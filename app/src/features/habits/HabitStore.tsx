/**
 * 习惯域数据容器。
 *
 * 唯一数据源是 `data/db/client` → Tauri IPC → SQLite 仓储；浏览器预览没有
 * IPC 时进入 `unavailable`，不回退 localStorage、不生成内存里的“假持久化”
 * 数据。测试通过注入 `HabitSource` 使用内存仓储。
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
  Habit,
  NewHabit,
  List,
  Task,
} from '../../data/db/types';
import {
  createHabitRepository,
  type HabitPatch,
  type HabitRepository,
} from '../../data/repositories/habits';
import {
  createListRepository,
  type ListRepository,
} from '../../data/repositories/lists';
import {
  createTaskRepository,
  type TaskRepository,
} from '../../data/repositories/tasks';
import {
  currentMonth,
  groupLogs,
  todayISOFromClock,
  type HabitLogMap,
} from './stats';

export type HabitSource = {
  habits: HabitRepository;
  lists: Pick<ListRepository, 'list'>;
  tasks: Pick<TaskRepository, 'create'>;
};

export type HabitStoreStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export type ToggleLogResult = {
  checked: boolean;
  date: string;
};

export type ArrangeActionResult = {
  task: Task;
  list: List;
};

export type HabitStoreValue = {
  status: HabitStoreStatus;
  error: string | null;
  habits: Habit[];
  logsByHabit: HabitLogMap;
  lists: List[];
  today: string;
  month: string;
  setMonth: (month: string) => void;
  refresh: () => Promise<void>;
  createHabit: (input: NewHabit) => Promise<Habit>;
  updateHabit: (habit: Habit, patch: HabitPatch) => Promise<Habit>;
  deleteHabit: (id: string) => Promise<void>;
  toggleLog: (habitId: string, date: string) => Promise<ToggleLogResult>;
  arrangeAction: (habit: Habit) => Promise<ArrangeActionResult>;
};

const HabitStoreContext = createContext<HabitStoreValue | null>(null);

export const defaultHabitSource: HabitSource = {
  habits: createHabitRepository(db),
  lists: createListRepository(db),
  tasks: createTaskRepository(db),
};

export function formatError(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '操作失败，请重试';
}

/** 安排行动固定落到“生活”；缺失时按非收件箱、收件箱顺序回退。 */
export function pickActionList(lists: List[]): List | null {
  return (
    lists.find((list) => list.id === 'life') ??
    lists.find((list) => list.name === '生活') ??
    lists.find((list) => !list.isInbox) ??
    lists.find((list) => list.isInbox) ??
    null
  );
}

export type HabitStoreProviderProps = {
  children: ReactNode;
  /** 测试注入；不传时使用真实的 SQLite 仓储。 */
  source?: HabitSource;
  /** 固定“今天”，测试可传入稳定日期。 */
  today?: string;
  /**
   * 显式覆盖可用性。注入 source 时默认可用；
   * 未注入时只有在 Tauri 运行时才可用。
   */
  available?: boolean;
};

export function HabitStoreProvider({
  children,
  source,
  today,
  available,
}: HabitStoreProviderProps) {
  const sourceRef = useRef<HabitSource>(source ?? defaultHabitSource);
  const runtimeAvailable =
    available ?? (source !== undefined ? true : isTauriRuntime());
  const resolvedToday = today ?? todayISOFromClock();
  const [status, setStatus] = useState<HabitStoreStatus>(
    runtimeAvailable ? 'loading' : 'unavailable',
  );
  const [error, setError] = useState<string | null>(null);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [logsByHabit, setLogsByHabit] = useState<HabitLogMap>({});
  const [lists, setLists] = useState<List[]>([]);
  const [month, setMonth] = useState(() => currentMonth(resolvedToday));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setMonth(currentMonth(resolvedToday));
  }, [resolvedToday]);

  const refresh = useCallback(async () => {
    if (!runtimeAvailable) {
      setStatus('unavailable');
      return;
    }
    try {
      const [nextHabits, nextLists] = await Promise.all([
        sourceRef.current.habits.list(),
        sourceRef.current.lists.list(),
      ]);
      const logRows = await Promise.all(
        nextHabits.map((habit) => sourceRef.current.habits.logs.list(habit.id)),
      );
      if (!mounted.current) {
        return;
      }
      setHabits(nextHabits);
      setLists(nextLists);
      setLogsByHabit(groupLogs(nextHabits, logRows));
      setError(null);
      setStatus('ready');
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

  const ensureAvailable = useCallback(() => {
    if (!runtimeAvailable) {
      throw new Error('需在桌面壳内使用本地习惯库');
    }
  }, [runtimeAvailable]);

  const createHabit = useCallback(
    async (input: NewHabit) => {
      ensureAvailable();
      const habit = await sourceRef.current.habits.create(input);
      await refresh();
      return habit;
    },
    [ensureAvailable, refresh],
  );

  const updateHabit = useCallback(
    async (habit: Habit, patch: HabitPatch) => {
      ensureAvailable();
      const updated = await sourceRef.current.habits.patch(habit, patch);
      await refresh();
      return updated;
    },
    [ensureAvailable, refresh],
  );

  const deleteHabit = useCallback(
    async (id: string) => {
      ensureAvailable();
      await sourceRef.current.habits.remove(id);
      await refresh();
    },
    [ensureAvailable, refresh],
  );

  const toggleLog = useCallback(
    async (habitId: string, date: string) => {
      ensureAvailable();
      if (date > resolvedToday) {
        throw new Error('还没到这一天');
      }
      const existing = (logsByHabit[habitId] ?? []).some(
        (log) => log.logDate === date && log.deletedAt === null,
      );
      try {
        if (existing) {
          await sourceRef.current.habits.logs.remove(habitId, date);
        } else {
          await sourceRef.current.habits.logs.set(habitId, date);
        }
        await refresh();
        return { checked: !existing, date };
      } catch (reason) {
        throw new Error(formatError(reason));
      }
    },
    [ensureAvailable, logsByHabit, refresh, resolvedToday],
  );

  const arrangeAction = useCallback(
    async (habit: Habit): Promise<ArrangeActionResult> => {
      ensureAvailable();
      const availableLists =
        lists.length > 0 ? lists : await sourceRef.current.lists.list();
      const list = pickActionList(availableLists);
      if (!list) {
        throw new Error('没有可用清单，无法安排行动');
      }
      const task = await sourceRef.current.tasks.create({
        title: `习惯：${habit.title}`,
        listId: list.id,
        status: 'todo',
        priority: 3,
        quadrant: 2,
        dueDate: resolvedToday,
        notes: '来自习惯',
      });
      return { task, list };
    },
    [ensureAvailable, lists, resolvedToday],
  );

  const value = useMemo<HabitStoreValue>(
    () => ({
      status,
      error,
      habits,
      logsByHabit,
      lists,
      today: resolvedToday,
      month,
      setMonth,
      refresh,
      createHabit,
      updateHabit,
      deleteHabit,
      toggleLog,
      arrangeAction,
    }),
    [
      status,
      error,
      habits,
      logsByHabit,
      lists,
      resolvedToday,
      month,
      refresh,
      createHabit,
      updateHabit,
      deleteHabit,
      toggleLog,
      arrangeAction,
    ],
  );

  return (
    <HabitStoreContext.Provider value={value}>
      {children}
    </HabitStoreContext.Provider>
  );
}

export function useHabitStore(): HabitStoreValue {
  const context = useContext(HabitStoreContext);
  if (!context) {
    throw new Error('useHabitStore 必须在 HabitStoreProvider 内使用');
  }
  return context;
}
