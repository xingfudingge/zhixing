/**
 * 画板文档 ID 重映射与导入落库（ZX5-IO-07 / ZX-DESIGN-16 §7.3）。
 *
 * `board_nodes.id` / `board_edges.id` 是全局主键。把源画板的 JSON（或
 * `.zxboard` 包内的 `board.json`）直接写库时，只要同库已经导入过一次，
 * 就会撞主键并在保存阶段失败。这里在任何写库之前为每个节点/连线生成
 * 全新 ID，并同步改写连线端点，保证同一份 JSON 连续导入两次也互不冲突。
 *
 * 导入为新画板与替换当前画板都走同一套映射；写入失败时执行补偿：
 * - 新建画板失败 → 删除本次创建的空/半成品画板；
 * - 替换失败 → 用导入前快照回写，尽量恢复原画板。
 */

import type { IdFactory } from '../types';
import type { BoardDocument } from '../types';
import { createBoardId } from '../ids';
import { cloneJson } from '../model';
import type { BoardSource } from '../types';

export type BoardRemapOptions = {
  /** 新画板的 boardId；替换模式下就是当前画板 ID。 */
  boardId: string;
  /** 重新绑定的目标笔记；null 表示不关联笔记。 */
  noteId: string | null;
  /** 测试注入；默认使用 `createBoardId`。 */
  idFactory?: IdFactory;
};

export type RemappedBoardDocument = {
  document: BoardDocument;
  nodeIdMap: Map<string, string>;
  edgeIdMap: Map<string, string>;
};

/** 最多为一次导入生成多少个候选 ID；防止注入的工厂死循环。 */
const ID_ATTEMPTS = 100;

/**
 * 生成不与源文档 ID 重复的新 ID。
 *
 * 即便调用方注入的工厂返回了源 ID（例如固定序列测试），也继续尝试，
 * 从入口就保证“不得复用源 ID”，而不是依赖数据库兜底。
 */
function createAllocator(
  document: BoardDocument,
  factory: IdFactory,
): (prefix: 'node' | 'edge') => string {
  const used = new Set<string>([
    ...document.nodes.map((node) => node.id),
    ...document.edges.map((edge) => edge.id),
  ]);
  return (prefix) => {
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
      const id = factory(prefix);
      if (id && !used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new Error(`无法为画板${prefix === 'node' ? '对象' : '连线'}生成不重复的 ID`);
  };
}

/**
 * 深拷贝画板文档并重映射所有节点/连线 ID。
 *
 * 保留 `payload` / `style` 中所有已知与未知字段、几何、文字、层级和
 * 锁定状态；viewport 不属于持久化文档，由 UI 层单独恢复。
 */
export function remapBoardDocument(
  document: BoardDocument,
  options: BoardRemapOptions,
): RemappedBoardDocument {
  const allocate = createAllocator(
    document,
    options.idFactory ?? createBoardId,
  );
  const nodeIdMap = new Map<string, string>();
  for (const node of document.nodes) {
    nodeIdMap.set(node.id, allocate('node'));
  }
  const edgeIdMap = new Map<string, string>();
  for (const edge of document.edges) {
    edgeIdMap.set(edge.id, allocate('edge'));
  }

  const nodes = document.nodes.map((node) => ({
    ...cloneJson(node),
    id: nodeIdMap.get(node.id)!,
  }));
  const edges = document.edges.map((edge) => {
    const fromNodeId = nodeIdMap.get(edge.fromNodeId);
    const toNodeId = nodeIdMap.get(edge.toNodeId);
    if (!fromNodeId || !toNodeId) {
      throw new Error(`连线 ${edge.id} 的端点不在画板对象中`);
    }
    return {
      ...cloneJson(edge),
      id: edgeIdMap.get(edge.id)!,
      fromNodeId,
      toNodeId,
    };
  });

  return {
    document: {
      version: 1,
      boardId: options.boardId,
      noteId: options.noteId,
      title: document.title,
      background: document.background,
      nodes,
      edges,
    },
    nodeIdMap,
    edgeIdMap,
  };
}

function errorText(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return typeof reason === 'string' ? reason : '';
}

/** 仅对唯一约束/主键冲突重试；磁盘失败等不应反复创建画板。 */
function isDuplicateIdError(reason: unknown): boolean {
  return /unique|constraint|duplicate|主键|已存在|重复/i.test(
    errorText(reason),
  );
}

export type ImportBoardAsNewOptions = {
  noteId: string | null;
  /** 默认在源标题后追加「（导入）」。 */
  title?: string;
  idFactory?: IdFactory;
  /** 唯一约束冲突时的总尝试次数（含首次）。 */
  maxAttempts?: number;
};

/**
 * 把源文档导入为一张新画板。
 *
 * - 每次尝试都重新生成节点/连线 ID；
 * - 新建画板与保存不是同一个 SQLite 事务（当前 IPC 没有批量事务命令），
 *   因此保存失败时删除本次创建的画板，避免留下半成品；
 * - 主键冲突时用全新 ID 重试，覆盖极端碰撞。
 */
export async function importBoardDocumentAsNew(
  source: BoardSource,
  sourceDocument: BoardDocument,
  options: ImportBoardAsNewOptions,
): Promise<BoardDocument> {
  const noteId = options.noteId ?? sourceDocument.noteId ?? null;
  const title =
    options.title ??
    `${(sourceDocument.title || '未命名画板').slice(0, 110)}（导入）`.trim();
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const created = await source.create({ noteId, title });
    try {
      const remapped = remapBoardDocument(sourceDocument, {
        boardId: created.boardId,
        noteId,
        idFactory: options.idFactory,
      });
      return await source.save(created.boardId, {
        ...remapped.document,
        title,
      });
    } catch (reason) {
      lastError = reason;
      try {
        await source.remove(created.boardId);
      } catch {
        // 回收失败不覆盖导入失败原因。
      }
      if (!isDuplicateIdError(reason) || attempt === maxAttempts - 1) {
        throw reason;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('导入画板失败，请重试');
}

export type ReplaceBoardOptions = {
  noteId: string | null;
  idFactory?: IdFactory;
};

/**
 * 用源文档替换当前画板内容。
 *
 * 节点/连线同样生成新 ID；保存失败时用导入前快照回写。补偿本身失败时
 * 不掩盖原始错误，界面仍会明确显示“保存失败”。
 */
export async function replaceBoardDocument(
  source: BoardSource,
  boardId: string,
  sourceDocument: BoardDocument,
  options: ReplaceBoardOptions,
): Promise<BoardDocument> {
  const before = await source.load(boardId);
  const remapped = remapBoardDocument(sourceDocument, {
    boardId,
    noteId: options.noteId,
    idFactory: options.idFactory,
  });
  try {
    return await source.save(boardId, remapped.document);
  } catch (reason) {
    try {
      await source.save(boardId, before);
    } catch {
      // 补偿失败不覆盖原始错误。
    }
    throw reason;
  }
}
