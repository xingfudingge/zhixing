/**
 * 画板数据源适配：把 SQLite 仓储的 raw node/edge 记录映射为 Canvas 模型。
 * 页面只依赖 `BoardSource`，测试可注入内存实现。
 */

import { db } from '../../data/db/client';
import {
  createBoardRepository,
  type BoardRecord,
  type BoardRepository,
  type SaveBoardInput,
} from '../../data/repositories/boards';
import type {
  BoardDocument,
  BoardSource,
  BoardSummary,
} from './types';

export function documentFromRecord(record: BoardRecord): BoardDocument {
  return {
    version: 1,
    boardId: record.board.id,
    noteId: record.board.noteId,
    title: record.board.title,
    background: record.board.background,
    nodes: record.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rotation: node.rotation,
      zIndex: node.zIndex,
      text: node.text,
      payload: node.payload,
    })),
    edges: record.edges.map((edge) => ({
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      label: edge.label,
      style: edge.style,
    })),
  };
}

export function saveInputFromDocument(
  document: BoardDocument,
): SaveBoardInput {
  return {
    noteId: document.noteId,
    title: document.title,
    background: document.background,
    snapshot: {
      version: 1,
      nodeCount: document.nodes.length,
      edgeCount: document.edges.length,
    },
    nodes: document.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rotation: node.rotation,
      zIndex: node.zIndex,
      text: node.text,
      payload: node.payload,
    })),
    edges: document.edges.map((edge) => ({
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      label: edge.label,
      style: edge.style,
    })),
  };
}

export function createBoardSource(
  repository: BoardRepository = createBoardRepository(db),
): BoardSource {
  return {
    list: async (): Promise<BoardSummary[]> => {
      const boards = await repository.list();
      return boards.map((board) => ({
        id: board.id,
        title: board.title,
        noteId: board.noteId,
        updatedAt: board.updatedAt,
      }));
    },

    load: async (boardId) => documentFromRecord(await repository.load(boardId)),

    create: async (input = {}) =>
      documentFromRecord(
        await repository.create({
          id: input.id,
          noteId: input.noteId,
          title: input.title,
        }),
      ),

    save: async (boardId, document) =>
      documentFromRecord(
        await repository.save(boardId, saveInputFromDocument(document)),
      ),

    remove: (boardId) => repository.remove(boardId),
  };
}
