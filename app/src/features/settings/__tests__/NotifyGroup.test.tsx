import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotifyGroup } from '../groups/NotifyGroup';
import {
  NotificationScheduler,
  NOTIFICATION_SETTINGS_KEY,
  LocalStorageNotificationSettingsStore,
  LocalStorageNotificationPlanStore,
  MemoryNotificationSettingsStore,
  MemoryNotificationPlanStore,
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
} from '../../notifications';

function installNotification(permission: 'default' | 'granted' | 'denied') {
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => permission);
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

function makeScheduler(options: {
  now?: Date;
  settings?: NotificationSettings;
  persistent?: boolean;
  dispatch?: (plan: unknown) => void;
}) {
  const now = options.now ?? new Date('2026-10-26T14:54:00.000Z');
  return new NotificationScheduler({
    store: options.persistent
      ? new LocalStorageNotificationPlanStore()
      : new MemoryNotificationPlanStore(),
    settingsStore: options.persistent
      ? new LocalStorageNotificationSettingsStore()
      : new MemoryNotificationSettingsStore(
          options.settings ?? DEFAULT_NOTIFICATION_SETTINGS,
        ),
    now: () => now,
    deviceId: 'device-test',
    autoSchedule: false,
    inAppDispatcher: options.dispatch,
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  delete (globalThis as { Notification?: unknown }).Notification;
  window.localStorage.clear();
});

describe('提醒与通知设置分组', () => {
  it('开关、免打扰与摘要写入本机偏好，重新挂载仍生效', async () => {
    const user = userEvent.setup();
    const first = makeScheduler({ persistent: true });
    const view = render(<NotifyGroup scheduler={first} />);

    const inApp = screen.getByRole('checkbox', { name: /^应用内提醒/ });
    expect(inApp).toBeChecked();
    await user.click(inApp);

    await user.click(screen.getByRole('checkbox', { name: /^启用免打扰/ }));
    fireEvent.change(screen.getByLabelText('开始'), {
      target: { value: '21:30' },
    });
    fireEvent.change(screen.getByLabelText('结束'), {
      target: { value: '07:15' },
    });
    await user.click(
      screen.getByRole('checkbox', { name: /^每天汇总今天与逾期任务/ }),
    );
    fireEvent.change(screen.getByLabelText('时间'), {
      target: { value: '08:45' },
    });

    await waitFor(() => {
      const raw = window.localStorage.getItem(NOTIFICATION_SETTINGS_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw ?? 'null')).toMatchObject({
        inApp: false,
        quietHours: { enabled: true, start: '21:30', end: '07:15' },
        dailyDigest: { enabled: true, time: '08:45' },
      });
    });

    view.unmount();
    const reopened = makeScheduler({ persistent: true });
    render(<NotifyGroup scheduler={reopened} />);

    expect(
      screen.getByRole('checkbox', { name: /^应用内提醒/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /^启用免打扰/ }),
    ).toBeChecked();
    expect(screen.getByLabelText('开始')).toHaveValue('21:30');
    expect(
      screen.getByRole('checkbox', { name: /^每天汇总今天与逾期任务/ }),
    ).toBeChecked();
    expect(screen.getByLabelText('时间')).toHaveValue('08:45');
  });

  it('无系统通知能力时禁用系统通道并降级应用内，不显示“已授权”', async () => {
    const scheduler = makeScheduler({ persistent: true });
    render(<NotifyGroup scheduler={scheduler} />);

    expect(
      await screen.findByText(/当前环境没有 Notification API/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /^系统通知/ }),
    ).toBeDisabled();
    expect(screen.getByText(/应用内提醒仍会工作/)).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /^应用内提醒/ }),
    ).toBeChecked();
    expect(screen.queryByText('已授权')).not.toBeInTheDocument();
  });

  it('浏览器权限被拒绝时给出站点设置引导，开关保持关闭', async () => {
    installNotification('denied');
    const user = userEvent.setup();
    const scheduler = makeScheduler({});
    render(<NotifyGroup scheduler={scheduler} />);

    await user.click(
      screen.getByRole('checkbox', { name: /^浏览器通知/ }),
    );

    expect(
      (await screen.findAllByText(/请在浏览器站点设置中重新允许/)).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole('checkbox', { name: /^浏览器通知/ }),
    ).not.toBeChecked();
  });

  it('发送测试通知走应用内通道并明确反馈结果', async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const scheduler = makeScheduler({ dispatch });
    render(<NotifyGroup scheduler={scheduler} />);

    await user.click(
      screen.getByRole('button', { name: '发送测试通知' }),
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/测试通知已触发/),
    ).toBeInTheDocument();
    expect(screen.getByText(/应用内：已发送/)).toBeInTheDocument();
  });

  it('没有可用通道时测试通知明确失败，不静默', async () => {
    const user = userEvent.setup();
    const scheduler = makeScheduler({
      settings: {
        ...DEFAULT_NOTIFICATION_SETTINGS,
        inApp: false,
        browser: false,
        system: false,
      },
    });
    render(<NotifyGroup scheduler={scheduler} />);

    await user.click(
      screen.getByRole('button', { name: '发送测试通知' }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('测试通知未触发');
    expect(alert).toHaveTextContent('没有可用的通知通道');
  });
});
