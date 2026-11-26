/**
 * 笔记待办仓储（P1-03）。
 *
 * `note_todos` 是知识域的独立对象：有稳定的 todo id、独立 `done` 状态和
 * 排序，只通过 `task_id` 与全局任务建立显式关联。本模块只读写笔记待办，
 * 不创建、不完成、不删除任何全局任务，也不镜像任务状态。
 *
 * 页面不直接接触 IPC 命令名；软删除后的撤销由 `restoreNoteTodo` 以“新 id
 * 重建同内容对象”的方式完成，因为当前 Rust 仓储只提供 `note_todos_delete`
 * 软删除命令，没有 restore 命令。旧行作为墓碑保留，关系不丢。
 */

import type { DbClient } from '../db/client';
import type {
  NewNoteTodo,
  NoteTodo,
  NoteTodoUpdate,
} from '../db/types';

/** 空标题在库里有非空约束；界面统一显示这个兜底文案。 */
export const NOTE_TODO_FALLBACK_TITLE = '待办事项';

export type NoteTodoPatch = Partial<
  Pick<
    NoteTodo,
    | 'taskId'
    | 'title'
    | 'done'
    | 'dueDate'
    | 'reminderEnabled'
    | 'sortOrder'
  >
>;

/** 撤销删除时需要的完整快照；不影响原行墓碑。 */
export type NoteTodoSnapshot = Pick<
  NoteTodo,
  | 'noteId'
  | 'taskId'
  | 'title'
  | 'done'
  | 'dueDate'
  | 'reminderEnabled'
  | 'sortOrder'
>;

export type NoteTodoRepository = {
  list: (noteId: string, includeDeleted?: boolean) => Promise<NoteTodo[]>;
  create: (input: NewNoteTodo) => Promise<NoteTodo>;
  patch: (todo: NoteTodo, patch: NoteTodoPatch) => Promise<NoteTodo>;
  remove: (id: string) => Promise<void>;
  /** 以新 id 重建同内容待办，用于删除撤销。 */
  restore: (snapshot: NoteTodoSnapshot) => Promise<NoteTodo>;
};

export function normalizeNoteTodoTitle(value: string): string {
  const title = value.replace(/\s+/g, ' ').trim();
  return title || NOTE_TODO_FALLBACK_TITLE;
}

export function sortNoteTodos(todos: ReadonlyArray<NoteTodo>): NoteTodo[] {
  return [...todos].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  });
}

export function noteTodoSummary(todos: ReadonlyArray<NoteTodo>): {
  total: number;
  done: number;
  pending: number;
} {
  const total = todos.length;
  const done = todos.filter((todo) => todo.done).length;
  return { total, done, pending: total - done };
}

/** 把局部修改补全为 Rust `NoteTodoUpdate` 要求的完整结构。 */
export function toNoteTodoUpdate(
  todo: NoteTodo,
  patch: NoteTodoPatch,
): NoteTodoUpdate {
  const next = { ...todo, ...patch };
  return {
    taskId: next.taskId,
    title: normalizeNoteTodoTitle(next.title),
    done: next.done,
    dueDate: next.dueDate,
    reminderEnabled: next.reminderEnabled,
    sortOrder: next.sortOrder,
  };
}

export function noteTodoSnapshot(todo: NoteTodo): NoteTodoSnapshot {
  return {
    noteId: todo.noteId,
    taskId: todo.taskId,
    title: todo.title,
    done: todo.done,
    dueDate: todo.dueDate,
    reminderEnabled: todo.reminderEnabled,
    sortOrder: todo.sortOrder,
  };
}

export function createNoteTodoRepository(
  client: DbClient,
): NoteTodoRepository {
  const noteTodos = client.noteTodos;

  return {
    list: async (noteId, includeDeleted = false) =>
      sortNoteTodos(await noteTodos.list(noteId, includeDeleted)),

    create: (input) =>
      noteTodos.create({
        ...input,
        title: normalizeNoteTodoTitle(input.title),
      }),

    patch: (todo, patch) =>
      noteTodos.update(todo.id, toNoteTodoUpdate(todo, patch)),

    remove: (id) => noteTodos.remove(id),

    restore: (snapshot) =>
      noteTodos.create({
        noteId: snapshot.noteId,
        taskId: snapshot.taskId,
        title: normalizeNoteTodoTitle(snapshot.title),
        done: snapshot.done,
        dueDate: snapshot.dueDate,
        reminderEnabled: snapshot.reminderEnabled,
        sortOrder: snapshot.sortOrder,
      }),
  };
}
