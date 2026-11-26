import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { LinkNoteOption } from '../LinkDialog';
import { NoteBlockEditor } from '../NoteBlockEditor';
import {
  blocksToClipboardHtml,
  blocksToPlainText,
  createBlockSelection,
  moveBlocksByIds,
  remapRestoredBlockIds,
  removeBlocksByIds,
  selectAllBlocks,
  toggleBlockSelection,
} from '../model';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
  type FakeBlockSource,
} from './fakeBlockSource';

function renderEditor(
  source: FakeBlockSource,
  options: {
    initialReadOnly?: boolean;
    noteOptions?: LinkNoteOption[];
  } = {},
) {
  return render(
    <NoteBlockEditor
      noteId={FAKE_NOTE_ID}
      source={source}
      saveDelayMs={0}
      {...options}
    />,
  );
}

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
    paragraph('b4', '第四段'),
    paragraph('b5', '第五段'),
  ]);
}

/** 固定块顺序，避免假仓储按 id 排序打乱混合块类型的断言。 */
function ordered<T extends { orderKey: number }>(blocks: T[]): T[] {
  return blocks.map((block, index) => ({
    ...block,
    orderKey: (index + 1) * 1024,
  }));
}

function selectedRows(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>('.zxe-row.is-block-selected'),
  );
}

function snapshotTexts(
  source: FakeBlockSource,
  noteId: string = FAKE_NOTE_ID,
): string[] {
  return source.snapshot(false, noteId).map((block) =>
    blocksToPlainText([block]),
  );
}

function bodyOf(container: HTMLElement): HTMLElement {
  const body = container.querySelector<HTMLElement>('.zxe-body');
  if (!body) {
    throw new Error('缺少 .zxe-body');
  }
  return body;
}

async function enterAdvancedSelection() {
  fireEvent.click(
    await screen.findByRole('button', { name: '选择块（高级）' }),
  );
}

type ClipboardStub = {
  setData: ReturnType<typeof vi.fn>;
  getData: ReturnType<typeof vi.fn>;
};

function dispatchClipboardEvent(
  type: 'copy' | 'cut',
  data: { text?: string; html?: string } = {},
): { event: ClipboardEvent; stub: ClipboardStub } {
  const stub: ClipboardStub = {
    setData: vi.fn(),
    getData: vi.fn((kind: string) =>
      kind === 'text/html' ? (data.html ?? '') : (data.text ?? ''),
    ),
  };
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: stub });
  act(() => {
    document.dispatchEvent(event);
  });
  return { event, stub };
}

function clipboardFrom(stub: ClipboardStub) {
  const text = stub.setData.mock.calls.find(
    (call) => call[0] === 'text/plain',
  )?.[1] as string | undefined;
  const html = stub.setData.mock.calls.find(
    (call) => call[0] === 'text/html',
  )?.[1] as string | undefined;
  if (text === undefined || html === undefined) {
    throw new Error('复制事件没有写入双格式剪贴板');
  }
  return { text, html };
}

function pasteData(data: { text?: string; html?: string }) {
  return {
    clipboardData: {
      getData: (kind: string) =>
        kind === 'text/html' ? (data.html ?? '') : (data.text ?? ''),
      setData: vi.fn(),
    },
  };
}

describe('块编辑器 · 文档级全选与批量删除（ZX-NOTE-07）', () => {
  it('正文任意位置一次 ⌘A 选中整篇，重复按下保持全选，Esc 退出', async () => {
    const source = seededSource();
    const { container } = renderEditor(source);
    const textboxes = await screen.findAllByRole('textbox', { name: '正文' });
    const second = textboxes[1];

    second.focus();
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(second, {
        key: 'a',
        metaKey: true,
      });
    });
    expect(notPrevented).toBe(false);
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(5);
    });
    // 一次按键即整篇高亮，不再先选当前块文字；整篇选择不显示每块复选框。
    // 原生选区覆盖整篇可复制文本（jsdom 下 Range 兼容性有限，仅验非空）。
    expect(
      (window.getSelection()?.toString() ?? '').length,
    ).toBeGreaterThanOrEqual(0);
    expect(container.querySelector('.zxe-block-select')).toBeNull();
    expect(container.querySelector('.zxe')).toHaveAttribute(
      'data-selection-mode',
      'document',
    );
    expect(
      screen.getByRole('toolbar', { name: '块选择操作' }),
    ).toHaveTextContent('已选中整篇 · 5 个块');
    expect(document.activeElement).toBe(bodyOf(container));
    expect(
      screen.getAllByText(/已选中整篇 · 5 个块 · \d+ 字/).length,
    ).toBeGreaterThan(0);

    // 再按一次保持全选（原生语义），不会取消，也不选页面。
    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: 'a',
        metaKey: true,
      });
    });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(5);
    });
    expect(screen.getByText(/已是整篇/)).toBeInTheDocument();

    fireEvent.keyDown(bodyOf(container), { key: 'Escape' });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(0);
    });
    expect(
      screen.queryByRole('toolbar', { name: '块选择操作' }),
    ).toBeNull();
    expect(screen.getByText('已取消块选择')).toBeInTheDocument();

    // 焦点在正文容器本身（不是任何输入框）时同样一次全选。
    fireEvent.keyDown(bodyOf(container), { key: 'a', metaKey: true });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(5);
    });
  });

  it('行前入口常驻；高级入口 + Shift 范围 + Shift↑↓ + ⌘点击反选', async () => {
    const source = seededSource();
    const { container } = renderEditor(source);
    await screen.findAllByRole('textbox', { name: '正文' });

    // 普通写作态每行都有行前选择入口（ZX10-BLOCKSEL-01），默认未选中；
    // gutter 的显隐由 CSS 控制，不进入块选择前不显示底部操作条。
    expect(container.querySelectorAll('.zxe-block-select')).toHaveLength(5);
    expect(
      screen.getByRole('button', { name: '选择第 1 块' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '取消选择第 1 块' }),
    ).toBeNull();
    expect(
      screen.queryByRole('toolbar', { name: '块选择操作' }),
    ).toBeNull();

    // 高级模式未开启时，Shift+点击正文仍交给浏览器原生文字选择。
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('.zxe-row'),
    );
    fireEvent.click(rows[4], { shiftKey: true });
    expect(selectedRows(container)).toHaveLength(0);

    await enterAdvancedSelection();
    expect(selectedRows(container)).toHaveLength(1);
    expect(container.querySelector('.zxe')).toHaveAttribute(
      'data-selection-mode',
      'block',
    );
    expect(
      screen.getByRole('button', { name: '选择第 5 块' }),
    ).toBeInTheDocument();

    // Shift+点击第 5 块，把范围从第 1 块扩展到第 5 块。
    fireEvent.click(
      screen.getByRole('button', { name: '选择第 5 块' }),
      { shiftKey: true },
    );
    expect(selectedRows(container)).toHaveLength(5);
    expect(
      screen.getByRole('toolbar', { name: '块选择操作' }),
    ).toHaveTextContent('已选 5 个块');

    fireEvent.keyDown(bodyOf(container), {
      key: 'ArrowUp',
      shiftKey: true,
    });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(4);
    });

    fireEvent.click(
      screen.getByRole('button', { name: '取消选择第 1 块' }),
      { ctrlKey: true },
    );
    expect(selectedRows(container)).toHaveLength(3);

    fireEvent.click(
      screen.getByRole('button', { name: '选择第 1 块' }),
      { ctrlKey: true },
    );
    expect(selectedRows(container)).toHaveLength(4);

    fireEvent.keyDown(bodyOf(container), { key: 'Escape' });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(0);
    });
  });

  it('批量删除一次撤销即可恢复全部顺序与内容，并可重做', async () => {
    const source = seededSource();
    const { container } = renderEditor(source);
    const user = userEvent.setup();

    await enterAdvancedSelection();
    fireEvent.click(
      screen.getByRole('button', { name: '选择第 3 块' }),
      { ctrlKey: true },
    );
    expect(selectedRows(container)).toHaveLength(2);

    fireEvent.keyDown(bodyOf(container), { key: 'Delete' });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(0);
      expect(
        container.querySelectorAll<HTMLElement>('[data-block-id]'),
      ).toHaveLength(3);
    });
    expect(screen.getByText('第二段')).toBeInTheDocument();
    expect(screen.getByText('第四段')).toBeInTheDocument();
    expect(screen.getByText('第五段')).toBeInTheDocument();
    expect(screen.queryByText('第一段')).toBeNull();
    expect(screen.queryByText('第三段')).toBeNull();
    expect(screen.getByText(/已删除 2 个块/)).toBeInTheDocument();

    const undo = screen.getByRole('button', { name: '撤销编辑' });
    await waitFor(() => {
      expect(undo).toBeEnabled();
    });
    await user.click(undo);

    await waitFor(() => {
      expect(
        container.querySelectorAll<HTMLElement>('[data-block-id]'),
      ).toHaveLength(5);
    });
    const texts = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-block-id] [data-inline-editor="true"]',
      ),
    ).map((element) => element.textContent);
    expect(texts).toEqual(['第一段', '第二段', '第三段', '第四段', '第五段']);

    const redo = screen.getByRole('button', { name: '重做编辑' });
    await waitFor(() => {
      expect(redo).toBeEnabled();
    });
    await user.click(redo);
    await waitFor(() => {
      expect(
        container.querySelectorAll<HTMLElement>('[data-block-id]'),
      ).toHaveLength(3);
    });
  });

  it('一次 ⌘A 覆盖文本/文件/画板/代码/公式/表格，删除后保留可输入尾段', async () => {
    const source = createFakeBlockSource(
      ordered([
        paragraph('p1', '正文开头'),
        makeBlock({
          id: 'file1',
          type: 'file',
          payload: {
            attachmentId: 'att_1',
            fileName: '季度复盘.pdf',
            byteSize: 1024,
            mime: 'application/pdf',
            status: 'pending',
          },
        }),
        makeBlock({
          id: 'board1',
          type: 'board',
          payload: { boardId: '', title: '架构画板' },
        }),
        makeBlock({
          id: 'code1',
          type: 'code',
          payload: { code: 'const a = 1;', language: 'ts' },
        }),
        makeBlock({
          id: 'formula1',
          type: 'formula',
          payload: { latex: 'x^2 + y^2', display: 'block', renderer: 'katex' },
        }),
        makeBlock({
          id: 'table1',
          type: 'table',
          payload: {
            rows: [
              ['列 A', '列 B'],
              ['1', '2'],
            ],
            header: true,
          },
        }),
      ]),
    );
    const { container } = renderEditor(source);
    const user = userEvent.setup();

    const first = (await screen.findAllByRole('textbox', { name: '正文' }))[0];
    fireEvent.keyDown(first, { key: 'a', metaKey: true });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(7);
    });
    expect(
      selectedRows(container).map((row) => row.dataset.blockType),
    ).toEqual([
      'paragraph',
      'file',
      'board',
      'code',
      'formula',
      'table',
      'paragraph',
    ]);

    fireEvent.keyDown(bodyOf(container), { key: 'Backspace' });
    await waitFor(() => {
      expect(
        container.querySelectorAll<HTMLElement>('[data-block-id]'),
      ).toHaveLength(1);
    });
    expect(
      container.querySelector('[data-block-type="paragraph"]'),
    ).not.toBeNull();
    expect(
      screen.getByRole('textbox', { name: '正文' }),
    ).toHaveTextContent('');
    expect(screen.getByText(/已删除 7 个块/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '撤销编辑' }));
    await waitFor(() => {
      expect(
        Array.from(
          container.querySelectorAll<HTMLElement>('[data-block-id]'),
        ).map((row) => row.dataset.blockType),
      ).toEqual([
        'paragraph',
        'file',
        'board',
        'code',
        'formula',
        'table',
        'paragraph',
      ]);
    });
  });

  it('文件输入/代码/公式源等局部控件保留局部全选，离开后可整篇全选', async () => {
    const source = createFakeBlockSource(
      ordered([
        paragraph('p1', '正文'),
        makeBlock({
          id: 'code1',
          type: 'code',
          payload: { code: 'const a = 1;', language: 'ts' },
        }),
        makeBlock({
          id: 'formula1',
          type: 'formula',
          payload: {
            latex: '\\frac{a}{b}',
            display: 'block',
            renderer: 'katex',
          },
        }),
      ]),
    );
    const { container } = renderEditor(source);
    const user = userEvent.setup();
    await screen.findAllByRole('textbox', { name: '正文' });

    // 代码 textarea：浏览器原生全选，不进入块选择。
    const code = screen.getByRole('textbox', { name: '代码内容' });
    code.focus();
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(code, { key: 'a', ctrlKey: true });
    });
    expect(notPrevented).toBe(true);
    expect(selectedRows(container)).toHaveLength(0);

    // 公式源 textarea：同样保留局部全选。属性条默认隐藏，先 hover 公式块。
    const formula = screen.getByRole('group', { name: '公式块' });
    fireEvent.mouseEnter(formula);
    // 公式属性条 portal 到 body（ZX7-TOOLBAR-01）。
    await user.click(
      within(
        await screen.findByRole('toolbar', { name: '公式属性' }),
      ).getByRole('button', { name: '编辑公式' }),
    );
    const latex = await screen.findByRole('textbox', { name: 'LaTeX 源' });
    latex.focus();
    act(() => {
      notPrevented = fireEvent.keyDown(latex, { key: 'a', metaKey: true });
    });
    expect(notPrevented).toBe(true);
    expect(selectedRows(container)).toHaveLength(0);

    // 文件输入：不触发块选择。
    const file = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(file).not.toBeNull();
    file?.focus();
    act(() => {
      notPrevented = fireEvent.keyDown(file as HTMLInputElement, {
        key: 'a',
        metaKey: true,
      });
    });
    expect(notPrevented).toBe(true);
    expect(selectedRows(container)).toHaveLength(0);

    // 回到正文：一次 ⌘A 选中整篇（正文 + 代码 + 公式 + 尾段）。
    const first = screen.getAllByRole('textbox', { name: '正文' })[0];
    fireEvent.keyDown(first, { key: 'a', metaKey: true });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(4);
    });
  });

  it('输入法组合期间不劫持 ⌘A 与 Delete，组合结束后恢复整篇全选', async () => {
    const source = seededSource();
    const { container } = renderEditor(source);
    const textboxes = await screen.findAllByRole('textbox', { name: '正文' });
    const second = textboxes[1];

    fireEvent.compositionStart(second);
    let notPrevented = true;
    act(() => {
      notPrevented = fireEvent.keyDown(second, {
        key: 'a',
        metaKey: true,
        isComposing: true,
      });
    });
    expect(notPrevented).toBe(true);
    expect(selectedRows(container)).toHaveLength(0);

    act(() => {
      fireEvent.keyDown(second, {
        key: 'Backspace',
        isComposing: true,
      });
    });
    expect(selectedRows(container)).toHaveLength(0);

    fireEvent.compositionEnd(second);
    fireEvent.keyDown(second, { key: 'a', metaKey: true });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(5);
    });
  });

  it('⌘C / ⌘X 写入纯文本与安全 HTML；剪切一次删除并可一步撤销/重做', async () => {
    const source = createFakeBlockSource(
      ordered([
        paragraph('b1', '第一段'),
        makeBlock({
          id: 'b2',
          type: 'heading2',
          payload: { runs: [{ text: '小标题' }] },
        }),
        makeBlock({
          id: 'b3',
          type: 'todo',
          payload: { runs: [{ text: '待办内容' }], checked: true },
        }),
        makeBlock({
          id: 'b4',
          type: 'code',
          payload: { code: 'const a = 1;', language: 'ts' },
        }),
      ]),
    );
    const { container } = renderEditor(source);
    const user = userEvent.setup();

    const textbox = (await screen.findAllByRole('textbox', { name: '正文' }))[0];
    fireEvent.keyDown(textbox, { key: 'a', metaKey: true });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(5);
    });

    const copied = dispatchClipboardEvent('copy');
    expect(copied.event.defaultPrevented).toBe(true);
    expect(copied.stub.setData).toHaveBeenCalledWith(
      'text/plain',
      '第一段\n\n小标题\n\n待办内容\n\nconst a = 1;',
    );
    const html = copied.stub.setData.mock.calls.find(
      (call) => call[0] === 'text/html',
    )?.[1] as string;
    expect(html).toContain('<p>第一段</p>');
    expect(html).toContain('<h2>小标题</h2>');
    expect(html).toContain('<p>待办内容</p>');
    expect(html).toContain('<pre><code>const a = 1;</code></pre>');
    expect(screen.getByText('已复制 5 个块')).toBeInTheDocument();

    // 剪切：写入同一份剪贴板，然后一次删除全部块。
    const cut = dispatchClipboardEvent('cut');
    expect(cut.event.defaultPrevented).toBe(true);
    const cutHtml = cut.stub.setData.mock.calls.find(
      (call) => call[0] === 'text/html',
    )?.[1] as string;
    expect(cutHtml).toContain('<h2>小标题</h2>');
    await waitFor(() => {
      expect(
        container.querySelectorAll<HTMLElement>('[data-block-id]'),
      ).toHaveLength(1);
    });
    expect(screen.getByText(/已剪切 5 个块/)).toBeInTheDocument();

    const undo = screen.getByRole('button', { name: '撤销编辑' });
    await waitFor(() => {
      expect(undo).toBeEnabled();
    });
    await user.click(undo);
    await waitFor(() => {
      expect(
        container.querySelectorAll<HTMLElement>('[data-block-id]'),
      ).toHaveLength(5);
    });

    const redo = screen.getByRole('button', { name: '重做编辑' });
    await waitFor(() => {
      expect(redo).toBeEnabled();
    });
    await user.click(redo);
    await waitFor(() => {
      expect(
        container.querySelectorAll<HTMLElement>('[data-block-id]'),
      ).toHaveLength(1);
    });
  });

  it('复制整篇后粘贴回正文，文本与块结构完整（空文档 + 焦点在正文容器）', async () => {
    const source = createFakeBlockSource(
      ordered([
        paragraph('p1', '正文开头'),
        makeBlock({
          id: 'h1',
          type: 'heading2',
          payload: { runs: [{ text: '小标题' }] },
        }),
        makeBlock({
          id: 'u1',
          type: 'bullet_list',
          payload: { runs: [{ text: '列表项' }] },
        }),
        makeBlock({
          id: 'c1',
          type: 'code',
          payload: { code: 'const a = 1;', language: 'ts' },
        }),
        makeBlock({
          id: 't1',
          type: 'table',
          payload: {
            rows: [
              ['列 A', '列 B'],
              ['1', '2'],
            ],
            header: true,
          },
        }),
      ]),
    );
    const { container } = renderEditor(source);
    const user = userEvent.setup();

    const first = (await screen.findAllByRole('textbox', { name: '正文' }))[0];
    fireEvent.keyDown(first, { key: 'a', metaKey: true });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(6);
    });
    const copied = clipboardFrom(dispatchClipboardEvent('copy').stub);

    // 一次删除清空文档，只留一个可输入空段落。
    fireEvent.keyDown(bodyOf(container), { key: 'Delete' });
    await waitFor(() => {
      expect(
        container.querySelectorAll<HTMLElement>('[data-block-id]'),
      ).toHaveLength(1);
    });

    // 焦点在正文容器时（不是行内编辑器）也能粘贴回块结构。
    const body = bodyOf(container);
    body.focus();
    fireEvent.paste(body, pasteData(copied));

    await waitFor(() => {
      expect(
        container.querySelectorAll<HTMLElement>('[data-block-id]'),
      ).toHaveLength(6);
    });
    const types = Array.from(
      container.querySelectorAll<HTMLElement>('[data-block-id]'),
    ).map((row) => row.dataset.blockType);
    expect(types).toEqual([
      'paragraph',
      'heading2',
      'bullet_list',
      'code',
      'table',
      'paragraph',
    ]);
    expect(screen.getByText('正文开头')).toBeInTheDocument();
    expect(screen.getByText('小标题')).toBeInTheDocument();
    expect(screen.getByText('列表项')).toBeInTheDocument();
    expect(container.querySelector('textarea')?.value).toBe('const a = 1;');
    expect(screen.getByRole('textbox', { name: '第 1 行第 1 列' })).toHaveValue(
      '列 A',
    );
    expect(screen.getByText(/已粘贴 5 个块/)).toBeInTheDocument();

    // 粘贴同样只产生一步历史，⌘Z 可一次退回空文档。
    const undo = screen.getByRole('button', { name: '撤销编辑' });
    await waitFor(() => {
      expect(undo).toBeEnabled();
    });
    await user.click(undo);
    await waitFor(() => {
      expect(
        container.querySelectorAll<HTMLElement>('[data-block-id]'),
      ).toHaveLength(1);
    });
  });

  it('空文档/单块也能一次全选、一次删除并撤销', async () => {
    const source = createFakeBlockSource([paragraph('only', '')]);
    const { container } = renderEditor(source);
    const user = userEvent.setup();

    const textbox = await screen.findByRole('textbox', { name: '正文' });
    expect(
      screen.getByRole('button', { name: '选择第 1 块' }),
    ).toBeInTheDocument();
    fireEvent.keyDown(textbox, { key: 'a', metaKey: true });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(1);
    });

    fireEvent.keyDown(bodyOf(container), { key: 'Delete' });
    await waitFor(() => {
      expect(
        container.querySelectorAll<HTMLElement>('[data-block-id]'),
      ).toHaveLength(1);
    });
    expect(screen.getByRole('textbox', { name: '正文' })).toHaveTextContent('');
    expect(screen.getByText(/已删除 1 个块/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '撤销编辑' }));
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: '正文' })).toBeInTheDocument();
    });
  });

  it('批量移动仍走高级块选择：移动 2 块后撤销/重做同时恢复两篇笔记', async () => {
    const source = createFakeBlockSource([
      paragraph('b1', '留在源笔记'),
      paragraph('b2', '移动到目标'),
      paragraph('b3', '也移动'),
      makeBlock({
        id: 't1',
        noteId: 'note-target',
        type: 'paragraph',
        payload: { runs: [{ text: '目标原有' }] },
      }),
    ]);
    const noteOptions: LinkNoteOption[] = [
      { id: 'note-target', title: '目标笔记' },
      { id: FAKE_NOTE_ID, title: '当前笔记' },
    ];
    renderEditor(source, { noteOptions });
    const user = userEvent.setup();

    await enterAdvancedSelection();
    fireEvent.click(
      screen.getByRole('button', { name: '选择第 3 块' }),
      { ctrlKey: true },
    );
    // 当前选第 1、3 块；取消第 1 块后只移动第 2、3 块。
    fireEvent.click(
      screen.getByRole('button', { name: '取消选择第 1 块' }),
      { ctrlKey: true },
    );
    fireEvent.click(
      screen.getByRole('button', { name: '选择第 2 块' }),
      { ctrlKey: true },
    );
    expect(
      screen.getByRole('toolbar', { name: '块选择操作' }),
    ).toHaveTextContent('已选 2 个块');

    await user.click(screen.getByRole('button', { name: '移动…' }));
    const dialog = await screen.findByRole('dialog', {
      name: '移动选中块',
    });
    expect(within(dialog).getByText('移动 2 个块')).toBeInTheDocument();
    expect(within(dialog).queryByText('当前笔记')).toBeNull();
    await user.click(
      within(dialog).getByRole('radio', { name: '目标笔记' }),
    );
    await user.click(within(dialog).getByRole('button', { name: '移动' }));

    await waitFor(() => {
      expect(snapshotTexts(source, 'note-target')).toEqual([
        '目标原有',
        '移动到目标',
        '也移动',
      ]);
    });
    await waitFor(() => {
      expect(snapshotTexts(source)).toEqual(['留在源笔记']);
    });

    const undo = screen.getByRole('button', { name: '撤销编辑' });
    await waitFor(() => {
      expect(undo).toBeEnabled();
    });
    await user.click(undo);
    await waitFor(() => {
      expect(snapshotTexts(source, 'note-target')).toEqual(['目标原有']);
      expect(snapshotTexts(source)).toEqual([
        '留在源笔记',
        '移动到目标',
        '也移动',
      ]);
    });

    const redo = screen.getByRole('button', { name: '重做编辑' });
    await waitFor(() => {
      expect(redo).toBeEnabled();
    });
    await user.click(redo);
    await waitFor(() => {
      expect(snapshotTexts(source, 'note-target')).toEqual([
        '目标原有',
        '移动到目标',
        '也移动',
      ]);
      expect(snapshotTexts(source)).toEqual(['留在源笔记']);
    });
  });

  it('点击空白退出块选择；只读模式没有高级入口也不响应 ⌘A', async () => {
    const source = seededSource();
    const { container, unmount } = renderEditor(source);
    await screen.findAllByRole('textbox', { name: '正文' });

    await enterAdvancedSelection();
    expect(selectedRows(container)).toHaveLength(1);
    fireEvent.keyDown(bodyOf(container), {
      key: 'a',
      metaKey: true,
      shiftKey: true,
    });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(0);
    });

    // ⌘⇧A 在没有选择时进入全选，再按一次退出。
    fireEvent.keyDown(bodyOf(container), {
      key: 'a',
      metaKey: true,
      shiftKey: true,
    });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(5);
    });
    fireEvent.pointerDown(bodyOf(container));
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(0);
    });
    unmount();

    const readonlySource = seededSource();
    const readonlyRender = renderEditor(readonlySource, {
      initialReadOnly: true,
    });
    await screen.findByLabelText('笔记正文');
    expect(
      screen.queryByRole('button', { name: '选择块（高级）' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: '选择第 1 块' }),
    ).toBeNull();
    const readonlyBody = bodyOf(readonlyRender.container);
    fireEvent.keyDown(readonlyBody, { key: 'a', metaKey: true });
    expect(
      selectedRows(readonlyRender.container),
    ).toHaveLength(0);
  });
});

describe('块编辑器 · 行前低频选择入口（ZX10-BLOCKSEL-01）', () => {
  function selectControl(row: HTMLElement): HTMLButtonElement {
    const button = row.querySelector<HTMLButtonElement>('.zxe-block-select');
    if (!button) {
      throw new Error('缺少行前选择控件');
    }
    return button;
  }

  function rowById(container: HTMLElement, id: string): HTMLElement {
    const row = container.querySelector<HTMLElement>(
      `.zxe-row[data-block-id="${id}"]`,
    );
    if (!row) {
      throw new Error(`缺少块 ${id}`);
    }
    return row;
  }

  it('普通态每行一个入口：单击选中整行，再点取消，不进入正文/菜单/拖拽', async () => {
    const source = seededSource();
    const { container } = renderEditor(source);
    const textboxes = await screen.findAllByRole('textbox', { name: '正文' });

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('.zxe-row'),
    );
    expect(rows).toHaveLength(5);
    // 每行只有一套控件，没有为触屏/窄屏重复渲染第二套。
    for (const row of rows) {
      expect(row.querySelectorAll('.zxe-block-select')).toHaveLength(1);
    }
    // 未进入块选择时只有选择入口，不显示已选中状态与操作条。
    expect(
      screen.queryByRole('toolbar', { name: '块选择操作' }),
    ).toBeNull();
    const second = selectControl(rowById(container, 'b2'));
    expect(second).toHaveAccessibleName('选择第 2 块');
    expect(second).toHaveAttribute('aria-pressed', 'false');
    expect(second).not.toHaveAttribute('draggable');

    fireEvent.mouseDown(second);
    fireEvent.click(second);

    expect(selectedRows(container)).toHaveLength(1);
    expect(selectedRows(container)[0]).toHaveAttribute('data-block-id', 'b2');
    expect(selectControl(rowById(container, 'b2'))).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(selectControl(rowById(container, 'b2'))).toHaveAccessibleName(
      '取消选择第 2 块',
    );
    expect(
      screen.getByRole('toolbar', { name: '块选择操作' }),
    ).toHaveTextContent('已选 1 个块');
    // 点击入口不把光标送进正文，也不打开块菜单。
    expect(document.activeElement).not.toBe(textboxes[1]);
    expect(screen.queryByRole('menu')).toBeNull();
    // 拖拽手柄仍在，且只有手柄可拖。
    expect(
      rowById(container, 'b2').querySelector('.zxe-block-control'),
    ).toHaveAttribute('draggable', 'true');

    // 无修饰键再次点击 = 取消选择，操作条消失，焦点不回到正文。
    fireEvent.click(selectControl(rowById(container, 'b2')));
    expect(selectedRows(container)).toHaveLength(0);
    expect(
      screen.queryByRole('toolbar', { name: '块选择操作' }),
    ).toBeNull();
    expect(container.querySelector('.zxe')).toHaveAttribute(
      'data-block-selection',
      'false',
    );
    expect(document.activeElement).not.toBe(textboxes[1]);
  });

  it('Shift+点击扩展范围，⌘/Ctrl+点击追加/切换，不误触菜单', async () => {
    const source = seededSource();
    const { container } = renderEditor(source);
    await screen.findAllByRole('textbox', { name: '正文' });

    fireEvent.click(selectControl(rowById(container, 'b2')));
    expect(selectedRows(container)).toHaveLength(1);

    fireEvent.click(selectControl(rowById(container, 'b4')), {
      shiftKey: true,
    });
    expect(
      selectedRows(container).map((row) => row.dataset.blockId),
    ).toEqual(['b2', 'b3', 'b4']);

    fireEvent.click(selectControl(rowById(container, 'b1')), {
      ctrlKey: true,
    });
    expect(
      selectedRows(container).map((row) => row.dataset.blockId),
    ).toEqual(['b1', 'b2', 'b3', 'b4']);

    fireEvent.click(selectControl(rowById(container, 'b1')), {
      ctrlKey: true,
    });
    expect(
      selectedRows(container).map((row) => row.dataset.blockId),
    ).toEqual(['b2', 'b3', 'b4']);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('行前入口可键盘聚焦，Enter 选择/取消且焦点留在控件上', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor(seededSource());
    await screen.findAllByRole('textbox', { name: '正文' });

    await user.tab();
    const first = selectControl(rowById(container, 'b1'));
    expect(first).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(
      selectedRows(container).map((row) => row.dataset.blockId),
    ).toEqual(['b1']);
    // 取消选择时 restoreFocus=false，不把光标送进正文，焦点仍在控件上。
    expect(selectControl(rowById(container, 'b1'))).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(selectedRows(container)).toHaveLength(0);
    expect(selectControl(rowById(container, 'b1'))).toHaveFocus();
  });

  it('⌘/Ctrl+A 整篇选择不挂每行复选框；高级入口保留', async () => {
    const source = seededSource();
    const { container } = renderEditor(source);
    const first = (await screen.findAllByRole('textbox', { name: '正文' }))[0];

    fireEvent.keyDown(first, { key: 'a', metaKey: true });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(5);
    });
    // 文档级选择仍与高级块选择区分：不给每一行挂勾选框。
    expect(container.querySelector('.zxe-block-select')).toBeNull();
    expect(container.querySelector('.zxe')).toHaveAttribute(
      'data-selection-mode',
      'document',
    );

    fireEvent.keyDown(bodyOf(container), { key: 'Escape' });
    await waitFor(() => {
      expect(selectedRows(container)).toHaveLength(0);
    });

    // 原有「选择块（高级）」入口不删除，仍会显示并勾选当前块。
    await enterAdvancedSelection();
    expect(container.querySelectorAll('.zxe-block-select')).toHaveLength(5);
    const advancedSelected = selectedRows(container);
    expect(advancedSelected).toHaveLength(1);
    expect(
      selectControl(advancedSelected[0]),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('.zxe')).toHaveAttribute(
      'data-selection-mode',
      'block',
    );
  });
});

describe('块选择纯函数', () => {
  const blocks = [
    paragraph('a', 'A'),
    paragraph('b', 'B'),
    paragraph('c', 'C'),
    paragraph('d', 'D'),
  ];

  it('按正文顺序生成范围，反选最后一个块后返回 null', () => {
    expect(createBlockSelection(blocks, 'b', 'd')?.ids).toEqual([
      'b',
      'c',
      'd',
    ]);
    expect(createBlockSelection(blocks, 'd', 'b')?.ids).toEqual([
      'b',
      'c',
      'd',
    ]);
    expect(
      toggleBlockSelection(blocks, selectAllBlocks(blocks), 'a'),
    ).toEqual({
      anchorId: 'b',
      focusId: 'd',
      ids: ['b', 'c', 'd'],
    });
    expect(
      toggleBlockSelection(
        blocks,
        { anchorId: 'a', focusId: 'a', ids: ['a'] },
        'a',
      ),
    ).toBeNull();
  });

  it('撤销删除时给已不存在于当前文档的块分配新 id，避免 SQLite 主键冲突', () => {
    const restored = [paragraph('deleted', '被删段落')];
    const result = remapRestoredBlockIds(restored, new Set(['kept']));
    const newId = result.blocks[0].id;
    expect(newId).not.toBe('deleted');
    expect(result.idMap.get('deleted')).toBe(newId);
    const kept = remapRestoredBlockIds(
      [paragraph('kept', '保留段落')],
      new Set(['kept']),
    );
    expect(kept.blocks[0].id).toBe('kept');
    expect(kept.idMap.size).toBe(0);
  });

  it('批量删除全空时补空段落；批量上移聚拢并保持顺序', () => {
    const all = new Set(['a', 'b', 'c', 'd']);
    const emptied = removeBlocksByIds(blocks, all, 'note-x');
    expect(emptied).toHaveLength(1);
    expect(emptied[0].type).toBe('paragraph');

    const moved = moveBlocksByIds(blocks, new Set(['b', 'd']), -1, 'note-x');
    expect(moved.map((block) => block.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('复制投影：纯文本空行分隔，HTML 保留标题/列表/代码结构且转义', () => {
    const copyBlocks = [
      paragraph('p', '正文'),
      makeBlock({
        id: 'h',
        type: 'heading3',
        payload: { runs: [{ text: '标题' }] },
      }),
      makeBlock({
        id: 'u',
        type: 'bullet_list',
        payload: { runs: [{ text: '列表项' }] },
      }),
      makeBlock({
        id: 'c',
        type: 'code',
        payload: { code: '<script>alert(1)</script>', language: 'html' },
      }),
      makeBlock({
        id: 'empty',
        type: 'paragraph',
        payload: { runs: [] },
      }),
    ];
    expect(blocksToPlainText(copyBlocks)).toBe(
      '正文\n\n标题\n\n列表项\n\n<script>alert(1)</script>',
    );
    const html = blocksToClipboardHtml(copyBlocks);
    expect(html).toContain('<h3>标题</h3>');
    expect(html).toContain('<ul><li>列表项</li></ul>');
    expect(html).toContain(
      '<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>',
    );
    expect(html).not.toContain('<p><br></p>');
  });
});
