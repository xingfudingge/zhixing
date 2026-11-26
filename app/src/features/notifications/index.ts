/**
 * 通知功能入口。
 *
 *   const scheduler = createDefaultNotificationScheduler();
 *   await scheduler.reconcile(tasks);
 *   <NotificationCenter scheduler={scheduler} tasks={tasks} />
 *
 * 应用需要监听 `IN_APP_NOTIFICATION_EVENT` 展示应用内提醒；浏览器/系统
 * 通道只做尽力发送，界面不得宣称“必达”。
 */

import './notifications.css';

import { defaultNotificationSettingsStore } from './settings';
import { LocalStorageNotificationPlanStore } from './store';
import {
  createNotificationScheduler,
  type NotificationScheduler,
  type NotificationSchedulerOptions,
} from './scheduler';

export {
  NotificationCenter,
} from './NotificationCenter';
export type { NotificationCenterProps } from './NotificationCenter';
export { NotificationRuntime } from './NotificationRuntime';
export type { NotificationRuntimeProps } from './NotificationRuntime';
export {
  IN_APP_NOTIFICATION_EVENT,
  NOTIFICATION_SETTINGS_CHANGED_EVENT,
  NotificationScheduler,
  UnavailableSystemNotificationAdapter,
  browserPermissionExplanation,
  createNotificationScheduler,
  readBrowserPermission,
  requestBrowserPermission,
} from './scheduler';
export type {
  NotificationSchedulerOptions,
  SystemNotificationAdapter,
} from './scheduler';
export {
  NOTIFICATION_DEVICE_KEY,
  NOTIFICATION_TASKS_CHANGED_EVENT,
  broadcastTasksChanged,
  getDefaultNotificationScheduler,
  loadNotificationTasks,
  readNotificationDeviceId,
  resetDefaultNotificationScheduler,
} from './runtime';
export {
  buildDigestPlans,
  buildReminderPlans,
  buildTaskReminderPlans,
  formatPlanTime,
  isInQuietHours,
  isMissedPlan,
  parseReminderOffsetMinutes,
  quietHoursLabel,
  reconcilePlans,
  taskDueInstant,
  zonedDateTimeToUtc,
} from './planner';
export {
  DEFAULT_NOTIFICATION_SETTINGS,
  channelLabel,
  explainPermission,
  planStatusLabel,
} from './types';
export type {
  DeliveryRecord,
  NotificationChannel,
  NotificationPermissionState,
  NotificationSettings,
  NotificationTask,
  NotificationTestOutcome,
  NotificationTestResult,
  PermissionExplanation,
  PlanContext,
  QuietHours,
  ReminderPlan,
  ReminderPlanStatus,
} from './types';
export {
  LocalStorageNotificationSettingsStore,
  MemoryNotificationSettingsStore,
  NOTIFICATION_SETTINGS_KEY,
  defaultNotificationSettingsStore,
  normalizeNotificationSettings,
} from './settings';
export type { NotificationSettingsStore } from './settings';
export {
  LocalStorageNotificationPlanStore,
  MemoryNotificationPlanStore,
  NOTIFICATION_STORE_KEY,
} from './store';
export type { NotificationPlanStore } from './store';

export function createDefaultNotificationScheduler(
  options: Partial<NotificationSchedulerOptions> = {},
): NotificationScheduler {
  return createNotificationScheduler({
    store: options.store ?? new LocalStorageNotificationPlanStore(),
    settingsStore:
      options.settingsStore ?? defaultNotificationSettingsStore(),
    ...options,
  });
}
