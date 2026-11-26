import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationScheduler } from '../scheduler';
import { MemoryNotificationSettingsStore } from '../settings';
import { MemoryNotificationPlanStore } from '../store';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  type NotificationTask,
} from '../types';

function task(overrides: Partial<NotificationTask> = {}): NotificationTask {
  return {
    id: 'task-1',
    title: '提交方案',
    status: 'todo',
    dueDate: '2026-10-26',
    dueTime: '15:00',
    dueAt: '2026-10-26T15:00:00.000Z',
    tz: 'UTC',
    reminder: '提前 5 分钟',
    deletedAt: null,
    ...overrides,
  };
}

function settings(patch: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    inApp: true,
    browser: false,
    system: false,
    ...patch,
    quietHours: {
      ...DEFAULT_NOTIFICATION_SETTINGS.quietHours,
      ...(patch.quietHours ?? {}),
    },
    dailyDigest: {
      ...DEFAULT_NOTIFICATION_SETTINGS.dailyDigest,
      ...(patch.dailyDigest ?? {}),
    },
  };
}

function setup(options: {
  current: Date;
  settings?: NotificationSettings;
  adapter?: {
    available: () => Promise<boolean>;
    send: () => Promise<{ ok: boolean; explanation: string }>;
  };
}) {
  let current = options.current;
  const store = new MemoryNotificationPlanStore();
  const settingsStore = new MemoryNotificationSettingsStore(
    options.settings ?? settings(),
  );
  const dispatch = vi.fn();
  const scheduler = new NotificationScheduler({
    store,
    settingsStore,
    now: () => current,
    deviceId: 'device-a',
    autoSchedule: false,
    inAppDispatcher: dispatch,
    systemAdapter: options.adapter,
  });
  return {
    scheduler,
    store,
    settingsStore,
    dispatch,
    setNow: (date: Date) => {
      current = date;
    },
  };
}

afterEach(() => {
  delete (globalThis as { Notification?: unknown }).Notification;
  vi.restoreAllMocks();
});

function installNotification(options: {
  permission: 'default' | 'granted' | 'denied';
  request?: () => Promise<'default' | 'granted' | 'denied'>;
}) {
  const instances: { title: string; body?: string; silent?: boolean }[] = [];
  class FakeNotification {
    static permission = options.permission;
    static requestPermission = vi.fn(
      options.request ?? (async () => options.permission),
    );
    constructor(title: string, init?: { body?: string; silent?: boolean }) {
      instances.push({ title, body: init?.body, silent: init?.silent });
    }
  }
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    writable: true,
    value: FakeNotification,
  });
  return { FakeNotification, instances };
}

describe('通知计划器', () => {
  it('到点发送应用内提醒并记录；重复检查不会重复发送', async () => {
    const current = new Date('2026-10-26T14:54:00.000Z');
    const { scheduler, dispatch, setNow } = setup({ current });
    const plans = await scheduler.reconcile([task()]);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.status).toBe('scheduled');

    await scheduler.checkNow();
    expect(dispatch).not.toHaveBeenCalled();

    setNow(new Date('2026-10-26T14:55:00.000Z'));
    const fired = await scheduler.checkNow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(fired[0]?.status).toBe('sent');
    const deliveries = await scheduler.getDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe('sent');

    await scheduler.checkNow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await scheduler.getDeliveries()).toHaveLength(1);
  });

  it('任务改期会撤销旧计划并生成新计划', async () => {
    const current = new Date('2026-10-26T10:00:00.000Z');
    const { scheduler } = setup({ current });
    await scheduler.reconcile([task()]);
    const rescheduled = await scheduler.reconcile([
      task({
        dueAt: '2026-10-27T15:00:00.000Z',
        dueDate: '2026-10-27',
      }),
    ]);
    const oldPlan = rescheduled.find(
      (plan) => plan.triggerAt === '2026-10-26T14:55:00.000Z',
    );
    expect(oldPlan?.status).toBe('canceled');
    expect(
      rescheduled.filter((plan) => plan.status === 'scheduled'),
    ).toHaveLength(1);
    expect(
      rescheduled.find((plan) => plan.status === 'scheduled')?.triggerAt,
    ).toBe('2026-10-27T14:55:00.000Z');
  });

  it('任务完成后撤销待触发提醒', async () => {
    const { scheduler } = setup({
      current: new Date('2026-10-26T10:00:00.000Z'),
    });
    await scheduler.reconcile([task()]);
    const after = await scheduler.reconcile([task({ status: 'done' })]);
    expect(after.every((plan) => plan.status !== 'scheduled')).toBe(true);
    expect(after[0]?.explanation).toContain('撤销');
  });

  it('权限被拒绝时不发送浏览器通知，并给出站点设置说明', async () => {
    const { FakeNotification } = installNotification({ permission: 'denied' });
    const { scheduler, setNow } = setup({
      current: new Date('2026-10-26T14:54:00.000Z'),
      settings: settings({ inApp: false, browser: true }),
    });
    await scheduler.reconcile([task()]);
    setNow(new Date('2026-10-26T14:55:00.000Z'));
    const plans = await scheduler.checkNow();
    expect(plans[0]?.status).toBe('blocked');
    expect(plans[0]?.explanation).toContain('站点设置');
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    const deliveries = await scheduler.getDeliveries();
    expect(deliveries[0]?.status).toBe('blocked');
  });

  it('浏览器权限只在显式调用时请求；允许后发送并遵守锁屏隐私', async () => {
    const { FakeNotification } = installNotification({
      permission: 'default',
      request: async () => 'granted',
    });
    const { scheduler, setNow } = setup({
      current: new Date('2026-10-26T14:54:00.000Z'),
      settings: settings({
        inApp: false,
        browser: true,
        lockScreenPrivacy: true,
      }),
    });
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    await expect(scheduler.requestBrowserPermission()).resolves.toBe('granted');
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);

    const second = installNotification({ permission: 'granted' });
    await scheduler.reconcile([task()]);
    setNow(new Date('2026-10-26T14:55:00.000Z'));
    const plans = await scheduler.checkNow();
    expect(plans[0]?.status).toBe('sent');
    expect(second.instances[0]).toMatchObject({
      title: '知行 · 待办提醒',
      body: '锁屏隐私已开启，打开知行查看详情',
      silent: true,
    });
  });

  it('系统通知未接入时标记 unsupported，不影响应用内通道', async () => {
    const { scheduler, setNow } = setup({
      current: new Date('2026-10-26T14:54:00.000Z'),
      settings: settings({ inApp: true, browser: false, system: true }),
    });
    await scheduler.reconcile([task()]);
    setNow(new Date('2026-10-26T14:55:00.000Z'));
    const plans = await scheduler.checkNow();
    const systemPlan = plans.find((plan) => plan.channel === 'system');
    expect(systemPlan?.status).toBe('unsupported');
    expect(systemPlan?.explanation).toMatch(/原生通知插件|系统通知适配器/);
    const inAppPlan = plans.find((plan) => plan.channel === 'in-app');
    expect(inAppPlan?.status).toBe('sent');
  });

  it('免打扰内抑制并延后到结束时间，结束后可发送', async () => {
    const due = new Date(2026, 9, 26, 23, 40);
    const trigger = new Date(2026, 9, 26, 23, 35);
    const { scheduler, dispatch, setNow } = setup({
      current: new Date(2026, 9, 26, 23, 34),
      settings: settings({
        inApp: true,
        quietHours: { enabled: true, start: '22:00', end: '08:00' },
      }),
    });
    await scheduler.reconcile([
      task({
        dueAt: due.toISOString(),
        dueDate: '2026-10-26',
        dueTime: '23:40',
      }),
    ]);
    setNow(trigger);
    const plans = await scheduler.checkNow();
    expect(dispatch).not.toHaveBeenCalled();
    const suppressed = plans.find(
      (plan) => plan.triggerAt === trigger.toISOString(),
    );
    expect(suppressed?.status).toBe('suppressed');
    const delayed = plans.find((plan) => plan.dedupeKey.endsWith('|quiet'));
    expect(delayed?.status).toBe('scheduled');
    const end = new Date(delayed!.triggerAt);
    expect(end.getHours()).toBe(8);
    expect(end.getMinutes()).toBe(0);

    setNow(new Date(2026, 9, 27, 8, 1));
    await scheduler.checkNow();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('错过超过 5 分钟不补发旧提醒', async () => {
    const { scheduler, dispatch, setNow } = setup({
      current: new Date('2026-10-26T14:54:00.000Z'),
    });
    await scheduler.reconcile([task()]);
    setNow(new Date('2026-10-26T15:10:00.000Z'));
    const plans = await scheduler.checkNow();
    expect(plans[0]?.status).toBe('suppressed');
    expect(plans[0]?.explanation).toContain('错过');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('每日摘要只发送一次，重复检查不重复记录', async () => {
    const { scheduler, dispatch, setNow } = setup({
      // 00:50Z = 08:50 Asia/Shanghai；摘要定在本地 09:00（01:00Z）。
      current: new Date('2026-10-26T00:50:00.000Z'),
      settings: settings({
        inApp: true,
        dailyDigest: { enabled: true, time: '09:00' },
      }),
    });
    await scheduler.reconcile([
      task({ dueDate: '2026-10-26', dueAt: '2026-10-26T15:00:00.000Z' }),
    ]);
    setNow(new Date('2026-10-26T01:00:00.000Z'));
    await scheduler.checkNow();
    await scheduler.checkNow();
    expect(dispatch).toHaveBeenCalledTimes(1);
    const deliveries = await scheduler.getDeliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.title).toBe('今日摘要');
  });

  it('免打扰延迟计划不会被重新调和撤销', async () => {
    const due = new Date(2026, 9, 26, 23, 40);
    const trigger = new Date(2026, 9, 26, 23, 35);
    const { scheduler, dispatch, setNow } = setup({
      current: new Date(2026, 9, 26, 23, 34),
      settings: settings({
        inApp: true,
        quietHours: { enabled: true, start: '22:00', end: '08:00' },
      }),
    });
    const dueTask = task({
      dueAt: due.toISOString(),
      dueDate: '2026-10-26',
      dueTime: '23:40',
    });
    await scheduler.reconcile([dueTask]);
    setNow(trigger);
    await scheduler.checkNow();
    expect(dispatch).not.toHaveBeenCalled();

    // 运行时每 30 秒重新调和；延迟计划必须继续存在。
    const reconciled = await scheduler.reconcile([dueTask]);
    const delayed = reconciled.find((plan) =>
      plan.dedupeKey.endsWith('|quiet'),
    );
    expect(delayed?.status).toBe('scheduled');
    expect(new Date(delayed!.triggerAt).getHours()).toBe(8);

    setNow(new Date(2026, 9, 27, 8, 1));
    await scheduler.checkNow();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('发送测试通知：应用内通道可用且不受免打扰影响', async () => {
    const { scheduler, dispatch } = setup({
      current: new Date(2026, 9, 26, 23, 30),
      settings: settings({
        inApp: true,
        quietHours: { enabled: true, start: '22:00', end: '08:00' },
      }),
    });
    const result = await scheduler.testNotification();
    expect(result.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.outcomes[0]).toMatchObject({
      channel: 'in-app',
      status: 'sent',
    });
    expect(await scheduler.getPlans()).toEqual([]);
    expect(await scheduler.getDeliveries()).toEqual([]);
  });

  it('发送测试通知：没有通道时明确失败并给出引导', async () => {
    const { scheduler, dispatch } = setup({
      current: new Date('2026-10-26T14:54:00.000Z'),
      settings: settings({ inApp: false, browser: false, system: false }),
    });
    const result = await scheduler.testNotification();
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]?.status).toBe('failed');
    expect(result.outcomes[0]?.explanation).toContain('没有可用的通知通道');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('发送测试通知：权限拒绝时明确 blocked，不伪造成功', async () => {
    installNotification({ permission: 'denied' });
    const { scheduler } = setup({
      current: new Date('2026-10-26T14:54:00.000Z'),
      settings: settings({ inApp: false, browser: true }),
    });
    const result = await scheduler.testNotification();
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]).toMatchObject({
      channel: 'browser',
      status: 'blocked',
    });
    expect(result.outcomes[0]?.explanation).toContain('站点设置');
  });

  it('发送测试通知：系统通道不可用时标记 unsupported', async () => {
    const { scheduler } = setup({
      current: new Date('2026-10-26T14:54:00.000Z'),
      settings: settings({ inApp: false, browser: false, system: true }),
    });
    const result = await scheduler.testNotification();
    expect(result.ok).toBe(false);
    expect(result.outcomes[0]).toMatchObject({
      channel: 'system',
      status: 'unsupported',
    });
  });
});
