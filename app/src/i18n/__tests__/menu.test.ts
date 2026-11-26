import { describe, expect, it } from 'vitest';

import {
  MENU_LOCALE,
  isMenuKey,
  menuCatalog,
  t,
  tMenu,
  type MenuKey,
} from '../menu';

const HAN = /\p{Script=Han}/u;
const keys = Object.keys(menuCatalog) as MenuKey[];

/**
 * 允许只包含专有名词的文案。设计文档 §6.5 明确 Markdown/HTML/LaTeX 等
 * 专有名词不翻译，因此这些值可以没有汉字。
 */
const PROPER_NOUN_ONLY_VALUES = new Set([
  'Markdown（.md）',
  'HTML（.html）',
]);

/** 设计文档 §8 的分区数量；数量变化必须同步文档与菜单卡。 */
const EXPECTED_COUNTS: ReadonlyArray<readonly [prefix: string, count: number]> = [
  ['menu.label.', 10],
  ['menu.common.', 5],
  ['menu.heading.', 6],
  ['menu.note.', 15],
  ['menu.text.', 19],
  ['menu.blank.', 6],
  ['menu.table.', 25],
  ['menu.formula.', 11],
  ['menu.image.', 7],
  ['menu.tree.', 4],
  ['menu.tab.', 11],
  ['menu.board.', 35],
  ['menu.hint.', 21],
  ['menu.confirm.', 3],
  ['menu.toast.', 8],
];

describe('menuCatalog', () => {
  it('默认语言为 zh-CN', () => {
    expect(MENU_LOCALE).toBe('zh-CN');
  });

  it('覆盖设计文档 §8 的全部 186 个 key', () => {
    expect(keys).toHaveLength(186);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('每个分区的 key 数量与设计文档一致', () => {
    for (const [prefix, count] of EXPECTED_COUNTS) {
      expect(
        keys.filter((key) => key.startsWith(prefix)),
        `${prefix} 数量`,
      ).toHaveLength(count);
    }
  });

  it('key 非空、使用 menu.* 命名、无空白字符', () => {
    for (const key of keys) {
      expect(key.length).toBeGreaterThan('menu.'.length);
      expect(key).toMatch(/^menu\.[A-Za-z0-9.]+$/);
      expect(key.trim()).toBe(key);
    }
  });

  it('所有 key 都有非空中文值（专有名词除外）', () => {
    for (const key of keys) {
      const value = menuCatalog[key];
      expect(value, key).toBeTypeOf('string');
      expect(value.trim().length, key).toBeGreaterThan(0);
      expect(value, key).not.toBe(key);
      expect(
        HAN.test(value) || PROPER_NOUN_ONLY_VALUES.has(value),
        `${key} 缺少中文值：${value}`,
      ).toBe(true);
    }
  });

  it('目录为只读，避免运行期被菜单实现意外改写', () => {
    expect(Object.isFrozen(menuCatalog)).toBe(true);
  });
});

describe('t', () => {
  it('返回登记的中文值', () => {
    expect(t('menu.text.copy')).toBe('复制');
    expect(t('menu.label.text')).toBe('文本菜单');
  });

  it('tMenu 与 t 等价，供设计文档中的菜单卡直接引用', () => {
    expect(tMenu).toBe(t);
    expect(tMenu('menu.table.deleteTable')).toBe('删除表格');
  });

  it('替换单个 {count} 占位符，包括 0', () => {
    expect(t('menu.board.label.node', { count: 0 })).toBe('已选 0 个对象');
    expect(t('menu.board.label.edge', { count: 3 })).toBe('已选 3 条连线');
    expect(t('menu.board.deleteSelection', { count: 12 })).toBe(
      '删除选中（12）',
    );
  });

  it('替换多个命名占位符', () => {
    expect(
      t('menu.board.label.multi', { nodeCount: 2, edgeCount: 5 }),
    ).toBe('已选 2 个对象 · 5 条连线');
  });

  it('替换文本占位符并保留其他字符', () => {
    expect(t('menu.toast.movedToFolder', { folder: '产品设计' })).toBe(
      '已移动到「产品设计」',
    );
  });

  it('缺少参数时保留占位符，不输出 undefined 或空字符串', () => {
    expect(t('menu.toast.movedToFolder')).toBe('已移动到「{folder}」');
    expect(t('menu.board.label.multi', { nodeCount: 1 })).toBe(
      '已选 1 个对象 · {edgeCount} 条连线',
    );
  });

  it('忽略未使用的多余参数', () => {
    expect(t('menu.text.paste', { count: 9, folder: 'x' })).toBe('粘贴');
  });

  it('未知 key 在测试环境显式报错，而不是返回空字符串', () => {
    const unknown = 'menu.unknown.key' as MenuKey;
    expect(() => t(unknown)).toThrow(/未知菜单 key: menu\.unknown\.key/);
  });

  it('isMenuKey 可区分已登记与未知 key', () => {
    expect(isMenuKey('menu.text.copy')).toBe(true);
    expect(isMenuKey('menu.unknown.key')).toBe(false);
    expect(isMenuKey('')).toBe(false);
    expect(isMenuKey('toString')).toBe(false);
  });
});
