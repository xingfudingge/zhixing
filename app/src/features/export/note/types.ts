/**
 * 单篇笔记导出（ZX-EXPORT-01 / 规范 §5）的领域类型。
 *
 * 这里只描述「准备导出的内容」，不依赖 DOM/Canvas：
 * - 文档模型由 `document.ts` 从 `note_blocks` 权威投影生成；
 * - Markdown/Word/PDF 三个渲染器只消费同一个文档模型，保证三种格式
 *   的结构映射一致；
 * - 缺失附件、降级项与格式能力差异统一进入 `warnings`，不静默丢内容。
 */

import type { TableModel } from '../../editor/types';

export type NoteExportFormat = 'docx' | 'pdf' | 'md';
export type NotePdfPaper = 'A4' | 'Letter';
export type NoteExportStatus = 'active' | 'trashed';

export type NoteExportOptions = {
  format: NoteExportFormat;
  includeMetadata: boolean;
  includeImages: boolean;
  pdfPaper: NotePdfPaper;
};

export type NoteExportPreferences = {
  format: NoteExportFormat;
  includeMetadata: boolean;
  includeImages: boolean;
  pdfPaper: NotePdfPaper;
};

export type NoteExportRunLink = {
  href: string;
  /** `zhixing://note/<id>` 站内内链；导出文件在应用外不可跳转。 */
  internal: boolean;
  noteId: string | null;
};

export type NoteExportRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  color?: string;
  background?: string;
  link?: NoteExportRunLink;
};

export type NoteExportMeta = {
  title: string;
  folderName: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  status: NoteExportStatus;
  wordCount: number;
  exportedAt: string;
};

export type NoteExportHeading = {
  level: number;
  text: string;
  blockIndex: number;
};

/** 附件解析结果；`bytes` 是为了 Markdown base64 / Word media 只读一次。 */
export type NoteExportAsset = {
  attachmentId: string;
  fileName: string;
  mime: string;
  byteSize: number;
  sha256: string | null;
  status: 'available' | 'missing' | 'unavailable' | 'error';
  error: string | null;
  blob: Blob | null;
  bytes: Uint8Array | null;
};

/**
 * 画板渲染资源。
 *
 * 画板不是附件表记录，所以不复用 `NoteExportAsset` 的 `attachmentId`：
 * - `bytes` 是 `renderBoardPng` 输出的 PNG，Word 直接写入 media；
 * - `base64` 供调试/包工具读取，避免调用方重复编码；
 * - `width/height` 是 **1x 逻辑尺寸**（2x PNG 已除以倍率），
 *   Word/PDF 按它换算 mm/物理像素，避免 2x 图片被当成 2 倍大小。
 */
export type NoteExportBoardAsset = {
  boardId: string;
  fileName: string;
  mime: string;
  byteSize: number;
  sha256: string | null;
  status: 'available' | 'missing' | 'unavailable' | 'error';
  error: string | null;
  blob: Blob | null;
  bytes: Uint8Array | null;
  base64: string | null;
  width: number;
  height: number;
  /** 大画板被 `planBoardExport` 等比缩小。 */
  limited: boolean;
};

export type NoteExportFile = {
  attachmentId: string | null;
  fileName: string;
  mime: string;
  byteSize: number;
  status: 'local' | 'pending' | 'available' | 'missing';
  asset: NoteExportAsset | null;
};

export type NoteExportBlock =
  | {
      kind: 'paragraph';
      runs: NoteExportRun[];
      align?: 'left' | 'center' | 'right';
    }
  | {
      kind: 'heading';
      level: number;
      runs: NoteExportRun[];
      align?: 'left' | 'center' | 'right';
    }
  | {
      kind: 'todo';
      runs: NoteExportRun[];
      checked: boolean;
      indent: number;
    }
  | {
      kind: 'bullet';
      runs: NoteExportRun[];
      indent: number;
    }
  | {
      kind: 'ordered';
      runs: NoteExportRun[];
      indent: number;
      number: number;
    }
  | {
      kind: 'quote';
      runs: NoteExportRun[];
      source: string;
      noteId: string;
      noteTitle: string;
      sourceUrl: string;
    }
  | {
      kind: 'code';
      code: string;
      language: string;
    }
  | { kind: 'divider' }
  | {
      kind: 'table';
      model: TableModel;
      header: boolean;
    }
  | {
      kind: 'image';
      asset: NoteExportAsset | null;
      alt: string;
      fileName: string;
      mime: string;
      width: number | null;
      height: number | null;
      missingReason: string | null;
    }
  | { kind: 'file'; file: NoteExportFile }
  | {
      kind: 'board';
      boardId: string | null;
      title: string;
      /** `null` 表示空/缺/坏画板，渲染器必须输出可见占位而不是普通文字。 */
      asset: NoteExportBoardAsset | null;
      /** 1x 逻辑尺寸（像素），来自 `plan.pixelWidth / plan.scale`。 */
      width: number | null;
      height: number | null;
      missingReason: string | null;
    }
  | {
      kind: 'formula';
      latex: string;
      display: 'block' | 'inline';
    }
  | {
      kind: 'link';
      title: string;
      url: string;
      internal: boolean;
    }
  | {
      kind: 'unknown';
      blockType: string;
      text: string;
    };

export type NoteExportFacts = {
  blocks: number;
  headings: number;
  tables: number;
  code: number;
  formulas: number;
  images: number;
  files: number;
  boards: number;
  internalLinks: number;
  externalLinks: number;
  coloredRuns: number;
  unknownBlocks: number;
  words: number;
};

export type NoteExportDocument = {
  title: string;
  meta: NoteExportMeta;
  blocks: NoteExportBlock[];
  toc: NoteExportHeading[];
  facts: NoteExportFacts;
  warnings: string[];
  options: NoteExportOptions;
};

export type NoteExportRenderResult = {
  bytes: Uint8Array;
  mime: string;
  warnings: string[];
};

export type NoteExportReport = {
  format: NoteExportFormat;
  fileName: string;
  mime: string;
  bytes: Uint8Array;
  size: number;
  warnings: string[];
  document: NoteExportDocument;
  generatedAt: string;
};

export type NoteExportSaveResult =
  | {
      status: 'saved';
      report: NoteExportReport;
      /** 桌面返回完整路径；浏览器返回 null（面板不暴露路径）。 */
      path: string | null;
      target: 'desktop' | 'browser';
      /** 实际落盘文件名；同名冲突时可能带 `-1`。 */
      actualFileName: string;
      renamed: boolean;
    }
  | { status: 'canceled' };

export class NoteExportError extends Error {
  readonly code: 'GENERATE_FAILED' | 'PDF_UNAVAILABLE' | 'PDF_TOO_LONG';

  constructor(
    code: NoteExportError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'NoteExportError';
    this.code = code;
  }
}
