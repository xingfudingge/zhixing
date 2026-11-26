import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../../../data/db/client';
import type { NewTask, Task } from '../../../data/db/types';
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from '../../../data/repositories/settings';
import { NotificationScheduler } from '../../notifications/scheduler';
import { MemoryNotificationSettingsStore } from '../../notifications/settings';
import { MemoryNotificationPlanStore } from '../../notifications/store';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationTask,
} from '../../notifications/types';
import { buildTaskReminderPlans } from '../../notifications/planner';
import { createQuickAddSource } from '../../quickAdd/source';
import { setRuntimeSettings } from '../../settings/runtime';
import { applyDefaultReminder } from '../reminders';
import { installTaskReminderDefaultsBridge } from '../reminderDefaults';

const createdAt = '2026-11-01T08:00:00.000Z';

function taskFromInput(input: NewTask, index: number): Task {
  return {
    id: `task-${index}`,
    spaceId: 'personal',
    listId: input.listId,
    parentId: input.parentId ?? null,
    noteId: input.noteId ?? null,
    title: input.title,
    notes: input.notes ?? '',
    status: input.status ?? 'todo',
    priority: input.priority ?? 0,
    quadrant: input.quadrant ?? 4,
    dueDate: input.dueDate ?? null,
    dueTime: input.dueTime ?? null,
    dueAt: input.dueAt ?? null,
    tz: input.tz ?? 'UTC',
    reminder: input.reminder ?? '',
    sortOrder: input.sortOrder ?? 0,
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    version: 1,
  };
}

function fakeClient() {
  const inputs: NewTask[] = [];
  const client = {
    tasks: {
      create: async (input: NewTask) => {
        inputs.push(input);
        return taskFromInput(input, inputs.length);
      },
    },
  } as unknown as DbClient;
  return { client, inputs };
}

function settingsWithTask(
  patch: Partial<AppSettings['task']>,
): AppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    task: { ...DEFAULT_APP_SETTINGS.task, ...patch },
  };
}

const dueTask: NewTask = {
  title: '提交方案',
  listId: 'work',
  status: 'todo',
  dueDate: '2026-11-02',
  dueTime: '10:00',
  dueAt: '2026-11-02T10:00:00.000Z',
  tz: 'UTC',
};

beforeEach(() => {
  window.localStorage.clear();
  setRuntimeSettings(DEFAULT_APP_SETTINGS);
});

afterEach(() => {
  setRuntimeSettings(DEFAULT_APP_SETTINGS);
  window.localStorage.clear();
  delete (globalThis as { Notification?: unknown }).Notification;
});

describe('默认提醒纯函数', () => {
  it('默认关闭时不写提醒', () => {
    const result = applyDefaultReminder(dueTask, '');
    expect(result).toBe(dueTask);
    expect(result.reminder).toBeUndefined();
  });

  it('有日期新任务写入默认提醒', () => {
    expect(applyDefaultReminder(dueTask, '15m').reminder).toBe('15m');
    expect(applyDefaultReminder(dueTask, '提前 30 分钟').reminder).toBe('30m');
  });

  it('无日期任务不写提醒', () => {
    const undated = { ...dueTask, dueDate: null, dueTime: null, dueAt: null };
    expect(applyDefaultReminder(undated, '15m')).toBe(undated);
  });

  it('调用方显式设置的提醒（含不提醒）不被覆盖', () => {
    expect(applyDefaultReminder({ ...dueTask, reminder: '30m' }, '15m').reminder).toBe(
      '30m',
    );
    expect(applyDefaultReminder({ ...dueTask, reminder: '' }, '15m').reminder).toBe(
      '',
    );
    expect(
      applyDefaultReminder({ ...dueTask, reminder: 'none' }, '15m').reminder,
    ).toBe('none');
  });
});

describe('默认提醒创建桥', () => {
  it('设置后新任务写入提醒，且已有任务不被回填', async () => {
    const { client, inputs } = fakeClient();
    setRuntimeSettings(settingsWithTask({ defaultReminder: '' }));
    installTaskReminderDefaultsBridge(client);

    await client.tasks.create({ ...dueTask, title: '旧任务' });

    setRuntimeSettings(settingsWithTask({ defaultReminder: '15m' }));
    await client.tasks.create({ ...dueTask, title: '新任务' });

    expect(inputs[0]?.reminder).toBeUndefined();
    expect(inputs[1]?.reminder).toBe('15m');
  });

  it('快速创建同样经过创建桥', async () => {
    const { client, inputs } = fakeClient();
    setRuntimeSettings(settingsWithTask({ defaultReminder: '30m' }));
    installTaskReminderDefaultsBridge(client);
    const quick = createQuickAddSource(client);

    await quick.createTask({ ...dueTask, title: '快速收集' });

    expect(inputs[0]?.reminder).toBe('30m');
  });

  it('同一 client 只安装一次', async () => {
    const { client, inputs } = fakeClient();
    setRuntimeSettings(settingsWithTask({ defaultReminder: '1h' }));
    installTaskReminderDefaultsBridge(client);
    installTaskReminderDefaultsBridge(client);

    await client.tasks.create(dueTask);

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.reminder).toBe('1h');
  });
});

describe('与现有通知调度器衔接', () => {
  it('默认关闭不排程；设置后新任务生成待触发计划', async () => {
    const { client, inputs } = fakeClient();
    installTaskReminderDefaultsBridge(client);
    const now = new Date('2026-11-02T09:00:00.000Z');

    await client.tasks.create({ ...dueTask, title: '无提醒' });
    const offTask: NotificationTask = {
      id: 'off',
      title: '无提醒',
      status: 'todo',
      dueDate: inputs[0]?.dueDate ?? null,
      dueTime: inputs[0]?.dueTime ?? null,
      dueAt: inputs[0]?.dueAt ?? null,
      tz: inputs[0]?.tz ?? 'UTC',
      reminder: inputs[0]?.reminder ?? '',
      deletedAt: null,
    };
    expect(
      buildTaskReminderPlans(
        [offTask],
        DEFAULT_NOTIFICATION_SETTINGS,
        {
          now,
          deviceId: 'device-a',
          browserPermission: 'granted',
          systemAvailable: false,
        },
      ),
    ).toHaveLength(0);

    setRuntimeSettings(settingsWithTask({ defaultReminder: '15m' }));
    await client.tasks.create({ ...dueTask, title: '有提醒' });
    const onTask: NotificationTask = {
      ...offTask,
      id: 'on',
      title: '有提醒',
      reminder: inputs[1]?.reminder ?? '',
    };
    const plans = buildTaskReminderPlans(
      [onTask],
      DEFAULT_NOTIFICATION_SETTINGS,
      {
        now,
        deviceId: 'device-a',
        browserPermission: 'granted',
        systemAvailable: false,
      },
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]?.status).toBe('scheduled');
    expect(plans[0]?.triggerAt).toBe('2026-11-02T09:45:00.000Z');
  });

  it('浏览器权限被拒绝时标记权限阻止，不伪造已发送', async () => {
    const { client, inputs } = fakeClient();
    setRuntimeSettings(settingsWithTask({ defaultReminder: '15m' }));
    installTaskReminderDefaultsBridge(client);
    await client.tasks.create(dueTask);

    class DeniedNotification {
      static permission: NotificationPermission = 'denied';
      static requestPermission = vi.fn(async () => 'denied' as const);
    }
    (globalThis as { Notification?: unknown }).Notification =
      DeniedNotification;

    const scheduler = new NotificationScheduler({
      store: new MemoryNotificationPlanStore(),
      settingsStore: new MemoryNotificationSettingsStore({
        ...DEFAULT_NOTIFICATION_SETTINGS,
        inApp: false,
        browser: true,
      }),
      now: () => new Date('2026-11-02T09:50:00.000Z'),
      deviceId: 'device-a',
      autoSchedule: false,
      inAppDispatcher: () => undefined,
    });
    const task: NotificationTask = {
      id: 'task-1',
      title: inputs[0]?.title ?? '',
      status: 'todo',
      dueDate: inputs[0]?.dueDate ?? null,
      dueTime: inputs[0]?.dueTime ?? null,
      dueAt: inputs[0]?.dueAt ?? null,
      tz: inputs[0]?.tz ?? 'UTC',
      reminder: inputs[0]?.reminder ?? '',
      deletedAt: null,
    };

    await scheduler.reconcile([task]);
    const plans = await scheduler.checkNow(
      new Date('2026-11-02T09:50:00.000Z'),
    );

    expect(plans[0]?.status).toBe('blocked');
    expect(plans[0]?.explanation).toContain('权限已被拒绝');
    const deliveries = await scheduler.getDeliveries();
    expect(deliveries[0]?.status).toBe('blocked');
  });
});
