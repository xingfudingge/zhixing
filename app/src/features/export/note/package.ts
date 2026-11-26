/**
 * 知行笔记包（`.zxnote`）导出（ZX5-IO-06 / ZX-DESIGN-16 §4、§6）。
 *
 * 一个标准 ZIP，而不是整库备份：
 * - `manifest.json`：包级别版本、计数器、校验和索引与人读摘要；
 * - `note.json`：笔记元数据与笔记待办；
 * - `blocks.json`：按权威顺序排列的完整块 payload（未知字段原样保留）；
 * - `boards/<boardId>.json`：被块引用的完整画板文档（含 nodes/edges/viewport）；
 * - `attachments/<sha256>.<ext>`：被块引用的附件二进制（内容寻址）；
 * - `relations.json`：内部/外部/缺失引用清单，导入端据此重映射；
 * - `attachments.json`：附件元数据索引；
 * - `checksums.json`：除自身外全部文件的 SHA-256（manifest 内亦保留一份）。
 *
 * 约束：
 * - 缺画板/缺附件不静默丢：写入 manifest 警告与 `relations.missing`；
 * - 附件二进制哈希与元数据不一致时导出失败，不生成不可导入的包；
 * - 不读取账号、令牌、同步游标等秘密，也不把其他笔记递归打进包。
 */

import type { Note, NoteTodo } from '../../../data/db/types';
import type { EditorBlock } from '../../../data/repositories/blocks';
import { serializeBoardDocument } from '../../board/model';
import type { BoardDocument, BoardSource, BoardViewport } from '../../board/types';
import type { AttachmentManager } from '../../attachments/manager';
import { sha256Bytes } from '../../attachments/sha256';
import { saveBlobWithDialog, type SaveResult } from '../../attachments/fileActions';
import { internalNoteIdFromUrl } from '../../editor/security';
import { sanitizeFileName, stableStringify } from '../sanitize';
import { createZip, type ZipWriteEntry } from '../zip';

export const NOTE_PACKAGE_EXTENSION = '.zxnote';
export const NOTE_PACKAGE_MIME = 'application/x-zhixing-note+zip';
export const NOTE_PACKAGE_FALLBACK_MIME = 'application/zip';
export const NOTE_PACKAGE_ACCEPT = '.zxnote';
export const NOTE_PACKAGE_APP = 'zhixing';
export const NOTE_PACKAGE_KIND = 'note-package';
export const NOTE_PACKAGE_FORMAT = 'zxnote';
export const NOTE_PACKAGE_FORMAT_VERSION = 1;
export const NOTE_PACKAGE_MIN_READER_VERSION = 1;
export const NOTE_PACKAGE_GENERATOR = 'zhixing/note-package@1';
export const NOTE_PACKAGE_MAX_BYTES = 1024 * 1024 * 1024;
export const NOTE_PACKAGE_MAX_BLOCKS = 50_000;
export const NOTE_PACKAGE_MAX_BOARDS = 200;
export const NOTE_PACKAGE_DEFAULT_APP_VERSION = '0.1.0';
export const NOTE_PACKAGE_DEFAULT_SCHEMA_VERSION = 2;

const encoder = new TextEncoder();

export type NotePackageJsonObject = { [key: string]: unknown };

export type NotePackageAttachmentLoaderResult = {
  fileName: string;
  mime: string;
  sha256: string | null;
  byteSize: number;
  bytes: Uint8Array;
};

export type NotePackageAttachmentLoader = (
  attachmentId: string,
  fallback: { fileName: string; mime: string; byteSize: number },
) => Promise<NotePackageAttachmentLoaderResult | null>;

export type NotePackageBoardLoaderResult = {
  document: BoardDocument;
  viewport?: BoardViewport | null;
};

export type NotePackageBoardLoader = (
  boardId: string,
) => Promise<NotePackageBoardLoaderResult | null>;

export type BuildNotePackageInput = {
  note: Pick<
    Note,
    | 'id'
    | 'title'
    | 'folderId'
    | 'tags'
    | 'body'
    | 'bodyFormat'
    | 'status'
    | 'favorite'
    | 'pinned'
    | 'deletedAt'
    | 'createdAt'
    | 'updatedAt'
  >;
  blocks: ReadonlyArray<EditorBlock>;
  noteTodos?: ReadonlyArray<
    Pick<
      NoteTodo,
      | 'id'
      | 'title'
      | 'done'
      | 'dueDate'
      | 'reminderEnabled'
      | 'sortOrder'
      | 'taskId'
    >
  >;
  /** 目录名；与 `note.folderId` 一起写入 `note.json.folder`。 */
  folderName: string;
  loadBoard?: NotePackageBoardLoader;
  resolveAttachment?: NotePackageAttachmentLoader;
  /** 便捷入口：直接传附件管理器，内部复用 `open()` 并核对哈希。 */
  attachmentManager?: AttachmentManager | null;
  appVersion?: string;
  schemaVersion?: number;
  now?: Date;
};

export type NotePackageManifestEntry = {
  path: string;
  role:
    | 'note'
    | 'blocks'
    | 'relations'
    | 'attachment-index'
    | 'board'
    | 'attachment';
  byteSize: number;
  sha256: string;
  boardKey?: string;
  sourceBoardId?: string;
};

export type NotePackageChecksumEntry = {
  path: string;
  byteSize: number;
  sha256: string;
};

export type NotePackageBoardManifestEntry = {
  key: string;
  sourceId: string;
  sourceNoteId: string | null;
  title: string;
  path: string | null;
  sha256: string | null;
  byteSize: number;
  nodeCount: number;
  edgeCount: number;
  viewport: BoardViewport | null;
  missing: boolean;
};

export type NotePackageAttachmentManifestEntry = {
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
};

export type NotePackageManifest = {
  app: typeof NOTE_PACKAGE_APP;
  kind: typeof NOTE_PACKAGE_KIND;
  format: typeof NOTE_PACKAGE_FORMAT;
  version: number;
  formatVersion: number;
  minReaderVersion: number;
  exportedAt: string;
  appVersion: string;
  schemaVersion: number;
  generator: string;
  note: {
    sourceId: string;
    title: string;
    folder: { id: string | null; name: string } | null;
    blockCount: number;
    boardCount: number;
    attachmentCount: number;
    todoCount: number;
    wordCount: number;
  };
  counts: {
    blocks: number;
    boards: number;
    boardNodes: number;
    boardEdges: number;
    attachments: number;
    attachmentBytes: number;
    todos: number;
    relations: {
      total: number;
      internal: number;
      external: number;
      missing: number;
      byKind: Record<string, number>;
    };
  };
  entries: NotePackageManifestEntry[];
  boards: NotePackageBoardManifestEntry[];
  attachments: NotePackageAttachmentManifestEntry[];
  relations: {
    total: number;
    internal: number;
    external: number;
    missing: number;
    byKind: Record<string, number>;
  };
  checksums: NotePackageChecksumEntry[];
  warnings: string[];
  security: {
    secretsExcluded: true;
    excludedScopes: string[];
  };
  notes: string[];
};

export type NotePackageReport = {
  format: typeof NOTE_PACKAGE_FORMAT;
  fileName: string;
  mime: string;
  bytes: Uint8Array;
  size: number;
  warnings: string[];
  manifest: NotePackageManifest;
  /** 包内文件树（不含 ZIP 目录项），按路径升序。 */
  files: string[];
  generatedAt: string;
};

export type NotePackageSaveResult =
  | {
      status: 'saved';
      report: NotePackageReport;
      path: string | null;
      target: 'desktop' | 'browser';
      actualFileName: string;
      renamed: boolean;
    }
  | { status: 'canceled' };

export type NotePackageSaver = (
  blob: Blob,
  fileName: string,
) => Promise<SaveResult>;

export type NotePackageExportErrorCode =
  | 'EXPORT_NOTE_TOO_LARGE'
  | 'EXPORT_ATTACHMENT_HASH_MISMATCH'
  | 'EXPORT_ATTACHMENT_REF_MISSING'
  | 'EXPORT_ZIP_FAILED';

export class NotePackageExportError extends Error {
  readonly code: NotePackageExportErrorCode;

  constructor(code: NotePackageExportErrorCode, message: string) {
    super(message);
    this.name = 'NotePackageExportError';
    this.code = code;
  }
}

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

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${stableStringify(value)}\n`);
}

function cleanText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function fileExtension(fileName: string, mime: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(fileName);
  if (match) {
    return match[1]!.toLowerCase();
  }
  const byMime: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'application/json': 'json',
  };
  return byMime[mime] ?? 'bin';
}

function safePathSegment(value: string, fallback: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 80);
  return safe || fallback;
}

function timestampForFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate(),
  )}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** `.zxnote` 文件名：`<净化标题>-YYYYMMDD-HHmm.zxnote`。 */
export function notePackageFileName(
  title: string,
  now: Date = new Date(),
): string {
  const base =
    sanitizeFileName(title.trim() || '未命名笔记', '未命名笔记').slice(0, 120) ||
    '未命名笔记';
  return `${base}-${timestampForFileName(now)}${NOTE_PACKAGE_EXTENSION}`;
}

/** 从附件管理器构造解析器；缺失/读取失败返回 null，由调用方写警告。 */
export function notePackageAttachmentLoaderFromManager(
  manager: AttachmentManager | null | undefined,
): NotePackageAttachmentLoader | undefined {
  if (!manager) {
    return undefined;
  }
  return async (attachmentId) => {
    try {
      const { blob, metadata } = await manager.open(attachmentId);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return {
        fileName: metadata.fileName,
        mime: metadata.mime,
        sha256: metadata.sha256,
        byteSize: metadata.byteSize || bytes.byteLength,
        bytes,
      };
    } catch {
      return null;
    }
  };
}

/** 从画板数据源构造 loader；画板视图状态不持久化时为 null。 */
export function notePackageBoardLoaderFromSource(
  source: Pick<BoardSource, 'load'> | null | undefined,
): NotePackageBoardLoader | undefined {
  if (!source) {
    return undefined;
  }
  return async (boardId) => {
    try {
      const document = await source.load(boardId);
      return { document, viewport: null };
    } catch {
      return null;
    }
  };
}

type BlockRef =
  | {
      kind: 'board';
      blockIndex: number;
      blockId: string;
      sourceId: string;
      title: string;
      path: string;
    }
  | {
      kind: 'attachment';
      blockIndex: number;
      blockId: string;
      sourceId: string;
      fileName: string;
      mime: string;
      byteSize: number;
      path: string;
    }
  | {
      kind: 'todo';
      blockIndex: number;
      blockId: string;
      sourceId: string;
      path: string;
    }
  | {
      kind: 'self-note-link' | 'note-link';
      blockIndex: number;
      blockId: string;
      sourceId: string;
      path: string;
    }
  | {
      kind: 'self-quote' | 'note-quote';
      blockIndex: number;
      blockId: string;
      sourceId: string;
      path: string;
    }
  | {
      kind: 'task';
      base: 'note';
      sourceId: string;
      path: string;
    };

function scanRunsForLinks(
  value: unknown,
  basePath: string,
  visit: (url: string, path: string) => void,
): void {
  if (!Array.isArray(value)) {
    return;
  }
  value.forEach((run, index) => {
    if (!isRecord(run)) {
      return;
    }
    const marks = isRecord(run.marks) ? run.marks : null;
    if (marks && typeof marks.link === 'string' && marks.link.trim()) {
      visit(marks.link, `${basePath}/${index}/marks/link`);
    } else if (typeof run.link === 'string' && run.link.trim()) {
      visit(run.link, `${basePath}/${index}/link`);
    }
  });
}

function collectRefs(
  blocks: ReadonlyArray<EditorBlock>,
  noteSourceId: string,
): BlockRef[] {
  const refs: BlockRef[] = [];
  blocks.forEach((block, blockIndex) => {
    const payload = block.payload;
    const path = `/blocks/${blockIndex}/payload`;
    const blockId = block.id;

    if (typeof payload.boardId === 'string' && payload.boardId.trim()) {
      refs.push({
        kind: 'board',
        blockIndex,
        blockId,
        sourceId: payload.boardId.trim(),
        title: cleanText(payload.title, '未命名画板'),
        path: `${path}/boardId`,
      });
    }
    if (
      typeof payload.attachmentId === 'string' &&
      payload.attachmentId.trim()
    ) {
      refs.push({
        kind: 'attachment',
        blockIndex,
        blockId,
        sourceId: payload.attachmentId.trim(),
        fileName: cleanText(payload.fileName, '未命名附件'),
        mime: cleanText(payload.mime),
        byteSize:
          typeof payload.byteSize === 'number' &&
          Number.isFinite(payload.byteSize)
            ? Math.max(0, payload.byteSize)
            : 0,
        path: `${path}/attachmentId`,
      });
    }
    if (typeof payload.todoId === 'string' && payload.todoId.trim()) {
      refs.push({
        kind: 'todo',
        blockIndex,
        blockId,
        sourceId: payload.todoId.trim(),
        path: `${path}/todoId`,
      });
    }
    if (typeof payload.noteId === 'string' && payload.noteId.trim()) {
      const sourceId = payload.noteId.trim();
      refs.push({
        kind: sourceId === noteSourceId ? 'self-quote' : 'note-quote',
        blockIndex,
        blockId,
        sourceId,
        path: `${path}/noteId`,
      });
    }
    scanRunsForLinks(payload.runs, `${path}/runs`, (url, linkPath) => {
      const noteId = internalNoteIdFromUrl(url);
      if (!noteId) {
        return;
      }
      refs.push({
        kind: noteId === noteSourceId ? 'self-note-link' : 'note-link',
        blockIndex,
        blockId,
        sourceId: noteId,
        path: linkPath,
      });
    });
    if (typeof payload.url === 'string' && payload.url.trim()) {
      const noteId = internalNoteIdFromUrl(payload.url);
      if (noteId) {
        refs.push({
          kind: noteId === noteSourceId ? 'self-note-link' : 'note-link',
          blockIndex,
          blockId,
          sourceId: noteId,
          path: `${path}/url`,
        });
      }
    }
  });
  return refs;
}

function plainTextOfPayload(payload: Record<string, unknown>): string {
  const pieces: string[] = [];
  if (Array.isArray(payload.runs)) {
    for (const run of payload.runs) {
      if (isRecord(run) && typeof run.text === 'string') {
        pieces.push(run.text);
      }
    }
  }
  if (typeof payload.text === 'string') {
    pieces.push(payload.text);
  }
  if (typeof payload.code === 'string') {
    pieces.push(payload.code);
  }
  if (typeof payload.latex === 'string') {
    pieces.push(payload.latex);
  }
  if (typeof payload.title === 'string') {
    pieces.push(payload.title);
  }
  return pieces.join(' ');
}

function countWords(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  const cjk = (normalized.match(/[㐀-鿿]/g) ?? []).length;
  const latin = normalized
    .replace(/[㐀-鿿]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + latin;
}

type PendingTodo = {
  id: string;
  title: string;
  done: boolean;
  dueDate: string | null;
  reminderEnabled: boolean;
  sortOrder: number;
  taskId: string | null;
};

type AttachmentPlan = NotePackageAttachmentManifestEntry & {
  ext: string;
};

export async function buildNotePackage(
  input: BuildNotePackageInput,
): Promise<NotePackageReport> {
  const now = input.now ?? new Date();
  const exportedAt = now.toISOString();
  const noteSourceId = input.note.id;
  const warnings: string[] = [];
  const seenWarnings = new Set<string>();
  const warn = (message: string) => {
    if (!seenWarnings.has(message)) {
      seenWarnings.add(message);
      warnings.push(message);
    }
  };

  const sourceBlocks = input.blocks
    .filter((block) => block.deletedAt === null)
    .map((block) => ({ ...block, payload: cloneJson(block.payload) }))
    .sort((a, b) => {
      if (a.orderKey !== b.orderKey) {
        return a.orderKey - b.orderKey;
      }
      return 0;
    });
  if (sourceBlocks.length > NOTE_PACKAGE_MAX_BLOCKS) {
    throw new NotePackageExportError(
      'EXPORT_NOTE_TOO_LARGE',
      `笔记块数超过上限（${NOTE_PACKAGE_MAX_BLOCKS}）`,
    );
  }

  // 1. 笔记待办 + todo 块关联；缺 todoId 的块生成包内待办，空待办不静默丢。
  const todos: PendingTodo[] = (input.noteTodos ?? []).map((todo) => ({
    id: todo.id,
    title: todo.title,
    done: todo.done,
    dueDate: todo.dueDate,
    reminderEnabled: todo.reminderEnabled,
    sortOrder: todo.sortOrder,
    taskId: todo.taskId,
  }));
  const todoById = new Map(todos.map((todo) => [todo.id, todo]));
  const referencedTodoIds = new Set<string>();
  let syntheticTodoOrder =
    todos.reduce((max, todo) => Math.max(max, todo.sortOrder), 0) + 1;

  sourceBlocks.forEach((block, blockIndex) => {
    const payload = block.payload;
    if (block.type !== 'todo') {
      return;
    }
    const rawId =
      typeof payload.todoId === 'string' && payload.todoId.trim()
        ? payload.todoId.trim()
        : null;
    if (rawId && todoById.has(rawId)) {
      referencedTodoIds.add(rawId);
      return;
    }
    const id = `todo-synthetic-${block.id}`;
    const synthetic: PendingTodo = {
      id,
      title:
        plainTextOfPayload(payload).trim() || `待办 ${blockIndex + 1}`,
      done: payload.checked === true,
      dueDate: null,
      reminderEnabled: false,
      sortOrder: syntheticTodoOrder,
      taskId: null,
    };
    syntheticTodoOrder += 1;
    todos.push(synthetic);
    todoById.set(id, synthetic);
    payload.todoId = id;
    referencedTodoIds.add(id);
    warn(
      `待办块「${synthetic.title}」没有稳定待办 ID，已在包内生成对应待办。`,
    );
  });
  const orphanTodos = todos.filter((todo) => !referencedTodoIds.has(todo.id));
  if (orphanTodos.length > 0) {
    warn(`有 ${orphanTodos.length} 个待办未出现在正文，已保留在包内。`);
  }

  // 2. 引用扫描。
  const refs = collectRefs(sourceBlocks, noteSourceId);
  const taskRefs: Array<Extract<BlockRef, { kind: 'task' }>> = [];
  todos.forEach((todo, index) => {
    if (todo.taskId) {
      taskRefs.push({
        kind: 'task',
        base: 'note',
        sourceId: todo.taskId,
        path: `/noteTodos/${index}/taskId`,
      });
    }
  });

  const boardRefs = refs.filter(
    (ref): ref is Extract<BlockRef, { kind: 'board' }> =>
      ref.kind === 'board',
  );
  const attachmentRefs = refs.filter(
    (ref): ref is Extract<BlockRef, { kind: 'attachment' }> =>
      ref.kind === 'attachment',
  );
  const todoRefs = refs.filter(
    (ref): ref is Extract<BlockRef, { kind: 'todo' }> =>
      ref.kind === 'todo',
  );
  const noteLinkRefs = refs.filter(
    (
      ref,
    ): ref is Extract<
      BlockRef,
      { kind: 'self-note-link' | 'note-link' | 'self-quote' | 'note-quote' }
    > => ref.kind === 'self-note-link' || ref.kind === 'note-link' ||
      ref.kind === 'self-quote' || ref.kind === 'note-quote',
  );

  const externalLinks = noteLinkRefs.filter(
    (ref) => ref.kind === 'note-link' || ref.kind === 'note-quote',
  );
  if (externalLinks.length > 0) {
    warn(`有 ${externalLinks.length} 个内链指向包外笔记，已保留为外部引用。`);
  }

  // 3. 画板：按首次出现顺序收集；缺失写警告与 relations.missing。
  const boardIds: string[] = [];
  for (const ref of boardRefs) {
    if (!boardIds.includes(ref.sourceId)) {
      boardIds.push(ref.sourceId);
    }
  }
  if (boardIds.length > NOTE_PACKAGE_MAX_BOARDS) {
    throw new NotePackageExportError(
      'EXPORT_NOTE_TOO_LARGE',
      `单篇画板数超过上限（${NOTE_PACKAGE_MAX_BOARDS}）`,
    );
  }
  const boardEntries: NotePackageBoardManifestEntry[] = [];
  const boardFiles = new Map<string, Uint8Array>();
  const boardPathBySource = new Map<string, string>();
  const usedBoardPaths = new Set<string>();
  let boardNodeTotal = 0;
  let boardEdgeTotal = 0;

  for (const boardId of boardIds) {
    const ref = boardRefs.find((item) => item.sourceId === boardId)!;
    let loaded: NotePackageBoardLoaderResult | null = null;
    if (input.loadBoard) {
      try {
        loaded = await input.loadBoard(boardId);
      } catch {
        loaded = null;
      }
    }
    if (!loaded) {
      warn(
        `画板「${ref.title}」数据缺失，包内未包含；导入后将显示占位。`,
      );
      boardEntries.push({
        key: boardId,
        sourceId: boardId,
        sourceNoteId: null,
        title: ref.title,
        path: null,
        sha256: null,
        byteSize: 0,
        nodeCount: 0,
        edgeCount: 0,
        viewport: null,
        missing: true,
      });
      continue;
    }

    const document: BoardDocument = {
      ...loaded.document,
      boardId,
      nodes: cloneJson(loaded.document.nodes),
      edges: cloneJson(loaded.document.edges),
    };
    if (document.noteId && document.noteId !== noteSourceId) {
      warn(
        `画板「${document.title}」关联了其他笔记，导入时将改为当前笔记。`,
      );
    }
    if (document.nodes.length === 0) {
      warn(`画板「${document.title}」为空，仍写入包内。`);
    }

    const serialized = serializeBoardDocument(document, {
      viewport: loaded.viewport ?? null,
      exportedAt,
    });
    const bytes = jsonBytes(serialized);
    const base = safePathSegment(boardId, 'board');
    let key = base;
    let suffix = 2;
    while (usedBoardPaths.has(`boards/${key}.json`)) {
      key = `${base}-${suffix}`;
      suffix += 1;
    }
    const path = `boards/${key}.json`;
    usedBoardPaths.add(path);
    boardFiles.set(path, bytes);
    boardPathBySource.set(boardId, path);
    boardNodeTotal += document.nodes.length;
    boardEdgeTotal += document.edges.length;
    boardEntries.push({
      key,
      sourceId: boardId,
      sourceNoteId: document.noteId,
      title: document.title,
      path,
      sha256: sha256Bytes(bytes),
      byteSize: bytes.byteLength,
      nodeCount: document.nodes.length,
      edgeCount: document.edges.length,
      viewport: serialized.viewport,
      missing: false,
    });
  }

  const boardSourceIds = new Set(
    boardEntries.filter((board) => !board.missing).map((board) => board.sourceId),
  );

  // 4. 附件：内容寻址；缺失写警告，哈希不符直接失败。
  const resolveAttachment =
    input.resolveAttachment ??
    notePackageAttachmentLoaderFromManager(input.attachmentManager);
  const attachmentOrder: string[] = [];
  for (const ref of attachmentRefs) {
    if (!attachmentOrder.includes(ref.sourceId)) {
      attachmentOrder.push(ref.sourceId);
    }
  }
  const attachmentPlans: AttachmentPlan[] = [];
  const attachmentFiles = new Map<string, Uint8Array>();
  const attachmentPathBySource = new Map<string, string>();
  const attachmentBySha = new Map<string, AttachmentPlan>();
  const missingAttachmentIds = new Set<string>();

  for (const sourceId of attachmentOrder) {
    const ref = attachmentRefs.find((item) => item.sourceId === sourceId)!;
    const blockIds = attachmentRefs
      .filter((item) => item.sourceId === sourceId)
      .map((item) => item.blockId);
    let loaded: NotePackageAttachmentLoaderResult | null = null;
    if (resolveAttachment) {
      try {
        loaded = await resolveAttachment(sourceId, {
          fileName: ref.fileName,
          mime: ref.mime,
          byteSize: ref.byteSize,
        });
      } catch {
        loaded = null;
      }
    }
    if (!loaded) {
      warn(
        `附件「${ref.fileName}」本机内容缺失，包内未包含二进制；导入后文件卡保留但不可打开。`,
      );
      missingAttachmentIds.add(sourceId);
      attachmentPlans.push({
        sourceId,
        sourceIds: [sourceId],
        fileName: ref.fileName,
        mime: ref.mime,
        sha256: null,
        byteSize: ref.byteSize,
        path: null,
        blockIds,
        createdAt: null,
        missing: true,
        ext: fileExtension(ref.fileName, ref.mime),
      });
      continue;
    }

    const actualSha = sha256Bytes(loaded.bytes);
    if (loaded.sha256 && loaded.sha256 !== actualSha) {
      throw new NotePackageExportError(
        'EXPORT_ATTACHMENT_HASH_MISMATCH',
        `附件「${loaded.fileName || ref.fileName}」内容哈希与元数据不一致，已停止导出`,
      );
    }
    const ext = fileExtension(
      loaded.fileName || ref.fileName,
      loaded.mime || ref.mime,
    );
    const existing = attachmentBySha.get(actualSha);
    if (existing) {
      existing.sourceIds.push(sourceId);
      for (const blockId of blockIds) {
        if (!existing.blockIds.includes(blockId)) {
          existing.blockIds.push(blockId);
        }
      }
      attachmentPathBySource.set(sourceId, existing.path!);
      continue;
    }
    const path = `attachments/${actualSha}.${ext}`;
    const plan: AttachmentPlan = {
      sourceId,
      sourceIds: [sourceId],
      fileName: loaded.fileName || ref.fileName,
      mime: loaded.mime || ref.mime || 'application/octet-stream',
      sha256: actualSha,
      byteSize: loaded.bytes.byteLength,
      path,
      blockIds,
      createdAt: null,
      missing: false,
      ext,
    };
    attachmentBySha.set(actualSha, plan);
    attachmentPlans.push(plan);
    attachmentFiles.set(path, loaded.bytes);
    attachmentPathBySource.set(sourceId, path);
  }
  void missingAttachmentIds;

  // 5. relations：内部可解析、外部保留、缺失只登记画板/附件。
  const internal: NotePackageJsonObject[] = [];
  const external: NotePackageJsonObject[] = [];
  const missing: NotePackageJsonObject[] = [];
  const byKind: Record<string, number> = {};
  const countKind = (kind: string) => {
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  };

  for (const ref of boardRefs) {
    if (boardSourceIds.has(ref.sourceId)) {
      internal.push({
        kind: 'board',
        base: 'blocks',
        path: ref.path,
        target: ref.sourceId,
        targetType: 'boardId',
      });
      countKind('board');
    } else {
      missing.push({
        kind: 'board',
        base: 'blocks',
        path: ref.path,
        target: ref.sourceId,
        targetType: 'boardId',
        title: ref.title,
        reason: '画板文件缺失，导入后保留占位',
      });
      countKind('board-missing');
    }
  }
  for (const ref of attachmentRefs) {
    if (attachmentPathBySource.has(ref.sourceId)) {
      internal.push({
        kind: 'attachment',
        base: 'blocks',
        path: ref.path,
        target: ref.sourceId,
        targetType: 'attachmentSourceId',
      });
      countKind('attachment');
    } else {
      missing.push({
        kind: 'attachment',
        base: 'blocks',
        path: ref.path,
        target: ref.sourceId,
        targetType: 'attachmentSourceId',
        title: ref.fileName,
        reason: '附件二进制缺失，导入后保留文件卡',
      });
      countKind('attachment-missing');
    }
  }
  for (const ref of todoRefs) {
    internal.push({
      kind: 'todo',
      base: 'blocks',
      path: ref.path,
      target: ref.sourceId,
      targetType: 'todoSourceId',
    });
    countKind('todo');
  }
  for (const ref of noteLinkRefs) {
    if (ref.kind === 'self-note-link' || ref.kind === 'self-quote') {
      internal.push({
        kind: ref.kind,
        base: 'blocks',
        path: ref.path,
        target: noteSourceId,
        targetType: 'noteSourceId',
      });
      countKind(ref.kind);
    } else {
      external.push({
        kind: ref.kind === 'note-quote' ? 'note-quote' : 'note-link',
        base: 'blocks',
        path: ref.path,
        target: ref.sourceId,
        targetType: 'noteSourceId',
        reason: '目标笔记不在包内',
      });
      countKind('note-link');
    }
  }
  for (const ref of taskRefs) {
    external.push({
      kind: 'task',
      base: 'note',
      path: ref.path,
      target: ref.sourceId,
      targetType: 'taskId',
      reason: '任务不随单篇笔记导出',
    });
    countKind('task');
  }

  const relations = {
    total: internal.length + external.length + missing.length,
    internal: internal.length,
    external: external.length,
    missing: missing.length,
    byKind,
  };

  const relationsJson = {
    format: 'zhixing.note.relations',
    version: 1,
    noteSourceId,
    internal,
    external,
    missing,
  };

  // 6. note.json / blocks.json / attachments.json。
  const folder =
    input.note.folderId === null
      ? null
      : { id: input.note.folderId, name: input.folderName };
  const tags = Array.from(
    new Set(
      input.note.tags
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const sortedTodos = todos
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const noteJson = {
    format: 'zhixing.note.meta',
    version: 1,
    sourceId: noteSourceId,
    title: input.note.title.trim() || '未命名笔记',
    folder,
    tags,
    favorite: input.note.favorite,
    pinned: input.note.pinned,
    status: input.note.status,
    createdAt: input.note.createdAt,
    updatedAt: input.note.updatedAt,
    bodyFormat: 'blocks' as const,
    body: input.note.body,
    noteTodos: sortedTodos.map((todo, index) => ({
      sourceId: todo.id,
      title: todo.title,
      done: todo.done,
      dueDate: todo.dueDate,
      reminderEnabled: todo.reminderEnabled,
      sortOrder: index,
      taskId: todo.taskId,
    })),
  };
  const blocksJson = {
    format: 'zhixing.note.blocks',
    version: 1,
    noteSourceId,
    blocks: sourceBlocks.map((block) => ({
      id: block.id,
      type: block.type,
      orderKey: block.orderKey,
      schemaVersion: block.schemaVersion,
      payload: block.payload,
    })),
  };
  const attachmentsJson = {
    format: 'zhixing.note.attachments',
    version: 1,
    noteSourceId,
    items: attachmentPlans.map((item) => ({
      sourceId: item.sourceId,
      sourceIds: item.sourceIds,
      fileName: item.fileName,
      mime: item.mime,
      sha256: item.sha256,
      byteSize: item.byteSize,
      path: item.path,
      blockIds: item.blockIds,
      createdAt: item.createdAt,
      missing: item.missing,
    })),
  };

  // 7. 组装文件与校验和。
  const files = new Map<string, Uint8Array>();
  files.set('note.json', jsonBytes(noteJson));
  files.set('blocks.json', jsonBytes(blocksJson));
  files.set('relations.json', jsonBytes(relationsJson));
  files.set('attachments.json', jsonBytes(attachmentsJson));
  for (const [path, bytes] of boardFiles) {
    files.set(path, bytes);
  }
  for (const [path, bytes] of attachmentFiles) {
    files.set(path, bytes);
  }

  const entries: NotePackageManifestEntry[] = [];
  for (const [path, role] of [
    ['note.json', 'note'],
    ['blocks.json', 'blocks'],
    ['relations.json', 'relations'],
    ['attachments.json', 'attachment-index'],
  ] as const) {
    const data = files.get(path)!;
    entries.push({
      path,
      role,
      byteSize: data.byteLength,
      sha256: sha256Bytes(data),
    });
  }
  for (const board of boardEntries) {
    if (!board.path || !board.sha256) {
      continue;
    }
    entries.push({
      path: board.path,
      role: 'board',
      byteSize: board.byteSize,
      sha256: board.sha256,
      boardKey: board.key,
      sourceBoardId: board.sourceId,
    });
  }
  for (const item of attachmentPlans) {
    if (!item.path || !item.sha256) {
      continue;
    }
    entries.push({
      path: item.path,
      role: 'attachment',
      byteSize: item.byteSize,
      sha256: item.sha256,
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const checksums: NotePackageChecksumEntry[] = entries
    .map((entry) => ({
      path: entry.path,
      byteSize: entry.byteSize,
      sha256: entry.sha256,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const wordCount = countWords(
    sourceBlocks.map((block) => plainTextOfPayload(block.payload)).join('\n'),
  );
  const manifest: NotePackageManifest = {
    app: NOTE_PACKAGE_APP,
    kind: NOTE_PACKAGE_KIND,
    format: NOTE_PACKAGE_FORMAT,
    version: NOTE_PACKAGE_FORMAT_VERSION,
    formatVersion: NOTE_PACKAGE_FORMAT_VERSION,
    minReaderVersion: NOTE_PACKAGE_MIN_READER_VERSION,
    exportedAt,
    appVersion: input.appVersion ?? NOTE_PACKAGE_DEFAULT_APP_VERSION,
    schemaVersion: input.schemaVersion ?? NOTE_PACKAGE_DEFAULT_SCHEMA_VERSION,
    generator: NOTE_PACKAGE_GENERATOR,
    note: {
      sourceId: noteSourceId,
      title: noteJson.title,
      folder,
      blockCount: sourceBlocks.length,
      boardCount: boardEntries.length,
      attachmentCount: attachmentPlans.length,
      todoCount: sortedTodos.length,
      wordCount,
    },
    counts: {
      blocks: sourceBlocks.length,
      boards: boardEntries.length,
      boardNodes: boardNodeTotal,
      boardEdges: boardEdgeTotal,
      attachments: attachmentPlans.length,
      attachmentBytes: attachmentPlans.reduce(
        (sum, item) => sum + (item.missing ? 0 : item.byteSize),
        0,
      ),
      todos: sortedTodos.length,
      relations,
    },
    entries,
    boards: boardEntries,
    attachments: attachmentPlans.map((item) => ({
      sourceId: item.sourceId,
      sourceIds: item.sourceIds,
      fileName: item.fileName,
      mime: item.mime,
      sha256: item.sha256,
      byteSize: item.byteSize,
      path: item.path,
      blockIds: item.blockIds,
      createdAt: item.createdAt,
      missing: item.missing,
    })),
    relations,
    checksums,
    warnings,
    security: {
      secretsExcluded: true,
      excludedScopes: [
        '账号与登录态',
        '设备令牌 / 配对码',
        'WebDAV 密码与同步游标',
        '账号 / 令牌 / 设备密钥',
        'API 密钥与环境变量',
      ],
    },
    notes: [
      '单篇笔记包，不替代整库备份。',
      '附件按 SHA-256 内容寻址；同一内容导入时复用已有附件记录。',
      '检查到缺失画板/附件时，包内保留元数据与警告，不静默删除。',
    ],
  };

  const checksumsJson = {
    format: 'zhixing.note.checksums',
    version: 1,
    algorithm: 'sha256' as const,
    files: [
      {
        path: 'manifest.json',
        byteSize: 0,
        sha256: '',
      },
      ...checksums,
    ],
  };
  // manifest 字节先算出来，再回填 checksums.json 的 manifest 校验项。
  const manifestBytes = jsonBytes(manifest);
  checksumsJson.files[0] = {
    path: 'manifest.json',
    byteSize: manifestBytes.byteLength,
    sha256: sha256Bytes(manifestBytes),
  };
  const checksumsBytes = jsonBytes(checksumsJson);

  const payloadPaths = Array.from(files.keys()).sort((a, b) =>
    a.localeCompare(b),
  );
  const zipEntries: ZipWriteEntry[] = [
    { path: 'manifest.json', data: manifestBytes },
    ...payloadPaths.map((path) => ({ path, data: files.get(path)! })),
    { path: 'checksums.json', data: checksumsBytes },
  ];

  let bytes: Uint8Array;
  try {
    bytes = createZip(zipEntries, now);
  } catch (reason) {
    throw new NotePackageExportError(
      'EXPORT_ZIP_FAILED',
      reason instanceof Error ? reason.message : '生成 ZIP 失败',
    );
  }
  if (bytes.byteLength > NOTE_PACKAGE_MAX_BYTES) {
    throw new NotePackageExportError(
      'EXPORT_NOTE_TOO_LARGE',
      '笔记包超过 1 GiB 上限',
    );
  }

  return {
    format: NOTE_PACKAGE_FORMAT,
    fileName: notePackageFileName(noteJson.title, now),
    mime: NOTE_PACKAGE_MIME,
    bytes,
    size: bytes.byteLength,
    warnings,
    manifest,
    files: ['manifest.json', ...payloadPaths, 'checksums.json'],
    generatedAt: exportedAt,
  };
}

function basename(path: string | null): string | null {
  if (!path) return null;
  return path.split(/[\\/]/).pop() ?? null;
}

export async function saveNotePackageToFile(
  input: BuildNotePackageInput,
  saver: NotePackageSaver = saveBlobWithDialog,
): Promise<NotePackageSaveResult> {
  const report = await buildNotePackage(input);
  const blob = new Blob([report.bytes.slice().buffer], {
    type: report.mime,
  });
  const result = await saver(blob, report.fileName);
  if (result.status === 'canceled') {
    return { status: 'canceled' };
  }
  const actualFileName = basename(result.path) ?? report.fileName;
  return {
    status: 'saved',
    report,
    path: result.path,
    target: result.target,
    actualFileName,
    renamed: actualFileName !== report.fileName,
  };
}
