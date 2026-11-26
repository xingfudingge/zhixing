/**
 * OCR 作业持久化。
 *
 * 作业文本可能包含图片中的敏感信息，默认只存本机 IndexedDB；是否随
 * 附件同步由 `OcrJob.textStorage` 明确标记，本模块不会自行上传。
 */

import type { OcrJob } from './types';

export interface OcrJobStore {
  get(id: string): Promise<OcrJob | null>;
  put(job: OcrJob): Promise<void>;
  list(): Promise<OcrJob[]>;
  clear(): Promise<void>;
}

export class MemoryOcrJobStore implements OcrJobStore {
  private readonly jobs = new Map<string, OcrJob>();

  async get(id: string): Promise<OcrJob | null> {
    const job = this.jobs.get(id);
    return job ? normalizeStoredJob(job) : null;
  }

  async put(job: OcrJob): Promise<void> {
    this.jobs.set(job.id, normalizeStoredJob(job));
  }

  async list(): Promise<OcrJob[]> {
    return Array.from(this.jobs.values())
      .map((job) => normalizeStoredJob(job))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async clear(): Promise<void> {
    this.jobs.clear();
  }
}

const DB_NAME = 'zhixing-ocr';
const STORE = 'jobs';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('OCR IndexedDB 请求失败'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('OCR IndexedDB 事务失败'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('OCR IndexedDB 事务中止'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前环境没有 IndexedDB'));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开 OCR IndexedDB'));
  });
  return dbPromise;
}

export class IndexedDbOcrJobStore implements OcrJobStore {
  async get(id: string): Promise<OcrJob | null> {
    const db = await openDb();
    const transaction = db.transaction(STORE, 'readonly');
    const value = await requestToPromise(
      transaction.objectStore(STORE).get(id),
    );
    return isOcrJob(value) ? normalizeStoredJob(value) : null;
  }

  async put(job: OcrJob): Promise<void> {
    const db = await openDb();
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(normalizeStoredJob(job));
    await transactionDone(transaction);
  }

  async list(): Promise<OcrJob[]> {
    const db = await openDb();
    const transaction = db.transaction(STORE, 'readonly');
    const values = await requestToPromise(transaction.objectStore(STORE).getAll());
    if (!Array.isArray(values)) return [];
    return values
      .filter(isOcrJob)
      .map((job) => normalizeStoredJob(job))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async clear(): Promise<void> {
    const db = await openDb();
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).clear();
    await transactionDone(transaction);
  }
}

function isOcrJob(value: unknown): value is OcrJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === 'string' &&
    typeof raw.attachmentId === 'string' &&
    typeof raw.status === 'string' &&
    typeof raw.dedupeKey === 'string'
  );
}

/**
 * 旧版本作业没有 textSyncState/textSyncError。不能把它们默认成“已同步”：
 * 当时并没有同步消费方，因此标记为 failed 并说明只在本机，避免历史数据伪装。
 */
function normalizeStoredJob(job: OcrJob): OcrJob {
  const raw = job as OcrJob & {
    textSyncState?: unknown;
    textSyncError?: unknown;
  };
  const knownState =
    raw.textSyncState === 'local' ||
    raw.textSyncState === 'pending' ||
    raw.textSyncState === 'queued' ||
    raw.textSyncState === 'failed';
  if (knownState) {
    return {
      ...job,
      textSyncError:
        typeof raw.textSyncError === 'string' ? raw.textSyncError : null,
    };
  }
  if (job.textStorage === 'sync') {
    return {
      ...job,
      textSyncState: 'failed',
      textSyncError:
        '旧版本 OCR 作业没有进入同步管线；识别文本只保存在本机。',
    };
  }
  return { ...job, textSyncState: 'local', textSyncError: null };
}

/** 测试/重置。 */
export async function resetOcrJobDb(): Promise<void> {
  dbPromise = null;
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
