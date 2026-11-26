/**
 * manifest 构建（P2-04）。
 *
 * manifest 是一份自描述清单：对象数量、每个文件的 SHA-256、附件哈希、
 * 画板文件、关系总数与悬空引用、设置导出白名单，以及明确的安全边界。
 * 恢复前先校验 manifest，再允许用户确认写入。
 */

import { sha256Bytes } from '../attachments/sha256';
import { BACKUP_GENERATOR, datasetCounts } from './dataset';
import { collectRelations, findDanglingRelations, relationKindCounts } from './relations';
import { sha256Text, stableStringify } from './sanitize';
import type {
  BackupAttachmentEntry,
  BackupBoardEntry,
  BackupDataset,
  BackupManifest,
  BackupManifestEntry,
  BackupPayload,
} from './types';
import { BACKUP_APP, BACKUP_FORMAT_VERSION, BACKUP_KIND } from './types';
import { fileExtension, formatBytes } from './utils';

export const ZIP_PATHS = {
  manifest: 'manifest.json',
  entities: 'data/entities.json',
  relations: 'data/relations.json',
  boards: 'boards/',
  attachments: 'attachments/',
} as const;

export function zipPathForBoard(id: string, index = 0): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'board';
  return `${ZIP_PATHS.boards}${safe}${index > 0 ? `-${index}` : ''}.json`;
}

export function zipPathForAttachment(sha256: string, fileName: string): string {
  const extension = fileExtension(fileName)
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10);
  return `${ZIP_PATHS.attachments}${sha256}${extension ? `.${extension}` : ''}`;
}

export function entitiesDocument(payload: BackupPayload): Uint8Array {
  const dataset = payload.dataset;
  const body = {
    app: payload.app,
    kind: payload.kind,
    formatVersion: payload.formatVersion,
    exportedAt: payload.exportedAt,
    appVersion: payload.appVersion,
    schemaVersion: payload.schemaVersion,
    appearance: payload.appearance,
    excludedSettings: payload.excludedSettings,
    dataset: {
      lists: dataset.lists,
      tasks: dataset.tasks,
      subtasks: dataset.subtasks,
      notes: dataset.notes,
      noteBlocks: dataset.noteBlocks,
      noteTodos: dataset.noteTodos,
      events: dataset.events,
      countdowns: dataset.countdowns,
      habits: dataset.habits,
      habitLogs: dataset.habitLogs,
      focusSessions: dataset.focusSessions,
      reviewSnapshots: dataset.reviewSnapshots,
      attachments: dataset.attachments,
      settings: dataset.settings,
    },
  };
  return new TextEncoder().encode(stableStringify(body));
}

export function boardDocument(
  board: BackupDataset['boards'][number],
): Uint8Array {
  return new TextEncoder().encode(
    stableStringify({
      version: 1,
      board: board.board,
      nodes: board.nodes,
      edges: board.edges,
    }),
  );
}

export function relationsDocument(dataset: BackupDataset): Uint8Array {
  const relations = collectRelations(dataset);
  const dangling = findDanglingRelations(relations, dataset);
  return new TextEncoder().encode(
    stableStringify({
      total: relations.length,
      byKind: relationKindCounts(relations),
      dangling,
      relations,
    }),
  );
}

export type ManifestInput = {
  payload: BackupPayload;
  entries: BackupManifestEntry[];
  boardEntries: BackupBoardEntry[];
  attachmentEntries: BackupAttachmentEntry[];
  notes?: string[];
};

export function buildManifest(input: ManifestInput): BackupManifest {
  const { payload } = input;
  const relations = collectRelations(payload.dataset);
  const dangling = findDanglingRelations(relations, payload.dataset);
  const counts = datasetCounts(payload.dataset);
  const missing = input.attachmentEntries.filter((entry) => entry.path === null);
  const notes = [
    'manifest.json 描述本次备份；data/entities.json 保存除画板外的业务行。',
    '每个 board 文件保存画板、节点与连线；附件二进制按 SHA-256 内容寻址。',
    '恢复先预览冲突并等待用户确认，默认跳过冲突，不静默覆盖。',
    '备份不包含账号、令牌、密钥、WebDAV 密码或同步游标。',
  ];
  if (missing.length > 0) {
    notes.push(`有 ${missing.length} 个附件没有二进制，仅恢复元数据。`);
  }
  if (dangling.length > 0) {
    notes.push(
      `数据中有 ${dangling.length} 条悬空关系；恢复时相关对象会被阻止并报告。`,
    );
  }
  notes.push(...(input.notes ?? []));

  return {
    app: BACKUP_APP,
    kind: BACKUP_KIND,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: payload.exportedAt,
    appVersion: payload.appVersion,
    schemaVersion: payload.schemaVersion,
    generator: BACKUP_GENERATOR,
    counts,
    entries: input.entries,
    boards: input.boardEntries,
    attachments: input.attachmentEntries,
    relations: {
      total: relations.length,
      byKind: relationKindCounts(relations),
      dangling,
    },
    settings: {
      exportedKeys: payload.dataset.settings.map((row) => row.key).sort(),
      excludedKeys: [...payload.excludedSettings].sort(),
    },
    security: {
      secretsExcluded: true,
      encryptedNotes: payload.dataset.notes.filter((note) => note.encrypted)
        .length,
      noteEncryptionKeyIncluded: false,
      excludedScopes: [
        '账号与登录态',
        '设备令牌 / 配对码',
        'WebDAV 密码与同步游标',
        '账号 / 令牌 / 设备密钥',
        'API 密钥与环境变量',
        '笔记加密明文主密钥（备份仅含受口令保护的密文）',
      ],
    },
    notes,
  };
}

export function entryFor(path: string, bytes: Uint8Array): BackupManifestEntry {
  return {
    path,
    byteSize: bytes.byteLength,
    sha256: sha256Bytes(bytes),
  };
}

export function manifestBytes(manifest: BackupManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest, null, 2));
}

export function describeArchiveSize(bytes: number): string {
  return formatBytes(bytes);
}

export function sectionHash(value: unknown): string {
  return sha256Text(stableStringify(value));
}
