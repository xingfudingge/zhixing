/** P2-04 测试数据：完整备份、ZIP、恢复预览与内存写入目标共用。 */

import type {
  Attachment,
  Board,
  BoardEdge,
  BoardNode,
  Countdown,
  Event,
  FocusSession,
  Habit,
  HabitLog,
  List,
  Note,
  NoteBlock,
  NoteTodo,
  ReviewSnapshot,
  Setting,
  Subtask,
  Task,
} from '../../../data/db/types';
import { SETTING_KEYS } from '../../../data/repositories/settings';
import { sha256Bytes } from '../../attachments/sha256';
import { buildManifest } from '../manifest';
import { collectRelations, findDanglingRelations } from '../relations';
import type {
  BackupDataset,
  BackupPayload,
  BackupSource,
  BoardBackup,
  ParsedBackup,
} from '../types';
import { BACKUP_APP, BACKUP_FORMAT_VERSION, BACKUP_KIND } from '../types';
import { cloneDatasetShallow } from '../dataset';

export const FIXED_NOW = new Date('2026-10-26T12:00:00.000Z');

export const ATTACHMENT_TEXT = 'release checklist';
export const ATTACHMENT_SHA = sha256Bytes(
  new TextEncoder().encode(ATTACHMENT_TEXT),
);

export function makeDataset(): BackupDataset {
  const lists: List[] = [
    {
      id: 'list-inbox',
      spaceId: 'personal',
      name: '收件箱',
      color: '#5579d5',
      icon: '',
      parentId: null,
      sortOrder: 0,
      isInbox: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
    {
      id: 'list-work',
      spaceId: 'personal',
      name: '工作',
      color: '#3a9b9a',
      icon: '',
      parentId: null,
      sortOrder: 1,
      isInbox: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];

  const tasks: Task[] = [
    {
      id: 'task-a',
      spaceId: 'personal',
      listId: 'list-work',
      parentId: null,
      noteId: 'note-a',
      title: '整理发布清单',
      notes: '检查导出与恢复',
      status: 'todo',
      priority: 2,
      quadrant: 1,
      dueDate: '2026-10-30',
      dueTime: null,
      dueAt: '2026-10-30T09:00:00.000Z',
      tz: 'Asia/Shanghai',
      reminder: '',
      sortOrder: 1,
      completedAt: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
      deletedAt: null,
      version: 2,
    },
    {
      id: 'task-deleted',
      spaceId: 'personal',
      listId: 'list-work',
      parentId: null,
      noteId: 'note-a',
      title: '已删除但关系要保留',
      notes: '',
      status: 'todo',
      priority: 0,
      quadrant: 0,
      dueDate: null,
      dueTime: null,
      dueAt: null,
      tz: 'Asia/Shanghai',
      reminder: '',
      sortOrder: 2,
      completedAt: null,
      createdAt: '2026-10-02T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
      deletedAt: '2026-10-03T00:00:00.000Z',
      version: 2,
    },
  ];

  const subtasks: Subtask[] = [
    {
      id: 'subtask-a',
      taskId: 'task-a',
      title: '导出 ZIP',
      done: false,
      sortOrder: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];

  const notes: Note[] = [
    {
      id: 'note-a',
      spaceId: 'personal',
      title: '发布检查',
      folderId: 'f1',
      tags: ['发布', '验收'],
      body: '<h1>发布</h1><p>检查清单与导出。</p>',
      bodyFormat: 'html',
      status: 'active',
      favorite: true,
      pinned: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
      deletedAt: null,
      version: 3,
    },
    {
      id: 'note-deleted',
      spaceId: 'personal',
      title: '旧笔记',
      folderId: 'f3',
      tags: [],
      body: '<p>旧内容</p>',
      bodyFormat: 'html',
      status: 'trashed',
      favorite: false,
      pinned: false,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      deletedAt: '2026-08-02T00:00:00.000Z',
      version: 2,
    },
    {
      id: 'note-review',
      spaceId: 'personal',
      title: '复盘 · 2026-10-26',
      folderId: 'f3',
      tags: ['复盘'],
      body: '<p>本周复盘</p>',
      bodyFormat: 'html',
      status: 'active',
      favorite: false,
      pinned: false,
      createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];

  const noteBlocks: NoteBlock[] = [
    {
      id: 'block-a',
      noteId: 'note-a',
      blockType: 'heading1',
      orderKey: 1,
      payload: { text: '发布', level: 1 },
      schemaVersion: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
    {
      id: 'block-deleted',
      noteId: 'note-deleted',
      blockType: 'paragraph',
      orderKey: 1,
      payload: { text: '旧内容' },
      schemaVersion: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];

  const noteTodos: NoteTodo[] = [
    {
      id: 'todo-a',
      spaceId: 'personal',
      noteId: 'note-a',
      taskId: 'task-a',
      title: '确认恢复预览',
      done: false,
      dueDate: '2026-10-29',
      reminderEnabled: false,
      sortOrder: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];

  const events: Event[] = [
    {
      id: 'event-a',
      spaceId: 'personal',
      title: '发布评审',
      eventType: '工作',
      allDay: false,
      startDate: '2026-10-28',
      startAt: '2026-10-28T10:00:00.000Z',
      endAt: '2026-10-28T11:00:00.000Z',
      tz: 'Asia/Shanghai',
      source: 'local',
      externalUid: null,
      repeatRule: '单次',
      calendarType: 'solar',
      noteId: 'note-a',
      color: '',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];

  const countdowns: Countdown[] = [
    {
      id: 'countdown-a',
      spaceId: 'personal',
      title: '发布日',
      category: '工作',
      calendarType: 'solar',
      targetDate: '2026-11-01',
      repeatRule: '单次',
      lunarMonth: null,
      lunarDay: null,
      note: '',
      color: '',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];

  const habits: Habit[] = [
    {
      id: 'habit-a',
      spaceId: 'personal',
      title: '每日复盘',
      schedule: '每天',
      icon: '◎',
      color: 'teal',
      goalPerWeek: 7,
      sortOrder: 1,
      archived: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];

  const habitLogs: HabitLog[] = [
    {
      id: 'log-a',
      spaceId: 'personal',
      habitId: 'habit-a',
      logDate: '2026-10-20',
      done: true,
      note: '',
      createdAt: '2026-10-20T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];

  const focusSessions: FocusSession[] = [
    {
      id: 'focus-a',
      spaceId: 'personal',
      taskId: 'task-a',
      minutes: 25,
      startedAt: '2026-10-20T09:00:00.000Z',
      endedAt: '2026-10-20T09:25:00.000Z',
      mode: 'countdown',
      note: '',
      createdAt: '2026-10-20T09:00:00.000Z',
      updatedAt: '2026-10-20T09:25:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];

  const reviewSnapshots: ReviewSnapshot[] = [
    {
      id: 'review-a',
      spaceId: 'personal',
      rangeStart: '2026-10-20',
      rangeEnd: '2026-10-26',
      taskIds: ['task-a'],
      focusIds: ['focus-a'],
      habitIds: ['habit-a'],
      noteId: 'note-review',
      createdAt: '2026-10-26T10:00:00.000Z',
      updatedAt: '2026-10-26T10:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];

  const board: Board = {
    id: 'board-a',
    spaceId: 'personal',
    noteId: 'note-a',
    title: '发布流程',
    background: 'dot',
    snapshot: { version: 1, nodeCount: 2, edgeCount: 1 },
    thumbnailKey: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    deletedAt: null,
    version: 2,
  };
  const nodes: BoardNode[] = [
    {
      id: 'node-1',
      boardId: 'board-a',
      nodeType: 'start',
      x: 0,
      y: 0,
      width: 130,
      height: 54,
      rotation: 0,
      zIndex: 1,
      text: '开始',
      payload: { style: { fill: '#eef8f1' } },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
    {
      id: 'node-2',
      boardId: 'board-a',
      nodeType: 'process',
      x: 240,
      y: 0,
      width: 170,
      height: 62,
      rotation: 0,
      zIndex: 2,
      text: '导出',
      payload: { style: { fill: '#ffffff' } },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];
  const edges: BoardEdge[] = [
    {
      id: 'edge-1',
      boardId: 'board-a',
      fromNodeId: 'node-1',
      toNodeId: 'node-2',
      label: '下一步',
      style: { routing: 'straight', arrow: 'end' },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];

  const attachment: Attachment = {
    id: 'attachment-a',
    spaceId: 'personal',
    noteId: 'note-a',
    blockId: 'block-a',
    fileName: 'release.txt',
    sha256: ATTACHMENT_SHA,
    byteSize: ATTACHMENT_TEXT.length,
    mime: 'text/plain',
    storageKey: `spaces/personal/assets/${ATTACHMENT_SHA}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  };

  const settings: Setting[] = [
    {
      id: 'setting-font',
      spaceId: 'personal',
      scope: 'device',
      key: SETTING_KEYS.editorFontSize,
      value: 15,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];

  return {
    lists,
    tasks,
    subtasks,
    notes,
    noteBlocks,
    noteTodos,
    events,
    countdowns,
    habits,
    habitLogs,
    focusSessions,
    reviewSnapshots,
    boards: [{ board, nodes, edges }],
    attachments: [attachment],
    settings,
  };
}

export function makePayload(
  dataset: BackupDataset = makeDataset(),
): BackupPayload {
  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: FIXED_NOW.toISOString(),
    appVersion: '0.1.0',
    schemaVersion: 3,
    appearance: { theme: 'light', accent: 'blue', density: 'comfortable' },
    dataset,
    excludedSettings: ['sync.token'],
  };
}

export function makeBlobs(dataset: BackupDataset = makeDataset()): Map<string, Blob> {
  const map = new Map<string, Blob>();
  const attachment = dataset.attachments[0];
  if (attachment) {
    map.set(
      attachment.id,
      new Blob([ATTACHMENT_TEXT], { type: attachment.mime }),
    );
  }
  return map;
}

export function makeParsed(
  payload: BackupPayload = makePayload(),
  blobs: Map<string, Blob> = makeBlobs(payload.dataset),
): ParsedBackup {
  const manifest = buildManifest({
    payload,
    entries: [],
    boardEntries: payload.dataset.boards.map((board: BoardBackup) => ({
      id: board.board.id,
      title: board.board.title,
      noteId: board.board.noteId,
      path: '',
      sha256: sha256Bytes(new TextEncoder().encode(JSON.stringify(board))),
      nodeCount: board.nodes.length,
      edgeCount: board.edges.length,
    })),
    attachmentEntries: payload.dataset.attachments.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      mime: attachment.mime,
      sha256: attachment.sha256,
      byteSize: attachment.byteSize,
      path: ATTACHMENT_SHA ? 'attachments/release.txt' : null,
      deletedAt: attachment.deletedAt,
    })),
  });
  const relations = collectRelations(payload.dataset);
  return {
    format: 'json',
    payload,
    manifest,
    blobs,
    issues: [],
    warnings: [],
    relations,
    danglingRelations: findDanglingRelations(relations, payload.dataset),
  };
}

export function makeMemorySource(
  payload: BackupPayload = makePayload(),
  blobs: Map<string, Blob> = makeBlobs(payload.dataset),
): BackupSource & { calls: number } {
  const source = {
    calls: 0,
    async collect() {
      source.calls += 1;
      return {
        payload: {
          ...payload,
          dataset: cloneDatasetShallow(payload.dataset),
        },
        blobs,
        missingAttachmentIds: [],
        warnings: [],
      };
    },
  };
  return source;
}
