/**
 * 搜索结果深链的落地页验证：
 * - 事件 / 倒数日 → 日历打开编辑弹层；
 * - 习惯 → 习惯页打开编辑弹层；
 * - 无日期任务 → 旧 /inbox?task= 重定向到任务中心打开详情。
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  MemoryRouter,
  Route,
  Routes,
} from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { CalendarWorkspace } from '../../calendar/CalendarWorkspace';
import {
  createFakeCalendarSource,
  makeCountdown,
  makeEvent,
} from '../../calendar/__tests__/fakeCalendarSource';
import { HabitsPage } from '../../habits/HabitsPage';
import {
  createFakeHabitSource,
  TEST_TODAY as HABIT_TODAY,
} from '../../habits/__tests__/fakeHabitSource';
import {
  createFakeTaskSource,
  TEST_TODAY,
} from '../../tasks/__tests__/fakeTaskSource';
import { renderInbox as renderInboxRoute } from '../../tasks/__tests__/testUtils';

function renderAt(path: string, element: ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('搜索深链落地', () => {
  it('事件深链打开日历事件编辑框并选中事件页签', async () => {
    const taskSource = createFakeTaskSource();
    const calendarSource = createFakeCalendarSource({
      events: [
        makeEvent({
          id: 'event-1',
          title: '复盘会',
          startDate: '2026-10-27',
          startAt: '2026-10-27T14:00:00',
        }),
      ],
    });

    renderAt(
      '/calendar?tab=events&event=event-1',
      <CalendarWorkspace
        taskSource={taskSource}
        calendarSource={calendarSource}
        today={TEST_TODAY}
      />,
    );

    const dialog = await screen.findByRole('dialog', { name: '编辑事件' });
    await waitFor(() =>
      expect(within(dialog).getByLabelText('标题')).toHaveValue('复盘会'),
    );
    expect(screen.getByRole('tab', { name: '事件' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('倒数日深链打开日历倒数日编辑框', async () => {
    const taskSource = createFakeTaskSource();
    const calendarSource = createFakeCalendarSource({
      countdowns: [
        makeCountdown({
          id: 'countdown-1',
          title: '季度复盘日',
          targetDate: '2026-12-31',
        }),
      ],
    });

    renderAt(
      '/calendar?tab=countdowns&countdown=countdown-1',
      <CalendarWorkspace
        taskSource={taskSource}
        calendarSource={calendarSource}
        today={TEST_TODAY}
      />,
    );

    const dialog = await screen.findByRole('dialog', {
      name: '编辑倒数日',
    });
    await waitFor(() =>
      expect(within(dialog).getByLabelText('名称')).toHaveValue('季度复盘日'),
    );
    expect(screen.getByRole('tab', { name: '倒数日' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('习惯深链打开习惯编辑框', async () => {
    const source = createFakeHabitSource();
    render(
      <MemoryRouter initialEntries={['/habits?habit=habit-read']}>
        <HabitsPage source={source} today={HABIT_TODAY} />
      </MemoryRouter>,
    );

    const dialog = await screen.findByRole('dialog', { name: '编辑习惯' });
    expect(within(dialog).getByLabelText('名称')).toHaveValue('阅读 30 分钟');
  });

  it('旧 /inbox?task= 深链重定向到任务中心并打开对应详情', async () => {
    const source = createFakeTaskSource();
    renderInboxRoute(source, '/inbox?task=task-idea');

    expect(await screen.findByLabelText('标题')).toHaveValue(
      '记一个想法：把日历和笔记连起来',
    );
  });
});
