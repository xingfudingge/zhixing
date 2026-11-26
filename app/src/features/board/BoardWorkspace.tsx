/**
 * 画板整页工作区（P1-04）。
 *
 * 知识区 / 笔记内嵌预览之外的独立编辑页：左侧工具栏、Canvas2D 画布、
 * 右侧检查器、顶部标题/保存状态与阅读模式。数据来自 `BoardSource`
 * （正式运行走 Tauri + SQLite；浏览器预览明确提示无法持久化）。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';

import { db, isTauriRuntime } from '../../data/db/client';
import {
  createBlockRepository,
  type BlockRepository,
} from '../../data/repositories/blocks';
import {
  useAttachmentRuntime,
  type AttachmentManager,
} from '../attachments';
import {
  addObject,
  alignObjects,
  copyObjects,
  createEmptyDocument,
  deleteObjects,
  distributeObjects,
  duplicateObjects,
  fitViewport,
  insertStarter,
  layerObjects,
  normalizeBoardDocument,
  normalizeObjectType,
  OBJECT_TYPE_LABELS,
  parseBoardDocumentFile,
  pasteObjects,
  reverseConnector,
  screenToWorld,
  setConnectorLabel,
  setObjectType,
  setObjectsLocked,
  updateConnectorsStyle,
  updateObjectsStyle,
  type AlignMode,
  type BoardLayerDirection,
} from './model';
import { createBoardSource } from './source';
import { useBoardEditor } from './useBoardEditor';
import { BoardCanvas } from './BoardCanvas';
import { BoardContextMenu } from './components/BoardContextMenu';
import type { ContextMenuCloseReason } from '../knowledge/contextMenu';
import { BoardExportDialog } from './components/BoardExportDialog';
import { BoardInspector } from './components/BoardInspector';
import { BoardLink } from './components/BoardLink';
import { BoardRail } from './components/BoardRail';
import { insertBoardImageIntoNote, type BoardImageFile } from './export/noteInsert';
import {
  importBoardDocumentAsNew,
  replaceBoardDocument,
} from './export/remap';
import {
  JsonDialog,
  ShapesDialog,
  StarterDialog,
  errorMessageOf,
  type BoardImportMode,
} from './components/BoardDialogs';
import type {
  BoardClipboard,
  BoardConnectorStyle,
  BoardContextMenuState,
  BoardDocument,
  BoardObjectStyle,
  BoardObjectType,
  BoardRouting,
  BoardSelection,
  BoardSource,
  BoardStarterKind,
  BoardTool,
  BoardViewport,
} from './types';
import './board.css';

export type BoardWorkspaceProps = {
  boardId?: string | null;
  noteId?: string | null;
  /** 测试注入；不传时按运行环境创建 SQLite 数据源。 */
  source?: BoardSource;
  /** 测试注入：附件运行时；不传时按桌面环境装配。 */
  attachmentManager?: AttachmentManager | null;
  /** 测试注入：笔记块仓储；不传时写真实 SQLite。 */
  blockSource?: BlockRepository;
  /** 自动保存防抖；测试可传 0。 */
  saveDelayMs?: number;
};

type Availability = 'loading' | 'ready' | 'unavailable' | 'error';

type WorkspaceState = {
  availability: Availability;
  document: BoardDocument;
  notice: string | null;
};

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'unavailable';

const SAVE_LABELS: Record<SaveState, string> = {
  saved: '已保存',
  dirty: '有改动',
  saving: '保存中…',
  error: '保存失败',
  unavailable: '未连接本地库',
};

function noteHref(noteId: string | null | undefined): string {
  return noteId ? `/knowledge?note=${encodeURIComponent(noteId)}` : '/knowledge';
}

/**
 * 返回笔记前先等待保存，避免笔记里的画板预览读到上一版节点。
 * 无 Router 的测试环境退回普通链接。
 */
function BoardBackButton({
  to,
  onBeforeNavigate,
  className,
}: {
  to: string;
  onBeforeNavigate: () => Promise<unknown>;
  className?: string;
}) {
  const inRouter = useInRouterContext();
  if (!inRouter) {
    return (
      <a
        href={to}
        className={className}
        onClick={() => {
          void onBeforeNavigate();
        }}
      >
        返回笔记
      </a>
    );
  }
  return (
    <RouterBoardBackButton
      to={to}
      onBeforeNavigate={onBeforeNavigate}
      className={className}
    />
  );
}

function RouterBoardBackButton({
  to,
  onBeforeNavigate,
  className,
}: {
  to: string;
  onBeforeNavigate: () => Promise<unknown>;
  className?: string;
}) {
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={saving}
      onClick={() => {
        setSaving(true);
        void onBeforeNavigate().finally(() => {
          navigate(to);
        });
      }}
    >
      {saving ? '保存中…' : '返回笔记'}
    </button>
  );
}

function documentKey(document: BoardDocument): string {
  return JSON.stringify(document);
}

function fallbackDocument(
  boardId: string | null | undefined,
  noteId: string | null | undefined,
  availability: Availability,
): WorkspaceState {
  return {
    availability,
    document: createEmptyDocument({
      boardId: boardId || 'local-draft',
      noteId: noteId ?? null,
      title: '未命名画板',
    }),
    notice:
      availability === 'unavailable'
        ? '浏览器预览：画板编辑可用，但不会写入 SQLite；请从桌面壳打开以保存与刷新恢复。'
        : availability === 'loading'
          ? '正在加载画板…'
          : null,
  };
}

export function BoardWorkspace({
  boardId,
  noteId,
  source,
  attachmentManager,
  blockSource,
  saveDelayMs = 500,
}: BoardWorkspaceProps) {
  const dataSource = useMemo<BoardSource>(
    () => source ?? createBoardSource(),
    [source],
  );
  const available = source !== undefined || isTauriRuntime();
  const attachmentRuntime = useAttachmentRuntime({
    enabled: attachmentManager === undefined && available,
  });
  const activeAttachmentManager =
    attachmentManager === undefined
      ? attachmentRuntime.manager
      : attachmentManager;
  const attachmentReason =
    attachmentManager === undefined
      ? attachmentRuntime.reason
      : null;
  const blockRepository = useMemo<BlockRepository>(
    () => blockSource ?? createBlockRepository(db),
    [blockSource],
  );
  const [state, setState] = useState<WorkspaceState>(() =>
    fallbackDocument(
      boardId,
      noteId,
      available ? 'loading' : 'unavailable',
    ),
  );
  const [reloadToken, setReloadToken] = useState(0);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    if (!available) {
      setState(fallbackDocument(boardId, noteId, 'unavailable'));
      return;
    }
    setState((previous) => ({
      ...previous,
      availability: 'loading',
      notice: '正在加载画板…',
    }));

    const run = async () => {
      try {
        let targetId = boardId ?? null;
        if (!targetId) {
          const boards = await dataSource.list();
          targetId = boards[0]?.id ?? null;
          if (!targetId) {
            const created = await dataSource.create({
              noteId: noteId ?? null,
              title: '未命名画板',
            });
            if (!cancelledRef.current) {
              setState({
                availability: 'ready',
                document: created,
                notice: '已新建空白画板；插入对象后会自动保存。',
              });
            }
            return;
          }
        }
        const document = await dataSource.load(targetId);
        if (!cancelledRef.current) {
          setState({
            availability: 'ready',
            document,
            notice: null,
          });
        }
      } catch (reason) {
        if (!cancelledRef.current) {
          setState({
            availability: 'error',
            document: createEmptyDocument({
              boardId: boardId || 'local-draft',
              noteId: noteId ?? null,
              title: '未命名画板',
            }),
            notice: `画板加载失败：${errorMessageOf(reason)}。当前为未保存草稿。`,
          });
        }
      }
    };
    void run();

    return () => {
      cancelledRef.current = true;
    };
  }, [available, boardId, dataSource, noteId, reloadToken]);

  const handleCreateBoard = useCallback(async () => {
    try {
      const document = await dataSource.create({
        noteId: noteId ?? null,
        title: '未命名画板',
      });
      setState({ availability: 'ready', document, notice: '已创建新画板' });
    } catch (reason) {
      setState((previous) => ({
        ...previous,
        availability: 'error',
        notice: `创建画板失败：${errorMessageOf(reason)}`,
      }));
    }
  }, [dataSource, noteId]);

  const handleImportAsNewBoard = useCallback(
    async (sourceDocument: BoardDocument): Promise<BoardDocument> => {
      // 导入为新画板：新建 boardId + 全套 node/edge ID，失败回收半成品。
      const saved = await importBoardDocumentAsNew(dataSource, sourceDocument, {
        noteId: noteId ?? sourceDocument.noteId ?? null,
      });
      setState({
        availability: 'ready',
        document: saved,
        notice: '已导入为新画板；原画板内容保持不变。',
      });
      return saved;
    },
    [dataSource, noteId],
  );

  const handleInsertIntoNote = useCallback(
    async (file: BoardImageFile) => {
      const targetNoteId = noteId ?? state.document.noteId;
      if (!targetNoteId) {
        throw new Error(
          '当前画板没有关联笔记，无法插入。请从笔记里的画板块打开画板后再导出。',
        );
      }
      if (!activeAttachmentManager) {
        throw new Error(
          attachmentReason ?? '附件服务不可用，无法把 PNG 写入本机附件库。',
        );
      }
      await insertBoardImageIntoNote({
        noteId: targetNoteId,
        file,
        attachmentManager: activeAttachmentManager,
        blockRepository,
      });
    },
    [
      activeAttachmentManager,
      attachmentReason,
      blockRepository,
      noteId,
      state.document.noteId,
    ],
  );

  return (
    <BoardEditor
      key={`${state.document.boardId || 'draft'}:${state.availability}`}
      initialDocument={state.document}
      source={dataSource}
      available={state.availability === 'ready'}
      availability={state.availability}
      sourceNotice={state.notice}
      noteId={noteId ?? state.document.noteId}
      saveDelayMs={saveDelayMs}
      onCreateBoard={handleCreateBoard}
      onImportAsNewBoard={handleImportAsNewBoard}
      onRetryLoad={() => setReloadToken((token) => token + 1)}
      onInsertIntoNote={handleInsertIntoNote}
    />
  );
}

type BoardEditorProps = {
  initialDocument: BoardDocument;
  source: BoardSource;
  available: boolean;
  availability: Availability;
  sourceNotice: string | null;
  noteId: string | null;
  saveDelayMs: number;
  onCreateBoard: () => void;
  onImportAsNewBoard: (document: BoardDocument) => Promise<BoardDocument>;
  onRetryLoad: () => void;
  onInsertIntoNote: (file: BoardImageFile) => Promise<void>;
};

function BoardEditor({
  initialDocument,
  source,
  available,
  availability,
  sourceNotice,
  noteId,
  saveDelayMs,
  onCreateBoard,
  onImportAsNewBoard,
  onRetryLoad,
  onInsertIntoNote,
}: BoardEditorProps) {
  // 旧画板（process/start/decision）在进入编辑时归一为新语义；文字、样式、
  // 锁定与连线保持不变，后续保存会写回新类型。
  const editor = useBoardEditor(normalizeBoardDocument(initialDocument));
  const document = editor.document;
  const boardId = document.boardId;
  const documentRef = useRef(document);
  documentRef.current = document;

  const [selection, setSelection] = useState<BoardSelection>({
    nodeIds: [],
    edgeIds: [],
  });
  const [tool, setTool] = useState<BoardTool>('select');
  const [readOnly, setReadOnly] = useState(false);
  const [viewport, setViewport] = useState<BoardViewport>({
    x: 700,
    y: 450,
    zoom: 1,
  });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [saveState, setSaveState] = useState<SaveState>(
    available ? 'saved' : 'unavailable',
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [titleDraft, setTitleDraft] = useState(document.title);
  const [starterOpen, setStarterOpen] = useState(false);
  const [shapesOpen, setShapesOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [focusLabelToken, setFocusLabelToken] = useState(0);
  const [contextMenu, setContextMenu] = useState<BoardContextMenuState | null>(
    null,
  );

  const lastSavedRef = useRef(documentKey(initialDocument));
  const rootRef = useRef<HTMLElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const statusTimerRef = useRef<number | null>(null);
  const didFitRef = useRef(false);
  const clipboardRef = useRef<BoardClipboard | null>(null);

  const notify = useCallback((message: string) => {
    setStatus(message);
    if (statusTimerRef.current !== null) {
      window.clearTimeout(statusTimerRef.current);
    }
    statusTimerRef.current = window.setTimeout(() => {
      statusTimerRef.current = null;
      setStatus('');
    }, 3200);
  }, []);

  const closeContextMenu = useCallback(
    (reason?: ContextMenuCloseReason) => {
      setContextMenu(null);
      if (reason !== 'escape' && reason !== 'select') {
        return;
      }
      // 共享菜单已移除 DOM；把焦点交还画布，不落回 body。
      window.setTimeout(() => {
        rootRef.current
          ?.querySelector<HTMLElement>('.bw-canvas')
          ?.focus({ preventScroll: true });
      }, 0);
    },
    [],
  );

  // 弹窗置顶层之前先收起背景右键菜单，避免关闭弹窗后菜单仍在或抢焦点。
  const openBoardDialog = useCallback((setOpen: (open: boolean) => void) => {
    setContextMenu(null);
    setOpen(true);
  }, []);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current !== null) {
        window.clearTimeout(statusTimerRef.current);
      }
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // 复核选择：撤销/删除后不要把不存在的对象留在选择里。
  useEffect(() => {
    setSelection((previous) => {
      const nodeIds = previous.nodeIds.filter((id) =>
        document.nodes.some((node) => node.id === id),
      );
      const edgeIds = previous.edgeIds.filter((id) =>
        document.edges.some((edge) => edge.id === id),
      );
      if (
        nodeIds.length === previous.nodeIds.length &&
        edgeIds.length === previous.edgeIds.length &&
        nodeIds.every((id, index) => id === previous.nodeIds[index]) &&
        edgeIds.every((id, index) => id === previous.edgeIds[index])
      ) {
        return previous;
      }
      return { nodeIds, edgeIds };
    });
  }, [document]);

  useEffect(() => {
    setTitleDraft(document.title);
  }, [document.title]);

  // 首次加载后适配内容；空画板回到画布中心。
  useEffect(() => {
    if (didFitRef.current) {
      return;
    }
    if (canvasSize.width < 10 || canvasSize.height < 10) {
      return;
    }
    didFitRef.current = true;
    setViewport(fitViewport(document.nodes, canvasSize));
  }, [canvasSize, document.nodes]);

  // -------------------------------------------------------------------------
  // 保存
  // -------------------------------------------------------------------------

  const saveNow = useCallback((): Promise<boolean> => {
    if (!available || !boardId) {
      setSaveState('unavailable');
      return Promise.resolve(false);
    }
    const snapshot = documentRef.current;
    const json = documentKey(snapshot);
    if (json === lastSavedRef.current) {
      setSaveState('saved');
      return Promise.resolve(true);
    }
    setSaveState('saving');
    const task = saveChainRef.current.then(async () => {
      try {
        await source.save(boardId, snapshot);
        lastSavedRef.current = json;
        if (documentKey(documentRef.current) === json) {
          setSaveState('saved');
        }
        setSaveError(null);
        return true;
      } catch (reason) {
        setSaveState('error');
        setSaveError(errorMessageOf(reason));
        return false;
      }
    });
    saveChainRef.current = task.catch(() => undefined);
    return task;
  }, [available, boardId, source]);

  useEffect(() => {
    if (!available || !boardId) {
      setSaveState('unavailable');
      return;
    }
    const json = documentKey(document);
    if (json === lastSavedRef.current) {
      setSaveState('saved');
      return;
    }
    setSaveState('dirty');
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveNow();
    }, Math.max(0, saveDelayMs));
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [available, boardId, document, saveDelayMs, saveNow]);

  // 离开页面前提示未保存；Tauri/浏览器都不静默丢改动。
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (
        available &&
        documentKey(documentRef.current) !== lastSavedRef.current
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [available]);

  // -------------------------------------------------------------------------
  // 文档操作
  // -------------------------------------------------------------------------

  const insertAtCenter = useCallback(
    (type: BoardObjectType | string) => {
      if (readOnly) {
        return;
      }
      const center = screenToWorld(viewport, {
        x: (canvasSize.width || 1000) / 2,
        y: (canvasSize.height || 700) / 2,
      });
      let nodeId = '';
      editor.apply((current) => {
        const prepared = addObject(current, type, center);
        nodeId = prepared.nodeId;
        return prepared.document;
      });
      if (nodeId) {
        setSelection({ nodeIds: [nodeId], edgeIds: [] });
      }
      notify(
        `已插入${OBJECT_TYPE_LABELS[normalizeObjectType(type)]}`,
      );
    },
    [canvasSize.height, canvasSize.width, editor, notify, readOnly, viewport],
  );

  const insertStarterAtCenter = useCallback(
    (kind: BoardStarterKind) => {
      if (readOnly) {
        return;
      }
      let nodeIds: string[] = [];
      const next = editor.apply((current) => {
        const prepared = insertStarter(current, kind);
        nodeIds = prepared.nodeIds;
        return prepared.document;
      });
      setSelection({ nodeIds, edgeIds: [] });
      setStarterOpen(false);
      setViewport(fitViewport(next.nodes, canvasSize));
      notify('已插入起步结构，可继续编辑或删除');
    },
    [canvasSize, editor, notify, readOnly],
  );

  const deleteSelection = useCallback(() => {
    if (readOnly) {
      return;
    }
    const current = selection;
    if (current.nodeIds.length === 0 && current.edgeIds.length === 0) {
      return;
    }
    editor.apply((documentItem) => deleteObjects(documentItem, current));
    setSelection({ nodeIds: [], edgeIds: [] });
    const nodeCount = current.nodeIds.length;
    const edgeCount = current.edgeIds.length;
    if (nodeCount === 0) {
      notify(edgeCount > 1 ? `已删除 ${edgeCount} 条连线` : '连线已删除');
      return;
    }
    notify(
      edgeCount > 0
        ? `已删除 ${nodeCount} 个对象、${edgeCount} 条连线`
        : `已删除 ${nodeCount} 个对象`,
    );
  }, [editor, notify, readOnly, selection]);

  const alignSelection = useCallback(
    (mode: AlignMode) => {
      if (readOnly) {
        return;
      }
      if (selection.nodeIds.length < 2) {
        notify('先按住 Shift 多选两个以上对象');
        return;
      }
      editor.apply((documentItem) =>
        alignObjects(documentItem, selection.nodeIds, mode),
      );
      notify('已对齐');
    },
    [editor, notify, readOnly, selection.nodeIds],
  );

  const distributeSelection = useCallback(
    (axis: 'x' | 'y') => {
      if (readOnly) {
        return;
      }
      if (selection.nodeIds.length < 3) {
        notify('至少选择 3 个对象才能等距');
        return;
      }
      editor.apply((documentItem) =>
        distributeObjects(documentItem, selection.nodeIds, axis),
      );
      notify(axis === 'x' ? '已水平等距' : '已垂直等距');
    },
    [editor, notify, readOnly, selection.nodeIds],
  );

  const duplicateSelection = useCallback(() => {
    if (readOnly || selection.nodeIds.length === 0) {
      return;
    }
    let nodeIds: string[] = [];
    editor.apply((current) => {
      const prepared = duplicateObjects(current, selection.nodeIds);
      nodeIds = prepared.nodeIds;
      return prepared.document;
    });
    setSelection({ nodeIds, edgeIds: [] });
    notify('已复制一份');
  }, [editor, notify, readOnly, selection.nodeIds]);

  const copySelection = useCallback(() => {
    if (selection.nodeIds.length === 0) {
      return;
    }
    clipboardRef.current = copyObjects(
      documentRef.current,
      selection.nodeIds,
    );
    notify(`已复制 ${selection.nodeIds.length} 个对象`);
  }, [notify, selection.nodeIds]);

  const pasteClipboard = useCallback(() => {
    const clipboard = clipboardRef.current;
    if (readOnly || !clipboard || clipboard.nodes.length === 0) {
      return;
    }
    let nodeIds: string[] = [];
    editor.apply((current) => {
      const prepared = pasteObjects(current, clipboard, { offset: 24 });
      nodeIds = prepared.nodeIds;
      clipboardRef.current = copyObjects(prepared.document, prepared.nodeIds);
      return prepared.document;
    });
    setSelection({ nodeIds, edgeIds: [] });
    notify('已粘贴');
  }, [editor, notify, readOnly]);

  const selectAll = useCallback(() => {
    if (readOnly) {
      return;
    }
    setSelection({
      nodeIds: documentRef.current.nodes.map((node) => node.id),
      edgeIds: documentRef.current.edges.map((edge) => edge.id),
    });
  }, [readOnly]);

  const layerSelection = useCallback(
    (direction: BoardLayerDirection) => {
      if (readOnly || selection.nodeIds.length === 0) {
        return;
      }
      editor.apply((documentItem) =>
        layerObjects(documentItem, selection.nodeIds, direction),
      );
      const labels: Record<BoardLayerDirection, string> = {
        front: '已置顶',
        back: '已置底',
        up: '已上移一层',
        down: '已下移一层',
      };
      notify(labels[direction]);
    },
    [editor, notify, readOnly, selection.nodeIds],
  );

  const toggleLock = useCallback(() => {
    if (readOnly || selection.nodeIds.length === 0) {
      return;
    }
    const selected = documentRef.current.nodes.filter((node) =>
      selection.nodeIds.includes(node.id),
    );
    const shouldLock = selected.some((node) => node.payload.locked !== true);
    editor.apply((documentItem) =>
      setObjectsLocked(documentItem, selection.nodeIds, shouldLock),
    );
    notify(shouldLock ? '已锁定，解锁后可移动' : '已解锁');
  }, [editor, notify, readOnly, selection.nodeIds]);

  const changeObjectStyle = useCallback(
    (patch: Partial<BoardObjectStyle>) => {
      if (readOnly) {
        return;
      }
      editor.apply((documentItem) =>
        updateObjectsStyle(documentItem, selection.nodeIds, patch),
      );
    },
    [editor, readOnly, selection.nodeIds],
  );

  const changeObjectType = useCallback(
    (type: string) => {
      if (readOnly) {
        return;
      }
      editor.apply((documentItem) =>
        setObjectType(documentItem, selection.nodeIds, type),
      );
    },
    [editor, readOnly, selection.nodeIds],
  );

  const changeEdgeStyle = useCallback(
    (patch: Partial<BoardConnectorStyle>) => {
      if (readOnly || selection.edgeIds.length === 0) {
        return;
      }
      editor.apply((documentItem) =>
        updateConnectorsStyle(documentItem, selection.edgeIds, patch),
      );
    },
    [editor, readOnly, selection.edgeIds],
  );

  const changeEdgeLabel = useCallback(
    (label: string) => {
      if (readOnly || selection.edgeIds.length !== 1) {
        return;
      }
      editor.apply((documentItem) =>
        setConnectorLabel(documentItem, selection.edgeIds[0], label),
      );
    },
    [editor, readOnly, selection.edgeIds],
  );

  const reverseSelectedEdge = useCallback(() => {
    if (readOnly || selection.edgeIds.length !== 1) {
      return;
    }
    editor.apply((documentItem) =>
      reverseConnector(documentItem, selection.edgeIds[0]),
    );
    notify('连线方向已反转');
  }, [editor, notify, readOnly, selection.edgeIds]);

  const applyJson = useCallback(
    async (json: string, mode: BoardImportMode) => {
      if (readOnly) {
        throw new Error('阅读模式下不能导入画板 JSON');
      }
      const file = parseBoardDocumentFile(json);
      if (mode === 'create') {
        const flushed = await saveNow();
        if (!flushed) {
          throw new Error('当前画板还有未保存的改动，请重试');
        }
        const saved = await onImportAsNewBoard(file.document);
        setViewport(file.viewport ?? fitViewport(saved.nodes, canvasSize));
        return;
      }
      // 替换当前画板：外来 boardId/noteId 不写回路由；校验全部通过后才应用。
      // 节点/连线生成新 ID；保存失败时用导入前快照回滚。
      const flushed = await saveNow();
      if (!flushed) {
        throw new Error('当前画板还有未保存的改动，请重试');
      }
      const saved = await replaceBoardDocument(
        source,
        documentRef.current.boardId,
        file.document,
        { noteId: documentRef.current.noteId },
      );
      editor.apply(() => saved);
      setSelection({ nodeIds: [], edgeIds: [] });
      setViewport(file.viewport ?? fitViewport(saved.nodes, canvasSize));
      notify('画板 JSON 已恢复，可 ⌘Z 撤销');
    },
    [
      canvasSize,
      editor,
      notify,
      onImportAsNewBoard,
      readOnly,
      saveNow,
      source,
    ],
  );

  const applyPackageDocument = useCallback(
    async (
      sourceDocument: BoardDocument,
      importedViewport: BoardViewport | null,
      mode: BoardImportMode,
    ) => {
      if (readOnly) {
        throw new Error('阅读模式下不能导入画板包');
      }
      if (mode === 'create') {
        const flushed = await saveNow();
        if (!flushed) {
          throw new Error('当前画板还有未保存的改动，请重试');
        }
        const saved = await onImportAsNewBoard(sourceDocument);
        setViewport(
          importedViewport ?? fitViewport(saved.nodes, canvasSize),
        );
        notify('已导入为新画板；原画板内容保持不变。');
        return;
      }
      const flushed = await saveNow();
      if (!flushed) {
        throw new Error('当前画板还有未保存的改动，请重试');
      }
      const saved = await replaceBoardDocument(
        source,
        documentRef.current.boardId,
        sourceDocument,
        { noteId: documentRef.current.noteId },
      );
      editor.apply(() => saved);
      setSelection({ nodeIds: [], edgeIds: [] });
      setViewport(
        importedViewport ?? fitViewport(saved.nodes, canvasSize),
      );
      notify('画板包已导入；原画板内容已替换，可 ⌘Z 撤销');
    },
    [
      canvasSize,
      editor,
      notify,
      onImportAsNewBoard,
      readOnly,
      saveNow,
      source,
    ],
  );

  // -------------------------------------------------------------------------
  // 键盘快捷键
  // -------------------------------------------------------------------------

  useEffect(() => {
    const isEditable = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      return Boolean(
        target.closest('input, textarea, select, [contenteditable="true"]'),
      );
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || isEditable(event.target)) {
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (event.key === 'Escape') {
        if (contextMenu) {
          closeContextMenu('escape');
          return;
        }
        setSelection({ nodeIds: [], edgeIds: [] });
        return;
      }
      if (readOnly) {
        return;
      }
      if (mod && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          editor.redo();
        } else {
          editor.undo();
        }
        return;
      }
      if (mod && key === 'y') {
        event.preventDefault();
        editor.redo();
        return;
      }
      if (mod && key === 'a') {
        event.preventDefault();
        selectAll();
        return;
      }
      if (mod && key === 'c') {
        if (selection.nodeIds.length === 0) {
          return;
        }
        event.preventDefault();
        copySelection();
        return;
      }
      if (mod && key === 'v') {
        if (!clipboardRef.current || clipboardRef.current.nodes.length === 0) {
          return;
        }
        event.preventDefault();
        pasteClipboard();
        return;
      }
      if (mod && key === 'd') {
        if (selection.nodeIds.length === 0) {
          return;
        }
        event.preventDefault();
        duplicateSelection();
        return;
      }
      if (mod && event.key === '0') {
        event.preventDefault();
        setViewport(fitViewport(documentRef.current.nodes, canvasSize));
        return;
      }
      if (mod && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        setViewport((current) => ({
          ...current,
          zoom: Math.min(2, Math.round((current.zoom + 0.1) * 100) / 100),
        }));
        return;
      }
      if (mod && event.key === '-') {
        event.preventDefault();
        setViewport((current) => ({
          ...current,
          zoom: Math.max(0.3, Math.round((current.zoom - 0.1) * 100) / 100),
        }));
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selection.nodeIds.length > 0 || selection.edgeIds.length > 0) {
          event.preventDefault();
          deleteSelection();
        }
        return;
      }
      if (
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight'
      ) {
        if (selection.nodeIds.length === 0) {
          return;
        }
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx =
          event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy =
          event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        editor.apply((documentItem) =>
          moveObjectsBy(documentItem, selection.nodeIds, dx, dy),
        );
        return;
      }
      const shortcutTypes: Record<string, BoardObjectType> = {
        r: 'rect',
        o: 'ellipse',
        d: 'diamond',
        t: 'text',
        s: 'sticky',
        f: 'frame',
      };
      if (!mod && shortcutTypes[key]) {
        event.preventDefault();
        insertAtCenter(shortcutTypes[key]);
        return;
      }
      if (!mod && key === 'v') {
        setTool('select');
        return;
      }
      if (!mod && key === 'h') {
        setTool('hand');
        return;
      }
      if (!mod && key === 'l') {
        setTool('connect');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    canvasSize,
    closeContextMenu,
    contextMenu,
    copySelection,
    deleteSelection,
    duplicateSelection,
    editor,
    insertAtCenter,
    pasteClipboard,
    readOnly,
    selectAll,
    selection,
  ]);

  // -------------------------------------------------------------------------
  // 视图
  // -------------------------------------------------------------------------

  const zoomBy = (factor: number) => {
    const center = {
      x: (canvasSize.width || 1000) / 2,
      y: (canvasSize.height || 700) / 2,
    };
    setViewport((current) => {
      const world = screenToWorld(current, center);
      const nextZoom = Math.min(
        2,
        Math.max(0.3, Math.round(current.zoom * factor * 100) / 100),
      );
      return {
        zoom: nextZoom,
        x: world.x - center.x / nextZoom,
        y: world.y - center.y / nextZoom,
      };
    });
  };

  const fit = () => {
    setViewport(fitViewport(documentRef.current.nodes, canvasSize));
  };

  const toggleReadOnly = () => {
    const next = !readOnly;
    setReadOnly(next);
    setContextMenu(null);
    if (next) {
      setSelection({ nodeIds: [], edgeIds: [] });
      setTool('select');
      void saveNow();
    }
  };

  const commitTitle = () => {
    const title = titleDraft.trim() || '未命名画板';
    if (title !== document.title) {
      editor.apply((documentItem) => ({ ...documentItem, title }));
    }
    setTitleDraft(title);
  };

  const selectionCount = selection.nodeIds.length;
  const edgeSelectionCount = selection.edgeIds.length;
  const hasSelection = selectionCount > 0 || edgeSelectionCount > 0;
  const selectedEdges = document.edges.filter((edge) =>
    selection.edgeIds.includes(edge.id),
  );
  const edgeRouting: BoardRouting | null =
    selectedEdges.length > 0 &&
    selectedEdges.every(
      (edge) => edge.style.routing === selectedEdges[0].style.routing,
    ) &&
    (selectedEdges[0].style.routing === 'straight' ||
      selectedEdges[0].style.routing === 'elbow' ||
      selectedEdges[0].style.routing === 'curve')
      ? (selectedEdges[0].style.routing as BoardRouting)
      : null;
  const canSave = available && Boolean(boardId);
  const saveLabel =
    saveState === 'unavailable'
      ? available
        ? '未保存草稿'
        : '未连接本地库'
      : SAVE_LABELS[saveState];
  const notice =
    saveState === 'error' && saveError
      ? `保存失败：${saveError}`
      : sourceNotice;

  return (
    <section
      ref={rootRef}
      className={
        readOnly ? 'bw-root bw-page is-readonly' : 'bw-root bw-page'
      }
      aria-label="画板工作区"
    >
      <div className="bw-head">
        <div className="bw-head-main">
          <nav className="bw-crumb" aria-label="画板位置">
            <BoardLink to="/knowledge" className="bw-crumb-link">
              知识
            </BoardLink>
            <span aria-hidden="true">/</span>
            {noteId ? (
              <BoardLink to={noteHref(noteId)} className="bw-crumb-link">
                笔记
              </BoardLink>
            ) : null}
            <span aria-hidden="true">/</span>
            <h1>画板</h1>
          </nav>
          <input
            className="bw-title-input"
            aria-label="画板标题"
            value={titleDraft}
            readOnly={readOnly}
            placeholder="未命名画板"
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              }
              if (event.key === 'Escape') {
                setTitleDraft(document.title);
                event.currentTarget.blur();
              }
            }}
          />
          <span className="bw-workspace-meta">全高工作区 · 顶栏隐藏</span>
        </div>
        <div className="bw-head-actions">
          <span
            className={`bw-save-state bw-save-${saveState}`}
            role="status"
            aria-live="polite"
          >
            <span className="bw-save-dot" aria-hidden="true" />
            {saveLabel}
          </span>
          <span className="bw-counts">
            {document.nodes.length} 个对象 · {document.edges.length} 条连线
          </span>
          {availability === 'error' ? (
            <button
              type="button"
              className="bw-button"
              onClick={onRetryLoad}
            >
              重试加载
            </button>
          ) : null}
          {!boardId && availability === 'ready' ? (
            <button
              type="button"
              className="bw-button is-primary"
              onClick={onCreateBoard}
            >
              新建画板
            </button>
          ) : null}
          <button
            type="button"
            className={readOnly ? 'bw-button is-active' : 'bw-button'}
            aria-pressed={readOnly}
            onClick={toggleReadOnly}
          >
            {readOnly ? '退出阅读' : '阅读'}
          </button>
          <button
            type="button"
            className="bw-button"
            aria-label="导出画板 PNG"
            onClick={() => openBoardDialog(setExportOpen)}
          >
            导出 PNG
          </button>
          <button
            type="button"
            className="bw-button"
            aria-label="导入或导出画板包"
            onClick={() => openBoardDialog(setJsonOpen)}
          >
            导入 / 导出
          </button>
          <button
            type="button"
            className="bw-button is-primary"
            disabled={!canSave}
            onClick={() => {
              void saveNow().then((ok) => {
                if (ok) {
                  notify('画板已保存到本机');
                }
              });
            }}
          >
            保存
          </button>
          <BoardBackButton
            to={noteHref(noteId)}
            className="bw-button"
            onBeforeNavigate={saveNow}
          />
        </div>
      </div>

      {notice ? (
        <div
          className={`bw-notice ${
            availability === 'error' || saveState === 'error'
              ? 'is-error'
              : ''
          }`}
          role="status"
        >
          {notice}
        </div>
      ) : null}

      <div className="bw-body">
        {!readOnly ? (
          <BoardRail
            tool={tool}
            onToolChange={setTool}
            onInsert={insertAtCenter}
            onMoreShapes={() => openBoardDialog(setShapesOpen)}
            onStarter={() => openBoardDialog(setStarterOpen)}
            onUndo={editor.undo}
            onRedo={editor.redo}
            canUndo={editor.canUndo}
            canRedo={editor.canRedo}
            selectionCount={selectionCount}
            edgeSelectionCount={edgeSelectionCount}
            edgeRouting={edgeRouting}
            onEdgeRouting={(routing) => changeEdgeStyle({ routing })}
            onAlign={alignSelection}
            onDelete={deleteSelection}
          />
        ) : null}

        <div className="bw-stage">
          <BoardCanvas
            document={document}
            selection={selection}
            tool={tool}
            readOnly={readOnly}
            view={viewport}
            onViewChange={setViewport}
            onSelectionChange={setSelection}
            onApply={editor.apply}
            onBeginTransaction={editor.beginTransaction}
            onUpdateTransient={editor.updateTransient}
            onEndTransaction={editor.endTransaction}
            onStatus={notify}
            onContextMenuRequest={setContextMenu}
            onRequestEdgeLabel={(edgeId) => {
              setSelection({ nodeIds: [], edgeIds: [edgeId] });
              setFocusLabelToken((token) => token + 1);
            }}
            onSizeChange={setCanvasSize}
          />
          {document.nodes.length === 0 ? (
            <div className="bw-empty">
              <div className="bw-empty-card">
                <strong>空白画板</strong>
                <p>
                  从左侧插入图形，或选择一组起步结构。不会自动插入示例对象。
                </p>
                <div className="bw-empty-actions">
                  <button
                    type="button"
                    className="bw-button is-primary"
                    disabled={readOnly}
                    onClick={() => openBoardDialog(setStarterOpen)}
                  >
                    起步结构
                  </button>
                  <button
                    type="button"
                    className="bw-button"
                    disabled={readOnly}
                    onClick={() => insertAtCenter('rect')}
                  >
                    插入矩形
                  </button>
                  <button
                    type="button"
                    className="bw-button"
                    onClick={() => openBoardDialog(setJsonOpen)}
                  >
                    导入画板包…
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          <div className="bw-zoom" role="group" aria-label="缩放">
            <button
              type="button"
              aria-label="缩小"
              onClick={() => zoomBy(0.9)}
            >
              −
            </button>
            <button
              type="button"
              className="bw-zoom-value"
              aria-label="适配画布"
              title="适配画布"
              onClick={fit}
            >
              {Math.round(viewport.zoom * 100)}%
            </button>
            <button
              type="button"
              aria-label="放大"
              onClick={() => zoomBy(1.1)}
            >
              ＋
            </button>
          </div>
        </div>

        {!readOnly ? (
          <BoardInspector
            document={document}
            selection={selection}
            readOnly={readOnly}
            focusLabelToken={focusLabelToken}
            onChangeObjectStyle={changeObjectStyle}
            onChangeObjectType={changeObjectType}
            onAlign={alignSelection}
            onDistribute={distributeSelection}
            onDuplicate={duplicateSelection}
            onLayer={layerSelection}
            onToggleLock={toggleLock}
            onDelete={deleteSelection}
            onChangeEdgeStyle={changeEdgeStyle}
            onChangeEdgeLabel={changeEdgeLabel}
            onReverseEdge={reverseSelectedEdge}
          />
        ) : null}
      </div>

      <footer className="bw-statusbar">
        <div className="bw-status-text">
          {readOnly
            ? '阅读模式：只读，可缩放与平移'
            : !hasSelection
              ? '拖动空白处框选 · Shift 加选 · 从锚点拖线 · 右键菜单 · ⌘Z 撤销'
              : selectionCount === 0
                ? `已选 ${edgeSelectionCount} 条连线 · Delete 删除 · 右侧/右键可批量改线型`
                : edgeSelectionCount === 0
                  ? `已选 ${selectionCount} 个对象 · 拖动移动 · 双击改字 · 右下角缩放`
                  : `已选 ${selectionCount} 个对象、${edgeSelectionCount} 条连线 · 右键批量操作`}
        </div>
        <div className="bw-status-right">
          {status ? <span className="bw-status-message">{status}</span> : null}
          <span>缩放 30%–200% · Canvas2D</span>
        </div>
      </footer>

      {contextMenu && !readOnly ? (
        <BoardContextMenu
          state={contextMenu}
          document={document}
          selection={selection}
          clipboardAvailable={Boolean(
            clipboardRef.current && clipboardRef.current.nodes.length > 0,
          )}
          canUndo={editor.canUndo}
          canRedo={editor.canRedo}
          onClose={closeContextMenu}
          onCopy={copySelection}
          onPaste={pasteClipboard}
          onSelectAll={selectAll}
          onFit={fit}
          onUndo={editor.undo}
          onRedo={editor.redo}
          onLayer={layerSelection}
          onToggleLock={toggleLock}
          onDelete={deleteSelection}
          onAlign={alignSelection}
          onDistribute={distributeSelection}
          onReverseEdge={reverseSelectedEdge}
          onChangeEdgeStyle={changeEdgeStyle}
        />
      ) : null}

      <StarterDialog
        open={starterOpen}
        onClose={() => setStarterOpen(false)}
        onInsert={insertStarterAtCenter}
        hasContent={document.nodes.length > 0}
      />      <ShapesDialog
        open={shapesOpen}
        onClose={() => setShapesOpen(false)}
        onInsert={(type) => {
          setShapesOpen(false);
          insertAtCenter(type);
        }}
      />
      <JsonDialog
        open={jsonOpen}
        document={document}
        readOnly={readOnly}
        viewport={viewport}
        onClose={() => setJsonOpen(false)}
        onApply={applyJson}
        onApplyDocument={applyPackageDocument}
        onStatus={notify}
      />
      <BoardExportDialog
        open={exportOpen}
        document={document}
        noteId={noteId}
        onClose={() => setExportOpen(false)}
        onInsertIntoNote={noteId ? onInsertIntoNote : undefined}
        onStatus={notify}
      />
    </section>
  );
}

/**
 * 方向键微移不能把 snapping 的 10px 网格强行套到 1px 上，所以这里单独保留
 * 精确移动；其它拖动仍走 `moveObjects` 的 10px 吸附。
 */
function moveObjectsBy(
  document: BoardDocument,
  ids: ReadonlyArray<string>,
  dx: number,
  dy: number,
): BoardDocument {
  const idSet = new Set(ids);
  let changed = false;
  const nodes = document.nodes.map((node) => {
    if (!idSet.has(node.id) || node.payload.locked === true) {
      return node;
    }
    changed = true;
    return { ...node, x: node.x + dx, y: node.y + dy };
  });
  return changed ? { ...document, nodes } : document;
}
