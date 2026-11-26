/**
 * 任务域数据容器。
 *
 * 唯一数据源是 `data/db/client` → Tauri IPC → SQLite 仓储。
 * 浏览器预览没有 IPC 时进入 `unavailable`，绝不回退 localStorage、
 * 也不生成内存里的“假持久化”数据；测试通过注入 `TaskSource` 使用内存仓储。
 *
 * 视图偏好（今天视图、四象限范围）写入 device 设置，刷新/重启后保持。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { db, isTauriRuntime } from '../../data/db/client';
import type {
  List,
  ListDeleteResult,
  ListMove,
  ListUpdate,
  NewList,
  NewNote,
  NewSetting,
  NewTask,
  Note,
  NoteQuery,
  Setting,
  SettingQuery,
  Subtask,
  Task,
  TaskStatus,
} from '../../data/db/types';
import {
  createExecutionNote,
  type ExecutionNoteOptions,
} from '../notes/createFromTask';
import { broadcastTasksChanged } from '../notifications/runtime';
import {
  createListRepository,
  LISTS_CHANGED_EVENT,
  type ListRepository,
} from '../../data/repositories/lists';
import {
  normalizeTaskCompletionBehavior,
  type TaskCompletionBehavior,
} from '../../data/repositories/settings';
import {
  normalizeWeekStart,
  type WeekStart,
} from '../calendar/workweek';
import {
  createTaskRepository,
  type TaskPatch,
  type TaskRepository,
} from '../../data/repositories/tasks';
import { installTaskReminderDefaultsBridge } from './reminderDefaults';
import type { QuadrantScope, TodayView } from './viewModel';

// 所有任务创建入口（含快速创建）最终都走 client.tasks.create；
// 在这里安装一次默认提醒桥，保证设置页保存后下一次新建即生效。
installTaskReminderDefaultsBridge();

export type TaskPreferences = {
  todayView: TodayView;
  quadrantScope: QuadrantScope;
  /**
   * `remove` 时今天/清单/四象限/看板的活动视图过滤已完成任务；
   * 任务中心的「已完成」筛选与搜索仍读取完整任务集。
   */
  completionBehavior: TaskCompletionBehavior;
  /** 任务中心「本周」分组与日历共用同一个周起始。 */
  weekStart: WeekStart;
};

export type TaskSettingsRepository = {
  list: (query?: SettingQuery) => Promise<Setting[]>;
  set: (input: NewSetting) => Promise<Setting>;
};

/** 任务详情只依赖笔记域的最小读写面，避免把知识页状态塞进任务 store。 */
export type TaskNotesRepository = {
  list: (query?: NoteQuery) => Promise<Note[]>;
  get: (id: string) => Promise<Note>;
  create: (input: NewNote) => Promise<Note>;
  remove: (id: string) => Promise<void>;
};

export type TaskSource = {
  tasks: TaskRepository;
  lists: ListRepository;
  settings: TaskSettingsRepository;
  /** 旧测试源可以没有笔记；此时详情只读任务字段。 */
  notes?: TaskNotesRepository;
};

export type TaskStoreStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export type TaskBatchFailure = { id: string; error: string };

/**
 * 批量结果：逐条独立事务，成功项保留、失败项不写入；最后只刷新一次。
 * `refreshError` 非空表示数据已提交，但列表刷新失败（以库为准，提示重试）。
 */
export type TaskBatchResult = {
  succeeded: string[];
  failed: TaskBatchFailure[];
  refreshError: string | null;
};

export type TaskBatchProgress = (done: number, total: number) => void;

export type TaskStoreValue = {
  status: TaskStoreStatus;
  error: string | null;
  tasks: Task[];
  lists: List[];
  inbox: List | null;
  preferences: TaskPreferences;
  today: string;
  refresh: () => Promise<void>;
  createTask: (input: NewTask) => Promise<Task>;
  patchTask: (id: string, patch: TaskPatch) => Promise<Task>;
  /** 批量改期等：逐条 patch，最后 refresh 一次。 */
  patchTaskBatch: (
    items: Array<{ id: string; patch: TaskPatch }>,
    onProgress?: TaskBatchProgress,
  ) => Promise<TaskBatchResult>;
  completeTaskBatch: (
    ids: string[],
    onProgress?: TaskBatchProgress,
  ) => Promise<TaskBatchResult>;
  setTaskStatus: (id: string, status: TaskStatus) => Promise<Task>;
  completeTask: (id: string, done: boolean) => Promise<Task>;
  removeTask: (id: string) => Promise<void>;
  restoreTask: (id: string) => Promise<Task>;
  createList: (input: NewList) => Promise<List>;
  updateList: (id: string, input: ListUpdate) => Promise<List>;
  moveList: (id: string, input: ListMove) => Promise<List>;
  deleteList: (id: string) => Promise<ListDeleteResult>;
  setPreference: <K extends keyof TaskPreferences>(
    key: K,
    value: TaskPreferences[K],
  ) => Promise<void>;
  listSubtasks: (taskId: string) => Promise<Subtask[]>;
  addSubtask: (taskId: string, title: string) => Promise<Subtask>;
  setSubtaskDone: (subtask: Subtask, done: boolean) => Promise<Subtask>;
  removeSubtask: (id: string) => Promise<void>;
  listNotes: (query?: NoteQuery) => Promise<Note[]>;
  getNote: (id: string) => Promise<Note>;
  createExecutionNote: (
    task: Task,
    options?: ExecutionNoteOptions,
  ) => Promise<{ note: Note; task: Task }>;
};

const DEFAULT_PREFERENCES: TaskPreferences = {
  todayView: 'list',
  quadrantScope: 'today',
  completionBehavior: 'keep',
  weekStart: 'monday',
};

const PREFERENCE_KEYS: Record<keyof TaskPreferences, string> = {
  todayView: 'tasks.todayView',
  quadrantScope: 'tasks.quadrantScope',
  completionBehavior: 'tasks.completionBehavior',
  weekStart: 'calendar.weekStart',
};

const TaskStoreContext = createContext<TaskStoreValue | null>(null);

export const defaultTaskSource: TaskSource = {
  tasks: createTaskRepository(db),
  lists: createListRepository(db),
  settings: {
    list: (query) => db.settings.list(query),
    set: (input) => db.settings.set(input),
  },
  notes: {
    list: (query) => db.notes.list(query),
    get: (id) => db.notes.get(id),
    create: (input) => db.notes.create(input),
    remove: (id) => db.notes.remove(id),
  },
};

export function formatError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message || '操作失败，请重试';
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '操作失败，请重试';
}

function readPreferences(settings: Setting[]): TaskPreferences {
  const values = new Map(settings.map((setting) => [setting.key, setting.value]));
  const view = values.get(PREFERENCE_KEYS.todayView);
  const scope = values.get(PREFERENCE_KEYS.quadrantScope);
  return {
    todayView:
      view === 'list' || view === 'quadrant' || view === 'board'
        ? view
        : DEFAULT_PREFERENCES.todayView,
    quadrantScope:
      scope === 'today' || scope === 'all'
        ? scope
        : DEFAULT_PREFERENCES.quadrantScope,
    completionBehavior: normalizeTaskCompletionBehavior(
      values.get(PREFERENCE_KEYS.completionBehavior),
    ),
    weekStart: normalizeWeekStart(values.get(PREFERENCE_KEYS.weekStart)),
  };
}

export type TaskStoreProviderProps = {
  children: ReactNode;
  /** 测试注入；不传时使用真实的 SQLite 仓储。 */
  source?: TaskSource;
  /** 固定“今天”，测试可传入稳定日期。 */
  today?: string;
  /**
   * 显式覆盖可用性。注入 source 时默认可用；
   * 未注入时只有在 Tauri 运行时才可用。
   */
  available?: boolean;
};

export function TaskStoreProvider({
  children,
  source,
  today,
  available,
}: TaskStoreProviderProps) {
  const sourceRef = useRef<TaskSource>(source ?? defaultTaskSource);
  const runtimeAvailable =
    available ?? (source !== undefined ? true : isTauriRuntime());
  const resolvedToday = today ?? todayISOFromClock();
  const [status, setStatus] = useState<TaskStoreStatus>(
    runtimeAvailable ? 'loading' : 'unavailable',
  );
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [lists, setLists] = useState<List[]>([]);
  const [preferences, setPreferences] =
    useState<TaskPreferences>(DEFAULT_PREFERENCES);
  const mounted = useRef(true);
  // 同一任务的 patch 串行执行：详情页同 tick 改多个字段时，后一次必须基于
  // 前一次落库后的任务生成完整 TaskUpdate，不能被旧快照覆盖。
  const patchQueues = useRef(new Map<string, Promise<Task>>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!runtimeAvailable) {
      setStatus('unavailable');
      return;
    }
    try {
      const [nextLists, nextTasks, nextSettings] = await Promise.all([
        sourceRef.current.lists.list(),
        sourceRef.current.tasks.list(),
        sourceRef.current.settings.list({ scope: 'device' }),
      ]);
      if (!mounted.current) {
        return;
      }
      setLists(nextLists);
      setTasks(nextTasks);
      setPreferences(readPreferences(nextSettings));
      setError(null);
      setStatus('ready');
      // 通知运行时据此立即重算提醒计划；无监听者时无副作用。
      broadcastTasksChanged();
    } catch (reason) {
      const message = formatError(reason);
      if (!mounted.current) {
        return;
      }
      setError(message);
      setStatus((current) => (current === 'ready' ? 'ready' : 'error'));
      throw new Error(message);
    }
  }, [runtimeAvailable]);

  useEffect(() => {
    if (!runtimeAvailable) {
      setStatus('unavailable');
      return;
    }
    setStatus('loading');
    void refresh().catch(() => undefined);
  }, [refresh, runtimeAvailable]);

  // 侧栏树直接调用 IPC 改父级/顺序时，任务页需要同步刷新。
  useEffect(() => {
    if (!runtimeAvailable) {
      return;
    }
    const handler = () => {
      void refresh().catch(() => undefined);
    };
    window.addEventListener(LISTS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(LISTS_CHANGED_EVENT, handler);
  }, [refresh, runtimeAvailable]);

  const ensureAvailable = useCallback(() => {
    if (!runtimeAvailable) {
      throw new Error('需在桌面壳内使用任务库');
    }
  }, [runtimeAvailable]);

  const createTask = useCallback(
    async (input: NewTask) => {
      ensureAvailable();
      const task = await sourceRef.current.tasks.create(input);
      await refresh();
      return task;
    },
    [ensureAvailable, refresh],
  );

  /**
   * 同一任务的 patch 串行执行，但不在这里 refresh；
   * 单条 patch 与批量 patch 都复用它，批量只在结束时刷新一次。
   */
  const queuePatch = useCallback(async (id: string, patch: TaskPatch) => {
    const previous = patchQueues.current.get(id) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const current = await sourceRef.current.tasks.get(id);
        return sourceRef.current.tasks.patch(current, patch);
      });
    patchQueues.current.set(id, operation);
    try {
      return await operation;
    } finally {
      if (patchQueues.current.get(id) === operation) {
        patchQueues.current.delete(id);
      }
    }
  }, []);

  const patchTask = useCallback(
    async (id: string, patch: TaskPatch) => {
      ensureAvailable();
      const task = await queuePatch(id, patch);
      await refresh();
      return task;
    },
    [ensureAvailable, queuePatch, refresh],
  );

  const patchTaskBatch = useCallback(
    async (
      items: Array<{ id: string; patch: TaskPatch }>,
      onProgress?: TaskBatchProgress,
    ): Promise<TaskBatchResult> => {
      ensureAvailable();
      const succeeded: string[] = [];
      const failed: TaskBatchFailure[] = [];
      let done = 0;
      for (const item of items) {
        try {
          await queuePatch(item.id, item.patch);
          succeeded.push(item.id);
        } catch (reason) {
          failed.push({ id: item.id, error: formatError(reason) });
        }
        done += 1;
        onProgress?.(done, items.length);
      }
      let refreshError: string | null = null;
      try {
        await refresh();
      } catch (reason) {
        refreshError = formatError(reason);
      }
      return { succeeded, failed, refreshError };
    },
    [ensureAvailable, queuePatch, refresh],
  );

  const completeTaskBatch = useCallback(
    async (
      ids: string[],
      onProgress?: TaskBatchProgress,
    ): Promise<TaskBatchResult> => {
      ensureAvailable();
      const succeeded: string[] = [];
      const failed: TaskBatchFailure[] = [];
      let done = 0;
      for (const id of ids) {
        try {
          await sourceRef.current.tasks.complete(id, true);
          succeeded.push(id);
        } catch (reason) {
          failed.push({ id, error: formatError(reason) });
        }
        done += 1;
        onProgress?.(done, ids.length);
      }
      let refreshError: string | null = null;
      try {
        await refresh();
      } catch (reason) {
        refreshError = formatError(reason);
      }
      return { succeeded, failed, refreshError };
    },
    [ensureAvailable, refresh],
  );

  const setTaskStatus = useCallback(
    async (id: string, taskStatus: TaskStatus) => {
      return patchTask(id, { status: taskStatus });
    },
    [patchTask],
  );

  const completeTask = useCallback(
    async (id: string, done: boolean) => {
      ensureAvailable();
      const task = await sourceRef.current.tasks.complete(id, done);
      await refresh();
      return task;
    },
    [ensureAvailable, refresh],
  );

  const removeTask = useCallback(
    async (id: string) => {
      ensureAvailable();
      await sourceRef.current.tasks.remove(id);
      await refresh();
    },
    [ensureAvailable, refresh],
  );

  const restoreTask = useCallback(
    async (id: string) => {
      ensureAvailable();
      const task = await sourceRef.current.tasks.restore(id);
      await refresh();
      return task;
    },
    [ensureAvailable, refresh],
  );

  const requireNotes = useCallback((): TaskNotesRepository => {
    const notes = sourceRef.current.notes;
    if (!notes) {
      throw new Error('当前数据源不支持笔记');
    }
    return notes;
  }, []);

  const listNotes = useCallback(
    async (query?: NoteQuery) => {
      ensureAvailable();
      return requireNotes().list(query);
    },
    [ensureAvailable, requireNotes],
  );

  const getNote = useCallback(
    async (id: string) => {
      ensureAvailable();
      return requireNotes().get(id);
    },
    [ensureAvailable, requireNotes],
  );

  const createTaskExecutionNote = useCallback(
    async (task: Task, options?: ExecutionNoteOptions) => {
      ensureAvailable();
      const notes = requireNotes();
      const result = await createExecutionNote(
        {
          notes: {
            create: (input) => notes.create(input),
            remove: (id) => notes.remove(id),
          },
          tasks: {
            patch: (current, patch) =>
              sourceRef.current.tasks.patch(current, patch),
          },
        },
        task,
        options,
      );
      await refresh();
      return result;
    },
    [ensureAvailable, refresh, requireNotes],
  );

  const createList = useCallback(
    async (input: NewList) => {
      ensureAvailable();
      const list = await sourceRef.current.lists.create(input);
      await refresh();
      return list;
    },
    [ensureAvailable, refresh],
  );

  const updateList = useCallback(
    async (id: string, input: ListUpdate) => {
      ensureAvailable();
      const list = await sourceRef.current.lists.update(id, input);
      await refresh();
      return list;
    },
    [ensureAvailable, refresh],
  );

  const moveList = useCallback(
    async (id: string, input: ListMove) => {
      ensureAvailable();
      const list = await sourceRef.current.lists.move(id, input);
      await refresh();
      return list;
    },
    [ensureAvailable, refresh],
  );

  const deleteList = useCallback(
    async (id: string) => {
      ensureAvailable();
      const result = await sourceRef.current.lists.remove(id);
      await refresh();
      return result;
    },
    [ensureAvailable, refresh],
  );

  const setPreference = useCallback(
    async <K extends keyof TaskPreferences>(
      key: K,
      value: TaskPreferences[K],
    ) => {
      ensureAvailable();
      const previous = preferences[key];
      setPreferences((current) => ({ ...current, [key]: value }));
      try {
        await sourceRef.current.settings.set({
          scope: 'device',
          key: PREFERENCE_KEYS[key],
          value,
        });
      } catch (reason) {
        setPreferences((current) => ({ ...current, [key]: previous }));
        throw reason;
      }
    },
    [ensureAvailable, preferences],
  );

  const listSubtasks = useCallback(
    async (taskId: string) => {
      ensureAvailable();
      return sourceRef.current.tasks.subtasks.list(taskId);
    },
    [ensureAvailable],
  );

  const addSubtask = useCallback(
    async (taskId: string, title: string) => {
      ensureAvailable();
      const subtask = await sourceRef.current.tasks.subtasks.create({
        taskId,
        title,
      });
      return subtask;
    },
    [ensureAvailable],
  );

  const setSubtaskDone = useCallback(
    async (subtask: Subtask, done: boolean) => {
      ensureAvailable();
      return sourceRef.current.tasks.subtasks.update(subtask.id, {
        title: subtask.title,
        done,
        sortOrder: subtask.sortOrder,
      });
    },
    [ensureAvailable],
  );

  const removeSubtask = useCallback(
    async (id: string) => {
      ensureAvailable();
      await sourceRef.current.tasks.subtasks.remove(id);
    },
    [ensureAvailable],
  );

  const inbox = useMemo(
    () => lists.find((list) => list.isInbox) ?? null,
    [lists],
  );

  const value = useMemo<TaskStoreValue>(
    () => ({
      status,
      error,
      tasks,
      lists,
      inbox,
      preferences,
      today: resolvedToday,
      refresh,
      createTask,
      patchTask,
      patchTaskBatch,
      completeTaskBatch,
      setTaskStatus,
      completeTask,
      removeTask,
      restoreTask,
      createList,
      updateList,
      moveList,
      deleteList,
      setPreference,
      listSubtasks,
      addSubtask,
      setSubtaskDone,
      removeSubtask,
      listNotes,
      getNote,
      createExecutionNote: createTaskExecutionNote,
    }),
    [
      status,
      error,
      tasks,
      lists,
      inbox,
      preferences,
      resolvedToday,
      refresh,
      createTask,
      patchTask,
      patchTaskBatch,
      completeTaskBatch,
      setTaskStatus,
      completeTask,
      removeTask,
      restoreTask,
      createList,
      updateList,
      moveList,
      deleteList,
      setPreference,
      listSubtasks,
      addSubtask,
      setSubtaskDone,
      removeSubtask,
      listNotes,
      getNote,
      createTaskExecutionNote,
    ],
  );

  return (
    <TaskStoreContext.Provider value={value}>
      {children}
    </TaskStoreContext.Provider>
  );
}

function todayISOFromClock(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function useTaskStore(): TaskStoreValue {
  const context = useContext(TaskStoreContext);
  if (!context) {
    throw new Error('useTaskStore 必须在 TaskStoreProvider 内使用');
  }
  return context;
}
