import { describe, expect, it } from 'vitest';

import { createZip, readZip, type ZipWriteEntry } from '../../export/zip';
import {
  BOARD_PACKAGE_ACCEPT,
  BOARD_PACKAGE_IMPORT_ACCEPT,
  BoardPackageImportError,
  boardPackageFileName,
  buildBoardPackage,
  parseBoardPackage,
  type BoardPackageReport,
} from '../export/package';
import { remapBoardDocument } from '../export/remap';
import type { RenderedBoardPng } from '../export/image';
import { sampleDocument } from './fakeBoardSource';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02,
]);

async function buildWithThumbnail(
  includeThumbnail = true,
): Promise<BoardPackageReport> {
  return buildBoardPackage({
    document: sampleDocument(),
    viewport: { x: -40, y: -30, zoom: 0.9 },
    includeThumbnail,
    now: new Date(2026, 9, 29, 8, 30),
    renderThumbnail: async () =>
      ({
        blob: new Blob([PNG_BYTES], { type: 'image/png' }),
        plan: {},
      }) as unknown as RenderedBoardPng,
  });
}

async function rewriteEntry(
  bytes: Uint8Array,
  path: string,
  data: Uint8Array,
): Promise<Uint8Array> {
  const entries = await readZip(bytes);
  const files = new Map(entries.map((entry) => [entry.path, entry.data]));
  files.set(path, data);
  const checksums = JSON.parse(
    decoder.decode(files.get('checksums.json')!),
  ) as {
    files: Array<{ path: string; byteSize: number; sha256: string }>;
  };
  const { sha256Bytes } = await import('../../attachments/sha256');
  for (const item of checksums.files) {
    const content = files.get(item.path);
    if (!content) continue;
    item.byteSize = content.byteLength;
    item.sha256 = sha256Bytes(content);
  }
  files.set('checksums.json', encoder.encode(JSON.stringify(checksums, null, 2)));
  const payloadPaths = Array.from(files.keys())
    .filter((item) => item !== 'manifest.json' && item !== 'checksums.json')
    .sort((a, b) => a.localeCompare(b));
  const zipEntries: ZipWriteEntry[] = [
    { path: 'manifest.json', data: files.get('manifest.json')! },
    ...payloadPaths.map((item) => ({ path: item, data: files.get(item)! })),
    { path: 'checksums.json', data: files.get('checksums.json')! },
  ];
  return createZip(zipEntries, new Date(2026, 9, 29, 8, 30));
}

function errorCodeOf(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => 'NO_ERROR',
    (reason: unknown) =>
      reason instanceof BoardPackageImportError ? reason.code : 'UNKNOWN',
  );
}

describe('画板包 .zxboard · 导出', () => {
  it('生成 manifest + board.json + thumbnail + checksums，并保留 viewport/样式/未知字段', async () => {
    const document = sampleDocument();
    document.nodes[0]!.payload = {
      ...document.nodes[0]!.payload,
      locked: true,
      custom: { nested: true },
    };
    const report = await buildBoardPackage({
      document,
      viewport: { x: -40, y: -30, zoom: 0.9 },
      now: new Date(2026, 9, 29, 8, 30),
      renderThumbnail: async () =>
        ({
          blob: new Blob([PNG_BYTES], { type: 'image/png' }),
          plan: {},
        }) as unknown as RenderedBoardPng,
    });

    expect(report.fileName).toBe('测试画板-20261029-0830.zxboard');
    expect(report.files).toEqual([
      'manifest.json',
      'board.json',
      'thumbnail.png',
      'checksums.json',
    ]);
    expect(report.manifest.app).toBe('zhixing');
    expect(report.manifest.kind).toBe('board-package');
    expect(report.manifest.formatVersion).toBe(1);
    expect(report.manifest.counts).toEqual({
      nodes: 3,
      edges: 2,
      thumbnail: 1,
    });
    expect(report.thumbnailIncluded).toBe(true);

    const entries = await readZip(report.bytes);
    expect(entries.map((entry) => entry.path).sort()).toEqual(
      report.files.slice().sort(),
    );
    const boardJson = JSON.parse(
      decoder.decode(entries.find((entry) => entry.path === 'board.json')!.data),
    ) as {
      version: number;
      schema: string;
      viewport: unknown;
      nodes: Array<{ id: string; payload: Record<string, unknown> }>;
    };
    expect(boardJson.version).toBe(1);
    expect(boardJson.schema).toBe('zhixing.board');
    expect(boardJson.viewport).toEqual({ x: -40, y: -30, zoom: 0.9 });
    expect(boardJson.nodes[0]!.payload.custom).toEqual({ nested: true });
    expect(boardJson.nodes[0]!.payload.locked).toBe(true);
  });

  it('缩略图渲染失败时省略文件但仍导出 board.json', async () => {
    const report = await buildBoardPackage({
      document: sampleDocument(),
      now: new Date(2026, 9, 29, 8, 30),
      renderThumbnail: async () => {
        throw new Error('canvas unavailable');
      },
    });
    expect(report.files).toEqual([
      'manifest.json',
      'board.json',
      'checksums.json',
    ]);
    expect(report.warnings.join('')).toContain('缩略图生成失败');
    expect(report.thumbnailIncluded).toBe(false);
  });

  it('文件名与接受扩展名符合规范', () => {
    expect(
      boardPackageFileName('发布/流程', new Date(2026, 9, 29, 8, 30)),
    ).toBe('发布 流程-20261029-0830.zxboard');
    expect(
      boardPackageFileName('', new Date(2026, 9, 29, 8, 30)),
    ).toBe('未命名画板-20261029-0830.zxboard');
    expect(BOARD_PACKAGE_ACCEPT).toContain('.zxboard');
    expect(BOARD_PACKAGE_ACCEPT).toContain('.json');
    // 用户主入口只收画板包；JSON 归开发者入口，不能混入包选择器。
    expect(BOARD_PACKAGE_IMPORT_ACCEPT).toBe('.zxboard,application/zip');
    expect(BOARD_PACKAGE_IMPORT_ACCEPT).not.toContain('.json');
  });
});

describe('画板包 .zxboard · 导入解析', () => {
  it('往返读取：文档/连线/viewport/缩略图全部保留，重映射后 ID 全不同', async () => {
    const report = await buildWithThumbnail();
    const parsed = await parseBoardPackage(report.bytes, {
      fileName: report.fileName,
    });

    expect(parsed.document.boardId).toBe('board-1');
    expect(parsed.document.nodes).toHaveLength(3);
    expect(parsed.document.edges).toHaveLength(2);
    expect(parsed.viewport).toEqual({ x: -40, y: -30, zoom: 0.9 });
    expect(parsed.thumbnail).not.toBeNull();
    expect(parsed.warnings).toEqual([]);
    expect(parsed.files).toEqual([
      'board.json',
      'checksums.json',
      'manifest.json',
      'thumbnail.png',
    ]);

    const remapped = remapBoardDocument(parsed.document, {
      boardId: 'board-new',
      noteId: 'note-new',
    });
    expect(remapped.document.boardId).toBe('board-new');
    for (const node of remapped.document.nodes) {
      expect(node.id).not.toBe(
        parsed.document.nodes.find((source) => source.text === node.text)?.id,
      );
    }
    expect(remapped.document.edges[0]!.fromNodeId).toBe(
      remapped.nodeIdMap.get(parsed.document.edges[0]!.fromNodeId),
    );
  });

  it('缺少缩略图仍成功，并给出 ZXBOARD_THUMBNAIL_MISSING 警告', async () => {
    const report = await buildWithThumbnail(false);
    const parsed = await parseBoardPackage(report.bytes);
    expect(parsed.thumbnail).toBeNull();
    expect(parsed.warnings.join('')).toContain('ZXBOARD_THUMBNAIL_MISSING');
  });

  it('篡改 board.json 后校验和不符，零写入', async () => {
    const report = await buildWithThumbnail();
    const entries = await readZip(report.bytes);
    const board = entries.find((entry) => entry.path === 'board.json')!;
    const tampered = encoder.encode(
      decoder.decode(board.data).replace('开始', '被篡改'),
    );
    const files = new Map(entries.map((entry) => [entry.path, entry.data]));
    files.set('board.json', tampered);
    const zip = await createZip(
      Array.from(files.entries()).map(([path, data]) => ({ path, data })),
    );

    expect(await errorCodeOf(() => parseBoardPackage(zip))).toBe(
      'ZXBOARD_CHECKSUM_MISMATCH',
    );
  });

  it('board.json version=2 被拒绝', async () => {
    const report = await buildWithThumbnail();
    const entries = await readZip(report.bytes);
    const board = JSON.parse(
      decoder.decode(entries.find((entry) => entry.path === 'board.json')!.data),
    ) as Record<string, unknown>;
    board.version = 2;
    const zip = await rewriteEntry(
      report.bytes,
      'board.json',
      encoder.encode(JSON.stringify(board)),
    );
    expect(await errorCodeOf(() => parseBoardPackage(zip))).toBe(
      'ZXBOARD_VERSION_UNSUPPORTED',
    );
  });

  it('连线端点指向不存在节点时拒绝导入', async () => {
    const report = await buildWithThumbnail();
    const entries = await readZip(report.bytes);
    const board = JSON.parse(
      decoder.decode(entries.find((entry) => entry.path === 'board.json')!.data),
    ) as { edges: Array<Record<string, unknown>> };
    board.edges[0]!.toNodeId = 'missing-node';
    const zip = await rewriteEntry(
      report.bytes,
      'board.json',
      encoder.encode(JSON.stringify(board)),
    );
    expect(await errorCodeOf(() => parseBoardPackage(zip))).toBe(
      'ZXBOARD_EDGE_DANGLING',
    );
  });

  it('manifest 计数与 board.json 不一致时拒绝导入', async () => {
    const report = await buildWithThumbnail();
    const entries = await readZip(report.bytes);
    const manifest = JSON.parse(
      decoder.decode(
        entries.find((entry) => entry.path === 'manifest.json')!.data,
      ),
    ) as { counts: { nodes: number } };
    manifest.counts.nodes = 99;
    const zip = await rewriteEntry(
      report.bytes,
      'manifest.json',
      encoder.encode(JSON.stringify(manifest)),
    );
    expect(await errorCodeOf(() => parseBoardPackage(zip))).toBe(
      'ZXBOARD_COUNT_MISMATCH',
    );
  });

  it('非 ZIP / 非画板包明确报错', async () => {
    expect(
      await errorCodeOf(() => parseBoardPackage(encoder.encode('{"hello":1}'))),
    ).toBe('ZXBOARD_ZIP_INVALID');
  });
});
