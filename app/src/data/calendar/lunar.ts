/**
 * 中国农历换算（公历 -> 农历 / 下一次农历月日）。
 *
 * 基于浏览器/Node 的 `Intl` 中国农历日历，离线可用，不依赖网络。
 * - 不把农历年份/月名长文本放进月格；月格只取「初几/廿几」或节气。
 * - 每年（农历）倒数日从今天起最多扫描 400 天，跳过闰月（原型边界）。
 */

import { addDaysISO, isValidISODate, parseISODate } from './date';

export type LunarInfo = {
  /** 规范化后的月名，例如 正月 / 二月 / 十一月 / 腊月。 */
  month: string;
  /** Intl 原始月名，可能是「闰六月」。 */
  monthRaw: string;
  leap: boolean;
  day: number;
  yearName: string;
  /** 农历年对应的公历年份（用于生肖）。 */
  relatedYear: number;
  zodiac: string;
};

const ZODIAC = [
  '鼠',
  '牛',
  '虎',
  '兔',
  '龙',
  '蛇',
  '马',
  '羊',
  '猴',
  '鸡',
  '狗',
  '猪',
] as const;

const LUNAR_DAY_DIGITS = [
  '',
  '一',
  '二',
  '三',
  '四',
  '五',
  '六',
  '七',
  '八',
  '九',
  '十',
] as const;

const lunarCache = new Map<string, LunarInfo | null>();
const nextLunarCache = new Map<string, string | null>();

let formatter: Intl.DateTimeFormat | null = null;

function chineseFormatter(): Intl.DateTimeFormat | null {
  if (formatter) {
    return formatter;
  }
  try {
    formatter = new Intl.DateTimeFormat('zh-u-ca-chinese', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    return formatter;
  } catch {
    return null;
  }
}

export function zodiacForYear(year: number): string {
  return ZODIAC[((Math.trunc(year) - 4) % 12 + 12) % 12];
}

/** 腊月/十二月、十一月/冬月 混用时的统一比较值。 */
export function normalizeLunarMonth(month: string): string {
  return month
    .replace(/^闰/, '')
    .replace(/^十二月$/, '腊月')
    .replace(/^冬月$/, '十一月')
    .replace(/^元月$/, '正月');
}

export function lunarDayLabel(day: number): string {
  if (!Number.isInteger(day) || day < 1 || day > 30) {
    return '';
  }
  if (day <= 10) {
    return `初${LUNAR_DAY_DIGITS[day]}`;
  }
  if (day < 20) {
    return `十${LUNAR_DAY_DIGITS[day - 10]}`;
  }
  if (day === 20) {
    return '二十';
  }
  if (day < 30) {
    return `廿${LUNAR_DAY_DIGITS[day - 20]}`;
  }
  return '三十';
}

export function lunarInfo(date: string): LunarInfo | null {
  if (!isValidISODate(date)) {
    return null;
  }
  if (lunarCache.has(date)) {
    return lunarCache.get(date) ?? null;
  }

  const instance = chineseFormatter();
  if (!instance) {
    lunarCache.set(date, null);
    return null;
  }

  try {
    const parsed = parseISODate(date);
    // 中午保证不会因时区跨日；Intl 的中国农历按本地日期解释。
    const noon = new Date(
      parsed.getFullYear(),
      parsed.getMonth(),
      parsed.getDate(),
      12,
    );
    // TS 的 DateTimeFormatPartTypesRegistry 尚未包含 yearName/relatedYear，
    // 但浏览器与 Node 的 Intl 中国农历会返回这两个 part。
    const parts = instance.formatToParts(noon) as unknown as Array<{
      type: string;
      value: string;
    }>;
    const monthRaw = parts.find((part) => part.type === 'month')?.value ?? '';
    const day = Number(parts.find((part) => part.type === 'day')?.value ?? 0);
    const yearName =
      parts.find((part) => part.type === 'yearName')?.value ?? '';
    const relatedYear = Number(
      parts.find((part) => part.type === 'relatedYear')?.value ?? 0,
    );
    if (!monthRaw || !Number.isInteger(day) || day < 1) {
      lunarCache.set(date, null);
      return null;
    }
    const info: LunarInfo = {
      month: normalizeLunarMonth(monthRaw),
      monthRaw,
      leap: monthRaw.startsWith('闰'),
      day,
      yearName,
      relatedYear,
      zodiac: relatedYear ? zodiacForYear(relatedYear) : '',
    };
    lunarCache.set(date, info);
    return info;
  } catch {
    lunarCache.set(date, null);
    return null;
  }
}

/** 下一次（含今天）非闰月的同农历月日；最多扫描 400 天。 */
export function nextLunarDate(
  month: string,
  day: number,
  from: string,
): string | null {
  const targetMonth = normalizeLunarMonth(month);
  if (!targetMonth || !Number.isInteger(day) || day < 1 || day > 30) {
    return null;
  }
  const cacheKey = `${targetMonth}|${day}|${from}`;
  if (nextLunarCache.has(cacheKey)) {
    return nextLunarCache.get(cacheKey) ?? null;
  }
  for (let offset = 0; offset < 400; offset += 1) {
    const date = addDaysISO(from, offset);
    const info = lunarInfo(date);
    if (
      info &&
      !info.leap &&
      normalizeLunarMonth(info.month) === targetMonth &&
      info.day === day
    ) {
      nextLunarCache.set(cacheKey, date);
      return date;
    }
  }
  nextLunarCache.set(cacheKey, null);
  return null;
}

export type LunarTextOptions = {
  includeYear?: boolean;
  includeZodiac?: boolean;
};

/** 例：丙午年 正月初一 · 生肖马。 */
export function formatLunarText(
  date: string,
  options: LunarTextOptions = {},
): string {
  const info = lunarInfo(date);
  if (!info) {
    return '农历数据暂不可用';
  }
  const parts: string[] = [];
  if (options.includeYear && info.yearName) {
    parts.push(`${info.yearName}年`);
  }
  parts.push(`${info.monthRaw}${lunarDayLabel(info.day)}`);
  if (options.includeZodiac && info.zodiac) {
    parts.push(`生肖${info.zodiac}`);
  }
  return parts.join(' ');
}
