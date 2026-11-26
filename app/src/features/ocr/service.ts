/**
 * OCR 用例层：开关检查、排队、去重、重试与真实识别。
 *
 * 关键行为：
 * - `settings.enabled === false` 时任何 enqueue/process 都拒绝，不写假结果；
 * - 引擎 probe 不可用时明确报错，队列不会进入“识别中”；
 * - 同一附件 + 引擎 + 图片哈希只保留一个成功作业，重复入队幂等；
 * - 关闭 OCR 后不再处理 pending 作业（历史结果保留，由用户选择清除）。
 */

import { sha256Blob } from '../attachments/sha256';
import {
  resolveOcrEngine,
  type OcrEngine,
} from './engines';
import type { OcrSettingsStore } from './settings';
import type { OcrJobStore } from './store';
import type { OcrTextSyncSink } from './textSync';
import {
  OcrDisabledError,
  OcrEncryptionBoundaryError,
  OcrScopeError,
  OcrUnavailableError,
  type OcrCapability,
  type OcrImageCandidate,
  type OcrImageContext,
  type OcrJob,
  type OcrResult,
  type OcrScopeEnqueueResult,
  type OcrSettings,
} from './types';

export type OcrImageResolver = (attachmentId: string) => Promise<Blob | null>;

/** 读取附件所属知识库目录；读取不到时返回 null，不猜测目录。 */
export type OcrImageContextResolver = (
  attachmentId: string,
) => Promise<OcrImageContext | null>;

export type OcrEncryptionGuard = () => Promise<{
  enabled: boolean;
  locked: boolean;
}>;

export type OcrServiceOptions = {
  settingsStore: OcrSettingsStore;
  jobStore: OcrJobStore;
  engineFactory?: (settings: OcrSettings) => OcrEngine;
  /** 测试注入；默认读取桌面壳的笔记加密状态。 */
  encryptionGuard?: OcrEncryptionGuard;
  /** 识别范围校验所需的附件/笔记上下文；缺失时 folder 范围会拒绝入队。 */
  imageContext?: OcrImageContextResolver;
  /** 识别文本同步消费方；null 表示当前运行未接入同步（sync 作业会明确失败）。 */
  textSync?: OcrTextSyncSink | null;
  now?: () => string;
  newId?: () => string;
};

async function defaultEncryptionGuard(): Promise<{
  enabled: boolean;
  locked: boolean;
}> {
  const { getNoteEncryptionStatus } = await import('../settings/noteEncryption');
  const status = await getNoteEncryptionStatus();
  return { enabled: status.enabled, locked: status.locked };
}

function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ocr_${crypto.randomUUID()}`;
  }
  return `ocr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class OcrService {
  private readonly settingsStore: OcrSettingsStore;
  private readonly jobStore: OcrJobStore;
  private readonly engineFactory: (settings: OcrSettings) => OcrEngine;
  private readonly encryptionGuard: OcrEncryptionGuard;
  private readonly imageContext?: OcrImageContextResolver;
  private readonly textSync: OcrTextSyncSink | null;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(options: OcrServiceOptions) {
    this.settingsStore = options.settingsStore;
    this.jobStore = options.jobStore;
    this.engineFactory = options.engineFactory ?? ((settings) => resolveOcrEngine(settings));
    this.encryptionGuard = options.encryptionGuard ?? defaultEncryptionGuard;
    this.imageContext = options.imageContext;
    this.textSync = options.textSync ?? null;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? defaultNewId;
  }

  settings(): OcrSettings {
    return this.settingsStore.load();
  }

  saveSettings(next: OcrSettings): OcrSettings {
    return this.settingsStore.save(next);
  }

  engine(): OcrEngine {
    return this.engineFactory(this.settings());
  }

  async capability(): Promise<OcrCapability> {
    return this.engine().probe();
  }

  /**
   * 设置页“测试识别”：使用当前选择的引擎真实识别一张图，不写队列。
   * 关闭开关或引擎不可用时直接报错。
   */
  async recognizeTestImage(image: Blob): Promise<OcrResult> {
    const settings = this.settings();
    if (!settings.enabled) {
      throw new OcrDisabledError();
    }
    const engine = this.engine();
    const capability = await engine.probe();
    if (!capability.available) {
      throw new OcrUnavailableError(capability.reason ?? 'OCR 引擎不可用');
    }
    return engine.recognize(image, { languages: settings.languages });
  }

  async enqueue(input: {
    attachmentId: string;
    image: Blob;
    force?: boolean;
    /** 调用方已知的图片上下文；缺省时通过 imageContext 读取附件/笔记元数据。 */
    context?: OcrImageContext;
  }): Promise<OcrJob> {
    const settings = this.settings();
    if (!settings.enabled) {
      throw new OcrDisabledError();
    }
    await this.assertEncryptionBoundary();
    const engine = this.engine();
    const capability = await engine.probe();
    if (!capability.available) {
      throw new OcrUnavailableError(capability.reason ?? 'OCR 引擎不可用');
    }
    const sourceSha256 = await sha256Blob(input.image);
    const dedupeKey = `${input.attachmentId}:${engine.id}:${sourceSha256}`;
    const jobs = await this.jobStore.list();
    const existing = jobs.find((job) => job.dedupeKey === dedupeKey);
    const attachmentJobs = jobs.filter(
      (job) => job.attachmentId === input.attachmentId,
    );
    const context =
      input.context ??
      (this.imageContext ? await this.imageContext(input.attachmentId) : null);

    // 识别范围必须参与入队 gate，而不是只写进设置。
    this.assertScopeAllows({
      settings,
      attachmentId: input.attachmentId,
      existing,
      attachmentJobs,
      dedupeKey,
      force: input.force === true,
      context,
    });

    // all-images 的语义就是允许覆盖已有结果；其余范围只有显式 force 才重跑。
    const effectiveForce = input.force ?? settings.scope === 'all-images';
    if (existing && !effectiveForce) {
      return existing;
    }
    const timestamp = this.now();
    const job: OcrJob = {
      id: existing?.id ?? this.newId(),
      attachmentId: input.attachmentId,
      status: 'pending',
      engineId: engine.id,
      dedupeKey,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      attempts: existing?.attempts ?? 0,
      text: null,
      language: null,
      error: null,
      textStorage: settings.textStorage,
      textSyncState: settings.textStorage === 'sync' ? 'pending' : 'local',
      textSyncError: null,
      sourceSha256,
    };
    await this.jobStore.put(job);
    return job;
  }

  private assertScopeAllows(input: {
    settings: OcrSettings;
    attachmentId: string;
    existing: OcrJob | undefined;
    attachmentJobs: OcrJob[];
    dedupeKey: string;
    force: boolean;
    context: OcrImageContext | null;
  }): void {
    const { settings, existing, attachmentJobs, dedupeKey, force, context } =
      input;

    if (settings.scope === 'folder') {
      if (!settings.scopeFolderId) {
        throw new OcrScopeError(
          '识别范围为“指定目录”，但尚未选择知识库目录；已拒绝入队。请先选择目录，或改用“仅新图片/全部图片”。',
        );
      }
      if (!context) {
        throw new OcrScopeError(
          '识别范围为“指定目录”，但无法确认该图片所属的知识库目录；已拒绝入队，避免越界识别。',
        );
      }
      if (context.folderId !== settings.scopeFolderId) {
        throw new OcrScopeError(
          `该图片不在所选知识库目录（${settings.scopeFolderId}）内；已拒绝入队。画册/未分类图片请改用“仅新图片”或“全部图片”。`,
        );
      }
      return;
    }

    if (settings.scope !== 'new-images') {
      return;
    }

    if (existing && force) {
      throw new OcrScopeError(
        '识别范围为“仅新图片”，不能重跑已有图片；如需重新识别，请先切换到“全部图片”。',
      );
    }
    // 同一附件换了引擎/内容时会生成不同去重键；仍然属于“旧图”，拒绝。
    const otherRecord = attachmentJobs.find((job) => job.dedupeKey !== dedupeKey);
    if (otherRecord) {
      throw new OcrScopeError(
        '识别范围为“仅新图片”，该图片已有识别记录；如需重新识别，请先切换到“全部图片”。',
      );
    }
  }

  async processJob(
    id: string,
    resolveImage: OcrImageResolver,
  ): Promise<OcrJob> {
    const settings = this.settings();
    if (!settings.enabled) {
      throw new OcrDisabledError();
    }
    await this.assertEncryptionBoundary();
    const job = await this.jobStore.get(id);
    if (!job) {
      throw new OcrUnavailableError(`OCR 作业不存在：${id}`);
    }
    if (job.status === 'succeeded' || job.status === 'canceled') {
      return job;
    }
    let image: Blob | null = null;
    try {
      image = await resolveImage(job.attachmentId);
    } catch (reason) {
      const failed: OcrJob = {
        ...job,
        status: 'failed',
        attempts: job.attempts + 1,
        error: reason instanceof Error ? reason.message : '读取原图失败',
        updatedAt: this.now(),
      };
      await this.jobStore.put(failed);
      return failed;
    }
    if (!image) {
      const failed: OcrJob = {
        ...job,
        status: 'failed',
        attempts: job.attempts + 1,
        error: '找不到原图；无法识别（不会生成占位结果）',
        updatedAt: this.now(),
      };
      await this.jobStore.put(failed);
      return failed;
    }

    const processing: OcrJob = {
      ...job,
      status: 'processing',
      attempts: job.attempts + 1,
      error: null,
      updatedAt: this.now(),
    };
    await this.jobStore.put(processing);

    try {
      const engine = this.engine();
      const capability = await engine.probe();
      if (!capability.available) {
        throw new OcrUnavailableError(capability.reason ?? 'OCR 引擎不可用');
      }
      const result = await engine.recognize(image, {
        languages: settings.languages,
      });
      const latest = await this.jobStore.get(id);
      if (latest?.status === 'canceled') {
        return latest;
      }
      const succeeded: OcrJob = {
        ...processing,
        status: 'succeeded',
        text: result.text,
        language: result.language,
        error: null,
        textSyncState:
          job.textStorage === 'sync' ? 'pending' : 'local',
        textSyncError: null,
        updatedAt: this.now(),
      };
      await this.jobStore.put(succeeded);

      if (job.textStorage !== 'sync') {
        return succeeded;
      }
      return this.queueRecognizedText(succeeded);
    } catch (reason) {
      const latest = await this.jobStore.get(id);
      if (latest?.status === 'canceled') {
        return latest;
      }
      const failed: OcrJob = {
        ...processing,
        status: 'failed',
        error: reason instanceof Error ? reason.message : 'OCR 识别失败',
        updatedAt: this.now(),
      };
      await this.jobStore.put(failed);
      return failed;
    }
  }

  /**
   * 识别文本进入同步管线。失败不改变 OCR 成功状态，只把 `textSyncState`
   * 标成 failed 并保留真实原因；不会静默丢弃或伪报“已同步”。
   */
  private async queueRecognizedText(job: OcrJob): Promise<OcrJob> {
    if (!this.textSync) {
      const failed: OcrJob = {
        ...job,
        textSyncState: 'failed',
        textSyncError:
          '当前运行未接入同步管线；识别文本只保存在本机，未上传。',
        updatedAt: this.now(),
      };
      await this.jobStore.put(failed);
      return failed;
    }
    try {
      const result = await this.textSync(job);
      if (!result.queued) {
        const failed: OcrJob = {
          ...job,
          textSyncState: 'failed',
          textSyncError: result.reason,
          updatedAt: this.now(),
        };
        await this.jobStore.put(failed);
        return failed;
      }
      const queued: OcrJob = {
        ...job,
        textSyncState: 'queued',
        textSyncError: null,
        updatedAt: this.now(),
      };
      await this.jobStore.put(queued);
      return queued;
    } catch (reason) {
      const failed: OcrJob = {
        ...job,
        textSyncState: 'failed',
        textSyncError:
          reason instanceof Error ? reason.message : '识别文本进入同步队列失败',
        updatedAt: this.now(),
      };
      await this.jobStore.put(failed);
      return failed;
    }
  }

  /**
   * 按当前识别范围批量排队。folder 会先过滤目录；目录为空时返回 queued=0
   * 并给出明确原因，不会伪造一条识别记录。
   */
  async enqueueForScope(
    candidates: OcrImageCandidate[],
    resolveImage: OcrImageResolver,
  ): Promise<OcrScopeEnqueueResult> {
    const settings = this.settings();
    if (!settings.enabled) {
      throw new OcrDisabledError();
    }
    if (settings.scope === 'folder' && !settings.scopeFolderId) {
      throw new OcrScopeError(
        '识别范围为“指定目录”，但尚未选择知识库目录；请先选择目录再排队。',
      );
    }

    const output: OcrScopeEnqueueResult = {
      queued: 0,
      skipped: 0,
      failed: 0,
      reasons: [],
    };
    let eligible = candidates;
    if (settings.scope === 'folder') {
      eligible = candidates.filter(
        (candidate) => candidate.folderId === settings.scopeFolderId,
      );
      output.skipped += candidates.length - eligible.length;
      if (eligible.length === 0) {
        output.reasons.push('所选目录没有可识别的图片。');
        return output;
      }
    }

    for (const candidate of eligible) {
      try {
        const image = await resolveImage(candidate.attachmentId);
        if (!image) {
          output.failed += 1;
          output.reasons.push(`${candidate.attachmentId}：找不到原图`);
          continue;
        }
        const job = await this.enqueue({
          attachmentId: candidate.attachmentId,
          image,
          context: candidate,
        });
        if (job.status === 'pending' || job.status === 'processing') {
          output.queued += 1;
        } else {
          output.skipped += 1;
        }
      } catch (reason) {
        if (reason instanceof OcrScopeError) {
          output.skipped += 1;
        } else {
          output.failed += 1;
        }
        output.reasons.push(
          reason instanceof Error ? reason.message : 'OCR 入队失败',
        );
      }
    }
    return output;
  }

  async processAll(resolveImage: OcrImageResolver): Promise<OcrJob[]> {
    if (!this.settings().enabled) {
      throw new OcrDisabledError();
    }
    await this.assertEncryptionBoundary();
    const jobs = await this.jobStore.list();
    const results: OcrJob[] = [];
    for (const job of jobs) {
      if (job.status === 'pending') {
        results.push(await this.processJob(job.id, resolveImage));
      }
    }
    return results;
  }

  async retry(id: string): Promise<OcrJob> {
    const job = await this.jobStore.get(id);
    if (!job) throw new OcrUnavailableError(`OCR 作业不存在：${id}`);
    if (job.status !== 'failed' && job.status !== 'canceled') {
      return job;
    }
    const next: OcrJob = {
      ...job,
      status: 'pending',
      error: null,
      textSyncState:
        job.textStorage === 'sync' ? 'pending' : 'local',
      textSyncError: null,
      updatedAt: this.now(),
    };
    await this.jobStore.put(next);
    return next;
  }

  async cancel(id: string): Promise<OcrJob> {
    const job = await this.jobStore.get(id);
    if (!job) throw new OcrUnavailableError(`OCR 作业不存在：${id}`);
    const next: OcrJob = {
      ...job,
      status: 'canceled',
      updatedAt: this.now(),
    };
    await this.jobStore.put(next);
    return next;
  }

  async listJobs(): Promise<OcrJob[]> {
    return this.jobStore.list();
  }

  async counts(): Promise<Record<OcrJob['status'], number>> {
    const jobs = await this.jobStore.list();
    const counts: Record<OcrJob['status'], number> = {
      pending: 0,
      processing: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0,
    };
    for (const job of jobs) {
      counts[job.status] += 1;
    }
    return counts;
  }

  /**
   * 加密边界：开启后 OCR 文本会落在 SQLite 之外的 IndexedDB，形成明文旁路。
   * 状态不可确认时同样拒绝，避免“读不到状态就默认放行”。
   */
  private async assertEncryptionBoundary(): Promise<void> {
    try {
      const status = await this.encryptionGuard();
      if (status.enabled) {
        throw new OcrEncryptionBoundaryError();
      }
    } catch (reason) {
      if (reason instanceof OcrEncryptionBoundaryError) {
        throw reason;
      }
      throw new OcrEncryptionBoundaryError(
        '无法确认笔记加密状态，已拒绝 OCR 以避免明文旁路；请稍后重试。',
      );
    }
  }

  /** 清除失败/取消/已完成作业（保留待处理与识别中）。 */
  async clearFinished(): Promise<void> {
    const jobs = await this.jobStore.list();
    for (const job of jobs) {
      if (job.status !== 'pending' && job.status !== 'processing') {
        await this.jobStore.put({
          ...job,
          status: 'canceled',
          text: null,
          textSyncState: job.textStorage === 'sync' ? 'pending' : 'local',
          textSyncError: null,
        });
      }
    }
  }
}

export function createOcrService(options: OcrServiceOptions): OcrService {
  return new OcrService(options);
}
