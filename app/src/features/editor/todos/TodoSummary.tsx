/**
 * 文末待办汇总（P1-03）。
 *
 * 与正文内联待办共用同一批 `note_todos` 对象：勾选、定位、关联、删除都
 * 操作同一个 todo id。汇总只展示 note_todos 自己的完成状态；关联任务的
 * 状态是独立信息，不参与计数，也不镜像。
 */

import type { NoteTodo } from '../../../data/db/types';
import { noteTodoSummary } from '../../../data/repositories/noteTodos';
import {
  describeTodoTask,
  linkedTaskIsDeleted,
  taskStatusLabel,
  type TodoTaskState,
} from '../../tasks/linkTodo';

export type TodoSummaryProps = {
  todos: ReadonlyArray<NoteTodo>;
  taskStates: ReadonlyMap<string, TodoTaskState>;
  busy?: boolean;
  /** 阅读模式/回收站：只展示待办，不提供勾选、关联、删除与添加。 */
  readOnly?: boolean;
  onToggle: (todoId: string) => void;
  onLocate: (todoId: string) => void;
  onOpenLink: (todoId: string) => void;
  onDelete: (todoId: string) => void;
  onAdd: () => void;
  /** 重新读取关联任务状态（任务可能在别的页面被完成/删除）。 */
  onRefresh?: () => void;
};

export function TodoSummary({
  todos,
  taskStates,
  busy = false,
  readOnly = false,
  onToggle,
  onLocate,
  onOpenLink,
  onDelete,
  onAdd,
  onRefresh,
}: TodoSummaryProps) {
  if (todos.length === 0) {
    return null;
  }

  const { total, done } = noteTodoSummary(todos);
  const locked = busy || readOnly;

  return (
    <section
      className="zxt-summary"
      aria-label="本篇待办"
      data-read-only={readOnly ? 'true' : 'false'}
    >
      <header className="zxt-summary-head">
        <strong>本篇待办</strong>
        <span className="zxt-summary-count" aria-live="polite">
          {done}/{total} 已完成
        </span>
        {onRefresh ? (
          <button
            type="button"
            className="zxt-summary-refresh"
            aria-label="刷新关联任务状态"
            title="刷新关联任务状态"
            onClick={onRefresh}
            disabled={busy}
          >
            ↻
          </button>
        ) : null}
        <button
          type="button"
          className="zxt-summary-add"
          onClick={onAdd}
          disabled={locked}
        >
          ＋ 添加
        </button>
      </header>

      <ul className="zxt-summary-list">
        {todos.map((todo) => {
          const title = todo.title || '待办事项';
          const taskState = todo.taskId
            ? taskStates.get(todo.taskId)
            : undefined;
          const taskDeleted = linkedTaskIsDeleted(taskState);
          const linked = Boolean(todo.taskId);
          const taskStatus = taskState
            ? taskStatusLabel(taskState.status)
            : '读取中';
          const taskLabel = taskState
            ? taskState.title
            : '正在读取关联任务';

          return (
            <li
              key={todo.id}
              className={todo.done ? 'zxt-summary-row is-done' : 'zxt-summary-row'}
              data-note-todo-id={todo.id}
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={todo.done}
                aria-label={
                  todo.done
                    ? `标记未完成：${title}`
                    : `标记完成：${title}`
                }
                className="zxt-summary-check"
                onClick={() => onToggle(todo.id)}
                disabled={locked}
              >
                {todo.done ? '✓' : ''}
              </button>

              <button
                type="button"
                className="zxt-summary-title"
                title={`定位到正文：${title}`}
                aria-label={`定位待办：${title}`}
                onClick={() => onLocate(todo.id)}
                disabled={busy}
              >
                {title}
              </button>

              {linked ? (
                <button
                  type="button"
                  className={
                    taskDeleted
                      ? 'zxt-summary-link is-deleted'
                      : 'zxt-summary-link is-linked'
                  }
                  title={
                    taskState
                      ? `${describeTodoTask(taskState)} · ${
                          taskDeleted ? '可解除关联' : taskStatus
                        }`
                      : '正在读取关联任务状态'
                  }
                  aria-label={
                    taskDeleted
                      ? `关联任务已删除：${title}`
                      : `已关联任务：${taskLabel}（${taskStatus}）`
                  }
                  onClick={() => onOpenLink(todo.id)}
                  disabled={locked}
                >
                  {taskDeleted ? (
                    <span className="zxt-summary-link-deleted">已删除</span>
                  ) : (
                    <>
                      <span aria-hidden="true">▤</span>
                      <span className="zxt-summary-link-text">
                        {taskState
                          ? `${taskState.title} · ${taskStatus}`
                          : '读取中…'}
                      </span>
                    </>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  className="zxt-summary-link"
                  aria-label={`关联任务：${title}`}
                  title="关联全局任务"
                  onClick={() => onOpenLink(todo.id)}
                  disabled={locked}
                >
                  关联
                </button>
              )}

              <button
                type="button"
                className="zxt-summary-delete"
                aria-label={`删除待办：${title}`}
                title="删除待办（不会删除关联任务）"
                onClick={() => onDelete(todo.id)}
                disabled={locked}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
