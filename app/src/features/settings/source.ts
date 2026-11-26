/**
 * 设置读取源。
 *
 * 桌面端走 SQLite（`settings` 表，scope=device）；浏览器预览没有 IPC，
 * 只把设备偏好放在 localStorage。任务/笔记等业务数据仍然绝不回退 localStorage。
 */

import { db, isTauriRuntime } from '../../data/db/client';
import type {
  DbStatus,
  List,
  NewSetting,
  Setting,
  SettingQuery,
} from '../../data/db/types';
import {
  appSettingsToRows,
  applySettingValue,
  readLocalSettings,
  SETTINGS_SCOPE,
  writeLocalSettings,
} from '../../data/repositories/settings';

export type SettingsSource = {
  mode: 'sqlite' | 'browser';
  settings: {
    list: (query?: SettingQuery) => Promise<Setting[]>;
    set: (input: NewSetting) => Promise<Setting>;
  };
  /** 默认清单需要读取真实清单；浏览器预览没有本地库。 */
  lists?: {
    list: () => Promise<List[]>;
  };
  system?: {
    status: () => Promise<DbStatus>;
  };
};

export function createDbSettingsSource(): SettingsSource {
  return {
    mode: 'sqlite',
    settings: {
      list: (query) => db.settings.list(query),
      set: (input) => db.settings.set(input),
    },
    lists: {
      list: () => db.lists.list(),
    },
    system: {
      status: () => db.system.status(),
    },
  };
}

function rowOf(settings: ReturnType<typeof readLocalSettings>, key: string) {
  return appSettingsToRows(settings).find((row) => row.key === key);
}

export function createBrowserSettingsSource(): SettingsSource {
  return {
    mode: 'browser',
    settings: {
      async list(query = {}) {
        const rows = appSettingsToRows(readLocalSettings());
        return query.scope
          ? rows.filter((row) => row.scope === query.scope)
          : rows;
      },
      async set(input: NewSetting) {
        const next = applySettingValue(
          readLocalSettings(),
          input.key,
          input.value,
        );
        writeLocalSettings(next);
        const row = rowOf(next, input.key);
        if (!row) {
          throw new Error(`未知设置项：${input.key}`);
        }
        return { ...row, scope: input.scope ?? SETTINGS_SCOPE };
      },
    },
  };
}

export function defaultSettingsSource(): SettingsSource {
  return isTauriRuntime()
    ? createDbSettingsSource()
    : createBrowserSettingsSource();
}
