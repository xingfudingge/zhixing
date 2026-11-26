import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type {
  Event,
  EventQuery,
  EventUpdate,
  NewEvent,
} from '../../../../data/db/types';
import type { EventRepository } from '../../../events/eventRepository';
import { IcsSubscriptionsPanel } from '../IcsSubscriptionsPanel';
import { MemoryIcsStore } from '../store';
import { IcsSyncService } from '../sync';

const CALENDAR = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:e1',
  'DTSTART;VALUE=DATE:20261026',
  'SUMMARY:团队启动会',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

class FakeEvents implements EventRepository {
  rows: Event[] = [];

  async list(query: EventQuery = {}): Promise<Event[]> {
    void query;
    return this.rows;
  }

  async create(input: NewEvent): Promise<Event> {
    const now = new Date().toISOString();
    const row: Event = {
      id: `evt_${this.rows.length + 1}`,
      spaceId: 'personal',
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
    return row;
  }

  async update(id: string, input: EventUpdate): Promise<Event> {
    const row = this.rows.find((item) => item.id === id)!;
    Object.assign(row, input);
    return row;
  }

  async remove(id: string): Promise<void> {
    this.rows = this.rows.filter((item) => item.id !== id);
  }
}

function setup(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  options: { newId?: () => string } = {},
) {
  const store = new MemoryIcsStore();
  const events = new FakeEvents();
  const service = new IcsSyncService({
    store,
    events,
    fetchImpl,
    now: () => new Date('2026-10-26T10:00:00.000Z'),
    newId: options.newId ?? (() => 'ics_ui'),
  });
  return { service, store, events };
}

describe('ICS 订阅面板', () => {
  it('添加订阅后显示只读标签、最后同步时间与事件数', async () => {
    const { service } = setup(async () => new Response(CALENDAR, { status: 200 }));
    const user = userEvent.setup();
    render(<IcsSubscriptionsPanel service={service} />);

    expect(
      screen.getByText(/还没有 ICS 订阅/),
    ).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('例如：团队日历'), '团队');
    await user.type(
      screen.getByPlaceholderText('https://example.com/calendar.ics'),
      'https://example.com/team.ics',
    );
    await user.click(screen.getByRole('button', { name: '添加订阅' }));

    expect(await screen.findByText('团队')).toBeInTheDocument();
    expect(screen.getAllByText('只读').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/事件实例：/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('尚未同步')).not.toBeInTheDocument();
    });
    expect(screen.getByText(/最后同步：/)).toBeInTheDocument();
    expect(screen.getByText(/最后尝试：/)).toBeInTheDocument();
    expect(screen.queryByText(/可写/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/不会把外部事件自动变成任务/),
    ).toBeInTheDocument();
  });

  it('非法 URL 明确报错，且不创建订阅', async () => {
    const { service } = setup(async () => new Response(CALENDAR, { status: 200 }));
    const user = userEvent.setup();
    render(<IcsSubscriptionsPanel service={service} />);

    await user.type(
      screen.getByPlaceholderText('https://example.com/calendar.ics'),
      'not-a-url',
    );
    await user.click(screen.getByRole('button', { name: '添加订阅' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'ICS 地址不是合法 URL',
    );
    expect(await service.listSubscriptions()).toHaveLength(0);
    expect(screen.getByText(/还没有 ICS 订阅/)).toBeInTheDocument();
  });

  it('重新挂载（模拟刷新）后保留最后同步时间，不伪造已同步', async () => {
    const { service } = setup(async () => new Response(CALENDAR, { status: 200 }));
    const user = userEvent.setup();
    const first = render(<IcsSubscriptionsPanel service={service} />);

    await user.type(
      screen.getByPlaceholderText('https://example.com/calendar.ics'),
      'https://example.com/team.ics',
    );
    await user.click(screen.getByRole('button', { name: '添加订阅' }));
    await waitFor(() => {
      expect(screen.queryByText('尚未同步')).not.toBeInTheDocument();
    });
    expect(
      (await service.listSubscriptions())[0]?.lastSyncAt,
    ).toBe('2026-10-26T10:00:00.000Z');

    first.unmount();
    render(<IcsSubscriptionsPanel service={service} />);

    expect(
      await screen.findByText('https://example.com/team.ics'),
    ).toBeInTheDocument();
    expect(screen.getByText(/最后同步：/)).toBeInTheDocument();
    expect(screen.queryByText('尚未同步')).not.toBeInTheDocument();
    expect(screen.queryByText(/可写/)).not.toBeInTheDocument();
  });

  it('同步失败时显示错误与最后尝试时间，订阅仍保留', async () => {
    const { service } = setup(async () => {
      throw new Error('网络不可达');
    });
    const user = userEvent.setup();
    render(<IcsSubscriptionsPanel service={service} />);
    await user.type(
      screen.getByPlaceholderText('https://example.com/calendar.ics'),
      'https://example.com/team.ics',
    );
    await user.click(screen.getByRole('button', { name: '添加订阅' }));

    expect(
      (await screen.findAllByText(/无法获取 ICS/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/最后同步：/)).toBeInTheDocument();
    expect(screen.getByText('尚未同步')).toBeInTheDocument();
  });

  it('删除订阅需要二次确认，确认后列表清空且说明保留事件与任务', async () => {
    const { service } = setup(async () => new Response(CALENDAR, { status: 200 }));
    const user = userEvent.setup();
    render(<IcsSubscriptionsPanel service={service} />);
    await user.type(
      screen.getByPlaceholderText('https://example.com/calendar.ics'),
      'https://example.com/team.ics',
    );
    await user.click(screen.getByRole('button', { name: '添加订阅' }));
    await screen.findByText('https://example.com/team.ics');

    await user.click(screen.getByRole('button', { name: /删除订阅/ }));
    expect(
      screen.getByText(/只删除订阅和缓存，已导入的事件与任务保留/),
    ).toBeInTheDocument();
    // 取消不会删除订阅。
    await user.click(screen.getByRole('button', { name: /取消删除订阅/ }));
    expect(screen.getByText('https://example.com/team.ics')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /删除订阅/ }));
    await user.click(screen.getByRole('button', { name: /确认删除订阅/ }));
    await waitFor(() => {
      expect(screen.getByText(/还没有 ICS 订阅/)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/只删除了订阅和缓存，已导入的本地事件与任务保留/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/取消订阅不会删除知行任务或已导入的本地事件/),
    ).toBeInTheDocument();
  });

  it('重新打开设置页后保留事件数、最后同步与错误状态', async () => {
    let fail = false;
    const { service, events } = setup(async () => {
      if (fail) throw new Error('网络不可达');
      return new Response(CALENDAR, { status: 200 });
    });
    const user = userEvent.setup();
    const first = render(<IcsSubscriptionsPanel service={service} />);
    await user.type(
      screen.getByPlaceholderText('https://example.com/calendar.ics'),
      'https://example.com/team.ics',
    );
    await user.click(screen.getByRole('button', { name: '添加订阅' }));
    await waitFor(() => {
      expect(screen.queryByText('尚未同步')).not.toBeInTheDocument();
    });
    expect(events.rows).toHaveLength(1);

    fail = true;
    await user.click(screen.getByRole('button', { name: /立即同步订阅/ }));
    expect(
      (await screen.findAllByText(/无法获取 ICS/)).length,
    ).toBeGreaterThan(0);

    first.unmount();
    render(<IcsSubscriptionsPanel service={service} />);
    const row = (await screen.findByText('https://example.com/team.ics')).closest(
      '[data-subscription-id]',
    ) as HTMLElement;
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent('事件实例：1');
    expect(row).toHaveTextContent('最后同步：');
    expect(row).not.toHaveTextContent('最后同步：尚未同步');
    expect(row).toHaveTextContent('无法获取 ICS');
    expect(row).toHaveTextContent('沿用最近一次成功缓存');
    // 事件物化没有因为失败被清空。
    expect(events.rows).toHaveLength(1);
  });

  it('全部同步：单个订阅失败不阻断其他订阅，并汇总失败原因', async () => {
    let sequence = 0;
    const { service, events } = setup(
      async (input) => {
        if (input.includes('broken')) {
          throw new Error('CORS 被拦截');
        }
        return new Response(CALENDAR, { status: 200 });
      },
      {
        newId: () => {
          sequence += 1;
          return `ics_${sequence}`;
        },
      },
    );
    const user = userEvent.setup();
    render(<IcsSubscriptionsPanel service={service} />);
    const urlInput = screen.getByPlaceholderText(
      'https://example.com/calendar.ics',
    );

    await user.type(urlInput, 'https://example.com/good.ics');
    await user.click(screen.getByRole('button', { name: '添加订阅' }));
    await screen.findByText('https://example.com/good.ics');
    await user.type(urlInput, 'https://example.com/broken.ics');
    await user.click(screen.getByRole('button', { name: '添加订阅' }));
    await screen.findByText('https://example.com/broken.ics');

    await user.click(screen.getByRole('button', { name: '全部同步' }));
    expect(
      await screen.findByText(/全部同步：1 个成功，1 个失败/),
    ).toBeInTheDocument();
    expect(
      (await screen.findAllByText(/broken\.ics|CORS 被拦截/)).length,
    ).toBeGreaterThan(0);
    expect(events.rows).toHaveLength(1);
  });

  it('成功同步但存在解析警告时，保留事件并显示警告', async () => {
    const withWarning = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:e1',
      'DTSTART;VALUE=DATE:20261026',
      'SUMMARY:有效事件',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20261027',
      'SUMMARY:缺少 UID',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const { service, events } = setup(
      async () => new Response(withWarning, { status: 200 }),
    );
    const user = userEvent.setup();
    render(<IcsSubscriptionsPanel service={service} />);
    await user.type(
      screen.getByPlaceholderText('https://example.com/calendar.ics'),
      'https://example.com/warn.ics',
    );
    await user.click(screen.getByRole('button', { name: '添加订阅' }));

    expect(
      (await screen.findAllByText(/解析警告：跳过缺少 UID 的事件/)).length,
    ).toBeGreaterThan(0);
    expect(events.rows).toHaveLength(1);
  });
});
