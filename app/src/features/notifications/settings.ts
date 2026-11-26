/**
 * 通知设备偏好。默认只开应用内提醒；浏览器/系统通知必须由用户主动开启。
 * 这里不保存权限状态（权限永远以系统实时值为准）。
 */

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
} from './types';

export const NOTIFICATION_SETTINGS_KEY = 'zhixing.notifications.v1';

export interface NotificationSettingsStore {
  load(): NotificationSettings;
  save(settings: NotificationSettings): NotificationSettings;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeTime(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : fallback;
}

export function normalizeNotificationSettings(raw: unknown): NotificationSettings {
  const source = isRecord(raw) ? raw : {};
  const quiet = isRecord(source.quietHours) ? source.quietHours : {};
  const digest = isRecord(source.dailyDigest) ? source.dailyDigest : {};
  return {
    inApp: source.inApp !== false,
    browser: source.browser === true,
    system: source.system === true,
    sound: source.sound === true,
    lockScreenPrivacy: source.lockScreenPrivacy !== false,
    quietHours: {
      enabled: quiet.enabled === true,
      start: normalizeTime(quiet.start, DEFAULT_NOTIFICATION_SETTINGS.quietHours.start),
      end: normalizeTime(quiet.end, DEFAULT_NOTIFICATION_SETTINGS.quietHours.end),
    },
    dailyDigest: {
      enabled: digest.enabled === true,
      time: normalizeTime(
        digest.time,
        DEFAULT_NOTIFICATION_SETTINGS.dailyDigest.time,
      ),
    },
  };
}

export function cloneNotificationSettings(
  settings: NotificationSettings,
): NotificationSettings {
  return {
    ...settings,
    quietHours: { ...settings.quietHours },
    dailyDigest: { ...settings.dailyDigest },
  };
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class LocalStorageNotificationSettingsStore
  implements NotificationSettingsStore
{
  private readonly storage: StorageLike | null;
  private readonly key: string;

  constructor(
    storage: StorageLike | null = defaultStorage(),
    key = NOTIFICATION_SETTINGS_KEY,
  ) {
    this.storage = storage;
    this.key = key;
  }

  load(): NotificationSettings {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(this.key) ?? null;
    } catch {
      raw = null;
    }
    if (!raw) return cloneNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS);
    try {
      return normalizeNotificationSettings(JSON.parse(raw) as unknown);
    } catch {
      return cloneNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS);
    }
  }

  save(settings: NotificationSettings): NotificationSettings {
    const normalized = normalizeNotificationSettings(settings);
    try {
      this.storage?.setItem(this.key, JSON.stringify(normalized));
    } catch {
      // 隐私模式：本次会话继续使用内存中的值。
    }
    return normalized;
  }
}

export class MemoryNotificationSettingsStore
  implements NotificationSettingsStore
{
  private settings: NotificationSettings;

  constructor(initial: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS) {
    this.settings = cloneNotificationSettings(initial);
  }

  load(): NotificationSettings {
    return cloneNotificationSettings(this.settings);
  }

  save(settings: NotificationSettings): NotificationSettings {
    this.settings = normalizeNotificationSettings(settings);
    return cloneNotificationSettings(this.settings);
  }
}

export function defaultNotificationSettingsStore(): NotificationSettingsStore {
  return new LocalStorageNotificationSettingsStore();
}
