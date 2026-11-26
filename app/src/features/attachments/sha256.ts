/**
 * SHA-256 增量实现（纯 TS）。
 *
 * 附件是内容寻址的：本地落盘前、上传分片前、下载合并后都必须用同一份
 * 算法校验。这里不依赖 WebCrypto，原因有二：
 * 1. Tauri WebView / jsdom 的 `crypto.subtle` 可用性不一致；
 * 2. 大文件需要边读边算，不能一次性把整块内容读进内存。
 *
 * 实现遵循 FIPS 180-4。测试用 Node `crypto` 的标准向量交叉验证。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly buffer = new Uint8Array(64);
  private bufferLength = 0;
  private bytesHashed = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) {
      throw new Error('SHA-256 已完成，不能继续 update');
    }
    let offset = 0;
    this.bytesHashed += data.length;

    if (this.bufferLength > 0) {
      const need = Math.min(64 - this.bufferLength, data.length);
      this.buffer.set(data.subarray(0, need), this.bufferLength);
      this.bufferLength += need;
      offset = need;
      if (this.bufferLength === 64) {
        this.compress(this.buffer, 0);
        this.bufferLength = 0;
      }
    }

    while (offset + 64 <= data.length) {
      this.compress(data, offset);
      offset += 64;
    }

    if (offset < data.length) {
      this.buffer.set(data.subarray(offset), 0);
      this.bufferLength = data.length - offset;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finished) {
      throw new Error('SHA-256 已结束');
    }
    this.finished = true;
    const bitLength = this.bytesHashed * 8;
    const tail = new Uint8Array(this.bufferLength < 56 ? 64 : 128);
    tail.set(this.buffer.subarray(0, this.bufferLength));
    tail[this.bufferLength] = 0x80;
    const view = new DataView(tail.buffer);
    // 长度上限 2^53 bit；JS 安全整数范围内足够。
    view.setUint32(tail.length - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(tail.length - 4, bitLength >>> 0);
    this.compress(tail, 0);
    if (tail.length === 128) {
      this.compress(tail, 64);
    }

    const output = new Uint8Array(32);
    const outView = new DataView(output.buffer);
    for (let index = 0; index < 8; index += 1) {
      outView.setUint32(index * 4, this.state[index]!);
    }
    return output;
  }

  hex(): string {
    return bytesToHex(this.digest());
  }

  private compress(block: Uint8Array, offset: number): void {
    const w = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset + offset, 64);
    for (let index = 0; index < 16; index += 1) {
      w[index] = view.getUint32(index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotr(w[index - 15]!, 7) ^ rotr(w[index - 15]!, 18) ^ (w[index - 15]! >>> 3);
      const s1 =
        rotr(w[index - 2]!, 17) ^ rotr(w[index - 2]!, 19) ^ (w[index - 2]! >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0;
    }

    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[index]! + w[index]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0;
    this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0;
    this.state[7] = (this.state[7]! + h) >>> 0;
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function sha256Bytes(data: Uint8Array): string {
  return new Sha256().update(data).hex();
}

const READ_CHUNK = 1024 * 1024;

function isBlob(value: unknown): value is Blob {
  return (
    typeof Blob !== 'undefined' &&
    value instanceof Blob
  );
}

function hasReadableStream(blob: Blob): boolean {
  return typeof (blob as Blob & { stream?: unknown }).stream === 'function';
}

/**
 * 计算 Blob 的 SHA-256。带进度回调，按 1MB 读取，不复制整文件。
 */
export async function sha256Blob(
  blob: Blob,
  onProgress?: (hashedBytes: number, totalBytes: number) => void,
): Promise<string> {
  const hash = new Sha256();
  const total = blob.size;
  if (total === 0) {
    onProgress?.(0, 0);
    return hash.hex();
  }

  if (hasReadableStream(blob) && typeof blob.stream === 'function') {
    const reader = blob.stream().getReader();
    let hashed = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        hash.update(value);
        hashed += value.length;
        onProgress?.(hashed, total);
      }
    } finally {
      reader.releaseLock();
    }
    return hash.hex();
  }

  let offset = 0;
  while (offset < total) {
    const end = Math.min(offset + READ_CHUNK, total);
    const buffer = await blob.slice(offset, end).arrayBuffer();
    hash.update(new Uint8Array(buffer));
    offset = end;
    onProgress?.(offset, total);
  }
  return hash.hex();
}

/** 合并多个分片后计算总哈希；用于下载校验。 */
export async function sha256Parts(parts: ReadonlyArray<Blob>): Promise<string> {
  const hash = new Sha256();
  for (const part of parts) {
    const buffer = await part.arrayBuffer();
    hash.update(new Uint8Array(buffer));
  }
  return hash.hex();
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** 供调用方在不确定输入类型时使用；不是 Blob 时明确报错，不静默算空值。 */
export async function sha256Of(value: unknown): Promise<string> {
  if (!isBlob(value)) {
    throw new TypeError('sha256Of 需要 Blob');
  }
  return sha256Blob(value);
}
