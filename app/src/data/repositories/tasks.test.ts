import { describe, expect, it } from 'vitest';

import {
  createDbClient,
  type DbInvoker,
} from '../db/client';
import type {
  NewSubtask,
  Subtask,
  SubtaskUpdate,
  Task,
  TaskUpdate,
} from '../db/types';
import {
  createTaskRepository,
  isOpenTask,
  isTaskStatus,
  toTaskUpdate,
} from './tasks';

type Call = { command: string; args?: Record<string, unknown> };

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    spaceId: 'personal',
    listId: 'work',
    parentId: null,
    noteId: 'note-1',
    title: '写方案',
    notes: '先收敛范围',
    status: 'doing',
    priority: 3,
    quadrant: 1,
    dueDate: '2026-10-26',
    dueTime: '10:30',
    dueAt: '2026-10-26T02:30:00.000Z',
    tz: 'Asia/Shanghai',
    reminder: 'before10',
    sortOrder: 7,
    completedAt: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    deletedAt: null,
    version: 3,
    ...overrides,
  };
}

function makeClient(respond: (command: string, args?: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const invoker: DbInvoker = (command, args) => {
    calls.push({ command, args });
    return Promise.resolve(respond(command, args) as never);
  };
  return { client: createDbClient(invoker), calls };
}

describe('toTaskUpdate', () => {
  it('把局部修改补成完整 TaskUpdate，未提到的字段原样保留', () => {
    const task = makeTask();
    const update = toTaskUpdate(task, { dueDate: '2026-10-27' });

    expect(update).toEqual({
      listId: 'work',
      parentId: null,
      noteId: 'note-1',
      title: '写方案',
      notes: '先收敛范围',
      status: 'doing',
      priority: 3,
      quadrant: 1,
      dueDate: '2026-10-27',
      dueTime: '10:30',
      dueAt: '2026-10-26T02:30:00.000Z',
      tz: 'Asia/Shanghai',
      reminder: 'before10',
      sortOrder: 7,
    });
    expect(update).not.toHaveProperty('id');
    expect(update).not.toHaveProperty('completedAt');
    expect(update).not.toHaveProperty('version');
  });

  it('支持把日期清空为 null，且不丢标题与状态', () => {
    const update: TaskUpdate = toTaskUpdate(makeTask(), {
      dueDate: null,
      dueTime: null,
      dueAt: null,
      status: 'todo',
    });
    expect(update.dueDate).toBeNull();
    expect(update.dueTime).toBeNull();
    expect(update.status).toBe('todo');
    expect(update.title).toBe('写方案');
  });
});

describe('createTaskRepository', () => {
  it('list 把查询对象原样传给 tasks_list', async () => {
    const { client, calls } = makeClient(() => [makeTask()]);
    const repository = createTaskRepository(client);

    const rows = await repository.list({
      dueBefore: '2026-10-26',
      status: 'todo',
    });
    expect(rows).toHaveLength(1);
    expect(calls).toEqual([
      {
        command: 'tasks_list',
        args: { query: { dueBefore: '2026-10-26', status: 'todo' } },
      },
    ]);
  });

  it('patch 先补全再调用 tasks_update', async () => {
    const updated = makeTask({ dueDate: '2026-10-27', version: 4 });
    const { client, calls } = makeClient(() => updated);
    const repository = createTaskRepository(client);

    const result = await repository.patch(makeTask(), {
      dueDate: '2026-10-27',
    });

    expect(result).toEqual(updated);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('tasks_update');
    expect(calls[0].args).toEqual({
      id: 'task-1',
      input: toTaskUpdate(makeTask(), { dueDate: '2026-10-27' }),
    });
    const input = calls[0].args?.input as TaskUpdate;
    expect(input.title).toBe('写方案');
    expect(input.notes).toBe('先收敛范围');
  });

  it('complete 透传 done，false 用于撤销', async () => {
    const { client, calls } = makeClient(() =>
      makeTask({ status: 'done', completedAt: '2026-10-26T03:00:00.000Z' }),
    );
    const repository = createTaskRepository(client);

    await repository.complete('task-1', true);
    await repository.complete('task-1', false);

    expect(calls).toEqual([
      { command: 'tasks_complete', args: { id: 'task-1', done: true } },
      { command: 'tasks_complete', args: { id: 'task-1', done: false } },
    ]);
  });

  it('create / get / remove 使用对应 IPC 命令', async () => {
    const created = makeTask();
    const { client, calls } = makeClient((command) => {
      if (command === 'tasks_delete') {
        return undefined;
      }
      return created;
    });
    const repository = createTaskRepository(client);

    await repository.get('task-1');
    await repository.create({
      listId: 'inbox',
      title: '新任务',
      dueDate: null,
    });
    await repository.remove('task-1');

    expect(calls).toEqual([
      { command: 'tasks_get', args: { id: 'task-1' } },
      {
        command: 'tasks_create',
        args: { input: { listId: 'inbox', title: '新任务', dueDate: null } },
      },
      { command: 'tasks_delete', args: { id: 'task-1' } },
    ]);
  });

  it('子任务的列表 / 创建 / 更新 / 删除都走 tasks 仓储下的命令', async () => {
    const subtask: Subtask = {
      id: 'sub-1',
      taskId: 'task-1',
      title: '列出要点',
      done: false,
      sortOrder: 1,
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    };
    const { client, calls } = makeClient((command) =>
      command === 'subtasks_delete' ? undefined : subtask,
    );
    const repository = createTaskRepository(client);

    await repository.subtasks.list('task-1', true);
    const input: NewSubtask = {
      taskId: 'task-1',
      title: '列出要点',
      sortOrder: 1,
    };
    await repository.subtasks.create(input);
    const update: SubtaskUpdate = { title: '列出要点', done: true, sortOrder: 1 };
    await repository.subtasks.update('sub-1', update);
    await repository.subtasks.remove('sub-1');

    expect(calls).toEqual([
      {
        command: 'subtasks_list',
        args: { taskId: 'task-1', includeDeleted: true },
      },
      { command: 'subtasks_create', args: { input } },
      { command: 'subtasks_update', args: { id: 'sub-1', input: update } },
      { command: 'subtasks_delete', args: { id: 'sub-1' } },
    ]);
  });
});

describe('任务状态判断', () => {
  it('isOpenTask 只把 done 视为结束', () => {
    expect(isOpenTask(makeTask({ status: 'todo' }))).toBe(true);
    expect(isOpenTask(makeTask({ status: 'doing' }))).toBe(true);
    expect(isOpenTask(makeTask({ status: 'done' }))).toBe(false);
  });

  it('isTaskStatus 只接受三个合法值', () => {
    expect(isTaskStatus('todo')).toBe(true);
    expect(isTaskStatus('doing')).toBe(true);
    expect(isTaskStatus('done')).toBe(true);
    expect(isTaskStatus('archived')).toBe(false);
  });
});
