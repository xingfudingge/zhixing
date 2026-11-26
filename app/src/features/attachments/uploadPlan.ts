/**
 * 分片上传计划（与 server/src/attachments 共用同一套路径约定）。
 *
 * 对象布局：
 *   spaces/{space}/assets/.parts/{sha256}/{index}
 *   spaces/{space}/assets/.parts/{sha256}/complete.json
 *
 * 分片只写一次、永不改名；`complete.json` 记录分片哈希。服务端在标记
 * `available` 之前逐个 HEAD + 回读校验分片，下载端合并后再校验整体哈希。
 */

import type { AttachmentPart } from './types';

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
export const MIN_CHUNK_SIZE = 64 * 1024;
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
export const MAX_PARTS = 10_000;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024 * 1024;

export function normalizeChunkSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CHUNK_SIZE;
  const rounded = Math.floor(value);
  if (rounded < MIN_CHUNK_SIZE) return MIN_CHUNK_SIZE;
  if (rounded > MAX_CHUNK_SIZE) return MAX_CHUNK_SIZE;
  return rounded;
}

export function partCountFor(
  byteSize: number,
  chunkSize = DEFAULT_CHUNK_SIZE,
): number {
  if (!Number.isFinite(byteSize) || byteSize < 0) {
    throw new RangeError('附件大小不能为负');
  }
  if (byteSize === 0) return 1;
  const size = normalizeChunkSize(chunkSize);
  return Math.ceil(byteSize / size);
}

export function validateAttachmentSize(byteSize: number): void {
  if (!Number.isFinite(byteSize) || byteSize < 0) {
    throw new RangeError('附件大小不能为负');
  }
  if (byteSize > MAX_ATTACHMENT_BYTES) {
    throw new RangeError('附件超过 5GB 上限');
  }
}

export function partSizeFor(
  byteSize: number,
  index: number,
  chunkSize = DEFAULT_CHUNK_SIZE,
): number {
  const size = normalizeChunkSize(chunkSize);
  const count = partCountFor(byteSize, size);
  if (index < 0 || index >= count) {
    throw new RangeError(`分片索引越界：${index}/${count}`);
  }
  if (byteSize === 0) return 0;
  const start = index * size;
  return Math.min(size, byteSize - start);
}

export function planAttachmentParts(
  byteSize: number,
  chunkSize = DEFAULT_CHUNK_SIZE,
): { index: number; size: number }[] {
  validateAttachmentSize(byteSize);
  const size = normalizeChunkSize(chunkSize);
  const count = partCountFor(byteSize, size);
  return Array.from({ length: count }, (_, index) => ({
    index,
    size: partSizeFor(byteSize, index, size),
  }));
}

export function partsPrefix(sha256: string, spaceId = 'personal'): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error('sha256 必须是 64 位小写十六进制');
  }
  if (!/^[a-z0-9_-]{1,64}$/.test(spaceId)) {
    throw new Error('spaceId 不合法');
  }
  return `spaces/${spaceId}/assets/.parts/${sha256}`;
}

export function partStorageKey(
  sha256: string,
  index: number,
  spaceId = 'personal',
): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('分片索引必须是非负整数');
  }
  return `${partsPrefix(sha256, spaceId)}/${index}`;
}

export function completeStorageKey(
  sha256: string,
  spaceId = 'personal',
): string {
  return `${partsPrefix(sha256, spaceId)}/complete.json`;
}

export type CompleteManifest = {
  version: 1;
  sha256: string;
  byteSize: number;
  chunkSize: number;
  partCount: number;
  parts: AttachmentPart[];
  createdAt: string;
};

export function createCompleteManifest(input: {
  sha256: string;
  byteSize: number;
  chunkSize: number;
  parts: ReadonlyArray<AttachmentPart>;
  createdAt?: string;
}): CompleteManifest {
  validateAttachmentSize(input.byteSize);
  const expectedCount = partCountFor(input.byteSize, input.chunkSize);
  if (input.parts.length !== expectedCount) {
    throw new Error(
      `分片数量不一致：期望 ${expectedCount}，实际 ${input.parts.length}`,
    );
  }
  const sorted = [...input.parts].sort((a, b) => a.index - b.index);
  sorted.forEach((part, index) => {
    if (part.index !== index) {
      throw new Error(`分片索引不连续：缺少 ${index}`);
    }
    if (part.size !== partSizeFor(input.byteSize, index, input.chunkSize)) {
      throw new Error(`分片 ${index} 大小不正确`);
    }
  });
  return {
    version: 1,
    sha256: input.sha256,
    byteSize: input.byteSize,
    chunkSize: normalizeChunkSize(input.chunkSize),
    partCount: expectedCount,
    parts: sorted,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function completeManifestBlob(manifest: CompleteManifest): Blob {
  return new Blob([JSON.stringify(manifest)], {
    type: 'application/json',
  });
}

export function isCompleteManifest(value: unknown): value is CompleteManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  return (
    raw.version === 1 &&
    typeof raw.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(raw.sha256) &&
    typeof raw.byteSize === 'number' &&
    typeof raw.chunkSize === 'number' &&
    typeof raw.partCount === 'number' &&
    Array.isArray(raw.parts)
  );
}

/** 把附件切成上传分片；索引与 `planAttachmentParts` 一致。 */
export function sliceAttachment(
  blob: Blob,
  chunkSize = DEFAULT_CHUNK_SIZE,
): { index: number; blob: Blob }[] {
  const size = normalizeChunkSize(chunkSize);
  const count = partCountFor(blob.size, size);
  return Array.from({ length: count }, (_, index) => ({
    index,
    blob:
      blob.size === 0
        ? blob.slice(0, 0)
        : blob.slice(index * size, Math.min((index + 1) * size, blob.size)),
  }));
}
