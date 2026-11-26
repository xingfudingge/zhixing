import { describe, expect, it, vi } from 'vitest';

import type {
  Attachment,
  Note,
  NoteBlock,
  NoteTodo,
} from '../../../data/db/types';
import type { BoardDocument, BoardViewport } from '../../board/types';
import {
  buildInput,
  NOW,
  png,
  pngSha,
} from '../../export/note/__tests__/packageFixtures';
import {
  buildNotePackage,
  NOTE_PACKAGE_MAX_BYTES,
  saveNotePackageToFile,
} from '../../export/note/package';
import { createZip, readZip } from '../../export/zip';
import {
  applyNotePackageImport,
  NOTE_PACKAGE_IMPORT_ACCEPT,
  NotePackageImportError,
  parseNotePackage,
  planNotePackageImport,
  type NotePackageImportPlan,
  type NotePackageImportTarget,
  type ParsedNotePackage,
} from '../notePackage';

type MemoryStore = {
  notes: Note[];
  blocks: NoteBlock[];
  todos: NoteTodo[];
  boards: Map<
    string,
    { document: BoardDocument; viewport: BoardViewport | null }
  >;
  attachments: Map<string, { metadata: Attachment; bytes: Uint8Array }>;
};

function emptyStore(): MemoryStore {
  return {
    notes: [],
    blocks: [],
    todos: [],
    boards: new Map(),
    attachments: new Map(),
  };
}

function createMemoryTarget(store: MemoryStore): NotePackageImportTarget {
  return {
    async apply(plan: NotePackageImportPlan) {
      // 先整体检查主键冲突，再一次性写入：模拟单事务的“全有或全无”。
      const noteIds = new Set(store.notes.map((note) => note.id));
      const blockIds = new Set(store.blocks.map((block) => block.id));
      const todoIds = new Set(store.todos.map((todo) => todo.id));
      const boardIds = new Set(store.boards.keys());
      if (noteIds.has(plan.noteId)) {
        throw new NotePackageImportError(
          'ZXNOTE_ID_COLLISION',
          `笔记主键冲突：${plan.noteId}`,
        );
      }
      for (const block of plan.blocks) {
        if (blockIds.has(block.id)) {
          throw new NotePackageImportError(
            'ZXNOTE_ID_COLLISION',
            `块主键冲突：${block.id}`,
          );
        }
      }
      for (const todo of plan.todos) {
        if (todoIds.has(todo.id)) {
          throw new NotePackageImportError(
            'ZXNOTE_ID_COLLISION',
            `待办主键冲突：${todo.id}`,
          );
        }
      }
      for (const board of plan.boards) {
        if (boardIds.has(board.boardId)) {
          throw new NotePackageImportError(
            'ZXNOTE_ID_COLLISION',
            `画板主键冲突：${board.boardId}`,
          );
        }
      }

      const now = '2026-10-29T00:00:00.000Z';
      const note: Note = {
        id: plan.noteId,
        spaceId: 'personal',
        title: plan.note.title,
        folderId: plan.note.folderId ?? null,
        tags: [...(plan.note.tags ?? [])],
        body: plan.note.body ?? '',
        bodyFormat: 'html',
        status: 'active',
        favorite: plan.note.favorite ?? false,
        pinned: plan.note.pinned ?? false,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      };
      const blocks: NoteBlock[] = plan.blocks.map((block) => ({
        id: block.id,
        noteId: plan.noteId,
        blockType: block.blockType,
        orderKey: block.orderKey,
        payload: block.payload,
        schemaVersion: block.schemaVersion ?? 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      }));
      const todos: NoteTodo[] = plan.todoDetails.map((todo) => ({
        id: todo.id,
        spaceId: 'personal',
        noteId: plan.noteId,
        taskId: null,
        title: todo.title,
        done: todo.done,
        dueDate: todo.dueDate,
        reminderEnabled: todo.reminderEnabled,
        sortOrder: todo.sortOrder,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 1,
      }));
      const boards = plan.boards.map((board) => ({
        id: board.boardId,
        document: board.document,
        viewport: board.viewport,
      }));
      const newAttachments = plan.attachmentWrites
        .filter((attachment) => !attachment.reused)
        .map((attachment) => ({
          metadata: {
            id: attachment.id,
            spaceId: 'personal',
            noteId: plan.noteId,
            blockId: attachment.blockId,
            fileName: attachment.fileName,
            sha256: attachment.sha256,
            byteSize: attachment.byteSize,
            mime: attachment.mime,
            storageKey: `spaces/personal/assets/${attachment.sha256}`,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            version: 1,
          } satisfies Attachment,
          bytes: attachment.bytes,
        }));

      store.notes.push(note);
      store.blocks.push(...blocks);
      store.todos.push(...todos);
      for (const board of boards) {
        store.boards.set(board.id, {
          document: board.document,
          viewport: board.viewport,
        });
      }
      for (const attachment of newAttachments) {
        store.attachments.set(attachment.metadata.id, attachment);
      }
      return {
        note,
        boardIds: boards.map((board) => board.id),
        createdAttachments: newAttachments.length,
        reusedAttachments: plan.attachmentWrites.filter(
          (attachment) => attachment.reused,
        ).length,
      };
    },
  };
}

async function buildPackage() {
  return buildNotePackage(buildInput());
}

async function parse(report: { bytes: Uint8Array }): Promise<ParsedNotePackage> {
  return parseNotePackage({ bytes: report.bytes, fileName: '发布流程.zxnote' });
}

function nextIdFactory() {
  let sequence = 0;
  return (prefix: string) => {
    sequence += 1;
    return `${prefix}-new-${sequence}`;
  };
}

async function importOnce(
  parsed: ParsedNotePackage,
  store: MemoryStore,
  idFactory = nextIdFactory(),
) {
  const plan = planNotePackageImport(parsed, {
    idFactory,
    folders: [{ id: 'f1', name: '产品设计' }],
  });
  const result = await applyNotePackageImport(
    plan,
    createMemoryTarget(store),
  );
  return { plan, result };
}

async function expectCode(
  run: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await run();
    throw new Error(`expected ${code}`);
  } catch (reason) {
    expect(reason).toBeInstanceOf(NotePackageImportError);
    expect((reason as NotePackageImportError).code).toBe(code);
  }
}

async function rewritePackage(
  report: { bytes: Uint8Array },
  mutate: (files: Map<string, Uint8Array>) => void,
): Promise<Uint8Array> {
  const entries = await readZip(report.bytes);
  const files = new Map(entries.map((entry) => [entry.path, entry.data]));
  mutate(files);
  return createZip(
    entries.map((entry) => ({
      path: entry.path,
      data: files.get(entry.path)!,
    })),
  );
}

// ---------------------------------------------------------------------------
// 往返 canonical
// ---------------------------------------------------------------------------

type CanonicalPackage = ReturnType<typeof canonicalize>;

function canonicalize(parsed: ParsedNotePackage) {
  const sourceNoteId = parsed.note.sourceId;
  const boardIndex = new Map(
    parsed.boards.map((board, index) => [board.sourceId, index]),
  );
  const nodeIndex = new Map<string, Map<string, number>>();
  for (const board of parsed.boards) {
    if (!board.document) continue;
    nodeIndex.set(
      board.sourceId,
      new Map(board.document.nodes.map((node, index) => [node.id, index])),
    );
  }
  const attachmentToken = new Map<string, string>();
  for (const item of parsed.attachments) {
    for (const sourceId of item.sourceIds) {
      attachmentToken.set(
        sourceId,
        item.sha256 ? `@att-${item.sha256}` : '@att-missing',
      );
    }
  }
  const todoIndex = new Map(
    parsed.note.noteTodos.map((todo, index) => [todo.sourceId, index]),
  );

  const rewriteString = (value: string): string =>
    value.split(`zhixing://note/${sourceNoteId}`).join('zhixing://note/@note');

  const rewrite = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string') {
      if (key === 'boardId') {
        const index = boardIndex.get(value);
        return index === undefined ? value : `@board-${index}`;
      }
      if (key === 'attachmentId') {
        return attachmentToken.get(value) ?? value;
      }
      if (key === 'todoId') {
        const index = todoIndex.get(value);
        return index === undefined ? value : `@todo-${index}`;
      }
      if (key === 'noteId') {
        return value === sourceNoteId ? '@note' : value;
      }
      return rewriteString(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => rewrite(item));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([childKey, child]) => [childKey, rewrite(child, childKey)],
        ),
      );
    }
    return value;
  };

  return {
    note: {
      title: parsed.note.title,
      folderName: parsed.note.folder?.name ?? null,
      tags: [...parsed.note.tags].sort(),
      favorite: parsed.note.favorite,
      pinned: parsed.note.pinned,
      bodyFormat: parsed.note.bodyFormat,
    },
    todos: parsed.note.noteTodos.map((todo) => ({
      title: todo.title,
      done: todo.done,
      dueDate: todo.dueDate,
      reminderEnabled: todo.reminderEnabled,
      sortOrder: todo.sortOrder,
    })),
    blocks: parsed.blocks.map((block) => ({
      type: block.type,
      schemaVersion: block.schemaVersion,
      payload: rewrite(block.payload),
    })),
    boards: parsed.boards.map((board) => {
      const document = board.document!;
      const nodes = document.nodes.map((node) => node.id);
      const index = new Map(nodes.map((id, position) => [id, position]));
      return {
        title: document.title,
        background: document.background,
        viewport: board.viewport,
        nodes: document.nodes.map((node) => ({
          type: node.type,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          rotation: node.rotation,
          zIndex: node.zIndex,
          text: node.text,
          payload: rewrite(node.payload),
        })),
        edges: document.edges.map((edge) => ({
          from: index.get(edge.fromNodeId),
          to: index.get(edge.toNodeId),
          label: edge.label,
          style: rewrite(edge.style),
        })),
      };
    }),
    attachments: parsed.attachments
      .filter((item) => !item.missing)
      .map((item) => ({
        fileName: item.fileName,
        mime: item.mime,
        sha256: item.sha256,
        byteSize: item.byteSize,
      }))
      .sort((a, b) => (a.sha256 ?? '').localeCompare(b.sha256 ?? '')),
  } satisfies Record<string, unknown>;
}

async function exportStore(
  store: MemoryStore,
  noteId: string,
): Promise<{ bytes: Uint8Array }> {
  const note = store.notes.find((row) => row.id === noteId)!;
  const blocks = store.blocks.filter((block) => block.noteId === noteId);
  const todos = store.todos.filter((todo) => todo.noteId === noteId);
  return buildNotePackage({
    note,
    blocks: blocks.map((block) => ({
      ...block,
      type: block.blockType,
      payload: block.payload as never,
    })),
    noteTodos: todos,
    folderName: '产品设计',
    now: NOW,
    loadBoard: async (boardId) => {
      const board = store.boards.get(boardId);
      return board
        ? { document: board.document, viewport: board.viewport }
        : null;
    },
    resolveAttachment: async (attachmentId) => {
      const row = store.attachments.get(attachmentId);
      if (!row) return null;
      return {
        fileName: row.metadata.fileName,
        mime: row.metadata.mime,
        sha256: row.metadata.sha256,
        byteSize: row.metadata.byteSize,
        bytes: row.bytes,
      };
    },
  });
}

// ---------------------------------------------------------------------------

describe('知行笔记包 · 导入与重映射（ZX5-IO-06）', () => {
  it('解析包并预览：块/画板/附件/待办计数与校验通过', async () => {
    const parsed = await parse(await buildPackage());
    expect(parsed.preview).toMatchObject({
      kind: 'note-package',
      formatVersion: 1,
      title: '发布流程',
      blockCount: 5,
      boardCount: 1,
      boardNodeCount: 2,
      boardEdgeCount: 1,
      attachmentCount: 1,
      todoCount: 1,
    });
    expect(parsed.preview.checks).toEqual({
      zip: true,
      version: true,
      checksums: true,
      structure: true,
      references: true,
    });
    expect(parsed.attachments[0]!.bytes).toEqual(png);
    expect(parsed.boards[0]!.viewport).toEqual({ x: -40, y: -30, zoom: 0.9 });
  });

  it('创建全新 note/block/todo/board/node/edge/attachment ID 并改写引用', async () => {
    const parsed = await parse(await buildPackage());
    const store = emptyStore();
    const { plan, result } = await importOnce(parsed, store);

    expect(plan.noteId).not.toBe('note-a');
    expect(result.note.id).toBe(plan.noteId);
    expect(store.notes).toHaveLength(1);
    expect(store.blocks).toHaveLength(5);
    expect(store.todos).toHaveLength(1);
    expect(store.boards).toHaveLength(1);
    expect(store.attachments.size).toBe(1);

    const blockIds = store.blocks.map((block) => block.id);
    expect(new Set(blockIds).size).toBe(5);
    for (const id of ['block-1', 'block-2', 'block-3', 'block-4', 'block-5']) {
      expect(blockIds).not.toContain(id);
    }

    const boardBlock = store.blocks.find(
      (block) => block.blockType === 'board',
    )!;
    const board = Array.from(store.boards.values())[0]!;
    expect(boardBlock.payload).toMatchObject({
      boardId: board.document.boardId,
      title: '发布流程',
    });

    const fileBlock = store.blocks.find(
      (block) => block.blockType === 'file',
    )!;
    const attachment = Array.from(store.attachments.values())[0]!;
    expect(fileBlock.payload).toMatchObject({
      attachmentId: attachment.metadata.id,
      fileName: '发布流程.png',
      mime: 'image/png',
      byteSize: png.byteLength,
      status: 'local',
    });
    expect(attachment.metadata.sha256).toBe(pngSha);
    expect(attachment.bytes).toEqual(png);

    const todoBlock = store.blocks.find(
      (block) => block.blockType === 'todo',
    )!;
    expect(
      (todoBlock.payload as Record<string, unknown>).todoId,
    ).toBe(store.todos[0]!.id);
    expect(store.todos[0]).toMatchObject({
      title: '确认评审时间',
      done: false,
      dueDate: '2026-11-02',
      reminderEnabled: true,
    });

    const document = board.document;
    expect(document.noteId).toBe(plan.noteId);
    expect(document.nodes.map((node) => node.id)).not.toContain('node-1');
    expect(document.edges[0]).toMatchObject({
      fromNodeId: document.nodes[0]!.id,
      toNodeId: document.nodes[1]!.id,
    });
    expect(board.viewport).toEqual({ x: -40, y: -30, zoom: 0.9 });
    expect(document.nodes[0]!.payload).toMatchObject({
      locked: false,
      unknownFutureField: { keep: true },
    });

    const selfLinkBlock = store.blocks.find((block) =>
      JSON.stringify(block.payload).includes('zhixing://note/'),
    )!;
    expect(JSON.stringify(selfLinkBlock.payload)).toContain(
      `zhixing://note/${plan.noteId}`,
    );
    expect(JSON.stringify(selfLinkBlock.payload)).toContain(
      'zhixing://note/note-other',
    );
  });

  it('同一包连续导入两次：两组 ID 不同，无主键冲突', async () => {
    const parsed = await parse(await buildPackage());
    const store = emptyStore();
    const idFactory = nextIdFactory();
    const first = await importOnce(parsed, store, idFactory);
    const second = await importOnce(parsed, store, idFactory);

    expect(store.notes).toHaveLength(2);
    expect(first.result.note.id).not.toBe(second.result.note.id);
    expect(store.blocks).toHaveLength(10);
    expect(new Set(store.blocks.map((block) => block.id)).size).toBe(10);
    expect(store.boards).toHaveLength(2);
    expect(new Set(Array.from(store.boards.keys())).size).toBe(2);
  });

  it('同 SHA-256 附件复用已有记录，不新增附件行', async () => {
    const parsed = await parse(await buildPackage());
    const store = emptyStore();
    store.attachments.set('att-existing', {
      metadata: {
        id: 'att-existing',
        spaceId: 'personal',
        noteId: 'note-old',
        blockId: null,
        fileName: '发布流程.png',
        sha256: pngSha,
        byteSize: png.byteLength,
        mime: 'image/png',
        storageKey: `spaces/personal/assets/${pngSha}`,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        deletedAt: null,
        version: 1,
      },
      bytes: png,
    });
    const plan = planNotePackageImport(parsed, {
      idFactory: nextIdFactory(),
      folders: [{ id: 'f1', name: '产品设计' }],
      existingAttachments: [{ id: 'att-existing', sha256: pngSha }],
    });
    expect(plan.attachmentWrites[0]).toMatchObject({
      id: 'att-existing',
      reused: true,
    });
    const result = await applyNotePackageImport(
      plan,
      createMemoryTarget(store),
    );
    expect(result.reusedAttachments).toBe(1);
    expect(store.attachments.size).toBe(1);
    const fileBlock = plan.blocks.find(
      (block) => block.blockType === 'file',
    )!;
    expect(
      (fileBlock.payload as Record<string, unknown>).attachmentId,
    ).toBe('att-existing');
  });

  it('缺画板：笔记成功导入，画板块保留占位并警告', async () => {
    const report = await buildNotePackage(
      buildInput({ loadBoard: vi.fn().mockResolvedValue(null) }),
    );
    const parsed = await parse(report);
    const store = emptyStore();
    const { plan, result } = await importOnce(parsed, store);

    expect(result.note.id).toBe(plan.noteId);
    expect(store.boards.size).toBe(0);
    const boardBlock = store.blocks.find(
      (block) => block.blockType === 'board',
    )!;
    expect(boardBlock.payload).toMatchObject({
      boardId: null,
      title: '发布流程（画板缺失）',
    });
    expect(plan.warnings.join('\n')).toContain('画板「发布流程」');
    expect(plan.warnings.join('\n')).toContain('boardId=null');
  });

  it('缺附件：文件卡保留但引用置空并警告，不产生半成品', async () => {
    const report = await buildNotePackage(
      buildInput({ resolveAttachment: vi.fn().mockResolvedValue(null) }),
    );
    const parsed = await parse(report);
    const store = emptyStore();
    const { plan } = await importOnce(parsed, store);

    expect(store.attachments.size).toBe(0);
    const fileBlock = store.blocks.find(
      (block) => block.blockType === 'file',
    )!;
    expect(fileBlock.payload).toMatchObject({
      attachmentId: null,
      status: 'missing',
    });
    expect(plan.warnings.join('\n')).toContain('附件「发布流程.png」缺失');
  });

  it('篡改文件字节：checksum 失败，零写入', async () => {
    const report = await buildPackage();
    const tampered = await rewritePackage(report, (files) => {
      const blocks = files.get('blocks.json')!;
      const next = blocks.slice();
      next[0] = next[0]! ^ 0xff;
      files.set('blocks.json', next);
    });
    const store = emptyStore();
    await expectCode(
      async () => {
        const parsed = await parseNotePackage({
          bytes: tampered,
          fileName: '损坏包.zxnote',
        });
        await importOnce(parsed, store);
      },
      'ZXNOTE_CHECKSUM_MISMATCH',
    );
    expect(store.notes).toHaveLength(0);
    expect(store.blocks).toHaveLength(0);
    expect(store.boards.size).toBe(0);
    expect(store.attachments.size).toBe(0);
  });

  it('未来版本：明确拒绝，零写入', async () => {
    const report = await buildPackage();
    const future = await rewritePackage(report, (files) => {
      const manifest = JSON.parse(
        new TextDecoder().decode(files.get('manifest.json')!),
      ) as Record<string, unknown>;
      manifest.formatVersion = 2;
      manifest.minReaderVersion = 2;
      manifest.version = 2;
      files.set(
        'manifest.json',
        new TextEncoder().encode(JSON.stringify(manifest)),
      );
    });
    const store = emptyStore();
    await expectCode(
      async () => {
        const parsed = await parseNotePackage({
          bytes: future,
          fileName: '未来版本.zxnote',
        });
        await importOnce(parsed, store);
      },
      'ZXNOTE_VERSION_UNSUPPORTED',
    );
    expect(store.notes).toHaveLength(0);
  });

  it('导出 → 导入 → 再导出：canonical 结构等价（块/画板/附件/待办）', async () => {
    const packageA = await buildPackage();
    const parsedA = await parse(packageA);
    const store = emptyStore();
    const { plan, result } = await importOnce(parsedA, store);

    const packageB = await exportStore(store, result.note.id);
    const parsedB = await parse(packageB);

    expect(parsedB.note.sourceId).not.toBe(parsedA.note.sourceId);
    expect(
      parsedB.boards[0]!.document!.nodes.map((node) => node.id),
    ).not.toEqual(parsedA.boards[0]!.document!.nodes.map((node) => node.id));
    expect(parsedB.attachments[0]!.sha256).toBe(
      parsedA.attachments[0]!.sha256,
    );
    expect(parsedB.boards[0]!.viewport).toEqual(
      parsedA.boards[0]!.viewport,
    );

    const canonicalA: CanonicalPackage = canonicalize(parsedA);
    const canonicalB: CanonicalPackage = canonicalize(parsedB);
    expect(canonicalB).toEqual(canonicalA);
    expect(canonicalA.blocks.map((block) => block.type)).toEqual([
      'heading1',
      'paragraph',
      'board',
      'todo',
      'file',
    ]);
    expect(plan.stats).toMatchObject({
      blocks: 5,
      boards: 1,
      attachments: 1,
      todos: 1,
    });
  });
});

describe('知行笔记包 · 入口与异常边界（ZX6-IO-01）', () => {
  it('文件选择只接受 .zxnote，不把 docx/pdf/md 混进包入口', () => {
    expect(NOTE_PACKAGE_IMPORT_ACCEPT).toBe('.zxnote');
  });

  it('系统保存面板取消时返回 canceled，不产生“已保存”结果', async () => {
    const saver = vi.fn().mockResolvedValue({ status: 'canceled' });
    const result = await saveNotePackageToFile(buildInput(), saver);
    expect(result).toEqual({ status: 'canceled' });
    expect(saver).toHaveBeenCalledTimes(1);
    const blob = saver.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('application/x-zhixing-note+zip');
  });

  it('超过 1 GiB 上限在读取 ZIP 前拒绝，零写入', async () => {
    const oversized = {
      byteLength: NOTE_PACKAGE_MAX_BYTES + 1,
    } as unknown as Uint8Array;
    await expect(
      parseNotePackage({ bytes: oversized, fileName: 'big.zxnote' }),
    ).rejects.toMatchObject({
      code: 'ZXNOTE_TOO_LARGE',
      message: expect.stringContaining('1 GiB'),
    });
  });
});

