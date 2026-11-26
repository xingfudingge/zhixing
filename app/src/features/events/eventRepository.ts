/**
 * 事件仓储与事件→任务纯函数。
 *
 * 事件是时间占位：可以编辑、删除、从事件创建独立任务，
 * 但没有完成状态，也不会因为建任务而改变。
 */

import type { DbClient } from '../../data/db/client';
import type {
  Event,
  EventQuery,
  EventUpdate,
  List,
  NewEvent,
  NewTask,
} from '../../data/db/types';

export type EventRepository = {
  list: (query?: EventQuery) => Promise<Event[]>;
  create: (input: NewEvent) => Promise<Event>;
  update: (id: string, input: EventUpdate) => Promise<Event>;
  remove: (id: string) => Promise<void>;
};

export function createEventRepository(client: DbClient): EventRepository {
  return {
    list: (query: EventQuery = {}) => client.events.list(query),
    create: (input: NewEvent) => client.events.create(input),
    update: (id: string, input: EventUpdate) => client.events.update(id, input),
    remove: (id: string) => client.events.remove(id),
  };
}

export const EVENT_TYPES = [
  '工作日程',
  '个人日程',
  '会议',
  '生日',
  '纪念日',
] as const;

export const EVENT_REPEAT_RULES = [
  '单次',
  '每天',
  '每周',
  '每月',
  '每年',
] as const;

export const EVENT_CALENDAR_TYPES = [
  { value: 'solar', label: '公历' },
  { value: 'lunar', label: '农历' },
] as const;

/** 公历/农历只是标记：未知值一律收敛为公历，不做任何日期换算。 */
export function eventCalendarLabel(
  event: Pick<Event, 'calendarType'>,
): '公历' | '农历' {
  return event.calendarType === 'lunar' ? '农历' : '公历';
}

export function eventTime(event: Pick<Event, 'allDay' | 'startAt'>): string | null {
  if (event.allDay || !event.startAt) {
    return null;
  }
  const match = /(?:T|\s)(\d{2}:\d{2})/.exec(event.startAt);
  return match ? match[1] : null;
}

export function eventStartAt(date: string, time: string): string | null {
  return time ? `${date}T${time}:00` : null;
}

export function eventWhenLabel(event: Event): string {
  const time = eventTime(event);
  return time ? `${event.startDate} ${time}` : `${event.startDate} 全天`;
}

export type EventPatch = Partial<
  Pick<
    Event,
    | 'title'
    | 'eventType'
    | 'allDay'
    | 'startDate'
    | 'startAt'
    | 'endAt'
    | 'tz'
    | 'source'
    | 'externalUid'
    | 'repeatRule'
    | 'calendarType'
    | 'noteId'
    | 'color'
  >
>;

/** 局部修改补全为 Rust `EventUpdate` 要求的完整字段。 */
export function toEventUpdate(event: Event, patch: EventPatch): EventUpdate {
  const next = { ...event, ...patch };
  return {
    title: next.title.trim(),
    eventType: next.eventType || '个人日程',
    allDay: next.allDay,
    startDate: next.startDate,
    startAt: next.startAt,
    endAt: next.endAt,
    tz: next.tz || 'Asia/Shanghai',
    source: next.source || 'local',
    externalUid: next.externalUid,
    repeatRule: next.repeatRule || '单次',
    calendarType: next.calendarType === 'lunar' ? 'lunar' : 'solar',
    noteId: next.noteId,
    color: next.color || '',
  };
}

function pickListForEvent(lists: List[]): List | null {
  return (
    lists.find(
      (list) => !list.isInbox && (list.id === 'work' || list.name === '工作'),
    ) ??
    lists.find((list) => !list.isInbox) ??
    lists.find((list) => list.isInbox) ??
    null
  );
}

/**
 * 从事件创建独立任务（复制语义，不建立事件-任务关系）：
 * 标题「准备：事件标题」、工作清单、象限 1、优先级高、日期/时间沿用事件。
 */
export function buildTaskFromEvent(event: Event, lists: List[]): NewTask {
  const list = pickListForEvent(lists);
  if (!list) {
    throw new Error('找不到可用清单，无法从事件创建任务');
  }
  const time = eventTime(event);
  const when = time
    ? `${event.startDate} ${time}`
    : `${event.startDate} 全天`;
  return {
    title: `准备：${event.title}`,
    listId: list.id,
    status: 'todo',
    priority: 3,
    quadrant: 1,
    dueDate: event.startDate,
    dueTime: time,
    noteId: event.noteId,
    notes: `关联事件：${event.title}（${when}）`,
  };
}
