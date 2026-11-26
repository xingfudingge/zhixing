import { describe, expect, it, vi } from 'vitest';

import { createHolidayLookup, holidayOn } from '../../../../data/calendar/holidays';
import {
  HolidaySourceError,
  normalizeHolidayPreferences,
  normalizeHolidaySyncState,
  type HolidayPreferences,
  type HolidaySourceId,
} from '../types';
import { MemoryHolidayPackageStore, holidayCacheKey } from '../store';
import { HolidaySyncService, defaultHolidaySyncState } from '../sync';

const NOW = new Date(2026, 10, 1, 12, 0, 0); // 本地 2026-11-01 12:00
const ATTEMPT = NOW.toISOString();
const PREVIOUS_SYNC = '2026-10-01T00:00:00.000Z';

const URLS = {
  'holiday-cn':
    'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json',
  'holiday-cn-github':
    'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2026.json',
  'chinese-days':
    'https://cdn.jsdelivr.net/npm/chinese-days@1.5.9/dist/years/2026.json',
  'chinese-days-unpkg':
    'https://unpkg.com/chinese-days@1.5.9/dist/years/2026.json',
  'china-mainland-calendar':
    'https://cdn.jsdelivr.net/gh/Lancetwang/china-mainland-calendar@main/china-mainland.ics',
} as const;

const DAYS_2026 = [
  { name: '元旦', date: '2026-01-01', isOffDay: true },
  { name: '元旦', date: '2026-01-02', isOffDay: true },
  { name: '元旦', date: '2026-01-03', isOffDay: true },
  { name: '元旦调休上班', date: '2026-01-04', isOffDay: false },
  { name: '国庆节', date: '2026-10-01', isOffDay: true },
  { name: '国庆调休上班', date: '2026-10-10', isOffDay: false },
];

function holidayCnPayload(
  year = 2026,
  days: Array<{ name: string; date: string; isOffDay: boolean }> = DAYS_2026,
): string {
  return JSON.stringify({ year, papers: [], days });
}

const CHINESE_DAYS_PAYLOAD = JSON.stringify({
  holidays: {
    '2026-01-01': "New Year's Day,元旦,1",
    '2026-01-02': "New Year's Day,元旦,1",
    '2026-01-03': "New Year's Day,元旦,1",
    '2026-10-01': 'National Day,国庆节,3',
    '2026-10-02': 'National Day,国庆节,3',
  },
  workdays: {
    '2026-01-04': "New Year's Day,元旦,1",
    '2026-10-10': 'National Day,国庆节,3',
  },
});

const ICS_PAYLOAD = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'SUMMARY:元旦',
  'DTSTART;VALUE=DATE:20260101',
  'DTEND;VALUE=DATE:20260102',
  'CATEGORIES:法定节日',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:元旦休假',
  'DTSTART;VALUE=DATE:20260101',
  'DTEND;VALUE=DATE:20260105',
  'CATEGORIES:连续休假',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:元旦调休上班',
  'DTSTART;VALUE=DATE:20260105',
  'DTEND;VALUE=DATE:20260106',
  'CATEGORIES:调休补班',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:国庆节',
  'DTSTART;VALUE=DATE:20261001',
  'DTEND;VALUE=DATE:20261002',
  'CATEGORIES:法定节日',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:国庆调休上班',
  'DTSTART;VALUE=DATE:20261010',
  'DTEND;VALUE=DATE:20261011',
  'CATEGORIES:调休补班',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:小寒',
  'DTSTART;VALUE=DATE:20260106',
  'DTEND;VALUE=DATE:20260107',
  'CATEGORIES:二十四节气',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const PAYLOADS: Record<HolidaySourceId, string> = {
  'holiday-cn': holidayCnPayload(),
  'chinese-days': CHINESE_DAYS_PAYLOAD,
  'china-mainland-calendar': ICS_PAYLOAD,
};

const SUCCESS_URLS: Record<HolidaySourceId, string> = {
  'holiday-cn': URLS['holiday-cn'],
  'chinese-days': URLS['chinese-days'],
  'china-mainland-calendar': URLS['china-mainland-calendar'],
};

function setup(
  options: {
    targetYears?: number[];
    timeoutMs?: number;
    fetchImpl?: ReturnType<typeof vi.fn>;
    now?: () => Date;
  } = {},
) {
  const store = new MemoryHolidayPackageStore();
  const fetchImpl = options.fetchImpl ?? vi.fn();
  const service = new HolidaySyncService({
    store,
    fetchImpl: fetchImpl as unknown as (
      input: string,
      init?: RequestInit,
    ) => Promise<Response>,
    now: options.now ?? (() => NOW),
    timeoutMs: options.timeoutMs ?? 50,
    targetYears: () => options.targetYears ?? [2026],
  });
  return { store, fetchImpl, service };
}

function single(
  sourceId: HolidaySourceId,
  transport: 'jsdelivr' | 'github-raw' | 'unpkg' | 'auto' = 'jsdelivr',
  patch: Partial<HolidayPreferences> = {},
): HolidayPreferences {
  return normalizeHolidayPreferences({
    mode: 'single',
    sourceId,
    transport,
    autoFallback: false,
    ...patch,
  });
}

function automatic(
  transport: 'jsdelivr' | 'github-raw' | 'unpkg' | 'auto' = 'jsdelivr',
  patch: Partial<HolidayPreferences> = {},
): HolidayPreferences {
  return normalizeHolidayPreferences({
    mode: 'auto',
    transport,
    autoFallback: true,
    ...patch,
  });
}

async function seedRecord(
  store: MemoryHolidayPackageStore,
  options: {
    sourceId: HolidaySourceId | 'custom' | 'builtin';
    transport?: 'jsdelivr' | 'github-raw' | 'unpkg' | 'auto';
    year?: number;
    etag?: string;
    version?: string;
    days?: Array<{ name: string; date: string; isOffDay: boolean }>;
  },
) {
  const transport = options.transport ?? 'jsdelivr';
  const year = options.year ?? 2026;
  const version = options.version ?? 'cached-v1';
  const etag = options.etag ?? '"cached-v1"';
  await store.putRecord({
    cacheKey: holidayCacheKey(options.sourceId, transport, year),
    sourceId: options.sourceId,
    transport,
    format: options.sourceId === 'china-mainland-calendar' ? 'ics' : 'holiday-cn-json',
    year,
    package: {
      year,
      days: options.days ?? DAYS_2026,
      source: options.sourceId,
      version,
      origin: 'remote',
      fetchedAt: PREVIOUS_SYNC,
      papers: [],
    },
    etag,
    lastModified: null,
    contentHash: 'deadbeef',
    fetchedAt: PREVIOUS_SYNC,
  });
  await store.putState({
    ...defaultHolidaySyncState(),
    source: 'jsdelivr',
    mode: 'single',
    sourceId:
      options.sourceId === 'custom' || options.sourceId === 'builtin'
        ? 'holiday-cn'
        : options.sourceId,
    transport,
    activeSourceId: options.sourceId,
    activeTransport: transport,
    lastGoodSourceId:
      options.sourceId === 'custom' || options.sourceId === 'builtin'
        ? null
        : options.sourceId,
    lastSyncAt: PREVIOUS_SYNC,
    lastAttemptAt: PREVIOUS_SYNC,
    version: `${year}:${version}`,
    cachedYears: [year],
  });
}

describe.each([
  'holiday-cn',
  'chinese-days',
  'china-mainland-calendar',
] as const)('源 %s', (sourceId) => {
  it('成功拉取后按源+传输+年份写缓存，并可按源查询', async () => {
    const { service, fetchImpl, store } = setup();
    fetchImpl.mockResolvedValueOnce(
      new Response(PAYLOADS[sourceId], {
        status: 200,
        headers: { etag: `"${sourceId}-v1"`, 'content-type': 'text/plain' },
      }),
    );

    const result = await service.sync(single(sourceId));

    expect(fetchImpl).toHaveBeenCalledWith(
      SUCCESS_URLS[sourceId],
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result.fetchedYears).toEqual([2026]);
    expect(result.activeSourceId).toBe(sourceId);
    expect(result.fallbackUsed).toBe(false);
    expect(result.state.lastSyncAt).toBe(ATTEMPT);
    expect(result.state.lastError).toBeNull();
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]?.source).toBe(sourceId);
    const record = await store.getRecord(sourceId, 'jsdelivr', 2026);
    expect(record?.sourceId).toBe(sourceId);
    expect(record?.etag).toBe(`"${sourceId}-v1"`);
    expect(record?.contentHash).toMatch(/^[0-9a-f]{8}$/);

    const lookup = createHolidayLookup(result.packages);
    expect(holidayOn('2026-01-01', lookup)?.kind).toBe('holiday');
    expect(holidayOn('2026-10-10', lookup)?.kind).toBe('makeup');
  });

  it('命中 304 时只更新同步时间，不重复写包', async () => {
    const { service, fetchImpl, store } = setup();
    await seedRecord(store, { sourceId });
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 304 }));

    const result = await service.sync(single(sourceId));

    expect(fetchImpl).toHaveBeenCalledWith(
      SUCCESS_URLS[sourceId],
      expect.objectContaining({
        headers: expect.objectContaining({
          'if-none-match': '"cached-v1"',
        }),
      }),
    );
    expect(result.notModified).toBe(true);
    expect(result.fetchedYears).toEqual([]);
    expect(result.state.lastSyncAt).toBe(ATTEMPT);
    expect((await store.getRecord(sourceId, 'jsdelivr', 2026))?.package.version).toBe(
      'cached-v1',
    );
  });

  it('HTTP 失败保留 last-good，不伪装成功', async () => {
    const { service, fetchImpl, store } = setup();
    await seedRecord(store, { sourceId });
    fetchImpl.mockResolvedValueOnce(new Response('server error', { status: 500 }));

    await expect(service.sync(single(sourceId))).rejects.toBeInstanceOf(
      HolidaySourceError,
    );

    expect((await store.getRecord(sourceId, 'jsdelivr', 2026))?.package.version).toBe(
      'cached-v1',
    );
    const state = await service.getState();
    expect(state.lastSyncAt).toBe(PREVIOUS_SYNC);
    expect(state.lastAttemptAt).toBe(ATTEMPT);
    expect(state.lastError).toContain('HTTP 500');
    expect(state.nextRetryAt).not.toBeNull();
    expect(state.consecutiveFailures).toBe(1);
  });

  it('坏 JSON 不写缓存，并明确报错', async () => {
    const { service, fetchImpl, store } = setup();
    fetchImpl.mockResolvedValueOnce(
      new Response('<html>not json</html>', { status: 200 }),
    );

    await expect(service.sync(single(sourceId))).rejects.toBeInstanceOf(
      HolidaySourceError,
    );
    expect(await store.listPackages(sourceId)).toEqual([]);
    expect((await service.getState()).lastError).toMatch(/不是有效 (JSON|ICS)/);
  });
});

describe('故障转移与状态', () => {
  it('A 失败后按优先级回退到 B，并记录回退源与失败原因', async () => {
    const { service, fetchImpl } = setup();
    fetchImpl
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(new Response(PAYLOADS['chinese-days'], { status: 200 }));

    const result = await service.sync(automatic());

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      URLS['holiday-cn'],
      URLS['chinese-days'],
    ]);
    expect(result.activeSourceId).toBe('chinese-days');
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackFromSourceId).toBe('holiday-cn');
    expect(result.fallbackReason).toContain('HTTP 503');
    expect(result.state.activeSourceId).toBe('chinese-days');
    expect(result.state.fallbackUsed).toBe(true);
    expect(result.state.fallbackReason).toContain('holiday-cn');
    expect(result.state.perSource['holiday-cn']?.lastError).toContain(
      'HTTP 503',
    );
    expect(result.state.perSource['chinese-days']?.lastSuccessAt).toBe(ATTEMPT);
  });

  it('同一源的传输镜像失败后回退，不误算成新源', async () => {
    const { service, fetchImpl } = setup();
    fetchImpl
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response(PAYLOADS['holiday-cn'], { status: 200 }));

    const result = await service.sync(
      single('holiday-cn', 'auto', { autoFallback: true }),
    );

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      URLS['holiday-cn'],
      URLS['holiday-cn-github'],
    ]);
    expect(result.activeSourceId).toBe('holiday-cn');
    expect(result.activeTransport).toBe('github-raw');
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackFromSourceId).toBeNull();
    expect(result.fallbackReason).toContain('HTTP 500');
    expect(result.attempts.filter((item) => item.status === 'failed')).toHaveLength(
      1,
    );
  });

  it('三个源都失败时报聚合错误，保留上次成功缓存与 15m 退避', async () => {
    const { service, fetchImpl, store } = setup();
    await seedRecord(store, { sourceId: 'holiday-cn' });
    fetchImpl
      .mockResolvedValueOnce(new Response('a', { status: 500 }))
      .mockResolvedValueOnce(new Response('b', { status: 502 }))
      .mockResolvedValueOnce(new Response('c', { status: 503 }));

    await expect(service.sync(automatic())).rejects.toThrow(
      /所有节假日源均失败.*holiday-cn.*chinese-days.*china-mainland-calendar/,
    );

    const state = await service.getState();
    expect(state.lastSyncAt).toBe(PREVIOUS_SYNC);
    expect(state.lastAttemptAt).toBe(ATTEMPT);
    expect(state.lastError).toContain('503');
    expect(state.nextRetryAt).toBe(
      new Date(NOW.getTime() + 15 * 60 * 1000).toISOString(),
    );
    expect((await store.getRecord('holiday-cn', 'jsdelivr', 2026))?.package.version).toBe(
      'cached-v1',
    );
  });

  it('固定单源显式开启回退后，按优先级切到下一个独立源', async () => {
    const { service, fetchImpl } = setup();
    fetchImpl
      .mockResolvedValueOnce(new Response('a', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(PAYLOADS['chinese-days'], { status: 200 }),
      );

    const result = await service.sync(
      single('holiday-cn', 'jsdelivr', { autoFallback: true }),
    );

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      URLS['holiday-cn'],
      URLS['chinese-days'],
    ]);
    expect(result.activeSourceId).toBe('chinese-days');
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackFromSourceId).toBe('holiday-cn');
  });

  it('固定单源关闭回退时不会请求其它源', async () => {
    const { service, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(new Response('boom', { status: 500 }));

    await expect(service.sync(single('holiday-cn'))).rejects.toBeInstanceOf(
      HolidaySourceError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('跨年、304 与超时', () => {
  it('今年成功、明年空包只标记未公布，不覆盖今年', async () => {
    const { service, fetchImpl } = setup({ targetYears: [2026, 2027] });
    fetchImpl
      .mockResolvedValueOnce(
        new Response(holidayCnPayload(2026, DAYS_2026), {
          status: 200,
          headers: { etag: '"v2026"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(holidayCnPayload(2027, []), {
          status: 200,
          headers: { etag: '"empty"' },
        }),
      );

    const result = await service.sync(single('holiday-cn'));

    expect(result.fetchedYears).toEqual([2026]);
    expect(result.notPublishedYears).toEqual([2027]);
    expect(result.state.notPublishedYears).toEqual([2027]);
    expect(result.packages.map((item) => item.year)).toEqual([2026]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('源不覆盖下一年时直接标记未公布，不发多余请求', async () => {
    for (const sourceId of [
      'chinese-days',
      'china-mainland-calendar',
    ] as const) {
      const { service, fetchImpl } = setup({ targetYears: [2026, 2027] });
      fetchImpl.mockResolvedValueOnce(
        new Response(PAYLOADS[sourceId], { status: 200 }),
      );
      const result = await service.sync(single(sourceId));
      expect(result.notPublishedYears).toEqual([2027]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('今年成功、明年 HTTP 失败返回 partial，不整体标红', async () => {
    const { service, fetchImpl } = setup({ targetYears: [2026, 2027] });
    fetchImpl
      .mockResolvedValueOnce(new Response(PAYLOADS['holiday-cn'], { status: 200 }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));

    const result = await service.sync(single('holiday-cn'));

    expect(result.fetchedYears).toEqual([2026]);
    expect(result.partial).toBe(true);
    expect(result.warnings.join('')).toContain('2027');
    expect(result.state.lastError).toBeNull();
  });

  it('今年 404 是失败，不是未公布', async () => {
    const { service, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(new Response('missing', { status: 404 }));

    await expect(service.sync(single('holiday-cn'))).rejects.toBeInstanceOf(
      HolidaySourceError,
    );
    expect((await service.getState()).lastError).toContain('HTTP 404');
  });

  it('304 但没有本地缓存是失败，不能凭 304 造数据', async () => {
    const { service, fetchImpl, store } = setup();
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 304 }));

    await expect(service.sync(single('holiday-cn'))).rejects.toBeInstanceOf(
      HolidaySourceError,
    );
    expect(await store.listPackages('holiday-cn')).toEqual([]);
    expect((await service.getState()).lastError).toContain('304');
  });

  it('超时立即失败，不把同步中永久挂起', async () => {
    const { service, fetchImpl, store } = setup({ timeoutMs: 15 });
    fetchImpl.mockReturnValueOnce(new Promise(() => undefined));

    await expect(service.sync(single('holiday-cn'))).rejects.toMatchObject({
      name: 'HolidaySourceError',
      message: expect.stringContaining('超时'),
    });

    expect(await store.listPackages('holiday-cn')).toEqual([]);
    expect((await service.getState()).lastError).toContain('超时');
  });
});

describe('缓存隔离、迁移与持久化', () => {
  it('A→B→A 切换：B 不带 A 的 ETag，A 仍能用自己的 ETag 命中 304', async () => {
    const { service, fetchImpl, store } = setup();
    fetchImpl
      .mockResolvedValueOnce(
        new Response(PAYLOADS['holiday-cn'], {
          status: 200,
          headers: { etag: '"a-v1"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(PAYLOADS['chinese-days'], {
          status: 200,
          headers: { etag: '"b-v1"' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));

    await service.sync(single('holiday-cn'));
    await service.sync(single('chinese-days'));
    const bCall = fetchImpl.mock.calls[1]!;
    expect(bCall[0]).toBe(URLS['chinese-days']);
    expect(
      (bCall[1] as RequestInit).headers,
    ).not.toHaveProperty('if-none-match');

    await service.sync(single('holiday-cn'));
    const aSecond = fetchImpl.mock.calls[2]!;
    expect(
      (aSecond[1] as RequestInit).headers,
    ).toMatchObject({ 'if-none-match': '"a-v1"' });

    expect((await store.getRecord('holiday-cn', 'jsdelivr', 2026))?.etag).toBe(
      '"a-v1"',
    );
    expect(
      (await store.getRecord('chinese-days', 'jsdelivr', 2026))?.etag,
    ).toBe('"b-v1"');
  });

  it('清除当前源只删该源；清除全部保留其它缓存直到全部删除', async () => {
    const { service, fetchImpl, store } = setup();
    fetchImpl
      .mockResolvedValueOnce(new Response(PAYLOADS['holiday-cn'], { status: 200 }))
      .mockResolvedValueOnce(new Response(PAYLOADS['chinese-days'], { status: 200 }));

    await service.sync(single('holiday-cn'));
    await service.sync(single('chinese-days'));

    await service.clearCurrent(single('chinese-days'));
    expect(await store.getRecord('chinese-days', 'jsdelivr', 2026)).toBeNull();
    expect(
      await store.getRecord('holiday-cn', 'jsdelivr', 2026),
    ).not.toBeNull();

    await service.clearAll();
    expect(await store.listRecords()).toEqual([]);
    expect((await service.getState()).mode).toBe('builtin');
  });

  it('旧状态 source=github 仍可读取并映射到 holiday-cn/github-raw', async () => {
    const { store, service } = setup();
    await store.putState({
      source: 'github',
      lastSyncAt: PREVIOUS_SYNC,
      lastAttemptAt: PREVIOUS_SYNC,
      lastError: null,
      version: '2026:cached-v1',
      cachedYears: [2026],
      notPublishedYears: [],
    } as unknown as ReturnType<typeof defaultHolidaySyncState>);

    const state = await service.getState();
    expect(state.mode).toBe('single');
    expect(state.sourceId).toBe('holiday-cn');
    expect(state.transport).toBe('github-raw');
    expect(state.activeSourceId).toBe('holiday-cn');
    expect(state.activeTransport).toBe('github-raw');
    expect(state.lastSyncAt).toBe(PREVIOUS_SYNC);
    expect(state.perSource['holiday-cn']?.lastSuccessAt).toBe(PREVIOUS_SYNC);
  });

  it('重启后新服务实例读取同一缓存与状态，24h 内自动同步跳过', async () => {
    const { service, fetchImpl, store } = setup();
    fetchImpl.mockResolvedValueOnce(
      new Response(PAYLOADS['holiday-cn'], { status: 200 }),
    );
    await service.sync(single('holiday-cn'));

    const persistedState = await store.getState();
    const persistedRecords = await store.listRecords();
    // 模拟重启：从持久化快照恢复一个新的存储与服务实例。
    const restartedStore = new MemoryHolidayPackageStore();
    for (const record of persistedRecords) {
      await restartedStore.putRecord(record);
    }
    await restartedStore.putState(persistedState!);
    const restartedMake = vi.fn();
    const restarted = new HolidaySyncService({
      store: restartedStore,
      fetchImpl: restartedMake as unknown as (
        input: string,
        init?: RequestInit,
      ) => Promise<Response>,
      now: () => new Date(NOW.getTime() + 60 * 60 * 1000),
      targetYears: () => [2026],
    });

    const state = await restarted.getState();
    expect(state.activeSourceId).toBe('holiday-cn');
    expect(state.lastSyncAt).toBe(ATTEMPT);
    expect(await restarted.listPackages()).toHaveLength(1);
    expect(
      await restarted.maybeAutoSync(single('holiday-cn', 'jsdelivr', {
        autoSync: true,
      })),
    ).toBeNull();
    expect(restartedMake).not.toHaveBeenCalled();
    expect(await restartedStore.getState()).toEqual(persistedState);
  });

  it('离线时保留缓存、不伪装成功；恢复后到退避时间才自动重试', async () => {
    const { service, fetchImpl, store } = setup();
    await seedRecord(store, { sourceId: 'holiday-cn' });
    fetchImpl.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(service.sync(single('holiday-cn'))).rejects.toBeInstanceOf(
      HolidaySourceError,
    );
    expect((await store.listPackages('holiday-cn'))[0]?.version).toBe(
      'cached-v1',
    );
    const state = await service.getState();
    expect(state.lastError).toContain('无法获取');
    expect(state.lastSyncAt).toBe(PREVIOUS_SYNC);

    // 退避未到：自动同步跳过，不发请求。
    const beforeRetry = new HolidaySyncService({
      store,
      fetchImpl: fetchImpl as unknown as (
        input: string,
        init?: RequestInit,
      ) => Promise<Response>,
      now: () => new Date(NOW.getTime() + 5 * 60 * 1000),
      targetYears: () => [2026],
    });
    expect(
      await beforeRetry.maybeAutoSync(
        single('holiday-cn', 'jsdelivr', { autoSync: true }),
      ),
    ).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('内置源不联网，返回内置 2026 状态', async () => {
    const { service, fetchImpl } = setup();
    const result = await service.sync(normalizeHolidayPreferences('builtin'));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.state.mode).toBe('builtin');
    expect(result.state.version).toBe('2026.1');
    expect(result.activeSourceId).toBe('builtin');
  });

  it('自定义 URL 支持 {year} 与单文件源', async () => {
    const withYear = setup();
    withYear.fetchImpl.mockResolvedValueOnce(
      new Response(holidayCnPayload(), { status: 200 }),
    );
    await withYear.service.sync(
      normalizeHolidayPreferences({
        mode: 'custom',
        customUrl: 'https://example.com/holidays-{year}.json',
      }),
    );
    expect(withYear.fetchImpl).toHaveBeenCalledWith(
      'https://example.com/holidays-2026.json',
      expect.anything(),
    );

    const singleFile = setup({ targetYears: [2026, 2027] });
    singleFile.fetchImpl.mockResolvedValueOnce(
      new Response(holidayCnPayload(), { status: 200 }),
    );
    const result = await singleFile.service.sync(
      normalizeHolidayPreferences({
        mode: 'custom',
        customUrl: 'https://example.com/all-holidays.json',
      }),
    );
    expect(singleFile.fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.fetchedYears).toEqual([2026]);
    expect(await singleFile.store.listRecords('custom')).toHaveLength(1);
  });

  it('自定义 URL 为空时明确失败并记录 lastError', async () => {
    const { service, fetchImpl } = setup();
    await expect(
      service.sync(
        normalizeHolidayPreferences({ mode: 'custom', customUrl: '' }),
      ),
    ).rejects.toBeInstanceOf(HolidaySourceError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await service.getState()).lastError).toContain('请填写');
  });
});

describe('桌面 Rust 代理与真实 304（ZX12-FIX-304-01）', () => {
  type ProxyCall = {
    command: string;
    args?: Record<string, unknown>;
  };

  function proxyService(
    responses: Array<Record<string, unknown>>,
    options: {
      store?: MemoryHolidayPackageStore;
      targetYears?: number[];
      invokeImpl?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    } = {},
  ) {
    const store = options.store ?? new MemoryHolidayPackageStore();
    const calls: ProxyCall[] = [];
    const queue = [...responses];
    const invokeImpl =
      options.invokeImpl ??
      (async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const next = queue.shift();
        if (!next) throw new Error('没有更多代理响应');
        return next;
      });
    const service = new HolidaySyncService({
      store,
      runtime: true,
      invokeImpl,
      now: () => NOW,
      timeoutMs: 50,
      targetYears: () => options.targetYears ?? [2026],
    });
    return { service, store, calls };
  }

  it.each([
    'holiday-cn',
    'chinese-days',
    'china-mainland-calendar',
  ] as const)('%s 第二次同步经代理发送 If-None-Match 并接收真实 304', async (sourceId) => {
    const store = new MemoryHolidayPackageStore();
    const responses = [
      {
        status: 200,
        statusText: 'OK',
        etag: `"${sourceId}-v1"`,
        lastModified: null,
        contentType: 'text/plain',
        body: PAYLOADS[sourceId],
        finalUrl: SUCCESS_URLS[sourceId],
      },
      {
        status: 304,
        statusText: 'Not Modified',
        etag: `"${sourceId}-v1"`,
        lastModified: null,
        contentType: null,
        body: '',
        finalUrl: SUCCESS_URLS[sourceId],
      },
    ];
    const { service, calls } = proxyService(responses, { store });

    const first = await service.sync(single(sourceId));
    expect(first.fetchedYears).toEqual([2026]);
    expect(first.notModified).toBe(false);
    const firstRecord = await store.getRecord(sourceId, 'jsdelivr', 2026);
    expect(firstRecord?.etag).toBe(`"${sourceId}-v1"`);
    const firstFetchedAt = firstRecord?.fetchedAt;

    const second = await service.sync(single(sourceId));

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.command === 'http_fetch_text')).toBe(true);
    expect(calls[1]?.args).toMatchObject({
      url: SUCCESS_URLS[sourceId],
      timeoutMs: 50,
      headers: expect.objectContaining({
        'if-none-match': `"${sourceId}-v1"`,
      }),
    });
    expect(second.notModified).toBe(true);
    expect(second.fetchedYears).toEqual([]);
    expect(second.state.lastSyncAt).toBe(ATTEMPT);
    expect(second.state.lastAttemptAt).toBe(ATTEMPT);
    expect(second.state.lastError).toBeNull();
    expect(second.packages).toHaveLength(1);
    expect(second.packages[0]?.version).toBe(first.packages[0]?.version);

    // 304 保留缓存、版本与 fetchedAt，不重复物化。
    const secondRecord = await store.getRecord(sourceId, 'jsdelivr', 2026);
    expect(secondRecord?.etag).toBe(`"${sourceId}-v1"`);
    expect(secondRecord?.fetchedAt).toBe(firstFetchedAt);
    expect(secondRecord?.package.version).toBe(first.packages[0]?.version);
  });

  it('代理返回 200 原文一致时仍按 200 处理，不伪装 304', async () => {
    const body = PAYLOADS['holiday-cn'];
    const { service, calls } = proxyService([
      { status: 200, etag: '"v1"', body },
      { status: 200, etag: '"v1"', body },
    ]);

    await service.sync(single('holiday-cn'));
    const second = await service.sync(single('holiday-cn'));

    expect(calls).toHaveLength(2);
    expect(second.notModified).toBe(false);
    expect(second.fetchedYears).toEqual([2026]);
    expect(second.state.lastSyncAt).toBe(ATTEMPT);
  });

  it('代理返回坏包时保留缓存且不更新 lastSyncAt', async () => {
    const store = new MemoryHolidayPackageStore();
    await seedRecord(store, { sourceId: 'holiday-cn' });
    const { service } = proxyService([
      {
        status: 200,
        etag: '"bad"',
        body: '<html>not json</html>',
      },
    ], { store });

    await expect(service.sync(single('holiday-cn'))).rejects.toBeInstanceOf(
      HolidaySourceError,
    );

    const state = await service.getState();
    expect(state.lastSyncAt).toBe(PREVIOUS_SYNC);
    expect(state.lastAttemptAt).toBe(ATTEMPT);
    expect(state.lastError).toMatch(/不是有效 JSON|格式/);
    expect(
      (await store.getRecord('holiday-cn', 'jsdelivr', 2026))?.package.version,
    ).toBe('cached-v1');
  });

  it('代理超时保留缓存且不更新 lastSyncAt', async () => {
    const store = new MemoryHolidayPackageStore();
    await seedRecord(store, { sourceId: 'holiday-cn' });
    const { service } = proxyService([], {
      store,
      invokeImpl: async () => {
        throw '桌面网络代理请求超时：timed out';
      },
    });

    await expect(service.sync(single('holiday-cn'))).rejects.toBeInstanceOf(
      HolidaySourceError,
    );

    const state = await service.getState();
    expect(state.lastSyncAt).toBe(PREVIOUS_SYNC);
    expect(state.lastAttemptAt).toBe(ATTEMPT);
    expect(state.lastError).toContain('超时');
    expect(
      (await store.getRecord('holiday-cn', 'jsdelivr', 2026))?.package.version,
    ).toBe('cached-v1');
  });

  it('浏览器预览无 Tauri 时不直连远端，明确提示需桌面壳', async () => {
    const store = new MemoryHolidayPackageStore();
    await seedRecord(store, { sourceId: 'holiday-cn' });
    const service = new HolidaySyncService({
      store,
      runtime: false,
      now: () => NOW,
      targetYears: () => [2026],
    });
    expect(service.transportKind).toBe('browser');

    await expect(service.sync(single('holiday-cn'))).rejects.toThrow(
      /浏览器预览.*需桌面壳/,
    );

    const state = await service.getState();
    expect(state.lastSyncAt).toBe(PREVIOUS_SYNC);
    expect(state.lastAttemptAt).toBe(ATTEMPT);
    expect(state.lastError).toContain('桌面壳');
    expect(
      (await store.getRecord('holiday-cn', 'jsdelivr', 2026))?.package.version,
    ).toBe('cached-v1');
  });
});

describe('状态归一化', () => {
  it('旧同步状态缺少新字段时补齐默认值', () => {
    expect(
      normalizeHolidaySyncState({
        source: 'jsdelivr',
        lastSyncAt: PREVIOUS_SYNC,
        lastAttemptAt: PREVIOUS_SYNC,
        lastError: null,
        version: '2026.1',
        cachedYears: [2026],
        notPublishedYears: [],
      }),
    ).toMatchObject({
      mode: 'single',
      sourceId: 'holiday-cn',
      transport: 'jsdelivr',
      activeSourceId: 'holiday-cn',
      activeTransport: 'jsdelivr',
      lastSyncAt: PREVIOUS_SYNC,
      consecutiveFailures: 0,
      stale: false,
    });
    expect(normalizeHolidaySyncState(null)).toBeNull();
  });
});
