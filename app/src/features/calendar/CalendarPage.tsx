/**
 * 日历工作台：日历（月/周/日）、事件、倒数日、小工具四个分区。
 *
 * 任务来自 TaskStore（唯一任务实体），事件/倒数日来自 CalendarStore；
 * 三者只在日期上投影并列，不复制数据、不互相生成完成状态。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import {
  addDaysISO,
  addMonthsISO,
  deriveLunarFields,
  formatMonthDay,
  formatWeekday,
  normalizeCalendarType,
  normalizeCountdownRepeat,
} from '../../data/calendar';
import type { Countdown, Event, Note } from '../../data/db/types';
import { CountdownDialog, type CountdownPrefill } from '../countdowns/CountdownDialog';
import {
  CountdownsSection,
} from '../countdowns/CountdownsSection';
import {
  toCountdownUpdate,
  toNewCountdown,
} from '../countdowns/countdownRepository';
import { EventDialog, type EventDraft } from '../events/EventDialog';
import {
  buildTaskFromEvent,
  eventStartAt,
  toEventUpdate,
} from '../events/eventRepository';
import { EventsSection } from '../events/EventsSection';
import { useToast } from '../tasks/Feedback';
import { NewTaskDialog } from '../tasks/NewTaskDialog';
import {
  formatError,
  useTaskStore,
} from '../tasks/TaskStore';
import { TaskStoreGate } from '../tasks/TaskStoreGate';
import {
  hasPointerEvents,
  isDraggableEntry,
  type CalendarChipPointerHandler,
  type CalendarChipPointerOrigin,
} from './CalendarChip';
import { isIcsEvent } from './ics/types';
import {
  CalendarDataGate,
  useCalendarData,
} from './CalendarStore';
import { DatePanel } from './DatePanel';
import { DayView } from './DayView';
import { MonthView } from './MonthView';
import { ToolsSection } from './ToolsSection';
import {
  CALENDAR_TABS,
  CALENDAR_VIEWS,
  formatCalendarTitle,
  type CalendarEntry,
  type CalendarTab,
  type CalendarView,
} from './viewModel';
import { WeekView } from './WeekView';
import { workdayRuleLabel } from './workweek';
import './calendar.css';

export type CalendarPageProps = {
  initialView?: CalendarView;
  initialTab?: CalendarTab;
  initialDate?: string;
};

/** 指针移动超过 4px 才进入拖拽，低于阈值仍按点击处理。 */
const POINTER_DRAG_THRESHOLD = 4;
/** 命中失败时允许吸附到最近日期格的最大距离（CSS px）。 */
const POINTER_NEAREST_CELL_LIMIT = 48;
/** 拖拽结束后抑制紧随其后的 click 的兜底时长。 */
const POINTER_CLICK_SUPPRESS_MS = 450;

type PointerDragState = {
  phase: 'idle' | 'press' | 'drag';
  pointerId: number | null;
  taskId: string | null;
  x0: number;
  y0: number;
  grabDx: number;
  grabDy: number;
  ghost: HTMLDivElement | null;
  sourceEl: HTMLElement | null;
  targetDate: string | null;
  title: string;
  time: string | null;
};

function idlePointerDrag(): PointerDragState {
  return {
    phase: 'idle',
    pointerId: null,
    taskId: null,
    x0: 0,
    y0: 0,
    grabDx: 0,
    grabDy: 0,
    ghost: null,
    sourceEl: null,
    targetDate: null,
    title: '',
    time: null,
  };
}

function createPointerGhost(
  source: HTMLElement,
  time: string | null,
  title: string,
): HTMLDivElement {
  const rect = source.getBoundingClientRect();
  const ghost = document.createElement('div');
  ghost.dataset.dragGhost = 'true';
  ghost.setAttribute('aria-hidden', 'true');
  if (time) {
    const timeEl = document.createElement('span');
    timeEl.className = 'calendar-drag-ghost-time';
    timeEl.textContent = time;
    ghost.appendChild(timeEl);
  }
  const titleEl = document.createElement('span');
  titleEl.className = 'calendar-drag-ghost-title';
  titleEl.textContent = title;
  ghost.appendChild(titleEl);
  ghost.style.width = `${Math.min(Math.max(rect.width, 112), 240)}px`;
  document.body.appendChild(ghost);
  return ghost;
}

/**
 * 解析指针下的目标日期：
 * 1. 优先 `elementFromPoint` 命中 `[data-drop-date]`；
 * 2. 指针在网格外扩 24px 之外 → 取消；
 * 3. 否则吸附 48px 内最近的日期格。
 *
 * jsdom 的 `getBoundingClientRect` 恒为 0，测试只打桩 `elementFromPoint` 即可；
 * 没有该 API 的环境（极旧 WebView）自然走不到命中，退回 HTML5 分支。
 */
function resolvePointerDropDate(x: number, y: number): string | null {
  if (typeof document.elementFromPoint === 'function') {
    const hit = document
      .elementFromPoint(x, y)
      ?.closest?.('[data-drop-date]') as HTMLElement | null | undefined;
    if (hit?.dataset.dropDate) {
      return hit.dataset.dropDate;
    }
  }

  const cells = Array.from(
    document.querySelectorAll<HTMLElement>('[data-drop-date]'),
  );
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const cell of cells) {
    const rect = cell.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      continue;
    }
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (left === Infinity) {
    return null;
  }
  if (x < left - 24 || x > right + 24 || y < top - 24 || y > bottom + 24) {
    return null;
  }

  let bestDate: string | null = null;
  let bestDistance = Infinity;
  for (const cell of cells) {
    const rect = cell.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      continue;
    }
    const cx = Math.min(Math.max(x, rect.left), rect.right);
    const cy = Math.min(Math.max(y, rect.top), rect.bottom);
    const distance = Math.hypot(x - cx, y - cy);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestDate = cell.dataset.dropDate ?? null;
    }
  }
  return bestDistance <= POINTER_NEAREST_CELL_LIMIT ? bestDate : null;
}

export function CalendarPage({
  initialView = 'month',
  initialTab = 'calendar',
  initialDate,
}: CalendarPageProps) {
  const store = useTaskStore();
  const data = useCalendarData();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [view, setView] = useState<CalendarView>(initialView);
  const [tab, setTab] = useState<CalendarTab>(initialTab);
  const [selectedDate, setSelectedDate] = useState(
    initialDate ?? store.today,
  );

  const [eventOpen, setEventOpen] = useState(false);
  const [eventDate, setEventDate] = useState(selectedDate);
  const [editingEvent, setEditingEvent] = useState<Event | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);

  const [countdownOpen, setCountdownOpen] = useState(false);
  const [editingCountdown, setEditingCountdown] = useState<Countdown | null>(
    null,
  );
  const [countdownPrefill, setCountdownPrefill] = useState<
    CountdownPrefill | undefined
  >(undefined);

  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [taskDialogDate, setTaskDialogDate] = useState(selectedDate);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  // Pointer 拖拽状态：press 只记录起点，移动过阈值后才是 drag。
  const pointerDragRef = useRef<PointerDragState>(idlePointerDrag());
  const [pointerDragTaskId, setPointerDragTaskId] = useState<string | null>(
    null,
  );
  const [pointerTargetDate, setPointerTargetDate] = useState<string | null>(
    null,
  );
  const [dragAnnouncement, setDragAnnouncement] = useState('');
  const latestTasksRef = useRef(store.tasks);
  latestTasksRef.current = store.tasks;
  const dropTaskRef = useRef<(date: string, taskId: string) => void>(() => {});
  const clickSuppressionRef = useRef<{
    handler: ((event: MouseEvent) => void) | null;
    timer: number | null;
  }>({ handler: null, timer: null });
  const announceTimerRef = useRef<number | null>(null);
  const [eventTaskBusyId, setEventTaskBusyId] = useState<string | null>(null);
  const eventTaskBusyRef = useRef(new Set<string>());
  const eventTaskCooldownRef = useRef(new Map<string, number>());

  useEffect(() => {
    if (!eventOpen) {
      setNotes([]);
      return;
    }
    let cancelled = false;
    void store
      .listNotes({ status: 'active' })
      .then((rows) => {
        if (!cancelled) {
          setNotes(rows);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNotes([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [eventOpen, store.listNotes]);

  const title = formatCalendarTitle(view, selectedDate, data.weekStart);

  const defaultListId = useMemo(
    () =>
      store.lists.find((list) => !list.isInbox)?.id ??
      store.inbox?.id ??
      '',
    [store.lists, store.inbox],
  );

  const notifyError = (reason: unknown) => {
    toast(formatError(reason), { tone: 'danger' });
  };

  const move = (direction: -1 | 1) => {
    if (view === 'month') {
      setSelectedDate((current) => addMonthsISO(current, direction));
      return;
    }
    setSelectedDate((current) =>
      addDaysISO(current, view === 'week' ? direction * 7 : direction),
    );
  };

  const goToday = () => {
    setSelectedDate(store.today);
  };

  const openNewEvent = (date: string) => {
    setEditingEvent(null);
    setEventDate(date);
    setEventOpen(true);
  };

  const explainReadOnlyEvent = () => {
    toast(
      '外部日历事件为只读，不会写回订阅源；请到设置中同步或取消订阅',
      { tone: 'info' },
    );
  };

  const openEditEvent = (event: Event) => {
    if (isIcsEvent(event)) {
      explainReadOnlyEvent();
      return;
    }
    setEditingEvent(event);
    setEventDate(event.startDate);
    setEventOpen(true);
  };

  const openNewCountdown = (prefill?: CountdownPrefill) => {
    setEditingCountdown(null);
    setCountdownPrefill(prefill);
    setCountdownOpen(true);
  };

  const openEditCountdown = (countdown: Countdown) => {
    setEditingCountdown(countdown);
    setCountdownPrefill(undefined);
    setCountdownOpen(true);
  };

  const openNewTask = () => {
    setTaskDialogDate(selectedDate);
    setTaskDialogOpen(true);
  };

  const openTaskEntry = (entry: CalendarEntry) => {
    if (entry.kind !== 'task') {
      return;
    }
    navigate(`/today?task=${encodeURIComponent(entry.id)}`);
  };

  const openEventEntry = (entry: CalendarEntry) => {
    if (entry.kind === 'event') {
      openEditEvent(entry.event);
    }
  };

  const openCountdownEntry = (entry: CalendarEntry) => {
    if (entry.kind === 'countdown') {
      openEditCountdown(entry.countdown);
    }
  };

  // 搜索结果深链：/calendar?tab=events&event=<id> 或
  // /calendar?tab=countdowns&countdown=<id>。等本地库就绪后再消费一次，
  // 然后清理 URL，避免刷新后反复弹出编辑框。
  useEffect(() => {
    if (data.status !== 'ready') {
      return;
    }
    const eventId = searchParams.get('event');
    const countdownId = searchParams.get('countdown');
    const tabParam = searchParams.get('tab');
    const dateParam = searchParams.get('date');
    if (!eventId && !countdownId && !tabParam && !dateParam) {
      return;
    }

    if (tabParam && CALENDAR_TABS.some((tabItem) => tabItem.value === tabParam)) {
      setTab(tabParam as CalendarTab);
    }
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      setSelectedDate(dateParam);
    }

    if (eventId) {
      const event = data.events.find((item) => item.id === eventId);
      setTab('events');
      if (event) {
        setSelectedDate(event.startDate);
        if (isIcsEvent(event)) {
          toast(
            '外部日历事件为只读，不会写回订阅源；请到设置中同步或取消订阅',
            { tone: 'info' },
          );
        } else {
          setEventDate(event.startDate);
          setEditingEvent(event);
          setEventOpen(true);
        }
      } else {
        toast('事件不存在或已被删除', { tone: 'danger' });
      }
    } else if (countdownId) {
      const countdown = data.countdowns.find((item) => item.id === countdownId);
      setTab('countdowns');
      if (countdown) {
        setSelectedDate(countdown.targetDate);
        setCountdownPrefill(undefined);
        setEditingCountdown(countdown);
        setCountdownOpen(true);
      } else {
        toast('倒数日不存在或已被删除', { tone: 'danger' });
      }
    }

    const next = new URLSearchParams(searchParams);
    next.delete('event');
    next.delete('countdown');
    next.delete('tab');
    next.delete('date');
    setSearchParams(next, { replace: true });
  }, [
    data.status,
    data.events,
    data.countdowns,
    searchParams,
    setSearchParams,
    toast,
  ]);

  const handleDropTask = (date: string, taskId: string) => {
    const id = taskId || draggingTaskId;
    setDraggingTaskId(null);
    if (!id) {
      return;
    }
    const task = store.tasks.find((item) => item.id === id);
    if (!task || task.status === 'done') {
      return;
    }
    if (task.dueDate === date) {
      setSelectedDate(date);
      return;
    }
    setSelectedDate(date);
    // 只改 dueDate，dueTime 原样保留；历史 dueAt 非空时置空，
    // 让提醒回退到 dueDate + dueTime，避免提醒时刻漂移到旧日期。
    const patch = task.dueAt
      ? { dueDate: date, dueAt: null }
      : { dueDate: date };
    void store
      .patchTask(task.id, patch)
      .then(() => {
        toast(`已改期到 ${formatMonthDay(date)}`, { tone: 'success' });
      })
      .catch(notifyError);
  };

  dropTaskRef.current = handleDropTask;

  const announceDrag = (message: string) => {
    if (announceTimerRef.current !== null) {
      window.clearTimeout(announceTimerRef.current);
    }
    setDragAnnouncement('');
    announceTimerRef.current = window.setTimeout(() => {
      setDragAnnouncement(message);
      announceTimerRef.current = null;
    }, 20);
  };

  const clearClickSuppression = () => {
    const current = clickSuppressionRef.current;
    if (current.handler) {
      window.removeEventListener('click', current.handler, true);
      current.handler = null;
    }
    if (current.timer !== null) {
      window.clearTimeout(current.timer);
      current.timer = null;
    }
  };

  /** 拖拽结束（成功/取消/取消键）后吞掉紧随其后的一次 click。 */
  const armClickSuppression = () => {
    clearClickSuppression();
    const handler = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      clearClickSuppression();
    };
    clickSuppressionRef.current.handler = handler;
    window.addEventListener('click', handler, true);
    clickSuppressionRef.current.timer = window.setTimeout(
      clearClickSuppression,
      POINTER_CLICK_SUPPRESS_MS,
    );
  };

  const detachPointerDragDom = (state: PointerDragState) => {
    // 先置 idle，再释放捕获：避免 lostpointercapture 重入取消流程。
    state.phase = 'idle';
    state.ghost?.remove();
    state.ghost = null;
    state.sourceEl?.classList.remove('is-drag-source');
    document.body.classList.remove('is-calendar-dragging');
    document
      .querySelectorAll('[data-drop-active="true"]')
      .forEach((element) => element.removeAttribute('data-drop-active'));
    if (state.sourceEl && state.pointerId !== null) {
      try {
        state.sourceEl.releasePointerCapture?.(state.pointerId);
      } catch {
        // jsdom / WKWebView 可能没有指针捕获，不影响改期。
      }
    }
  };

  const resetPointerDrag = () => {
    pointerDragRef.current = idlePointerDrag();
    setPointerDragTaskId(null);
    setPointerTargetDate(null);
  };

  const focusTaskChip = (taskId: string) => {
    const schedule =
      typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : (callback: FrameRequestCallback) =>
            window.setTimeout(() => callback(0), 0);
    schedule(() => {
      const chip = document.querySelector<HTMLElement>(
        `[data-testid="month-grid"] [data-task-id="${taskId}"], [data-testid="week-grid"] [data-task-id="${taskId}"]`,
      );
      chip?.focus?.({ preventScroll: true });
    });
  };

  const beginPointerPress: CalendarChipPointerHandler = (
    entry,
    element,
    origin: CalendarChipPointerOrigin,
  ) => {
    if (!hasPointerEvents() || !isDraggableEntry(entry)) {
      return;
    }
    if (pointerDragRef.current.phase !== 'idle') {
      // 拖拽中收到第二指针，忽略，不切换任务。
      return;
    }
    const task = latestTasksRef.current.find((item) => item.id === entry.id);
    if (!task || task.status === 'done') {
      return;
    }
    const rect = element.getBoundingClientRect();
    pointerDragRef.current = {
      phase: 'press',
      pointerId: origin.pointerId,
      taskId: task.id,
      x0: origin.clientX,
      y0: origin.clientY,
      grabDx: origin.clientX - rect.left,
      grabDy: origin.clientY - rect.top,
      ghost: null,
      sourceEl: element,
      targetDate: null,
      title: task.title,
      time: task.dueTime,
    };
  };

  const enterPointerDrag = (state: PointerDragState) => {
    state.phase = 'drag';
    try {
      state.ghost = createPointerGhost(
        state.sourceEl as HTMLElement,
        state.time,
        state.title,
      );
    } catch {
      // 装饰失败不阻断改期，仍高亮目标并允许落点。
      state.ghost = null;
    }
    state.sourceEl?.classList.add('is-drag-source');
    document.body.classList.add('is-calendar-dragging');
    if (state.sourceEl && state.pointerId !== null) {
      try {
        state.sourceEl.setPointerCapture?.(state.pointerId);
      } catch {
        // 捕获不可用时 window 级监听仍能完成拖拽。
      }
    }
    setPointerDragTaskId(state.taskId);
    armClickSuppression();
    announceDrag(`已抓起任务：${state.title}，移动到日期格后松开`);
  };

  const finishPointerDrag = (
    state: PointerDragState,
    x: number,
    y: number,
  ) => {
    const taskId = state.taskId ?? '';
    const target = resolvePointerDropDate(x, y);
    const task = latestTasksRef.current.find((item) => item.id === taskId);
    detachPointerDragDom(state);
    resetPointerDrag();
    // 延长抑制窗口，覆盖浏览器在 pointerup 之后派发的 click。
    armClickSuppression();

    if (!task || task.status === 'done') {
      announceDrag('任务已变化，未改期');
      toast('任务已变化，未改期', { tone: 'info' });
      return;
    }
    if (!target) {
      announceDrag('已取消改期');
      state.sourceEl?.focus?.({ preventScroll: true });
      return;
    }
    if (task.dueDate === target) {
      setSelectedDate(target);
      announceDrag('日期未变化');
      focusTaskChip(taskId);
      return;
    }

    announceDrag(
      `已改期到 ${formatMonthDay(target)}，时间 ${task.dueTime ?? '全天'} 不变`,
    );
    dropTaskRef.current(target, taskId);
    focusTaskChip(taskId);
  };

  const cancelPointerDrag = (state: PointerDragState) => {
    if (state.phase === 'idle') {
      return;
    }
    const wasDragging = state.phase === 'drag';
    detachPointerDragDom(state);
    resetPointerDrag();
    if (wasDragging) {
      armClickSuppression();
      announceDrag('已取消改期');
      state.sourceEl?.focus?.({ preventScroll: true });
    }
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const state = pointerDragRef.current;
      if (state.phase === 'idle' || event.pointerId !== state.pointerId) {
        return;
      }
      if (state.phase === 'press') {
        const distance = Math.hypot(
          event.clientX - state.x0,
          event.clientY - state.y0,
        );
        if (distance < POINTER_DRAG_THRESHOLD) {
          return;
        }
        const task = latestTasksRef.current.find(
          (item) => item.id === state.taskId,
        );
        if (!task || task.status === 'done') {
          resetPointerDrag();
          return;
        }
        enterPointerDrag(state);
      }
      if (state.phase !== 'drag') {
        return;
      }
      if (event.cancelable) {
        event.preventDefault();
      }
      if (state.ghost) {
        state.ghost.style.transform = `translate3d(${
          event.clientX - state.grabDx + 6
        }px, ${event.clientY - state.grabDy + 6}px, 0)`;
      }
      const target = resolvePointerDropDate(event.clientX, event.clientY);
      if (target !== state.targetDate) {
        state.targetDate = target;
        setPointerTargetDate(target);
        if (target) {
          announceDrag(
            `目标日期：${formatMonthDay(target)} ${formatWeekday(target)}`,
          );
        }
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      const state = pointerDragRef.current;
      if (state.phase === 'idle' || event.pointerId !== state.pointerId) {
        return;
      }
      if (state.phase === 'press') {
        // 未过阈值：清掉 press，交给浏览器正常派发 click。
        resetPointerDrag();
        return;
      }
      finishPointerDrag(state, event.clientX, event.clientY);
    };

    const onPointerCancel = (event: PointerEvent) => {
      const state = pointerDragRef.current;
      if (state.phase === 'idle') {
        return;
      }
      if (
        event.pointerId !== undefined &&
        state.pointerId !== null &&
        event.pointerId !== state.pointerId
      ) {
        return;
      }
      cancelPointerDrag(state);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const state = pointerDragRef.current;
      if (state.phase === 'idle') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      cancelPointerDrag(state);
    };

    const onWindowBlur = () => {
      const state = pointerDragRef.current;
      if (state.phase !== 'idle') {
        cancelPointerDrag(state);
      }
    };

    const onLostPointerCapture = (event: PointerEvent) => {
      const state = pointerDragRef.current;
      if (state.phase !== 'drag' || !state.sourceEl) {
        return;
      }
      if (event.target === state.sourceEl) {
        cancelPointerDrag(state);
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener(
      'lostpointercapture',
      onLostPointerCapture,
    );

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener(
        'lostpointercapture',
        onLostPointerCapture,
      );
      clearClickSuppression();
      if (announceTimerRef.current !== null) {
        window.clearTimeout(announceTimerRef.current);
        announceTimerRef.current = null;
      }
      detachPointerDragDom(pointerDragRef.current);
      pointerDragRef.current = idlePointerDrag();
    };
    // 监听器只注册一次，内部通过 ref 读取最新任务与写库函数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTaskCreate = async (
    input: Parameters<typeof store.createTask>[0],
    subtaskTitles: string[],
  ) => {
    const task = await store.createTask(input);
    for (const subtaskTitle of subtaskTitles) {
      await store.addSubtask(task.id, subtaskTitle);
    }
    setTaskDialogOpen(false);
    setSelectedDate(input.dueDate ?? selectedDate);
    toast('已创建任务', { tone: 'success' });
  };

  const handleEventSubmit = async (draft: EventDraft, eventId?: string) => {
    try {
      const startAt = eventStartAt(draft.date, draft.time);
      if (eventId) {
        const existing = data.events.find((event) => event.id === eventId);
        if (!existing) {
          throw new Error('事件不存在或已被删除');
        }
        await data.updateEvent(
          eventId,
          toEventUpdate(existing, {
            title: draft.title,
            eventType: draft.eventType,
            allDay: !draft.time,
            startDate: draft.date,
            startAt,
            repeatRule: draft.repeatRule,
            calendarType:
              draft.calendarType === 'lunar' ? 'lunar' : 'solar',
            noteId: draft.noteId || null,
          }),
        );
        toast('事件已更新', { tone: 'success' });
      } else {
        await data.createEvent({
          title: draft.title,
          eventType: draft.eventType,
          allDay: !draft.time,
          startDate: draft.date,
          startAt,
          endAt: null,
          repeatRule: draft.repeatRule,
          calendarType: draft.calendarType === 'lunar' ? 'lunar' : 'solar',
          noteId: draft.noteId || null,
          color: '',
        });
        toast('已添加事件', { tone: 'success' });
      }
      setSelectedDate(draft.date);
      setEventOpen(false);
    } catch (reason) {
      notifyError(reason);
      throw reason;
    }
  };

  const handleEventDelete = async (event: Event) => {
    if (isIcsEvent(event)) {
      explainReadOnlyEvent();
      return;
    }
    try {
      await data.removeEvent(event.id);
      toast('事件已删除', { tone: 'success' });
    } catch (reason) {
      notifyError(reason);
    }
  };

  const handleEventToTask = async (event: Event) => {
    const now = Date.now();
    const last = eventTaskCooldownRef.current.get(event.id) ?? 0;
    if (eventTaskBusyRef.current.has(event.id) || now - last < 1000) {
      return;
    }
    eventTaskCooldownRef.current.set(event.id, now);
    eventTaskBusyRef.current.add(event.id);
    setEventTaskBusyId(event.id);
    try {
      const input = buildTaskFromEvent(event, store.lists);
      await store.createTask(input);
      toast(`已创建任务「${input.title}」`, { tone: 'success' });
    } catch (reason) {
      notifyError(reason);
    } finally {
      eventTaskBusyRef.current.delete(event.id);
      setEventTaskBusyId((current) => (current === event.id ? null : current));
    }
  };

  const handleCountdownSubmit = async (
    draft: Parameters<typeof toNewCountdown>[0],
    countdownId?: string,
  ) => {
    try {
      if (countdownId) {
        const existing = data.countdowns.find(
          (countdown) => countdown.id === countdownId,
        );
        if (!existing) {
          throw new Error('倒数日不存在或已被删除');
        }
        const calendarType = normalizeCalendarType(draft.calendarType);
        const repeatRule = normalizeCountdownRepeat(
          calendarType,
          draft.repeatRule,
        );
        const lunar =
          calendarType === 'lunar'
            ? deriveLunarFields(draft.targetDate)
            : null;
        await data.updateCountdown(
          countdownId,
          toCountdownUpdate(existing, {
            title: draft.title,
            category: draft.category,
            calendarType,
            targetDate: draft.targetDate,
            repeatRule,
            lunarMonth: lunar?.lunarMonth ?? null,
            lunarDay: lunar?.lunarDay ?? null,
            note: draft.note,
          }),
        );
        toast('倒数日已更新', { tone: 'success' });
      } else {
        await data.createCountdown(toNewCountdown(draft));
        toast('已添加倒数日', { tone: 'success' });
      }
      setCountdownOpen(false);
    } catch (reason) {
      notifyError(reason);
      throw reason;
    }
  };

  const handleCountdownDelete = async (countdown: Countdown) => {
    try {
      await data.removeCountdown(countdown.id);
      toast('倒数日已删除', { tone: 'success' });
    } catch (reason) {
      notifyError(reason);
    }
  };

  const handleAddCountdownFromTool = (prefill: CountdownPrefill) => {
    setTab('countdowns');
    openNewCountdown(prefill);
  };

  const toggleLunar = () => {
    void data.setShowLunar(!data.showLunar).catch(notifyError);
  };

  return (
    <section className="calendar-page" aria-labelledby="calendar-title-heading">
      <header className="calendar-page-head">
        <div>
          <p className="calendar-eyebrow">时间 · 日历</p>
          <h1 id="calendar-title-heading">日历</h1>
          <p className="calendar-page-sub">
            月、周、日视图并列展示任务、事件与倒数日；拖动任务只改日期，不改时间。
          </p>
        </div>
        <div className="calendar-page-actions">
          {tab === 'calendar' ? (
            <>
              <button
                type="button"
                className="task-button"
                aria-label="新建事件"
                onClick={() => openNewEvent(selectedDate)}
              >
                ＋ 事件
              </button>
              <button
                type="button"
                className="task-button task-button--primary"
                aria-label="新建任务"
                onClick={openNewTask}
              >
                ＋ 任务
              </button>
            </>
          ) : null}
          {tab === 'events' ? (
            <button
              type="button"
              className="task-button task-button--primary"
              aria-label="新建事件"
              onClick={() => openNewEvent(selectedDate)}
            >
              ＋ 事件
            </button>
          ) : null}
          {tab === 'countdowns' ? (
            <button
              type="button"
              className="task-button task-button--primary"
              aria-label="新建倒数日"
              onClick={() => openNewCountdown()}
            >
              ＋ 倒数日
            </button>
          ) : null}
        </div>
      </header>

      <TaskStoreGate>
        <CalendarDataGate>
          <div className="calendar-tabs" role="tablist" aria-label="日历分区">
            {CALENDAR_TABS.map((item) => (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={tab === item.value}
                className={
                  tab === item.value
                    ? 'calendar-tab calendar-tab--active'
                    : 'calendar-tab'
                }
                onClick={() => setTab(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {tab === 'calendar' ? (
            <>
              <div className="calendar-toolbar">
                <div className="calendar-nav">
                  <button
                    type="button"
                    className="task-button task-button--small"
                    aria-label="上一段"
                    onClick={() => move(-1)}
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    className="task-button task-button--small"
                    onClick={goToday}
                  >
                    今天
                  </button>
                  <button
                    type="button"
                    className="task-button task-button--small"
                    aria-label="下一段"
                    onClick={() => move(1)}
                  >
                    ›
                  </button>
                  <h2 className="calendar-title" data-testid="calendar-title">
                    {title}
                  </h2>
                </div>

                <div
                  className="calendar-view-switch"
                  role="group"
                  aria-label="日历视图"
                >
                  {CALENDAR_VIEWS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={
                        view === item.value
                          ? 'calendar-view calendar-view--active'
                          : 'calendar-view'
                      }
                      aria-label={item.label}
                      aria-pressed={view === item.value}
                      onClick={() => setView(item.value)}
                    >
                      {item.short}
                    </button>
                  ))}
                </div>

                <label className="calendar-lunar-toggle">
                  <input
                    type="checkbox"
                    checked={data.showLunar}
                    onChange={toggleLunar}
                  />
                  显示农历
                </label>
              </div>

              <div className="calendar-legend">
                <span>
                  <i className="calendar-legend-task" /> 任务 · 可完成/可拖动
                </span>
                <span>
                  <i className="calendar-legend-event" /> 事件 · 占时间
                </span>
                <span>
                  <i className="calendar-legend-countdown" /> 倒数日 · 只计数
                </span>
                {data.events.some(isIcsEvent) ? (
                  <span>
                    <i className="calendar-legend-ics" /> 外部日历 · 只读
                  </span>
                ) : null}
                <span className="calendar-legend-holiday">
                  休/班 · 法定节假日{' '}
                  {data.holidayState?.version ??
                    `${data.holidayPackages.at(-1)?.year ?? 2026}`}{' '}
                  · 周起始
                  {data.weekStart === 'monday' ? '周一' : '周日'} ·{' '}
                  {workdayRuleLabel(data.workdayRule)}
                  {data.dateExceptions.length > 0
                    ? ` · 个人例外 ${data.dateExceptions.length} 天`
                    : ''}
                </span>
              </div>

              <div
                className="zx-visually-hidden"
                role="status"
                aria-live="polite"
                data-testid="calendar-drag-status"
              >
                {dragAnnouncement}
              </div>

              <div className="calendar-layout">
                <div className="calendar-main">
                  {view === 'month' ? (
                    <MonthView
                      selectedDate={selectedDate}
                      today={store.today}
                      tasks={store.tasks}
                      events={data.events}
                      countdowns={data.countdowns}
                      showLunar={data.showLunar}
                      weekStart={data.weekStart}
                      workdayRule={data.workdayRule}
                      holidayLookup={data.holidayLookup}
                      dateExceptions={data.dateExceptions}
                      onSelectDate={setSelectedDate}
                      onTaskDragStart={(entry) => {
                        if (entry.kind === 'task') {
                          setDraggingTaskId(entry.id);
                        }
                      }}
                      onDropTask={handleDropTask}
                      dragTaskId={pointerDragTaskId}
                      dragTargetDate={pointerTargetDate}
                      onPointerDragStart={beginPointerPress}
                      onOpenTask={openTaskEntry}
                      onOpenEvent={openEventEntry}
                      onOpenCountdown={openCountdownEntry}
                    />
                  ) : null}
                  {view === 'week' ? (
                    <WeekView
                      selectedDate={selectedDate}
                      today={store.today}
                      tasks={store.tasks}
                      events={data.events}
                      countdowns={data.countdowns}
                      showLunar={data.showLunar}
                      weekStart={data.weekStart}
                      workdayRule={data.workdayRule}
                      holidayLookup={data.holidayLookup}
                      dateExceptions={data.dateExceptions}
                      onSelectDate={setSelectedDate}
                      onTaskDragStart={(entry) => {
                        if (entry.kind === 'task') {
                          setDraggingTaskId(entry.id);
                        }
                      }}
                      onDropTask={handleDropTask}
                      dragTaskId={pointerDragTaskId}
                      dragTargetDate={pointerTargetDate}
                      onPointerDragStart={beginPointerPress}
                      onOpenTask={openTaskEntry}
                      onOpenEvent={openEventEntry}
                      onOpenCountdown={openCountdownEntry}
                    />
                  ) : null}
                  {view === 'day' ? (
                    <DayView
                      selectedDate={selectedDate}
                      today={store.today}
                      tasks={store.tasks}
                      events={data.events}
                      countdowns={data.countdowns}
                      showLunar={data.showLunar}
                      workdayRule={data.workdayRule}
                      holidayLookup={data.holidayLookup}
                      dateExceptions={data.dateExceptions}
                      onOpenTask={openTaskEntry}
                      onOpenEvent={openEventEntry}
                      onOpenCountdown={openCountdownEntry}
                    />
                  ) : null}
                </div>

                <DatePanel
                  selectedDate={selectedDate}
                  today={store.today}
                  tasks={store.tasks}
                  events={data.events}
                  countdowns={data.countdowns}
                  showLunar={data.showLunar}
                  workdayRule={data.workdayRule}
                  holidayLookup={data.holidayLookup}
                  dateExceptions={data.dateExceptions}
                  onNewTask={openNewTask}
                  onNewEvent={() => openNewEvent(selectedDate)}
                  onNewCountdown={() => openNewCountdown()}
                  onOpenTask={openTaskEntry}
                  onOpenEvent={openEventEntry}
                  onOpenCountdown={openCountdownEntry}
                />
              </div>
            </>
          ) : null}

          {tab === 'events' ? (
            <EventsSection
              selectedDate={selectedDate}
              events={data.events}
              onNew={() => openNewEvent(selectedDate)}
              onEdit={openEditEvent}
              onDelete={handleEventDelete}
              onCreateTask={(event) => {
                void handleEventToTask(event);
              }}
              busyEventId={eventTaskBusyId}
            />
          ) : null}

          {tab === 'countdowns' ? (
            <CountdownsSection
              today={store.today}
              countdowns={data.countdowns}
              onNew={() => openNewCountdown()}
              onEdit={openEditCountdown}
              onDelete={handleCountdownDelete}
            />
          ) : null}

          {tab === 'tools' ? (
            <ToolsSection
              today={store.today}
              onAddCountdown={handleAddCountdownFromTool}
            />
          ) : null}
        </CalendarDataGate>
      </TaskStoreGate>

      <NewTaskDialog
        open={taskDialogOpen}
        lists={store.lists}
        inboxId={store.inbox?.id ?? null}
        defaultListId={defaultListId}
        defaultDate={taskDialogDate}
        defaultQuadrant={4}
        onClose={() => setTaskDialogOpen(false)}
        onSubmit={handleTaskCreate}
      />

      <EventDialog
        open={eventOpen}
        initialDate={eventDate}
        event={editingEvent}
        notes={notes}
        onClose={() => setEventOpen(false)}
        onSubmit={handleEventSubmit}
      />

      <CountdownDialog
        open={countdownOpen}
        initialDate={selectedDate}
        countdown={editingCountdown}
        prefill={countdownPrefill}
        onClose={() => setCountdownOpen(false)}
        onSubmit={handleCountdownSubmit}
      />
    </section>
  );
}
