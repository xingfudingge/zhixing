/**
 * 测试用内存 HabitSource。
 *
 * 语义贴近 Rust 仓储与 `createHabitRepository` 封装：软删除、同 habit+date
 * 唯一、未来日期拒绝、删除习惯连带删除日志、安排行动创建普通任务。
 * 不参与任何产品运行路径。
 */

import type {
  Habit,
  HabitLog,
  HabitLogQuery,
  HabitQuery,
  HabitUpdate,
  List,
  NewHabit,
  NewTask,
  Task,
} from '../../../data/db/types';
import type { HabitPatch } from '../../../data/repositories/habits';
import type { HabitSource } from '../HabitStore';

export const TEST_TODAY = '2026-10-26';

let clock = Date.parse('2026-10-26T08:00:00.000Z');

function stamp(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function makeList(
  overrides: Partial<List> & Pick<List, 'id' | 'name'>,
): List {
  const now = '2026-10-20T00:00:00.000Z';
  return {
    spaceId: 'personal',
    color: '#5579d5',
    icon: '',
    parentId: null,
    sortOrder: 10,
    isInbox: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function makeHabit(
  overrides: Partial<Habit> & Pick<Habit, 'id' | 'title'>,
): Habit {
  const now = '2026-10-20T00:00:00.000Z';
  return {
    spaceId: 'personal',
    schedule: '每天',
    icon: '✳',
    color: 'amber',
    goalPerWeek: 7,
    sortOrder: 0,
    archived: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function makeHabitLog(
  overrides: Partial<HabitLog> & Pick<HabitLog, 'habitId' | 'logDate'>,
): HabitLog {
  const now = '2026-10-20T00:00:00.000Z';
  return {
    id: `log-${overrides.habitId}-${overrides.logDate}`,
    spaceId: 'personal',
    done: true,
    note: '',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function createDefaultSeed(): {
  lists: List[];
  habits: Habit[];
  logs: HabitLog[];
  tasks: Task[];
} {
  return {
    lists: [
      makeList({
        id: 'inbox',
        name: '收件箱',
        icon: 'inbox',
        sortOrder: 0,
        isInbox: true,
      }),
      makeList({
        id: 'life',
        name: '生活',
        color: '#d89338',
        icon: 'home',
        sortOrder: 20,
      }),
      makeList({
        id: 'work',
        name: '工作',
        color: '#5579d5',
        icon: 'briefcase',
        sortOrder: 10,
      }),
    ],
    habits: [
      makeHabit({
        id: 'habit-read',
        title: '阅读 30 分钟',
        schedule: '每天 · 睡前',
        icon: '▤',
        color: 'violet',
        sortOrder: 1,
      }),
      makeHabit({
        id: 'habit-early',
        title: '早起',
        schedule: '每天 · 07:00',
        icon: '☀',
        color: 'amber',
        sortOrder: 2,
      }),
    ],
    logs: [],
    tasks: [],
  };
}

export type FakeHabitSnapshot = {
  habits: Habit[];
  logs: HabitLog[];
  lists: List[];
  tasks: Task[];
};

export type FakeHabitSource = HabitSource & {
  snapshot: () => FakeHabitSnapshot;
  calls: string[];
};

export function createFakeHabitSource(seed?: {
  lists?: List[];
  habits?: Habit[];
  logs?: HabitLog[];
  tasks?: Task[];
}): FakeHabitSource {
  const defaults = createDefaultSeed();
  let lists = (seed?.lists ?? defaults.lists).map(clone);
  let habits = (seed?.habits ?? defaults.habits).map(clone);
  let logs = (seed?.logs ?? defaults.logs).map(clone);
  let tasks = (seed?.tasks ?? defaults.tasks).map(clone);
  const calls: string[] = [];
  let seq = 0;

  const nextId = (prefix: string) => {
    seq += 1;
    return `${prefix}-${seq}`;
  };

  const activeLists = () => lists.filter((list) => list.deletedAt === null);

  const activeHabits = (includeArchived = false) =>
    habits.filter(
      (habit) =>
        habit.deletedAt === null && (includeArchived || !habit.archived),
    );

  const activeLogs = (habitId?: string) =>
    logs.filter(
      (log) =>
        log.deletedAt === null && (!habitId || log.habitId === habitId),
    );

  const getHabit = (id: string): Habit => {
    const habit = activeHabits().find((item) => item.id === id);
    if (!habit) {
      throw new Error(`习惯不存在：${id}`);
    }
    return habit;
  };

  const applyUpdate = (habit: Habit, input: HabitUpdate): Habit => {
    const title = input.title.trim();
    if (!title) {
      throw new Error('习惯名称不能为空');
    }
    if (input.goalPerWeek < 0 || input.goalPerWeek > 7) {
      throw new Error('每周目标必须在 0..=7');
    }
    return {
      ...habit,
      title,
      schedule: input.schedule,
      icon: input.icon ?? '',
      color: input.color ?? 'blue',
      goalPerWeek: input.goalPerWeek,
      sortOrder: input.sortOrder,
      archived: input.archived,
      updatedAt: stamp(),
      version: habit.version + 1,
    };
  };

  const source: FakeHabitSource = {
    calls,
    snapshot: () => clone({ habits, logs, lists, tasks }),

    habits: {
      async list(query: HabitQuery = {}) {
        calls.push('habits.list');
        const rows = (
          query.includeDeleted ? habits : activeHabits(query.includeArchived ?? false)
        ).filter(
          (habit) =>
            (query.includeDeleted || habit.deletedAt === null) &&
            ((query.includeArchived ?? false) || !habit.archived),
        );
        return clone(
          rows.slice().sort((a, b) => {
            if (a.sortOrder !== b.sortOrder) {
              return a.sortOrder - b.sortOrder;
            }
            if (a.createdAt !== b.createdAt) {
              return a.createdAt < b.createdAt ? -1 : 1;
            }
            return a.id.localeCompare(b.id);
          }),
        );
      },

      async get(id: string) {
        calls.push('habits.get');
        return clone(getHabit(id));
      },

      async create(input: NewHabit) {
        calls.push('habits.create');
        const title = input.title.trim();
        if (!title) {
          throw new Error('习惯名称不能为空');
        }
        const goal = input.goalPerWeek ?? 7;
        if (goal < 0 || goal > 7) {
          throw new Error('每周目标必须在 0..=7');
        }
        const now = stamp();
        const habit = makeHabit({
          id: input.id ?? nextId('habit'),
          title,
          schedule: input.schedule ?? '每天',
          icon: input.icon ?? '',
          color: input.color ?? 'blue',
          goalPerWeek: goal,
          sortOrder: input.sortOrder ?? 0,
          archived: input.archived ?? false,
          createdAt: now,
          updatedAt: now,
        });
        habits = [...habits, habit];
        return clone(habit);
      },

      async update(id: string, input: HabitUpdate) {
        calls.push('habits.update');
        const habit = getHabit(id);
        const next = applyUpdate(habit, input);
        habits = habits.map((item) => (item.id === id ? next : item));
        return clone(next);
      },

      async patch(habit: Habit, patch: HabitPatch) {
        calls.push('habits.patch');
        const current = getHabit(habit.id);
        const next = applyUpdate(current, {
          title: patch.title ?? current.title,
          schedule: patch.schedule ?? current.schedule,
          icon: patch.icon ?? current.icon,
          color: patch.color ?? current.color,
          goalPerWeek: patch.goalPerWeek ?? current.goalPerWeek,
          sortOrder: patch.sortOrder ?? current.sortOrder,
          archived: patch.archived ?? current.archived,
        });
        habits = habits.map((item) => (item.id === habit.id ? next : item));
        return clone(next);
      },

      async remove(id: string) {
        calls.push('habits.remove');
        getHabit(id);
        const now = stamp();
        logs = logs.map((log) =>
          log.habitId === id && log.deletedAt === null
            ? {
                ...log,
                done: false,
                deletedAt: now,
                updatedAt: now,
                version: log.version + 1,
              }
            : log,
        );
        habits = habits.map((habit) =>
          habit.id === id
            ? {
                ...habit,
                deletedAt: now,
                updatedAt: now,
                version: habit.version + 1,
              }
            : habit,
        );
      },

      logs: {
        async list(habitId: string, query: HabitLogQuery = {}) {
          calls.push('habit_logs.list');
          let rows = activeLogs(habitId);
          if (query.from) {
            rows = rows.filter((log) => log.logDate >= (query.from as string));
          }
          if (query.to) {
            rows = rows.filter((log) => log.logDate <= (query.to as string));
          }
          return clone(rows.slice().sort((a, b) => a.logDate.localeCompare(b.logDate)));
        },

        async set(habitId: string, date: string, note?: string) {
          calls.push('habit_logs.set');
          getHabit(habitId);
          if (date > TEST_TODAY) {
            throw new Error('还没到这一天');
          }
          const existing = logs.find(
            (log) => log.habitId === habitId && log.logDate === date,
          );
          if (existing) {
            const next: HabitLog = {
              ...existing,
              done: true,
              note: note ?? '',
              deletedAt: null,
              updatedAt: stamp(),
              version: existing.version + 1,
            };
            logs = logs.map((log) => (log === existing ? next : log));
            return clone(next);
          }
          const now = stamp();
          const log = makeHabitLog({
            id: nextId('log'),
            habitId,
            logDate: date,
            note: note ?? '',
            createdAt: now,
            updatedAt: now,
          });
          logs = [...logs, log];
          return clone(log);
        },

        async remove(habitId: string, date: string) {
          calls.push('habit_logs.delete');
          if (date > TEST_TODAY) {
            throw new Error('还没到这一天');
          }
          const now = stamp();
          logs = logs.map((log) =>
            log.habitId === habitId &&
            log.logDate === date &&
            log.deletedAt === null
              ? {
                  ...log,
                  done: false,
                  deletedAt: now,
                  updatedAt: now,
                  version: log.version + 1,
                }
              : log,
          );
        },
      },
    },

    lists: {
      async list(includeDeleted = false) {
        calls.push('lists.list');
        return clone(
          (includeDeleted ? lists : activeLists())
            .slice()
            .sort((a, b) => a.sortOrder - b.sortOrder),
        );
      },
    },

    tasks: {
      async create(input: NewTask) {
        calls.push('tasks.create');
        const title = input.title.trim();
        if (!title) {
          throw new Error('任务标题不能为空');
        }
        if (!activeLists().some((list) => list.id === input.listId)) {
          throw new Error(`清单不存在：${input.listId}`);
        }
        const now = stamp();
        const status = input.status ?? 'todo';
        const task: Task = {
          id: input.id ?? nextId('task'),
          spaceId: 'personal',
          listId: input.listId,
          parentId: input.parentId ?? null,
          noteId: input.noteId ?? null,
          title,
          notes: input.notes ?? '',
          status,
          priority: input.priority ?? 0,
          quadrant: input.quadrant ?? 0,
          dueDate: input.dueDate ?? null,
          dueTime: input.dueTime ?? null,
          dueAt: input.dueAt ?? null,
          tz: input.tz ?? 'Asia/Shanghai',
          reminder: input.reminder ?? '',
          sortOrder: input.sortOrder ?? 0,
          completedAt: status === 'done' ? now : null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          version: 1,
        };
        tasks = [...tasks, task];
        return clone(task);
      },
    },
  };

  return source;
}
