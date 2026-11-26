/**
 * 附件面板：插入即本机已保存 → local 模式不上传 → 同步模式由用户显式上传/下载。
 *
 * 面板本身不读取正文，只按归属管理附件元数据：
 * - 笔记：`noteId`；
 * - 任务：`taskId`（落库为 `block_id="task:<id>"`）。
 * 编辑器可在文件块中引用 `attachmentId`，移块不会复制文件本体。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createDefaultOcrService } from '../ocr/runtime';
import type { OcrService } from '../ocr/service';
import type { AttachmentManager } from './manager';
import type { AttachmentUploader } from './uploader';
import { AttachmentCard } from './AttachmentCard';
import { objectUrlFor, revokeObjectUrl } from './blobStore';
import {
  describeSaveResult,
  openAttachmentLocally,
  saveLocalAttachment,
} from './fileActions';
import {
  isImageAttachment,
  type AttachmentProgress,
  type AttachmentSyncMode,
  type StoredAttachment,
} from './types';

export type AttachmentPanelProps = {
  manager: AttachmentManager;
  noteId?: string | null;
  /** 任务详情附件；与 noteId 同时存在时以 taskId 为准。 */
  taskId?: string | null;
  uploader?: AttachmentUploader;
  /** 当前设备同步模式；未传时按“有 uploader 即 backend”推断，兼容注入场景。 */
  syncMode?: AttachmentSyncMode;
  title?: string;
  /** 文件选择按钮文案；避免与页面里“插入正文文件卡”重名。 */
  insertLabel?: string;
  accept?: string;
  /** manager 可用但没有 uploader 时的原因，会以可见提示展示。 */
  uploadDisabledReason?: string | null;
  /**
   * 图片 OCR 服务；不传时自动装配默认服务（与设置页共用偏好）。
   * 传 null 可明确关闭该入口（例如只读嵌入/测试）。
   */
  ocrService?: OcrService | null;
  /** 外部写入附件后递增；面板据此重新读取同一条元数据。 */
  refreshToken?: number;
  /**
   * 正文文件块引用的附件 ID。内容寻址下同一附件可能只归属首次插入的笔记，
   * 其他笔记通过 attachmentId 引用同一条记录，这里合并展示，避免复制元数据。
   */
  attachmentIds?: readonly string[];
  onOpen?: (attachment: StoredAttachment, blob: Blob) => void | Promise<void>;
  onNotice?: (message: string) => void;
};

type PreviewState = {
  id: string;
  name: string;
  url: string;
};

function percent(progress: AttachmentProgress | undefined): number | undefined {
  if (!progress || progress.totalBytes <= 0) {
    return progress ? 100 : undefined;
  }
  return Math.round((progress.completedBytes / progress.totalBytes) * 100);
}

export function AttachmentPanel({
  manager,
  noteId = null,
  taskId = null,
  uploader,
  syncMode,
  title = '附件',
  insertLabel = '＋ 插入文件',
  accept,
  uploadDisabledReason,
  ocrService,
  refreshToken = 0,
  attachmentIds,
  onOpen,
  onNotice,
}: AttachmentPanelProps) {
  /**
   * 兼容测试/嵌入：注入 uploader 但没传模式时，视为 backend。
   * 正式运行时由 AttachmentSection 传入真实模式，local 模式 uploader 为 null。
   */
  const effectiveMode: AttachmentSyncMode =
    syncMode ?? (uploader ? 'backend' : 'local');
  const serviceAvailable = Boolean(uploader);
  const [items, setItems] = useState<StoredAttachment[]>([]);
  const [localIds, setLocalIds] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [progress, setProgress] = useState<Record<string, AttachmentProgress>>(
    {},
  );
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const defaultOcrService = useMemo(() => createDefaultOcrService(), []);
  const activeOcrService = ocrService === undefined ? defaultOcrService : ocrService;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!preview) {
      return;
    }
    return () => {
      revokeObjectUrl(preview.url);
    };
  }, [preview]);

  useEffect(() => {
    if (!preview) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreview(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [preview]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const listed = taskId
        ? await manager.listForTask(taskId)
        : await manager.list(noteId);
      const known = new Set(listed.map((item) => item.metadata.id));
      const extra = await Promise.all(
        (attachmentIds ?? [])
          .filter((id) => id && !known.has(id))
          .map(async (id) => {
            try {
              return await manager.get(id);
            } catch {
              return null;
            }
          }),
      );
      const next = [
        ...listed,
        ...extra.filter((item): item is StoredAttachment => item !== null),
      ].sort((a, b) => {
        if (a.metadata.createdAt !== b.metadata.createdAt) {
          return a.metadata.createdAt < b.metadata.createdAt ? -1 : 1;
        }
        return a.metadata.id.localeCompare(b.metadata.id);
      });
      const local = await Promise.all(
        next.map(
          async (item) =>
            [item.metadata.id, await manager.hasLocalBlob(item.metadata.id)] as const,
        ),
      );
      if (alive.current) {
        setItems(next);
        setLocalIds(Object.fromEntries(local));
        setError(null);
      }
    } catch (reason) {
      if (alive.current) {
        setError(reason instanceof Error ? reason.message : '读取附件失败');
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [attachmentIds, manager, noteId, taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  const setBusy = (id: string, busy: boolean) => {
    setBusyIds((current) =>
      busy ? Array.from(new Set([...current, id])) : current.filter((x) => x !== id),
    );
  };

  const handleFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList).slice(0, 20);
      setIngesting(true);
      setError(null);
      try {
        let count = 0;
        for (const file of files) {
          await manager.ingest(file, {
            noteId: taskId ? null : noteId,
            taskId,
            onProgress: (item) => {
              if (!item.attachmentId) {
                setProgress((current) => ({
                  ...current,
                  __ingest__: item,
                }));
              }
            },
          });
          count += 1;
        }
        if (alive.current) {
          const notice =
            effectiveMode === 'local'
              ? `${count} 个文件已保存到本机（仅本机，不会上传）。`
              : serviceAvailable
                ? `${count} 个文件已保存到本机；需要同步时再点「上传」。`
                : `${count} 个文件已保存到本机；同步服务当前不可用，文件不受影响。`;
          onNotice?.(notice);
          setProgress((current) => {
            const next = { ...current };
            delete next.__ingest__;
            return next;
          });
        }
        await refresh();
      } catch (reason) {
        if (alive.current) {
          setError(reason instanceof Error ? reason.message : '插入附件失败');
        }
      } finally {
        if (alive.current) setIngesting(false);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [effectiveMode, manager, noteId, onNotice, refresh, serviceAvailable, taskId],
  );

  const handleUpload = useCallback(
    async (attachment: StoredAttachment, allowRemote: boolean) => {
      if (!uploader) return;
      setBusy(attachment.metadata.id, true);
      setError(null);
      // 先写“待同步”再交给 uploader：只有用户明确点上传，才进入队列。
      try {
        await manager.markPending(attachment.metadata.id);
      } catch {
        // 状态写入失败不阻断上传；uploader 会按真实结果重新写状态。
      }
      // 先给 0% 进度，让用户立刻看到“上传中”，而不是只看到按钮变灰。
      setProgress((current) => ({
        ...current,
        [attachment.metadata.id]: {
          attachmentId: attachment.metadata.id,
          phase: 'uploading',
          completedBytes: 0,
          totalBytes: attachment.metadata.byteSize,
        },
      }));
      try {
        await uploader.upload(attachment.metadata.id, {
          allowRemote,
          onProgress: (item) => {
            setProgress((current) => ({
              ...current,
              [attachment.metadata.id]: item,
            }));
          },
        });
        if (alive.current) {
          onNotice?.(`「${attachment.metadata.fileName}」已同步，服务端哈希校验通过。`);
        }
        await refresh();
      } catch (reason) {
        // uploader 已把状态写成 failed；刷新列表让“失败，可重试”立刻可见。
        // 先刷新再写错误，避免 refresh 成功时把面板级错误清空。
        await refresh();
        if (alive.current) {
          setError(reason instanceof Error ? reason.message : '上传失败');
        }
      } finally {
        if (alive.current) {
          setBusy(attachment.metadata.id, false);
          setProgress((current) => {
            const next = { ...current };
            delete next[attachment.metadata.id];
            return next;
          });
        }
      }
    },
    [onNotice, refresh, uploader],
  );

  const handleDownload = useCallback(
    async (attachment: StoredAttachment) => {
      if (!uploader) return;
      setBusy(attachment.metadata.id, true);
      setError(null);
      setProgress((current) => ({
        ...current,
        [attachment.metadata.id]: {
          attachmentId: attachment.metadata.id,
          phase: 'downloading',
          completedBytes: 0,
          totalBytes: attachment.metadata.byteSize,
        },
      }));
      try {
        await uploader.download(attachment.metadata.id, {
          onProgress: (item) => {
            setProgress((current) => ({
              ...current,
              [attachment.metadata.id]: item,
            }));
          },
        });
        if (alive.current) {
          onNotice?.(`「${attachment.metadata.fileName}」已下载并校验哈希。`);
        }
        await refresh();
      } catch (reason) {
        await refresh();
        if (alive.current) {
          setError(reason instanceof Error ? reason.message : '下载失败');
        }
      } finally {
        if (alive.current) {
          setBusy(attachment.metadata.id, false);
          setProgress((current) => {
            const next = { ...current };
            delete next[attachment.metadata.id];
            return next;
          });
        }
      }
    },
    [onNotice, refresh, uploader],
  );

  const handleOpen = useCallback(
    async (attachment: StoredAttachment) => {
      try {
        // 嵌入方显式提供 onOpen 时保留其自定义打开行为（测试/只读嵌入）；
        // 否则统一走附件文件动作：图片应用内预览，其他格式交系统默认应用。
        if (onOpen) {
          const { blob } = await manager.open(attachment.metadata.id);
          await onOpen(attachment, blob);
          return;
        }
        const opened = await openAttachmentLocally(
          manager,
          attachment.metadata.id,
        );
        if (opened.kind === 'image') {
          const url = objectUrlFor(opened.blob);
          if (!url) {
            throw new Error('当前环境无法生成图片预览地址');
          }
          setPreview({
            id: attachment.metadata.id,
            name: opened.metadata.fileName,
            url,
          });
          return;
        }
        onNotice?.(
          opened.path
            ? `已用系统默认应用打开「${opened.metadata.fileName}」（缓存：${opened.path}）`
            : `已用系统默认应用打开「${opened.metadata.fileName}」`,
        );
      } catch (reason) {
        // 哈希不一致时 open() 会把状态写成 failed；刷新让卡片显示失败态，
        // 再把错误写回面板（refresh 成功会清空旧错误）。
        await refresh();
        if (alive.current) {
          setError(
            reason instanceof Error ? reason.message : '打开附件失败',
          );
        }
      }
    },
    [manager, onNotice, onOpen, refresh],
  );

  const handleSaveLocal = useCallback(
    async (attachment: StoredAttachment) => {
      try {
        const { result, metadata } = await saveLocalAttachment(
          manager,
          attachment.metadata.id,
        );
        onNotice?.(describeSaveResult(result, metadata.fileName));
      } catch (reason) {
        await refresh();
        if (alive.current) {
          setError(
            reason instanceof Error ? reason.message : '另存本机附件失败',
          );
        }
      }
    },
    [manager, onNotice, refresh],
  );

  const handleRemove = useCallback(
    async (attachment: StoredAttachment) => {
      setBusy(attachment.metadata.id, true);
      try {
        await manager.remove(attachment.metadata.id);
        setPreview((current) =>
          current?.id === attachment.metadata.id ? null : current,
        );
        await refresh();
      } catch (reason) {
        await refresh();
        if (alive.current) {
          setError(reason instanceof Error ? reason.message : '删除附件失败');
        }
      } finally {
        if (alive.current) setBusy(attachment.metadata.id, false);
      }
    },
    [manager, refresh],
  );

  const imageCount = items.filter((item) =>
    isImageAttachment(item.metadata),
  ).length;

  return (
    <section className="zx-attach-panel" aria-label={title}>
      <header className="zx-attach-head">
        <div>
          <h3>{title}</h3>
          <p>
            {items.length} 个附件
            {imageCount > 0 ? ` · ${imageCount} 张图片默认仅本机` : ''}
          </p>
        </div>
        <button
          type="button"
          className="zx-attach-button is-primary"
          disabled={ingesting}
          onClick={() => inputRef.current?.click()}
        >
          {ingesting ? '保存中…' : insertLabel}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={accept}
          className="zx-attach-file-input"
          aria-label="选择附件文件"
          onChange={(event) => void handleFiles(event.target.files)}
        />
      </header>

      {effectiveMode === 'local' ? (
        <p className="zx-attach-notice" role="status">
          <b>当前为本地模式：</b>
          附件只保存在这台设备，可打开、另存和删除，不需要上传。
        </p>
      ) : !uploader ? (
        <p className="zx-attach-notice" role="status">
          <b>
            {effectiveMode === 'webdav'
              ? 'WebDAV 附件同步尚未启用：'
              : '同步服务不可用：'}
          </b>
          {uploadDisabledReason ??
            '文件仍保存在本机，可打开、另存和删除；连接同步服务后可重试上传。'}
        </p>
      ) : null}

      {serviceAvailable && effectiveMode !== 'local' && imageCount > 0 ? (
        <label className="zx-attach-consent">
          <input
            type="checkbox"
            checked={allowRemoteImages}
            onChange={(event) => setAllowRemoteImages(event.target.checked)}
          />
          <span>
            允许把图片上传到当前同步服务器（默认关闭；开启前请确认图片内容）
          </span>
        </label>
      ) : null}

      {error ? (
        <p className="zx-attach-error" role="alert">
          {error}
        </p>
      ) : null}

      {progress.__ingest__ ? (
        <p className="zx-attach-hint" role="status">
          正在计算 SHA-256… {percent(progress.__ingest__) ?? 0}%
        </p>
      ) : null}

      {loading ? (
        <p className="zx-attach-empty" role="status">
          正在读取本机附件…
        </p>
      ) : items.length === 0 ? (
        <p className="zx-attach-empty">
          还没有附件。插入的文件会先保存到本机，可在本机打开和另存。
        </p>
      ) : (
        <div className="zx-attach-list">
          {items.map((item) => (
            <AttachmentCard
              key={item.metadata.id}
              attachment={item}
              hasLocal={localIds[item.metadata.id] ?? false}
              syncMode={effectiveMode}
              serviceAvailable={serviceAvailable}
              allowRemoteImages={allowRemoteImages}
              busy={busyIds.includes(item.metadata.id)}
              progress={percent(progress[item.metadata.id])}
              onOpen={handleOpen}
              onSaveLocal={handleSaveLocal}
              onUpload={
                uploader
                  ? (attachment, allowRemote) =>
                      void handleUpload(attachment, allowRemote)
                  : undefined
              }
              onDownload={
                uploader
                  ? (attachment) => void handleDownload(attachment)
                  : undefined
              }
              onRemove={(attachment) => void handleRemove(attachment)}
              onError={setError}
              ocrService={activeOcrService}
              ocrGetImage={
                activeOcrService
                  ? async () => {
                      try {
                        const { blob } = await manager.open(item.metadata.id);
                        return blob;
                      } catch {
                        return null;
                      }
                    }
                  : undefined
              }
              onOcrNotice={onNotice}
            />
          ))}
        </div>
      )}

      {preview ? (
        <div
          className="zx-attach-preview"
          role="dialog"
          aria-modal="true"
          aria-label={`预览附件 ${preview.name}`}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setPreview(null);
            }
          }}
        >
          <div className="zx-attach-preview-card">
            <header className="zx-attach-preview-head">
              <strong>{preview.name}</strong>
              <button
                type="button"
                className="zx-attach-button"
                aria-label="关闭附件预览"
                onClick={() => setPreview(null)}
              >
                ×
              </button>
            </header>
            <img src={preview.url} alt={preview.name} />
            <p className="zx-attach-hint">
              预览来自本机 Blob；不会上传或写入 localStorage。
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
