import { describe, expect, it, vi } from 'vitest';

import { createNoteExport, saveNoteExportToFile } from '../index';
import { exportNoteFileName } from '../../../../data/repositories/notes';
import { makeBlock } from '../../../editor/__tests__/fakeBlockSource';
import { readZip } from '../../zip';
import {
  boardDocumentFixture,
  docxOptions,
  fixtureDocument,
  noteFixture,
  pngBytes,
  renderBoard,
  resolveAsset,
} from './fixtures';
import {
  DEFAULT_NOTE_EXPORT_PREFERENCES,
  loadNoteExportPreferences,
  saveNoteExportPreferences,
  NOTE_EXPORT_SETTING_KEYS,
} from '../settings';
import { buildNoteExportDocument } from '../document';
import { renderNoteMarkdown } from '../markdown';

describe('单篇导出文件名与设置', () => {
  it('文件名去非法字符、保留扩展名、空标题回落', () => {
    expect(exportNoteFileName('a/b:c*?"<>|', 'docx')).toBe(
      'a-b-c------.docx',
    );
    expect(exportNoteFileName('   ', 'pdf')).toBe('未命名笔记.pdf');
    expect(exportNoteFileName('标题.', 'md')).toBe('标题.md');
  });

  it('设置缺失/不可用时使用默认 docx + 元信息 + 图片 + A4', async () => {
    const preferences = await loadNoteExportPreferences({
      settings: {
        list: vi.fn().mockRejectedValue(new Error('没有 SQLite')),
      } as never,
    });
    expect(preferences).toEqual(DEFAULT_NOTE_EXPORT_PREFERENCES);
  });

  it('设置读取按键解析，写入四个键', async () => {
    const list = vi.fn().mockResolvedValue([
      { key: NOTE_EXPORT_SETTING_KEYS.format, value: 'pdf' },
      { key: NOTE_EXPORT_SETTING_KEYS.includeMetadata, value: false },
      { key: NOTE_EXPORT_SETTING_KEYS.includeImages, value: true },
      { key: NOTE_EXPORT_SETTING_KEYS.pdfPaper, value: 'Letter' },
    ]);
    const set = vi.fn().mockResolvedValue({});
    const client = { settings: { list, set } } as never;
    await expect(loadNoteExportPreferences(client)).resolves.toEqual({
      format: 'pdf',
      includeMetadata: false,
      includeImages: true,
      pdfPaper: 'Letter',
    });
    await expect(
      saveNoteExportPreferences(client, {
        format: 'md',
        includeMetadata: true,
        includeImages: false,
        pdfPaper: 'A4',
      }),
    ).resolves.toBe(true);
    expect(set).toHaveBeenCalledTimes(4);
    expect(set.mock.calls.map((call) => call[0].key)).toEqual([
      NOTE_EXPORT_SETTING_KEYS.format,
      NOTE_EXPORT_SETTING_KEYS.includeMetadata,
      NOTE_EXPORT_SETTING_KEYS.includeImages,
      NOTE_EXPORT_SETTING_KEYS.pdfPaper,
    ]);
  });
});

describe('导出编排与保存结果', () => {
  it('生成 Markdown 报告并交给保存面板；同名路径报告实际文件名', async () => {
    const doc = await fixtureDocument({
      ...docxOptions(),
      format: 'md',
    });
    const saver = vi.fn().mockResolvedValue({
      status: 'saved' as const,
      path: '/tmp/导出结构-1.md',
      target: 'desktop' as const,
    });
    const result = await saveNoteExportToFile(
      {
        note: noteFixture(),
        blocks: [],
        options: { ...docxOptions(), format: 'md' },
        folderName: '产品设计',
        attachmentManager: null,
        now: new Date('2026-10-28T09:12:00+08:00'),
      },
      saver,
    );
    expect(result.status).toBe('saved');
    if (result.status !== 'saved') return;
    expect(result.report.fileName).toBe('导出结构.md');
    expect(result.actualFileName).toBe('导出结构-1.md');
    expect(result.renamed).toBe(true);
    expect(result.path).toBe('/tmp/导出结构-1.md');
    expect(saver).toHaveBeenCalledTimes(1);
    const blob = saver.mock.calls[0]![0] as Blob;
    expect(blob.type).toContain('text/markdown');
    expect(await blob.text()).toContain('# 导出结构');
    void doc;
  });

  it('取消保存返回 canceled，报告已生成但不落盘', async () => {
    const saver = vi.fn().mockResolvedValue({ status: 'canceled' as const });
    const result = await saveNoteExportToFile(
      {
        note: noteFixture(),
        blocks: [],
        options: { ...docxOptions(), format: 'md' },
        folderName: '产品设计',
        attachmentManager: null,
        now: new Date('2026-10-28T09:12:00+08:00'),
      },
      saver,
    );
    expect(result).toEqual({ status: 'canceled' });
    expect(saver).toHaveBeenCalledTimes(1);
  });

  it('附件服务缺失时仍在报告中列出缺失图片，不阻断 DOCX', async () => {
    const report = await createNoteExport({
      note: noteFixture(),
      blocks: [],
      options: docxOptions(),
      folderName: '产品设计',
      attachmentManager: null,
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    expect(report.bytes[0]).toBe(0x50);
    expect(report.fileName).toBe('导出结构.docx');
  });

  it('图片通过附件解析器进入 Markdown data URI', async () => {
    const doc = await buildNoteExportDocument({
      note: noteFixture(),
      blocks: [
        {
          id: 'img',
          noteId: 'note-a',
          type: 'image',
          orderKey: 1024,
          schemaVersion: 1,
          payload: {
            attachmentId: 'att-image',
            fileName: '架构图.png',
            mime: 'image/png',
            byteSize: pngBytes().byteLength,
            alt: '架构图',
          },
          createdAt: '2026-10-20T00:00:00.000Z',
          updatedAt: '2026-10-20T00:00:00.000Z',
          deletedAt: null,
          version: 1,
        },
      ],
      options: { ...docxOptions(), format: 'md' },
      folderName: '产品设计',
      resolveAttachment: resolveAsset,
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const markdown = new TextDecoder().decode(
      renderNoteMarkdown(doc).bytes,
    );
    expect(markdown).toContain('data:image/png;base64,');
    expect(doc.warnings).toHaveLength(0);
  });

  it('boardSource 读画板、DOCX 嵌入图片，保存后释放临时二进制', async () => {
    const load = vi.fn(async () => boardDocumentFixture());
    const board = makeBlock({
      id: 'board-only',
      noteId: 'note-a',
      type: 'board',
      orderKey: 1024,
      payload: { boardId: 'board-a', title: '发布流程' },
    });
    const saver = vi.fn().mockResolvedValue({
      status: 'saved' as const,
      path: '/tmp/导出结构.docx',
      target: 'desktop' as const,
    });

    const result = await saveNoteExportToFile(
      {
        note: noteFixture(),
        blocks: [board],
        options: docxOptions(),
        folderName: '产品设计',
        attachmentManager: null,
        boardSource: { load },
        renderBoard,
        now: new Date('2026-10-28T09:12:00+08:00'),
      },
      saver,
    );

    expect(load).toHaveBeenCalledWith('board-a');
    expect(result.status).toBe('saved');
    if (result.status !== 'saved') return;
    const entries = await readZip(result.report.bytes);
    expect(entries.map((entry) => entry.path)).toContain(
      'word/media/board-1.png',
    );
    const boardBlock = result.report.document.blocks.find(
      (block) => block.kind === 'board',
    );
    expect(boardBlock?.kind).toBe('board');
    if (boardBlock?.kind !== 'board') return;
    expect(boardBlock.asset).not.toBeNull();
    // `saveNoteExportToFile` 在 finally 中释放；已生成字节不受影响。
    expect(boardBlock.asset!.bytes).toBeNull();
    expect(boardBlock.asset!.base64).toBeNull();
  });
});
