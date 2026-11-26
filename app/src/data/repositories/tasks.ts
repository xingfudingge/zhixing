/**
 * 任务仓储封装。页面只使用这里的高层方法，不拼 SQL、不直接接触 IPC 命令名。
 *
 * * `patch` 以「当前任务 + 局部字段」生成完整 `TaskUpdate`，避免页面漏传字段；
 * * 完成状态统一走 `tasks_complete`，撤销由页面用 `patch({ status })` 恢复原状态；
 * * 子任务仍按任务 id 归属，删除为软删除。
 */

import type { DbClient } from '../db/client';
import type {
  NewSubtask,
  NewTask,
  Subtask,
  SubtaskUpdate,
  Task,
  TaskQuery,
  TaskStatus,
  TaskUpdate,
} from '../db/types';

export type TaskPatch = Partial<
  Pick<
    Task,
    | 'listId'
    | 'parentId'
    | 'noteId'
    | 'title'
    | 'notes'
    | 'status'
    | 'priority'
    | 'quadrant'
    | 'dueDate'
    | 'dueTime'
    | 'dueAt'
    | 'tz'
    | 'reminder'
    | 'sortOrder'
  >
>;

/** 把局部修改补全为 Rust `TaskUpdate` 需要的完整结构。 */
export function toTaskUpdate(task: Task, patch: TaskPatch): TaskUpdate {
  const next = { ...task, ...patch };
  return {
    listId: next.listId,
    parentId: next.parentId,
    noteId: next.noteId,
    title: next.title,
    notes: next.notes,
    status: next.status,
    priority: next.priority,
    quadrant: next.quadrant,
    dueDate: next.dueDate,
    dueTime: next.dueTime,
    dueAt: next.dueAt,
    tz: next.tz,
    reminder: next.reminder,
    sortOrder: next.sortOrder,
  };
}

export function isOpenTask(task: Task): boolean {
  return task.status !== 'done';
}

export function isTaskStatus(value: string): value is TaskStatus {
  return value === 'todo' || value === 'doing' || value === 'done';
}

export function createTaskRepository(client: DbClient) {
  const tasks = client.tasks;

  return {
    list: (query: TaskQuery = {}): Promise<Task[]> => tasks.list(query),
    get: (id: string): Promise<Task> => tasks.get(id),
    create: (input: NewTask): Promise<Task> => tasks.create(input),
    patch: (task: Task, patch: TaskPatch): Promise<Task> =>
      tasks.update(task.id, toTaskUpdate(task, patch)),
    complete: (id: string, done: boolean): Promise<Task> =>
      tasks.complete(id, done),
    remove: (id: string): Promise<void> => tasks.remove(id),
    restore: (id: string): Promise<Task> => tasks.restore(id),
    subtasks: {
      list: (taskId: string, includeDeleted = false): Promise<Subtask[]> =>
        tasks.subtasks.list(taskId, includeDeleted),
      create: (input: NewSubtask): Promise<Subtask> =>
        tasks.subtasks.create(input),
      update: (id: string, input: SubtaskUpdate): Promise<Subtask> =>
        tasks.subtasks.update(id, input),
      remove: (id: string): Promise<void> => tasks.subtasks.remove(id),
    },
  };
}

export type TaskRepository = ReturnType<typeof createTaskRepository>;
