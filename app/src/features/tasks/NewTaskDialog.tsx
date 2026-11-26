/** 新建任务弹层：标题必填；日期可空，未安排仍属于所选清单。 */

import { useEffect, useId, useState } from 'react';

import type { List, NewTask } from '../../data/db/types';
import { DatePicker } from '../../ui/date';
import { formatError } from './TaskStore';
import { PRIORITY_LABELS, QUADRANTS } from './viewModel';

export type NewTaskDialogProps = {
  open: boolean;
  lists: List[];
  inboxId: string | null;
  defaultListId: string;
  defaultDate: string | null;
  defaultQuadrant?: number;
  onClose: () => void;
  onSubmit: (input: NewTask, subtaskTitles: string[]) => Promise<void>;
};

type SubtaskDraft = { key: number; title: string };

function firstUsableListId(lists: List[], fallback: string): string {
  return (
    lists.find((list) => !list.isInbox && list.deletedAt === null)?.id ??
    fallback
  );
}

export function NewTaskDialog({
  open,
  lists,
  defaultListId,
  defaultDate,
  defaultQuadrant = 4,
  onClose,
  onSubmit,
}: NewTaskDialogProps) {
  const titleId = useId();
  const userLists = lists.filter(
    (list) => !list.isInbox && list.deletedAt === null,
  );
  const [title, setTitle] = useState('');
  const [listId, setListId] = useState(() =>
    firstUsableListId(userLists, defaultListId),
  );
  const [date, setDate] = useState(defaultDate ?? '');
  const [time, setTime] = useState('');
  const [priority, setPriority] = useState(0);
  const [quadrant, setQuadrant] = useState(defaultQuadrant);
  const [notes, setNotes] = useState('');
  const [subtasks, setSubtasks] = useState<SubtaskDraft[]>([]);
  const [draftSubtask, setDraftSubtask] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dateValid, setDateValid] = useState(true);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTitle('');
    setListId(
      firstUsableListId(lists, defaultListId),
    );
    setDate(defaultDate ?? '');
    setTime('');
    setPriority(0);
    setQuadrant(defaultQuadrant);
    setNotes('');
    setSubtasks([]);
    setDraftSubtask('');
    setError(null);
    setSubmitting(false);
    setDateValid(true);
  }, [open, defaultListId, defaultDate, defaultQuadrant, lists]);

  if (!open) {
    return null;
  }

  const noDate = date.trim() === '';

  const handleDateChange = (value: string) => {
    setDate(value);
    if (value.trim() && !userLists.some((list) => list.id === listId)) {
      setListId(firstUsableListId(userLists, ''));
    }
  };

  const addSubtask = () => {
    const value = draftSubtask.trim();
    if (!value) {
      return;
    }
    setSubtasks((current) => [
      ...current,
      { key: Date.now() + current.length, title: value },
    ]);
    setDraftSubtask('');
  };

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError('请先写任务标题');
      return;
    }
    if (!dateValid) {
      setError('请先修正日期');
      return;
    }
    const finalListId = userLists.some((list) => list.id === listId)
      ? listId
      : firstUsableListId(userLists, '');
    if (!finalListId) {
      setError('请先创建一个清单');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(
        {
          title: trimmed,
          listId: finalListId,
          status: 'todo',
          priority,
          quadrant,
          dueDate: date.trim() || null,
          dueTime: date.trim() && time.trim() ? time : null,
          notes: notes.trim(),
        },
        subtasks.map((subtask) => subtask.title),
      );
    } catch (reason) {
      setError(formatError(reason));
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
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>新建任务</h2>
        <p className="task-dialog-desc">
          任务只保留执行必需的字段；无日期任务会进入未安排，之后再分诊。
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="task-field">
            <label htmlFor={`${titleId}-title`}>标题</label>
            <input
              id={`${titleId}-title`}
              autoFocus
              value={title}
              placeholder="要做什么？"
              onChange={(event) => {
                setTitle(event.target.value);
                if (error) {
                  setError(null);
                }
              }}
            />
          </div>

          <div className="task-field-row">
            <div className="task-field">
              <label htmlFor={`${titleId}-list`}>清单</label>
              <select
                id={`${titleId}-list`}
                value={userLists.some((list) => list.id === listId) ? listId : ''}
                disabled={userLists.length === 0}
                onChange={(event) => setListId(event.target.value)}
              >
                {userLists.length === 0 ? (
                  <option value="">请先创建清单</option>
                ) : null}
                {userLists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="task-field">
              <label htmlFor={`${titleId}-date`}>日期</label>
              <DatePicker
                id={`${titleId}-date`}
                value={date || null}
                emptyLabel="未安排"
                onValidityChange={setDateValid}
                onChange={(next) => handleDateChange(next ?? '')}
              />
            </div>
          </div>

          <div className="task-field-row">
            <div className="task-field">
              <label htmlFor={`${titleId}-time`}>时间</label>
              <input
                id={`${titleId}-time`}
                type="time"
                value={time}
                disabled={noDate}
                onChange={(event) => setTime(event.target.value)}
              />
            </div>
            <div className="task-field">
              <label htmlFor={`${titleId}-priority`}>优先级</label>
              <select
                id={`${titleId}-priority`}
                value={priority}
                onChange={(event) => setPriority(Number(event.target.value))}
              >
                {PRIORITY_LABELS.map((label, value) => (
                  <option key={label} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="task-field">
            <label htmlFor={`${titleId}-quadrant`}>象限</label>
            <select
              id={`${titleId}-quadrant`}
              value={quadrant}
              onChange={(event) => setQuadrant(Number(event.target.value))}
            >
              {QUADRANTS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.title}
                </option>
              ))}
            </select>
          </div>

          <div className="task-field">
            <label htmlFor={`${titleId}-notes`}>备注</label>
            <textarea
              id={`${titleId}-notes`}
              rows={3}
              value={notes}
              placeholder="执行要点、链接、上下文…"
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>

          <div className="task-field">
            <span className="task-field-label">子任务</span>
            {subtasks.length > 0 ? (
              <ol className="task-draft-subtasks">
                {subtasks.map((subtask) => (
                  <li key={subtask.key}>
                    <span>{subtask.title}</span>
                    <button
                      type="button"
                      className="task-link-button"
                      aria-label={`移除子任务：${subtask.title}`}
                      onClick={() =>
                        setSubtasks((current) =>
                          current.filter((item) => item.key !== subtask.key),
                        )
                      }
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ol>
            ) : null}
            <div className="task-subtask-form">
              <input
                aria-label="新子任务"
                value={draftSubtask}
                placeholder="例如：先确认范围"
                onChange={(event) => setDraftSubtask(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addSubtask();
                  }
                }}
              />
              <button
                type="button"
                className="task-button task-button--small"
                onClick={addSubtask}
              >
                添加
              </button>
            </div>
          </div>

          {noDate ? (
            <p className="task-dialog-hint">
              未安排日期：创建后进入「未安排」，仍属于所选清单。
            </p>
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
              {submitting ? '创建中…' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
