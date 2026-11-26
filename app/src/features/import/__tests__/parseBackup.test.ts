import { describe, expect, it } from 'vitest';

import { buildJsonBackup, buildZipBackup } from '../../export/serialize';
import { createZip, readZip } from '../../export/zip';
import {
  FIXED_NOW,
  makeBlobs,
  makePayload,
} from '../../export/__tests__/testFixtures';
import { BackupParseError, parseBackupFile } from '../parseBackup';

async function rebuildZipWith(
  bytes: Uint8Array,
  path: string,
  data: Uint8Array,
): Promise<Uint8Array> {
  const entries = await readZip(bytes);
  return createZip(
    entries.map((entry) =>
      entry.path === path ? { path, data } : { path: entry.path, data: entry.data },
    ),
  );
}

describe('备份导入校验', () => {
  it('篡改附件二进制会被 SHA-256 拒绝', async () => {
    const exported = await buildZipBackup(makePayload(), makeBlobs(), FIXED_NOW);
    const parsed = await parseBackupFile(exported.bytes);
    const attachmentPath = parsed.manifest.attachments[0]!.path!;
    const tampered = await rebuildZipWith(
      exported.bytes,
      attachmentPath,
      new TextEncoder().encode('tampered bytes'),
    );
    await expect(parseBackupFile(tampered)).rejects.toMatchObject({
      name: 'BackupParseError',
    });
  });

  it('ZIP 缺少 manifest 时拒绝', async () => {
    const zip = createZip([
      { path: 'data/entities.json', data: new TextEncoder().encode('{}') },
    ]);
    await expect(parseBackupFile(zip)).rejects.toThrow(/manifest/);
  });

  it('JSON 没有 manifest 时重建并给出提示', async () => {
    const exported = buildJsonBackup(makePayload(), FIXED_NOW);
    const raw = JSON.parse(new TextDecoder().decode(exported.bytes));
    delete raw.manifest;
    const bytes = new TextEncoder().encode(JSON.stringify(raw));
    const parsed = await parseBackupFile(bytes);
    expect(parsed.manifest.counts.tasks).toBe(2);
    expect(
      parsed.warnings.some((warning) => warning.code === 'manifest.rebuilt'),
    ).toBe(true);
  });

  it('包含非白名单设置键的备份被拒绝', async () => {
    const payload = makePayload();
    payload.dataset.settings.push({
      id: 'setting-token',
      spaceId: 'personal',
      scope: 'device',
      key: 'sync.token',
      value: 'leaked-token',
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
      version: 1,
    });
    const exported = buildJsonBackup(payload, FIXED_NOW);
    await expect(parseBackupFile(exported.bytes)).rejects.toThrow(/不允许导出/);
  });

  it('悬空关系只给警告，恢复计划会阻止相关写入', async () => {
    const payload = makePayload();
    payload.dataset.tasks[0]!.noteId = 'missing-note';
    const exported = buildJsonBackup(payload, FIXED_NOW);
    const parsed = await parseBackupFile(exported.bytes);
    expect(parsed.danglingRelations.length).toBeGreaterThan(0);
    expect(parsed.warnings.some((warning) => warning.code === 'relations.dangling')).toBe(
      true,
    );
  });

  it('事件历法在 JSON/ZIP 备份中原样往返，缺省旧数据回退为公历', async () => {
    const payload = makePayload();
    payload.dataset.events[0]!.calendarType = 'lunar';
    const json = await parseBackupFile(buildJsonBackup(payload, FIXED_NOW).bytes);
    expect(json.payload.dataset.events[0]?.calendarType).toBe('lunar');

    const zip = await parseBackupFile(
      (await buildZipBackup(payload, makeBlobs(), FIXED_NOW)).bytes,
    );
    expect(zip.payload.dataset.events[0]?.calendarType).toBe('lunar');

    // v3 备份（AUD-024 之前）没有该字段，导入必须回退为公历而不是报错。
    const legacy = makePayload();
    delete (legacy.dataset.events[0] as { calendarType?: string }).calendarType;
    const parsedLegacy = await parseBackupFile(
      buildJsonBackup(legacy, FIXED_NOW).bytes,
    );
    expect(parsedLegacy.payload.dataset.events[0]?.calendarType).toBe('solar');
  });

  it('未识别文件只给警告，不阻断恢复', async () => {
    const exported = await buildZipBackup(makePayload(), makeBlobs(), FIXED_NOW);
    const entries = await readZip(exported.bytes);
    const zip = createZip([
      ...entries.map((entry) => ({ path: entry.path, data: entry.data })),
      { path: 'notes/readme.txt', data: new TextEncoder().encode('hello') },
    ]);
    const parsed = await parseBackupFile(zip);
    expect(parsed.warnings.some((warning) => warning.code === 'zip.extraEntry')).toBe(
      true,
    );
  });

  it('备份版本不匹配时拒绝', async () => {
    const exported = buildJsonBackup(makePayload(), FIXED_NOW);
    const raw = JSON.parse(new TextDecoder().decode(exported.bytes));
    raw.formatVersion = 99;
    await expect(
      parseBackupFile(new TextEncoder().encode(JSON.stringify(raw))),
    ).rejects.toBeInstanceOf(BackupParseError);
  });
});
