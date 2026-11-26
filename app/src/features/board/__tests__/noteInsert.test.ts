import { describe, expect, it, vi } from 'vitest';

import type {
  BlockDraft,
  BlockRepository,
  EditorBlock,
} from '../../../data/repositories/blocks';
import type { AttachmentManager } from '../../attachments/manager';
import type {
  AttachmentMetadata,
  AttachmentState,
  StoredAttachment,
} from '../../attachments/types';
import {
  createBoardImageBlock,
  insertBoardImageIntoNote,
} from '../export/noteInsert';

function storedAttachment(
  fileName: string,
  noteId: string,
  blockId: string,
): StoredAttachment {
  const metadata: AttachmentMetadata = {
    id: 'att-export-1',
    spaceId: 'personal',
    noteId,
    blockId,
    fileName,
    sha256: 'a'.repeat(64),
    byteSize: 4,
    mime: 'image/png',
    storageKey: 'spaces/personal/assets/export.png',
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    version: 1,
  };
  const state: AttachmentState = {
    attachmentId: metadata.id,
    status: 'pending',
    localBlobKey: `attachments/${metadata.sha256}`,
    remoteId: null,
    uploadedPartIndexes: [],
    lastError: null,
    downloadedAt: null,
    updatedAt: metadata.updatedAt,
  };
  return { metadata, state };
}

function fakeManager() {
  const ingest = vi.fn(
    async (
      file: File | Blob,
      options: { noteId?: string | null; blockId?: string | null },
    ) => {
      const name = file instanceof File ? file.name : '画板导出.png';
      return {
        attachment: storedAttachment(
          name,
          options.noteId ?? 'note-1',
          options.blockId ?? 'block-1',
        ),
        reusedBlob: false,
      };
    },
  );
  return {
    manager: { ingest } as unknown as AttachmentManager,
    ingest,
  };
}

function existingBlock(id: string, noteId = 'note-1'): EditorBlock {
  return {
    id,
    noteId,
    type: 'paragraph',
    orderKey: 1024,
    payload: { runs: [{ text: '已有正文' }] },
    schemaVersion: 1,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  };
}

describe('画板导出图片插入笔记', () => {
  it('把 PNG 写进附件库，并追加 file 文件卡到笔记末尾', async () => {
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], {
      type: 'image/png',
    });
    const { manager, ingest } = fakeManager();
    const list = vi.fn(async () => [existingBlock('block-1')]);
    const saveDocument = vi.fn(
      async (_noteId: string, drafts: ReadonlyArray<BlockDraft>) => drafts,
    );
    const blockRepository = {
      list,
      saveDocument,
    } as unknown as BlockRepository;

    const result = await insertBoardImageIntoNote({
      noteId: 'note-1',
      file: { fileName: '发布流程', blob },
      attachmentManager: manager,
      blockRepository,
    });

    expect(ingest).toHaveBeenCalledTimes(1);
    const [file, context] = ingest.mock.calls[0]!;
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('发布流程.png');
    expect(context).toMatchObject({
      noteId: 'note-1',
      blockId: result.block.id,
    });

    expect(result.attachment.metadata.fileName).toBe('发布流程.png');
    expect(result.block.type).toBe('file');
    expect(result.block.payload).toMatchObject({
      attachmentId: 'att-export-1',
      fileName: '发布流程.png',
      mime: 'image/png',
    });

    expect(saveDocument).toHaveBeenCalledTimes(1);
    const drafts = saveDocument.mock.calls[0]![1];
    expect(drafts.map((draft) => draft.id)).toEqual([
      'block-1',
      result.block.id,
    ]);
    expect(drafts[0]!.payload).toEqual(existingBlock('block-1').payload);
    expect(drafts[1]!.type).toBe('file');
  });

  it('只生成文件卡草稿时也可供内嵌编辑器复用，不触碰块仓储', async () => {
    const { manager } = fakeManager();
    const created = await createBoardImageBlock({
      noteId: 'note-1',
      file: {
        fileName: '画板.png',
        blob: new Blob(['x'], { type: 'image/png' }),
      },
      attachmentManager: manager,
    });
    expect(created.block.noteId).toBe('note-1');
    expect(created.block.type).toBe('file');
    expect(created.attachment.metadata.noteId).toBe('note-1');
  });
});
