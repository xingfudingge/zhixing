import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { documentBounds, fitViewport } from '../model';
import { paintBoardThumbnail, readBoardTheme } from '../canvas/render';
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  MAX_ZOOM,
  type BoardDocument,
  type BoardObject,
  type BoardViewport,
} from '../types';

function get2dContext(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

/** 嵌入预览四周留白（世界单位），与《画板自由画布规范》§4.3 一致。 */
export const EMBED_PAD = 24;
export const EMBED_MIN_HEIGHT = 240;
export const EMBED_MAX_HEIGHT = 560;

export type EmbedFit = {
  /** 嵌入预览内容盒的 CSS 宽度（px）；运行时取整，纯函数保留小数。 */
  width: number;
  /** 嵌入预览的 CSS 高度（px），240–560。 */
  height: number;
  /** §4.3 视口：内容等比居中、完整可见、不裁切。世界坐标约定同渲染器。 */
  view: BoardViewport;
  /** 底部信息展示用的缩放比。 */
  zoom: number;
  /** 没有任何对象时为 true：调用方展示空态，不画空画布。 */
  empty: boolean;
};

/**
 * 笔记嵌入的按内容适配（规范 §4.3）：
 * 1) ratio = (bbox.h + 2·PAD) / (bbox.w + 2·PAD)
 * 2) H = clamp(round(W × ratio), 240, 560)
 * 3) zoom = min(W / (bbox.w + 2·PAD), H / (bbox.h + 2·PAD))
 * 4) `view` 是**世界坐标**中的视口左上角，与 render.ts 的
 *    `screen = (world − view) × zoom`、`fitViewport()` 同一语义：
 *    view = bboxCenter − viewportSize / (2 × zoom)。
 *    旧公式 `(W − bbox.w×zoom)/2 − bbox.x×zoom` 是屏幕像素口径，已废弃。
 * 5) 小内容只封顶到 MAX_ZOOM，超大内容允许缩到任意小，保证“不裁切”优先。
 */
export function computeEmbedFit(
  nodes: ReadonlyArray<BoardObject>,
  containerWidth: number,
): EmbedFit {
  // 纯函数不做二次取整：运行时调用方传入已取整的容器内容宽。
  const width = Math.max(1, containerWidth);
  const bounds = documentBounds(nodes);
  if (!bounds) {
    return {
      width,
      height: EMBED_MIN_HEIGHT,
      view: {
        x: BOARD_WIDTH / 2 - width / 2,
        y: BOARD_HEIGHT / 2 - EMBED_MIN_HEIGHT / 2,
        zoom: 1,
      },
      zoom: 1,
      empty: true,
    };
  }
  const paddedWidth = Math.max(1, bounds.width + EMBED_PAD * 2);
  const paddedHeight = Math.max(1, bounds.height + EMBED_PAD * 2);
  const height = Math.min(
    EMBED_MAX_HEIGHT,
    Math.max(EMBED_MIN_HEIGHT, Math.round(width * (paddedHeight / paddedWidth))),
  );
  const zoom = Math.min(width / paddedWidth, height / paddedHeight, MAX_ZOOM);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return {
    width,
    height,
    view: {
      x: centerX - width / (2 * zoom),
      y: centerY - height / (2 * zoom),
      zoom,
    },
    zoom,
    empty: false,
  };
}

/**
 * 笔记内嵌画板预览。使用同一套 Canvas2D 渲染器；默认按容器尺寸
 * 自适应缩放，传入 `fit` 时按规范 §4.3 的嵌入高度与视口绘制。
 */
export function BoardThumbnail({
  document,
  className,
  label,
  fit,
}: {
  document: BoardDocument;
  className?: string;
  label?: string;
  /** 嵌入模式：使用 §4.3 的高度/视口，而不是通用 fitViewport。 */
  fit?: EmbedFit;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({
    width: fit?.width ?? 520,
    height: fit?.height ?? 132,
  });
  const [themeVersion, setThemeVersion] = useState(0);
  // §4.3：fit 的 W/H 与 Canvas 的 CSS 宽高必须是同一组数；只有通用
  // 缩略图（无 fit）才依赖自身测量。
  const renderWidth = fit ? fit.width : size.width;
  const renderHeight = fit ? fit.height : size.height;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width || 520));
      const height = Math.max(
        1,
        Math.round(rect.height || (fit ? fit.height : 132)),
      );
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    measure();
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(measure)
        : null;
    observer?.observe(canvas);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
    // fit 只提供初始高度与视口来源，测量逻辑本身与 fit 无关。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') {
      return;
    }
    const observer = new MutationObserver(() =>
      setThemeVersion((value) => value + 1),
    );
    observer.observe(window.document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent'],
    });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = get2dContext(canvas);
    if (!context) {
      return;
    }
    const dpr =
      typeof window !== 'undefined'
        ? Math.min(2, window.devicePixelRatio || 1)
        : 1;
    const pixelWidth = Math.max(1, Math.round(renderWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(renderHeight * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const view = fit
      ? fit.view
      : fitViewport(document.nodes, size, 18);
    paintBoardThumbnail(
      context,
      document,
      renderWidth,
      renderHeight,
      dpr,
      view,
      readBoardTheme(),
    );
  }, [document, size, renderWidth, renderHeight, themeVersion, fit]);

  return (
    <canvas
      ref={canvasRef}
      className={className ? `bw-thumbnail ${className}` : 'bw-thumbnail'}
      style={
        fit
          ? { width: `${fit.width}px`, height: `${fit.height}px` }
          : undefined
      }
      role="img"
      aria-label={
        label ??
        `画板预览：${document.nodes.length} 个对象、${document.edges.length} 条连线`
      }
    />
  );
}
