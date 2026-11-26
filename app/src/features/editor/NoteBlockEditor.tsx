/**
 * 块编辑器（P1-02）。
 *
 * 交互事实来自原型：正文顶部没有固定格式栏；空块左侧 `＋`、非空块 `⠿`；
 * 空块输入 `/` 打开块菜单；选中文字浮出格式条；右侧 `Aa` 打开样式面板。
 *
 * 权威数据是 `note_blocks` 的结构化 payload，不是 contenteditable 的 HTML。
 * `InlineEditable` 只是视图，输入后立刻序列化为 runs 并写入仓储。
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from 'react';

import { db } from '../../data/db/client';
import type { JsonValue } from '../../data/db/types';
import {
  blockDocumentJson,
  createBlockRepository,
  serializeBlockDocument,
  toBlockDraft,
  type BlockDocument,
  type BlockRepository,
  type EditorBlock,
} from '../../data/repositories/blocks';
import { BlockMenu } from './BlockMenu';
import { BlockRow } from './BlockRow';
import { FormatBar, type ActiveInlineMarks } from './FormatBar';
import {
  ContextMenu,
  type ContextMenuCloseReason,
  type ContextMenuItem,
} from '../knowledge/contextMenu';
import { t } from '../../i18n/menu';
import {
  LinkDialog,
  QuoteSourceDialog,
  type LinkNoteOption,
} from './LinkDialog';
import type { FileCardLocalState } from './blocks/FileCardBlock';
import type { FormulaContextMenuState } from './blocks/FormulaBlock';
import type { TableContextMenuState } from './blocks/TableBlock';
import { internalNoteIdFromUrl, internalNoteUrl } from './security';
import { StylePanel } from './StylePanel';
import {
  blockLabel,
  createBlock,
  canContainText,
  newBlockId,
} from './blocks/registry';
import type { InlinePastePayload } from './blocks/InlineEditable';
import type { AttachmentManager } from '../attachments/manager';
import type { AttachmentUploader } from '../attachments/uploader';
import type { StoredAttachment } from '../attachments/types';
import {
  describeAttachmentStatus,
  type AttachmentDisplayState,
  type AttachmentSyncMode,
} from '../attachments/types';
import { attachmentFilePayload } from '../attachments/runtime';
import {
  createBoardImageBlock,
  type BoardImageFile,
} from '../board/export/noteInsert';
import {
  describeSaveResult,
  openAttachmentLocally,
  saveLocalAttachment,
} from '../attachments/fileActions';
import { objectUrlFor, revokeObjectUrl } from '../attachments/blobStore';
import {
  clearMarksInRange,
  rangeHasMark,
  replaceRangeWithRuns,
  restoreSelectionByOffsets,
  runsToPlainText,
  selectionOffsetsIn,
  selectionRect,
  sliceRuns,
  splitRunsAt,
  toggleMarksInRange,
  type InlineSelection,
  type SelectionRect,
} from './inline';
import {
  HISTORY_MERGE_MS,
  blocksToClipboardHtml,
  blocksToPlainText,
  caretBeforeTextChange,
  cloneHistoryBlocks,
  convertBlockType,
  createBlockSelection,
  ensureTrailingParagraph,
  extendBlockSelection,
  isBlockEmpty,
  mergeBlockBackward,
  moveBlock,
  normalizeBlockOrder,
  pushHistoryEntry,
  remapRestoredBlockIds,
  removeBlockById,
  removeBlocksByIds,
  selectAllBlocks,
  splitBlock,
  toggleBlockSelection,
  withAlign,
  withIndent,
  withPayload,
  withRuns,
  type BlockHistoryEntry,
  type BlockSelection,
  type HistoryCaret,
  type MoveHistorySideEffect,
} from './model';
import { normalizeLegacyBlocks } from './legacy';
import { pastedBlocksFromHtml, pastedTextRuns } from './paste';
import { selectDocumentContent } from './documentSelection';
import type { PastedBlock } from './paste';
import {
  blockChecked,
  blockFile,
  blockIndent,
  blockQuoteHasMeta,
  blockQuoteMeta,
  blockRuns,
  isTextualBlockType,
  normalizeInlineRuns,
  type InlineMarks,
  type KnownBlockType,
  type QuoteMeta,
  type TextAlign,
} from './types';
import './editor.css';

export type EditorActiveBlock = {
  id: string;
  type: KnownBlockType;
};

/**
 * 文档级选择与高级块选择共用 `BlockSelection` 的 ids，但交互不同：
 * - document：⌘/Ctrl+A 整篇，不显示每块复选框，Shift+点击回到原生选择；
 * - block：底部「选择块」/⌘⇧A 显式进入，显示复选框并支持 Shift 扩展。
 * 普通写作态每行行前另有低频选择入口（ZX10-BLOCKSEL-01）。
 */
type BlockSelectionMode = 'document' | 'block';

/**
 * 文档命令栏调用编辑器能力的窄接口（ZX-TOOLBAR-02）。
 * 只暴露插入/链接与当前块信息，不把内部状态或仓储泄漏给知识页。
 */
export type EditorCommandHandle = {
  insertBlock: (type: KnownBlockType) => void;
  openLink: () => void;
  focusEditor: () => void;
};

export type NoteBlockEditorProps = {
  noteId: string;
  /** 测试或上层业务注入；不传时使用真实 SQLite 仓储。 */
  source?: BlockRepository;
  /** 知识页命令栏使用；不传时编辑器保持无外部命令入口。 */
  commandRef?: Ref<EditorCommandHandle>;
  /** 当前块变化时回传类型，供命令栏显示「Aa 正文 / 标题 2」。 */
  onActiveBlockChange?: (block: EditorActiveBlock | null) => void;
  /**
   * 旧笔记的 HTML 正文。仅当 `note_blocks` 为空时用于首次投影，
   * 之后以块仓储为权威；不会覆盖已有块。
   */
  initialHtml?: string;
  initialReadOnly?: boolean;
  /**
   * 受控阅读模式。传入时由上层工具轨控制；未传时保留编辑器自带工具轨。
   * 回收站笔记等强制只读场景也走这里，避免上层和编辑器各有一套状态。
   */
  readOnly?: boolean;
  onReadOnlyChange?: (readOnly: boolean) => void;
  /** 受控样式面板；知识页命令栏的「样式」通过它打开编辑器面板。 */
  stylePanelOpen?: boolean;
  onStylePanelChange?: (open: boolean) => void;
  /**
   * 受控专注模式。专注模式已并入原「打字机」能力：
   * 隐藏周边、当前块居中/高亮、写作跟随（默认开启，可关闭）。
   */
  focusMode?: boolean;
  onFocusModeChange?: (focus: boolean) => void;
  /** 递增该值等价于点击编辑器内的「插入文件」，由知识页附件入口触发。 */
  filePickerToken?: number;
  /** 大纲点击/搜索定位后把指定块滚动到视口中间；highlight 时短暂高亮。 */
  scrollToBlock?: {
    blockId: string;
    token: number;
    highlight?: boolean;
  } | null;
  /**
   * 打开笔记时恢复的正文滚动位置。只在块加载就绪后应用一次；
   * 保存、撤销/重做、块更新都不会重放，避免把用户滚回旧位置。
   */
  initialScrollTop?: number;
  /**
   * 正文滚动位置变化（含卸载前最后一次）。知识页据此按笔记记住位置，
   * 切回来时通过 initialScrollTop 恢复；不写入块数据或 localStorage。
   */
  onScrollPositionChange?: (noteId: string, scrollTop: number) => void;
  /** 插入链接弹层可选的站内笔记（N-16）。 */
  noteOptions?: readonly LinkNoteOption[];
  /** 点击站内内链时打开笔记；是否存在由知识页判断（N-16）。 */
  onOpenNote?: (noteId: string) => void;
  /** 附件服务；正文插入文件时由同一个 manager 写入 SQLite + 本机 Blob。 */
  attachmentManager?: AttachmentManager | null;
  attachmentUploader?: AttachmentUploader | null;
  /** 当前设备同步模式；不传时读 manager 的模式（测试注入默认 local）。 */
  attachmentSyncMode?: AttachmentSyncMode;
  /** manager 不可用时的可见原因；插入文件会明确失败，不生成假文件卡。 */
  attachmentUnavailableReason?: string | null;
  /** 文件成功写入附件库后通知上层刷新附件面板。 */
  onAttachmentIngested?: (attachments: readonly StoredAttachment[]) => void;
  /**
   * 每次块加载/变更后回传快照；知识页据此生成大纲、附件和画板列表。
   * 不会触发 notes.body 写回。
   */
  onBlocksChange?: (blocks: readonly EditorBlock[]) => void;
  /**
   * 是否在编辑器状态栏里渲染撤销/重做。知识页把按钮放在自己的
   * 「保存状态 + 字数」页脚时传 false，避免出现两组按钮。
   */
  showHistoryControls?: boolean;
  /** 撤销/重做可用性变化，供上层渲染自己的按钮。 */
  onHistoryChange?: (state: EditorHistoryState) => void;
  /** 上层触发撤销/重做；token 递增执行一次。 */
  historyAction?: EditorHistoryAction | null;
  /** 输入后的保存防抖；测试可传 0。 */
  saveDelayMs?: number;
  className?: string;
  onDocumentChange?: (document: BlockDocument) => void;
  onError?: (error: Error) => void;
};

type LoadState = 'loading' | 'ready' | 'error';
type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
type PendingFocus = {
  blockId: string;
  start?: number;
  end?: number;
  /** 选中原子块时只要整行焦点，不进入表格单元格/代码输入框。 */
  rowOnly?: boolean;
} | null;
type MenuState = {
  blockId: string;
  x: number;
  y: number;
} | null;
type EditorContextMenuKind =
  | 'text'
  | 'table'
  | 'formula'
  | 'blank'
  | 'image'
  | 'block';
type EditorContextMenuState = {
  kind: EditorContextMenuKind;
  blockId: string | null;
  x: number;
  y: number;
  items: ContextMenuItem[];
  /** Escape / 选中菜单项后把焦点与选区还给来源块。 */
  restoreFocus: () => void;
} | null;
type EditorSelection = InlineSelection & {
  blockId: string;
  rect: SelectionRect;
};
/**
 * 一次块变更应如何进入撤销历史：
 * - 省略 = 独立一步（插入/删除/转换/粘贴/勾选等）；
 * - `{ mergeKey }` = 400ms 内相同 mergeKey 的连续输入合并成一步；
 * - `false` = 不入历史（例如只读/出错时的程序性回写）。
 */
type HistoryOption =
  | false
  | { mergeKey?: string; sideEffects?: MoveHistorySideEffect[] };
export type EditorHistoryAction = {
  action: 'undo' | 'redo';
  token: number;
};
export type EditorHistoryState = {
  canUndo: boolean;
  canRedo: boolean;
};
type MergeMark = { key: string; at: number };

function formatError(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  // Tauri 命令错误经常是字符串而不是 Error；不能吞成“操作失败，请重试”，
  // 否则文件入库失败时用户看不到真实原因。
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  if (reason && typeof reason === 'object' && 'message' in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }
  return '操作失败，请重试';
}

/** 剪贴板写入：优先 Clipboard API，Tauri WebView/旧内核回退到 execCommand。 */
function writeClipboardText(text: string): Promise<boolean> {
  const fallback = (): boolean => {
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
  };
  const clipboard = navigator.clipboard;
  if (clipboard?.writeText) {
    return clipboard.writeText(text).then(
      () => true,
      () => fallback(),
    );
  }
  return Promise.resolve(fallback());
}

async function readClipboardText(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch {
    // 读取权限被拒时交给调用方提示使用系统快捷键。
  }
  return null;
}

/**
 * 「写作跟随」是设备级偏好：原型 `ui.follow`，正式版落 `app_settings`；
 * 当前编辑器在浏览器预览/桌面共用 localStorage 镜像，默认开启。
 */
const WRITING_FOLLOW_STORAGE_KEY = 'editor.focus.follow';

function readWritingFollowPreference(): boolean {
  try {
    if (typeof window === 'undefined') {
      return true;
    }
    const raw = window.localStorage.getItem(WRITING_FOLLOW_STORAGE_KEY);
    return raw === null ? true : raw !== 'false';
  } catch {
    return true;
  }
}

function writeWritingFollowPreference(next: boolean): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(
        WRITING_FOLLOW_STORAGE_KEY,
        next ? 'true' : 'false',
      );
    }
  } catch {
    // localStorage 不可用时只影响跨会话记忆，不影响本次专注。
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function emptyActiveMarks(): ActiveInlineMarks {
  return {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    code: false,
  };
}

/**
 * 连续敲字的字段按字段合并；结构性操作（多字段 patch）保持独立一步。
 * 表格单元格由调用方传入更细的 `table:<block>:<row>:<col>`。
 */
function continuousHistoryKey(
  blockId: string,
  patch: Record<string, JsonValue>,
): string | undefined {
  const keys = Object.keys(patch);
  if (keys.length !== 1) {
    return undefined;
  }
  switch (keys[0]) {
    case 'code':
      return `code:${blockId}`;
    case 'latex':
      return `latex:${blockId}`;
    case 'fileName':
      return `fileName:${blockId}`;
    case 'title':
      return `title:${blockId}`;
    case 'url':
      return `url:${blockId}`;
    default:
      return undefined;
  }
}

/** 旧版 HTML 正文 → 初始块；解析失败时返回空数组，由调用方补空段落。 */
function blocksFromInitialHtml(html: string, noteId: string): EditorBlock[] {
  if (!html.trim()) {
    return [];
  }
  return pastedBlocksFromHtml(html).map((item) => {
    const block = createBlock(item.type, noteId);
    block.payload = item.payload;
    return block;
  });
}

/**
 * 文档级粘贴纯文本时的兜底：空行分段，段内保留换行。
 * 有 `text/html` 时优先走 `pastedBlocksFromHtml` 保留块结构。
 */
function pastedBlocksFromPlainText(text: string): PastedBlock[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return [];
  }
  return normalized
    .split(/\n{2,}/)
    .filter((part) => part.trim() !== '')
    .map((part) => ({
      type: 'paragraph' as KnownBlockType,
      payload: { runs: pastedTextRuns(part) } as PastedBlock['payload'],
    }));
}

function saveLabelOf(state: SaveState): string {
  switch (state) {
    case 'saved':
      return '已保存到本机';
    case 'dirty':
      return '编辑中…';
    case 'saving':
      return '保存中…';
    case 'error':
      return '保存失败';
  }
}

export function NoteBlockEditor({
  noteId,
  source,
  commandRef,
  onActiveBlockChange,
  initialHtml = '',
  initialReadOnly = false,
  readOnly: controlledReadOnly,
  onReadOnlyChange,
  stylePanelOpen: controlledPanelOpen,
  onStylePanelChange,
  focusMode: controlledFocusMode,
  onFocusModeChange,
  filePickerToken,
  scrollToBlock,
  initialScrollTop = 0,
  onScrollPositionChange,
  noteOptions,
  onOpenNote,
  attachmentManager,
  attachmentUploader,
  attachmentSyncMode,
  attachmentUnavailableReason,
  onAttachmentIngested,
  onBlocksChange,
  showHistoryControls = true,
  onHistoryChange,
  historyAction,
  saveDelayMs = 300,
  className,
  onDocumentChange,
  onError,
}: NoteBlockEditorProps) {
  const repository = useMemo(
    () => source ?? createBlockRepository(db),
    [source],
  );
  const [blocks, setBlocks] = useState<EditorBlock[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [internalReadOnly, setInternalReadOnly] =
    useState(initialReadOnly);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  /** 文档级块选择；临时 UI 状态，不写 payload / localStorage。 */
  const [blockSelection, setBlockSelection] =
    useState<BlockSelection | null>(null);
  /** 选择来源：整篇选择不显示复选框，高级块选择才显示。 */
  const [selectionMode, setSelectionMode] =
    useState<BlockSelectionMode | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveTargetId, setMoveTargetId] = useState<string | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [menu, setMenu] = useState<MenuState>(null);
  /** 编辑器内右键菜单：文本 / 表格 / 公式 / 空白共用一套 ContextMenu。 */
  const [editorMenu, setEditorMenu] = useState<EditorContextMenuState>(null);
  const editorMenuRef = useRef<EditorContextMenuState>(null);
  const [internalPanelOpen, setInternalPanelOpen] = useState(false);
  const [internalFocusMode, setInternalFocusMode] = useState(false);
  const [writingFollow, setWritingFollow] = useState(readWritingFollowPreference);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  /** 引用出处弹层：只存块 id，payload 始终从 blocks 读取，避免快照漂移。 */
  const [quoteDialogBlockId, setQuoteDialogBlockId] = useState<
    string | null
  >(null);
  const [highlightBlockId, setHighlightBlockId] = useState<string | null>(
    null,
  );
  const [pendingFocus, setPendingFocus] = useState<PendingFocus>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [fileLocalStates, setFileLocalStates] = useState<
    Record<string, FileCardLocalState>
  >({});
  const [fileSyncStates, setFileSyncStates] = useState<
    Record<string, AttachmentDisplayState>
  >({});
  const [fileLocalErrors, setFileLocalErrors] = useState<
    Record<string, string | null>
  >({});
  const [fileIngestError, setFileIngestError] = useState<string | null>(null);
  const [fileIngesting, setFileIngesting] = useState(false);
  const [fileLocalToken, setFileLocalToken] = useState(0);
  const [filePreview, setFilePreview] = useState<{
    fileName: string;
    url: string;
  } | null>(null);

  const readOnly = controlledReadOnly ?? internalReadOnly;
  const panelOpen = controlledPanelOpen ?? internalPanelOpen;
  const focusMode = controlledFocusMode ?? internalFocusMode;

  /** 批量移动的目标笔记：排除当前笔记，数据来自知识页已有的未删除笔记。 */
  const moveTargets = useMemo(
    () => (noteOptions ?? []).filter((option) => option.id !== noteId),
    [noteId, noteOptions],
  );

  const quoteDialogBlock = useMemo(
    () =>
      quoteDialogBlockId
        ? blocks.find((block) => block.id === quoteDialogBlockId) ??
          null
        : null,
    [blocks, quoteDialogBlockId],
  );
  const quoteDialogMeta = useMemo(
    () =>
      quoteDialogBlock && quoteDialogBlock.type === 'quote'
        ? blockQuoteMeta(quoteDialogBlock)
        : null,
    [quoteDialogBlock],
  );

  // 块被删除/撤销掉时，同步清掉悬空的弹层状态，避免多按一次 Esc。
  useEffect(() => {
    if (quoteDialogBlockId && !quoteDialogBlock) {
      setQuoteDialogBlockId(null);
    }
  }, [quoteDialogBlock, quoteDialogBlockId]);

  const bodyRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const blocksRef = useRef<EditorBlock[]>([]);
  const mountedRef = useRef(true);
  const noteIdRef = useRef(noteId);
  const selectionRef = useRef<EditorSelection | null>(null);
  const blockSelectionRef = useRef<BlockSelection | null>(null);
  const selectionModeRef = useRef<BlockSelectionMode | null>(null);
  /**
   * 块首 Backspace 选中原子块后的护栏：用户继续按住/连按 Backspace 时
   * 不删除该块，必须先按 Delete 或走块菜单，避免一次误删多个块。
   */
  const backspaceSelectionGuardRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);
  const pendingFileTargetRef = useRef<{
    blockId: string;
    mode: 'insert' | 'replace';
  } | null>(null);
  const fileIngestingRef = useRef(false);
  const initialHtmlRef = useRef(initialHtml);
  const saveTimerRef = useRef<number | null>(null);
  const savingRef = useRef<Promise<void> | null>(null);
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const scheduleSaveRef = useRef<() => void>(() => undefined);
  const onDocumentChangeRef = useRef(onDocumentChange);
  const onErrorRef = useRef(onError);
  const onBlocksChangeRef = useRef(onBlocksChange);
  const onAttachmentIngestedRef = useRef(onAttachmentIngested);
  const onHistoryChangeRef = useRef(onHistoryChange);
  const onReadOnlyChangeRef = useRef(onReadOnlyChange);
  const onPanelOpenChangeRef = useRef(onStylePanelChange);
  const onFocusModeChangeRef = useRef(onFocusModeChange);
  const onActiveBlockChangeRef = useRef(onActiveBlockChange);
  const handledFileTokenRef = useRef(filePickerToken ?? 0);
  const handledScrollTokenRef = useRef(scrollToBlock?.token ?? 0);
  const handledHistoryTokenRef = useRef(historyAction?.token ?? 0);
  const highlightTimerRef = useRef<number | null>(null);
  const previousReadOnlyRef = useRef(readOnly);
  /** 撤销/重做：只存在内存里，切换笔记即清空。 */
  const undoStackRef = useRef<BlockHistoryEntry[]>([]);
  const redoStackRef = useRef<BlockHistoryEntry[]>([]);
  const lastMergeRef = useRef<MergeMark | null>(null);
  const historyEnabledRef = useRef(false);
  const historyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeBlockIdRef = useRef<string | null>(null);
  /** 输入法组合期间暂停写作跟随，避免候选窗抖动。 */
  const composingRef = useRef(false);
  const onScrollPositionChangeRef = useRef(onScrollPositionChange);
  /** 当前正文滚动位置：卸载时回传给知识页按笔记记忆。 */
  const scrollPositionRef = useRef(0);
  const initialScrollAppliedRef = useRef(false);

  useEffect(() => {
    onDocumentChangeRef.current = onDocumentChange;
  }, [onDocumentChange]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    onBlocksChangeRef.current = onBlocksChange;
  }, [onBlocksChange]);
  useEffect(() => {
    onAttachmentIngestedRef.current = onAttachmentIngested;
  }, [onAttachmentIngested]);
  useEffect(() => {
    onHistoryChangeRef.current = onHistoryChange;
  }, [onHistoryChange]);
  useEffect(() => {
    onReadOnlyChangeRef.current = onReadOnlyChange;
  }, [onReadOnlyChange]);
  useEffect(() => {
    onPanelOpenChangeRef.current = onStylePanelChange;
  }, [onStylePanelChange]);
  useEffect(() => {
    onFocusModeChangeRef.current = onFocusModeChange;
  }, [onFocusModeChange]);
  useEffect(() => {
    onActiveBlockChangeRef.current = onActiveBlockChange;
  }, [onActiveBlockChange]);
  useEffect(() => {
    onScrollPositionChangeRef.current = onScrollPositionChange;
  }, [onScrollPositionChange]);

  useEffect(() => {
    activeBlockIdRef.current = activeBlockId;
  }, [activeBlockId]);

  useEffect(() => {
    editorMenuRef.current = editorMenu;
  }, [editorMenu]);

  // 切换阅读模式/笔记时菜单必须收起，避免动作落在已经不存在的块上。
  useEffect(() => {
    setEditorMenu(null);
    editorMenuRef.current = null;
  }, [noteId, readOnly]);

  // 只读、加载失败、保存失败都不记录历史；恢复后自动继续记录。
  useEffect(() => {
    historyEnabledRef.current =
      !readOnly && loadState === 'ready' && saveState !== 'error';
  }, [loadState, readOnly, saveState]);

  /** 受控/非受控共用的状态写入；受控时只通知上层。 */
  const updatePanelOpen = useCallback(
    (next: boolean) => {
      if (onPanelOpenChangeRef.current) {
        onPanelOpenChangeRef.current(next);
      } else {
        setInternalPanelOpen(next);
      }
    },
    [],
  );

  const updateFocusMode = useCallback((next: boolean) => {
    if (onFocusModeChangeRef.current) {
      onFocusModeChangeRef.current(next);
    } else {
      setInternalFocusMode(next);
    }
  }, []);

  /** 写作跟随是设备偏好，只存本机，不进入笔记数据。 */
  const updateWritingFollow = useCallback((next: boolean) => {
    setWritingFollow(next);
    writeWritingFollowPreference(next);
  }, []);

  const updateReadOnly = useCallback(
    (next: boolean) => {
      if (onReadOnlyChangeRef.current) {
        onReadOnlyChangeRef.current(next);
      } else {
        setInternalReadOnly(next);
      }
    },
    [],
  );

  const syncHistoryAvailability = useCallback(() => {
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
  }, []);

  const clearHistory = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    lastMergeRef.current = null;
    setCanUndo(false);
    setCanRedo(false);
  }, []);

  /** 块选择必须同步写 ref：键盘处理器在 React 状态更新前就要读到最新值。 */
  const applyBlockSelection = useCallback(
    (next: BlockSelection | null, mode?: BlockSelectionMode) => {
      // 任何新的选择/清空都先解除 Backspace 护栏，避免状态串到下一次选择。
      backspaceSelectionGuardRef.current = false;
      const resolved = next
        ? (mode ?? selectionModeRef.current ?? 'block')
        : null;
      blockSelectionRef.current = next;
      selectionModeRef.current = resolved;
      setBlockSelection(next);
      setSelectionMode(resolved);
    },
    [],
  );

  const showSelectionNotice = useCallback((message: string | null) => {
    setSelectionNotice(message);
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    if (!message) {
      return;
    }
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      setSelectionNotice(null);
    }, 3200);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
    },
    [],
  );

  // 切换笔记不得复用上一篇的历史。
  useEffect(() => {
    clearHistory();
  }, [clearHistory, noteId]);
  useEffect(() => {
    noteIdRef.current = noteId;
  }, [noteId]);
  // 只有首次读取（块为空）时才使用旧 HTML；保存后的父级 body 更新不能
  // 触发重新投影，否则会覆盖用户正在编辑的块和光标。
  useEffect(() => {
    initialHtmlRef.current = initialHtml;
  }, [initialHtml, noteId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      // 卸载/切换笔记时尽量把最新草稿落库；失败不阻塞关闭。
      const snapshot = blocksRef.current;
      if (snapshot.length > 0) {
        void repository
          .saveDocument(noteId, snapshot.map(toBlockDraft))
          .catch(() => undefined);
      }
    };
  }, [repository, noteId]);

  // 读取块 ----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setError(null);
    setSelection(null);
    selectionRef.current = null;
    blockSelectionRef.current = null;
    selectionModeRef.current = null;
    setBlockSelection(null);
    setSelectionMode(null);
    setMoveDialogOpen(false);
    setMenu(null);
    updatePanelOpen(false);
    setLinkDialogOpen(false);
    setQuoteDialogBlockId(null);
    clearHistory();

    repository
      .list(noteId)
      .then((rows) => {
        if (cancelled) {
          return;
        }
        const legacy = normalizeLegacyBlocks(rows);
        const seeded =
          legacy.length === 0
            ? blocksFromInitialHtml(initialHtmlRef.current, noteId)
            : legacy;
        const normalized = normalizeBlockOrder(
          ensureTrailingParagraph(seeded, noteId),
        );
        blocksRef.current = normalized;
        setBlocks(normalized);
        setActiveBlockId(normalized[0]?.id ?? null);
        setLoadState('ready');
        setSaveState('saved');
      })
      .catch((reason: unknown) => {
        if (cancelled) {
          return;
        }
        const message = formatError(reason);
        setError(message);
        setLoadState('error');
        onErrorRef.current?.(
          reason instanceof Error ? reason : new Error(message),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [repository, noteId, reloadToken, updatePanelOpen, clearHistory]);

  // 保存 ------------------------------------------------------------------
  const scheduleSave = useCallback(() => {
    setSaveState('dirty');
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushRef.current();
    }, saveDelayMs);
  }, [saveDelayMs]);

  useEffect(() => {
    scheduleSaveRef.current = scheduleSave;
  }, [scheduleSave]);

  const flushSave = useCallback(async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    // 阅读模式不再写入新编辑，但进入阅读/卸载前仍需把已排队的草稿落库。
    const snapshot = blocksRef.current;
    if (snapshot.length === 0) {
      return;
    }
    const currentNoteId = noteIdRef.current;
    setSaveState('saving');

    const previous = savingRef.current;
    const run = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const saved = await repository.saveDocument(
          currentNoteId,
          snapshot.map(toBlockDraft),
        );
        if (!mountedRef.current || noteIdRef.current !== currentNoteId) {
          return;
        }
        if (blocksRef.current === snapshot) {
          const normalized = normalizeBlockOrder(
            ensureTrailingParagraph(saved, currentNoteId),
          );
          blocksRef.current = normalized;
          setBlocks(normalized);
          setSaveState('saved');
          setError(null);
          onDocumentChangeRef.current?.(
            serializeBlockDocument(normalized, currentNoteId),
          );
        } else {
          // 保存期间用户继续输入：不要用旧快照覆盖本地，再排一次保存。
          setSaveState('dirty');
          scheduleSaveRef.current();
        }
      })
      .catch((reason: unknown) => {
        if (!mountedRef.current) {
          return;
        }
        const message = formatError(reason);
        setSaveState('error');
        setError(message);
        onErrorRef.current?.(
          reason instanceof Error ? reason : new Error(message),
        );
      });

    savingRef.current = run;
    await run;
    if (savingRef.current === run) {
      savingRef.current = null;
    }
  }, [repository]);

  useEffect(() => {
    flushRef.current = flushSave;
  }, [flushSave]);

  /** 当前光标/选区；用于撤销后把光标放回原块。 */
  const readCaret = useCallback((): HistoryCaret | null => {
    if (typeof document === 'undefined') {
      return null;
    }
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) {
      return null;
    }
    const body = bodyRef.current;
    if (!body || !body.contains(active)) {
      return null;
    }
    const row = active.closest?.('[data-block-id]');
    const blockId = row?.getAttribute('data-block-id');
    if (!blockId) {
      return null;
    }
    if (active.getAttribute('data-inline-editor') === 'true') {
      try {
        const offsets = selectionOffsetsIn(active);
        return offsets ? { blockId, ...offsets } : { blockId, start: 0, end: 0 };
      } catch {
        return { blockId, start: 0, end: 0 };
      }
    }
    if (
      typeof HTMLInputElement !== 'undefined' &&
      active instanceof HTMLInputElement
    ) {
      const start = active.selectionStart ?? 0;
      const end = active.selectionEnd ?? start;
      return { blockId, start, end };
    }
    if (
      typeof HTMLTextAreaElement !== 'undefined' &&
      active instanceof HTMLTextAreaElement
    ) {
      const start = active.selectionStart ?? 0;
      const end = active.selectionEnd ?? start;
      return { blockId, start, end };
    }
    return null;
  }, []);

  /**
   * 在块变更前记录当前文档快照。
   * - 同一 mergeKey 在 400ms 内只记第一步，连续输入最终撤销回输入前；
   * - 任何新变更都会清空 redo 分支。
   */
  const recordHistory = useCallback(
    (next: ReadonlyArray<EditorBlock>, history?: HistoryOption) => {
      if (history === false || !historyEnabledRef.current) {
        lastMergeRef.current = null;
        return;
      }
      const mergeKey = history?.mergeKey;
      const now = Date.now();
      const last = lastMergeRef.current;
      if (
        mergeKey &&
        last &&
        last.key === mergeKey &&
        now - last.at < HISTORY_MERGE_MS &&
        undoStackRef.current.length > 0
      ) {
        last.at = now;
        if (redoStackRef.current.length > 0) {
          redoStackRef.current = [];
          syncHistoryAvailability();
        }
        return;
      }

      let caret = readCaret();
      if (mergeKey?.startsWith('text:')) {
        const blockId = mergeKey.slice('text:'.length);
        const before = blocksRef.current.find((block) => block.id === blockId);
        const after = next.find((block) => block.id === blockId);
        if (before && after) {
          caret = caretBeforeTextChange(
            caret,
            blockId,
            blockRuns(before),
            blockRuns(after),
          );
        }
      }

      const entry: BlockHistoryEntry = {
        blocks: cloneHistoryBlocks(blocksRef.current),
        activeBlockId: activeBlockIdRef.current,
        caret,
        ...(history?.sideEffects
          ? { sideEffects: history.sideEffects }
          : {}),
      };
      undoStackRef.current = pushHistoryEntry(undoStackRef.current, entry);
      redoStackRef.current = [];
      lastMergeRef.current = mergeKey ? { key: mergeKey, at: now } : null;
      syncHistoryAvailability();
    },
    [readCaret, syncHistoryAvailability],
  );

  const commitBlocks = useCallback(
    (
      next: EditorBlock[],
      options?: { save?: boolean; history?: HistoryOption },
    ) => {
      const normalized = normalizeBlockOrder(next);
      recordHistory(normalized, options?.history);
      blocksRef.current = normalized;
      setBlocks(normalized);
      setActiveBlockId((current) =>
        current && normalized.some((block) => block.id === current)
          ? current
          : (normalized[0]?.id ?? null),
      );
      if (options?.save !== false) {
        scheduleSave();
      }
    },
    [recordHistory, scheduleSave],
  );

  const updateBlock = useCallback(
    (
      blockId: string,
      updater: (block: EditorBlock) => EditorBlock,
      history?: HistoryOption,
    ) => {
      const next = blocksRef.current.map((block) =>
        block.id === blockId ? updater(block) : block,
      );
      commitBlocks(next, { history });
    },
    [commitBlocks],
  );

  // 上层（知识页大纲/附件/画板列表）只读快照；不触发 body 写回。
  useEffect(() => {
    onBlocksChangeRef.current?.(blocks);
  }, [blocks]);

  const fileBlocksKey = useMemo(
    () =>
      blocks
        .filter((block) => block.type === 'file')
        .map(
          (block) =>
            `${block.id}:${String(block.payload.attachmentId ?? '')}`,
        )
        .join('|'),
    [blocks],
  );

  /**
   * 文件卡的本机可用性必须问附件管理器，不能相信块里的快照状态。
   * 附件记录被删除、Blob 丢失或哈希校验失败都统一显示“缺失”，
   * 绝不在没有内容时渲染一个能点但打不开的“打开”按钮。
   */
  useEffect(() => {
    let cancelled = false;
    const fileBlocks = blocksRef.current.filter(
      (block) => block.type === 'file',
    );
    if (fileBlocks.length === 0) {
      setFileLocalStates({});
      setFileSyncStates({});
      setFileLocalErrors({});
      return;
    }
    if (!attachmentManager) {
      const reason =
        attachmentUnavailableReason ??
        '附件服务不可用，当前无法读取本机文件';
      const states: Record<string, FileCardLocalState> = {};
      const syncStates: Record<string, AttachmentDisplayState> = {};
      const errors: Record<string, string | null> = {};
      fileBlocks.forEach((block) => {
        const file = blockFile(block);
        states[block.id] = file.attachmentId ? 'unavailable' : 'none';
        syncStates[block.id] = file.attachmentId
          ? 'service_unavailable'
          : 'missing';
        if (file.attachmentId) {
          errors[block.id] = reason;
        } else if (file.status === 'missing') {
          states[block.id] = 'missing';
          errors[block.id] = '本机没有这个文件本体，请重新选择';
        }
      });
      setFileLocalStates(states);
      setFileSyncStates(syncStates);
      setFileLocalErrors(errors);
      return;
    }

    void (async () => {
      const states: Record<string, FileCardLocalState> = {};
      const syncStates: Record<string, AttachmentDisplayState> = {};
      const errors: Record<string, string | null> = {};
      await Promise.all(
        fileBlocks.map(async (block) => {
          const file = blockFile(block);
          if (!file.attachmentId) {
            states[block.id] =
              file.status === 'missing' ? 'missing' : 'none';
            syncStates[block.id] = 'missing';
            if (file.status === 'missing') {
              errors[block.id] = '本机没有这个文件本体，请重新选择';
            }
            return;
          }
          try {
            const stored = await attachmentManager.get(file.attachmentId);
            const hasLocal = await attachmentManager.hasLocalBlob(
              file.attachmentId,
            );
            states[block.id] = hasLocal
              ? 'local'
              : stored.state.status === 'remote'
                ? 'remote'
                : 'missing';
            syncStates[block.id] = describeAttachmentStatus({
              status: stored.state.status,
              hasLocal,
              mode: attachmentSyncMode ?? attachmentManager.currentMode(),
              serviceAvailable: Boolean(attachmentUploader),
              remoteId: stored.state.remoteId,
              lastError: stored.state.lastError,
            }).state;
            errors[block.id] = stored.state.lastError;
          } catch (reason) {
            states[block.id] = 'missing';
            syncStates[block.id] = 'missing';
            errors[block.id] =
              reason instanceof Error ? reason.message : '附件记录不存在';
          }
        }),
      );
      if (!cancelled) {
        setFileLocalStates(states);
        setFileSyncStates(syncStates);
        setFileLocalErrors(errors);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    attachmentManager,
    attachmentUploader,
    attachmentSyncMode,
    attachmentUnavailableReason,
    fileBlocksKey,
    fileLocalToken,
  ]);

  useEffect(() => {
    if (!filePreview) {
      return;
    }
    return () => {
      revokeObjectUrl(filePreview.url);
    };
  }, [filePreview]);

  // 受控阅读模式从「可编辑」切到「只读」时，先落库再收起浮层。
  useEffect(() => {
    if (previousReadOnlyRef.current === readOnly) {
      return;
    }
    previousReadOnlyRef.current = readOnly;
    if (!readOnly) {
      return;
    }
    void flushRef.current();
    setMenu(null);
    setSelection(null);
    selectionRef.current = null;
    blockSelectionRef.current = null;
    selectionModeRef.current = null;
    setBlockSelection(null);
    setSelectionMode(null);
    setMoveDialogOpen(false);
    setLinkDialogOpen(false);
    setQuoteDialogBlockId(null);
    updatePanelOpen(false);
  }, [readOnly, updatePanelOpen]);

  // 焦点与选区 ------------------------------------------------------------
  const scrollBlockToCenter = useCallback((blockId: string) => {
    if (typeof bodyRef.current?.querySelectorAll !== 'function') {
      return;
    }
    const row = Array.from(
      bodyRef.current.querySelectorAll<HTMLElement>('[data-block-id]'),
    ).find((element) => element.dataset.blockId === blockId);
    row?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, []);

  /**
   * 专注模式的「写作跟随」：把当前块放到滚动容器约 36% 高度。
   * v1 按整块对齐，代码/表格/图片/画板嵌入同样整块；行级打字机属于
   * 正式版增强，不在本轮承诺。
   */
  const scrollBlockToWritingLine = useCallback(
    (blockId: string, smooth = true) => {
      const body = bodyRef.current;
      if (!body) {
        return;
      }
      const row = Array.from(
        body.querySelectorAll<HTMLElement>('[data-block-id]'),
      ).find((element) => element.dataset.blockId === blockId);
      if (!row) {
        return;
      }
      const behavior: ScrollBehavior =
        smooth && !prefersReducedMotion() ? 'smooth' : 'auto';
      if (typeof body.scrollTo === 'function') {
        const bodyRect = body.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const target =
          body.scrollTop +
          (rowRect.top - bodyRect.top) -
          body.clientHeight * 0.36;
        body.scrollTo({ top: Math.max(0, target), behavior });
        return;
      }
      // 没有布局/滚动 API 的环境（jsdom）不制造假位移。
      row.scrollIntoView?.({ block: 'center', behavior });
    },
    [],
  );

  // 搜索结果高亮：只加 class，1.4s 后自动褪去，不修改块内容。
  const flashBlock = useCallback((blockId: string) => {
    setHighlightBlockId(blockId);
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = null;
      setHighlightBlockId(null);
    }, 1400);
  }, []);

  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
    },
    [],
  );

  // 打开/切回笔记时恢复上次阅读位置。只执行一次，且不参与保存/撤销重渲染；
  // 显式 scrollToBlock（大纲/搜索）在下方 effect 里仍可覆盖到目标块。
  useEffect(() => {
    if (loadState !== 'ready' || initialScrollAppliedRef.current) {
      return;
    }
    initialScrollAppliedRef.current = true;
    const body = bodyRef.current;
    if (!body || !initialScrollTop) {
      return;
    }
    body.scrollTop = initialScrollTop;
    scrollPositionRef.current = initialScrollTop;
  }, [initialScrollTop, loadState]);

  // 卸载/切笔记前把最后一次滚动位置交还上层；运行期记忆，不写持久化。
  useEffect(() => {
    return () => {
      onScrollPositionChangeRef.current?.(noteId, scrollPositionRef.current);
    };
  }, [noteId]);

  // 大纲点击/搜索定位：滚动；搜索命中时再短暂高亮。
  useEffect(() => {
    if (!scrollToBlock) {
      return;
    }
    if (scrollToBlock.token === handledScrollTokenRef.current) {
      return;
    }
    handledScrollTokenRef.current = scrollToBlock.token;
    scrollBlockToCenter(scrollToBlock.blockId);
    if (scrollToBlock.highlight) {
      flashBlock(scrollToBlock.blockId);
    }
  }, [scrollToBlock, scrollBlockToCenter, flashBlock]);

  // 知识页「附件 → 插入文件」：复用编辑器已有的文件选择与文件卡插入逻辑。
  useEffect(() => {
    if (filePickerToken === undefined || loadState !== 'ready') {
      return;
    }
    if (filePickerToken === handledFileTokenRef.current) {
      return;
    }
    handledFileTokenRef.current = filePickerToken;
    if (readOnly) {
      return;
    }
    const target =
      activeBlockId ??
      blocksRef.current[blocksRef.current.length - 1]?.id ??
      null;
    if (target) {
      pendingFileTargetRef.current = { blockId: target, mode: 'insert' };
    }
    fileInputRef.current?.click();
  }, [activeBlockId, filePickerToken, loadState, readOnly]);

  useEffect(() => {
    if (!pendingFocus) {
      return;
    }
    const rows = Array.from(
      bodyRef.current?.querySelectorAll<HTMLElement>('[data-block-id]') ?? [],
    );
    const row = rows.find(
      (element) => element.dataset.blockId === pendingFocus.blockId,
    );
    const target = pendingFocus.rowOnly
      ? null
      : (row?.querySelector<HTMLElement>('[data-inline-editor="true"]') ??
        row?.querySelector<HTMLElement>('textarea, input') ??
        row?.querySelector<HTMLElement>('[contenteditable="true"]'));
    if (target) {
      // 程序化聚焦一律 preventScroll：可见性只由 scrollToBlock / 专注写作跟随负责，
      // 否则聚焦最后一个块时浏览器会把正文滚到底部。
      target.focus({ preventScroll: true });
      if (target.dataset.inlineEditor === 'true' && !readOnly) {
        const start = pendingFocus.start;
        const end = pendingFocus.end ?? start;
        if (typeof start === 'number') {
          // 延迟到浏览器完成 contenteditable 聚焦后的选区初始化。
          queueMicrotask(() => {
            restoreSelectionByOffsets(target, start, end ?? start);
          });
        } else {
          const range = document.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
          const domSelection = window.getSelection();
          domSelection?.removeAllRanges();
          domSelection?.addRange(range);
        }
      }
    } else if (row) {
      // 表格/画板/文件卡等原子块没有可编辑文本；把焦点落到整行，
      // 让后续 Backspace/块菜单仍作用于该块，而不是掉回文档开头。
      row.focus({ preventScroll: true });
    }
    setPendingFocus(null);
  }, [pendingFocus, readOnly]);

  const focusBlock = useCallback(
    (blockId: string, start?: number, end?: number) => {
      setPendingFocus({ blockId, start, end });
    },
    [],
  );

  /** 只把焦点放到块整行（不进入内部输入框），供原子块选中态使用。 */
  const focusBlockRow = useCallback((blockId: string) => {
    setPendingFocus({ blockId, rowOnly: true });
  }, []);

  // 文档级块选择 ----------------------------------------------------------

  const clearBlockSelection = useCallback(
    (focusBack = false) => {
      applyBlockSelection(null);
      if (!focusBack) {
        return;
      }
      const id = activeBlockIdRef.current ?? blocksRef.current[0]?.id;
      if (id) {
        focusBlock(id);
      }
    },
    [applyBlockSelection, focusBlock],
  );

  /** checkbox / Shift+点击 / ⌘点击 的统一入口。 */
  const handleBlockSelect = useCallback(
    (
      blockId: string,
      modifiers: {
        shiftKey: boolean;
        additive: boolean;
        /** false：仅取消选择，不把光标送回块内（行前控件点击）。 */
        restoreFocus?: boolean;
        /** true：键盘触发时保留控件焦点，不把焦点交给正文。 */
        preserveFocus?: boolean;
      },
    ) => {
      if (readOnly) {
        return;
      }
      const current = blocksRef.current;
      if (!current.some((block) => block.id === blockId)) {
        return;
      }
      const previous = blockSelectionRef.current;
      let next: BlockSelection | null;
      if (modifiers.shiftKey) {
        next = createBlockSelection(
          current,
          previous?.anchorId ?? activeBlockIdRef.current ?? blockId,
          blockId,
        );
      } else if (modifiers.additive) {
        next = toggleBlockSelection(current, previous, blockId);
      } else {
        next = createBlockSelection(current, blockId, blockId);
      }
      applyBlockSelection(next, 'block');
      selectionRef.current = null;
      setSelection(null);
      setActiveBlockId(blockId);
      if (!next) {
        // 行前控件取消选择时不抢焦点，避免把光标送进正文（ZX10-BLOCKSEL-01）。
        if (modifiers.restoreFocus !== false) {
          focusBlock(blockId);
        }
        return;
      }
      window.getSelection()?.removeAllRanges();
      if (!modifiers.preserveFocus) {
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          active.closest('[data-inline-editor="true"]')
        ) {
          active.blur();
        }
        bodyRef.current?.focus({ preventScroll: true });
      }
      showSelectionNotice(
        `已选 ${next.ids.length} 个块${
          next.ids.length > 1 ? ' · Shift+点击可扩展范围' : ''
        }`,
      );
    },
    [
      applyBlockSelection,
      focusBlock,
      readOnly,
      showSelectionNotice,
    ],
  );

  /**
   * 高级块选择入口：从当前块开始进入块选择模式。
   *
   * 普通写作态已可通过每行行前的低频入口选整行（ZX10-BLOCKSEL-01）；
   * 需要从当前块进入高级块选择、批量移动/删除时，用底部「选择块」或
   * 快捷键显式进入，再 Shift+点击扩展范围。
   */
  const enterBlockSelectionMode = useCallback(() => {
    if (readOnly) {
      return;
    }
    const focused =
      document.activeElement instanceof Element
        ? document.activeElement.closest('[data-block-id]')
        : null;
    const focusedId = focused?.getAttribute('data-block-id');
    const id =
      focusedId ??
      activeBlockIdRef.current ??
      blocksRef.current[0]?.id;
    if (!id) {
      return;
    }
    handleBlockSelect(id, { shiftKey: false, additive: false });
  }, [handleBlockSelect, readOnly]);

  /** ⌘/Ctrl+A 一次选中整篇；重复按下保持全选，Esc 或点击空白退出。 */
  const selectAllBlocksAction = useCallback(
    (mode: BlockSelectionMode = 'document') => {
      if (readOnly) {
        return;
      }
      const current = blocksRef.current;
      const alreadyAll =
        current.length > 0 &&
        blockSelectionRef.current?.ids.length === current.length &&
        selectionModeRef.current === mode;
      const next = selectAllBlocks(current);
      if (!next) {
        return;
      }
      applyBlockSelection(next, mode);
      selectionRef.current = null;
      setSelection(null);
      setActiveBlockId(next.focusId);
      const active = document.activeElement;
      if (active instanceof HTMLElement && mode === 'document') {
        active.blur();
      }
      if (mode === 'document') {
        // 文档级选择用原生 Range 覆盖整篇可复制文本（控件文案除外），
        // 直接支持原生复制；块高亮负责不可复制的对象块（文件/画板等）。
        bodyRef.current?.focus({ preventScroll: true });
        selectDocumentContent(bodyRef.current);
      } else {
        window.getSelection()?.removeAllRanges();
        bodyRef.current?.focus({ preventScroll: true });
      }
      // 第二次 ⌘A 不循环、不选页面，只维持整篇选择。
      if (alreadyAll) {
        showSelectionNotice(
          mode === 'document'
            ? '已是整篇 · Delete 删除 · Esc 取消'
            : `已选 ${next.ids.length} 个块 · Esc 取消`,
        );
        return;
      }
      if (mode === 'document') {
        showSelectionNotice(
          `已选中整篇 · ${next.ids.length} 个块 · ${
            blocksToPlainText(current).length
          } 字 · Delete 删除 · Esc 取消`,
        );
        return;
      }
      showSelectionNotice(
        `已选 ${next.ids.length} 个块 · Shift+点击可扩展范围`,
      );
    },
    [applyBlockSelection, readOnly, showSelectionNotice],
  );

  const deleteSelectedBlocks = useCallback(() => {
    if (readOnly) {
      return;
    }
    const currentSelection = blockSelectionRef.current;
    if (!currentSelection?.ids.length) {
      return;
    }
    const selected = new Set(currentSelection.ids);
    const current = blocksRef.current;
    const firstIndex = current.findIndex((block) => selected.has(block.id));
    const count = current.filter((block) => selected.has(block.id)).length;
    if (count === 0) {
      clearBlockSelection();
      return;
    }
    const next = removeBlocksByIds(current, selected, noteId);
    // 一次 commit = 一步历史；撤销恢复完整顺序与 payload。
    commitBlocks(next);
    applyBlockSelection(null);
    showSelectionNotice(`已删除 ${count} 个块 · 可 ⌘/Ctrl+Z 撤销`);
    const neighbour =
      next[Math.min(Math.max(firstIndex, 0), next.length - 1)] ?? next[0];
    if (neighbour) {
      focusBlock(neighbour.id);
    }
  }, [
    applyBlockSelection,
    clearBlockSelection,
    commitBlocks,
    focusBlock,
    noteId,
    readOnly,
    showSelectionNotice,
  ]);

  const buildSelectionClipboard = useCallback(() => {
    const currentSelection = blockSelectionRef.current;
    if (!currentSelection?.ids.length) {
      return null;
    }
    const ids = new Set(currentSelection.ids);
    const selected = blocksRef.current.filter((block) => ids.has(block.id));
    if (selected.length === 0) {
      return null;
    }
    return {
      blocks: selected,
      text: blocksToPlainText(selected),
      html: blocksToClipboardHtml(selected),
    };
  }, []);

  /** 操作条「复制」：优先写双格式剪贴板，失败时给出可执行提示。 */
  const copySelectedBlocks = useCallback(async () => {
    const payload = buildSelectionClipboard();
    if (!payload) {
      return;
    }
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard?.write &&
        typeof ClipboardItem !== 'undefined'
      ) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([payload.text], {
              type: 'text/plain',
            }),
            'text/html': new Blob([payload.html], {
              type: 'text/html',
            }),
          }),
        ]);
      } else if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(payload.text);
      } else {
        throw new Error('当前环境不支持写入剪贴板');
      }
      showSelectionNotice(`已复制 ${payload.blocks.length} 个块`);
    } catch {
      showSelectionNotice('复制失败，请用 ⌘/Ctrl+C 或手动选择文本');
    }
  }, [buildSelectionClipboard, showSelectionNotice]);

  const openMoveDialog = useCallback(() => {
    if (readOnly || !blockSelectionRef.current?.ids.length) {
      return;
    }
    if (moveTargets.length === 0) {
      showSelectionNotice('没有其他笔记可移动');
      return;
    }
    setMoveTargetId((current) =>
      current && moveTargets.some((option) => option.id === current)
        ? current
        : moveTargets[0].id,
    );
    setMoveDialogOpen(true);
  }, [moveTargets, readOnly, showSelectionNotice]);

  /**
   * 批量移动：块以新 id 追加到目标笔记末尾；源笔记删除一次提交。
   * 目标笔记的写入通过 history sideEffects 在 ⌘Z / ⇧⌘Z 时一起恢复。
   */
  const moveSelectedBlocks = useCallback(async () => {
    const currentSelection = blockSelectionRef.current;
    const targetId = moveTargetId;
    if (
      readOnly ||
      moveBusy ||
      !currentSelection?.ids.length ||
      !targetId
    ) {
      return;
    }
    const target = moveTargets.find((option) => option.id === targetId);
    if (!target) {
      return;
    }
    const ids = new Set(currentSelection.ids);
    const selected = blocksRef.current.filter((block) => ids.has(block.id));
    if (selected.length === 0) {
      return;
    }
    const sourceNoteId = noteId;
    setMoveBusy(true);
    try {
      const targetBlocks = await repository.list(targetId);
      if (!mountedRef.current || noteIdRef.current !== sourceNoteId) {
        return;
      }
      const now = new Date().toISOString();
      const moved: EditorBlock[] = selected.map((block, index) => ({
        ...block,
        id: newBlockId(),
        noteId: targetId,
        orderKey: (targetBlocks.length + index + 1) * 1024,
        payload: JSON.parse(
          JSON.stringify(block.payload),
        ) as EditorBlock['payload'],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        version: 0,
      }));
      const targetNext = ensureTrailingParagraph(
        [...targetBlocks, ...moved],
        targetId,
      );
      await repository.saveDocument(
        targetId,
        targetNext.map(toBlockDraft),
      );
      if (!mountedRef.current || noteIdRef.current !== sourceNoteId) {
        return;
      }
      const sideEffect: MoveHistorySideEffect = {
        kind: 'move',
        noteId: targetId,
        blocks: cloneHistoryBlocks(selected),
        appliedIds: moved.map((block) => block.id),
      };
      const next = removeBlocksByIds(blocksRef.current, ids, sourceNoteId);
      commitBlocks(next, { history: { sideEffects: [sideEffect] } });
      applyBlockSelection(null);
      setMoveDialogOpen(false);
      showSelectionNotice(
        `已移动 ${selected.length} 个块到「${target.title}」 · 可 ⌘/Ctrl+Z 撤销`,
      );
      const neighbour =
        next.find((block) => isTextualBlockType(block.type)) ?? next[0];
      if (neighbour) {
        focusBlock(neighbour.id);
      }
    } catch (reason) {
      const message = formatError(reason);
      showSelectionNotice(`移动失败：${message}`);
      onErrorRef.current?.(
        reason instanceof Error ? reason : new Error(message),
      );
    } finally {
      if (mountedRef.current) {
        setMoveBusy(false);
      }
    }
  }, [
    applyBlockSelection,
    commitBlocks,
    focusBlock,
    moveBusy,
    moveTargetId,
    moveTargets,
    noteId,
    readOnly,
    repository,
    showSelectionNotice,
  ]);

  // 专注模式没有当前块时，落位到第一个可编辑块；切笔记后同样归位。
  useEffect(() => {
    if (!focusMode || loadState !== 'ready') {
      return;
    }
    if (activeBlockIdRef.current) {
      return;
    }
    const first =
      blocks.find((block) => isTextualBlockType(block.type)) ?? blocks[0];
    if (first) {
      focusBlock(first.id);
    }
  }, [blocks, focusBlock, focusMode, loadState]);

  // 写作跟随：当前块变化、进入专注或重新开启跟随时，滚到约 36% 高度。
  // 不在每次按键时重复滚动；输入法组合期间暂停。
  useEffect(() => {
    if (!focusMode || !writingFollow || composingRef.current) {
      return;
    }
    if (!activeBlockId) {
      return;
    }
    scrollBlockToWritingLine(activeBlockId, true);
  }, [activeBlockId, focusMode, scrollBlockToWritingLine, writingFollow]);

  // 专注入口/退出：⌘⇧F 切换；Esc 先关弹层/清选择，再退出专注。
  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (
        mod &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault();
        updateFocusMode(!focusMode);
        if (!focusMode) {
          updatePanelOpen(false);
        }
        return;
      }
      if (event.key !== 'Escape') {
        return;
      }
      if (moveDialogOpen) {
        setMoveDialogOpen(false);
        return;
      }
      if (menu) {
        setMenu(null);
        return;
      }
      if (linkDialogOpen) {
        setLinkDialogOpen(false);
        return;
      }
      if (quoteDialogBlockId) {
        setQuoteDialogBlockId(null);
        return;
      }
      if (panelOpen) {
        updatePanelOpen(false);
        return;
      }
      if (blockSelection) {
        clearBlockSelection(true);
        showSelectionNotice('已取消块选择');
        return;
      }
      if (selection) {
        selectionRef.current = null;
        setSelection(null);
        return;
      }
      if (focusMode) {
        updateFocusMode(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    blockSelection,
    clearBlockSelection,
    focusMode,
    linkDialogOpen,
    menu,
    moveDialogOpen,
    panelOpen,
    quoteDialogBlockId,
    selection,
    showSelectionNotice,
    updateFocusMode,
    updatePanelOpen,
  ]);

  /**
   * 文档级键盘：⌘/Ctrl+A 三态循环、Delete/Backspace 批量删除、
   * Shift+↑/↓ 扩展范围。只在焦点位于正文或已有块选择时接管。
   */
  useEffect(() => {
    if (readOnly || typeof document === 'undefined') {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      // 局部编辑控件（文件输入、公式源/代码 textarea、表格单元格等）
      // 保留浏览器原生全选与编辑行为；离开这些控件后才由编辑器接管。
      if (
        target?.closest?.(
          '.zxe-dialog-backdrop, .zxe-menu, input, textarea, select',
        )
      ) {
        return;
      }
      // 输入法组合期间不劫持任何快捷键，避免吞掉候选词/删除。
      if (event.isComposing || composingRef.current) {
        return;
      }
      const editor = editorRef.current;
      const active = document.activeElement;
      const targetInEditor = Boolean(
        editor && target && (editor === target || editor.contains(target)),
      );
      const focusInEditor = Boolean(
        editor && active && (editor === active || editor.contains(active)),
      );
      const selecting = Boolean(blockSelectionRef.current?.ids.length);
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      // 正文任意非输入框位置：一次 ⌘/Ctrl+A 选中整篇（含所有块类型）。
      // 高级块选择仍可用 ⌘/Ctrl+Shift+A 进入/退出，作为移动/批量操作入口。
      if (mod && !event.altKey && key === 'a') {
        if (!targetInEditor && !focusInEditor && !selecting) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          if (blockSelectionRef.current) {
            clearBlockSelection(true);
            showSelectionNotice('已取消块选择');
          } else {
            // ⌘⇧A 是高级块选择的全选入口，复选框随之出现。
            selectAllBlocksAction('block');
          }
          return;
        }
        // 普通 ⌘A 是文档级选择，不进入块选择、不显示复选框。
        selectAllBlocksAction('document');
        return;
      }

      if (!selecting) {
        return;
      }
      // 块首 Backspace 刚选中原子块时，连按/长按 Backspace 不再删除；
      // 只有 Delete 或块菜单才是明确的删除动作。
      if (
        event.key === 'Backspace' &&
        backspaceSelectionGuardRef.current
      ) {
        event.preventDefault();
        event.stopPropagation();
        const guarded = blocksRef.current.find(
          (item) => item.id === blockSelectionRef.current?.focusId,
        );
        showSelectionNotice(
          guarded
            ? `${blockLabel(guarded.type)}原子块已选中，按 Delete 删除`
            : '已选中原子块，按 Delete 删除',
        );
        return;
      }
      if (target?.closest?.('[data-inline-editor="true"]')) {
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        deleteSelectedBlocks();
        return;
      }
      if (
        selectionModeRef.current === 'block' &&
        event.shiftKey &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      ) {
        event.preventDefault();
        event.stopPropagation();
        const current = blockSelectionRef.current;
        if (!current) {
          return;
        }
        const next = extendBlockSelection(
          blocksRef.current,
          current,
          event.key === 'ArrowDown' ? 1 : -1,
        );
        applyBlockSelection(next);
        setActiveBlockId(next.focusId);
        showSelectionNotice(
          `已选 ${next.ids.length} 个块 · Shift+点击可扩展范围`,
        );
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [
    applyBlockSelection,
    clearBlockSelection,
    deleteSelectedBlocks,
    readOnly,
    selectAllBlocksAction,
    showSelectionNotice,
  ]);

  /**
   * 点击正文/空白/其他区域退出块选择；checkbox、操作条和弹层保持选择，
   * 避免用户点「复制/移动/删除」时先被清空。
   */
  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest(
          '.zxe-block-select, .zxe-selectionbar, .zxe-select-all, .zxe-dialog-backdrop, .zxe-menu',
        )
      ) {
        return;
      }
      // 选择态下 Shift+点击用于扩展范围，由行/checkbox 处理，不能先清空。
      if (event.shiftKey && blockSelectionRef.current) {
        return;
      }
      if (blockSelectionRef.current) {
        applyBlockSelection(null);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () =>
      document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [applyBlockSelection]);

  // 块选择态下 ⌘/Ctrl+C / X：一次写入纯文本与安全 HTML，不劫持输入框内复制。
  useEffect(() => {
    if (readOnly || typeof document === 'undefined') {
      return;
    }
    const localTarget = (target: Element | null) =>
      Boolean(
        target?.closest?.(
          '.zxe-dialog-backdrop, .zxe-menu, input, textarea, select, [data-inline-editor="true"]',
        ),
      );
    const writeSelection = (event: ClipboardEvent) => {
      const current = blockSelectionRef.current;
      if (!current?.ids.length) {
        return null;
      }
      if (localTarget(event.target as Element | null)) {
        return null;
      }
      const payload = buildSelectionClipboard();
      if (!payload) {
        return null;
      }
      event.clipboardData?.setData('text/plain', payload.text);
      event.clipboardData?.setData('text/html', payload.html);
      event.preventDefault();
      return payload;
    };
    const handleCopy = (event: ClipboardEvent) => {
      const payload = writeSelection(event);
      if (payload) {
        showSelectionNotice(`已复制 ${payload.blocks.length} 个块`);
      }
    };
    const handleCut = (event: ClipboardEvent) => {
      const payload = writeSelection(event);
      if (!payload) {
        return;
      }
      // 先写剪贴板，再一次性删除；commitBlocks 只产生一步历史。
      deleteSelectedBlocks();
      showSelectionNotice(
        `已剪切 ${payload.blocks.length} 个块 · 可 ⌘/Ctrl+Z 一步撤销`,
      );
    };
    document.addEventListener('copy', handleCopy);
    document.addEventListener('cut', handleCut);
    return () => {
      document.removeEventListener('copy', handleCopy);
      document.removeEventListener('cut', handleCut);
    };
  }, [
    buildSelectionClipboard,
    deleteSelectedBlocks,
    readOnly,
    showSelectionNotice,
  ]);

  /**
   * 文档级粘贴：焦点在正文容器（不是行内编辑器/输入框）时，把剪贴板
   * HTML 还原成块；有块选择时替换选中块。行内粘贴仍由 InlineEditable 处理。
   */
  useEffect(() => {
    if (readOnly || typeof document === 'undefined') {
      return;
    }
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target as Element | null;
      if (
        target?.closest?.(
          '.zxe-dialog-backdrop, .zxe-menu, input, textarea, select, [data-inline-editor="true"]',
        )
      ) {
        return;
      }
      const editor = editorRef.current;
      if (!editor || !target || !(editor === target || editor.contains(target))) {
        return;
      }
      const html = event.clipboardData?.getData('text/html') ?? '';
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!html.trim() && !text.trim()) {
        return;
      }
      const parsed = html.trim() ? pastedBlocksFromHtml(html) : [];
      const pasted = parsed.length > 0 ? parsed : pastedBlocksFromPlainText(text);
      event.preventDefault();
      if (pasted.length === 0) {
        return;
      }
      const created = pasted.map((item) => {
        const block = createBlock(item.type, noteId);
        block.payload = item.payload;
        return block;
      });
      const current = blocksRef.current;
      const selection = blockSelectionRef.current;
      let next: EditorBlock[];
      if (selection?.ids.length) {
        const ids = new Set(selection.ids);
        const first = current.findIndex((block) => ids.has(block.id));
        const insertAt =
          first < 0
            ? current.length
            : current
                .slice(0, first)
                .filter((block) => !ids.has(block.id)).length;
        const kept = current.filter((block) => !ids.has(block.id));
        next = [
          ...kept.slice(0, insertAt),
          ...created,
          ...kept.slice(insertAt),
        ];
      } else if (current.length === 1 && isBlockEmpty(current[0])) {
        // 空文档粘贴：直接替换占位空段落，避免正文前多出一行空行。
        next = created;
      } else {
        next = [...current, ...created];
      }
      commitBlocks(ensureTrailingParagraph(next, noteId));
      applyBlockSelection(null);
      focusBlock(created[0].id);
      showSelectionNotice(`已粘贴 ${created.length} 个块`);
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [
    applyBlockSelection,
    commitBlocks,
    focusBlock,
    noteId,
    readOnly,
    showSelectionNotice,
  ]);

  /**
   * 撤销回到旧快照时，若快照里的待办块缺少 `todoId`（例如首次保存前），
   * 从当前同 id 块补回绑定，避免保存时新建另一条 note_todo。
   */
  const mergeTodoBindings = useCallback(
    (snapshot: EditorBlock[]): EditorBlock[] => {
      const currentById = new Map(
        blocksRef.current.map((block) => [block.id, block]),
      );
      return snapshot.map((block) => {
        if (block.type !== 'todo') {
          return block;
        }
        const existingTodoId = block.payload.todoId;
        if (typeof existingTodoId === 'string' && existingTodoId) {
          return block;
        }
        const currentTodoId = currentById.get(block.id)?.payload.todoId;
        if (typeof currentTodoId !== 'string' || !currentTodoId) {
          return block;
        }
        return {
          ...block,
          payload: { ...block.payload, todoId: currentTodoId },
        };
      });
    },
    [],
  );

  /**
   * 待办恢复可能给同一条 note_todo 换新 id；把历史栈里同一正文块的旧
   * todoId 一并迁移，避免之后重做时又新建一条待办。
   */
  const remapHistoryTodoBindings = useCallback(
    (restored: ReadonlyArray<EditorBlock>) => {
      const todoIdByBlock = new Map<string, string>();
      for (const block of restored) {
        if (block.type !== 'todo') {
          continue;
        }
        const todoId = block.payload.todoId;
        if (typeof todoId === 'string' && todoId) {
          todoIdByBlock.set(block.id, todoId);
        }
      }
      if (todoIdByBlock.size === 0) {
        return;
      }
      for (const stack of [undoStackRef.current, redoStackRef.current]) {
        for (const entry of stack) {
          entry.blocks = entry.blocks.map((block) => {
            if (block.type !== 'todo') {
              return block;
            }
            const todoId = todoIdByBlock.get(block.id);
            if (!todoId || block.payload.todoId === todoId) {
              return block;
            }
            return {
              ...block,
              payload: { ...block.payload, todoId },
            };
          });
        }
      }
    },
    [],
  );

  /** 用历史快照替换当前文档；不记入历史，但仍走原有防抖保存。 */
  const restoreHistoryEntry = useCallback(
    async (
      entry: BlockHistoryEntry,
      direction: EditorHistoryAction['action'],
    ) => {
      const targetNoteId = noteIdRef.current;
      // 跨笔记批量移动：先恢复目标笔记，失败时源笔记保持不变。
      for (const sideEffect of entry.sideEffects ?? []) {
        if (sideEffect.noteId === targetNoteId) {
          continue;
        }
        const targetBlocks = await repository.list(sideEffect.noteId);
        if (direction === 'undo') {
          const removeIds = new Set(sideEffect.appliedIds);
          const nextTarget = ensureTrailingParagraph(
            targetBlocks.filter((block) => !removeIds.has(block.id)),
            sideEffect.noteId,
          );
          await repository.saveDocument(
            sideEffect.noteId,
            nextTarget.map(toBlockDraft),
          );
          sideEffect.appliedIds = [];
        } else {
          const now = new Date().toISOString();
          const clones = cloneHistoryBlocks(sideEffect.blocks).map(
            (block, index) => ({
              ...block,
              id: newBlockId(),
              noteId: sideEffect.noteId,
              orderKey: (targetBlocks.length + index + 1) * 1024,
              payload: JSON.parse(
                JSON.stringify(block.payload),
              ) as EditorBlock['payload'],
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
              version: 0,
            }),
          );
          sideEffect.appliedIds = clones.map((block) => block.id);
          const nextTarget = ensureTrailingParagraph(
            [...targetBlocks, ...clones],
            sideEffect.noteId,
          );
          await repository.saveDocument(
            sideEffect.noteId,
            nextTarget.map(toBlockDraft),
          );
        }
        if (!mountedRef.current || noteIdRef.current !== targetNoteId) {
          return;
        }
      }

      let restored = mergeTodoBindings(cloneHistoryBlocks(entry.blocks));
      // 待办工作台适配层可在这里解除删除抑制并恢复 note_todos 关联；
      // 普通仓储没有该方法时直接使用快照。
      const capable = repository as BlockRepository & {
        prepareHistoryRestore?: (
          blocks: ReadonlyArray<EditorBlock>,
        ) => Promise<EditorBlock[]>;
      };
      if (capable.prepareHistoryRestore) {
        restored = await capable.prepareHistoryRestore(restored);
        remapHistoryTodoBindings(restored);
      }
      if (!mountedRef.current || noteIdRef.current !== targetNoteId) {
        return;
      }
      const currentIds = new Set(
        blocksRef.current.map((block) => block.id),
      );
      const remapped = remapRestoredBlockIds(restored, currentIds);
      restored = remapped.blocks;
      const mappedActiveId = entry.activeBlockId
        ? (remapped.idMap.get(entry.activeBlockId) ?? entry.activeBlockId)
        : null;
      const mappedCaret = entry.caret
        ? {
            ...entry.caret,
            blockId:
              remapped.idMap.get(entry.caret.blockId) ??
              entry.caret.blockId,
          }
        : null;

      blocksRef.current = restored;
      setBlocks(restored);
      setMenu(null);
      setSelection(null);
      selectionRef.current = null;
      applyBlockSelection(null);
      setMoveDialogOpen(false);
      setLinkDialogOpen(false);
      setQuoteDialogBlockId(null);
      setActiveBlockId(
        mappedActiveId &&
          restored.some((block) => block.id === mappedActiveId)
          ? mappedActiveId
          : (restored[0]?.id ?? null),
      );
      scheduleSaveRef.current();

      const caret =
        mappedCaret &&
        restored.some((block) => block.id === mappedCaret.blockId)
          ? mappedCaret
          : null;
      if (caret) {
        focusBlock(caret.blockId, caret.start, caret.end);
        return;
      }
      const fallback =
        mappedActiveId &&
        restored.some((block) => block.id === mappedActiveId)
          ? mappedActiveId
          : (restored[0]?.id ?? null);
      if (fallback) {
        focusBlock(fallback);
      }
    },
    [
      applyBlockSelection,
      focusBlock,
      mergeTodoBindings,
      remapHistoryTodoBindings,
      repository,
    ],
  );

  const applyHistory = useCallback(
    (action: EditorHistoryAction['action']): Promise<void> => {
      // 连续按 ⌘Z 时排队执行，不能因为上一次恢复尚未落库就吞掉后续步骤。
      const run = historyQueueRef.current.then(async () => {
        if (!historyEnabledRef.current) {
          return;
        }
        const fromStack =
          action === 'undo' ? undoStackRef : redoStackRef;
        if (fromStack.current.length === 0) {
          return;
        }
        const entry = fromStack.current[fromStack.current.length - 1];
        const currentEntry: BlockHistoryEntry = {
          blocks: cloneHistoryBlocks(blocksRef.current),
          activeBlockId: activeBlockIdRef.current,
          caret: readCaret(),
          // 目标笔记的副作用对象共享：重做时用新 id 追加并刷新 appliedIds。
          ...(entry.sideEffects
            ? { sideEffects: entry.sideEffects }
            : {}),
        };
        // 先完成栈的移动，按钮状态立即反映；恢复快照失败时再回滚。
        fromStack.current = fromStack.current.slice(0, -1);
        const toStack = action === 'undo' ? redoStackRef : undoStackRef;
        toStack.current = pushHistoryEntry(toStack.current, currentEntry);
        lastMergeRef.current = null;
        syncHistoryAvailability();

        const targetNoteId = noteIdRef.current;
        try {
          await restoreHistoryEntry(entry, action);
          // 恢复期间切换了笔记则丢弃这次撤销。
          if (!mountedRef.current) {
            return;
          }
        } catch (reason) {
          if (
            mountedRef.current &&
            noteIdRef.current === targetNoteId
          ) {
            toStack.current = toStack.current.slice(0, -1);
            fromStack.current = pushHistoryEntry(fromStack.current, entry);
            syncHistoryAvailability();
          }
          const message = formatError(reason);
          setSaveState('error');
          setError(message);
          onErrorRef.current?.(
            reason instanceof Error ? reason : new Error(message),
          );
        }
      });
      historyQueueRef.current = run.catch(() => undefined);
      return run;
    },
    [readCaret, restoreHistoryEntry, syncHistoryAvailability],
  );

  const handleHistoryKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (readOnly) {
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      const isUndo = key === 'z' && !event.shiftKey;
      const isRedo = (key === 'z' && event.shiftKey) || key === 'y';
      if (!isUndo && !isRedo) {
        return;
      }
      // 弹层里的输入框保留原生撤销，避免影响对话框文案。
      const target = event.target as Element | null;
      if (target?.closest?.('.zxe-dialog, .zxe-menu')) {
        return;
      }
      // 无论历史是否为空都拦下原生 undo，防止 DOM 与块模型双回退。
      event.preventDefault();
      event.stopPropagation();
      void applyHistory(isUndo ? 'undo' : 'redo');
    },
    [applyHistory, readOnly],
  );

  // 知识页等上层通过递增 token 触发撤销/重做。
  useEffect(() => {
    if (!historyAction) {
      return;
    }
    if (historyAction.token === handledHistoryTokenRef.current) {
      return;
    }
    handledHistoryTokenRef.current = historyAction.token;
    void applyHistory(historyAction.action);
  }, [applyHistory, historyAction]);

  // 上层按钮需要与实际历史/只读/保存失败状态同步。
  useEffect(() => {
    const available = !readOnly && saveState !== 'error';
    onHistoryChangeRef.current?.({
      canUndo: available && canUndo,
      canRedo: available && canRedo,
    });
  }, [canRedo, canUndo, readOnly, saveState]);

  const handleSelectionChange = useCallback(
    (
      blockId: string,
      info: (InlineSelection & { rect: SelectionRect }) | null,
    ) => {
      if (info) {
        const next: EditorSelection = { ...info, blockId };
        selectionRef.current = next;
        setSelection(next);
      } else {
        selectionRef.current = null;
        setSelection(null);
      }
    },
    [],
  );

  // 文档级 selectionchange：鼠标/键盘选择后更新浮条。
  useEffect(() => {
    if (readOnly || typeof document === 'undefined') {
      return;
    }
    const handler = () => {
      const domSelection = window.getSelection();
      if (
        !domSelection ||
        domSelection.rangeCount === 0 ||
        domSelection.isCollapsed
      ) {
        // 文字选区被方向键/点击折叠后，⌘A 重新从「当前块」开始。
        if (!blockSelectionRef.current) {
        }
        // 点击格式条时浏览器可能先把焦点移出正文并折叠选区；这里不立刻
        // 卸载浮条，由 pointerdown/输入事件决定何时收起。
        return;
      }
      const range = domSelection.getRangeAt(0);
      const body = bodyRef.current;
      if (!body || !body.contains(range.commonAncestorContainer)) {
        selectionRef.current = null;
        setSelection(null);
        return;
      }
      const element =
        range.startContainer.nodeType === 1
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      const row = element?.closest?.('[data-block-id]');
      const inline = row?.querySelector<HTMLElement>(
        '[data-inline-editor="true"]',
      );
      if (!row || !inline) {
        selectionRef.current = null;
        setSelection(null);
        return;
      }
      const offsets = (() => {
        try {
          return window.getSelection()?.rangeCount
            ? selectionOffsetsIn(inline)
            : null;
        } catch {
          return null;
        }
      })();
      if (!offsets || offsets.start === offsets.end) {
        selectionRef.current = null;
        setSelection(null);
        return;
      }
      const info = {
        blockId: row.getAttribute('data-block-id') ?? '',
        ...offsets,
        rect: selectionRect(),
      };
      selectionRef.current = info;
      setSelection(info);
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [readOnly]);

  // 点击浮条/面板之外的区域才收起格式条，避免 pointerdown 先折叠选区导致
  // 按钮在 click 前被卸载。
  useEffect(() => {
    if (readOnly || typeof document === 'undefined') {
      return;
    }
    const handler = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest('.zxe-formatbar') ||
          target.closest('.zxe-stylepanel') ||
          target.closest('.zxe-dialog-backdrop') ||
          target.closest('.zxe-menu') ||
          target.closest('.kn-context-menu'))
      ) {
        return;
      }
      selectionRef.current = null;
      setSelection(null);
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [readOnly]);

  // 计算属性 --------------------------------------------------------------
  const activeBlock = useMemo(
    () => blocks.find((block) => block.id === activeBlockId) ?? blocks[0] ?? null,
    [activeBlockId, blocks],
  );

  const activeMarks = useMemo<ActiveInlineMarks>(() => {
    if (!selection) {
      return emptyActiveMarks();
    }
    const block = blocks.find((item) => item.id === selection.blockId);
    if (!block) {
      return emptyActiveMarks();
    }
    const runs = blockRuns(block);
    return {
      bold: rangeHasMark(runs, selection.start, selection.end, 'bold'),
      italic: rangeHasMark(runs, selection.start, selection.end, 'italic'),
      underline: rangeHasMark(
        runs,
        selection.start,
        selection.end,
        'underline',
      ),
      strike: rangeHasMark(runs, selection.start, selection.end, 'strike'),
      code: rangeHasMark(runs, selection.start, selection.end, 'code'),
    };
  }, [blocks, selection]);

  const panelBlockId =
    selection?.blockId ?? activeBlockId ?? blocks[0]?.id ?? null;
  const panelBlock =
    blocks.find((block) => block.id === panelBlockId) ?? activeBlock;

  // 命令栏的「Aa 当前块类型」只跟随类型变化，不把整块传回上层。
  useEffect(() => {
    onActiveBlockChangeRef.current?.(
      panelBlock
        ? { id: panelBlock.id, type: panelBlock.type as KnownBlockType }
        : null,
    );
  }, [panelBlock?.id, panelBlock?.type]);

  const saveLabel = saveLabelOf(saveState);
  /** 只读与保存失败时不可撤销；历史本身保留，恢复保存后继续可用。 */
  const historyAvailable = !readOnly && saveState !== 'error';

  // 行内格式 --------------------------------------------------------------
  const applyInlineFormat = useCallback(
    (patch: Partial<InlineMarks>) => {
      const currentSelection = selectionRef.current;
      const blockId = currentSelection?.blockId ?? activeBlockId;
      if (!blockId) {
        return;
      }
      const block = blocksRef.current.find((item) => item.id === blockId);
      if (!block || !canContainText(block.type)) {
        return;
      }
      const runs = blockRuns(block);
      const inside =
        currentSelection && currentSelection.blockId === blockId
          ? currentSelection
          : null;
      const start = inside ? inside.start : 0;
      const end = inside ? inside.end : runsToPlainText(runs).length;
      if (start === end) {
        return;
      }
      const nextRuns = toggleMarksInRange(runs, start, end, patch);
      updateBlock(blockId, (item) => withRuns(item, nextRuns));
      setPendingFocus({ blockId, start, end });
    },
    [activeBlockId, updateBlock],
  );

  const clearInlineFormat = useCallback(() => {
    const currentSelection = selectionRef.current;
    const blockId = currentSelection?.blockId ?? activeBlockId;
    if (!blockId) {
      return;
    }
    const block = blocksRef.current.find((item) => item.id === blockId);
    if (!block || !canContainText(block.type)) {
      return;
    }
    const runs = blockRuns(block);
    const inside =
      currentSelection && currentSelection.blockId === blockId
        ? currentSelection
        : null;
    const start = inside ? inside.start : 0;
    const end = inside ? inside.end : runsToPlainText(runs).length;
    if (start === end) {
      return;
    }
    updateBlock(blockId, (item) => {
      const cleared = clearMarksInRange(blockRuns(item), start, end);
      let next = withRuns(item, cleared);
      if (!currentSelection) {
        next = withAlign(withIndent(next, 0), undefined);
      }
      return next;
    });
    setPendingFocus({ blockId, start, end });
  }, [activeBlockId, updateBlock]);

  const applyLink = useCallback(
    (url: string) => {
      applyInlineFormat({ link: url });
      setLinkDialogOpen(false);
    },
    [applyInlineFormat],
  );

  /**
   * 出处弹层保存：一次写入三个字段，不改正文 runs，也不触碰其他块。
   * 空字符串会覆盖旧值，确保「清除」真的清空 payload。
   */
  const applyQuoteMeta = useCallback(
    (meta: QuoteMeta) => {
      if (!quoteDialogBlockId) {
        return;
      }
      updateBlock(quoteDialogBlockId, (block) =>
        withPayload(block, {
          source: meta.source,
          noteId: meta.noteId,
          sourceUrl: meta.sourceUrl,
        }),
      );
      setQuoteDialogBlockId(null);
    },
    [quoteDialogBlockId, updateBlock],
  );

  // 块操作 ----------------------------------------------------------------
  const insertBlockOfType = useCallback(
    (targetId: string, type: KnownBlockType) => {
      applyBlockSelection(null);
      if (type === 'file') {
        pendingFileTargetRef.current = { blockId: targetId, mode: 'insert' };
        updatePanelOpen(false);
        fileInputRef.current?.click();
        return;
      }

      const current = blocksRef.current;
      const index = current.findIndex((block) => block.id === targetId);
      const target = index >= 0 ? current[index] : current[current.length - 1];
      let next: EditorBlock[];
      let focusId: string;

      if (!target) {
        const created = createBlock(type, noteId);
        next = [created];
        focusId = created.id;
        if (!canContainText(type)) {
          const paragraph = createBlock('paragraph', noteId);
          next.push(paragraph);
          focusId = type === 'divider' ? paragraph.id : created.id;
        }
      } else if (
        target.type === 'paragraph' &&
        isBlockEmpty(target) &&
        canContainText(type)
      ) {
        const converted = convertBlockType(target, type);
        next = [...current];
        next[index] = converted;
        focusId = converted.id;
      } else if (target.type === 'paragraph' && isBlockEmpty(target)) {
        const converted = convertBlockType(target, type);
        const paragraph = createBlock('paragraph', noteId);
        next = [...current];
        next[index] = converted;
        next.splice(index + 1, 0, paragraph);
        focusId =
          type === 'divider' || type === 'board' ? paragraph.id : converted.id;
      } else {
        const created = createBlock(type, noteId);
        next = [...current];
        next.splice(index + 1, 0, created);
        focusId = created.id;
        if (!canContainText(type)) {
          const paragraph = createBlock('paragraph', noteId);
          next.splice(index + 2, 0, paragraph);
          if (type === 'divider' || type === 'board') {
            focusId = paragraph.id;
          }
        }
      }

      commitBlocks(ensureTrailingParagraph(next, noteId));
      focusBlock(focusId);
    },
    [
      applyBlockSelection,
      commitBlocks,
      focusBlock,
      noteId,
      updatePanelOpen,
    ],
  );

  const commandTargetId = useCallback(
    () =>
      selectionRef.current?.blockId ??
      activeBlockId ??
      blocksRef.current[blocksRef.current.length - 1]?.id ??
      null,
    [activeBlockId],
  );

  const insertFromCommand = useCallback(
    (type: KnownBlockType) => {
      if (readOnly) {
        return;
      }
      const targetId = commandTargetId();
      if (targetId) {
        insertBlockOfType(targetId, type);
      }
    },
    [commandTargetId, insertBlockOfType, readOnly],
  );

  /**
   * 命令栏「链接」：有非折叠选区时给选中文字加链接；
   * 无选区时插入链接块，由 LinkBlock 的空块自动编辑弹层继续。
   */
  const openLinkFromCommand = useCallback(() => {
    if (readOnly) {
      return;
    }
    const targetId = commandTargetId();
    if (!targetId) {
      return;
    }
    if (selectionRef.current) {
      setLinkDialogOpen(true);
      return;
    }
    insertBlockOfType(targetId, 'link');
  }, [commandTargetId, insertBlockOfType, readOnly]);

  useImperativeHandle(
    commandRef,
    () => ({
      insertBlock: insertFromCommand,
      openLink: openLinkFromCommand,
      focusEditor: () => {
        bodyRef.current?.focus({ preventScroll: true });
      },
    }),
    [insertFromCommand, openLinkFromCommand],
  );

  const handleMenuSelect = useCallback(
    (type: KnownBlockType) => {
      if (!menu) {
        return;
      }
      insertBlockOfType(menu.blockId, type);
    },
    [insertBlockOfType, menu],
  );

  const handleConvert = useCallback(
    (type: KnownBlockType, blockId?: string) => {
      applyBlockSelection(null);
      const targetId =
        blockId ?? selectionRef.current?.blockId ?? activeBlockId;
      if (!targetId) {
        return;
      }
      const target = blocksRef.current.find((block) => block.id === targetId);
      if (!target || target.type === type) {
        return;
      }
      if (type === 'file') {
        pendingFileTargetRef.current = { blockId: targetId, mode: 'insert' };
        fileInputRef.current?.click();
        return;
      }
      const converted = convertBlockType(target, type);
      const next = blocksRef.current.map((block) =>
        block.id === targetId ? converted : block,
      );
      commitBlocks(ensureTrailingParagraph(next, noteId));
      focusBlock(converted.id);
    },
    [
      activeBlockId,
      applyBlockSelection,
      commitBlocks,
      focusBlock,
      noteId,
    ],
  );

  const handleAlign = useCallback(
    (align: TextAlign | undefined) => {
      const targetId = selectionRef.current?.blockId ?? activeBlockId;
      if (!targetId) {
        return;
      }
      updateBlock(targetId, (block) => withAlign(block, align));
    },
    [activeBlockId, updateBlock],
  );

  const handleIndent = useCallback(
    (delta: number) => {
      const targetId = selectionRef.current?.blockId ?? activeBlockId;
      if (!targetId) {
        return;
      }
      updateBlock(targetId, (block) =>
        withIndent(block, blockIndent(block) + delta),
      );
    },
    [activeBlockId, updateBlock],
  );

  const handleDeleteBlock = useCallback(
    (blockId: string) => {
      applyBlockSelection(null);
      if (blocksRef.current.length <= 1) {
        return;
      }
      const current = blocksRef.current;
      const index = current.findIndex((block) => block.id === blockId);
      const next = removeBlockById(current, blockId, noteId);
      commitBlocks(next);
      const neighbour =
        next[Math.min(index, next.length - 1)] ?? next[0] ?? null;
      if (neighbour) {
        focusBlock(neighbour.id);
      }
    },
    [applyBlockSelection, commitBlocks, focusBlock, noteId],
  );

  const handleMoveBlock = useCallback(
    (blockId: string, delta: number) => {
      applyBlockSelection(null);
      commitBlocks(moveBlock(blocksRef.current, blockId, delta));
      focusBlock(blockId);
    },
    [applyBlockSelection, commitBlocks, focusBlock],
  );

  const handleToggleTodo = useCallback(
    (blockId: string) => {
      updateBlock(blockId, (block) => ({
        ...block,
        payload: { ...block.payload, checked: block.payload.checked !== true },
      }));
    },
    [updateBlock],
  );

  const handlePayload = useCallback(
    (blockId: string, patch: Record<string, JsonValue>, mergeKey?: string) => {
      const key = mergeKey ?? continuousHistoryKey(blockId, patch);
      updateBlock(
        blockId,
        (block) => withPayload(block, patch),
        key ? { mergeKey: key } : undefined,
      );
    },
    [updateBlock],
  );

  const handleInputRuns = useCallback(
    (blockId: string, runs: Parameters<typeof withRuns>[1]) => {
      updateBlock(
        blockId,
        (block) => withRuns(block, normalizeInlineRuns(runs)),
        { mergeKey: `text:${blockId}` },
      );
    },
    [updateBlock],
  );

  const handleEnter = useCallback(
    (blockId: string, before: Parameters<typeof withRuns>[1], after: Parameters<typeof withRuns>[1]) => {
      applyBlockSelection(null);
      const result = splitBlock(
        blocksRef.current,
        blockId,
        before,
        after,
        noteId,
      );
      commitBlocks(result.blocks);
      focusBlock(result.newBlockId, 0, 0);
    },
    [applyBlockSelection, commitBlocks, focusBlock, noteId],
  );

  /**
   * 块首 Backspace（ZX6-BACKSPACE-01）。
   *
   * 规则按“内容优先”收敛为三条，且一次按键只产生一步历史：
   * 1. 前块可容纳文本 → 合并进前块，保留前块类型与 payload；
   * 2. 前块是表格/公式/代码/文件/画板等不可合并对象 → 不删除，选中该原子块
   *    并提示“按 Delete 删除”，当前块保持不动；
   * 3. 会丢元数据的当前块（已完成待办、带出处引用）拒绝合并并提示，
   *    交给块菜单处理，绝不静默丢弃 checked / 来源。
   *
   * 列表、空待办、空引用先降级为段落，再按一次 Backspace 才走 1/2，
   * 与原型 `zx-editor-interactions-v6.html#backspace` 一致。
   */
  const handleBackspaceAtStart = useCallback(
    (blockId: string) => {
      if (readOnly) {
        return;
      }
      // 文档级块选择由 document keydown 统一删除；这里直接返回，避免
      // 选中多块时又对当前块做一次合并，导致删除范围与历史错位。
      if (blockSelectionRef.current?.ids.length) {
        return;
      }
      const current = blocksRef.current;
      const index = current.findIndex((item) => item.id === blockId);
      const block = index >= 0 ? current[index] : null;
      if (!block) {
        return;
      }
      if (index === 0) {
        showSelectionNotice('第一个块前没有可合并的内容');
        return;
      }
      const previous = current[index - 1]!;
      applyBlockSelection(null);

      // 元数据保护必须排在合并之前：合并只保留前块 payload，当前块的
      // checked / 引用出处会被静默丢掉。
      if (block.type === 'todo' && blockChecked(block)) {
        showSelectionNotice(
          '已完成待办不参与合并，避免丢失完成状态；可用块菜单删除',
        );
        return;
      }
      if (block.type === 'quote' && blockQuoteHasMeta(block)) {
        showSelectionNotice(
          '引用含出处，不合并也不删除，避免丢失来源；可用块菜单删除',
        );
        return;
      }

      // 列表先退格成段落（保留正文），第二次 Backspace 再合并/删除前块。
      if (block.type === 'bullet_list' || block.type === 'ordered_list') {
        const converted = convertBlockType(block, 'paragraph');
        commitBlocks(
          current.map((item) => (item.id === blockId ? converted : item)),
        );
        focusBlock(converted.id, 0, 0);
        showSelectionNotice('列表已转为文本，再按一次 Backspace 可合并到上一块');
        return;
      }

      // 空待办 / 空引用先转为段落；带出处的引用已在上方保护。
      if (
        (block.type === 'todo' || block.type === 'quote') &&
        isBlockEmpty(block)
      ) {
        const converted = convertBlockType(block, 'paragraph');
        commitBlocks(
          current.map((item) => (item.id === blockId ? converted : item)),
        );
        focusBlock(converted.id, 0, 0);
        showSelectionNotice('空块已转为文本，再按一次 Backspace 可合并到上一块');
        return;
      }

      // 当前是空块、前块又是不可合并的原子对象：删除空块本身，选中前一个
      // 原子块。这里不删除原子块，避免“只想删空行却丢了表格/公式”。
      // 不补尾段落：选中态下原子块可以临时位于文档末尾，下一次编辑或
      // 重新载入会由 ensureTrailingParagraph 补回。
      if (!canContainText(previous.type) && isBlockEmpty(block)) {
        const next = current.filter((item) => item.id !== blockId);
        commitBlocks(next);
        applyBlockSelection(
          createBlockSelection(next, previous.id, previous.id),
          'block',
        );
        backspaceSelectionGuardRef.current = true;
        focusBlock(previous.id);
        showSelectionNotice(
          `已删除空块；前一个是${blockLabel(previous.type)}原子块，已选中 · 可用块菜单删除`,
        );
        return;
      }

      // 前块可容纳文本：合并，caret 落在两段交界处。
      if (canContainText(previous.type)) {
        const merged = mergeBlockBackward(current, blockId);
        if (merged) {
          commitBlocks(merged.blocks);
          focusBlock(merged.focusBlockId, merged.caret, merged.caret);
          showSelectionNotice('已合并到上一块 · 可 ⌘/Ctrl+Z 撤销');
        }
        return;
      }

      // 前块是原子对象，无法合并：不删除，改为选中该原子块并提示。
      // 与已确认原型 `zx-editor-interactions-v6.html#backspace` 一致——
      // 一次 Backspace 不改变块结构、不写历史；用户可用 Delete 或块菜单
      // 明确删除，避免“只想把光标退到上一块却误删整张表格/公式”。
      applyBlockSelection(
        createBlockSelection(current, previous.id, previous.id),
        'block',
      );
      backspaceSelectionGuardRef.current = true;
      focusBlockRow(previous.id);
      showSelectionNotice(
        `前一个是${blockLabel(previous.type)}原子块，无法合并；已选中原子块，按 Delete 删除`,
      );
    },
    [
      applyBlockSelection,
      commitBlocks,
      focusBlock,
      focusBlockRow,
      readOnly,
      showSelectionNotice,
    ],
  );

  const handlePaste = useCallback(
    (blockId: string, payload: InlinePastePayload) => {
      applyBlockSelection(null);
      const current = blocksRef.current;
      const index = current.findIndex((block) => block.id === blockId);
      const target = index >= 0 ? current[index] : null;
      if (!target || !canContainText(target.type)) {
        return;
      }
      const runs = blockRuns(target);

      const insertPlain = () => {
        // 粘贴纯文本内链时自动识别为链接（N-16）：只认规范形态，
        // 文本原样保留，href 再经过一次 id 校验。
        const trimmed = payload.text.trim();
        const internalId = internalNoteIdFromUrl(trimmed);
        const internalUrl = internalId ? internalNoteUrl(internalId) : null;
        const inserted = internalUrl
          ? [{ text: trimmed, marks: { link: internalUrl } }]
          : pastedTextRuns(payload.text);
        if (inserted.length === 0) {
          return;
        }
        const nextRuns = replaceRangeWithRuns(
          runs,
          payload.offsets.start,
          payload.offsets.end,
          inserted,
        );
        updateBlock(target.id, (block) => withRuns(block, nextRuns));
        const caret = payload.offsets.start + runsToPlainText(inserted).length;
        focusBlock(target.id, caret, caret);
      };

      if (payload.html.trim()) {
        const pasted = pastedBlocksFromHtml(payload.html);
        if (pasted.length === 0) {
          insertPlain();
          return;
        }
        if (pasted.length === 1 && canContainText(pasted[0].type)) {
          const inserted = normalizeInlineRuns(pasted[0].payload.runs);
          if (inserted.length === 0) {
            return;
          }
          const nextRuns = replaceRangeWithRuns(
            runs,
            payload.offsets.start,
            payload.offsets.end,
            inserted,
          );
          updateBlock(target.id, (block) => withRuns(block, nextRuns));
          const caret = payload.offsets.start + runsToPlainText(inserted).length;
          focusBlock(target.id, caret, caret);
          return;
        }

        const [before] = splitRunsAt(runs, payload.offsets.start);
        const [, after] = splitRunsAt(runs, payload.offsets.end);
        const next = [...current];
        const insertedBlocks: EditorBlock[] = pasted.map((item) => {
          const created = createBlock(item.type, noteId);
          created.payload = item.payload;
          return created;
        });
        if (runsToPlainText(after).length > 0) {
          insertedBlocks.push(withRuns(createBlock('paragraph', noteId), after));
        }
        if (isBlockEmpty(target)) {
          // 空段落直接由粘贴内容替换，避免正文前面多出一行空行。
          next.splice(index, 1, ...insertedBlocks);
        } else {
          next[index] = withRuns(target, before);
          next.splice(index + 1, 0, ...insertedBlocks);
        }
        commitBlocks(ensureTrailingParagraph(next, noteId));
        if (insertedBlocks[0]) {
          focusBlock(insertedBlocks[0].id);
        }
        return;
      }

      insertPlain();
    },
    [applyBlockSelection, commitBlocks, focusBlock, noteId, updateBlock],
  );

  const handleSlash = useCallback((blockId: string, rect: SelectionRect) => {
    setMenu({
      blockId,
      x: Math.max(8, rect.left),
      y: Math.max(8, rect.top + rect.height),
    });
  }, []);

  const handleFileSelection = useCallback(
    (fileList: FileList | null) => {
      const pending = pendingFileTargetRef.current;
      pendingFileTargetRef.current = null;
      if (!fileList || fileList.length === 0 || !pending) {
        return;
      }
      if (fileIngestingRef.current) {
        setFileIngestError('正在保存上一批文件，请稍候再试');
        return;
      }
      const files = Array.from(fileList).slice(0, 20);
      const manager = attachmentManager;
      if (!manager) {
        const reason =
          attachmentUnavailableReason ??
          '附件服务不可用，无法把文件保存到本机';
        setFileIngestError(reason);
        onErrorRef.current?.(new Error(reason));
        return;
      }

      const targetNoteId = noteId;
      fileIngestingRef.current = true;
      setFileIngesting(true);
      setFileIngestError(null);

      void (async () => {
        try {
          const succeeded: Array<{
            block: EditorBlock;
            attachment: StoredAttachment;
          }> = [];
          const failures: string[] = [];

          for (const file of files) {
            const block = createBlock('file', targetNoteId);
            try {
              const result = await manager.ingest(file, {
                noteId: targetNoteId,
                blockId: block.id,
              });
              block.payload = attachmentFilePayload(
                result.attachment,
              ) as EditorBlock['payload'];
              succeeded.push({ block, attachment: result.attachment });
            } catch (reason) {
              failures.push(`${file.name}：${formatError(reason)}`);
            }
          }

          if (!mountedRef.current || noteIdRef.current !== targetNoteId) {
            return;
          }

          if (succeeded.length > 0) {
            const current = blocksRef.current;
            const index = current.findIndex(
              (block) => block.id === pending.blockId,
            );
            let next: EditorBlock[];
            let focusId: string;

            if (
              pending.mode === 'replace' &&
              index >= 0 &&
              current[index]?.type === 'file'
            ) {
              // 重新选择：沿用原块 id，只替换附件引用，不产生第二张卡。
              const target = current[index]!;
              const [first, ...rest] = succeeded;
              const replaced: EditorBlock = {
                ...target,
                payload: { ...first!.block.payload },
                updatedAt: new Date().toISOString(),
                version: target.version + 1,
              };
              next = [
                ...current.slice(0, index),
                replaced,
                ...rest.map((item) => item.block),
                ...current.slice(index + 1),
              ];
              focusId = replaced.id;
            } else {
              const replaceTarget =
                index >= 0 &&
                current[index]?.type === 'paragraph' &&
                isBlockEmpty(current[index]!);
              next = [
                ...current.slice(0, replaceTarget ? index : index + 1),
                ...succeeded.map((item) => item.block),
                ...current.slice(index + 1),
              ];
              focusId = succeeded[0]!.block.id;
            }

            commitBlocks(ensureTrailingParagraph(next, targetNoteId));
            setFileLocalToken((current) => current + 1);
            onAttachmentIngestedRef.current?.(
              succeeded.map((item) => item.attachment),
            );
            focusBlock(focusId);
          }

          if (failures.length > 0) {
            const message = `${failures.length} 个文件未能插入：${failures.join('；')}`;
            setFileIngestError(message);
            onErrorRef.current?.(new Error(message));
          }
        } catch (reason) {
          if (mountedRef.current) {
            const message = `插入文件失败：${formatError(reason)}`;
            setFileIngestError(message);
            onErrorRef.current?.(new Error(message));
          }
        } finally {
          fileIngestingRef.current = false;
          if (mountedRef.current) {
            setFileIngesting(false);
          }
        }
      })();
    },
    [
      attachmentManager,
      attachmentUnavailableReason,
      commitBlocks,
      focusBlock,
      noteId,
    ],
  );

  /**
   * 笔记内嵌画板「导出 PNG → 插入到笔记」：图片写入同一个附件库，
   * 正文末尾追加文件卡。只读画板文档，不修改画板节点/连线。
   */
  const handleBoardExportInsert = useCallback(
    async (file: BoardImageFile) => {
      const manager = attachmentManager;
      if (!manager) {
        const reason =
          attachmentUnavailableReason ??
          '附件服务不可用，无法把导出的 PNG 保存到本机';
        setFileIngestError(reason);
        onErrorRef.current?.(new Error(reason));
        throw new Error(reason);
      }
      const created = await createBoardImageBlock({
        noteId,
        file,
        attachmentManager: manager,
      });
      if (!mountedRef.current || noteIdRef.current !== noteId) {
        return;
      }
      const next = ensureTrailingParagraph(
        [...blocksRef.current, created.block],
        noteId,
      );
      commitBlocks(next);
      setFileLocalToken((current) => current + 1);
      onAttachmentIngestedRef.current?.([created.attachment]);
      focusBlock(created.block.id);
      showSelectionNotice('已插入画板导出图片；点击文件卡可预览 PNG');
    },
    [
      attachmentManager,
      attachmentUnavailableReason,
      commitBlocks,
      focusBlock,
      noteId,
      showSelectionNotice,
    ],
  );

  const handleFileOpen = useCallback(
    async (blockId: string) => {
      const block = blocksRef.current.find((item) => item.id === blockId);
      const file = block ? blockFile(block) : null;
      if (!file?.attachmentId) {
        throw new Error('这条文件卡还没有关联附件，请重新选择文件');
      }
      if (!attachmentManager) {
        throw new Error(
          attachmentUnavailableReason ??
            '附件服务不可用，无法读取本机文件',
        );
      }
      const opened = await openAttachmentLocally(
        attachmentManager,
        file.attachmentId,
      ).catch((reason) => {
        setFileLocalToken((current) => current + 1);
        throw reason;
      });
      if (opened.kind === 'image') {
        const url = objectUrlFor(opened.blob);
        if (!url) {
          throw new Error('当前环境无法生成图片预览地址');
        }
        setFilePreview({ fileName: opened.metadata.fileName, url });
        return;
      }
      showSelectionNotice(
        opened.path
          ? `已用系统默认应用打开「${opened.metadata.fileName}」（缓存：${opened.path}）`
          : `已用系统默认应用打开「${opened.metadata.fileName}」`,
      );
    },
    [attachmentManager, attachmentUnavailableReason, showSelectionNotice],
  );

  const handleFileDownload = useCallback(
    async (blockId: string) => {
      const block = blocksRef.current.find((item) => item.id === blockId);
      const file = block ? blockFile(block) : null;
      if (!file?.attachmentId) {
        throw new Error('这条文件卡还没有关联附件，请重新选择文件');
      }
      if (!attachmentManager) {
        throw new Error(
          attachmentUnavailableReason ??
            '附件服务不可用，无法读取本机文件',
        );
      }
      const { result, metadata } = await saveLocalAttachment(
        attachmentManager,
        file.attachmentId,
      ).catch((reason) => {
        setFileLocalToken((current) => current + 1);
        throw reason;
      });
      showSelectionNotice(describeSaveResult(result, metadata.fileName));
    },
    [
      attachmentManager,
      attachmentUnavailableReason,
      showSelectionNotice,
    ],
  );

  const handleFileRemoteDownload = useCallback(
    async (blockId: string) => {
      const block = blocksRef.current.find((item) => item.id === blockId);
      const file = block ? blockFile(block) : null;
      if (!file?.attachmentId) {
        throw new Error('这条文件卡还没有关联附件，请重新选择文件');
      }
      if (!attachmentUploader) {
        throw new Error('尚未配对后台，无法从服务器下载');
      }
      await attachmentUploader.download(file.attachmentId).catch((reason) => {
        setFileLocalToken((current) => current + 1);
        throw reason;
      });
      setFileLocalToken((current) => current + 1);
    },
    [attachmentUploader],
  );

  const handleFileReselect = useCallback((blockId: string) => {
    pendingFileTargetRef.current = { blockId, mode: 'replace' };
    fileInputRef.current?.click();
  }, []);

  /**
   * 删除文件卡只移除正文引用；附件元数据与 Blob 保留在附件面板。
   * 因此不可能误删仍被其他笔记引用的附件，面板也仍是唯一的删除入口。
   */
  const handleFileRemove = useCallback(
    (blockId: string) => {
      const current = blocksRef.current;
      const index = current.findIndex((block) => block.id === blockId);
      if (index < 0) {
        return;
      }
      const next = removeBlockById(current, blockId, noteId);
      commitBlocks(next);
      setFileIngestError(null);
      const neighbour =
        next[Math.min(index, next.length - 1)] ?? next[0] ?? null;
      if (neighbour) {
        focusBlock(neighbour.id);
      }
    },
    [commitBlocks, focusBlock, noteId],
  );

  const handleFileCommitName = useCallback(
    (blockId: string, fileName: string) => {
      const block = blocksRef.current.find((item) => item.id === blockId);
      const attachmentId = block ? blockFile(block).attachmentId : null;
      if (!attachmentId || !attachmentManager || !fileName.trim()) {
        return;
      }
      void attachmentManager.rename(attachmentId, fileName).catch((reason) => {
        setFileLocalErrors((current) => ({
          ...current,
          [blockId]: `重命名附件失败：${formatError(reason)}`,
        }));
      });
    },
    [attachmentManager],
  );

  // 阅读 / 专注（写作跟随已并入） -----------------------------------------
  const toggleReadOnly = useCallback(() => {
    if (!readOnly) {
      void flushRef.current();
      setMenu(null);
      setSelection(null);
      selectionRef.current = null;
      applyBlockSelection(null);
      setMoveDialogOpen(false);
      updatePanelOpen(false);
      setLinkDialogOpen(false);
    }
    updateReadOnly(!readOnly);
  }, [
    applyBlockSelection,
    readOnly,
    updatePanelOpen,
    updateReadOnly,
  ]);

  // ⇧⌘R / ⇧Ctrl+R：阅读/编辑切换；回收站等强制只读由上层决定是否接受。
  useEffect(() => {
    const handleReadingShortcut = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (
        mod &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'r'
      ) {
        event.preventDefault();
        toggleReadOnly();
      }
    };
    document.addEventListener('keydown', handleReadingShortcut);
    return () =>
      document.removeEventListener('keydown', handleReadingShortcut);
  }, [toggleReadOnly]);

  const openMenu = useCallback(
    (blockId: string, rect: SelectionRect) => {
      applyBlockSelection(null);
      setSelection(null);
      selectionRef.current = null;
      setEditorMenu(null);
      editorMenuRef.current = null;
      setMenu({
        blockId,
        x: Math.max(8, rect.left),
        y: Math.max(8, rect.top),
      });
    },
    [applyBlockSelection],
  );

  // 右键菜单 --------------------------------------------------------------

  const closeEditorMenu = useCallback(
    (reason: ContextMenuCloseReason) => {
      const current = editorMenuRef.current;
      setEditorMenu(null);
      editorMenuRef.current = null;
      // Escape/执行命令后归还焦点与选区；点外部与 Tab 交给浏览器决定去向。
      if (
        current &&
        (reason === 'escape' ||
          reason === 'select' ||
          reason === 'reposition')
      ) {
        current.restoreFocus();
      }
    },
    [],
  );

  const showContextMenu = useCallback(
    (state: NonNullable<EditorContextMenuState>) => {
      setMenu(null);
      setEditorMenu(state);
      editorMenuRef.current = state;
    },
    [],
  );

  const openTextContextMenu = useCallback(
    (
      blockId: string,
      inline: HTMLElement,
      offsets: InlineSelection,
      x: number,
      y: number,
    ) => {
      const block = blocksRef.current.find((item) => item.id === blockId);
      if (!block) {
        return;
      }
      const runs = blockRuns(block);
      const selectedText = runsToPlainText(
        sliceRuns(runs, offsets.start, offsets.end),
      );
      const canDelete = blocksRef.current.length > 1;
      if (offsets.start !== offsets.end) {
        // 右键不应改变选区；同时给格式/链接动作一个确定的选区快照。
        selectionRef.current = {
          blockId,
          start: offsets.start,
          end: offsets.end,
          rect: selectionRect(),
        };
      }

      const restoreFocus = () => {
        if (!inline.isConnected) {
          bodyRef.current?.focus({ preventScroll: true });
          return;
        }
        if (readOnly) {
          // 阅读态正文不可聚焦，把焦点还给整行，同时恢复文字选区。
          inline
            .closest<HTMLElement>('[data-block-id]')
            ?.focus({ preventScroll: true });
        } else {
          inline.focus({ preventScroll: true });
        }
        restoreSelectionByOffsets(inline, offsets.start, offsets.end);
        // 聚焦会触发 InlineEditable 的 reportSelection，可能先把结构化选区
        // 清空；这里恢复 DOM 选区后同步回 ref，格式/链接动作才不会整块生效。
        if (offsets.start !== offsets.end) {
          const restored: EditorSelection = {
            blockId,
            start: offsets.start,
            end: offsets.end,
            rect: selectionRect(),
          };
          selectionRef.current = restored;
          setSelection(restored);
        }
      };

      const copyText = async () => {
        const text =
          selectedText ||
          runsToPlainText(blockRuns(block));
        const ok = await writeClipboardText(text);
        showSelectionNotice(
          ok
            ? selectedText
              ? `已复制 ${selectedText.length} 个字符`
              : '已复制当前块文字'
            : '无法写入剪贴板，请用 ⌘C / Ctrl+C 复制',
        );
      };

      const cutText = async () => {
        if (offsets.start === offsets.end) {
          showSelectionNotice('先选中要剪切的文字');
          return;
        }
        const ok = await writeClipboardText(selectedText);
        if (!ok) {
          showSelectionNotice('无法写入剪贴板，未执行剪切');
          return;
        }
        updateBlock(blockId, (item) =>
          withRuns(
            item,
            replaceRangeWithRuns(
              blockRuns(item),
              offsets.start,
              offsets.end,
              [],
            ),
          ),
        );
        focusBlock(blockId, offsets.start, offsets.start);
        showSelectionNotice(`已剪切 ${selectedText.length} 个字符`);
      };

      const pasteText = async () => {
        const text = await readClipboardText();
        if (text === null) {
          showSelectionNotice('无法读取剪贴板，请用 ⌘V / Ctrl+V 粘贴');
          return;
        }
        if (!text) {
          showSelectionNotice('剪贴板为空');
          return;
        }
        handlePaste(blockId, { html: '', text, offsets });
      };

      const selectAll = () => {
        if (readOnly) {
          const range = document.createRange();
          range.selectNodeContents(inline);
          const selectionApi = window.getSelection();
          selectionApi?.removeAllRanges();
          selectionApi?.addRange(range);
          return;
        }
        selectAllBlocksAction('document');
      };

      const items: ContextMenuItem[] = readOnly
        ? [
            {
              id: 'copy',
              labelKey: 'menu.text.copy',
              shortcut: 'Mod+C',
              disabled: !selectedText,
              hintKey: selectedText ? undefined : 'menu.hint.selectText',
              onSelect: () => {
                void copyText();
              },
            },
            {
              id: 'select-all',
              labelKey: 'menu.text.selectAll',
              shortcut: 'Mod+A',
              onSelect: selectAll,
            },
          ]
        : [
            {
              id: 'cut',
              labelKey: 'menu.text.cut',
              shortcut: 'Mod+X',
              disabled: offsets.start === offsets.end,
              hintKey:
                offsets.start === offsets.end
                  ? 'menu.hint.selectText'
                  : undefined,
              onSelect: () => {
                void cutText();
              },
            },
            {
              id: 'copy',
              labelKey: 'menu.text.copy',
              shortcut: 'Mod+C',
              disabled: !selectedText,
              hintKey: selectedText ? undefined : 'menu.hint.selectText',
              onSelect: () => {
                void copyText();
              },
            },
            {
              id: 'paste',
              labelKey: 'menu.text.paste',
              shortcut: 'Mod+V',
              onSelect: () => {
                void pasteText();
              },
            },
            {
              id: 'select-all',
              labelKey: 'menu.text.selectAll',
              shortcut: 'Mod+A',
              onSelect: selectAll,
            },
            { divider: true },
            {
              id: 'bold',
              labelKey: 'menu.text.bold',
              shortcut: 'Mod+B',
              disabled: !selectedText,
              hintKey: selectedText ? undefined : 'menu.hint.selectText',
              onSelect: () => applyInlineFormat({ bold: true }),
            },
            {
              id: 'italic',
              labelKey: 'menu.text.italic',
              shortcut: 'Mod+I',
              disabled: !selectedText,
              hintKey: selectedText ? undefined : 'menu.hint.selectText',
              onSelect: () => applyInlineFormat({ italic: true }),
            },
            {
              id: 'underline',
              labelKey: 'menu.text.underline',
              shortcut: 'Mod+U',
              disabled: !selectedText,
              hintKey: selectedText ? undefined : 'menu.hint.selectText',
              onSelect: () => applyInlineFormat({ underline: true }),
            },
            {
              id: 'strike',
              labelKey: 'menu.text.strike',
              shortcut: 'Mod+Shift+X',
              disabled: !selectedText,
              hintKey: selectedText ? undefined : 'menu.hint.selectText',
              onSelect: () => applyInlineFormat({ strike: true }),
            },
            {
              id: 'code',
              labelKey: 'menu.text.code',
              shortcut: 'Mod+E',
              disabled: !selectedText,
              hintKey: selectedText ? undefined : 'menu.hint.selectText',
              onSelect: () => applyInlineFormat({ code: true }),
            },
            {
              id: 'link',
              labelKey: 'menu.text.link',
              shortcut: 'Mod+K',
              disabled: !selectedText,
              hintKey: selectedText ? undefined : 'menu.hint.selectText',
              onSelect: () => {
                selectionRef.current = {
                  blockId,
                  start: offsets.start,
                  end: offsets.end,
                  rect: selectionRect(),
                };
                setLinkDialogOpen(true);
              },
            },
            { divider: true },
            {
              id: 'to-heading',
              labelKey: 'menu.text.toHeading2',
              disabled: block.type === 'heading2',
              hintKey:
                block.type === 'heading2' ? 'menu.hint.heading2' : undefined,
              onSelect: () => handleConvert('heading2', blockId),
            },
            {
              id: 'to-todo',
              labelKey: 'menu.text.toTodo',
              disabled: block.type === 'todo',
              hintKey: block.type === 'todo' ? 'menu.hint.todo' : undefined,
              onSelect: () => handleConvert('todo', blockId),
            },
            {
              id: 'to-quote',
              labelKey: 'menu.text.toQuote',
              disabled: block.type === 'quote',
              hintKey: block.type === 'quote' ? 'menu.hint.quote' : undefined,
              onSelect: () => handleConvert('quote', blockId),
            },
            { divider: true },
            {
              id: 'insert',
              labelKey: 'menu.text.insert',
              submenu: [
                {
                  id: 'insert-table',
                  labelKey: 'menu.text.insert.table',
                  onSelect: () => insertBlockOfType(blockId, 'table'),
                },
                {
                  id: 'insert-formula',
                  labelKey: 'menu.text.insert.formula',
                  onSelect: () => insertBlockOfType(blockId, 'formula'),
                },
                {
                  id: 'insert-code',
                  labelKey: 'menu.text.insert.code',
                  onSelect: () => insertBlockOfType(blockId, 'code'),
                },
                {
                  id: 'insert-divider',
                  labelKey: 'menu.text.insert.divider',
                  onSelect: () => insertBlockOfType(blockId, 'divider'),
                },
              ],
            },
            { divider: true },
            {
              id: 'delete-block',
              labelKey: 'menu.text.deleteBlock',
              shortcut: 'Delete',
              danger: true,
              disabled: !canDelete,
              hintKey: !canDelete ? 'menu.hint.lastBlock' : undefined,
              onSelect: () => handleDeleteBlock(blockId),
            },
          ];

      showContextMenu({
        kind: 'text',
        blockId,
        x,
        y,
        items,
        restoreFocus,
      });
    },
    [
      applyInlineFormat,
      focusBlock,
      handleConvert,
      handleDeleteBlock,
      handlePaste,
      insertBlockOfType,
      readOnly,
      selectAllBlocksAction,
      showContextMenu,
      showSelectionNotice,
      updateBlock,
    ],
  );

  const openBlankContextMenu = useCallback(
    (targetBlockId: string | null, x: number, y: number) => {
      const targetId =
        targetBlockId ??
        blocksRef.current[blocksRef.current.length - 1]?.id ??
        null;
      const pasteIntoBlank = async () => {
        const text = await readClipboardText();
        if (text === null) {
          showSelectionNotice('无法读取剪贴板，请用 ⌘V / Ctrl+V 粘贴');
          return;
        }
        if (!text) {
          showSelectionNotice('剪贴板为空');
          return;
        }
        const inserted = withRuns(
          createBlock('paragraph', noteId),
          pastedTextRuns(text),
        );
        const current = blocksRef.current;
        const index = targetId
          ? current.findIndex((block) => block.id === targetId)
          : current.length - 1;
        const next = [...current];
        next.splice(index + 1, 0, inserted);
        commitBlocks(ensureTrailingParagraph(next, noteId));
        focusBlock(inserted.id);
        showSelectionNotice('已粘贴为新段落');
      };

      const restoreFocus = () => {
        bodyRef.current?.focus({ preventScroll: true });
      };

      const items: ContextMenuItem[] = readOnly
        ? [
            {
              id: 'select-all',
              labelKey: 'menu.blank.selectAll',
              shortcut: 'Mod+A',
              onSelect: () => {
                const first = bodyRef.current?.querySelector<HTMLElement>(
                  '[data-inline-editor="true"]',
                );
                if (!first) {
                  return;
                }
                const range = document.createRange();
                range.selectNodeContents(first);
                const selectionApi = window.getSelection();
                selectionApi?.removeAllRanges();
                selectionApi?.addRange(range);
              },
            },
          ]
        : [
            {
              id: 'paste',
              labelKey: 'menu.blank.paste',
              shortcut: 'Mod+V',
              onSelect: () => {
                void pasteIntoBlank();
              },
            },
            { divider: true },
            {
              id: 'new-paragraph',
              labelKey: 'menu.blank.newParagraph',
              onSelect: () => {
                if (targetId) {
                  insertBlockOfType(targetId, 'paragraph');
                }
              },
            },
            {
              id: 'new-todo',
              labelKey: 'menu.blank.newTodo',
              onSelect: () => {
                if (targetId) {
                  insertBlockOfType(targetId, 'todo');
                }
              },
            },
            {
              id: 'new-heading',
              labelKey: 'menu.blank.newHeading2',
              onSelect: () => {
                if (targetId) {
                  insertBlockOfType(targetId, 'heading2');
                }
              },
            },
            { divider: true },
            {
              id: 'insert',
              labelKey: 'menu.blank.insert',
              submenu: [
                {
                  id: 'insert-table',
                  labelKey: 'menu.text.insert.table',
                  onSelect: () => {
                    if (targetId) {
                      insertBlockOfType(targetId, 'table');
                    }
                  },
                },
                {
                  id: 'insert-formula',
                  labelKey: 'menu.text.insert.formula',
                  onSelect: () => {
                    if (targetId) {
                      insertBlockOfType(targetId, 'formula');
                    }
                  },
                },
                {
                  id: 'insert-code',
                  labelKey: 'menu.text.insert.code',
                  onSelect: () => {
                    if (targetId) {
                      insertBlockOfType(targetId, 'code');
                    }
                  },
                },
                {
                  id: 'insert-divider',
                  labelKey: 'menu.text.insert.divider',
                  onSelect: () => {
                    if (targetId) {
                      insertBlockOfType(targetId, 'divider');
                    }
                  },
                },
              ],
            },
            { divider: true },
            {
              id: 'select-all',
              labelKey: 'menu.blank.selectAll',
              shortcut: 'Mod+A',
              onSelect: () => selectAllBlocksAction('document'),
            },
          ];

      showContextMenu({
        kind: 'blank',
        blockId: targetId,
        x,
        y,
        items,
        restoreFocus,
      });
    },
    [
      commitBlocks,
      focusBlock,
      handlePaste,
      insertBlockOfType,
      noteId,
      readOnly,
      selectAllBlocksAction,
      showContextMenu,
      showSelectionNotice,
    ],
  );

  const openTableContextMenu = useCallback(
    (blockId: string, state: TableContextMenuState) => {
      const actions = state.actions;
      const canDelete = blocksRef.current.length > 1;
      const items: ContextMenuItem[] = state.readOnly
        ? [
            {
              id: 'copy-table',
              labelKey: 'menu.table.copyTable',
              shortcut: 'Mod+C',
              onSelect: actions.copySelection,
            },
            {
              id: 'copy-markdown',
              labelKey: 'menu.table.copyMarkdown',
              onSelect: () => actions.copyExport('markdown'),
            },
            {
              id: 'copy-html',
              labelKey: 'menu.table.copyHtml',
              onSelect: () => actions.copyExport('html'),
            },
          ]
        : [
            {
              id: 'cut-selection',
              labelKey: 'menu.table.cutSelection',
              shortcut: 'Mod+X',
              disabled: !state.hasSelection,
              hintKey: state.hasSelection
                ? undefined
                : 'menu.hint.selectCells',
              onSelect: actions.cutSelection,
            },
            {
              id: 'copy-selection',
              labelKey: 'menu.table.copySelection',
              shortcut: 'Mod+C',
              disabled: !state.hasSelection,
              hintKey: state.hasSelection
                ? undefined
                : 'menu.hint.selectCells',
              onSelect: actions.copySelection,
            },
            {
              id: 'paste',
              labelKey: 'menu.table.paste',
              shortcut: 'Mod+V',
              onSelect: actions.paste,
            },
            { divider: true },
            {
              id: 'merge',
              labelKey: 'menu.table.merge',
              disabled: !state.canMerge,
              hintKey: state.canMerge ? undefined : 'menu.hint.merge',
              onSelect: actions.merge,
            },
            {
              id: 'split',
              labelKey: 'menu.table.split',
              disabled: !state.hasMerge,
              hintKey: state.hasMerge ? undefined : 'menu.hint.noMerge',
              onSelect: actions.split,
            },
            { divider: true },
            {
              id: 'row-above',
              labelKey: 'menu.table.rowAbove',
              disabled: !state.canInsertRow,
              hintKey: state.canInsertRow ? undefined : 'menu.hint.maxRows',
              onSelect: () => actions.insertRow('above'),
            },
            {
              id: 'row-below',
              labelKey: 'menu.table.rowBelow',
              disabled: !state.canInsertRow,
              hintKey: state.canInsertRow ? undefined : 'menu.hint.maxRows',
              onSelect: () => actions.insertRow('below'),
            },
            {
              id: 'column-left',
              labelKey: 'menu.table.columnLeft',
              disabled: !state.canInsertColumn,
              hintKey: state.canInsertColumn
                ? undefined
                : 'menu.hint.maxColumns',
              onSelect: () => actions.insertColumn('left'),
            },
            {
              id: 'column-right',
              labelKey: 'menu.table.columnRight',
              disabled: !state.canInsertColumn,
              hintKey: state.canInsertColumn
                ? undefined
                : 'menu.hint.maxColumns',
              onSelect: () => actions.insertColumn('right'),
            },
            {
              id: 'row-remove',
              labelKey: 'menu.table.rowRemove',
              disabled: !state.canRemoveRow,
              hintKey: state.canRemoveRow ? undefined : 'menu.hint.lastRow',
              onSelect: actions.removeRow,
            },
            {
              id: 'column-remove',
              labelKey: 'menu.table.columnRemove',
              disabled: !state.canRemoveColumn,
              hintKey: state.canRemoveColumn
                ? undefined
                : 'menu.hint.lastColumn',
              onSelect: actions.removeColumn,
            },
            { divider: true },
            { heading: t('menu.heading.tableProperties') },
            {
              id: 'align-left',
              labelKey: 'menu.table.alignLeft',
              role: 'menuitemradio',
              checked: state.align === 'left',
              disabled: !state.hasSelection,
              hintKey: state.hasSelection
                ? undefined
                : 'menu.hint.selectCells',
              onSelect: () => actions.setAlign('left'),
            },
            {
              id: 'align-center',
              labelKey: 'menu.table.alignCenter',
              role: 'menuitemradio',
              checked: state.align === 'center',
              disabled: !state.hasSelection,
              hintKey: state.hasSelection
                ? undefined
                : 'menu.hint.selectCells',
              onSelect: () => actions.setAlign('center'),
            },
            {
              id: 'align-right',
              labelKey: 'menu.table.alignRight',
              role: 'menuitemradio',
              checked: state.align === 'right',
              disabled: !state.hasSelection,
              hintKey: state.hasSelection
                ? undefined
                : 'menu.hint.selectCells',
              onSelect: () => actions.setAlign('right'),
            },
            {
              id: 'toggle-header',
              labelKey: 'menu.table.header',
              role: 'menuitemcheckbox',
              checked: state.header,
              onSelect: actions.toggleHeader,
            },
            { divider: true },
            {
              id: 'width-average',
              labelKey: 'menu.table.averageWidth',
              onSelect: actions.averageWidths,
            },
            {
              id: 'width-reset',
              labelKey: 'menu.table.resetWidth',
              onSelect: actions.resetColumnWidth,
            },
            {
              id: 'selection-clear',
              labelKey: 'menu.table.clearSelection',
              disabled: !state.hasSelection,
              hintKey: state.hasSelection
                ? undefined
                : 'menu.hint.selectCells',
              onSelect: actions.clearSelection,
            },
            { divider: true },
            {
              id: 'export',
              labelKey: 'menu.table.export',
              submenu: [
                {
                  id: 'export-markdown',
                  labelKey: 'menu.table.exportMarkdown',
                  onSelect: () => actions.exportTable('markdown'),
                },
                {
                  id: 'export-html',
                  labelKey: 'menu.table.exportHtml',
                  onSelect: () => actions.exportTable('html'),
                },
              ],
            },
            { divider: true },
            {
              id: 'delete-table',
              labelKey: 'menu.table.deleteTable',
              danger: true,
              disabled: !canDelete,
              hintKey: !canDelete ? 'menu.hint.lastBlock' : undefined,
              onSelect: () => handleDeleteBlock(blockId),
            },
          ];

      showContextMenu({
        kind: 'table',
        blockId,
        x: state.x,
        y: state.y,
        items,
        restoreFocus: actions.restoreFocus,
      });
    },
    [handleDeleteBlock, showContextMenu],
  );

  const openFormulaContextMenu = useCallback(
    (blockId: string, state: FormulaContextMenuState) => {
      const actions = state.actions;
      const canDelete = blocksRef.current.length > 1;
      const items: ContextMenuItem[] = state.readOnly
        ? [
            {
              id: 'copy-latex',
              labelKey: 'menu.formula.copyLatex',
              shortcut: 'Mod+C',
              disabled: !state.hasLatex,
              hintKey: state.hasLatex ? undefined : 'menu.hint.emptyFormula',
              onSelect: actions.copyLatex,
            },
            {
              id: 'export',
              labelKey: 'menu.formula.export',
              onSelect: actions.exportFormula,
            },
          ]
        : [
            {
              id: state.editing ? 'finish' : 'edit',
              labelKey: state.editing
                ? 'menu.formula.finish'
                : 'menu.formula.edit',
              shortcut: state.editing ? 'Mod+Enter' : undefined,
              onSelect: state.editing ? actions.finish : actions.edit,
            },
            {
              id: 'copy-latex',
              labelKey: 'menu.formula.copyLatex',
              shortcut: 'Mod+C',
              disabled: !state.hasLatex,
              hintKey: state.hasLatex ? undefined : 'menu.hint.emptyFormula',
              onSelect: actions.copyLatex,
            },
            {
              id: 'toggle-display',
              labelKey:
                state.display === 'inline'
                  ? 'menu.formula.toggleDisplay.toBlock'
                  : 'menu.formula.toggleDisplay.toInline',
              onSelect: actions.toggleDisplay,
            },
            { divider: true },
            {
              id: 'zoom',
              labelKey: 'menu.formula.zoom',
              submenu: [
                {
                  id: 'zoom-in',
                  labelKey: 'menu.formula.zoomIn',
                  shortcut: 'Mod+=',
                  disabled: state.zoom >= 2,
                  hintKey: state.zoom >= 2 ? 'menu.hint.maxZoom' : undefined,
                  onSelect: actions.zoomIn,
                },
                {
                  id: 'zoom-out',
                  labelKey: 'menu.formula.zoomOut',
                  shortcut: 'Mod+-',
                  disabled: state.zoom <= 0.8,
                  hintKey:
                    state.zoom <= 0.8 ? 'menu.hint.minZoom' : undefined,
                  onSelect: actions.zoomOut,
                },
                {
                  id: 'zoom-reset',
                  labelKey: 'menu.formula.zoomReset',
                  shortcut: 'Mod+0',
                  disabled: state.zoom === 1,
                  hintKey: state.zoom === 1 ? 'menu.hint.zoom100' : undefined,
                  onSelect: actions.resetZoom,
                },
              ],
            },
            { divider: true },
            {
              id: 'export',
              labelKey: 'menu.formula.export',
              onSelect: actions.exportFormula,
            },
            { divider: true },
            {
              id: 'delete-block',
              labelKey: 'menu.formula.deleteBlock',
              danger: true,
              disabled: !canDelete,
              hintKey: !canDelete ? 'menu.hint.lastBlock' : undefined,
              onSelect: () => handleDeleteBlock(blockId),
            },
          ];

      showContextMenu({
        kind: 'formula',
        blockId,
        x: state.x,
        y: state.y,
        items,
        restoreFocus: actions.restoreFocus,
      });
    },
    [handleDeleteBlock, showContextMenu],
  );

  const openFileContextMenu = useCallback(
    (blockId: string, x: number, y: number) => {
      const block = blocksRef.current.find((item) => item.id === blockId);
      if (!block || block.type !== 'file') {
        return;
      }
      const file = blockFile(block);
      const resolved =
        fileLocalStates[blockId] ??
        (file.attachmentId
          ? 'checking'
          : file.status === 'missing'
            ? 'missing'
            : 'none');
      const isLocal = resolved === 'local';
      const isRemote = resolved === 'remote' || resolved === 'missing';
      const isImage = file.mime.startsWith('image/');
      const canRemoteDownload =
        !readOnly && Boolean(attachmentUploader) && isRemote;

      const fileRow = () =>
        Array.from(
          bodyRef.current?.querySelectorAll<HTMLElement>('[data-block-id]') ??
            [],
        ).find((row) => row.getAttribute('data-block-id') === blockId) ?? null;

      const focusFileCard = () => {
        const name =
          fileRow()?.querySelector<HTMLButtonElement>('.zxe-filecard-name') ??
          null;
        if (name) {
          name.focus({ preventScroll: true });
          return;
        }
        bodyRef.current?.focus({ preventScroll: true });
      };

      const requestRename = () => {
        const name =
          fileRow()?.querySelector<HTMLButtonElement>('.zxe-filecard-name') ??
          null;
        if (!name) {
          return;
        }
        name.focus({ preventScroll: true });
        name.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'F2', bubbles: true }),
        );
      };

      const run = (action?: () => void | Promise<void>) => {
        if (!action) {
          return;
        }
        Promise.resolve()
          .then(action)
          .catch((reason: unknown) => {
            showSelectionNotice(formatError(reason));
          });
      };

      const copyName = async () => {
        const ok = await writeClipboardText(file.fileName);
        showSelectionNotice(
          ok ? t('menu.toast.copied') : t('menu.toast.copyFailed'),
        );
      };

      const items: ContextMenuItem[] = [
        ...(isImage
          ? [
              {
                id: 'preview',
                labelKey: 'menu.image.preview' as const,
                shortcut: 'Enter',
                disabled: !isLocal,
                onSelect: () => run(() => handleFileOpen(blockId)),
              },
            ]
          : []),
        {
          id: 'open',
          labelKey: 'menu.image.open',
          disabled: !isLocal,
          onSelect: () => run(() => handleFileOpen(blockId)),
        },
        {
          id: 'save-as',
          labelKey: 'menu.image.saveAs',
          disabled: !isLocal,
          onSelect: () => run(() => handleFileDownload(blockId)),
        },
        { divider: true },
        {
          id: 'remote-download',
          labelKey: 'menu.image.remoteDownload',
          disabled: !canRemoteDownload,
          hintKey:
            !canRemoteDownload && !isRemote
              ? 'menu.hint.remoteOnly'
              : undefined,
          onSelect: () => run(() => handleFileRemoteDownload(blockId)),
        },
        { divider: true },
        {
          id: 'rename',
          labelKey: 'menu.image.rename',
          shortcut: 'F2',
          disabled: readOnly,
          onSelect: requestRename,
        },
        {
          id: 'copy-name',
          labelKey: 'menu.image.copyName',
          disabled: !file.fileName,
          onSelect: () => {
            void copyName();
          },
        },
        ...(readOnly
          ? []
          : [
              { divider: true as const },
              {
                id: 'delete-file',
                labelKey: 'menu.image.deleteFile' as const,
                shortcut: 'Delete',
                danger: true,
                onSelect: () => {
                  handleFileRemove(blockId);
                  showSelectionNotice(t('menu.toast.fileRemovedUndo'));
                },
              },
            ]),
      ];

      showContextMenu({
        kind: 'image',
        blockId,
        x,
        y,
        items,
        restoreFocus: focusFileCard,
      });
    },
    [
      attachmentUploader,
      fileLocalStates,
      handleFileDownload,
      handleFileOpen,
      handleFileRemoteDownload,
      handleFileRemove,
      readOnly,
      showContextMenu,
      showSelectionNotice,
    ],
  );

  const openBlockSelectionContextMenu = useCallback(
    (x: number, y: number) => {
      const count = blockSelectionRef.current?.ids.length ?? 0;
      if (count === 0) {
        return;
      }
      const items: ContextMenuItem[] = [
        {
          id: 'copy-blocks',
          label: `复制 ${count} 个块`,
          shortcut: '⌘C',
          onSelect: () => {
            void copySelectedBlocks();
          },
        },
        {
          id: 'move-blocks',
          label: `移动 ${count} 个块…`,
          onSelect: openMoveDialog,
        },
        { divider: true },
        {
          id: 'delete-blocks',
          label: `删除 ${count} 个块`,
          danger: true,
          onSelect: deleteSelectedBlocks,
        },
      ];
      showContextMenu({
        kind: 'block',
        blockId: null,
        x,
        y,
        items,
        restoreFocus: () => bodyRef.current?.focus({ preventScroll: true }),
      });
    },
    [copySelectedBlocks, deleteSelectedBlocks, openMoveDialog, showContextMenu],
  );

  const handleBodyContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      // 公式 textarea / 表格单元格文本选区由子块处理并 stopPropagation。
      const target = event.target as Element;
      if (target.closest('.zxe-formula, .zxe-table-wrap')) {
        return;
      }
      if (target.closest('textarea')) {
        return;
      }

      const row = target.closest<HTMLElement>('[data-block-id]');
      const inline = row?.querySelector<HTMLElement>(
        '[data-inline-editor="true"]',
      );
      const rowBlockId = row?.getAttribute('data-block-id') ?? null;

      // 多选块：右键任意选中块，菜单作用于整个块选区（设计 §6.5）。
      const blockIds = blockSelectionRef.current?.ids;
      if (
        rowBlockId &&
        blockIds &&
        blockIds.length > 1 &&
        blockIds.includes(rowBlockId)
      ) {
        event.preventDefault();
        openBlockSelectionContextMenu(
          event.clientX,
          event.clientY,
        );
        return;
      }

      if (row && inline) {
        const domSelection = window.getSelection();
        const selectionInside =
          domSelection?.anchorNode instanceof Node &&
          inline.contains(domSelection.anchorNode);
        const block = rowBlockId
          ? blocksRef.current.find((item) => item.id === rowBlockId)
          : null;
        const fallbackEnd = block
          ? runsToPlainText(blockRuns(block)).length
          : 0;
        const offsets = selectionInside
          ? selectionOffsetsIn(inline)
          : { start: fallbackEnd, end: fallbackEnd };
        if (!offsets) {
          return;
        }
        event.preventDefault();
        openTextContextMenu(
          rowBlockId as string,
          inline,
          offsets,
          event.clientX,
          event.clientY,
        );
        return;
      }

      // 文件/图片卡：自定义菜单走同一套 ContextMenu，不弹原生菜单。
      if (row && rowBlockId) {
        const rowBlock = blocksRef.current.find(
          (item) => item.id === rowBlockId,
        );
        if (rowBlock?.type === 'file') {
          event.preventDefault();
          openFileContextMenu(rowBlockId, event.clientX, event.clientY);
        }
        return;
      }

      event.preventDefault();
      openBlankContextMenu(
        rowBlockId,
        event.clientX,
        event.clientY,
      );
    },
    [
      openBlankContextMenu,
      openBlockSelectionContextMenu,
      openFileContextMenu,
      openTextContextMenu,
    ],
  );

  const retrySave = useCallback(() => {
    void flushRef.current();
  }, []);

  const rootClassName = [
    'zxe',
    readOnly ? 'zxe--readonly' : '',
    focusMode ? 'zxe--focus' : '',
    blockSelection ? 'zxe--block-selecting' : '',
    // 文档级入口统一在知识页命令栏；编辑器不再自带右侧工具轨。
    'zxe--external-rail',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const rootStyle = {
    '--zxe-read-width': '860px',
  } as CSSProperties;

  const allBlocksSelected = Boolean(
    blockSelection &&
      blocks.length > 0 &&
      blockSelection.ids.length === blocks.length,
  );
  const documentSelection =
    allBlocksSelected && selectionMode === 'document';
  const selectedCharCount = documentSelection
    ? blocksToPlainText(blocks).length
    : 0;

  if (loadState === 'loading') {
    return (
      <section className={`${rootClassName} is-loading`} aria-label="块编辑器">
        <p className="zxe-loading" role="status">
          正在读取块…
        </p>
      </section>
    );
  }

  if (loadState === 'error') {
    return (
      <section className={`${rootClassName} is-error`} aria-label="块编辑器">
        <div className="zxe-load-error" role="alert">
          <strong>无法读取笔记块</strong>
          <p>{error ?? '未知错误'}</p>
          <button type="button" onClick={() => setReloadToken((n) => n + 1)}>
            重试
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      ref={editorRef}
      className={rootClassName}
      aria-label="块编辑器"
      data-read-only={readOnly ? 'true' : 'false'}
      data-focus={focusMode ? 'true' : 'false'}
      data-block-selection={blockSelection ? 'true' : 'false'}
      data-selection-mode={selectionMode ?? ''}
      data-writing-follow={focusMode ? String(writingFollow) : 'false'}
      style={rootStyle}
      onKeyDownCapture={handleHistoryKeyDown}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
        const blockId = activeBlockIdRef.current;
        if (focusMode && writingFollow && blockId) {
          scrollBlockToWritingLine(blockId, true);
        }
      }}
    >
      {focusMode ? (
        <div
          className="zxe-focusbar"
          role="region"
          aria-label="专注模式状态"
        >
          <span className="zxe-focusbar-dot" aria-hidden="true" />
          <strong className="zxe-focusbar-title">专注模式</strong>
          <label
            className="zxe-focusbar-follow"
            title="开启后，点击或切换到其他块时把它滚到视口约 36% 高度"
          >
            <input
              type="checkbox"
              checked={writingFollow}
              onChange={(event) =>
                updateWritingFollow(event.currentTarget.checked)
              }
            />
            写作跟随
          </label>
          <span className="zxe-focusbar-hint" aria-live="polite">
            {writingFollow ? '当前段落居中' : '只保留当前块高亮'} · Esc 退出
          </span>
          <button
            type="button"
            className="zxe-focusbar-exit"
            onClick={() => updateFocusMode(false)}
          >
            退出
          </button>
        </div>
      ) : null}
      <div
        ref={bodyRef}
        className="zxe-body zxe-focus-body"
        tabIndex={-1}
        aria-label="笔记正文"
        onContextMenu={handleBodyContextMenu}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          scrollPositionRef.current = top;
          onScrollPositionChangeRef.current?.(noteId, top);
        }}
        onMouseDown={(event) => {
          // 正文空白不是块：普通点击不抢焦点、不移动光标、不滚动。
          // 只有点击具体块/行内编辑器时才聚焦该块（由 BlockRow 负责）。
          if (event.target === event.currentTarget) {
            event.preventDefault();
          }
        }}
      >
        {blocks.map((block, index) => (
          <BlockRow
            key={block.id}
            block={block}
            index={index}
            count={blocks.length}
            readOnly={readOnly}
            active={block.id === activeBlockId}
            dragging={block.id === draggingId}
            selected={Boolean(blockSelection?.ids.includes(block.id))}
            selecting={selectionMode === 'block'}
            documentSelecting={selectionMode === 'document'}
            highlighted={block.id === highlightBlockId}
            onOpenNote={onOpenNote}
            onBoardInsertImage={handleBoardExportInsert}
            noteOptions={noteOptions}
            onEditQuote={setQuoteDialogBlockId}
            onSelectBlock={handleBlockSelect}
            onFocusBlock={setActiveBlockId}
            onBlurBlock={() => {
              void flushRef.current();
            }}
            onMenu={openMenu}
            onInputRuns={handleInputRuns}
            onInlineFormat={applyInlineFormat}
            onSelectionChange={handleSelectionChange}
            onEnter={handleEnter}
            onBackspaceAtStart={handleBackspaceAtStart}
            onSlash={handleSlash}
            onPaste={handlePaste}
            onToggleTodo={handleToggleTodo}
            contextMenuBlockId={editorMenu?.blockId ?? null}
            onTableContextMenu={openTableContextMenu}
            onFormulaContextMenu={openFormulaContextMenu}
            onPayload={handlePayload}
            fileLocalStates={fileLocalStates}
            fileSyncStates={fileSyncStates}
            fileLocalErrors={fileLocalErrors}
            onFileOpen={handleFileOpen}
            onFileDownload={handleFileDownload}
            onFileRemoteDownload={
              attachmentUploader ? handleFileRemoteDownload : undefined
            }
            onFileRemove={handleFileRemove}
            onFileReselect={handleFileReselect}
            onFileRename={handleFileCommitName}
            onDragStart={setDraggingId}
            onDragOver={(_id, event) => {
              event.preventDefault();
              if (event.dataTransfer) {
                event.dataTransfer.dropEffect = 'move';
              }
            }}
            onDrop={(id) => {
              const sourceId = draggingId;
              setDraggingId(null);
              if (!sourceId || sourceId === id) {
                return;
              }
              const current = blocksRef.current;
              const sourceIndex = current.findIndex(
                (block) => block.id === sourceId,
              );
              const targetIndex = current.findIndex((block) => block.id === id);
              if (sourceIndex < 0 || targetIndex < 0) {
                return;
              }
              const next = [...current];
              const [moved] = next.splice(sourceIndex, 1);
              next.splice(targetIndex, 0, moved);
              commitBlocks(next);
              focusBlock(moved.id);
            }}
          />
        ))}
      </div>

      {blockSelection && !readOnly ? (
        <div
          className="zxe-selectionbar"
          role="toolbar"
          aria-label="块选择操作"
        >
          <span className="zxe-selection-count">
            {documentSelection
              ? `已选中整篇 · ${blocks.length} 个块 · ${selectedCharCount} 字`
              : `已选 ${blockSelection.ids.length} 个块`}
          </span>
          <span className="zxe-selection-hint">
            {documentSelection
              ? '⌘/Ctrl+C 复制 · Delete 删除 · Esc 取消'
              : 'Shift+点击扩展范围 · Shift+↑/↓ 调整'}
          </span>
          <span className="zxe-selectionbar-spacer" />
          <button type="button" onClick={() => void copySelectedBlocks()}>
            复制
          </button>
          <button type="button" onClick={openMoveDialog}>
            移动…
          </button>
          <button
            type="button"
            className="is-danger"
            onClick={deleteSelectedBlocks}
          >
            删除
          </button>
          <button
            type="button"
            onClick={() => {
              clearBlockSelection(true);
              showSelectionNotice('已取消块选择');
            }}
          >
            取消
          </button>
        </div>
      ) : null}

      {selectionNotice ? (
        <p className="zxe-selection-toast" role="status" aria-live="polite">
          {selectionNotice}
        </p>
      ) : null}

      {fileIngesting ? (
        <p className="zxe-file-status" role="status">
          正在把文件保存到本机附件库…
        </p>
      ) : null}

      {fileIngestError ? (
        <p className="zxe-file-error" role="alert">
          {fileIngestError}
        </p>
      ) : null}

      {!readOnly ? (
        <input
          ref={fileInputRef}
          className="zxe-file-input"
          type="file"
          multiple
          aria-label="选择文件"
          tabIndex={-1}
          onChange={(event) => {
            const files = event.currentTarget.files;
            handleFileSelection(files);
            event.currentTarget.value = '';
          }}
        />
      ) : null}

      {filePreview ? (
        <div
          className="zxe-file-preview"
          role="dialog"
          aria-modal="true"
          aria-label={`图片预览：${filePreview.fileName}`}
        >
          <div className="zxe-file-preview-panel">
            <header>
              <strong>{filePreview.fileName}</strong>
              <button
                type="button"
                className="zxe-file-preview-close"
                aria-label="关闭图片预览"
                onClick={() => setFilePreview(null)}
              >
                ×
              </button>
            </header>
            <img src={filePreview.url} alt={filePreview.fileName} />
          </div>
        </div>
      ) : null}

      {selection && !readOnly && !editorMenu ? (
        <FormatBar
          rect={selection.rect}
          active={activeMarks}
          onFormat={applyInlineFormat}
          onClear={clearInlineFormat}
          onLink={() => setLinkDialogOpen(true)}
        />
      ) : null}

      {panelOpen ? (
        <StylePanel
          block={panelBlock}
          readOnly={readOnly}
          active={activeMarks}
          hasSelection={Boolean(
            selection && panelBlock && selection.blockId === panelBlock.id,
          )}
          onClose={() => updatePanelOpen(false)}
          onConvert={handleConvert}
          onFormat={applyInlineFormat}
          onClear={clearInlineFormat}
          onAlign={handleAlign}
          onIndent={handleIndent}
          onInsert={(type) => {
            const targetId =
              selectionRef.current?.blockId ?? activeBlockId ?? blocks[0]?.id;
            if (targetId) {
              insertBlockOfType(targetId, type);
            }
          }}
        />
      ) : null}

      {menu ? (
        <BlockMenu
          blockId={menu.blockId}
          x={menu.x}
          y={menu.y}
          canMoveUp={
            blocks.findIndex((block) => block.id === menu.blockId) > 0
          }
          canMoveDown={
            blocks.findIndex((block) => block.id === menu.blockId) <
            blocks.length - 1
          }
          canDelete={blocks.length > 1}
          isQuote={
            blocks.find((block) => block.id === menu.blockId)?.type ===
            'quote'
          }
          onEditQuote={() => {
            setQuoteDialogBlockId(menu.blockId);
            setMenu(null);
          }}
          onSelect={handleMenuSelect}
          onMove={(delta) => handleMoveBlock(menu.blockId, delta)}
          onDelete={() => handleDeleteBlock(menu.blockId)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {editorMenu ? (
        <ContextMenu
          x={editorMenu.x}
          y={editorMenu.y}
          label={
            editorMenu.kind === 'text'
              ? t('menu.label.text')
              : editorMenu.kind === 'table'
                ? t('menu.label.table')
                : editorMenu.kind === 'formula'
                  ? t('menu.label.formula')
                  : editorMenu.kind === 'image'
                    ? t('menu.label.image')
                    : editorMenu.kind === 'block'
                      ? '块选择菜单'
                      : t('menu.label.blank')
          }
          items={editorMenu.items}
          // 指针打开时不抢焦点：焦点留在来源块/单元格，方向键再进入菜单。
          focusOnOpen={false}
          softDisabled
          className="zxe-context-menu"
          onClose={closeEditorMenu}
        />
      ) : null}

      {moveDialogOpen ? (
        <div
          className="zxe-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !moveBusy) {
              setMoveDialogOpen(false);
            }
          }}
        >
          <div
            className="zxe-dialog zxe-move-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="移动选中块"
          >
            <h2>移动 {blockSelection?.ids.length ?? 0} 个块</h2>
            <p>
              块会追加到目标笔记末尾；⌘/Ctrl+Z 会同时恢复源笔记和目标笔记。
            </p>
            {moveTargets.length > 0 ? (
              <div
                className="zxe-move-list"
                role="radiogroup"
                aria-label="目标笔记"
              >
                {moveTargets.map((option) => (
                  <label key={option.id} className="zxe-move-item">
                    <input
                      type="radio"
                      name="zxe-move-target"
                      value={option.id}
                      checked={moveTargetId === option.id}
                      onChange={() => setMoveTargetId(option.id)}
                    />
                    <span className="zxe-move-title">{option.title}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="zxe-move-empty">没有其他笔记可移动</p>
            )}
            <div className="zxe-dialog-actions">
              <button
                type="button"
                onClick={() => setMoveDialogOpen(false)}
                disabled={moveBusy}
              >
                取消
              </button>
              <button
                type="button"
                className="is-primary"
                onClick={() => void moveSelectedBlocks()}
                disabled={
                  moveBusy ||
                  !moveTargetId ||
                  moveTargets.length === 0
                }
              >
                {moveBusy ? '移动中…' : '移动'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {linkDialogOpen ? (
        <LinkDialog
          initialUrl=""
          notes={noteOptions}
          onApply={applyLink}
          onClose={() => setLinkDialogOpen(false)}
        />
      ) : null}

      {quoteDialogMeta ? (
        <QuoteSourceDialog
          initial={quoteDialogMeta}
          notes={noteOptions}
          currentNoteId={noteId}
          onApply={applyQuoteMeta}
          onClose={() => setQuoteDialogBlockId(null)}
        />
      ) : null}

      <footer className="zxe-status">
        <span
          className={`zxe-save-state is-${saveState}`}
          aria-live="polite"
          role="status"
        >
          {saveLabel}
        </span>
        <span className="zxe-status-meta">
          {blocks.length} 块 · {blocks.filter((block) => isTextualBlockType(block.type)).length} 个文本块
        </span>
        {!readOnly && blocks.length > 0 ? (
          <button
            type="button"
            className="zxe-select-all"
            aria-label={blockSelection ? '取消块选择' : '选择块（高级）'}
            title="块选择：从当前块开始，Shift+点击扩展；⌘/Ctrl+Shift+A 全选块"
            onClick={() => {
              if (blockSelectionRef.current) {
                clearBlockSelection(true);
                showSelectionNotice('已取消块选择');
              } else {
                enterBlockSelectionMode();
              }
            }}
          >
            {blockSelection ? '取消选择' : '选择块'}
          </button>
        ) : null}
        {showHistoryControls ? (
          <span className="zxe-history" role="group" aria-label="撤销与重做">
            <button
              type="button"
              className="zxe-history-button"
              aria-label="撤销编辑"
              title="撤销（⌘Z / Ctrl+Z）"
              disabled={!historyAvailable || !canUndo}
              onClick={() => void applyHistory('undo')}
            >
              <span aria-hidden="true">↶</span> 撤销
            </button>
            <button
              type="button"
              className="zxe-history-button"
              aria-label="重做编辑"
              title="重做（⇧⌘Z / Ctrl+Shift+Z / ⌘Y）"
              disabled={!historyAvailable || !canRedo}
              onClick={() => void applyHistory('redo')}
            >
              <span aria-hidden="true">↷</span> 重做
            </button>
          </span>
        ) : null}
        {saveState === 'error' ? (
          <span className="zxe-save-error" role="alert">
            {error}
            <button type="button" onClick={retrySave}>
              重试保存
            </button>
          </span>
        ) : null}
        <span className="zxe-status-json" title="块顺序 JSON 可回放">
          JSON v1
        </span>
      </footer>
    </section>
  );
}

export const BlockEditor = NoteBlockEditor;

/** 导出给上层做「复制/备份」或调试回放。 */
export function editorDocumentJson(
  blocks: ReadonlyArray<EditorBlock>,
  noteId?: string,
): string {
  return blockDocumentJson(blocks, noteId);
}
