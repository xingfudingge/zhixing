/** 周视图：7 列，列顺序随周起始日；列内显示当天全部条目，任务可拖到某列改期。 */

import { useState } from 'react';

import {
  formatMonthDay,
  formatWeekday,
} from '../../data/calendar/date';
import {
  DATE_EXCEPTION_KIND_LABELS,
  dateExceptionOn,
  type DateException,
} from '../../data/calendar/exceptions';
import { dayMeta, type HolidayLookup } from '../../data/calendar/holidays';
import type { Countdown, Event, Task } from '../../data/db/types';
import {
  CalendarChip,
  type CalendarChipPointerHandler,
} from './CalendarChip';
import { entriesOnDate, type CalendarEntry } from './viewModel';
import {
  DEFAULT_WORKDAY_RULE,
  isRestStatus,
  weekDaysISO,
  workdayStatus,
  workdayStatusLabel,
  type WeekStart,
  type WorkdayRule,
} from './workweek';

export type WeekViewProps = {
  selectedDate: string;
  today: string;
  tasks: Task[];
  events: Event[];
  countdowns: Countdown[];
  showLunar: boolean;
  weekStart?: WeekStart;
  workdayRule?: WorkdayRule;
  holidayLookup?: HolidayLookup;
  dateExceptions?: readonly DateException[];
  onSelectDate: (date: string) => void;
  onTaskDragStart: (entry: CalendarEntry) => void;
  onDropTask: (date: string, taskId: string) => void;
  /** Pointer 拖拽中的任务 id（源芯片淡化）。 */
  dragTaskId?: string | null;
  /** Pointer 拖拽当前命中的目标日期（列高亮）。 */
  dragTargetDate?: string | null;
  onPointerDragStart?: CalendarChipPointerHandler;
  onOpenTask: (entry: CalendarEntry) => void;
  onOpenEvent: (entry: CalendarEntry) => void;
  onOpenCountdown: (entry: CalendarEntry) => void;
};

export function WeekView({
  selectedDate,
  today,
  tasks,
  events,
  countdowns,
  showLunar,
  weekStart = 'monday',
  workdayRule = DEFAULT_WORKDAY_RULE,
  holidayLookup,
  dateExceptions = [],
  onSelectDate,
  onTaskDragStart,
  onDropTask,
  dragTaskId = null,
  dragTargetDate = null,
  onPointerDragStart,
  onOpenTask,
  onOpenEvent,
  onOpenCountdown,
}: WeekViewProps) {
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);
  const activeDropDate = dragOverDate ?? dragTargetDate;
  const days = weekDaysISO(selectedDate, weekStart);

  return (
    <div className="calendar-week" data-testid="week-grid">
      {days.map((date) => {
        const exception = dateExceptionOn(date, dateExceptions);
        const meta = dayMeta(date, { holidayLookup, exception });
        const dayStatus = workdayStatus(date, workdayRule, {
          exceptions: dateExceptions,
          holidayLookup,
        });
        const entries = entriesOnDate(
          tasks,
          events,
          countdowns,
          date,
          today,
        );
        const classNames = [
          'calendar-week-column',
          date === selectedDate ? 'calendar-week-column--selected' : '',
          date === today ? 'calendar-week-column--today' : '',
          isRestStatus(dayStatus) ? 'calendar-week-column--rest' : '',
          meta.holiday?.kind === 'holiday'
            ? 'calendar-week-column--holiday'
            : '',
          meta.holiday?.kind === 'makeup' ? 'calendar-week-column--makeup' : '',
          meta.exception
            ? `calendar-week-column--exception-${meta.exception.kind}`
            : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div
            className={classNames}
            key={date}
            data-date={date}
            data-drop-date={date}
            data-workday={dayStatus}
            data-testid={`day-${date}`}
            data-drop-active={activeDropDate === date ? 'true' : undefined}
            aria-label={`${formatMonthDay(date)} ${formatWeekday(date)} ${workdayStatusLabel(dayStatus)}${
              meta.exception
                ? ` 个人例外${DATE_EXCEPTION_KIND_LABELS[meta.exception.kind]}`
                : ''
            }`}
            onClick={() => onSelectDate(date)}
            onDragOver={(event) => {
              event.preventDefault();
              if (event.dataTransfer) {
                event.dataTransfer.dropEffect = 'move';
              }
              setDragOverDate(date);
            }}
            onDragLeave={() => {
              setDragOverDate((current) => (current === date ? null : current));
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragOverDate(null);
              let taskId = '';
              try {
                taskId = event.dataTransfer?.getData('text/plain') ?? '';
              } catch {
                taskId = '';
              }
              onDropTask(date, taskId);
            }}
          >
            <div className="calendar-week-head">
              <span className="calendar-week-weekday">
                {formatWeekday(date)}
              </span>
              <span className="calendar-week-day">
                {formatMonthDay(date)}
              </span>
              {showLunar && meta.lunarLabel ? (
                <span
                  className={
                    meta.solarTerm
                      ? 'calendar-lunar calendar-lunar--term'
                      : 'calendar-lunar'
                  }
                >
                  {meta.lunarLabel}
                </span>
              ) : null}
              {meta.holiday ? (
                <span
                  className={`calendar-holiday calendar-holiday--${meta.holiday.kind}`}
                  title={meta.holiday.name}
                >
                  {meta.holiday.label} {meta.holiday.name}
                </span>
              ) : null}
              {meta.exception ? (
                <span
                  className={`calendar-holiday calendar-holiday--exception-${meta.exception.kind}`}
                  title={`个人例外：${DATE_EXCEPTION_KIND_LABELS[meta.exception.kind]}${
                    meta.exception.note ? ` · ${meta.exception.note}` : ''
                  }`}
                >
                  例 {DATE_EXCEPTION_KIND_LABELS[meta.exception.kind]}
                </span>
              ) : null}
            </div>
            <div className="calendar-week-items">
              {entries.length > 0 ? (
                entries.map((entry) => (
                  <CalendarChip
                    key={`${entry.kind}:${entry.id}`}
                    entry={entry}
                    draggable={entry.kind === 'task'}
                    dragSource={dragTaskId === entry.id}
                    onDragStart={(dragged) => onTaskDragStart(dragged)}
                    onPointerDragStart={onPointerDragStart}
                    onOpenTask={onOpenTask}
                    onOpenEvent={onOpenEvent}
                    onOpenCountdown={onOpenCountdown}
                  />
                ))
              ) : (
                <span className="calendar-week-empty">无安排</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
