/**
 * 测试用内存 NoteSource。语义对齐 Rust `repositories::notes`：
 * 软删除、恢复保留原字段、标题非空、查询过滤与置顶优先排序。
 */

import type {
  NewNote,
  Note,
  NoteQuery,
  NoteUpdate,
} from '../../../data/db/types';
import type { NoteSource } from '../../../data/repositories/notes';

let clock = Date.parse('2026-10-26T08:00:00.000Z');

function stamp(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function makeNote(
  overrides: Partial<Note> & Pick<Note, 'id' | 'title'>,
): Note {
  const now = '2026-10-20T00:00:00.000Z';
  return {
    spaceId: 'personal',
    folderId: null,
    tags: [],
    body: '',
    bodyFormat: 'html',
    status: 'active',
    favorite: false,
    pinned: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export type FakeNoteSource = NoteSource & {
  snapshot: () => Note[];
  calls: string[];
};

export function createFakeNoteSource(seed: Note[] = []): FakeNoteSource {
  let notes = seed.map(clone);
  const calls: string[] = [];
  let sequence = 0;

  const nextId = () => {
    sequence += 1;
    return `note-test-${sequence}`;
  };

  const active = (includeDeleted: boolean) =>
    notes.filter((note) => includeDeleted || note.deletedAt === null);

  return {
    calls,
    snapshot: () => clone(notes),
    async list(query: NoteQuery = {}) {
      calls.push('list');
      let rows = active(Boolean(query.includeDeleted));
      if (query.status) {
        rows = rows.filter((note) => note.status === query.status);
      }
      if (typeof query.favorite === 'boolean') {
        rows = rows.filter((note) => note.favorite === query.favorite);
      }
      if (query.folderId) {
        rows = rows.filter((note) => note.folderId === query.folderId);
      }
      if (query.search) {
        const needle = query.search.trim();
        rows = rows.filter(
          (note) =>
            note.title.includes(needle) || note.body.includes(needle),
        );
      }
      return clone(
        rows.slice().sort((a, b) => {
          if (a.pinned !== b.pinned) {
            return a.pinned ? -1 : 1;
          }
          if (a.updatedAt !== b.updatedAt) {
            return a.updatedAt < b.updatedAt ? 1 : -1;
          }
          return a.title.localeCompare(b.title, 'zh-Hans-CN');
        }),
      );
    },
    async create(input: NewNote) {
      calls.push('create');
      const title = input.title.trim();
      if (!title) {
        throw new Error('笔记标题不能为空');
      }
      const now = stamp();
      const note: Note = {
        id: input.id ?? nextId(),
        spaceId: input.spaceId ?? 'personal',
        title,
        folderId: input.folderId ?? null,
        tags: input.tags ?? [],
        body: input.body ?? '',
        bodyFormat: input.bodyFormat ?? 'html',
        status: input.status ?? 'active',
        favorite: input.favorite ?? false,
        pinned: input.pinned ?? false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      };
      notes = [note, ...notes];
      return clone(note);
    },
    async update(id: string, input: NoteUpdate) {
      calls.push('update');
      const title = input.title.trim();
      if (!title) {
        throw new Error('笔记标题不能为空');
      }
      const current = notes.find(
        (note) => note.id === id && note.deletedAt === null,
      );
      if (!current) {
        throw new Error(`笔记不存在：${id}`);
      }
      const updated: Note = {
        ...current,
        title,
        folderId: input.folderId,
        tags: [...input.tags],
        body: input.body,
        bodyFormat: input.bodyFormat,
        favorite: input.favorite,
        pinned: input.pinned,
        updatedAt: stamp(),
        version: current.version + 1,
      };
      notes = notes.map((note) => (note.id === id ? updated : note));
      return clone(updated);
    },
    async remove(id: string) {
      calls.push('remove');
      const now = stamp();
      notes = notes.map((note) =>
        note.id === id
          ? {
              ...note,
              status: 'trashed',
              deletedAt: now,
              updatedAt: now,
              version: note.version + 1,
            }
          : note,
      );
    },
    async restore(id: string) {
      calls.push('restore');
      const current = notes.find((note) => note.id === id);
      if (!current) {
        throw new Error(`笔记不存在：${id}`);
      }
      const restored: Note = {
        ...current,
        status: 'active',
        deletedAt: null,
        updatedAt: stamp(),
        version: current.version + 1,
      };
      notes = notes.map((note) => (note.id === id ? restored : note));
      return clone(restored);
    },
  };
}
