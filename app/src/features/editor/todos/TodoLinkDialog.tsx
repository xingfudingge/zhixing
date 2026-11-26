/**
 * 笔记待办关联全局任务弹层（P1-03）。
 *
 * 只做两件用户显式发起的事：
 * 1. 关联一个已有任务；
 * 2. 新建一个全局任务并立即关联。
 * 不提供“自动同步标题/日期/完成状态”的开关，因为 v1 明确不镜像。
 */

import { useEffect, useState, type FormEvent } from 'react';

import type { List, NoteTodo } from '../../../data/db/types';
import {
  describeTodoTask,
  linkedTaskIsDeleted,
  taskStatusLabel,
  type TodoTaskChoice,
  type TodoTaskState,
} from '../../tasks/linkTodo';
import { normalizeNoteTodoTitle } from '../../../data/repositories/noteTodos';

export type TodoLinkDialogProps = {
  open: boolean;
  todo: NoteTodo | null;
  taskState: TodoTaskState | null | undefined;
  choices: ReadonlyArray<TodoTaskChoice>;
  lists: ReadonlyArray<List>;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onLink: (taskId: string) => void;
  onCreate: (input: { title: string; listId: string }) => void;
  onUnlink: () => void;
};

function inboxOrFirst(lists: ReadonlyArray<List>): string {
  return (
    lists.find((list) => list.isInbox)?.id ??
    lists[0]?.id ??
    ''
  );
}

export function TodoLinkDialog({
  open,
  todo,
  taskState,
  choices,
  lists,
  busy = false,
  error,
  onClose,
  onLink,
  onCreate,
  onUnlink,
}: TodoLinkDialogProps) {
  const [selected, setSelected] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newListId, setNewListId] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const linked = Boolean(todo?.taskId);
  const linkedDeleted = linkedTaskIsDeleted(taskState);

  useEffect(() => {
    if (!open || !todo) {
      return;
    }
    setSelected(todo.taskId ?? '');
    setNewTitle(todo.title);
    setNewListId(inboxOrFirst(lists));
    setLocalError(null);
    // 只在打开另一条待办时重置，避免父组件刷新任务列表时清空输入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, todo?.id, todo?.taskId]);

  // 清单是异步读到的：弹层先打开、清单后到达时补上默认清单，
  // 否则“新建任务并关联”会一直处于不可用状态。
  useEffect(() => {
    if (!open) {
      return;
    }
    setNewListId((current) => current || inboxOrFirst(lists));
  }, [lists, open]);

  if (!open || !todo) {
    return null;
  }

  const title = todo.title || '待办事项';
  const shownError = localError ?? error ?? null;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!selected) {
      setLocalError('请选择一个要关联的任务');
      return;
    }
    setLocalError(null);
    onLink(selected);
  };

  const handleCreate = () => {
    const clean = normalizeNoteTodoTitle(newTitle);
    if (!newListId) {
      setLocalError('还没有可用的清单，无法创建全局任务');
      return;
    }
    setLocalError(null);
    onCreate({ title: clean, listId: newListId });
  };

  return (
    <div className="zxt-dialog-backdrop" role="presentation">
      <section
        className="zxt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="zxt-dialog-title"
      >
        <header className="zxt-dialog-head">
          <h2 id="zxt-dialog-title">关联全局任务</h2>
          <button
            type="button"
            className="zxt-dialog-close"
            aria-label="关闭关联弹层"
            onClick={onClose}
            disabled={busy}
          >
            ×
          </button>
        </header>

        <p className="zxt-dialog-desc">
          “{title}”仍保留笔记自己的完成状态，只建立上下文关系；勾选、
          完成或删除任一边都不会改变另一边。
        </p>

        {linked ? (
          <div
            className={
              linkedDeleted
                ? 'zxt-dialog-linked is-deleted'
                : 'zxt-dialog-linked'
            }
            role="status"
          >
            <span>当前关联</span>
            <strong>
              {linkedDeleted
                ? `已删除：${taskState?.title ?? '关联任务'}`
                : taskState
                  ? describeTodoTask(taskState)
                  : '正在读取关联任务…'}
            </strong>
            {!linkedDeleted && taskState ? (
              <small>{taskStatusLabel(taskState.status)}</small>
            ) : null}
            <button type="button" onClick={onUnlink} disabled={busy}>
              解除关联
            </button>
          </div>
        ) : null}

        <form className="zxt-dialog-form" onSubmit={handleSubmit}>
          <label className="zxt-dialog-field">
            <span>关联已有任务</span>
            <select
              aria-label="选择已有任务"
              value={selected}
              onChange={(event) => setSelected(event.currentTarget.value)}
              disabled={busy}
            >
              <option value="">不关联</option>
              {linked && linkedDeleted && todo.taskId ? (
                <option value={todo.taskId}>已删除：{taskState?.title}</option>
              ) : null}
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.title} · {taskStatusLabel(choice.status)}
                </option>
              ))}
            </select>
          </label>
          <p className="zxt-dialog-hint">
            {choices.length === 0
              ? '还没有全局任务，可以在下方新建一个再关联。'
              : '只列出未删除的全局任务。'}
          </p>
          <div className="zxt-dialog-actions">
            <button
              type="button"
              className="zxt-dialog-button"
              onClick={onClose}
              disabled={busy}
            >
              取消
            </button>
            <button
              type="submit"
              className="zxt-dialog-button is-primary"
              disabled={busy || !selected}
            >
              保存关联
            </button>
          </div>
        </form>

        <div className="zxt-dialog-divider" aria-hidden="true" />

        <section className="zxt-dialog-new" aria-label="新建任务并关联">
          <h3>新建任务并关联</h3>
          <label className="zxt-dialog-field">
            <span>任务标题</span>
            <input
              aria-label="新任务标题"
              value={newTitle}
              onChange={(event) => setNewTitle(event.currentTarget.value)}
              disabled={busy}
            />
          </label>
          <label className="zxt-dialog-field">
            <span>所属清单</span>
            <select
              aria-label="新任务清单"
              value={newListId}
              onChange={(event) => setNewListId(event.currentTarget.value)}
              disabled={busy || lists.length === 0}
            >
              {lists.length === 0 ? (
                <option value="">没有可用清单</option>
              ) : null}
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </label>
          <div className="zxt-dialog-actions">
            <button
              type="button"
              className="zxt-dialog-button is-primary"
              onClick={handleCreate}
              disabled={busy || lists.length === 0}
            >
              新建任务并关联
            </button>
          </div>
        </section>

        {shownError ? (
          <p className="zxt-dialog-error" role="alert">
            {shownError}
          </p>
        ) : null}
      </section>
    </div>
  );
}
