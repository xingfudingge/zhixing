/**
 * ZX6-BACKSPACE-01 块首 Backspace：合并 / 删除前块 / 元数据保护 / 撤销重做。
 *
 * 这些用例从真实 `<NoteBlockEditor>` 出发（contenteditable + 文档键盘监听），
 * 不直接调用内部函数，确保用户按 Backspace 的路径与产品一致。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { restoreSelectionByOffsets, selectionOffsetsIn } from '../inline';
import { NoteBlockEditor } from '../NoteBlockEditor';
import {
  createFakeBlockSource,
  FAKE_NOTE_ID,
  makeBlock,
} from './fakeBlockSource';

function ordered<T extends { orderKey: number }>(blocks: T[]): T[] {
  return blocks.map((block, index) => ({
    ...block,
    orderKey: (index + 1) * 1024,
  }));
}

function paragraph(id: string, text: string) {
  return makeBlock({
    id,
    type: 'paragraph',
    payload: { runs: text ? [{ text }] : [] },
  });
}

function renderEditor(
  blocks: NonNullable<Parameters<typeof createFakeBlockSource>[0]>,
  options: { initialReadOnly?: boolean } = {},
) {
  const source = createFakeBlockSource(ordered(blocks));
  const result = render(
    <NoteBlockEditor
      noteId={FAKE_NOTE_ID}
      source={source}
      saveDelayMs={0}
      {...options}
    />,
  );
  return { ...result, source };
}

function blockIds(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-block-id]'),
  ).map((element) => element.dataset.blockId ?? '');
}

function rowTypes(container: HTMLElement): Array<string | undefined> {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-block-id]'),
  ).map((element) => element.dataset.blockType);
}

function inlineTexts(container: HTMLElement): Array<string | null> {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-inline-editor="true"]'),
  ).map((element) => element.textContent);
}

function rowOf(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
}

function inlineOf(container: HTMLElement, id: string): HTMLElement | null {
  return (
    rowOf(container, id)?.querySelector<HTMLElement>(
      '[data-inline-editor="true"]',
    ) ?? null
  );
}

/**
 * 正文渲染出来只代表 loadState=ready；历史开关在 passive effect 里同步，
 * 必须再 flush 一次，否则极快按 Backspace 时这次操作可能没进历史栈。
 */
async function waitForEditorReady() {
  await screen.findByLabelText('笔记正文');
  await act(async () => {
    await Promise.resolve();
  });
}

function caretAtStart(element: HTMLElement) {
  element.focus();
  restoreSelectionByOffsets(element, 0, 0);
}

function pressBackspace(element: HTMLElement) {
  fireEvent.keyDown(element, { key: 'Backspace' });
}

describe('块首 Backspace · 合并与删除', () => {
  it('前一个非空文本块：合并、caret 落在交界，一次撤销/重做恢复', async () => {
    const { container } = renderEditor([
      paragraph('p1', '前面'),
      paragraph('p2', '后面'),
    ]);
    const user = userEvent.setup();
    await waitForEditorReady();

    const p2 = inlineOf(container, 'p2')!;
    expect(p2).not.toBeNull();
    caretAtStart(p2);
    pressBackspace(p2);

    await waitFor(() => {
      expect(blockIds(container)).toEqual(['p1']);
    });
    const p1 = inlineOf(container, 'p1')!;
    expect(p1).toHaveTextContent('前面后面');
    expect(screen.getByText(/已合并到上一块/)).toBeInTheDocument();

    // 合并后焦点回到交界处，继续按 Backspace 是删除字符而不是再次合并。
    await waitFor(() => {
      expect(document.activeElement).toBe(p1);
      expect(selectionOffsetsIn(p1)).toEqual({ start: 2, end: 2 });
    });

    const undo = screen.getByRole('button', { name: '撤销编辑' });
    await waitFor(() => expect(undo).toBeEnabled());
    await user.click(undo);
    await waitFor(() => {
      expect(blockIds(container)).toHaveLength(2);
    });
    // 撤销会给被删除的块分配新的 id（历史栈防主键复活），因此断言顺序、
    // 类型与正文，而不是旧 id。
    expect(rowTypes(container)).toEqual(['paragraph', 'paragraph']);
    expect(inlineTexts(container)).toEqual(['前面', '后面']);

    const redo = screen.getByRole('button', { name: '重做编辑' });
    await waitFor(() => expect(redo).toBeEnabled());
    await user.click(redo);
    await waitFor(() => {
      expect(blockIds(container)).toEqual(['p1']);
    });
    expect(inlineOf(container, 'p1')).toHaveTextContent('前面后面');
  });

  const atomicCases: Array<{
    label: string;
    type: 'table' | 'formula' | 'file' | 'board' | 'code';
    payload: Record<string, unknown>;
  }> = [
    {
      label: '表格',
      type: 'table',
      payload: {
        rows: [
          ['列 1', '列 2'],
          ['单元格', '内容'],
        ],
        header: true,
      },
    },
    {
      label: '公式',
      type: 'formula',
      payload: { latex: 'x^2 + y^2', renderer: 'none' },
    },
    {
      label: '文件',
      type: 'file',
      payload: {
        attachmentId: 'att_1',
        fileName: '季度复盘.pdf',
        byteSize: 1024,
        mime: 'application/pdf',
        status: 'pending',
      },
    },
    {
      label: '画板',
      type: 'board',
      payload: { boardId: '', title: '架构画板' },
    },
    {
      label: '代码',
      type: 'code',
      payload: { code: 'const a = 1;', language: 'ts' },
    },
  ];

  it.each(atomicCases)(
    '跨类型：前一个是$label块时不可合并，选中原子块并提示，不删除',
    async ({ type, payload }) => {
      const { container } = renderEditor([
        makeBlock({
          id: 'atomic1',
          type,
          payload: payload as never,
        }),
        paragraph('p2', '正文'),
      ]);
      await waitForEditorReady();

      const p2 = inlineOf(container, 'p2')!;
      expect(rowOf(container, 'atomic1')?.dataset.blockAtomic).toBe('true');
      caretAtStart(p2);
      pressBackspace(p2);

      await waitFor(() => {
        expect(rowOf(container, 'atomic1')?.dataset.selected).toBe('true');
      });
      // 块结构不变：原子块与当前段落都保留，当前正文不被吞掉。
      expect(blockIds(container)).toEqual(['atomic1', 'p2']);
      expect(rowTypes(container)).toEqual([type, 'paragraph']);
      expect(inlineOf(container, 'p2')).toHaveTextContent('正文');
      expect(
        screen.getByText(/已选中原子块，按 Delete 删除/),
      ).toBeInTheDocument();
      // 选中只是视图状态，不写文档历史，⌘Z 不会产生无意义步骤。
      expect(
        screen.getByRole('button', { name: '撤销编辑' }),
      ).toBeDisabled();
      // 焦点落到原子块整行，Delete / 块菜单可以继续作用于它。
      await waitFor(() => {
        expect(document.activeElement).toBe(rowOf(container, 'atomic1'));
      });
    },
  );

  it('选中原子块后按 Delete 才删除，并可用一步撤销恢复', async () => {
    const { container } = renderEditor([
      makeBlock({
        id: 'f1',
        type: 'formula',
        payload: { latex: 'x^2 + y^2', renderer: 'none' },
      }),
      paragraph('p2', '正文'),
    ]);
    const user = userEvent.setup();
    await waitForEditorReady();

    const p2 = inlineOf(container, 'p2')!;
    caretAtStart(p2);
    pressBackspace(p2);
    await waitFor(() => {
      expect(rowOf(container, 'f1')?.dataset.selected).toBe('true');
    });
    expect(blockIds(container)).toEqual(['f1', 'p2']);

    fireEvent.keyDown(rowOf(container, 'f1')!, { key: 'Delete' });
    await waitFor(() => {
      expect(blockIds(container)).toEqual(['p2']);
    });
    expect(inlineOf(container, 'p2')).toHaveTextContent('正文');
    expect(screen.getByText(/已删除 1 个块/)).toBeInTheDocument();

    const undo = screen.getByRole('button', { name: '撤销编辑' });
    await waitFor(() => expect(undo).toBeEnabled());
    await user.click(undo);
    await waitFor(() => {
      expect(blockIds(container)).toHaveLength(2);
    });
    expect(rowTypes(container)).toEqual(['formula', 'paragraph']);
    expect(inlineOf(container, 'p2')).toHaveTextContent('正文');
  });

  it('原子块前连续 Backspace：只选中不删除，多次 Backspace 也不会连带删块', async () => {
    const { container } = renderEditor([
      makeBlock({
        id: 'f1',
        type: 'formula',
        payload: { latex: 'x^2', renderer: 'none' },
      }),
      makeBlock({
        id: 't1',
        type: 'table',
        payload: {
          rows: [
            ['列 1', '列 2'],
            ['单元格', '内容'],
          ],
          header: true,
        },
      }),
      paragraph('p3', '正文'),
    ]);
    await waitForEditorReady();

    const p3 = inlineOf(container, 'p3')!;
    caretAtStart(p3);
    pressBackspace(p3);
    await waitFor(() => {
      expect(rowOf(container, 't1')?.dataset.selected).toBe('true');
    });
    expect(blockIds(container)).toEqual(['f1', 't1', 'p3']);

    // 选中态下继续按 Backspace（含长按重复）只重复提示，不删除任何块；
    // 否则连续按键会顺着往前把表格、公式一起吃掉。
    pressBackspace(rowOf(container, 't1')!);
    pressBackspace(rowOf(container, 't1')!);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(blockIds(container)).toEqual(['f1', 't1', 'p3']);
    expect(rowOf(container, 't1')?.dataset.selected).toBe('true');
    expect(
      screen.getByText(/表格原子块已选中，按 Delete 删除/),
    ).toBeInTheDocument();

    // Delete 才是明确删除：只删选中的表格，公式与当前段落保留。
    fireEvent.keyDown(rowOf(container, 't1')!, { key: 'Delete' });
    await waitFor(() => {
      expect(blockIds(container)).toEqual(['f1', 'p3']);
    });
    expect(inlineOf(container, 'p3')).toHaveTextContent('正文');
    expect(screen.getByText(/已删除 1 个块/)).toBeInTheDocument();
  });

  it('空块：前一个是文本时删除空块；第一个块按 Backspace 无操作', async () => {
    const first = renderEditor([
      paragraph('p1', '前面'),
      paragraph('p2', ''),
    ]);
    await waitForEditorReady();
    const empty = inlineOf(first.container, 'p2')!;
    caretAtStart(empty);
    pressBackspace(empty);
    await waitFor(() => {
      expect(blockIds(first.container)).toEqual(['p1']);
    });
    expect(inlineOf(first.container, 'p1')).toHaveTextContent('前面');
    first.unmount();

    const second = renderEditor([paragraph('only', '')]);
    await waitForEditorReady();
    const only = inlineOf(second.container, 'only')!;
    caretAtStart(only);
    pressBackspace(only);
    await waitFor(() => {
      expect(screen.getByText(/第一个块前没有可合并的内容/)).toBeInTheDocument();
    });
    expect(blockIds(second.container)).toEqual(['only']);
  });

  it('空块前是原子块：只删空块并选中原子块，不连带删除表格/公式', async () => {
    const { container } = renderEditor([
      makeBlock({
        id: 'f1',
        type: 'formula',
        payload: { latex: 'x^2', renderer: 'none' },
      }),
      paragraph('p2', ''),
    ]);
    const user = userEvent.setup();
    await waitForEditorReady();

    const empty = inlineOf(container, 'p2')!;
    caretAtStart(empty);
    pressBackspace(empty);

    await waitFor(() => {
      expect(blockIds(container)).toEqual(['f1']);
    });
    expect(rowOf(container, 'f1')?.dataset.blockType).toBe('formula');
    expect(rowOf(container, 'f1')?.dataset.selected).toBe('true');
    expect(screen.getByText(/已删除空块/)).toBeInTheDocument();
    expect(screen.getByText(/已选中/)).toBeInTheDocument();

    // 空块删除只占一步历史；撤销恢复空段落，原子块内容不丢。
    const undo = screen.getByRole('button', { name: '撤销编辑' });
    await waitFor(() => expect(undo).toBeEnabled());
    await user.click(undo);
    await waitFor(() => {
      expect(blockIds(container)).toHaveLength(2);
    });
    expect(rowTypes(container)).toEqual(['formula', 'paragraph']);
    expect(rowOf(container, 'f1')?.dataset.blockType).toBe('formula');
  });

  it('连续 Backspace：每次只合并一层，不重复合并也不卡住', async () => {
    const { container } = renderEditor([
      paragraph('p0', 'X'),
      paragraph('p1', 'AB'),
      paragraph('p2', 'CD'),
    ]);
    await waitForEditorReady();

    caretAtStart(inlineOf(container, 'p2')!);
    pressBackspace(inlineOf(container, 'p2')!);
    await waitFor(() => {
      expect(blockIds(container)).toEqual(['p0', 'p1']);
    });
    expect(inlineOf(container, 'p1')).toHaveTextContent('ABCD');

    const merged = inlineOf(container, 'p1')!;
    caretAtStart(merged);
    pressBackspace(merged);
    await waitFor(() => {
      expect(blockIds(container)).toEqual(['p0']);
    });
    expect(inlineOf(container, 'p0')).toHaveTextContent('XABCD');
  });
});

describe('块首 Backspace · 元数据与场景保护', () => {
  it('引用带出处：不合并、不删除，正文与出处都保留', async () => {
    const { container } = renderEditor([
      paragraph('p1', '前面'),
      makeBlock({
        id: 'q1',
        type: 'quote',
        payload: {
          runs: [{ text: '引用正文' }],
          source: '设计文档',
          noteId: '',
          sourceUrl: '',
        },
      }),
    ]);
    await waitForEditorReady();

    const quoteText = inlineOf(container, 'q1')!;
    caretAtStart(quoteText);
    pressBackspace(quoteText);

    await waitFor(() => {
      expect(screen.getByText(/引用含出处/)).toBeInTheDocument();
    });
    expect(blockIds(container)).toEqual(['p1', 'q1']);
    expect(rowOf(container, 'q1')?.dataset.blockType).toBe('quote');
    expect(inlineOf(container, 'q1')).toHaveTextContent('引用正文');
    expect(screen.getByText(/— 设计文档/)).toBeInTheDocument();
  });

  it('已完成待办：不合并，checked 与正文都保留', async () => {
    const { container } = renderEditor([
      paragraph('p1', '前面'),
      makeBlock({
        id: 't1',
        type: 'todo',
        payload: { runs: [{ text: '完成事项' }], checked: true },
      }),
    ]);
    await waitForEditorReady();

    const todoText = inlineOf(container, 't1')!;
    caretAtStart(todoText);
    pressBackspace(todoText);

    await waitFor(() => {
      expect(screen.getByText(/已完成待办不参与合并/)).toBeInTheDocument();
    });
    expect(blockIds(container)).toEqual(['p1', 't1']);
    expect(rowOf(container, 't1')?.dataset.blockType).toBe('todo');
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    expect(inlineOf(container, 't1')).toHaveTextContent('完成事项');
  });

  it('非空列表：第一次转为段落，第二次才合并到上一块', async () => {
    const { container } = renderEditor([
      paragraph('p1', '前面'),
      makeBlock({
        id: 'l1',
        type: 'bullet_list',
        payload: { runs: [{ text: '列表项' }] },
      }),
    ]);
    await waitForEditorReady();

    const listText = inlineOf(container, 'l1')!;
    caretAtStart(listText);
    pressBackspace(listText);

    await waitFor(() => {
      expect(rowOf(container, 'l1')?.dataset.blockType).toBe('paragraph');
    });
    expect(blockIds(container)).toEqual(['p1', 'l1']);
    expect(inlineOf(container, 'l1')).toHaveTextContent('列表项');
    expect(screen.getByText(/列表已转为文本/)).toBeInTheDocument();

    const converted = inlineOf(container, 'l1')!;
    caretAtStart(converted);
    pressBackspace(converted);
    await waitFor(() => {
      expect(blockIds(container)).toEqual(['p1']);
    });
    expect(inlineOf(container, 'p1')).toHaveTextContent('前面列表项');
  });

  it('只读模式：Backspace 不合并、不删除', async () => {
    const { container } = renderEditor(
      [paragraph('p1', '前面'), paragraph('p2', '后面')],
      { initialReadOnly: true },
    );
    await waitForEditorReady();

    const p2 = inlineOf(container, 'p2')!;
    caretAtStart(p2);
    pressBackspace(p2);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(blockIds(container)).toEqual(['p1', 'p2']);
    expect(inlineOf(container, 'p1')).toHaveTextContent('前面');
    expect(inlineOf(container, 'p2')).toHaveTextContent('后面');
  });

  it('只读模式：原子块前的 Backspace 不删除、不选中、不提示', async () => {
    const { container } = renderEditor(
      [
        makeBlock({
          id: 'c1',
          type: 'code',
          payload: { code: 'const a = 1;', language: 'ts' },
        }),
        paragraph('p2', '正文'),
      ],
      { initialReadOnly: true },
    );
    await waitForEditorReady();

    const p2 = inlineOf(container, 'p2')!;
    caretAtStart(p2);
    pressBackspace(p2);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(blockIds(container)).toEqual(['c1', 'p2']);
    expect(rowOf(container, 'c1')?.dataset.selected).toBe('false');
    expect(inlineOf(container, 'p2')).toHaveTextContent('正文');
    expect(
      screen.queryByText(/已选中原子块，按 Delete 删除/),
    ).not.toBeInTheDocument();
  });

  it('中文输入法组合态：Backspace 交给输入法，不触发块合并', async () => {
    const { container } = renderEditor([
      paragraph('p1', '前面'),
      paragraph('p2', '后面'),
    ]);
    await waitForEditorReady();

    const p2 = inlineOf(container, 'p2')!;
    caretAtStart(p2);
    fireEvent.keyDown(p2, { key: 'Backspace', isComposing: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(blockIds(container)).toEqual(['p1', 'p2']);

    // 组合结束后同一次按键仍走正常合并，证明保护只作用于组合态。
    pressBackspace(p2);
    await waitFor(() => {
      expect(blockIds(container)).toEqual(['p1']);
    });
  });

  it('文本内/选区 Backspace 不受块首逻辑影响', async () => {
    const { container } = renderEditor([
      paragraph('p1', '前面'),
      paragraph('p2', '后面'),
    ]);
    await waitForEditorReady();

    const p2 = inlineOf(container, 'p2')!;
    p2.focus();
    restoreSelectionByOffsets(p2, 1, 1);
    pressBackspace(p2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(blockIds(container)).toEqual(['p1', 'p2']);

    restoreSelectionByOffsets(p2, 0, 1);
    pressBackspace(p2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(blockIds(container)).toEqual(['p1', 'p2']);
  });

  it('批量块选择：Backspace 只删除所选块，不叠加单块合并', async () => {
    const { container } = renderEditor([
      paragraph('p1', '一'),
      paragraph('p2', '二'),
      paragraph('p3', '三'),
    ]);
    const user = userEvent.setup();
    await waitForEditorReady();

    fireEvent.keyDown(inlineOf(container, 'p1')!, {
      key: 'a',
      metaKey: true,
    });
    await waitFor(() => {
      expect(
        container.querySelectorAll('.zxe-row.is-block-selected'),
      ).toHaveLength(3);
    });

    // 块选择态下即使焦点被程序化落到文本块首，也不应触发单块合并。
    const p2 = inlineOf(container, 'p2')!;
    caretAtStart(p2);
    pressBackspace(p2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(blockIds(container)).toEqual(['p1', 'p2', 'p3']);

    fireEvent.keyDown(screen.getByLabelText('笔记正文'), {
      key: 'Backspace',
    });
    await waitFor(() => {
      expect(blockIds(container)).toHaveLength(1);
    });
    expect(screen.getByText(/已删除 3 个块/)).toBeInTheDocument();

    const undo = screen.getByRole('button', { name: '撤销编辑' });
    await waitFor(() => expect(undo).toBeEnabled());
    await user.click(undo);
    await waitFor(() => {
      expect(blockIds(container)).toHaveLength(3);
    });
  });
});
