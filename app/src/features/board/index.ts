/**
 * 画板模块公共入口（P1-04）。
 *
 * 页面/笔记块只从这里导入；Canvas2D、模型与数据源适配均在该目录内。
 */

export { BoardWorkspace } from './BoardWorkspace';
export type { BoardWorkspaceProps } from './BoardWorkspace';
export { BoardEmbed } from './BoardEmbed';
export type { BoardEmbedProps } from './BoardEmbed';
export { BoardCanvas } from './BoardCanvas';
export { BoardExportDialog } from './components/BoardExportDialog';
export type { BoardExportDialogProps } from './components/BoardExportDialog';
export {
  BoardExportError,
  boardExportBounds,
  defaultBoardExportFileName,
  planBoardExport,
  renderBoardPng,
} from './export/image';
export type {
  BoardExportBackground,
  BoardExportOptions,
  BoardExportPlan,
  RenderedBoardPng,
} from './export/image';
export {
  createBoardImageBlock,
  insertBoardImageIntoNote,
} from './export/noteInsert';
export type {
  BoardImageFile,
  CreatedBoardImageBlock,
} from './export/noteInsert';
export {
  BOARD_JSON_MIME,
  boardJsonFileBlob,
  boardJsonFileText,
  defaultBoardJsonFileName,
} from './export/json';
export type { BoardJsonFileOptions } from './export/json';
export {
  saveBoardJsonWithDialog,
  saveBoardPngWithDialog,
} from './export/save';
export { createBoardSource, documentFromRecord, saveInputFromDocument } from './source';
export * from './model';
export type * from './types';
