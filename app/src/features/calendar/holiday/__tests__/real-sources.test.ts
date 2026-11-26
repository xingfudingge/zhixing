/**
 * 真实 HTTP 契约测试（默认跳过，避免 CI 依赖公网）。
 *
 *   HOLIDAY_REAL_HTTP=1 pnpm --filter app exec vitest run \
 *     src/features/calendar/holiday/__tests__/real-sources.test.ts
 *
 * 断言 3 个独立内置源的 2026 休/班日期集合逐日一致（33 休 + 6 班）。
 * 只读取数据，不依赖 CSS/CORS；浏览器直连与 Rust 代理的传输问题
 * 由 ZX12-CAL-SYNC-02 的桌面冒烟覆盖。
 */

import { describe, expect, it } from 'vitest';

import {
  parseChinaMainlandCalendarPayload,
  parseChineseDaysPayload,
  parseHolidayPayload,
  resolveHolidayTransports,
} from '../package';
import type { HolidaySourceId } from '../types';

const RUN = process.env.HOLIDAY_REAL_HTTP === '1';
const describeReal = RUN ? describe : describe.skip;

function primaryUrl(sourceId: HolidaySourceId): string {
  const transport = resolveHolidayTransports(sourceId, 'auto')[0]!;
  return transport.urlTemplate.replaceAll('{year}', '2026');
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { accept: 'application/json, text/calendar, text/plain' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}`);
  }
  return response.text();
}

function offDates(days: ReadonlyArray<{ date: string; isOffDay: boolean }>) {
  return days
    .filter((day) => day.isOffDay)
    .map((day) => day.date)
    .sort();
}

function workDates(days: ReadonlyArray<{ date: string; isOffDay: boolean }>) {
  return days
    .filter((day) => !day.isOffDay)
    .map((day) => day.date)
    .sort();
}

describeReal('真实 HTTP 节假日源契约', () => {
  it(
    'holiday-cn / chinese-days / china-mainland-calendar 的 2026 逐日一致',
    async () => {
      const [aText, bText, cText] = await Promise.all([
        fetchText(primaryUrl('holiday-cn')),
        fetchText(primaryUrl('chinese-days')),
        fetchText(primaryUrl('china-mainland-calendar')),
      ]);
      const a = parseHolidayPayload(aText, 2026);
      const b = parseChineseDaysPayload(bText, 2026);
      const c = parseChinaMainlandCalendarPayload(cText, 2026);

      for (const parsed of [a, b, c]) {
        expect(parsed.year).toBe(2026);
        expect(parsed.days).toHaveLength(39);
        expect(parsed.days.filter((day) => day.isOffDay)).toHaveLength(33);
        expect(parsed.days.filter((day) => !day.isOffDay)).toHaveLength(6);
      }
      expect(offDates(b.days)).toEqual(offDates(a.days));
      expect(offDates(c.days)).toEqual(offDates(a.days));
      expect(workDates(b.days)).toEqual(workDates(a.days));
      expect(workDates(c.days)).toEqual(workDates(a.days));
    },
    60_000,
  );
});
