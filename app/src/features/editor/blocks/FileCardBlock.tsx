import { useEffect, useId, useRef, useState } from 'react';

import type { EditorBlock } from '../../../data/repositories/blocks';
import type {
  AttachmentDisplayState,
} from '../../attachments/types';
import { blockFile } from '../types';
import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu';

/**
 * 文件卡本机状态由编辑器按 `attachmentId` 查询附件管理器后传入：
 * - `local`：本机 Blob 存在，可打开/下载；
 * - `missing`：有附件引用但本机没有内容，必须重新选择或从远端下载；
 * - `remote`：只有远端记录，可显式下载；
 * - `unavailable`：附件服务没装配，不能假装文件可用。
 */
export type FileCardLocalState =
  | 'checking'
  | 'local'
  | 'missing'
  | 'remote'
  | 'unavailable'
  | 'none';

type FileCardBlockProps = {
  block: EditorBlock;
  readOnly: boolean;
  onChangeName: (name: string) => void;
  /** 失焦时把 name 同步回同一条附件元数据。 */
  onCommitName?: (name: string) => void;
  localState?: FileCardLocalState;
  /** 附件管理器按同步模式算出的展示状态；只影响文案，不改变打开能力。 */
  syncState?: AttachmentDisplayState | null;
  /** 管理器给出的最近错误，例如哈希不一致或附件记录已删除。 */
  localError?: string | null;
  /** 有 uploader 时才允许从服务器下载缺失内容。 */
  onRemoteDownload?: () => void | Promise<void>;
  onOpen?: () => void | Promise<void>;
  onDownload?: () => void | Promise<void>;
  onRemove?: () => void;
  onReselect?: () => void;
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
  svg: 'IMG',
  zip: 'ZIP',
  rar: 'ZIP',
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${
    units[unit]
  }`;
}

export function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

/**
 * 文件行状态文案。`local` 只说明二进制在本机；同步文案由附件管理器按
 * 当前模式算出的 `syncState` 决定，不用 payload 快照猜“待上传”。
 */
function statusText(
  state: FileCardLocalState,
  syncState?: AttachmentDisplayState | null,
): string {
  switch (state) {
    case 'local':
      switch (syncState) {
        case 'local_only':
          return '本机已保存';
        case 'local_saved':
          return '本机已保存 · 未同步';
        case 'pending_sync':
          return '待同步';
        case 'syncing':
          return '同步中';
        case 'synced':
          return '已同步';
        case 'sync_failed':
          return '同步失败 · 本机保留';
        case 'service_unavailable':
          return '本机已保存 · 服务不可用';
        case 'local_error':
          return '本机文件异常';
        default:
          return '本机已保存';
      }
    case 'checking':
      return '正在检查本机文件…';
    case 'missing':
      return '文件缺失';
    case 'remote':
      return '远端可用 · 需下载';
    case 'unavailable':
      return '附件服务不可用';
    case 'none':
      return '仅文件信息';
  }
}

/** 长说明放到 badge 的 title 与读屏文本里，避免把文件行撑成卡片。 */
function stateHint(state: FileCardLocalState): string | null {
  switch (state) {
    case 'local':
      return null;
    case 'checking':
      return '正在读取附件管理器，确认本机是否有这个文件。';
    case 'missing':
      return '本机没有这个文件本体，请重新选择原文件；如果已上传过，也可以从服务器下载。';
    case 'remote':
      return '文件只存在远端；下载到本机后才能交给系统默认应用打开。';
    case 'unavailable':
      return '附件服务不可用；当前不会伪装成可打开，也不会发起下载。';
    case 'none':
      return '这条旧文件卡只有文件名，尚未关联附件记录。';
  }
}

export function FileCardBlock({
  block,
  readOnly,
  onChangeName,
  onCommitName,
  localState,
  syncState,
  localError,
  onRemoteDownload,
  onOpen,
  onDownload,
  onRemove,
  onReselect,
}: FileCardBlockProps) {
  const file = blockFile(block);
  const extension = fileExtension(file.fileName);
  const icon = FILE_ICONS[extension] ?? '⌁';
  const label = file.fileName || '未选择文件';
  const resolvedState: FileCardLocalState =
    localState ??
    (file.attachmentId
      ? 'checking'
      : file.status === 'missing'
        ? 'missing'
        : 'none');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(file.fileName);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLButtonElement>(null);
  const editFinishedRef = useRef(false);
  const editCancelledRef = useRef(false);
  const restoreFocusRef = useRef(false);
  const hintId = useId();

  const hint = stateHint(resolvedState);
  /** 管理器错误并进 badge 的 title/读屏说明，默认不在行内再占一行。 */
  const description =
    [hint, localError].filter((part): part is string => Boolean(part)).join(' ') ||
    null;
  const isMissing = resolvedState === 'missing';
  const hasLocal = resolvedState === 'local';
  const showOpen = hasLocal && Boolean(onOpen);
  const canReselect =
    !readOnly &&
    Boolean(onReselect) &&
    (resolvedState === 'missing' || resolvedState === 'none');
  const showRemoteDownload =
    !readOnly &&
    Boolean(onRemoteDownload) &&
    (resolvedState === 'remote' || resolvedState === 'missing');

  useEffect(() => {
    if (!editing) {
      setDraftName(file.fileName);
    }
  }, [editing, file.fileName]);

  useEffect(() => {
    if (editing) {
      const input = inputRef.current;
      input?.focus();
      input?.select();
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      nameRef.current?.focus();
    }
  }, [editing]);

  const run = (action?: () => void | Promise<void>) => {
    if (!action || busy) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const result = action();
      if (result && typeof result.then === 'function') {
        void result
          .catch((reason: unknown) => {
            setActionError(
              reason instanceof Error ? reason.message : '文件操作失败',
            );
          })
          .finally(() => setBusy(false));
      } else {
        setBusy(false);
      }
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : '文件操作失败');
      setBusy(false);
    }
  };

  const startEditing = () => {
    if (readOnly) {
      return;
    }
    editFinishedRef.current = false;
    editCancelledRef.current = false;
    setDraftName(file.fileName);
    setEditing(true);
  };

  const commitName = (restoreFocus: boolean) => {
    if (editFinishedRef.current) {
      return;
    }
    editFinishedRef.current = true;
    const next = draftName.trim();
    setEditing(false);
    restoreFocusRef.current = restoreFocus;
    if (!next || next === file.fileName) {
      setDraftName(file.fileName);
      return;
    }
    onChangeName(next);
    onCommitName?.(next);
  };

  const cancelName = () => {
    editFinishedRef.current = true;
    editCancelledRef.current = true;
    setDraftName(file.fileName);
    setEditing(false);
    restoreFocusRef.current = true;
  };

  const items: OverflowMenuItem[] = [];
  if (showOpen && onOpen) {
    items.push({
      id: 'open',
      label: '打开',
      disabled: busy,
      onSelect: () => run(onOpen),
    });
  }
  if (hasLocal && onDownload) {
    items.push({
      id: 'download',
      label: '另存为…',
      disabled: busy,
      onSelect: () => run(onDownload),
    });
  }
  if (showRemoteDownload && onRemoteDownload) {
    items.push({
      id: 'remote-download',
      label: '从服务器下载',
      disabled: busy,
      onSelect: () => run(onRemoteDownload),
    });
  }
  if (canReselect && onReselect) {
    items.push({
      id: 'reselect',
      label: file.attachmentId ? '重新选择文件…' : '选择文件…',
      disabled: busy,
      onSelect: () => run(onReselect),
    });
  }
  if (!readOnly) {
    items.push({
      id: 'rename',
      label: '重命名…',
      disabled: busy,
      onSelect: startEditing,
    });
  }
  if (!readOnly && onRemove) {
    items.push({
      id: 'remove',
      label: '删除文件卡',
      disabled: busy,
      onSelect: () => run(onRemove),
    });
  }

  return (
    <div
      className="zxe-filecard zxe-filerow"
      role="group"
      aria-label={`文件卡：${label}`}
      aria-busy={busy || undefined}
      aria-describedby={description ? hintId : undefined}
      data-file-state={resolvedState}
      data-sync-state={syncState ?? undefined}
      data-attachment-id={file.attachmentId ?? undefined}
      data-editing={editing ? 'true' : undefined}
    >
      <span className="zxe-filecard-icon zxe-filerow-icon" aria-hidden="true">
        {icon}
      </span>
      {editing ? (
        <input
          ref={inputRef}
          className="zxe-filecard-name-input zxe-filerow-name-input"
          aria-label="文件名"
          value={draftName}
          placeholder="文件名"
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={() => {
            if (editCancelledRef.current) {
              editCancelledRef.current = false;
              return;
            }
            commitName(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              commitName(true);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              cancelName();
            }
          }}
        />
      ) : readOnly ? (
        <span className="zxe-filecard-name zxe-filerow-name">{label}</span>
      ) : (
        <button
          ref={nameRef}
          type="button"
          className="zxe-filecard-name zxe-filerow-name"
          aria-label={`重命名文件 ${label}：双击或按 F2`}
          title={`${label} · 双击或按 F2 重命名`}
          onDoubleClick={startEditing}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === 'F2') {
              event.preventDefault();
              event.stopPropagation();
              startEditing();
            }
          }}
        >
          {label}
        </button>
      )}
      <span className="zxe-filecard-meta zxe-filerow-meta">
        {extension ? `${extension.toUpperCase()} · ` : ''}
        {formatBytes(file.byteSize)}
      </span>
      <span
        className={`zxe-filecard-state zxe-filerow-state is-${resolvedState}`}
        role={isMissing ? 'alert' : 'status'}
        title={description ?? undefined}
      >
        {statusText(resolvedState, syncState)}
      </span>
      {actionError ? (
        <span
          className="zxe-filecard-error zxe-filerow-error"
          role="alert"
          title={actionError}
        >
          {actionError}
        </span>
      ) : null}
      {items.length > 0 ? (
        <div className="zxe-filecard-side zxe-filerow-actions">
          {showOpen && onOpen ? (
            <button
              type="button"
              className="zxe-filecard-action is-primary"
              aria-label={`打开文件 ${label}`}
              disabled={busy}
              onClick={() => run(onOpen)}
            >
              打开
            </button>
          ) : null}
          <OverflowMenu
            label={`更多文件操作 ${label}`}
            triggerTitle="打开、另存、下载、重命名、重新选择与删除"
            items={items}
          />
        </div>
      ) : null}
      {description ? (
        <span id={hintId} className="zx-visually-hidden">
          {description}
        </span>
      ) : null}
    </div>
  );
}
