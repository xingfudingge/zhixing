import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationRuntime } from '../NotificationRuntime';
import {
  IN_APP_NOTIFICATION_EVENT,
  NotificationScheduler,
} from '../scheduler';
import { MemoryNotificationSettingsStore } from '../settings';
import { MemoryNotificationPlanStore } from '../store';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationTask,
  type ReminderPlan,
} from '../types';

const TASK: NotificationTask = {
  id: 'task-1',
  title: '提交方案',
  status: 'todo',
  dueDate: '2026-10-26',
  dueTime: '15:00',
  dueAt: '2026-10-26T15:00:00.000Z',
  tz: 'UTC',
  reminder: '提前 5 分钟',
  deletedAt: null,
};

function makeScheduler(current: Date) {
  return new NotificationScheduler({
    store: new MemoryNotificationPlanStore(),
    settingsStore: new MemoryNotificationSettingsStore({
      ...DEFAULT_NOTIFICATION_SETTINGS,
      inApp: true,
    }),
    now: () => current,
    deviceId: 'device-test',
    autoSchedule: false,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('应用级通知运行时', () => {
  it('任务到点后通过调度器触发应用内提醒', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const current = new Date('2026-10-26T14:56:00.000Z');
    const scheduler = makeScheduler(current);
    const loadTasks = vi.fn(async () => [TASK]);

    render(
      <NotificationRuntime
        scheduler={scheduler}
        loadTasks={loadTasks}
        now={() => current}
        pollIntervalMs={1_000_000}
      />,
    );

    expect(
      await screen.findByRole('status', { name: '应用内提醒' }),
    ).toBeInTheDocument();
    expect(screen.getByText('提交方案')).toBeInTheDocument();
    expect(screen.getByText(/到期：/)).toBeInTheDocument();
    expect(loadTasks).toHaveBeenCalled();
    const plans = await scheduler.getPlans();
    expect(plans[0]?.status).toBe('sent');
  });

  it('同一去重键只渲染一条应用内提醒', async () => {
    const current = new Date('2026-10-26T14:56:00.000Z');
    const scheduler = makeScheduler(current);
    const plan: ReminderPlan = {
      id: 'rem_test',
      ownerType: 'task',
      ownerId: 'task-1',
      channel: 'in-app',
      title: '重复提醒',
      body: '只应出现一次',
      triggerAt: current.toISOString(),
      timezone: 'UTC',
      dedupeKey: 'same-key',
      status: 'scheduled',
      explanation: null,
      createdAt: current.toISOString(),
      updatedAt: current.toISOString(),
    };

    render(
      <NotificationRuntime
        scheduler={scheduler}
        loadTasks={async () => []}
        now={() => current}
        pollIntervalMs={1_000_000}
      />,
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(IN_APP_NOTIFICATION_EVENT, { detail: plan }),
      );
      window.dispatchEvent(
        new CustomEvent(IN_APP_NOTIFICATION_EVENT, { detail: plan }),
      );
    });

    const region = await screen.findByRole('status', {
      name: '应用内提醒',
    });
    await waitFor(() => {
      expect(within(region).getAllByText('重复提醒')).toHaveLength(1);
    });
  });
});
