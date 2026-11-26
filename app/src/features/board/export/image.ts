/**
 * 画板导出 PNG（ZX-EXPORT-02）。
 *
 * 与整页/内嵌画布共用 Canvas2D 渲染器，不另做一套“导出图”绘制：
 * - 按内容边界（节点 + 连线 + 连线标签）计算裁切框，四周留固定留白；
 * - 支持当前主题 / 白底 / 透明背景，输出始终是 PNG；
 * - 默认 2x 高清；大画板按最大边长与总像素数等比缩小并返回 `limited`，
 *   由界面明确提示，不静默裁掉内容。
 *
 * 这里只负责生成 Blob/尺寸计划，不落盘、不写画板文档；保存面板与插入
 * 笔记分别由 `save.ts`、`noteInsert.ts` 处理。
 */

import {
  connectorGeometry,
  connectorLabelPoint,
  connectorSamples,
} from '../canvas/geometry';
import {
  FALLBACK_THEME,
  paintBoardScene,
  readBoardTheme,
  type BoardTheme,
} from '../canvas/render';
import { documentBounds, type Rect } from '../model';
import type { BoardDocument, BoardViewport } from '../types';

export type BoardExportBackground = 'theme' | 'white' | 'transparent';

export const BOARD_EXPORT_BACKGROUNDS: ReadonlyArray<{
  value: BoardExportBackground;
  label: string;
  hint: string;
}> = [
  {
    value: 'theme',
    label: '当前主题',
    hint: '跟随应用浅色 / 暗色外观',
  },
  {
    value: 'white',
    label: '白底',
    hint: '始终浅色，适合插入文档',
  },
  {
    value: 'transparent',
    label: '透明背景',
    hint: '不铺底色，便于叠放到其它背景',
  },
];

export const BOARD_EXPORT_MIME = 'image/png';
export const BOARD_EXPORT_DEFAULT_SCALE = 2;
export const BOARD_EXPORT_PADDING = 48;
/** 单边像素上限；超过时等比缩小而不是裁切。 */
export const BOARD_EXPORT_MAX_DIMENSION = 8192;
/** 总像素上限（约 40MP），避免超大画板耗尽 WebView 内存。 */
export const BOARD_EXPORT_MAX_PIXELS = 40_000_000;

export type BoardExportOptions = {
  background?: BoardExportBackground;
  /** 输出倍率；界面提供 1x / 2x。 */
  scale?: number;
  /** 内容四周留白（世界单位）。 */
  padding?: number;
  maxDimension?: number;
  maxPixels?: number;
};

export type BoardExportPlan = {
  background: BoardExportBackground;
  theme: BoardTheme;
  bounds: Rect;
  padding: number;
  /** 世界坐标 -> 输出 CSS 像素的缩放（大画板会小于 1）。 */
  zoom: number;
  /** 设备像素倍率（1 或 2）。 */
  scale: number;
  cssWidth: number;
  cssHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  /** 是否因尺寸上限被等比缩小；界面需要明确提示。 */
  limited: boolean;
  view: BoardViewport;
  paintBackground: boolean;
};

export type BoardExportErrorCode = 'empty' | 'unavailable' | 'encode';

export class BoardExportError extends Error {
  constructor(
    message: string,
    readonly code: BoardExportErrorCode,
  ) {
    super(message);
    this.name = 'BoardExportError';
  }
}

function includePoint(
  bounds: { left: number; top: number; right: number; bottom: number },
  point: { x: number; y: number },
): void {
  bounds.left = Math.min(bounds.left, point.x);
  bounds.top = Math.min(bounds.top, point.y);
  bounds.right = Math.max(bounds.right, point.x);
  bounds.bottom = Math.max(bounds.bottom, point.y);
}

/**
 * 导出裁切框：节点包围盒 + 连线路径 + 连线标签。
 *
 * 只取节点包围盒会在曲线/折线外扩时裁掉端部，因此这里把每条连线的采样
 * 点也纳入边界；标签按字符数估算宽度，宁可多留白也不裁掉文字。
 */
export function boardExportBounds(document: BoardDocument): Rect | null {
  const nodeBounds = documentBounds(document.nodes);
  if (!nodeBounds) {
    return null;
  }
  const box = {
    left: nodeBounds.x,
    top: nodeBounds.y,
    right: nodeBounds.x + nodeBounds.width,
    bottom: nodeBounds.y + nodeBounds.height,
  };
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  for (const edge of document.edges) {
    const from = nodeMap.get(edge.fromNodeId);
    const to = nodeMap.get(edge.toNodeId);
    if (!from || !to) {
      continue;
    }
    const geometry = connectorGeometry(edge, from, to);
    for (const point of connectorSamples(geometry, 32)) {
      includePoint(box, point);
    }
    if (edge.label.trim()) {
      const point = connectorLabelPoint(geometry);
      const labelWidth = Array.from(edge.label).length * 12 + 16;
      const labelHeight = 28;
      includePoint(box, { x: point.x - labelWidth / 2, y: point.y - labelHeight / 2 });
      includePoint(box, { x: point.x + labelWidth / 2, y: point.y + labelHeight / 2 });
    }
  }
  return {
    x: box.left,
    y: box.top,
    width: Math.max(1, box.right - box.left),
    height: Math.max(1, box.bottom - box.top),
  };
}

function resolveBackground(
  background: BoardExportBackground,
): { theme: BoardTheme; paintBackground: boolean } {
  if (background === 'white') {
    return { theme: FALLBACK_THEME, paintBackground: true };
  }
  if (background === 'transparent') {
    return { theme: readBoardTheme(), paintBackground: false };
  }
  return { theme: readBoardTheme(), paintBackground: true };
}

/**
 * 计算导出尺寸与视口。空画板直接抛出 `empty`，让界面显示空态而不是
 * 生成一张空白 PNG。
 */
export function planBoardExport(
  document: BoardDocument,
  options: BoardExportOptions = {},
): BoardExportPlan {
  const bounds = boardExportBounds(document);
  if (!bounds || document.nodes.length === 0) {
    throw new BoardExportError(
      '空白画板没有可导出的内容。先插入对象或模板后再导出。',
      'empty',
    );
  }

  const background = options.background ?? 'theme';
  const padding = Math.max(0, options.padding ?? BOARD_EXPORT_PADDING);
  const scale = Math.min(
    3,
    Math.max(1, Number.isFinite(options.scale) ? (options.scale as number) : BOARD_EXPORT_DEFAULT_SCALE),
  );
  const maxDimension = Math.max(
    256,
    options.maxDimension ?? BOARD_EXPORT_MAX_DIMENSION,
  );
  const maxPixels = Math.max(
    65_536,
    options.maxPixels ?? BOARD_EXPORT_MAX_PIXELS,
  );

  const contentWidth = Math.max(1, bounds.width + padding * 2);
  const contentHeight = Math.max(1, bounds.height + padding * 2);

  let zoom = 1;
  let pixelWidth = Math.max(1, Math.round(contentWidth * scale));
  let pixelHeight = Math.max(1, Math.round(contentHeight * scale));

  if (pixelWidth > maxDimension || pixelHeight > maxDimension) {
    zoom = Math.min(zoom, maxDimension / pixelWidth, maxDimension / pixelHeight);
  }
  if (pixelWidth * pixelHeight > maxPixels) {
    zoom *= Math.sqrt(maxPixels / (pixelWidth * pixelHeight));
  }
  zoom = Math.max(zoom, 0.001);

  pixelWidth = Math.max(1, Math.round(contentWidth * zoom * scale));
  pixelHeight = Math.max(1, Math.round(contentHeight * zoom * scale));

  // 极端长条画板四舍五入后仍可能越过上限，再做一次硬收敛。
  if (pixelWidth > maxDimension || pixelHeight > maxDimension) {
    const hard = Math.min(
      maxDimension / pixelWidth,
      maxDimension / pixelHeight,
    );
    pixelWidth = Math.max(1, Math.floor(pixelWidth * hard));
    pixelHeight = Math.max(1, Math.floor(pixelHeight * hard));
    zoom *= hard;
  }

  const { theme, paintBackground } = resolveBackground(background);
  return {
    background,
    theme,
    bounds,
    padding,
    zoom,
    scale,
    cssWidth: pixelWidth / scale,
    cssHeight: pixelHeight / scale,
    pixelWidth,
    pixelHeight,
    limited: zoom < 0.999,
    view: {
      x: bounds.x - padding,
      y: bounds.y - padding,
      zoom,
    },
    paintBackground,
  };
}

export type BoardExportCanvas = {
  width: number;
  height: number;
  getContext(type: '2d'): CanvasRenderingContext2D | null;
  toBlob(
    callback: (blob: Blob | null) => void,
    type?: string,
    quality?: number,
  ): void;
};

export type BoardExportCanvasFactory = (
  width: number,
  height: number,
) => BoardExportCanvas;

export type RenderBoardPngDependencies = {
  /** 测试注入；不传时创建真实 `<canvas>`。 */
  canvasFactory?: BoardExportCanvasFactory;
};

export type RenderedBoardPng = {
  blob: Blob;
  plan: BoardExportPlan;
};

export function defaultBoardExportCanvasFactory(): BoardExportCanvas {
  if (typeof document === 'undefined') {
    throw new BoardExportError('当前环境没有 Canvas，无法导出图片', 'unavailable');
  }
  return document.createElement('canvas') as unknown as BoardExportCanvas;
}

function canvasToPng(canvas: BoardExportCanvas): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new BoardExportError('Canvas 无法编码为 PNG', 'encode'));
            return;
          }
          resolve(blob);
        },
        BOARD_EXPORT_MIME,
      );
    } catch (reason) {
      reject(
        reason instanceof BoardExportError
          ? reason
          : new BoardExportError(
              `Canvas 无法编码为 PNG：${
                reason instanceof Error ? reason.message : String(reason)
              }`,
              'encode',
            ),
      );
    }
  });
}

/**
 * 把当前画板渲染为 PNG Blob。调用方负责保存/插入；此处不修改文档。
 */
export async function renderBoardPng(
  document: BoardDocument,
  options: BoardExportOptions = {},
  dependencies: RenderBoardPngDependencies = {},
): Promise<RenderedBoardPng> {
  const plan = planBoardExport(document, options);
  const canvas = (
    dependencies.canvasFactory ?? defaultBoardExportCanvasFactory
  )(plan.pixelWidth, plan.pixelHeight);
  canvas.width = plan.pixelWidth;
  canvas.height = plan.pixelHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new BoardExportError('当前环境无法创建 Canvas 上下文', 'unavailable');
  }

  paintBoardScene({
    ctx,
    width: plan.cssWidth,
    height: plan.cssHeight,
    dpr: plan.scale,
    document,
    view: plan.view,
    theme: plan.theme,
    readOnly: true,
    showGrid: false,
    showBoundary: false,
    shadow: true,
    paintBackground: plan.paintBackground,
  });

  return { blob: await canvasToPng(canvas), plan };
}

/** 文件名：保留标题信息，去掉路径/系统非法字符，并附本地时间戳。 */
export function defaultBoardExportFileName(
  title: string,
  now: Date = new Date(),
): string {
  const base =
    Array.from(
      (title || '画板')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
      .slice(0, 60)
      .join('') || '画板';
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate(),
  )}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${base}-${stamp}.png`;
}
