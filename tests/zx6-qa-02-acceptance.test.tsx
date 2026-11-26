/**
 * ZX6-QA-02 独立复验 · 9 项用户验收的补充证据
 *
 * 与实现卡测试隔离：本文件只从产品组件出发，按 ZX6-DESIGN-01/02 的
 * 验收口径重新断言，不复用实现者用例。`zx6-qa-01-findings.test.tsx`
 * 的 12 条缺陷回归仍单独运行；这里补的是 9 项清单的边界与交互证据：
 * 公式选区替换、表格无选区禁用/有选区生效、代码/公式/块序号默认隐藏、
 * 原子块 Backspace 后 Delete 语义、共享 Modal、JSON 入口、日期双向联动、
 * 快速连点与农历去重。
 *
 * 报告：outputs/验收报告-ZX6-QA-02-2026-10-30.md
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '../app/node_modules/@testing-library/react/dist/index.js';
import userEvent from '../app/node_modules/@testing-library/user-event/dist/esm/index.js';
import { MemoryRouter, Route, Routes } from '../app/node_modules/react-router-dom/dist/index.mjs';
import { useState } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { BoardExportDialog } from '../app/src/features/board/components/BoardExportDialog';
import { planBoardExport } from '../app/src/features/board/export/image';
import {
  createFakeBoardSource,
  sampleDocument,
} from '../app/src/features/board/__tests__/fakeBoardSource';
import { BoardWorkspace } from '../app/src/features/board/BoardWorkspace';
import { createEmptyDocument } from '../app/src/features/board/model';
import { CountdownDialog } from '../app/src/features/countdowns/CountdownDialog';
import { DataBackupPanel } from '../app/src/features/export/DataBackupPanel';
import { createMemoryDownloader } from '../app/src/features/export/download';
import {
  makeDataset,
  makeMemorySource,
  makePayload,
} from '../app/src/features/export/__tests__/testFixtures';
import { createMemoryRestoreTarget } from '../app/src/features/import/__tests__/memoryTarget';
import { KnowledgePage } from '../app/src/features/knowledge/KnowledgePage';
import {
  createFakeNoteSource,
  makeNote,
} from '../app/src/features/knowledge/__tests__/fakeNoteSource';
import { NoteBlockEditor } from '../app/src/features/editor/NoteBlockEditor';
import { FormulaBlock } from '../app/src/features/editor/blocks/FormulaBlock';
import { TableBlock } from '../app/src/features/editor/blocks/TableBlock';
import { blockTableModel } from '../app/src/features/editor/types';
import { restoreSelectionByOffsets } from '../app/src/features/editor/inline';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
} from '../app/src/features/editor/__tests__/fakeBlockSource';
import { createFakeNoteTodoSource } from '../app/src/features/editor/todos/__tests__/fakeNoteTodoSource';
import {
  createFakeTodoTaskSource,
  makeFakeList,
} from '../app/src/features/editor/todos/__tests__/fakeTodoTaskSource';
import { DatePicker } from '../app/src/ui/date/DatePicker';

const ROOT = path.resolve(__dirname, '..');

beforeAll(() => {
  // jsdom 没有 Canvas；画板只验证入口与 DOM，不验证绘制。
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterAll(() => {
  vi.restoreAllMocks();
});

type User = ReturnType<typeof userEvent.setup>;

// ---------------------------------------------------------------------------
// 第 1 项 · 公式模板：焦点、连续插入、选区替换
// ---------------------------------------------------------------------------

function FormulaHarness({ initial }: { initial: string }) {
  const [state, setState] = useState({
    latex: initial,
    display: 'block' as 'block' | 'inline',
  });
  return (
    <FormulaBlock
      block={makeBlock({
        id: 'formula-qa2',
        type: 'formula',
        payload: { latex: state.latex, display: state.display, renderer: 'none' },
      })}
      readOnly={false}
      onChangeLatex={(latex) => setState((s) => ({ ...s, latex }))}
      onChangeDisplay={(display) => setState((s) => ({ ...s, display }))}
    />
  );
}

async function enterFormulaEdit(user: User) {
  const group = screen.getByRole('group', { name: '公式块' });
  fireEvent.mouseEnter(group);
  await user.click(screen.getByRole('button', { name: '编辑公式' }));
  return screen.getByLabelText('LaTeX 源') as HTMLTextAreaElement;
}

async function chooseTemplate(user: User, label: string) {
  await user.click(screen.getByRole('button', { name: '公式模板' }));
  const menu = await screen.findByRole('menu', { name: '公式模板' });
  await user.click(within(menu).getByRole('menuitem', { name: label }));
}

describe('第 1 项 · 公式模板', () => {
  it('已选中的文本被模板替换，焦点与 caret 仍留在 textarea', async () => {
    const user = userEvent.setup();
    render(<FormulaHarness initial="abcd" />);
    const textarea = await enterFormulaEdit(user);
    textarea.focus();
    textarea.setSelectionRange(1, 3); // 选中 "bc"

    await chooseTemplate(user, '分数');

    expect(textarea.value).toBe('a\\frac{a}{b}d');
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(12);
    expect(textarea.selectionStart).toBe(textarea.selectionEnd);
  });

  it('连续两次切换模板不丢焦点，第二次基于第一次的结果插入', async () => {
    const user = userEvent.setup();
    render(<FormulaHarness initial="x=" />);
    const textarea = await enterFormulaEdit(user);
    textarea.focus();
    textarea.setSelectionRange(2, 2);

    await chooseTemplate(user, '分数');
    await chooseTemplate(user, '根式');

    expect(textarea.value).toBe('x=\\frac{a}{b}\\sqrt{x}');
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// 第 3 项 · 表格上下文工具条（含无选区禁用）
// ---------------------------------------------------------------------------

function TableHarness({ rows }: { rows: string[][] }) {
  const [current, setCurrent] = useState(rows);
  const model = blockTableModel(
    makeBlock({
      id: 'table-qa2',
      type: 'table',
      payload: { rows: current } as never,
    }),
  ).model;
  const aligns = model.rows
    .map((row) => row.map((cell) => cell.align).join(','))
    .join('|');
  return (
    <>
      <TableBlock
        block={makeBlock({
          id: 'table-qa2',
          type: 'table',
          payload: { rows: current } as never,
        })}
        readOnly={false}
        onChange={(next) => setCurrent(next as unknown as string[][])}
      />
      <output data-testid="aligns">{aligns}</output>
    </>
  );
}

describe('第 3 项 · 表格工具条', () => {
  it('默认不常驻；hover 无选区时对齐禁用且说明原因；选中后可用并只改选区', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TableHarness
        rows={[
          ['A', 'B'],
          ['C', 'D'],
        ]}
      />,
    );
    const wrap = container.querySelector<HTMLElement>('.zxe-table-wrap')!;
    expect(screen.queryByRole('toolbar', { name: '表格工具栏' })).toBeNull();
    expect(container.querySelector('.zxe-table-foot')).toBeNull();
    expect(container.querySelector('.zxe-table-empty')).toBeNull();

    fireEvent.mouseEnter(wrap);
    const toolbar = await screen.findByRole('toolbar', { name: '表格工具栏' });
    const alignLeft = within(toolbar).getByRole('button', { name: '左对齐' });
    expect(alignLeft).toBeDisabled();
    expect(alignLeft).toHaveAttribute('title', '请先选择单元格再设置对齐');

    await user.click(screen.getByLabelText('第 1 行第 1 列'));
    await waitFor(() => {
      expect(
        within(screen.getByRole('toolbar', { name: '表格工具栏' })).getByRole(
          'button',
          { name: '左对齐' },
        ),
      ).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: '中对齐' }));

    expect(screen.getByTestId('aligns')).toHaveTextContent(
      'center,left|left,left',
    );
    // 表格下方仍不应出现状态/键位行。
    expect(container.querySelector('.zxe-table-foot')).toBeNull();
  });

  it('快速连点单元格 12 次不出现重复工具条或异常', async () => {
    render(<TableHarness rows={[['A', 'B']]} />);
    const cell = screen.getByLabelText('第 1 行第 1 列');
    // ZX7-TOOLBAR-01：工具条只在单元格聚焦 / hover / 菜单打开时出现；
    // 先聚焦，再快速连点验证不会重复挂载。
    cell.focus();
    for (let index = 0; index < 12; index += 1) {
      fireEvent.mouseDown(cell);
      fireEvent.mouseUp(cell);
      fireEvent.click(cell);
    }
    await waitFor(() =>
      expect(
        // ZX7-TOOLBAR-01：工具条 portal 到 body，不再留在容器内。
        document.body.querySelectorAll('.zxe-table-toolbar'),
      ).toHaveLength(1),
    );
  });

  it('点击表格外隐藏工具条', async () => {
    const user = userEvent.setup();
    render(<TableHarness rows={[['A', 'B']]} />);
    await user.click(screen.getByLabelText('第 1 行第 1 列'));
    expect(
      screen.getByRole('toolbar', { name: '表格工具栏' }),
    ).toBeInTheDocument();
    await user.click(document.body);
    await waitFor(() =>
      expect(
        document.body.querySelector('.zxe-table-toolbar'),
      ).toBeNull(),
    );
  });
});

// ---------------------------------------------------------------------------
// 第 4 项 · 四类右键菜单
// ---------------------------------------------------------------------------

function seedEditor() {
  return createFakeBlockSource([
    makeBlock({
      id: 'text-1',
      type: 'paragraph',
      payload: { runs: [{ text: '右键这句话试试' }] },
      orderKey: 1024,
    }),
    makeBlock({
      id: 'table-1',
      type: 'table',
      payload: {
        header: false,
        rows: [
          ['A', 'B'],
          ['C', 'D'],
        ],
      },
      orderKey: 2048,
    }),
    makeBlock({
      id: 'formula-1',
      type: 'formula',
      payload: { latex: 'x^2', display: 'block', renderer: 'none' },
      orderKey: 3072,
    }),
  ]);
}

async function renderEditor(source = seedEditor()) {
  const view = render(
    <NoteBlockEditor
      noteId={FAKE_NOTE_ID}
      source={source}
      saveDelayMs={0}
    />,
  );
  await screen.findByLabelText('笔记正文');
  return view;
}

async function closeContextMenu() {
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
}

describe('第 4 项 · 右键菜单', () => {
  it('文本/表格/公式/空白四套菜单互不相同；Esc 关闭并把焦点还给文本', async () => {
    await renderEditor();
    const textbox = (await screen.findAllByRole('textbox', { name: '正文' }))[0];

    fireEvent.contextMenu(textbox, { clientX: 120, clientY: 140 });
    const textMenu = await screen.findByRole('menu', { name: '文本菜单' });
    expect(
      within(textMenu).getByRole('menuitem', { name: /转为待办/ }),
    ).toBeInTheDocument();
    expect(
      within(textMenu).queryByRole('menuitem', { name: /上方插入行/ }),
    ).toBeNull();
    await closeContextMenu();
    await waitFor(() => expect(document.activeElement).toBe(textbox));

    fireEvent.contextMenu(screen.getByLabelText('第 1 行第 1 列'), {
      clientX: 200,
      clientY: 240,
    });
    const tableMenu = await screen.findByRole('menu', { name: '表格菜单' });
    expect(
      within(tableMenu).getByRole('menuitem', { name: /合并选区/ }),
    ).toBeInTheDocument();
    expect(
      within(tableMenu).queryByRole('menuitem', { name: /转为待办/ }),
    ).toBeNull();
    await closeContextMenu();

    fireEvent.contextMenu(screen.getByRole('group', { name: '公式块' }), {
      clientX: 300,
      clientY: 360,
    });
    const formulaMenu = await screen.findByRole('menu', { name: '公式菜单' });
    expect(
      within(formulaMenu).getByRole('menuitem', { name: /复制 LaTeX/ }),
    ).toBeInTheDocument();
    expect(
      within(formulaMenu).queryByRole('menuitem', { name: /上方插入行/ }),
    ).toBeNull();
    await closeContextMenu();

    fireEvent.contextMenu(screen.getByLabelText('笔记正文'), {
      clientX: 60,
      clientY: 60,
    });
    const blankMenu = await screen.findByRole('menu', { name: '空白菜单' });
    expect(
      within(blankMenu).getByRole('menuitem', { name: /新建段落/ }),
    ).toBeInTheDocument();
    expect(
      within(blankMenu).queryByRole('menuitem', { name: /转为待办/ }),
    ).toBeNull();
    await closeContextMenu();
  });

  it('公式编辑中的 textarea 保留原生菜单', async () => {
    const user = userEvent.setup();
    await renderEditor();
    const textarea = await enterFormulaEdit(user);
    fireEvent.contextMenu(textarea, { clientX: 100, clientY: 100 });
    expect(screen.queryByRole('menu', { name: '公式菜单' })).toBeNull();
  });

  it('右键菜单打开时表格工具条隐藏，关闭后选区仍在则工具条恢复', async () => {
    const user = userEvent.setup();
    await renderEditor();
    const cell = screen.getByLabelText('第 1 行第 1 列');
    await user.click(cell);
    await waitFor(() =>
      expect(
        document.body.querySelector('.zxe-table-toolbar'),
      ).not.toBeNull(),
    );

    fireEvent.contextMenu(cell, { clientX: 200, clientY: 240 });
    await screen.findByRole('menu', { name: '表格菜单' });
    expect(document.body.querySelector('.zxe-table-toolbar')).toBeNull();

    await closeContextMenu();
    await waitFor(() =>
      expect(
        document.body.querySelector('.zxe-table-toolbar'),
      ).not.toBeNull(),
    );
  });
});

// ---------------------------------------------------------------------------
// 第 5 项 · 属性标识默认隐藏
// ---------------------------------------------------------------------------

describe('第 5 项 · 属性标识', () => {
  it('代码属性头默认不渲染；hover 与键盘焦点才浮出，移开隐藏', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'code1',
        type: 'code',
        payload: { code: 'const a = 1;', language: 'ts' },
        orderKey: 1024,
      }),
    ]);
    const { container } = render(
      <NoteBlockEditor noteId={FAKE_NOTE_ID} source={source} saveDelayMs={0} />,
    );
    await screen.findByLabelText('笔记正文');
    const code = screen.getByRole('group', { name: '代码块' });
    expect(container.querySelector('.zxe-code-head')).toBeNull();
    expect(code.getAttribute('data-head-visible')).toBe('false');

    fireEvent.mouseEnter(code);
    await waitFor(() =>
      expect(container.querySelector('.zxe-code-head')).not.toBeNull(),
    );
    fireEvent.mouseLeave(code);
    await waitFor(() =>
      expect(container.querySelector('.zxe-code-head')).toBeNull(),
    );

    code.focus();
    await waitFor(() =>
      expect(container.querySelector('.zxe-code-head')).not.toBeNull(),
    );
  });

  it('公式属性条默认不渲染，hover 后出现', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'f1',
        type: 'formula',
        payload: { latex: 'x^2', display: 'block', renderer: 'none' },
        orderKey: 1024,
      }),
    ]);
    const { container } = render(
      <NoteBlockEditor noteId={FAKE_NOTE_ID} source={source} saveDelayMs={0} />,
    );
    await screen.findByLabelText('笔记正文');
    expect(document.body.querySelector('.zxe-formula-head')).toBeNull();
    fireEvent.mouseEnter(screen.getByRole('group', { name: '公式块' }));
    await waitFor(() =>
      expect(
        document.body.querySelector('.zxe-formula-head'),
      ).not.toBeNull(),
    );
  });

  it('块序号默认不渲染；hover 当前行才出现，移开消失', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'p1',
        type: 'paragraph',
        payload: { runs: [{ text: '第一段' }] },
        orderKey: 1024,
      }),
      makeBlock({
        id: 'p2',
        type: 'paragraph',
        payload: { runs: [{ text: '第二段' }] },
        orderKey: 2048,
      }),
    ]);
    const { container } = render(
      <NoteBlockEditor noteId={FAKE_NOTE_ID} source={source} saveDelayMs={0} />,
    );
    await screen.findByLabelText('笔记正文');
    expect(container.querySelector('.zxe-row-index')).toBeNull();

    const row = container.querySelector<HTMLElement>('[data-block-id="p1"]')!;
    fireEvent.mouseEnter(row);
    await waitFor(() =>
      expect(container.querySelector('.zxe-row-index')).not.toBeNull(),
    );
    fireEvent.mouseLeave(row);
    await waitFor(() =>
      expect(container.querySelector('.zxe-row-index')).toBeNull(),
    );
  });
});

// ---------------------------------------------------------------------------
// 第 6 项 · 原子块前的 Backspace
// ---------------------------------------------------------------------------

function formulaThenParagraph() {
  return createFakeBlockSource([
    makeBlock({
      id: 'f1',
      type: 'formula',
      payload: { latex: 'x^2', display: 'block', renderer: 'none' },
      orderKey: 1024,
    }),
    makeBlock({
      id: 'p2',
      type: 'paragraph',
      payload: { runs: [{ text: '正文' }] },
      orderKey: 2048,
    }),
  ]);
}

describe('第 6 项 · Backspace 原子块', () => {
  it('块首 Backspace 不删除公式；再按 Backspace 仍不删；Delete 才删除', async () => {
    const { container } = render(
      <NoteBlockEditor
        noteId={FAKE_NOTE_ID}
        source={formulaThenParagraph()}
        saveDelayMs={0}
      />,
    );
    await screen.findByLabelText('笔记正文');
    const p2 = container
      .querySelector<HTMLElement>('[data-block-id="p2"]')
      ?.querySelector<HTMLElement>('[data-inline-editor="true"]')!;
    p2.focus();
    restoreSelectionByOffsets(p2, 0, 0);

    fireEvent.keyDown(p2, { key: 'Backspace' });
    await waitFor(() =>
      expect(screen.getByText(/原子块/)).toBeInTheDocument(),
    );
    expect(container.querySelector('[data-block-id="f1"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-block-id]')).toHaveLength(2);

    // 连按 / 长按 Backspace 不得越过护栏。
    fireEvent.keyDown(document, { key: 'Backspace' });
    fireEvent.keyDown(document, { key: 'Backspace' });
    expect(container.querySelectorAll('[data-block-id]')).toHaveLength(2);

    fireEvent.keyDown(document, { key: 'Delete' });
    await waitFor(() =>
      expect(container.querySelectorAll('[data-block-id]')).toHaveLength(1),
    );
    expect(container.querySelector('[data-block-id="f1"]')).toBeNull();
  });

  it('公式后空段落 Backspace：只删空段落、选中公式、可撤销', async () => {
    const user = userEvent.setup();
    const source = createFakeBlockSource([
      makeBlock({
        id: 'f1',
        type: 'formula',
        payload: { latex: 'x^2', display: 'block', renderer: 'none' },
        orderKey: 1024,
      }),
      makeBlock({
        id: 'p2',
        type: 'paragraph',
        payload: { runs: [] },
        orderKey: 2048,
      }),
    ]);
    const { container } = render(
      <NoteBlockEditor
        noteId={FAKE_NOTE_ID}
        source={source}
        saveDelayMs={0}
      />,
    );
    await screen.findByLabelText('笔记正文');
    const p2 = container
      .querySelector<HTMLElement>('[data-block-id="p2"]')
      ?.querySelector<HTMLElement>('[data-inline-editor="true"]')!;
    p2.focus();
    restoreSelectionByOffsets(p2, 0, 0);
    fireEvent.keyDown(p2, { key: 'Backspace' });

    await waitFor(() =>
      expect(container.querySelectorAll('[data-block-id]')).toHaveLength(1),
    );
    expect(container.querySelector('[data-block-id="f1"]')).not.toBeNull();

    const undo = screen.getByRole('button', { name: '撤销编辑' });
    await waitFor(() => expect(undo).toBeEnabled());
    await user.click(undo);
    await waitFor(() =>
      expect(container.querySelectorAll('[data-block-id]')).toHaveLength(2),
    );
  });
});

// ---------------------------------------------------------------------------
// 第 7 项 · 弹窗：共享 Modal、footer、忙碌全锁
// ---------------------------------------------------------------------------

function renderKnowledgePage() {
  const source = createFakeNoteSource([
    makeNote({
      id: 'note-a',
      title: '产品设计笔记',
      folderId: null,
      body: '<h2>背景</h2><p>正文</p>',
      updatedAt: '2026-10-22T08:00:00.000Z',
    }),
  ]);
  const taskSource = createFakeTodoTaskSource(
    [],
    [makeFakeList({ id: 'inbox', name: '收件箱', isInbox: true, sortOrder: 0 })],
  );
  return render(
    <MemoryRouter initialEntries={['/knowledge']}>
      <Routes>
        <Route
          path="/knowledge"
          element={
            <KnowledgePage
              source={source}
              blockSource={createFakeBlockSource()}
              boardSource={createFakeBoardSource().source}
              noteTodoSource={createFakeNoteTodoSource()}
              taskSource={{
                tasks: taskSource.tasks,
                lists: taskSource.lists,
              }}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('第 7 项 · 弹窗层级与底部操作栏', () => {
  it('知识页导出弹窗走共享 Modal：portal、footer 独立于滚动 body、Esc 关闭', async () => {
    const user = userEvent.setup();
    renderKnowledgePage();
    await user.click(
      await screen.findByRole('button', { name: '更多操作：产品设计笔记' }),
    );
    await user.click(screen.getByRole('menuitem', { name: '导出…' }));

    const dialog = await screen.findByRole('dialog', {
      name: /导出「产品设计笔记」/,
    });
    expect(dialog.closest('.zx-modal-backdrop')).not.toBeNull();
    expect(document.body.contains(dialog.closest('.zx-modal-backdrop'))).toBe(
      true,
    );
    expect(document.querySelector('.kn-modal-backdrop')).toBeNull();
    const body = dialog.querySelector('.zx-modal-body')!;
    const footer = dialog.querySelector('.zx-modal-foot')!;
    expect(footer).not.toBeNull();
    expect(body.contains(footer)).toBe(false);
    expect(
      within(footer).getByRole('button', { name: '继续' }),
    ).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
  });

  it('知识页导入弹窗走共享 Modal，且页面不再有旧 .kn-modal', async () => {
    const user = userEvent.setup();
    renderKnowledgePage();
    const importButtons = await screen.findAllByRole('button', {
      name: '导入笔记',
    });
    await user.click(importButtons[0]!);
    const dialog = await screen.findByRole('dialog', { name: '导入笔记' });
    expect(dialog.closest('.zx-modal-backdrop')).not.toBeNull();
    expect(document.querySelector('.kn-modal-backdrop')).toBeNull();
    expect(fs.readFileSync(
      path.join(ROOT, 'app/src/features/import/NoteImportDialog.tsx'),
      'utf8',
    )).not.toContain('kn-modal-backdrop');
  });

  it('PNG 保存进行中：取消、关闭 X、Esc 与 backdrop 全部失效', async () => {
    const user = userEvent.setup();
    const document_ = sampleDocument();
    const never = new Promise<never>(() => undefined);
    const onClose = vi.fn();
    render(
      <BoardExportDialog
        open
        document={document_}
        noteId="note-1"
        onClose={onClose}
        renderPng={vi.fn(async () => ({
          blob: new Blob([new Uint8Array([137, 80, 78, 71])], {
            type: 'image/png',
          }),
          plan: planBoardExport(document_),
        }))}
        savePng={vi.fn(() => never)}
        now={() => new Date(2026, 9, 30, 10, 0)}
      />,
    );
    await user.click(screen.getByRole('button', { name: '保存 PNG' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '正在导出…' })).toBeDisabled(),
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerDown(document.querySelector('.bw-modal-backdrop')!);
    fireEvent.mouseDown(document.querySelector('.bw-modal-backdrop')!);
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 第 8 项 · JSON 入口与设置分组
// ---------------------------------------------------------------------------

describe('第 8 项 · 导入导出入口', () => {
  it('画板工具栏没有独立「JSON」；空画板只有「导入画板包…」', async () => {
    const empty = createEmptyDocument({
      boardId: 'board-empty-qa2',
      noteId: 'note-1',
      title: '空白画板',
    });
    render(
      <BoardWorkspace
        boardId={empty.boardId}
        noteId={empty.noteId}
        source={createFakeBoardSource(empty).source}
        saveDelayMs={0}
      />,
    );
    await screen.findByText('空白画板');
    expect(screen.queryByRole('button', { name: 'JSON' })).toBeNull();
    expect(screen.queryByRole('button', { name: '恢复 JSON' })).toBeNull();
    expect(
      screen.getByRole('button', { name: /导入画板包/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '导入或导出画板包' }),
    ).toBeInTheDocument();
  });

  it('设置“数据与备份”分为备份与恢复 / 单向导出，且无裸「JSON」按钮', () => {
    const downloads = createMemoryDownloader();
    render(
      <DataBackupPanel
        source={makeMemorySource(makePayload())}
        target={createMemoryRestoreTarget(makeDataset())}
        downloader={downloads.downloader}
      />,
    );
    expect(screen.getByText('备份与恢复')).toBeInTheDocument();
    expect(screen.getByText('单向导出')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'JSON' })).toBeNull();
    expect(
      screen.getByRole('button', { name: /结构化数据（JSON/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '选择备份文件' }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 第 9 项 · 日期双向联动
// ---------------------------------------------------------------------------

function DateHarness({
  initial = '2026-11-03',
  min,
  max,
  onChange,
}: {
  initial?: string | null;
  min?: string;
  max?: string;
  onChange?: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="qa2-date">日期</label>
      <DatePicker
        id="qa2-date"
        value={value}
        today="2026-10-30"
        min={min}
        max={max}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
      <output data-testid="committed">{value ?? 'null'}</output>
    </>
  );
}

function dateInput() {
  return screen.getByLabelText('日期') as HTMLInputElement;
}

async function openDatePanel(user: User) {
  await user.click(screen.getByRole('button', { name: /打开日期选择/ }));
  return screen.findByRole('dialog', { name: '选择日期' });
}

describe('第 9 项 · 日期输入与面板', () => {
  it('输入→面板实时联动且不提交', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateHarness onChange={onChange} />);
    const panel = await openDatePanel(user);
    const input = dateInput();
    await user.clear(input);
    await user.type(input, '2026-12-24');

    await waitFor(() =>
      expect(panel.getAttribute('data-view-month')).toBe('2026-12'),
    );
    expect(
      panel.querySelector('.dp-day.is-selected')?.getAttribute('data-date'),
    ).toBe('2026-12-24');
    expect(screen.getByTestId('committed')).toHaveTextContent('2026-11-03');
    expect(onChange).not.toHaveBeenCalled();
    // 取消语义（Esc 恢复已提交值）另见 zx6-qa-02-findings.test.tsx D13。
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
  });

  it('面板→输入实时回写并标记“待确定”；确定才提交一次', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateHarness onChange={onChange} />);
    const panel = await openDatePanel(user);
    await user.click(screen.getByRole('button', { name: '下个月' }));
    await user.click(
      panel.querySelector<HTMLElement>('[data-date="2026-12-25"]')!,
    );

    expect(dateInput()).toHaveValue('2026-12-25');
    expect(screen.getByTestId('committed')).toHaveTextContent('2026-11-03');
    expect(panel.textContent).toMatch(/待确定/);
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() =>
      expect(screen.getByTestId('committed')).toHaveTextContent('2026-12-25'),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('2026-12-25');
    expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull();
    expect(dateInput()).toHaveFocus();
  });

  it('min 越界：今天禁用并说明范围，明天可用；输入越界给行内错误且不提交', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateHarness min="2026-10-31" max="2026-12-31" onChange={onChange} />,
    );
    await openDatePanel(user);
    const today = screen.getByRole('button', { name: '今天' });
    expect(today).toBeDisabled();
    expect(today).toHaveAttribute(
      'title',
      '今天 2026-10-30：仅可选 2026-10-31 至 2026-12-31',
    );
    expect(screen.getByRole('button', { name: '明天' })).toBeEnabled();

    const input = dateInput();
    await user.clear(input);
    await user.type(input, '2026-10-30');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(/日期需在/);
    expect(screen.getByTestId('committed')).toHaveTextContent('2026-11-03');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('双击日格提交；快速开关面板 10 次不残留弹层', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateHarness onChange={onChange} />);
    const panel = await openDatePanel(user);
    await user.click(screen.getByRole('button', { name: '下个月' }));
    await user.dblClick(
      panel.querySelector<HTMLElement>('[data-date="2026-12-01"]')!,
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('2026-12-01'));

    for (let index = 0; index < 10; index += 1) {
      await user.click(screen.getByRole('button', { name: /打开日期选择/ }));
      await user.click(screen.getByRole('button', { name: '关闭日期选择' }));
    }
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
  });

  it('倒数日农历提示只有一条，日期字段无辅助行', async () => {
    const user = userEvent.setup();
    render(
      <CountdownDialog
        open
        initialDate="2026-10-28"
        onClose={vi.fn()}
        onSubmit={async () => undefined}
      />,
    );
    await user.selectOptions(screen.getByLabelText('历法'), 'lunar');
    expect(document.querySelectorAll('.date-field-help')).toHaveLength(0);
    expect(
      document.querySelectorAll('[data-testid="countdown-lunar-preview"]'),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 测试基础设施自检：不允许用源码字符串替代行为断言（第 10 条只查源码，
// 这里再补一条运行时：知识页 DOM 无旧外壳 class）。
// ---------------------------------------------------------------------------

describe('弹窗迁移的运行时证据', () => {
  it('知识页渲染后文档中不存在 .kn-modal / .kn-modal-backdrop', async () => {
    renderKnowledgePage();
    await screen.findAllByText('产品设计笔记');
    expect(document.querySelector('.kn-modal')).toBeNull();
    expect(document.querySelector('.kn-modal-backdrop')).toBeNull();
  });
});
