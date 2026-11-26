/**
 * 任务提醒选项与默认值注入。
 *
 * 提醒值沿用任务表已有的短码（与 `planner.parseReminderOffsetMinutes` 对齐），
 * 不新增任务字段；默认提醒只在“新建且未显式传 reminder”时补入。
 */

import type { NewTask } from '../../data/db/types';
import {
  normalizeTaskDefaultReminder,
  TASK_DEFAULT_REMINDERS,
} from '../../data/repositories/settings';

export type ReminderOption = {
  value: string;
  label: string;
};

/** 单条任务可选的全部提醒；详情页与默认值下拉共用，避免两套标签漂移。 */
export const TASK_REMINDER_OPTIONS: readonly ReminderOption[] = [
  { value: '', label: '不提醒' },
  { value: 'at', label: '到期时' },
  { value: '5m', label: '提前 5 分钟' },
  { value: '15m', label: '提前 15 分钟' },
  { value: '30m', label: '提前 30 分钟' },
  { value: '1h', label: '提前 1 小时' },
  { value: '1d', label: '提前 1 天' },
];

/**
 * 默认提醒不提供“提前 1 天”：全局默认应只覆盖短提前量，
 * 长提前量仍留给单条任务显式选择。
 */
export const TASK_DEFAULT_REMINDER_OPTIONS: readonly ReminderOption[] =
  TASK_REMINDER_OPTIONS.filter((option) =>
    (TASK_DEFAULT_REMINDERS as readonly string[]).includes(option.value),
  );

/** 旧数据/种子可能保存中文提醒文案，下拉只认短码；显示时回映射。 */
export function reminderOptionValue(reminder: string): string {
  const text = reminder.trim();
  const match = TASK_REMINDER_OPTIONS.find(
    (option) => option.label === text || option.value === text,
  );
  return match?.value ?? text;
}

/**
 * 只在新建任务时补默认提醒：
 * - 没有日期/到期瞬间的任务不提醒（无日期不写）；
 * - 调用方显式传 `reminder`（包括空字符串或 sentinel `none`）时一律尊重，
 *   不把用户主动选择的“不提醒”再填回默认值；
 * - 默认值为“关闭”时保持原样。
 */
export function applyDefaultReminder(
  input: NewTask,
  defaultReminder: unknown,
): NewTask {
  if (input.reminder !== undefined) {
    return input;
  }
  if (!input.dueDate && !input.dueAt) {
    return input;
  }
  const reminder = normalizeTaskDefaultReminder(defaultReminder);
  if (!reminder) {
    return input;
  }
  return { ...input, reminder };
}
