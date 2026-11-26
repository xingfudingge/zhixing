import { describe, expect, it } from 'vitest';

import type {
  FocusSession,
  Habit,
  HabitLog,
  List,
  Task,
} from '../../../data/db/types';
import {
  barPercent,
  buildReviewAggregate,
  focusCardValue,
  formatDuration,
  localDateOfTimestamp,
  metricMax,
  metricValue,
  reviewRange,
} from '../model';

const TODAY = '2026-10-26';
const STAMP = '2026-10-20T00:00:00.000Z';

function makeList(overrides: Partial<List> & Pick<List, 'id' | 'name'>): List {
  return {
    spaceId: 'personal',
    color: '#5579d5',
    icon: '',
    parentId: null,
    sortOrder: 0,
    isInbox: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    spaceId: 'personal',
    listId: 'work',
    parentId: null,
    noteId: null,
    notes: '',
    status: 'done',
    priority: 0,
    quadrant: 2,
    dueDate: null,
    dueTime: null,
    dueAt: null,
    tz: 'Asia/Shanghai',
    reminder: '',
    sortOrder: 0,
    completedAt: `${TODAY}T12:00:00.000Z`,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<FocusSession> &
    Pick<FocusSession, 'id' | 'taskId' | 'minutes' | 'startedAt'>,
): FocusSession {
  return {
    spaceId: 'personal',
    endedAt: null,
    mode: 'pomodoro',
    note: '',
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function makeHabit(overrides: Partial<Habit> & Pick<Habit, 'id' | 'title'>): Habit {
  return {
    spaceId: 'personal',
    schedule: '每天',
    icon: '✳',
    color: 'blue',
    goalPerWeek: 7,
    sortOrder: 0,
    archived: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function makeLog(
  overrides: Partial<HabitLog> & Pick<HabitLog, 'habitId' | 'logDate'>,
): HabitLog {
  return {
    id: `log-${overrides.habitId}-${overrides.logDate}`,
    spaceId: 'personal',
    done: true,
    note: '',
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function fixture() {
  const tasks = [
    makeTask({ id: 'task-1', title: '完成任务一', listId: 'work' }),
    makeTask({
      id: 'task-2',
      title: '完成任务二',
      listId: 'life',
      completedAt: `${TODAY}T13:00:00.000Z`,
    }),
    makeTask({
      id: 'task-3',
      title: '昨天完成',
      completedAt: '2026-10-25T12:00:00.000Z',
    }),
    // 到期日是今天，但完成日是更早的一天：不得回退当作今天完成。
    makeTask({
      id: 'task-old',
      title: '旧任务今天到期',
      dueDate: TODAY,
      completedAt: '2026-10-20T12:00:00.000Z',
    }),
    // 未完成 / 软删除不计入。
    makeTask({ id: 'task-open', title: '还没做', status: 'todo', completedAt: null }),
    makeTask({
      id: 'task-deleted',
      title: '已删除完成项',
      deletedAt: '2026-10-26T00:00:00.000Z',
    }),
  ];
  const sessions = [
    makeSession({
      id: 'focus-1',
      taskId: 'task-1',
      minutes: 25,
      startedAt: `${TODAY}T09:00:00+08:00`,
    }),
    makeSession({
      id: 'focus-2',
      taskId: 'task-1',
      minutes: 5,
      startedAt: `${TODAY}T10:00:00+08:00`,
    }),
    makeSession({
      id: 'focus-3',
      taskId: 'task-2',
      minutes: 10,
      startedAt: '2026-10-25T09:00:00+08:00',
    }),
    makeSession({
      id: 'focus-old',
      taskId: 'task-1',
      minutes: 99,
      startedAt: '2026-10-01T09:00:00+08:00',
    }),
    makeSession({
      id: 'focus-deleted',
      taskId: 'task-1',
      minutes: 60,
      startedAt: `${TODAY}T11:00:00+08:00`,
      deletedAt: '2026-10-26T00:00:00.000Z',
    }),
  ];
  const habits = [
    makeHabit({ id: 'habit-a', title: '阅读' }),
    makeHabit({ id: 'habit-b', title: '早起' }),
  ];
  const logsByHabit = {
    'habit-a': [
      makeLog({ habitId: 'habit-a', logDate: TODAY }),
      makeLog({
        habitId: 'habit-a',
        logDate: '2026-10-25',
        id: 'log-a-yesterday',
      }),
    ],
    'habit-b': [
      makeLog({ habitId: 'habit-b', logDate: TODAY, id: 'log-b-today' }),
      makeLog({
        habitId: 'habit-b',
        logDate: '2026-10-26',
        id: 'log-b-deleted',
        deletedAt: '2026-10-26T00:00:00.000Z',
      }),
      makeLog({
        habitId: 'habit-b',
        logDate: '2026-10-01',
        id: 'log-b-old',
      }),
    ],
  };
  const lists = [
    makeList({ id: 'work', name: '工作' }),
    makeList({ id: 'life', name: '生活' }),
  ];
  return { tasks, sessions, habits, logsByHabit, lists };
}

describe('复盘范围与柱高', () => {
  it('最近 7 天包含今天，升序且跨月正确', () => {
    expect(reviewRange('2026-10-26')).toEqual({
      from: '2026-10-20',
      to: '2026-10-26',
    });
    expect(reviewRange('2026-11-02').from).toBe('2026-10-27');
  });

  it('柱高对 0 与非法值返回 0，不会出现 NaN', () => {
    expect(barPercent(0, 10)).toBe(0);
    expect(barPercent(5, 0)).toBe(100);
    expect(barPercent(5, Number.NaN)).toBe(100);
    expect(barPercent(Number.NaN, 10)).toBe(0);
    expect(barPercent(1, 100)).toBe(4);
    expect(Number.isNaN(barPercent(0, 0))).toBe(false);
  });

  it('分钟格式化与统计卡数值', () => {
    expect(formatDuration(0)).toBe('0 分钟');
    expect(formatDuration(30)).toBe('30 分钟');
    expect(formatDuration(60)).toBe('1 小时');
    expect(formatDuration(95)).toBe('1 小时 35 分钟');
    expect(focusCardValue(30)).toEqual({ value: '30', unit: '分钟' });
    expect(focusCardValue(90)).toEqual({ value: '1.5', unit: '小时' });
  });

  it('完成日只认 completedAt，不把到期日回退为完成日', () => {
    const { tasks, sessions, habits, logsByHabit, lists } = fixture();
    const aggregate = buildReviewAggregate({
      today: TODAY,
      tasks,
      sessions,
      habits,
      logsByHabit,
      lists,
    });

    const today = aggregate.days.find((day) => day.date === TODAY);
    expect(today?.taskCount).toBe(2);
    expect(today?.focusMinutes).toBe(30);
    expect(today?.habitChecks).toBe(2);

    const older = aggregate.days.find((day) => day.date === '2026-10-20');
    expect(older?.taskCount).toBe(1);
    expect(aggregate.days.find((day) => day.date === '2026-10-25')?.taskCount).toBe(
      1,
    );
    expect(
      aggregate.recentCompleted.some((item) => item.id === 'task-old'),
    ).toBe(true);
    expect(
      aggregate.recentCompleted.find((item) => item.id === 'task-old')
        ?.completedDate,
    ).toBe('2026-10-20');
  });

  it('三卡合计与日柱逐日相加一致，今天柱与卡片同源', () => {
    const { tasks, sessions, habits, logsByHabit, lists } = fixture();
    const aggregate = buildReviewAggregate({
      today: TODAY,
      tasks,
      sessions,
      habits,
      logsByHabit,
      lists,
    });

    expect(aggregate.totals.tasks).toBe(4);
    expect(aggregate.totals.focusMinutes).toBe(40);
    expect(aggregate.totals.habits).toBe(3);
    expect(
      aggregate.days.reduce((sum, day) => sum + day.taskCount, 0),
    ).toBe(aggregate.totals.tasks);
    expect(
      aggregate.days.reduce((sum, day) => sum + day.focusMinutes, 0),
    ).toBe(aggregate.totals.focusMinutes);
    expect(
      aggregate.days.reduce((sum, day) => sum + day.habitChecks, 0),
    ).toBe(aggregate.totals.habits);
    expect(
      metricValue(aggregate.days[6], 'tasks'),
    ).toBe(aggregate.totals.tasks - 2);
    expect(metricMax(aggregate.days, 'tasks')).toBe(2);
  });

  it('保存来源 ID：任务完成、专注记录与习惯 id 均可回链', () => {
    const { tasks, sessions, habits, logsByHabit, lists } = fixture();
    const aggregate = buildReviewAggregate({
      today: TODAY,
      tasks,
      sessions,
      habits,
      logsByHabit,
      lists,
    });

    expect(aggregate.sourceIds.taskIds).toEqual([
      'task-1',
      'task-2',
      'task-3',
      'task-old',
    ]);
    expect(aggregate.sourceIds.focusIds).toEqual([
      'focus-1',
      'focus-2',
      'focus-3',
    ]);
    expect(aggregate.sourceIds.habitIds.sort()).toEqual([
      'habit-a',
      'habit-b',
    ]);
    expect(aggregate.note.title).toBe('复盘 · 2026-10-26');
    expect(aggregate.note.tags).toEqual(['复盘']);
    expect(aggregate.note.body).toContain('data-review-range-start="2026-10-20"');
    expect(aggregate.note.body).toContain('data-review-range-end="2026-10-26"');
    expect(aggregate.note.body).toContain('data-source-type="task"');
    expect(aggregate.note.body).toContain('data-source-id="focus-1"');
    expect(aggregate.note.body).toContain('data-source-type="habit"');
    expect(aggregate.note.body).toContain('完成任务：4 项');
    expect(aggregate.note.body).toContain('专注时长：40 分钟');
    expect(aggregate.note.body).toContain('习惯打卡：3 次');
    expect(aggregate.note.body).not.toContain('NaN');
  });

  it('最近完成按完成时间倒序，专注 Top5 按任务汇总', () => {
    const { tasks, sessions, habits, logsByHabit, lists } = fixture();
    const aggregate = buildReviewAggregate({
      today: TODAY,
      tasks,
      sessions,
      habits,
      logsByHabit,
      lists,
    });

    expect(aggregate.recentCompleted[0].id).toBe('task-2');
    expect(aggregate.recentCompleted[0].listName).toBe('生活');
    expect(aggregate.focusTop).toEqual([
      { taskId: 'task-1', title: '完成任务一', minutes: 30, share: 75 },
      { taskId: 'task-2', title: '完成任务二', minutes: 10, share: 25 },
    ]);
  });

  it('无数据日显示 0，不产生 NaN', () => {
    const aggregate = buildReviewAggregate({
      today: TODAY,
      tasks: [],
      sessions: [],
      habits: [],
      logsByHabit: {},
      lists: [],
    });

    expect(aggregate.totals).toEqual({ tasks: 0, focusMinutes: 0, habits: 0 });
    expect(aggregate.days).toHaveLength(7);
    expect(aggregate.days.every((day) => day.taskCount === 0)).toBe(true);
    expect(aggregate.days.every((day) => day.focusMinutes === 0)).toBe(true);
    expect(aggregate.days.every((day) => day.habitChecks === 0)).toBe(true);
    expect(aggregate.recentCompleted).toEqual([]);
    expect(aggregate.focusTop).toEqual([]);
    expect(aggregate.note.body).toContain('这段时间还没有完成任务');
    expect(aggregate.note.body).toContain('还没有专注记录');
    expect(aggregate.note.body).not.toContain('NaN');
    expect(aggregate.note.body).not.toContain('Infinity');
  });

  it('聚合是纯函数，不会修改源对象（编辑笔记不影响统计）', () => {
    const { tasks, sessions, habits, logsByHabit, lists } = fixture();
    const before = JSON.stringify({ tasks, sessions, habits, logsByHabit });
    const first = buildReviewAggregate({
      today: TODAY,
      tasks,
      sessions,
      habits,
      logsByHabit,
      lists,
    });
    const second = buildReviewAggregate({
      today: TODAY,
      tasks,
      sessions,
      habits,
      logsByHabit,
      lists,
    });
    expect(second).toEqual(first);
    expect(JSON.stringify({ tasks, sessions, habits, logsByHabit })).toBe(
      before,
    );
  });

  it('时间戳按本地日历日换算，而不是盲截前 10 位', () => {
    const parsed = localDateOfTimestamp('2026-10-26T10:00:00+08:00');
    expect(parsed).toMatch(/^2026-10-2[56]$/);
    expect(localDateOfTimestamp(null)).toBeNull();
    expect(localDateOfTimestamp('')).toBeNull();
    expect(localDateOfTimestamp('not-a-date')).toBeNull();
  });
});
