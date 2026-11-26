import { describe, expect, it } from 'vitest';

import { blocksToHtml } from '../../editor/blockHtml';
import {
  buildPdfExport,
  buildPdfFromJpegs,
  type CanvasFactory,
  type PdfCanvas,
  type PdfContext,
} from '../pdf';
import { FIXED_NOW, makePayload } from './testFixtures';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

function fakeCanvasFactory(sink: string[]): CanvasFactory {
  return (width, height): PdfCanvas => {
    const context: PdfContext = {
      font: '18px sans',
      fillStyle: '#000',
      strokeStyle: '#000',
      lineWidth: 1,
      textBaseline: 'top',
      textAlign: 'left',
      fillRect() {},
      fillText(text) {
        sink.push(text);
      },
      measureText(text) {
        const match = /(\d+)px/.exec(context.font);
        const size = match ? Number(match[1]) : 18;
        return { width: text.length * size * 0.58 };
      },
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      save() {},
      restore() {},
    };
    return {
      width,
      height,
      getContext: () => context,
      toBlob(callback) {
        callback(new Blob([JPEG], { type: 'image/jpeg' }));
      },
    };
  };
}

describe('PDF 导出', () => {
  it('将 Canvas 报告页嵌入 PDF（DCTDecode）并包含中文内容', async () => {
    const texts: string[] = [];
    const exported = await buildPdfExport(makePayload(), {
      canvasFactory: fakeCanvasFactory(texts),
      now: FIXED_NOW,
    });
    expect(exported.fileName).toMatch(/^zhixing-report-.*\.pdf$/);
    const bytes = exported.bytes;
    const head = new TextDecoder().decode(bytes.slice(0, 8));
    expect(head.startsWith('%PDF-1.4')).toBe(true);
    const body = new TextDecoder('latin1').decode(bytes);
    expect(body).toContain('/Filter /DCTDecode');
    expect(body).toContain('/Type /Page');
    expect(body).toContain('xref');
    expect(body).toContain('%%EOF');
    expect(texts.join(' ')).toContain('知行 · 完整导出');
    expect(texts.join(' ')).toContain('发布检查');
    expect(texts.join(' ')).toContain('整理发布清单');
    expect(exported.warnings.join(' ')).toContain('不可选中');
  });

  it('公式笔记在 PDF 报告中保留 LaTeX 源，不丢公式', async () => {
    const payload = makePayload();
    const formulaBody = blocksToHtml([
      {
        type: 'formula',
        payload: { latex: '\\frac{a}{b}', display: 'block' },
      },
    ]);
    const withFormula = {
      ...payload,
      dataset: {
        ...payload.dataset,
        notes: payload.dataset.notes.map((note) =>
          note.id === 'note-a'
            ? { ...note, body: formulaBody, bodyFormat: 'html' as const }
            : note,
        ),
      },
    };
    const texts: string[] = [];
    await buildPdfExport(withFormula, {
      canvasFactory: fakeCanvasFactory(texts),
      now: FIXED_NOW,
    });
    const reportText = texts.join(' ');
    expect(reportText).toContain('latex');
    expect(reportText).toContain('\\frac{a}{b}');
  });

  it('多页 PDF 的 /Count 与页对象数量一致', () => {
    const pdf = buildPdfFromJpegs([JPEG, JPEG, JPEG]);
    const body = new TextDecoder('latin1').decode(pdf);
    expect(body).toContain('/Count 3');
    expect((body.match(/\/Type \/Page\b/g) ?? []).length).toBe(3);
    expect((body.match(/\/Subtype \/Image/g) ?? []).length).toBe(3);
  });

  it('没有 Canvas 时抛出可读错误', async () => {
    const original = document.createElement;
    const createElement = document.createElement.bind(document);
    document.createElement = ((tag: string) => {
      if (tag === 'canvas') {
        const canvas = createElement('canvas');
        canvas.getContext = () => null;
        return canvas;
      }
      return createElement(tag);
    }) as typeof document.createElement;
    try {
      await expect(buildPdfExport(makePayload())).rejects.toThrow(/Canvas/);
    } finally {
      document.createElement = original;
    }
  });
});
