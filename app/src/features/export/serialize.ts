/**
 * 导出格式序列化（P2-04）。
 *
 * - JSON：单文件、可读、包含业务行与画板；不含附件二进制。
 * - ZIP：manifest + entities + relations + 每画板 JSON + 附件二进制。
 * - Markdown：面向阅读与迁移的全文导出。
 * - CSV：多张表的 ZIP，便于表格工具打开。
 *
 * 所有格式都只使用 BackupPayload 中的业务数据与白名单设置。
 */

import { sha256Bytes } from '../attachments/sha256';
import { htmlToMarkdown, noteFolderName } from '../../data/repositories/notes';
import type { JsonValue } from '../../data/db/types';
import { datasetCounts } from './dataset';
import { COLLECTION_LABELS, entityLabel } from './labels';
import {
  boardDocument,
  buildManifest,
  entryFor,
  entitiesDocument,
  manifestBytes,
  relationsDocument,
  zipPathForAttachment,
  zipPathForBoard,
  ZIP_PATHS,
} from './manifest';
import { collectRelations, findDanglingRelations } from './relations';
import {
  backupTimestamp,
  stableStringify,
} from './sanitize';
import type {
  BackupAttachmentEntry,
  BackupBoardEntry,
  BackupManifest,
  BackupPayload,
  BackupRelation,
} from './types';
import { createZip, type ZipWriteEntry } from './zip';
import { formatDateTime } from './utils';

export type SerializedExport = {
  fileName: string;
  mime: string;
  bytes: Uint8Array;
  manifest?: BackupManifest;
  warnings: string[];
};

export function exportFileName(
  prefix: string,
  extension: string,
  now: Date,
): string {
  return `${prefix}-${backupTimestamp(now)}.${extension}`;
}

function boardPath(boardId: string, used: Set<string>): string {
  let index = 0;
  let path = zipPathForBoard(boardId, index);
  while (used.has(path)) {
    index += 1;
    path = zipPathForBoard(boardId, index);
  }
  used.add(path);
  return path;
}

function attachmentEntries(
  payload: BackupPayload,
  blobs?: Map<string, Blob>,
): { entries: BackupAttachmentEntry[] } {
  const used = new Set<string>();
  const entries: BackupAttachmentEntry[] = [];

  for (const attachment of payload.dataset.attachments) {
    const blob = blobs?.get(attachment.id) ?? null;
    let path: string | null = null;
    if (blob) {
      path = zipPathForAttachment(attachment.sha256, attachment.fileName);
      while (used.has(path)) {
        path = path.replace(/(\.[^./]+)?$/, `-dup$1`);
      }
      used.add(path);
    }
    entries.push({
      id: attachment.id,
      fileName: attachment.fileName,
      mime: attachment.mime,
      sha256: attachment.sha256,
      byteSize: attachment.byteSize,
      path,
      deletedAt: attachment.deletedAt,
    });
  }
  return { entries };
}

/** ZIP 构建是异步的（读取 Blob + 哈希校验）。 */
export async function buildZipBackup(
  payload: BackupPayload,
  blobs: Map<string, Blob>,
  now: Date = new Date(),
): Promise<SerializedExport> {
  const entries: ZipWriteEntry[] = [];
  const manifestEntries = [];
  const warnings: string[] = [];
  const usedPaths = new Set<string>();

  const entities = entitiesDocument(payload);
  entries.push({ path: ZIP_PATHS.entities, data: entities });
  manifestEntries.push(entryFor(ZIP_PATHS.entities, entities));

  const relations = relationsDocument(payload.dataset);
  entries.push({ path: ZIP_PATHS.relations, data: relations });
  manifestEntries.push(entryFor(ZIP_PATHS.relations, relations));

  const boardEntries: BackupBoardEntry[] = [];
  for (const board of payload.dataset.boards) {
    const path = boardPath(board.board.id, usedPaths);
    const bytes = boardDocument(board);
    entries.push({ path, data: bytes });
    manifestEntries.push(entryFor(path, bytes));
    boardEntries.push({
      id: board.board.id,
      title: board.board.title,
      noteId: board.board.noteId,
      path,
      sha256: sha256Bytes(bytes),
      nodeCount: board.nodes.length,
      edgeCount: board.edges.length,
    });
  }

  const attachmentMeta = attachmentEntries(payload, blobs);
  const attachmentResults: BackupAttachmentEntry[] = [];
  for (const entry of attachmentMeta.entries) {
    if (!entry.path) {
      warnings.push(
        `附件 ${entry.fileName} 的二进制不在本机，ZIP 未包含该文件`,
      );
      attachmentResults.push(entry);
      continue;
    }
    const blob = blobs.get(entry.id);
    if (!blob) {
      attachmentResults.push({ ...entry, path: null });
      continue;
    }
    const data = new Uint8Array(await blob.arrayBuffer());
    const actual = sha256Bytes(data);
    if (actual !== entry.sha256 || data.byteLength !== entry.byteSize) {
      warnings.push(
        `附件 ${entry.fileName} 的 SHA-256 或大小与元数据不一致，ZIP 未包含该文件`,
      );
      attachmentResults.push({ ...entry, path: null });
      continue;
    }
    entries.push({ path: entry.path, data });
    manifestEntries.push(entryFor(entry.path, data));
    attachmentResults.push(entry);
  }

  const manifest = buildManifest({
    payload,
    entries: manifestEntries,
    boardEntries,
    attachmentEntries: attachmentResults,
    notes: warnings,
  });
  const manifestFile = manifestBytes(manifest);
  const zipEntries: ZipWriteEntry[] = [
    { path: ZIP_PATHS.manifest, data: manifestFile },
    ...entries,
  ];
  const bytes = createZip(zipEntries, now);

  return {
    fileName: exportFileName('zhixing-backup', 'zip', now),
    mime: 'application/zip',
    bytes,
    manifest,
    warnings,
  };
}

export function buildJsonBackup(
  payload: BackupPayload,
  now: Date = new Date(),
): SerializedExport {
  const relations = collectRelations(payload.dataset);
  const dangling = findDanglingRelations(relations, payload.dataset);
  const attachmentMeta = attachmentEntries(payload);
  const warnings: string[] = [];
  if (dangling.length > 0) {
    warnings.push(`有 ${dangling.length} 条悬空关系，恢复时会被阻止`);
  }
  if (payload.dataset.attachments.length > 0) {
    warnings.push(
      'JSON 备份只包含附件元数据与哈希，不包含附件二进制；需要完整文件请导出 ZIP',
    );
  }
  const manifest = buildManifest({
    payload,
    entries: [],
    boardEntries: payload.dataset.boards.map((board) => ({
      id: board.board.id,
      title: board.board.title,
      noteId: board.board.noteId,
      path: '',
      sha256: sha256Bytes(boardDocument(board)),
      nodeCount: board.nodes.length,
      edgeCount: board.edges.length,
    })),
    attachmentEntries: attachmentMeta.entries,
    notes: warnings,
  });

  const body = {
    app: payload.app,
    kind: payload.kind,
    formatVersion: payload.formatVersion,
    exportedAt: payload.exportedAt,
    appVersion: payload.appVersion,
    schemaVersion: payload.schemaVersion,
    appearance: payload.appearance,
    excludedSettings: payload.excludedSettings,
    dataset: payload.dataset,
    relations,
    manifest,
  };
  const text = `${JSON.stringify(body, null, 2)}\n`;
  return {
    fileName: exportFileName('zhixing-backup', 'json', now),
    mime: 'application/json;charset=utf-8',
    bytes: new TextEncoder().encode(text),
    manifest,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function blockText(payload: JsonValue): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }
  const record = payload as Record<string, JsonValue>;
  const candidates = ['text', 'html', 'code', 'title', 'label', 'url'];
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      if (key === 'html') {
        return htmlToMarkdown(value).trim();
      }
      return value.trim();
    }
  }
  return '';
}

function noteMarkdown(
  payload: BackupPayload,
  noteId: string,
): string {
  const note = payload.dataset.notes.find((item) => item.id === noteId);
  if (!note) return '';
  const blocks = payload.dataset.noteBlocks
    .filter((block) => block.noteId === noteId && !block.deletedAt)
    .sort((a, b) => a.orderKey - b.orderKey)
    .map((block) => blockText(block.payload))
    .filter(Boolean);
  if (note.body && note.body.trim()) {
    return note.bodyFormat === 'html'
      ? htmlToMarkdown(note.body).trim()
      : note.body.trim();
  }
  return blocks.join('\n\n').trim();
}

function markdownEscapeLine(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function relationLines(relations: ReadonlyArray<BackupRelation>): string[] {
  return relations.map(
    (relation) =>
      `- ${COLLECTION_LABELS[relation.fromCollection] ?? relation.fromCollection} \`${relation.fromId}\` · ${relation.field} → ${COLLECTION_LABELS[relation.toCollection] ?? relation.toCollection} \`${relation.toId}\`（${relation.kind}）`,
  );
}

export function buildMarkdownExport(
  payload: BackupPayload,
  now: Date = new Date(),
): SerializedExport {
  const lines: string[] = [];
  const counts = datasetCounts(payload.dataset);
  lines.push('# 知行 · 完整导出');
  lines.push('');
  lines.push(`- 导出时间：${formatDateTime(payload.exportedAt)}`);
  lines.push(`- 应用版本：${payload.appVersion}`);
  lines.push(`- 数据库 schema：v${payload.schemaVersion}`);
  lines.push(
    `- 对象：${counts.lists} 清单 / ${counts.tasks} 任务 / ${counts.notes} 笔记 / ${counts.boards} 画板 / ${counts.attachments} 附件`,
  );
  lines.push('- 附件二进制不在此 Markdown 中；完整文件请使用 ZIP 备份。');
  lines.push('');

  lines.push('## 任务');
  lines.push('');
  if (payload.dataset.tasks.length === 0) {
    lines.push('_没有任务_');
  } else {
    const listNames = new Map(
      payload.dataset.lists.map((list) => [list.id, list.name]),
    );
    for (const task of payload.dataset.tasks.slice().sort((a, b) => {
      if (a.deletedAt !== b.deletedAt) return a.deletedAt ? 1 : -1;
      return a.sortOrder - b.sortOrder;
    })) {
      const mark = task.status === 'done' ? 'x' : ' ';
      const due = task.dueDate ? ` · 截止 ${task.dueDate}` : '';
      const list = listNames.get(task.listId) ?? task.listId;
      lines.push(
        `- [${mark}] ${markdownEscapeLine(task.title)} — ${list}${due}${task.deletedAt ? '（回收站）' : ''}`,
      );
      if (task.notes.trim()) {
        lines.push(`  > ${markdownEscapeLine(task.notes).replace(/\n/g, '\n  > ')}`);
      }
    }
  }
  lines.push('');

  lines.push('## 知识');
  lines.push('');
  if (payload.dataset.notes.length === 0) {
    lines.push('_没有笔记_');
  } else {
    const visible = payload.dataset.notes
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
    for (const note of visible) {
      lines.push(
        `### ${markdownEscapeLine(note.title || '未命名笔记')}${note.deletedAt ? '（回收站）' : ''}`,
      );
      lines.push('');
      lines.push(
        `- 目录：${noteFolderName(note.folderId)} · 标签：${
          note.tags.length ? note.tags.join('、') : '无'
        }${note.favorite ? ' · 收藏' : ''}${note.pinned ? ' · 置顶' : ''}`,
      );
      const body = noteMarkdown(payload, note.id);
      if (body) {
        lines.push('');
        lines.push(body);
      }
      lines.push('');
    }
  }

  lines.push('## 画板');
  lines.push('');
  if (payload.dataset.boards.length === 0) {
    lines.push('_没有画板_');
  } else {
    for (const board of payload.dataset.boards) {
      lines.push(
        `### ${markdownEscapeLine(board.board.title)}${board.board.deletedAt ? '（回收站）' : ''}`,
      );
      lines.push('');
      lines.push(`- 对象 ${board.nodes.length} 个 / 连线 ${board.edges.length} 条`);
      for (const node of board.nodes.filter((item) => !item.deletedAt)) {
        lines.push(`  - ${node.nodeType}：${markdownEscapeLine(node.text || node.id)}`);
      }
      lines.push('');
    }
  }

  lines.push('## 复盘');
  lines.push('');
  if (payload.dataset.reviewSnapshots.length === 0) {
    lines.push('_没有复盘快照_');
  } else {
    for (const snapshot of payload.dataset.reviewSnapshots) {
      lines.push(
        `- ${snapshot.rangeStart} → ${snapshot.rangeEnd} · ${snapshot.taskIds.length} 任务 / ${snapshot.focusIds.length} 专注 / ${snapshot.habitIds.length} 习惯${snapshot.deletedAt ? '（回收站）' : ''}`,
      );
    }
  }
  lines.push('');

  lines.push('## 附件');
  lines.push('');
  if (payload.dataset.attachments.length === 0) {
    lines.push('_没有附件_');
  } else {
    for (const attachment of payload.dataset.attachments) {
      lines.push(
        `- ${attachment.fileName} · ${attachment.byteSize} B · SHA-256 \`${attachment.sha256}\`${attachment.deletedAt ? '（回收站）' : ''}`,
      );
    }
  }
  lines.push('');

  lines.push('## 关系');
  lines.push('');
  const relations = collectRelations(payload.dataset);
  if (relations.length === 0) {
    lines.push('_没有跨对象关系_');
  } else {
    lines.push(...relationLines(relations));
  }
  lines.push('');

  lines.push('## 设备偏好（白名单）');
  lines.push('');
  if (payload.dataset.settings.length === 0) {
    lines.push('_没有可导出的偏好_');
  } else {
    for (const setting of payload.dataset.settings) {
      lines.push(`- \`${setting.key}\` = ${stableStringify(setting.value)}`);
    }
  }
  lines.push('');

  const text = `${lines.join('\n')}\n`;
  return {
    fileName: exportFileName('zhixing-notes', 'md', now),
    mime: 'text/markdown;charset=utf-8',
    bytes: new TextEncoder().encode(text),
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : stableStringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function csvTable<T extends Record<string, unknown>>(
  rows: ReadonlyArray<T>,
  columns: ReadonlyArray<keyof T & string>,
): Uint8Array {
  const lines = [columns.map((column) => csvCell(column)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(','));
  }
  return new TextEncoder().encode(`﻿${lines.join('\r\n')}\r\n`);
}

export function buildCsvArchive(
  payload: BackupPayload,
  now: Date = new Date(),
): SerializedExport {
  const dataset = payload.dataset;
  const entries: ZipWriteEntry[] = [
    {
      path: 'lists.csv',
      data: csvTable(dataset.lists, [
        'id',
        'name',
        'color',
        'icon',
        'parentId',
        'sortOrder',
        'isInbox',
        'deletedAt',
      ]),
    },
    {
      path: 'tasks.csv',
      data: csvTable(dataset.tasks, [
        'id',
        'listId',
        'parentId',
        'noteId',
        'title',
        'notes',
        'status',
        'priority',
        'quadrant',
        'dueDate',
        'dueTime',
        'dueAt',
        'reminder',
        'sortOrder',
        'completedAt',
        'deletedAt',
      ]),
    },
    {
      path: 'subtasks.csv',
      data: csvTable(dataset.subtasks, [
        'id',
        'taskId',
        'title',
        'done',
        'sortOrder',
        'deletedAt',
      ]),
    },
    {
      path: 'notes.csv',
      data: csvTable(dataset.notes, [
        'id',
        'title',
        'folderId',
        'tags',
        'body',
        'bodyFormat',
        'status',
        'favorite',
        'pinned',
        'deletedAt',
      ]),
    },
    {
      path: 'note_blocks.csv',
      data: csvTable(dataset.noteBlocks, [
        'id',
        'noteId',
        'blockType',
        'orderKey',
        'payload',
        'schemaVersion',
        'deletedAt',
      ]),
    },
    {
      path: 'note_todos.csv',
      data: csvTable(dataset.noteTodos, [
        'id',
        'noteId',
        'taskId',
        'title',
        'done',
        'dueDate',
        'reminderEnabled',
        'sortOrder',
        'deletedAt',
      ]),
    },
    {
      path: 'events.csv',
      data: csvTable(dataset.events, [
        'id',
        'title',
        'eventType',
        'allDay',
        'startDate',
        'startAt',
        'endAt',
        'repeatRule',
        'calendarType',
        'noteId',
        'deletedAt',
      ]),
    },
    {
      path: 'countdowns.csv',
      data: csvTable(dataset.countdowns, [
        'id',
        'title',
        'category',
        'calendarType',
        'targetDate',
        'repeatRule',
        'note',
        'deletedAt',
      ]),
    },
    {
      path: 'habits.csv',
      data: csvTable(dataset.habits, [
        'id',
        'title',
        'schedule',
        'goalPerWeek',
        'archived',
        'sortOrder',
        'deletedAt',
      ]),
    },
    {
      path: 'habit_logs.csv',
      data: csvTable(dataset.habitLogs, [
        'id',
        'habitId',
        'logDate',
        'done',
        'note',
        'deletedAt',
      ]),
    },
    {
      path: 'focus_sessions.csv',
      data: csvTable(dataset.focusSessions, [
        'id',
        'taskId',
        'minutes',
        'startedAt',
        'endedAt',
        'mode',
        'note',
        'deletedAt',
      ]),
    },
    {
      path: 'review_snapshots.csv',
      data: csvTable(dataset.reviewSnapshots, [
        'id',
        'rangeStart',
        'rangeEnd',
        'taskIds',
        'focusIds',
        'habitIds',
        'noteId',
        'deletedAt',
      ]),
    },
    {
      path: 'boards.csv',
      data: csvTable(
        dataset.boards.map((board) => ({
          id: board.board.id,
          title: board.board.title,
          noteId: board.board.noteId,
          nodes: board.nodes.length,
          edges: board.edges.length,
          deletedAt: board.board.deletedAt,
        })),
        ['id', 'title', 'noteId', 'nodes', 'edges', 'deletedAt'],
      ),
    },
    {
      path: 'attachments.csv',
      data: csvTable(dataset.attachments, [
        'id',
        'noteId',
        'blockId',
        'fileName',
        'sha256',
        'byteSize',
        'mime',
        'deletedAt',
      ]),
    },
    {
      path: 'settings.csv',
      data: csvTable(dataset.settings, ['key', 'scope', 'value', 'deletedAt']),
    },
    {
      path: 'relations.csv',
      data: csvTable(
        collectRelations(dataset).map((relation) => ({ ...relation })),
        [
          'kind',
          'fromCollection',
          'fromId',
          'field',
          'toCollection',
          'toId',
        ],
      ),
    },
  ];

  const manifest = {
    format: 'zhixing-csv-tables',
    formatVersion: 1,
    exportedAt: payload.exportedAt,
    appVersion: payload.appVersion,
    schemaVersion: payload.schemaVersion,
    counts: datasetCounts(dataset),
    files: entries.map((entry) => entry.path),
    notes: [
      'UTF-8 BOM，逗号分隔；复杂字段使用 JSON 字符串。',
      'CSV 不是恢复格式；恢复请使用 JSON/ZIP 备份。',
      '不包含附件二进制。',
    ],
  };
  entries.push({
    path: 'manifest.json',
    data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  });

  return {
    fileName: exportFileName('zhixing-tables', 'zip', now),
    mime: 'application/zip',
    bytes: createZip(entries, now),
    warnings: [],
  };
}

/** 供 UI 展示导出摘要。 */
export function describePayload(payload: BackupPayload): string {
  const counts = datasetCounts(payload.dataset);
  return `${counts.lists} 清单 · ${counts.tasks} 任务 · ${counts.notes} 笔记 · ${counts.boards} 画板 · ${counts.attachments} 附件`;
}

/** 关系数量；测试与诊断使用。 */
export function payloadRelationCount(payload: BackupPayload): number {
  return collectRelations(payload.dataset).length;
}

/** 让类型检查确认实体标签可用（UI 复用同一实现）。 */
export const labelForEntity = entityLabel;
