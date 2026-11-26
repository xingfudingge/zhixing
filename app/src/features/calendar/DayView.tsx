/**
 * 日视图：全天区 + 08:00–21:00 时间轴。
 * 21:00 之后/08:00 之前的条目不会画进时间轴，但在「时间轴外」列出，
 * 数据不静默丢失（21:30 不可见是 PRD 记录的已知边界）。
 */

import {
  formatDayTitle,
  formatMonthDay,
  formatWeekday,
  timeToMinutes,
} from '../../data/calendar/date';
import {
  DATE_EXCEPTION_KIND_LABELS,
  dateExceptionOn,
  type DateException,
} from '../../data/calendar/exceptions';
import { dayMeta, type HolidayLookup } from '../../data/calendar/holidays';
import type { Countdown, Event, Task } from '../../data/db/types';
import { CalendarChip } from './CalendarChip';
import {
  dayAllDayEntries,
  dayOutsideTimelineEntries,
  dayTimedEntries,
  entriesOnDate,
  entryTopOffset,
  TIMELINE_HOURS,
  TIMELINE_SLOT_HEIGHT,
  type CalendarEntry,
} from './viewModel';
import {
  DEFAULT_WORKDAY_RULE,
  workdayStatus,
  workdayStatusLabel,
  type WorkdayRule,
} from './workweek';

export type DayViewProps = {
  selectedDate: string;
  today: string;
  tasks: Task[];
  events: Event[];
  countdowns: Countdown[];
  showLunar: boolean;
  workdayRule?: WorkdayRule;
  holidayLookup?: HolidayLookup;
  dateExceptions?: readonly DateException[];
  onOpenTask: (entry: CalendarEntry) => void;
  onOpenEvent: (entry: CalendarEntry) => void;
  onOpenCountdown: (entry: CalendarEntry) => void;
};

function TimelineEntry({
  entry,
  onOpenTask,
  onOpenEvent,
}: {
  entry: CalendarEntry;
  onOpenTask: (entry: CalendarEntry) => void;
  onOpenEvent: (entry: CalendarEntry) => void;
}) {
  if (!entry.time) {
    return null;
  }
  return (
    <button
      type="button"
      className={`calendar-timeline-item calendar-timeline-item--${entry.kind}`}
      style={{ top: `${entryTopOffset(entry.time)}px` }}
      onClick={() => {
        if (entry.kind === 'task') {
          onOpenTask(entry);
        } else {
          onOpenEvent(entry);
        }
      }}
      aria-label={`${entry.time} ${entry.title}`}
    >
      <span>{entry.time}</span>
      <b>{entry.title}</b>
    </button>
  );
}

export function DayView({
  selectedDate,
  today,
  tasks,
  events,
  countdowns,
  showLunar,
  workdayRule = DEFAULT_WORKDAY_RULE,
  holidayLookup,
  dateExceptions = [],
  onOpenTask,
  onOpenEvent,
  onOpenCountdown,
}: DayViewProps) {
  const exception = dateExceptionOn(selectedDate, dateExceptions);
  const meta = dayMeta(selectedDate, { holidayLookup, exception });
  const dayStatus = workdayStatus(selectedDate, workdayRule, {
    exceptions: dateExceptions,
    holidayLookup,
  });
  const entries = entriesOnDate(tasks, events, countdowns, selectedDate, today);
  const allDay = dayAllDayEntries(entries);
  const timed = dayTimedEntries(entries);
  const outside = dayOutsideTimelineEntries(entries);

  return (
    <div className="calendar-day" data-testid="day-view" data-workday={dayStatus}>
      <header className="calendar-day-head">
        <div>
          <h3>{formatDayTitle(selectedDate)}</h3>
          <p>
            {formatMonthDay(selectedDate)} · {formatWeekday(selectedDate)}
            {' · '}
            {workdayStatusLabel(dayStatus)}
            {showLunar && meta.lunarLabel
              ? ` · ${meta.lunarLabel}`
              : ''}
            {meta.holiday
              ? ` · ${meta.holiday.name}${meta.holiday.label}`
              : ''}
            {meta.exception
              ? ` · 个人例外${DATE_EXCEPTION_KIND_LABELS[meta.exception.kind]}${
                  meta.exception.note ? `（${meta.exception.note}）` : ''
                }`
              : ''}
          </p>
        </div>
        <span className="calendar-day-range">08:00 – 21:00</span>
      </header>

      <section className="calendar-allday" aria-label="全天事项">
        <span className="calendar-allday-label">全天</span>
        <div className="calendar-allday-items">
          {allDay.length > 0 ? (
            allDay.map((entry) =>
              entry.kind === 'countdown' ? (
                <CalendarChip
                  key={`countdown:${entry.id}`}
                  entry={entry}
                  onOpenTask={onOpenTask}
                  onOpenEvent={onOpenEvent}
                  onOpenCountdown={onOpenCountdown}
                />
              ) : (
                <CalendarChip
                  key={`${entry.kind}:${entry.id}`}
                  entry={entry}
                  onOpenTask={onOpenTask}
                  onOpenEvent={onOpenEvent}
                  onOpenCountdown={onOpenCountdown}
                />
              ),
            )
          ) : (
            <span className="calendar-day-empty">无全天事项</span>
          )}
        </div>
      </section>

      <div className="calendar-timeline" data-testid="day-timeline">
        {TIMELINE_HOURS.map((hour) => {
          const label = `${String(hour).padStart(2, '0')}:00`;
          const items = timed.filter(
            (entry) =>
              entry.time !== null && timeToMinutes(entry.time) !== null &&
              Math.floor((timeToMinutes(entry.time) as number) / 60) === hour,
          );
          return (
            <div className="calendar-hour-row" key={hour} data-hour={hour}>
              <span className="calendar-hour-label">{label}</span>
              <div
                className="calendar-hour-slot"
                style={{ height: `${TIMELINE_SLOT_HEIGHT}px` }}
              >
                {items.map((entry) => (
                  <TimelineEntry
                    key={`${entry.kind}:${entry.id}`}
                    entry={entry}
                    onOpenTask={onOpenTask}
                    onOpenEvent={onOpenEvent}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {outside.length > 0 ? (
        <section
          className="calendar-outside"
          data-testid="day-outside-timeline"
          aria-label="时间轴外事项"
        >
          <h4>时间轴外（数据仍保留）</h4>
          <p>08:00 前或 21:00 后的条目不在上方时间轴显示，可在这里打开。</p>
          <div className="calendar-outside-items">
            {outside.map((entry) => (
              <button
                type="button"
                key={`${entry.kind}:${entry.id}`}
                className={`calendar-outside-item calendar-outside-item--${entry.kind}`}
                onClick={() => {
                  if (entry.kind === 'task') {
                    onOpenTask(entry);
                  } else if (entry.kind === 'event') {
                    onOpenEvent(entry);
                  }
                }}
              >
                {entry.time} {entry.title}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
