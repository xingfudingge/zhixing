import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { LockOverlay } from '../LockOverlay';
import { usePrivacyLock } from '../usePrivacyLock';

function Harness({ enabled }: { enabled: boolean }) {
  const { covered, reveal } = usePrivacyLock(enabled);
  return (
    <>
      <main data-sensitive-copy>
        <h1>秘密任务标题</h1>
        <p>笔记正文不应出现在遮挡层</p>
      </main>
      <LockOverlay covered={covered} onReveal={reveal} />
    </>
  );
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

afterEach(() => {
  setVisibility('visible');
});

describe('失焦遮挡', () => {
  it('窗口失焦后覆盖内容，且遮挡层不复制正文', () => {
    render(<Harness enabled />);
    expect(
      screen.queryByRole('dialog', { name: '内容已隐藏' }),
    ).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    const dialog = screen.getByRole('dialog', { name: '内容已隐藏' });
    expect(dialog).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('秘密任务标题');
    expect(dialog).not.toHaveTextContent('笔记正文不应出现在遮挡层');
    expect(
      screen.getByRole('button', { name: '显示内容' }),
    ).toBeInTheDocument();
  });

  it('回焦不会自动揭开，必须点击「显示内容」', async () => {
    const user = userEvent.setup();
    render(<Harness enabled />);

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(
      screen.getByRole('dialog', { name: '内容已隐藏' }),
    ).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(
      screen.getByRole('dialog', { name: '内容已隐藏' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '显示内容' }));
    expect(
      screen.queryByRole('dialog', { name: '内容已隐藏' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('秘密任务标题')).toBeInTheDocument();
  });

  it('页面进入后台时遮挡', () => {
    render(<Harness enabled />);
    setVisibility('hidden');

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(
      screen.getByRole('dialog', { name: '内容已隐藏' }),
    ).toBeInTheDocument();
  });

  it('设置关闭时不遮挡', () => {
    render(<Harness enabled={false} />);

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(
      screen.queryByRole('dialog', { name: '内容已隐藏' }),
    ).not.toBeInTheDocument();
  });
});
