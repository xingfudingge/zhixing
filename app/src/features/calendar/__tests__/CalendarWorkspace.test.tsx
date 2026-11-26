import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDefaultSeed,
  createFakeTaskSource,
  makeTask,
  TEST_TODAY,
} from '../../tasks/__tests__/fakeTaskSource';
import type { Setting } from '../../../data/db/types';
import {
  CalendarWorkspace,
  type CalendarWorkspaceProps,
} from '../CalendarWorkspace';
import { CalendarChip } from '../CalendarChip';
import { taskEntry } from '../viewModel';
import { openDatePicker, pickDate, typeDate } from '../../../test/datePicker';
import {
  createFakeCalendarSource,
  makeCountdown,
  makeEvent,
} from './fakeCalendarSource';

type RenderOptions = Omit<CalendarWorkspaceProps, 'taskSource' | 'calendarSource'> & {
  taskSource?: ReturnType<typeof createFakeTaskSource>;
  calendarSource?: ReturnType<typeof createFakeCalendarSource>;
};

function renderCalendar(options: RenderOptions = {}) {
  const taskSource = options.taskSource ?? createFakeTaskSource();
  const calendarSource = options.calendarSource ?? createFakeCalendarSource();
  const view = render(
    <MemoryRouter initialEntries={['/calendar']}>
      <Routes>
        <Route
          path="/calendar"
          element={
            <CalendarWorkspace
              taskSource={taskSource}
              calendarSource={calendarSource}
              today={options.today ?? TEST_TODAY}
              initialView={options.initialView}
              initialTab={options.initialTab}
              initialDate={options.initialDate}
            />
          }
        />
        <Route path="/today" element={<div>今天详情页</div>} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...view, taskSource, calendarSource };
}

async function waitForMonth() {
  await screen.findByRole('tab', { name: '日历' });
  return screen.findByTestId('month-grid');
}

async function waitForCalendarReady() {
  await screen.findByRole('tab', { name: '日历' });
}

/** jsdom 没有 elementFromPoint；按设计文档只打桩命中测试。 */
function stubElementFromPoint(element: Element | null) {
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    writable: true,
    value: () => element,
  });
}

function pointerInit(overrides: Record<string, number | boolean> = {}) {
  return {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 40,
    clientY: 40,
    ...overrides,
  };
}

function setting(key: string, value: Setting['value']): Setting {
  return {
    id: `setting-${key}`,
    spaceId: 'personal',
    scope: 'device',
    key,
    value,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  };
}

afterEach(() => {
  Reflect.deleteProperty(document, 'elementFromPoint');
  document
    .querySelectorAll('[data-drag-ghost]')
    .forEach((node) => node.remove());
  document.body.classList.remove('is-calendar-dragging');
  // 触发一次 window click，摘掉上一个用例可能残留的 click 抑制监听。
  window.dispatchEvent(new MouseEvent('click'));
});

describe('日历工作台', () => {
  it('月/周/日切换保留选中日期，上一段/下一段按粒度移动', async () => {
    const user = userEvent.setup();
    renderCalendar({ initialDate: TEST_TODAY });

    const monthGrid = await waitForMonth();
    expect(screen.getByTestId('calendar-title')).toHaveTextContent(
      '2026 年 10 月',
    );
    expect(within(monthGrid).getAllByRole('gridcell')).toHaveLength(42);
    expect(monthGrid.querySelector('[data-date="2026-09-28"]')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: '周视图' }));
    expect(screen.getByTestId('calendar-title')).toHaveTextContent(
      '10月26日 – 11月1日',
    );
    const weekGrid = screen.getByTestId('week-grid');
    expect(weekGrid.querySelectorAll('[data-date]')).toHaveLength(7);
    expect(
      weekGrid.querySelector('[data-date="2026-10-26"]'),
    ).not.toBeNull();

    await user.click(screen.getByRole('button', { name: '日视图' }));
    expect(screen.getByTestId('calendar-title')).toHaveTextContent(
      '10月26日 周一',
    );
    expect(screen.getByTestId('day-view')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '月视图' }));
    expect(screen.getByTestId('calendar-title')).toHaveTextContent(
      '2026 年 10 月',
    );

    await user.click(screen.getByRole('button', { name: '日视图' }));
    await user.click(screen.getByRole('button', { name: '下一段' }));
    expect(screen.getByTestId('calendar-title')).toHaveTextContent(
      '10月27日 周二',
    );
    await user.click(screen.getByRole('button', { name: '上一段' }));
    expect(screen.getByTestId('calendar-title')).toHaveTextContent(
      '10月26日 周一',
    );
    await user.click(screen.getByRole('button', { name: '月视图' }));
    await user.click(screen.getByRole('button', { name: '下一段' }));
    expect(screen.getByTestId('calendar-title')).toHaveTextContent(
      '2026 年 11 月',
    );
    await user.click(screen.getByRole('button', { name: '今天' }));
    expect(screen.getByTestId('calendar-title')).toHaveTextContent(
      '2026 年 10 月',
    );
  });

  it('周起始与工作日规则来自设置：月/周排列与休息日标记同步', async () => {
    const user = userEvent.setup();
    const calendarSource = createFakeCalendarSource({
      settings: [
        setting('calendar.weekStart', 'sunday'),
        setting('calendar.workdayRule', {
          rule: 'single',
          anchorMonday: null,
          customWorkdays: [1, 2, 3, 4, 5],
        }),
      ],
    });
    renderCalendar({
      calendarSource,
      initialDate: TEST_TODAY,
      initialView: 'month',
    });

    const monthGrid = await waitForMonth();
    expect(
      within(monthGrid)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);
    expect(monthGrid.querySelector('[data-date="2026-09-27"]')).not.toBeNull();
    expect(
      monthGrid
        .querySelector('[data-date="2026-10-31"]')
        ?.getAttribute('data-workday'),
    ).toBe('workday');
    expect(
      monthGrid
        .querySelector('[data-date="2026-11-01"]')
        ?.getAttribute('data-workday'),
    ).toBe('rest');

    await user.click(screen.getByRole('button', { name: '周视图' }));
    expect(screen.getByTestId('calendar-title')).toHaveTextContent(
      '10月25日 – 10月31日',
    );
    const weekGrid = screen.getByTestId('week-grid');
    expect(
      weekGrid.querySelectorAll('[data-date]')[0].getAttribute('data-date'),
    ).toBe('2026-10-25');
    expect(
      weekGrid.querySelectorAll('[data-date]')[6].getAttribute('data-date'),
    ).toBe('2026-10-31');
  });

  it('周日开头的月视图真实跨年：2026-01 网格从 2025-12-28 到 2026-02-07', async () => {
    const calendarSource = createFakeCalendarSource({
      settings: [setting('calendar.weekStart', 'sunday')],
    });
    renderCalendar({
      calendarSource,
      initialDate: '2026-01-01',
      initialView: 'month',
    });

    const monthGrid = await waitForMonth();
    expect(screen.getByTestId('calendar-title')).toHaveTextContent(
      '2026 年 1 月',
    );
    expect(within(monthGrid).getAllByRole('gridcell')).toHaveLength(42);
    expect(
      monthGrid.querySelectorAll('[data-date]')[0].getAttribute('data-date'),
    ).toBe('2025-12-28');
    expect(
      monthGrid.querySelectorAll('[data-date]')[41].getAttribute('data-date'),
    ).toBe('2026-02-07');
    expect(
      monthGrid.querySelector('[data-date="2026-01-01"]'),
    ).not.toBeNull();
  });

  it('HTML5 降级：dragStart/drop 从周一至周三只改 dueDate，保留 dueTime', async () => {
    const { taskSource } = renderCalendar({ initialDate: TEST_TODAY });
    const monday = await screen.findByTestId('day-2026-10-26');
    await screen.findByTestId('month-grid');

    const chip = within(monday).getByRole('button', {
      name: '任务：完成新版产品需求文档',
    });
    fireEvent.dragStart(chip);
    const wednesday = screen.getByTestId('day-2026-10-28');
    fireEvent.dragOver(wednesday);
    fireEvent.drop(wednesday);

    await waitFor(() => {
      const task = taskSource
        .snapshot()
        .tasks.find((item) => item.id === 'task-review');
      expect(task?.dueDate).toBe('2026-10-28');
      expect(task?.dueTime).toBe('10:30');
    });

    expect(
      await within(wednesday).findByRole('button', {
        name: '任务：完成新版产品需求文档',
      }),
    ).toBeInTheDocument();
    expect(
      within(monday).queryByText('完成新版产品需求文档'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId('day-panel'),
    ).toHaveTextContent('10月28日 周三');
  });

  it('新建事件同步出现在日历与事件列表；事件建任务字段正确且事件保留', async () => {
    const user = userEvent.setup();
    const { taskSource, calendarSource } = renderCalendar({
      initialDate: TEST_TODAY,
    });
    await waitForMonth();

    await user.click(screen.getByRole('button', { name: '新建事件' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('标题'), '产品评审');
    expect(within(dialog).getByLabelText('日期')).toHaveAttribute(
      'data-value',
      TEST_TODAY,
    );
    fireEvent.change(within(dialog).getByLabelText('时间'), {
      target: { value: '10:00' },
    });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    const monday = await screen.findByTestId('day-2026-10-26');
    expect(await within(monday).findByText('产品评审')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '事件' }));
    const region = await screen.findByRole('region', { name: '当天事件' });
    const rowTitle = await within(region).findByText('产品评审');
    const row = rowTitle.closest('[data-event-id]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).queryByRole('button', { name: /完成/ })).toBeNull();
    expect(within(row).queryByRole('checkbox')).toBeNull();

    await user.click(
      within(row).getByRole('button', {
        name: '从事件「产品评审」建任务',
      }),
    );

    await waitFor(() => {
      const created = taskSource
        .snapshot()
        .tasks.find((task) => task.title === '准备：产品评审');
      expect(created).toMatchObject({
        listId: 'work',
        quadrant: 1,
        priority: 3,
        dueDate: TEST_TODAY,
        dueTime: '10:00',
        status: 'todo',
      });
      expect(created?.notes).toContain('关联事件：产品评审');
    });

    const events = calendarSource
      .snapshot()
      .events.filter((event) => event.deletedAt === null);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('产品评审');
  });

  it('事件弹层可选公历/农历：农历生日保存 calendarType=lunar 并在列表显示农历', async () => {
    const user = userEvent.setup();
    const { calendarSource } = renderCalendar({ initialDate: TEST_TODAY });
    await waitForMonth();

    await user.click(screen.getByRole('button', { name: '新建事件' }));
    const dialog = screen.getByRole('dialog');
    // DEF-AUD014-02：字段必须与原型 evCal 一致。
    expect(within(dialog).getByLabelText('历法')).toHaveValue('solar');
    await user.type(within(dialog).getByLabelText('标题'), '妈妈农历生日');
    await user.selectOptions(within(dialog).getByLabelText('类别'), '生日');
    await user.selectOptions(within(dialog).getByLabelText('历法'), 'lunar');
    // 农历只做标记：弹层给出边界提示，不做公历换算。
    expect(
      within(dialog).getByText(/不会把农历事件换算成下一次公历日期/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const event = calendarSource
        .snapshot()
        .events.find((item) => item.title === '妈妈农历生日');
      expect(event).toMatchObject({
        calendarType: 'lunar',
        eventType: '生日',
        // 用户选的日期原样保存，没有被换算。
        startDate: TEST_TODAY,
        allDay: true,
      });
    });

    await user.click(screen.getByRole('tab', { name: '事件' }));
    const row = (
      await screen.findByText('妈妈农历生日')
    ).closest('[data-event-id]') as HTMLElement;
    expect(row).toHaveTextContent('生日 · 农历 · 单次');

    // 编辑回公历：DB 与列表同步。
    await user.click(
      within(row).getByRole('button', { name: '编辑事件「妈妈农历生日」' }),
    );
    const editDialog = screen.getByRole('dialog');
    expect(within(editDialog).getByLabelText('历法')).toHaveValue('lunar');
    await user.selectOptions(
      within(editDialog).getByLabelText('历法'),
      'solar',
    );
    await user.click(
      within(editDialog).getByRole('button', { name: '保存' }),
    );

    await waitFor(() => {
      const event = calendarSource
        .snapshot()
        .events.find((item) => item.title === '妈妈农历生日');
      expect(event?.calendarType).toBe('solar');
      expect(event?.version).toBe(2);
    });
    await waitFor(() => {
      const updatedRow = screen
        .getByText('妈妈农历生日')
        .closest('[data-event-id]') as HTMLElement;
      expect(updatedRow).toHaveTextContent('生日 · 公历 · 单次');
    });
  });

  it('事件日期统一选择器：农历预览、Esc 只关弹层、确定后保存新日期', async () => {
    const user = userEvent.setup();
    const { calendarSource } = renderCalendar({ initialDate: TEST_TODAY });
    await waitForMonth();

    await user.click(screen.getByRole('button', { name: '新建事件' }));
    const dialog = screen.getByRole('dialog');
    const field = within(dialog).getByLabelText('日期');
    const eventsBefore = calendarSource.snapshot().events.length;
    expect(field.tagName).toBe('INPUT');
    expect(field).toHaveAttribute('data-value', TEST_TODAY);

    const panel = await openDatePicker(user, field);
    expect(panel).toHaveClass('dp-popover');
    expect(within(panel).getByText('农历丙午年九月十七')).toBeInTheDocument();
    expect(panel.querySelectorAll('.dp-day')).toHaveLength(42);

    // Enter 提交焦点日期，但不会连带提交外层事件表单。
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(field).toHaveAttribute('data-value', TEST_TODAY);
    expect(calendarSource.snapshot().events).toHaveLength(eventsBefore);
    expect(within(dialog).queryByRole('alert')).toBeNull();

    // Esc 只取消日期弹层，不关闭外层事件弹层。
    await openDatePicker(user, field);
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(field).toHaveAttribute('data-value', TEST_TODAY);

    await pickDate(
      user,
      within(dialog).getByLabelText('日期'),
      '2026-11-03',
    );
    expect(within(dialog).getByLabelText('日期')).toHaveValue('2026-11-03');

    await user.type(within(dialog).getByLabelText('标题'), '统一日期事件');
    await user.selectOptions(within(dialog).getByLabelText('历法'), 'lunar');
    expect(
      within(dialog).getByTestId('event-lunar-preview'),
    ).toHaveTextContent('日期仍按公历保存');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const event = calendarSource
        .snapshot()
        .events.find((item) => item.title === '统一日期事件');
      expect(event).toMatchObject({
        startDate: '2026-11-03',
        calendarType: 'lunar',
      });
    });
  });

  it('事件输入非法日期时禁用保存，修正后恢复', async () => {
    const user = userEvent.setup();
    renderCalendar({ initialDate: TEST_TODAY });
    await waitForMonth();

    await user.click(screen.getByRole('button', { name: '新建事件' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('标题'), '非法日期事件');
    const field = within(dialog).getByLabelText('日期');
    const save = within(dialog).getByRole('button', { name: '保存' });
    expect(save).toBeEnabled();

    await typeDate(user, field, '2026-02-30');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(save).toBeDisabled();
    expect(screen.getByRole('dialog')).toBe(dialog);

    await typeDate(user, field, '2026-11-03');
    expect(field).toHaveValue('2026-11-03');
    expect(save).toBeEnabled();
  });

  it('倒数日切换农历不清空日期，并派生「每年此日」只读提示', async () => {
    const user = userEvent.setup();
    const { calendarSource } = renderCalendar({ initialTab: 'countdowns' });
    await waitForCalendarReady();

    await user.click(screen.getByRole('button', { name: '新建倒数日' }));
    const dialog = screen.getByRole('dialog');
    const field = within(dialog).getByLabelText('目标日期');
    expect(field).toHaveAttribute('data-value', TEST_TODAY);

    await user.selectOptions(within(dialog).getByLabelText('历法'), 'lunar');
    expect(within(dialog).getByLabelText('目标日期')).toHaveAttribute(
      'data-value',
      TEST_TODAY,
    );
    expect(
      within(dialog).getByTestId('countdown-lunar-preview'),
    ).toHaveTextContent('农历九月十七');

    await user.selectOptions(
      within(dialog).getByLabelText('重复'),
      '每年（农历）',
    );
    expect(
      within(dialog).getByTestId('countdown-lunar-preview'),
    ).toHaveTextContent('农历九月十七 → 每年此日');

    await user.type(within(dialog).getByLabelText('名称'), '奶奶生日');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      const countdown = calendarSource
        .snapshot()
        .countdowns.find((item) => item.title === '奶奶生日');
      expect(countdown).toMatchObject({
        targetDate: TEST_TODAY,
        calendarType: 'lunar',
        repeatRule: '每年（农历）',
      });
    });
  });

  it('事件可编辑时间/类别/重复，删除后从日历与列表消失', async () => {
    const user = userEvent.setup();
    const calendarSource = createFakeCalendarSource({
      events: [
        makeEvent({
          id: 'event-standup',
          title: '旧站会',
          startDate: TEST_TODAY,
          startAt: `${TEST_TODAY}T09:00:00`,
          eventType: '会议',
          repeatRule: '单次',
        }),
      ],
    });
    renderCalendar({ calendarSource, initialTab: 'events' });
    await waitForCalendarReady();

    await user.click(
      await screen.findByRole('button', { name: '编辑事件「旧站会」' }),
    );
    const dialog = screen.getByRole('dialog');
    const titleInput = within(dialog).getByLabelText('标题');
    await user.clear(titleInput);
    await user.type(titleInput, '新站会');
    fireEvent.change(within(dialog).getByLabelText('时间'), {
      target: { value: '14:30' },
    });
    await user.selectOptions(within(dialog).getByLabelText('类别'), '工作日程');
    await user.selectOptions(within(dialog).getByLabelText('重复'), '每周');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const event = calendarSource
        .snapshot()
        .events.find((item) => item.id === 'event-standup');
      expect(event).toMatchObject({
        title: '新站会',
        startDate: TEST_TODAY,
        startAt: `${TEST_TODAY}T14:30:00`,
        allDay: false,
        eventType: '工作日程',
        repeatRule: '每周',
        version: 2,
      });
    });
    expect(await screen.findByText('新站会')).toBeInTheDocument();
    expect(screen.queryByText('旧站会')).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: '删除事件「新站会」' }),
    );
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: '删除事件',
      }),
    );

    await waitFor(() => {
      const event = calendarSource
        .snapshot()
        .events.find((item) => item.id === 'event-standup');
      expect(event?.deletedAt).not.toBeNull();
    });
    await waitFor(() => {
      expect(screen.queryByText('新站会')).not.toBeInTheDocument();
    });
  });

  it('倒数日五类筛选、农历每年显示下一次公历日、单次过去显示已过去 N 天', async () => {
    const user = userEvent.setup();
    const calendarSource = createFakeCalendarSource({
      countdowns: [
        makeCountdown({
          id: 'cd-spring',
          title: '春节',
          category: '热门节日',
          targetDate: '2026-02-17',
          calendarType: 'lunar',
          repeatRule: '每年（农历）',
          lunarMonth: '正月',
          lunarDay: 1,
          note: '农历新年',
        }),
        makeCountdown({
          id: 'cd-past',
          title: '项目启动',
          category: '自定义',
          targetDate: '2026-10-01',
          calendarType: 'solar',
          repeatRule: '单次',
        }),
      ],
    });
    renderCalendar({ calendarSource, initialTab: 'countdowns' });
    await waitForCalendarReady();

    const spring = (await screen.findByText('春节')).closest(
      '[data-countdown-id]',
    ) as HTMLElement;
    expect(spring).not.toBeNull();
    expect(within(spring).getByText(/2027-02-07/)).toBeInTheDocument();
    expect(
      within(spring).getByText(/农历 正月初一/),
    ).toBeInTheDocument();
    expect(within(spring).getByText('104')).toBeInTheDocument();
    expect(within(spring).getByText('天')).toBeInTheDocument();

    const past = screen.getByText('项目启动').closest(
      '[data-countdown-id]',
    ) as HTMLElement;
    expect(within(past).getByText('已过去 25 天')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '节假日' }));
    expect(screen.queryByText('春节')).not.toBeInTheDocument();
    expect(
      screen.getByText('这个分类还没有倒数日，点右上角新建。'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '热门节日' }));
    expect(screen.getByText('春节')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '全部' }));
    await user.click(screen.getByRole('button', { name: '新建倒数日' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('名称'), '旅行');
    await pickDate(
      user,
      within(dialog).getByLabelText('目标日期'),
      '2026-11-01',
    );
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(await screen.findByText('旅行')).toBeInTheDocument();
    expect(
      calendarSource
        .snapshot()
        .countdowns.some(
          (countdown) =>
            countdown.title === '旅行' &&
            countdown.targetDate === '2026-11-01',
        ),
    ).toBe(true);
  });

  it('倒数日可编辑/删除，且不产生任务（不进收件箱/今天）', async () => {
    const user = userEvent.setup();
    const calendarSource = createFakeCalendarSource({
      countdowns: [
        makeCountdown({
          id: 'cd-trip',
          title: '旅行',
          category: '自定义',
          targetDate: '2026-11-01',
          repeatRule: '单次',
        }),
      ],
    });
    const { taskSource } = renderCalendar({
      calendarSource,
      initialTab: 'countdowns',
    });
    const tasksBefore = taskSource.snapshot().tasks.length;
    await waitForCalendarReady();

    await user.click(
      await screen.findByRole('button', { name: '编辑倒数日「旅行」' }),
    );
    const dialog = screen.getByRole('dialog');
    const titleInput = within(dialog).getByLabelText('名称');
    await user.clear(titleInput);
    await user.type(titleInput, '旅行计划');
    await pickDate(
      user,
      within(dialog).getByLabelText('目标日期'),
      '2026-12-01',
    );
    await user.selectOptions(within(dialog).getByLabelText('重复'), '每年');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const countdown = calendarSource
        .snapshot()
        .countdowns.find((item) => item.id === 'cd-trip');
      expect(countdown).toMatchObject({
        title: '旅行计划',
        targetDate: '2026-12-01',
        repeatRule: '每年',
        version: 2,
      });
    });
    expect(await screen.findByText('旅行计划')).toBeInTheDocument();
    expect(taskSource.snapshot().tasks).toHaveLength(tasksBefore);

    await user.click(
      screen.getByRole('button', { name: '删除倒数日「旅行计划」' }),
    );
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: '删除倒数日',
      }),
    );

    await waitFor(() => {
      const countdown = calendarSource
        .snapshot()
        .countdowns.find((item) => item.id === 'cd-trip');
      expect(countdown?.deletedAt).not.toBeNull();
    });
    await waitFor(() => {
      expect(screen.queryByText('旅行计划')).not.toBeInTheDocument();
    });
    expect(taskSource.snapshot().tasks).toHaveLength(tasksBefore);
  });

  it('日视图 08:00–21:00 按时间显示；21:30 不进时间轴但保留在轴外列表', async () => {
    const seed = createDefaultSeed();
    const taskSource = createFakeTaskSource({
      tasks: [
        ...seed.tasks,
        makeTask({
          id: 'task-end',
          title: '晚间收尾',
          listId: 'work',
          dueDate: TEST_TODAY,
          dueTime: '21:00',
        }),
        makeTask({
          id: 'task-late',
          title: '深夜复盘',
          listId: 'work',
          dueDate: TEST_TODAY,
          dueTime: '21:30',
        }),
      ],
    });
    renderCalendar({
      taskSource,
      initialView: 'day',
      initialDate: TEST_TODAY,
    });

    const timeline = await screen.findByTestId('day-timeline');
    expect(
      await within(timeline).findByText('完成新版产品需求文档'),
    ).toBeInTheDocument();
    expect(within(timeline).getByText('晚间收尾')).toBeInTheDocument();
    expect(within(timeline).queryByText('深夜复盘')).not.toBeInTheDocument();
    expect(timeline.querySelector('[data-hour="21"]')).not.toBeNull();

    const outside = screen.getByTestId('day-outside-timeline');
    expect(within(outside).getByText(/深夜复盘/)).toBeInTheDocument();
    expect(
      taskSource
        .snapshot()
        .tasks.some((task) => task.id === 'task-late'),
    ).toBe(true);
  });

  it('显示农历开关写入设备设置，重新渲染保持', async () => {
    const user = userEvent.setup();
    const first = renderCalendar({ initialDate: TEST_TODAY });
    await waitForMonth();
    expect(document.querySelectorAll('.calendar-lunar').length).toBeGreaterThan(
      0,
    );

    await user.click(screen.getByRole('checkbox', { name: '显示农历' }));
    await waitFor(() => {
      expect(
        first.calendarSource
          .snapshot()
          .settings.find(
            (setting) => setting.key === 'calendar.showLunar',
          )?.value,
      ).toBe(false);
      expect(document.querySelectorAll('.calendar-lunar')).toHaveLength(0);
    });

    first.unmount();
    renderCalendar({
      taskSource: first.taskSource,
      calendarSource: first.calendarSource,
      initialDate: TEST_TODAY,
    });
    await waitForMonth();
    expect(screen.getByRole('checkbox', { name: '显示农历' })).not.toBeChecked();
    expect(document.querySelectorAll('.calendar-lunar')).toHaveLength(0);
  });

  it('小工具日期非法时结果显示请先修正日期，且不拿旧值计算', async () => {
    const user = userEvent.setup();
    const calendarSource = createFakeCalendarSource();
    renderCalendar({ calendarSource, initialTab: 'tools' });
    await waitForCalendarReady();

    await user.click(screen.getByRole('button', { name: '天数计算' }));
    const inputA = screen.getByLabelText('时间 1');
    await typeDate(user, inputA, '2026-02-30');
    expect(screen.getByTestId('days-result')).toHaveTextContent(
      '请先修正日期',
    );
    expect(screen.getByRole('button', { name: '+7 天' })).toBeDisabled();
  });

  it('小工具：天数计算包含首尾、农历转换预填倒数日但不自动保存', async () => {
    const user = userEvent.setup();
    const calendarSource = createFakeCalendarSource();
    renderCalendar({ calendarSource, initialTab: 'tools' });
    await waitForCalendarReady();

    await user.click(screen.getByRole('button', { name: '天数计算' }));
    await pickDate(user, screen.getByLabelText('时间 1'), '2026-10-01');
    await pickDate(user, screen.getByLabelText('时间 2'), '2026-10-07');
    expect(screen.getByTestId('days-result')).toHaveTextContent('6');
    await user.click(screen.getByRole('button', { name: '切换：包含首尾' }));
    expect(screen.getByTestId('days-result')).toHaveTextContent('7');

    await user.click(screen.getByRole('button', { name: '农历转换' }));
    const dateInput = screen.getByLabelText('公历日期');
    await pickDate(user, dateInput, '2026-02-17');
    expect(screen.getByTestId('lunar-result')).toHaveTextContent(
      '丙午年 正月初一 生肖马',
    );

    await user.click(screen.getByRole('button', { name: '加入倒数日' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('名称')).toHaveValue('农历纪念日');
    expect(within(dialog).getByLabelText('历法')).toHaveValue('lunar');
    expect(within(dialog).getByLabelText('重复')).toHaveValue('每年（农历）');
    expect(calendarSource.snapshot().countdowns).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('pointer 拖拽：移动 ≥4px 落到周三，只改 dueDate 并保留 dueTime', async () => {
    const { taskSource } = renderCalendar({ initialDate: TEST_TODAY });
    const monday = await screen.findByTestId('day-2026-10-26');
    await screen.findByTestId('month-grid');
    const wednesday = screen.getByTestId('day-2026-10-28');
    const chip = within(monday).getByRole('button', {
      name: '任务：完成新版产品需求文档',
    });
    stubElementFromPoint(wednesday);

    fireEvent.pointerDown(chip, pointerInit({ clientX: 40, clientY: 40 }));
    fireEvent.pointerMove(
      window,
      pointerInit({ clientX: 120, clientY: 140 }),
    );

    expect(document.querySelector('[data-drag-ghost]')).not.toBeNull();
    expect(chip).toHaveClass('is-drag-source');
    expect(wednesday).toHaveAttribute('data-drop-active', 'true');
    await waitFor(() => {
      expect(screen.getByTestId('calendar-drag-status')).toHaveTextContent(
        /目标日期：10月28日/,
      );
    });

    fireEvent.pointerUp(
      window,
      pointerInit({ clientX: 120, clientY: 140 }),
    );

    await waitFor(() => {
      const task = taskSource
        .snapshot()
        .tasks.find((item) => item.id === 'task-review');
      expect(task?.dueDate).toBe('2026-10-28');
      expect(task?.dueTime).toBe('10:30');
    });
    expect(document.querySelector('[data-drag-ghost]')).toBeNull();
    expect(document.body).not.toHaveClass('is-calendar-dragging');
    expect(wednesday).not.toHaveAttribute('data-drop-active', 'true');

    // 拖后紧随的 click 被吞掉；抑制只生效一次，下一次点击正常打开详情。
    const otherChip = within(monday).getByRole('button', {
      name: '任务：和设计师确认首页信息架构',
    });
    fireEvent.click(otherChip);
    expect(screen.queryByText('今天详情页')).not.toBeInTheDocument();
    fireEvent.click(otherChip);
    expect(await screen.findByText('今天详情页')).toBeInTheDocument();
  });

  it('pointer 位移 <4px 仍按点击处理，打开任务详情', async () => {
    const { taskSource } = renderCalendar({ initialDate: TEST_TODAY });
    const monday = await screen.findByTestId('day-2026-10-26');
    await screen.findByTestId('month-grid');
    const chip = within(monday).getByRole('button', {
      name: '任务：完成新版产品需求文档',
    });

    fireEvent.pointerDown(chip, pointerInit({ clientX: 40, clientY: 40 }));
    fireEvent.pointerMove(
      window,
      pointerInit({ clientX: 42, clientY: 41 }),
    );
    fireEvent.pointerUp(
      window,
      pointerInit({ clientX: 42, clientY: 41 }),
    );

    expect(document.querySelector('[data-drag-ghost]')).toBeNull();
    expect(
      taskSource.snapshot().tasks.find((item) => item.id === 'task-review')
        ?.dueDate,
    ).toBe('2026-10-26');

    fireEvent.click(chip);
    expect(await screen.findByText('今天详情页')).toBeInTheDocument();
  });

  it('Esc 取消拖拽：不写库、移除拖影并抑制随后的 click', async () => {
    const { taskSource } = renderCalendar({ initialDate: TEST_TODAY });
    const monday = await screen.findByTestId('day-2026-10-26');
    await screen.findByTestId('month-grid');
    const wednesday = screen.getByTestId('day-2026-10-28');
    const chip = within(monday).getByRole('button', {
      name: '任务：完成新版产品需求文档',
    });
    stubElementFromPoint(wednesday);

    fireEvent.pointerDown(chip, pointerInit());
    fireEvent.pointerMove(
      window,
      pointerInit({ clientX: 120, clientY: 140 }),
    );
    expect(document.querySelector('[data-drag-ghost]')).not.toBeNull();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(document.querySelector('[data-drag-ghost]')).toBeNull();
    expect(document.body).not.toHaveClass('is-calendar-dragging');
    expect(wednesday).not.toHaveAttribute('data-drop-active', 'true');
    await waitFor(() => {
      expect(screen.getByTestId('calendar-drag-status')).toHaveTextContent(
        '已取消改期',
      );
    });
    expect(
      taskSource.snapshot().tasks.find((item) => item.id === 'task-review')
        ?.dueDate,
    ).toBe('2026-10-26');

    fireEvent.pointerUp(
      window,
      pointerInit({ clientX: 120, clientY: 140 }),
    );
    const otherChip = within(monday).getByRole('button', {
      name: '任务：和设计师确认首页信息架构',
    });
    fireEvent.click(otherChip);
    expect(screen.queryByText('今天详情页')).not.toBeInTheDocument();
    fireEvent.click(otherChip);
    expect(await screen.findByText('今天详情页')).toBeInTheDocument();
  });

  it('pointercancel 取消拖拽，不写库也不残留拖影', async () => {
    const { taskSource } = renderCalendar({ initialDate: TEST_TODAY });
    const monday = await screen.findByTestId('day-2026-10-26');
    await screen.findByTestId('month-grid');
    const wednesday = screen.getByTestId('day-2026-10-28');
    const chip = within(monday).getByRole('button', {
      name: '任务：完成新版产品需求文档',
    });
    stubElementFromPoint(wednesday);

    fireEvent.pointerDown(chip, pointerInit());
    fireEvent.pointerMove(
      window,
      pointerInit({ clientX: 120, clientY: 140 }),
    );
    expect(document.querySelector('[data-drag-ghost]')).not.toBeNull();

    fireEvent.pointerCancel(window, pointerInit({ clientX: 120, clientY: 140 }));

    expect(document.querySelector('[data-drag-ghost]')).toBeNull();
    expect(document.body).not.toHaveClass('is-calendar-dragging');
    expect(
      taskSource.snapshot().tasks.find((item) => item.id === 'task-review')
        ?.dueDate,
    ).toBe('2026-10-26');
  });

  it('周视图 pointer 拖拽：跨列改 dueDate，保留 dueTime', async () => {
    const user = userEvent.setup();
    const { taskSource } = renderCalendar({ initialDate: TEST_TODAY });
    await waitForMonth();
    await user.click(screen.getByRole('button', { name: '周视图' }));
    const weekGrid = await screen.findByTestId('week-grid');
    const monday = within(weekGrid).getByTestId('day-2026-10-26');
    const thursday = within(weekGrid).getByTestId('day-2026-10-29');
    const chip = within(monday).getByRole('button', {
      name: '任务：完成新版产品需求文档',
    });
    stubElementFromPoint(thursday);

    fireEvent.pointerDown(chip, pointerInit({ clientX: 20, clientY: 20 }));
    fireEvent.pointerMove(
      window,
      pointerInit({ clientX: 220, clientY: 120 }),
    );
    expect(document.querySelector('[data-drag-ghost]')).not.toBeNull();
    expect(thursday).toHaveAttribute('data-drop-active', 'true');

    fireEvent.pointerUp(
      window,
      pointerInit({ clientX: 220, clientY: 120 }),
    );

    await waitFor(() => {
      const task = taskSource
        .snapshot()
        .tasks.find((item) => item.id === 'task-review');
      expect(task?.dueDate).toBe('2026-10-29');
      expect(task?.dueTime).toBe('10:30');
    });
    expect(document.querySelector('[data-drag-ghost]')).toBeNull();
  });

  it('拖回同一个日期不写库，只更新选中日期', async () => {
    const { taskSource } = renderCalendar({ initialDate: TEST_TODAY });
    const monday = await screen.findByTestId('day-2026-10-26');
    await screen.findByTestId('month-grid');
    const chip = within(monday).getByRole('button', {
      name: '任务：完成新版产品需求文档',
    });
    stubElementFromPoint(monday);
    const patchCallsBefore = taskSource.calls.filter(
      (call) => call === 'tasks.patch',
    ).length;

    fireEvent.pointerDown(chip, pointerInit());
    fireEvent.pointerMove(
      window,
      pointerInit({ clientX: 120, clientY: 140 }),
    );
    fireEvent.pointerUp(
      window,
      pointerInit({ clientX: 120, clientY: 140 }),
    );

    expect(
      taskSource.snapshot().tasks.find((item) => item.id === 'task-review')
        ?.dueDate,
    ).toBe('2026-10-26');
    expect(
      taskSource.calls.filter((call) => call === 'tasks.patch').length,
    ).toBe(patchCallsBefore);
    await waitFor(() => {
      expect(screen.getByTestId('calendar-drag-status')).toHaveTextContent(
        '日期未变化',
      );
    });
  });

  it('历史 dueAt 非空时改期同时置空 dueAt，避免提醒漂移到旧日期', async () => {
    const task = makeTask({
      id: 'task-dueat',
      title: '带提醒的任务',
      listId: 'work',
      dueDate: TEST_TODAY,
      dueTime: '09:15',
      dueAt: '2026-10-26T01:15:00.000Z',
    });
    const taskSource = createFakeTaskSource({ tasks: [task] });
    renderCalendar({ taskSource, initialDate: TEST_TODAY });
    const monday = await screen.findByTestId('day-2026-10-26');
    await screen.findByTestId('month-grid');
    const wednesday = screen.getByTestId('day-2026-10-28');
    const chip = within(monday).getByRole('button', {
      name: '任务：带提醒的任务',
    });
    stubElementFromPoint(wednesday);

    fireEvent.pointerDown(chip, pointerInit());
    fireEvent.pointerMove(
      window,
      pointerInit({ clientX: 120, clientY: 140 }),
    );
    fireEvent.pointerUp(
      window,
      pointerInit({ clientX: 120, clientY: 140 }),
    );

    await waitFor(() => {
      const updated = taskSource
        .snapshot()
        .tasks.find((item) => item.id === 'task-dueat');
      expect(updated?.dueDate).toBe('2026-10-28');
      expect(updated?.dueTime).toBe('09:15');
      expect(updated?.dueAt).toBeNull();
    });
  });

  it('已完成任务/只读事件不显示抓手，也不能进入 pointer 拖拽', () => {
    const doneTask = makeTask({
      id: 'done-task',
      title: '已完成任务',
      listId: 'work',
      dueDate: TEST_TODAY,
      status: 'done',
    });
    const onPointerDragStart = vi.fn();
    const { rerender } = render(
      <CalendarChip
        entry={taskEntry(doneTask)}
        draggable
        onPointerDragStart={onPointerDragStart}
        onOpenTask={vi.fn()}
        onOpenEvent={vi.fn()}
        onOpenCountdown={vi.fn()}
      />,
    );
    const doneChip = screen.getByRole('button', {
      name: '任务：已完成任务',
    });
    expect(doneChip).not.toHaveAttribute('data-draggable');
    expect(doneChip).not.toHaveClass('calendar-chip--draggable');

    fireEvent.pointerDown(doneChip, pointerInit());
    fireEvent.pointerMove(
      window,
      pointerInit({ clientX: 120, clientY: 140 }),
    );
    expect(onPointerDragStart).not.toHaveBeenCalled();
    expect(document.querySelector('[data-drag-ghost]')).toBeNull();

    const icsEvent = makeEvent({
      id: 'ics-event',
      title: '行业大会',
      startDate: TEST_TODAY,
      source: 'ics:demo',
    });
    rerender(
      <CalendarChip
        entry={{ kind: 'event', id: icsEvent.id, title: icsEvent.title, time: null, event: icsEvent }}
        draggable
        onPointerDragStart={onPointerDragStart}
        onOpenTask={vi.fn()}
        onOpenEvent={vi.fn()}
        onOpenCountdown={vi.fn()}
      />,
    );
    const eventChip = screen.getByRole('button', {
      name: '事件：行业大会（只读）',
    });
    expect(eventChip).not.toHaveAttribute('data-draggable');
    expect(eventChip).not.toHaveClass('calendar-chip--draggable');
  });
});
