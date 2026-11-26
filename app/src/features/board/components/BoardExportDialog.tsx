/**
 * 画板导出 PNG 面板（ZX-EXPORT-02）。
 *
 * - 背景至少三选一：当前主题 / 白底 / 透明；
 * - 1x / 2x 清晰度；默认 2x；
 * - 空画板明确提示，不生成空白图；
 * - 大画板按上限等比缩小并提示，不裁切；
 * - 保存走统一保存面板；有笔记时可直接插入笔记（文件卡，可点击预览）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { BoardDocument } from '../types';
import {
  BOARD_EXPORT_BACKGROUNDS,
  BOARD_EXPORT_DEFAULT_SCALE,
  BOARD_EXPORT_MAX_DIMENSION,
  BoardExportError,
  defaultBoardExportFileName,
  planBoardExport,
  renderBoardPng,
  type BoardExportBackground,
  type BoardExportOptions,
  type BoardExportPlan,
  type RenderedBoardPng,
} from '../export/image';
import type { BoardImageFile } from '../export/noteInsert';
import { saveBoardPngWithDialog } from '../export/save';
import type { SaveResult } from '../../attachments/fileActions';
import { Modal } from './BoardDialogs';

export type BoardExportDialogProps = {
  open: boolean;
  document: BoardDocument | null;
  noteId?: string | null;
  onClose: () => void;
  /** 插入成功/保存成功的轻提示；不传时只在面板内显示。 */
  onStatus?: (message: string) => void;
  /** 有笔记时显示「插入到笔记」；不传则隐藏。 */
  onInsertIntoNote?: (file: BoardImageFile) => Promise<void>;
  /** 测试注入：默认使用真实 Canvas2D 渲染。 */
  renderPng?: (
    document: BoardDocument,
    options: BoardExportOptions,
  ) => Promise<RenderedBoardPng>;
  /** 测试注入：默认走统一保存面板。 */
  savePng?: (blob: Blob, fileName: string) => Promise<SaveResult>;
  now?: () => Date;
};

function describeError(reason: unknown): string {
  if (reason instanceof BoardExportError) {
    return reason.message;
  }
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  return '导出失败，请重试';
}

function basename(path: string | null): string | null {
  if (!path) {
    return null;
  }
  return path.split(/[\\/]/).pop() ?? null;
}

export function BoardExportDialog({
  open,
  document,
  noteId,
  onClose,
  onStatus,
  onInsertIntoNote,
  renderPng = renderBoardPng,
  savePng = saveBoardPngWithDialog,
  now,
}: BoardExportDialogProps) {
  const [background, setBackground] = useState<BoardExportBackground>('theme');
  const [scale, setScale] = useState(BOARD_EXPORT_DEFAULT_SCALE);
  const [busy, setBusy] = useState<'save' | 'insert' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setBusy(null);
      setMessage(null);
      setError(null);
    }
  }, [open]);

  const planResult = useMemo<{
    plan: BoardExportPlan | null;
    error: string | null;
    empty: boolean;
  }>(() => {
    if (!document) {
      return {
        plan: null,
        error: '没有可导出的画板内容。',
        empty: true,
      };
    }
    try {
      return {
        plan: planBoardExport(document, { background, scale }),
        error: null,
        empty: false,
      };
    } catch (reason) {
      return {
        plan: null,
        error: describeError(reason),
        empty:
          reason instanceof BoardExportError && reason.code === 'empty'
            ? true
            : document.nodes.length === 0,
      };
    }
  }, [background, document, scale]);

  const { plan, error: planError, empty } = planResult;
  const canExport = Boolean(document && plan) && busy === null;
  const canInsert =
    canExport && Boolean(noteId) && typeof onInsertIntoNote === 'function';

  const fileName = useMemo(
    () => defaultBoardExportFileName(document?.title ?? '画板', now?.()),
    [document?.title, now],
  );

  const exportBlob = async (): Promise<Blob> => {
    if (!document || !plan) {
      throw new BoardExportError(
        planError ?? '当前画板不能导出。',
        empty ? 'empty' : 'unavailable',
      );
    }
    const rendered = await renderPng(document, { background, scale });
    return rendered.blob;
  };

  const handleSave = async () => {
    if (!canExport) {
      return;
    }
    setBusy('save');
    setError(null);
    setMessage(null);
    try {
      const blob = await exportBlob();
      const result = await savePng(blob, fileName);
      if (result.status === 'canceled') {
        setMessage('已取消保存，未写入任何文件。');
        return;
      }
      const savedName = basename(result.path) ?? fileName;
      const text = `已保存 PNG：${savedName}${
        result.path ? `（${result.path}）` : ''
      }`;
      setMessage(text);
      onStatus?.(text);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  const handleInsert = async () => {
    if (!canInsert || !onInsertIntoNote) {
      return;
    }
    setBusy('insert');
    setError(null);
    setMessage(null);
    try {
      const blob = await exportBlob();
      await onInsertIntoNote({ fileName, blob });
      const text = '已插入当前笔记末尾；回到笔记点击文件卡即可预览这张 PNG。';
      setMessage(text);
      onStatus?.(text);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      title="导出画板 PNG"
      description="按内容边界导出，连线、文字、便签与泳道完整可见；大画板会等比缩小而不是裁切。"
      onClose={onClose}
      wide
      busy={busy !== null}
      initialFocusRef={saveButtonRef}
    >
      <div className="bw-export">
        <fieldset className="bw-export-group">
          <legend>背景</legend>
          <div className="bw-export-options">
            {BOARD_EXPORT_BACKGROUNDS.map((option) => (
              <label
                key={option.value}
                className={
                  background === option.value
                    ? 'bw-export-option is-selected'
                    : 'bw-export-option'
                }
              >
                <input
                  type="radio"
                  name="bw-export-background"
                  value={option.value}
                  checked={background === option.value}
                  onChange={() => setBackground(option.value)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.hint}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="bw-export-group">
          <legend>清晰度</legend>
          <div className="bw-export-options">
            <label
              className={
                scale === 1 ? 'bw-export-option is-selected' : 'bw-export-option'
              }
            >
              <input
                type="radio"
                name="bw-export-scale"
                value="1"
                checked={scale === 1}
                onChange={() => setScale(1)}
              />
              <span>
                <strong>1x 标准</strong>
                <small>文件更小，适合快速分享</small>
              </span>
            </label>
            <label
              className={
                scale === 2 ? 'bw-export-option is-selected' : 'bw-export-option'
              }
            >
              <input
                type="radio"
                name="bw-export-scale"
                value="2"
                checked={scale === 2}
                onChange={() => setScale(2)}
              />
              <span>
                <strong>2x 高清</strong>
                <small>文字与连线更清晰，推荐</small>
              </span>
            </label>
          </div>
        </fieldset>

        {plan ? (
          <dl className="bw-export-summary" aria-label="导出信息">
            <div>
              <dt>输出尺寸</dt>
              <dd>
                {plan.pixelWidth} × {plan.pixelHeight}px
              </dd>
            </div>
            <div>
              <dt>格式</dt>
              <dd>PNG · {plan.background === 'transparent' ? '透明' : '不透明'}</dd>
            </div>
            <div>
              <dt>文件名</dt>
              <dd>{fileName}</dd>
            </div>
          </dl>
        ) : null}

        {empty ? (
          <p className="bw-export-empty" role="alert">
            {planError ?? '空白画板没有可导出的内容。'}
          </p>
        ) : null}

        {planError && !empty ? (
          <p className="bw-export-error" role="alert">
            {planError}
          </p>
        ) : null}

        {plan?.limited ? (
          <p className="bw-export-warning" role="status">
            画板内容较大，已按单边 {BOARD_EXPORT_MAX_DIMENSION}px 与总像素上限
            等比缩小到 {plan.pixelWidth} × {plan.pixelHeight}px；导出不会裁切内容。
          </p>
        ) : null}

        {error ? (
          <p className="bw-export-error" role="alert">
            {error}
          </p>
        ) : null}

        {message ? (
          <p className="bw-export-message" role="status">
            {message}
          </p>
        ) : null}

        <div className="bw-modal-actions bw-modal-actions-split">
          <button
            type="button"
            className="bw-button"
            disabled={busy !== null}
            onClick={onClose}
          >
            取消
          </button>
          <div className="bw-modal-actions">
            {noteId && onInsertIntoNote ? (
              <button
                type="button"
                className="bw-button"
                disabled={!canInsert}
                onClick={() => void handleInsert()}
              >
                {busy === 'insert' ? '正在插入…' : '插入到笔记'}
              </button>
            ) : null}
            <button
              ref={saveButtonRef}
              type="button"
              className="bw-button is-primary"
              disabled={!canExport}
              onClick={() => void handleSave()}
            >
              {busy === 'save' ? '正在导出…' : '保存 PNG'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
