/**
 * 节假日数据包缓存（按源 + 传输 + 年份隔离）。
 *
 * 放在 IndexedDB 而不是 SQLite：
 * - 节假日是公共数据，可随时重建，不进业务备份；
 * - 与 ICS 订阅/缓存同层，避免为公共数据改 SQLite schema；
 * - 缓存只保存解析后的数据包、ETag 与内容哈希，不保存请求 URL
 *   （自定义 URL 可能含 token）。
 *
 * 回退到其它源时只读写该源自己的记录；绝不复用另一源的 ETag。
 */

import type { HolidayPackage } from '../../../data/calendar/holidays';
import {
  normalizeHolidaySyncState,
  type HolidayCacheRecord,
  type HolidayCacheSourceId,
  type HolidayCacheTransport,
  type HolidaySyncState,
} from './types';

export interface HolidayPackageStore {
  /** 不传源时返回当前激活源的包（由 state.activeSourceId 决定）。 */
  listPackages(
    sourceId?: HolidayCacheSourceId,
    transport?: HolidayCacheTransport,
  ): Promise<HolidayPackage[]>;
  listRecords(sourceId?: HolidayCacheSourceId): Promise<HolidayCacheRecord[]>;
  getRecord(
    sourceId: HolidayCacheSourceId,
    transport: HolidayCacheTransport,
    year: number,
  ): Promise<HolidayCacheRecord | null>;
  putRecord(record: HolidayCacheRecord): Promise<void>;
  deleteRecord(
    sourceId: HolidayCacheSourceId,
    transport: HolidayCacheTransport,
    year: number,
  ): Promise<void>;
  /** 只删除一个源（可选限定传输）的记录，不触碰其它源。 */
  deleteSource(
    sourceId: HolidayCacheSourceId,
    transport?: HolidayCacheTransport,
  ): Promise<void>;
  getState(): Promise<HolidaySyncState | null>;
  putState(state: HolidaySyncState): Promise<void>;
  clear(): Promise<void>;
}

export function holidayCacheKey(
  sourceId: HolidayCacheSourceId,
  transport: HolidayCacheTransport,
  year: number,
): string {
  return `${sourceId}|${transport}|${year}`;
}

function cloneRecord(record: HolidayCacheRecord): HolidayCacheRecord {
  return {
    ...record,
    package: {
      ...record.package,
      days: record.package.days.map((day) => ({ ...day })),
      papers: [...record.package.papers],
    },
  };
}

function cloneSourceStatus(
  status: HolidaySyncState['perSource'][keyof HolidaySyncState['perSource']],
) {
  if (!status) return status;
  return {
    ...status,
    cachedYears: [...status.cachedYears],
    notPublishedYears: [...status.notPublishedYears],
  };
}

function cloneState(state: HolidaySyncState): HolidaySyncState {
  const perSource: HolidaySyncState['perSource'] = {};
  for (const [key, value] of Object.entries(state.perSource ?? {})) {
    perSource[key as keyof HolidaySyncState['perSource']] =
      cloneSourceStatus(value);
  }
  return {
    ...state,
    cachedYears: [...state.cachedYears],
    notPublishedYears: [...state.notPublishedYears],
    perSource,
  };
}

function dedupePackages(records: readonly HolidayCacheRecord[]): HolidayPackage[] {
  const byYear = new Map<number, HolidayCacheRecord>();
  for (const record of records) {
    const existing = byYear.get(record.year);
    if (!existing || record.fetchedAt >= existing.fetchedAt) {
      byYear.set(record.year, record);
    }
  }
  return [...byYear.values()]
    .map((record) => cloneRecord(record).package)
    .sort((a, b) => a.year - b.year);
}

export class MemoryHolidayPackageStore implements HolidayPackageStore {
  private readonly records = new Map<string, HolidayCacheRecord>();
  private state: HolidaySyncState | null = null;

  async listPackages(
    sourceId?: HolidayCacheSourceId,
    transport?: HolidayCacheTransport,
  ): Promise<HolidayPackage[]> {
    const active = sourceId ?? (await this.activeSourceId());
    const records = [...this.records.values()].filter(
      (record) =>
        (active === undefined || record.sourceId === active) &&
        (transport === undefined || record.transport === transport),
    );
    if (active === undefined) {
      return dedupePackages(records);
    }
    return records
      .map((record) => cloneRecord(record).package)
      .sort((a, b) => a.year - b.year);
  }

  async listRecords(
    sourceId?: HolidayCacheSourceId,
  ): Promise<HolidayCacheRecord[]> {
    return [...this.records.values()]
      .filter((record) => sourceId === undefined || record.sourceId === sourceId)
      .map(cloneRecord)
      .sort((a, b) =>
        a.year === b.year
          ? a.transport.localeCompare(b.transport)
          : a.year - b.year,
      );
  }

  async getRecord(
    sourceId: HolidayCacheSourceId,
    transport: HolidayCacheTransport,
    year: number,
  ): Promise<HolidayCacheRecord | null> {
    const record = this.records.get(holidayCacheKey(sourceId, transport, year));
    return record ? cloneRecord(record) : null;
  }

  async putRecord(record: HolidayCacheRecord): Promise<void> {
    this.records.set(
      holidayCacheKey(record.sourceId, record.transport, record.year),
      cloneRecord(record),
    );
  }

  async deleteRecord(
    sourceId: HolidayCacheSourceId,
    transport: HolidayCacheTransport,
    year: number,
  ): Promise<void> {
    this.records.delete(holidayCacheKey(sourceId, transport, year));
  }

  async deleteSource(
    sourceId: HolidayCacheSourceId,
    transport?: HolidayCacheTransport,
  ): Promise<void> {
    for (const [key, record] of this.records) {
      if (
        record.sourceId === sourceId &&
        (transport === undefined || record.transport === transport)
      ) {
        this.records.delete(key);
      }
    }
  }

  async getState(): Promise<HolidaySyncState | null> {
    return this.state ? cloneState(this.state) : null;
  }

  async putState(state: HolidaySyncState): Promise<void> {
    this.state = cloneState(state);
  }

  async clear(): Promise<void> {
    this.records.clear();
    this.state = null;
  }

  private async activeSourceId(): Promise<HolidayCacheSourceId | undefined> {
    if (!this.state) return undefined;
    return this.state.activeSourceId ?? undefined;
  }
}

const DB_NAME = 'zhixing-holiday';
const PACKAGES = 'packages';
const META = 'meta';
const DB_VERSION = 2;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('节假日 IndexedDB 请求失败'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('节假日 IndexedDB 事务失败'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('节假日 IndexedDB 事务中止'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前环境没有 IndexedDB'));
  }
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // v1 的 packages 以 year 为主键，无法容纳 source/transport 维度。
      // 节假日是公共数据，升级时清空重建；业务设置与个人例外不在此库。
      if (db.objectStoreNames.contains(PACKAGES)) {
        db.deleteObjectStore(PACKAGES);
      }
      db.createObjectStore(PACKAGES, { keyPath: 'cacheKey' });
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('无法打开节假日 IndexedDB'));
  });
  return dbPromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHolidayPackage(value: unknown): value is HolidayPackage {
  if (!isRecord(value)) return false;
  return (
    typeof value.year === 'number' &&
    Array.isArray(value.days) &&
    typeof value.version === 'string'
  );
}

function isCacheRecord(value: unknown): value is HolidayCacheRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.cacheKey === 'string' &&
    typeof value.sourceId === 'string' &&
    typeof value.transport === 'string' &&
    typeof value.year === 'number' &&
    isHolidayPackage(value.package) &&
    typeof value.fetchedAt === 'string'
  );
}

function matches(
  record: HolidayCacheRecord,
  sourceId?: HolidayCacheSourceId,
  transport?: HolidayCacheTransport,
): boolean {
  return (
    (sourceId === undefined || record.sourceId === sourceId) &&
    (transport === undefined || record.transport === transport)
  );
}

export class IndexedDbHolidayPackageStore implements HolidayPackageStore {
  async listPackages(
    sourceId?: HolidayCacheSourceId,
    transport?: HolidayCacheTransport,
  ): Promise<HolidayPackage[]> {
    const active = sourceId ?? (await this.activeSourceId());
    const records = (await this.listRecords()).filter((record) =>
      matches(record, active, transport),
    );
    if (active === undefined) {
      return dedupePackages(records);
    }
    return records
      .map((record) => record.package)
      .sort((a, b) => a.year - b.year);
  }

  async listRecords(
    sourceId?: HolidayCacheSourceId,
  ): Promise<HolidayCacheRecord[]> {
    const db = await openDb();
    const transaction = db.transaction(PACKAGES, 'readonly');
    const values = await requestToPromise(
      transaction.objectStore(PACKAGES).getAll(),
    );
    if (!Array.isArray(values)) return [];
    return values
      .filter(isCacheRecord)
      .filter((record) => sourceId === undefined || record.sourceId === sourceId)
      .sort((a, b) =>
        a.year === b.year
          ? a.transport.localeCompare(b.transport)
          : a.year - b.year,
      );
  }

  async getRecord(
    sourceId: HolidayCacheSourceId,
    transport: HolidayCacheTransport,
    year: number,
  ): Promise<HolidayCacheRecord | null> {
    const db = await openDb();
    const transaction = db.transaction(PACKAGES, 'readonly');
    const value = await requestToPromise(
      transaction
        .objectStore(PACKAGES)
        .get(holidayCacheKey(sourceId, transport, year)),
    );
    return isCacheRecord(value) ? value : null;
  }

  async putRecord(record: HolidayCacheRecord): Promise<void> {
    const db = await openDb();
    const transaction = db.transaction(PACKAGES, 'readwrite');
    transaction.objectStore(PACKAGES).put({
      ...record,
      cacheKey: holidayCacheKey(record.sourceId, record.transport, record.year),
    });
    await transactionDone(transaction);
  }

  async deleteRecord(
    sourceId: HolidayCacheSourceId,
    transport: HolidayCacheTransport,
    year: number,
  ): Promise<void> {
    const db = await openDb();
    const transaction = db.transaction(PACKAGES, 'readwrite');
    transaction
      .objectStore(PACKAGES)
      .delete(holidayCacheKey(sourceId, transport, year));
    await transactionDone(transaction);
  }

  async deleteSource(
    sourceId: HolidayCacheSourceId,
    transport?: HolidayCacheTransport,
  ): Promise<void> {
    const records = (await this.listRecords(sourceId)).filter((record) =>
      matches(record, sourceId, transport),
    );
    if (records.length === 0) return;
    const db = await openDb();
    const transaction = db.transaction(PACKAGES, 'readwrite');
    const store = transaction.objectStore(PACKAGES);
    for (const record of records) {
      store.delete(holidayCacheKey(record.sourceId, record.transport, record.year));
    }
    await transactionDone(transaction);
  }

  async getState(): Promise<HolidaySyncState | null> {
    const db = await openDb();
    const transaction = db.transaction(META, 'readonly');
    const value = await requestToPromise(
      transaction.objectStore(META).get('state'),
    );
    return isRecord(value) ? normalizeHolidaySyncState(value) : null;
  }

  async putState(state: HolidaySyncState): Promise<void> {
    const db = await openDb();
    const transaction = db.transaction(META, 'readwrite');
    transaction.objectStore(META).put({ id: 'state', ...state });
    await transactionDone(transaction);
  }

  async clear(): Promise<void> {
    const db = await openDb();
    const transaction = db.transaction([PACKAGES, META], 'readwrite');
    transaction.objectStore(PACKAGES).clear();
    transaction.objectStore(META).clear();
    await transactionDone(transaction);
  }

  private async activeSourceId(): Promise<HolidayCacheSourceId | undefined> {
    const state = await this.getState();
    return state?.activeSourceId ?? undefined;
  }
}

export function isIndexedDbAvailableForHolidays(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export async function resetHolidayDb(): Promise<void> {
  dbPromise = null;
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
