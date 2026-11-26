/**
 * ICS 只读订阅入口。
 *
 *   const service = createDefaultIcsSyncService();
 *   await service.syncAll();
 *   <IcsSubscriptionsPanel service={service} />
 *
 * 导入的事件写入 SQLite `events`（source=`ics:<订阅id>`），由日历页按现有
 * 事件查询显示；本模块没有写回 ICS 的 API。
 */

import './ics.css';

import { db } from '../../../data/db/client';
import { createEventRepository } from '../../events/eventRepository';
import {
  IndexedDbIcsStore,
  MemoryIcsStore,
  isIndexedDbAvailableForIcs,
} from './store';
import { createIcsSyncService, type IcsSyncService } from './sync';

export { IcsSubscriptionsPanel } from './IcsSubscriptionsPanel';
export type { IcsSubscriptionsPanelProps } from './IcsSubscriptionsPanel';
export {
  IcsSyncService,
  createIcsSyncService,
  validateIcsUrl,
} from './sync';
export type {
  FetchLike,
  IcsSyncAllReport,
  IcsSyncFailure,
  IcsSyncResult,
  IcsSyncServiceOptions,
} from './sync';
export { createIcsHttpClient, isTauriRuntime } from './http';
export type {
  IcsHttpClient,
  IcsHttpClientOptions,
  IcsHttpTransportKind,
} from './http';
export {
  expandOccurrences,
  occurrenceToDraft,
  parseIcs,
  unescapeIcsText,
} from './parser';
export {
  ICS_SOURCE_PREFIX,
  IcsFetchError,
  IcsParseError,
  IcsSubscriptionError,
  isIcsEvent,
  isIcsSource,
  redactIcsUrl,
  sourceForSubscription,
} from './types';
export type {
  IcsCache,
  IcsDateValue,
  IcsEvent,
  IcsEventDraft,
  IcsOccurrence,
  IcsParseResult,
  IcsRecurrence,
  IcsSubscription,
} from './types';
export { IndexedDbIcsStore, MemoryIcsStore, resetIcsDb } from './store';
export type { IcsStore } from './store';

/**
 * 浏览器预览/无 IndexedDB 环境的兜底存储。
 *
 * 用模块级单例而不是每次挂载新实例：设置页重新打开/重新挂载时，订阅与
 * 最近一次缓存仍可见（真实桌面/浏览器优先使用 IndexedDB）。
 */
const fallbackStore = new MemoryIcsStore();

export function createDefaultIcsSyncService(): IcsSyncService {
  return createIcsSyncService({
    store: isIndexedDbAvailableForIcs()
      ? new IndexedDbIcsStore()
      : fallbackStore,
    events: createEventRepository(db),
  });
}

/** 浏览器预览/测试：不落 SQLite，只解析与缓存。 */
export function createMemoryIcsSyncService(
  options: Omit<Parameters<typeof createIcsSyncService>[0], 'store'> & {
    store?: MemoryIcsStore;
  },
): IcsSyncService {
  return createIcsSyncService({
    ...options,
    store: options.store ?? new MemoryIcsStore(),
  });
}
