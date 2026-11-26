import { describe, expect, it } from 'vitest';

import { createDbClient, type DbInvoker } from '../db/client';
import type { Habit, HabitLog, HabitUpdate } from '../db/types';
import {
  FUTURE_DATE_MESSAGE,
  assertCheckableDate,
  createHabitRepository,
  toHabitUpdate,
} from './habits';

type Call = { command: string; args?: Record<string, unknown> };

function makeHabit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: 'habit-read',
    spaceId: 'personal',
    title: '阅读 30 分钟',
    schedule: '每天 · 睡前',
    icon: '▤',
    color: 'violet',
    goalPerWeek: 7,
    sortOrder: 1,
    archived: false,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function makeLog(overrides: Partial<HabitLog> = {}): HabitLog {
  return {
    id: 'log-1',
    spaceId: 'personal',
    habitId: 'habit-read',
    logDate: '2026-10-26',
    done: true,
    note: '',
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function makeClient(
  respond: (command: string, args?: Record<string, unknown>) => unknown,
) {
  const calls: Call[] = [];
  const invoker: DbInvoker = (command, args) => {
    calls.push({ command, args });
    return Promise.resolve(respond(command, args) as never);
  };
  return { client: createDbClient(invoker), calls };
}

describe('toHabitUpdate', () => {
  it('把局部修改补成完整 HabitUpdate，未提到的字段原样保留', () => {
    const update = toHabitUpdate(makeHabit(), { title: '阅读 45 分钟' });

    expect(update).toEqual({
      title: '阅读 45 分钟',
      schedule: '每天 · 睡前',
      icon: '▤',
      color: 'violet',
      goalPerWeek: 7,
      sortOrder: 1,
      archived: false,
    });
    expect(update).not.toHaveProperty('id');
    expect(update).not.toHaveProperty('version');
  });
});

describe('assertCheckableDate', () => {
  it('今天和过去可打卡，未来被拒绝', () => {
    expect(() => assertCheckableDate('2026-10-26', '2026-10-26')).not.toThrow();
    expect(() => assertCheckableDate('2026-10-01', '2026-10-26')).not.toThrow();
    expect(() => assertCheckableDate('2026-10-27', '2026-10-26')).toThrow(
      FUTURE_DATE_MESSAGE,
    );
  });

  it('拒绝非法日期格式', () => {
    expect(() => assertCheckableDate('2026/10/26', '2026-10-26')).toThrow(
      '打卡日期格式不正确',
    );
  });
});

describe('createHabitRepository', () => {
  it('list / create / patch 走对应 IPC 命令', async () => {
    const updated = makeHabit({ title: '阅读 45 分钟', version: 2 });
    const { client, calls } = makeClient((command) => {
      if (command === 'habits_list') {
        return [makeHabit()];
      }
      if (command === 'habits_create') {
        return makeHabit();
      }
      return updated;
    });
    const repository = createHabitRepository(client, {
      today: () => '2026-10-26',
    });

    await repository.list({ includeArchived: true });
    await repository.create({ title: '阅读 30 分钟', color: 'violet' });
    await repository.patch(makeHabit(), { title: '阅读 45 分钟' });

    expect(calls).toEqual([
      {
        command: 'habits_list',
        args: { query: { includeArchived: true } },
      },
      {
        command: 'habits_create',
        args: { input: { title: '阅读 30 分钟', color: 'violet' } },
      },
      {
        command: 'habits_update',
        args: {
          id: 'habit-read',
          input: {
            title: '阅读 45 分钟',
            schedule: '每天 · 睡前',
            icon: '▤',
            color: 'violet',
            goalPerWeek: 7,
            sortOrder: 1,
            archived: false,
          } satisfies HabitUpdate,
        },
      },
    ]);
  });

  it('未来日期在渲染层直接拒绝，不发出 habit_logs_set', async () => {
    const { client, calls } = makeClient(() => makeLog());
    const repository = createHabitRepository(client, {
      today: () => '2026-10-26',
    });

    await expect(
      repository.logs.set('habit-read', '2026-10-27'),
    ).rejects.toThrow(FUTURE_DATE_MESSAGE);
    expect(calls).toEqual([]);
  });

  it('今天打卡透传日期与备注', async () => {
    const { client, calls } = makeClient(() => makeLog());
    const repository = createHabitRepository(client, {
      today: () => '2026-10-26',
    });

    await repository.logs.set('habit-read', '2026-10-26', '第二章');

    expect(calls).toEqual([
      {
        command: 'habit_logs_set',
        args: {
          habitId: 'habit-read',
          date: '2026-10-26',
          note: '第二章',
        },
      },
    ]);
  });

  it('删除习惯先逐条删除活动日志，再删除习惯', async () => {
    const logs = [
      makeLog({ id: 'log-1', logDate: '2026-10-24' }),
      makeLog({ id: 'log-2', logDate: '2026-10-25' }),
    ];
    const { client, calls } = makeClient((command) => {
      if (command === 'habit_logs_list') {
        return logs;
      }
      return undefined;
    });
    const repository = createHabitRepository(client, {
      today: () => '2026-10-26',
    });

    await repository.remove('habit-read');

    expect(calls).toEqual([
      {
        command: 'habit_logs_list',
        args: { habitId: 'habit-read', query: {} },
      },
      {
        command: 'habit_logs_delete',
        args: { habitId: 'habit-read', date: '2026-10-24' },
      },
      {
        command: 'habit_logs_delete',
        args: { habitId: 'habit-read', date: '2026-10-25' },
      },
      { command: 'habits_delete', args: { id: 'habit-read' } },
    ]);
    expect(
      calls.findIndex((call) => call.command === 'habits_delete'),
    ).toBe(calls.length - 1);
  });
});
