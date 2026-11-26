/**
 * 图片块：只渲染本机缓存中的图片，不自动发起下载或上传。
 *
 * 图片不在本机时展示明确占位（“仅远端可用 · 需下载”），绝不显示空白
 * 或伪造缩略图。解码失败同样显示错误，而不是静默当成功。
 */

import { useEffect, useMemo, useState } from 'react';

import { OcrImageAction } from '../ocr/OcrImageAction';
import { createDefaultOcrService } from '../ocr/runtime';
import type { OcrService } from '../ocr/service';
import type { BlobStore } from './blobStore';
import { objectUrlFor, revokeObjectUrl } from './blobStore';
import {
  formatFileSize,
  statusLabel,
  type StoredAttachment,
} from './types';

function readAsDataUrl(blob: Blob): Promise<string | null> {
  if (typeof FileReader === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

export type LocalImageState =
  | { status: 'loading' }
  | { status: 'missing'; message: string }
  | { status: 'ready'; src: string; blob: Blob }
  | { status: 'error'; message: string };

export type ImageBlockProps = {
  attachment: StoredAttachment;
  blobStore: BlobStore;
  alt?: string;
  onRequestDownload?: (attachment: StoredAttachment) => void;
  /** 图片 OCR 服务；不传时自动装配默认服务（与设置页共用偏好）。 */
  ocrService?: OcrService | null;
  onOcrNotice?: (message: string) => void;
};

export function ImageBlock({
  attachment,
  blobStore,
  alt,
  onRequestDownload,
  ocrService,
  onOcrNotice,
}: ImageBlockProps) {
  const [state, setState] = useState<LocalImageState>({ status: 'loading' });
  const defaultOcrService = useMemo(() => createDefaultOcrService(), []);
  const activeOcrService = ocrService === undefined ? defaultOcrService : ocrService;

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;

    void (async () => {
      if (attachment.state.status === 'remote') {
        if (alive) {
          setState({
            status: 'missing',
            message: '图片仅远端可用，需要先下载到本机',
          });
        }
        return;
      }

      let blob: Blob | null = null;
      try {
        blob = await blobStore.get(attachment.state.localBlobKey);
      } catch (reason) {
        if (alive) {
          setState({
            status: 'error',
            message:
              reason instanceof Error ? reason.message : '读取本机图片失败',
          });
        }
        return;
      }

      if (!blob) {
        if (alive) {
          setState({
            status: 'missing',
            message: '本机没有这张图片，需要先下载',
          });
        }
        return;
      }

      objectUrl = objectUrlFor(blob);
      if (objectUrl) {
        if (alive) setState({ status: 'ready', src: objectUrl, blob });
        return;
      }
      const dataUrl = await readAsDataUrl(blob);
      if (!alive) return;
      if (dataUrl) {
        setState({ status: 'ready', src: dataUrl, blob });
      } else {
        setState({ status: 'error', message: '当前环境无法解码图片' });
      }
    })();

    return () => {
      alive = false;
      revokeObjectUrl(objectUrl);
    };
  }, [attachment.state.localBlobKey, attachment.state.status, blobStore]);

  const label = alt ?? attachment.metadata.fileName;

  if (state.status === 'ready') {
    const localBlob = state.blob;
    return (
      <figure className="zx-attach-image">
        <img src={state.src} alt={label} />
        <figcaption>
          {attachment.metadata.fileName} ·{' '}
          {formatFileSize(attachment.metadata.byteSize)}
        </figcaption>
        {activeOcrService ? (
          <OcrImageAction
            service={activeOcrService}
            attachmentId={attachment.metadata.id}
            fileName={attachment.metadata.fileName}
            getImage={async () => localBlob}
            onNotice={onOcrNotice}
          />
        ) : null}
      </figure>
    );
  }

  return (
    <div
      className={`zx-attach-image-placeholder is-${state.status}`}
      role={state.status === 'error' ? 'alert' : 'status'}
      aria-label={`图片块：${label}`}
    >
      <span aria-hidden="true">IMG</span>
      <b>{state.status === 'loading' ? '正在读取本机图片…' : state.message}</b>
      <small>
        {attachment.metadata.fileName} ·{' '}
        {statusLabel(attachment.state.status)}
      </small>
      {state.status === 'missing' && onRequestDownload ? (
        <button
          type="button"
          className="zx-attach-button"
          onClick={() => onRequestDownload(attachment)}
        >
          下载到本机
        </button>
      ) : null}
    </div>
  );
}
