/**
 * 把导出的画板 PNG 插入笔记。
 *
 * 图片本体进本机附件库，笔记里只追加一张 `file` 文件卡（引用
 * attachmentId），不写 base64、不复制文件本体。整条链路只读画板文档，
 * 不会改动画板节点/连线。
 */

import type {
  BlockRepository,
  EditorBlock,
} from '../../../data/repositories/blocks';
import type { AttachmentManager } from '../../attachments/manager';
import { attachmentFilePayload } from '../../attachments/runtime';
import type { StoredAttachment } from '../../attachments/types';
import { createBlock } from '../../editor/blocks/registry';
import { BOARD_EXPORT_MIME } from './image';

export type BoardImageFile = {
  fileName: string;
  blob: Blob;
};

export type CreatedBoardImageBlock = {
  block: EditorBlock;
  attachment: StoredAttachment;
};

function fileNameOf(file: BoardImageFile): string {
  const name = file.fileName.trim() || '画板导出.png';
  return /\.png$/i.test(name) ? name : `${name}.png`;
}

/**
 * 只把图片写进附件库并生成文件卡草稿；由编辑器或笔记仓储决定如何落盘。
 * 供内嵌编辑器（已有实时 blocks 状态）和整页画板（直接写块仓储）复用。
 */
export async function createBoardImageBlock(input: {
  noteId: string;
  file: BoardImageFile;
  attachmentManager: AttachmentManager;
}): Promise<CreatedBoardImageBlock> {
  const fileName = fileNameOf(input.file);
  const block = createBlock('file', input.noteId);
  const stored = await input.attachmentManager.ingest(
    typeof File === 'function'
      ? new File([input.file.blob], fileName, { type: BOARD_EXPORT_MIME })
      : input.file.blob,
    { noteId: input.noteId, blockId: block.id },
  );
  block.payload = attachmentFilePayload(
    stored.attachment,
  ) as EditorBlock['payload'];
  return { block, attachment: stored.attachment };
}

/**
 * 整页画板导出后插入笔记：追加文件卡到笔记末尾。
 * 已存在的块原样保留，顺序键由 `saveDocument` 重新计算。
 */
export async function insertBoardImageIntoNote(input: {
  noteId: string;
  file: BoardImageFile;
  attachmentManager: AttachmentManager;
  blockRepository: BlockRepository;
}): Promise<CreatedBoardImageBlock> {
  const created = await createBoardImageBlock(input);
  const existing = await input.blockRepository.list(input.noteId);
  await input.blockRepository.saveDocument(input.noteId, [
    ...existing.map((block) => ({
      id: block.id,
      type: block.type,
      payload: block.payload,
      schemaVersion: block.schemaVersion,
    })),
    {
      id: created.block.id,
      type: created.block.type,
      payload: created.block.payload,
      schemaVersion: created.block.schemaVersion,
    },
  ]);
  return created;
}
