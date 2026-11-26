/**
 * 日历域的纯日期工具。
 *
 * 全部使用本地日历日 `YYYY-MM-DD`，不经过 UTC 切日；
 * 周一是一周的第一天，与 PRD 的月/周视图一致。
 */

export const WEEKDAYS = [
  '周日',
  '周一',
  '周二',
  '周三',
  '周四',
  '周五',
  '周六',
] as const;

/** 月视图列头：周一开头。 */
export const MONDAY_FIRST_WEEKDAYS = [
  '周一',
  '周二',
  '周三',
  '周四',
  '周五',
  '周六',
  '周日',
] as const;

export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function isValidISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

export function formatISO(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate(),
  )}`;
}

export function todayISO(now = new Date()): string {
  return formatISO(now);
}

/** 解析为本地零点，避免 `new Date('YYYY-MM-DD')` 被当作 UTC。 */
export function parseISODate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function addDaysISO(value: string, days: number): string {
  const date = parseISODate(value);
  date.setDate(date.getDate() + days);
  return formatISO(date);
}

/** b - a，按自然日计算。 */
export function diffDays(a: string, b: string): number {
  const ms = parseISODate(b).getTime() - parseISODate(a).getTime();
  return Math.round(ms / 86_400_000);
}

/** 按「月」移动，月末自动收敛（1 月 31 日 + 1 月 = 2 月 28 日）。 */
export function addMonthsISO(value: string, months: number): string {
  const date = parseISODate(value);
  const day = date.getDate();
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(
    target.getFullYear(),
    target.getMonth() + 1,
    0,
  ).getDate();
  target.setDate(Math.min(day, lastDay));
  return formatISO(target);
}

export function monthKeyOf(value: string): string {
  return value.slice(0, 7);
}

/** 周一为一周起点。 */
export function startOfWeekISO(value: string): string {
  const date = parseISODate(value);
  const offset = (date.getDay() + 6) % 7;
  return addDaysISO(value, -offset);
}

export function weekDaysISO(value: string): string[] {
  const start = startOfWeekISO(value);
  return Array.from({ length: 7 }, (_, index) => addDaysISO(start, index));
}

export type MonthGridCell = {
  date: string;
  inMonth: boolean;
};

/** 固定 6×7，共 42 格；周一开头。 */
export function monthGrid(monthKey: string): MonthGridCell[] {
  const [year, month] = monthKey.split('-').map(Number);
  const first = new Date(year, month - 1, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month - 1, 1 - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + index,
    );
    return {
      date: formatISO(date),
      inMonth: formatISO(date).startsWith(monthKey),
    };
  });
}

/** ISO 周序（周一为首日）；用于月格上的「第 N 周」。 */
export function isoWeekNumber(value: string): number {
  const date = parseISODate(value);
  const target = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  return (
    1 +
    Math.round(
      (target.getTime() - firstThursday.getTime()) / (7 * 86_400_000),
    )
  );
}

export function formatMonthTitle(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  return `${year} 年 ${month} 月`;
}

export function formatMonthDay(value: string): string {
  const date = parseISODate(value);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatMonthDayWithYear(value: string): string {
  const date = parseISODate(value);
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function formatWeekday(value: string): string {
  return WEEKDAYS[parseISODate(value).getDay()];
}

/** 日视图标题：10月26日 周一。 */
export function formatDayTitle(value: string): string {
  return `${formatMonthDay(value)} ${formatWeekday(value)}`;
}

/** 周视图标题：10月26日 – 11月1日。 */
export function formatWeekRange(value: string): string {
  const days = weekDaysISO(value);
  return `${formatMonthDay(days[0])} – ${formatMonthDay(days[6])}`;
}

export function isWeekend(value: string): boolean {
  const day = parseISODate(value).getDay();
  return day === 0 || day === 6;
}

/** HH:mm -> 分钟数；非法值返回 null。 */
export function timeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

export function minutesToTime(value: number): string {
  const normalized = ((value % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`;
}

export function compareTime(a: string | null, b: string | null): number {
  const left = a === null ? Number.POSITIVE_INFINITY : timeToMinutes(a) ?? 0;
  const right = b === null ? Number.POSITIVE_INFINITY : timeToMinutes(b) ?? 0;
  return left - right;
}
