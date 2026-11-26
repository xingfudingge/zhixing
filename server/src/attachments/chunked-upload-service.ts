/**
 * 分片直传 MinIO 的会话/完成/下载清单服务。
 *
 * 二进制不经过应用服务器：分片与 complete.json 都由客户端用预签名 URL
 * 直接 PUT。服务端在 complete 时逐个 HEAD + 回读 SHA-256 校验，全部通过
 * 才把 attachments.status 置为 available。任何一片缺失/损坏都不会标记成功。
 */

import { createHash } from 'node:crypto';

import type { DbPool } from '../db/pool.ts';
import type { AttachmentRow, DeviceRow } from '../db/rows.ts';
import { attachmentToJson } from '../db/rows.ts';
import { errors } from '../errors.ts';
import type { StorageService } from '../services/storage.ts';
import {
  COMPLETE_CONTENT_TYPE,
  MAX_ATTACHMENT_BYTES,
  MAX_PARTS,
  PART_CONTENT_TYPE,
  completeStorageKey,
  normalizeChunkSize,
  partCountFor,
  partSizeFor,
  partStorageKey,
} from './chunk-plan.ts';

export type ChunkPart = {
  index: number;
  size: number;
  sha256: string;
};

export type UploadSessionResult = {
  attachment: ReturnType<typeof attachmentToJson>;
  chunkSize: number;
  partCount: number;
  presentPartIndexes: number[];
  missingParts: { index: number; size: number; url: string }[];
  completeUrl: string;
  completeKey: string;
  alreadyAvailable: boolean;
};

export type CompleteUploadInput = {
  chunkSize: number;
  partCount: number;
  completeSha256: string;
  parts: ChunkPart[];
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type AttachmentChunkServiceOptions = {
  fetchImpl?: FetchLike;
  assemble?: boolean;
  /** 超过该大小的文件不在服务端组装整对象，保留下载清单模式。 */
  maxAssembleBytes?: number;
};

export type DownloadManifestResult = {
  attachment: ReturnType<typeof attachmentToJson>;
  chunkSize: number;
  partCount: number;
  parts: { index: number; size: number; url: string }[];
};

const DEFAULT_MAX_ASSEMBLE_BYTES = 256 * 1024 * 1024;

export class AttachmentChunkService {
  private readonly fetchImpl: FetchLike;
  private readonly assemble: boolean;
  private readonly maxAssembleBytes: number;

  constructor(
    private readonly pool: DbPool,
    private readonly storage: StorageService,
    options: AttachmentChunkServiceOptions = {},
  ) {
    this.fetchImpl =
      options.fetchImpl ??
      ((input, init) => {
        if (typeof fetch !== 'function') {
          return Promise.reject(new Error('当前环境没有 fetch'));
        }
        return fetch(input, init);
      });
    this.assemble = options.assemble ?? true;
    this.maxAssembleBytes =
      options.maxAssembleBytes ?? DEFAULT_MAX_ASSEMBLE_BYTES;
  }

  private requireStorage(): void {
    if (!this.storage.configured) {
      throw errors.serviceUnavailable('未配置对象存储，无法上传附件', 'STORAGE_NOT_CONFIGURED');
    }
  }

  private async load(attachmentId: string): Promise<AttachmentRow> {
    const result = await this.pool.query<AttachmentRow>(
      `SELECT * FROM attachments
        WHERE id = $1 AND status <> 'deleted'`,
      [attachmentId],
    );
    const row = result.rows[0];
    if (!row) throw errors.notFound('附件不存在', 'ATTACHMENT_NOT_FOUND');
    return row;
  }

  private async exists(key: string): Promise<boolean> {
    try {
      await this.storage.stat(key);
      return true;
    } catch {
      return false;
    }
  }

  async createSession(
    _device: DeviceRow,
    attachmentId: string,
    requestedChunkSize?: number,
  ): Promise<UploadSessionResult> {
    this.requireStorage();
    const row = await this.load(attachmentId);
    const byteSize = Number(row.byte_size);
    if (byteSize > MAX_ATTACHMENT_BYTES) {
      throw errors.unprocessable('附件超过 5GB 上限', 'ATTACHMENT_TOO_LARGE');
    }
    const chunkSize = normalizeChunkSize(requestedChunkSize);
    const partCount = partCountFor(byteSize, chunkSize);
    if (partCount > MAX_PARTS) {
      throw errors.unprocessable('分片数量过多', 'ATTACHMENT_TOO_MANY_PARTS');
    }
    const completeKey = completeStorageKey(row.sha256, row.space_id);
    const completeUrl = await this.storage.putUrl(
      completeKey,
      COMPLETE_CONTENT_TYPE,
      900,
    );
    const presentPartIndexes: number[] = [];
    const missingParts: { index: number; size: number; url: string }[] = [];
    const alreadyAvailable = row.status === 'available';

    if (!alreadyAvailable) {
      for (let index = 0; index < partCount; index += 1) {
        const key = partStorageKey(row.sha256, index, row.space_id);
        if (await this.exists(key)) {
          presentPartIndexes.push(index);
        } else {
          missingParts.push({
            index,
            size: partSizeFor(byteSize, index, chunkSize),
            url: await this.storage.putUrl(key, PART_CONTENT_TYPE, 900),
          });
        }
      }
    } else {
      for (let index = 0; index < partCount; index += 1) {
        presentPartIndexes.push(index);
      }
    }

    return {
      attachment: attachmentToJson(row),
      chunkSize,
      partCount,
      presentPartIndexes,
      missingParts,
      completeUrl,
      completeKey,
      alreadyAvailable,
    };
  }

  async complete(
    _device: DeviceRow,
    attachmentId: string,
    input: CompleteUploadInput,
  ): Promise<{
    attachment: ReturnType<typeof attachmentToJson>;
    verified: true;
  }> {
    this.requireStorage();
    const row = await this.load(attachmentId);
    if (row.status === 'available') {
      return { attachment: attachmentToJson(row), verified: true };
    }
    const byteSize = Number(row.byte_size);
    const chunkSize = normalizeChunkSize(input.chunkSize);
    const expectedCount = partCountFor(byteSize, chunkSize);
    if (input.partCount !== expectedCount) {
      throw errors.unprocessable('分片数量与附件大小不一致', 'ATTACHMENT_PART_COUNT_MISMATCH', {
        expected: expectedCount,
        actual: input.partCount,
      });
    }
    if (input.parts.length !== expectedCount) {
      throw errors.unprocessable('提交的分片清单不完整', 'ATTACHMENT_PARTS_INCOMPLETE');
    }
    if (!/^[0-9a-f]{64}$/.test(input.completeSha256)) {
      throw errors.badRequest('completeSha256 必须是 64 位小写十六进制');
    }

    const sorted = [...input.parts].sort((a, b) => a.index - b.index);
    for (let index = 0; index < sorted.length; index += 1) {
      const part = sorted[index]!;
      if (part.index !== index) {
        throw errors.unprocessable('分片索引不连续', 'ATTACHMENT_PART_INDEX_GAP', {
          expected: index,
          actual: part.index,
        });
      }
      if (!/^[0-9a-f]{64}$/.test(part.sha256)) {
        throw errors.badRequest(`分片 ${index} 的 sha256 不合法`);
      }
      if (part.size !== partSizeFor(byteSize, index, chunkSize)) {
        throw errors.unprocessable(
          `分片 ${index} 大小不正确`,
          'ATTACHMENT_PART_SIZE_MISMATCH',
          { expected: partSizeFor(byteSize, index, chunkSize), actual: part.size },
        );
      }
      const key = partStorageKey(row.sha256, index, row.space_id);
      const stat = await this.storage.stat(key);
      if (stat.size !== part.size) {
        throw errors.unprocessable(
          `分片 ${index} 对象大小与清单不一致`,
          'ATTACHMENT_PART_SIZE_MISMATCH',
          { expected: part.size, actual: stat.size },
        );
      }
      await this.storage.verifyHash(key, part.sha256);
    }

    const completeKey = completeStorageKey(row.sha256, row.space_id);
    const completeStat = await this.storage.stat(completeKey);
    if (completeStat.size <= 0) {
      throw errors.unprocessable(
        '缺少 complete.json 分片清单',
        'ATTACHMENT_COMPLETE_MANIFEST_MISSING',
      );
    }
    await this.storage.verifyHash(completeKey, input.completeSha256);

    if (this.assemble && byteSize <= this.maxAssembleBytes) {
      await this.assembleWholeObject(row, sorted, chunkSize, completeKey);
    }

    const updated = await this.pool.query<AttachmentRow>(
      `UPDATE attachments
          SET status = 'available', updated_at = now()
        WHERE id = $1 AND status <> 'deleted'
        RETURNING *`,
      [row.id],
    );
    const next = updated.rows[0];
    if (!next) throw errors.notFound('附件不存在', 'ATTACHMENT_NOT_FOUND');
    return { attachment: attachmentToJson(next), verified: true };
  }

  /**
   * 把已校验的分片拼成整文件 `assets/{sha256}`，让旧的 `/download` 接口
   * 与导出/备份仍能拿到单对象。成功后删除分片，避免双份存储。
   * 大文件超过阈值时保留分片，由下载清单读取。
   */
  private async assembleWholeObject(
    row: AttachmentRow,
    parts: ChunkPart[],
    chunkSize: number,
    completeKey: string,
  ): Promise<void> {
    const buffers: Uint8Array[] = [];
    const hash = createHash('sha256');
    let total = 0;
    for (const part of parts) {
      const key = partStorageKey(row.sha256, part.index, row.space_id);
      let response: Response;
      try {
        response = await this.fetchImpl(await this.storage.getUrl(key, 900), {
          method: 'GET',
        });
      } catch (reason) {
        throw errors.serviceUnavailable(
          `附件分片组装失败：${(reason as Error).message}`,
          'ATTACHMENT_ASSEMBLY_FAILED',
        );
      }
      if (!response.ok) {
        throw errors.serviceUnavailable(
          `附件分片组装失败（HTTP ${response.status}）`,
          'ATTACHMENT_ASSEMBLY_FAILED',
        );
      }
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.length !== part.size) {
        throw errors.unprocessable(
          `分片 ${part.index} 组装大小不一致`,
          'ATTACHMENT_PART_SIZE_MISMATCH',
        );
      }
      hash.update(data);
      buffers.push(data);
      total += data.length;
    }
    if (total !== Number(row.byte_size)) {
      throw errors.unprocessable('组装后的附件大小与元数据不一致');
    }
    const actual = hash.digest('hex');
    if (actual !== row.sha256) {
      throw errors.unprocessable('组装后的附件 SHA-256 不一致', 'ATTACHMENT_HASH_MISMATCH');
    }
    let put: Response;
    try {
      put = await this.fetchImpl(
        await this.storage.putUrl(row.storage_key, row.mime, 900),
        {
          method: 'PUT',
          headers: { 'content-type': row.mime },
          body: Buffer.concat(buffers),
        },
      );
    } catch (reason) {
      throw errors.serviceUnavailable(
        `附件整对象写入失败：${(reason as Error).message}`,
        'ATTACHMENT_ASSEMBLY_FAILED',
      );
    }
    if (!put.ok) {
      throw errors.serviceUnavailable(
        `附件整对象写入失败（HTTP ${put.status}）`,
        'ATTACHMENT_ASSEMBLY_FAILED',
      );
    }
    await this.storage.verifyHash(row.storage_key, row.sha256);
    for (let index = 0; index < parts.length; index += 1) {
      await this.storage
        .delete(partStorageKey(row.sha256, index, row.space_id))
        .catch(() => undefined);
    }
    await this.storage.delete(completeKey).catch(() => undefined);
    void chunkSize;
  }

  async downloadManifest(
    _device: DeviceRow,
    attachmentId: string,
    requestedChunkSize?: number,
  ): Promise<DownloadManifestResult> {
    this.requireStorage();
    const row = await this.load(attachmentId);
    if (row.status !== 'available') {
      throw errors.conflict('附件尚未上传完成', 'ATTACHMENT_NOT_READY');
    }
    const byteSize = Number(row.byte_size);
    const chunkSize = normalizeChunkSize(requestedChunkSize);
    const partCount = partCountFor(byteSize, chunkSize);
    if (partCount > MAX_PARTS) {
      throw errors.unprocessable('分片数量过多', 'ATTACHMENT_TOO_MANY_PARTS');
    }

    const parts: { index: number; size: number; url: string }[] = [];
    let missing = 0;
    for (let index = 0; index < partCount; index += 1) {
      const key = partStorageKey(row.sha256, index, row.space_id);
      if (await this.exists(key)) {
        parts.push({
          index,
          size: partSizeFor(byteSize, index, chunkSize),
          url: await this.storage.getUrl(key, 900),
        });
      } else {
        missing += 1;
      }
    }

    // 兼容旧版整文件上传：没有任何分片时退回 storage_key 单对象。
    if (missing === partCount) {
      if (await this.exists(row.storage_key)) {
        return {
          attachment: attachmentToJson(row),
          chunkSize: Math.max(1, byteSize),
          partCount: 1,
          parts: [
            {
              index: 0,
              size: byteSize,
              url: await this.storage.getUrl(row.storage_key, 900),
            },
          ],
        };
      }
    }
    if (missing > 0) {
      throw errors.conflict(
        '附件分片不完整，需要重新上传',
        'ATTACHMENT_OBJECT_MISSING',
        { missing },
      );
    }

    return {
      attachment: attachmentToJson(row),
      chunkSize,
      partCount,
      parts,
    };
  }

  /** 测试/诊断：判断某个分片是否存在。 */
  async partExists(
    attachmentId: string,
    index: number,
  ): Promise<boolean> {
    const row = await this.load(attachmentId);
    return this.exists(partStorageKey(row.sha256, index, row.space_id));
  }
}
