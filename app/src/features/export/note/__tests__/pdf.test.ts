import { describe, expect, it } from 'vitest';

import { makeBlock } from '../../../editor/__tests__/fakeBlockSource';
import { tablePayloadRows, type TableModel } from '../../../editor/types';
import type {
  NotePdfCanvas,
  NotePdfCanvasFactory,
  NotePdfContext,
} from '../pdf';
import { renderNotePdf } from '../pdf';
import {
  boardDocumentFixture,
  docxOptions,
  fixtureDocument,
  noteFixture,
  pngBytes,
  renderBoard,
  resolveAsset,
} from './fixtures';
import { buildNoteExportDocument } from '../document';
import type { NoteExportDocument } from '../types';

const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
]);

type Recorder = {
  /** 所有页的 fillText 文本，保持调用顺序。 */
  texts: string[];
  images: number;
  /** Canvas 工厂被调用的次数，即页数。 */
  pages: number;
  /** 按页记录的文字，用于逐页断言内容没有被画到错误页面。 */
  pageTexts: string[][];
  /** 按页记录的 drawImage 次数。 */
  pageImages: number[];
  /** 实际编码为 JPEG 的页数；报错时应为 0，避免输出残缺文件。 */
  encoded: number;
  /** 每次 drawImage 的目标矩形，用于断言不溢出正文。 */
  imageRects: Array<{ dx: number; dy: number; dw: number; dh: number }>;
};

function makeRecorder(): Recorder {
  return {
    texts: [],
    images: 0,
    pages: 0,
    pageTexts: [],
    pageImages: [],
    encoded: 0,
    imageRects: [],
  };
}

function fakeFactory(recorder: Recorder): NotePdfCanvasFactory {
  return (width, height): NotePdfCanvas => {
    const pageIndex = recorder.pages;
    recorder.pages += 1;
    recorder.pageTexts.push([]);
    recorder.pageImages.push(0);
    let font = '28px sans';
    const ctx: NotePdfContext & Record<string, unknown> = {
      get font() {
        return font;
      },
      set font(value: string) {
        font = value;
      },
      fillStyle: '#000',
      strokeStyle: '#000',
      lineWidth: 1,
      textBaseline: 'top',
      textAlign: 'left',
      fillRect() {},
      fillText(text: string) {
        recorder.texts.push(text);
        recorder.pageTexts[pageIndex]!.push(text);
      },
      measureText(text: string) {
        const match = /(\d+(?:\.\d+)?)px/.exec(font);
        const size = match ? Number(match[1]) : 28;
        return { width: text.length * size * 0.58 };
      },
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      save() {},
      restore() {},
      drawImage(_image: unknown, dx: number, dy: number, dw: number, dh: number) {
        recorder.images += 1;
        recorder.pageImages[pageIndex] += 1;
        recorder.imageRects.push({ dx, dy, dw, dh });
      },
    };
    return {
      width,
      height,
      getContext: () => ctx,
      toBlob(callback) {
        recorder.encoded += 1;
        callback(new Blob([JPEG], { type: 'image/jpeg' }));
      },
    };
  };
}

function pdfOptions() {
  return { ...docxOptions(), format: 'pdf' as const };
}

function pageTexts(recorder: Recorder): string[] {
  return recorder.pageTexts.map((texts) => texts.join(''));
}

function gridTableModel(header: string[], rows: string[][]): TableModel {
  const allRows = [header, ...rows];
  return {
    schemaVersion: 2,
    header: true,
    widths: [400, 400],
    rows: allRows.map((row) =>
      row.map((text) => ({
        text,
        align: 'left' as const,
        rowSpan: 1,
        colSpan: 1,
        covered: false,
      })),
    ),
  };
}

describe('单篇笔记 PDF 导出', () => {
  it('A4 分页、页眉标题、页脚页码与全部块的可读表示', async () => {
    const doc = await fixtureDocument(pdfOptions());
    const recorder = makeRecorder();
    const result = await renderNotePdf(doc, {
      canvasFactory: fakeFactory(recorder),
      loadImage: async () => ({ fake: true }),
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const body = new TextDecoder('latin1').decode(result.bytes);
    expect(body.startsWith('%PDF-1.4')).toBe(true);
    expect(body).toContain('/Type /Page');
    // 画板整幅嵌入后内容超过一页，分页修复必须把后续块画到第 2 页。
    expect(body).toContain('/Count 2');
    expect(body).toContain('%%EOF');

    const text = recorder.texts.join('');
    expect(text).toContain('导出结构');
    expect(text).toContain('创建：2026-10-20 08:00');
    expect(text).toContain('目录');
    expect(text).toContain('概述');
    expect(text).toContain('重点');
    expect(text).toContain('完成导出');
    expect(text).toContain('第一步');
    expect(text).toContain('引用一段原则');
    expect(text).toContain('代码 · typescript');
    expect(text).toContain('const save = await saveFile({ name });');
    expect(text).toContain('模块');
    expect(text).toContain('打开 / 另存为');
    expect(text).toContain('哈希校验');
    expect(text).toContain('架构图.png');
    expect(text).toContain('需求说明.pdf');
    expect(text).toContain('画板：发布流程');
    expect(text).toContain('公式（LaTeX 源）');
    expect(text).toContain('E = mc^2');
    expect(text).toContain('示例站点');
    expect(text).toContain('第 1 / 2 页');
    expect(recorder.images).toBe(2);
    expect(result.warnings.join('\n')).toContain('不可选中、检索或复制');
    expect(result.warnings.join('\n')).toContain('公式以 LaTeX 源导出');
  });

  it('缺失/无法解码图片写入占位框并报告，不中断导出', async () => {
    const doc = await fixtureDocument(pdfOptions());
    const recorder = makeRecorder();
    const result = await renderNotePdf(doc, {
      canvasFactory: fakeFactory(recorder),
      loadImage: async () => null,
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const text = recorder.texts.join('');
    expect(text).toContain('［图片无法解码：架构图.png］');
    expect(recorder.images).toBe(0);
    expect(result.warnings.join('\n')).toContain('无法在当前环境解码');
  });

  it('超过页数上限时明确报错，且不编码残缺文件', async () => {
    const paragraphs = Array.from({ length: 80 }, (_, index) =>
      makeBlock({
        id: `p${index}`,
        noteId: 'note-a',
        type: 'paragraph',
        orderKey: 1024 * (index + 1),
        payload: { runs: [{ text: `第 ${index} 段`.repeat(8) }] },
      }),
    );
    const doc: NoteExportDocument = await buildNoteExportDocument({
      note: noteFixture(),
      blocks: paragraphs,
      options: pdfOptions(),
      folderName: '产品设计',
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const recorder = makeRecorder();
    let failure: unknown;
    try {
      await renderNotePdf(doc, {
        canvasFactory: fakeFactory(recorder),
        loadImage: async () => null,
        maxPages: 1,
        now: new Date('2026-10-28T09:12:00+08:00'),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('页上限');
    expect((failure as { code?: string }).code).toBe('PDF_TOO_LONG');
    // 报错发生在编码前：不能产出只剩第一页的残缺 PDF。
    expect(recorder.encoded).toBe(0);
  });

  it('空笔记也输出标题与空态', async () => {
    const doc = await buildNoteExportDocument({
      note: noteFixture({ title: '空笔记', body: '' }),
      blocks: [],
      options: pdfOptions(),
      folderName: '未分类',
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const recorder = makeRecorder();
    await renderNotePdf(doc, {
      canvasFactory: fakeFactory(recorder),
      loadImage: async () => null,
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    expect(recorder.texts.join('')).toContain('（空笔记）');
  });

  it('Letter 纸张使用不同页面尺寸', async () => {
    const doc = await fixtureDocument({
      ...pdfOptions(),
      pdfPaper: 'Letter',
    });
    const sizes: Array<[number, number]> = [];
    const base = fakeFactory(makeRecorder());
    const result = await renderNotePdf(doc, {
      canvasFactory: (width, height) => {
        sizes.push([width, height]);
        return base(width, height);
      },
      loadImage: async () => null,
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    expect(sizes[0]?.[0]).toBeGreaterThan(1600);
    expect(sizes[0]?.[0]).toBeLessThan(1700);
    expect(result.bytes.byteLength).toBeGreaterThan(100);
  });

  it('跨页长文：换页后的每一行都画在新页，逐页内容不丢', async () => {
    // 同一个 drawRichText 调用内跨页，才能覆盖「缓存旧页 ctx」的问题。
    const longText = Array.from(
      { length: 120 },
      (_, index) =>
        `段落标记-${String(index).padStart(3, '0')} ${'跨页内容'.repeat(20)}`,
    ).join('');
    const blocks = [
      makeBlock({
        id: 'long-paragraph',
        noteId: 'note-a',
        type: 'paragraph',
        orderKey: 1024,
        payload: { runs: [{ text: longText }] },
      }),
    ];
    const doc = await buildNoteExportDocument({
      note: noteFixture({ title: '跨页长文' }),
      blocks,
      options: pdfOptions(),
      folderName: '产品设计',
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const recorder = makeRecorder();
    await renderNotePdf(doc, {
      canvasFactory: fakeFactory(recorder),
      loadImage: async () => null,
      now: new Date('2026-10-28T09:12:00+08:00'),
    });

    const pages = pageTexts(recorder);
    expect(pages.length).toBeGreaterThan(1);
    const all = pages.join('\n');
    for (let index = 0; index < 120; index += 1) {
      const marker = `段落标记-${String(index).padStart(3, '0')}`;
      expect(all).toContain(marker);
    }
    // 旧实现把换页后的内容继续画在第一页的 ctx 上，续页只剩页眉页脚。
    for (let index = 1; index < pages.length; index += 1) {
      expect(pages[index]).toContain('段落标记-');
    }
    expect(recorder.encoded).toBe(recorder.pages);
  });

  it('跨页长表格：每页重复表头，所有行只出现一次', async () => {
    // 编辑器表格上限为 40 行（含表头），用满后再验证跨页分页。
    const rows = Array.from({ length: 39 }, (_, index) => [
      `行标记-${String(index).padStart(3, '0')}`,
      `内容-${String(index).padStart(3, '0')}`,
    ]);
    const model = gridTableModel(['列标题甲', '列标题乙'], rows);
    const table = makeBlock({
      id: 'table-long',
      noteId: 'note-a',
      type: 'table',
      orderKey: 1024,
      payload: { rows: tablePayloadRows(model) },
    });
    const doc = await buildNoteExportDocument({
      note: noteFixture({ title: '跨页长表格' }),
      blocks: [table],
      options: pdfOptions(),
      folderName: '产品设计',
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const recorder = makeRecorder();
    await renderNotePdf(doc, {
      canvasFactory: fakeFactory(recorder),
      loadImage: async () => null,
      now: new Date('2026-10-28T09:12:00+08:00'),
    });

    const pages = pageTexts(recorder);
    expect(pages.length).toBeGreaterThan(1);
    const all = pages.join('\n');
    const missing: number[] = [];
    for (let index = 0; index < 39; index += 1) {
      const suffix = String(index).padStart(3, '0');
      if (all.split(`行标记-${suffix}`).length - 1 !== 1) {
        missing.push(index);
      }
      expect(all).toContain(`内容-${suffix}`);
    }
    expect(missing).toEqual([]);
    const tablePages = pages.filter((text) => text.includes('行标记-'));
    expect(tablePages.length).toBeGreaterThan(1);
    for (const text of tablePages) {
      expect(text).toContain('列标题甲');
      expect(text).toContain('列标题乙');
    }
    // 表头只在有数据行的页重复，避免多画或漏画。
    expect(pages.filter((text) => text.includes('列标题甲')).length).toBe(
      tablePages.length,
    );
  });

  it('跨页代码块：每个代码行都落在某一页且不重复', async () => {
    const lines = Array.from(
      { length: 100 },
      (_, index) => `CODE_LINE_${String(index).padStart(3, '0')} // 示例`,
    );
    const code = makeBlock({
      id: 'code-long',
      noteId: 'note-a',
      type: 'code',
      orderKey: 1024,
      payload: { code: lines.join('\n'), language: 'typescript' },
    });
    const doc = await buildNoteExportDocument({
      note: noteFixture({ title: '跨页代码' }),
      blocks: [code],
      options: pdfOptions(),
      folderName: '产品设计',
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const recorder = makeRecorder();
    await renderNotePdf(doc, {
      canvasFactory: fakeFactory(recorder),
      loadImage: async () => null,
      now: new Date('2026-10-28T09:12:00+08:00'),
    });

    const pages = pageTexts(recorder);
    expect(pages.length).toBeGreaterThan(1);
    const all = pages.join('\n');
    for (const line of lines) {
      expect(all).toContain(line);
    }
    for (let index = 1; index < pages.length; index += 1) {
      expect(pages[index]).toContain('CODE_LINE_');
    }
  });

  it('跨页图片：所有图片都绘制，且续页图片不丢', async () => {
    const paragraphs = Array.from({ length: 60 }, (_, index) =>
      makeBlock({
        id: `before-image-${index}`,
        noteId: 'note-a',
        type: 'paragraph',
        orderKey: 1024 * (index + 1),
        payload: {
          runs: [{ text: `图片前段落-${String(index).padStart(2, '0')}` }],
        },
      }),
    );
    const images = Array.from({ length: 3 }, (_, index) =>
      makeBlock({
        id: `image-${index}`,
        noteId: 'note-a',
        type: 'image',
        orderKey: 1024 * (61 + index),
        payload: {
          attachmentId: 'att-image',
          fileName: `图片-${index}.png`,
          mime: 'image/png',
          byteSize: pngBytes().byteLength,
          alt: `图片 ${index}`,
          width: 600,
          height: 600,
        },
      }),
    );
    const doc = await buildNoteExportDocument({
      note: noteFixture({ title: '跨页图片' }),
      blocks: [...paragraphs, ...images],
      options: pdfOptions(),
      folderName: '产品设计',
      resolveAttachment: resolveAsset,
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const recorder = makeRecorder();
    await renderNotePdf(doc, {
      canvasFactory: fakeFactory(recorder),
      loadImage: async () => ({ fake: true }),
      now: new Date('2026-10-28T09:12:00+08:00'),
    });

    expect(recorder.images).toBe(3);
    const imagePages = recorder.pageImages.flatMap((count, index) =>
      Array.from({ length: count }, () => index),
    );
    expect(imagePages).toHaveLength(3);
    // 图片排在 60 段正文之后，必须落在续页而不是被画回第一页。
    expect(imagePages.every((index) => index > 0)).toBe(true);
    const pages = pageTexts(recorder);
    const all = pages.join('\n');
    for (let index = 0; index < 3; index += 1) {
      expect(all).toContain(`图片-${index}.png`);
    }
  });

  it('只有表头的表格也输出表头，不静默消失', async () => {
    const model = gridTableModel(['唯一表头甲', '唯一表头乙'], []);
    const table = makeBlock({
      id: 'table-header-only',
      noteId: 'note-a',
      type: 'table',
      orderKey: 1024,
      payload: { rows: tablePayloadRows(model) },
    });
    const doc = await buildNoteExportDocument({
      note: noteFixture({ title: '只有表头' }),
      blocks: [table],
      options: pdfOptions(),
      folderName: '产品设计',
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const recorder = makeRecorder();
    await renderNotePdf(doc, {
      canvasFactory: fakeFactory(recorder),
      loadImage: async () => null,
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const all = pageTexts(recorder).join('\n');
    expect(all).toContain('唯一表头甲');
    expect(all).toContain('唯一表头乙');
  });

  it('单行高过整页时明确报错，不静默裁掉单元格内容', async () => {
    const model = gridTableModel(
      ['列甲', '列乙'],
      [['超长内容'.repeat(1500), '短内容']],
    );
    const table = makeBlock({
      id: 'table-tall-row',
      noteId: 'note-a',
      type: 'table',
      orderKey: 1024,
      payload: { rows: tablePayloadRows(model) },
    });
    const doc = await buildNoteExportDocument({
      note: noteFixture({ title: '超高行' }),
      blocks: [table],
      options: pdfOptions(),
      folderName: '产品设计',
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const recorder = makeRecorder();
    let failure: unknown;
    try {
      await renderNotePdf(doc, {
        canvasFactory: fakeFactory(recorder),
        loadImage: async () => null,
        now: new Date('2026-10-28T09:12:00+08:00'),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('行过高');
    expect((failure as { code?: string }).code).toBe('GENERATE_FAILED');
    expect(recorder.encoded).toBe(0);
  });

  it('画板以 drawImage 嵌入，宽度不溢出正文且图注同页', async () => {
    const board = makeBlock({
      id: 'board-only',
      noteId: 'note-a',
      type: 'board',
      orderKey: 1024,
      payload: { boardId: 'board-a', title: '发布流程' },
    });
    const doc = await buildNoteExportDocument({
      note: noteFixture(),
      blocks: [board],
      options: pdfOptions(),
      folderName: '产品设计',
      resolveBoard: async () => boardDocumentFixture(),
      renderBoard: async () => {
        const base = await renderBoard(boardDocumentFixture());
        return { ...base, width: 1600, height: 800 };
      },
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const recorder = makeRecorder();
    const result = await renderNotePdf(doc, {
      canvasFactory: fakeFactory(recorder),
      loadImage: async () => ({ fake: true }),
      now: new Date('2026-10-28T09:12:00+08:00'),
    });

    expect(recorder.images).toBe(1);
    expect(recorder.pageImages[0]).toBe(1);
    const [rect] = recorder.imageRects;
    // A4 正文宽 174 mm → 约 1315 物理像素；高度上限 220 mm → 约 1663。
    expect(rect!.dw).toBeLessThanOrEqual(1316);
    expect(rect!.dh).toBeLessThanOrEqual(1663);
    expect(rect!.dh / rect!.dw).toBeCloseTo(0.5, 2);
    expect(recorder.pageTexts[0]!.join('')).toContain('画板：发布流程');
    expect(result.warnings.join('\n')).not.toContain('BOARD_IMAGE_MISSING');
  });

  it('画板缺失时 PDF 画可见占位并报告，不中断导出', async () => {
    const board = makeBlock({
      id: 'board-only',
      noteId: 'note-a',
      type: 'board',
      orderKey: 1024,
      payload: { boardId: 'board-a', title: '发布流程' },
    });
    const doc = await buildNoteExportDocument({
      note: noteFixture(),
      blocks: [board],
      options: pdfOptions(),
      folderName: '产品设计',
      resolveBoard: async () => null,
      renderBoard,
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const recorder = makeRecorder();
    const result = await renderNotePdf(doc, {
      canvasFactory: fakeFactory(recorder),
      loadImage: async () => null,
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    expect(recorder.images).toBe(0);
    expect(recorder.texts.join('')).toContain(
      '画板：发布流程（画板数据不存在）',
    );
    expect(result.warnings.join('\n')).toContain('BOARD_IMAGE_MISSING');
  });
});
