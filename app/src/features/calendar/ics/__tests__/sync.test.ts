import { describe, expect, it, vi } from 'vitest';

import type {
  Event,
  EventQuery,
  EventUpdate,
  NewEvent,
} from '../../../../data/db/types';
import type { EventRepository } from '../../../events/eventRepository';
import { MemoryIcsStore } from '../store';
import { IcsSyncService, validateIcsUrl } from '../sync';
import {
  IcsFetchError,
  IcsSubscriptionError,
  type IcsCache,
} from '../types';

const CRLF = '\r\n';

function calendar(events: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    ...events,
    'END:VCALENDAR',
  ].join(CRLF);
}

function eventBody(uid: string, summary: string, date: string): string[] {
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART;VALUE=DATE:${date.replace(/-/g, '')}`,
    `SUMMARY:${summary}`,
    'END:VEVENT',
  ];
}

class FakeEventRepository implements EventRepository {
  rows: Event[] = [];
  private sequence = 0;

  async list(query: EventQuery = {}): Promise<Event[]> {
    void query;
    return this.rows.filter((row) => !row.deletedAt).map((row) => ({ ...row }));
  }

  async create(input: NewEvent): Promise<Event> {
    this.sequence += 1;
    const now = new Date().toISOString();
    const row: Event = {
      id: input.id ?? `evt_${this.sequence}`,
      spaceId: input.spaceId ?? 'personal',
      title: input.title,
      eventType: input.eventType ?? '个人日程',
      allDay: input.allDay ?? false,
      startDate: input.startDate,
      startAt: input.startAt ?? null,
      endAt: input.endAt ?? null,
      tz: input.tz ?? 'Asia/Shanghai',
      source: input.source ?? 'local',
      externalUid: input.externalUid ?? null,
      repeatRule: input.repeatRule ?? '单次',
      calendarType: input.calendarType ?? 'solar',
      noteId: input.noteId ?? null,
      color: input.color ?? '',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      version: 1,
    };
    this.rows.push(row);
    return { ...row };
  }

  async update(id: string, input: EventUpdate): Promise<Event> {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index < 0) throw new Error('事件不存在');
    const current = this.rows[index]!;
    const next: Event = {
      ...current,
      ...input,
      tz: input.tz ?? current.tz,
      source: input.source ?? current.source,
      externalUid: input.externalUid ?? null,
      repeatRule: input.repeatRule ?? current.repeatRule,
      noteId: input.noteId ?? null,
      color: input.color ?? current.color,
      updatedAt: new Date().toISOString(),
      version: current.version + 1,
    };
    this.rows[index] = next;
    return { ...next };
  }

  async remove(id: string): Promise<void> {
    this.rows = this.rows.filter((row) => row.id !== id);
  }
}

function setup(options: { now?: Date } = {}) {
  const store = new MemoryIcsStore();
  const events = new FakeEventRepository();
  const fetchImpl = vi.fn();
  const service = new IcsSyncService({
    store,
    events,
    fetchImpl,
    now: () => options.now ?? new Date('2026-10-26T10:00:00.000Z'),
    newId: () => 'ics_1',
    pastDays: 365,
    futureDays: 365,
  });
  return { store, events, fetchImpl, service };
}

describe('ICS 只读同步', () => {
  it('校验 URL，拒绝内嵌账号密码与非 http(s)', async () => {
    expect(validateIcsUrl(' https://example.com/a.ics ')).toBe(
      'https://example.com/a.ics',
    );
    expect(() => validateIcsUrl('file:///etc/passwd')).toThrow(
      IcsSubscriptionError,
    );
    expect(() => validateIcsUrl('https://user:pass@example.com/a.ics')).toThrow(
      IcsSubscriptionError,
    );
  });

  it('添加订阅后只读拉取并幂等物化；304 不重复导入', async () => {
    const { service, fetchImpl, events, store } = setup();
    const subscription = await service.addSubscription({
      name: '团队',
      url: 'https://example.com/team.ics',
    });
    expect(subscription.readOnly).toBe(true);
    expect(subscription.lastSyncAt).toBeNull();

    fetchImpl.mockResolvedValueOnce(
      new Response(
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          'UID:e1',
          'DTSTART;VALUE=DATE:20261026',
          'SUMMARY:项目启动',
          'END:VEVENT',
          'BEGIN:VEVENT',
          'UID:e2',
          'DTSTART;VALUE=DATE:20261027',
          'SUMMARY:评审',
          'END:VEVENT',
          'END:VCALENDAR',
        ].join(CRLF),
        {
          status: 200,
          headers: { etag: '"v1"', 'last-modified': 'Mon, 26 Oct 2026 10:00:00 GMT' },
        },
      ),
    );

    const first = await service.sync(subscription.id);
    expect(first.notModified).toBe(false);
    expect(first.eventCount).toBe(2);
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0]).toMatchObject({
      title: '项目启动',
      startDate: '2026-10-26',
      source: 'ics:ics_1',
      externalUid: 'e1#2026-10-26',
      repeatRule: '单次',
      // 外部订阅同步后仍是公历标记，不因本地农历开关改变语义。
      calendarType: 'solar',
    });
    const after = await store.getSubscription(subscription.id);
    expect(after?.lastSyncAt).toBe('2026-10-26T10:00:00.000Z');
    expect(after?.etag).toBe('"v1"');

    const callHeaders = fetchImpl.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(callHeaders['if-none-match']).toBeUndefined();

    fetchImpl.mockResolvedValueOnce(
      new Response(null, { status: 304 }),
    );
    const second = await service.sync(subscription.id);
    expect(second.notModified).toBe(true);
    expect(events.rows).toHaveLength(2);
    const headers = fetchImpl.mock.calls[1]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers['if-none-match']).toBe('"v1"');
    expect(headers['if-modified-since']).toContain('2026');
    const after304 = await store.getSubscription(subscription.id);
    expect(after304?.lastSyncAt).toBe('2026-10-26T10:00:00.000Z');
    expect(after304?.lastAttemptAt).toBe('2026-10-26T10:00:00.000Z');
    expect(after304?.lastError).toBeNull();
    expect((await store.getCache(subscription.id))?.fetchedAt).toBe(
      '2026-10-26T10:00:00.000Z',
    );
  });

  it('远端删除/改名后以只读镜像更新，不触碰本地事件', async () => {
    const { service, fetchImpl, events } = setup();
    const subscription = await service.addSubscription({
      name: '团队',
      url: 'https://example.com/team.ics',
    });
    await events.create({
      title: '本地事件',
      startDate: '2026-10-26',
      source: 'local',
    });
    fetchImpl.mockResolvedValueOnce(
      new Response(
        calendar([
          ...eventBody('e1', '旧标题', '2026-10-26'),
          ...eventBody('e2', '将被删除', '2026-10-27'),
        ]),
        { status: 200 },
      ),
    );
    await service.sync(subscription.id);
    expect(events.rows).toHaveLength(3);

    fetchImpl.mockResolvedValueOnce(
      new Response(calendar([...eventBody('e1', '新标题', '2026-10-26')]), {
        status: 200,
      }),
    );
    await service.sync(subscription.id);
    expect(events.rows).toHaveLength(2);
    expect(events.rows.find((row) => row.title === '新标题')).toBeTruthy();
    expect(events.rows.find((row) => row.title === '本地事件')).toBeTruthy();
    expect(events.rows.find((row) => row.title === '将被删除')).toBeFalsy();
  });

  it('拉取失败记录 lastAttemptAt/lastError 并保留缓存与已导入事件', async () => {
    const { service, fetchImpl, events, store } = setup();
    const subscription = await service.addSubscription({
      name: '团队',
      url: 'https://example.com/team.ics',
    });
    fetchImpl.mockResolvedValueOnce(
      new Response(calendar([...eventBody('e1', '保留', '2026-10-26')]), {
        status: 200,
        headers: { etag: '"v1"' },
      }),
    );
    await service.sync(subscription.id);
    const cache = await store.getCache(subscription.id);
    expect(cache).not.toBeNull();

    fetchImpl.mockRejectedValueOnce(new Error('offline'));
    await expect(service.sync(subscription.id)).rejects.toBeInstanceOf(
      IcsFetchError,
    );
    const after = await store.getSubscription(subscription.id);
    expect(after?.lastError).toContain('offline');
    expect(after?.lastAttemptAt).toBe('2026-10-26T10:00:00.000Z');
    expect(after?.lastSyncAt).toBe('2026-10-26T10:00:00.000Z');
    expect(events.rows).toHaveLength(1);
    expect(await store.getCache(subscription.id)).toEqual(cache);
  });

  it('请求超时会明确失败并记录 lastAttempt，不伪造 lastSyncAt', async () => {
    const store = new MemoryIcsStore();
    const events = new FakeEventRepository();
    const service = new IcsSyncService({
      store,
      events,
      // 模拟不响应 AbortSignal 的 transport：只有 Promise.race 兜底才会结束。
      fetchImpl: () => new Promise<Response>(() => {}),
      now: () => new Date('2026-10-26T10:00:00.000Z'),
      timeoutMs: 25,
    });
    const subscription = await service.addSubscription({
      url: 'https://example.com/slow.ics',
    });

    await expect(service.sync(subscription.id)).rejects.toThrow(/超时/);

    const after = await store.getSubscription(subscription.id);
    expect(after?.lastSyncAt).toBeNull();
    expect(after?.lastAttemptAt).toBe('2026-10-26T10:00:00.000Z');
    expect(after?.lastError).toContain('超时');
    expect(events.rows).toHaveLength(0);
  });

  it('本地写入失败也记录错误，不伪造 lastSyncAt', async () => {
    const store = new MemoryIcsStore();
    const events = new FakeEventRepository();
    events.create = async () => {
      throw new Error('磁盘已满');
    };
    const service = new IcsSyncService({
      store,
      events,
      fetchImpl: async () =>
        new Response(calendar([...eventBody('e1', '无法写入', '2026-10-26')]), {
          status: 200,
        }),
      now: () => new Date('2026-10-26T10:00:00.000Z'),
    });
    const subscription = await service.addSubscription({
      url: 'https://example.com/team.ics',
    });

    await expect(service.sync(subscription.id)).rejects.toThrow(
      /导入 ICS 失败/,
    );

    const after = await store.getSubscription(subscription.id);
    expect(after?.lastSyncAt).toBeNull();
    expect(after?.lastAttemptAt).toBe('2026-10-26T10:00:00.000Z');
    expect(after?.lastError).toContain('磁盘已满');
  });

  it('解析失败不覆盖缓存，并记录错误', async () => {
    const { service, fetchImpl, store } = setup();
    const subscription = await service.addSubscription({
      name: '团队',
      url: 'https://example.com/team.ics',
    });
    fetchImpl.mockResolvedValueOnce(
      new Response(calendar([...eventBody('e1', '保留', '2026-10-26')]), {
        status: 200,
      }),
    );
    await service.sync(subscription.id);
    const before = await store.getCache(subscription.id);

    fetchImpl.mockResolvedValueOnce(
      new Response('这不是日历', { status: 200 }),
    );
    await expect(service.sync(subscription.id)).rejects.toThrow(
      /BEGIN:VCALENDAR/,
    );
    const after = await store.getSubscription(subscription.id);
    expect(after?.lastError).toContain('BEGIN:VCALENDAR');
    expect(await store.getCache(subscription.id)).toEqual(before);
  });

  it('重复 URL 被拒绝（含尾斜杠差异）；取消订阅保留本地事件', async () => {
    const { service, fetchImpl, events, store } = setup();
    const subscription = await service.addSubscription({
      url: 'https://example.com/team.ics',
    });
    await expect(
      service.addSubscription({ url: ' https://example.com/team.ics ' }),
    ).rejects.toBeInstanceOf(IcsSubscriptionError);
    await expect(
      service.addSubscription({ url: 'https://example.com/team.ics/' }),
    ).rejects.toBeInstanceOf(IcsSubscriptionError);

    fetchImpl.mockResolvedValueOnce(
      new Response(calendar([...eventBody('e1', '事件', '2026-10-26')]), {
        status: 200,
      }),
    );
    await service.sync(subscription.id);
    await service.removeSubscription(subscription.id);

    expect(await store.getSubscription(subscription.id)).toBeNull();
    expect(await store.getCache(subscription.id)).toBeNull();
    expect(events.rows).toHaveLength(1);
  });

  it('空 ICS 且没有警告时清空镜像；全部无效时保留旧数据并报错', async () => {
    const { service, fetchImpl, events } = setup();
    const subscription = await service.addSubscription({
      url: 'https://example.com/team.ics',
    });
    fetchImpl.mockResolvedValueOnce(
      new Response(calendar([...eventBody('e1', '事件', '2026-10-26')]), {
        status: 200,
      }),
    );
    await service.sync(subscription.id);
    expect(events.rows).toHaveLength(1);

    fetchImpl.mockResolvedValueOnce(
      new Response(
        calendar([
          'BEGIN:VEVENT',
          'DTSTART;VALUE=DATE:20261026',
          'SUMMARY:没有 UID',
          'END:VEVENT',
        ]),
        { status: 200 },
      ),
    );
    await expect(service.sync(subscription.id)).rejects.toThrow(/没有可导入/);
    expect(events.rows).toHaveLength(1);
  });

  it('合法的空日历会清空该订阅镜像，但不碰本地事件', async () => {
    const { service, fetchImpl, events, store } = setup();
    const subscription = await service.addSubscription({
      url: 'https://example.com/team.ics',
    });
    await events.create({
      title: '本地事件',
      startDate: '2026-10-26',
      source: 'local',
    });
    fetchImpl.mockResolvedValueOnce(
      new Response(calendar([...eventBody('e1', '事件', '2026-10-26')]), {
        status: 200,
      }),
    );
    await service.sync(subscription.id);
    expect(events.rows).toHaveLength(2);

    fetchImpl.mockResolvedValueOnce(
      new Response(
        ['BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR'].join(CRLF),
        { status: 200 },
      ),
    );
    const result = await service.sync(subscription.id);
    expect(result.eventCount).toBe(0);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.title).toBe('本地事件');
    expect((await store.getSubscription(subscription.id))?.eventCount).toBe(0);
  });

  it('重复 UID/实例只物化一次，保留 SEQUENCE 更高的修订', async () => {
    const { service, fetchImpl, events } = setup();
    const subscription = await service.addSubscription({
      url: 'https://example.com/team.ics',
    });
    fetchImpl.mockResolvedValueOnce(
      new Response(
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          'UID:dup-1',
          'DTSTART;VALUE=DATE:20261026',
          'SUMMARY:旧标题',
          'END:VEVENT',
          'BEGIN:VEVENT',
          'UID:dup-1',
          'DTSTART;VALUE=DATE:20261026',
          'SUMMARY:新标题',
          'SEQUENCE:2',
          'END:VEVENT',
          'END:VCALENDAR',
        ].join(CRLF),
        { status: 200 },
      ),
    );

    const result = await service.sync(subscription.id);
    expect(result.eventCount).toBe(1);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      title: '新标题',
      externalUid: 'dup-1#2026-10-26',
    });

    // 再次同步同一内容仍保持 1 条。
    fetchImpl.mockResolvedValueOnce(
      new Response(
        [
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          'UID:dup-1',
          'DTSTART;VALUE=DATE:20261026',
          'SUMMARY:新标题',
          'SEQUENCE:2',
          'END:VEVENT',
          'END:VCALENDAR',
        ].join(CRLF),
        { status: 200 },
      ),
    );
    await service.sync(subscription.id);
    expect(events.rows).toHaveLength(1);
  });

  it('浏览器跨域不发送条件头，用 200 原文对比判定未变化', async () => {
    let nowValue = new Date('2026-10-26T10:00:00.000Z');
    const store = new MemoryIcsStore();
    const events = new FakeEventRepository();
    const fetchImpl = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(calendar([...eventBody('e1', '事件', '2026-10-26')]), {
          status: 200,
          headers: { etag: '"v1"' },
        }),
    );
    const service = new IcsSyncService({
      store,
      events,
      httpClient: {
        kind: 'browser',
        supportsConditionalHeaders: () => false,
        fetch: fetchImpl,
      },
      now: () => nowValue,
      newId: () => 'ics_1',
      pastDays: 365,
      futureDays: 365,
    });
    const subscription = await service.addSubscription({
      url: 'https://example.com/team.ics',
    });
    await service.sync(subscription.id);

    nowValue = new Date('2026-10-26T11:00:00.000Z');
    const second = await service.sync(subscription.id);
    expect(second.notModified).toBe(true);
    expect(second.eventCount).toBe(1);
    expect(events.rows).toHaveLength(1);
    const headers = fetchImpl.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers['if-none-match']).toBeUndefined();
    expect(headers['if-modified-since']).toBeUndefined();
    const after = await store.getSubscription(subscription.id);
    expect(after?.lastSyncAt).toBe('2026-10-26T11:00:00.000Z');
    const cache = await store.getCache(subscription.id);
    expect(cache?.fetchedAt).toBe('2026-10-26T11:00:00.000Z');
    expect(cache?.etag).toBe('"v1"');
  });

  it('没有缓存却收到 304 时明确失败，不伪造 lastSyncAt', async () => {
    const { service, fetchImpl, store } = setup();
    const subscription = await service.addSubscription({
      url: 'https://example.com/team.ics',
    });
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 304 }));

    await expect(service.sync(subscription.id)).rejects.toThrow(
      /没有可复用的缓存/,
    );
    const after = await store.getSubscription(subscription.id);
    expect(after?.lastSyncAt).toBeNull();
    expect(after?.lastAttemptAt).toBe('2026-10-26T10:00:00.000Z');
    expect(after?.lastError).toContain('304');
  });

  it('多订阅：一个失败不阻断其他，source 隔离且失败原因可读', async () => {
    let sequence = 0;
    const store = new MemoryIcsStore();
    const events = new FakeEventRepository();
    const service = new IcsSyncService({
      store,
      events,
      fetchImpl: async (input) => {
        if (input.includes('broken')) {
          throw new Error('服务端证书无效');
        }
        return new Response(
          calendar([...eventBody('ok-1', '正常订阅事件', '2026-10-26')]),
          { status: 200 },
        );
      },
      now: () => new Date('2026-10-26T10:00:00.000Z'),
      newId: () => {
        sequence += 1;
        return `ics_${sequence}`;
      },
      pastDays: 365,
      futureDays: 365,
    });
    const good = await service.addSubscription({
      name: '正常',
      url: 'https://example.com/good.ics',
    });
    const broken = await service.addSubscription({
      name: '坏订阅',
      url: 'https://example.com/broken.ics',
    });

    const report = await service.syncAll();
    expect(report.results).toHaveLength(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({
      subscriptionId: broken.id,
      name: '坏订阅',
    });
    expect(report.failures[0]?.message).toContain('证书无效');
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.source).toBe(`ics:${good.id}`);
    expect((await store.getSubscription(good.id))?.lastError).toBeNull();
    expect((await store.getSubscription(broken.id))?.lastError).toContain(
      '证书无效',
    );
    expect((await store.getSubscription(broken.id))?.lastSyncAt).toBeNull();
  });

  it('缓存可独立读取，供断网展示', async () => {
    const { service, fetchImpl, store } = setup();
    const subscription = await service.addSubscription({
      url: 'https://example.com/team.ics',
    });
    fetchImpl.mockResolvedValueOnce(
      new Response(calendar([...eventBody('e1', '缓存事件', '2026-10-26')]), {
        status: 200,
      }),
    );
    await service.sync(subscription.id);
    const cache = (await service.getCached(subscription.id)) as IcsCache;
    expect(cache.events[0]?.summary).toBe('缓存事件');
    expect(cache.fetchedAt).toBe('2026-10-26T10:00:00.000Z');
    void store;
  });
});
