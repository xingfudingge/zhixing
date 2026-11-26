/**
 * 2026 年中国法定节假日 / 调休上班数据包。
 *
 * 数据来源：国务院办公厅 2026 年部分节假日安排（内置包，离线可读）。
 * 只影响日历标记与工作日计算，不改变任务日期、倒数日计算或提醒时区。
 */

import { addDaysISO } from './date';
import type { DateException } from './exceptions';
import { lunarDayLabel, lunarInfo, type LunarInfo } from './lunar';
import { solarTermOn } from './terms';

export type HolidayKind = 'holiday' | 'makeup';

export type HolidayEntry = {
  date: string;
  name: string;
  kind: HolidayKind;
  /** 月格短标：休 / 班。 */
  label: '休' | '班';
};

/**
 * 上游 holiday-cn 的日粒度数据。
 *
 * 与 `HolidayEntry` 的差别：这里保留 `isOffDay` 原义，方便直接校验远程 JSON；
 * `HolidayEntry` 是日历渲染用的派生物。
 */
export type HolidayDay = {
  date: string;
  name: string;
  isOffDay: boolean;
};

/**
 * 一个年份的节假日数据包。
 *
 * `origin=builtin` 表示随应用发布的离线回退包；`remote` 表示用户同步得到的缓存。
 * `version` 来自上游 ETag / Last-Modified，内置包使用人工版本号。
 */
export type HolidayPackage = {
  year: number;
  days: HolidayDay[];
  source: string;
  version: string;
  origin: 'builtin' | 'remote';
  fetchedAt: string | null;
  papers: string[];
};

/** 工作日/日历标记查询函数；不传时使用内置 2026 包。 */
export type HolidayLookup = (date: string) => HolidayEntry | null;

export type DayMeta = {
  date: string;
  lunar: LunarInfo | null;
  /** 节气优先，否则农历日序（初一…三十）。 */
  lunarLabel: string;
  solarTerm: string | null;
  holiday: HolidayEntry | null;
  /** 个人日期例外；优先于 `holiday` 参与工作日计算。 */
  exception: DateException | null;
};

type HolidayRange = {
  name: string;
  start: string;
  end: string;
};

type MakeupDay = {
  date: string;
  name: string;
};

const HOLIDAY_RANGES_2026: HolidayRange[] = [
  { name: '元旦', start: '2026-01-01', end: '2026-01-03' },
  { name: '春节', start: '2026-02-15', end: '2026-02-23' },
  { name: '清明', start: '2026-04-04', end: '2026-04-06' },
  { name: '劳动节', start: '2026-05-01', end: '2026-05-05' },
  { name: '端午', start: '2026-06-19', end: '2026-06-21' },
  { name: '中秋', start: '2026-09-25', end: '2026-09-27' },
  { name: '国庆', start: '2026-10-01', end: '2026-10-07' },
];

const MAKEUP_DAYS_2026: MakeupDay[] = [
  { date: '2026-01-04', name: '元旦调休上班' },
  { date: '2026-02-14', name: '春节调休上班' },
  { date: '2026-02-28', name: '春节调休上班' },
  { date: '2026-05-09', name: '劳动节调休上班' },
  { date: '2026-09-20', name: '国庆调休上班' },
  { date: '2026-10-10', name: '国庆调休上班' },
];

function expandHolidayDays(): HolidayDay[] {
  const days: HolidayDay[] = [];
  for (const range of HOLIDAY_RANGES_2026) {
    let date = range.start;
    while (date <= range.end) {
      days.push({ date, name: range.name, isOffDay: true });
      date = addDaysISO(date, 1);
    }
  }
  for (const day of MAKEUP_DAYS_2026) {
    days.push({ date: day.date, name: day.name, isOffDay: false });
  }
  return days;
}

export const BUILTIN_HOLIDAY_DAYS_2026: readonly HolidayDay[] =
  expandHolidayDays();

export const HOLIDAY_PACKAGE_2026 = {
  year: 2026,
  source: '国务院办公厅 2026 年节假日安排',
  version: '2026.1',
  papers: [
    'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm',
  ],
  holidays: HOLIDAY_RANGES_2026,
  makeupDays: MAKEUP_DAYS_2026,
} as const;

/** 随应用发布、离线可读的 2026 回退包；远程 2026 包可用时按年覆盖。 */
export const BUILTIN_HOLIDAY_PACKAGE: HolidayPackage = {
  year: HOLIDAY_PACKAGE_2026.year,
  days: [...BUILTIN_HOLIDAY_DAYS_2026],
  source: 'builtin',
  version: HOLIDAY_PACKAGE_2026.version,
  origin: 'builtin',
  fetchedAt: null,
  papers: [...HOLIDAY_PACKAGE_2026.papers],
};

export const BUILTIN_HOLIDAY_PACKAGES: readonly HolidayPackage[] = [
  BUILTIN_HOLIDAY_PACKAGE,
];

export function holidayEntryFromDay(day: HolidayDay): HolidayEntry {
  return {
    date: day.date,
    name: day.name,
    kind: day.isOffDay ? 'holiday' : 'makeup',
    label: day.isOffDay ? '休' : '班',
  };
}

function buildHolidayMap(days: readonly HolidayDay[]): Map<string, HolidayEntry> {
  return new Map(
    days.map((day) => [day.date, holidayEntryFromDay(day)] as const),
  );
}

const holidayMap = buildHolidayMap(BUILTIN_HOLIDAY_DAYS_2026);

/** 内置包查询；可作为 `HolidayLookup` 直接传入纯函数。 */
export const builtinHolidayLookup: HolidayLookup = (date) =>
  holidayMap.get(date) ?? null;

/**
 * 合并多个数据包，构造查询函数。
 *
 * - 同一个年份出现远程包时，该年以内置包之外的远程数据为准（远程是权威）；
 * - 没有远程包的年份继续使用内置 2026 回退，跨年查询不会突然变空；
 * - 2027 未公布时上游返回空包，同步层会拒绝写入，这里不会出现空年份覆盖。
 */
export function createHolidayLookup(
  packages: readonly HolidayPackage[],
): HolidayLookup {
  if (packages.length === 0) {
    return builtinHolidayLookup;
  }
  const remoteYears = new Set(packages.map((item) => item.year));
  const map = new Map<string, HolidayEntry>();
  for (const [date, entry] of holidayMap) {
    const year = Number(date.slice(0, 4));
    if (!remoteYears.has(year)) {
      map.set(date, entry);
    }
  }
  for (const pack of packages) {
    for (const day of pack.days) {
      map.set(day.date, holidayEntryFromDay(day));
    }
  }
  return (date) => map.get(date) ?? null;
}

export function holidayOn(
  date: string,
  lookup: HolidayLookup | null = null,
): HolidayEntry | null {
  return (lookup ?? builtinHolidayLookup)(date);
}

export function dayMeta(
  date: string,
  options: {
    holidayLookup?: HolidayLookup | null;
    exception?: DateException | null;
  } = {},
): DayMeta {
  const lunar = lunarInfo(date);
  const solarTerm = solarTermOn(date);
  return {
    date,
    lunar,
    lunarLabel:
      solarTerm ?? (lunar ? lunarDayLabel(lunar.day) : ''),
    solarTerm,
    holiday: holidayOn(date, options.holidayLookup ?? null),
    exception: options.exception ?? null,
  };
}

export function holidaySummary(
  date: string,
  lookup: HolidayLookup | null = null,
): string {
  const holiday = holidayOn(date, lookup);
  if (!holiday) {
    return '';
  }
  return `${holiday.name} · ${holiday.label}`;
}
