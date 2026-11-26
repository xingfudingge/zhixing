// @ts-nocheck
/**
 * AUD-012 独立验收 · P2 附件闭环。
 *
 * 真实渲染产品 AttachmentSection，使用产品 AttachmentManager / Uploader，
 * 元数据走 fakeTauri 实现的 SQLite IPC（同一套 attachments_* 命令），
 * Blob 使用内存存储替代 IndexedDB。覆盖：
 *   选择文件 → 元数据落库 → 重挂载仍在 → 图片预览 → 非图片下载 → 删除。
 *
 * 不注入任何“已成功”状态；上传走产品 Uploader 的真实分片代码，只替换远端
 * transport（与实现者测试不同：这里使用独立最小 transport，而非复用其 helper）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from '../app/node_modules/react/index.js';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '../app/node_modules/@testing-library/react/dist/index.js';
import userEvent from '../app/node_modules/@testing-library/user-event/dist/esm/index.js';

import { createFakeWorld } from './harness/fakeTauri';

let consoleErrors: string[] = [];
let consoleWarns: string[] = [];
let restoreConsole: (() => void) | null = null;

beforeEach(() => {
  consoleErrors = [];
  consoleWarns = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(args.map(String).join(' '));
  });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
    consoleWarns.push(args.map(String).join(' '));
  });
  restoreConsole = () => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  };
  window.localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  restoreConsole?.();
  delete window.__TAURI_INTERNALS__;
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
});

function makeTransport(manager, blobStore) {
  let remoteSeq = 0;
  const remoteId = () => `remote-${++remoteSeq}`;
  const remoteMeta = new Map();
  return {
    async initAttachment(input) {
      const id = remoteId();
      remoteMeta.set(id, { ...input, id });
      return {
        attachment: {
          id,
          spaceId: 'personal',
          noteId: input.noteId,
          blockId: input.blockId,
          fileName: input.fileName,
          sha256: input.sha256,
          byteSize: input.byteSize,
          mime: input.mime,
          storageKey: `spaces/personal/assets/${input.sha256}`,
          status: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        uploadUrl: null,
        alreadyAvailable: false,
      };
    },
    async createSession(id, chunkSize) {
      const meta = remoteMeta.get(id);
      const size = meta?.byteSize ?? 0;
      return {
        chunkSize,
        partCount: 1,
        presentPartIndexes: [],
        missingParts: [{ index: 0, size, url: 'https://upload.test/part/0' }],
        completeUrl: 'https://upload.test/complete',
        completeKey: 'complete-key',
        alreadyAvailable: false,
      };
    },
    async putBlob() {
      return undefined;
    },
    async completeUpload(id, input) {
      const meta = remoteMeta.get(id);
      if (!meta) throw new Error(`未知远端附件 ${id}`);
      return {
        id,
        spaceId: 'personal',
        noteId: meta.noteId,
        blockId: meta.blockId,
        fileName: meta.fileName,
        sha256: meta.sha256,
        byteSize: meta.byteSize,
        mime: meta.mime,
        storageKey: `spaces/personal/assets/${input.completeSha256}`,
        status: 'available',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
    async downloadManifest(id) {
      const meta = remoteMeta.get(id);
      if (!meta) throw new Error(`未知远端附件 ${id}`);
      return {
        attachment: {
          id,
          spaceId: 'personal',
          noteId: meta.noteId,
          blockId: meta.blockId,
          fileName: meta.fileName,
          sha256: meta.sha256,
          byteSize: meta.byteSize,
          mime: meta.mime,
          storageKey: `spaces/personal/assets/${meta.sha256}`,
          status: 'available',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        chunkSize: 4 * 1024 * 1024,
        partCount: 1,
        parts: [
          {
            index: 0,
            size: metadata.metadata.byteSize,
            url: 'https://download.test/part/0',
          },
        ],
      };
    },
    async getBlob() {
      return blobStore.__blob;
    },
  };
}

async function setup() {
  const world = createFakeWorld();
  world.install();
  const { createDbClient } = await import('../app/src/data/db/client');
  const { createDbAttachmentRepository } = await import(
    '../app/src/features/attachments/repository'
  );
  const {
    AttachmentManager,
    MemoryBlobStore,
    MemoryAttachmentStateStore,
    AttachmentUploader,
    AttachmentSection,
  } = await import('../app/src/features/attachments/index');
  const repository = createDbAttachmentRepository(createDbClient(world.invoke));
  const blobStore = new MemoryBlobStore();
  const manager = new AttachmentManager({
    repository,
    blobStore,
    stateStore: new MemoryAttachmentStateStore(),
    now: () => '2026-10-27T10:00:00.000Z',
  });
  const transport = makeTransport(manager, blobStore);
  const uploader = new AttachmentUploader({ manager, transport, chunkSize: 4 * 1024 * 1024 });
  return {
    world,
    manager,
    uploader,
    blobStore,
    AttachmentSection,
  };
}

describe('P2 附件 · 真实选择/持久化/预览/下载/删除', () => {
  it('任务附件：上传字节落库、重挂载可见、预览/下载、删除后消失', async () => {
    const harness = await setup();
    const user = userEvent.setup();
    // Tauri WebView 有 createObjectURL；jsdom 没有，这里只补浏览器能力，不跳过组件逻辑。
    URL.createObjectURL = vi.fn(() => 'blob:acceptance-preview');
    URL.revokeObjectURL = vi.fn();
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    const renderSection = () =>
      render(
        React.createElement(harness.AttachmentSection, {
          manager: harness.manager,
          uploader: harness.uploader,
          taskId: 'task-acceptance',
          title: '任务附件',
          insertLabel: '＋ 添加附件',
        }),
      );

    const view = renderSection();
    const png = new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])],
      '验收截图.png',
      { type: 'image/png' },
    );
    harness.blobStore.__blob = png;
    fireEvent.change(screen.getByLabelText('选择附件文件'), {
      target: { files: [png] },
    });

    await waitFor(() => {
      expect(
        harness.world.db.attachments.filter((row) => row.deletedAt === null),
      ).toHaveLength(1);
    });
    const stored = harness.world.db.attachments[0];
    expect(stored).toMatchObject({
      fileName: '验收截图.png',
      mime: 'image/png',
      byteSize: png.size,
      blockId: 'task:task-acceptance',
      noteId: null,
    });
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await screen.findByText('验收截图.png')).toBeInTheDocument();
    expect(screen.getByText(/本机已保存/)).toBeInTheDocument();

    // 卸载后重挂载（等价刷新页面）：元数据来自 fakeTauri SQLite，Blob 仍由同一存储持有。
    view.unmount();
    renderSection();
    expect(await screen.findByText('验收截图.png')).toBeInTheDocument();

    // 图片预览：真实 AttachmentCard → AttachmentPanel 预览弹层。
    await user.click(screen.getByRole('button', { name: '预览附件 验收截图.png' }));
    const dialog = await screen.findByRole('dialog', {
      name: '预览附件 验收截图.png',
    });
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(
      'blob:acceptance-preview',
    );
    await user.click(screen.getByRole('button', { name: '关闭附件预览' }));

    // 上传走产品 Uploader 的真实分片/哈希校验代码；图片必须先显式同意。
    await user.click(
      screen.getByRole('checkbox', { name: /允许把图片上传到当前同步服务器/ }),
    );
    await user.click(screen.getByRole('button', { name: '上传附件 验收截图.png' }));
    await waitFor(() => {
      expect(screen.getByText('已同步')).toBeInTheDocument();
    });

    // 非图片下载：再次选择 txt，点击“下载本机附件”，必须触发浏览器保存。
    const txt = new File([new TextEncoder().encode('验收正文')], '验收说明.txt', {
      type: 'text/plain',
    });
    harness.blobStore.__blob = txt;
    fireEvent.change(screen.getByLabelText('选择附件文件'), {
      target: { files: [txt] },
    });
    expect(await screen.findByText('验收说明.txt')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: '另存本机附件 验收说明.txt' }),
    );
    await waitFor(() => {
      expect(
        harness.world.exportsWritten.some(
          (item) => item.fileName === '验收说明.txt',
        ),
      ).toBe(true);
    });

    // 删除两张附件：SQLite 软删除 + 页面不再显示。
    await user.click(screen.getByRole('button', { name: '删除附件 验收截图.png' }));
    await user.click(screen.getByRole('button', { name: '删除附件 验收说明.txt' }));
    await waitFor(() => {
      expect(screen.queryByText('验收截图.png')).not.toBeInTheDocument();
      expect(screen.queryByText('验收说明.txt')).not.toBeInTheDocument();
    });
    expect(
      harness.world.db.attachments.every((row) => row.deletedAt !== null),
    ).toBe(true);
    expect(await screen.findByText(/还没有附件/)).toBeInTheDocument();
    expect(consoleErrors).toEqual([]);
    expect(consoleWarns).toEqual([]);
  });
});
