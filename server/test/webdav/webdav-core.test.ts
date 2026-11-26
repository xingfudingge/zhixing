import { afterEach, describe, expect, it } from 'vitest';

import type { SyncOp } from '../../../packages/shared/src/index.ts';
import {
  WebDavClient,
  WebDavError,
  createSpaceLayout,
  parseOpFileName,
  sha256Hex,
  type RetryInfo,
  type WebDavClientOptions,
} from '../../../packages/sync-webdav/src/index.ts';
import { MockWebDavServer, type MockWebDavOptions } from './mock-webdav-server.ts';

const openServers: MockWebDavServer[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()?.stop();
  }
});

async function startServer(
  options: MockWebDavOptions = {},
): Promise<MockWebDavServer> {
  const server = new MockWebDavServer({
    username: 'alice',
    password: 'app-password',
    ...options,
  });
  await server.start();
  openServers.push(server);
  return server;
}

function makeClient(
  server: MockWebDavServer,
  overrides: Partial<WebDavClientOptions> = {},
): WebDavClient {
  return new WebDavClient({
    baseUrl: server.baseUrl,
    username: 'alice',
    password: 'app-password',
    root: '/zhixing',
    spaceId: 'personal',
    deviceId: 'device-a',
    chunkSize: 512,
    timeoutMs: 5_000,
    retry: { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
    ...overrides,
  });
}

function dav(path: string): string {
  return `/dav${path}`;
}

function makeOp(deviceId: string, sequence: number, title = `任务 ${sequence}`): SyncOp {
  const ms = 1_700_000_000_000 + sequence;
  return {
    op_id: `op_${deviceId}_${String(sequence).padStart(4, '0')}_abcdefgh`,
    space_id: 'personal',
    device_id: deviceId,
    entity_type: 'task',
    entity_id: `task-${sequence}`,
    op_type: 'upsert',
    hlc: { ms, c: 0, d: deviceId },
    base_vv: {},
    payload: { title },
    created_at: new Date(ms).toISOString(),
  };
}

describe('SHA-256 / 路径基础', () => {
  it('SHA-256 与标准向量一致', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('知行 WebDAV')).toHaveLength(64);
  });

  it('op 文件名必须能从目录清单推出 seq 与 op_id', () => {
    expect(parseOpFileName('000000000042-op_abc_defgh123.ndjson')).toEqual({
      seq: 42,
      opId: 'op_abc_defgh123',
    });
    expect(parseOpFileName('42-op_abc_defgh123.ndjson')).toBeNull();
    expect(parseOpFileName('000000000042-abc.ndjson')).toBeNull();
  });

  it('拒绝非 loopback 的 HTTP 与 Web 平台', async () => {
    expect(
      () =>
        new WebDavClient({
          baseUrl: 'http://dav.example.com/dav',
          deviceId: 'device-a',
          platform: 'macos',
        }),
    ).toThrow(WebDavError);

    expect(
      () =>
        new WebDavClient({
          baseUrl: 'https://dav.example.com/dav',
          deviceId: 'device-a',
          platform: 'web',
        }),
    ).toThrow(/Web 端/);
  });
});

describe('连接探测与基础方法', () => {
  it('PROPFIND/MKCOL/PUT/GET/DELETE 全部通过，且不发送条件写/锁头', async () => {
    const server = await startServer();
    const client = makeClient(server);
    const result = await client.testConnection();

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.id)).toEqual([
      'propfind',
      'auth',
      'mkcol',
      'depth1',
      'put',
      'get',
      'delete',
      'chunked',
    ]);
    expect(result.checks.every((check) => check.status === 'ok')).toBe(true);

    const methods = server.requests.map((request) => request.method);
    expect(methods).not.toContain('LOCK');
    expect(methods).not.toContain('UNLOCK');
    expect(methods).not.toContain('MOVE');
    expect(methods).not.toContain('COPY');
    for (const request of server.requests) {
      expect(request.headers['if-match']).toBeUndefined();
      expect(request.headers['if-none-match']).toBeUndefined();
      expect(request.headers['lock-token']).toBeUndefined();
      expect(request.headers.if).toBeUndefined();
    }
  });

  it('认证失败返回可展示的错误而不是静默成功', async () => {
    const server = await startServer();
    const client = makeClient(server, { password: 'wrong' });
    const result = await client.testConnection();

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('AUTH_FAILED');
    expect(result.checks[0]?.status).toBe('failed');
  });

  it('PUT 已存在同内容时跳过；不同内容报 REMOTE_CONFLICT 且不覆盖', async () => {
    const server = await startServer();
    const client = makeClient(server);
    const path = '/zhixing/spaces/personal/ops/device-a/000000000001-op_aaaaaaaa.ndjson';
    const payload = new TextEncoder().encode('{"hello":"world"}\n');

    const first = await client.putImmutable(path, payload);
    expect(first.created).toBe(true);
    const second = await client.putImmutable(path, payload);
    expect(second.created).toBe(false);
    expect(second.existed).toBe(true);

    await expect(
      client.putImmutable(path, new TextEncoder().encode('{"hello":"changed"}\n')),
    ).rejects.toMatchObject({ code: 'REMOTE_CONFLICT' });
    expect(server.read(dav(path))?.toString()).toBe('{"hello":"world"}\n');
  });
});

describe('目录清单推导状态与追加写入', () => {
  it('两台设备各写 op，目录清单可推出设备与最大 seq', async () => {
    const server = await startServer();
    const clientA = makeClient(server, { deviceId: 'device-a' });
    const clientB = makeClient(server, { deviceId: 'device-b' });

    const opA1 = makeOp('device-a', 1);
    const opA2 = makeOp('device-a', 2);
    const opB1 = makeOp('device-b', 1, '另一台设备');

    const appendedA = await clientA.appendOps([opA1, opA2]);
    expect(appendedA.results.map((result) => result.seq)).toEqual([1, 2]);
    expect(appendedA.maxSeq).toBe(2);
    expect(appendedA.results[0].path).toMatch(
      /\/ops\/device-a\/000000000001-op_device-a_0001_abcdefgh\.ndjson$/,
    );

    const appendedB = await clientB.appendOps([opB1]);
    expect(appendedB.maxSeq).toBe(1);

    expect(await clientA.listDeviceDirectories()).toEqual([
      'device-a',
      'device-b',
    ]);

    const remote = await clientA.readRemoteState();
    expect(remote.maxSeqByDevice).toEqual({ 'device-a': 2, 'device-b': 1 });

    const readA = await clientA.readOps('device-a', 0);
    expect(readA.maxSeq).toBe(2);
    expect(readA.ops.map((item) => item.op.entity_id)).toEqual([
      'task-1',
      'task-2',
    ]);
    expect(readA.warnings).toEqual([]);

    const after = await clientA.readOps('device-a', 1);
    expect(after.ops.map((item) => item.op.entity_id)).toEqual(['task-2']);
  });

  it('重复 append 同一 op 跳过，不新增文件', async () => {
    const server = await startServer();
    const client = makeClient(server);
    const op = makeOp('device-a', 1);

    const first = await client.appendOps([op]);
    expect(first.results[0].created).toBe(true);
    const before = server.countFiles('/dav/zhixing/spaces/personal/ops/device-a');

    const second = await client.appendOps([op]);
    expect(second.results[0].skipped).toBe(true);
    const after = server.countFiles('/dav/zhixing/spaces/personal/ops/device-a');
    expect(after).toBe(before);
  });

  it('同 op_id 不同内容时拒绝覆盖远端文件', async () => {
    const server = await startServer();
    const client = makeClient(server);
    const op = makeOp('device-a', 1);
    await client.appendOps([op]);

    const conflict: SyncOp = { ...op, payload: { title: '被篡改' } };
    await expect(client.appendOps([conflict])).rejects.toMatchObject({
      code: 'REMOTE_CONFLICT',
    });
  });
});

describe('重试 / 断网 / 分片 / 快照', () => {
  it('响应丢失后重试：同一不可变文件只写一次', async () => {
    const server = await startServer();
    const retries: RetryInfo[] = [];
    const client = makeClient(server, {
      retry: {
        maxAttempts: 4,
        baseDelayMs: 1,
        sleep: async () => {},
        onRetry: (info) => retries.push(info),
      },
    });
    const op = makeOp('device-a', 1);
    server.failNext({ method: 'PUT', status: 502, afterWrite: true, times: 1 });

    const result = await client.appendOps([op]);
    expect(result.results).toHaveLength(1);
    expect(retries.length).toBeGreaterThanOrEqual(1);
    expect(
      server.countFiles('/dav/zhixing/spaces/personal/ops/device-a'),
    ).toBe(1);

    const remote = await client.readOps('device-a', 0);
    expect(remote.ops).toHaveLength(1);
    expect(remote.ops[0].op.op_id).toBe(op.op_id);
  });

  it('断网时失败可重试；恢复后只写一次', async () => {
    const server = await startServer();
    const client = makeClient(server);
    const op = makeOp('device-a', 1);

    server.setOffline(true);
    await expect(client.appendOps([op])).rejects.toMatchObject({
      code: 'NETWORK',
      retryable: true,
    });
    expect(
      server.countFiles('/dav/zhixing/spaces/personal/ops/device-a'),
    ).toBe(0);

    server.setOffline(false);
    const recovered = await client.appendOps([op]);
    expect(recovered.results[0].created).toBe(true);
    expect(
      server.countFiles('/dav/zhixing/spaces/personal/ops/device-a'),
    ).toBe(1);
  });

  it('大文件按分片写入，缺失/损坏时读取失败', async () => {
    const server = await startServer();
    const client = makeClient(server);
    const layout = createSpaceLayout('/zhixing', 'personal');
    const payload = new Uint8Array(2_500);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (index * 13 + 11) & 0xff;
    }

    const asset = await client.putAsset(payload, { chunkSize: 512 });
    expect(asset.chunked).toBe(true);
    expect(asset.path).toMatch(/\/assets\/\.parts\/[a-f0-9]{64}\/complete\.json$/);

    const digest = sha256Hex(payload);
    expect(server.has(dav(layout.assetManifestPath(digest)))).toBe(true);
    for (let index = 0; index < Math.ceil(payload.length / 512); index += 1) {
      expect(server.has(dav(layout.assetPartPath(digest, index)))).toBe(true);
    }

    const readBack = await client.getAsset(digest);
    expect(Buffer.from(readBack).equals(Buffer.from(payload))).toBe(true);

    // 缺一片 → CHUNK_INCOMPLETE
    await client.deletePath(layout.assetPartPath(digest, 2));
    await expect(client.getAsset(digest)).rejects.toMatchObject({
      code: 'CHUNK_INCOMPLETE',
    });

    // 换一片损坏内容 → CHUNK_CORRUPT（大小可能一致，但整体哈希不对）
    const repaired = await client.putAsset(payload, { chunkSize: 512 });
    expect(repaired.sha256).toBe(digest);
    server.seedFile(dav(layout.assetPartPath(digest, 1)), new Uint8Array(512).fill(7));
    await expect(client.getAsset(digest)).rejects.toMatchObject({
      code: 'CHUNK_CORRUPT',
    });
  });

  it('快照 sha256 校验失败时回退到上一个有效快照', async () => {
    const server = await startServer();
    const client = makeClient(server);

    const first = await client.writeSnapshot({
      entities: [],
      cursors: { 'device-a': 1 },
      coveredSeq: 1,
    });
    const second = await client.writeSnapshot({
      entities: [],
      cursors: { 'device-a': 2 },
      coveredSeq: 2,
    });
    expect(second.ref.coveredSeq).toBe(2);
    expect(server.has(dav(second.ref.sha256Path))).toBe(true);

    // 远端最新快照被改坏：读取方必须跳过它，回退到 seq=1。
    server.seedFile(dav(second.ref.path), new TextEncoder().encode('tampered'));

    const best = await client.readBestSnapshot(3);
    expect(best?.ref.coveredSeq).toBe(1);
    expect(best?.snapshot.cursors).toEqual({ 'device-a': 1 });
    expect(best?.skipped.length).toBeGreaterThanOrEqual(1);
    expect(first.ref.coveredSeq).toBe(1);
  });
});
