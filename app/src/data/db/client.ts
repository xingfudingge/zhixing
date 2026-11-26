/**
 * Tauri IPC 客户端。命令名与 Rust `#[tauri::command]` 一一对应；
 * 渲染层只通过这里访问 SQLite，不拼 SQL、不直接读 localStorage。
 */

import { invoke } from '@tauri-apps/api/core';

import type {
  Attachment,
  AttachmentQuery,
  AttachmentUpdate,
  Board,
  BoardEdge,
  BoardEdgeUpdate,
  BoardNode,
  BoardNodeUpdate,
  BoardQuery,
  BoardUpdate,
  Countdown,
  CountdownQuery,
  CountdownUpdate,
  DbStatus,
  Event,
  EventQuery,
  EventUpdate,
  FocusSession,
  FocusSessionQuery,
  FocusSessionUpdate,
  Habit,
  HabitLog,
  HabitLogQuery,
  HabitQuery,
  HabitUpdate,
  ImportNoteInput,
  List,
  ListDeleteResult,
  ListMove,
  ListUpdate,
  NewAttachment,
  NewBoard,
  NewBoardEdge,
  NewBoardNode,
  NewCountdown,
  NewEvent,
  NewFocusSession,
  NewHabit,
  NewList,
  NewNote,
  NewNoteBlock,
  NewNoteTodo,
  NewSetting,
  NoteEncryptionReport,
  NoteEncryptionStatus,
  NewSubtask,
  NewTask,
  Note,
  NoteBlock,
  NoteBlockUpdate,
  NoteQuery,
  NoteTodo,
  NoteTodoUpdate,
  NoteUpdate,
  ReviewSnapshot,
  ReviewSnapshotQuery,
  SaveReviewInput,
  SavedReview,
  Setting,
  SettingQuery,
  Subtask,
  SubtaskUpdate,
  Task,
  TaskQuery,
  TaskUpdate,
} from './types';

export type DbInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/** 业务数据重置结果（Rust `ResetDomainReport`，camelCase）。 */
export type ResetDomainReport = {
  deletedRows: number;
  preservedSettings: number;
  seedApplied: boolean;
  samplesInserted: number;
  inboxCreated: boolean;
  workCreated: boolean;
  seedMarker: string;
};

export const tauriInvoker: DbInvoker = (command, args) =>
  invoke(command, args);

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export class DbUnavailableError extends Error {
  constructor(command: string) {
    super(`SQLite 仓储命令 ${command} 只能在 Tauri 桌面壳内调用`);
    this.name = 'DbUnavailableError';
  }
}

export function createDbClient(invoker: DbInvoker = tauriInvoker) {
  const useRuntimeGuard = invoker === tauriInvoker;

  const call = <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (useRuntimeGuard && !isTauriRuntime()) {
      return Promise.reject(new DbUnavailableError(command));
    }
    return invoker<T>(command, args);
  };

  return {
    system: {
      status: () => call<DbStatus>('db_status'),
      migrate: () => call<DbStatus>('db_migrate'),
      /** 同一事务内清空业务表并重新执行种子；偏好保留。 */
      resetDomain: () => call<ResetDomainReport>('db_reset_domain'),
    },

    lists: {
      list: (includeDeleted = false) =>
        call<List[]>('lists_list', { includeDeleted }),
      get: (id: string) => call<List>('lists_get', { id }),
      create: (input: NewList) => call<List>('lists_create', { input }),
      update: (id: string, input: ListUpdate) =>
        call<List>('lists_update', { id, input }),
      move: (id: string, input: ListMove) =>
        call<List>('lists_move', { id, input }),
      remove: (id: string) =>
        call<ListDeleteResult>('lists_delete', { id }),
    },

    tasks: {
      list: (query: TaskQuery = {}) =>
        call<Task[]>('tasks_list', { query }),
      get: (id: string) => call<Task>('tasks_get', { id }),
      create: (input: NewTask) => call<Task>('tasks_create', { input }),
      update: (id: string, input: TaskUpdate) =>
        call<Task>('tasks_update', { id, input }),
      complete: (id: string, done: boolean) =>
        call<Task>('tasks_complete', { id, done }),
      remove: (id: string) => call<void>('tasks_delete', { id }),
      restore: (id: string) => call<Task>('tasks_restore', { id }),
      subtasks: {
        list: (taskId: string, includeDeleted = false) =>
          call<Subtask[]>('subtasks_list', { taskId, includeDeleted }),
        create: (input: NewSubtask) =>
          call<Subtask>('subtasks_create', { input }),
        update: (id: string, input: SubtaskUpdate) =>
          call<Subtask>('subtasks_update', { id, input }),
        remove: (id: string) => call<void>('subtasks_delete', { id }),
      },
    },

    notes: {
      list: (query: NoteQuery = {}) =>
        call<Note[]>('notes_list', { query }),
      get: (id: string) => call<Note>('notes_get', { id }),
      create: (input: NewNote) => call<Note>('notes_create', { input }),
      /** 文件导入：笔记、块、待办在 Rust 侧同一事务内写入。 */
      import: (input: ImportNoteInput) =>
        call<Note>('notes_import', { input }),
      update: (id: string, input: NoteUpdate) =>
        call<Note>('notes_update', { id, input }),
      remove: (id: string) => call<void>('notes_delete', { id }),
      restore: (id: string) => call<Note>('notes_restore', { id }),
      /**
       * 完整备份专用：原样导出所有笔记（含密文/回收站），不接触明文密钥。
       * 普通 list 在锁定时返回空内容，不能用于备份。
       */
      exportRows: () => call<Note[]>('notes_export_rows'),
      blocks: {
        list: (noteId: string, includeDeleted = false) =>
          call<NoteBlock[]>('note_blocks_list', { noteId, includeDeleted }),
        create: (input: NewNoteBlock) =>
          call<NoteBlock>('note_blocks_create', { input }),
        update: (id: string, input: NoteBlockUpdate) =>
          call<NoteBlock>('note_blocks_update', { id, input }),
        remove: (id: string) => call<void>('note_blocks_delete', { id }),
        exportRows: () => call<NoteBlock[]>('note_blocks_export_rows'),
      },
    },

    noteTodos: {
      list: (noteId: string, includeDeleted = false) =>
        call<NoteTodo[]>('note_todos_list', { noteId, includeDeleted }),
      create: (input: NewNoteTodo) =>
        call<NoteTodo>('note_todos_create', { input }),
      update: (id: string, input: NoteTodoUpdate) =>
        call<NoteTodo>('note_todos_update', { id, input }),
      remove: (id: string) => call<void>('note_todos_delete', { id }),
      exportRows: () => call<NoteTodo[]>('note_todos_export_rows'),
    },

    noteEncryption: {
      status: () => call<NoteEncryptionStatus>('note_encryption_status'),
      enable: (passphrase: string) =>
        call<NoteEncryptionReport>('note_encryption_enable', { passphrase }),
      unlock: (passphrase: string) =>
        call<NoteEncryptionStatus>('note_encryption_unlock', { passphrase }),
      lock: () => call<NoteEncryptionStatus>('note_encryption_lock'),
      changePassphrase: (currentPassphrase: string, nextPassphrase: string) =>
        call<NoteEncryptionStatus>('note_encryption_change_passphrase', {
          currentPassphrase,
          nextPassphrase,
        }),
      disable: (passphrase?: string) =>
        call<NoteEncryptionReport>('note_encryption_disable', { passphrase }),
      exportEnvelope: () =>
        call<string | null>('note_encryption_export_envelope'),
      importEnvelope: (envelopeJson: string) =>
        call<NoteEncryptionStatus>('note_encryption_import_envelope', {
          envelopeJson,
        }),
    },

    events: {
      list: (query: EventQuery = {}) =>
        call<Event[]>('events_list', { query }),
      get: (id: string) => call<Event>('events_get', { id }),
      create: (input: NewEvent) => call<Event>('events_create', { input }),
      update: (id: string, input: EventUpdate) =>
        call<Event>('events_update', { id, input }),
      remove: (id: string) => call<void>('events_delete', { id }),
    },

    countdowns: {
      list: (query: CountdownQuery = {}) =>
        call<Countdown[]>('countdowns_list', { query }),
      get: (id: string) => call<Countdown>('countdowns_get', { id }),
      create: (input: NewCountdown) =>
        call<Countdown>('countdowns_create', { input }),
      update: (id: string, input: CountdownUpdate) =>
        call<Countdown>('countdowns_update', { id, input }),
      remove: (id: string) => call<void>('countdowns_delete', { id }),
    },

    habits: {
      list: (query: HabitQuery = {}) =>
        call<Habit[]>('habits_list', { query }),
      get: (id: string) => call<Habit>('habits_get', { id }),
      create: (input: NewHabit) => call<Habit>('habits_create', { input }),
      update: (id: string, input: HabitUpdate) =>
        call<Habit>('habits_update', { id, input }),
      remove: (id: string) => call<void>('habits_delete', { id }),
      logs: {
        list: (habitId: string, query: HabitLogQuery = {}) =>
          call<HabitLog[]>('habit_logs_list', { habitId, query }),
        set: (habitId: string, date: string, note?: string) =>
          call<HabitLog>('habit_logs_set', { habitId, date, note }),
        remove: (habitId: string, date: string) =>
          call<void>('habit_logs_delete', { habitId, date }),
      },
    },

    focusSessions: {
      list: (query: FocusSessionQuery = {}) =>
        call<FocusSession[]>('focus_sessions_list', { query }),
      get: (id: string) => call<FocusSession>('focus_sessions_get', { id }),
      create: (input: NewFocusSession) =>
        call<FocusSession>('focus_sessions_create', { input }),
      update: (id: string, input: FocusSessionUpdate) =>
        call<FocusSession>('focus_sessions_update', { id, input }),
      remove: (id: string) => call<void>('focus_sessions_delete', { id }),
    },

    reviewSnapshots: {
      list: (query: ReviewSnapshotQuery = {}) =>
        call<ReviewSnapshot[]>('review_snapshots_list', { query }),
      get: (id: string) => call<ReviewSnapshot>('review_snapshots_get', { id }),
      getByRange: (from: string, to: string) =>
        call<ReviewSnapshot | null>('review_snapshots_get_by_range', {
          from,
          to,
        }),
      /** 笔记与快照在同一 Rust 事务内创建；同范围重复调用幂等。 */
      save: (input: SaveReviewInput) =>
        call<SavedReview>('review_snapshots_save', { input }),
    },

    boards: {
      list: (query: BoardQuery = {}) =>
        call<Board[]>('boards_list', { query }),
      get: (id: string) => call<Board>('boards_get', { id }),
      create: (input: NewBoard) => call<Board>('boards_create', { input }),
      update: (id: string, input: BoardUpdate) =>
        call<Board>('boards_update', { id, input }),
      remove: (id: string) => call<void>('boards_delete', { id }),
      nodes: {
        list: (boardId: string, includeDeleted = false) =>
          call<BoardNode[]>('board_nodes_list', { boardId, includeDeleted }),
        create: (input: NewBoardNode) =>
          call<BoardNode>('board_nodes_create', { input }),
        update: (id: string, input: BoardNodeUpdate) =>
          call<BoardNode>('board_nodes_update', { id, input }),
        remove: (id: string) => call<void>('board_nodes_delete', { id }),
      },
      edges: {
        list: (boardId: string, includeDeleted = false) =>
          call<BoardEdge[]>('board_edges_list', { boardId, includeDeleted }),
        create: (input: NewBoardEdge) =>
          call<BoardEdge>('board_edges_create', { input }),
        update: (id: string, input: BoardEdgeUpdate) =>
          call<BoardEdge>('board_edges_update', { id, input }),
        remove: (id: string) => call<void>('board_edges_delete', { id }),
      },
    },

    attachments: {
      list: (query: AttachmentQuery = {}) =>
        call<Attachment[]>('attachments_list', { query }),
      get: (id: string) => call<Attachment>('attachments_get', { id }),
      create: (input: NewAttachment) =>
        call<Attachment>('attachments_create', { input }),
      update: (id: string, input: AttachmentUpdate) =>
        call<Attachment>('attachments_update', { id, input }),
      remove: (id: string) => call<void>('attachments_delete', { id }),
    },

    settings: {
      list: (query: SettingQuery = {}) =>
        call<Setting[]>('settings_list', { query }),
      get: (scope: 'device' | 'space', key: string) =>
        call<Setting>('settings_get', { scope, key }),
      set: (input: NewSetting) =>
        call<Setting>('settings_set', { input }),
      remove: (id: string) => call<void>('settings_delete', { id }),
    },
  };
}

export type DbClient = ReturnType<typeof createDbClient>;

export const db = createDbClient();
