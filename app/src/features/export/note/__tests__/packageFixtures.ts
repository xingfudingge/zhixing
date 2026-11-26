/**
 * `.zxnote` 测试共用的笔记/画板/附件夹具。
 *
 * 导出侧与导入侧测试都从同一份数据出发，避免“导出测试一套、导入测试
 * 另一套”导致往返等价被悄悄放宽。
 */

import { vi } from 'vitest';

import type { Note, NoteTodo } from '../../../../data/db/types';
import type { EditorBlock } from '../../../../data/repositories/blocks';
import type { BoardDocument, BoardViewport } from '../../../board/types';
import { sha256Bytes } from '../../../attachments/sha256';
import { makeBlock } from '../../../editor/__tests__/fakeBlockSource';
import type { BuildNotePackageInput } from '../package';
import { pngBytes } from './fixtures';

export const NOW = new Date(2026, 9, 29, 8, 30, 0);
export const png = pngBytes();
export const pngSha = sha256Bytes(png);
export const VIEWPORT: BoardViewport = { x: -40, y: -30, zoom: 0.9 };

export function noteFixture(): Note {
  return {
    id: 'note-a',
    spaceId: 'personal',
    title: '发布流程',
    folderId: 'f1',
    tags: ['产品', '流程'],
    body: '<p>兼容缓存</p>',
    bodyFormat: 'html',
    status: 'active',
    favorite: true,
    pinned: true,
    createdAt: '2026-10-20T09:10:00.000Z',
    updatedAt: '2026-10-28T16:22:00.000Z',
    deletedAt: null,
    version: 1,
  };
}

export function noteTodosFixture(): NoteTodo[] {
  return [
    {
      id: 'todo-1',
      spaceId: 'personal',
      noteId: 'note-a',
      taskId: null,
      title: '确认评审时间',
      done: false,
      dueDate: '2026-11-02',
      reminderEnabled: true,
      sortOrder: 0,
      createdAt: '2026-10-20T09:10:00.000Z',
      updatedAt: '2026-10-20T09:10:00.000Z',
      deletedAt: null,
      version: 1,
    },
  ];
}

export function boardFixture(): BoardDocument {
  return {
    version: 1,
    boardId: 'board-a',
    noteId: 'note-a',
    title: '发布流程',
    background: 'dot',
    nodes: [
      {
        id: 'node-1',
        type: 'round',
        x: 0,
        y: 0,
        width: 180,
        height: 56,
        rotation: 0,
        zIndex: 0,
        text: '开始',
        payload: {
          style: { fill: '#ffffff', stroke: '#5579d5' },
          locked: false,
          unknownFutureField: { keep: true },
        },
      },
      {
        id: 'node-2',
        type: 'rect',
        x: 260,
        y: 0,
        width: 180,
        height: 56,
        rotation: 0,
        zIndex: 1,
        text: '结束',
        payload: {},
      },
    ],
    edges: [
      {
        id: 'edge-1',
        fromNodeId: 'node-1',
        toNodeId: 'node-2',
        label: '通过',
        style: { routing: 'elbow', arrow: 'end', color: '#5579d5' },
      },
    ],
  };
}

export function blocksFixture(): EditorBlock[] {
  const noteId = 'note-a';
  return [
    makeBlock({
      id: 'block-1',
      noteId,
      type: 'heading1',
      orderKey: 1024,
      payload: { runs: [{ text: '发布流程' }] },
    }),
    makeBlock({
      id: 'block-2',
      noteId,
      type: 'paragraph',
      orderKey: 2048,
      payload: {
        runs: [
          { text: '自引用 ', marks: { link: 'zhixing://note/note-a' } },
          { text: '外部 ', marks: { link: 'zhixing://note/note-other' } },
        ],
      },
    }),
    makeBlock({
      id: 'block-3',
      noteId,
      type: 'board',
      orderKey: 3072,
      payload: { boardId: 'board-a', title: '发布流程' },
    }),
    makeBlock({
      id: 'block-4',
      noteId,
      type: 'todo',
      orderKey: 4096,
      payload: {
        runs: [{ text: '确认评审时间' }],
        checked: false,
        todoId: 'todo-1',
      },
    }),
    makeBlock({
      id: 'block-5',
      noteId,
      type: 'file',
      orderKey: 5120,
      payload: {
        attachmentId: 'att-image',
        fileName: '发布流程.png',
        mime: 'image/png',
        byteSize: png.byteLength,
        status: 'local',
      },
    }),
  ];
}

export function buildInput(
  overrides: Partial<BuildNotePackageInput> = {},
): BuildNotePackageInput {
  return {
    note: noteFixture(),
    blocks: blocksFixture(),
    noteTodos: noteTodosFixture(),
    folderName: '产品设计',
    loadBoard: vi.fn().mockResolvedValue({
      document: boardFixture(),
      viewport: VIEWPORT,
    }),
    resolveAttachment: vi.fn().mockResolvedValue({
      fileName: '发布流程.png',
      mime: 'image/png',
      sha256: pngSha,
      byteSize: png.byteLength,
      bytes: png,
    }),
    now: NOW,
    ...overrides,
  };
}
