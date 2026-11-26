import { describe, expect, it } from 'vitest';

import type { Appearance } from '../../../app/shell/appearance';
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from '../../../data/repositories/settings';
import {
  createSettingsBackup,
  defaultBackupSettings,
  parseSettingsBackup,
  serializeSettingsBackup,
  SettingsBackupError,
} from '../backup';

const appearance: Appearance = {
  theme: 'dark',
  accent: 'violet',
  density: 'compact',
};

const settings: AppSettings = {
  editor: {
    fontSize: 20,
    paragraphSpacing: 24,
    textIndent: 2,
    width: 800,
    titleMode: 'date',
    showBlockIcon: false,
    textColor: '#2f5d8a',
  },
  task: {
    defaultListId: 'life',
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

describe('偏好备份', () => {
  it('导出再导入完全一致', () => {
    const at = new Date('2026-10-26T08:05:00.000Z');
    const text = serializeSettingsBackup(settings, appearance, at);

    const parsed = parseSettingsBackup(text);

    expect(parsed.appearance).toEqual(appearance);
    expect(parsed.settings).toEqual(settings);
    expect(parsed.exportedAt).toBe('2026-10-26T08:05:00.000Z');
    expect(createSettingsBackup(settings, appearance, at)).toEqual(parsed);
  });

  it('拒绝坏 JSON', () => {
    expect(() => parseSettingsBackup('{oops')).toThrow(SettingsBackupError);
    expect(() => parseSettingsBackup('{oops')).toThrow('不是有效的 JSON');
  });

  it('拒绝其他应用的备份', () => {
    const text = JSON.stringify({
      app: 'other',
      kind: 'settings',
      version: 1,
    });
    expect(() => parseSettingsBackup(text)).toThrow('不是知行偏好备份');
  });

  it('拒绝不支持的版本', () => {
    const text = JSON.stringify({
      app: 'zhixing',
      kind: 'settings',
      version: 99,
      appearance,
      settings,
    });
    expect(() => parseSettingsBackup(text)).toThrow('不受支持');
  });

  it('拒绝非法枚举与数值', () => {
    const text = JSON.stringify({
      app: 'zhixing',
      kind: 'settings',
      version: 1,
      exportedAt: '2026-10-26T00:00:00.000Z',
      appearance: { ...appearance, theme: 'midnight' },
      settings,
    });
    expect(() => parseSettingsBackup(text)).toThrow('主题的值无效');

    const badNumber = JSON.stringify({
      app: 'zhixing',
      kind: 'settings',
      version: 1,
      appearance,
      settings: {
        ...settings,
        editor: { ...settings.editor, fontSize: 99 },
      },
    });
    expect(() => parseSettingsBackup(badNumber)).toThrow('正文字号的值无效');
  });

  it('未知目录回退到默认目录而不是让导入失败', () => {
    const text = JSON.stringify({
      app: 'zhixing',
      kind: 'settings',
      version: 1,
      appearance,
      settings: {
        ...settings,
        task: { ...settings.task, noteFolderId: 'missing' },
      },
    });
    const parsed = parseSettingsBackup(text);
    expect(parsed.settings.task.noteFolderId).toBe(
      defaultBackupSettings().task.noteFolderId,
    );
  });

  it('默认备份值就是完整默认设置', () => {
    expect(defaultBackupSettings()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('导出→导入往返保留默认提醒与完成后行为（QA F6 回归）', () => {
    const exported = JSON.parse(
      serializeSettingsBackup(settings, appearance),
    );
    expect(exported.settings.task.defaultReminder).toBe('15m');
    expect(exported.settings.task.completionBehavior).toBe('remove');

    const parsed = parseSettingsBackup(JSON.stringify(exported));
    expect(parsed.settings.task.defaultReminder).toBe('15m');
    expect(parsed.settings.task.completionBehavior).toBe('remove');
    expect(parsed.settings.task.defaultListId).toBe('life');
    expect(parsed.settings.task.noteFolderId).toBe('f3');
  });

  it.each([1, 2, 3, 4, 5])(
    'v%i 备份保留 defaultReminder',
    (version) => {
      const text = JSON.stringify({
        app: 'zhixing',
        kind: 'settings',
        version,
        exportedAt: '2026-10-26T00:00:00.000Z',
        appearance,
        settings,
      });
      expect(parseSettingsBackup(text).settings.task.defaultReminder).toBe(
        '15m',
      );
    },
  );

  it.each([1, 2, 3, 4, 5])(
    'v%i 备份缺少 defaultReminder 时回退关闭且不丢其他设置',
    (version) => {
      const legacyTask = {
        defaultListId: settings.task.defaultListId,
        completionBehavior: settings.task.completionBehavior,
        noteFolderId: settings.task.noteFolderId,
      };
      const text = JSON.stringify({
        app: 'zhixing',
        kind: 'settings',
        version,
        exportedAt: '2026-10-26T00:00:00.000Z',
        appearance,
        settings: {
          ...settings,
          task: legacyTask,
        },
      });
      const parsed = parseSettingsBackup(text);
      expect(parsed.settings.task.defaultReminder).toBe('');
      expect(parsed.settings.task.completionBehavior).toBe('remove');
      expect(parsed.settings.task.defaultListId).toBe('life');
      expect(parsed.settings.task.noteFolderId).toBe('f3');
    },
  );

  it('非法 defaultReminder 回退关闭，旧中文文案按设置仓库规则迁移', () => {
    const withReminder = (defaultReminder: unknown) =>
      JSON.stringify({
        app: 'zhixing',
        kind: 'settings',
        version: 5,
        appearance,
        settings: {
          ...settings,
          task: { ...settings.task, defaultReminder },
        },
      });

    expect(
      parseSettingsBackup(withReminder('随便')).settings.task,
    ).toMatchObject({
      defaultReminder: '',
      completionBehavior: 'remove',
      defaultListId: 'life',
      noteFolderId: 'f3',
    });
    expect(
      parseSettingsBackup(withReminder('提前 15 分钟')).settings.task
        .defaultReminder,
    ).toBe('15m');
    expect(
      parseSettingsBackup(withReminder(999)).settings.task.defaultReminder,
    ).toBe('');
  });

  it('新备份写 v5；v1 旧备份缺周起始/工作日/隐私时回退默认', () => {
    const text = serializeSettingsBackup(settings, appearance);
    expect(JSON.parse(text).version).toBe(5);

    const legacy = JSON.stringify({
      app: 'zhixing',
      kind: 'settings',
      version: 1,
      exportedAt: '2026-10-26T00:00:00.000Z',
      appearance,
      settings: {
        ...settings,
        calendar: { showLunar: false },
        privacy: undefined,
      },
    });
    const parsed = parseSettingsBackup(legacy);
    expect(parsed.version).toBe(5);
    expect(parsed.settings.calendar).toEqual({
      showLunar: false,
      weekStart: 'monday',
      workdayRule: DEFAULT_APP_SETTINGS.calendar.workdayRule,
      holidaySource: DEFAULT_APP_SETTINGS.calendar.holidaySource,
      dateExceptions: [],
    });
    expect(parsed.settings.privacy).toEqual(
      DEFAULT_APP_SETTINGS.privacy,
    );
  });

  it('v2 旧备份可导入，并补齐节假日源与个人例外默认值', () => {
    const legacyV2 = JSON.stringify({
      app: 'zhixing',
      kind: 'settings',
      version: 2,
      exportedAt: '2026-10-26T00:00:00.000Z',
      appearance,
      settings: {
        ...settings,
        privacy: undefined,
        calendar: {
          ...DEFAULT_APP_SETTINGS.calendar,
          showLunar: false,
        },
      },
    });
    const parsed = parseSettingsBackup(legacyV2);
    expect(parsed.version).toBe(5);
    expect(parsed.settings.calendar.dateExceptions).toEqual([]);
    expect(parsed.settings.calendar.holidaySource.source).toBe('builtin');
    expect(parsed.settings.privacy.clipboardClearSeconds).toBe(0);
  });
});
