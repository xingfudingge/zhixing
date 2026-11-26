import type { DbPool } from '../db/pool.ts';
import type { AttachmentRow, DeviceRow } from '../db/rows.ts';
import { attachmentToJson } from '../db/rows.ts';
import { errors } from '../errors.ts';
import { newAttachmentId } from '../security/tokens.ts';
import type { StorageService } from './storage.ts';

export type AttachmentInput = {
  spaceId: string;
  noteId?: string | null;
  blockId?: string | null;
  fileName: string;
  sha256: string;
  byteSize: number;
  mime: string;
};

export type AttachmentJson = ReturnType<typeof attachmentToJson>;

function storageKeyFor(spaceId: string, sha256: string): string {
  return `spaces/${spaceId}/assets/${sha256}`;
}

export class AttachmentService {
  constructor(
    private readonly pool: DbPool,
    private readonly storage: StorageService,
  ) {}

  async init(
    device: DeviceRow,
    input: AttachmentInput,
  ): Promise<{ attachment: AttachmentJson; uploadUrl: string | null; alreadyAvailable: boolean }> {
    if (!this.storage.configured) {
      throw errors.serviceUnavailable('未配置对象存储，无法上传附件', 'STORAGE_NOT_CONFIGURED');
    }
    const storageKey = storageKeyFor(input.spaceId, input.sha256);
    const result = await this.pool.query<AttachmentRow>(
      `INSERT INTO attachments
         (id, space_id, note_id, block_id, file_name, sha256, byte_size, mime,
          storage_key, status, created_by_device_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)
       ON CONFLICT (space_id, sha256) DO UPDATE
         SET note_id = COALESCE(EXCLUDED.note_id, attachments.note_id),
             block_id = COALESCE(EXCLUDED.block_id, attachments.block_id),
             file_name = EXCLUDED.file_name,
             byte_size = EXCLUDED.byte_size,
             mime = EXCLUDED.mime,
             updated_at = now()
       RETURNING *`,
      [
        newAttachmentId(),
        input.spaceId,
        input.noteId ?? null,
        input.blockId ?? null,
        input.fileName,
        input.sha256,
        input.byteSize,
        input.mime,
        storageKey,
        device.id,
      ],
    );
    const row = result.rows[0]!;
    const alreadyAvailable = row.status === 'available';
    const uploadUrl = alreadyAvailable
      ? null
      : await this.storage.putUrl(row.storage_key, row.mime, 900);
    return {
      attachment: attachmentToJson(row),
      uploadUrl,
      alreadyAvailable,
    };
  }

  async complete(
    _device: DeviceRow,
    attachmentId: string,
  ): Promise<{ attachment: AttachmentJson; verified: true }> {
    const existing = await this.pool.query<AttachmentRow>(
      `SELECT * FROM attachments
        WHERE id = $1 AND status <> 'deleted'`,
      [attachmentId],
    );
    const row = existing.rows[0];
    if (!row) throw errors.notFound('附件不存在', 'ATTACHMENT_NOT_FOUND');
    if (row.status === 'available') {
      return { attachment: attachmentToJson(row), verified: true };
    }

    const stat = await this.storage.stat(row.storage_key);
    if (stat.size !== Number(row.byte_size)) {
      throw errors.unprocessable('附件大小与元数据不一致', 'ATTACHMENT_SIZE_MISMATCH', {
        expected: Number(row.byte_size),
        actual: stat.size,
      });
    }
    await this.storage.verifyHash(row.storage_key, row.sha256);

    const updated = await this.pool.query<AttachmentRow>(
      `UPDATE attachments
          SET status = 'available', updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [row.id],
    );
    return { attachment: attachmentToJson(updated.rows[0]!), verified: true };
  }

  async getDownloadUrl(
    device: DeviceRow,
    attachmentId: string,
  ): Promise<{ attachment: AttachmentJson; downloadUrl: string }> {
    const result = await this.pool.query<AttachmentRow>(
      `SELECT * FROM attachments
        WHERE id = $1 AND status <> 'deleted'`,
      [attachmentId],
    );
    const row = result.rows[0];
    if (!row) throw errors.notFound('附件不存在', 'ATTACHMENT_NOT_FOUND');
    if (row.status !== 'available') {
      throw errors.conflict('附件尚未上传完成', 'ATTACHMENT_NOT_READY');
    }
    void device;
    return {
      attachment: attachmentToJson(row),
      downloadUrl: await this.storage.getUrl(row.storage_key, 900),
    };
  }

  async list(spaceId: string, noteId: string | null): Promise<AttachmentJson[]> {
    const result = noteId
      ? await this.pool.query<AttachmentRow>(
          `SELECT * FROM attachments
            WHERE space_id = $1 AND note_id = $2 AND status <> 'deleted'
            ORDER BY created_at ASC`,
          [spaceId, noteId],
        )
      : await this.pool.query<AttachmentRow>(
          `SELECT * FROM attachments
            WHERE space_id = $1 AND status <> 'deleted'
            ORDER BY created_at ASC`,
          [spaceId],
        );
    return result.rows.map(attachmentToJson);
  }

  async remove(_device: DeviceRow, attachmentId: string): Promise<AttachmentJson> {
    const result = await this.pool.query<AttachmentRow>(
      `UPDATE attachments
          SET status = 'deleted', deleted_at = now(), updated_at = now()
        WHERE id = $1 AND status <> 'deleted'
        RETURNING *`,
      [attachmentId],
    );
    const row = result.rows[0];
    if (!row) throw errors.notFound('附件不存在', 'ATTACHMENT_NOT_FOUND');
    return attachmentToJson(row);
  }
}
