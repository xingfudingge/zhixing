import type { EditorBlock } from '../../../data/repositories/blocks';
import { BoardEmbed, type BoardImageFile } from '../../board';
import { blockBoard } from '../types';

type BoardBlockProps = {
  block: EditorBlock;
  readOnly: boolean;
  onChangeTitle: (title: string) => void;
  onChangeBoard: (patch: { boardId: string; title: string }) => void;
  /** 导出 PNG 后插入当前笔记；由块编辑器提供附件管理器与块状态。 */
  onInsertExportedImage?: (file: BoardImageFile) => Promise<void>;
};

/**
 * 画板块只保存引用与标题。预览与打开由 P1-04 的画板模块提供：
 * - boardId 为空时不伪造预览，点击「创建空白画板」才创建 boards 行；
 * - 有 boardId 时按真实 board_nodes / board_edges 绘制 Canvas2D 缩略图。
 */
export function BoardBlock({
  block,
  readOnly,
  onChangeTitle,
  onChangeBoard,
  onInsertExportedImage,
}: BoardBlockProps) {
  const board = blockBoard(block);
  return (
    <div className="zxe-board" role="group" aria-label="画板块">
      <BoardEmbed
        boardId={board.boardId}
        title={board.title}
        noteId={block.noteId}
        readOnly={readOnly}
        onChangeTitle={onChangeTitle}
        onChangeBoard={onChangeBoard}
        onInsertExportedImage={onInsertExportedImage}
      />
    </div>
  );
}
