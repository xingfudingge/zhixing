import katex from 'katex';
import 'katex/dist/katex.min.css';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { Modal } from '../../../app/a11y';
import type { EditorBlock } from '../../../data/repositories/blocks';
import {
  formulaDisplayMode,
  renderFormula,
  splitFormulaDelimiters,
  type FormulaDisplayMode,
  type FormulaRenderResult,
} from '../blockHtml';
import {
  TOOLBAR_HOVER_HIDE_MS,
  getFloatingLayer,
  useAnchoredToolbar,
  type ToolbarAnchor,
} from '../toolbarPlacement';
import { blockFormula } from '../types';
import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu';

type FormulaBlockProps = {
  block: EditorBlock;
  readOnly: boolean;
  onChangeLatex: (latex: string) => void;
  onChangeDisplay: (display: FormulaDisplayMode) => void;
  /** 右键在非 textarea 区域时回调；textarea 内保留原生文本菜单。 */
  onContextMenu?: (state: FormulaContextMenuState) => void;
};

/**
 * 公式右键菜单的实时状态。菜单项点击时执行，动作直接操作本块内部状态
 *（编辑/复制/显示模式/缩放/导出），避免编辑器重复实现公式逻辑。
 */
export type FormulaContextMenuState = {
  x: number;
  y: number;
  readOnly: boolean;
  editing: boolean;
  hasLatex: boolean;
  display: FormulaDisplayMode;
  renderStatus: FormulaRenderResult['status'];
  zoom: number;
  actions: {
    edit: () => void;
    finish: () => void;
    copyLatex: () => void;
    toggleDisplay: () => void;
    zoomIn: () => void;
    zoomOut: () => void;
    resetZoom: () => void;
    exportFormula: () => void;
    restoreFocus: () => void;
  };
};

const TEMPLATES: ReadonlyArray<{ label: string; source: string }> = [
  { label: '分数', source: '\\frac{a}{b}' },
  { label: '根式', source: '\\sqrt{x}' },
  { label: '上标', source: 'x^{2}' },
  { label: '下标', source: 'x_{i}' },
  { label: '求和', source: '\\sum_{i=1}^{n} x_i' },
  { label: '积分', source: '\\int_{a}^{b} f(x)\\,\\mathrm{d}x' },
  {
    label: '矩阵',
    source: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
  },
  {
    label: '分段',
    source: '\\begin{cases} x, & x \\ge 0 \\\\ -x, & x < 0 \\end{cases}',
  },
  { label: '希腊', source: '\\alpha \\beta \\gamma \\theta \\lambda' },
];

const EXPORT_TABS = [
  { id: 'latex', label: 'LaTeX' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'html', label: 'HTML' },
] as const;

/** 计算 caret 行时，computed line-height 为 normal 的回退值。 */
const FALLBACK_LINE_HEIGHT = 18;

type ExportTab = (typeof EXPORT_TABS)[number]['id'];
type CopyState = 'idle' | 'copied' | 'error';

function clampOffset(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    return max;
  }
  return Math.max(0, Math.min(Math.trunc(value), max));
}

async function copyText(text: string): Promise<boolean> {
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

function exportMarkdown(result: FormulaRenderResult): string {
  if (result.status === 'error') {
    return '<!-- 公式无法渲染 -->';
  }
  const source = result.source.trim();
  if (!source) {
    return '';
  }
  return result.display === 'inline'
    ? `$${source}$`
    : `$$\n${source}\n$$`;
}

/**
 * HTML 导出与阅读态一致：成功时给 KaTeX 结果；空公式省略；解析错误只给
 * 可见占位与注释，不把 LaTeX 源当作正文输出。
 */
function exportHtml(result: FormulaRenderResult): string {
  if (result.status === 'ok') {
    return result.html;
  }
  if (result.status === 'empty') {
    return '';
  }
  return '<!-- 公式无法渲染 -->\n<p class="zx-formula-error">⚠ 公式无法渲染</p>';
}

/**
 * 公式块：默认阅读态只渲染 KaTeX，源码/模板/错误详情只在编辑态出现。
 *
 * - 阅读态、导出 HTML 与编辑态预览共用 `renderFormula`，避免渲染结果漂移；
 * - 解析错误在阅读态只显示可理解占位，行列位置与摘录只在编辑态展示；
 * - `notes.body` 兼容缓存仍只写 LaTeX 源，不缓存 KaTeX HTML。
 */
export function FormulaBlock({
  block,
  readOnly,
  onChangeLatex,
  onChangeDisplay,
  onContextMenu,
}: FormulaBlockProps) {
  const formula = blockFormula(block);
  const display = formulaDisplayMode(block.payload);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<number | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const restoreFocusRef = useRef(false);
  /** 模板菜单（portal）打开期间不因失焦退出编辑。 */
  const templateMenuOpenRef = useRef(false);
  /** 打开菜单时的实时值与选区；插入以它为准，不读失焦后的 DOM 或父级 prop。 */
  const templateSnapshotRef = useRef<{
    value: string;
    start: number;
    end: number;
  } | null>(null);
  /** 模板插入后待恢复的光标；由 layout effect 在 React 提交 value 之后应用。 */
  const pendingCaretRef = useRef<number | null>(null);
  const errorId = useId();
  const textareaId = useId();
  const [editing, setEditing] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [exportOpen, setExportOpen] = useState(false);
  const [exportTab, setExportTab] = useState<ExportTab>('latex');
  const [exportCopyState, setExportCopyState] = useState<CopyState>('idle');
  const [zoom, setZoom] = useState(1);
  /**
   * 属性条默认不渲染；hover / focus-within / 菜单打开时才浮出。
   * 用状态而不是纯 CSS 隐藏，保证阅读态 DOM 里没有常驻属性标识，
   * 同时根节点本身可聚焦，键盘 Tab 进入公式块后属性条才出现。
   */
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  /** 自定义右键菜单打开期间让位；textarea 原生菜单不设置此标记。 */
  const [customMenuOpen, setCustomMenuOpen] = useState(false);
  /** caret 移动 / 输入 / textarea 滚动时自增，驱动工具条重新测量。 */
  const [caretTick, setCaretTick] = useState(0);
  const isEditing = editing && !readOnly;
  const metaVisible =
    !customMenuOpen &&
    (isEditing || hovered || focusWithin || moreMenuOpen);

  const result = useMemo(
    () => renderFormula(formula.latex, display),
    [formula.latex, display],
  );

  const bumpCaret = () => {
    setCaretTick((tick) => tick + 1);
  };

  /**
   * 工具条锚点（ZX7-TOOLBAR-01 §5.4）：
   * - 编辑态：textarea 内 caret 所在行（padding + 行高 × 行号 - scrollTop）；
   * - 阅读态：公式预览的右上角。
   * 只读 DOM 的 `getBoundingClientRect()`，不使用 offsetLeft/固定坐标。
   */
  const getToolbarAnchor = (): ToolbarAnchor | null => {
    const textarea = textareaRef.current;
    if (isEditing && textarea) {
      const rect = textarea.getBoundingClientRect();
      const style = window.getComputedStyle(textarea);
      const parsedLineHeight = Number.parseFloat(style.lineHeight);
      const lineHeight =
        Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
          ? parsedLineHeight
          : FALLBACK_LINE_HEIGHT;
      const paddingTop = Number.parseFloat(style.paddingTop) || 0;
      const caretOffset =
        textarea.selectionStart ?? textarea.value.length;
      const line = textarea.value
        .slice(0, caretOffset)
        .split('\n').length - 1;
      const rawTop =
        rect.top + paddingTop + line * lineHeight - textarea.scrollTop;
      const top = Math.max(
        rect.top,
        Math.min(rawTop, rect.bottom - lineHeight),
      );
      return {
        rect: {
          left: rect.left,
          top,
          right: rect.right,
          bottom: Math.min(rect.bottom, top + lineHeight),
          width: rect.width,
          height: lineHeight,
        },
        contentLeft: rect.left,
      };
    }
    const preview = previewRef.current;
    if (!preview) {
      return null;
    }
    const rootRect = rootRef.current?.getBoundingClientRect();
    return {
      rect: preview.getBoundingClientRect(),
      contentLeft: rootRect?.left,
    };
  };

  const toolbar = useAnchoredToolbar({
    open: metaVisible,
    getAnchor: getToolbarAnchor,
    signature: `${caretTick}|${isEditing ? 1 : 0}|${hovered ? 1 : 0}|${moreMenuOpen ? 1 : 0}|${formula.latex.length}`,
  });

  const showHover = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHovered(true);
  };

  /** 指针从公式块跨到 body 上的 portal 工具条时保留 120ms。 */
  const hideHoverSoon = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      setHovered(false);
    }, TOOLBAR_HOVER_HIDE_MS);
  };

  useEffect(
    () => () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    },
    [],
  );

  // 自定义右键菜单在外部的知识页菜单里渲染；点任意位置/滚动后恢复工具条。
  useEffect(() => {
    if (!customMenuOpen) {
      return;
    }
    const close = () => setCustomMenuOpen(false);
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', close, true);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', close, true);
      window.removeEventListener('scroll', close, true);
    };
  }, [customMenuOpen]);

  // 方向键/鼠标拖选改变 textarea caret 时重新测量（keyup 之外的第二道保险）。
  useEffect(() => {
    if (!isEditing) {
      return;
    }
    const onSelectionChange = () => {
      if (document.activeElement === textareaRef.current) {
        setCaretTick((tick) => tick + 1);
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () =>
      document.removeEventListener('selectionchange', onSelectionChange);
  }, [isEditing]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
    },
    [],
  );

  // 阅读模式强制回 view；切换笔记时也不保留上一块的编辑态。
  useEffect(() => {
    if (readOnly) {
      restoreFocusRef.current = false;
      setEditing(false);
    }
  }, [readOnly]);

  useEffect(() => {
    restoreFocusRef.current = false;
    setEditing(false);
  }, [block.id]);

  useEffect(() => {
    if (isEditing) {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus({ preventScroll: true });
      const caret = textarea.value.length;
      textarea.setSelectionRange(caret, caret);
      return;
    }
    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      rootRef.current?.focus({ preventScroll: true });
    }
  }, [isEditing]);

  // 退出编辑/切换块时 portal 菜单会被卸载且不再回调 onOpenChange；复位保护标记。
  useEffect(() => {
    if (isEditing) {
      return;
    }
    templateMenuOpenRef.current = false;
    templateSnapshotRef.current = null;
    pendingCaretRef.current = null;
  }, [isEditing]);

  /**
   * 模板插入后的光标必须在 React 提交受控 `value` 之后再恢复，
   * 因此用 useLayoutEffect；`queueMicrotask` 会抢在 commit 之前被覆盖。
   */
  useLayoutEffect(() => {
    if (!isEditing) {
      return;
    }
    const caret = pendingCaretRef.current;
    if (caret === null) {
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    pendingCaretRef.current = null;
    const next = Math.max(0, Math.min(caret, textarea.value.length));
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(next, next);
  }, [isEditing, formula.latex]);

  const startEditing = () => {
    if (readOnly) {
      return;
    }
    restoreFocusRef.current = false;
    if (editing) {
      textareaRef.current?.focus({ preventScroll: true });
      return;
    }
    setEditing(true);
  };

  const finishEditing = (restoreFocus: boolean) => {
    if (!editing) {
      return;
    }
    restoreFocusRef.current = restoreFocus;
    setEditing(false);
  };

  const changeCopyState = (next: CopyState) => {
    setCopyState(next);
    if (copyTimer.current !== null) {
      window.clearTimeout(copyTimer.current);
    }
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1800);
  };

  const handleCopyLatex = async () => {
    const ok = await copyText(formula.latex);
    changeCopyState(ok ? 'copied' : 'error');
  };

  /**
   * 模板菜单只存在于编辑态。打开时记录 textarea 的实时值与选区，
   * 关闭时归还焦点/选区；点外部关闭也不会把草稿连同编辑态一起丢掉。
   */
  const handleTemplateMenuOpenChange = (open: boolean) => {
    templateMenuOpenRef.current = open;
    const textarea = textareaRef.current;
    if (!textarea) {
      templateSnapshotRef.current = null;
      return;
    }
    if (open) {
      const length = textarea.value.length;
      const start = clampOffset(textarea.selectionStart ?? length, length);
      const end = clampOffset(textarea.selectionEnd ?? start, length);
      templateSnapshotRef.current = {
        value: textarea.value,
        start,
        end: Math.max(start, end),
      };
      return;
    }
    // 选择模板后的最终光标由 pendingCaretRef + useLayoutEffect 覆盖；
    // 这里只处理 Esc / 外部点击 / 再次点触发器这些“保持原选区”的关闭。
    if (pendingCaretRef.current !== null) {
      return;
    }
    const snapshot = templateSnapshotRef.current;
    textarea.focus({ preventScroll: true });
    if (snapshot) {
      const length = textarea.value.length;
      const start = clampOffset(snapshot.start, length);
      const end = Math.max(start, clampOffset(snapshot.end, length));
      textarea.setSelectionRange(start, end);
    }
  };

  const insertTemplate = (source: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      // 菜单只在编辑态渲染；没有输入框时不写死追加，避免把模板插到错误位置。
      return;
    }
    const snapshot = templateSnapshotRef.current;
    const value = textarea.value;
    const length = value.length;
    const start = snapshot
      ? clampOffset(snapshot.start, length)
      : clampOffset(textarea.selectionStart ?? length, length);
    const end = snapshot
      ? Math.max(start, clampOffset(snapshot.end, length))
      : Math.max(start, clampOffset(textarea.selectionEnd ?? start, length));
    const next = `${value.slice(0, start)}${source}${value.slice(end)}`;
    const caret = Math.min(start + source.length, next.length);
    templateSnapshotRef.current = { value: next, start: caret, end: caret };
    pendingCaretRef.current = caret;
    onChangeLatex(next);
  };

  const insertPastedSource = (
    event: ReactClipboardEvent<HTMLTextAreaElement>,
  ) => {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const stripped = splitFormulaDelimiters(text);
    if (!stripped.display) {
      return;
    }
    event.preventDefault();
    const textarea = event.currentTarget;
    const value = textarea.value;
    const start = clampOffset(
      textarea.selectionStart ?? value.length,
      value.length,
    );
    const end = Math.max(
      start,
      clampOffset(textarea.selectionEnd ?? start, value.length),
    );
    const next = `${value.slice(0, start)}${stripped.source}${value.slice(end)}`;
    const caret = Math.min(start + stripped.source.length, next.length);
    pendingCaretRef.current = caret;
    onChangeLatex(next);
    if (stripped.display !== display) {
      onChangeDisplay(stripped.display);
    }
  };

  const toggleDisplay = () => {
    onChangeDisplay(result.display === 'inline' ? 'block' : 'inline');
  };

  const changeZoom = (delta: number) => {
    setZoom((current) =>
      Math.max(0.8, Math.min(2, Math.round((current + delta) * 10) / 10)),
    );
  };

  const zoomStyle = {
    '--zxe-formula-zoom': String(zoom),
  } as CSSProperties;

  const renderPreview = (
    html: string,
    mode: FormulaDisplayMode,
  ): ReactNode =>
    mode === 'inline' ? (
      <span className="zxe-formula-inline-wrap">
        行内预览：当参数满足
        <span
          className="zxe-formula-inline-slot"
          // KaTeX 在 trust:false 下输出自身转义后的 HTML，不含可执行链接。
          dangerouslySetInnerHTML={{ __html: html }}
        />
        时命题成立
      </span>
    ) : (
      <div
        className="zxe-formula-rendered"
        // 同上：输出只来自 KaTeX，不拼接用户原始 HTML。
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );

  let previewContent: ReactNode;
  if (result.status === 'ok') {
    previewContent = renderPreview(result.html, result.display);
  } else if (result.status === 'empty') {
    previewContent = (
      <div className="zxe-formula-empty">
        <strong>空公式</strong>
        {isEditing ? (
          <span>在下方输入 LaTeX，预览会实时更新。</span>
        ) : readOnly ? (
          <span>阅读态不显示源码</span>
        ) : (
          <button
            type="button"
            className="zxe-formula-empty-action"
            onClick={startEditing}
          >
            点击添加公式
          </button>
        )}
      </div>
    );
  } else {
    previewContent = (
      <div className="zxe-formula-empty is-error">
        <strong>公式无法渲染</strong>
        {isEditing ? (
          <span>请检查下方的括号、命令或反斜杠。</span>
        ) : readOnly ? (
          <span>公式源数据错误</span>
        ) : (
          <span>打开编辑查看错误位置</span>
        )}
      </div>
    );
  }

  const statusText =
    result.status === 'empty'
      ? '空公式 · 等待输入'
      : result.status === 'error'
        ? result.line !== null && result.column !== null
          ? `解析错误 · 第 ${result.line} 行第 ${result.column} 列`
          : '解析错误 · 见下方错误详情'
        : '渲染成功 · 预览与导出一致';

  const exportData = {
    latex: formula.latex,
    markdown: exportMarkdown(result),
    html: exportHtml(result),
  };
  const exportText = exportData[exportTab];
  const exportLabel =
    EXPORT_TABS.find((tab) => tab.id === exportTab)?.label ?? 'LaTeX';

  const handleCopyExport = async () => {
    const ok = await copyText(exportText);
    setExportCopyState(ok ? 'copied' : 'error');
    if (copyTimer.current !== null) {
      window.clearTimeout(copyTimer.current);
    }
    copyTimer.current = window.setTimeout(
      () => setExportCopyState('idle'),
      1800,
    );
  };

  const handlePreviewClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (readOnly) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest('button, a')) {
      return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      return;
    }
    if (isEditing) {
      // 编辑态点预览不退出，也不把焦点丢给块容器（tabIndex=-1 会被点击聚焦）。
      textareaRef.current?.focus({ preventScroll: true });
      return;
    }
    startEditing();
  };

  const focusToolbarFirst = () => {
    toolbar.ref.current
      ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus();
  };

  const focusFormulaInput = () => {
    if (isEditing && textareaRef.current?.isConnected) {
      textareaRef.current.focus({ preventScroll: true });
      return;
    }
    rootRef.current?.focus({ preventScroll: true });
  };

  const handleToolbarKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    // 菜单 portal 的事件会沿 React 树冒泡到工具条；交给菜单自己的键盘逻辑。
    if (
      event.target instanceof Element &&
      event.target.closest('.zxe-overflow-menu')
    ) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      // 工具条 portal 的 React 事件会冒泡到公式块根节点；不停止会让根节点
      // 同时执行“退出编辑”，Esc 就回不到 textarea。
      event.stopPropagation();
      focusFormulaInput();
      return;
    }
    if (
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }
    const buttons = Array.from(
      toolbar.ref.current?.querySelectorAll<HTMLButtonElement>(
        'button:not(:disabled)',
      ) ?? [],
    );
    if (buttons.length === 0) {
      return;
    }
    event.preventDefault();
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : current === -1
            ? 0
            : (current +
                (event.key === 'ArrowRight' ? 1 : -1) +
                buttons.length) %
              buttons.length;
    buttons[next]?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey && event.key === 'F10' && metaVisible) {
      event.preventDefault();
      focusToolbarFirst();
      return;
    }
    if (!isEditing) {
      if (readOnly || event.target !== rootRef.current) {
        return;
      }
      if (
        event.key === 'Tab' &&
        !event.shiftKey &&
        metaVisible
      ) {
        // 工具条 portal 到 body 后，仍保持“根节点 → 工具条按钮”的顺序。
        event.preventDefault();
        focusToolbarFirst();
        return;
      }
      if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault();
        startEditing();
      }
      return;
    }
    if (event.key === 'Escape') {
      // 模板菜单打开时 Esc 只关闭菜单（由 OverflowMenu 接管并归还焦点），
      // 不退出编辑、不丢草稿。
      if (templateMenuOpenRef.current) {
        return;
      }
      event.preventDefault();
      finishEditing(true);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      finishEditing(true);
    }
  };

  const handleBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    // 焦点移到 portal 工具条、菜单或块内其他控件时，属性条保持可见，
    // 避免菜单/工具条刚打开就因“失焦”被卸载（ZX6-MENU-01、ZX7-TOOLBAR-01）。
    const insideRoot =
      next instanceof Node && Boolean(rootRef.current?.contains(next));
    const insideToolbar =
      next instanceof Node && Boolean(toolbar.ref.current?.contains(next));
    const insideMenu =
      next instanceof Element && Boolean(next.closest('.zxe-overflow-menu'));
    if (!insideRoot && !insideToolbar && !insideMenu) {
      setFocusWithin(false);
    }
    if (!isEditing) {
      return;
    }
    // portal 菜单打开期间焦点可能落到 body/菜单项，relatedTarget 在 WKWebView
    // 下还可能是 null；一律不退出编辑，等菜单关闭后再决定。
    if (templateMenuOpenRef.current) {
      return;
    }
    if (insideRoot || insideToolbar || insideMenu) {
      return;
    }
    finishEditing(false);
  };

  const handleMoreMenuOpenChange = (open: boolean) => {
    setMoreMenuOpen(open);
    if (open) {
      setFocusWithin(true);
      return;
    }
    const active = document.activeElement;
    setFocusWithin(
      active instanceof Node &&
        (Boolean(rootRef.current?.contains(active)) ||
          Boolean(toolbar.ref.current?.contains(active))),
    );
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    // 公式源码 textarea 保留原生文本菜单（剪切/复制/粘贴/输入法）。
    if (
      target instanceof Element &&
      target.closest('textarea, .zxe-formula-input')
    ) {
      event.stopPropagation();
      return;
    }
    if (!onContextMenu) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // 右键菜单与 hover 属性条二选一：菜单打开期间不叠加“编辑/更多”入口，
    // 菜单关闭后由焦点回归或再次 hover 恢复（ZX6-MENU-01）。
    setHovered(false);
    setFocusWithin(false);
    setCustomMenuOpen(true);
    const caret = textareaRef.current
      ? {
          start:
            textareaRef.current.selectionStart ??
            textareaRef.current.value.length,
          end:
            textareaRef.current.selectionEnd ??
            textareaRef.current.selectionStart ??
            textareaRef.current.value.length,
        }
      : null;
    const restoreFocus = () => {
      if (isEditing && textareaRef.current?.isConnected) {
        const textarea = textareaRef.current;
        textarea.focus({ preventScroll: true });
        const length = textarea.value.length;
        const start = Math.max(0, Math.min(caret?.start ?? length, length));
        const end = Math.max(start, Math.min(caret?.end ?? start, length));
        textarea.setSelectionRange(start, end);
        return;
      }
      rootRef.current?.focus({ preventScroll: true });
    };

    onContextMenu({
      x: event.clientX,
      y: event.clientY,
      readOnly,
      editing: isEditing,
      hasLatex: formula.latex.trim().length > 0,
      display: result.display,
      renderStatus: result.status,
      zoom,
      actions: {
        edit: startEditing,
        finish: () => finishEditing(true),
        copyLatex: () => {
          void handleCopyLatex();
        },
        toggleDisplay,
        zoomIn: () => changeZoom(0.1),
        zoomOut: () => changeZoom(-0.1),
        resetZoom: () => setZoom(1),
        exportFormula: () => {
          setExportTab('latex');
          setExportCopyState('idle');
          setExportOpen(true);
        },
        restoreFocus,
      },
    });
  };

  const menuItems: OverflowMenuItem[] = [
    {
      id: 'copy',
      label:
        copyState === 'copied'
          ? '已复制 LaTeX'
          : copyState === 'error'
            ? '复制失败'
            : '复制 LaTeX',
      disabled: !formula.latex.trim(),
      onSelect: () => {
        void handleCopyLatex();
      },
    },
    {
      id: 'display',
      label: result.display === 'inline' ? '切换为块级' : '切换为行内',
      disabled: readOnly,
      onSelect: toggleDisplay,
    },
    {
      id: 'zoom-in',
      label: '放大公式',
      disabled: zoom >= 2,
      onSelect: () => changeZoom(0.1),
    },
    {
      id: 'zoom-out',
      label: '缩小公式',
      disabled: zoom <= 0.8,
      onSelect: () => changeZoom(-0.1),
    },
    {
      id: 'zoom-reset',
      label: '重置公式缩放',
      disabled: zoom === 1,
      onSelect: () => setZoom(1),
    },
    {
      id: 'export',
      label: '导出',
      onSelect: () => {
        setExportTab('latex');
        setExportCopyState('idle');
        setExportOpen(true);
      },
    },
  ];

  return (
    <div
      ref={rootRef}
      className={`zxe-formula${readOnly ? ' is-readonly' : ''}${
        isEditing ? ' is-editing' : ''
      }`}
      role="group"
      aria-label="公式块"
      tabIndex={isEditing ? -1 : 0}
      data-state={isEditing ? 'edit' : 'view'}
      data-render-error={result.status === 'error' ? 'true' : 'false'}
      data-display={result.display}
      data-zoom={Math.round(zoom * 100)}
      data-meta-visible={metaVisible ? 'true' : 'false'}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      onFocus={() => setFocusWithin(true)}
      onContextMenu={handleContextMenu}
      onMouseEnter={showHover}
      onMouseLeave={(event) => {
        const next = event.relatedTarget;
        if (
          next instanceof Node &&
          toolbar.ref.current?.contains(next)
        ) {
          return;
        }
        hideHoverSoon();
      }}
    >
      {metaVisible
        ? createPortal(
            <div
              ref={toolbar.ref}
              className={`zxe-formula-head${
                isEditing ? ' is-editing' : ' is-floating'
              }`}
              role="toolbar"
              aria-label={isEditing ? '公式工具栏' : '公式属性'}
              aria-controls={isEditing ? textareaId : undefined}
              data-formula-strip
              data-positioned={toolbar.placement ? 'true' : 'false'}
              data-side={toolbar.placement?.side}
              style={toolbar.style}
              onKeyDown={handleToolbarKeyDown}
              onMouseEnter={showHover}
              onMouseLeave={hideHoverSoon}
            >
              <span className="zxe-formula-icon" aria-hidden="true">
                ∑
              </span>
              <span className="zxe-formula-title">公式</span>
              <span className="zxe-formula-mode" data-formula="mode">
                {result.display === 'inline' ? '行内' : '块级'}
              </span>
              <div className="zxe-formula-actions">
                {readOnly || isEditing ? null : (
                  <button
                    type="button"
                    className="zxe-formula-action"
                    data-formula="edit"
                    title="编辑公式源"
                    onClick={startEditing}
                  >
                    编辑公式
                  </button>
                )}
                {isEditing ? (
                  <OverflowMenu
                    label="公式模板"
                    triggerTitle="插入公式模板"
                    triggerContent="模板 ▾"
                    triggerClassName="zxe-formula-action"
                    focusOnOpen="keyboard"
                    returnFocusRef={textareaRef}
                    preservePointerFocus
                    onOpenChange={handleTemplateMenuOpenChange}
                    items={TEMPLATES.map((template) => ({
                      id: `template-${template.label}`,
                      label: template.label,
                      onSelect: () => insertTemplate(template.source),
                    }))}
                  />
                ) : null}
                {isEditing ? (
                  <button
                    type="button"
                    className="zxe-formula-action is-on"
                    data-formula="done"
                    title="完成公式编辑"
                    onClick={() => finishEditing(true)}
                  >
                    完成
                  </button>
                ) : null}
                <OverflowMenu
                  label="更多公式选项"
                  triggerTitle="复制、切换、缩放与导出"
                  triggerClassName="zxe-formula-action"
                  onOpenChange={handleMoreMenuOpenChange}
                  items={menuItems}
                />
              </div>
            </div>,
            getFloatingLayer() ?? document.body,
          )
        : null}

      <div
        ref={previewRef}
        className={`zxe-formula-preview${
          result.display === 'inline' ? ' is-inline' : ''
        }`}
        style={zoomStyle}
        aria-label="公式预览"
        onClick={handlePreviewClick}
      >
        {previewContent}
      </div>

      {isEditing ? (
        <div className="zxe-formula-source">
          <textarea
            ref={textareaRef}
            id={textareaId}
            className="zxe-formula-input"
            aria-label="LaTeX 源"
            aria-invalid={result.status === 'error'}
            aria-describedby={
              result.status === 'error' ? errorId : undefined
            }
            value={formula.latex}
            placeholder="输入 LaTeX，例如 \frac{a}{b}"
            rows={Math.min(8, Math.max(2, formula.latex.split('\n').length))}
            spellCheck={false}
            onChange={(event) => {
              onChangeLatex(event.target.value);
              bumpCaret();
            }}
            onClick={bumpCaret}
            onKeyUp={bumpCaret}
            onSelect={bumpCaret}
            onScroll={bumpCaret}
            onPaste={insertPastedSource}
          />
        </div>
      ) : null}

      {isEditing && result.status === 'error' ? (
        <div className="zxe-formula-error" role="alert" id={errorId}>
          <span className="zxe-formula-error-icon" aria-hidden="true">
            !
          </span>
          <div className="zxe-formula-error-body">
            <code className="zxe-formula-error-message">{result.message}</code>
            {result.line !== null && result.column !== null ? (
              <p className="zxe-formula-error-pos">
                位置：第 {result.line} 行第 {result.column} 列
                {result.position !== null
                  ? `（字符 ${result.position + 1}）`
                  : ''}
              </p>
            ) : null}
            {result.excerpt ? (
              <pre className="zxe-formula-error-excerpt">
                {`${result.excerpt}\n${result.caret}`}
              </pre>
            ) : null}
          </div>
        </div>
      ) : null}

      {isEditing ? (
        <div className="zxe-formula-foot">
          <span className="zxe-formula-state" data-formula-state>
            {statusText}
          </span>
          <span className="zxe-formula-zoom-value" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <span className="zxe-formula-version">
            KaTeX {katex.version} · 离线
          </span>
        </div>
      ) : null}

      <span className="zx-visually-hidden" role="status" aria-live="polite">
        {copyState === 'copied'
          ? '已复制 LaTeX'
          : copyState === 'error'
            ? '复制失败'
            : ''}
      </span>

      <Modal
        open={exportOpen}
        title="导出公式"
        description="LaTeX、Markdown 与 HTML 共用同一份源；HTML 使用 KaTeX 离线渲染结果（含 MathML），解析错误只给占位，不把源码当正文。"
        onClose={() => setExportOpen(false)}
        closeLabel="关闭公式导出"
        footer={
          <>
            <button
              type="button"
              className="settings-button settings-button--primary"
              onClick={() => {
                void handleCopyExport();
              }}
              disabled={exportCopyState === 'copied'}
            >
              {exportCopyState === 'copied'
                ? '已复制'
                : exportCopyState === 'error'
                  ? '复制失败'
                  : '复制'}
            </button>
            <button
              type="button"
              className="settings-button"
              onClick={() => setExportOpen(false)}
            >
              关闭
            </button>
          </>
        }
      >
        <div
          className="zxe-formula-export-tabs"
          role="tablist"
          aria-label="公式导出格式"
        >
          {EXPORT_TABS.map((tab) => (
            <button
              type="button"
              key={tab.id}
              role="tab"
              data-fetab={tab.id}
              aria-selected={exportTab === tab.id}
              className={exportTab === tab.id ? 'is-on' : ''}
              onClick={() => {
                setExportTab(tab.id);
                setExportCopyState('idle');
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <pre
          className="zxe-formula-export-text"
          role="tabpanel"
          aria-label={`${exportLabel} 内容`}
          data-fepre
        >
          {exportText || '（空）'}
        </pre>
        <p className="zxe-formula-export-note">
          HTML 含 KaTeX 视觉层与 MathML，可脱离在线 CDN 直接嵌入文档；
          Markdown 只保留 LaTeX 源，阅读端需支持 $…$ / $$…$$。
          解析错误时只导出可见占位与注释，不输出源码。
        </p>
      </Modal>
    </div>
  );
}
