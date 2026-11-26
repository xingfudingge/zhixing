/**
 * 测试用内存 TaskSource。
 *
 * 只用于 vitest：语义尽量贴近 Rust 仓储（软删除、收件箱不可删、
 * 删除清单迁移任务、设置 upsert、完成写 completedAt），
 * 不参与任何产品运行路径。
 */

import type {
  List,
  ListDeleteResult,
  ListMove,
  ListUpdate,
  NewList,
  NewNote,
  NewSetting,
  NewSubtask,
  NewTask,
  Note,
  NoteQuery,
  Setting,
  SettingQuery,
  Subtask,
  SubtaskUpdate,
  Task,
  TaskQuery,
  TaskStatus,
} from '../../../data/db/types';
import type { TaskSource } from '../TaskStore';

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

export function makeTask(
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

export function createDefaultSeed(): {
  lists: List[];
  tasks: Task[];
  notes: Note[];
} {
  return {
    notes: [
      makeNote({
        id: 'note-welcome',
        title: '欢迎使用知行',
        tags: ['开始'],
        body: '<p>本地优先的任务与知识库。</p>',
      }),
    ],
    lists: [
      makeList({
        id: 'inbox',
        name: '收件箱',
        color: '#8b96a3',
        icon: 'inbox',
        sortOrder: 0,
        isInbox: true,
      }),
      makeList({
        id: 'work',
        name: '工作',
        color: '#5579d5',
        icon: 'briefcase',
        sortOrder: 10,
      }),
      makeList({
        id: 'life',
        name: '生活',
        color: '#d89338',
        icon: 'home',
        sortOrder: 20,
      }),
      makeList({
        id: 'reading',
        name: '阅读',
        color: '#8066c7',
        icon: 'book',
        sortOrder: 30,
      }),
    ],
    tasks: [
      makeTask({
        id: 'task-overdue',
        title: '交房租',
        listId: 'life',
        dueDate: '2026-10-25',
        priority: 2,
        quadrant: 1,
        sortOrder: 1,
      }),
      makeTask({
        id: 'task-review',
        title: '完成新版产品需求文档',
        listId: 'work',
        dueDate: TEST_TODAY,
        dueTime: '10:30',
        priority: 3,
        quadrant: 1,
        notes: '收敛任务与知识的融合边界。',
        sortOrder: 2,
      }),
      makeTask({
        id: 'task-design',
        title: '和设计师确认首页信息架构',
        listId: 'work',
        dueDate: TEST_TODAY,
        dueTime: '14:00',
        status: 'doing',
        priority: 2,
        quadrant: 1,
        sortOrder: 3,
      }),
      makeTask({
        id: 'task-coffee',
        title: '买咖啡豆',
        listId: 'life',
        dueDate: TEST_TODAY,
        status: 'done',
        completedAt: '2026-10-26T03:00:00.000Z',
        sortOrder: 4,
      }),
      makeTask({
        id: 'task-weekly',
        title: '准备周会材料',
        listId: 'work',
        dueDate: '2026-10-27',
        dueTime: '09:30',
        priority: 2,
        quadrant: 2,
        sortOrder: 5,
      }),
      makeTask({
        id: 'task-idea',
        title: '记一个想法：把日历和笔记连起来',
        listId: 'inbox',
        sortOrder: 6,
      }),
      makeTask({
        id: 'task-reading',
        title: '读《设计中的设计》第二章',
        listId: 'reading',
        dueDate: TEST_TODAY,
        sortOrder: 7,
      }),
      makeTask({
        id: 'task-travel',
        title: '整理旅行清单',
        listId: 'life',
        sortOrder: 8,
      }),
      makeTask({
        id: 'task-mail',
        title: '回复合作方邮件',
        listId: 'work',
        dueDate: '2026-10-25',
        status: 'done',
        completedAt: '2026-10-25T09:00:00.000Z',
        priority: 1,
        quadrant: 2,
        sortOrder: 9,
      }),
    ],
  };
}

export type FakeTaskSource = TaskSource & {
  snapshot: () => {
    lists: List[];
    tasks: Task[];
    subtasks: Subtask[];
    notes: Note[];
    settings: Setting[];
  };
  calls: string[];
};

export function createFakeTaskSource(seed?: {
  lists?: List[];
  tasks?: Task[];
  settings?: Setting[];
  subtasks?: Subtask[];
  notes?: Note[];
}): FakeTaskSource {
  const defaults = createDefaultSeed();
  let lists = (seed?.lists ?? defaults.lists).map(clone);
  let tasks = (seed?.tasks ?? defaults.tasks).map(clone);
  let subtasks = (seed?.subtasks ?? []).map(clone);
  let notes = (seed?.notes ?? defaults.notes).map(clone);
  let settings = (seed?.settings ?? []).map(clone);
  const calls: string[] = [];
  let seq = 0;

  const nextId = (prefix: string) => {
    seq += 1;
    return `${prefix}-${seq}`;
  };

  const activeLists = () =>
    lists.filter((list) => list.deletedAt === null);

  const listDepth = (id: string): number => {
    let depth = 0;
    let current = activeLists().find((list) => list.id === id);
    while (current && depth < 32) {
      depth += 1;
      current = current.parentId
        ? activeLists().find((list) => list.id === current?.parentId)
        : undefined;
    }
    return depth;
  };

  const subtreeHeight = (id: string): number => {
    let height = 0;
    let frontier = [id];
    while (frontier.length > 0 && height < 32) {
      height += 1;
      frontier = activeLists()
        .filter((list) => list.parentId !== null && frontier.includes(list.parentId))
        .map((list) => list.id);
    }
    return height;
  };

  const isDescendant = (candidate: string, root: string): boolean => {
    let current = activeLists().find((list) => list.id === candidate);
    let guard = 0;
    while (current && guard < 32) {
      if (current.id === root) {
        return true;
      }
      guard += 1;
      current = current.parentId
        ? activeLists().find((list) => list.id === current?.parentId)
        : undefined;
    }
    return false;
  };

  const activeTasks = (includeDeleted = false) =>
    tasks.filter((task) => includeDeleted || task.deletedAt === null);

  const sortTaskRows = (rows: Task[]) =>
    [...rows].sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? -1 : 1;
      }
      return a.id.localeCompare(b.id);
    });

  const source: FakeTaskSource = {
    calls,
    snapshot: () => clone({ lists, tasks, subtasks, notes, settings }),
    tasks: {
      async list(query: TaskQuery = {}) {
        calls.push('tasks.list');
        let rows = activeTasks(query.includeDeleted ?? false);
        if (query.listId !== undefined && query.listId !== null) {
          rows = rows.filter((task) => task.listId === query.listId);
        }
        if (query.status !== undefined && query.status !== null) {
          rows = rows.filter((task) => task.status === query.status);
        }
        if (query.dueDate !== undefined && query.dueDate !== null) {
          rows = rows.filter((task) => task.dueDate === query.dueDate);
        }
        if (query.dueBefore !== undefined && query.dueBefore !== null) {
          rows = rows.filter(
            (task) =>
              task.dueDate !== null && task.dueDate <= (query.dueBefore as string),
          );
        }
        if (query.inbox) {
          const inboxIds = new Set(
            activeLists()
              .filter((list) => list.isInbox)
              .map((list) => list.id),
          );
          rows = rows.filter((task) => inboxIds.has(task.listId));
        }
        return clone(sortTaskRows(rows));
      },
      async get(id: string) {
        calls.push('tasks.get');
        const task = tasks.find(
          (item) => item.id === id && item.deletedAt === null,
        );
        if (!task) {
          throw new Error(`任务不存在：${id}`);
        }
        return clone(task);
      },
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
        const task = makeTask({
          id: input.id ?? nextId('task'),
          title,
          listId: input.listId,
          parentId: input.parentId ?? null,
          noteId: input.noteId ?? null,
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
          version: 1,
        });
        tasks = [...tasks, task];
        return clone(task);
      },
      async patch(task: Task, patch) {
        calls.push('tasks.patch');
        const index = tasks.findIndex(
          (item) => item.id === task.id && item.deletedAt === null,
        );
        if (index < 0) {
          throw new Error(`任务不存在：${task.id}`);
        }
        const current = tasks[index];
        const nextStatus = patch.status ?? current.status;
        const now = stamp();
        const next: Task = {
          ...current,
          ...patch,
          status: nextStatus,
          title: patch.title === undefined ? current.title : patch.title.trim(),
          completedAt:
            nextStatus === 'done' ? (current.completedAt ?? now) : null,
          updatedAt: now,
          version: current.version + 1,
        };
        if (!next.title) {
          throw new Error('任务标题不能为空');
        }
        tasks = tasks.map((item) => (item.id === task.id ? next : item));
        return clone(next);
      },
      async complete(id: string, done: boolean) {
        calls.push('tasks.complete');
        const index = tasks.findIndex(
          (item) => item.id === id && item.deletedAt === null,
        );
        if (index < 0) {
          throw new Error(`任务不存在：${id}`);
        }
        const now = stamp();
        const nextStatus: TaskStatus = done ? 'done' : 'todo';
        const next: Task = {
          ...tasks[index],
          status: nextStatus,
          completedAt: done ? now : null,
          updatedAt: now,
          version: tasks[index].version + 1,
        };
        tasks = tasks.map((item) => (item.id === id ? next : item));
        return clone(next);
      },
      async remove(id: string) {
        calls.push('tasks.remove');
        const now = stamp();
        tasks = tasks.map((item) =>
          item.id === id
            ? {
                ...item,
                deletedAt: now,
                updatedAt: now,
                version: item.version + 1,
              }
            : item,
        );
      },
      async restore(id: string) {
        calls.push('tasks.restore');
        const index = tasks.findIndex(
          (item) => item.id === id && item.deletedAt !== null,
        );
        if (index < 0) {
          throw new Error(`任务不存在或未删除：${id}`);
        }
        const now = stamp();
        const next: Task = {
          ...tasks[index],
          deletedAt: null,
          updatedAt: now,
          version: tasks[index].version + 1,
        };
        tasks = tasks.map((item) => (item.id === id ? next : item));
        return clone(next);
      },
      subtasks: {
        async list(taskId: string) {
          calls.push('subtasks.list');
          return clone(
            subtasks.filter(
              (item) => item.taskId === taskId && item.deletedAt === null,
            ),
          );
        },
        async create(input: NewSubtask) {
          calls.push('subtasks.create');
          const title = input.title.trim();
          if (!title) {
            throw new Error('子任务标题不能为空');
          }
          const now = stamp();
          const subtask: Subtask = {
            id: input.id ?? nextId('subtask'),
            taskId: input.taskId,
            title,
            done: input.done ?? false,
            sortOrder: input.sortOrder ?? 0,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            version: 1,
          };
          subtasks = [...subtasks, subtask];
          return clone(subtask);
        },
        async update(id: string, input: SubtaskUpdate) {
          calls.push('subtasks.update');
          const index = subtasks.findIndex(
            (item) => item.id === id && item.deletedAt === null,
          );
          if (index < 0) {
            throw new Error(`子任务不存在：${id}`);
          }
          const next: Subtask = {
            ...subtasks[index],
            title: input.title.trim(),
            done: input.done,
            sortOrder: input.sortOrder,
            updatedAt: stamp(),
            version: subtasks[index].version + 1,
          };
          subtasks = subtasks.map((item) => (item.id === id ? next : item));
          return clone(next);
        },
        async remove(id: string) {
          calls.push('subtasks.remove');
          const now = stamp();
          subtasks = subtasks.map((item) =>
            item.id === id
              ? {
                  ...item,
                  deletedAt: now,
                  updatedAt: now,
                  version: item.version + 1,
                }
              : item,
          );
        },
      },
    },
    notes: {
      async list(query: NoteQuery = {}) {
        calls.push('notes.list');
        let rows = notes.filter((note) => note.deletedAt === null);
        if (query.status) {
          rows = rows.filter((note) => note.status === query.status);
        }
        if (query.folderId !== undefined && query.folderId !== null) {
          rows = rows.filter((note) => note.folderId === query.folderId);
        }
        if (query.search) {
          const needle = query.search.trim();
          rows = rows.filter(
            (note) => note.title.includes(needle) || note.body.includes(needle),
          );
        }
        return clone(
          rows.slice().sort((a, b) => {
            if (a.pinned !== b.pinned) {
              return a.pinned ? -1 : 1;
            }
            return a.updatedAt < b.updatedAt ? 1 : -1;
          }),
        );
      },
      async get(id: string) {
        calls.push('notes.get');
        const note = notes.find(
          (item) => item.id === id && item.deletedAt === null,
        );
        if (!note) {
          throw new Error(`笔记不存在：${id}`);
        }
        return clone(note);
      },
      async create(input: NewNote) {
        calls.push('notes.create');
        const title = input.title.trim();
        if (!title) {
          throw new Error('笔记标题不能为空');
        }
        const now = stamp();
        const note: Note = {
          id: input.id ?? nextId('note'),
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
      async remove(id: string) {
        calls.push('notes.remove');
        const now = stamp();
        notes = notes.map((item) =>
          item.id === id
            ? {
                ...item,
                status: 'trashed',
                deletedAt: now,
                updatedAt: now,
                version: item.version + 1,
              }
            : item,
        );
      },
    },
    lists: {
      async list(includeDeleted = false) {
        calls.push('lists.list');
        return clone(
          (includeDeleted ? lists : activeLists())
            .slice()
            .sort((a, b) => {
              if (a.sortOrder !== b.sortOrder) {
                return a.sortOrder - b.sortOrder;
              }
              if (a.name !== b.name) {
                return a.name < b.name ? -1 : 1;
              }
              return a.id.localeCompare(b.id);
            }),
        );
      },
      async get(id: string) {
        calls.push('lists.get');
        const list = activeLists().find((item) => item.id === id);
        if (!list) {
          throw new Error(`清单不存在：${id}`);
        }
        return clone(list);
      },
      async create(input: NewList) {
        calls.push('lists.create');
        const name = input.name.trim();
        if (!name) {
          throw new Error('清单名称不能为空');
        }
        const isInbox = input.isInbox ?? false;
        const parentId = input.parentId ?? null;
        if (isInbox && parentId !== null) {
          throw new Error('收件箱必须位于根级');
        }
        if (isInbox && activeLists().some((item) => item.isInbox)) {
          throw new Error('该空间已存在收件箱，不能重复创建');
        }
        if (parentId !== null) {
          const parent = activeLists().find((item) => item.id === parentId);
          if (!parent) {
            throw new Error(`清单不存在：${parentId}`);
          }
          if (parent.isInbox) {
            throw new Error('不能把清单放到收件箱下');
          }
          if (listDepth(parentId) + 1 > 3) {
            throw new Error('最多支持 3 层清单');
          }
        }
        if (
          activeLists().some(
            (item) =>
              item.parentId === parentId &&
              item.name.toLowerCase() === name.toLowerCase(),
          )
        ) {
          throw new Error('同一父级下已存在同名清单');
        }
        const now = stamp();
        const siblings = activeLists().filter(
          (item) => item.parentId === parentId,
        );
        const list = makeList({
          id: input.id ?? nextId('list'),
          name,
          color: input.color ?? '#5579d5',
          icon: input.icon ?? '',
          parentId,
          sortOrder:
            input.sortOrder ??
            Math.max(0, ...siblings.map((item) => item.sortOrder)) + 10,
          isInbox,
          createdAt: now,
          updatedAt: now,
        });
        lists = [...lists, list];
        return clone(list);
      },
      async update(id: string, input: ListUpdate) {
        calls.push('lists.update');
        const index = lists.findIndex(
          (item) => item.id === id && item.deletedAt === null,
        );
        if (index < 0) {
          throw new Error(`清单不存在：${id}`);
        }
        const name = input.name.trim();
        if (!name) {
          throw new Error('清单名称不能为空');
        }
        if (
          activeLists().some(
            (item) =>
              item.id !== id &&
              item.parentId === lists[index].parentId &&
              item.name.toLowerCase() === name.toLowerCase(),
          )
        ) {
          throw new Error('同一父级下已存在同名清单');
        }
        const next: List = {
          ...lists[index],
          name,
          color: input.color,
          icon: input.icon ?? lists[index].icon,
          sortOrder: input.sortOrder,
          updatedAt: stamp(),
          version: lists[index].version + 1,
        };
        lists = lists.map((item) => (item.id === id ? next : item));
        return clone(next);
      },
      async move(id: string, input: ListMove) {
        calls.push('lists.move');
        const target = activeLists().find((item) => item.id === id);
        if (!target) {
          throw new Error(`清单不存在：${id}`);
        }
        if (target.isInbox) {
          throw new Error('收件箱是系统清单，不能移动');
        }
        const parentId = input.parentId;
        if (parentId !== null) {
          if (parentId === id) {
            throw new Error('清单不能移动到自己的子清单下');
          }
          const parent = activeLists().find((item) => item.id === parentId);
          if (!parent) {
            throw new Error(`清单不存在：${parentId}`);
          }
          if (parent.isInbox) {
            throw new Error('不能把清单放到收件箱下');
          }
          if (isDescendant(parentId, id)) {
            throw new Error('清单不能移动到自己的子清单下');
          }
          if (listDepth(parentId) + subtreeHeight(id) > 3) {
            throw new Error('最多支持 3 层清单');
          }
        }
        const next: List = {
          ...target,
          parentId,
          sortOrder: input.sortOrder,
          updatedAt: stamp(),
          version: target.version + 1,
        };
        lists = lists.map((item) => (item.id === id ? next : item));
        return clone(next);
      },
      async remove(id: string): Promise<ListDeleteResult> {
        calls.push('lists.remove');
        const target = activeLists().find((item) => item.id === id);
        if (!target) {
          throw new Error(`清单不存在：${id}`);
        }
        if (target.isInbox) {
          throw new Error('收件箱是系统清单，不能删除');
        }
        const inbox = activeLists().find((item) => item.isInbox);
        if (!inbox) {
          throw new Error('找不到可用收件箱');
        }
        const now = stamp();
        let moved = 0;
        tasks = tasks.map((task) => {
          if (task.listId === id && task.deletedAt === null) {
            moved += 1;
            return {
              ...task,
              listId: inbox.id,
              updatedAt: now,
              version: task.version + 1,
            };
          }
          return task;
        });
        let promoted = 0;
        lists = lists.map((item) => {
          if (item.parentId === id && item.deletedAt === null) {
            promoted += 1;
            return {
              ...item,
              parentId: target.parentId,
              updatedAt: now,
              version: item.version + 1,
            };
          }
          return item;
        });
        lists = lists.map((item) =>
          item.id === id
            ? {
                ...item,
                deletedAt: now,
                updatedAt: now,
                version: item.version + 1,
              }
            : item,
        );
        return { movedTasks: moved, promotedLists: promoted, inboxId: inbox.id };
      },
      async inbox() {
        calls.push('lists.inbox');
        const list = activeLists().find((item) => item.isInbox) ?? null;
        return list ? clone(list) : null;
      },
    },
    settings: {
      async list(query: SettingQuery = {}) {
        calls.push('settings.list');
        return clone(
          settings.filter(
            (setting) =>
              setting.deletedAt === null &&
              (!query.scope || setting.scope === query.scope),
          ),
        );
      },
      async set(input: NewSetting) {
        calls.push('settings.set');
        const scope = input.scope ?? 'space';
        const existing = settings.find(
          (setting) =>
            setting.scope === scope &&
            setting.key === input.key &&
            setting.deletedAt === null,
        );
        if (existing) {
          const next: Setting = {
            ...existing,
            value: input.value,
            updatedAt: stamp(),
            version: existing.version + 1,
          };
          settings = settings.map((setting) =>
            setting.id === existing.id ? next : setting,
          );
          return clone(next);
        }
        const now = stamp();
        const setting: Setting = {
          id: nextId('setting'),
          spaceId: input.spaceId ?? 'personal',
          scope,
          key: input.key,
          value: input.value,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          version: 1,
        };
        settings = [...settings, setting];
        return clone(setting);
      },
    },
  };

  return source;
}
