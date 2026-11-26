import type { Note } from '../../../../data/db/types';
import type { EditorBlock } from '../../../../data/repositories/blocks';
import { sampleDocument } from '../../../board/__tests__/fakeBoardSource';
import type { BoardDocument } from '../../../board/types';
import {
  tablePayloadRows,
  type TableModel,
} from '../../../editor/types';
import { makeBlock } from '../../../editor/__tests__/fakeBlockSource';
import {
  buildNoteExportDocument,
  type RenderNoteBoard,
  type ResolveNoteAttachment,
  type ResolveNoteBoard,
} from '../document';
import type { NoteExportOptions } from '../types';

export const NOW = new Date('2026-10-28T09:12:00+08:00');

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2S8AAAAASUVORK5CYII=';

export function pngBytes(): Uint8Array {
  const binary = globalThis.atob(PNG_BASE64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function noteFixture(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-a',
    spaceId: 'personal',
    title: '导出结构',
    folderId: 'f1',
    tags: ['知识管理', '导出'],
    body: '',
    bodyFormat: 'html',
    status: 'active',
    favorite: true,
    pinned: false,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-28T01:12:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function tableModel(): TableModel {
  return {
    schemaVersion: 2,
    header: true,
    widths: [220, 140],
    rows: [
      [
        {
          text: '模块',
          align: 'left',
          rowSpan: 1,
          colSpan: 2,
          covered: false,
        },
        {
          text: '',
          align: 'left',
          rowSpan: 1,
          colSpan: 1,
          covered: true,
        },
      ],
      [
        {
          text: '附件',
          align: 'left',
          rowSpan: 2,
          colSpan: 1,
          covered: false,
        },
        {
          text: '打开 / 另存为',
          align: 'center',
          rowSpan: 1,
          colSpan: 1,
          covered: false,
        },
      ],
      [
        {
          text: '',
          align: 'left',
          rowSpan: 1,
          colSpan: 1,
          covered: true,
        },
        {
          text: '哈希校验',
          align: 'right',
          rowSpan: 1,
          colSpan: 1,
          covered: false,
        },
      ],
    ],
  };
}

export function blocksFixture(): EditorBlock[] {
  const noteId = 'note-a';
  const model = tableModel();
  return [
    makeBlock({
      id: 'b1',
      noteId,
      type: 'heading1',
      orderKey: 1024,
      payload: { runs: [{ text: '概述' }] },
    }),
    makeBlock({
      id: 'b2',
      noteId,
      type: 'paragraph',
      orderKey: 2048,
      payload: {
        runs: [
          { text: '重点', marks: { bold: true, color: '#FF403C' } },
          { text: ' 和 ' },
          {
            text: '外链',
            marks: { link: 'https://example.com/doc' },
          },
          { text: ' 及 ' },
          {
            text: '关联笔记',
            marks: { link: 'zhixing://note/note-b' },
          },
        ],
      },
    }),
    makeBlock({
      id: 'b3',
      noteId,
      type: 'todo',
      orderKey: 3072,
      payload: { runs: [{ text: '完成导出' }], checked: true },
    }),
    makeBlock({
      id: 'b4',
      noteId,
      type: 'bullet_list',
      orderKey: 4096,
      payload: { runs: [{ text: '无序项' }] },
    }),
    makeBlock({
      id: 'b5',
      noteId,
      type: 'ordered_list',
      orderKey: 5120,
      payload: { runs: [{ text: '第一步' }] },
    }),
    makeBlock({
      id: 'b6',
      noteId,
      type: 'ordered_list',
      orderKey: 6144,
      payload: { runs: [{ text: '第二步' }] },
    }),
    makeBlock({
      id: 'b7',
      noteId,
      type: 'quote',
      orderKey: 7168,
      payload: {
        runs: [{ text: '引用一段原则' }],
        source: '设计规范',
        sourceUrl: 'https://example.com/spec',
        noteId: 'note-b',
      },
    }),
    makeBlock({
      id: 'b8',
      noteId,
      type: 'code',
      orderKey: 8192,
      payload: {
        code: 'const save = await saveFile({ name });',
        language: 'typescript',
      },
    }),
    makeBlock({
      id: 'b9',
      noteId,
      type: 'table',
      orderKey: 9216,
      payload: { rows: tablePayloadRows(model) },
    }),
    makeBlock({
      id: 'b10',
      noteId,
      type: 'image',
      orderKey: 10240,
      payload: {
        attachmentId: 'att-image',
        fileName: '架构图.png',
        mime: 'image/png',
        byteSize: pngBytes().byteLength,
        alt: '架构图',
        width: 1,
        height: 1,
      },
    }),
    makeBlock({
      id: 'b11',
      noteId,
      type: 'file',
      orderKey: 11264,
      payload: {
        attachmentId: 'att-file',
        fileName: '需求说明.pdf',
        mime: 'application/pdf',
        byteSize: 1_258_291,
        status: 'missing',
      },
    }),
    makeBlock({
      id: 'b12',
      noteId,
      type: 'board',
      orderKey: 12288,
      payload: { boardId: 'board-a', title: '发布流程' },
    }),
    makeBlock({
      id: 'b13',
      noteId,
      type: 'formula',
      orderKey: 13312,
      payload: { latex: 'E = mc^2', display: 'block' },
    }),
    makeBlock({
      id: 'b14',
      noteId,
      type: 'link',
      orderKey: 14336,
      payload: { url: 'https://example.com/', title: '示例站点' },
    }),
    makeBlock({
      id: 'b15',
      noteId,
      type: 'divider',
      orderKey: 15360,
      payload: {},
    }),
  ];
}

export const resolveAsset: ResolveNoteAttachment = async (
  attachmentId,
  fallback,
) => {
  if (attachmentId === 'att-image') {
    const bytes = pngBytes();
    return {
      blob: new Blob([bytes.slice().buffer], { type: 'image/png' }),
      bytes,
      sha256: 'a'.repeat(64),
      status: 'available',
      error: null,
      fileName: fallback.fileName,
      mime: 'image/png',
      byteSize: bytes.byteLength,
    };
  }
  return {
    blob: null,
    bytes: null,
    sha256: null,
    status: 'missing',
    error: '本机没有这个附件',
    fileName: fallback.fileName,
    mime: fallback.mime,
    byteSize: fallback.byteSize,
  };
};

/** 与 `board-a` 对应的完整画板文档；测试可据此断言只加载一次。 */
export function boardDocumentFixture(
  overrides: Partial<BoardDocument> = {},
): BoardDocument {
  return {
    ...sampleDocument(),
    boardId: 'board-a',
    noteId: 'note-a',
    title: '发布流程',
    ...overrides,
  };
}

export const resolveBoard: ResolveNoteBoard = async (boardId) =>
  boardId === 'board-a' ? boardDocumentFixture() : null;

export const renderBoard: RenderNoteBoard = async () => {
  const bytes = pngBytes();
  return {
    blob: new Blob([bytes.slice().buffer], { type: 'image/png' }),
    bytes,
    mime: 'image/png',
    width: 640,
    height: 360,
    limited: false,
  };
};

export function docxOptions(): NoteExportOptions {
  return {
    format: 'docx',
    includeMetadata: true,
    includeImages: true,
    pdfPaper: 'A4',
  };
}

export async function fixtureDocument(
  options: NoteExportOptions = docxOptions(),
  overrides: {
    includeImage?: boolean;
    blocks?: EditorBlock[];
    resolveBoard?: ResolveNoteBoard;
    renderBoard?: RenderNoteBoard;
  } = {},
) {
  const blocks = overrides.blocks ?? blocksFixture();
  return buildNoteExportDocument({
    note: noteFixture(),
    blocks: overrides.includeImage === false
      ? blocks.filter((block) => block.type !== 'image')
      : blocks,
    options,
    folderName: '产品设计',
    noteTitles: new Map([['note-b', '目标笔记']]),
    resolveAttachment: resolveAsset,
    resolveBoard: overrides.resolveBoard ?? resolveBoard,
    renderBoard: overrides.renderBoard ?? renderBoard,
    now: NOW,
  });
}
