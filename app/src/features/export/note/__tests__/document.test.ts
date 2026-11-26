import { describe, expect, it, vi } from 'vitest';

import { makeBlock } from '../../../editor/__tests__/fakeBlockSource';
import {
  buildNoteExportDocument,
  releaseNoteExportAssets,
  type RenderNoteBoard,
  type ResolveNoteBoard,
} from '../document';
import type { NoteExportBlock } from '../types';
import {
  boardDocumentFixture,
  docxOptions,
  noteFixture,
  renderBoard,
  resolveBoard,
} from './fixtures';

type BoardBlock = Extract<NoteExportBlock, { kind: 'board' }>;

function boardBlock(
  id: string,
  boardId: string | null = 'board-a',
  title = '发布流程',
) {
  return makeBlock({
    id,
    noteId: 'note-a',
    type: 'board',
    orderKey: 1024,
    payload: boardId ? { boardId, title } : { title },
  });
}

async function build(
  options: Parameters<typeof buildNoteExportDocument>[0]['options'],
  overrides: {
    blocks?: ReturnType<typeof boardBlock>[];
    resolveBoard?: ResolveNoteBoard;
    renderBoard?: RenderNoteBoard;
  } = {},
) {
  return buildNoteExportDocument({
    note: noteFixture(),
    blocks: overrides.blocks ?? [boardBlock('b1')],
    options,
    folderName: '产品设计',
    resolveBoard: overrides.resolveBoard ?? resolveBoard,
    renderBoard: overrides.renderBoard ?? renderBoard,
    now: new Date('2026-10-28T09:12:00+08:00'),
  });
}

function boardsOf(document: Awaited<ReturnType<typeof build>>): BoardBlock[] {
  return document.blocks.filter(
    (block): block is BoardBlock => block.kind === 'board',
  );
}

describe('单篇笔记导出 · 画板资源', () => {
  it('按 boardId 读取并渲染完整画板，同一画板只渲染一次且复用资源', async () => {
    const render = vi.fn(renderBoard);
    const doc = await build(docxOptions(), {
      blocks: [boardBlock('b1'), boardBlock('b2')],
      renderBoard: render,
    });
    const boards = boardsOf(doc);

    expect(render).toHaveBeenCalledTimes(1);
    expect(boards).toHaveLength(2);
    expect(boards[0]!.asset).not.toBeNull();
    expect(boards[1]!.asset).toBe(boards[0]!.asset);
    expect(boards[0]!.asset!.mime).toBe('image/png');
    expect(boards[0]!.asset!.base64).toBeTruthy();
    expect(boards[0]!.asset!.bytes?.byteLength).toBeGreaterThan(0);
    expect(boards[0]!.width).toBe(640);
    expect(boards[0]!.height).toBe(360);
    expect(boards[0]!.missingReason).toBeNull();
  });

  it('画板文档缺失时保留占位并写 BOARD_IMAGE_MISSING', async () => {
    const doc = await build(docxOptions(), {
      resolveBoard: async () => null,
    });
    const [board] = boardsOf(doc);
    expect(board!.asset).toBeNull();
    expect(board!.missingReason).toContain('不存在');
    expect(doc.warnings.join('\n')).toContain('BOARD_IMAGE_MISSING');
  });

  it('画板读取抛错也算数据缺失，不中断导出', async () => {
    const doc = await build(docxOptions(), {
      resolveBoard: async () => {
        throw new Error('SQLite 不可用');
      },
    });
    const [board] = boardsOf(doc);
    expect(board!.asset).toBeNull();
    expect(board!.missingReason).toContain('SQLite 不可用');
    expect(doc.warnings.join('\n')).toContain('BOARD_IMAGE_MISSING');
  });

  it('空画板保留占位并写 BOARD_IMAGE_EMPTY', async () => {
    const doc = await build(docxOptions(), {
      renderBoard: async () => {
        throw Object.assign(new Error('空白画板没有可导出的内容。'), {
          code: 'empty',
        });
      },
    });
    const [board] = boardsOf(doc);
    expect(board!.asset).toBeNull();
    expect(board!.missingReason).toContain('空画板');
    expect(doc.warnings.join('\n')).toContain('BOARD_IMAGE_EMPTY');
  });

  it('Canvas/编码失败保留占位并写 BOARD_IMAGE_FAILED', async () => {
    const doc = await build(docxOptions(), {
      renderBoard: async () => {
        throw new Error('Canvas 编码失败');
      },
    });
    const [board] = boardsOf(doc);
    expect(board!.asset).toBeNull();
    expect(board!.missingReason).toContain('Canvas 编码失败');
    expect(doc.warnings.join('\n')).toContain('BOARD_IMAGE_FAILED');
  });

  it('大画板被等比缩小仍嵌入，并写 BOARD_IMAGE_LIMITED', async () => {
    const doc = await build(docxOptions(), {
      renderBoard: async () => {
        const bytes = (await renderBoard(boardDocumentFixture())).bytes;
        return {
          blob: new Blob([bytes.slice().buffer], { type: 'image/png' }),
          bytes,
          mime: 'image/png',
          width: 4000,
          height: 2000,
          limited: true,
        };
      },
    });
    const [board] = boardsOf(doc);
    expect(board!.asset).not.toBeNull();
    expect(board!.asset!.limited).toBe(true);
    expect(doc.warnings.join('\n')).toContain('BOARD_IMAGE_LIMITED');
  });

  it('Markdown 不渲染画板 PNG，保留文字占位并报告', async () => {
    const render = vi.fn(renderBoard);
    const doc = await build(
      { ...docxOptions(), format: 'md' },
      { renderBoard: render },
    );
    const [board] = boardsOf(doc);
    expect(render).not.toHaveBeenCalled();
    expect(board!.asset).toBeNull();
    expect(doc.warnings.join('\n')).toContain('画板「发布流程」以文字占位导出');
    expect(doc.warnings.join('\n')).toContain(
      'BOARD_IMAGE_MARKDOWN_PLACEHOLDER',
    );
  });

  it('导出结束后释放画板与图片的临时二进制', async () => {
    const doc = await build(docxOptions());
    const [board] = boardsOf(doc);
    expect(board!.asset!.bytes).not.toBeNull();
    releaseNoteExportAssets(doc);
    expect(board!.asset!.bytes).toBeNull();
    expect(board!.asset!.base64).toBeNull();
    expect(board!.asset!.blob).toBeNull();
  });
});
