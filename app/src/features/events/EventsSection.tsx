/**
 * 事件分区：当天事件 + 本月其他事件。
 * 每行只有「建任务 / 编辑 / 删除」，没有完成控件。
 */

import { useMemo, useState } from 'react';

import { formatDayTitle, formatMonthDay } from '../../data/calendar/date';
import type { Event } from '../../data/db/types';
import { isIcsEvent } from '../calendar/ics/types';
import { ConfirmDialog } from '../tasks/Feedback';
import { eventCalendarLabel, eventTime } from './eventRepository';

export type EventsSectionProps = {
  selectedDate: string;
  events: Event[];
  onNew: () => void;
  onEdit: (event: Event) => void;
  onDelete: (event: Event) => Promise<void>;
  onCreateTask: (event: Event) => void;
  busyEventId?: string | null;
};

function EventRow({
  event,
  onEdit,
  onDelete,
  onCreateTask,
  busy = false,
  muted = false,
}: {
  event: Event;
  onEdit: (event: Event) => void;
  onDelete: (event: Event) => Promise<void>;
  onCreateTask: (event: Event) => void;
  busy?: boolean;
  muted?: boolean;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const time = eventTime(event);
  const readOnly = isIcsEvent(event);

  return (
    <>
      <div
        className={[
          muted ? 'event-row event-row--muted' : 'event-row',
          readOnly ? 'event-row--readonly' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        data-event-id={event.id}
        data-event-source={event.source}
      >
        <span className="event-dot" aria-hidden="true" />
        <div className="event-main">
          <b>{event.title}</b>
          <small>
            {event.eventType || '个人日程'} · {eventCalendarLabel(event)} ·{' '}
            {event.repeatRule || '单次'}
            {event.noteId ? ' · 关联笔记' : ''}
            {readOnly ? ' · 外部日历' : ''}
          </small>
        </div>
        <span className="event-time">{time ?? '全天'}</span>
        <button
          type="button"
          className="task-button task-button--small"
          aria-label={`从事件「${event.title}」建任务`}
          disabled={busy}
          onClick={() => onCreateTask(event)}
        >
          {busy ? '创建中…' : '建任务'}
        </button>
        {readOnly ? (
          <span className="event-readonly-badge" title="外部 ICS 只读，不可写回">
            外部 · 只读
          </span>
        ) : (
          <>
            <button
              type="button"
              className="task-button task-button--small"
              aria-label={`编辑事件「${event.title}」`}
              onClick={() => onEdit(event)}
            >
              编辑
            </button>
            <button
              type="button"
              className="task-button task-button--small task-button--danger"
              aria-label={`删除事件「${event.title}」`}
              onClick={() => setConfirmOpen(true)}
            >
              删除
            </button>
          </>
        )}
      </div>
      {readOnly ? null : (
        <ConfirmDialog
          open={confirmOpen}
          title="删除这个事件？"
          description={`「${event.title}」会从日历和事件列表移除。已从这个事件创建的任务不会受影响。`}
          confirmLabel="删除事件"
          danger
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            void onDelete(event);
          }}
        />
      )}
    </>
  );
}

export function EventsSection({
  selectedDate,
  events,
  onNew,
  onEdit,
  onDelete,
  onCreateTask,
  busyEventId = null,
}: EventsSectionProps) {
  const dayEvents = useMemo(
    () =>
      events
        .filter((event) => event.startDate === selectedDate)
        .sort((a, b) => {
          const left = eventTime(a) ?? '99:99';
          const right = eventTime(b) ?? '99:99';
          return left.localeCompare(right);
        }),
    [events, selectedDate],
  );

  const monthEvents = useMemo(
    () =>
      events
        .filter(
          (event) =>
            event.startDate !== selectedDate &&
            event.startDate.startsWith(selectedDate.slice(0, 7)),
        )
        .sort((a, b) => a.startDate.localeCompare(b.startDate)),
    [events, selectedDate],
  );

  return (
    <div className="events-section">
      <div className="calendar-info-banner">
        <span className="calendar-info-icon" aria-hidden="true">
          ≠
        </span>
        <div>
          <b>事件和任务不是一回事</b>
          <p>
            <b>事件</b>是时间占位：会议、生日、纪念日，有开始时间、可以重复，
            但没有“完成”状态。<b>任务</b>是要完成的事，有清单、优先级和完成状态。
            需要准备事项时，从事件行点“建任务”创建一条独立任务。
          </p>
        </div>
      </div>

      <section className="event-day" aria-label="当天事件">
        <header className="event-day-head">
          <div>
            <h3>{formatDayTitle(selectedDate)}</h3>
            <p>
              {dayEvents.length} 个事件 · 点编辑可改时间、类别、历法与重复
            </p>
          </div>
          <button
            type="button"
            className="task-button task-button--primary"
            aria-label="事件分区新建事件"
            onClick={onNew}
          >
            ＋ 事件
          </button>
        </header>
        {dayEvents.length > 0 ? (
          dayEvents.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              onEdit={onEdit}
              onDelete={onDelete}
              onCreateTask={onCreateTask}
              busy={busyEventId === event.id}
            />
          ))
        ) : (
          <div className="event-empty">
            这一天没有事件。
            <br />
            任务仍在待办里，不会自动变成事件。
          </div>
        )}
      </section>

      <section className="event-day" aria-label="本月其他事件">
        <header className="event-day-head">
          <div>
            <h3>本月其他事件</h3>
            <p>{selectedDate.slice(0, 7)} 内、除当天外</p>
          </div>
        </header>
        {monthEvents.length > 0 ? (
          monthEvents.map((event) => (
            <div
              className={
                isIcsEvent(event)
                  ? 'event-row event-row--muted event-row--readonly'
                  : 'event-row event-row--muted'
              }
              key={event.id}
              data-event-id={event.id}
              data-event-source={event.source}
            >
              <span className="event-dot event-dot--muted" aria-hidden="true" />
              <div className="event-main">
                <b>{event.title}</b>
                <small>
                  {formatMonthDay(event.startDate)} ·{' '}
                  {event.eventType || '个人日程'} ·{' '}
                  {eventCalendarLabel(event)}
                  {isIcsEvent(event) ? ' · 外部日历' : ''}
                </small>
              </div>
              <span className="event-time">{eventTime(event) ?? '全天'}</span>
              {isIcsEvent(event) ? (
                <span
                  className="event-readonly-badge"
                  title="外部 ICS 只读，不可写回"
                >
                  外部 · 只读
                </span>
              ) : (
                <button
                  type="button"
                  className="task-button task-button--small"
                  aria-label={`编辑事件「${event.title}」`}
                  onClick={() => onEdit(event)}
                >
                  编辑
                </button>
              )}
            </div>
          ))
        ) : (
          <div className="event-empty">本月暂无其他事件</div>
        )}
      </section>
    </div>
  );
}
