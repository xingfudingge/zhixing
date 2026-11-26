/**
 * 笔记待办 ↔ 全局任务显式关联（P1-03）。
 *
 * 边界：
 * - 只有用户明确点“关联已有任务”或“新建任务并关联”才会写 `tasks`；
 *   插入/勾选笔记待办永远不会自动创建全局任务。
 * - 关联只写 `note_todos.task_id`，两边状态、完成时间、删除互不镜像。
 * - 全局任务被软删除后，关联仍然保留为墓碑；界面显示“已删除”，
 *   用户可以解除关联。解除不删除任一对象。
 */

import type {
  List,
  NewTask,
  NoteTodo,
  Task,
  TaskStatus,
} from '../../data/db/types';
import {
  normalizeNoteTodoTitle,
  type NoteTodoRepository,
} from '../../data/repositories/noteTodos';

/** linkTodo 只需要任务域的最小读写面，便于测试注入。 */
export type TodoTaskSource = {
  tasks: {
    list: (query?: {
      includeDeleted?: boolean | null;
      status?: TaskStatus | null;
    }) => Promise<Task[]>;
    get: (id: string) => Promise<Task>;
    create: (input: NewTask) => Promise<Task>;
    remove?: (id: string) => Promise<void>;
  };
  lists?: {
    list: (includeDeleted?: boolean) => Promise<List[]>;
    inbox?: () => Promise<List | null>;
  };
  noteTodos: NoteTodoRepository;
};

export type TodoTaskState = {
  taskId: string;
  title: string;
  status: TaskStatus;
  deleted: boolean;
  missing: boolean;
  listId: string | null;
};

export type TodoTaskChoice = {
  id: string;
  title: string;
  status: TaskStatus;
  listId: string;
};

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
};

export function taskStatusLabel(status: TaskStatus): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

export function isDeletedTask(task: Task): boolean {
  return task.deletedAt !== null;
}

export function toTodoTaskState(task: Task): TodoTaskState {
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    deleted: isDeletedTask(task),
    missing: false,
    listId: task.listId,
  };
}

/** 关联任务已被删除（或物理缺失）时给用户看的明确状态。 */
export function describeTodoTask(state: TodoTaskState | null | undefined): string {
  if (!state) {
    return '未关联';
  }
  if (state.deleted || state.missing) {
    return `已删除：${state.title}`;
  }
  return state.title;
}

export function linkedTaskIsDeleted(
  state: TodoTaskState | null | undefined,
): boolean {
  return Boolean(state && (state.deleted || state.missing));
}

export function todoTaskStateOfMissing(taskId: string): TodoTaskState {
  return {
    taskId,
    title: '已删除的任务',
    status: 'todo',
    deleted: true,
    missing: true,
    listId: null,
  };
}

/** 以任务列表为准构造状态表；物理缺失的 id 标记为已删除。 */
export function buildTodoTaskStates(
  taskIds: ReadonlyArray<string>,
  tasks: ReadonlyArray<Task>,
): Map<string, TodoTaskState> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const result = new Map<string, TodoTaskState>();
  for (const taskId of taskIds) {
    const task = byId.get(taskId);
    result.set(taskId, task ? toTodoTaskState(task) : todoTaskStateOfMissing(taskId));
  }
  return result;
}

export function sortTaskChoices(
  tasks: ReadonlyArray<Task>,
): TodoTaskChoice[] {
  const rank = (task: Task) => (task.status === 'done' ? 1 : 0);
  return [...tasks]
    .filter((task) => task.deletedAt === null && task.parentId === null)
    .sort((a, b) => {
      const rankDelta = rank(a) - rank(b);
      if (rankDelta !== 0) {
        return rankDelta;
      }
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      return a.title.localeCompare(b.title, 'zh-Hans-CN');
    })
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      listId: task.listId,
    }));
}

export function defaultListId(lists: ReadonlyArray<List>): string {
  const inbox = lists.find((list) => list.isInbox && list.deletedAt === null);
  if (inbox) {
    return inbox.id;
  }
  const first = lists.find((list) => list.deletedAt === null);
  if (first) {
    return first.id;
  }
  throw new Error('还没有可用的清单，无法创建全局任务');
}

/** 新建任务时只带用户明确选择/可推导的字段；不自动塞日期或象限。 */
export function buildTaskInputForTodo(
  todo: Pick<NoteTodo, 'noteId' | 'title'>,
  listId: string,
  options: { title?: string; dueDate?: string | null } = {},
): NewTask {
  const title = normalizeNoteTodoTitle(options.title ?? todo.title);
  return {
    listId,
    noteId: todo.noteId,
    title,
    notes: '来自笔记待办',
    status: 'todo',
    priority: 0,
    quadrant: 4,
    dueDate: options.dueDate ?? null,
  };
}

export type CreateTaskForTodoOptions = {
  title?: string;
  listId?: string;
  dueDate?: string | null;
};

export function createTodoTaskLinkService(source: TodoTaskSource) {
  const resolveOne = async (taskId: string): Promise<TodoTaskState> => {
    const tasks = await source.tasks.list({ includeDeleted: true });
    return buildTodoTaskStates([taskId], tasks).get(taskId)
      ?? todoTaskStateOfMissing(taskId);
  };

  const listChoices = async (): Promise<TodoTaskChoice[]> => {
    const tasks = await source.tasks.list({ includeDeleted: true });
    return sortTaskChoices(tasks);
  };

  const resolveMany = async (
    taskIds: ReadonlyArray<string>,
  ): Promise<Map<string, TodoTaskState>> => {
    const unique = [...new Set(taskIds.filter(Boolean))];
    if (unique.length === 0) {
      return new Map();
    }
    const tasks = await source.tasks.list({ includeDeleted: true });
    return buildTodoTaskStates(unique, tasks);
  };

  const link = async (todo: NoteTodo, taskId: string): Promise<NoteTodo> => {
    const state = await resolveOne(taskId);
    if (state.deleted || state.missing) {
      throw new Error('关联任务已删除，请选择其他任务');
    }
    if (todo.taskId === taskId) {
      return todo;
    }
    return source.noteTodos.patch(todo, { taskId });
  };

  const unlink = async (todo: NoteTodo): Promise<NoteTodo> => {
    if (todo.taskId === null) {
      return todo;
    }
    return source.noteTodos.patch(todo, { taskId: null });
  };

  const createTask = async (
    todo: NoteTodo,
    options: CreateTaskForTodoOptions = {},
  ): Promise<{ task: Task; todo: NoteTodo }> => {
    let listId = options.listId?.trim();
    if (!listId) {
      const lists = source.lists ? await source.lists.list() : [];
      listId = defaultListId(lists);
    }

    const task = await source.tasks.create(
      buildTaskInputForTodo(todo, listId, {
        title: options.title,
        dueDate: options.dueDate,
      }),
    );

    try {
      const updated = await source.noteTodos.patch(todo, { taskId: task.id });
      return { task, todo: updated };
    } catch (reason) {
      // 没有跨仓储事务；关联失败时回滚刚建的任务，避免留下半成品。
      if (source.tasks.remove) {
        await source.tasks.remove(task.id).catch(() => undefined);
      }
      throw reason;
    }
  };

  return {
    listChoices,
    resolveOne,
    resolveMany,
    link,
    unlink,
    createTask,
  };
}

export type TodoTaskLinkService = ReturnType<typeof createTodoTaskLinkService>;
