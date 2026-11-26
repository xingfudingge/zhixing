import type { DbStatus, List, NewSetting, Setting } from '../../../data/db/types';
import {
  appSettingsToRows,
  DEFAULT_APP_SETTINGS,
  parseStoredSettings,
  type AppSettings,
} from '../../../data/repositories/settings';
import type { SettingsSource } from '../source';

export type FakeSettingsSourceOptions = {
  initial?: AppSettings;
  lists?: List[];
  mode?: 'sqlite' | 'browser';
  status?: DbStatus | null;
  failSet?: boolean;
};

export function fakeList(
  id: string,
  name: string,
  isInbox = false,
  sortOrder = 0,
): List {
  return {
    id,
    spaceId: 'personal',
    name,
    color: '#5579d5',
    icon: isInbox ? 'inbox' : 'list',
    parentId: null,
    sortOrder,
    isInbox,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  };
}

export const FAKE_LISTS: List[] = [
  fakeList('inbox', '收件箱', true, 0),
  fakeList('work', '工作', false, 1),
  fakeList('life', '生活', false, 2),
];

export function createFakeSettingsSource(
  options: FakeSettingsSourceOptions = {},
) {
  let current: AppSettings = options.initial ?? DEFAULT_APP_SETTINGS;
  const writes: NewSetting[] = [];

  const source: SettingsSource = {
    mode: options.mode ?? 'sqlite',
    settings: {
      async list(query = {}) {
        const rows = appSettingsToRows(current, '2026-10-26T00:00:00.000Z');
        return query.scope
          ? rows.filter((row) => row.scope === query.scope)
          : rows;
      },
      async set(input: NewSetting) {
        if (options.failSet) {
          throw new Error('本机设置写入失败');
        }
        writes.push(input);
        current = parseStoredSettings(
          appSettingsToRows(current, '2026-10-26T00:00:00.000Z').map((row) =>
            row.key === input.key ? { ...row, value: input.value } : row,
          ),
        );
        const row = appSettingsToRows(
          current,
          '2026-10-26T00:00:00.000Z',
        ).find((item) => item.key === input.key);
        if (!row) {
          throw new Error(`未知设置项：${input.key}`);
        }
        return row as Setting;
      },
    },
    lists:
      options.mode === 'browser'
        ? undefined
        : {
            list: async () => options.lists ?? FAKE_LISTS,
          },
    system:
      options.mode === 'browser'
        ? undefined
        : {
            status: async () =>
              options.status ?? {
                path: '/tmp/zhixing.db',
                ready: true,
                schemaVersion: 4,
                journalMode: 'wal',
                foreignKeys: true,
                applied: ['0001', '0002', '0003', '0004'],
                error: null,
              },
          },
  };

  return {
    source,
    writes,
    getSettings: () => current,
    getSettingsFromRows: () => current,
  };
}
