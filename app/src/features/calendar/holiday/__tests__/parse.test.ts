import { describe, expect, it } from 'vitest';

import {
  BUILTIN_HOLIDAY_PACKAGE,
  HOLIDAY_PACKAGE_2026,
  holidayOn,
} from '../../../../data/calendar/holidays';
import {
  HOLIDAY_SOURCE_DEFINITIONS,
  holidayPackageVersion,
  holidayRequestForYear,
  holidayRequestsForYear,
  parseChinaMainlandCalendarPayload,
  parseChineseDaysPayload,
  parseHolidayPayload,
  resolveHolidayTransports,
} from '../package';
import {
  HOLIDAY_SOURCE_IDS,
  HolidayNotPublishedError,
  HolidayParseError,
  HolidaySourceError,
  applyHolidaySourceChoice,
  holidaySourceChoice,
  normalizeHolidayPreferences,
  validateHolidayCustomUrl,
} from '../types';

const UPSTREAM_2026 = JSON.stringify({
  $schema:
    'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/schema.json',
  year: 2026,
  papers: ['https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm'],
  days: [
    { name: '元旦', date: '2026-01-01', isOffDay: true },
    { name: '元旦', date: '2026-01-04', isOffDay: false },
  ],
});

const CHINESE_DAYS_2026 = JSON.stringify({
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
  inLieuDays: {
    '2026-01-02': "New Year's Day,元旦,1",
  },
});

const ICS_2026 = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-CALNAME:中国大陆日历 2026',
  'BEGIN:VEVENT',
  'SUMMARY:元旦',
  'DTSTART;VALUE=DATE:20260101',
  'DTEND;VALUE=DATE:20260102',
  'CATEGORIES:法定节日',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:元旦休假',
  'DTSTART;VALUE=DATE:20260101',
  'DTEND;VALUE=DATE:20260104',
  'CATEGORIES:连续休假',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:元旦调休上班',
  'DTSTART;VALUE=DATE:20260104',
  'DTEND;VALUE=DATE:20260105',
  'CATEGORIES:调休补班',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:小寒',
  'DTSTART;VALUE=DATE:20260105',
  'DTEND;VALUE=DATE:20260106',
  'CATEGORIES:二十四节气',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:跨年事件',
  'DTSTART;VALUE=DATE:20251231',
  'DTEND;VALUE=DATE:20260101',
  'CATEGORIES:连续休假',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('节假日 JSON 解析', () => {
  it('解析 holiday-cn 官方格式并排序、去重同义重复', () => {
    const parsed = parseHolidayPayload(
      JSON.stringify({
        year: 2026,
        papers: ['https://example.com/notice'],
        days: [
          { name: '国庆', date: '2026-10-01', isOffDay: true },
          { name: '元旦', date: '2026-01-01', isOffDay: true },
          { name: '元旦', date: '2026-01-01', isOffDay: true },
        ],
      }),
      2026,
    );
    expect(parsed.year).toBe(2026);
    expect(parsed.days).toEqual([
      { name: '元旦', date: '2026-01-01', isOffDay: true },
      { name: '国庆', date: '2026-10-01', isOffDay: true },
    ]);
    expect(parsed.papers).toEqual(['https://example.com/notice']);
  });

  it('空 days 视为尚未公布，不是有效数据', () => {
    expect(() =>
      parseHolidayPayload(JSON.stringify({ year: 2027, days: [] }), 2027),
    ).toThrow(HolidayNotPublishedError);
    expect(() =>
      parseHolidayPayload(JSON.stringify({ year: 2027, days: [] }), 2027),
    ).toThrow('尚未公布');
  });

  it('拒绝坏 JSON、年份不匹配、跨年日期、同日冲突与坏 isOffDay', () => {
    expect(() => parseHolidayPayload('{oops', null)).toThrow(
      HolidayParseError,
    );
    expect(() =>
      parseHolidayPayload(JSON.stringify({ year: 2027, days: [] }), 2026),
    ).toThrow(HolidayParseError);
    expect(() =>
      parseHolidayPayload(
        JSON.stringify({
          year: 2026,
          days: [{ name: '假', date: '2026-02-30', isOffDay: true }],
        }),
        2026,
      ),
    ).toThrow('非法日期');
    expect(() =>
      parseHolidayPayload(
        JSON.stringify({
          year: 2026,
          days: [{ name: '假', date: '2025-12-31', isOffDay: true }],
        }),
        2026,
      ),
    ).toThrow('不属于');
    expect(() =>
      parseHolidayPayload(
        JSON.stringify({
          year: 2026,
          days: [
            { name: '假', date: '2026-02-01', isOffDay: true },
            { name: '假', date: '2026-02-01', isOffDay: false },
          ],
        }),
        2026,
      ),
    ).toThrow('既休又班');
    expect(() =>
      parseHolidayPayload(
        JSON.stringify({
          year: 2026,
          days: [{ name: '假', date: '2026-02-01', isOffDay: 'yes' }],
        }),
        2026,
      ),
    ).toThrow('非法 isOffDay');
    expect(() =>
      parseHolidayPayload(JSON.stringify({ year: 2026 }), 2026),
    ).toThrow('缺少 days');
  });

  it('内置 2026 回退与官方公告一致，且不伪造 2027', () => {
    expect(BUILTIN_HOLIDAY_PACKAGE.days).toHaveLength(39);
    expect(holidayOn('2026-10-01')?.kind).toBe('holiday');
    expect(holidayOn('2026-10-10')?.kind).toBe('makeup');
    expect(holidayOn('2027-01-01')).toBeNull();
    expect(HOLIDAY_PACKAGE_2026.version).toBe('2026.1');
  });

  it('远程版本优先 ETag，其次 Last-Modified，最后 fetchedAt', () => {
    expect(holidayPackageVersion('W/"abc"', null, '2026-11-01T00:00:00Z')).toBe(
      'abc',
    );
    expect(
      holidayPackageVersion(null, 'Sun, 01 Nov 2026 00:00:00 GMT', 'x'),
    ).toBe('Sun, 01 Nov 2026 00:00:00 GMT');
    expect(holidayPackageVersion(null, null, 'x')).toBe('x');
  });
});

describe('chinese-days 适配器', () => {
  it('holidays → 休、workdays → 班，名称取中文字段', () => {
    const parsed = parseChineseDaysPayload(CHINESE_DAYS_2026, 2026);
    expect(parsed.days).toHaveLength(7);
    expect(parsed.days.filter((day) => day.isOffDay)).toHaveLength(5);
    expect(parsed.days.filter((day) => !day.isOffDay)).toHaveLength(2);
    expect(parsed.days.find((day) => day.date === '2026-01-01')?.name).toBe(
      '元旦',
    );
    expect(parsed.days.find((day) => day.date === '2026-10-10')?.isOffDay).toBe(
      false,
    );
  });

  it('没有本年条目视为未公布；同日既休又班拒绝', () => {
    expect(() =>
      parseChineseDaysPayload(
        JSON.stringify({ holidays: {}, workdays: {} }),
        2027,
      ),
    ).toThrow(HolidayNotPublishedError);
    expect(() =>
      parseChineseDaysPayload(
        JSON.stringify({
          holidays: { '2026-01-01': 'A,元旦,1' },
          workdays: { '2026-01-01': 'A,元旦,1' },
        }),
        2026,
      ),
    ).toThrow('既休又班');
    expect(() =>
      parseChineseDaysPayload(
        JSON.stringify({ holidays: { '2026-01-01': 42 } }),
        2026,
      ),
    ).toThrow(HolidayParseError);
  });
});

describe('china-mainland-calendar ICS 适配器', () => {
  it('只取法定节日/连续休假/调休补班，DTEND 排他并忽略节气', () => {
    const parsed = parseChinaMainlandCalendarPayload(ICS_2026, 2026);
    expect(parsed.days.map((day) => [day.date, day.isOffDay])).toEqual([
      ['2026-01-01', true],
      ['2026-01-02', true],
      ['2026-01-03', true],
      ['2026-01-04', false],
    ]);
  });

  it('非 ICS / 没有本年事件 / 同一事件既休又班均明确报错', () => {
    expect(() =>
      parseChinaMainlandCalendarPayload('<html>', 2026),
    ).toThrow(HolidayParseError);
    expect(() =>
      parseChinaMainlandCalendarPayload(
        'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:节气\r\nDTSTART;VALUE=DATE:20260105\r\nCATEGORIES:二十四节气\r\nEND:VEVENT\r\nEND:VCALENDAR',
        2026,
      ),
    ).toThrow(HolidayNotPublishedError);
    expect(() =>
      parseChinaMainlandCalendarPayload(
        'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:冲突\r\nDTSTART;VALUE=DATE:20260101\r\nCATEGORIES:法定节日；调休补班\r\nEND:VEVENT\r\nEND:VCALENDAR',
        2026,
      ),
    ).toThrow('既休又班');
  });
});

describe('节假日源模型 v2', () => {
  it('恰好 3 个独立内置源，均 MIT；GitHub Raw 只是传输镜像', () => {
    expect(HOLIDAY_SOURCE_DEFINITIONS).toHaveLength(3);
    expect(HOLIDAY_SOURCE_DEFINITIONS.map((item) => item.id)).toEqual(
      HOLIDAY_SOURCE_IDS,
    );
    for (const source of HOLIDAY_SOURCE_DEFINITIONS) {
      expect(source.license).toBe('MIT');
      expect(source.independent).toBe(true);
      expect(source.priority).toBeGreaterThan(0);
    }
    const transportIds = HOLIDAY_SOURCE_DEFINITIONS.flatMap((source) =>
      source.transports.map((transport) => `${source.id}:${transport.id}`),
    );
    expect(transportIds).toContain('holiday-cn:github-raw');
    expect(transportIds).not.toContain('github-raw');
    expect(
      resolveHolidayTransports('holiday-cn', 'github-raw').map(
        (item) => item.mirror,
      ),
    ).toEqual([true]);
  });

  it('归一化字符串/对象旧值并迁移到新源 id', () => {
    expect(normalizeHolidayPreferences('github')).toMatchObject({
      mode: 'single',
      sourceId: 'holiday-cn',
      transport: 'github-raw',
      source: 'github',
      autoFallback: false,
    });
    expect(normalizeHolidayPreferences('jsdelivr')).toMatchObject({
      mode: 'single',
      sourceId: 'holiday-cn',
      transport: 'jsdelivr',
      source: 'jsdelivr',
    });
    expect(
      normalizeHolidayPreferences({
        source: 'custom',
        url: ' https://example.com/a.json ',
        autoSync: true,
      }),
    ).toMatchObject({
      mode: 'custom',
      customUrl: 'https://example.com/a.json',
      customFormat: 'holiday-cn-json',
      autoSync: true,
      source: 'custom',
    });
    expect(
      normalizeHolidayPreferences({
        source: 'custom',
        customUrl: 'https://example.com/a.ics',
      }),
    ).toMatchObject({ customFormat: 'ics' });
    expect(normalizeHolidayPreferences(undefined)).toMatchObject({
      mode: 'builtin',
      source: 'builtin',
    });
    expect(normalizeHolidayPreferences('乱写')).toMatchObject({
      mode: 'builtin',
      source: 'builtin',
    });
  });

  it('设置页选择可在自动、3 个源、内置与自定义之间切换', () => {
    let preferences = normalizeHolidayPreferences(undefined);
    preferences = applyHolidaySourceChoice(preferences, 'auto');
    expect(holidaySourceChoice(preferences)).toBe('auto');
    preferences = applyHolidaySourceChoice(preferences, 'chinese-days');
    expect(holidaySourceChoice(preferences)).toBe('chinese-days');
    expect(preferences).toMatchObject({
      mode: 'single',
      sourceId: 'chinese-days',
      source: 'jsdelivr',
    });
    preferences = applyHolidaySourceChoice(preferences, 'builtin');
    expect(holidaySourceChoice(preferences)).toBe('builtin');
    preferences = applyHolidaySourceChoice(preferences, 'custom');
    expect(holidaySourceChoice(preferences)).toBe('custom');
  });

  it('自定义 URL 只允许 http/https，拒绝内嵌凭据', () => {
    expect(
      validateHolidayCustomUrl(' https://example.com/h-{year}.json '),
    ).toBe('https://example.com/h-{year}.json');
    expect(() => validateHolidayCustomUrl('file:///etc/passwd')).toThrow(
      HolidaySourceError,
    );
    expect(() =>
      validateHolidayCustomUrl(
        'https://user:pass@example.com/a.json',
      ),
    ).toThrow('账号密码');
    expect(() => validateHolidayCustomUrl('  ')).toThrow('请填写');
  });

  it('按源/传输构造 URL；不覆盖年份返回 null；内置不联网', () => {
    const single = (
      sourceId: 'holiday-cn' | 'chinese-days' | 'china-mainland-calendar',
      transport: 'jsdelivr' | 'github-raw' | 'unpkg' | 'auto' = 'jsdelivr',
    ) => normalizeHolidayPreferences({ mode: 'single', sourceId, transport });

    expect(holidayRequestForYear(single('holiday-cn'), 2026)?.url).toBe(
      'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json',
    );
    expect(
      holidayRequestForYear(single('holiday-cn', 'github-raw'), 2027)?.url,
    ).toBe(
      'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2027.json',
    );
    expect(holidayRequestForYear(single('chinese-days'), 2026)?.url).toBe(
      'https://cdn.jsdelivr.net/npm/chinese-days@1.5.9/dist/years/2026.json',
    );
    expect(
      holidayRequestForYear(single('chinese-days', 'unpkg'), 2026)?.url,
    ).toBe(
      'https://unpkg.com/chinese-days@1.5.9/dist/years/2026.json',
    );
    expect(
      holidayRequestForYear(single('china-mainland-calendar'), 2026)?.url,
    ).toBe(
      'https://cdn.jsdelivr.net/gh/Lancetwang/china-mainland-calendar@main/china-mainland.ics',
    );
    expect(holidayRequestForYear(single('chinese-days'), 2027)).toBeNull();
    expect(
      holidayRequestForYear(single('china-mainland-calendar'), 2027),
    ).toBeNull();
    expect(
      holidayRequestForYear(normalizeHolidayPreferences('builtin'), 2026),
    ).toBeNull();
    expect(
      holidayRequestsForYear(
        single('holiday-cn', 'auto'),
        2026,
      ).map((item) => item.transport),
    ).toEqual(['jsdelivr', 'github-raw']);
    expect(
      holidayRequestForYear(
        normalizeHolidayPreferences({
          mode: 'custom',
          customUrl: 'https://example.com/all.json',
        }),
        2026,
      ),
    ).toMatchObject({ expectedYear: null, url: 'https://example.com/all.json' });
  });

  it('fixture 与上游 2026 结构一致', () => {
    const parsed = parseHolidayPayload(UPSTREAM_2026, 2026);
    expect(parsed.days.map((day) => day.date)).toEqual([
      '2026-01-01',
      '2026-01-04',
    ]);
    expect(parsed.papers).toHaveLength(1);
  });
});
