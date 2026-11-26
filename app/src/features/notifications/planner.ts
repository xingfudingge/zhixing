/**
 * 提醒计划纯函数：任务 → 提醒计划、免打扰判断、改期撤销与去重。
 *
 * 不依赖定时器/浏览器，方便精确测试。关键规则：
 * - 任务完成/删除/关闭通道后，旧计划撤销；
 * - 改期后 dedupeKey 包含到期时间，旧计划不会复用；
 * - 已发送/已抑制的计划不会因为重新调和而再次发送。
 */

import type {
  NotificationChannel,
  NotificationSettings,
  NotificationTask,
  PlanContext,
  ReminderPlan,
} from './types';

const MINUTE = 60_000;

const SHORT_REMINDER_MINUTES: Record<string, number> = {
  at: 0,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '1d': 24 * 60,
};

export function parseReminderOffsetMinutes(reminder: string): number | null {
  const text = reminder.trim().toLowerCase();
  if (!text) return null;
  if (Object.prototype.hasOwnProperty.call(SHORT_REMINDER_MINUTES, text)) {
    return SHORT_REMINDER_MINUTES[text] ?? null;
  }
  if (/不提醒|关闭提醒|none/.test(text)) return null;
  if (/准时|到点|on time/.test(text)) return 0;

  const unitMinutes: Record<string, number> = {
    分钟: 1,
    分: 1,
    小时: 60,
    钟头: 60,
    天: 24 * 60,
    日: 24 * 60,
    周: 7 * 24 * 60,
    星期: 7 * 24 * 60,
  };
  let total = 0;
  let matched = false;
  const pattern = /(\d+)\s*(分钟|小时|钟头|天|日|周|星期)/g;
  for (const match of text.matchAll(pattern)) {
    total += Number(match[1]) * (unitMinutes[match[2] ?? ''] ?? 0);
    matched = true;
  }
  if (/半小时/.test(text)) {
    total += 30;
    matched = true;
  }
  return matched ? total : null;
}

function timezoneOffsetMs(instant: Date, timeZone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = formatter.formatToParts(instant);
    const values: Record<string, number> = {};
    for (const part of parts) {
      if (
        part.type === 'year' ||
        part.type === 'month' ||
        part.type === 'day' ||
        part.type === 'hour' ||
        part.type === 'minute' ||
        part.type === 'second'
      ) {
        values[part.type] = Number(part.value);
      }
    }
    if (values.year === undefined) return 0;
    const asUtc = Date.UTC(
      values.year,
      (values.month ?? 1) - 1,
      values.day ?? 1,
      values.hour ?? 0,
      values.minute ?? 0,
      values.second ?? 0,
    );
    return asUtc - instant.getTime();
  } catch {
    return 0;
  }
}

/** 把 IANA 时区里的墙上时间转换成 UTC 瞬间。 */
export function zonedDateTimeToUtc(
  date: string,
  time: string,
  timeZone: string,
): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  if (!timeZone) return new Date(guess);
  try {
    // 用猜测瞬间的时区偏移校正；再迭代一次处理 DST 边界。
    let offset = timezoneOffsetMs(new Date(guess), timeZone);
    let actual = guess - offset;
    offset = timezoneOffsetMs(new Date(actual), timeZone);
    actual = guess - offset;
    return new Date(actual);
  } catch {
    return new Date(guess);
  }
}

export function taskDueInstant(task: NotificationTask): Date | null {
  if (task.dueAt) {
    const parsed = new Date(task.dueAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (!task.dueDate) return null;
  return zonedDateTimeToUtc(
    task.dueDate,
    task.dueTime || '09:00',
    task.tz || 'Asia/Shanghai',
  );
}

export function formatPlanTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formatter.format(date);
}

function isoLocalDate(date: Date, timeZone = 'Asia/Shanghai'): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(date);
    const values: Record<string, string> = {};
    for (const part of parts) {
      values[part.type] = part.value;
    }
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function enabledChannels(settings: NotificationSettings): NotificationChannel[] {
  const channels: NotificationChannel[] = [];
  if (settings.inApp) channels.push('in-app');
  if (settings.browser) channels.push('browser');
  if (settings.system) channels.push('system');
  return channels;
}

function offsetLabel(minutes: number): string {
  if (minutes === 0) return '准时';
  if (minutes % (7 * 24 * 60) === 0) return `提前 ${minutes / (7 * 24 * 60)} 周`;
  if (minutes % (24 * 60) === 0) return `提前 ${minutes / (24 * 60)} 天`;
  if (minutes % 60 === 0) return `提前 ${minutes / 60} 小时`;
  return `提前 ${minutes} 分钟`;
}

export function buildTaskReminderPlans(
  tasks: ReadonlyArray<NotificationTask>,
  settings: NotificationSettings,
  context: PlanContext,
): ReminderPlan[] {
  const channels = enabledChannels(settings);
  if (channels.length === 0) return [];
  const nowIso = context.now.toISOString();
  const plans: ReminderPlan[] = [];

  for (const task of tasks) {
    if (task.deletedAt || task.status === 'done') continue;
    const offset = parseReminderOffsetMinutes(task.reminder);
    if (offset === null) continue;
    const due = taskDueInstant(task);
    if (!due) continue;
    const trigger = new Date(due.getTime() - offset * MINUTE);
    const timezone = task.tz || 'Asia/Shanghai';
    for (const channel of channels) {
      const dedupeKey = `${task.id}|${due.toISOString()}|${offset}|${channel}|${context.deviceId}`;
      plans.push({
        id: `rem_${task.id}_${due.getTime()}_${channel}`,
        ownerType: 'task',
        ownerId: task.id,
        channel,
        title: task.title,
        body: `到期：${formatPlanTime(due.toISOString())} · ${offsetLabel(offset)}`,
        triggerAt: trigger.toISOString(),
        timezone,
        dedupeKey,
        status: 'scheduled',
        explanation: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }
  return plans.sort((a, b) => a.triggerAt.localeCompare(b.triggerAt));
}

export function buildDigestPlans(
  tasks: ReadonlyArray<NotificationTask>,
  settings: NotificationSettings,
  context: PlanContext,
): ReminderPlan[] {
  if (!settings.dailyDigest.enabled) return [];
  const channels = enabledChannels(settings);
  if (channels.length === 0) return [];
  const timezone = 'Asia/Shanghai';
  const today = isoLocalDate(context.now, timezone);
  let date = today;
  let trigger = zonedDateTimeToUtc(date, settings.dailyDigest.time, timezone);
  if (!trigger) return [];
  if (trigger.getTime() <= context.now.getTime()) {
    date = addDays(today, 1);
    trigger = zonedDateTimeToUtc(date, settings.dailyDigest.time, timezone);
    if (!trigger) return [];
  }
  const todayTasks = tasks.filter(
    (task) => !task.deletedAt && task.status !== 'done' && task.dueDate === today,
  );
  const overdue = tasks.filter(
    (task) =>
      !task.deletedAt &&
      task.status !== 'done' &&
      task.dueDate !== null &&
      task.dueDate < today,
  );
  const nowIso = context.now.toISOString();
  return channels.map((channel) => ({
    id: `rem_digest_${date}_${channel}`,
    ownerType: 'digest',
    ownerId: date,
    channel,
    title: '今日摘要',
    body: `今天 ${todayTasks.length} 项待办，逾期 ${overdue.length} 项。`,
    triggerAt: trigger!.toISOString(),
    timezone,
    dedupeKey: `${date}|digest|${channel}|${context.deviceId}`,
    status: 'scheduled',
    explanation: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));
}

export function buildReminderPlans(
  tasks: ReadonlyArray<NotificationTask>,
  settings: NotificationSettings,
  context: PlanContext,
): ReminderPlan[] {
  return [
    ...buildTaskReminderPlans(tasks, settings, context),
    ...buildDigestPlans(tasks, settings, context),
  ].sort((a, b) => a.triggerAt.localeCompare(b.triggerAt));
}

/**
 * 免打扰期间生成的是 `原去重键|quiet` 延迟计划。重新调和时任务本身仍是
 * desired，但不能因此把延迟计划撤销，否则免打扰结束后永远不会提醒。
 */
function isQuietVariantOf(
  dedupeKey: string,
  desiredKeys: ReadonlySet<string>,
): boolean {
  const suffix = '|quiet';
  if (!dedupeKey.endsWith(suffix)) return false;
  return desiredKeys.has(dedupeKey.slice(0, -suffix.length));
}

export function reconcilePlans(
  previous: ReadonlyArray<ReminderPlan>,
  desired: ReadonlyArray<ReminderPlan>,
  now: Date,
): ReminderPlan[] {
  const desiredKeys = new Set(desired.map((plan) => plan.dedupeKey));
  const nowIso = now.toISOString();
  const result: ReminderPlan[] = [];

  for (const plan of previous) {
    if (
      plan.status === 'scheduled' &&
      !desiredKeys.has(plan.dedupeKey) &&
      !isQuietVariantOf(plan.dedupeKey, desiredKeys)
    ) {
      result.push({
        ...plan,
        status: 'canceled',
        explanation: '任务已改期/完成，或对应通知通道已关闭；旧计划已撤销',
        updatedAt: nowIso,
      });
    } else {
      result.push(plan);
    }
  }

  const byKey = new Map(result.map((plan) => [plan.dedupeKey, plan]));
  for (const plan of desired) {
    const existing = byKey.get(plan.dedupeKey);
    if (!existing) {
      byKey.set(plan.dedupeKey, plan);
      result.push(plan);
      continue;
    }
    if (existing.status === 'canceled') {
      const revived: ReminderPlan = {
        ...existing,
        status: 'scheduled',
        explanation: null,
        updatedAt: nowIso,
      };
      byKey.set(plan.dedupeKey, revived);
      const index = result.findIndex((item) => item.dedupeKey === plan.dedupeKey);
      if (index >= 0) result[index] = revived;
    }
  }

  return result.sort((a, b) => a.triggerAt.localeCompare(b.triggerAt));
}

export function isInQuietHours(
  date: Date,
  quiet: NotificationSettings['quietHours'],
): boolean {
  if (!quiet.enabled) return false;
  if (quiet.start === quiet.end) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  const [startHour, startMinute] = quiet.start.split(':').map(Number);
  const [endHour, endMinute] = quiet.end.split(':').map(Number);
  const start = startHour! * 60 + startMinute!;
  const end = endHour! * 60 + endMinute!;
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

export function quietHoursLabel(
  quiet: NotificationSettings['quietHours'],
): string {
  return `${quiet.start}–${quiet.end}`;
}

/** 已错过超过 5 分钟的计划不再补发，避免打开应用时集中弹旧提醒。 */
export function isMissedPlan(plan: ReminderPlan, now: Date): boolean {
  const trigger = new Date(plan.triggerAt).getTime();
  if (Number.isNaN(trigger)) return true;
  return now.getTime() - trigger > 5 * MINUTE;
}
