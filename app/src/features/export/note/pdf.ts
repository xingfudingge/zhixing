/**
 * 单篇笔记 → A4/Letter 图片型 PDF（规范 §5.6）。
 *
 * 复用 `export/pdf.ts` 的 JPEG 页面嵌入器（`buildPdfFromJpegs`），但不复用
 * 整库备份的固定报告排版。这里逐块绘制：
 * - 标题/元信息/目录/正文/页眉/页脚；
 * - 列表、待办、引用、代码、表格（含合并）、图片、文件卡、画板、公式、链接；
 * - 中文由系统字体渲染，所以文字是图像，**不可选中/检索**，报告如实标注。
 *
 * Canvas 工厂与图片解码器可注入，便于 jsdom/单测验证分页、占位与页脚。
 */

import { formatDateTime, formatBytes } from '../utils';
import { buildPdfFromJpegs, type PdfContext } from '../pdf';
import { tableAnchorAt, type TableModel } from '../../editor/types';
import { noteMetaLines } from './document';
import type {
  NoteExportBlock,
  NoteExportBoardAsset,
  NoteExportDocument,
  NoteExportRenderResult,
  NoteExportRun,
} from './types';
import { NoteExportError } from './types';

export type NotePdfContext = PdfContext & {
  drawImage(
    image: unknown,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
};

export type NotePdfCanvas = {
  width: number;
  height: number;
  getContext(type: '2d'): NotePdfContext | null;
  toBlob(
    callback: (blob: Blob | null) => void,
    type?: string,
    quality?: number,
  ): void;
};

export type NotePdfCanvasFactory = (
  width: number,
  height: number,
) => NotePdfCanvas;

export type NotePdfImageLoader = (blob: Blob) => Promise<unknown | null>;

export type NotePdfRenderOptions = {
  canvasFactory?: NotePdfCanvasFactory;
  loadImage?: NotePdfImageLoader;
  now?: Date;
  maxPages?: number;
};

type PaperSize = 'A4' | 'Letter';

const SCALE = 2;
const PX_PER_MM = (96 / 25.4) * SCALE;
const MARGIN = Math.round(18 * PX_PER_MM);
const HEADER_Y = 54;
const HEADER_LINE_Y = 96;
const FIRST_CONTENT_TOP = 166;
const NEXT_CONTENT_TOP = 128;
const FOOTER_HEIGHT = 42;
const MAX_PAGES = 300;
/** 单张图/画板的最大显示高度（22 cm），超过则等比缩小而不是裁切。 */
const MAX_BOARD_IMAGE_HEIGHT = Math.round((220 / 25.4) * 96 * SCALE);

const INK = '#252C38';
const MUTED = '#7F8999';
const LINE = '#E7E9EF';
const SOFT = '#F4F6FA';
const ACCENT = '#5579D5';
const FONT_SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const FONT_MONO = '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

function paperPixels(paper: PaperSize): { width: number; height: number } {
  const [mmWidth, mmHeight] = paper === 'Letter' ? [215.9, 279.4] : [210, 297];
  return {
    width: Math.round(mmWidth * PX_PER_MM),
    height: Math.round(mmHeight * PX_PER_MM),
  };
}

export function defaultNotePdfCanvasFactory(): NotePdfCanvasFactory {
  if (typeof document === 'undefined') {
    throw new NoteExportError('PDF_UNAVAILABLE', '当前环境没有 Canvas，无法生成 PDF');
  }
  return (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as NotePdfCanvas;
  };
}

export async function defaultNotePdfImageLoader(
  blob: Blob,
): Promise<unknown | null> {
  const createImageBitmapFn = (
    globalThis as typeof globalThis & {
      createImageBitmap?: (source: Blob) => Promise<unknown>;
    }
  ).createImageBitmap;
  if (typeof createImageBitmapFn === 'function') {
    try {
      return await createImageBitmapFn(blob);
    } catch {
      // 继续尝试 <img> 解码；某些 WebView 不支持该 Blob 格式。
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined') {
    return null;
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    if (typeof image.decode === 'function') {
      await image.decode();
      return image;
    }
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('图片解码失败'));
    });
    return image;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

type Page = {
  canvas: NotePdfCanvas;
  ctx: NotePdfContext;
};

type RenderState = {
  pages: Page[];
  page: Page;
  y: number;
  width: number;
  height: number;
  contentWidth: number;
  bottom: number;
  title: string;
  exportedAt: string;
  maxPages: number;
  factory: NotePdfCanvasFactory;
  loadImage: NotePdfImageLoader;
  imageWarnings: string[];
  /** 同一画板帧只解码一次；多个画板块复用时直接复用解码结果。 */
  boardImages: Map<NoteExportBoardAsset, Promise<unknown | null>>;
  currentOrderedGroup: number | null;
};

function setFont(
  ctx: NotePdfContext,
  size: number,
  weight = '400',
  italic = false,
  mono = false,
): string {
  const font = `${italic ? 'italic ' : ''}${weight} ${size}px ${
    mono ? FONT_MONO : FONT_SANS
  }`;
  ctx.font = font;
  return font;
}

function fillRect(
  ctx: NotePdfContext,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);
}

function drawLine(
  ctx: NotePdfContext,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width = 1,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function truncateToWidth(
  ctx: NotePdfContext,
  text: string,
  maxWidth: number,
  font: string,
): string {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let output = text;
  while (output.length > 1 && ctx.measureText(`${output}…`).width > maxWidth) {
    output = output.slice(0, -1);
  }
  return `${output}…`;
}

function createPage(state: RenderState, first: boolean): Page {
  if (state.pages.length >= state.maxPages) {
    throw new NoteExportError(
      'PDF_TOO_LONG',
      `PDF 超过 ${state.maxPages} 页上限，请缩小图片或分段导出。`,
    );
  }
  const canvas = state.factory(state.width, state.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new NoteExportError('PDF_UNAVAILABLE', 'Canvas 2D 上下文不可用，无法生成 PDF');
  }
  fillRect(ctx, 0, 0, state.width, state.height, '#FFFFFF');
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const headerFont = setFont(ctx, 17, '400', false, false);
  ctx.fillStyle = MUTED;
  ctx.fillText(
    truncateToWidth(ctx, state.title, state.contentWidth, headerFont),
    MARGIN,
    HEADER_Y,
  );
  drawLine(
    ctx,
    MARGIN,
    HEADER_LINE_Y,
    state.width - MARGIN,
    HEADER_LINE_Y,
    LINE,
    1,
  );
  const page = { canvas, ctx };
  state.pages.push(page);
  state.page = page;
  state.y = first ? FIRST_CONTENT_TOP : NEXT_CONTENT_TOP;
  return page;
}

/**
 * 确保当前页还能放下 `height`，返回**绘制时必须使用**的页面。
 *
 * 返回值就是调用方唯一可信的页面：放不下时这里会新建一页，调用方若继续
 * 使用换页前缓存的 `ctx`，后续内容会被画到旧页并裁掉。
 */
function ensureSpace(state: RenderState, height: number): Page {
  if (state.y + height <= state.bottom) {
    return state.page;
  }
  return createPage(state, false);
}

function drawFooter(state: RenderState): void {
  const total = state.pages.length;
  state.pages.forEach((page, index) => {
    const ctx = page.ctx;
    setFont(ctx, 17, '400', false, false);
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'left';
    ctx.fillText(
      `第 ${index + 1} / ${total} 页 · 导出于 ${formatDateTime(state.exportedAt)}`,
      MARGIN,
      state.height - FOOTER_HEIGHT,
    );
    ctx.textAlign = 'right';
    ctx.fillText('知行', state.width - MARGIN, state.height - FOOTER_HEIGHT);
    ctx.textAlign = 'left';
  });
}

type TextStyle = {
  size: number;
  lineHeight: number;
  color: string;
  font: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  background: string | null;
};

type TextToken = {
  text: string;
  style: TextStyle;
  width?: number;
};

function runStyle(run: NoteExportRun, base: TextStyle): TextStyle {
  const internal = run.link?.internal === true;
  return {
    size: base.size,
    lineHeight: base.lineHeight,
    color:
      run.link && !internal
        ? ACCENT
        : run.color ?? base.color,
    font: run.code ? FONT_MONO : base.font,
    bold: base.bold || run.bold === true,
    italic: base.italic || run.italic === true,
    underline: base.underline || run.underline === true || (run.link ? !internal : false),
    strike: base.strike || run.strike === true,
    background: run.background ?? base.background,
  };
}

function tokenizeRuns(
  runs: ReadonlyArray<NoteExportRun>,
  base: TextStyle,
): Array<TextToken | { newline: true }> {
  const output: Array<TextToken | { newline: true }> = [];
  for (const run of runs) {
    const style = runStyle(run, base);
    const text = run.link?.internal
      ? run.text.startsWith('《')
        ? run.text
        : `《${run.text}》`
      : run.text;
    const parts = text.split(/\r\n|\r|\n/);
    parts.forEach((part, index) => {
      if (index > 0) {
        output.push({ newline: true });
      }
      const pieces = part.match(/\s+|[A-Za-z0-9]+|./gu) ?? [];
      for (const piece of pieces) {
        output.push({ text: piece, style });
      }
    });
  }
  return output;
}

function fontFor(style: TextStyle): string {
  return `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} ${
    style.size
  }px ${style.font}`;
}

function measureToken(ctx: NotePdfContext, token: TextToken): number {
  ctx.font = fontFor(token.style);
  return ctx.measureText(token.text).width;
}

/**
 * 绘制一段富文本；按 token 换行，支持页内自动分页。
 * `leftBar` 用于引用块左侧竖线；`indent` 是相对正文左边距的缩进。
 */
function drawRichText(
  state: RenderState,
  runs: ReadonlyArray<NoteExportRun>,
  options: {
    size?: number;
    lineHeight?: number;
    color?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    background?: string | null;
    indent?: number;
    align?: 'left' | 'center' | 'right';
    leftBar?: boolean;
    mono?: boolean;
    maxWidth?: number;
  } = {},
): void {
  const base: TextStyle = {
    size: options.size ?? 28,
    lineHeight: options.lineHeight ?? 48,
    color: options.color ?? INK,
    font: options.mono ? FONT_MONO : FONT_SANS,
    bold: options.bold ?? false,
    italic: options.italic ?? false,
    underline: options.underline ?? false,
    strike: options.strike ?? false,
    background: options.background ?? null,
  };
  const indent = options.indent ?? 0;
  const maxWidth = options.maxWidth ?? state.contentWidth - indent;
  const tokens = tokenizeRuns(runs, base);
  const line: TextToken[] = [];
  let lineWidth = 0;

  const flush = (): void => {
    if (line.length === 0) {
      return;
    }
    // 必须在 ensureSpace 之后取 ctx：换页后旧页 ctx 会把这一行画到上一页。
    const ctx = ensureSpace(state, base.lineHeight).ctx;
    const totalWidth = line.reduce((sum, token) => sum + (token.width ?? 0), 0);
    let x = MARGIN + indent;
    if (options.align === 'center') {
      x = MARGIN + indent + Math.max(0, (maxWidth - totalWidth) / 2);
    } else if (options.align === 'right') {
      x = MARGIN + indent + Math.max(0, maxWidth - totalWidth);
    }
    const y = state.y;
    if (options.leftBar) {
      fillRect(ctx, MARGIN + indent - 18, y, 5, base.lineHeight, '#D8DDE7');
    }
    for (const token of line) {
      const style = token.style;
      const tokenWidth = token.width ?? 0;
      if (style.background) {
        fillRect(ctx, x, y + 2, tokenWidth, base.lineHeight - 4, style.background);
      }
      ctx.font = fontFor(style);
      ctx.fillStyle = style.color;
      ctx.fillText(token.text, x, y);
      if (style.underline) {
        fillRect(
          ctx,
          x,
          y + style.size * 1.03,
          tokenWidth,
          Math.max(1, style.size / 16),
          style.color,
        );
      }
      if (style.strike) {
        fillRect(
          ctx,
          x + 1,
          y + style.size * 0.56,
          Math.max(0, tokenWidth - 2),
          Math.max(1, style.size / 18),
          style.color,
        );
      }
      x += tokenWidth;
    }
    state.y += base.lineHeight;
    line.length = 0;
    lineWidth = 0;
  };

  for (const token of tokens) {
    if ('newline' in token) {
      flush();
      state.y += base.lineHeight * 0.35;
      continue;
    }
    const width = measureToken(state.page.ctx, token);
    if (lineWidth > 0 && lineWidth + width > maxWidth) {
      flush();
      if (token.text.trim() === '') {
        continue;
      }
    }
    if (width > maxWidth && maxWidth > 0) {
      // 超长单词/URL 按字符拆开，避免整行溢出页面。
      for (const character of token.text) {
        const part: TextToken = { ...token, text: character };
        const partWidth = measureToken(state.page.ctx, part);
        if (lineWidth > 0 && lineWidth + partWidth > maxWidth) {
          flush();
        }
        part.width = partWidth;
        line.push(part);
        lineWidth += partWidth;
      }
      continue;
    }
    token.width = width;
    line.push(token);
    lineWidth += width;
  }
  flush();
}

function drawSpacer(state: RenderState, height: number): void {
  ensureSpace(state, height);
  state.y += height;
}

function drawHeading(
  state: RenderState,
  block: Extract<NoteExportBlock, { kind: 'heading' }>,
): void {
  const sizes = [58, 48, 41, 36, 32];
  const size = sizes[Math.max(0, Math.min(4, block.level - 1))] ?? 32;
  const lineHeight = Math.round(size * 1.32);
  ensureSpace(state, lineHeight + 34);
  state.y += block.level === 1 ? 12 : 6;
  drawRichText(state, block.runs, {
    size,
    lineHeight,
    color: INK,
    bold: true,
    align: block.align,
  });
  state.y += block.level === 1 ? 14 : 8;
}

function drawQuote(
  state: RenderState,
  block: Extract<NoteExportBlock, { kind: 'quote' }>,
): void {
  drawRichText(state, block.runs, {
    color: '#59636F',
    indent: 28,
    leftBar: true,
  });
  const source = [
    block.source,
    block.noteTitle ? `关联笔记《${block.noteTitle}》` : '',
    block.sourceUrl,
  ]
    .filter(Boolean)
    .join(' · ');
  if (source) {
    drawRichText(state, [{ text: source }], {
      size: 20,
      lineHeight: 32,
      color: MUTED,
      indent: 28,
      align: 'right',
    });
  }
  state.y += 8;
}

function wrapPlainLines(
  ctx: NotePdfContext,
  text: string,
  maxWidth: number,
  font: string,
): string[] {
  ctx.font = font;
  const output: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (raw === '') {
      output.push('');
      continue;
    }
    let current = '';
    for (const character of raw) {
      const next = current + character;
      if (current && ctx.measureText(next).width > maxWidth) {
        output.push(current);
        current = character;
      } else {
        current = next;
      }
    }
    output.push(current);
  }
  return output.length > 0 ? output : [''];
}

function drawCode(
  state: RenderState,
  block: Extract<NoteExportBlock, { kind: 'code' }>,
): void {
  if (block.language) {
    drawRichText(state, [{ text: `代码 · ${block.language}` }], {
      size: 19,
      lineHeight: 30,
      color: MUTED,
    });
  }
  const size = 24;
  const lineHeight = 36;
  const ctx = state.page.ctx;
  const font = fontFor({
    size,
    lineHeight,
    color: INK,
    font: FONT_MONO,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    background: null,
  });
  const lines: string[] = [];
  for (const raw of block.code.split(/\r\n|\r|\n/)) {
    const wrapped = wrapPlainLines(
      ctx,
      raw,
      state.contentWidth - 34,
      font,
    );
    lines.push(...wrapped);
  }
  if (lines.length === 0) {
    lines.push('');
  }
  for (const line of lines) {
    const page = ensureSpace(state, lineHeight);
    fillRect(page.ctx, MARGIN, state.y - 2, state.contentWidth, lineHeight, SOFT);
    page.ctx.font = font;
    page.ctx.fillStyle = INK;
    page.ctx.fillText(line, MARGIN + 16, state.y);
    state.y += lineHeight;
  }
  state.y += 10;
}

function columnWidths(model: TableModel, total: number): number[] {
  const columns = Math.max(1, model.rows[0]?.length ?? model.widths.length);
  const values = Array.from({ length: columns }, (_, index) => {
    const width = model.widths[index];
    return typeof width === 'number' && Number.isFinite(width) && width > 0
      ? width
      : 140;
  });
  const sum = values.reduce((totalValue, value) => totalValue + value, 0);
  return values.map((value) => Math.max(46, (total * value) / sum));
}

type TableLayout = {
  rowHeights: number[];
  cellTexts: Map<string, string[]>;
};

function layoutTable(
  state: RenderState,
  model: TableModel,
  widths: number[],
): TableLayout {
  const rowHeights = model.rows.map(() => 44);
  const cellTexts = new Map<string, string[]>();
  const font = fontFor({
    size: 22,
    lineHeight: 32,
    color: INK,
    font: FONT_SANS,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    background: null,
  });
  for (let row = 0; row < model.rows.length; row += 1) {
    for (let column = 0; column < widths.length; column += 1) {
      const cell = model.rows[row]?.[column];
      if (!cell || cell.covered) {
        continue;
      }
      const width = widths
        .slice(column, column + cell.colSpan)
        .reduce((sum, value) => sum + value, 0);
      const lines = wrapPlainLines(
        state.page.ctx,
        cell.text || '',
        Math.max(30, width - 18),
        font,
      );
      cellTexts.set(`${row}:${column}`, lines);
      const needed = Math.max(1, lines.length) * 32 + 20;
      if (cell.rowSpan === 1) {
        rowHeights[row] = Math.max(rowHeights[row] ?? 44, needed);
      } else {
        const current = rowHeights
          .slice(row, row + cell.rowSpan)
          .reduce((sum, value) => sum + value, 0);
        if (current < needed) {
          rowHeights[row + cell.rowSpan - 1] =
            (rowHeights[row + cell.rowSpan - 1] ?? 44) +
            (needed - current);
        }
      }
    }
  }
  return { rowHeights, cellTexts };
}

function drawTableRow(
  state: RenderState,
  model: TableModel,
  widths: number[],
  layout: TableLayout,
  rowIndex: number,
  y: number,
  headerRow: boolean,
): void {
  const ctx = state.page.ctx;
  const rowHeight = layout.rowHeights[rowIndex] ?? 44;
  let x = MARGIN;
  for (let column = 0; column < widths.length; column += 1) {
    const cell = model.rows[rowIndex]?.[column];
    const width = widths[column] ?? 40;
    if (!cell) {
      x += width;
      continue;
    }
    if (cell.covered) {
      const anchor = tableAnchorAt(model, rowIndex, column);
      if (!anchor || anchor.row === rowIndex || column !== anchor.column) {
        x += width;
        continue;
      }
      const spanHeight = layout.rowHeights
        .slice(anchor.row, anchor.row + anchor.cell.rowSpan)
        .reduce((sum, value) => sum + value, 0);
      // 垂直合并的续行：只补边框，内容由锚点绘制。
      fillRect(ctx, x, y, width, rowHeight, '#FFFFFF');
      drawLine(ctx, x, y, x, y + rowHeight, LINE, 1);
      x += width;
      void spanHeight;
      continue;
    }
    const spanWidth = widths
      .slice(column, column + cell.colSpan)
      .reduce((sum, value) => sum + value, 0);
    const spanHeight = layout.rowHeights
      .slice(rowIndex, rowIndex + cell.rowSpan)
      .reduce((sum, value) => sum + value, 0);
    if (headerRow) {
      fillRect(ctx, x, y, spanWidth, spanHeight, '#F1F4F8');
    }
    const lines = layout.cellTexts.get(`${rowIndex}:${column}`) ?? [''];
    const fontSize = 22;
    ctx.font = fontFor({
      size: fontSize,
      lineHeight: 32,
      color: INK,
      font: FONT_SANS,
      bold: headerRow,
      italic: false,
      underline: false,
      strike: false,
      background: null,
    });
    ctx.fillStyle = INK;
    let textY = y + 10;
    for (const line of lines) {
      let textX = x + 9;
      if (cell.align === 'center') {
        textX = x + Math.max(9, (spanWidth - ctx.measureText(line).width) / 2);
      } else if (cell.align === 'right') {
        textX = x + Math.max(9, spanWidth - ctx.measureText(line).width - 9);
      }
      ctx.fillText(line, textX, textY);
      textY += 32;
    }
    drawLine(ctx, x, y, x + spanWidth, y, LINE, 1);
    drawLine(ctx, x, y + spanHeight, x + spanWidth, y + spanHeight, LINE, 1);
    drawLine(ctx, x, y, x, y + spanHeight, LINE, 1);
    drawLine(ctx, x + spanWidth, y, x + spanWidth, y + spanHeight, LINE, 1);
    x += spanWidth;
    column += cell.colSpan - 1;
  }
}

/**
 * 返回从 `rowIndex` 开始、必须与它同页的连续行区间终点（含）。
 *
 * 跨行合并单元格的锚点文字会画到整个 `rowSpan` 高度里；如果行区间被页边界
 * 切开，锚点文字就会越过页底被裁掉。这里把整段合并行视为不可拆分单元。
 */
function rowGroupEnd(model: TableModel, rowIndex: number): number {
  let end = rowIndex;
  for (let row = 0; row <= end; row += 1) {
    for (const cell of model.rows[row] ?? []) {
      if (!cell || cell.covered || cell.rowSpan <= 1) {
        continue;
      }
      if (row + cell.rowSpan - 1 >= rowIndex) {
        end = Math.max(end, row + cell.rowSpan - 1);
      }
    }
  }
  return end;
}

function drawTable(state: RenderState, block: Extract<NoteExportBlock, { kind: 'table' }>): void {
  const model = block.model;
  if (model.rows.length === 0) {
    drawRichText(state, [{ text: '（空表格）' }], { color: MUTED });
    return;
  }
  const widths = columnWidths(model, state.contentWidth);
  const layout = layoutTable(state, model, widths);
  const headerHeight = block.header ? layout.rowHeights[0] ?? 44 : 0;
  // 续页会重复表头，所以单行可用的最大高度要扣掉表头。
  const pageCapacity = state.bottom - NEXT_CONTENT_TOP - headerHeight;
  if (headerHeight > state.bottom - NEXT_CONTENT_TOP) {
    throw new NoteExportError(
      'GENERATE_FAILED',
      'PDF 生成失败：表格表头过高，单页放不下；请缩短表头后重试。',
    );
  }
  // 表格整体能放下时一次画完；否则按行分页并重复表头。
  const bodyStart = block.header ? 1 : 0;
  if (bodyStart >= model.rows.length) {
    // 只有表头、没有数据行的表格也要输出，不能静默消失。
    ensureSpace(state, headerHeight);
    drawTableRow(state, model, widths, layout, 0, state.y, true);
    state.y += headerHeight + 10;
    return;
  }
  let row = bodyStart;
  while (row < model.rows.length) {
    const pageRows: number[] = [];
    let pageHeight = block.header ? headerHeight : 0;
    let cursor = row;
    while (cursor < model.rows.length) {
      const groupEnd = rowGroupEnd(model, cursor);
      let groupHeight = 0;
      for (let index = cursor; index <= groupEnd; index += 1) {
        groupHeight += layout.rowHeights[index] ?? 44;
      }
      if (groupHeight > pageCapacity) {
        // 整段（含跨行合并）高过一整页的可排区域：拆行会破坏合并单元格
        // 语义，明确报错而不是把单元格文字裁掉。
        const range =
          groupEnd > cursor
            ? `第 ${cursor + 1}–${groupEnd + 1} 行`
            : `第 ${cursor + 1} 行`;
        throw new NoteExportError(
          'GENERATE_FAILED',
          `PDF 生成失败：表格${range}过高，单页放不下；请拆分单元格内容后重试。`,
        );
      }
      if (
        pageRows.length > 0 &&
        state.y + pageHeight + groupHeight > state.bottom
      ) {
        break;
      }
      for (let index = cursor; index <= groupEnd; index += 1) {
        pageRows.push(index);
        pageHeight += layout.rowHeights[index] ?? 44;
      }
      cursor = groupEnd + 1;
    }
    if (pageRows.length === 0) {
      pageRows.push(cursor);
      pageHeight += layout.rowHeights[cursor] ?? 44;
      cursor += 1;
    }
    if (state.y + pageHeight > state.bottom) {
      createPage(state, false);
    }
    let y = state.y;
    if (block.header) {
      drawTableRow(state, model, widths, layout, 0, y, true);
      y += layout.rowHeights[0] ?? 44;
    }
    for (const rowIndex of pageRows) {
      drawTableRow(state, model, widths, layout, rowIndex, y, false);
      y += layout.rowHeights[rowIndex] ?? 44;
    }
    state.y = y;
    row = cursor;
    if (row < model.rows.length) {
      createPage(state, false);
    }
  }
  state.y += 10;
}

function imagePixels(
  bytes: Uint8Array,
  mime: string,
): { width: number; height: number } {
  if (
    bytes.length > 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return {
      width: bytes[6]! | (bytes[7]! << 8),
      height: bytes[8]! | (bytes[9]! << 8),
    };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7)
      ) {
        return {
          width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
          height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (/webp/i.test(mime) && bytes.length > 30) {
    return {
      width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
      height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
    };
  }
  return { width: 600, height: 400 };
}

function drawPlaceholder(
  state: RenderState,
  label: string,
  height = 96,
): void {
  const page = ensureSpace(state, height + 14);
  fillRect(page.ctx, MARGIN, state.y, state.contentWidth, height, SOFT);
  drawLine(page.ctx, MARGIN, state.y, MARGIN + state.contentWidth, state.y, LINE, 1);
  drawLine(
    page.ctx,
    MARGIN,
    state.y + height,
    MARGIN + state.contentWidth,
    state.y + height,
    LINE,
    1,
  );
  drawRichText(state, [{ text: label }], {
    size: 21,
    lineHeight: 34,
    color: MUTED,
    indent: 18,
  });
  state.y += Math.max(0, height - 34) + 8;
}

async function drawImageBlock(
  state: RenderState,
  block: Extract<NoteExportBlock, { kind: 'image' }>,
): Promise<void> {
  const asset = block.asset;
  if (
    !asset ||
    asset.status !== 'available' ||
    !asset.bytes ||
    !asset.blob ||
    asset.bytes.byteLength === 0
  ) {
    drawPlaceholder(
      state,
      `［图片缺失：${block.fileName || asset?.fileName || '未命名图片'}］${
        block.missingReason ? `（${block.missingReason}）` : ''
      }`,
    );
    return;
  }
  const image = await state.loadImage(asset.blob);
  if (!image) {
    state.imageWarnings.push(
      `图片「${asset.fileName}」无法在当前环境解码，PDF 中已写入占位框。`,
    );
    drawPlaceholder(state, `［图片无法解码：${asset.fileName}］`);
    return;
  }
  const pixels = imagePixels(asset.bytes, asset.mime);
  let width = Math.min(
    state.contentWidth,
    block.width && block.width > 0 ? block.width * 2 : pixels.width * 2,
  );
  let height = (width * pixels.height) / Math.max(1, pixels.width);
  const maxHeight = Math.round((22 / 25.4) * 96 * SCALE);
  if (height > maxHeight) {
    width = (width * maxHeight) / height;
    height = maxHeight;
  }
  const captionHeight = 38;
  const page = ensureSpace(state, height + captionHeight + 12);
  const x = MARGIN + (state.contentWidth - width) / 2;
  page.ctx.drawImage(image, x, state.y, width, height);
  state.y += height + 4;
  drawRichText(
    state,
    [{ text: `${asset.fileName} · ${formatBytes(asset.byteSize)}` }],
    {
      size: 19,
      lineHeight: 30,
      color: MUTED,
      align: 'center',
    },
  );
  state.y += 8;
}

function drawFileCard(
  state: RenderState,
  block: Extract<NoteExportBlock, { kind: 'file' }>,
): void {
  const file = block.file;
  const label = `📎 ${file.fileName || '未命名文件'}（${formatBytes(
    file.byteSize,
  )}）${file.status === 'missing' ? ' · 文件缺失' : ''}`;
  const lines = wrapPlainLines(
    state.page.ctx,
    label,
    state.contentWidth - 24,
    fontFor({
      size: 21,
      lineHeight: 32,
      color: INK,
      font: FONT_SANS,
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      background: null,
    }),
  );
  const height = Math.max(58, lines.length * 32 + 20);
  const page = ensureSpace(state, height + 10);
  fillRect(page.ctx, MARGIN, state.y, state.contentWidth, height, SOFT);
  drawLine(page.ctx, MARGIN, state.y, MARGIN + state.contentWidth, state.y, LINE, 1);
  drawLine(
    page.ctx,
    MARGIN,
    state.y + height,
    MARGIN + state.contentWidth,
    state.y + height,
    LINE,
    1,
  );
  let y = state.y + 10;
  page.ctx.font = fontFor({
    size: 21,
    lineHeight: 32,
    color: INK,
    font: FONT_SANS,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    background: null,
  });
  for (const line of lines) {
    page.ctx.fillStyle = INK;
    page.ctx.fillText(line, MARGIN + 12, y);
    y += 32;
  }
  state.y += height + 8;
}

function drawFormula(
  state: RenderState,
  block: Extract<NoteExportBlock, { kind: 'formula' }>,
): void {
  if (!block.latex.trim()) {
    drawRichText(state, [{ text: '（空公式）' }], { color: MUTED });
    return;
  }
  if (block.display === 'inline') {
    drawRichText(
      state,
      [{ text: '$' }, { text: block.latex, code: true }, { text: '$' }],
    );
    return;
  }
  drawRichText(state, [{ text: '公式（LaTeX 源）' }], {
    size: 19,
    lineHeight: 30,
    color: MUTED,
  });
  drawCode(
    state,
    { kind: 'code', code: block.latex, language: 'latex' },
  );
}

function drawLink(
  state: RenderState,
  block: Extract<NoteExportBlock, { kind: 'link' }>,
): void {
  if (block.internal) {
    const label = block.title || block.url || '站内笔记';
    drawRichText(state, [
      {
        text: label.startsWith('《') ? label : `《${label}》`,
        link: { href: block.url, internal: true, noteId: null },
      },
      { text: '（站内链接）', color: MUTED },
    ]);
    return;
  }
  drawRichText(state, [
    {
      text: block.title || block.url || '链接',
      link: { href: block.url, internal: false, noteId: null },
    },
  ]);
  if (block.url && block.title && block.title !== block.url) {
    drawRichText(state, [{ text: block.url }], {
      size: 19,
      lineHeight: 30,
      color: MUTED,
      indent: 16,
    });
  }
  state.y += 4;
}

function boardImage(
  state: RenderState,
  asset: NoteExportBoardAsset,
): Promise<unknown | null> {
  const cached = state.boardImages.get(asset);
  if (cached) {
    return cached;
  }
  const pending = (async () => {
    if (!asset.blob) {
      return null;
    }
    try {
      return await state.loadImage(asset.blob);
    } catch {
      return null;
    }
  })();
  state.boardImages.set(asset, pending);
  return pending;
}

/**
 * 画板块：有 PNG 资源时按正文宽度等比 drawImage；空/缺/坏时画可见占位条。
 * 先 ensureSpace 再取返回页的 ctx，避免换页后画到旧页被裁掉。
 */
async function drawBoardImage(
  state: RenderState,
  block: Extract<NoteExportBlock, { kind: 'board' }>,
): Promise<void> {
  const asset = block.asset;
  const title = block.title || '未命名画板';
  if (
    !asset ||
    asset.status !== 'available' ||
    !asset.bytes ||
    asset.bytes.byteLength === 0
  ) {
    drawPlaceholder(
      state,
      `🖼 画板：${title}（${block.missingReason || '数据缺失'}）`,
      86,
    );
    return;
  }

  const image = await boardImage(state, asset);
  if (!image) {
    state.imageWarnings.push(
      `画板「${title}」无法在当前环境解码，PDF 中已写入占位框。`,
    );
    drawPlaceholder(state, `🖼 画板：${title}（渲染失败）`, 86);
    return;
  }

  const naturalWidth = Math.max(
    1,
    (block.width ?? asset.width) * SCALE,
  );
  const naturalHeight = Math.max(
    1,
    (block.height ?? asset.height) * SCALE,
  );
  let width = Math.min(state.contentWidth, naturalWidth);
  let height = (width * naturalHeight) / naturalWidth;
  if (height > MAX_BOARD_IMAGE_HEIGHT) {
    width = (width * MAX_BOARD_IMAGE_HEIGHT) / height;
    height = MAX_BOARD_IMAGE_HEIGHT;
  }

  const captionHeight = 38;
  const page = ensureSpace(state, height + captionHeight + 12);
  const x = MARGIN + (state.contentWidth - width) / 2;
  page.ctx.drawImage(image, x, state.y, width, height);
  state.y += height + 4;
  drawRichText(
    state,
    [
      {
        text: `画板：${title}${asset.limited ? ' · 已等比缩小' : ''}`,
      },
    ],
    {
      size: 19,
      lineHeight: 30,
      color: MUTED,
      align: 'center',
    },
  );
  state.y += 8;
}

async function drawBlock(
  state: RenderState,
  block: NoteExportBlock,
): Promise<void> {
  switch (block.kind) {
    case 'paragraph':
      if (block.runs.length === 0) {
        drawSpacer(state, 28);
      } else {
        drawRichText(state, block.runs, {
          align: block.align,
        });
        state.y += 6;
      }
      return;
    case 'heading':
      drawHeading(state, block);
      return;
    case 'todo': {
      const prefix = block.checked ? '☑ ' : '☐ ';
      drawRichText(
        state,
        [{ text: prefix, color: block.checked ? ACCENT : MUTED }, ...block.runs],
        { indent: block.indent * 24 },
      );
      state.y += 4;
      return;
    }
    case 'bullet':
      drawRichText(state, [{ text: '• ' }, ...block.runs], {
        indent: block.indent * 24,
      });
      state.y += 4;
      return;
    case 'ordered':
      drawRichText(state, [{ text: `${block.number}. ` }, ...block.runs], {
        indent: block.indent * 24,
      });
      state.y += 4;
      return;
    case 'quote':
      drawQuote(state, block);
      return;
    case 'code':
      drawCode(state, block);
      return;
    case 'divider': {
      const page = ensureSpace(state, 24);
      drawLine(
        page.ctx,
        MARGIN,
        state.y + 10,
        MARGIN + state.contentWidth,
        state.y + 10,
        LINE,
        1,
      );
      state.y += 26;
      return;
    }
    case 'table':
      drawTable(state, block);
      return;
    case 'image':
      await drawImageBlock(state, block);
      return;
    case 'file':
      drawFileCard(state, block);
      return;
    case 'board':
      await drawBoardImage(state, block);
      return;
    case 'formula':
      drawFormula(state, block);
      return;
    case 'link':
      drawLink(state, block);
      return;
    case 'unknown':
      drawRichText(
        state,
        [
          {
            text: block.text
              ? `［无法导出的块：${block.blockType}］ ${block.text}`
              : `［无法导出的块：${block.blockType}］`,
          },
        ],
        { color: MUTED },
      );
      state.y += 6;
      return;
  }
}

function drawMetadata(state: RenderState, document: NoteExportDocument): void {
  for (const line of noteMetaLines(document.meta)) {
    drawRichText(state, [{ text: line }], {
      size: 20,
      lineHeight: 32,
      color: MUTED,
    });
  }
  state.y += 4;
}

function drawToc(state: RenderState, document: NoteExportDocument): void {
  if (document.toc.length === 0) {
    return;
  }
  drawRichText(state, [{ text: '目录' }], {
    size: 30,
    lineHeight: 42,
    color: INK,
    bold: true,
  });
  state.y += 2;
  for (const heading of document.toc) {
    drawRichText(
      state,
      [{ text: `• ${heading.text}` }],
      {
        size: 21,
        lineHeight: 34,
        color: '#59636F',
        indent: (heading.level - 1) * 22,
      },
    );
  }
  state.y += 12;
}

async function canvasToJpeg(canvas: NotePdfCanvas): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(
              new NoteExportError('PDF_UNAVAILABLE', 'Canvas 无法编码为 JPEG'),
            );
            return;
          }
          void blob
            .arrayBuffer()
            .then((buffer) => resolve(new Uint8Array(buffer)))
            .catch(reject);
        },
        'image/jpeg',
        0.92,
      );
    } catch (reason) {
      reject(
        reason instanceof Error
          ? reason
          : new NoteExportError('PDF_UNAVAILABLE', 'Canvas 无法编码为 JPEG'),
      );
    }
  });
}

function dedupe(items: ReadonlyArray<string>): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function createState(
  document: NoteExportDocument,
  options: NotePdfRenderOptions,
): RenderState {
  const paper = document.options.pdfPaper;
  const { width, height } = paperPixels(paper);
  const factory = options.canvasFactory ?? defaultNotePdfCanvasFactory();
  const exportedAt = (options.now ?? new Date()).toISOString();
  const state: RenderState = {
    pages: [],
    page: null as unknown as Page,
    y: 0,
    width,
    height,
    contentWidth: width - MARGIN * 2,
    bottom: height - MARGIN,
    title: document.title,
    exportedAt,
    maxPages: options.maxPages ?? MAX_PAGES,
    factory,
    loadImage: options.loadImage ?? defaultNotePdfImageLoader,
    imageWarnings: [],
    boardImages: new Map(),
    currentOrderedGroup: null,
  };
  createPage(state, true);
  return state;
}

export async function renderNotePdf(
  document: NoteExportDocument,
  options: NotePdfRenderOptions = {},
): Promise<NoteExportRenderResult> {
  const state = createState(document, options);
  drawRichText(state, [{ text: document.title }], {
    size: 64,
    lineHeight: 78,
    color: INK,
    bold: true,
  });
  state.y += 8;

  if (document.options.includeMetadata) {
    drawMetadata(state, document);
  }
  drawToc(state, document);

  if (document.blocks.length === 0) {
    drawRichText(state, [{ text: '（空笔记）' }], { color: MUTED });
  } else {
    for (const block of document.blocks) {
      if (block.kind === 'ordered') {
        if (state.currentOrderedGroup === null) {
          state.currentOrderedGroup = block.number;
        }
      } else {
        state.currentOrderedGroup = null;
      }
      await drawBlock(state, block);
    }
  }
  if (state.y === FIRST_CONTENT_TOP) {
    drawRichText(state, [{ text: '（空笔记）' }], { color: MUTED });
  }
  drawFooter(state);

  const pages = await Promise.all(
    state.pages.map((page) => canvasToJpeg(page.canvas)),
  );
  const warnings: string[] = [
    ...document.warnings,
    ...state.imageWarnings,
    'PDF 文字由 Canvas 排版为图像，不可选中、检索或复制；需要可编辑内容请导出 Word 或 Markdown。',
  ];
  if (document.facts.formulas > 0) {
    warnings.push(
      `${document.facts.formulas} 个公式以 LaTeX 源导出（当前没有可用的公式预览图）。`,
    );
  }
  if (document.facts.internalLinks > 0) {
    warnings.push(
      `${document.facts.internalLinks} 个站内内链在导出文件外不可跳转。`,
    );
  }
  return {
    bytes: buildPdfFromJpegs(pages),
    mime: 'application/pdf',
    warnings: dedupe(warnings),
  };
}
