/**
 * 块仓储（P1-02）。
 *
 * `note_blocks` 是编辑器正文的权威投影：每个块有稳定 id、类型、顺序键和
 * 结构化 payload JSON。渲染层不把 HTML 字符串当唯一权威，也不直接拼 SQL。
 *
 * `saveDocument` 以「整篇文档草稿」为单位做最小 diff：新增/更新/删除块，
 * 顺序由数组下标折算为可小数插入的 order_key（1024 步长）。导出 JSON 可按
 * `parseBlockDocument` → `saveDocument` 原样回放，未知类型会被保留。
 */

import type { DbClient } from '../db/client';
import type {
  JsonValue,
  NewNoteBlock,
  NoteBlock,
  NoteBlockUpdate,
} from '../db/types';

export type BlockPayload = Record<string, JsonValue>;

/**
 * 渲染层使用的块。与 Rust `NoteBlock` 的区别：
 * - `blockType` 归一为更短的 `type`；
 * - `payload` 始终是对象，避免每个调用方再做一次 JSON 解析。
 */
export type EditorBlock = {
  id: string;
  noteId: string;
  type: string;
  orderKey: number;
  payload: BlockPayload;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

/** 保存整篇文档时只需要这些字段；orderKey 由数组顺序重新计算。 */
export type BlockDraft = {
  id: string;
  type: string;
  payload: BlockPayload;
  orderKey?: number;
  schemaVersion?: number;
};

export type BlockDocumentBlock = {
  id: string;
  type: string;
  orderKey: number;
  schemaVersion: number;
  payload: BlockPayload;
};

export type BlockDocument = {
  version: 1;
  noteId?: string;
  blocks: BlockDocumentBlock[];
};

export type BlockRepository = {
  list: (noteId: string, includeDeleted?: boolean) => Promise<EditorBlock[]>;
  create: (input: NewNoteBlock) => Promise<EditorBlock>;
  update: (id: string, input: NoteBlockUpdate) => Promise<EditorBlock>;
  remove: (id: string) => Promise<void>;
  loadDocument: (noteId: string) => Promise<BlockDocument>;
  saveDocument: (
    noteId: string,
    blocks: ReadonlyArray<BlockDraft>,
  ) => Promise<EditorBlock[]>;
  exportDocument: (noteId: string) => Promise<string>;
  importDocument: (noteId: string, json: string) => Promise<EditorBlock[]>;
};

export class BlockDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockDocumentError';
  }
}

const ORDER_STEP = 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== null
  );
}

export function normalizeBlockPayload(value: unknown): BlockPayload {
  if (isPlainObject(value)) {
    return value as BlockPayload;
  }
  return {};
}

export function toEditorBlock(raw: NoteBlock): EditorBlock {
  return {
    id: raw.id,
    noteId: raw.noteId,
    type: raw.blockType,
    orderKey: raw.orderKey,
    payload: normalizeBlockPayload(raw.payload),
    schemaVersion: raw.schemaVersion,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    deletedAt: raw.deletedAt,
    version: raw.version,
  };
}

export function toBlockDraft(block: EditorBlock): BlockDraft {
  return {
    id: block.id,
    type: block.type,
    payload: block.payload,
    schemaVersion: block.schemaVersion,
  };
}

/** 与 Rust `note_blocks_list` 的 ORDER BY 完全一致。 */
export function sortEditorBlocks(
  blocks: ReadonlyArray<EditorBlock>,
): EditorBlock[] {
  return [...blocks].sort((a, b) => {
    if (a.orderKey !== b.orderKey) {
      return a.orderKey - b.orderKey;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  });
}

function toDocumentBlock(block: EditorBlock): BlockDocumentBlock {
  return {
    id: block.id,
    type: block.type,
    orderKey: block.orderKey,
    schemaVersion: block.schemaVersion,
    payload: block.payload,
  };
}

export function serializeBlockDocument(
  blocks: ReadonlyArray<EditorBlock>,
  noteId?: string,
): BlockDocument {
  const document: BlockDocument = {
    version: 1,
    ...(noteId ? { noteId } : {}),
    blocks: sortEditorBlocks(blocks).map(toDocumentBlock),
  };
  return document;
}

export function blockDocumentJson(
  blocks: ReadonlyArray<EditorBlock>,
  noteId?: string,
): string {
  return JSON.stringify(serializeBlockDocument(blocks, noteId), null, 2);
}

function parseDocumentInput(input: string | unknown): unknown {
  if (typeof input !== 'string') {
    return input;
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new BlockDocumentError('块文档不是合法 JSON');
  }
}

/**
 * 校验并回放块文档。未知块类型不报错，payload 原样保留。
 * 返回按 orderKey 排序的块，且 id 唯一非空。
 */
export function parseBlockDocument(input: string | unknown): EditorBlock[] {
  const value = parseDocumentInput(input);
  if (!isPlainObject(value)) {
    throw new BlockDocumentError('块文档必须是对象');
  }
  if (value.version !== 1) {
    throw new BlockDocumentError('仅支持 version=1 的块文档');
  }
  if (!Array.isArray(value.blocks)) {
    throw new BlockDocumentError('块文档缺少 blocks 数组');
  }
  const seen = new Set<string>();
  const noteId = typeof value.noteId === 'string' ? value.noteId : '';
  const blocks: EditorBlock[] = value.blocks.map((raw, index) => {
    if (!isPlainObject(raw)) {
      throw new BlockDocumentError(`第 ${index + 1} 个块不是对象`);
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const type = typeof raw.type === 'string' ? raw.type.trim() : '';
    const orderKey =
      typeof raw.orderKey === 'number' && Number.isFinite(raw.orderKey)
        ? raw.orderKey
        : (index + 1) * ORDER_STEP;
    if (!id) {
      throw new BlockDocumentError(`第 ${index + 1} 个块缺少 id`);
    }
    if (seen.has(id)) {
      throw new BlockDocumentError(`块 id 重复：${id}`);
    }
    if (!type) {
      throw new BlockDocumentError(`块 ${id} 缺少类型`);
    }
    seen.add(id);
    return {
      id,
      noteId,
      type,
      orderKey,
      payload: normalizeBlockPayload(raw.payload),
      schemaVersion:
        typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      deletedAt: null,
      version: typeof raw.version === 'number' ? raw.version : 0,
    };
  });
  return sortEditorBlocks(blocks);
}

function payloadsEqual(a: BlockPayload, b: BlockPayload): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateDrafts(blocks: ReadonlyArray<BlockDraft>): void {
  const seen = new Set<string>();
  blocks.forEach((block, index) => {
    if (!block.id || !block.id.trim()) {
      throw new BlockDocumentError(`第 ${index + 1} 个块缺少 id`);
    }
    if (seen.has(block.id)) {
      throw new BlockDocumentError(`块 id 重复：${block.id}`);
    }
    if (!block.type || !block.type.trim()) {
      throw new BlockDocumentError(`块 ${block.id} 缺少类型`);
    }
    seen.add(block.id);
  });
}

export function createBlockRepository(
  client: DbClient,
): BlockRepository {
  const list = async (
    noteId: string,
    includeDeleted = false,
  ): Promise<EditorBlock[]> =>
    sortEditorBlocks(
      (await client.notes.blocks.list(noteId, includeDeleted)).map(toEditorBlock),
    );

  const repository: BlockRepository = {
    list,

    create: async (input) =>
      toEditorBlock(
        await client.notes.blocks.create({
          ...input,
          payload: normalizeBlockPayload(input.payload),
        }),
      ),

    update: async (id, input) =>
      toEditorBlock(
        await client.notes.blocks.update(id, {
          ...input,
          payload: normalizeBlockPayload(input.payload),
        }),
      ),

    remove: (id) => client.notes.blocks.remove(id),

    loadDocument: async (noteId) => {
      const blocks = await list(noteId);
      return {
        version: 1,
        noteId,
        blocks: blocks.map(toDocumentBlock),
      };
    },

    saveDocument: async (noteId, drafts) => {
      validateDrafts(drafts);
      const existing = await list(noteId);
      const existingById = new Map(existing.map((block) => [block.id, block]));
      const kept = new Set<string>();

      for (let index = 0; index < drafts.length; index += 1) {
        const draft = drafts[index];
        const orderKey = (index + 1) * ORDER_STEP;
        const current = existingById.get(draft.id);
        kept.add(draft.id);
        if (!current) {
          await client.notes.blocks.create({
            id: draft.id,
            noteId,
            blockType: draft.type,
            orderKey,
            payload: normalizeBlockPayload(draft.payload),
            schemaVersion: draft.schemaVersion ?? 1,
          });
          continue;
        }
        const changed =
          current.type !== draft.type ||
          current.orderKey !== orderKey ||
          !payloadsEqual(current.payload, draft.payload) ||
          current.schemaVersion !== (draft.schemaVersion ?? current.schemaVersion);
        if (changed) {
          await client.notes.blocks.update(current.id, {
            blockType: draft.type,
            orderKey,
            payload: normalizeBlockPayload(draft.payload),
            schemaVersion: draft.schemaVersion ?? current.schemaVersion,
          });
        }
      }

      for (const block of existing) {
        if (!kept.has(block.id)) {
          await client.notes.blocks.remove(block.id);
        }
      }

      return list(noteId);
    },

    exportDocument: async (noteId) => {
      const document = await repository.loadDocument(noteId);
      return JSON.stringify(document, null, 2);
    },

    importDocument: async (noteId, json) => {
      const parsed = parseBlockDocument(json);
      return repository.saveDocument(
        noteId,
        parsed.map((block) => ({
          id: block.id,
          type: block.type,
          payload: block.payload,
          schemaVersion: block.schemaVersion,
        })),
      );
    },
  };

  return repository;
}
