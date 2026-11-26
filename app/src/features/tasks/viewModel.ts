/**
 * 任务域的纯函数视图模型。
 *
 * 所有日期都是本地日历日 `YYYY-MM-DD`，不使用 UTC 切日；逾期按自然日计算。
 * 这些函数不读全局状态、不访问 IPC，便于单测和页面复用。
 */

import type { List, Task, TaskStatus } from '../../data/db/types';
import type { TaskCompletionBehavior } from '../../data/repositories/settings';
import {
  startOfWeekISO,
  type WeekStart,
} from '../calendar/workweek';

export type TodayView = 'list' | 'quadrant' | 'board';
export type QuadrantScope = 'today' | 'all';
export type BoardStatus = 'todo' | 'doing' | 'done';

export const TODAY_VIEWS: ReadonlyArray<{ value: TodayView; label: string }> = [
  { value: 'list', label: '列表' },
  { value: 'quadrant', label: '四象限' },
  { value: 'board', label: '看板' },
];

export const QUADRANT_SCOPES: ReadonlyArray<{
  value: QuadrantScope;
  label: string;
}> = [
  { value: 'today', label: '今天（含逾期）' },
  { value: 'all', label: '全部未完成' },
];

export const QUADRANTS = [
  { value: 1, title: '重要且紧急', hint: '马上处理', tone: 'q1' },
  { value: 2, title: '重要不紧急', hint: '安排时间', tone: 'q2' },
  { value: 3, title: '紧急不重要', hint: '尽量委托', tone: 'q3' },
  { value: 4, title: '不重要不紧急', hint: '可以放下', tone: 'q4' },
] as const;

export const BOARD_COLUMNS: ReadonlyArray<{
  status: BoardStatus;
  label: string;
  color: string;
}> = [
  { status: 'todo', label: '待办', color: 'var(--muted)' },
  { status: 'doing', label: '进行中', color: 'var(--blue)' },
  { status: 'done', label: '已完成', color: 'var(--green)' },
];

/** 任务三态的唯一显示顺序；行、看板、筛选、详情共用。 */
export const TASK_STATUS_ORDER: ReadonlyArray<TaskStatus> = [
  'todo',
  'doing',
  'done',
];

export const TASK_STATUS_OPTIONS: ReadonlyArray<{
  value: TaskStatus;
  label: string;
}> = [
  { value: 'todo', label: '待办' },
  { value: 'doing', label: '进行中' },
  { value: 'done', label: '已完成' },
];

export type TaskStatusFilter = 'all' | TaskStatus;

export const TASK_STATUS_FILTERS: ReadonlyArray<{
  value: TaskStatusFilter;
  label: string;
}> = [{ value: 'all', label: '全部' }, ...TASK_STATUS_OPTIONS];

export function isTaskStatusFilter(
  value: string | null | undefined,
): value is TaskStatusFilter {
  return (
    value === 'all' ||
    value === 'todo' ||
    value === 'doing' ||
    value === 'done'
  );
}

export function statusCounts(tasks: Task[]): {
  all: number;
  todo: number;
  doing: number;
  done: number;
  open: number;
} {
  const todo = tasks.filter((task) => task.status === 'todo').length;
  const doing = tasks.filter((task) => task.status === 'doing').length;
  const done = tasks.filter((task) => task.status === 'done').length;
  return {
    all: tasks.length,
    todo,
    doing,
    done,
    open: todo + doing,
  };
}

/** 状态筛选只做最后一道过滤；计数由调用方在筛选前的集合上计算。 */
export function filterTasksByStatus(
  tasks: Task[],
  filter: TaskStatusFilter,
): Task[] {
  return filter === 'all'
    ? tasks
    : tasks.filter((task) => task.status === filter);
}

/**
 * 完成前状态记忆。
 *
 * 正式版应写 SQLite `statusBeforeDone`；当前任务表没有该列，因此前端在本机
 * localStorage 里按 taskId + completedAt 记忆。completedAt 不匹配（任务被
 * 再次完成、同步覆盖或换了测试数据）时会自动丢弃旧记忆，避免恢复错状态。
 */
export type StatusBeforeDone = 'todo' | 'doing';

type StatusMemoryEntry = {
  status: StatusBeforeDone;
  completedAt: string;
};

const STATUS_MEMORY_KEY = 'zx.tasks.statusBeforeDone.v1';

function readStatusMemory(): Record<string, StatusMemoryEntry> {
  try {
    if (typeof localStorage === 'undefined') {
      return {};
    }
    const raw = localStorage.getItem(STATUS_MEMORY_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const entries: Record<string, StatusMemoryEntry> = {};
    for (const [id, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const entry = value as { status?: unknown; completedAt?: unknown };
      if (
        (entry.status === 'todo' || entry.status === 'doing') &&
        typeof entry.completedAt === 'string' &&
        entry.completedAt
      ) {
        entries[id] = { status: entry.status, completedAt: entry.completedAt };
      }
    }
    return entries;
  } catch {
    return {};
  }
}

let statusMemory: Record<string, StatusMemoryEntry> = readStatusMemory();

function persistStatusMemory() {
  try {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.setItem(STATUS_MEMORY_KEY, JSON.stringify(statusMemory));
  } catch {
    // 隐私模式/配额不足时只保留内存记忆，不影响状态变更本身。
  }
}

export function rememberStatusBeforeDone(
  taskId: string,
  status: TaskStatus,
  completedAt: string | null,
) {
  if (status === 'done' || !completedAt) {
    return;
  }
  statusMemory[taskId] = { status, completedAt };
  persistStatusMemory();
}

/** 只有 completedAt 仍是同一次完成时才返回记忆，避免旧记忆串到新完成。 */
export function statusBeforeDoneOf(task: Task): StatusBeforeDone | null {
  const entry = statusMemory[task.id];
  if (!entry || !task.completedAt || entry.completedAt !== task.completedAt) {
    return null;
  }
  return entry.status;
}

export function forgetStatusBeforeDone(taskId: string) {
  if (!(taskId in statusMemory)) {
    return;
  }
  delete statusMemory[taskId];
  persistStatusMemory();
}

/** 单测用：清空模块内与 localStorage 的记忆。 */
export function resetStatusBeforeDoneMemory() {
  statusMemory = {};
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STATUS_MEMORY_KEY);
    }
  } catch {
    // ignore
  }
}

export const PRIORITY_LABELS = ['无', '低', '中', '高'] as const;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地日历日，避免 `toISOString()` 在东八区跨日。 */
export function todayISO(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseISODate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function addDaysISO(value: string, days: number): string {
  const date = parseISODate(value);
  date.setDate(date.getDate() + days);
  return todayISO(date);
}

/** b - a，按自然日计算。 */
export function diffDays(a: string, b: string): number {
  const ms = parseISODate(b).getTime() - parseISODate(a).getTime();
  return Math.round(ms / 86_400_000);
}

/** 本周起始日（与日历共用周起始设置）。 */
export function weekStartISO(
  value: string,
  weekStart: WeekStart = 'monday',
): string {
  return startOfWeekISO(value, weekStart);
}

/** 本周最后一天（周日开头时为周六）。 */
export function weekEndISO(
  value: string,
  weekStart: WeekStart = 'monday',
): string {
  return addDaysISO(weekStartISO(value, weekStart), 6);
}

export function overdueDays(dueDate: string, today: string): number {
  return Math.max(0, diffDays(dueDate, today));
}

export function isOverdue(task: Task, today: string): boolean {
  return (
    task.status !== 'done' &&
    task.dueDate !== null &&
    task.dueDate < today
  );
}

export function formatMonthDay(value: string): string {
  const date = parseISODate(value);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatWeekday(value: string): string {
  return `周${'日一二三四五六'[parseISODate(value).getDay()]}`;
}

export function formatTodayHeading(value: string): string {
  return `${formatMonthDay(value)} ${formatWeekday(value)}`;
}

export function formatDueLabel(task: Task, today: string): string {
  if (!task.dueDate) {
    return '未安排';
  }
  const diff = diffDays(today, task.dueDate);
  const base =
    diff === 0
      ? '今天'
      : diff === 1
        ? '明天'
        : diff === -1
          ? '昨天'
          : formatMonthDay(task.dueDate);
  return task.dueTime ? `${base} ${task.dueTime}` : base;
}

export function formatOverdueLabel(task: Task, today: string): string {
  if (!task.dueDate || !isOverdue(task, today)) {
    return '';
  }
  return `逾期 ${Math.max(1, overdueDays(task.dueDate, today))} 天`;
}

function compareTasks(a: Task, b: Task): number {
  const dueA = a.dueDate ?? '9999-99-99';
  const dueB = b.dueDate ?? '9999-99-99';
  if (dueA !== dueB) {
    return dueA < dueB ? -1 : 1;
  }
  const timeA = a.dueTime ?? '99:99';
  const timeB = b.dueTime ?? '99:99';
  if (timeA !== timeB) {
    return timeA < timeB ? -1 : 1;
  }
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }
  if (a.sortOrder !== b.sortOrder) {
    return a.sortOrder - b.sortOrder;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
}

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(compareTasks);
}

export type TodayOverview = {
  overdue: Task[];
  todayOpen: Task[];
  todayDone: Task[];
  open: Task[];
  total: number;
  doneCount: number;
  percent: number;
};

/**
 * 今天只处理「今天到期 + 逾期未完成」，以及今天到期且已完成。
 * 未来任务和无日期任务永远不会被塞进今天。
 *
 * `completionBehavior === 'remove'` 时只从活动视图移除已完成行；完成计数与
 * 进度仍按真实数据计算，避免设置把已有成果“清零”。任务中心的「已完成」
 * 筛选与搜索不经过这里。
 */
export function getTodayOverview(
  tasks: Task[],
  today: string,
  completionBehavior: TaskCompletionBehavior = 'keep',
): TodayOverview {
  const overdue = sortTasks(
    tasks.filter((task) => task.status !== 'done' && task.dueDate !== null && task.dueDate < today),
  );
  const todayOpen = sortTasks(
    tasks.filter((task) => task.status !== 'done' && task.dueDate === today),
  );
  const completedToday = sortTasks(
    tasks.filter((task) => task.status === 'done' && task.dueDate === today),
  );
  const todayDone =
    completionBehavior === 'remove' ? [] : completedToday;
  const open = sortTasks([...overdue, ...todayOpen]);
  const total = open.length + completedToday.length;
  return {
    overdue,
    todayOpen,
    todayDone,
    open,
    total,
    doneCount: completedToday.length,
    percent: total === 0 ? 0 : Math.round((completedToday.length / total) * 100),
  };
}

/** 四象限范围：今天（含逾期，只看未完成）或全部未完成。 */
export function getQuadrantTasks(
  tasks: Task[],
  scope: QuadrantScope,
  today: string,
): Task[] {
  if (scope === 'today') {
    return tasks.filter(
      (task) =>
        task.status !== 'done' &&
        task.dueDate !== null &&
        task.dueDate <= today,
    );
  }
  return tasks.filter((task) => task.status !== 'done');
}

export function quadrantOf(task: Task): number {
  return task.quadrant >= 1 && task.quadrant <= 4 ? task.quadrant : 4;
}

export function nextQuadrant(quadrant: number): number {
  return quadrant >= 4 ? 1 : Math.max(1, quadrant) + 1;
}

/** 看板三列：今天范围内的待办 / 进行中，以及今天到期的已完成。 */
export function getBoardTasks(
  tasks: Task[],
  status: BoardStatus,
  today: string,
  completionBehavior: TaskCompletionBehavior = 'keep',
): Task[] {
  if (status === 'done') {
    if (completionBehavior === 'remove') {
      return [];
    }
    return sortTasks(
      tasks.filter(
        (task) => task.status === 'done' && task.dueDate === today,
      ),
    );
  }
  return sortTasks(
    tasks.filter(
      (task) =>
        task.status === status &&
        task.dueDate !== null &&
        task.dueDate <= today,
    ),
  );
}

/**
 * 未安排投影（兼容旧页面的纯函数）：所有无日期任务（无论当前挂在哪个清单）。
 * 新建无日期任务时会被强制放入内部 capture 清单，编辑日期为空时也会回到 capture；
 * UI 统一显示为「未安排」，不再把它当作清单入口。
 */
export function getInboxTasks(tasks: Task[]): Task[] {
  return sortTasks(tasks.filter((task) => task.dueDate === null));
}

export type ListTaskGroups = {
  todo: Task[];
  doing: Task[];
  done: Task[];
};

/**
 * 单个清单内按任务三态分组，顺序固定：待办 → 进行中 → 已完成。
 * 日期只作为行内徽标，不再决定清单详情分组；空组由调用方跳过。
 * `remove` 只隐藏已完成行，清单概览统计仍由全部任务计算。
 */
export function groupListTasks(
  tasks: Task[],
  completionBehavior: TaskCompletionBehavior = 'keep',
): ListTaskGroups {
  return {
    todo: sortTasks(tasks.filter((task) => task.status === 'todo')),
    doing: sortTasks(tasks.filter((task) => task.status === 'doing')),
    done:
      completionBehavior === 'remove'
        ? []
        : sortTasks(tasks.filter((task) => task.status === 'done')),
  };
}

export function listNameOf(lists: List[], listId: string): string {
  return lists.find((list) => list.id === listId)?.name ?? '未命名清单';
}

/**
 * 用户可见的清单名：内部 capture 清单（is_inbox=1）统一显示「未安排」，
 * 不作为可管理清单出现在任何 UI 中。
 */
export function listDisplayName(lists: List[], listId: string): string {
  const list = lists.find((item) => item.id === listId);
  if (!list || list.isInbox) {
    return '未安排';
  }
  return list.name;
}

export function countOpenTasks(tasks: Task[]): number {
  return tasks.filter((task) => task.status !== 'done').length;
}

export function statusLabel(status: TaskStatus): string {
  return status === 'done' ? '已完成' : status === 'doing' ? '进行中' : '待办';
}
