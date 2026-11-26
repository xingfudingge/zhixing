import { describe, expect, it } from 'vitest';

import { makeBlock } from '../../../editor/__tests__/fakeBlockSource';
import { readZip } from '../../zip';
import { renderNoteDocx } from '../docx';
import type { NoteExportBlock } from '../types';
import {
  boardDocumentFixture,
  docxOptions,
  fixtureDocument,
  renderBoard,
} from './fixtures';

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function entriesOf(bytes: Uint8Array) {
  return new Map((await readZip(bytes)).map((entry) => [entry.path, entry]));
}

describe('单篇笔记 Word 导出', () => {
  it('生成可回读的 docx 包，含标题/表格/编号/图片/超链接', async () => {
    const doc = await fixtureDocument(docxOptions());
    const result = await renderNoteDocx(doc);
    const entries = await entriesOf(result.bytes);

    expect(result.bytes[0]).toBe(0x50);
    expect(result.bytes[1]).toBe(0x4b);
    expect([...entries.keys()]).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        '_rels/.rels',
        'word/document.xml',
        'word/styles.xml',
        'word/numbering.xml',
        'word/settings.xml',
        'word/header1.xml',
        'word/footer1.xml',
        'word/_rels/document.xml.rels',
        'word/media/image1.png',
        'word/media/board-1.png',
        'docProps/core.xml',
        'docProps/app.xml',
      ]),
    );

    const documentXml = decode(entries.get('word/document.xml')!.data);
    expect(documentXml).toContain('导出结构');
    expect(documentXml).toContain('w:pStyle w:val="Title"');
    expect(documentXml).toContain('w:pStyle w:val="Heading1"');
    expect(documentXml).toContain('<w:tbl>');
    expect(documentXml).toContain('<w:gridSpan w:val="2"/>');
    expect(documentXml).toContain('<w:vMerge w:val="restart"/>');
    expect(documentXml).toContain('<w:vMerge/>');
    expect(documentXml).toContain('<w:numPr>');
    expect(documentXml).toContain('<w:numId w:val="2"/>');
    expect(documentXml).toContain('☑');
    expect(documentXml).toContain('<w:drawing>');
    expect(documentXml).toContain('r:embed="');
    expect(documentXml).toContain('<w:hyperlink r:id="');
    expect(documentXml).toContain('《关联笔记》');
    expect(documentXml).toContain('需求说明.pdf');
    expect(documentXml).toContain('公式（LaTeX 源）');
    expect(documentXml).toContain('E = mc^2');
    expect(documentXml).toContain('画板：发布流程');

    const rels = decode(entries.get('word/_rels/document.xml.rels')!.data);
    expect(rels).toContain('Target="media/image1.png"');
    expect(rels).toContain('Target="media/board-1.png"');
    expect(rels).toContain(
      'Target="https://example.com/doc" TargetMode="External"',
    );

    const styles = decode(entries.get('word/styles.xml')!.data);
    expect(styles).toContain('w:styleId="Title"');
    expect(styles).toContain('w:styleId="Heading1"');
    expect(styles).toContain('w:styleId="QuoteSource"');

    const numbering = decode(entries.get('word/numbering.xml')!.data);
    expect(numbering).toContain('w:numFmt w:val="bullet"');
    expect(numbering).toContain('w:numFmt w:val="decimal"');

    const core = decode(entries.get('docProps/core.xml')!.data);
    expect(core).toContain('<dc:title>导出结构</dc:title>');
    expect(core).toContain('<dc:creator>知行</dc:creator>');

    expect(result.warnings.join('\n')).toContain('公式以 LaTeX 源导出');
    expect(result.warnings.join('\n')).toContain(
      '站内内链以“《标题》”文本导出',
    );
  });

  it('关闭元信息后不输出 Meta 表与创建/标签', async () => {
    const doc = await fixtureDocument({
      ...docxOptions(),
      includeMetadata: false,
    });
    const result = await renderNoteDocx(doc);
    const entries = await entriesOf(result.bytes);
    const documentXml = decode(entries.get('word/document.xml')!.data);
    expect(documentXml).not.toContain('w:style w:val="Meta"');
    expect(documentXml).not.toContain('创建');
    expect(documentXml).not.toContain('标签');
  });

  it('缺失图片写入占位文本，媒体数量与图片数一致', async () => {
    const doc = await fixtureDocument(docxOptions());
    type ImageBlock = Extract<NoteExportBlock, { kind: 'image' }>;
    expect(
      doc.blocks.filter((block): block is ImageBlock => block.kind === 'image'),
    ).toHaveLength(1);
    const result = await renderNoteDocx({
      ...doc,
      blocks: doc.blocks.map((block) =>
        block.kind === 'image'
          ? {
              ...block,
              asset: null,
              missingReason: '本机没有这个附件',
            }
          : block,
      ),
    });
    const entries = await entriesOf(result.bytes);
    expect(
      [...entries.keys()].filter((path) =>
        path.startsWith('word/media/image'),
      ),
    ).toHaveLength(0);
    // 画板块的图片不受“图片缺失”影响。
    expect(entries.has('word/media/board-1.png')).toBe(true);
    expect(decode(entries.get('word/document.xml')!.data)).toContain(
      '［图片缺失：架构图.png］',
    );
  });

  it('画板写入 board-N.png + 图片关系，超宽时等比缩进正文', async () => {
    const blocks = [
      makeBlock({
        id: 'board-only',
        noteId: 'note-a',
        type: 'board',
        orderKey: 1024,
        payload: { boardId: 'board-a', title: '发布流程' },
      }),
    ];
    const doc = await fixtureDocument(docxOptions(), {
      blocks,
      renderBoard: async () => {
        const base = await renderBoard(boardDocumentFixture());
        return { ...base, width: 1600, height: 800 };
      },
    });
    const result = await renderNoteDocx(doc);
    const entries = await entriesOf(result.bytes);
    const media = entries.get('word/media/board-1.png');
    expect(media).toBeDefined();
    expect([...media!.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const rels = decode(entries.get('word/_rels/document.xml.rels')!.data);
    expect(rels).toContain('Target="media/board-1.png"');

    const xml = decode(entries.get('word/document.xml')!.data);
    expect(xml).toContain('画板：发布流程');
    expect(xml).toContain('r:embed="');
    expect(xml).toContain('<w:keepNext/>');

    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(xml);
    expect(extent).not.toBeNull();
    const cx = Number(extent![1]);
    const cy = Number(extent![2]);
    // A4 + 20 mm 页边距：正文宽 170 mm = 6,120,130 EMU。
    expect(cx).toBeLessThanOrEqual(6_120_130);
    expect(cy / cx).toBeCloseTo(0.5, 2);
  });

  it('画板缺失时仍写可见占位与降级 warning', async () => {
    const blocks = [
      makeBlock({
        id: 'board-only',
        noteId: 'note-a',
        type: 'board',
        orderKey: 1024,
        payload: { boardId: 'board-a', title: '发布流程' },
      }),
    ];
    const doc = await fixtureDocument(docxOptions(), {
      blocks,
      resolveBoard: async () => null,
    });
    const result = await renderNoteDocx(doc);
    const entries = await entriesOf(result.bytes);
    expect(
      [...entries.keys()].filter((path) => path.startsWith('word/media/')),
    ).toHaveLength(0);
    expect(decode(entries.get('word/document.xml')!.data)).toContain(
      '画板：发布流程（画板数据不存在）',
    );
    expect(result.warnings.join('\n')).toContain('BOARD_IMAGE_MISSING');
  });

  it('同一画板出现两次只写一份 media，两处都引用同一关系', async () => {
    const block = (id: string) =>
      makeBlock({
        id,
        noteId: 'note-a',
        type: 'board',
        orderKey: 1024,
        payload: { boardId: 'board-a', title: '发布流程' },
      });
    const doc = await fixtureDocument(docxOptions(), {
      blocks: [block('board-1'), block('board-2')],
    });
    const result = await renderNoteDocx(doc);
    const entries = await entriesOf(result.bytes);
    expect(
      [...entries.keys()].filter((path) =>
        path.startsWith('word/media/board-'),
      ),
    ).toEqual(['word/media/board-1.png']);
    const xml = decode(entries.get('word/document.xml')!.data);
    expect(xml.match(/r:embed="/g)).toHaveLength(2);
    expect(xml.match(/画板：发布流程/g)).toHaveLength(2);
  });
});
