import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import {
  IndexedDbIcsStore,
  closeIcsDb,
  resetIcsDb,
} from '../store';
import type { IcsCache, IcsSubscription } from '../types';

function subscription(id: string, name = '团队日历'): IcsSubscription {
  return {
    id,
    name,
    url: `https://example.com/${id}.ics`,
    color: '',
    enabled: true,
    readOnly: true,
    etag: '"v1"',
    lastModified: 'Mon, 26 Oct 2026 10:00:00 GMT',
    lastSyncAt: '2026-10-26T10:00:00.000Z',
    lastAttemptAt: '2026-10-26T10:00:00.000Z',
    lastError: 'HTTP 500',
    lastWarning: '跳过缺少 UID 的事件',
    eventCount: 2,
    createdAt: '2026-10-26T09:00:00.000Z',
    updatedAt: '2026-10-26T10:00:00.000Z',
  };
}

function cache(id: string): IcsCache {
  return {
    subscriptionId: id,
    etag: '"v1"',
    lastModified: 'Mon, 26 Oct 2026 10:00:00 GMT',
    fetchedAt: '2026-10-26T10:00:00.000Z',
    raw: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
    events: [],
    windowFrom: '2026-07-28',
    windowTo: '2027-10-26',
    warnings: ['跳过缺少 UID 的事件'],
  };
}

afterEach(async () => {
  await resetIcsDb();
});

describe('IndexedDB ICS 存储（设置页重启/持久化）', () => {
  it('关闭连接模拟重启后，订阅、最后同步、事件数、错误与缓存仍在', async () => {
    const store = new IndexedDbIcsStore();
    await store.putSubscription(subscription('ics_1'));
    await store.putCache(cache('ics_1'));

    // 模拟 App 重启：释放连接，再由新的 store 实例重新打开同一 IndexedDB。
    await closeIcsDb();
    const restarted = new IndexedDbIcsStore();
    const list = await restarted.listSubscriptions();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'ics_1',
      lastSyncAt: '2026-10-26T10:00:00.000Z',
      lastAttemptAt: '2026-10-26T10:00:00.000Z',
      lastError: 'HTTP 500',
      lastWarning: '跳过缺少 UID 的事件',
      eventCount: 2,
    });
    const restoredCache = await restarted.getCache('ics_1');
    expect(restoredCache?.raw).toContain('BEGIN:VCALENDAR');
    expect(restoredCache?.warnings).toEqual(['跳过缺少 UID 的事件']);
  });

  it('删除订阅只删该订阅与缓存，其他订阅不受影响', async () => {
    const store = new IndexedDbIcsStore();
    await store.putSubscription(subscription('ics_1'));
    await store.putSubscription(subscription('ics_2', '另一个'));
    await store.putCache(cache('ics_1'));
    await store.putCache(cache('ics_2'));

    await store.deleteSubscription('ics_1');
    await store.deleteCache('ics_1');

    expect(await store.getSubscription('ics_1')).toBeNull();
    expect(await store.getCache('ics_1')).toBeNull();
    expect(await store.getSubscription('ics_2')).not.toBeNull();
    expect(await store.getCache('ics_2')).not.toBeNull();
    expect((await store.listSubscriptions()).map((item) => item.id)).toEqual([
      'ics_2',
    ]);
  });
});
