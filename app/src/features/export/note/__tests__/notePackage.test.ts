import { describe, expect, it, vi } from 'vitest';

import { sha256Bytes } from '../../../attachments/sha256';
import { readZip } from '../../zip';
import {
  buildNotePackage,
  notePackageFileName,
  saveNotePackageToFile,
} from '../package';
import {
  buildInput,
  NOW,
  png,
  pngSha,
  VIEWPORT,
} from './packageFixtures';

async function entriesOf(bytes: Uint8Array) {
  const entries = await readZip(bytes);
  return new Map(entries.map((entry) => [entry.path, entry.data]));
}

function jsonOf(files: Map<string, Uint8Array>, path: string): unknown {
  const bytes = files.get(path);
  expect(bytes, path).toBeTruthy();
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe('知行笔记包 · 导出结构（ZX5-IO-06）', () => {
  it('生成标准 ZIP：manifest 第一、checksums 最后，note/blocks/boards/attachments/relations 齐全', async () => {
    const report = await buildNotePackage(buildInput());
    const entries = await readZip(report.bytes);
    const paths = entries.map((entry) => entry.path);

    expect(paths[0]).toBe('manifest.json');
    expect(paths[paths.length - 1]).toBe('checksums.json');
    expect(paths).toContain('note.json');
    expect(paths).toContain('blocks.json');
    expect(paths).toContain('relations.json');
    expect(paths).toContain('attachments.json');
    expect(paths).toContain('boards/board-a.json');
    expect(paths).toContain(`attachments/${pngSha}.png`);

    const files = await entriesOf(report.bytes);
    const manifest = jsonOf(files, 'manifest.json') as Record<string, unknown>;
    expect(manifest).toMatchObject({
      app: 'zhixing',
      kind: 'note-package',
      format: 'zxnote',
      version: 1,
      formatVersion: 1,
      minReaderVersion: 1,
      exportedAt: NOW.toISOString(),
      generator: 'zhixing/note-package@1',
    });
    expect(manifest.warnings).toEqual([
      '有 1 个内链指向包外笔记，已保留为外部引用。',
    ]);
    expect(manifest.counts).toMatchObject({
      blocks: 5,
      boards: 1,
      boardNodes: 2,
      boardEdges: 1,
      attachments: 1,
      attachmentBytes: png.byteLength,
      todos: 1,
    });

    const checksums = manifest.checksums as Array<{
      path: string;
      sha256: string;
      byteSize: number;
    }>;
    for (const entry of checksums) {
      const data = files.get(entry.path);
      expect(data, entry.path).toBeTruthy();
      expect(sha256Bytes(data!)).toBe(entry.sha256);
      expect(data!.byteLength).toBe(entry.byteSize);
    }
    const checksumsFile = jsonOf(files, 'checksums.json') as {
      algorithm: string;
      files: Array<{ path: string; sha256: string }>;
    };
    expect(checksumsFile.algorithm).toBe('sha256');
    expect(
      checksumsFile.files.find((entry) => entry.path === 'manifest.json')
        ?.sha256,
    ).toBe(sha256Bytes(files.get('manifest.json')!));

    const blocks = jsonOf(files, 'blocks.json') as {
      blocks: Array<{ id: string; type: string; payload: unknown }>;
    };
    expect(blocks.blocks.map((block) => block.type)).toEqual([
      'heading1',
      'paragraph',
      'board',
      'todo',
      'file',
    ]);
    expect(blocks.blocks[2]!.payload).toEqual({
      boardId: 'board-a',
      title: '发布流程',
    });

    const board = jsonOf(files, 'boards/board-a.json') as {
      viewport: unknown;
      nodes: unknown[];
      edges: unknown[];
      schema: string;
    };
    expect(board.schema).toBe('zhixing.board');
    expect(board.viewport).toEqual(VIEWPORT);
    expect(board.nodes).toHaveLength(2);
    expect(board.edges).toHaveLength(1);

    const attachments = jsonOf(files, 'attachments.json') as {
      items: Array<{
        sourceId: string;
        sha256: string;
        path: string;
        blockIds: string[];
      }>;
    };
    expect(attachments.items).toHaveLength(1);
    expect(attachments.items[0]).toMatchObject({
      sourceId: 'att-image',
      sha256: pngSha,
      path: `attachments/${pngSha}.png`,
      blockIds: ['block-5'],
    });
    expect(sha256Bytes(files.get(`attachments/${pngSha}.png`)!)).toBe(pngSha);

    const relations = jsonOf(files, 'relations.json') as {
      internal: Array<{ kind: string; target: string }>;
      external: Array<{ kind: string; target: string }>;
      missing: unknown[];
    };
    expect(relations.internal.map((relation) => relation.kind).sort()).toEqual([
      'attachment',
      'board',
      'self-note-link',
      'todo',
    ]);
    expect(relations.external).toEqual([
      expect.objectContaining({ kind: 'note-link', target: 'note-other' }),
    ]);
    expect(relations.missing).toEqual([]);
  });

  it('缺画板写 manifest 警告与 relations.missing，不静默丢块', async () => {
    const report = await buildNotePackage(
      buildInput({
        loadBoard: vi.fn().mockResolvedValue(null),
      }),
    );
    expect(report.warnings.join('\n')).toContain('画板「发布流程」数据缺失');
    const files = await entriesOf(report.bytes);
    const manifest = jsonOf(files, 'manifest.json') as {
      warnings: string[];
      boards: Array<{ sourceId: string; missing: boolean; path: null }>;
      relations: { missing: number };
      counts: { boards: number; boardNodes: number };
    };
    expect(manifest.warnings.join('\n')).toContain('画板「发布流程」数据缺失');
    expect(manifest.boards).toEqual([
      expect.objectContaining({
        sourceId: 'board-a',
        missing: true,
        path: null,
      }),
    ]);
    expect(manifest.relations.missing).toBe(1);
    expect(manifest.counts).toMatchObject({ boards: 1, boardNodes: 0 });
    expect(files.has('boards/board-a.json')).toBe(false);
    const relations = jsonOf(files, 'relations.json') as {
      missing: Array<{ kind: string; target: string; title: string }>;
    };
    expect(relations.missing).toEqual([
      expect.objectContaining({
        kind: 'board',
        target: 'board-a',
        title: '发布流程',
      }),
    ]);
  });

  it('缺附件写 manifest 警告并保留文件卡引用，不生成空文件', async () => {
    const report = await buildNotePackage(
      buildInput({
        resolveAttachment: vi.fn().mockResolvedValue(null),
      }),
    );
    expect(report.warnings.join('\n')).toContain('附件「发布流程.png」');
    const files = await entriesOf(report.bytes);
    const manifest = jsonOf(files, 'manifest.json') as {
      attachments: Array<{ sourceId: string; missing: boolean; path: null }>;
      counts: { attachments: number; attachmentBytes: number };
    };
    expect(manifest.attachments).toEqual([
      expect.objectContaining({
        sourceId: 'att-image',
        missing: true,
        path: null,
      }),
    ]);
    expect(manifest.counts).toMatchObject({
      attachments: 1,
      attachmentBytes: 0,
    });
    expect(
      Array.from(files.keys()).some((path) => path.startsWith('attachments/')),
    ).toBe(false);
    const blocks = jsonOf(files, 'blocks.json') as {
      blocks: Array<{ payload: { attachmentId?: string } }>;
    };
    expect(blocks.blocks[4]!.payload.attachmentId).toBe('att-image');
  });

  it('附件哈希不一致时停止导出，不生成不可导入的包', async () => {
    await expect(
      buildNotePackage(
        buildInput({
          resolveAttachment: vi.fn().mockResolvedValue({
            fileName: '发布流程.png',
            mime: 'image/png',
            sha256: '0'.repeat(64),
            byteSize: png.byteLength,
            bytes: png,
          }),
        }),
      ),
    ).rejects.toMatchObject({
      name: 'NotePackageExportError',
      code: 'EXPORT_ATTACHMENT_HASH_MISMATCH',
    });
  });

  it('文件名带时间戳，保存面板取消不落盘', async () => {
    expect(notePackageFileName('发布流程', NOW)).toBe(
      '发布流程-20261029-0830.zxnote',
    );
    const saver = vi.fn().mockResolvedValue({ status: 'canceled' as const });
    await expect(
      saveNotePackageToFile(buildInput(), saver),
    ).resolves.toEqual({ status: 'canceled' });
    expect(saver).toHaveBeenCalledTimes(1);
  });

  it('保存成功回报实际文件名与包内文件树', async () => {
    const saver = vi.fn().mockResolvedValue({
      status: 'saved' as const,
      path: '/tmp/发布流程-1.zxnote',
      target: 'desktop' as const,
    });
    const result = await saveNotePackageToFile(buildInput(), saver);
    expect(result.status).toBe('saved');
    if (result.status !== 'saved') return;
    expect(result.actualFileName).toBe('发布流程-1.zxnote');
    expect(result.renamed).toBe(true);
    expect(result.report.files[0]).toBe('manifest.json');
    expect(result.report.files[result.report.files.length - 1]).toBe(
      'checksums.json',
    );
  });
});
