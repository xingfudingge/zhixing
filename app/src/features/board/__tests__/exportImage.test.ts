import { describe, expect, it } from 'vitest';

import {
  BOARD_EXPORT_MAX_DIMENSION,
  BoardExportError,
  boardExportBounds,
  defaultBoardExportFileName,
  planBoardExport,
  renderBoardPng,
  type BoardExportCanvas,
} from '../export/image';
import { createEmptyDocument } from '../model';
import { sampleDocument } from './fakeBoardSource';

function fakeContext(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(target, property) {
        if (property === 'measureText') {
          return (text: string) => ({ width: Array.from(text).length * 8 });
        }
        return (..._args: unknown[]) => {
          void target;
        };
      },
      set() {
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

function fakeCanvasFactory(log: string[]) {
  return (width: number, height: number): BoardExportCanvas => ({
    width,
    height,
    getContext: () => fakeContext(),
    toBlob: (callback, type) => {
      log.push(`toBlob:${type ?? ''}:${width}x${height}`);
      callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type }));
    },
  });
}

function emptyBoard() {
  return createEmptyDocument({
    boardId: 'board-empty',
    noteId: 'note-1',
    title: '空白画板',
  });
}

describe('画板导出 PNG · 尺寸计划', () => {
  it('空画板明确报错，不生成空白图', () => {
    expect(() => planBoardExport(emptyBoard())).toThrowError(
      /空白画板没有可导出的内容/,
    );
    try {
      planBoardExport(emptyBoard());
    } catch (reason) {
      expect(reason).toBeInstanceOf(BoardExportError);
      expect((reason as BoardExportError).code).toBe('empty');
    }
  });

  it('按内容边界计算，连线/标签也包含在裁切框内', () => {
    const document = sampleDocument();
    const bounds = boardExportBounds(document);
    expect(bounds).not.toBeNull();
    // 样例文档节点范围 100..660；连线路径不能把边界缩回到节点内。
    expect(bounds!.width).toBeGreaterThanOrEqual(560);
    expect(bounds!.x).toBeLessThanOrEqual(100);

    const plan = planBoardExport(document, { scale: 2, padding: 48 });
    const left = (bounds!.x - plan.view.x) * plan.view.zoom;
    const top = (bounds!.y - plan.view.y) * plan.view.zoom;
    const right =
      (bounds!.x + bounds!.width - plan.view.x) * plan.view.zoom;
    const bottom =
      (bounds!.y + bounds!.height - plan.view.y) * plan.view.zoom;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(plan.cssWidth + 0.5);
    expect(bottom).toBeLessThanOrEqual(plan.cssHeight + 0.5);
    expect(plan.pixelWidth).toBeGreaterThanOrEqual(
      Math.round(bounds!.width * 2),
    );
  });

  it('支持当前主题 / 白底 / 透明三种背景', () => {
    const document = sampleDocument();
    const theme = planBoardExport(document, { background: 'theme' });
    expect(theme.paintBackground).toBe(true);

    const white = planBoardExport(document, { background: 'white' });
    expect(white.paintBackground).toBe(true);
    expect(white.theme.palette['--board-canvas-bg']).toBe('#ffffff');

    const transparent = planBoardExport(document, {
      background: 'transparent',
    });
    expect(transparent.paintBackground).toBe(false);
  });

  it('大画板按上限等比缩小并标记 limited，不裁切', () => {
    const document = sampleDocument();
    document.nodes[0] = {
      ...document.nodes[0]!,
      x: 0,
      y: 0,
      width: 40_000,
      height: 30_000,
    };
    const plan = planBoardExport(document, { scale: 2 });
    expect(plan.limited).toBe(true);
    expect(plan.pixelWidth).toBeLessThanOrEqual(BOARD_EXPORT_MAX_DIMENSION);
    expect(plan.pixelHeight).toBeLessThanOrEqual(BOARD_EXPORT_MAX_DIMENSION);
    expect(plan.zoom).toBeLessThan(1);
  });

  it('1x / 2x 倍率影响输出像素，不改变画板文档', () => {
    const document = sampleDocument();
    const snapshot = JSON.stringify(document);
    const one = planBoardExport(document, { scale: 1 });
    const two = planBoardExport(document, { scale: 2 });
    expect(two.pixelWidth).toBeGreaterThan(one.pixelWidth);
    expect(two.pixelHeight).toBeGreaterThan(one.pixelHeight);
    expect(JSON.stringify(document)).toBe(snapshot);
  });

  it('文件名去除非法字符并附时间戳', () => {
    expect(
      defaultBoardExportFileName('  发布/流程:*?  ', new Date(2026, 9, 28, 9, 5)),
    ).toBe('发布 流程-20261028-0905.png');
    expect(defaultBoardExportFileName('', new Date(2026, 0, 2, 3, 4))).toBe(
      '画板-20260102-0304.png',
    );
  });
});

describe('画板导出 PNG · Canvas 渲染', () => {
  it('输出 image/png，透明背景不铺底色，且不修改文档', async () => {
    const document = sampleDocument();
    const snapshot = JSON.stringify(document);
    const log: string[] = [];
    const result = await renderBoardPng(
      document,
      { background: 'transparent', scale: 2 },
      { canvasFactory: fakeCanvasFactory(log) },
    );
    expect(result.blob.type).toBe('image/png');
    expect(log).toEqual([
      `toBlob:image/png:${result.plan.pixelWidth}x${result.plan.pixelHeight}`,
    ]);
    expect(result.plan.paintBackground).toBe(false);
    expect(JSON.stringify(document)).toBe(snapshot);
  });

  it('没有 Canvas 上下文时给出可读错误', async () => {
    const document = sampleDocument();
    await expect(
      renderBoardPng(document, {}, {
        canvasFactory: (width, height) => ({
          width,
          height,
          getContext: () => null,
          toBlob: () => undefined,
        }),
      }),
    ).rejects.toThrow(/无法创建 Canvas 上下文/);
  });

  it('Canvas 编码失败时不返回伪成功', async () => {
    const document = sampleDocument();
    await expect(
      renderBoardPng(document, {}, {
        canvasFactory: (width, height) => ({
          width,
          height,
          getContext: () => fakeContext(),
          toBlob: (callback) => callback(null),
        }),
      }),
    ).rejects.toMatchObject({ code: 'encode' });
  });
});
