/**
 * ZX11-QA-02 独立复验（只读产品代码）。
 *
 * 覆盖上一轮 QA 的 OCR scope / 文本同步 / 偏好备份默认提醒：
 * - 三种识别范围不是“只存设置”：new-images 复用/拒绝重跑，all-images 重新排队，
 *   folder 逐入队拒绝未选目录、目录不匹配，并按目录过滤批量候选；
 * - textStorage=sync 在已配对后台时写入真实 outbox；仅本机模式明确失败；
 * - v5 偏好备份往返保留 defaultReminder/completionBehavior；旧版缺键与坏值回退。
 *
 * 真实桌面点击/Apple Vision 结果见 tests/evidence/zx11-qa-02/desktop-*。
 */
import { describe, expect, it } from 'vitest';

import {
  defaultBackupSettings,
  parseSettingsBackup,
  serializeSettingsBackup,
} from '../app/src/features/settings/backup';
import type { Appearance } from '../app/src/app/shell/appearance';
import type { OcrEngine } from '../app/src/features/ocr/engines';
import { OcrService } from '../app/src/features/ocr/service';
import { MemoryOcrSettingsStore } from '../app/src/features/ocr/settings';
import { MemoryOcrJobStore } from '../app/src/features/ocr/store';
import { createOcrTextSyncSink } from '../app/src/features/ocr/textSync';
import {
  OcrScopeError,
  DEFAULT_OCR_SETTINGS,
  type OcrSettings,
} from '../app/src/features/ocr/types';
import { MemorySyncStore } from '../app/src/sync/store';
import type { SyncDeviceProfile } from '../app/src/sync/types';

const IMAGE = new Blob([new Uint8Array([1, 2, 3, 4, 5])], {
  type: 'image/png',
});
const OTHER_IMAGE = new Blob([new Uint8Array([9, 8, 7, 6])], {
  type: 'image/png',
});

const ENGINE: OcrEngine = {
  id: 'qa-fake-local',
  name: 'QA 本地引擎',
  local: true,
  probe: async () => ({
    engineId: 'qa-fake-local',
    engineName: 'QA 本地引擎',
    kind: 'system-local',
    available: true,
    local: true,
    languages: ['zh-Hans'],
    version: '1',
    reason: null,
  }),
  recognize: async () => ({
    engineId: 'qa-fake-local',
    engineName: 'QA 本地引擎',
    text: 'QA-OCR-TEXT',
    language: 'zh-Hans',
    confidence: 0.9,
    blocks: [{ text: 'QA-OCR-TEXT', confidence: 0.9, boundingBox: null }],
    durationMs: 1,
    finishedAt: '2026-11-01T00:00:00.000Z',
  }),
};

function setup(
  settings: Partial<OcrSettings> = {},
  options: {
    imageContext?: (attachmentId: string) => Promise<{
      attachmentId: string;
      folderId: string | null;
    } | null>;
    textSync?: ReturnType<typeof createOcrTextSyncSink> | null;
  } = {},
) {
  const settingsStore = new MemoryOcrSettingsStore({
    ...DEFAULT_OCR_SETTINGS,
    enabled: true,
    ...settings,
  });
  const jobStore = new MemoryOcrJobStore();
  let sequence = 0;
  const service = new OcrService({
    settingsStore,
    jobStore,
    engineFactory: () => ENGINE,
    encryptionGuard: async () => ({ enabled: false, locked: false }),
    imageContext: options.imageContext,
    textSync: options.textSync,
    now: () => '2026-11-01T00:00:01.000Z',
    newId: () => `qa_job_${++sequence}`,
  });
  return { service, jobStore, settingsStore };
}

describe('ZX11-QA-02 OCR 识别范围真实生效', () => {
  it('new-images：相同图片复用原结果；强制重跑/换图被拒绝', async () => {
    const { service } = setup({ scope: 'new-images' });
    const first = await service.enqueue({ attachmentId: 'a1', image: IMAGE });
    const done = await service.processJob(first.id, async () => IMAGE);
    expect(done.status).toBe('succeeded');

    const reused = await service.enqueue({ attachmentId: 'a1', image: IMAGE });
    expect(reused.id).toBe(first.id);
    expect(reused.status).toBe('succeeded');

    await expect(
      service.enqueue({ attachmentId: 'a1', image: IMAGE, force: true }),
    ).rejects.toBeInstanceOf(OcrScopeError);
    await expect(
      service.enqueue({ attachmentId: 'a1', image: OTHER_IMAGE }),
    ).rejects.toBeInstanceOf(OcrScopeError);
  });

  it('all-images：已有结果会重新排队并可再次识别', async () => {
    const { service, jobStore } = setup({ scope: 'all-images' });
    const first = await service.enqueue({ attachmentId: 'a1', image: IMAGE });
    expect((await service.processJob(first.id, async () => IMAGE)).status).toBe(
      'succeeded',
    );

    const again = await service.enqueue({ attachmentId: 'a1', image: IMAGE });
    expect(again.id).toBe(first.id);
    expect(again.status).toBe('pending');
    expect(again.text).toBeNull();
    expect(await jobStore.list()).toHaveLength(1);
    expect((await service.processJob(again.id, async () => IMAGE)).status).toBe(
      'succeeded',
    );
  });

  it('folder：未选目录/无法确认目录/目录不匹配拒绝，匹配目录入队', async () => {
    const unset = setup({ scope: 'folder' });
    await expect(
      unset.service.enqueue({ attachmentId: 'a1', image: IMAGE }),
    ).rejects.toThrow(/尚未选择知识库目录/);

    const unknown = setup(
      { scope: 'folder', scopeFolderId: 'f1' },
      { imageContext: async () => null },
    );
    await expect(
      unknown.service.enqueue({ attachmentId: 'a1', image: IMAGE }),
    ).rejects.toThrow(/无法确认该图片所属/);

    const mismatch = setup(
      { scope: 'folder', scopeFolderId: 'f1' },
      {
        imageContext: async (attachmentId) => ({
          attachmentId,
          folderId: 'f2',
        }),
      },
    );
    await expect(
      mismatch.service.enqueue({ attachmentId: 'a1', image: IMAGE }),
    ).rejects.toBeInstanceOf(OcrScopeError);

    const matched = setup(
      { scope: 'folder', scopeFolderId: 'f1' },
      {
        imageContext: async (attachmentId) => ({
          attachmentId,
          folderId: 'f1',
        }),
      },
    );
    const job = await matched.service.enqueue({
      attachmentId: 'a1',
      image: IMAGE,
    });
    expect(job.status).toBe('pending');
  });

  it('folder：按范围排队只取所选目录，跳过其他目录并返回计数', async () => {
    const { service } = setup({ scope: 'folder', scopeFolderId: 'f1' });
    const outcome = await service.enqueueForScope(
      [
        { attachmentId: 'a1', folderId: 'f1' },
        { attachmentId: 'a2', folderId: 'f2' },
      ],
      async () => IMAGE,
    );
    expect(outcome).toMatchObject({ queued: 1, skipped: 1, failed: 0 });
  });
});

describe('ZX11-QA-02 OCR 文本同步消费方', () => {
  const profile: SyncDeviceProfile = {
    baseUrl: 'https://sync.example.com',
    spaceId: 'personal',
    deviceId: 'qa_device',
    deviceName: 'QA 设备',
    platform: 'macos',
    deviceToken: 'token',
    refreshToken: 'refresh',
    accessExpiresAt: '2026-11-02T00:00:00.000Z',
    refreshExpiresAt: '2026-12-02T00:00:00.000Z',
    features: { sync: true },
    lastPullCursor: '0',
    lastSyncAt: null,
    lastError: null,
  };

  it('后台已配对：sync 作业写入 outbox 并标记 queued', async () => {
    const store = new MemorySyncStore();
    await store.saveProfile(profile);
    const sink = createOcrTextSyncSink({ store, mode: () => 'backend' });
    const { service } = setup(
      { textStorage: 'sync' },
      { textSync: sink },
    );
    const job = await service.enqueue({ attachmentId: 'a1', image: IMAGE });
    const done = await service.processJob(job.id, async () => IMAGE);
    expect(done.status).toBe('succeeded');
    expect(done.textSyncState).toBe('queued');
    expect(done.textSyncError).toBeNull();
    const outbox = await store.listOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.op.entity_type).toBe('ocr_text');
    expect(outbox[0]!.op.entity_id).toBe('a1');
  });

  it('仅本机模式：不伪报成功，作业保留具体失败原因且 outbox 为空', async () => {
    const store = new MemorySyncStore();
    const sink = createOcrTextSyncSink({ store, mode: () => 'local' });
    const { service } = setup(
      { textStorage: 'sync' },
      { textSync: sink },
    );
    const job = await service.enqueue({ attachmentId: 'a1', image: IMAGE });
    const done = await service.processJob(job.id, async () => IMAGE);
    expect(done.status).toBe('succeeded');
    expect(done.textSyncState).toBe('failed');
    expect(done.textSyncError).toContain('仅本机');
    expect(await store.listOutbox()).toHaveLength(0);
  });
});

describe('ZX11-QA-02 偏好备份默认提醒', () => {
  const appearance: Appearance = {
    theme: 'light',
    accent: 'blue',
    density: 'comfortable',
  };

  function seeded() {
    const settings = defaultBackupSettings();
    settings.task.defaultReminder = '15m';
    settings.task.completionBehavior = 'remove';
    return settings;
  }

  function rawV5() {
    return JSON.parse(
      serializeSettingsBackup(seeded(), appearance, new Date('2026-11-01')),
    ) as Record<string, any>;
  }

  it('v5 导出→导入保留 defaultReminder 与 completionBehavior', () => {
    const raw = rawV5();
    expect(raw.version).toBe(5);
    expect(raw.settings.task.defaultReminder).toBe('15m');
    expect(raw.settings.task.completionBehavior).toBe('remove');

    const parsed = parseSettingsBackup(JSON.stringify(raw));
    expect(parsed.settings.task.defaultReminder).toBe('15m');
    expect(parsed.settings.task.completionBehavior).toBe('remove');
  });

  it('v1/v5 缺键与坏值回退关闭，不影响其他设置', () => {
    const missing = rawV5();
    delete missing.settings.task.defaultReminder;
    expect(
      parseSettingsBackup(JSON.stringify(missing)).settings.task,
    ).toMatchObject({ defaultReminder: '', completionBehavior: 'remove' });

    const legacyV1 = rawV5();
    legacyV1.version = 1;
    delete legacyV1.settings.task.defaultReminder;
    expect(
      parseSettingsBackup(JSON.stringify(legacyV1)).settings.task
        .defaultReminder,
    ).toBe('');

    const bad = rawV5();
    bad.settings.task.defaultReminder = '随便';
    bad.settings.task.completionBehavior = 'explode';
    expect(parseSettingsBackup(JSON.stringify(bad)).settings.task).toMatchObject({
      defaultReminder: '',
      completionBehavior: 'keep',
    });

    const numeric = rawV5();
    numeric.settings.task.defaultReminder = 999;
    expect(
      parseSettingsBackup(JSON.stringify(numeric)).settings.task.defaultReminder,
    ).toBe('');

    const legacyText = rawV5();
    legacyText.settings.task.defaultReminder = '提前 15 分钟';
    expect(
      parseSettingsBackup(JSON.stringify(legacyText)).settings.task
        .defaultReminder,
    ).toBe('15m');
  });
});
