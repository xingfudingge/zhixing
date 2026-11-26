/**
 * 知识工作区（P1-01）。
 *
 * 四区：目录树 / 笔记列表 / 编辑器 / 右侧工具轨 + 信息面板。
 * 生命周期：新建、标签页、收藏/置顶筛选、重命名、移动目录、软删除、
 * 回收站恢复、Markdown 导出（保留标题/列表/待办结构）。
 *
 * 禁区遵循：
 * - 删除入口只有右键/`···` 菜单和信息面板两处，没有悬浮删除按钮；
 * - 全部使用知行全局 token，没有第二套深色侧栏；
 * - 正文待办统一交给 NoteTodosWorkspace：正文块与文末汇总共用 `note_todos`，
 *   勾选/删除不镜像全局任务状态，也不在知识页另建第二套待办数据。
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { db, isTauriRuntime } from '../../data/db/client';
import type { ImportNoteInput, Note } from '../../data/db/types';
import {
  createBlockRepository,
  type BlockRepository,
  type EditorBlock,
} from '../../data/repositories/blocks';
import {
  buildNoteLinkGraph,
  createNoteRepository,
  htmlToPlainText,
  isTrashedNote,
  NOTE_FOLDERS,
  noteFolderName,
  sortNotes,
  toNoteUpdate,
  type NoteLinkDepth,
  type NoteLinkGraph,
  type NoteLinkGraphEdge,
  type NoteLinkGraphNode,
  type NotePatch,
  type NoteSource,
} from '../../data/repositories/notes';
import {
  createNoteTodoRepository,
  type NoteTodoRepository,
} from '../../data/repositories/noteTodos';
import {
  blocksToHtml,
  blocksToPlainText,
  createBlock,
  pastedBlocksFromHtml,
  runsToPlainText,
  type EditorActiveBlock,
  type EditorCommandHandle,
  type EditorHistoryAction,
  type EditorHistoryState,
  type KnownBlockType,
} from '../editor';
import { internalNoteIdsInText } from '../editor/security';
import {
  NoteTodosWorkspace,
  type NoteTodosTaskSource,
} from '../editor/todos';
import {
  blockBoard,
  blockFile,
  blockRuns,
  headingLevel,
} from '../editor/types';
import { createBoardSource } from '../board/source';
import type { BoardSource, BoardSummary } from '../board/types';
import { Modal } from '../../app/a11y';
import { Icon } from '../../ui/icons/Icon';
import type { IconName } from '../../ui/icons/icons';
import {
  AttachmentSection,
  describeAttachmentStatus,
  useAttachmentRuntime,
  type AttachmentManager,
  type AttachmentSyncMode,
  type AttachmentUploader,
  type StoredAttachment,
} from '../attachments';
import {
  loadNoteExportPreferences,
  noteExportFormatLabel,
  saveNoteExportPreferences,
  saveNoteExportToFile,
  summarizeNoteBlocks,
  type NoteExportFormat,
  type NoteExportSaveResult,
  type NotePdfPaper,
} from '../export/note';
import {
  notePackageBoardLoaderFromSource,
  saveNotePackageToFile,
  type NotePackageSaveResult,
} from '../export/note/package';
import { formatBytes } from '../export/utils';
import '../export/note/note-export.css';
import {
  NoteImportDialog,
  type NotePackageImportInput,
} from '../import/NoteImportDialog';
import {
  applyNotePackageImport,
  createNotePackageImportTarget,
  NotePackageImportError,
  planNotePackageImport,
} from '../import/notePackage';
import {
  EXECUTION_NOTES_CHANGED,
  extractTaskBacklink,
  taskBacklinkPath,
} from '../notes/createFromTask';
import {
  CommandBar,
  type CommandExportFormat,
} from './CommandBar';
import {
  ContextMenu,
  type ContextMenuCloseReason,
  type ContextMenuItem,
} from './contextMenu';
import { t, type MenuKey } from '../../i18n/menu';
import './knowledge.css';

export type KnowledgePageProps = {
  /** 测试注入；不传时使用真实 SQLite 客户端。 */
  source?: NoteSource;
  /** 块编辑器仓储；测试注入。不传时与笔记共用真实 SQLite 客户端。 */
  blockSource?: BlockRepository;
  /** 画板数据源；测试注入。「新建画板」需要真实 boards 记录。 */
  boardSource?: BoardSource;
  /** 笔记待办仓储；测试注入。正文待办与文末汇总共用这一份数据。 */
  noteTodoSource?: NoteTodoRepository;
  /** 关联任务/清单源；测试注入。只有用户显式关联时才写任务。 */
  taskSource?: NoteTodosTaskSource;
  /** 附件服务；测试或嵌入场景注入。不传时自动装配桌面运行时。 */
  attachmentManager?: AttachmentManager | null;
  attachmentUploader?: AttachmentUploader | null;
  /** manager 不可用时的可见原因。 */
  attachmentUnavailableReason?: string | null;
};

type LoadStatus = 'loading' | 'ready' | 'unavailable' | 'error';
type SaveState = 'saved' | 'saving' | 'error';
type NoteView =
  | 'all'
  | 'favorites'
  | 'pinned'
  | 'trash'
  | 'boards:orphan'
  | 'folder:uncategorized'
  | `folder:${string}`;

/** 孤儿画板关联/删除弹层；画板数据与笔记正文分开处理。 */
type BoardDialogState =
  | { kind: 'associate'; boardId: string }
  | { kind: 'delete'; boardId: string }
  | null;

function bodyReferencesBoard(body: string, boardId: string): boolean {
  return body.includes(`data-board-id="${boardId}"`);
}

type DialogState =
  | { kind: 'delete'; noteId: string }
  | { kind: 'rename'; noteId: string }
  | { kind: 'move'; noteId: string }
  | { kind: 'export'; noteId: string }
  | null;

type NoteExportChoice = NoteExportFormat | 'zxnote';

type SavedNoteExport =
  | Extract<NoteExportSaveResult, { status: 'saved' }>
  | Extract<NotePackageSaveResult, { status: 'saved' }>;

function exportResultLabel(format: NoteExportChoice): string {
  return format === 'zxnote' ? '知行笔记包' : noteExportFormatLabel(format);
}

const NOTE_EXPORT_FORMATS: ReadonlyArray<{
  value: NoteExportChoice;
  label: string;
  extension: string;
  description: string;
}> = [
  {
    value: 'docx',
    label: 'Word 文档',
    extension: '.docx',
    description: '可编辑，保留标题层级、表格、图片与编号；v1 仅导出，不支持回导。',
  },
  {
    value: 'pdf',
    label: 'PDF',
    extension: '.pdf',
    description: '适合打印/分享；文字为图像，不可选中。',
  },
  {
    value: 'md',
    label: 'Markdown',
    extension: '.md',
    description: '纯文本便于迁移，可回导；颜色/底色/列宽会丢失。',
  },
  {
    value: 'zxnote',
    label: '知行笔记包',
    extension: '.zxnote',
    description:
      '完整保留块顺序、画板与附件，可无损回导（上限 1 GiB）；仅知行可导入，不替代整库备份。',
  },
];

/**
 * 右栏工具对应的面板（ZX-NOTE-02 后工具轨为 9 项）。
 * `style` 复用编辑器内部的 StylePanel，其余在知识页渲染侧栏。
 */
type SidePanel =
  | 'style'
  | 'links'
  | 'outline'
  | 'info'
  | 'attachment'
  | null;

type PanelKind = Exclude<SidePanel, null>;

/**
 * 右栏面板按钮控制的浮层 id。四个信息面板共用 `kn-rail-flyout`（同一时刻
 * 只渲染一个），样式面板仍由编辑器内部的 `kn-style-panel` 承载。
 */
const RAIL_PANEL_CONTROLS: Partial<Record<PanelKind, string>> = {
  style: 'kn-style-panel',
  links: 'kn-rail-flyout',
  outline: 'kn-rail-flyout',
  info: 'kn-rail-flyout',
  attachment: 'kn-rail-flyout',
};

/** 命令栏「Aa」显示的当前块名称；不改变块类型。 */
const COMMAND_BLOCK_LABELS: Record<KnownBlockType, string> = {
  paragraph: '正文',
  heading1: 'H1',
  heading2: 'H2',
  heading3: 'H3',
  heading4: 'H4',
  heading5: 'H5',
  todo: '待办',
  bullet_list: '无序列表',
  ordered_list: '有序列表',
  quote: '引用',
  code: '代码',
  divider: '分割线',
  table: '表格',
  file: '文件',
  formula: '公式',
  board: '画板',
  link: '链接',
};

function commandBlockLabel(type: KnownBlockType | undefined): string {
  return type ? COMMAND_BLOCK_LABELS[type] ?? '正文' : '正文';
}

/**
 * jsdom/不支持的运行环境按宽屏处理，不把入口藏起来、也不误判为窄屏。
 * 断点只用于状态归一化；布局仍由 CSS 媒体查询负责，避免 JS/CSS 双真值。
 */
function useMediaQuery(query: string, fallback = false): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : fallback,
  );
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    ) {
      return;
    }
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, [query]);
  return matches;
}

/** ≤900 时右栏收起，命令栏出现「面板」菜单。 */
function useNarrowLayout(): boolean {
  return useMediaQuery('(max-width: 900px)');
}

/** ≤720 已无左树/列表可收，ESC 展开退化为 no-op。 */
function useExpandBlocked(): boolean {
  return useMediaQuery('(max-width: 720px)');
}

/** 编辑器自己的临时层：这些层打开时 Esc 归编辑器，知识页不抢。 */
const EDITOR_ESCAPE_LAYER_SELECTOR = [
  '.zxe-dialog-backdrop',
  '.zxe-menu',
  '.zxe-context-menu',
  '.zxe-stylepanel',
  '.zxe-formatbar',
  '.zxe-selectionbar',
  '.zxe-code-lang-menu',
  '.zxe-table-toolbar',
  '.zxe-formula-toolbar',
  '.zxe-overflow-menu',
].join(',');

/** 输入控件/公式/代码/表格单元格：Esc 由控件自己处理，不触发布局变化。 */
function ownsEscapeInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.closest('input, textarea, select, [contenteditable="true"]')) {
    return true;
  }
  return Boolean(
    target.closest(
      '.zxe-formula-source, .zxe-formula-input, .zxe-code-source, .zxe-code-lang-menu, .zxe-table-cell',
    ),
  );
}

function editorOwnsEscape(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  if (document.querySelector(EDITOR_ESCAPE_LAYER_SELECTOR)) {
    return true;
  }
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') {
    return false;
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode) {
    return false;
  }
  const anchor =
    selection.anchorNode instanceof Element
      ? selection.anchorNode
      : selection.anchorNode.parentElement;
  return Boolean(anchor?.closest('.zxe'));
}

/** 「笔记链接」面板的两个视图：关系列表与内链关系图。 */
type LinkPanelView = 'list' | 'graph';

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
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

/**
 * 真实状态查询完成前的兜底文案：只用于首帧，不把旧 pending 快照原样
 * 当成“待同步”。无附件引用的文件卡明确写“仅文件信息”。
 */
function fallbackFileStatusLabel(
  file: {
    attachmentId: string | null;
    status: 'local' | 'pending' | 'available' | 'missing';
  },
  mode: AttachmentSyncMode,
): string {
  if (!file.attachmentId) {
    return '仅文件信息';
  }
  if (file.status === 'pending') {
    return mode === 'local' ? '本机已保存' : '待同步';
  }
  if (file.status === 'available') {
    return mode === 'local' ? '本机已保存' : '已同步';
  }
  return file.status === 'missing' ? '文件缺失' : '本机已保存';
}

type TreeSystemView = 'all' | 'favorites' | 'pinned' | 'trash';

type TreeMenuTarget =
  | { kind: 'system'; view: TreeSystemView }
  | { kind: 'folder'; folderId: string | null; name: string }
  | { kind: 'blank' };

type MenuTarget =
  | { kind: 'note'; noteId: string }
  | { kind: 'tab'; noteId: string }
  | { kind: 'tree'; tree: TreeMenuTarget };

type MenuState = {
  target: MenuTarget;
  x: number;
  y: number;
  /** 菜单关闭后归还焦点的来源（行/标签/目录按钮）；可能已被卸载。 */
  trigger: HTMLElement | null;
  /** 指针打开保持焦点在来源；键盘打开聚焦第一项。 */
  focusOnOpen: boolean;
} | null;

type ToastState = {
  id: number;
  message: string;
  tone: 'ok' | 'error';
} | null;

function formatError(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  return '操作失败，请重试';
}

/**
 * 任务回链的兼容标记（`createFromTask` 生成）。
 *
 * 块编辑器没有 callout 块，但任务关联依赖 `notes.body` 里的 `data-task-*`。
 * 进入编辑器时把这段结构暂挂在正文之外（页面顶部已有来源任务条），
 * 同步 HTML 缓存时再原样带回，避免首次编辑丢任务关联。
 */
const TASK_CALLOUT_PATTERN =
  /<div\b[^>]*\bclass="[^"]*\bzx-task-backlink\b[^"]*"[^>]*>[\s\S]*?<\/div>/i;

function extractTaskCalloutHtml(body: string): string | null {
  return body.match(TASK_CALLOUT_PATTERN)?.[0] ?? null;
}

function withoutTaskCallout(body: string): string {
  return body.replace(TASK_CALLOUT_PATTERN, '');
}

function formatNoteDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 10);
  }
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function folderIdOfView(view: NoteView): string | null | undefined {
  if (view === 'folder:uncategorized') {
    return null;
  }
  if (view.startsWith('folder:')) {
    return view.slice('folder:'.length);
  }
  return undefined;
}

function notesForView(notes: ReadonlyArray<Note>, view: NoteView): Note[] {
  if (view === 'boards:orphan') {
    return [];
  }
  const active = notes.filter((note) => !isTrashedNote(note));
  if (view === 'trash') {
    return notes.filter(isTrashedNote);
  }
  if (view === 'favorites') {
    return active.filter((note) => note.favorite);
  }
  if (view === 'pinned') {
    return active.filter((note) => note.pinned);
  }
  const folderId = folderIdOfView(view);
  if (folderId !== undefined) {
    return active.filter((note) => note.folderId === folderId);
  }
  return active;
}

function viewTitle(view: NoteView): string {
  if (view === 'boards:orphan') {
    return '未关联画板';
  }
  if (view === 'favorites') {
    return '收藏';
  }
  if (view === 'pinned') {
    return '置顶';
  }
  if (view === 'trash') {
    return '回收站';
  }
  const folderId = folderIdOfView(view);
  if (folderId !== undefined) {
    return noteFolderName(folderId);
  }
  return '全部笔记';
}

function emptyCopy(view: NoteView): string {
  if (view === 'boards:orphan') {
    return '没有未关联的画板';
  }
  if (view === 'trash') {
    return '回收站是空的';
  }
  if (view === 'favorites') {
    return '还没有收藏的笔记';
  }
  if (view === 'pinned') {
    return '还没有置顶的笔记';
  }
  if (view.startsWith('folder:')) {
    return '这个目录还没有笔记';
  }
  return '还没有笔记';
}

/* ------------------------------------------------------------------ */
/* 笔记内链关系图（ZX-GRAPH-01）                                        */
/* ------------------------------------------------------------------ */

type GraphPoint = { x: number; y: number };

type GraphLayout = {
  positions: Map<string, GraphPoint>;
  viewBox: { x: number; y: number; width: number; height: number };
};

const EMPTY_GRAPH_LAYOUT: GraphLayout = {
  positions: new Map(),
  viewBox: { x: -120, y: -120, width: 240, height: 240 },
};

function truncateGraphLabel(value: string, max = 10): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : value;
}

/**
 * 确定性径向布局：当前笔记在中心，一跳/两跳按环展开；全部模式下不可达的
 * 孤立笔记放到最外环。断链幽灵节点挂在来源节点旁边，方向仍然可读。
 *
 * 布局只做简单三角运算，不引入力导向库；100 节点/1000 边时重排一次即可，
 * 拖拽/缩放只改 transform，不会重新计算节点位置。
 */
function layoutNoteLinkGraph(graph: NoteLinkGraph): GraphLayout {
  const positions = new Map<string, GraphPoint>();
  const noteNodes = graph.nodes.filter((node) => node.kind === 'note');
  if (noteNodes.length === 0) {
    return EMPTY_GRAPH_LAYOUT;
  }

  const root = noteNodes.find((node) => node.isRoot) ?? null;
  if (root) {
    positions.set(root.id, { x: 0, y: 0 });
  }

  const reachable = noteNodes.filter(
    (node) => !node.isRoot && typeof node.depth === 'number',
  );
  const maxDepth = reachable.reduce(
    (max, node) => Math.max(max, node.depth ?? 0),
    0,
  );
  const rings = new Map<number, NoteLinkGraphNode[]>();
  for (const node of noteNodes) {
    if (node.isRoot) {
      continue;
    }
    const ring =
      typeof node.depth === 'number' ? Math.max(1, node.depth) : maxDepth + 1;
    const bucket = rings.get(ring) ?? [];
    bucket.push(node);
    rings.set(ring, bucket);
  }

  let radius = 0;
  [...rings.keys()]
    .sort((a, b) => a - b)
    .forEach((ringKey, ringIndex) => {
      const nodes = rings.get(ringKey) ?? [];
      if (nodes.length === 0) {
        return;
      }
      // 节点多时按周长加半径，避免同环节点挤在圆点上。
      radius = Math.max(
        radius + 92,
        (nodes.length * 58) / (Math.PI * 2),
      );
      const startAngle = -Math.PI / 2 + ringIndex * 0.38;
      // ringIndex 只控制起始角；半径始终从中心向外递增。
      nodes.forEach((node, index) => {
        const angle = startAngle + (index / nodes.length) * Math.PI * 2;
        positions.set(node.id, {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        });
      });
    });

  // 断链节点：围绕来源节点外侧排开；同一目标只放一次。
  const brokenBySource = new Map<string, NoteLinkGraphEdge[]>();
  for (const edge of graph.edges) {
    if (!edge.broken) {
      continue;
    }
    const bucket = brokenBySource.get(edge.sourceId) ?? [];
    bucket.push(edge);
    brokenBySource.set(edge.sourceId, bucket);
  }
  const validTargetsBySource = new Map<string, GraphPoint[]>();
  for (const edge of graph.edges) {
    if (edge.broken) {
      continue;
    }
    const target = positions.get(edge.targetId);
    if (!target) {
      continue;
    }
    const bucket = validTargetsBySource.get(edge.sourceId) ?? [];
    bucket.push(target);
    validTargetsBySource.set(edge.sourceId, bucket);
  }
  for (const [sourceId, brokenEdges] of brokenBySource) {
    const source = positions.get(sourceId) ?? { x: 0, y: 0 };
    const targets = validTargetsBySource.get(sourceId) ?? [];
    let directionX = 0;
    let directionY = 0;
    for (const target of targets) {
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.hypot(dx, dy) || 1;
      directionX += dx / distance;
      directionY += dy / distance;
    }
    const magnitude = Math.hypot(directionX, directionY);
    const fromCenter = Math.hypot(source.x, source.y);
    // 断链挂在有效邻居的反方向，避免盖住真实边；没有邻居时朝外。
    const baseAngle =
      magnitude > 0.15
        ? Math.atan2(directionY, directionX) + Math.PI
        : fromCenter > 1
          ? Math.atan2(source.y, source.x)
          : -Math.PI / 2;
    let placed = 0;
    for (const edge of brokenEdges) {
      if (positions.has(edge.targetId)) {
        continue;
      }
      const offset = (placed - (brokenEdges.length - 1) / 2) * 0.62;
      const angle = baseAngle + offset;
      positions.set(edge.targetId, {
        x: source.x + Math.cos(angle) * 54,
        y: source.y + Math.sin(angle) * 54,
      });
      placed += 1;
    }
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const [id, point] of positions) {
    const node = nodeById.get(id);
    const labelWidth = Math.min(
      Array.from(node?.title ?? '').length || 4,
      10,
    ) * 5.6;
    const halfWidth = Math.max(22, labelWidth / 2 + 6);
    minX = Math.min(minX, point.x - halfWidth);
    maxX = Math.max(maxX, point.x + halfWidth);
    minY = Math.min(minY, point.y - 30);
    maxY = Math.max(maxY, point.y + (node?.kind === 'broken' ? 44 : 48));
  }

  const padding = 30;
  const width = Math.max(240, maxX - minX + padding * 2);
  const height = Math.max(240, maxY - minY + padding * 2);
  return {
    positions,
    viewBox: {
      x: minX - padding,
      y: minY - padding,
      width,
      height,
    },
  };
}

type NoteLinkGraphViewProps = {
  notes: ReadonlyArray<Note>;
  rootId: string;
  onOpenNote: (id: string) => void;
};

function NoteLinkGraphView({
  notes,
  rootId,
  onOpenNote,
}: NoteLinkGraphViewProps) {
  const [depth, setDepth] = useState<NoteLinkDepth>(1);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<GraphPoint>({ x: 0, y: 0 });
  const [retryToken, setRetryToken] = useState(0);
  const [panning, setPanning] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const suppressClickRef = useRef(false);
  const dragRef = useRef({
    active: false,
    moved: false,
    x: 0,
    y: 0,
    panX: 0,
    panY: 0,
  });
  const markerId = `kn-graph-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const brokenMarkerId = `${markerId}-broken`;

  const rootNote = notes.find((note) => note.id === rootId) ?? null;
  const rootTrashed = rootNote ? isTrashedNote(rootNote) : false;

  const result = useMemo(() => {
    try {
      return {
        graph: buildNoteLinkGraph(notes, { rootId, depth }),
        error: null as string | null,
      };
    } catch (reason) {
      return { graph: null, error: formatError(reason) };
    }
    // retryToken 只用于错误态重试；数据不变时重新计算一次是安全且廉价的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, rootId, depth, retryToken]);

  const graph = result.graph;
  const layout = useMemo(
    () => (graph ? layoutNoteLinkGraph(graph) : EMPTY_GRAPH_LAYOUT),
    [graph],
  );

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  panRef.current = pan;

  const zoomBy = useCallback(
    (factor: number) => {
      const previous = zoomRef.current;
      const next = Math.min(3, Math.max(0.5, previous * factor));
      if (next === previous) {
        return;
      }
      const centerX = layout.viewBox.x + layout.viewBox.width / 2;
      const centerY = layout.viewBox.y + layout.viewBox.height / 2;
      setPan((currentPan) => {
        const contentX = (centerX - currentPan.x) / previous;
        const contentY = (centerY - currentPan.y) / previous;
        return {
          x: centerX - contentX * next,
          y: centerY - contentY * next,
        };
      });
      setZoom(next);
    },
    [layout.viewBox.height, layout.viewBox.width, layout.viewBox.x, layout.viewBox.y],
  );

  // 滚轮缩放需要 preventDefault，React 的 wheel 监听是被动的，这里手动挂。
  useEffect(() => {
    const element = svgRef.current;
    if (!element) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [zoomBy, graph]);

  const resetView = () => {
    suppressClickRef.current = false;
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) {
      return;
    }
    // 从节点按下时不启动平移，避免 pointer capture 把 click 目标改成 svg，
    // 导致点击节点无法打开笔记。平移从画布空白/网格处开始。
    const target = event.target as Element | null;
    if (target?.closest?.('.kn-graph-node')) {
      return;
    }
    dragRef.current = {
      active: true,
      moved: false,
      x: event.clientX,
      y: event.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // 合成事件或指针已释放时忽略；拖拽仍由 pointermove 继续。
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag.active) {
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 3) {
      drag.moved = true;
      setPanning(true);
    }
    if (!drag.moved) {
      return;
    }
    const rect = svgRef.current?.getBoundingClientRect();
    const scale =
      rect && rect.width > 0 ? layout.viewBox.width / rect.width : 1;
    setPan({
      x: drag.panX + dx * scale,
      y: drag.panY + dy * scale,
    });
  };

  const endPointer = (
    event: ReactPointerEvent<SVGSVGElement>,
  ) => {
    if (!dragRef.current.active) {
      return;
    }
    const wasDrag = dragRef.current.moved;
    dragRef.current.active = false;
    setPanning(false);
    if (wasDrag) {
      // 拖拽结束后的那一次 click 不应打开节点；短暂屏蔽后恢复键盘/点击。
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 250);
    }
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // 指针已经释放时无需处理。
    }
  };

  if (rootTrashed) {
    return (
      <div className="kn-graph-state" role="status">
        <h4>回收站笔记不参与关系图</h4>
        <p>恢复这篇笔记后，内链关系会重新出现在图中。</p>
      </div>
    );
  }

  if (result.error) {
    return (
      <div className="kn-graph-state" role="alert">
        <h4>关系图生成失败</h4>
        <p>{result.error}</p>
        <button
          type="button"
          className="kn-secondary-button"
          onClick={() => setRetryToken((value) => value + 1)}
        >
          重试
        </button>
      </div>
    );
  }

  if (!graph) {
    return null;
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgeKeys = new Set(graph.edges.map((edge) => edge.id));
  const hasCanvas = graph.noteCount > 0;

  const edgePath = (edge: NoteLinkGraphEdge): string | null => {
    const from = layout.positions.get(edge.sourceId);
    const to = layout.positions.get(edge.targetId);
    if (!from || !to) {
      return null;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy) || 1;
    const ux = dx / distance;
    const uy = dy / distance;
    const start = { x: from.x + ux * 15, y: from.y + uy * 15 };
    const end = { x: to.x - ux * 20, y: to.y - uy * 20 };
    const reverse = edgeKeys.has(`${edge.targetId}->${edge.sourceId}`);
    const bend = reverse ? 15 : 0;
    if (!bend) {
      return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
    }
    const controlX = (start.x + end.x) / 2 - uy * bend;
    const controlY = (start.y + end.y) / 2 + ux * bend;
    return `M ${start.x} ${start.y} Q ${controlX} ${controlY} ${end.x} ${end.y}`;
  };

  const noLinks = graph.edgeCount === 0 && graph.brokenCount === 0;
  const emptyMessage =
    depth === 'all'
      ? '整个知识库还没有笔记间内链。内链只统计 zhixing://note/<id>；外部网页链接不计入，也不会生成跨库链接。'
      : '当前笔记还没有站内内链。切到「两跳」或「全部」可查看更远关系；外部网页链接不计入关系图。';

  return (
    <div className="kn-graph-view">
      <div className="kn-graph-toolbar">
        <div
          className="kn-graph-filter"
          role="group"
          aria-label="关系图范围"
        >
          {(
            [
              [1, '一跳'],
              [2, '两跳'],
              ['all', '全部'],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={String(value)}
              className={depth === value ? 'is-active' : undefined}
              aria-pressed={depth === value}
              onClick={() => {
                setDepth(value);
                resetView();
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="kn-graph-zoom" role="group" aria-label="关系图缩放">
          <button
            type="button"
            aria-label="放大关系图"
            title="放大关系图"
            onClick={() => zoomBy(1.25)}
          >
            ＋
          </button>
          <button
            type="button"
            aria-label="缩小关系图"
            title="缩小关系图"
            onClick={() => zoomBy(0.8)}
          >
            −
          </button>
          <button
            type="button"
            className="kn-graph-reset"
            aria-label="重置关系图"
            title="重置缩放与平移"
            onClick={resetView}
          >
            重置
          </button>
        </div>
      </div>

      <p className="kn-graph-stats" aria-live="polite">
        {graph.noteCount} 篇笔记 · {graph.edgeCount} 条内链
        {graph.brokenCount > 0 ? ` · ${graph.brokenCount} 条断链` : ''}
        {graph.isolatedCount > 0
          ? ` · ${graph.isolatedCount} 个孤立`
          : ''}
      </p>

      {hasCanvas ? (
        <svg
          ref={svgRef}
          className={panning ? 'kn-graph-canvas is-panning' : 'kn-graph-canvas'}
          role="group"
          aria-label="笔记关系图"
          viewBox={`${layout.viewBox.x} ${layout.viewBox.y} ${layout.viewBox.width} ${layout.viewBox.height}`}
          data-zoom={zoom.toFixed(2)}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 6 6"
              refX="5"
              refY="3"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M 0 0 L 6 3 L 0 6 z" fill="var(--muted)" />
            </marker>
            <marker
              id={brokenMarkerId}
              viewBox="0 0 6 6"
              refX="5"
              refY="3"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
              markerUnits="userSpaceOnUse"
            >
              <path d="M 0 0 L 6 3 L 0 6 z" fill="var(--red)" />
            </marker>
          </defs>
          <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
            {graph.edges.map((edge) => {
              const path = edgePath(edge);
              if (!path) {
                return null;
              }
              const source = nodeById.get(edge.sourceId);
              const target = nodeById.get(edge.targetId);
              return (
                <path
                  key={edge.id}
                  className={
                    edge.broken
                      ? 'kn-graph-edge is-broken'
                      : 'kn-graph-edge'
                  }
                  d={path}
                  data-direction={`${edge.sourceId}->${edge.targetId}`}
                  markerEnd={`url(#${
                    edge.broken ? brokenMarkerId : markerId
                  })`}
                >
                  <title>
                    {source?.title ?? edge.sourceId} →{' '}
                    {target?.title ?? edge.targetId}
                    {edge.broken ? '（断链）' : ''}
                  </title>
                </path>
              );
            })}
            {graph.nodes.map((node) => {
              const point = layout.positions.get(node.id);
              if (!point) {
                return null;
              }
              const label = truncateGraphLabel(
                node.kind === 'broken'
                  ? node.title.replace(/^断链：/, '')
                  : node.title,
                node.kind === 'broken' ? 8 : 10,
              );
              const badge = node.isRoot
                ? '当前'
                : node.kind === 'broken'
                  ? '断链'
                  : node.isolated
                    ? '孤立'
                    : node.depth === 1
                      ? '一跳'
                      : node.depth === 2
                        ? '两跳'
                        : null;
              const className = [
                'kn-graph-node',
                node.isRoot ? 'is-root' : '',
                node.isolated ? 'is-isolated' : '',
                node.kind === 'broken' ? 'is-broken' : '',
              ]
                .filter(Boolean)
                .join(' ');
              const ariaLabel =
                node.kind === 'broken'
                  ? `断链：${node.title.replace(/^断链：/, '')}`
                  : `打开关系图笔记：${node.title}${
                      node.isolated ? '（孤立笔记）' : ''
                    }`;
              const description = node.isRoot
                ? '当前笔记'
                : node.kind === 'broken'
                  ? node.brokenReason === 'trashed'
                    ? '目标笔记已在回收站，恢复后内链才会生效'
                    : '目标笔记不存在'
                  : node.isolated
                    ? '孤立笔记：没有任何站内内链'
                    : `距离当前笔记 ${node.depth ?? '?'} 跳`;
              return (
                <g
                  key={node.id}
                  className={className}
                  transform={`translate(${point.x} ${point.y})`}
                  role={node.kind === 'note' ? 'button' : 'img'}
                  tabIndex={node.kind === 'note' ? 0 : undefined}
                  aria-label={ariaLabel}
                  onClick={() => {
                    if (suppressClickRef.current || node.kind !== 'note') {
                      return;
                    }
                    onOpenNote(node.id);
                  }}
                  onKeyDown={(event) => {
                    if (node.kind !== 'note') {
                      return;
                    }
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onOpenNote(node.id);
                    }
                  }}
                >
                  <title>{description}</title>
                  {node.isRoot ? (
                    <circle className="kn-graph-root-ring" r={18} />
                  ) : null}
                  <circle className="kn-graph-node-dot" r={12} />
                  <text className="kn-graph-label" y={27}>
                    {label}
                  </text>
                  {badge ? (
                    <text className="kn-graph-badge" y={40}>
                      {badge}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>
      ) : null}

      {!hasCanvas ? (
        <div className="kn-graph-state" role="status">
          <h4>还没有可显示的笔记</h4>
          <p>知识库为空，创建两篇以上笔记并用内链连接后即可查看关系图。</p>
        </div>
      ) : null}

      {hasCanvas && noLinks ? (
        <p className="kn-graph-empty" role="status">
          {emptyMessage}
        </p>
      ) : null}

      <div className="kn-graph-legend" aria-label="关系图图例">
        <span>
          <i className="is-current" aria-hidden="true" />
          当前
        </span>
        <span>
          <i aria-hidden="true" />
          笔记
        </span>
        <span>
          <i className="is-isolated" aria-hidden="true" />
          孤立
        </span>
        <span>
          <i className="is-broken" aria-hidden="true" />
          断链
        </span>
        <span>→ 来源指向目标</span>
      </div>

      <p className="kn-panel-note kn-graph-scope">
        内链仅站内有效，跨应用不可跳转；外部链接不进入关系图，也不会伪造跨库链接。
      </p>
    </div>
  );
}

export function KnowledgePage({
  source,
  blockSource,
  boardSource,
  noteTodoSource,
  taskSource,
  attachmentManager,
  attachmentUploader,
  attachmentUnavailableReason,
}: KnowledgePageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const noteSource = useMemo<NoteSource>(
    () => source ?? createNoteRepository(db),
    [source],
  );
  const blockRepository = useMemo<BlockRepository>(
    () => blockSource ?? createBlockRepository(db),
    [blockSource],
  );
  const boardRepository = useMemo<BoardSource>(
    () => boardSource ?? createBoardSource(),
    [boardSource],
  );
  const noteTodoRepository = useMemo<NoteTodoRepository>(
    () => noteTodoSource ?? createNoteTodoRepository(db),
    [noteTodoSource],
  );
  const available = source !== undefined || isTauriRuntime();
  /** 画板列表只用于「未关联画板」入口；浏览器预览不探测本地库。 */
  const boardAvailable = boardSource !== undefined || isTauriRuntime();

  const [status, setStatus] = useState<LoadStatus>(
    available ? 'loading' : 'unavailable',
  );
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [boardObjectCounts, setBoardObjectCounts] = useState<
    Record<string, number>
  >({});
  const [boardDialog, setBoardDialog] = useState<BoardDialogState>(null);
  const [boardDialogNoteId, setBoardDialogNoteId] = useState('');
  const [boardDialogError, setBoardDialogError] = useState<string | null>(null);
  const [view, setView] = useState<NoteView>('all');
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [closedAll, setClosedAll] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panel, setPanel] = useState<SidePanel>(null);
  const [linksView, setLinksView] = useState<LinkPanelView>('list');
  const [readingMode, setReadingMode] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [immersive, setImmersive] = useState(false);
  /**
   * 轻量布局专注：只收左树/列表，内容区向左扩展。
   * 不加 scrim、不置灰、不隐藏右栏；与 focusMode/immersive 互斥归一化。
   */
  const [contentExpanded, setContentExpanded] = useState(false);
  const [readingBeforeImmersive, setReadingBeforeImmersive] =
    useState(false);
  const [focusBeforeImmersive, setFocusBeforeImmersive] = useState(false);
  const [expandedBeforeImmersive, setExpandedBeforeImmersive] =
    useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  /** ≤900 的「工具」抽屉：9 项在窄屏仍然可达，不做功能删除。 */
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsTitleRef = useRef<HTMLHeadingElement>(null);
  /** 右栏浮窗的触发按钮：Esc/× 关闭后焦点回到这里（ZX8-RAILPOP-01）。 */
  const railButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [activeBlock, setActiveBlock] = useState<EditorActiveBlock | null>(
    null,
  );
  const [helpOpen, setHelpOpen] = useState(false);
  const narrowLayout = useNarrowLayout();
  const expandBlocked = useExpandBlocked();
  const canExpandLayout = !expandBlocked;
  const expandedActive = contentExpanded && canExpandLayout;
  const [editorBlocks, setEditorBlocks] = useState<readonly EditorBlock[]>([]);
  const [editorReloadToken, setEditorReloadToken] = useState(0);
  const [filePickerToken, setFilePickerToken] = useState(0);
  const [attachmentRefreshToken, setAttachmentRefreshToken] = useState(0);
  /**
   * 正文文件卡状态不在块 payload 里信任快照：按当前同步模式向附件管理器
   * 查询真实状态，避免旧 `pending` 在 local 模式被展示成“待同步”。
   */
  const [attachmentStatusLabels, setAttachmentStatusLabels] = useState<
    Record<string, string>
  >({});
  const [scrollToBlock, setScrollToBlock] = useState<{
    blockId: string;
    token: number;
    highlight?: boolean;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<MenuState>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  // Modal footer 的提交按钮通过 form 属性关联 body 内的表单。
  const dialogFormId = useId();
  const boardDialogFormId = useId();
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exportFormat, setExportFormat] =
    useState<NoteExportChoice>('docx');
  const [exportIncludeMetadata, setExportIncludeMetadata] = useState(true);
  const [exportIncludeImages, setExportIncludeImages] = useState(true);
  const [exportPaper, setExportPaper] = useState<NotePdfPaper>('A4');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<SavedNoteExport | null>(
    null,
  );
  const [renameValue, setRenameValue] = useState('');
  const [moveFolder, setMoveFolder] = useState('');
  const [titleEdit, setTitleEdit] = useState<{
    id: string;
    value: string;
  } | null>(null);
  const [bodyLength, setBodyLength] = useState<{
    noteId: string;
    length: number;
  } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [editorHistory, setEditorHistory] = useState<EditorHistoryState>({
    canUndo: false,
    canRedo: false,
  });
  const [editorHistoryAction, setEditorHistoryAction] =
    useState<EditorHistoryAction | null>(null);
  const [toast, setToast] = useState<ToastState>(null);

  const notesRef = useRef<Note[]>([]);
  const shellRef = useRef<HTMLElement | null>(null);
  const scrollSeq = useRef(0);
  /**
   * 每篇笔记的正文滚动位置（运行期记忆）。切换标签/重新打开时恢复，
   * 不写块数据、不写 localStorage；这是布局交互态，不是笔记内容。
   */
  const noteScrollTopRef = useRef(new Map<string, number>());
  const titleRef = useRef<HTMLInputElement | null>(null);
  /** 展开后的焦点落点：正文纸面（不是 input，避免下一次 Esc 被输入守卫吞掉）。 */
  const paperRef = useRef<HTMLElement | null>(null);
  /** 展开前焦点与滚动位置；还原后归还，不重置正文位置。 */
  const expandReturnFocusRef = useRef<HTMLElement | null>(null);
  const expandScrollRef = useRef(0);
  const pendingExpandFocusRef = useRef<'editor' | 'restore' | null>(null);
  const editorCommandRef = useRef<EditorCommandHandle | null>(null);
  const bodyTimer = useRef<number | null>(null);
  const pendingBody = useRef<string | null>(null);
  const pendingBodyNoteId = useRef<string | null>(null);
  const flushBodyRef = useRef<() => Promise<void>>(async () => undefined);
  const previousActiveId = useRef<string | null>(null);
  const toastSeq = useRef(0);
  const lastSearchFindRef = useRef<string>('');
  const editorHistoryToken = useRef(0);

  const requestedNoteId = searchParams.get('note');
  const findQuery = (searchParams.get('find') ?? '').trim();

  const showToast = useCallback(
    (message: string, tone: 'ok' | 'error' = 'ok') => {
      toastSeq.current += 1;
      setToast({ id: toastSeq.current, message, tone });
    },
    [],
  );

  /** 锁定笔记只允许查看元数据；任何会写内容的操作先明确拒绝。 */
  const requireUnlocked = (note: Note, action: string): boolean => {
    if (!note.locked) return true;
    showToast(
      `笔记已加密并锁定；请先在「设置 → 隐私与安全」解锁再${action}`,
      'error',
    );
    return false;
  };

  /** 读取画板摘要与对象数；失败时保持空列表，不让知识页整体不可用。 */
  const refreshBoards = useCallback(async () => {
    if (!boardAvailable) {
      setBoards([]);
      setBoardObjectCounts({});
      return;
    }
    try {
      const list = await boardRepository.list();
      const counts = await Promise.all(
        list.map(async (board) => {
          try {
            const document = await boardRepository.load(board.id);
            return [board.id, document.nodes.length] as const;
          } catch {
            return [board.id, 0] as const;
          }
        }),
      );
      setBoards(list);
      setBoardObjectCounts(Object.fromEntries(counts));
    } catch {
      setBoards([]);
      setBoardObjectCounts({});
    }
  }, [boardAvailable, boardRepository]);

  useEffect(() => {
    if (!boardAvailable) {
      return;
    }
    void refreshBoards();
  }, [boardAvailable, refreshBoards]);

  const notesById = useMemo(
    () => new Map(notes.map((note) => [note.id, note])),
    [notes],
  );
  /**
   * 孤儿画板：`boards.note_id` 为空、来源笔记已删除，或正文里已没有
   * 引用它的 `board` 块（`zx-board-ref` 标记）。数据不删，只在目录中可达。
   */
  const orphanBoards = useMemo(
    () =>
      boards.filter((board) => {
        if (!board.noteId) {
          return true;
        }
        const note = notesById.get(board.noteId);
        if (!note || isTrashedNote(note)) {
          return true;
        }
        return !bodyReferencesBoard(note.body, board.id);
      }),
    [boards, notesById],
  );
  /**
   * 页面级只装配一次附件运行时：正文文件卡与右栏附件面板引用同一个
   * manager，保证插入的文件立刻出现在同一条附件记录里，而不是两套元数据。
   */
  const embeddedAttachments = useAttachmentRuntime({
    enabled: attachmentManager === undefined,
  });
  const activeAttachmentManager =
    attachmentManager === undefined
      ? embeddedAttachments.manager
      : attachmentManager;
  const activeAttachmentUploader =
    attachmentManager === undefined
      ? embeddedAttachments.uploader
      : attachmentUploader ?? null;
  const activeAttachmentReason =
    attachmentUnavailableReason !== undefined
      ? attachmentUnavailableReason
      : attachmentManager === undefined
        ? embeddedAttachments.reason
        : null;
  const activeAttachmentMode =
    attachmentManager === undefined
      ? embeddedAttachments.syncMode
      : activeAttachmentUploader
        ? 'backend'
        : 'local';
  const attachmentRuntimeLoading =
    attachmentManager === undefined && embeddedAttachments.status === 'loading';

  const handleAttachmentIngested = useCallback(
    (attachments: readonly StoredAttachment[]) => {
      setAttachmentRefreshToken((current) => current + 1);
      showToast(
        activeAttachmentMode === 'local'
          ? `${attachments.length} 个文件已保存到本机（仅本机，不会上传）。`
          : activeAttachmentUploader
            ? `${attachments.length} 个文件已保存到本机；需要同步时在附件面板点「上传」。`
            : `${attachments.length} 个文件已保存到本机；同步服务当前不可用，文件不受影响。`,
      );
    },
    [activeAttachmentMode, activeAttachmentUploader, showToast],
  );

  /** 页脚的撤销/重做按钮：递增 token 交给内联块编辑器执行。 */
  const requestEditorHistory = useCallback((action: 'undo' | 'redo') => {
    editorHistoryToken.current += 1;
    setEditorHistoryAction({
      action,
      token: editorHistoryToken.current,
    });
  }, []);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const commitNotes = useCallback((next: Note[]) => {
    notesRef.current = next;
    setNotes(next);
  }, []);

  /** 导出默认格式/选项写入 SQLite；无桌面库时用默认值，不影响导出。 */
  useEffect(() => {
    let cancelled = false;
    void loadNoteExportPreferences(db).then((preferences) => {
      if (cancelled) {
        return;
      }
      setExportFormat(preferences.format);
      setExportIncludeMetadata(preferences.includeMetadata);
      setExportIncludeImages(preferences.includeImages);
      setExportPaper(preferences.pdfPaper);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const syncUrl = useCallback(
    (id: string | null) => {
      if (
        (searchParams.get('note') ?? null) === id &&
        !searchParams.has('find')
      ) {
        return;
      }
      const next = new URLSearchParams(searchParams);
      if (id) {
        next.set('note', id);
      } else {
        next.delete('note');
      }
      // 用户手动切换笔记后，上一次搜索定位参数不再适用于新笔记。
      next.delete('find');
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const load = useCallback(async () => {
    if (!available) {
      setStatus('unavailable');
      return;
    }
    setStatus((current) => (current === 'ready' ? 'ready' : 'loading'));
    try {
      const rows = sortNotes(
        await noteSource.list({ includeDeleted: true }),
      );
      commitNotes(rows);
      setError(null);
      setStatus('ready');
    } catch (reason) {
      setError(formatError(reason));
      setStatus('error');
    }
  }, [available, commitNotes, noteSource]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!available) {
      return;
    }
    const refresh = () => {
      void load();
    };
    window.addEventListener(EXECUTION_NOTES_CHANGED, refresh);
    return () => window.removeEventListener(EXECUTION_NOTES_CHANGED, refresh);
  }, [available, load]);

  // 深链 / 首次进入的当前笔记直接从数据派生，不额外写一次状态；
  // 这样列表、标签与正文出现在同一次提交里，也避免空白编辑器闪烁。
  // 用户主动关闭全部标签后 closedAll=true，不再自动回退到第一篇。
  const requestedNote = requestedNoteId
    ? notes.find((note) => note.id === requestedNoteId) ?? null
    : null;
  const fallbackNote = closedAll
    ? null
    : requestedNote ?? notes.find((note) => !isTrashedNote(note)) ?? null;
  const activeNote =
    requestedNote ??
    (activeId ? notes.find((note) => note.id === activeId) : null) ??
    fallbackNote;

  // 初始笔记/深链笔记也显示为一个标签；用户打开更多标签后以 openTabs 为准。
  const displayTabs =
    activeNote && !openTabs.includes(activeNote.id)
      ? [...openTabs, activeNote.id]
      : openTabs;

  const noteInTrash = activeNote ? isTrashedNote(activeNote) : false;
  const noteLocked = Boolean(activeNote?.locked);
  const editorReadOnly = noteInTrash || readingMode || noteLocked;
  const displayNoteTitle = (note: Note) =>
    note.locked ? '已加密笔记（锁定）' : note.title;
  const sidePanelOpen = panel !== null && panel !== 'style';
  const linksGraphOpen = panel === 'links' && linksView === 'graph';
  /** 新建画板要同时写笔记与画板；只读/回收站/数据源缺写能力时禁用。 */
  const canCreateBoard =
    Boolean(activeNote) &&
    !noteInTrash &&
    !noteLocked &&
    Boolean(noteSource.create) &&
    Boolean(noteSource.update);

  // 变宽回桌面时关闭抽屉：右栏恢复常驻，避免双份入口与双份焦点。
  useEffect(() => {
    if (!narrowLayout) {
      setToolsOpen(false);
    }
  }, [narrowLayout]);

  useEffect(() => {
    if (!activeNote) {
      setToolsOpen(false);
    }
  }, [activeNote]);

  // 打开抽屉时焦点进入标题；关闭后由命令栏「工具」按钮收回焦点。
  useEffect(() => {
    if (toolsOpen) {
      toolsTitleRef.current?.focus();
    }
  }, [toolsOpen]);

  // 窄屏抽屉与右栏浮窗互斥：抽屉打开时不再保留同位置的 panel。
  useEffect(() => {
    if (toolsOpen) {
      setPanel(null);
    }
  }, [toolsOpen]);

  // Esc 统一由下方调度器处理：输入 → 模态 → 抽屉 → 浮窗 → 编辑器临时层 →
  // 沉浸 → 专注 → 展开。这里只保留浮窗关闭时的焦点归还工具。
  const focusRailPanelTrigger = useCallback((kind: PanelKind) => {
    const trigger = railButtonRefs.current.get(kind);
    if (trigger) {
      trigger.focus();
      return;
    }
    // 窄屏右栏不渲染，触发按钮在抽屉里；关闭后回到命令栏「工具」。
    if (typeof document !== 'undefined') {
      document
        .querySelector<HTMLButtonElement>('.kn-cmd-tools')
        ?.focus();
    }
  }, []);

  // 菜单没有几何空间时请求关闭浮窗，避免两块浮层叠在一起。
  useEffect(() => {
    const closeFlyout = () => {
      setPanel((current) =>
        current && current !== 'style' ? null : current,
      );
    };
    window.addEventListener('kn:close-rail-flyout', closeFlyout);
    return () =>
      window.removeEventListener('kn:close-rail-flyout', closeFlyout);
  }, []);

  // 切换笔记时清空上一页的块快照与撤销/重做可用性，避免短暂串页。
  // 专注模式按规范跨笔记保持，只由用户显式退出；编辑器会把当前块归位。
  useEffect(() => {
    setEditorBlocks([]);
    setActiveBlock(null);
    setPanel(null);
    setLinksView('list');
    setReadingMode(false);
    setScrollToBlock(null);
    setEditorHistory({ canUndo: false, canRedo: false });
    setEditorHistoryAction(null);
  }, [activeNote?.id]);

  const headings = useMemo(
    () =>
      editorBlocks.flatMap((block) => {
        const level = headingLevel(block.type);
        if (!level) {
          return [];
        }
        const text = runsToPlainText(blockRuns(block)).trim();
        return [
          {
            blockId: block.id,
            level,
            text: text || '无标题',
          },
        ];
      }),
    [editorBlocks],
  );

  const attachmentBlocks = useMemo(
    () =>
      editorBlocks
        .filter((block) => block.type === 'file')
        .map((block) => ({ id: block.id, ...blockFile(block) })),
    [editorBlocks],
  );

  /** 正文文件块引用的附件：面板按“所属笔记 + 引用”合并，避免跨笔记复制元数据。 */
  const referencedAttachmentIds = useMemo(
    () =>
      Array.from(
        new Set(
          attachmentBlocks
            .map((file) => file.attachmentId)
            .filter((id): id is string => Boolean(id)),
        ),
      ),
    [attachmentBlocks],
  );

  useEffect(() => {
    let cancelled = false;
    if (attachmentBlocks.length === 0) {
      setAttachmentStatusLabels({});
      return;
    }
    if (!activeAttachmentManager) {
      setAttachmentStatusLabels(
        Object.fromEntries(
          attachmentBlocks.map((file) => [
            file.id,
            file.attachmentId ? '附件服务不可用' : '仅文件信息',
          ]),
        ),
      );
      return;
    }
    void (async () => {
      const entries = await Promise.all(
        attachmentBlocks.map(async (file) => {
          if (!file.attachmentId) {
            return [file.id, '仅文件信息'] as const;
          }
          try {
            const stored = await activeAttachmentManager.get(file.attachmentId);
            const hasLocal = await activeAttachmentManager.hasLocalBlob(
              file.attachmentId,
            );
            return [
              file.id,
              describeAttachmentStatus({
                status: stored.state.status,
                hasLocal,
                mode: activeAttachmentMode,
                serviceAvailable: Boolean(activeAttachmentUploader),
                remoteId: stored.state.remoteId,
                lastError: stored.state.lastError,
              }).label,
            ] as const;
          } catch {
            return [file.id, '文件缺失'] as const;
          }
        }),
      );
      if (!cancelled) {
        setAttachmentStatusLabels(Object.fromEntries(entries));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activeAttachmentManager,
    activeAttachmentMode,
    activeAttachmentUploader,
    attachmentBlocks,
    attachmentRefreshToken,
  ]);

  const boardBlocks = useMemo(
    () =>
      editorBlocks
        .filter((block) => block.type === 'board')
        .map((block) => ({ id: block.id, ...blockBoard(block) })),
    [editorBlocks],
  );

  const reverseLinks = useMemo(() => {
    if (!activeNote) {
      return [];
    }
    // 与链接块、引用块共用 `internalNoteIdsInText`：只认规范 id，
    // 不用裸 `includes` 把 `zhixing://note/<id>/extra` 也算成反向链接。
    return notes.filter(
      (note) =>
        note.id !== activeNote.id &&
        !isTrashedNote(note) &&
        internalNoteIdsInText(note.body).includes(activeNote.id),
    );
  }, [activeNote, notes]);

  /**
   * 搜索结果定位（N-18）：⌘K 深链带 `find` 打开笔记后，等当前笔记的块加载完，
   * 定位首个命中的块并短暂高亮。只滚动/加 class，不改内容。
   * 脏数据导致没有命中时，打开笔记顶部并提示，而不是假装成功。
   */
  useEffect(() => {
    if (!findQuery) {
      lastSearchFindRef.current = '';
      return;
    }
    if (!activeNote || editorBlocks.length === 0) {
      return;
    }
    // 切换笔记的瞬间可能还持有上一篇的块快照，必须确认归属。
    if (editorBlocks[0]?.noteId !== activeNote.id) {
      return;
    }
    const key = `${location.key}:${activeNote.id}:${findQuery}`;
    if (lastSearchFindRef.current === key) {
      return;
    }
    lastSearchFindRef.current = key;
    const needle = findQuery.toLocaleLowerCase('zh-Hans-CN');
    const target = editorBlocks.find((block) =>
      blocksToPlainText([block])
        .toLocaleLowerCase('zh-Hans-CN')
        .includes(needle),
    );
    if (!target) {
      showToast('未找到匹配位置', 'error');
      return;
    }
    scrollSeq.current += 1;
    setScrollToBlock({
      blockId: target.id,
      token: scrollSeq.current,
      highlight: true,
    });
  }, [
    activeNote,
    editorBlocks,
    findQuery,
    location.key,
    showToast,
  ]);

  useEffect(() => {
    if (previousActiveId.current && previousActiveId.current !== activeNote?.id) {
      // 切换笔记前把上一页待写的兼容 HTML 落库。
      void flushBodyRef.current?.();
    }
    previousActiveId.current = activeNote?.id ?? null;
  }, [activeNote?.id]);

  // 标题编辑只保留“当前笔记 + 草稿”；切换笔记时自动显示仓储标题，
  // 不额外写状态，也不会把上一篇的草稿带到下一篇。
  const titleValue =
    activeNote && titleEdit?.id === activeNote.id
      ? titleEdit.value
      : activeNote?.title ?? '';

  const textLength = activeNote
    ? bodyLength?.noteId === activeNote.id
      ? bodyLength.length
      : htmlToPlainText(activeNote.body).length
    : 0;

  const patchNote = useCallback(
    async (note: Note, patch: NotePatch): Promise<Note | null> => {
      if (!requireUnlocked(note, '编辑笔记')) {
        return null;
      }
      const update = noteSource.update;
      if (!update) {
        showToast('当前数据源不支持编辑笔记', 'error');
        return null;
      }
      const current = notesRef.current.find((item) => item.id === note.id) ?? note;
      setSaveState('saving');
      try {
        const updated = await update(
          current.id,
          toNoteUpdate(current, patch),
        );
        const next = sortNotes(
          notesRef.current.map((item) =>
            item.id === updated.id ? updated : item,
          ),
        );
        commitNotes(next);
        setSaveState('saved');
        return updated;
      } catch (reason) {
        setSaveState('error');
        showToast(formatError(reason), 'error');
        return null;
      }
    },
    [commitNotes, noteSource, showToast],
  );

  const flushBody = useCallback(async () => {
    if (bodyTimer.current !== null) {
      window.clearTimeout(bodyTimer.current);
      bodyTimer.current = null;
    }
    const noteId = pendingBodyNoteId.current;
    const html = pendingBody.current;
    pendingBody.current = null;
    pendingBodyNoteId.current = null;
    if (!noteId || html === null) {
      return;
    }
    const note = notesRef.current.find((item) => item.id === noteId);
    if (!note || note.locked || isTrashedNote(note) || note.body === html) {
      setSaveState('saved');
      return;
    }
    await patchNote(note, { body: html });
  }, [patchNote]);

  useEffect(() => {
    flushBodyRef.current = flushBody;
  }, [flushBody]);

  useEffect(
    () => () => {
      if (bodyTimer.current !== null) {
        window.clearTimeout(bodyTimer.current);
        bodyTimer.current = null;
      }
      void flushBodyRef.current?.();
    },
    [],
  );

  const queueBodySave = (note: Note, html: string) => {
    pendingBodyNoteId.current = note.id;
    pendingBody.current = html;
    setSaveState('saving');
    if (bodyTimer.current !== null) {
      window.clearTimeout(bodyTimer.current);
    }
    bodyTimer.current = window.setTimeout(() => {
      void flushBodyRef.current?.();
    }, 650);
  };

  const commitTitle = async () => {
    const note = activeNote;
    if (!note) {
      return;
    }
    if (isTrashedNote(note)) {
      setTitleEdit(null);
      return;
    }
    const title = titleValue.trim();
    if (!title) {
      setTitleEdit(null);
      showToast('标题不能为空', 'error');
      return;
    }
    if (title === note.title) {
      setTitleEdit(null);
      return;
    }
    const updated = await patchNote(note, { title });
    if (updated) {
      setTitleEdit(null);
      showToast('笔记已重命名');
    } else {
      setTitleEdit(null);
    }
  };

  const activateNote = (id: string) => {
    setActiveId(id);
    setClosedAll(false);
    setPanel(null);
    setSaveState('saved');
    syncUrl(id);
  };

  const openNote = (id: string) => {
    setOpenTabs((current) => {
      const base =
        current.length > 0
          ? current
          : activeNote
            ? [activeNote.id]
            : [];
      return base.includes(id) ? base : [...base, id];
    });
    activateNote(id);
  };

  /**
   * 菜单「打开」：复用当前标签，不在标签栏继续堆叠；
   * 「在新标签页打开」仍用 `openNote` 追加标签，两者行为不同。
   */
  const openNoteInCurrentTab = (id: string) => {
    setOpenTabs((current) => {
      if (current.includes(id)) {
        return current;
      }
      const base =
        current.length > 0
          ? current
          : activeNote
            ? [activeNote.id]
            : [];
      if (base.length === 0) {
        return [id];
      }
      const activeIndex = activeNote ? base.indexOf(activeNote.id) : -1;
      if (activeIndex === -1) {
        return [...base, id];
      }
      const next = [...base];
      next[activeIndex] = id;
      return next;
    });
    activateNote(id);
  };

  /**
   * 文件导入的原子写入口：数据源负责笔记 + 块 + 待办的单一事务。
   * 页面只做乐观列表更新，不拆成 create 后再逐块写入。
   */
  const importNoteBundle = useCallback(
    async (input: ImportNoteInput): Promise<Note> => {
      const importer = noteSource.import;
      if (!importer) {
        throw new Error('当前数据源不支持文件导入');
      }
      const note = await importer(input);
      commitNotes(sortNotes([note, ...notesRef.current]));
      return note;
    },
    [noteSource, commitNotes],
  );

  /**
   * `.zxnote` 导入：解析已完成，这里只做 ID 重映射与写入。
   * 画板与附件在笔记事务之后写入；任一失败由目标执行补偿清理。
   */
  const importNotePackage = useCallback(
    async (input: NotePackageImportInput): Promise<Note> => {
      if (!noteSource.import) {
        throw new NotePackageImportError(
          'ZXNOTE_WRITE_FAILED',
          '当前数据源不支持文件导入',
        );
      }
      let existingAttachments: Array<{ id: string; sha256: string }> = [];
      if (activeAttachmentManager) {
        try {
          existingAttachments = (await activeAttachmentManager.list()).map(
            (item) => ({
              id: item.metadata.id,
              sha256: item.metadata.sha256,
            }),
          );
        } catch {
          existingAttachments = [];
        }
      }
      const plan = planNotePackageImport(input.parsed, {
        // 未指定目录时按 note.json.folder.name 映射；源目录不存在则未分类。
        folderId: input.folderId ?? undefined,
        folders: NOTE_FOLDERS,
        existingAttachments,
      });
      const target = createNotePackageImportTarget({
        noteSource,
        boardSource: boardRepository,
        blockSource: blockRepository,
        noteTodoRepository,
        attachmentManager: activeAttachmentManager,
      });
      const result = await applyNotePackageImport(plan, target);
      commitNotes(sortNotes([result.note, ...notesRef.current]));
      await refreshBoards();
      showToast(
        `已导入《${result.note.title}》：${plan.stats.blocks} 个块 · ${plan.stats.boards} 张画板 · ${plan.stats.attachments} 个附件`,
      );
      return result.note;
    },
    [
      activeAttachmentManager,
      boardRepository,
      blockRepository,
      commitNotes,
      noteSource,
      noteTodoRepository,
      refreshBoards,
      showToast,
    ],
  );

  const importTitlesInFolder = useCallback(
    (folderId: string | null): ReadonlySet<string> =>
      new Set(
        notesRef.current
          .filter(
            (note) => !isTrashedNote(note) && note.folderId === folderId,
          )
          .map((note) => note.title.trim()),
      ),
    [],
  );

  const openImportedNote = (note: Note) => {
    setImportOpen(false);
    openNote(note.id);
  };

  /**
   * 站内内链点击（N-16）：目标不存在或已在回收站时明确提示，
   * 不静默切到别的笔记（删除后的内链视为失效，恢复后才重新可用）。
   */
  const openInternalNote = (noteId: string) => {
    const target = notesRef.current.find((note) => note.id === noteId);
    if (!target || isTrashedNote(target)) {
      showToast('笔记不存在或已删除', 'error');
      return;
    }
    openNote(target.id);
  };

  const closeTab = (id: string) => {
    const index = displayTabs.indexOf(id);
    const nextTabs = displayTabs.filter((tabId) => tabId !== id);
    setOpenTabs(nextTabs);
    setClosedAll(nextTabs.length === 0);
    if (activeNote?.id === id) {
      const neighbor =
        nextTabs[Math.min(Math.max(index, 0), nextTabs.length - 1)] ?? null;
      setActiveId(neighbor);
      setPanel(null);
      setSaveState('saved');
      syncUrl(neighbor);
    }
  };

  /** 关闭其他标签：保留被右键的那一个并激活，避免误关当前编辑对象。 */
  const closeOtherTabs = (id: string) => {
    setOpenTabs([id]);
    setClosedAll(false);
    setActiveId(id);
    setPanel(null);
    setSaveState('saved');
    syncUrl(id);
  };

  const closeAllTabs = () => {
    setOpenTabs([]);
    setActiveId(null);
    setClosedAll(true);
    setPanel(null);
    setSaveState('saved');
    syncUrl(null);
  };

  const locateNoteInList = (note: Note) => {
    const targetView: NoteView = isTrashedNote(note) ? 'trash' : 'all';
    setView(targetView);
    window.setTimeout(() => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>('[data-note-id]'),
      ).find((element) => element.dataset.noteId === note.id);
      row?.scrollIntoView({ block: 'nearest' });
      row
        ?.querySelector<HTMLElement>('.kn-note-open')
        ?.focus({ preventScroll: true });
    }, 0);
  };

  const createNote = async (folderOverride?: string | null) => {
    const create = noteSource.create;
    if (!create) {
      showToast('当前数据源不支持新建笔记', 'error');
      return;
    }
    const folderId =
      folderOverride !== undefined
        ? folderOverride
        : view.startsWith('folder:')
          ? folderIdOfView(view) ?? null
          : NOTE_FOLDERS[0]?.id ?? null;
    try {
      const note = await create({
        title: '未命名笔记',
        folderId,
        body: '<p><br></p>',
        bodyFormat: 'html',
      });
      commitNotes(sortNotes([note, ...notesRef.current]));
      setOpenTabs((current) => {
        const base =
          current.length > 0
            ? current
            : activeNote
              ? [activeNote.id]
              : [];
        return base.includes(note.id) ? base : [...base, note.id];
      });
      setActiveId(note.id);
      setClosedAll(false);
      setSaveState('saved');
      if (folderOverride !== undefined) {
        setView(
          folderOverride
            ? (`folder:${folderOverride}` as NoteView)
            : 'folder:uncategorized',
        );
      } else if (
        view === 'trash' ||
        view === 'favorites' ||
        view === 'pinned'
      ) {
        setView('all');
      }
      syncUrl(note.id);
      showToast('已新建笔记');
      window.setTimeout(() => {
        titleRef.current?.focus();
        titleRef.current?.select();
      }, 0);
    } catch (reason) {
      showToast(formatError(reason), 'error');
    }
  };

  const toggleFavorite = async (note: Note) => {
    if (!requireUnlocked(note, '收藏')) return;
    const updated = await patchNote(note, { favorite: !note.favorite });
    if (updated) {
      showToast(updated.favorite ? '已收藏' : '已取消收藏');
    }
  };

  const togglePinned = async (note: Note) => {
    if (!requireUnlocked(note, '置顶')) return;
    const updated = await patchNote(note, { pinned: !note.pinned });
    if (updated) {
      showToast(updated.pinned ? '已置顶' : '已取消置顶');
    }
  };

  const requestDelete = (note: Note) => {
    setDialogError(null);
    setDialog({ kind: 'delete', noteId: note.id });
  };

  const confirmDelete = async () => {
    if (!dialog || dialog.kind !== 'delete') {
      return;
    }
    const note = notesRef.current.find((item) => item.id === dialog.noteId);
    const remove = noteSource.remove;
    if (!note || !remove) {
      showToast('当前数据源不支持删除笔记', 'error');
      return;
    }
    try {
      await remove(note.id);
      const index = displayTabs.indexOf(note.id);
      const nextTabs = displayTabs.filter((tabId) => tabId !== note.id);
      setOpenTabs(nextTabs);
      if (activeNote?.id === note.id) {
        const remaining = notesRef.current.filter(
          (item) => item.id !== note.id && !isTrashedNote(item),
        );
        const neighbor =
          nextTabs[Math.min(Math.max(index, 0), nextTabs.length - 1)] ??
          remaining[0]?.id ??
          null;
        setActiveId(neighbor);
        setClosedAll(nextTabs.length === 0 && !neighbor);
        setPanel(null);
        setSaveState('saved');
        syncUrl(neighbor);
      } else {
        setClosedAll(nextTabs.length === 0);
      }
      setDialog(null);
      await load();
      showToast('已移到回收站');
    } catch (reason) {
      showToast(formatError(reason), 'error');
    }
  };

  const restoreNote = async (note: Note) => {
    const restore = noteSource.restore;
    if (!restore) {
      showToast('当前数据源不支持恢复笔记', 'error');
      return;
    }
    try {
      const restored = await restore(note.id);
      await load();
      setView('all');
      setOpenTabs((current) =>
        current.includes(restored.id) ? current : [...current, restored.id],
      );
      setActiveId(restored.id);
      setClosedAll(false);
      setSaveState('saved');
      syncUrl(restored.id);
      showToast('已恢复笔记');
    } catch (reason) {
      showToast(formatError(reason), 'error');
    }
  };

  const openRename = (note: Note) => {
    if (!requireUnlocked(note, '重命名')) return;
    setDialogError(null);
    setRenameValue(note.title);
    setDialog({ kind: 'rename', noteId: note.id });
  };

  const confirmRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || dialog.kind !== 'rename') {
      return;
    }
    const note = notesRef.current.find((item) => item.id === dialog.noteId);
    if (!note) {
      setDialog(null);
      return;
    }
    const title = renameValue.trim();
    if (!title) {
      setDialogError('标题不能为空');
      return;
    }
    const updated = await patchNote(note, { title });
    if (!updated) {
      return;
    }
    setDialog(null);
    setDialogError(null);
    if (activeNote?.id === note.id) {
      setTitleEdit(null);
    }
    showToast('笔记已重命名');
  };

  const openMove = (note: Note) => {
    if (!requireUnlocked(note, '移动目录')) return;
    setDialogError(null);
    setMoveFolder(note.folderId ?? '');
    setDialog({ kind: 'move', noteId: note.id });
  };

  const confirmMove = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || dialog.kind !== 'move') {
      return;
    }
    const note = notesRef.current.find((item) => item.id === dialog.noteId);
    if (!note) {
      setDialog(null);
      return;
    }
    const updated = await patchNote(note, {
      folderId: moveFolder || null,
    });
    if (!updated) {
      return;
    }
    setDialog(null);
    showToast('笔记已移动');
  };

  const openExportDialog = useCallback(
    (note: Note, format?: NoteExportChoice) => {
      if (!requireUnlocked(note, '导出明文')) return;
      setDialogError(null);
      setExportNotice(null);
      setExportResult(null);
      if (format) {
        setExportFormat(format);
      }
      setDialog({ kind: 'export', noteId: note.id });
    },
    [],
  );

  const exportOutlineFor = (note: Note): string => {
    if (activeNote?.id === note.id && editorBlocks.length > 0) {
      return summarizeNoteBlocks(editorBlocks);
    }
    return '该笔记的全部正文块（导出时从本机读取）';
  };

  const confirmExport = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || dialog.kind !== 'export') {
      return;
    }
    const note = notesRef.current.find((item) => item.id === dialog.noteId);
    if (!note) {
      setDialogError('笔记不存在或已删除，无法导出');
      return;
    }
    setExportBusy(true);
    setDialogError(null);
    setExportNotice(null);
    const isPackage = exportFormat === 'zxnote';
    const options = {
      format: isPackage ? 'md' : exportFormat,
      includeMetadata: exportIncludeMetadata,
      includeImages: exportIncludeImages,
      pdfPaper: exportPaper,
    } satisfies {
      format: NoteExportFormat;
      includeMetadata: boolean;
      includeImages: boolean;
      pdfPaper: NotePdfPaper;
    };
    if (!isPackage) {
      void saveNoteExportPreferences(db, options);
    }
    try {
      const activeBlocks =
        activeNote?.id === note.id
          ? editorBlocks.filter((block) => block.noteId === note.id)
          : [];
      const blocks =
        activeBlocks.length > 0
          ? activeBlocks
          : await blockRepository.list(note.id);

      if (isPackage) {
        let noteTodos: Awaited<
          ReturnType<NoteTodoRepository['list']>
        > = [];
        try {
          noteTodos = await noteTodoRepository.list(note.id);
        } catch {
          noteTodos = [];
        }
        const saved = await saveNotePackageToFile({
          note,
          blocks,
          noteTodos,
          folderName: noteFolderName(note.folderId),
          loadBoard: notePackageBoardLoaderFromSource(boardRepository),
          attachmentManager: activeAttachmentManager,
          now: new Date(),
        });
        if (saved.status === 'canceled') {
          setExportNotice('已取消保存，未写入文件。');
          return;
        }
        setDialog(null);
        setExportResult(saved);
        showToast('已导出知行笔记包 (.zxnote)');
        return;
      }

      const saved = await saveNoteExportToFile({
        note,
        blocks,
        options,
        folderName: noteFolderName(note.folderId),
        noteTitles: new Map(
          notesRef.current.map((item) => [item.id, item.title]),
        ),
        attachmentManager: activeAttachmentManager,
        boardSource: boardRepository,
      });
      if (saved.status === 'canceled') {
        setExportNotice('已取消保存，未写入文件。');
        return;
      }
      setDialog(null);
      setExportResult(saved);
      showToast(`已导出 ${noteExportFormatLabel(saved.report.format)}`);
    } catch (reason) {
      setDialogError(formatError(reason));
    } finally {
      setExportBusy(false);
    }
  };

  /** ⇧⌘E / ⇧Ctrl+E：四入口共用同一个导出面板，不静默导出。 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== 'e') {
        return;
      }
      if (!activeNote || dialog || exportResult) {
        return;
      }
      event.preventDefault();
      openExportDialog(activeNote);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeNote, dialog, exportResult, openExportDialog]);

  // 模态统一由共享 Modal 的 FocusTrap 在 document 捕获阶段消费 Esc；
  // 知识页调度器只负责模态之外的层级，不重复关闭。
  const closeRailPanel = (kind: Exclude<PanelKind, 'style'>) => {
    setPanel(null);
    focusRailPanelTrigger(kind);
  };

  const togglePanel = (kind: PanelKind) => {
    if (!activeNote) {
      return;
    }
    setPanel((current) => (current === kind ? null : kind));
    // 窄屏由「工具」抽屉进入；打开面板时收起抽屉，避免双层浮窗。
    if (kind !== 'style' && narrowLayout) {
      setToolsOpen(false);
    }
  };

  const openToolsDrawer = () => {
    // 抽屉是窄屏模态；打开时关闭同位置的右栏浮窗。
    setPanel(null);
    setToolsOpen(true);
  };

  const toggleReadingMode = () => {
    if (!activeNote || noteInTrash) {
      return;
    }
    if (immersive) {
      exitImmersive();
      return;
    }
    setReadingMode((current) => !current);
    setPanel(null);
  };

  const toggleFocus = () => {
    if (!activeNote) {
      return;
    }
    const next = !focusMode;
    setFocusMode(next);
    if (next) {
      // 专注与展开互斥：进入专注时退出展开，避免两个布局态互相覆盖。
      setContentExpanded(false);
    }
    setPanel(null);
  };

  const ignorePromise = (result: unknown) => {
    if (
      result &&
      typeof (result as Promise<void>).catch === 'function'
    ) {
      void (result as Promise<void>).catch(() => undefined);
    }
  };

  const leaveNativeFullscreen = () => {
    if (
      typeof document !== 'undefined' &&
      document.fullscreenElement &&
      typeof document.exitFullscreen === 'function'
    ) {
      ignorePromise(document.exitFullscreen());
    }
  };

  const exitImmersive = () => {
    setImmersive(false);
    setReadingMode(readingBeforeImmersive);
    // 恢复进入全屏前的布局：展开/专注都按进入前状态还原，不恢复面板。
    setFocusMode(focusBeforeImmersive);
    if (expandedBeforeImmersive && canExpandLayout) {
      // 从展开进入全屏：退出后还原展开，并把焦点/滚动还给进入前的位置。
      pendingExpandFocusRef.current = 'restore';
      expandScrollRef.current =
        paperRef.current?.querySelector<HTMLElement>('.zxe-body')?.scrollTop ??
        expandScrollRef.current;
    }
    setContentExpanded(expandedBeforeImmersive && canExpandLayout);
    leaveNativeFullscreen();
  };

  const toggleImmersive = () => {
    if (!activeNote) {
      return;
    }
    if (immersive) {
      exitImmersive();
      return;
    }
    setReadingBeforeImmersive(readingMode);
    setFocusBeforeImmersive(focusMode);
    setExpandedBeforeImmersive(contentExpanded);
    if (contentExpanded) {
      expandReturnFocusRef.current =
        typeof document !== 'undefined' &&
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      expandScrollRef.current =
        paperRef.current?.querySelector<HTMLElement>('.zxe-body')?.scrollTop ??
        0;
    }
    setReadingMode(true);
    setFocusMode(false);
    setContentExpanded(false);
    setPanel(null);
    setImmersive(true);
    const shell = shellRef.current;
    if (shell && typeof shell.requestFullscreen === 'function') {
      ignorePromise(shell.requestFullscreen());
    }
  };

  // F11 与「更多 → 全屏阅读」同一入口；浏览器拒绝原生全屏时仍进入沉浸布局。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'F11' ||
        !activeNote ||
        dialog ||
        exportResult ||
        helpOpen
      ) {
        return;
      }
      event.preventDefault();
      toggleImmersive();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeNote,
    canExpandLayout,
    contentExpanded,
    dialog,
    expandedBeforeImmersive,
    exportResult,
    focusBeforeImmersive,
    focusMode,
    helpOpen,
    immersive,
    readingBeforeImmersive,
    readingMode,
  ]);

  // 浏览器原生 Esc 退出全屏时，同步退出沉浸布局并恢复进入前布局。
  // Esc 本身由知识页统一调度器消费，这里不再注册第二个 keydown。
  useEffect(() => {
    if (!immersive || typeof document === 'undefined') {
      return;
    }
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) {
        exitImmersive();
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [
    canExpandLayout,
    expandedBeforeImmersive,
    exitImmersive,
    focusBeforeImmersive,
    immersive,
    readingBeforeImmersive,
  ]);

  const createBoardNote = async () => {
    if (!activeNote) {
      return;
    }
    const create = noteSource.create;
    const update = noteSource.update;
    if (!create || !update) {
      showToast('当前数据源不支持新建画板', 'error');
      return;
    }
    try {
      const note = await create({
        title: '未命名画板',
        folderId: activeNote.folderId ?? NOTE_FOLDERS[0]?.id ?? null,
        body: '<p>在这里记录画板的背景与结论。</p>',
        bodyFormat: 'html',
      });
      const board = await boardRepository.create({
        noteId: note.id,
        title: '未命名画板',
      });
      const intro = createBlock('paragraph', note.id);
      intro.payload = {
        runs: [{ text: '在这里记录画板的背景与结论。' }],
      };
      const boardBlock = createBlock('board', note.id);
      boardBlock.payload = {
        boardId: board.boardId,
        title: board.title,
      };
      const blocks = [intro, boardBlock];
      await blockRepository.saveDocument(
        note.id,
        blocks.map((block) => ({
          id: block.id,
          type: block.type,
          payload: block.payload,
        })),
      );
      const updated = await update(
        note.id,
        toNoteUpdate(note, { body: blocksToHtml(blocks) }),
      );
      // 不在知识页短暂挂载新笔记的块编辑器：直接进入画板，
      // 否则编辑器会在跳转前补一个尾随空段落。
      commitNotes(sortNotes([updated, ...notesRef.current]));
      showToast('已新建画板');
      navigate(
        `/board/${encodeURIComponent(board.boardId)}?note=${encodeURIComponent(
          note.id,
        )}`,
      );
    } catch (reason) {
      showToast(formatError(reason), 'error');
    }
  };

  const openBoard = (board: BoardSummary) => {
    const note = board.noteId ? notesById.get(board.noteId) : undefined;
    const query =
      note && !isTrashedNote(note)
        ? `?note=${encodeURIComponent(note.id)}`
        : '';
    navigate(`/board/${encodeURIComponent(board.id)}${query}`);
  };

  /** 打开孤儿画板的关联/删除弹层；默认选中第一篇可用笔记。 */
  const openBoardDialog = (
    kind: 'associate' | 'delete',
    board: BoardSummary,
  ) => {
    const firstNote = notes.find((note) => !isTrashedNote(note));
    setBoardDialogNoteId(firstNote?.id ?? '');
    setBoardDialogError(null);
    setBoardDialog({ kind, boardId: board.id });
  };

  const closeBoardDialog = () => {
    setBoardDialog(null);
    setBoardDialogNoteId('');
    setBoardDialogError(null);
  };

  /**
   * 把孤儿画板关联到笔记：写回 `boards.note_id`，并在笔记末尾追加
   * 一个 `board` 块；旧版 HTML 正文先转成块，避免关联时丢正文。
   */
  const confirmAssociateBoard = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    if (!boardDialog || boardDialog.kind !== 'associate') {
      return;
    }
    const board = boards.find((item) => item.id === boardDialog.boardId);
    const note = notesById.get(boardDialogNoteId);
    const update = noteSource.update;
    if (!board || !note || isTrashedNote(note)) {
      setBoardDialogError('请选择一篇未删除的笔记');
      return;
    }
    if (!update) {
      setBoardDialogError('当前数据源不支持关联画板');
      return;
    }
    try {
      // 先落盘当前正文，避免关联后旧编辑器状态把新画板块覆盖掉。
      await flushBodyRef.current?.();
      const document = await boardRepository.load(board.id);
      await boardRepository.save(board.id, { ...document, noteId: note.id });

      const existing = await blockRepository.list(note.id);
      const drafts = (
        existing.length > 0
          ? existing.map((block) => ({
              id: block.id,
              type: block.type,
              payload: block.payload,
              schemaVersion: block.schemaVersion,
            }))
          : pastedBlocksFromHtml(note.body).map((item) => {
              const block = createBlock(item.type, note.id);
              block.payload = item.payload;
              return {
                id: block.id,
                type: block.type,
                payload: block.payload,
              };
            })
      ).slice();
      if (
        !drafts.some(
          (block) =>
            block.type === 'board' && block.payload.boardId === board.id,
        )
      ) {
        const boardBlock = createBlock('board', note.id);
        boardBlock.payload = { boardId: board.id, title: document.title };
        drafts.push({
          id: boardBlock.id,
          type: boardBlock.type,
          payload: boardBlock.payload,
        });
      }
      const savedBlocks = await blockRepository.saveDocument(note.id, drafts);
      const nextHtml = blocksToHtml(savedBlocks);
      const callout = extractTaskCalloutHtml(note.body);
      const body =
        callout && !nextHtml.includes('zx-task-backlink')
          ? `${callout}${nextHtml}`
          : nextHtml;
      const updated = await update(note.id, toNoteUpdate(note, { body }));
      commitNotes(
        sortNotes(
          notesRef.current.map((item) =>
            item.id === updated.id ? updated : item,
          ),
        ),
      );
      await refreshBoards();
      if (activeNote?.id === note.id) {
        // 编辑器内存里还没有新画板块，重挂一次从仓储读回完整正文。
        setEditorReloadToken((token) => token + 1);
      }
      closeBoardDialog();
      showToast('已关联到笔记');
    } catch (reason) {
      setBoardDialogError(formatError(reason));
    }
  };

  /** 删除孤儿画板：只在应用内二次确认，不动笔记正文与其它画板。 */
  const confirmDeleteBoard = async () => {
    if (!boardDialog || boardDialog.kind !== 'delete') {
      return;
    }
    const board = boards.find((item) => item.id === boardDialog.boardId);
    if (!board) {
      setBoardDialogError('画板不存在或已被删除');
      return;
    }
    try {
      await boardRepository.remove(board.id);
      await refreshBoards();
      closeBoardDialog();
      showToast('已删除画板');
    } catch (reason) {
      setBoardDialogError(formatError(reason));
    }
  };

  const copyText = async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMessage);
    } catch {
      showToast(t('menu.toast.copyFailed'), 'error');
    }
  };

  const copyNoteLink = (note: Note) => {
    void copyText(`zhixing://note/${note.id}`, t('menu.toast.linkCopied'));
  };

  const copyNoteBody = (note: Note) => {
    if (!requireUnlocked(note, '复制正文')) return;
    void copyText(htmlToPlainText(note.body), '已复制笔记正文');
  };

  const openMenu = (
    target: MenuTarget,
    x: number,
    y: number,
    trigger: HTMLElement | null,
    focusOnOpen: boolean,
  ) => {
    setContextMenu({ target, x, y, trigger, focusOnOpen });
  };

  const openRowMenu = (
    event: ReactMouseEvent<HTMLElement>,
    note: Note,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openMenu(
      { kind: 'note', noteId: note.id },
      event.clientX,
      event.clientY,
      event.currentTarget.querySelector<HTMLElement>('.kn-note-open'),
      false,
    );
  };

  const openMoreMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    note: Note,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu(
      { kind: 'note', noteId: note.id },
      rect.right - 4,
      rect.bottom + 4,
      event.currentTarget,
      false,
    );
  };

  /** Shift+F10 / Menu 键：在来源元素下方打开同一份上下文菜单。 */
  const openMenuFromKeyboard = (
    event: ReactKeyboardEvent<HTMLElement>,
    target: MenuTarget,
  ) => {
    if (
      event.key !== 'ContextMenu' &&
      !(event.shiftKey && event.key === 'F10')
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget;
    const rect = trigger.getBoundingClientRect();
    openMenu(target, rect.left + 8, rect.bottom + 4, trigger, true);
  };

  const openTabMenu = (
    event: ReactMouseEvent<HTMLElement>,
    note: Note,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openMenu(
      { kind: 'tab', noteId: note.id },
      event.clientX,
      event.clientY,
      event.currentTarget.querySelector<HTMLElement>('[role="tab"]'),
      false,
    );
  };

  const openTreeMenu = (
    event: ReactMouseEvent<HTMLElement>,
    tree: TreeMenuTarget,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openMenu(
      { kind: 'tree', tree },
      event.clientX,
      event.clientY,
      event.currentTarget,
      false,
    );
  };

  const closeContextMenu = (reason: ContextMenuCloseReason) => {
    const trigger = contextMenu?.trigger ?? null;
    setContextMenu(null);
    if (reason === 'outside' || reason === 'tab') {
      return;
    }
    const restore = () => {
      // 菜单命令打开模态时，焦点应交给模态，不抢回来源行。
      if (reason === 'select' && document.querySelector('[role="dialog"]')) {
        return;
      }
      if (trigger?.isConnected) {
        trigger.focus();
      }
    };
    if (reason === 'escape' || reason === 'reposition') {
      restore();
    } else {
      window.setTimeout(restore, 0);
    }
  };

  const menuNote = (() => {
    if (!contextMenu) {
      return null;
    }
    const { target } = contextMenu;
    if (target.kind !== 'note' && target.kind !== 'tab') {
      return null;
    }
    return notes.find((note) => note.id === target.noteId) ?? null;
  })();

  const treeMenuItems = (tree: TreeMenuTarget): ContextMenuItem[] => {
    const folderId = tree.kind === 'folder' ? tree.folderId : undefined;
    const items: ContextMenuItem[] = [
      {
        id: 'tree-new',
        labelKey: 'menu.tree.newNote',
        icon: '＋',
        shortcut: 'Mod+N',
        onSelect: () => {
          void createNote(folderId);
        },
      },
    ];
    if (tree.kind !== 'blank') {
      items.push({
        id: 'tree-open',
        labelKey: 'menu.tree.openInList',
        icon: '↗',
        shortcut: 'Enter',
        onSelect: () => {
          setView(
            tree.kind === 'folder'
              ? tree.folderId
                ? (`folder:${tree.folderId}` as NoteView)
                : 'folder:uncategorized'
              : tree.view,
          );
        },
      });
    }
    items.push({
      id: 'tree-refresh',
      labelKey: 'menu.tree.refresh',
      icon: '↻',
      shortcut: 'Mod+R',
      onSelect: () => {
        void load();
      },
    });
    if (tree.kind !== 'blank') {
      items.push(
        { divider: true },
        {
          id: 'tree-copy-name',
          labelKey: 'menu.tree.copyFolderName',
          icon: '⌁',
          disabled: tree.kind !== 'folder',
          onSelect: () => {
            if (tree.kind === 'folder') {
              void copyText(tree.name, t('menu.toast.copied'));
            }
          },
        },
      );
    }
    return items;
  };

  const tabMenuItems = (note: Note): ContextMenuItem[] => {
    const trashed = isTrashedNote(note);
    const items: ContextMenuItem[] = [
      {
        id: 'tab-close',
        labelKey: 'menu.tab.close',
        icon: '×',
        shortcut: 'Mod+W',
        onSelect: () => closeTab(note.id),
      },
      {
        id: 'tab-close-others',
        labelKey: 'menu.tab.closeOthers',
        disabled: displayTabs.length <= 1,
        hintKey: 'menu.hint.oneTab',
        onSelect: () => closeOtherTabs(note.id),
      },
      {
        id: 'tab-close-all',
        labelKey: 'menu.tab.closeAll',
        onSelect: closeAllTabs,
      },
      { divider: true },
      {
        id: 'tab-copy-link',
        labelKey: 'menu.tab.copyLink',
        icon: '⌁',
        shortcut: 'Mod+Shift+L',
        onSelect: () => copyNoteLink(note),
      },
      {
        id: 'tab-locate',
        labelKey: 'menu.tab.locateInList',
        icon: '▤',
        onSelect: () => locateNoteInList(note),
      },
      {
        id: 'tab-pin',
        labelKey: note.pinned ? 'menu.tab.unpin' : 'menu.tab.pin',
        icon: '⌖',
        disabled: trashed,
        onSelect: () => {
          void togglePinned(note);
        },
      },
      {
        id: 'tab-favorite',
        labelKey: note.favorite ? 'menu.tab.unfavorite' : 'menu.tab.favorite',
        icon: note.favorite ? '★' : '☆',
        disabled: trashed,
        onSelect: () => {
          void toggleFavorite(note);
        },
      },
      { divider: true },
      {
        id: 'tab-rename',
        labelKey: 'menu.tab.rename',
        icon: 'Aa',
        disabled: trashed,
        onSelect: () => openRename(note),
      },
      {
        id: 'tab-export',
        labelKey: 'menu.tab.export',
        icon: '⇩',
        onSelect: () => openExportDialog(note),
      },
    ];
    return items;
  };

  const noteMenuItems = (note: Note): ContextMenuItem[] => {
    if (isTrashedNote(note)) {
      return [
        {
          id: 'restore',
          labelKey: 'menu.note.restore',
          icon: '↩',
          onSelect: () => {
            void restoreNote(note);
          },
        },
        {
          id: 'copy-link',
          labelKey: 'menu.note.copyLink',
          icon: '⌁',
          shortcut: 'Mod+Shift+L',
          onSelect: () => copyNoteLink(note),
        },
        { divider: true },
        {
          id: 'export',
          labelKey: 'menu.note.exportSnapshot',
          icon: '⇩',
          onSelect: () => openExportDialog(note),
        },
      ];
    }
    return [
      {
        id: 'open',
        labelKey: 'menu.note.open',
        icon: '↗',
        shortcut: 'Enter',
        onSelect: () => openNoteInCurrentTab(note.id),
      },
      {
        id: 'open-new',
        labelKey: 'menu.note.openNew',
        icon: '⧉',
        shortcut: 'Mod+Enter',
        onSelect: () => openNote(note.id),
      },
      { divider: true },
      {
        id: 'pin',
        labelKey: note.pinned ? 'menu.note.unpin' : 'menu.note.pin',
        icon: '⌖',
        onSelect: () => {
          void togglePinned(note);
        },
      },
      {
        id: 'favorite',
        labelKey: note.favorite
          ? 'menu.note.unfavorite'
          : 'menu.note.favorite',
        icon: note.favorite ? '★' : '☆',
        onSelect: () => {
          void toggleFavorite(note);
        },
      },
      {
        id: 'copy-link',
        labelKey: 'menu.note.copyLink',
        icon: '⌁',
        shortcut: 'Mod+Shift+L',
        onSelect: () => copyNoteLink(note),
      },
      {
        id: 'copy-body',
        labelKey: 'menu.note.copyBody',
        icon: '▤',
        onSelect: () => copyNoteBody(note),
      },
      { divider: true },
      {
        id: 'move',
        labelKey: 'menu.note.move',
        icon: '⇄',
        onSelect: () => openMove(note),
      },
      {
        id: 'rename',
        labelKey: 'menu.note.rename',
        icon: 'Aa',
        shortcut: 'F2',
        onSelect: () => openRename(note),
      },
      {
        id: 'export',
        labelKey: 'menu.note.export',
        icon: '⇩',
        onSelect: () => openExportDialog(note),
      },
      { divider: true },
      {
        id: 'delete',
        labelKey: 'menu.note.delete',
        icon: '⌫',
        shortcut: 'Delete',
        danger: true,
        onSelect: () => requestDelete(note),
      },
    ];
  };

  const menuLabelKey: MenuKey =
    contextMenu?.target.kind === 'tree'
      ? 'menu.label.tree'
      : contextMenu?.target.kind === 'tab'
        ? 'menu.label.tab'
        : 'menu.label.note';

  const menuItems: ContextMenuItem[] = (() => {
    if (!contextMenu) {
      return [];
    }
    if (contextMenu.target.kind === 'tree') {
      return treeMenuItems(contextMenu.target.tree);
    }
    if (!menuNote) {
      return [];
    }
    return contextMenu.target.kind === 'tab'
      ? tabMenuItems(menuNote)
      : noteMenuItems(menuNote);
  })();

  const activeNotes = notes.filter((note) => !isTrashedNote(note));
  const trashedNotes = notes.filter(isTrashedNote);
  /** 插入内链选择器：可链接到其他未删除笔记，不提供自链接。 */
  const linkNoteOptions = activeNotes
    .filter((note) => note.id !== activeNote?.id)
    .map((note) => ({ id: note.id, title: note.title }));
  const favorites = activeNotes.filter((note) => note.favorite);
  const pinned = activeNotes.filter((note) => note.pinned);
  const visibleNotes = sortNotes(notesForView(notes, view));
  const tags = Array.from(
    new Set(activeNotes.flatMap((note) => note.tags)),
  ).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const uncategorizedCount = activeNotes.filter(
    (note) => !note.folderId,
  ).length;
  const backlink = activeNote ? extractTaskBacklink(activeNote.body) : null;
  const dialogNote = dialog
    ? notes.find((note) => note.id === dialog.noteId) ?? null
    : null;
  const boardDialogBoard = boardDialog
    ? boards.find((board) => board.id === boardDialog.boardId) ?? null
    : null;
  const importDefaultFolderId = view.startsWith('folder:')
    ? folderIdOfView(view) ?? null
    : null;
  const saveLabel =
    saveState === 'saving'
      ? '● 编辑中…'
      : saveState === 'error'
        ? '● 保存失败'
        : '● 已保存到本机';

  const treeEntryClass = (target: NoteView) =>
    view === target ? 'kn-tree-item is-active' : 'kn-tree-item';

  const getEditorScroller = () =>
    paperRef.current?.querySelector<HTMLElement>('.zxe-body') ?? null;

  /**
   * 展开/还原的唯一切换点：记录焦点与正文滚动，状态变化后再落地。
   * 展开时只收左树/列表；右栏、Tabs、命令栏保持可用。
   */
  const setContentExpandedSafe = useCallback(
    (next: boolean) => {
      if (next === contentExpanded) {
        return;
      }
      if (next) {
        if (!canExpandLayout) {
          showToast('当前窗口已无可收起列，Esc 只关闭上层浮层');
          return;
        }
        const active =
          typeof document !== 'undefined' ? document.activeElement : null;
        expandReturnFocusRef.current =
          active instanceof HTMLElement ? active : null;
        expandScrollRef.current = getEditorScroller()?.scrollTop ?? 0;
        pendingExpandFocusRef.current =
          active instanceof HTMLElement &&
          Boolean(active.closest('.kn-tree, .kn-list'))
            ? 'editor'
            : null;
        // 先移走焦点再收列，避免 aria-hidden/inert 命中仍持有焦点的元素。
        if (pendingExpandFocusRef.current === 'editor') {
          paperRef.current?.focus({ preventScroll: true });
        }
        // 展开与专注互斥：进入展开即退出专注。
        setFocusMode(false);
        setContentExpanded(true);
        return;
      }
      expandScrollRef.current =
        getEditorScroller()?.scrollTop ?? expandScrollRef.current;
      pendingExpandFocusRef.current = 'restore';
      setContentExpanded(false);
    },
    [canExpandLayout, contentExpanded, showToast],
  );

  const toggleContentExpanded = useCallback(() => {
    setContentExpandedSafe(!contentExpanded);
  }, [contentExpanded, setContentExpandedSafe]);

  // 列宽过渡结束后再迁移焦点/还原滚动，避免在 visibility:hidden 上留焦点。
  useEffect(() => {
    const pending = pendingExpandFocusRef.current;
    if (pending === null) {
      if (contentExpanded) {
        const scroller = getEditorScroller();
        if (scroller) {
          scroller.scrollTop = expandScrollRef.current;
        }
      }
      return;
    }
    pendingExpandFocusRef.current = null;
    const scroller = getEditorScroller();
    if (scroller) {
      scroller.scrollTop = expandScrollRef.current;
    }
    if (pending === 'editor') {
      paperRef.current?.focus({ preventScroll: true });
      return;
    }
    const target = expandReturnFocusRef.current;
    if (
      target &&
      target.isConnected &&
      !target.closest('[aria-hidden="true"]')
    ) {
      target.focus({ preventScroll: true });
    } else {
      paperRef.current?.focus({ preventScroll: true });
    }
  }, [contentExpanded]);

  // 沉浸/专注/展开非法叠加时归一化为最高优先级：沉浸 > 专注 > 展开。
  useEffect(() => {
    if (!immersive) {
      return;
    }
    if (focusMode) {
      setFocusMode(false);
    }
    if (contentExpanded) {
      setContentExpanded(false);
    }
  }, [contentExpanded, focusMode, immersive]);

  /**
   * 知识页唯一的 Esc 调度器（window 冒泡）。
   * 优先级：输入控件 → 模态 → 工具抽屉 → 浮窗 → 编辑器临时层 →
   * 沉浸 → 专注 → 展开/还原。每次按键只消费一层。
   * 菜单与共享 Modal 在自己的 document 处理器里 stopPropagation，
   * 因此不会到达这里；这里保留模态兜底以覆盖程序化事件。
   */
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.repeat
      ) {
        return;
      }
      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      // P1 模态：FocusTrap 通常已在捕获阶段处理；这里兜底并阻止下沉。
      if (dialog || helpOpen || exportResult || boardDialog || importOpen) {
        consume();
        if (exportBusy) {
          return;
        }
        if (dialog) {
          setDialog(null);
          setDialogError(null);
          setExportNotice(null);
        } else if (helpOpen) {
          setHelpOpen(false);
        } else if (exportResult) {
          setExportResult(null);
        } else if (boardDialog) {
          closeBoardDialog();
        } else if (importOpen) {
          setImportOpen(false);
        }
        return;
      }

      // P0 输入控件/公式/代码/表格单元格：优先于抽屉/浮窗/布局，
      // 保留局部取消语义。沉浸阅读是只读全屏态，Esc 必须能退出。
      if (!immersive && ownsEscapeInput(event.target)) {
        return;
      }

      // P3 工具抽屉：关闭后由 CommandBar 把焦点还给「工具」。
      if (toolsOpen) {
        consume();
        setToolsOpen(false);
        return;
      }

      // P4 右栏浮窗 / 样式面板：关闭并归还触发按钮焦点。
      if (panel && panel !== 'style') {
        consume();
        closeRailPanel(panel);
        return;
      }
      if (panel === 'style') {
        consume();
        setPanel(null);
        return;
      }

      // P5 编辑器临时层（链接/引用/移动弹窗、块菜单、划词条、表格工具条等）
      // 由编辑器自己关闭；知识页不抢同一次按键。
      if (editorOwnsEscape()) {
        return;
      }

      // P6 沉浸阅读：退出并恢复进入前布局，不进入展开。
      if (immersive) {
        consume();
        exitImmersive();
        return;
      }

      // P7 专注：退出专注，不自动进入展开。
      if (focusMode) {
        consume();
        setFocusMode(false);
        // 编辑器自己的 Esc 处理通常已把焦点留在正文；只有焦点落到
        // body/document 时才补一个可见落点，避免抢走编辑光标。
        if (
          typeof document !== 'undefined' &&
          (!document.activeElement ||
            document.activeElement === document.body ||
            document.activeElement === document.documentElement)
        ) {
          paperRef.current?.focus({ preventScroll: true });
        }
        return;
      }

      // P8/P9 展开与还原。
      consume();
      setContentExpandedSafe(!contentExpanded);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    boardDialog,
    canExpandLayout,
    closeBoardDialog,
    closeRailPanel,
    contentExpanded,
    dialog,
    exitImmersive,
    exportBusy,
    exportResult,
    focusMode,
    helpOpen,
    immersive,
    importOpen,
    panel,
    setContentExpandedSafe,
    toolsOpen,
  ]);

  /**
   * 右栏与窄屏抽屉共用同一份 9 项定义（ZX-DESIGN-15 §3.1）。
   * 顺序、aria-label、禁用条件、handler 只有这一处，避免两套入口漂移。
   */
  const knowledgeTools: ReadonlyArray<{
    key: string;
    label: string;
    caption: string;
    title: string;
    icon: IconName;
    group: 1 | 2 | 3;
    pressed?: boolean;
    disabled: boolean;
    onSelect: () => void;
  }> = [
    {
      key: 'reading',
      label: readingMode ? '编辑模式' : '阅读模式',
      caption: readingMode ? '编辑' : '阅读',
      title: readingMode ? '编辑模式（⇧⌘R）' : '阅读模式（⇧⌘R）',
      icon: readingMode ? 'note-edit' : 'note-read',
      group: 1,
      pressed: readingMode,
      disabled: !activeNote || noteInTrash,
      onSelect: toggleReadingMode,
    },
    {
      key: 'style',
      label: '样式',
      caption: '样式',
      title: '样式（Alt+F10）',
      icon: 'note-style',
      group: 1,
      pressed: panel === 'style',
      disabled: !activeNote || editorReadOnly,
      onSelect: () => togglePanel('style'),
    },
    {
      key: 'links',
      label: '笔记链接',
      caption: '链接',
      title: '笔记链接：内链与反向链接',
      icon: 'note-link',
      group: 2,
      pressed: panel === 'links',
      disabled: !activeNote,
      onSelect: () => togglePanel('links'),
    },
    {
      key: 'outline',
      label: '大纲',
      caption: '大纲',
      title: '大纲',
      icon: 'note-outline',
      group: 2,
      pressed: panel === 'outline',
      disabled: !activeNote,
      onSelect: () => togglePanel('outline'),
    },
    {
      key: 'info',
      label: '笔记信息',
      caption: '信息',
      title: '笔记信息',
      icon: 'note-info',
      group: 2,
      pressed: panel === 'info',
      disabled: !activeNote,
      onSelect: () => togglePanel('info'),
    },
    {
      key: 'attachment',
      label: '附件',
      caption: '附件',
      title: '附件',
      icon: 'note-attachment',
      group: 2,
      pressed: panel === 'attachment',
      disabled: !activeNote,
      onSelect: () => togglePanel('attachment'),
    },
    {
      key: 'focus',
      label: '专注模式',
      caption: '专注',
      title: '专注模式（⌘⇧F）',
      icon: 'note-focus',
      group: 3,
      pressed: focusMode,
      disabled: !activeNote,
      onSelect: toggleFocus,
    },
    {
      key: 'board',
      label: '新建画板',
      caption: '画板',
      title: '新建画板',
      icon: 'note-board',
      group: 3,
      disabled: !canCreateBoard,
      onSelect: () => void createBoardNote(),
    },
    {
      key: 'immersive',
      label: '全屏阅读',
      caption: '全屏',
      title: '全屏阅读（F11）',
      icon: 'note-fullscreen',
      group: 3,
      pressed: immersive,
      disabled: !activeNote,
      onSelect: toggleImmersive,
    },
  ];

  const toolStatus = (tool: (typeof knowledgeTools)[number]) => {
    if (tool.key === 'reading') {
      return readingMode ? '已开启' : '';
    }
    if (tool.key === 'focus') {
      return focusMode ? '已开启' : '';
    }
    if (tool.key === 'immersive') {
      return immersive ? '已开启' : '';
    }
    return tool.pressed ? '已打开' : '';
  };

  return (
    <section
      ref={shellRef}
      className={
        immersive ? 'knowledge-shell is-immersive' : 'knowledge-shell'
      }
      aria-labelledby="knowledge-title"
    >
      <h1 id="knowledge-title" className="kn-sr-only">
        知识
      </h1>
      <span className="kn-sr-only">全高工作区 · 顶栏隐藏</span>

      {immersive ? (
        <button
          type="button"
          className="kn-immersive-exit"
          aria-label="退出全屏阅读"
          onClick={exitImmersive}
        >
          ⛶ 退出全屏
        </button>
      ) : null}

      {status === 'unavailable' ? (
        <div className="task-state-card kn-state-card" role="status">
          <span className="task-state-mark" aria-hidden="true">
            库
          </span>
          <h2>需在桌面壳内使用本地笔记库</h2>
          <p>
            知识数据保存在本机 SQLite，浏览器预览没有 Tauri IPC 通道。请使用
            <code>pnpm --filter app tauri dev</code>
            启动桌面壳后再查看笔记。
          </p>
          <p className="task-state-note">
            这里不会回退到 localStorage，也不会生成演示数据。
          </p>
        </div>
      ) : null}

      {status === 'loading' ? (
        <div className="task-state-card kn-state-card" role="status" aria-live="polite">
          <h2>正在读取本地笔记库…</h2>
          <p>笔记与目录从本机 SQLite 读取。</p>
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="task-state-card kn-state-card" role="alert">
          <h2>笔记读取失败</h2>
          <p>{error ?? '未知错误，请稍后重试。'}</p>
          <button type="button" className="task-button" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      {status === 'ready' ? (
        <div
          className={`kn-workspace${focusMode ? ' is-focus' : ''}${
            expandedActive ? ' is-expanded' : ''
          }`}
          data-expanded={expandedActive ? 'true' : 'false'}
        >
          <nav
            className="kn-tree"
            aria-label="知识目录"
            aria-hidden={expandedActive ? true : undefined}
            inert={expandedActive ? true : undefined}
            onContextMenu={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest('button')
              ) {
                return;
              }
              openTreeMenu(event, { kind: 'blank' });
            }}
          >
            <div className="kn-tree-head">
              <span>笔记</span>
              <button
                type="button"
                className="kn-icon-button"
                aria-label="新建笔记"
                title="新建笔记"
                onClick={() => void createNote()}
              >
                ＋
              </button>
            </div>
            <button
              type="button"
              className={treeEntryClass('all')}
              aria-label="全部笔记"
              aria-pressed={view === 'all'}
              onClick={() => setView('all')}
              onContextMenu={(event) =>
                openTreeMenu(event, { kind: 'system', view: 'all' })
              }
              onKeyDown={(event) =>
                openMenuFromKeyboard(event, {
                  kind: 'tree',
                  tree: { kind: 'system', view: 'all' },
                })
              }
            >
              <span className="kn-tree-icon" aria-hidden="true">
                ▣
              </span>
              <span className="kn-tree-label">全部笔记</span>
              <span className="kn-tree-count">{activeNotes.length}</span>
            </button>
            <button
              type="button"
              className={treeEntryClass('favorites')}
              aria-label="收藏"
              aria-pressed={view === 'favorites'}
              onClick={() => setView('favorites')}
              onContextMenu={(event) =>
                openTreeMenu(event, { kind: 'system', view: 'favorites' })
              }
              onKeyDown={(event) =>
                openMenuFromKeyboard(event, {
                  kind: 'tree',
                  tree: { kind: 'system', view: 'favorites' },
                })
              }
            >
              <span className="kn-tree-icon" aria-hidden="true">
                ☆
              </span>
              <span className="kn-tree-label">收藏</span>
              <span className="kn-tree-count">{favorites.length}</span>
            </button>
            <button
              type="button"
              className={treeEntryClass('pinned')}
              aria-label="置顶"
              aria-pressed={view === 'pinned'}
              onClick={() => setView('pinned')}
              onContextMenu={(event) =>
                openTreeMenu(event, { kind: 'system', view: 'pinned' })
              }
              onKeyDown={(event) =>
                openMenuFromKeyboard(event, {
                  kind: 'tree',
                  tree: { kind: 'system', view: 'pinned' },
                })
              }
            >
              <span className="kn-tree-icon" aria-hidden="true">
                📌
              </span>
              <span className="kn-tree-label">置顶</span>
              <span className="kn-tree-count">{pinned.length}</span>
            </button>
            <button
              type="button"
              className={treeEntryClass('trash')}
              aria-label="回收站"
              aria-pressed={view === 'trash'}
              onClick={() => setView('trash')}
              onContextMenu={(event) =>
                openTreeMenu(event, { kind: 'system', view: 'trash' })
              }
              onKeyDown={(event) =>
                openMenuFromKeyboard(event, {
                  kind: 'tree',
                  tree: { kind: 'system', view: 'trash' },
                })
              }
            >
              <span className="kn-tree-icon" aria-hidden="true">
                ⌫
              </span>
              <span className="kn-tree-label">回收站</span>
              <span className="kn-tree-count">{trashedNotes.length}</span>
            </button>

            <div className="kn-tree-group">目录</div>
            {NOTE_FOLDERS.map((folder) => {
              const target = `folder:${folder.id}` as NoteView;
              const count = activeNotes.filter(
                (note) => note.folderId === folder.id,
              ).length;
              return (
                <button
                  key={folder.id}
                  type="button"
                  className={treeEntryClass(target)}
                  aria-label={`目录：${folder.name}`}
                  aria-pressed={view === target}
                  onClick={() => setView(target)}
                  onContextMenu={(event) =>
                    openTreeMenu(event, {
                      kind: 'folder',
                      folderId: folder.id,
                      name: folder.name,
                    })
                  }
                  onKeyDown={(event) =>
                    openMenuFromKeyboard(event, {
                      kind: 'tree',
                      tree: {
                        kind: 'folder',
                        folderId: folder.id,
                        name: folder.name,
                      },
                    })
                  }
                >
                  <span className="kn-tree-icon" aria-hidden="true">
                    ▸
                  </span>
                  <span className="kn-tree-label">{folder.name}</span>
                  <span className="kn-tree-count">{count}</span>
                </button>
              );
            })}
            {uncategorizedCount > 0 ? (
              <button
                type="button"
                className={treeEntryClass('folder:uncategorized')}
                aria-label="目录：未分类"
                aria-pressed={view === 'folder:uncategorized'}
                onClick={() => setView('folder:uncategorized')}
                onContextMenu={(event) =>
                  openTreeMenu(event, {
                    kind: 'folder',
                    folderId: null,
                    name: '未分类',
                  })
                }
                onKeyDown={(event) =>
                  openMenuFromKeyboard(event, {
                    kind: 'tree',
                    tree: {
                      kind: 'folder',
                      folderId: null,
                      name: '未分类',
                    },
                  })
                }
              >
                <span className="kn-tree-icon" aria-hidden="true">
                  ▸
                </span>
                <span className="kn-tree-label">未分类</span>
                <span className="kn-tree-count">{uncategorizedCount}</span>
              </button>
            ) : null}

            <div className="kn-tree-group">标签</div>
            <div className="kn-tag-cloud">
              {tags.length > 0 ? (
                tags.map((tag) => (
                  <span className="kn-tag" key={tag}>
                    #{tag}
                  </span>
                ))
              ) : (
                <span className="kn-tree-hint">暂无标签</span>
              )}
            </div>

            {/*
              孤儿画板兜底入口：画板不再有顶层导航，来源笔记删除或
              正文引用移除后仍可从这里打开、关联或删除，不静默丢数据。
            */}
            {orphanBoards.length > 0 ? (
              <>
                <div className="kn-tree-group">画板</div>
                <button
                  type="button"
                  className={treeEntryClass('boards:orphan')}
                  aria-label="未关联画板"
                  aria-pressed={view === 'boards:orphan'}
                  onClick={() => setView('boards:orphan')}
                >
                  <span className="kn-tree-icon" aria-hidden="true">
                    ▧
                  </span>
                  <span className="kn-tree-label">未关联画板</span>
                  <span className="kn-tree-count">{orphanBoards.length}</span>
                </button>
              </>
            ) : null}
          </nav>

          <section
            className="kn-list"
            aria-label={view === 'boards:orphan' ? '画板列表' : '笔记列表'}
            aria-hidden={expandedActive ? true : undefined}
            inert={expandedActive ? true : undefined}
          >
            <header className="kn-list-head">
              <div>
                <h2>{viewTitle(view)}</h2>
                <span>
                  {view === 'boards:orphan'
                    ? `${orphanBoards.length} 块`
                    : `${visibleNotes.length} 篇`}
                </span>
              </div>
              {view === 'boards:orphan' ? null : (
                <div className="kn-list-head-actions">
                <button
                  type="button"
                  className="kn-secondary-button"
                  onClick={() => setImportOpen(true)}
                >
                  导入笔记
                </button>
                <button
                  type="button"
                  className="kn-primary-button"
                  onClick={() => void createNote()}
                >
                  ＋ 新建
                </button>
                </div>
              )}
            </header>

            <div className="kn-note-list">
              {view === 'boards:orphan' ? (
                orphanBoards.length === 0 ? (
                  <div className="kn-empty-state">
                    <p className="kn-empty">{emptyCopy(view)}</p>
                  </div>
                ) : (
                  orphanBoards.map((board) => {
                    const sourceNote = board.noteId
                      ? notesById.get(board.noteId) ?? null
                      : null;
                    return (
                      <div
                        className="kn-note-row kn-orphan-row"
                        key={board.id}
                        data-board-id={board.id}
                      >
                        <button
                          type="button"
                          className="kn-note-open"
                          aria-label={`打开画板：${board.title}`}
                          onClick={() => openBoard(board)}
                        >
                          <span className="kn-note-title">
                            ▧ {board.title}
                          </span>
                          <span className="kn-note-meta">
                            <span>
                              {boardObjectCounts[board.id] ?? 0} 个对象
                            </span>
                            <span>{formatNoteDate(board.updatedAt)}</span>
                            <span>
                              {sourceNote
                                ? `来源：${sourceNote.title}`
                                : '未关联'}
                            </span>
                          </span>
                        </button>
                        <div className="kn-orphan-actions">
                          <button
                            type="button"
                            className="kn-secondary-button"
                            aria-label={`关联到笔记：${board.title}`}
                            onClick={() => openBoardDialog('associate', board)}
                          >
                            关联到笔记…
                          </button>
                          <button
                            type="button"
                            className="kn-danger-button"
                            aria-label={`删除画板：${board.title}`}
                            onClick={() => openBoardDialog('delete', board)}
                          >
                            删除画板…
                          </button>
                        </div>
                      </div>
                    );
                  })
                )
              ) : visibleNotes.length === 0 ? (
                <div className="kn-empty-state">
                  <p className="kn-empty">{emptyCopy(view)}</p>
                  <button
                    type="button"
                    className="kn-secondary-button"
                    onClick={() => setImportOpen(true)}
                  >
                    导入笔记
                  </button>
                </div>
              ) : (
                visibleNotes.map((note) => {
                  const noteBacklink = extractTaskBacklink(note.body);
                  const trashed = isTrashedNote(note);
                  return (
                    <div
                      key={note.id}
                      className={
                        note.id === activeNote?.id
                          ? 'kn-note-row is-active'
                          : 'kn-note-row'
                      }
                      data-note-id={note.id}
                      onContextMenu={(event) => openRowMenu(event, note)}
                    >
                      <button
                        type="button"
                        className="kn-note-open"
                        aria-label={`打开笔记：${displayNoteTitle(note)}`}
                        aria-pressed={note.id === activeNote?.id}
                        onClick={() => openNote(note.id)}
                        onKeyDown={(event) =>
                          openMenuFromKeyboard(event, {
                            kind: 'note',
                            noteId: note.id,
                          })
                        }
                      >
                        <span className="kn-note-title">
                          {note.pinned ? (
                            <span
                              className="kn-pin"
                              aria-label="已置顶"
                              title="已置顶"
                            >
                              📌
                            </span>
                          ) : null}
                          {displayNoteTitle(note)}
                        </span>
                        <span className="kn-note-meta">
                          <span>{formatNoteDate(note.updatedAt)}</span>
                          {noteBacklink ? (
                            <span className="kn-note-badge">▤ 任务</span>
                          ) : null}
                          {note.tags.length > 0 ? (
                            <span>{note.tags.slice(0, 2).join(' / ')}</span>
                          ) : null}
                        </span>
                      </button>
                      {!trashed ? (
                        <button
                          type="button"
                          className={
                            note.favorite
                              ? 'kn-star is-on'
                              : 'kn-star'
                          }
                          aria-label={
                            note.favorite
                              ? `取消收藏：${note.title}`
                              : `收藏：${note.title}`
                          }
                          aria-pressed={note.favorite}
                          onClick={(event) => {
                            event.stopPropagation();
                            void toggleFavorite(note);
                          }}
                        >
                          {note.favorite ? '★' : '☆'}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="kn-more"
                        aria-label={`更多操作：${note.title}`}
                        title="更多操作"
                        onClick={(event) => openMoreMenu(event, note)}
                      >
                        ···
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <section
            className={`kn-editor${
              railCollapsed ? ' is-rail-collapsed' : ''
            }${narrowLayout ? ' is-narrow' : ''}`}
            aria-label="笔记编辑器"
          >
            <div className="kn-editor-main">
              <div className="kn-tabs" role="tablist" aria-label="打开的笔记">
                {displayTabs.map((id) => {
                  const note = notes.find((item) => item.id === id);
                  if (!note) {
                    return null;
                  }
                  const selected = id === activeNote?.id;
                  return (
                    <div
                      key={id}
                      className={selected ? 'kn-tab is-active' : 'kn-tab'}
                      onContextMenu={(event) => openTabMenu(event, note)}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        aria-label={`切换到标签：${displayNoteTitle(note)}`}
                        onClick={() => openNote(id)}
                        onKeyDown={(event) =>
                          openMenuFromKeyboard(event, {
                            kind: 'tab',
                            noteId: id,
                          })
                        }
                      >
                        <span className="kn-tab-title">{displayNoteTitle(note)}</span>
                      </button>
                      <button
                        type="button"
                        className="kn-tab-close"
                        aria-label={`关闭标签：${displayNoteTitle(note)}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeTab(id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="kn-tab-add"
                  aria-label="新建笔记"
                  title="新建笔记"
                  onClick={() => void createNote()}
                >
                  ＋
                </button>
              </div>

              {activeNote && !noteLocked ? (
                <CommandBar
                  styleLabel={commandBlockLabel(activeBlock?.type)}
                  readOnly={editorReadOnly}
                  trashed={noteInTrash}
                  readingMode={readingMode}
                  focusMode={focusMode}
                  immersive={immersive}
                  expanded={expandedActive}
                  onToggleExpanded={toggleContentExpanded}
                  styleOpen={panel === 'style'}
                  narrow={narrowLayout}
                  toolsOpen={toolsOpen}
                  onOpenTools={openToolsDrawer}
                  pinned={activeNote.pinned}
                  favorite={activeNote.favorite}
                  canUndo={editorHistory.canUndo}
                  canRedo={editorHistory.canRedo}
                  onStyle={() => togglePanel('style')}
                  onInsert={(type) => {
                    if (type === 'board') {
                      void createBoardNote();
                      return;
                    }
                    editorCommandRef.current?.insertBlock(type);
                  }}
                  onLink={() => editorCommandRef.current?.openLink()}
                  onExport={(format: CommandExportFormat | undefined) =>
                    openExportDialog(activeNote, format)
                  }
                  onUndo={() => requestEditorHistory('undo')}
                  onRedo={() => requestEditorHistory('redo')}
                  onToggleReading={toggleReadingMode}
                  onToggleFocus={toggleFocus}
                  onToggleImmersive={toggleImmersive}
                  onTogglePinned={() => void togglePinned(activeNote)}
                  onToggleFavorite={() => void toggleFavorite(activeNote)}
                  onCopyLink={() => copyNoteLink(activeNote)}
                  onCopyBody={() => copyNoteBody(activeNote)}
                  onMove={() => openMove(activeNote)}
                  onRename={() => openRename(activeNote)}
                  onShowInfo={() => setPanel('info')}
                  onHelp={() => setHelpOpen(true)}
                  onRestore={() => void restoreNote(activeNote)}
                />
              ) : null}

              {activeNote?.locked ? (
                <div className="kn-locked-note" role="status" aria-live="polite">
                  <div className="kn-locked-note-icon" aria-hidden="true">
                    🔒
                  </div>
                  <h3>这篇笔记已加密并锁定</h3>
                  <p>
                    锁定期间不显示标题、正文、标签与块内容，也不参与搜索、导出和
                    OCR；写命令会被本机后端直接拒绝，不会把密文覆盖成空内容。
                  </p>
                  <Link className="kn-primary-button" to="/settings/privacy">
                    前往设置解锁
                  </Link>
                </div>
              ) : activeNote ? (
                <div
                  className={
                    sidePanelOpen
                      ? `kn-editor-content has-panel${
                          linksGraphOpen ? ' is-graph' : ''
                        }`
                      : 'kn-editor-content'
                  }
                >
                  <article
                    ref={paperRef}
                    className="kn-paper knowledge-note"
                    aria-label="笔记内容"
                    tabIndex={-1}
                  >
                    <h2 className="kn-sr-only">{activeNote.title}</h2>
                    <div className="kn-paper-head">
                      <input
                        ref={titleRef}
                        className="kn-title"
                        aria-label="笔记标题"
                        value={titleValue}
                        readOnly={editorReadOnly}
                        placeholder="无标题"
                        onChange={(event) =>
                          setTitleEdit({
                            id: activeNote.id,
                            value: event.target.value,
                          })
                        }
                        onBlur={() => void commitTitle()}
                        onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                        }}
                      />
                      <div className="kn-paper-meta">
                        <span>{noteFolderName(activeNote.folderId)}</span>
                        <span>更新 {formatNoteDate(activeNote.updatedAt)}</span>
                        {activeNote.tags.map((tag) => (
                          <span className="kn-tag" key={tag}>
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </div>

                    {backlink ? (
                      <div className="knowledge-backlink">
                        <span>来源任务</span>
                        <Link to={backlink.path ?? taskBacklinkPath(backlink.taskId)}>
                          {backlink.title}
                        </Link>
                      </div>
                    ) : null}

                    <div className="kn-block-editor">
                      {/*
                        正文内联待办与文末「本篇待办」由同一个工作台维护，
                        共用 note_todos；编辑器能力（标题/只读/工具轨）原样透传。
                      */}
                      <NoteTodosWorkspace
                        key={`${activeNote.id}:${
                          isTrashedNote(activeNote) ? 'readonly' : 'edit'
                        }:${editorReloadToken}`}
                        className="kn-note-todos"
                        noteId={activeNote.id}
                        blockSource={blockRepository}
                        noteTodoSource={noteTodoSource}
                        taskSource={taskSource}
                        editorProps={{
                          commandRef: editorCommandRef,
                          onActiveBlockChange: setActiveBlock,
                          initialHtml: withoutTaskCallout(activeNote.body),
                          readOnly: editorReadOnly,
                          onReadOnlyChange: (next) => {
                            if (noteInTrash) {
                              return;
                            }
                            setReadingMode(next);
                          },
                          stylePanelOpen: panel === 'style',
                          onStylePanelChange: (open) =>
                            setPanel(open ? 'style' : null),
                          focusMode,
                          onFocusModeChange: (next: boolean) => {
                            setFocusMode(next);
                            if (next) {
                              // ⌘⇧F 进入专注时同步退出展开，保持互斥。
                              setContentExpanded(false);
                            }
                          },
                          showHistoryControls: false,
                          onHistoryChange: (state) => setEditorHistory(state),
                          historyAction: editorHistoryAction,
                          filePickerToken,
                          attachmentManager: activeAttachmentManager,
                          attachmentUploader: activeAttachmentUploader,
                          attachmentSyncMode: activeAttachmentMode,
                          attachmentUnavailableReason: activeAttachmentReason,
                          onAttachmentIngested: handleAttachmentIngested,
                          scrollToBlock,
                          initialScrollTop:
                            noteScrollTopRef.current.get(activeNote.id) ?? 0,
                          onScrollPositionChange: (id, top) => {
                            noteScrollTopRef.current.set(id, top);
                          },
                          noteOptions: linkNoteOptions,
                          onOpenNote: openInternalNote,
                          onBlocksChange: (blocks) => setEditorBlocks(blocks),
                          onDocumentChange: (document) => {
                            const noteId = document.noteId ?? activeNote.id;
                            const note = notesRef.current.find(
                              (item) => item.id === noteId,
                            );
                            if (!note || isTrashedNote(note)) {
                              return;
                            }
                            setBodyLength({
                              noteId,
                              length: blocksToPlainText(document.blocks).length,
                            });
                            const nextHtml = blocksToHtml(document.blocks);
                            const callout = extractTaskCalloutHtml(note.body);
                            queueBodySave(
                              note,
                              callout && !nextHtml.includes('zx-task-backlink')
                                ? `${callout}${nextHtml}`
                                : nextHtml,
                            );
                          },
                        }}
                        onEditorError={(reason) =>
                          showToast(formatError(reason), 'error')
                        }
                      />
                    </div>

                    {isTrashedNote(activeNote) ? (
                      <div className="kn-trash-banner" role="status">
                        <span>这篇笔记在回收站中，恢复后可继续编辑。</span>
                        <button
                          type="button"
                          className="kn-primary-button"
                          onClick={() => void restoreNote(activeNote)}
                        >
                          恢复笔记
                        </button>
                      </div>
                    ) : null}

                    <footer className="kn-paper-foot">
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: 10,
                        }}
                      >
                        <span
                          className={`kn-save-state is-${saveState}`}
                          aria-live="polite"
                        >
                          {saveLabel}
                        </span>
                        <span
                          className="zxe-history"
                          role="group"
                          aria-label="撤销与重做"
                        >
                          <button
                            type="button"
                            className="zxe-history-button"
                            aria-label="撤销编辑"
                            title="撤销（⌘Z / Ctrl+Z）"
                            disabled={
                              editorReadOnly || !editorHistory.canUndo
                            }
                            onClick={() => requestEditorHistory('undo')}
                          >
                            <span aria-hidden="true">↶</span> 撤销
                          </button>
                          <button
                            type="button"
                            className="zxe-history-button"
                            aria-label="重做编辑"
                            title="重做（⇧⌘Z / Ctrl+Shift+Z / ⌘Y）"
                            disabled={
                              editorReadOnly || !editorHistory.canRedo
                            }
                            onClick={() => requestEditorHistory('redo')}
                          >
                            <span aria-hidden="true">↷</span> 重做
                          </button>
                        </span>
                      </span>
                      <span>{textLength} 字</span>
                    </footer>
                  </article>

                  {panel === 'info' ? (
                    <aside
                      className="kn-info kn-rail-flyout"
                      id="kn-rail-flyout"
                      data-kn-rail-flyout="true"
                      aria-label="笔记信息"
                    >
                      <header className="kn-info-head">
                        <h3>笔记信息</h3>
                        <button
                          type="button"
                          className="kn-icon-button"
                          aria-label="关闭笔记信息"
                          onClick={() => closeRailPanel('info')}
                        >
                          ×
                        </button>
                      </header>
                      <dl className="kn-info-list">
                        <div>
                          <dt>位置</dt>
                          <dd>{noteFolderName(activeNote.folderId)}</dd>
                        </div>
                        <div>
                          <dt>创建</dt>
                          <dd>{formatNoteDate(activeNote.createdAt)}</dd>
                        </div>
                        <div>
                          <dt>更新</dt>
                          <dd>{formatNoteDate(activeNote.updatedAt)}</dd>
                        </div>
                        <div>
                          <dt>标签</dt>
                          <dd>
                            {activeNote.tags.length > 0
                              ? activeNote.tags.map((tag) => `#${tag}`).join(' ')
                              : '—'}
                          </dd>
                        </div>
                        <div>
                          <dt>状态</dt>
                          <dd>
                            {isTrashedNote(activeNote) ? '回收站' : '正常'}
                          </dd>
                        </div>
                        {backlink ? (
                          <div>
                            <dt>来源任务</dt>
                            <dd>
                              <Link to={backlink.path ?? taskBacklinkPath(backlink.taskId)}>
                                {backlink.title}
                              </Link>
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                      <div className="kn-info-actions">
                        {!isTrashedNote(activeNote) ? (
                          <>
                            <button
                              type="button"
                              className="kn-secondary-button"
                              onClick={() => void toggleFavorite(activeNote)}
                            >
                              {activeNote.favorite ? '取消收藏' : '收藏'}
                            </button>
                            <button
                              type="button"
                              className="kn-secondary-button"
                              onClick={() => void togglePinned(activeNote)}
                            >
                              {activeNote.pinned ? '取消置顶' : '置顶'}
                            </button>
                          </>
                        ) : null}
                        {isTrashedNote(activeNote) ? (
                          <button
                            type="button"
                            className="kn-primary-button"
                            onClick={() => void restoreNote(activeNote)}
                          >
                            恢复笔记
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="kn-danger-button"
                            onClick={() => requestDelete(activeNote)}
                          >
                            删除笔记
                          </button>
                        )}
                      </div>
                    </aside>
                  ) : null}

                  {panel === 'links' ? (
                    <aside
                      className={
                        linksGraphOpen
                          ? 'kn-info kn-rail-flyout is-graph'
                          : 'kn-info kn-rail-flyout'
                      }
                      id="kn-rail-flyout"
                      data-kn-rail-flyout="true"
                      aria-label="笔记链接"
                    >
                      <header className="kn-info-head">
                        <h3>笔记链接</h3>
                        <button
                          type="button"
                          className="kn-icon-button"
                          aria-label="关闭笔记链接面板"
                          onClick={() => closeRailPanel('links')}
                        >
                          ×
                        </button>
                      </header>
                      <div
                        className="kn-links-tabs"
                        role="tablist"
                        aria-label="笔记链接视图"
                      >
                        <button
                          type="button"
                          role="tab"
                          aria-selected={linksView === 'list'}
                          className={
                            linksView === 'list' ? 'is-active' : undefined
                          }
                          onClick={() => setLinksView('list')}
                        >
                          列表
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={linksView === 'graph'}
                          className={
                            linksView === 'graph' ? 'is-active' : undefined
                          }
                          onClick={() => setLinksView('graph')}
                        >
                          关系图
                        </button>
                      </div>

                      {linksView === 'graph' ? (
                        <NoteLinkGraphView
                          key={activeNote.id}
                          notes={notes}
                          rootId={activeNote.id}
                          onOpenNote={openNote}
                        />
                      ) : (
                        <>
                          <section
                            className="kn-panel-section"
                            aria-label="关联任务"
                          >
                            <h4>关联任务</h4>
                            {backlink ? (
                              <Link
                                className="kn-panel-item"
                                to={
                                  backlink.path ??
                                  taskBacklinkPath(backlink.taskId)
                                }
                              >
                                ▤ {backlink.title}
                              </Link>
                            ) : (
                              <p className="kn-panel-hint">暂无关联任务</p>
                            )}
                          </section>
                          <section
                            className="kn-panel-section"
                            aria-label="关联画板"
                          >
                            <h4>关联画板</h4>
                            {boardBlocks.length > 0 ? (
                              boardBlocks.map((board) =>
                                board.boardId ? (
                                  <button
                                    type="button"
                                    key={board.id}
                                    className="kn-panel-item"
                                    onClick={() =>
                                      navigate(
                                        `/board/${encodeURIComponent(
                                          board.boardId as string,
                                        )}?note=${encodeURIComponent(
                                          activeNote.id,
                                        )}`,
                                      )
                                    }
                                  >
                                    ▧ {board.title}
                                  </button>
                                ) : (
                                  <p className="kn-panel-hint" key={board.id}>
                                    ▧ {board.title}（尚未创建画板）
                                  </p>
                                ),
                              )
                            ) : (
                              <p className="kn-panel-hint">暂无关联画板</p>
                            )}
                          </section>
                          <section
                            className="kn-panel-section"
                            aria-label="反向链接"
                          >
                            <h4>反向链接</h4>
                            {reverseLinks.length > 0 ? (
                              reverseLinks.map((note) => (
                                <button
                                  type="button"
                                  key={note.id}
                                  className="kn-panel-item"
                                  onClick={() => openNote(note.id)}
                                >
                                  ⌁ {note.title}
                                </button>
                              ))
                            ) : (
                              <p className="kn-panel-hint">
                                暂无其他笔记链接到本篇
                              </p>
                            )}
                          </section>
                          <div className="kn-panel-actions">
                            <button
                              type="button"
                              className="kn-secondary-button"
                              onClick={() => copyNoteLink(activeNote)}
                            >
                              复制笔记内链
                            </button>
                          </div>
                          <p className="kn-panel-note kn-link-scope">
                            内链仅站内有效，跨应用不可跳转；不会伪造跨库链接。
                          </p>
                        </>
                      )}
                    </aside>
                  ) : null}

                  {panel === 'outline' ? (
                    <aside
                      className="kn-info kn-rail-flyout"
                      id="kn-rail-flyout"
                      data-kn-rail-flyout="true"
                      aria-label="笔记大纲"
                    >
                      <header className="kn-info-head">
                        <h3>笔记大纲</h3>
                        <button
                          type="button"
                          className="kn-icon-button"
                          aria-label="关闭大纲面板"
                          onClick={() => closeRailPanel('outline')}
                        >
                          ×
                        </button>
                      </header>
                      {headings.length > 0 ? (
                        <div className="kn-outline-list">
                          {headings.map((heading) => (
                            <button
                              type="button"
                              key={heading.blockId}
                              className="kn-panel-item kn-outline-item"
                              style={{
                                paddingLeft: `${8 + (heading.level - 1) * 12}px`,
                              }}
                              onClick={() => {
                                scrollSeq.current += 1;
                                setScrollToBlock({
                                  blockId: heading.blockId,
                                  token: scrollSeq.current,
                                });
                              }}
                            >
                              H{heading.level} · {heading.text}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="kn-panel-hint">
                          添加标题后自动生成大纲
                        </p>
                      )}
                    </aside>
                  ) : null}

                  {panel === 'attachment' ? (
                    <aside
                      className="kn-info kn-rail-flyout"
                      id="kn-rail-flyout"
                      data-kn-rail-flyout="true"
                      aria-label="附件"
                    >
                      <header className="kn-info-head">
                        <h3>附件</h3>
                        <button
                          type="button"
                          className="kn-icon-button"
                          aria-label="关闭附件面板"
                          onClick={() => closeRailPanel('attachment')}
                        >
                          ×
                        </button>
                      </header>
                      <AttachmentSection
                        manager={activeAttachmentManager}
                        uploader={activeAttachmentUploader}
                        syncMode={activeAttachmentMode}
                        unavailableReason={activeAttachmentReason}
                        loading={attachmentRuntimeLoading}
                        refreshToken={attachmentRefreshToken}
                        attachmentIds={referencedAttachmentIds}
                        noteId={activeNote.id}
                        title="笔记附件"
                        insertLabel="＋ 添加附件"
                        onNotice={(message) => showToast(message)}
                      />

                      <div className="kn-attachment-body">
                        <h4>正文文件卡</h4>
                        <p className="kn-panel-hint">
                          文件卡引用附件面板里的同一条记录：文件本体先保存在本机，打开/另存不依赖同步状态；只有后端模式且你显式点「上传」才进入同步队列。
                        </p>
                        {attachmentBlocks.length > 0 ? (
                          <ul className="kn-attachment-list">
                            {attachmentBlocks.map((file) => (
                              <li key={file.id}>
                                <span
                                  className="kn-attachment-name"
                                  title={file.fileName || '未选择文件'}
                                >
                                  {file.fileName || '未选择文件'}
                                </span>
                                <span className="kn-attachment-meta">
                                  {formatByteSize(file.byteSize)} ·{' '}
                                  {attachmentStatusLabels[file.id] ??
                                    fallbackFileStatusLabel(
                                      file,
                                      activeAttachmentMode,
                                    )}
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="kn-panel-hint">正文里还没有文件卡</p>
                        )}
                        <button
                          type="button"
                          className="kn-secondary-button"
                          disabled={editorReadOnly}
                          onClick={() =>
                            setFilePickerToken((current) => current + 1)
                          }
                        >
                          ＋ 在正文插入文件卡
                        </button>
                        {editorReadOnly ? (
                          <p className="kn-panel-note">
                            阅读模式下不能插入文件，切回编辑后可用。
                          </p>
                        ) : null}
                      </div>
                    </aside>
                  ) : null}

                </div>
              ) : (
                <div className="kn-editor-empty">
                  <span aria-hidden="true">▤</span>
                  <h2>选择或新建一篇笔记</h2>
                  <p>左侧目录与列表仍可继续浏览。</p>
                </div>
              )}
            </div>

            {narrowLayout ? null : (
              <nav
                className={railCollapsed ? 'kn-rail is-collapsed' : 'kn-rail'}
                aria-label="笔记面板"
              >
                <button
                  type="button"
                  className="kn-rail-toggle"
                  aria-label={railCollapsed ? '展开面板栏' : '收起面板栏'}
                  title={railCollapsed ? '展开面板栏' : '收起面板栏'}
                  aria-expanded={!railCollapsed}
                  onClick={() => setRailCollapsed((current) => !current)}
                >
                  <Icon
                    name={
                      railCollapsed
                        ? 'common-chevron-left'
                        : 'common-chevron-right'
                    }
                    size={14}
                  />
                </button>

                {([1, 2, 3] as const).map((group) => (
                  <Fragment key={group}>
                    {group > 1 ? (
                      <div className="kn-rail-separator" role="separator" />
                    ) : null}
                    <div
                      className="kn-rail-group"
                      role="group"
                      aria-label={
                        group === 1
                          ? '视图与样式'
                          : group === 2
                            ? '面板'
                            : '专注与输出'
                      }
                    >
                      {knowledgeTools
                        .filter((tool) => tool.group === group)
                        .map((tool) => (
                          <button
                            key={tool.key}
                            ref={(element) => {
                              if (element) {
                                railButtonRefs.current.set(tool.key, element);
                              } else {
                                railButtonRefs.current.delete(tool.key);
                              }
                            }}
                            type="button"
                            className={
                              tool.pressed ? 'is-active' : undefined
                            }
                            data-rail-tool={tool.key}
                            aria-label={tool.label}
                            title={tool.title}
                            aria-pressed={tool.pressed}
                            aria-expanded={
                              RAIL_PANEL_CONTROLS[
                                tool.key as PanelKind
                              ] !== undefined
                                ? Boolean(tool.pressed)
                                : undefined
                            }
                            aria-controls={
                              RAIL_PANEL_CONTROLS[
                                tool.key as PanelKind
                              ]
                            }
                            disabled={tool.disabled}
                            onClick={tool.onSelect}
                          >
                            <Icon name={tool.icon} size={16} />
                            <span
                              className="kn-rail-caption"
                              aria-hidden="true"
                            >
                              {tool.caption}
                            </span>
                          </button>
                        ))}
                    </div>
                  </Fragment>
                ))}
              </nav>
            )}
          </section>
        </div>
      ) : null}

      {toolsOpen && narrowLayout ? (
        <>
          <div
            className="kn-tools-scrim"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setToolsOpen(false);
              }
            }}
          />
          <aside
            className="kn-tools-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="kn-tools-title"
          >
            <header className="kn-drawer-head">
              <h2 id="kn-tools-title" ref={toolsTitleRef} tabIndex={-1}>
                笔记工具
              </h2>
              <button
                type="button"
                className="kn-icon-button"
                aria-label="关闭工具抽屉"
                onClick={() => setToolsOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="kn-drawer-body">
              {knowledgeTools.map((tool, index) => (
                <Fragment key={tool.key}>
                  {index > 0 &&
                  knowledgeTools[index - 1].group !== tool.group ? (
                    <div className="kn-drawer-separator" role="separator" />
                  ) : null}
                  <button
                    type="button"
                    className={
                      tool.pressed
                        ? 'kn-drawer-row is-active'
                        : 'kn-drawer-row'
                    }
                    aria-label={tool.label}
                    aria-pressed={tool.pressed}
                    disabled={tool.disabled}
                    onClick={() => {
                      // 阅读/编辑留在抽屉内刷新状态；其余动作执行后关闭。
                      if (tool.key !== 'reading') {
                        setToolsOpen(false);
                      }
                      tool.onSelect();
                    }}
                  >
                    <span className="kn-drawer-icon" aria-hidden="true">
                      <Icon name={tool.icon} size={18} />
                    </span>
                    <span className="kn-drawer-label">{tool.label}</span>
                    <span className="kn-drawer-state">
                      {toolStatus(tool)}
                    </span>
                  </button>
                </Fragment>
              ))}
            </div>
          </aside>
        </>
      ) : null}

      {helpOpen ? (
        <Modal
          open
          title="知识编辑器快捷键"
          onClose={() => setHelpOpen(false)}
          footer={
            <div className="kn-modal-actions">
              <button
                type="button"
                className="kn-primary-button"
                autoFocus
                onClick={() => setHelpOpen(false)}
              >
                知道了
              </button>
            </div>
          }
        >
          <p className="kn-modal-copy">
            文档级动作在顶部命令栏，块级动作在正文左侧 `＋ / ⠿`，
            选区格式在划词后浮出。命令栏本身不放 B/I/U/S。
          </p>
          <dl className="kn-help-list">
            <div>
              <dt>Alt+F10</dt>
              <dd>聚焦「样式」命令</dd>
            </div>
            <div>
              <dt>⌘⇧I / Ctrl+Shift+I</dt>
              <dd>打开插入菜单</dd>
            </div>
            <div>
              <dt>⌘⇧K / Ctrl+Shift+K</dt>
              <dd>插入链接（有选区时作用在选中文字）</dd>
            </div>
            <div>
              <dt>⇧⌘E / Ctrl+Shift+E</dt>
              <dd>打开导出</dd>
            </div>
            <div>
              <dt>⇧⌘R / Ctrl+Shift+R</dt>
              <dd>阅读 / 编辑切换</dd>
            </div>
            <div>
              <dt>⌘⇧F / Ctrl+Shift+F</dt>
              <dd>专注模式；Esc 退出</dd>
            </div>
            <div>
              <dt>F11</dt>
              <dd>全屏阅读 / 退出</dd>
            </div>
            <div>
              <dt>⌘B / ⌘I / ⌘U</dt>
              <dd>选中文字后加粗、斜体、下划线（Ctrl 同效）</dd>
            </div>
            <div>
              <dt>↑ ↓ / Home / End / Enter / Esc</dt>
              <dd>菜单导航、执行与关闭；Esc 关闭后焦点回到触发按钮</dd>
            </div>
            <div>
              <dt>/</dt>
              <dd>空块内打开插入菜单</dd>
            </div>
          </dl>
        </Modal>
      ) : null}

      {contextMenu && menuItems.length > 0 ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          label={t(menuLabelKey)}
          items={menuItems}
          focusOnOpen={contextMenu.focusOnOpen}
          softDisabled
          onClose={closeContextMenu}
        />
      ) : null}

      {dialog && dialogNote ? (
        <Modal
          open
          title={
            dialog.kind === 'delete'
              ? '删除笔记'
              : dialog.kind === 'rename'
                ? '重命名笔记'
                : dialog.kind === 'move'
                  ? '移动到目录'
                  : `导出「${dialogNote.title || '未命名笔记'}」`
          }
          onClose={() => {
            setDialog(null);
            setDialogError(null);
            setExportNotice(null);
          }}
          busy={dialog.kind === 'export' && exportBusy}
          className={dialog.kind === 'export' ? 'kx-export-modal' : undefined}
          footer={
            dialog.kind === 'delete' ? (
              <div className="kn-modal-actions">
                <button
                  type="button"
                  className="kn-secondary-button"
                  onClick={() => setDialog(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="kn-danger-button"
                  onClick={() => void confirmDelete()}
                >
                  确认删除
                </button>
              </div>
            ) : dialog.kind === 'rename' ? (
              <div className="kn-modal-actions">
                <button
                  type="button"
                  className="kn-secondary-button"
                  onClick={() => setDialog(null)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  form={`${dialogFormId}-rename`}
                  className="kn-primary-button"
                >
                  保存
                </button>
              </div>
            ) : dialog.kind === 'move' ? (
              <div className="kn-modal-actions">
                <button
                  type="button"
                  className="kn-secondary-button"
                  onClick={() => setDialog(null)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  form={`${dialogFormId}-move`}
                  className="kn-primary-button"
                >
                  移动
                </button>
              </div>
            ) : (
              <div className="kn-modal-actions">
                <button
                  type="button"
                  className="kn-secondary-button"
                  disabled={exportBusy}
                  onClick={() => setDialog(null)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  form={`${dialogFormId}-export`}
                  className="kn-primary-button"
                  disabled={exportBusy}
                >
                  {exportBusy ? '正在生成…' : '继续'}
                </button>
              </div>
            )
          }
        >
          {dialog.kind === 'delete' ? (
            <p className="kn-modal-copy">
              把「{dialogNote.title}」移到回收站？30 天内可从回收站恢复。
            </p>
          ) : null}

          {dialog.kind === 'rename' ? (
            <form
              id={`${dialogFormId}-rename`}
              onSubmit={(event) => void confirmRename(event)}
            >
              <p className="kn-modal-copy">
                标题不能为空；保存后列表与标签页同步更新。
              </p>
              <label className="kn-field">
                <span>标题</span>
                <input
                  autoFocus
                  value={renameValue}
                  maxLength={120}
                  onChange={(event) => {
                    setRenameValue(event.target.value);
                    if (dialogError) {
                      setDialogError(null);
                    }
                  }}
                />
              </label>
              {dialogError ? (
                <p className="kn-field-error" role="alert">
                  {dialogError}
                </p>
              ) : null}
            </form>
          ) : null}

          {dialog.kind === 'move' ? (
            <form
              id={`${dialogFormId}-move`}
              onSubmit={(event) => void confirmMove(event)}
            >
              <p className="kn-modal-copy">
                只改变笔记所在目录，不会改变笔记链接和关联任务。
              </p>
              <label className="kn-field">
                <span>目录</span>
                <select
                  autoFocus
                  value={moveFolder}
                  onChange={(event) => setMoveFolder(event.target.value)}
                >
                  <option value="">未分类</option>
                  {NOTE_FOLDERS.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
              </label>
            </form>
          ) : null}

          {dialog.kind === 'export' ? (
            <form
              id={`${dialogFormId}-export`}
              className="kx-export-form"
              onSubmit={(event) => void confirmExport(event)}
            >
              <p className="kn-modal-copy">
                单篇笔记导出；格式选择后会打开系统保存面板。取消保存不会写入文件。
              </p>

              <fieldset className="kx-export-fieldset">
                <legend>格式</legend>
                <div className="kx-export-formats">
                  {NOTE_EXPORT_FORMATS.map((format) => (
                    <label
                      key={format.value}
                      className="kx-export-format"
                    >
                      <input
                        type="radio"
                        name="note-export-format"
                        value={format.value}
                        checked={exportFormat === format.value}
                        onChange={() => setExportFormat(format.value)}
                      />
                      <strong>
                        {format.label}
                        <em>{format.extension}</em>
                      </strong>
                      <span>{format.description}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {exportFormat === 'pdf' ? (
                <p className="kx-export-limit" role="note">
                  PDF 由 Canvas 排版为图像：文字不可选中、检索或复制；需要可编辑内容请选
                  Word，需要迁移请选 Markdown。
                </p>
              ) : null}
              {exportFormat === 'md' ? (
                <p className="kx-export-note" role="note">
                  Markdown 会丢失文字颜色、底色和表格列宽；公式保留 LaTeX 源，站内内链保留
                  zhixing://note/&lt;id&gt;。
                </p>
              ) : null}
              {exportFormat === 'zxnote' ? (
                <p className="kx-export-note" role="note">
                  知行笔记包（.zxnote）始终包含全部块、被引用画板与附件，不受下方“元信息/图片”开关影响；
                  仅知行可导入，不能替代整库备份。
                </p>
              ) : null}

              <fieldset className="kx-export-fieldset">
                <legend>选项</legend>
                <div className="kx-export-options">
                  <label>
                    <input
                      type="checkbox"
                      disabled={exportFormat === 'zxnote'}
                      checked={exportIncludeMetadata}
                      onChange={(event) =>
                        setExportIncludeMetadata(event.target.checked)
                      }
                    />
                    包含创建/更新、目录、标签与字数
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      disabled={exportFormat === 'zxnote'}
                      checked={exportIncludeImages}
                      onChange={(event) =>
                        setExportIncludeImages(event.target.checked)
                      }
                    />
                    包含图片（Word/PDF 嵌原图，Markdown base64）
                  </label>
                  {exportFormat === 'pdf' ? (
                    <label>
                      纸张
                      <select
                        aria-label="PDF 纸张"
                        value={exportPaper}
                        onChange={(event) =>
                          setExportPaper(event.target.value as NotePdfPaper)
                        }
                      >
                        <option value="A4">A4</option>
                        <option value="Letter">Letter</option>
                      </select>
                    </label>
                  ) : null}
                </div>
              </fieldset>

              <p className="kx-export-outline">
                内容清单：{exportOutlineFor(dialogNote)}
              </p>
              {isTrashedNote(dialogNote) ? (
                <p className="kx-export-note" role="status">
                  该笔记在回收站中，将按只读快照导出；不会恢复或修改笔记。
                </p>
              ) : editorReadOnly ? (
                <p className="kx-export-note" role="status">
                  当前为阅读模式，导出的是只读快照，不会修改正文。
                </p>
              ) : null}
              {exportNotice ? (
                <p className="kx-export-note" role="status">
                  {exportNotice}
                </p>
              ) : null}
              {dialogError ? (
                <p className="kn-field-error" role="alert">
                  {dialogError}
                </p>
              ) : null}
            </form>
          ) : null}
        </Modal>
      ) : null}

      {exportResult ? (
        <Modal
          open
          title={`已导出 ${exportResultLabel(exportResult.report.format)}`}
          onClose={() => setExportResult(null)}
          className="kx-export-modal"
          footer={
            <div className="kn-modal-actions">
              {exportResult.path ? (
                <button
                  type="button"
                  className="kn-secondary-button"
                  onClick={() =>
                    void copyText(exportResult.path!, '已复制导出路径')
                  }
                >
                  复制路径
                </button>
              ) : null}
              <button
                type="button"
                className="kn-primary-button"
                onClick={() => setExportResult(null)}
              >
                完成
              </button>
            </div>
          }
        >
          <p className="kx-export-result-file">
            {exportResult.actualFileName} · {formatBytes(exportResult.report.size)}
          </p>
          <p className="kx-export-result-path">
            {exportResult.path ??
              '已保存到所选位置（浏览器无法回显完整路径）'}
          </p>
          {exportResult.renamed ? (
            <p className="kx-export-rename" role="status">
              同名文件已存在，已自动另存为「{exportResult.actualFileName}」，原文件未被覆盖。
            </p>
          ) : null}
          {exportResult.report.warnings.length > 0 ? (
            <section
              className="kx-export-warnings"
              aria-label="导出降级项"
            >
              <h3>降级项（{exportResult.report.warnings.length}）</h3>
              <ul>
                {exportResult.report.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </Modal>
      ) : null}

      {boardDialog && boardDialogBoard ? (
        <Modal
          open
          title={
            boardDialog.kind === 'associate'
              ? '关联画板到笔记'
              : '删除画板'
          }
          onClose={closeBoardDialog}
          footer={
            boardDialog.kind === 'associate' ? (
              <div className="kn-modal-actions">
                <button
                  type="button"
                  className="kn-secondary-button"
                  onClick={closeBoardDialog}
                >
                  取消
                </button>
                <button
                  type="submit"
                  form={`${boardDialogFormId}-associate`}
                  className="kn-primary-button"
                >
                  关联
                </button>
              </div>
            ) : (
              <div className="kn-modal-actions">
                <button
                  type="button"
                  className="kn-secondary-button"
                  onClick={closeBoardDialog}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="kn-danger-button"
                  onClick={() => void confirmDeleteBoard()}
                >
                  确认删除
                </button>
              </div>
            )
          }
        >
          {boardDialog.kind === 'associate' ? (
            <form
              id={`${boardDialogFormId}-associate`}
              onSubmit={(event) => void confirmAssociateBoard(event)}
            >
              <p className="kn-modal-copy">
                把「{boardDialogBoard.title}」关联到一篇笔记，并在笔记末尾追加画板块；现有正文会保留。
              </p>
              <label className="kn-field">
                <span>笔记</span>
                <select
                  autoFocus
                  value={boardDialogNoteId}
                  onChange={(event) => {
                    setBoardDialogNoteId(event.target.value);
                    if (boardDialogError) {
                      setBoardDialogError(null);
                    }
                  }}
                >
                  {activeNotes.length === 0 ? (
                    <option value="">暂无可用笔记</option>
                  ) : (
                    activeNotes.map((note) => (
                      <option key={note.id} value={note.id}>
                        {note.title}
                      </option>
                    ))
                  )}
                </select>
              </label>
              {boardDialogError ? (
                <p className="kn-field-error" role="alert">
                  {boardDialogError}
                </p>
              ) : null}
            </form>
          ) : (
            <>
              <p className="kn-modal-copy">
                「{boardDialogBoard.title}」包含{' '}
                {boardObjectCounts[boardDialogBoard.id] ?? 0}{' '}
                个对象，删除后无法恢复。只删除画板数据，不改动笔记正文与其它画板。
              </p>
              {boardDialogError ? (
                <p className="kn-field-error" role="alert">
                  {boardDialogError}
                </p>
              ) : null}
            </>
          )}
        </Modal>
      ) : null}

      {importOpen ? (
        <NoteImportDialog
          folders={NOTE_FOLDERS}
          defaultFolderId={importDefaultFolderId}
          existingTitles={importTitlesInFolder}
          importNote={importNoteBundle}
          importPackage={importNotePackage}
          onClose={() => setImportOpen(false)}
          onOpenNote={openImportedNote}
        />
      ) : null}

      {toast ? (
        <div
          className={
            toast.tone === 'error'
              ? 'kn-toast is-error'
              : 'kn-toast'
          }
          role="status"
          key={toast.id}
        >
          {toast.message}
        </div>
      ) : null}
    </section>
  );
}
