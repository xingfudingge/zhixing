import { describe, expect, it } from 'vitest';

import {
  MemoryAttachmentStateStore,
  MemoryBlobStore,
} from '../blobStore';
import { AttachmentManager } from '../manager';
import { MemoryAttachmentMetadataRepository } from '../repository';
import { sha256Blob } from '../sha256';
import { bytesKey, defaultState, type AttachmentSyncMode } from '../types';

function setup(mode: AttachmentSyncMode = 'local') {
  const repository = new MemoryAttachmentMetadataRepository();
  const blobStore = new MemoryBlobStore();
  const stateStore = new MemoryAttachmentStateStore();
  let sequence = 0;
  const manager = new AttachmentManager({
    repository,
    blobStore,
    stateStore,
    now: () => '2026-10-26T10:00:00.000Z',
    newId: () => `att_${++sequence}`,
    getSyncMode: () => mode,
  });
  return { manager, repository, blobStore, stateStore, mode };
}

async function docxFile(): Promise<File> {
  return new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], '项目方案.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

describe('AttachmentManager：离线插入与本机打开', () => {
  it('插入 DOCX 后本机可打开，状态为本机已保存，且没有网络调用', async () => {
    const { manager, blobStore } = setup();
    const file = await docxFile();
    const expected = await sha256Blob(file);

    const result = await manager.ingest(file, { noteId: 'note-1', blockId: 'block-1' });

    expect(result.attachment.metadata).toMatchObject({
      noteId: 'note-1',
      blockId: 'block-1',
      fileName: '项目方案.docx',
      sha256: expected,
      byteSize: file.size,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      storageKey: `spaces/personal/assets/${expected}`,
    });
    expect(result.attachment.state.status).toBe('local');
    expect(await blobStore.has(bytesKey(expected))).toBe(true);

    const opened = await manager.open(result.attachment.metadata.id);
    expect(opened.blob.size).toBe(file.size);
    expect(new Uint8Array(await opened.blob.arrayBuffer())).toEqual(
      new Uint8Array(await file.arrayBuffer()),
    );
  });

  it('backend/WebDAV 模式插入也先写本机 local，只有显式 markPending 才进入待同步', async () => {
    for (const mode of ['webdav', 'backend'] as const) {
      const { manager } = setup(mode);
      const file = await docxFile();
      const result = await manager.ingest(file, { noteId: `note-${mode}` });

      expect(result.attachment.state.status).toBe('local');
      expect(await manager.hasLocalBlob(result.attachment.metadata.id)).toBe(
        true,
      );

      const pending = await manager.markPending(result.attachment.metadata.id);
      expect(pending.state.status).toBe('pending');
      expect(await manager.hasLocalBlob(result.attachment.metadata.id)).toBe(
        true,
      );
    }
  });

  it('同内容同笔记重复插入只保留一条元数据与一份 Blob', async () => {
    const { manager, repository, blobStore } = setup();
    const file = await docxFile();
    const first = await manager.ingest(file, { noteId: 'note-1' });
    const second = await manager.ingest(file, { noteId: 'note-1' });

    expect(repository.all()).toHaveLength(1);
    expect(second.attachment.metadata.id).toBe(first.attachment.metadata.id);
    expect(second.reusedBlob).toBe(true);
    expect(blobStore.keys()).toHaveLength(1);
    expect(second.attachment.state.status).toBe('local');
  });

  it('状态记录丢失时仍能通过元数据哈希找到本机 Blob', async () => {
    const { manager, stateStore } = setup();
    const file = await docxFile();
    const { attachment } = await manager.ingest(file, { noteId: 'note-1' });

    await stateStore.delete(attachment.metadata.id);

    expect(await manager.hasLocalBlob(attachment.metadata.id)).toBe(true);
    expect((await manager.get(attachment.metadata.id)).state.status).toBe(
      'local',
    );
  });

  it('重命名只更新同一条附件元数据，不改 Blob 与状态', async () => {
    const { manager } = setup();
    const file = await docxFile();
    const { attachment } = await manager.ingest(file, { noteId: 'note-1' });

    const renamed = await manager.rename(attachment.metadata.id, '  新方案.docx  ');

    expect(renamed.metadata.id).toBe(attachment.metadata.id);
    expect(renamed.metadata.fileName).toBe('新方案.docx');
    expect(renamed.state.status).toBe('local');
    expect(await manager.hasLocalBlob(attachment.metadata.id)).toBe(true);
  });

  it('打开时检测本机内容被篡改，并标记失败', async () => {
    const { manager, blobStore } = setup();
    const file = await docxFile();
    const { attachment } = await manager.ingest(file, { noteId: 'note-1' });
    await blobStore.put(
      bytesKey(attachment.metadata.sha256),
      new Blob(['tampered']),
    );

    await expect(manager.open(attachment.metadata.id)).rejects.toMatchObject({
      name: 'AttachmentIntegrityError',
    });
    const after = await manager.get(attachment.metadata.id);
    expect(after.state.status).toBe('failed');
    expect(after.state.lastError).toContain('哈希不一致');
  });

  it('不同笔记引用同一内容时复用同一条附件记录与一份 Blob', async () => {
    const { manager, repository, blobStore } = setup();
    const file = await docxFile();
    const first = await manager.ingest(file, { noteId: 'note-1' });
    const second = await manager.ingest(file, { noteId: 'note-2' });

    expect(second.attachment.metadata.id).toBe(first.attachment.metadata.id);
    expect(repository.all()).toHaveLength(1);
    expect(blobStore.keys()).toHaveLength(1);
    expect(await manager.hasLocalBlob(second.attachment.metadata.id)).toBe(true);
  });

  it('远端导入且本机无 Blob 时状态为“仅远端可用”', async () => {
    const { manager } = setup();
    const sha = 'a'.repeat(64);
    const imported = await manager.importRemote({
      id: 'srv_1',
      spaceId: 'personal',
      noteId: 'note-9',
      blockId: null,
      fileName: '远端.pdf',
      sha256: sha,
      byteSize: 10,
      mime: 'application/pdf',
      storageKey: `spaces/personal/assets/${sha}`,
      status: 'available',
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
    });
    expect(imported.state.status).toBe('remote');
    expect(imported.state.lastError).toContain('下载');
  });
});

describe('AttachmentManager：旧 pending 数据按同步模式迁移', () => {
  it('local 模式下旧 pending 记录变为本机已保存，Blob 仍可打开', async () => {
    const { manager, stateStore, blobStore } = setup('local');
    const file = await docxFile();
    const { attachment } = await manager.ingest(file, { noteId: 'note-legacy' });

    await stateStore.put({
      ...defaultState(attachment.metadata.id, bytesKey(attachment.metadata.sha256), '2026-10-01T00:00:00.000Z'),
      status: 'pending',
      lastError: null,
    });

    const migrated = await manager.get(attachment.metadata.id);
    expect(migrated.state.status).toBe('local');
    expect(migrated.state.lastError).toBeNull();
    expect(await blobStore.has(bytesKey(attachment.metadata.sha256))).toBe(true);
    const opened = await manager.open(attachment.metadata.id);
    expect(opened.blob.size).toBe(file.size);
  });

  it('local 模式下旧 pending 但 Blob 缺失时标为 missing，不丢元数据', async () => {
    const { manager, stateStore, repository, blobStore } = setup('local');
    const file = await docxFile();
    const { attachment } = await manager.ingest(file, { noteId: 'note-legacy' });

    // 模拟 Blob 被清理：内容寻址键与状态行都指向不存在的内容。
    await blobStore.delete(bytesKey(attachment.metadata.sha256));
    await stateStore.put({
      ...defaultState(attachment.metadata.id, bytesKey(attachment.metadata.sha256), '2026-10-01T00:00:00.000Z'),
      status: 'pending',
      lastError: null,
      localBlobKey: 'attachments/not-present',
    });

    const migrated = await manager.get(attachment.metadata.id);
    expect(migrated.state.status).toBe('missing');
    expect(migrated.state.lastError).toContain('本机没有这个文件');
    expect(await repository.get(attachment.metadata.id)).toMatchObject({
      fileName: '项目方案.docx',
    });
  });

  it('backend/WebDAV 模式保留 pending，显示为待同步', async () => {
    const { manager, stateStore } = setup('backend');
    const file = await docxFile();
    const { attachment } = await manager.ingest(file, { noteId: 'note-legacy' });

    await stateStore.put({
      ...defaultState(attachment.metadata.id, bytesKey(attachment.metadata.sha256), '2026-10-01T00:00:00.000Z'),
      status: 'pending',
    });

    const migrated = await manager.get(attachment.metadata.id);
    expect(migrated.state.status).toBe('pending');
  });

  it('批量迁移只改与模式矛盾的记录，并返回迁移数量', async () => {
    const { manager, stateStore } = setup('local');
    const file = await docxFile();
    const first = await manager.ingest(file, { noteId: 'note-a' });
    const secondFile = new File([new Uint8Array([9, 9, 9])], '另一份.pdf', {
      type: 'application/pdf',
    });
    const second = await manager.ingest(secondFile, { noteId: 'note-b' });

    await stateStore.put({
      ...defaultState(first.attachment.metadata.id, bytesKey(first.attachment.metadata.sha256), '2026-10-01T00:00:00.000Z'),
      status: 'pending',
    });
    await stateStore.put({
      ...defaultState(second.attachment.metadata.id, bytesKey(second.attachment.metadata.sha256), '2026-10-01T00:00:00.000Z'),
      status: 'local',
    });

    expect(await manager.migrateLegacyStates()).toBe(1);
    expect((await manager.get(first.attachment.metadata.id)).state.status).toBe('local');
    expect((await manager.get(second.attachment.metadata.id)).state.status).toBe('local');
  });
});
