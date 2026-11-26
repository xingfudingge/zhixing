/**
 * ZX7-QA-01 第七轮独立验收。
 *
 * 本文件不复用实现卡的单测断言，只从产品导出函数 / 组件出发，
 * 重新验证四项：
 *   1. 日期弹层碰撞、翻转、限高、390 sheet、滚动关闭、连续点击；
 *   2. 表格 / 公式工具条跟随锚点、首末行列、390 夹取、键盘与失焦；
 *   3. 菜单键盘/子菜单/Escape/焦点归还；i18n 覆盖与跨区域命名；
 *   4. 空数据与控制台零报错。
 *
 * 运行：bash tests/run-acceptance.sh zx7-qa-01-independent
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
import { describe, expect, it, vi } from 'vitest';

import { DatePicker, computeDatePopoverLayout } from '../app/src/ui/date/DatePicker';
import {
  isAnchorVisible,
  placeToolbar,
} from '../app/src/features/editor/toolbarPlacement';
import { TableBlock } from '../app/src/features/editor/blocks/TableBlock';
import { FormulaBlock } from '../app/src/features/editor/blocks/FormulaBlock';
import { ContextMenu } from '../app/src/features/knowledge/contextMenu';
import { KnowledgePage } from '../app/src/features/knowledge/KnowledgePage';
import {
  createFakeNoteSource,
  makeNote,
} from '../app/src/features/knowledge/__tests__/fakeNoteSource';
import {
  createFakeBlockSource,
  makeBlock,
} from '../app/src/features/editor/__tests__/fakeBlockSource';
import { createFakeNoteTodoSource } from '../app/src/features/editor/todos/__tests__/fakeNoteTodoSource';
import {
  createFakeTodoTaskSource,
  makeFakeList,
} from '../app/src/features/editor/todos/__tests__/fakeTodoTaskSource';
import { createFakeBoardSource } from '../app/src/features/board/__tests__/fakeBoardSource';
import {
  menuCatalog,
  t,
  type MenuKey,
} from '../app/src/i18n/menu';

const VIEWPORT = {
  left: 0,
  top: 0,
  right: 1280,
  bottom: 900,
  width: 1280,
  height: 900,
};

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

function expectInside(layer: { left: number; top: number }, width: number, height: number, viewport = VIEWPORT) {
  expect(layer.left).toBeGreaterThanOrEqual(viewport.left + 7);
  expect(layer.left + width).toBeLessThanOrEqual(viewport.right - 7);
  expect(layer.top).toBeGreaterThanOrEqual(viewport.top + 7);
  expect(layer.top + height).toBeLessThanOrEqual(viewport.bottom - 7);
}

function overlaps(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number },
) {
  return !(
    a.right <= b.left ||
    a.left >= b.right ||
    a.bottom <= b.top ||
    a.top >= b.bottom
  );
}

/* ------------------------------------------------------------------ */
/* 1. 日期弹层                                                         */
/* ------------------------------------------------------------------ */

describe('ZX7-QA-01 · 日期弹层', () => {
  it('底部触发器翻上、顶部触发器翻下，左右边缘夹取且不遮触发器', () => {
    const layer = { width: 320, height: 430 };

    const bottom = computeDatePopoverLayout({
      anchor: rect(500, 820, 200, 36),
      layer,
      viewport: VIEWPORT,
    });
    expect(bottom.placement).toBe('top-start');
    expect(bottom.top + 430).toBeLessThanOrEqual(820);

    const top = computeDatePopoverLayout({
      anchor: rect(500, 10, 200, 36),
      layer,
      viewport: VIEWPORT,
    });
    expect(top.placement).toBe('bottom-start');
    expect(top.top).toBeGreaterThanOrEqual(46);

    const rightEdge = computeDatePopoverLayout({
      anchor: rect(1180, 400, 80, 36),
      layer,
      viewport: VIEWPORT,
    });
    expectInside(rightEdge, rightEdge.width, Math.min(430, rightEdge.maxHeight ?? 430));
    expect(rightEdge.left + rightEdge.width).toBeLessThanOrEqual(1272);

    const leftEdge = computeDatePopoverLayout({
      anchor: rect(2, 400, 80, 36),
      layer,
      viewport: VIEWPORT,
    });
    expect(leftEdge.left).toBe(8);
    expect(overlaps(
      { left: leftEdge.left, top: leftEdge.top, right: leftEdge.left + leftEdge.width, bottom: leftEdge.top + (leftEdge.maxHeight ?? 430) },
      rect(2, 400, 80, 36),
    )).toBe(false);
  });

  it('短视口与 390 窄窗回退 sheet；模态内提升到 1250 层', () => {
    const narrow = computeDatePopoverLayout({
      anchor: rect(20, 600, 120, 36),
      layer: { width: 320, height: 430 },
      viewport: { ...VIEWPORT, right: 390, width: 390, height: 844 },
    });
    expect(narrow.placement).toBe('sheet');
    expect(narrow.maxHeight).toBe(844 - 24);

    const short = computeDatePopoverLayout({
      anchor: rect(500, 300, 200, 36),
      layer: { width: 320, height: 430 },
      viewport: { ...VIEWPORT, bottom: 340, height: 340 },
    });
    expect(short.placement).toBe('sheet');

    const modal = computeDatePopoverLayout({
      anchor: rect(500, 500, 200, 36),
      layer: { width: 320, height: 430 },
      viewport: VIEWPORT,
      inModal: true,
    });
    expect(modal.layer).toBe('modal');
  });

  it('连续点击触发器只保留一个弹层；Esc 恢复最后已提交值', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<string | null>('2026-10-30');
      return (
        <>
          <DatePicker
            id="qa-date"
            value={value}
            today="2026-10-31"
            ariaLabel="日期"
            onChange={(next) => {
              setValue(next);
              onChange(next);
            }}
          />
          <output data-testid="value">{value ?? 'null'}</output>
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: /打开日期选择/ });

    for (let index = 0; index < 12; index += 1) {
      fireEvent.click(trigger);
    }
    expect(screen.queryAllByRole('dialog', { name: '选择日期' })).toHaveLength(0);
    fireEvent.click(trigger);
    const dialogs = screen.getAllByRole('dialog', { name: '选择日期' });
    expect(dialogs).toHaveLength(1);

    const dialog = dialogs[0];
    const target = dialog.querySelector<HTMLElement>('[data-date="2026-11-05"]');
    expect(target).not.toBeNull();
    fireEvent.click(target!);
    expect(screen.getByTestId('value').textContent).toBe('2026-10-30');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    expect(screen.getByTestId('value').textContent).toBe('2026-10-30');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('日期')).toHaveFocus();
  });

  it('锚点滚出视口后关闭弹层，不留下悬空浮层', async () => {
    const { container } = render(
      <DatePicker
        id="qa-scroll"
        value="2026-10-30"
        today="2026-10-31"
        ariaLabel="滚动日期"
        onChange={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /打开日期选择/ }));
    expect(await screen.findByRole('dialog', { name: '选择日期' })).toBeTruthy();

    const field = container.querySelector<HTMLElement>('.date-field');
    expect(field).not.toBeNull();
    const spy = vi
      .spyOn(field!, 'getBoundingClientRect')
      .mockReturnValue({
        left: 500,
        top: -800,
        right: 700,
        bottom: -764,
        width: 200,
        height: 36,
        x: 500,
        y: -800,
        toJSON: () => ({}),
      } as DOMRect);
    fireEvent.scroll(window);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    spy.mockRestore();
  });
});

/* ------------------------------------------------------------------ */
/* 2. 表格 / 公式工具条                                                */
/* ------------------------------------------------------------------ */

describe('ZX7-QA-01 · 工具条定位纯函数', () => {
  const layer = { width: 211, height: 34 };

  it('首行翻到下方、末行翻到上方，均不覆盖锚点', () => {
    const first = placeToolbar({
      anchor: rect(300, 8, 140, 34),
      layer,
      viewport: VIEWPORT,
    });
    expect(first.side).toBe('bottom');
    expect(first.top).toBeGreaterThanOrEqual(42);

    const last = placeToolbar({
      anchor: rect(300, 850, 140, 34),
      layer,
      viewport: VIEWPORT,
    });
    expect(last.side).toBe('top');
    expect(last.top + 34).toBeLessThanOrEqual(850);
  });

  it('首列/末列与 390 窄窗均夹在视口内，maxWidth 不超过 vw-16', () => {
    const firstColumn = placeToolbar({
      anchor: rect(2, 400, 140, 34),
      layer,
      viewport: VIEWPORT,
    });
    expect(firstColumn.left).toBeGreaterThanOrEqual(8);

    const lastColumn = placeToolbar({
      anchor: rect(1240, 400, 40, 34),
      layer,
      viewport: VIEWPORT,
    });
    expect(lastColumn.left + 211).toBeLessThanOrEqual(1272);

    const narrowViewport = {
      left: 0,
      top: 0,
      right: 390,
      bottom: 844,
      width: 390,
      height: 844,
    };
    const narrow = placeToolbar({
      anchor: rect(202, 600, 140, 34),
      layer,
      viewport: narrowViewport,
    });
    expect(narrow.maxWidth).toBe(374);
    expect(narrow.left).toBeGreaterThanOrEqual(8);
    expect(narrow.left + 211).toBeLessThanOrEqual(382);
  });

  it('锚点离开视口 24px 后视为不可见', () => {
    expect(isAnchorVisible(rect(100, -30, 100, 34), VIEWPORT)).toBe(true);
    expect(isAnchorVisible(rect(100, -60, 100, 34), VIEWPORT)).toBe(false);
    expect(isAnchorVisible(rect(100, 100, 0, 0), VIEWPORT)).toBe(true);
  });
});

function TableHarness({ rows }: { rows: string[][] }) {
  const [current, setCurrent] = useState(rows);
  return (
    <TableBlock
      block={makeBlock({
        id: 'qa-table',
        type: 'table',
        payload: { rows: current } as never,
      })}
      readOnly={false}
      onChange={(next) => setCurrent(next as unknown as string[][])}
    />
  );
}

function FormulaHarness() {
  const [state, setState] = useState({
    latex: 'x^2 + y^2',
    display: 'block' as 'block' | 'inline',
  });
  return (
    <FormulaBlock
      block={makeBlock({
        id: 'qa-formula',
        type: 'formula',
        payload: { latex: state.latex, display: state.display, renderer: 'none' },
      })}
      readOnly={false}
      onChangeLatex={(latex) => setState((s) => ({ ...s, latex }))}
      onChangeDisplay={(display) => setState((s) => ({ ...s, display }))}
    />
  );
}

describe('ZX7-QA-01 · 工具条组件交互', () => {
  it('表格：聚焦后只挂载一个工具条；连续点击不重复；Alt+F10/Esc 焦点归还', async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(
      <TableHarness rows={[['A', 'B'], ['C', 'D']]} />,
    );
    const cell = screen.getByLabelText('第 1 行第 1 列');
    await user.click(cell);
    await waitFor(() =>
      expect(document.body.querySelectorAll('.zxe-table-toolbar')).toHaveLength(1),
    );

    for (let index = 0; index < 12; index += 1) {
      fireEvent.mouseDown(cell);
      fireEvent.mouseUp(cell);
      fireEvent.click(cell);
    }
    expect(document.body.querySelectorAll('.zxe-table-toolbar')).toHaveLength(1);

    const wrap = container.querySelector<HTMLElement>('.zxe-table-wrap')!;
    wrap.focus();
    fireEvent.keyDown(wrap, { key: 'F10', altKey: true });
    const toolbar = screen.getByRole('toolbar', { name: '表格工具栏' });
    expect(toolbar.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(cell);

    rerender(
      <TableBlock
        block={makeBlock({
          id: 'qa-table',
          type: 'table',
          payload: { rows: [['A', 'B'], ['C', 'D']] } as never,
        })}
        readOnly={false}
        contextMenuOpen
        onChange={() => undefined}
      />,
    );
    await waitFor(() =>
      expect(document.body.querySelector('.zxe-table-toolbar')).toBeNull(),
    );
  });

  it('公式：hover 出现、编辑态跟随 caret、Esc 回 textarea、失焦隐藏', async () => {
    const user = userEvent.setup();
    render(<FormulaHarness />);
    const group = screen.getByRole('group', { name: '公式块' });
    fireEvent.mouseEnter(group);
    await waitFor(() =>
      expect(document.body.querySelector('.zxe-formula-head')).not.toBeNull(),
    );

    await user.click(screen.getByRole('button', { name: '编辑公式' }));
    const textarea = screen.getByLabelText('LaTeX 源') as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(3, 3);
    fireEvent.keyUp(textarea, { key: 'ArrowRight' });
    const toolbar = screen.getByRole('toolbar', { name: '公式工具栏' });
    expect(toolbar.getAttribute('data-positioned')).toBe('true');

    fireEvent.keyDown(toolbar, { key: 'F10', altKey: true });
    expect(toolbar.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(document.activeElement).toBe(textarea);

    fireEvent.mouseLeave(group, { relatedTarget: document.body });
    fireEvent.blur(textarea, { relatedTarget: document.body });
    await waitFor(
      () => expect(document.body.querySelector('.zxe-formula-head')).toBeNull(),
      { timeout: 1500 },
    );
  });
});

/* ------------------------------------------------------------------ */
/* 3. 菜单：键盘 / 子菜单 / 焦点归还 / i18n                              */
/* ------------------------------------------------------------------ */

function MenuHarness({ onClose }: { onClose: (reason: string) => void }) {
  return (
    <ContextMenu
      x={40}
      y={40}
      label={t('menu.label.text')}
      focusOnOpen
      items={[
        { id: 'copy', labelKey: 'menu.text.copy', shortcut: 'Mod+C' },
        { divider: true },
        {
          id: 'insert',
          labelKey: 'menu.text.insert',
          submenu: [
            { id: 'insert-table', labelKey: 'menu.text.insert.table' },
            { id: 'insert-formula', labelKey: 'menu.text.insert.formula' },
          ],
        },
        {
          id: 'delete',
          labelKey: 'menu.text.deleteBlock',
          danger: true,
          disabled: true,
          hintKey: 'menu.hint.lastBlock',
        },
      ]}
      softDisabled
      onClose={(reason) => onClose(reason)}
    />
  );
}

describe('ZX7-QA-01 · 菜单键盘与 i18n', () => {
  it('方向键跳过禁用项；→ 展开子菜单、← 返回、Esc 关闭', async () => {
    const onClose = vi.fn();
    render(<MenuHarness onClose={onClose} />);
    const menu = screen.getByRole('menu', { name: '文本菜单' });
    const copy = within(menu).getByRole('menuitem', { name: /^复制/ });
    expect(document.activeElement).toBe(copy);

    fireEvent.keyDown(copy, { key: 'End' });
    const insert = within(menu).getByRole('menuitem', { name: /^插入/ });
    expect(document.activeElement).toBe(insert);

    fireEvent.keyDown(insert, { key: 'ArrowRight' });
    const tableItem = await within(menu).findByRole('menuitem', { name: /^表格/ });
    expect(document.activeElement).toBe(tableItem);
    expect(
      within(menu).getByRole('menuitem', { name: /^公式/ }),
    ).toBeInTheDocument();

    fireEvent.keyDown(tableItem, { key: 'ArrowLeft' });
    await waitFor(() => expect(document.activeElement).toBe(insert));

    fireEvent.keyDown(insert, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith('escape');
  });

  it('菜单文案 key 全覆盖：全部有中文值，跨区域同动作同名', () => {
    const keys = Object.keys(menuCatalog);
    expect(keys).toHaveLength(186);
    const properNounOnly = new Set([
      'Markdown（.md）',
      'HTML（.html）',
      '复制 Markdown',
      '复制 HTML',
    ]);
    for (const [key, value] of Object.entries(menuCatalog)) {
      expect(key.startsWith('menu.'), key).toBe(true);
      expect(value.trim(), key).not.toBe('');
      expect(
        /[一-鿿]/.test(value) || properNounOnly.has(value),
        key,
      ).toBe(true);
    }

    expect(menuCatalog['menu.tab.copyLink']).toBe(
      menuCatalog['menu.note.copyLink'],
    );
    expect(menuCatalog['menu.tab.pin']).toBe(menuCatalog['menu.note.pin']);
    expect(menuCatalog['menu.tab.unpin']).toBe(menuCatalog['menu.note.unpin']);
    expect(menuCatalog['menu.tab.favorite']).toBe(
      menuCatalog['menu.note.favorite'],
    );
    expect(menuCatalog['menu.tab.export']).toBe(menuCatalog['menu.note.export']);
    expect(menuCatalog['menu.formula.deleteBlock']).toBe(
      menuCatalog['menu.text.deleteBlock'],
    );
    expect(menuCatalog['menu.table.alignLeft']).toBe(
      menuCatalog['menu.board.alignLeft'],
    );

    const files = [
      'app/src/features/editor/NoteBlockEditor.tsx',
      'app/src/features/knowledge/KnowledgePage.tsx',
      'app/src/features/board/components/BoardContextMenu.tsx',
      'app/src/features/knowledge/contextMenu.tsx',
    ];
    const root = path.resolve(__dirname, '..');
    for (const file of files) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      const used = [
        ...source.matchAll(
          /(?:labelKey|hintKey|headingKey):\s*'(menu\.[^']+)'/g,
        ),
      ].map((match) => match[1] as MenuKey);
      for (const key of used) {
        expect(menuCatalog[key], `${file} 使用了未登记 key ${key}`).toBeTruthy();
      }
      const englishLabels = [
        ...source.matchAll(/(?:label|heading):\s*'([A-Za-z][A-Za-z .]*?)'/g),
      ].map((match) => match[1]);
      expect(
        englishLabels.filter(
          (value) => !/^(Markdown|HTML|LaTeX|PDF|Word|JavaScript|TypeScript)$/.test(value),
        ),
        `${file} 菜单英文硬编码`,
      ).toEqual([]);
    }
  });

  it('知识页笔记行 Shift+F10 打开菜单，Esc 后焦点回到来源行', async () => {
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-a',
        title: '独立验收笔记',
        body: '<p>正文</p>',
        updatedAt: '2026-10-22T08:00:00.000Z',
      }),
    ]);
    const taskSource = createFakeTodoTaskSource(
      [],
      [makeFakeList({ id: 'inbox', name: '收件箱', isInbox: true, sortOrder: 0 })],
    );
    render(
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
                taskSource={{ tasks: taskSource.tasks, lists: taskSource.lists }}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    const noteButton = await screen.findByRole('button', {
      name: '打开笔记：独立验收笔记',
    });
    noteButton.focus();
    fireEvent.keyDown(noteButton, { key: 'F10', shiftKey: true });
    const menu = await screen.findByRole('menu', { name: '笔记操作' });
    expect(document.activeElement).toBe(
      within(menu).getByRole('menuitem', { name: /^打开/ }),
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(noteButton);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 空数据与控制台                                                   */
/* ------------------------------------------------------------------ */

describe('ZX7-QA-01 · 空数据与控制台', () => {
  function renderPage(source: ReturnType<typeof createFakeNoteSource>) {
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
                taskSource={{ tasks: taskSource.tasks, lists: taskSource.lists }}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('知识页空数据不崩溃、不产生 console.error，并显示空态', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderPage(createFakeNoteSource([]));
    expect(await screen.findByText('还没有笔记')).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: '导入笔记' }).length,
    ).toBeGreaterThan(0);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('重命名后卸载再挂载，标题从数据源恢复（刷新持久化）', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-persist',
        title: '刷新前标题',
        body: '<p>正文</p>',
        updatedAt: '2026-10-22T08:00:00.000Z',
      }),
    ]);
    const first = renderPage(source);
    await user.click(
      await screen.findByRole('button', { name: '打开笔记：刷新前标题' }),
    );
    const title = screen.getByLabelText('笔记标题') as HTMLInputElement;
    await user.clear(title);
    await user.type(title, '刷新后仍在{Enter}');
    await waitFor(() =>
      expect(source.snapshot()[0].title).toBe('刷新后仍在'),
    );
    first.unmount();

    renderPage(source);
    expect(
      await screen.findByRole('button', { name: '打开笔记：刷新后仍在' }),
    ).toBeInTheDocument();
  });

  it('删除已被移除的笔记：报错可见且不产生未捕获异常', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = createFakeNoteSource([
      makeNote({
        id: 'note-gone',
        title: '已被移除',
        body: '<p>正文</p>',
        updatedAt: '2026-10-22T08:00:00.000Z',
      }),
    ]);
    const source = {
      ...base,
      async remove(): Promise<void> {
        throw new Error('笔记不存在：note-gone');
      },
    };
    const user = userEvent.setup();
    renderPage(source);
    await user.click(
      await screen.findByRole('button', { name: '更多操作：已被移除' }),
    );
    await user.click(screen.getByRole('menuitem', { name: /^删除笔记/ }));
    const dialog = await screen.findByRole('dialog', { name: '删除笔记' });
    await user.click(within(dialog).getByRole('button', { name: '确认删除' }));
    expect(
      await screen.findByText('笔记不存在：note-gone'),
    ).toBeInTheDocument();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
