/**
 * 画板领域模型（Canvas2D 第一阶段）。
 *
 * 坐标使用画布逻辑单位；缩放/平移只属于视图状态，不写入文档。
 * `payload` / `style` 保留原始 JSON 对象，渲染层只读取已知字段，
 * 未识别的字段在保存/导出时原样保留，避免跨版本丢数据。
 *
 * 本阶段明确没有：图片、自由画笔、旋转编辑、8 向手柄、分组、导出图片、
 * 历史版本与多人协作。模型里出现 `rotation` 只是为了读取旧 JSON 时不丢字段。
 */

import type { JsonValue } from '../../data/db/types';

export type BoardJsonObject = { [key: string]: JsonValue };

export type AnchorSide = 'l' | 'r' | 't' | 'b';

export type BoardTextAlign = 'left' | 'center' | 'right';

export type BoardTool = 'select' | 'hand' | 'connect';

/**
 * 中性对象类型：矩形 / 圆角矩形 / 椭圆 / 菱形 / 文本 / 便签 / 容器，
 * 以及「更多形状」三角形 / 六边形 / 胶囊 / 平行四边形。
 *
 * 不再包含 `process`（流程步骤）、`start`（开始/结束）、`decision`（判定）；
 * 旧文档在解析/加载时分别映射为 `rect` / `pill` / `diamond`。
 */
export type BoardObjectType =
  | 'rect'
  | 'round'
  | 'ellipse'
  | 'diamond'
  | 'text'
  | 'sticky'
  | 'frame'
  | 'triangle'
  | 'hexagon'
  | 'pill'
  | 'parallelogram';

export type BoardObject = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 第一阶段不支持旋转编辑；读取旧数据时保留原值。 */
  rotation: number;
  zIndex: number;
  text: string;
  /** 已知字段见 `objectStyle` / `objectLocked`；未知字段原样保留。 */
  payload: BoardJsonObject;
};

export type BoardObjectStyle = {
  fill: string;
  stroke: string;
  textColor: string;
  fontSize: number;
  bold: boolean;
  textAlign: BoardTextAlign;
  radius: number;
  opacity: number;
};

export type BoardRouting = 'straight' | 'elbow' | 'curve';
export type BoardArrow = 'none' | 'end' | 'both';

export type BoardConnectorStyle = {
  routing: BoardRouting;
  arrow: BoardArrow;
  color: string;
  width: number;
  dashed: boolean;
  fromSide: AnchorSide;
  toSide: AnchorSide;
};

export type BoardConnector = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label: string;
  /** 已知字段见 `connectorStyle`；未知字段原样保留。 */
  style: BoardJsonObject;
};

export type BoardDocument = {
  version: 1;
  boardId: string;
  noteId: string | null;
  title: string;
  background: string;
  nodes: BoardObject[];
  edges: BoardConnector[];
};

export type BoardSelection = {
  nodeIds: string[];
  edgeIds: string[];
};

/** 画布右键菜单的命中目标；坐标是 client 坐标（fixed 浮层）。 */
export type BoardContextMenuState = {
  x: number;
  y: number;
  target:
    | { kind: 'canvas' }
    | { kind: 'node'; nodeId: string }
    | { kind: 'edge'; edgeId: string };
};

export type BoardViewport = {
  /** 视口左上角对应的画布世界坐标。 */
  x: number;
  y: number;
  zoom: number;
};

export type BoardSnapshot = {
  title: string;
  nodes: BoardObject[];
  edges: BoardConnector[];
};

export type BoardClipboard = {
  nodes: BoardObject[];
  edges: BoardConnector[];
};

/**
 * 起步结构（模板）类型。所有模板插入的都是普通对象与连线，
 * 不写入 `templateId` / `groupId` / 模式字段。
 *
 * `lane` 保持旧的横向泳道语义，`flow` 为早期已交付的流程图模板，
 * 其余为规范中的常用结构：时间线、组织架构、系统架构、思维导图、
 * 金字塔、增长飞轮。
 */
export type BoardStarterKind =
  | 'flow'
  | 'timeline'
  | 'org'
  | 'sys'
  | 'mind'
  | 'pyramid'
  | 'flywheel'
  | 'lane'
  | 'lane-vertical';

/** 模板弹层里的分组；只影响展示，不写入文档。 */
export type BoardStarterGroup = 'process' | 'structure' | 'thinking';

export type BoardStarterTemplate = {
  kind: BoardStarterKind;
  title: string;
  description: string;
  group: BoardStarterGroup;
};

export type BoardSelectionMode =
  | 'replace'
  | 'toggle'
  | 'add'
  | 'none';

export type IdFactory = (prefix: 'node' | 'edge') => string;

export type BoardSummary = {
  id: string;
  title: string;
  noteId: string | null;
  updatedAt: string;
};

export type BoardSource = {
  list: () => Promise<BoardSummary[]>;
  load: (boardId: string) => Promise<BoardDocument>;
  create: (input?: {
    id?: string;
    noteId?: string | null;
    title?: string;
  }) => Promise<BoardDocument>;
  save: (boardId: string, document: BoardDocument) => Promise<BoardDocument>;
  remove: (boardId: string) => Promise<void>;
};

export const BOARD_WIDTH = 2400;
export const BOARD_HEIGHT = 1600;
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2;
export const GRID_SIZE = 10;
export const MIN_OBJECT_WIDTH = 40;
export const MIN_OBJECT_HEIGHT = 30;
export const HISTORY_LIMIT = 100;
