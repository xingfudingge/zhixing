/**
 * 附件领域类型。
 *
 * 设计约束：
 * - 元数据权威在 SQLite `attachments` 表；二进制与上传队列状态在本机
 *   IndexedDB（桌面版未来可替换为应用私有目录 + SQLite 表）。
 * - `status` 只描述“本机此刻看到的状态”，不能把 pending 显示成已同步。
 * - 图片默认只留在本机；任何远程上传都必须由用户显式触发。
 */

import type { Attachment as DbAttachment } from '../../data/db/types';

/**
 * `status` 是“本机此刻知道的传输事实”，不是面向用户的文案：
 * - `local`：本机已有二进制，没有进行中的传输；是否上传由同步模式决定。
 * - `pending`：已明确进入上传队列，等待传输；local 模式下不得写入。
 * - `available`：服务端已确认可用，且本机有对应二进制（上传完成或下载完成）。
 * - `remote`：只有远端记录，本机没有二进制。
 * - `missing`：本机与远端都没有可打开的内容（旧记录/Blob 被清理）。
 */
export type AttachmentStatus =
  | 'local'
  | 'pending'
  | 'uploading'
  | 'available'
  | 'remote'
  | 'downloading'
  | 'failed'
  | 'missing';

/** 每设备单一同步模式；附件状态文案按它分流，不靠“有没有 profile”猜。 */
export type AttachmentSyncMode = 'local' | 'webdav' | 'backend';

/** 面向用户展示的一层状态；由 `status + hasLocal + mode + 服务可用性` 派生。 */
export type AttachmentDisplayState =
  | 'local_only'
  | 'local_saved'
  | 'pending_sync'
  | 'syncing'
  | 'synced'
  | 'remote_only'
  | 'missing'
  | 'download_failed'
  | 'sync_failed'
  | 'local_error'
  | 'downloading'
  | 'service_unavailable';

export type AttachmentDisplayTone =
  | 'neutral'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'active';

export type AttachmentDisplay = {
  state: AttachmentDisplayState;
  label: string;
  tone: AttachmentDisplayTone;
  hint: string;
};

export type AttachmentMetadata = {
  id: string;
  spaceId: string;
  noteId: string | null;
  blockId: string | null;
  fileName: string;
  sha256: string;
  byteSize: number;
  mime: string;
  storageKey: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type AttachmentState = {
  attachmentId: string;
  status: AttachmentStatus;
  /** 本机 Blob 在 IndexedDB 中的键；内容寻址，可被多个元数据共享。 */
  localBlobKey: string;
  /** 服务端附件 ID；通常与 attachmentId 相同，保留字段便于远端映射。 */
  remoteId: string | null;
  /** 已确认上传的分片索引；仅用于展示进度，真正续传以服务端 HEAD 为准。 */
  uploadedPartIndexes: number[];
  lastError: string | null;
  downloadedAt: string | null;
  updatedAt: string;
};

export type StoredAttachment = {
  metadata: AttachmentMetadata;
  state: AttachmentState;
};

export type IngestContext = {
  noteId?: string | null;
  blockId?: string | null;
  /**
   * 任务级附件。SQLite `attachments` 只有 note_id/block_id 两个归属字段，
   * 任务不是笔记，无法写进 note_id（外键指向 notes）。因此任务附件使用
   * `block_id = "task:<taskId>"` 作为归属标记，并由 `listForTask()` 过滤。
   */
  taskId?: string | null;
  spaceId?: string;
};

export type IngestResult = {
  attachment: StoredAttachment;
  /** 同内容已存在时复用 Blob，不重复占空间。 */
  reusedBlob: boolean;
};

export type AttachmentProgress = {
  attachmentId: string;
  phase: 'hashing' | 'uploading' | 'downloading' | 'verifying';
  completedBytes: number;
  totalBytes: number;
  partIndex?: number;
  partCount?: number;
};

export type AttachmentPart = {
  index: number;
  size: number;
  sha256: string;
};

export type RemoteAttachment = {
  id: string;
  spaceId: string;
  noteId: string | null;
  blockId: string | null;
  fileName: string;
  sha256: string;
  byteSize: number;
  mime: string;
  storageKey: string;
  status: 'pending' | 'available' | 'deleted';
  createdAt: string;
  updatedAt: string;
};

export type UploadSession = {
  chunkSize: number;
  partCount: number;
  /** 服务端已经存在、无需重传的分片索引。 */
  presentPartIndexes: number[];
  /** 只返回缺失分片的预签名 URL。 */
  missingParts: { index: number; size: number; url: string }[];
  completeUrl: string;
  completeKey: string;
  alreadyAvailable: boolean;
};

export type DownloadManifest = {
  attachment: RemoteAttachment;
  chunkSize: number;
  partCount: number;
  parts: { index: number; size: number; url: string }[];
};

export function statusLabel(status: AttachmentStatus): string {
  switch (status) {
    case 'local':
      return '本机已保存';
    case 'pending':
      return '待同步';
    case 'uploading':
      return '同步中';
    case 'available':
      return '已同步';
    case 'remote':
      return '远端可用 · 本机缺失';
    case 'downloading':
      return '下载中';
    case 'failed':
      return '同步失败，可重试';
    case 'missing':
      return '文件缺失';
  }
}

function display(
  state: AttachmentDisplayState,
  label: string,
  tone: AttachmentDisplayTone,
  hint: string,
): AttachmentDisplay {
  return { state, label, tone, hint };
}

/**
 * 把持久化状态翻译成用户能理解的状态。
 *
 * 关键约束：
 * - local 模式没有上传目标，本机 Blob 一律是“本机已保存”，绝不显示“待上传”；
 * - 只有后端/WebDAV 模式且确实在队列中（`pending/uploading`）才显示“待同步”；
 * - 本机有副本时，传输失败只说“同步失败 · 本机保留”，打开/另存不受影响；
 * - 没有 Blob 时区分“远端可用”和“双方都缺失”，不把两者混成“失败”。
 */
export function describeAttachmentStatus(input: {
  status: AttachmentStatus;
  hasLocal: boolean;
  mode: AttachmentSyncMode;
  serviceAvailable: boolean;
  remoteId?: string | null;
  lastError?: string | null;
}): AttachmentDisplay {
  const { status, hasLocal, mode, serviceAvailable } = input;
  const hasRemote = Boolean(input.remoteId) || status === 'remote';
  const localMode = mode === 'local';

  const localOnly = display(
    'local_only',
    '本机已保存',
    'ok',
    '仅保存在这台设备；当前为本地模式，不会上传。',
  );
  const localSaved = display(
    'local_saved',
    '本机已保存 · 未同步',
    'neutral',
    '文件已保存在本机；需要同步时再显式上传。',
  );
  const serviceUnavailable = display(
    'service_unavailable',
    '服务不可用 · 本机已保存',
    'warn',
    '同步服务暂不可用；文件仍保存在本机，可打开、另存和删除。',
  );

  if (!hasLocal) {
    if (status === 'downloading') {
      return display(
        'downloading',
        '下载中',
        'active',
        '正在把远端文件下载到本机。',
      );
    }
    if (hasRemote) {
      if (status === 'failed') {
        return display(
          'download_failed',
          '下载失败 · 本机缺失',
          'danger',
          input.lastError ?? '下载失败；本机没有可用副本，可重试。',
        );
      }
      return display(
        'remote_only',
        '远端可用 · 本机缺失',
        'neutral',
        '文件只存在远端；下载到本机并校验哈希后才能打开。',
      );
    }
    return display(
      'missing',
      '文件缺失',
      'danger',
      '本机与远端都没有文件本体，请重新选择原文件。',
    );
  }

  if (status === 'pending' || status === 'uploading' || status === 'downloading') {
    if (localMode) {
      return localOnly;
    }
    if (!serviceAvailable) {
      return serviceUnavailable;
    }
    if (status === 'pending') {
      return display(
        'pending_sync',
        '待同步',
        'warn',
        '已加入同步队列，等待上传；本机副本始终可打开。',
      );
    }
    return display(
      'syncing',
      '同步中',
      'active',
      '正在与同步服务传输文件，本机副本保持可用。',
    );
  }

  if (localMode) {
    if (status === 'failed') {
      return display(
        'local_error',
        '本机文件异常',
        'danger',
        input.lastError ?? '本机文件校验失败；请重新选择或从远端恢复。',
      );
    }
    return localOnly;
  }

  if (status === 'failed') {
    return display(
      'sync_failed',
      '同步失败 · 本机保留',
      'danger',
      input.lastError ?? '同步失败；本机副本仍可打开，可重试上传。',
    );
  }
  if (!serviceAvailable) {
    return serviceUnavailable;
  }
  if (status === 'available' && hasRemote) {
    return display(
      'synced',
      '已同步',
      'ok',
      '本机与服务端内容一致，哈希已校验。',
    );
  }
  return localSaved;
}

/**
 * 旧状态修正：只改“与当前同步模式矛盾”的记录，不丢元数据/Blob。
 * - local 模式中的 pending/uploading/downloading → local（有 Blob）或 missing；
 * - 有状态记录但 Blob 已不在、且没有远端记录 → missing；
 * - 有远端记录但没有 Blob → remote（保留可下载入口）。
 */
export function normalizeStateForMode(
  state: AttachmentState,
  mode: AttachmentSyncMode,
  hasLocal: boolean,
): AttachmentState {
  if (mode === 'local' && state.status === 'pending') {
    return {
      ...state,
      status: hasLocal ? 'local' : 'missing',
      lastError: hasLocal ? null : '本机没有这个文件，且当前为本地模式',
    };
  }
  if (mode === 'local' && (state.status === 'uploading' || state.status === 'downloading')) {
    return {
      ...state,
      status: hasLocal ? 'local' : 'failed',
      lastError: hasLocal ? null : '同步在切换模式前中断，本机没有文件',
    };
  }
  if ((state.status === 'local' || state.status === 'available') && !hasLocal) {
    return {
      ...state,
      status: state.remoteId ? 'remote' : 'missing',
      lastError: state.remoteId
        ? '本机没有这个文件，需要从远端下载'
        : '本机与远端都没有这个文件',
    };
  }
  return state;
}

export function isImageAttachment(
  attachment: Pick<AttachmentMetadata, 'mime' | 'fileName'>,
): boolean {
  if (attachment.mime.startsWith('image/')) {
    return true;
  }
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(attachment.fileName);
}

export function toMetadata(row: DbAttachment): AttachmentMetadata {
  return {
    id: row.id,
    spaceId: row.spaceId,
    noteId: row.noteId,
    blockId: row.blockId,
    fileName: row.fileName,
    sha256: row.sha256,
    byteSize: row.byteSize,
    mime: row.mime,
    storageKey: row.storageKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function defaultState(
  attachmentId: string,
  localBlobKey: string,
  now: string,
): AttachmentState {
  return {
    attachmentId,
    status: 'local',
    localBlobKey,
    remoteId: null,
    uploadedPartIndexes: [],
    lastError: null,
    downloadedAt: null,
    updatedAt: now,
  };
}

export function bytesKey(sha256: string): string {
  return `attachments/${sha256}`;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${
    units[unit]
  }`;
}

export function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

/**
 * 任务附件的归属标记。
 *
 * 数据库 schema 只为附件提供 note_id / block_id：note_id 有指向 notes 的
 * 外键，不能塞任务 ID；block_id 没有约束，因此用带前缀的命名空间保存。
 * 普通文件块的 block_id 是真实块 ID，不会带这个前缀。
 */
export const TASK_ATTACHMENT_PREFIX = 'task:';

export function taskAttachmentBlockId(taskId: string): string {
  return `${TASK_ATTACHMENT_PREFIX}${taskId}`;
}

export function taskIdFromBlockId(blockId: string | null): string | null {
  if (!blockId || !blockId.startsWith(TASK_ATTACHMENT_PREFIX)) {
    return null;
  }
  const taskId = blockId.slice(TASK_ATTACHMENT_PREFIX.length);
  return taskId || null;
}
