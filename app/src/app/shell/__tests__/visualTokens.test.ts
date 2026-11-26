/**
 * ZX-STYLE-01 视觉令牌断言。
 *
 * 这里只做静态断言：组件 CSS 不允许再出现颜色字面量、px 字号或 px 圆角；
 * 按钮高度/圆角/字号必须来自 tokens.css，主题与强调色只通过令牌切换。
 * 真实渲染的浅色/暗色/强调色验证见 tests/e2e/zx-style-01-desktop.mjs。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function readCss(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function blockOf(css: string, selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `找不到选择器 ${selector}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('}', start);
  expect(end, `选择器 ${selector} 缺少结尾`).toBeGreaterThan(start);
  return css.slice(start, end + 1);
}

const tokens = readCss('../../../styles/tokens.css');

const targets = [
  ['shell.css', readCss('../shell.css')],
  ['tasks.css', readCss('../../../features/tasks/tasks.css')],
  ['knowledge.css', readCss('../../../features/knowledge/knowledge.css')],
  ['settings.css', readCss('../../../features/settings/settings.css')],
  ['attachments.css', readCss('../../../features/attachments/attachments.css')],
] as const;

const REQUIRED_TOKENS = [
  // 表面 / 文字 / 分隔 / 焦点
  '--bg',
  '--surface',
  '--surface-2',
  '--surface-3',
  '--ink',
  '--muted',
  '--line',
  '--line-strong',
  '--focus-ring',
  '--focus-ring-width',
  '--focus-ring-offset',
  // 语义色与危险确认
  '--blue',
  '--blue-soft',
  '--blue-ink',
  '--red',
  '--red-soft',
  '--green',
  '--amber',
  '--on-accent',
  '--on-danger',
  '--danger-hover',
  '--scrim',
  // 字号阶梯与语义字号
  '--text-9-5',
  '--text-10-5',
  '--text-11',
  '--text-11-5',
  '--text-12',
  '--text-12-5',
  '--text-13',
  '--text-14',
  '--text-16',
  '--text-20',
  '--text-24',
  '--text-page-title',
  '--text-page-subtitle',
  '--text-section-title',
  '--text-card-title',
  '--text-body',
  '--text-body-lg',
  '--text-control',
  '--text-control-sm',
  '--text-caption',
  '--text-meta',
  '--text-micro',
  '--text-display',
  // 字重 / 间距 / 控件尺寸
  '--weight-regular',
  '--weight-medium',
  '--weight-semibold',
  '--weight-title',
  '--weight-bold',
  '--space-0-5',
  '--space-1',
  '--space-1-5',
  '--space-2',
  '--space-3',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-8',
  '--control-h-sm',
  '--control-h',
  '--control-h-lg',
  '--control-pad-x',
  '--control-pad-x-sm',
  '--icon-button-sm',
  '--icon-button',
  '--icon-button-lg',
  '--icon-gap',
  '--icon-empty',
  // 圆角阶梯与组件别名
  '--radius-6',
  '--radius-8',
  '--radius-10',
  '--radius-12',
  '--radius-13',
  '--radius-16',
  '--radius-pill',
  '--radius-circle',
  '--radius-button',
  '--radius-card',
  '--radius-panel',
  '--radius-popover',
] as const;

const BUTTON_SELECTORS = [
  ['shell.css', '.icon-button {', '--icon-button', '--radius-button'],
  ['tasks.css', '.task-button {', '--control-h', '--radius-button'],
  ['tasks.css', '.task-button--small {', '--control-h-sm', '--radius-6'],
  ['knowledge.css', '.kn-primary-button,', '--control-h', '--radius-button'],
  ['settings.css', '.settings-button {', '--control-h', '--radius-button'],
  ['settings.css', '.settings-button--small {', '--control-h-sm', '--radius-6'],
  ['settings.css', '.settings-sync-button {', '--control-h', '--radius-button'],
  ['attachments.css', '.zx-attach-button {', '--control-h', '--radius-button'],
] as const;

describe('全局视觉令牌', () => {
  it('tokens.css 定义了页面标题/正文/按钮/输入/卡片/空态/焦点/危险确认所需令牌', () => {
    for (const token of REQUIRED_TOKENS) {
      expect(tokens, `缺少令牌 ${token}`).toMatch(
        new RegExp(`${token.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}\\s*:`),
      );
    }
  });

  it('浅色与暗色主题都覆盖表面、文字和分隔层级', () => {
    const darkBlock = blockOf(tokens, ":root[data-theme='dark'] {");
    for (const token of [
      '--bg',
      '--surface',
      '--surface-2',
      '--surface-3',
      '--ink',
      '--muted',
      '--line',
      '--line-strong',
      '--focus-ring',
      '--shadow',
      '--scrim',
    ]) {
      expect(darkBlock, `暗色主题缺少 ${token}`).toContain(`${token}:`);
    }
    expect(tokens).toContain('--on-danger: #ffffff');
    expect(tokens).toContain('--bg: #f6f7fa');
    expect(tokens).toContain('--bg: #171b24');
  });

  it('强调色只替换 --accent 系，不动语义红绿', () => {
    for (const accent of ['violet', 'coral', 'teal', 'amber']) {
      const block = blockOf(tokens, `:root[data-accent='${accent}'] {`);
      expect(block).toContain('--accent:');
      expect(block).toContain('--accent-soft:');
      expect(block).toContain('--accent-ink:');
      expect(block, `${accent} 不应改语义色`).not.toMatch(
        /--(red|green|amber|violet|coral|teal)\s*:/,
      );
    }
  });
});

describe.each(targets)('%s 只消费令牌', (_name, rawCss) => {
  const css = stripComments(rawCss);

  it('没有颜色字面量（hex / rgb / rgba）', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(/i);
  });

  it('没有 px 字号或带 px 的 font 简写', () => {
    for (const match of css.matchAll(/font-size:\s*([^;]+);/g)) {
      expect(match[1].trim(), 'font-size 必须引用令牌').toMatch(/^var\(--/);
    }
    for (const match of css.matchAll(/(^|[^-])font:\s*([^;]+);/g)) {
      expect(match[2], 'font 简写不得写死 px').not.toMatch(/\d+px/);
    }
  });

  it('没有 px / 百分比圆角', () => {
    for (const match of css.matchAll(/border-radius:\s*([^;]+);/g)) {
      const value = match[1];
      expect(value, 'border-radius 不得写死 px').not.toMatch(
        /\d+(?:\.\d+)?px/,
      );
      expect(value, '50% 应使用 --radius-circle').not.toMatch(/\b50%/);
    }
  });
});

describe('按钮三档尺寸与图标间距', () => {
  it.each(BUTTON_SELECTORS)(
    '%s %s 的高度/圆角来自令牌',
    (file, selector, heightToken, radiusToken) => {
      const content = targets.find(([name]) => name === file)?.[1] ?? '';
      const block = blockOf(stripComments(content), selector);
      expect(block).toContain(`height: var(${heightToken})`);
      expect(block).toContain(`border-radius: var(${radiusToken})`);
    },
  );

  it('主/危险按钮共用一个危险确认令牌', () => {
    const all = targets.map(([, css]) => stripComments(css)).join('\n');
    expect(all).toContain('var(--on-danger)');
    expect(all).toContain('var(--danger-hover)');
    expect(all).toContain('var(--radius-button)');
    expect(all).toContain('var(--icon-gap)');
  });
});
