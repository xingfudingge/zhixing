import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ChangeEvent,
  CompositionEvent as ReactCompositionEvent,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  UIEvent as ReactUIEvent,
} from 'react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type { LanguageFn } from 'highlight.js';

import type { EditorBlock } from '../../../data/repositories/blocks';
import { escapeHtml } from '../security';
import { OverflowMenu } from './OverflowMenu';
import {
  CODE_LANGUAGES,
  blockCode,
  blockCodeLineNumbers,
  blockCodeWrap,
  blockLanguage,
  canonicalCodeLanguage,
  codeHighlightLanguage,
  codeIndentUnit,
  codeLanguageOption,
  sanitizeCodeLanguage,
} from '../types';

type CodeBlockProps = {
  block: EditorBlock;
  readOnly: boolean;
  onChange: (code: string) => void;
  onChangeLanguage: (language: string) => void;
  /** 可选：换行/行号设置持久化；未提供时只在当前实例内生效。 */
  onChangeOptions?: (patch: Record<string, boolean>) => void;
};

/**
 * 语言模块按需注册（离线内置，不发外部请求）。
 * 只注册下拉里出现的语言，未知语言不会调用 highlight.js。
 */
const HIGHLIGHT_MODULES: Readonly<Record<string, LanguageFn>> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  markdown,
  php,
  python,
  r,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, module] of Object.entries(HIGHLIGHT_MODULES)) {
  if (!hljs.getLanguage(name)) {
    hljs.registerLanguage(name, module);
  }
}

function highlightCode(code: string, language: string): string {
  if (!code) {
    return '';
  }
  const id = codeHighlightLanguage(language);
  if (!id || !hljs.getLanguage(id)) {
    return escapeHtml(code);
  }
  try {
    return hljs.highlight(code, { language: id, ignoreIllegals: true }).value;
  } catch {
    // 高亮异常绝不能影响正文可读性，也不能把错误抛到控制台。
    return escapeHtml(code);
  }
}

type Selection = { start: number; end: number };

/** 代码块左右内边距，镜像层测宽时要扣掉。 */
const CODE_PADDING_X = 14;
/** 代码块顶部内边距，gutter 行号从这里开始。 */
const CODE_PADDING_Y = 12;
/** 12.5px × 1.7；测量不可用时（如 jsdom）的首屏兜底。 */
const FALLBACK_LINE_HEIGHT = 21.25;

/** 逻辑行：空代码也保留一行，行号从 1 开始。 */
function codeLines(code: string): string[] {
  return code ? code.split('\n') : [''];
}

function lineStartAt(code: string, index: number): number {
  const before = code.lastIndexOf('\n', Math.max(0, index - 1));
  return before < 0 ? 0 : before + 1;
}

function indentLines(
  code: string,
  selection: Selection,
  unit: string,
  outdent: boolean,
): { code: string; selection: Selection } {
  const { start, end } = selection;
  const from = lineStartAt(code, start);
  // 选区正好停在行首时，不要动下一行。
  const to = end > start && code[end - 1] === '\n' ? end - 1 : end;
  const block = code.slice(from, to);
  const lines = block.split('\n');
  let firstDelta = 0;
  const nextLines = lines.map((line, index) => {
    if (!outdent) {
      if (index === 0) {
        firstDelta = unit.length;
      }
      return unit + line;
    }
    const removable = Math.min(unit.length, /^ */.exec(line)?.[0].length ?? 0);
    if (index === 0) {
      firstDelta = -removable;
    }
    return line.slice(removable);
  });
  const nextBlock = nextLines.join('\n');
  return {
    code: `${code.slice(0, from)}${nextBlock}${code.slice(to)}`,
    selection: {
      start: Math.max(from, start + firstDelta),
      end: Math.max(from, end + (nextBlock.length - block.length)),
    },
  };
}

function applyIndent(
  code: string,
  selection: Selection,
  language: string,
  outdent: boolean,
): { code: string; selection: Selection } {
  const unit = codeIndentUnit(language);
  if (selection.start !== selection.end) {
    return indentLines(code, selection, unit, outdent);
  }
  const { start } = selection;
  const from = lineStartAt(code, start);
  const linePrefix = code.slice(from, start);
  const hasSelectionAtLineStart = linePrefix.length === 0;
  if (!outdent) {
    const value = `${code.slice(0, start)}${unit}${code.slice(start)}`;
    return {
      code: value,
      selection: { start: start + unit.length, end: start + unit.length },
    };
  }
  if (hasSelectionAtLineStart) {
    const removable = Math.min(
      unit.length,
      /^ */.exec(code.slice(start))?.[0].length ?? 0,
    );
    return {
      code: `${code.slice(0, start)}${code.slice(start + removable)}`,
      selection: {
        start: Math.max(from, start - removable),
        end: Math.max(from, start - removable),
      },
    };
  }
  return indentLines(code, selection, unit, true);
}

function autoIndentOnEnter(
  code: string,
  selection: Selection,
  language: string,
  indent: boolean,
): { code: string; selection: Selection } {
  const { start, end } = selection;
  if (!indent) {
    return {
      code: `${code.slice(0, start)}\n${code.slice(end)}`,
      selection: { start: start + 1, end: start + 1 },
    };
  }
  const from = lineStartAt(code, start);
  const currentLine = code.slice(from, start);
  const leading = /^[ \t]*/.exec(currentLine)?.[0] ?? '';
  const trimmed = currentLine.trimEnd();
  const unit = codeIndentUnit(language);
  let extra = '';
  if (/(\{|\[|\()$/.test(trimmed)) {
    extra = unit;
  } else if (trimmed.endsWith(':')) {
    // Python 的冒号缩进 4 空格，其余语言沿用缩进单位（2 空格）。
    extra = unit;
  }
  const insertion = `\n${leading}${extra}`;
  return {
    code: `${code.slice(0, start)}${insertion}${code.slice(end)}`,
    selection: {
      start: start + insertion.length,
      end: start + insertion.length,
    },
  };
}

/** 示例模板：按语言给出可直接运行/阅读的最小片段。 */
const CODE_SAMPLES: Readonly<Record<string, string>> = {
  javascript:
    "const notes = ['知行', '任务', '日历'];\nnotes.forEach((note) => console.log(note));",
  typescript:
    "type Note = { id: string; title: string };\n\nconst render = (note: Note): string => `# ${note.title}`;",
  json: '{\n  "title": "知行",\n  "ready": true\n}',
  html: '<article class="note">\n  <h1>知行</h1>\n</article>',
  css: '.note {\n  display: grid;\n  gap: 12px;\n}',
  python: "def main():\n    print('知行')\n\n\nif __name__ == '__main__':\n    main()",
  bash: 'pnpm --filter app test\npnpm --filter app build',
  sql: 'select id, title\nfrom notes\nwhere deleted_at is null;',
  go: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("知行")\n}',
  rust: 'fn main() {\n    println!("知行");\n}',
  java: 'class Main {\n  public static void main(String[] args) {\n    System.out.println("知行");\n  }\n}',
  markdown: '# 知行\n\n- 任务\n- 知识\n- 日历',
  plaintext: '在这里输入文本。',
};

function sampleFor(language: string): string {
  const canonical = canonicalCodeLanguage(language);
  return CODE_SAMPLES[canonical] ?? '// 在这里输入代码\n';
}

async function copyCode(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走 execCommand 兜底（Tauri WebView / 旧内核）。
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

type LanguagePickerProps = {
  value: string;
  onChange: (language: string) => void;
  listId: string;
  /** 语言菜单开合；属性头据此保持挂载，避免选项被中途卸载。 */
  onOpenChange?: (open: boolean) => void;
};

function LanguagePicker({
  value,
  onChange,
  listId,
  onOpenChange,
}: LanguagePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return CODE_LANGUAGES;
    }
    return CODE_LANGUAGES.filter(
      (option) =>
        option.id.includes(needle) ||
        option.label.toLowerCase().includes(needle) ||
        option.aliases.some((alias) => alias.includes(needle)),
    );
  }, [query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const openMenu = () => {
    setQuery('');
    setOpen(true);
  };

  const choose = (id: string) => {
    onChange(id === 'plaintext' ? '' : id);
    setOpen(false);
    setQuery('');
    queueMicrotask(() => inputRef.current?.focus());
  };

  const commit = () => {
    const canonical = canonicalCodeLanguage(value);
    if (canonical !== value) {
      onChange(canonical === 'plaintext' ? '' : canonical);
    }
    setOpen(false);
  };

  return (
    <div className="zxe-code-lang" ref={rootRef}>
      <input
        ref={inputRef}
        className="zxe-code-language-input"
        role="combobox"
        aria-label="代码语言"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        value={value}
        placeholder="纯文本"
        maxLength={24}
        spellCheck={false}
        onFocus={openMenu}
        onClick={() => {
          if (!open) {
            openMenu();
          }
        }}
        onChange={(event) => {
          const next = sanitizeCodeLanguage(event.target.value);
          setQuery(next);
          onChange(next);
          setOpen(true);
        }}
        onBlur={(event) => {
          if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
            commit();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
              openMenu();
              return;
            }
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            setActiveIndex((index) => {
              if (options.length === 0) {
                return 0;
              }
              return (index + delta + options.length) % options.length;
            });
            return;
          }
          if (event.key === 'Enter') {
            if (open && options[activeIndex]) {
              event.preventDefault();
              choose(options[activeIndex].id);
            } else if (open) {
              event.preventDefault();
              commit();
            }
            return;
          }
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
      />
      <button
        type="button"
        className="zxe-code-lang-toggle"
        aria-label="选择代码语言"
        aria-expanded={open}
        aria-controls={listId}
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            openMenu();
            inputRef.current?.focus();
          }
        }}
      >
        ▾
      </button>
      {open ? (
        <ul
          id={listId}
          className="zxe-code-lang-menu"
          role="listbox"
          aria-label="常用代码语言"
        >
          {options.length === 0 ? (
            <li className="zxe-code-lang-empty" role="presentation">
              未找到预设，按 Enter 使用手输值
            </li>
          ) : (
            options.map((option, index) => {
              const selected =
                canonicalCodeLanguage(value || 'plaintext') === option.id;
              return (
                <li
                  key={option.id}
                  role="option"
                  aria-selected={selected}
                  className={`zxe-code-lang-option${
                    index === activeIndex ? ' is-active' : ''
                  }${selected ? ' is-selected' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(option.id)}
                >
                  <span>{option.label}</span>
                  <code>{option.id}</code>
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}

export function CodeBlock({
  block,
  readOnly,
  onChange,
  onChangeLanguage,
  onChangeOptions,
}: CodeBlockProps) {
  const code = blockCode(block);
  const language = blockLanguage(block);
  const id = useId();
  const listId = `${id}-languages`;
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const gutterInnerRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const pendingSelection = useRef<Selection | null>(null);
  const pendingViewRestore = useRef<{
    selection: Selection;
    scrollTop: number;
    scrollLeft: number;
  } | null>(null);
  const measureRef = useRef<() => void>(() => undefined);
  const copyTimer = useRef<number | null>(null);
  const [composing, setComposing] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>(
    'idle',
  );
  /**
   * 属性头（语言/复制/更多）默认不渲染，只在指针悬停、块内获得焦点或
   * 更多菜单打开时浮出（ZX6-PROPS-02）。浮层绝对定位在代码块右上方，
   * 不占文档流、不遮挡代码正文；根节点可聚焦，键盘 Tab 进入后即可到达。
   */
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const headVisible =
    hovered || focusWithin || moreMenuOpen || languageMenuOpen;
  const [wrap, setWrap] = useState(() => blockCodeWrap(block));
  const [lineNumbers, setLineNumbers] = useState(() =>
    blockCodeLineNumbers(block),
  );
  const [gutterMetrics, setGutterMetrics] = useState<{
    tops: number[];
    lineHeight: number;
  }>({ tops: [], lineHeight: FALLBACK_LINE_HEIGHT });

  useEffect(() => {
    setWrap(blockCodeWrap(block));
    setLineNumbers(blockCodeLineNumbers(block));
  }, [block.id, block.payload.wrap, block.payload.lineNumbers]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
    },
    [],
  );

  /** 把 textarea / 只读 pre 的滚动同步到高亮层与 gutter。 */
  const syncLayers = (scrollTop: number, scrollLeft: number) => {
    const highlight = highlightRef.current;
    if (highlight) {
      highlight.scrollTop = scrollTop;
      highlight.scrollLeft = scrollLeft;
    }
    const gutterInner = gutterInnerRef.current;
    if (gutterInner) {
      gutterInner.style.transform = `translateY(${-scrollTop}px)`;
    }
  };

  /**
   * 用隐藏镜像层测量每条逻辑行第一视觉行的纵向偏移。
   * 镜像层宽度与 textarea 内容宽度一致，所以换行后的行高与正文完全相同；
   * gutter 只在逻辑行起点放一个编号，折行续行不重复编号。
   */
  const measureGutter = () => {
    const scroller = readOnly ? preRef.current : textareaRef.current;
    const view = viewRef.current;
    if (!scroller) {
      return;
    }
    if (view) {
      // textarea 出现纵向滚动条时内容宽度会变窄；高亮层按同一宽度收窄，
      // 否则换行位置会与正文错开。
      view.style.setProperty(
        '--zxe-code-scrollbar',
        `${Math.max(0, scroller.offsetWidth - scroller.clientWidth)}px`,
      );
    }
    const mirror = mirrorRef.current;
    if (!mirror) {
      return;
    }
    // clientWidth 已排除滚动条，减去左右内边距就是可折行宽度。
    mirror.style.width = `${Math.max(
      48,
      scroller.clientWidth - CODE_PADDING_X * 2,
    )}px`;
    const lineHeight =
      parseFloat(window.getComputedStyle(mirror).lineHeight) ||
      FALLBACK_LINE_HEIGHT;
    const tops = Array.from(
      mirror.children,
      (node) => (node as HTMLElement).offsetTop,
    );
    setGutterMetrics((current) => {
      if (
        current.lineHeight === lineHeight &&
        current.tops.length === tops.length &&
        current.tops.every((top, index) => top === tops[index])
      ) {
        return current;
      }
      return { tops, lineHeight };
    });
    syncLayers(scroller.scrollTop, scroller.scrollLeft);
  };

  useLayoutEffect(() => {
    measureRef.current = measureGutter;
    measureGutter();
  }, [code, wrap, lineNumbers, readOnly]);

  useEffect(() => {
    const scroller = readOnly ? preRef.current : textareaRef.current;
    if (!scroller) {
      return;
    }
    let disposed = false;
    const remeasure = () => {
      if (!disposed) {
        measureRef.current();
      }
    };
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(remeasure);
      observer.observe(scroller);
    }
    // 窗口/字体缩放不一定改变 scroller 自身尺寸，额外监听 resize 兜底。
    window.addEventListener('resize', remeasure);
    void document.fonts?.ready.then(remeasure).catch(() => undefined);
    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener('resize', remeasure);
    };
  }, [readOnly]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const selection = pendingSelection.current;
    if (!textarea || !selection) {
      return;
    }
    pendingSelection.current = null;
    textarea.focus();
    textarea.setSelectionRange(selection.start, selection.end);
  }, [code]);

  // 切换换行/行号只改视图，不重建 textarea；这里把光标、选区和滚动位置还原。
  useLayoutEffect(() => {
    const snapshot = pendingViewRestore.current;
    if (!snapshot) {
      return;
    }
    pendingViewRestore.current = null;
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.setSelectionRange(snapshot.selection.start, snapshot.selection.end);
    textarea.scrollTop = snapshot.scrollTop;
    textarea.scrollLeft = snapshot.scrollLeft;
    syncLayers(snapshot.scrollTop, snapshot.scrollLeft);
  }, [wrap, lineNumbers]);

  const highlighted = useMemo(
    () => highlightCode(code, language),
    [code, language],
  );
  const option = codeLanguageOption(language);
  const badgeText =
    !language.trim() || option?.id === 'plaintext'
      ? '纯文本'
      : option
        ? option.label
        : '未识别 · 纯文本';
  const lines = useMemo(() => codeLines(code), [code]);
  const lineCount = lines.length;
  const rows = Math.max(3, Math.min(24, lineCount + 1));

  const commitEdit = (next: string, selection?: Selection) => {
    if (selection) {
      pendingSelection.current = selection;
    }
    onChange(next);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    const textarea = event.currentTarget;
    const selection = {
      start: textarea.selectionStart ?? 0,
      end: textarea.selectionEnd ?? 0,
    };
    if (event.key === 'Tab') {
      event.preventDefault();
      const next = applyIndent(
        code,
        selection,
        language,
        event.shiftKey,
      );
      commitEdit(next.code, next.selection);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const next = autoIndentOnEnter(
        code,
        selection,
        language,
        !event.shiftKey,
      );
      commitEdit(next.code, next.selection);
    }
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(event.target.value);
  };

  const handleCompositionEnd = (
    event: ReactCompositionEvent<HTMLTextAreaElement>,
  ) => {
    setComposing(false);
    onChange(event.currentTarget.value);
  };

  const handleScroll = (
    event: ReactUIEvent<HTMLTextAreaElement | HTMLPreElement>,
  ) => {
    const { scrollTop, scrollLeft } = event.currentTarget;
    syncLayers(scrollTop, scrollLeft);
  };

  const handleCopy = async () => {
    const ok = await copyCode(code);
    setCopyState(ok ? 'copied' : 'error');
    if (copyTimer.current !== null) {
      window.clearTimeout(copyTimer.current);
    }
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1800);
    if (!ok) {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    }
  };

  /**
   * 焦点离开整个代码块时收起属性头；焦点进入更多菜单（portal）时保持
   * 可见，避免“点开菜单→属性头先被卸载→菜单失去锚点”的闪断。
   */
  const handleBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    const insideRoot =
      next instanceof Node && Boolean(rootRef.current?.contains(next));
    const insideMenu =
      next instanceof Element &&
      Boolean(next.closest('.zxe-overflow-menu'));
    if (!insideRoot && !insideMenu) {
      setFocusWithin(false);
    }
  };

  const captureViewState = () => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return null;
    }
    return {
      selection: {
        start: textarea.selectionStart ?? 0,
        end: textarea.selectionEnd ?? 0,
      },
      scrollTop: textarea.scrollTop,
      scrollLeft: textarea.scrollLeft,
    };
  };

  const toggleWrap = () => {
    pendingViewRestore.current = captureViewState();
    const next = !wrap;
    setWrap(next);
    onChangeOptions?.({ wrap: next });
  };

  const toggleLineNumbers = () => {
    pendingViewRestore.current = captureViewState();
    const next = !lineNumbers;
    setLineNumbers(next);
    onChangeOptions?.({ lineNumbers: next });
  };

  const insertSample = () => {
    commitEdit(sampleFor(language));
  };

  const codeClassName = `hljs${codeHighlightLanguage(language) ? '' : ' language-plaintext'}`;
  const gutterTops =
    gutterMetrics.tops.length === lineCount ? gutterMetrics.tops : null;

  return (
    <div
      ref={rootRef}
      className={`zxe-code${wrap ? ' is-wrap' : ''}${
        composing ? ' is-composing' : ''
      }${readOnly ? ' is-readonly' : ''}`}
      role="group"
      aria-label="代码块"
      data-language={language || 'plaintext'}
      data-head-visible={headVisible ? 'true' : 'false'}
      tabIndex={readOnly ? -1 : 0}
      onFocus={() => setFocusWithin(true)}
      onBlur={handleBlur}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {headVisible ? (
        <div className="zxe-code-head is-floating">
          <span className="zxe-code-label">&lt;/&gt; 代码</span>
          <div className="zxe-code-tools">
            {readOnly ? (
              <span
                className="zxe-code-language"
                title={language || 'plaintext'}
              >
                {badgeText}
              </span>
            ) : (
              <LanguagePicker
                value={language}
                onChange={onChangeLanguage}
                listId={listId}
                onOpenChange={setLanguageMenuOpen}
              />
            )}
            <button
              type="button"
              className={`zxe-code-action${
                copyState === 'copied' ? ' is-done' : ''
              }`}
              onClick={handleCopy}
              disabled={code === ''}
            >
              {copyState === 'copied' ? '已复制' : '复制'}
            </button>
            {readOnly ? null : (
              <OverflowMenu
                label="更多代码块选项"
                triggerTitle="换行、行号与示例"
                items={[
                  {
                    id: 'wrap',
                    label: '自动换行',
                    pressed: wrap,
                    onSelect: toggleWrap,
                  },
                  {
                    id: 'line-numbers',
                    label: '显示行号',
                    pressed: lineNumbers,
                    onSelect: toggleLineNumbers,
                  },
                  ...(code === ''
                    ? [
                        {
                          id: 'sample',
                          label: '插入示例',
                          onSelect: insertSample,
                        },
                      ]
                    : []),
                ]}
                onOpenChange={setMoreMenuOpen}
              />
            )}
          </div>
        </div>
      ) : null}

      <div className={`zxe-code-body${lineNumbers ? ' has-gutter' : ''}`}>
        {lineNumbers ? (
          <div className="zxe-code-gutter" aria-hidden="true">
            <div className="zxe-code-gutter-inner" ref={gutterInnerRef}>
              {lines.map((_, index) => (
                <span
                  key={index}
                  data-line={index + 1}
                  style={{
                    top:
                      CODE_PADDING_Y +
                      (gutterTops
                        ? gutterTops[index]
                        : index * gutterMetrics.lineHeight),
                  }}
                >
                  {index + 1}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <div className="zxe-code-view" ref={viewRef}>
          {readOnly ? (
            <pre
              className="zxe-code-pre"
              ref={preRef}
              tabIndex={0}
              onScroll={handleScroll}
            >
              <code
                className={codeClassName}
                // highlight.js 输出经过转义；未知语言回退到已转义源码。
                dangerouslySetInnerHTML={{ __html: highlighted || ' ' }}
              />
            </pre>
          ) : (
            <>
              <pre
                className="zxe-code-highlight"
                ref={highlightRef}
                aria-hidden="true"
              >
                <code
                  className={codeClassName}
                  dangerouslySetInnerHTML={{ __html: highlighted }}
                />
              </pre>
              <textarea
                ref={textareaRef}
                className="zxe-code-input"
                aria-label="代码内容"
                value={code}
                placeholder="输入代码…"
                rows={rows}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                wrap={wrap ? 'soft' : 'off'}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onScroll={handleScroll}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={handleCompositionEnd}
              />
            </>
          )}
        </div>
        {lineNumbers ? (
          <div className="zxe-code-mirror" aria-hidden="true" ref={mirrorRef}>
            {lines.map((line, index) => (
              <div
                className="zxe-code-mirror-line"
                data-line={index + 1}
                key={index}
              >
                {line === '' ? ' ' : line}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {readOnly ? null : (
        <div className="zxe-code-foot">
          <span>
            {option?.id === 'plaintext' || !language
              ? '纯文本'
              : option
                ? `${option.label} · ${option.id}`
                : `${language} · 纯文本`}
            {' · '}
            {lineCount} 行 · {code.length} 字符
          </span>
          <span className="zxe-code-hint">
            {code === ''
              ? '空代码块：输入即高亮；未识别语言按纯文本保存，不报错。'
              : `${wrap ? '自动换行' : '不换行'} · 行号${
                  lineNumbers ? '开' : '关'
                } · Tab 缩进 · Shift+Tab 反缩进`}
          </span>
        </div>
      )}

      <span className="zxe-code-copy-status" role="status" aria-live="polite">
        {copyState === 'copied'
          ? '已复制代码'
          : copyState === 'error'
            ? '复制失败，请手动选择代码'
            : ''}
      </span>
    </div>
  );
}
