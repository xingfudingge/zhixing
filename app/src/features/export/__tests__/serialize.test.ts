import { describe, expect, it } from 'vitest';

import { sha256Bytes } from '../../attachments/sha256';
import { datasetCounts } from '../dataset';
import {
  buildCsvArchive,
  buildJsonBackup,
  buildMarkdownExport,
  buildZipBackup,
} from '../serialize';
import { createZip, readZip } from '../zip';
import { parseBackupFile } from '../../import/parseBackup';
import {
  ATTACHMENT_SHA,
  FIXED_NOW,
  makeBlobs,
  makeDataset,
  makePayload,
} from './testFixtures';

const decoder = new TextDecoder();

describe('完整备份序列化', () => {
  it('ZIP 含 manifest、附件哈希、关系与每块画板 JSON', async () => {
    const payload = makePayload();
    const result = await buildZipBackup(payload, makeBlobs(), FIXED_NOW);
    const entries = await readZip(result.bytes);
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain('manifest.json');
    expect(paths).toContain('data/entities.json');
    expect(paths).toContain('data/relations.json');
    expect(paths).toContain('boards/board-a.json');
    expect(paths.some((path) => path.startsWith('attachments/'))).toBe(true);

    const manifestEntry = entries.find((entry) => entry.path === 'manifest.json')!;
    const manifest = JSON.parse(decoder.decode(manifestEntry.data));
    expect(manifest.app).toBe('zhixing');
    expect(manifest.counts).toEqual(datasetCounts(payload.dataset));
    expect(manifest.relations.total).toBeGreaterThan(0);
    expect(manifest.attachments[0].sha256).toBe(ATTACHMENT_SHA);
    expect(manifest.attachments[0].path).toBeTruthy();
    expect(manifest.security.secretsExcluded).toBe(true);

    for (const meta of manifest.entries) {
      const entry = entries.find((item) => item.path === meta.path);
      expect(entry, `缺少条目 ${meta.path}`).toBeTruthy();
      expect(sha256Bytes(entry!.data)).toBe(meta.sha256);
      expect(entry!.data.byteLength).toBe(meta.byteSize);
    }

    const attachmentEntry = entries.find(
      (entry) => entry.path === manifest.attachments[0].path,
    )!;
    expect(sha256Bytes(attachmentEntry.data)).toBe(ATTACHMENT_SHA);
    expect(decoder.decode(attachmentEntry.data)).toBe('release checklist');

    const allText = entries
      .filter((entry) => entry.path.endsWith('.json'))
      .map((entry) => decoder.decode(entry.data))
      .join('\n');
    expect(allText).not.toContain('secret-token');
    expect(allText).not.toContain('password');
    expect(manifest.settings.excludedKeys).toEqual(['sync.token']);
  });

  it('ZIP 可被导入解析，附件二进制与关系完整', async () => {
    const payload = makePayload();
    const exported = await buildZipBackup(payload, makeBlobs(), FIXED_NOW);
    const parsed = await parseBackupFile(exported.bytes, exported.fileName);
    expect(parsed.format).toBe('zip');
    expect(parsed.payload.dataset.notes).toHaveLength(payload.dataset.notes.length);
    expect(parsed.payload.dataset.boards[0]!.nodes).toHaveLength(2);
    expect(parsed.payload.dataset.boards[0]!.edges).toHaveLength(1);
    expect(parsed.blobs.get('attachment-a')!.size).toBe('release checklist'.length);
    expect(parsed.relations.length).toBe(parsed.manifest.relations.total);
    expect(parsed.danglingRelations).toHaveLength(0);
    expect(parsed.warnings).toHaveLength(0);
  });

  it('JSON 备份不含附件二进制，仍能完整解析', async () => {
    const payload = makePayload();
    const exported = buildJsonBackup(payload, FIXED_NOW);
    expect(exported.manifest?.attachments[0].path).toBeNull();
    const parsed = await parseBackupFile(exported.bytes, exported.fileName);
    expect(parsed.format).toBe('json');
    expect(parsed.blobs.size).toBe(0);
    expect(parsed.payload.dataset.tasks).toHaveLength(2);
    const text = decoder.decode(exported.bytes);
    expect(text).not.toContain('secret-token');
  });

  it('缺附件二进制时 manifest 标记、导入后仅剩元数据', async () => {
    const payload = makePayload();
    const exported = await buildZipBackup(payload, new Map(), FIXED_NOW);
    expect(exported.manifest!.attachments[0].path).toBeNull();
    expect(exported.warnings.length).toBeGreaterThan(0);
    const parsed = await parseBackupFile(exported.bytes);
    expect(parsed.blobs.size).toBe(0);
    expect(parsed.payload.dataset.attachments).toHaveLength(1);
  });

  it('Markdown 保留笔记、任务、画板、关系与附件哈希', () => {
    const exported = buildMarkdownExport(makePayload(), FIXED_NOW);
    const text = decoder.decode(exported.bytes);
    expect(text).toContain('# 知行 · 完整导出');
    expect(text).toContain('### 发布检查');
    expect(text).toContain('整理发布清单');
    expect(text).toContain('### 发布流程');
    expect(text).toContain('release.txt');
    expect(text).toContain(ATTACHMENT_SHA);
    expect(text).toContain('task.note');
    expect(text).not.toContain('secret-token');
  });

  it('CSV 导出为多表 ZIP，含 BOM 与 manifest', async () => {
    const exported = buildCsvArchive(makePayload(), FIXED_NOW);
    const entries = await readZip(exported.bytes);
    const paths = entries.map((entry) => entry.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'tasks.csv',
        'notes.csv',
        'events.csv',
        'habit_logs.csv',
        'review_snapshots.csv',
        'boards.csv',
        'attachments.csv',
        'relations.csv',
        'manifest.json',
      ]),
    );
    const tasks = entries.find((entry) => entry.path === 'tasks.csv')!;
    expect(Array.from(tasks.data.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = decoder.decode(tasks.data);
    expect(text).toContain('整理发布清单');
    expect(text).toContain('"title"');
    expect(text).not.toContain('secret-token');

    // AUD-024：事件历法必须出现在 events.csv，不能只存在于 JSON 备份。
    const events = entries.find((entry) => entry.path === 'events.csv')!;
    const eventsText = decoder.decode(events.data);
    expect(eventsText.split('\n')[0]).toContain('calendarType');
    expect(eventsText).toContain('发布评审');
  });

  it('拒绝重复路径与损坏数据由 ZIP 层兜底', async () => {
    expect(() =>
      createZip([
        { path: 'a', data: new Uint8Array([1]) },
        { path: 'a', data: new Uint8Array([2]) },
      ]),
    ).toThrow(/重复/);
    const payload = makePayload(makeDataset());
    const exported = await buildZipBackup(payload, makeBlobs(), FIXED_NOW);
    const entries = await readZip(exported.bytes);
    const manifest = entries.find((entry) => entry.path === 'manifest.json')!;
    const entities = entries.find((entry) => entry.path === 'data/entities.json')!;
    const tampered = createZip([
      { path: manifest.path, data: manifest.data },
      { path: entities.path, data: new Uint8Array(entities.data).fill(0) },
    ]);
    await expect(parseBackupFile(tampered)).rejects.toThrow(/SHA-256|校验/);
  });
});
