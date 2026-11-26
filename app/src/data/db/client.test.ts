import { describe, expect, it } from 'vitest';

import {
  createDbClient,
  DbUnavailableError,
  type DbInvoker,
} from './client';

type Call = { command: string; args?: Record<string, unknown> };

function recordingInvoker(results: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const invoker = (async (
    command: string,
    args?: Record<string, unknown>,
  ) => {
    calls.push({ command, args });
    return results[command];
  }) as DbInvoker;
  return { calls, invoker };
}

describe('SQLite 客户端命令映射', () => {
  it('清单 CRUD 使用与 Rust 命令一致的名称和参数', async () => {
    const { calls, invoker } = recordingInvoker();
    const client = createDbClient(invoker);

    await client.lists.list();
    await client.lists.get('inbox');
    await client.lists.create({ name: '工作' });
    await client.lists.update('work', {
      name: '工作',
      color: '#5579d5',
      sortOrder: 1,
    });
    await client.lists.move('reading', { parentId: 'life', sortOrder: 15 });
    await client.lists.remove('life');

    expect(calls).toEqual([
      { command: 'lists_list', args: { includeDeleted: false } },
      { command: 'lists_get', args: { id: 'inbox' } },
      { command: 'lists_create', args: { input: { name: '工作' } } },
      {
        command: 'lists_update',
        args: {
          id: 'work',
          input: {
            name: '工作',
            color: '#5579d5',
            sortOrder: 1,
          },
        },
      },
      {
        command: 'lists_move',
        args: { id: 'reading', input: { parentId: 'life', sortOrder: 15 } },
      },
      { command: 'lists_delete', args: { id: 'life' } },
    ]);
  });

  it('任务、子任务与完成动作参数正确', async () => {
    const { calls, invoker } = recordingInvoker();
    const client = createDbClient(invoker);

    await client.tasks.list({ inbox: true, dueBefore: '2026-10-31' });
    await client.tasks.complete('t1', true);
    await client.tasks.restore('t1');
    await client.tasks.subtasks.list('t1', true);
    await client.tasks.subtasks.update('s1', {
      title: '拆分',
      done: true,
      sortOrder: 2,
    });

    expect(calls).toEqual([
      {
        command: 'tasks_list',
        args: { query: { inbox: true, dueBefore: '2026-10-31' } },
      },
      { command: 'tasks_complete', args: { id: 't1', done: true } },
      { command: 'tasks_restore', args: { id: 't1' } },
      {
        command: 'subtasks_list',
        args: { taskId: 't1', includeDeleted: true },
      },
      {
        command: 'subtasks_update',
        args: {
          id: 's1',
          input: { title: '拆分', done: true, sortOrder: 2 },
        },
      },
    ]);
  });

  it('笔记、块投影与笔记待办参数正确', async () => {
    const { calls, invoker } = recordingInvoker();
    const client = createDbClient(invoker);

    await client.notes.list({ folderId: 'f1', includeDeleted: true });
    await client.notes.blocks.list('n1');
    await client.notes.blocks.create({
      noteId: 'n1',
      blockType: 'paragraph',
      payload: { text: '正文' },
    });
    await client.noteTodos.list('n1');
    await client.noteTodos.update('nt1', {
      taskId: null,
      title: '待办',
      done: true,
      dueDate: null,
      reminderEnabled: false,
      sortOrder: 0,
    });

    expect(calls.map((call) => call.command)).toEqual([
      'notes_list',
      'note_blocks_list',
      'note_blocks_create',
      'note_todos_list',
      'note_todos_update',
    ]);
    expect(calls[1].args).toEqual({
      noteId: 'n1',
      includeDeleted: false,
    });
    expect(calls[4].args).toEqual({
      id: 'nt1',
      input: {
        taskId: null,
        title: '待办',
        done: true,
        dueDate: null,
        reminderEnabled: false,
        sortOrder: 0,
      },
    });
  });

  it('事件、倒数日、习惯打卡与专注命令参数正确', async () => {
    const { calls, invoker } = recordingInvoker();
    const client = createDbClient(invoker);

    await client.events.list({ from: '2026-10-01', to: '2026-10-31' });
    await client.countdowns.list({ category: '热门节日' });
    await client.habits.logs.set('h1', '2026-10-26', '第二章');
    await client.habits.logs.remove('h1', '2026-10-26');
    await client.focusSessions.create({
      taskId: 't1',
      minutes: 25,
      startedAt: '2026-10-26T09:00:00Z',
    });

    expect(calls.map((call) => call.command)).toEqual([
      'events_list',
      'countdowns_list',
      'habit_logs_set',
      'habit_logs_delete',
      'focus_sessions_create',
    ]);
    expect(calls[2].args).toEqual({
      habitId: 'h1',
      date: '2026-10-26',
      note: '第二章',
    });
    expect(calls[3].args).toEqual({
      habitId: 'h1',
      date: '2026-10-26',
    });
  });

  it('画板节点、连线、附件与设置命令参数正确', async () => {
    const { calls, invoker } = recordingInvoker();
    const client = createDbClient(invoker);

    await client.boards.nodes.list('b1');
    await client.boards.edges.create({
      boardId: 'b1',
      fromNodeId: 'n1',
      toNodeId: 'n2',
    });
    await client.attachments.list({ noteId: 'note-1' });
    await client.settings.get('space', 'task.defaults');
    await client.settings.set({
      scope: 'device',
      key: 'appearance.theme',
      value: 'dark',
    });

    expect(calls.map((call) => call.command)).toEqual([
      'board_nodes_list',
      'board_edges_create',
      'attachments_list',
      'settings_get',
      'settings_set',
    ]);
    expect(calls[0].args).toEqual({
      boardId: 'b1',
      includeDeleted: false,
    });
    expect(calls[3].args).toEqual({
      scope: 'space',
      key: 'task.defaults',
    });
    expect(calls[4].args).toEqual({
      input: {
        scope: 'device',
        key: 'appearance.theme',
        value: 'dark',
      },
    });
  });

  it('浏览器预览下默认客户端拒绝调用，不产生虚假成功', async () => {
    const client = createDbClient();
    await expect(client.lists.list()).rejects.toBeInstanceOf(
      DbUnavailableError,
    );
  });

  it('system 状态与迁移命令可调用', async () => {
    const { calls, invoker } = recordingInvoker({
      db_status: { ready: true, schemaVersion: 2 },
      db_migrate: { ready: true, schemaVersion: 2 },
    });
    const client = createDbClient(invoker);

    const status = await client.system.status();
    const migrated = await client.system.migrate();

    expect(status.schemaVersion).toBe(2);
    expect(migrated.ready).toBe(true);
    expect(calls.map((call) => call.command)).toEqual([
      'db_status',
      'db_migrate',
    ]);
  });
});
