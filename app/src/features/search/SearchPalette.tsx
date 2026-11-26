/**
 * ⌘K 全局搜索面板。
 *
 * 五类结果（任务/笔记/事件/倒数日/习惯）来自本机 SQLite；空查询展示最近笔记，
 * 选择结果后用深链打开原始对象。没有附件、标签、OCR 结果，也没有云端请求。
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { todayISO } from '../../data/calendar/date';
import { isTauriRuntime } from '../../data/db/client';
import { SearchIcon } from '../../app/shell/icons';
import { CommandDialog } from './CommandDialog';
import {
  buildRecentNotes,
  searchDataset,
  type SearchDataset,
  type SearchGroup,
  type SearchHit,
} from './model';
import {
  createSearchSource,
  type SearchSource,
} from './source';
import './search.css';

export type SearchPaletteProps = {
  open: boolean;
  onClose: () => void;
  /** 测试注入；不传时使用本机 SQLite。 */
  source?: SearchSource;
  available?: boolean;
  today?: string;
};

type SearchStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

function formatError(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '搜索失败，请重试';
}

export function SearchPalette({
  open,
  onClose,
  source,
  available,
  today,
}: SearchPaletteProps) {
  const navigate = useNavigate();
  const defaultSource = useMemo(() => createSearchSource(), []);
  const activeSource = source ?? defaultSource;
  const runtimeAvailable = available ?? (source !== undefined || isTauriRuntime());
  const resolvedToday = today ?? todayISO();

  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [dataset, setDataset] = useState<SearchDataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery('');
    setActiveIndex(0);
    setError(null);

    if (!runtimeAvailable) {
      setStatus('unavailable');
      setDataset(null);
      return;
    }

    let cancelled = false;
    setStatus('loading');
    void activeSource
      .load()
      .then((next) => {
        if (cancelled) {
          return;
        }
        setDataset(next);
        setStatus('ready');
      })
      .catch((reason) => {
        if (cancelled) {
          return;
        }
        setDataset(null);
        setError(formatError(reason));
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [open, runtimeAvailable, activeSource, reloadKey]);

  const results = useMemo(
    () =>
      dataset
        ? searchDataset(dataset, query, resolvedToday)
        : { query: '', groups: [], total: 0 },
    [dataset, query, resolvedToday],
  );

  const recentNotes = useMemo(
    () => (dataset ? buildRecentNotes(dataset.notes) : []),
    [dataset],
  );

  const groups: Array<{
    key: string;
    label: string;
    hits: SearchHit[];
  }> = useMemo(() => {
    if (query.trim() === '') {
      return recentNotes.length > 0
        ? [{ key: 'recent', label: '最近笔记', hits: recentNotes }]
        : [];
    }
    return results.groups.map((group: SearchGroup) => ({
      key: group.kind,
      label: group.label,
      hits: group.hits,
    }));
  }, [query, recentNotes, results.groups]);

  const hits = useMemo(
    () => groups.flatMap((group) => group.hits),
    [groups],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    setActiveIndex((current) =>
      hits.length === 0 ? 0 : Math.min(current, hits.length - 1),
    );
  }, [hits.length]);

  const openHit = (hit: SearchHit) => {
    onClose();
    navigate(hit.path);
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      if (hits.length === 0) {
        return;
      }
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % hits.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      if (hits.length === 0) {
        return;
      }
      event.preventDefault();
      setActiveIndex(
        (current) => (current - 1 + hits.length) % hits.length,
      );
      return;
    }
    if (event.key === 'Home' && hits.length > 0) {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === 'End' && hits.length > 0) {
      event.preventDefault();
      setActiveIndex(hits.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      const hit = hits[activeIndex];
      if (!hit) {
        return;
      }
      event.preventDefault();
      openHit(hit);
    }
  };

  const ready = status === 'ready';
  const showResults = ready && hits.length > 0;
  const inputDisabled = status === 'unavailable' || status === 'error';

  let flatIndex = 0;

  return (
    <CommandDialog
      open={open}
      label="全局搜索"
      className="search-palette"
      initialFocusRef={inputRef}
      onClose={onClose}
    >
      <div className="search-bar">
        <SearchIcon className="search-bar-icon" />
        <input
          ref={inputRef}
          className="search-bar-input"
          type="text"
          value={query}
          disabled={inputDisabled}
          placeholder="搜索任务、笔记、事件、倒数日、习惯…"
          aria-label="搜索本机数据"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showResults}
          aria-controls={showResults ? listboxId : undefined}
          aria-activedescendant={
            showResults ? `${listboxId}-hit-${activeIndex}` : undefined
          }
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
        />
        {query ? (
          <button
            type="button"
            className="search-clear"
            aria-label="清空搜索"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        ) : null}
        <kbd className="command-kbd">Esc</kbd>
      </div>

      <div className="search-body">
        {status === 'loading' ? (
          <div className="search-state" role="status" aria-live="polite">
            <span className="search-state-mark" aria-hidden="true">
              库
            </span>
            <b>正在读取本机数据…</b>
            <p>任务、笔记、事件、倒数日和习惯都从本机 SQLite 读取。</p>
          </div>
        ) : null}

        {status === 'unavailable' ? (
          <div className="search-state">
            <span className="search-state-mark" aria-hidden="true">
              库
            </span>
            <b>需在桌面壳内搜索</b>
            <p>
              搜索只读取本机 SQLite。浏览器预览没有 Tauri IPC
              通道，请使用 <code>pnpm --filter app tauri dev</code> 启动桌面壳。
            </p>
          </div>
        ) : null}

        {status === 'error' ? (
          <div className="search-state" role="alert">
            <span className="search-state-mark" aria-hidden="true">
              !
            </span>
            <b>搜索读取失败</b>
            <p>{error}</p>
            <button
              type="button"
              className="command-button command-state__action"
              onClick={() => setReloadKey((current) => current + 1)}
            >
              重试
            </button>
          </div>
        ) : null}

        {ready && hits.length === 0 ? (
          query.trim() ? (
            <div className="search-state">
              <span className="search-state-mark" aria-hidden="true">
                ⌕
              </span>
              <b>没有匹配结果</b>
              <p>
                试试标题或正文中的关键词。搜索范围只有任务、笔记、事件、倒数日和习惯，
                <strong>不含附件、标签和 OCR</strong>。
              </p>
            </div>
          ) : (
            <div className="search-state">
              <span className="search-state-mark" aria-hidden="true">
                ⌕
              </span>
              <b>输入关键词开始搜索</b>
              <p>
                搜索任务、笔记、事件、倒数日与习惯；⌘N
                可以快速创建任务或笔记。这里只读本机数据。
              </p>
            </div>
          )
        ) : null}

        {showResults ? (
          <div
            className="search-results"
            id={listboxId}
            role="listbox"
            aria-label={query.trim() ? '搜索结果' : '最近笔记'}
          >
            {groups.map((group) => (
              <div
                className="search-group"
                role="group"
                aria-label={group.label}
                key={group.key}
              >
                <div className="search-group-head">
                  <span>{group.label}</span>
                  <span className="search-group-count">
                    {group.hits.length}
                  </span>
                </div>
                {group.hits.map((hit) => {
                  const index = flatIndex;
                  flatIndex += 1;
                  return (
                    <button
                      type="button"
                      role="option"
                      id={`${listboxId}-hit-${index}`}
                      key={hit.key}
                      className={
                        index === activeIndex
                          ? 'search-result is-active'
                          : 'search-result'
                      }
                      aria-selected={index === activeIndex}
                      data-hit-key={hit.key}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => openHit(hit)}
                    >
                      <span className={`search-kind is-${hit.kind}`}>
                        {group.label}
                      </span>
                      <span className="search-result-main">
                        <b>{hit.title}</b>
                        {hit.excerpt ? <small>{hit.excerpt}</small> : null}
                      </span>
                      <span className="search-result-meta">{hit.meta}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <footer className="search-foot">
        <span className="search-scope">
          本机数据 · 不含附件、标签与 OCR
        </span>
        <span className="search-keys">
          <span>
            <kbd className="command-kbd">↑</kbd>
            <kbd className="command-kbd">↓</kbd> 选择
          </span>
          <span>
            <kbd className="command-kbd">↵</kbd> 打开
          </span>
          <span>
            <kbd className="command-kbd">Esc</kbd> 关闭
          </span>
        </span>
      </footer>
    </CommandDialog>
  );
}
