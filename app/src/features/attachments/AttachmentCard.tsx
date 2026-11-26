/**
 * 单个附件卡：状态、打开、上传、下载与删除。
 *
 * 所有网络动作都由按钮触发；组件不会在挂载或插入时自动上传，
 * 图片尤其如此。
 */

import { useState } from 'react';

import { OcrImageAction } from '../ocr/OcrImageAction';
import type { OcrService } from '../ocr/service';
import {
  describeAttachmentStatus,
  fileExtension,
  formatFileSize,
  isImageAttachment,
  type AttachmentDisplay,
  type AttachmentSyncMode,
  type StoredAttachment,
} from './types';

export type AttachmentCardProps = {
  attachment: StoredAttachment;
  /** 本机是否真的有 Blob；由面板查询，避免只看状态字段误判。 */
  hasLocal?: boolean;
  /** 当前设备的同步模式；local 模式不渲染上传入口，也不显示“待上传”。 */
  syncMode?: AttachmentSyncMode;
  /** 是否有可用的同步服务（transport/uploader）。local 模式恒为 false。 */
  serviceAvailable?: boolean;
  allowRemoteImages?: boolean;
  busy?: boolean;
  progress?: number;
  onOpen?: (attachment: StoredAttachment) => void | Promise<void>;
  onSaveLocal?: (attachment: StoredAttachment) => void | Promise<void>;
  onUpload?: (attachment: StoredAttachment, allowRemote: boolean) => void;
  onDownload?: (attachment: StoredAttachment) => void;
  onRemove?: (attachment: StoredAttachment) => void;
  onError?: (message: string) => void;
  /** 图片 OCR 入口；与设置页共用同一份设备偏好。null 表示不展示。 */
  ocrService?: OcrService | null;
  /** 读取本机原图供 OCR 使用；只在 hasLocal 时展示入口。 */
  ocrGetImage?: () => Promise<Blob | null>;
  onOcrNotice?: (message: string) => void;
};

const FILE_ICONS: Record<string, string> = {
  doc: 'W',
  docx: 'W',
  xls: 'X',
  xlsx: 'X',
  ppt: 'P',
  pptx: 'P',
  pdf: 'PDF',
  md: 'MD',
  txt: 'TXT',
  png: 'IMG',
  jpg: 'IMG',
  jpeg: 'IMG',
  gif: 'IMG',
  webp: 'IMG',
  avif: 'IMG',
  svg: 'IMG',
  zip: 'ZIP',
};

export function AttachmentStatusBadge({
  display,
}: {
  display: AttachmentDisplay;
}) {
  return (
    <span
      className={`zx-attach-status is-${display.tone}`}
      data-status={display.state}
      title={display.hint}
    >
      {display.label}
    </span>
  );
}

export function AttachmentCard({
  attachment,
  hasLocal = attachment.state.status !== 'remote',
  syncMode = 'local',
  serviceAvailable = false,
  allowRemoteImages = false,
  busy = false,
  progress,
  onOpen,
  onSaveLocal,
  onUpload,
  onDownload,
  onRemove,
  onError,
  ocrService,
  ocrGetImage,
  onOcrNotice,
}: AttachmentCardProps) {
  const { metadata, state } = attachment;
  const [localError, setLocalError] = useState<string | null>(null);
  const extension = fileExtension(metadata.fileName);
  const icon = FILE_ICONS[extension] ?? '⌁';
  const image = isImageAttachment(metadata);
  const canSync = syncMode !== 'local' && serviceAvailable;
  const display = describeAttachmentStatus({
    status: state.status,
    hasLocal,
    mode: syncMode,
    serviceAvailable,
    remoteId: state.remoteId,
    lastError: state.lastError,
  });
  const canUpload =
    canSync &&
    hasLocal &&
    (state.status === 'local' ||
      state.status === 'pending' ||
      state.status === 'failed');
  // 失败后本机副本仍在：按钮表达“再试一次”，而不是让用户以为从未上传。
  const retryUpload = state.status === 'failed';
  // 只有本机确实没有 Blob 时才显示“从远端下载”，避免上传失败后误显示
  // 一个永远失败的下载按钮。
  const canDownload =
    canSync &&
    !hasLocal &&
    (state.status === 'remote' || state.status === 'failed');

  const run = (fn: () => void | Promise<void>) => {
    setLocalError(null);
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        void result.catch((reason: unknown) => {
          const message =
            reason instanceof Error ? reason.message : '附件操作失败';
          setLocalError(message);
          onError?.(message);
        });
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '附件操作失败';
      setLocalError(message);
      onError?.(message);
    }
  };

  return (
    <article
      className={`zx-attach-card ${image ? 'is-image' : ''}`}
      aria-label={`附件：${metadata.fileName}`}
      data-attachment-id={metadata.id}
      data-status={state.status}
      data-display-state={display.state}
    >
      <span className="zx-attach-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="zx-attach-main">
        <div className="zx-attach-title-line">
          <b className="zx-attach-name">{metadata.fileName}</b>
          <AttachmentStatusBadge display={display} />
        </div>
        <small className="zx-attach-meta">
          {extension ? `${extension.toUpperCase()} · ` : ''}
          {formatFileSize(metadata.byteSize)} · SHA-256{' '}
          <code
            className="zx-attach-hash"
            data-sha256={metadata.sha256}
            title={metadata.sha256}
          >
            {metadata.sha256}
          </code>
        </small>
        {typeof progress === 'number' && busy ? (
          <div
            className="zx-attach-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
            aria-label={`${metadata.fileName} 传输进度`}
          >
            <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
          </div>
        ) : null}
        {state.lastError ? (
          <p className="zx-attach-error" role="alert">
            {state.lastError}
          </p>
        ) : null}
        {localError ? (
          <p className="zx-attach-error" role="alert">
            {localError}
          </p>
        ) : null}
        {!state.lastError &&
        (display.state === 'service_unavailable' ||
          display.state === 'remote_only' ||
          display.state === 'pending_sync') ? (
          <p className="zx-attach-hint">{display.hint}</p>
        ) : null}
        {image ? (
          <p className="zx-attach-hint">
            图片默认只保存在本机；上传前需要显式勾选。
          </p>
        ) : null}
        {image && hasLocal && ocrService && ocrGetImage ? (
          <OcrImageAction
            service={ocrService}
            attachmentId={metadata.id}
            fileName={metadata.fileName}
            getImage={ocrGetImage}
            onNotice={onOcrNotice}
          />
        ) : null}
      </div>
      <div className="zx-attach-actions">
        {hasLocal && onOpen ? (
          <button
            type="button"
            className="zx-attach-button"
            aria-label={`${image ? '预览' : '打开'}附件 ${metadata.fileName}`}
            disabled={busy}
            onClick={() => run(() => onOpen(attachment))}
          >
            {image ? '预览' : '打开'}
          </button>
        ) : null}
        {hasLocal && onSaveLocal ? (
          <button
            type="button"
            className="zx-attach-button"
            aria-label={`另存本机附件 ${metadata.fileName}`}
            disabled={busy}
            onClick={() => run(() => onSaveLocal(attachment))}
          >
            另存
          </button>
        ) : null}
        {canUpload && onUpload ? (
          <button
            type="button"
            className="zx-attach-button is-primary"
            aria-label={
              retryUpload
                ? `重试上传附件 ${metadata.fileName}`
                : `上传附件 ${metadata.fileName}`
            }
            disabled={busy || (image && !allowRemoteImages)}
            title={
              image && !allowRemoteImages
                ? '图片默认不上传；请先勾选允许上传图片'
                : retryUpload
                  ? '上次同步失败；本机副本仍在，可重试上传'
                  : '上传到当前同步服务器'
            }
            onClick={() => run(() => onUpload(attachment, allowRemoteImages))}
          >
            {retryUpload ? '重试' : '上传'}
          </button>
        ) : null}
        {canDownload && onDownload ? (
          <button
            type="button"
            className="zx-attach-button is-primary"
            aria-label={`下载附件 ${metadata.fileName}`}
            disabled={busy}
            onClick={() => run(() => onDownload(attachment))}
          >
            下载
          </button>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            className="zx-attach-button is-danger"
            aria-label={`删除附件 ${metadata.fileName}`}
            disabled={busy}
            onClick={() => run(() => onRemove(attachment))}
          >
            删除
          </button>
        ) : null}
      </div>
    </article>
  );
}
