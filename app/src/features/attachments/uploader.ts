/**
 * 附件上传/下载队列。
 *
 * 上传协议是可续传的：每次上传都重新申请会话，服务端 HEAD 每个分片，
 * 只返回缺失分片的预签名 URL。客户端崩溃或断网后不会从头再传。
 *
 * 下载同理：先取清单，再逐片下载，合并后校验整体 SHA-256；校验失败不会
 * 写入本机，避免把坏文件伪装成“可用”。
 */

import {
  ATTACHMENT_COMPLETE_CONTENT_TYPE,
  ATTACHMENT_PART_CONTENT_TYPE,
  initInputFromMetadata,
  type AttachmentTransport,
} from './api';
import type { AttachmentManager } from './manager';
import { RemoteUploadNotAllowedError } from './manager';
import { sha256Blob } from './sha256';
import {
  isImageAttachment,
  type AttachmentPart,
  type AttachmentProgress,
  type StoredAttachment,
} from './types';
import {
  DEFAULT_CHUNK_SIZE,
  createCompleteManifest,
  completeManifestBlob,
  normalizeChunkSize,
  sliceAttachment,
} from './uploadPlan';

export type UploadOptions = {
  /** 图片必须显式传 true；普通文件也需要由用户点“上传”触发。 */
  allowRemote?: boolean;
  chunkSize?: number;
  onProgress?: (progress: AttachmentProgress) => void;
};

export type DownloadOptions = {
  chunkSize?: number;
  onProgress?: (progress: AttachmentProgress) => void;
};

export class AttachmentUploader {
  private readonly manager: AttachmentManager;
  private readonly transport: AttachmentTransport;
  private readonly defaultChunkSize: number;

  constructor(options: {
    manager: AttachmentManager;
    transport: AttachmentTransport;
    chunkSize?: number;
  }) {
    this.manager = options.manager;
    this.transport = options.transport;
    this.defaultChunkSize = normalizeChunkSize(
      options.chunkSize ?? DEFAULT_CHUNK_SIZE,
    );
  }

  async upload(id: string, options: UploadOptions = {}): Promise<StoredAttachment> {
    const current = await this.manager.get(id);
    const metadata = current.metadata;
    if (
      isImageAttachment(metadata) &&
      current.state.status !== 'available' &&
      options.allowRemote !== true
    ) {
      throw new RemoteUploadNotAllowedError(
        '图片默认不上传远程；请显式确认“上传图片到服务器”',
      );
    }

    const { blob } = await this.manager.open(id);
    await this.manager.setStatus(id, 'uploading');
    const chunkSize = normalizeChunkSize(options.chunkSize ?? this.defaultChunkSize);

    try {
      const init = await this.transport.initAttachment(
        initInputFromMetadata(metadata),
      );
      const remote = init.attachment;
      if (remote.sha256 !== metadata.sha256 || remote.byteSize !== metadata.byteSize) {
        throw new Error('服务端附件元数据与本地不一致，已停止上传');
      }
      await this.manager.updateState(id, {
        status: 'uploading',
        remoteId: remote.id,
        lastError: null,
      });
      if (init.alreadyAvailable || remote.status === 'available') {
        return this.manager.markUploaded(id, remote);
      }

      const session = await this.transport.createSession(remote.id, chunkSize);
      const effectiveChunkSize = normalizeChunkSize(session.chunkSize);
      const localParts = sliceAttachment(blob, effectiveChunkSize);
      if (localParts.length !== session.partCount) {
        throw new Error(
          `分片数量不一致：本地 ${localParts.length}，服务端 ${session.partCount}`,
        );
      }

      const partHashes: AttachmentPart[] = [];
      for (const part of localParts) {
        const partSha = await sha256Blob(part.blob);
        partHashes.push({
          index: part.index,
          size: part.blob.size,
          sha256: partSha,
        });
      }

      const uploaded = new Set(session.presentPartIndexes);
      for (const pending of session.missingParts) {
        const part = localParts[pending.index];
        if (!part) {
          throw new Error(`服务端请求了不存在的分片 ${pending.index}`);
        }
        if (part.blob.size !== pending.size) {
          throw new Error(`分片 ${pending.index} 大小与服务端期望不一致`);
        }
        await this.transport.putBlob(
          pending.url,
          part.blob,
          ATTACHMENT_PART_CONTENT_TYPE,
        );
        uploaded.add(pending.index);
        const completedBytes = partHashes
          .filter((item) => uploaded.has(item.index))
          .reduce((sum, item) => sum + item.size, 0);
        await this.manager.updateState(id, {
          status: 'uploading',
          uploadedPartIndexes: Array.from(uploaded).sort((a, b) => a - b),
          lastError: null,
        });
        options.onProgress?.({
          attachmentId: id,
          phase: 'uploading',
          completedBytes,
          totalBytes: metadata.byteSize,
          partIndex: pending.index,
          partCount: session.partCount,
        });
      }

      const manifest = createCompleteManifest({
        sha256: metadata.sha256,
        byteSize: metadata.byteSize,
        chunkSize: effectiveChunkSize,
        parts: partHashes,
      });
      const completeBlob = completeManifestBlob(manifest);
      const completeSha = await sha256Blob(completeBlob);
      await this.transport.putBlob(
        session.completeUrl,
        completeBlob,
        ATTACHMENT_COMPLETE_CONTENT_TYPE,
      );
      options.onProgress?.({
        attachmentId: id,
        phase: 'verifying',
        completedBytes: metadata.byteSize,
        totalBytes: metadata.byteSize,
        partCount: session.partCount,
      });

      const completed = await this.transport.completeUpload(remote.id, {
        chunkSize: effectiveChunkSize,
        partCount: session.partCount,
        completeSha256: completeSha,
        parts: partHashes,
      });
      if (
        completed.sha256 !== metadata.sha256 ||
        completed.byteSize !== metadata.byteSize
      ) {
        throw new Error('服务端校验后的附件哈希与本地不一致');
      }
      return this.manager.markUploaded(id, completed);
    } catch (reason) {
      await this.manager.markFailed(id, reason);
      throw reason;
    }
  }

  async download(
    id: string,
    options: DownloadOptions = {},
  ): Promise<StoredAttachment> {
    const current = await this.manager.get(id);
    const remoteId = current.state.remoteId ?? current.metadata.id;
    await this.manager.setStatus(id, 'downloading');
    const chunkSize = normalizeChunkSize(
      options.chunkSize ?? this.defaultChunkSize,
    );

    try {
      const manifest = await this.transport.downloadManifest(remoteId, chunkSize);
      const remote = manifest.attachment;
      if (
        remote.sha256 !== current.metadata.sha256 ||
        remote.byteSize !== current.metadata.byteSize
      ) {
        throw new Error('服务端附件哈希与本地元数据不一致，拒绝下载');
      }
      if (manifest.parts.length !== manifest.partCount) {
        throw new Error('下载清单缺少分片');
      }

      const blobs: Blob[] = [];
      let completedBytes = 0;
      for (const part of manifest.parts) {
        const blob = await this.transport.getBlob(part.url);
        if (blob.size !== part.size) {
          throw new Error(
            `分片 ${part.index} 大小不一致：期望 ${part.size}，实际 ${blob.size}`,
          );
        }
        blobs.push(blob);
        completedBytes += blob.size;
        options.onProgress?.({
          attachmentId: id,
          phase: 'downloading',
          completedBytes,
          totalBytes: current.metadata.byteSize,
          partIndex: part.index,
          partCount: manifest.partCount,
        });
      }

      const merged = new Blob(blobs, { type: current.metadata.mime });
      if (merged.size !== current.metadata.byteSize) {
        throw new Error('下载合并后的附件大小与元数据不一致');
      }
      const actual = await sha256Blob(merged);
      if (actual !== current.metadata.sha256) {
        throw new Error(
          `下载校验失败：期望 ${current.metadata.sha256}，实际 ${actual}`,
        );
      }
      await this.manager.storeDownloadedBlob(
        current.metadata,
        merged,
        remoteId,
      );
      return this.manager.get(id);
    } catch (reason) {
      await this.manager.markFailed(id, reason);
      throw reason;
    }
  }

  /** 测试/诊断：确认本机已缓存的内容与元数据一致。 */
  async verifyLocal(id: string): Promise<boolean> {
    const { metadata } = await this.manager.get(id);
    const { blob } = await this.manager.open(id);
    const actual = await sha256Blob(blob);
    return actual === metadata.sha256 && blob.size === metadata.byteSize;
  }

  /** 给 UI 展示：本机 Blob 是否存在。 */
  async hasLocal(id: string): Promise<boolean> {
    try {
      await this.manager.open(id, { verify: false });
      return true;
    } catch {
      return false;
    }
  }
}

export function createAttachmentUploader(options: {
  manager: AttachmentManager;
  transport: AttachmentTransport;
  chunkSize?: number;
}): AttachmentUploader {
  return new AttachmentUploader(options);
}
