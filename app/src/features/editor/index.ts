/**
 * P1-02 块编辑器公共入口。
 *
 * 上层（知识工作区）只需传入 noteId；测试可注入 BlockRepository。
 */

export { NoteBlockEditor, BlockEditor, editorDocumentJson } from './NoteBlockEditor';
export type {
  NoteBlockEditorProps,
  EditorHistoryAction,
  EditorHistoryState,
  EditorCommandHandle,
  EditorActiveBlock,
} from './NoteBlockEditor';
export { createBlockRepository } from '../../data/repositories/blocks';
export type {
  BlockDocument,
  BlockDraft,
  BlockRepository,
  EditorBlock,
} from '../../data/repositories/blocks';
export { createBlock, BLOCK_DEFINITIONS, blockLabel } from './blocks/registry';
export {
  blockDocumentJson,
  parseBlockDocument,
  serializeBlockDocument,
  sortEditorBlocks,
} from '../../data/repositories/blocks';
export {
  inlineRunsFromHtml,
  inlineRunsFromNode,
  runsToHtml,
  runsToPlainText,
  toggleMarksInRange,
  clearMarksInRange,
} from './inline';
export { sanitizePastedHtml, pastedBlocksFromHtml } from './paste';
export { blocksToHtml, blocksToPlainText } from './blockHtml';
export type { HtmlBlock } from './blockHtml';
export { normalizeLegacyBlocks } from './legacy';
export type { InlineMarks, InlineRun, KnownBlockType } from './types';
