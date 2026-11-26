/**
 * 桌面附件运行时装配。
 *
 * 元数据走 SQLite，二进制/队列走 IndexedDB；未配对后台时仍提供本机
 * manager，只是 uploader 为 null。页面通过 `AttachmentSection` 挂载时
 * 会把 unavailable reason 显式展示出来，不做静默降级。
 */

import { db, isTauriRuntime } from '../../data/db/client';
import { readStoredSyncMode } from '../../sync/mode';
import type { SyncMode } from '../sync/types';
import { LocalStorageSyncStore } from '../../sync/store';
import {
  createHttpAttachmentTransport,
  type AttachmentTransport,
} from './api';
import {
  IndexedDbAttachmentStateStore,
  IndexedDbBlobStore,
  isIndexedDbAvailable,
} from './blobStore';
import { createAttachmentManager, type AttachmentManager } from './manager';
import { createDbAttachmentRepository } from './repository';
import type { StoredAttachment } from './types';
import { createAttachmentUploader, type AttachmentUploader } from './uploader';

export type AttachmentRuntime = {
  manager: AttachmentManager | null;
  transport: AttachmentTransport | null;
  uploader: AttachmentUploader | null;
  /** 存储是否可用；与同步模式分开，避免 local 被误报成 unavailable。 */
  mode: 'sqlite' | 'unavailable';
  /** 每设备单一同步模式；附件文案与上传入口按它分流。 */
  syncMode: SyncMode;
  reason: string | null;
};

export type AttachmentRuntimeOptions = {
  dbName?: string;
};

/**
 * 桌面运行时：元数据走 SQLite，二进制/队列走 IndexedDB。
 * local 模式仍返回 manager（纯本机），uploader 为 null；只有 backend 且已
 * 配对后台时才装配上传队列。WebDAV 附件二进制同步是正式版能力，当前不
 * 伪造上传入口。
 */
export async function createDesktopAttachmentRuntime(
  options: AttachmentRuntimeOptions = {},
): Promise<AttachmentRuntime> {
  const syncMode = readStoredSyncMode();
  if (!isTauriRuntime()) {
    return {
      manager: null,
      transport: null,
      uploader: null,
      mode: 'unavailable',
      syncMode,
      reason: '附件元数据需要 Tauri 桌面壳内的 SQLite',
    };
  }
  if (!isIndexedDbAvailable()) {
    return {
      manager: null,
      transport: null,
      uploader: null,
      mode: 'unavailable',
      syncMode,
      reason: '当前 WebView 没有 IndexedDB，无法保存附件二进制',
    };
  }
  const dbName = options.dbName ?? 'zhixing-attachments';
  const manager = createAttachmentManager({
    repository: createDbAttachmentRepository(db),
    blobStore: new IndexedDbBlobStore(dbName),
    stateStore: new IndexedDbAttachmentStateStore(dbName),
    getSyncMode: readStoredSyncMode,
  });
  try {
    await manager.migrateLegacyStates();
  } catch {
    // 状态迁移失败不阻断本机打开；ensureState 仍会逐条懒迁移。
  }

  if (syncMode === 'local') {
    return {
      manager,
      transport: null,
      uploader: null,
      mode: 'sqlite',
      syncMode,
      reason: '当前为本地模式；附件只保存在本机',
    };
  }
  if (syncMode === 'webdav') {
    return {
      manager,
      transport: null,
      uploader: null,
      mode: 'sqlite',
      syncMode,
      reason: 'WebDAV 附件二进制同步尚未启用；文件只保存在本机',
    };
  }

  const profile = await new LocalStorageSyncStore().loadProfile();
  if (!profile) {
    return {
      manager,
      transport: null,
      uploader: null,
      mode: 'sqlite',
      syncMode,
      reason: '尚未配对后台；附件只保存在本机',
    };
  }
  const transport = createHttpAttachmentTransport({
    baseUrl: profile.baseUrl,
    deviceId: profile.deviceId,
    deviceToken: profile.deviceToken,
  });
  return {
    manager,
    transport,
    uploader: createAttachmentUploader({ manager, transport }),
    mode: 'sqlite',
    syncMode,
    reason: null,
  };
}

/** 生成编辑器 `file` 块 payload；文件本体不进入块 JSON。 */
export function attachmentFilePayload(
  attachment: StoredAttachment,
): Record<string, unknown> {
  return {
    attachmentId: attachment.metadata.id,
    fileName: attachment.metadata.fileName,
    byteSize: attachment.metadata.byteSize,
    mime: attachment.metadata.mime,
    // 块 payload 只是快照，真实状态仍以 AttachmentState 为准。local 模式
    // 不得把这个快照写成 pending；只有确实在同步队列里才写 pending。
    status:
      attachment.state.status === 'available'
        ? 'available'
        : attachment.state.status === 'remote' ||
            attachment.state.status === 'missing'
          ? 'missing'
          : attachment.state.status === 'pending' ||
              attachment.state.status === 'uploading' ||
              attachment.state.status === 'downloading'
            ? 'pending'
            : 'local',
  };
}

/** 生成图片块 payload（块类型由编辑器注册表决定）。 */
export function attachmentImagePayload(
  attachment: StoredAttachment,
): Record<string, unknown> {
  return {
    attachmentId: attachment.metadata.id,
    fileName: attachment.metadata.fileName,
    byteSize: attachment.metadata.byteSize,
    mime: attachment.metadata.mime,
    width: null,
    height: null,
    alt: attachment.metadata.fileName,
  };
}
