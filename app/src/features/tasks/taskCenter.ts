/**
 * 任务中心（全部任务）的纯函数模型。
 *
 * 权威口径来自 `outputs/任务中心定位与交互规范-2026-10-28.md`：
 * * `/tasks` 是唯一入口；范围 open / undated / today / done；
 * * 清单筛选包含后代，capture（is_inbox）不进入清单筛选；
 * * 日期筛选只在「全部未完成」生效；
 * * 未完成按逾期 / 今天 / 本周 / 以后 / 未安排分组，周起始跟随日历设置；
 * * 已完成按 completedAt 降序，缺失时用 updatedAt；
 * * 计数、筛选、分组都在内存中完成，便于单测与实际页面复用。
 */

import type { List, Task } from '../../data/db/types';
import type { WeekStart } from '../calendar/workweek';
import { subtreeIds } from '../../pages/Lists/tree';
import {
  addDaysISO,
  diffDays,
  sortTasks,
  weekEndISO,
  weekStartISO,
} from './viewModel';

export { weekEndISO, weekStartISO } from './viewModel';

export type TaskCenterFilter = 'open' | 'today' | 'next' | 'undated' | 'done';
export type TaskCenterDateFilter = 'overdue' | 'week' | 'later';
export type TaskCenterView = 'list' | 'board';

export type TaskCenterState = {
  filter: TaskCenterFilter;
  view: TaskCenterView;
  listId: string | null;
  /** `0` 是有效值（无优先级），因此用 null 表示“全部”。 */
  priority: number | null;
  date: TaskCenterDateFilter | null;
  query: string;
};

export type TaskCenterCounts = {
  total: number;
  open: number;
  done: number;
  /** 逾期未完成。 */
  overdue: number;
  /** 今天到期且未完成。 */
  todayOpen: number;
  /** 今天到期且已完成。 */
  todayDone: number;
  /** 范围标签的「今天」= 逾期 + 今天到期未完成。 */
  today: number;
  /** 明天到未来 7 天（不含今天）的未完成。 */
  next7: number;
  undated: number;
};

export type TaskCenterGroupKey =
  | 'overdue'
  | 'today'
  | 'week'
  | 'later'
  | 'undated'
  | 'tomorrow'
  | 'd2'
  | 'd4'
  | 'done-today'
  | 'done-week'
  | 'done-earlier';

export type TaskCenterGroup = {
  key: TaskCenterGroupKey;
  label: string;
  tasks: Task[];
};

export type TaskCenterEmptyReason =
  | 'no-tasks'
  | 'undated-empty'
  | 'next-empty'
  | 'today-empty'
  | 'done-empty'
  | 'filtered';

export const MAX_BATCH_SIZE = 200;
export const MAX_QUERY_LENGTH = 100;

export const TASK_CENTER_FILTERS: ReadonlyArray<{
  value: TaskCenterFilter;
  label: string;
}> = [
  { value: 'open', label: '全部未完成' },
  { value: 'today', label: '今天' },
  { value: 'next', label: '接下来' },
  { value: 'undated', label: '未安排' },
  { value: 'done', label: '已完成' },
];

export const TASK_CENTER_VIEWS: ReadonlyArray<{
  value: TaskCenterView;
  label: string;
}> = [
  { value: 'list', label: '列表' },
  { value: 'board', label: '看板' },
];

export const TASK_CENTER_DATE_FILTERS: ReadonlyArray<{
  value: TaskCenterDateFilter;
  label: string;
}> = [
  { value: 'overdue', label: '逾期' },
  { value: 'week', label: '本周' },
  { value: 'later', label: '以后' },
];

export function isTaskCenterFilter(
  value: string | null | undefined,
): value is TaskCenterFilter {
  return (
    value === 'open' ||
    value === 'today' ||
    value === 'next' ||
    value === 'undated' ||
    value === 'done'
  );
}

export function isTaskCenterView(
  value: string | null | undefined,
): value is TaskCenterView {
  return value === 'list' || value === 'board';
}

export function isTaskCenterDateFilter(
  value: string | null | undefined,
): value is TaskCenterDateFilter {
  return value === 'overdue' || value === 'week' || value === 'later';
}

function isActiveTask(task: Task): boolean {
  return task.deletedAt === null;
}

function isOpenTask(task: Task): boolean {
  return task.status !== 'done';
}

export function isActiveUserList(list: List): boolean {
  return list.deletedAt === null && !list.isInbox;
}

/** 日期筛选与分组共用任务周起始（默认周一，设置可改为周日）。 */

export function getTaskCenterCounts(
  tasks: Task[],
  today: string,
): TaskCenterCounts {
  const active = tasks.filter(isActiveTask);
  const open = active.filter(isOpenTask);
  const overdue = open.filter(
    (task) => task.dueDate !== null && task.dueDate < today,
  ).length;
  const todayOpen = open.filter((task) => task.dueDate === today).length;
  const sevenDaysLater = addDaysISO(today, 7);
  return {
    total: active.length,
    open: open.length,
    done: active.length - open.length,
    overdue,
    todayOpen,
    todayDone: active.filter(
      (task) => !isOpenTask(task) && task.dueDate === today,
    ).length,
    today: overdue + todayOpen,
    next7: open.filter(
      (task) =>
        task.dueDate !== null &&
        task.dueDate > today &&
        task.dueDate <= sevenDaysLater,
    ).length,
    undated: open.filter((task) => task.dueDate === null).length,
  };
}

export function scopeTasks(
  tasks: Task[],
  filter: TaskCenterFilter,
  today: string,
): Task[] {
  const active = tasks.filter(isActiveTask);
  if (filter === 'done') {
    return active.filter((task) => !isOpenTask(task));
  }
  const open = active.filter(isOpenTask);
  if (filter === 'undated') {
    return open.filter((task) => task.dueDate === null);
  }
  if (filter === 'today') {
    return open.filter(
      (task) => task.dueDate !== null && task.dueDate <= today,
    );
  }
  if (filter === 'next') {
    const sevenDaysLater = addDaysISO(today, 7);
    return open.filter(
      (task) =>
        task.dueDate !== null &&
        task.dueDate > today &&
        task.dueDate <= sevenDaysLater,
    );
  }
  return open;
}

export function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/** 返回命中位置：标题优先，其次备注。 */
export function queryHit(
  task: Pick<Task, 'title' | 'notes'>,
  query: string,
): 'title' | 'notes' | null {
  const needle = normalizeQuery(query);
  if (!needle) {
    return null;
  }
  if (normalizeQuery(task.title).includes(needle)) {
    return 'title';
  }
  if (normalizeQuery(task.notes).includes(needle)) {
    return 'notes';
  }
  return null;
}

function inSelectedList(
  task: Task,
  listId: string | null,
  lists: List[],
): boolean {
  if (!listId) {
    return true;
  }
  const target = lists.find(
    (list) => list.id === listId && list.deletedAt === null,
  );
  if (!target) {
    // 清单不存在/已删除时按全部清单展示，避免用户误以为任务丢失；
    // 页面会额外显示“这个清单不存在或已被删除”的提示条。
    return true;
  }
  if (target.isInbox) {
    // 规范化后不应出现；兜底为“没有匹配”，避免把 capture 当成清单。
    return false;
  }
  return subtreeIds(lists, listId).has(task.listId);
}

function inDateRange(
  task: Task,
  date: TaskCenterDateFilter,
  today: string,
  weekStart: WeekStart,
): boolean {
  if (task.dueDate === null) {
    return false;
  }
  const weekEnd = weekEndISO(today, weekStart);
  if (date === 'overdue') {
    return task.dueDate < today;
  }
  if (date === 'week') {
    return task.dueDate > today && task.dueDate <= weekEnd;
  }
  return task.dueDate > weekEnd;
}

/** 范围 + 清单（含后代）+ 优先级 + 日期 + 搜索，全部 AND。 */
export function filterTaskCenter(
  tasks: Task[],
  state: TaskCenterState,
  lists: List[],
  today: string,
  weekStart: WeekStart = 'monday',
): Task[] {
  const date = state.filter === 'open' ? state.date : null;
  return scopeTasks(tasks, state.filter, today).filter((task) => {
    if (!inSelectedList(task, state.listId, lists)) {
      return false;
    }
    if (state.priority !== null && task.priority !== state.priority) {
      return false;
    }
    if (date && !inDateRange(task, date, today, weekStart)) {
      return false;
    }
    if (state.query && !queryHit(task, state.query)) {
      return false;
    }
    return true;
  });
}

export function matchesTaskCenter(
  task: Task,
  state: TaskCenterState,
  lists: List[],
  today: string,
  weekStart: WeekStart = 'monday',
): boolean {
  return filterTaskCenter([task], state, lists, today, weekStart).length === 1;
}

function compareDoneTasks(a: Task, b: Task): number {
  const valueA = a.completedAt ?? a.updatedAt;
  const valueB = b.completedAt ?? b.updatedAt;
  if (valueA !== valueB) {
    return valueA < valueB ? 1 : -1;
  }
  return a.id.localeCompare(b.id);
}

export function sortDoneTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(compareDoneTasks);
}

function groupOf(
  key: TaskCenterGroupKey,
  label: string,
  sorted: Task[],
): TaskCenterGroup | null {
  if (sorted.length === 0) {
    return null;
  }
  return { key, label, tasks: sorted };
}

/**
 * 只返回非空分组；调用方直接渲染即可。
 * `dateFilter` 只在 open 范围生效，由调用方保证。
 */
export function groupTaskCenter(
  tasks: Task[],
  filter: TaskCenterFilter,
  today: string,
  dateFilter: TaskCenterDateFilter | null = null,
  weekStart: WeekStart = 'monday',
): TaskCenterGroup[] {
  if (filter === 'done') {
    const doneWeekStart = weekStartISO(today, weekStart);
    const dayOf = (task: Task) => (task.completedAt ?? '').slice(0, 10);
    const doneToday = sortDoneTasks(
      tasks.filter((task) => dayOf(task) === today),
    );
    const doneThisWeek = sortDoneTasks(
      tasks.filter((task) => {
        const day = dayOf(task);
        return Boolean(day) && day >= doneWeekStart && day < today;
      }),
    );
    const doneEarlier = sortDoneTasks(
      tasks.filter((task) => {
        const day = dayOf(task);
        return !day || day < doneWeekStart;
      }),
    );
    return [
      groupOf('done-today', '今天完成', doneToday),
      groupOf('done-week', '本周完成', doneThisWeek),
      groupOf('done-earlier', '更早完成', doneEarlier),
    ].filter((group): group is TaskCenterGroup => group !== null);
  }

  if (filter === 'undated') {
    return tasks.length > 0
      ? [{ key: 'undated', label: '未安排', tasks: sortTasks(tasks) }]
      : [];
  }

  if (filter === 'today') {
    const overdue = sortTasks(
      tasks.filter((task) => task.dueDate !== null && task.dueDate < today),
    );
    const dueToday = sortTasks(
      tasks.filter((task) => task.dueDate === today),
    );
    return [
      groupOf('overdue', '逾期', overdue),
      groupOf('today', '今天', dueToday),
    ].filter((group): group is TaskCenterGroup => group !== null);
  }

  if (filter === 'next') {
    const bucket = (min: number, max: number) =>
      sortTasks(
        tasks.filter((task) => {
          if (task.dueDate === null) {
            return false;
          }
          const distance = diffDays(today, task.dueDate);
          return distance >= min && distance <= max;
        }),
      );
    return [
      groupOf('tomorrow', '明天', bucket(1, 1)),
      groupOf('d2', '2–3 天后', bucket(2, 3)),
      groupOf('d4', '4–7 天后', bucket(4, 7)),
    ].filter((group): group is TaskCenterGroup => group !== null);
  }

  const pending = scopeTasks(tasks, 'open', today);
  const weekEnd = weekEndISO(today, weekStart);

  const candidates: Array<{
    key: TaskCenterGroupKey;
    label: string;
    match: (task: Task) => boolean;
  }> = [
    {
      key: 'overdue',
      label: '逾期',
      match: (task) => task.dueDate !== null && task.dueDate < today,
    },
    {
      key: 'today',
      label: '今天',
      match: (task) => task.dueDate === today,
    },
    {
      key: 'week',
      label: '本周',
      match: (task) =>
        task.dueDate !== null &&
        task.dueDate > today &&
        task.dueDate <= weekEnd,
    },
    {
      key: 'later',
      label: '以后',
      match: (task) => task.dueDate !== null && task.dueDate > weekEnd,
    },
    {
      key: 'undated',
      label: '未安排',
      match: (task) => task.dueDate === null,
    },
  ];

  const selected = dateFilter
    ? candidates.filter((candidate) => candidate.key === dateFilter)
    : candidates;

  return selected.flatMap((candidate) => {
    const group = groupOf(
      candidate.key,
      candidate.label,
      sortTasks(pending.filter(candidate.match)),
    );
    return group ? [group] : [];
  });
}

export function hasSecondaryFilters(state: TaskCenterState): boolean {
  return Boolean(
    state.listId ||
      state.priority !== null ||
      state.date ||
      state.query,
  );
}

export function listIsSelectedAndInbox(
  lists: List[],
  listId: string | null,
): boolean {
  if (!listId) {
    return false;
  }
  const list = lists.find(
    (item) => item.id === listId && item.deletedAt === null,
  );
  return Boolean(list?.isInbox);
}

export function listIsMissing(lists: List[], listId: string | null): boolean {
  if (!listId) {
    return false;
  }
  const list = lists.find(
    (item) => item.id === listId && item.deletedAt === null,
  );
  // capture 清单会在 URL 规范化时改成 filter=undated，不算“清单不存在”。
  return !list;
}

/**
 * URL 规范化：
 * * 非法 filter 删除（缺省即 open）；
 * * 非法 priority / date 删除；date 仅在 open 保留；
 * * q trim、截断 100，空串删除；
 * * list 指向 capture → 改成 filter=undated 并移除 list；
 * * task 空串删除；未知参数保留，避免丢用户上下文。
 */
export function normalizeTaskCenterSearch(
  input: URLSearchParams,
  lists: List[],
  listsReady: boolean,
): URLSearchParams {
  const next = new URLSearchParams(input);

  const rawFilter = next.get('filter');
  let filter: TaskCenterFilter = 'open';
  if (rawFilter !== null) {
    if (isTaskCenterFilter(rawFilter)) {
      filter = rawFilter;
    } else {
      next.delete('filter');
    }
  }

  const rawView = next.get('view');
  if (rawView !== null) {
    if (!isTaskCenterView(rawView) || rawView === 'list') {
      next.delete('view');
    }
  }

  const rawPriority = next.get('priority');
  if (rawPriority !== null) {
    const valid = /^[0-3]$/.test(rawPriority);
    if (!valid) {
      next.delete('priority');
    }
  }

  const rawDate = next.get('date');
  if (rawDate !== null) {
    if (!isTaskCenterDateFilter(rawDate) || filter !== 'open') {
      next.delete('date');
    }
  }

  const rawQuery = next.get('q');
  if (rawQuery !== null) {
    const trimmed = rawQuery.trim().slice(0, MAX_QUERY_LENGTH);
    if (!trimmed) {
      next.delete('q');
    } else if (trimmed !== rawQuery) {
      next.set('q', trimmed);
    }
  }

  const rawList = next.get('list');
  if (rawList !== null) {
    if (!rawList) {
      next.delete('list');
    } else if (listsReady) {
      const list = lists.find(
        (item) => item.id === rawList && item.deletedAt === null,
      );
      if (list?.isInbox) {
        next.delete('list');
        next.set('filter', 'undated');
      }
    }
  }

  if (next.get('task') === '') {
    next.delete('task');
  }

  return next;
}

/** 从已规范化的 URL 读取状态；非法值按“未设置”处理。 */
export function readTaskCenterState(
  params: URLSearchParams,
): TaskCenterState {
  const rawFilter = params.get('filter');
  const filter = isTaskCenterFilter(rawFilter) ? rawFilter : 'open';

  const rawPriority = params.get('priority');
  const priority =
    rawPriority !== null && /^[0-3]$/.test(rawPriority)
      ? Number(rawPriority)
      : null;

  const rawDate = params.get('date');
  const date =
    filter === 'open' && isTaskCenterDateFilter(rawDate) ? rawDate : null;

  const rawQuery = params.get('q') ?? '';
  const query = rawQuery.trim().slice(0, MAX_QUERY_LENGTH);
  const rawView = params.get('view');

  return {
    filter,
    view: isTaskCenterView(rawView) ? rawView : 'list',
    listId: params.get('list') || null,
    priority,
    date,
    query,
  };
}

export function taskCenterEmptyState(input: {
  total: number;
  resultCount: number;
  filter: TaskCenterFilter;
  hasSecondary: boolean;
  counts: TaskCenterCounts;
}): TaskCenterEmptyReason | null {
  if (input.total === 0) {
    return 'no-tasks';
  }
  if (input.resultCount > 0) {
    return null;
  }
  if (!input.hasSecondary) {
    if (input.filter === 'undated' && input.counts.undated === 0) {
      return 'undated-empty';
    }
    if (input.filter === 'today' && input.counts.today === 0) {
      return 'today-empty';
    }
    if (input.filter === 'next' && input.counts.next7 === 0) {
      return 'next-empty';
    }
    if (input.filter === 'done' && input.counts.done === 0) {
      return 'done-empty';
    }
  }
  return 'filtered';
}
