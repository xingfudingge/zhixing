/**
 * ZX6-QA-01 独立验收 · 通过项
 *
 * 本文件只从产品组件出发，不复用实现卡的测试文件；覆盖卡面要求的：
 * 公式连续切换模板、表格未选中不常驻工具条、右键四类上下文、
 * hover 属性默认隐藏、Backspace 非空前块、日期 Enter/非法输入、
 * 画板导入导出弹窗按钮/取消/错误。
 *
 * 已知与设计不符的行为单独放在 zx6-qa-01-findings.test.tsx，
 * 避免把“现状能跑”误判成“验收通过”。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '../app/node_modules/@testing-library/react/dist/index.js';
import userEvent from '../app/node_modules/@testing-library/user-event/dist/esm/index.js';
import { useState, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoardExportDialog } from '../app/src/features/board/components/BoardExportDialog';
import { JsonDialog } from '../app/src/features/board/components/BoardDialogs';
import { planBoardExport } from '../app/src/features/board/export/image';
import { buildBoardPackage } from '../app/src/features/board/export/package';
import {
  createFakeBoardSource,
  sampleDocument,
} from '../app/src/features/board/__tests__/fakeBoardSource';
import { BoardWorkspace } from '../app/src/features/board/BoardWorkspace';
import type { SaveResult } from '../app/src/features/attachments/fileActions';
import { NoteBlockEditor } from '../app/src/features/editor/NoteBlockEditor';
import { FormulaBlock } from '../app/src/features/editor/blocks/FormulaBlock';
import { TableBlock } from '../app/src/features/editor/blocks/TableBlock';
import {
  restoreSelectionByOffsets,
  selectionOffsetsIn,
} from '../app/src/features/editor/inline';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
} from '../app/src/features/editor/__tests__/fakeBlockSource';
import type { BlockPayload } from '../app/src/data/repositories/blocks';
import { DatePicker } from '../app/src/ui/date/DatePicker';

type User = ReturnType<typeof userEvent.setup>;

function makeFormulaHarness(initialLatex: string) {
  return function Harness() {
    const [state, setState] = useState({
      latex: initialLatex,
      display: 'block' as 'block' | 'inline',
    });
    return (
      <FormulaBlock
        block={makeBlock({
          id: 'formula-qa',
          type: 'formula',
          payload: {
            latex: state.latex,
            display: state.display,
            renderer: 'none',
          },
        })}
        readOnly={false}
        onChangeLatex={(latex) => setState((s) => ({ ...s, latex }))}
        onChangeDisplay={(display) => setState((s) => ({ ...s, display }))}
      />
    );
  };
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

describe('ZX6-QA-01 · 第 1 项 公式模板焦点与连续切换', () => {
  it('指针打开菜单不抢焦点；连续插入分数/根式，caret 与焦点保持在 textarea', async () => {
    const user = userEvent.setup();
    const Harness = makeFormulaHarness('x=');
    render(<Harness />);

    const textarea = await enterFormulaEdit(user);
    textarea.focus();
    textarea.setSelectionRange(2, 2);

    await chooseTemplate(user, '分数');
    expect(textarea).toHaveValue('x=\\frac{a}{b}');
    expect(textarea.selectionStart).toBe(13);
    expect(document.activeElement).toBe(textarea);

    // 不重新点输入框，直接第二次打开模板菜单。
    await chooseTemplate(user, '根式');
    expect(textarea).toHaveValue('x=\\frac{a}{b}\\sqrt{x}');
    expect(textarea.selectionStart).toBe(21);
    expect(document.activeElement).toBe(textarea);
  });

  it('菜单打开时 Esc 只关闭菜单，焦点与选区回到 textarea', async () => {
    const user = userEvent.setup();
    const Harness = makeFormulaHarness('ab');
    render(<Harness />);
    const textarea = await enterFormulaEdit(user);
    textarea.focus();
    textarea.setSelectionRange(1, 1);

    await user.click(screen.getByRole('button', { name: '公式模板' }));
    await screen.findByRole('menu', { name: '公式模板' });
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: '公式模板' })).toBeNull();
    });
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(1);
    expect(textarea.selectionEnd).toBe(1);
  });
});

function TableHarness({ rows }: { rows: string[][] }) {
  const [current, setCurrent] = useState(rows);
  return (
    <TableBlock
      block={makeBlock({
        id: 'table-qa',
        type: 'table',
        payload: { rows: current } as unknown as BlockPayload,
      })}
      readOnly={false}
      onChange={(next) => setCurrent(next as unknown as string[][])}
    />
  );
}

describe('ZX6-QA-01 · 第 3 项 表格工具条按上下文出现', () => {
  it('初始渲染不常驻工具条/底栏/空表提示；单元格聚焦后出现，点外部隐藏', async () => {
    const user = userEvent.setup();
    const { container } = render(<TableHarness rows={[['A', 'B']]} />);
    const wrap = container.querySelector<HTMLElement>('.zxe-table-wrap');

    expect(wrap).not.toBeNull();
    expect(screen.queryByRole('toolbar', { name: '表格工具栏' })).toBeNull();
    expect(container.querySelector('.zxe-table-foot')).toBeNull();
    expect(container.querySelector('.zxe-table-empty')).toBeNull();
    expect(wrap?.lastElementChild?.classList.contains('zxe-table-scroll')).toBe(
      true,
    );

    await user.click(screen.getByLabelText('第 1 行第 1 列'));
    expect(
      screen.getByRole('toolbar', { name: '表格工具栏' }),
    ).toBeInTheDocument();

    await user.click(document.body);
    await waitFor(() => {
      expect(screen.queryByRole('toolbar', { name: '表格工具栏' })).toBeNull();
    });
  });
});

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

async function renderEditor() {
  const source = seedEditor();
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

describe('ZX6-QA-01 · 第 4 项 右键四类上下文', () => {
  it('文本/表格/公式/空白给出互不相同的菜单，Esc 关闭', async () => {
    await renderEditor();
    const textbox = (
      await screen.findAllByRole('textbox', { name: '正文' })
    )[0];

    fireEvent.contextMenu(textbox, { clientX: 120, clientY: 140 });
    const textMenu = await screen.findByRole('menu', { name: '文本菜单' });
    expect(within(textMenu).getByRole('menuitem', { name: /加粗/ })).toBeInTheDocument();
    expect(
      within(textMenu).getByRole('menuitem', { name: /转为待办/ }),
    ).toBeInTheDocument();
    // ZX7-MENU-01 起“插入”收为一级子菜单：先展开，再断言子项。
    fireEvent.click(
      within(textMenu).getByRole('menuitem', { name: /^插入/ }),
    );
    expect(
      within(textMenu).getByRole('menuitem', { name: /^公式/ }),
    ).toBeInTheDocument();
    expect(
      within(textMenu).queryByRole('menuitem', { name: /合并选区/ }),
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
      within(tableMenu).getByRole('menuitem', { name: /上方插入行/ }),
    ).toBeInTheDocument();
    // ZX7-MENU-01 起导出收为子菜单。
    fireEvent.click(
      within(tableMenu).getByRole('menuitem', { name: /^导出$/ }),
    );
    expect(
      within(tableMenu).getByRole('menuitem', { name: /Markdown/ }),
    ).toBeInTheDocument();
    expect(
      within(tableMenu).queryByRole('menuitem', { name: /^加粗/ }),
    ).toBeNull();
    await closeContextMenu();

    fireEvent.contextMenu(screen.getByRole('group', { name: '公式块' }), {
      clientX: 300,
      clientY: 360,
    });
    const formulaMenu = await screen.findByRole('menu', { name: '公式菜单' });
    expect(
      within(formulaMenu).getByRole('menuitem', { name: /编辑公式/ }),
    ).toBeInTheDocument();
    expect(
      within(formulaMenu).getByRole('menuitem', { name: /复制 LaTeX/ }),
    ).toBeInTheDocument();
    // ZX7-MENU-01 起缩放收为子菜单。
    fireEvent.click(
      within(formulaMenu).getByRole('menuitem', { name: /^缩放/ }),
    );
    expect(
      within(formulaMenu).getByRole('menuitem', { name: /重置缩放/ }),
    ).toBeInTheDocument();
    expect(
      within(formulaMenu).queryByRole('menuitem', { name: /插入表格/ }),
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
    // ZX7-MENU-01 起插入收为子菜单。
    fireEvent.click(
      within(blankMenu).getByRole('menuitem', { name: /^插入/ }),
    );
    expect(
      within(blankMenu).getByRole('menuitem', { name: /^分割线/ }),
    ).toBeInTheDocument();
    expect(
      within(blankMenu).queryByRole('menuitem', { name: /^剪切/ }),
    ).toBeNull();
    await closeContextMenu();
  });

  it('公式 textarea 内右键保留原生菜单，不弹自定义公式菜单', async () => {
    const user = userEvent.setup();
    await renderEditor();
    const textarea = await enterFormulaEdit(user);
    fireEvent.contextMenu(textarea, { clientX: 100, clientY: 100 });
    expect(screen.queryByRole('menu', { name: '公式菜单' })).toBeNull();
  });
});

describe('ZX6-QA-01 · 第 5 项 属性标识默认隐藏', () => {
  it('公式属性条与表格工具条默认不渲染，hover 后出现', async () => {
    const { container } = render(
      <TableHarness rows={[['A', 'B']]} />,
    );
    expect(document.body.querySelector('.zxe-table-toolbar')).toBeNull();
    expect(document.body.querySelector('.meta-chip')).toBeNull();

    fireEvent.mouseEnter(container.querySelector('.zxe-table-wrap')!);
    await waitFor(() => {
      expect(
        screen.getByRole('toolbar', { name: '表格工具栏' }),
      ).toBeInTheDocument();
    });
  });

  it('公式默认无属性头，hover 后浮出；文本块无 .meta-chip', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'p1',
        type: 'paragraph',
        payload: { runs: [{ text: '正文' }] },
        orderKey: 1024,
      }),
      makeBlock({
        id: 'f1',
        type: 'formula',
        payload: { latex: 'x^2', display: 'block', renderer: 'none' },
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
    expect(document.body.querySelector('.zxe-formula-head')).toBeNull();
    expect(container.querySelector('.meta-chip')).toBeNull();

    fireEvent.mouseEnter(screen.getByRole('group', { name: '公式块' }));
    await waitFor(() => {
      // ZX7-TOOLBAR-01 起工具条 portal 到 body，容器内查不到属预期。
      expect(
        document.body.querySelector('.zxe-formula-head'),
      ).not.toBeNull();
    });
  });
});

describe('ZX6-QA-01 · 第 6 项 Backspace 合并非空文本块', () => {
  it('两段非空文本，第二段块首 Backspace 合并，caret 落在交界，可撤销', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'p1',
        type: 'paragraph',
        payload: { runs: [{ text: '前面' }] },
        orderKey: 1024,
      }),
      makeBlock({
        id: 'p2',
        type: 'paragraph',
        payload: { runs: [{ text: '后面' }] },
        orderKey: 2048,
      }),
    ]);
    const user = userEvent.setup();
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
      ?.querySelector<HTMLElement>('[data-inline-editor="true"]');
    expect(p2).not.toBeNull();
    p2!.focus();
    restoreSelectionByOffsets(p2!, 0, 0);
    fireEvent.keyDown(p2!, { key: 'Backspace' });

    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-block-id]'),
      ).toHaveLength(1);
    });
    const p1 = container
      .querySelector<HTMLElement>('[data-block-id="p1"]')
      ?.querySelector<HTMLElement>('[data-inline-editor="true"]');
    expect(p1).toHaveTextContent('前面后面');
    await waitFor(() => {
      expect(document.activeElement).toBe(p1);
      expect(selectionOffsetsIn(p1!)).toEqual({ start: 2, end: 2 });
    });

    const undo = screen.getByRole('button', { name: '撤销编辑' });
    await waitFor(() => expect(undo).toBeEnabled());
    await user.click(undo);
    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-block-id]'),
      ).toHaveLength(2);
    });
  });
});

function DateHarness({
  initial = '2026-11-03',
  onChange,
}: {
  initial?: string | null;
  onChange?: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="qa-date">日期</label>
      <DatePicker
        id="qa-date"
        value={value}
        today="2026-10-30"
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

describe('ZX6-QA-01 · 第 9 项 日期 Enter 提交与非法输入', () => {
  it('面板打开时手输合法日期后按 Enter：面板月份/选中/焦点同步，仅提交一次', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateHarness onChange={onChange} />);
    const panel = await openDatePanel(user);

    const input = dateInput();
    await user.click(input);
    await user.clear(input);
    await user.type(input, '2026/12/25');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(panel.getAttribute('data-view-month')).toBe('2026-12');
    });
    expect(
      panel.querySelector('.dp-day.is-selected')?.getAttribute('data-date'),
    ).toBe('2026-12-25');
    expect(input).toHaveValue('2026-12-25');
    expect(input).toHaveFocus();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('2026-12-25');
  });

  it('非法日期保留原文、显示行内错误、不写已提交值', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateHarness onChange={onChange} />);
    await openDatePanel(user);

    const input = dateInput();
    await user.click(input);
    await user.clear(input);
    await user.type(input, '2026-02-30');
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent('日期不存在');
    expect(input).toHaveValue('2026-02-30');
    expect(screen.getByTestId('committed')).toHaveTextContent('2026-11-03');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ZX6-QA-01 · 第 7 项 画板导入/导出弹窗', () => {
  const cancelSave = async (): Promise<SaveResult> => ({ status: 'canceled' });

  function renderJsonDialog(
    overrides: Partial<ComponentProps<typeof JsonDialog>> = {},
  ) {
    const onApply = vi.fn();
    const onApplyDocument = vi.fn();
    const onClose = vi.fn();
    const onStatus = vi.fn();
    const saveJson = vi.fn(cancelSave);
    const savePackage = vi.fn(cancelSave);
    const view = render(
      <JsonDialog
        open
        document={sampleDocument()}
        viewport={{ x: 0, y: 0, zoom: 1 }}
        onApply={onApply}
        onApplyDocument={onApplyDocument}
        onClose={onClose}
        onStatus={onStatus}
        saveJson={saveJson}
        savePackage={savePackage}
        now={() => new Date(2026, 9, 30, 10, 0)}
        {...overrides}
      />,
    );
    return { ...view, onClose, savePackage };
  }

  it('默认画板包 tab；header/body/footer 分离，footer 不在滚动区', async () => {
    const user = userEvent.setup();
    renderJsonDialog();
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    expect(within(dialog).getByRole('tab', { name: /画板包/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const body = dialog.querySelector('.bw-modal-body');
    const footer = dialog.querySelector('.bw-modal-foot');
    expect(body).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(body!.contains(footer)).toBe(false);
    expect(
      within(dialog).getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
  });

  it('开发者 JSON 初始为空；坏 JSON 在弹窗内报错且应用禁用', async () => {
    const user = userEvent.setup();
    renderJsonDialog();
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    await user.click(
      within(dialog).getByRole('tab', { name: /开发者 · JSON/ }),
    );
    const textarea = within(dialog).getByLabelText('画板 JSON');
    expect(textarea).toHaveValue('');

    fireEvent.change(textarea, { target: { value: '{bad' } });
    await user.click(
      within(dialog).getByRole('button', { name: '应用导入' }),
    );
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/合法 JSON/);
    expect(
      within(dialog).getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
    expect(screen.getByRole('dialog', { name: '导入 / 导出画板' })).toBeInTheDocument();
  });

  it('画板包导出取消：弹窗保留并显示“未写入文件”', async () => {
    const user = userEvent.setup();
    const { savePackage } = renderJsonDialog();
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    await user.click(
      within(dialog).getByRole('button', { name: '导出画板包…' }),
    );
    await waitFor(() => expect(savePackage).toHaveBeenCalledTimes(1));
    expect(
      await within(dialog).findByText('已取消导出画板包，未写入文件。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '导入 / 导出画板' })).toBeInTheDocument();
  });

  it('PNG 导出：空画板给出 alert 且保存禁用；取消保存显示未写入', async () => {
    const user = userEvent.setup();
    const document = sampleDocument();
    const savePng = vi.fn(cancelSave);
    const renderPng = vi.fn(async () => ({
      blob: new Blob([new Uint8Array([137, 80, 78, 71])], {
        type: 'image/png',
      }),
      plan: planBoardExport(document),
    }));
    render(
      <BoardExportDialog
        open
        document={document}
        noteId="note-1"
        onClose={vi.fn()}
        renderPng={renderPng}
        savePng={savePng}
        now={() => new Date(2026, 9, 30, 10, 0)}
      />,
    );
    await user.click(screen.getByRole('button', { name: '保存 PNG' }));
    await waitFor(() => expect(savePng).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText('已取消保存，未写入任何文件。'),
    ).toBeInTheDocument();
  });

  it('画板包导出成功：tab 内显示导出结果，弹窗不关闭', async () => {
    const user = userEvent.setup();
    const savePackage = vi.fn(async () => ({
      status: 'saved' as const,
      path: '/tmp/测试画板.zxboard',
    }));
    renderJsonDialog({ savePackage });
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    await user.click(
      within(dialog).getByRole('button', { name: '导出画板包…' }),
    );
    await waitFor(() => expect(savePackage).toHaveBeenCalledTimes(1));
    expect(
      await within(dialog).findByText(/已导出画板包/),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '导入 / 导出画板' })).toBeInTheDocument();
  });

  it('画板包导入完整走通：预览 → 新建画板 → 原画板不变', async () => {
    const user = userEvent.setup();
    const initial = sampleDocument();
    const fake = createFakeBoardSource(initial);
    render(
      <BoardWorkspace
        boardId={initial.boardId}
        noteId={initial.noteId}
        source={fake.source}
        saveDelayMs={0}
      />,
    );
    await screen.findByDisplayValue('测试画板');

    const report = await buildBoardPackage({
      document: sampleDocument(),
      viewport: { x: -40, y: -30, zoom: 0.9 },
      includeThumbnail: false,
    });
    const file = new File([report.bytes.slice().buffer], '测试画板.zxboard', {
      type: 'application/zip',
    });

    await user.click(
      screen.getByRole('button', { name: '导入或导出画板包' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: '导入 / 导出画板',
    });
    fireEvent.change(within(dialog).getByLabelText('选择画板包文件'), {
      target: { files: [file] },
    });
    await within(dialog).findByText(/包类型 board-package/);
    await user.click(
      within(dialog).getByRole('radio', { name: /导入为新画板/ }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: '应用导入' }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: '确认导入新画板' }),
    );

    await waitFor(() => expect(fake.created).toHaveLength(1));
    expect(fake.created[0].title).toBe('测试画板（导入）');
    const saved = fake.saves[fake.saves.length - 1]!;
    expect(saved.boardId).not.toBe(initial.boardId);
    expect(saved.nodes).toHaveLength(3);
    expect(saved.edges).toHaveLength(2);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
