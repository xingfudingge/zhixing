import { beforeEach, describe, expect, it } from 'vitest';

import type { DbClient } from '../db/client';
import type { NewSetting, Setting, SettingQuery } from '../db/types';
import {
  applySettingValue,
  appSettingsToRows,
  createSettingsRepository,
  DEFAULT_APP_SETTINGS,
  diffSettings,
  normalizeAppSettings,
  normalizeTaskCompletionBehavior,
  parseStoredSettings,
  readLocalSettings,
  LEGACY_SETTING_KEYS,
  SETTINGS_STORAGE_KEY,
  settingsToInputs,
  SETTING_KEYS,
  writeLocalSettings,
  type AppSettings,
} from './settings';

type Call = { command: string; args?: Record<string, unknown> };

function settingRow(
  key: string,
  value: Setting['value'],
  scope: Setting['scope'] = 'device',
): Setting {
  return {
    id: `setting-${key}`,
    spaceId: 'personal',
    scope,
    key,
    value,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  };
}

function fakeClient(initial: Setting[] = []) {
  const calls: Call[] = [];
  const rows = new Map(initial.map((row) => [`${row.scope}:${row.key}`, row]));

  const client = {
    settings: {
      list: async (query: SettingQuery = {}) => {
        calls.push({ command: 'settings_list', args: query });
        return [...rows.values()]
          .filter((row) => !query.scope || row.scope === query.scope)
          .filter((row) => query.includeDeleted || row.deletedAt === null)
          .map((row) => ({ ...row }));
      },
      set: async (input: NewSetting) => {
        calls.push({ command: 'settings_set', args: input });
        const scope = input.scope ?? 'space';
        const key = `${scope}:${input.key}`;
        const existing = rows.get(key);
        const next: Setting = {
          id: existing?.id ?? `setting-${input.key}`,
          spaceId: 'personal',
          scope,
          key: input.key,
          value: input.value,
          createdAt: existing?.createdAt ?? '2026-10-26T00:00:00.000Z',
          updatedAt: '2026-10-26T00:00:00.000Z',
          deletedAt: null,
          version: (existing?.version ?? 0) + 1,
        };
        rows.set(key, next);
        return next;
      },
      get: async () => {
        throw new Error('not used');
      },
      remove: async () => undefined,
    },
  } as unknown as DbClient;

  return { client, calls, rows };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('设置解析', () => {
  it('没有记录时返回完整默认值', () => {
    expect(parseStoredSettings([])).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('只接受 device scope 的未删除记录', () => {
    const settings = parseStoredSettings([
      settingRow(SETTING_KEYS.editorFontSize, 20),
      settingRow(SETTING_KEYS.editorWidth, 1024),
      settingRow(SETTING_KEYS.showLunar, false),
      settingRow(SETTING_KEYS.taskDefaultList, 'life'),
      settingRow(SETTING_KEYS.editorTextColor, '#2f5d8a'),
      settingRow(SETTING_KEYS.editorParagraphSpacing, 24, 'space'),
    ]);

    expect(settings.editor.fontSize).toBe(20);
    expect(settings.editor.width).toBe(1024);
    expect(settings.calendar.showLunar).toBe(false);
    expect(settings.task.defaultListId).toBe('life');
    expect(settings.editor.textColor).toBe('#2f5d8a');
    expect(settings.editor.paragraphSpacing).toBe(
      DEFAULT_APP_SETTINGS.editor.paragraphSpacing,
    );
  });

  it('非法值回退默认，不让坏记录打断渲染', () => {
    const settings = normalizeAppSettings({
      editor: {
        fontSize: 99,
        paragraphSpacing: 'x',
        textIndent: -1,
        width: 42,
        titleMode: 'unknown',
        showBlockIcon: 'yes',
        textColor: '#ffffff',
      },
      task: { defaultListId: '   ', noteFolderId: 'nope' },
      calendar: { showLunar: 'false' },
    });

    expect(settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('周起始与工作日规则可持久化，并兼容旧键/数字值', () => {
    const parsed = parseStoredSettings([
      settingRow(SETTING_KEYS.calendarWeekStart, 'sunday'),
      settingRow(SETTING_KEYS.calendarWorkdayRule, {
        rule: 'alternating',
        anchorMonday: '2026-10-19',
        customWorkdays: [1, 2, 3, 4, 5],
      }),
    ]);

    expect(parsed.calendar.weekStart).toBe('sunday');
    expect(parsed.calendar.workdayRule).toEqual({
      rule: 'alternating',
      anchorMonday: '2026-10-19',
      customWorkdays: [1, 2, 3, 4, 5],
    });
    expect(
      settingsToInputs(parsed).find(
        (item) => item.key === SETTING_KEYS.calendarWeekStart,
      )?.value,
    ).toBe('sunday');

    const legacy = parseStoredSettings([
      settingRow(LEGACY_SETTING_KEYS.calendarWeekStartsOn, 0),
      settingRow(LEGACY_SETTING_KEYS.calendarWorkdays, '单休'),
    ]);
    expect(legacy.calendar.weekStart).toBe('sunday');
    expect(legacy.calendar.workdayRule.rule).toBe('single');

    const invalid = normalizeAppSettings({
      calendar: {
        weekStart: '火曜日',
        workdayRule: {
          rule: 'unknown',
          anchorMonday: '2026-02-30',
          customWorkdays: ['x'],
        },
      },
    });
    expect(invalid.calendar.weekStart).toBe('monday');
    expect(invalid.calendar.workdayRule).toEqual(
      DEFAULT_APP_SETTINGS.calendar.workdayRule,
    );
  });

  it('节假日源旧值迁移到源 id + 传输，并写回新字段', () => {
    const migrated = parseStoredSettings([
      settingRow(SETTING_KEYS.calendarHolidaySource, {
        source: 'github',
        customUrl: '',
        autoSync: true,
      }),
    ]);
    expect(migrated.calendar.holidaySource).toEqual({
      mode: 'single',
      sourceId: 'holiday-cn',
      transport: 'github-raw',
      customUrl: '',
      customFormat: 'holiday-cn-json',
      autoSync: true,
      autoFallback: false,
      source: 'github',
    });

    const written = settingsToInputs(migrated).find(
      (item) => item.key === SETTING_KEYS.calendarHolidaySource,
    )?.value;
    expect(written).toEqual({
      mode: 'single',
      sourceId: 'holiday-cn',
      transport: 'github-raw',
      customUrl: '',
      customFormat: 'holiday-cn-json',
      autoSync: true,
      autoFallback: false,
      source: 'github',
    });

    const custom = parseStoredSettings([
      settingRow(SETTING_KEYS.calendarHolidaySource, {
        mode: 'custom',
        customUrl: 'https://example.com/h-{year}.ics',
      }),
    ]);
    expect(custom.calendar.holidaySource).toMatchObject({
      mode: 'custom',
      customUrl: 'https://example.com/h-{year}.ics',
      customFormat: 'ics',
      autoFallback: false,
      source: 'custom',
    });
  });

  it('默认提醒缺省为关闭，旧中文文案映射到短码', () => {
    expect(normalizeAppSettings({}).task.defaultReminder).toBe('');
    expect(
      normalizeAppSettings({ task: { defaultReminder: '提前 15 分钟' } }).task
        .defaultReminder,
    ).toBe('15m');
    expect(
      normalizeAppSettings({ task: { defaultReminder: '准时' } }).task
        .defaultReminder,
    ).toBe('at');
    expect(
      normalizeAppSettings({ task: { defaultReminder: '随便' } }).task
        .defaultReminder,
    ).toBe('');
  });

  it('默认提醒键可保存并回读', () => {
    const stored = parseStoredSettings([
      settingRow(SETTING_KEYS.taskDefaultReminder, '30m'),
    ]);
    expect(stored.task.defaultReminder).toBe('30m');

    const cleared = applySettingValue(
      stored,
      SETTING_KEYS.taskDefaultReminder,
      '',
    );
    expect(cleared.task.defaultReminder).toBe('');
  });

  it('完成后行为默认保留；旧 hide/中文值迁移，非法值回退 keep', () => {
    expect(normalizeAppSettings({}).task.completionBehavior).toBe('keep');
    expect(
      parseStoredSettings([
        settingRow(SETTING_KEYS.taskCompletionBehavior, 'remove'),
      ]).task.completionBehavior,
    ).toBe('remove');
    expect(
      parseStoredSettings([
        settingRow(SETTING_KEYS.taskCompletionBehavior, 'hide'),
      ]).task.completionBehavior,
    ).toBe('remove');
    expect(normalizeTaskCompletionBehavior('立即移出')).toBe('remove');
    expect(normalizeTaskCompletionBehavior('保留在当前视图')).toBe('keep');
    expect(normalizeTaskCompletionBehavior('unknown')).toBe('keep');
    expect(normalizeTaskCompletionBehavior(null)).toBe('keep');

    const changed = applySettingValue(
      DEFAULT_APP_SETTINGS,
      SETTING_KEYS.taskCompletionBehavior,
      'remove',
    );
    expect(changed.task.completionBehavior).toBe('remove');
  });

  it('隐私默认关闭；只接受 0/15/30/60，非法值回退关闭', () => {
    expect(normalizeAppSettings({}).privacy).toEqual({
      hideOnBlur: false,
      clipboardClearSeconds: 0,
      diagnosticsEnabled: false,
    });

    const stored = parseStoredSettings([
      settingRow(SETTING_KEYS.privacyHideOnBlur, true),
      settingRow(SETTING_KEYS.privacyClipboardClearSeconds, 30),
    ]);
    expect(stored.privacy).toEqual({
      hideOnBlur: true,
      clipboardClearSeconds: 30,
      diagnosticsEnabled: false,
    });

    expect(
      parseStoredSettings([
        settingRow(SETTING_KEYS.privacyHideOnBlur, 'yes'),
        settingRow(SETTING_KEYS.privacyClipboardClearSeconds, 7),
      ]).privacy,
    ).toEqual({
      hideOnBlur: false,
      clipboardClearSeconds: 0,
      diagnosticsEnabled: false,
    });

    const changed = applySettingValue(
      DEFAULT_APP_SETTINGS,
      SETTING_KEYS.privacyClipboardClearSeconds,
      '15',
    );
    expect(changed.privacy.clipboardClearSeconds).toBe(15);
  });

  it('完整偏好键可以无损往返', () => {
    const source: AppSettings = {
      editor: {
        fontSize: 20,
        paragraphSpacing: 24,
        textIndent: 2,
        width: '100%',
        titleMode: 'datetime',
        showBlockIcon: false,
        textColor: '#6b4f8a',
      },
      task: {
        defaultListId: 'work',
        defaultReminder: '15m',
        completionBehavior: 'remove',
        noteFolderId: 'f3',
      },
      calendar: {
        ...DEFAULT_APP_SETTINGS.calendar,
        showLunar: false,
      },
      privacy: {
        hideOnBlur: true,
        clipboardClearSeconds: 30,
        diagnosticsEnabled: true,
      },
      export: { directory: '/Users/me/Exports' },
    };
    const inputs = settingsToInputs(source);
    expect(inputs).toHaveLength(20);
    expect(inputs.every((item) => item.scope === 'device')).toBe(true);

    const rows = inputs
      .map((item) => settingRow(item.key, item.value))
      .map((row, index) => ({ ...row, id: `r${index}` }));
    expect(parseStoredSettings(rows)).toEqual(source);
  });

  it('默认导出目录可保存、清除，并拒绝空白路径', () => {
    const rows = [
      settingRow(SETTING_KEYS.exportDirectory, '  /Users/me/Exports  '),
    ];
    expect(parseStoredSettings(rows).export.directory).toBe(
      '/Users/me/Exports',
    );

    const cleared = applySettingValue(
      parseStoredSettings(rows),
      SETTING_KEYS.exportDirectory,
      '',
    );
    expect(cleared.export.directory).toBeNull();

    const blank = normalizeAppSettings({
      ...DEFAULT_APP_SETTINGS,
      export: { directory: '   ' },
    });
    expect(blank.export.directory).toBeNull();
  });

  it('diffSettings 只返回变化项', () => {
    const next: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      editor: { ...DEFAULT_APP_SETTINGS.editor, fontSize: 20 },
    };
    expect(diffSettings(DEFAULT_APP_SETTINGS, next)).toEqual([
      {
        scope: 'device',
        key: SETTING_KEYS.editorFontSize,
        value: 20,
      },
    ]);
  });
});

describe('设置仓储', () => {
  it('load 读取 SQLite 并镜像 localStorage', async () => {
    const { client } = fakeClient([
      settingRow(SETTING_KEYS.editorFontSize, 20),
      settingRow(SETTING_KEYS.showLunar, false),
    ]);
    const repository = createSettingsRepository(client);

    const settings = await repository.load();

    expect(settings.editor.fontSize).toBe(20);
    expect(settings.calendar.showLunar).toBe(false);
    expect(
      JSON.parse(
        window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null',
      ).editor.fontSize,
    ).toBe(20);
  });

  it('saveChanged 只写变化项，save 全量写入', async () => {
    const { client, calls } = fakeClient();
    const repository = createSettingsRepository(client);
    const next: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      editor: { ...DEFAULT_APP_SETTINGS.editor, fontSize: 20 },
    };

    await repository.saveChanged(DEFAULT_APP_SETTINGS, next);
    expect(calls.map((call) => call.command)).toEqual(['settings_set']);
    expect(calls[0].args).toMatchObject({
      key: SETTING_KEYS.editorFontSize,
      value: 20,
    });

    calls.length = 0;
    await repository.save(next);
    expect(calls).toHaveLength(20);
  });

  it('reset 写回默认值', async () => {
    const { client } = fakeClient([
      settingRow(SETTING_KEYS.editorFontSize, 24),
    ]);
    const repository = createSettingsRepository(client);

    const reset = await repository.reset();

    expect(reset).toEqual(DEFAULT_APP_SETTINGS);
    const loaded = await repository.load();
    expect(loaded.editor.fontSize).toBe(
      DEFAULT_APP_SETTINGS.editor.fontSize,
    );
  });
});

describe('浏览器偏好镜像', () => {
  it('读写 localStorage 并容错坏 JSON', () => {
    const next: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      editor: { ...DEFAULT_APP_SETTINGS.editor, fontSize: 22 },
    };
    writeLocalSettings(next);
    expect(readLocalSettings()).toEqual(next);

    window.localStorage.setItem(SETTINGS_STORAGE_KEY, '{bad');
    expect(readLocalSettings()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('applySettingValue 保持非法值不变', () => {
    const current: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      editor: { ...DEFAULT_APP_SETTINGS.editor, fontSize: 20 },
    };
    const next = applySettingValue(
      current,
      SETTING_KEYS.editorFontSize,
      99,
    );
    expect(next.editor.fontSize).toBe(20);
  });

  it('appSettingsToRows 生成 20 条 device 行', () => {
    const rows = appSettingsToRows(DEFAULT_APP_SETTINGS);
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.scope === 'device')).toBe(true);
    expect(rows.every((row) => row.deletedAt === null)).toBe(true);
  });
});
