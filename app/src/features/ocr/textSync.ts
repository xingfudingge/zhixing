/**
 * OCR 作业 → 同步边车的适配层。
 *
 * 真正的 outbox 写入与同步目标判断在 `features/sync/ocrText.ts`（同步管线）；
 * 本文件只把 `OcrJob` 映射成同步输入，并保持 OCR 模块原有导出不变。
 * `textStorage='sync'` 的作业才会调用同步 sink，失败原因由 `OcrService`
 * 写回作业，不会静默丢弃。
 */

import {
  OCR_TEXT_ENTITY_TYPE,
  OcrTextSyncError,
  createOcrTextSyncSink as createSyncTextSink,
  describeTextSyncAvailability as describeSyncTextAvailability,
  ocrTextSyncPayload as syncTextPayload,
  type OcrTextSyncInput,
  type OcrTextSyncOptions,
  type OcrTextSyncResult,
  type TextSyncAvailability,
  type TextSyncAvailabilityOptions,
} from '../sync/ocrText';
import type { OcrJob } from './types';

export {
  OCR_TEXT_ENTITY_TYPE,
  OcrTextSyncError,
  type OcrTextSyncOptions,
  type OcrTextSyncResult,
  type TextSyncAvailability,
  type TextSyncAvailabilityOptions,
};

export type OcrTextSyncSink = (job: OcrJob) => Promise<OcrTextSyncResult>;

export function ocrTextSyncPayload(job: OcrJob): ReturnType<typeof syncTextPayload> {
  return syncTextPayload(toInput(job));
}

export function describeTextSyncAvailability(
  options: TextSyncAvailabilityOptions = {},
): TextSyncAvailability {
  return describeSyncTextAvailability(options);
}

function toInput(job: OcrJob): OcrTextSyncInput {
  return {
    attachmentId: job.attachmentId,
    text: job.text ?? '',
    language: job.language,
    engineId: job.engineId,
    sourceSha256: job.sourceSha256,
    jobId: job.id,
    recognizedAt: job.updatedAt,
    textStorage: job.textStorage,
  };
}

export function createOcrTextSyncSink(
  options: OcrTextSyncOptions = {},
): OcrTextSyncSink {
  const sink = createSyncTextSink(options);
  return (job) => sink(toInput(job));
}
