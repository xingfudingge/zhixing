/** 月视图：固定 6×7，列顺序随周起始日；任务可拖到日期格改期。 */

import { useState } from 'react';

import {
  formatMonthDay,
  formatWeekday,
  monthKeyOf,
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
import {
  monthCellSelection,
  type CalendarEntry,
} from './viewModel';
import {
  DEFAULT_WORKDAY_RULE,
  isRestStatus,
  monthGrid,
  weekNumberFor,
  weekdayLabels,
  workdayStatus,
  workdayStatusLabel,
  type WeekStart,
  type WorkdayRule,
} from './workweek';

export type MonthViewProps = {
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
  /** Pointer 拖拽当前命中的目标日期（格子高亮）。 */
  dragTargetDate?: string | null;
  onPointerDragStart?: CalendarChipPointerHandler;
  onOpenTask: (entry: CalendarEntry) => void;
  onOpenEvent: (entry: CalendarEntry) => void;
  onOpenCountdown: (entry: CalendarEntry) => void;
};

export function MonthView({
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
}: MonthViewProps) {
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);
  const activeDropDate = dragOverDate ?? dragTargetDate;
  const cells = monthGrid(monthKeyOf(selectedDate), weekStart);

  return (
    <div className="calendar-month" data-testid="month-grid">
      <div className="calendar-weekday-row" role="row">
        {weekdayLabels(weekStart).map((weekday) => (
          <div className="calendar-weekday" role="columnheader" key={weekday}>
            {weekday}
          </div>
        ))}
      </div>
      <div className="calendar-month-grid" role="grid" aria-label="月视图">
        {cells.map((cell, index) => {
          const exception = dateExceptionOn(cell.date, dateExceptions);
          const meta = dayMeta(cell.date, { holidayLookup, exception });
          const dayStatus = workdayStatus(cell.date, workdayRule, {
            exceptions: dateExceptions,
            holidayLookup,
          });
          const selection = monthCellSelection(
            tasks,
            events,
            countdowns,
            cell.date,
            today,
          );
          const isSelected = cell.date === selectedDate;
          const isToday = cell.date === today;
          const isDropActive = activeDropDate === cell.date;
          const classNames = [
            'calendar-cell',
            cell.inMonth ? '' : 'calendar-cell--outside',
            isRestStatus(dayStatus) ? 'calendar-cell--rest' : '',
            isSelected ? 'calendar-cell--selected' : '',
            isToday ? 'calendar-cell--today' : '',
            meta.holiday?.kind === 'holiday'
              ? 'calendar-cell--holiday'
              : '',
            meta.holiday?.kind === 'makeup' ? 'calendar-cell--makeup' : '',
            meta.exception
              ? `calendar-cell--exception-${meta.exception.kind}`
              : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div
              className={classNames}
              role="gridcell"
              key={cell.date}
              data-date={cell.date}
              data-drop-date={cell.date}
              data-workday={dayStatus}
              data-testid={`day-${cell.date}`}
              aria-selected={isSelected}
              aria-label={[
                formatMonthDay(cell.date),
                formatWeekday(cell.date),
                workdayStatusLabel(dayStatus),
                meta.exception
                  ? `个人例外${DATE_EXCEPTION_KIND_LABELS[meta.exception.kind]}${
                      meta.exception.note ? ` ${meta.exception.note}` : ''
                    }`
                  : '',
                meta.lunarLabel,
                meta.holiday ? `${meta.holiday.name}${meta.holiday.label}` : '',
                isToday ? '今天' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onSelectDate(cell.date)}
              onDragOver={(event) => {
                event.preventDefault();
                if (event.dataTransfer) {
                  event.dataTransfer.dropEffect = 'move';
                }
                setDragOverDate(cell.date);
              }}
              onDragLeave={() => {
                setDragOverDate((current) =>
                  current === cell.date ? null : current,
                );
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
                onDropTask(cell.date, taskId);
              }}
              data-drop-active={isDropActive ? 'true' : undefined}
            >
              <div className="calendar-cell-head">
                <span className="calendar-day-number">{Number(cell.date.slice(8))}</span>
                {isToday ? (
                  <span className="calendar-today-mark">今天</span>
                ) : null}
                {cell.date === selectedDate ? (
                  <span className="calendar-selected-mark" aria-hidden="true" />
                ) : null}
                {index % 7 === 0 ? (
                  <span className="calendar-week-number">
                    第{weekNumberFor(cell.date, weekStart)}周
                  </span>
                ) : null}
                {meta.holiday ? (
                  <span
                    className={`calendar-holiday calendar-holiday--${meta.holiday.kind}`}
                    title={meta.holiday.name}
                  >
                    {meta.holiday.label}
                  </span>
                ) : null}
                {meta.exception ? (
                  <span
                    className={`calendar-holiday calendar-holiday--exception-${meta.exception.kind}`}
                    title={`个人例外：${DATE_EXCEPTION_KIND_LABELS[meta.exception.kind]}${
                      meta.exception.note ? ` · ${meta.exception.note}` : ''
                    }`}
                  >
                    例
                  </span>
                ) : null}
              </div>

              {showLunar && meta.lunarLabel ? (
                <div
                  className={
                    meta.solarTerm
                      ? 'calendar-lunar calendar-lunar--term'
                      : 'calendar-lunar'
                  }
                >
                  {meta.lunarLabel}
                  {meta.holiday?.kind === 'holiday' ? (
                    <span className="calendar-holiday-name">
                      {' '}
                      {meta.holiday.name}
                    </span>
                  ) : null}
                </div>
              ) : null}

              <div className="calendar-cell-items">
                {selection.visible.map((entry) => (
                  <CalendarChip
                    key={`${entry.kind}:${entry.id}`}
                    entry={entry}
                    compact
                    draggable={entry.kind === 'task'}
                    dragSource={dragTaskId === entry.id}
                    onDragStart={(dragged) => onTaskDragStart(dragged)}
                    onPointerDragStart={onPointerDragStart}
                    onOpenTask={onOpenTask}
                    onOpenEvent={onOpenEvent}
                    onOpenCountdown={onOpenCountdown}
                  />
                ))}
                {selection.more > 0 ? (
                  <span className="calendar-more">+{selection.more} 项</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
