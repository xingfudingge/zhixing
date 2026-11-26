import { describe, expect, it } from 'vitest';

import type { Task } from '../../../data/db/types';
import {
  addDaysISO,
  diffDays,
  filterTasksByStatus,
  formatDueLabel,
  formatOverdueLabel,
  forgetStatusBeforeDone,
  getBoardTasks,
  getInboxTasks,
  getQuadrantTasks,
  getTodayOverview,
  groupListTasks,
  isOverdue,
  overdueDays,
  quadrantOf,
  rememberStatusBeforeDone,
  resetStatusBeforeDoneMemory,
  statusBeforeDoneOf,
  statusCounts,
  todayISO,
} from '../viewModel';
import { makeTask } from './fakeTaskSource';

const TODAY = '2026-10-26';

function task(overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return makeTask({ listId: 'work', ...overrides });
}

describe('任务日期与视图模型', () => {
  it('按本地日历日加减，不受 UTC 跨日影响', () => {
    expect(addDaysISO(TODAY, 1)).toBe('2026-10-27');
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysISO('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-10-24', TODAY)).toBe(2);
    expect(todayISO(new Date(2026, 9, 26, 23, 30))).toBe('2026-10-26');
  });

  it('逾期按自然日计算，已完成不算逾期', () => {
    const overdue = task({ id: 'a', title: '逾期', dueDate: '2026-10-23' });
    expect(isOverdue(overdue, TODAY)).toBe(true);
    expect(overdueDays(overdue.dueDate as string, TODAY)).toBe(3);
    expect(formatOverdueLabel(overdue, TODAY)).toBe('逾期 3 天');
    expect(
      isOverdue({ ...overdue, status: 'done' }, TODAY),
    ).toBe(false);
    expect(formatOverdueLabel({ ...overdue, status: 'done' }, TODAY)).toBe('');
    expect(
      formatOverdueLabel(
        task({ id: 'b', title: '今天', dueDate: TODAY }),
        TODAY,
      ),
    ).toBe('');
  });

  it('今天概览只含逾期与今天到期；未来、无日期、往日已完成都不计入', () => {
    const tasks = [
      task({ id: 'overdue', title: '逾期', dueDate: '2026-10-25' }),
      task({ id: 'today-open', title: '今天', dueDate: TODAY }),
      task({
        id: 'today-done',
        title: '今天完成',
        dueDate: TODAY,
        status: 'done',
      }),
      task({
        id: 'old-done',
        title: '昨天完成',
        dueDate: '2026-10-25',
        status: 'done',
      }),
      task({ id: 'future', title: '明天', dueDate: '2026-10-27' }),
      task({ id: 'inbox', title: '无日期', dueDate: null }),
    ];
    const overview = getTodayOverview(tasks, TODAY);

    expect(overview.overdue.map((item) => item.id)).toEqual(['overdue']);
    expect(overview.todayOpen.map((item) => item.id)).toEqual(['today-open']);
    expect(overview.todayDone.map((item) => item.id)).toEqual(['today-done']);
    expect(overview.open.map((item) => item.id)).toEqual([
      'overdue',
      'today-open',
    ]);
    expect(overview.total).toBe(3);
    expect(overview.doneCount).toBe(1);
    expect(overview.percent).toBe(33);

    const empty = getTodayOverview([], TODAY);
    expect(empty.percent).toBe(0);
    expect(empty.total).toBe(0);
  });

  it('四象限范围：今天含逾期只看未完成；全部未完成包含未来与无日期', () => {
    const tasks = [
      task({ id: 'overdue', title: '逾期', dueDate: '2026-10-25' }),
      task({ id: 'today', title: '今天', dueDate: TODAY }),
      task({
        id: 'today-done',
        title: '今天完成',
        dueDate: TODAY,
        status: 'done',
      }),
      task({ id: 'future', title: '明天', dueDate: '2026-10-27' }),
      task({ id: 'inbox', title: '无日期', dueDate: null }),
    ];

    expect(getQuadrantTasks(tasks, 'today', TODAY).map((item) => item.id)).toEqual(
      ['overdue', 'today'],
    );
    expect(getQuadrantTasks(tasks, 'all', TODAY).map((item) => item.id)).toEqual(
      ['overdue', 'today', 'future', 'inbox'],
    );
  });

  it('非法象限回落到第四象限，避免任务在四象限视图里丢失', () => {
    expect(quadrantOf(task({ id: 'a', title: '正常', quadrant: 2 }))).toBe(2);
    expect(quadrantOf(task({ id: 'b', title: '零', quadrant: 0 }))).toBe(4);
    expect(quadrantOf(task({ id: 'c', title: '越界', quadrant: 9 }))).toBe(4);
  });

  it('看板：待办/进行中只含今天及逾期，已完成只含今天完成', () => {
    const tasks = [
      task({ id: 'overdue', title: '逾期', dueDate: '2026-10-25' }),
      task({ id: 'todo', title: '待办', dueDate: TODAY }),
      task({ id: 'doing', title: '进行中', dueDate: TODAY, status: 'doing' }),
      task({ id: 'done', title: '今天完成', dueDate: TODAY, status: 'done' }),
      task({
        id: 'old-done',
        title: '昨天完成',
        dueDate: '2026-10-25',
        status: 'done',
      }),
      task({ id: 'future', title: '明天', dueDate: '2026-10-27' }),
      task({ id: 'inbox', title: '无日期', dueDate: null }),
    ];

    expect(getBoardTasks(tasks, 'todo', TODAY).map((item) => item.id)).toEqual([
      'overdue',
      'todo',
    ]);
    expect(getBoardTasks(tasks, 'doing', TODAY).map((item) => item.id)).toEqual([
      'doing',
    ]);
    expect(getBoardTasks(tasks, 'done', TODAY).map((item) => item.id)).toEqual([
      'done',
    ]);
  });

  it('收件箱只含无日期任务，不论挂在哪个清单', () => {
    const tasks = [
      task({ id: 'inbox', title: '收件箱', listId: 'inbox' }),
      task({ id: 'life', title: '生活里没日期', listId: 'life' }),
      task({ id: 'dated', title: '有日期', dueDate: TODAY }),
    ];
    expect(getInboxTasks(tasks).map((item) => item.id)).toEqual([
      'inbox',
      'life',
    ]);
  });

  it('清单详情按三态分组：待办/进行中/已完成，每个任务只出现一次', () => {
    const tasks = [
      task({ id: 'todo', title: '待办', dueDate: '2026-10-25' }),
      task({ id: 'doing', title: '进行中', dueDate: TODAY, status: 'doing' }),
      task({ id: 'done', title: '已完成', dueDate: TODAY, status: 'done' }),
    ];
    const groups = groupListTasks(tasks);

    expect(groups.todo.map((item) => item.id)).toEqual(['todo']);
    expect(groups.doing.map((item) => item.id)).toEqual(['doing']);
    expect(groups.done.map((item) => item.id)).toEqual(['done']);

    const ids = [...groups.todo, ...groups.doing, ...groups.done].map(
      (item) => item.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(tasks.length);
  });

  it('完成后移出只隐藏活动视图行，完成计数与进度保持真实', () => {
    const tasks = [
      task({ id: 'overdue', title: '逾期', dueDate: '2026-10-25' }),
      task({ id: 'today-open', title: '今天', dueDate: TODAY }),
      task({
        id: 'today-done',
        title: '今天完成',
        dueDate: TODAY,
        status: 'done',
      }),
    ];

    const kept = getTodayOverview(tasks, TODAY, 'keep');
    const removed = getTodayOverview(tasks, TODAY, 'remove');
    expect(kept.todayDone.map((item) => item.id)).toEqual(['today-done']);
    expect(removed.todayDone).toEqual([]);
    expect(removed.open.map((item) => item.id)).toEqual([
      'overdue',
      'today-open',
    ]);
    expect(removed.doneCount).toBe(1);
    expect(removed.total).toBe(3);
    expect(removed.percent).toBe(33);

    expect(
      getBoardTasks(tasks, 'done', TODAY, 'remove').map((item) => item.id),
    ).toEqual([]);
    expect(
      getBoardTasks(tasks, 'done', TODAY, 'keep').map((item) => item.id),
    ).toEqual(['today-done']);
    expect(groupListTasks(tasks, 'remove').done).toEqual([]);
    expect(
      groupListTasks(tasks, 'keep').done.map((item) => item.id),
    ).toEqual(['today-done']);
  });

  it('日期标签覆盖今天、明天、昨天与普通日期，并带时间', () => {
    expect(
      formatDueLabel(task({ id: 'a', title: '今天', dueDate: TODAY }), TODAY),
    ).toBe('今天');
    expect(
      formatDueLabel(
        task({ id: 'a', title: '今天', dueDate: TODAY, dueTime: '09:30' }),
        TODAY,
      ),
    ).toBe('今天 09:30');
    expect(
      formatDueLabel(
        task({ id: 'b', title: '明天', dueDate: '2026-10-27' }),
        TODAY,
      ),
    ).toBe('明天');
    expect(
      formatDueLabel(
        task({ id: 'c', title: '昨天', dueDate: '2026-10-25' }),
        TODAY,
      ),
    ).toBe('昨天');
    expect(
      formatDueLabel(
        task({ id: 'd', title: '月日', dueDate: '2026-11-02' }),
        TODAY,
      ),
    ).toBe('11月2日');
    expect(
      formatDueLabel(task({ id: 'e', title: '无日期' }), TODAY),
    ).toBe('未安排');
  });
});

describe('任务三态与完成前状态记忆', () => {
  it('三态计数与筛选同源：未完成 = 待办 + 进行中', () => {
    const tasks = [
      task({ id: 'a', title: '待办', status: 'todo' }),
      task({ id: 'b', title: '进行中', status: 'doing' }),
      task({ id: 'c', title: '已完成', status: 'done' }),
    ];
    expect(statusCounts(tasks)).toEqual({
      all: 3,
      todo: 1,
      doing: 1,
      done: 1,
      open: 2,
    });
    expect(filterTasksByStatus(tasks, 'all')).toHaveLength(3);
    expect(filterTasksByStatus(tasks, 'doing').map((item) => item.id)).toEqual([
      'b',
    ]);
  });

  it('记忆只在 completedAt 匹配时生效，撤销后可恢复 doing 而不是降级 todo', () => {
    resetStatusBeforeDoneMemory();
    const completedAt = '2026-10-28T09:00:00.000Z';
    rememberStatusBeforeDone('task-a', 'doing', completedAt);
    const done = task({
      id: 'task-a',
      title: '进行中后完成',
      status: 'done',
      completedAt,
    });
    expect(statusBeforeDoneOf(done)).toBe('doing');
    expect(
      statusBeforeDoneOf({ ...done, completedAt: '2026-10-29T09:00:00.000Z' }),
    ).toBeNull();

    forgetStatusBeforeDone('task-a');
    expect(statusBeforeDoneOf(done)).toBeNull();
  });
});
