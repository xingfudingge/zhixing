/**
 * 编辑器浮动工具条的共享定位模型（ZX7-TOOLBAR-01）。
 *
 * 表格工具条与公式工具条共用同一套「锚点 → 视口坐标」计算：
 * - 锚点是 caret 所在单元格 / 公式 caret 行，不是块外壳；
 * - 首选锚点上方、右对齐；上方放不下翻到下方；两侧都不足按较大侧限高；
 * - 水平越界先改对齐再夹取，最后按内容区左/右边界兜底；
 * - 滚动 / resize / visualViewport / ResizeObserver 统一走 rAF 合并重算；
 * - 锚点离开视口超过 24px 时不再定位（由调用方隐藏工具条）。
 *
 * 坐标全部来自 `getBoundingClientRect()`，不写死位置；px 常量只表达
 * 设计与视口之间的间距，不是某个块的固定坐标。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';

export type RectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type ToolbarPlacement = {
  side: 'top' | 'bottom';
  left: number;
  top: number;
  maxWidth: number;
  /** 两侧空间都不足时的可见高度；正常情况为 null（不限制）。 */
  maxHeight: number | null;
};

export type ToolbarAnchor = {
  /** caret 单元格 / caret 行 / 公式预览的视口矩形。 */
  rect: RectLike;
  /** 编辑器内容区左边界，用于避免工具条压住侧栏。 */
  contentLeft?: number;
};

/** 工具条与锚点之间的间距（ZX7-DESIGN-01 §4.4 / §5.4）。 */
export const TOOLBAR_GAP = 6;
/** 工具条与可视视口边缘的最小间距。 */
export const TOOLBAR_VIEWPORT_GAP = 8;
/** 锚点离开视口多少像素后视为不可见。 */
export const TOOLBAR_ANCHOR_MARGIN = 24;
/** jsdom / 首帧测量不到尺寸时的回退，只用于定位，不参与视觉。 */
export const TOOLBAR_FALLBACK_WIDTH = 240;
export const TOOLBAR_FALLBACK_HEIGHT = 34;
/** 指针从块移动到 portal 工具条的缓冲时间。 */
export const TOOLBAR_HOVER_HIDE_MS = 120;

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

/** 优先使用 visualViewport（缩放 / 软键盘），不可用时回落 window。 */
export function getViewportRect(): RectLike {
  if (typeof window === 'undefined') {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  const visual = window.visualViewport;
  const width = visual?.width ?? window.innerWidth;
  const height = visual?.height ?? window.innerHeight;
  const left = visual?.offsetLeft ?? 0;
  const top = visual?.offsetTop ?? 0;
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

/**
 * 零尺寸锚点（jsdom / display:none）不做“滚出视口”判断：
 * 真实滚动时 DOM 矩形一定有尺寸，零尺寸只出现在测试或尚未布局的首帧。
 */
export function isAnchorVisible(
  rect: RectLike,
  viewport: RectLike = getViewportRect(),
  margin = TOOLBAR_ANCHOR_MARGIN,
): boolean {
  if (rect.width <= 0 && rect.height <= 0) {
    return true;
  }
  return (
    rect.bottom >= viewport.top - margin &&
    rect.top <= viewport.bottom + margin &&
    rect.right >= viewport.left - margin &&
    rect.left <= viewport.right + margin
  );
}

export function placeToolbar({
  anchor,
  layer,
  viewport,
  contentLeft,
}: {
  anchor: RectLike;
  layer: { width: number; height: number };
  viewport: RectLike;
  contentLeft?: number;
}): ToolbarPlacement {
  const edge = TOOLBAR_VIEWPORT_GAP;
  const gap = TOOLBAR_GAP;

  // 1) 水平可用宽度：先按视口上限收敛，避免窄窗里按钮被裁切。
  const maxWidth = Math.max(0, viewport.width - edge * 2);
  const width = Math.min(
    Math.max(0, layer.width) || TOOLBAR_FALLBACK_WIDTH,
    maxWidth,
  );
  const naturalHeight =
    Math.max(0, layer.height) || TOOLBAR_FALLBACK_HEIGHT;

  // 2) 垂直：首选上方，其次下方；都放不下时选空间大的一侧并限高。
  const spaceAbove = anchor.top - viewport.top - edge;
  const spaceBelow = viewport.bottom - anchor.bottom - edge;
  let side: 'top' | 'bottom';
  if (naturalHeight + gap <= spaceAbove) {
    side = 'top';
  } else if (naturalHeight + gap <= spaceBelow) {
    side = 'bottom';
  } else {
    side = spaceAbove >= spaceBelow ? 'top' : 'bottom';
  }
  const available = side === 'top' ? spaceAbove : spaceBelow;
  const maxHeight =
    naturalHeight + gap > available
      ? Math.max(0, available - gap)
      : null;
  const renderedHeight = maxHeight === null ? naturalHeight : maxHeight;

  // 3) 水平：end 对齐锚点右缘；左越界回落到视口左边界，再夹取右边界。
  let left = anchor.right - width;
  if (left < viewport.left + edge) {
    left = viewport.left + edge;
  }
  left = Math.min(left, viewport.right - edge - width);

  // 4) 内容区兜底：不压住左侧栏，但仍不离开视口。
  const minLeft = viewport.left + edge;
  const maxLeft = Math.max(minLeft, viewport.right - edge - width);
  if (contentLeft !== undefined) {
    left = Math.max(left, Math.min(contentLeft, maxLeft));
  }
  left = clamp(left, minLeft, maxLeft);

  // 5) 垂直坐标：绝不把工具条放进锚点矩形内。
  let top: number;
  if (side === 'top') {
    top = anchor.top - gap - renderedHeight;
    top = Math.max(viewport.top + edge, top);
  } else {
    top = anchor.bottom + gap;
    top = Math.min(top, viewport.bottom - edge - renderedHeight);
  }

  return {
    side,
    left: Math.round(left),
    top: Math.round(top),
    maxWidth: Math.round(maxWidth),
    maxHeight: maxHeight === null ? null : Math.round(maxHeight),
  };
}

/** 浮层根节点：应用存在 #floating-layer 时优先复用，否则挂到 body。 */
export function getFloatingLayer(): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.getElementById('floating-layer') ?? document.body;
}

function samePlacement(
  previous: ToolbarPlacement | null,
  next: ToolbarPlacement,
): boolean {
  return Boolean(
    previous &&
      previous.side === next.side &&
      previous.left === next.left &&
      previous.top === next.top &&
      previous.maxWidth === next.maxWidth &&
      previous.maxHeight === next.maxHeight,
  );
}

export type AnchoredToolbarOptions = {
  open: boolean;
  getAnchor: () => ToolbarAnchor | null;
  /**
   * 锚点/内容变化签名。caret 移动、切换编辑态、选中范围变化时改变它，
   * 让 hook 在 React 提交后重新测量；滚动与 resize 由监听器负责。
   */
  signature?: string | number;
};

export type AnchoredToolbar = {
  ref: RefObject<HTMLDivElement | null>;
  placement: ToolbarPlacement | null;
  style: CSSProperties;
};

/**
 * 把工具条挂到视口的共享 hook。首帧用 `visibility:hidden` 避免左上角闪动，
 * 测量完成后写入 left/top（position:fixed 由调用方 CSS 提供）。
 */
export function useAnchoredToolbar({
  open,
  getAnchor,
  signature,
}: AnchoredToolbarOptions): AnchoredToolbar {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<ToolbarPlacement | null>(null);
  const getAnchorRef = useRef(getAnchor);
  const frameRef = useRef<number | null>(null);
  getAnchorRef.current = getAnchor;

  const reposition = useCallback(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const layer = ref.current;
    if (!layer) {
      return;
    }
    const anchor = getAnchorRef.current();
    if (!anchor) {
      setPlacement(null);
      return;
    }
    const viewport = getViewportRect();
    if (!isAnchorVisible(anchor.rect, viewport)) {
      setPlacement(null);
      return;
    }
    const rect = layer.getBoundingClientRect();
    const width =
      rect.width || layer.offsetWidth || TOOLBAR_FALLBACK_WIDTH;
    const height =
      rect.height || layer.offsetHeight || TOOLBAR_FALLBACK_HEIGHT;
    const next = placeToolbar({
      anchor: anchor.rect,
      layer: { width, height },
      viewport,
      contentLeft: anchor.contentLeft,
    });
    setPlacement((previous) =>
      samePlacement(previous, next) ? previous : next,
    );
  }, [open]);

  const schedule = useCallback(() => {
    if (typeof window === 'undefined' || frameRef.current !== null) {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      reposition();
    });
  }, [reposition]);

  useLayoutEffect(() => {
    reposition();
  }, [open, signature, reposition]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onViewportChange = () => schedule();
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    const visual = window.visualViewport;
    visual?.addEventListener('resize', onViewportChange);
    visual?.addEventListener('scroll', onViewportChange);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(onViewportChange);
      if (ref.current) {
        observer.observe(ref.current);
      }
    }

    return () => {
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
      visual?.removeEventListener('resize', onViewportChange);
      visual?.removeEventListener('scroll', onViewportChange);
      observer?.disconnect();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [open, schedule]);

  const style: CSSProperties = placement
    ? {
        left: placement.left,
        top: placement.top,
        maxWidth: placement.maxWidth,
        ...(placement.maxHeight !== null
          ? {
              maxHeight: placement.maxHeight,
              overflowY: 'auto' as const,
            }
          : null),
      }
    : { visibility: 'hidden', pointerEvents: 'none' };

  return { ref, placement, style };
}
