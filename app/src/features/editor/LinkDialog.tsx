import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { copyLinkText } from './linkActions';
import { internalNoteUrl, parseLinkInput } from './security';
import {
  QUOTE_SOURCE_MAX_LENGTH,
  checkQuoteMeta,
  type QuoteMeta,
} from './types';

export type LinkNoteOption = {
  id: string;
  title: string;
};

type LinkDialogProps = {
  initialUrl?: string;
  /** 可插入的站内笔记；不传时只保留「网页链接」和粘贴内链两条路径。 */
  notes?: readonly LinkNoteOption[];
  onApply: (url: string) => void;
  onClose: () => void;
};

type LinkMode = 'web' | 'note';

/**
 * 插入链接弹层（N-16）。
 *
 * 两种类型：
 * - 网页链接：http / https / mailto，也接受直接粘贴的 `zhixing://note/<id>`；
 * - 笔记内链：按标题搜索本机笔记，选中后写入规范的 `zhixing://note/<id>`。
 *
 * 应用前一律经过 `sanitizeLinkUrl`，未知协议/非法 id 不会离开弹层。
 */
export function LinkDialog({
  initialUrl = '',
  notes = [],
  onApply,
  onClose,
}: LinkDialogProps) {
  const [mode, setMode] = useState<LinkMode>('web');
  const [value, setValue] = useState(initialUrl);
  const [noteQuery, setNoteQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const noteSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const filteredNotes = useMemo(() => {
    const needle = noteQuery.trim().toLocaleLowerCase('zh-Hans-CN');
    const source = needle
      ? notes.filter((note) =>
          note.title.toLocaleLowerCase('zh-Hans-CN').includes(needle),
        )
      : notes;
    return source.slice(0, 50);
  }, [noteQuery, notes]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseLinkInput(value);
    if (parsed.kind === 'invalid') {
      setError(parsed.reason);
      return;
    }
    onApply(parsed.url);
  };

  const applyNote = (note: LinkNoteOption) => {
    const url = internalNoteUrl(note.id);
    if (!url) {
      setError('笔记不存在或已删除');
      return;
    }
    onApply(url);
  };

  const switchMode = (next: LinkMode) => {
    setMode(next);
    setError(null);
    if (next === 'note') {
      window.setTimeout(() => noteSearchRef.current?.focus(), 0);
    } else {
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="zxe-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <form
        className="zxe-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="插入链接"
        onSubmit={submit}
      >
        <h2>插入链接</h2>
        <div className="zxe-dialog-tabs" role="group" aria-label="链接类型">
          <button
            type="button"
            aria-pressed={mode === 'web'}
            className={mode === 'web' ? 'is-active' : undefined}
            onClick={() => switchMode('web')}
          >
            网页链接
          </button>
          <button
            type="button"
            aria-pressed={mode === 'note'}
            className={mode === 'note' ? 'is-active' : undefined}
            onClick={() => switchMode('note')}
          >
            笔记内链
          </button>
        </div>

        {mode === 'web' ? (
          <>
            <p>
              选中文字将变成链接；支持 http / https / mailto，也可以直接粘贴
              zhixing://note/… 内链。
            </p>
            <input
              ref={inputRef}
              aria-label="链接地址"
              value={value}
              placeholder="https://example.com"
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
            />
          </>
        ) : (
          <>
            <p>按标题搜索本机笔记，选中后正文会写入可点击的站内内链。</p>
            <input
              ref={noteSearchRef}
              aria-label="搜索笔记"
              value={noteQuery}
              placeholder="搜索笔记标题"
              onChange={(event) => {
                setNoteQuery(event.target.value);
                setError(null);
              }}
            />
            {filteredNotes.length > 0 ? (
              <div
                className="zxe-link-notes"
                role="listbox"
                aria-label="可插入的笔记"
              >
                {filteredNotes.map((note) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    className="zxe-link-note"
                    key={note.id}
                    onClick={() => applyNote(note)}
                  >
                    {note.title}
                  </button>
                ))}
              </div>
            ) : (
              <p className="zxe-dialog-empty" role="status">
                {notes.length === 0 ? '暂无可链接的笔记' : '没有匹配的笔记'}
              </p>
            )}
          </>
        )}

        {error ? (
          <p className="zxe-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="zxe-dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          {mode === 'web' ? (
            <button type="submit" className="is-primary">
              应用
            </button>
          ) : null}
        </div>
      </form>
    </div>,
    document.body,
  );
}

type LinkCardDialogProps = {
  initialUrl?: string;
  initialTitle?: string;
  /** 可选的站内笔记；不传时只校验 URL 格式，无法判断目标是否存在。 */
  notes?: readonly LinkNoteOption[];
  /** 当前笔记 id；自链接视为有效目标，不误报「已删除」。 */
  currentNoteId?: string;
  onApply: (value: { url: string; title: string }) => void;
  onClose: () => void;
};

/**
 * 链接块编辑弹层（ZX-LINK-01）。
 *
 * 与划词插入链接不同，这里同时编辑卡片标题和地址；内链仍只认
 * `zhixing://note/<id>`，标题留空时由卡片跟随目标笔记标题。
 * 所有地址在离开弹层前统一走 `parseLinkInput`。
 */
export function LinkCardDialog({
  initialUrl = '',
  initialTitle = '',
  notes,
  currentNoteId,
  onApply,
  onClose,
}: LinkCardDialogProps) {
  const [mode, setMode] = useState<LinkMode>('web');
  const [value, setValue] = useState(initialUrl);
  const [title, setTitle] = useState(initialTitle);
  const [noteQuery, setNoteQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const noteSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const parsed = parseLinkInput(value);
  const internalId = parsed.kind === 'note' ? parsed.id : null;
  const targetNote = internalId
    ? notes?.find((note) => note.id === internalId)
    : undefined;
  const selfLink = Boolean(
    internalId && currentNoteId && internalId === currentNoteId,
  );
  const targetMissing =
    Boolean(internalId) &&
    notes !== undefined &&
    !selfLink &&
    !targetNote;
  const targetLabel = targetNote?.title || (selfLink ? '当前笔记' : '');

  const filteredNotes = useMemo(() => {
    const needle = noteQuery.trim().toLocaleLowerCase('zh-Hans-CN');
    const source = (notes ?? []).filter(
      (note) => note.id !== currentNoteId,
    );
    const matched = needle
      ? source.filter((note) =>
          note.title.toLocaleLowerCase('zh-Hans-CN').includes(needle),
        )
      : source;
    return matched.slice(0, 50);
  }, [currentNoteId, noteQuery, notes]);

  const switchMode = (next: LinkMode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    const target = next === 'note' ? noteSearchRef : inputRef;
    window.setTimeout(() => target.current?.focus(), 0);
  };

  const chooseNote = (note: LinkNoteOption) => {
    const url = internalNoteUrl(note.id);
    if (!url) {
      setError('笔记不存在或已删除');
      return;
    }
    setValue(url);
    setMode('web');
    setError(null);
    setNotice(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = parseLinkInput(value);
    if (next.kind === 'invalid') {
      setError(next.reason);
      inputRef.current?.focus();
      return;
    }
    if (
      next.kind === 'note' &&
      notes !== undefined &&
      next.id !== currentNoteId &&
      !notes.some((note) => note.id === next.id)
    ) {
      setError('笔记不存在或已删除');
      inputRef.current?.focus();
      return;
    }
    onApply({ url: next.url, title: title.trim() });
  };

  const copyCurrent = () => {
    if (parsed.kind === 'invalid') {
      return;
    }
    void copyLinkText(parsed.url).then((ok) => {
      setNotice(
        ok
          ? parsed.kind === 'note'
            ? '已复制内链（仅站内可用，跨应用无法跳转）'
            : '已复制链接'
          : '复制失败，请手动选择文本',
      );
    });
  };

  if (typeof document === 'undefined') {
    return null;
  }

  const titlePlaceholder =
    parsed.kind === 'note'
      ? targetLabel
        ? `留空则跟随「${targetLabel}」`
        : '留空则跟随目标笔记标题'
      : parsed.kind === 'external'
        ? '留空则用域名'
        : '链接标题';

  return createPortal(
    <div
      className="zxe-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <form
        className="zxe-dialog zxe-link-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="编辑链接"
        onSubmit={submit}
      >
        <h2>编辑链接</h2>
        <p>
          外链只允许 http / https / mailto；内链格式为
          zhixing://note/&lt;id&gt;。标题留空时自动使用域名或目标笔记标题。
        </p>

        <div className="zxe-dialog-tabs" role="group" aria-label="链接类型">
          <button
            type="button"
            aria-pressed={mode === 'web'}
            className={mode === 'web' ? 'is-active' : undefined}
            onClick={() => switchMode('web')}
          >
            网页链接
          </button>
          <button
            type="button"
            aria-pressed={mode === 'note'}
            className={mode === 'note' ? 'is-active' : undefined}
            onClick={() => switchMode('note')}
          >
            笔记内链
          </button>
        </div>

        <div className="zxe-dialog-field">
          <label htmlFor="zxe-link-title">标题</label>
          <input
            id="zxe-link-title"
            aria-label="链接标题"
            value={title}
            placeholder={titlePlaceholder}
            onChange={(event) => {
              setTitle(event.target.value);
              setError(null);
              setNotice(null);
            }}
          />
        </div>

        {mode === 'web' ? (
          <div className="zxe-dialog-field">
            <label htmlFor="zxe-link-url">地址</label>
            <input
              id="zxe-link-url"
              ref={inputRef}
              aria-label="链接地址"
              value={value}
              placeholder="https://… 或 zhixing://note/…"
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
                setNotice(null);
              }}
            />
            {parsed.kind === 'note' ? (
              <small
                className={
                  targetMissing
                    ? 'zxe-link-target is-invalid'
                    : 'zxe-link-target'
                }
              >
                {targetMissing
                  ? '目标笔记不存在或已删除'
                  : `目标笔记：${targetLabel || internalId}`}
              </small>
            ) : parsed.kind === 'external' ? (
              <small className="zxe-link-target">
                来源：{parsed.host}
              </small>
            ) : value.trim() ? (
              <small className="zxe-link-target is-invalid">
                {parsed.reason}
              </small>
            ) : (
              <small className="zxe-dialog-hint">
                内链仅站内可用，复制到其他应用不会跳转。
              </small>
            )}
          </div>
        ) : (
          <>
            <p>按标题搜索本机笔记，选中后地址会写成规范的站内内链。</p>
            <input
              ref={noteSearchRef}
              aria-label="搜索笔记"
              value={noteQuery}
              placeholder="搜索笔记标题"
              onChange={(event) => {
                setNoteQuery(event.target.value);
                setError(null);
              }}
            />
            {filteredNotes.length > 0 ? (
              <div
                className="zxe-link-notes"
                role="listbox"
                aria-label="可插入的笔记"
              >
                {filteredNotes.map((note) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={note.id === internalId}
                    className="zxe-link-note"
                    key={note.id}
                    onClick={() => chooseNote(note)}
                  >
                    {note.title}
                  </button>
                ))}
              </div>
            ) : (
              <p className="zxe-dialog-empty" role="status">
                {notes === undefined || notes.length === 0
                  ? '暂无可链接的笔记'
                  : '没有匹配的笔记'}
              </p>
            )}
          </>
        )}

        {error ? (
          <p className="zxe-dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="zxe-dialog-hint" role="status">
            {notice}
          </p>
        ) : null}

        <div className="zxe-dialog-actions">
          {parsed.kind === 'note' ? (
            <button type="button" onClick={copyCurrent}>
              复制内链
            </button>
          ) : parsed.kind === 'external' ? (
            <button type="button" onClick={copyCurrent}>
              复制链接
            </button>
          ) : null}
          <span className="zxe-dialog-spacer" />
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="is-primary">
            保存
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export type QuoteSourceDialogProps = {
  initial: QuoteMeta;
  /** 当前笔记之外、未删除的笔记；不传时保留已有 noteId 并跳过存在性校验。 */
  notes?: readonly LinkNoteOption[];
  /** 排除自引用；知识页传入当前笔记 id。 */
  currentNoteId?: string;
  onApply: (meta: QuoteMeta) => void;
  onClose: () => void;
};

/**
 * 引用出处弹层（ZX-NOTE-04）。
 *
 * 三个字段独立：出处、关联笔记、来源链接。保存前统一走 `checkQuoteMeta`，
 * URL 与链接块共用 `sanitizeLinkUrl`，内链只认 `zhixing://note/<合法 id>`。
 * 目标笔记已删除时不报错，保存会清除关联，避免半填状态卡住用户。
 */
export function QuoteSourceDialog({
  initial,
  notes,
  currentNoteId,
  onApply,
  onClose,
}: QuoteSourceDialogProps) {
  const [source, setSource] = useState(initial.source);
  const [noteId, setNoteId] = useState(initial.noteId);
  const [sourceUrl, setSourceUrl] = useState(initial.sourceUrl);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const idPrefix = useId();

  const selectableNotes = useMemo(
    () =>
      notes === undefined
        ? undefined
        : notes.filter((note) => note.id !== currentNoteId),
    [currentNoteId, notes],
  );

  const noteMissing =
    Boolean(noteId) &&
    selectableNotes !== undefined &&
    !selectableNotes.some((note) => note.id === noteId);

  useEffect(() => {
    sourceRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const checked = checkQuoteMeta(
      { source, noteId, sourceUrl },
      selectableNotes,
    );
    if (checked.error) {
      setError(checked.error);
      return;
    }
    onApply(checked.meta);
  };

  if (typeof document === 'undefined') {
    return null;
  }

  const sourceCount = source.trim().length;

  return createPortal(
    <div
      className="zxe-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <form
        className="zxe-dialog zxe-quote-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="编辑引用出处"
        onSubmit={submit}
      >
        <h2>编辑引用出处</h2>
        <p>出处、关联笔记、来源链接可以独立填写，也可以全部留空。</p>

        <div className="zxe-dialog-field">
          <label htmlFor={`${idPrefix}-source`}>
            出处
            <span
              className={
                sourceCount > QUOTE_SOURCE_MAX_LENGTH
                  ? 'zxe-dialog-counter is-over'
                  : 'zxe-dialog-counter'
              }
            >
              {sourceCount}/{QUOTE_SOURCE_MAX_LENGTH}
            </span>
          </label>
          <input
            id={`${idPrefix}-source`}
            ref={sourceRef}
            aria-label="出处"
            value={source}
            placeholder="如：《卡片笔记写作法》第 6 章"
            aria-invalid={sourceCount > QUOTE_SOURCE_MAX_LENGTH || undefined}
            onChange={(event) => {
              setSource(event.target.value);
              setError(null);
            }}
          />
        </div>

        <div className="zxe-dialog-field">
          <label htmlFor={`${idPrefix}-note`}>关联笔记</label>
          <select
            id={`${idPrefix}-note`}
            aria-label="关联笔记"
            value={noteMissing ? '' : noteId}
            onChange={(event) => {
              setNoteId(event.target.value);
              setError(null);
            }}
          >
            <option value="">
              {noteMissing
                ? '关联笔记已删除（保存将清除）'
                : '不关联笔记'}
            </option>
            {(selectableNotes ?? []).map((note) => (
              <option key={note.id} value={note.id}>
                {note.title}
              </option>
            ))}
          </select>
          {notes !== undefined && (selectableNotes?.length ?? 0) === 0 ? (
            <small className="zxe-dialog-hint">暂无可关联的其他笔记</small>
          ) : null}
        </div>

        {noteMissing ? (
          <p className="zxe-dialog-warning" role="status">
            关联笔记已删除；保存后会清除该关联，引用正文不受影响。
          </p>
        ) : null}

        <div className="zxe-dialog-field">
          <label htmlFor={`${idPrefix}-url`}>来源链接</label>
          <input
            id={`${idPrefix}-url`}
            aria-label="来源链接"
            value={sourceUrl}
            placeholder="https://… 或 zhixing://note/…"
            onChange={(event) => {
              setSourceUrl(event.target.value);
              setError(null);
            }}
          />
          <small className="zxe-dialog-hint">
            外链会显示「↗ 来源链接」，站内内链会显示「⌁ 站内来源」。
          </small>
        </div>

        {error ? (
          <p className="zxe-dialog-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="zxe-dialog-actions">
          <button
            type="button"
            className="zxe-dialog-clear"
            onClick={() =>
              onApply({ source: '', noteId: '', sourceUrl: '' })
            }
          >
            清除
          </button>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="is-primary">
            保存
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
