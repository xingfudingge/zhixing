/**
 * 块文档操作：纯函数，便于测试与回放。
 * 所有函数返回新数组，不修改入参。
 */

import type { EditorBlock } from '../../data/repositories/blocks';
import type { JsonValue } from '../../data/db/types';
import { createBlock, newBlockId } from './blocks/registry';
import { canContainText } from './blocks/registry';
import { concatRuns, runsToHtml, runsToPlainText } from './inline';
import { isSafeLinkUrl } from './security';
import {
  blockAlign,
  blockBoard,
  blockChecked,
  blockCode,
  blockFile,
  blockFormula,
  blockHeaderRow,
  blockIndent,
  blockLink,
  blockRuns,
  blockTableRows,
  headingLevel,
  isTextualBlockType,
  type InlineRun,
  type KnownBlockType,
  type TextAlign,
} from './types';

const ORDER_STEP = 1024;

/** 撤销/重做历史默认上限；超过后丢弃最早的一步。 */
export const HISTORY_LIMIT = 100;
/** 连续文本输入的合并窗口；同一块内 400ms 内的输入算一步。 */
export const HISTORY_MERGE_MS = 400;

export type HistoryCaret = {
  blockId: string;
  start: number;
  end: number;
};

/**
 * 跨笔记批量移动的副作用：
 * - `blocks` 是移动时的块模板（源 id 不复用）；
 * - `appliedIds` 记录最近一次真正写入目标笔记的 id，撤销时按 id 移除。
 * 撤销/重做共用同一个对象，重做会用新 id 追加并刷新 `appliedIds`。
 */
export type MoveHistorySideEffect = {
  kind: 'move';
  noteId: string;
  blocks: EditorBlock[];
  appliedIds: string[];
};

/**
 * 一步历史的快照。历史只在内存里，不写 SQLite、不跨笔记共享。
 * `blocks` 必须深拷贝，避免后续原地修改 payload 污染历史。
 */
export type BlockHistoryEntry = {
  blocks: EditorBlock[];
  activeBlockId: string | null;
  caret: HistoryCaret | null;
  /** 跨笔记结构操作的附加恢复信息；普通编辑为空。 */
  sideEffects?: MoveHistorySideEffect[];
};

function clonePayload<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneHistoryBlocks(
  blocks: ReadonlyArray<EditorBlock>,
): EditorBlock[] {
  return blocks.map((block) => ({
    ...block,
    payload: clonePayload(block.payload),
  }));
}

/**
 * 历史撤销删除时，被软删除的行仍占用原 id：直接 saveDocument 会重复插入
 * 主键（SQLite `note_blocks.id` 是 PRIMARY KEY）。恢复到当前文档里已经不存在的
 * id 时分配新 id，保证「删除 → 一次撤销」在真实仓储也能落库。
 */
export function remapRestoredBlockIds(
  blocks: ReadonlyArray<EditorBlock>,
  existingIds: ReadonlySet<string>,
): { blocks: EditorBlock[]; idMap: Map<string, string> } {
  const used = new Set(existingIds);
  const idMap = new Map<string, string>();
  const next = blocks.map((block) => {
    if (used.has(block.id)) {
      return block;
    }
    let id = newBlockId();
    while (used.has(id)) {
      id = newBlockId();
    }
    used.add(id);
    idMap.set(block.id, id);
    return { ...block, id };
  });
  return { blocks: next, idMap };
}

/** 入栈并裁到上限；返回新数组，避免调用方共享引用。 */
export function pushHistoryEntry(
  stack: ReadonlyArray<BlockHistoryEntry>,
  entry: BlockHistoryEntry,
  limit: number = HISTORY_LIMIT,
): BlockHistoryEntry[] {
  const next = [...stack, entry];
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}

/**
 * 文本输入发生在 `input` 事件之后，DOM 里的光标已经是“改完后”的位置。
 * 撤销回到改前状态时，把光标按文本长度差回推，避免落在错误字符上。
 */
export function caretBeforeTextChange(
  caret: HistoryCaret | null,
  blockId: string,
  before: ReadonlyArray<InlineRun>,
  after: ReadonlyArray<InlineRun>,
): HistoryCaret | null {
  if (!caret || caret.blockId !== blockId) {
    return caret;
  }
  const beforeLength = runsToPlainText(before).length;
  const afterLength = runsToPlainText(after).length;
  const delta = afterLength - beforeLength;
  const clamp = (value: number) =>
    Math.max(0, Math.min(beforeLength, value));
  return {
    blockId,
    start: clamp(caret.start - delta),
    end: clamp(caret.end - delta),
  };
}

export function normalizeBlockOrder(
  blocks: ReadonlyArray<EditorBlock>,
): EditorBlock[] {
  return blocks.map((block, index) => ({
    ...block,
    orderKey: (index + 1) * ORDER_STEP,
  }));
}

export function isBlockEmpty(block: EditorBlock): boolean {
  if (isTextualBlockType(block.type)) {
    return runsToPlainText(blockRuns(block)).trim() === '';
  }
  if (block.type === 'code') {
    return blockCode(block).trim() === '';
  }
  // 表格、文件卡、画板、公式、链接、分割线都是“原子块”，即使内容为空也
  // 需要保留，不能因为空文本被当成空段落移除。
  return false;
}

export function withRuns(block: EditorBlock, runs: InlineRun[]): EditorBlock {
  return {
    ...block,
    payload: { ...block.payload, runs },
  };
}

export function withPayload(
  block: EditorBlock,
  patch: Record<string, JsonValue>,
): EditorBlock {
  return {
    ...block,
    payload: { ...block.payload, ...patch },
  };
}

export function withAlign(
  block: EditorBlock,
  align: TextAlign | undefined,
): EditorBlock {
  const payload = { ...block.payload };
  if (align) {
    payload.align = align;
  } else {
    delete payload.align;
  }
  return { ...block, payload };
}

export function withIndent(block: EditorBlock, indent: number): EditorBlock {
  return {
    ...block,
    payload: { ...block.payload, indent: Math.max(0, Math.min(6, indent)) },
  };
}

export function convertBlockType(
  block: EditorBlock,
  type: KnownBlockType,
): EditorBlock {
  const runs = blockRuns(block);
  const base = createBlock(type, block.noteId, block.id);
  let payload = base.payload;

  if (canContainText(type)) {
    payload = {
      ...payload,
      runs,
      ...(blockAlign(block) ? { align: blockAlign(block) } : {}),
      ...(blockIndent(block) > 0 ? { indent: blockIndent(block) } : {}),
    };
    if (type === 'todo') {
      payload.checked = blockChecked(block);
    }
  } else if (type === 'code') {
    payload = {
      code: runsToPlainText(runs),
      language: '',
    };
  } else if (type === 'link') {
    const link = blockLink(block);
    payload = {
      url: link.url,
      title: link.title || runsToPlainText(runs).trim(),
    };
  }

  return {
    ...base,
    payload,
    orderKey: block.orderKey,
    schemaVersion: block.schemaVersion,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
    deletedAt: block.deletedAt,
    version: block.version,
  };
}

/** 文档末尾总要留一个可输入的块，避免用户只能看着表格/画板。 */
export function ensureTrailingParagraph(
  blocks: ReadonlyArray<EditorBlock>,
  noteId: string,
): EditorBlock[] {
  if (blocks.length === 0) {
    return [createBlock('paragraph', noteId)];
  }
  const last = blocks[blocks.length - 1];
  if (canContainText(last.type)) {
    return [...blocks];
  }
  return [...blocks, createBlock('paragraph', noteId)];
}

// ---------------------------------------------------------------------------
// 文档级块选择（ZX-NOTE-03）
// ---------------------------------------------------------------------------

/**
 * 块选择是临时 UI 状态：`ids` 按正文顺序展开，anchor → focus 描述范围。
 * 不写入 payload，也不持久化。
 */
export type BlockSelection = {
  anchorId: string;
  focusId: string;
  ids: string[];
};

/** 按当前正文顺序取 anchor → focus 的连续范围；任一端不存在时返回 null。 */
export function createBlockSelection(
  blocks: ReadonlyArray<EditorBlock>,
  anchorId: string,
  focusId: string,
): BlockSelection | null {
  const order = blocks.map((block) => block.id);
  const start = order.indexOf(anchorId);
  const end = order.indexOf(focusId);
  if (start < 0 || end < 0) {
    return null;
  }
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  return { anchorId, focusId, ids: order.slice(from, to + 1) };
}

/** 显式「全选块」；空文档返回 null。 */
export function selectAllBlocks(
  blocks: ReadonlyArray<EditorBlock>,
): BlockSelection | null {
  if (blocks.length === 0) {
    return null;
  }
  return {
    anchorId: blocks[0].id,
    focusId: blocks[blocks.length - 1].id,
    ids: blocks.map((block) => block.id),
  };
}

/** ⌘/Ctrl+点击：追加或反选；最后一块取消后退出块选择。 */
export function toggleBlockSelection(
  blocks: ReadonlyArray<EditorBlock>,
  selection: BlockSelection | null,
  id: string,
): BlockSelection | null {
  const order = blocks.map((block) => block.id);
  if (!order.includes(id)) {
    return selection;
  }
  const selected = new Set(selection?.ids ?? []);
  if (selected.has(id)) {
    selected.delete(id);
  } else {
    selected.add(id);
  }
  const ids = order.filter((blockId) => selected.has(blockId));
  if (ids.length === 0) {
    return null;
  }
  const anchorId =
    selection && ids.includes(selection.anchorId) ? selection.anchorId : ids[0];
  const focusId = ids.includes(id)
    ? id
    : selection && ids.includes(selection.focusId)
      ? selection.focusId
      : ids[ids.length - 1];
  return { anchorId, focusId, ids };
}

/** Shift+↑/↓：以 anchor 为起点扩展/收缩一块。 */
export function extendBlockSelection(
  blocks: ReadonlyArray<EditorBlock>,
  selection: BlockSelection,
  delta: number,
): BlockSelection {
  const order = blocks.map((block) => block.id);
  const current = order.indexOf(selection.focusId);
  if (current < 0) {
    return selection;
  }
  const target = Math.max(0, Math.min(order.length - 1, current + delta));
  if (target === current) {
    return selection;
  }
  const anchorId = order.includes(selection.anchorId)
    ? selection.anchorId
    : selection.focusId;
  return createBlockSelection(blocks, anchorId, order[target]) ?? selection;
}

/** 批量删除；至少保留一个可输入块，整篇被删时补一个空段落。 */
export function removeBlocksByIds(
  blocks: ReadonlyArray<EditorBlock>,
  ids: ReadonlySet<string>,
  noteId: string,
): EditorBlock[] {
  const next = blocks.filter((block) => !ids.has(block.id));
  if (next.length === 0) {
    return [createBlock('paragraph', noteId)];
  }
  return ensureTrailingParagraph(next, noteId);
}

/**
 * 把选中的块作为一组上移/下移一格；非连续选择会先聚拢成一组。
 * 不能越过文档边界，也不改变选中集合内部的顺序。
 */
export function moveBlocksByIds(
  blocks: ReadonlyArray<EditorBlock>,
  ids: ReadonlySet<string>,
  delta: number,
  noteId: string,
): EditorBlock[] {
  if (ids.size === 0 || delta === 0) {
    return [...blocks];
  }
  const indices: number[] = [];
  blocks.forEach((block, index) => {
    if (ids.has(block.id)) {
      indices.push(index);
    }
  });
  if (indices.length === 0) {
    return [...blocks];
  }
  const moved = blocks.filter((block) => ids.has(block.id));
  const rest = blocks.filter((block) => !ids.has(block.id));

  let insertAt = -1;
  if (delta < 0) {
    const first = indices[0];
    if (first === 0 || ids.has(blocks[first - 1].id)) {
      return [...blocks];
    }
    insertAt = rest.findIndex((block) => block.id === blocks[first - 1].id);
  } else {
    const last = indices[indices.length - 1];
    if (last >= blocks.length - 1 || ids.has(blocks[last + 1].id)) {
      return [...blocks];
    }
    insertAt =
      rest.findIndex((block) => block.id === blocks[last + 1].id) + 1;
  }
  if (insertAt < 0) {
    return [...blocks];
  }
  return ensureTrailingParagraph(
    [...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)],
    noteId,
  );
}

// ---------------------------------------------------------------------------
// 批量复制：纯文本 + 安全 HTML（保持块级结构，不携带知行私有元数据）
// ---------------------------------------------------------------------------

function escapeClipboardHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 单个块的纯文本投影；标题级别、勾选态、出处等元数据不复制。 */
export function blockPlainText(block: EditorBlock): string {
  if (isTextualBlockType(block.type)) {
    return runsToPlainText(blockRuns(block));
  }
  switch (block.type) {
    case 'code':
      return blockCode(block);
    case 'table':
      return blockTableRows(block)
        .map((row) => row.join('\t'))
        .join('\n');
    case 'file':
      return blockFile(block).fileName;
    case 'board':
      return blockBoard(block).title;
    case 'formula':
      return blockFormula(block).latex;
    case 'link': {
      const link = blockLink(block);
      return link.title || link.url;
    }
    case 'divider':
      return '---';
    default:
      return runsToPlainText(blockRuns(block));
  }
}

/** 块之间空行分隔；空文本块不产生多余空行。 */
export function blocksToPlainText(
  blocks: ReadonlyArray<EditorBlock>,
): string {
  return blocks
    .map(blockPlainText)
    .filter((text) => text.trim() !== '')
    .join('\n\n');
}

/** 单个块的安全 HTML；只复用已转义的 runs，不拼接原始 DOM。 */
export function blockClipboardHtml(block: EditorBlock): string {
  const inline = runsToHtml(blockRuns(block));
  const content = inline || '<br>';
  const level = headingLevel(block.type);
  if (level) {
    return `<h${level}>${content}</h${level}>`;
  }
  switch (block.type) {
    case 'paragraph':
    case 'todo':
      return `<p>${content}</p>`;
    case 'bullet_list':
      return `<ul><li>${content}</li></ul>`;
    case 'ordered_list':
      return `<ol><li>${content}</li></ol>`;
    case 'quote':
      return `<blockquote>${content}</blockquote>`;
    case 'code':
      return `<pre><code>${escapeClipboardHtml(blockCode(block))}</code></pre>`;
    case 'divider':
      return '<hr>';
    case 'table': {
      const rows = blockTableRows(block);
      const header = blockHeaderRow(block);
      const body = rows
        .map((row, rowIndex) => {
          const tag = header && rowIndex === 0 ? 'th' : 'td';
          return `<tr>${row
            .map(
              (cell) =>
                `<${tag}>${escapeClipboardHtml(cell)}</${tag}>`,
            )
            .join('')}</tr>`;
        })
        .join('');
      return `<table><tbody>${body}</tbody></table>`;
    }
    case 'file':
      return `<p>${escapeClipboardHtml(blockFile(block).fileName)}</p>`;
    case 'board':
      return `<p>${escapeClipboardHtml(blockBoard(block).title)}</p>`;
    case 'formula':
      return `<p>${escapeClipboardHtml(blockFormula(block).latex)}</p>`;
    case 'link': {
      const link = blockLink(block);
      const label = escapeClipboardHtml(link.title || link.url);
      if (!isSafeLinkUrl(link.url)) {
        return `<p>${label}</p>`;
      }
      return `<p><a href="${escapeClipboardHtml(link.url)}">${label}</a></p>`;
    }
    default:
      return `<p>${escapeClipboardHtml(blockPlainText(block))}</p>`;
  }
}

/** 多块复制到富文本目标时保留段落/标题/列表/代码等基本结构。 */
export function blocksToClipboardHtml(
  blocks: ReadonlyArray<EditorBlock>,
): string {
  return blocks
    .filter((block) => !isBlockEmpty(block))
    .map(blockClipboardHtml)
    .join('\n');
}

export function replaceBlock(
  blocks: ReadonlyArray<EditorBlock>,
  id: string,
  next: EditorBlock,
): EditorBlock[] {
  return blocks.map((block) => (block.id === id ? next : block));
}

export function insertBlocksAfter(
  blocks: ReadonlyArray<EditorBlock>,
  id: string,
  inserted: ReadonlyArray<EditorBlock>,
): EditorBlock[] {
  const index = blocks.findIndex((block) => block.id === id);
  if (index < 0) {
    return [...blocks, ...inserted];
  }
  return [
    ...blocks.slice(0, index + 1),
    ...inserted,
    ...blocks.slice(index + 1),
  ];
}

export function removeBlockById(
  blocks: ReadonlyArray<EditorBlock>,
  id: string,
  noteId: string,
): EditorBlock[] {
  const next = blocks.filter((block) => block.id !== id);
  if (next.length === 0) {
    return [createBlock('paragraph', noteId)];
  }
  return ensureTrailingParagraph(next, noteId);
}

export function moveBlock(
  blocks: ReadonlyArray<EditorBlock>,
  id: string,
  delta: number,
): EditorBlock[] {
  const index = blocks.findIndex((block) => block.id === id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= blocks.length) {
    return [...blocks];
  }
  const next = [...blocks];
  const [block] = next.splice(index, 1);
  next.splice(target, 0, block);
  return next;
}

/**
 * 在块内换行/回车：前半段留在当前块，后半段进入新块。
 * 标题回车后得到正文；列表/待办延续同类；引用延续引用。
 */
export function splitBlock(
  blocks: ReadonlyArray<EditorBlock>,
  id: string,
  before: InlineRun[],
  after: InlineRun[],
  noteId: string,
): { blocks: EditorBlock[]; newBlockId: string } {
  const index = blocks.findIndex((block) => block.id === id);
  if (index < 0) {
    return { blocks: [...blocks], newBlockId: id };
  }
  const current = blocks[index];
  const currentUpdated = withRuns(current, before);

  let nextType: KnownBlockType = 'paragraph';
  if (current.type === 'todo') {
    nextType = 'todo';
  } else if (
    current.type === 'bullet_list' ||
    current.type === 'ordered_list' ||
    current.type === 'quote'
  ) {
    nextType = current.type;
  }

  const next: EditorBlock = createBlock(nextType, noteId);
  next.payload = {
    ...next.payload,
    runs: after,
    ...(blockAlign(current) ? { align: blockAlign(current) } : {}),
    ...(blockIndent(current) > 0 ? { indent: blockIndent(current) } : {}),
  };
  if (nextType === 'todo') {
    next.payload.checked = false;
  }

  const updated = [...blocks];
  updated[index] = currentUpdated;
  updated.splice(index + 1, 0, next);
  return {
    blocks: ensureTrailingParagraph(updated, noteId),
    newBlockId: next.id,
  };
}

/** 退格合并：把当前块内容接到前一个可文本块末尾。 */
export function mergeBlockBackward(
  blocks: ReadonlyArray<EditorBlock>,
  id: string,
): { blocks: EditorBlock[]; focusBlockId: string; caret: number } | null {
  const index = blocks.findIndex((block) => block.id === id);
  if (index <= 0) {
    return null;
  }
  const current = blocks[index];
  const previous = blocks[index - 1];
  if (!canContainText(previous.type)) {
    return null;
  }
  const previousRuns = blockRuns(previous);
  const currentRuns = blockRuns(current);
  const caret = runsToPlainText(previousRuns).length;
  const merged = concatRuns(previousRuns, currentRuns);
  const updated = [...blocks];
  updated[index - 1] = withRuns(previous, merged);
  updated.splice(index, 1);
  return {
    blocks: ensureTrailingParagraph(updated, previous.noteId),
    focusBlockId: previous.id,
    caret,
  };
}
