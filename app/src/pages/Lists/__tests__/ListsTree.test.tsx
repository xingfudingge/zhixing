import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { List } from '../../../data/db/types';
import { ListsTree, type ListTreeAction } from '../ListsTree';
import {
  LISTS_COLLAPSED_STORAGE_KEY,
  useCollapsedLists,
} from '../useCollapsedLists';

function list(overrides: Partial<List> & Pick<List, 'id' | 'name'>): List {
  return {
    spaceId: 'personal',
    color: '#5579d5',
    icon: '',
    parentId: null,
    sortOrder: 10,
    isInbox: false,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

const lists: List[] = [
  list({ id: 'inbox', name: '收件箱', isInbox: true, sortOrder: 0 }),
  list({ id: 'work', name: '工作', sortOrder: 10 }),
  list({ id: 'life', name: '生活', sortOrder: 20 }),
  list({ id: 'project', name: '项目 A', parentId: 'work', sortOrder: 10 }),
];

function rowOf(name: RegExp): HTMLElement {
  const link = screen.getByRole('link', { name });
  const row = link.closest<HTMLElement>('[data-list-row]');
  if (!row) {
    throw new Error('找不到清单行');
  }
  return row;
}

function renderTree(onMove = vi.fn(), onAction?: (action: ListTreeAction, list: List) => void) {
  render(
    <MemoryRouter>
      <ListsTree
        variant="sidebar"
        lists={lists}
        counts={new Map()}
        collapsed={new Set()}
        onToggle={() => undefined}
        onMove={onMove}
        onAction={onAction}
      />
    </MemoryRouter>,
  );
  return onMove;
}

function drag(
  source: HTMLElement,
  target: HTMLElement,
  ratio: number,
  pointerId = 1,
) {
  const rect = {
    top: 0,
    height: 100,
    bottom: 100,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(rect);
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => target,
  });

  fireEvent.pointerDown(source, {
    pointerId,
    pointerType: 'mouse',
    button: 0,
    isPrimary: true,
    clientX: 10,
    clientY: 10,
  });
  fireEvent.pointerMove(window, {
    pointerId,
    clientX: 10,
    clientY: 10 + ratio * 100,
  });
  fireEvent.pointerUp(window, {
    pointerId,
    clientX: 10,
    clientY: 10 + ratio * 100,
  });
}

describe('ListsTree 侧栏交互', () => {
  beforeEach(() => {
    window.localStorage.removeItem(LISTS_COLLAPSED_STORAGE_KEY);
  });

  it('点击节点菜单把操作交给上层（新建子清单 / 编辑 / 移动 / 删除）', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderTree(vi.fn(), onAction);

    await user.click(screen.getByRole('button', { name: '清单操作：项目 A' }));
    await user.click(
      await screen.findByRole('menuitem', { name: '新建子清单' }),
    );
    expect(onAction).toHaveBeenLastCalledWith(
      'create-child',
      expect.objectContaining({ id: 'project' }),
    );

    await user.click(screen.getByRole('button', { name: '清单操作：项目 A' }));
    await user.click(await screen.findByRole('menuitem', { name: '编辑清单' }));
    expect(onAction).toHaveBeenLastCalledWith(
      'edit',
      expect.objectContaining({ id: 'project' }),
    );

    await user.click(screen.getByRole('button', { name: '清单操作：项目 A' }));
    await user.click(await screen.findByRole('menuitem', { name: '移动到…' }));
    expect(onAction).toHaveBeenLastCalledWith(
      'move',
      expect.objectContaining({ id: 'project' }),
    );

    await user.click(screen.getByRole('button', { name: '清单操作：项目 A' }));
    await user.click(await screen.findByRole('menuitem', { name: '删除清单' }));
    expect(onAction).toHaveBeenLastCalledWith(
      'delete',
      expect.objectContaining({ id: 'project' }),
    );
  });

  it('当前清单行带选中态，链接指向深链', () => {
    render(
      <MemoryRouter>
        <ListsTree
          variant="sidebar"
          lists={lists}
          counts={new Map()}
          activeListId="project"
          collapsed={new Set()}
          onToggle={() => undefined}
        />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: /项目 A/ });
    expect(link).toHaveAttribute('href', '/lists/project');
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(rowOf(/^项目 A/)).toHaveClass('is-active');
  });

  it('折叠状态持久化，跳转子清单自动展开祖先', async () => {
    const user = userEvent.setup();

    function CollapsedSidebar({ activeListId }: { activeListId?: string }) {
      const { collapsed, toggle } = useCollapsedLists(lists, activeListId);
      return (
        <ListsTree
          variant="sidebar"
          lists={lists}
          counts={new Map()}
          activeListId={activeListId ?? null}
          collapsed={collapsed}
          onToggle={toggle}
        />
      );
    }

    const view = render(
      <MemoryRouter>
        <CollapsedSidebar />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: '折叠 工作' }));
    expect(
      screen.queryByRole('link', { name: /项目 A/ }),
    ).not.toBeInTheDocument();
    expect(
      JSON.parse(
        window.localStorage.getItem(LISTS_COLLAPSED_STORAGE_KEY) ?? '[]',
      ),
    ).toContain('work');

    view.unmount();
    window.localStorage.setItem(
      LISTS_COLLAPSED_STORAGE_KEY,
      JSON.stringify(['work']),
    );
    render(
      <MemoryRouter>
        <CollapsedSidebar activeListId="project" />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('link', { name: /项目 A/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '折叠 工作' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

describe('ListsTree 指针拖拽', () => {
  it('拖到目标行上 1/4，成为同级前一项并写入小数顺序', () => {
    const onMove = renderTree();
    drag(rowOf(/^工作/), rowOf(/^生活/), 0.1);

    expect(onMove).toHaveBeenCalledWith('work', null, 10);
  });

  it('拖到目标行中部，成为子清单', () => {
    const onMove = renderTree();
    drag(rowOf(/^工作/), rowOf(/^生活/), 0.5);

    expect(onMove).toHaveBeenCalledWith('work', 'life', 10);
  });

  it('拒绝把父清单拖进自己的子清单', () => {
    const onMove = renderTree();
    drag(rowOf(/^工作/), rowOf(/^项目 A/), 0.5);

    expect(onMove).not.toHaveBeenCalled();
  });

  it('拖到树空白处成为根级最后一项', () => {
    const onMove = renderTree();
    const source = rowOf(/^工作/);
    const tree = document.querySelector<HTMLElement>('[data-list-tree]');
    if (!tree) throw new Error('找不到树容器');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => tree,
    });

    fireEvent.pointerDown(source, {
      pointerId: 9,
      pointerType: 'mouse',
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 40, clientY: 200 });
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 40, clientY: 200 });

    expect(onMove).toHaveBeenCalledWith('work', null, 30);
  });

  it('清单树不渲染系统收件箱行', () => {
    renderTree();

    expect(
      screen.queryByRole('link', { name: /^收件箱/ }),
    ).not.toBeInTheDocument();
  });

  it('Esc 取消拖拽，不写入落点', () => {
    const onMove = renderTree();
    const source = rowOf(/^工作/);
    const target = rowOf(/^生活/);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      height: 100,
      bottom: 100,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => target,
  });

    fireEvent.pointerDown(source, {
      pointerId: 7,
      pointerType: 'mouse',
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 10, clientY: 60 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 10, clientY: 60 });

    expect(onMove).not.toHaveBeenCalled();
  });
});
