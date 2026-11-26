/**
 * 测试用内存 BlockRepository：语义对齐 `createBlockRepository` + Rust 仓储。
 * 软删除、order_key 排序、整篇 saveDocument 的增删改都覆盖。
 */

import type {
  NewNoteBlock,
  NoteBlockUpdate,
} from '../../../data/db/types';
import type {
  BlockDocument,
  BlockDraft,
  BlockRepository,
  EditorBlock,
} from '../../../data/repositories/blocks';
import { parseBlockDocument } from '../../../data/repositories/blocks';

const NOTE_ID = 'note-editor';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `block-test-${sequence}`;
}

export function makeBlock(
  overrides: Partial<EditorBlock> & Pick<EditorBlock, 'id' | 'type'>,
): EditorBlock {
  const { payload, ...rest } = overrides;
  return {
    noteId: NOTE_ID,
    orderKey: 1024,
    schemaVersion: 1,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...rest,
    payload: clone(payload ?? {}) as EditorBlock['payload'],
  };
}

export type FakeBlockSource = BlockRepository & {
  snapshot: (includeDeleted?: boolean, noteId?: string) => EditorBlock[];
  calls: string[];
};

export function createFakeBlockSource(
  seed: EditorBlock[] = [],
): FakeBlockSource {
  let blocks = seed.map(clone);
  let clock = Date.parse('2026-10-26T08:00:00.000Z');
  const calls: string[] = [];

  const stamp = () => {
    clock += 1000;
    return new Date(clock).toISOString();
  };

  const listBlocks = (noteId: string, includeDeleted = false) =>
    clone(
      blocks
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

  const repository: FakeBlockSource = {
    calls,
    snapshot: (includeDeleted = false, noteId = NOTE_ID) =>
      listBlocks(noteId, includeDeleted),

    async list(noteId, includeDeleted = false) {
      calls.push('list');
      return listBlocks(noteId, includeDeleted);
    },

    async create(input: NewNoteBlock) {
      calls.push('create');
      const now = stamp();
      const block: EditorBlock = {
        id: input.id ?? nextId(),
        noteId: input.noteId,
        type: input.blockType,
        orderKey: input.orderKey ?? 0,
        payload: clone(
          (input.payload as Record<string, unknown> | undefined) ?? {},
        ) as EditorBlock['payload'],
        schemaVersion: input.schemaVersion ?? 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      };
      blocks.push(block);
      return clone(block);
    },

    async update(id: string, input: NoteBlockUpdate) {
      calls.push('update');
      const index = blocks.findIndex(
        (block) => block.id === id && block.deletedAt === null,
      );
      if (index < 0) {
        throw new Error(`缺少笔记块：${id}`);
      }
      const now = stamp();
      blocks[index] = {
        ...blocks[index],
        type: input.blockType,
        orderKey: input.orderKey,
        payload: clone(
          (input.payload as Record<string, unknown> | undefined) ?? {},
        ) as EditorBlock['payload'],
        schemaVersion: input.schemaVersion ?? blocks[index].schemaVersion,
        updatedAt: now,
        version: blocks[index].version + 1,
      };
      return clone(blocks[index]);
    },

    async remove(id: string) {
      calls.push('remove');
      const index = blocks.findIndex(
        (block) => block.id === id && block.deletedAt === null,
      );
      if (index < 0) {
        throw new Error(`缺少笔记块：${id}`);
      }
      const now = stamp();
      blocks[index] = {
        ...blocks[index],
        deletedAt: now,
        updatedAt: now,
        version: blocks[index].version + 1,
      };
    },

    async loadDocument(noteId: string): Promise<BlockDocument> {
      calls.push('loadDocument');
      const rows = listBlocks(noteId);
      return {
        version: 1,
        noteId,
        blocks: rows.map((block) => ({
          id: block.id,
          type: block.type,
          orderKey: block.orderKey,
          schemaVersion: block.schemaVersion,
          payload: block.payload,
        })),
      };
    },

    async saveDocument(noteId: string, drafts: ReadonlyArray<BlockDraft>) {
      calls.push('saveDocument');
      const existing = blocks.filter(
        (block) => block.noteId === noteId && block.deletedAt === null,
      );
      const kept = new Set<string>();
      for (let index = 0; index < drafts.length; index += 1) {
        const draft = drafts[index];
        const orderKey = (index + 1) * 1024;
        const current = existing.find((block) => block.id === draft.id);
        kept.add(draft.id);
        if (!current) {
          const now = stamp();
          // 撤销删除会用同一个 id 还原软删除块。真实仓储的 create 不接受
          // 重复主键，因此假仓储这里按 id 复活原行，而不是再插入一条重复行。
          const tombstoneIndex = blocks.findIndex(
            (block) => block.id === draft.id && block.noteId === noteId,
          );
          if (tombstoneIndex >= 0) {
            blocks[tombstoneIndex] = {
              ...blocks[tombstoneIndex],
              type: draft.type,
              orderKey,
              payload: clone(draft.payload),
              schemaVersion:
                draft.schemaVersion ?? blocks[tombstoneIndex].schemaVersion,
              deletedAt: null,
              updatedAt: now,
              version: blocks[tombstoneIndex].version + 1,
            };
          } else {
            blocks.push({
              id: draft.id,
              noteId,
              type: draft.type,
              orderKey,
              payload: clone(draft.payload),
              schemaVersion: draft.schemaVersion ?? 1,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
              version: 1,
            });
          }
          continue;
        }
        const changed =
          current.type !== draft.type ||
          current.orderKey !== orderKey ||
          JSON.stringify(current.payload) !== JSON.stringify(draft.payload);
        if (changed) {
          const now = stamp();
          const indexInAll = blocks.findIndex(
            (block) => block.id === current.id,
          );
          blocks[indexInAll] = {
            ...blocks[indexInAll],
            type: draft.type,
            orderKey,
            payload: clone(draft.payload),
            updatedAt: now,
            version: blocks[indexInAll].version + 1,
          };
        }
      }
      for (const block of existing) {
        if (!kept.has(block.id)) {
          const indexInAll = blocks.findIndex(
            (item) => item.id === block.id,
          );
          const now = stamp();
          blocks[indexInAll] = {
            ...blocks[indexInAll],
            deletedAt: now,
            updatedAt: now,
            version: blocks[indexInAll].version + 1,
          };
        }
      }
      return listBlocks(noteId);
    },

    async exportDocument(noteId: string) {
      calls.push('exportDocument');
      return JSON.stringify(await repository.loadDocument(noteId), null, 2);
    },

    async importDocument(noteId: string, json: string) {
      calls.push('importDocument');
      const parsed = parseBlockDocument(json);
      return repository.saveDocument(
        noteId,
        parsed.map((block) => ({
          id: block.id,
          type: block.type,
          payload: block.payload,
          schemaVersion: block.schemaVersion,
        })),
      );
    },
  };

  return repository;
}

export const FAKE_NOTE_ID = NOTE_ID;
