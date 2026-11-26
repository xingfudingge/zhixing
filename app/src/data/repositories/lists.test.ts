import { describe, expect, it } from 'vitest';

import { createDbClient, type DbInvoker } from '../db/client';
import type { List } from '../db/types';
import {
  INBOX_DELETE_ERROR,
  createListRepository,
} from './lists';

type Call = { command: string; args?: Record<string, unknown> };

function makeList(overrides: Partial<List> = {}): List {
  return {
    id: 'work',
    spaceId: 'personal',
    name: '工作',
    color: '#5579d5',
    icon: 'briefcase',
    parentId: null,
    sortOrder: 10,
    isInbox: false,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    deletedAt: null,
    version: 1,
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

describe('createListRepository', () => {
  it('list 透传 includeDeleted，get 使用清单 id', async () => {
    const { client, calls } = makeClient(() => [makeList()]);
    const repository = createListRepository(client);

    await repository.list(true);
    await repository.get('work');

    expect(calls).toEqual([
      { command: 'lists_list', args: { includeDeleted: true } },
      { command: 'lists_get', args: { id: 'work' } },
    ]);
  });

  it('create / update 直接调用对应命令', async () => {
    const { client, calls } = makeClient(() => makeList());
    const repository = createListRepository(client);

    await repository.create({ name: '学习', color: '#3a9b9a' });
    await repository.update('work', {
      name: '工作',
      color: '#2f9e73',
      sortOrder: 10,
    });

    expect(calls).toEqual([
      {
        command: 'lists_create',
        args: { input: { name: '学习', color: '#3a9b9a' } },
      },
      {
        command: 'lists_update',
        args: {
          id: 'work',
          input: { name: '工作', color: '#2f9e73', sortOrder: 10 },
        },
      },
    ]);
  });

  it('move 只调用 lists_move，明确传递 parentId 与 sortOrder', async () => {
    const { client, calls } = makeClient(() => makeList({ parentId: 'life' }));
    const repository = createListRepository(client);

    const moved = await repository.move('work', {
      parentId: 'life',
      sortOrder: 15,
    });

    expect(moved.parentId).toBe('life');
    expect(calls).toEqual([
      {
        command: 'lists_move',
        args: { id: 'work', input: { parentId: 'life', sortOrder: 15 } },
      },
    ]);
  });

  it('删除普通清单：先确认不是收件箱，再交给 lists_delete 迁移任务', async () => {
    const result = { movedTasks: 2, promotedLists: 1, inboxId: 'inbox' };
    const { client, calls } = makeClient((command) => {
      if (command === 'lists_get') {
        return makeList();
      }
      return result;
    });
    const repository = createListRepository(client);

    const removed = await repository.remove('work');

    expect(removed).toEqual(result);
    expect(calls).toEqual([
      { command: 'lists_get', args: { id: 'work' } },
      { command: 'lists_delete', args: { id: 'work' } },
    ]);
  });

  it('删除收件箱在渲染层直接拒绝，不发出 lists_delete', async () => {
    const { client, calls } = makeClient(() =>
      makeList({ id: 'inbox', name: '收件箱', isInbox: true }),
    );
    const repository = createListRepository(client);

    await expect(repository.remove('inbox')).rejects.toThrow(INBOX_DELETE_ERROR);
    expect(calls).toEqual([{ command: 'lists_get', args: { id: 'inbox' } }]);
    expect(calls.some((call) => call.command === 'lists_delete')).toBe(false);
  });

  it('inbox() 从启用清单中找出系统收件箱，没有时返回 null', async () => {
    const withInbox = makeClient(() => [
      makeList({ id: 'inbox', name: '收件箱', isInbox: true }),
      makeList(),
    ]);
    const repository = createListRepository(withInbox.client);
    await expect(repository.inbox()).resolves.toMatchObject({ id: 'inbox' });
    expect(withInbox.calls).toEqual([
      { command: 'lists_list', args: { includeDeleted: false } },
    ]);

    const empty = makeClient(() => [makeList()]);
    await expect(createListRepository(empty.client).inbox()).resolves.toBeNull();
  });
});
