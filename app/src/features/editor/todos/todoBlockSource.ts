/**
 * 正文待办块 ↔ note_todos 的一致性适配层（P1-03）。
 *
 * P1-02 的块编辑器把待办当成一个带 `payload.checked` 的普通块；本模块在
 * 块仓储外面套一层，把每个 `type === 'todo'` 的块与一条 `note_todos`
 * 记录绑定：
 *
 * - 加载时补齐/认领双向缺失的数据（旧块没有 todoId、todo 没有正文块）；
 * - 保存时用块内文字/勾选更新 note_todos，用 todo id 回填块 payload；
 * - 正文删除/转换成其他块时，对应 note_todo 软删除，保证“正文删除一致性”；
 * - 汇总面板删除待办时同时软删除正文块，撤销时以新 id 重建正文块与待办，
 *   并保留原 task_id 关联；
 * - `note_todos.done` 与 `tasks.status` 没有任何镜像代码。
 *
 * 所有写操作串行执行，避免编辑器卸载时的保存、删除、撤销互相覆盖。
 */

import type { JsonValue, NoteTodo } from '../../../data/db/types';
import type {
  BlockDraft,
  BlockPayload,
  BlockRepository,
  EditorBlock,
} from '../../../data/repositories/blocks';
import {
  NOTE_TODO_FALLBACK_TITLE,
  normalizeNoteTodoTitle,
  noteTodoSnapshot,
  sortNoteTodos,
  type NoteTodoRepository,
} from '../../../data/repositories/noteTodos';
import { runsToPlainText } from '../inline';
import { payloadRuns } from '../types';

const ORDER_STEP = 1024;

export type DeletedTodoSnapshot = {
  todo: NoteTodo;
  block: EditorBlock | null;
};

export type RestoredTodo = {
  todo: NoteTodo;
  block: EditorBlock;
};

export type NoteTodoBlockSource = BlockRepository & {
  listTodos: (includeDeleted?: boolean) => Promise<NoteTodo[]>;
  /** 当前 todoId → 正文 blockId 的映射，供定位使用。 */
  todoBlocks: () => ReadonlyMap<string, string>;
  addTodoBlock: (title?: string) => Promise<RestoredTodo>;
  deleteTodo: (todoId: string) => Promise<DeletedTodoSnapshot>;
  restoreTodo: (snapshot: DeletedTodoSnapshot) => Promise<RestoredTodo>;
  /**
   * 直接切换待办完成状态（汇总在找不到正文 checkbox 时的兜底）。
   * 正常路径是点击正文 checkbox，由 saveDocument 同步。
   */
  toggleTodo: (todoId: string, done: boolean) => Promise<NoteTodo>;
  /** 监听 note_todos 变化；编辑器的防抖保存完成后会触发。 */
  subscribe: (listener: (todos: NoteTodo[]) => void) => () => void;
  emitTodos: () => Promise<NoteTodo[]>;
  /**
   * 撤销/重做恢复正文快照前调用：解除“已删除”抑制，并用墓碑行恢复
   * note_todo（保留 taskId 关联），把快照里的旧 todoId 映射到新 id。
   */
  prepareHistoryRestore: (
    blocks: ReadonlyArray<EditorBlock>,
  ) => Promise<EditorBlock[]>;
};

export type NoteTodoBlockSourceOptions = {
  noteId: string;
  blocks: BlockRepository;
  noteTodos: NoteTodoRepository;
};

function payloadTodoId(payload: BlockPayload): string | null {
  const value = payload.todoId;
  return typeof value === 'string' && value.trim() ? value : null;
}

function payloadTitle(payload: BlockPayload): string {
  return runsToPlainText(payloadRuns(payload)).replace(/\s+/g, ' ').trim();
}

function payloadDone(payload: BlockPayload): boolean {
  return payload.checked === true;
}

function todoBlockPayload(
  todoId: string,
  title: string,
  done: boolean,
): BlockPayload {
  const clean = title.trim();
  return {
    runs: clean ? [{ text: clean }] : [],
    checked: done,
    todoId,
  };
}

function nextOrderKey(blocks: ReadonlyArray<EditorBlock>): number {
  const max = blocks.reduce(
    (current, block) => Math.max(current, block.orderKey),
    0,
  );
  return max + ORDER_STEP;
}

function findTodoBlock(
  blocks: ReadonlyArray<EditorBlock>,
  todoId: string,
): EditorBlock | null {
  return (
    blocks.find(
      (block) =>
        block.type === 'todo' && payloadTodoId(block.payload) === todoId,
    ) ?? null
  );
}

function unchanged(
  current: EditorBlock,
  draft: BlockDraft,
  orderKey: number,
): boolean {
  return (
    current.type === draft.type &&
    current.orderKey === orderKey &&
    current.schemaVersion === (draft.schemaVersion ?? current.schemaVersion) &&
    JSON.stringify(current.payload) === JSON.stringify(draft.payload)
  );
}

export function createNoteTodoBlockSource({
  noteId,
  blocks: blockRepository,
  noteTodos,
}: NoteTodoBlockSourceOptions): NoteTodoBlockSource {
  let queue: Promise<unknown> = Promise.resolve();
  let knownBlockIds = new Set<string>();
  let todoBlockMap = new Map<string, string>();
  let suppressedBlockIds = new Set<string>();
  let suppressedTodoIds = new Set<string>();
  let lastTodos: NoteTodo[] = [];
  const listeners = new Set<(todos: NoteTodo[]) => void>();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const notify = async (todos?: NoteTodo[]): Promise<NoteTodo[]> => {
    const rows = sortNoteTodos(todos ?? (await noteTodos.list(noteId)));
    lastTodos = rows;
    for (const listener of listeners) {
      listener(rows);
    }
    return rows;
  };

  const rememberMaps = (
    blocks: ReadonlyArray<EditorBlock>,
    todos: ReadonlyArray<NoteTodo>,
  ) => {
    const todoIds = new Set(todos.map((todo) => todo.id));
    const nextMap = new Map<string, string>();
    for (const block of blocks) {
      if (block.type !== 'todo' || suppressedBlockIds.has(block.id)) {
        continue;
      }
      const todoId = payloadTodoId(block.payload);
      if (todoId && todoIds.has(todoId)) {
        nextMap.set(todoId, block.id);
      }
    }
    todoBlockMap = nextMap;
    knownBlockIds = new Set(
      blocks
        .filter((block) => !suppressedBlockIds.has(block.id))
        .map((block) => block.id),
    );
  };

  /**
   * 双向补齐：旧正文待办块绑定 note_todo，缺失的正文块按 todo 内容补出来。
   * 正文块有文字时以正文为准；正文为空时用 todo 标题回填正文。
   */
  const reconcile = async (): Promise<{
    blocks: EditorBlock[];
    todos: NoteTodo[];
  }> => {
    let rows = sortNoteTodos(await noteTodos.list(noteId));
    let allBlocks = (await blockRepository.list(noteId)).filter(
      (block) => !suppressedBlockIds.has(block.id),
    );
    const byId = new Map(rows.map((todo) => [todo.id, todo]));
    const matchedTodoIds = new Set<string>();
    const unlinkedBlocks: EditorBlock[] = [];

    for (const block of allBlocks) {
      if (block.type !== 'todo') {
        continue;
      }
      const todoId = payloadTodoId(block.payload);
      if (todoId && byId.has(todoId) && !matchedTodoIds.has(todoId)) {
        matchedTodoIds.add(todoId);
      } else {
        unlinkedBlocks.push(block);
      }
    }

    const orphanTodos = rows.filter((todo) => !matchedTodoIds.has(todo.id));
    const paired = Math.min(orphanTodos.length, unlinkedBlocks.length);

    for (let index = 0; index < paired; index += 1) {
      const todo = orphanTodos[index];
      const block = unlinkedBlocks[index];
      const inlineTitle = payloadTitle(block.payload);
      let nextTodo = todo;
      let title = todo.title;
      let done = todo.done;

      if (inlineTitle) {
        title = normalizeNoteTodoTitle(inlineTitle);
        done = payloadDone(block.payload);
        if (todo.title !== title || todo.done !== done) {
          nextTodo = await noteTodos.patch(todo, { title, done });
        }
      } else {
        title = normalizeNoteTodoTitle(todo.title);
        done = todo.done;
      }

      const updated = await blockRepository.update(block.id, {
        blockType: 'todo',
        orderKey: block.orderKey,
        payload: todoBlockPayload(nextTodo.id, title, done),
        schemaVersion: block.schemaVersion,
      });
      byId.set(nextTodo.id, nextTodo);
      matchedTodoIds.add(nextTodo.id);
      allBlocks = allBlocks.map((item) =>
        item.id === updated.id ? updated : item,
      );
    }

    // 剩下的待办没有正文块：补出正文块，保证内联与汇总都能定位。
    for (const todo of orphanTodos.slice(paired)) {
      const created = await blockRepository.create({
        noteId,
        blockType: 'todo',
        orderKey: nextOrderKey(allBlocks),
        payload: todoBlockPayload(todo.id, todo.title, todo.done),
        schemaVersion: 1,
      });
      allBlocks = [...allBlocks, created];
      matchedTodoIds.add(todo.id);
    }

    // 剩下的正文待办块没有 todo：创建 note_todo，完成双向绑定。
    for (const block of unlinkedBlocks.slice(paired)) {
      const title = normalizeNoteTodoTitle(payloadTitle(block.payload));
      const done = payloadDone(block.payload);
      const created = await noteTodos.create({
        noteId,
        title,
        done,
        sortOrder: rows.length,
      });
      const updated = await blockRepository.update(block.id, {
        blockType: 'todo',
        orderKey: block.orderKey,
        payload: todoBlockPayload(created.id, title, done),
        schemaVersion: block.schemaVersion,
      });
      rows = [...rows, created];
      byId.set(created.id, created);
      matchedTodoIds.add(created.id);
      allBlocks = allBlocks.map((item) =>
        item.id === updated.id ? updated : item,
      );
    }

    rows = sortNoteTodos(await noteTodos.list(noteId));
    rememberMaps(allBlocks, rows);
    return { blocks: allBlocks, todos: rows };
  };

  const syncTodosFromDrafts = async (
    drafts: ReadonlyArray<BlockDraft>,
  ): Promise<{
    drafts: BlockDraft[];
    todos: NoteTodo[];
  }> => {
    const existing = sortNoteTodos(await noteTodos.list(noteId));
    const todoById = new Map(existing.map((todo) => [todo.id, todo]));
    const usedTodoIds = new Set<string>();
    const nextDrafts: BlockDraft[] = [];

    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index];
      const orderKey = (index + 1) * ORDER_STEP;
      let payload: BlockPayload = { ...draft.payload };
      let todoId = payloadTodoId(payload);

      // 已从汇总删除的待办，其正文块即使被旧快照带回来也不再复活。
      if (todoId && suppressedTodoIds.has(todoId)) {
        continue;
      }

      if (draft.type === 'todo') {
        const title = normalizeNoteTodoTitle(payloadTitle(payload));
        const done = payloadDone(payload);
        const current = todoId ? todoById.get(todoId) : undefined;

        if (current) {
          usedTodoIds.add(current.id);
          if (current.title !== title || current.done !== done) {
            const updated = await noteTodos.patch(current, { title, done });
            todoById.set(updated.id, updated);
          }
          if (payload.todoId !== current.id) {
            payload = { ...payload, todoId: current.id };
          }
        } else {
          const created = await noteTodos.create({
            noteId,
            title,
            done,
            sortOrder: index,
          });
          todoById.set(created.id, created);
          usedTodoIds.add(created.id);
          payload = { ...payload, todoId: created.id };
        }
      } else if (todoId) {
        // 待办块被转换成其他块：去掉残留引用，待办在下方统一软删除。
        payload = { ...payload };
        delete payload.todoId;
      }

      nextDrafts.push({
        ...draft,
        orderKey,
        payload,
        schemaVersion: draft.schemaVersion ?? 1,
      });
    }

    // 之前有正文块、这次快照里没有（正文删除/转换）→ 待办随之软删除。
    for (const todoId of todoBlockMap.keys()) {
      if (usedTodoIds.has(todoId) || suppressedTodoIds.has(todoId)) {
        continue;
      }
      const todo = todoById.get(todoId);
      if (!todo) {
        continue;
      }
      suppressedTodoIds.add(todoId);
      await noteTodos.remove(todoId);
      todoById.delete(todoId);
    }

    return {
      drafts: nextDrafts,
      todos: sortNoteTodos([...todoById.values()]),
    };
  };

  const applyBlockDiff = async (
    drafts: ReadonlyArray<BlockDraft>,
  ): Promise<EditorBlock[]> => {
    const current = await blockRepository.list(noteId);
    const currentById = new Map(current.map((block) => [block.id, block]));
    const draftIds = new Set(drafts.map((draft) => draft.id));

    for (const draft of drafts) {
      const orderKey = draft.orderKey ?? 0;
      const existing = currentById.get(draft.id);
      if (!existing) {
        await blockRepository.create({
          id: draft.id,
          noteId,
          blockType: draft.type,
          orderKey,
          payload: draft.payload,
          schemaVersion: draft.schemaVersion ?? 1,
        });
        continue;
      }
      if (!unchanged(existing, draft, orderKey)) {
        await blockRepository.update(existing.id, {
          blockType: draft.type,
          orderKey,
          payload: draft.payload,
          schemaVersion: draft.schemaVersion ?? existing.schemaVersion,
        });
      }
    }

    // 只删除“本编辑器加载过、这次快照里消失”的块。外部新增的块（例如
    // 汇总面板刚补出的待办正文）不在 known 里，不能被旧快照误删。
    for (const block of current) {
      if (knownBlockIds.has(block.id) && !draftIds.has(block.id)) {
        await blockRepository.remove(block.id);
      }
    }

    return blockRepository.list(noteId);
  };

  const source: NoteTodoBlockSource = {
    async list(targetNoteId, includeDeleted = false) {
      if (targetNoteId !== noteId || includeDeleted) {
        return blockRepository.list(targetNoteId, includeDeleted);
      }
      return enqueue(async () => {
        const result = await reconcile();
        await notify(result.todos);
        return result.blocks;
      });
    },

    async create(input) {
      return enqueue(() => blockRepository.create(input));
    },

    async update(id, input) {
      return enqueue(() => blockRepository.update(id, input));
    },

    async remove(id) {
      return enqueue(async () => {
        const block = (await blockRepository.list(noteId)).find(
          (item) => item.id === id,
        );
        const todoId = block ? payloadTodoId(block.payload) : null;
        await blockRepository.remove(id);
        if (todoId) {
          suppressedTodoIds.add(todoId);
          suppressedBlockIds.add(id);
          todoBlockMap.delete(todoId);
          knownBlockIds.delete(id);
          await noteTodos.remove(todoId);
          await notify();
        }
      });
    },

    loadDocument: (targetNoteId) =>
      enqueue(() => blockRepository.loadDocument(targetNoteId)),

    async saveDocument(targetNoteId, drafts) {
      if (targetNoteId !== noteId) {
        return blockRepository.saveDocument(targetNoteId, drafts);
      }
      return enqueue(async () => {
        const incoming = drafts.filter(
          (draft) => !suppressedBlockIds.has(draft.id),
        );
        const synced = await syncTodosFromDrafts(incoming);
        const saved = await applyBlockDiff(synced.drafts);
        const todos = await notify(synced.todos);
        rememberMaps(saved, todos);
        return saved;
      });
    },

    exportDocument: (targetNoteId) =>
      blockRepository.exportDocument(targetNoteId),

    async importDocument(targetNoteId, json) {
      return enqueue(async () => {
        const saved = await blockRepository.importDocument(targetNoteId, json);
        if (targetNoteId !== noteId) {
          return saved;
        }
        const result = await reconcile();
        await notify(result.todos);
        return result.blocks;
      });
    },

    listTodos: (includeDeleted = false) =>
      noteTodos.list(noteId, includeDeleted),

    todoBlocks: () => new Map(todoBlockMap),

    async addTodoBlock(title = '') {
      return enqueue(async () => {
        const clean = title.replace(/\s+/g, ' ').trim();
        const created = await noteTodos.create({
          noteId,
          title: clean ? clean : NOTE_TODO_FALLBACK_TITLE,
          done: false,
          sortOrder: lastTodos.length,
        });
        try {
          const current = await blockRepository.list(noteId);
          const block = await blockRepository.create({
            noteId,
            blockType: 'todo',
            orderKey: nextOrderKey(current),
            payload: todoBlockPayload(created.id, clean, false),
            schemaVersion: 1,
          });
          await notify();
          return { todo: created, block };
        } catch (reason) {
          await noteTodos.remove(created.id).catch(() => undefined);
          throw reason;
        }
      });
    },

    async deleteTodo(todoId) {
      return enqueue(async () => {
        const todos = sortNoteTodos(await noteTodos.list(noteId));
        const todo = todos.find((item) => item.id === todoId);
        if (!todo) {
          throw new Error('待办已不存在，无法删除');
        }
        const current = await blockRepository.list(noteId);
        const block = findTodoBlock(current, todoId);

        suppressedTodoIds.add(todoId);
        if (block) {
          suppressedBlockIds.add(block.id);
          todoBlockMap.delete(todoId);
          knownBlockIds.delete(block.id);
          await blockRepository.remove(block.id);
        }
        await noteTodos.remove(todoId);
        await notify();
        return {
          todo: { ...todo },
          block: block ? { ...block } : null,
        };
      });
    },

    async restoreTodo(snapshot) {
      return enqueue(async () => {
        const todo = await noteTodos.restore({
          noteId: snapshot.todo.noteId,
          taskId: snapshot.todo.taskId,
          title: snapshot.todo.title,
          done: snapshot.todo.done,
          dueDate: snapshot.todo.dueDate,
          reminderEnabled: snapshot.todo.reminderEnabled,
          sortOrder: snapshot.todo.sortOrder,
        });
        const current = await blockRepository.list(noteId);
        const block = await blockRepository.create({
          noteId,
          blockType: 'todo',
          orderKey: nextOrderKey(current),
          payload: todoBlockPayload(todo.id, todo.title, todo.done),
          schemaVersion: 1,
        });
        await notify();
        return { todo, block };
      });
    },

    async toggleTodo(todoId, done) {
      return enqueue(async () => {
        const todos = sortNoteTodos(await noteTodos.list(noteId));
        const todo = todos.find((item) => item.id === todoId);
        if (!todo) {
          throw new Error('待办已不存在');
        }
        const updated = await noteTodos.patch(todo, { done });
        const current = await blockRepository.list(noteId);
        const block = findTodoBlock(current, todoId);
        if (block) {
          await blockRepository.update(block.id, {
            blockType: 'todo',
            orderKey: block.orderKey,
            payload: { ...block.payload, checked: done } as Record<
              string,
              JsonValue
            >,
            schemaVersion: block.schemaVersion,
          });
        }
        await notify();
        return updated;
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      if (lastTodos.length > 0) {
        listener(lastTodos);
      }
      return () => {
        listeners.delete(listener);
      };
    },

    emitTodos: () => notify(),

    async prepareHistoryRestore(blocks) {
      return enqueue(async () => {
        const suppressed = blocks.filter((block) => {
          if (block.type !== 'todo') {
            return false;
          }
          const todoId = payloadTodoId(block.payload);
          return Boolean(
            todoId &&
              (suppressedTodoIds.has(todoId) ||
                suppressedBlockIds.has(block.id)),
          );
        });
        if (suppressed.length === 0) {
          return [...blocks];
        }

        const allTodos = await noteTodos.list(noteId, true);
        const byId = new Map(allTodos.map((todo) => [todo.id, todo]));
        const remapped = new Map<string, string>();
        for (const block of suppressed) {
          const todoId = payloadTodoId(block.payload);
          if (!todoId) {
            continue;
          }
          // 撤销是用户明确动作，解除删除抑制；重做删除时由新的 save 快照决定。
          suppressedTodoIds.delete(todoId);
          suppressedBlockIds.delete(block.id);
          todoBlockMap.delete(todoId);
          const tombstone = byId.get(todoId);
          if (tombstone?.deletedAt) {
            const restored = await noteTodos.restore(
              noteTodoSnapshot(tombstone),
            );
            remapped.set(todoId, restored.id);
            byId.set(restored.id, restored);
          }
        }
        await notify();
        if (remapped.size === 0) {
          return [...blocks];
        }
        return blocks.map((block) => {
          if (block.type !== 'todo') {
            return block;
          }
          const oldId = payloadTodoId(block.payload);
          const newId = oldId ? remapped.get(oldId) : undefined;
          return newId
            ? { ...block, payload: { ...block.payload, todoId: newId } }
            : block;
        });
      });
    },
  };

  return source;
}
