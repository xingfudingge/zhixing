/**
 * ZX7-MENU-01：编辑器块级右键菜单重设计。
 *
 * 覆盖：正文 / 表格 / 公式 / 图片·文件 / 空白五套菜单互不相同；
 * 菜单文案全部来自 `menu.*` key；分组/分隔线/快捷键/禁用原因/危险项；
 * 子菜单（插入 / 导出 / 缩放）与 Arrow/Enter/Escape 键盘；
 * Escape 与执行命令后焦点归还来源块；只读只保留安全项；右下角 clamp。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { menuCatalog } from '../../../i18n/menu';
import { restoreSelectionByOffsets } from '../inline';
import { NoteBlockEditor } from '../NoteBlockEditor';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
  type FakeBlockSource,
} from './fakeBlockSource';

function seedEditor() {
  return createFakeBlockSource([
    makeBlock({
      id: 'b1',
      type: 'paragraph',
      payload: { runs: [{ text: '右键这句话试试' }] },
    }),
    makeBlock({
      id: 'b2',
      type: 'table',
      payload: {
        header: false,
        rows: [
          ['A', 'B'],
          ['C', 'D'],
        ],
      },
    }),
    makeBlock({
      id: 'b3',
      type: 'formula',
      payload: { latex: 'x^2', display: 'block', renderer: 'none' },
    }),
    makeBlock({
      id: 'b4',
      type: 'file',
      payload: {
        attachmentId: 'att-image',
        fileName: '示意图.png',
        byteSize: 2048,
        mime: 'image/png',
        status: 'local',
      },
    }),
  ]);
}

function renderEditor(
  source: FakeBlockSource,
  options: { initialReadOnly?: boolean } = {},
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

async function openTextMenu() {
  const textbox = (
    await screen.findAllByRole('textbox', { name: '正文' })
  )[0];
  fireEvent.contextMenu(textbox, { clientX: 120, clientY: 140 });
  return { textbox, menu: await screen.findByRole('menu', { name: '文本菜单' }) };
}

function closeMenu() {
  fireEvent.keyDown(document, { key: 'Escape' });
}

function menuLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.kn-menu-label')).map(
    (node) => node.textContent ?? '',
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('编辑器右键菜单 · 上下文矩阵', () => {
  it('正文 / 表格 / 公式 / 图片 / 空白给出不同菜单项', async () => {
    const source = seedEditor();
    const { container } = renderEditor(source);

    const { textbox, menu: textMenu } = await openTextMenu();
    expect(
      within(textMenu).getByRole('menuitem', { name: /加粗/ }),
    ).toBeInTheDocument();
    expect(
      within(textMenu).getByRole('menuitem', { name: /转为待办/ }),
    ).toBeInTheDocument();
    expect(
      within(textMenu).queryByRole('menuitem', { name: /插入公式/ }),
    ).toBeNull();
    expect(
      within(textMenu).getByRole('menuitem', { name: /插入/ }),
    ).toHaveAttribute('aria-haspopup', 'menu');
    expect(
      within(textMenu).queryByRole('menuitem', { name: /合并选区/ }),
    ).toBeNull();
    expect(
      within(textMenu).queryByRole('menuitem', { name: /上方插入行/ }),
    ).toBeNull();

    // 插入是子菜单：展开后才出现表格/公式/代码块/分割线。
    const insertParent = within(textMenu).getByRole('menuitem', {
      name: /插入/,
    });
    fireEvent.click(insertParent);
    const insertMenu = await screen.findByRole('menu', { name: '插入' });
    expect(
      within(insertMenu).getByRole('menuitem', { name: /公式/ }),
    ).toBeInTheDocument();
    expect(
      within(insertMenu).getByRole('menuitem', { name: /分割线/ }),
    ).toBeInTheDocument();
    fireEvent.keyDown(insertMenu, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: '插入' })).toBeNull(),
    );

    closeMenu();
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(textbox);
    });

    const tableCell = screen.getByLabelText('第 1 行第 1 列');
    fireEvent.contextMenu(tableCell, { clientX: 200, clientY: 240 });
    const tableMenu = await screen.findByRole('menu', { name: '表格菜单' });
    expect(
      within(tableMenu).getByRole('menuitem', { name: /合并选区/ }),
    ).toBeInTheDocument();
    expect(
      within(tableMenu).getByRole('menuitem', { name: /上方插入行/ }),
    ).toBeInTheDocument();
    expect(
      within(tableMenu).getByRole('menuitemradio', { name: /左对齐/ }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      within(tableMenu).getByRole('menuitemcheckbox', { name: /表头/ }),
    ).toHaveAttribute('aria-checked', 'false');
    expect(
      within(tableMenu).queryByRole('menuitem', { name: /导出 Markdown/ }),
    ).toBeNull();
    const exportParent = within(tableMenu).getByRole('menuitem', {
      name: /导出/,
    });
    fireEvent.click(exportParent);
    const exportMenu = await screen.findByRole('menu', { name: '导出' });
    expect(
      within(exportMenu).getByRole('menuitem', { name: /Markdown/ }),
    ).toBeInTheDocument();
    expect(
      within(exportMenu).getByRole('menuitem', { name: /HTML/ }),
    ).toBeInTheDocument();
    fireEvent.keyDown(exportMenu, { key: 'Escape' });
    closeMenu();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    const formula = container.querySelector<HTMLElement>('.zxe-formula');
    expect(formula).not.toBeNull();
    fireEvent.contextMenu(
      formula!.querySelector('.zxe-formula-preview') as Element,
      { clientX: 220, clientY: 300 },
    );
    const formulaMenu = await screen.findByRole('menu', { name: '公式菜单' });
    expect(
      within(formulaMenu).getByRole('menuitem', { name: /编辑公式/ }),
    ).toBeInTheDocument();
    expect(
      within(formulaMenu).getByRole('menuitem', { name: /复制 LaTeX/ }),
    ).toBeInTheDocument();
    expect(
      within(formulaMenu).queryByRole('menuitem', { name: /重置缩放/ }),
    ).toBeNull();
    fireEvent.click(
      within(formulaMenu).getByRole('menuitem', { name: /缩放/ }),
    );
    const zoomMenu = await screen.findByRole('menu', { name: '缩放' });
    expect(
      within(zoomMenu).getByRole('menuitem', { name: /重置缩放/ }),
    ).toBeInTheDocument();
    fireEvent.keyDown(zoomMenu, { key: 'Escape' });
    closeMenu();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    const fileCard = container.querySelector<HTMLElement>('.zxe-filecard');
    expect(fileCard).not.toBeNull();
    fireEvent.contextMenu(fileCard as Element, {
      clientX: 260,
      clientY: 380,
    });
    const imageMenu = await screen.findByRole('menu', { name: '图片菜单' });
    expect(
      within(imageMenu).getByRole('menuitem', { name: /预览图片/ }),
    ).toBeInTheDocument();
    expect(
      within(imageMenu).getByRole('menuitem', { name: /另存为…/ }),
    ).toBeInTheDocument();
    expect(
      within(imageMenu).getByRole('menuitem', { name: /删除文件卡/ }),
    ).toBeInTheDocument();
    expect(
      within(imageMenu).queryByRole('menuitem', { name: /加粗/ }),
    ).toBeNull();
    closeMenu();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    const body = container.querySelector<HTMLElement>('.zxe-body');
    fireEvent.contextMenu(body as Element, { clientX: 240, clientY: 360 });
    const blankMenu = await screen.findByRole('menu', { name: '空白菜单' });
    expect(
      within(blankMenu).getByRole('menuitem', { name: /新建段落/ }),
    ).toBeInTheDocument();
    expect(
      within(blankMenu).queryByRole('menuitem', { name: /插入分割线/ }),
    ).toBeNull();
    expect(
      within(blankMenu).queryByRole('menuitem', { name: /剪切/ }),
    ).toBeNull();
  });

  it('所有菜单文案都来自 menu.* key，无英文硬编码', async () => {
    const source = seedEditor();
    const { container } = renderEditor(source);
    const menuValues = new Set<string>(Object.values(menuCatalog));

    const check = (menu: HTMLElement) => {
      for (const label of menuLabels(menu)) {
        expect(menuValues.has(label)).toBe(true);
      }
    };

    const { menu: textMenu } = await openTextMenu();
    check(textMenu);
    closeMenu();

    const tableCell = screen.getByLabelText('第 1 行第 1 列');
    fireEvent.contextMenu(tableCell, { clientX: 200, clientY: 240 });
    check(await screen.findByRole('menu', { name: '表格菜单' }));
    closeMenu();

    const formula = container.querySelector<HTMLElement>('.zxe-formula');
    fireEvent.contextMenu(
      formula!.querySelector('.zxe-formula-preview') as Element,
      { clientX: 220, clientY: 300 },
    );
    check(await screen.findByRole('menu', { name: '公式菜单' }));
    closeMenu();

    const fileCard = container.querySelector<HTMLElement>('.zxe-filecard');
    fireEvent.contextMenu(fileCard as Element, {
      clientX: 260,
      clientY: 380,
    });
    check(await screen.findByRole('menu', { name: '图片菜单' }));
    closeMenu();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('键盘：方向键/Home/End、→ 展开子菜单、← 收起、Escape 归还焦点', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        payload: { runs: [{ text: '保留选区测试' }] },
      }),
    ]);
    renderEditor(source);
    const textbox = await screen.findByRole('textbox', { name: '正文' });
    act(() => {
      restoreSelectionByOffsets(textbox, 0, 2);
    });
    fireEvent.mouseUp(textbox);
    fireEvent.contextMenu(textbox, { clientX: 120, clientY: 140 });
    const menu = await screen.findByRole('menu', { name: '文本菜单' });
    expect(window.getSelection()?.toString()).toBe('保留');

    // 指针打开时不抢焦点；方向键才进入菜单。
    const usable = within(menu)
      .getAllByRole('menuitem')
      .filter(
        (item) =>
          !item.hasAttribute('disabled') &&
          item.getAttribute('aria-disabled') !== 'true',
      );
    expect(document.activeElement).not.toBe(usable[0]);
    fireEvent.keyDown(document, { key: 'End' });
    expect(document.activeElement).toBe(usable[usable.length - 1]);
    fireEvent.keyDown(document, { key: 'Home' });
    expect(document.activeElement).toBe(usable[0]);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(usable[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(usable[1]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(usable[0]);

    // → 打开“插入”子菜单并聚焦第一项；← 收起并回到父项。
    const insertParent = within(menu).getByRole('menuitem', { name: /插入/ });
    insertParent.focus();
    fireEvent.keyDown(insertParent, { key: 'ArrowRight' });
    const submenu = await screen.findByRole('menu', { name: '插入' });
    await waitFor(() => {
      expect(
        submenu.contains(document.activeElement),
      ).toBe(true);
    });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: '插入' })).toBeNull();
    });
    await waitFor(() => expect(document.activeElement).toBe(insertParent));

    closeMenu();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(textbox));
    expect(window.getSelection()?.toString()).toBe('保留');
  });

  it('Enter 执行当前菜单项', async () => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    const { container } = renderEditor(source);
    await screen.findByRole('textbox', { name: '正文' });
    const body = container.querySelector<HTMLElement>('.zxe-body');
    fireEvent.contextMenu(body as Element, { clientX: 240, clientY: 360 });
    const menu = await screen.findByRole('menu', { name: '空白菜单' });
    const item = within(menu).getByRole('menuitem', { name: /新建待办/ });
    item.focus();
    fireEvent.keyDown(item, { key: 'Enter' });
    await waitFor(() => {
      expect(
        container
          .querySelector('[data-block-id]')
          ?.getAttribute('data-block-type'),
      ).toBe('todo');
    });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('表格右键 Escape 把焦点与 caret 归还来源单元格', async () => {
    const source = seedEditor();
    renderEditor(source);
    await screen.findAllByRole('textbox', { name: '正文' });
    const cell = screen.getByLabelText('第 1 行第 1 列') as HTMLInputElement;
    cell.focus();
    fireEvent.contextMenu(cell, { clientX: 200, clientY: 240 });
    const menu = await screen.findByRole('menu', { name: '表格菜单' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(menu.contains(document.activeElement)).toBe(true);
    closeMenu();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(cell));
  });

  it('图片菜单 Escape 把焦点归还文件卡名称', async () => {
    const source = seedEditor();
    const { container } = renderEditor(source);
    await screen.findAllByRole('textbox', { name: '正文' });
    const name = container.querySelector<HTMLButtonElement>(
      '.zxe-filecard-name',
    );
    expect(name).not.toBeNull();
    fireEvent.contextMenu(container.querySelector('.zxe-filecard') as Element, {
      clientX: 260,
      clientY: 380,
    });
    await screen.findByRole('menu', { name: '图片菜单' });
    closeMenu();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(name));
  });

  it('Tab 与点击外部都能关闭菜单', async () => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    const { container } = renderEditor(source);
    const textbox = await screen.findByRole('textbox', { name: '正文' });

    fireEvent.contextMenu(textbox, { clientX: 120, clientY: 140 });
    const first = await screen.findByRole('menu', { name: '文本菜单' });
    fireEvent.keyDown(first, { key: 'Tab' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    fireEvent.contextMenu(textbox, { clientX: 120, clientY: 140 });
    const second = await screen.findByRole('menu', { name: '文本菜单' });
    // 外点关闭监听在 effect 后异步挂载，等一个宏任务再点击。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.pointerDown(container.querySelector('.zxe-body') as Element);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(second).not.toBeInTheDocument();
  });

  it('表格动作可用：上方插入行与合并选区都落到块数据', async () => {
    const user = userEvent.setup();
    const source = seedEditor();
    const { container } = renderEditor(source);
    await screen.findAllByRole('textbox', { name: '正文' });

    const cell = screen.getByLabelText('第 1 行第 1 列');
    fireEvent.contextMenu(cell, { clientX: 200, clientY: 240 });
    const menu = await screen.findByRole('menu', { name: '表格菜单' });
    await user.click(
      within(menu).getByRole('menuitem', { name: /上方插入行/ }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('第 3 行第 1 列')).toBeInTheDocument();
    });

    // 拖选 2 个单元格后右键：菜单应保持选区并允许合并。
    const firstTd = cell.closest('td') as HTMLElement;
    const secondTd = screen
      .getByLabelText('第 1 行第 2 列')
      .closest('td') as HTMLElement;
    fireEvent.mouseDown(firstTd, { button: 0 });
    fireEvent.mouseEnter(secondTd);
    fireEvent.mouseUp(window);
    fireEvent.contextMenu(screen.getByLabelText('第 1 行第 2 列'), {
      clientX: 240,
      clientY: 260,
    });
    const mergeMenu = await screen.findByRole('menu', { name: '表格菜单' });
    const merge = within(mergeMenu).getByRole('menuitem', {
      name: /合并选区/,
    });
    expect(merge).not.toHaveAttribute('aria-disabled', 'true');
    await user.click(merge);
    await waitFor(() => {
      expect(
        container.querySelector('td[colspan="2"], th[colspan="2"]'),
      ).not.toBeNull();
    });
  });

  it('多选块右键作用于整个块选区', async () => {
    const source = seedEditor();
    const { container } = renderEditor(source);
    const textbox = (
      await screen.findAllByRole('textbox', { name: '正文' })
    )[0];
    fireEvent.keyDown(textbox, { key: 'a', metaKey: true, shiftKey: true });
    await waitFor(() => {
      expect(container.querySelector('.zxe-selectionbar')).not.toBeNull();
    });
    const count = container.querySelectorAll('[data-block-id]').length;
    expect(count).toBeGreaterThan(1);

    fireEvent.contextMenu(textbox, { clientX: 120, clientY: 140 });
    const menu = await screen.findByRole('menu', { name: '块选择菜单' });
    expect(
      within(menu).getByRole('menuitem', {
        name: new RegExp(`删除 ${count} 个块`),
      }),
    ).toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: /加粗/ }),
    ).toBeNull();
  });

  it('文本加粗与公式显示模式都直接落到块数据', async () => {
    const user = userEvent.setup();
    const source = seedEditor();
    const { container } = renderEditor(source);
    await screen.findAllByRole('textbox', { name: '正文' });
    const textbox = screen.getAllByRole('textbox', { name: '正文' })[0];
    act(() => {
      restoreSelectionByOffsets(textbox, 0, 2);
    });
    fireEvent.mouseUp(textbox);
    fireEvent.contextMenu(textbox, { clientX: 120, clientY: 140 });
    const textMenu = await screen.findByRole('menu', { name: '文本菜单' });
    await user.click(within(textMenu).getByRole('menuitem', { name: /加粗/ }));
    await waitFor(() => {
      expect(textbox.innerHTML).toContain('<strong>右键</strong>');
    });

    const formula = container.querySelector<HTMLElement>('.zxe-formula');
    fireEvent.contextMenu(
      formula!.querySelector('.zxe-formula-preview') as Element,
      { clientX: 220, clientY: 300 },
    );
    const formulaMenu = await screen.findByRole('menu', { name: '公式菜单' });
    await user.click(
      within(formulaMenu).getByRole('menuitem', { name: /切换为行内/ }),
    );
    await waitFor(() => {
      expect(container.querySelector('.zxe-formula')).toHaveAttribute(
        'data-display',
        'inline',
      );
    });
  });

  it('公式 textarea 与表格文字选区保留原生菜单', async () => {
    const user = userEvent.setup();
    const source = seedEditor();
    const { container } = renderEditor(source);

    const formula = await screen.findByRole('group', { name: '公式块' });
    // 属性条默认隐藏，hover 公式块后才出现显式编辑入口（ZX6-PROPS-01）。
    fireEvent.mouseEnter(formula);
    // 公式属性条 portal 到 body（ZX7-TOOLBAR-01），不再在公式块容器内。
    const formulaToolbar = await screen.findByRole('toolbar', {
      name: '公式属性',
    });
    await user.click(
      within(formulaToolbar).getByRole('button', { name: '编辑公式' }),
    );
    const textarea = await screen.findByRole('textbox', { name: 'LaTeX 源' });
    fireEvent.contextMenu(textarea, { clientX: 100, clientY: 100 });
    expect(screen.queryByRole('menu', { name: '公式菜单' })).toBeNull();

    // 关闭公式编辑，避免两个块菜单状态互相影响。
    await user.keyboard('{Escape}');
    const tableCell = screen.getByLabelText('第 1 行第 1 列');
    (tableCell as HTMLInputElement).setSelectionRange(0, 1);
    fireEvent.contextMenu(tableCell, { clientX: 200, clientY: 240 });
    expect(screen.queryByRole('menu', { name: '表格菜单' })).toBeNull();
    expect(container.querySelector('.zxe-context-menu')).toBeNull();
  });

  it('只读模式只保留复制/全选等安全项', async () => {
    const source = seedEditor();
    const { container } = renderEditor(source, { initialReadOnly: true });
    await screen.findAllByRole('textbox', { name: '正文' });

    const textbox = screen.getAllByRole('textbox', { name: '正文' })[0];
    fireEvent.contextMenu(textbox, { clientX: 120, clientY: 140 });
    const textMenu = await screen.findByRole('menu', { name: '文本菜单' });
    expect(
      within(textMenu).getByRole('menuitem', { name: /复制/ }),
    ).toBeInTheDocument();
    expect(
      within(textMenu).getByRole('menuitem', { name: /全选/ }),
    ).toBeInTheDocument();
    expect(
      within(textMenu).queryByRole('menuitem', { name: /剪切/ }),
    ).toBeNull();
    expect(
      within(textMenu).queryByRole('menuitem', { name: /删除块/ }),
    ).toBeNull();
    closeMenu();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    const formula = container.querySelector<HTMLElement>('.zxe-formula');
    fireEvent.contextMenu(
      formula!.querySelector('.zxe-formula-preview') as Element,
      { clientX: 200, clientY: 300 },
    );
    const formulaMenu = await screen.findByRole('menu', { name: '公式菜单' });
    expect(
      within(formulaMenu).queryByRole('menuitem', { name: /编辑公式/ }),
    ).toBeNull();
    expect(
      within(formulaMenu).getByRole('menuitem', { name: /复制 LaTeX/ }),
    ).toBeInTheDocument();

    const tableTd = container.querySelector<HTMLElement>(
      '.zxe-table tbody td',
    ) as HTMLElement;
    fireEvent.contextMenu(tableTd, { clientX: 200, clientY: 240 });
    const tableMenu = await screen.findByRole('menu', { name: '表格菜单' });
    expect(
      within(tableMenu).queryByRole('menuitem', { name: /上方插入行/ }),
    ).toBeNull();
    expect(
      within(tableMenu).getByRole('menuitem', { name: /复制整表/ }),
    ).toBeInTheDocument();
  });

  it('禁用项保留 aria-disabled 与原因，危险项有独立样式', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        payload: { runs: [{ text: '不选中文字' }] },
      }),
    ]);
    renderEditor(source);
    const textbox = await screen.findByRole('textbox', { name: '正文' });
    fireEvent.contextMenu(textbox, { clientX: 120, clientY: 140 });
    const menu = await screen.findByRole('menu', { name: '文本菜单' });

    const cut = within(menu).getByRole('menuitem', { name: /剪切/ });
    expect(cut).toHaveAttribute('aria-disabled', 'true');
    const describedBy = cut.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      '先选中文字',
    );

    const danger = within(menu).getByRole('menuitem', { name: /删除块/ });
    expect(danger.className).toContain('is-danger');
    expect(danger).toHaveClass('is-danger');
  });

  it('右下角打开时菜单被 clamp 在视口内', async () => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    const { container } = renderEditor(source);
    await screen.findByRole('textbox', { name: '正文' });

    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        width: 248,
        height: 400,
        top: 0,
        left: 0,
        right: 248,
        bottom: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
    const body = container.querySelector<HTMLElement>('.zxe-body');
    fireEvent.contextMenu(body as Element, {
      clientX: window.innerWidth - 10,
      clientY: window.innerHeight - 10,
    });
    const menu = await screen.findByRole('menu', { name: '空白菜单' });
    expect(menu.style.left).toBe(`${window.innerWidth - 248 - 8}px`);
    expect(menu.style.top).toBe(`${window.innerHeight - 400 - 8}px`);
    rectSpy.mockRestore();
  });
});
