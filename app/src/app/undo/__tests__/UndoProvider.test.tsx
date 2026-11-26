import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  UNDO_WINDOW_MS,
  UndoProvider,
  useUndo,
  type UndoRequest,
} from '..';

function Harness({ request }: { request: UndoRequest }) {
  const { schedule } = useUndo();
  return (
    <button type="button" onClick={() => schedule(request)}>
      删除
    </button>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('UndoProvider', () => {
  it('撤销窗口固定为 5 秒：窗口内可撤销，超时自动收起', () => {
    vi.useFakeTimers();
    const onUndo = vi.fn();
    const onExpire = vi.fn();

    render(
      <UndoProvider>
        <Harness request={{ message: '任务已删除', onUndo, onExpire }} />
      </UndoProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByText('任务已删除')).toBeInTheDocument();
    expect(screen.getByText('5 秒内可撤销')).toBeInTheDocument();
    expect(UNDO_WINDOW_MS).toBe(5000);

    act(() => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    });
    expect(screen.getByText('任务已删除')).toBeInTheDocument();
    expect(onExpire).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('任务已删除')).not.toBeInTheDocument();
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('点撤销会立即移除提示并执行恢复动作', async () => {
    const onUndo = vi.fn();

    render(
      <UndoProvider>
        <Harness
          request={{ message: '任务已删除', undoLabel: '撤销', onUndo }}
        />
      </UndoProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));

    await waitFor(() => {
      expect(onUndo).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('任务已删除')).not.toBeInTheDocument();
    });
  });

  it('恢复失败时回调错误，不留下撤销条', async () => {
    const onUndoError = vi.fn();
    const onUndo = vi.fn(async () => {
      throw new Error('数据库不可用');
    });

    render(
      <UndoProvider>
        <Harness
          request={{ message: '任务已删除', onUndo, onUndoError }}
        />
      </UndoProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));

    await waitFor(() => {
      expect(onUndoError).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('任务已删除')).not.toBeInTheDocument();
    });
  });
});
