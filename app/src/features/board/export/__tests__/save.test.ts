/**
 * ZX-EXPORT-06：画板 PNG 与附件另存共用同一套默认目录策略。
 */

import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SETTINGS_STORAGE_KEY } from '../../../../data/settingsStorage';
import {
  saveBoardJsonWithDialog,
  saveBoardPngWithDialog,
} from '../save';

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

function setDefaultExportDirectory(directory: string | null) {
  if (directory === null) {
    window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({ export: { directory } }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  invokeMock.mockReset();
  setTauriRuntime(true);
});

afterEach(() => {
  window.localStorage.clear();
  setTauriRuntime(false);
});

describe('画板 PNG 保存位置', () => {
  it('未设置默认目录时传 null，由系统保存面板决定位置', async () => {
    invokeMock.mockResolvedValue('/Users/me/Pictures/画板.png');

    const result = await saveBoardPngWithDialog(
      new Blob(['png'], { type: 'image/png' }),
      '画板.png',
    );

    expect(invokeMock).toHaveBeenCalledWith('save_board_export_file', {
      fileName: '画板.png',
      bytes: [112, 110, 103],
      directory: null,
    });
    expect(result).toEqual({
      status: 'saved',
      path: '/Users/me/Pictures/画板.png',
      target: 'desktop',
    });
  });

  it('设置默认目录后从该目录打开保存面板', async () => {
    setDefaultExportDirectory('/Users/me/Exports');
    invokeMock.mockResolvedValue('/Users/me/Exports/画板-1.png');

    await saveBoardPngWithDialog(new Blob(['png']), '画板.png');

    expect(invokeMock).toHaveBeenCalledWith('save_board_export_file', {
      fileName: '画板.png',
      bytes: [112, 110, 103],
      directory: '/Users/me/Exports',
    });
  });

  it('取消返回 canceled，调用方不会提示“已保存”', async () => {
    invokeMock.mockResolvedValue(null);

    const result = await saveBoardPngWithDialog(new Blob(['png']), '画板.png');

    expect(result).toEqual({ status: 'canceled' });
  });
});

describe('画板 JSON 保存位置', () => {
  it('复用保存面板并声明 json 类型，不写死默认目录', async () => {
    invokeMock.mockResolvedValue('/Users/me/Exports/画板-20261029-1330.json');

    const result = await saveBoardJsonWithDialog(
      new Blob(['{}'], { type: 'application/json' }),
      '画板-20261029-1330.json',
    );

    expect(invokeMock).toHaveBeenCalledWith('save_board_export_file', {
      fileName: '画板-20261029-1330.json',
      bytes: [123, 125],
      directory: null,
      kind: 'json',
    });
    expect(result).toEqual({
      status: 'saved',
      path: '/Users/me/Exports/画板-20261029-1330.json',
      target: 'desktop',
    });
  });

  it('用户取消保存面板时不写文件', async () => {
    invokeMock.mockResolvedValue(null);
    const result = await saveBoardJsonWithDialog(
      new Blob(['{}']),
      '画板.json',
    );
    expect(result).toEqual({ status: 'canceled' });
  });
});
