/**
 * 服务端分片计划。与 app/src/features/attachments/uploadPlan.ts 保持同一
 * 路径约定；两边改动必须同步，集成测试会校验路径与大小。
 */

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
export const MIN_CHUNK_SIZE = 64 * 1024;
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
export const MAX_PARTS = 10_000;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024 * 1024;

export function normalizeChunkSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_CHUNK_SIZE;
  }
  const rounded = Math.floor(value);
  if (rounded < MIN_CHUNK_SIZE) return MIN_CHUNK_SIZE;
  if (rounded > MAX_CHUNK_SIZE) return MAX_CHUNK_SIZE;
  return rounded;
}

export function partCountFor(byteSize: number, chunkSize: number): number {
  if (!Number.isFinite(byteSize) || byteSize < 0) {
    throw new RangeError('附件大小不能为负');
  }
  if (byteSize === 0) return 1;
  return Math.ceil(byteSize / normalizeChunkSize(chunkSize));
}

export function partSizeFor(
  byteSize: number,
  index: number,
  chunkSize: number,
): number {
  const size = normalizeChunkSize(chunkSize);
  const count = partCountFor(byteSize, size);
  if (index < 0 || index >= count) {
    throw new RangeError(`分片索引越界：${index}/${count}`);
  }
  if (byteSize === 0) return 0;
  return Math.min(size, byteSize - index * size);
}

export function partsPrefix(sha256: string, spaceId: string): string {
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
  spaceId: string,
): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('分片索引必须是非负整数');
  }
  return `${partsPrefix(sha256, spaceId)}/${index}`;
}

export function completeStorageKey(sha256: string, spaceId: string): string {
  return `${partsPrefix(sha256, spaceId)}/complete.json`;
}

export const PART_CONTENT_TYPE = 'application/octet-stream';
export const COMPLETE_CONTENT_TYPE = 'application/json';
