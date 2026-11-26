/**
 * Canvas2D 渲染层。
 *
 * 对象的填充、描边、文字、连线、锚点与选择框全部画在 Canvas 上；
 * 只有「双击改字」时临时叠加一个 textarea（IME/选区需要原生控件）。
 * 这里不生成 SVG，也不把 DOM 当成图形渲染器。
 */

import {
  BOARD_OBJECT_STROKE_WIDTH,
  connectorStyle,
  normalizeObjectType,
  objectLocked,
  objectStyle,
  sortByZ,
  type Point,
  type Rect,
} from '../model';
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  type AnchorSide,
  type BoardConnector,
  type BoardDocument,
  type BoardObject,
  type BoardSelection,
  type BoardViewport,
} from '../types';
import {
  anchorPoint,
  connectorEnds,
  connectorGeometry,
  connectorLabelPoint,
  sideDirection,
  type ConnectorGeometry,
} from './geometry';

export type BoardTheme = {
  surface: string;
  surface2: string;
  surface3: string;
  line: string;
  lineStrong: string;
  ink: string;
  muted: string;
  accent: string;
  accentSoft: string;
  onAccent: string;
  grid: string;
  shadow: string;
  fontFamily: string;
  /** `var(--board-*)` 语义令牌到当前主题实际颜色的映射。 */
  palette: Readonly<Record<string, string>>;
};

export const BOARD_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

/**
 * 画板语义色板。与 `board.css` 的 `--board-*` 保持一一对应；
 * CSS 尚未加载或 SSR 环境下用这里的值兜底，保证浅色/暗色都可读。
 */
const LIGHT_PALETTE: Readonly<Record<string, string>> = {
  '--surface': '#ffffff',
  '--surface-2': '#fbfcfe',
  '--surface-3': '#f1f4f8',
  '--line': '#e7e9ef',
  '--line-strong': '#d8dde7',
  '--ink': '#252c38',
  '--muted': '#7f8999',
  '--accent': '#5579d5',
  '--accent-soft': '#edf2fc',
  '--accent-ink': '#3f63b5',
  '--on-accent': '#ffffff',
  '--violet': '#8066c7',
  '--violet-soft': '#f2eefb',
  '--coral': '#d97664',
  '--coral-soft': '#fdf0ed',
  '--teal': '#3a9b9a',
  '--teal-soft': '#eaf5f4',
  '--amber': '#d89338',
  '--amber-soft': '#fdf4e6',
  '--green': '#2f9e73',
  '--green-soft': '#eaf6f0',
  '--red': '#cf5f59',
  '--red-soft': '#fbeceb',
  '--board-canvas-bg': '#ffffff',
  '--board-grid': '#dfe5ee',
  '--board-connector': '#93a1b3',
  '--board-anchor': '#5579d5',
  '--board-rect-fill': '#ffffff',
  '--board-rect-stroke': '#b9c4d3',
  '--board-rect-text': '#252c38',
  '--board-frame-fill': 'transparent',
  '--board-frame-stroke': '#cfd8e4',
  '--board-frame-text': '#5c6b7d',
  '--board-sticky-fill': '#fbf4df',
  '--board-sticky-stroke': '#e2cf9e',
  '--board-sticky-text': '#3c3a30',
  '--board-diamond-fill': '#fdf3e4',
  '--board-diamond-stroke': '#d8b37c',
  '--board-diamond-text': '#252c38',
  '--board-neutral-fill': '#f1f4f8',
  '--board-neutral-stroke': '#d8dde7',
  '--board-neutral-text': '#252c38',
  '--board-pill-fill': '#eaf6f0',
  '--board-pill-stroke': '#2f9e73',
  '--board-pill-text': '#252c38',
  '--board-decision-fill': '#fdf3e4',
  '--board-decision-stroke': '#d8b37c',
  '--board-decision-text': '#252c38',
  '--board-start-fill': '#ecf5f0',
  '--board-start-stroke': '#9fc4b0',
  '--board-start-text': '#2f5f4a',
  '--board-process-fill': '#ffffff',
  '--board-process-stroke': '#b9c4d3',
  '--board-process-text': '#252c38',
  '--board-accent-fill': '#edf2fc',
  '--board-accent-stroke': '#b9c8ea',
  '--board-violet-fill': '#f2eefb',
  '--board-violet-stroke': '#c9bce8',
  '--board-teal-fill': '#eaf5f4',
  '--board-teal-stroke': '#a9cfcd',
  '--board-coral-fill': '#fdf0ed',
  '--board-coral-stroke': '#e3b6aa',
  '--board-text': '#252c38',
  '--board-lock': '#7f8999',
};

const DARK_PALETTE: Readonly<Record<string, string>> = {
  '--surface': '#202633',
  '--surface-2': '#252c3a',
  '--surface-3': '#1b2029',
  '--line': '#323948',
  '--line-strong': '#414a5c',
  '--ink': '#e7eaf1',
  '--muted': '#9ca7ba',
  '--accent': '#5579d5',
  '--accent-soft': '#26324a',
  '--accent-ink': '#a9bdf0',
  '--on-accent': '#ffffff',
  '--violet': '#8066c7',
  '--violet-soft': '#2f2a44',
  '--coral': '#d97664',
  '--coral-soft': '#3a2a2a',
  '--teal': '#3a9b9a',
  '--teal-soft': '#22383a',
  '--amber': '#d89338',
  '--amber-soft': '#3a3022',
  '--green': '#2f9e73',
  '--green-soft': '#22352d',
  '--red': '#cf5f59',
  '--red-soft': '#3b2a2a',
  '--board-canvas-bg': '#202633',
  '--board-grid': '#394152',
  '--board-connector': '#7d8b9f',
  '--board-anchor': '#8aa6ea',
  '--board-rect-fill': '#252c3a',
  '--board-rect-stroke': '#495367',
  '--board-rect-text': '#e7eaf1',
  '--board-frame-fill': 'transparent',
  '--board-frame-stroke': '#3c4657',
  '--board-frame-text': '#a8b4c6',
  '--board-sticky-fill': '#33301f',
  '--board-sticky-stroke': '#5d5432',
  '--board-sticky-text': '#ece4cf',
  '--board-diamond-fill': '#332c1f',
  '--board-diamond-stroke': '#7a6338',
  '--board-diamond-text': '#e7eaf1',
  '--board-neutral-fill': '#252c3a',
  '--board-neutral-stroke': '#414a5c',
  '--board-neutral-text': '#e7eaf1',
  '--board-pill-fill': '#22352d',
  '--board-pill-stroke': '#3f7458',
  '--board-pill-text': '#e7eaf1',
  '--board-decision-fill': '#332c1f',
  '--board-decision-stroke': '#7a6338',
  '--board-decision-text': '#e7eaf1',
  '--board-start-fill': '#20322b',
  '--board-start-stroke': '#3d6a55',
  '--board-start-text': '#bfe0cf',
  '--board-process-fill': '#252c3a',
  '--board-process-stroke': '#495367',
  '--board-process-text': '#e7eaf1',
  '--board-accent-fill': '#26324a',
  '--board-accent-stroke': '#4f5f86',
  '--board-violet-fill': '#2f2a44',
  '--board-violet-stroke': '#645394',
  '--board-teal-fill': '#22383a',
  '--board-teal-stroke': '#3f7472',
  '--board-coral-fill': '#3a2a2a',
  '--board-coral-stroke': '#7a4c45',
  '--board-text': '#e7eaf1',
  '--board-lock': '#9ca7ba',
};

export const LIGHT_BOARD_PALETTE = LIGHT_PALETTE;
export const DARK_BOARD_PALETTE = DARK_PALETTE;

function themeFromPalette(
  palette: Readonly<Record<string, string>>,
  dark: boolean,
): BoardTheme {
  return {
    surface: palette['--surface'] ?? FALLBACK_COLOR,
    surface2: palette['--surface-2'] ?? FALLBACK_COLOR,
    surface3: palette['--surface-3'] ?? FALLBACK_COLOR,
    line: palette['--line'] ?? FALLBACK_COLOR,
    lineStrong: palette['--line-strong'] ?? FALLBACK_COLOR,
    ink: palette['--ink'] ?? FALLBACK_COLOR,
    muted: palette['--muted'] ?? FALLBACK_COLOR,
    accent: palette['--accent'] ?? FALLBACK_COLOR,
    accentSoft: palette['--accent-soft'] ?? FALLBACK_COLOR,
    onAccent: palette['--on-accent'] ?? '#ffffff',
    grid: palette['--board-grid'] ?? palette['--line-strong'] ?? FALLBACK_COLOR,
    shadow: dark ? 'rgba(0, 0, 0, 0.34)' : 'rgba(37, 49, 74, 0.16)',
    fontFamily: BOARD_FONT_FAMILY,
    palette,
  };
}

const FALLBACK_COLOR = '#7f8999';

export const FALLBACK_THEME: BoardTheme = themeFromPalette(LIGHT_PALETTE, false);
export const FALLBACK_DARK_THEME: BoardTheme = themeFromPalette(
  DARK_PALETTE,
  true,
);

function cssVariable(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return fallback;
  }
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

export function readBoardTheme(): BoardTheme {
  const dark =
    typeof document !== 'undefined' &&
    document.documentElement.getAttribute('data-theme') === 'dark';
  const base = dark ? DARK_PALETTE : LIGHT_PALETTE;
  const palette: Record<string, string> = {};
  for (const name of Object.keys(base)) {
    palette[name] = cssVariable(name, base[name]);
  }
  const fontFamily =
    cssVariable('--font-sans', BOARD_FONT_FAMILY).replace(/\s+/g, ' ').trim() ||
    BOARD_FONT_FAMILY;
  return { ...themeFromPalette(palette, dark), fontFamily };
}

const THEME_COLOR = /^var\(\s*(--board-[a-z0-9-]+)\s*\)$/i;

/**
 * 解析对象上保存的颜色：hex/transparent 原样返回，主题令牌按当前主题取值。
 * 用户自定义颜色永远不会被主题覆盖。
 */
export function resolveBoardColor(
  color: string,
  theme: BoardTheme = FALLBACK_THEME,
): string {
  if (!color || color === 'transparent') {
    return color;
  }
  const match = THEME_COLOR.exec(color.trim());
  if (!match) {
    return color;
  }
  const name = match[1].toLowerCase();
  return theme.palette[name] ?? LIGHT_PALETTE[name] ?? theme.muted;
}

export type PendingConnection = {
  from: BoardObject;
  side: AnchorSide;
  to: Point;
  targetId?: string | null;
};

export type PaintBoardOptions = {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
  document: BoardDocument;
  view: BoardViewport;
  selection?: BoardSelection;
  hoveredNodeId?: string | null;
  editingNodeId?: string | null;
  marquee?: Rect | null;
  pendingConnection?: PendingConnection | null;
  theme?: BoardTheme;
  readOnly?: boolean;
  showGrid?: boolean;
  showBoundary?: boolean;
  shadow?: boolean;
  /** 导出透明背景时传 false：只 clear，不铺画布底色。 */
  paintBackground?: boolean;
};

function isTransparent(color: string): boolean {
  return !color || color === 'transparent';
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function traceObjectPath(
  ctx: CanvasRenderingContext2D,
  node: BoardObject,
): void {
  const style = objectStyle(node);
  // 旧类型（process/start/decision）在这里按新语义取路径，避免刷新后变形。
  const type = normalizeObjectType(node.type);
  const { x, y, width, height } = node;
  switch (type) {
    case 'ellipse':
      ctx.beginPath();
      ctx.ellipse(
        x + width / 2,
        y + height / 2,
        width / 2,
        height / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.closePath();
      return;
    case 'diamond': {
      ctx.beginPath();
      ctx.moveTo(x + width / 2, y);
      ctx.lineTo(x + width, y + height / 2);
      ctx.lineTo(x + width / 2, y + height);
      ctx.lineTo(x, y + height / 2);
      ctx.closePath();
      return;
    }
    case 'triangle': {
      ctx.beginPath();
      ctx.moveTo(x + width / 2, y);
      ctx.lineTo(x + width, y + height);
      ctx.lineTo(x, y + height);
      ctx.closePath();
      return;
    }
    case 'hexagon': {
      const inset = width * 0.25;
      ctx.beginPath();
      ctx.moveTo(x + inset, y);
      ctx.lineTo(x + width - inset, y);
      ctx.lineTo(x + width, y + height / 2);
      ctx.lineTo(x + width - inset, y + height);
      ctx.lineTo(x + inset, y + height);
      ctx.lineTo(x, y + height / 2);
      ctx.closePath();
      return;
    }
    case 'parallelogram': {
      const skew = width * 0.14;
      ctx.beginPath();
      ctx.moveTo(x + skew, y);
      ctx.lineTo(x + width, y);
      ctx.lineTo(x + width - skew, y + height);
      ctx.lineTo(x, y + height);
      ctx.closePath();
      return;
    }
    case 'pill':
      roundedRectPath(ctx, x, y, width, height, height / 2);
      return;
    case 'text':
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      return;
    case 'frame':
    case 'round':
      roundedRectPath(ctx, x, y, width, height, style.radius);
      return;
    default:
      roundedRectPath(ctx, x, y, width, height, style.radius);
  }
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  if (!text) {
    return [];
  }
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const character of Array.from(paragraph)) {
      const candidate = current + character;
      if (current && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = character.trimStart();
      } else {
        current = candidate;
      }
    }
    if (current) {
      lines.push(current);
    }
  }
  return lines;
}

function drawObjectText(
  ctx: CanvasRenderingContext2D,
  node: BoardObject,
  theme: BoardTheme,
): void {
  const style = objectStyle(node);
  const type = normalizeObjectType(node.type);
  if (!node.text) {
    if (type === 'text' || type === 'sticky') {
      ctx.fillStyle = theme.muted;
      ctx.font = `400 ${style.fontSize}px ${theme.fontFamily}`;
      ctx.textBaseline = 'top';
      ctx.fillText(
        type === 'text' ? '双击输入文字' : '双击输入',
        node.x + 10,
        node.y + 9,
      );
    }
    return;
  }
  const padding = type === 'frame' || type === 'text' ? 10 : 12;
  ctx.save();
  traceObjectPath(ctx, node);
  ctx.clip();
  ctx.fillStyle = resolveBoardColor(style.textColor, theme);
  ctx.font = `${style.bold ? 700 : 400} ${style.fontSize}px ${theme.fontFamily}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = style.textAlign;
  const maxWidth = Math.max(8, node.width - padding * 2);
  const lines = wrapText(ctx, node.text, maxWidth);
  const lineHeight = style.fontSize * 1.38;
  const totalHeight = lines.length * lineHeight;
  const alignTop =
    type === 'sticky' ||
    type === 'text' ||
    type === 'frame' ||
    style.textAlign === 'left';
  const startY = alignTop
    ? node.y + padding
    : node.y + Math.max(padding, (node.height - totalHeight) / 2);
  const textX =
    style.textAlign === 'left'
      ? node.x + padding
      : style.textAlign === 'right'
        ? node.x + node.width - padding
        : node.x + node.width / 2;
  ctx.textAlign = style.textAlign;
  lines.forEach((line, index) => {
    ctx.fillText(line, textX, startY + index * lineHeight);
  });
  ctx.restore();
}

function drawLock(ctx: CanvasRenderingContext2D, node: BoardObject, zoom: number, theme: BoardTheme): void {
  if (!objectLocked(node)) {
    return;
  }
  const size = 11 / zoom;
  const x = node.x + node.width - size - 7 / zoom;
  const y = node.y + 6 / zoom;
  ctx.save();
  ctx.strokeStyle = theme.palette['--board-lock'] ?? theme.muted;
  ctx.fillStyle = theme.surface;
  ctx.lineWidth = 1.3 / zoom;
  ctx.beginPath();
  ctx.rect(x, y + size * 0.42, size * 0.86, size * 0.58);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + size * 0.43, y + size * 0.42, size * 0.28, Math.PI, 0);
  ctx.stroke();
  ctx.restore();
}

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  tip: Point,
  tangent: Point,
  color: string,
  size: number,
): void {
  const length = Math.hypot(tangent.x, tangent.y);
  if (length < 0.001) {
    return;
  }
  const ux = tangent.x / length;
  const uy = tangent.y / length;
  const baseX = tip.x - ux * size;
  const baseY = tip.y - uy * size;
  const half = size * 0.46;
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(baseX - uy * half, baseY + ux * half);
  ctx.lineTo(baseX + uy * half, baseY - ux * half);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function traceConnector(
  ctx: CanvasRenderingContext2D,
  geometry: ConnectorGeometry,
): void {
  ctx.beginPath();
  if (geometry.kind === 'curve') {
    const [p0, c1, c2, p3] = geometry.points;
    ctx.moveTo(p0.x, p0.y);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p3.x, p3.y);
    return;
  }
  geometry.points.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
}

function drawConnector(
  ctx: CanvasRenderingContext2D,
  edge: BoardConnector,
  from: BoardObject,
  to: BoardObject,
  selected: boolean,
  zoom: number,
  theme: BoardTheme,
  readOnly: boolean,
): void {
  const style = connectorStyle(edge);
  const color = resolveBoardColor(style.color, theme);
  const geometry = connectorGeometry(edge, from, to);
  const ends = connectorEnds(geometry);
  const inverseZoom = 1 / zoom;

  if (selected) {
    ctx.save();
    traceConnector(ctx, geometry);
    ctx.strokeStyle = theme.accentSoft;
    ctx.lineWidth = style.width + 7 * inverseZoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  traceConnector(ctx, geometry);
  ctx.strokeStyle = selected ? theme.accent : color;
  ctx.lineWidth = selected ? Math.max(2.2, style.width) : style.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (style.dashed) {
    ctx.setLineDash([7 * inverseZoom, 6 * inverseZoom]);
  }
  ctx.stroke();
  ctx.restore();

  const arrowSize = Math.max(7, 7.5 * inverseZoom);
  if (style.arrow === 'end' || style.arrow === 'both') {
    drawArrowhead(ctx, ends.end, ends.endTangent, selected ? theme.accent : color, arrowSize);
  }
  if (style.arrow === 'both') {
    drawArrowhead(ctx, ends.start, ends.startTangent, selected ? theme.accent : color, arrowSize);
  }

  if (edge.label) {
    const point = connectorLabelPoint(geometry);
    const fontSize = 10.5 * inverseZoom;
    ctx.save();
    ctx.font = `500 ${fontSize}px ${theme.fontFamily}`;
    const width = ctx.measureText(edge.label).width + 10 * inverseZoom;
    const height = fontSize + 7 * inverseZoom;
    roundedRectPath(
      ctx,
      point.x - width / 2,
      point.y - height / 2,
      width,
      height,
      4 * inverseZoom,
    );
    ctx.fillStyle = theme.surface;
    ctx.globalAlpha = 0.94;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = theme.line;
    ctx.lineWidth = 0.8 * inverseZoom;
    ctx.stroke();
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(edge.label, point.x, point.y + 0.5 * inverseZoom);
    ctx.restore();
  }

  if (!readOnly && selected) {
    ctx.save();
    ctx.fillStyle = theme.accent;
    for (const point of [ends.start, ends.end]) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3.2 * inverseZoom, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  node: BoardObject,
  theme: BoardTheme,
  options: {
    zoom: number;
    selected: boolean;
    hovered: boolean;
    editing: boolean;
    showShadow: boolean;
  },
): void {
  const style = objectStyle(node);
  const type = normalizeObjectType(node.type);
  const { zoom } = options;
  ctx.save();
  traceObjectPath(ctx, node);
  if (options.showShadow && type !== 'text' && type !== 'frame') {
    ctx.shadowColor = theme.shadow;
    ctx.shadowBlur = 8 / zoom;
    ctx.shadowOffsetY = 2 / zoom;
  }
  if (!isTransparent(style.fill)) {
    ctx.globalAlpha = style.opacity;
    ctx.fillStyle = resolveBoardColor(style.fill, theme);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  if (!isTransparent(style.stroke)) {
    ctx.strokeStyle = resolveBoardColor(style.stroke, theme);
    ctx.lineWidth = BOARD_OBJECT_STROKE_WIDTH;
    ctx.stroke();
  }
  ctx.restore();

  if (!options.editing) {
    drawObjectText(ctx, node, theme);
  }

  const locked = objectLocked(node);
  const stateColor = locked ? theme.muted : theme.accent;

  if (options.hovered && !options.selected) {
    ctx.save();
    traceObjectPath(ctx, node);
    ctx.strokeStyle = stateColor;
    ctx.globalAlpha = 0.42;
    ctx.lineWidth = 1.4 / zoom;
    ctx.stroke();
    ctx.restore();
  }

  if (options.selected) {
    const offset = 3 / zoom;
    ctx.save();
    ctx.strokeStyle = stateColor;
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([4 / zoom, 3 / zoom]);
    ctx.strokeRect(
      node.x - offset,
      node.y - offset,
      node.width + offset * 2,
      node.height + offset * 2,
    );
    ctx.restore();
  }

  drawLock(ctx, node, zoom, theme);
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  view: BoardViewport,
  theme: BoardTheme,
): void {
  const spacing = 20 * view.zoom;
  if (spacing < 6) {
    return;
  }
  const offsetX = -((view.x * view.zoom) % spacing);
  const offsetY = -((view.y * view.zoom) % spacing);
  ctx.save();
  ctx.fillStyle = theme.grid;
  ctx.globalAlpha = 0.52;
  for (let x = offsetX; x < width; x += spacing) {
    for (let y = offsetY; y < height; y += spacing) {
      ctx.beginPath();
      ctx.arc(x, y, 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawBoundary(
  ctx: CanvasRenderingContext2D,
  zoom: number,
  theme: BoardTheme,
): void {
  ctx.save();
  ctx.strokeStyle = theme.lineStrong;
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([10 / zoom, 8 / zoom]);
  ctx.strokeRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
  ctx.restore();
}

function drawSelectionChrome(
  ctx: CanvasRenderingContext2D,
  document: BoardDocument,
  selection: BoardSelection | undefined,
  hoveredNodeId: string | null | undefined,
  zoom: number,
  theme: BoardTheme,
  readOnly: boolean,
): void {
  if (!selection || readOnly) {
    return;
  }
  const selectedIds = new Set(selection.nodeIds);
  const selectedNodes = document.nodes.filter((node) => selectedIds.has(node.id));
  const hovered = hoveredNodeId
    ? document.nodes.find((node) => node.id === hoveredNodeId)
    : null;
  const anchorNodes = new Map<string, BoardObject>();
  for (const node of selectedNodes) {
    anchorNodes.set(node.id, node);
  }
  if (hovered) {
    anchorNodes.set(hovered.id, hovered);
  }

  for (const node of anchorNodes.values()) {
    const locked = objectLocked(node);
    for (const side of ['l', 'r', 't', 'b'] as const) {
      const point = anchorPoint(node, side);
      ctx.save();
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4.3 / zoom, 0, Math.PI * 2);
      ctx.fillStyle = theme.surface;
      ctx.fill();
      ctx.strokeStyle = locked
        ? theme.muted
        : (theme.palette['--board-anchor'] ?? theme.accent);
      ctx.lineWidth = 1.4 / zoom;
      ctx.stroke();
      ctx.restore();
    }
  }

  if (selectedNodes.length !== 1) {
    return;
  }
  const node = selectedNodes[0];
  if (objectLocked(node)) {
    return;
  }

  // SE 缩放手柄：本阶段唯一缩放手柄（不是 8 向）。
  const handleSize = 10 / zoom;
  const handleX = node.x + node.width;
  const handleY = node.y + node.height;
  ctx.save();
  ctx.fillStyle = theme.surface;
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.4 / zoom;
  ctx.fillRect(
    handleX - handleSize / 2,
    handleY - handleSize / 2,
    handleSize,
    handleSize,
  );
  ctx.strokeRect(
    handleX - handleSize / 2,
    handleY - handleSize / 2,
    handleSize,
    handleSize,
  );
  ctx.restore();

  // 四向快捷创建控件（不是旋转/缩放手柄）。
  if (normalizeObjectType(node.type) !== 'frame') {
    for (const side of ['r', 'b', 'l', 't'] as const) {
      const direction = sideDirection(side);
      const anchor = anchorPoint(node, side);
      const point = {
        x: anchor.x + direction.x * (18 / zoom),
        y: anchor.y + direction.y * (18 / zoom),
      };
      ctx.save();
      ctx.beginPath();
      ctx.arc(point.x, point.y, 8 / zoom, 0, Math.PI * 2);
      ctx.fillStyle = theme.accent;
      ctx.fill();
      ctx.strokeStyle = theme.surface;
      ctx.lineWidth = 1.4 / zoom;
      ctx.stroke();
      ctx.strokeStyle = theme.onAccent;
      ctx.lineWidth = 1.4 / zoom;
      ctx.beginPath();
      ctx.moveTo(point.x - 3 / zoom, point.y);
      ctx.lineTo(point.x + 3 / zoom, point.y);
      ctx.moveTo(point.x, point.y - 3 / zoom);
      ctx.lineTo(point.x, point.y + 3 / zoom);
      ctx.stroke();
      ctx.restore();
    }
  }
}

export function paintBoardScene(options: PaintBoardOptions): void {
  const {
    ctx,
    width,
    height,
    dpr,
    document,
    view,
    selection,
    hoveredNodeId,
    editingNodeId,
    marquee,
    pendingConnection,
    theme = FALLBACK_THEME,
    readOnly = false,
    showGrid = true,
    showBoundary = true,
    shadow = true,
    paintBackground = true,
  } = options;

  // backing store 与 CSS 尺寸可能因四舍五入不严格等于 dpr（嵌入预览尤其
  // 明显）；用实际比例而不是假设 dpr，避免亚像素偏移/裁边。
  const backing = ctx.canvas as HTMLCanvasElement | undefined;
  const sx =
    backing && backing.width > 0 && width > 0 ? backing.width / width : dpr;
  const sy =
    backing && backing.height > 0 && height > 0 ? backing.height / height : dpr;
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (paintBackground) {
    ctx.fillStyle = theme.palette['--board-canvas-bg'] ?? theme.surface;
    ctx.fillRect(0, 0, width, height);
  }

  if (showGrid) {
    drawGrid(ctx, width, height, view, theme);
  }

  ctx.save();
  ctx.scale(view.zoom, view.zoom);
  ctx.translate(-view.x, -view.y);

  if (showBoundary) {
    drawBoundary(ctx, view.zoom, theme);
  }

  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const selectedIds = new Set(selection?.nodeIds ?? []);
  const ordered = sortByZ(document.nodes);
  const drawNodeAt = (node: BoardObject) => {
    drawNode(ctx, node, theme, {
      zoom: view.zoom,
      selected: selectedIds.has(node.id),
      hovered: hoveredNodeId === node.id,
      editing: editingNodeId === node.id,
      showShadow: shadow,
    });
  };

  // 容器/泳道先铺底，再画连线，最后画普通对象：
  // 否则有底色的泳道会盖住从便签/节点之间穿过的连线，导出图片尤其明显。
  for (const node of ordered) {
    if (normalizeObjectType(node.type) === 'frame') {
      drawNodeAt(node);
    }
  }

  const selectedEdges = new Set(selection?.edgeIds ?? []);
  for (const edge of document.edges) {
    const from = nodeMap.get(edge.fromNodeId);
    const to = nodeMap.get(edge.toNodeId);
    if (!from || !to) {
      continue;
    }
    drawConnector(
      ctx,
      edge,
      from,
      to,
      selectedEdges.has(edge.id),
      view.zoom,
      theme,
      readOnly,
    );
  }

  for (const node of ordered) {
    if (normalizeObjectType(node.type) !== 'frame') {
      drawNodeAt(node);
    }
  }

  if (pendingConnection) {
    const start = anchorPoint(pendingConnection.from, pendingConnection.side);
    const target = pendingConnection.targetId
      ? nodeMap.get(pendingConnection.targetId)
      : null;
    if (target) {
      ctx.save();
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2 / view.zoom;
      ctx.setLineDash([5 / view.zoom, 4 / view.zoom]);
      ctx.strokeRect(
        target.x - 2 / view.zoom,
        target.y - 2 / view.zoom,
        target.width + 4 / view.zoom,
        target.height + 4 / view.zoom,
      );
      ctx.restore();
    }
    ctx.save();
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.6 / view.zoom;
    ctx.setLineDash([6 / view.zoom, 5 / view.zoom]);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(pendingConnection.to.x, pendingConnection.to.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(pendingConnection.to.x, pendingConnection.to.y, 3.5 / view.zoom, 0, Math.PI * 2);
    ctx.fillStyle = theme.accent;
    ctx.fill();
    ctx.restore();
  }

  drawSelectionChrome(
    ctx,
    document,
    selection,
    hoveredNodeId,
    view.zoom,
    theme,
    readOnly,
  );

  if (marquee) {
    ctx.save();
    ctx.fillStyle = theme.accent;
    ctx.globalAlpha = 0.08;
    ctx.fillRect(marquee.x, marquee.y, marquee.width, marquee.height);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1 / view.zoom;
    ctx.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height);
    ctx.restore();
  }

  ctx.restore();
}

/** 笔记内嵌预览：按内容适配到给定像素尺寸。 */
export function paintBoardThumbnail(
  ctx: CanvasRenderingContext2D,
  document: BoardDocument,
  width: number,
  height: number,
  dpr: number,
  view: BoardViewport,
  theme: BoardTheme,
): void {
  paintBoardScene({
    ctx,
    width,
    height,
    dpr,
    document,
    view,
    theme,
    readOnly: true,
    showGrid: false,
    showBoundary: false,
    shadow: false,
  });
}
