import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../../../data/db/client';
import type {
  List,
  NewSetting,
  NewTask,
  Setting,
  Task,
} from '../../../data/db/types';
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from '../../../data/repositories/settings';

const lists: List[] = [
  {
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
  },
  {
    id: 'work',
    spaceId: 'personal',
    name: '工作',
    color: '#5579d5',
    icon: 'list',
    parentId: null,
    sortOrder: 1,
    isInbox: false,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  },
  {
    id: 'life',
    spaceId: 'personal',
    name: '生活',
    color: '#d89338',
    icon: 'list',
    parentId: null,
    sortOrder: 2,
    isInbox: false,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  },
];

function settingRow(input: NewSetting): Setting {
  return {
    id: `setting-${input.key}`,
    spaceId: 'personal',
    scope: input.scope ?? 'device',
    key: input.key,
    value: input.value,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  };
}

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
});

afterEach(() => {
  vi.doUnmock('../../../data/db/client');
  vi.resetModules();
  window.localStorage.clear();
});

describe('桌面端启动 hydration', () => {
  it('hydration 完成后仍读取用户刚保存的新默认值', async () => {
    const created: NewTask[] = [];
    const mockDb = {
      settings: {
        list: vi.fn(async () => [] as Setting[]),
        set: vi.fn(async (input: NewSetting) => settingRow(input)),
      },
      lists: {
        list: vi.fn(async () => lists),
      },
      tasks: {
        create: vi.fn(async (input: NewTask) => {
          created.push(input);
          return {
            id: 'task-1',
            spaceId: 'personal',
            parentId: null,
            noteId: null,
            notes: '',
            priority: 0,
            quadrant: 4,
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
            ...input,
          } as Task;
        }),
      },
      notes: {
        create: vi.fn(async () => ({})),
      },
    };

    vi.doMock('../../../data/db/client', () => ({
      db: mockDb,
      isTauriRuntime: () => true,
    }));

    const runtime = await import('../runtime');
    // 让模块加载时发起的 SQLite 读取完成（空库 -> 默认值）。
    await new Promise((resolve) => setTimeout(resolve, 0));

    const changed: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      editor: { ...DEFAULT_APP_SETTINGS.editor, titleMode: 'date' },
      task: { ...DEFAULT_APP_SETTINGS.task, defaultListId: 'life' },
    };
    runtime.setRuntimeSettings(changed);

    const current = await runtime.ensureRuntimeSettings(
      mockDb as unknown as DbClient,
    );
    expect(current.task.defaultListId).toBe('life');

    // 桥接层在任务创建时必须拿到当前新值，而不是启动时的旧 promise 结果。
    await mockDb.tasks.create({
      title: '默认清单测试',
      listId: 'work',
      dueDate: '2026-10-26',
      status: 'todo',
    });
    expect(created[0].listId).toBe('life');
  });
});
