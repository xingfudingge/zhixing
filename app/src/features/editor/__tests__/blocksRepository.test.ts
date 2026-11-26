import { describe, expect, it } from 'vitest';

import { createDbClient } from '../../../data/db/client';
import type {
  NewNoteBlock,
  NoteBlock,
  NoteBlockUpdate,
} from '../../../data/db/types';
import {
  createBlockRepository,
  parseBlockDocument,
} from '../../../data/repositories/blocks';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createMemoryClient() {
  const store = new Map<string, NoteBlock>();
  let clock = Date.parse('2026-10-26T08:00:00.000Z');
  const stamp = () => {
    clock += 1000;
    return new Date(clock).toISOString();
  };

  const invoker = (async (
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    switch (command) {
      case 'note_blocks_list': {
        const noteId = args.noteId as string;
        const includeDeleted = Boolean(args.includeDeleted);
        return clone(
          [...store.values()]
            .filter(
              (block) =>
                block.noteId === noteId &&
                (includeDeleted || block.deletedAt === null),
            )
            .sort((a, b) => {
              if (a.orderKey !== b.orderKey) {
                return a.orderKey - b.orderKey;
              }
              if (a.createdAt !== b.createdAt) {
                return a.createdAt < b.createdAt ? -1 : 1;
              }
              return a.id.localeCompare(b.id);
            }),
        );
      }
      case 'note_blocks_create': {
        const input = args.input as NewNoteBlock;
        const now = stamp();
        const block: NoteBlock = {
          id: input.id ?? `block-${store.size + 1}`,
          noteId: input.noteId,
          blockType: input.blockType,
          orderKey: input.orderKey ?? 0,
          payload: clone(input.payload ?? {}),
          schemaVersion: input.schemaVersion ?? 1,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          version: 1,
        };
        store.set(block.id, block);
        return clone(block);
      }
      case 'note_blocks_update': {
        const id = args.id as string;
        const input = args.input as NoteBlockUpdate;
        const current = store.get(id);
        if (!current || current.deletedAt !== null) {
          throw new Error(`缺少笔记块：${id}`);
        }
        const now = stamp();
        const next: NoteBlock = {
          ...current,
          blockType: input.blockType,
          orderKey: input.orderKey,
          payload: clone(input.payload),
          schemaVersion: input.schemaVersion ?? current.schemaVersion,
          updatedAt: now,
          version: current.version + 1,
        };
        store.set(id, next);
        return clone(next);
      }
      case 'note_blocks_delete': {
        const id = args.id as string;
        const current = store.get(id);
        if (!current || current.deletedAt !== null) {
          throw new Error(`缺少笔记块：${id}`);
        }
        const now = stamp();
        const next: NoteBlock = {
          ...current,
          deletedAt: now,
          updatedAt: now,
          version: current.version + 1,
        };
        store.set(id, next);
        return undefined;
      }
      default:
        throw new Error(`未实现的命令：${command}`);
    }
  }) as unknown as Parameters<typeof createDbClient>[0];

  return { store, client: createDbClient(invoker) };
}

describe('块仓储', () => {
  it('创建、更新、软删除与排序', async () => {
    const { client, store } = createMemoryClient();
    const repository = createBlockRepository(client);

    const first = await repository.create({
      id: 'b1',
      noteId: 'n1',
      blockType: 'paragraph',
      orderKey: 2048,
      payload: { runs: [{ text: '第二' }] },
    });
    expect(first.type).toBe('paragraph');
    expect(first.payload.runs).toEqual([{ text: '第二' }]);

    const second = await repository.create({
      id: 'b2',
      noteId: 'n1',
      blockType: 'heading2',
      orderKey: 1024,
      payload: { runs: [{ text: '第一' }] },
    });
    expect(second.type).toBe('heading2');

    expect((await repository.list('n1')).map((block) => block.id)).toEqual([
      'b2',
      'b1',
    ]);

    await repository.update('b1', {
      blockType: 'todo',
      orderKey: 3072,
      payload: { runs: [{ text: '改了' }], checked: true },
    });
    const updated = await repository.list('n1');
    expect(updated[1].type).toBe('todo');
    expect(updated[1].payload.checked).toBe(true);

    await repository.remove('b1');
    expect((await repository.list('n1')).map((block) => block.id)).toEqual([
      'b2',
    ]);
    expect(store.get('b1')?.deletedAt).not.toBeNull();
  });

  it('saveDocument 按数组顺序重排并删除缺失块，未知类型原样保留', async () => {
    const { client } = createMemoryClient();
    const repository = createBlockRepository(client);

    const saved = await repository.saveDocument('note-1', [
      {
        id: 'p1',
        type: 'paragraph',
        payload: { runs: [{ text: 'A' }] },
      },
      {
        id: 'u1',
        type: 'mindmap_future',
        payload: { unknown: { nested: true }, version: 3 },
      },
      {
        id: 'p2',
        type: 'paragraph',
        payload: { runs: [{ text: 'B' }] },
      },
    ]);
    expect(saved.map((block) => block.id)).toEqual(['p1', 'u1', 'p2']);
    expect(saved.map((block) => block.orderKey)).toEqual([1024, 2048, 3072]);
    expect(saved[1].type).toBe('mindmap_future');
    expect(saved[1].payload).toEqual({ unknown: { nested: true }, version: 3 });

    const reordered = await repository.saveDocument('note-1', [
      { id: 'p2', type: 'paragraph', payload: { runs: [{ text: 'B2' }] } },
      { id: 'p1', type: 'paragraph', payload: { runs: [{ text: 'A' }] } },
    ]);
    expect(reordered.map((block) => block.id)).toEqual(['p2', 'p1']);
    expect(reordered[0].payload.runs).toEqual([{ text: 'B2' }]);
    expect((await repository.list('note-1')).map((block) => block.id)).toEqual([
      'p2',
      'p1',
    ]);
  });

  it('导出 JSON 可回放到另一篇笔记，顺序与内容一致', async () => {
    const { client } = createMemoryClient();
    const repository = createBlockRepository(client);
    await repository.saveDocument('source', [
      { id: 'b3', type: 'paragraph', payload: { runs: [{ text: '第三' }] } },
      { id: 'b1', type: 'heading2', payload: { runs: [{ text: '第一' }] } },
      { id: 'b2', type: 'todo', payload: { runs: [{ text: '第二' }], checked: true } },
    ]);

    const json = await repository.exportDocument('source');
    const document = JSON.parse(json) as {
      version: number;
      blocks: Array<{ id: string; type: string; payload: unknown }>;
    };
    expect(document.version).toBe(1);
    expect(document.blocks.map((block) => block.id)).toEqual(['b3', 'b1', 'b2']);

    await repository.importDocument('target', json);
    const target = await repository.list('target');
    expect(target.map((block) => block.id)).toEqual(['b3', 'b1', 'b2']);
    expect(target.map((block) => block.type)).toEqual([
      'paragraph',
      'heading2',
      'todo',
    ]);
    expect(target[2].payload.checked).toBe(true);
  });

  it('拒绝非法文档：版本、重复 id、缺类型', () => {
    expect(() =>
      parseBlockDocument({ version: 2, blocks: [] }),
    ).toThrow('version=1');
    expect(() =>
      parseBlockDocument({
        version: 1,
        blocks: [
          { id: 'a', type: 'paragraph', payload: {} },
          { id: 'a', type: 'paragraph', payload: {} },
        ],
      }),
    ).toThrow('重复');
    expect(() =>
      parseBlockDocument({
        version: 1,
        blocks: [{ id: 'a', type: '', payload: {} }],
      }),
    ).toThrow('缺少类型');
  });
});
