/**
 * 习惯域的纯函数：日期网格、连续天数、周完成率与复盘汇总。
 *
 * 所有日期都是本地日历日 `YYYY-MM-DD`，不使用 UTC 切日；周视图固定周一开始，
 * 不受设置里的“周起始日”影响（与原型一致）。
 */

import type { Habit, HabitLog } from '../../data/db/types';

/**
 * 习惯图标的稳定 key。数据里只存 key（如 `read`），不存 emoji/符号本身；
 * 旧版本写入的字符通过 `normalizeHabitIcon()` 映射到新 key。
 */
export const HABIT_ICONS = [
  { value: 'read', label: '阅读' },
  { value: 'exercise', label: '运动' },
  { value: 'water', label: '喝水' },
  { value: 'sleep', label: '睡眠' },
  { value: 'meditate', label: '冥想' },
  { value: 'write', label: '写作' },
  { value: 'study', label: '学习' },
  { value: 'wake', label: '早起' },
  { value: 'diet', label: '饮食' },
  { value: 'tidy', label: '整理' },
  { value: 'music', label: '音乐' },
  { value: 'custom', label: '自定义' },
] as const;

export type HabitIconKey = (typeof HABIT_ICONS)[number]['value'];

export const HABIT_COLORS = [
  { value: 'amber', label: '琥珀' },
  { value: 'violet', label: '紫' },
  { value: 'blue', label: '蓝' },
  { value: 'teal', label: '青' },
] as const;

export const HABIT_TONES = ['amber', 'violet', 'blue', 'teal'] as const;
export type HabitTone = (typeof HABIT_TONES)[number];

/** 旧数据里的抽象字符/常见 emoji → 语义 key。 */
export const LEGACY_HABIT_ICONS: Record<string, HabitIconKey> = {
  '☀': 'wake',
  '▤': 'read',
  '⌂': 'custom',
  '✳': 'custom',
  '◉': 'meditate',
  '◇': 'custom',
  '📖': 'read',
  '📚': 'read',
  '🏃': 'exercise',
  '🚶': 'exercise',
  '🏋️': 'exercise',
  '💧': 'water',
  '🥤': 'water',
  '🌙': 'sleep',
  '😴': 'sleep',
  '💤': 'sleep',
  '🧘': 'meditate',
  '✍️': 'write',
  '✍': 'write',
  '📝': 'write',
  '🎓': 'study',
  '📘': 'study',
  '🌅': 'wake',
  '🌞': 'wake',
  '⏰': 'wake',
  '🍎': 'diet',
  '🥗': 'diet',
  '🍽️': 'diet',
  '🧹': 'tidy',
  '📦': 'tidy',
  '🎵': 'music',
  '🎶': 'music',
  '🎧': 'music',
  '⭐': 'custom',
  '✨': 'custom',
};

export const DEFAULT_HABIT_ICON: HabitIconKey = 'custom';
export const DEFAULT_HABIT_COLOR = 'amber';

const HABIT_ICON_KEY_SET = new Set<string>(
  HABIT_ICONS.map((item) => item.value),
);

export function isHabitIconKey(value: string): value is HabitIconKey {
  return HABIT_ICON_KEY_SET.has(value);
}

/** 任意历史值 → 稳定 key；无法识别时落到「自定义」。 */
export function normalizeHabitIcon(
  value: string | null | undefined,
): HabitIconKey {
  const raw = value?.trim() ?? '';
  if (isHabitIconKey(raw)) {
    return raw;
  }
  return LEGACY_HABIT_ICONS[raw] ?? DEFAULT_HABIT_ICON;
}

export function habitIconLabel(value: string | null | undefined): string {
  const key = normalizeHabitIcon(value);
  return HABIT_ICONS.find((item) => item.value === key)?.label ?? '自定义';
}

export function habitToneOf(color: string): HabitTone {
  return (HABIT_TONES as readonly string[]).includes(color)
    ? (color as HabitTone)
    : 'amber';
}

export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const;

export type HabitLogMap = Record<string, HabitLog[]>;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function todayISOFromClock(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function parseISODate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function formatISODate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(date: string, days: number): string {
  const value = parseISODate(date);
  value.setDate(value.getDate() + days);
  return formatISODate(value);
}

/** 周一 = 0，周日 = 6。 */
export function weekdayIndex(date: string): number {
  return (parseISODate(date).getDay() + 6) % 7;
}

export function isFutureDate(date: string, today: string): boolean {
  return date > today;
}

/** 包含 `today` 的周一到周日 7 个日期。 */
export function weekDates(today: string): string[] {
  const monday = addDays(today, -weekdayIndex(today));
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

export function currentMonth(today: string): string {
  return today.slice(0, 7);
}

export function monthDates(month: string): string[] {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return Array.from(
    { length: lastDay },
    (_, index) => `${year}-${pad(monthNumber)}-${pad(index + 1)}`,
  );
}

export function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(year, monthNumber - 1 + delta, 1);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

export function monthLabel(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return `${year} 年 ${monthNumber} 月`;
}

/** 只把真实生效的打卡计入统计；软删除的日志不算。 */
export function activeLogDates(logs: HabitLog[] | undefined): Set<string> {
  const dates = new Set<string>();
  for (const log of logs ?? []) {
    if (log.done && log.deletedAt === null) {
      dates.add(log.logDate);
    }
  }
  return dates;
}

export function checkedOn(dates: ReadonlySet<string>, date: string): boolean {
  return dates.has(date);
}

/**
 * 当前连续：今天已打卡从今天向前数，否则从昨天向前数。
 * 与原型 `habitStreak()` 一致，允许“今天还没来得及打卡”时显示昨天为止的连续。
 */
export function currentStreak(
  dates: ReadonlySet<string>,
  today: string,
): number {
  let cursor = dates.has(today) ? today : addDays(today, -1);
  let count = 0;
  while (dates.has(cursor)) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

/** 历史最佳连续：遍历全部打卡日期，取最长连续段。 */
export function bestStreak(dates: ReadonlySet<string>): number {
  const sorted = [...dates].sort();
  let best = 0;
  let run = 0;
  let previous: string | null = null;
  for (const date of sorted) {
    if (previous !== null && addDays(previous, 1) === date) {
      run += 1;
    } else {
      run = 1;
    }
    best = Math.max(best, run);
    previous = date;
  }
  return best;
}

export type HabitStreak = {
  current: number;
  best: number;
};

export function habitStreak(
  logs: HabitLog[] | undefined,
  today: string,
): HabitStreak {
  const dates = activeLogDates(logs);
  const current = currentStreak(dates, today);
  return {
    current,
    best: Math.max(bestStreak(dates), current),
  };
}

export type WeeklyCompletion = {
  checked: number;
  total: number;
  percent: number;
  week: string[];
};

export function weeklyCompletion(
  habits: Habit[],
  logsByHabit: HabitLogMap,
  today: string,
): WeeklyCompletion {
  const week = weekDates(today);
  let checked = 0;
  for (const habit of habits) {
    const dates = activeLogDates(logsByHabit[habit.id]);
    checked += week.filter((date) => dates.has(date)).length;
  }
  const total = habits.length * week.length;
  return {
    checked,
    total,
    percent: total === 0 ? 0 : Math.round((checked / total) * 100),
    week,
  };
}

export function longestBest(
  habits: Habit[],
  logsByHabit: HabitLogMap,
  today: string,
): number {
  return habits.reduce(
    (longest, habit) =>
      Math.max(longest, habitStreak(logsByHabit[habit.id], today).best),
    0,
  );
}

/**
 * 复盘页（P0-09）需要的习惯汇总。只读、不改源数据；
 * 今天打卡后 `checks` 必然 +1。
 */
export function reviewHabitStats(
  habits: Habit[],
  logsByHabit: HabitLogMap,
  today: string,
) {
  const weekly = weeklyCompletion(habits, logsByHabit, today);
  return {
    habitCount: habits.length,
    checks: weekly.checked,
    best: longestBest(habits, logsByHabit, today),
    weekStart: weekly.week[0] ?? today,
    weekEnd: weekly.week[6] ?? today,
  };
}

/** 按习惯分组日志；生成页面的唯一入口。 */
export function groupLogs(
  habits: Habit[],
  rowsByHabit: HabitLog[][],
): HabitLogMap {
  const map: HabitLogMap = {};
  habits.forEach((habit, index) => {
    map[habit.id] = rowsByHabit[index] ?? [];
  });
  return map;
}
