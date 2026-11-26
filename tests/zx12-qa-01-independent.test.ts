// @ts-nocheck
/**
 * ZX12-QA-01 独立回归：自动回退后的“当前源”必须保持，清除当前源必须
 * 删实际提供数据的源，而不是偏好里残留的源。
 *
 * 这两个用例故意按产品承诺断言；失败即说明产品缺陷（不是测试环境问题）。
 * 复现证据：tests/evidence/zx12-qa-01/desktop/main.json 与 browser/summary.json。
 */
import { describe, expect, it } from 'vitest';

import type { HolidayPackage } from '../app/src/data/calendar/holidays';
import { MemoryHolidayPackageStore, holidayCacheKey } from '../app/src/features/calendar/holiday/store';
import { HolidaySyncService, defaultHolidaySyncState } from '../app/src/features/calendar/holiday/sync';
import {
  normalizeHolidayPreferences,
  normalizeHolidaySyncState,
} from '../app/src/features/calendar/holiday/types';
import { IcsSyncService } from '../app/src/features/calendar/ics/sync';
import { MemoryIcsStore } from '../app/src/features/calendar/ics/store';

const NOW = new Date('2026-11-01T12:00:00.000Z');

function pack(source: string): HolidayPackage {
  return {
    year: 2026,
    days: [
      { name: '元旦', date: '2026-01-01', isOffDay: true },
      { name: '元旦', date: '2026-01-02', isOffDay: true },
      { name: '元旦', date: '2026-01-03', isOffDay: true },
      { name: '国庆节', date: '2026-10-01', isOffDay: true },
      { name: '国庆节', date: '2026-10-02', isOffDay: true },
    ],
    source,
    version: `${source}-v1`,
    origin: 'remote',
    fetchedAt: NOW.toISOString(),
    papers: [],
  };
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
  lastSyncAt: NOW.toISOString(),
  lastAttemptAt: NOW.toISOString(),
  cachedYears: [2026],
};

async function seedRecord(
  store: MemoryHolidayPackageStore,
  sourceId: 'chinese-days' | 'holiday-cn' | 'china-mainland-calendar',
  year = 2026,
) {
  await store.putRecord({
    cacheKey: holidayCacheKey(sourceId, 'jsdelivr', year),
    sourceId,
    transport: 'jsdelivr',
    format: sourceId === 'chinese-days' ? 'chinese-days-json' : 'holiday-cn-json',
    year,
    package: pack(sourceId),
    etag: `"${sourceId}-v1"`,
    lastModified: null,
    contentHash: `${sourceId}-hash`,
    fetchedAt: NOW.toISOString(),
  });
}

describe('ZX12-QA-01 自动回退当前源', () => {
  it('持久化的 activeSourceId 在重新读取后不得被偏好源覆盖', () => {
    const normalized = normalizeHolidaySyncState(fallbackState);
    expect(normalized).not.toBeNull();
    expect(normalized?.activeSourceId).toBe('chinese-days');
    expect(normalized?.activeTransport).toBe('jsdelivr');
    expect(normalized?.fallbackUsed).toBe(true);
    expect(normalized?.sourceId).toBe('china-mainland-calendar');
  });

  it('重启/重开设置页后仍恢复真实 active，且偏好源保持不变', async () => {
    const store = new MemoryHolidayPackageStore();
    await seedRecord(store, 'chinese-days');
    await seedRecord(store, 'holiday-cn');
    await store.putState(fallbackState);

    const first = new HolidaySyncService({
      store,
      now: () => NOW,
      fetchImpl: () => Promise.reject(new Error('不应发起网络请求')),
    });
    const firstState = await first.getState();
    expect(firstState.activeSourceId).toBe('chinese-days');
    expect(firstState.activeTransport).toBe('jsdelivr');
    expect(firstState.sourceId).toBe('china-mainland-calendar');
    expect(firstState.fallbackFromSourceId).toBe('holiday-cn');

    // 模拟重启：新服务实例读取同一份 IndexedDB 快照。
    const restarted = new HolidaySyncService({
      store,
      now: () => NOW,
      fetchImpl: () => Promise.reject(new Error('不应发起网络请求')),
    });
    const state = await restarted.getState();
    expect(state.activeSourceId).toBe('chinese-days');
    expect(state.activeTransport).toBe('jsdelivr');
    expect(state.sourceId).toBe('china-mainland-calendar');
    expect(state.mode).toBe('auto');
    expect(state.fallbackUsed).toBe(true);
    expect(state.fallbackFromSourceId).toBe('holiday-cn');
  });

  it('active 源当前年缓存失效时按偏好/failover 重新推导并修复持久化状态', async () => {
    const store = new MemoryHolidayPackageStore();
    await seedRecord(store, 'holiday-cn');
    await store.putState({
      ...fallbackState,
      activeSourceId: 'china-mainland-calendar',
      activeTransport: 'jsdelivr',
    });

    const service = new HolidaySyncService({
      store,
      now: () => NOW,
      fetchImpl: () => Promise.reject(new Error('不应发起网络请求')),
    });
    const state = await service.getState();
    expect(state.activeSourceId).toBe('holiday-cn');
    expect(state.activeTransport).toBe('jsdelivr');
    expect(state.sourceId).toBe('china-mainland-calendar');
    expect((await store.getState())?.activeSourceId).toBe('holiday-cn');
  });

  it('清除当前源应清除实际提供数据的 chinese-days，而不是偏好残留源', async () => {
    const store = new MemoryHolidayPackageStore();
    for (const sourceId of ['chinese-days', 'holiday-cn'] as const) {
      await store.putRecord({
        cacheKey: holidayCacheKey(sourceId, 'jsdelivr', 2026),
        sourceId,
        transport: 'jsdelivr',
        format: sourceId === 'chinese-days' ? 'chinese-days-json' : 'holiday-cn-json',
        year: 2026,
        package: pack(sourceId),
        etag: `"${sourceId}-v1"`,
        lastModified: null,
        contentHash: `${sourceId}-hash`,
        fetchedAt: NOW.toISOString(),
      });
    }
    await store.putState(fallbackState);

    const service = new HolidaySyncService({
      store,
      now: () => NOW,
      fetchImpl: () => Promise.reject(new Error('不应发起网络请求')),
    });
    await service.clearCurrent(
      normalizeHolidayPreferences({
        mode: 'auto',
        sourceId: 'china-mainland-calendar',
        transport: 'auto',
      }),
    );

    const records = await store.listRecords();
    expect(records.some((record) => record.sourceId === 'chinese-days')).toBe(false);
    expect(records.some((record) => record.sourceId === 'holiday-cn')).toBe(true);

    const state = await service.getState();
    expect(state.activeSourceId).toBe('builtin');
    expect(state.mode).toBe('auto');
    expect(state.sourceId).toBe('china-mainland-calendar');
    expect(state.fallbackUsed).toBe(false);
    expect(state.fallbackFromSourceId).toBeNull();
  });

  it('内置离线模式下“清除当前源”不得删除隐藏的远端缓存', async () => {
    const store = new MemoryHolidayPackageStore();
    await seedRecord(store, 'holiday-cn');
    await store.putState({
      ...fallbackState,
      activeSourceId: 'holiday-cn',
    });

    const service = new HolidaySyncService({
      store,
      now: () => NOW,
      fetchImpl: () => Promise.reject(new Error('不应发起网络请求')),
    });
    const cleared = await service.clearCurrent(
      normalizeHolidayPreferences({ mode: 'builtin' }),
    );
    expect(cleared).toBe('builtin');
    expect((await store.listRecords()).some((record) => record.sourceId === 'holiday-cn')).toBe(
      true,
    );
  });

  it('手动选源并同步后 active 切换到该源，偏好不变', async () => {
    const store = new MemoryHolidayPackageStore();
    const body = JSON.stringify({
      holidays: {
        '2026-01-01': "New Year's Day,元旦,1",
        '2026-01-02': "New Year's Day,元旦,1",
        '2026-01-03': "New Year's Day,元旦,1",
        '2026-10-01': 'National Day,国庆节,3',
        '2026-10-02': 'National Day,国庆节,3',
      },
      workdays: {},
    });
    const service = new HolidaySyncService({
      store,
      now: () => NOW,
      targetYears: () => [2026],
      fetchImpl: () =>
        Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
    const preferences = normalizeHolidayPreferences({
      mode: 'single',
      sourceId: 'chinese-days',
      transport: 'jsdelivr',
      autoFallback: false,
    });
    const result = await service.sync(preferences);
    expect(result.activeSourceId).toBe('chinese-days');
    expect(result.state.sourceId).toBe('chinese-days');

    const state = await service.getState();
    expect(state.activeSourceId).toBe('chinese-days');
    expect(state.activeTransport).toBe('jsdelivr');
    expect(state.sourceId).toBe('chinese-days');
  });
});

describe('ZX12-QA-01 边界', () => {
  it('删除不存在的 ICS 订阅给出具体错误，不静默成功', async () => {
    const service = new IcsSyncService({
      store: new MemoryIcsStore(),
      events: {
        list: async () => [],
        create: async () => {
          throw new Error('不应创建事件');
        },
        update: async () => {
          throw new Error('不应更新事件');
        },
        remove: async () => {
          throw new Error('不应删除事件');
        },
      },
      now: () => NOW,
    });
    await expect(service.removeSubscription('missing-subscription')).rejects.toThrow(
      '订阅不存在',
    );
  });
});
