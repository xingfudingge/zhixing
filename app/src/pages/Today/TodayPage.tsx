import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { isTauriRuntime } from '../../data/db/client';
import type { NewTask, Task } from '../../data/db/types';
import { NewTaskDialog } from '../../features/tasks/NewTaskDialog';
import { TaskDetailPanel } from '../../features/tasks/TaskDetailPanel';
import {
  TaskRow,
  TaskStatusButton,
  useTaskStatusActions,
} from '../../features/tasks/TaskRow';
import { TaskStoreGate } from '../../features/tasks/TaskStoreGate';
import {
  formatError,
  useTaskStore,
} from '../../features/tasks/TaskStore';
import { useToast } from '../../features/tasks/Feedback';
import { useTaskAction } from '../../features/tasks/actions';
import { resolveDefaultList } from '../Lists/tree';
import {
  BOARD_COLUMNS,
  QUADRANTS,
  QUADRANT_SCOPES,
  TODAY_VIEWS,
  formatOverdueLabel,
  formatTodayHeading,
  getBoardTasks,
  getQuadrantTasks,
  getTodayOverview,
  listNameOf,
  quadrantOf,
  statusLabel,
  type BoardStatus as BoardStatusType,
  type TodayView,
} from '../../features/tasks/viewModel';

type CreateDraft = {
  date: string | null;
  listId: string;
  quadrant: number;
};

type PointerDragMode = 'quadrant' | 'board';

/** 指针拖拽会话：阈值前不阻止点击，越过阈值后才进入拖拽。 */
type PointerDragSession = {
  taskId: string;
  title: string;
  meta: string;
  mode: PointerDragMode;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  /** 由 startDrag 或 Esc / pointercancel / blur 调用，不提交落点。 */
  cancel: () => void;
};

type DragGhostState = {
  title: string;
  meta: string;
  mode: PointerDragMode;
} | null;

type DropTarget =
  | { mode: 'quadrant'; quadrant: number }
  | { mode: 'board'; status: BoardStatusType };

/** 超过该距离才视为拖拽，避免和点击/勾选冲突。 */
const DRAG_THRESHOLD = 6;
/** 拖拽结束后短暂屏蔽 click，防止拖完又打开详情。 */
const CLICK_SUPPRESS_MS = 400;

export function TodayPage() {
  const store = useTaskStore();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const run = useTaskAction();
  const { toggle: toggleTask, setStatus } = useTaskStatusActions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dragOverQuadrant, setDragOverQuadrant] = useState<number | null>(null);
  const [dragOverStatus, setDragOverStatus] =
    useState<BoardStatusType | null>(null);
  const [dragGhost, setDragGhost] = useState<DragGhostState>(null);
  const pointerSessionRef = useRef<PointerDragSession | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const ghostPositionRef = useRef({ x: 0, y: 0 });
  const suppressClickUntilRef = useRef(0);
  // Tauri WKWebView 里原生 HTML5 拖拽不可靠：在桌面壳内关掉 draggable，
  // 让 pointer 拖拽独占手势；浏览器里仍保留 DragEvent 兼容路径。
  const pointerOnlyDrag = isTauriRuntime();
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(() => ({
    date: store.today,
    listId: '',
    quadrant: 4,
  }));

  // 知识笔记的“来源任务”回链：/today?task=<id> 直接打开对应详情。
  useEffect(() => {
    const taskId = searchParams.get('task');
    if (!taskId) {
      return;
    }
    setSelectedId(taskId);
    const next = new URLSearchParams(searchParams);
    next.delete('task');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // 导览 / 搜索深链：/today?view=quadrant 切到四象限后清理 URL。
  useEffect(() => {
    const view = searchParams.get('view');
    if (view !== 'list' && view !== 'quadrant' && view !== 'board') {
      return;
    }
    if (store.preferences.todayView !== view) {
      void store.setPreference('todayView', view).catch(() => undefined);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('view');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, store]);

  const defaultListId = useMemo(() => {
    return resolveDefaultList(store.lists)?.id ?? store.inbox?.id ?? '';
  }, [store.lists, store.inbox]);

  const overview = useMemo(
    () =>
      getTodayOverview(
        store.tasks,
        store.today,
        store.preferences.completionBehavior,
      ),
    [store.tasks, store.today, store.preferences.completionBehavior],
  );
  const quadrantTasks = useMemo(
    () => getQuadrantTasks(store.tasks, store.preferences.quadrantScope, store.today),
    [store.tasks, store.preferences.quadrantScope, store.today],
  );
  const selectedTask =
    store.tasks.find((task) => task.id === selectedId) ?? null;
  const doingOpen = overview.open.filter(
    (task) => task.status === 'doing',
  ).length;

  const setView = (next: TodayView) => {
    void run(() => store.setPreference('todayView', next));
  };

  const openCreate = (draft: Partial<CreateDraft> = {}) => {
    setCreateDraft({
      date: draft.date === undefined ? store.today : draft.date,
      listId: draft.listId ?? defaultListId,
      quadrant: draft.quadrant ?? 4,
    });
    setCreateOpen(true);
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
      if (input.dueDate) {
        setSelectedId(task.id);
        toast('已创建任务', { tone: 'success' });
      } else {
        toast('已加入未安排', {
          tone: 'success',
          action: {
            label: '查看未安排',
            onClick: () => navigate('/tasks?filter=undated'),
          },
        });
      }
    } catch (reason) {
      toast(formatError(reason), { tone: 'danger' });
      throw reason;
    }
  };

  const guardSelect = (id: string) => {
    // 拖拽结束后浏览器仍会补发一次 click，不能因此打开详情。
    if (Date.now() < suppressClickUntilRef.current) {
      return;
    }
    setSelectedId(id);
  };

  /** 四象限只改 quadrant，不碰日期、状态或清单。 */
  const moveTaskToQuadrant = async (id: string, quadrant: number) => {
    const task = store.tasks.find((item) => item.id === id);
    if (!task) {
      return;
    }
    const previous = quadrantOf(task);
    if (previous === quadrant) {
      return;
    }
    const title =
      QUADRANTS.find((item) => item.value === quadrant)?.title ?? '象限';
    await run(() => store.patchTask(id, { quadrant }), {
      success: `已移到「${title}」`,
      action: {
        label: '撤销',
        onClick: async () => {
          await run(() => store.patchTask(id, { quadrant: previous }), {
            success: '已恢复原象限',
          });
        },
      },
    });
  };

  /** 看板按状态规则移动；完成列复用统一完成/撤销逻辑。 */
  const moveTaskToStatus = async (id: string, status: BoardStatusType) => {
    const task = store.tasks.find((item) => item.id === id);
    if (!task) {
      return;
    }
    await setStatus(task, status);
  };

  const startDrag = <T extends HTMLElement>(
    event: DragEvent<T>,
    task: Task,
  ) => {
    // 原生 HTML5 拖拽一旦接管手势，指针路径立即让位，避免双重拖拽。
    pointerSessionRef.current?.cancel();
    setDragTaskId(task.id);
    event.dataTransfer?.setData('text/plain', task.id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
  };

  const resolveDragId = (event: DragEvent<HTMLElement>) =>
    dragTaskId ?? event.dataTransfer?.getData('text/plain') ?? null;

  const dropQuadrant = async (
    event: DragEvent<HTMLElement>,
    quadrant: number,
  ) => {
    event.preventDefault();
    setDragOverQuadrant(null);
    const id = resolveDragId(event);
    setDragTaskId(null);
    if (!id) {
      return;
    }
    await moveTaskToQuadrant(id, quadrant);
  };

  const dropBoard = async (
    event: DragEvent<HTMLElement>,
    status: BoardStatusType,
  ) => {
    event.preventDefault();
    setDragOverStatus(null);
    const id = resolveDragId(event);
    setDragTaskId(null);
    if (!id) {
      return;
    }
    await moveTaskToStatus(id, status);
  };

  /**
   * 根据指针位置找落点。优先 elementFromPoint（touch 隐式捕获时 target
   * 仍是起点），jsdom 没有布局时回退到事件 target。
   */
  const readDropTarget = (event: {
    clientX: number;
    clientY: number;
    target: EventTarget | null;
  }): DropTarget | null => {
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
      const quadrantElement = element.closest('[data-drop-quadrant]');
      if (quadrantElement) {
        const value = Number(
          quadrantElement.getAttribute('data-drop-quadrant'),
        );
        if (Number.isInteger(value) && value >= 1 && value <= 4) {
          return { mode: 'quadrant', quadrant: value };
        }
      }
      const statusElement = element.closest('[data-drop-status]');
      if (statusElement) {
        const status = statusElement.getAttribute('data-drop-status');
        if (status === 'todo' || status === 'doing' || status === 'done') {
          return { mode: 'board', status };
        }
      }
    }
    return null;
  };

  const positionGhostAt = (x: number, y: number) => {
    ghostPositionRef.current = { x, y };
    const ghost = ghostRef.current;
    if (ghost) {
      ghost.style.transform = `translate3d(${Math.round(x + 14)}px, ${Math.round(y + 14)}px, 0)`;
    }
  };

  // ghost 首次挂载后补一次定位（pointermove 时它可能还不存在）。
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

  // 页面卸载时中止进行中的指针拖拽，避免残留 body class / ghost。
  useEffect(() => {
    return () => {
      pointerSessionRef.current?.cancel();
    };
  }, []);

  const beginPointerDrag = (
    event: ReactPointerEvent<HTMLElement>,
    task: Task,
    mode: PointerDragMode,
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
    // 勾选、行内操作按钮保持原有点击语义，不作为拖拽起点。
    if (origin?.closest('.task-check, .task-row-actions, [data-no-drag]')) {
      return;
    }

    const session: PointerDragSession = {
      taskId: task.id,
      title: task.title,
      meta: listNameOf(store.lists, task.listId),
      mode,
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
      setDragOverQuadrant(null);
      setDragOverStatus(null);
      if (!session.active) {
        return;
      }
      // 拖拽后的补充 click 不应当选中任务。
      suppressClickUntilRef.current = Date.now() + CLICK_SUPPRESS_MS;
      if (!upEvent) {
        return;
      }
      const target = readDropTarget(upEvent);
      if (!target) {
        // 拖到空白区域或别的视图：无副作用。
        return;
      }
      if (target.mode === 'quadrant' && session.mode === 'quadrant') {
        void moveTaskToQuadrant(session.taskId, target.quadrant);
      } else if (target.mode === 'board' && session.mode === 'board') {
        void moveTaskToStatus(session.taskId, target.status);
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
        setDragGhost({
          title: session.title,
          meta: session.meta,
          mode: session.mode,
        });
        document.body.classList.add('task-pointer-dragging');
        window.getSelection()?.removeAllRanges();
      }
      if (moveEvent.cancelable) {
        moveEvent.preventDefault();
      }
      positionGhostAt(moveEvent.clientX, moveEvent.clientY);
      const target = readDropTarget(moveEvent);
      if (session.mode === 'quadrant') {
        setDragOverQuadrant(
          target?.mode === 'quadrant' ? target.quadrant : null,
        );
      } else {
        setDragOverStatus(target?.mode === 'board' ? target.status : null);
      }
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

  const renderRow = (task: Task) => (
    <TaskRow
      key={task.id}
      task={task}
      lists={store.lists}
      today={store.today}
      selected={selectedId === task.id}
      onSelect={() => guardSelect(task.id)}
      onToggle={() => void toggleTask(task)}
      onStatusChange={(status) => void setStatus(task, status)}
    />
  );

  const renderQuadrantRow = (task: Task) => (
    <TaskRow
      key={task.id}
      task={task}
      lists={store.lists}
      today={store.today}
      selected={selectedId === task.id}
      onSelect={() => guardSelect(task.id)}
      onToggle={() => void toggleTask(task)}
      onStatusChange={(status) => void setStatus(task, status)}
      draggable={!pointerOnlyDrag}
      dragging={dragTaskId === task.id}
      onDragStart={startDrag}
      onPointerDragStart={(event, dragged) =>
        beginPointerDrag(event, dragged, 'quadrant')
      }
    />
  );

  return (
    <section className="page task-page" aria-labelledby="today-title">
      <header className="task-page-head">
        <div>
          <p className="page-eyebrow">工作台 · 今天</p>
          <h1 id="today-title">今天</h1>
          <p className="task-page-sub">
            {formatTodayHeading(store.today)} · 把重要的事先做完
          </p>
        </div>
        {store.status === 'ready' ? (
          <div className="task-head-actions">
            <button
              type="button"
              className="task-button task-button--primary"
              onClick={() => openCreate()}
            >
              ＋ 新任务
            </button>
          </div>
        ) : null}
      </header>

      <TaskStoreGate>
        <section className="today-brief" aria-label="今日概览">
          <div className="today-brief-copy">
            <p className="today-kicker">TODAY</p>
            <strong>
              {overview.total === 0
                ? '今天还没有任务，先加一件最重要的事'
                : overview.open.length > 0
                  ? `还有 ${overview.open.length} 件事，先做最重要的一件`
                  : '今天的任务都完成了'}
            </strong>
            <p>
              {overview.overdue.length > 0
                ? `有 ${overview.overdue.length} 件逾期任务，建议先处理或改期。`
                : '没有逾期任务，节奏不错。'}
            </p>
            <div className="today-tags">
              <span>
                ◷ {overview.open.filter((task) => task.dueTime).length} 个时间点
              </span>
              <span>△ {overview.overdue.length} 件逾期</span>
              <span>▸ {doingOpen} 件进行中</span>
              <span>✓ {overview.doneCount} 件已完成</span>
            </div>
          </div>
          <div
            className="today-progress"
            role="img"
            aria-label={`今日完成 ${overview.doneCount}/${overview.total}`}
            style={{ '--progress': `${overview.percent}%` } as CSSProperties}
          >
            <div>
              <b>
                {overview.doneCount}/{overview.total}
              </b>
              <span>已完成</span>
            </div>
          </div>
        </section>

        <div className="task-toolbar">
          <div className="task-tabs" aria-label="今天视图">
            {TODAY_VIEWS.map((item) => (
              <button
                type="button"
                key={item.value}
                className="task-tab"
                aria-pressed={store.preferences.todayView === item.value}
                onClick={() => setView(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="task-toolbar-hint">
            逾期任务保留原日期，只加逾期标记
          </span>
        </div>

        <div className="task-workspace">
          <div className="task-main">
            {store.preferences.todayView === 'list' ? (
              <ListView
                overview={overview}
                renderRow={renderRow}
                onCreate={() => openCreate()}
              />
            ) : null}

            {store.preferences.todayView === 'quadrant' ? (
              <div>
                <div className="task-scope">
                  {QUADRANT_SCOPES.map((item) => (
                    <button
                      type="button"
                      key={item.value}
                      className="task-tab"
                      aria-pressed={
                        store.preferences.quadrantScope === item.value
                      }
                      onClick={() => {
                        void run(() =>
                          store.setPreference('quadrantScope', item.value),
                        );
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                  <span className="task-toolbar-hint">
                    拖动只改象限，不改变日期或状态
                  </span>
                </div>
                <div className="task-quadrant-grid">
                  {QUADRANTS.map((quadrant) => {
                    const items = quadrantTasks.filter(
                      (task) => quadrantOf(task) === quadrant.value,
                    );
                    return (
                      <section
                        key={quadrant.value}
                        className={
                          dragOverQuadrant === quadrant.value
                            ? 'task-quadrant is-over'
                            : 'task-quadrant'
                        }
                        aria-label={`四象限：${quadrant.title}`}
                        data-drop-quadrant={quadrant.value}
                        onDragOver={(event) => {
                          event.preventDefault();
                          setDragOverQuadrant(quadrant.value);
                        }}
                        onDragLeave={() => setDragOverQuadrant(null)}
                        onDrop={(event) =>
                          void dropQuadrant(event, quadrant.value)
                        }
                      >
                        <div className="task-quadrant-head">
                          <span>{quadrant.title}</span>
                          <small>
                            {quadrant.hint} · {items.length}
                          </small>
                        </div>
                        <div className="task-list">
                          {items.map(renderQuadrantRow)}
                        </div>
                        {items.length === 0 ? (
                          <p className="task-quadrant-empty">这一格还空着</p>
                        ) : null}
                        <button
                          type="button"
                          className="task-button task-button--ghost task-button--small"
                          onClick={() =>
                            openCreate({ quadrant: quadrant.value })
                          }
                        >
                          ＋ 新建
                        </button>
                      </section>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {store.preferences.todayView === 'board' ? (
              <div>
                <p className="task-toolbar-hint task-board-hint">
                  看板按状态分组；拖动卡片改状态，和四象限是两个维度。
                </p>
                <div className="task-board">
                  {BOARD_COLUMNS.map((column) => {
                    const items = getBoardTasks(
                      store.tasks,
                      column.status,
                      store.today,
                      store.preferences.completionBehavior,
                    );
                    return (
                      <section
                        key={column.status}
                        className={
                          dragOverStatus === column.status
                            ? 'task-board-column is-over'
                            : 'task-board-column'
                        }
                        aria-label={`${column.label}列`}
                        data-status={column.status}
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
                          <span className="task-board-bar" aria-hidden="true" />
                          {column.label}
                          <span className="task-board-count">
                            {items.length}
                          </span>
                        </div>
                        {items.length === 0 ? (
                          <p className="task-board-empty">
                            {column.status === 'done'
                              ? store.preferences.completionBehavior ===
                                'remove'
                                ? '完成后已按设置移出当前视图'
                                : '今天还没有完成的任务'
                              : column.status === 'doing'
                                ? '把卡片拖到这里开始做'
                                : '暂无待办任务'}
                          </p>
                        ) : null}
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
                              draggable={!pointerOnlyDrag}
                              data-task-id={task.id}
                              aria-label={`${task.title}，${statusLabel(
                                task.status,
                              )}，可拖动改状态`}
                              onClick={() => guardSelect(task.id)}
                              onKeyDown={(event) => {
                                if (
                                  event.target !== event.currentTarget ||
                                  (event.key !== 'Enter' &&
                                    event.key !== ' ')
                                ) {
                                  return;
                                }
                                event.preventDefault();
                                guardSelect(task.id);
                              }}
                              onDragStart={(event) => startDrag(event, task)}
                              onPointerDown={(event) =>
                                beginPointerDrag(event, task, 'board')
                              }
                            >
                              <span className="task-card-title">
                                {task.title}
                              </span>
                              <span className="task-card-meta">
                                <span>
                                  {listNameOf(store.lists, task.listId)}
                                </span>
                                {overdue ? (
                                  <span className="task-badge task-badge--overdue">
                                    {overdue}
                                  </span>
                                ) : task.dueTime ? (
                                  <span>· {task.dueTime}</span>
                                ) : null}
                                {task.priority > 0 ? (
                                  <span>· 优先级 {task.priority}</span>
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
                      </section>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <TaskDetailPanel
            task={selectedTask}
            lists={store.lists}
            inboxId={store.inbox?.id ?? null}
            defaultListId={defaultListId}
            today={store.today}
            onToggleTask={(task) => void toggleTask(task)}
            onClose={() => setSelectedId(null)}
          />
        </div>

        <NewTaskDialog
          open={createOpen}
          lists={store.lists}
          inboxId={store.inbox?.id ?? null}
          defaultListId={createDraft.listId || defaultListId}
          defaultDate={createDraft.date}
          defaultQuadrant={createDraft.quadrant}
          onClose={() => setCreateOpen(false)}
          onSubmit={handleCreate}
        />
      </TaskStoreGate>

      {dragGhost && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={ghostRef}
              className={`task-drag-ghost task-drag-ghost--${dragGhost.mode}`}
              aria-hidden="true"
            >
              <span className="task-drag-ghost-title">{dragGhost.title}</span>
              <span className="task-drag-ghost-meta">{dragGhost.meta}</span>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}

type ListViewProps = {
  overview: ReturnType<typeof getTodayOverview>;
  renderRow: (task: Task) => ReactElement;
  onCreate: () => void;
};

function ListView({ overview, renderRow, onCreate }: ListViewProps) {
  const emptyToday =
    overview.total === 0
      ? '今天还没有任务，先加一件最重要的事。'
      : '今天没有未完成任务。';

  return (
    <div>
      {overview.overdue.length > 0 ? (
        <section className="task-section" aria-label="逾期任务">
          <h2 className="task-section-head task-section-head--danger">
            逾期 <span className="task-count">{overview.overdue.length}</span>
          </h2>
          <div className="task-list">{overview.overdue.map(renderRow)}</div>
        </section>
      ) : null}

      <section className="task-section" aria-label="今天未完成">
        <h2 className="task-section-head">
          今天 · 未完成
          <span className="task-count">{overview.todayOpen.length}</span>
        </h2>
        <div className="task-list">
          {overview.todayOpen.length > 0 ? (
            overview.todayOpen.map(renderRow)
          ) : (
            <p className="task-empty">{emptyToday}</p>
          )}
        </div>
      </section>

      {overview.todayDone.length > 0 ? (
        <section className="task-section" aria-label="今天已完成">
          <h2 className="task-section-head">
            今天 · 已完成
            <span className="task-count">{overview.todayDone.length}</span>
          </h2>
          <div className="task-list">{overview.todayDone.map(renderRow)}</div>
        </section>
      ) : null}

      <button
        type="button"
        className="task-button task-button--ghost task-add-button"
        onClick={onCreate}
      >
        ＋ 添加任务
      </button>
    </div>
  );
}
