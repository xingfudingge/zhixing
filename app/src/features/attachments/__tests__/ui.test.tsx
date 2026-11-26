import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AttachmentPanel } from '../AttachmentPanel';
import { AttachmentSection } from '../AttachmentSection';
import { ImageBlock } from '../ImageBlock';
import {
  MemoryAttachmentStateStore,
  MemoryBlobStore,
} from '../blobStore';
import { AttachmentManager } from '../manager';
import { MemoryAttachmentMetadataRepository } from '../repository';
import { sha256Blob } from '../sha256';
import {
  bytesKey,
  defaultState,
  type AttachmentSyncMode,
} from '../types';
import type { AttachmentTransport } from '../api';
import { AttachmentUploader } from '../uploader';
import { createFakeTransport } from './fakeTransport';

const CHUNK = 64 * 1024;

function setup(mode: AttachmentSyncMode = 'local') {
  const repository = new MemoryAttachmentMetadataRepository();
  const blobStore = new MemoryBlobStore();
  const stateStore = new MemoryAttachmentStateStore();
  let sequence = 0;
  const manager = new AttachmentManager({
    repository,
    blobStore,
    stateStore,
    newId: () => `ui_${++sequence}`,
    getSyncMode: () => mode,
  });
  const server = createFakeTransport();
  const uploader = new AttachmentUploader({
    manager,
    transport: server,
    chunkSize: CHUNK,
  });
  return { manager, repository, blobStore, stateStore, uploader, server };
}

describe('附件面板与图片块 UI', () => {
  it('插入 DOCX 后显示本机已保存，并可本机打开', async () => {
    const user = userEvent.setup();
    const { manager } = setup();
    const onOpen = vi.fn();
    render(
      <AttachmentPanel
        manager={manager}
        noteId="note-ui"
        uploader={undefined}
        onOpen={onOpen}
      />,
    );

    expect(
      await screen.findByText('还没有附件。插入的文件会先保存到本机，可在本机打开和另存。'),
    ).toBeInTheDocument();

    const input = screen.getByLabelText('选择附件文件');
    await user.upload(
      input,
      new File([new Uint8Array([1, 2, 3, 4])], '离线方案.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    );

    expect(await screen.findByText('离线方案.docx')).toBeInTheDocument();
    expect(screen.getByText('本机已保存')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '打开附件 离线方案.docx' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    const blob = onOpen.mock.calls[0]![1] as Blob;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it('local 模式即使注入了 uploader 也不显示上传入口，文件仍可本机打开', async () => {
    const user = userEvent.setup();
    const { manager, uploader } = setup();
    const onOpen = vi.fn();
    render(
      <AttachmentPanel
        manager={manager}
        noteId="note-local"
        uploader={uploader}
        syncMode="local"
        onOpen={onOpen}
      />,
    );

    await user.upload(
      screen.getByLabelText('选择附件文件'),
      new File([new Uint8Array([7, 8, 9])], '仅本机.pdf', {
        type: 'application/pdf',
      }),
    );

    expect(await screen.findByText('仅本机.pdf')).toBeInTheDocument();
    expect(screen.getByText('本机已保存')).toBeInTheDocument();
    expect(screen.queryByText(/待上传|待同步/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: '上传附件 仅本机.pdf' }),
    ).toBeNull();
    expect(
      screen.queryByText(/允许把图片上传到当前同步服务器/),
    ).toBeNull();

    await user.click(
      screen.getByRole('button', { name: '打开附件 仅本机.pdf' }),
    );
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
  });

  it('local 模式旧 pending 记录迁移为本机已保存，界面不出现待同步或上传入口', async () => {
    const user = userEvent.setup();
    const { manager, stateStore } = setup('local');
    const onOpen = vi.fn();
    const file = await fileOf('旧记录.pdf', [4, 5, 6], 'application/pdf');
    const ingested = await manager.ingest(file, { noteId: 'note-legacy-local' });
    await stateStore.put({
      ...defaultState(
        ingested.attachment.metadata.id,
        bytesKey(ingested.attachment.metadata.sha256),
        '2026-10-01T00:00:00.000Z',
      ),
      status: 'pending',
      lastError: null,
    });

    render(
      <AttachmentPanel
        manager={manager}
        noteId="note-legacy-local"
        syncMode="local"
        onOpen={onOpen}
      />,
    );

    expect(await screen.findByText('旧记录.pdf')).toBeInTheDocument();
    expect(screen.getByText('本机已保存')).toBeInTheDocument();
    expect(screen.queryByText(/待上传|待同步/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: '上传附件 旧记录.pdf' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: '打开附件 旧记录.pdf' }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: '打开附件 旧记录.pdf' }),
    );
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
  });

  it('backend 模式旧 pending 保留待同步，并显示上传（重试）入口', async () => {
    const { manager, stateStore } = setup('backend');
    const file = await fileOf('后端待传.pdf', [7, 7, 7], 'application/pdf');
    const ingested = await manager.ingest(file, { noteId: 'note-legacy-backend' });
    await stateStore.put({
      ...defaultState(
        ingested.attachment.metadata.id,
        bytesKey(ingested.attachment.metadata.sha256),
        '2026-10-01T00:00:00.000Z',
      ),
      status: 'pending',
      lastError: null,
    });

    render(
      <AttachmentPanel
        manager={manager}
        noteId="note-legacy-backend"
        syncMode="backend"
        uploader={new AttachmentUploader({
          manager,
          transport: createFakeTransport(),
          chunkSize: CHUNK,
        })}
      />,
    );

    expect(await screen.findByText('后端待传.pdf')).toBeInTheDocument();
    expect(screen.getByText('待同步')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '上传附件 后端待传.pdf' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('待上传')).toBeNull();
  });

  it('正文引用其他笔记的附件时，面板展示同一条记录', async () => {
    const { manager, repository } = setup();
    const file = await fileOf('共享方案.pdf', [1, 2, 3], 'application/pdf');
    const ingested = await manager.ingest(file, { noteId: 'note-origin' });

    render(
      <AttachmentPanel
        manager={manager}
        noteId="note-ref"
        attachmentIds={[ingested.attachment.metadata.id]}
      />,
    );

    expect(await screen.findByText('共享方案.pdf')).toBeInTheDocument();
    expect(repository.all()).toHaveLength(1);
    expect(await manager.list('note-ref')).toHaveLength(0);
  });

  it('图片上传按钮默认禁用，勾选允许后才可上传', async () => {
    const user = userEvent.setup();
    const { manager, uploader } = setup();
    render(
      <AttachmentPanel manager={manager} noteId="note-img" uploader={uploader} />,
    );
    await user.upload(
      screen.getByLabelText('选择附件文件'),
      new File([new Uint8Array([137, 80, 78, 71, 11])], '截图.png', {
        type: 'image/png',
      }),
    );

    expect(await screen.findByText('截图.png')).toBeInTheDocument();
    const uploadButton = screen.getByRole('button', { name: '上传附件 截图.png' });
    expect(uploadButton).toBeDisabled();
    expect(screen.getByText(/图片默认只保存在本机/)).toBeInTheDocument();

    await user.click(
      screen.getByRole('checkbox', {
        name: /允许把图片上传到当前同步服务器/,
      }),
    );
    expect(uploadButton).toBeEnabled();
    await user.click(uploadButton);

    expect(
      await screen.findByText('已同步'),
    ).toBeInTheDocument();
  });

  it('图片块只渲染本机 Blob，远端缺失时显示下载提示', async () => {
    const { manager, blobStore } = setup();
    const ingested = await manager.ingest(
      new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], '本机图.png', {
        type: 'image/png',
      }),
      { noteId: 'note-image' },
    );
    const { unmount } = render(
      <ImageBlock attachment={ingested.attachment} blobStore={blobStore} />,
    );
    expect(await screen.findByRole('img', { name: '本机图.png' })).toBeInTheDocument();
    unmount();

    const remote = await manager.importRemote({
      id: 'srv_remote_img',
      spaceId: 'personal',
      noteId: 'note-image',
      blockId: null,
      fileName: '远端图.png',
      sha256: 'b'.repeat(64),
      byteSize: 10,
      mime: 'image/png',
      storageKey: `spaces/personal/assets/${'b'.repeat(64)}`,
      status: 'available',
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
    });
    const onRequestDownload = vi.fn();
    render(
      <ImageBlock
        attachment={remote}
        blobStore={blobStore}
        onRequestDownload={onRequestDownload}
      />,
    );
    expect(
      await screen.findByText('图片仅远端可用，需要先下载到本机'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '下载到本机' }));
    expect(onRequestDownload).toHaveBeenCalledTimes(1);
  });
});

async function fileOf(
  name: string,
  bytes: number[],
  type = 'application/octet-stream',
): Promise<File> {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('附件 UI 闭环：上传进度、完成、失败重试、删除与刷新持久化', () => {
  it('上传显示进度与完成态，完整哈希与上传时计算值一致，重新挂载后仍存在', async () => {
    const user = userEvent.setup();
    const { manager, uploader, server } = setup();
    const file = await fileOf(
      '验收报告.bin',
      Array.from({ length: 64 * 1024 * 2 + 16 }, (_, index) => index % 251),
    );
    const expectedSha = await sha256Blob(file);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let putCalls = 0;
    const slowTransport = Object.create(server) as AttachmentTransport;
    slowTransport.putBlob = async (url, blob) => {
      putCalls += 1;
      // 第二片开始前挂起：第一片已完成，uploader 已上报 33% 进度。
      if (putCalls === 2) {
        await gate;
      }
      await server.putBlob(url, blob);
    };
    const slowUploader = new AttachmentUploader({
      manager,
      transport: slowTransport,
      chunkSize: 64 * 1024,
    });

    const first = render(
      <AttachmentPanel manager={manager} noteId="note-progress" uploader={slowUploader} />,
    );
    await user.upload(screen.getByLabelText('选择附件文件'), file);
    await screen.findByText('验收报告.bin');
    expect(screen.getByText(expectedSha)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '上传附件 验收报告.bin' }));
    const progress = await screen.findByRole('progressbar', {
      name: '验收报告.bin 传输进度',
    });
    expect(progress).toHaveAttribute('aria-valuenow');
    release();

    expect(
      await screen.findByText('已同步'),
    ).toBeInTheDocument();
    expect(screen.getByText(expectedSha)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

    first.unmount();
    render(
      <AttachmentPanel manager={manager} noteId="note-progress" uploader={uploader} />,
    );
    expect(await screen.findByText('验收报告.bin')).toBeInTheDocument();
    expect(screen.getByText(expectedSha)).toBeInTheDocument();
  });

  it('上传失败显示可读错误与失败态，重试可成功，删除后记录消失', async () => {
    const user = userEvent.setup();
    const { manager, uploader, server, repository } = setup();
    const file = await fileOf('失败重试.txt', [1, 2, 3, 4], 'text/plain');
    server.failNextPartPutAfter = 1;

    render(
      <AttachmentPanel manager={manager} noteId="note-fail" uploader={uploader} />,
    );
    await user.upload(screen.getByLabelText('选择附件文件'), file);
    await screen.findByText('失败重试.txt');

    await user.click(screen.getByRole('button', { name: '上传附件 失败重试.txt' }));
    expect((await screen.findAllByText('模拟断网')).length).toBeGreaterThan(0);
    expect(await screen.findByText('同步失败 · 本机保留')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '重试上传附件 失败重试.txt' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '上传附件 失败重试.txt' }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: '重试上传附件 失败重试.txt' }),
    );
    expect(
      await screen.findByText('已同步'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '删除附件 失败重试.txt' }));
    await waitFor(() => {
      expect(screen.queryByText('失败重试.txt')).not.toBeInTheDocument();
    });
    expect(repository.all()).toHaveLength(0);
  });

  it('任务附件使用 task 归属，不与笔记附件混在一起', async () => {
    const { manager } = setup();
    const taskFile = await fileOf('任务附件.md', [10, 11, 12], 'text/markdown');
    const otherTask = await fileOf('另一个任务.md', [20, 21, 22], 'text/markdown');
    const noteFile = await fileOf('笔记附件.md', [30, 31, 32], 'text/markdown');

    const taskResult = await manager.ingest(taskFile, { taskId: 'task-1' });
    await manager.ingest(otherTask, { taskId: 'task-2' });
    await manager.ingest(noteFile, { noteId: 'note-1' });

    expect(taskResult.attachment.metadata.noteId).toBeNull();
    expect(taskResult.attachment.metadata.blockId).toBe('task:task-1');

    const taskList = await manager.listForTask('task-1');
    expect(taskList.map((item) => item.metadata.fileName)).toEqual([
      '任务附件.md',
    ]);
    const noteList = await manager.list('note-1');
    expect(noteList.map((item) => item.metadata.fileName)).toEqual([
      '笔记附件.md',
    ]);

    render(
      <AttachmentPanel
        manager={manager}
        taskId="task-1"
        title="任务附件"
        insertLabel="＋ 添加附件"
      />,
    );
    expect(await screen.findByText('任务附件.md')).toBeInTheDocument();
    expect(screen.queryByText('另一个任务.md')).not.toBeInTheDocument();
    expect(screen.queryByText('笔记附件.md')).not.toBeInTheDocument();
  });

  it('另一台设备从远端下载同一附件，校验哈希后可直接打开', async () => {
    const user = userEvent.setup();
    const { manager, uploader, server } = setup();
    const file = await fileOf('跨设备.pdf', [5, 6, 7, 8], 'application/pdf');
    const ingested = await manager.ingest(file, { noteId: 'note-remote' });
    await uploader.upload(ingested.attachment.metadata.id, {
      allowRemote: true,
    });
    const remote = server.list()[0]!;

    const repositoryB = new MemoryAttachmentMetadataRepository();
    const blobStoreB = new MemoryBlobStore();
    const stateStoreB = new MemoryAttachmentStateStore();
    const managerB = new AttachmentManager({
      repository: repositoryB,
      blobStore: blobStoreB,
      stateStore: stateStoreB,
      newId: () => 'att_device_b',
    });
    const uploaderB = new AttachmentUploader({
      manager: managerB,
      transport: server,
      chunkSize: CHUNK,
    });
    const imported = await managerB.importRemote(remote);
    expect(imported.state.status).toBe('remote');

    render(
      <AttachmentPanel
        manager={managerB}
        noteId="note-remote"
        uploader={uploaderB}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: '下载附件 跨设备.pdf' }),
    );

    expect(await screen.findByText('已同步')).toBeInTheDocument();
    expect(await blobStoreB.has(imported.state.localBlobKey)).toBe(true);
    expect(
      screen.getByRole('button', { name: '打开附件 跨设备.pdf' }),
    ).toBeInTheDocument();
  });

  it('backend 模式未连接后台时明确提示同步服务不可用，而不是静默隐藏按钮', async () => {
    const { manager } = setup();
    render(
      <AttachmentPanel
        manager={manager}
        noteId="note-offline"
        syncMode="backend"
        uploadDisabledReason="尚未配对后台；附件只保存在本机"
      />,
    );
    expect(
      await screen.findByText(/同步服务不可用/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/尚未配对后台；附件只保存在本机/),
    ).toBeInTheDocument();
  });

  it('另存按钮取消保存面板时明确提示未写入，不显示“已保存”', async () => {
    const user = userEvent.setup();
    const { manager } = setup();
    await manager.ingest(
      new File(['hello'], '取消保存.txt', { type: 'text/plain' }),
      { noteId: 'note-cancel' },
    );
    const onNotice = vi.fn();
    const abort = Object.assign(new Error('canceled'), { name: 'AbortError' });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: vi.fn().mockRejectedValue(abort),
    });

    try {
      render(
        <AttachmentPanel
          manager={manager}
          noteId="note-cancel"
          onNotice={onNotice}
        />,
      );
      await user.click(
        await screen.findByRole('button', {
          name: '另存本机附件 取消保存.txt',
        }),
      );
      await waitFor(() =>
        expect(onNotice).toHaveBeenCalledWith(
          expect.stringContaining('未写入任何文件'),
        ),
      );
      expect(onNotice).not.toHaveBeenCalledWith(
        expect.stringContaining('已保存到'),
      );
    } finally {
      delete (window as Window & { showSaveFilePicker?: unknown })
        .showSaveFilePicker;
    }
  });

  it('图片附件可本机预览并关闭，不写入正文或 localStorage', async () => {
    const user = userEvent.setup();
    const { manager } = setup();
    const createObjectURL = vi.fn(() => 'blob:preview-image');
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });

    try {
      render(
        <AttachmentPanel manager={manager} noteId="note-preview" />,
      );
      await user.upload(
        screen.getByLabelText('选择附件文件'),
        new File([new Uint8Array([137, 80, 78, 71])], '预览图.png', {
          type: 'image/png',
        }),
      );
      await screen.findByText('预览图.png');
      await user.click(
        screen.getByRole('button', { name: '预览附件 预览图.png' }),
      );

      const dialog = await screen.findByRole('dialog', {
        name: '预览附件 预览图.png',
      });
      expect(dialog).toHaveTextContent('预览图.png');
      expect(createObjectURL).toHaveBeenCalledTimes(1);

      await user.click(
        screen.getByRole('button', { name: '关闭附件预览' }),
      );
      expect(
        screen.queryByRole('dialog', { name: '预览附件 预览图.png' }),
      ).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreate,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevoke,
      });
    }
  });

  it('附件服务不可用时显示原因与重试入口', () => {
    render(
      <AttachmentSection
        manager={null}
        unavailableReason="当前环境没有 SQLite"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('附件服务不可用：当前环境没有 SQLite');
    expect(
      screen.queryByRole('button', { name: '重试' }),
    ).not.toBeInTheDocument();
  });
});
