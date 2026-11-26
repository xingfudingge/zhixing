/**
 * 测试用内存 ReviewRepository。
 *
 * 语义贴近真实链路：只读聚合、同范围快照幂等、笔记与快照成对创建。
 * 不参与任何产品运行路径。
 */

import type {
  FocusSession,
  Habit,
  HabitLog,
  List,
  NewNote,
  Note,
  NoteQuery,
  NoteUpdate,
  ReviewSnapshot,
  SavedReview,
  Task,
} from '../../../data/db/types';
import type {
  ReviewRepository,
  ReviewLoadOptions,
} from '../../../data/repositories/review';
import {
  buildReviewAggregate,
  type ReviewAggregate,
} from '../model';

export const TEST_TODAY = '2026-10-26';
const STAMP = '2026-10-20T00:00:00.000Z';

let clock = Date.parse('2026-10-26T08:00:00.000Z');

function stamp(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    spaceId: 'personal',
    listId: 'work',
    parentId: null,
    noteId: null,
    notes: '',
    status: 'done',
    priority: 0,
    quadrant: 2,
    dueDate: null,
    dueTime: null,
    dueAt: null,
    tz: 'Asia/Shanghai',
    reminder: '',
    sortOrder: 0,
    completedAt: `${TEST_TODAY}T12:00:00.000Z`,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function makeSession(
  overrides: Partial<FocusSession> &
    Pick<FocusSession, 'id' | 'taskId' | 'minutes' | 'startedAt'>,
): FocusSession {
  return {
    spaceId: 'personal',
    endedAt: null,
    mode: 'pomodoro',
    note: '',
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function makeHabit(overrides: Partial<Habit> & Pick<Habit, 'id' | 'title'>): Habit {
  return {
    spaceId: 'personal',
    schedule: '每天',
    icon: '✳',
    color: 'blue',
    goalPerWeek: 7,
    sortOrder: 0,
    archived: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function makeLog(
  overrides: Partial<HabitLog> & Pick<HabitLog, 'habitId' | 'logDate'>,
): HabitLog {
  return {
    id: `log-${overrides.habitId}-${overrides.logDate}`,
    spaceId: 'personal',
    done: true,
    note: '',
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function makeNote(overrides: Partial<Note> & Pick<Note, 'id' | 'title'>): Note {
  return {
    spaceId: 'personal',
    folderId: null,
    tags: [],
    body: '',
    bodyFormat: 'html',
    status: 'active',
    favorite: false,
    pinned: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function makeList(overrides: Partial<List> & Pick<List, 'id' | 'name'>): List {
  return {
    spaceId: 'personal',
    color: '#5579d5',
    icon: '',
    parentId: null,
    sortOrder: 0,
    isInbox: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export type FakeReviewSeed = {
  tasks?: Task[];
  sessions?: FocusSession[];
  habits?: Habit[];
  logsByHabit?: Record<string, HabitLog[]>;
  lists?: List[];
  notes?: Note[];
  snapshots?: ReviewSnapshot[];
};

export type FakeReviewState = {
  notes: Note[];
  snapshots: ReviewSnapshot[];
};

export type FakeReviewSource = ReviewRepository & {
  notes: {
    list: (query?: NoteQuery) => Promise<Note[]>;
    get: (id: string) => Promise<Note>;
    create: (input: NewNote) => Promise<Note>;
    update: (id: string, input: NoteUpdate) => Promise<Note>;
    remove: (id: string) => Promise<void>;
  };
  state: () => FakeReviewState;
};

export function createDefaultReviewSeed(): Required<
  Pick<FakeReviewSeed, 'tasks' | 'sessions' | 'habits' | 'logsByHabit' | 'lists'>
> {
  return {
    tasks: [
      makeTask({ id: 'task-1', title: '完成复盘卡', listId: 'work' }),
      makeTask({
        id: 'task-2',
        title: '整理本周笔记',
        listId: 'life',
        completedAt: `${TEST_TODAY}T13:00:00.000Z`,
      }),
    ],
    sessions: [
      makeSession({
        id: 'focus-1',
        taskId: 'task-1',
        minutes: 20,
        startedAt: `${TEST_TODAY}T09:00:00+08:00`,
      }),
      makeSession({
        id: 'focus-2',
        taskId: 'task-2',
        minutes: 10,
        startedAt: `${TEST_TODAY}T10:00:00+08:00`,
      }),
    ],
    habits: [makeHabit({ id: 'habit-read', title: '阅读 30 分钟' })],
    logsByHabit: {
      'habit-read': [makeLog({ habitId: 'habit-read', logDate: TEST_TODAY })],
    },
    lists: [
      makeList({ id: 'work', name: '工作' }),
      makeList({ id: 'life', name: '生活' }),
    ],
  };
}

export function createFakeReviewSource(seed: FakeReviewSeed = {}): FakeReviewSource {
  const defaults = createDefaultReviewSeed();
  const tasks = seed.tasks ?? defaults.tasks;
  const sessions = seed.sessions ?? defaults.sessions;
  const habits = seed.habits ?? defaults.habits;
  const logsByHabit = seed.logsByHabit ?? defaults.logsByHabit;
  const lists = seed.lists ?? defaults.lists;
  const notes = seed.notes ?? [];
  const snapshots = seed.snapshots ?? [];
  let noteSequence = notes.length;

  const notesApi = {
    async list(query: NoteQuery = {}): Promise<Note[]> {
      return clone(
        notes
          .filter((note) => query.includeDeleted || note.deletedAt === null)
          .filter((note) => !query.status || note.status === query.status)
          .filter(
            (note) =>
              query.search === undefined ||
              query.search === null ||
              note.title.includes(query.search) ||
              note.body.includes(query.search),
          )
          .slice()
          .sort((left, right) => {
            if (left.pinned !== right.pinned) {
              return left.pinned ? -1 : 1;
            }
            const diff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
            return diff !== 0 ? diff : left.id.localeCompare(right.id);
          }),
      );
    },
    async get(id: string): Promise<Note> {
      const note = notes.find(
        (item) => item.id === id && item.deletedAt === null,
      );
      if (!note) {
        throw new Error(`未找到笔记：${id}`);
      }
      return clone(note);
    },
    async create(input: NewNote): Promise<Note> {
      noteSequence += 1;
      const timestamp = stamp();
      const note = makeNote({
        id: input.id ?? `note-${noteSequence}`,
        title: input.title,
        folderId: input.folderId ?? null,
        tags: input.tags ?? [],
        body: input.body ?? '',
        bodyFormat: input.bodyFormat ?? 'html',
        status: input.status ?? 'active',
        favorite: input.favorite ?? false,
        pinned: input.pinned ?? false,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      notes.unshift(note);
      return clone(note);
    },
    async update(id: string, input: NoteUpdate): Promise<Note> {
      const index = notes.findIndex(
        (item) => item.id === id && item.deletedAt === null,
      );
      if (index < 0) {
        throw new Error(`未找到笔记：${id}`);
      }
      const next: Note = {
        ...notes[index],
        title: input.title,
        folderId: input.folderId,
        tags: [...input.tags],
        body: input.body,
        bodyFormat: input.bodyFormat,
        favorite: input.favorite,
        pinned: input.pinned,
        updatedAt: stamp(),
        version: notes[index].version + 1,
      };
      notes[index] = next;
      return clone(next);
    },
    async remove(id: string): Promise<void> {
      const index = notes.findIndex(
        (item) => item.id === id && item.deletedAt === null,
      );
      if (index >= 0) {
        notes[index] = {
          ...notes[index],
          deletedAt: stamp(),
          version: notes[index].version + 1,
        };
      }
    },
  };

  function activeNote(noteId: string | null): Note | null {
    if (!noteId) {
      return null;
    }
    const note = notes.find(
      (item) => item.id === noteId && item.deletedAt === null,
    );
    return note ? clone(note) : null;
  }

  return {
    notes: notesApi,
    state: () => ({ notes: clone(notes), snapshots: clone(snapshots) }),

    async load(options: ReviewLoadOptions = {}): Promise<ReviewAggregate> {
      return buildReviewAggregate({
        today: options.today ?? TEST_TODAY,
        days: options.days ?? 7,
        tasks: clone(tasks),
        sessions: clone(sessions),
        habits: clone(habits),
        logsByHabit: clone(logsByHabit),
        lists: clone(lists),
      });
    },

    async save(aggregate: ReviewAggregate): Promise<SavedReview> {
      const existing = snapshots.find(
        (snapshot) =>
          snapshot.deletedAt === null &&
          snapshot.rangeStart === aggregate.range.from &&
          snapshot.rangeEnd === aggregate.range.to,
      );

      if (existing) {
        const current = activeNote(existing.noteId);
        if (current) {
          return { snapshot: clone(existing), note: current, created: false };
        }
        const note = await notesApi.create({
          title: aggregate.note.title,
          folderId: null,
          tags: aggregate.note.tags,
          body: aggregate.note.body,
          bodyFormat: 'html',
        });
        existing.noteId = note.id;
        existing.updatedAt = stamp();
        existing.version += 1;
        return { snapshot: clone(existing), note, created: false };
      }

      const note = await notesApi.create({
        title: aggregate.note.title,
        folderId: null,
        tags: aggregate.note.tags,
        body: aggregate.note.body,
        bodyFormat: 'html',
      });
      const timestamp = stamp();
      const snapshot: ReviewSnapshot = {
        id: `snapshot-${snapshots.length + 1}`,
        spaceId: 'personal',
        rangeStart: aggregate.range.from,
        rangeEnd: aggregate.range.to,
        taskIds: [...aggregate.sourceIds.taskIds],
        focusIds: [...aggregate.sourceIds.focusIds],
        habitIds: [...aggregate.sourceIds.habitIds],
        noteId: note.id,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
        version: 1,
      };
      snapshots.unshift(snapshot);
      return { snapshot: clone(snapshot), note, created: true };
    },

    async snapshot(from: string, to: string): Promise<ReviewSnapshot | null> {
      const found = snapshots.find(
        (item) =>
          item.deletedAt === null &&
          item.rangeStart === from &&
          item.rangeEnd === to,
      );
      return found ? clone(found) : null;
    },
  };
}
