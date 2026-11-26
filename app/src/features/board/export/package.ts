/**
 * 知行画板包（`.zxboard`）导出/导入（ZX5-IO-07 / ZX-DESIGN-16 §5–§7）。
 *
 * 包是标准 ZIP，不是伪装的 JSON：
 * - `manifest.json`：类型、版本、画板摘要、计数、条目与安全说明；
 * - `board.json`：与 v4 画板 JSON 完全同 schema，保留 nodes/edges/viewport/
 *   背景/锁定/样式与未知 payload 字段；
 * - `thumbnail.png`：可选，仅用于预览，导入不读取；
 * - `checksums.json`：manifest 与全部 payload 的 SHA-256。
 *
 * 导入分两段：`parseBoardPackage` 只读字节、完成全部校验；`remap.ts`
 * 在写库前生成新 board/node/edge ID。因此同一包连续导入两次不会撞主键。
 */

import type { SaveResult } from '../../attachments/fileActions';
import { saveBlobWithDialog } from '../../attachments/fileActions';
import { sha256Bytes } from '../../attachments/sha256';
import {
  BoardDocumentError,
  parseBoardDocumentFile,
  type BoardDocumentFileMetadata,
  type ParsedBoardDocumentFile,
} from '../model';
import type { BoardDocument, BoardViewport } from '../types';
import { createZip, readZip, ZipError, type ZipWriteEntry } from '../../export/zip';
import {
  renderBoardPng,
  type BoardExportOptions,
  type RenderedBoardPng,
} from './image';

export const BOARD_PACKAGE_APP = 'zhixing';
export const BOARD_PACKAGE_KIND = 'board-package';
export const BOARD_PACKAGE_FORMAT = 'zxboard';
export const BOARD_PACKAGE_FORMAT_VERSION = 1;
export const BOARD_PACKAGE_MIN_READER_VERSION = 1;
export const BOARD_PACKAGE_SCHEMA_VERSION = 2;
export const BOARD_PACKAGE_DEFAULT_APP_VERSION = '0.1.0';
export const BOARD_PACKAGE_GENERATOR = 'zhixing/board-package@1';
export const BOARD_PACKAGE_EXTENSION = '.zxboard';
export const BOARD_PACKAGE_MIME = 'application/zip';

/**
 * 普通用户「导入画板包」的接受类型。
 *
 * 只允许 `.zxboard`：`.json` 是开发者/调试入口，不能混在包入口里让用户
 * 误以为 JSON 可以跨软件使用。`BOARD_PACKAGE_ACCEPT` 保留给需要同时
 * 接受 JSON 的旧调用方（测试/兼容），新 UI 不再使用。
 */
export const BOARD_PACKAGE_IMPORT_ACCEPT = '.zxboard,application/zip';
/** 兼容旧调用方；包含 `.json` 的开发者入口。 */
export const BOARD_PACKAGE_ACCEPT = '.zxboard,.json,application/json,application/zip';

export const BOARD_PACKAGE_MAX_BYTES = 64 * 1024 * 1024;
export const BOARD_PACKAGE_MAX_BOARD_JSON_BYTES = 10 * 1024 * 1024;
export const BOARD_PACKAGE_MAX_THUMBNAIL_BYTES = 1024 * 1024;

const decoder = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();
const SHA256_HEX = /^[a-f0-9]{64}$/;

export type BoardPackageChecksumEntry = {
  path: string;
  byteSize: number;
  sha256: string;
};

export type BoardPackageManifestEntry = {
  path: string;
  role: 'board' | 'thumbnail';
  byteSize: number;
  sha256: string;
  sourceBoardId?: string;
};

export type BoardPackageManifest = {
  app: string;
  kind: string;
  format: string;
  version: number;
  formatVersion: number;
  minReaderVersion: number;
  exportedAt: string;
  appVersion: string;
  schemaVersion: number;
  generator: string;
  board: {
    sourceId: string;
    sourceNoteId: string | null;
    title: string;
    background: string;
    nodeCount: number;
    edgeCount: number;
    viewport: BoardViewport | null;
  };
  counts: {
    nodes: number;
    edges: number;
    thumbnail: number;
  };
  entries: BoardPackageManifestEntry[];
  security: {
    secretsExcluded: true;
    excludedScopes: string[];
  };
  notes: string[];
};

export type BoardPackageReport = {
  format: typeof BOARD_PACKAGE_FORMAT;
  fileName: string;
  mime: string;
  bytes: Uint8Array;
  size: number;
  warnings: string[];
  manifest: BoardPackageManifest;
  /** 包内文件树，按 ZIP 顺序（manifest 第一、checksums 最后）。 */
  files: string[];
  generatedAt: string;
  thumbnailIncluded: boolean;
};

export type BoardPackageSaveResult =
  | {
      status: 'saved';
      report: BoardPackageReport;
      path: string | null;
      target: 'desktop' | 'browser';
      actualFileName: string;
      renamed: boolean;
    }
  | { status: 'canceled' };

export type BoardPackageSaver = (
  blob: Blob,
  fileName: string,
) => Promise<SaveResult>;

export type BoardPackageImportErrorCode =
  | 'ZXBOARD_TOO_LARGE'
  | 'ZXBOARD_ZIP_INVALID'
  | 'ZXBOARD_MANIFEST_INVALID'
  | 'ZXBOARD_VERSION_UNSUPPORTED'
  | 'ZXBOARD_CHECKSUM_MISMATCH'
  | 'ZXBOARD_FILE_MISSING'
  | 'ZXBOARD_STRUCTURE_INVALID'
  | 'ZXBOARD_COUNT_MISMATCH'
  | 'ZXBOARD_BOARD_INVALID'
  | 'ZXBOARD_EDGE_DANGLING'
  | 'ZXBOARD_LIMIT_EXCEEDED'
  | 'ZXBOARD_THUMBNAIL_MISSING';

export class BoardPackageImportError extends Error {
  readonly code: BoardPackageImportErrorCode;
  readonly fileName: string | null;

  constructor(
    code: BoardPackageImportErrorCode,
    message: string,
    fileName: string | null = null,
  ) {
    super(message);
    this.name = 'BoardPackageImportError';
    this.code = code;
    this.fileName = fileName;
  }
}

export type ParsedBoardPackage = {
  document: BoardDocument;
  viewport: BoardViewport | null;
  metadata: BoardDocumentFileMetadata;
  manifest: BoardPackageManifest;
  /** 排序后的包内路径，便于预览文件树。 */
  files: string[];
  thumbnail: Uint8Array | null;
  warnings: string[];
};

export type BoardPackageThumbnailRenderer = (
  document: BoardDocument,
  options: BoardExportOptions,
) => Promise<RenderedBoardPng>;

export type BuildBoardPackageInput = {
  document: BoardDocument;
  viewport?: BoardViewport | null;
  /** 默认 true；缩略图失败只警告，不阻断导出。 */
  includeThumbnail?: boolean;
  now?: Date;
  appVersion?: string;
  schemaVersion?: number;
  renderThumbnail?: BoardPackageThumbnailRenderer;
};

function fail(
  code: BoardPackageImportErrorCode,
  message: string,
  fileName: string | null = null,
): never {
  throw new BoardPackageImportError(code, message, fileName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value, null, 2));
}

function sanitizeTitle(title: string): string {
  return (
    Array.from(
      (title || '')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
      .slice(0, 120)
      .join('') || '未命名画板'
  );
}

function timestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate(),
  )}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** 文件名：`标题-YYYYMMDD-HHmm.zxboard`。 */
export function boardPackageFileName(
  title: string,
  now: Date = new Date(),
): string {
  return `${sanitizeTitle(title)}-${timestamp(now)}.zxboard`;
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength < signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[index] === byte);
}

function basename(path: string | null): string | null {
  if (!path) {
    return null;
  }
  return path.split(/[\\/]/).pop() ?? null;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 构建 `.zxboard` 包。缩略图按规范白底、1x、最长边 1024、padding 24；
 * Canvas 不可用或渲染失败时省略缩略图并给出警告，`board.json` 始终完整。
 */
export async function buildBoardPackage(
  input: BuildBoardPackageInput,
): Promise<BoardPackageReport> {
  const now = input.now ?? new Date();
  const exportedAt = now.toISOString();
  const appVersion =
    input.appVersion ?? BOARD_PACKAGE_DEFAULT_APP_VERSION;
  const schemaVersion =
    input.schemaVersion ?? BOARD_PACKAGE_SCHEMA_VERSION;
  const document = input.document;
  const viewport = input.viewport ?? null;
  const warnings: string[] = [];

  const boardJson = {
    version: 1 as const,
    schema: 'zhixing.board',
    metadata: {
      app: BOARD_PACKAGE_APP,
      schema: 'zhixing.board',
      exportedAt,
    },
    boardId: document.boardId,
    noteId: document.noteId,
    title: document.title,
    background: document.background,
    viewport,
    nodes: document.nodes,
    edges: document.edges,
  };
  const boardBytes = jsonBytes(boardJson);

  const files = new Map<string, Uint8Array>();
  files.set('board.json', boardBytes);

  let thumbnailIncluded = false;
  if (input.includeThumbnail !== false) {
    if (document.nodes.length === 0) {
      warnings.push('画板为空，未生成缩略图；board.json 仍可正常往返。');
    } else {
      try {
        const rendered = await (input.renderThumbnail ?? renderBoardPng)(
          document,
          {
            background: 'white',
            scale: 1,
            padding: 24,
            maxDimension: 1024,
          },
        );
        const bytes = await blobBytes(rendered.blob);
        if (bytes.byteLength > BOARD_PACKAGE_MAX_THUMBNAIL_BYTES) {
          warnings.push('缩略图超过 1 MiB，已省略；导入不受影响。');
        } else if (!isPng(bytes)) {
          warnings.push('缩略图不是有效 PNG，已省略；导入不受影响。');
        } else {
          files.set('thumbnail.png', bytes);
          thumbnailIncluded = true;
        }
      } catch (reason) {
        warnings.push(
          `缩略图生成失败，已省略：${
            reason instanceof Error ? reason.message : '未知原因'
          }`,
        );
      }
    }
  }

  const entries: BoardPackageManifestEntry[] = [];
  for (const path of ['board.json', 'thumbnail.png']) {
    const data = files.get(path);
    if (!data) {
      continue;
    }
    entries.push({
      path,
      role: path === 'board.json' ? 'board' : 'thumbnail',
      byteSize: data.byteLength,
      sha256: sha256Bytes(data),
      ...(path === 'board.json'
        ? { sourceBoardId: document.boardId }
        : {}),
    });
  }

  const checksums: BoardPackageChecksumEntry[] = entries.map((entry) => ({
    path: entry.path,
    byteSize: entry.byteSize,
    sha256: entry.sha256,
  }));

  const manifest: BoardPackageManifest = {
    app: BOARD_PACKAGE_APP,
    kind: BOARD_PACKAGE_KIND,
    format: BOARD_PACKAGE_FORMAT,
    version: BOARD_PACKAGE_FORMAT_VERSION,
    formatVersion: BOARD_PACKAGE_FORMAT_VERSION,
    minReaderVersion: BOARD_PACKAGE_MIN_READER_VERSION,
    exportedAt,
    appVersion,
    schemaVersion,
    generator: BOARD_PACKAGE_GENERATOR,
    board: {
      sourceId: document.boardId,
      sourceNoteId: document.noteId,
      title: document.title,
      background: document.background,
      nodeCount: document.nodes.length,
      edgeCount: document.edges.length,
      viewport,
    },
    counts: {
      nodes: document.nodes.length,
      edges: document.edges.length,
      thumbnail: thumbnailIncluded ? 1 : 0,
    },
    entries,
    security: {
      secretsExcluded: true,
      excludedScopes: [
        '账号与登录态',
        '设备令牌 / 配对码',
        'WebDAV 密码与同步游标',
        '账号 / 令牌 / 设备密钥',
      ],
    },
    notes: [
      '单张画板包，不替代整库备份。',
      '导入会为画板、对象与连线生成新 ID，不覆盖同库已有画板。',
      '缩略图只用于预览，导入只读取 board.json。',
    ],
  };

  const manifestBytes = jsonBytes(manifest);
  const checksumsJson = {
    format: 'zhixing.board.checksums',
    version: 1,
    algorithm: 'sha256' as const,
    files: [
      {
        path: 'manifest.json',
        byteSize: manifestBytes.byteLength,
        sha256: sha256Bytes(manifestBytes),
      },
      ...checksums,
    ],
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
    throw new BoardPackageImportError(
      'ZXBOARD_ZIP_INVALID',
      reason instanceof Error ? reason.message : '生成画板包失败',
    );
  }
  if (bytes.byteLength > BOARD_PACKAGE_MAX_BYTES) {
    throw new BoardPackageImportError(
      'ZXBOARD_TOO_LARGE',
      '画板包超过 64 MiB 上限',
    );
  }

  return {
    format: BOARD_PACKAGE_FORMAT,
    fileName: boardPackageFileName(document.title, now),
    mime: BOARD_PACKAGE_MIME,
    bytes,
    size: bytes.byteLength,
    warnings,
    manifest,
    files: ['manifest.json', ...payloadPaths, 'checksums.json'],
    generatedAt: exportedAt,
    thumbnailIncluded,
  };
}

function jsonFile(
  files: ReadonlyMap<string, Uint8Array>,
  path: string,
  maxBytes: number,
  fileName: string | null,
): unknown {
  const bytes = files.get(path);
  if (!bytes) {
    fail('ZXBOARD_FILE_MISSING', `包内缺少必需文件：${path}`, fileName);
  }
  if (bytes.byteLength > maxBytes) {
    fail(
      'ZXBOARD_STRUCTURE_INVALID',
      `${path} 超过大小上限（${Math.round(maxBytes / 1024)} KB）`,
      fileName,
    );
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    fail('ZXBOARD_STRUCTURE_INVALID', `${path} 不是有效的 JSON`, fileName);
  }
}

function checksumList(
  raw: unknown,
  fileName: string | null,
): BoardPackageChecksumEntry[] {
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
        'ZXBOARD_MANIFEST_INVALID',
        `校验和第 ${index + 1} 项格式无效`,
        fileName,
      );
    }
    const path = asString(entry.path);
    const sha256 = asString(entry.sha256).toLowerCase();
    if (!path || !SHA256_HEX.test(sha256)) {
      fail(
        'ZXBOARD_MANIFEST_INVALID',
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
  checksums: BoardPackageChecksumEntry[],
  fileName: string | null,
): void {
  if (checksums.length === 0) {
    fail(
      'ZXBOARD_MANIFEST_INVALID',
      '包内没有校验和清单，拒绝导入',
      fileName,
    );
  }
  const covered = new Set<string>();
  for (const entry of checksums) {
    if (covered.has(entry.path)) {
      continue;
    }
    covered.add(entry.path);
    const bytes = files.get(entry.path);
    if (!bytes) {
      fail(
        'ZXBOARD_FILE_MISSING',
        `校验和引用的文件不存在：${entry.path}`,
        fileName,
      );
    }
    if (entry.byteSize > 0 && entry.byteSize !== bytes.byteLength) {
      fail(
        'ZXBOARD_CHECKSUM_MISMATCH',
        `${entry.path} 字节数不符（期望 ${entry.byteSize}，实际 ${bytes.byteLength}）`,
        fileName,
      );
    }
    if (sha256Bytes(bytes) !== entry.sha256) {
      fail(
        'ZXBOARD_CHECKSUM_MISMATCH',
        `${entry.path} 校验和不符，包可能已被篡改`,
        fileName,
      );
    }
  }
  if (!covered.has('board.json')) {
    fail(
      'ZXBOARD_CHECKSUM_MISMATCH',
      'board.json 没有出现在校验和清单中，拒绝导入',
      fileName,
    );
  }
  for (const path of files.keys()) {
    if (path === 'manifest.json' || path === 'checksums.json') {
      continue;
    }
    if (!covered.has(path)) {
      fail(
        'ZXBOARD_CHECKSUM_MISMATCH',
        `${path} 没有出现在校验和清单中，拒绝导入`,
        fileName,
      );
    }
  }
}

function parseManifest(
  raw: unknown,
  fileName: string | null,
): BoardPackageManifest {
  if (!isRecord(raw)) {
    fail('ZXBOARD_MANIFEST_INVALID', 'manifest.json 必须是对象', fileName);
  }
  if (asString(raw.app) !== BOARD_PACKAGE_APP) {
    fail(
      'ZXBOARD_MANIFEST_INVALID',
      '这不是知行画板包（manifest.app 不是 zhixing）',
      fileName,
    );
  }
  const kind = asString(raw.kind);
  const format = asString(raw.format);
  if (
    kind !== BOARD_PACKAGE_KIND &&
    format !== BOARD_PACKAGE_FORMAT &&
    asString(raw.generator) !== BOARD_PACKAGE_GENERATOR
  ) {
    fail(
      'ZXBOARD_MANIFEST_INVALID',
      '包类型不是 board-package，拒绝按画板包导入',
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
      'ZXBOARD_MANIFEST_INVALID',
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
      'ZXBOARD_MANIFEST_INVALID',
      'manifest.minReaderVersion 必须是数字',
      fileName,
    );
  }
  const formatVersion = asNumber(
    rawFormatVersion,
    BOARD_PACKAGE_FORMAT_VERSION,
  );
  const minReaderVersion = asNumber(
    raw.minReaderVersion,
    BOARD_PACKAGE_MIN_READER_VERSION,
  );
  if (
    formatVersion > BOARD_PACKAGE_FORMAT_VERSION ||
    minReaderVersion > BOARD_PACKAGE_MIN_READER_VERSION
  ) {
    fail(
      'ZXBOARD_VERSION_UNSUPPORTED',
      `该画板包由更新版本导出（formatVersion=${formatVersion}，minReaderVersion=${minReaderVersion}），当前版本无法读取`,
      fileName,
    );
  }
  if (!isRecord(raw.board)) {
    fail('ZXBOARD_MANIFEST_INVALID', 'manifest.board 必须是对象', fileName);
  }
  if (
    typeof raw.board.title !== 'string' ||
    typeof raw.board.sourceId !== 'string' ||
    !Number.isFinite(raw.board.nodeCount) ||
    !Number.isFinite(raw.board.edgeCount)
  ) {
    fail(
      'ZXBOARD_MANIFEST_INVALID',
      'manifest.board 缺少 title/sourceId/nodeCount/edgeCount',
      fileName,
    );
  }
  return raw as unknown as BoardPackageManifest;
}

function mapBoardDocumentError(
  reason: unknown,
  fileName: string | null,
): never {
  if (reason instanceof BoardDocumentError) {
    if (reason.code === 'version') {
      fail('ZXBOARD_VERSION_UNSUPPORTED', reason.message, fileName);
    }
    if (reason.code === 'edge') {
      fail('ZXBOARD_EDGE_DANGLING', reason.message, fileName);
    }
    if (/过多|上限/.test(reason.message)) {
      fail('ZXBOARD_LIMIT_EXCEEDED', reason.message, fileName);
    }
    fail('ZXBOARD_BOARD_INVALID', reason.message, fileName);
  }
  fail(
    'ZXBOARD_BOARD_INVALID',
    reason instanceof Error ? reason.message : '画板 JSON 无法解析',
    fileName,
  );
}

function countMismatch(
  manifest: BoardPackageManifest,
  parsed: ParsedBoardDocumentFile,
): string | null {
  const expectedNodes = [
    asNumberOrNull(manifest.board?.nodeCount),
    asNumberOrNull(manifest.counts?.nodes),
  ].filter((value): value is number => value !== null);
  const expectedEdges = [
    asNumberOrNull(manifest.board?.edgeCount),
    asNumberOrNull(manifest.counts?.edges),
  ].filter((value): value is number => value !== null);
  for (const expected of expectedNodes) {
    if (expected !== parsed.document.nodes.length) {
      return `节点数不一致（manifest=${expected}，board.json=${parsed.document.nodes.length}）`;
    }
  }
  for (const expected of expectedEdges) {
    if (expected !== parsed.document.edges.length) {
      return `连线数不一致（manifest=${expected}，board.json=${parsed.document.edges.length}）`;
    }
  }
  return null;
}

/**
 * 读取并校验 `.zxboard`。校验失败抛 `BoardPackageImportError`，调用方在
 * 写库前展示错误并禁用导入；成功时返回源文档与 viewport，ID 重映射由
 * `remapBoardDocument` 负责。
 */
export async function parseBoardPackage(
  input: Uint8Array | ArrayBuffer,
  options: { fileName?: string | null } = {},
): Promise<ParsedBoardPackage> {
  const fileName = options.fileName ?? null;
  const bytes =
    input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > BOARD_PACKAGE_MAX_BYTES) {
    fail(
      'ZXBOARD_TOO_LARGE',
      '画板包超过 64 MiB 上限，拒绝导入',
      fileName,
    );
  }

  let entries;
  try {
    entries = await readZip(bytes);
  } catch (reason) {
    fail(
      'ZXBOARD_ZIP_INVALID',
      reason instanceof ZipError ? reason.message : '文件不是有效的画板包 ZIP',
      fileName,
    );
  }
  const files = new Map(entries.map((entry) => [entry.path, entry.data]));

  const manifestRaw = jsonFile(
    files,
    'manifest.json',
    2 * 1024 * 1024,
    fileName,
  );
  const manifest = parseManifest(manifestRaw, fileName);
  const checksumsRaw = jsonFile(
    files,
    'checksums.json',
    2 * 1024 * 1024,
    fileName,
  );
  const checksums = checksumList(checksumsRaw, fileName);
  validateChecksums(files, checksums, fileName);

  const boardRaw = jsonFile(
    files,
    'board.json',
    BOARD_PACKAGE_MAX_BOARD_JSON_BYTES,
    fileName,
  );
  let parsed: ParsedBoardDocumentFile;
  try {
    parsed = parseBoardDocumentFile(boardRaw);
  } catch (reason) {
    mapBoardDocumentError(reason, fileName);
  }

  const mismatch = countMismatch(manifest, parsed);
  if (mismatch) {
    fail('ZXBOARD_COUNT_MISMATCH', mismatch, fileName);
  }

  const warnings: string[] = [...parsed.warnings];
  let thumbnail: Uint8Array | null = null;
  const thumbnailBytes = files.get('thumbnail.png');
  if (!thumbnailBytes) {
    warnings.push('ZXBOARD_THUMBNAIL_MISSING：包内没有缩略图，已跳过预览。');
  } else if (thumbnailBytes.byteLength > BOARD_PACKAGE_MAX_THUMBNAIL_BYTES) {
    warnings.push('ZXBOARD_THUMBNAIL_MISSING：缩略图超过 1 MiB，已跳过预览。');
  } else if (!isPng(thumbnailBytes)) {
    warnings.push('ZXBOARD_THUMBNAIL_MISSING：缩略图损坏，已跳过预览。');
  } else {
    thumbnail = thumbnailBytes;
  }

  return {
    document: parsed.document,
    viewport: parsed.viewport,
    metadata: parsed.metadata,
    manifest,
    files: entries
      .map((entry) => entry.path)
      .sort((a, b) => a.localeCompare(b)),
    thumbnail,
    warnings,
  };
}

/** 生成并保存 `.zxboard`；取消保存面板时不写文件。 */
export async function saveBoardPackageToFile(
  input: BuildBoardPackageInput,
  saver: BoardPackageSaver = saveBlobWithDialog,
): Promise<BoardPackageSaveResult> {
  const report = await buildBoardPackage(input);
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
