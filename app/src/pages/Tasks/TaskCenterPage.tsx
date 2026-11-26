/**
 * 任务中心（/tasks）：全部任务的唯一总管入口。
 *
 * * URL 是筛选与详情深链的唯一权威；不写 localStorage。
 * * 数据来自 TaskStore（SQLite），筛选/分组/计数在内存中的纯函数里完成。
 * * 批量完成 / 批量改期逐条提交，不做整批回滚；成功项可撤销。
 * * 「未安排」只是范围/状态；内部 capture 清单不出现在任何清单选择器里。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { isTauriRuntime } from '../../data/db/client';
import type { NewTask, Task, TaskStatus } from '../../data/db/types';
import { DatePicker } from '../../ui/date';
import { useToast } from '../../features/tasks/Feedback';
import { NewTaskDialog } from '../../features/tasks/NewTaskDialog';
import { TaskDetailPanel } from '../../features/tasks/TaskDetailPanel';
import {
  TaskRow,
  TaskStatusButton,
  useTaskStatusActions,
} from '../../features/tasks/TaskRow';
import {
  formatError,
  useTaskStore,
  type TaskBatchResult,
} from '../../features/tasks/TaskStore';
import { useTaskAction } from '../../features/tasks/actions';
import {
  BOARD_COLUMNS,
  TASK_STATUS_FILTERS,
  addDaysISO,
  filterTasksByStatus,
  forgetStatusBeforeDone,
  formatMonthDay,
  formatOverdueLabel,
  isTaskStatusFilter,
  listDisplayName,
  PRIORITY_LABELS,
  rememberStatusBeforeDone,
  sortTasks,
  statusCounts,
  statusLabel,
  type BoardStatus,
  type TaskStatusFilter,
} from '../../features/tasks/viewModel';
import {
  MAX_BATCH_SIZE,
  MAX_QUERY_LENGTH,
  TASK_CENTER_DATE_FILTERS,
  TASK_CENTER_VIEWS,
  filterTaskCenter,
  getTaskCenterCounts,
  groupTaskCenter,
  hasSecondaryFilters,
  listIsMissing,
  matchesTaskCenter,
  normalizeTaskCenterSearch,
  queryHit,
  readTaskCenterState,
  sortDoneTasks,
  taskCenterEmptyState,
  type TaskCenterEmptyReason,
  type TaskCenterFilter,
  type TaskCenterView,
} from '../../features/tasks/taskCenter';
import {
  listPath,
  orderedUserLists,
  resolveDefaultList,
} from '../Lists/tree';

type Triage = 'today' | 'tomorrow' | 'work';

type BatchState = {
  kind: 'complete' | 'reschedule';
  done: number;
  total: number;
};

type RescheduleSnapshot = {
  dueDate: string | null;
  dueTime: string | null;
  listId: string;
};

type PointerDragSession = {
  taskId: string;
  title: string;
  meta: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  cancel: () => void;
};

type DragGhostState = {
  title: string;
  meta: string;
} | null;

/** 超过该距离才视为拖拽，避免和点击冲突。 */
const DRAG_THRESHOLD = 6;
/** 拖拽结束后短暂屏蔽 click，防止拖完又打开详情。 */
const CLICK_SUPPRESS_MS = 400;
/** 快速新建后高亮新行的时间。 */
const NEW_TASK_HIGHLIGHT_MS = 1500;

function formatRangeLabel(today: string): string {
  return `${formatMonthDay(addDaysISO(today, 1))}–${formatMonthDay(
    addDaysISO(today, 7),
  )}`;
}

function completedLabelOf(task: Task): string | null {
  if (!task.completedAt) {
    return null;
  }
  const day = task.completedAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? formatMonthDay(day) : null;
}

export function TaskCenterPage() {
  const store = useTaskStore();
  const toast = useToast();
  const run = useTaskAction();
  const { toggle: toggleTask, setStatus } = useTaskStatusActions();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [customDateOpen, setCustomDateOpen] = useState(false);
  const [customDate, setCustomDate] = useState('');
  const [customDateValid, setCustomDateValid] = useState(true);
  const [searchDraft, setSearchDraft] = useState('');
  const [quickTitle, setQuickTitle] = useState('');
  const [quickDate, setQuickDate] = useState('');
  const [quickListId, setQuickListId] = useState('');
  const [quickError, setQuickError] = useState<string | null>(null);
  const [highlightTaskId, setHighlightTaskId] = useState<string | null>(null);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<BoardStatus | null>(null);
  const [dragGhost, setDragGhost] = useState<DragGhostState>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const focusedTaskRef = useRef<string | null>(null);
  const returnFocusRef = useRef<string | null>(null);
  const allCheckboxRef = useRef<HTMLInputElement | null>(null);
  const filterKeyRef = useRef('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const quickInputRef = useRef<HTMLInputElement | null>(null);
  const listTopRef = useRef<HTMLDivElement | null>(null);
  const pointerSessionRef = useRef<PointerDragSession | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const ghostPositionRef = useRef({ x: 0, y: 0 });
  const suppressClickUntilRef = useRef(0);
  const pendingCompletionMemory = useRef(new Map<string, TaskStatus>());
  // Tauri WKWebView 对原生 HTML5 拖拽支持不可靠：桌面壳内用 pointer 拖拽。
  const pointerOnlyDrag = isTauriRuntime();

  const ready = store.status === 'ready';
  const batchRunning = batch !== null;
  // 任务中心与日历共用同一个周起始偏好；TaskStore 从 device settings 读取。
  const weekStart = store.preferences.weekStart;

  const searchKey = params.toString();
  const normalized = useMemo(
    () => {
      const next = normalizeTaskCenterSearch(params, store.lists, ready);
      const rawStatus = next.get('status');
      if (rawStatus !== null && !isTaskStatusFilter(rawStatus)) {
        next.delete('status');
      }
      if (next.get('status') === 'all') {
        next.delete('status');
      }
      return next;
    },
    // `searchKey` 已经代表 params 的字符串内容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchKey, store.lists, ready],
  );
  const normalizedKey = normalized.toString();
  const state = useMemo(
    () => readTaskCenterState(new URLSearchParams(normalizedKey)),
    [normalizedKey],
  );
  const statusFilter: TaskStatusFilter = useMemo(() => {
    const raw = new URLSearchParams(normalizedKey).get('status');
    return isTaskStatusFilter(raw) ? raw : 'all';
  }, [normalizedKey]);

  useEffect(() => {
    if (normalizedKey !== params.toString()) {
      setParams(normalized, { replace: true });
    }
  }, [normalized, normalizedKey, params, setParams]);

  const taskId = normalized.get('task');
  const selectedTask = useMemo(
    () => (taskId ? store.tasks.find((task) => task.id === taskId) ?? null : null),
    [store.tasks, taskId],
  );
  const taskMissing = Boolean(taskId && ready && !selectedTask);

  const counts = useMemo(
    () => getTaskCenterCounts(store.tasks, store.today),
    [store.tasks, store.today],
  );
  const listMissing = ready && listIsMissing(store.lists, state.listId);
  const hasSecondary = hasSecondaryFilters(state);

  const baseFiltered = useMemo(
    () =>
      filterTaskCenter(
        store.tasks,
        state,
        store.lists,
        store.today,
        weekStart,
      ),
    [store.tasks, state, store.lists, store.today, weekStart],
  );
  // 状态标签计数不受状态筛选影响：在当前范围/清单/日期/搜索之后计算。
  const statusCountMap = useMemo(
    () => statusCounts(baseFiltered),
    [baseFiltered],
  );
  const filtered = useMemo(
    () => filterTasksByStatus(baseFiltered, statusFilter),
    [baseFiltered, statusFilter],
  );
  const groups = useMemo(
    () =>
      groupTaskCenter(
        filtered,
        state.filter,
        store.today,
        state.date,
        weekStart,
      ),
    [filtered, state.filter, state.date, store.today, weekStart],
  );
  const orderedTasks = useMemo(
    () => groups.flatMap((group) => group.tasks),
    [groups],
  );

  const batchAllowed = state.filter !== 'done' && statusFilter !== 'done';
  const selectionApplicable = batchMode && batchAllowed;
  const statusEmpty =
    ready &&
    statusFilter !== 'all' &&
    baseFiltered.length > 0 &&
    filtered.length === 0;
  const emptyReason: TaskCenterEmptyReason | null = ready
    ? taskCenterEmptyState({
        total: counts.total,
        resultCount: filtered.length,
        filter: state.filter,
        hasSecondary,
        counts,
      })
    : null;

  const listOptions = useMemo(
    () => orderedUserLists(store.lists),
    [store.lists],
  );
  const defaultList = useMemo(
    () => resolveDefaultList(store.lists),
    [store.lists],
  );
  const defaultListId = defaultList?.id ?? store.inbox?.id ?? '';

  const quickDefaultDate =
    state.filter === 'today'
      ? store.today
      : state.filter === 'next'
        ? addDaysISO(store.today, 1)
        : '';
  const quickDefaultListId = useMemo(() => {
    if (state.listId && listOptions.some((list) => list.id === state.listId)) {
      return state.listId;
    }
    return defaultList?.id ?? '';
  }, [defaultList, listOptions, state.listId]);

  useEffect(() => {
    setQuickDate(quickDefaultDate);
  }, [quickDefaultDate]);

  useEffect(() => {
    setQuickListId(quickDefaultListId);
  }, [quickDefaultListId]);

  useEffect(() => {
    if (!highlightTaskId) {
      return;
    }
    const timer = window.setTimeout(
      () => setHighlightTaskId(null),
      NEW_TASK_HIGHLIGHT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [highlightTaskId]);

  const boardColumns =
    state.filter === 'done'
      ? BOARD_COLUMNS.filter((column) => column.status === 'done')
      : BOARD_COLUMNS;

  const selectionInResult = useMemo(() => {
    const ids = new Set(orderedTasks.map((task) => task.id));
    return [...selection].filter((id) => ids.has(id));
  }, [orderedTasks, selection]);
  const allChecked =
    orderedTasks.length > 0 && selectionInResult.length === orderedTasks.length;
  const someChecked =
    selectionInResult.length > 0 && !allChecked;

  useEffect(() => {
    if (!allCheckboxRef.current) {
      return;
    }
    allCheckboxRef.current.indeterminate = someChecked;
  }, [someChecked]);

  // 数据刷新后裁剪选择集：只保留仍在当前筛选结果中的任务。
  useEffect(() => {
    if (batchRunning) {
      return;
    }
    if (!selectionApplicable) {
      setSelection((current) => (current.size === 0 ? current : new Set()));
      return;
    }
    const allowed = new Set(filtered.map((task) => task.id));
    setSelection((current) => {
      const next = [...current].filter((id) => allowed.has(id));
      return next.length === current.size ? current : new Set(next);
    });
  }, [filtered, batchRunning, selectionApplicable]);

  // 批量完成后刷新才拿到 completedAt；在下一轮 tasks 里补写完成前状态记忆。
  useEffect(() => {
    if (pendingCompletionMemory.current.size === 0) {
      return;
    }
    for (const [id, before] of [...pendingCompletionMemory.current]) {
      const task = store.tasks.find((item) => item.id === id);
      if (task?.status === 'done') {
        rememberStatusBeforeDone(id, before, task.completedAt);
        pendingCompletionMemory.current.delete(id);
      }
    }
  }, [store.tasks]);

  // 状态筛选切到「已完成」或范围切到「已完成」时批量不可用，直接退出。
  useEffect(() => {
    if (batchMode && !batchAllowed) {
      setBatchMode(false);
      setSelection(new Set());
    }
  }, [batchAllowed, batchMode]);

  const filterKey = [
    state.filter,
    statusFilter,
    state.listId ?? '',
    state.priority ?? '',
    state.date ?? '',
    state.query,
  ].join('|');

  useEffect(() => {
    if (filterKeyRef.current === '') {
      filterKeyRef.current = filterKey;
      return;
    }
    if (filterKeyRef.current === filterKey) {
      return;
    }
    filterKeyRef.current = filterKey;
    if (batchMode || selection.size > 0) {
      setBatchMode(false);
      setSelection(new Set());
      if (selection.size > 0 && !batchRunning) {
        toast('筛选已变更，已清空选择', { tone: 'info' });
      }
    }
  }, [
    filterKey,
    selection.size,
    batchRunning,
    batchMode,
    toast,
  ]);

  // 搜索：150ms 防抖，写回 URL 用 replace，避免逐字污染历史。
  useEffect(() => {
    setSearchDraft(state.query);
  }, [state.query]);

  const updateParams = useCallback(
    (
      mutate: (next: URLSearchParams) => void,
      options: { replace?: boolean } = {},
    ) => {
      const next = new URLSearchParams(normalized);
      mutate(next);
      setParams(next, { replace: options.replace });
    },
    [normalized, setParams],
  );

  useEffect(() => {
    if (searchDraft === state.query) {
      return;
    }
    const timer = window.setTimeout(() => {
      const value = searchDraft.trim().slice(0, MAX_QUERY_LENGTH);
      updateParams(
        (next) => {
          if (value) {
            next.set('q', value);
          } else {
            next.delete('q');
          }
        },
        { replace: true },
      );
    }, 150);
    return () => window.clearTimeout(timer);
  }, [searchDraft, state.query, updateParams]);

  const setFilter = (filter: TaskCenterFilter) => {
    updateParams((next) => {
      if (filter === 'open') {
        next.delete('filter');
      } else {
        next.set('filter', filter);
      }
      if (filter !== 'open') {
        next.delete('date');
      }
    });
  };

  const setStatusFilter = (filter: TaskStatusFilter) => {
    updateParams((next) => {
      if (filter === 'all') {
        next.delete('status');
      } else {
        next.set('status', filter);
      }
    });
    // 切换状态筛选不弹 toast，但必须立刻退出批量选择。
    setBatchMode(false);
    setSelection(new Set());
  };

  const setView = (view: TaskCenterView) => {
    updateParams(
      (next) => {
        if (view === 'list') {
          next.delete('view');
        } else {
          next.set('view', view);
        }
      },
      { replace: false },
    );
    setBatchMode(false);
    setSelection(new Set());
    setRescheduleOpen(false);
    setCustomDateOpen(false);
  };

  const applyOverview = (kind: 'overdue' | 'today' | 'next' | 'undated') => {
    updateParams((next) => {
      next.delete('date');
      if (kind === 'overdue') {
        next.delete('filter');
        next.set('date', 'overdue');
      } else {
        next.set('filter', kind);
      }
    });
    const node = listTopRef.current;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node?.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  };

  const setListFilter = (listId: string) => {
    updateParams((next) => {
      if (listId) {
        next.set('list', listId);
      } else {
        next.delete('list');
      }
    });
  };

  const setPriorityFilter = (value: string) => {
    updateParams((next) => {
      if (value === '') {
        next.delete('priority');
      } else {
        next.set('priority', value);
      }
    });
  };

  const setDateFilter = (value: string) => {
    updateParams((next) => {
      if (value === '') {
        next.delete('date');
      } else {
        next.set('date', value);
      }
    });
  };

  const clearFilters = () => {
    updateParams((next) => {
      next.delete('list');
      next.delete('priority');
      next.delete('date');
      next.delete('q');
      next.delete('status');
      if (state.filter !== 'open') {
        next.delete('filter');
      }
    });
    setSearchDraft('');
    setBatchMode(false);
    setSelection(new Set());
  };

  const clearListFilter = () => {
    updateParams((next) => next.delete('list'));
  };

  const showAllTasks = () => {
    setParams(new URLSearchParams(), { replace: false });
    setSearchDraft('');
    setBatchMode(false);
    setSelection(new Set());
  };

  const showOpenTasks = () => {
    updateParams((next) => {
      next.delete('filter');
      next.delete('date');
      next.delete('status');
    });
    setBatchMode(false);
    setSelection(new Set());
  };

  const openTask = useCallback(
    (id: string) => {
      returnFocusRef.current = id;
      updateParams(
        (next) => {
          next.set('task', id);
        },
        { replace: true },
      );
    },
    [updateParams],
  );

  const closeTask = useCallback(() => {
    const previous = returnFocusRef.current;
    returnFocusRef.current = null;
    updateParams(
      (next) => {
        next.delete('task');
      },
      { replace: true },
    );
    if (previous) {
      window.setTimeout(() => {
        const rowBody = document.querySelector<HTMLElement>(
          `[data-task-id="${previous}"] .task-row-body`,
        );
        const boardCard = document.querySelector<HTMLElement>(
          `button[data-task-id="${previous}"]`,
        );
        (rowBody ?? boardCard)?.focus();
      }, 0);
    }
  }, [updateParams]);

  // 深链首次打开时聚焦详情；后续点击行不抢焦点。
  useEffect(() => {
    if (!taskId || !selectedTask) {
      focusedTaskRef.current = null;
      return;
    }
    if (focusedTaskRef.current === taskId) {
      return;
    }
    focusedTaskRef.current = taskId;
    const node = detailRef.current;
    node?.focus();
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node?.scrollIntoView?.({
      block: 'nearest',
      behavior: reduce ? 'auto' : 'smooth',
    });
  }, [taskId, selectedTask]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (document.querySelector('[role="dialog"]')) {
        return;
      }
      if (rescheduleOpen) {
        setRescheduleOpen(false);
        setCustomDateOpen(false);
        return;
      }
      if (batchRunning) {
        return;
      }
      if (batchMode) {
        setBatchMode(false);
        setSelection(new Set());
        return;
      }
      if (taskId) {
        closeTask();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [rescheduleOpen, batchRunning, batchMode, taskId, closeTask]);

  const toggleSelected = (id: string, checked: boolean) => {
    setSelection((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allChecked) {
      setSelection(new Set());
      return;
    }
    if (orderedTasks.length > MAX_BATCH_SIZE) {
      toast(`一次最多处理 ${MAX_BATCH_SIZE} 条，已选择前 ${MAX_BATCH_SIZE} 条`, {
        tone: 'info',
      });
    }
    setSelection(
      new Set(orderedTasks.slice(0, MAX_BATCH_SIZE).map((task) => task.id)),
    );
  };

  const enterBatch = () => {
    setBatchMode(true);
    setSelection(new Set());
    setRescheduleOpen(false);
    setCustomDateOpen(false);
  };

  const exitBatch = () => {
    setBatchMode(false);
    setSelection(new Set());
    setRescheduleOpen(false);
    setCustomDateOpen(false);
  };

  const submitQuickAdd = async (event: FormEvent) => {
    event.preventDefault();
    const title = quickTitle.trim();
    if (!title) {
      setQuickError('请输入任务标题');
      quickInputRef.current?.focus();
      return;
    }
    if (!quickListId) {
      setQuickError('请先创建一个清单');
      return;
    }
    const minSort = Math.min(
      100,
      ...store.tasks.map((task) => task.sortOrder),
    );
    try {
      const task = await store.createTask({
        title: title.slice(0, 200),
        listId: quickListId,
        status: 'todo',
        priority: 0,
        quadrant: 4,
        dueDate: quickDate || null,
        dueTime: null,
        sortOrder: minSort - 1,
      });
      setQuickTitle('');
      setQuickError(null);
      setQuickDate(quickDefaultDate);
      setQuickListId(quickDefaultListId);
      setHighlightTaskId(task.id);
      quickInputRef.current?.focus();
      if (
        !matchesTaskCenter(
          task,
          state,
          store.lists,
          store.today,
          weekStart,
        )
      ) {
        toast('已创建任务，但不在当前范围', {
          tone: 'info',
          action: {
            label: '查看任务',
            onClick: () =>
              navigate(`/tasks?task=${encodeURIComponent(task.id)}`),
          },
        });
      }
    } catch (reason) {
      toast(formatError(reason), { tone: 'danger' });
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target;
      const inField =
        target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      if (inField || document.querySelector('[role="dialog"]')) {
        return;
      }
      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        if (ready) {
          setCreateOpen(true);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ready]);

  const moveTaskToStatus = async (
    taskId: string,
    status: BoardStatus,
  ) => {
    const task = store.tasks.find((item) => item.id === taskId);
    if (!task) {
      return;
    }
    await setStatus(task, status);
  };

  const readBoardDropStatus = (event: {
    clientX: number;
    clientY: number;
    target: EventTarget | null;
  }): BoardStatus | null => {
    let pointElement: Element | null = null;
    if (typeof document.elementFromPoint === 'function') {
      try {
        pointElement = document.elementFromPoint(event.clientX, event.clientY);
      } catch {
        pointElement = null;
      }
    }
    const candidates: Array<Element | null> = [pointElement];
    if (event.target instanceof Element) {
      candidates.push(event.target);
    }
    for (const element of candidates) {
      if (!element) {
        continue;
      }
      const statusElement = element.closest('[data-drop-status]');
      const value = statusElement?.getAttribute('data-drop-status');
      if (value === 'todo' || value === 'doing' || value === 'done') {
        return value;
      }
    }
    return null;
  };

  const startBoardDrag = (
    event: DragEvent<HTMLElement>,
    task: Task,
  ) => {
    pointerSessionRef.current?.cancel();
    setDragTaskId(task.id);
    event.dataTransfer?.setData('text/plain', task.id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
  };

  const dropBoard = async (
    event: DragEvent<HTMLElement>,
    status: BoardStatus,
  ) => {
    event.preventDefault();
    setDragOverStatus(null);
    const id =
      dragTaskId ?? event.dataTransfer?.getData('text/plain') ?? null;
    setDragTaskId(null);
    if (!id) {
      return;
    }
    await moveTaskToStatus(id, status);
  };

  const positionGhostAt = (x: number, y: number) => {
    ghostPositionRef.current = { x, y };
    const ghost = ghostRef.current;
    if (ghost) {
      ghost.style.transform = `translate3d(${Math.round(x + 14)}px, ${Math.round(y + 14)}px, 0)`;
    }
  };

  // ghost 首次挂载后补一次定位。
  useEffect(() => {
    if (!dragGhost) {
      return;
    }
    const ghost = ghostRef.current;
    if (!ghost) {
      return;
    }
    const { x, y } = ghostPositionRef.current;
    ghost.style.transform = `translate3d(${Math.round(x + 14)}px, ${Math.round(y + 14)}px, 0)`;
  }, [dragGhost]);

  useEffect(() => {
    return () => {
      pointerSessionRef.current?.cancel();
    };
  }, []);

  const beginPointerDrag = (
    event: ReactPointerEvent<HTMLElement>,
    task: Task,
  ) => {
    if (pointerSessionRef.current) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    if (event.isPrimary === false) {
      return;
    }
    const origin = event.target as HTMLElement | null;
    if (origin?.closest('.task-row-actions, [data-no-drag]')) {
      return;
    }

    const session: PointerDragSession = {
      taskId: task.id,
      title: task.title,
      meta: listDisplayName(store.lists, task.listId),
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      cancel: () => undefined,
    };

    let cleanup = () => undefined;
    const finish = (upEvent: PointerEvent | null) => {
      if (pointerSessionRef.current !== session) {
        return;
      }
      pointerSessionRef.current = null;
      cleanup();
      document.body.classList.remove('task-pointer-dragging');
      setDragGhost(null);
      setDragTaskId(null);
      setDragOverStatus(null);
      if (!session.active) {
        return;
      }
      suppressClickUntilRef.current = Date.now() + CLICK_SUPPRESS_MS;
      if (!upEvent) {
        return;
      }
      const target = readBoardDropStatus(upEvent);
      if (target) {
        void moveTaskToStatus(session.taskId, target);
      }
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (
        pointerSessionRef.current !== session ||
        moveEvent.pointerId !== session.pointerId
      ) {
        return;
      }
      if (!session.active) {
        const distance = Math.hypot(
          moveEvent.clientX - session.startX,
          moveEvent.clientY - session.startY,
        );
        if (distance < DRAG_THRESHOLD) {
          return;
        }
        session.active = true;
        setDragTaskId(session.taskId);
        setDragGhost({ title: session.title, meta: session.meta });
        document.body.classList.add('task-pointer-dragging');
        window.getSelection()?.removeAllRanges();
      }
      if (moveEvent.cancelable) {
        moveEvent.preventDefault();
      }
      positionGhostAt(moveEvent.clientX, moveEvent.clientY);
      setDragOverStatus(readBoardDropStatus(moveEvent));
    };

    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== session.pointerId) {
        return;
      }
      finish(upEvent);
    };
    const onCancel = () => finish(null);
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') {
        return;
      }
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(null);
    };
    const onBlur = () => finish(null);

    cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
    };
    session.cancel = () => finish(null);
    pointerSessionRef.current = session;

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
  };

  const openFromBoard = (id: string) => {
    if (Date.now() < suppressClickUntilRef.current) {
      return;
    }
    openTask(id);
  };

  const handleCreate = async (input: NewTask, subtaskTitles: string[]) => {
    try {
      const task = await store.createTask(input);
      for (const title of subtaskTitles) {
        try {
          await store.addSubtask(task.id, title);
        } catch (reason) {
          toast(`任务已创建，但子任务「${title}」保存失败：${formatError(reason)}`, {
            tone: 'danger',
          });
          break;
        }
      }
      setCreateOpen(false);
      if (
        matchesTaskCenter(
          task,
          state,
          store.lists,
          store.today,
          weekStart,
        )
      ) {
        openTask(task.id);
        toast(input.dueDate ? '已创建任务' : '已加入未安排', {
          tone: 'success',
        });
      } else {
        toast('已创建任务，但不在当前筛选内', {
          tone: 'info',
          action: {
            label: '查看任务',
            onClick: () =>
              navigate(`/tasks?task=${encodeURIComponent(task.id)}`),
          },
        });
      }
    } catch (reason) {
      toast(formatError(reason), { tone: 'danger' });
      throw reason;
    }
  };

  const triageTask = async (task: Task, triage: Triage) => {
    const dueDate =
      triage === 'tomorrow' ? addDaysISO(store.today, 1) : store.today;
    let listId = task.listId;

    if (triage === 'work') {
      const work =
        store.lists.find((list) => !list.isInbox && list.name === '工作') ??
        defaultList;
      if (!work) {
        toast('请先创建一个清单，再把任务安排到工作', { tone: 'danger' });
        return;
      }
      listId = work.id;
    } else if (task.listId === store.inbox?.id) {
      if (!defaultList) {
        toast('请先创建一个清单再安排日期', { tone: 'danger' });
        return;
      }
      listId = defaultList.id;
    }

    const message =
      triage === 'work'
        ? '已移到工作，并安排到今天'
        : triage === 'tomorrow'
          ? `已安排到明天（${formatMonthDay(dueDate)}）`
          : '已安排到今天';

    await run(() => store.patchTask(task.id, { dueDate, listId }), {
      success: message,
    });
  };

  const undoBatchComplete = async (
    originals: Map<string, TaskStatus>,
  ) => {
    let restored = 0;
    let failed = 0;
    let firstError = '';
    for (const [id, status] of originals) {
      try {
        await store.setTaskStatus(id, status);
        forgetStatusBeforeDone(id);
        restored += 1;
      } catch (reason) {
        failed += 1;
        if (!firstError) {
          firstError = formatError(reason);
        }
      }
    }
    if (failed > 0) {
      toast(`已恢复 ${restored} 条，${failed} 条失败：${firstError}`, {
        tone: 'danger',
      });
    } else {
      toast(`已恢复 ${restored} 条`, { tone: 'success' });
    }
  };

  const runBatchComplete = async (ids: string[]) => {
    if (batchRunning) {
      return;
    }
    const targets = ids
      .map((id) => store.tasks.find((task) => task.id === id))
      .filter((task): task is Task => Boolean(task && task.status !== 'done'))
      .slice(0, MAX_BATCH_SIZE);
    if (targets.length === 0) {
      toast('没有可完成的任务', { tone: 'info' });
      return;
    }
    const originals = new Map<string, TaskStatus>(
      targets.map((task) => [task.id, task.status]),
    );
    setBatch({ kind: 'complete', done: 0, total: targets.length });
    let result: TaskBatchResult;
    try {
      result = await store.completeTaskBatch(
        targets.map((task) => task.id),
        (done, total) => setBatch({ kind: 'complete', done, total }),
      );
    } catch (reason) {
      setBatch(null);
      toast(formatError(reason), { tone: 'danger' });
      return;
    }
    setBatch(null);
    const failedIds = result.failed.map((item) => item.id);
    setSelection(new Set(failedIds));
    for (const id of result.succeeded) {
      const before = originals.get(id);
      if (before && before !== 'done') {
        pendingCompletionMemory.current.set(id, before);
      }
    }

    if (result.refreshError) {
      toast('操作已提交，但列表刷新失败，请重试', { tone: 'danger' });
      return;
    }
    if (result.failed.length === 0) {
      toast(`已完成 ${result.succeeded.length} 条`, {
        tone: 'success',
        action: {
          label: '撤销',
          onClick: () => undoBatchComplete(originals),
        },
      });
      return;
    }
    if (result.succeeded.length === 0) {
      toast(
        `已完成 0 条，${result.failed.length} 条失败：${result.failed[0].error}`,
        {
          tone: 'danger',
          action: {
            label: '重试失败项',
            onClick: () => runBatchComplete(failedIds),
          },
        },
      );
      return;
    }
    toast(
      `已完成 ${result.succeeded.length} 条，${result.failed.length} 条失败：${result.failed[0].error}`,
      {
        tone: 'danger',
        action: {
          label: '重试失败项',
          onClick: () => runBatchComplete(failedIds),
        },
      },
    );
  };

  const undoBatchReschedule = async (
    originals: Map<string, RescheduleSnapshot>,
  ) => {
    let restored = 0;
    let failed = 0;
    let firstError = '';
    for (const [id, before] of originals) {
      try {
        await store.patchTask(id, {
          dueDate: before.dueDate,
          dueTime: before.dueTime,
          listId: before.listId,
        });
        restored += 1;
      } catch (reason) {
        failed += 1;
        if (!firstError) {
          firstError = formatError(reason);
        }
      }
    }
    if (failed > 0) {
      toast(`已恢复 ${restored} 条，${failed} 条失败：${firstError}`, {
        tone: 'danger',
      });
    } else {
      toast(`已恢复 ${restored} 条`, { tone: 'success' });
    }
  };

  const runBatchReschedule = async (ids: string[], dueDate: string) => {
    if (batchRunning || !dueDate) {
      return;
    }
    const targets = ids
      .map((id) => store.tasks.find((task) => task.id === id))
      .filter((task): task is Task => Boolean(task))
      .slice(0, MAX_BATCH_SIZE);
    if (targets.length === 0) {
      toast('没有可改期的任务', { tone: 'info' });
      return;
    }
    const inboxId = store.inbox?.id ?? null;
    const needsDefault = targets.some((task) => task.listId === inboxId);
    if (needsDefault && !defaultList) {
      toast('请先创建一个清单再安排日期', { tone: 'danger' });
      return;
    }
    const originals = new Map<string, RescheduleSnapshot>(
      targets.map((task) => [
        task.id,
        {
          dueDate: task.dueDate,
          dueTime: task.dueTime,
          listId: task.listId,
        },
      ]),
    );
    const items = targets.map((task) => ({
      id: task.id,
      patch: {
        dueDate,
        ...(inboxId && task.listId === inboxId && defaultList
          ? { listId: defaultList.id }
          : {}),
      },
    }));

    setBatch({ kind: 'reschedule', done: 0, total: targets.length });
    let result: TaskBatchResult;
    try {
      result = await store.patchTaskBatch(items, (done, total) =>
        setBatch({ kind: 'reschedule', done, total }),
      );
    } catch (reason) {
      setBatch(null);
      toast(formatError(reason), { tone: 'danger' });
      return;
    }
    setBatch(null);
    const failedIds = result.failed.map((item) => item.id);
    setSelection(new Set(failedIds));

    if (result.refreshError) {
      toast('操作已提交，但列表刷新失败，请重试', { tone: 'danger' });
      return;
    }
    if (result.failed.length === 0) {
      toast(`已改期 ${result.succeeded.length} 条`, {
        tone: 'success',
        action: {
          label: '撤销',
          onClick: () => undoBatchReschedule(originals),
        },
      });
      return;
    }
    toast(
      `已改期 ${result.succeeded.length} 条，${result.failed.length} 条失败：${result.failed[0].error}`,
      {
        tone: 'danger',
        action: {
          label: '重试失败项',
          onClick: () => runBatchReschedule(failedIds, dueDate),
        },
      },
    );
  };

  const applyBatchDate = (value: string) => {
    if (!value || !customDateValid) {
      return;
    }
    setRescheduleOpen(false);
    setCustomDateOpen(false);
    setCustomDate('');
    setCustomDateValid(true);
    void runBatchReschedule([...selection], value);
  };

  const renderEmpty = (reason: TaskCenterEmptyReason) => (
    <TaskCenterEmpty
      reason={reason}
      onCreate={() => setCreateOpen(true)}
      onClear={clearFilters}
      onShowAll={showAllTasks}
      onShowOpen={showOpenTasks}
      onFilter={setFilter}
    />
  );

  return (
    <section
      className="page task-page task-center-page"
      aria-labelledby="tasks-title"
      aria-busy={store.status === 'loading'}
    >
      <header className="task-page-head">
        <div>
          <p className="page-eyebrow">工作台 · 任务</p>
          <h1 id="tasks-title">全部任务</h1>
          <p className="task-page-sub">
            {ready
              ? `共 ${counts.total} 条 · 未完成 ${counts.open} · 已完成 ${counts.done}`
              : '共 — 条 · 未完成 — · 已完成 —'}
          </p>
        </div>
        {ready ? (
          <div className="task-head-actions">
            <button
              type="button"
              className="task-button task-button--primary"
              onClick={() => setCreateOpen(true)}
            >
              ＋ 新任务
            </button>
          </div>
        ) : null}
      </header>

      {store.status === 'unavailable' ? (
        <div className="task-state-card">
          <span className="task-state-mark" aria-hidden="true">
            库
          </span>
          <h2>需在桌面壳内使用任务库</h2>
          <p>
            任务数据保存在本机 SQLite；请用
            <code>pnpm --filter app tauri dev</code>
            启动桌面壳。
          </p>
        </div>
      ) : store.status === 'error' ? (
        <div className="task-state-card" role="alert">
          <h2>任务加载失败</h2>
          <p>{store.error ?? '未知错误，请稍后重试。'}</p>
          <button
            type="button"
            className="task-button"
            onClick={() => {
              void store.refresh().catch(() => undefined);
            }}
          >
            重试
          </button>
        </div>
      ) : (
        <>
          <section className="task-center-overview" aria-label="任务概览">
            {[
              {
                key: 'overdue' as const,
                label: '逾期',
                value: counts.overdue,
                sub: '建议先处理或改期',
                tone: 'is-red',
                pressed: state.filter === 'open' && state.date === 'overdue',
              },
              {
                key: 'today' as const,
                label: '今天',
                value: counts.todayOpen,
                sub: `已完成 ${counts.todayDone} / ${
                  counts.todayDone + counts.todayOpen
                }`,
                tone: 'is-blue',
                pressed: state.filter === 'today',
              },
              {
                key: 'next' as const,
                label: '接下来 7 天',
                value: counts.next7,
                sub: formatRangeLabel(store.today),
                tone: '',
                pressed: state.filter === 'next',
              },
              {
                key: 'undated' as const,
                label: '未安排',
                value: counts.undated,
                sub: '无日期，待安排',
                tone: 'is-muted',
                pressed: state.filter === 'undated',
              },
            ].map((card) => (
              <button
                type="button"
                key={card.key}
                className="task-overview-card"
                aria-pressed={card.pressed}
                disabled={!ready || batchRunning}
                onClick={() => applyOverview(card.key)}
              >
                <span className="task-overview-label">{card.label}</span>
                <strong className={`task-overview-number ${card.tone}`}>
                  {ready ? card.value : '—'}
                </strong>
                <span className="task-overview-sub">{card.sub}</span>
                <span className="task-center-sr" aria-live="polite">
                  {card.label} {ready ? card.value : '—'}
                </span>
              </button>
            ))}
          </section>

          <section className="task-center-filters" aria-label="任务筛选">
            <div
              className="task-tabs task-center-statuses"
              role="tablist"
              aria-label="任务状态"
              onKeyDown={(event) => {
                const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
                if (!keys.includes(event.key)) {
                  return;
                }
                const tabs = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]:not(:disabled)',
                  ),
                );
                if (tabs.length === 0) {
                  return;
                }
                event.preventDefault();
                const current = tabs.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                let nextIndex = current;
                if (event.key === 'Home') {
                  nextIndex = 0;
                } else if (event.key === 'End') {
                  nextIndex = tabs.length - 1;
                } else if (event.key === 'ArrowLeft') {
                  nextIndex = current <= 0 ? tabs.length - 1 : current - 1;
                } else {
                  nextIndex = current >= tabs.length - 1 ? 0 : current + 1;
                }
                const next = tabs[nextIndex];
                next.focus();
                next.click();
              }}
            >
              {TASK_STATUS_FILTERS.map((item) => (
                <button
                  type="button"
                  key={item.value}
                  role="tab"
                  data-status={item.value}
                  className="task-tab"
                  aria-selected={statusFilter === item.value}
                  disabled={!ready || batchRunning}
                  onClick={() => setStatusFilter(item.value)}
                >
                  {item.label}
                  <span className="task-tab-count">
                    {ready ? statusCountMap[item.value] : '—'}
                  </span>
                </button>
              ))}
            </div>

            <div className="task-center-filter-row">
              <div className="task-center-search">
                <input
                  ref={searchRef}
                  type="search"
                  aria-label="搜索任务标题或备注"
                  placeholder="搜索任务标题或备注"
                  value={searchDraft}
                  disabled={!ready || batchRunning}
                  onChange={(event) => setSearchDraft(event.target.value)}
                />
                {searchDraft ? (
                  <button
                    type="button"
                    className="task-center-search-clear"
                    aria-label="清空搜索"
                    onClick={() => {
                      setSearchDraft('');
                      updateParams(
                        (next) => next.delete('q'),
                        { replace: true },
                      );
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </div>

              <select
                aria-label="清单筛选"
                value={state.listId ?? ''}
                disabled={!ready || batchRunning}
                onChange={(event) => setListFilter(event.target.value)}
              >
                <option value="">全部清单</option>
                {listMissing && state.listId ? (
                  <option value={state.listId} disabled>
                    清单不存在或已删除
                  </option>
                ) : null}
                {listOptions.map((list) => (
                  <option key={list.id} value={list.id}>
                    {listPath(store.lists, list.id)}
                  </option>
                ))}
              </select>

              <select
                aria-label="优先级筛选"
                value={state.priority === null ? '' : String(state.priority)}
                disabled={!ready || batchRunning}
                onChange={(event) => setPriorityFilter(event.target.value)}
              >
                <option value="">全部优先级</option>
                {PRIORITY_LABELS.map((label, value) => (
                  <option key={label} value={value}>
                    {value === 0 ? '无优先级' : label}
                  </option>
                ))}
              </select>

              {state.filter === 'open' ? (
                <select
                  aria-label="日期筛选"
                  value={state.date ?? ''}
                  disabled={!ready || batchRunning}
                  onChange={(event) => setDateFilter(event.target.value)}
                >
                  <option value="">全部日期</option>
                  {TASK_CENTER_DATE_FILTERS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              ) : null}

              {hasSecondary || statusFilter !== 'all' ? (
                <button
                  type="button"
                  className="task-button task-button--small"
                  disabled={!ready || batchRunning}
                  onClick={clearFilters}
                >
                  清除筛选
                </button>
              ) : null}

              <p className="task-center-result" role="status" aria-live="polite">
                筛选结果 {ready ? filtered.length : '—'} 条
              </p>
            </div>
          </section>

          <div className="task-center-viewbar">
            <span className="task-center-viewbar-count">
              {ready ? filtered.length : '—'} 条
              {batchMode ? ` · 已选 ${selection.size} 条` : ''}
            </span>
            <div className="task-center-viewbar-actions">
              <div
                className="task-tabs task-center-views"
                role="group"
                aria-label="主视图"
              >
                {TASK_CENTER_VIEWS.map((item) => (
                  <button
                    type="button"
                    key={item.value}
                    className="task-tab"
                    aria-pressed={state.view === item.value}
                    disabled={!ready || batchRunning}
                    onClick={() => setView(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {state.view === 'list' && batchAllowed ? (
                <button
                  type="button"
                  className={
                    batchMode
                      ? 'task-button task-button--small task-button--primary'
                      : 'task-button task-button--small'
                  }
                  aria-pressed={batchMode}
                  disabled={!ready || batchRunning || orderedTasks.length === 0}
                  onClick={batchMode ? exitBatch : enterBatch}
                >
                  {batchMode ? '退出批量' : '批量'}
                </button>
              ) : null}
            </div>
          </div>

          <div className="task-workspace task-center-workspace">
            <div className="task-main" ref={listTopRef} id="task-center-results">
              {listMissing ? (
                <div className="task-center-banner" role="status">
                  <span>
                    <strong>这个清单不存在或已被删除</strong>
                    　当前按全部清单显示。
                  </span>
                  <button
                    type="button"
                    className="task-button task-button--small"
                    onClick={clearListFilter}
                  >
                    清除清单筛选
                  </button>
                </div>
              ) : null}

              {taskId && selectedTask && !filtered.some((task) => task.id === taskId) ? (
                <div className="task-filter-hint" role="status">
                  <div>
                    <strong>当前任务不在筛选结果中</strong>
                    <p>任务仍可编辑；清除筛选后可在列表中看到它。</p>
                  </div>
                  <div className="task-filter-hint-actions">
                    <button
                      type="button"
                      className="task-button task-button--small"
                      onClick={clearFilters}
                    >
                      清除筛选
                    </button>
                    <button
                      type="button"
                      className="task-button task-button--small"
                      onClick={closeTask}
                    >
                      关闭
                    </button>
                  </div>
                </div>
              ) : null}

              {store.status === 'loading' ? (
                <div
                  className="task-center-skeleton"
                  role="status"
                  aria-live="polite"
                  aria-busy="true"
                >
                  <p>正在读取任务…</p>
                  {Array.from({ length: 6 }).map((_, index) => (
                    <span key={index} className="task-center-skeleton-row" />
                  ))}
                </div>
              ) : statusEmpty ? (
                <div className="task-empty-card task-center-empty">
                  <h2>没有「{statusLabel(statusFilter)}」的任务</h2>
                  <p>
                    {statusFilter === 'doing'
                      ? '在任意任务行的状态胶囊里选「进行中」，或从看板拖到进行中列。'
                      : statusFilter === 'done'
                        ? '完成一条任务后会出现在这里。'
                        : '切换状态筛选，或新建一条待办任务。'}
                  </p>
                  <div className="task-center-empty-actions">
                    <button
                      type="button"
                      className="task-button"
                      onClick={() => setStatusFilter('all')}
                    >
                      查看全部
                    </button>
                  </div>
                </div>
              ) : emptyReason ? (
                renderEmpty(emptyReason)
              ) : state.view === 'board' ? (
                <div className="task-center-board-wrap">
                  <p className="task-toolbar-hint task-center-board-hint">
                    {state.filter === 'done'
                      ? '已完成范围只显示完成列；切回其他范围可继续规划。'
                      : statusFilter !== 'all'
                        ? `当前只看「${statusLabel(statusFilter)}」；清空状态筛选可看全部三列。`
                        : '看板按状态分组；拖动卡片改状态，点卡片上的胶囊也能改。'}
                  </p>
                  <div
                    className={
                      state.filter === 'done'
                        ? 'task-board is-done-only'
                        : 'task-board'
                    }
                    aria-label="看板视图"
                  >
                    {boardColumns.map((column) => {
                      const columnTasks = filtered.filter(
                        (task) => task.status === column.status,
                      );
                      const items =
                        column.status === 'done'
                          ? sortDoneTasks(columnTasks)
                          : sortTasks(columnTasks);
                      const emptyCopy =
                        column.status === 'done'
                          ? state.filter === 'done' || statusFilter === 'done'
                            ? '还没有已完成的任务'
                            : '当前范围不含已完成'
                          : column.status === 'doing'
                            ? '把卡片拖到这里开始做'
                            : '暂无待办任务';
                      return (
                        <section
                          key={column.status}
                          className={
                            dragOverStatus === column.status
                              ? 'task-board-column is-over'
                              : 'task-board-column'
                          }
                          aria-label={`${column.label}列`}
                          data-drop-status={column.status}
                          onDragOver={(event) => {
                            event.preventDefault();
                            setDragOverStatus(column.status);
                          }}
                          onDragLeave={() => setDragOverStatus(null)}
                          onDrop={(event) =>
                            void dropBoard(event, column.status)
                          }
                        >
                          <div
                            className="task-board-head"
                            style={
                              {
                                '--board-color': column.color,
                              } as CSSProperties
                            }
                          >
                            <span
                              className="task-board-bar"
                              aria-hidden="true"
                            />
                            {column.label}
                            <span className="task-board-count">
                              {items.length}
                            </span>
                          </div>
                          <div className="task-board-cards">
                            {items.map((task) => {
                              const overdue = formatOverdueLabel(
                                task,
                                store.today,
                              );
                              return (
                                <div
                                  role="button"
                                  tabIndex={0}
                                  className={
                                    dragTaskId === task.id
                                      ? 'task-card is-dragging'
                                      : 'task-card'
                                  }
                                  key={task.id}
                                  data-task-id={task.id}
                                  draggable={!pointerOnlyDrag}
                                  aria-label={`${task.title}，${statusLabel(
                                    task.status,
                                  )}，可拖动改状态`}
                                  onClick={() => openFromBoard(task.id)}
                                  onKeyDown={(event) => {
                                    if (
                                      event.target !== event.currentTarget ||
                                      (event.key !== 'Enter' &&
                                        event.key !== ' ')
                                    ) {
                                      return;
                                    }
                                    event.preventDefault();
                                    openFromBoard(task.id);
                                  }}
                                  onDragStart={(event) =>
                                    startBoardDrag(event, task)
                                  }
                                  onDragEnd={() => {
                                    setDragTaskId(null);
                                    setDragOverStatus(null);
                                  }}
                                  onPointerDown={(event) =>
                                    beginPointerDrag(event, task)
                                  }
                                >
                                  <span className="task-card-title">
                                    {task.title}
                                  </span>
                                  <span className="task-card-meta">
                                    <span>
                                      {listDisplayName(
                                        store.lists,
                                        task.listId,
                                      )}
                                    </span>
                                    {overdue ? (
                                      <span className="task-badge task-badge--overdue">
                                        {overdue}
                                      </span>
                                    ) : task.dueDate ? (
                                      <span className="task-badge">
                                        {formatMonthDay(task.dueDate)}
                                      </span>
                                    ) : (
                                      <span className="task-badge">
                                        未安排
                                      </span>
                                    )}
                                    {task.priority > 0 ? (
                                      <span className="task-prio">
                                        {[1, 2, 3].map((level) => (
                                          <i
                                            key={level}
                                            className={
                                              level <= task.priority
                                                ? 'on'
                                                : undefined
                                            }
                                          />
                                        ))}
                                      </span>
                                    ) : null}
                                  </span>
                                  <span className="task-card-foot">
                                    <TaskStatusButton
                                      task={task}
                                      variant="card"
                                      onChange={(status) =>
                                        void setStatus(task, status)
                                      }
                                    />
                                  </span>
                                </div>
                              );
                            })}
                            {items.length === 0 ? (
                              <p className="task-board-empty">{emptyCopy}</p>
                            ) : null}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <>
                  {batchMode ? (
                    <div className="task-center-batch-hint">
                      <span>
                        批量模式：勾选任务后使用底部操作；Esc 退出。
                      </span>
                      <button
                        type="button"
                        className="task-button task-button--small"
                        onClick={exitBatch}
                      >
                        退出
                      </button>
                    </div>
                  ) : null}

                  {batchMode ? (
                    <div className="task-center-list-head">
                      <label className="task-center-select-all">
                        <input
                          ref={allCheckboxRef}
                          type="checkbox"
                          aria-label="全选当前筛选"
                          aria-checked={
                            allChecked ? true : someChecked ? 'mixed' : false
                          }
                          checked={allChecked}
                          disabled={batchRunning || orderedTasks.length === 0}
                          onChange={toggleSelectAll}
                        />
                        <span>全选当前筛选</span>
                      </label>
                      <span className="task-toolbar-hint">
                        共 {orderedTasks.length} 条
                      </span>
                    </div>
                  ) : null}

                  {!batchMode ? (
                    <form
                      className="task-quick-add"
                      onSubmit={(event) => void submitQuickAdd(event)}
                      autoComplete="off"
                    >
                      <input
                        ref={quickInputRef}
                        type="text"
                        aria-label="快速添加任务标题"
                        placeholder="＋ 添加任务，回车保存"
                        maxLength={200}
                        value={quickTitle}
                        onChange={(event) => {
                          setQuickTitle(event.target.value);
                          if (quickError) {
                            setQuickError(null);
                          }
                        }}
                      />
                      <select
                        aria-label="快速添加日期"
                        value={quickDate}
                        onChange={(event) => setQuickDate(event.target.value)}
                      >
                        <option value="">未安排</option>
                        <option value={store.today}>今天</option>
                        <option value={addDaysISO(store.today, 1)}>明天</option>
                        <option value={addDaysISO(store.today, 7)}>
                          7 天后
                        </option>
                      </select>
                      <select
                        aria-label="快速添加清单"
                        value={quickListId}
                        disabled={listOptions.length === 0}
                        onChange={(event) => setQuickListId(event.target.value)}
                      >
                        {listOptions.length === 0 ? (
                          <option value="">未安排</option>
                        ) : null}
                        {listOptions.map((list) => (
                          <option key={list.id} value={list.id}>
                            {list.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="submit"
                        className="task-button task-button--primary"
                        disabled={!quickTitle.trim() || !ready}
                      >
                        添加
                      </button>
                      {quickError ? (
                        <p className="task-quick-add-error" role="alert">
                          {quickError}
                        </p>
                      ) : null}
                    </form>
                  ) : null}

                  {groups.map((group) => (
                    <section
                      className="task-section"
                      aria-label={group.label}
                      key={group.key}
                    >
                      <h2
                        className={
                          group.key === 'overdue'
                            ? 'task-section-head task-section-head--danger'
                            : 'task-section-head'
                        }
                      >
                        {group.label}
                        <span className="task-count">{group.tasks.length}</span>
                      </h2>
                      <div className="task-list">
                        {group.tasks.map((task) => {
                          const hit = state.query
                            ? queryHit(task, state.query)
                            : null;
                          return (
                            <TaskRow
                              key={task.id}
                              task={task}
                              lists={store.lists}
                              today={store.today}
                              selected={taskId === task.id}
                              highlighted={highlightTaskId === task.id}
                              onSelect={() => {
                                if (batchMode) {
                                  toggleSelected(
                                    task.id,
                                    !selection.has(task.id),
                                  );
                                  return;
                                }
                                openTask(task.id);
                              }}
                              onToggle={() => void toggleTask(task)}
                              onStatusChange={(status) =>
                                void setStatus(task, status)
                              }
                              selectable={selectionApplicable}
                              checked={selection.has(task.id)}
                              onCheckedChange={(checked) =>
                                toggleSelected(task.id, checked)
                              }
                              notesMatched={hit === 'notes'}
                              completedLabel={
                                state.filter === 'done'
                                  ? completedLabelOf(task)
                                  : null
                              }
                              actions={
                                state.filter === 'undated' && task.status !== 'done' ? (
                                  <>
                                    <button
                                      type="button"
                                      className="task-button task-button--small"
                                      onClick={() => void triageTask(task, 'today')}
                                    >
                                      今天
                                    </button>
                                    <button
                                      type="button"
                                      className="task-button task-button--small"
                                      onClick={() =>
                                        void triageTask(task, 'tomorrow')
                                      }
                                    >
                                      明天
                                    </button>
                                    <button
                                      type="button"
                                      className="task-button task-button--small"
                                      onClick={() => void triageTask(task, 'work')}
                                    >
                                      工作
                                    </button>
                                  </>
                                ) : null
                              }
                            />
                          );
                        })}
                      </div>
                    </section>
                  ))}

                  {selectionApplicable && selection.size > 0 ? (
                    <div
                      className="task-batch-bar"
                      role="region"
                      aria-label="批量操作"
                      aria-live="polite"
                    >
                      <span className="task-batch-count">
                        已选 {selection.size} 条
                      </span>
                      {batch ? (
                        <span className="task-batch-progress">
                          处理中 {batch.done}/{batch.total}
                        </span>
                      ) : null}
                      <div className="task-batch-actions">
                        <button
                          type="button"
                          className="task-button task-button--small"
                          disabled={batchRunning}
                          onClick={() => void runBatchComplete([...selection])}
                        >
                          完成
                        </button>
                        <div className="task-batch-reschedule">
                          <button
                            type="button"
                            className="task-button task-button--small"
                            aria-haspopup="menu"
                            aria-expanded={rescheduleOpen}
                            disabled={batchRunning}
                            onClick={() => {
                              setRescheduleOpen((current) => !current);
                              setCustomDateOpen(false);
                            }}
                          >
                            改期 ▾
                          </button>
                          {rescheduleOpen ? (
                            <div
                              className="task-batch-menu"
                              role="menu"
                              aria-label="批量改期"
                            >
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() =>
                                  applyBatchDate(addDaysISO(store.today, 0))
                                }
                              >
                                今天
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() =>
                                  applyBatchDate(addDaysISO(store.today, 1))
                                }
                              >
                                明天
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setCustomDateValid(true);
                                  setCustomDateOpen(true);
                                }}
                              >
                                选择日期…
                              </button>
                              {customDateOpen ? (
                                <div className="task-batch-date">
                                  <DatePicker
                                    value={customDate || null}
                                    required
                                    ariaLabel="批量改期日期"
                                    showHelper={false}
                                    onValidityChange={setCustomDateValid}
                                    onChange={(next) =>
                                      setCustomDate(next ?? '')
                                    }
                                  />
                                  <button
                                    type="button"
                                    className="task-button task-button--small"
                                    disabled={!customDate || !customDateValid}
                                    onClick={() => applyBatchDate(customDate)}
                                  >
                                    应用
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          className="task-button task-button--small"
                          disabled={batchRunning}
                          onClick={exitBatch}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>

            {(selectedTask || taskMissing) && !batchMode ? (
              <button
                type="button"
                className="task-center-drawer-scrim"
                aria-label="关闭任务详情"
                onClick={closeTask}
              />
            ) : null}

            <div
              className={
                (selectedTask || taskMissing) && !batchMode
                  ? 'task-center-detail is-drawer-open'
                  : 'task-center-detail'
              }
              ref={detailRef}
              tabIndex={-1}
              aria-label="任务详情区"
            >
              {taskMissing ? (
                <div className="task-state-card">
                  <h2>这个任务不存在或已被删除</h2>
                  <p>它可能已被删除，或链接来自另一台设备。</p>
                  <button
                    type="button"
                    className="task-button"
                    onClick={closeTask}
                  >
                    关闭
                  </button>
                </div>
              ) : (
                <TaskDetailPanel
                  task={batchMode ? null : selectedTask}
                  lists={store.lists}
                  inboxId={store.inbox?.id ?? null}
                  defaultListId={defaultListId}
                  today={store.today}
                  onToggleTask={(task) => void toggleTask(task)}
                  onClose={closeTask}
                  closeOnDelete
                  emptyTitle="选一条任务查看详情"
                  emptyHint="点击任务行；用 ⌘K 可以搜索全部任务。"
                />
              )}
            </div>
          </div>

          <NewTaskDialog
            open={createOpen}
            lists={store.lists}
            inboxId={store.inbox?.id ?? null}
            defaultListId={quickDefaultListId}
            defaultDate={
              state.filter === 'today'
                ? store.today
                : state.filter === 'next'
                  ? addDaysISO(store.today, 1)
                  : null
            }
            onClose={() => setCreateOpen(false)}
            onSubmit={handleCreate}
          />

          {dragGhost && typeof document !== 'undefined'
            ? createPortal(
                <div
                  ref={ghostRef}
                  className="task-drag-ghost task-drag-ghost--board"
                  aria-hidden="true"
                >
                  <span className="task-drag-ghost-title">
                    {dragGhost.title}
                  </span>
                  <span className="task-drag-ghost-meta">
                    {dragGhost.meta}
                  </span>
                </div>,
                document.body,
              )
            : null}
        </>
      )}
    </section>
  );
}

function TaskCenterEmpty({
  reason,
  onCreate,
  onClear,
  onShowAll,
  onShowOpen,
  onFilter,
}: {
  reason: TaskCenterEmptyReason;
  onCreate: () => void;
  onClear: () => void;
  onShowAll: () => void;
  onShowOpen: () => void;
  onFilter: (filter: TaskCenterFilter) => void;
}) {
  const config: Record<
    TaskCenterEmptyReason,
    { title: string; description: string; primary?: string; secondary?: string }
  > = {
    'no-tasks': {
      title: '还没有任务',
      description: '从一件小事开始。新建的任务会出现在「未安排」，安排日期后进入对应范围。',
      primary: '＋ 新建任务',
    },
    filtered: {
      title: '没有匹配的任务',
      description: '试试清除筛选或换关键词。',
      primary: '清除筛选',
      secondary: '＋ 新建任务',
    },
    'undated-empty': {
      title: '没有未安排的任务',
      description: '所有任务都有日期。',
      primary: '查看全部未完成',
    },
    'today-empty': {
      title: '今天没有到期任务',
      description: '去「接下来」安排，或从「未安排」挑一件。',
      primary: '查看接下来',
      secondary: '查看未安排',
    },
    'next-empty': {
      title: '接下来 7 天还没有安排',
      description: '把未安排的任务放到未来几天。',
      primary: '查看未安排',
    },
    'done-empty': {
      title: '还没有已完成的任务',
      description: '完成任务后会出现在这里。',
      primary: '查看全部未完成',
    },
  };
  const item = config[reason];

  const renderAction = (label: string, key: string) => {
    if (label === '清除筛选') {
      return (
        <button
          key={key}
          type="button"
          className="task-button"
          onClick={onClear}
        >
          {label}
        </button>
      );
    }
    if (label === '查看全部任务') {
      return (
        <button
          key={key}
          type="button"
          className="task-button"
          onClick={onShowAll}
        >
          {label}
        </button>
      );
    }
    if (label === '查看全部未完成') {
      return (
        <button
          key={key}
          type="button"
          className="task-button"
          onClick={onShowOpen}
        >
          {label}
        </button>
      );
    }
    if (label === '查看接下来') {
      return (
        <button
          key={key}
          type="button"
          className="task-button"
          onClick={() => onFilter('next')}
        >
          {label}
        </button>
      );
    }
    if (label === '查看未安排') {
      return (
        <button
          key={key}
          type="button"
          className="task-button"
          onClick={() => onFilter('undated')}
        >
          {label}
        </button>
      );
    }
    return (
      <button
        key={key}
        type="button"
        className="task-button task-button--primary"
        onClick={onCreate}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="task-empty-card task-center-empty">
      <h2>{item.title}</h2>
      <p>{item.description}</p>
      <div className="task-center-empty-actions">
        {item.primary ? renderAction(item.primary, 'primary') : null}
        {item.secondary ? renderAction(item.secondary, 'secondary') : null}
      </div>
    </div>
  );
}
