/**
 * 笔记中的画板块（规范《画板自由画布规范》§4）：
 * - 默认全宽、按内容 fit 的只读 Canvas 预览，高度 240–560，不裁切；
 * - 「展开」在笔记内替换为内联编辑器（工具轨 + BoardCanvas + 完成），
 *   编辑实时写同一份画板文档并自动保存，「完成」/ Esc 收起后重算高度；
 * - 空白引用不伪造预览；idle/empty/loading/error/unavailable 状态明确。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { isTauriRuntime } from '../../data/db/client';
import { createBoardSource } from './source';
import { BoardCanvas } from './BoardCanvas';
import { BoardLink } from './components/BoardLink';
import { BoardExportDialog } from './components/BoardExportDialog';
import {
  JsonDialog,
  type BoardImportMode,
} from './components/BoardDialogs';
import {
  BoardThumbnail,
  computeEmbedFit,
  type EmbedFit,
} from './components/BoardThumbnail';
import type { BoardImageFile } from './export/noteInsert';
import {
  importBoardDocumentAsNew,
  replaceBoardDocument,
} from './export/remap';
import { useBoardEditor } from './useBoardEditor';
import {
  addObject,
  createEmptyDocument,
  deleteObjects,
  fitViewport,
  insertStarter,
  parseBoardDocumentFile,
  screenToWorld,
} from './model';
import type {
  BoardContextMenuState,
  BoardDocument,
  BoardSelection,
  BoardSource,
  BoardStarterKind,
  BoardTool,
  BoardViewport,
} from './types';
import './board.css';

export type BoardEmbedProps = {
  boardId: string | null;
  title: string;
  noteId: string;
  readOnly: boolean;
  onChangeTitle: (title: string) => void;
  onChangeBoard: (patch: { boardId: string; title: string }) => void;
  /**
   * 导出 PNG 后插入当前笔记；由笔记编辑器提供（写附件库 + 追加文件卡）。
   * 不传时导出面板只提供保存，不显示「插入到笔记」。
   */
  onInsertExportedImage?: (file: BoardImageFile) => Promise<void>;
  /** 测试注入；不传时使用 SQLite 数据源。 */
  source?: BoardSource;
  /** 内联编辑器自动保存防抖；测试可传 0。 */
  saveDelayMs?: number;
};

type LoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'unavailable' | 'error';

const EMBED_EDITOR_HEIGHT_DESKTOP = 460;
const EMBED_EDITOR_HEIGHT_MOBILE = 320;
const MOBILE_BREAKPOINT = 720;

const STARTER_ITEMS: ReadonlyArray<{ kind: BoardStarterKind; label: string }> = [
  { kind: 'flow', label: '流程图' },
  { kind: 'mind', label: '思维导图' },
  { kind: 'lane', label: '横向泳道' },
  { kind: 'lane-vertical', label: '纵向泳道' },
];

function errorMessageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : '操作失败，请重试';
}

function documentKey(document: BoardDocument): string {
  return JSON.stringify(document);
}

function stateOfDocument(document: BoardDocument): LoadState {
  return document.nodes.length === 0 ? 'empty' : 'ready';
}

export function BoardEmbed({
  boardId,
  title,
  noteId,
  readOnly,
  onChangeTitle,
  onChangeBoard,
  onInsertExportedImage,
  source,
  saveDelayMs = 700,
}: BoardEmbedProps) {
  const dataSource = useMemo<BoardSource>(
    () => source ?? createBoardSource(),
    [source],
  );
  const available = source !== undefined || isTauriRuntime();
  const [document, setDocument] = useState<BoardDocument | null>(null);
  const [loadState, setLoadState] = useState<LoadState>(
    boardId ? (available ? 'loading' : 'unavailable') : 'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [editorHeight, setEditorHeight] = useState(EMBED_EDITOR_HEIGHT_DESKTOP);
  /** 展开期间由内联编辑器上报的实时对象/连线数。 */
  const [inlineStats, setInlineStats] = useState<{
    nodes: number;
    edges: number;
  } | null>(null);
  const [previewWidth, setPreviewWidth] = useState(0);
  const mountedRef = useRef(true);
  const previewRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // 预览全宽：容器宽度变化（分栏/窗口缩放/字体缩放）时重算 §4.3 高度。
  // 只读内容盒宽度，避免把边框算进 W，也避免观察高度导致 fit → 高度 →
  // observer 的反馈循环。
  useEffect(() => {
    const element = previewRef.current;
    if (!element) {
      return;
    }
    const measure = () => {
      const width = Math.round(
        element.clientWidth || element.getBoundingClientRect().width || 0,
      );
      setPreviewWidth((previous) => (previous === width ? previous : width));
    };
    measure();
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver((entries) => {
            const entry = entries[0];
            if (entry) {
              const width = Math.round(
                entry.contentRect.width || element.clientWidth || 0,
              );
              setPreviewWidth((previous) =>
                previous === width ? previous : width,
              );
              return;
            }
            measure();
          })
        : null;
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [document, loadState, expanded]);

  useEffect(() => {
    if (!boardId) {
      setDocument(null);
      setLoadState('idle');
      setError(null);
      return;
    }
    if (!available) {
      setLoadState('unavailable');
      setDocument(null);
      return;
    }
    let cancelled = false;
    setLoadState('loading');
    setError(null);
    void dataSource
      .load(boardId)
      .then((loaded) => {
        if (!cancelled && mountedRef.current) {
          setDocument(loaded);
          setLoadState(stateOfDocument(loaded));
          if (loaded.title !== title) {
            onChangeTitle(loaded.title);
          }
        }
      })
      .catch((reason) => {
        if (!cancelled && mountedRef.current) {
          setError(errorMessageOf(reason));
          setLoadState('error');
        }
      });
    return () => {
      cancelled = true;
    };
    // title/onChangeTitle 只在加载成功后同步一次，不作为触发条件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, boardId, dataSource, reloadToken]);

  // 从画板页回到笔记后，知识页通常会重新挂载；再监听窗口焦点兜底。
  // 展开编辑期间不重载，避免覆盖正在编辑的文档。
  useEffect(() => {
    if (!boardId || !available) {
      return;
    }
    const bump = () => {
      if (!expandedRef.current) {
        setReloadToken((token) => token + 1);
      }
    };
    const onVisibility = () => {
      if (window.document.visibilityState === 'visible') {
        bump();
      }
    };
    window.addEventListener('focus', bump);
    window.document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', bump);
      window.document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [available, boardId]);

  const createBlank = useCallback(async () => {
    if (readOnly || creating) {
      return;
    }
    if (!available) {
      setError('需在桌面壳内创建画板');
      setLoadState('unavailable');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const created = await dataSource.create({
        noteId,
        title: title.trim() || '未命名画板',
      });
      if (!mountedRef.current) {
        return;
      }
      setDocument(created);
      setLoadState(stateOfDocument(created));
      onChangeBoard({ boardId: created.boardId, title: created.title });
    } catch (reason) {
      if (mountedRef.current) {
        setError(errorMessageOf(reason));
        setLoadState('error');
      }
    } finally {
      if (mountedRef.current) {
        setCreating(false);
      }
    }
  }, [
    available,
    creating,
    dataSource,
    noteId,
    onChangeBoard,
    readOnly,
    title,
  ]);

  const importAsNewBoard = useCallback(
    async (sourceDocument: BoardDocument): Promise<BoardDocument> => {
      // 导入必须生成新 board/node/edge ID；重复导入同一份 JSON 也不能撞主键。
      const saved = await importBoardDocumentAsNew(dataSource, sourceDocument, {
        noteId,
      });
      if (mountedRef.current) {
        setDocument(saved);
        setLoadState(stateOfDocument(saved));
        setToast('已导入为新画板；原画板内容保持不变。');
      }
      onChangeBoard({ boardId: saved.boardId, title: saved.title });
      return saved;
    },
    [dataSource, noteId, onChangeBoard],
  );

  const applyCollapsedJson = useCallback(
    async (json: string, mode: BoardImportMode) => {
      if (readOnly) {
        throw new Error('阅读模式下不能导入画板 JSON');
      }
      const file = parseBoardDocumentFile(json);
      if (mode === 'create') {
        if (!available) {
          throw new Error('需在桌面壳内导入画板 JSON');
        }
        await importAsNewBoard(file.document);
        return;
      }
      if (!boardId || !document) {
        throw new Error('当前画板块还没有画板，请先创建空白画板或导入为新画板');
      }
      // 替换同样重映射 ID，并在保存失败时回滚到导入前快照。
      const saved = await replaceBoardDocument(
        dataSource,
        boardId,
        file.document,
        { noteId },
      );
      if (mountedRef.current) {
        setDocument(saved);
        setLoadState(stateOfDocument(saved));
        setToast('画板 JSON 已恢复');
      }
      if (saved.title !== title) {
        onChangeBoard({ boardId, title: saved.title });
      }
    },
    [
      boardId,
      available,
      dataSource,
      document,
      importAsNewBoard,
      noteId,
      onChangeBoard,
      readOnly,
      title,
    ],
  );

  const applyPackageDocument = useCallback(
    async (
      sourceDocument: BoardDocument,
      _viewport: BoardViewport | null,
      mode: BoardImportMode,
    ) => {
      if (readOnly) {
        throw new Error('阅读模式下不能导入画板包');
      }
      if (mode === 'create') {
        if (!available) {
          throw new Error('需在桌面壳内导入画板包');
        }
        await importAsNewBoard(sourceDocument);
        return;
      }
      if (!boardId || !document) {
        throw new Error('当前画板块还没有画板，请先创建空白画板或导入为新画板');
      }
      const saved = await replaceBoardDocument(
        dataSource,
        boardId,
        sourceDocument,
        { noteId },
      );
      if (mountedRef.current) {
        setDocument(saved);
        setLoadState(stateOfDocument(saved));
        setToast('画板包已导入；原画板内容已替换');
      }
      if (saved.title !== title) {
        onChangeBoard({ boardId, title: saved.title });
      }
    },
    [
      available,
      boardId,
      dataSource,
      document,
      importAsNewBoard,
      noteId,
      onChangeBoard,
      readOnly,
      title,
    ],
  );

  const fit = useMemo<EmbedFit | null>(
    () =>
      document
        ? computeEmbedFit(document.nodes, previewWidth || 760)
        : null,
    [document, previewWidth],
  );

  const counts = inlineStats ??
    (document
      ? { nodes: document.nodes.length, edges: document.edges.length }
      : null);

  const expandEditor = useCallback(() => {
    setEditorHeight(
      window.innerWidth < MOBILE_BREAKPOINT
        ? EMBED_EDITOR_HEIGHT_MOBILE
        : EMBED_EDITOR_HEIGHT_DESKTOP,
    );
    setExpanded(true);
  }, []);

  const collapseEditor = useCallback(() => {
    setExpanded(false);
    setInlineStats(null);
    setReloadToken((token) => token + 1);
  }, []);

  const openHref = boardId
    ? `/board/${encodeURIComponent(boardId)}?note=${encodeURIComponent(noteId)}`
    : null;
  const openLabel = readOnly ? '查看画板' : '打开画板';
  const canExpand =
    !readOnly &&
    available &&
    boardId != null &&
    document != null &&
    (loadState === 'ready' || loadState === 'empty');

  return (
    <div className={expanded ? 'bw-embed is-expanded' : 'bw-embed'}>
      <div className="bw-embed-head">
        <span className="bw-embed-icon" aria-hidden="true">
          ▧
        </span>
        {boardId || readOnly ? (
          <span className="bw-embed-title">
            {(document?.title || title || '未命名画板').trim() || '未命名画板'}
          </span>
        ) : (
          <input
            className="bw-embed-title-input"
            aria-label="画板标题"
            value={title}
            placeholder="未命名画板"
            maxLength={120}
            onChange={(event) => onChangeTitle(event.target.value)}
          />
        )}
        {counts ? (
          <span className="bw-embed-counts">
            {counts.nodes} 个对象 · {counts.edges} 条连线
          </span>
        ) : null}
        <span className="bw-embed-badge">画板</span>
        <div className="bw-embed-actions">
          {boardId && document && !expanded ? (
            <button
              type="button"
              className="bw-embed-expand"
              aria-label="导出画板 PNG"
              onClick={() => setExportOpen(true)}
            >
              导出 PNG
            </button>
          ) : null}
          {boardId && document && !expanded ? (
            <button
              type="button"
              className="bw-embed-expand"
              aria-label="导入或导出画板包"
              onClick={() => setJsonOpen(true)}
            >
              画板包
            </button>
          ) : null}
          {boardId && document && !expanded ? (
            <button
              type="button"
              className="bw-embed-expand"
              aria-label="打开画板 JSON"
              onClick={() => setJsonOpen(true)}
            >
              JSON
            </button>
          ) : null}
          {canExpand && !expanded ? (
            <button
              type="button"
              className="bw-embed-expand"
              onClick={expandEditor}
            >
              展开
            </button>
          ) : null}
          {openHref ? (
            <BoardLink to={openHref} className="bw-embed-open">
              {openLabel}
            </BoardLink>
          ) : null}
        </div>
      </div>
      {toast ? (
        <div className="bw-embed-status" role="status">
          {toast}
        </div>
      ) : null}

      {boardId ? (
        expanded && document && !readOnly ? (
          <BoardInlineEditor
            key={boardId}
            boardId={boardId}
            document={document}
            source={dataSource}
            height={editorHeight}
            saveDelayMs={saveDelayMs}
            noteId={noteId}
            onInsertExportedImage={onInsertExportedImage}
            onImportAsNewBoard={importAsNewBoard}
            onStats={setInlineStats}
            onDone={collapseEditor}
          />
        ) : (
          <>
            {loadState === 'ready' && document && fit ? (
              <>
                <div className="bw-embed-preview" ref={previewRef}>
                  <BoardThumbnail
                    document={document}
                    fit={fit}
                    className="bw-embed-thumbnail"
                    label={`画板预览：${document.nodes.length} 个对象、${document.edges.length} 条连线`}
                  />
                </div>
                <div className="bw-embed-foot">
                  <span>
                    按内容适应 · 全宽 · 高度 {fit.height}px ·{' '}
                    {Math.round(fit.zoom * 100) / 100}x
                  </span>
                  {canExpand ? (
                    <span className="bw-embed-foot-hint">
                      点击「展开」在笔记内编辑
                    </span>
                  ) : null}
                </div>
              </>
            ) : null}

            {loadState === 'empty' ? (
              <div className="bw-embed-placeholder is-empty">
                <p>
                  {readOnly
                    ? '空白画板：还没有任何对象。'
                    : '空白画板：展开后可插入模板，或进入整页编辑。'}
                </p>
                {canExpand ? (
                  <div className="bw-embed-actions">
                    <button
                      type="button"
                      className="bw-button is-primary"
                      onClick={expandEditor}
                    >
                      展开编辑
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {loadState === 'loading' ? (
              <div className="bw-embed-placeholder is-loading" role="status">
                正在加载画板预览…
              </div>
            ) : null}

            {loadState === 'unavailable' ? (
              <div className="bw-embed-placeholder">
                <p>需在桌面壳内加载画板预览；这里不显示伪预览。</p>
                {openHref && !readOnly ? (
                  <BoardLink to={openHref} className="bw-embed-open">
                    打开画板
                  </BoardLink>
                ) : null}
              </div>
            ) : null}

            {loadState === 'error' ? (
              <div className="bw-embed-placeholder is-error" role="alert">
                <p>画板预览加载失败：{error}</p>
                <div className="bw-embed-actions">
                  <button
                    type="button"
                    className="bw-button"
                    onClick={() => setReloadToken((token) => token + 1)}
                  >
                    重试
                  </button>
                  {openHref && !readOnly ? (
                    <BoardLink to={openHref} className="bw-embed-open">
                      打开画板
                    </BoardLink>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        )
      ) : (
        <div className="bw-embed-placeholder">
          <p>
            空白画板引用；画布预览与编辑由画板模块提供，这里不显示伪预览。
          </p>
          {!readOnly ? (
            <button
              type="button"
              className="bw-button is-primary"
              disabled={creating}
              onClick={() => void createBlank()}
            >
              {creating ? '正在创建…' : '创建空白画板'}
            </button>
          ) : null}
          {!readOnly ? (
            <button
              type="button"
              className="bw-button"
              onClick={() => setJsonOpen(true)}
            >
              导入 JSON
            </button>
          ) : null}
          {loadState === 'unavailable' && !readOnly ? (
            <small>需在桌面壳内创建画板。</small>
          ) : null}
          {error && loadState === 'error' ? (
            <p className="bw-embed-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}

      {!expanded ? (
        <BoardExportDialog
          open={exportOpen}
          document={document}
          noteId={noteId}
          onClose={() => setExportOpen(false)}
          onInsertIntoNote={readOnly ? undefined : onInsertExportedImage}
        />
      ) : null}
      {!expanded ? (
        <JsonDialog
          open={jsonOpen}
          document={
            document ??
            createEmptyDocument({
              boardId: boardId ?? '',
              noteId,
              title: title.trim() || '未命名画板',
            })
          }
          readOnly={readOnly}
          viewport={fit?.view ?? null}
          defaultMode={boardId ? 'replace' : 'create'}
          allowReplace={Boolean(boardId)}
          onClose={() => setJsonOpen(false)}
          onApply={applyCollapsedJson}
          onApplyDocument={applyPackageDocument}
          onStatus={setToast}
        />
      ) : null}
    </div>
  );
}

const SAVE_LABELS: Record<'saved' | 'dirty' | 'saving' | 'error', string> = {
  saved: '已保存',
  dirty: '有改动',
  saving: '保存中…',
  error: '保存失败',
};

/**
 * 展开后的内联编辑器：工具轨（选择/矩形/便签/连线/模板库）+ BoardCanvas。
 * 编辑实时写同一份文档并防抖自动保存；「完成」/ Esc 先保存再收起。
 */
function BoardInlineEditor({
  boardId,
  document: initialDocument,
  source,
  height,
  saveDelayMs,
  noteId,
  onInsertExportedImage,
  onImportAsNewBoard,
  onStats,
  onDone,
}: {
  boardId: string;
  document: BoardDocument;
  source: BoardSource;
  height: number;
  saveDelayMs: number;
  noteId: string;
  onInsertExportedImage?: (file: BoardImageFile) => Promise<void>;
  onImportAsNewBoard: (document: BoardDocument) => Promise<BoardDocument>;
  onStats: (stats: { nodes: number; edges: number }) => void;
  onDone: () => void;
}) {
  const editor = useBoardEditor(initialDocument);
  const [selection, setSelection] = useState<BoardSelection>({
    nodeIds: [],
    edgeIds: [],
  });
  const [tool, setTool] = useState<BoardTool>('select');
  const [starterOpen, setStarterOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [view, setView] = useState<BoardViewport>({ x: 0, y: 0, zoom: 1 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [status, setStatus] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<
    'saved' | 'dirty' | 'saving' | 'error'
  >('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const editorDocumentRef = useRef(editor.document);
  const lastSavedRef = useRef(documentKey(initialDocument));
  const saveTimerRef = useRef<number | null>(null);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const statusTimerRef = useRef<number | null>(null);
  const didFitRef = useRef(false);
  const mountedRef = useRef(true);
  const onDoneRef = useRef(onDone);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    editorDocumentRef.current = editor.document;
  }, [editor.document]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (statusTimerRef.current !== null) {
        window.clearTimeout(statusTimerRef.current);
      }
      // 收起/切页时还有未落盘的改动：补一次保存，失败只能静默（组件已卸载）。
      const snapshot = editorDocumentRef.current;
      if (documentKey(snapshot) !== lastSavedRef.current) {
        void saveChainRef.current
          .then(() => source.save(boardId, snapshot))
          .then(() => {
            lastSavedRef.current = documentKey(snapshot);
          })
          .catch(() => undefined);
      }
    };
  }, [boardId, source]);

  useEffect(() => {
    onStats({
      nodes: editor.document.nodes.length,
      edges: editor.document.edges.length,
    });
  }, [editor.document, onStats]);

  // 尺寸就绪后按内容适配；空画板回到画布中心。
  useEffect(() => {
    if (didFitRef.current || canvasSize.width < 10 || canvasSize.height < 10) {
      return;
    }
    didFitRef.current = true;
    setView(fitViewport(editor.document.nodes, canvasSize, 32));
  }, [canvasSize, editor.document.nodes]);

  const saveNow = useCallback(async (): Promise<boolean> => {
    const snapshot = editorDocumentRef.current;
    if (documentKey(snapshot) === lastSavedRef.current) {
      setSaveState('saved');
      return true;
    }
    setSaveState('saving');
    // 串行写入：自动保存与「完成」不会并发改写同一块画板。
    const task = saveChainRef.current.then(async () => {
      try {
        await source.save(boardId, snapshot);
        lastSavedRef.current = documentKey(snapshot);
        if (mountedRef.current) {
          setSaveState('saved');
          setSaveError(null);
        }
        return true;
      } catch (reason) {
        if (mountedRef.current) {
          setSaveState('error');
          setSaveError(errorMessageOf(reason));
        }
        return false;
      }
    });
    saveChainRef.current = task.catch(() => undefined);
    return task;
  }, [boardId, source]);

  // 自动保存：改动后防抖落盘，与整页画板一致。
  useEffect(() => {
    if (documentKey(editor.document) === lastSavedRef.current) {
      return;
    }
    setSaveState('dirty');
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(
      () => {
        saveTimerRef.current = null;
        void saveNow();
      },
      Math.max(0, saveDelayMs),
    );
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [editor.document, saveDelayMs, saveNow]);

  // 离开窗口前提示未保存改动。
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (documentKey(editorDocumentRef.current) !== lastSavedRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const notify = useCallback((message: string) => {
    setStatus(message);
    if (statusTimerRef.current !== null) {
      window.clearTimeout(statusTimerRef.current);
    }
    statusTimerRef.current = window.setTimeout(() => {
      statusTimerRef.current = null;
      if (mountedRef.current) {
        setStatus(null);
      }
    }, 2400);
  }, []);

  const finish = useCallback(async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const ok = await saveNow();
    if (ok) {
      onDoneRef.current();
    }
  }, [saveNow]);

  const applyInlineJson = useCallback(
    async (json: string, mode: BoardImportMode) => {
      const file = parseBoardDocumentFile(json);
      if (mode === 'create') {
        const saved = await saveNow();
        if (!saved) {
          throw new Error('当前画板还有未保存的改动，请重试');
        }
        await onImportAsNewBoard(file.document);
        return;
      }
      const flushed = await saveNow();
      if (!flushed) {
        throw new Error('当前画板还有未保存的改动，请重试');
      }
      const saved = await replaceBoardDocument(
        source,
        boardId,
        file.document,
        { noteId },
      );
      editor.apply(() => saved);
      setSelection({ nodeIds: [], edgeIds: [] });
      setView(file.viewport ?? fitViewport(saved.nodes, canvasSize, 32));
      notify('画板 JSON 已恢复，可 ⌘Z 撤销');
    },
    [
      boardId,
      canvasSize,
      editor,
      noteId,
      notify,
      onImportAsNewBoard,
      saveNow,
      source,
    ],
  );

  const applyInlinePackage = useCallback(
    async (
      sourceDocument: BoardDocument,
      importedViewport: BoardViewport | null,
      mode: BoardImportMode,
    ) => {
      if (mode === 'create') {
        const saved = await saveNow();
        if (!saved) {
          throw new Error('当前画板还有未保存的改动，请重试');
        }
        await onImportAsNewBoard(sourceDocument);
        return;
      }
      const flushed = await saveNow();
      if (!flushed) {
        throw new Error('当前画板还有未保存的改动，请重试');
      }
      const saved = await replaceBoardDocument(source, boardId, sourceDocument, {
        noteId,
      });
      editor.apply(() => saved);
      setSelection({ nodeIds: [], edgeIds: [] });
      setView(
        importedViewport ?? fitViewport(saved.nodes, canvasSize, 32),
      );
      notify('画板包已导入；原画板内容已替换，可 ⌘Z 撤销');
    },
    [
      boardId,
      canvasSize,
      editor,
      noteId,
      notify,
      onImportAsNewBoard,
      saveNow,
      source,
    ],
  );

  // 键盘：仅在焦点位于内联编辑器内时接管，避免劫持笔记正文的输入。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !(event.target instanceof Node) || !root.contains(event.target)) {
        return;
      }
      if (event.isComposing) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
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
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selection.nodeIds.length > 0 || selection.edgeIds.length > 0) {
          event.preventDefault();
          const current = selection;
          setSelection({ nodeIds: [], edgeIds: [] });
          editor.apply((documentItem) => deleteObjects(documentItem, current));
          notify(
            current.nodeIds.length > 0
              ? `已删除 ${current.nodeIds.length} 个对象`
              : '连线已删除',
          );
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editor, notify, selection]);

  const insertAtCenter = useCallback(
    (type: string) => {
      const center = screenToWorld(view, {
        x: (canvasSize.width || 800) / 2,
        y: (canvasSize.height || height) / 2,
      });
      let nodeId = '';
      editor.apply((current) => {
        const prepared = addObject(current, type, center);
        nodeId = prepared.nodeId;
        return prepared.document;
      });
      if (nodeId) {
        setSelection({ nodeIds: [nodeId], edgeIds: [] });
        setTool('select');
        setStarterOpen(false);
      }
    },
    [canvasSize, editor, height, view],
  );

  const insertStarterAtCenter = useCallback(
    (kind: BoardStarterKind) => {
      let nodeIds: string[] = [];
      const next = editor.apply((current) => {
        const prepared = insertStarter(current, kind);
        nodeIds = prepared.nodeIds;
        return prepared.document;
      });
      setSelection({ nodeIds, edgeIds: [] });
      setStarterOpen(false);
      if (canvasSize.width > 10) {
        setView(fitViewport(next.nodes, canvasSize, 32));
      }
      notify('已插入起步结构，可继续编辑或删除');
    },
    [canvasSize, editor, notify],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') {
      return;
    }
    const target = event.target as HTMLElement;
    // 弹层（导出面板等）自己的 Esc 只关闭弹层，不收起编辑器。
    if (target.closest?.('.bw-modal-backdrop')) {
      return;
    }
    // 双击改字的 Esc 只退出改字，不收起编辑器。
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
      return;
    }
    event.preventDefault();
    void finish();
  };

  return (
    <div
      ref={rootRef}
      className="bw-embed-editor"
      onKeyDown={onKeyDown}
      data-board-id={boardId}
    >
      <div className="bw-embed-tools" role="toolbar" aria-label="内嵌画板工具">
        <button
          type="button"
          className={
            tool === 'select' && !starterOpen
              ? 'bw-embed-tool is-active'
              : 'bw-embed-tool'
          }
          aria-pressed={tool === 'select'}
          onClick={() => {
            setTool('select');
            setStarterOpen(false);
          }}
        >
          选择
        </button>
        <button
          type="button"
          className="bw-embed-tool"
          onClick={() => insertAtCenter('rect')}
        >
          矩形
        </button>
        <button
          type="button"
          className="bw-embed-tool"
          onClick={() => insertAtCenter('sticky')}
        >
          便签
        </button>
        <button
          type="button"
          className={tool === 'connect' ? 'bw-embed-tool is-active' : 'bw-embed-tool'}
          aria-pressed={tool === 'connect'}
          onClick={() => {
            setTool('connect');
            setStarterOpen(false);
          }}
        >
          连线
        </button>
        <span className="bw-embed-tools-sep" aria-hidden="true" />
        <button
          type="button"
          className={
            starterOpen ? 'bw-embed-tool is-active' : 'bw-embed-tool'
          }
          aria-pressed={starterOpen}
          aria-expanded={starterOpen}
          onClick={() => setStarterOpen((open) => !open)}
        >
          模板库
        </button>
        <button
          type="button"
          className="bw-embed-tool"
          aria-label="导出画板 PNG"
          onClick={() => setExportOpen(true)}
        >
          导出 PNG
        </button>
        <button
          type="button"
          className="bw-embed-tool"
          aria-label="打开画板 JSON"
          onClick={() => setJsonOpen(true)}
        >
          JSON
        </button>
        <span className="bw-embed-tools-sep" aria-hidden="true" />
        <button
          type="button"
          className="bw-embed-tool"
          disabled={!editor.canUndo}
          onClick={() => editor.undo()}
        >
          撤销
        </button>
        <button
          type="button"
          className="bw-embed-tool"
          disabled={!editor.canRedo}
          onClick={() => editor.redo()}
        >
          重做
        </button>
        <span
          className={
            saveState === 'error'
              ? 'bw-embed-save is-error'
              : 'bw-embed-save'
          }
        >
          {saveState === 'error' && saveError
            ? `保存失败：${saveError}`
            : SAVE_LABELS[saveState]}
        </span>
        <button
          type="button"
          className="bw-embed-tool is-primary"
          onClick={() => void finish()}
        >
          完成
        </button>
      </div>

      {starterOpen ? (
        <div className="bw-embed-starter-menu" role="menu" aria-label="模板库">
          {STARTER_ITEMS.map((item) => (
            <button
              key={item.kind}
              type="button"
              className="bw-embed-tool"
              role="menuitem"
              onClick={() => insertStarterAtCenter(item.kind)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="bw-embed-canvas-host" style={{ height: `${height}px` }}>
        <BoardCanvas
          document={editor.document}
          selection={selection}
          tool={tool}
          readOnly={false}
          view={view}
          onViewChange={setView}
          onSelectionChange={setSelection}
          onApply={editor.apply}
          onBeginTransaction={editor.beginTransaction}
          onUpdateTransient={editor.updateTransient}
          onEndTransaction={editor.endTransaction}
          onStatus={notify}
          onRequestEdgeLabel={() => notify('连线标签请在整页画板中编辑')}
          onContextMenuRequest={(_: BoardContextMenuState) => undefined}
          onSizeChange={setCanvasSize}
        />
      </div>

      <div className="bw-embed-statusbar" role="status">
        {status ?? `${height}px 内联编辑 · 滚轮缩放 · 空格拖动平移 · Esc 完成`}
      </div>

      <BoardExportDialog
        open={exportOpen}
        document={editor.document}
        noteId={noteId}
        onClose={() => setExportOpen(false)}
        onInsertIntoNote={onInsertExportedImage}
        onStatus={notify}
      />
      <JsonDialog
        open={jsonOpen}
        document={editor.document}
        viewport={view}
        onClose={() => setJsonOpen(false)}
        onApply={applyInlineJson}
        onApplyDocument={applyInlinePackage}
        onStatus={notify}
      />
    </div>
  );
}
