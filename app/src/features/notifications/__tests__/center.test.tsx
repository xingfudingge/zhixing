import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationCenter } from '../NotificationCenter';
import { NotificationScheduler } from '../scheduler';
import { MemoryNotificationSettingsStore } from '../settings';
import { MemoryNotificationPlanStore } from '../store';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  type NotificationTask,
} from '../types';

const TASKS: NotificationTask[] = [
  {
    id: 'task-1',
    title: '提交方案',
    status: 'todo',
    dueDate: '2026-10-26',
    dueTime: '15:00',
    dueAt: '2026-10-26T15:00:00.000Z',
    tz: 'UTC',
    reminder: '提前 5 分钟',
    deletedAt: null,
  },
];

function setup(options: {
  current?: Date;
  settings?: Partial<NotificationSettings>;
} = {}) {
  let current = options.current ?? new Date('2026-10-26T14:54:00.000Z');
  const store = new MemoryNotificationPlanStore();
  const settingsStore = new MemoryNotificationSettingsStore({
    ...DEFAULT_NOTIFICATION_SETTINGS,
    inApp: true,
    ...options.settings,
  });
  const dispatch = vi.fn();
  const scheduler = new NotificationScheduler({
    store,
    settingsStore,
    now: () => current,
    deviceId: 'device-a',
    autoSchedule: false,
    inAppDispatcher: dispatch,
  });
  return {
    scheduler,
    dispatch,
    setNow: (date: Date) => {
      current = date;
    },
  };
}

afterEach(() => {
  delete (globalThis as { Notification?: unknown }).Notification;
});

function installNotification(options: {
  permission: 'default' | 'granted' | 'denied';
  request?: () => Promise<'granted' | 'denied' | 'default'>;
}) {
  class FakeNotification {
    static permission = options.permission;
    static requestPermission = vi.fn(
      options.request ?? (async () => options.permission),
    );
    constructor() {
      // no-op
    }
  }
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    writable: true,
    value: FakeNotification,
  });
  return FakeNotification;
}

describe('通知中心 UI', () => {
  it('展示权限说明、待触发计划与不承诺必达提示', async () => {
    installNotification({ permission: 'default' });
    const { scheduler } = setup();
    render(
      <NotificationCenter
        scheduler={scheduler}
        tasks={TASKS}
        now={() => new Date('2026-10-26T14:54:00.000Z')}
      />,
    );

    expect(await screen.findByText('提交方案')).toBeInTheDocument();
    expect(screen.getAllByText(/应用内/).length).toBeGreaterThan(0);
    expect(screen.getByText(/不承诺必达/)).toBeInTheDocument();
    expect(screen.getByText('浏览器权限：未请求')).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /^应用内提醒/ }),
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /^浏览器通知/ }),
    ).not.toBeChecked();
  });

  it('请求浏览器权限只发生在点击开启时；拒绝后说明站点设置', async () => {
    const FakeNotification = installNotification({ permission: 'denied' });
    const { scheduler } = setup();
    const user = userEvent.setup();
    render(
      <NotificationCenter scheduler={scheduler} tasks={TASKS} />,
    );
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('checkbox', { name: /^浏览器通知/ }),
    );
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(
      screen.getByRole('checkbox', { name: /^浏览器通知/ }),
    ).not.toBeChecked();
    expect(
      (await screen.findAllByText(/请在浏览器站点设置中重新允许/)).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/应用内提醒仍然可用/).length,
    ).toBeGreaterThan(0);
  });

  it('授予权限后开启浏览器通道，并立即检查到点应用内提醒', async () => {
    installNotification({ permission: 'default', request: async () => 'granted' });
    const { scheduler, dispatch, setNow } = setup();
    const user = userEvent.setup();
    render(
      <NotificationCenter
        scheduler={scheduler}
        tasks={TASKS}
        now={() => new Date('2026-10-26T14:55:00.000Z')}
      />,
    );
    await user.click(
      screen.getByRole('checkbox', { name: /^浏览器通知/ }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole('checkbox', { name: /^浏览器通知/ }),
      ).toBeChecked();
    });

    setNow(new Date('2026-10-26T14:55:00.000Z'));
    await user.click(
      screen.getByRole('button', { name: '立即检查到点提醒' }),
    );
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(
      (await screen.findAllByText('已发送（不保证送达）')).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/必达/).length).toBeGreaterThan(0);
  });
});
