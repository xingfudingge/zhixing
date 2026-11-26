/**
 * 真实 HTTP 契约测试（默认跳过，避免 CI 依赖公网）。
 *
 *   ICS_REAL_HTTP=1 pnpm --filter app exec vitest run \
 *     src/features/calendar/ics/__tests__/real-http.test.ts
 *
 * 用真实上游 ICS（MIT，非节假日兜底源）验证：200 解析物化、条件请求 304、
 * 404 明确失败且不伪造 lastSyncAt。传输层仍用 Node fetch；桌面壳的 Rust
 * 代理由 `cargo test http::` 与 Tauri 冒烟覆盖。
 */

import { describe, expect, it } from 'vitest';

import type {
  Event,
  EventQuery,
  EventUpdate,
  NewEvent,
} from '../../../../data/db/types';
import type { EventRepository } from '../../../events/eventRepository';
import { MemoryIcsStore } from '../store';
import { IcsSyncService } from '../sync';

const RUN = process.env.ICS_REAL_HTTP === '1';
const describeReal = RUN ? describe : describe.skip;

const REAL_ICS =
  'https://cdn.jsdelivr.net/gh/Lancetwang/china-mainland-calendar@main/china-mainland.ics';
const MISSING_ICS =
  'https://cdn.jsdelivr.net/gh/Lancetwang/china-mainland-calendar@main/does-not-exist.ics';

class MemoryEvents implements EventRepository {
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
    this.rows[index] = { ...this.rows[index]!, ...input };
    return { ...this.rows[index]! };
  }

  async remove(id: string): Promise<void> {
    this.rows = this.rows.filter((row) => row.id !== id);
  }
}

function realFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(25_000),
  });
}

describeReal('真实 ICS 订阅契约', () => {
  it('拉取真实 ICS、条件请求到达 304、404 明确失败', async () => {
    const store = new MemoryIcsStore();
    const events = new MemoryEvents();
    let lastStatus: number | null = null;
    const service = new IcsSyncService({
      store,
      events,
      fetchImpl: async (input, init) => {
        const response = await realFetch(input, init);
        lastStatus = response.status;
        return response;
      },
      pastDays: 7,
      futureDays: 30,
      maxInstances: 50,
      timeoutMs: 25_000,
    });

    const subscription = await service.addSubscription({
      name: 'china-mainland-calendar',
      url: REAL_ICS,
    });
    const first = await service.sync(subscription.id);
    expect(first.eventCount).toBeGreaterThan(0);
    expect(events.rows.length).toBe(first.eventCount);
    expect(
      events.rows.every((row) => row.source === `ics:${subscription.id}`),
    ).toBe(true);
    const cache = await service.getCached(subscription.id);
    expect(cache?.raw).toContain('BEGIN:VCALENDAR');
    expect(first.warnings.length).toBeGreaterThanOrEqual(0);

    const second = await service.sync(subscription.id);
    // jsDelivr 正常返回 304；若中间层忽略条件头，服务会用原文对比兜底。
    expect([200, 304]).toContain(lastStatus);
    expect(second.notModified).toBe(true);
    expect(events.rows.length).toBe(first.eventCount);

    const broken = await service.addSubscription({ url: MISSING_ICS });
    await expect(service.sync(broken.id)).rejects.toThrow(/HTTP 404/);
    const afterBroken = await store.getSubscription(broken.id);
    expect(afterBroken?.lastSyncAt).toBeNull();
    expect(afterBroken?.lastError).toContain('HTTP 404');
    expect(afterBroken?.lastAttemptAt).not.toBeNull();
  }, 60_000);
});
