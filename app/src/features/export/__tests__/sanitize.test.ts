import { describe, expect, it } from 'vitest';

import { SETTING_KEYS } from '../../../data/repositories/settings';
import { filterSafeSettings, isSafeSettingKey, isSecretKey, redactSecrets, stableStringify } from '../sanitize';
import { makeDataset } from './testFixtures';

describe('备份安全过滤', () => {
  it('设置白名单只保留已确认的偏好键', () => {
    const dataset = makeDataset();
    dataset.settings.push({
      id: 'setting-token',
      spaceId: 'personal',
      scope: 'device',
      key: 'sync.token',
      value: 'super-secret-token',
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
      version: 1,
    });
    dataset.settings.push({
      id: 'setting-license',
      spaceId: 'personal',
      scope: 'device',
      key: 'license.code',
      value: 'ZX-1234',
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
      version: 1,
    });
    const filtered = filterSafeSettings(dataset.settings);
    expect(filtered.safe.map((row) => row.key)).toEqual([SETTING_KEYS.editorFontSize]);
    expect(filtered.excludedKeys).toEqual(['license.code', 'sync.token']);
    expect(isSafeSettingKey('webdav.password')).toBe(false);
    expect(isSafeSettingKey('editor.fontSize')).toBe(true);
    expect(isSafeSettingKey(SETTING_KEYS.taskDefaultReminder)).toBe(true);
    expect(isSecretKey('device.id')).toBe(true);
    expect(isSecretKey('notes.defaultFolderId')).toBe(false);
  });

  it('节假日源偏好属于白名单，保存新源模型字段', () => {
    const value = {
      mode: 'auto',
      sourceId: 'chinese-days',
      transport: 'jsdelivr',
      customUrl: '',
      customFormat: 'holiday-cn-json',
      autoSync: true,
      autoFallback: true,
      source: 'jsdelivr',
    };
    const filtered = filterSafeSettings([
      {
        id: 'setting-holiday',
        spaceId: 'personal',
        scope: 'device',
        key: SETTING_KEYS.calendarHolidaySource,
        value,
        createdAt: '',
        updatedAt: '',
        deletedAt: null,
        version: 1,
      },
    ]);
    expect(filtered.excludedKeys).toEqual([]);
    expect(filtered.safe).toHaveLength(1);
    expect(filtered.safe[0]?.value).toEqual(value);
    expect(isSafeSettingKey(SETTING_KEYS.calendarHolidaySource)).toBe(true);
  });

  it('稳定序列化忽略对象键顺序，检测循环引用', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableStringify(cyclic)).toThrow(/循环/);
  });

  it('诊断脱敏隐藏令牌、密码、邮箱与长哈希', () => {
    const text = redactSecrets(
      'Authorization: Bearer abc.def.ghi token=secret password=p@ss user@example.com ' +
        'a'.repeat(64),
    );
    expect(text).not.toContain('abc.def.ghi');
    expect(text).not.toContain('p@ss');
    expect(text).not.toContain('user@example.com');
    expect(text).not.toContain('a'.repeat(64));
    expect(text).toContain('已隐藏');
  });
});
