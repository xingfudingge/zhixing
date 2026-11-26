/**
 * 恢复写入目标（P2-04）。
 *
 * 生产实现只调用既有 Tauri 仓储命令，不直接拼 SQL；附件二进制写入
 * IndexedDB 内容寻址存储，并同步更新附件状态。恢复按计划顺序逐项写入：
 * 先父后子、先新增后回收站。任一步失败都会停止并返回已应用数量，绝不
 * 把失败当成成功。
 */

import {
  applyAppearance,
  saveAppearance,
} from '../../app/shell/appearance';
import type { DbClient } from '../../data/db/client';
import { createBoardRepository, type SaveBoardInput } from '../../data/repositories/boards';
import type {
  Attachment,
  Countdown,
  Event,
  FocusSession,
  Habit,
  List,
  Note,
  NoteBlock,
  NoteTodo,
  Subtask,
  Task,
} from '../../data/db/types';
import {
  IndexedDbAttachmentStateStore,
  IndexedDbBlobStore,
  isIndexedDbAvailable,
  type AttachmentStateStore,
  type BlobStore,
} from '../attachments/blobStore';
import { defaultState, bytesKey } from '../attachments/types';
import type {
  BoardBackup,
  RestoreOperation,
  RestoreTarget,
} from '../export/types';

export type RestoreTargetOptions = {
  blobStore?: BlobStore;
  stateStore?: AttachmentStateStore;
  now?: () => string;
};

class NullStateStore implements AttachmentStateStore {
  async get(): Promise<null> {
    return null;
  }
  async put(): Promise<void> {}
  async delete(): Promise<void> {}
  async list(): Promise<[]> {
    return [];
  }
  async clear(): Promise<void> {}
}

function defaultBlobStore(): BlobStore {
  return isIndexedDbAvailable()
    ? new IndexedDbBlobStore()
    : new (class {
        async put(): Promise<void> {}
        async get(): Promise<Blob | null> {
          return null;
        }
        async has(): Promise<boolean> {
          return false;
        }
        async delete(): Promise<void> {}
      })();
}

function defaultStateStore(): AttachmentStateStore {
  return isIndexedDbAvailable()
    ? new IndexedDbAttachmentStateStore()
    : new NullStateStore();
}

async function ensureAttachmentState(
  row: Attachment,
  blob: Blob | null,
  blobStore: BlobStore,
  stateStore: AttachmentStateStore,
  now: () => string,
): Promise<void> {
  const key = bytesKey(row.sha256);
  let content = blob;
  if (!content) {
    try {
      content = await blobStore.get(key);
    } catch {
      content = null;
    }
  }
  if (content) {
    // 计划摘要把“含二进制”计为可恢复；写入失败必须让整个恢复停下并报告，
    // 不能把失败静默显示成成功。
    await blobStore.put(key, content);
  }
  if (content) {
    await stateStore.put({
      ...defaultState(row.id, key, now()),
      status: 'local',
      remoteId: null,
      lastError: null,
      downloadedAt: now(),
    });
  } else {
    await stateStore.put({
      ...defaultState(row.id, key, now()),
      status: 'remote',
      remoteId: null,
      lastError: '备份未包含附件二进制，需要重新上传或下载',
    });
  }
}

function boardSaveInput(bundle: BoardBackup): SaveBoardInput {
  return {
    noteId: bundle.board.noteId,
    title: bundle.board.title,
    background: bundle.board.background,
    snapshot: bundle.board.snapshot,
    nodes: bundle.nodes
      .filter((node) => !node.deletedAt)
      .map((node) => ({
        id: node.id,
        type: node.nodeType,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
        zIndex: node.zIndex,
        text: node.text,
        payload: (node.payload ?? {}) as never,
      })),
    edges: bundle.edges
      .filter((edge) => !edge.deletedAt)
      .map((edge) => ({
        id: edge.id,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        label: edge.label,
        style: (edge.style ?? {}) as never,
      })),
  };
}

async function createBoard(
  client: DbClient,
  bundle: BoardBackup,
): Promise<void> {
  await client.boards.create({
    id: bundle.board.id,
    spaceId: bundle.board.spaceId,
    noteId: bundle.board.noteId,
    title: bundle.board.title,
    background: bundle.board.background,
    snapshot: bundle.board.snapshot,
    thumbnailKey: bundle.board.thumbnailKey,
  });
  for (const node of bundle.nodes) {
    await client.boards.nodes.create({
      id: node.id,
      boardId: bundle.board.id,
      nodeType: node.nodeType,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rotation: node.rotation,
      zIndex: node.zIndex,
      text: node.text,
      payload: node.payload,
    });
  }
  for (const edge of bundle.edges) {
    await client.boards.edges.create({
      id: edge.id,
      boardId: bundle.board.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      label: edge.label,
      style: edge.style,
    });
  }
  for (const edge of bundle.edges) {
    if (edge.deletedAt) await client.boards.edges.remove(edge.id);
  }
  for (const node of bundle.nodes) {
    if (node.deletedAt) await client.boards.nodes.remove(node.id);
  }
}

async function updateBoard(
  client: DbClient,
  bundle: BoardBackup,
): Promise<void> {
  const repository = createBoardRepository(client);
  await repository.save(bundle.board.id, boardSaveInput(bundle));
  await client.boards.update(bundle.board.id, {
    noteId: bundle.board.noteId,
    title: bundle.board.title,
    background: bundle.board.background,
    snapshot: bundle.board.snapshot,
    thumbnailKey: bundle.board.thumbnailKey,
  });

  const [currentNodes, currentEdges] = await Promise.all([
    client.boards.nodes.list(bundle.board.id, true),
    client.boards.edges.list(bundle.board.id, true),
  ]);
  const nodeIds = new Set(currentNodes.map((node) => node.id));
  const edgeIds = new Set(currentEdges.map((edge) => edge.id));

  for (const node of bundle.nodes) {
    if (!node.deletedAt || nodeIds.has(node.id)) continue;
    await client.boards.nodes.create({
      id: node.id,
      boardId: bundle.board.id,
      nodeType: node.nodeType,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rotation: node.rotation,
      zIndex: node.zIndex,
      text: node.text,
      payload: node.payload,
    });
    await client.boards.nodes.remove(node.id);
  }
  for (const edge of bundle.edges) {
    if (!edge.deletedAt || edgeIds.has(edge.id)) continue;
    await client.boards.edges.create({
      id: edge.id,
      boardId: bundle.board.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      label: edge.label,
      style: edge.style,
    });
    await client.boards.edges.remove(edge.id);
  }
}

function reviewNoteInput(note: Note) {
  return {
    id: note.id,
    spaceId: note.spaceId,
    title: note.title,
    folderId: note.folderId,
    tags: note.tags,
    body: note.body,
    bodyFormat: note.bodyFormat,
    status: note.status,
    favorite: note.favorite,
    pinned: note.pinned,
  };
}

async function createSimple(
  client: DbClient,
  operation: Extract<RestoreOperation, { type: 'create' }>,
): Promise<void> {
  switch (operation.collection) {
    case 'lists': {
      const row = operation.row as List;
      await client.lists.create({
        id: row.id,
        spaceId: row.spaceId,
        name: row.name,
        color: row.color,
        icon: row.icon,
        parentId: row.parentId,
        sortOrder: row.sortOrder,
        isInbox: row.isInbox,
      });
      return;
    }
    case 'tasks': {
      const row = operation.row as Task;
      await client.tasks.create({
        id: row.id,
        spaceId: row.spaceId,
        listId: row.listId,
        parentId: row.parentId,
        noteId: row.noteId,
        title: row.title,
        notes: row.notes,
        status: row.status,
        priority: row.priority,
        quadrant: row.quadrant,
        dueDate: row.dueDate,
        dueTime: row.dueTime,
        dueAt: row.dueAt,
        tz: row.tz,
        reminder: row.reminder,
        sortOrder: row.sortOrder,
      });
      return;
    }
    case 'subtasks': {
      const row = operation.row as Subtask;
      await client.tasks.subtasks.create({
        id: row.id,
        taskId: row.taskId,
        title: row.title,
        done: row.done,
        sortOrder: row.sortOrder,
      });
      return;
    }
    case 'notes': {
      const row = operation.row as Note;
      await client.notes.create({
        id: row.id,
        spaceId: row.spaceId,
        title: row.title,
        folderId: row.folderId,
        tags: row.tags,
        body: row.body,
        bodyFormat: row.bodyFormat,
        status: row.status,
        favorite: row.favorite,
        pinned: row.pinned,
        ...(row.encrypted
          ? {
              encrypted: true,
              encryptedTagsJson: row.encryptedTagsJson ?? null,
            }
          : {}),
      });
      return;
    }
    case 'noteBlocks': {
      const row = operation.row as NoteBlock;
      await client.notes.blocks.create({
        id: row.id,
        noteId: row.noteId,
        blockType: row.blockType,
        orderKey: row.orderKey,
        payload: row.payload,
        schemaVersion: row.schemaVersion,
        ...(row.encrypted
          ? {
              encrypted: true,
              encryptedPayloadJson: row.encryptedPayloadJson ?? null,
            }
          : {}),
      });
      return;
    }
    case 'noteTodos': {
      const row = operation.row as NoteTodo;
      await client.noteTodos.create({
        id: row.id,
        spaceId: row.spaceId,
        noteId: row.noteId,
        taskId: row.taskId,
        title: row.title,
        done: row.done,
        dueDate: row.dueDate,
        reminderEnabled: row.reminderEnabled,
        sortOrder: row.sortOrder,
        ...(row.encrypted ? { encrypted: true } : {}),
      });
      return;
    }
    case 'events': {
      const row = operation.row as Event;
      await client.events.create({
        id: row.id,
        spaceId: row.spaceId,
        title: row.title,
        eventType: row.eventType,
        allDay: row.allDay,
        startDate: row.startDate,
        startAt: row.startAt,
        endAt: row.endAt,
        tz: row.tz,
        source: row.source,
        externalUid: row.externalUid,
        repeatRule: row.repeatRule,
        calendarType: row.calendarType,
        noteId: row.noteId,
        color: row.color,
      });
      return;
    }
    case 'countdowns': {
      const row = operation.row as Countdown;
      await client.countdowns.create({
        id: row.id,
        spaceId: row.spaceId,
        title: row.title,
        category: row.category,
        calendarType: row.calendarType,
        targetDate: row.targetDate,
        repeatRule: row.repeatRule,
        lunarMonth: row.lunarMonth,
        lunarDay: row.lunarDay,
        note: row.note,
        color: row.color,
      });
      return;
    }
    case 'habits': {
      const row = operation.row as Habit;
      await client.habits.create({
        id: row.id,
        spaceId: row.spaceId,
        title: row.title,
        schedule: row.schedule,
        icon: row.icon,
        color: row.color,
        goalPerWeek: row.goalPerWeek,
        sortOrder: row.sortOrder,
        archived: row.archived,
      });
      return;
    }
    case 'habitLogs': {
      const row = operation.row as import('../../data/db/types').HabitLog;
      await client.habits.logs.set(row.habitId, row.logDate, row.note);
      // 已删除的打卡由计划末尾的统一删除步骤处理，避免重复软删除。
      if (!row.done && !row.deletedAt) {
        await client.habits.logs.remove(row.habitId, row.logDate);
      }
      return;
    }
    case 'focusSessions': {
      const row = operation.row as FocusSession;
      await client.focusSessions.create({
        id: row.id,
        spaceId: row.spaceId,
        taskId: row.taskId,
        minutes: row.minutes,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        mode: row.mode,
        note: row.note,
      });
      return;
    }
  }
}

async function updateSimple(
  client: DbClient,
  operation: Extract<RestoreOperation, { type: 'update' }>,
): Promise<void> {
  switch (operation.collection) {
    case 'lists': {
      const row = operation.row as List;
      await client.lists.update(row.id, {
        name: row.name,
        color: row.color,
        icon: row.icon,
        sortOrder: row.sortOrder,
      });
      return;
    }
    case 'tasks': {
      const row = operation.row as Task;
      try {
        await client.tasks.restore(row.id);
      } catch {
        // 本机对象没有在回收站时 restore 会失败；继续 update。
      }
      await client.tasks.update(row.id, {
        listId: row.listId,
        parentId: row.parentId,
        noteId: row.noteId,
        title: row.title,
        notes: row.notes,
        status: row.status,
        priority: row.priority,
        quadrant: row.quadrant,
        dueDate: row.dueDate,
        dueTime: row.dueTime,
        dueAt: row.dueAt,
        tz: row.tz,
        reminder: row.reminder,
        sortOrder: row.sortOrder,
      });
      return;
    }
    case 'subtasks': {
      const row = operation.row as Subtask;
      await client.tasks.subtasks.update(row.id, {
        title: row.title,
        done: row.done,
        sortOrder: row.sortOrder,
      });
      return;
    }
    case 'notes': {
      const row = operation.row as Note;
      try {
        await client.notes.restore(row.id);
      } catch {
        // 同上。
      }
      await client.notes.update(row.id, {
        title: row.title,
        folderId: row.folderId,
        tags: row.tags,
        body: row.body,
        bodyFormat: row.bodyFormat,
        favorite: row.favorite,
        pinned: row.pinned,
        ...(row.encrypted
          ? {
              encrypted: true,
              encryptedTagsJson: row.encryptedTagsJson ?? null,
            }
          : {}),
      });
      return;
    }
    case 'noteBlocks': {
      const row = operation.row as NoteBlock;
      await client.notes.blocks.update(row.id, {
        blockType: row.blockType,
        orderKey: row.orderKey,
        payload: row.payload,
        schemaVersion: row.schemaVersion,
        ...(row.encrypted
          ? {
              encrypted: true,
              encryptedPayloadJson: row.encryptedPayloadJson ?? null,
            }
          : {}),
      });
      return;
    }
    case 'noteTodos': {
      const row = operation.row as NoteTodo;
      await client.noteTodos.update(row.id, {
        taskId: row.taskId,
        title: row.title,
        done: row.done,
        dueDate: row.dueDate,
        reminderEnabled: row.reminderEnabled,
        sortOrder: row.sortOrder,
        ...(row.encrypted ? { encrypted: true } : {}),
      });
      return;
    }
    case 'events': {
      const row = operation.row as Event;
      await client.events.update(row.id, {
        title: row.title,
        eventType: row.eventType,
        allDay: row.allDay,
        startDate: row.startDate,
        startAt: row.startAt,
        endAt: row.endAt,
        tz: row.tz,
        source: row.source,
        externalUid: row.externalUid,
        repeatRule: row.repeatRule,
        calendarType: row.calendarType,
        noteId: row.noteId,
        color: row.color,
      });
      return;
    }
    case 'countdowns': {
      const row = operation.row as Countdown;
      await client.countdowns.update(row.id, {
        title: row.title,
        category: row.category,
        calendarType: row.calendarType,
        targetDate: row.targetDate,
        repeatRule: row.repeatRule,
        lunarMonth: row.lunarMonth,
        lunarDay: row.lunarDay,
        note: row.note,
        color: row.color,
      });
      return;
    }
    case 'habits': {
      const row = operation.row as Habit;
      await client.habits.update(row.id, {
        title: row.title,
        schedule: row.schedule,
        icon: row.icon,
        color: row.color,
        goalPerWeek: row.goalPerWeek,
        sortOrder: row.sortOrder,
        archived: row.archived,
      });
      return;
    }
    case 'habitLogs': {
      const row = operation.row as import('../../data/db/types').HabitLog;
      await client.habits.logs.set(row.habitId, row.logDate, row.note);
      if (!row.done) {
        await client.habits.logs.remove(row.habitId, row.logDate);
      }
      return;
    }
    case 'focusSessions': {
      const row = operation.row as FocusSession;
      await client.focusSessions.update(row.id, {
        taskId: row.taskId,
        minutes: row.minutes,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        mode: row.mode,
        note: row.note,
      });
      return;
    }
  }
}

async function deleteSimple(
  client: DbClient,
  collection: string,
  id: string,
): Promise<void> {
  switch (collection) {
    case 'lists':
      await client.lists.remove(id);
      return;
    case 'tasks':
      await client.tasks.remove(id);
      return;
    case 'subtasks':
      await client.tasks.subtasks.remove(id);
      return;
    case 'notes':
      await client.notes.remove(id);
      return;
    case 'noteBlocks':
      await client.notes.blocks.remove(id);
      return;
    case 'noteTodos':
      await client.noteTodos.remove(id);
      return;
    case 'events':
      await client.events.remove(id);
      return;
    case 'countdowns':
      await client.countdowns.remove(id);
      return;
    case 'habits':
      await client.habits.remove(id);
      return;
    case 'focusSessions':
      await client.focusSessions.remove(id);
      return;
    case 'boards':
      await client.boards.remove(id);
      return;
    case 'attachments':
      await client.attachments.remove(id);
      return;
    default:
      throw new Error(`不支持删除集合：${collection}`);
  }
}

export function createDbRestoreTarget(
  client: DbClient,
  options: RestoreTargetOptions = {},
): RestoreTarget {
  const blobStore = options.blobStore ?? defaultBlobStore();
  const stateStore = options.stateStore ?? defaultStateStore();
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async apply(operation: RestoreOperation): Promise<void> {
      switch (operation.type) {
        case 'create':
          await createSimple(client, operation);
          return;
        case 'update':
          await updateSimple(client, operation);
          return;
        case 'delete':
          await deleteSimple(client, operation.collection, operation.id);
          return;
        case 'habit-log-delete':
          await client.habits.logs.remove(operation.habitId, operation.logDate);
          return;
        case 'board':
          if (operation.mode === 'create') {
            await createBoard(client, operation.row);
          } else {
            await updateBoard(client, operation.row);
          }
          return;
        case 'review':
          await client.reviewSnapshots.save({
            id: operation.row.id,
            spaceId: operation.row.spaceId,
            rangeStart: operation.row.rangeStart,
            rangeEnd: operation.row.rangeEnd,
            taskIds: operation.row.taskIds,
            focusIds: operation.row.focusIds,
            habitIds: operation.row.habitIds,
            note: reviewNoteInput(operation.note as Note),
          });
          return;
        case 'attachment': {
          const row = operation.row;
          try {
            await client.attachments.create({
              id: row.id,
              spaceId: row.spaceId,
              noteId: row.noteId,
              blockId: row.blockId,
              fileName: row.fileName,
              sha256: row.sha256,
              byteSize: row.byteSize,
              mime: row.mime,
              storageKey: row.storageKey,
            });
          } catch {
            // 同 id 已存在（update 场景）时改走更新。
            await client.attachments.update(row.id, {
              noteId: row.noteId,
              blockId: row.blockId,
              fileName: row.fileName,
              mime: row.mime,
              storageKey: row.storageKey,
            });
          }
          await ensureAttachmentState(row, operation.blob, blobStore, stateStore, now);
          return;
        }
        case 'setting':
          await client.settings.set({
            id: operation.row.id,
            spaceId: operation.row.spaceId,
            scope: operation.row.scope,
            key: operation.row.key,
            value: operation.row.value,
          });
          return;
        case 'setting-delete':
          await client.settings.remove(operation.id);
          return;
        case 'appearance': {
          const appearance = {
            theme: operation.value.theme,
            accent: operation.value.accent,
            density: operation.value.density,
          };
          saveAppearance(appearance);
          applyAppearance(appearance);
          return;
        }
      }
    },
  };
}
