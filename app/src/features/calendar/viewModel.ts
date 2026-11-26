/**
 * 日历三视图的纯投影函数。
 *
 * 任务/事件/倒数日不复制数据：全部按日期投影到同一网格。
 * 任务只取 `dueDate`，事件只取 `startDate`，倒数日只取
 * `nextCountdownDate()`；完成状态与倒数日无关联。
 */

import { nextCountdownDate } from '../../data/calendar/countdowns';
import {
  compareTime,
  formatDayTitle,
  formatMonthDay,
  formatMonthTitle,
  timeToMinutes,
} from '../../data/calendar/date';
import type { Countdown, Event, Task } from '../../data/db/types';
import { eventTime } from '../events/eventRepository';
import { weekDaysISO, type WeekStart } from './workweek';

export type CalendarView = 'month' | 'week' | 'day';
export type CalendarTab = 'calendar' | 'events' | 'countdowns' | 'tools';

export const CALENDAR_VIEWS: ReadonlyArray<{
  value: CalendarView;
  label: string;
  short: string;
}> = [
  { value: 'month', label: '月视图', short: '月' },
  { value: 'week', label: '周视图', short: '周' },
  { value: 'day', label: '日视图', short: '日' },
];

export const CALENDAR_TABS: ReadonlyArray<{
  value: CalendarTab;
  label: string;
}> = [
  { value: 'calendar', label: '日历' },
  { value: 'events', label: '事件' },
  { value: 'countdowns', label: '倒数日' },
  { value: 'tools', label: '小工具' },
];

export type TaskEntry = {
  kind: 'task';
  id: string;
  title: string;
  time: string | null;
  task: Task;
};

export type EventEntry = {
  kind: 'event';
  id: string;
  title: string;
  time: string | null;
  event: Event;
};

export type CountdownEntry = {
  kind: 'countdown';
  id: string;
  title: string;
  time: null;
  countdown: Countdown;
};

export type CalendarEntry = TaskEntry | EventEntry | CountdownEntry;

export function taskEntry(task: Task): TaskEntry {
  return {
    kind: 'task',
    id: task.id,
    title: task.title,
    time: task.dueTime,
    task,
  };
}

export function eventEntry(event: Event): EventEntry {
  return {
    kind: 'event',
    id: event.id,
    title: event.title,
    time: eventTime(event),
    event,
  };
}

export function countdownEntry(countdown: Countdown): CountdownEntry {
  return {
    kind: 'countdown',
    id: countdown.id,
    title: countdown.title,
    time: null,
    countdown,
  };
}

export function entryKey(entry: CalendarEntry): string {
  return `${entry.kind}:${entry.id}`;
}

export function entryTimeLabel(entry: CalendarEntry): string {
  return entry.time ?? '全天';
}

export function tasksOnDate(
  tasks: Task[],
  date: string,
  includeDone = false,
): Task[] {
  return tasks.filter(
    (task) =>
      task.dueDate === date && (includeDone || task.status !== 'done'),
  );
}

export function eventsOnDate(events: Event[], date: string): Event[] {
  return events.filter((event) => event.startDate === date);
}

export function countdownsOnDate(
  countdowns: Countdown[],
  date: string,
  today: string,
): Countdown[] {
  return countdowns.filter(
    (countdown) => nextCountdownDate(countdown, today) === date,
  );
}

export function sortEntries(entries: CalendarEntry[]): CalendarEntry[] {
  const kindOrder: Record<CalendarEntry['kind'], number> = {
    task: 0,
    event: 1,
    countdown: 2,
  };
  return [...entries].sort((a, b) => {
    const timeDelta = compareTime(a.time, b.time);
    if (timeDelta !== 0) {
      return timeDelta;
    }
    const kindDelta = kindOrder[a.kind] - kindOrder[b.kind];
    if (kindDelta !== 0) {
      return kindDelta;
    }
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });
}

export function entriesOnDate(
  tasks: Task[],
  events: Event[],
  countdowns: Countdown[],
  date: string,
  today: string,
  options: { includeDoneTasks?: boolean } = {},
): CalendarEntry[] {
  return sortEntries([
    ...tasksOnDate(tasks, date, options.includeDoneTasks ?? false).map(
      taskEntry,
    ),
    ...eventsOnDate(events, date).map(eventEntry),
    ...countdownsOnDate(countdowns, date, today).map(countdownEntry),
  ]);
}

export type MonthCellSelection = {
  visible: CalendarEntry[];
  more: number;
};

/**
 * 月格：任务最多 2 条 + 事件 1 条 + 倒数日 1 条，合计最多 3 条；
 * 隐藏条目汇总为 +N。
 */
export function monthCellSelection(
  tasks: Task[],
  events: Event[],
  countdowns: Countdown[],
  date: string,
  today: string,
): MonthCellSelection {
  const openTasks = tasksOnDate(tasks, date).map(taskEntry);
  const dayEvents = eventsOnDate(events, date).map(eventEntry);
  const dayCountdowns = countdownsOnDate(countdowns, date, today).map(
    countdownEntry,
  );
  const visible = [
    ...openTasks.slice(0, 2),
    ...dayEvents.slice(0, 1),
    ...dayCountdowns.slice(0, 1),
  ].slice(0, 3);
  const total = openTasks.length + dayEvents.length + dayCountdowns.length;
  return { visible, more: Math.max(0, total - visible.length) };
}

export const TIMELINE_START_HOUR = 8;
export const TIMELINE_END_HOUR = 21;
export const TIMELINE_HOURS = Array.from(
  { length: TIMELINE_END_HOUR - TIMELINE_START_HOUR + 1 },
  (_, index) => TIMELINE_START_HOUR + index,
);
export const TIMELINE_SLOT_HEIGHT = 44;

export function isTimelineTime(time: string | null): boolean {
  if (!time) {
    return false;
  }
  const minutes = timeToMinutes(time);
  return (
    minutes !== null &&
    minutes >= TIMELINE_START_HOUR * 60 &&
    minutes <= TIMELINE_END_HOUR * 60
  );
}

/** 08:00–21:00 内按分钟定位；21:30 属于已知边界，不进入时间轴。 */
export function dayTimedEntries(entries: CalendarEntry[]): CalendarEntry[] {
  return entries.filter((entry) => isTimelineTime(entry.time));
}

export function dayAllDayEntries(entries: CalendarEntry[]): CalendarEntry[] {
  return entries.filter(
    (entry) => entry.kind === 'countdown' || entry.time === null,
  );
}

/** 08:00 前、21:00 后的条目：不画进时间轴，但明确列出，绝不静默丢数据。 */
export function dayOutsideTimelineEntries(
  entries: CalendarEntry[],
): CalendarEntry[] {
  return entries.filter(
    (entry) => entry.time !== null && !isTimelineTime(entry.time),
  );
}

export function entryTopOffset(time: string): number {
  const minutes = timeToMinutes(time) ?? 0;
  return ((minutes % 60) / 60) * TIMELINE_SLOT_HEIGHT;
}

/** 月/周/日视图标题；周标题随周起始日重排。 */
export function formatCalendarTitle(
  view: CalendarView,
  selectedDate: string,
  weekStart: WeekStart = 'monday',
): string {
  if (view === 'month') {
    return formatMonthTitle(selectedDate.slice(0, 7));
  }
  if (view === 'week') {
    const days = weekDaysISO(selectedDate, weekStart);
    return `${formatMonthDay(days[0])} – ${formatMonthDay(days[6])}`;
  }
  return formatDayTitle(selectedDate);
}
