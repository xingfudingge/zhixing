/**
 * 测试用内存附件服务器。严格模拟真实协议：
 * - `init` 以 (spaceId, sha256) 去重；
 * - `upload-session` 依据已存在的分片返回缺失部分；
 * - `upload-complete` 逐片校验大小/哈希；
 * - `download-manifest` 返回全部分片。
 */

import type {
  AttachmentTransport,
  CompleteUploadInput,
  InitAttachmentInput,
  InitAttachmentResult,
} from '../api';
import { parseRemoteAttachment } from '../api';
import { sha256Blob } from '../sha256';
import type {
  AttachmentPart,
  DownloadManifest,
  RemoteAttachment,
  UploadSession,
} from '../types';
import {
  completeStorageKey,
  normalizeChunkSize,
  partStorageKey,
  partCountFor,
  partSizeFor,
} from '../uploadPlan';

type StoredPart = { blob: Blob; sha256: string };

export class FakeAttachmentServer implements AttachmentTransport {
  readonly attachments = new Map<string, RemoteAttachment>();
  readonly parts = new Map<string, Map<number, StoredPart>>();
  readonly complete = new Map<string, Blob>();
  readonly uploads: { key: string; size: number }[] = [];
  failNextPartPutAfter: number | null = null;
  partPutCount = 0;
  initCalls = 0;
  sessionCalls = 0;
  completeCalls = 0;

  private idFor(sha256: string): string {
    return `srv_${sha256.slice(0, 16)}`;
  }

  async initAttachment(input: InitAttachmentInput): Promise<InitAttachmentResult> {
    this.initCalls += 1;
    const id = this.idFor(input.sha256);
    const existing = this.attachments.get(id);
    if (existing) {
      return {
        attachment: { ...existing },
        uploadUrl: null,
        alreadyAvailable: existing.status === 'available',
      };
    }
    const now = new Date().toISOString();
    const attachment: RemoteAttachment = {
      id,
      spaceId: input.spaceId ?? 'personal',
      noteId: input.noteId,
      blockId: input.blockId,
      fileName: input.fileName,
      sha256: input.sha256,
      byteSize: input.byteSize,
      mime: input.mime,
      storageKey: `spaces/${input.spaceId ?? 'personal'}/assets/${input.sha256}`,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.attachments.set(id, attachment);
    this.parts.set(id, new Map());
    return { attachment: { ...attachment }, uploadUrl: null, alreadyAvailable: false };
  }

  async createSession(remoteId: string, chunkSize: number): Promise<UploadSession> {
    this.sessionCalls += 1;
    const attachment = this.attachments.get(remoteId);
    if (!attachment) throw new Error('附件不存在');
    const size = normalizeChunkSize(chunkSize);
    const partCount = partCountFor(attachment.byteSize, size);
    const stored = this.parts.get(remoteId) ?? new Map();
    const present: number[] = [];
    const missing: { index: number; size: number; url: string }[] = [];
    for (let index = 0; index < partCount; index += 1) {
      if (stored.has(index)) {
        present.push(index);
      } else {
        missing.push({
          index,
          size: partSizeFor(attachment.byteSize, index, size),
          url: `mem://put/${remoteId}/${index}`,
        });
      }
    }
    return {
      chunkSize: size,
      partCount,
      presentPartIndexes: present,
      missingParts: missing,
      completeUrl: `mem://complete/${remoteId}`,
      completeKey: completeStorageKey(attachment.sha256, attachment.spaceId),
      alreadyAvailable: attachment.status === 'available',
    };
  }

  async putBlob(url: string, blob: Blob): Promise<void> {
    if (url.startsWith('mem://part/')) {
      const [remoteId, indexRaw] = url.slice('mem://part/'.length).split('/');
      const index = Number(indexRaw);
      const sha256 = await sha256Blob(blob);
      this.parts.get(remoteId!)?.set(index, { blob, sha256 });
    } else if (url.startsWith('mem://put/')) {
      this.partPutCount += 1;
      const [remoteId, indexRaw] = url.slice('mem://put/'.length).split('/');
      const index = Number(indexRaw);
      const sha256 = await sha256Blob(blob);
      const bucket = this.parts.get(remoteId!) ?? new Map<number, StoredPart>();
      bucket.set(index, { blob, sha256 });
      this.parts.set(remoteId!, bucket);
      this.uploads.push({ key: partStorageKey('0'.repeat(64), index), size: blob.size });
      if (
        this.failNextPartPutAfter !== null &&
        this.partPutCount >= this.failNextPartPutAfter
      ) {
        this.failNextPartPutAfter = null;
        throw new Error('模拟断网');
      }
    } else if (url.startsWith('mem://complete/')) {
      const remoteId = url.slice('mem://complete/'.length);
      this.complete.set(remoteId, blob);
    } else {
      throw new Error(`未知上传地址 ${url}`);
    }
  }

  async completeUpload(
    remoteId: string,
    input: CompleteUploadInput,
  ): Promise<RemoteAttachment> {
    this.completeCalls += 1;
    const attachment = this.attachments.get(remoteId);
    if (!attachment) throw new Error('附件不存在');
    const stored = this.parts.get(remoteId) ?? new Map();
    if (input.parts.length !== input.partCount) {
      throw new Error('分片数量不一致');
    }
    for (const part of input.parts) {
      const item = stored.get(part.index);
      if (!item) throw new Error(`缺少分片 ${part.index}`);
      if (item.blob.size !== part.size) throw new Error(`分片 ${part.index} 大小不一致`);
      if (item.sha256 !== part.sha256) throw new Error(`分片 ${part.index} 哈希不一致`);
    }
    const updated: RemoteAttachment = {
      ...attachment,
      status: 'available',
      updatedAt: new Date().toISOString(),
    };
    this.attachments.set(remoteId, updated);
    return { ...updated };
  }

  async downloadManifest(
    remoteId: string,
    requestedChunkSize = 4 * 1024 * 1024,
  ): Promise<DownloadManifest> {
    const attachment = this.attachments.get(remoteId);
    if (!attachment) throw new Error('附件不存在');
    if (attachment.status !== 'available') throw new Error('附件尚未上传完成');
    const stored = this.parts.get(remoteId) ?? new Map();
    const chunkSize = normalizeChunkSize(requestedChunkSize);
    const partCount = partCountFor(attachment.byteSize, chunkSize);
    const parts = Array.from({ length: partCount }, (_, index) => {
      if (!stored.has(index)) throw new Error(`缺少分片 ${index}`);
      return {
        index,
        size: partSizeFor(attachment.byteSize, index, chunkSize),
        url: `mem://part/${remoteId}/${index}`,
      };
    });
    return {
      attachment: { ...attachment },
      chunkSize,
      partCount,
      parts,
    };
  }

  async getBlob(url: string): Promise<Blob> {
    if (!url.startsWith('mem://part/')) throw new Error('未知下载地址');
    const [remoteId, indexRaw] = url.slice('mem://part/'.length).split('/');
    const item = this.parts.get(remoteId!)?.get(Number(indexRaw));
    if (!item) throw new Error('分片不存在');
    return item.blob;
  }

  /** 测试辅助：篡改一个分片，模拟对象存储损坏。 */
  async corruptPart(remoteId: string, index: number, replacement: Blob): Promise<void> {
    const bucket = this.parts.get(remoteId);
    if (!bucket) throw new Error('附件不存在');
    const sha256 = await sha256Blob(replacement);
    bucket.set(index, { blob: replacement, sha256 });
  }

  remote(remoteId: string): RemoteAttachment {
    const attachment = this.attachments.get(remoteId);
    if (!attachment) throw new Error('附件不存在');
    return parseRemoteAttachment(attachment);
  }

  partsFor(remoteId: string): Map<number, StoredPart> {
    return this.parts.get(remoteId) ?? new Map();
  }

  /** 用于构造另一台设备的 importRemote。 */
  list(): RemoteAttachment[] {
    return Array.from(this.attachments.values()).map((row) => ({ ...row }));
  }
}

export function createFakeTransport(): FakeAttachmentServer {
  return new FakeAttachmentServer();
}

export type { AttachmentPart };
