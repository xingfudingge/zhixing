import { describe, expect, it } from 'vitest';

import { createDbClient, type DbInvoker } from '../db/client';
import type { List } from '../db/types';
import { createRepositories } from './index';

type Call = { command: string; args?: Record<string, unknown> };

function invokerReturning(
  results: Record<string, unknown>,
): { calls: Call[]; invoker: DbInvoker } {
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

const inbox: List = {
  id: 'inbox',
  spaceId: 'personal',
  name: '收件箱',
  color: '#8b96a3',
  icon: 'inbox',
  parentId: null,
  sortOrder: 0,
  isInbox: true,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  deletedAt: null,
  version: 1,
};

describe('仓储门面', () => {
  it('lists.inbox 从清单列表中找到 isInbox 清单', async () => {
    const { calls, invoker } = invokerReturning({
      lists_list: [inbox],
    });
    const repositories = createRepositories(createDbClient(invoker));

    const result = await repositories.lists.inbox();

    expect(result).toEqual(inbox);
    expect(calls).toEqual([
      { command: 'lists_list', args: { includeDeleted: false } },
    ]);
  });

  it('没有收件箱时返回 null，而不是编造数据', async () => {
    const { invoker } = invokerReturning({ lists_list: [] });
    const repositories = createRepositories(createDbClient(invoker));

    await expect(repositories.lists.inbox()).resolves.toBeNull();
  });

  it('各领域委托给同一客户端，命令可追踪', async () => {
    const { calls, invoker } = invokerReturning({
      tasks_list: [],
      notes_list: [],
      habits_list: [],
      boards_list: [],
    });
    const repositories = createRepositories(createDbClient(invoker));

    await repositories.tasks.list({ inbox: true });
    await repositories.notes.list({ folderId: 'f1' });
    await repositories.habits.list({ includeArchived: true });
    await repositories.boards.list({ noteId: 'n1' });

    expect(calls.map((call) => call.command)).toEqual([
      'tasks_list',
      'notes_list',
      'habits_list',
      'boards_list',
    ]);
  });
});
