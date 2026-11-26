/** 任务行：勾选完成、状态胶囊、选中查看详情，可拖到四象限或看板列。 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import type { List, Task, TaskStatus } from '../../data/db/types';
import { useToast } from './Feedback';
import { formatError, useTaskStore } from './TaskStore';
import {
  TASK_STATUS_OPTIONS,
  forgetStatusBeforeDone,
  formatDueLabel,
  formatOverdueLabel,
  isOverdue,
  listDisplayName,
  rememberStatusBeforeDone,
  statusBeforeDoneOf,
  statusLabel,
} from './viewModel';

/**
 * 全应用唯一的状态写入口。
 *
 * * 完成写 completedAt，并记忆完成前状态；撤销/再次点完成圆点会恢复原状态。
 * * 待办 ⇄ 进行中直接写 status；从已完成手动改回时清空完成记忆。
 * * 所有行、看板卡、详情都通过这里，避免各页面各写一套。
 */
export function useTaskStatusActions() {
  const store = useTaskStore();
  const toast = useToast();

  const restore = useCallback(
    async (taskId: string, target: TaskStatus) => {
      try {
        await store.setTaskStatus(taskId, target);
        forgetStatusBeforeDone(taskId);
        toast(`已恢复为${statusLabel(target)}`, { tone: 'success' });
      } catch (reason) {
        toast(formatError(reason), { tone: 'danger' });
      }
    },
    [store, toast],
  );

  const setStatus = useCallback(
    async (task: Task, next: TaskStatus) => {
      if (task.status === next) {
        return task;
      }
      try {
        if (next === 'done') {
          const previous = task.status;
          const completed = await store.completeTask(task.id, true);
          rememberStatusBeforeDone(
            task.id,
            previous,
            completed.completedAt,
          );
          toast(`已完成「${task.title}」`, {
            tone: 'success',
            action: {
              label: '撤销',
              onClick: () => restore(task.id, previous),
            },
          });
          return completed;
        }

        const updated = await store.setTaskStatus(task.id, next);
        if (task.status === 'done') {
          forgetStatusBeforeDone(task.id);
        }
        toast(next === 'doing' ? '已移到进行中' : '已恢复为待办', {
          tone: 'success',
        });
        return updated;
      } catch (reason) {
        toast(formatError(reason), { tone: 'danger' });
        return undefined;
      }
    },
    [restore, store, toast],
  );

  const toggle = useCallback(
    async (task: Task) => {
      if (task.status !== 'done') {
        return setStatus(task, 'done');
      }
      return restore(task.id, statusBeforeDoneOf(task) ?? 'todo');
    },
    [restore, setStatus],
  );

  return { setStatus, toggle };
}

export type TaskStatusButtonProps = {
  task: Task;
  onChange: (status: TaskStatus) => void;
  disabled?: boolean;
  /** row = 任务行；card = 看板卡片底部。 */
  variant?: 'row' | 'card';
};

/**
 * 状态胶囊 + 三项菜单。不改动任务行高度；菜单固定定位到胶囊下方，
 * 空间不足时向上翻转，点外部/Esc 关闭。
 */
export function TaskStatusButton({
  task,
  onChange,
  disabled = false,
  variant = 'row',
}: TaskStatusButtonProps) {
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentLabel = statusLabel(task.status);

  const close = useCallback((focusTrigger = false) => {
    setOpen(false);
    if (focusTrigger) {
      triggerRef.current?.focus();
    }
  }, []);

  const openMenu = () => {
    if (disabled) {
      return;
    }
    if (open) {
      close();
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const width = 154;
    const height = 108;
    const viewportWidth =
      typeof window === 'undefined' ? 1024 : window.innerWidth;
    const viewportHeight =
      typeof window === 'undefined' ? 768 : window.innerHeight;
    const left = Math.min(
      Math.max(8, rect.right - width),
      Math.max(8, viewportWidth - width - 8),
    );
    let top = rect.bottom + 6;
    if (top + height > viewportHeight - 8) {
      top = Math.max(8, rect.top - height - 6);
    }
    setPosition({ left, top });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"]',
    );
    first?.focus({ preventScroll: true });

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (menuRef.current?.contains(target) ||
          triggerRef.current?.contains(target))
      ) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key === 'Tab') {
        setOpen(false);
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
        return;
      }
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitemradio"]',
        ) ?? [],
      );
      if (items.length === 0) {
        return;
      }
      event.preventDefault();
      const index = items.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex =
        (index + delta + items.length) % items.length;
      items[nextIndex]?.focus();
    };
    // 滚动/缩放后旧坐标不再可信，直接关闭而不是把菜单留在半空。
    const onReposition = () => setOpen(false);

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [close, open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-no-drag
        className={[
          'task-status-toggle',
          `task-status-toggle--${task.status}`,
          variant === 'card' ? 'task-status-toggle--card' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label={`任务状态：${currentLabel}，点击修改`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          openMenu();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <span className="task-status-dot" aria-hidden="true" />
        {currentLabel}
      </button>

      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="task-status-menu"
              role="menu"
              aria-label="修改任务状态"
              style={{ left: position.left, top: position.top }}
              data-no-drag
            >
              {TASK_STATUS_OPTIONS.map((option) => {
                const checked = task.status === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    data-status={option.value}
                    onClick={(event) => {
                      event.stopPropagation();
                      close(true);
                      if (!checked) {
                        onChange(option.value);
                      }
                    }}
                  >
                    <span className="task-status-dot" aria-hidden="true" />
                    {option.label}
                    {checked ? (
                      <span className="task-status-menu-check" aria-hidden="true">
                        ✓
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export type TaskRowProps = {
  task: Task;
  lists: List[];
  today: string;
  selected?: boolean;
  /** 快速新建后短暂高亮新行。 */
  highlighted?: boolean;
  onSelect: () => void;
  onToggle: () => void;
  /** 状态胶囊：待办 / 进行中 / 已完成，三处入口共用。 */
  onStatusChange?: (status: TaskStatus) => void;
  actions?: ReactNode;
  /** 批量选择：未完成范围才显示复选框。 */
  selectable?: boolean;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** 搜索命中备注且标题未命中时显示「备注命中」。 */
  notesMatched?: boolean;
  /** 已完成范围显示「完成于 M 月 D 日」。 */
  completedLabel?: string | null;
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: (event: DragEvent<HTMLDivElement>, task: Task) => void;
  /**
   * 指针拖拽（pointerdown/move/up）的起点。HTML5 DragEvent 在 macOS
   * WKWebView 里不可靠，真实桌面拖拽走这条路径；两者可同时存在。
   */
  onPointerDragStart?: (
    event: ReactPointerEvent<HTMLDivElement>,
    task: Task,
  ) => void;
};

export function TaskRow({
  task,
  lists,
  today,
  selected = false,
  highlighted = false,
  onSelect,
  onToggle,
  onStatusChange,
  actions,
  selectable = false,
  checked = false,
  onCheckedChange,
  notesMatched = false,
  completedLabel = null,
  draggable = false,
  dragging = false,
  onDragStart,
  onPointerDragStart,
}: TaskRowProps) {
  const done = task.status === 'done';
  const overdueLabel = formatOverdueLabel(task, today);

  return (
    <div
      className={[
        'task-row',
        done ? 'is-done' : '',
        selected ? 'is-selected' : '',
        highlighted ? 'is-highlight' : '',
        checked ? 'is-batch-selected' : '',
        dragging ? 'is-dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-task-id={task.id}
      draggable={draggable}
      onDragStart={
        draggable && onDragStart
          ? (event) => onDragStart(event, task)
          : undefined
      }
      onPointerDown={
        onPointerDragStart
          ? (event) => onPointerDragStart(event, task)
          : undefined
      }
    >
      {selectable ? (
        <input
          type="checkbox"
          className="task-select"
          aria-label={`选择任务：${task.title}`}
          checked={checked}
          onChange={(event) => onCheckedChange?.(event.target.checked)}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}

      <button
        type="button"
        className="task-check"
        aria-label={`${done ? '撤销完成' : '完成任务'}：${task.title}`}
        aria-pressed={done}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        {done ? '✓' : ''}
      </button>

      <button
        type="button"
        className="task-row-body"
        onClick={onSelect}
        aria-label={`查看任务：${task.title}`}
      >
        <span className="task-title" title={task.title}>
          {task.title}
        </span>
        <span className="task-meta">
          <span>{listDisplayName(lists, task.listId)}</span>
          {task.dueDate ? (
            <span
              className={
                overdueLabel
                  ? 'task-badge task-badge--overdue'
                  : 'task-badge task-badge--today'
              }
            >
              {overdueLabel || formatDueLabel(task, today)}
            </span>
          ) : (
            <span className="task-badge">未安排</span>
          )}
          {completedLabel ? (
            <span className="task-badge task-badge--done">
              完成于 {completedLabel}
            </span>
          ) : null}
          {task.priority > 0 ? (
            <span
              className="task-prio"
              aria-label={`优先级 ${task.priority}`}
            >
              {[1, 2, 3].map((level) => (
                <i
                  key={level}
                  className={level <= task.priority ? 'on' : undefined}
                />
              ))}
            </span>
          ) : null}
          {notesMatched ? (
            <span className="task-badge task-badge--hit">备注命中</span>
          ) : task.notes.trim() ? (
            <span className="task-badge">备注</span>
          ) : null}
        </span>
      </button>

      {onStatusChange ? (
        <TaskStatusButton task={task} onChange={onStatusChange} />
      ) : (
        <span
          className={`task-status-toggle task-status-toggle--${task.status} is-static`}
        >
          <span className="task-status-dot" aria-hidden="true" />
          {statusLabel(task.status)}
        </span>
      )}

      {actions ? <div className="task-row-actions">{actions}</div> : null}
    </div>
  );
}

export function dueTone(task: Task, today: string): string {
  return isOverdue(task, today) ? 'danger' : 'normal';
}
