/** 事件新建/编辑弹层。事件只有时间与重复，没有完成状态。 */

import { useEffect, useId, useState } from 'react';

import type { CalendarType, Event, Note } from '../../data/db/types';
import { DatePicker, lunarFullLabel } from '../../ui/date';
import {
  EVENT_CALENDAR_TYPES,
  EVENT_REPEAT_RULES,
  EVENT_TYPES,
  eventTime,
} from './eventRepository';

export type EventDraft = {
  title: string;
  date: string;
  time: string;
  eventType: string;
  calendarType: CalendarType;
  repeatRule: string;
  noteId: string;
};

export type EventDialogProps = {
  open: boolean;
  initialDate: string;
  event: Event | null;
  notes: Note[];
  onClose: () => void;
  onSubmit: (draft: EventDraft, eventId?: string) => Promise<void>;
};

function draftFromEvent(event: Event): EventDraft {
  return {
    title: event.title,
    date: event.startDate,
    time: eventTime(event) ?? '',
    eventType: event.eventType || '个人日程',
    calendarType: event.calendarType === 'lunar' ? 'lunar' : 'solar',
    repeatRule: event.repeatRule || '单次',
    noteId: event.noteId ?? '',
  };
}

export function EventDialog({
  open,
  initialDate,
  event,
  notes,
  onClose,
  onSubmit,
}: EventDialogProps) {
  const titleId = useId();
  const [draft, setDraft] = useState<EventDraft>(() =>
    event
      ? draftFromEvent(event)
      : {
          title: '',
          date: initialDate,
          time: '',
          eventType: '个人日程',
          calendarType: 'solar',
          repeatRule: '单次',
          noteId: '',
        },
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dateValid, setDateValid] = useState(true);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(
      event
        ? draftFromEvent(event)
        : {
            title: '',
            date: initialDate,
            time: '',
            eventType: '个人日程',
            calendarType: 'solar',
            repeatRule: '单次',
            noteId: '',
          },
    );
    setError(null);
    setSubmitting(false);
    setDateValid(true);
  }, [open, event, initialDate]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const update = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (error) {
      setError(null);
    }
  };

  const submit = async () => {
    if (!draft.title.trim()) {
      setError('请先写事件标题');
      return;
    }
    if (!draft.date) {
      setError('请选择事件日期');
      return;
    }
    if (!dateValid) {
      setError('请先修正日期');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(
        {
          ...draft,
          title: draft.title.trim(),
          noteId: draft.noteId || '',
        },
        event?.id,
      );
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : '保存事件失败，请重试',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="task-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="task-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(mouseEvent) => mouseEvent.stopPropagation()}
      >
        <h2 id={titleId}>{event ? '编辑事件' : '新建事件'}</h2>
        <p className="task-dialog-desc">
          事件是时间占位，有开始时间、可以重复，但没有完成状态；它不会自动变成任务。
        </p>

        <form
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            void submit();
          }}
        >
          <div className="task-field">
            <label htmlFor={`${titleId}-title`}>标题</label>
            <input
              id={`${titleId}-title`}
              autoFocus
              value={draft.title}
              placeholder="例如：产品评审会"
              onChange={(inputEvent) => update('title', inputEvent.target.value)}
            />
          </div>

          <div className="task-field-row">
            <div className="task-field">
              <label htmlFor={`${titleId}-date`}>日期</label>
              <DatePicker
                id={`${titleId}-date`}
                value={draft.date || null}
                required
                onValidityChange={setDateValid}
                onChange={(next) => update('date', next ?? '')}
              />
            </div>
            <div className="task-field">
              <label htmlFor={`${titleId}-time`}>时间</label>
              <input
                id={`${titleId}-time`}
                type="time"
                value={draft.time}
                onChange={(inputEvent) =>
                  update('time', inputEvent.target.value)
                }
              />
            </div>
          </div>

          <div className="task-field-row">
            <div className="task-field">
              <label htmlFor={`${titleId}-type`}>类别</label>
              <select
                id={`${titleId}-type`}
                value={draft.eventType}
                onChange={(selectEvent) =>
                  update('eventType', selectEvent.target.value)
                }
              >
                {EVENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div className="task-field">
              <label htmlFor={`${titleId}-repeat`}>重复</label>
              <select
                id={`${titleId}-repeat`}
                value={draft.repeatRule}
                onChange={(selectEvent) =>
                  update('repeatRule', selectEvent.target.value)
                }
              >
                {EVENT_REPEAT_RULES.map((rule) => (
                  <option key={rule} value={rule}>
                    {rule}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="task-field-row">
            <div className="task-field">
              <label htmlFor={`${titleId}-calendar`}>历法</label>
              <select
                id={`${titleId}-calendar`}
                value={draft.calendarType}
                onChange={(selectEvent) =>
                  update(
                    'calendarType',
                    selectEvent.target.value === 'lunar' ? 'lunar' : 'solar',
                  )
                }
              >
                {EVENT_CALENDAR_TYPES.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="task-field">
              <label htmlFor={`${titleId}-note`}>关联笔记</label>
              <select
                id={`${titleId}-note`}
                value={draft.noteId}
                onChange={(selectEvent) =>
                  update('noteId', selectEvent.target.value)
                }
              >
                <option value="">不关联</option>
                {notes.map((note) => (
                  <option key={note.id} value={note.id}>
                    {note.title}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {draft.calendarType === 'lunar' ? (
            <>
              <p className="task-dialog-hint">
                农历只是标记：知行不会把农历事件换算成下一次公历日期，下一次生日请用「倒数日」。
              </p>
              {draft.date ? (
                <p
                  className="task-dialog-hint"
                  data-testid="event-lunar-preview"
                >
                  所选公历日对应：{lunarFullLabel(draft.date)}；日期仍按公历保存。
                </p>
              ) : null}
            </>
          ) : null}

          {error ? (
            <p className="task-dialog-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="task-dialog-actions">
            <button type="button" className="task-button" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="task-button task-button--primary"
              disabled={submitting || !dateValid}
            >
              {submitting ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
