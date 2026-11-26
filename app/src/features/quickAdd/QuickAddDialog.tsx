/**
 * ⌘N 快速创建：任务 / 笔记。
 *
 * 任务默认落到今天、设置页的默认清单、象限 4、无优先级；清空日期后只能进入
 * 收件箱。创建成功后用深链打开对应对象，而不是只弹一句“已创建”。
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { todayISO as calendarToday } from '../../data/calendar/date';
import { isTauriRuntime } from '../../data/db/client';
import type { List, Note } from '../../data/db/types';
import { NOTE_FOLDERS } from '../../data/repositories/notes';
import type { AppSettings } from '../../data/repositories/settings';
import { DatePicker } from '../../ui/date';
import { CommandDialog } from '../search/CommandDialog';
import { getRuntimeSettings } from '../settings/runtime';
import { PRIORITY_LABELS, QUADRANTS } from '../tasks/viewModel';
import {
  buildQuickNote,
  buildQuickTask,
  inboxOf,
  noteDestination,
  quickTaskDestinationLabel,
  resolveNoteFolderId,
  resolveTaskListId,
  taskDestination,
  type QuickAddTab,
} from './model';
import {
  createQuickAddSource,
  type QuickAddSource,
} from './source';
import './quickAdd.css';

export type QuickAddDialogProps = {
  open: boolean;
  initialTab?: QuickAddTab;
  onClose: () => void;
  /** 测试注入；不传时使用本机 SQLite。 */
  source?: QuickAddSource;
  settings?: AppSettings;
  available?: boolean;
  today?: string;
};

type LoadStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

function formatError(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '创建失败，请重试';
}

export function QuickAddDialog({
  open,
  initialTab = 'task',
  onClose,
  source,
  settings,
  available,
  today,
}: QuickAddDialogProps) {
  const navigate = useNavigate();
  const defaultSource = useMemo(() => createQuickAddSource(), []);
  const activeSource = source ?? defaultSource;
  const runtimeAvailable =
    available ?? (source !== undefined || isTauriRuntime());
  const resolvedToday = today ?? calendarToday();

  const titleRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef<AppSettings | null>(null);
  const fieldId = useId();

  const [tab, setTab] = useState<QuickAddTab>(initialTab);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lists, setLists] = useState<List[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);

  const [title, setTitle] = useState('');
  const [listId, setListId] = useState('');
  const [date, setDate] = useState(resolvedToday);
  const [dateValid, setDateValid] = useState(true);
  const [time, setTime] = useState('');
  const [priority, setPriority] = useState(0);
  const [quadrant, setQuadrant] = useState(4);
  const [noteId, setNoteId] = useState('');
  const [folderId, setFolderId] = useState(resolveNoteFolderId(null));

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open) {
      return;
    }

    setTab(initialTab);
    setTitle('');
    setDate(resolvedToday);
    setDateValid(true);
    setTime('');
    setPriority(0);
    setQuadrant(4);
    setNoteId('');
    setError(null);
    setBusy(false);
    setLoadError(null);
    setLists([]);
    setNotes([]);

    const currentSettings = settings ?? getRuntimeSettings();
    settingsRef.current = currentSettings;
    setFolderId(resolveNoteFolderId(currentSettings.task.noteFolderId));

    if (!runtimeAvailable) {
      setStatus('unavailable');
      return;
    }

    let cancelled = false;
    setStatus('loading');
    void Promise.all([
      activeSource.lists(),
      activeSource.notes().catch(() => [] as Note[]),
    ])
      .then(([nextLists, nextNotes]) => {
        if (cancelled) {
          return;
        }
        setLists(nextLists);
        setNotes(nextNotes);
        setListId(
          resolveTaskListId(
            nextLists,
            currentSettings.task.defaultListId,
            resolvedToday,
          ),
        );
        setStatus('ready');
      })
      .catch((reason) => {
        if (cancelled) {
          return;
        }
        setLoadError(formatError(reason));
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [
    open,
    initialTab,
    resolvedToday,
    runtimeAvailable,
    activeSource,
    settings,
    reloadKey,
  ]);

  const inbox = inboxOf(lists);
  const noDate = date.trim() === '';
  const datedLists = lists.filter((list) => !list.isInbox);
  const effectiveListId = noDate ? (inbox?.id ?? '') : listId;
  const taskListLabel = quickTaskDestinationLabel(
    date,
    lists,
    effectiveListId,
    resolvedToday,
  );

  const changeDate = (nextDate: string) => {
    setDate(nextDate);
    if (!nextDate.trim()) {
      setListId(inbox?.id ?? '');
      return;
    }
    setListId(
      resolveTaskListId(
        lists,
        settingsRef.current?.task.defaultListId ?? null,
        nextDate,
      ),
    );
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || status !== 'ready') {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (tab === 'task') {
        const input = buildQuickTask(
          {
            title,
            listId: effectiveListId,
            date,
            time,
            priority,
            quadrant,
            noteId,
          },
          lists,
        );
        const task = await activeSource.createTask(input);
        onClose();
        navigate(
          taskDestination({
            id: task.id,
            dueDate: task.dueDate ?? input.dueDate ?? null,
          }),
        );
      } else {
        const input = buildQuickNote({ title, folderId });
        const note = await activeSource.createNote(input);
        onClose();
        navigate(noteDestination(note));
      }
    } catch (reason) {
      setError(formatError(reason));
    } finally {
      setBusy(false);
    }
  };

  const switchTab = (next: QuickAddTab) => {
    setTab(next);
    setError(null);
    window.setTimeout(() => titleRef.current?.focus(), 0);
  };

  return (
    <CommandDialog
      open={open}
      label="快速创建"
      className="quickadd-dialog"
      initialFocusRef={titleRef}
      onClose={onClose}
    >
      <header className="quickadd-head">
        <div>
          <h2 className="command-dialog__title">快速创建</h2>
          <p className="command-dialog__desc">
            先记下来，再决定细节。任务默认进入今天；清空日期则进入未安排。
          </p>
        </div>
        <div className="quickadd-tabs" role="tablist" aria-label="创建类型">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'task'}
            className={
              tab === 'task' ? 'quickadd-tab is-active' : 'quickadd-tab'
            }
            onClick={() => switchTab('task')}
          >
            任务
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'note'}
            className={
              tab === 'note' ? 'quickadd-tab is-active' : 'quickadd-tab'
            }
            onClick={() => switchTab('note')}
          >
            笔记
          </button>
        </div>
      </header>

      <div className="quickadd-body">
        {status === 'loading' ? (
          <div className="quickadd-state" role="status" aria-live="polite">
            正在读取清单与最近笔记…
          </div>
        ) : null}

        {status === 'unavailable' ? (
          <div className="quickadd-state">
            <span className="quickadd-state-mark" aria-hidden="true">
              库
            </span>
            <b>需在桌面壳内快速创建</b>
            <p>
              任务与笔记保存在本机 SQLite。浏览器预览没有 Tauri IPC
              通道，请使用 <code>pnpm --filter app tauri dev</code> 启动桌面壳。
            </p>
          </div>
        ) : null}

        {status === 'error' ? (
          <div className="quickadd-state" role="alert">
            <span className="quickadd-state-mark" aria-hidden="true">
              !
            </span>
            <b>清单读取失败</b>
            <p>{loadError}</p>
            <button
              type="button"
              className="command-button"
              onClick={() => setReloadKey((current) => current + 1)}
            >
              重试
            </button>
          </div>
        ) : null}

        {status === 'ready' ? (
          <form className="quickadd-form" onSubmit={(event) => void submit(event)}>
            <label className="quickadd-field quickadd-field--full">
              <span>{tab === 'task' ? '任务标题' : '笔记标题'}</span>
              <input
                ref={titleRef}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  if (error) {
                    setError(null);
                  }
                }}
                placeholder={
                  tab === 'task' ? '要做什么？' : '这篇笔记记什么？'
                }
                autoComplete="off"
              />
            </label>

            {tab === 'task' ? (
              <>
                <div className="quickadd-row">
                  <label className="quickadd-field" htmlFor={`${fieldId}-list`}>
                    <span>清单</span>
                    <select
                      id={`${fieldId}-list`}
                      value={effectiveListId}
                      disabled={noDate}
                      onChange={(event) => setListId(event.target.value)}
                    >
                      {noDate ? (
                        <option value={inbox?.id ?? ''}>
                          未安排
                        </option>
                      ) : (
                        datedLists.map((list) => (
                          <option key={list.id} value={list.id}>
                            {list.name}
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                  <label className="quickadd-field" htmlFor={`${fieldId}-date`}>
                    <span>日期</span>
                    <DatePicker
                      id={`${fieldId}-date`}
                      value={date || null}
                      emptyLabel="未安排"
                      showHelper={false}
                      onValidityChange={setDateValid}
                      onChange={(next) => changeDate(next ?? '')}
                    />
                  </label>
                </div>

                <div className="quickadd-row">
                  <label className="quickadd-field" htmlFor={`${fieldId}-time`}>
                    <span>时间</span>
                    <input
                      id={`${fieldId}-time`}
                      type="time"
                      value={time}
                      disabled={noDate}
                      onChange={(event) => setTime(event.target.value)}
                    />
                  </label>
                  <label
                    className="quickadd-field"
                    htmlFor={`${fieldId}-priority`}
                  >
                    <span>优先级</span>
                    <select
                      id={`${fieldId}-priority`}
                      value={priority}
                      onChange={(event) =>
                        setPriority(Number(event.target.value))
                      }
                    >
                      {PRIORITY_LABELS.map((label, value) => (
                        <option key={label} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="quickadd-row">
                  <label
                    className="quickadd-field"
                    htmlFor={`${fieldId}-quadrant`}
                  >
                    <span>象限</span>
                    <select
                      id={`${fieldId}-quadrant`}
                      value={quadrant}
                      onChange={(event) =>
                        setQuadrant(Number(event.target.value))
                      }
                    >
                      {QUADRANTS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label
                    className="quickadd-field"
                    htmlFor={`${fieldId}-note`}
                  >
                    <span>关联笔记</span>
                    <select
                      id={`${fieldId}-note`}
                      value={noteId}
                      onChange={(event) => setNoteId(event.target.value)}
                    >
                      <option value="">不关联</option>
                      {notes.map((note) => (
                        <option key={note.id} value={note.id}>
                          {note.title}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <p className="quickadd-hint">
                  {noDate
                    ? '未安排日期：创建后进入未安排，不会出现在今天。'
                    : `创建后打开：${taskListLabel}`}
                </p>
                {!noDate && datedLists.length === 0 ? (
                  <p className="quickadd-warning">
                    还没有可用清单。请先到「清单」创建一个清单，或清空日期放入未安排。
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <label className="quickadd-field quickadd-field--full">
                  <span>目录</span>
                  <select
                    value={folderId}
                    onChange={(event) => setFolderId(event.target.value)}
                  >
                    {NOTE_FOLDERS.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="quickadd-hint">
                  先写标题与目录；正文、块内容和待办到知识页继续编辑。
                </p>
              </>
            )}

            {error ? (
              <p className="quickadd-error" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        ) : null}
      </div>

      <footer className="command-dialog__footer">
        <span className="command-dialog__hint">
          {tab === 'task' ? '⌘N 新建任务 · ⌘⇧N 新建笔记' : '⌘⇧N 新建笔记'}
        </span>
        <button type="button" className="command-button" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="command-button command-button--primary"
          disabled={
            status !== 'ready' ||
            busy ||
            (tab === 'task' &&
              (noDate ? !inbox : datedLists.length === 0 || !dateValid))
          }
          onClick={() => void submit()}
        >
          {busy ? '创建中…' : tab === 'task' ? '创建任务' : '创建笔记'}
        </button>
      </footer>
    </CommandDialog>
  );
}
