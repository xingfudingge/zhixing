/**
 * ZX-UX-05 笔记待办复选框可见性回归。
 *
 * 真实组件 + 真实 CSS：断言内联待办与文末「本篇待办」的复选框在 DOM 中
 * 保留边框/背景/至少 17×17 的点击区，并覆盖空、勾选、悬停、聚焦、
 * 禁用五种状态。jsdom 不解析 `var()` 的 computed value，因此样式值从
 * 注入的 CSSOM 规则读取；真实 WebView 的 computed value 由
 * tests/e2e/zx-ux-05-desktop.mjs 验证。
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { NoteTodo } from '../../../data/db/types';
import type { EditorBlock } from '../../../data/repositories/blocks';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
} from '../__tests__/fakeBlockSource';
import { NoteTodosWorkspace } from '../todos/NoteTodosWorkspace';
import {
  createFakeNoteTodoSource,
  makeNoteTodo,
} from '../todos/__tests__/fakeNoteTodoSource';
import {
  createFakeTodoTaskSource,
  makeFakeList,
} from '../todos/__tests__/fakeTodoTaskSource';

const TODOS: NoteTodo[] = [
  makeNoteTodo({
    id: 'todo-1',
    noteId: FAKE_NOTE_ID,
    title: '确认接口契约',
    done: true,
    sortOrder: 1,
  }),
  makeNoteTodo({
    id: 'todo-2',
    noteId: FAKE_NOTE_ID,
    title: '补齐暗色截图',
    sortOrder: 2,
  }),
  makeNoteTodo({
    id: 'todo-3',
    noteId: FAKE_NOTE_ID,
    title: '手测三条待办',
    sortOrder: 3,
  }),
];

function todoBlock(
  id: string,
  todoId: string,
  text: string,
  checked: boolean,
  orderKey: number,
): EditorBlock {
  return makeBlock({
    id,
    type: 'todo',
    orderKey,
    payload: { runs: [{ text }], checked, todoId },
  });
}

const BLOCKS: EditorBlock[] = [
  todoBlock('block-1', 'todo-1', '确认接口契约', true, 1024),
  todoBlock('block-2', 'todo-2', '补齐暗色截图', false, 2048),
  todoBlock('block-3', 'todo-3', '手测三条待办', false, 3072),
];

function renderWorkspace(readOnly = false) {
  const blockSource = createFakeBlockSource(BLOCKS);
  const noteTodoSource = createFakeNoteTodoSource(TODOS);
  const tasks = createFakeTodoTaskSource([], [
    makeFakeList({ id: 'inbox', name: '收件箱', isInbox: true, sortOrder: 0 }),
  ]);
  const view = render(
    <NoteTodosWorkspace
      noteId={FAKE_NOTE_ID}
      blockSource={blockSource}
      noteTodoSource={noteTodoSource}
      taskSource={{ tasks: tasks.tasks, lists: tasks.lists }}
      saveDelayMs={0}
      editorProps={readOnly ? { readOnly: true } : undefined}
    />,
  );
  return view;
}

function cssRule(selector: string): CSSStyleRule {
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule instanceof CSSStyleRule && rule.selectorText === selector) {
        return rule;
      }
    }
  }
  throw new Error(`没有找到 CSS 规则：${selector}`);
}


describe('ZX-UX-05 · 待办复选框可见性', () => {
  it('内联与文末复选框都保留边框、背景和 ≥17×17 点击区', async () => {
    const { container } = renderWorkspace();

    await screen.findByLabelText('本篇待办');
    const inlineChecks = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.zxe-todo-check'),
    );
    const summaryChecks = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.zxt-summary-check'),
    );

    expect(inlineChecks).toHaveLength(3);
    expect(summaryChecks).toHaveLength(3);

    for (const checkbox of [...inlineChecks, ...summaryChecks]) {
      expect(checkbox).toHaveAttribute('role', 'checkbox');
      expect(checkbox).toHaveAttribute(
        'aria-checked',
        checkbox.closest('.is-done') ? 'true' : 'false',
      );
      const width = Number.parseFloat(getComputedStyle(checkbox).width);
      const height = Number.parseFloat(getComputedStyle(checkbox).height);
      expect(width).toBeGreaterThanOrEqual(17);
      expect(height).toBeGreaterThanOrEqual(17);
    }

    const inlineRule = cssRule('.zxe-todo-check');
    expect(inlineRule.style.border).toBe('1.5px solid var(--muted)');
    expect(inlineRule.style.background).toBe('var(--surface)');
    expect(inlineRule.style.width).toBe('18px');
    expect(inlineRule.style.height).toBe('18px');
    expect(inlineRule.style.minWidth).toBe('18px');
    expect(inlineRule.style.minHeight).toBe('18px');

    const summaryRule = cssRule('.zxt-summary-check');
    expect(summaryRule.style.border).toBe('1.5px solid var(--muted)');
    expect(summaryRule.style.background).toBe('var(--surface)');
    expect(summaryRule.style.width).toBe('18px');
    expect(summaryRule.style.height).toBe('18px');
    expect(summaryRule.style.minWidth).toBe('18px');
    expect(summaryRule.style.minHeight).toBe('18px');

    // 原 bug 的根因：`.zxe button`（0,1,1）压过 `.zxe-todo-check`
    // （0,1,0），把 border/background 清空。reset 必须保持低特异性。
    expect(() => cssRule('.zxe button')).toThrow();
    expect(cssRule(':where(.zxe) button').style.border).toBe('0px');
  });

  it('勾选态、悬停、聚焦、禁用都有独立可辨的样式规则', async () => {
    renderWorkspace();
    await screen.findByLabelText('本篇待办');

    expect(cssRule('.zxe-todo.is-done .zxe-todo-check').style.cssText).toContain(
      'border-color: var(--green)',
    );
    expect(cssRule('.zxe-todo.is-done .zxe-todo-check').style.cssText).toContain(
      'background: var(--green)',
    );
    expect(
      cssRule('.zxt-summary-row.is-done .zxt-summary-check').style.cssText,
    ).toContain('background: var(--green)');

    expect(
      cssRule('.zxe-todo-check:hover:not(:disabled)').style.cssText,
    ).toContain('border-color: var(--accent)');
    expect(
      cssRule('.zxe-todo-check:hover:not(:disabled)').style.cssText,
    ).toContain('background: var(--accent-soft)');
    expect(
      cssRule('.zxt-summary-check:hover:not(:disabled)').style.cssText,
    ).toContain('background: var(--accent-soft)');

    for (const selector of [
      '.zxe-todo-check:focus',
      '.zxt-summary-check:focus',
    ]) {
      const rule = cssRule(selector);
      expect(rule.style.cssText).toContain(
        'outline: 2px solid var(--accent-ink)',
      );
      expect(rule.style.cssText).toContain('outline-offset: 2px');
    }

    expect(cssRule('.zxe-todo-check:disabled').style.cssText).toContain(
      'border-color: var(--line-strong)',
    );
    expect(cssRule('.zxt-summary-check:disabled').style.cssText).toContain(
      'background: var(--surface-3)',
    );
  });

  it('点击内联复选框后 aria-checked 与文末汇总同步，语义不变', async () => {
    const user = userEvent.setup();
    const { container } = renderWorkspace();
    await screen.findByLabelText('本篇待办');

    const secondInline = container.querySelector<HTMLButtonElement>(
      '[data-block-id="block-2"] .zxe-todo-check',
    );
    expect(secondInline).not.toBeNull();
    expect(secondInline).toHaveAttribute('aria-checked', 'false');

    await user.click(secondInline!);

    await waitFor(() => {
      expect(secondInline).toHaveAttribute('aria-checked', 'true');
    });
    const summaryCheck = screen.getByRole('checkbox', {
      name: /补齐暗色截图/,
    });
    await waitFor(() => {
      expect(summaryCheck).toHaveAttribute('aria-checked', 'true');
    });
    expect(secondInline).toHaveAccessibleName('标记未完成');
    expect(summaryCheck).toHaveAccessibleName('标记未完成：补齐暗色截图');
  });

  it('只读笔记中复选框保持可见但禁用，点击不改变状态', async () => {
    const user = userEvent.setup();
    const { container } = renderWorkspace(true);
    await screen.findByLabelText('本篇待办');

    const checks = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '.zxe-todo-check, .zxt-summary-check',
      ),
    );
    expect(checks).toHaveLength(6);
    for (const checkbox of checks) {
      expect(checkbox).toBeDisabled();
    }

    const secondInline = container.querySelector<HTMLButtonElement>(
      '[data-block-id="block-2"] .zxe-todo-check',
    );
    await user.click(secondInline!);
    expect(secondInline).toHaveAttribute('aria-checked', 'false');
  });
});
