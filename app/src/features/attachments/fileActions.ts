/**
 * 附件／导出的统一本机文件动作。
 *
 * 这里只做三件事，所有入口（附件面板、正文文件卡、知识 Markdown 导出）
 * 必须复用本模块，禁止各自再写 `<a download>`：
 * - `saveBlobWithDialog()`：桌面走 Tauri 保存面板，浏览器走 File System
 *   Access 保存面板；取消不写文件，不默认 Downloads；
 * - `openBlobWithSystemApp()`：桌面写应用缓存后交给系统默认应用打开；
 *   浏览器只对 PDF/文本降级到新标签预览，Office 等明确提示改用桌面版；
 * - `openAttachmentLocally()` / `saveLocalAttachment()`：先用附件管理器
 *   读取并校验本机 Blob，再走上面两条链路，避免绕过哈希校验。
 *
 * 保存路径只用于界面提示与日志，不写回附件元数据，也不作为文件本体。
 */

import { invoke } from '@tauri-apps/api/core';

import { isTauriRuntime } from '../../data/db/client';
import { readDefaultExportDirectory } from '../export/location';
import type { AttachmentManager } from './manager';
import { objectUrlFor, revokeObjectUrl } from './blobStore';
import { isImageAttachment, type AttachmentMetadata } from './types';

export type SaveResult =
  | { status: 'saved'; path: string | null; target: 'desktop' | 'browser' }
  | { status: 'canceled' };

export class FileActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileActionError';
  }
}

type BrowserWritable = {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
};

type BrowserFileHandle = {
  createWritable: () => Promise<BrowserWritable>;
};

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
  }) => Promise<BrowserFileHandle>;
};

/** 展示名只保留单段文件名；不参与路径拼接。 */
export function safeFileName(fileName: string): string {
  const raw = fileName.split(/[\\/]/).pop() ?? '';
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '_').trim();
  const safe = Array.from(cleaned).slice(0, 120).join('');
  return safe && safe !== '.' && safe !== '..' ? safe : '未命名文件';
}

function commandErrorMessage(reason: unknown, fallback: string): string {
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  if (reason && typeof reason === 'object') {
    const value = reason as { message?: unknown };
    if (typeof value.message === 'string' && value.message.trim()) {
      return value.message;
    }
  }
  return fallback;
}

function isAbortError(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as { name?: unknown }).name === 'AbortError'
  );
}

function extensionOf(fileName: string): string | undefined {
  const index = fileName.lastIndexOf('.');
  if (index <= 0 || index === fileName.length - 1) {
    return undefined;
  }
  return fileName.slice(index + 1).toLowerCase();
}

/**
 * 用用户可见的保存面板另存 Blob。
 *
 * - 桌面：调用 `save_attachment_file`；`directory` 只来自用户设置的默认导出
 *   目录，未设置时传 `null`，Rust 不调用 `set_directory`，由系统记住上次
 *   位置。返回 `None` 表示用户取消。
 * - 浏览器：调用 `showSaveFilePicker`；取消抛 `AbortError`，不落盘。
 * - 无保存面板：抛出可读错误，**不回退到 `<a download>`**，避免擅自写入
 *   Downloads。
 */
export async function saveBlobWithDialog(
  blob: Blob,
  fileName: string,
): Promise<SaveResult> {
  const safeName = safeFileName(fileName);

  if (isTauriRuntime()) {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    let path: string | null;
    try {
      path = await invoke<string | null>('save_attachment_file', {
        fileName: safeName,
        bytes,
        directory: readDefaultExportDirectory(),
      });
    } catch (reason) {
      throw new FileActionError(
        commandErrorMessage(reason, `无法打开保存面板：${safeName}`),
      );
    }
    return path
      ? { status: 'saved', path, target: 'desktop' }
      : { status: 'canceled' };
  }

  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (typeof picker !== 'function') {
    throw new FileActionError(
      '当前环境没有用户可见的保存面板，已取消写入。请使用桌面版另存文件；浏览器预览不会自动放进 Downloads。',
    );
  }

  let handle: BrowserFileHandle;
  try {
    handle = await picker.call(window, { suggestedName: safeName });
  } catch (reason) {
    if (isAbortError(reason)) {
      return { status: 'canceled' };
    }
    throw new FileActionError(
      commandErrorMessage(reason, `无法打开保存面板：${safeName}`),
    );
  }

  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (reason) {
    try {
      await writable.abort?.();
    } catch {
      // 取消失败不覆盖原始错误。
    }
    throw new FileActionError(
      commandErrorMessage(reason, `写入文件失败：${safeName}`),
    );
  }
  return { status: 'saved', path: null, target: 'browser' };
}

/**
 * 用系统默认应用打开本机 Blob（非图片）。
 *
 * 桌面端调用 `open_attachment_file`；浏览器只对 PDF/纯文本降级到新标签
 * 预览，其他格式明确提示桌面版，不冒充“已打开”。
 */
export async function openBlobWithSystemApp(
  blob: Blob,
  metadata: Pick<AttachmentMetadata, 'fileName' | 'mime' | 'sha256'>,
): Promise<string | null> {
  const safeName = safeFileName(metadata.fileName);

  if (isTauriRuntime()) {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    try {
      return await invoke<string>('open_attachment_file', {
        fileName: safeName,
        bytes,
        sha256: metadata.sha256,
      });
    } catch (reason) {
      throw new FileActionError(
        commandErrorMessage(
          reason,
          `无法用系统默认应用打开「${safeName}」`,
        ),
      );
    }
  }

  const extension = extensionOf(safeName) ?? '';
  const browserViewable =
    /^application\/pdf$/i.test(metadata.mime) ||
    /^text\//i.test(metadata.mime) ||
    ['pdf', 'txt', 'md', 'json', 'csv', 'log'].includes(extension);
  if (!browserViewable) {
    throw new FileActionError(
      `浏览器预览无法调用系统默认应用打开「${safeName}」。请使用桌面版「打开」，或先保存到本机后用对应应用打开。`,
    );
  }

  const url = objectUrlFor(blob);
  if (!url) {
    throw new FileActionError('当前环境无法生成本机文件地址');
  }
  // 不传 'noopener'：现代浏览器在该参数下会按规范返回 null，导致无法
  // 区分“被拦截”和“已打开”。这里打开后立刻断开 opener。
  const opened =
    typeof window.open === 'function' ? window.open(url, '_blank') : null;
  if (!opened) {
    revokeObjectUrl(url);
    throw new FileActionError(
      `浏览器拦截了「${safeName}」的预览标签页，请允许弹出窗口后重试。`,
    );
  }
  try {
    opened.opener = null;
  } catch {
    // 跨域窗口可能禁止改写；预览仍已打开。
  }
  window.setTimeout(() => revokeObjectUrl(url), 60_000);
  return null;
}

export type OpenedAttachment =
  | {
      kind: 'image';
      blob: Blob;
      metadata: AttachmentMetadata;
    }
  | {
      kind: 'external';
      metadata: AttachmentMetadata;
      path: string | null;
    };

/**
 * 打开本机附件：图片交给调用方做应用内预览，其他格式交给系统默认应用。
 * 读取时复用 `AttachmentManager.open()`，默认重新校验 SHA-256。
 */
export async function openAttachmentLocally(
  manager: AttachmentManager,
  attachmentId: string,
): Promise<OpenedAttachment> {
  const { blob, metadata } = await manager.open(attachmentId);
  if (isImageAttachment(metadata)) {
    return { kind: 'image', blob, metadata };
  }
  const path = await openBlobWithSystemApp(blob, metadata);
  return { kind: 'external', metadata, path };
}

/** 另存本机附件；返回附件元数据供界面提示。 */
export async function saveLocalAttachment(
  manager: AttachmentManager,
  attachmentId: string,
): Promise<{ result: SaveResult; metadata: AttachmentMetadata }> {
  const { blob, metadata } = await manager.open(attachmentId);
  const result = await saveBlobWithDialog(blob, metadata.fileName);
  return { result, metadata };
}

/** 供 UI 统一生成保存结果文案，取消时明确说明未写入。 */
export function describeSaveResult(
  result: SaveResult,
  fileName: string,
): string {
  if (result.status === 'canceled') {
    return `已取消保存「${safeFileName(fileName)}」，未写入任何文件。`;
  }
  return result.path
    ? `「${safeFileName(fileName)}」已保存到 ${result.path}`
    : `「${safeFileName(fileName)}」已保存到所选位置`;
}
