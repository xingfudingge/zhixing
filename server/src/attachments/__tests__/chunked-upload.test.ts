import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';

import type { DbPool } from '../../db/pool.ts';
import type { AttachmentRow, DeviceRow } from '../../db/rows.ts';
import type { StorageService } from '../../services/storage.ts';
import {
  AttachmentChunkService,
  type ChunkPart,
} from '../chunked-upload-service.ts';
import {
  completeStorageKey,
  partCountFor,
  partSizeFor,
  partStorageKey,
} from '../chunk-plan.ts';
import { registerAttachmentChunkRoutes } from '../routes.ts';

const CHUNK = 64 * 1024;
const SHA = 'a'.repeat(64);

class FakeStorage {
  readonly objects = new Map<string, { data: Uint8Array; mime: string }>();
  readonly configured = true;
  readonly config = { bucket: 'test' };
  readonly lastError: string | null = null;

  async putUrl(key: string, mime: string): Promise<string> {
    return `mem://put/${key}?mime=${encodeURIComponent(mime)}`;
  }

  async getUrl(key: string): Promise<string> {
    return `mem://get/${key}`;
  }

  async stat(key: string): Promise<{ size: number; contentType: string | null }> {
    const object = this.objects.get(key);
    if (!object) {
      const error = new Error('object missing');
      (error as Error & { code?: string }).code = 'ATTACHMENT_OBJECT_MISSING';
      throw error;
    }
    return { size: object.data.length, contentType: object.mime };
  }

  async verifyHash(key: string, expected: string): Promise<void> {
    const object = this.objects.get(key);
    if (!object) throw new Error('object missing');
    const actual = createHash('sha256').update(object.data).digest('hex');
    if (actual !== expected) {
      const error = new Error('hash mismatch');
      (error as Error & { code?: string }).code = 'ATTACHMENT_HASH_MISMATCH';
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  put(key: string, data: Uint8Array, mime = 'application/octet-stream'): string {
    this.objects.set(key, { data, mime });
    return createHash('sha256').update(data).digest('hex');
  }
}

class FakePool {
  row: AttachmentRow;
  readonly queries: { sql: string; params: unknown[] }[] = [];

  constructor(row: AttachmentRow) {
    this.row = row;
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: AttachmentRow[] }> {
    this.queries.push({ sql, params });
    if (/SELECT \* FROM attachments/i.test(sql)) {
      return { rows: [this.row] };
    }
    if (/UPDATE attachments/i.test(sql)) {
      this.row = {
        ...this.row,
        status: 'available',
        updated_at: new Date('2026-10-26T10:05:00.000Z'),
      };
      return { rows: [this.row] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

function row(byteSize: number, overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 'att_server_1',
    space_id: 'personal',
    note_id: 'note-1',
    block_id: 'block-1',
    file_name: '方案.zip',
    sha256: SHA,
    byte_size: String(byteSize),
    mime: 'application/zip',
    storage_key: `spaces/personal/assets/${SHA}`,
    status: 'pending',
    created_by_device_id: 'dev_1',
    created_at: new Date('2026-10-26T10:00:00.000Z'),
    updated_at: new Date('2026-10-26T10:00:00.000Z'),
    deleted_at: null,
    ...overrides,
  };
}

const DEVICE: DeviceRow = {
  id: 'dev_1',
  name: '测试设备',
  platform: 'macos',
  token_hash: 'x',
  refresh_token_hash: 'y',
  access_expires_at: new Date(Date.now() + 1000_000),
  refresh_expires_at: new Date(Date.now() + 1000_000),
  features: {},
  pairing_code_id: null,
  paired_at: new Date(),
  last_seen_at: null,
  revoked_at: null,
  created_at: new Date(),
};

function bytes(total: number, offset = 0): Uint8Array {
  const data = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) {
    data[index] = (index * 13 + offset) % 256;
  }
  return data;
}

function fetchFor(storage: FakeStorage) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.startsWith('mem://get/')) {
      const key = decodeURIComponent(url.slice('mem://get/'.length).split('?')[0]!);
      const object = storage.objects.get(key);
      if (!object) return new Response('missing', { status: 404 });
      return new Response(object.data as unknown as BodyInit, { status: 200 });
    }
    if (url.startsWith('mem://put/')) {
      const key = decodeURIComponent(url.slice('mem://put/'.length).split('?')[0]!);
      const body = init?.body;
      let data: Uint8Array;
      if (body instanceof Uint8Array) {
        data = body;
      } else if (body instanceof ArrayBuffer) {
        data = new Uint8Array(body);
      } else if (body instanceof Blob) {
        data = new Uint8Array(await body.arrayBuffer());
      } else {
        data = new Uint8Array(0);
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      storage.objects.set(key, {
        data,
        mime: headers['content-type'] ?? 'application/octet-stream',
      });
      return new Response('', { status: 200 });
    }
    return new Response('unsupported', { status: 400 });
  };
}

function setup(byteSize = 200_000) {
  const storage = new FakeStorage();
  const pool = new FakePool(row(byteSize));
  const service = new AttachmentChunkService(
    pool as unknown as DbPool,
    storage as unknown as StorageService,
    { fetchImpl: fetchFor(storage), assemble: false },
  );
  const chunkSize = CHUNK;
  const count = partCountFor(byteSize, chunkSize);
  const parts: ChunkPart[] = [];
  for (let index = 0; index < count; index += 1) {
    const data = bytes(partSizeFor(byteSize, index, chunkSize), index * 7);
    const sha256 = storage.put(
      partStorageKey(SHA, index, 'personal'),
      data,
    );
    parts.push({ index, size: data.length, sha256 });
  }
  const manifest = new TextEncoder().encode(
    JSON.stringify({ version: 1, parts, chunkSize }),
  );
  const completeSha = storage.put(
    completeStorageKey(SHA, 'personal'),
    manifest,
    'application/json',
  );
  return { storage, pool, service, chunkSize, count, parts, completeSha };
}

test('upload-session 根据已存在分片返回缺失部分，可续传', async () => {
  const fixture = setup();
  for (let index = 0; index < fixture.count; index += 1) {
    fixture.storage.objects.delete(partStorageKey(SHA, index, 'personal'));
  }
  const first = await fixture.service.createSession(
    DEVICE,
    'att_server_1',
    fixture.chunkSize,
  );
  assert.equal(first.chunkSize, CHUNK);
  assert.equal(first.partCount, fixture.count);
  assert.equal(first.missingParts.length, fixture.count);
  assert.equal(first.presentPartIndexes.length, 0);
  assert.match(first.missingParts[0]!.url, /mem:\/\/put\//);
  assert.match(first.completeUrl, /complete\.json/);
  assert.equal(first.alreadyAvailable, false);

  // 模拟只上传了 0、3 两片后断网；会话只补 1、2。
  fixture.storage.put(
    partStorageKey(SHA, 0, 'personal'),
    bytes(partSizeFor(200_000, 0, CHUNK)),
  );
  fixture.storage.put(
    partStorageKey(SHA, 3, 'personal'),
    bytes(partSizeFor(200_000, 3, CHUNK)),
  );
  const resumed = await fixture.service.createSession(
    DEVICE,
    'att_server_1',
    fixture.chunkSize,
  );
  assert.deepEqual(resumed.presentPartIndexes.sort(), [0, 3].sort());
  assert.deepEqual(
    resumed.missingParts.map((part) => part.index),
    [1, 2],
  );
});

test('upload-complete 逐片校验后置 available；坏分片拒绝', async () => {
  const { service, pool, parts, completeSha, chunkSize, count } = setup();
  const result = await service.complete(DEVICE, 'att_server_1', {
    chunkSize,
    partCount: count,
    completeSha256: completeSha,
    parts,
  });
  assert.equal(result.verified, true);
  assert.equal(result.attachment.status, 'available');
  assert.equal(pool.row.status, 'available');

  const bad = setup();
  const broken = [...bad.parts];
  broken[1] = { ...broken[1]!, sha256: 'b'.repeat(64) };
  await assert.rejects(
    bad.service.complete(DEVICE, 'att_server_1', {
      chunkSize,
      partCount: count,
      completeSha256: bad.completeSha,
      parts: broken,
    }),
    /hash mismatch/,
  );
  assert.equal(bad.pool.row.status, 'pending');
});

test('缺少分片或 complete.json 时 complete 失败', async () => {
  const missingPart = setup();
  missingPart.storage.objects.delete(partStorageKey(SHA, 2, 'personal'));
  await assert.rejects(
    missingPart.service.complete(DEVICE, 'att_server_1', {
      chunkSize: missingPart.chunkSize,
      partCount: missingPart.count,
      completeSha256: missingPart.completeSha,
      parts: missingPart.parts,
    }),
    /object missing/,
  );

  const missingManifest = setup();
  missingManifest.storage.objects.delete(completeStorageKey(SHA, 'personal'));
  await assert.rejects(
    missingManifest.service.complete(DEVICE, 'att_server_1', {
      chunkSize: missingManifest.chunkSize,
      partCount: missingManifest.count,
      completeSha256: missingManifest.completeSha,
      parts: missingManifest.parts,
    }),
    /object missing/,
  );
});

test('download-manifest 返回分片预签名 GET；缺片时拒绝', async () => {
  const ready = setup();
  ready.pool.row = { ...ready.pool.row, status: 'available' };
  const manifest = await ready.service.downloadManifest(
    DEVICE,
    'att_server_1',
    CHUNK,
  );
  assert.equal(manifest.partCount, ready.count);
  assert.equal(manifest.parts.length, ready.count);
  assert.match(manifest.parts[0]!.url, /mem:\/\/get\//);
  assert.equal(manifest.attachment.sha256, SHA);

  ready.storage.objects.delete(partStorageKey(SHA, 1, 'personal'));
  await assert.rejects(
    ready.service.downloadManifest(DEVICE, 'att_server_1', CHUNK),
    /分片不完整/,
  );
});

test('兼容旧版整文件对象：没有分片时退回 storage_key 单对象', async () => {
  const legacy = setup(4096);
  for (let index = 0; index < legacy.count; index += 1) {
    legacy.storage.objects.delete(partStorageKey(SHA, index, 'personal'));
  }
  const whole = bytes(4096, 99);
  const wholeSha = legacy.storage.put(
    `spaces/personal/assets/${SHA}`,
    whole,
  );
  void wholeSha;
  legacy.pool.row = { ...legacy.pool.row, status: 'available' };
  const manifest = await legacy.service.downloadManifest(
    DEVICE,
    'att_server_1',
    CHUNK,
  );
  assert.equal(manifest.partCount, 1);
  assert.equal(manifest.parts[0]?.size, 4096);
  assert.match(manifest.parts[0]!.url, /assets\/a{64}/);
});

test('complete 会组装整对象并清理分片，旧 /download 仍可用', async () => {
  const byteSize = 130_000;
  const fileBytes = bytes(byteSize, 3);
  const fileSha = createHash('sha256').update(fileBytes).digest('hex');
  const storage = new FakeStorage();
  const pool = new FakePool(
    row(byteSize, {
      sha256: fileSha,
      storage_key: `spaces/personal/assets/${fileSha}`,
    }),
  );
  const service = new AttachmentChunkService(
    pool as unknown as DbPool,
    storage as unknown as StorageService,
    { fetchImpl: fetchFor(storage) },
  );
  const chunkSize = CHUNK;
  const count = partCountFor(byteSize, chunkSize);
  const parts: ChunkPart[] = [];
  for (let index = 0; index < count; index += 1) {
    const size = partSizeFor(byteSize, index, chunkSize);
    const data = fileBytes.slice(index * chunkSize, index * chunkSize + size);
    const sha256 = storage.put(partStorageKey(fileSha, index, 'personal'), data);
    parts.push({ index, size: data.length, sha256 });
  }
  const manifest = new TextEncoder().encode(
    JSON.stringify({ version: 1, parts, chunkSize }),
  );
  const completeSha = storage.put(
    completeStorageKey(fileSha, 'personal'),
    manifest,
    'application/json',
  );

  await service.complete(DEVICE, 'att_server_1', {
    chunkSize,
    partCount: count,
    completeSha256: completeSha,
    parts,
  });

  const whole = storage.objects.get(`spaces/personal/assets/${fileSha}`);
  assert.ok(whole);
  assert.equal(
    createHash('sha256').update(whole.data).digest('hex'),
    fileSha,
  );
  for (let index = 0; index < count; index += 1) {
    assert.equal(
      storage.objects.has(partStorageKey(fileSha, index, 'personal')),
      false,
    );
  }
  const manifestResult = await service.downloadManifest(
    DEVICE,
    'att_server_1',
    chunkSize,
  );
  assert.equal(manifestResult.partCount, 1);
  assert.equal(manifestResult.parts[0]?.size, byteSize);
});

test('路由：upload-session / upload-complete / download-manifest', async () => {
  const { storage, pool, parts, completeSha, chunkSize, count } = setup();
  const app = Fastify({ logger: false });
  app.decorate('zx', {
    pool,
    storage,
  } as unknown as FastifyInstance['zx']);
  app.addHook('onRequest', async (request) => {
    request.device = DEVICE;
  });
  app.register(
    async (api) => {
      registerAttachmentChunkRoutes(api, {
        fetchImpl: fetchFor(storage),
        assemble: false,
      });
    },
    { prefix: '/api/v1' },
  );
  await app.ready();

  const session = await app.inject({
    method: 'POST',
    url: '/api/v1/attachments/att_server_1/upload-session',
    payload: { chunkSize },
  });
  assert.equal(session.statusCode, 200);
  const sessionBody = session.json();
  assert.equal(sessionBody.ok, true);
  assert.equal(sessionBody.partCount, count);
  assert.equal(sessionBody.presentPartIndexes.length, count);
  assert.equal(sessionBody.missingParts.length, 0);

  const complete = await app.inject({
    method: 'POST',
    url: '/api/v1/attachments/att_server_1/upload-complete',
    payload: {
      chunkSize,
      partCount: count,
      completeSha256: completeSha,
      parts,
    },
  });
  assert.equal(complete.statusCode, 200);
  assert.equal(complete.json().attachment.status, 'available');

  const manifest = await app.inject({
    method: 'GET',
    url: `/api/v1/attachments/att_server_1/download-manifest?chunkSize=${chunkSize}`,
  });
  assert.equal(manifest.statusCode, 200);
  assert.equal(manifest.json().parts.length, count);

  const badChunk = await app.inject({
    method: 'GET',
    url: '/api/v1/attachments/att_server_1/download-manifest?chunkSize=nope',
  });
  assert.equal(badChunk.statusCode, 400);

  await app.close();
});
