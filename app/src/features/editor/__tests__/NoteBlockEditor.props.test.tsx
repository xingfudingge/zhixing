import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { NoteBlockEditor } from '../NoteBlockEditor';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
} from './fakeBlockSource';

function paragraph(id: string, text: string) {
  return makeBlock({
    id,
    type: 'paragraph',
    payload: { runs: [{ text }] },
  });
}

function seededSource() {
  return createFakeBlockSource([
    paragraph('b1', '第一段'),
    paragraph('b2', '第二段'),
    paragraph('b3', '第三段'),
  ]);
}

function renderEditor(
  source: ReturnType<typeof seededSource>,
) {
  return render(
    <NoteBlockEditor noteId={FAKE_NOTE_ID} source={source} saveDelayMs={0} />,
  );
}

/** jsdom 不计算布局，浮层契约通过 CSSOM 断言（与 PROPS-01 测试一致）。 */
function editorCssRule(selector: string): CSSStyleRule {
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule instanceof CSSStyleRule && rule.selectorText === selector) {
        return rule;
      }
    }
  }
  throw new Error(`没有找到编辑器 CSS 规则：${selector}`);
}

describe('编辑器 · 块序号默认隐藏（ZX6-PROPS-02 / D11）', () => {
  it('默认打开多块笔记不渲染块序号；普通输入聚焦也不渲染', async () => {
    const { container } = renderEditor(seededSource());
    await screen.findAllByRole('textbox', { name: '正文' });

    expect(container.querySelector('.zxe-row-index')).toBeNull();

    const firstEditor = container.querySelector<HTMLElement>(
      '[data-inline-editor="true"]',
    );
    expect(firstEditor).not.toBeNull();
    firstEditor!.focus();
    // 普通输入态不是块选择态，序号仍不出现。
    expect(container.querySelector('.zxe-row-index')).toBeNull();
  });

  it('指针悬停当前行才出现序号，移开消失，且一次只出现一个', async () => {
    const { container } = renderEditor(seededSource());
    await screen.findAllByRole('textbox', { name: '正文' });

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('.zxe-row'),
    );
    expect(rows).toHaveLength(3);

    fireEvent.mouseEnter(rows[1]);
    await waitFor(() => {
      expect(
        rows[1].querySelector('.zxe-row-index')?.textContent,
      ).toBe('2');
    });
    expect(container.querySelectorAll('.zxe-row-index')).toHaveLength(1);
    expect(rows[0].querySelector('.zxe-row-index')).toBeNull();

    fireEvent.mouseLeave(rows[1]);
    await waitFor(() => {
      expect(container.querySelector('.zxe-row-index')).toBeNull();
    });
  });

  it('显式块选择态显示选中块序号', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor(seededSource());
    await screen.findAllByRole('textbox', { name: '正文' });

    await user.click(
      await screen.findByRole('button', { name: '选择块（高级）' }),
    );

    const selected = container.querySelector<HTMLElement>(
      '.zxe-row.is-block-selected',
    );
    expect(selected).not.toBeNull();
    expect(
      selected!.querySelector('.zxe-row-index')?.textContent,
    ).toBeTruthy();
    // 未选中的行仍不显示序号。
    expect(
      container.querySelectorAll('.zxe-row-index').length,
    ).toBe(container.querySelectorAll('.zxe-row.is-block-selected').length);
  });

  it('块序号绝对定位，不参与行内布局', () => {
    expect(editorCssRule('.zxe-row-index').style.position).toBe(
      'absolute',
    );
  });
});

describe('编辑器 · 代码属性头默认隐藏（ZX6-PROPS-02 / D10）', () => {
  function codeSource() {
    return createFakeBlockSource([
      makeBlock({ id: 'p1', type: 'paragraph', payload: { runs: [] } }),
      makeBlock({
        id: 'code1',
        type: 'code',
        payload: { code: 'const a = 1;', language: 'ts' },
        orderKey: 2048,
      }),
    ]);
  }

  it('默认打开笔记时 DOM 中没有 .zxe-code-head', async () => {
    const { container } = renderEditor(codeSource());
    await screen.findByLabelText('笔记正文');
    expect(container.querySelector('.zxe-code-head')).toBeNull();
  });

  it('属性头绝对定位在代码块上方，不占文档流、不遮挡第一行', async () => {
    const { container } = renderEditor(codeSource());
    await screen.findByLabelText('笔记正文');
    fireEvent.mouseEnter(screen.getByRole('group', { name: '代码块' }));
    expect(container.querySelector('.zxe-code-head')).not.toBeNull();

    const rule = editorCssRule('.zxe-code-head');
    expect(rule.style.position).toBe('absolute');
    // 浮在代码块上方（bottom:100%），不占用代码正文高度。
    expect(rule.style.bottom).not.toBe('');
    expect(rule.style.top).toBe('');
    expect(rule.style.right).toBe('0px');

    // 悬浮时仍可操作语言/复制/更多；不新增布局行。
    const head = container.querySelector('.zxe-code-head') as HTMLElement;
    expect(
      within(head).getByRole('combobox', { name: '代码语言' }),
    ).toBeInTheDocument();
    expect(
      within(head).getByRole('button', { name: '复制' }),
    ).toBeInTheDocument();
    expect(
      within(head).getByRole('button', { name: '更多代码块选项' }),
    ).toBeInTheDocument();
  });
});
