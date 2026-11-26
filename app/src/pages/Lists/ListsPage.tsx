import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import type { List, NewTask, Task, TaskStatus } from '../../data/db/types';
import { NewTaskDialog } from '../../features/tasks/NewTaskDialog';
import { TaskDetailPanel } from '../../features/tasks/TaskDetailPanel';
import { TaskRow, useTaskStatusActions } from '../../features/tasks/TaskRow';
import { TaskStoreGate } from '../../features/tasks/TaskStoreGate';
import { formatError, useTaskStore } from '../../features/tasks/TaskStore';
import { useToast } from '../../features/tasks/Feedback';
import {
  countOpenTasks,
  groupListTasks,
  type ListTaskGroups,
} from '../../features/tasks/viewModel';
import { ListIcon } from './ListIcon';
import { useListDialogs } from './useListDialogs';
import { ancestorIds, orderedUserLists, resolveDefaultList } from './tree';

type ListStat = {
  open: number;
  done: number;
  total: number;
};

/**
 * 清单入口：
 * * `/lists` 只显示清单管理概览（可选 `?mode=select` 单选态），绝不自动打开第一个清单；
 * * 只有 `/lists/:listId` 才渲染具体清单的任务。
 */
export function ListsPage() {
  const { listId } = useParams<{ listId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const store = useTaskStore();
  const toast = useToast();
  const { toggle: toggleTask, setStatus } = useTaskStatusActions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [pickedListId, setPickedListId] = useState<string | null>(null);
  const [overviewMenuId, setOverviewMenuId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(null);
  }, [listId]);

  const overview = !listId;
  const selecting = overview && searchParams.get('mode') === 'select';

  const ordered = useMemo(() => orderedUserLists(store.lists), [store.lists]);
  const directList = listId
    ? store.lists.find((item) => item.id === listId) ?? null
    : null;
  // 关键：/lists 没有 listId 时不回退到 ordered[0]。
  const activeList = directList;
  const listMissing = Boolean(listId && !directList);

  const listStats = useMemo(() => {
    const map = new Map<string, ListStat>();
    for (const list of ordered) {
      map.set(list.id, { open: 0, done: 0, total: 0 });
    }
    for (const task of store.tasks) {
      if (task.deletedAt !== null) {
        continue;
      }
      const stat = map.get(task.listId);
      if (!stat) {
        continue;
      }
      stat.total += 1;
      if (task.status === 'done') {
        stat.done += 1;
      } else {
        stat.open += 1;
      }
    }
    return map;
  }, [ordered, store.tasks]);

  const totalOpen = useMemo(
    () =>
      ordered.reduce(
        (sum, list) => sum + (listStats.get(list.id)?.open ?? 0),
        0,
      ),
    [ordered, listStats],
  );
  const pickedList = pickedListId
    ? ordered.find((list) => list.id === pickedListId) ?? null
    : null;

  const exitSelectMode = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('mode');
    setSearchParams(next, { replace: true });
    setPickedListId(null);
  }, [searchParams, setSearchParams]);

  const enterSelectMode = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.set('mode', 'select');
    setSearchParams(next, { replace: true });
    setPickedListId(null);
  }, [searchParams, setSearchParams]);

  // 选择态绝不预选；清单被删除后同步清掉已选项。
  useEffect(() => {
    if (!pickedListId) {
      return;
    }
    if (!ordered.some((list) => list.id === pickedListId)) {
      setPickedListId(null);
    }
  }, [ordered, pickedListId]);

  // 选择态 Esc 退出，保留概览。
  useEffect(() => {
    if (!selecting) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        exitSelectMode();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selecting, exitSelectMode]);

  // 概览卡片菜单：点击外部 / Esc 关闭。
  useEffect(() => {
    if (!overviewMenuId) {
      return;
    }
    const close = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.list-card-action, .list-tree-menu')) {
        return;
      }
      setOverviewMenuId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOverviewMenuId(null);
      }
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [overviewMenuId]);

  // 侧栏树是唯一清单树；页面只展示当前清单，用面包屑补回父级上下文。
  const listTrail = useMemo(() => {
    if (!activeList) {
      return [];
    }
    const byId = new Map(store.lists.map((list) => [list.id, list]));
    return ancestorIds(store.lists, activeList.id)
      .map((id) => byId.get(id))
      .filter((item): item is List => Boolean(item))
      .reverse();
  }, [store.lists, activeList]);

  const listTasks = useMemo(
    () =>
      activeList
        ? store.tasks.filter((task) => task.listId === activeList.id)
        : [],
    [store.tasks, activeList],
  );
  const groups = useMemo(
    () =>
      groupListTasks(
        listTasks,
        store.preferences.completionBehavior,
      ),
    [listTasks, store.preferences.completionBehavior],
  );
  // 仅用于空态说明：已完成任务被设置移出时，不能误报“这个清单还没有任务”。
  const hiddenDoneCount = useMemo(
    () =>
      store.preferences.completionBehavior === 'remove'
        ? listTasks.filter((task) => task.status === 'done').length
        : 0,
    [listTasks, store.preferences.completionBehavior],
  );
  const selectedTask =
    store.tasks.find((task) => task.id === selectedId) ?? null;
  const defaultList = resolveDefaultList(store.lists);
  const defaultListId = defaultList?.id ?? store.inbox?.id ?? '';

  const dialogs = useListDialogs({
    onDeleted: (target) => {
      setOverviewMenuId(null);
      setPickedListId(null);
      if (target.id === listId) {
        // 删除当前打开的清单：明确回到管理概览，不落到其他清单。
        navigate('/lists');
      }
    },
  });

  // 侧栏清单树的操作通过查询参数进入本页弹层：
  // ?new=root / ?newChild=<id> / ?edit=<id> / ?delete=<id> / ?move=<id>
  useEffect(() => {
    if (store.status !== 'ready') {
      return;
    }
    const newRoot = searchParams.get('new');
    const childId = searchParams.get('newChild');
    const editId = searchParams.get('edit');
    const deleteId = searchParams.get('delete');
    const moveId = searchParams.get('move');
    if (!newRoot && !childId && !editId && !deleteId && !moveId) {
      return;
    }
    if (newRoot === 'root') {
      dialogs.openCreate(null);
    }
    if (childId) {
      const parent = store.lists.find((item) => item.id === childId);
      if (parent) {
        dialogs.openCreate(parent.id);
      }
    }
    if (editId) {
      const target = store.lists.find((item) => item.id === editId);
      if (target) {
        dialogs.openEdit(target);
      }
    }
    if (deleteId) {
      const target = store.lists.find((item) => item.id === deleteId);
      if (target) {
        dialogs.openDelete(target);
      }
    }
    if (moveId) {
      const target = store.lists.find((item) => item.id === moveId);
      if (target) {
        dialogs.openMove(target);
      }
    }
    const next = new URLSearchParams(searchParams);
    for (const key of ['new', 'newChild', 'edit', 'delete', 'move']) {
      next.delete(key);
    }
    setSearchParams(next, { replace: true });
  }, [
    searchParams,
    setSearchParams,
    store.status,
    store.lists,
    dialogs.openCreate,
    dialogs.openEdit,
    dialogs.openDelete,
    dialogs.openMove,
  ]);

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

  if (activeList?.isInbox) {
    const params = new URLSearchParams({ filter: 'undated' });
    const taskId = searchParams.get('task');
    if (taskId) {
      params.set('task', taskId);
    }
    return <Navigate to={`/tasks?${params.toString()}`} replace />;
  }

  const openList = (list: List) => {
    if (selecting) {
      setPickedListId(list.id);
      return;
    }
    navigate(`/lists/${list.id}`);
  };

  const overviewHeader = (
    <header className="task-page-head lists-page-head">
      <div>
        <p className="page-eyebrow">清单 · 管理</p>
        <h1 id="lists-title">
          {selecting ? '选择要打开的清单' : '清单管理'}
        </h1>
        <p className="task-page-sub">
          {selecting
            ? '选中一个清单后打开；Esc 取消。不会自动选中第一个。'
            : store.status === 'ready'
              ? `先选择清单；不会自动打开第一个清单。共 ${ordered.length} 个清单 · ${totalOpen} 条未完成。`
              : '先选择清单；不会自动打开第一个清单。'}
        </p>
      </div>
      {store.status === 'ready' ? (
        <div className="task-head-actions">
          {selecting ? (
            <button type="button" className="task-button" onClick={exitSelectMode}>
              取消
            </button>
          ) : (
            <>
              <button
                type="button"
                className="task-button"
                disabled={ordered.length === 0}
                onClick={enterSelectMode}
              >
                选择清单
              </button>
              <button
                type="button"
                className="task-button task-button--primary"
                onClick={() => dialogs.openCreate(null)}
              >
                ＋ 新建清单
              </button>
            </>
          )}
        </div>
      ) : null}
    </header>
  );

  const detailHeader = (
    <header className="task-page-head lists-page-head">
      <div>
        <Link
          className="task-button task-button--ghost lists-back-link"
          to="/lists"
          style={{ marginBottom: 6 }}
        >
          ← 返回清单管理
        </Link>
        {activeList && listTrail.length > 0 ? (
          <nav className="lists-breadcrumb" aria-label="清单路径">
            <Link to="/lists">全部清单</Link>
            {listTrail.map((item) => (
              <span className="lists-breadcrumb-item" key={item.id}>
                <span className="lists-breadcrumb-sep" aria-hidden="true">
                  /
                </span>
                <Link to={`/lists/${item.id}`}>{item.name}</Link>
              </span>
            ))}
            <span className="lists-breadcrumb-item">
              <span className="lists-breadcrumb-sep" aria-hidden="true">
                /
              </span>
              <span className="lists-breadcrumb-current" aria-current="page">
                {activeList.name}
              </span>
            </span>
          </nav>
        ) : (
          <p className="page-eyebrow">清单 · 详情</p>
        )}
        <h1 id="lists-title">
          {activeList
            ? activeList.name
            : listMissing
              ? '清单不存在或已删除'
              : '清单'}
        </h1>
        <p className="task-page-sub">
          {activeList
            ? `${countOpenTasks(listTasks)} 未完成 · ${groups.done.length} 已完成 · 清单只负责归类，不改变任务状态`
            : listMissing
              ? '它可能已被删除；任务仍在「未安排」或原日期中，不会丢数据。'
              : '用清单组织不同领域的任务；删除清单不会删除任务，任务会移到未安排。'}
        </p>
      </div>
      {store.status === 'ready' && activeList ? (
        <div className="task-head-actions">
          <button
            type="button"
            className="task-button"
            onClick={() => dialogs.openEdit(activeList)}
          >
            编辑清单
          </button>
          <button
            type="button"
            className="task-button task-button--danger"
            onClick={() => dialogs.openDelete(activeList)}
          >
            删除清单
          </button>
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
  );

  const overviewContent = (
    <>
      <p className="task-inline-hint">
        清单只负责分类；任务总账在「任务」。删除清单不会删除任务。
      </p>
      {ordered.length > 0 ? (
        <div className="lists-grid" aria-label="全部清单">
          {ordered.map((list) => {
            const stat = listStats.get(list.id) ?? {
              open: 0,
              done: 0,
              total: 0,
            };
            const picked = selecting && pickedListId === list.id;
            return (
              <article
                key={list.id}
                className="list-card"
                role="button"
                tabIndex={0}
                data-list-card={list.id}
                data-selected={picked ? 'true' : undefined}
                aria-pressed={selecting ? picked : undefined}
                aria-label={`${list.name}，${stat.open} 条未完成，${stat.done} 条已完成`}
                style={{
                  position: 'relative',
                  cursor: 'pointer',
                  ...(picked
                    ? {
                        borderColor: 'var(--blue)',
                        boxShadow: '0 0 0 1px var(--blue)',
                      }
                    : {}),
                }}
                onClick={(event) => {
                  const target = event.target as HTMLElement | null;
                  if (target?.closest('[data-list-card-action]')) {
                    return;
                  }
                  openList(list);
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) {
                    return;
                  }
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openList(list);
                  }
                }}
              >
                <ListIcon list={list} />
                <div className="list-card-body">
                  <span className="list-card-name">{list.name}</span>
                  <span className="list-card-meta">
                    {stat.open} 未完成 · {stat.done} 已完成
                  </span>
                  {selecting ? null : (
                    <span className="list-card-meta">打开清单 →</span>
                  )}
                </div>
                {selecting ? (
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'grid',
                      width: 16,
                      height: 16,
                      flex: 'none',
                      placeItems: 'center',
                      borderRadius: 'var(--radius-pill)',
                      border: '1px solid var(--line-strong)',
                      background: picked ? 'var(--blue)' : 'var(--surface)',
                      color: 'var(--on-accent)',
                      fontSize: 10,
                      lineHeight: 1,
                    }}
                  >
                    {picked ? '✓' : ''}
                  </span>
                ) : (
                  <div
                    className="list-card-action"
                    data-list-card-action
                    style={{ position: 'relative', flex: 'none' }}
                  >
                    <button
                      type="button"
                      className="list-tree-more"
                      style={{ opacity: 1 }}
                      aria-label={`管理清单：${list.name}`}
                      aria-haspopup="menu"
                      aria-expanded={overviewMenuId === list.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOverviewMenuId((current) =>
                          current === list.id ? null : list.id,
                        );
                      }}
                    >
                      ···
                    </button>
                    {overviewMenuId === list.id ? (
                      <div
                        className="list-tree-menu"
                        role="menu"
                        aria-label={`${list.name} 操作`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setOverviewMenuId(null);
                            dialogs.openEdit(list);
                          }}
                        >
                          编辑清单
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="is-danger"
                          onClick={() => {
                            setOverviewMenuId(null);
                            dialogs.openDelete(list);
                          }}
                        >
                          删除清单
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="task-empty-card">
          <h2>还没有清单</h2>
          <p>新建一个清单来归类任务；不填日期的任务会进入未安排。</p>
          {store.status === 'ready' ? (
            <button
              type="button"
              className="task-button task-button--primary"
              onClick={() => dialogs.openCreate(null)}
            >
              ＋ 新建清单
            </button>
          ) : null}
        </div>
      )}
      {selecting ? (
        <div className="task-head-actions" style={{ marginTop: 12 }}>
          <span
            className="task-page-sub"
            style={{ marginRight: 'auto', marginTop: 0 }}
          >
            {pickedList
              ? `已选「${pickedList.name}」`
              : '还没有选择清单；请点一张卡片。'}
          </span>
          <button type="button" className="task-button" onClick={exitSelectMode}>
            取消
          </button>
          <button
            type="button"
            className="task-button task-button--primary"
            disabled={!pickedList}
            onClick={() => {
              if (pickedList) {
                navigate(`/lists/${pickedList.id}`);
              }
            }}
          >
            打开清单
          </button>
        </div>
      ) : null}
    </>
  );

  return (
    <section className="page task-page lists-page" aria-labelledby="lists-title">
      {overview ? overviewHeader : detailHeader}

      <TaskStoreGate>
        {overview ? (
          overviewContent
        ) : activeList ? (
          <ListDetail
            groups={groups}
            hiddenDoneCount={hiddenDoneCount}
            lists={store.lists}
            today={store.today}
            selectedTask={selectedTask}
            onSelect={setSelectedId}
            onToggle={(task) => void toggleTask(task)}
            onStatusChange={(task, status) => void setStatus(task, status)}
            onNewTask={() => setCreateOpen(true)}
            inboxId={store.inbox?.id ?? null}
            defaultListId={defaultListId}
          />
        ) : listMissing ? (
          <div className="task-state-card">
            <h2>这个清单不存在或已被删除</h2>
            <p>任务不会因为清单不存在而丢失，可能已经在未安排里。</p>
            <Link className="task-button" to="/lists">
              返回清单管理
            </Link>
          </div>
        ) : (
          <div className="task-empty-card">
            <h2>还没有清单</h2>
            <p>新建一个清单来归类任务；不填日期的任务会进入未安排。</p>
            <button
              type="button"
              className="task-button task-button--primary"
              onClick={() => dialogs.openCreate(null)}
            >
              ＋ 新建清单
            </button>
          </div>
        )}

        <NewTaskDialog
          open={createOpen}
          lists={store.lists}
          inboxId={store.inbox?.id ?? null}
          defaultListId={activeList?.id ?? defaultListId}
          defaultDate={store.today}
          onClose={() => setCreateOpen(false)}
          onSubmit={handleCreate}
        />

        {dialogs.node}
      </TaskStoreGate>
    </section>
  );
}

type ListDetailProps = {
  groups: ListTaskGroups;
  /** `remove` 设置下被隐藏的已完成数量，只用于准确空态。 */
  hiddenDoneCount: number;
  lists: List[];
  today: string;
  selectedTask: Task | null;
  onSelect: (id: string) => void;
  onToggle: (task: Task) => void;
  onStatusChange: (task: Task, status: TaskStatus) => void;
  onNewTask: () => void;
  inboxId: string | null;
  defaultListId: string;
};

function ListDetail({
  groups,
  hiddenDoneCount,
  lists,
  today,
  selectedTask,
  onSelect,
  onToggle,
  onStatusChange,
  onNewTask,
  inboxId,
  defaultListId,
}: ListDetailProps) {
  const showEmpty =
    groups.todo.length === 0 &&
    groups.doing.length === 0 &&
    groups.done.length === 0;

  if (showEmpty) {
    return (
      <div className="task-workspace">
        <div className="task-main">
          <div className="task-empty-card">
            {hiddenDoneCount > 0 ? (
              <>
                <h2>没有未完成任务</h2>
                <p>
                  已完成 {hiddenDoneCount} 条已按「完成后移出」设置隐藏；
                  可在任务中心的「已完成」中查看。
                </p>
                <Link className="task-button" to="/tasks?filter=done">
                  查看已完成
                </Link>
              </>
            ) : (
              <>
                <h2>这个清单还没有任务</h2>
                <p>清单只负责归类，任务可以随时改期或移到其他清单。</p>
              </>
            )}
            <button
              type="button"
              className="task-button task-button--primary"
              onClick={onNewTask}
            >
              ＋ 添加任务
            </button>
          </div>
        </div>
        <TaskDetailPanel
          task={null}
          lists={lists}
          inboxId={inboxId}
          defaultListId={defaultListId}
          today={today}
          onToggleTask={onToggle}
        />
      </div>
    );
  }

  return (
    <div className="task-workspace">
      <div className="task-main">
        <GroupSection
          title="待办"
          tasks={groups.todo}
          lists={lists}
          today={today}
          selectedId={selectedTask?.id ?? null}
          onSelect={onSelect}
          onToggle={onToggle}
          onStatusChange={onStatusChange}
        />
        <GroupSection
          title="进行中"
          tasks={groups.doing}
          lists={lists}
          today={today}
          selectedId={selectedTask?.id ?? null}
          onSelect={onSelect}
          onToggle={onToggle}
          onStatusChange={onStatusChange}
        />
        <GroupSection
          title="已完成"
          tasks={groups.done}
          lists={lists}
          today={today}
          selectedId={selectedTask?.id ?? null}
          onSelect={onSelect}
          onToggle={onToggle}
          onStatusChange={onStatusChange}
        />
        <button
          type="button"
          className="task-button task-button--ghost task-add-button"
          onClick={onNewTask}
        >
          ＋ 添加任务
        </button>
      </div>

      <TaskDetailPanel
        task={selectedTask}
        lists={lists}
        inboxId={inboxId}
        defaultListId={defaultListId}
        today={today}
        onToggleTask={onToggle}
      />
    </div>
  );
}

type GroupSectionProps = {
  title: string;
  tasks: Task[];
  lists: List[];
  today: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (task: Task) => void;
  onStatusChange: (task: Task, status: TaskStatus) => void;
};

function GroupSection({
  title,
  tasks,
  lists,
  today,
  selectedId,
  onSelect,
  onToggle,
  onStatusChange,
}: GroupSectionProps) {
  if (tasks.length === 0) {
    return null;
  }
  return (
    <section className="task-section" aria-label={title}>
      <h2 className="task-section-head">
        {title} <span className="task-count">{tasks.length}</span>
      </h2>
      <div className="task-list">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            lists={lists}
            today={today}
            selected={selectedId === task.id}
            onSelect={() => onSelect(task.id)}
            onToggle={() => onToggle(task)}
            onStatusChange={(status) => onStatusChange(task, status)}
          />
        ))}
      </div>
    </section>
  );
}
