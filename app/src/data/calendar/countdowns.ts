/**
 * 倒数日纯计算。
 *
 * 规则（与 PRD §3.6.7 一致）：
 * - 单次：目标日 - 今天，可为负数；过去显示「已过去 N 天」。
 * - 每年（公历）：取今年目标月/日，已过则取明年；2 月 29 日按构造日期滚动。
 * - 每年（农历）：从今天起最多扫描 400 天，跳过闰月；找不到退回原日期。
 * 倒数日不进入任务/收件箱/今天，也不产生完成状态。
 */

import type { CalendarType, Countdown } from '../db/types';
import {
  diffDays,
  formatISO,
  isValidISODate,
  parseISODate,
} from './date';
import {
  formatLunarText,
  lunarDayLabel,
  lunarInfo,
  nextLunarDate,
} from './lunar';

export const COUNTDOWN_CATEGORIES = [
  '纪念日·生日',
  '节假日',
  '热门节日',
  '节气',
  '自定义',
] as const;

export type CountdownCategory = (typeof COUNTDOWN_CATEGORIES)[number];

export const COUNTDOWN_REPEAT_RULES = ['单次', '每年', '每年（农历）'] as const;

export const DEFAULT_COUNTDOWN_CATEGORY: CountdownCategory = '自定义';

export type CountdownLike = Pick<
  Countdown,
  'calendarType' | 'targetDate' | 'repeatRule' | 'lunarMonth' | 'lunarDay'
>;

export function normalizeCalendarType(value: string): CalendarType {
  return value === 'lunar' ? 'lunar' : 'solar';
}

export function normalizeCountdownCategory(value: string): CountdownCategory {
  return (COUNTDOWN_CATEGORIES as readonly string[]).includes(value)
    ? (value as CountdownCategory)
    : DEFAULT_COUNTDOWN_CATEGORY;
}

/** 历法与重复组合收敛：农历的「每年」保存为「每年（农历）」。 */
export function normalizeCountdownRepeat(
  calendarType: CalendarType,
  repeatRule: string,
): string {
  if (calendarType === 'lunar') {
    return repeatRule.includes('每年') ? '每年（农历）' : '单次';
  }
  return repeatRule.includes('每年') ? '每年' : '单次';
}

export function isLunarYearly(countdown: CountdownLike): boolean {
  const repeat = countdown.repeatRule ?? '';
  return (
    repeat.includes('农历') ||
    (countdown.calendarType === 'lunar' && repeat.includes('每年'))
  );
}

export function resolveCountdownLunar(
  countdown: CountdownLike,
): { month: string; day: number } | null {
  if (countdown.lunarMonth && countdown.lunarDay) {
    return { month: countdown.lunarMonth, day: countdown.lunarDay };
  }
  const info = lunarInfo(countdown.targetDate);
  return info ? { month: info.month, day: info.day } : null;
}

/** 从公历日期派生农历月/日，供倒数日表单保存。 */
export function deriveLunarFields(
  date: string,
): { lunarMonth: string; lunarDay: number } | null {
  const info = lunarInfo(date);
  return info ? { lunarMonth: info.month, lunarDay: info.day } : null;
}

function nextSolarDate(targetDate: string, today: string): string {
  if (!isValidISODate(targetDate) || !isValidISODate(today)) {
    return targetDate;
  }
  const target = parseISODate(targetDate);
  const month = target.getMonth() + 1;
  const day = target.getDate();
  let year = parseISODate(today).getFullYear();
  for (let guard = 0; guard < 9; guard += 1) {
    const candidate = new Date(year, month - 1, day);
    const iso = formatISO(candidate);
    if (iso >= today) {
      return iso;
    }
    year += 1;
  }
  return targetDate;
}

/** 倒数日在日历上出现的公历日。 */
export function nextCountdownDate(
  countdown: CountdownLike,
  today: string,
): string {
  if (isLunarYearly(countdown)) {
    const lunar = resolveCountdownLunar(countdown);
    if (lunar) {
      const next = nextLunarDate(lunar.month, lunar.day, today);
      if (next) {
        return next;
      }
    }
    return countdown.targetDate;
  }

  if ((countdown.repeatRule ?? '').includes('每年')) {
    return nextSolarDate(countdown.targetDate, today);
  }

  return countdown.targetDate;
}

/** 正数=还有 N 天；0=今天；负数=已过去 N 天。 */
export function countdownDays(countdown: CountdownLike, today: string): number {
  return diffDays(today, nextCountdownDate(countdown, today));
}

export function countdownDayLabel(
  countdown: CountdownLike,
  today: string,
): string {
  const days = countdownDays(countdown, today);
  if (days < 0) {
    return `已过去 ${Math.abs(days)} 天`;
  }
  if (days === 0) {
    return '就是今天';
  }
  return `还有 ${days} 天`;
}

export type CountdownTone = 'past' | 'soon' | 'future';

export function countdownTone(
  countdown: CountdownLike,
  today: string,
): CountdownTone {
  const days = countdownDays(countdown, today);
  if (days < 0) {
    return 'past';
  }
  return days <= 7 ? 'soon' : 'future';
}

export function sortCountdowns<T extends CountdownLike>(
  countdowns: T[],
  today: string,
): T[] {
  return [...countdowns].sort((a, b) => {
    const delta = countdownDays(a, today) - countdownDays(b, today);
    if (delta !== 0) {
      return delta;
    }
    return a.targetDate.localeCompare(b.targetDate);
  });
}

/** 例：农历 正月初一 · 2027-02-07 · 每年（农历） · 热门节日。 */
export function countdownMetaText(
  countdown: CountdownLike & { category?: string },
  today: string,
): string {
  const parts: string[] = [];
  if (isLunarYearly(countdown) || countdown.calendarType === 'lunar') {
    const lunar = resolveCountdownLunar(countdown);
    if (lunar) {
      parts.push(
        `农历 ${lunar.month}${lunarDayLabel(lunar.day)}`,
      );
    }
  }
  parts.push(nextCountdownDate(countdown, today));
  parts.push(countdown.repeatRule || '单次');
  if (countdown.category) {
    parts.push(countdown.category);
  }
  return parts.join(' · ');
}

/** 农历转换工具的结果文案。 */
export function lunarConversionText(date: string): string {
  const info = lunarInfo(date);
  if (!info) {
    return '农历数据暂不可用';
  }
  return `${formatLunarText(date, {
    includeYear: true,
    includeZodiac: true,
  })}`;
}
