/**
 * 快速创建测试夹具：内存清单 / 笔记 + 捕获创建输入。
 */

import type {
  List,
  NewNote,
  NewTask,
  Note,
  Task,
} from '../../../data/db/types';
import {
  makeList,
  makeNote,
} from '../../search/__tests__/fixtures';
import type { QuickAddSource } from '../source';

export type FakeQuickAddSource = QuickAddSource & {
  snapshot: () => {
    tasks: NewTask[];
    notes: NewNote[];
    lists: List[];
    recentNotes: Note[];
  };
  createTaskCalls: () => number;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createFakeQuickAddSource(seed?: {
  lists?: List[];
  notes?: Note[];
}): FakeQuickAddSource {
  const lists = seed?.lists ?? [
    makeList({ id: 'inbox', name: '收件箱', isInbox: true, sortOrder: 0 }),
    makeList({ id: 'work', name: '工作', sortOrder: 10 }),
    makeList({ id: 'life', name: '生活', sortOrder: 20 }),
  ];
  const recentNotes = seed?.notes ?? [
    makeNote({ id: 'note-1', title: '现有笔记', folderId: 'f1' }),
  ];
  const tasks: NewTask[] = [];
  const notes: NewNote[] = [];
  let sequence = 0;
  let taskCalls = 0;

  return {
    async lists() {
      return clone(lists);
    },
    async notes() {
      return clone(recentNotes);
    },
    async createTask(input) {
      taskCalls += 1;
      sequence += 1;
      tasks.push(clone(input));
      const now = '2026-10-26T08:00:00.000Z';
      return {
        id: input.id ?? `task-${sequence}`,
        spaceId: 'personal',
        listId: input.listId,
        parentId: input.parentId ?? null,
        noteId: input.noteId ?? null,
        title: input.title,
        notes: input.notes ?? '',
        status: input.status ?? 'todo',
        priority: input.priority ?? 0,
        quadrant: input.quadrant ?? 4,
        dueDate: input.dueDate ?? null,
        dueTime: input.dueTime ?? null,
        dueAt: input.dueAt ?? null,
        tz: input.tz ?? 'Asia/Shanghai',
        reminder: input.reminder ?? '',
        sortOrder: input.sortOrder ?? 0,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      } as Task;
    },
    async createNote(input) {
      sequence += 1;
      notes.push(clone(input));
      const now = '2026-10-26T08:00:00.000Z';
      return {
        id: input.id ?? `note-${sequence}`,
        spaceId: 'personal',
        title: input.title,
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
      } as Note;
    },
    snapshot() {
      return {
        tasks: clone(tasks),
        notes: clone(notes),
        lists: clone(lists),
        recentNotes: clone(recentNotes),
      };
    },
    createTaskCalls: () => taskCalls,
  };
}
