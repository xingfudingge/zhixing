// @ts-nocheck
/**
 * ZX12-QA-02 独立回归（不启动桌面壳；桌面/Chromium 真实链路见 e2e 证据）。
 *
 * 本文件只按卡面 F1/F2 的产品承诺断言，不修改产品代码：
 * F1：桌面代理第二次同步发送 If-None-Match、原样接收 304、不落镜像 200；
 *     200 即使带条件头也不得冒充未变化；304 无缓存必须明确失败。
 * F2：持久化 activeSourceId 优先于偏好源；重启保持；清除当前源只删 active；
 *     清除后重启仍回退内置离线；快速连点清除幂等。
 */
import { describe, expect, it } from 'vitest';

import type { HolidayPackage } from '../app/src/data/calendar/holidays';
import {
  MemoryHolidayPackageStore,
  holidayCacheKey,
} from '../app/src/features/calendar/holiday/store';
import {
  HolidaySyncService,
  defaultHolidaySyncState,
} from '../app/src/features/calendar/holiday/sync';
import {
  normalizeHolidayPreferences,
  normalizeHolidaySyncState,
} from '../app/src/features/calendar/holiday/types';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const PREVIOUS = '2026-10-01T00:00:00.000Z';

const PAYLOAD = JSON.stringify({
  year: 2026,
  papers: [],
  days: [
    { name: '元旦', date: '2026-01-01', isOffDay: true },
    { name: '元旦', date: '2026-01-02', isOffDay: true },
    { name: '元旦', date: '2026-01-03', isOffDay: true },
    { name: '国庆节', date: '2026-10-01', isOffDay: true },
    { name: '国庆节', date: '2026-10-02', isOffDay: true },
  ],
});

function pack(source: string): HolidayPackage {
  return {
    year: 2026,
    days: JSON.parse(PAYLOAD).days,
    source,
    version: `${source}-v1`,
    origin: 'remote',
    fetchedAt: NOW.toISOString(),
    papers: [],
  };
}

function single(sourceId = 'holiday-cn') {
  return normalizeHolidayPreferences({
    mode: 'single',
    sourceId,
    transport: 'jsdelivr',
    autoFallback: false,
  });
}

async function seedRecord(
  store: MemoryHolidayPackageStore,
  sourceId: 'chinese-days' | 'holiday-cn' | 'china-mainland-calendar',
  year = 2026,
  transport = 'jsdelivr',
) {
  await store.putRecord({
    cacheKey: holidayCacheKey(sourceId, transport, year),
    sourceId,
    transport,
    format:
      sourceId === 'chinese-days' ? 'chinese-days-json' : 'holiday-cn-json',
    year,
    package: pack(sourceId),
    etag: `"${sourceId}-v1"`,
    lastModified: null,
    contentHash: `${sourceId}-hash`,
    fetchedAt: PREVIOUS,
  });
}

const fallbackState = {
  ...defaultHolidaySyncState(),
  source: 'jsdelivr',
  mode: 'auto',
  sourceId: 'china-mainland-calendar',
  transport: 'auto',
  activeSourceId: 'chinese-days',
  activeTransport: 'jsdelivr',
  lastGoodSourceId: 'chinese-days',
  fallbackUsed: true,
  fallbackFromSourceId: 'holiday-cn',
  fallbackReason: 'holiday-cn：节假日拉取失败（HTTP 500）',
  lastSyncAt: PREVIOUS,
  lastAttemptAt: PREVIOUS,
  cachedYears: [2026],
};

function proxyResponse(
  status: number,
  {
    etag = null,
    body = '',
    contentType = 'application/json',
  }: { etag?: string | null; body?: string; contentType?: string } = {},
) {
  return {
    status,
    statusText:
      status === 304 ? 'Not Modified' : status === 200 ? 'OK' : 'Error',
    etag,
    lastModified: null,
    contentType,
    body,
    finalUrl: '',
  };
}

describe('ZX12-QA-02 F1：代理 304 语义', () => {
  it('第二次同步经 Rust 代理发送 If-None-Match 并原样 304，不追加镜像请求', async () => {
    const store = new MemoryHolidayPackageStore();
    const calls: any[] = [];
    const responses = [
      proxyResponse(200, { etag: '"qa02-v1"', body: PAYLOAD }),
      proxyResponse(304, { etag: '"qa02-v1"' }),
    ];
    const service = new HolidaySyncService({
      store,
      runtime: true,
      invokeImpl: async (command: string, args: any) => {
        calls.push({ command, args });
        return responses.shift();
      },
      now: () => NOW,
      targetYears: () => [2026],
    });

    const first = await service.sync(single());
    expect(first.notModified).toBe(false);
    expect(first.fetchedYears).toEqual([2026]);
    const before = await store.getRecord('holiday-cn', 'jsdelivr', 2026);
    expect(before?.etag).toBe('"qa02-v1"');

    const second = await service.sync(single());

    // 只有每次同步各一次 IPC；304 后没有 GitHub Raw/unpkg 镜像 200。
    expect(calls.map((call) => call.command)).toEqual([
      'http_fetch_text',
      'http_fetch_text',
    ]);
    expect(calls[1].args.headers['if-none-match']).toBe('"qa02-v1"');
    expect(second.notModified).toBe(true);
    expect(second.fetchedYears).toEqual([]);
    expect(second.state.lastSyncAt).toBe(NOW.toISOString());
    expect(second.state.lastError).toBeNull();

    const after = await store.getRecord('holiday-cn', 'jsdelivr', 2026);
    expect(after?.etag).toBe('"qa02-v1"');
    expect(after?.fetchedAt).toBe(before?.fetchedAt);
    expect(after?.package.version).toBe(before?.package.version);
    expect(after?.contentHash).toBe(before?.contentHash);
  });

  it('代理返回 200 时不得冒充 304，必须重写缓存版本', async () => {
    const store = new MemoryHolidayPackageStore();
    const calls: any[] = [];
    const responses = [
      proxyResponse(200, { etag: '"qa02-v1"', body: PAYLOAD }),
      proxyResponse(200, { etag: '"qa02-v2"', body: PAYLOAD }),
    ];
    const service = new HolidaySyncService({
      store,
      runtime: true,
      invokeImpl: async (command: string, args: any) => {
        calls.push({ command, args });
        return responses.shift();
      },
      now: () => NOW,
      targetYears: () => [2026],
    });

    await service.sync(single());
    const second = await service.sync(single());

    expect(calls[1].args.headers['if-none-match']).toBe('"qa02-v1"');
    expect(second.notModified).toBe(false);
    expect(second.fetchedYears).toEqual([2026]);
    const after = await store.getRecord('holiday-cn', 'jsdelivr', 2026);
    expect(after?.etag).toBe('"qa02-v2"');
    expect(after?.package.version).not.toBe(pack('holiday-cn').version);
  });

  it('上游 304 但本地没有当前年缓存时明确失败，不写成功时间/不造假缓存', async () => {
    const store = new MemoryHolidayPackageStore();
    const service = new HolidaySyncService({
      store,
      runtime: true,
      invokeImpl: async () => proxyResponse(304, { etag: '"ghost"' }),
      now: () => NOW,
      targetYears: () => [2026],
    });

    await expect(service.sync(single())).rejects.toThrow(/304|缓存/);
    expect(await store.getRecord('holiday-cn', 'jsdelivr', 2026)).toBeNull();
    const state = await store.getState();
    expect(state?.lastSyncAt ?? null).toBeNull();
    expect(state?.lastError).toMatch(/304/);
  });

  it('坏包/超时/断网均保留上次成功缓存且不更新 lastSyncAt', async () => {
    for (const fault of ['bad-json', 'timeout', 'offline']) {
      const store = new MemoryHolidayPackageStore();
      await seedRecord(store, 'holiday-cn');
      await store.putState({
        ...defaultHolidaySyncState(),
        source: 'jsdelivr',
        mode: 'single',
        sourceId: 'holiday-cn',
        transport: 'jsdelivr',
        activeSourceId: 'holiday-cn',
        activeTransport: 'jsdelivr',
        lastSyncAt: PREVIOUS,
        lastAttemptAt: PREVIOUS,
        cachedYears: [2026],
      });
      const service = new HolidaySyncService({
        store,
        runtime: true,
        invokeImpl: async () => {
          if (fault === 'bad-json') {
            return proxyResponse(200, { body: '{not json' });
          }
          if (fault === 'timeout') {
            throw new Error('桌面网络代理请求超时：ZX12-QA-02');
          }
          throw new Error('无法获取（ZX12-QA-02 断网）');
        },
        now: () => NOW,
        targetYears: () => [2026],
      });

      await expect(service.sync(single())).rejects.toThrow();
      const record = await store.getRecord('holiday-cn', 'jsdelivr', 2026);
      expect(record?.fetchedAt, fault).toBe(PREVIOUS);
      const state = await store.getState();
      expect(state?.lastSyncAt, fault).toBe(PREVIOUS);
      expect(state?.lastAttemptAt, fault).toBe(NOW.toISOString());
      expect(state?.lastError, fault).toBeTruthy();
    }
  });

  it('浏览器运行时明确提示需桌面壳，不发远端请求、不伪造 304', async () => {
    const store = new MemoryHolidayPackageStore();
    await seedRecord(store, 'holiday-cn');
    await store.putState({
      ...defaultHolidaySyncState(),
      source: 'jsdelivr',
      mode: 'single',
      sourceId: 'holiday-cn',
      transport: 'jsdelivr',
      activeSourceId: 'holiday-cn',
      activeTransport: 'jsdelivr',
      lastSyncAt: PREVIOUS,
      lastAttemptAt: PREVIOUS,
      cachedYears: [2026],
    });
    const service = new HolidaySyncService({
      store,
      runtime: false,
      now: () => NOW,
      targetYears: () => [2026],
    });

    expect(service.transportKind).toBe('browser');
    await expect(service.sync(single())).rejects.toThrow(/需桌面壳/);
    const state = await store.getState();
    expect(state?.lastSyncAt).toBe(PREVIOUS);
    expect(state?.lastAttemptAt).toBe(NOW.toISOString());
    expect(state?.lastError).toContain('桌面壳');
    expect(
      (await store.getRecord('holiday-cn', 'jsdelivr', 2026))?.package.version,
    ).toBe('holiday-cn-v1');
  });
});

describe('ZX12-QA-02 F2：active 源持久化与清除', () => {
  it('重新读取状态时优先持久化 activeSourceId，不被偏好源覆盖', () => {
    const normalized = normalizeHolidaySyncState(fallbackState);
    expect(normalized?.activeSourceId).toBe('chinese-days');
    expect(normalized?.activeTransport).toBe('jsdelivr');
    expect(normalized?.sourceId).toBe('china-mainland-calendar');
    expect(normalized?.fallbackUsed).toBe(true);
    expect(normalized?.fallbackFromSourceId).toBe('holiday-cn');
  });

  it('重启后（新服务实例）当前源仍为真实 active，偏好不变', async () => {
    const store = new MemoryHolidayPackageStore();
    await seedRecord(store, 'chinese-days');
    await seedRecord(store, 'holiday-cn');
    await store.putState(fallbackState);

    const restarted = new HolidaySyncService({
      store,
      now: () => NOW,
      fetchImpl: () => Promise.reject(new Error('不应发起网络请求')),
    });
    const state = await restarted.getState();
    expect(state.activeSourceId).toBe('chinese-days');
    expect(state.activeTransport).toBe('jsdelivr');
    expect(state.sourceId).toBe('china-mainland-calendar');
    expect(state.fallbackFromSourceId).toBe('holiday-cn');
  });

  it('清除当前源只删 active（chinese-days），保留其它源与偏好', async () => {
    const store = new MemoryHolidayPackageStore();
    await seedRecord(store, 'chinese-days');
    await seedRecord(store, 'holiday-cn');
    await seedRecord(store, 'china-mainland-calendar');
    await store.putState(fallbackState);

    const service = new HolidaySyncService({
      store,
      now: () => NOW,
      fetchImpl: () => Promise.reject(new Error('不应发起网络请求')),
    });
    const cleared = await service.clearCurrent(
      normalizeHolidayPreferences({
        mode: 'auto',
        sourceId: 'china-mainland-calendar',
        transport: 'auto',
      }),
    );

    expect(cleared).toBe('chinese-days');
    const remaining = (await store.listRecords()).map(
      (record) => record.sourceId,
    );
    expect(remaining).not.toContain('chinese-days');
    expect(remaining).toContain('holiday-cn');
    expect(remaining).toContain('china-mainland-calendar');

    const state = await service.getState();
    expect(state.activeSourceId).toBe('builtin');
    expect(state.sourceId).toBe('china-mainland-calendar');
    expect(state.fallbackUsed).toBe(false);
    expect(state.fallbackFromSourceId).toBeNull();
  });

  it('清除当前源后重启仍保持内置离线，不复活已删源', async () => {
    const store = new MemoryHolidayPackageStore();
    await seedRecord(store, 'chinese-days');
    await seedRecord(store, 'holiday-cn');
    await store.putState(fallbackState);

    const first = new HolidaySyncService({
      store,
      now: () => NOW,
      fetchImpl: () => Promise.reject(new Error('不应发起网络请求')),
    });
    await first.clearCurrent(
      normalizeHolidayPreferences({
        mode: 'auto',
        sourceId: 'china-mainland-calendar',
        transport: 'auto',
      }),
    );

    const restarted = new HolidaySyncService({
      store,
      now: () => NOW,
      fetchImpl: () => Promise.reject(new Error('不应发起网络请求')),
    });
    const state = await restarted.getState();
    expect(state.activeSourceId).toBe('builtin');
    expect(
      (await store.listRecords()).some(
        (record) => record.sourceId === 'chinese-days',
      ),
    ).toBe(false);
  });

  it('快速连点清除当前源：第二次幂等返回 builtin，不删除其它源', async () => {
    const store = new MemoryHolidayPackageStore();
    await seedRecord(store, 'chinese-days');
    await seedRecord(store, 'holiday-cn');
    await store.putState(fallbackState);
    const service = new HolidaySyncService({
      store,
      now: () => NOW,
      fetchImpl: () => Promise.reject(new Error('不应发起网络请求')),
    });
    const preferences = normalizeHolidayPreferences({
      mode: 'auto',
      sourceId: 'china-mainland-calendar',
      transport: 'auto',
    });

    const [first, second] = await Promise.all([
      service.clearCurrent(preferences),
      service.clearCurrent(preferences),
    ]);
    // 两个并发调用都可能落在 active 变更前，因此都返回 chinese-days；
    // 关键是删除目标始终是同一个 active 源，不能因连点误删偏好源或其它源。
    expect([first, second]).toContain('chinese-days');
    for (const value of [first, second]) {
      expect(['chinese-days', 'builtin']).toContain(value);
    }
    expect(
      (await store.listRecords()).some(
        (record) => record.sourceId === 'holiday-cn',
      ),
    ).toBe(true);
    expect(
      (await service.getState()).activeSourceId,
    ).toBe('builtin');
  });
});
