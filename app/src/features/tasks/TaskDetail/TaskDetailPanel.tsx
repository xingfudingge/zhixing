/**
 * 右侧任务详情：字段编辑、子任务、关联笔记、删除与 5 秒撤销。
 *
 * 约定：
 *   * 所有字段写入都走 TaskStore → SQLite 仓储；面板不缓存任务副本。
 *   * 子任务勾选只改子任务，不自动完成父任务。
 *   * 删除任务只软删除任务行；子任务和关联笔记保留。
 *   * “创建于”永远读取 `task.createdAt`，与到期日无关。
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import type { List, Note, Subtask, Task } from '../../../data/db/types';
import type { TaskPatch } from '../../../data/repositories/tasks';
import {
  EXECUTION_NOTE_TEMPLATES,
  type ExecutionNoteTemplate,
} from '../../notes/createFromTask';
import { UndoProvider, useOptionalUndo, useUndo } from '../../../app/undo';
import { DatePicker } from '../../../ui/date';
import {
  AttachmentSection,
  type AttachmentManager,
  type AttachmentUploader,
} from '../../attachments';
import { ConfirmDialog, useToast } from '../Feedback';
import { useTaskAction } from '../actions';
import { formatError, useTaskStore } from '../TaskStore';
import {
  reminderOptionValue,
  TASK_REMINDER_OPTIONS,
} from '../reminders';
import {
  PRIORITY_LABELS,
  QUADRANTS,
  forgetStatusBeforeDone,
  listNameOf,
  statusLabel,
} from '../viewModel';
import './task-detail.css';

export type TaskDetailPanelProps = {
  task: Task | null;
  lists: List[];
  inboxId: string | null;
  defaultListId: string;
  today: string;
  onToggleTask: (task: Task) => void;
  onClose?: () => void;
  /** 删除成功后是否关闭详情；任务中心用它清掉 URL 里的 task。 */
  closeOnDelete?: boolean;
  /** 任务中心无选中时的固定空态文案；其他页面沿用默认值。 */
  emptyTitle?: string;
  emptyHint?: string;
  /** 附件服务；测试或嵌入场景注入。不传时自动装配桌面运行时。 */
  attachmentManager?: AttachmentManager | null;
  attachmentUploader?: AttachmentUploader | null;
  attachmentUnavailableReason?: string | null;
};

type NotesStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

function formatCreatedAt(value: string): string {
  if (!value) {
    return '未知';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 16).replace('T', ' ');
  }
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 产品里详情由 TaskWorkspace 提供全局 UndoProvider；单独渲染面板
 * （例如组件测试或未来嵌入其他页面）时自动补一个局部 provider。
 */
export function TaskDetailPanel(props: TaskDetailPanelProps) {
  const undo = useOptionalUndo();
  if (!undo) {
    return (
      <UndoProvider>
        <TaskDetailBody key={props.task?.id ?? 'empty'} {...props} />
      </UndoProvider>
    );
  }
  return <TaskDetailBody key={props.task?.id ?? 'empty'} {...props} />;
}

function TaskDetailBody({
  task,
  lists,
  inboxId,
  today,
  onToggleTask,
  onClose,
  closeOnDelete = false,
  emptyTitle = '选择一个任务查看详情',
  emptyHint,
  attachmentManager,
  attachmentUploader,
  attachmentUnavailableReason,
}: TaskDetailPanelProps) {
  const store = useTaskStore();
  const run = useTaskAction();
  const toast = useToast();
  const undo = useUndo();

  const [titleDraft, setTitleDraft] = useState(task?.title ?? '');
  const [notesDraft, setNotesDraft] = useState(task?.notes ?? '');
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [subtasksLoading, setSubtasksLoading] = useState(false);
  const [newSubtask, setNewSubtask] = useState('');
  const [noteRows, setNoteRows] = useState<Note[]>([]);
  const [notesStatus, setNotesStatus] = useState<NotesStatus>('idle');
  const [linkedNote, setLinkedNote] = useState<Note | null>(null);
  const [template, setTemplate] = useState<ExecutionNoteTemplate>('blank');
  const [creatingNote, setCreatingNote] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    setTitleDraft(task?.title ?? '');
    setNotesDraft(task?.notes ?? '');
  }, [task?.id, task?.title, task?.notes]);

  useEffect(() => {
    setNewSubtask('');
    setTemplate('blank');
    setDeleteOpen(false);
    setLinkedNote(null);
  }, [task?.id]);

  useEffect(() => {
    if (!task) {
      setSubtasks([]);
      setSubtasksLoading(false);
      return;
    }
    let cancelled = false;
    setSubtasksLoading(true);
    store
      .listSubtasks(task.id)
      .then((rows) => {
        if (!cancelled) {
          setSubtasks(rows);
          setSubtasksLoading(false);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setSubtasksLoading(false);
          toast(formatError(reason), { tone: 'danger' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [task?.id, store.listSubtasks, toast]);

  useEffect(() => {
    if (!task) {
      setNotesStatus('idle');
      return;
    }
    let cancelled = false;
    setNotesStatus('loading');
    store
      .listNotes()
      .then((rows) => {
        if (!cancelled) {
          setNoteRows(rows);
          setNotesStatus('ready');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNoteRows([]);
          setNotesStatus('unavailable');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [task?.id, store.listNotes]);

  useEffect(() => {
    if (!task?.noteId) {
      setLinkedNote(null);
      return;
    }
    const fromList = noteRows.find((note) => note.id === task.noteId);
    if (fromList) {
      setLinkedNote(fromList);
      return;
    }
    let cancelled = false;
    store
      .getNote(task.noteId)
      .then((note) => {
        if (!cancelled) {
          setLinkedNote(note);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLinkedNote(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [task?.noteId, noteRows, store.getNote]);

  if (!task) {
    return (
      <aside className="task-detail" aria-label="任务详情">
        <div className="task-detail-head">
          <h2>任务详情</h2>
        </div>
        <p className="task-detail-empty">{emptyTitle}</p>
        {emptyHint ? <p className="task-detail-note">{emptyHint}</p> : null}
      </aside>
    );
  }

  const done = task.status === 'done';
  const noteOptions =
    linkedNote && !noteRows.some((note) => note.id === linkedNote.id)
      ? [linkedNote, ...noteRows]
      : noteRows;

  const userLists = lists.filter(
    (list) => !list.isInbox && list.deletedAt === null,
  );
  const listFallback = task.listId === inboxId || !lists.some(
    (list) => list.id === task.listId && list.deletedAt === null,
  );

  const savePatch = async (patch: TaskPatch, success?: string) => {
    const next: TaskPatch = { ...patch };

    // 清单是分类，日期是安排；两者正交。改日期不改变清单，
    // 清空日期只表示回到「未安排」，任务仍留在原清单。
    if (patch.dueDate !== undefined && !patch.dueDate) {
      next.dueTime = null;
    }

    return run(
      () => store.patchTask(task.id, next),
      success ? { success } : {},
    );
  };

  const submitTitle = () => {
    const value = titleDraft.trim();
    if (!value) {
      toast('任务标题不能为空', { tone: 'danger' });
      setTitleDraft(task.title);
      return;
    }
    if (value !== task.title) {
      void savePatch({ title: value }, '标题已更新');
    }
  };

  const addSubtask = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = newSubtask.trim();
    if (!value) {
      toast('子任务标题不能为空', { tone: 'danger' });
      return;
    }
    const created = await run(() => store.addSubtask(task.id, value));
    if (created) {
      setSubtasks((current) => [...current, created]);
      setNewSubtask('');
    }
  };

  const toggleSubtask = async (subtask: Subtask) => {
    const updated = await run(() =>
      store.setSubtaskDone(subtask, !subtask.done),
    );
    if (updated) {
      setSubtasks((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    }
  };

  const removeSubtask = async (subtask: Subtask) => {
    try {
      await store.removeSubtask(subtask.id);
      setSubtasks((current) =>
        current.filter((item) => item.id !== subtask.id),
      );
    } catch (reason) {
      toast(formatError(reason), { tone: 'danger' });
    }
  };

  const linkNote = async (noteId: string) => {
    const selected = noteOptions.find((note) => note.id === noteId) ?? null;
    const updated = await savePatch(
      { noteId: noteId || null },
      noteId ? '已关联笔记' : '已取消关联',
    );
    if (updated === undefined) {
      // 写入失败时回到任务当前的关联，避免界面短暂显示错误选择。
      setLinkedNote(
        noteRows.find((note) => note.id === task.noteId) ?? null,
      );
      return;
    }
    setLinkedNote(selected);
  };

  const createNote = async () => {
    setCreatingNote(true);
    try {
      const result = await store.createExecutionNote(task, {
        template,
        listName: listNameOf(lists, task.listId),
        today,
      });
      setLinkedNote(result.note);
      setNoteRows((current) => [
        result.note,
        ...current.filter((note) => note.id !== result.note.id),
      ]);
      toast('已创建执行笔记', { tone: 'success' });
    } catch (reason) {
      toast(formatError(reason), { tone: 'danger' });
    } finally {
      setCreatingNote(false);
    }
  };

  const deleteTask = async () => {
    try {
      await store.removeTask(task.id);
      setDeleteOpen(false);
      if (closeOnDelete) {
        onClose?.();
      }
      undo.schedule({
        message: `任务「${task.title}」已删除`,
        undoLabel: '撤销',
        onUndo: async () => {
          try {
            await store.restoreTask(task.id);
            toast('已恢复任务及其子任务与关联笔记', { tone: 'success' });
          } catch (reason) {
            toast(formatError(reason), { tone: 'danger' });
            throw reason;
          }
        },
      });
    } catch (reason) {
      toast(formatError(reason), { tone: 'danger' });
    }
  };

  return (
    <aside className="task-detail" aria-label="任务详情">
      <div className="task-detail-head">
        <h2>任务详情</h2>
        {onClose ? (
          <button
            type="button"
            className="task-icon-button"
            aria-label="关闭任务详情"
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
      </div>

      <div className="task-field">
        <label htmlFor="task-detail-title">标题</label>
        <input
          id="task-detail-title"
          value={titleDraft}
          onChange={(event) => setTitleDraft(event.target.value)}
          onBlur={submitTitle}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
        />
      </div>

      <div className="task-field-row">
        <div className="task-field">
          <label htmlFor="task-detail-list">清单</label>
          <select
            id="task-detail-list"
            value={task.listId}
            onChange={(event) => {
              void savePatch(
                { listId: event.target.value },
                '清单已更新',
              );
            }}
          >
            {listFallback ? (
              <option value={task.listId} disabled>
                未安排
              </option>
            ) : null}
            {userLists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
          </select>
        </div>
        <div className="task-field">
          <label htmlFor="task-detail-status">状态</label>
          <select
            id="task-detail-status"
            value={task.status}
            onChange={(event) => {
              const next = event.target.value as Task['status'];
              if (next === 'done') {
                // 完成走统一动作：写 completedAt、记忆完成前状态、提供撤销。
                if (!done) {
                  onToggleTask(task);
                }
                return;
              }
              // 从已完成手动改回待办/进行中：显式改状态，清空完成记忆。
              if (done) {
                forgetStatusBeforeDone(task.id);
              }
              void savePatch(
                { status: next },
                `已恢复为${statusLabel(next)}`,
              );
            }}
          >
            <option value="todo">待办</option>
            <option value="doing">进行中</option>
            <option value="done">已完成</option>
          </select>
        </div>
      </div>

      <div className="task-field-row">
        <div className="task-field">
          <label htmlFor="task-detail-date">日期</label>
          <DatePicker
            id="task-detail-date"
            value={task.dueDate}
            emptyLabel="未安排"
            onChange={(value) => {
              void savePatch(
                { dueDate: value },
                value ? '日期已更新' : '已移到未安排',
              );
            }}
          />
        </div>
        <div className="task-field">
          <label htmlFor="task-detail-time">时间</label>
          <input
            id="task-detail-time"
            type="time"
            value={task.dueTime ?? ''}
            disabled={!task.dueDate}
            onChange={(event) => {
              void savePatch({ dueTime: event.target.value || null });
            }}
          />
        </div>
      </div>

      <div className="task-field-row">
        <div className="task-field">
          <label htmlFor="task-detail-quadrant">象限</label>
          <select
            id="task-detail-quadrant"
            value={task.quadrant >= 1 && task.quadrant <= 4 ? task.quadrant : 4}
            onChange={(event) => {
              void savePatch({ quadrant: Number(event.target.value) });
            }}
          >
            {QUADRANTS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.title}
              </option>
            ))}
          </select>
        </div>
        <div className="task-field">
          <label htmlFor="task-detail-priority">优先级</label>
          <select
            id="task-detail-priority"
            value={task.priority}
            onChange={(event) => {
              void savePatch({ priority: Number(event.target.value) });
            }}
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
        <label htmlFor="task-detail-reminder">提醒</label>
        <select
          id="task-detail-reminder"
          value={reminderOptionValue(task.reminder)}
          onChange={(event) => {
            void savePatch({ reminder: event.target.value }, '提醒已更新');
          }}
        >
          {TASK_REMINDER_OPTIONS.map((option) => (
            <option key={option.value || 'none'} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="task-field">
        <label htmlFor="task-detail-notes">备注</label>
        <textarea
          id="task-detail-notes"
          rows={3}
          value={notesDraft}
          placeholder="执行要点、链接、上下文…"
          onChange={(event) => setNotesDraft(event.target.value)}
          onBlur={() => {
            if (notesDraft !== task.notes) {
              void savePatch({ notes: notesDraft });
            }
          }}
        />
      </div>

      <div className="task-field task-attachment-field">
        <span className="task-field-label">附件</span>
        <AttachmentSection
          manager={attachmentManager}
          uploader={attachmentUploader}
          unavailableReason={attachmentUnavailableReason}
          taskId={task.id}
          title="任务附件"
          insertLabel="＋ 添加附件"
          onNotice={(message) => toast(message, { tone: 'success' })}
        />
      </div>

      <div className="task-field">
        <span className="task-field-label">
          子任务
          {subtasks.length > 0
            ? ` · ${subtasks.filter((item) => item.done).length}/${subtasks.length}`
            : ''}
        </span>
        {subtasksLoading ? (
          <p className="task-detail-note" role="status">
            正在读取子任务…
          </p>
        ) : null}
        {!subtasksLoading && subtasks.length === 0 ? (
          <p className="task-detail-note">还没有子任务</p>
        ) : null}
        <div className="task-subtasks">
          {subtasks.map((subtask) => (
            <div
              className={
                subtask.done ? 'task-subtask is-done' : 'task-subtask'
              }
              key={subtask.id}
            >
              <button
                type="button"
                className="task-subtask-check"
                aria-label={`${subtask.done ? '撤销子任务' : '完成子任务'}：${subtask.title}`}
                aria-pressed={subtask.done}
                onClick={() => void toggleSubtask(subtask)}
              >
                {subtask.done ? '✓' : ''}
              </button>
              <span>{subtask.title}</span>
              <button
                type="button"
                className="task-link-button"
                aria-label={`删除子任务：${subtask.title}`}
                onClick={() => void removeSubtask(subtask)}
              >
                删除
              </button>
            </div>
          ))}
        </div>
        <form
          className="task-subtask-form"
          onSubmit={(event) => void addSubtask(event)}
        >
          <input
            aria-label="新子任务"
            value={newSubtask}
            placeholder="添加子任务"
            onChange={(event) => setNewSubtask(event.target.value)}
          />
          <button type="submit" className="task-button task-button--small">
            添加
          </button>
        </form>
      </div>

      <div className="task-field task-note-section">
        <span className="task-field-label">关联笔记</span>
        {notesStatus === 'unavailable' ? (
          <p className="task-detail-note">
            笔记库当前不可用；任务字段仍可正常保存。
          </p>
        ) : (
          <select
            aria-label="关联已有笔记"
            value={task.noteId ?? ''}
            disabled={notesStatus !== 'ready'}
            onChange={(event) => void linkNote(event.target.value)}
          >
            <option value="">未关联</option>
            {noteOptions.map((note) => (
              <option key={note.id} value={note.id}>
                {note.title}
              </option>
            ))}
          </select>
        )}

        {linkedNote ? (
          <div className="task-note-card">
            <span className="task-note-card-title">{linkedNote.title}</span>
            <span className="task-note-card-meta">
              {linkedNote.tags.length > 0
                ? linkedNote.tags.join(' · ')
                : '普通笔记'}
            </span>
            <Link
              className="task-note-open"
              to={`/knowledge?note=${encodeURIComponent(linkedNote.id)}`}
            >
              打开笔记
            </Link>
          </div>
        ) : task.noteId ? (
          <p className="task-detail-note">关联笔记已删除或不可读取。</p>
        ) : null}

        {!task.noteId && notesStatus === 'ready' ? (
          <div className="task-note-create">
            <label htmlFor="task-note-template">执行笔记模板</label>
            <select
              id="task-note-template"
              value={template}
              onChange={(event) =>
                setTemplate(event.target.value as ExecutionNoteTemplate)
              }
            >
              {EXECUTION_NOTE_TEMPLATES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="task-button task-button--small"
              disabled={creatingNote}
              onClick={() => void createNote()}
            >
              {creatingNote ? '正在创建…' : '＋ 创建执行笔记'}
            </button>
          </div>
        ) : null}
      </div>

      <div className="task-detail-meta" aria-label="任务时间信息">
        {today ? <span>今天 {today}</span> : null}
        <span>
          创建于{' '}
          <time dateTime={task.createdAt}>{formatCreatedAt(task.createdAt)}</time>
        </span>
        <span>
          {task.dueDate
            ? `到期 ${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ''}`
            : '未安排日期'}
        </span>
      </div>

      <div className="task-detail-actions">
        <button
          type="button"
          className="task-button"
          onClick={() => onToggleTask(task)}
        >
          {done ? '撤销完成' : '完成任务'}
        </button>
        {done ? (
          <button
            type="button"
            className="task-button"
            onClick={() => {
              forgetStatusBeforeDone(task.id);
              void savePatch({ status: 'todo' }, '已恢复到待办');
            }}
          >
            恢复为待办
          </button>
        ) : null}
        <button
          type="button"
          className="task-button task-button--danger"
          onClick={() => setDeleteOpen(true)}
        >
          删除任务
        </button>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        title="删除任务"
        description={
          <>
            将「{task.title}」移到回收站？子任务和关联笔记会保留，删除任务
            不会删除知识笔记。
          </>
        }
        confirmLabel="删除任务"
        cancelLabel="取消"
        danger
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void deleteTask()}
      />
    </aside>
  );
}
