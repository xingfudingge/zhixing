/**
 * 真实 / mock WebDAV 验收脚本。
 *
 * 真实 OpenList/Alist：
 *   WEBDAV_URL=http://127.0.0.1:5244/dav \
 *   WEBDAV_USERNAME=admin WEBDAV_PASSWORD=应用密码 \
 *   npx tsx test/webdav/live-check.ts
 *
 * 无外部服务时：
 *   npx tsx test/webdav/live-check.ts --mock
 *
 * 脚本会实际执行：连接探测（PROPFIND/MKCOL/PUT/GET/DELETE/分片）→
 * 追加一个 op → 从目录清单读回 → 写快照并校验 → 删除本次产生的文件。
 */

import type { SyncOp } from '../../../packages/shared/src/index.ts';
import {
  createRandomId,
  WebDavClient,
  sha256Hex,
} from '../../../packages/sync-webdav/src/index.ts';
import { MockWebDavServer } from './mock-webdav-server.ts';

const useMock = process.argv.includes('--mock');

async function main(): Promise<void> {
  let mock: MockWebDavServer | null = null;
  let baseUrl = process.env.WEBDAV_URL ?? '';
  let username = process.env.WEBDAV_USERNAME ?? '';
  let password = process.env.WEBDAV_PASSWORD ?? '';

  if (useMock) {
    mock = new MockWebDavServer({
      username: 'alice',
      password: 'app-password',
    });
    baseUrl = await mock.start();
    username = 'alice';
    password = 'app-password';
  }

  if (!baseUrl) {
    console.error(
      '缺少 WEBDAV_URL。示例：WEBDAV_URL=http://127.0.0.1:5244/dav WEBDAV_USERNAME=admin WEBDAV_PASSWORD=... npx tsx test/webdav/live-check.ts',
    );
    process.exitCode = 2;
    return;
  }

  const deviceId = createRandomId('live').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const spaceId = process.env.WEBDAV_SPACE ?? 'verify';
  const root = process.env.WEBDAV_ROOT ?? '/zhixing-verify';
  const client = new WebDavClient({
    baseUrl,
    username,
    password,
    root,
    spaceId,
    deviceId,
    chunkSize: 4 * 1024,
    timeoutMs: 20_000,
    retry: { maxAttempts: 3, baseDelayMs: 200 },
    platform: 'macos',
  });

  try {
    const connection = await client.testConnection();
    console.log('连接探测:', JSON.stringify(connection, null, 2));
    if (!connection.ok) {
      process.exitCode = 1;
      return;
    }

    const now = Date.now();
    const op: SyncOp = {
      op_id: createRandomId('op').replace(/[^A-Za-z0-9_-]/g, ''),
      space_id: spaceId,
      device_id: deviceId,
      entity_type: 'task',
      entity_id: `acceptance-${now}`,
      op_type: 'upsert',
      hlc: { ms: now, c: 0, d: deviceId },
      base_vv: {},
      payload: { title: 'WebDAV 验收任务', created_by: 'live-check' },
      created_at: new Date(now).toISOString(),
    };

    const appended = await client.appendOps([op]);
    const readBack = await client.readOps(deviceId, 0);
    const found = readBack.ops.some((item) => item.op.op_id === op.op_id);
    console.log(
      '上传/目录回读:',
      JSON.stringify(
        {
          file: appended.results[0]?.path,
          seq: appended.results[0]?.seq,
          readOps: readBack.ops.length,
          found,
        },
        null,
        2,
      ),
    );
    if (!found) throw new Error('目录清单读回缺失刚上传的 op');

    const snapshot = await client.writeSnapshot({
      entities: [],
      cursors: { [deviceId]: appended.maxSeq },
      coveredSeq: appended.maxSeq,
    });
    const best = await client.readBestSnapshot();
    const snapshotOk = best?.ref.name === snapshot.ref.name;
    console.log(
      '快照:',
      JSON.stringify(
        {
          name: snapshot.ref.name,
          sha256: snapshot.sha256,
          readBack: best?.ref.name ?? null,
          snapshotOk,
        },
        null,
        2,
      ),
    );
    if (!snapshotOk) throw new Error('快照回读/校验失败');

    // 清理本次验收生成的文件，不触碰目录中的其他内容。
    for (const item of appended.results) {
      await client.deletePath(item.path);
    }
    await client.deletePath(snapshot.ref.path);
    await client.deletePath(snapshot.ref.sha256Path);
    console.log(
      '清理完成:',
      JSON.stringify({
        deviceId,
        root,
        spaceId,
        baseUrl,
        sha256: sha256Hex(JSON.stringify(op)),
      }),
    );
  } finally {
    await mock?.stop();
  }
}

main().catch((error) => {
  console.error('WebDAV 验收失败:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
