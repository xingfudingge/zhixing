/**
 * 测试用内存 note_todos 仓储：软删除、排序、局部更新语义对齐 Rust 仓储。
 */

import type {
  NewNoteTodo,
  NoteTodo,
  NoteTodoUpdate,
} from '../../../../data/db/types';
import {
  normalizeNoteTodoTitle,
  noteTodoSnapshot,
  sortNoteTodos,
  toNoteTodoUpdate,
  type NoteTodoPatch,
  type NoteTodoRepository,
  type NoteTodoSnapshot,
} from '../../../../data/repositories/noteTodos';

let sequence = 0;
let clock = Date.parse('2026-10-26T08:00:00.000Z');

function nextId(): string {
  sequence += 1;
  return `note-todo-test-${sequence}`;
}

function stamp(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function makeNoteTodo(
  overrides: Partial<NoteTodo> & Pick<NoteTodo, 'id' | 'noteId' | 'title'>,
): NoteTodo {
  const now = '2026-10-20T00:00:00.000Z';
  return {
    spaceId: 'personal',
    taskId: null,
    done: false,
    dueDate: null,
    reminderEnabled: false,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export type FakeNoteTodoSource = NoteTodoRepository & {
  calls: string[];
  snapshot: (includeDeleted?: boolean) => NoteTodo[];
};

export function createFakeNoteTodoSource(
  seed: NoteTodo[] = [],
): FakeNoteTodoSource {
  let rows = seed.map(clone);
  const calls: string[] = [];

  const store: FakeNoteTodoSource = {
    calls,
    snapshot: (includeDeleted = true) =>
      clone(
        includeDeleted
          ? rows
          : rows.filter((todo) => todo.deletedAt === null),
      ),

    async list(noteId, includeDeleted = false) {
      calls.push('list');
      return clone(
        sortNoteTodos(
          rows.filter(
            (todo) =>
              todo.noteId === noteId &&
              (includeDeleted || todo.deletedAt === null),
          ),
        ),
      );
    },

    async create(input: NewNoteTodo) {
      calls.push('create');
      if (input.id && rows.some((todo) => todo.id === input.id)) {
        throw new Error(`笔记待办 id 已存在：${input.id}`);
      }
      if (!input.noteId) {
        throw new Error('笔记待办缺少笔记');
      }
      const now = stamp();
      const todo: NoteTodo = {
        id: input.id ?? nextId(),
        spaceId: input.spaceId ?? 'personal',
        noteId: input.noteId,
        taskId: input.taskId ?? null,
        title: normalizeNoteTodoTitle(input.title),
        done: input.done ?? false,
        dueDate: input.dueDate ?? null,
        reminderEnabled: input.reminderEnabled ?? false,
        sortOrder: input.sortOrder ?? rows.length,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      };
      rows = [...rows, todo];
      return clone(todo);
    },

    async patch(todo: NoteTodo, patch: NoteTodoPatch) {
      calls.push('update');
      const index = rows.findIndex(
        (item) => item.id === todo.id && item.deletedAt === null,
      );
      if (index < 0) {
        throw new Error(`缺少笔记待办：${todo.id}`);
      }
      const update: NoteTodoUpdate = toNoteTodoUpdate(rows[index], patch);
      rows[index] = {
        ...rows[index],
        ...update,
        updatedAt: stamp(),
        version: rows[index].version + 1,
      };
      return clone(rows[index]);
    },

    async remove(id) {
      calls.push('remove');
      const index = rows.findIndex(
        (item) => item.id === id && item.deletedAt === null,
      );
      if (index < 0) {
        throw new Error(`缺少笔记待办：${id}`);
      }
      rows[index] = {
        ...rows[index],
        deletedAt: stamp(),
        updatedAt: stamp(),
        version: rows[index].version + 1,
      };
    },

    async restore(snapshot: NoteTodoSnapshot) {
      return store.create({
        noteId: snapshot.noteId,
        taskId: snapshot.taskId,
        title: snapshot.title,
        done: snapshot.done,
        dueDate: snapshot.dueDate,
        reminderEnabled: snapshot.reminderEnabled,
        sortOrder: snapshot.sortOrder,
      });
    },
  };

  return store;
}

export { noteTodoSnapshot };
