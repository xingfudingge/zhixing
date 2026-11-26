/**
 * 单个文本块的行内编辑视图。
 *
 * DOM 只是视图；输入后立即序列化为 `InlineRun[]` 交给父组件。父组件应用
 * 格式时改 runs，组件在 layout effect 中重绘并恢复选区。
 */

import {
  useLayoutEffect,
  useRef,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import {
  inlineRunsFromNode,
  mergeRuns,
  restoreSelectionByOffsets,
  runsEqual,
  runsToHtml,
  runsToPlainText,
  selectionOffsetsIn,
  selectionRect,
  splitRunsForEnter,
  type InlineSelection,
  type SelectionRect,
} from '../inline';
import { internalNoteIdFromUrl } from '../security';
import type { InlineMarks, InlineRun } from '../types';

export type InlinePastePayload = {
  html: string;
  text: string;
  offsets: InlineSelection;
};

export type InlineEditableProps = {
  blockId: string;
  runs: InlineRun[];
  readOnly: boolean;
  as?: 'div' | 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'span' | 'blockquote';
  className?: string;
  ariaLabel: string;
  placeholder: string;
  onInput: (blockId: string, runs: InlineRun[]) => void;
  onInlineFormat: (patch: Partial<InlineMarks>) => void;
  onSelectionChange: (
    blockId: string,
    selection: (InlineSelection & { rect: SelectionRect }) | null,
  ) => void;
  onEnter: (blockId: string, before: InlineRun[], after: InlineRun[]) => void;
  onBackspaceAtStart: (blockId: string) => void;
  onSlash: (blockId: string, rect: SelectionRect) => void;
  onPaste: (blockId: string, payload: InlinePastePayload) => void;
  onFocusBlock: (blockId: string) => void;
  onBlurBlock: (blockId: string) => void;
  /**
   * 打开站内笔记（N-16）。编辑态只在 Ctrl/Cmd+点击时触发；阅读态直接触发。
   * 是否存在的判断由上层负责，这里只解析 id。
   */
  onOpenNote?: (noteId: string) => void;
};

export function InlineEditable({
  blockId,
  runs,
  readOnly,
  as = 'div',
  className,
  ariaLabel,
  placeholder,
  onInput,
  onInlineFormat,
  onSelectionChange,
  onEnter,
  onBackspaceAtStart,
  onSlash,
  onPaste,
  onFocusBlock,
  onBlurBlock,
  onOpenNote,
}: InlineEditableProps) {
  const ref = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const Tag = as as 'div';

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    if (!initialized.current) {
      element.innerHTML = runsToHtml(runs);
      initialized.current = true;
      return;
    }
    const current = inlineRunsFromNode(element);
    if (!runsEqual(current, runs)) {
      const focused = document.activeElement === element;
      const offsets = focused ? selectionOffsetsIn(element) : null;
      element.innerHTML = runsToHtml(runs);
      if (focused) {
        element.focus();
      }
      if (offsets) {
        restoreSelectionByOffsets(element, offsets.start, offsets.end);
      }
    }
  }, [runs]);

  const reportSelection = () => {
    const element = ref.current;
    if (!element || readOnly) {
      return;
    }
    const offsets = selectionOffsetsIn(element);
    if (!offsets || offsets.start === offsets.end) {
      onSelectionChange(blockId, null);
      return;
    }
    onSelectionChange(blockId, {
      ...offsets,
      rect: selectionRect(),
    });
  };

  const handleInput = (_event: ReactFormEvent<HTMLDivElement>) => {
    const element = ref.current;
    if (!element || readOnly) {
      return;
    }
    onInput(blockId, inlineRunsFromNode(element));
    reportSelection();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (readOnly) {
      return;
    }
    const element = ref.current;
    if (!element) {
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      const patch =
        key === 'b'
          ? { bold: true }
          : key === 'i'
            ? { italic: true }
            : key === 'u'
              ? { underline: true }
              : null;
      if (patch) {
        // 接管浏览器原生 execCommand 快捷键，统一走结构化 runs。
        event.preventDefault();
        reportSelection();
        onInlineFormat(patch);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const current = inlineRunsFromNode(element);
      const offsets = selectionOffsetsIn(element) ?? {
        start: runsToPlainText(current).length,
        end: runsToPlainText(current).length,
      };
      const { before, after } = splitRunsForEnter(
        current,
        offsets.start,
        offsets.end,
      );
      onEnter(blockId, before, after);
      return;
    }
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const current = inlineRunsFromNode(element);
      if (runsToPlainText(current).trim() === '') {
        event.preventDefault();
        onSlash(blockId, selectionRect());
      }
      return;
    }
    if (event.key === 'Backspace') {
      const offsets = selectionOffsetsIn(element);
      if (offsets && offsets.start === 0 && offsets.end === 0) {
        event.preventDefault();
        onBackspaceAtStart(blockId);
      }
    }
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (readOnly) {
      return;
    }
    const element = ref.current;
    if (!element) {
      return;
    }
    event.preventDefault();
    const html = event.clipboardData?.getData('text/html') ?? '';
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!html && !text) {
      return;
    }
    const offsets = selectionOffsetsIn(element) ?? {
      start: runsToPlainText(inlineRunsFromNode(element)).length,
      end: runsToPlainText(inlineRunsFromNode(element)).length,
    };
    onPaste(blockId, { html, text, offsets });
  };

  const handleMouseUp = (_event: ReactMouseEvent<HTMLDivElement>) => {
    reportSelection();
  };

  const handleKeyUp = () => {
    reportSelection();
  };

  const text = runsToPlainText(runs);
  const empty = text.replace(/\n/g, '') === '';

  return (
    <Tag
      ref={ref}
      className={className ? `zxe-inline ${className}` : 'zxe-inline'}
      role="textbox"
      aria-label={ariaLabel}
      aria-multiline="true"
      contentEditable={!readOnly}
      suppressContentEditableWarning
      spellCheck={false}
      data-inline-editor="true"
      data-empty={empty ? 'true' : 'false'}
      data-placeholder={placeholder}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onMouseUp={handleMouseUp}
      onPaste={handlePaste}
      onClick={(event) => {
        const anchor = (event.target as Element | null)?.closest?.('a');
        if (!anchor) {
          return;
        }
        const href = anchor.getAttribute('href');
        const internalNoteId = internalNoteIdFromUrl(href);
        if (internalNoteId) {
          // 编辑态普通点击只落光标，避免写正文时误跳；阅读态直接打开。
          event.preventDefault();
          if (readOnly || event.metaKey || event.ctrlKey) {
            onOpenNote?.(internalNoteId);
          }
          return;
        }
        event.preventDefault();
        if (readOnly && href && typeof window !== 'undefined') {
          window.open(href, '_blank', 'noopener,noreferrer');
        }
      }}
      onFocus={() => {
        onFocusBlock(blockId);
        reportSelection();
      }}
      onBlur={() => onBlurBlock(blockId)}
    />
  );
}

/** 供父组件读取当前 DOM 的行内 runs（粘贴/回车时用）。 */
export function readInlineRuns(element: HTMLElement | null): InlineRun[] {
  return element ? mergeRuns(inlineRunsFromNode(element)) : [];
}
