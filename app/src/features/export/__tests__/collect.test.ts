import { describe, expect, it } from 'vitest';

import { createDbClient, type DbInvoker } from '../../../data/db/client';
import type { DbStatus } from '../../../data/db/types';
import { MemoryBlobStore } from '../../attachments/blobStore';
import { bytesKey } from '../../attachments/types';
import { createDbBackupSource } from '../collect';
import {
  ATTACHMENT_SHA,
  ATTACHMENT_TEXT,
  makeDataset,
} from './testFixtures';

function fakeInvoker(dataset = makeDataset()) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoker: DbInvoker = async <T,>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    calls.push({ command, args });
    const result = (() => {
      switch (command) {
        case 'db_status':
          return {
            path: '/tmp/zhixing.db',
            ready: true,
            schemaVersion: 3,
            journalMode: 'wal',
            foreignKeys: true,
            applied: ['1', '2', '3'],
            error: null,
          } satisfies DbStatus;
        case 'lists_list':
          return dataset.lists;
        case 'tasks_list':
          return dataset.tasks;
        case 'subtasks_list':
          return dataset.subtasks.filter((row) => row.taskId === args?.taskId);
        case 'notes_list':
        case 'notes_export_rows':
          return dataset.notes;
        case 'note_blocks_export_rows':
          return dataset.noteBlocks;
        case 'note_todos_export_rows':
          return dataset.noteTodos;
        case 'note_blocks_list':
          return dataset.noteBlocks.filter((row) => row.noteId === args?.noteId);
        case 'note_todos_list':
          return dataset.noteTodos.filter((row) => row.noteId === args?.noteId);
        case 'events_list':
          return dataset.events;
        case 'countdowns_list':
          return dataset.countdowns;
        case 'habits_list':
          return dataset.habits;
        case 'habit_logs_list':
          return dataset.habitLogs.filter((row) => row.habitId === args?.habitId);
        case 'focus_sessions_list':
          return dataset.focusSessions;
        case 'review_snapshots_list':
          return dataset.reviewSnapshots;
        case 'attachments_list':
          return dataset.attachments;
        case 'settings_list':
          return [
            ...dataset.settings,
            {
              id: 'setting-secret',
              spaceId: 'personal',
              scope: 'device',
              key: 'sync.token',
              value: 'super-secret',
              createdAt: '',
              updatedAt: '',
              deletedAt: null,
              version: 1,
            },
          ];
        case 'boards_list':
          return dataset.boards.map((board) => board.board);
        case 'board_nodes_list':
          return dataset.boards
            .find((board) => board.board.id === args?.boardId)!
            .nodes;
        case 'board_edges_list':
          return dataset.boards
            .find((board) => board.board.id === args?.boardId)!
            .edges;
        default:
          throw new Error(`未实现的命令 ${command}`);
      }
    })();
    return result as T;
  };
  return { invoker, calls };
}

describe('从 SQLite 收集完整备份', () => {
  it('包含回收站行、画板子表与白名单附件；过滤秘密设置', async () => {
    const { invoker, calls } = fakeInvoker();
    const client = createDbClient(invoker);
    const store = new MemoryBlobStore();
    await store.put(
      bytesKey(ATTACHMENT_SHA),
      new Blob([ATTACHMENT_TEXT], { type: 'text/plain' }),
    );
    const source = createDbBackupSource(
      client,
      store,
      () => new Date('2026-10-26T12:00:00.000Z'),
    );
    const result = await source.collect({ includeBlobs: true });

    expect(result.payload.dataset.tasks.map((task) => task.id)).toContain(
      'task-deleted',
    );
    expect(result.payload.dataset.notes.map((note) => note.id)).toContain(
      'note-deleted',
    );
    expect(result.payload.dataset.boards[0]!.nodes).toHaveLength(2);
    expect(result.payload.dataset.boards[0]!.edges).toHaveLength(1);
    expect(result.payload.dataset.settings.map((row) => row.key)).toEqual([
      'editor.fontSize',
    ]);
    expect(result.payload.excludedSettings).toEqual(['sync.token']);
    expect(result.blobs.get('attachment-a')?.size).toBe(ATTACHMENT_TEXT.length);
    expect(result.missingAttachmentIds).toHaveLength(0);
    expect(result.payload.schemaVersion).toBe(3);

    const businessListCalls = calls.filter((call) =>
      [
        'lists_list',
        'tasks_list',
        'notes_list',
        'events_list',
        'countdowns_list',
        'habits_list',
        'focus_sessions_list',
        'review_snapshots_list',
        'attachments_list',
      ].includes(call.command),
    );
    for (const call of businessListCalls) {
      const query = call.args?.query as
        | { includeDeleted?: boolean }
        | undefined;
      const includeDeleted = call.args?.includeDeleted ?? query?.includeDeleted;
      expect(includeDeleted).toBe(true);
    }
  });

  it('附件二进制损坏时拒绝导出并给出警告', async () => {
    const { invoker } = fakeInvoker();
    const client = createDbClient(invoker);
    const store = new MemoryBlobStore();
    await store.put(
      bytesKey(ATTACHMENT_SHA),
      new Blob(['wrong bytes'], { type: 'text/plain' }),
    );
    const source = createDbBackupSource(client, store);
    const result = await source.collect({ includeBlobs: true });
    expect(result.blobs.size).toBe(0);
    expect(result.missingAttachmentIds).toEqual(['attachment-a']);
    expect(result.warnings.join(' ')).toContain('大小');
  });

  it('JSON 导出可跳过读取附件二进制', async () => {
    const { invoker } = fakeInvoker();
    const source = createDbBackupSource(createDbClient(invoker), new MemoryBlobStore());
    const result = await source.collect({ includeBlobs: false });
    expect(result.blobs.size).toBe(0);
    expect(result.warnings.join(' ')).toContain('sync.token');
  });

  it('加密笔记备份保留密文与旁路标签，不伪造明文', async () => {
    const dataset = makeDataset();
    const target = dataset.notes[0]!;
    dataset.notes[0] = {
      ...target,
      encrypted: true,
      locked: true,
      title: 'zxnote:v1:abcdef0123456789:title',
      body: 'zxnote:v1:abcdef0123456789:body',
      tags: [],
      encryptedTagsJson: 'zxnote:v1:abcdef0123456789:tags',
    };
    const { invoker, calls } = fakeInvoker(dataset);
    const source = createDbBackupSource(
      createDbClient(invoker),
      new MemoryBlobStore(),
    );
    const result = await source.collect({ includeBlobs: false });

    const note = result.payload.dataset.notes.find(
      (item) => item.id === target.id,
    )!;
    expect(note.title).toBe('zxnote:v1:abcdef0123456789:title');
    expect(note.body).toBe('zxnote:v1:abcdef0123456789:body');
    expect(note.encryptedTagsJson).toBe('zxnote:v1:abcdef0123456789:tags');
    expect(note.locked).toBe(true);
    expect(calls.some((call) => call.command === 'notes_export_rows')).toBe(
      true,
    );
    expect(result.warnings.join(' ')).toContain('加密笔记的密文');
  });
});
