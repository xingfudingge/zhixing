import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BoardInspector } from '../BoardInspector';
import { sampleDocument } from '../../__tests__/fakeBoardSource';
import type { BoardSelection } from '../../types';

function props(selection: BoardSelection) {
  return {
    document: sampleDocument(),
    selection,
    readOnly: false,
    focusLabelToken: 0,
    onChangeObjectStyle: vi.fn(),
    onChangeObjectType: vi.fn(),
    onAlign: vi.fn(),
    onDistribute: vi.fn(),
    onDuplicate: vi.fn(),
    onLayer: vi.fn(),
    onToggleLock: vi.fn(),
    onDelete: vi.fn(),
    onChangeEdgeStyle: vi.fn(),
    onChangeEdgeLabel: vi.fn(),
    onReverseEdge: vi.fn(),
  };
}

describe('画板检查器', () => {
  it('未选中时给出检查器说明，不伪装可编辑字段', () => {
    render(<BoardInspector {...props({ nodeIds: [], edgeIds: [] })} />);
    expect(screen.getByRole('heading', { name: '检查器' })).toBeInTheDocument();
    expect(screen.getByText(/选中对象后可改形状/)).toBeInTheDocument();
  });

  it('单选对象：形状、填充、字号、加粗、对齐、锁定与层级操作', async () => {
    const user = userEvent.setup();
    const input = props({ nodeIds: ['n-a'], edgeIds: [] });
    render(<BoardInspector {...input} />);
    expect(screen.getByRole('heading', { name: '胶囊' })).toBeInTheDocument();

    const shapeSelect = screen.getByLabelText('形状');
    expect(
      within(shapeSelect).getByRole('option', { name: '菱形' }),
    ).toBeInTheDocument();
    expect(
      within(shapeSelect).queryByRole('option', { name: '流程步骤' }),
    ).toBeNull();
    expect(
      within(shapeSelect).queryByRole('option', { name: '判定' }),
    ).toBeNull();
    expect(
      within(shapeSelect).queryByRole('option', { name: '开始/结束' }),
    ).toBeNull();

    await user.selectOptions(shapeSelect, 'ellipse');
    expect(input.onChangeObjectType).toHaveBeenCalledWith('ellipse');

    await user.click(screen.getByRole('button', { name: '填充色 FFFFFF' }));
    expect(input.onChangeObjectStyle).toHaveBeenCalledWith({ fill: '#ffffff' });

    fireEvent.change(screen.getByLabelText('字号'), {
      target: { value: '18' },
    });
    expect(input.onChangeObjectStyle).toHaveBeenCalledWith({ fontSize: 18 });

    await user.click(screen.getByRole('button', { name: '加粗' }));
    expect(input.onChangeObjectStyle).toHaveBeenCalledWith({ bold: true });

    await user.click(screen.getByRole('button', { name: '锁定' }));
    expect(input.onToggleLock).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '复制一份' }));
    await user.click(screen.getByRole('button', { name: '置顶' }));
    expect(input.onDuplicate).toHaveBeenCalled();
    expect(input.onLayer).toHaveBeenCalledWith('front');
  });

  it('多选：对齐、水平/垂直等距、层级与删除', async () => {
    const user = userEvent.setup();
    const input = props({ nodeIds: ['n-a', 'n-b', 'n-c'], edgeIds: [] });
    render(<BoardInspector {...input} />);
    expect(screen.getByRole('heading', { name: '已选 3 个对象' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '左对齐' }));
    expect(input.onAlign).toHaveBeenCalledWith('left');
    await user.click(screen.getByRole('button', { name: '水平等距' }));
    expect(input.onDistribute).toHaveBeenCalledWith('x');
    await user.click(screen.getByRole('button', { name: '垂直等距' }));
    expect(input.onDistribute).toHaveBeenCalledWith('y');
    await user.click(screen.getByRole('button', { name: '置底' }));
    expect(input.onLayer).toHaveBeenCalledWith('back');
    await user.click(screen.getByRole('button', { name: '上移一层' }));
    await user.click(screen.getByRole('button', { name: '下移一层' }));
    expect(input.onLayer).toHaveBeenCalledWith('up');
    expect(input.onLayer).toHaveBeenCalledWith('down');
    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(input.onDelete).toHaveBeenCalled();
  });

  it('连线：线型/箭头/颜色/粗细/虚线/标签/反向/删除', async () => {
    const user = userEvent.setup();
    const input = {
      ...props({ nodeIds: [], edgeIds: ['e-a'] }),
      focusLabelToken: 1,
    };
    render(<BoardInspector {...input} />);
    expect(screen.getByRole('heading', { name: '连线' })).toBeInTheDocument();
    expect(screen.getByLabelText('连线颜色 9FB0C2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '折线' }));
    expect(input.onChangeEdgeStyle).toHaveBeenCalledWith({ routing: 'elbow' });
    await user.click(screen.getByRole('button', { name: '两端' }));
    expect(input.onChangeEdgeStyle).toHaveBeenCalledWith({ arrow: 'both' });
    await user.click(screen.getByRole('button', { name: '连线颜色 5579D5' }));
    expect(input.onChangeEdgeStyle).toHaveBeenCalledWith({ color: '#5579d5' });

    await user.selectOptions(screen.getByLabelText('粗细'), '3');
    expect(input.onChangeEdgeStyle).toHaveBeenCalledWith({ width: 3 });
    await user.click(screen.getByLabelText('虚线'));
    expect(input.onChangeEdgeStyle).toHaveBeenCalledWith({ dashed: true });

    const label = screen.getByLabelText('标签');
    fireEvent.change(label, { target: { value: '否' } });
    fireEvent.blur(label);
    expect(input.onChangeEdgeLabel).toHaveBeenCalledWith('否');

    await user.click(screen.getByRole('button', { name: '反向' }));
    expect(input.onReverseEdge).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '删除连线' }));
    expect(input.onDelete).toHaveBeenCalled();
  });

  it('多选连线：批量线型/箭头/颜色/粗细，隐藏标签输入', async () => {
    const user = userEvent.setup();
    const input = props({ nodeIds: [], edgeIds: ['e-a', 'e-b'] });
    render(<BoardInspector {...input} />);
    expect(
      screen.getByRole('heading', { name: '已选 2 条连线' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('标签')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '直线' }));
    expect(input.onChangeEdgeStyle).toHaveBeenCalledWith({
      routing: 'straight',
    });
    await user.click(screen.getByRole('button', { name: '两端' }));
    expect(input.onChangeEdgeStyle).toHaveBeenCalledWith({ arrow: 'both' });
    await user.click(screen.getByRole('button', { name: '批量连线颜色 5579D5' }));
    expect(input.onChangeEdgeStyle).toHaveBeenCalledWith({ color: '#5579d5' });
    fireEvent.change(screen.getByLabelText('粗细'), {
      target: { value: '3' },
    });
    expect(input.onChangeEdgeStyle).toHaveBeenCalledWith({ width: 3 });
    await user.click(screen.getByRole('button', { name: '删除 2 条连线' }));
    expect(input.onDelete).toHaveBeenCalled();
  });

  it('节点+连线混合选择：节点面板与批量连线面板同时出现', () => {
    const input = props({ nodeIds: ['n-a', 'n-b'], edgeIds: ['e-a'] });
    render(<BoardInspector {...input} />);
    expect(screen.getByRole('heading', { name: '已选 2 个对象' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '已选 1 条连线' })).toBeInTheDocument();
    expect(screen.getByLabelText('批量线型')).toBeInTheDocument();
    expect(screen.queryByLabelText('标签')).not.toBeInTheDocument();
  });

  it('阅读模式下字段与操作禁用', () => {
    render(
      <BoardInspector
        {...props({ nodeIds: ['n-a'], edgeIds: [] })}
        readOnly
      />,
    );
    expect(screen.getByLabelText('形状')).toBeDisabled();
    expect(screen.getByRole('button', { name: '锁定' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除' })).toBeDisabled();
  });
});
