/**
 * 周起始与工作日规则的唯一计算入口。
 *
 * 日历月/周/日视图、任务中心的「本周」分组、统一日期选择器都从这里取
 * `startOfWeekISO` / `weekDaysISO` / `monthGrid` / `isWorkday`，不允许各页面
 * 复制「周一固定」或节假日判断。
 *
 * 约定：
 * - 日期字符串始终是本地日历日 `YYYY-MM-DD`，不经过 UTC 切日；
 * - ISO 周号仍按周一计算，避免周起始改成周日时周号语义漂移；
 * - 工作日优先级：个人日期例外（CAL-HOLIDAY-01）>
 *   法定节假日/调休 > 周规则；
 * - 本模块不读全局状态；设置值由调用方显式传入。远程节假日包通过
 *   `holidayLookup` 注入，内置包仍是默认回退。
 */

import {
  dateExceptionOn,
  type DateException,
  type DateExceptionKind,
} from '../../data/calendar/exceptions';
import {
  addDaysISO,
  diffDays,
  formatISO,
  isValidISODate,
  isoWeekNumber,
  monthKeyOf,
  parseISODate,
  WEEKDAYS,
  type MonthGridCell,
} from '../../data/calendar/date';
import { holidayOn, type HolidayLookup } from '../../data/calendar/holidays';

export type {
  DateException,
  DateExceptionKind,
}; // 设置仓储/日历视图共用同一类型。

export type WeekStart = 'monday' | 'sunday';

export type WorkdayRuleKind =
  | 'double'
  | 'single'
  | 'alternating'
  | 'custom';

/**
 * 工作日规则。
 *
 * `anchorMonday` 是「大小周」的基准周一：该周为双休周，下一周为单休周。
 * 为空时使用固定的 1970-01-05（周一）作为基准，保证同一日期永远算出同一结果。
 * `customWorkdays` 使用 ISO 周几：1=周一 … 7=周日。
 */
export type WorkdayRule = {
  rule: WorkdayRuleKind;
  anchorMonday: string | null;
  customWorkdays: number[];
};

export type WorkdayStatus =
  | 'workday'
  | 'rest'
  | 'holiday'
  | 'makeup'
  | 'exception-work'
  | 'exception-rest';

export type WorkdayOptions = {
  /** 是否让内置/远程法定节假日与调休覆盖周规则，默认 true。 */
  officialHolidays?: boolean;
  /** 个人日期例外；优先级最高。 */
  exceptions?: readonly DateException[] | null;
  /** 当前激活的节假日包查询；不传时使用内置 2026 回退。 */
  holidayLookup?: HolidayLookup | null;
};

export const DEFAULT_WORKDAY_RULE: WorkdayRule = {
  rule: 'double',
  anchorMonday: null,
  customWorkdays: [1, 2, 3, 4, 5],
};

export const WEEK_START_OPTIONS: ReadonlyArray<{
  value: WeekStart;
  label: string;
}> = [
  { value: 'monday', label: '周一' },
  { value: 'sunday', label: '周日' },
];

export const WORKDAY_RULE_OPTIONS: ReadonlyArray<{
  value: WorkdayRuleKind;
  label: string;
}> = [
  { value: 'double', label: '双休（周一至周五）' },
  { value: 'single', label: '单休（周一至周六）' },
  { value: 'alternating', label: '大小周（一周双休、一周单休）' },
  { value: 'custom', label: '自定义' },
];

export const WEEKDAY_OPTIONS: ReadonlyArray<{
  value: number;
  label: string;
}> = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
];

/** 大小周无锚点时的固定基准周一。 */
export const ALTERNATING_EPOCH_MONDAY = '1970-01-05';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 接受 `monday/sunday`、`mon/sun`、1/0、周一周日文案；非法值回退周一。 */
export function normalizeWeekStart(value: unknown): WeekStart {
  if (value === 0 || value === '0') {
    return 'sunday';
  }
  if (value === 1 || value === '1') {
    return 'monday';
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (
      text === 'sunday' ||
      text === 'sun' ||
      text === '周日' ||
      text === '星期日' ||
      text === '周天'
    ) {
      return 'sunday';
    }
  }
  return 'monday';
}

/** 周起始的数字形式：周一=1，周日=0（与 date-fns weekStartsOn 语义一致）。 */
export function weekStartsOnValue(weekStart: WeekStart): 0 | 1 {
  return weekStart === 'sunday' ? 0 : 1;
}

/** 当前周起始下的 JS 周几顺序（0=周日 … 6=周六）。 */
export function weekdayOrder(weekStart: WeekStart): number[] {
  return weekStart === 'sunday'
    ? [0, 1, 2, 3, 4, 5, 6]
    : [1, 2, 3, 4, 5, 6, 0];
}

/** 当前周起始下的列头/按钮文案，例：周一 … 周日。 */
export function weekdayLabels(weekStart: WeekStart): string[] {
  return weekdayOrder(weekStart).map((day) => WEEKDAYS[day]);
}

function normalizeRuleKind(value: unknown): WorkdayRuleKind {
  if (typeof value !== 'string') {
    return 'double';
  }
  const text = value.trim().toLowerCase();
  if (
    text === 'single' ||
    text === '单休' ||
    text === 'six-day' ||
    text === 'sixday' ||
    text === '6'
  ) {
    return 'single';
  }
  if (
    text === 'alternating' ||
    text === 'alternate' ||
    text === '大小周' ||
    text === 'big-small' ||
    text === 'rotating'
  ) {
    return 'alternating';
  }
  if (text === 'custom' || text === '自定义') {
    return 'custom';
  }
  return 'double';
}

function normalizeCustomWorkdays(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const days = new Set<number>();
  for (const item of value) {
    const day =
      typeof item === 'number'
        ? item
        : typeof item === 'string' && item.trim() !== ''
          ? Number(item)
          : Number.NaN;
    if (Number.isInteger(day) && day >= 1 && day <= 7) {
      days.add(day);
    }
  }
  // 显式空数组保留为空（自定义全休息），但全是坏值视为无效并回退默认。
  if (value.length > 0 && days.size === 0) {
    return null;
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * 容错解析工作日规则。兼容旧值：
 * - `calendar.workdayRule` 对象；
 * - 字符串 `双休/单休/大小周/自定义`；
 * - 旧键 `calendar.workdays` 的简单数组。
 */
export function normalizeWorkdayRule(value: unknown): WorkdayRule {
  if (typeof value === 'string') {
    const rule = normalizeRuleKind(value);
    return {
      ...DEFAULT_WORKDAY_RULE,
      rule,
      customWorkdays: [...DEFAULT_WORKDAY_RULE.customWorkdays],
    };
  }

  if (Array.isArray(value)) {
    return {
      rule: 'custom',
      anchorMonday: null,
      customWorkdays:
        normalizeCustomWorkdays(value) ??
        [...DEFAULT_WORKDAY_RULE.customWorkdays],
    };
  }

  if (!isRecord(value)) {
    return {
      ...DEFAULT_WORKDAY_RULE,
      customWorkdays: [...DEFAULT_WORKDAY_RULE.customWorkdays],
    };
  }

  const rawRule =
    value.rule ??
    value.kind ??
    value.type ??
    (typeof value.workdays === 'string' ? value.workdays : undefined);
  const custom = normalizeCustomWorkdays(
    value.customWorkdays ?? value.days ?? value.workdays,
  );
  const rule = rawRule
    ? normalizeRuleKind(rawRule)
    : custom
      ? 'custom'
      : 'double';
  const rawAnchor = value.anchorMonday ?? value.anchor;
  const anchorMonday =
    typeof rawAnchor === 'string' && isValidISODate(rawAnchor)
      ? startOfWeekISO(rawAnchor, 'monday')
      : null;

  return {
    rule,
    anchorMonday,
    customWorkdays:
      custom ?? [...DEFAULT_WORKDAY_RULE.customWorkdays],
  };
}

export function workdayRuleLabel(rule: WorkdayRule): string {
  return (
    WORKDAY_RULE_OPTIONS.find((option) => option.value === rule.rule)?.label ??
    '双休（周一至周五）'
  );
}

/** 周起始（本地日历日）。 */
export function startOfWeekISO(
  value: string,
  weekStart: WeekStart = 'monday',
): string {
  const weekday = parseISODate(value).getDay();
  const offset =
    weekStart === 'sunday' ? weekday : (weekday + 6) % 7;
  return addDaysISO(value, -offset);
}

/** 当前周起始下的连续 7 天。 */
export function weekDaysISO(
  value: string,
  weekStart: WeekStart = 'monday',
): string[] {
  const start = startOfWeekISO(value, weekStart);
  return Array.from({ length: 7 }, (_, index) => addDaysISO(start, index));
}

/** 固定 6×7，共 42 格；按周起始排列，跨月/跨年由自然日推进。 */
export function monthGrid(
  monthKey: string,
  weekStart: WeekStart = 'monday',
): MonthGridCell[] {
  const [year, month] = monthKey.split('-').map(Number);
  const first = new Date(year, month - 1, 1);
  const offset =
    weekStart === 'sunday' ? first.getDay() : (first.getDay() + 6) % 7;
  const start = new Date(year, month - 1, 1 - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + index,
    );
    const iso = formatISO(date);
    return {
      date: iso,
      inMonth: monthKeyOf(iso) === monthKey,
    };
  });
}

/**
 * 某一周在月格上的周序号：ISO 周号仍按周一计算。
 * 周日开头时取该行周一的周号，避免显示上一周的 ISO 周号。
 */
export function weekNumberFor(
  weekStartDate: string,
  weekStart: WeekStart = 'monday',
): number {
  return isoWeekNumber(
    weekStart === 'sunday'
      ? addDaysISO(weekStartDate, 1)
      : weekStartDate,
  );
}

export { isoWeekNumber };

function isoWeekday(value: string): number {
  const day = parseISODate(value).getDay();
  return day === 0 ? 7 : day;
}

function isDoubleAlternatingWeek(date: string, rule: WorkdayRule): boolean {
  const monday = startOfWeekISO(date, 'monday');
  const anchor =
    rule.anchorMonday && isValidISODate(rule.anchorMonday)
      ? startOfWeekISO(rule.anchorMonday, 'monday')
      : ALTERNATING_EPOCH_MONDAY;
  const weeks = Math.round(diffDays(anchor, monday) / 7);
  return Math.abs(weeks % 2) === 0;
}

/** 只看周规则（忽略法定节假日/调休）。 */
export function weeklyWorkday(
  date: string,
  rule: WorkdayRule = DEFAULT_WORKDAY_RULE,
): boolean {
  const normalized = normalizeWorkdayRule(rule);
  const day = isoWeekday(date);

  if (normalized.rule === 'single') {
    return day <= 6;
  }
  if (normalized.rule === 'alternating') {
    if (day === 7) {
      return false;
    }
    if (day <= 5) {
      return true;
    }
    // 周六：双休周休息，单休周上班。
    return !isDoubleAlternatingWeek(date, normalized);
  }
  if (normalized.rule === 'custom') {
    return normalized.customWorkdays.includes(day);
  }
  return day <= 5;
}

/**
 * 工作日状态：
 * - `exception-work` / `exception-rest`：个人日期例外（最高优先级）；
 * - `holiday`：法定节假日（休息）；
 * - `makeup`：法定调休上班（工作）；
 * - `workday` / `rest`：周规则。
 */
export function workdayStatus(
  date: string,
  rule: WorkdayRule | WorkdayRuleKind = DEFAULT_WORKDAY_RULE,
  options: WorkdayOptions = {},
): WorkdayStatus {
  const exception = dateExceptionOn(date, options.exceptions);
  if (exception) {
    return exception.kind === 'work' ? 'exception-work' : 'exception-rest';
  }
  const normalized = normalizeWorkdayRule(rule);
  if (options.officialHolidays !== false) {
    const holiday = holidayOn(date, options.holidayLookup ?? null);
    if (holiday) {
      return holiday.kind;
    }
  }
  return weeklyWorkday(date, normalized) ? 'workday' : 'rest';
}

/** 是否工作日；个人例外 > 法定节假日/调休 > 周规则。 */
export function isWorkday(
  date: string,
  rule: WorkdayRule | WorkdayRuleKind = DEFAULT_WORKDAY_RULE,
  options: WorkdayOptions = {},
): boolean {
  const status = workdayStatus(date, rule, options);
  return (
    status === 'workday' ||
    status === 'makeup' ||
    status === 'exception-work'
  );
}

/** 是否休息日（含个人例外休息），供视图统一加休息样式。 */
export function isRestStatus(status: WorkdayStatus): boolean {
  return status === 'rest' || status === 'exception-rest';
}

export function workdayStatusLabel(status: WorkdayStatus): string {
  if (status === 'holiday') {
    return '法定节假日';
  }
  if (status === 'makeup') {
    return '调休上班';
  }
  if (status === 'exception-work') {
    return '个人例外 · 上班';
  }
  if (status === 'exception-rest') {
    return '个人例外 · 休息';
  }
  return status === 'workday' ? '工作日' : '休息日';
}

/** 切换自定义工作日；至少保留一天，避免产生“全周休息”的误操作。 */
export function toggleCustomWorkday(
  rule: WorkdayRule,
  day: number,
): WorkdayRule {
  const normalized = normalizeWorkdayRule(rule);
  if (!Number.isInteger(day) || day < 1 || day > 7) {
    return normalized;
  }
  const current = new Set(normalized.customWorkdays);
  if (current.has(day)) {
    if (current.size === 1) {
      return { ...normalized, rule: 'custom' };
    }
    current.delete(day);
  } else {
    current.add(day);
  }
  return {
    ...normalized,
    rule: 'custom',
    customWorkdays: [...current].sort((a, b) => a - b),
  };
}

/** 当前周在大小周里是否为双休周。 */
export function isAlternatingDoubleWeek(
  date: string,
  rule: WorkdayRule = DEFAULT_WORKDAY_RULE,
): boolean {
  return isDoubleAlternatingWeek(date, normalizeWorkdayRule(rule));
}
