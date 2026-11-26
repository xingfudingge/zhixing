import { describe, expect, it } from 'vitest';

import type { List, Task } from '../../../data/db/types';
import { makeList, makeTask } from './fakeTaskSource';
import {
  MAX_QUERY_LENGTH,
  filterTaskCenter,
  getTaskCenterCounts,
  groupTaskCenter,
  hasSecondaryFilters,
  listIsMissing,
  matchesTaskCenter,
  normalizeTaskCenterSearch,
  queryHit,
  readTaskCenterState,
  scopeTasks,
  taskCenterEmptyState,
  weekEndISO,
  weekStartISO,
  type TaskCenterState,
} from '../taskCenter';

const TODAY = '2026-10-26';

const lists: List[] = [
  makeList({ id: 'inbox', name: '收件箱', isInbox: true, sortOrder: 0 }),
  makeList({ id: 'work', name: '工作', sortOrder: 10 }),
  makeList({ id: 'project', name: '项目 A', parentId: 'work', sortOrder: 10 }),
  makeList({ id: 'life', name: '生活', sortOrder: 20 }),
];

const tasks: Task[] = [
  makeTask({
    id: 'overdue',
    title: '逾期任务',
    listId: 'life',
    dueDate: '2026-10-25',
    priority: 2,
  }),
  makeTask({
    id: 'today',
    title: '今天任务',
    listId: 'work',
    dueDate: TODAY,
    dueTime: '09:00',
    priority: 3,
  }),
  makeTask({
    id: 'week',
    title: '本周任务',
    listId: 'work',
    dueDate: '2026-10-27',
    priority: 1,
  }),
  makeTask({
    id: 'later',
    title: '以后任务',
    listId: 'work',
    dueDate: '2026-11-02',
  }),
  makeTask({
    id: 'undated',
    title: '未安排任务',
    listId: 'inbox',
    notes: '这里写着 Report 草稿',
  }),
  makeTask({
    id: 'project-task',
    title: '项目任务',
    listId: 'project',
    dueDate: TODAY,
  }),
  makeTask({
    id: 'done',
    title: '已完成任务',
    listId: 'work',
    status: 'done',
    dueDate: '2026-10-24',
    completedAt: '2026-10-25T02:00:00.000Z',
  }),
  makeTask({
    id: 'deleted',
    title: '已删除任务',
    listId: 'work',
    dueDate: TODAY,
    deletedAt: '2026-10-25T00:00:00.000Z',
  }),
];

function state(overrides: Partial<TaskCenterState> = {}): TaskCenterState {
  return {
    filter: 'open',
    view: 'list',
    listId: null,
    priority: null,
    date: null,
    query: '',
    ...overrides,
  };
}

describe('任务中心纯函数：范围与计数', () => {
  it('计数排除已删除，今天含逾期，已完成单独计数', () => {
    expect(getTaskCenterCounts(tasks, TODAY)).toEqual({
      total: 7,
      open: 6,
      done: 1,
      overdue: 1,
      todayOpen: 2,
      todayDone: 0,
      today: 3,
      next7: 2,
      undated: 1,
    });
  });

  it('五个范围互斥且不包含已删除', () => {
    expect(
      scopeTasks(tasks, 'open', TODAY).map((task) => task.id),
    ).toEqual(['overdue', 'today', 'week', 'later', 'undated', 'project-task']);
    expect(
      scopeTasks(tasks, 'undated', TODAY).map((task) => task.id),
    ).toEqual(['undated']);
    expect(
      scopeTasks(tasks, 'today', TODAY).map((task) => task.id),
    ).toEqual(['overdue', 'today', 'project-task']);
    expect(
      scopeTasks(tasks, 'next', TODAY).map((task) => task.id),
    ).toEqual(['week', 'later']);
    expect(scopeTasks(tasks, 'done', TODAY).map((task) => task.id)).toEqual([
      'done',
    ]);
  });

  it('周一为周起始；周日「本周」为空', () => {
    expect(weekEndISO('2026-10-26')).toBe('2026-11-01');
    expect(weekEndISO('2026-11-01')).toBe('2026-11-01');
    expect(weekEndISO('2026-10-25')).toBe('2026-10-25');
  });
});

describe('任务中心纯函数：筛选', () => {
  it('清单筛选包含全部后代，不包含 capture 清单', () => {
    const ids = filterTaskCenter(
      tasks,
      state({ listId: 'work' }),
      lists,
      TODAY,
    ).map((task) => task.id);
    expect(ids).toContain('today');
    expect(ids).toContain('project-task');
    expect(ids).not.toContain('overdue');
    expect(ids).not.toContain('undated');

    expect(
      filterTaskCenter(tasks, state({ listId: 'inbox' }), lists, TODAY),
    ).toEqual([]);
  });

  it('priority=0 是有效值；null 表示全部', () => {
    const withoutPriority = tasks.filter((task) => task.priority === 0);
    expect(withoutPriority.length).toBeGreaterThan(0);
    expect(
      filterTaskCenter(tasks, state({ priority: 0 }), lists, TODAY).every(
        (task) => task.priority === 0,
      ),
    ).toBe(true);
    expect(
      filterTaskCenter(tasks, state({ priority: 2 }), lists, TODAY).map(
        (task) => task.id,
      ),
    ).toEqual(['overdue']);
    expect(
      filterTaskCenter(tasks, state({ priority: null }), lists, TODAY),
    ).toHaveLength(6);
  });

  it('日期筛选只在全部未完成生效，且不改变范围', () => {
    expect(
      filterTaskCenter(tasks, state({ date: 'overdue' }), lists, TODAY).map(
        (task) => task.id,
      ),
    ).toEqual(['overdue']);
    expect(
      filterTaskCenter(tasks, state({ date: 'week' }), lists, TODAY).map(
        (task) => task.id,
      ),
    ).toEqual(['week']);
    expect(
      filterTaskCenter(tasks, state({ date: 'later' }), lists, TODAY).map(
        (task) => task.id,
      ),
    ).toEqual(['later']);

    expect(
      filterTaskCenter(
        tasks,
        state({ filter: 'done', date: 'overdue' }),
        lists,
        TODAY,
      ).map((task) => task.id),
    ).toEqual(['done']);
  });

  it('搜索匹配标题与备注，拉丁字母大小写不敏感', () => {
    expect(queryHit(tasks[0], '逾期')).toBe('title');
    expect(queryHit(tasks[4], 'report')).toBe('notes');
    expect(queryHit(tasks[4], '不存在')).toBeNull();
    expect(
      filterTaskCenter(tasks, state({ query: 'report' }), lists, TODAY).map(
        (task) => task.id,
      ),
    ).toEqual(['undated']);
    expect(
      filterTaskCenter(
        tasks,
        state({ listId: 'project', query: '项目' }),
        lists,
        TODAY,
      ).map((task) => task.id),
    ).toEqual(['project-task']);
  });

  it('matchesTaskCenter 用于新建后判断是否在当前筛选内', () => {
    const created = makeTask({
      id: 'new',
      title: '新任务',
      listId: 'inbox',
      dueDate: null,
    });
    expect(matchesTaskCenter(created, state({ filter: 'undated' }), lists, TODAY)).toBe(true);
    expect(matchesTaskCenter(created, state({ filter: 'today' }), lists, TODAY)).toBe(false);
    expect(
      matchesTaskCenter(
        created,
        state({ filter: 'open', listId: 'work' }),
        lists,
        TODAY,
      ),
    ).toBe(false);
  });
});

describe('任务中心纯函数：分组与排序', () => {
  it('全部未完成按逾期/今天/本周/以后/未安排分组', () => {
    const open = scopeTasks(tasks, 'open', TODAY);
    const groups = groupTaskCenter(open, 'open', TODAY);
    expect(groups.map((group) => group.key)).toEqual([
      'overdue',
      'today',
      'week',
      'later',
      'undated',
    ]);
    expect(groups.map((group) => group.tasks.length)).toEqual([1, 2, 1, 1, 1]);
  });

  it('日期筛选只渲染对应组；今天范围只有逾期/今天', () => {
    expect(
      groupTaskCenter(
        filterTaskCenter(tasks, state({ date: 'week' }), lists, TODAY),
        'open',
        TODAY,
        'week',
      ).map((group) => group.key),
    ).toEqual(['week']);

    const todayGroups = groupTaskCenter(
      scopeTasks(tasks, 'today', TODAY),
      'today',
      TODAY,
    );
    expect(todayGroups.map((group) => group.key)).toEqual([
      'overdue',
      'today',
    ]);
  });

  it('接下来范围按明天 / 2–3 天后 / 4–7 天后分组', () => {
    const groups = groupTaskCenter(
      scopeTasks(tasks, 'next', TODAY),
      'next',
      TODAY,
    );
    expect(groups.map((group) => group.key)).toEqual(['tomorrow', 'd4']);
    expect(groups.map((group) => group.label)).toEqual(['明天', '4–7 天后']);
    expect(groups[0].tasks.map((task) => task.id)).toEqual(['week']);
    expect(groups[1].tasks.map((task) => task.id)).toEqual(['later']);
  });

  it('已完成按今天 / 本周 / 更早分组，组内 completedAt 降序', () => {
    const doneTasks = [
      makeTask({
        id: 'a',
        title: 'A',
        listId: 'work',
        status: 'done',
        completedAt: '2026-10-24T00:00:00.000Z',
      }),
      makeTask({
        id: 'b',
        title: 'B',
        listId: 'work',
        status: 'done',
        completedAt: '2026-10-26T00:00:00.000Z',
      }),
      makeTask({
        id: 'c',
        title: 'C',
        listId: 'work',
        status: 'done',
        completedAt: null,
        updatedAt: '2026-10-25T00:00:00.000Z',
      }),
    ];
    const groups = groupTaskCenter(doneTasks, 'done', TODAY);
    expect(groups.map((group) => group.key)).toEqual([
      'done-today',
      'done-earlier',
    ]);
    expect(groups[0].tasks.map((task) => task.id)).toEqual(['b']);
    expect(groups[1].tasks.map((task) => task.id)).toEqual(['c', 'a']);
  });
});

describe('任务中心纯函数：URL 规范化与空态', () => {
  it('非法 filter/priority/date 被移除，q trim 并截断', () => {
    const params = new URLSearchParams(
      `filter=bogus&priority=9&date=overdue&q=%20%20${'x'.repeat(
        MAX_QUERY_LENGTH + 10,
      )}%20%20`,
    );
    const next = normalizeTaskCenterSearch(params, lists, true);
    expect(next.get('filter')).toBeNull();
    expect(next.get('priority')).toBeNull();
    expect(next.get('date')).toBe('overdue');
    expect(next.get('q')).toBe('x'.repeat(MAX_QUERY_LENGTH));
  });

  it('date 只在 open 保留；capture list 改写为 filter=undated', () => {
    const done = normalizeTaskCenterSearch(
      new URLSearchParams('filter=done&date=week'),
      lists,
      true,
    );
    expect(done.get('date')).toBeNull();

    const inbox = normalizeTaskCenterSearch(
      new URLSearchParams('filter=done&list=inbox&task=t1'),
      lists,
      true,
    );
    expect(inbox.get('list')).toBeNull();
    expect(inbox.get('filter')).toBe('undated');
    expect(inbox.get('task')).toBe('t1');
  });

  it('未知参数保留；空 list/task 移除', () => {
    const next = normalizeTaskCenterSearch(
      new URLSearchParams('list=&task=&unknown=1'),
      lists,
      true,
    );
    expect(next.get('list')).toBeNull();
    expect(next.get('task')).toBeNull();
    expect(next.get('unknown')).toBe('1');
  });

  it('读取状态时非法值按未设置处理', () => {
    expect(
      readTaskCenterState(
        new URLSearchParams('filter=done&priority=0&date=week&q=%20报告%20'),
      ),
    ).toEqual({
      filter: 'done',
      view: 'list',
      listId: null,
      priority: 0,
      date: null,
      query: '报告',
    });
    expect(
      readTaskCenterState(
        new URLSearchParams('view=board&filter=next'),
      ),
    ).toMatchObject({ view: 'board', filter: 'next' });
    expect(
      readTaskCenterState(new URLSearchParams('view=bogus')),
    ).toMatchObject({ view: 'list' });
  });

  it('listIsMissing 只判断是否真的不存在', () => {
    expect(listIsMissing(lists, null)).toBe(false);
    expect(listIsMissing(lists, 'work')).toBe(false);
    expect(listIsMissing(lists, 'inbox')).toBe(false);
    expect(listIsMissing(lists, 'missing')).toBe(true);
  });

  it('hasSecondaryFilters 覆盖清单/优先级/日期/搜索', () => {
    expect(hasSecondaryFilters(state())).toBe(false);
    expect(hasSecondaryFilters(state({ listId: 'work' }))).toBe(true);
    expect(hasSecondaryFilters(state({ priority: 0 }))).toBe(true);
    expect(hasSecondaryFilters(state({ date: 'week' }))).toBe(true);
    expect(hasSecondaryFilters(state({ query: 'x' }))).toBe(true);
  });

  it('空态判定优先全局无任务，再区分五类范围空态', () => {
    const counts = getTaskCenterCounts(tasks, TODAY);
    expect(
      taskCenterEmptyState({
        total: 0,
        resultCount: 0,
        filter: 'open',
        hasSecondary: true,
        counts,
      }),
    ).toBe('no-tasks');
    expect(
      taskCenterEmptyState({
        total: 7,
        resultCount: 0,
        filter: 'undated',
        hasSecondary: false,
        counts: { ...counts, undated: 0 },
      }),
    ).toBe('undated-empty');
    expect(
      taskCenterEmptyState({
        total: 7,
        resultCount: 0,
        filter: 'today',
        hasSecondary: false,
        counts: { ...counts, today: 0 },
      }),
    ).toBe('today-empty');
    expect(
      taskCenterEmptyState({
        total: 7,
        resultCount: 0,
        filter: 'next',
        hasSecondary: false,
        counts: { ...counts, next7: 0 },
      }),
    ).toBe('next-empty');
    expect(
      taskCenterEmptyState({
        total: 7,
        resultCount: 0,
        filter: 'done',
        hasSecondary: false,
        counts: { ...counts, done: 0 },
      }),
    ).toBe('done-empty');
    expect(
      taskCenterEmptyState({
        total: 7,
        resultCount: 0,
        filter: 'undated',
        hasSecondary: true,
        counts,
      }),
    ).toBe('filtered');
  });
});

describe('任务中心：本周分组跟随周起始设置', () => {
  const sunday = '2026-11-01';
  const weekTasks: Task[] = [
    makeTask({ id: 'sat', title: '周六', listId: 'work', dueDate: '2026-10-31' }),
    makeTask({ id: 'sun', title: '周日', listId: 'work', dueDate: sunday }),
    makeTask({ id: 'mon', title: '周一', listId: 'work', dueDate: '2026-11-02' }),
    makeTask({ id: 'fri', title: '周五', listId: 'work', dueDate: '2026-11-06' }),
    makeTask({ id: 'sat2', title: '下周六', listId: 'work', dueDate: '2026-11-07' }),
    makeTask({ id: 'next', title: '下周之后', listId: 'work', dueDate: '2026-11-08' }),
  ];

  it('周一起始的周日是本周末尾，周日起始则开启新一周', () => {
    expect(weekStartISO(sunday, 'monday')).toBe('2026-10-26');
    expect(weekEndISO(sunday, 'monday')).toBe(sunday);
    expect(weekStartISO(sunday, 'sunday')).toBe(sunday);
    expect(weekEndISO(sunday, 'sunday')).toBe('2026-11-07');
  });

  it('「本周」筛选与分组使用同一个周末边界', () => {
    const mondayWeek = groupTaskCenter(
      weekTasks,
      'open',
      sunday,
      'week',
      'monday',
    );
    expect(mondayWeek.flatMap((group) => group.tasks).map((task) => task.id)).toEqual([]);

    const sundayWeek = groupTaskCenter(
      weekTasks,
      'open',
      sunday,
      'week',
      'sunday',
    );
    expect(
      sundayWeek.flatMap((group) => group.tasks).map((task) => task.id),
    ).toEqual(['mon', 'fri', 'sat2']);

    expect(
      filterTaskCenter(
        weekTasks,
        state({ date: 'week' }),
        lists,
        sunday,
        'sunday',
      ).map((task) => task.id),
    ).toEqual(['mon', 'fri', 'sat2']);
  });

  it('「已完成」本周分组同用周起始：周日开头时周六属于更早', () => {
    const done = [
      makeTask({
        id: 'done-sat',
        title: '周六完成',
        listId: 'work',
        status: 'done',
        dueDate: '2026-10-31',
        completedAt: '2026-10-31T02:00:00.000Z',
      }),
    ];

    const monday = groupTaskCenter(done, 'done', sunday, null, 'monday');
    expect(monday.find((group) => group.key === 'done-week')?.tasks).toHaveLength(
      1,
    );

    const sundayGroups = groupTaskCenter(
      done,
      'done',
      sunday,
      null,
      'sunday',
    );
    expect(
      sundayGroups.find((group) => group.key === 'done-earlier')?.tasks,
    ).toHaveLength(1);
    expect(
      sundayGroups.find((group) => group.key === 'done-week'),
    ).toBeUndefined();
  });
});
