import { useEffect, useRef, useState } from 'react';

import type { EditorBlock } from '../../../data/repositories/blocks';
import { LinkCardDialog, type LinkNoteOption } from '../LinkDialog';
import { copyLinkText, openExternalLink } from '../linkActions';
import { parseLinkInput } from '../security';
import { blockLink } from '../types';

type LinkBlockProps = {
  block: EditorBlock;
  readOnly: boolean;
  /** 未删除的笔记；用于把内链解析成目标标题并判断失效。 */
  noteOptions?: readonly LinkNoteOption[];
  /** 打开站内笔记；由知识页负责保留来源标签，形成返回路径。 */
  onOpenNote?: (noteId: string) => void;
  onChange: (patch: { url?: string; title?: string }) => void;
};

type Notice = { tone: 'error' | 'info'; message: string };

/** 同一空链接块对象只自动弹一次编辑，取消后不再打扰。 */
const autoEditPrompted = new WeakSet<EditorBlock>();

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function LinkBlock({
  block,
  readOnly,
  noteOptions,
  onOpenNote,
  onChange,
}: LinkBlockProps) {
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const autoOpenedRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditingRef = useRef(false);
  const link = blockLink(block);
  const parsed = parseLinkInput(link.url);
  const internalId = parsed.kind === 'note' ? parsed.id : null;
  const selfLink = Boolean(internalId && internalId === block.noteId);
  const targetNote = internalId
    ? noteOptions?.find((note) => note.id === internalId)
    : undefined;
  const internalMissing =
    Boolean(internalId) &&
    noteOptions !== undefined &&
    !selfLink &&
    !targetNote;
  const invalid = parsed.kind === 'invalid' || internalMissing;
  const hasInput = link.url.trim().length > 0;
  const invalidWithInput = parsed.kind === 'invalid' && hasInput;

  const alias = normalizeText(link.title);
  const targetTitle = targetNote ? normalizeText(targetNote.title) : '';
  const title =
    alias ||
    (parsed.kind === 'note'
      ? selfLink
        ? '当前笔记'
        : targetTitle || (internalMissing ? '笔记不存在' : '站内笔记')
      : parsed.kind === 'external'
        ? parsed.host
        : link.url.trim() || '未填写链接');
  const meta =
    parsed.kind === 'note'
      ? internalMissing
        ? '笔记不存在或已删除'
        : alias && targetTitle && alias !== targetTitle
          ? `站内笔记 · ${targetTitle}`
          : '站内笔记'
      : parsed.kind === 'external'
        ? parsed.host
        : link.url.trim() || parsed.reason;
  const errorText =
    parsed.kind === 'invalid'
      ? link.url.trim()
        ? `${link.url.trim()} · ${parsed.reason}`
        : parsed.reason
      : internalMissing
        ? '笔记不存在或已删除'
        : null;

  const clearNoticeTimer = () => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
  };

  const announce = (tone: Notice['tone'], message: string) => {
    clearNoticeTimer();
    setNotice({ tone, message });
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, 4200);
  };

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
    },
    [],
  );

  // 弹层关闭后把焦点还给显式编辑按钮，避免键盘用户丢失位置。
  useEffect(() => {
    if (wasEditingRef.current && !editing) {
      editButtonRef.current?.focus();
    }
    wasEditingRef.current = editing;
  }, [editing]);

  useEffect(() => {
    if (readOnly || autoOpenedRef.current) {
      return;
    }
    if (link.url.trim() || link.title.trim()) {
      return;
    }
    if (autoEditPrompted.has(block)) {
      return;
    }
    autoOpenedRef.current = true;
    autoEditPrompted.add(block);
    setEditing(true);
  }, [block, link.title, link.url, readOnly]);

  /** 内链打开：点击时重新校验目标，避免渲染后目标被删除仍然导航。 */
  const openInternal = () => {
    if (!internalId) {
      announce('error', '站内链接无效');
      return;
    }
    if (
      !selfLink &&
      noteOptions !== undefined &&
      !noteOptions.some((note) => note.id === internalId)
    ) {
      announce('error', '笔记不存在或已删除');
      return;
    }
    if (!onOpenNote) {
      announce('error', '当前环境无法打开站内笔记');
      return;
    }
    setNotice(null);
    onOpenNote(internalId);
  };

  /** 外链打开：点击时重新解析，统一交给系统浏览器/邮件客户端。 */
  const openExternal = () => {
    const fresh = parseLinkInput(link.url);
    if (fresh.kind === 'note') {
      announce('error', '站内笔记链接只能在应用内打开');
      return;
    }
    if (fresh.kind === 'invalid') {
      announce('error', fresh.reason);
      return;
    }
    setNotice(null);
    void openExternalLink(fresh.url).catch((reason: unknown) => {
      announce(
        'error',
        reason instanceof Error && reason.message
          ? reason.message
          : '无法打开链接，请复制链接到浏览器打开',
      );
    });
  };

  const copyCurrent = () => {
    const value = link.url.trim();
    if (!value) {
      announce('error', '没有可复制的链接地址');
      return;
    }
    void copyLinkText(value).then((ok) => {
      announce(
        ok ? 'info' : 'error',
        ok ? '已复制链接' : '复制失败，请手动选择链接文本',
      );
    });
  };

  const invalidTitleMessage = errorText ?? '链接无效';

  return (
    <div
      className="zxe-linkblock"
      role="group"
      aria-label="链接块"
      data-kind={
        parsed.kind === 'note'
          ? 'note'
          : parsed.kind === 'external'
            ? 'external'
            : 'invalid'
      }
      data-invalid={invalid ? 'true' : 'false'}
    >
      <span className="zxe-linkblock-icon" aria-hidden="true">
        {parsed.kind === 'note' ? '⌁' : '↗'}
      </span>
      <div className="zxe-linkblock-main">
        {parsed.kind === 'note' && !internalMissing ? (
          <button
            type="button"
            className="zxe-linkblock-title"
            title={`打开笔记：${title}`}
            onClick={openInternal}
          >
            {title}
          </button>
        ) : parsed.kind === 'external' ? (
          <button
            type="button"
            className="zxe-linkblock-title"
            title={`打开链接：${title}`}
            onClick={openExternal}
          >
            {title}
          </button>
        ) : (
          <button
            type="button"
            className="zxe-linkblock-title is-invalid"
            title={invalidTitleMessage}
            onClick={() => announce('error', invalidTitleMessage)}
          >
            {title}
          </button>
        )}
        <span
          className="zxe-linkblock-meta"
          role={invalidWithInput || internalMissing ? 'alert' : undefined}
          title={errorText ?? meta}
        >
          {errorText ?? meta}
        </span>
      </div>
      <div className="zxe-linkblock-actions">
        {readOnly ? null : (
          <button
            ref={editButtonRef}
            type="button"
            className={`zxe-linkblock-action${invalid ? ' is-text' : ''}`}
            aria-label={invalid ? '修复链接' : '编辑链接'}
            title={invalid ? '修复链接' : '编辑链接'}
            onClick={() => {
              setNotice(null);
              setEditing(true);
            }}
          >
            {invalid ? '修复' : '✎'}
          </button>
        )}
        {invalid && hasInput ? (
          <button
            type="button"
            className="zxe-linkblock-action"
            aria-label="复制链接"
            title="复制链接地址（可粘贴到浏览器修复）"
            onClick={copyCurrent}
          >
            ⧉
          </button>
        ) : null}
        {parsed.kind === 'note' && !internalMissing ? (
          <button
            type="button"
            className="zxe-linkblock-action"
            aria-label={`打开笔记：${title}`}
            title="打开笔记（来源标签保留，可返回）"
            onClick={openInternal}
          >
            ↗
          </button>
        ) : parsed.kind === 'external' ? (
          <button
            type="button"
            className="zxe-linkblock-action"
            aria-label={`打开链接：${title}`}
            title="用系统浏览器打开"
            onClick={openExternal}
          >
            ↗
          </button>
        ) : null}
      </div>

      {notice ? (
        <p
          className={`zxe-linkblock-notice is-${notice.tone}`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          {notice.message}
          {notice.tone === 'error' && hasInput ? (
            <button type="button" onClick={copyCurrent}>
              复制链接
            </button>
          ) : null}
        </p>
      ) : null}

      {editing ? (
        <LinkCardDialog
          initialUrl={link.url}
          initialTitle={link.title}
          notes={noteOptions}
          currentNoteId={block.noteId}
          onApply={(next) => {
            setNotice(null);
            onChange({ url: next.url, title: next.title });
            setEditing(false);
          }}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}
