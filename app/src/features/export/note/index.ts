/**
 * 单篇笔记导出入口（ZX-EXPORT-01）。
 *
 * 调用顺序固定：块模型 → 共用文档模型 → 格式渲染 → 统一保存面板。
 * 生成失败时不会调用保存面板；取消保存不会写文件；同名冲突由桌面
 * `save_attachment_file` 自动追加序号，结果里报告实际文件名。
 */

import type { Note } from '../../../data/db/types';
import type { EditorBlock } from '../../../data/repositories/blocks';
import { exportNoteFileName } from '../../../data/repositories/notes';
import type { BoardSource, BoardDocument } from '../../board/types';
import {
  BOARD_EXPORT_MIME,
  renderBoardPng,
} from '../../board/export/image';
import {
  saveBlobWithDialog,
  type SaveResult,
} from '../../attachments/fileActions';
import type { AttachmentManager } from '../../attachments/manager';
import {
  buildNoteExportDocument,
  releaseNoteExportAssets,
  type RenderNoteBoard,
  type RenderedNoteBoard,
} from './document';
import { renderNoteDocx } from './docx';
import { renderNoteMarkdown } from './markdown';
import {
  renderNotePdf,
  type NotePdfCanvasFactory,
  type NotePdfImageLoader,
} from './pdf';
import type {
  NoteExportAsset,
  NoteExportFormat,
  NoteExportOptions,
  NoteExportReport,
  NoteExportSaveResult,
} from './types';

export type CreateNoteExportInput = {
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
  folderName: string;
  noteTitles?: ReadonlyMap<string, string>;
  attachmentManager?: AttachmentManager | null;
  /** 画板文档数据源；启用后 Word/PDF 把画板渲染为图片而不是文字占位。 */
  boardSource?: Pick<BoardSource, 'load'> | null;
  /** 测试注入画板渲染；正式运行使用 `renderBoardPng` + 白底 2x。 */
  renderBoard?: RenderNoteBoard;
  now?: Date;
  /** 测试注入 PDF Canvas/图片解码器；正式运行使用默认实现。 */
  pdfCanvasFactory?: NotePdfCanvasFactory;
  pdfLoadImage?: NotePdfImageLoader;
  pdfMaxPages?: number;
};

function errorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return fallback;
}

function attachmentResolver(
  manager: AttachmentManager | null | undefined,
): Parameters<typeof buildNoteExportDocument>[0]['resolveAttachment'] {
  if (!manager) {
    return undefined;
  }
  return async (attachmentId, fallback) => {
    try {
      const { blob, metadata } = await manager.open(attachmentId);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return {
        blob,
        bytes,
        sha256: metadata.sha256,
        status: 'available' as const,
        error: null,
        fileName: metadata.fileName || fallback.fileName,
        mime: metadata.mime || fallback.mime,
        byteSize: metadata.byteSize || fallback.byteSize,
      };
    } catch (reason) {
      return {
        blob: null,
        bytes: null,
        sha256: null,
        status: 'missing' as const,
        error: errorMessage(reason, '读取本机附件失败'),
        fileName: fallback.fileName,
        mime: fallback.mime,
        byteSize: fallback.byteSize,
      } satisfies Omit<NoteExportAsset, 'attachmentId'>;
    }
  };
}

/**
 * 默认画板渲染：与画板 PNG 导出同一套渲染器，固定白底 / 2x / 48 留白，
 * 不画选择框、控制点、网格和画布边界。返回的 width/height 已除以倍率，
 * 供 Word/PDF 按 1x 逻辑尺寸换算，避免 2x 图被放大成两倍。
 */
export async function defaultNoteBoardRenderer(
  board: BoardDocument,
): Promise<RenderedNoteBoard> {
  const { blob, plan } = await renderBoardPng(board, {
    background: 'white',
    scale: 2,
    padding: 48,
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    blob,
    bytes,
    mime: BOARD_EXPORT_MIME,
    width: Math.max(1, Math.round(plan.pixelWidth / plan.scale)),
    height: Math.max(1, Math.round(plan.pixelHeight / plan.scale)),
    limited: plan.limited,
  };
}

function boardResolver(
  source: Pick<BoardSource, 'load'> | null | undefined,
): Parameters<typeof buildNoteExportDocument>[0]['resolveBoard'] {
  if (!source) {
    return undefined;
  }
  // 不吞异常：`document.ts` 会转成 BOARD_IMAGE_MISSING 占位，并保留
  // “画板不存在 / JSON 解析失败”等具体原因，便于结果面板定位。
  return (boardId) => source.load(boardId);
}

export function formatExtension(format: NoteExportFormat): 'md' | 'docx' | 'pdf' {
  return format === 'md' ? 'md' : format;
}

export function noteExportFormatLabel(format: NoteExportFormat): string {
  if (format === 'docx') return 'Word 文档';
  if (format === 'pdf') return 'PDF';
  return 'Markdown';
}

/**
 * 生成导出报告（不触碰保存面板）。
 *
 * PDF 的 Canvas 工厂/图片解码器仅用于测试注入；正式运行由 `pdf.ts` 使用
 * 浏览器 Canvas 与 `createImageBitmap`。
 */
export async function createNoteExport(
  input: CreateNoteExportInput,
): Promise<NoteExportReport> {
  const document = await buildNoteExportDocument({
    note: input.note,
    blocks: input.blocks,
    options: input.options,
    folderName: input.folderName,
    noteTitles: input.noteTitles,
    resolveAttachment: attachmentResolver(input.attachmentManager),
    resolveBoard: boardResolver(input.boardSource),
    renderBoard: input.renderBoard ?? defaultNoteBoardRenderer,
    now: input.now,
  });

  try {
    let rendered;
    if (input.options.format === 'md') {
      rendered = renderNoteMarkdown(document);
    } else if (input.options.format === 'docx') {
      rendered = await renderNoteDocx(document);
    } else {
      rendered = await renderNotePdf(document, {
        ...(input.pdfCanvasFactory ? { canvasFactory: input.pdfCanvasFactory } : {}),
        ...(input.pdfLoadImage ? { loadImage: input.pdfLoadImage } : {}),
        ...(input.pdfMaxPages ? { maxPages: input.pdfMaxPages } : {}),
        now: input.now,
      });
    }

    return {
      format: input.options.format,
      fileName: exportNoteFileName(
        document.title,
        formatExtension(input.options.format),
      ),
      mime: rendered.mime,
      bytes: rendered.bytes,
      size: rendered.bytes.byteLength,
      warnings: rendered.warnings,
      document,
      generatedAt: (input.now ?? new Date()).toISOString(),
    };
  } finally {
    // 渲染完成或失败后都不再需要画板/附件二进制；最终文件字节不受影响。
    releaseNoteExportAssets(document);
  }
}

function basename(path: string | null): string | null {
  if (!path) return null;
  return path.split(/[\\/]/).pop() ?? null;
}

export type NoteExportSaver = (
  blob: Blob,
  fileName: string,
) => Promise<SaveResult>;

export async function saveNoteExportToFile(
  input: CreateNoteExportInput,
  saver: NoteExportSaver = saveBlobWithDialog,
): Promise<NoteExportSaveResult> {
  const report = await createNoteExport(input);
  try {
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
  } finally {
    // 保存面板关闭或取消后不再需要画板/附件的临时二进制。
    releaseNoteExportAssets(report.document);
  }
}

export { NOTE_EXPORT_SETTING_KEYS, DEFAULT_NOTE_EXPORT_PREFERENCES, loadNoteExportPreferences, saveNoteExportPreferences } from './settings';
export { buildNoteExportDocument, formatNoteExportOutline, noteMetaLines, releaseNoteExportAssets, summarizeNoteBlocks } from './document';
export type { RenderNoteBoard, RenderedNoteBoard, ResolveNoteBoard } from './document';
export { renderNoteMarkdown } from './markdown';
export { renderNoteDocx } from './docx';
export { renderNotePdf, defaultNotePdfCanvasFactory, defaultNotePdfImageLoader } from './pdf';
export { NoteExportError } from './types';
export type {
  NoteExportAsset,
  NoteExportBlock,
  NoteExportBoardAsset,
  NoteExportDocument,
  NoteExportFacts,
  NoteExportFormat,
  NoteExportMeta,
  NoteExportOptions,
  NoteExportPreferences,
  NoteExportReport,
  NoteExportRun,
  NoteExportSaveResult,
  NotePdfPaper,
} from './types';
