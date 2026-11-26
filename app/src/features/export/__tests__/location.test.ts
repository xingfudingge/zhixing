/**
 * ZX-EXPORT-06：默认导出目录策略。
 *
 * 锁定的产品行为：
 * - 未设置 / 空白 / 坏 JSON 都视为“每次询问”，不猜 Downloads/Documents；
 * - 设置后只作为保存面板起始目录；
 * - 取消目录选择不改变设置；浏览器预览明确提示不可用。
 */

import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SETTINGS_STORAGE_KEY } from '../../../data/settingsStorage';
import {
  ExportDirectoryError,
  pickExportDirectory,
  readDefaultExportDirectory,
} from '../location';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

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

function writeSettings(raw: unknown) {
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(raw));
}

beforeEach(() => {
  window.localStorage.clear();
  invokeMock.mockReset();
  setTauriRuntime(false);
});

afterEach(() => {
  window.localStorage.clear();
  setTauriRuntime(false);
});

describe('读取默认导出目录', () => {
  it('未设置、空白与坏 JSON 都返回 null（每次询问）', () => {
    expect(readDefaultExportDirectory()).toBeNull();

    writeSettings({ export: { directory: '   ' } });
    expect(readDefaultExportDirectory()).toBeNull();

    window.localStorage.setItem(SETTINGS_STORAGE_KEY, '{not-json');
    expect(readDefaultExportDirectory()).toBeNull();

    writeSettings({ export: { directory: 42 } });
    expect(readDefaultExportDirectory()).toBeNull();
  });

  it('读取设置里保存的绝对路径并去掉首尾空白', () => {
    writeSettings({ export: { directory: '  /Users/me/Exports  ' } });
    expect(readDefaultExportDirectory()).toBe('/Users/me/Exports');
  });

  it('可以注入只读 storage，不依赖全局 localStorage', () => {
    expect(
      readDefaultExportDirectory({
        getItem: () =>
          JSON.stringify({ export: { directory: '/tmp/from-injected' } }),
      }),
    ).toBe('/tmp/from-injected');
    expect(readDefaultExportDirectory({ getItem: () => null })).toBeNull();
  });
});

describe('选择默认导出目录', () => {
  it('桌面端取消返回 null，不伪造路径', async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue(null);

    await expect(pickExportDirectory()).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('pick_export_directory');
  });

  it('桌面端返回用户选择的目录', async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue('  /Users/me/Documents/知行导出  ');

    await expect(pickExportDirectory()).resolves.toBe(
      '/Users/me/Documents/知行导出',
    );
  });

  it('目录失效/无权限错误原样提示，便于用户重新选择或清除', async () => {
    setTauriRuntime(true);
    invokeMock.mockRejectedValue(
      '默认导出目录不可写：/Volumes/离线盘 没有写入权限。请在「设置 → 数据与备份」中重新选择默认导出目录，或清除默认目录后每次手动选择。',
    );

    await expect(pickExportDirectory()).rejects.toThrow(/重新选择/);
  });

  it('浏览器预览明确报错，不假装设置成功', async () => {
    await expect(pickExportDirectory()).rejects.toBeInstanceOf(
      ExportDirectoryError,
    );
    await expect(pickExportDirectory()).rejects.toThrow(/桌面版/);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
