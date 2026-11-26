/**
 * OCR 功能入口。
 *
 * 设置面板：
 *   const ocr = createDefaultOcrService();
 *   <OcrPanel service={ocr} resolveImage={...} />
 *
 * 附件/图片块入口：
 *   <OcrImageAction service={ocr} attachmentId={...} getImage={...} />
 *
 * 队列处理需要原图读取器；附件模块可通过 `attachmentOcrImageResolver`
 * 提供，识别文本默认只留在本机。
 */

import './ocr.css';

export { OcrPanel } from './OcrPanel';
export type { OcrPanelProps } from './OcrPanel';
export { OcrImageAction } from './OcrImageAction';
export type { OcrImageActionProps } from './OcrImageAction';
export { OcrService, createOcrService } from './service';
export type {
  OcrImageContextResolver,
  OcrImageResolver,
  OcrServiceOptions,
} from './service';
export {
  OCR_TEXT_ENTITY_TYPE,
  OcrTextSyncError,
  createOcrTextSyncSink,
  describeTextSyncAvailability,
  ocrTextSyncPayload,
} from './textSync';
export type {
  OcrTextSyncOptions,
  OcrTextSyncResult,
  OcrTextSyncSink,
  TextSyncAvailability,
  TextSyncAvailabilityOptions,
} from './textSync';
export {
  BrowserTextDetectorEngine,
  CustomAdapterEngine,
  MAX_OCR_IMAGE_BYTES,
  NativeVisionEngine,
  UnavailableOcrEngine,
  isDesktopOcrRuntime,
  resolveOcrEngine,
} from './engines';
export type {
  NativeOcrBridge,
  NativeOcrCapability,
  NativeOcrFailure,
  NativeOcrResult,
  OcrEngine,
  OcrEngineEnvironment,
} from './engines';
export {
  OCR_LANGUAGES,
  OCR_SETTINGS_KEY,
  LocalStorageOcrSettingsStore,
  MemoryOcrSettingsStore,
  defaultOcrSettingsStore,
  normalizeOcrSettings,
  normalizeEndpoint,
} from './settings';
export type { OcrSettingsStore, StorageLike } from './settings';
export { IndexedDbOcrJobStore, MemoryOcrJobStore, resetOcrJobDb } from './store';
export type { OcrJobStore } from './store';
export {
  attachmentOcrImageResolver,
  createAttachmentQueueResolver,
  createDefaultOcrService,
  createMemoryOcrService,
  listAttachmentOcrCandidates,
  resolveAttachmentImageContext,
} from './runtime';
export {
  DEFAULT_OCR_SETTINGS,
  OcrDisabledError,
  OcrProtocolError,
  OcrRemoteConsentError,
  OcrScopeError,
  OcrUnavailableError,
  isLocalEndpoint,
  isScopeConfigured,
  jobStatusLabel,
  redactEndpoint,
  scopeLabel,
  textSyncStateLabel,
} from './types';
export type {
  OcrBlock,
  OcrCapability,
  OcrEngineKind,
  OcrImageCandidate,
  OcrImageContext,
  OcrJob,
  OcrJobStatus,
  OcrResult,
  OcrScope,
  OcrScopeEnqueueResult,
  OcrSettings,
  OcrTextSyncState,
} from './types';
