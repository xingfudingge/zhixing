/**
 * 画板纯模型：对象、连线、对齐/分布、复制粘贴、层级、撤销快照与 JSON 解析。
 *
 * 所有函数都不接触 DOM/Canvas，便于单测覆盖；Canvas 只负责命中测试与绘制。
 */

import type { JsonValue } from '../../data/db/types';
import { boardIdFactory } from './ids';
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  GRID_SIZE,
  MAX_ZOOM,
  MIN_OBJECT_HEIGHT,
  MIN_OBJECT_WIDTH,
  MIN_ZOOM,
  type AnchorSide,
  type BoardArrow,
  type BoardClipboard,
  type BoardConnector,
  type BoardConnectorStyle,
  type BoardDocument,
  type BoardJsonObject,
  type BoardObject,
  type BoardObjectStyle,
  type BoardObjectType,
  type BoardRouting,
  type BoardSelection,
  type BoardSnapshot,
  type BoardStarterGroup,
  type BoardStarterKind,
  type BoardStarterTemplate,
  type BoardTextAlign,
  type BoardViewport,
  type IdFactory,
} from './types';

export type BoardDocumentErrorCode = 'json' | 'shape' | 'version' | 'id' | 'edge';

export class BoardDocumentError extends Error {
  readonly code: BoardDocumentErrorCode;

  constructor(message: string, code: BoardDocumentErrorCode = 'shape') {
    super(message);
    this.name = 'BoardDocumentError';
    this.code = code;
  }
}

export type Point = { x: number; y: number };

export type Rect = { x: number; y: number; width: number; height: number };

/** 只需要几何字段的节点；模板源数据与真实对象都能传入。 */
type NodeGeometry = Pick<BoardObject, 'x' | 'y' | 'width' | 'height'>;

export const OBJECT_TYPE_LABELS: Readonly<Record<BoardObjectType, string>> = {
  rect: '矩形',
  round: '圆角矩形',
  ellipse: '椭圆',
  diamond: '菱形',
  text: '文本',
  sticky: '便签',
  frame: '容器',
  triangle: '三角形',
  hexagon: '六边形',
  pill: '胶囊',
  parallelogram: '平行四边形',
};

/** 工具轨常显的 6 类对象 + 连线；容器是对象，不是分组/泳道模式。 */
export const DEFAULT_OBJECT_TYPES: ReadonlyArray<BoardObjectType> = [
  'rect',
  'round',
  'ellipse',
  'text',
  'sticky',
  'frame',
];

/** 「更多形状」只放低频形状，避免工具轨膨胀。 */
export const MORE_OBJECT_TYPES: ReadonlyArray<BoardObjectType> = [
  'diamond',
  'triangle',
  'hexagon',
  'pill',
  'parallelogram',
];

export const OBJECT_TYPE_ORDER: ReadonlyArray<BoardObjectType> = [
  ...DEFAULT_OBJECT_TYPES,
  ...MORE_OBJECT_TYPES,
];

export const SHAPE_SIZES: Readonly<
  Record<BoardObjectType, { width: number; height: number; text: string }>
> = {
  rect: { width: 180, height: 90, text: '' },
  round: { width: 180, height: 90, text: '' },
  ellipse: { width: 160, height: 120, text: '' },
  diamond: { width: 170, height: 110, text: '' },
  text: { width: 220, height: 44, text: '' },
  sticky: { width: 180, height: 120, text: '' },
  frame: { width: 460, height: 280, text: '' },
  triangle: { width: 160, height: 140, text: '' },
  hexagon: { width: 170, height: 110, text: '' },
  pill: { width: 180, height: 60, text: '' },
  parallelogram: { width: 190, height: 80, text: '' },
};

export const OBJECT_FILLS: ReadonlyArray<string> = [
  '#ffffff',
  '#eef8f1',
  '#fff8e9',
  '#f4f0fc',
  '#fdf0ed',
  '#eaf5f4',
  '#e8eefb',
  '#fff7d9',
];

export const OBJECT_STROKES: ReadonlyArray<string> = [
  '#cbd6e2',
  '#86c69d',
  '#e5c477',
  '#cbbce8',
  '#e8c4b3',
  '#a9cfcd',
  '#9bbca5',
  '#7f8c9f',
];

export const OBJECT_TEXT_COLORS: ReadonlyArray<string> = [
  '#34424b',
  '#5579d5',
  '#8066c7',
  '#b1584e',
  '#2f7e63',
  '#7f8999',
];

export const CONNECTOR_COLORS: ReadonlyArray<string> = [
  '#9fb0c2',
  '#5579d5',
  '#8066c7',
  '#d97664',
  '#3a9b9a',
  '#d89338',
  '#2f9e73',
  '#5c6877',
];

/**
 * 画板默认样式的语义颜色令牌。
 *
 * 文档里存的是 `var(--board-*)` 引用而不是 hex：Canvas2D 绘制前从当前主题的
 * computed style 里解析，所以切换浅色/暗色、强调色时默认对象会一起变化；
 * 用户手动改过的颜色仍是 hex，渲染时原样保留。
 */
export const BOARD_THEME_TOKENS = {
  rectFill: 'var(--board-rect-fill)',
  rectStroke: 'var(--board-rect-stroke)',
  rectText: 'var(--board-rect-text)',
  /** 容器保持透明底，内部连线不会被底色遮挡。 */
  frameFill: 'var(--board-frame-fill)',
  frameStroke: 'var(--board-frame-stroke)',
  frameText: 'var(--board-frame-text)',
  stickyFill: 'var(--board-sticky-fill)',
  stickyStroke: 'var(--board-sticky-stroke)',
  stickyText: 'var(--board-sticky-text)',
  diamondFill: 'var(--board-diamond-fill)',
  diamondStroke: 'var(--board-diamond-stroke)',
  diamondText: 'var(--board-diamond-text)',
  neutralFill: 'var(--board-neutral-fill)',
  neutralStroke: 'var(--board-neutral-stroke)',
  neutralText: 'var(--board-neutral-text)',
  pillFill: 'var(--board-pill-fill)',
  pillStroke: 'var(--board-pill-stroke)',
  pillText: 'var(--board-pill-text)',
  accentFill: 'var(--board-accent-fill)',
  accentStroke: 'var(--board-accent-stroke)',
  violetFill: 'var(--board-violet-fill)',
  violetStroke: 'var(--board-violet-stroke)',
  tealFill: 'var(--board-teal-fill)',
  tealStroke: 'var(--board-teal-stroke)',
  coralFill: 'var(--board-coral-fill)',
  coralStroke: 'var(--board-coral-stroke)',
  text: 'var(--board-text)',
  connector: 'var(--board-connector)',
  /** 实心蓝点/强调线；模板里的时间线节点使用。 */
  anchor: 'var(--board-anchor)',
  /** 与画布同色，用来给时间线圆点描一圈“挖空”边。 */
  canvas: 'var(--board-canvas-bg)',
  // 旧文档样式兼容：process/start/decision 已不是对象类型，但旧 payload
  // 里保存的令牌仍需能解析，避免刷新后颜色丢失。
  decisionFill: 'var(--board-decision-fill)',
  decisionStroke: 'var(--board-decision-stroke)',
  decisionText: 'var(--board-decision-text)',
  processFill: 'var(--board-process-fill)',
  processStroke: 'var(--board-process-stroke)',
  processText: 'var(--board-process-text)',
  startFill: 'var(--board-start-fill)',
  startStroke: 'var(--board-start-stroke)',
  startText: 'var(--board-start-text)',
} as const;

/** 统一的默认字号/圆角/描边，起步结构与新插入对象共用。 */
export const BOARD_OBJECT_FONT_SIZE = 12;
export const BOARD_OBJECT_STROKE_WIDTH = 1.25;

type TypeDefaultStyle = {
  fill: string;
  stroke: string;
  textColor: string;
  fontSize: number;
  radius: number;
  align: BoardTextAlign;
  bold?: boolean;
};

const TYPE_DEFAULT_STYLE: Readonly<Record<BoardObjectType, TypeDefaultStyle>> = {
  rect: {
    fill: BOARD_THEME_TOKENS.rectFill,
    stroke: BOARD_THEME_TOKENS.rectStroke,
    textColor: BOARD_THEME_TOKENS.rectText,
    fontSize: BOARD_OBJECT_FONT_SIZE,
    radius: 8,
    align: 'center',
  },
  round: {
    fill: BOARD_THEME_TOKENS.accentFill,
    stroke: BOARD_THEME_TOKENS.accentStroke,
    textColor: BOARD_THEME_TOKENS.text,
    fontSize: BOARD_OBJECT_FONT_SIZE,
    radius: 18,
    align: 'center',
  },
  ellipse: {
    fill: BOARD_THEME_TOKENS.violetFill,
    stroke: BOARD_THEME_TOKENS.violetStroke,
    textColor: BOARD_THEME_TOKENS.text,
    fontSize: BOARD_OBJECT_FONT_SIZE,
    radius: 0,
    align: 'center',
  },
  diamond: {
    fill: BOARD_THEME_TOKENS.diamondFill,
    stroke: BOARD_THEME_TOKENS.diamondStroke,
    textColor: BOARD_THEME_TOKENS.diamondText,
    fontSize: BOARD_OBJECT_FONT_SIZE,
    radius: 0,
    align: 'center',
  },
  text: {
    fill: 'transparent',
    stroke: 'transparent',
    textColor: BOARD_THEME_TOKENS.text,
    fontSize: 14,
    radius: 0,
    align: 'left',
  },
  sticky: {
    fill: BOARD_THEME_TOKENS.stickyFill,
    stroke: BOARD_THEME_TOKENS.stickyStroke,
    textColor: BOARD_THEME_TOKENS.stickyText,
    fontSize: BOARD_OBJECT_FONT_SIZE,
    radius: 6,
    align: 'left',
  },
  frame: {
    fill: BOARD_THEME_TOKENS.frameFill,
    stroke: BOARD_THEME_TOKENS.frameStroke,
    textColor: BOARD_THEME_TOKENS.frameText,
    fontSize: BOARD_OBJECT_FONT_SIZE,
    radius: 10,
    align: 'left',
    bold: true,
  },
  triangle: {
    fill: BOARD_THEME_TOKENS.coralFill,
    stroke: BOARD_THEME_TOKENS.coralStroke,
    textColor: BOARD_THEME_TOKENS.text,
    fontSize: BOARD_OBJECT_FONT_SIZE,
    radius: 0,
    align: 'center',
  },
  hexagon: {
    fill: BOARD_THEME_TOKENS.tealFill,
    stroke: BOARD_THEME_TOKENS.tealStroke,
    textColor: BOARD_THEME_TOKENS.text,
    fontSize: BOARD_OBJECT_FONT_SIZE,
    radius: 0,
    align: 'center',
  },
  pill: {
    fill: BOARD_THEME_TOKENS.pillFill,
    stroke: BOARD_THEME_TOKENS.pillStroke,
    textColor: BOARD_THEME_TOKENS.pillText,
    fontSize: BOARD_OBJECT_FONT_SIZE,
    radius: 999,
    align: 'center',
  },
  parallelogram: {
    fill: BOARD_THEME_TOKENS.neutralFill,
    stroke: BOARD_THEME_TOKENS.neutralStroke,
    textColor: BOARD_THEME_TOKENS.neutralText,
    fontSize: BOARD_OBJECT_FONT_SIZE,
    radius: 0,
    align: 'center',
  },
};

const KNOWN_TYPES = new Set<string>(Object.keys(OBJECT_TYPE_LABELS));

/** 旧版本对象类型 → 当前中性类型；只改类型名，几何/文字/样式/连线不动。 */
const LEGACY_OBJECT_TYPES: Readonly<Record<string, BoardObjectType>> = {
  process: 'rect',
  start: 'pill',
  decision: 'diamond',
  circle: 'ellipse',
};

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** 只接受内部语义令牌，避免把任意 CSS 注入到 Canvas fillStyle。 */
const THEME_COLOR = /^var\(\s*--board-[a-z0-9-]+\s*\)$/i;

export function isBoardObjectType(value: string): value is BoardObjectType {
  return KNOWN_TYPES.has(value);
}

export function isLegacyObjectType(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(LEGACY_OBJECT_TYPES, value.trim())
  );
}

export function normalizeObjectType(value: unknown): BoardObjectType {
  const type = typeof value === 'string' ? value.trim() : '';
  if (isBoardObjectType(type)) {
    return type;
  }
  return LEGACY_OBJECT_TYPES[type] ?? 'rect';
}

/**
 * 加载旧文档时把旧类型归一为新语义，返回新文档（无变化时返回原对象）。
 * 文字、几何、样式、锁定与连线保持原样，下一次保存自然写回新类型。
 */
export function normalizeBoardDocument(document: BoardDocument): BoardDocument {
  let changed = false;
  const nodes = document.nodes.map((node) => {
    const type = normalizeObjectType(node.type);
    if (type === node.type) {
      return node;
    }
    changed = true;
    return { ...node, type };
  });
  return changed ? { ...document, nodes } : document;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== null
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundGeometry(value: number): number {
  return Math.round(value * 100) / 100;
}

export function normalizeColor(value: unknown, fallback: string): string {
  if (value === 'transparent') {
    return value;
  }
  if (typeof value !== 'string') {
    return fallback;
  }
  const color = value.trim();
  if (HEX_COLOR.test(color)) {
    return color.toLowerCase();
  }
  // 主题令牌保留原样，由 Canvas 渲染层按当前主题解析。
  if (THEME_COLOR.test(color)) {
    return color.toLowerCase();
  }
  return fallback;
}

function normalizeAlign(value: unknown, fallback: BoardTextAlign): BoardTextAlign {
  return value === 'left' || value === 'center' || value === 'right'
    ? value
    : fallback;
}

function normalizeJsonObject(value: unknown): BoardJsonObject {
  return isPlainObject(value) ? (value as BoardJsonObject) : {};
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function defaultObjectStyle(type: string): BoardObjectStyle {
  const normalized = normalizeObjectType(type);
  const colors = TYPE_DEFAULT_STYLE[normalized];
  return {
    fill: colors.fill,
    stroke: colors.stroke,
    textColor: colors.textColor,
    fontSize: colors.fontSize,
    bold: colors.bold === true,
    textAlign: colors.align,
    radius: colors.radius,
    opacity: 1,
  };
}

export function objectStyle(object: BoardObject): BoardObjectStyle {
  const defaults = defaultObjectStyle(object.type);
  const rawStyle = isPlainObject(object.payload.style)
    ? object.payload.style
    : {};
  const fontSize = isFiniteNumber(rawStyle.fontSize)
    ? clamp(rawStyle.fontSize, 9, 32)
    : defaults.fontSize;
  return {
    fill: normalizeColor(rawStyle.fill, defaults.fill),
    stroke: normalizeColor(rawStyle.stroke, defaults.stroke),
    textColor: normalizeColor(rawStyle.textColor, defaults.textColor),
    fontSize,
    bold: rawStyle.bold === true,
    textAlign: normalizeAlign(rawStyle.textAlign, defaults.textAlign),
    radius: isFiniteNumber(rawStyle.radius)
      ? clamp(rawStyle.radius, 0, 999)
      : defaults.radius,
    opacity: isFiniteNumber(rawStyle.opacity)
      ? clamp(rawStyle.opacity, 0.1, 1)
      : defaults.opacity,
  };
}

export function withObjectStyle(
  object: BoardObject,
  patch: Partial<BoardObjectStyle>,
): BoardObject {
  const style = { ...objectStyle(object), ...patch };
  const rawStyle = isPlainObject(object.payload.style)
    ? object.payload.style
    : {};
  return {
    ...object,
    payload: {
      ...object.payload,
      style: { ...rawStyle, ...style } as BoardJsonObject,
    },
  };
}

export function objectLocked(object: BoardObject): boolean {
  return object.payload.locked === true;
}

export function withObjectLocked(
  object: BoardObject,
  locked: boolean,
): BoardObject {
  return {
    ...object,
    payload: { ...object.payload, locked },
  };
}

export function connectorStyle(edge: BoardConnector): BoardConnectorStyle {
  const raw = edge.style;
  const routing: BoardRouting =
    raw.routing === 'straight' || raw.routing === 'elbow' || raw.routing === 'curve'
      ? raw.routing
      : 'curve';
  const arrow: BoardArrow =
    raw.arrow === 'none' || raw.arrow === 'both' || raw.arrow === 'end'
      ? raw.arrow
      : 'end';
  const side = (value: unknown, fallback: AnchorSide): AnchorSide =>
    value === 'l' || value === 'r' || value === 't' || value === 'b'
      ? value
      : fallback;
  return {
    routing,
    arrow,
    color: normalizeColor(raw.color, BOARD_THEME_TOKENS.connector),
    width: isFiniteNumber(raw.width) ? clamp(raw.width, 1, 8) : 1.5,
    dashed: raw.dashed === true,
    fromSide: side(raw.fromSide, 'r'),
    toSide: side(raw.toSide, 'l'),
  };
}

export function withConnectorStyle(
  edge: BoardConnector,
  patch: Partial<BoardConnectorStyle>,
): BoardConnector {
  return {
    ...edge,
    style: { ...edge.style, ...connectorStyle(edge), ...patch } as BoardJsonObject,
  };
}

export function snapshotOf(document: BoardDocument): BoardSnapshot {
  return cloneJson({
    title: document.title,
    nodes: document.nodes,
    edges: document.edges,
  });
}

export function createEmptyDocument(input: {
  boardId: string;
  noteId?: string | null;
  title?: string;
  background?: string;
}): BoardDocument {
  return {
    version: 1,
    boardId: input.boardId,
    noteId: input.noteId ?? null,
    title: input.title?.trim() || '未命名画板',
    background: input.background || 'dot',
    nodes: [],
    edges: [],
  };
}

export function sortByZ(nodes: ReadonlyArray<BoardObject>): BoardObject[] {
  return [...nodes].sort((a, b) => a.zIndex - b.zIndex);
}

function normalizeZ(nodes: ReadonlyArray<BoardObject>): BoardObject[] {
  return sortByZ(nodes).map((node, index) =>
    node.zIndex === index ? node : { ...node, zIndex: index },
  );
}

function nextZ(nodes: ReadonlyArray<BoardObject>): number {
  return nodes.reduce((max, node) => Math.max(max, node.zIndex), -1) + 1;
}

function minZ(nodes: ReadonlyArray<BoardObject>): number {
  return nodes.reduce((min, node) => Math.min(min, node.zIndex), 0);
}

export function createObject(
  type: string,
  point: Point,
  options: {
    idFactory?: IdFactory;
    text?: string;
    width?: number;
    height?: number;
    zIndex?: number;
  } = {},
): BoardObject {
  const normalizedType = normalizeObjectType(type);
  const size = SHAPE_SIZES[normalizedType];
  const width = Math.max(MIN_OBJECT_WIDTH, options.width ?? size.width);
  const height = Math.max(MIN_OBJECT_HEIGHT, options.height ?? size.height);
  const x = clamp(
    Math.round(point.x - width / 2),
    -BOARD_WIDTH,
    BOARD_WIDTH * 2,
  );
  const y = clamp(
    Math.round(point.y - height / 2),
    -BOARD_HEIGHT,
    BOARD_HEIGHT * 2,
  );
  const idFactory = options.idFactory ?? boardIdFactory;
  return {
    id: idFactory('node'),
    type: normalizedType,
    x,
    y,
    width,
    height,
    rotation: 0,
    zIndex: options.zIndex ?? 0,
    text: options.text ?? size.text,
    payload: {
      style: defaultObjectStyle(normalizedType) as unknown as JsonValue,
      locked: false,
    },
  };
}

export function addObject(
  document: BoardDocument,
  type: string,
  point: Point,
  options: { idFactory?: IdFactory } = {},
): { document: BoardDocument; nodeId: string } {
  const normalizedType = normalizeObjectType(type);
  const zIndex =
    normalizedType === 'frame'
      ? minZ(document.nodes) - 1
      : nextZ(document.nodes);
  const node = createObject(type, point, {
    idFactory: options.idFactory,
    zIndex,
  });
  return {
    document: {
      ...document,
      nodes: normalizeZ([...document.nodes, node]),
    },
    nodeId: node.id,
  };
}

export function setObjectText(
  document: BoardDocument,
  nodeId: string,
  text: string,
): BoardDocument {
  const node = document.nodes.find((item) => item.id === nodeId);
  if (!node || node.text === text) {
    return document;
  }
  return {
    ...document,
    nodes: document.nodes.map((item) =>
      item.id === nodeId ? { ...item, text } : item,
    ),
  };
}

export function setObjectType(
  document: BoardDocument,
  nodeIds: ReadonlyArray<string>,
  type: string,
): BoardDocument {
  const ids = new Set(nodeIds);
  const normalized = normalizeObjectType(type);
  if (!document.nodes.some((node) => ids.has(node.id) && node.type !== normalized)) {
    return document;
  }
  return {
    ...document,
    nodes: document.nodes.map((node) =>
      ids.has(node.id) ? { ...node, type: normalized } : node,
    ),
  };
}

export function moveObjects(
  document: BoardDocument,
  nodeIds: ReadonlyArray<string>,
  dx: number,
  dy: number,
  options: { snap?: boolean; clampToBoard?: boolean } = {},
): BoardDocument {
  const ids = new Set(nodeIds);
  const snap = options.snap ?? true;
  const clampToBoard = options.clampToBoard ?? true;
  let changed = false;
  const nodes = document.nodes.map((node) => {
    if (!ids.has(node.id) || objectLocked(node)) {
      return node;
    }
    const nextX = node.x + dx;
    const nextY = node.y + dy;
    const x = clampToBoard
      ? clamp(nextX, 0, BOARD_WIDTH - node.width)
      : nextX;
    const y = clampToBoard
      ? clamp(nextY, 0, BOARD_HEIGHT - node.height)
      : nextY;
    const snappedX = snap ? Math.round(x / GRID_SIZE) * GRID_SIZE : Math.round(x);
    const snappedY = snap ? Math.round(y / GRID_SIZE) * GRID_SIZE : Math.round(y);
    if (snappedX === node.x && snappedY === node.y) {
      return node;
    }
    changed = true;
    return { ...node, x: snappedX, y: snappedY };
  });
  return changed ? { ...document, nodes } : document;
}

export function resizeObject(
  document: BoardDocument,
  nodeId: string,
  width: number,
  height: number,
): BoardDocument {
  const node = document.nodes.find((item) => item.id === nodeId);
  if (!node || objectLocked(node)) {
    return document;
  }
  const nextWidth = Math.round(
    clamp(width, MIN_OBJECT_WIDTH, BOARD_WIDTH - node.x),
  );
  const nextHeight = Math.round(
    clamp(height, MIN_OBJECT_HEIGHT, BOARD_HEIGHT - node.y),
  );
  if (nextWidth === node.width && nextHeight === node.height) {
    return document;
  }
  return {
    ...document,
    nodes: document.nodes.map((item) =>
      item.id === nodeId
        ? { ...item, width: nextWidth, height: nextHeight }
        : item,
    ),
  };
}

export function deleteObjects(
  document: BoardDocument,
  selection: BoardSelection,
): BoardDocument {
  const ids = new Set(selection.nodeIds);
  const edgeIds = new Set(selection.edgeIds);
  if (ids.size === 0 && edgeIds.size === 0) {
    return document;
  }
  return {
    ...document,
    nodes: document.nodes.filter((node) => !ids.has(node.id)),
    edges: document.edges.filter(
      (edge) =>
        !edgeIds.has(edge.id) &&
        !ids.has(edge.fromNodeId) &&
        !ids.has(edge.toNodeId),
    ),
  };
}

export type AlignMode =
  | 'left'
  | 'hcenter'
  | 'right'
  | 'top'
  | 'vcenter'
  | 'bottom';

export function alignObjects(
  document: BoardDocument,
  nodeIds: ReadonlyArray<string>,
  mode: AlignMode,
): BoardDocument {
  const ids = new Set(nodeIds);
  const targets = document.nodes.filter(
    (node) => ids.has(node.id) && !objectLocked(node),
  );
  if (targets.length < 2) {
    return document;
  }
  const left = Math.min(...targets.map((node) => node.x));
  const right = Math.max(...targets.map((node) => node.x + node.width));
  const top = Math.min(...targets.map((node) => node.y));
  const bottom = Math.max(...targets.map((node) => node.y + node.height));
  const centerX =
    targets.reduce((sum, node) => sum + node.x + node.width / 2, 0) /
    targets.length;
  const centerY =
    targets.reduce((sum, node) => sum + node.y + node.height / 2, 0) /
    targets.length;
  const targetByMode: Record<AlignMode, (node: BoardObject) => Point> = {
    left: () => ({ x: left, y: 0 }),
    hcenter: (node) => ({ x: centerX - node.width / 2, y: 0 }),
    right: (node) => ({ x: right - node.width, y: 0 }),
    top: () => ({ x: 0, y: top }),
    vcenter: (node) => ({ x: 0, y: centerY - node.height / 2 }),
    bottom: (node) => ({ x: 0, y: bottom - node.height }),
  };
  let changed = false;
  const nodes = document.nodes.map((node) => {
    if (!targets.includes(node)) {
      return node;
    }
    const target = targetByMode[mode](node);
    const x = mode === 'top' || mode === 'vcenter' || mode === 'bottom'
      ? node.x
      : Math.round(target.x);
    const y = mode === 'left' || mode === 'hcenter' || mode === 'right'
      ? node.y
      : Math.round(target.y);
    if (x === node.x && y === node.y) {
      return node;
    }
    changed = true;
    return { ...node, x, y };
  });
  return changed ? { ...document, nodes } : document;
}

export function distributeObjects(
  document: BoardDocument,
  nodeIds: ReadonlyArray<string>,
  axis: 'x' | 'y',
): BoardDocument {
  const ids = new Set(nodeIds);
  const targets = document.nodes
    .filter((node) => ids.has(node.id) && !objectLocked(node))
    .sort((a, b) =>
      axis === 'x'
        ? a.x + a.width / 2 - (b.x + b.width / 2)
        : a.y + a.height / 2 - (b.y + b.height / 2),
    );
  if (targets.length < 3) {
    return document;
  }
  const first = targets[0];
  const last = targets[targets.length - 1];
  if (axis === 'x') {
    const start = first.x;
    const end = last.x + last.width;
    const totalWidth = targets.reduce((sum, node) => sum + node.width, 0);
    const gap = (end - start - totalWidth) / (targets.length - 1);
    let cursor = start;
    const positions = new Map<string, Point>();
    targets.forEach((node, index) => {
      const x = index === 0 ? node.x : Math.round(cursor);
      positions.set(node.id, { x, y: node.y });
      cursor += node.width + gap;
    });
    return {
      ...document,
      nodes: document.nodes.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, x: position.x } : node;
      }),
    };
  }
  const start = first.y;
  const end = last.y + last.height;
  const totalHeight = targets.reduce((sum, node) => sum + node.height, 0);
  const gap = (end - start - totalHeight) / (targets.length - 1);
  let cursor = start;
  const positions = new Map<string, Point>();
  targets.forEach((node, index) => {
    const y = index === 0 ? node.y : Math.round(cursor);
    positions.set(node.id, { x: node.x, y });
    cursor += node.height + gap;
  });
  return {
    ...document,
    nodes: document.nodes.map((node) => {
      const position = positions.get(node.id);
      return position ? { ...node, y: position.y } : node;
    }),
  };
}

export function copyObjects(
  document: BoardDocument,
  nodeIds: ReadonlyArray<string>,
): BoardClipboard {
  const ids = new Set(nodeIds);
  return cloneJson({
    nodes: document.nodes.filter((node) => ids.has(node.id)),
    edges: document.edges.filter(
      (edge) => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId),
    ),
  });
}

export function pasteObjects(
  document: BoardDocument,
  clipboard: BoardClipboard,
  options: { offset?: number; idFactory?: IdFactory } = {},
): { document: BoardDocument; nodeIds: string[] } {
  if (clipboard.nodes.length === 0) {
    return { document, nodeIds: [] };
  }
  const idFactory = options.idFactory ?? boardIdFactory;
  const offset = options.offset ?? 24;
  const idMap = new Map<string, string>();
  const zBase = nextZ(document.nodes);
  const newNodes = clipboard.nodes.map((node, index) => {
    const id = idFactory('node');
    idMap.set(node.id, id);
    return {
      ...cloneJson(node),
      id,
      x: node.x + offset,
      y: node.y + offset,
      zIndex: zBase + index,
    };
  });
  const newEdges = clipboard.edges.map((edge) => ({
    ...cloneJson(edge),
    id: idFactory('edge'),
    fromNodeId: idMap.get(edge.fromNodeId) ?? edge.fromNodeId,
    toNodeId: idMap.get(edge.toNodeId) ?? edge.toNodeId,
  }));
  return {
    document: {
      ...document,
      nodes: normalizeZ([...document.nodes, ...newNodes]),
      edges: [...document.edges, ...newEdges],
    },
    nodeIds: newNodes.map((node) => node.id),
  };
}

export function duplicateObjects(
  document: BoardDocument,
  nodeIds: ReadonlyArray<string>,
  options: { idFactory?: IdFactory } = {},
): { document: BoardDocument; nodeIds: string[] } {
  return pasteObjects(document, copyObjects(document, nodeIds), options);
}

export type BoardLayerDirection = 'front' | 'back' | 'up' | 'down';

/**
 * 层级调整：
 * - front/back：整组移到最上/最下；
 * - up/down：整组相对其它对象上移/下移一层，组内相对顺序不变。
 * 所有分支都重排 zIndex，保证保存重开后层级一致。
 */
export function layerObjects(
  document: BoardDocument,
  nodeIds: ReadonlyArray<string>,
  direction: BoardLayerDirection,
): BoardDocument {
  const ids = new Set(nodeIds);
  if (ids.size === 0) {
    return document;
  }
  const sorted = sortByZ(document.nodes);
  if (!sorted.some((node) => ids.has(node.id))) {
    return document;
  }
  if (direction === 'front' || direction === 'back') {
    const selected = sorted.filter((node) => ids.has(node.id));
    const rest = sorted.filter((node) => !ids.has(node.id));
    const ordered = direction === 'front' ? [...rest, ...selected] : [...selected, ...rest];
    return {
      ...document,
      nodes: ordered.map((node, index) => ({ ...node, zIndex: index })),
    };
  }

  const ordered = [...sorted];
  const selectedIndices = ordered
    .map((node, index) => (ids.has(node.id) ? index : -1))
    .filter((index) => index >= 0);
  const indices =
    direction === 'up' ? [...selectedIndices].reverse() : selectedIndices;
  let changed = false;
  for (const index of indices) {
    if (direction === 'up') {
      let target = index + 1;
      while (target < ordered.length && ids.has(ordered[target].id)) {
        target += 1;
      }
      if (target < ordered.length) {
        [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
        changed = true;
      }
    } else {
      let target = index - 1;
      while (target >= 0 && ids.has(ordered[target].id)) {
        target -= 1;
      }
      if (target >= 0) {
        [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
        changed = true;
      }
    }
  }
  if (!changed) {
    return document;
  }
  return {
    ...document,
    nodes: ordered.map((node, index) => ({ ...node, zIndex: index })),
  };
}

export function setObjectsLocked(
  document: BoardDocument,
  nodeIds: ReadonlyArray<string>,
  locked: boolean,
): BoardDocument {
  const ids = new Set(nodeIds);
  if (!document.nodes.some((node) => ids.has(node.id))) {
    return document;
  }
  return {
    ...document,
    nodes: document.nodes.map((node) =>
      ids.has(node.id) ? withObjectLocked(node, locked) : node,
    ),
  };
}

export function updateObjectsStyle(
  document: BoardDocument,
  nodeIds: ReadonlyArray<string>,
  patch: Partial<BoardObjectStyle>,
): BoardDocument {
  const ids = new Set(nodeIds);
  let changed = false;
  const nodes = document.nodes.map((node) => {
    if (!ids.has(node.id)) {
      return node;
    }
    const next = withObjectStyle(node, patch);
    if (JSON.stringify(next.payload) !== JSON.stringify(node.payload)) {
      changed = true;
      return next;
    }
    return node;
  });
  return changed ? { ...document, nodes } : document;
}

function autoSides(from: NodeGeometry, to: NodeGeometry): [AnchorSide, AnchorSide] {
  if (from.x + from.width <= to.x) {
    return ['r', 'l'];
  }
  if (to.x + to.width <= from.x) {
    return ['l', 'r'];
  }
  if (from.y + from.height <= to.y) {
    return ['b', 't'];
  }
  return ['t', 'b'];
}

export function createConnector(
  document: BoardDocument,
  fromNodeId: string,
  toNodeId: string,
  options: {
    idFactory?: IdFactory;
    label?: string;
    fromSide?: AnchorSide;
    toSide?: AnchorSide;
    routing?: BoardRouting;
  } = {},
): BoardConnector | null {
  if (fromNodeId === toNodeId) {
    return null;
  }
  const from = document.nodes.find((node) => node.id === fromNodeId);
  const to = document.nodes.find((node) => node.id === toNodeId);
  if (!from || !to || objectLocked(from) || objectLocked(to)) {
    return null;
  }
  const [autoFrom, autoTo] = autoSides(from, to);
  const idFactory = options.idFactory ?? boardIdFactory;
  return {
    id: idFactory('edge'),
    fromNodeId,
    toNodeId,
    label: options.label ?? '',
    style: {
      // 流程图/结构图的主场景优先正交折线；直线/曲线由用户或起步结构显式选择。
      routing: options.routing ?? 'elbow',
      arrow: 'end',
      color: BOARD_THEME_TOKENS.connector,
      width: 1.5,
      dashed: false,
      fromSide: options.fromSide ?? autoFrom,
      toSide: options.toSide ?? autoTo,
    },
  };
}

export function addConnector(
  document: BoardDocument,
  fromNodeId: string,
  toNodeId: string,
  options: {
    idFactory?: IdFactory;
    label?: string;
    fromSide?: AnchorSide;
    toSide?: AnchorSide;
  } = {},
): { document: BoardDocument; edgeId: string | null } {
  const connector = createConnector(
    document,
    fromNodeId,
    toNodeId,
    options,
  );
  if (!connector) {
    return { document, edgeId: null };
  }
  return {
    document: { ...document, edges: [...document.edges, connector] },
    edgeId: connector.id,
  };
}

const OPPOSITE_SIDE: Record<AnchorSide, AnchorSide> = {
  l: 'r',
  r: 'l',
  t: 'b',
  b: 't',
};

/**
 * 四向快捷创建：在对象某一侧放一个新矩形，并自动连线。
 * 只创建一个普通对象，不是「模式」或不可编辑模板。
 */
export function addQuickObject(
  document: BoardDocument,
  nodeId: string,
  side: AnchorSide,
  options: { idFactory?: IdFactory } = {},
): { document: BoardDocument; nodeId: string; edgeId: string | null } {
  const source = document.nodes.find((node) => node.id === nodeId);
  if (!source || objectLocked(source)) {
    return { document, nodeId: '', edgeId: null };
  }
  const idFactory = options.idFactory ?? boardIdFactory;
  const width = SHAPE_SIZES.rect.width;
  const height = SHAPE_SIZES.rect.height;
  const gap = 90;
  let x = source.x + source.width / 2 - width / 2;
  let y = source.y + source.height / 2 - height / 2;
  if (side === 'r') {
    x = source.x + source.width + gap;
  } else if (side === 'l') {
    x = source.x - gap - width;
  } else if (side === 'b') {
    y = source.y + source.height + gap;
  } else {
    y = source.y - gap - height;
  }
  const node = createObject(
    'rect',
    { x: x + width / 2, y: y + height / 2 },
    { idFactory, zIndex: nextZ(document.nodes) },
  );
  const withNode: BoardDocument = {
    ...document,
    nodes: normalizeZ([...document.nodes, node]),
  };
  const connected = addConnector(withNode, source.id, node.id, {
    idFactory,
    fromSide: side,
    toSide: OPPOSITE_SIDE[side],
  });
  return {
    document: connected.document,
    nodeId: node.id,
    edgeId: connected.edgeId,
  };
}

export function updateConnectorStyle(
  document: BoardDocument,
  edgeId: string,
  patch: Partial<BoardConnectorStyle>,
): BoardDocument {
  return updateConnectorsStyle(document, [edgeId], patch);
}

/** 批量改线型/箭头/颜色等；一次调用只产生一步撤销。 */
export function updateConnectorsStyle(
  document: BoardDocument,
  edgeIds: ReadonlyArray<string>,
  patch: Partial<BoardConnectorStyle>,
): BoardDocument {
  const ids = new Set(edgeIds);
  if (ids.size === 0) {
    return document;
  }
  let changed = false;
  const edges = document.edges.map((edge) => {
    if (!ids.has(edge.id)) {
      return edge;
    }
    const next = withConnectorStyle(edge, patch);
    if (JSON.stringify(next.style) !== JSON.stringify(edge.style)) {
      changed = true;
      return next;
    }
    return edge;
  });
  return changed ? { ...document, edges } : document;
}

export function setConnectorLabel(
  document: BoardDocument,
  edgeId: string,
  label: string,
): BoardDocument {
  if (!document.edges.some((edge) => edge.id === edgeId && edge.label !== label)) {
    return document;
  }
  return {
    ...document,
    edges: document.edges.map((edge) =>
      edge.id === edgeId ? { ...edge, label } : edge,
    ),
  };
}

export function reverseConnector(
  document: BoardDocument,
  edgeId: string,
): BoardDocument {
  const edge = document.edges.find((item) => item.id === edgeId);
  if (!edge) {
    return document;
  }
  const style = connectorStyle(edge);
  return {
    ...document,
    edges: document.edges.map((item) =>
      item.id === edgeId
        ? {
            ...item,
            fromNodeId: item.toNodeId,
            toNodeId: item.fromNodeId,
            style: {
              ...item.style,
              fromSide: style.toSide,
              toSide: style.fromSide,
            } as BoardJsonObject,
          }
        : item,
    ),
  };
}

export function deleteConnector(
  document: BoardDocument,
  edgeId: string,
): BoardDocument {
  if (!document.edges.some((edge) => edge.id === edgeId)) {
    return document;
  }
  return {
    ...document,
    edges: document.edges.filter((edge) => edge.id !== edgeId),
  };
}

export function documentBounds(
  nodes: ReadonlyArray<NodeGeometry>,
): Rect | null {
  if (nodes.length === 0) {
    return null;
  }
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function selectionBounds(
  document: BoardDocument,
  selection: BoardSelection,
): Rect | null {
  const nodeIds = new Set(selection.nodeIds);
  for (const edgeId of selection.edgeIds) {
    const edge = document.edges.find((item) => item.id === edgeId);
    if (!edge) {
      continue;
    }
    nodeIds.add(edge.fromNodeId);
    nodeIds.add(edge.toNodeId);
  }
  return documentBounds(document.nodes.filter((node) => nodeIds.has(node.id)));
}

export function clampZoom(value: number): number {
  return Math.round(clamp(value, MIN_ZOOM, MAX_ZOOM) * 100) / 100;
}

/**
 * 适配视图：留出固定屏幕边距，把内容放到视口中央。
 * 空画板回到画布中心，缩放 100%。
 */
export function fitViewport(
  nodes: ReadonlyArray<BoardObject>,
  viewportSize: { width: number; height: number },
  padding = 80,
): BoardViewport {
  const width = Math.max(1, viewportSize.width);
  const height = Math.max(1, viewportSize.height);
  const bounds = documentBounds(nodes);
  if (!bounds) {
    return {
      x: BOARD_WIDTH / 2 - width / 2,
      y: BOARD_HEIGHT / 2 - height / 2,
      zoom: 1,
    };
  }
  const safeWidth = Math.max(1, bounds.width);
  const safeHeight = Math.max(1, bounds.height);
  const availableWidth = Math.max(60, width - padding * 2);
  const availableHeight = Math.max(60, height - padding * 2);
  const zoom = clampZoom(
    Math.min(availableWidth / safeWidth, availableHeight / safeHeight, 1.2),
  );
  const centerX = bounds.x + safeWidth / 2;
  const centerY = bounds.y + safeHeight / 2;
  return {
    x: centerX - width / (2 * zoom),
    y: centerY - height / (2 * zoom),
    zoom,
  };
}

export function zoomAtPoint(
  viewport: BoardViewport,
  nextZoom: number,
  screenPoint: Point,
): BoardViewport {
  const zoom = clampZoom(nextZoom);
  const worldX = viewport.x + screenPoint.x / viewport.zoom;
  const worldY = viewport.y + screenPoint.y / viewport.zoom;
  return {
    zoom,
    x: worldX - screenPoint.x / zoom,
    y: worldY - screenPoint.y / zoom,
  };
}

export function screenToWorld(
  viewport: BoardViewport,
  point: Point,
): Point {
  return {
    x: viewport.x + point.x / viewport.zoom,
    y: viewport.y + point.y / viewport.zoom,
  };
}

export function worldToScreen(
  viewport: BoardViewport,
  point: Point,
): Point {
  return {
    x: (point.x - viewport.x) * viewport.zoom,
    y: (point.y - viewport.y) * viewport.zoom,
  };
}

export function roundPoint(point: Point): Point {
  return {
    x: roundGeometry(point.x),
    y: roundGeometry(point.y),
  };
}

// ---------------------------------------------------------------------------
// 起步结构
// ---------------------------------------------------------------------------

type StarterNode = {
  key: string;
  type: BoardObjectType;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  /** 覆盖该对象的默认样式（例如纵向泳道标题顶部居中）。 */
  style?: Partial<BoardObjectStyle>;
};

type StarterEdge = {
  from: string;
  to: string;
  label?: string;
  fromSide?: AnchorSide;
  toSide?: AnchorSide;
  routing?: BoardRouting;
  /** 覆盖默认连线颜色（仍写入普通连线的 style，不是模式字段）。 */
  color?: string;
};

/** 模板弹层的分组顺序与标题；只影响展示。 */
export const STARTER_GROUPS: ReadonlyArray<{
  id: BoardStarterGroup;
  title: string;
}> = [
  { id: 'process', title: '流程与阶段' },
  { id: 'structure', title: '结构与系统' },
  { id: 'thinking', title: '发散与闭环' },
];

/**
 * 模板清单。名称/说明/分组与下方 `starterSource` 的几何一一对应，
 * 弹层与测试都从这里取数，避免 UI 和模型各维护一份。
 */
export const BOARD_STARTERS: ReadonlyArray<BoardStarterTemplate> = [
  {
    kind: 'flow',
    title: '流程图',
    description: '开始 → 步骤 → 判断 → 结束，五条可编辑连线',
    group: 'process',
  },
  {
    kind: 'timeline',
    title: '时间线',
    description: '一条轴 + 五个里程碑，标签上下交错，可直接改字',
    group: 'process',
  },
  {
    kind: 'lane',
    title: '泳道 · 横向',
    description: '3 行阶段容器 + 每行 2 张便签；容器不绑定子对象',
    group: 'process',
  },
  {
    kind: 'lane-vertical',
    title: '泳道 · 纵向',
    description: '3 列阶段容器 + 每列 2 张便签，适合按状态分栏',
    group: 'process',
  },
  {
    kind: 'org',
    title: '组织架构',
    description: '负责人 + 3 个部门 + 6 个小组，九条折线汇报关系',
    group: 'structure',
  },
  {
    kind: 'sys',
    title: '系统架构',
    description: '三层容器 + 九个圆角矩形，层间直线；容器只是对象',
    group: 'structure',
  },
  {
    kind: 'pyramid',
    title: '金字塔',
    description: '四层结构，从战略到动作；宽度递减、居中排布',
    group: 'structure',
  },
  {
    kind: 'mind',
    title: '思维导图',
    description: '中心主题 + 五个分支，曲线连接；插入后可继续发散',
    group: 'thinking',
  },
  {
    kind: 'flywheel',
    title: '增长飞轮',
    description: '五个环节首尾相接，曲线串成闭环；中心是飞轮名',
    group: 'thinking',
  },
];

/**
 * 流程图只是「模板」：插入的是矩形/菱形/胶囊等普通对象，
 * 不写入 process/start/decision 类型，也不带模式字段。
 */
function starterFlow(): { nodes: StarterNode[]; edges: StarterEdge[] } {
  return {
    nodes: [
      { key: 's1', type: 'pill', x: 160, y: 220, width: 130, height: 54, text: '开始' },
      { key: 's2', type: 'rect', x: 360, y: 218, width: 170, height: 58, text: '收集信息' },
      { key: 's3', type: 'diamond', x: 600, y: 205, width: 170, height: 84, text: '是否值得做？' },
      { key: 's4', type: 'rect', x: 850, y: 130, width: 170, height: 58, text: '拆解任务' },
      { key: 's5', type: 'rect', x: 850, y: 310, width: 170, height: 58, text: '归档暂缓' },
      { key: 's6', type: 'pill', x: 1120, y: 218, width: 130, height: 54, text: '结束' },
    ],
    edges: [
      { from: 's1', to: 's2' },
      { from: 's2', to: 's3' },
      { from: 's3', to: 's4', label: '是' },
      { from: 's3', to: 's5', label: '否' },
      { from: 's4', to: 's6' },
    ],
  };
}

/**
 * 思维导图：中心椭圆 + 5 个圆角分支，曲线从中心四向发散。
 * 坐标来自《画板自由画布规范》§5.3（原型已确认）。
 */
function starterMind(): StarterSource {
  return {
    nodes: [
      { key: 'mind-c', type: 'ellipse', x: 300, y: 185, width: 180, height: 110, text: '画板', style: { fontSize: 15, bold: true } },
      { key: 'mind-1', type: 'round', x: 560, y: 80, width: 150, height: 50, text: '对象' },
      { key: 'mind-2', type: 'round', x: 560, y: 300, width: 150, height: 50, text: '连线' },
      { key: 'mind-3', type: 'round', x: 30, y: 80, width: 150, height: 50, text: '模板' },
      { key: 'mind-4', type: 'round', x: 30, y: 300, width: 150, height: 50, text: '嵌入' },
      { key: 'mind-5', type: 'round', x: 315, y: -40, width: 150, height: 50, text: '导出' },
    ],
    edges: [
      { from: 'mind-c', to: 'mind-1', fromSide: 'r', toSide: 'l', routing: 'curve' },
      { from: 'mind-c', to: 'mind-2', fromSide: 'r', toSide: 'l', routing: 'curve' },
      { from: 'mind-c', to: 'mind-3', fromSide: 'l', toSide: 'r', routing: 'curve' },
      { from: 'mind-c', to: 'mind-4', fromSide: 'l', toSide: 'r', routing: 'curve' },
      { from: 'mind-c', to: 'mind-5', fromSide: 't', toSide: 'b', routing: 'curve' },
    ],
  };
}

/**
 * 时间线：一条 760×6 的轴 + 5 个圆点 + 上下交错标签 + 标题（12 个对象）。
 * 坐标来自《画板自由画布规范》§5.3。
 */
function starterTimeline(): StarterSource {
  const labels = ['立项', '设计', '开发', '内测', '发布'];
  const nodes: StarterNode[] = [
    {
      key: 'tl-axis',
      type: 'rect',
      x: 0,
      y: 120,
      width: 760,
      height: 6,
      text: '',
      style: {
        fill: BOARD_THEME_TOKENS.neutralStroke,
        stroke: 'transparent',
        radius: 3,
      },
    },
  ];
  labels.forEach((label, index) => {
    const x = 36 + index * 170;
    nodes.push(
      {
        key: `tl-dot-${index}`,
        type: 'ellipse',
        x,
        y: 111,
        width: 24,
        height: 24,
        text: '',
        style: {
          fill: BOARD_THEME_TOKENS.anchor,
          stroke: BOARD_THEME_TOKENS.canvas,
          radius: 0,
        },
      },
      {
        key: `tl-label-${index}`,
        type: 'text',
        x: x - 50,
        y: index % 2 === 0 ? 44 : 160,
        width: 124,
        height: 30,
        text: label,
        style: { fontSize: 13, textAlign: 'center' },
      },
    );
  });
  nodes.push({
    key: 'tl-title',
    type: 'text',
    x: 0,
    y: -16,
    width: 300,
    height: 34,
    text: '时间线 · 2026 Q4',
    style: { fontSize: 15, bold: true, textAlign: 'left' },
  });
  return { nodes, edges: [] };
}

/** 组织架构：1 负责人 + 3 部门 + 6 小组，9 条折线汇报关系。 */
function starterOrg(): StarterSource {
  const departments = ['产品', '设计', '工程'];
  const teams = ['用户研究', '路线规划', '交互', '视觉', '前端', '后端'];
  return {
    nodes: [
      { key: 'org-root', type: 'round', x: 330, y: 0, width: 180, height: 56, text: '负责人' },
      ...departments.map((text, index) => ({
        key: `org-dept-${index}`,
        type: 'rect' as const,
        x: 60 + index * 250,
        y: 120,
        width: 180,
        height: 52,
        text,
      })),
      ...teams.map((text, index) => ({
        key: `org-team-${index}`,
        type: 'rect' as const,
        x: 20 + index * 130,
        y: 244,
        width: 110,
        height: 48,
        text,
        style: { fontSize: 12 },
      })),
    ],
    edges: [
      ...departments.map((_, index) => ({
        from: 'org-root',
        to: `org-dept-${index}`,
        fromSide: 'b' as const,
        toSide: 't' as const,
        routing: 'elbow' as const,
      })),
      ...teams.map((_, index) => ({
        from: `org-dept-${Math.floor(index / 2)}`,
        to: `org-team-${index}`,
        fromSide: 'b' as const,
        toSide: 't' as const,
        routing: 'elbow' as const,
      })),
    ],
  };
}

/** 系统架构：3 个横向容器 × 每层 3 个圆角矩形，层间直线（6 条）。 */
function starterSys(): StarterSource {
  const layers = ['接入层', '服务层', '数据层'];
  const blocks = [
    '桌面端',
    'Web 端',
    '移动端',
    'API',
    '同步',
    '授权',
    'PostgreSQL',
    'MinIO',
    '备份',
  ];
  return {
    nodes: [
      ...layers.map((text, index) => ({
        key: `sys-frame-${index}`,
        type: 'frame' as const,
        x: 0,
        y: index * 160,
        width: 760,
        height: 120,
        text,
        style: { fontSize: 12, textAlign: 'left' as const },
      })),
      ...blocks.map((text, index) => {
        const row = Math.floor(index / 3);
        const col = index % 3;
        return {
          key: `sys-node-${index}`,
          type: 'round' as const,
          x: 30 + col * 250,
          y: row * 160 + 44,
          width: 200,
          height: 56,
          text,
        };
      }),
    ],
    edges: [0, 1, 2].flatMap((index) => [
      {
        from: `sys-node-${index}`,
        to: `sys-node-${index + 3}`,
        fromSide: 'b' as const,
        toSide: 't' as const,
        routing: 'straight' as const,
      },
      {
        from: `sys-node-${index + 3}`,
        to: `sys-node-${index + 6}`,
        fromSide: 'b' as const,
        toSide: 't' as const,
        routing: 'straight' as const,
      },
    ]),
  };
}

/** 金字塔：4 层矩形，宽度 600/460/320/180，全部以 x=380 居中。 */
function starterPyramid(): StarterSource {
  return {
    nodes: [
      { key: 'py-1', type: 'rect', x: 80, y: 0, width: 600, height: 64, text: '战略', style: { fontSize: 15, bold: true } },
      {
        key: 'py-2',
        type: 'rect',
        x: 150,
        y: 76,
        width: 460,
        height: 64,
        text: '目标',
        style: {
          fill: BOARD_THEME_TOKENS.accentFill,
          stroke: BOARD_THEME_TOKENS.accentStroke,
        },
      },
      {
        key: 'py-3',
        type: 'rect',
        x: 220,
        y: 152,
        width: 320,
        height: 64,
        text: '执行',
        style: {
          fill: BOARD_THEME_TOKENS.tealFill,
          stroke: BOARD_THEME_TOKENS.tealStroke,
        },
      },
      {
        key: 'py-4',
        type: 'rect',
        x: 290,
        y: 228,
        width: 180,
        height: 64,
        text: '动作',
        style: {
          fill: BOARD_THEME_TOKENS.stickyFill,
          stroke: BOARD_THEME_TOKENS.stickyStroke,
        },
      },
    ],
    edges: [],
  };
}

/**
 * 增长飞轮：5 个胶囊按 72° 均布在半径 210 的圆上，中心是飞轮名；
 * 5 条曲线首尾相接。计算保留原型坐标，保证预览与插入结果一致。
 */
function starterFlywheel(): StarterSource {
  const cx = 380;
  const cy = 240;
  const radius = 210;
  const labels = ['获客', '激活', '留存', '收入', '推荐'];
  return {
    nodes: [
      {
        key: 'fw-c',
        type: 'text',
        x: cx - 90,
        y: cy - 20,
        width: 180,
        height: 40,
        text: '增长飞轮',
        style: { fontSize: 16, bold: true, textAlign: 'center' },
      },
      ...labels.map((text, index) => {
        const angle = ((-90 + index * 72) * Math.PI) / 180;
        return {
          key: `fw-${index}`,
          type: 'pill' as const,
          x: Math.round(cx + Math.cos(angle) * radius - 75),
          y: Math.round(cy + Math.sin(angle) * radius - 27),
          width: 150,
          height: 54,
          text,
          style: {
            fill: BOARD_THEME_TOKENS.tealFill,
            stroke: BOARD_THEME_TOKENS.tealStroke,
          },
        };
      }),
    ],
    edges: labels.map((_, index) => ({
      from: `fw-${index}`,
      to: `fw-${(index + 1) % labels.length}`,
      routing: 'curve' as const,
      color: BOARD_THEME_TOKENS.tealStroke,
    })),
  };
}

/** 横向泳道：3 行 880×140 容器，每行 2 张 180×76 便签。 */
function starterLaneHorizontal(): StarterSource {
  const frames = [
    { text: '市场', y: 0 },
    { text: '产品', y: 150 },
    { text: '研发', y: 300 },
  ];
  return {
    nodes: [
      ...frames.map((frame, index) => ({
        key: `lane-h-frame-${index}`,
        type: 'frame' as const,
        x: 0,
        y: frame.y,
        width: 880,
        height: 140,
        text: frame.text,
        style: { fontSize: 12, bold: true, textAlign: 'left' as const },
      })),
      ...Array.from({ length: 6 }, (_, index) => {
        const lane = Math.floor(index / 2);
        const col = index % 2;
        return {
          key: `lane-h-sticky-${index}`,
          type: 'sticky' as const,
          x: 210 + col * 300,
          y: lane * 150 + 34,
          width: 180,
          height: 76,
          text: col === 0 ? '待验证' : '已就绪',
          style: { fontSize: 12 },
        };
      }),
    ],
    edges: [],
  };
}

/** 纵向泳道：3 列 280×420 容器，每列 2 张 220×100 便签。 */
function starterLaneVertical(): StarterSource {
  const frames = ['待办', '进行中', '已完成'];
  return {
    nodes: [
      ...frames.map((text, index) => ({
        key: `lane-v-frame-${index}`,
        type: 'frame' as const,
        x: index * 300,
        y: 0,
        width: 280,
        height: 420,
        text,
        style: { fontSize: 12, bold: true, textAlign: 'left' as const },
      })),
      ...Array.from({ length: 6 }, (_, index) => {
        const col = Math.floor(index / 2);
        const row = index % 2;
        return {
          key: `lane-v-sticky-${index}`,
          type: 'sticky' as const,
          x: col * 300 + 30,
          y: 74 + row * 160,
          width: 220,
          height: 100,
          text: row === 0 ? '这一列的第一张卡' : '这一列的第二张卡',
          style: { fontSize: 12 },
        };
      }),
    ],
    edges: [],
  };
}

type StarterSource = { nodes: StarterNode[]; edges: StarterEdge[] };

function starterSource(kind: BoardStarterKind): StarterSource {
  switch (kind) {
    case 'timeline':
      return starterTimeline();
    case 'org':
      return starterOrg();
    case 'sys':
      return starterSys();
    case 'mind':
      return starterMind();
    case 'pyramid':
      return starterPyramid();
    case 'flywheel':
      return starterFlywheel();
    case 'lane':
      return starterLaneHorizontal();
    case 'lane-vertical':
      return starterLaneVertical();
    case 'flow':
    default:
      return starterFlow();
  }
}

/** 模板弹层缩略图所需的只读几何；与真正插入的对象同源。 */
export type StarterPreviewNode = {
  key: string;
  type: BoardObjectType;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  style: BoardObjectStyle;
};

export type StarterPreviewEdge = {
  from: string;
  to: string;
  routing: BoardRouting;
  fromSide: AnchorSide;
  toSide: AnchorSide;
  color: string;
};

export type StarterPreview = {
  nodes: StarterPreviewNode[];
  edges: StarterPreviewEdge[];
  bounds: Rect;
};

/**
 * 生成模板预览数据：默认样式 + 显式覆盖，连线端点/方位按真实插入规则
 * （显式优先，否则 `autoSides`）解析。缩略图因此不会和插入结果走样。
 */
export function starterPreview(kind: BoardStarterKind): StarterPreview {
  const source = starterSource(kind);
  const nodes: StarterPreviewNode[] = source.nodes.map((node) => ({
    key: node.key,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    text: node.text,
    style: {
      ...defaultObjectStyle(node.type),
      ...(node.style ?? {}),
    },
  }));
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const edges: StarterPreviewEdge[] = source.edges.map((edge) => {
    const from = byKey.get(edge.from);
    const to = byKey.get(edge.to);
    if (!from || !to) {
      throw new BoardDocumentError('起步结构内出现无效连线');
    }
    const [autoFrom, autoTo] = autoSides(from, to);
    return {
      from: edge.from,
      to: edge.to,
      routing: edge.routing ?? 'elbow',
      fromSide: edge.fromSide ?? autoFrom,
      toSide: edge.toSide ?? autoTo,
      color: edge.color ?? BOARD_THEME_TOKENS.connector,
    };
  });
  const bounds = documentBounds(nodes);
  if (!bounds) {
    throw new BoardDocumentError('起步结构没有对象');
  }
  return { nodes, edges, bounds };
}

/** 新模板与已有内容之间保留的呼吸距离。 */
export const STARTER_CONTENT_GAP = 80;

export function insertStarter(
  document: BoardDocument,
  kind: BoardStarterKind,
  options: { idFactory?: IdFactory } = {},
): { document: BoardDocument; nodeIds: string[] } {
  const source = starterSource(kind);
  const idFactory = options.idFactory ?? boardIdFactory;
  const keyToId = new Map<string, string>();
  for (const node of source.nodes) {
    keyToId.set(node.key, idFactory('node'));
  }

  // 已有内容时插到整份内容下方，并与内容左缘对齐；空画板保持模板坐标。
  const existingBounds = documentBounds(document.nodes);
  const sourceTop = Math.min(...source.nodes.map((node) => node.y));
  const offsetX = existingBounds ? existingBounds.x : 0;
  const offsetY = existingBounds
    ? Math.max(
        0,
        existingBounds.y + existingBounds.height + STARTER_CONTENT_GAP - sourceTop,
      )
    : 0;

  const newNodes: BoardObject[] = source.nodes.map((node) => {
    const type = node.type;
    const zIndex =
      type === 'frame' ? minZ(document.nodes) - 1 : nextZ(document.nodes);
    return {
      id: keyToId.get(node.key) as string,
      type,
      x: node.x + offsetX,
      y: node.y + offsetY,
      width: node.width,
      height: node.height,
      rotation: 0,
      zIndex,
      text: node.text,
      payload: {
        style: {
          ...defaultObjectStyle(type),
          ...(node.style ?? {}),
        } as unknown as JsonValue,
        locked: false,
      },
    };
  });

  const newEdges: BoardConnector[] = source.edges.map((edge) => {
    const connector = createConnector(
      { ...document, nodes: [...document.nodes, ...newNodes] },
      keyToId.get(edge.from) as string,
      keyToId.get(edge.to) as string,
      {
        idFactory,
        label: edge.label,
        fromSide: edge.fromSide,
        toSide: edge.toSide,
        routing: edge.routing,
      },
    );
    if (!connector) {
      throw new BoardDocumentError('起步结构内出现无效连线');
    }
    return edge.color
      ? { ...connector, style: { ...connector.style, color: edge.color } }
      : connector;
  });

  return {
    document: {
      ...document,
      nodes: normalizeZ([...document.nodes, ...newNodes]),
      edges: [...document.edges, ...newEdges],
    },
    nodeIds: newNodes.map((node) => node.id),
  };
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** 画板源文件的公开 schema 标识；只认 `version=1`。 */
export const BOARD_FILE_SCHEMA = 'zhixing.board';
/** 单个画板 JSON 的大小/对象上限（与《笔记画板导入导出规范 v4》§3.2 对齐）。 */
export const BOARD_JSON_MAX_BYTES = 10 * 1024 * 1024;
export const BOARD_JSON_MAX_NODES = 20_000;
export const BOARD_JSON_MAX_EDGES = 40_000;

export type BoardDocumentFileMetadata = {
  app: string;
  schema: string;
  exportedAt: string | null;
};

export type BoardDocumentJson = {
  version: 1;
  /** 源文件标识，便于外部工具识别；解析时可选。 */
  schema: string;
  /** document 元数据；旧文件没有该字段时按旧格式读取。 */
  metadata: BoardDocumentFileMetadata;
  boardId: string;
  noteId: string | null;
  title: string;
  background: string;
  /** 视图状态属于源文件的一部分，用于恢复上次缩放/平移；旧文件可为 null。 */
  viewport: BoardViewport | null;
  nodes: BoardObject[];
  edges: BoardConnector[];
};

export type SerializeBoardDocumentOptions = {
  viewport?: BoardViewport | null;
  /** 测试/调用方可注入固定时间，避免导出内容随渲染时间抖动。 */
  exportedAt?: string;
};

export type ParsedBoardDocumentFile = {
  document: BoardDocument;
  viewport: BoardViewport | null;
  metadata: BoardDocumentFileMetadata;
  warnings: string[];
};

/** 只接受有限坐标与正缩放；不在此处裁剪缩放，保证导出/导入 viewport 一致。 */
export function normalizeBoardViewport(
  value: unknown,
): BoardViewport | null {
  if (!isPlainObject(value)) {
    return null;
  }
  if (
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y) ||
    !isFiniteNumber(value.zoom) ||
    value.zoom <= 0
  ) {
    return null;
  }
  return { x: value.x, y: value.y, zoom: value.zoom };
}

function normalizeFileMetadata(value: unknown): BoardDocumentFileMetadata {
  if (!isPlainObject(value)) {
    return { app: 'zhixing', schema: BOARD_FILE_SCHEMA, exportedAt: null };
  }
  return {
    app:
      typeof value.app === 'string' && value.app.trim()
        ? value.app.trim()
        : 'zhixing',
    schema:
      typeof value.schema === 'string' && value.schema.trim()
        ? value.schema.trim()
        : BOARD_FILE_SCHEMA,
    exportedAt:
      typeof value.exportedAt === 'string' && value.exportedAt.trim()
        ? value.exportedAt.trim()
        : null,
  };
}

export function serializeBoardDocument(
  document: BoardDocument,
  options: SerializeBoardDocumentOptions = {},
): BoardDocumentJson {
  const metadata: BoardDocumentFileMetadata = {
    app: 'zhixing',
    schema: BOARD_FILE_SCHEMA,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
  };
  return {
    version: 1,
    schema: BOARD_FILE_SCHEMA,
    metadata,
    boardId: document.boardId,
    noteId: document.noteId,
    title: document.title,
    background: document.background,
    viewport: normalizeBoardViewport(options.viewport),
    nodes: cloneJson(document.nodes),
    edges: cloneJson(document.edges),
  };
}

export function boardDocumentJson(
  document: BoardDocument,
  options: SerializeBoardDocumentOptions = {},
): string {
  return JSON.stringify(serializeBoardDocument(document, options), null, 2);
}

function parseInput(input: string | unknown): unknown {
  if (typeof input !== 'string') {
    return input;
  }
  // UTF-16 code unit 数已经超过字节上限时无需解析；小于上限的多字节内容
  // 仍由后续结构上限保护。
  if (input.length > BOARD_JSON_MAX_BYTES) {
    throw new BoardDocumentError('画板 JSON 过大，无法导入', 'shape');
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new BoardDocumentError('画板 JSON 不是合法 JSON', 'json');
  }
}

function normalizeNodeRaw(
  raw: unknown,
  index: number,
  seen: Set<string>,
): BoardObject {
  if (!isPlainObject(raw)) {
    throw new BoardDocumentError(`第 ${index + 1} 个对象不是对象`, 'shape');
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) {
    throw new BoardDocumentError(`第 ${index + 1} 个对象缺少 id`, 'id');
  }
  if (seen.has(id)) {
    throw new BoardDocumentError(`对象 id 重复：${id}`, 'id');
  }
  seen.add(id);
  // 旧类型归一：process→rect、start→pill、decision→diamond、circle→ellipse；
  // 未知类型按规范回退为矩形。几何、文字、样式、锁定与连线全部保留。
  const rawType =
    typeof raw.type === 'string' && raw.type.trim()
      ? raw.type.trim().slice(0, 48)
      : 'rect';
  const type = normalizeObjectType(rawType);
  const fallbackSize = SHAPE_SIZES[type];
  // 导入/重开必须原样保留合法几何：模板里的时间线轴只有 6 单位高，
  // 圆点 24×24，若按交互缩放下限（40×30）抬高会破坏 round-trip。
  // 只有非正数/非有限值才回退到该类型的默认尺寸。
  const width =
    isFiniteNumber(raw.width) && raw.width > 0
      ? raw.width
      : fallbackSize.width;
  const height =
    isFiniteNumber(raw.height) && raw.height > 0
      ? raw.height
      : fallbackSize.height;
  return {
    id,
    type,
    x: isFiniteNumber(raw.x) ? raw.x : 0,
    y: isFiniteNumber(raw.y) ? raw.y : 0,
    width,
    height,
    rotation: isFiniteNumber(raw.rotation) ? raw.rotation : 0,
    zIndex: isFiniteNumber(raw.zIndex) ? Math.round(raw.zIndex) : index,
    text: typeof raw.text === 'string' ? raw.text : '',
    payload: normalizeJsonObject(raw.payload),
  };
}

function normalizeEdgeRaw(
  raw: unknown,
  index: number,
  seen: Set<string>,
  nodeIds: Set<string>,
): BoardConnector {
  if (!isPlainObject(raw)) {
    throw new BoardDocumentError(`第 ${index + 1} 条连线不是对象`, 'edge');
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const fromNodeId =
    typeof raw.fromNodeId === 'string' ? raw.fromNodeId.trim() : '';
  const toNodeId =
    typeof raw.toNodeId === 'string' ? raw.toNodeId.trim() : '';
  if (!id) {
    throw new BoardDocumentError(`第 ${index + 1} 条连线缺少 id`, 'edge');
  }
  if (seen.has(id)) {
    throw new BoardDocumentError(`连线 id 重复：${id}`, 'edge');
  }
  if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) {
    throw new BoardDocumentError(`连线 ${id} 的端点无效`, 'edge');
  }
  if (!nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId)) {
    throw new BoardDocumentError(`连线 ${id} 引用了不存在的对象`, 'edge');
  }
  seen.add(id);
  return {
    id,
    fromNodeId,
    toNodeId,
    label: typeof raw.label === 'string' ? raw.label : '',
    style: normalizeJsonObject(raw.style),
  };
}

/**
 * 解析并校验画板 JSON。可覆盖 boardId / noteId，用于「导入到当前画板」时
 * 不把外来的画板 id 写回路由。
 *
 * 返回值同时携带 viewport、元数据与迁移警告；`parseBoardDocument` 只取
 * document，保持原有调用方兼容。
 */
export function parseBoardDocumentFile(
  input: string | unknown,
  overrides: { boardId?: string; noteId?: string | null } = {},
): ParsedBoardDocumentFile {
  const value = parseInput(input);
  if (!isPlainObject(value)) {
    throw new BoardDocumentError('画板 JSON 必须是对象', 'shape');
  }
  if (value.version !== 1) {
    throw new BoardDocumentError('仅支持 version=1 的画板 JSON', 'version');
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new BoardDocumentError('画板 JSON 缺少 nodes / edges 数组', 'shape');
  }
  if (value.nodes.length > BOARD_JSON_MAX_NODES) {
    throw new BoardDocumentError(
      `画板 JSON 对象过多（上限 ${BOARD_JSON_MAX_NODES} 个），无法导入`,
      'shape',
    );
  }
  if (value.edges.length > BOARD_JSON_MAX_EDGES) {
    throw new BoardDocumentError(
      `画板 JSON 连线过多（上限 ${BOARD_JSON_MAX_EDGES} 条），无法导入`,
      'shape',
    );
  }
  const migratedTypes = new Set<string>();
  for (const raw of value.nodes) {
    if (!isPlainObject(raw) || typeof raw.type !== 'string') {
      continue;
    }
    const rawType = raw.type.trim().slice(0, 48);
    const nextType = normalizeObjectType(rawType);
    if (nextType !== rawType) {
      migratedTypes.add(`${rawType} → ${nextType}`);
    }
  }
  const nodeSeen = new Set<string>();
  const nodes = value.nodes.map((raw, index) =>
    normalizeNodeRaw(raw, index, nodeSeen),
  );
  const edgeSeen = new Set<string>();
  const edges = value.edges.map((raw, index) =>
    normalizeEdgeRaw(raw, index, edgeSeen, nodeSeen),
  );
  const boardId =
    overrides.boardId ??
    (typeof value.boardId === 'string' && value.boardId.trim()
      ? value.boardId.trim()
      : 'local-board');
  const document: BoardDocument = {
    version: 1,
    boardId,
    noteId:
      overrides.noteId !== undefined
        ? overrides.noteId
        : typeof value.noteId === 'string'
          ? value.noteId
          : null,
    title:
      typeof value.title === 'string' && value.title.trim()
        ? value.title.trim()
        : '未命名画板',
    background:
      typeof value.background === 'string' && value.background
        ? value.background
        : 'dot',
    nodes: normalizeZ(nodes),
    edges,
  };
  return {
    document,
    viewport: normalizeBoardViewport(value.viewport),
    metadata: normalizeFileMetadata(value.metadata),
    warnings: migratedTypes.size
      ? [`旧对象类型已迁移：${Array.from(migratedTypes).join('、')}`]
      : [],
  };
}

export function parseBoardDocument(
  input: string | unknown,
  overrides: { boardId?: string; noteId?: string | null } = {},
): BoardDocument {
  return parseBoardDocumentFile(input, overrides).document;
}
