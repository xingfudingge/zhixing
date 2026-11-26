/**
 * 快照 gzip。
 *
 * 写入端使用“stored block”编码：不压缩，但生成的是标准 gzip 流，
 * 任何客户端都能用 zlib/浏览器解压。这样渲染层不需要引入 node:zlib，
 * 也不会因为不同 WebView 的压缩实现差异产生不兼容文件。
 * 读取端优先用 DecompressionStream（Tauri/现代浏览器/Node 18+ 都有）。
 */

import { WebDavError } from './errors.ts';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

export function gzipBytes(input: Uint8Array): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(input.length / 65535));
  const outputLength = 10 + input.length + blockCount * 5 + 8;
  const output = new Uint8Array(outputLength);
  output[0] = 0x1f;
  output[1] = 0x8b;
  output[2] = 0x08; // deflate
  output[3] = 0; // flags
  // mtime 0，XFL 0，OS 255（unknown），保证同一内容生成稳定字节。
  output[8] = 0;
  output[9] = 0xff;

  let read = 0;
  let write = 10;
  for (let block = 0; block < blockCount; block += 1) {
    const length = Math.min(65535, input.length - read);
    const final = block === blockCount - 1;
    output[write] = final ? 1 : 0;
    writeUint32LE(output, write + 1, length);
    writeUint32LE(output, write + 3, (~length) & 0xffff);
    write += 5;
    output.set(input.subarray(read, read + length), write);
    write += length;
    read += length;
  }

  writeUint32LE(output, write, crc32(input));
  writeUint32LE(output, write + 4, input.length >>> 0);
  return output;
}

export async function gunzipBytes(input: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new WebDavError(
      'COMPRESSION_UNSUPPORTED',
      '当前环境不支持 gzip 解压，无法读取远端快照',
    );
  }
  try {
    // 复制一份，避免某些实现把输入 buffer detach 后调用方无法复用。
    const stream = new DecompressionStream('gzip');
    const writer = stream.writable.getWriter();
    await writer.write(input.slice());
    await writer.close();
    const buffer = await new Response(stream.readable).arrayBuffer();
    return new Uint8Array(buffer);
  } catch (error) {
    throw new WebDavError('INVALID_DATA', '快照 gzip 解压失败', {
      cause: error,
    });
  }
}

export function encodeGzipJson(value: unknown): Uint8Array {
  return gzipBytes(new TextEncoder().encode(JSON.stringify(value)));
}

export async function decodeGzipJson<T>(bytes: Uint8Array): Promise<T> {
  const raw = await gunzipBytes(bytes);
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as T;
  } catch (error) {
    throw new WebDavError('INVALID_DATA', '快照 JSON 解析失败', {
      cause: error,
    });
  }
}
