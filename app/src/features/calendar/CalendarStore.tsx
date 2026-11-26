/**
 * 日历域数据容器：事件、倒数日与「显示农历」设备偏好。
 *
 * 与任务域一样，真实数据只走 Tauri IPC → SQLite 仓储；
 * 浏览器预览没有 IPC 时进入 unavailable，不回退 localStorage、不造假数据。
 * 测试通过注入 `CalendarSource` 使用内存仓储。
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
  Countdown,
  CountdownUpdate,
  Event,
  EventUpdate,
  NewCountdown,
  NewEvent,
  NewSetting,
  Setting,
  SettingQuery,
} from '../../data/db/types';
import { parseStoredSettings } from '../../data/repositories/settings';
import {
  builtinHolidayLookup,
  createHolidayLookup,
  type HolidayLookup,
  type HolidayPackage,
} from '../../data/calendar/holidays';
import type { DateException } from '../../data/calendar/exceptions';
import {
  createDefaultHolidaySyncService,
  setRuntimeHolidayPackages,
  DEFAULT_HOLIDAY_PREFERENCES,
  type HolidayPreferences,
  type HolidaySyncState,
} from './holiday';
import {
  createEventRepository,
  type EventRepository,
} from '../events/eventRepository';
import {
  createCountdownRepository,
  type CountdownRepository,
} from '../countdowns/countdownRepository';
import {
  DEFAULT_WORKDAY_RULE,
  normalizeWeekStart,
  normalizeWorkdayRule,
  type WeekStart,
  type WorkdayRule,
} from './workweek';

export const SHOW_LUNAR_KEY = 'calendar.showLunar';

export type CalendarSettingsRepository = {
  list: (query?: SettingQuery) => Promise<Setting[]>;
  set: (input: NewSetting) => Promise<Setting>;
};

export type CalendarHolidaySource = {
  listPackages: () => Promise<HolidayPackage[]>;
  getState: () => Promise<HolidaySyncState>;
  maybeAutoSync?: (
    preferences: HolidayPreferences,
  ) => Promise<unknown>;
};

export type CalendarSource = {
  events: EventRepository;
  countdowns: CountdownRepository;
  settings?: CalendarSettingsRepository;
  /** 节假日缓存读取；测试可省略。正式运行使用 IndexedDB。 */
  holidays?: CalendarHolidaySource;
};

export type CalendarStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export type CalendarDataValue = {
  status: CalendarStatus;
  error: string | null;
  events: Event[];
  countdowns: Countdown[];
  showLunar: boolean;
  weekStart: WeekStart;
  workdayRule: WorkdayRule;
  holidaySource: HolidayPreferences;
  holidayPackages: HolidayPackage[];
  holidayState: HolidaySyncState | null;
  holidayLookup: HolidayLookup;
  dateExceptions: DateException[];
  refresh: () => Promise<void>;
  createEvent: (input: NewEvent) => Promise<Event>;
  updateEvent: (id: string, input: EventUpdate) => Promise<Event>;
  removeEvent: (id: string) => Promise<void>;
  createCountdown: (input: NewCountdown) => Promise<Countdown>;
  updateCountdown: (id: string, input: CountdownUpdate) => Promise<Countdown>;
  removeCountdown: (id: string) => Promise<void>;
  setShowLunar: (value: boolean) => Promise<void>;
};

export const defaultCalendarSource: CalendarSource = {
  events: createEventRepository(db),
  countdowns: createCountdownRepository(db),
  settings: {
    list: (query) => db.settings.list(query),
    set: (input) => db.settings.set(input),
  },
  holidays: createDefaultHolidaySyncService(),
};

const CalendarDataContext = createContext<CalendarDataValue | null>(null);

function formatError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message || '操作失败，请重试';
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '操作失败，请重试';
}

export type CalendarDataProviderProps = {
  children: ReactNode;
  source?: CalendarSource;
  available?: boolean;
};

export function CalendarDataProvider({
  children,
  source,
  available,
}: CalendarDataProviderProps) {
  const sourceRef = useRef<CalendarSource>(source ?? defaultCalendarSource);
  const runtimeAvailable =
    available ?? (source !== undefined ? true : isTauriRuntime());
  const [status, setStatus] = useState<CalendarStatus>(
    runtimeAvailable ? 'loading' : 'unavailable',
  );
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [countdowns, setCountdowns] = useState<Countdown[]>([]);
  const [showLunar, setShowLunarState] = useState(true);
  const [weekStart, setWeekStartState] = useState<WeekStart>(
    normalizeWeekStart(undefined),
  );
  const [workdayRule, setWorkdayRuleState] = useState<WorkdayRule>(
    normalizeWorkdayRule(DEFAULT_WORKDAY_RULE),
  );
  const [holidaySource, setHolidaySourceState] = useState<HolidayPreferences>(
    { ...DEFAULT_HOLIDAY_PREFERENCES },
  );
  const [holidayPackages, setHolidayPackagesState] = useState<
    HolidayPackage[]
  >([]);
  const [holidayState, setHolidayState] = useState<HolidaySyncState | null>(
    null,
  );
  const [dateExceptions, setDateExceptionsState] = useState<DateException[]>(
    [],
  );
  const mounted = useRef(true);

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
      const current = sourceRef.current;
      const [nextEvents, nextCountdowns, settings] = await Promise.all([
        current.events.list(),
        current.countdowns.list(),
        current.settings?.list({ scope: 'device' }) ?? Promise.resolve([]),
      ]);
      if (!mounted.current) {
        return;
      }
      setEvents(nextEvents);
      setCountdowns(nextCountdowns);
      const calendar = parseStoredSettings(settings).calendar;
      setShowLunarState(calendar.showLunar);
      setWeekStartState(calendar.weekStart);
      setWorkdayRuleState(calendar.workdayRule);
      setHolidaySourceState(calendar.holidaySource);
      setDateExceptionsState(calendar.dateExceptions);

      let packages: HolidayPackage[] = [];
      let holidaySyncState: HolidaySyncState | null = null;
      const holidayService = current.holidays;
      if (holidayService) {
        try {
          [packages, holidaySyncState] = await Promise.all([
            holidayService.listPackages(),
            holidayService.getState(),
          ]);
        } catch {
          // 缓存读取失败只影响节假日标记，不挡住事件/倒数日加载。
          packages = [];
          holidaySyncState = null;
        }
      }
      setHolidayPackagesState(packages);
      setHolidayState(holidaySyncState);
      setRuntimeHolidayPackages(
        calendar.holidaySource.source === 'builtin' ? [] : packages,
      );

      // 自动同步在后台进行：先展示上次成功缓存，完成后替换；失败保留缓存。
      if (
        holidayService &&
        holidayService.maybeAutoSync &&
        calendar.holidaySource.autoSync &&
        calendar.holidaySource.source !== 'builtin'
      ) {
        const source = calendar.holidaySource;
        void holidayService
          .maybeAutoSync(source)
          .then(async () => {
            const [nextPackages, nextState] = await Promise.all([
              holidayService.listPackages(),
              holidayService.getState(),
            ]);
            if (!mounted.current) return;
            setHolidayPackagesState(nextPackages);
            setHolidayState(nextState);
            setRuntimeHolidayPackages(nextPackages);
          })
          .catch(async () => {
            const nextState = await holidayService
              .getState()
              .catch(() => null);
            if (!mounted.current) return;
            setHolidayState(nextState);
          });
      }

      setError(null);
      setStatus('ready');
    } catch (reason) {
      const message = formatError(reason);
      if (!mounted.current) {
        return;
      }
      setError(message);
      setStatus((currentStatus) =>
        currentStatus === 'ready' ? 'ready' : 'error',
      );
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
      throw new Error('需在桌面壳内使用本地库');
    }
  }, [runtimeAvailable]);

  const createEvent = useCallback(
    async (input: NewEvent) => {
      ensureAvailable();
      const event = await sourceRef.current.events.create(input);
      await refresh();
      return event;
    },
    [ensureAvailable, refresh],
  );

  const updateEvent = useCallback(
    async (id: string, input: EventUpdate) => {
      ensureAvailable();
      const event = await sourceRef.current.events.update(id, input);
      await refresh();
      return event;
    },
    [ensureAvailable, refresh],
  );

  const removeEvent = useCallback(
    async (id: string) => {
      ensureAvailable();
      await sourceRef.current.events.remove(id);
      await refresh();
    },
    [ensureAvailable, refresh],
  );

  const createCountdown = useCallback(
    async (input: NewCountdown) => {
      ensureAvailable();
      const countdown = await sourceRef.current.countdowns.create(input);
      await refresh();
      return countdown;
    },
    [ensureAvailable, refresh],
  );

  const updateCountdown = useCallback(
    async (id: string, input: CountdownUpdate) => {
      ensureAvailable();
      const countdown = await sourceRef.current.countdowns.update(id, input);
      await refresh();
      return countdown;
    },
    [ensureAvailable, refresh],
  );

  const removeCountdown = useCallback(
    async (id: string) => {
      ensureAvailable();
      await sourceRef.current.countdowns.remove(id);
      await refresh();
    },
    [ensureAvailable, refresh],
  );

  const setShowLunar = useCallback(
    async (value: boolean) => {
      ensureAvailable();
      const previous = showLunar;
      setShowLunarState(value);
      try {
        const settings = sourceRef.current.settings;
        if (settings) {
          await settings.set({
            scope: 'device',
            key: SHOW_LUNAR_KEY,
            value,
          });
        }
      } catch (reason) {
        setShowLunarState(previous);
        throw reason;
      }
    },
    [ensureAvailable, showLunar],
  );

  const holidayLookup = useMemo<HolidayLookup>(
    () =>
      holidaySource.source === 'builtin'
        ? builtinHolidayLookup
        : createHolidayLookup(holidayPackages),
    [holidayPackages, holidaySource.source],
  );

  const value = useMemo<CalendarDataValue>(
    () => ({
      status,
      error,
      events,
      countdowns,
      showLunar,
      weekStart,
      workdayRule,
      holidaySource,
      holidayPackages,
      holidayState,
      holidayLookup,
      dateExceptions,
      refresh,
      createEvent,
      updateEvent,
      removeEvent,
      createCountdown,
      updateCountdown,
      removeCountdown,
      setShowLunar,
    }),
    [
      status,
      error,
      events,
      countdowns,
      showLunar,
      weekStart,
      workdayRule,
      holidaySource,
      holidayPackages,
      holidayState,
      holidayLookup,
      dateExceptions,
      refresh,
      createEvent,
      updateEvent,
      removeEvent,
      createCountdown,
      updateCountdown,
      removeCountdown,
      setShowLunar,
    ],
  );

  return (
    <CalendarDataContext.Provider value={value}>
      {children}
    </CalendarDataContext.Provider>
  );
}

export function useCalendarData(): CalendarDataValue {
  const context = useContext(CalendarDataContext);
  if (!context) {
    throw new Error('useCalendarData 必须在 CalendarDataProvider 内使用');
  }
  return context;
}

/** 日历域门禁：加载 / 浏览器不可用 / 读取失败。 */
export function CalendarDataGate({ children }: { children: ReactNode }) {
  const { status, error, refresh } = useCalendarData();

  if (status === 'loading') {
    return (
      <div className="task-state-card" role="status" aria-live="polite">
        <h2>正在读取本地日历库…</h2>
        <p>事件与倒数日都从本机 SQLite 读取。</p>
      </div>
    );
  }

  if (status === 'unavailable') {
    return (
      <div className="task-state-card">
        <span className="task-state-mark" aria-hidden="true">
          历
        </span>
        <h2>需在桌面壳内使用本地库</h2>
        <p>
          事件与倒数日保存在本机 SQLite，浏览器预览没有 Tauri IPC 通道。
          请使用 <code>pnpm --filter app tauri dev</code> 启动桌面壳。
        </p>
        <p className="task-state-note">
          这里不会回退到 localStorage，也不会生成演示数据。
        </p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="task-state-card" role="alert">
        <h2>本地日历库读取失败</h2>
        <p>{error ?? '未知错误，请稍后重试。'}</p>
        <button
          type="button"
          className="task-button"
          onClick={() => {
            void refresh().catch(() => undefined);
          }}
        >
          重试
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
