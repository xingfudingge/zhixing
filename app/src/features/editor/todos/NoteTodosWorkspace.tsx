/**
 * 笔记待办工作台：块编辑器 + 文末汇总 + 关联任务弹层 + 删除撤销。
 *
 * 这是 P1-03 的组装入口。知识页只需渲染：
 *
 *   <NoteTodosWorkspace noteId={note.id} />
 *
 * 所有数据仍走 SQLite 仓储；测试可注入块仓储、笔记待办仓储、任务/清单源。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { UndoProvider, useOptionalUndo, useUndo } from '../../../app/undo';
import { db } from '../../../data/db/client';
import type { List, NoteTodo } from '../../../data/db/types';
import {
  createBlockRepository,
  type BlockRepository,
} from '../../../data/repositories/blocks';
import { createListRepository } from '../../../data/repositories/lists';
import {
  createNoteTodoRepository,
  type NoteTodoRepository,
} from '../../../data/repositories/noteTodos';
import { createTaskRepository } from '../../../data/repositories/tasks';
import {
  NoteBlockEditor,
  type NoteBlockEditorProps,
} from '../NoteBlockEditor';
import {
  createTodoTaskLinkService,
  linkedTaskIsDeleted,
  type TodoTaskChoice,
  type TodoTaskSource,
  type TodoTaskState,
} from '../../tasks/linkTodo';
import { TodoLinkDialog } from './TodoLinkDialog';
import { TodoSummary } from './TodoSummary';
import {
  createNoteTodoBlockSource,
  type DeletedTodoSnapshot,
  type NoteTodoBlockSource,
} from './todoBlockSource';
import './todos.css';

export type NoteTodosTaskSource = {
  tasks: TodoTaskSource['tasks'];
  lists?: TodoTaskSource['lists'];
};

/** 知识页把标题、只读、工具轨等编辑器能力原样透传给内联块编辑器。 */
export type NoteTodosEditorProps = Omit<
  NoteBlockEditorProps,
  'noteId' | 'source' | 'saveDelayMs' | 'onError'
>;

export type NoteTodosWorkspaceProps = {
  noteId: string;
  /** 测试注入；不传时使用真实 SQLite 仓储。 */
  blockSource?: BlockRepository;
  noteTodoSource?: NoteTodoRepository;
  taskSource?: NoteTodosTaskSource;
  saveDelayMs?: number;
  className?: string;
  /** 透传块编辑器；不改变待办数据链路。 */
  editorProps?: NoteTodosEditorProps;
  /** 上层（知识页）统一提示编辑器错误；不传时工作台内部提示。 */
  onEditorError?: (error: Error) => void;
};

type Notice = {
  id: number;
  message: string;
  tone: 'ok' | 'error';
};

function sourceError(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '操作失败，请重试';
}

function attributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 外层只补 UndoProvider，保证汇总删除在任何页面都有 5 秒撤销。 */
export function NoteTodosWorkspace(props: NoteTodosWorkspaceProps) {
  const undo = useOptionalUndo();
  if (!undo) {
    return (
      <UndoProvider>
        <NoteTodosWorkspaceBody {...props} />
      </UndoProvider>
    );
  }
  return <NoteTodosWorkspaceBody {...props} />;
}

function NoteTodosWorkspaceBody({
  noteId,
  blockSource,
  noteTodoSource,
  taskSource,
  saveDelayMs = 300,
  className,
  editorProps,
  onEditorError,
}: NoteTodosWorkspaceProps) {
  const blocks = useMemo<BlockRepository>(
    () => blockSource ?? createBlockRepository(db),
    [blockSource],
  );
  const todosRepository = useMemo<NoteTodoRepository>(
    () => noteTodoSource ?? createNoteTodoRepository(db),
    [noteTodoSource],
  );
  const source = useMemo<NoteTodoBlockSource>(
    () =>
      createNoteTodoBlockSource({
        noteId,
        blocks,
        noteTodos: todosRepository,
      }),
    [blocks, noteId, todosRepository],
  );

  const tasks = useMemo(
    () => taskSource?.tasks ?? createTaskRepository(db),
    [taskSource],
  );
  const listsSource = useMemo(
    () => taskSource?.lists ?? createListRepository(db),
    [taskSource],
  );
  const linkService = useMemo(
    () =>
      createTodoTaskLinkService({
        tasks,
        lists: listsSource,
        noteTodos: todosRepository,
      }),
    [listsSource, tasks, todosRepository],
  );

  const undo = useUndo();
  const rootRef = useRef<HTMLDivElement>(null);
  const noticeSeq = useRef(0);
  const noticeTimer = useRef<number | null>(null);
  const flashTimer = useRef<number | null>(null);

  const [todos, setTodos] = useState<NoteTodo[]>([]);
  const [taskStates, setTaskStates] = useState<Map<string, TodoTaskState>>(
    () => new Map(),
  );
  const [choices, setChoices] = useState<TodoTaskChoice[]>([]);
  const [lists, setLists] = useState<List[]>([]);
  const [dialogTodoId, setDialogTodoId] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [remountKey, setRemountKey] = useState(0);

  const showNotice = useCallback(
    (message: string, tone: 'ok' | 'error' = 'ok') => {
      noticeSeq.current += 1;
      setNotice({ id: noticeSeq.current, message, tone });
      if (noticeTimer.current !== null) {
        window.clearTimeout(noticeTimer.current);
      }
      noticeTimer.current = window.setTimeout(() => {
        noticeTimer.current = null;
        setNotice(null);
      }, 3200);
    },
    [],
  );

  const handleEditorError = useCallback(
    (reason: Error) => {
      if (onEditorError) {
        onEditorError(reason);
        return;
      }
      showNotice(sourceError(reason), 'error');
    },
    [onEditorError, showNotice],
  );

  useEffect(() => {
    return () => {
      if (noticeTimer.current !== null) {
        window.clearTimeout(noticeTimer.current);
      }
      if (flashTimer.current !== null) {
        window.clearTimeout(flashTimer.current);
      }
    };
  }, []);

  // 知识页在阅读模式/回收站会传受控只读；汇总只展示，不再提供写操作。
  const readOnly = Boolean(
    editorProps?.readOnly ?? editorProps?.initialReadOnly ?? false,
  );

  // 待办变化：汇总立即刷新。
  useEffect(() => {
    setTodos([]);
    setTaskStates(new Map());
    setDialogTodoId(null);
    return source.subscribe((rows) => {
      setTodos(rows);
    });
  }, [source]);

  // 关联任务状态独立读取；不参与待办计数。
  // 只在关联 id 集合变化时重读，避免每次正文输入保存都打一次任务查询。
  const linkedTaskIds = useMemo(
    () =>
      [...new Set(
        todos
          .map((todo) => todo.taskId)
          .filter((taskId): taskId is string => Boolean(taskId)),
      )].sort(),
    [todos],
  );
  const linkedTaskKey = linkedTaskIds.join('|');

  useEffect(() => {
    if (!linkedTaskKey) {
      setTaskStates(new Map());
      return;
    }
    let cancelled = false;
    linkService
      .resolveMany(linkedTaskKey.split('|'))
      .then((map) => {
        if (!cancelled) {
          setTaskStates(map);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          showNotice(sourceError(reason), 'error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [linkService, linkedTaskKey, showNotice]);

  const refreshTaskStates = useCallback(async () => {
    const ids = todos
      .map((todo) => todo.taskId)
      .filter((taskId): taskId is string => Boolean(taskId));
    if (ids.length === 0) {
      setTaskStates(new Map());
      return;
    }
    const map = await linkService.resolveMany(ids);
    setTaskStates(map);
  }, [linkService, todos]);

  const refreshTodos = useCallback(async () => {
    const rows = await source.emitTodos();
    setTodos(rows);
    return rows;
  }, [source]);

  const handleToggle = useCallback(
    async (todoId: string) => {
      const todo = todos.find((item) => item.id === todoId);
      if (!todo || busy) {
        return;
      }
      const blockId = source.todoBlocks().get(todoId);
      const row = blockId
        ? rootRef.current?.querySelector<HTMLElement>(
            `[data-block-id="${attributeValue(blockId)}"]`,
          )
        : null;
      const checkbox = row?.querySelector<HTMLButtonElement>(
        'button[role="checkbox"]',
      );
      if (checkbox) {
        // 走编辑器自身的块状态与保存链路，保证正文与汇总同步。
        checkbox.click();
        return;
      }

      setBusy(true);
      try {
        await source.toggleTodo(todoId, !todo.done);
        await refreshTodos();
      } catch (reason) {
        showNotice(sourceError(reason), 'error');
      } finally {
        setBusy(false);
      }
    },
    [busy, refreshTodos, showNotice, source, todos],
  );

  const handleLocate = useCallback(
    async (todoId: string) => {
      let blockId = source.todoBlocks().get(todoId);
      if (!blockId) {
        await refreshTodos();
        blockId = source.todoBlocks().get(todoId);
      }
      const row = blockId
        ? rootRef.current?.querySelector<HTMLElement>(
            `[data-block-id="${attributeValue(blockId)}"]`,
          )
        : null;
      if (!row) {
        showNotice('没有找到正文位置，待办可能刚被删除', 'error');
        return;
      }
      row.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      row.classList.remove('zxt-locate-flash');
      // 允许连续点击同一行时重新触发动画。
      void row.offsetWidth;
      row.classList.add('zxt-locate-flash');
      if (flashTimer.current !== null) {
        window.clearTimeout(flashTimer.current);
      }
      flashTimer.current = window.setTimeout(() => {
        flashTimer.current = null;
        row.classList.remove('zxt-locate-flash');
      }, 1400);
    },
    [refreshTodos, showNotice, source],
  );

  const handleAdd = useCallback(async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await source.addTodoBlock();
      setRemountKey((key) => key + 1);
      await refreshTodos();
      showNotice('已添加笔记待办');
    } catch (reason) {
      showNotice(sourceError(reason), 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, refreshTodos, showNotice, source]);

  const handleDelete = useCallback(
    async (todoId: string) => {
      if (busy) {
        return;
      }
      setBusy(true);
      let snapshot: DeletedTodoSnapshot | null = null;
      try {
        snapshot = await source.deleteTodo(todoId);
        setRemountKey((key) => key + 1);
        await refreshTodos();
        showNotice(
          snapshot.todo.taskId
            ? '已删除笔记待办，关联任务保留'
            : '已删除笔记待办',
        );
      } catch (reason) {
        showNotice(sourceError(reason), 'error');
        setBusy(false);
        return;
      }
      setBusy(false);

      const deleted = snapshot;
      if (!deleted) {
        return;
      }
      undo.schedule({
        message: deleted.todo.taskId
          ? '已删除笔记待办，关联任务保留'
          : '已删除笔记待办',
        undoLabel: '撤销',
        onUndo: async () => {
          const restored = await source.restoreTodo(deleted);
          setRemountKey((key) => key + 1);
          await refreshTodos();
          void restored;
          showNotice('已恢复待办、正文与关联');
        },
        onUndoError: (reason) => {
          showNotice(sourceError(reason), 'error');
        },
      });
    },
    [busy, refreshTodos, showNotice, source, undo],
  );

  const handleOpenLink = useCallback(
    async (todoId: string) => {
      setDialogTodoId(todoId);
      setDialogError(null);
      setBusy(true);
      try {
        const [nextChoices, nextLists, nextStates] = await Promise.all([
          linkService.listChoices(),
          listsSource.list(),
          linkService.resolveMany(
            todos
              .map((todo) => todo.taskId)
              .filter((taskId): taskId is string => Boolean(taskId)),
          ),
        ]);
        setChoices(nextChoices);
        setLists(nextLists.filter((list) => list.deletedAt === null));
        setTaskStates(nextStates);
      } catch (reason) {
        setDialogError(sourceError(reason));
      } finally {
        setBusy(false);
      }
    },
    [linkService, listsSource, todos],
  );

  const dialogTodo = dialogTodoId
    ? todos.find((todo) => todo.id === dialogTodoId) ?? null
    : null;
  const dialogTaskState = dialogTodo?.taskId
    ? taskStates.get(dialogTodo.taskId) ?? null
    : null;

  const replaceTodo = useCallback((next: NoteTodo) => {
    setTodos((current) =>
      current.map((todo) => (todo.id === next.id ? next : todo)),
    );
  }, []);

  const handleLink = useCallback(
    async (taskId: string) => {
      if (!dialogTodo) {
        return;
      }
      setBusy(true);
      setDialogError(null);
      try {
        const updated = await linkService.link(dialogTodo, taskId);
        replaceTodo(updated);
        setTaskStates(await linkService.resolveMany([updated.taskId ?? '']));
        setDialogTodoId(null);
        showNotice('已关联任务；两边状态独立');
      } catch (reason) {
        setDialogError(sourceError(reason));
      } finally {
        setBusy(false);
      }
    },
    [dialogTodo, linkService, replaceTodo, showNotice],
  );

  const handleCreateTask = useCallback(
    async (input: { title: string; listId: string }) => {
      if (!dialogTodo) {
        return;
      }
      setBusy(true);
      setDialogError(null);
      try {
        const result = await linkService.createTask(dialogTodo, input);
        replaceTodo(result.todo);
        setTaskStates(await linkService.resolveMany([result.task.id]));
        setDialogTodoId(null);
        showNotice('已新建全局任务并关联');
      } catch (reason) {
        setDialogError(sourceError(reason));
      } finally {
        setBusy(false);
      }
    },
    [dialogTodo, linkService, replaceTodo, showNotice],
  );

  const handleUnlink = useCallback(async () => {
    if (!dialogTodo) {
      return;
    }
    setBusy(true);
    setDialogError(null);
    try {
      const updated = await linkService.unlink(dialogTodo);
      replaceTodo(updated);
      setDialogTodoId(null);
      showNotice('已解除关联；任务与待办都保留');
    } catch (reason) {
      setDialogError(sourceError(reason));
    } finally {
      setBusy(false);
    }
  }, [dialogTodo, linkService, replaceTodo, showNotice]);

  const dialogErrorMerged =
    dialogError ??
    (dialogTaskState && linkedTaskIsDeleted(dialogTaskState)
      ? '关联任务已删除，可解除关联后重新选择。'
      : null);

  return (
    <div
      ref={rootRef}
      className={className ? `zxt-workspace ${className}` : 'zxt-workspace'}
    >
      <NoteBlockEditor
        key={remountKey}
        {...editorProps}
        noteId={noteId}
        source={source}
        saveDelayMs={saveDelayMs}
        onError={handleEditorError}
      />
      <TodoSummary
        todos={todos}
        taskStates={taskStates}
        busy={busy}
        readOnly={readOnly}
        onToggle={(todoId) => void handleToggle(todoId)}
        onLocate={(todoId) => void handleLocate(todoId)}
        onOpenLink={(todoId) => void handleOpenLink(todoId)}
        onDelete={(todoId) => void handleDelete(todoId)}
        onAdd={() => void handleAdd()}
        onRefresh={() => void refreshTaskStates()}
      />
      <TodoLinkDialog
        open={Boolean(dialogTodo)}
        todo={dialogTodo}
        taskState={dialogTaskState}
        choices={choices}
        lists={lists}
        busy={busy}
        error={dialogErrorMerged}
        onClose={() => {
          setDialogTodoId(null);
          setDialogError(null);
        }}
        onLink={(taskId) => void handleLink(taskId)}
        onCreate={(input) => void handleCreateTask(input)}
        onUnlink={() => void handleUnlink()}
      />
      {notice ? (
        <div
          className={
            notice.tone === 'error'
              ? 'zxt-notice is-error'
              : 'zxt-notice'
          }
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          {notice.message}
        </div>
      ) : null}
    </div>
  );
}
