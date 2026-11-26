import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BoardContextMenu } from '../BoardContextMenu';
import { sampleDocument } from '../../__tests__/fakeBoardSource';
import type { BoardSelection } from '../../types';

function props(
  selection: BoardSelection,
  target: { kind: 'canvas' } | { kind: 'node'; nodeId: string } | { kind: 'edge'; edgeId: string } = { kind: 'canvas' },
) {
  return {
    state: { x: 120, y: 80, target },
    document: sampleDocument(),
    selection,
    clipboardAvailable: false,
    canUndo: false,
    canRedo: false,
    onClose: vi.fn(),
    onCopy: vi.fn(),
    onPaste: vi.fn(),
    onSelectAll: vi.fn(),
    onFit: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onLayer: vi.fn(),
    onToggleLock: vi.fn(),
    onDelete: vi.fn(),
    onAlign: vi.fn(),
    onDistribute: vi.fn(),
    onReverseEdge: vi.fn(),
    onChangeEdgeStyle: vi.fn(),
  };
}

describe('画板右键菜单', () => {
  it('空白菜单：粘贴/撤销/重做按状态禁用，点击全选与适配视图', async () => {
    const user = userEvent.setup();
    const input = props({ nodeIds: [], edgeIds: [] });
    render(<BoardContextMenu {...input} />);

    expect(screen.getByRole('menu', { name: '画板右键菜单' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^粘贴/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: /^撤销/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: /^重做/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await user.click(screen.getByRole('menuitem', { name: /^全选/ }));
    expect(input.onSelectAll).toHaveBeenCalled();
    expect(input.onClose).toHaveBeenCalled();
    await user.click(screen.getByRole('menuitem', { name: /^适配视图/ }));
    expect(input.onFit).toHaveBeenCalled();
  });

  it('节点菜单：复制、四档层级、锁定/解锁与删除', async () => {
    const user = userEvent.setup();
    const input = props(
      { nodeIds: ['n-a'], edgeIds: [] },
      { kind: 'node', nodeId: 'n-a' },
    );
    render(<BoardContextMenu {...input} />);

    await user.click(screen.getByRole('menuitem', { name: /^复制/ }));
    expect(input.onCopy).toHaveBeenCalled();
    // 节点菜单只保留“层级”子菜单，不再平铺四档层级。
    expect(
      screen.queryByRole('menuitem', { name: '置顶' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /^层级/ }));
    for (const label of ['置顶', '上移一层', '下移一层', '置底']) {
      await user.click(screen.getByRole('menuitem', { name: label }));
    }
    expect(input.onLayer.mock.calls.map((call) => call[0])).toEqual([
      'front',
      'up',
      'down',
      'back',
    ]);
    await user.click(screen.getByRole('menuitem', { name: '锁定' }));
    expect(input.onToggleLock).toHaveBeenCalled();
    await user.click(screen.getByRole('menuitem', { name: /^删除/ }));
    expect(input.onDelete).toHaveBeenCalled();
  });

  it('多选菜单：对齐/等距/层级/批量线型与删除', async () => {
    const user = userEvent.setup();
    const input = props(
      { nodeIds: ['n-a', 'n-b', 'n-c'], edgeIds: ['e-a'] },
      { kind: 'node', nodeId: 'n-a' },
    );
    render(<BoardContextMenu {...input} />);
    expect(
      screen.getByText('已选 3 个对象 · 1 条连线'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: /^对齐/ }));
    await user.click(screen.getByRole('menuitem', { name: '右对齐' }));
    expect(input.onAlign).toHaveBeenCalledWith('right');

    await user.click(screen.getByRole('menuitem', { name: /^等距/ }));
    await user.click(screen.getByRole('menuitem', { name: '水平等距' }));
    expect(input.onDistribute).toHaveBeenCalledWith('x');

    await user.click(screen.getByRole('menuitem', { name: /^层级/ }));
    await user.click(screen.getByRole('menuitem', { name: '上移一层' }));
    expect(input.onLayer).toHaveBeenCalledWith('up');

    await user.click(screen.getByRole('menuitem', { name: /^线型/ }));
    await user.click(screen.getByRole('menuitemradio', { name: '直线' }));
    expect(input.onChangeEdgeStyle).toHaveBeenCalledWith({
      routing: 'straight',
    });

    await user.click(screen.getByRole('menuitem', { name: /^删除选中（4）/ }));
    expect(input.onDelete).toHaveBeenCalled();
  });

  it('连线菜单：单条可反向，批量只显示线型与删除', async () => {
    const user = userEvent.setup();
    const single = props(
      { nodeIds: [], edgeIds: ['e-a'] },
      { kind: 'edge', edgeId: 'e-a' },
    );
    render(<BoardContextMenu {...single} />);
    expect(screen.getByText('已选 1 条连线')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /^反向/ }));
    expect(single.onReverseEdge).toHaveBeenCalled();
    await user.click(screen.getByRole('menuitem', { name: /^线型/ }));
    await user.click(screen.getByRole('menuitemradio', { name: '曲线' }));
    expect(single.onChangeEdgeStyle).toHaveBeenCalledWith({ routing: 'curve' });
  });

  it('Escape 关闭菜单', () => {
    const input = props({ nodeIds: [], edgeIds: [] });
    render(<BoardContextMenu {...input} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(input.onClose).toHaveBeenCalledWith('escape');
  });
});
