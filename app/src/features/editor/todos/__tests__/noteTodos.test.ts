import { describe, expect, it } from 'vitest';

import { createDbClient, type DbInvoker } from '../../../../data/db/client';
import type { NoteTodo } from '../../../../data/db/types';
import {
  createNoteTodoRepository,
  normalizeNoteTodoTitle,
  noteTodoSnapshot,
  noteTodoSummary,
  sortNoteTodos,
  toNoteTodoUpdate,
} from '../../../../data/repositories/noteTodos';

function makeTodo(overrides: Partial<NoteTodo>): NoteTodo {
  return {
    id: 'todo-1',
    spaceId: 'personal',
    noteId: 'note-1',
    taskId: null,
    title: '待办',
    done: false,
    dueDate: null,
    reminderEnabled: false,
    sortOrder: 0,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

describe('noteTodos 领域辅助', () => {
  it('标题归一：折叠空白，空标题回退兜底文案', () => {
    expect(normalizeNoteTodoTitle('  写   验收  ')).toBe('写 验收');
    expect(normalizeNoteTodoTitle('   ')).toBe('待办事项');
  });

  it('局部更新保留未修改的 taskId/日期/提醒/排序', () => {
    const todo = makeTodo({
      taskId: 'task-1',
      dueDate: '2026-10-30',
      reminderEnabled: true,
      sortOrder: 3,
    });
    const update = toNoteTodoUpdate(todo, { done: true });
    expect(update).toMatchObject({
      taskId: 'task-1',
      title: '待办',
      done: true,
      dueDate: '2026-10-30',
      reminderEnabled: true,
      sortOrder: 3,
    });

    expect(toNoteTodoUpdate(todo, { taskId: null }).taskId).toBeNull();
  });

  it('汇总只统计 note_todos，自成一派', () => {
    const todos = [
      makeTodo({ id: 'a', done: true }),
      makeTodo({ id: 'b', done: false }),
      makeTodo({ id: 'c', done: false }),
    ];
    expect(noteTodoSummary(todos)).toEqual({ total: 3, done: 1, pending: 2 });
    expect(sortNoteTodos([...todos].reverse()).map((todo) => todo.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('快照包含恢复所需的关联字段', () => {
    const todo = makeTodo({
      taskId: 'task-9',
      done: true,
      dueDate: '2026-11-01',
      reminderEnabled: true,
      sortOrder: 7,
    });
    expect(noteTodoSnapshot(todo)).toEqual({
      noteId: 'note-1',
      taskId: 'task-9',
      title: '待办',
      done: true,
      dueDate: '2026-11-01',
      reminderEnabled: true,
      sortOrder: 7,
    });
  });
});

describe('createNoteTodoRepository · IPC 命令映射', () => {
  it('读取、创建、局部更新、删除与恢复都走对应命令', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const row = makeTodo({
      id: 'todo-a',
      taskId: 'task-1',
      title: '写验收清单',
      done: true,
      sortOrder: 2,
    });
    const invoker = (async (
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args });
      if (command === 'note_todos_list') {
        return [row];
      }
      if (command === 'note_todos_create') {
        const input = args?.input as { title: string };
        return { ...row, id: 'todo-new', title: input.title };
      }
      if (command === 'note_todos_update') {
        return row;
      }
      return undefined;
    }) as DbInvoker;

    const repository = createNoteTodoRepository(createDbClient(invoker));

    await repository.list('note-1');
    await repository.create({ noteId: 'note-1', title: '  新   待办 ' });
    await repository.patch(row, { done: false });
    await repository.remove('todo-a');
    await repository.restore({
      noteId: 'note-1',
      taskId: 'task-1',
      title: '恢复的待办',
      done: true,
      dueDate: null,
      reminderEnabled: false,
      sortOrder: 2,
    });

    expect(calls.map((call) => call.command)).toEqual([
      'note_todos_list',
      'note_todos_create',
      'note_todos_update',
      'note_todos_delete',
      'note_todos_create',
    ]);
    expect(calls[1].args?.input).toMatchObject({ title: '新 待办' });
    expect(calls[2].args).toMatchObject({
      id: 'todo-a',
      input: {
        taskId: 'task-1',
        title: '写验收清单',
        done: false,
        sortOrder: 2,
      },
    });
    // 恢复不带原 id，避免和软删除墓碑主键冲突。
    expect((calls[4].args?.input as { id?: string }).id).toBeUndefined();
  });
});
