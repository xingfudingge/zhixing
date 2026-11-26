/**
 * 真实环境验收：PostgreSQL 16 + MinIO/S3 + Fastify 注入。
 *
 * 运行：
 *   DATABASE_URL=postgres://user@127.0.0.1:55432/zx_p203 \
 *   ZX_S3_ENDPOINT=http://127.0.0.1:19000 \
 *   ZX_S3_PUBLIC_ENDPOINT=http://127.0.0.1:19000 \
 *   node --import tsx src/attachments/acceptance.ts
 *
 * 脚本会创建独立的临时数据库，验证：
 * 1. 分片上传中断后重新申请会话只返回缺失分片；
 * 2. complete 逐片 SHA-256 校验后组装整对象；
 * 3. 第二台设备下载并校验整体哈希一致；
 * 4. 旧 `/attachments/:id/download` 也能拿到同一内容。
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import pg from 'pg';

import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { runMigrations } from '../db/migrate.ts';
import { StorageService } from '../services/storage.ts';
import {
  completeStorageKey,
  partCountFor,
  partSizeFor,
  partStorageKey,
} from './chunk-plan.ts';
import { registerAttachmentChunkRoutes } from './routes.ts';

const { Pool } = pg;

function hash(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function databaseName(): string {
  return `zx_p203_${Date.now().toString(36)}`;
}

async function createDatabase(baseUrl: string, name: string): Promise<pg.Pool> {
  const url = new URL(baseUrl);
  const adminDatabase = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = new Pool({
    connectionString: url.toString(),
    max: 1,
  });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  await runMigrations(pool);
  void adminDatabase;
  return pool;
}

async function main(): Promise<void> {
  const baseUrl =
    process.env.ZX_ACCEPTANCE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    process.env.ZX_TEST_DATABASE_URL ??
    'postgres://example@127.0.0.1:55432/postgres';
  const name = databaseName();
  const pool = await createDatabase(baseUrl, name);
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: `${baseUrl.replace(/\/[^/]*$/, '')}/${name}`,
    ZX_SETUP_TOKEN: 'p203-acceptance-token',
    ZX_SETUP_ALLOW_REMOTE: 'true',
    ZX_LOG_LEVEL: 'silent',
    ZX_S3_ENDPOINT:
      process.env.ZX_S3_ENDPOINT ?? 'http://127.0.0.1:19000',
    ZX_S3_PUBLIC_ENDPOINT:
      process.env.ZX_S3_PUBLIC_ENDPOINT ?? 'http://127.0.0.1:19000',
    ZX_S3_BUCKET: process.env.ZX_S3_BUCKET ?? 'zhixing',
    ZX_S3_ACCESS_KEY: process.env.ZX_S3_ACCESS_KEY ?? 'minioadmin',
    ZX_S3_SECRET_KEY: process.env.ZX_S3_SECRET_KEY ?? 'minioadmin',
    ZX_S3_AUTO_CREATE_BUCKET: 'true',
  });
  const storage = new StorageService(config.storage);
  await storage.ensureBucket();
  const app = await buildApp({ config, pool, storage });
  await app.register(
    async (api) => {
      registerAttachmentChunkRoutes(api);
    },
    { prefix: '/api/v1' },
  );
  await app.ready();

  const cleanup = async () => {
    await app.close();
    await pool.end();
    const url = new URL(baseUrl);
    url.pathname = '/postgres';
    const admin = new Pool({ connectionString: url.toString(), max: 1 });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    } finally {
      await admin.end();
    }
  };

  try {
    await pool.query(`
      TRUNCATE TABLE
        conflicts, sync_ops, sync_entities, device_sync_state,
        attachments, devices, pairing_codes, admin_sessions
      RESTART IDENTITY CASCADE
    `);
    await pool.query(
      `UPDATE deployment SET passphrase_hash = NULL, passphrase_salt = NULL,
              passphrase_scheme = NULL, initialized_at = NULL WHERE id = 'default'`,
    );

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: {
        setupToken: 'p203-acceptance-token',
        passphrase: 'acceptance-pass-123',
      },
      remoteAddress: '127.0.0.1',
    });
    assert.equal(setup.statusCode, 200, setup.body);
    const adminToken = (setup.json() as { adminToken: string }).adminToken;

    async function pair(name: string) {
      const codeResponse = await app.inject({
        method: 'POST',
        url: '/api/v1/devices/pair-code',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { label: name },
      });
      assert.equal(codeResponse.statusCode, 200, codeResponse.body);
      const code = (codeResponse.json() as { code: string }).code;
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/devices/pair',
        payload: { code, name, platform: 'macos' },
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json() as { deviceId: string; deviceToken: string };
      return {
        id: body.deviceId,
        headers: {
          'x-zx-device': body.deviceId,
          authorization: `Bearer ${body.deviceToken}`,
        } as Record<string, string>,
      };
    }

    const deviceA = await pair('设备 A');
    const deviceB = await pair('设备 B');

    const chunkSize = 64 * 1024;
    const file = randomBytes(200_000);
    const fileSha = hash(file);
    const partCount = partCountFor(file.length, chunkSize);
    const parts: { index: number; size: number; sha256: string }[] = [];
    for (let index = 0; index < partCount; index += 1) {
      const size = partSizeFor(file.length, index, chunkSize);
      const data = file.subarray(index * chunkSize, index * chunkSize + size);
      parts.push({ index, size, sha256: hash(data) });
    }

    const init = await app.inject({
      method: 'POST',
      url: '/api/v1/attachments/init',
      headers: deviceA.headers,
      payload: {
        fileName: '验收.docx',
        sha256: fileSha,
        byteSize: file.length,
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        noteId: 'note-acceptance',
      },
    });
    assert.equal(init.statusCode, 200, init.body);
    const attachmentId = (init.json() as { attachment: { id: string } })
      .attachment.id;

    const session1 = await app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${attachmentId}/upload-session`,
      headers: deviceA.headers,
      payload: { chunkSize },
    });
    assert.equal(session1.statusCode, 200, session1.body);
    const first = session1.json() as {
      missingParts: { index: number; size: number; url: string }[];
      partCount: number;
    };
    assert.equal(first.partCount, partCount);
    assert.equal(first.missingParts.length, partCount);

    async function putPart(part: { index: number; url: string; size: number }) {
      const data = file.subarray(
        part.index * chunkSize,
        part.index * chunkSize + part.size,
      );
      const response = await fetch(part.url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: data,
      });
      assert.equal(response.ok, true, `分片 ${part.index} PUT 失败`);
    }

    // 模拟上传两片后断网。
    for (const part of first.missingParts.slice(0, 2)) {
      await putPart(part);
    }
    const session2 = await app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${attachmentId}/upload-session`,
      headers: deviceA.headers,
      payload: { chunkSize },
    });
    assert.equal(session2.statusCode, 200, session2.body);
    const resumed = session2.json() as {
      missingParts: { index: number; size: number; url: string }[];
      presentPartIndexes: number[];
      completeUrl: string;
    };
    assert.deepEqual(resumed.presentPartIndexes.sort((a, b) => a - b), [0, 1]);
    assert.equal(resumed.missingParts.length, partCount - 2);
    for (const part of resumed.missingParts) {
      await putPart(part);
    }

    const completeManifest = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        sha256: fileSha,
        byteSize: file.length,
        chunkSize,
        partCount,
        parts,
      }),
    );
    const completeSha = hash(completeManifest);
    const putComplete = await fetch(resumed.completeUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: completeManifest,
    });
    assert.equal(putComplete.ok, true, 'complete.json PUT 失败');

    const complete = await app.inject({
      method: 'POST',
      url: `/api/v1/attachments/${attachmentId}/upload-complete`,
      headers: deviceA.headers,
      payload: {
        chunkSize,
        partCount,
        completeSha256: completeSha,
        parts,
      },
    });
    assert.equal(complete.statusCode, 200, complete.body);
    assert.equal(
      (complete.json() as { attachment: { status: string } }).attachment.status,
      'available',
    );

    // 确认分片已清理、整对象已组装（旧 /download 接口可用）。
    const partStillThere = await storage.stat(
      partStorageKey(fileSha, 0, 'personal'),
    ).then(
      () => true,
      () => false,
    );
    assert.equal(partStillThere, false, '组装后分片应被清理');
    const wholeStat = await storage.stat(`spaces/personal/assets/${fileSha}`);
    assert.equal(wholeStat.size, file.length);

    const manifest = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${attachmentId}/download-manifest?chunkSize=${chunkSize}`,
      headers: deviceB.headers,
    });
    assert.equal(manifest.statusCode, 200, manifest.body);
    const manifestBody = manifest.json() as {
      parts: { index: number; size: number; url: string }[];
      attachment: { sha256: string };
    };
    assert.equal(manifestBody.attachment.sha256, fileSha);
    assert.equal(manifestBody.parts.length, 1);
    const downloaded = Buffer.concat(
      await Promise.all(
        manifestBody.parts.map(async (part) => {
          const response = await fetch(part.url);
          assert.equal(response.ok, true);
          return Buffer.from(await response.arrayBuffer());
        }),
      ),
    );
    assert.equal(hash(downloaded), fileSha, '另一设备下载哈希不一致');
    assert.equal(downloaded.length, file.length);

    const legacyDownload = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${attachmentId}/download`,
      headers: deviceB.headers,
    });
    assert.equal(legacyDownload.statusCode, 200, legacyDownload.body);
    const legacyUrl = (
      legacyDownload.json() as { downloadUrl: string }
    ).downloadUrl;
    const legacyResponse = await fetch(legacyUrl);
    assert.equal(legacyResponse.ok, true);
    const legacyBytes = Buffer.from(await legacyResponse.arrayBuffer());
    assert.equal(hash(legacyBytes), fileSha, '旧下载接口哈希不一致');

    // 清理对象存储，避免留下验收文件。
    await storage.delete(`spaces/personal/assets/${fileSha}`).catch(() => undefined);
    await storage.delete(completeStorageKey(fileSha, 'personal')).catch(() => undefined);

    console.log('P2-03 附件验收通过：');
    console.log(`- 文件 ${file.length} bytes / ${partCount} 片 / SHA-256 ${fileSha}`);
    console.log('- 断点续传：第二次会话只补缺失分片');
    console.log('- 服务端逐片校验并组装整对象');
    console.log('- 设备 B 下载与旧 /download 均哈希一致');
  } finally {
    await cleanup();
  }
}

await main();
