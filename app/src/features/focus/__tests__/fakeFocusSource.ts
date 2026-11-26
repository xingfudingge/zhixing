/**
 * 测试用内存 FocusSource。
 *
 * 语义贴近 Rust 仓储：无任务/非法分钟拒绝、软删除过滤、按开始日期过滤；
 * 不参与任何产品运行路径。
 */

import type {
  FocusSession,
  FocusSessionQuery,
  Task,
  TaskQuery,
} from '../../../data/db/types';
import {
  validateFocusRecord,
  type RecordFocusInput,
} from '../../../data/repositories/focus';
import type { FocusSource } from '../FocusRuntime';

export const TEST_TODAY = '2026-10-26';
const NOW = '2026-10-26T08:00:00.000Z';

let clock = 0;

function stamp(): string {
  clock += 1000;
  return new Date(Date.parse(NOW) + clock).toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function makeTask(
  overrides: Partial<Task> & Pick<Task, 'id' | 'title' | 'listId'>,
): Task {
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
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
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
    createdAt: overrides.startedAt,
    updatedAt: overrides.startedAt,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function createDefaultTasks(): Task[] {
  return [
    makeTask({
      id: 'task-review',
      title: '完成新版产品需求文档',
      listId: 'work',
      dueDate: TEST_TODAY,
      status: 'doing',
    }),
    makeTask({
      id: 'task-design',
      title: '和设计师确认首页信息架构',
      listId: 'work',
      dueDate: '2026-10-27',
    }),
    makeTask({
      id: 'task-done',
      title: '买咖啡豆',
      listId: 'life',
      status: 'done',
      completedAt: '2026-10-26T03:00:00.000Z',
    }),
  ];
}

type FakeOptions = {
  tasks?: Task[];
  sessions?: FocusSession[];
};

export function createFakeFocusSource(options: FakeOptions = {}) {
  const taskRows = options.tasks ?? createDefaultTasks();
  const sessionRows = options.sessions ?? [];
  let sequence = 0;

  const tasks = {
    list: async (_query: TaskQuery = {}): Promise<Task[]> =>
      clone(taskRows.filter((task) => task.deletedAt === null)),
  };

  const sessions = {
    list: async (query: FocusSessionQuery = {}): Promise<FocusSession[]> =>
      clone(
        sessionRows.filter((session) => {
          if (!query.includeDeleted && session.deletedAt !== null) {
            return false;
          }
          const date = session.startedAt.slice(0, 10);
          if (query.from && date < query.from) {
            return false;
          }
          if (query.to && date > query.to) {
            return false;
          }
          if (query.taskId && session.taskId !== query.taskId) {
            return false;
          }
          return true;
        }),
      ),
    record: async (input: RecordFocusInput): Promise<FocusSession> => {
      const message = validateFocusRecord(input);
      if (message) {
        throw new Error(message);
      }
      if (!taskRows.some((task) => task.id === input.taskId)) {
        throw new Error('FOREIGN KEY constraint failed');
      }
      sequence += 1;
      const createdAt = stamp();
      const session: FocusSession = {
        id: `focus-${sequence}`,
        spaceId: 'personal',
        taskId: input.taskId,
        minutes: input.minutes,
        startedAt: input.startedAt,
        endedAt: input.endedAt ?? null,
        mode: input.mode,
        note: input.note ?? '',
        createdAt,
        updatedAt: createdAt,
        deletedAt: null,
        version: 1,
      };
      sessionRows.unshift(session);
      return clone(session);
    },
  };

  return {
    tasks,
    sessions,
    snapshot: () => ({
      tasks: clone(taskRows),
      sessions: clone(sessionRows),
    }),
  } satisfies FocusSource & { snapshot: () => { tasks: Task[]; sessions: FocusSession[] } };
}

export type FakeFocusSource = ReturnType<typeof createFakeFocusSource>;
