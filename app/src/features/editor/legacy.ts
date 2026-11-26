/**
 * 旧版块数据归一化。
 *
 * 早期种子/导入数据使用 `heading` + `{ level, text }`、`paragraph` + `{ text }`
 * 的扁平 payload；P1-02 的编辑器使用 `heading1..5` 与结构化 runs。这里在
 * 读取时做一次无副作用归一化，避免旧笔记在块编辑器里显示成“未知块”或空白。
 *
 * 归一化结果会在编辑器下一次落库时自然持久化；加载阶段不写库。
 */

import type { EditorBlock } from '../../data/repositories/blocks';
import type { KnownBlockType } from './types';
import { normalizeInlineRuns } from './types';

const LEGACY_TEXT_TYPES = new Set([
  'paragraph',
  'heading',
  'todo',
  'bullet_list',
  'ordered_list',
  'quote',
]);

function legacyType(type: string, payload: Record<string, unknown>): KnownBlockType {
  if (type === 'heading') {
    const level =
      typeof payload.level === 'number' && Number.isFinite(payload.level)
        ? Math.min(5, Math.max(1, Math.round(payload.level)))
        : 2;
    return `heading${level}` as KnownBlockType;
  }
  if (type === 'text') {
    return 'paragraph';
  }
  if (type === 'checklist' || type === 'checklist_item') {
    return 'todo';
  }
  return type as KnownBlockType;
}

function payloadWithRuns(
  payload: EditorBlock['payload'],
): EditorBlock['payload'] {
  if (Array.isArray(payload.runs)) {
    return payload;
  }
  if (typeof payload.text === 'string' && payload.text.length > 0) {
    return {
      ...payload,
      runs: normalizeInlineRuns([{ text: payload.text }]),
    };
  }
  return payload;
}

/**
 * 返回归一化后的块；未变化时返回原数组，便于调用方判断是否需要重排/保存。
 */
export function normalizeLegacyBlocks(
  blocks: ReadonlyArray<EditorBlock>,
): EditorBlock[] {
  let changed = false;
  const next = blocks.map((block) => {
    const nextType = legacyType(block.type, block.payload);
    const typeChanged = nextType !== block.type;
    if (!typeChanged && !LEGACY_TEXT_TYPES.has(block.type)) {
      return block;
    }
    const payload = payloadWithRuns(block.payload);
    if (!typeChanged && payload === block.payload) {
      return block;
    }
    changed = true;
    return {
      ...block,
      type: nextType,
      payload,
    };
  });
  return changed ? next : [...blocks];
}
