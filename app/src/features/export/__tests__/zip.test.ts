import { describe, expect, it } from 'vitest';

import { crc32, createZip, readZip, ZipError } from '../zip';

const encoder = new TextEncoder();

describe('ZIP 读写', () => {
  it('写入并读取 UTF-8 路径、文本与二进制，CRC 一致', async () => {
    const binary = new Uint8Array([0, 1, 2, 250, 255, 10]);
    const zip = createZip(
      [
        { path: 'manifest.json', data: encoder.encode('{"app":"zhixing"}') },
        { path: 'boards/画板-1.json', data: encoder.encode('{"nodes":[]}') },
        { path: 'attachments/a.bin', data: binary },
      ],
      new Date('2026-10-26T12:00:00.000Z'),
    );

    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    const entries = await readZip(zip);
    expect(entries.map((entry) => entry.path)).toEqual([
      'manifest.json',
      'boards/画板-1.json',
      'attachments/a.bin',
    ]);
    expect(new TextDecoder().decode(entries[0]!.data)).toContain('zhixing');
    expect(Array.from(entries[2]!.data)).toEqual(Array.from(binary));
    expect(entries[2]!.crc32).toBe(crc32(binary));
  });

  it('拒绝路径穿越、绝对路径与重复条目', () => {
    expect(() =>
      createZip([{ path: '../escape.txt', data: new Uint8Array([1]) }]),
    ).toThrow(ZipError);
    expect(() =>
      createZip([{ path: '/etc/passwd', data: new Uint8Array([1]) }]),
    ).toThrow(ZipError);
    expect(() =>
      createZip([
        { path: 'a.txt', data: new Uint8Array([1]) },
        { path: 'a.txt', data: new Uint8Array([2]) },
      ]),
    ).toThrow(ZipError);
  });

  it('读取时发现 CRC 损坏并拒绝', async () => {
    const zip = createZip([
      { path: 'data.txt', data: encoder.encode('hello zhixing') },
    ]);
    const corrupted = zip.slice();
    // 本地头 30 字节 + 文件名 10 字节后是数据区。
    corrupted[30 + 'data.txt'.length] = 0x00;
    await expect(readZip(corrupted)).rejects.toThrow(/CRC/);
  });

  it('空 ZIP 与缺少中央目录的文件被拒绝', async () => {
    await expect(readZip(new Uint8Array(10))).rejects.toThrow(/有效/);
    await expect(readZip(new Uint8Array(22))).rejects.toThrow(/中央目录/);
  });
});
