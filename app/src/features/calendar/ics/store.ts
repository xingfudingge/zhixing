/**
 * ICS 订阅与离线缓存存储。
 *
 * 订阅 URL 可能包含私有 token，因此默认写 IndexedDB（而不是 localStorage），
 * 也不写日志。缓存保留最近一次成功解析的事件，断网时仍可读。
 */

import type { IcsCache, IcsSubscription } from './types';

export interface IcsStore {
  listSubscriptions(): Promise<IcsSubscription[]>;
  getSubscription(id: string): Promise<IcsSubscription | null>;
  putSubscription(subscription: IcsSubscription): Promise<void>;
  deleteSubscription(id: string): Promise<void>;
  getCache(subscriptionId: string): Promise<IcsCache | null>;
  putCache(cache: IcsCache): Promise<void>;
  deleteCache(subscriptionId: string): Promise<void>;
  clear(): Promise<void>;
}

function cloneSubscription(value: IcsSubscription): IcsSubscription {
  return {
    ...value,
    enabled: value.enabled !== false,
    lastError: value.lastError ?? null,
    lastWarning: value.lastWarning ?? null,
    eventCount: typeof value.eventCount === 'number' ? value.eventCount : 0,
  };
}

function normalizeCache(value: IcsCache): IcsCache {
  return {
    ...value,
    events: value.events.map((event) => ({ ...event })),
    windowFrom: value.windowFrom ?? null,
    windowTo: value.windowTo ?? null,
    warnings: Array.isArray(value.warnings) ? [...value.warnings] : [],
  };
}

export class MemoryIcsStore implements IcsStore {
  private readonly subscriptions = new Map<string, IcsSubscription>();
  private readonly caches = new Map<string, IcsCache>();

  async listSubscriptions(): Promise<IcsSubscription[]> {
    return Array.from(this.subscriptions.values())
      .map(cloneSubscription)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getSubscription(id: string): Promise<IcsSubscription | null> {
    const value = this.subscriptions.get(id);
    return value ? cloneSubscription(value) : null;
  }

  async putSubscription(subscription: IcsSubscription): Promise<void> {
    this.subscriptions.set(subscription.id, cloneSubscription(subscription));
  }

  async deleteSubscription(id: string): Promise<void> {
    this.subscriptions.delete(id);
  }

  async getCache(subscriptionId: string): Promise<IcsCache | null> {
    const value = this.caches.get(subscriptionId);
    return value ? normalizeCache(value) : null;
  }

  async putCache(cache: IcsCache): Promise<void> {
    this.caches.set(cache.subscriptionId, normalizeCache(cache));
  }

  async deleteCache(subscriptionId: string): Promise<void> {
    this.caches.delete(subscriptionId);
  }

  async clear(): Promise<void> {
    this.subscriptions.clear();
    this.caches.clear();
  }
}

const DB_NAME = 'zhixing-ics';
const SUBSCRIPTIONS = 'subscriptions';
const CACHE = 'cache';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('ICS IndexedDB 请求失败'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('ICS IndexedDB 事务失败'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('ICS IndexedDB 事务中止'));
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
      if (!db.objectStoreNames.contains(SUBSCRIPTIONS)) {
        db.createObjectStore(SUBSCRIPTIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CACHE)) {
        db.createObjectStore(CACHE, { keyPath: 'subscriptionId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开 ICS IndexedDB'));
  });
  return dbPromise;
}

export class IndexedDbIcsStore implements IcsStore {
  async listSubscriptions(): Promise<IcsSubscription[]> {
    const db = await openDb();
    const transaction = db.transaction(SUBSCRIPTIONS, 'readonly');
    const values = await requestToPromise(
      transaction.objectStore(SUBSCRIPTIONS).getAll(),
    );
    if (!Array.isArray(values)) return [];
    return values
      .filter(isSubscription)
      .map(cloneSubscription)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getSubscription(id: string): Promise<IcsSubscription | null> {
    const db = await openDb();
    const transaction = db.transaction(SUBSCRIPTIONS, 'readonly');
    const value = await requestToPromise(
      transaction.objectStore(SUBSCRIPTIONS).get(id),
    );
    return isSubscription(value) ? cloneSubscription(value) : null;
  }

  async putSubscription(subscription: IcsSubscription): Promise<void> {
    const db = await openDb();
    const transaction = db.transaction(SUBSCRIPTIONS, 'readwrite');
    transaction.objectStore(SUBSCRIPTIONS).put(subscription);
    await transactionDone(transaction);
  }

  async deleteSubscription(id: string): Promise<void> {
    const db = await openDb();
    const transaction = db.transaction(SUBSCRIPTIONS, 'readwrite');
    transaction.objectStore(SUBSCRIPTIONS).delete(id);
    await transactionDone(transaction);
  }

  async getCache(subscriptionId: string): Promise<IcsCache | null> {
    const db = await openDb();
    const transaction = db.transaction(CACHE, 'readonly');
    const value = await requestToPromise(
      transaction.objectStore(CACHE).get(subscriptionId),
    );
    return isCache(value) ? normalizeCache(value) : null;
  }

  async putCache(cache: IcsCache): Promise<void> {
    const db = await openDb();
    const transaction = db.transaction(CACHE, 'readwrite');
    transaction.objectStore(CACHE).put(cache);
    await transactionDone(transaction);
  }

  async deleteCache(subscriptionId: string): Promise<void> {
    const db = await openDb();
    const transaction = db.transaction(CACHE, 'readwrite');
    transaction.objectStore(CACHE).delete(subscriptionId);
    await transactionDone(transaction);
  }

  async clear(): Promise<void> {
    const db = await openDb();
    const transaction = db.transaction([SUBSCRIPTIONS, CACHE], 'readwrite');
    transaction.objectStore(SUBSCRIPTIONS).clear();
    transaction.objectStore(CACHE).clear();
    await transactionDone(transaction);
  }
}

function isSubscription(value: unknown): value is IcsSubscription {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.id === 'string' &&
    typeof raw.url === 'string' &&
    typeof raw.name === 'string'
  );
}

function isCache(value: unknown): value is IcsCache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw.subscriptionId === 'string' &&
    typeof raw.raw === 'string' &&
    Array.isArray(raw.events)
  );
}

export function isIndexedDbAvailableForIcs(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** 关闭当前连接（测试模拟“重启”或重置前释放锁）。 */
export async function closeIcsDb(): Promise<void> {
  const pending = dbPromise;
  dbPromise = null;
  if (!pending) return;
  try {
    (await pending).close();
  } catch {
    // 连接可能已经失败/关闭；重置流程继续。
  }
}

export async function resetIcsDb(): Promise<void> {
  await closeIcsDb();
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
