/**
 * 后台附件协议客户端。
 *
 * 二进制不经过应用服务器：先在 `/attachments/init` 写元数据，再向
 * `/attachments/:id/upload-session` 申请分片预签名 URL，分片直接 PUT 到
 * MinIO/S3；最后提交分片清单，服务端逐片回读校验后才标记 available。
 */

import type {
  AttachmentMetadata,
  AttachmentPart,
  DownloadManifest,
  RemoteAttachment,
  UploadSession,
} from './types';
import { DEFAULT_CHUNK_SIZE, normalizeChunkSize } from './uploadPlan';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class AttachmentApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'AttachmentApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export type InitAttachmentInput = {
  noteId: string | null;
  blockId: string | null;
  fileName: string;
  sha256: string;
  byteSize: number;
  mime: string;
  spaceId?: string;
};

export type InitAttachmentResult = {
  attachment: RemoteAttachment;
  uploadUrl: string | null;
  alreadyAvailable: boolean;
};

export type CompleteUploadInput = {
  chunkSize: number;
  partCount: number;
  completeSha256: string;
  parts: AttachmentPart[];
};

export type AttachmentTransport = {
  initAttachment(input: InitAttachmentInput): Promise<InitAttachmentResult>;
  createSession(
    remoteId: string,
    chunkSize: number,
  ): Promise<UploadSession>;
  putBlob(url: string, blob: Blob, contentType: string): Promise<void>;
  completeUpload(
    remoteId: string,
    input: CompleteUploadInput,
  ): Promise<RemoteAttachment>;
  downloadManifest(
    remoteId: string,
    chunkSize: number,
  ): Promise<DownloadManifest>;
  getBlob(url: string): Promise<Blob>;
};

const PART_CONTENT_TYPE = 'application/octet-stream';
const COMPLETE_CONTENT_TYPE = 'application/json';

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function apiBase(baseUrl: string): string {
  const root = normalizeBaseUrl(baseUrl);
  return root.endsWith('/api/v1') ? root : `${root}/api/v1`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new AttachmentApiError(502, 'BAD_RESPONSE', `服务端响应缺少 ${label}`, true);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AttachmentApiError(502, 'BAD_RESPONSE', `服务端响应缺少 ${label}`, true);
  }
  return value;
}

export function parseRemoteAttachment(value: unknown): RemoteAttachment {
  if (!isRecord(value)) {
    throw new AttachmentApiError(502, 'BAD_RESPONSE', '服务端附件元数据格式不正确', true);
  }
  const sha256 = requireString(value.sha256, 'sha256');
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new AttachmentApiError(502, 'BAD_RESPONSE', '服务端返回的 sha256 不合法', true);
  }
  const status = value.status;
  if (status !== 'pending' && status !== 'available' && status !== 'deleted') {
    throw new AttachmentApiError(502, 'BAD_RESPONSE', '服务端返回的附件状态不合法', true);
  }
  return {
    id: requireString(value.id, 'id'),
    spaceId:
      typeof value.spaceId === 'string' && value.spaceId ? value.spaceId : 'personal',
    noteId: typeof value.noteId === 'string' ? value.noteId : null,
    blockId: typeof value.blockId === 'string' ? value.blockId : null,
    fileName: requireString(value.fileName, 'fileName'),
    sha256,
    byteSize: requireNumber(value.byteSize, 'byteSize'),
    mime:
      typeof value.mime === 'string' && value.mime
        ? value.mime
        : 'application/octet-stream',
    storageKey: requireString(value.storageKey, 'storageKey'),
    status,
    createdAt: requireString(value.createdAt, 'createdAt'),
    updatedAt: requireString(value.updatedAt, 'updatedAt'),
  };
}

function parseUploadSession(value: unknown): UploadSession {
  if (!isRecord(value)) {
    throw new AttachmentApiError(502, 'BAD_RESPONSE', '上传会话格式不正确', true);
  }
  const missing = Array.isArray(value.missingParts)
    ? value.missingParts
        .filter(isRecord)
        .map((part) => ({
          index: requireNumber(part.index, 'missingParts.index'),
          size: requireNumber(part.size, 'missingParts.size'),
          url: requireString(part.url, 'missingParts.url'),
        }))
    : [];
  return {
    chunkSize: requireNumber(value.chunkSize, 'chunkSize'),
    partCount: requireNumber(value.partCount, 'partCount'),
    presentPartIndexes: Array.isArray(value.presentPartIndexes)
      ? value.presentPartIndexes.filter(
          (item): item is number => typeof item === 'number',
        )
      : [],
    missingParts: missing,
    completeUrl: requireString(value.completeUrl, 'completeUrl'),
    completeKey: requireString(value.completeKey, 'completeKey'),
    alreadyAvailable: value.alreadyAvailable === true,
  };
}

function parseDownloadManifest(value: unknown): DownloadManifest {
  if (!isRecord(value)) {
    throw new AttachmentApiError(502, 'BAD_RESPONSE', '下载清单格式不正确', true);
  }
  const parts = Array.isArray(value.parts)
    ? value.parts.filter(isRecord).map((part) => ({
        index: requireNumber(part.index, 'parts.index'),
        size: requireNumber(part.size, 'parts.size'),
        url: requireString(part.url, 'parts.url'),
      }))
    : [];
  parts.sort((a, b) => a.index - b.index);
  return {
    attachment: parseRemoteAttachment(value.attachment),
    chunkSize: requireNumber(value.chunkSize, 'chunkSize'),
    partCount: requireNumber(value.partCount, 'partCount'),
    parts,
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const defaultFetch: FetchLike = (input, init) => {
  if (typeof fetch !== 'function') {
    return Promise.reject(
      new AttachmentApiError(0, 'NO_FETCH', '当前环境没有 fetch', false),
    );
  }
  return fetch(input, init);
};

export type HttpAttachmentApiOptions = {
  baseUrl: string;
  deviceId: string;
  deviceToken: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
};

export class HttpAttachmentApi implements AttachmentTransport {
  readonly rootUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly deviceId: string;
  private readonly token: string;

  constructor(options: HttpAttachmentApiOptions) {
    this.rootUrl = normalizeBaseUrl(options.baseUrl);
    this.deviceId = options.deviceId;
    this.token = options.deviceToken;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request<T>(path: string, options: {
    method?: 'GET' | 'POST';
    body?: unknown;
  } = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.token}`,
      'x-zx-device': this.deviceId,
    };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${apiBase(this.rootUrl)}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      const message =
        (error as Error)?.name === 'AbortError'
          ? '附件请求超时'
          : `网络不可达：${(error as Error)?.message ?? 'unknown'}`;
      throw new AttachmentApiError(0, 'NETWORK_ERROR', message, true);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!response.ok) {
      const error = isRecord(body) && isRecord(body.error) ? body.error : null;
      throw new AttachmentApiError(
        response.status,
        typeof error?.code === 'string' ? error.code : `HTTP_${response.status}`,
        typeof error?.message === 'string'
          ? error.message
          : `附件请求失败（HTTP ${response.status}）`,
        isRetryableStatus(response.status),
      );
    }
    return body as T;
  }

  async initAttachment(input: InitAttachmentInput): Promise<InitAttachmentResult> {
    const body = await this.request<unknown>('/attachments/init', {
      method: 'POST',
      body: input,
    });
    if (!isRecord(body)) {
      throw new AttachmentApiError(502, 'BAD_RESPONSE', '初始化附件响应格式不正确', true);
    }
    return {
      attachment: parseRemoteAttachment(body.attachment),
      uploadUrl: typeof body.uploadUrl === 'string' ? body.uploadUrl : null,
      alreadyAvailable: body.alreadyAvailable === true,
    };
  }

  async createSession(
    remoteId: string,
    chunkSize = DEFAULT_CHUNK_SIZE,
  ): Promise<UploadSession> {
    const body = await this.request<unknown>(
      `/attachments/${encodeURIComponent(remoteId)}/upload-session`,
      {
        method: 'POST',
        body: { chunkSize: normalizeChunkSize(chunkSize) },
      },
    );
    return parseUploadSession(body);
  }

  async putBlob(url: string, blob: Blob, contentType: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: blob,
      });
    } catch (error) {
      throw new AttachmentApiError(
        0,
        'UPLOAD_NETWORK_ERROR',
        `分片上传网络失败：${(error as Error)?.message ?? 'unknown'}`,
        true,
      );
    }
    if (!response.ok) {
      throw new AttachmentApiError(
        response.status,
        'UPLOAD_PART_FAILED',
        `分片上传失败（HTTP ${response.status}）`,
        isRetryableStatus(response.status),
      );
    }
  }

  async completeUpload(
    remoteId: string,
    input: CompleteUploadInput,
  ): Promise<RemoteAttachment> {
    const body = await this.request<unknown>(
      `/attachments/${encodeURIComponent(remoteId)}/upload-complete`,
      { method: 'POST', body: input },
    );
    if (!isRecord(body)) {
      throw new AttachmentApiError(502, 'BAD_RESPONSE', '完成上传响应格式不正确', true);
    }
    return parseRemoteAttachment(body.attachment);
  }

  async downloadManifest(
    remoteId: string,
    chunkSize = DEFAULT_CHUNK_SIZE,
  ): Promise<DownloadManifest> {
    const query = new URLSearchParams({
      chunkSize: String(normalizeChunkSize(chunkSize)),
    });
    const body = await this.request<unknown>(
      `/attachments/${encodeURIComponent(remoteId)}/download-manifest?${query.toString()}`,
    );
    return parseDownloadManifest(body);
  }

  async getBlob(url: string): Promise<Blob> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET' });
    } catch (error) {
      throw new AttachmentApiError(
        0,
        'DOWNLOAD_NETWORK_ERROR',
        `下载网络失败：${(error as Error)?.message ?? 'unknown'}`,
        true,
      );
    }
    if (!response.ok) {
      throw new AttachmentApiError(
        response.status,
        'DOWNLOAD_FAILED',
        `下载失败（HTTP ${response.status}）`,
        isRetryableStatus(response.status),
      );
    }
    return response.blob();
  }
}

export function createHttpAttachmentTransport(
  options: HttpAttachmentApiOptions,
): AttachmentTransport {
  return new HttpAttachmentApi(options);
}

export const ATTACHMENT_PART_CONTENT_TYPE = PART_CONTENT_TYPE;
export const ATTACHMENT_COMPLETE_CONTENT_TYPE = COMPLETE_CONTENT_TYPE;

/** 便于调用方把本地元数据转换成 init 请求。 */
export function initInputFromMetadata(
  metadata: Pick<
    AttachmentMetadata,
    'noteId' | 'blockId' | 'fileName' | 'sha256' | 'byteSize' | 'mime' | 'spaceId'
  >,
): InitAttachmentInput {
  return {
    noteId: metadata.noteId,
    blockId: metadata.blockId,
    fileName: metadata.fileName,
    sha256: metadata.sha256,
    byteSize: metadata.byteSize,
    mime: metadata.mime,
    spaceId: metadata.spaceId,
  };
}
