/**
 * ZX-FILE-01：打开/另存统一链路。
 *
 * 这些测试锁定几个产品约束：
 * - 桌面“打开”调用系统应用，不退化成下载；
 * - 取消保存不写文件；
 * - 浏览器没有保存面板时明确报错，不偷偷放进 Downloads；
 * - 知识 Markdown 导出与附件另存使用同一个保存入口。
 */

import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadNoteMarkdown } from '../../../data/repositories/notes';
import { SETTINGS_STORAGE_KEY } from '../../../data/settingsStorage';
import {
  MemoryAttachmentStateStore,
  MemoryBlobStore,
} from '../blobStore';
import {
  FileActionError,
  openAttachmentLocally,
  openBlobWithSystemApp,
  saveBlobWithDialog,
  saveLocalAttachment,
} from '../fileActions';
import { AttachmentManager } from '../manager';
import { MemoryAttachmentMetadataRepository } from '../repository';

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

function setSavePicker(picker?: (options?: unknown) => Promise<unknown>) {
  if (picker) {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: picker,
    });
  } else {
    delete (window as Window & { showSaveFilePicker?: unknown })
      .showSaveFilePicker;
  }
}

function createManager() {
  const repository = new MemoryAttachmentMetadataRepository();
  const blobStore = new MemoryBlobStore();
  const stateStore = new MemoryAttachmentStateStore();
  let sequence = 0;
  const manager = new AttachmentManager({
    repository,
    blobStore,
    stateStore,
    newId: () => `file_action_${++sequence}`,
  });
  return { manager, repository, blobStore };
}

let originalCreate: typeof URL.createObjectURL;
let originalRevoke: typeof URL.revokeObjectURL;

beforeEach(() => {
  setTauriRuntime(false);
  setSavePicker(undefined);
  setDefaultExportDirectory(null);
  invokeMock.mockReset();
  originalCreate = URL.createObjectURL;
  originalRevoke = URL.revokeObjectURL;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:file-action'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  setTauriRuntime(false);
  setSavePicker(undefined);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: originalCreate,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: originalRevoke,
  });
  vi.restoreAllMocks();
});

describe('保存：统一走用户可见保存面板', () => {
  it('桌面调用 save_attachment_file，返回真实保存路径', async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue('/Users/me/Documents/方案.pdf');

    const result = await saveBlobWithDialog(
      new Blob([new Uint8Array([1, 2, 3])]),
      '方案.pdf',
    );

    expect(invokeMock).toHaveBeenCalledWith('save_attachment_file', {
      fileName: '方案.pdf',
      bytes: [1, 2, 3],
      // 未设置默认目录：明确传 null，Rust 不得调用 set_directory 回退到
      // Downloads/Documents。
      directory: null,
    });
    expect(result).toEqual({
      status: 'saved',
      path: '/Users/me/Documents/方案.pdf',
      target: 'desktop',
    });
  });

  it('设置默认导出目录后作为保存面板起始目录传入', async () => {
    setTauriRuntime(true);
    setDefaultExportDirectory('/Users/me/Exports');
    invokeMock.mockResolvedValue('/Users/me/Exports/方案.pdf');

    const result = await saveBlobWithDialog(new Blob(['x']), '方案.pdf');

    expect(invokeMock).toHaveBeenCalledWith('save_attachment_file', {
      fileName: '方案.pdf',
      bytes: [120],
      directory: '/Users/me/Exports',
    });
    expect(result).toMatchObject({
      status: 'saved',
      path: '/Users/me/Exports/方案.pdf',
    });
  });

  it('清除默认导出目录后恢复每次由保存面板选择', async () => {
    setTauriRuntime(true);
    setDefaultExportDirectory('/Users/me/Exports');
    invokeMock.mockResolvedValue(null);

    await saveBlobWithDialog(new Blob(['x']), '取消.md');
    setDefaultExportDirectory(null);
    await saveBlobWithDialog(new Blob(['x']), '再次取消.md');

    expect(invokeMock).toHaveBeenNthCalledWith(2, 'save_attachment_file', {
      fileName: '再次取消.md',
      bytes: [120],
      directory: null,
    });
  });

  it('桌面保存面板取消时返回 canceled，不写文件', async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue(null);

    const result = await saveBlobWithDialog(new Blob(['x']), '取消.txt');

    expect(result).toEqual({ status: 'canceled' });
  });

  it('桌面命令失败时抛出可读错误，不静默成功', async () => {
    setTauriRuntime(true);
    invokeMock.mockRejectedValue('无法创建文件：磁盘只读');

    await expect(
      saveBlobWithDialog(new Blob(['x']), '失败.txt'),
    ).rejects.toThrow('无法创建文件：磁盘只读');
  });

  it('浏览器保存面板写入所选位置，取消时不创建可写流', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const createWritable = vi.fn().mockResolvedValue({
      write,
      close,
      abort: vi.fn(),
    });
    const picker = vi.fn().mockResolvedValue({ createWritable });
    setSavePicker(picker);

    const result = await saveBlobWithDialog(new Blob(['hello']), '笔记.md');

    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: '笔记.md' }),
    );
    expect(createWritable).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'saved',
      path: null,
      target: 'browser',
    });
  });

  it('浏览器取消（AbortError）不写文件', async () => {
    const createWritable = vi.fn();
    const abort = Object.assign(new Error('canceled'), { name: 'AbortError' });
    setSavePicker(vi.fn().mockRejectedValue(abort));

    const result = await saveBlobWithDialog(new Blob(['x']), '取消.md');

    expect(result).toEqual({ status: 'canceled' });
    expect(createWritable).not.toHaveBeenCalled();
  });

  it('没有保存面板时明确报错，绝不使用 <a download> 落进 Downloads', async () => {
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    await expect(
      saveBlobWithDialog(new Blob(['x']), '无面板.txt'),
    ).rejects.toBeInstanceOf(FileActionError);
    await expect(
      saveBlobWithDialog(new Blob(['x']), '无面板.txt'),
    ).rejects.toThrow(/不会自动放进 Downloads/);
    expect(anchorClick).not.toHaveBeenCalled();
  });

  it('知识 Markdown 导出复用同一保存面板与文件名清洗', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const picker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({
        write,
        close: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn(),
      }),
    });
    setSavePicker(picker);

    const result = await downloadNoteMarkdown({
      title: '项目/复盘',
      body: '<p>正文</p>',
    });

    expect(result.status).toBe('saved');
    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: '项目-复盘.md' }),
    );
    const blob = write.mock.calls[0]![0] as Blob;
    expect(await blob.text()).toContain('# 项目/复盘');
  });
});

describe('打开：图片预览，非图片交系统默认应用', () => {
  it('桌面非图片调用 open_attachment_file，并携带 SHA-256', async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue('/cache/attachment-open/abc-方案.pdf');
    const metadata = {
      fileName: '方案.pdf',
      mime: 'application/pdf',
      sha256: 'a'.repeat(64),
    };

    const path = await openBlobWithSystemApp(new Blob(['pdf']), metadata);

    expect(path).toBe('/cache/attachment-open/abc-方案.pdf');
    expect(invokeMock).toHaveBeenCalledWith('open_attachment_file', {
      fileName: '方案.pdf',
      bytes: [112, 100, 102],
      sha256: 'a'.repeat(64),
    });
  });

  it('图片走应用内预览，不调用系统应用', async () => {
    setTauriRuntime(true);
    const { manager } = createManager();
    const ingested = await manager.ingest(
      new File([new Uint8Array([137, 80, 78, 71])], '截图.png', {
        type: 'image/png',
      }),
      { noteId: 'note-image' },
    );

    const opened = await openAttachmentLocally(
      manager,
      ingested.attachment.metadata.id,
    );

    expect(opened.kind).toBe('image');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('浏览器 PDF 在新标签预览，不使用下载锚点', async () => {
    const openWindow = vi
      .spyOn(window, 'open')
      .mockImplementation(() => ({}) as Window);

    const path = await openBlobWithSystemApp(new Blob(['pdf']), {
      fileName: '方案.pdf',
      mime: 'application/pdf',
      sha256: 'b'.repeat(64),
    });

    expect(path).toBeNull();
    expect(openWindow).toHaveBeenCalledWith('blob:file-action', '_blank');
  });

  it('浏览器 Office 文件明确提示改用桌面版，不假装已打开', async () => {
    await expect(
      openBlobWithSystemApp(new Blob(['docx']), {
        fileName: '方案.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sha256: 'c'.repeat(64),
      }),
    ).rejects.toThrow(/请使用桌面版「打开」/);
  });

  it('另存本机附件取消时保持 Blob 不变', async () => {
    setTauriRuntime(true);
    invokeMock.mockResolvedValue(null);
    const { manager } = createManager();
    const ingested = await manager.ingest(
      new File(['hello'], '保留.txt', { type: 'text/plain' }),
      { noteId: 'note-save' },
    );

    const { result } = await saveLocalAttachment(
      manager,
      ingested.attachment.metadata.id,
    );

    expect(result).toEqual({ status: 'canceled' });
    expect(
      await manager.hasLocalBlob(ingested.attachment.metadata.id),
    ).toBe(true);
    expect(await manager.open(ingested.attachment.metadata.id)).toBeTruthy();
  });
});
