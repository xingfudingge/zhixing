/**
 * 测试用内存 CalendarSource：只服务 vitest，语义贴近 Rust 仓储
 * （软删除、版本号 +1、事件/倒数日各自独立）。
 */

import type {
  Countdown,
  CountdownQuery,
  CountdownUpdate,
  Event,
  EventQuery,
  EventUpdate,
  NewCountdown,
  NewEvent,
  NewSetting,
  Setting,
  SettingQuery,
} from '../../../data/db/types';
import type { CalendarSource } from '../CalendarStore';

const NOW = '2026-10-20T00:00:00.000Z';

export function makeEvent(
  overrides: Partial<Event> & Pick<Event, 'id' | 'title' | 'startDate'>,
): Event {
  return {
    spaceId: 'personal',
    eventType: '个人日程',
    allDay: false,
    startAt: null,
    endAt: null,
    tz: 'Asia/Shanghai',
    source: 'local',
    externalUid: null,
    repeatRule: '单次',
    calendarType: 'solar',
    noteId: null,
    color: '',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function makeCountdown(
  overrides: Partial<Countdown> &
    Pick<Countdown, 'id' | 'title' | 'targetDate'>,
): Countdown {
  return {
    spaceId: 'personal',
    category: '自定义',
    calendarType: 'solar',
    repeatRule: '单次',
    lunarMonth: null,
    lunarDay: null,
    note: '',
    color: '',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type FakeCalendarSource = CalendarSource & {
  snapshot: () => {
    events: Event[];
    countdowns: Countdown[];
    settings: Setting[];
  };
  calls: string[];
};

export function createFakeCalendarSource(seed?: {
  events?: Event[];
  countdowns?: Countdown[];
  settings?: Setting[];
}): FakeCalendarSource {
  let events = (seed?.events ?? []).map(clone);
  let countdowns = (seed?.countdowns ?? []).map(clone);
  let settings = (seed?.settings ?? []).map(clone);
  const calls: string[] = [];
  let sequence = 0;

  const nextId = (prefix: string) => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };

  const activeEvents = () => events.filter((event) => event.deletedAt === null);
  const activeCountdowns = () =>
    countdowns.filter((countdown) => countdown.deletedAt === null);

  const source: FakeCalendarSource = {
    calls,
    snapshot: () => clone({ events, countdowns, settings }),
    events: {
      async list(query: EventQuery = {}) {
        calls.push('events.list');
        return clone(
          activeEvents()
            .filter(
              (event) =>
                (!query.from || event.startDate >= query.from) &&
                (!query.to || event.startDate <= query.to) &&
                (!query.noteId || event.noteId === query.noteId),
            )
            .sort((a, b) => {
              if (a.startDate !== b.startDate) {
                return a.startDate.localeCompare(b.startDate);
              }
              return (a.startAt ?? '').localeCompare(b.startAt ?? '');
            }),
        );
      },
      async create(input: NewEvent) {
        calls.push('events.create');
        const title = input.title.trim();
        if (!title) {
          throw new Error('事件标题不能为空');
        }
        const event = makeEvent({
          id: input.id ?? nextId('event'),
          title,
          startDate: input.startDate,
          eventType: input.eventType ?? '个人日程',
          allDay: input.allDay ?? false,
          startAt: input.startAt ?? null,
          endAt: input.endAt ?? null,
          tz: input.tz ?? 'Asia/Shanghai',
          source: input.source ?? 'local',
          externalUid: input.externalUid ?? null,
          repeatRule: input.repeatRule ?? '单次',
          calendarType: input.calendarType ?? 'solar',
          noteId: input.noteId ?? null,
          color: input.color ?? '',
        });
        events = [...events, event];
        return clone(event);
      },
      async update(id: string, input: EventUpdate) {
        calls.push('events.update');
        const index = events.findIndex(
          (event) => event.id === id && event.deletedAt === null,
        );
        if (index < 0) {
          throw new Error(`事件不存在：${id}`);
        }
        const next: Event = {
          ...events[index],
          title: input.title.trim(),
          eventType: input.eventType,
          allDay: input.allDay,
          startDate: input.startDate,
          startAt: input.startAt,
          endAt: input.endAt,
          tz: input.tz ?? events[index].tz,
          source: input.source ?? events[index].source,
          externalUid: input.externalUid ?? null,
          repeatRule: input.repeatRule ?? '单次',
          calendarType: input.calendarType,
          noteId: input.noteId ?? null,
          color: input.color ?? '',
          updatedAt: NOW,
          version: events[index].version + 1,
        };
        events = events.map((event) => (event.id === id ? next : event));
        return clone(next);
      },
      async remove(id: string) {
        calls.push('events.remove');
        events = events.map((event) =>
          event.id === id
            ? {
                ...event,
                deletedAt: NOW,
                updatedAt: NOW,
                version: event.version + 1,
              }
            : event,
        );
      },
    },
    countdowns: {
      async list(query: CountdownQuery = {}) {
        calls.push('countdowns.list');
        return clone(
          activeCountdowns().filter(
            (countdown) =>
              !query.category || countdown.category === query.category,
          ),
        );
      },
      async create(input: NewCountdown) {
        calls.push('countdowns.create');
        const title = input.title.trim();
        if (!title) {
          throw new Error('倒数日标题不能为空');
        }
        const countdown = makeCountdown({
          id: input.id ?? nextId('countdown'),
          title,
          targetDate: input.targetDate,
          category: input.category ?? '自定义',
          calendarType: input.calendarType ?? 'solar',
          repeatRule: input.repeatRule ?? '单次',
          lunarMonth: input.lunarMonth ?? null,
          lunarDay: input.lunarDay ?? null,
          note: input.note ?? '',
          color: input.color ?? '',
        });
        countdowns = [...countdowns, countdown];
        return clone(countdown);
      },
      async update(id: string, input: CountdownUpdate) {
        calls.push('countdowns.update');
        const index = countdowns.findIndex(
          (countdown) =>
            countdown.id === id && countdown.deletedAt === null,
        );
        if (index < 0) {
          throw new Error(`倒数日不存在：${id}`);
        }
        const next: Countdown = {
          ...countdowns[index],
          title: input.title.trim(),
          category: input.category,
          calendarType: input.calendarType,
          targetDate: input.targetDate,
          repeatRule: input.repeatRule,
          lunarMonth: input.lunarMonth,
          lunarDay: input.lunarDay,
          note: input.note,
          color: input.color ?? '',
          updatedAt: NOW,
          version: countdowns[index].version + 1,
        };
        countdowns = countdowns.map((countdown) =>
          countdown.id === id ? next : countdown,
        );
        return clone(next);
      },
      async remove(id: string) {
        calls.push('countdowns.remove');
        countdowns = countdowns.map((countdown) =>
          countdown.id === id
            ? {
                ...countdown,
                deletedAt: NOW,
                updatedAt: NOW,
                version: countdown.version + 1,
              }
            : countdown,
        );
      },
    },
    settings: {
      async list(query: SettingQuery = {}) {
        calls.push('settings.list');
        return clone(
          settings.filter(
            (setting) => !query.scope || setting.scope === query.scope,
          ),
        );
      },
      async set(input: NewSetting) {
        calls.push('settings.set');
        const existing = settings.find(
          (setting) =>
            setting.scope === (input.scope ?? 'device') &&
            setting.key === input.key,
        );
        const setting: Setting = {
          id: input.id ?? existing?.id ?? nextId('setting'),
          spaceId: input.spaceId ?? 'personal',
          scope: input.scope ?? 'device',
          key: input.key,
          value: input.value,
          createdAt: existing?.createdAt ?? NOW,
          updatedAt: NOW,
          deletedAt: null,
          version: (existing?.version ?? 0) + 1,
        };
        settings = existing
          ? settings.map((item) => (item.id === existing.id ? setting : item))
          : [...settings, setting];
        return clone(setting);
      },
    },
  };

  return source;
}
