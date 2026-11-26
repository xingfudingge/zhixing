import { describe, expect, it } from 'vitest';

import {
  createDefaultReviewSeed,
  makeNote,
  TEST_TODAY,
} from '../../features/review/__tests__/fakeReviewSource';
import type {
  Note,
  ReviewSnapshot,
  SaveReviewInput,
  SavedReview,
} from '../db/types';
import { createDbClient, type DbInvoker } from '../db/client';
import { createReviewRepository } from './review';

type Call = { command: string; args?: Record<string, unknown> };

function makeHarness() {
  const seed = createDefaultReviewSeed();
  const calls: Call[] = [];
  const savedInputs: SaveReviewInput[] = [];
  const snapshot: ReviewSnapshot = {
    id: 'snapshot-1',
    spaceId: 'personal',
    rangeStart: '2026-10-20',
    rangeEnd: '2026-10-26',
    taskIds: ['task-1', 'task-2'],
    focusIds: ['focus-1', 'focus-2'],
    habitIds: ['habit-read'],
    noteId: 'note-1',
    createdAt: '2026-10-26T08:00:00.000Z',
    updatedAt: '2026-10-26T08:00:00.000Z',
    deletedAt: null,
    version: 1,
  };

  const invoker: DbInvoker = async (command, args) => {
    calls.push({ command, args });
    if (command === 'tasks_list') {
      return seed.tasks as never;
    }
    if (command === 'focus_sessions_list') {
      return seed.sessions as never;
    }
    if (command === 'habits_list') {
      return seed.habits as never;
    }
    if (command === 'habit_logs_list') {
      const habitId = args?.habitId as string;
      return (seed.logsByHabit[habitId] ?? []) as never;
    }
    if (command === 'lists_list') {
      return seed.lists as never;
    }
    if (command === 'review_snapshots_get_by_range') {
      return null as never;
    }
    if (command === 'review_snapshots_save') {
      const input = args?.input as SaveReviewInput;
      savedInputs.push(input);
      const note: Note = makeNote({
        id: 'note-1',
        title: input.note.title,
        tags: input.note.tags ?? [],
        body: input.note.body ?? '',
      });
      return { snapshot, note, created: true } as SavedReview as never;
    }
    throw new Error(`unexpected command ${command}`);
  };

  return { seed, calls, savedInputs, snapshot, client: createDbClient(invoker) };
}

describe('createReviewRepository', () => {
  it('按范围读取任务、专注、习惯与打卡，并生成三卡与来源 ID', async () => {
    const { client, calls } = makeHarness();
    const repository = createReviewRepository(client);

    const aggregate = await repository.load({ today: TEST_TODAY });

    expect(calls.map((call) => call.command).sort()).toEqual([
      'focus_sessions_list',
      'habit_logs_list',
      'habits_list',
      'lists_list',
      'tasks_list',
    ]);
    expect(
      calls.find((call) => call.command === 'focus_sessions_list')?.args,
    ).toEqual({ query: { from: '2026-10-20', to: '2026-10-26' } });
    expect(
      calls.find((call) => call.command === 'habit_logs_list')?.args,
    ).toEqual({
      habitId: 'habit-read',
      query: { from: '2026-10-20', to: '2026-10-26' },
    });
    expect(
      calls.find((call) => call.command === 'habits_list')?.args,
    ).toEqual({ query: { includeArchived: true } });

    expect(aggregate.range).toEqual({
      from: '2026-10-20',
      to: '2026-10-26',
    });
    expect(aggregate.totals).toEqual({
      tasks: 2,
      focusMinutes: 30,
      habits: 1,
    });
    expect(aggregate.note.title).toBe('复盘 · 2026-10-26');
    expect(aggregate.sourceIds).toEqual({
      taskIds: ['task-1', 'task-2'],
      focusIds: ['focus-1', 'focus-2'],
      habitIds: ['habit-read'],
    });
  });

  it('保存时把快照来源 ID 与复盘笔记正文一起交给单事务命令', async () => {
    const { client, calls, savedInputs } = makeHarness();
    const repository = createReviewRepository(client);
    const aggregate = await repository.load({ today: TEST_TODAY });
    calls.length = 0;

    const result = await repository.save(aggregate);

    expect(calls.map((call) => call.command)).toEqual([
      'review_snapshots_save',
    ]);
    expect(savedInputs).toHaveLength(1);
    expect(savedInputs[0]).toMatchObject({
      rangeStart: '2026-10-20',
      rangeEnd: '2026-10-26',
      taskIds: ['task-1', 'task-2'],
      focusIds: ['focus-1', 'focus-2'],
      habitIds: ['habit-read'],
      note: {
        title: '复盘 · 2026-10-26',
        folderId: null,
        tags: ['复盘'],
        bodyFormat: 'html',
        status: 'active',
      },
    });
    expect(savedInputs[0].note.body).toContain('data-source-type="task"');
    expect(savedInputs[0].note.body).toContain('data-source-id="focus-1"');
    expect(result.created).toBe(true);
    expect(result.snapshot.noteId).toBe('note-1');
  });

  it('快照查询直接使用范围，不读本地缓存', async () => {
    const { client, calls, snapshot } = makeHarness();
    const repository = createReviewRepository(client);

    await expect(
      repository.snapshot('2026-10-20', '2026-10-26'),
    ).resolves.toBeNull();
    expect(calls).toEqual([
      {
        command: 'review_snapshots_get_by_range',
        args: { from: '2026-10-20', to: '2026-10-26' },
      },
    ]);
    expect(snapshot.id).toBe('snapshot-1');
  });
});
