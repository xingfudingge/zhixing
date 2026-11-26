/**
 * 测试用任务/清单源：只实现 linkTodo 需要的最小读写面，
 * 并额外提供 complete/delete 模拟“任务在其他页面被完成/删除”。
 */

import type {
  List,
  NewTask,
  Task,
  TaskStatus,
} from '../../../../data/db/types';

let sequence = 0;
let clock = Date.parse('2026-10-26T09:00:00.000Z');

function nextId(): string {
  sequence += 1;
  return `task-test-${sequence}`;
}

function stamp(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function makeFakeList(
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

export function makeFakeTask(
  overrides: Partial<Task> & Pick<Task, 'id' | 'title' | 'listId'>,
): Task {
  const now = '2026-10-20T00:00:00.000Z';
  return {
    spaceId: 'personal',
    parentId: null,
    noteId: null,
    notes: '',
    status: 'todo',
    priority: 0,
    quadrant: 4,
    dueDate: null,
    dueTime: null,
    dueAt: null,
    tz: 'Asia/Shanghai',
    reminder: '',
    sortOrder: 0,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export type FakeTodoTaskSource = {
  tasks: {
    list: (query?: {
      includeDeleted?: boolean | null;
      status?: TaskStatus | null;
    }) => Promise<Task[]>;
    get: (id: string) => Promise<Task>;
    create: (input: NewTask) => Promise<Task>;
    remove: (id: string) => Promise<void>;
  };
  lists: {
    list: (includeDeleted?: boolean) => Promise<List[]>;
    inbox: () => Promise<List | null>;
  };
  snapshotTasks: (includeDeleted?: boolean) => Task[];
  snapshotLists: () => List[];
  completeTask: (id: string, done?: boolean) => Task;
  deleteTask: (id: string) => void;
};

export function createFakeTodoTaskSource(
  seedTasks: Task[] = [],
  seedLists: List[] = [],
): FakeTodoTaskSource {
  let tasks = seedTasks.map(clone);
  const lists = seedLists.map(clone);

  const requireActive = (id: string): Task => {
    const task = tasks.find((item) => item.id === id && item.deletedAt === null);
    if (!task) {
      throw new Error(`缺少任务：${id}`);
    }
    return task;
  };

  return {
    tasks: {
      async list(query = {}) {
        const includeDeleted = query.includeDeleted === true;
        return clone(
          tasks.filter(
            (task) =>
              (includeDeleted || task.deletedAt === null) &&
              (!query.status || task.status === query.status),
          ),
        );
      },

      async get(id) {
        return clone(requireActive(id));
      },

      async create(input: NewTask) {
        const now = stamp();
        const task: Task = {
          id: input.id ?? nextId(),
          spaceId: input.spaceId ?? 'personal',
          listId: input.listId,
          parentId: input.parentId ?? null,
          noteId: input.noteId ?? null,
          title: input.title.trim(),
          notes: input.notes ?? '',
          status: input.status ?? 'todo',
          priority: input.priority ?? 0,
          quadrant: input.quadrant ?? 4,
          dueDate: input.dueDate ?? null,
          dueTime: input.dueTime ?? null,
          dueAt: input.dueAt ?? null,
          tz: input.tz ?? 'Asia/Shanghai',
          reminder: input.reminder ?? '',
          sortOrder: input.sortOrder ?? tasks.length,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          version: 1,
        };
        tasks = [...tasks, task];
        return clone(task);
      },

      async remove(id) {
        const index = tasks.findIndex(
          (task) => task.id === id && task.deletedAt === null,
        );
        if (index < 0) {
          throw new Error(`缺少任务：${id}`);
        }
        tasks[index] = {
          ...tasks[index],
          deletedAt: stamp(),
          updatedAt: stamp(),
          version: tasks[index].version + 1,
        };
      },
    },

    lists: {
      async list(includeDeleted = false) {
        return clone(
          lists.filter((list) => includeDeleted || list.deletedAt === null),
        );
      },
      async inbox() {
        return clone(lists.find((list) => list.isInbox) ?? null);
      },
    },

    snapshotTasks: (includeDeleted = true) =>
      clone(
        includeDeleted
          ? tasks
          : tasks.filter((task) => task.deletedAt === null),
      ),

    snapshotLists: () => clone(lists),

    completeTask(id, done = true) {
      const index = tasks.findIndex((task) => task.id === id);
      if (index < 0) {
        throw new Error(`缺少任务：${id}`);
      }
      tasks[index] = {
        ...tasks[index],
        status: done ? 'done' : 'todo',
        completedAt: done ? stamp() : null,
        updatedAt: stamp(),
        version: tasks[index].version + 1,
      };
      return clone(tasks[index]);
    },

    deleteTask(id) {
      const index = tasks.findIndex((task) => task.id === id);
      if (index < 0) {
        throw new Error(`缺少任务：${id}`);
      }
      tasks[index] = {
        ...tasks[index],
        deletedAt: stamp(),
        updatedAt: stamp(),
        version: tasks[index].version + 1,
      };
    },
  };
}
