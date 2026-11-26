import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { NoteBlockEditor } from '../NoteBlockEditor';
import {
  HISTORY_LIMIT,
  caretBeforeTextChange,
  pushHistoryEntry,
  type BlockHistoryEntry,
} from '../model';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
  type FakeBlockSource,
} from './fakeBlockSource';

function renderEditor(source: FakeBlockSource) {
  return render(
    <NoteBlockEditor
      noteId={FAKE_NOTE_ID}
      source={source}
      saveDelayMs={0}
    />,
  );
}

/** 内容可编辑区里同步输入，确保所有字符落在同一个 400ms 合并窗口。 */
function typeRuns(element: HTMLElement, text: string) {
  element.focus();
  for (let index = 1; index <= text.length; index += 1) {
    element.textContent = text.slice(0, index);
    fireEvent.input(element);
  }
}

function historyButtons() {
  return {
    undo: screen.getByRole('button', { name: '撤销编辑' }),
    redo: screen.getByRole('button', { name: '重做编辑' }),
  };
}

const WAIT = { timeout: 5000 } as const;

/**
 * 等载入与 React 被动 effect 都稳定后再开始输入。
 *
 * `findBy*`/`waitFor` 由 RTL 的 asyncWrapper 驱动，会暂时关闭 act 环境，
 * 可能在编辑器打开历史的 useEffect 之前就返回。此时立刻 input，第一次按键
 * 不会进撤销栈，⌘Z 只能回到第一个字符（ZX10-HIST-01 的 '知' / '按'）。
 * 因此先等可观察的「已保存到本机」，再用 act 显式排空被动 effect，最后确认
 * 撤销/重做都没有历史可走。
 */
async function waitForEditorReady() {
  await waitFor(
    () => {
      expect(screen.getByText('已保存到本机')).toBeInTheDocument();
    },
    WAIT,
  );
  await act(async () => {});
  expect(historyButtons().undo).toBeDisabled();
  expect(historyButtons().redo).toBeDisabled();
}

describe('块编辑器 · 撤销/重做（N-23）', () => {
  it('连续输入合并为一步：⌘Z 回到输入前，⇧⌘Z 恢复并保持已保存', async () => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    renderEditor(source);
    const textbox = await screen.findByRole('textbox', { name: '正文' });
    await waitForEditorReady();

    expect(historyButtons().undo).toBeDisabled();
    expect(historyButtons().redo).toBeDisabled();

    typeRuns(textbox, '知行笔记四字');
    expect(textbox.textContent).toBe('知行笔记四字');
    await waitFor(
      () => {
        expect(historyButtons().undo).toBeEnabled();
      },
      WAIT,
    );
    // typeRuns 后保存队列/撤销栈可能仍在收尾：等到可观察的已保存状态再按 ⌘Z。
    await waitFor(
      () => {
        expect(screen.getByText('已保存到本机')).toBeInTheDocument();
      },
      WAIT,
    );

    // 快捷键被应用层接管，返回 false 表示原生 undo 已被阻止。
    let notPrevented = true;
    await act(async () => {
      notPrevented = fireEvent.keyDown(textbox, {
        key: 'z',
        metaKey: true,
      });
    });
    expect(notPrevented).toBe(false);

    await waitFor(
      () => {
        expect(textbox.textContent).toBe('');
      },
      WAIT,
    );
    expect(historyButtons().undo).toBeDisabled();
    expect(historyButtons().redo).toBeEnabled();
    await waitFor(
      () => {
        expect(screen.getByText('已保存到本机')).toBeInTheDocument();
      },
      WAIT,
    );
    await waitFor(
      () => {
        expect(JSON.stringify(source.snapshot())).not.toContain('知行笔记四字');
      },
      WAIT,
    );

    await act(async () => {
      fireEvent.keyDown(textbox, { key: 'z', metaKey: true, shiftKey: true });
    });
    await waitFor(
      () => {
        expect(textbox.textContent).toBe('知行笔记四字');
      },
      WAIT,
    );
    await waitFor(
      () => {
        expect(screen.getByText('已保存到本机')).toBeInTheDocument();
      },
      WAIT,
    );
    await waitFor(
      () => {
        expect(JSON.stringify(source.snapshot())).toContain('知行笔记四字');
      },
      WAIT,
    );
  });

  it('Ctrl+Y 重做；按钮带禁用态并可点击撤销', async () => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    const user = userEvent.setup();
    renderEditor(source);
    const textbox = await screen.findByRole('textbox', { name: '正文' });
    await waitForEditorReady();

    typeRuns(textbox, '按钮');
    await waitFor(
      () => {
        expect(historyButtons().undo).toBeEnabled();
      },
      WAIT,
    );
    await waitFor(
      () => {
        expect(screen.getByText('已保存到本机')).toBeInTheDocument();
      },
      WAIT,
    );
    await user.click(historyButtons().undo);
    await waitFor(
      () => {
        expect(textbox.textContent).toBe('');
      },
      WAIT,
    );

    await act(async () => {
      fireEvent.keyDown(textbox, { key: 'y', ctrlKey: true });
    });
    await waitFor(
      () => {
        expect(textbox.textContent).toBe('按钮');
      },
      WAIT,
    );
  });

  it('插入表格成一步：⌘Z 移除表格，⇧⌘Z 恢复', async () => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    const user = userEvent.setup();
    const { container } = renderEditor(source);
    await screen.findByRole('textbox', { name: '正文' });
    await waitForEditorReady();

    await user.click(screen.getByRole('button', { name: '插入内容' }));
    const menu = await screen.findByRole('menu', { name: '插入块' });
    await user.click(within(menu).getByRole('menuitem', { name: /表格/ }));
    await waitFor(
      () => {
        expect(container.querySelector('table')).not.toBeNull();
      },
      WAIT,
    );
    expect(historyButtons().undo).toBeEnabled();

    const cell = screen.getByLabelText('第 1 行第 1 列');
    await act(async () => {
      fireEvent.keyDown(cell, { key: 'z', metaKey: true });
    });
    await waitFor(
      () => {
        expect(container.querySelector('table')).toBeNull();
      },
      WAIT,
    );
    expect(screen.getByRole('textbox', { name: '正文' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(screen.getByRole('textbox', { name: '正文' }), {
        key: 'z',
        metaKey: true,
        shiftKey: true,
      });
    });
    await waitFor(
      () => {
        expect(container.querySelector('table')).not.toBeNull();
      },
      WAIT,
    );
  });

  it('表格不同单元格各自成步，单元格内连续输入合并', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'tbody',
        type: 'table',
        payload: {
          rows: [
            ['', ''],
            ['', ''],
          ],
        },
      }),
    ]);
    renderEditor(source);
    const first = await screen.findByLabelText('第 1 行第 1 列');
    const second = screen.getByLabelText('第 1 行第 2 列');
    await waitForEditorReady();

    fireEvent.change(first, { target: { value: '甲' } });
    fireEvent.change(first, { target: { value: '甲乙' } });
    fireEvent.change(second, { target: { value: '丙' } });
    expect(first).toHaveValue('甲乙');
    expect(second).toHaveValue('丙');

    await act(async () => {
      fireEvent.keyDown(second, { key: 'z', metaKey: true });
    });
    await waitFor(
      () => {
        expect(screen.getByLabelText('第 1 行第 2 列')).toHaveValue('');
        expect(screen.getByLabelText('第 1 行第 1 列')).toHaveValue('甲乙');
      },
      WAIT,
    );

    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText('第 1 行第 1 列'), {
        key: 'z',
        metaKey: true,
      });
    });
    await waitFor(
      () => {
        expect(screen.getByLabelText('第 1 行第 1 列')).toHaveValue('');
      },
      WAIT,
    );
  });

  it('勾选待办可撤销/重做', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'todo-1',
        type: 'todo',
        payload: { runs: [{ text: '写验收' }], checked: false },
      }),
    ]);
    const user = userEvent.setup();
    renderEditor(source);
    const checkbox = await screen.findByRole('checkbox');
    await waitForEditorReady();
    expect(checkbox).toHaveAttribute('aria-checked', 'false');

    await user.click(checkbox);
    expect(checkbox).toHaveAttribute('aria-checked', 'true');

    await act(async () => {
      fireEvent.keyDown(screen.getByRole('textbox', { name: '待办内容' }), {
        key: 'z',
        metaKey: true,
      });
    });
    await waitFor(
      () => {
        expect(screen.getByRole('checkbox')).toHaveAttribute(
          'aria-checked',
          'false',
        );
      },
      WAIT,
    );
    await waitFor(
      () => {
        expect(source.snapshot()[0].payload.checked).toBe(false);
      },
      WAIT,
    );
  });

  it('只读模式不记录历史，按钮禁用且不拦截原生行为', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        payload: { runs: [{ text: '只读正文' }] },
      }),
    ]);
    render(
      <NoteBlockEditor
        noteId={FAKE_NOTE_ID}
        source={source}
        saveDelayMs={0}
        initialReadOnly
      />,
    );
    const textbox = await screen.findByRole('textbox', { name: '正文' });
    expect(historyButtons().undo).toBeDisabled();
    expect(historyButtons().redo).toBeDisabled();

    const notPrevented = fireEvent.keyDown(textbox, {
      key: 'z',
      metaKey: true,
    });
    expect(notPrevented).toBe(true);
    expect(textbox.textContent).toBe('只读正文');
  });

  it('切换笔记清空历史，不跨笔记共享', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'a1',
        noteId: 'note-a',
        type: 'paragraph',
        payload: { runs: [{ text: '甲笔记' }] },
      }),
      makeBlock({
        id: 'b1',
        noteId: 'note-b',
        type: 'paragraph',
        payload: { runs: [{ text: '乙笔记' }] },
      }),
    ]);
    const view = render(
      <NoteBlockEditor noteId="note-a" source={source} saveDelayMs={0} />,
    );
    const first = await screen.findByRole('textbox', { name: '正文' });
    await waitForEditorReady();
    first.textContent = '甲笔记改';
    fireEvent.input(first);
    await waitFor(
      () => {
        expect(historyButtons().undo).toBeEnabled();
      },
      WAIT,
    );

    view.rerender(
      <NoteBlockEditor noteId="note-b" source={source} saveDelayMs={0} />,
    );
    await waitFor(
      () => {
        expect(screen.getByRole('textbox', { name: '正文' })).toHaveTextContent(
          '乙笔记',
        );
      },
      WAIT,
    );
    await waitFor(
      () => {
        expect(historyButtons().undo).toBeDisabled();
        expect(historyButtons().redo).toBeDisabled();
      },
      WAIT,
    );
  });

  it('历史上限 100 步，超出后丢弃最早一步', () => {
    const entries: BlockHistoryEntry[] = [];
    for (let index = 0; index <= HISTORY_LIMIT; index += 1) {
      entries.push({
        blocks: [
          makeBlock({
            id: `b-${index}`,
            type: 'paragraph',
            payload: { runs: [] },
          }),
        ],
        activeBlockId: `b-${index}`,
        caret: null,
      });
    }
    const kept = entries.reduce<BlockHistoryEntry[]>(
      (stack, entry) => pushHistoryEntry(stack, entry),
      [],
    );
    expect(kept).toHaveLength(HISTORY_LIMIT);
    expect(kept[0].activeBlockId).toBe('b-1');
    expect(kept[kept.length - 1].activeBlockId).toBe(`b-${HISTORY_LIMIT}`);
  });

  it('文本撤销光标按长度差回推', () => {
    const caret = caretBeforeTextChange(
      { blockId: 'b1', start: 3, end: 3 },
      'b1',
      [{ text: 'ab' }],
      [{ text: 'abc' }],
    );
    expect(caret).toEqual({ blockId: 'b1', start: 2, end: 2 });
  });
});
