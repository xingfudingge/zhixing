/**
 * ZX-LINK-03：链接块的统一打开动作。
 *
 * 锁定：
 * - 外链在打开前重新走 `parseLinkInput`，危险协议/站内链不会被交给系统；
 * - 浏览器被拦截时明确抛错，不静默；
 * - 桌面端只走 `tauri-plugin-opener`，失败信息可展示；
 * - 复制链接走剪贴板，供失效/打开失败时兜底。
 */

import { openUrl } from '@tauri-apps/plugin-opener';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LinkOpenError,
  copyLinkText,
  openExternalLink,
} from '../linkActions';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

const openUrlMock = vi.mocked(openUrl);

function setTauriRuntime(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  } else {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;
  }
}

beforeEach(() => {
  openUrlMock.mockReset();
  openUrlMock.mockResolvedValue(undefined);
  setTauriRuntime(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  setTauriRuntime(false);
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

describe('openExternalLink', () => {
  it('浏览器中打开 http/https，并立即断开 opener', async () => {
    const opened = { opener: {} } as unknown as Window;
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(opened);

    await openExternalLink('https://example.com/a?b=1');

    expect(openSpy).toHaveBeenCalledWith(
      'https://example.com/a?b=1',
      '_blank',
    );
    expect(opened.opener).toBeNull();
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  it('浏览器拦截新窗口时抛出可展示的错误', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);

    const error = await openExternalLink(
      'https://example.com/blocked',
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(LinkOpenError);
    expect((error as Error).message).toContain('拦截');
  });

  it('危险协议与站内链不会交给系统打开', async () => {
    const openSpy = vi.spyOn(window, 'open');

    await expect(openExternalLink('javascript:alert(1)')).rejects.toThrow(
      '仅支持 http / https / mailto 或站内笔记内链',
    );
    await expect(openExternalLink('file:///etc/passwd')).rejects.toThrow(
      '仅支持 http / https / mailto 或站内笔记内链',
    );
    await expect(
      openExternalLink('zhixing://note/note-target'),
    ).rejects.toThrow('站内笔记链接只能在应用内打开');

    expect(openSpy).not.toHaveBeenCalled();
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  it('Tauri 中调用 tauri-plugin-opener，不用 window.open', async () => {
    setTauriRuntime(true);
    const openSpy = vi.spyOn(window, 'open');

    await openExternalLink('mailto:hi@example.com');

    expect(openUrlMock).toHaveBeenCalledWith('mailto:hi@example.com');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('Tauri opener 失败时携带系统原因，供界面提示', async () => {
    setTauriRuntime(true);
    openUrlMock.mockRejectedValueOnce(new Error('no default browser'));

    const error = await openExternalLink(
      'https://example.com/no-browser',
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(LinkOpenError);
    expect((error as Error).message).toContain('无法用系统默认应用打开链接');
    expect((error as Error).message).toContain('no default browser');
  });
});

describe('copyLinkText', () => {
  it('优先使用 Clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    await expect(
      copyLinkText('https://example.com/copy'),
    ).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('https://example.com/copy');
  });
});
