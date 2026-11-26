/**
 * PDF 导出（P2-04）。
 *
 * 不依赖第三方 PDF 库：先把报告排版到 Canvas，再把每页 JPEG 以 DCTDecode
 * 图像嵌入一个最小 PDF。这样中文由系统字体渲染，不需要在安装包里塞字体；
 * 代价是文字不可选中/检索，因此发布说明必须如实标注，结构化迁移应使用
 * Markdown 或 ZIP。
 */

import { htmlToMarkdown, noteFolderName } from '../../data/repositories/notes';
import { datasetCounts } from './dataset';
import type { BackupPayload } from './types';
import { exportFileName, type SerializedExport } from './serialize';
import { formatBytes, formatDateTime, truncate } from './utils';

export type PdfTextMetrics = { width: number };

export type PdfContext = {
  font: string;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  textBaseline: string;
  textAlign: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): PdfTextMetrics;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  save(): void;
  restore(): void;
};

export type PdfCanvas = {
  width: number;
  height: number;
  getContext(type: '2d'): PdfContext | null;
  toBlob(
    callback: (blob: Blob | null) => void,
    type?: string,
    quality?: number,
  ): void;
};

export type CanvasFactory = (width: number, height: number) => PdfCanvas;

export class PdfUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfUnavailableError';
  }
}

const PAGE_WIDTH = 1240;
const PAGE_HEIGHT = 1754;
const MARGIN_X = 88;
const MARGIN_TOP = 92;
const MARGIN_BOTTOM = 110;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const BODY_SIZE = 18;
const BODY_LINE = 30;
const MAX_PAGES = 150;

const INK = '#252c38';
const MUTED = '#7f8999';
const ACCENT = '#5579d5';
const LINE = '#e7e9ef';
const SOFT = '#f4f6fa';

const FONT_SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

export function defaultCanvasFactory(): CanvasFactory {
  if (typeof document === 'undefined') {
    throw new PdfUnavailableError('当前环境没有 Canvas，无法生成 PDF');
  }
  return (width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as PdfCanvas;
  };
}

type Page = { canvas: PdfCanvas; ctx: PdfContext };

type RenderState = {
  pages: Page[];
  page: Page;
  y: number;
  truncated: boolean;
};

function createPage(factory: CanvasFactory, first: boolean, exportedAt: string): Page {
  const canvas = factory(PAGE_WIDTH, PAGE_HEIGHT);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new PdfUnavailableError('Canvas 2D 上下文不可用');
  }
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  ctx.restore();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  if (first) {
    ctx.fillStyle = ACCENT;
    ctx.fillRect(MARGIN_X, 60, 64, 8);
    ctx.fillStyle = INK;
    ctx.font = `700 42px ${FONT_SANS}`;
    ctx.fillText('知行 · 完整导出', MARGIN_X, 92);
    ctx.fillStyle = MUTED;
    ctx.font = `18px ${FONT_SANS}`;
    ctx.fillText(`导出时间 ${formatDateTime(exportedAt)}`, MARGIN_X, 148);
  } else {
    ctx.fillStyle = MUTED;
    ctx.font = `15px ${FONT_SANS}`;
    ctx.fillText('知行 · 完整导出（续）', MARGIN_X, 44);
  }
  return { canvas, ctx };
}

function addPage(state: RenderState, factory: CanvasFactory, exportedAt: string): void {
  if (state.pages.length >= MAX_PAGES) {
    state.truncated = true;
    return;
  }
  const page = createPage(factory, false, exportedAt);
  state.pages.push(page);
  state.page = page;
  state.y = MARGIN_TOP;
}

function ensureSpace(
  state: RenderState,
  factory: CanvasFactory,
  exportedAt: string,
  height: number,
): boolean {
  if (state.truncated) return false;
  if (state.y + height <= PAGE_HEIGHT - MARGIN_BOTTOM) return true;
  if (state.pages.length >= MAX_PAGES) {
    state.truncated = true;
    return false;
  }
  addPage(state, factory, exportedAt);
  return !state.truncated;
}

function drawWrapped(
  state: RenderState,
  factory: CanvasFactory,
  exportedAt: string,
  text: string,
  options: {
    size?: number;
    lineHeight?: number;
    color?: string;
    weight?: string;
    indent?: number;
    maxChars?: number;
  } = {},
): void {
  if (!text) return;
  const size = options.size ?? BODY_SIZE;
  const lineHeight = options.lineHeight ?? BODY_LINE;
  const color = options.color ?? INK;
  const indent = options.indent ?? 0;
  const limited =
    options.maxChars && text.length > options.maxChars
      ? `${text.slice(0, options.maxChars)}…（后续内容见 Markdown/ZIP）`
      : text;
  const maxWidth = CONTENT_WIDTH - indent;
  let current = '';

  const flush = () => {
    if (!current) return;
    if (!ensureSpace(state, factory, exportedAt, lineHeight)) return;
    state.page.ctx.fillStyle = color;
    state.page.ctx.font = `${options.weight ?? '400'} ${size}px ${FONT_SANS}`;
    state.page.ctx.fillText(current, MARGIN_X + indent, state.y);
    state.y += lineHeight;
    current = '';
  };

  for (const raw of limited.split('\n')) {
    if (raw === '') {
      flush();
      if (ensureSpace(state, factory, exportedAt, lineHeight / 2)) {
        state.y += lineHeight / 2;
      }
      continue;
    }
    for (const char of raw) {
      state.page.ctx.font = `${options.weight ?? '400'} ${size}px ${FONT_SANS}`;
      const next = current + char;
      if (current && state.page.ctx.measureText(next).width > maxWidth) {
        flush();
        current = char;
      } else {
        current = next;
      }
    }
    flush();
  }
}

function drawSection(
  state: RenderState,
  factory: CanvasFactory,
  exportedAt: string,
  title: string,
  count?: number,
): void {
  if (!ensureSpace(state, factory, exportedAt, 62)) return;
  state.y += 10;
  state.page.ctx.fillStyle = LINE;
  state.page.ctx.fillRect(MARGIN_X, state.y, CONTENT_WIDTH, 1);
  state.y += 18;
  state.page.ctx.fillStyle = ACCENT;
  state.page.ctx.fillRect(MARGIN_X, state.y + 4, 5, 25);
  state.page.ctx.fillStyle = INK;
  state.page.ctx.font = `700 26px ${FONT_SANS}`;
  state.page.ctx.fillText(title, MARGIN_X + 18, state.y);
  if (typeof count === 'number') {
    state.page.ctx.fillStyle = MUTED;
    state.page.ctx.font = `16px ${FONT_SANS}`;
    const label = `${count}`;
    const width = state.page.ctx.measureText(label).width;
    state.page.ctx.fillText(label, PAGE_WIDTH - MARGIN_X - width, state.y + 8);
  }
  state.y += 44;
}

function drawRow(
  state: RenderState,
  factory: CanvasFactory,
  exportedAt: string,
  label: string,
  value: string,
): void {
  if (!ensureSpace(state, factory, exportedAt, 30)) return;
  state.page.ctx.fillStyle = MUTED;
  state.page.ctx.font = `15px ${FONT_SANS}`;
  state.page.ctx.fillText(label, MARGIN_X, state.y + 3);
  state.page.ctx.fillStyle = INK;
  state.page.ctx.font = `17px ${FONT_SANS}`;
  state.page.ctx.fillText(value, MARGIN_X + 200, state.y + 1);
  state.y += 30;
}

function noteBody(payload: BackupPayload, noteId: string): string {
  const note = payload.dataset.notes.find((item) => item.id === noteId);
  if (!note) return '';
  const blocks = payload.dataset.noteBlocks
    .filter((block) => block.noteId === noteId && !block.deletedAt)
    .sort((a, b) => a.orderKey - b.orderKey)
    .map((block) => {
      const value = block.payload as Record<string, unknown>;
      const text =
        (typeof value.text === 'string' && value.text) ||
        (typeof value.html === 'string' && value.html) ||
        '';
      return text;
    })
    .filter(Boolean);
  const body =
    note.body && note.body.trim()
      ? note.bodyFormat === 'html'
        ? htmlToMarkdown(note.body)
        : note.body
      : blocks.join('\n\n');
  return body.replace(/<[^>]+>/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function renderReport(
  payload: BackupPayload,
  factory: CanvasFactory,
): { pages: Page[]; truncated: boolean } {
  const exportedAt = payload.exportedAt;
  const first = createPage(factory, true, exportedAt);
  const state: RenderState = {
    pages: [first],
    page: first,
    y: 190,
    truncated: false,
  };
  const counts = datasetCounts(payload.dataset);

  drawWrapped(state, factory, exportedAt, '概览', {
    size: 30,
    weight: '700',
    lineHeight: 42,
  });
  state.y += 6;
  drawRow(state, factory, exportedAt, '应用版本', payload.appVersion);
  drawRow(state, factory, exportedAt, '数据库 schema', `v${payload.schemaVersion}`);
  drawRow(
    state,
    factory,
    exportedAt,
    '对象总数',
    `${counts.lists} 清单 · ${counts.tasks} 任务 · ${counts.notes} 笔记 · ${counts.boards} 画板`,
  );
  drawRow(
    state,
    factory,
    exportedAt,
    '附件',
    `${counts.attachments} 个（二进制不随 PDF 导出）`,
  );
  drawRow(
    state,
    factory,
    exportedAt,
    '关系',
    `${payload.dataset.tasks.length + payload.dataset.noteTodos.length + payload.dataset.boards.length} 组主要关联（结构以 ZIP 为准）`,
  );

  drawSection(state, factory, exportedAt, '任务', counts.tasks);
  if (payload.dataset.tasks.length === 0) {
    drawWrapped(state, factory, exportedAt, '没有任务', { color: MUTED });
  } else {
    const listNames = new Map(
      payload.dataset.lists.map((list) => [list.id, list.name]),
    );
    const tasks = payload.dataset.tasks
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder);
    for (const task of tasks) {
      const mark = task.status === 'done' ? '✓' : task.status === 'doing' ? '◐' : '○';
      const due = task.dueDate ? ` · 截止 ${task.dueDate}` : '';
      const list = listNames.get(task.listId) ?? task.listId;
      drawWrapped(
        state,
        factory,
        exportedAt,
        `${mark} ${task.title} — ${list}${due}${task.deletedAt ? '（回收站）' : ''}`,
        { size: 17, lineHeight: 27 },
      );
    }
  }

  drawSection(state, factory, exportedAt, '知识', counts.notes);
  if (payload.dataset.notes.length === 0) {
    drawWrapped(state, factory, exportedAt, '没有笔记', { color: MUTED });
  } else {
    for (const note of payload.dataset.notes) {
      if (!ensureSpace(state, factory, exportedAt, 80)) break;
      drawWrapped(
        state,
        factory,
        exportedAt,
        `${note.title || '未命名笔记'}${note.deletedAt ? '（回收站）' : ''}`,
        { size: 22, weight: '700', lineHeight: 34 },
      );
      drawWrapped(
        state,
        factory,
        exportedAt,
        `目录 ${noteFolderName(note.folderId)} · 标签 ${
          note.tags.length ? note.tags.join('、') : '无'
        }`,
        { size: 14, color: MUTED, lineHeight: 24 },
      );
      const body = noteBody(payload, note.id);
      if (body) {
        state.y += 4;
        drawWrapped(state, factory, exportedAt, body, {
          size: 16,
          lineHeight: 26,
          maxChars: 4000,
        });
      }
      state.y += 16;
    }
  }

  drawSection(state, factory, exportedAt, '画板', counts.boards);
  if (payload.dataset.boards.length === 0) {
    drawWrapped(state, factory, exportedAt, '没有画板', { color: MUTED });
  } else {
    for (const board of payload.dataset.boards) {
      if (!ensureSpace(state, factory, exportedAt, 70)) break;
      drawWrapped(
        state,
        factory,
        exportedAt,
        `${board.board.title}${board.board.deletedAt ? '（回收站）' : ''}`,
        { size: 21, weight: '700', lineHeight: 32 },
      );
      drawWrapped(
        state,
        factory,
        exportedAt,
        `${board.nodes.length} 个对象 / ${board.edges.length} 条连线`,
        { size: 15, color: MUTED, lineHeight: 24 },
      );
      const texts = board.nodes
        .filter((node) => !node.deletedAt && node.text.trim())
        .slice(0, 12)
        .map((node) => truncate(node.text, 36));
      if (texts.length > 0) {
        drawWrapped(state, factory, exportedAt, texts.join(' · '), {
          size: 15,
          lineHeight: 24,
          maxChars: 400,
        });
      }
      state.y += 12;
    }
  }

  drawSection(state, factory, exportedAt, '复盘', counts.reviewSnapshots);
  if (payload.dataset.reviewSnapshots.length === 0) {
    drawWrapped(state, factory, exportedAt, '没有复盘快照', { color: MUTED });
  } else {
    for (const snapshot of payload.dataset.reviewSnapshots) {
      drawWrapped(
        state,
        factory,
        exportedAt,
        `${snapshot.rangeStart} → ${snapshot.rangeEnd} · ${snapshot.taskIds.length} 任务 / ${snapshot.focusIds.length} 专注 / ${snapshot.habitIds.length} 习惯${snapshot.deletedAt ? '（回收站）' : ''}`,
        { size: 16, lineHeight: 26 },
      );
    }
  }

  drawSection(state, factory, exportedAt, '附件', counts.attachments);
  if (payload.dataset.attachments.length === 0) {
    drawWrapped(state, factory, exportedAt, '没有附件', { color: MUTED });
  } else {
    for (const attachment of payload.dataset.attachments) {
      drawWrapped(
        state,
        factory,
        exportedAt,
        `${attachment.fileName} · ${formatBytes(attachment.byteSize)} · ${attachment.sha256.slice(0, 16)}…`,
        { size: 16, lineHeight: 26 },
      );
    }
  }

  drawSection(state, factory, exportedAt, '设备偏好（白名单）', counts.settings);
  if (payload.dataset.settings.length === 0) {
    drawWrapped(state, factory, exportedAt, '没有可导出的偏好', { color: MUTED });
  } else {
    for (const setting of payload.dataset.settings) {
      drawWrapped(
        state,
        factory,
        exportedAt,
        `${setting.key} = ${JSON.stringify(setting.value)}`,
        { size: 16, lineHeight: 26, maxChars: 300 },
      );
    }
  }

  if (state.truncated) {
    drawWrapped(
      state,
      factory,
      exportedAt,
      `报告超过 ${MAX_PAGES} 页，后续内容已截断；完整数据请导出 ZIP。`,
      { size: 16, color: MUTED, lineHeight: 26 },
    );
  }

  // 页脚：在所有页生成后绘制，才能显示总页数。
  const total = state.pages.length;
  state.pages.forEach((page, index) => {
    page.ctx.fillStyle = SOFT;
    page.ctx.fillRect(MARGIN_X, PAGE_HEIGHT - 76, CONTENT_WIDTH, 1);
    page.ctx.fillStyle = MUTED;
    page.ctx.font = `13px ${FONT_SANS}`;
    page.ctx.fillText(
      `知行 · 本机数据导出 · ${formatDateTime(exportedAt)}`,
      MARGIN_X,
      PAGE_HEIGHT - 58,
    );
    const label = `${index + 1} / ${total}`;
    const width = page.ctx.measureText(label).width;
    page.ctx.fillText(label, PAGE_WIDTH - MARGIN_X - width, PAGE_HEIGHT - 58);
  });

  return { pages: state.pages, truncated: state.truncated };
}

async function canvasToJpeg(canvas: PdfCanvas): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new PdfUnavailableError('Canvas 无法编码为 JPEG'));
            return;
          }
          void blob
            .arrayBuffer()
            .then((buffer) => resolve(new Uint8Array(buffer)))
            .catch(reject);
        },
        'image/jpeg',
        0.86,
      );
    } catch (error) {
      reject(error);
    }
  });
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

class PdfBuilder {
  private readonly chunks: Uint8Array[] = [];
  private readonly offsets: number[] = [];
  private length = 0;

  constructor() {
    this.push(ascii('%PDF-1.4\n%âãÏÓ\n'));
  }

  private push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
  }

  private object(id: number, body: Uint8Array): void {
    this.offsets[id] = this.length;
    this.push(ascii(`${id} 0 obj\n`));
    this.push(body);
    this.push(ascii('\nendobj\n'));
  }

  addCatalogAndPages(pageIds: number[]): void {
    this.object(1, ascii('<< /Type /Catalog /Pages 2 0 R >>'));
    this.object(
      2,
      ascii(
        `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds
          .map((id) => `${id} 0 R`)
          .join(' ')}] >>`,
      ),
    );
  }

  addPage(pageId: number, contentId: number, imageId: number, image: Uint8Array): void {
    const content = ascii(
      `q\n595 0 0 842 0 0 cm\n/Im0 Do\nQ\n`,
    );
    this.object(
      pageId,
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
    this.object(
      contentId,
      this.streamObject(
        `<< /Length ${content.byteLength} >>`,
        content,
      ),
    );
    this.object(
      imageId,
      this.streamObject(
        `<< /Type /XObject /Subtype /Image /Width ${PAGE_WIDTH} /Height ${PAGE_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.byteLength} >>`,
        image,
      ),
    );
  }

  private streamObject(dict: string, data: Uint8Array): Uint8Array {
    const head = ascii(`${dict}\nstream\n`);
    const tail = ascii('\nendstream');
    const output = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
    output.set(head, 0);
    output.set(data, head.byteLength);
    output.set(tail, head.byteLength + data.byteLength);
    return output;
  }

  finish(rootId = 1): Uint8Array {
    const count = this.offsets.length;
    const xrefOffset = this.length;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let id = 1; id < count; id += 1) {
      xref += `${String(this.offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${count} /Root ${rootId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    this.push(ascii(xref));
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const output = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return output;
  }
}

export function buildPdfFromJpegs(
  jpegs: ReadonlyArray<Uint8Array>,
): Uint8Array {
  if (jpegs.length === 0) {
    throw new PdfUnavailableError('PDF 至少需要一页');
  }
  const builder = new PdfBuilder();
  const pageIds: number[] = [];
  const pageObjects: Array<{ pageId: number; contentId: number; imageId: number }> = [];
  for (let index = 0; index < jpegs.length; index += 1) {
    const pageId = 3 + index * 3;
    pageObjects.push({
      pageId,
      contentId: pageId + 1,
      imageId: pageId + 2,
    });
    pageIds.push(pageId);
  }
  builder.addCatalogAndPages(pageIds);
  pageObjects.forEach((objects, index) => {
    builder.addPage(
      objects.pageId,
      objects.contentId,
      objects.imageId,
      jpegs[index]!,
    );
  });
  return builder.finish();
}

export async function buildPdfExport(
  payload: BackupPayload,
  options: { canvasFactory?: CanvasFactory; now?: Date } = {},
): Promise<SerializedExport> {
  const now = options.now ?? new Date();
  const factory = options.canvasFactory ?? defaultCanvasFactory();
  const { pages, truncated } = renderReport(payload, factory);
  const jpegs: Uint8Array[] = [];
  for (const page of pages) {
    jpegs.push(await canvasToJpeg(page.canvas));
  }
  const bytes = buildPdfFromJpegs(jpegs);
  const warnings = [
    'PDF 由 Canvas 排版后以 JPEG 图像嵌入，文字不可选中或检索；结构化迁移请使用 Markdown/ZIP。',
    'PDF 不包含附件二进制。',
  ];
  if (truncated) {
    warnings.push(`报告超过 ${MAX_PAGES} 页，后续内容已截断。`);
  }
  return {
    fileName: exportFileName('zhixing-report', 'pdf', now),
    mime: 'application/pdf',
    bytes,
    warnings,
  };
}
