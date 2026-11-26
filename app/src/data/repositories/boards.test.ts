import { describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../db/client';
import type {
  Board,
  BoardEdge,
  BoardEdgeUpdate,
  BoardNode,
  BoardNodeUpdate,
  BoardQuery,
  BoardUpdate,
  NewBoard,
  NewBoardEdge,
  NewBoardNode,
} from '../db/types';
import {
  BoardRepositoryError,
  createBoardRepository,
  type SaveBoardInput,
} from './boards';

type FakeStore = {
  client: DbClient;
  boards: Map<string, Board>;
  nodes: Map<string, BoardNode>;
  edges: Map<string, BoardEdge>;
  spies: {
    boardUpdate: ReturnType<typeof vi.fn>;
    nodeCreate: ReturnType<typeof vi.fn>;
    nodeUpdate: ReturnType<typeof vi.fn>;
    nodeRemove: ReturnType<typeof vi.fn>;
    edgeCreate: ReturnType<typeof vi.fn>;
    edgeUpdate: ReturnType<typeof vi.fn>;
    edgeRemove: ReturnType<typeof vi.fn>;
  };
};

let clock = 0;
function timestamp(): string {
  clock += 1;
  return `2026-10-26T00:00:${String(clock).padStart(2, '0')}.000Z`;
}

function createFakeStore(): FakeStore {
  const boards = new Map<string, Board>();
  const nodes = new Map<string, BoardNode>();
  const edges = new Map<string, BoardEdge>();
  let sequence = 0;
  const nextId = (prefix: string) => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };

  const boardUpdate = vi.fn(async (id: string, input: BoardUpdate) => {
    const current = boards.get(id);
    if (!current) {
      throw new Error('not found');
    }
    const updated: Board = {
      ...current,
      noteId: input.noteId,
      title: input.title,
      background: input.background,
      snapshot: input.snapshot,
      thumbnailKey: input.thumbnailKey,
      updatedAt: timestamp(),
      version: current.version + 1,
    };
    boards.set(id, updated);
    return updated;
  });
  const nodeCreate = vi.fn(async (input: NewBoardNode) => {
    const node: BoardNode = {
      id: input.id ?? nextId('node'),
      boardId: input.boardId,
      nodeType: input.nodeType ?? 'process',
      x: input.x ?? 0,
      y: input.y ?? 0,
      width: input.width ?? 150,
      height: input.height ?? 60,
      rotation: input.rotation ?? 0,
      zIndex: input.zIndex ?? 0,
      text: input.text ?? '',
      payload: input.payload ?? {},
      createdAt: timestamp(),
      updatedAt: timestamp(),
      deletedAt: null,
      version: 1,
    };
    nodes.set(node.id, node);
    return node;
  });
  const nodeUpdate = vi.fn(async (id: string, input: BoardNodeUpdate) => {
    const current = nodes.get(id);
    if (!current) {
      throw new Error('not found');
    }
    const updated: BoardNode = {
      ...current,
      nodeType: input.nodeType,
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      rotation: input.rotation,
      zIndex: input.zIndex,
      text: input.text,
      payload: input.payload,
      updatedAt: timestamp(),
      version: current.version + 1,
    };
    nodes.set(id, updated);
    return updated;
  });
  const nodeRemove = vi.fn(async (id: string) => {
    const current = nodes.get(id);
    if (!current) {
      throw new Error('not found');
    }
    nodes.set(id, {
      ...current,
      deletedAt: timestamp(),
      version: current.version + 1,
    });
    for (const edge of edges.values()) {
      if (
        edge.boardId === current.boardId &&
        (edge.fromNodeId === id || edge.toNodeId === id) &&
        !edge.deletedAt
      ) {
        edges.set(edge.id, {
          ...edge,
          deletedAt: timestamp(),
          version: edge.version + 1,
        });
      }
    }
  });
  const edgeCreate = vi.fn(async (input: NewBoardEdge) => {
    const edge: BoardEdge = {
      id: input.id ?? nextId('edge'),
      boardId: input.boardId,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      label: input.label ?? '',
      style: input.style ?? {},
      createdAt: timestamp(),
      updatedAt: timestamp(),
      deletedAt: null,
      version: 1,
    };
    edges.set(edge.id, edge);
    return edge;
  });
  const edgeUpdate = vi.fn(async (id: string, input: BoardEdgeUpdate) => {
    const current = edges.get(id);
    if (!current) {
      throw new Error('not found');
    }
    const updated: BoardEdge = {
      ...current,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      label: input.label,
      style: input.style,
      updatedAt: timestamp(),
      version: current.version + 1,
    };
    edges.set(id, updated);
    return updated;
  });
  const edgeRemove = vi.fn(async (id: string) => {
    const current = edges.get(id);
    if (!current) {
      throw new Error('not found');
    }
    edges.set(id, {
      ...current,
      deletedAt: timestamp(),
      version: current.version + 1,
    });
  });

  const client = {
    boards: {
      list: vi.fn(async (query: BoardQuery = {}) =>
        [...boards.values()]
          .filter(
            (board) =>
              (query.includeDeleted || !board.deletedAt) &&
              (query.noteId === undefined ||
                query.noteId === null ||
                board.noteId === query.noteId),
          )
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
      ),
      get: vi.fn(async (id: string) => {
        const board = boards.get(id);
        if (!board || board.deletedAt) {
          throw new Error('not found');
        }
        return board;
      }),
      create: vi.fn(async (input: NewBoard) => {
        const id = input.id ?? nextId('board');
        const board: Board = {
          id,
          spaceId: input.spaceId ?? 'personal',
          noteId: input.noteId ?? null,
          title: input.title,
          background: input.background ?? 'dot',
          snapshot: input.snapshot ?? {},
          thumbnailKey: input.thumbnailKey ?? null,
          createdAt: timestamp(),
          updatedAt: timestamp(),
          deletedAt: null,
          version: 1,
        };
        boards.set(id, board);
        return board;
      }),
      update: boardUpdate,
      remove: vi.fn(async (id: string) => {
        const current = boards.get(id);
        if (!current) {
          throw new Error('not found');
        }
        boards.set(id, {
          ...current,
          deletedAt: timestamp(),
          version: current.version + 1,
        });
      }),
      nodes: {
        list: vi.fn(async (boardId: string, includeDeleted = false) =>
          [...nodes.values()].filter(
            (node) =>
              node.boardId === boardId && (includeDeleted || !node.deletedAt),
          ),
        ),
        create: nodeCreate,
        update: nodeUpdate,
        remove: nodeRemove,
      },
      edges: {
        list: vi.fn(async (boardId: string, includeDeleted = false) =>
          [...edges.values()].filter(
            (edge) =>
              edge.boardId === boardId && (includeDeleted || !edge.deletedAt),
          ),
        ),
        create: edgeCreate,
        update: edgeUpdate,
        remove: edgeRemove,
      },
    },
  } as unknown as DbClient;

  return {
    client,
    boards,
    nodes,
    edges,
    spies: {
      boardUpdate,
      nodeCreate,
      nodeUpdate,
      nodeRemove,
      edgeCreate,
      edgeUpdate,
      edgeRemove,
    },
  };
}

function saveInput(overrides: Partial<SaveBoardInput> = {}): SaveBoardInput {
  return {
    noteId: 'note-1',
    title: '流程',
    background: 'dot',
    nodes: [
      {
        id: 'n1',
        type: 'start',
        x: 100,
        y: 100,
        width: 100,
        height: 50,
        rotation: 0,
        zIndex: 0,
        text: '开始',
        payload: { style: { fill: '#eef8f1' }, locked: false },
      },
      {
        id: 'n2',
        type: 'decision',
        x: 300,
        y: 100,
        width: 120,
        height: 70,
        rotation: 0,
        zIndex: 1,
        text: '判断？',
        payload: {},
      },
    ],
    edges: [
      {
        id: 'e1',
        fromNodeId: 'n1',
        toNodeId: 'n2',
        label: '是',
        style: { routing: 'curve', arrow: 'end', fromSide: 'r', toSide: 'l' },
      },
    ],
    ...overrides,
  };
}

describe('画板仓储', () => {
  it('创建画板：标题去空格，默认背景 dot；load 映射 camelCase', async () => {
    const store = createFakeStore();
    const repository = createBoardRepository(store.client);
    const created = await repository.create({
      id: 'b1',
      noteId: 'note-1',
      title: '  需求评审  ',
    });
    expect(created.board.id).toBe('b1');
    expect(created.board.title).toBe('需求评审');
    expect(created.board.background).toBe('dot');
    expect(created.nodes).toEqual([]);
    expect(created.edges).toEqual([]);

    const emptyTitle = await repository.create({ id: 'b2', title: '   ' });
    expect(emptyTitle.board.title).toBe('未命名画板');

    const loaded = await repository.load('b1');
    expect(loaded.board.noteId).toBe('note-1');
  });

  it('save 以整份文档做最小 diff，重复保存不产生无意义更新', async () => {
    const store = createFakeStore();
    const repository = createBoardRepository(store.client);
    await repository.create({ id: 'b1' });

    const first = await repository.save('b1', saveInput());
    expect(first.nodes.map((node) => node.id).sort()).toEqual(['n1', 'n2']);
    expect(first.edges).toHaveLength(1);
    expect(store.spies.nodeCreate).toHaveBeenCalledTimes(2);
    expect(store.spies.edgeCreate).toHaveBeenCalledTimes(1);

    await repository.save('b1', saveInput());
    expect(store.spies.nodeCreate).toHaveBeenCalledTimes(2);
    expect(store.spies.nodeUpdate).not.toHaveBeenCalled();
    expect(store.spies.edgeCreate).toHaveBeenCalledTimes(1);
    expect(store.spies.edgeUpdate).not.toHaveBeenCalled();
    expect(store.spies.boardUpdate).toHaveBeenCalledTimes(2);
    const board = await store.client.boards.get('b1');
    expect(board.snapshot).toEqual({
      version: 1,
      nodeCount: 2,
      edgeCount: 1,
    });
  });

  it('保存时先删连线再删节点，再新增/更新节点，最后更新连线与画板', async () => {
    const store = createFakeStore();
    const repository = createBoardRepository(store.client);
    await repository.create({ id: 'b1' });
    await repository.save('b1', saveInput());

    const next = saveInput({
      nodes: [
        {
          id: 'n1',
          type: 'start',
          x: 150,
          y: 120,
          width: 100,
          height: 50,
          rotation: 0,
          zIndex: 0,
          text: '开始',
          payload: { style: { fill: '#eef8f1' }, locked: false },
        },
        {
          id: 'n3',
          type: 'process',
          x: 500,
          y: 200,
          width: 120,
          height: 60,
          rotation: 0,
          zIndex: 1,
          text: '新步骤',
          payload: {},
        },
      ],
      edges: [
        {
          id: 'e2',
          fromNodeId: 'n1',
          toNodeId: 'n3',
          label: '',
          style: { routing: 'straight', fromSide: 'r', toSide: 'l' },
        },
      ],
    });
    await repository.save('b1', next);

    expect(store.spies.nodeUpdate).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({ x: 150, y: 120 }),
    );
    expect(store.spies.nodeRemove).toHaveBeenCalledWith('n2');
    expect(store.spies.nodeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'n3' }),
    );
    expect(store.spies.edgeRemove).toHaveBeenCalledWith('e1');
    expect(store.spies.edgeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e2' }),
    );
    expect(
      store.spies.edgeRemove.mock.invocationCallOrder[0],
    ).toBeLessThan(store.spies.nodeRemove.mock.invocationCallOrder[0]);
    expect(
      store.spies.nodeCreate.mock.invocationCallOrder.at(-1)!,
    ).toBeLessThan(store.spies.edgeCreate.mock.invocationCallOrder.at(-1)!);

    const loaded = await repository.load('b1');
    expect(loaded.nodes.map((node) => node.id).sort()).toEqual(['n1', 'n3']);
    expect(loaded.edges.map((edge) => edge.id)).toEqual(['e2']);
  });

  it('校验重复 id、自连与悬空端点；出错前不写任何行', async () => {
    const store = createFakeStore();
    const repository = createBoardRepository(store.client);
    await repository.create({ id: 'b1' });

    await expect(
      repository.save(
        'b1',
        saveInput({
          nodes: [saveInput().nodes[0], saveInput().nodes[0]],
          edges: [],
        }),
      ),
    ).rejects.toThrow(BoardRepositoryError);
    await expect(
      repository.save(
        'b1',
        saveInput({
          edges: [
            {
              id: 'self',
              fromNodeId: 'n1',
              toNodeId: 'n1',
              label: '',
              style: {},
            },
          ],
        }),
      ),
    ).rejects.toThrow(/同一个对象/);
    await expect(
      repository.save(
        'b1',
        saveInput({
          edges: [
            {
              id: 'dangling',
              fromNodeId: 'n1',
              toNodeId: 'missing',
              label: '',
              style: {},
            },
          ],
        }),
      ),
    ).rejects.toThrow(/端点/);

    expect(store.spies.nodeCreate).not.toHaveBeenCalled();
    expect(store.spies.edgeCreate).not.toHaveBeenCalled();
    expect(store.spies.boardUpdate).not.toHaveBeenCalled();
  });

  it('导出公开 JSON：version=1，包含 boardId/noteId/title/background/nodes/edges', async () => {
    const store = createFakeStore();
    const repository = createBoardRepository(store.client);
    await repository.create({ id: 'b1', noteId: 'note-1', title: '流程' });
    await repository.save('b1', saveInput());

    const exported = await repository.exportDocument('b1');
    expect(exported.version).toBe(1);
    expect(exported.boardId).toBe('b1');
    expect(exported.noteId).toBe('note-1');
    expect(exported.title).toBe('流程');
    expect(exported.nodes).toHaveLength(2);
    expect(exported.edges).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(exported)).edges[0].style.routing).toBe(
      'curve',
    );
  });

  it('删除画板后 load 失败，但列表可包含软删除', async () => {
    const store = createFakeStore();
    const repository = createBoardRepository(store.client);
    await repository.create({ id: 'b1' });
    await repository.remove('b1');
    await expect(repository.load('b1')).rejects.toThrow();
    const all = await store.client.boards.list({ includeDeleted: true });
    expect(all[0].deletedAt).toBeTruthy();
  });
});
