/**
 * 本地通知计划器类型。
 *
 * 产品不承诺系统通知必达：每条计划都保留状态与失败/抑制原因，UI 只展示
 * “已发送到浏览器/应用内”，不展示“已送达”。
 */

import type { Task } from '../../data/db/types';

export type NotificationChannel = 'in-app' | 'browser' | 'system';

export type NotificationPermissionState =
  | 'default'
  | 'granted'
  | 'denied'
  | 'unsupported';

export type QuietHours = {
  enabled: boolean;
  start: string;
  end: string;
};

export type NotificationSettings = {
  /** 应用内提醒默认开启；不依赖系统权限。 */
  inApp: boolean;
  browser: boolean;
  system: boolean;
  sound: boolean;
  lockScreenPrivacy: boolean;
  quietHours: QuietHours;
  dailyDigest: {
    enabled: boolean;
    time: string;
  };
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  inApp: true,
  browser: false,
  system: false,
  sound: false,
  lockScreenPrivacy: true,
  quietHours: { enabled: false, start: '22:00', end: '08:00' },
  dailyDigest: { enabled: false, time: '09:00' },
};

export type ReminderPlanStatus =
  | 'scheduled'
  | 'sent'
  | 'suppressed'
  | 'blocked'
  | 'unsupported'
  | 'failed'
  | 'canceled';

export type ReminderPlan = {
  id: string;
  ownerType: 'task' | 'digest';
  ownerId: string;
  channel: NotificationChannel;
  title: string;
  body: string;
  triggerAt: string;
  timezone: string;
  dedupeKey: string;
  status: ReminderPlanStatus;
  explanation: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeliveryRecord = {
  id: string;
  planId: string;
  dedupeKey: string;
  channel: NotificationChannel;
  title: string;
  body: string;
  status: ReminderPlanStatus;
  at: string;
  explanation: string | null;
};

export type PlanContext = {
  now: Date;
  deviceId: string;
  browserPermission: NotificationPermissionState;
  systemAvailable: boolean;
};

export type NotificationTask = Pick<
  Task,
  | 'id'
  | 'title'
  | 'status'
  | 'dueDate'
  | 'dueTime'
  | 'dueAt'
  | 'tz'
  | 'reminder'
  | 'deletedAt'
>;

export type PermissionExplanation = {
  state: NotificationPermissionState;
  label: string;
  detail: string;
  canRequest: boolean;
};

/** “发送测试通知”的逐通道结果；ok 为 true 表示至少一个通道已触发。 */
export type NotificationTestOutcome = {
  channel: NotificationChannel;
  status: ReminderPlanStatus;
  explanation: string;
};

export type NotificationTestResult = {
  ok: boolean;
  outcomes: NotificationTestOutcome[];
};

export function planStatusLabel(status: ReminderPlanStatus): string {
  switch (status) {
    case 'scheduled':
      return '待触发';
    case 'sent':
      return '已发送（不保证送达）';
    case 'suppressed':
      return '已抑制';
    case 'blocked':
      return '权限阻止';
    case 'unsupported':
      return '环境不支持';
    case 'failed':
      return '发送失败';
    case 'canceled':
      return '已撤销';
  }
}

export function channelLabel(channel: NotificationChannel): string {
  switch (channel) {
    case 'in-app':
      return '应用内';
    case 'browser':
      return '浏览器';
    case 'system':
      return '系统';
  }
}

/** 权限拒绝时给出可执行的下一步，而不是只说“失败”。 */
export function explainPermission(
  state: NotificationPermissionState,
  options: { isTauri?: boolean } = {},
): PermissionExplanation {
  switch (state) {
    case 'granted':
      return {
        state,
        label: '已允许',
        detail: '浏览器允许显示通知；系统仍可能延迟或丢弃，不承诺必达。',
        canRequest: false,
      };
    case 'denied':
      return {
        state,
        label: '已拒绝',
        detail:
          '浏览器已拒绝通知权限。请在浏览器站点设置中重新允许；应用内提醒仍然可用。',
        canRequest: false,
      };
    case 'default':
      return {
        state,
        label: '未请求',
        detail: '只有点击“开启浏览器通知”时才会请求权限，不会自动弹窗。',
        canRequest: true,
      };
    case 'unsupported':
      return {
        state,
        label: '不支持',
        detail: options.isTauri
          ? '当前桌面壳未接入原生通知插件；本版本只保证应用内提醒。'
          : '当前环境没有 Notification API；应用内提醒仍然可用。',
        canRequest: false,
      };
  }
}
