import { describe, expect, it, vi } from 'vitest';

import type { BoardDocument, BoardSource } from '../types';
import { cloneJson, createEmptyDocument } from '../model';
import {
  importBoardDocumentAsNew,
  remapBoardDocument,
  replaceBoardDocument,
} from '../export/remap';
import { sampleDocument } from './fakeBoardSource';

type SaveFailure = 'none' | 'start' | 'partial';

/**
 * 多画板内存源，模拟 SQLite 的全局主键：
 * - board_nodes.id / board_edges.id 跨画板唯一；
 * - 冲突时抛出与 Rust 仓储相同的错误文案；
 * - 可模拟保存中途失败，用于验证补偿回写。
 */
function createStrictSource(initial: BoardDocument[] = []) {
  const boards = new Map<string, BoardDocument>();
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  let sequence = 0;
  let failure: SaveFailure = 'none';

  const register = (document: BoardDocument) => {
    for (const node of document.nodes) {
      if (nodeIds.has(node.id)) {
        throw new Error(`UNIQUE constraint failed: board_nodes.id (${node.id})`);
      }
    }
    for (const edge of document.edges) {
      if (edgeIds.has(edge.id)) {
        throw new Error(`UNIQUE constraint failed: board_edges.id (${edge.id})`);
      }
    }
    for (const node of document.nodes) nodeIds.add(node.id);
    for (const edge of document.edges) edgeIds.add(edge.id);
  };
  const unregister = (document: BoardDocument) => {
    for (const node of document.nodes) nodeIds.delete(node.id);
    for (const edge of document.edges) edgeIds.delete(edge.id);
  };

  for (const document of initial) {
    boards.set(document.boardId, cloneJson(document));
    register(document);
  }

  const source: BoardSource = {
    list: async () =>
      Array.from(boards.values()).map((document) => ({
        id: document.boardId,
        title: document.title,
        noteId: document.noteId,
        updatedAt: '2026-10-29T00:00:00.000Z',
      })),
    load: async (boardId) => {
      const document = boards.get(boardId);
      if (!document) throw new Error(`画板不存在：${boardId}`);
      return cloneJson(document);
    },
    create: async (input = {}) => {
      sequence += 1;
      const document = createEmptyDocument({
        boardId: input.id ?? `board-strict-${sequence}`,
        noteId: input.noteId ?? null,
        title: input.title ?? '未命名画板',
      });
      boards.set(document.boardId, document);
      return cloneJson(document);
    },
    save: async (boardId, document) => {
      const current = boards.get(boardId);
      if (!current) throw new Error(`画板不存在：${boardId}`);
      if (failure === 'start') {
        failure = 'none';
        throw new Error('磁盘不可写');
      }
      if (failure === 'partial') {
        failure = 'none';
        unregister(current);
        const partial: BoardDocument = {
          ...cloneJson(document),
          nodes: cloneJson(document.nodes.slice(0, 1)),
          edges: [],
        };
        boards.set(boardId, partial);
        register(partial);
        throw new Error('磁盘不可写');
      }
      const incoming = cloneJson({ ...document, boardId });
      // 先把当前画板从全局主键集合移除，再检查新内容是否与其它画板冲突。
      unregister(current);
      try {
        register(incoming);
      } catch (reason) {
        register(current);
        throw reason;
      }
      boards.set(boardId, incoming);
      return cloneJson(incoming);
    },
    remove: async (boardId) => {
      const current = boards.get(boardId);
      if (current) {
        unregister(current);
        boards.delete(boardId);
      }
    },
  };

  return {
    source,
    boards,
    failNextSave(mode: Exclude<SaveFailure, 'none'>) {
      failure = mode;
    },
    allNodeIds: () => Array.from(nodeIds),
    allEdgeIds: () => Array.from(edgeIds),
  };
}

function documentWithUnknownFields(): BoardDocument {
  const document = sampleDocument();
  document.nodes[0]!.payload = {
    ...document.nodes[0]!.payload,
    locked: true,
    custom: { nested: ['保留', 42], flag: true },
  };
  document.nodes[0]!.rotation = 15;
  document.edges[0]!.style = {
    ...document.edges[0]!.style,
    unknownEdgeField: 'keep-me',
  };
  return document;
}

describe('画板导入 · ID 重映射', () => {
  it('为每个节点/连线生成新 ID，并改写连线端点', () => {
    const source = documentWithUnknownFields();
    const remapped = remapBoardDocument(source, {
      boardId: 'board-new',
      noteId: 'note-new',
      idFactory: (() => {
        let sequence = 0;
        return (prefix) => `${prefix}-new-${++sequence}`;
      })(),
    });

    expect(remapped.document.boardId).toBe('board-new');
    expect(remapped.document.noteId).toBe('note-new');
    expect(remapped.document.nodes.map((node) => node.id)).toEqual([
      'node-new-1',
      'node-new-2',
      'node-new-3',
    ]);
    expect(remapped.document.edges.map((edge) => edge.id)).toEqual([
      'edge-new-4',
      'edge-new-5',
    ]);
    for (const edge of remapped.document.edges) {
      expect(edge.fromNodeId).toMatch(/^node-new-/);
      expect(edge.toNodeId).toMatch(/^node-new-/);
    }
    expect(remapped.document.edges[0]!.fromNodeId).toBe('node-new-1');
    expect(remapped.document.edges[0]!.toNodeId).toBe('node-new-2');

    // 几何/文字/样式/锁定/未知字段全部保留。
    expect(remapped.document.nodes[0]!.payload.locked).toBe(true);
    expect(remapped.document.nodes[0]!.payload.custom).toEqual({
      nested: ['保留', 42],
      flag: true,
    });
    expect(remapped.document.nodes[0]!.rotation).toBe(15);
    expect(remapped.document.edges[0]!.style.unknownEdgeField).toBe(
      'keep-me',
    );
    expect(remapped.document.nodes[0]!.text).toBe('开始');
  });

  it('注入的工厂若返回源 ID，会继续尝试而不是复用源 ID', () => {
    const source = documentWithUnknownFields();
    let call = 0;
    const remapped = remapBoardDocument(source, {
      boardId: 'board-new',
      noteId: null,
      idFactory: (prefix) => {
        call += 1;
        // 前三次故意返回源 ID，模拟最坏碰撞。
        if (call <= 3) return call === 1 ? 'n-a' : call === 2 ? 'n-b' : 'n-c';
        return `${prefix}-safe-${call}`;
      },
    });
    const sourceIds = new Set([
      ...source.nodes.map((node) => node.id),
      ...source.edges.map((edge) => edge.id),
    ]);
    for (const node of remapped.document.nodes) {
      expect(sourceIds.has(node.id)).toBe(false);
    }
    for (const edge of remapped.document.edges) {
      expect(sourceIds.has(edge.id)).toBe(false);
    }
  });
});

describe('画板导入 · 新建画板', () => {
  it('同一份文档连续导入两次得到两张画板，ID 全不同且无主键冲突', async () => {
    const strict = createStrictSource();
    const document = documentWithUnknownFields();

    const first = await importBoardDocumentAsNew(strict.source, document, {
      noteId: 'note-1',
    });
    const second = await importBoardDocumentAsNew(strict.source, document, {
      noteId: 'note-1',
    });

    expect(strict.boards.size).toBe(2);
    expect(first.boardId).not.toBe(second.boardId);
    const firstNodeIds = first.nodes.map((node) => node.id);
    const secondNodeIds = second.nodes.map((node) => node.id);
    expect(firstNodeIds.some((id) => secondNodeIds.includes(id))).toBe(false);
    expect(firstNodeIds).not.toContain('n-a');
    expect(secondNodeIds).not.toContain('n-a');
    expect(first.edges[0]!.fromNodeId).toBe(firstNodeIds[0]);
    expect(second.edges[0]!.fromNodeId).toBe(secondNodeIds[0]);
    // 两个画板的对象 ID 都在全局主键集合里，且没有重复。
    expect(new Set(strict.allNodeIds()).size).toBe(strict.allNodeIds().length);
    expect(new Set(strict.allEdgeIds()).size).toBe(strict.allEdgeIds().length);
  });

  it('保存失败时回收新建画板，不留下半成品', async () => {
    const strict = createStrictSource();
    strict.failNextSave('start');
    const before = strict.boards.size;

    await expect(
      importBoardDocumentAsNew(strict.source, sampleDocument(), {
        noteId: 'note-1',
      }),
    ).rejects.toThrow(/磁盘不可写/);

    expect(strict.boards.size).toBe(before);
    expect(strict.allNodeIds()).toEqual([]);
    expect(strict.allEdgeIds()).toEqual([]);
  });

  it('唯一约束冲突时用全新 ID 重试，最多三次', async () => {
    const strict = createStrictSource();
    const originalSave = strict.source.save;
    let attempts = 0;
    strict.source.save = vi.fn(async (boardId, document) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('UNIQUE constraint failed: board_nodes.id');
      }
      return originalSave(boardId, document);
    });

    const saved = await importBoardDocumentAsNew(strict.source, sampleDocument(), {
      noteId: 'note-1',
    });
    expect(attempts).toBe(2);
    expect(saved.nodes).toHaveLength(3);
    expect(strict.boards.size).toBe(1);
  });
});

describe('画板导入 · 替换当前画板', () => {
  it('替换后节点/连线为新 ID，当前 boardId 不变', async () => {
    const original = sampleDocument();
    const strict = createStrictSource([original]);

    const saved = await replaceBoardDocument(
      strict.source,
      'board-1',
      {
        ...original,
        title: '替换后的画板',
        nodes: [original.nodes[0]!],
        edges: [],
      },
      { noteId: 'note-1' },
    );

    expect(saved.boardId).toBe('board-1');
    expect(saved.title).toBe('替换后的画板');
    expect(saved.nodes).toHaveLength(1);
    expect(saved.nodes[0]!.id).not.toBe('n-a');
    expect(strict.boards.get('board-1')!.nodes[0]!.id).toBe(
      saved.nodes[0]!.id,
    );
  });

  it('写入中途失败时用导入前快照回滚，当前画板保持原样', async () => {
    const original = sampleDocument();
    const strict = createStrictSource([original]);
    strict.failNextSave('partial');

    await expect(
      replaceBoardDocument(
        strict.source,
        'board-1',
        {
          ...sampleDocument(),
          title: '不应保留',
          nodes: [sampleDocument().nodes[0]!],
          edges: [],
        },
        { noteId: 'note-1' },
      ),
    ).rejects.toThrow(/磁盘不可写/);

    const stored = await strict.source.load('board-1');
    expect(stored.title).toBe('测试画板');
    expect(stored.nodes.map((node) => node.id)).toEqual([
      'n-a',
      'n-b',
      'n-c',
    ]);
    expect(stored.edges.map((edge) => edge.id)).toEqual(['e-a', 'e-b']);
    expect(strict.allNodeIds().sort()).toEqual(['n-a', 'n-b', 'n-c']);
  });
});
