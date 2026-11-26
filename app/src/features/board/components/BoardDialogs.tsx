import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import {
  FocusTrap,
  getFocusableElements,
} from '../../../app/a11y/FocusTrap';
import {
  BOARD_JSON_MAX_BYTES,
  BOARD_STARTERS,
  MORE_OBJECT_TYPES,
  OBJECT_TYPE_LABELS,
  STARTER_GROUPS,
  boardDocumentJson,
  parseBoardDocumentFile,
  starterPreview,
  type BoardDocumentError,
  type ParsedBoardDocumentFile,
  type StarterPreview,
  type StarterPreviewEdge,
  type StarterPreviewNode,
} from '../model';
import type {
  BoardDocument,
  BoardObjectType,
  BoardStarterKind,
  BoardViewport,
} from '../types';
import {
  BOARD_JSON_ACCEPT,
  boardJsonFileBlob,
  defaultBoardJsonFileName,
} from '../export/json';
import { saveBoardJsonWithDialog } from '../export/save';
import {
  BOARD_PACKAGE_IMPORT_ACCEPT,
  BOARD_PACKAGE_MAX_BYTES,
  parseBoardPackage,
  saveBoardPackageToFile,
  type BoardPackageSaver,
  type BoardPackageThumbnailRenderer,
  type ParsedBoardPackage,
} from '../export/package';
import { saveBlobWithDialog, type SaveResult } from '../../attachments/fileActions';

export type ModalProps = {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  /** 固定底部操作栏；不随 body 滚动。 */
  footer?: ReactNode;
  wide?: boolean;
  /** 导出/导入进行中：关闭 X、backdrop 与 Escape 全部失效。 */
  busy?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
};

function canReceiveFocus(element: HTMLElement | null): element is HTMLElement {
  return Boolean(
    element &&
      element.isConnected &&
      !element.hasAttribute('disabled') &&
      element.getAttribute('aria-disabled') !== 'true' &&
      element.tabIndex !== -1,
  );
}

/**
 * 画板弹窗外壳。
 *
 * 通过 portal 挂到 body，避免画布/检查器/工具栏的 stacking context 把
 * `position:fixed` 遮罩裁掉或压住；焦点、Tab 循环与 Escape 复用全局
 * FocusTrap，关闭后焦点回到触发按钮。底部操作栏单独成段，body 自己滚动。
 */
export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  wide,
  busy = false,
  initialFocusRef,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const focusHandledRef = useRef(false);
  // 父组件每次渲染都可能传新 onClose；用 ref 保证 Esc/遮罩拿到最新回调。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      focusHandledRef.current = false;
      return;
    }
    // 只在 open 由 false 变 true 时聚焦一次。父组件重渲染（主题、滚动
    // 状态等）不应重新聚焦首项，否则浏览器会把弹窗滚回顶部。
    if (!focusHandledRef.current) {
      focusHandledRef.current = true;
      const preferred = initialFocusRef?.current ?? null;
      const target =
        (canReceiveFocus(preferred) ? preferred : null) ??
        getFocusableElements(bodyRef.current).find(
          (element) => !element.classList.contains('bw-modal-close'),
        ) ??
        getFocusableElements(footerRef.current)[0] ??
        dialogRef.current;
      target?.focus({ preventScroll: true });
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [initialFocusRef, open]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="bw-modal-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        // 不要等到 click：拖拽结束落到遮罩上不应误触发背景按钮。
        event.preventDefault();
        if (!busy) {
          onCloseRef.current();
        }
      }}
    >
      <FocusTrap
        active={open}
        autoFocus={false}
        onEscape={busy ? undefined : onClose}
        className="bw-modal-shell"
      >
        <div
          ref={dialogRef}
          className={[
            'bw-modal',
            wide ? 'bw-modal-wide' : '',
            busy ? 'is-busy' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          aria-busy={busy || undefined}
          tabIndex={-1}
        >
          <div className="bw-modal-head">
            <div>
              <h2 id={titleId}>{title}</h2>
              {description ? <p id={descriptionId}>{description}</p> : null}
            </div>
            <button
              type="button"
              className="bw-modal-close"
              aria-label="关闭"
              onClick={onClose}
              disabled={busy}
            >
              ×
            </button>
          </div>
          <div ref={bodyRef} className="bw-modal-body">
            {children}
          </div>
          {footer ? (
            <div ref={footerRef} className="bw-modal-foot">
              {footer}
            </div>
          ) : null}
        </div>
      </FocusTrap>
    </div>,
    document.body,
  );
}

export type StarterDialogProps = {
  open: boolean;
  onClose: () => void;
  onInsert: (kind: BoardStarterKind) => void;
  hasContent: boolean;
};

function previewAnchor(
  node: StarterPreviewNode,
  side: StarterPreviewEdge['fromSide'],
): { x: number; y: number } {
  switch (side) {
    case 'l':
      return { x: node.x, y: node.y + node.height / 2 };
    case 'r':
      return { x: node.x + node.width, y: node.y + node.height / 2 };
    case 't':
      return { x: node.x + node.width / 2, y: node.y };
    case 'b':
      return { x: node.x + node.width / 2, y: node.y + node.height };
  }
}

function previewDirection(side: StarterPreviewEdge['fromSide']): { x: number; y: number } {
  switch (side) {
    case 'l':
      return { x: -1, y: 0 };
    case 'r':
      return { x: 1, y: 0 };
    case 't':
      return { x: 0, y: -1 };
    case 'b':
      return { x: 0, y: 1 };
  }
}

function previewEdgePath(
  edge: StarterPreviewEdge,
  nodes: ReadonlyArray<StarterPreviewNode>,
): string {
  const from = nodes.find((node) => node.key === edge.from);
  const to = nodes.find((node) => node.key === edge.to);
  if (!from || !to) {
    return '';
  }
  const a = previewAnchor(from, edge.fromSide);
  const b = previewAnchor(to, edge.toSide);
  if (edge.routing === 'straight') {
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  }
  if (edge.routing === 'elbow') {
    if (edge.fromSide === 'l' || edge.fromSide === 'r') {
      const midX = (a.x + b.x) / 2;
      return `M ${a.x} ${a.y} L ${midX} ${a.y} L ${midX} ${b.y} L ${b.x} ${b.y}`;
    }
    const midY = (a.y + b.y) / 2;
    return `M ${a.x} ${a.y} L ${a.x} ${midY} L ${b.x} ${midY} L ${b.x} ${b.y}`;
  }
  const distance = Math.max(36, Math.hypot(b.x - a.x, b.y - a.y) * 0.4);
  const da = previewDirection(edge.fromSide);
  const db = previewDirection(edge.toSide);
  return [
    `M ${a.x} ${a.y}`,
    `C ${a.x + da.x * distance} ${a.y + da.y * distance},`,
    `${b.x + db.x * distance} ${b.y + db.y * distance},`,
    `${b.x} ${b.y}`,
  ].join(' ');
}

function polygonPoints(points: ReadonlyArray<[number, number]>): string {
  return points.map(([x, y]) => `${x},${y}`).join(' ');
}

function StarterThumbShape({ node }: { node: StarterPreviewNode }) {
  const style = {
    fill: node.style.fill,
    stroke: node.style.stroke,
    opacity: node.style.opacity,
  };
  const strokeWidth = 1.2;
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  switch (node.type) {
    case 'ellipse':
      return (
        <ellipse
          cx={cx}
          cy={cy}
          rx={node.width / 2}
          ry={node.height / 2}
          style={style}
          strokeWidth={strokeWidth}
        />
      );
    case 'diamond':
      return (
        <polygon
          points={polygonPoints([
            [cx, node.y],
            [node.x + node.width, cy],
            [cx, node.y + node.height],
            [node.x, cy],
          ])}
          style={style}
          strokeWidth={strokeWidth}
        />
      );
    case 'triangle':
      return (
        <polygon
          points={polygonPoints([
            [cx, node.y],
            [node.x + node.width, node.y + node.height],
            [node.x, node.y + node.height],
          ])}
          style={style}
          strokeWidth={strokeWidth}
        />
      );
    case 'hexagon': {
      const inset = node.width * 0.22;
      return (
        <polygon
          points={polygonPoints([
            [node.x + inset, node.y],
            [node.x + node.width - inset, node.y],
            [node.x + node.width, cy],
            [node.x + node.width - inset, node.y + node.height],
            [node.x + inset, node.y + node.height],
            [node.x, cy],
          ])}
          style={style}
          strokeWidth={strokeWidth}
        />
      );
    }
    case 'parallelogram': {
      const offset = node.width * 0.2;
      return (
        <polygon
          points={polygonPoints([
            [node.x + offset, node.y],
            [node.x + node.width, node.y],
            [node.x + node.width - offset, node.y + node.height],
            [node.x, node.y + node.height],
          ])}
          style={style}
          strokeWidth={strokeWidth}
        />
      );
    }
    case 'text':
      // 缩略图不放大段文字，用一条低对比度色块表示“这里有文字”。
      return (
        <rect
          x={node.x}
          y={node.y + node.height * 0.32}
          width={node.width}
          height={Math.max(3, node.height * 0.32)}
          rx={1.5}
          style={{ fill: 'var(--board-text)', opacity: 0.24 }}
        />
      );
    default: {
      const radius = Math.min(
        node.style.radius,
        node.width / 2,
        node.height / 2,
      );
      return (
        <rect
          x={node.x}
          y={node.y}
          width={node.width}
          height={node.height}
          rx={radius}
          style={style}
          strokeWidth={strokeWidth}
          strokeDasharray={node.type === 'frame' ? '5 3' : undefined}
        />
      );
    }
  }
}

function StarterThumb({ preview }: { preview: StarterPreview }) {
  const padding = 10;
  const { bounds } = preview;
  const viewBox = [
    bounds.x - padding,
    bounds.y - padding,
    bounds.width + padding * 2,
    bounds.height + padding * 2,
  ].join(' ');
  return (
    <span className="bw-starter-preview" aria-hidden="true">
      <svg
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="presentation"
        focusable="false"
      >
        {preview.edges.map((edge, index) => (
          <path
            key={`edge-${index}`}
            d={previewEdgePath(edge, preview.nodes)}
            fill="none"
            strokeWidth={1.4}
            strokeLinecap="round"
            style={{ stroke: edge.color }}
          />
        ))}
        {preview.nodes.map((node) => (
          <StarterThumbShape key={node.key} node={node} />
        ))}
      </svg>
    </span>
  );
}

function starterCountLabel(preview: StarterPreview): string {
  const objects = `${preview.nodes.length} 个对象`;
  return preview.edges.length > 0
    ? `${objects} · ${preview.edges.length} 条连线`
    : objects;
}

/** 与 board.css 里把模板网格收成单列的断点保持一致。 */
const STARTER_SINGLE_COLUMN_QUERY = '(max-width: 860px)';

/**
 * 键盘上下移动要按实际列数走。优先读真实布局（桌面 2 列、窄屏 1 列），
 * 布局尚未生成时（例如 jsdom）退回与 CSS 断点一致的宽度判断。
 */
function starterColumnCount(grid: Element | null): number {
  if (!grid) {
    return 2;
  }
  const template =
    typeof window !== 'undefined' &&
    typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(grid).gridTemplateColumns.trim()
      : '';
  if (template && template !== 'none') {
    const repeat = template.match(/^repeat\(\s*(\d+)\s*,/);
    if (repeat) {
      return Number(repeat[1]);
    }
    const tracks = template.split(/\s+/).filter(Boolean).length;
    if (tracks > 0) {
      return tracks;
    }
  }
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
  ) {
    return window.matchMedia(STARTER_SINGLE_COLUMN_QUERY).matches ? 1 : 2;
  }
  return 2;
}

export function StarterDialog({
  open,
  onClose,
  onInsert,
  hasContent,
}: StarterDialogProps) {
  const firstRef = useRef<HTMLButtonElement>(null);
  const groupsRef = useRef<HTMLDivElement>(null);
  // 弹窗关闭后 DOM 会卸载，滚动位置需要自己记住，重新打开时恢复。
  const scrollTopRef = useRef(0);
  const groupId = useId();
  const previews = useMemo(
    () =>
      new Map<BoardStarterKind, StarterPreview>(
        BOARD_STARTERS.map((template) => [
          template.kind,
          starterPreview(template.kind),
        ]),
      ),
    [],
  );

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const scroller = groupsRef.current?.closest<HTMLElement>('.bw-modal-body');
    if (!scroller) {
      return;
    }
    scroller.scrollTop = scrollTopRef.current;
    const recordScroll = () => {
      scrollTopRef.current = scroller.scrollTop;
    };
    scroller.addEventListener('scroll', recordScroll, { passive: true });
    return () => {
      // 关闭前再记一次；节点已脱离文档时读到 0，不覆盖已记录的位置。
      scrollTopRef.current = scroller.scrollTop || scrollTopRef.current;
      scroller.removeEventListener('scroll', recordScroll);
    };
  }, [open]);

  const moveCardFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Home',
      'End',
    ];
    if (!keys.includes(event.key)) {
      return;
    }
    const cards = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '.bw-starter-card',
      ),
    );
    const active = document.activeElement as HTMLButtonElement | null;
    const index = active ? cards.indexOf(active) : -1;
    if (index < 0) {
      return;
    }
    event.preventDefault();
    const grid =
      active?.closest('.bw-starter-grid') ??
      event.currentTarget.querySelector('.bw-starter-grid');
    const columns = starterColumnCount(grid);
    let next = index;
    if (event.key === 'ArrowRight') {
      next = index + 1;
    } else if (event.key === 'ArrowLeft') {
      next = index - 1;
    } else if (event.key === 'ArrowDown') {
      next = index + columns;
    } else if (event.key === 'ArrowUp') {
      next = index - columns;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = cards.length - 1;
    }
    const target = cards[Math.min(cards.length - 1, Math.max(0, next))];
    // preventScroll + nearest：只把目标卡片带进视口，不把整个弹窗跳回顶部。
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const firstKind = BOARD_STARTERS[0]?.kind;
  return (
    <Modal
      open={open}
      title="起步结构"
      description={
        hasContent
          ? '插入一组可继续编辑的普通对象与连线，放在现有内容下方。'
          : '插入一组可继续编辑的普通对象与连线；不是模式或固定模板。'
      }
      onClose={onClose}
      initialFocusRef={firstRef}
      wide
      footer={
        <div className="bw-modal-actions">
          <button type="button" className="bw-button" onClick={onClose}>
            取消
          </button>
        </div>
      }
    >
      <div
        ref={groupsRef}
        className="bw-starter-groups"
        onKeyDown={moveCardFocus}
      >
        {STARTER_GROUPS.map((group) => {
          const templates = BOARD_STARTERS.filter(
            (template) => template.group === group.id,
          );
          if (templates.length === 0) {
            return null;
          }
          const headingId = `${groupId}-${group.id}`;
          return (
            <section
              key={group.id}
              className="bw-starter-group"
              role="group"
              aria-labelledby={headingId}
            >
              <h3 id={headingId}>{group.title}</h3>
              <div className="bw-starter-grid">
                {templates.map((template) => {
                  const preview = previews.get(template.kind);
                  return (
                    <button
                      key={template.kind}
                      ref={template.kind === firstKind ? firstRef : undefined}
                      type="button"
                      className="bw-starter-card"
                      onClick={() => {
                        onInsert(template.kind);
                      }}
                    >
                      {preview ? <StarterThumb preview={preview} /> : null}
                      <span className="bw-starter-card-title">
                        <strong>{template.title}</strong>
                        <span className="bw-starter-count">
                          {preview ? starterCountLabel(preview) : ''}
                        </span>
                      </span>
                      <small>{template.description}</small>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <p className="bw-starter-hint">
        插入位置：现有内容下方 · 一次插入记为一步撤销
      </p>
    </Modal>
  );
}

export type ShapesDialogProps = {
  open: boolean;
  onClose: () => void;
  onInsert: (type: BoardObjectType) => void;
};

export function ShapesDialog({ open, onClose, onInsert }: ShapesDialogProps) {
  const firstRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open={open}
      title="更多形状"
      description="插入后可拖动、连线、改色；右侧检查器继续编辑。"
      onClose={onClose}
      initialFocusRef={firstRef}
      footer={
        <div className="bw-modal-actions">
          <button type="button" className="bw-button" onClick={onClose}>
            取消
          </button>
        </div>
      }
    >
      <div className="bw-shape-grid">
        {MORE_OBJECT_TYPES.map((type, index) => (
          <button
            key={type}
            ref={index === 0 ? firstRef : undefined}
            type="button"
            className="bw-shape-card"
            onClick={() => onInsert(type)}
          >
            <span aria-hidden="true">
              {type === 'diamond'
                ? '◇'
                : type === 'triangle'
                  ? '△'
                  : type === 'hexagon'
                    ? '⬡'
                    : type === 'pill'
                      ? '▬'
                      : '▱'}
            </span>
            <small>{OBJECT_TYPE_LABELS[type]}</small>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export type BoardImportMode = 'replace' | 'create';

/** 画板弹窗的两个层级：普通用户包入口 vs 开发者调试入口。 */
export type BoardIOTab = 'package' | 'json';

export type JsonDialogProps = {
  open: boolean;
  document: BoardDocument;
  readOnly?: boolean;
  /** 当前视图；导出时写入源文件，导入时用于恢复。 */
  viewport?: BoardViewport | null;
  /** 默认导入策略；空白嵌入块没有当前画板时默认新建。 */
  defaultMode?: BoardImportMode;
  /** 没有当前画板时禁止“替换当前画板”。 */
  allowReplace?: boolean;
  /** 打开时定位的 tab；默认画板包，开发者 JSON 仅在测试/显式调用时直达。 */
  defaultTab?: BoardIOTab;
  onClose: () => void;
  onApply: (json: string, mode: BoardImportMode) => void | Promise<void>;
  /**
   * `.zxboard` 画板包导入入口。画板包与 JSON 共用预览/模式选择，但包内
   * 还带 viewport 与 manifest 元数据，因此单独回调，由页面负责重映射与落库。
   */
  onApplyDocument?: (
    document: BoardDocument,
    viewport: BoardViewport | null,
    mode: BoardImportMode,
  ) => void | Promise<void>;
  onStatus: (message: string) => void;
  /** 测试注入：保存面板与时钟。 */
  saveJson?: (blob: Blob, fileName: string) => Promise<SaveResult>;
  savePackage?: BoardPackageSaver;
  renderThumbnail?: BoardPackageThumbnailRenderer;
  now?: () => Date;
};

type JsonPreview = {
  file: ParsedBoardDocumentFile | null;
  error: string | null;
};

function parsePreview(text: string): JsonPreview {
  if (!text.trim()) {
    return { file: null, error: null };
  }
  try {
    return { file: parseBoardDocumentFile(text), error: null };
  } catch (reason) {
    return {
      file: null,
      error: reason instanceof Error ? reason.message : '画板 JSON 无法解析',
    };
  }
}

function fileNameOf(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }
  return path.split(/[\\/]/).pop() ?? null;
}

/**
 * 判断导入内容是否与当前画板相同。比较用户可见内容（标题/背景/对象/
 * 连线/视图），忽略 boardId、noteId 与导出时间——它们导入后本来就会
 * 重新生成。相同内容再“导入自己”是空操作，应禁用应用按钮。
 */
function sameBoardContent(
  document: BoardDocument,
  viewport: BoardViewport | null,
  imported: { document: BoardDocument; viewport: BoardViewport | null },
): boolean {
  const projection = (doc: BoardDocument, view: BoardViewport | null) =>
    JSON.stringify({
      title: doc.title,
      background: doc.background,
      nodes: doc.nodes,
      edges: doc.edges,
      viewport: view,
    });
  return (
    projection(document, viewport) ===
    projection(imported.document, imported.viewport)
  );
}

async function isZipFile(file: File): Promise<boolean> {
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return (
    header.length === 4 &&
    header[0] === 0x50 &&
    header[1] === 0x4b &&
    (header[2] === 0x03 || header[2] === 0x05)
  );
}

export function JsonDialog({
  open,
  document,
  readOnly = false,
  viewport = null,
  defaultMode = 'replace',
  allowReplace = true,
  defaultTab = 'package',
  onClose,
  onApply,
  onApplyDocument,
  onStatus,
  saveJson = saveBoardJsonWithDialog,
  savePackage = saveBlobWithDialog,
  renderThumbnail,
  now,
}: JsonDialogProps) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<JsonPreview>({
    file: null,
    error: null,
  });
  const [tab, setTab] = useState<BoardIOTab>(defaultTab);
  const [packagePreview, setPackagePreview] =
    useState<ParsedBoardPackage | null>(null);
  const [packageError, setPackageError] = useState<string | null>(null);
  const [packageMessage, setPackageMessage] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<BoardImportMode>(defaultMode);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<'export' | 'package' | 'apply' | null>(null);
  // 状态更新是异步的；用 ref 同步挡住同一 tick 内的重复点击/重复提交。
  const busyRef = useRef<'export' | 'package' | 'apply' | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const packageTabRef = useRef<HTMLButtonElement>(null);
  const jsonTabRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickerTabRef = useRef<BoardIOTab | null>(null);
  const tabsId = useId();
  const packagePanelId = `${tabsId}-package`;
  const jsonPanelId = `${tabsId}-json`;

  const beginBusy = useCallback((kind: 'export' | 'package' | 'apply') => {
    if (busyRef.current !== null) {
      return false;
    }
    busyRef.current = kind;
    setBusy(kind);
    return true;
  }, []);

  const endBusy = useCallback(() => {
    busyRef.current = null;
    setBusy(null);
  }, []);

  const clock = useCallback(() => now?.() ?? new Date(), [now]);

  // 「查看当前画板 JSON」用只读投影；不写入编辑区，避免打开即可“导入自己”。
  const currentJson = useMemo(
    () =>
      boardDocumentJson(document, {
        viewport,
        exportedAt: clock().toISOString(),
      }),
    [clock, document, viewport],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    // 开发者入口初始为空：必须先粘贴/选择文件，才可能启用「应用导入」。
    setText('');
    setPreview({ file: null, error: null });
    setTab(defaultTab);
    setPackagePreview(null);
    setPackageError(null);
    setPackageMessage(null);
    setStrategy(defaultMode);
    setConfirming(false);
    setError(null);
    setMessage(null);
    busyRef.current = null;
    setBusy(null);
    // 只在打开时重置；编辑 textarea 不应被外部 document 变化覆盖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const refreshText = (value: string) => {
    setText(value);
    setPreview(parsePreview(value));
    // 手动编辑/读取 JSON 后，导入来源切回 JSON，避免“看起来是包、实际用 JSON”。
    setPackagePreview(null);
    setPackageError(null);
    setPackageMessage(null);
    setConfirming(false);
    setError(null);
    setMessage(null);
  };

  const importedJson = preview.file;
  const sameAsCurrent =
    importedJson !== null &&
    preview.error === null &&
    sameBoardContent(document, viewport, importedJson);

  const canApply =
    !readOnly &&
    busy === null &&
    !confirming &&
    packageError === null &&
    (packagePreview !== null ||
      (importedJson !== null && preview.error === null && !sameAsCurrent));

  const openFilePicker = (target: BoardIOTab) => {
    if (readOnly || busyRef.current !== null) {
      return;
    }
    pickerTabRef.current = target;
    setTab(target);
    // 等一帧让 accept/aria-label 切到目标 tab，再触发系统选择器。
    window.setTimeout(() => fileRef.current?.click(), 0);
  };

  const handleExport = async () => {
    if (!beginBusy('export')) {
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const at = clock();
      const fileName = defaultBoardJsonFileName(document.title, at);
      const blob = boardJsonFileBlob(document, { viewport, now: at });
      const result = await saveJson(blob, fileName);
      if (result.status === 'canceled') {
        setMessage('已取消导出，未写入文件。');
        return;
      }
      const savedName = fileNameOf(result.path) ?? fileName;
      const status = `已导出画板 JSON：${savedName}`;
      setMessage(status);
      onStatus(status);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '导出画板 JSON 失败',
      );
    } finally {
      endBusy();
    }
  };

  const handleExportPackage = async () => {
    if (!beginBusy('package')) {
      return;
    }
    setError(null);
    setPackageError(null);
    setMessage(null);
    setPackageMessage(null);
    try {
      const at = clock();
      const result = await saveBoardPackageToFile(
        {
          document,
          viewport,
          now: at,
          renderThumbnail,
        },
        savePackage,
      );
      if (result.status === 'canceled') {
        setPackageMessage('已取消导出画板包，未写入文件。');
        return;
      }
      const summary = `已导出画板包：${result.actualFileName}（${document.nodes.length} 个对象 · ${document.edges.length} 条连线${
        result.report.thumbnailIncluded ? ' · 含缩略图' : ' · 无缩略图'
      }）`;
      setPackageMessage(
        result.report.warnings.length > 0
          ? `${summary}；${result.report.warnings.join('；')}`
          : summary,
      );
      onStatus(summary);
    } catch (reason) {
      setPackageError(
        reason instanceof Error ? reason.message : '导出画板包失败',
      );
    } finally {
      endBusy();
    }
  };

  const readPackageFile = async (file: File) => {
    if (!beginBusy('package')) {
      return;
    }
    setPackageError(null);
    setPackageMessage(null);
    setError(null);
    setMessage(null);
    setConfirming(false);
    try {
      if (file.size > BOARD_PACKAGE_MAX_BYTES) {
        throw new Error('画板包超过 64 MiB 上限，无法导入');
      }
      if (!(await isZipFile(file))) {
        throw new Error(
          '这不是知行画板包（.zxboard）。JSON 文件请切换到「开发者 · JSON」导入。',
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await parseBoardPackage(bytes, { fileName: file.name });
      setPackagePreview(parsed);
      setPackageError(null);
      setPackageMessage(null);
      // 包预览优先；清空 JSON 预览，避免两套内容同时可点“应用导入”。
      setText('');
      setPreview({ file: null, error: null });
    } catch (reason) {
      setPackagePreview(null);
      setPackageError(
        reason instanceof Error ? reason.message : '读取画板包失败',
      );
    } finally {
      endBusy();
    }
  };

  const readJsonFile = async (file: File) => {
    if (file.size > BOARD_JSON_MAX_BYTES) {
      setPreview({
        file: null,
        error: '画板 JSON 超过 10 MiB 上限，无法导入',
      });
      setConfirming(false);
      setError(null);
      return;
    }
    try {
      if (await isZipFile(file)) {
        setPreview({
          file: null,
          error: '这是画板包（ZIP）。请切换到「画板包 .zxboard」导入。',
        });
        setConfirming(false);
        setError(null);
        setPackageError(null);
        return;
      }
      refreshText(await file.text());
    } catch {
      setPreview({ file: null, error: '读取文件失败' });
      setConfirming(false);
    }
  };

  const handleFile = async (file: File, target: BoardIOTab) => {
    if (busyRef.current !== null) {
      return;
    }
    if (target === 'package') {
      await readPackageFile(file);
      return;
    }
    await readJsonFile(file);
  };

  const startApply = () => {
    if (!canApply || busyRef.current !== null) {
      return;
    }
    setError(null);
    setMessage(null);
    setConfirming(true);
  };

  const confirmApply = async () => {
    if (readOnly || !beginBusy('apply')) {
      return;
    }
    if (!packagePreview && !preview.file) {
      endBusy();
      return;
    }
    setError(null);
    try {
      if (packagePreview) {
        if (!onApplyDocument) {
          throw new Error('当前画板不支持导入画板包');
        }
        await onApplyDocument(
          packagePreview.document,
          packagePreview.viewport,
          activeStrategy,
        );
      } else {
        await onApply(text, activeStrategy);
      }
      setConfirming(false);
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : '画板文件无法应用',
      );
    } finally {
      endBusy();
    }
  };

  const copy = async (value: string, label = '画板 JSON') => {
    try {
      await navigator.clipboard.writeText(value);
      onStatus(`${label} 已复制`);
    } catch {
      onStatus('当前环境不能访问剪贴板；可手动选择 JSON 复制');
      if (value === text) {
        textareaRef.current?.focus();
        textareaRef.current?.select();
      }
    }
  };

  const imported = importedJson;
  // packageError 已在画板包区域用 role=alert 展示，预览区不再重复同一条错误。
  const errorText = preview.error ?? error;
  const activeStrategy: BoardImportMode = allowReplace ? strategy : 'create';
  const applyHint = canApply
    ? null
    : readOnly
      ? '阅读模式下不能导入；导出仍可用。'
      : busy !== null
        ? '正在处理，请稍候…'
        : packageError
          ? '当前画板包不可用，请重新选择。'
          : preview.error
            ? '当前文件不可用，请重新选择。'
            : sameAsCurrent
              ? '粘贴的 JSON 与当前画板内容相同，无需导入。'
              : !packagePreview && !imported
                ? '请先选择画板包，或在「开发者 · JSON」粘贴/选择有效 JSON。'
                : null;

  return (
    <Modal
      open={open}
      title="导入 / 导出画板"
      description="用户主路径是画板包 .zxboard；JSON 仅用于开发者/调试。导入会生成全新 ID，替换当前画布可撤销。"
      onClose={onClose}
      wide
      busy={busy !== null}
      initialFocusRef={defaultTab === 'json' ? jsonTabRef : packageTabRef}
      footer={
        <>
          {applyHint ? (
            <p className="bw-modal-foot-hint">{applyHint}</p>
          ) : null}
          <div className="bw-modal-actions">
            <button
              type="button"
              className="bw-button"
              onClick={onClose}
              disabled={busy !== null}
            >
              取消
            </button>
            <button
              type="button"
              className="bw-button is-primary"
              disabled={!canApply}
              onClick={startApply}
            >
              {busy === 'apply' ? '正在导入…' : '应用导入'}
            </button>
          </div>
        </>
      }
    >
      <div
        className="bw-segmented"
        role="tablist"
        aria-label="画板导入导出方式"
      >
        <button
          ref={packageTabRef}
          type="button"
          role="tab"
          id={`${tabsId}-tab-package`}
          aria-selected={tab === 'package'}
          aria-controls={packagePanelId}
          className={tab === 'package' ? 'is-active' : undefined}
          disabled={busy !== null}
          onClick={() => setTab('package')}
        >
          画板包 .zxboard（推荐）
        </button>
        <button
          ref={jsonTabRef}
          type="button"
          role="tab"
          id={`${tabsId}-tab-json`}
          aria-selected={tab === 'json'}
          aria-controls={jsonPanelId}
          className={tab === 'json' ? 'is-active' : undefined}
          disabled={busy !== null}
          onClick={() => setTab('json')}
        >
          开发者 · JSON{' '}
          <span className="bw-json-preview-meta" aria-hidden="true">
            调试
          </span>
        </button>
      </div>

      <section
        id={packagePanelId}
        role="tabpanel"
        aria-labelledby={`${tabsId}-tab-package`}
        hidden={tab !== 'package'}
        className="bw-json-package"
        aria-label="知行画板包"
      >
        <div className="bw-json-package-head">
          <strong>知行画板包 · .zxboard（推荐）</strong>
          <span>
            ZIP：manifest + board.json + 可选缩略图；完整保留对象、连线、视图、背景、锁定与样式。
            仅知行可导入，可无损往返。
          </span>
        </div>
        <div className="bw-modal-actions">
          <button
            type="button"
            className="bw-button is-primary"
            disabled={busy !== null}
            onClick={() => void handleExportPackage()}
          >
            {busy === 'package' ? '正在导出…' : '导出画板包…'}
          </button>
          <button
            type="button"
            className="bw-button"
            disabled={readOnly || busy !== null}
            onClick={() => openFilePicker('package')}
          >
            导入画板包…
          </button>
        </div>
        {packagePreview ? (
          <div className="bw-json-preview" aria-label="画板包预览">
            <p className="bw-json-preview-line">
              <strong>{packagePreview.manifest.board.title}</strong>
              {' · '}
              {packagePreview.document.nodes.length} 个对象 ·{' '}
              {packagePreview.document.edges.length} 条连线
            </p>
            <p className="bw-json-preview-meta">
              包类型 {packagePreview.manifest.kind} · formatVersion{' '}
              {packagePreview.manifest.formatVersion} · schemaVersion{' '}
              {packagePreview.manifest.schemaVersion} · 导出于{' '}
              {packagePreview.manifest.exportedAt}
              {packagePreview.thumbnail ? ' · 含缩略图' : ' · 无缩略图'}
            </p>
            <p className="bw-json-preview-meta">
              背景 {packagePreview.document.background}
              {packagePreview.viewport
                ? ` · 视图 ${Math.round(packagePreview.viewport.zoom * 100)}%`
                : ''}
              {' · '}包内文件：{packagePreview.files.join('、')}
            </p>
            {packagePreview.warnings.map((warning) => (
              <p key={warning} className="bw-json-preview-warning">
                {warning}
              </p>
            ))}
          </div>
        ) : null}
        {packageError ? (
          <p className="bw-modal-error" role="alert">
            {packageError}
          </p>
        ) : null}
        {packageMessage ? (
          <p className="bw-json-preview-meta" role="status">
            {packageMessage}
          </p>
        ) : null}
      </section>

      <section
        id={jsonPanelId}
        role="tabpanel"
        aria-labelledby={`${tabsId}-tab-json`}
        hidden={tab !== 'json'}
        aria-label="开发者 JSON"
      >
        <p className="bw-json-preview-meta" role="note">
          开发者/调试入口。普通备份与迁移请用 .zxboard；JSON 是知行内部
          schema，不是跨软件交换格式，也不保证跨版本兼容。
        </p>
        <details className="bw-json-preview">
          <summary>查看当前画板 JSON（只读）</summary>
          <textarea
            className="bw-json-textarea"
            aria-label="当前画板 JSON"
            value={currentJson}
            readOnly
            spellCheck={false}
          />
          <div className="bw-modal-actions">
            <button
              type="button"
              className="bw-button"
              onClick={() => void copy(currentJson, '当前画板 JSON')}
            >
              复制当前 JSON
            </button>
          </div>
        </details>
        <textarea
          ref={textareaRef}
          className="bw-json-textarea"
          aria-label="画板 JSON"
          placeholder="粘贴画板 JSON，或从文件导入 .json"
          value={text}
          spellCheck={false}
          readOnly={readOnly}
          onChange={(event) => refreshText(event.target.value)}
        />

        <div className="bw-json-preview" aria-label="导入预览">
          {errorText ? (
            <p className="bw-modal-error" role="alert">
              {errorText}
            </p>
          ) : imported ? (
            <>
              <p className="bw-json-preview-line">
                <strong>{imported.document.title}</strong>
                {' · '}
                {imported.document.nodes.length} 个对象 ·{' '}
                {imported.document.edges.length} 条连线 · version=1
              </p>
              <p className="bw-json-preview-meta">
                背景 {imported.document.background}
                {imported.viewport
                  ? ` · 视图 ${Math.round(imported.viewport.zoom * 100)}%`
                  : ''}
                {imported.metadata.exportedAt
                  ? ` · 导出于 ${imported.metadata.exportedAt}`
                  : ''}
              </p>
              {imported.warnings.map((warning) => (
                <p key={warning} className="bw-json-preview-warning">
                  {warning}
                </p>
              ))}
            </>
          ) : (
            <p className="bw-json-preview-meta">
              粘贴 JSON 或选择 .json 文件后显示导入预览。
            </p>
          )}
        </div>

        <div className="bw-modal-actions bw-json-dev-actions">
          <button
            type="button"
            className="bw-button"
            disabled={readOnly || busy !== null}
            onClick={() => openFilePicker('json')}
          >
            从文件导入 .json…
          </button>
          <button
            type="button"
            className="bw-button"
            disabled={!text.trim()}
            onClick={() => void copy(text, '画板 JSON')}
          >
            复制 JSON
          </button>
          <button
            type="button"
            className="bw-button"
            disabled={busy !== null}
            onClick={() => void handleExport()}
          >
            {busy === 'export' ? '正在导出…' : '导出 JSON…'}
          </button>
        </div>
      </section>

      <input
        ref={fileRef}
        type="file"
        accept={
          tab === 'package' ? BOARD_PACKAGE_IMPORT_ACCEPT : BOARD_JSON_ACCEPT
        }
        hidden
        disabled={readOnly}
        aria-label={
          tab === 'package' ? '选择画板包文件' : '选择画板 JSON 文件'
        }
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) {
            return;
          }
          void handleFile(file, pickerTabRef.current ?? tab);
          pickerTabRef.current = null;
          event.target.value = '';
        }}
      />

      {readOnly ? (
        <p className="bw-json-preview-meta" role="note">
          阅读模式下不能导入画板包或 JSON；导出仍可用。
        </p>
      ) : null}

      {(imported || packagePreview) && !readOnly ? (
        <fieldset className="bw-json-strategy">
          <legend>导入方式</legend>
          {allowReplace ? (
            <label>
              <input
                type="radio"
                name="bw-json-strategy"
                value="replace"
                checked={strategy === 'replace'}
                onChange={() => {
                  setStrategy('replace');
                  setConfirming(false);
                }}
              />
              替换当前画板（可撤销）
            </label>
          ) : null}
          <label>
            <input
              type="radio"
              name="bw-json-strategy"
              value="create"
              checked={activeStrategy === 'create'}
              onChange={() => {
                setStrategy('create');
                setConfirming(false);
              }}
            />
            导入为新画板
          </label>
        </fieldset>
      ) : null}

      {confirming ? (
        <div
          className="bw-json-confirm"
          role="group"
          aria-label="确认导入"
        >
          <p>
            {activeStrategy === 'replace'
              ? packagePreview
                ? '将用画板包内容替换当前画布；对象与连线会生成新 ID，可用 ⌘Z 撤销。'
                : '将替换当前画布内容；可用 ⌘Z 撤销。'
              : '将创建一个新画板，当前画板内容保持不变。'}
          </p>
          <div className="bw-modal-actions">
            <button
              type="button"
              className="bw-button"
              disabled={busy !== null}
              onClick={() => setConfirming(false)}
            >
              返回修改
            </button>
            <button
              type="button"
              className="bw-button is-primary"
              disabled={busy !== null}
              onClick={() => void confirmApply()}
            >
              {busy === 'apply'
                ? '正在导入…'
                : activeStrategy === 'replace'
                  ? '确认替换'
                  : '确认导入新画板'}
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p className="bw-json-preview-meta" role="status">
          {message}
        </p>
      ) : null}
    </Modal>
  );
}

export type BoardDocumentParseError = BoardDocumentError;

export function errorMessageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : '操作失败，请重试';
}
