/**
 * UUIDv7（时间有序）+ 简易稳定哈希。
 * 不依赖 Node 专属 API，浏览器与 Tauri 渲染层均可使用。
 */

let lastTimestamp = -1;
let sequence = 0;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

export function uuidv7(now = Date.now()): string {
  let timestamp = now;
  if (timestamp < lastTimestamp) timestamp = lastTimestamp;
  if (timestamp === lastTimestamp) {
    sequence += 1;
    if (sequence > 0x0fff) {
      timestamp += 1;
      sequence = 0;
    }
  } else {
    sequence = 0;
  }
  lastTimestamp = timestamp;

  const bytes = new Uint8Array(16);
  const random = randomBytes(16);
  // 48-bit big-endian 毫秒时间戳
  bytes[0] = (timestamp / 2 ** 40) & 0xff;
  bytes[1] = (timestamp / 2 ** 32) & 0xff;
  bytes[2] = (timestamp / 2 ** 24) & 0xff;
  bytes[3] = (timestamp / 2 ** 16) & 0xff;
  bytes[4] = (timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  // version 7
  bytes[6] = 0x70 | (sequence >> 8) & 0x0f;
  bytes[7] = sequence & 0xff;
  // RFC 4122 variant
  bytes[8] = 0x80 | (random[8] & 0x3f);
  for (const index of [9, 10, 11, 12, 13, 14, 15]) {
    bytes[index] = random[index];
  }
  return formatUuid(bytes);
}

/** FNV-1a 64-bit，返回 16 位十六进制；用于确定性冲突副本 ID。 */
export function stableHash(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isOperationId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value);
}
