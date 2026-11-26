/**
 * 附件元数据仓储适配。
 *
 * 元数据始终写入 SQLite（Tauri IPC）。浏览器预览没有 IPC 时由调用方提供
 * 内存仓储；这里绝不回退 localStorage 冒充权威库。
 */

import type { DbClient } from '../../data/db/client';
import type { AttachmentUpdate, NewAttachment } from '../../data/db/types';
import {
  toMetadata,
  type AttachmentMetadata,
} from './types';

export type AttachmentMetadataRepository = {
  list: (noteId?: string | null) => Promise<AttachmentMetadata[]>;
  get: (id: string) => Promise<AttachmentMetadata>;
  create: (input: NewAttachment) => Promise<AttachmentMetadata>;
  update: (id: string, input: AttachmentUpdate) => Promise<AttachmentMetadata>;
  remove: (id: string) => Promise<void>;
};

export function createDbAttachmentRepository(
  client: DbClient,
): AttachmentMetadataRepository {
  return {
    async list(noteId) {
      const rows = await client.attachments.list(
        noteId === undefined || noteId === null ? {} : { noteId },
      );
      return rows.map(toMetadata);
    },
    async get(id) {
      return toMetadata(await client.attachments.get(id));
    },
    async create(input) {
      return toMetadata(await client.attachments.create(input));
    },
    async update(id, input) {
      return toMetadata(await client.attachments.update(id, input));
    },
    async remove(id) {
      await client.attachments.remove(id);
    },
  };
}

export class MemoryAttachmentMetadataRepository
  implements AttachmentMetadataRepository
{
  private readonly rows = new Map<string, AttachmentMetadata>();
  private sequence = 0;

  constructor(seed: AttachmentMetadata[] = []) {
    for (const row of seed) {
      this.rows.set(row.id, { ...row });
    }
  }

  async list(noteId?: string | null): Promise<AttachmentMetadata[]> {
    const values = Array.from(this.rows.values());
    return values
      .filter((row) => noteId === undefined || noteId === null || row.noteId === noteId)
      .map((row) => ({ ...row }));
  }

  async get(id: string): Promise<AttachmentMetadata> {
    const row = this.rows.get(id);
    if (!row) {
      throw new Error(`附件不存在：${id}`);
    }
    return { ...row };
  }

  async create(input: NewAttachment): Promise<AttachmentMetadata> {
    this.sequence += 1;
    const now = new Date().toISOString();
    const id = input.id ?? `att_${String(this.sequence).padStart(4, '0')}`;
    const row: AttachmentMetadata = {
      id,
      spaceId: input.spaceId ?? 'personal',
      noteId: input.noteId ?? null,
      blockId: input.blockId ?? null,
      fileName: input.fileName,
      sha256: input.sha256.toLowerCase(),
      byteSize: input.byteSize,
      mime: input.mime ?? 'application/octet-stream',
      storageKey: input.storageKey,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.rows.set(id, row);
    return { ...row };
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async update(
    id: string,
    input: AttachmentUpdate,
  ): Promise<AttachmentMetadata> {
    const row = this.rows.get(id);
    if (!row) {
      throw new Error(`附件不存在：${id}`);
    }
    const next: AttachmentMetadata = {
      ...row,
      noteId: input.noteId,
      blockId: input.blockId,
      fileName: input.fileName.trim(),
      mime: input.mime,
      storageKey: input.storageKey,
      updatedAt: new Date().toISOString(),
      version: row.version + 1,
    };
    this.rows.set(id, next);
    return { ...next };
  }

  /** 测试辅助：直接放一条元数据。 */
  seed(row: AttachmentMetadata): void {
    this.rows.set(row.id, { ...row });
  }

  all(): AttachmentMetadata[] {
    return Array.from(this.rows.values()).map((row) => ({ ...row }));
  }
}
