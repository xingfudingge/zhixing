import { describe, expect, it, vi } from 'vitest';

import type { OcrEngine } from '../engines';
import {
  OcrService,
  type OcrImageContextResolver,
} from '../service';
import { MemoryOcrSettingsStore } from '../settings';
import { MemoryOcrJobStore } from '../store';
import type { OcrTextSyncSink } from '../textSync';
import {
  DEFAULT_OCR_SETTINGS,
  OcrDisabledError,
  OcrEncryptionBoundaryError,
  OcrScopeError,
  OcrUnavailableError,
  type OcrCapability,
  type OcrResult,
  type OcrSettings,
} from '../types';

const IMAGE = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/png' });
const OTHER_IMAGE = new Blob([new Uint8Array([9, 8, 7, 6])], {
  type: 'image/png',
});

function capability(available = true): OcrCapability {
  return {
    engineId: 'test-engine',
    engineName: '测试本地引擎',
    kind: 'system-local',
    available,
    local: true,
    languages: ['zh-Hans'],
    version: '1',
    reason: available ? null : '测试引擎不可用',
  };
}

function result(text = '识别到的文字'): OcrResult {
  return {
    engineId: 'test-engine',
    engineName: '测试本地引擎',
    text,
    language: 'zh-Hans',
    confidence: 0.9,
    blocks: [{ text, confidence: 0.9, boundingBox: null }],
    durationMs: 12,
    finishedAt: '2026-10-26T10:00:00.000Z',
  };
}

function fakeEngine(overrides: Partial<OcrEngine> = {}): OcrEngine {
  return {
    id: 'test-engine',
    name: '测试本地引擎',
    local: true,
    probe: async () => capability(true),
    recognize: async () => result(),
    ...overrides,
  };
}

function setup(options: {
  enabled?: boolean;
  engine?: OcrEngine;
  encryptionGuard?: () => Promise<{ enabled: boolean; locked: boolean }>;
  settings?: Partial<OcrSettings>;
  imageContext?: OcrImageContextResolver;
  textSync?: OcrTextSyncSink | null;
} = {}) {
  const settingsStore = new MemoryOcrSettingsStore({
    ...DEFAULT_OCR_SETTINGS,
    ...options.settings,
    enabled: options.enabled ?? true,
  });
  const jobStore = new MemoryOcrJobStore();
  let sequence = 0;
  const service = new OcrService({
    settingsStore,
    jobStore,
    engineFactory: () => options.engine ?? fakeEngine(),
    encryptionGuard: options.encryptionGuard,
    imageContext: options.imageContext,
    textSync: options.textSync,
    now: () => '2026-10-26T10:00:00.000Z',
    newId: () => `job_${++sequence}`,
  });
  return { service, jobStore, settingsStore };
}

describe('OCR 服务与队列', () => {
  it('默认关闭时不排队、不识别', async () => {
    const { service, jobStore } = setup({ enabled: false });
    await expect(
      service.enqueue({ attachmentId: 'att_1', image: IMAGE }),
    ).rejects.toBeInstanceOf(OcrDisabledError);
    await expect(service.recognizeTestImage(IMAGE)).rejects.toBeInstanceOf(
      OcrDisabledError,
    );
    expect(await jobStore.list()).toEqual([]);
  });

  it('笔记加密开启时拒绝 OCR 入队，避免明文旁路', async () => {
    const { service, jobStore } = setup({
      encryptionGuard: async () => ({ enabled: true, locked: true }),
    });
    await expect(
      service.enqueue({ attachmentId: 'att_1', image: IMAGE }),
    ).rejects.toBeInstanceOf(OcrEncryptionBoundaryError);
    expect(await jobStore.list()).toEqual([]);
  });

  it('引擎不可用时明确失败，不写成功作业', async () => {
    const { service, jobStore } = setup({
      engine: fakeEngine({
        probe: async () => capability(false),
        recognize: vi.fn(async () => result('不应该被调用')),
      }),
    });
    await expect(
      service.enqueue({ attachmentId: 'att_1', image: IMAGE }),
    ).rejects.toBeInstanceOf(OcrUnavailableError);
    expect(await jobStore.list()).toEqual([]);
  });

  it('同一附件/引擎/图片只保留一个作业，成功后重复入队幂等', async () => {
    const { service, jobStore } = setup();
    const first = await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    const second = await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    expect(second.id).toBe(first.id);
    expect(await jobStore.list()).toHaveLength(1);

    const done = await service.processJob(first.id, async () => IMAGE);
    expect(done.status).toBe('succeeded');
    expect(done.text).toBe('识别到的文字');

    const again = await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    expect(again.status).toBe('succeeded');
    expect(again.text).toBe('识别到的文字');
  });

  it('找不到原图时失败并保留错误原因，可重试成功', async () => {
    const { service, jobStore } = setup({
      engine: fakeEngine({ recognize: async () => result('重试成功') }),
    });
    const job = await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    const missing = await service.processJob(job.id, async () => null);
    expect(missing.status).toBe('failed');
    expect(missing.error).toContain('找不到原图');

    await service.retry(job.id);
    const done = await service.processJob(job.id, async () => IMAGE);
    expect(done.status).toBe('succeeded');
    expect(done.text).toBe('重试成功');
    expect(done.attempts).toBe(2);
    expect(await jobStore.list()).toHaveLength(1);
  });

  it('取消后的作业不会写入识别结果', async () => {
    let release: (() => void) | null = null;
    let signalStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const { service } = setup({
      engine: fakeEngine({
        recognize: async () => {
          signalStarted?.();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return result('迟到的结果');
        },
      }),
    });
    const job = await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    const processing = service.processJob(job.id, async () => IMAGE);
    await started;
    await service.cancel(job.id);
    release!();
    const after = await processing;
    expect(after.status).toBe('canceled');
    expect(after.text).toBeNull();
  });

  it('关闭开关后 processAll 拒绝处理 pending 作业', async () => {
    const { service, settingsStore } = setup();
    await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    settingsStore.save({ ...settingsStore.load(), enabled: false });
    await expect(service.processAll(async () => IMAGE)).rejects.toBeInstanceOf(
      OcrDisabledError,
    );
  });

  it('测试识别返回引擎原始结果，不做补全', async () => {
    const { service } = setup({
      engine: fakeEngine({ recognize: async () => result('') }),
    });
    const output = await service.recognizeTestImage(IMAGE);
    expect(output.text).toBe('');
  });

  it('仅新图片：已有记录时拒绝强制重跑，但相同图片重复入队幂等', async () => {
    const { service } = setup({ settings: { scope: 'new-images' } });
    const first = await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    await service.processJob(first.id, async () => IMAGE);

    const again = await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    expect(again.id).toBe(first.id);
    expect(again.status).toBe('succeeded');

    await expect(
      service.enqueue({ attachmentId: 'att_1', image: IMAGE, force: true }),
    ).rejects.toBeInstanceOf(OcrScopeError);
    await expect(
      service.enqueue({ attachmentId: 'att_1', image: OTHER_IMAGE }),
    ).rejects.toBeInstanceOf(OcrScopeError);
  });

  it('全部图片：允许覆盖已有识别结果重新排队', async () => {
    const { service, jobStore } = setup({ settings: { scope: 'all-images' } });
    const first = await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    const done = await service.processJob(first.id, async () => IMAGE);
    expect(done.status).toBe('succeeded');
    expect(done.text).toBe('识别到的文字');

    const again = await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    expect(again.id).toBe(first.id);
    expect(again.status).toBe('pending');
    expect(again.text).toBeNull();
    expect(again.textSyncState).toBe('local');
    expect(await jobStore.list()).toHaveLength(1);
  });

  it('指定目录：未选目录、无法确认目录、目录不匹配都拒绝入队', async () => {
    const noFolder = setup({ settings: { scope: 'folder' } });
    await expect(
      noFolder.service.enqueue({ attachmentId: 'att_1', image: IMAGE }),
    ).rejects.toThrow(/尚未选择知识库目录/);

    const unknown = setup({
      settings: { scope: 'folder', scopeFolderId: 'f1' },
      imageContext: async () => null,
    });
    await expect(
      unknown.service.enqueue({ attachmentId: 'att_1', image: IMAGE }),
    ).rejects.toThrow(/无法确认该图片所属/);

    const mismatch = setup({
      settings: { scope: 'folder', scopeFolderId: 'f1' },
      imageContext: async (attachmentId) => ({
        attachmentId,
        folderId: 'f2',
      }),
    });
    await expect(
      mismatch.service.enqueue({ attachmentId: 'att_1', image: IMAGE }),
    ).rejects.toBeInstanceOf(OcrScopeError);
  });

  it('指定目录：匹配目录允许入队；目录为空时按范围排队返回明确原因', async () => {
    const context: OcrImageContextResolver = async (attachmentId) => ({
      attachmentId,
      folderId: 'f1',
    });
    const { service } = setup({
      settings: { scope: 'folder', scopeFolderId: 'f1' },
      imageContext: context,
    });
    const job = await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    expect(job.status).toBe('pending');

    const empty = await service.enqueueForScope([], async () => IMAGE);
    expect(empty.queued).toBe(0);
    expect(empty.reasons.join('')).toContain('所选目录没有可识别的图片');
  });

  it('按范围排队只处理匹配目录的候选，并记录缺失原图', async () => {
    const { service, jobStore } = setup({
      settings: { scope: 'folder', scopeFolderId: 'f1' },
    });
    const outcome = await service.enqueueForScope(
      [
        { attachmentId: 'in_folder', folderId: 'f1' },
        { attachmentId: 'other_folder', folderId: 'f2' },
        { attachmentId: 'missing_blob', folderId: 'f1' },
      ],
      async (attachmentId) => (attachmentId === 'missing_blob' ? null : IMAGE),
    );
    expect(outcome.queued).toBe(1);
    expect(outcome.skipped).toBe(1);
    expect(outcome.failed).toBe(1);
    expect(outcome.reasons.join('')).toContain('找不到原图');
    expect(await jobStore.list()).toHaveLength(1);
  });

  it('识别文本设置为同步时调用真实消费方并标记 queued', async () => {
    const sink = vi.fn(async (job) => ({
      queued: true,
      mode: 'backend' as const,
      entityId: job.attachmentId,
      reason: '已进入同步队列',
    }));
    const { service, jobStore } = setup({
      settings: { textStorage: 'sync' },
      textSync: sink,
    });
    const job = await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    const done = await service.processJob(job.id, async () => IMAGE);
    expect(done.status).toBe('succeeded');
    expect(done.textSyncState).toBe('queued');
    expect(done.textSyncError).toBeNull();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0].text).toBe('识别到的文字');
    expect((await jobStore.get(job.id))?.textSyncState).toBe('queued');
  });

  it('同步消费方失败时保留 OCR 成功结果和真实同步错误', async () => {
    const { service } = setup({
      settings: { textStorage: 'sync' },
      textSync: async () => {
        throw new Error('后台尚未配对，识别文本无法进入同步');
      },
    });
    const job = await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    const done = await service.processJob(job.id, async () => IMAGE);
    expect(done.status).toBe('succeeded');
    expect(done.text).toBe('识别到的文字');
    expect(done.textSyncState).toBe('failed');
    expect(done.textSyncError).toContain('尚未配对');
  });

  it('未接入同步消费方时 sync 作业明确标失败，不伪造已同步', async () => {
    const { service } = setup({ settings: { textStorage: 'sync' } });
    const job = await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    const done = await service.processJob(job.id, async () => IMAGE);
    expect(done.status).toBe('succeeded');
    expect(done.textSyncState).toBe('failed');
    expect(done.textSyncError).toContain('未接入同步管线');
  });

  it('读取原图抛错时作业失败并保留原因，队列继续处理下一项', async () => {
    const { service, jobStore } = setup();
    const first = await service.enqueue({ attachmentId: 'att_1', image: IMAGE });
    const second = await service.enqueue({
      attachmentId: 'att_2',
      image: OTHER_IMAGE,
    });
    const results = await service.processAll(async (attachmentId) => {
      if (attachmentId === 'att_1') {
        throw new Error('附件服务不可用');
      }
      return IMAGE;
    });
    expect(results.map((job) => job.status)).toEqual(['failed', 'succeeded']);
    expect((await jobStore.get(first.id))?.error).toContain('附件服务不可用');
    expect((await jobStore.get(second.id))?.status).toBe('succeeded');
  });
});
