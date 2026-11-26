/**
 * 习惯仓储封装。
 *
 * 设计约束（PRD §3.6.9 / 看板卡 P0-07）：
 * * 习惯不是任务：这里只读写 `habits` / `habit_logs`，不生成每日任务；
 * * `habit_id + log_date` 唯一，打卡是幂等 upsert；
 * * 未来日期在渲染层直接拒绝，不发出 IPC；
 * * 删除习惯时先删除它的全部活动日志，再软删除习惯，避免留下可查询的孤儿日志。
 *
 * 页面只使用这里的高层方法，不拼 SQL、不直接接触 IPC 命令名。
 */

import type { DbClient } from '../db/client';
import type {
  Habit,
  HabitLog,
  HabitLogQuery,
  HabitQuery,
  HabitUpdate,
  NewHabit,
} from '../db/types';

/** 与原型一致的拒绝提示；未来日期不能补卡。 */
export const FUTURE_DATE_MESSAGE = '还没到这一天';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 把局部修改补全为 Rust `HabitUpdate` 需要的完整结构。 */
export type HabitPatch = Partial<
  Pick<
    Habit,
    | 'title'
    | 'schedule'
    | 'icon'
    | 'color'
    | 'goalPerWeek'
    | 'sortOrder'
    | 'archived'
  >
>;

export function toHabitUpdate(habit: Habit, patch: HabitPatch): HabitUpdate {
  const next = { ...habit, ...patch };
  return {
    title: next.title,
    schedule: next.schedule,
    icon: next.icon,
    color: next.color,
    goalPerWeek: next.goalPerWeek,
    sortOrder: next.sortOrder,
    archived: next.archived,
  };
}

/** 本地日历日，避免 `toISOString()` 在东八区跨日。 */
export function todayISOFromClock(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function isFutureDate(date: string, today: string): boolean {
  return date > today;
}

export function assertCheckableDate(date: string, today: string): void {
  if (!ISO_DATE.test(date)) {
    throw new Error(`打卡日期格式不正确：${date}`);
  }
  if (isFutureDate(date, today)) {
    throw new Error(FUTURE_DATE_MESSAGE);
  }
}

export type HabitRepositoryOptions = {
  /** 测试可注入稳定“今天”；不传时使用本机本地日期。 */
  today?: () => string;
};

export function createHabitRepository(
  client: DbClient,
  options: HabitRepositoryOptions = {},
) {
  const habits = client.habits;
  const today = options.today ?? todayISOFromClock;

  return {
    list: (query: HabitQuery = {}): Promise<Habit[]> => habits.list(query),
    get: (id: string): Promise<Habit> => habits.get(id),
    create: (input: NewHabit): Promise<Habit> => habits.create(input),
    update: (id: string, input: HabitUpdate): Promise<Habit> =>
      habits.update(id, input),
    patch: (habit: Habit, patch: HabitPatch): Promise<Habit> =>
      habits.update(habit.id, toHabitUpdate(habit, patch)),

    /**
     * 删除习惯及其打卡记录。
     *
     * Rust 的 `habits_delete` 只软删除习惯，日志行仍在库里；这里按日期逐条
     * 取消打卡（`habit_logs_delete` 软删除），再删除习惯。即使某条日志在
     * 读取后被删除，重复删除也是幂等的。
     */
    async remove(id: string): Promise<void> {
      const logs = await habits.logs.list(id);
      for (const log of logs) {
        await habits.logs.remove(id, log.logDate);
      }
      await habits.remove(id);
    },

    logs: {
      list: (habitId: string, query: HabitLogQuery = {}): Promise<HabitLog[]> =>
        habits.logs.list(habitId, query),
      async set(
        habitId: string,
        date: string,
        note?: string,
      ): Promise<HabitLog> {
        assertCheckableDate(date, today());
        return habits.logs.set(habitId, date, note);
      },
      async remove(habitId: string, date: string): Promise<void> {
        assertCheckableDate(date, today());
        return habits.logs.remove(habitId, date);
      },
    },
  };
}

export type HabitRepository = ReturnType<typeof createHabitRepository>;
