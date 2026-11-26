import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BoardRail } from '../BoardRail';

function props() {
  return {
    tool: 'select' as const,
    onToolChange: vi.fn(),
    onInsert: vi.fn(),
    onMoreShapes: vi.fn(),
    onStarter: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    canUndo: false,
    canRedo: false,
    selectionCount: 0,
    edgeSelectionCount: 0,
    edgeRouting: null,
    onEdgeRouting: vi.fn(),
    onAlign: vi.fn(),
    onDelete: vi.fn(),
  };
}

describe('画板工具条 · 线型快捷按钮', () => {
  it('无选中连线时禁用；选中后高亮当前线型并批量回传', async () => {
    const user = userEvent.setup();
    const input = props();
    const { rerender } = render(<BoardRail {...input} />);
    expect(screen.getByRole('button', { name: '线型直线' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '线型折线' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '线型曲线' })).toBeDisabled();

    rerender(
      <BoardRail
        {...input}
        edgeSelectionCount={2}
        edgeRouting="elbow"
      />,
    );
    const elbow = screen.getByRole('button', { name: '线型折线' });
    expect(elbow).toBeEnabled();
    expect(elbow).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: '线型直线' }));
    expect(input.onEdgeRouting).toHaveBeenCalledWith('straight');
  });
});
