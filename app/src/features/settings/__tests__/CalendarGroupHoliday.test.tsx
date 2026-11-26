import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_APP_SETTINGS,
  readLocalSettings,
  SETTING_KEYS,
} from '../../../data/repositories/settings';
import { settingsGroupOf } from '../../../app/shell/navigation';
import { HolidaySyncService } from '../../calendar/holiday/sync';
import { MemoryHolidayPackageStore } from '../../calendar/holiday/store';
import type { SettingsSource } from '../source';
import { SettingsWorkspace } from '../SettingsWorkspace';
import { typeDate } from '../../../test/datePicker';
import { createFakeSettingsSource } from './fakeSettingsSource';

const NOW = () => new Date('2026-10-26T08:05:00.000Z');
const SYNC_NOW = () => new Date(2026, 10, 1, 12, 0, 0);
const JSDELIVR_2026 =
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json';

const DAYS_2026 = [
  { name: '元旦', date: '2026-01-01', isOffDay: true },
  { name: '元旦', date: '2026-01-02', isOffDay: true },
  { name: '元旦', date: '2026-01-03', isOffDay: true },
  { name: '元旦调休上班', date: '2026-01-04', isOffDay: false },
  { name: '国庆节', date: '2026-10-01', isOffDay: true },
  { name: '国庆调休上班', date: '2026-10-10', isOffDay: false },
];

function payload(): string {
  return JSON.stringify({ year: 2026, papers: [], days: DAYS_2026 });
}

const CHINESE_DAYS_PAYLOAD = JSON.stringify({
  holidays: {
    '2026-01-01': "New Year's Day,元旦,1",
    '2026-01-02': "New Year's Day,元旦,1",
    '2026-01-03': "New Year's Day,元旦,1",
    '2026-10-01': 'National Day,国庆节,3',
    '2026-10-02': 'National Day,国庆节,3',
  },
  workdays: {
    '2026-01-04': "New Year's Day,元旦,1",
    '2026-10-10': 'National Day,国庆节,3',
  },
});

const ICS_PAYLOAD = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'SUMMARY:元旦休假',
  'DTSTART;VALUE=DATE:20260101',
  'DTEND;VALUE=DATE:20260105',
  'CATEGORIES:连续休假',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:元旦调休上班',
  'DTSTART;VALUE=DATE:20260105',
  'DTEND;VALUE=DATE:20260106',
  'CATEGORIES:调休补班',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:国庆节',
  'DTSTART;VALUE=DATE:20261001',
  'DTEND;VALUE=DATE:20261002',
  'CATEGORIES:法定节日',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:国庆调休上班',
  'DTSTART;VALUE=DATE:20261010',
  'DTEND;VALUE=DATE:20261011',
  'CATEGORIES:调休补班',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function setupHolidayService() {
  const store = new MemoryHolidayPackageStore();
  const fetchImpl = vi.fn();
  const service = new HolidaySyncService({
    store,
    fetchImpl: fetchImpl as unknown as (
      input: string,
      init?: RequestInit,
    ) => Promise<Response>,
    now: SYNC_NOW,
    timeoutMs: 50,
    targetYears: () => [2026],
  });
  return { store, fetchImpl, service };
}

function Harness({
  source,
  holidayService,
}: {
  source: SettingsSource;
  holidayService: HolidaySyncService;
}) {
  const { group } = useParams();
  const meta = settingsGroupOf(group) ?? settingsGroupOf('calendar')!;
  return (
    <SettingsWorkspace
      group={meta.id}
      source={source}
      now={NOW}
      holidayService={holidayService}
    />
  );
}

function renderCalendarGroup(
  options: { initial?: typeof DEFAULT_APP_SETTINGS } = {},
) {
  const fake = createFakeSettingsSource(options);
  const holiday = setupHolidayService();
  const view = render(
    <MemoryRouter initialEntries={['/settings/calendar']}>
      <Routes>
        <Route
          path="/settings/:group"
          element={
            <Harness source={fake.source} holidayService={holiday.service} />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { ...fake, ...holiday, ...view };
}

async function readSettings(source: SettingsSource) {
  const rows = await source.settings.list({ scope: 'device' });
  const value = rows.find(
    (row) => row.key === SETTING_KEYS.calendarDateExceptions,
  )?.value;
  return value as Array<{ date: string; kind: string; note: string }>;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('节假日同步源 UI', () => {
  it('切到 holiday-cn 后手动同步：真实请求、写版本/时间与缓存', async () => {
    const user = userEvent.setup();
    const { source, fetchImpl, store } = renderCalendarGroup();
    fetchImpl.mockResolvedValueOnce(
      new Response(payload(), {
        status: 200,
        headers: { etag: '"v1"', 'content-type': 'application/json' },
      }),
    );

    await user.selectOptions(
      screen.getByLabelText('节假日数据源'),
      'holiday-cn',
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '立即同步' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: '立即同步' }));

    await waitFor(() => {
      expect(screen.getByText(/已同步 2026 年节假日/)).toBeInTheDocument();
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      JSDELIVR_2026,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(screen.getByText('2026:v1')).toBeInTheDocument();
    expect(screen.getAllByText(/上次成功/).length).toBeGreaterThan(0);
    expect(await store.listPackages()).toHaveLength(1);

    const stored = await source.settings.list({ scope: 'device' });
    expect(
      stored.find(
        (row) => row.key === SETTING_KEYS.calendarHolidaySource,
      )?.value,
    ).toMatchObject({
      mode: 'single',
      sourceId: 'holiday-cn',
      transport: 'auto',
      source: 'jsdelivr',
      autoSync: false,
    });
  });

  it('设置页展示 3 个独立源与内置离线包，传输镜像不算独立源', async () => {
    renderCalendarGroup();
    const list = screen.getByRole('list', { name: '内置节假日源' });
    expect(within(list).getByText('holiday-cn')).toBeInTheDocument();
    expect(within(list).getByText('chinese-days')).toBeInTheDocument();
    expect(
      within(list).getByText('china-mainland-calendar'),
    ).toBeInTheDocument();
    expect(within(list).getByText('内置离线包')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByLabelText('节假日数据源'),
      'holiday-cn',
    );
    const transport = await screen.findByLabelText('节假日传输方式');
    expect(
      within(transport).getByRole('option', {
        name: 'GitHub Raw（同源镜像）',
      }),
    ).toBeInTheDocument();
    expect(
      within(transport).queryByRole('option', { name: 'holiday-cn' }),
    ).not.toBeInTheDocument();
  });

  it('可分别切换 3 个独立源并各自同步', async () => {
    const user = userEvent.setup();
    const { fetchImpl } = renderCalendarGroup();

    fetchImpl.mockResolvedValueOnce(
      new Response(CHINESE_DAYS_PAYLOAD, { status: 200 }),
    );
    await user.selectOptions(
      screen.getByLabelText('节假日数据源'),
      'chinese-days',
    );
    await user.click(screen.getByRole('button', { name: '立即同步' }));
    await screen.findByText(/已同步 2026 年节假日（chinese-days）/);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cdn.jsdelivr.net/npm/chinese-days@1.5.9/dist/years/2026.json',
      expect.objectContaining({ method: 'GET' }),
    );

    fetchImpl.mockResolvedValueOnce(new Response(ICS_PAYLOAD, { status: 200 }));
    await user.selectOptions(
      screen.getByLabelText('节假日数据源'),
      'china-mainland-calendar',
    );
    await user.click(screen.getByRole('button', { name: '立即同步' }));
    await screen.findByText(
      /已同步 2026 年节假日（china-mainland-calendar）/,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cdn.jsdelivr.net/gh/Lancetwang/china-mainland-calendar@main/china-mainland.ics',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('同步失败显示明确错误，不伪装成功也不清空缓存', async () => {
    const user = userEvent.setup();
    const { source, fetchImpl, store } = renderCalendarGroup({
      initial: {
        ...DEFAULT_APP_SETTINGS,
        calendar: {
          ...DEFAULT_APP_SETTINGS.calendar,
          holidaySource: {
            mode: 'single',
            sourceId: 'holiday-cn',
            transport: 'jsdelivr',
            customUrl: '',
            customFormat: 'holiday-cn-json',
            autoSync: false,
            autoFallback: false,
            source: 'jsdelivr',
          },
        },
      },
    });
    fetchImpl.mockResolvedValueOnce(new Response('boom', { status: 500 }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '立即同步' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: '立即同步' }));

    expect(
      await screen.findByText(/节假日同步失败：.*HTTP 500/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/已同步/)).not.toBeInTheDocument();
    expect(await store.listPackages()).toEqual([]);
    const state = await store.getState();
    expect(state?.lastError).toContain('HTTP 500');
    expect(
      (
        await source.settings.list({ scope: 'device' })
      ).find((row) => row.key === SETTING_KEYS.calendarHolidaySource)?.value,
    ).toMatchObject({ mode: 'single', sourceId: 'holiday-cn' });
  });

  it('自动回退会显示回退源与失败原因，不静默成功', async () => {
    const user = userEvent.setup();
    const { fetchImpl, store } = renderCalendarGroup();
    fetchImpl
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(CHINESE_DAYS_PAYLOAD, { status: 200 }),
      );

    await user.selectOptions(
      screen.getByLabelText('节假日数据源'),
      'auto',
    );
    await user.selectOptions(
      await screen.findByLabelText('节假日传输方式'),
      'jsdelivr',
    );
    await user.click(screen.getByRole('button', { name: '立即同步' }));

    expect(
      await screen.findByText(/已回退到 chinese-days.*HTTP 503/),
    ).toBeInTheDocument();
    const state = await store.getState();
    expect(state?.activeSourceId).toBe('chinese-days');
    expect(state?.fallbackUsed).toBe(true);
    expect(state?.fallbackFromSourceId).toBe('holiday-cn');
    expect(state?.fallbackReason).toContain('HTTP 503');
    const list = screen.getByRole('list', { name: '内置节假日源' });
    expect(within(list).getByText('失败')).toBeInTheDocument();
    expect(within(list).getByText('当前源')).toBeInTheDocument();
  });

  it('回退后重新打开设置页，当前源与回退文案仍指向真实 active', async () => {
    const user = userEvent.setup();
    const { fetchImpl, source, service, unmount } = renderCalendarGroup();
    fetchImpl
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(CHINESE_DAYS_PAYLOAD, { status: 200 }),
      );

    await user.selectOptions(
      screen.getByLabelText('节假日数据源'),
      'auto',
    );
    await user.selectOptions(
      await screen.findByLabelText('节假日传输方式'),
      'jsdelivr',
    );
    await user.click(screen.getByRole('button', { name: '立即同步' }));
    await screen.findByText(/已回退到 chinese-days.*HTTP 503/);

    unmount();
    render(
      <MemoryRouter initialEntries={['/settings/calendar']}>
        <Routes>
          <Route
            path="/settings/:group"
            element={
              <Harness source={source} holidayService={service} />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('chinese-days · jsdelivr')).toBeInTheDocument();
    expect(
      screen.getByText(/从 holiday-cn 回退到 chinese-days/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/china-mainland-calendar · jsdelivr/),
    ).not.toBeInTheDocument();
  });

  it('自动同步开关写入设置；内置源时禁用', async () => {
    const user = userEvent.setup();
    const { source, fetchImpl } = renderCalendarGroup();
    expect(
      screen.getByRole('switch', { name: '自动同步节假日' }),
    ).toBeDisabled();

    await user.selectOptions(
      screen.getByLabelText('节假日数据源'),
      'holiday-cn',
    );
    const toggle = await screen.findByRole('switch', {
      name: '自动同步节假日',
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    fetchImpl.mockResolvedValueOnce(new Response(payload(), { status: 200 }));
    await user.click(toggle);

    await waitFor(async () => {
      const rows = await source.settings.list({ scope: 'device' });
      expect(
        rows.find(
          (row) => row.key === SETTING_KEYS.calendarHolidaySource,
        )?.value,
      ).toMatchObject({
        mode: 'single',
        sourceId: 'holiday-cn',
        autoSync: true,
      });
    });
  });

  it('自定义 URL 非法时报错，合法时保存并推断格式', async () => {
    const user = userEvent.setup();
    const { source } = renderCalendarGroup();

    await user.selectOptions(
      screen.getByLabelText('节假日数据源'),
      'custom',
    );
    const input = await screen.findByLabelText('自定义节假日 URL');
    await user.type(input, 'file:///etc/passwd');
    await user.click(screen.getByRole('button', { name: '保存地址' }));
    expect(
      await screen.findByText(/只支持 http\/https/),
    ).toBeInTheDocument();

    await user.clear(input);
    fireEvent.change(input, {
      target: { value: 'https://example.com/h-{year}.json' },
    });
    await user.click(screen.getByRole('button', { name: '保存地址' }));

    await waitFor(async () => {
      const rows = await source.settings.list({ scope: 'device' });
      expect(
        rows.find(
          (row) => row.key === SETTING_KEYS.calendarHolidaySource,
        )?.value,
      ).toMatchObject({
        mode: 'custom',
        source: 'custom',
        customUrl: 'https://example.com/h-{year}.json',
        customFormat: 'holiday-cn-json',
      });
    });
  });

  it('清除当前源缓存不清源设置，也保留个人日期例外', async () => {
    const user = userEvent.setup();
    const { source, fetchImpl, store } = renderCalendarGroup({
      initial: {
        ...DEFAULT_APP_SETTINGS,
        calendar: {
          ...DEFAULT_APP_SETTINGS.calendar,
          dateExceptions: [
            { date: '2026-12-31', kind: 'work', note: '跨年值班' },
          ],
        },
      },
    });
    fetchImpl.mockResolvedValueOnce(new Response(payload(), { status: 200 }));
    await user.selectOptions(
      screen.getByLabelText('节假日数据源'),
      'holiday-cn',
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '立即同步' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: '立即同步' }));
    await screen.findByText(/已同步 2026 年节假日/);

    await user.click(screen.getByRole('button', { name: '清除当前源缓存' }));

    await waitFor(() => {
      expect(screen.getByText(/已清除当前源缓存/)).toBeInTheDocument();
    });
    expect(screen.getByLabelText('节假日数据源')).toHaveValue('holiday-cn');
    expect(await store.listPackages('holiday-cn')).toEqual([]);
    expect(readLocalSettings().calendar.holidaySource.mode).toBe('single');
    expect(readLocalSettings().calendar.holidaySource.sourceId).toBe(
      'holiday-cn',
    );
    expect(await readSettings(source)).toEqual([
      { date: '2026-12-31', kind: 'work', note: '跨年值班' },
    ]);
  });
});

describe('个人日期例外 UI', () => {
  it('添加、同日更新、删除；写入设置并保持排序', async () => {
    const user = userEvent.setup();
    const { source } = renderCalendarGroup();

    await typeDate(user, screen.getByLabelText('例外日期'), '2026-10-08');
    await user.selectOptions(screen.getByLabelText('例外类型'), 'rest');
    await user.type(screen.getByLabelText('例外备注'), '请假');
    await user.click(screen.getByRole('button', { name: '添加例外' }));

    await waitFor(async () => {
      expect(await readSettings(source)).toEqual([
        { date: '2026-10-08', kind: 'rest', note: '请假' },
      ]);
    });
    expect(screen.getByText('2026-10-08 周四')).toBeInTheDocument();

    // 同一天再次保存：更新而不是追加。
    await typeDate(user, screen.getByLabelText('例外日期'), '2026-10-08');
    await user.selectOptions(screen.getByLabelText('例外类型'), 'work');
    await user.type(screen.getByLabelText('例外备注'), '补班');
    await user.click(screen.getByRole('button', { name: '添加例外' }));

    await waitFor(async () => {
      expect(await readSettings(source)).toEqual([
        { date: '2026-10-08', kind: 'work', note: '补班' },
      ]);
    });
    const list = screen.getByRole('list', { name: '个人日期例外列表' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('补班')).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: '删除' }));
    await waitFor(async () => {
      expect(await readSettings(source)).toEqual([]);
    });
    expect(screen.getByText('还没有个人日期例外。')).toBeInTheDocument();
  });

  it('编辑按钮回填表单，保存后更新同一天', async () => {
    const user = userEvent.setup();
    const { source } = renderCalendarGroup({
      initial: {
        ...DEFAULT_APP_SETTINGS,
        calendar: {
          ...DEFAULT_APP_SETTINGS.calendar,
          dateExceptions: [
            { date: '2026-12-31', kind: 'work', note: '跨年值班' },
          ],
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: '编辑' }));
    expect(screen.getByLabelText('例外日期')).toHaveValue('2026-12-31');
    expect(screen.getByLabelText('例外类型')).toHaveValue('work');
    expect(screen.getByLabelText('例外备注')).toHaveValue('跨年值班');

    await user.selectOptions(screen.getByLabelText('例外类型'), 'rest');
    await user.click(screen.getByRole('button', { name: '更新例外' }));

    await waitFor(async () => {
      expect(await readSettings(source)).toEqual([
        { date: '2026-12-31', kind: 'rest', note: '跨年值班' },
      ]);
    });
    expect(
      screen.queryByRole('button', { name: '更新例外' }),
    ).not.toBeInTheDocument();
  });
});
