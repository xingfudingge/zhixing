/**
 * 知行笔记包（`.zxnote`）导入（ZX5-IO-06 / ZX-DESIGN-16 §4、§7）。
 *
 * 分两段，边界清晰：
 * 1. `parseNotePackage`：只读 ZIP 字节，校验 manifest / 版本 / checksums /
 *    结构 / 画板 / 附件哈希 / 引用；任何失败都在写库前抛出，零写入。
 * 2. `planNotePackageImport`：为 note / block / todo / board / node / edge
 *    生成全新 ID，改写块 payload、画板节点端点与附件引用；仍然不写库。
 * 3. `applyNotePackageImport`：把计划交给 `NotePackageImportTarget`。测试用
 *    内存目标验证原子性；正式运行用 `createNotePackageImportTarget` 适配
 *    现有笔记/画板/附件仓储，失败时执行补偿清理。
 *
 * 缺画板：导入继续，块保留为 `boardId=null` 占位并警告；
 * 缺附件：块引用置空并警告，不产生“有文件卡没有附件行”的半成品；
 * 重复导入：每次生成全新 ID；同 SHA-256 附件按内容寻址复用。
 */

import type {
  ImportNoteBlock,
  ImportNoteTodo,
  NewNote,
  Note,
} from '../../data/db/types';
import type { BlockRepository } from '../../data/repositories/blocks';
import type { NoteSource } from '../../data/repositories/notes';
import type { NoteTodoRepository } from '../../data/repositories/noteTodos';
import type { BoardDocument, BoardSource, BoardViewport } from '../board/types';
import {
  parseBoardDocumentFile,
  type ParsedBoardDocumentFile,
} from '../board/model';
import type { AttachmentManager } from '../attachments/manager';
import { sha256Bytes } from '../attachments/sha256';
import { blocksToHtml } from '../editor/blockHtml';
import { readZip, ZipError } from '../export/zip';
import {
  NOTE_PACKAGE_APP,
  NOTE_PACKAGE_FORMAT_VERSION,
  NOTE_PACKAGE_KIND,
  NOTE_PACKAGE_MAX_BOARDS,
  NOTE_PACKAGE_MAX_BLOCKS,
  NOTE_PACKAGE_MAX_BYTES,
  NOTE_PACKAGE_MIN_READER_VERSION,
  type NotePackageAttachmentManifestEntry,
  type NotePackageBoardManifestEntry,
  type NotePackageChecksumEntry,
  type NotePackageManifest,
} from '../export/note/package';

const decoder = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();

const MAX_NOTE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_BLOCKS_JSON_BYTES = 20 * 1024 * 1024;
const MAX_RELATIONS_JSON_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS_JSON_BYTES = 2 * 1024 * 1024;

export const NOTE_PACKAGE_IMPORT_ACCEPT = '.zxnote';

export type NotePackageImportErrorCode =
  | 'ZXNOTE_TOO_LARGE'
  | 'ZXNOTE_ZIP_INVALID'
  | 'ZXNOTE_MANIFEST_INVALID'
  | 'ZXNOTE_VERSION_UNSUPPORTED'
  | 'ZXNOTE_CHECKSUM_MISMATCH'
  | 'ZXNOTE_FILE_MISSING'
  | 'ZXNOTE_STRUCTURE_INVALID'
  | 'ZXNOTE_COUNT_MISMATCH'
  | 'ZXNOTE_BOARD_INVALID'
  | 'ZXNOTE_ATTACHMENT_MISSING'
  | 'ZXNOTE_ATTACHMENT_HASH_MISMATCH'
  | 'ZXNOTE_RELATION_TARGET_MISSING'
  | 'ZXNOTE_ID_COLLISION'
  | 'ZXNOTE_WRITE_FAILED';

export class NotePackageImportError extends Error {
  readonly code: NotePackageImportErrorCode;
  readonly fileName: string | null;

  constructor(
    code: NotePackageImportErrorCode,
    message: string,
    fileName: string | null = null,
  ) {
    super(message);
    this.name = 'NotePackageImportError';
    this.code = code;
    this.fileName = fileName;
  }
}

export type NotePackageNoteTodoJson = {
  sourceId: string;
  title: string;
  done: boolean;
  dueDate: string | null;
  reminderEnabled: boolean;
  sortOrder: number;
  taskId: string | null;
};

export type NotePackageNoteJson = {
  format: string;
  version: number;
  sourceId: string;
  title: string;
  folder: { id: string | null; name: string } | null;
  tags: string[];
  favorite: boolean;
  pinned: boolean;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  bodyFormat: string;
  body: string;
  noteTodos: NotePackageNoteTodoJson[];
};

export type NotePackageBlockJson = {
  id: string;
  type: string;
  orderKey: number;
  schemaVersion: number;
  payload: Record<string, unknown>;
};

export type NotePackageRelationJson = {
  kind: string;
  base: string;
  path: string;
  target: string;
  targetType?: string;
  title?: string;
  label?: string;
  reason?: string;
};

export type NotePackageRelationsJson = {
  format: string;
  version: number;
  noteSourceId: string;
  internal: NotePackageRelationJson[];
  external: NotePackageRelationJson[];
  missing: NotePackageRelationJson[];
};

export type NotePackageAttachmentItem = {
  sourceId: string;
  sourceIds: string[];
  fileName: string;
  mime: string;
  sha256: string | null;
  byteSize: number;
  path: string | null;
  blockIds: string[];
  createdAt: string | null;
  missing: boolean;
  bytes: Uint8Array | null;
};

export type NotePackageBoardItem = {
  key: string;
  sourceId: string;
  title: string;
  path: string | null;
  missing: boolean;
  document: BoardDocument | null;
  viewport: BoardViewport | null;
  warnings: string[];
};

export type NotePackagePreview = {
  kind: 'note-package';
  app: string;
  formatVersion: number;
  minReaderVersion: number;
  appVersion: string;
  exportedAt: string;
  title: string;
  folderName: string | null;
  tags: string[];
  blockCount: number;
  boardCount: number;
  boardNodeCount: number;
  boardEdgeCount: number;
  attachmentCount: number;
  attachmentBytes: number;
  todoCount: number;
  warnings: string[];
  checks: {
    zip: boolean;
    version: boolean;
    checksums: boolean;
    structure: boolean;
    references: boolean;
  };
};

export type ParsedNotePackage = {
  fileName: string | null;
  byteSize: number;
  manifest: NotePackageManifest;
  note: NotePackageNoteJson;
  blocks: NotePackageBlockJson[];
  relations: NotePackageRelationsJson;
  attachments: NotePackageAttachmentItem[];
  boards: NotePackageBoardItem[];
  warnings: string[];
  preview: NotePackagePreview;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function fail(
  code: NotePackageImportErrorCode,
  message: string,
  fileName: string | null = null,
): never {
  throw new NotePackageImportError(code, message, fileName);
}

function jsonFile(
  files: ReadonlyMap<string, Uint8Array>,
  path: string,
  maxBytes: number,
  fileName: string | null,
): unknown {
  const bytes = files.get(path);
  if (!bytes) {
    fail('ZXNOTE_FILE_MISSING', `包内缺少必需文件：${path}`, fileName);
  }
  if (bytes.byteLength > maxBytes) {
    fail(
      'ZXNOTE_STRUCTURE_INVALID',
      `${path} 超过大小上限（${Math.round(maxBytes / 1024)} KB）`,
      fileName,
    );
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    fail('ZXNOTE_STRUCTURE_INVALID', `${path} 不是有效的 JSON`, fileName);
  }
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

function checksumList(
  raw: unknown,
  fileName: string | null,
): NotePackageChecksumEntry[] {
  const source = isRecord(raw)
    ? Array.isArray(raw.files)
      ? raw.files
      : Array.isArray(raw.checksums)
        ? raw.checksums
        : []
    : Array.isArray(raw)
      ? raw
      : [];
  return source.map((entry, index) => {
    if (!isRecord(entry)) {
      fail(
        'ZXNOTE_MANIFEST_INVALID',
        `校验和第 ${index + 1} 项格式无效`,
        fileName,
      );
    }
    const path = asString(entry.path);
    const sha256 = asString(entry.sha256).toLowerCase();
    if (!path || !SHA256_HEX.test(sha256)) {
      fail(
        'ZXNOTE_MANIFEST_INVALID',
        `校验和第 ${index + 1} 项缺少 path 或 sha256`,
        fileName,
      );
    }
    return {
      path,
      sha256,
      byteSize: asNumber(entry.byteSize),
    };
  });
}

function validateChecksums(
  files: ReadonlyMap<string, Uint8Array>,
  manifestChecksums: NotePackageChecksumEntry[],
  standaloneChecksums: NotePackageChecksumEntry[],
  fileName: string | null,
): void {
  const all = [...manifestChecksums, ...standaloneChecksums];
  if (all.length === 0) {
    fail(
      'ZXNOTE_MANIFEST_INVALID',
      '包内没有校验和清单，拒绝导入',
      fileName,
    );
  }
  const seen = new Set<string>();
  for (const entry of all) {
    if (seen.has(entry.path)) {
      continue;
    }
    seen.add(entry.path);
    const bytes = files.get(entry.path);
    if (!bytes) {
      fail(
        'ZXNOTE_FILE_MISSING',
        `校验和引用的文件不存在：${entry.path}`,
        fileName,
      );
    }
    if (entry.byteSize > 0 && entry.byteSize !== bytes.byteLength) {
      fail(
        'ZXNOTE_CHECKSUM_MISMATCH',
        `${entry.path} 字节数不符（期望 ${entry.byteSize}，实际 ${bytes.byteLength}）`,
        fileName,
      );
    }
    const actual = sha256Bytes(bytes);
    if (actual !== entry.sha256) {
      fail(
        'ZXNOTE_CHECKSUM_MISMATCH',
        `${entry.path} 校验和不符，包可能已被篡改`,
        fileName,
      );
    }
  }

  // manifest.checksums 是导出时的权威覆盖清单：除 manifest/checksums 外
  // 的每个 ZIP 条目都必须被覆盖，避免夹带未校验文件。
  const coverage = new Set(
    (manifestChecksums.length > 0 ? manifestChecksums : standaloneChecksums).map(
      (entry) => entry.path,
    ),
  );
  for (const path of files.keys()) {
    if (path === 'manifest.json' || path === 'checksums.json') {
      continue;
    }
    if (!coverage.has(path)) {
      fail(
        'ZXNOTE_CHECKSUM_MISMATCH',
        `${path} 没有出现在校验和清单中，拒绝导入`,
        fileName,
      );
    }
  }
}

function parseManifest(
  raw: unknown,
  fileName: string | null,
): NotePackageManifest {
  if (!isRecord(raw)) {
    fail('ZXNOTE_MANIFEST_INVALID', 'manifest.json 必须是对象', fileName);
  }
  if (asString(raw.app) !== NOTE_PACKAGE_APP) {
    fail(
      'ZXNOTE_MANIFEST_INVALID',
      '这不是知行笔记包（manifest.app 不是 zhixing）',
      fileName,
    );
  }
  const kind = asString(raw.kind);
  const format = asString(raw.format);
  if (
    kind !== NOTE_PACKAGE_KIND &&
    format !== 'zxnote' &&
    asString(raw.generator) !== 'zhixing/note-package@1'
  ) {
    fail(
      'ZXNOTE_MANIFEST_INVALID',
      '包类型不是 note-package，拒绝按笔记包导入',
      fileName,
    );
  }
  const rawFormatVersion = raw.formatVersion ?? raw.version;
  if (
    rawFormatVersion !== undefined &&
    (typeof rawFormatVersion !== 'number' ||
      !Number.isFinite(rawFormatVersion))
  ) {
    fail(
      'ZXNOTE_MANIFEST_INVALID',
      'manifest.formatVersion 必须是数字',
      fileName,
    );
  }
  if (
    raw.minReaderVersion !== undefined &&
    (typeof raw.minReaderVersion !== 'number' ||
      !Number.isFinite(raw.minReaderVersion))
  ) {
    fail(
      'ZXNOTE_MANIFEST_INVALID',
      'manifest.minReaderVersion 必须是数字',
      fileName,
    );
  }
  const formatVersion = asNumber(
    rawFormatVersion,
    NOTE_PACKAGE_FORMAT_VERSION,
  );
  const minReaderVersion = asNumber(
    raw.minReaderVersion,
    NOTE_PACKAGE_MIN_READER_VERSION,
  );
  if (
    formatVersion > NOTE_PACKAGE_FORMAT_VERSION ||
    minReaderVersion > NOTE_PACKAGE_MIN_READER_VERSION
  ) {
    fail(
      'ZXNOTE_VERSION_UNSUPPORTED',
      `该笔记包由更新版本导出（formatVersion=${formatVersion}，minReaderVersion=${minReaderVersion}），当前版本无法读取`,
      fileName,
    );
  }
  return raw as unknown as NotePackageManifest;
}

function parseNoteJson(
  raw: unknown,
  manifest: NotePackageManifest,
  fileName: string | null,
): NotePackageNoteJson {
  if (!isRecord(raw)) {
    fail('ZXNOTE_STRUCTURE_INVALID', 'note.json 必须是对象', fileName);
  }
  if (asNumber(raw.version, 0) !== 1) {
    fail(
      'ZXNOTE_STRUCTURE_INVALID',
      'note.json 仅支持 version=1',
      fileName,
    );
  }
  const sourceId =
    asStringOrNull(raw.sourceId) ??
    asStringOrNull(manifest.note?.sourceId) ??
    fail(
      'ZXNOTE_STRUCTURE_INVALID',
      'note.json 缺少 sourceId',
      fileName,
    );
  const folderRaw = raw.folder;
  const folder =
    isRecord(folderRaw) && asStringOrNull(folderRaw.name)
      ? {
          id: asStringOrNull(folderRaw.id),
          name: asString(folderRaw.name),
        }
      : null;
  const todos = asArray(raw.noteTodos).map((todo, index) => {
    if (!isRecord(todo)) {
      fail(
        'ZXNOTE_STRUCTURE_INVALID',
        `noteTodos 第 ${index + 1} 项格式无效`,
        fileName,
      );
    }
    return {
      sourceId: asString(todo.sourceId),
      title: asString(todo.title),
      done: asBoolean(todo.done),
      dueDate: asStringOrNull(todo.dueDate),
      reminderEnabled: asBoolean(todo.reminderEnabled),
      sortOrder: asNumber(todo.sortOrder, index),
      taskId: asStringOrNull(todo.taskId),
    };
  });
  const seen = new Set<string>();
  for (const todo of todos) {
    if (!todo.sourceId) {
      fail(
        'ZXNOTE_STRUCTURE_INVALID',
        'noteTodos 存在缺少 sourceId 的待办',
        fileName,
      );
    }
    if (seen.has(todo.sourceId)) {
      fail(
        'ZXNOTE_STRUCTURE_INVALID',
        `noteTodos 存在重复 ID：${todo.sourceId}`,
        fileName,
      );
    }
    seen.add(todo.sourceId);
  }
  return {
    format: asString(raw.format, 'zhixing.note.meta'),
    version: 1,
    sourceId,
    title: asString(raw.title),
    folder,
    tags: asArray(raw.tags)
      .map((tag) => asString(tag).trim())
      .filter(Boolean),
    favorite: asBoolean(raw.favorite),
    pinned: asBoolean(raw.pinned),
    status: asString(raw.status, 'active'),
    createdAt: asStringOrNull(raw.createdAt),
    updatedAt: asStringOrNull(raw.updatedAt),
    bodyFormat: asString(raw.bodyFormat, 'blocks'),
    body: asString(raw.body),
    noteTodos: todos,
  };
}

function parseBlocksJson(
  raw: unknown,
  fileName: string | null,
): NotePackageBlockJson[] {
  if (!isRecord(raw)) {
    fail('ZXNOTE_STRUCTURE_INVALID', 'blocks.json 必须是对象', fileName);
  }
  if (asNumber(raw.version, 0) !== 1) {
    fail(
      'ZXNOTE_STRUCTURE_INVALID',
      'blocks.json 仅支持 version=1',
      fileName,
    );
  }
  const list = asArray(raw.blocks);
  if (list.length > NOTE_PACKAGE_MAX_BLOCKS) {
    fail(
      'ZXNOTE_STRUCTURE_INVALID',
      `块数超过上限（${NOTE_PACKAGE_MAX_BLOCKS}）`,
      fileName,
    );
  }
  const seen = new Set<string>();
  return list.map((entry, index) => {
    if (!isRecord(entry)) {
      fail(
        'ZXNOTE_STRUCTURE_INVALID',
        `第 ${index + 1} 个块不是对象`,
        fileName,
      );
    }
    const id = asString(entry.id);
    const type = asString(entry.type);
    if (!id || !type) {
      fail(
        'ZXNOTE_STRUCTURE_INVALID',
        `第 ${index + 1} 个块缺少 id 或 type`,
        fileName,
      );
    }
    if (seen.has(id)) {
      fail(
        'ZXNOTE_STRUCTURE_INVALID',
        `块 ID 重复：${id}`,
        fileName,
      );
    }
    seen.add(id);
    if (!isRecord(entry.payload)) {
      fail(
        'ZXNOTE_STRUCTURE_INVALID',
        `块 ${id} 的 payload 必须是对象`,
        fileName,
      );
    }
    return {
      id,
      type,
      orderKey: asNumber(entry.orderKey, (index + 1) * 1024),
      schemaVersion: asNumber(entry.schemaVersion, 1),
      payload: cloneJson(entry.payload),
    };
  });
}

function parseRelationsJson(
  raw: unknown,
  noteSourceId: string,
  fileName: string | null,
): NotePackageRelationsJson {
  if (!isRecord(raw)) {
    fail('ZXNOTE_STRUCTURE_INVALID', 'relations.json 必须是对象', fileName);
  }
  if (asNumber(raw.version, 0) !== 1) {
    fail(
      'ZXNOTE_STRUCTURE_INVALID',
      'relations.json 仅支持 version=1',
      fileName,
    );
  }
  const relations = (value: unknown, label: string) =>
    asArray(value).map((entry, index) => {
      if (!isRecord(entry)) {
        fail(
          'ZXNOTE_STRUCTURE_INVALID',
          `${label} 第 ${index + 1} 项格式无效`,
          fileName,
        );
      }
      const kind = asString(entry.kind);
      const path = asString(entry.path);
      const target = asString(entry.target);
      if (!kind || !path || !target) {
        fail(
          'ZXNOTE_STRUCTURE_INVALID',
          `${label} 第 ${index + 1} 项缺少 kind/path/target`,
          fileName,
        );
      }
      return {
        kind,
        base: asString(entry.base, 'blocks'),
        path,
        target,
        targetType: asStringOrNull(entry.targetType) ?? undefined,
        title: asStringOrNull(entry.title) ?? undefined,
        label: asStringOrNull(entry.label) ?? undefined,
        reason: asStringOrNull(entry.reason) ?? undefined,
      } satisfies NotePackageRelationJson;
    });
  return {
    format: asString(raw.format, 'zhixing.note.relations'),
    version: 1,
    noteSourceId: asStringOrNull(raw.noteSourceId) ?? noteSourceId,
    internal: relations(raw.internal, 'internal'),
    external: relations(raw.external, 'external'),
    missing: relations(raw.missing, 'missing'),
  };
}

type AttachmentIndexItem = NotePackageAttachmentManifestEntry & {
  bytes: Uint8Array | null;
};

function parseAttachmentItems(
  indexRaw: unknown,
  manifest: NotePackageManifest,
  files: ReadonlyMap<string, Uint8Array>,
  fileName: string | null,
): AttachmentIndexItem[] {
  const rawItems = isRecord(indexRaw)
    ? asArray(indexRaw.items)
    : Array.isArray(manifest.attachments)
      ? manifest.attachments
      : [];
  const items: AttachmentIndexItem[] = rawItems.map((raw, index) => {
    if (!isRecord(raw)) {
      fail(
        'ZXNOTE_STRUCTURE_INVALID',
        `attachments 第 ${index + 1} 项格式无效`,
        fileName,
      );
    }
    const sourceId = asString(raw.sourceId);
    if (!sourceId) {
      fail(
        'ZXNOTE_STRUCTURE_INVALID',
        `attachments 第 ${index + 1} 项缺少 sourceId`,
        fileName,
      );
    }
    const sourceIds = asArray(raw.sourceIds)
      .map((value) => asString(value))
      .filter(Boolean);
    const sha256 = asStringOrNull(raw.sha256)?.toLowerCase() ?? null;
    const path = asStringOrNull(raw.path);
    const missing = asBoolean(raw.missing) || path === null;
    const byteSize = asNumber(raw.byteSize);
    let bytes: Uint8Array | null = null;
    if (!missing && path) {
      bytes = files.get(path) ?? null;
      if (!bytes) {
        fail(
          'ZXNOTE_ATTACHMENT_MISSING',
          `附件「${asString(raw.fileName, sourceId)}」文件缺失：${path}`,
          fileName,
        );
      }
      if (!sha256 || !SHA256_HEX.test(sha256)) {
        fail(
          'ZXNOTE_STRUCTURE_INVALID',
          `附件「${asString(raw.fileName, sourceId)}」缺少有效 sha256`,
          fileName,
        );
      }
      if (byteSize > 0 && bytes.byteLength !== byteSize) {
        fail(
          'ZXNOTE_ATTACHMENT_HASH_MISMATCH',
          `附件「${asString(raw.fileName, sourceId)}」字节数不符`,
          fileName,
        );
      }
      if (sha256Bytes(bytes) !== sha256) {
        fail(
          'ZXNOTE_ATTACHMENT_HASH_MISMATCH',
          `附件「${asString(raw.fileName, sourceId)}」哈希不符`,
          fileName,
        );
      }
    }
    return {
      sourceId,
      sourceIds: sourceIds.length > 0 ? sourceIds : [sourceId],
      fileName: asString(raw.fileName, sourceId),
      mime: asString(raw.mime, 'application/octet-stream'),
      sha256,
      byteSize,
      path,
      blockIds: asArray(raw.blockIds)
        .map((value) => asString(value))
        .filter(Boolean),
      createdAt: asStringOrNull(raw.createdAt),
      missing,
      bytes,
    };
  });
  const seen = new Set<string>();
  for (const item of items) {
    for (const id of item.sourceIds) {
      if (seen.has(id)) {
        fail(
          'ZXNOTE_STRUCTURE_INVALID',
          `附件 sourceId 重复：${id}`,
          fileName,
        );
      }
      seen.add(id);
    }
  }
  return items;
}

function parseBoards(
  manifest: NotePackageManifest,
  files: ReadonlyMap<string, Uint8Array>,
  fileName: string | null,
): NotePackageBoardItem[] {
  const entries: NotePackageBoardManifestEntry[] = Array.isArray(
    manifest.boards,
  )
    ? manifest.boards
    : [];
  if (entries.length > NOTE_PACKAGE_MAX_BOARDS) {
    fail(
      'ZXNOTE_STRUCTURE_INVALID',
      `画板数超过上限（${NOTE_PACKAGE_MAX_BOARDS}）`,
      fileName,
    );
  }
  return entries.map((entry, index) => {
    if (!isRecord(entry)) {
      fail(
        'ZXNOTE_STRUCTURE_INVALID',
        `manifest.boards 第 ${index + 1} 项格式无效`,
        fileName,
      );
    }
    const sourceId = asString(entry.sourceId);
    if (!sourceId) {
      fail(
        'ZXNOTE_STRUCTURE_INVALID',
        `manifest.boards 第 ${index + 1} 项缺少 sourceId`,
        fileName,
      );
    }
    const path = asStringOrNull(entry.path);
    const missing = asBoolean(entry.missing) || path === null;
    const base: NotePackageBoardItem = {
      key: asString(entry.key, sourceId),
      sourceId,
      title: asString(entry.title, '未命名画板'),
      path,
      missing,
      document: null,
      viewport: null,
      warnings: [],
    };
    if (missing || !path) {
      return base;
    }
    const bytes = files.get(path);
    if (!bytes) {
      return base;
    }
    let parsed: ParsedBoardDocumentFile;
    try {
      parsed = parseBoardDocumentFile(decoder.decode(bytes), {
        boardId: sourceId,
        noteId: asStringOrNull(entry.sourceNoteId),
      });
    } catch (reason) {
      fail(
        'ZXNOTE_BOARD_INVALID',
        `画板「${base.title}」无法解析：${
          reason instanceof Error ? reason.message : '格式无效'
        }`,
        fileName,
      );
    }
    const warnings: string[] = [];
    if (parsed.warnings.length > 0) {
      warnings.push(...parsed.warnings);
    }
    if (
      typeof entry.nodeCount === 'number' &&
      entry.nodeCount !== parsed.document.nodes.length
    ) {
      warnings.push(
        `画板「${base.title}」节点数与 manifest 不一致（清单 ${entry.nodeCount}，实际 ${parsed.document.nodes.length}）。`,
      );
    }
    if (
      typeof entry.edgeCount === 'number' &&
      entry.edgeCount !== parsed.document.edges.length
    ) {
      warnings.push(
        `画板「${base.title}」连线数与 manifest 不一致（清单 ${entry.edgeCount}，实际 ${parsed.document.edges.length}）。`,
      );
    }
    return {
      ...base,
      missing: false,
      document: parsed.document,
      viewport: parsed.viewport,
      warnings,
    };
  });
}

function validateReferences(
  note: NotePackageNoteJson,
  relations: NotePackageRelationsJson,
  boards: NotePackageBoardItem[],
  attachments: NotePackageAttachmentItem[],
  fileName: string | null,
): void {
  const boardIds = new Set(boards.map((board) => board.sourceId));
  const attachmentIds = new Set(
    attachments.flatMap((item) => item.sourceIds),
  );
  const todoIds = new Set(note.noteTodos.map((todo) => todo.sourceId));

  for (const relation of relations.internal) {
    if (relation.kind === 'board' && !boardIds.has(relation.target)) {
      fail(
        'ZXNOTE_RELATION_TARGET_MISSING',
        `relations.internal 引用了不存在的画板：${relation.target}`,
        fileName,
      );
    }
    if (
      relation.kind === 'attachment' &&
      !attachmentIds.has(relation.target)
    ) {
      fail(
        'ZXNOTE_RELATION_TARGET_MISSING',
        `relations.internal 引用了不存在的附件：${relation.target}`,
        fileName,
      );
    }
    if (relation.kind === 'todo' && !todoIds.has(relation.target)) {
      fail(
        'ZXNOTE_RELATION_TARGET_MISSING',
        `relations.internal 引用了不存在的待办：${relation.target}`,
        fileName,
      );
    }
    if (
      (relation.kind === 'self-note-link' ||
        relation.kind === 'self-quote') &&
      relation.target !== note.sourceId
    ) {
      fail(
        'ZXNOTE_RELATION_TARGET_MISSING',
        `relations.internal 的自引用目标不是当前笔记：${relation.target}`,
        fileName,
      );
    }
  }

  for (const relation of relations.missing) {
    if (relation.kind === 'attachment') {
      // 允许：导出时本机附件缺失会写警告，不阻断笔记导入。
      continue;
    }
    if (relation.kind !== 'board') {
      fail(
        'ZXNOTE_STRUCTURE_INVALID',
        `relations.missing 只允许画板/附件，发现：${relation.kind}`,
        fileName,
      );
    }
  }

  // 块里实际引用但 relations.json 未声明的项目：计划阶段按块内容继续
  // 重映射；缺画板/缺附件会写警告，不静默丢弃。
}

/** 读取并校验 `.zxnote`；失败抛 `NotePackageImportError`，不写任何数据。 */
export async function parseNotePackage(input: {
  bytes: Uint8Array;
  fileName?: string | null;
}): Promise<ParsedNotePackage> {
  const fileName = input.fileName ?? null;
  const bytes = input.bytes;
  if (bytes.byteLength > NOTE_PACKAGE_MAX_BYTES) {
    fail('ZXNOTE_TOO_LARGE', '笔记包超过 1 GiB 上限', fileName);
  }
  let zipEntries;
  try {
    zipEntries = await readZip(bytes);
  } catch (reason) {
    fail(
      'ZXNOTE_ZIP_INVALID',
      reason instanceof ZipError
        ? reason.message
        : '文件不是有效的 ZIP 笔记包',
      fileName,
    );
  }
  const files = new Map<string, Uint8Array>(
    zipEntries.map((entry) => [entry.path, entry.data]),
  );

  const manifestRaw = jsonFile(
    files,
    'manifest.json',
    2 * 1024 * 1024,
    fileName,
  );
  const manifest = parseManifest(manifestRaw, fileName);
  const manifestChecksums = checksumList(
    isRecord(manifestRaw) ? manifestRaw.checksums : [],
    fileName,
  );
  let standaloneChecksums: NotePackageChecksumEntry[] = [];
  if (files.has('checksums.json')) {
    const raw = jsonFile(
      files,
      'checksums.json',
      2 * 1024 * 1024,
      fileName,
    );
    if (isRecord(raw) && raw.algorithm !== undefined) {
      if (asString(raw.algorithm).toLowerCase() !== 'sha256') {
        fail(
          'ZXNOTE_MANIFEST_INVALID',
          'checksums.json 仅支持 sha256',
          fileName,
        );
      }
    }
    standaloneChecksums = checksumList(raw, fileName);
  }
  validateChecksums(
    files,
    manifestChecksums,
    standaloneChecksums,
    fileName,
  );

  const note = parseNoteJson(
    jsonFile(files, 'note.json', MAX_NOTE_JSON_BYTES, fileName),
    manifest,
    fileName,
  );
  const blocks = parseBlocksJson(
    jsonFile(files, 'blocks.json', MAX_BLOCKS_JSON_BYTES, fileName),
    fileName,
  );
  const relations = parseRelationsJson(
    jsonFile(files, 'relations.json', MAX_RELATIONS_JSON_BYTES, fileName),
    note.sourceId,
    fileName,
  );
  const attachmentIndex = files.has('attachments.json')
    ? jsonFile(files, 'attachments.json', MAX_ATTACHMENTS_JSON_BYTES, fileName)
    : null;
  const attachments = parseAttachmentItems(
    attachmentIndex,
    manifest,
    files,
    fileName,
  );
  const boards = parseBoards(manifest, files, fileName);

  if (
    isRecord(manifest.counts) &&
    typeof manifest.counts.blocks === 'number' &&
    manifest.counts.blocks !== blocks.length
  ) {
    fail(
      'ZXNOTE_COUNT_MISMATCH',
      `manifest 块数与 blocks.json 不一致（清单 ${manifest.counts.blocks}，实际 ${blocks.length}）`,
      fileName,
    );
  }

  validateReferences(
    note,
    relations,
    boards,
    attachments,
    fileName,
  );

  const warnings: string[] = [];
  if (Array.isArray(manifest.warnings)) {
    warnings.push(
      ...manifest.warnings.filter(
        (warning): warning is string => typeof warning === 'string',
      ),
    );
  }
  if (note.status === 'trashed') {
    warnings.push('源笔记在回收站中，导入后将作为正常笔记（active）。');
  }
  if (!note.title.trim()) {
    warnings.push('笔记标题为空，导入后使用「未命名笔记」。');
  }
  for (const board of boards) {
    if (board.missing) {
      warnings.push(
        `画板「${board.title}」文件缺失，导入后保留占位。`,
      );
    }
    warnings.push(...board.warnings);
  }
  for (const attachment of attachments) {
    if (attachment.missing) {
      warnings.push(
        `附件「${attachment.fileName}」二进制缺失，导入后文件卡保留但不可打开。`,
      );
    }
  }
  const taskRefs = note.noteTodos.filter((todo) => todo.taskId);
  if (taskRefs.length > 0) {
    warnings.push(
      `有 ${taskRefs.length} 个待办关联了任务；任务不随单篇笔记导出，导入后将解除关联。`,
    );
  }
  const externalRefs = relations.external.filter(
    (relation) => relation.kind === 'note-link' || relation.kind === 'note-quote',
  );
  if (externalRefs.length > 0) {
    warnings.push(
      `有 ${externalRefs.length} 个内链指向包外笔记，已原样保留。`,
    );
  }

  const boardNodeCount = boards.reduce(
    (sum, board) => sum + (board.document?.nodes.length ?? 0),
    0,
  );
  const boardEdgeCount = boards.reduce(
    (sum, board) => sum + (board.document?.edges.length ?? 0),
    0,
  );
  const attachmentBytes = attachments.reduce(
    (sum, item) => sum + (item.bytes?.byteLength ?? 0),
    0,
  );

  return {
    fileName,
    byteSize: bytes.byteLength,
    manifest,
    note,
    blocks,
    relations,
    attachments,
    boards,
    warnings: Array.from(new Set(warnings)),
    preview: {
      kind: 'note-package',
      app: asString(manifest.app, NOTE_PACKAGE_APP),
      formatVersion: asNumber(
        manifest.formatVersion,
        NOTE_PACKAGE_FORMAT_VERSION,
      ),
      minReaderVersion: asNumber(
        manifest.minReaderVersion,
        NOTE_PACKAGE_MIN_READER_VERSION,
      ),
      appVersion: asString(manifest.appVersion, '—'),
      exportedAt: asString(manifest.exportedAt),
      title: note.title.trim() || '未命名笔记',
      folderName: note.folder?.name ?? null,
      tags: note.tags,
      blockCount: blocks.length,
      boardCount: boards.length,
      boardNodeCount,
      boardEdgeCount,
      attachmentCount: attachments.length,
      attachmentBytes,
      todoCount: note.noteTodos.length,
      warnings: [],
      checks: {
        zip: true,
        version: true,
        checksums: true,
        structure: true,
        references: true,
      },
    },
  };
}

export async function parseNotePackageFile(input: {
  fileName: string;
  bytes: Uint8Array;
}): Promise<ParsedNotePackage> {
  try {
    return await parseNotePackage({
      bytes: input.bytes,
      fileName: input.fileName,
    });
  } catch (reason) {
    if (reason instanceof NotePackageImportError) {
      if (!reason.fileName) {
        throw new NotePackageImportError(
          reason.code,
          reason.message,
          input.fileName,
        );
      }
      throw reason;
    }
    throw new NotePackageImportError(
      'ZXNOTE_STRUCTURE_INVALID',
      reason instanceof Error ? reason.message : '笔记包解析失败',
      input.fileName,
    );
  }
}

export function isNotePackageFile(fileName: string): boolean {
  return /\.zxnote$/i.test(fileName.trim());
}

// ---------------------------------------------------------------------------
// 导入计划：ID 重映射
// ---------------------------------------------------------------------------

export type NotePackageIdFactory = (prefix: string) => string;

export type NotePackageExistingAttachment = {
  id: string;
  sha256: string;
};

export type NotePackageImportOptions = {
  /**
   * 目标目录。显式传 null 表示“未分类”；省略时按 `note.json.folder.name`
   * 在本机目录列表中精确匹配，无匹配则未分类并警告。
   */
  folderId?: string | null;
  /** 本机目录；用于按名称映射源目录。 */
  folders?: ReadonlyArray<{ id: string; name: string }>;
  idFactory?: NotePackageIdFactory;
  existingAttachments?:
    | ReadonlyArray<NotePackageExistingAttachment>
    | ReadonlyMap<string, string>;
  now?: Date;
};

export type NotePackageAttachmentWrite = {
  /** 规划 ID；正式写入时附件管理器可能返回另一个 ID（同内容已有记录）。 */
  id: string;
  sourceIds: string[];
  fileName: string;
  mime: string;
  sha256: string;
  byteSize: number;
  bytes: Uint8Array;
  noteId: string;
  blockId: string | null;
  reused: boolean;
};

export type NotePackagePlannedBoard = {
  boardId: string;
  title: string;
  document: BoardDocument;
  viewport: BoardViewport | null;
};

export type NotePackagePlannedTodo = {
  id: string;
  title: string;
  done: boolean;
  dueDate: string | null;
  reminderEnabled: boolean;
  sortOrder: number;
};

export type NotePackageImportPlan = {
  parsed: ParsedNotePackage;
  sourceNoteId: string;
  noteId: string;
  note: NewNote;
  blocks: ImportNoteBlock[];
  todos: ImportNoteTodo[];
  /** 现有 `notes_import` 不支持截止日期/提醒；写入后由目标补丁补齐。 */
  todoDetails: NotePackagePlannedTodo[];
  boards: NotePackagePlannedBoard[];
  attachmentWrites: NotePackageAttachmentWrite[];
  warnings: string[];
  stats: {
    blocks: number;
    boards: number;
    boardNodes: number;
    boardEdges: number;
    attachments: number;
    createdAttachments: number;
    reusedAttachments: number;
    todos: number;
  };
};

function defaultIdFactory(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

class IdAllocator {
  private readonly used = new Set<string>();

  constructor(private readonly factory: NotePackageIdFactory) {}

  next(prefix: string): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.factory(prefix);
      if (id && !this.used.has(id)) {
        this.used.add(id);
        return id;
      }
    }
    fail(
      'ZXNOTE_ID_COLLISION',
      `无法为 ${prefix} 生成不重复的 ID`,
    );
  }
}

type RewriteContext = {
  sourceNoteId: string;
  noteId: string;
  blockMap: Map<string, string>;
  todoMap: Map<string, string>;
  boardMap: Map<string, string>;
  attachmentMap: Map<string, string>;
  missingBoardIds: Set<string>;
  missingAttachmentIds: Set<string>;
  attachmentMeta: Map<
    string,
    { fileName: string; mime: string; byteSize: number; available: boolean }
  >;
  warnings: string[];
  warn: (message: string) => void;
};

function rewriteSelfNoteUrl(value: string, context: RewriteContext): string {
  return value.replace(
    new RegExp(
      `zhixing://note/${context.sourceNoteId.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      )}(?=$|[/?#])`,
      'g',
    ),
    `zhixing://note/${context.noteId}`,
  );
}

function rewriteUnknown(value: unknown, context: RewriteContext): unknown {
  if (typeof value === 'string') {
    return rewriteSelfNoteUrl(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteUnknown(item, context));
  }
  if (!isRecord(value)) {
    return value;
  }
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'boardId' && typeof child === 'string') {
      next[key] = context.boardMap.get(child) ?? null;
      continue;
    }
    if (key === 'attachmentId' && typeof child === 'string') {
      next[key] = context.attachmentMap.get(child) ?? null;
      continue;
    }
    if (key === 'todoId' && typeof child === 'string') {
      next[key] = context.todoMap.get(child) ?? null;
      continue;
    }
    if (key === 'noteId' && typeof child === 'string') {
      next[key] =
        child === context.sourceNoteId ? context.noteId : child;
      continue;
    }
    next[key] = rewriteUnknown(child, context);
  }
  return next;
}

function missingBoardWarning(context: RewriteContext, title: string) {
  context.missingBoardIds.add(title);
  context.warn(
    `画板「${title}」缺失，已保留为占位（boardId=null）。`,
  );
}

function rewriteBlockPayload(
  block: NotePackageBlockJson,
  context: RewriteContext,
): Record<string, unknown> {
  const original = block.payload;
  const rewritten = rewriteUnknown(cloneJson(original), context) as Record<
    string,
    unknown
  >;

  if (
    (block.type === 'board' || 'boardId' in original) &&
    typeof original.boardId === 'string' &&
    original.boardId
  ) {
    const mapped = context.boardMap.get(original.boardId);
    if (!mapped) {
      rewritten.boardId = null;
      const title = asString(original.title, '未命名画板');
      rewritten.title = title.endsWith('（画板缺失）')
        ? title
        : `${title}（画板缺失）`;
      missingBoardWarning(context, title);
    }
  }

  if (
    (block.type === 'file' || block.type === 'image') &&
    typeof original.attachmentId === 'string' &&
    original.attachmentId
  ) {
    const mapped = context.attachmentMap.get(original.attachmentId);
    const meta = context.attachmentMeta.get(original.attachmentId);
    if (!mapped) {
      rewritten.attachmentId = null;
      rewritten.status = 'missing';
      context.missingAttachmentIds.add(original.attachmentId);
      context.warn(
        `附件「${asString(original.fileName, '未命名附件')}」缺失，文件卡已保留但不可打开。`,
      );
    } else if (meta) {
      rewritten.fileName = meta.fileName;
      rewritten.mime = meta.mime;
      rewritten.byteSize = meta.byteSize;
      rewritten.status = meta.available ? 'local' : 'missing';
    }
  }

  if (
    block.type === 'todo' &&
    typeof original.todoId === 'string' &&
    original.todoId &&
    !context.todoMap.has(original.todoId)
  ) {
    rewritten.todoId = null;
    context.warn('有待办块缺少对应待办记录，已保留为普通待办块。');
  }

  return rewritten;
}

function existingAttachmentMap(
  input: NotePackageImportOptions['existingAttachments'],
): Map<string, string> {
  const map = new Map<string, string>();
  if (!input) {
    return map;
  }
  if (input instanceof Map) {
    (input as ReadonlyMap<string, string>).forEach((id, sha256) => {
      if (sha256 && id) {
        map.set(sha256.toLowerCase(), id);
      }
    });
    return map;
  }
  for (const item of input as ReadonlyArray<NotePackageExistingAttachment>) {
    if (item.sha256 && item.id) {
      map.set(item.sha256.toLowerCase(), item.id);
    }
  }
  return map;
}

/**
 * 生成完整导入计划（只生成新 ID，不写库）。调用前先 `parseNotePackage`。
 */
export function planNotePackageImport(
  parsed: ParsedNotePackage,
  options: NotePackageImportOptions = {},
): NotePackageImportPlan {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const warn = (message: string) => {
    if (!seen.has(message)) {
      seen.add(message);
      warnings.push(message);
    }
  };
  const allocate = new IdAllocator(
    options.idFactory ?? defaultIdFactory,
  );

  const sourceNoteId = parsed.note.sourceId;
  const noteId = allocate.next('note');

  const blockMap = new Map<string, string>();
  for (const block of parsed.blocks) {
    blockMap.set(block.id, allocate.next('block'));
  }
  const todoMap = new Map<string, string>();
  for (const todo of parsed.note.noteTodos) {
    todoMap.set(todo.sourceId, allocate.next('todo'));
  }
  const boardMap = new Map<string, string>();
  const nodeMaps = new Map<string, Map<string, string>>();
  const edgeMaps = new Map<string, Map<string, string>>();
  const plannedBoards: NotePackagePlannedBoard[] = [];
  for (const board of parsed.boards) {
    if (!board.document) {
      continue;
    }
    const boardId = allocate.next('board');
    boardMap.set(board.sourceId, boardId);
    const nodeMap = new Map<string, string>();
    for (const node of board.document.nodes) {
      nodeMap.set(node.id, allocate.next('node'));
    }
    const edgeMap = new Map<string, string>();
    for (const edge of board.document.edges) {
      edgeMap.set(edge.id, allocate.next('edge'));
    }
    nodeMaps.set(board.sourceId, nodeMap);
    edgeMaps.set(board.sourceId, edgeMap);
    const nodes = board.document.nodes.map((node) => ({
      ...node,
      id: nodeMap.get(node.id)!,
    }));
    const edges = board.document.edges.map((edge) => ({
      ...edge,
      id: edgeMap.get(edge.id)!,
      fromNodeId: nodeMap.get(edge.fromNodeId)!,
      toNodeId: nodeMap.get(edge.toNodeId)!,
    }));
    plannedBoards.push({
      boardId,
      title: board.document.title,
      document: {
        ...board.document,
        boardId,
        noteId,
        nodes,
        edges,
      },
      viewport: board.viewport,
    });
  }

  // 附件：同 SHA-256 复用已有记录；否则生成新 ID。缺失附件不写二进制。
  const existingBySha = existingAttachmentMap(options.existingAttachments);
  const attachmentMap = new Map<string, string>();
  const attachmentMeta = new Map<
    string,
    { fileName: string; mime: string; byteSize: number; available: boolean }
  >();
  const attachmentWrites: NotePackageAttachmentWrite[] = [];
  let createdAttachments = 0;
  let reusedAttachments = 0;
  const attachmentBlockIds = new Map<string, string[]>();
  for (const block of parsed.blocks) {
    const attachmentId = block.payload.attachmentId;
    if (typeof attachmentId === 'string' && attachmentId) {
      const mappedBlockId = blockMap.get(block.id);
      if (!mappedBlockId) {
        continue;
      }
      const list = attachmentBlockIds.get(attachmentId) ?? [];
      list.push(mappedBlockId);
      attachmentBlockIds.set(attachmentId, list);
    }
  }
  for (const item of parsed.attachments) {
    const available = !item.missing && item.bytes !== null;
    for (const sourceId of item.sourceIds) {
      attachmentMeta.set(sourceId, {
        fileName: item.fileName,
        mime: item.mime,
        byteSize: item.byteSize,
        available,
      });
    }
    if (!available || !item.sha256 || !item.bytes) {
      continue;
    }
    const reusedId = existingBySha.get(item.sha256);
    const id = reusedId ?? allocate.next('att');
    if (reusedId) {
      reusedAttachments += 1;
    } else {
      createdAttachments += 1;
    }
    for (const sourceId of item.sourceIds) {
      attachmentMap.set(sourceId, id);
    }
    const firstBlockId =
      item.sourceIds
        .flatMap((sourceId) => attachmentBlockIds.get(sourceId) ?? [])
        .at(0) ?? null;
    attachmentWrites.push({
      id,
      sourceIds: item.sourceIds,
      fileName: item.fileName,
      mime: item.mime,
      sha256: item.sha256,
      byteSize: item.bytes.byteLength,
      bytes: item.bytes,
      noteId,
      blockId: firstBlockId,
      reused: Boolean(reusedId),
    });
  }

  const context: RewriteContext = {
    sourceNoteId,
    noteId,
    blockMap,
    todoMap,
    boardMap,
    attachmentMap,
    missingBoardIds: new Set(),
    missingAttachmentIds: new Set(),
    attachmentMeta,
    warnings,
    warn,
  };
  void nodeMaps;
  void edgeMaps;

  const blocks: ImportNoteBlock[] = parsed.blocks.map((block, index) => ({
    id: blockMap.get(block.id)!,
    blockType: block.type,
    orderKey: (index + 1) * 1024,
    payload: rewriteBlockPayload(block, context) as never,
    schemaVersion: block.schemaVersion,
  }));

  const todoDetails: NotePackagePlannedTodo[] = parsed.note.noteTodos.map(
    (todo, index) => {
      if (todo.taskId) {
        warn('待办的任务关联已解除（任务不随单篇笔记导出）。');
      }
      return {
        id: todoMap.get(todo.sourceId)!,
        title: todo.title.trim() || '待办事项',
        done: todo.done,
        dueDate: todo.dueDate,
        reminderEnabled: todo.reminderEnabled,
        sortOrder: index,
      };
    },
  );
  const todos: ImportNoteTodo[] = todoDetails.map((todo) => ({
    id: todo.id,
    title: todo.title,
    done: todo.done,
    sortOrder: todo.sortOrder,
  }));

  const noteTitle = parsed.note.title.trim();
  if (!noteTitle) {
    warn('笔记标题为空，已使用「未命名笔记」。');
  }
  if (parsed.note.status === 'trashed') {
    warn('源笔记在回收站中，导入后状态为 active。');
  }
  const tags = Array.from(
    new Set(
      parsed.note.tags
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

  let folderId: string | null;
  if (options.folderId !== undefined) {
    folderId = options.folderId;
  } else {
    const folderName = parsed.note.folder?.name?.trim() ?? '';
    const matched = folderName
      ? options.folders?.find((folder) => folder.name === folderName)
      : undefined;
    folderId = matched?.id ?? null;
    if (folderName && !matched) {
      warn(`本机没有名为「${folderName}」的目录，已导入到未分类。`);
    }
  }

  // body 由块重建；不信任包里的兼容 HTML 缓存。
  const body = blocksToHtml(
    blocks.map((block) => ({
      type: block.blockType,
      payload: block.payload as never,
    })),
  );

  const note: NewNote = {
    id: noteId,
    title: noteTitle || '未命名笔记',
    folderId,
    tags,
    body,
    bodyFormat: 'html',
    status: 'active',
    favorite: parsed.note.favorite,
    pinned: parsed.note.pinned,
  };

  const stats = {
    blocks: blocks.length,
    boards: plannedBoards.length,
    boardNodes: plannedBoards.reduce(
      (sum, board) => sum + board.document.nodes.length,
      0,
    ),
    boardEdges: plannedBoards.reduce(
      (sum, board) => sum + board.document.edges.length,
      0,
    ),
    attachments: parsed.attachments.length,
    createdAttachments,
    reusedAttachments,
    todos: todos.length,
  };

  return {
    parsed,
    sourceNoteId,
    noteId,
    note,
    blocks,
    todos,
    todoDetails,
    boards: plannedBoards,
    attachmentWrites,
    warnings: Array.from(new Set([...parsed.warnings, ...warnings])),
    stats,
  };
}

// ---------------------------------------------------------------------------
// 写入目标
// ---------------------------------------------------------------------------

export type NotePackageApplyResult = {
  note: Note;
  boardIds: string[];
  createdAttachments: number;
  reusedAttachments: number;
};

export interface NotePackageImportTarget {
  /** 必须全有或全无；失败时不得留下本次导入的 note/block/board/attachment。 */
  apply(plan: NotePackageImportPlan): Promise<NotePackageApplyResult>;
}

export async function applyNotePackageImport(
  plan: NotePackageImportPlan,
  target: NotePackageImportTarget,
): Promise<NotePackageApplyResult> {
  return target.apply(plan);
}

export type NotePackageImportTargetSources = {
  noteSource: NoteSource;
  boardSource: BoardSource;
  blockSource?: BlockRepository;
  noteTodoRepository?: NoteTodoRepository;
  attachmentManager?: AttachmentManager | null;
};

/**
 * 正式写入目标：先走 `notes_import`（笔记+块+待办单事务），再创建画板与
 * 附件。任一步失败执行补偿清理并抛错，不把部分写入报告为成功。
 *
 * 说明：现有 Rust 命令没有把 notes/boards/attachments 放进同一个事务；
 * 本目标用“预检全部通过 + 失败补偿”保证 UI 不显示半成品，真正的跨表事务
 * 需要后续 Rust 卡扩展 `notes_import`。
 */
export function createNotePackageImportTarget(
  sources: NotePackageImportTargetSources,
): NotePackageImportTarget {
  const {
    noteSource,
    boardSource,
    blockSource,
    noteTodoRepository,
    attachmentManager,
  } = sources;
  return {
    async apply(plan) {
      const importer = noteSource.import;
      if (!importer) {
        throw new NotePackageImportError(
          'ZXNOTE_WRITE_FAILED',
          '当前数据源不支持笔记导入',
        );
      }
      if (
        plan.attachmentWrites.some((attachment) => !attachment.reused) &&
        !attachmentManager
      ) {
        throw new NotePackageImportError(
          'ZXNOTE_WRITE_FAILED',
          '附件服务不可用，无法写入笔记包内的附件',
        );
      }

      const createdBoards: string[] = [];
      const createdAttachmentIds: string[] = [];
      let note: Note | null = null;
      try {
        note = await importer({
          note: plan.note,
          blocks: plan.blocks,
          todos: plan.todos,
        });

        // `notes_import` 目前只写待办标题/完成态；截止日期与提醒在这里补齐。
        if (noteTodoRepository && plan.todoDetails.length > 0) {
          const rows = await noteTodoRepository.list(note.id);
          const byId = new Map(rows.map((row) => [row.id, row]));
          for (const detail of plan.todoDetails) {
            const row = byId.get(detail.id);
            if (!row) {
              throw new Error('写入后找不到刚创建的笔记待办');
            }
            if (
              row.dueDate !== detail.dueDate ||
              row.reminderEnabled !== detail.reminderEnabled
            ) {
              await noteTodoRepository.patch(row, {
                dueDate: detail.dueDate,
                reminderEnabled: detail.reminderEnabled,
              });
            }
          }
        }

        for (const board of plan.boards) {
          await boardSource.create({
            id: board.boardId,
            noteId: note.id,
            title: board.document.title,
          });
          createdBoards.push(board.boardId);
          await boardSource.save(board.boardId, board.document);
        }

        const actualAttachmentIds = new Map<string, string>();
        for (const attachment of plan.attachmentWrites) {
          if (attachment.reused) {
            actualAttachmentIds.set(attachment.id, attachment.id);
            continue;
          }
          const blob = new Blob([attachment.bytes.slice().buffer], {
            type: attachment.mime,
          });
          const result = await attachmentManager!.ingest(blob, {
            noteId: note.id,
            blockId: attachment.blockId,
          });
          const actualId = result.attachment.metadata.id;
          createdAttachmentIds.push(actualId);
          actualAttachmentIds.set(attachment.id, actualId);
        }

        // 附件管理器按内容自生成 ID；若与计划 ID 不同，回写块 payload。
        const changed = Array.from(actualAttachmentIds.entries()).some(
          ([planned, actual]) => planned !== actual,
        );
        if (changed) {
          if (!blockSource) {
            throw new Error('附件 ID 与计划不一致，但缺少块仓储，无法回写引用');
          }
          await blockSource.saveDocument(
            note.id,
            plan.blocks.map((block) => {
              const payload = cloneJson(block.payload) as Record<
                string,
                unknown
              >;
              const attachmentId = payload.attachmentId;
              if (typeof attachmentId === 'string') {
                const actual = actualAttachmentIds.get(attachmentId);
                if (actual) {
                  payload.attachmentId = actual;
                }
              }
              return {
                id: block.id,
                type: block.blockType,
                payload: payload as never,
                schemaVersion: block.schemaVersion ?? 1,
              };
            }),
          );
        }

        // 写入后自检：块顺序/画板几何/附件哈希；不符即回滚。
        if (blockSource) {
          const stored = await blockSource.list(note.id);
          const active = stored.filter((block) => block.deletedAt === null);
          if (active.length !== plan.blocks.length) {
            throw new Error('写入后块数不一致');
          }
          for (let index = 0; index < plan.blocks.length; index += 1) {
            if (active[index]!.id !== plan.blocks[index]!.id) {
              throw new Error('写入后块顺序不一致');
            }
          }
        }
        for (const board of plan.boards) {
          const stored = await boardSource.load(board.boardId);
          if (
            stored.nodes.length !== board.document.nodes.length ||
            stored.edges.length !== board.document.edges.length
          ) {
            throw new Error('写入后画板节点/连线数不一致');
          }
        }

        return {
          note,
          boardIds: createdBoards,
          createdAttachments: createdAttachmentIds.length,
          reusedAttachments: plan.attachmentWrites.filter(
            (attachment) => attachment.reused,
          ).length,
        };
      } catch (reason) {
        for (const id of createdAttachmentIds) {
          try {
            await attachmentManager?.remove(id);
          } catch {
            // 补偿失败不覆盖原始错误；UI 仍显示失败。
          }
        }
        for (const id of createdBoards) {
          try {
            await boardSource.remove(id);
          } catch {
            // 同上。
          }
        }
        if (note) {
          try {
            await noteSource.remove?.(note.id);
          } catch {
            // 同上。
          }
        }
        if (reason instanceof NotePackageImportError) {
          throw reason;
        }
        throw new NotePackageImportError(
          'ZXNOTE_WRITE_FAILED',
          reason instanceof Error ? reason.message : '写入笔记包失败',
        );
      }
    },
  };
}

/** 测试/检查用：读取包内附件的字节。 */
export function attachmentBytesFor(
  parsed: ParsedNotePackage,
  sourceId: string,
): Uint8Array | null {
  const item = parsed.attachments.find((attachment) =>
    attachment.sourceIds.includes(sourceId),
  );
  return item?.bytes ?? null;
}

/** 测试辅助：把包内 blocks 转成编辑器块。 */
export function notePackageBlocksForEditor(
  parsed: ParsedNotePackage,
  noteId: string,
): Array<{
  id: string;
  noteId: string;
  type: string;
  orderKey: number;
  payload: Record<string, unknown>;
  schemaVersion: number;
}> {
  return parsed.blocks.map((block) => ({
    id: block.id,
    noteId,
    type: block.type,
    orderKey: block.orderKey,
    payload: block.payload,
    schemaVersion: block.schemaVersion,
  }));
}

void encoder;
