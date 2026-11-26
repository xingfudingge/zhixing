/**
 * 画板仓储（P1-04）。
 *
 * 权威数据在 `boards` / `board_nodes` / `board_edges` 三张表：
 * - `board_nodes` 保存对象的几何、文字与 payload（样式/锁定等）；
 * - `board_edges` 保存两端对象、标签与 style_json；
 * - `boards.snapshot_json` 只保存可重建的轻量摘要，不作为对象数据的唯一来源。
 *
 * `save()` 以「整份画板文档」为单位做最小 diff：删除多余节点/连线、
 * 新增缺失项、更新变化项。删除顺序固定为「先连线、后节点」，新增顺序为
 * 「先节点、后连线」，避免外键与软删除产生悬空引用。渲染层不直接拼 SQL，
 * 也不把 localStorage 当权威库。
 */

import type { DbClient } from '../db/client';
import type {
  Board,
  BoardEdge,
  BoardNode,
  JsonValue,
  NewBoard,
  NewBoardEdge,
  NewBoardNode,
} from '../db/types';

export type BoardJsonObject = { [key: string]: JsonValue };

export type BoardNodeRecord = {
  id: string;
  boardId: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  text: string;
  payload: BoardJsonObject;
};

export type BoardEdgeRecord = {
  id: string;
  boardId: string;
  fromNodeId: string;
  toNodeId: string;
  label: string;
  style: BoardJsonObject;
};

export type BoardRecord = {
  board: Board;
  nodes: BoardNodeRecord[];
  edges: BoardEdgeRecord[];
};

export type BoardNodeInput = Omit<BoardNodeRecord, 'boardId'>;

export type BoardEdgeInput = Omit<BoardEdgeRecord, 'boardId'>;

export type SaveBoardInput = {
  noteId: string | null;
  title: string;
  background?: string;
  snapshot?: JsonValue;
  nodes: BoardNodeInput[];
  edges: BoardEdgeInput[];
};

export type CreateBoardInput = {
  id?: string;
  noteId?: string | null;
  title?: string;
  background?: string;
};

/** 画板导出的公开 JSON；用于自有备份与二次开发。 */
export type BoardExportDocument = {
  version: 1;
  boardId: string;
  noteId: string | null;
  title: string;
  background: string;
  nodes: BoardNodeRecord[];
  edges: BoardEdgeRecord[];
};

export class BoardRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardRepositoryError';
  }
}

export const DEFAULT_BOARD_TITLE = '未命名画板';
export const DEFAULT_BOARD_BACKGROUND = 'dot';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== null
  );
}

export function normalizeJsonObject(value: unknown): BoardJsonObject {
  return isPlainObject(value) ? (value as BoardJsonObject) : {};
}

export function toBoardNodeRecord(node: BoardNode): BoardNodeRecord {
  return {
    id: node.id,
    boardId: node.boardId,
    type: node.nodeType,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: node.rotation,
    zIndex: node.zIndex,
    text: node.text,
    payload: normalizeJsonObject(node.payload),
  };
}

export function toBoardEdgeRecord(edge: BoardEdge): BoardEdgeRecord {
  return {
    id: edge.id,
    boardId: edge.boardId,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    label: edge.label,
    style: normalizeJsonObject(edge.style),
  };
}

function normalizeTitle(value: string | undefined): string {
  const title = (value ?? '').trim();
  return title || DEFAULT_BOARD_TITLE;
}

function toNodePayload(node: BoardNodeInput): JsonValue {
  return node.payload as JsonValue;
}

function toEdgeStyle(edge: BoardEdgeInput): JsonValue {
  return edge.style as JsonValue;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateInput(input: SaveBoardInput): void {
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    throw new BoardRepositoryError('画板文档缺少 nodes / edges 数组');
  }
  const nodeIds = new Set<string>();
  for (const node of input.nodes) {
    if (!node.id || !node.id.trim()) {
      throw new BoardRepositoryError('画板对象缺少 id');
    }
    if (nodeIds.has(node.id)) {
      throw new BoardRepositoryError(`画板对象 id 重复：${node.id}`);
    }
    nodeIds.add(node.id);
    if (
      !Number.isFinite(node.x) ||
      !Number.isFinite(node.y) ||
      !Number.isFinite(node.width) ||
      !Number.isFinite(node.height)
    ) {
      throw new BoardRepositoryError(`画板对象 ${node.id} 的几何值不是有限数字`);
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of input.edges) {
    if (!edge.id || !edge.id.trim()) {
      throw new BoardRepositoryError('连线缺少 id');
    }
    if (edgeIds.has(edge.id)) {
      throw new BoardRepositoryError(`连线 id 重复：${edge.id}`);
    }
    edgeIds.add(edge.id);
    if (edge.fromNodeId === edge.toNodeId) {
      throw new BoardRepositoryError(`连线 ${edge.id} 的两端不能是同一个对象`);
    }
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      throw new BoardRepositoryError(
        `连线 ${edge.id} 的端点不在本次保存的对象中`,
      );
    }
  }
}

function nodeChanged(current: BoardNodeRecord, next: BoardNodeInput): boolean {
  return (
    current.type !== next.type ||
    current.x !== next.x ||
    current.y !== next.y ||
    current.width !== next.width ||
    current.height !== next.height ||
    current.rotation !== next.rotation ||
    current.zIndex !== next.zIndex ||
    current.text !== next.text ||
    !jsonEqual(current.payload, next.payload)
  );
}

function edgeChanged(current: BoardEdgeRecord, next: BoardEdgeInput): boolean {
  return (
    current.fromNodeId !== next.fromNodeId ||
    current.toNodeId !== next.toNodeId ||
    current.label !== next.label ||
    !jsonEqual(current.style, next.style)
  );
}

export function createBoardRepository(client: DbClient) {
  const load = async (boardId: string): Promise<BoardRecord> => {
    const [board, nodes, edges] = await Promise.all([
      client.boards.get(boardId),
      client.boards.nodes.list(boardId),
      client.boards.edges.list(boardId),
    ]);
    return {
      board,
      nodes: nodes.map(toBoardNodeRecord),
      edges: edges.map(toBoardEdgeRecord),
    };
  };

  const list = async (): Promise<Board[]> => client.boards.list({});

  const create = async (
    input: CreateBoardInput = {},
  ): Promise<BoardRecord> => {
    const title = normalizeTitle(input.title);
    const payload: NewBoard = {
      title,
      noteId: input.noteId ?? null,
      background: input.background ?? DEFAULT_BOARD_BACKGROUND,
      snapshot: { version: 1 },
      ...(input.id ? { id: input.id } : {}),
    };
    const board = await client.boards.create(payload);
    return { board, nodes: [], edges: [] };
  };

  const save = async (
    boardId: string,
    input: SaveBoardInput,
  ): Promise<BoardRecord> => {
    validateInput(input);
    const current = await load(boardId);
    const title = normalizeTitle(input.title);
    const background = input.background ?? current.board.background;
    const incomingNodeIds = new Set(input.nodes.map((node) => node.id));
    const incomingEdgeIds = new Set(input.edges.map((edge) => edge.id));

    // 1. 先删掉不再存在的连线，避免节点删除后留下悬空边。
    for (const edge of current.edges) {
      if (!incomingEdgeIds.has(edge.id)) {
        await client.boards.edges.remove(edge.id);
      }
    }

    // 2. 删除不再存在的节点（Rust 同事务软删除相连边）。
    for (const node of current.nodes) {
      if (!incomingNodeIds.has(node.id)) {
        await client.boards.nodes.remove(node.id);
      }
    }

    // 3. 新增 / 更新节点。
    const currentNodes = new Map(
      current.nodes.map((node) => [node.id, node]),
    );
    for (const node of input.nodes) {
      const existing = currentNodes.get(node.id);
      if (!existing) {
        const payload: NewBoardNode = {
          id: node.id,
          boardId,
          nodeType: node.type,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          rotation: node.rotation,
          zIndex: node.zIndex,
          text: node.text,
          payload: toNodePayload(node),
        };
        await client.boards.nodes.create(payload);
        continue;
      }
      if (nodeChanged(existing, node)) {
        await client.boards.nodes.update(node.id, {
          nodeType: node.type,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          rotation: node.rotation,
          zIndex: node.zIndex,
          text: node.text,
          payload: toNodePayload(node),
        });
      }
    }

    // 4. 新增 / 更新连线；端点此时一定已存在。
    const currentEdges = new Map(
      current.edges.map((edge) => [edge.id, edge]),
    );
    for (const edge of input.edges) {
      const existing = currentEdges.get(edge.id);
      if (!existing) {
        const payload: NewBoardEdge = {
          id: edge.id,
          boardId,
          fromNodeId: edge.fromNodeId,
          toNodeId: edge.toNodeId,
          label: edge.label,
          style: toEdgeStyle(edge),
        };
        await client.boards.edges.create(payload);
        continue;
      }
      if (edgeChanged(existing, edge)) {
        await client.boards.edges.update(edge.id, {
          fromNodeId: edge.fromNodeId,
          toNodeId: edge.toNodeId,
          label: edge.label,
          style: toEdgeStyle(edge),
        });
      }
    }

    // 5. 最后更新画板元信息。snapshot_json 只放可重建摘要。
    const snapshot: JsonValue =
      input.snapshot ?? {
        version: 1,
        nodeCount: input.nodes.length,
        edgeCount: input.edges.length,
      };
    await client.boards.update(boardId, {
      noteId: input.noteId,
      title,
      background,
      snapshot,
      thumbnailKey: null,
    });

    return load(boardId);
  };

  const remove = (boardId: string): Promise<void> =>
    client.boards.remove(boardId);

  const exportDocument = async (
    boardId: string,
  ): Promise<BoardExportDocument> => {
    const record = await load(boardId);
    return {
      version: 1,
      boardId: record.board.id,
      noteId: record.board.noteId,
      title: record.board.title,
      background: record.board.background,
      nodes: record.nodes,
      edges: record.edges,
    };
  };

  return {
    load,
    list,
    create,
    save,
    remove,
    exportDocument,
  };
}

export type BoardRepository = ReturnType<typeof createBoardRepository>;
