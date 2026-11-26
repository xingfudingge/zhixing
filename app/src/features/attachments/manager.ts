/**
 * 附件用例层：写入元数据、内容寻址落本机、打开与删除。
 *
 * 这里没有任何网络调用。上传/下载由 `uploader.ts` 显式发起，避免“插入
 * 一个文件就悄悄上传”；图片尤其如此。
 */

import type { NewAttachment } from '../../data/db/types';
import type {
  AttachmentStateStore,
  BlobStore,
} from './blobStore';
import type { AttachmentMetadataRepository } from './repository';
import {
  bytesKey,
  defaultState,
  isImageAttachment,
  normalizeStateForMode,
  taskAttachmentBlockId,
  toMetadata,
  type AttachmentMetadata,
  type AttachmentProgress,
  type AttachmentState,
  type AttachmentStatus,
  type AttachmentSyncMode,
  type IngestContext,
  type IngestResult,
  type RemoteAttachment,
  type StoredAttachment,
} from './types';
import { sha256Blob } from './sha256';
import { validateAttachmentSize } from './uploadPlan';

export class AttachmentIntegrityError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super('附件内容与 SHA-256 不一致，已拒绝使用');
    this.name = 'AttachmentIntegrityError';
  }
}

export class AttachmentNotFoundError extends Error {
  constructor(id: string) {
    super(`附件不存在：${id}`);
    this.name = 'AttachmentNotFoundError';
  }
}

export class RemoteUploadNotAllowedError extends Error {
  constructor(message = '该附件默认只保存在本机，需要用户显式确认后才能上传') {
    super(message);
    this.name = 'RemoteUploadNotAllowedError';
  }
}

export type AttachmentManagerOptions = {
  repository: AttachmentMetadataRepository;
  blobStore: BlobStore;
  stateStore: AttachmentStateStore;
  now?: () => string;
  newId?: () => string;
  spaceId?: string;
  /**
   * 每设备单一同步模式的读取器。默认 local（产品默认，也是最安全的假设）。
   * 每次读状态时重新读取，设置页切换模式后无需重建 manager。
   */
  getSyncMode?: () => AttachmentSyncMode;
};

export type IngestOptions = IngestContext & {
  onProgress?: (progress: AttachmentProgress) => void;
};

function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `att_${crypto.randomUUID()}`;
  }
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  zip: 'application/zip',
};

export function inferMime(fileName: string, declared?: string): string {
  const trimmed = declared?.trim();
  if (trimmed) return trimmed;
  const index = fileName.lastIndexOf('.');
  if (index >= 0) {
    const ext = fileName.slice(index + 1).toLowerCase();
    const known = MIME_BY_EXTENSION[ext];
    if (known) return known;
  }
  return 'application/octet-stream';
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return '未知错误';
}

/**
 * 把调用方传入的归属上下文归一成数据库里的 note_id / block_id。
 * 任务附件写 `block_id="task:<id>"`，绝不伪造 note_id（那会违反外键）。
 */
function resolveOwner(context: IngestContext): {
  noteId: string | null;
  blockId: string | null;
} {
  if (context.taskId) {
    return { noteId: null, blockId: taskAttachmentBlockId(context.taskId) };
  }
  return {
    noteId: context.noteId ?? null,
    blockId: context.blockId ?? null,
  };
}

export class AttachmentManager {
  private readonly repository: AttachmentMetadataRepository;
  private readonly blobStore: BlobStore;
  private readonly stateStore: AttachmentStateStore;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly spaceId: string;
  private readonly getSyncMode: () => AttachmentSyncMode;

  constructor(options: AttachmentManagerOptions) {
    this.repository = options.repository;
    this.blobStore = options.blobStore;
    this.stateStore = options.stateStore;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? defaultNewId;
    this.spaceId = options.spaceId ?? 'personal';
    this.getSyncMode = options.getSyncMode ?? (() => 'local');
  }

  /** 当前同步模式；UI 用它决定显示“仅本机/未同步/待同步”。 */
  currentMode(): AttachmentSyncMode {
    return this.getSyncMode();
  }

  /**
   * 插入文件：先算哈希、写本机 Blob，再写元数据。
   *
   * 状态一律先写 `local`（本机已保存），不写 `pending`：单机没有上传目标，
   * “待上传”会让用户误以为文件尚未保存。只有用户显式上传时，UI 才调用
   * `markPending()` 把记录放进同步队列。
   */
  async ingest(file: File | Blob, options: IngestOptions = {}): Promise<IngestResult> {
    validateAttachmentSize(file.size);
    const fileName =
      file instanceof File && file.name.trim()
        ? file.name.trim()
        : `未命名附件-${this.now().slice(0, 10)}`;
    const mime = inferMime(fileName, file.type);
    const owner = resolveOwner(options);

    const sha256 = await sha256Blob(file, (hashed, total) => {
      options.onProgress?.({
        attachmentId: '',
        phase: 'hashing',
        completedBytes: hashed,
        totalBytes: total,
      });
    });
    const blobKey = bytesKey(sha256);
    const reusedBlob = await this.blobStore.has(blobKey);
    if (!reusedBlob) {
      await this.blobStore.put(blobKey, file);
    }

    // SQLite 对 sha256 建了全局唯一约束（内容寻址），同一份内容只能有一条
    // 附件元数据。因此笔记附件按内容全局复用；不同笔记通过文件块的
    // attachmentId 引用同一条记录，附件面板再按“所属笔记 + 正文引用”合并展示。
    const existing = (await this.repository.list()).filter(
      (row) => row.sha256 === sha256,
    );
    if (options.taskId) {
      const sameTask = existing.find((row) => row.blockId === owner.blockId);
      if (sameTask) {
        const state = await this.ensureState(sameTask);
        return { attachment: { metadata: sameTask, state }, reusedBlob: true };
      }
      if (existing.length > 0) {
        throw new Error(
          '相同内容的附件已存在于其他笔记或任务，当前版本不能为另一个任务重复创建记录',
        );
      }
    } else if (existing.length > 0) {
      const metadata = existing[0]!;
      const state = await this.ensureState(metadata);
      return { attachment: { metadata, state }, reusedBlob: true };
    }

    const metadata = await this.repository.create({
      id: this.newId(),
      spaceId: options.spaceId ?? this.spaceId,
      noteId: owner.noteId,
      blockId: owner.blockId,
      fileName,
      sha256,
      byteSize: file.size,
      mime,
      storageKey: `spaces/${options.spaceId ?? this.spaceId}/assets/${sha256}`,
    } satisfies NewAttachment);

    const state: AttachmentState = {
      ...defaultState(metadata.id, blobKey, this.now()),
      status: 'local',
    };
    await this.stateStore.put(state);
    return {
      attachment: { metadata, state },
      reusedBlob,
    };
  }

  async list(noteId?: string | null): Promise<StoredAttachment[]> {
    const rows = await this.repository.list(noteId);
    return this.toStoredList(rows);
  }

  /**
   * 任务级附件列表。SQLite 没有 task_id 列，只能先取全部元数据再按
   * `block_id="task:<id>"` 的命名空间过滤；单用户数据量下开销可接受。
   */
  async listForTask(taskId: string): Promise<StoredAttachment[]> {
    const marker = taskAttachmentBlockId(taskId);
    const rows = (await this.repository.list()).filter(
      (row) => row.blockId === marker,
    );
    return this.toStoredList(rows);
  }

  private async toStoredList(
    rows: AttachmentMetadata[],
  ): Promise<StoredAttachment[]> {
    const results: StoredAttachment[] = [];
    for (const metadata of rows) {
      const state = await this.ensureState(metadata);
      results.push({ metadata, state });
    }
    return results.sort((a, b) => {
      if (a.metadata.createdAt !== b.metadata.createdAt) {
        return a.metadata.createdAt < b.metadata.createdAt ? -1 : 1;
      }
      return a.metadata.id.localeCompare(b.metadata.id);
    });
  }

  async get(id: string): Promise<StoredAttachment> {
    const metadata = await this.repository.get(id);
    const state = await this.ensureState(metadata);
    return { metadata, state };
  }

  async ensureState(metadata: AttachmentMetadata): Promise<AttachmentState> {
    const stored = await this.stateStore.get(metadata.id);
    const blobKey = bytesKey(metadata.sha256);
    const hasLocal = stored
      ? (await this.blobStore.has(stored.localBlobKey)) ||
        (await this.blobStore.has(blobKey))
      : await this.blobStore.has(blobKey);

    if (stored) {
      // 旧版本把“插入本机”写成 pending。local 模式下必须按真实情况迁移：
      // 有 Blob → local（本机已保存）；没有 Blob → missing/remote，但元数据不删。
      const normalized = normalizeStateForMode(stored, this.getSyncMode(), hasLocal);
      if (
        normalized.status !== stored.status ||
        normalized.lastError !== stored.lastError
      ) {
        await this.stateStore.put(normalized);
      }
      return normalized;
    }

    // 状态行丢失时，不能因为“元数据还在”就假装远端可用；只有 hash 对应的
    // 本机 Blob 存在才是 local，否则明确标成 missing，等待重新选择/下载。
    const state: AttachmentState = {
      ...defaultState(metadata.id, blobKey, this.now()),
      status: hasLocal ? 'local' : 'missing',
      remoteId: null,
      lastError: hasLocal ? null : '本机与远端都没有这个文件',
    };
    await this.stateStore.put(state);
    return state;
  }

  /**
   * 一次性修正旧记录（应用启动时调用）。`ensureState` 是懒迁移，这里保证
   * 附件面板/导出/诊断看到的是同一份已迁移状态。
   */
  async migrateLegacyStates(): Promise<number> {
    const rows = await this.repository.list();
    const mode = this.getSyncMode();
    let migrated = 0;
    for (const metadata of rows) {
      const stored = await this.stateStore.get(metadata.id);
      if (!stored) {
        continue;
      }
      const hasLocal =
        (await this.blobStore.has(stored.localBlobKey)) ||
        (await this.blobStore.has(bytesKey(metadata.sha256)));
      const normalized = normalizeStateForMode(stored, mode, hasLocal);
      if (
        normalized.status !== stored.status ||
        normalized.lastError !== stored.lastError
      ) {
        await this.stateStore.put(normalized);
        migrated += 1;
      }
    }
    return migrated;
  }

  async updateState(
    id: string,
    patch: Partial<Omit<AttachmentState, 'attachmentId'>>,
  ): Promise<StoredAttachment> {
    const current = await this.get(id);
    const next: AttachmentState = {
      ...current.state,
      ...patch,
      attachmentId: id,
      uploadedPartIndexes:
        patch.uploadedPartIndexes ?? current.state.uploadedPartIndexes,
      updatedAt: this.now(),
    };
    await this.stateStore.put(next);
    return { metadata: current.metadata, state: next };
  }

  async setStatus(
    id: string,
    status: AttachmentStatus,
    lastError: string | null = null,
  ): Promise<StoredAttachment> {
    return this.updateState(id, { status, lastError });
  }

  /**
   * 用户显式点“上传”后调用：把记录放进同步队列。
   * local 模式下不应调用；UI 也不渲染上传入口。
   */
  async markPending(id: string): Promise<StoredAttachment> {
    return this.updateState(id, { status: 'pending', lastError: null });
  }

  /**
   * 改名只更新 SQLite 里同一条附件元数据；文件块里的文件名只是投影，
   * 由编辑器同步写回，避免附件面板与正文出现两个名字。
   */
  async rename(id: string, fileName: string): Promise<StoredAttachment> {
    const trimmed = fileName.trim();
    if (!trimmed) {
      throw new Error('附件文件名不能为空');
    }
    const metadata = await this.repository.get(id);
    await this.repository.update(id, {
      noteId: metadata.noteId,
      blockId: metadata.blockId,
      fileName: trimmed,
      mime: metadata.mime,
      storageKey: metadata.storageKey,
    });
    return this.get(id);
  }

  /**
   * 从本机打开附件。默认再校验一次哈希，防止磁盘/缓存被篡改后静默打开。
   */
  async open(
    id: string,
    options: { verify?: boolean } = {},
  ): Promise<{ blob: Blob; metadata: AttachmentMetadata }> {
    const { metadata, state } = await this.get(id);
    const blob = await this.blobStore.get(state.localBlobKey);
    if (!blob) {
      await this.updateState(id, {
        status: state.remoteId ? 'remote' : 'missing',
        lastError: state.remoteId
          ? '本机没有这个文件，需要先下载'
          : '本机与远端都没有这个文件',
      });
      throw new AttachmentNotFoundError(id);
    }
    if (options.verify !== false) {
      const actual = await sha256Blob(blob);
      if (actual !== metadata.sha256) {
        await this.updateState(id, {
          status: 'failed',
          lastError: '本机文件哈希不一致，请重新下载',
        });
        throw new AttachmentIntegrityError(metadata.sha256, actual);
      }
    }
    return { blob, metadata };
  }

  /**
   * 本机是否有可打开的内容。UI 用它决定显示“打开/下载”还是“从远端下载”，
   * 避免仅凭状态字段把“上传失败但本机有文件”误判为远端缺失。
   */
  async hasLocalBlob(id: string): Promise<boolean> {
    try {
      const state = await this.stateStore.get(id);
      if (state && (await this.blobStore.has(state.localBlobKey))) {
        return true;
      }
      // 状态记录可能来自旧版本或已被清理；元数据里的 sha 才是内容寻址键。
      // 不能因为缺少状态行就把本机明明存在的文件判成缺失。
      const metadata = await this.repository.get(id);
      return await this.blobStore.has(bytesKey(metadata.sha256));
    } catch {
      return false;
    }
  }

  /** 下载完成且整体哈希通过后写入本机。 */
  async storeDownloadedBlob(
    metadata: AttachmentMetadata,
    blob: Blob,
    remoteId: string | null,
  ): Promise<StoredAttachment> {
    const actual = await sha256Blob(blob);
    if (actual !== metadata.sha256 || blob.size !== metadata.byteSize) {
      await this.updateState(metadata.id, {
        status: 'failed',
        lastError: `下载校验失败：期望 ${metadata.sha256}，实际 ${actual}`,
      });
      throw new AttachmentIntegrityError(metadata.sha256, actual);
    }
    const blobKey = bytesKey(metadata.sha256);
    await this.blobStore.put(blobKey, blob);
    await this.updateState(metadata.id, {
      status: 'available',
      localBlobKey: blobKey,
      remoteId,
      lastError: null,
      downloadedAt: this.now(),
    });
    return this.get(metadata.id);
  }

  async importRemote(remote: RemoteAttachment): Promise<StoredAttachment> {
    const metadata: AttachmentMetadata = {
      id: remote.id,
      spaceId: remote.spaceId,
      noteId: remote.noteId,
      blockId: remote.blockId,
      fileName: remote.fileName,
      sha256: remote.sha256,
      byteSize: remote.byteSize,
      mime: remote.mime,
      storageKey: remote.storageKey,
      createdAt: remote.createdAt,
      updatedAt: remote.updatedAt,
      version: 1,
    };
    let known: AttachmentMetadata | null = null;
    try {
      known = await this.repository.get(remote.id);
    } catch {
      known = null;
    }
    if (!known && remote.status !== 'deleted') {
      try {
        known = await this.repository.create({
          id: remote.id,
          spaceId: remote.spaceId,
          noteId: remote.noteId,
          blockId: remote.blockId,
          fileName: remote.fileName,
          sha256: remote.sha256,
          byteSize: remote.byteSize,
          mime: remote.mime,
          storageKey: remote.storageKey,
        });
      } catch {
        known = metadata;
      }
    }
    const target = known ?? metadata;
    const blobKey = bytesKey(target.sha256);
    const hasLocal = await this.blobStore.has(blobKey);
    const state = await this.stateStore.get(target.id);
    if (!state) {
      await this.stateStore.put({
        ...defaultState(target.id, blobKey, this.now()),
        status: hasLocal ? 'available' : 'remote',
        remoteId: remote.id,
        lastError: hasLocal ? null : '仅远端可用，需要下载',
      });
    }
    return this.get(target.id);
  }

  async markUploaded(
    localId: string,
    remote: RemoteAttachment,
  ): Promise<StoredAttachment> {
    return this.updateState(localId, {
      status: 'available',
      remoteId: remote.id,
      lastError: null,
    });
  }

  async markFailed(id: string, reason: unknown): Promise<StoredAttachment> {
    return this.updateState(id, {
      status: 'failed',
      lastError: errorMessage(reason),
    });
  }

  async remove(id: string): Promise<void> {
    const metadata = await this.repository.get(id);
    await this.repository.remove(id);
    await this.stateStore.delete(id);
    const remaining = await this.repository.list();
    const stillReferenced = remaining.some((row) => row.sha256 === metadata.sha256);
    if (!stillReferenced) {
      await this.blobStore.delete(bytesKey(metadata.sha256));
    }
  }

  async onRemoteUploadNeeded(
    attachment: StoredAttachment,
    allowRemote: boolean,
  ): Promise<void> {
    if (
      isImageAttachment(attachment.metadata) &&
      attachment.state.status !== 'available' &&
      !allowRemote
    ) {
      throw new RemoteUploadNotAllowedError(
        '图片默认不上传远程；请在附件卡上明确选择“上传图片到服务器”',
      );
    }
  }

  async listAllMetadata(): Promise<AttachmentMetadata[]> {
    return this.repository.list();
  }

  /** 测试辅助：确认元数据到领域类型的映射保持一致。 */
  static fromDb(row: Parameters<typeof toMetadata>[0]): AttachmentMetadata {
    return toMetadata(row);
  }
}

export function createAttachmentManager(options: AttachmentManagerOptions): AttachmentManager {
  return new AttachmentManager(options);
}
