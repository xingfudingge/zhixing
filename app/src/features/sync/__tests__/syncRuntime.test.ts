import { describe, expect, it, vi } from 'vitest';

import type { SyncOp } from '../../../../../packages/shared/src/index.ts';
import type { FetchLike } from '../../../sync/client.ts';
import { MemorySyncStore } from '../../../sync/store.ts';
import { MemoryWebDavConfigStore } from '../../../sync/webdav/configStore.ts';
import { createSyncRuntime } from '../runtime.ts';

function pairResponse() {
  return {
    ok: true,
    deviceId: 'dev_test_1',
    deviceName: '测试机',
    deviceToken: 'zxdt_token_1',
    refreshToken: 'zxrt_refresh_1',
    accessExpiresAt: '2026-10-27T00:00:00.000Z',
    refreshExpiresAt: '2026-11-27T00:00:00.000Z',
    features: { sync: true },
    serverTime: '2026-10-26T00:00:00.000Z',
    apiVersion: '1',
  };
}

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

function runtimeWith(
  fetchImpl: FetchLike,
  store = new MemorySyncStore(),
  webdavConfigStore = new MemoryWebDavConfigStore(),
) {
  return createSyncRuntime({
    platform: 'macos',
    store,
    webdavConfigStore,
    fetchImpl,
    now: () => Date.parse('2026-10-26T00:00:00.000Z'),
  });
}

function outboxEntry(): SyncOp {
  return {
    op_id: 'op_failed_1',
    space_id: 'personal',
    device_id: 'device-a',
    entity_type: 'note',
    entity_id: 'note-1',
    op_type: 'upsert',
    hlc: { ms: 1, c: 0, d: 'device-a' },
    base_vv: {},
    payload: { title: '离线修改' },
    created_at: '2026-10-26T00:00:00.000Z',
  };
}

describe('同步运行时', () => {
  it('仅本机模式的读取与立即同步都不发出任何网络请求', async () => {
    const fetchImpl = vi.fn();
    const runtime = runtimeWith(fetchImpl as unknown as FetchLike);

    const status = await runtime.readStatus('local');
    const outcome = await runtime.syncNow('local');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(status.pendingUploads).toBe(0);
    expect(outcome.kind).toBe('skipped');
    expect(outcome.message).toContain('不会发起任何同步网络请求');
  });

  it('后台未配对时立即同步短路，不发出请求', async () => {
    const fetchImpl = vi.fn();
    const runtime = runtimeWith(fetchImpl as unknown as FetchLike);

    const outcome = await runtime.syncNow('backend');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('failed');
    expect(outcome.message).toContain('尚未配对');
  });

  it('WebDAV 未配置地址时立即同步短路，不发出请求', async () => {
    const fetchImpl = vi.fn();
    const runtime = runtimeWith(fetchImpl as unknown as FetchLike);

    const outcome = await runtime.syncNow('webdav');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('failed');
    expect(outcome.message).toContain('尚未配置 WebDAV 地址');
  });

  it('Web 端拒绝 WebDAV 同步且不发请求', async () => {
    const fetchImpl = vi.fn();
    const runtime = createSyncRuntime({
      platform: 'web',
      store: new MemorySyncStore(),
      webdavConfigStore: new MemoryWebDavConfigStore(),
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    const outcome = await runtime.syncNow('webdav');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('skipped');
    expect(outcome.message).toContain('Web 端不提供 WebDAV');
  });

  it('配对后台使用真实 HTTP 并持久化配对状态', async () => {
    const fetchImpl = vi.fn(
      async (_input: string, _init?: RequestInit) => jsonResponse(pairResponse()),
    );
    const store = new MemorySyncStore();
    const runtime = runtimeWith(
      fetchImpl as unknown as FetchLike,
      store,
    );

    const profile = await runtime.pairBackend({
      baseUrl: 'https://sync.example.com/',
      code: 'ABCD-1234',
      deviceName: '测试机',
    });
    const status = await runtime.readStatus('backend');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://sync.example.com/api/v1/devices/pair',
    );
    expect(profile.deviceId).toBe('dev_test_1');
    expect(status.backendProfile?.deviceName).toBe('测试机');
    expect((await store.loadProfile())?.baseUrl).toBe(
      'https://sync.example.com',
    );
  });

  it('配对失败抛出服务端可读错误，不伪造已配对', async () => {
    const fetchImpl = vi.fn(async () => {
      const body = { error: { code: 'PAIRING_CODE_INVALID', message: '配对码无效' } };
      const text = JSON.stringify(body);
      return {
        ok: false,
        status: 401,
        text: async () => text,
      } as unknown as Response;
    });
    const store = new MemorySyncStore();
    const runtime = runtimeWith(fetchImpl as unknown as FetchLike, store);

    await expect(
      runtime.pairBackend({
        baseUrl: 'https://sync.example.com',
        code: 'bad',
        deviceName: '测试机',
      }),
    ).rejects.toThrow('配对码无效');
    expect(await store.loadProfile()).toBeNull();
  });

  it('状态包含 outbox 错误与待上传数量', async () => {
    const store = new MemorySyncStore();
    await store.putOutbox({
      op: outboxEntry(),
      attempts: 2,
      nextAttemptAt: 0,
      lastError: '网络不可达',
    });
    const runtime = runtimeWith(
      vi.fn() as unknown as FetchLike,
      store,
    );

    const status = await runtime.readStatus('backend');

    expect(status.pendingUploads).toBe(1);
    expect(status.issues).toEqual([
      expect.objectContaining({
        id: 'op_failed_1',
        message: '网络不可达',
        attempts: 2,
      }),
    ]);
  });
});
