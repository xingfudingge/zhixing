import { beforeEach, describe, expect, it } from 'vitest';

import {
  LocalStorageNotificationSettingsStore,
  MemoryNotificationSettingsStore,
  NOTIFICATION_SETTINGS_KEY,
  defaultNotificationSettingsStore,
  normalizeNotificationSettings,
} from '../settings';
import { DEFAULT_NOTIFICATION_SETTINGS } from '../types';

beforeEach(() => {
  window.localStorage.clear();
});

describe('通知设备偏好持久化', () => {
  it('默认只开应用内提醒，免打扰与摘要关闭', () => {
    const store = new LocalStorageNotificationSettingsStore();
    const settings = store.load();
    expect(settings.inApp).toBe(true);
    expect(settings.browser).toBe(false);
    expect(settings.system).toBe(false);
    expect(settings.quietHours).toEqual({
      enabled: false,
      start: '22:00',
      end: '08:00',
    });
    expect(settings.dailyDigest).toEqual({ enabled: false, time: '09:00' });
    expect(
      window.localStorage.getItem(NOTIFICATION_SETTINGS_KEY),
    ).toBeNull();
  });

  it('保存后重开（新实例）仍读取同一份设置', () => {
    const first = new LocalStorageNotificationSettingsStore();
    first.save({
      ...DEFAULT_NOTIFICATION_SETTINGS,
      inApp: false,
      browser: true,
      quietHours: { enabled: true, start: '21:30', end: '07:15' },
      dailyDigest: { enabled: true, time: '08:45' },
    });

    // 模拟重开应用：重新创建 store，而不是复用内存对象。
    const reopened = defaultNotificationSettingsStore();
    expect(reopened.load()).toMatchObject({
      inApp: false,
      browser: true,
      quietHours: { enabled: true, start: '21:30', end: '07:15' },
      dailyDigest: { enabled: true, time: '08:45' },
    });
  });

  it('损坏 JSON 与非法时间回退到默认值，不抛错', () => {
    window.localStorage.setItem(NOTIFICATION_SETTINGS_KEY, '{broken');
    const store = new LocalStorageNotificationSettingsStore();
    expect(store.load()).toEqual(DEFAULT_NOTIFICATION_SETTINGS);

    const normalized = normalizeNotificationSettings({
      quietHours: { enabled: true, start: '25:99', end: 'not-a-time' },
      dailyDigest: { enabled: true, time: '9:5' },
    });
    expect(normalized.quietHours).toMatchObject({
      enabled: true,
      start: '22:00',
      end: '08:00',
    });
    expect(normalized.dailyDigest).toEqual({ enabled: true, time: '09:00' });
  });

  it('无 localStorage 时使用内存 store，仍可读写', () => {
    const store = new MemoryNotificationSettingsStore();
    const saved = store.save({
      ...DEFAULT_NOTIFICATION_SETTINGS,
      inApp: false,
    });
    expect(saved.inApp).toBe(false);
    expect(store.load().inApp).toBe(false);
  });
});
