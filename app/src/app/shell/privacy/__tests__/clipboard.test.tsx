import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createClipboardGuard,
  fingerprintText,
  type ClipboardBackend,
} from '../clipboard';
import { ClipboardProtection } from '../ClipboardProtection';

function fakeBackend(initial: string) {
  const state = { text: initial };
  const clear = vi.fn(async () => {
    state.text = '';
  });
  const backend: ClipboardBackend = {
    readText: async () => state.text,
    clear,
  };
  return { backend, state, clear };
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete (navigator as { clipboard?: unknown }).clipboard;
});

describe('剪贴板保护核心', () => {
  it('延迟结束后只清空仍为本次复制的内容，且指纹不含原文', async () => {
    const { backend, state, clear } = fakeBackend('敏感笔记');
    const events: string[] = [];
    const guard = createClipboardGuard({
      backend,
      clearSeconds: () => 30,
      isSensitive: () => true,
      onEvent: (event) => events.push(event.type),
    });

    const fingerprint = await fingerprintText('敏感笔记');
    expect(JSON.stringify(fingerprint)).not.toContain('敏感笔记');

    guard.handleCopy('敏感笔记', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContain('scheduled');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(state.text).toBe('');
    expect(events).toContain('cleared');
  });

  it('用户后来复制了别的内容时不清空', async () => {
    const { backend, state, clear } = fakeBackend('敏感笔记');
    const events: string[] = [];
    const guard = createClipboardGuard({
      backend,
      clearSeconds: () => 15,
      isSensitive: () => true,
      onEvent: (event) => events.push(event.type),
    });

    guard.handleCopy('敏感笔记', true);
    await vi.advanceTimersByTimeAsync(0);
    state.text = '用户新复制的内容';

    await vi.advanceTimersByTimeAsync(15_000);
    expect(clear).not.toHaveBeenCalled();
    expect(events).toContain('skipped');
  });

  it('读取失败或权限被拒时选择不清空', async () => {
    const clear = vi.fn(async () => undefined);
    const events: string[] = [];
    const guard = createClipboardGuard({
      backend: {
        readText: async () => {
          throw new Error('permission denied');
        },
        clear,
      },
      clearSeconds: () => 15,
      isSensitive: () => true,
      onEvent: (event) => events.push(event.type),
    });

    guard.handleCopy('敏感笔记', true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(clear).not.toHaveBeenCalled();
    expect(events).toContain('skipped');
  });

  it('剪贴板已经为空（Tauri 返回 null）时只标记跳过，不抛错', async () => {
    const clear = vi.fn(async () => undefined);
    const events: string[] = [];
    const guard = createClipboardGuard({
      backend: {
        readText: async () => null,
        clear,
      },
      clearSeconds: () => 15,
      isSensitive: () => true,
      onEvent: (event) => events.push(event.type),
    });

    guard.handleCopy('敏感笔记', true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(clear).not.toHaveBeenCalled();
    expect(events).toContain('skipped');
  });

  it('撤销后不再清空；非敏感复制会取消尚未执行的清空', async () => {
    const { backend, clear } = fakeBackend('敏感笔记');
    const guard = createClipboardGuard({
      backend,
      clearSeconds: () => 15,
      isSensitive: () => true,
    });

    guard.handleCopy('敏感笔记', true);
    await vi.advanceTimersByTimeAsync(0);
    guard.cancel();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(clear).not.toHaveBeenCalled();

    guard.handleCopy('敏感笔记', true);
    await vi.advanceTimersByTimeAsync(0);
    guard.handleCopy('普通内容', false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(clear).not.toHaveBeenCalled();
  });

  it('设置关闭（0 秒）或内容为空时不安排清空', async () => {
    const { backend, clear } = fakeBackend('敏感笔记');
    const events: string[] = [];
    const guard = createClipboardGuard({
      backend,
      clearSeconds: () => 0,
      isSensitive: () => true,
      onEvent: (event) => events.push(event.type),
    });

    guard.handleCopy('敏感笔记', true);
    guard.handleCopy('', true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clear).not.toHaveBeenCalled();
    expect(events).not.toContain('scheduled');
  });
});

describe('剪贴板保护接入选中的视图', () => {
  it('在敏感视图复制后显示提示，延迟结束清空并回显结果', async () => {
    const clipboard = {
      writeText: vi.fn(async () => undefined),
      readText: vi.fn(async () => '敏感笔记'),
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: clipboard,
    });
    const { backend, clear } = fakeBackend('敏感笔记');

    render(
      <ClipboardProtection
        enabled
        seconds={30}
        sensitive
        backend={backend}
      />,
    );

    await act(async () => {
      await navigator.clipboard.writeText('敏感笔记');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(
      screen.getByText(/将在 30 秒后自动清空剪贴板/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '撤销清空' }),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(clear).toHaveBeenCalledTimes(1);
    expect(screen.getByText('剪贴板已清空。')).toBeInTheDocument();
  });

  it('点击「撤销清空」后提示消失且不会清空', async () => {
    const clipboard = {
      writeText: vi.fn(async () => undefined),
      readText: vi.fn(async () => '敏感笔记'),
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: clipboard,
    });
    const { backend, clear } = fakeBackend('敏感笔记');

    render(
      <ClipboardProtection
        enabled
        seconds={30}
        sensitive
        backend={backend}
      />,
    );

    await act(async () => {
      await navigator.clipboard.writeText('敏感笔记');
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '撤销清空' }));
    });

    expect(
      screen.queryByText(/将在 30 秒后自动清空剪贴板/),
    ).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(clear).not.toHaveBeenCalled();
  });

  it('覆盖 WKWebView 的 execCommand 兜底复制路径', async () => {
    Object.defineProperty(Document.prototype, 'execCommand', {
      configurable: true,
      writable: true,
      value: vi.fn(() => true),
    });
    const { backend, clear } = fakeBackend('敏感笔记');
    try {
      render(
        <ClipboardProtection
          enabled
          seconds={15}
          sensitive
          backend={backend}
        />,
      );

      const area = document.createElement('textarea');
      area.value = '敏感笔记';
      document.body.appendChild(area);
      let ok = false;
      act(() => {
        area.focus();
        area.select();
        ok = document.execCommand('copy');
      });
      area.remove();
      expect(ok).toBe(true);

      expect(
        screen.getByText(/将在 15 秒后自动清空剪贴板/),
      ).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(clear).toHaveBeenCalledTimes(1);
    } finally {
      delete (Document.prototype as { execCommand?: unknown }).execCommand;
    }
  });

  it('非敏感视图不保护，也不弹提示', async () => {    const clipboard = {
      writeText: vi.fn(async () => undefined),
      readText: vi.fn(async () => '设置页文本'),
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: clipboard,
    });
    const { backend, clear } = fakeBackend('设置页文本');

    render(
      <ClipboardProtection
        enabled
        seconds={30}
        sensitive={false}
        backend={backend}
      />,
    );

    await act(async () => {
      await navigator.clipboard.writeText('设置页文本');
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(clear).not.toHaveBeenCalled();
  });
});
