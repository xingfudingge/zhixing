/**
 * 附件/图片块里的 OCR 入口。
 *
 * 与设置页共用同一个 `OcrService`：开关、引擎、语言、结果保存位置都从
 * 设备偏好实时读取。默认关闭时按钮禁用并给出设置路径；引擎不可用或
 * 调用失败时显示真实错误，不生成任何示例文字。
 */

import { useCallback, useState } from 'react';

import type { OcrService } from './service';
import {
  isScopeConfigured,
  textSyncStateLabel,
  type OcrSettings,
  type OcrTextSyncState,
} from './types';
import './ocr.css';

export type OcrImageActionProps = {
  service: OcrService;
  attachmentId: string;
  fileName: string;
  /** 读取本机原图；调用方必须校验/读取真实 Blob，不能用占位图。 */
  getImage: () => Promise<Blob | null>;
  onNotice?: (message: string) => void;
};

type RecognizedText = {
  text: string;
  textStorage: OcrSettings['textStorage'];
  textSyncState: OcrTextSyncState;
  textSyncError: string | null;
};

function messageOf(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  return '图片 OCR 识别失败';
}

export function OcrImageAction({
  service,
  attachmentId,
  fileName,
  getImage,
  onNotice,
}: OcrImageActionProps) {
  const [settings, setSettings] = useState<OcrSettings>(() => service.settings());
  const [recognizing, setRecognizing] = useState(false);
  const [result, setResult] = useState<RecognizedText | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshSettings = useCallback((): OcrSettings => {
    const next = service.settings();
    setSettings(next);
    return next;
  }, [service]);

  const handleRecognize = useCallback(async () => {
    const current = refreshSettings();
    setResult(null);
    setError(null);

    if (!current.enabled) {
      setError('图片 OCR 默认关闭；请在 设置 → 知识库与 OCR 开启后再识别。');
      return;
    }

    setRecognizing(true);
    try {
      const image = await getImage();
      if (!image) {
        throw new Error('本机没有这张图片的原图，无法识别（不会伪造结果）。');
      }
      const job = await service.enqueue({ attachmentId, image });
      // 用同一份 Blob 处理，避免设置页/附件页再次读取时图片已被移走。
      const done = await service.processJob(job.id, async () => image);
      if (done.status === 'succeeded') {
        setResult({
          text: done.text ?? '',
          textStorage: done.textStorage,
          textSyncState: done.textSyncState,
          textSyncError: done.textSyncError,
        });
        onNotice?.(
          done.text?.trim()
            ? 'OCR 识别完成；文本来自当前引擎，未做任何补全。'
            : '引擎返回空文本：没有识别到文字（不是模拟结果）。',
        );
      } else {
        setError(done.error ?? 'OCR 识别失败，未生成任何结果');
      }
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setRecognizing(false);
    }
  }, [attachmentId, getImage, onNotice, refreshSettings, service]);

  const scopeReady = isScopeConfigured(settings);
  const disabled = !settings.enabled || recognizing || !scopeReady;
  const storageHint =
    settings.textStorage === 'local'
      ? '识别文本只保存在本机，不参与同步。'
      : '识别文本进入同步队列（只同步文本，不上传图片）；文本可能暴露图片中的信息。';
  const scopeHint =
    settings.scope === 'folder' && !settings.scopeFolderId
      ? '识别范围为“指定目录”，但尚未选择知识库目录；请先到 设置 → 知识库与 OCR 选择目录。'
      : null;

  return (
    <div className="zx-ocr-entry" data-ocr-enabled={settings.enabled}>
      <div className="zx-ocr-entry-actions">
        <button
          type="button"
          className="zx-ocr-button"
          aria-label={`OCR 识别 ${fileName}`}
          disabled={disabled}
          title={
            !settings.enabled
              ? '图片 OCR 默认关闭；请先在设置 → 知识库与 OCR 开启'
              : scopeHint ?? '使用设置页当前选择的引擎识别这张图片'
          }
          onClick={() => void handleRecognize()}
        >
          {recognizing ? '识别中…' : '识别图片文字'}
        </button>
        <small>{storageHint}</small>
      </div>

      {!settings.enabled ? (
        <p className="zx-ocr-entry-hint" role="status">
          图片 OCR 默认关闭；在 设置 → 知识库与 OCR 开启并选择可用引擎后，这里会自动可用。
        </p>
      ) : scopeHint ? (
        <p className="zx-ocr-entry-hint" role="status">
          {scopeHint}
        </p>
      ) : null}

      {error ? (
        <p className="zx-ocr-error" role="alert">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="zx-ocr-entry-result" aria-label={`OCR 识别结果：${fileName}`}>
          <b>识别结果</b>
          {result.text.trim() ? (
            <pre>{result.text}</pre>
          ) : (
            <p>引擎返回空文本：这张图片没有识别到文字（不是模拟结果）。</p>
          )}
          <small>
            {result.textStorage === 'local'
              ? '结果来自当前引擎；文本只保存在本机。'
              : `结果来自当前引擎；${textSyncStateLabel(result.textSyncState)}。`}
          </small>
          {result.textSyncState === 'failed' && result.textSyncError ? (
            <small>{result.textSyncError}</small>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
