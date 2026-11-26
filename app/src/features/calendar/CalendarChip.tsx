/**
 * 月/周/日视图中的统一条目芯片：任务可拖，事件/倒数日只打开编辑。
 *
 * 拖拽主链路走 Pointer Events（见 ZX-DESIGN-17）：
 * - 只有未完成的任务芯片带 `data-draggable="true"` 和 grab 光标；
 * - 有 PointerEvent 的宿主不设置原生 `draggable`，避免 WKWebView 抢走指针；
 * - 无 PointerEvent 的旧环境保留 HTML5 dragstart/drop 作为降级。
 */

import type {
  DragEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

import { isIcsEvent } from './ics/types';
import { entryTimeLabel, type CalendarEntry } from './viewModel';

export type CalendarChipPointerOrigin = {
  pointerId: number;
  clientX: number;
  clientY: number;
};

export type CalendarChipPointerHandler = (
  entry: CalendarEntry,
  element: HTMLElement,
  origin: CalendarChipPointerOrigin,
) => void;

/** 只有未完成任务可拖；已完成、事件、倒数日一律不可拖。 */
export function isDraggableEntry(entry: CalendarEntry): boolean {
  return entry.kind === 'task' && entry.task.status !== 'done';
}

/** 是否支持 Pointer Events；不支持时退回 HTML5 拖放。 */
export function hasPointerEvents(): boolean {
  return typeof window !== 'undefined' && 'PointerEvent' in window;
}

export type CalendarChipProps = {
  entry: CalendarEntry;
  compact?: boolean;
  draggable?: boolean;
  /** 当前 Pointer 拖拽中的任务 id；用于给源芯片加淡化样式。 */
  dragSource?: boolean;
  onDragStart?: (entry: CalendarEntry, event: DragEvent<HTMLElement>) => void;
  onPointerDragStart?: CalendarChipPointerHandler;
  onOpenTask: (entry: CalendarEntry) => void;
  onOpenEvent: (entry: CalendarEntry) => void;
  onOpenCountdown: (entry: CalendarEntry) => void;
};

export function CalendarChip({
  entry,
  compact = false,
  draggable = false,
  dragSource = false,
  onDragStart,
  onPointerDragStart,
  onOpenTask,
  onOpenEvent,
  onOpenCountdown,
}: CalendarChipProps) {
  const time = entry.time;
  const readOnly = entry.kind === 'event' && isIcsEvent(entry.event);
  const canDrag = draggable && isDraggableEntry(entry);
  const pointerEvents = hasPointerEvents();

  const open = () => {
    if (entry.kind === 'task') {
      onOpenTask(entry);
    } else if (entry.kind === 'event') {
      onOpenEvent(entry);
    } else {
      onOpenCountdown(entry);
    }
  };

  const handleDragStart = (event: DragEvent<HTMLButtonElement>) => {
    if (!canDrag) {
      return;
    }
    event.stopPropagation();
    try {
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', entry.id);
      }
    } catch {
      // jsdom / 受限环境仍使用组件内拖拽状态。
    }
    onDragStart?.(entry, event);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!canDrag || !pointerEvents) {
      return;
    }
    if (event.button !== 0 || event.isPrimary === false) {
      return;
    }
    onPointerDragStart?.(entry, event.currentTarget, {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };

  return (
    <button
      type="button"
      className={[
        'calendar-chip',
        `calendar-chip--${entry.kind}`,
        compact ? 'calendar-chip--compact' : '',
        canDrag ? 'calendar-chip--draggable' : '',
        dragSource ? 'is-drag-source' : '',
        readOnly ? 'calendar-chip--readonly' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      // Pointer 宿主禁用原生 draggable，HTML5 仅作为无 PointerEvent 时的回退。
      draggable={canDrag && !pointerEvents}
      data-task-id={entry.kind === 'task' ? entry.id : undefined}
      data-entry-kind={entry.kind}
      data-draggable={canDrag ? 'true' : undefined}
      data-readonly={readOnly ? 'true' : undefined}
      title={
        entry.kind === 'countdown'
          ? `${entry.title} · 倒数日只计数`
          : `${entryTimeLabel(entry)} ${entry.title}${readOnly ? ' · 外部日历只读' : ''}`
      }
      aria-label={`${entry.kind === 'task' ? '任务' : entry.kind === 'event' ? '事件' : '倒数日'}：${entry.title}${readOnly ? '（只读）' : ''}`}
      onPointerDown={handlePointerDown}
      onDragStart={handleDragStart}
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
    >
      {entry.kind === 'countdown' ? (
        <span className="calendar-chip-mark" aria-hidden="true">
          ◆
        </span>
      ) : null}
      {time ? <span className="calendar-chip-time">{time}</span> : null}
      <span className="calendar-chip-title">{entry.title}</span>
    </button>
  );
}
