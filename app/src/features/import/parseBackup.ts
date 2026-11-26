/**
 * 备份文件解析与校验（P2-04）。
 *
 * 只解析、不写库。ZIP 必须带 manifest，并逐个校验 SHA-256/大小/CRC；
 * JSON 单文件可重建 manifest，但仍校验结构、计数、关系与设置白名单。
 * 任何错误都在这里抛出，恢复预览不会在坏文件上打开。
 */

import type {
  Attachment,
  Board,
  BoardEdge,
  BoardNode,
  CalendarType,
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
} from '../../data/db/types';
import { isSha256Hex, sha256Bytes } from '../attachments/sha256';
import { datasetCounts } from '../export/dataset';
import { buildManifest, ZIP_PATHS } from '../export/manifest';
import {
  canonicalRelations,
  collectRelations,
  findDanglingRelations,
  relationsEqual,
} from '../export/relations';
import {
  isSafeSettingKey,
  stableStringify,
} from '../export/sanitize';
import type {
  BackupAttachmentEntry,
  BackupBoardEntry,
  BackupDataset,
  BackupIssue,
  BackupManifest,
  BackupPayload,
  BackupRelation,
  ParsedBackup,
} from '../export/types';
import {
  BACKUP_APP,
  BACKUP_FORMAT_VERSION,
  BACKUP_KIND,
} from '../export/types';
import { bytesToBlob } from '../export/utils';
import { readZip, ZipError, type ZipReadEntry } from '../export/zip';

const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

export class BackupParseError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    const summary = details.slice(0, 4).join('；');
    super(summary ? `${message}：${summary}` : message);
    this.name = 'BackupParseError';
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  label: string,
  details: string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    details.push(`${label} 不是对象`);
    return {};
  }
  return value;
}

function requireString(
  value: unknown,
  label: string,
  details: string[],
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push(`${label} 必须是非空字符串`);
    return '';
  }
  return value;
}

function requireArray(
  value: unknown,
  label: string,
  details: string[],
): unknown[] {
  if (!Array.isArray(value)) {
    details.push(`${label} 必须是数组`);
    return [];
  }
  return value;
}

function requireNumber(
  value: unknown,
  label: string,
  details: string[],
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    details.push(`${label} 必须是有限数字`);
    return 0;
  }
  return value;
}

function parseRows<T>(
  value: unknown,
  label: string,
  details: string[],
  validate: (row: Record<string, unknown>, index: number, details: string[]) => T | null,
): T[] {
  const rows = requireArray(value, label, details);
  const result: T[] = [];
  const ids = new Set<string>();
  rows.forEach((row, index) => {
    if (!isRecord(row)) {
      details.push(`${label}[${index}] 不是对象`);
      return;
    }
    const id = requireString(row.id, `${label}[${index}].id`, details);
    if (!id) return;
    if (ids.has(id)) {
      details.push(`${label} 的 id 重复：${id}`);
      return;
    }
    ids.add(id);
    const parsed = validate(row, index, details);
    if (parsed) result.push(parsed);
  });
  return result;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asJson<T>(value: unknown, fallback: T): T {
  return value === undefined ? fallback : (value as T);
}

function parseList(row: Record<string, unknown>): List {
  return {
    id: String(row.id),
    spaceId: asString(row.spaceId, 'personal'),
    name: asString(row.name, '未命名清单'),
    color: asString(row.color, '#5579d5'),
    icon: asString(row.icon, ''),
    parentId: asNullableString(row.parentId),
    sortOrder: asNumber(row.sortOrder),
    isInbox: asBoolean(row.isInbox),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    deletedAt: asNullableString(row.deletedAt),
    version: asNumber(row.version, 1),
  };
}

function parseTask(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    spaceId: asString(row.spaceId, 'personal'),
    listId: asString(row.listId),
    parentId: asNullableString(row.parentId),
    noteId: asNullableString(row.noteId),
    title: asString(row.title, '未命名任务'),
    notes: asString(row.notes),
    status:
      row.status === 'done' || row.status === 'doing' ? row.status : 'todo',
    priority: asNumber(row.priority),
    quadrant: asNumber(row.quadrant),
    dueDate: asNullableString(row.dueDate),
    dueTime: asNullableString(row.dueTime),
    dueAt: asNullableString(row.dueAt),
    tz: asString(row.tz, 'Asia/Shanghai'),
    reminder: asString(row.reminder),
    sortOrder: asNumber(row.sortOrder),
    completedAt: asNullableString(row.completedAt),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    deletedAt: asNullableString(row.deletedAt),
    version: asNumber(row.version, 1),
  };
}

function parseSubtask(row: Record<string, unknown>): Subtask {
  return {
    id: String(row.id),
    taskId: asString(row.taskId),
    title: asString(row.title, '子任务'),
    done: asBoolean(row.done),
    sortOrder: asNumber(row.sortOrder),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    deletedAt: asNullableString(row.deletedAt),
    version: asNumber(row.version, 1),
  };
}

function parseNote(row: Record<string, unknown>): Note {
  return {
    id: String(row.id),
    spaceId: asString(row.spaceId, 'personal'),
    title: asString(row.title),
    folderId: asNullableString(row.folderId),
    tags: asStringArray(row.tags),
    body: asString(row.body),
    bodyFormat: row.bodyFormat === 'blocks' ? 'blocks' : 'html',
    status: row.status === 'trashed' ? 'trashed' : 'active',
    favorite: asBoolean(row.favorite),
    pinned: asBoolean(row.pinned),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    deletedAt: asNullableString(row.deletedAt),
    version: asNumber(row.version, 1),
    encrypted: asBoolean(row.encrypted),
    locked: asBoolean(row.locked),
    encryptedTagsJson: asNullableString(row.encryptedTagsJson),
  };
}

function parseNoteBlock(row: Record<string, unknown>): NoteBlock {
  return {
    id: String(row.id),
    noteId: asString(row.noteId),
    blockType: asString(row.blockType, 'paragraph'),
    orderKey: asNumber(row.orderKey),
    payload: asJson(row.payload, {}),
    schemaVersion: asNumber(row.schemaVersion, 1),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    deletedAt: asNullableString(row.deletedAt),
    version: asNumber(row.version, 1),
    encrypted: asBoolean(row.encrypted),
    locked: asBoolean(row.locked),
    encryptedPayloadJson: asNullableString(row.encryptedPayloadJson),
  };
}

function parseNoteTodo(row: Record<string, unknown>): NoteTodo {
  return {
    id: String(row.id),
    spaceId: asString(row.spaceId, 'personal'),
    noteId: asString(row.noteId),
    taskId: asNullableString(row.taskId),
    title: asString(row.title, '待办事项'),
    done: asBoolean(row.done),
    dueDate: asNullableString(row.dueDate),
    reminderEnabled: asBoolean(row.reminderEnabled),
    sortOrder: asNumber(row.sortOrder),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    deletedAt: asNullableString(row.deletedAt),
    version: asNumber(row.version, 1),
    encrypted: asBoolean(row.encrypted),
    locked: asBoolean(row.locked),
  };
}

function asCalendarType(value: unknown): CalendarType {
  return value === 'lunar' ? 'lunar' : 'solar';
}

function parseEvent(row: Record<string, unknown>): Event {
  return {
    id: String(row.id),
    spaceId: asString(row.spaceId, 'personal'),
    title: asString(row.title, '事件'),
    eventType: asString(row.eventType, '个人日程'),
    allDay: asBoolean(row.allDay),
    startDate: asString(row.startDate),
    startAt: asNullableString(row.startAt),
    endAt: asNullableString(row.endAt),
    tz: asString(row.tz, 'Asia/Shanghai'),
    source: asString(row.source, 'local'),
    externalUid: asNullableString(row.externalUid),
    repeatRule: asString(row.repeatRule, '单次'),
    calendarType: asCalendarType(row.calendarType),
    noteId: asNullableString(row.noteId),
    color: asString(row.color),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    deletedAt: asNullableString(row.deletedAt),
    version: asNumber(row.version, 1),
  };
}

function parseCountdown(row: Record<string, unknown>): Countdown {
  return {
    id: String(row.id),
    spaceId: asString(row.spaceId, 'personal'),
    title: asString(row.title, '倒数日'),
    category: asString(row.category, '自定义'),
    calendarType: row.calendarType === 'lunar' ? 'lunar' : 'solar',
    targetDate: asString(row.targetDate),
    repeatRule: asString(row.repeatRule, '单次'),
    lunarMonth: asNullableString(row.lunarMonth),
    lunarDay:
      typeof row.lunarDay === 'number' && Number.isFinite(row.lunarDay)
        ? row.lunarDay
        : null,
    note: asString(row.note),
    color: asString(row.color),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    deletedAt: asNullableString(row.deletedAt),
    version: asNumber(row.version, 1),
  };
}

function parseHabit(row: Record<string, unknown>): Habit {
  return {
    id: String(row.id),
    spaceId: asString(row.spaceId, 'personal'),
    title: asString(row.title, '习惯'),
    schedule: asString(row.schedule, '每天'),
    icon: asString(row.icon),
    color: asString(row.color, 'blue'),
    goalPerWeek: asNumber(row.goalPerWeek, 7),
    sortOrder: asNumber(row.sortOrder),
    archived: asBoolean(row.archived),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    deletedAt: asNullableString(row.deletedAt),
    version: asNumber(row.version, 1),
  };
}

function parseHabitLog(row: Record<string, unknown>): HabitLog {
  return {
    id: String(row.id),
    spaceId: asString(row.spaceId, 'personal'),
    habitId: asString(row.habitId),
    logDate: asString(row.logDate),
    done: asBoolean(row.done, true),
    note: asString(row.note),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    deletedAt: asNullableString(row.deletedAt),
    version: asNumber(row.version, 1),
  };
}

function parseFocusSession(row: Record<string, unknown>): FocusSession {
  return {
    id: String(row.id),
    spaceId: asString(row.spaceId, 'personal'),
    taskId: asString(row.taskId),
    minutes: asNumber(row.minutes),
    startedAt: asString(row.startedAt),
    endedAt: asNullableString(row.endedAt),
    mode: asString(row.mode, 'countdown'),
    note: asString(row.note),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    deletedAt: asNullableString(row.deletedAt),
    version: asNumber(row.version, 1),
  };
}

function parseReviewSnapshot(row: Record<string, unknown>): ReviewSnapshot {
  return {
    id: String(row.id),
    spaceId: asString(row.spaceId, 'personal'),
    rangeStart: asString(row.rangeStart),
    rangeEnd: asString(row.rangeEnd),
    taskIds: asStringArray(row.taskIds),
    focusIds: asStringArray(row.focusIds),
    habitIds: asStringArray(row.habitIds),
    noteId: asNullableString(row.noteId),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    deletedAt: asNullableString(row.deletedAt),
    version: asNumber(row.version, 1),
  };
}

function parseSetting(row: Record<string, unknown>, details: string[]): Setting | null {
  const key = requireString(row.key, 'settings.key', details);
  if (!key) return null;
  if (!isSafeSettingKey(key)) {
    details.push(`备份包含不允许导出的设置键：${key}`);
    return null;
  }
  const scope = row.scope === 'space' ? 'space' : 'device';
  return {
    id: asString(row.id, `setting-${key}`),
    spaceId: asString(row.spaceId, 'personal'),
    scope,
    key,
    value: asJson(row.value, null),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    deletedAt: asNullableString(row.deletedAt),
    version: asNumber(row.version, 1),
  };
}

function parseAttachment(row: Record<string, unknown>, details: string[]): Attachment | null {
  const sha256 = asString(row.sha256).toLowerCase();
  if (!isSha256Hex(sha256)) {
    details.push(`附件 ${asString(row.fileName, String(row.id))} 的 sha256 无效`);
    return null;
  }
  const byteSize = asNumber(row.byteSize);
  if (byteSize < 0) {
    details.push(`附件 ${String(row.id)} 的 byteSize 无效`);
    return null;
  }
  return {
    id: String(row.id),
    spaceId: asString(row.spaceId, 'personal'),
    noteId: asNullableString(row.noteId),
    blockId: asNullableString(row.blockId),
    fileName: asString(row.fileName, '附件'),
    sha256,
    byteSize,
    mime: asString(row.mime, 'application/octet-stream'),
    storageKey: asString(row.storageKey, `spaces/personal/assets/${sha256}`),
    createdAt: asString(row.createdAt),
    updatedAt: asString(row.updatedAt),
    deletedAt: asNullableString(row.deletedAt),
    version: asNumber(row.version, 1),
  };
}

function parseBoardFile(
  raw: unknown,
  manifestEntry: BackupBoardEntry,
  details: string[],
): BackupDataset['boards'][number] | null {
  const root = requireRecord(raw, `画板文件 ${manifestEntry.path}`, details);
  const boardRaw = requireRecord(root.board, `画板 ${manifestEntry.path}.board`, details);
  const board: Board = {
    id: requireString(boardRaw.id, 'board.id', details),
    spaceId: asString(boardRaw.spaceId, 'personal'),
    noteId: asNullableString(boardRaw.noteId),
    title: asString(boardRaw.title, '未命名画板'),
    background: asString(boardRaw.background, 'dot'),
    snapshot: asJson(boardRaw.snapshot, {}),
    thumbnailKey: asNullableString(boardRaw.thumbnailKey),
    createdAt: asString(boardRaw.createdAt),
    updatedAt: asString(boardRaw.updatedAt),
    deletedAt: asNullableString(boardRaw.deletedAt),
    version: asNumber(boardRaw.version, 1),
  };
  if (!board.id) return null;
  if (board.id !== manifestEntry.id) {
    details.push(`画板文件 ${manifestEntry.path} 的 id 与 manifest 不一致`);
    return null;
  }

  const nodes = parseRows<BoardNode>(
    root.nodes,
    `画板 ${board.id}.nodes`,
    details,
    (row) => ({
      id: String(row.id),
      boardId: board.id,
      nodeType: asString(row.nodeType, 'process'),
      x: asNumber(row.x),
      y: asNumber(row.y),
      width: asNumber(row.width, 150),
      height: asNumber(row.height, 60),
      rotation: asNumber(row.rotation),
      zIndex: asNumber(row.zIndex),
      text: asString(row.text),
      payload: asJson(row.payload, {}),
      createdAt: asString(row.createdAt),
      updatedAt: asString(row.updatedAt),
      deletedAt: asNullableString(row.deletedAt),
      version: asNumber(row.version, 1),
    }),
  );
  const edges = parseRows<BoardEdge>(
    root.edges,
    `画板 ${board.id}.edges`,
    details,
    (row) => ({
      id: String(row.id),
      boardId: board.id,
      fromNodeId: asString(row.fromNodeId),
      toNodeId: asString(row.toNodeId),
      label: asString(row.label),
      style: asJson(row.style, {}),
      createdAt: asString(row.createdAt),
      updatedAt: asString(row.updatedAt),
      deletedAt: asNullableString(row.deletedAt),
      version: asNumber(row.version, 1),
    }),
  );

  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      details.push(`画板 ${board.id} 的连线 ${edge.id} 端点不存在`);
    }
    if (edge.fromNodeId === edge.toNodeId) {
      details.push(`画板 ${board.id} 的连线 ${edge.id} 两端相同`);
    }
  }
  if (nodes.length !== manifestEntry.nodeCount) {
    details.push(`画板 ${board.id} 的节点数与 manifest 不一致`);
  }
  if (edges.length !== manifestEntry.edgeCount) {
    details.push(`画板 ${board.id} 的连线数与 manifest 不一致`);
  }

  return { board, nodes, edges };
}

function validateBoardGlobalIds(
  boards: BackupDataset['boards'],
  details: string[],
): void {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const board of boards) {
    for (const node of board.nodes) {
      if (nodeIds.has(node.id)) {
        details.push(`画板节点 id 全局重复：${node.id}`);
      }
      nodeIds.add(node.id);
    }
    for (const edge of board.edges) {
      if (edgeIds.has(edge.id)) {
        details.push(`画板连线 id 全局重复：${edge.id}`);
      }
      edgeIds.add(edge.id);
    }
  }
}

function parseEntitiesDocument(
  raw: unknown,
  details: string[],
): { dataset: Omit<BackupDataset, 'boards'>; payloadBase: Omit<BackupPayload, 'dataset' | 'appearance'> & { appearance: BackupPayload['appearance'] } } | null {
  const root = requireRecord(raw, 'data/entities.json', details);
  if (root.app !== BACKUP_APP || root.kind !== BACKUP_KIND) {
    details.push('entities 文件不是知行备份');
    return null;
  }
  if (root.formatVersion !== BACKUP_FORMAT_VERSION) {
    details.push(`不支持的备份格式版本：${String(root.formatVersion)}`);
    return null;
  }
  const data = requireRecord(root.dataset, 'entities.dataset', details);

  const dataset = {
    lists: parseRows(data.lists, 'lists', details, (row) => parseList(row)),
    tasks: parseRows(data.tasks, 'tasks', details, (row) => parseTask(row)),
    subtasks: parseRows(data.subtasks, 'subtasks', details, (row) => parseSubtask(row)),
    notes: parseRows(data.notes, 'notes', details, (row) => parseNote(row)),
    noteBlocks: parseRows(data.noteBlocks, 'noteBlocks', details, (row) =>
      parseNoteBlock(row),
    ),
    noteTodos: parseRows(data.noteTodos, 'noteTodos', details, (row) =>
      parseNoteTodo(row),
    ),
    events: parseRows(data.events, 'events', details, (row) => parseEvent(row)),
    countdowns: parseRows(data.countdowns, 'countdowns', details, (row) =>
      parseCountdown(row),
    ),
    habits: parseRows(data.habits, 'habits', details, (row) => parseHabit(row)),
    habitLogs: parseRows(data.habitLogs, 'habitLogs', details, (row) =>
      parseHabitLog(row),
    ),
    focusSessions: parseRows(data.focusSessions, 'focusSessions', details, (row) =>
      parseFocusSession(row),
    ),
    reviewSnapshots: parseRows(
      data.reviewSnapshots,
      'reviewSnapshots',
      details,
      (row) => parseReviewSnapshot(row),
    ),
    attachments: parseRows(data.attachments, 'attachments', details, (row) =>
      parseAttachment(row, details),
    ),
    settings: parseRows(data.settings, 'settings', details, (row) =>
      parseSetting(row, details),
    ),
  };

  const settingKeys = new Set<string>();
  for (const setting of dataset.settings) {
    const identity = `${setting.scope}:${setting.key}`;
    if (settingKeys.has(identity)) {
      details.push(`设置键重复：${identity}`);
    }
    settingKeys.add(identity);
  }
  const attachmentHashes = new Set<string>();
  for (const attachment of dataset.attachments) {
    if (attachmentHashes.has(attachment.sha256)) {
      details.push(`附件 SHA-256 重复：${attachment.sha256}`);
    }
    attachmentHashes.add(attachment.sha256);
  }

  return {
    dataset,
    payloadBase: {
      app: BACKUP_APP,
      kind: BACKUP_KIND,
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt: asString(root.exportedAt, new Date(0).toISOString()),
      appVersion: asString(root.appVersion, 'unknown'),
      schemaVersion: asNumber(root.schemaVersion),
      appearance:
        root.appearance && isRecord(root.appearance)
          ? {
              theme:
                root.appearance.theme === 'dark' ||
                root.appearance.theme === 'auto'
                  ? root.appearance.theme
                  : 'light',
              accent:
                root.appearance.accent === 'violet' ||
                root.appearance.accent === 'coral' ||
                root.appearance.accent === 'teal' ||
                root.appearance.accent === 'amber'
                  ? root.appearance.accent
                  : 'blue',
              density:
                root.appearance.density === 'compact'
                  ? 'compact'
                  : 'comfortable',
            }
          : null,
      excludedSettings: asStringArray(root.excludedSettings),
    },
  };
}

function validateManifest(
  raw: unknown,
  details: string[],
): BackupManifest {
  const root = requireRecord(raw, 'manifest.json', details);
  if (root.app !== BACKUP_APP || root.kind !== BACKUP_KIND) {
    details.push('manifest 不是知行完整备份');
  }
  if (root.formatVersion !== BACKUP_FORMAT_VERSION) {
    details.push(`不支持的 manifest 格式版本：${String(root.formatVersion)}`);
  }
  const counts = requireRecord(root.counts, 'manifest.counts', details);
  const requireCount = (key: string): number =>
    requireNumber(counts[key], `manifest.counts.${key}`, details);
  const boards = requireArray(root.boards, 'manifest.boards', details).map(
    (item, index): BackupBoardEntry => {
      const row = requireRecord(item, `manifest.boards[${index}]`, details);
      return {
        id: requireString(row.id, `manifest.boards[${index}].id`, details),
        title: asString(row.title, '画板'),
        noteId: asNullableString(row.noteId),
        path: asString(row.path),
        sha256: requireString(row.sha256, `manifest.boards[${index}].sha256`, details),
        nodeCount: requireNumber(row.nodeCount, `manifest.boards[${index}].nodeCount`, details),
        edgeCount: requireNumber(row.edgeCount, `manifest.boards[${index}].edgeCount`, details),
      };
    },
  );
  const attachmentIds = new Set<string>();
  const attachments = requireArray(
    root.attachments,
    'manifest.attachments',
    details,
  ).map((item, index): BackupAttachmentEntry => {
    const row = requireRecord(item, `manifest.attachments[${index}]`, details);
    const sha256 = asString(row.sha256).toLowerCase();
    if (!isSha256Hex(sha256)) {
      details.push(`manifest.attachments[${index}].sha256 无效`);
    }
    const id = requireString(row.id, `manifest.attachments[${index}].id`, details);
    if (id && attachmentIds.has(id)) {
      details.push(`manifest 附件 id 重复：${id}`);
    }
    attachmentIds.add(id);
    return {
      id,
      fileName: asString(row.fileName, '附件'),
      mime: asString(row.mime, 'application/octet-stream'),
      sha256,
      byteSize: requireNumber(
        row.byteSize,
        `manifest.attachments[${index}].byteSize`,
        details,
      ),
      path: asNullableString(row.path),
      deletedAt: asNullableString(row.deletedAt),
    };
  });
  const entryPaths = new Set<string>();
  const entries = requireArray(root.entries, 'manifest.entries', details).map(
    (item, index) => {
      const row = requireRecord(item, `manifest.entries[${index}]`, details);
      const path = requireString(row.path, `manifest.entries[${index}].path`, details);
      if (path && entryPaths.has(path)) {
        details.push(`manifest 条目路径重复：${path}`);
      }
      entryPaths.add(path);
      return {
        path,
        byteSize: requireNumber(
          row.byteSize,
          `manifest.entries[${index}].byteSize`,
          details,
        ),
        sha256: requireString(
          row.sha256,
          `manifest.entries[${index}].sha256`,
          details,
        ),
      };
    },
  );
  const relationsRaw = requireRecord(
    root.relations,
    'manifest.relations',
    details,
  );
  const relationsDangling = requireArray(
    relationsRaw.dangling,
    'manifest.relations.dangling',
    details,
  ) as BackupRelation[];
  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: asString(root.exportedAt),
    appVersion: asString(root.appVersion, 'unknown'),
    schemaVersion: asNumber(root.schemaVersion),
    generator: asString(root.generator, 'unknown'),
    counts: {
      lists: requireCount('lists'),
      tasks: requireCount('tasks'),
      subtasks: requireCount('subtasks'),
      notes: requireCount('notes'),
      noteBlocks: requireCount('noteBlocks'),
      noteTodos: requireCount('noteTodos'),
      events: requireCount('events'),
      countdowns: requireCount('countdowns'),
      habits: requireCount('habits'),
      habitLogs: requireCount('habitLogs'),
      focusSessions: requireCount('focusSessions'),
      reviewSnapshots: requireCount('reviewSnapshots'),
      boards: requireCount('boards'),
      boardNodes: requireCount('boardNodes'),
      boardEdges: requireCount('boardEdges'),
      attachments: requireCount('attachments'),
      settings: requireCount('settings'),
    },
    entries,
    boards,
    attachments,
    relations: {
      total: requireNumber(
        relationsRaw.total,
        'manifest.relations.total',
        details,
      ),
      byKind: isRecord(relationsRaw.byKind)
        ? (relationsRaw.byKind as Record<string, number>)
        : {},
      dangling: relationsDangling,
    },
    settings: {
      exportedKeys: asStringArray(
        (root.settings as Record<string, unknown> | undefined)?.exportedKeys,
      ),
      excludedKeys: asStringArray(
        (root.settings as Record<string, unknown> | undefined)?.excludedKeys,
      ),
    },
    security: {
      secretsExcluded: true,
      excludedScopes: asStringArray(
        (root.security as Record<string, unknown> | undefined)?.excludedScopes,
      ),
    },
    notes: asStringArray(root.notes),
  };
}

function checkCounts(dataset: BackupDataset, manifest: BackupManifest, details: string[]): void {
  const actual = datasetCounts(dataset);
  const keys = Object.keys(actual) as Array<keyof typeof actual>;
  for (const key of keys) {
    if (actual[key] !== manifest.counts[key]) {
      details.push(
        `对象数量与 manifest 不一致：${key} 实际 ${actual[key]}，manifest ${manifest.counts[key]}`,
      );
    }
  }
}

function checkRelationIntegrity(
  dataset: BackupDataset,
  manifest: BackupManifest,
  relationsFile: unknown,
  warnings: BackupIssue[],
): BackupRelation[] {
  const relations = collectRelations(dataset);
  const dangling = findDanglingRelations(relations, dataset);
  if (relations.length !== manifest.relations.total) {
    warnings.push({
      code: 'relations.count',
      severity: 'warning',
      message: `关系数量与 manifest 不一致：实际 ${relations.length}，manifest ${manifest.relations.total}`,
    });
  }
  if (dangling.length > 0) {
    warnings.push({
      code: 'relations.dangling',
      severity: 'warning',
      message: `备份中有 ${dangling.length} 条悬空关系，相关对象恢复时会被阻止`,
    });
  }
  if (relationsFile !== undefined) {
    const parsed = isRecord(relationsFile)
      ? relationsFile.relations
      : relationsFile;
    if (Array.isArray(parsed)) {
      if (!relationsEqual(relations, parsed as BackupRelation[])) {
        throw new BackupParseError('relations.json 与业务数据不一致，备份可能被篡改');
      }
    } else {
      warnings.push({
        code: 'relations.format',
        severity: 'warning',
        message: 'relations.json 结构无效，已以业务数据重新计算关系',
      });
    }
  }
  return canonicalRelations(relations);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BackupParseError(`${label} 不是有效的 UTF-8 JSON`);
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new BackupParseError(`${label} 不是有效的 JSON`);
  }
}

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

async function parseZipBackup(bytes: Uint8Array): Promise<ParsedBackup> {
  let entries: ZipReadEntry[];
  try {
    entries = await readZip(bytes);
  } catch (error) {
    if (error instanceof ZipError) {
      throw new BackupParseError(error.message);
    }
    throw error;
  }
  const files = new Map(entries.map((entry) => [entry.path, entry]));
  const manifestFile = files.get(ZIP_PATHS.manifest);
  if (!manifestFile) {
    throw new BackupParseError('ZIP 缺少 manifest.json');
  }
  const details: string[] = [];
  const warnings: BackupIssue[] = [];
  const manifest = validateManifest(
    parseJson(decodeUtf8(manifestFile.data, 'manifest.json'), 'manifest.json'),
    details,
  );

  for (const entry of manifest.entries) {
    const file = files.get(entry.path);
    if (!file) {
      details.push(`manifest 声明的文件不存在：${entry.path}`);
      continue;
    }
    if (file.data.byteLength !== entry.byteSize) {
      details.push(`文件大小与 manifest 不一致：${entry.path}`);
    }
    const hash = sha256Bytes(file.data);
    if (hash !== entry.sha256) {
      details.push(`文件 SHA-256 与 manifest 不一致：${entry.path}`);
    }
  }

  const entitiesFile = files.get(ZIP_PATHS.entities);
  if (!entitiesFile) {
    details.push('ZIP 缺少 data/entities.json');
  }
  const relationsFile = files.get(ZIP_PATHS.relations);
  if (!relationsFile) {
    details.push('ZIP 缺少 data/relations.json');
  }
  if (details.length > 0) {
    throw new BackupParseError('ZIP 备份校验失败', details);
  }

  const parsedEntities = parseEntitiesDocument(
    parseJson(decodeUtf8(entitiesFile!.data, ZIP_PATHS.entities), ZIP_PATHS.entities),
    details,
  );
  if (!parsedEntities) {
    throw new BackupParseError('entities 文件结构无效', details);
  }

  const boards: BackupDataset['boards'] = [];
  const boardIds = new Set<string>();
  for (const boardEntry of manifest.boards) {
    const file = files.get(boardEntry.path);
    if (!file) {
      details.push(`manifest 声明的画板文件不存在：${boardEntry.path}`);
      continue;
    }
    if (sha256Bytes(file.data) !== boardEntry.sha256) {
      details.push(`画板文件 SHA-256 不一致：${boardEntry.path}`);
    }
    const board = parseBoardFile(
      parseJson(decodeUtf8(file.data, boardEntry.path), boardEntry.path),
      boardEntry,
      details,
    );
    if (board) {
      if (boardIds.has(board.board.id)) {
        details.push(`画板 id 重复：${board.board.id}`);
      }
      boardIds.add(board.board.id);
      boards.push(board);
    }
  }

  validateBoardGlobalIds(boards, details);

  const dataset: BackupDataset = {
    ...parsedEntities.dataset,
    boards,
  };

  const attachmentById = new Map(
    dataset.attachments.map((attachment) => [attachment.id, attachment]),
  );
  const blobs = new Map<string, Blob>();
  const referencedPaths = new Set<string>();
  for (const entry of manifest.attachments) {
    const metadata = attachmentById.get(entry.id);
    if (!metadata) {
      details.push(`manifest 中的附件不在 attachments 表中：${entry.id}`);
      continue;
    }
    if (metadata.sha256 !== entry.sha256) {
      details.push(`附件 ${entry.fileName} 的哈希与 manifest 不一致`);
    }
    if (!entry.path) continue;
    referencedPaths.add(entry.path);
    const file = files.get(entry.path);
    if (!file) {
      details.push(`附件二进制缺失：${entry.path}`);
      continue;
    }
    if (file.data.byteLength !== entry.byteSize) {
      details.push(`附件大小与 manifest 不一致：${entry.fileName}`);
    }
    const actual = sha256Bytes(file.data);
    if (actual !== entry.sha256) {
      details.push(`附件 SHA-256 校验失败：${entry.fileName}`);
      continue;
    }
    blobs.set(entry.id, bytesToBlob(file.data, entry.mime));
  }

  for (const entry of entries) {
    if (
      entry.path === ZIP_PATHS.manifest ||
      entry.path === ZIP_PATHS.entities ||
      entry.path === ZIP_PATHS.relations ||
      entry.path.startsWith(ZIP_PATHS.boards) ||
      entry.path.startsWith(ZIP_PATHS.attachments)
    ) {
      if (
        entry.path.startsWith(ZIP_PATHS.attachments) &&
        !referencedPaths.has(entry.path)
      ) {
        warnings.push({
          code: 'zip.extraAttachment',
          severity: 'warning',
          message: `ZIP 中有未在 manifest 声明的附件文件：${entry.path}`,
        });
      }
      continue;
    }
    warnings.push({
      code: 'zip.extraEntry',
      severity: 'warning',
      message: `ZIP 中有未识别的文件：${entry.path}`,
    });
  }

  checkCounts(dataset, manifest, details);
  const relationPayload = parseJson(
    decodeUtf8(relationsFile!.data, ZIP_PATHS.relations),
    ZIP_PATHS.relations,
  );
  checkRelationIntegrity(dataset, manifest, relationPayload, warnings);

  if (details.length > 0) {
    throw new BackupParseError('备份结构校验失败', details);
  }

  const payload: BackupPayload = {
    ...parsedEntities.payloadBase,
    dataset,
  };
  return {
    format: 'zip',
    payload,
    manifest,
    blobs,
    issues: [],
    warnings,
    relations: collectRelations(dataset),
    danglingRelations: findDanglingRelations(
      collectRelations(dataset),
      dataset,
    ),
  };
}

function parseJsonBackup(bytes: Uint8Array): ParsedBackup {
  const text = decodeUtf8(bytes, 'JSON 备份').replace(/^﻿/, '');
  const root = requireRecord(parseJson(text, 'JSON 备份'), 'JSON 备份', []);
  const details: string[] = [];
  if (root.app !== BACKUP_APP || root.kind !== BACKUP_KIND) {
    throw new BackupParseError('这不是知行完整备份');
  }
  if (root.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupParseError(`不支持的备份格式版本：${String(root.formatVersion)}`);
  }
  const parsedEntities = parseEntitiesDocument(root, details);
  if (!parsedEntities) {
    throw new BackupParseError('JSON 备份结构无效', details);
  }
  const parsedBoards = parseBoardsFromJson(root.dataset, details);
  validateBoardGlobalIds(parsedBoards, details);
  const dataset: BackupDataset = {
    ...parsedEntities.dataset,
    boards: parsedBoards,
  };

  const warnings: BackupIssue[] = [];
  const manifestRaw = root.manifest;
  let manifest: BackupManifest;
  if (manifestRaw !== undefined) {
    manifest = validateManifest(manifestRaw, details);
  } else {
    manifest = buildManifest({
      payload: {
        ...parsedEntities.payloadBase,
        dataset,
      },
      entries: [],
      boardEntries: dataset.boards.map((board) => ({
        id: board.board.id,
        title: board.board.title,
        noteId: board.board.noteId,
        path: '',
        sha256: sha256Bytes(
          new TextEncoder().encode(stableStringify(board)),
        ),
        nodeCount: board.nodes.length,
        edgeCount: board.edges.length,
      })),
      attachmentEntries: dataset.attachments.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        mime: attachment.mime,
        sha256: attachment.sha256,
        byteSize: attachment.byteSize,
        path: null,
        deletedAt: attachment.deletedAt,
      })),
      notes: ['JSON 备份缺少 manifest，已按数据结构重建。'],
    });
    warnings.push({
      code: 'manifest.rebuilt',
      severity: 'warning',
      message: 'JSON 备份没有 manifest，已按数据结构重建；状态写入前仍会预览冲突。',
    });
  }

  checkCounts(dataset, manifest, details);
  checkRelationIntegrity(dataset, manifest, root.relations, warnings);

  if (details.length > 0) {
    throw new BackupParseError('JSON 备份校验失败', details);
  }

  return {
    format: 'json',
    payload: {
      ...parsedEntities.payloadBase,
      dataset,
    },
    manifest,
    blobs: new Map(),
    issues: [],
    warnings,
    relations: collectRelations(dataset),
    danglingRelations: findDanglingRelations(collectRelations(dataset), dataset),
  };
}

function parseBoardsFromJson(
  datasetRaw: unknown,
  details: string[],
): BackupDataset['boards'] {
  const root = requireRecord(datasetRaw, 'dataset', details);
  const boardsRaw = requireArray(root.boards, 'dataset.boards', details);
  const boards: BackupDataset['boards'] = [];
  boardsRaw.forEach((item, index) => {
    const entry = requireRecord(item, `dataset.boards[${index}]`, details);
    const boardRaw = requireRecord(entry.board, `dataset.boards[${index}].board`, details);
    const board: Board = {
      id: requireString(boardRaw.id, `dataset.boards[${index}].id`, details),
      spaceId: asString(boardRaw.spaceId, 'personal'),
      noteId: asNullableString(boardRaw.noteId),
      title: asString(boardRaw.title, '未命名画板'),
      background: asString(boardRaw.background, 'dot'),
      snapshot: asJson(boardRaw.snapshot, {}),
      thumbnailKey: asNullableString(boardRaw.thumbnailKey),
      createdAt: asString(boardRaw.createdAt),
      updatedAt: asString(boardRaw.updatedAt),
      deletedAt: asNullableString(boardRaw.deletedAt),
      version: asNumber(boardRaw.version, 1),
    };
    if (!board.id) return;
    const nodes = parseRows<BoardNode>(
      entry.nodes,
      `dataset.boards[${index}].nodes`,
      details,
      (row) => ({
        id: String(row.id),
        boardId: board.id,
        nodeType: asString(row.nodeType, 'process'),
        x: asNumber(row.x),
        y: asNumber(row.y),
        width: asNumber(row.width, 150),
        height: asNumber(row.height, 60),
        rotation: asNumber(row.rotation),
        zIndex: asNumber(row.zIndex),
        text: asString(row.text),
        payload: asJson(row.payload, {}),
        createdAt: asString(row.createdAt),
        updatedAt: asString(row.updatedAt),
        deletedAt: asNullableString(row.deletedAt),
        version: asNumber(row.version, 1),
      }),
    );
    const edges = parseRows<BoardEdge>(
      entry.edges,
      `dataset.boards[${index}].edges`,
      details,
      (row) => ({
        id: String(row.id),
        boardId: board.id,
        fromNodeId: asString(row.fromNodeId),
        toNodeId: asString(row.toNodeId),
        label: asString(row.label),
        style: asJson(row.style, {}),
        createdAt: asString(row.createdAt),
        updatedAt: asString(row.updatedAt),
        deletedAt: asNullableString(row.deletedAt),
        version: asNumber(row.version, 1),
      }),
    );
    const nodeIds = new Set(nodes.map((node) => node.id));
    for (const edge of edges) {
      if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
        details.push(`画板 ${board.id} 的连线 ${edge.id} 端点不存在`);
      }
    }
    boards.push({ board, nodes, edges });
  });
  return boards;
}

export async function parseBackupFile(
  bytes: Uint8Array,
  _fileName?: string,
): Promise<ParsedBackup> {
  if (bytes.byteLength > MAX_BACKUP_BYTES) {
    throw new BackupParseError('备份文件超过 2 GB 限制');
  }
  if (bytes.byteLength === 0) {
    throw new BackupParseError('备份文件为空');
  }
  if (isZip(bytes)) {
    return parseZipBackup(bytes);
  }
  return parseJsonBackup(bytes);
}
