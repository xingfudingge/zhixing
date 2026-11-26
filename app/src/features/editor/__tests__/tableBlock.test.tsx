import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BlockPayload } from '../../../data/repositories/blocks';
import { blocksToHtml, tableToHtml, tableToMarkdown } from '../blockHtml';
import { NoteBlockEditor } from '../NoteBlockEditor';
import { TableBlock } from '../blocks/TableBlock';
import {
  blockTableModel,
  tablePayloadRows,
  type TableCell,
} from '../types';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
} from './fakeBlockSource';

type Rows = TableCell[][] | string[][];

function modelOf(rows: Rows) {
  return blockTableModel({
    payload: { rows } as unknown as BlockPayload,
  }).model;
}

function TableHarness({
  initial,
  readOnly = false,
  onRows,
}: {
  initial: Rows;
  readOnly?: boolean;
  onRows?: (rows: TableCell[][]) => void;
}) {
  const [rows, setRows] = useState<Rows>(initial);
  const block = makeBlock({
    id: 'table-1',
    type: 'table',
    payload: { rows } as unknown as BlockPayload,
  });
  return (
    <TableBlock
      block={block}
      readOnly={readOnly}
      onChange={(next) => {
        setRows(next);
        onRows?.(next);
      }}
    />
  );
}

function cellAt(row: number, column: number): HTMLElement {
  return screen.getByLabelText(`第 ${row + 1} 行第 ${column + 1} 列`);
}

function tdAt(row: number, column: number): HTMLElement {
  return cellAt(row, column).closest('td,th') as HTMLElement;
}

function dragSelect(
  from: [number, number],
  to: [number, number],
): void {
  // 真实浏览器 mousedown 会聚焦起始单元格；jsdom 不自动聚焦，显式补上，
  // 这样工具条按“焦点单元格 + 选区包围盒”跟随 caret（ZX7-TOOLBAR-01）。
  cellAt(from[0], from[1]).focus();
  fireEvent.mouseDown(tdAt(from[0], from[1]), { button: 0 });
  fireEvent.mouseEnter(tdAt(to[0], to[1]));
  fireEvent.mouseUp(window);
}

type TableUser = ReturnType<typeof userEvent.setup>;

/** 表格工具条只在有选区时出现，菜单/表头/对齐操作前先选中一个单元格。 */
async function selectCell(
  user: TableUser,
  row = 0,
  column = 0,
): Promise<void> {
  await user.click(cellAt(row, column));
}

async function openTableMenu(user: TableUser): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: '更多表格操作' }));
  return screen.findByRole('menu', { name: '更多表格操作' });
}

async function chooseTableAction(
  user: TableUser,
  name: string,
): Promise<void> {
  const menu = await openTableMenu(user);
  await user.click(within(menu).getByRole('menuitem', { name }));
}

/** jsdom 不计算绝对定位布局，浮层契约通过 CSSOM 断言（真实几何由 e2e 复验）。 */
function tableCssRule(selector: string): CSSStyleRule {
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule instanceof CSSStyleRule && rule.selectorText === selector) {
        return rule;
      }
    }
  }
  throw new Error(`没有找到表格 CSS 规则：${selector}`);
}

describe('表格块 · 结构编辑', () => {
  it('表头开关只影响首行标签，数据不丢', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TableHarness
        initial={[
          ['模块', '状态'],
          ['知识块', '进行中'],
        ]}
      />,
    );
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(cellAt(0, 0)).toHaveValue('模块');

    await selectCell(user);
    await user.click(screen.getByRole('button', { name: '表头' }));
    await waitFor(() => {
      expect(container.querySelectorAll('th')).toHaveLength(0);
    });
    expect(cellAt(0, 0)).toHaveValue('模块');

    await user.click(screen.getByRole('button', { name: '表头' }));
    await waitFor(() => {
      expect(container.querySelectorAll('th')).toHaveLength(2);
    });
  });

  it('单元格对齐写入模型并渲染 text-align', async () => {
    const user = userEvent.setup();
    render(<TableHarness initial={[['甲', '乙']]} />);
    await user.click(cellAt(0, 0));
    await user.click(screen.getByRole('button', { name: '中对齐' }));
    const cell = cellAt(0, 0).closest('td,th') as HTMLElement;
    expect(cell.style.textAlign).toBe('center');
    expect(cell.className).toContain('zxe-table-align-center');
  });

  it('拖选区域、合并/拆分，合并后删除相交行被拒绝', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TableHarness
        initial={[
          ['A', 'B', 'C'],
          ['D', 'E', 'F'],
          ['G', 'H', 'I'],
        ]}
      />,
    );
    dragSelect([0, 0], [1, 1]);
    // 选区尺寸只在选中时出现在浮出工具条里，不再有常驻底栏。
    expect(
      document.querySelector('.zxe-table-selection-chip')?.textContent,
    ).toBe('2×2');
    expect(container.querySelector('.zxe-table-foot')).toBeNull();

    await chooseTableAction(user, '合并选区');
    await waitFor(() => {
      expect(container.querySelector('[colspan="2"]')).not.toBeNull();
    });
    expect(container.querySelector('[rowspan="2"]')).not.toBeNull();
    expect(screen.getByText(/已合并 4 个单元格/)).toBeInTheDocument();

    await chooseTableAction(user, '删除当前行');
    expect(
      screen.getByText('该行包含合并单元格，请先拆分'),
    ).toBeInTheDocument();
    expect(container.querySelectorAll('tr')).toHaveLength(3);

    await chooseTableAction(user, '拆分单元格');
    await waitFor(() => {
      expect(container.querySelector('[colspan="2"]')).toBeNull();
    });
    expect(screen.getByText(/已拆分 1 个合并区域/)).toBeInTheDocument();
  });

  it('Shift+点击扩展选区，⌘A 选中全部单元格', async () => {
    render(
      <TableHarness
        initial={[
          ['A', 'B', 'C'],
          ['D', 'E', 'F'],
          ['G', 'H', 'I'],
        ]}
      />,
    );
    const chip = () =>
      document.querySelector('.zxe-table-selection-chip')?.textContent;
    cellAt(0, 0).focus();
    fireEvent.mouseDown(tdAt(0, 0), { button: 0 });
    fireEvent.mouseUp(window);
    fireEvent.mouseDown(tdAt(2, 1), { button: 0, shiftKey: true });
    fireEvent.mouseUp(window);
    expect(chip()).toBe('3×2');

    fireEvent.keyDown(cellAt(0, 0), { key: 'a', metaKey: true });
    expect(chip()).toBe('3×3');
    expect(screen.getByText('已选中全部单元格')).toBeInTheDocument();
  });

  it('在任意位置插入行列，40×16 边界禁用并给出原因', async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(
      <TableHarness
        initial={[
          ['A', 'B'],
          ['C', 'D'],
        ]}
      />,
    );
    await user.click(cellAt(1, 0));
    await chooseTableAction(user, '上方插入行');
    await waitFor(() => {
      expect(container.querySelectorAll('tr')).toHaveLength(3);
    });
    await user.click(cellAt(1, 1));
    await chooseTableAction(user, '右侧插入列');
    await waitFor(() => {
      expect(container.querySelectorAll('col')).toHaveLength(3);
    });

    unmount();
    const full = Array.from({ length: 40 }, (_, row) =>
      Array.from({ length: 16 }, (_, column) => `${row}-${column}`),
    );
    render(<TableHarness initial={full} />);
    await user.click(cellAt(0, 0));
    await user.click(screen.getByRole('button', { name: '更多表格操作' }));
    const menu = await screen.findByRole('menu', { name: '更多表格操作' });
    expect(
      within(menu).getByRole('menuitem', { name: '下方插入行' }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(
      within(menu).getByRole('menuitem', { name: '下方插入行' }),
    ).toHaveAttribute('title', '表格最多 40 行');
    expect(
      within(menu).getByRole('menuitem', { name: '右侧插入列' }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(
      within(menu).getByRole('menuitem', { name: '右侧插入列' }),
    ).toHaveAttribute('title', '表格最多 16 列');
  });

  it('Tab / Shift+Tab / Enter 导航，末格自动追加行', async () => {
    const first = render(<TableHarness initial={[['A', 'B']]} />);
    cellAt(0, 0).focus();
    fireEvent.keyDown(cellAt(0, 0), { key: 'Tab' });
    await waitFor(() => {
      expect(cellAt(0, 1)).toHaveFocus();
    });
    fireEvent.keyDown(cellAt(0, 1), { key: 'Tab' });
    await waitFor(() => {
      expect(cellAt(1, 0)).toHaveFocus();
    });
    first.unmount();

    const { container } = render(
      <TableHarness
        initial={[
          ['A', 'B'],
          ['C', 'D'],
        ]}
      />,
    );
    cellAt(1, 1).focus();
    fireEvent.keyDown(cellAt(1, 1), { key: 'Enter' });
    await waitFor(() => {
      expect(container.querySelectorAll('tr')).toHaveLength(3);
    });
  });

  it('列宽双击恢复默认，平均列宽写入模型', async () => {
    const user = userEvent.setup();
    let latest: TableCell[][] = [];
    const initial: TableCell[][] = [
      [
        { text: 'A', align: 'left', rowSpan: 1, colSpan: 1, covered: false },
        { text: 'B', align: 'left', rowSpan: 1, colSpan: 1, covered: false },
      ],
    ];
    initial[0][0].table = { header: true, widths: [220, 160] };
    const { container } = render(
      <TableHarness
        initial={initial}
        onRows={(rows) => {
          latest = rows;
        }}
      />,
    );
    await selectCell(user);
    await user.dblClick(
      screen.getByRole('separator', { name: '调整第 1 列列宽' }),
    );
    await waitFor(() => {
      expect(container.querySelector('col')?.getAttribute('style')).toContain(
        '140px',
      );
    });
    expect(latest[0][0].table?.widths[0]).toBe(140);

    await chooseTableAction(user, '平均列宽');
    await waitFor(() => {
      expect(latest[0][0].table?.widths).toEqual([320, 320]);
    });

    const handle = screen.getByRole('separator', {
      name: '调整第 1 列列宽',
    });
    fireEvent.mouseDown(handle, { button: 0, clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 136 });
    fireEvent.mouseUp(window);
    await waitFor(() => {
      expect(latest[0][0].table?.widths[0]).toBe(356);
    });
  });
});

describe('表格块 · 工具栏收口（ZX5-TABLE-01）', () => {
  it('选区工具条只保留 5 个可见控件', async () => {
    const user = userEvent.setup();
    render(<TableHarness initial={[['A', 'B']]} />);
    await selectCell(user);
    const toolbar = screen.getByRole('toolbar', { name: '表格工具栏' });
    const controls = within(toolbar)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(controls).toEqual([
      '表头',
      '左对齐',
      '中对齐',
      '右对齐',
      '更多表格操作',
    ]);
    expect(controls.length).toBeLessThanOrEqual(6);
    expect(
      screen.getByRole('button', { name: '更多表格操作' }),
    ).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('更多菜单按四段列出 13 个动作，并用分隔线分段', async () => {
    const user = userEvent.setup();
    render(<TableHarness initial={[['A', 'B']]} />);
    await selectCell(user);
    const menu = await openTableMenu(user);
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      '合并选区',
      '拆分单元格',
      '上方插入行',
      '下方插入行',
      '左侧插入列',
      '右侧插入列',
      '删除当前行',
      '删除当前列',
      '平均列宽',
      '清空选区',
      '复制选区',
      '导出 Markdown',
      '导出 HTML',
    ]);
    expect(within(menu).getAllByRole('separator')).toHaveLength(3);
  });

  it('按选区与行列边界禁用动作，并给出原因', async () => {
    const user = userEvent.setup();
    render(<TableHarness initial={[['A', 'B']]} />);
    await selectCell(user);
    let menu = await openTableMenu(user);
    const item = (name: string) =>
      within(menu).getByRole('menuitem', { name });

    expect(item('合并选区')).toHaveAttribute('aria-disabled', 'true');
    expect(item('合并选区')).toHaveAttribute(
      'title',
      '选择至少 2 个单元格',
    );
    expect(item('拆分单元格')).toHaveAttribute('aria-disabled', 'true');
    expect(item('拆分单元格')).toHaveAttribute(
      'title',
      '选区没有合并单元格',
    );
    expect(item('清空选区')).not.toHaveAttribute('aria-disabled');
    expect(item('删除当前行')).toHaveAttribute('aria-disabled', 'true');
    expect(item('删除当前行')).toHaveAttribute('title', '至少保留 1 行');
    expect(item('平均列宽')).not.toHaveAttribute('aria-disabled');
    expect(item('复制选区')).not.toHaveAttribute('aria-disabled');

    await user.keyboard('{Escape}');
    dragSelect([0, 0], [0, 1]);
    menu = await openTableMenu(user);
    expect(item('合并选区')).not.toHaveAttribute('aria-disabled');
    expect(item('清空选区')).not.toHaveAttribute('aria-disabled');
    expect(item('拆分单元格')).toHaveAttribute('aria-disabled', 'true');

    await user.click(within(menu).getByRole('menuitem', { name: '合并选区' }));
    menu = await openTableMenu(user);
    expect(item('拆分单元格')).not.toHaveAttribute('aria-disabled');
  });

  it('更多菜单可用键盘打开、循环、执行，Esc/Tab 关闭', async () => {
    const user = userEvent.setup();
    render(<TableHarness initial={[['A', 'B']]} />);
    await selectCell(user);
    const trigger = screen.getByRole('button', { name: '更多表格操作' });
    trigger.focus();
    await user.keyboard('{Enter}');
    let menu = await screen.findByRole('menu', { name: '更多表格操作' });
    let items = within(menu).getAllByRole('menuitem');
    await waitFor(() => expect(items[0]).toHaveFocus());

    await user.keyboard('{End}');
    expect(items[items.length - 1]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: '更多表格操作' })).toBeNull();
    expect(trigger).toHaveFocus();

    await user.keyboard('{Enter}');
    menu = await screen.findByRole('menu', { name: '更多表格操作' });
    items = within(menu).getAllByRole('menuitem');
    await user.keyboard('{End}');
    await user.keyboard('{Enter}');
    expect(
      screen.getByRole('dialog', { name: '表格导出预览' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('menu', { name: '更多表格操作' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '关闭导出预览' }));
    trigger.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu', { name: '更多表格操作' });
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu', { name: '更多表格操作' })).toBeNull();
  });

  it('清空、复制与导出 HTML 仍可从菜单执行', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(
      <TableHarness
        initial={[
          ['A', 'B'],
          ['C', 'D'],
        ]}
      />,
    );
    dragSelect([0, 0], [1, 1]);
    await chooseTableAction(user, '复制选区');
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('A\tB\nC\tD'));

    await chooseTableAction(user, '清空选区');
    await waitFor(() => {
      expect(cellAt(0, 0)).toHaveValue('');
      expect(cellAt(1, 1)).toHaveValue('');
    });
    expect(screen.getByText('已清空选区内容')).toBeInTheDocument();

    await chooseTableAction(user, '导出 HTML');
    const dialog = screen.getByRole('dialog', { name: '表格导出预览' });
    expect(within(dialog).getByText(/<table class="zx-table">/)).toBeVisible();
    expect(container.querySelector('table.zxe-table')).not.toBeNull();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: originalClipboard,
    });
  });
});

describe('表格块 · 无选区禁用单元格动作（ZX6-TABLE-02）', () => {
  function hoverTable(container: HTMLElement): HTMLElement {
    const wrap = container.querySelector<HTMLElement>('.zxe-table-wrap');
    expect(wrap).not.toBeNull();
    fireEvent.mouseEnter(wrap!);
    return wrap!;
  }

  it('仅 hover、无选区时对齐按钮禁用并说明原因，表格级动作仍可用', async () => {
    const { container } = render(<TableHarness initial={[['A', 'B']]} />);
    hoverTable(container);
    const toolbar = screen.getByRole('toolbar', { name: '表格工具栏' });

    for (const name of ['左对齐', '中对齐', '右对齐']) {
      const button = within(toolbar).getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', '请先选择单元格再设置对齐');
      const hintId = button.getAttribute('aria-describedby');
      expect(hintId).toBeTruthy();
      expect(document.getElementById(hintId!)).toHaveTextContent(
        '请先选择单元格再设置对齐',
      );
    }

    // 表头、更多菜单是表格级动作，不依赖单元格选区。
    expect(
      within(toolbar).getByRole('button', { name: '表头' }),
    ).toBeEnabled();
    expect(
      within(toolbar).getByRole('button', { name: '更多表格操作' }),
    ).toBeEnabled();
  });

  it('点击禁用按钮不改模型、不弹提示', () => {
    const onRows = vi.fn();
    const { container } = render(
      <TableHarness initial={[['A', 'B']]} onRows={onRows} />,
    );
    hoverTable(container);
    const alignLeft = screen.getByRole('button', { name: '左对齐' });
    fireEvent.click(alignLeft);

    expect(onRows).not.toHaveBeenCalled();
    expect(container.querySelector('.zxe-table-toast')).toBeNull();
    expect(screen.queryByText('请先选择单元格')).toBeNull();
    expect(tdAt(0, 0).style.textAlign).toBe('left');
  });

  it('选中单元格后解除禁用，执行对齐仍正确写入', async () => {
    const user = userEvent.setup();
    const { container } = render(<TableHarness initial={[['A', 'B']]} />);
    await selectCell(user, 0, 0);
    const toolbar = screen.getByRole('toolbar', { name: '表格工具栏' });

    for (const name of ['左对齐', '中对齐', '右对齐']) {
      const button = within(toolbar).getByRole('button', { name });
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute('aria-describedby');
    }

    await user.click(screen.getByRole('button', { name: '中对齐' }));
    expect(tdAt(0, 0).className).toContain('zxe-table-align-center');
    expect(tdAt(0, 1).className).not.toContain('zxe-table-align-center');
    expect(container.querySelector('.zxe-table-toast')).toHaveTextContent(
      '已中对齐 1 个单元格',
    );
  });

  it('键盘跳过禁用按钮，无法触发对齐', async () => {
    const user = userEvent.setup();
    const onRows = vi.fn();
    render(<TableHarness initial={[['A', 'B']]} onRows={onRows} />);

    await user.tab();
    const toolbar = await screen.findByRole('toolbar', {
      name: '表格工具栏',
    });
    const alignLeft = within(toolbar).getByRole('button', { name: '左对齐' });
    expect(alignLeft).toBeDisabled();
    alignLeft.focus();
    expect(alignLeft).not.toHaveFocus();

    await user.tab();
    expect(
      within(toolbar).getByRole('button', { name: '表头' }),
    ).toHaveFocus();
    await user.tab();
    expect(
      within(toolbar).getByRole('button', { name: '更多表格操作' }),
    ).toHaveFocus();
    expect(alignLeft).not.toHaveFocus();
    expect(onRows).not.toHaveBeenCalled();
  });

  it('无选区时表头与插入行按自身条件工作，不因对齐禁用而误伤', async () => {
    const onRows = vi.fn();
    const { container } = render(
      <TableHarness initial={[['A', 'B']]} onRows={onRows} />,
    );
    hoverTable(container);

    // 用 fireEvent 模拟点击，避免 userEvent 的指针移动在 jsdom 里
    // 触发 mouseleave，把“仅 hover 可见”的工具条提前卸载。
    fireEvent.click(screen.getByRole('button', { name: '表头' }));
    expect(onRows).toHaveBeenCalled();
    expect(
      onRows.mock.calls.at(-1)?.[0]?.[0]?.[0]?.table?.header,
    ).toBe(false);
    expect(container.querySelectorAll('th')).toHaveLength(0);

    fireEvent.click(
      screen.getByRole('button', { name: '更多表格操作' }),
    );
    const menu = await screen.findByRole('menu', {
      name: '更多表格操作',
    });
    fireEvent.click(
      within(menu).getByRole('menuitem', { name: '上方插入行' }),
    );
    expect(container.querySelector('.zxe-table-toast')).toHaveTextContent(
      '已在上方插入行',
    );
    const latest = onRows.mock.calls.at(-1)?.[0] as TableCell[][];
    expect(latest).toHaveLength(2);
  });
});

describe('表格块 · 复制粘贴与只读', () => {
  it('区域复制输出 TSV，粘贴自动扩行扩列', async () => {
    const { container } = render(
      <TableHarness
        initial={[
          ['A', 'B'],
          ['C', 'D'],
        ]}
      />,
    );
    dragSelect([0, 0], [1, 1]);
    const clipboard = {
      data: {} as Record<string, string>,
      setData(type: string, value: string) {
        this.data[type] = value;
      },
      getData(type: string) {
        return this.data[type] ?? '';
      },
    };
    fireEvent.copy(cellAt(0, 0), { clipboardData: clipboard });
    expect(clipboard.data['text/plain']).toBe('A\tB\nC\tD');

    await waitFor(() => {
      expect(container.querySelectorAll('tr')).toHaveLength(2);
    });
    const pasteTarget = cellAt(1, 1).closest('td') as HTMLElement;
    fireEvent.mouseDown(pasteTarget, { button: 0 });
    fireEvent.mouseUp(window);
    fireEvent.paste(cellAt(1, 1), {
      clipboardData: {
        getData: () => '1\t2\n3\t4',
      },
    });
    await waitFor(() => {
      expect(cellAt(2, 2)).toHaveValue('4');
    });
    expect(container.querySelectorAll('tr')).toHaveLength(3);
    expect(container.querySelectorAll('col')).toHaveLength(3);
  });

  it('只读态不渲染工具条和输入框，保留表头、对齐与合并', () => {
    const rows: TableCell[][] = [
      [
        {
          text: '合并标题',
          align: 'center',
          rowSpan: 1,
          colSpan: 2,
          covered: false,
        },
        {
          text: '',
          align: 'left',
          rowSpan: 1,
          colSpan: 1,
          covered: true,
        },
      ],
      [
        {
          text: '正文',
          align: 'right',
          rowSpan: 1,
          colSpan: 1,
          covered: false,
        },
        {
          text: '值',
          align: 'left',
          rowSpan: 1,
          colSpan: 1,
          covered: false,
        },
      ],
    ];
    rows[0][0].table = { header: true, widths: [200, 120] };
    const { container } = render(
      <TableHarness initial={rows} readOnly />,
    );
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(
      screen.queryByRole('button', { name: '更多表格操作' }),
    ).toBeNull();
    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelector('th')?.getAttribute('colspan')).toBe('2');
    expect(container.querySelectorAll('td')).toHaveLength(2);
    expect(container.textContent).toContain('合并标题');
    expect(container.textContent).toContain('正文');
  });

  it('空表提示位于第一个单元格，不再有底部说明行', () => {
    const { container } = render(<TableHarness initial={[['']]} />);
    expect(cellAt(0, 0)).toHaveAttribute(
      'placeholder',
      '输入内容，Tab 下一格',
    );
    expect(screen.queryByText(/空表格：点击单元格输入/)).toBeNull();
    expect(container.querySelector('.zxe-table-empty')).toBeNull();
    expect(container.querySelector('.zxe-table-foot')).toBeNull();
  });
});

describe('表格块 · 上下文工具条（ZX6-TABLE-01）', () => {
  it('未选中不渲染工具条、底栏和空表提示，表格下方直接是内容', () => {
    const { container } = render(<TableHarness initial={[['A', 'B']]} />);
    const wrap = container.querySelector<HTMLElement>('.zxe-table-wrap');
    expect(wrap).not.toBeNull();
    expect(screen.queryByRole('toolbar', { name: '表格工具栏' })).toBeNull();
    expect(wrap?.querySelector('.zxe-table-foot')).toBeNull();
    expect(wrap?.querySelector('.zxe-table-empty')).toBeNull();
    expect(wrap?.lastElementChild?.classList.contains('zxe-table-scroll')).toBe(
      true,
    );
  });

  it('单元格聚焦后浮出工具条，不改变布局；点击表格外隐藏', async () => {
    const user = userEvent.setup();
    const { container } = render(<TableHarness initial={[['A', 'B']]} />);
    const wrap = container.querySelector<HTMLElement>('.zxe-table-wrap');
    const scroll = container.querySelector<HTMLElement>('.zxe-table-scroll');
    const before = scroll?.getBoundingClientRect().top;

    await selectCell(user);
    const toolbar = screen.getByRole('toolbar', { name: '表格工具栏' });
    // 工具条 portal 到 body，脱离表格局部 stacking context（ZX7-TOOLBAR-01）。
    expect(toolbar.parentElement).toBe(document.body);
    expect(wrap?.contains(toolbar)).toBe(false);
    // 浮层不占布局：表格滚动容器的几何位置不变。
    expect(scroll?.getBoundingClientRect().top).toBe(before);
    expect(tableCssRule('.zxe-table-toolbar').style.position).toBe('fixed');
    expect(tableCssRule('.zxe-table-toolbar').style.zIndex).toBe(
      'var(--z-toolbar, 300)',
    );
    expect(tableCssRule('.zxe-table-wrap').style.position).toBe('relative');

    await user.click(document.body);
    await waitFor(() => {
      expect(screen.queryByRole('toolbar')).toBeNull();
    });
  });

  it('多选时只在工具条内显示选区尺寸，不新增底栏', () => {
    const { container } = render(
      <TableHarness
        initial={[
          ['A', 'B', 'C'],
          ['D', 'E', 'F'],
        ]}
      />,
    );
    dragSelect([0, 0], [1, 1]);
    expect(
      document.querySelector('.zxe-table-selection-chip')?.textContent,
    ).toBe('2×2');
    expect(container.querySelector('.zxe-table-foot')).toBeNull();
    expect(container.querySelector('.zxe-table-empty')).toBeNull();
  });

  it('状态消息是 1.6s 气泡，不占布局且自动消失', () => {
    const { container } = render(
      <TableHarness
        initial={[
          ['A', 'B'],
          ['C', 'D'],
        ]}
      />,
    );
    vi.useFakeTimers();
    try {
      dragSelect([0, 0], [0, 1]);
      fireEvent.keyDown(cellAt(0, 0), { key: 'a', metaKey: true });
      const toast = screen.getByRole('status');
      expect(toast.textContent).toBe('已选中全部单元格');
      expect(toast.className).toContain('zxe-table-toast');
      expect(container.querySelector('.zxe-table-foot')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(1700);
      });
      expect(screen.queryByText('已选中全部单元格')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('右键时不与工具条同屏，下一次交互后选区仍在则恢复', async () => {
    const user = userEvent.setup();
    render(<TableHarness initial={[['A', 'B']]} />);
    await selectCell(user);
    expect(
      screen.getByRole('toolbar', { name: '表格工具栏' }),
    ).toBeInTheDocument();

    fireEvent.contextMenu(cellAt(0, 0));
    expect(screen.queryByRole('toolbar')).toBeNull();

    fireEvent.pointerDown(cellAt(0, 0));
    await waitFor(() => {
      expect(
        screen.getByRole('toolbar', { name: '表格工具栏' }),
      ).toBeInTheDocument();
    });
  });

  it('无选区时工具条不存在，对齐不会静默改第一个单元格', () => {
    const { container } = render(<TableHarness initial={[['A', 'B']]} />);
    expect(screen.queryByRole('button', { name: '中对齐' })).toBeNull();
    const first = cellAt(0, 0).closest('td,th') as HTMLElement;
    expect(first.style.textAlign).toBe('left');
    expect(container.querySelector('.zxe-table-align-center')).toBeNull();
  });
});

describe('表格块 · 属性标识默认隐藏（ZX6-PROPS-01）', () => {
  it('默认无工具条；hover 出现表头/对齐/更多，移开消失', async () => {
    const { container } = render(<TableHarness initial={[['A', 'B']]} />);
    const wrap = container.querySelector<HTMLElement>('.zxe-table-wrap');
    expect(wrap).not.toBeNull();
    expect(wrap?.getAttribute('data-meta-visible')).toBe('false');
    expect(screen.queryByRole('toolbar', { name: '表格工具栏' })).toBeNull();

    fireEvent.mouseEnter(wrap!);
    await waitFor(() => {
      expect(wrap?.getAttribute('data-meta-visible')).toBe('true');
    });
    const toolbar = screen.getByRole('toolbar', { name: '表格工具栏' });
    expect(
      within(toolbar).getByRole('button', { name: '表头' }),
    ).toBeInTheDocument();
    expect(
      within(toolbar).getByRole('button', { name: '左对齐' }),
    ).toBeInTheDocument();
    expect(
      within(toolbar).getByRole('button', { name: '更多表格操作' }),
    ).toBeInTheDocument();
    // 表格属性与公式属性不同：不出现公式模式/编辑入口。
    expect(within(toolbar).queryByText('块级')).toBeNull();
    expect(
      within(toolbar).queryByRole('button', { name: '编辑公式' }),
    ).toBeNull();

    fireEvent.mouseLeave(wrap!);
    await waitFor(() => {
      expect(screen.queryByRole('toolbar', { name: '表格工具栏' })).toBeNull();
    });
  });

  it('属性工具条固定定位在视口浮层，hover 前后表格几何位置不变', () => {
    const { container } = render(<TableHarness initial={[['A', 'B']]} />);
    const wrap = container.querySelector<HTMLElement>('.zxe-table-wrap');
    const scroll = container.querySelector<HTMLElement>('.zxe-table-scroll');
    const before = scroll?.getBoundingClientRect().top;

    fireEvent.mouseEnter(wrap!);
    expect(screen.getByRole('toolbar', { name: '表格工具栏' })).toBeVisible();
    expect(scroll?.getBoundingClientRect().top).toBe(before);
    expect(tableCssRule('.zxe-table-toolbar').style.position).toBe('fixed');
  });

  it('键盘 Tab 进入表格对象时工具条浮出，再 Tab 可到达隐藏操作', async () => {
    const user = userEvent.setup();
    const { container } = render(<TableHarness initial={[['A', 'B']]} />);
    const wrap = container.querySelector<HTMLElement>('.zxe-table-wrap');

    await user.tab();
    expect(wrap).toHaveFocus();
    const toolbar = await screen.findByRole('toolbar', {
      name: '表格工具栏',
    });
    expect(toolbar).toBeInTheDocument();

    await user.tab();
    expect(
      within(toolbar).getByRole('button', { name: '表头' }),
    ).toHaveFocus();
  });
});

describe('表格块 · 导出与撤销', () => {
  it('HTML 保留表头、对齐、合并和列宽；Markdown 保留对齐并展开合并', () => {
    const rows: TableCell[][] = [
      [
        {
          text: '模块',
          align: 'left',
          rowSpan: 1,
          colSpan: 2,
          covered: false,
        },
        {
          text: '',
          align: 'left',
          rowSpan: 1,
          colSpan: 1,
          covered: true,
        },
        {
          text: '状态',
          align: 'center',
          rowSpan: 1,
          colSpan: 1,
          covered: false,
        },
      ],
      [
        {
          text: '知识块',
          align: 'right',
          rowSpan: 1,
          colSpan: 1,
          covered: false,
        },
        {
          text: '表格 | 代码',
          align: 'left',
          rowSpan: 1,
          colSpan: 1,
          covered: false,
        },
        {
          text: '进行中',
          align: 'left',
          rowSpan: 1,
          colSpan: 1,
          covered: false,
        },
      ],
    ];
    rows[0][0].table = { header: true, widths: [200, 96, 120] };
    const model = modelOf(rows);
    const html = tableToHtml(model, { className: 'zx-table' });
    expect(html).toContain('<colgroup>');
    expect(html).toContain('<col style="width:200px">');
    expect(html).toContain('<thead>');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('style="text-align:right"');
    expect(html).toContain('scope="col"');

    const markdown = tableToMarkdown(model);
    expect(markdown).toContain('| 模块 | 模块 | 状态 |');
    expect(markdown).toContain('| --- | --- | :--: |');
    expect(markdown).toContain('| 知识块 | 表格 \\| 代码 | 进行中 |');
    expect(markdown).toContain('<!-- 列宽: 200px, 96px, 120px -->');
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('无表头 Markdown 生成空表头行；blocksToHtml 使用同一 HTML 投影', () => {
    const model = modelOf([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    const noHeader = { ...model, header: false };
    const markdown = tableToMarkdown(noHeader, { includeWidths: false });
    expect(markdown.split('\n')[0]).toBe('|  |  |');
    expect(markdown.split('\n')[1]).toBe('| --- | --- |');
    expect(markdown).toContain('| A | B |');
    expect(markdown).toContain('| C | D |');

    const html = blocksToHtml([{ type: 'table', payload: { rows: tablePayloadRows(model) } }]);
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
  });

  it('撤销/重做覆盖表头与结构编辑', async () => {
    const user = userEvent.setup();
    const source = createFakeBlockSource([
      makeBlock({
        id: 'table-history',
        type: 'table',
        payload: {
          rows: [
            ['A', 'B'],
            ['C', 'D'],
          ],
        },
      }),
    ]);
    const { container } = render(
      <NoteBlockEditor
        noteId={FAKE_NOTE_ID}
        source={source}
        saveDelayMs={0}
      />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll('th')).toHaveLength(2);
    });

    await user.click(screen.getByLabelText('第 1 行第 1 列'));
    await user.click(screen.getByRole('button', { name: '表头' }));
    await waitFor(() => {
      expect(container.querySelectorAll('th')).toHaveLength(0);
    });
    await user.click(screen.getByRole('button', { name: '撤销编辑' }));
    await waitFor(() => {
      expect(container.querySelectorAll('th')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: '重做编辑' }));
    await waitFor(() => {
      expect(container.querySelectorAll('th')).toHaveLength(0);
    });

    await user.click(screen.getByLabelText('第 1 行第 1 列'));
    await chooseTableAction(user, '下方插入行');
    await waitFor(() => {
      expect(container.querySelectorAll('tr')).toHaveLength(3);
    });
    await user.click(screen.getByRole('button', { name: '撤销编辑' }));
    await waitFor(() => {
      expect(container.querySelectorAll('tr')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: '重做编辑' }));
    await waitFor(() => {
      expect(container.querySelectorAll('tr')).toHaveLength(3);
    });
  });

  it('导出面板展示 Markdown，并保留列宽可读表示', async () => {
    const user = userEvent.setup();
    render(
      <TableHarness
        initial={[
          ['A', 'B'],
          ['C', 'D'],
        ]}
      />,
    );
    await selectCell(user);
    await chooseTableAction(user, '导出 Markdown');
    const dialog = screen.getByRole('dialog', { name: '表格导出预览' });
    expect(within(dialog).getByText(/\| A \| B \|/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/<!-- 列宽: 140px, 140px -->/),
    ).toBeInTheDocument();
  });

  it('表头关闭时 Markdown 对齐行全部为 ---', () => {
    const rows: TableCell[][] = [
      [
        { text: 'A', align: 'center', rowSpan: 1, colSpan: 1, covered: false },
        { text: 'B', align: 'right', rowSpan: 1, colSpan: 1, covered: false },
      ],
      [
        { text: 'C', align: 'left', rowSpan: 1, colSpan: 1, covered: false },
        { text: 'D', align: 'left', rowSpan: 1, colSpan: 1, covered: false },
      ],
    ];
    rows[0][0].table = { header: false, widths: [140, 140] };
    const markdown = tableToMarkdown(modelOf(rows), {
      includeWidths: false,
    });
    expect(markdown.split('\n')[0]).toBe('|  |  |');
    expect(markdown.split('\n')[1]).toBe('| --- | --- |');
    expect(markdown).toContain('| A | B |');
  });
});

describe('表格块 · 工具条跟随 caret 与边界（ZX7-TOOLBAR-01）', () => {
  type Box = [left: number, top: number, width: number, height: number];
  const initialViewport = {
    width: window.innerWidth,
    height: window.innerHeight,
  };

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: initialViewport.width,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: initialViewport.height,
    });
  });

  function boxRect([left, top, width, height]: Box): DOMRect {
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  function setViewport(width: number, height: number) {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: width,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: height,
    });
  }

  /**
   * jsdom 没有布局；只替换工具条关心的元素矩形，其余保持原实现。
   * cells 以 "row:column" 索引，模拟不同行列在视口中的位置。
   */
  function installGeometry(
    cells: Record<string, Box>,
    table: Box = [0, 80, 640, 240],
    toolbarBox: Box = [0, 0, 220, 34],
  ) {
    const original = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        const element = this as HTMLElement;
        if (element.classList?.contains('zxe-table-toolbar')) {
          return boxRect(toolbarBox);
        }
        if (
          element.classList?.contains('zxe-table-wrap') ||
          element.tagName === 'TABLE'
        ) {
          return boxRect(table);
        }
        const cell = element.closest?.(
          '[data-row][data-column]',
        ) as HTMLElement | null;
        if (cell) {
          const box = cells[`${cell.dataset.row}:${cell.dataset.column}`];
          if (box) {
            return boxRect(box);
          }
        }
        return original.call(this);
      },
    );
  }

  function toolbarElement(): HTMLElement {
    return screen.getByRole('toolbar', { name: '表格工具栏' });
  }

  it('首行聚焦：工具条翻到 caret 行下方，不遮单元格', async () => {
    const user = userEvent.setup();
    installGeometry({ '0:0': [100, 20, 220, 40] });
    render(<TableHarness initial={[['A', 'B']]} />);

    await user.click(cellAt(0, 0));
    const toolbar = toolbarElement();
    await waitFor(() => expect(toolbar.style.top).toBe('66px'));
    expect(toolbar.style.left).toBe('100px');
    expect(toolbar.dataset.side).toBe('bottom');
    expect(toolbar.dataset.positioned).toBe('true');
  });

  it('末行聚焦：工具条翻到 caret 行上方，底边不压 caret', async () => {
    const user = userEvent.setup();
    installGeometry({ '0:0': [100, 700, 220, 40] });
    render(<TableHarness initial={[['A', 'B']]} />);

    await user.click(cellAt(0, 0));
    const toolbar = toolbarElement();
    await waitFor(() => expect(toolbar.style.top).toBe('660px'));
    expect(toolbar.dataset.side).toBe('top');
    expect(700 - 6 - 34).toBe(Number.parseFloat(toolbar.style.top));
  });

  it('首列聚焦：水平夹取到视口安全边距', async () => {
    const user = userEvent.setup();
    installGeometry({ '0:0': [0, 200, 220, 40] });
    render(<TableHarness initial={[['A', 'B']]} />);

    await user.click(cellAt(0, 0));
    const toolbar = toolbarElement();
    await waitFor(() => expect(toolbar.style.left).toBe('8px'));
    expect(toolbar.dataset.positioned).toBe('true');
  });

  it('末列聚焦：右边缘不溢出视口', async () => {
    const user = userEvent.setup();
    installGeometry({ '0:0': [900, 200, 220, 40] });
    render(<TableHarness initial={[['A', 'B']]} />);

    await user.click(cellAt(0, 0));
    const toolbar = toolbarElement();
    await waitFor(() => expect(toolbar.style.left).toBe('796px'));
    expect(796 + 220).toBeLessThanOrEqual(1024 - 8);
  });

  it('390 窄窗：maxWidth 生效，工具条留在视口内', async () => {
    const user = userEvent.setup();
    setViewport(390, 800);
    installGeometry({ '0:0': [280, 200, 100, 32] });
    render(<TableHarness initial={[['A', 'B']]} />);

    await user.click(cellAt(0, 0));
    const toolbar = toolbarElement();
    await waitFor(() => expect(toolbar.style.left).toBe('160px'));
    expect(toolbar.style.maxWidth).toBe('374px');
    expect(Number.parseFloat(toolbar.style.left) + 220).toBeLessThanOrEqual(
      390 - 8,
    );
  });

  it('滚动时重新测量并跟随 caret；滚出视口后隐藏', async () => {
    const user = userEvent.setup();
    const cells: Record<string, Box> = { '0:0': [100, 200, 220, 40] };
    installGeometry(cells);
    render(<TableHarness initial={[['A', 'B']]} />);

    await user.click(cellAt(0, 0));
    const toolbar = toolbarElement();
    await waitFor(() => expect(toolbar.style.top).toBe('160px'));

    cells['0:0'] = [100, 100, 220, 40];
    fireEvent.scroll(window);
    await waitFor(() => expect(toolbar.style.top).toBe('60px'));

    cells['0:0'] = [100, 900, 220, 40];
    fireEvent.scroll(window);
    await waitFor(() => {
      expect(toolbar.dataset.positioned).toBe('false');
      expect(toolbar.style.visibility).toBe('hidden');
    });
  });

  it('失焦或点外部后隐藏，选区不单独维持工具条', async () => {
    const user = userEvent.setup();
    installGeometry({ '0:0': [100, 200, 220, 40] });
    render(<TableHarness initial={[['A', 'B']]} />);

    await user.click(cellAt(0, 0));
    expect(toolbarElement()).toBeInTheDocument();

    await user.click(document.body);
    await waitFor(() => {
      expect(screen.queryByRole('toolbar')).toBeNull();
    });
  });

  it('右键菜单打开时不叠加，菜单关闭后随焦点恢复', async () => {
    const user = userEvent.setup();
    installGeometry({ '0:0': [100, 200, 220, 40] });
    render(<TableHarness initial={[['A', 'B']]} />);

    await user.click(cellAt(0, 0));
    expect(toolbarElement()).toBeInTheDocument();
    fireEvent.contextMenu(cellAt(0, 0));
    expect(screen.queryByRole('toolbar')).toBeNull();

    fireEvent.pointerDown(cellAt(0, 0));
    await waitFor(() => expect(toolbarElement()).toBeInTheDocument());
  });

  it('Alt+F10 进入工具条，Esc 回到当前单元格', async () => {
    const user = userEvent.setup();
    installGeometry({ '0:0': [100, 200, 220, 40] });
    render(<TableHarness initial={[['A', 'B']]} />);

    await user.click(cellAt(0, 0));
    const toolbar = toolbarElement();
    fireEvent.keyDown(cellAt(0, 0), { key: 'F10', altKey: true });
    expect(
      within(toolbar).getByRole('button', { name: '表头' }),
    ).toHaveFocus();

    fireEvent.keyDown(toolbar, { key: 'Escape' });
    expect(cellAt(0, 0)).toHaveFocus();
  });
});
