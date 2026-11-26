/**
 * 附件功能入口。
 *
 * 应用侧装配：
 *   const runtime = await createDesktopAttachmentRuntime();
 *   <AttachmentSection manager={runtime.manager} uploader={runtime.uploader} />
 *
 * 编辑器文件块/图片块只需保存 `attachmentId`，文件本体不复制进笔记。
 */

import '../../styles/density.css';
import './attachments.css';

export { AttachmentCard, AttachmentStatusBadge } from './AttachmentCard';
export type { AttachmentCardProps } from './AttachmentCard';
export { AttachmentPanel } from './AttachmentPanel';
export type { AttachmentPanelProps } from './AttachmentPanel';
export { AttachmentSection } from './AttachmentSection';
export type { AttachmentSectionProps } from './AttachmentSection';
export { ImageBlock } from './ImageBlock';
export type { ImageBlockProps, LocalImageState } from './ImageBlock';
export {
  AttachmentManager,
  AttachmentIntegrityError,
  AttachmentNotFoundError,
  RemoteUploadNotAllowedError,
  createAttachmentManager,
  inferMime,
} from './manager';
export type {
  AttachmentManagerOptions,
  IngestOptions,
} from './manager';
export {
  AttachmentUploader,
  createAttachmentUploader,
} from './uploader';
export type { DownloadOptions, UploadOptions } from './uploader';
export {
  HttpAttachmentApi,
  AttachmentApiError,
  createHttpAttachmentTransport,
  initInputFromMetadata,
} from './api';
export type {
  AttachmentTransport,
  CompleteUploadInput,
  FetchLike,
  HttpAttachmentApiOptions,
  InitAttachmentInput,
  InitAttachmentResult,
} from './api';
export {
  createDbAttachmentRepository,
  MemoryAttachmentMetadataRepository,
} from './repository';
export type { AttachmentMetadataRepository } from './repository';
export {
  IndexedDbAttachmentStateStore,
  IndexedDbBlobStore,
  MemoryAttachmentStateStore,
  MemoryBlobStore,
  closeAttachmentDb,
  isIndexedDbAvailable,
  objectUrlFor,
  revokeObjectUrl,
} from './blobStore';
export {
  FileActionError,
  describeSaveResult,
  openAttachmentLocally,
  openBlobWithSystemApp,
  safeFileName,
  saveBlobWithDialog,
  saveLocalAttachment,
} from './fileActions';
export type { OpenedAttachment, SaveResult } from './fileActions';
export type {
  AttachmentStateStore,
  BlobStore,
} from './blobStore';
export {
  DEFAULT_CHUNK_SIZE,
  completeStorageKey,
  createCompleteManifest,
  partStorageKey,
  planAttachmentParts,
  sliceAttachment,
} from './uploadPlan';
export {
  TASK_ATTACHMENT_PREFIX,
  bytesKey,
  describeAttachmentStatus,
  fileExtension,
  formatFileSize,
  isImageAttachment,
  normalizeStateForMode,
  statusLabel,
  taskAttachmentBlockId,
  taskIdFromBlockId,
  toMetadata,
} from './types';
export type {
  AttachmentDisplay,
  AttachmentDisplayState,
  AttachmentDisplayTone,
  AttachmentMetadata,
  AttachmentPart,
  AttachmentProgress,
  AttachmentState,
  AttachmentStatus,
  AttachmentSyncMode,
  DownloadManifest,
  IngestContext,
  IngestResult,
  RemoteAttachment,
  StoredAttachment,
  UploadSession,
} from './types';
export {
  attachmentFilePayload,
  attachmentImagePayload,
  createDesktopAttachmentRuntime,
} from './runtime';
export type {
  AttachmentRuntime,
  AttachmentRuntimeOptions,
} from './runtime';
export { useAttachmentRuntime } from './useAttachmentRuntime';
export type {
  AttachmentRuntimeState,
  UseAttachmentRuntimeOptions,
} from './useAttachmentRuntime';
