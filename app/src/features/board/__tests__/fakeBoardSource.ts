import { cloneJson, createEmptyDocument } from '../model';
import type { BoardDocument, BoardSource } from '../types';

export type FakeBoardSource = {
  source: BoardSource;
  saves: BoardDocument[];
  created: BoardDocument[];
  getStored: () => BoardDocument | null;
};

/** 内存 BoardSource：与真实仓储同样返回整份 BoardDocument。 */
export function createFakeBoardSource(
  initial: BoardDocument | null = null,
): FakeBoardSource {
  let stored = initial ? cloneJson(initial) : null;
  let sequence = 0;
  const saves: BoardDocument[] = [];
  const created: BoardDocument[] = [];

  const source: BoardSource = {
    list: async () =>
      stored
        ? [
            {
              id: stored.boardId,
              title: stored.title,
              noteId: stored.noteId,
              updatedAt: '2026-10-26T00:00:00.000Z',
            },
          ]
        : [],

    load: async (boardId) => {
      if (!stored || stored.boardId !== boardId) {
        throw new Error(`画板不存在：${boardId}`);
      }
      return cloneJson(stored);
    },

    create: async (input = {}) => {
      sequence += 1;
      const document = createEmptyDocument({
        boardId: input.id ?? `fake-board-${sequence}`,
        noteId: input.noteId ?? null,
        title: input.title ?? '未命名画板',
      });
      stored = document;
      created.push(cloneJson(document));
      return cloneJson(document);
    },

    save: async (boardId, document) => {
      const saved = cloneJson({ ...document, boardId });
      stored = saved;
      saves.push(cloneJson(saved));
      return cloneJson(saved);
    },

    remove: async () => {
      stored = null;
    },
  };

  return {
    source,
    saves,
    created,
    getStored: () => (stored ? cloneJson(stored) : null),
  };
}

export function sampleDocument(): BoardDocument {
  return {
    version: 1,
    boardId: 'board-1',
    noteId: 'note-1',
    title: '测试画板',
    background: 'dot',
    nodes: [
      {
        id: 'n-a',
        type: 'pill',
        x: 100,
        y: 100,
        width: 130,
        height: 54,
        rotation: 0,
        zIndex: 0,
        text: '开始',
        payload: { style: { fill: '#eef8f1' }, locked: false },
      },
      {
        id: 'n-b',
        type: 'rect',
        x: 340,
        y: 100,
        width: 170,
        height: 58,
        rotation: 0,
        zIndex: 1,
        text: '收集信息',
        payload: { style: { fill: '#ffffff' }, locked: false },
      },
      {
        id: 'n-c',
        type: 'diamond',
        x: 610,
        y: 90,
        width: 160,
        height: 84,
        rotation: 0,
        zIndex: 2,
        text: '继续？',
        payload: { style: { fill: '#fff8e9' }, locked: false },
      },
    ],
    edges: [
      {
        id: 'e-a',
        fromNodeId: 'n-a',
        toNodeId: 'n-b',
        label: '',
        style: {
          routing: 'curve',
          arrow: 'end',
          color: '#9fb0c2',
          width: 1.5,
          dashed: false,
          fromSide: 'r',
          toSide: 'l',
        },
      },
      {
        id: 'e-b',
        fromNodeId: 'n-b',
        toNodeId: 'n-c',
        label: '是',
        style: {
          routing: 'curve',
          arrow: 'end',
          color: '#9fb0c2',
          width: 1.5,
          dashed: false,
          fromSide: 'r',
          toSide: 'l',
        },
      },
    ],
  };
}
