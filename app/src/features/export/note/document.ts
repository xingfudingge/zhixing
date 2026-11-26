/**
 * 笔记块 → 单篇导出文档模型。
 *
 * `note_blocks` 是正文权威投影，`notes.body` 只是兼容缓存；导出优先读取
 * 块，只有在完全没有块记录时才回退到旧版 HTML 正文（并明确报告降级）。
 *
 * 所有格式共用这一份模型：
 * - 块顺序、列表缩进/编号、待办勾选、引用出处、表格合并、公式显示模式、
 *   内外链分类都在这里一次算清；
 * - 附件二进制由调用方注入 `resolveAttachment` 读取，本模块不直接碰
 *   IndexedDB/Tauri；
 * - 缺失图片、附件服务不可用、画板占位等降级项写入 `warnings`。
 */

import type { Note } from '../../../data/db/types';
import type { BlockPayload } from '../../../data/repositories/blocks';
import type { EditorBlock } from '../../../data/repositories/blocks';
import type { BoardDocument } from '../../board/types';
import { htmlToPlainText } from '../../../data/repositories/notes';
import {
  blockAlign,
  blockBoard,
  blockChecked,
  blockCode,
  blockFile,
  blockFormula,
  blockIndent,
  blockLanguage,
  blockLink,
  blockQuoteMeta,
  blockRuns,
  blockTableModel,
  headingLevel,
  isTextualBlockType,
  type InlineRun,
} from '../../editor/types';
import {
  formulaDisplayMode,
  splitFormulaDelimiters,
} from '../../editor/blockHtml';
import {
  internalNoteIdFromUrl,
  sanitizeLinkUrl,
} from '../../editor/security';
import { formatDateTime } from '../utils';
import type {
  NoteExportAsset,
  NoteExportBlock,
  NoteExportBoardAsset,
  NoteExportDocument,
  NoteExportFacts,
  NoteExportHeading,
  NoteExportMeta,
  NoteExportOptions,
  NoteExportRun,
  NoteExportRunLink,
} from './types';

const EMPTY_FACTS: NoteExportFacts = {
  blocks: 0,
  headings: 0,
  tables: 0,
  code: 0,
  formulas: 0,
  images: 0,
  files: 0,
  boards: 0,
  internalLinks: 0,
  externalLinks: 0,
  coloredRuns: 0,
  unknownBlocks: 0,
  words: 0,
};

export type ResolvedNoteAttachment = {
  blob: Blob | null;
  bytes: Uint8Array | null;
  sha256: string | null;
  status: NoteExportAsset['status'];
  error: string | null;
  fileName?: string;
  mime?: string;
  byteSize?: number;
};

export type ResolveNoteAttachment = (
  attachmentId: string,
  fallback: { fileName: string; mime: string; byteSize: number },
) => Promise<ResolvedNoteAttachment | null>;

/** 按 boardId 读取完整画板文档；读取失败返回 null，由调用方写降级占位。 */
export type ResolveNoteBoard = (
  boardId: string,
) => Promise<BoardDocument | null>;

/** `renderBoardPng` 的最小投影；文档模型不依赖 Canvas/DOM。 */
export type RenderedNoteBoard = {
  blob: Blob | null;
  bytes: Uint8Array;
  mime: string;
  /** 1x 逻辑尺寸（2x PNG 已除以倍率）。 */
  width: number;
  height: number;
  limited: boolean;
};

export type RenderNoteBoard = (
  board: BoardDocument,
) => Promise<RenderedNoteBoard>;

export type BuildNoteExportDocumentInput = {
  note: Pick<
    Note,
    | 'id'
    | 'title'
    | 'folderId'
    | 'tags'
    | 'body'
    | 'status'
    | 'deletedAt'
    | 'createdAt'
    | 'updatedAt'
  >;
  blocks: ReadonlyArray<EditorBlock>;
  options: NoteExportOptions;
  /** 由知识页传入，避免导出模块重复维护目录常量。 */
  folderName: string;
  noteTitles?: ReadonlyMap<string, string>;
  resolveAttachment?: ResolveNoteAttachment;
  /** 画板文档数据源；不可用时画板块保留占位并写降级警告。 */
  resolveBoard?: ResolveNoteBoard;
  /** 默认由 `index.ts` 注入 `renderBoardPng`；测试可注入假实现。 */
  renderBoard?: RenderNoteBoard;
  now?: Date;
};

function textOfRuns(runs: ReadonlyArray<{ text: string }>): string {
  return runs.map((run) => run.text).join('');
}

function exportLink(value: unknown): NoteExportRunLink | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const href = sanitizeLinkUrl(value);
  if (!href) {
    return null;
  }
  const noteId = internalNoteIdFromUrl(href);
  return { href, internal: noteId !== null, noteId };
}

function exportRun(
  run: InlineRun,
  facts: NoteExportFacts,
): NoteExportRun {
  const marks = run.marks;
  const link = exportLink(marks?.link);
  if (link?.internal) {
    facts.internalLinks += 1;
  } else if (link) {
    facts.externalLinks += 1;
  }
  if (marks?.color || marks?.background) {
    facts.coloredRuns += 1;
  }
  return {
    text: run.text,
    ...(marks?.bold ? { bold: true } : {}),
    ...(marks?.italic ? { italic: true } : {}),
    ...(marks?.underline ? { underline: true } : {}),
    ...(marks?.strike ? { strike: true } : {}),
    ...(marks?.code ? { code: true } : {}),
    ...(marks?.color ? { color: marks.color } : {}),
    ...(marks?.background ? { background: marks.background } : {}),
    ...(link ? { link } : {}),
  };
}

function exportRuns(
  runs: ReadonlyArray<InlineRun>,
  facts: NoteExportFacts,
): NoteExportRun[] {
  return runs.map((run) => exportRun(run, facts));
}

function isImageMime(mime: string, fileName = ''): boolean {
  if (/^image\//i.test(mime)) {
    return true;
  }
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(fileName);
}

function readString(payload: BlockPayload, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(payload: BlockPayload, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

async function resolveAsset(
  attachmentId: string | null,
  fallback: { fileName: string; mime: string; byteSize: number },
  resolveAttachment: ResolveNoteAttachment | undefined,
): Promise<NoteExportAsset | null> {
  if (!attachmentId) {
    return null;
  }
  if (!resolveAttachment) {
    return {
      attachmentId,
      ...fallback,
      sha256: null,
      status: 'unavailable',
      error: '附件服务不可用，无法读取本机二进制',
      blob: null,
      bytes: null,
    };
  }
  try {
    const resolved = await resolveAttachment(attachmentId, fallback);
    if (!resolved) {
      return {
        attachmentId,
        ...fallback,
        sha256: null,
        status: 'missing',
        error: '本机没有这个附件，需要先下载',
        blob: null,
        bytes: null,
      };
    }
    return {
      attachmentId,
      fileName: resolved.fileName || fallback.fileName,
      mime: resolved.mime || fallback.mime,
      byteSize:
        (resolved.byteSize ?? 0) > 0
          ? resolved.byteSize!
          : fallback.byteSize,
      sha256: resolved.sha256,
      status: resolved.status,
      error: resolved.error,
      blob: resolved.blob,
      bytes: resolved.bytes,
    };
  } catch (reason) {
    return {
      attachmentId,
      ...fallback,
      sha256: null,
      status: 'error',
      error:
        reason instanceof Error && reason.message
          ? reason.message
          : '读取附件失败',
      blob: null,
      bytes: null,
    };
  }
}

function assetWarning(asset: NoteExportAsset, label = '图片'): string {
  const reason = asset.error ?? '本机没有这个附件';
  return `${label}「${asset.fileName || asset.attachmentId}」缺失：${reason}，已写入占位符`;
}

function errorText(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  return typeof reason === 'string' && reason.trim() ? reason : '未知错误';
}

/** PNG → base64；按块拼接，避免大画板一次性展开参数导致栈溢出。 */
function bytesToBase64(bytes: Uint8Array): string {
  if (typeof globalThis.btoa !== 'function') {
    return '';
  }
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return globalThis.btoa(binary);
}

type BoardResolution = {
  asset: NoteExportBoardAsset | null;
  missingReason: string | null;
};

/**
 * 读取并渲染一张画板；同一个 boardId 只读取/渲染一次。
 *
 * 渲染失败分三类写降级报告：空画板 / 数据缺失 / Canvas 异常。无论哪类都
 * 返回 `asset: null`，由 docx/pdf 输出可见占位，不静默退化成普通文字。
 */
async function resolveBoardBlock(
  boardId: string | null,
  title: string,
  cache: Map<string, BoardResolution>,
  input: BuildNoteExportDocumentInput,
  warnings: string[],
): Promise<BoardResolution> {
  if (!boardId) {
    warnings.push(
      `【BOARD_IMAGE_MISSING】画板「${title}」没有画板引用，已写入占位。`,
    );
    return { asset: null, missingReason: '没有画板引用' };
  }

  const cached = cache.get(boardId);
  if (cached) {
    return cached;
  }

  const fallback = (
    reason: string,
    code:
      | 'BOARD_IMAGE_MISSING'
      | 'BOARD_IMAGE_EMPTY'
      | 'BOARD_IMAGE_FAILED' = 'BOARD_IMAGE_MISSING',
  ): BoardResolution => {
    const entry: BoardResolution = { asset: null, missingReason: reason };
    cache.set(boardId, entry);
    warnings.push(`【${code}】画板「${title}」${reason}，已写入占位。`);
    return entry;
  };

  if (!input.resolveBoard) {
    return fallback('画板数据源不可用');
  }
  if (!input.renderBoard) {
    return fallback('画板渲染器不可用');
  }

  let board: BoardDocument | null = null;
  try {
    board = await input.resolveBoard(boardId);
  } catch (reason) {
    return fallback(`读取失败：${errorText(reason)}`);
  }
  if (!board) {
    return fallback('画板数据不存在');
  }

  let rendered: RenderedNoteBoard;
  try {
    rendered = await input.renderBoard(board);
  } catch (reason) {
    if ((reason as { code?: unknown } | null)?.code === 'empty') {
      return fallback('空画板没有可导出的内容', 'BOARD_IMAGE_EMPTY');
    }
    return fallback(`渲染失败：${errorText(reason)}`, 'BOARD_IMAGE_FAILED');
  }
  if (!rendered.bytes || rendered.bytes.byteLength === 0) {
    return fallback('渲染结果为空', 'BOARD_IMAGE_FAILED');
  }

  const asset: NoteExportBoardAsset = {
    boardId,
    fileName: `${(board.title || title || '画板').replace(/[\\/:*?"<>|]/g, ' ')}.png`,
    mime: rendered.mime || 'image/png',
    byteSize: rendered.bytes.byteLength,
    sha256: null,
    status: 'available',
    error: null,
    blob: rendered.blob,
    bytes: rendered.bytes,
    base64: bytesToBase64(rendered.bytes),
    width: Math.max(1, rendered.width),
    height: Math.max(1, rendered.height),
    limited: rendered.limited,
  };
  const entry: BoardResolution = { asset, missingReason: null };
  cache.set(boardId, entry);
  if (rendered.limited) {
    warnings.push(
      `【BOARD_IMAGE_LIMITED】画板「${title}」超过导出尺寸上限，已等比缩小为 ${Math.round(
        asset.width,
      )}×${Math.round(asset.height)}。`,
    );
  }
  return entry;
}


function countWords(text: string): number {
  const chinese = text.match(/[㐀-鿿]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
  return chinese + latin;
}

function plainTextOfBlock(block: NoteExportBlock): string {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
    case 'todo':
    case 'bullet':
    case 'ordered':
    case 'quote':
      return textOfRuns(block.runs);
    case 'code':
      return block.code;
    case 'table':
      return block.model.rows
        .map((row: Array<{ text: string }>) => row.map((cell) => cell.text).join('\t'))
        .join('\n');
    case 'image':
      return block.alt || block.fileName;
    case 'file':
      return block.file.fileName;
    case 'board':
      return block.title;
    case 'formula':
      return block.latex;
    case 'link':
      return block.title || block.url;
    case 'divider':
      return '';
    case 'unknown':
      return block.text;
  }
}

export function summarizeNoteBlocks(
  blocks: ReadonlyArray<EditorBlock>,
): string {
  let tables = 0;
  let code = 0;
  let formulas = 0;
  let images = 0;
  let files = 0;
  let internalLinks = 0;
  for (const block of blocks) {
    if (block.type === 'table') tables += 1;
    if (block.type === 'code') code += 1;
    if (block.type === 'formula') formulas += 1;
    if (block.type === 'image') images += 1;
    if (block.type === 'file') files += 1;
    const text = blocksToSearchText(block);
    if (/zhixing:\/\/note\//.test(text)) internalLinks += 1;
  }
  if (blocks.length === 0) {
    return '空笔记（仅标题）';
  }
  const parts = [
    `${blocks.length} 个块`,
    tables ? `${tables} 张表` : '',
    code ? `${code} 段代码` : '',
    formulas ? `${formulas} 个公式` : '',
    images ? `${images} 张图片` : '',
    files ? `${files} 个附件` : '',
    internalLinks ? `${internalLinks} 个内链` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function blocksToSearchText(block: EditorBlock): string {
  const runs = blockRuns(block).map((run) => run.text).join(' ');
  const file = block.type === 'file' ? blockFile(block) : null;
  return [
    runs,
    typeof block.payload.text === 'string' ? block.payload.text : '',
    typeof block.payload.code === 'string' ? block.payload.code : '',
    typeof block.payload.url === 'string' ? block.payload.url : '',
    typeof block.payload.sourceUrl === 'string' ? block.payload.sourceUrl : '',
    file?.fileName ?? '',
  ].join(' ');
}

/**
 * 把块文档归一化为三种格式共用的模型。
 *
 * 附件解析按需进行：关闭“包含图片”时不读取 Blob，避免为了一张不导出的
 * 图去触发网络下载或大文件读取。
 */
export async function buildNoteExportDocument(
  input: BuildNoteExportDocumentInput,
): Promise<NoteExportDocument> {
  const now = input.now ?? new Date();
  const facts: NoteExportFacts = { ...EMPTY_FACTS };
  const warnings: string[] = [];
  const blocks: NoteExportBlock[] = [];
  const toc: NoteExportHeading[] = [];
  const boardCache = new Map<string, BoardResolution>();
  const title = input.note.title.trim() || '未命名笔记';
  const options = input.options;
  const trashed =
    input.note.status === 'trashed' || input.note.deletedAt !== null;
  let lastEmptyParagraph = false;
  let orderedCounters: number[] = [];
  let orderedActive = false;
  let unknownWarningAdded = false;

  const pushBlock = (block: NoteExportBlock): void => {
    blocks.push(block);
    facts.blocks += 1;
  };

  const resetOrdered = (): void => {
    orderedCounters = [];
    orderedActive = false;
  };

  const sourceBlocks = input.blocks.length > 0 ? input.blocks : [];

  if (sourceBlocks.length === 0 && input.note.body.trim()) {
    const text = htmlToPlainText(input.note.body);
    if (text) {
      pushBlock({
        kind: 'unknown',
        blockType: 'legacy-html',
        text,
      });
      facts.unknownBlocks += 1;
      warnings.push('旧版 HTML 正文没有块记录，已按纯文本导出；结构化格式建议重新保存一次笔记。');
    }
  }

  for (const block of sourceBlocks) {
    const type = block.type;

    if (isTextualBlockType(type)) {
      const runs = exportRuns(blockRuns(block), facts);
      const text = textOfRuns(runs);
      const indent = blockIndent(block);
      const align = blockAlign(block);

      if (type === 'paragraph') {
        if (!text.trim()) {
          if (lastEmptyParagraph) {
            continue;
          }
          lastEmptyParagraph = true;
        } else {
          lastEmptyParagraph = false;
        }
        pushBlock({ kind: 'paragraph', runs, ...(align ? { align } : {}) });
        resetOrdered();
        continue;
      }

      lastEmptyParagraph = false;

      const level = headingLevel(type);
      if (level) {
        if (!text.trim()) {
          continue;
        }
        pushBlock({ kind: 'heading', level, runs, ...(align ? { align } : {}) });
        facts.headings += 1;
        toc.push({ level, text: text.trim(), blockIndex: blocks.length - 1 });
        resetOrdered();
        continue;
      }

      if (type === 'todo') {
        pushBlock({
          kind: 'todo',
          runs,
          checked: blockChecked(block),
          indent,
        });
        resetOrdered();
        continue;
      }

      if (type === 'bullet_list') {
        pushBlock({ kind: 'bullet', runs, indent });
        resetOrdered();
        continue;
      }

      if (type === 'ordered_list') {
        if (!orderedActive) {
          orderedCounters = [];
          orderedActive = true;
        }
        const counterIndex = Math.max(0, Math.min(6, indent));
        orderedCounters[counterIndex] =
          (orderedCounters[counterIndex] ?? 0) + 1;
        orderedCounters = orderedCounters.slice(0, counterIndex + 1);
        pushBlock({
          kind: 'ordered',
          runs,
          indent,
          number: orderedCounters[counterIndex]!,
        });
        continue;
      }

      if (type === 'quote') {
        const meta = blockQuoteMeta(block);
        const noteTitle = meta.noteId
          ? input.noteTitles?.get(meta.noteId) ?? ''
          : '';
        pushBlock({
          kind: 'quote',
          runs,
          source: meta.source,
          noteId: meta.noteId,
          noteTitle,
          sourceUrl: meta.sourceUrl,
        });
        resetOrdered();
        continue;
      }
    }

    if (type === 'code') {
      pushBlock({
        kind: 'code',
        code: blockCode(block),
        language: blockLanguage(block),
      });
      facts.code += 1;
      resetOrdered();
      continue;
    }

    if (type === 'divider') {
      pushBlock({ kind: 'divider' });
      resetOrdered();
      continue;
    }

    if (type === 'table') {
      const model = blockTableModel(block).model;
      pushBlock({ kind: 'table', model, header: model.header });
      facts.tables += 1;
      resetOrdered();
      continue;
    }

    if (type === 'image') {
      const payload = block.payload;
      const attachmentId =
        typeof payload.attachmentId === 'string' ? payload.attachmentId : null;
      const fileName = readString(payload, 'fileName');
      const mime = readString(payload, 'mime');
      const byteSize = readNumber(payload, 'byteSize') ?? 0;
      const alt = readString(payload, 'alt') || fileName || '图片';
      const width = readNumber(payload, 'width');
      const height = readNumber(payload, 'height');
      const asset = options.includeImages
        ? await resolveAsset(
            attachmentId,
            { fileName, mime, byteSize },
            input.resolveAttachment,
          )
        : null;
      if (!options.includeImages) {
        warnings.push(`已按导出选项跳过图片「${fileName || '未命名图片'}」。`);
      } else if (asset && asset.status !== 'available') {
        warnings.push(assetWarning(asset));
      } else if (!attachmentId) {
        warnings.push(`图片「${fileName || alt}」没有附件引用，已写入占位符。`);
      }
      pushBlock({
        kind: 'image',
        asset,
        alt,
        fileName,
        mime,
        width,
        height,
        missingReason: !options.includeImages
          ? '导出时未包含图片'
          : !attachmentId
            ? '没有附件引用'
            : asset?.error ?? null,
      });
      facts.images += 1;
      resetOrdered();
      continue;
    }

    if (type === 'file') {
      const file = blockFile(block);
      const asImage =
        options.includeImages && isImageMime(file.mime, file.fileName);
      if (asImage) {
        const asset = await resolveAsset(
          file.attachmentId,
          {
            fileName: file.fileName,
            mime: file.mime,
            byteSize: file.byteSize,
          },
          input.resolveAttachment,
        );
        if (asset && asset.status !== 'available') {
          warnings.push(assetWarning(asset));
        }
        pushBlock({
          kind: 'image',
          asset,
          alt: file.fileName || '图片',
          fileName: file.fileName,
          mime: file.mime,
          width: null,
          height: null,
          missingReason: asset?.error ?? null,
        });
        facts.images += 1;
      } else {
        if (file.status === 'missing') {
          warnings.push(`文件「${file.fileName || '未命名文件'}」缺失，仅导出文件信息。`);
        }
        pushBlock({ kind: 'file', file: { ...file, asset: null } });
        facts.files += 1;
      }
      resetOrdered();
      continue;
    }

    if (type === 'board') {
      const board = blockBoard(block);
      let resolution: BoardResolution;
      if (options.format === 'md') {
        // Markdown 契约不嵌入画板 PNG（规范 §8.6），保留文字占位并报告。
        resolution = { asset: null, missingReason: null };
        warnings.push(
          `画板「${board.title}」以文字占位导出；Markdown 不嵌入画板图片（BOARD_IMAGE_MARKDOWN_PLACEHOLDER）。`,
        );
      } else {
        resolution = await resolveBoardBlock(
          board.boardId,
          board.title,
          boardCache,
          input,
          warnings,
        );
      }
      pushBlock({
        kind: 'board',
        boardId: board.boardId,
        title: board.title,
        asset: resolution.asset,
        width: resolution.asset?.width ?? null,
        height: resolution.asset?.height ?? null,
        missingReason: resolution.missingReason,
      });
      facts.boards += 1;
      resetOrdered();
      continue;
    }

    if (type === 'formula') {
      const formula = blockFormula(block);
      const split = splitFormulaDelimiters(formula.latex);
      pushBlock({
        kind: 'formula',
        latex: split.source,
        display: split.display ?? formulaDisplayMode(block.payload),
      });
      facts.formulas += 1;
      resetOrdered();
      continue;
    }

    if (type === 'link') {
      const link = blockLink(block);
      const safeUrl = sanitizeLinkUrl(link.url) ?? link.url;
      const internal = internalNoteIdFromUrl(safeUrl) !== null;
      if (internal) {
        facts.internalLinks += 1;
      } else if (safeUrl) {
        facts.externalLinks += 1;
      }
      pushBlock({
        kind: 'link',
        title: link.title.trim(),
        url: safeUrl,
        internal,
      });
      resetOrdered();
      continue;
    }

    const text = readString(block.payload, 'text');
    pushBlock({
      kind: 'unknown',
      blockType: type,
      text,
    });
    facts.unknownBlocks += 1;
    if (!unknownWarningAdded) {
      unknownWarningAdded = true;
      warnings.push('笔记含未知块，已按可读文本导出，不做静默删除。');
    }
    resetOrdered();
  }

  const plainText = blocks.map(plainTextOfBlock).join('\n');
  facts.words = countWords(plainText);

  const meta: NoteExportMeta = {
    title,
    folderName: input.folderName,
    tags: input.note.tags.map((tag) => tag.trim()).filter(Boolean),
    createdAt: input.note.createdAt,
    updatedAt: input.note.updatedAt,
    status: trashed ? 'trashed' : 'active',
    wordCount: facts.words,
    exportedAt: now.toISOString(),
  };

  return {
    title,
    meta,
    blocks,
    toc,
    facts,
    warnings,
    options,
  };
}

export function noteMetaLines(meta: NoteExportMeta): string[] {
  const lines = [
    `创建：${formatDateTime(meta.createdAt)} · 更新：${formatDateTime(meta.updatedAt)}`,
  ];
  const second: string[] = [];
  if (meta.folderName) {
    second.push(`目录：${meta.folderName}`);
  }
  if (meta.tags.length > 0) {
    second.push(`标签：${meta.tags.map((tag) => `#${tag}`).join('、')}`);
  }
  second.push(`约 ${meta.wordCount.toLocaleString('zh-Hans-CN')} 字`);
  lines.push(second.join(' · '));
  if (meta.status === 'trashed') {
    lines.push('状态：回收站 · 只读快照');
  }
  return lines;
}

/**
 * 导出落盘/取消后释放临时二进制，避免大画板/附件在报告对象里长期驻留。
 * 只清空可变引用，不影响已生成的字节（渲染器已完成输出）。
 */
export function releaseNoteExportAssets(document: NoteExportDocument): void {
  for (const block of document.blocks) {
    if (block.kind === 'image' && block.asset) {
      block.asset.blob = null;
      block.asset.bytes = null;
    } else if (block.kind === 'board' && block.asset) {
      block.asset.blob = null;
      block.asset.bytes = null;
      block.asset.base64 = null;
    }
  }
}

export function formatNoteExportOutline(facts: NoteExportFacts): string {
  const parts = [
    `${facts.blocks} 个块`,
    facts.tables ? `${facts.tables} 张表` : '',
    facts.code ? `${facts.code} 段代码` : '',
    facts.formulas ? `${facts.formulas} 个公式` : '',
    facts.images ? `${facts.images} 张图片` : '',
    facts.files ? `${facts.files} 个附件` : '',
    facts.internalLinks ? `${facts.internalLinks} 个内链` : '',
    `约 ${facts.words.toLocaleString('zh-Hans-CN')} 字`,
  ].filter(Boolean);
  return parts.join(' · ');
}
