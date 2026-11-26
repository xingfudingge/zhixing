/**
 * OCR 运行时装配（无 CSS/UI 副作用）。
 *
 * 设置页、附件面板与图片块都通过这里取得默认服务，确保读到同一份
 * 设备偏好（localStorage）和同一套作业存储（IndexedDB，测试回退内存）。
 * `system-local` 的引擎由 `resolveOcrEngine` 按运行时分派：桌面壳走 macOS
 * Apple Vision，浏览器预览才退回 TextDetector 预览。
 */

import { db, isTauriRuntime } from '../../data/db/client';
import { createDesktopAttachmentRuntime } from '../attachments/runtime';
import { isIndexedDbAvailable } from '../attachments/blobStore';
import type { AttachmentManager } from '../attachments/manager';
import { isImageAttachment } from '../attachments/types';
import {
  createOcrService,
  type OcrImageContextResolver,
  type OcrImageResolver,
  type OcrService,
} from './service';
import { MemoryOcrSettingsStore, defaultOcrSettingsStore } from './settings';
import { IndexedDbOcrJobStore, MemoryOcrJobStore } from './store';
import {
  createOcrTextSyncSink,
  type OcrTextSyncSink,
} from './textSync';
import type { OcrImageCandidate } from './types';

/** 默认装配：设备偏好 localStorage；作业文本 IndexedDB；文本同步走现有 outbox。 */
export function createDefaultOcrService(): OcrService {
  return createOcrService({
    settingsStore: defaultOcrSettingsStore(),
    jobStore: isIndexedDbAvailable()
      ? new IndexedDbOcrJobStore()
      : new MemoryOcrJobStore(),
    imageContext: resolveAttachmentImageContext,
    textSync: createOcrTextSyncSink(),
  });
}

/**
 * 读取附件所属知识库目录。只在 Tauri 内可用；浏览器预览返回 null，
 * folder 范围会明确拒绝入队而不是猜测目录。
 */
export const resolveAttachmentImageContext: OcrImageContextResolver = async (
  attachmentId,
) => {
  if (!isTauriRuntime()) return null;
  try {
    const attachment = await db.attachments.get(attachmentId);
    let folderId: string | null = null;
    if (attachment.noteId) {
      const note = await db.notes.get(attachment.noteId);
      folderId = note.folderId ?? null;
    }
    return {
      attachmentId,
      folderId,
      fileName: attachment.fileName,
      createdAt: attachment.createdAt,
    };
  } catch {
    return null;
  }
};

/**
 * 按当前知识库目录列出可识别图片。浏览器预览没有 SQLite 附件元数据，
 * 会抛错由 UI 明确展示；不返回任何示例图片。
 */
export async function listAttachmentOcrCandidates(): Promise<
  OcrImageCandidate[]
> {
  if (!isTauriRuntime()) {
    throw new Error(
      '浏览器预览没有本机附件数据库；按范围排队需要桌面壳内的 SQLite 附件元数据。',
    );
  }
  const runtime = await createDesktopAttachmentRuntime();
  if (!runtime.manager) {
    throw new Error(runtime.reason ?? '附件服务不可用，无法列出图片');
  }
  const [attachments, notes] = await Promise.all([
    runtime.manager.list(),
    db.notes.list(),
  ]);
  const folderByNote = new Map(
    notes.map((note) => [note.id, note.folderId] as const),
  );
  return attachments
    .filter((attachment) => isImageAttachment(attachment.metadata))
    .map((attachment) => ({
      attachmentId: attachment.metadata.id,
      folderId: attachment.metadata.noteId
        ? folderByNote.get(attachment.metadata.noteId) ?? null
        : null,
      fileName: attachment.metadata.fileName,
      createdAt: attachment.metadata.createdAt,
    }));
}

/**
 * 设置页队列的原图读取器。按需初始化附件运行时；不可用时抛出真实原因，
 * 由 `processJob` 保留为作业失败原因，而不是永久禁用按钮。
 */
export function createAttachmentQueueResolver(): OcrImageResolver {
  let runtimePromise: ReturnType<typeof createDesktopAttachmentRuntime> | null =
    null;
  const runtime = () => {
    runtimePromise ??= createDesktopAttachmentRuntime();
    return runtimePromise;
  };
  return async (attachmentId) => {
    const ready = await runtime();
    if (!ready.manager) {
      throw new Error(ready.reason ?? '附件服务不可用，无法读取原图');
    }
    try {
      const { blob } = await ready.manager.open(attachmentId);
      return blob;
    } catch (reason) {
      // 找不到/哈希不一致都返回 null，由 processJob 写成具体失败原因。
      return null;
    }
  };
}

/** 把附件管理器接到 OCR 队列：打开附件时仍会校验本机哈希。 */
export function attachmentOcrImageResolver(
  manager: AttachmentManager,
): OcrImageResolver {
  return async (attachmentId) => {
    try {
      const { blob } = await manager.open(attachmentId);
      return blob;
    } catch {
      return null;
    }
  };
}

/** 测试/浏览器预览：不使用 IndexedDB 与 localStorage 的内存装配。 */
export function createMemoryOcrService(
  options: {
    textSync?: OcrTextSyncSink | null;
    imageContext?: OcrImageContextResolver;
  } = {},
): OcrService {
  return createOcrService({
    settingsStore: new MemoryOcrSettingsStore(),
    jobStore: new MemoryOcrJobStore(),
    imageContext: options.imageContext,
    textSync: options.textSync ?? null,
  });
}
