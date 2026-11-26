/**
 * 真实源二次同步 304 契约（默认跳过，避免 CI 依赖公网）。
 *
 *   HOLIDAY_REAL_HTTP=1 pnpm --filter app exec vitest run \
 *     src/features/calendar/holiday/__tests__/real-304.test.ts
 *
 * 这里用产品自己的 HolidaySyncService 连续同步两次，确认：
 * - 第一次真实 200 并写入 ETag；
 * - 第二次请求真的带 If-None-Match 到源，源返回 304；
 * - 304 不重写缓存，只更新 lastSyncAt/lastAttemptAt。
 *
 * 浏览器 CORS 分支与桌面 Rust 代理分别由 browser/desktop 探针覆盖；
 * 本测试验证上游契约与同步状态机，不依赖 WebView。
 */

import { describe, expect, it } from 'vitest';

import { MemoryHolidayPackageStore } from '../store';
import { HolidaySyncService } from '../sync';
import { normalizeHolidayPreferences, type HolidaySourceId } from '../types';

const RUN = process.env.HOLIDAY_REAL_HTTP === '1';
const describeReal = RUN ? describe : describe.skip;

const NOW = new Date(2026, 10, 1, 12, 0, 0);
const SOURCES: HolidaySourceId[] = [
  'holiday-cn',
  'chinese-days',
  'china-mainland-calendar',
];

const URLS: Record<HolidaySourceId, string> = {
  'holiday-cn':
    'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json',
  'chinese-days':
    'https://cdn.jsdelivr.net/npm/chinese-days@1.5.9/dist/years/2026.json',
  'china-mainland-calendar':
    'https://cdn.jsdelivr.net/gh/Lancetwang/china-mainland-calendar@main/china-mainland.ics',
};

describeReal('真实源二次同步 304（ZX12-FIX-304-01）', () => {
  it.each(SOURCES)('%s 第二次同步收到真实 304 且不重写缓存', async (sourceId) => {
    const store = new MemoryHolidayPackageStore();
    const requests: Array<{
      url: string;
      ifNoneMatch: string | null;
      status: number;
    }> = [];
    const fetchImpl = async (input: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const ifNoneMatch = headers.get('if-none-match');
      const response = await fetch(input, {
        ...init,
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      requests.push({ url: input, ifNoneMatch, status: response.status });
      return response;
    };
    const service = new HolidaySyncService({
      store,
      fetchImpl,
      now: () => NOW,
      timeoutMs: 30_000,
      targetYears: () => [2026],
    });
    const preferences = normalizeHolidayPreferences({
      mode: 'single',
      sourceId,
      transport: 'jsdelivr',
      autoFallback: false,
    });

    const first = await service.sync(preferences);
    expect(first.fetchedYears).toEqual([2026]);
    expect(first.notModified).toBe(false);
    expect(first.packages[0]?.days.length).toBeGreaterThanOrEqual(5);
    const record = await store.getRecord(sourceId, 'jsdelivr', 2026);
    expect(record?.etag ?? record?.lastModified).toBeTruthy();
    const firstFetchedAt = record?.fetchedAt;
    const firstVersion = record?.package.version;

    const second = await service.sync(preferences);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(URLS[sourceId]);
    expect(requests[0]?.status).toBe(200);
    expect(requests[1]?.url).toBe(URLS[sourceId]);
    expect(requests[1]?.ifNoneMatch).toBe(record?.etag ?? null);
    expect(requests[1]?.status).toBe(304);
    expect(second.notModified).toBe(true);
    expect(second.fetchedYears).toEqual([]);
    expect(second.state.lastSyncAt).toBe(NOW.toISOString());
    expect(second.state.lastAttemptAt).toBe(NOW.toISOString());
    expect(second.state.lastError).toBeNull();
    expect(second.packages[0]?.version).toBe(firstVersion);

    const after = await store.getRecord(sourceId, 'jsdelivr', 2026);
    expect(after?.etag).toBe(record?.etag);
    expect(after?.fetchedAt).toBe(firstFetchedAt);
    expect(after?.package.version).toBe(firstVersion);
  }, 120_000);
});
