/**
 * 通知运行时：设备标识、默认调度器与任务变更广播。
 *
 * 调度器是应用级单例：设置页与宿主（Shell 中的 NotificationRuntime）读写
 * 同一份 preferences/计划，避免“设置页看起来改了、后台仍用旧值”。
 */

import { db, isTauriRuntime } from '../../data/db/client';
import { createNotificationScheduler, type NotificationScheduler } from './scheduler';
import { defaultNotificationSettingsStore } from './settings';
import { LocalStorageNotificationPlanStore } from './store';
import type { NotificationTask } from './types';

export const NOTIFICATION_DEVICE_KEY = 'zhixing.notifications.device.v1';

/** 任务域完成一次真实刷新后广播，通知运行时据此立即重算计划。 */
export const NOTIFICATION_TASKS_CHANGED_EVENT = 'zhixing:tasks-changed';

let defaultScheduler: NotificationScheduler | null = null;

function randomId(): string {
  try {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      return cryptoApi.randomUUID();
    }
  } catch {
    // 继续走时间戳兜底。
  }
  return `device-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/** 设备标识只用于去重键；持久化后重开应用不会重复提醒同一任务。 */
export function readNotificationDeviceId(): string {
  try {
    const existing = localStorage.getItem(NOTIFICATION_DEVICE_KEY);
    if (existing) return existing;
    const next = randomId();
    localStorage.setItem(NOTIFICATION_DEVICE_KEY, next);
    return next;
  } catch {
    return 'device';
  }
}

export function getDefaultNotificationScheduler(): NotificationScheduler {
  if (!defaultScheduler) {
    defaultScheduler = createNotificationScheduler({
      store: new LocalStorageNotificationPlanStore(),
      settingsStore: defaultNotificationSettingsStore(),
      deviceId: readNotificationDeviceId(),
      autoSchedule: true,
    });
  }
  return defaultScheduler;
}

/** 测试用：释放单例定时器，避免跨用例残留。 */
export function resetDefaultNotificationScheduler(): void {
  defaultScheduler?.stop();
  defaultScheduler = null;
}

/**
 * 浏览器预览没有任务库，返回空数组；桌面壳从真实 SQLite 读取。
 * 读取失败抛错，由调用方决定跳过 reconcile，避免用空数组撤销计划。
 */
export async function loadNotificationTasks(): Promise<NotificationTask[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  const tasks = await db.tasks.list();
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    dueDate: task.dueDate,
    dueTime: task.dueTime,
    dueAt: task.dueAt,
    tz: task.tz,
    reminder: task.reminder,
    deletedAt: task.deletedAt,
  }));
}

/** 任务 store 刷新后调用；在浏览器/测试环境安全无副作用。 */
export function broadcastTasksChanged(): void {
  if (typeof window === 'undefined' || typeof Event !== 'function') {
    return;
  }
  window.dispatchEvent(new Event(NOTIFICATION_TASKS_CHANGED_EVENT));
}
