import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { createFakeTaskSource } from '../../tasks/__tests__/fakeTaskSource';
import { renderToday } from '../../tasks/__tests__/testUtils';
import { HabitsPage } from '../HabitsPage';
import {
  TEST_TODAY,
  createFakeHabitSource,
  makeHabitLog,
  type FakeHabitSource,
} from './fakeHabitSource';

function renderHabits(source: FakeHabitSource) {
  return render(<HabitsPage source={source} today={TEST_TODAY} />);
}

async function findWeekGroup(habitTitle: string) {
  return screen.findByRole('group', {
    name: `${habitTitle} 本周打卡，周一到周日`,
  });
}

function findHabitRow(habitTitle: string) {
  const list = screen.getByLabelText('习惯列表');
  const title = within(list).getByText(habitTitle);
  const row = title.closest('article');
  if (!row) {
    throw new Error(`找不到习惯行：${habitTitle}`);
  }
  return within(row);
}

describe('习惯页', () => {
  it('今天打卡后周完成率、本周打卡数、月热力图与连续同步更新', async () => {
    const user = userEvent.setup();
    const source = createFakeHabitSource();
    renderHabits(source);

    expect(
      await screen.findByRole('heading', { level: 1, name: '习惯' }),
    ).toBeInTheDocument();
    await findWeekGroup('阅读 30 分钟');

    expect(screen.getByTestId('habit-week-checks')).toHaveTextContent('0');
    expect(screen.getByTestId('habit-week-rate')).toHaveTextContent(
      '0 / 14 次 · 完成度 0%',
    );

    const week = await findWeekGroup('阅读 30 分钟');
    await user.click(
      within(week).getByRole('button', {
        name: `阅读 30 分钟 ${TEST_TODAY} 未打卡`,
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('habit-week-checks')).toHaveTextContent('1');
    });
    expect(screen.getByTestId('habit-week-rate')).toHaveTextContent(
      '1 / 14 次 · 完成度 7%',
    );
    expect(screen.getByTestId('habit-longest-best')).toHaveTextContent('1');

    const heatmap = screen.getByRole('region', { name: '习惯月热力图' });
    expect(
      within(heatmap).getByRole('button', {
        name: `阅读 30 分钟 ${TEST_TODAY} 已打卡`,
      }),
    ).toHaveClass('is-on');

    expect(screen.getByLabelText('当前连续 1 天，最佳 1 天')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      `已打卡 ${TEST_TODAY}`,
    );

    const snapshot = source.snapshot();
    expect(snapshot.logs).toHaveLength(1);
    expect(snapshot.logs[0]).toMatchObject({
      habitId: 'habit-read',
      logDate: TEST_TODAY,
      done: true,
      deletedAt: null,
    });
  });

  it('再次点击已打卡日期撤销，周完成率与连续回落', async () => {
    const user = userEvent.setup();
    const source = createFakeHabitSource({
      logs: [makeHabitLog({ habitId: 'habit-read', logDate: TEST_TODAY })],
    });
    renderHabits(source);

    const week = await findWeekGroup('阅读 30 分钟');
    const row = findHabitRow('阅读 30 分钟');
    expect(screen.getByTestId('habit-week-checks')).toHaveTextContent('1');
    expect(
      within(week).getByRole('button', {
        name: `阅读 30 分钟 ${TEST_TODAY} 已打卡`,
      }),
    ).toHaveClass('is-on');

    await user.click(
      within(week).getByRole('button', {
        name: `阅读 30 分钟 ${TEST_TODAY} 已打卡`,
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('habit-week-checks')).toHaveTextContent('0');
    });
    expect(screen.getByTestId('habit-week-rate')).toHaveTextContent(
      '0 / 14 次 · 完成度 0%',
    );
    expect(
      row.getByLabelText('当前连续 0 天，最佳 0 天'),
    ).toBeInTheDocument();
    const snapshot = source.snapshot();
    expect(snapshot.logs).toHaveLength(1);
    expect(snapshot.logs[0]?.deletedAt).not.toBeNull();
    expect(snapshot.logs[0]?.done).toBe(false);
  });

  it('历史补卡后连续与最佳按全部日志重算，连续三天最佳≥3', async () => {
    const user = userEvent.setup();
    const source = createFakeHabitSource({
      logs: [
        makeHabitLog({ habitId: 'habit-read', logDate: '2026-10-25' }),
        makeHabitLog({ habitId: 'habit-read', logDate: '2026-10-24' }),
      ],
    });
    renderHabits(source);

    await findWeekGroup('阅读 30 分钟');
    expect(screen.getByLabelText('当前连续 2 天，最佳 2 天')).toBeInTheDocument();

    const heatmap = screen.getByRole('region', { name: '习惯月热力图' });
    await user.click(
      within(heatmap).getByRole('button', {
        name: '阅读 30 分钟 2026-10-23 未打卡',
      }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText('当前连续 3 天，最佳 3 天')).toBeInTheDocument();
    });
    expect(screen.getByTestId('habit-longest-best')).toHaveTextContent('3');
    expect(
      source
        .snapshot()
        .logs.filter((log) => log.deletedAt === null),
    ).toHaveLength(3);
  });

  it('未来日期点击被拒绝并提示，不写日志', async () => {
    const user = userEvent.setup();
    const source = createFakeHabitSource();
    renderHabits(source);

    const week = await findWeekGroup('阅读 30 分钟');
    const future = within(week).getByRole('button', {
      name: '阅读 30 分钟 2026-10-27 未打卡（未来日期，不可打卡）',
    });
    expect(future).toHaveAttribute('aria-disabled', 'true');
    expect(future).toHaveClass('is-future');

    await user.click(future);

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('还没到这一天');
    });
    expect(source.snapshot().logs).toHaveLength(0);
    expect(source.calls).not.toContain('habit_logs.set');
  });

  it('新建、编辑习惯后列表与周视图同步', async () => {
    const user = userEvent.setup();
    const source = createFakeHabitSource();
    renderHabits(source);

    await screen.findAllByText('阅读 30 分钟');
    await user.click(screen.getByRole('button', { name: '＋ 新习惯' }));

    const dialog = await screen.findByRole('dialog', { name: '新建习惯' });
    await user.type(within(dialog).getByLabelText('名称'), '晨跑');
    const schedule = within(dialog).getByLabelText('频率/时间');
    await user.clear(schedule);
    await user.type(schedule, '工作日 · 07:00');
    await user.click(within(dialog).getByRole('radio', { name: '运动图标' }));
    await user.selectOptions(within(dialog).getByLabelText('颜色'), 'teal');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: '新建习惯' }),
      ).not.toBeInTheDocument();
    });
    expect(await screen.findAllByText('晨跑')).not.toHaveLength(0);
    await findWeekGroup('晨跑');

    const created = source.snapshot().habits.find((habit) => habit.title === '晨跑');
    expect(created).toMatchObject({
      schedule: '工作日 · 07:00',
      icon: 'exercise',
      color: 'teal',
      goalPerWeek: 7,
    });

    const row = findHabitRow('晨跑');
    await user.click(row.getByRole('button', { name: '编辑习惯：晨跑' }));
    const editDialog = await screen.findByRole('dialog', { name: '编辑习惯' });
    const title = within(editDialog).getByLabelText('名称');
    await user.clear(title);
    await user.type(title, '晨跑 5 公里');
    await user.click(within(editDialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getAllByText('晨跑 5 公里').length).toBeGreaterThan(0);
    });
    expect(
      source.snapshot().habits.find((habit) => habit.id === created?.id),
    ).toMatchObject({ title: '晨跑 5 公里' });
  });

  it('图标在习惯行、热力图与编辑弹层保持一致，并带中文 aria-label', async () => {
    const user = userEvent.setup();
    const source = createFakeHabitSource();
    renderHabits(source);

    await screen.findAllByText('阅读 30 分钟');
    const row = findHabitRow('阅读 30 分钟');
    const rowIcon = row.getByRole('img', { name: '阅读图标' });
    expect(rowIcon).toHaveAttribute('data-habit-icon', 'read');
    expect(rowIcon.tagName.toLowerCase()).toBe('svg');

    const heatmap = screen.getByRole('region', { name: '习惯月热力图' });
    const heatLabel = within(heatmap)
      .getByText('阅读 30 分钟')
      .closest('.habit-heatmap-label');
    expect(heatLabel).not.toBeNull();
    expect(
      within(heatLabel as HTMLElement).getByRole('img', { name: '阅读图标' }),
    ).toHaveAttribute('data-habit-icon', 'read');

    await user.click(
      row.getByRole('button', { name: '编辑习惯：阅读 30 分钟' }),
    );
    const dialog = await screen.findByRole('dialog', { name: '编辑习惯' });
    const radios = within(dialog).getAllByRole('radio');
    expect(radios).toHaveLength(12);
    for (const label of [
      '阅读',
      '运动',
      '喝水',
      '睡眠',
      '冥想',
      '写作',
      '学习',
      '早起',
      '饮食',
      '整理',
      '音乐',
      '自定义',
    ]) {
      expect(
        within(dialog).getByRole('radio', { name: `${label}图标` }),
      ).toBeInTheDocument();
    }
    expect(within(dialog).getByRole('radio', { name: '阅读图标' })).toBeChecked();

    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(
        source.snapshot().habits.find((habit) => habit.id === 'habit-read')?.icon,
      ).toBe('read');
    });
  });

  it('空态使用同一套语义图标', async () => {
    const source = createFakeHabitSource({ habits: [] });
    renderHabits(source);

    expect(await screen.findByText('还没有习惯')).toBeInTheDocument();
    const emptyIcon = screen.getByRole('img', { name: '自定义图标' });
    expect(emptyIcon.tagName.toLowerCase()).toBe('svg');
    expect(emptyIcon).toHaveAttribute('data-habit-icon', 'custom');
  });

  it('删除习惯后日志同时删除', async () => {
    const user = userEvent.setup();
    const source = createFakeHabitSource({
      logs: [
        makeHabitLog({ habitId: 'habit-read', logDate: TEST_TODAY }),
        makeHabitLog({ habitId: 'habit-read', logDate: '2026-10-25' }),
      ],
    });
    renderHabits(source);

    await screen.findAllByText('阅读 30 分钟');
    const row = findHabitRow('阅读 30 分钟');
    await user.click(row.getByRole('button', { name: '编辑习惯：阅读 30 分钟' }));

    const dialog = await screen.findByRole('dialog', { name: '编辑习惯' });
    await user.click(within(dialog).getByRole('button', { name: '删除' }));

    const confirm = await screen.findByRole('dialog', {
      name: '删除这个习惯？',
    });
    await user.click(within(confirm).getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(screen.queryByText('阅读 30 分钟')).not.toBeInTheDocument();
    });

    const snapshot = source.snapshot();
    expect(snapshot.habits.find((habit) => habit.id === 'habit-read')?.deletedAt)
      .not.toBeNull();
    expect(snapshot.logs).toHaveLength(2);
    expect(snapshot.logs.every((log) => log.deletedAt !== null)).toBe(true);
  });

  it('安排行动创建今天到期的普通任务：生活清单、象限 2、优先级高，且不写回打卡', async () => {
    const user = userEvent.setup();
    const source = createFakeHabitSource();
    renderHabits(source);

    await screen.findAllByText('阅读 30 分钟');
    const row = findHabitRow('阅读 30 分钟');
    await user.click(
      row.getByRole('button', { name: '安排行动：阅读 30 分钟' }),
    );

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        '已加入今天任务：习惯：阅读 30 分钟',
      );
    });

    const task = source.snapshot().tasks[0];
    expect(task).toMatchObject({
      title: '习惯：阅读 30 分钟',
      listId: 'life',
      status: 'todo',
      priority: 3,
      quadrant: 2,
      dueDate: TEST_TODAY,
      notes: '来自习惯',
    });
    expect(source.snapshot().logs).toHaveLength(0);
  });

  it('安排行动后任务出现在今天页：生活清单、重要不紧急象限', async () => {
    const user = userEvent.setup();
    const source = createFakeHabitSource();
    const habitsView = renderHabits(source);

    await screen.findAllByText('阅读 30 分钟');
    await user.click(
      findHabitRow('阅读 30 分钟').getByRole('button', {
        name: '安排行动：阅读 30 分钟',
      }),
    );
    await waitFor(() => {
      expect(source.snapshot().tasks).toHaveLength(1);
    });
    habitsView.unmount();

    const snapshot = source.snapshot();
    const taskSource = createFakeTaskSource({
      lists: snapshot.lists,
      tasks: snapshot.tasks,
    });
    renderToday(taskSource);

    const title = await screen.findByText('习惯：阅读 30 分钟');
    const row = title.closest('.task-row');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('生活')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '四象限' }));
    const quadrant = await screen.findByRole('region', {
      name: '四象限：重要不紧急',
    });
    expect(
      within(quadrant).getByText('习惯：阅读 30 分钟'),
    ).toBeInTheDocument();
  });

  it('月热力图可切换月份并在历史格补卡', async () => {
    const user = userEvent.setup();
    const source = createFakeHabitSource();
    renderHabits(source);

    const heatmap = await screen.findByRole('region', {
      name: '习惯月热力图',
    });
    expect(
      within(heatmap).getByRole('heading', { name: '2026 年 10 月热力图' }),
    ).toBeInTheDocument();

    await user.click(within(heatmap).getByRole('button', { name: '上个月' }));
    expect(
      screen.getByRole('heading', { name: '2026 年 9 月热力图' }),
    ).toBeInTheDocument();

    const september = screen.getByRole('region', { name: '习惯月热力图' });
    await user.click(
      within(september).getByRole('button', {
        name: '阅读 30 分钟 2026-09-30 未打卡',
      }),
    );

    await waitFor(() => {
      expect(
        source
          .snapshot()
          .logs.some((log) => log.logDate === '2026-09-30'),
      ).toBe(true);
    });
  });

  it('浏览器预览没有 IPC 时给出明确空态，不回退 localStorage', async () => {
    render(<HabitsPage available={false} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: '习惯' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('需在桌面壳内使用本地习惯库'),
    ).toBeInTheDocument();
    expect(screen.getByText('这里不会回退到 localStorage，也不会生成演示数据。'))
      .toBeInTheDocument();
  });
});
