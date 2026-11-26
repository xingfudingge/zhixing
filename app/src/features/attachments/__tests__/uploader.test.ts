import { describe, expect, it } from 'vitest';

import {
  MemoryAttachmentStateStore,
  MemoryBlobStore,
} from '../blobStore';
import { AttachmentManager, RemoteUploadNotAllowedError } from '../manager';
import { MemoryAttachmentMetadataRepository } from '../repository';
import { sha256Blob } from '../sha256';
import { AttachmentUploader } from '../uploader';
import { createFakeTransport } from './fakeTransport';

const CHUNK = 64 * 1024;

function device(prefix: string) {
  const repository = new MemoryAttachmentMetadataRepository();
  const blobStore = new MemoryBlobStore();
  const stateStore = new MemoryAttachmentStateStore();
  let sequence = 0;
  const manager = new AttachmentManager({
    repository,
    blobStore,
    stateStore,
    now: () => new Date().toISOString(),
    newId: () => `${prefix}_${++sequence}`,
  });
  return { manager, repository, blobStore, stateStore };
}

function makeFile(size: number, name = '资料.bin'): File {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 7 + 13) % 256;
  }
  return new File([bytes], name, { type: 'application/octet-stream' });
}

describe('附件分片上传、续传与跨设备下载', () => {
  it('上传后另一台设备下载并校验整体哈希一致', async () => {
    const server = createFakeTransport();
    const a = device('a');
    const uploaderA = new AttachmentUploader({
      manager: a.manager,
      transport: server,
      chunkSize: CHUNK,
    });
    const file = makeFile(200_000, '合同.pdf');
    const ingested = await a.manager.ingest(file, { noteId: 'note-1' });
    expect(ingested.attachment.state.status).toBe('local');

    const uploaded = await uploaderA.upload(ingested.attachment.metadata.id, {
      chunkSize: CHUNK,
      allowRemote: true,
    });
    expect(uploaded.state.status).toBe('available');
    expect(uploaded.state.remoteId).toBeTruthy();
    const remote = server.remote(uploaded.state.remoteId!);
    expect(remote.sha256).toBe(uploaded.metadata.sha256);
    expect(remote.status).toBe('available');
    expect(server.partsFor(remote.id).size).toBe(4);

    const b = device('b');
    const imported = await b.manager.importRemote(remote);
    expect(imported.state.status).toBe('remote');
    const uploaderB = new AttachmentUploader({
      manager: b.manager,
      transport: server,
      chunkSize: CHUNK,
    });
    const downloaded = await uploaderB.download(imported.metadata.id, {
      chunkSize: CHUNK,
    });
    expect(downloaded.state.status).toBe('available');
    expect(await uploaderB.verifyLocal(imported.metadata.id)).toBe(true);
    const opened = await b.manager.open(imported.metadata.id);
    expect(await sha256Blob(opened.blob)).toBe(remote.sha256);
  });

  it('断点续传：第二次上传只补缺失分片', async () => {
    const server = createFakeTransport();
    const a = device('r');
    const uploader = new AttachmentUploader({
      manager: a.manager,
      transport: server,
      chunkSize: CHUNK,
    });
    const file = makeFile(260_000, '大文件.zip');
    const ingested = await a.manager.ingest(file, { noteId: 'note-r' });
    server.failNextPartPutAfter = 2;

    await expect(
      uploader.upload(ingested.attachment.metadata.id, {
        chunkSize: CHUNK,
        allowRemote: true,
      }),
    ).rejects.toThrow('模拟断网');
    const failed = await a.manager.get(ingested.attachment.metadata.id);
    expect(failed.state.status).toBe('failed');
    const remoteId = failed.state.remoteId ?? server.list()[0]?.id;
    expect(remoteId).toBeTruthy();
    expect(server.partsFor(remoteId!).size).toBe(2);

    const before = server.partPutCount;
    const resumed = await uploader.upload(ingested.attachment.metadata.id, {
      chunkSize: CHUNK,
      allowRemote: true,
    });
    expect(resumed.state.status).toBe('available');
    expect(server.partPutCount - before).toBe(2);
    expect(server.partsFor(remoteId!).size).toBe(4);
  });

  it('图片默认拒绝上传，显式允许后才发起', async () => {
    const server = createFakeTransport();
    const a = device('i');
    const uploader = new AttachmentUploader({ manager: a.manager, transport: server });
    const image = new File([new Uint8Array([137, 80, 78, 71])], '截图.png', {
      type: 'image/png',
    });
    const ingested = await a.manager.ingest(image, { noteId: 'note-i' });

    await expect(
      uploader.upload(ingested.attachment.metadata.id),
    ).rejects.toBeInstanceOf(RemoteUploadNotAllowedError);
    expect(server.initCalls).toBe(0);

    const uploaded = await uploader.upload(ingested.attachment.metadata.id, {
      allowRemote: true,
    });
    expect(uploaded.state.status).toBe('available');
    expect(server.initCalls).toBe(1);
  });

  it('下载内容损坏时拒绝落盘并标记失败', async () => {
    const server = createFakeTransport();
    const a = device('c');
    const uploaderA = new AttachmentUploader({
      manager: a.manager,
      transport: server,
      chunkSize: CHUNK,
    });
    const file = makeFile(130_000, '校验.bin');
    const ingested = await a.manager.ingest(file, { noteId: 'note-c' });
    const uploaded = await uploaderA.upload(ingested.attachment.metadata.id, {
      chunkSize: CHUNK,
      allowRemote: true,
    });
    const remoteId = uploaded.state.remoteId!;
    await server.corruptPart(remoteId, 1, new Blob([new Uint8Array(64_464).fill(9)]));

    const b = device('c2');
    const imported = await b.manager.importRemote(server.remote(remoteId));
    const uploaderB = new AttachmentUploader({
      manager: b.manager,
      transport: server,
      chunkSize: CHUNK,
    });
    await expect(
      uploaderB.download(imported.metadata.id, { chunkSize: CHUNK }),
    ).rejects.toThrow(/校验失败/);

    const after = await b.manager.get(imported.metadata.id);
    expect(after.state.status).toBe('failed');
    expect(await uploaderB.hasLocal(imported.metadata.id)).toBe(false);
  });
});
