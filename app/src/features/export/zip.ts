/**
 * 最小 ZIP 读写器（P2-04）。
 *
 * 备份必须是一个可被系统解压工具打开的标准 ZIP；这里不引入第三方依赖，
 * 只实现 STORE（不压缩）写入，并读取 STORE / DEFLATE 两种条目。
 * 读取时严格校验路径、CRC32、条目数量与解压后大小，拒绝路径穿越和
 * 超大压缩包，避免把不可信备份直接展开到本机。
 */

export type ZipWriteEntry = {
  path: string;
  data: Uint8Array;
};

export type ZipReadEntry = {
  path: string;
  data: Uint8Array;
  crc32: number;
  method: number;
};

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

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

export function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

const MAX_ENTRIES = 20_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

export function normalizeZipPath(raw: string): string {
  const path = raw.replace(/\\/g, '/');
  if (!path || path.includes('\0') || path.startsWith('/')) {
    throw new ZipError(`ZIP 条目路径无效：${raw}`);
  }
  const parts = path.split('/');
  if (parts.some((part) => part === '..' || part === '.')) {
    throw new ZipError(`ZIP 条目包含非法路径：${raw}`);
  }
  if (/^[a-zA-Z]:/.test(path)) {
    throw new ZipError(`ZIP 条目不能是绝对路径：${raw}`);
  }
  return path;
}

export function createZip(
  entries: ReadonlyArray<ZipWriteEntry>,
  now: Date = new Date(),
): Uint8Array {
  if (entries.length === 0) {
    throw new ZipError('ZIP 至少需要一个条目');
  }
  if (entries.length > MAX_ENTRIES) {
    throw new ZipError('ZIP 条目过多');
  }

  const seen = new Set<string>();
  const prepared = entries.map((entry) => {
    const path = normalizeZipPath(entry.path);
    if (seen.has(path)) {
      throw new ZipError(`ZIP 条目重复：${path}`);
    }
    seen.add(path);
    const name = encoder.encode(path);
    const crc = crc32(entry.data);
    if (entry.data.byteLength > 0xffffffff) {
      throw new ZipError(`ZIP 条目过大，不支持 ZIP64：${path}`);
    }
    return { name, data: entry.data, crc };
  });

  const { time, date } = dosDateTime(now);
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of prepared) {
    const local = new Uint8Array(30 + entry.name.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_SIGNATURE, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, entry.crc, true);
    localView.setUint32(18, entry.data.byteLength, true);
    localView.setUint32(22, entry.data.byteLength, true);
    localView.setUint16(26, entry.name.byteLength, true);
    localView.setUint16(28, 0, true);
    local.set(entry.name, 30);
    localParts.push(local, entry.data);

    const central = new Uint8Array(46 + entry.name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_SIGNATURE, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, entry.crc, true);
    centralView.setUint32(20, entry.data.byteLength, true);
    centralView.setUint32(24, entry.data.byteLength, true);
    centralView.setUint16(28, entry.name.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(entry.name, 46);
    centralParts.push(central);

    offset += local.byteLength + entry.data.byteLength;
    if (offset > 0xffffffff) {
      throw new ZipError('ZIP 过大，不支持 ZIP64');
    }
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const part of centralParts) {
    centralSize += part.byteLength;
  }
  if (centralSize > 0xffffffff) {
    throw new ZipError('ZIP 中央目录过大');
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, EOCD_SIGNATURE, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, prepared.length, true);
  endView.setUint16(10, prepared.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);

  const total =
    localParts.reduce((sum, part) => sum + part.byteLength, 0) +
    centralSize +
    end.byteLength;
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    output.set(part, cursor);
    cursor += part.byteLength;
  }
  return output;
}

function findEocd(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.byteLength - 65_557 - 22);
  for (let index = bytes.byteLength - 22; index >= min; index -= 1) {
    if (
      bytes[index] === 0x50 &&
      bytes[index + 1] === 0x4b &&
      bytes[index + 2] === 0x05 &&
      bytes[index + 3] === 0x06
    ) {
      return index;
    }
  }
  return -1;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DecompressionCtor = (
    globalThis as typeof globalThis & {
      DecompressionStream?: new (format: string) => DecompressionStream;
    }
  ).DecompressionStream;
  if (!DecompressionCtor) {
    throw new ZipError('当前环境不支持 DEFLATE 解压');
  }
  const stream = new Blob([data.slice().buffer]).stream().pipeThrough(
    new DecompressionCtor('deflate-raw'),
  );
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export async function readZip(bytes: Uint8Array): Promise<ZipReadEntry[]> {
  if (bytes.byteLength < 22) {
    throw new ZipError('文件不是有效的 ZIP');
  }
  const eocd = findEocd(bytes);
  if (eocd < 0) {
    throw new ZipError('ZIP 缺少中央目录结尾记录');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  if (disk !== 0 || centralDisk !== 0) {
    throw new ZipError('不支持分卷 ZIP');
  }
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError('不支持 ZIP64 备份');
  }
  if (entryCount > MAX_ENTRIES) {
    throw new ZipError('ZIP 条目过多');
  }
  if (centralOffset + centralSize > bytes.byteLength) {
    throw new ZipError('ZIP 中央目录越界');
  }

  const entries: ZipReadEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.byteLength) {
      throw new ZipError('ZIP 中央目录损坏');
    }
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError('ZIP 中央目录签名错误');
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) {
      throw new ZipError('ZIP 条目名称越界');
    }
    const rawName = decoder.decode(bytes.subarray(nameStart, nameEnd));
    cursor = nameEnd + extraLength + commentLength;

    if (flags & 0x0001) {
      throw new ZipError(`不支持加密 ZIP 条目：${rawName}`);
    }
    if (rawName.endsWith('/')) {
      continue;
    }
    const path = normalizeZipPath(rawName);
    if (seen.has(path)) {
      throw new ZipError(`ZIP 条目重复：${path}`);
    }
    seen.add(path);

    if (localOffset + 30 > bytes.byteLength) {
      throw new ZipError(`ZIP 条目越界：${path}`);
    }
    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new ZipError(`ZIP 本地头签名错误：${path}`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) {
      throw new ZipError(`ZIP 条目数据越界：${path}`);
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new ZipError(`ZIP 条目过大：${path}`);
    }
    totalBytes += uncompressedSize;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new ZipError('ZIP 解压后总大小超出限制');
    }

    const compressed = bytes.subarray(dataStart, dataEnd);
    let data: Uint8Array;
    if (method === 0) {
      data = compressed.slice();
    } else if (method === 8) {
      data = await inflateRaw(compressed);
    } else {
      throw new ZipError(`不支持的 ZIP 压缩方式 ${method}：${path}`);
    }
    if (data.byteLength !== uncompressedSize) {
      throw new ZipError(`ZIP 条目大小不匹配：${path}`);
    }
    const actual = crc32(data);
    if (actual !== crc) {
      throw new ZipError(`ZIP 条目 CRC 校验失败：${path}`);
    }
    entries.push({ path, data, crc32: crc, method });
  }

  if (entries.length === 0) {
    throw new ZipError('ZIP 中没有文件条目');
  }
  return entries;
}
