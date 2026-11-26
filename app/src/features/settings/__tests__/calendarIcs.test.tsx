import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { CalendarWorkspace } from '../../calendar/CalendarWorkspace';
import { MemoryIcsStore } from '../../calendar/ics/store';
import { IcsSyncService } from '../../calendar/ics/sync';
import {
  createFakeCalendarSource,
  makeEvent,
  type FakeCalendarSource,
} from '../../calendar/__tests__/fakeCalendarSource';
import {
  createFakeTaskSource,
  TEST_TODAY,
} from '../../tasks/__tests__/fakeTaskSource';
import { SettingsWorkspace } from '../SettingsWorkspace';
import { createFakeSettingsSource } from './fakeSettingsSource';

const NOW = () => new Date('2026-10-26T10:00:00.000Z');
const ICS_URL = 'https://example.com/team.ics';

const CALENDAR = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-CALNAME:团队日历',
  'BEGIN:VEVENT',
  'UID:ext-standup',
  'DTSTART;VALUE=DATE:20261029',
  'SUMMARY:外部会议',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function createService(
  events: FakeCalendarSource['events'],
  options: {
    fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
  },
) {
  const store = new MemoryIcsStore();
  const service = new IcsSyncService({
    store,
    events,
    fetchImpl: options.fetchImpl,
    now: NOW,
    newId: () => 'ics_cal',
    timeoutMs: options.timeoutMs,
    pastDays: 30,
    futureDays: 30,
  });
  return { store, service };
}

function renderSettings(service: IcsSyncService) {
  const fake = createFakeSettingsSource();
  const view = render(
    <MemoryRouter initialEntries={['/settings/calendar']}>
      <Routes>
        <Route
          path="/settings/:group"
          element={
            <SettingsWorkspace
              group="calendar"
              source={fake.source}
              now={NOW}
              icsService={service}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { ...view, fake };
}

function renderCalendar(calendarSource: FakeCalendarSource) {
  return render(
    <MemoryRouter initialEntries={['/calendar']}>
      <Routes>
        <Route
          path="/calendar"
          element={
            <CalendarWorkspaceHarness calendarSource={calendarSource} />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function CalendarWorkspaceHarness({
  calendarSource,
}: {
  calendarSource: FakeCalendarSource;
}) {
  // 单独抽组件，避免在 JSX 中重复构造 TaskSource。
  return (
    <CalendarWorkspace
      taskSource={createFakeTaskSource()}
      calendarSource={calendarSource}
      today={TEST_TODAY}
      initialDate="2026-10-29"
    />
  );
}

async function addSubscription(
  user: ReturnType<typeof userEvent.setup>,
  url = ICS_URL,
) {
  await user.type(
    await screen.findByPlaceholderText('https://example.com/calendar.ics'),
    url,
  );
  await user.click(screen.getByRole('button', { name: '添加订阅' }));
}

describe('日历设置中的 ICS 外部日历', () => {
  it('合法 ICS 导入后以只读方式出现在日历中，且请求只有 GET', async () => {
    const calendar = createFakeCalendarSource({
      events: [
        makeEvent({
          id: 'local-event',
          title: '本地评审',
          startDate: '2026-10-26',
          startAt: '2026-10-26T09:00:00',
        }),
      ],
    });
    const fetchImpl = vi.fn(
      async (_input: string, _init?: RequestInit) =>
        new Response(CALENDAR, { status: 200 }),
    );
    const { service } = createService(calendar.events, { fetchImpl });
    const user = userEvent.setup();
    const settingsView = renderSettings(service);

    await user.type(
      screen.getByPlaceholderText('例如：团队日历'),
      '团队日历',
    );
    await addSubscription(user);

    expect(await screen.findByText('团队日历')).toBeInTheDocument();
    expect(await screen.findByText(/同步完成：1 个事件实例/)).toBeInTheDocument();
    expect(screen.queryByText('尚未同步')).not.toBeInTheDocument();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });

    const imported = calendar
      .snapshot()
      .events.find((event) => event.source === 'ics:ics_cal');
    expect(imported).toMatchObject({
      title: '外部会议',
      startDate: '2026-10-29',
      externalUid: 'ext-standup#2026-10-29',
    });
    expect(
      calendar.snapshot().events.find((event) => event.id === 'local-event'),
    ).toBeTruthy();

    settingsView.unmount();
    renderCalendar(calendar);

    const cell = await screen.findByTestId('day-2026-10-29');
    const externalChip = await within(cell).findByRole('button', {
      name: '事件：外部会议（只读）',
    });
    expect(externalChip).toHaveAttribute('data-readonly', 'true');

    await user.click(externalChip);
    expect(
      await screen.findByText(/外部日历事件为只读/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '事件' }));
    const region = await screen.findByRole('region', { name: '当天事件' });
    const rowTitle = await within(region).findByText('外部会议');
    const row = rowTitle.closest('[data-event-id]') as HTMLElement;
    expect(row).toHaveAttribute('data-event-source', 'ics:ics_cal');
    expect(within(row).getByText('外部 · 只读')).toBeInTheDocument();
    expect(
      within(row).queryByRole('button', { name: '编辑事件「外部会议」' }),
    ).toBeNull();
    expect(
      within(row).queryByRole('button', { name: '删除事件「外部会议」' }),
    ).toBeNull();
    // 只读事件仍可派生本地任务，但不提供写回入口。
    expect(
      within(row).getByRole('button', { name: '从事件「外部会议」建任务' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/写回 ICS/)).not.toBeInTheDocument();
  });

  it('非法 URL 给出明确提示，不发起请求也不影响本地日历', async () => {
    const calendar = createFakeCalendarSource({
      events: [
        makeEvent({
          id: 'local-event',
          title: '本地评审',
          startDate: '2026-10-29',
          startAt: '2026-10-29T09:00:00',
        }),
      ],
    });
    const fetchImpl = vi.fn(async () => new Response(CALENDAR, { status: 200 }));
    const { service } = createService(calendar.events, { fetchImpl });
    const user = userEvent.setup();
    const settingsView = renderSettings(service);

    await addSubscription(user, 'not-a-url');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'ICS 地址不是合法 URL',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await service.listSubscriptions()).toHaveLength(0);
    expect(screen.getByText(/还没有 ICS 订阅/)).toBeInTheDocument();

    settingsView.unmount();
    renderCalendar(calendar);

    const cell = await screen.findByTestId('day-2026-10-29');
    expect(within(cell).getByText('本地评审')).toBeInTheDocument();
    expect(screen.queryByText('外部会议')).not.toBeInTheDocument();
  });

  it('请求超时明确失败，显示尚未同步，且本地事件保留', async () => {
    const calendar = createFakeCalendarSource({
      events: [
        makeEvent({
          id: 'local-event',
          title: '本地评审',
          startDate: '2026-10-29',
          startAt: '2026-10-29T09:00:00',
        }),
      ],
    });
    const { service } = createService(calendar.events, {
      // 不响应 AbortSignal，也不返回：必须由 Promise.race 结束。
      fetchImpl: () => new Promise<Response>(() => {}),
      timeoutMs: 25,
    });
    const user = userEvent.setup();
    const settingsView = renderSettings(service);

    await addSubscription(user);

    expect(
      (await screen.findAllByText(/ICS 拉取超时/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('尚未同步')).toBeInTheDocument();

    const subscription = (await service.listSubscriptions())[0];
    expect(subscription?.lastSyncAt).toBeNull();
    expect(subscription?.lastAttemptAt).toBe('2026-10-26T10:00:00.000Z');
    expect(subscription?.lastError).toContain('超时');
    expect(
      calendar
        .snapshot()
        .events.find((event) => event.id === 'local-event'),
    ).toBeTruthy();

    // 失败后本地日历仍可正常渲染与打开。
    settingsView.unmount();
    renderCalendar(calendar);
    const cell = await screen.findByTestId('day-2026-10-29');
    expect(within(cell).getByText('本地评审')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建事件' })).toBeEnabled();
  });
});
