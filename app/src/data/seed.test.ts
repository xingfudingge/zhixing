import { describe, expect, it } from 'vitest';

import { createDbClient, type DbInvoker } from './db/client';
import type { Board, List, Note, Task } from './db/types';
import {
  hasSeedData,
  loadSeedOverview,
  SEED_IDS,
  SEED_MARKER_KEY,
  SEED_VERSION,
} from './seed';

function invokerReturning(
  results: Record<string, unknown>,
): { calls: string[]; invoker: DbInvoker } {
  const calls: string[] = [];
  const invoker = (async (command: string) => {
    calls.push(command);
    return results[command];
  }) as DbInvoker;
  return { calls, invoker };
}

const list = (overrides: Partial<List>): List => ({
  id: 'list',
  spaceId: 'personal',
  name: '清单',
  color: '#5579d5',
  icon: '',
  parentId: null,
  sortOrder: 0,
  isInbox: false,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  deletedAt: null,
  version: 1,
  ...overrides,
});

const task = (overrides: Partial<Task>): Task => ({
  id: 'task',
  spaceId: 'personal',
  listId: 'inbox',
  parentId: null,
  noteId: null,
  title: '任务',
  notes: '',
  status: 'todo',
  priority: 0,
  quadrant: 0,
  dueDate: null,
  dueTime: null,
  dueAt: null,
  tz: 'Asia/Shanghai',
  reminder: '',
  sortOrder: 0,
  completedAt: null,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  deletedAt: null,
  version: 1,
  ...overrides,
});

const note = (overrides: Partial<Note>): Note => ({
  id: 'note',
  spaceId: 'personal',
  title: '笔记',
  folderId: null,
  tags: [],
  body: '',
  bodyFormat: 'html',
  status: 'active',
  favorite: false,
  pinned: false,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  deletedAt: null,
  version: 1,
  ...overrides,
});

const board = (overrides: Partial<Board>): Board => ({
  id: 'board',
  spaceId: 'personal',
  noteId: null,
  title: '画板',
  background: 'dot',
  snapshot: {},
  thumbnailKey: null,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
  deletedAt: null,
  version: 1,
  ...overrides,
});

describe('种子契约', () => {
  it('版本与标记和 Rust 常量一致', () => {
    expect(SEED_VERSION).toBe('0002_domain');
    expect(SEED_MARKER_KEY).toBe('domain_seed');
    expect(SEED_IDS.lists.inbox).toBe('inbox');
    expect(SEED_IDS.notes.welcome).toBe('seed-note-welcome');
  });

  it('loadSeedOverview 只读并行拉取四类实体', async () => {
    const { calls, invoker } = invokerReturning({
      lists_list: [list({ id: SEED_IDS.lists.inbox, isInbox: true })],
      tasks_list: [task({ id: SEED_IDS.tasks.review })],
      notes_list: [note({ id: SEED_IDS.notes.welcome })],
      boards_list: [board({ id: SEED_IDS.board })],
    });
    const client = createDbClient(invoker);

    const overview = await loadSeedOverview(client);

    expect(calls.sort()).toEqual([
      'boards_list',
      'lists_list',
      'notes_list',
      'tasks_list',
    ]);
    expect(overview.lists).toHaveLength(1);
    expect(hasSeedData(overview)).toBe(true);
  });

  it('缺少种子对象时 hasSeedData 为 false', async () => {
    const { invoker } = invokerReturning({
      lists_list: [],
      tasks_list: [],
      notes_list: [],
      boards_list: [],
    });
    const overview = await loadSeedOverview(createDbClient(invoker));

    expect(hasSeedData(overview)).toBe(false);
  });
});
