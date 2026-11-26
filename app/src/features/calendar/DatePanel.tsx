/** 桌面端固定日期面板：选中日的农历、休班与任务/事件/倒数日分组。 */

import {
  countdownDayLabel,
  countdownTone,
} from '../../data/calendar/countdowns';
import {
  formatDayTitle,
  formatLunarText,
} from '../../data/calendar';
import {
  DATE_EXCEPTION_KIND_LABELS,
  dateExceptionOn,
  type DateException,
} from '../../data/calendar/exceptions';
import { dayMeta, type HolidayLookup } from '../../data/calendar/holidays';
import type { Countdown, Event, Task } from '../../data/db/types';
import { eventTime } from '../events/eventRepository';
import { isIcsEvent } from './ics/types';
import {
  countdownsOnDate,
  eventsOnDate,
  tasksOnDate,
  type CalendarEntry,
} from './viewModel';
import {
  DEFAULT_WORKDAY_RULE,
  workdayStatus,
  workdayStatusLabel,
  type WorkdayRule,
} from './workweek';

export type DatePanelProps = {
  selectedDate: string;
  today: string;
  tasks: Task[];
  events: Event[];
  countdowns: Countdown[];
  showLunar: boolean;
  workdayRule?: WorkdayRule;
  holidayLookup?: HolidayLookup;
  dateExceptions?: readonly DateException[];
  onNewTask: () => void;
  onNewEvent: () => void;
  onNewCountdown: () => void;
  onOpenTask: (entry: CalendarEntry) => void;
  onOpenEvent: (entry: CalendarEntry) => void;
  onOpenCountdown: (entry: CalendarEntry) => void;
};

export function DatePanel({
  selectedDate,
  today,
  tasks,
  events,
  countdowns,
  showLunar,
  workdayRule = DEFAULT_WORKDAY_RULE,
  holidayLookup,
  dateExceptions = [],
  onNewTask,
  onNewEvent,
  onNewCountdown,
  onOpenTask,
  onOpenEvent,
  onOpenCountdown,
}: DatePanelProps) {
  const exception = dateExceptionOn(selectedDate, dateExceptions);
  const meta = dayMeta(selectedDate, { holidayLookup, exception });
  const dayStatus = workdayStatus(selectedDate, workdayRule, {
    exceptions: dateExceptions,
    holidayLookup,
  });
  const dayTasks = tasksOnDate(tasks, selectedDate, true);
  const dayEvents = eventsOnDate(events, selectedDate);
  const dayCountdowns = countdownsOnDate(countdowns, selectedDate, today);

  return (
    <aside className="calendar-date-panel" data-testid="day-panel" data-workday={dayStatus}>
      <header className="calendar-date-panel-head">
        <h3>{formatDayTitle(selectedDate)}</h3>
        <p className="calendar-date-panel-workday">
          {workdayStatusLabel(dayStatus)}
        </p>
        {showLunar ? (
          <p>{formatLunarText(selectedDate, { includeZodiac: true })}</p>
        ) : null}
        {meta.holiday ? (
          <p
            className={`calendar-date-panel-holiday calendar-date-panel-holiday--${meta.holiday.kind}`}
          >
            {meta.holiday.name} · {meta.holiday.label}
            {meta.holiday.kind === 'makeup' ? '（调休上班）' : ''}
          </p>
        ) : null}
        {meta.exception ? (
          <p className="calendar-date-panel-exception" role="note">
            个人例外 · {DATE_EXCEPTION_KIND_LABELS[meta.exception.kind]}
            {meta.exception.note ? `：${meta.exception.note}` : ''}
          </p>
        ) : null}
      </header>

      <section className="calendar-panel-group" aria-label="当天任务">
        <div className="calendar-panel-group-head">
          <span>任务</span>
          <small>可完成</small>
        </div>
        {dayTasks.length > 0 ? (
          dayTasks.map((task) => (
            <button
              type="button"
              className={
                task.status === 'done'
                  ? 'calendar-panel-row calendar-panel-row--task calendar-panel-row--done'
                  : 'calendar-panel-row calendar-panel-row--task'
              }
              key={task.id}
              data-task-id={task.id}
              onClick={() =>
                onOpenTask({
                  kind: 'task',
                  id: task.id,
                  title: task.title,
                  time: task.dueTime,
                  task,
                })
              }
            >
              <span className="calendar-panel-key" aria-hidden="true" />
              <span className="calendar-panel-time">
                {task.dueTime ?? '全天'}
              </span>
              <b>{task.title}</b>
              {task.status === 'done' ? (
                <span className="calendar-panel-status">已完成</span>
              ) : null}
            </button>
          ))
        ) : (
          <p className="calendar-panel-empty">当天没有任务</p>
        )}
      </section>

      <section className="calendar-panel-group" aria-label="当天事件">
        <div className="calendar-panel-group-head">
          <span>事件</span>
          <small>占时间 · 不完成</small>
        </div>
        {dayEvents.length > 0 ? (
          dayEvents.map((event) => (
            <button
              type="button"
              className="calendar-panel-row calendar-panel-row--event"
              key={event.id}
              data-event-id={event.id}
              onClick={() =>
                onOpenEvent({
                  kind: 'event',
                  id: event.id,
                  title: event.title,
                  time: eventTime(event),
                  event,
                })
              }
            >
              <span className="calendar-panel-key" aria-hidden="true" />
              <span className="calendar-panel-time">
                {eventTime(event) ?? '全天'}
              </span>
              <b>{event.title}</b>
              {isIcsEvent(event) ? (
                <span className="calendar-panel-readonly">只读</span>
              ) : null}
            </button>
          ))
        ) : (
          <p className="calendar-panel-empty">当天没有事件</p>
        )}
      </section>

      <section className="calendar-panel-group" aria-label="当天倒数日">
        <div className="calendar-panel-group-head">
          <span>倒数日</span>
          <small>只计数</small>
        </div>
        {dayCountdowns.length > 0 ? (
          dayCountdowns.map((countdown) => {
            const tone = countdownTone(countdown, today);
            return (
              <button
                type="button"
                className={`calendar-panel-row calendar-panel-row--countdown calendar-panel-row--${tone}`}
                key={countdown.id}
                data-countdown-id={countdown.id}
                onClick={() =>
                  onOpenCountdown({
                    kind: 'countdown',
                    id: countdown.id,
                    title: countdown.title,
                    time: null,
                    countdown,
                  })
                }
              >
                <span className="calendar-panel-key" aria-hidden="true" />
                <span className="calendar-panel-time">
                  {countdownDayLabel(countdown, today)}
                </span>
                <b>{countdown.title}</b>
              </button>
            );
          })
        ) : (
          <p className="calendar-panel-empty">当天没有倒数日</p>
        )}
      </section>

      <div className="calendar-panel-actions">
        <button
          type="button"
          className="task-button task-button--small"
          aria-label="日期面板新建任务"
          onClick={onNewTask}
        >
          ＋ 任务
        </button>
        <button
          type="button"
          className="task-button task-button--small"
          aria-label="日期面板新建事件"
          onClick={onNewEvent}
        >
          ＋ 事件
        </button>
        <button
          type="button"
          className="task-button task-button--small"
          aria-label="日期面板新建倒数日"
          onClick={onNewCountdown}
        >
          ＋ 倒数日
        </button>
      </div>
    </aside>
  );
}
