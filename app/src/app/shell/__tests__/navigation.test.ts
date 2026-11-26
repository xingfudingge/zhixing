import { describe, expect, it } from 'vitest';

import {
  NAV_SECTIONS,
  SETTINGS_NAV_ITEM,
  isNavItemActive,
} from '../navigation';

describe('全局导航配置', () => {
  it('主分组顺序固定为 工作台 → 节奏 → 知识与画板', () => {
    expect(NAV_SECTIONS.map((section) => section.id)).toEqual([
      'workspace',
      'rhythm',
      'knowledge',
    ]);
  });

  it('工作台首屏顺序为 今天 → 任务 → 日历', () => {
    const workspace = NAV_SECTIONS.find((section) => section.id === 'workspace');

    expect(workspace?.items.map((item) => item.label)).toEqual([
      '今天',
      '任务',
      '日历',
    ]);
    expect(workspace?.items.map((item) => item.to)).toEqual([
      '/today',
      '/tasks',
      '/calendar',
    ]);
  });

  it('今天与任务都保持独立入口与高亮规则', () => {
    const workspace = NAV_SECTIONS.find((section) => section.id === 'workspace');
    const today = workspace?.items.find((item) => item.to === '/today');
    const tasks = workspace?.items.find((item) => item.to === '/tasks');

    expect(today && isNavItemActive('/today', today)).toBe(true);
    expect(today && isNavItemActive('/tasks', today)).toBe(false);
    expect(tasks && isNavItemActive('/tasks', tasks)).toBe(true);
    expect(tasks && isNavItemActive('/today', tasks)).toBe(false);
  });

  it('设置入口在所有设置分组下保持高亮', () => {
    expect(isNavItemActive('/settings/appearance', SETTINGS_NAV_ITEM)).toBe(
      true,
    );
    expect(isNavItemActive('/settings/sync', SETTINGS_NAV_ITEM)).toBe(true);
    expect(isNavItemActive('/today', SETTINGS_NAV_ITEM)).toBe(false);
  });
});
