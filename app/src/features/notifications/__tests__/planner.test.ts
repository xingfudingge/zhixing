import { describe, expect, it } from 'vitest';

import {
  buildReminderPlans,
  buildTaskReminderPlans,
  isInQuietHours,
  parseReminderOffsetMinutes,
  reconcilePlans,
  taskDueInstant,
  zonedDateTimeToUtc,
} from '../planner';
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
    tz: 'Asia/Shanghai',
    reminder: '提前 15 分钟',
    deletedAt: null,
    ...overrides,
  };
}

function settings(patch: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    ...DEFAULT_NOTIFICATION_SETTINGS,
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

const context = {
  now: new Date('2026-10-26T10:00:00.000Z'),
  deviceId: 'device-a',
  browserPermission: 'granted' as const,
  systemAvailable: false,
};

describe('提醒解析与计划生成', () => {
  it('解析提前量，未知值不产生计划', () => {
    expect(parseReminderOffsetMinutes('提前 15 分钟')).toBe(15);
    expect(parseReminderOffsetMinutes('提前1小时')).toBe(60);
    expect(parseReminderOffsetMinutes('提前 2 天')).toBe(2880);
    expect(parseReminderOffsetMinutes('提前 1 周')).toBe(10080);
    expect(parseReminderOffsetMinutes('半小时前')).toBe(30);
    expect(parseReminderOffsetMinutes('准时')).toBe(0);
    expect(parseReminderOffsetMinutes('')).toBeNull();
    expect(parseReminderOffsetMinutes('随便')).toBeNull();
  });

  it('任务到期时间优先 dueAt；无 dueAt 时按 IANA 时区换算', () => {
    expect(taskDueInstant(task())?.toISOString()).toBe(
      '2026-10-26T15:00:00.000Z',
    );
    expect(
      taskDueInstant(
        task({ dueAt: null, dueDate: '2026-10-26', dueTime: '15:00' }),
      )?.toISOString(),
    ).toBe('2026-10-26T07:00:00.000Z');
    expect(
      zonedDateTimeToUtc('2026-10-26', '15:00', 'Asia/Shanghai')?.toISOString(),
    ).toBe('2026-10-26T07:00:00.000Z');
  });

  it('为每个启用通道生成计划，去重键包含到期时间与设备', () => {
    const plans = buildTaskReminderPlans(
      [task()],
      settings({ inApp: true, browser: true }),
      context,
    );
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({
      ownerType: 'task',
      ownerId: 'task-1',
      triggerAt: '2026-10-26T14:45:00.000Z',
      status: 'scheduled',
    });
    expect(plans.map((plan) => plan.channel).sort()).toEqual([
      'browser',
      'in-app',
    ]);
    expect(plans[0]?.dedupeKey).toContain('2026-10-26T15:00:00.000Z');
    expect(plans[0]?.dedupeKey).toContain('device-a');
  });

  it('完成/删除/无提醒的任务不生成计划', () => {
    const plans = buildTaskReminderPlans(
      [
        task({ id: 'done', status: 'done' }),
        task({ id: 'deleted', deletedAt: '2026-10-01T00:00:00.000Z' }),
        task({ id: 'none', reminder: '' }),
      ],
      settings(),
      context,
    );
    expect(plans).toEqual([]);
  });

  it('每日摘要在设定时间生成，摘要只读任务列表', () => {
    const plans = buildReminderPlans(
      [
        task({ id: 'today', dueDate: '2026-10-26' }),
        task({ id: 'overdue', dueDate: '2026-10-20' }),
      ],
      settings({
        inApp: true,
        browser: false,
        system: false,
        dailyDigest: { enabled: true, time: '09:00' },
      }),
      { ...context, now: new Date('2026-10-26T00:00:00.000Z') },
    );
    const digest = plans.find((plan) => plan.ownerType === 'digest');
    expect(digest).toMatchObject({
      title: '今日摘要',
      channel: 'in-app',
    });
    expect(digest?.body).toContain('逾期 1 项');
    expect(digest?.triggerAt).toBe('2026-10-26T01:00:00.000Z');
  });

  it('改期后旧计划撤销，新计划使用新的去重键', () => {
    const first = buildTaskReminderPlans([task()], settings(), context);
    const rescheduled = buildTaskReminderPlans(
      [task({ dueAt: '2026-10-27T15:00:00.000Z', dueDate: '2026-10-27' })],
      settings(),
      context,
    );
    const merged = reconcilePlans(first, rescheduled, context.now);
    const oldPlan = merged.find(
      (plan) => plan.triggerAt === '2026-10-26T14:45:00.000Z',
    );
    expect(oldPlan?.status).toBe('canceled');
    expect(oldPlan?.explanation).toContain('改期');
    const newPlan = merged.find(
      (plan) => plan.triggerAt === '2026-10-27T14:45:00.000Z',
    );
    expect(newPlan?.status).toBe('scheduled');
  });

  it('已发送计划不会因重新调和而重置为待触发', () => {
    const plans = buildTaskReminderPlans([task()], settings(), context);
    const sent = plans.map((plan) => ({ ...plan, status: 'sent' as const }));
    const again = buildTaskReminderPlans([task()], settings(), context);
    const merged = reconcilePlans(sent, again, context.now);
    expect(merged.every((plan) => plan.status === 'sent')).toBe(true);
  });

  it('免打扰跨午夜判断', () => {
    const quiet = { enabled: true, start: '22:00', end: '08:00' };
    expect(isInQuietHours(new Date(2026, 9, 26, 23, 30), quiet)).toBe(true);
    expect(isInQuietHours(new Date(2026, 9, 26, 7, 30), quiet)).toBe(true);
    expect(isInQuietHours(new Date(2026, 9, 26, 8, 0), quiet)).toBe(false);
    expect(isInQuietHours(new Date(2026, 9, 26, 12, 0), quiet)).toBe(false);
    expect(
      isInQuietHours(new Date(2026, 9, 26, 23, 0), {
        ...quiet,
        enabled: false,
      }),
    ).toBe(false);
  });
});
