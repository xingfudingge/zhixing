import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  Sha256,
  isSha256Hex,
  sha256Blob,
  sha256Bytes,
  sha256Parts,
} from '../sha256';

function nodeHash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('SHA-256 增量实现', () => {
  it('匹配 FIPS/NIST 标准向量', () => {
    expect(sha256Bytes(new TextEncoder().encode(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Bytes(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      sha256Bytes(
        new TextEncoder().encode(
          'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
        ),
      ),
    ).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('分块 update 与一次性结果一致', () => {
    const payload = new Uint8Array(200_000);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (index * 31 + 7) % 256;
    }
    const hash = new Sha256();
    for (let offset = 0; offset < payload.length; offset += 777) {
      hash.update(payload.subarray(offset, Math.min(offset + 777, payload.length)));
    }
    expect(hash.hex()).toBe(nodeHash(payload));
  });

  it('sha256Blob 按流读取并报告进度', async () => {
    const bytes = new Uint8Array(2_500_000);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251;
    }
    const blob = new Blob([bytes]);
    const progress: number[] = [];
    const hash = await sha256Blob(blob, (hashed, total) => {
      progress.push(hashed);
      expect(total).toBe(bytes.length);
    });
    expect(hash).toBe(nodeHash(bytes));
    expect(progress.at(-1)).toBe(bytes.length);
  });

  it('sha256Parts 等于拼接后的哈希', async () => {
    const a = new Blob(['hello ']);
    const b = new Blob(['知行']);
    expect(await sha256Parts([a, b])).toBe(
      nodeHash(new TextEncoder().encode('hello 知行')),
    );
  });

  it('isSha256Hex 只接受 64 位小写十六进制', () => {
    expect(isSha256Hex('0'.repeat(64))).toBe(true);
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('abc')).toBe(false);
  });
});
