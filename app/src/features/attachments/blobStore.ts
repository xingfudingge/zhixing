/**
 * 附件二进制与上传状态的本地存储。
 *
 * 浏览器/Tauri WebView 使用 IndexedDB，避免把大文件塞进 localStorage。
 * 测试使用内存实现；调用方只依赖 `BlobStore` / `AttachmentStateStore`，
 * 后续切换到 Tauri 应用私有目录时无需改上传逻辑。
 */

import type { AttachmentState } from './types';

export class AttachmentStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AttachmentStorageError';
  }
}

export interface BlobStore {
  put(key: string, blob: Blob): Promise<void>;
  get(key: string): Promise<Blob | null>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export interface AttachmentStateStore {
  get(attachmentId: string): Promise<AttachmentState | null>;
  put(state: AttachmentState): Promise<void>;
  delete(attachmentId: string): Promise<void>;
  list(): Promise<AttachmentState[]>;
  clear(): Promise<void>;
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Blob>();

  async put(key: string, blob: Blob): Promise<void> {
    this.blobs.set(key, blob);
  }

  async get(key: string): Promise<Blob | null> {
    return this.blobs.get(key) ?? null;
  }

  async has(key: string): Promise<boolean> {
    return this.blobs.has(key);
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  /** 测试辅助。 */
  keys(): string[] {
    return Array.from(this.blobs.keys());
  }
}

export class MemoryAttachmentStateStore implements AttachmentStateStore {
  private readonly states = new Map<string, AttachmentState>();

  async get(attachmentId: string): Promise<AttachmentState | null> {
    const state = this.states.get(attachmentId);
    return state ? { ...state, uploadedPartIndexes: [...state.uploadedPartIndexes] } : null;
  }

  async put(state: AttachmentState): Promise<void> {
    this.states.set(state.attachmentId, {
      ...state,
      uploadedPartIndexes: [...state.uploadedPartIndexes],
    });
  }

  async delete(attachmentId: string): Promise<void> {
    this.states.delete(attachmentId);
  }

  async list(): Promise<AttachmentState[]> {
    return Array.from(this.states.values()).map((state) => ({
      ...state,
      uploadedPartIndexes: [...state.uploadedPartIndexes],
    }));
  }

  async clear(): Promise<void> {
    this.states.clear();
  }
}

export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

const BLOB_STORE = 'blobs';
const STATE_STORE = 'attachment_state';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new AttachmentStorageError('IndexedDB 请求失败', {
          cause: request.error,
        }),
      );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        new AttachmentStorageError('IndexedDB 事务失败', {
          cause: transaction.error,
        }),
      );
    transaction.onabort = () =>
      reject(
        new AttachmentStorageError('IndexedDB 事务已中止', {
          cause: transaction.error,
        }),
      );
  });
}

const dbPromises = new Map<string, Promise<IDBDatabase>>();

export function openAttachmentDb(
  dbName = 'zhixing-attachments',
): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(
      new AttachmentStorageError('当前环境没有 IndexedDB，附件只能留在内存'),
    );
  }
  const existing = dbPromises.get(dbName);
  if (existing) return existing;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE);
      }
      if (!db.objectStoreNames.contains(STATE_STORE)) {
        db.createObjectStore(STATE_STORE, { keyPath: 'attachmentId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new AttachmentStorageError('无法打开附件 IndexedDB', {
          cause: request.error,
        }),
      );
    request.onblocked = () =>
      reject(new AttachmentStorageError('附件 IndexedDB 被其他窗口占用'));
  });
  dbPromises.set(dbName, promise);
  return promise;
}

/** 测试/重置时释放缓存的连接。 */
export async function closeAttachmentDb(dbName = 'zhixing-attachments'): Promise<void> {
  const promise = dbPromises.get(dbName);
  if (!promise) return;
  dbPromises.delete(dbName);
  const db = await promise.catch(() => null);
  db?.close();
}

export class IndexedDbBlobStore implements BlobStore {
  constructor(private readonly dbName = 'zhixing-attachments') {}

  async put(key: string, blob: Blob): Promise<void> {
    const db = await openAttachmentDb(this.dbName);
    const transaction = db.transaction(BLOB_STORE, 'readwrite');
    transaction.objectStore(BLOB_STORE).put(blob, key);
    await transactionDone(transaction);
  }

  async get(key: string): Promise<Blob | null> {
    const db = await openAttachmentDb(this.dbName);
    const transaction = db.transaction(BLOB_STORE, 'readonly');
    const value = await requestToPromise(
      transaction.objectStore(BLOB_STORE).get(key),
    );
    return value instanceof Blob ? value : null;
  }

  async has(key: string): Promise<boolean> {
    const db = await openAttachmentDb(this.dbName);
    const transaction = db.transaction(BLOB_STORE, 'readonly');
    const count = await requestToPromise(
      transaction.objectStore(BLOB_STORE).count(key),
    );
    return count > 0;
  }

  async delete(key: string): Promise<void> {
    const db = await openAttachmentDb(this.dbName);
    const transaction = db.transaction(BLOB_STORE, 'readwrite');
    transaction.objectStore(BLOB_STORE).delete(key);
    await transactionDone(transaction);
  }
}

export class IndexedDbAttachmentStateStore implements AttachmentStateStore {
  constructor(private readonly dbName = 'zhixing-attachments') {}

  async get(attachmentId: string): Promise<AttachmentState | null> {
    const db = await openAttachmentDb(this.dbName);
    const transaction = db.transaction(STATE_STORE, 'readonly');
    const value = await requestToPromise(
      transaction.objectStore(STATE_STORE).get(attachmentId),
    );
    return isAttachmentState(value) ? value : null;
  }

  async put(state: AttachmentState): Promise<void> {
    const db = await openAttachmentDb(this.dbName);
    const transaction = db.transaction(STATE_STORE, 'readwrite');
    transaction.objectStore(STATE_STORE).put(state);
    await transactionDone(transaction);
  }

  async delete(attachmentId: string): Promise<void> {
    const db = await openAttachmentDb(this.dbName);
    const transaction = db.transaction(STATE_STORE, 'readwrite');
    transaction.objectStore(STATE_STORE).delete(attachmentId);
    await transactionDone(transaction);
  }

  async list(): Promise<AttachmentState[]> {
    const db = await openAttachmentDb(this.dbName);
    const transaction = db.transaction(STATE_STORE, 'readonly');
    const values = await requestToPromise(
      transaction.objectStore(STATE_STORE).getAll(),
    );
    return Array.isArray(values) ? values.filter(isAttachmentState) : [];
  }

  async clear(): Promise<void> {
    const db = await openAttachmentDb(this.dbName);
    const transaction = db.transaction(STATE_STORE, 'readwrite');
    transaction.objectStore(STATE_STORE).clear();
    await transactionDone(transaction);
  }
}

function isAttachmentState(value: unknown): value is AttachmentState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.attachmentId === 'string' &&
    typeof raw.status === 'string' &&
    typeof raw.localBlobKey === 'string'
  );
}

export function objectUrlFor(blob: Blob): string | null {
  try {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      return URL.createObjectURL(blob);
    }
  } catch {
    // 忽略；调用方用 FileReader 降级。
  }
  return null;
}

export function revokeObjectUrl(url: string | null): void {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // ignore
  }
}
