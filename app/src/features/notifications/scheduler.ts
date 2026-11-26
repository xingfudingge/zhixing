/**
 * 本地提醒调度器。
 *
 * - 应用内提醒是确定可用的本机行为；
 * - 浏览器通知只在用户点击后请求权限，拒绝时保留应用内提醒；
 * - 系统通知需要桌面壳接入原生插件，未接入时明确标记 unsupported；
 * - 去重键包含任务到期时间/通道/设备，改期会撤销旧计划；
 * - 免打扰时段内不发送，改为在免打扰结束后延迟提醒。
 */

import {
  buildReminderPlans,
  isInQuietHours,
  isMissedPlan,
  quietHoursLabel,
  reconcilePlans,
} from './planner';
import type {
  NotificationSettingsStore,
} from './settings';
import type { NotificationPlanStore } from './store';
import {
  explainPermission,
  type DeliveryRecord,
  type NotificationChannel,
  type NotificationPermissionState,
  type NotificationSettings,
  type NotificationTask,
  type NotificationTestOutcome,
  type NotificationTestResult,
  type ReminderPlan,
  type ReminderPlanStatus,
} from './types';

export const IN_APP_NOTIFICATION_EVENT = 'zhixing:notification';

/** 设置页修改偏好后广播，宿主可立即重新调和计划。 */
export const NOTIFICATION_SETTINGS_CHANGED_EVENT =
  'zhixing:notification-settings-changed';

export type SystemNotificationAdapter = {
  available(): Promise<boolean>;
  send(
    plan: ReminderPlan,
    settings: NotificationSettings,
  ): Promise<{ ok: boolean; explanation: string }>;
};

export class UnavailableSystemNotificationAdapter
  implements SystemNotificationAdapter
{
  constructor(private readonly isTauri: boolean) {}

  async available(): Promise<boolean> {
    return false;
  }

  async send(): Promise<{ ok: boolean; explanation: string }> {
    return {
      ok: false,
      explanation: this.isTauri
        ? '桌面壳尚未接入原生通知插件；本版本只保证应用内提醒，不承诺系统通知必达'
        : '当前环境没有系统通知适配器；应用内提醒仍然可用',
    };
  }
}

type NotificationApi = typeof Notification;

function notificationApi(): NotificationApi | null {
  const candidate = (globalThis as { Notification?: unknown }).Notification;
  return typeof candidate === 'function' ? (candidate as NotificationApi) : null;
}

export function readBrowserPermission(): NotificationPermissionState {
  const api = notificationApi();
  if (!api) return 'unsupported';
  const permission = api.permission;
  if (permission === 'granted' || permission === 'denied') {
    return permission;
  }
  return 'default';
}

/**
 * 只应在用户点击“开启浏览器通知”时调用；不会在挂载/定时器里自动请求。
 * 已拒绝时不再反复弹窗，直接返回 denied 与站点设置说明。
 */
export async function requestBrowserPermission(): Promise<NotificationPermissionState> {
  const api = notificationApi();
  if (!api) return 'unsupported';
  if (api.permission === 'denied') return 'denied';
  if (api.permission === 'granted') return 'granted';
  try {
    const result = await api.requestPermission();
    return result === 'granted' || result === 'denied' ? result : 'default';
  } catch {
    return 'default';
  }
}

export function browserPermissionExplanation(
  state: NotificationPermissionState,
  isTauri = false,
): ReturnType<typeof explainPermission> {
  return explainPermission(state, { isTauri });
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function channelDisabledReason(channel: NotificationChannel): string {
  switch (channel) {
    case 'in-app':
      return '应用内通知已关闭';
    case 'browser':
      return '浏览器通知已关闭';
    case 'system':
      return '系统通知已关闭';
  }
}

function channelEnabled(
  channel: NotificationChannel,
  settings: NotificationSettings,
): boolean {
  if (channel === 'in-app') return settings.inApp;
  if (channel === 'browser') return settings.browser;
  return settings.system;
}

function enabledChannels(settings: NotificationSettings): NotificationChannel[] {
  const channels: NotificationChannel[] = [];
  if (settings.inApp) channels.push('in-app');
  if (settings.browser) channels.push('browser');
  if (settings.system) channels.push('system');
  return channels;
}

type DeliveryOutcome = {
  status: ReminderPlanStatus;
  explanation: string;
  delayUntil?: Date;
};

export type NotificationSchedulerOptions = {
  store: NotificationPlanStore;
  settingsStore: NotificationSettingsStore;
  now?: () => Date;
  deviceId?: string;
  autoSchedule?: boolean;
  systemAdapter?: SystemNotificationAdapter;
  inAppDispatcher?: (plan: ReminderPlan) => void;
  timer?: {
    set: (callback: () => void, delay: number) => number;
    clear: (id: number) => void;
  };
};

const MAX_TIMEOUT = 2_147_483_647;

export class NotificationScheduler {
  private readonly store: NotificationPlanStore;
  private readonly settingsStore: NotificationSettingsStore;
  private readonly now: () => Date;
  private readonly deviceId: string;
  private readonly autoSchedule: boolean;
  private readonly systemAdapter: SystemNotificationAdapter;
  private readonly inAppDispatcher: (plan: ReminderPlan) => void;
  private readonly timer: {
    set: (callback: () => void, delay: number) => number;
    clear: (id: number) => void;
  };
  private readonly timers = new Map<string, number>();

  constructor(options: NotificationSchedulerOptions) {
    this.store = options.store;
    this.settingsStore = options.settingsStore;
    this.now = options.now ?? (() => new Date());
    this.deviceId = options.deviceId ?? 'device';
    this.autoSchedule = options.autoSchedule ?? true;
    this.systemAdapter =
      options.systemAdapter ?? new UnavailableSystemNotificationAdapter(isTauriRuntime());
    this.inAppDispatcher =
      options.inAppDispatcher ??
      ((plan) => {
        if (
          typeof window !== 'undefined' &&
          typeof window.dispatchEvent === 'function' &&
          typeof CustomEvent === 'function'
        ) {
          window.dispatchEvent(
            new CustomEvent(IN_APP_NOTIFICATION_EVENT, { detail: plan }),
          );
        }
      });
    this.timer =
      options.timer ??
      {
        set: (callback, delay) => setTimeout(callback, delay) as unknown as number,
        clear: (id) => clearTimeout(id),
      };
  }

  settings(): NotificationSettings {
    return this.settingsStore.load();
  }

  updateSettings(patch: Partial<NotificationSettings>): NotificationSettings {
    const current = this.settings();
    const next: NotificationSettings = {
      ...current,
      ...patch,
      quietHours: {
        ...current.quietHours,
        ...(patch.quietHours ?? {}),
      },
      dailyDigest: {
        ...current.dailyDigest,
        ...(patch.dailyDigest ?? {}),
      },
    };
    const saved = this.settingsStore.save(next);
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(
        new CustomEvent(NOTIFICATION_SETTINGS_CHANGED_EVENT, {
          detail: saved,
        }),
      );
    }
    return saved;
  }

  /**
   * 发送一条用户主动触发的测试通知。测试通知不写入计划/发送记录，也不受
   * 免打扰影响；但通道开关、权限与系统能力仍按真实情况返回结果。
   */
  async testNotification(): Promise<NotificationTestResult> {
    const settings = this.settings();
    const now = this.now();
    const plan: ReminderPlan = {
      id: `rem_test_${now.getTime()}`,
      ownerType: 'task',
      ownerId: 'test',
      channel: 'in-app',
      title: '知行测试通知',
      body: '这是一条测试通知：能看到它，说明当前通道可用。',
      triggerAt: now.toISOString(),
      timezone:
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      dedupeKey: `test|${now.getTime()}`,
      status: 'scheduled',
      explanation: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const outcomes: NotificationTestOutcome[] = [];
    for (const channel of enabledChannels(settings)) {
      const outcome = await this.deliver(
        { ...plan, channel },
        settings,
        now,
        { manual: true },
      );
      outcomes.push({
        channel,
        status: outcome.status,
        explanation: outcome.explanation,
      });
    }

    if (outcomes.length === 0) {
      return {
        ok: false,
        outcomes: [
          {
            channel: 'in-app',
            status: 'failed',
            explanation:
              '没有可用的通知通道。请先开启“应用内提醒”，或授权浏览器通知后再试。',
          },
        ],
      };
    }

    return {
      ok: outcomes.some((outcome) => outcome.status === 'sent'),
      outcomes,
    };
  }

  browserPermission(): NotificationPermissionState {
    return readBrowserPermission();
  }

  async requestBrowserPermission(): Promise<NotificationPermissionState> {
    const next = await requestBrowserPermission();
    return next;
  }

  async systemAvailable(): Promise<boolean> {
    return this.systemAdapter.available();
  }

  async getPlans(): Promise<ReminderPlan[]> {
    return this.store.listPlans();
  }

  async getDeliveries(): Promise<DeliveryRecord[]> {
    return this.store.listDeliveries();
  }

  async reconcile(tasks: ReadonlyArray<NotificationTask>): Promise<ReminderPlan[]> {
    const now = this.now();
    const settings = this.settings();
    const desired = buildReminderPlans(tasks, settings, {
      now,
      deviceId: this.deviceId,
      browserPermission: readBrowserPermission(),
      systemAvailable: await this.systemAdapter.available(),
    });
    const previous = await this.store.listPlans();
    const next = reconcilePlans(previous, desired, now);
    await this.store.savePlans(next);
    this.scheduleTimers(next);
    return next;
  }

  async checkNow(now = this.now()): Promise<ReminderPlan[]> {
    const settings = this.settings();
    const current = await this.store.listPlans();
    const byKey = new Map(current.map((plan) => [plan.dedupeKey, plan]));
    const delayed: ReminderPlan[] = [];

    for (const plan of current) {
      if (plan.status !== 'scheduled') continue;
      const trigger = new Date(plan.triggerAt);
      if (Number.isNaN(trigger.getTime()) || trigger.getTime() > now.getTime()) {
        continue;
      }
      const outcome = await this.deliver(plan, settings, now);
      const updated: ReminderPlan = {
        ...plan,
        status: outcome.status,
        explanation: outcome.explanation,
        updatedAt: now.toISOString(),
      };
      byKey.set(plan.dedupeKey, updated);
      await this.store.addDelivery({
        id: `del_${plan.dedupeKey}_${now.getTime()}`,
        planId: plan.id,
        dedupeKey: plan.dedupeKey,
        channel: plan.channel,
        title: plan.title,
        body: plan.body,
        status: outcome.status,
        at: now.toISOString(),
        explanation: outcome.explanation,
      });
      if (outcome.delayUntil) {
        const delayedPlan: ReminderPlan = {
          ...plan,
          id: `${plan.id}_quiet`,
          triggerAt: outcome.delayUntil.toISOString(),
          dedupeKey: `${plan.dedupeKey}|quiet`,
          status: 'scheduled',
          explanation: `免打扰时段已延后到 ${outcome.delayUntil.toISOString()}`,
          updatedAt: now.toISOString(),
        };
        byKey.set(delayedPlan.dedupeKey, delayedPlan);
        delayed.push(delayedPlan);
      }
    }

    const next = Array.from(byKey.values()).sort((a, b) =>
      a.triggerAt.localeCompare(b.triggerAt),
    );
    await this.store.savePlans(next);
    this.scheduleTimers(next);
    return next;
  }

  private async deliver(
    plan: ReminderPlan,
    settings: NotificationSettings,
    now: Date,
    options: { manual?: boolean } = {},
  ): Promise<DeliveryOutcome> {
    if (!channelEnabled(plan.channel, settings)) {
      return {
        status: 'suppressed',
        explanation: `${channelDisabledReason(plan.channel)}；计划已抑制`,
      };
    }
    // 用户点击“发送测试通知”是显式行为，不受“错过补发”和免打扰限制。
    if (!options.manual && isMissedPlan(plan, now)) {
      return {
        status: 'suppressed',
        explanation: '应用未运行，提醒已错过超过 5 分钟；不补发旧提醒',
      };
    }
    if (!options.manual && isInQuietHours(now, settings.quietHours)) {
      const delayUntil = quietHoursEnd(now, settings.quietHours);
      return {
        status: 'suppressed',
        explanation: `免打扰时段（${quietHoursLabel(settings.quietHours)}）内不发送，延后到 ${delayUntil.toISOString()}`,
        delayUntil,
      };
    }
    if (plan.channel === 'in-app') {
      try {
        this.inAppDispatcher(plan);
        return {
          status: 'sent',
          explanation: '已显示应用内提醒；没有调用系统通知',
        };
      } catch (reason) {
        return {
          status: 'failed',
          explanation: `应用内提醒失败：${
            reason instanceof Error ? reason.message : '未知错误'
          }`,
        };
      }
    }
    if (plan.channel === 'browser') {
      const permission = readBrowserPermission();
      if (permission === 'unsupported') {
        return {
          status: 'unsupported',
          explanation:
            '当前环境没有 Notification API；应用内提醒仍然可用，系统通知不保证',
        };
      }
      if (permission === 'denied') {
        return {
          status: 'blocked',
          explanation:
            '浏览器通知权限已被拒绝。请在站点设置中重新允许；应用内提醒仍然可用。',
        };
      }
      if (permission === 'default') {
        return {
          status: 'blocked',
          explanation:
            '尚未授予浏览器通知权限。请点击“开启浏览器通知”后再试；不会自动弹窗。',
        };
      }
      try {
        const api = notificationApi();
        if (!api) throw new Error('Notification API 不可用');
        new api(
          settings.lockScreenPrivacy ? '知行 · 待办提醒' : plan.title,
          {
            body: settings.lockScreenPrivacy
              ? '锁屏隐私已开启，打开知行查看详情'
              : plan.body,
            silent: !settings.sound,
            tag: plan.dedupeKey,
          },
        );
        return {
          status: 'sent',
          explanation: '浏览器已接受通知；系统策略仍可能延迟或丢弃，不承诺必达',
        };
      } catch (reason) {
        return {
          status: 'failed',
          explanation: `浏览器通知发送失败：${
            reason instanceof Error ? reason.message : '未知错误'
          }`,
        };
      }
    }

    const available = await this.systemAdapter.available();
    if (!available) {
      const result = await this.systemAdapter.send(plan, settings);
      return {
        status: 'unsupported',
        explanation: result.explanation,
      };
    }
    const result = await this.systemAdapter.send(plan, settings);
    return {
      status: result.ok ? 'sent' : 'failed',
      explanation: result.explanation,
    };
  }

  private scheduleTimers(plans: ReadonlyArray<ReminderPlan>): void {
    for (const id of this.timers.values()) {
      this.timer.clear(id);
    }
    this.timers.clear();
    if (!this.autoSchedule) return;
    const now = this.now().getTime();
    for (const plan of plans) {
      if (plan.status !== 'scheduled') continue;
      const trigger = new Date(plan.triggerAt).getTime();
      if (Number.isNaN(trigger) || trigger <= now) continue;
      const delay = Math.min(trigger - now, MAX_TIMEOUT);
      const id = this.timer.set(() => {
        void this.checkNow(new Date());
      }, delay);
      this.timers.set(plan.dedupeKey, id);
    }
  }

  stop(): void {
    for (const id of this.timers.values()) {
      this.timer.clear(id);
    }
    this.timers.clear();
  }

  async reset(): Promise<void> {
    this.stop();
    await this.store.clear();
  }
}

function quietHoursEnd(
  now: Date,
  quiet: NotificationSettings['quietHours'],
): Date {
  const [endHour, endMinute] = quiet.end.split(':').map(Number);
  const end = new Date(now);
  end.setHours(endHour ?? 8, endMinute ?? 0, 0, 0);
  if (end.getTime() <= now.getTime()) {
    end.setDate(end.getDate() + 1);
  }
  return end;
}

export function createNotificationScheduler(
  options: NotificationSchedulerOptions,
): NotificationScheduler {
  return new NotificationScheduler(options);
}
