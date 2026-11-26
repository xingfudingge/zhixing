/**
 * Canvas2D 画布交互层。
 *
 * - 图形、连线、选择框、锚点、缩放手柄全部绘制在 canvas 上；
 * - 双击改字时临时叠加 textarea（IME 需要原生输入控件）；
 * - 所有文档变更通过 useBoardEditor 的 apply/transaction 完成，因此
 *   ⌘Z / ⇧⌘Z 能恢复拖动、缩放、改字、连线等操作。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import {
  addConnector,
  addQuickObject,
  moveObjects,
  normalizeObjectType,
  objectStyle,
  resizeObject,
  setObjectText,
  worldToScreen,
  zoomAtPoint,
  type Point,
  type Rect,
} from './model';
import {
  anchorPoint,
  autoSides,
  hitTestConnector,
  hitTestNode,
  marqueeNodeIds,
  normalizeDragRect,
} from './canvas/geometry';
import {
  paintBoardScene,
  readBoardTheme,
  type BoardTheme,
  type PendingConnection,
} from './canvas/render';
import type {
  AnchorSide,
  BoardContextMenuState,
  BoardDocument,
  BoardObject,
  BoardSelection,
  BoardTool,
  BoardViewport,
} from './types';

export type BoardCanvasProps = {
  document: BoardDocument;
  selection: BoardSelection;
  tool: BoardTool;
  readOnly: boolean;
  view: BoardViewport;
  onViewChange: (view: BoardViewport) => void;
  onSelectionChange: (selection: BoardSelection) => void;
  onApply: (mutator: (document: BoardDocument) => BoardDocument) => BoardDocument;
  onBeginTransaction: () => void;
  onUpdateTransient: (
    mutator: (document: BoardDocument) => BoardDocument,
  ) => BoardDocument;
  onEndTransaction: (commit: boolean) => void;
  onStatus: (message: string) => void;
  onRequestEdgeLabel: (edgeId: string) => void;
  onContextMenuRequest: (menu: BoardContextMenuState) => void;
  onSizeChange?: (size: { width: number; height: number }) => void;
};

type HandleHit =
  | { kind: 'anchor'; nodeId: string; side: AnchorSide }
  | { kind: 'resize'; nodeId: string }
  | { kind: 'quick'; nodeId: string; side: AnchorSide };

type DragState =
  | {
      kind: 'move';
      ids: string[];
      startWorld: Point;
      baseDocument: BoardDocument;
      moved: boolean;
    }
  | {
      kind: 'resize';
      nodeId: string;
      startWorld: Point;
      baseDocument: BoardDocument;
      baseWidth: number;
      baseHeight: number;
      moved: boolean;
    }
  | {
      kind: 'marquee';
      startWorld: Point;
      additive: boolean;
      baseSelection: string[];
      baseEdgeSelection: string[];
      moved: boolean;
    }
  | {
      kind: 'pan';
      startClient: Point;
      startView: BoardViewport;
    }
  | {
      kind: 'connect';
      fromId: string;
      fromSide: AnchorSide;
      targetId: string | null;
      targetSide: AnchorSide | null;
      moved: boolean;
    }
  | null;

type EditingState = {
  nodeId: string;
  text: string;
} | null;

const HANDLE_HIT_PX = 10;

function get2dContext(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

function oppositeSide(side: AnchorSide): AnchorSide {
  return side === 'l' ? 'r' : side === 'r' ? 'l' : side === 't' ? 'b' : 't';
}

function nearestAnchorSide(
  node: BoardObject,
  point: Point,
  tolerance: number,
): AnchorSide | null {
  let best: { side: AnchorSide; distance: number } | null = null;
  for (const side of ['l', 'r', 't', 'b'] as const) {
    const anchor = anchorPoint(node, side);
    const distance = Math.hypot(anchor.x - point.x, anchor.y - point.y);
    if (distance <= tolerance && (!best || distance < best.distance)) {
      best = { side, distance };
    }
  }
  return best?.side ?? null;
}

/** 连线目标：对象内部，或距离任一锚点 tolerance 内（锚点本身在边界上）。 */
function findConnectTarget(
  nodes: ReadonlyArray<BoardObject>,
  point: Point,
  tolerance: number,
): BoardObject | null {
  const direct = hitTestNode(nodes, point);
  if (direct) {
    return direct;
  }
  let best: { node: BoardObject; distance: number } | null = null;
  for (const node of nodes) {
    for (const side of ['l', 'r', 't', 'b'] as const) {
      const anchor = anchorPoint(node, side);
      const distance = Math.hypot(anchor.x - point.x, anchor.y - point.y);
      if (distance <= tolerance && (!best || distance < best.distance)) {
        best = { node, distance };
      }
    }
  }
  return best?.node ?? null;
}

function hitHandle(
  document: BoardDocument,
  selection: BoardSelection,
  hoveredNodeId: string | null,
  point: Point,
  zoom: number,
  readOnly: boolean,
): HandleHit | null {
  if (readOnly) {
    return null;
  }
  const threshold = HANDLE_HIT_PX / zoom;
  const selectedIds = new Set(selection.nodeIds);
  const selected = document.nodes.filter((node) => selectedIds.has(node.id));
  const hovered = hoveredNodeId
    ? document.nodes.find((node) => node.id === hoveredNodeId)
    : null;

  if (selected.length === 1) {
    const node = selected[0];
    const locked = node.payload.locked === true;
    if (!locked) {
      // 先命中 SE 缩放手柄。
      if (
        Math.hypot(
          point.x - (node.x + node.width),
          point.y - (node.y + node.height),
        ) <= threshold
      ) {
        return { kind: 'resize', nodeId: node.id };
      }
      if (node.type !== 'frame') {
        for (const side of ['r', 'b', 'l', 't'] as const) {
          const anchor = anchorPoint(node, side);
          const direction =
            side === 'r'
              ? { x: 1, y: 0 }
              : side === 'l'
                ? { x: -1, y: 0 }
                : side === 'b'
                  ? { x: 0, y: 1 }
                  : { x: 0, y: -1 };
          const quick = {
            x: anchor.x + direction.x * (18 / zoom),
            y: anchor.y + direction.y * (18 / zoom),
          };
          if (Math.hypot(point.x - quick.x, point.y - quick.y) <= 11 / zoom) {
            return { kind: 'quick', nodeId: node.id, side };
          }
        }
      }
    }
  }

  const anchorCandidates = new Map<string, BoardObject>();
  for (const node of selected) {
    anchorCandidates.set(node.id, node);
  }
  if (hovered && !anchorCandidates.has(hovered.id)) {
    anchorCandidates.set(hovered.id, hovered);
  }
  for (const node of anchorCandidates.values()) {
    // 锁定对象不能作为连线起点：不暴露锚点手柄。
    if (node.payload.locked === true) {
      continue;
    }
    for (const side of ['l', 'r', 't', 'b'] as const) {
      const anchor = anchorPoint(node, side);
      if (Math.hypot(point.x - anchor.x, point.y - anchor.y) <= threshold) {
        return { kind: 'anchor', nodeId: node.id, side };
      }
    }
  }
  return null;
}

export function BoardCanvas({
  document,
  selection,
  tool,
  readOnly,
  view,
  onViewChange,
  onSelectionChange,
  onApply,
  onBeginTransaction,
  onUpdateTransient,
  onEndTransaction,
  onStatus,
  onRequestEdgeLabel,
  onContextMenuRequest,
  onSizeChange,
}: BoardCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const documentRef = useRef(document);
  const selectionRef = useRef(selection);
  const viewRef = useRef(view);
  const dragRef = useRef<DragState>(null);
  const spaceDownRef = useRef(false);
  const themeRef = useRef<BoardTheme>(readBoardTheme());
  const editingRef = useRef<EditingState>(null);
  const connectSourceRef = useRef<{ nodeId: string; side: AnchorSide } | null>(
    null,
  );
  const onViewChangeRef = useRef(onViewChange);
  const onStatusRef = useRef(onStatus);
  const onRequestEdgeLabelRef = useRef(onRequestEdgeLabel);
  const onContextMenuRequestRef = useRef(onContextMenuRequest);
  const onSizeChangeRef = useRef(onSizeChange);

  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [cursor, setCursor] = useState('default');
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [pending, setPending] = useState<PendingConnection | null>(null);
  const [connectSource, setConnectSourceState] = useState<{
    nodeId: string;
    side: AnchorSide;
  } | null>(null);
  const [editing, setEditingState] = useState<EditingState>(null);
  const [themeVersion, setThemeVersion] = useState(0);

  documentRef.current = document;
  selectionRef.current = selection;
  viewRef.current = view;
  onViewChangeRef.current = onViewChange;
  onStatusRef.current = onStatus;
  onRequestEdgeLabelRef.current = onRequestEdgeLabel;
  onContextMenuRequestRef.current = onContextMenuRequest;
  onSizeChangeRef.current = onSizeChange;

  const setConnectSource = useCallback(
    (source: { nodeId: string; side: AnchorSide } | null) => {
      connectSourceRef.current = source;
      setConnectSourceState(source);
      if (!source) {
        setPending(null);
      }
    },
    [],
  );

  const setEditing = useCallback((next: EditingState) => {
    editingRef.current = next;
    setEditingState(next);
  }, []);

  // -------------------------------------------------------------------------
  // 尺寸与主题
  // -------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width || 1000));
      const height = Math.max(1, Math.round(rect.height || 700));
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
      onSizeChangeRef.current?.({ width, height });
    };
    measure();
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(measure)
        : null;
    observer?.observe(canvas);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') {
      return;
    }
    const observer = new MutationObserver(() => {
      themeRef.current = readBoardTheme();
      setThemeVersion((value) => value + 1);
    });
    observer.observe(window.document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent'],
    });
    return () => observer.disconnect();
  }, []);

  // -------------------------------------------------------------------------
  // 绘制
  // -------------------------------------------------------------------------

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = get2dContext(canvas);
    if (!context) {
      return;
    }
    const dpr =
      typeof window !== 'undefined'
        ? Math.min(2, window.devicePixelRatio || 1)
        : 1;
    const pixelWidth = Math.max(1, Math.round(size.width * dpr));
    const pixelHeight = Math.max(1, Math.round(size.height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    themeRef.current = readBoardTheme();
    paintBoardScene({
      ctx: context,
      width: size.width,
      height: size.height,
      dpr,
      document,
      view,
      selection,
      hoveredNodeId,
      editingNodeId: editing?.nodeId ?? null,
      marquee,
      pendingConnection: pending,
      theme: themeRef.current,
      readOnly,
    });
  }, [
    document,
    view,
    selection,
    hoveredNodeId,
    editing,
    marquee,
    pending,
    size,
    readOnly,
    themeVersion,
  ]);

  // -------------------------------------------------------------------------
  // 文字编辑
  // -------------------------------------------------------------------------

  useLayoutEffect(() => {
    if (!editing) {
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.focus();
    textarea.select();
    // 仅在切换对象时聚焦，避免每次输入都重置选区。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.nodeId]);

  const finishEditing = useCallback(
    (cancel: boolean) => {
      const current = editingRef.current;
      if (!current) {
        return;
      }
      editingRef.current = null;
      setEditingState(null);
      if (cancel) {
        return;
      }
      onApply((document) =>
        setObjectText(document, current.nodeId, current.text),
      );
    },
    [onApply],
  );

  const beginEditing = useCallback(
    (node: BoardObject) => {
      const currentDocument = documentRef.current;
      const live = currentDocument.nodes.find((nodeItem) => nodeItem.id === node.id);
      if (!live || live.payload.locked === true) {
        return;
      }
      onSelectionChange({ nodeIds: [live.id], edgeIds: [] });
      setEditing({ nodeId: live.id, text: live.text });
    },
    [onSelectionChange, setEditing],
  );

  // -------------------------------------------------------------------------
  // 坐标/命中
  // -------------------------------------------------------------------------

  const screenPointOf = useCallback((clientX: number, clientY: number): Point => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return { x: 0, y: 0 };
    }
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  const worldPointOf = useCallback(
    (clientX: number, clientY: number): Point => {
      const screen = screenPointOf(clientX, clientY);
      const currentView = viewRef.current;
      return {
        x: currentView.x + screen.x / currentView.zoom,
        y: currentView.y + screen.y / currentView.zoom,
      };
    },
    [screenPointOf],
  );

  const updateHover = useCallback(
    (clientX: number, clientY: number) => {
      const currentDocument = documentRef.current;
      const currentSelection = selectionRef.current;
      const currentView = viewRef.current;
      const world = worldPointOf(clientX, clientY);
      if (readOnly) {
        setHoveredNodeId(null);
        setCursor('grab');
        return;
      }
      const handle = hitHandle(
        currentDocument,
        currentSelection,
        hoveredNodeId,
        world,
        currentView.zoom,
        readOnly,
      );
      if (handle) {
        setHoveredNodeId(handle.nodeId);
        setCursor(
          handle.kind === 'resize'
            ? 'nwse-resize'
            : handle.kind === 'quick'
              ? 'pointer'
              : 'crosshair',
        );
        return;
      }
      const node = hitTestNode(currentDocument.nodes, world);
      if (node) {
        setHoveredNodeId(node.id);
        setCursor(
          node.payload.locked === true
            ? 'not-allowed'
            : tool === 'connect'
              ? 'crosshair'
              : 'move',
        );
        return;
      }
      const edge = hitTestConnector(
        currentDocument.edges,
        currentDocument.nodes,
        world,
        10 / currentView.zoom,
      );
      setHoveredNodeId(null);
      setCursor(
        edge
          ? 'pointer'
          : tool === 'connect'
            ? 'crosshair'
            : tool === 'hand'
              ? 'grab'
              : 'default',
      );
    },
    [hoveredNodeId, readOnly, tool, worldPointOf],
  );

  // -------------------------------------------------------------------------
  // 指针事件
  // -------------------------------------------------------------------------

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }
      const middle = event.button === 1;
      const hand = tool === 'hand' || spaceDownRef.current;
      if (middle || hand) {
        event.preventDefault();
        dragRef.current = {
          kind: 'pan',
          startClient: { x: event.clientX, y: event.clientY },
          startView: { ...viewRef.current },
        };
        setCursor('grabbing');
        return;
      }
      if (event.button !== 0) {
        return;
      }
      canvas.focus();
      if (readOnly) {
        // 阅读模式不能编辑，但允许左键拖动画布；工具栏已隐藏。
        dragRef.current = {
          kind: 'pan',
          startClient: { x: event.clientX, y: event.clientY },
          startView: { ...viewRef.current },
        };
        setCursor('grabbing');
        return;
      }
      const world = worldPointOf(event.clientX, event.clientY);
      const currentDocument = documentRef.current;
      const currentSelection = selectionRef.current;
      const currentView = viewRef.current;

      // 已有待连接源：下一次点击对象即完成连线。
      const connectSource = connectSourceRef.current;
      if (connectSource) {
        const sourceNode = currentDocument.nodes.find(
          (node) => node.id === connectSource.nodeId,
        );
        if (!sourceNode || sourceNode.payload.locked === true) {
          setConnectSource(null);
          onStatusRef.current('对象已锁定，不能作为连线起点');
          return;
        }
        const target = findConnectTarget(
          currentDocument.nodes,
          world,
          14 / currentView.zoom,
        );
        if (!target) {
          setConnectSource(null);
          onStatusRef.current('已取消连线');
          return;
        }
        if (target.id === connectSource.nodeId) {
          onStatusRef.current('不能连接同一个对象');
          return;
        }
        if (target.payload.locked === true) {
          setPending(null);
          setHoveredNodeId(target.id);
          setCursor('not-allowed');
          onStatusRef.current('对象已锁定，不能连接');
          return;
        }
        const targetSide =
          nearestAnchorSide(target, world, 12 / currentView.zoom) ??
          autoSides(sourceNode, target)[1];
        const result = onApply((documentItem) =>
          addConnector(documentItem, connectSource.nodeId, target.id, {
            fromSide: connectSource.side,
            toSide: targetSide,
          }).document,
        );
        const newEdge = result.edges[result.edges.length - 1] ?? null;
        setConnectSource(null);
        setPending(null);
        if (newEdge && result.edges.length > currentDocument.edges.length) {
          onSelectionChange({ nodeIds: [], edgeIds: [newEdge.id] });
          onStatusRef.current('已连接，可在右侧检查器改线型/箭头/标签');
        }
        return;
      }

      const handle = hitHandle(
        currentDocument,
        currentSelection,
        hoveredNodeId,
        world,
        currentView.zoom,
        readOnly,
      );

      if (handle?.kind === 'quick') {
        const result = onApply((documentItem) =>
          addQuickObject(documentItem, handle.nodeId, handle.side).document,
        );
        const newNode = result.nodes[result.nodes.length - 1];
        if (newNode) {
          onSelectionChange({ nodeIds: [newNode.id], edgeIds: [] });
        }
        onStatusRef.current('已创建并连接新步骤');
        return;
      }

      if (handle?.kind === 'resize') {
        const node = currentDocument.nodes.find(
          (item) => item.id === handle.nodeId,
        );
        if (!node) {
          return;
        }
        onBeginTransaction();
        dragRef.current = {
          kind: 'resize',
          nodeId: node.id,
          startWorld: world,
          baseDocument: currentDocument,
          baseWidth: node.width,
          baseHeight: node.height,
          moved: false,
        };
        return;
      }

      if (handle?.kind === 'anchor') {
        const anchorNode = currentDocument.nodes.find(
          (node) => node.id === handle.nodeId,
        );
        if (!anchorNode) {
          return;
        }
        if (anchorNode.payload.locked === true) {
          onStatusRef.current('对象已锁定，不能作为连线起点');
          return;
        }
        setPending({
          from: anchorNode,
          side: handle.side,
          to: world,
          targetId: null,
        });
        dragRef.current = {
          kind: 'connect',
          fromId: handle.nodeId,
          fromSide: handle.side,
          targetId: null,
          targetSide: null,
          moved: false,
        };
        setCursor('crosshair');
        return;
      }

      const node = hitTestNode(currentDocument.nodes, world);
      if (!node) {
        const edge = hitTestConnector(
          currentDocument.edges,
          currentDocument.nodes,
          world,
          10 / currentView.zoom,
        );
        if (edge) {
          if (event.shiftKey) {
            const exists = currentSelection.edgeIds.includes(edge.id);
            const edgeIds = exists
              ? currentSelection.edgeIds.filter((id) => id !== edge.id)
              : [...currentSelection.edgeIds, edge.id];
            onSelectionChange({
              nodeIds: currentSelection.nodeIds,
              edgeIds,
            });
          } else {
            onSelectionChange({ nodeIds: [], edgeIds: [edge.id] });
          }
          setHoveredNodeId(null);
          setCursor('pointer');
          return;
        }
      }

      if (node) {
        if (tool === 'connect') {
          if (node.payload.locked === true) {
            setHoveredNodeId(node.id);
            setCursor('not-allowed');
            onStatusRef.current('对象已锁定，不能作为连线起点');
            return;
          }
          if (
            connectSourceRef.current &&
            connectSourceRef.current.nodeId !== node.id
          ) {
            return;
          }
          const side = nearestAnchorSide(node, world, 12 / currentView.zoom) ?? 'r';
          setConnectSource({ nodeId: node.id, side });
          onSelectionChange({ nodeIds: [node.id], edgeIds: [] });
          onStatusRef.current('再点击目标对象或锚点完成连线');
          return;
        }

        const wasSelected = currentSelection.nodeIds.includes(node.id);
        let nextNodeIds: string[];
        if (event.shiftKey) {
          nextNodeIds = wasSelected
            ? currentSelection.nodeIds.filter((id) => id !== node.id)
            : [...currentSelection.nodeIds, node.id];
        } else if (wasSelected) {
          nextNodeIds = currentSelection.nodeIds;
        } else {
          nextNodeIds = [node.id];
        }
        onSelectionChange({
          nodeIds: nextNodeIds,
          edgeIds: event.shiftKey ? currentSelection.edgeIds : [],
        });
        if (node.payload.locked === true || !nextNodeIds.includes(node.id)) {
          setCursor(node.payload.locked === true ? 'not-allowed' : 'move');
          return;
        }
        onBeginTransaction();
        dragRef.current = {
          kind: 'move',
          ids: nextNodeIds,
          startWorld: world,
          baseDocument: currentDocument,
          moved: false,
        };
        setCursor('grabbing');
        return;
      }

      // 空白处：框选（默认只选节点，Shift 追加并保留已选连线）。
      const additive = event.shiftKey;
      const baseSelection = additive ? currentSelection.nodeIds : [];
      const baseEdgeSelection = additive ? currentSelection.edgeIds : [];
      dragRef.current = {
        kind: 'marquee',
        startWorld: world,
        additive,
        baseSelection,
        baseEdgeSelection,
        moved: false,
      };
      setHoveredNodeId(null);
      setCursor('crosshair');
    },
    [
      hoveredNodeId,
      onApply,
      onBeginTransaction,
      onSelectionChange,
      readOnly,
      setConnectSource,
      tool,
      worldPointOf,
    ],
  );

  const finishPointer = useCallback(
    (cancelled: boolean, clientX: number, clientY: number) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) {
        return;
      }
      if (drag.kind === 'pan') {
        setCursor(readOnly || tool === 'hand' ? 'grab' : 'default');
        return;
      }
      if (drag.kind === 'move' || drag.kind === 'resize') {
        if (cancelled) {
          onUpdateTransient(() => drag.baseDocument);
        }
        onEndTransaction(!cancelled && drag.moved);
        if (!cancelled && drag.moved) {
          onStatusRef.current(
            drag.kind === 'move' ? '位置已更新' : '尺寸已更新',
          );
        }
        return;
      }
      if (drag.kind === 'marquee') {
        setMarquee(null);
        if (cancelled) {
          return;
        }
        if (!drag.moved) {
          onSelectionChange({
            nodeIds: drag.additive ? drag.baseSelection : [],
            edgeIds: drag.additive ? drag.baseEdgeSelection : [],
          });
        }
        return;
      }
      // connect
      setPending(null);
      if (cancelled) {
        setConnectSource(null);
        return;
      }
      const currentDocument = documentRef.current;
      const world = worldPointOf(clientX, clientY);
      const sourceNode = currentDocument.nodes.find(
        (node) => node.id === drag.fromId,
      );
      if (!sourceNode || sourceNode.payload.locked === true) {
        setConnectSource(null);
        onStatusRef.current('对象已锁定，不能作为连线起点');
        return;
      }
      const target = findConnectTarget(
        currentDocument.nodes,
        world,
        14 / viewRef.current.zoom,
      );
      if (!target || target.id === drag.fromId) {
        setConnectSource({ nodeId: drag.fromId, side: drag.fromSide });
        onStatusRef.current('再点击目标对象或锚点完成连线');
        return;
      }
      if (target.payload.locked === true) {
        setConnectSource(null);
        setHoveredNodeId(target.id);
        setCursor('not-allowed');
        onStatusRef.current('对象已锁定，不能连接');
        return;
      }
      const targetSide =
        nearestAnchorSide(target, world, 14 / viewRef.current.zoom) ??
        oppositeSide(drag.fromSide);
      const result = onApply((documentItem) =>
        addConnector(documentItem, drag.fromId, target.id, {
          fromSide: drag.fromSide,
          toSide: targetSide,
        }).document,
      );
      const newEdge = result.edges[result.edges.length - 1] ?? null;
      setConnectSource(null);
      if (newEdge && result.edges.length > currentDocument.edges.length) {
        onSelectionChange({ nodeIds: [], edgeIds: [newEdge.id] });
        onStatusRef.current('已连接，可在右侧检查器改线型/箭头/标签');
      }
    },
    [
      onApply,
      onEndTransaction,
      onSelectionChange,
      onUpdateTransient,
      setConnectSource,
      tool,
      worldPointOf,
    ],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (drag) {
        return;
      }
      const connectSource = connectSourceRef.current;
      if (connectSource) {
        const world = worldPointOf(event.clientX, event.clientY);
        const sourceNode = documentRef.current.nodes.find(
          (node) => node.id === connectSource.nodeId,
        );
        const target = findConnectTarget(
          documentRef.current.nodes,
          world,
          14 / viewRef.current.zoom,
        );
        if (sourceNode) {
          const lockedTarget = target?.payload.locked === true;
          setPending({
            from: sourceNode,
            side: connectSource.side,
            to: world,
            targetId:
              target && target.id !== sourceNode.id && !lockedTarget
                ? target.id
                : null,
          });
          if (lockedTarget) {
            setHoveredNodeId(target.id);
            setCursor('not-allowed');
          }
        }
      }
      updateHover(event.clientX, event.clientY);
    },
    [updateHover, worldPointOf],
  );

  const handlePointerLeave = useCallback(() => {
    if (!dragRef.current && !connectSourceRef.current) {
      setHoveredNodeId(null);
      setCursor(readOnly || tool === 'hand' ? 'grab' : 'default');
    }
  }, [tool]);

  // 拖动期间在 document 上监听，指针移出 canvas 也不中断。
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const currentView = viewRef.current;
      if (drag.kind === 'pan') {
        const dx = event.clientX - drag.startClient.x;
        const dy = event.clientY - drag.startClient.y;
        onViewChangeRef.current({
          ...drag.startView,
          x: drag.startView.x - dx / drag.startView.zoom,
          y: drag.startView.y - dy / drag.startView.zoom,
        });
        return;
      }
      if (drag.kind === 'move') {
        const world = worldPointOf(event.clientX, event.clientY);
        const dx = world.x - drag.startWorld.x;
        const dy = world.y - drag.startWorld.y;
        if (Math.abs(dx) * currentView.zoom + Math.abs(dy) * currentView.zoom > 2) {
          drag.moved = true;
        }
        onUpdateTransient(() =>
          moveObjects(drag.baseDocument, drag.ids, dx, dy, {
            snap: !event.altKey,
          }),
        );
        return;
      }
      if (drag.kind === 'resize') {
        const world = worldPointOf(event.clientX, event.clientY);
        const dx = world.x - drag.startWorld.x;
        const dy = world.y - drag.startWorld.y;
        if (Math.abs(dx) * currentView.zoom + Math.abs(dy) * currentView.zoom > 2) {
          drag.moved = true;
        }
        onUpdateTransient(() =>
          resizeObject(
            drag.baseDocument,
            drag.nodeId,
            drag.baseWidth + dx,
            drag.baseHeight + dy,
          ),
        );
        return;
      }
      if (drag.kind === 'marquee') {
        const world = worldPointOf(event.clientX, event.clientY);
        const rect = normalizeDragRect(drag.startWorld, world);
        if (
          Math.abs(world.x - drag.startWorld.x) * currentView.zoom +
            Math.abs(world.y - drag.startWorld.y) * currentView.zoom >
          3
        ) {
          drag.moved = true;
        }
        setMarquee(rect);
        const hitIds = marqueeNodeIds(documentRef.current.nodes, rect);
        const merged = drag.additive
          ? Array.from(new Set([...drag.baseSelection, ...hitIds]))
          : hitIds;
        onSelectionChange({
          nodeIds: merged,
          edgeIds: drag.additive ? drag.baseEdgeSelection : [],
        });
        return;
      }
      if (drag.kind === 'connect') {
        const world = worldPointOf(event.clientX, event.clientY);
        const sourceNode = documentRef.current.nodes.find(
          (node) => node.id === drag.fromId,
        );
        const target = findConnectTarget(
          documentRef.current.nodes,
          world,
          14 / currentView.zoom,
        );
        const lockedTarget = target?.payload.locked === true;
        const targetId =
          target && target.id !== drag.fromId && !lockedTarget
            ? target.id
            : null;
        drag.targetId = targetId;
        drag.targetSide =
          target && !lockedTarget
            ? nearestAnchorSide(target, world, 14 / currentView.zoom)
            : null;
        if (lockedTarget) {
          setHoveredNodeId(target.id);
          setCursor('not-allowed');
        } else if (targetId) {
          setHoveredNodeId(targetId);
          setCursor('crosshair');
        }
        if (sourceNode) {
          setPending({
            from: sourceNode,
            side: drag.fromSide,
            to: world,
            targetId,
          });
        }
      }
    };
    const onUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      if (drag.kind === 'connect' && drag.targetId) {
        finishPointer(false, event.clientX, event.clientY);
        return;
      }
      finishPointer(false, event.clientX, event.clientY);
    };
    const onCancel = (event: PointerEvent) => {
      if (dragRef.current) {
        finishPointer(true, event.clientX, event.clientY);
      }
    };
    window.document.addEventListener('pointermove', onMove);
    window.document.addEventListener('pointerup', onUp);
    window.document.addEventListener('pointercancel', onCancel);
    return () => {
      window.document.removeEventListener('pointermove', onMove);
      window.document.removeEventListener('pointerup', onUp);
      window.document.removeEventListener('pointercancel', onCancel);
    };
  }, [
    finishPointer,
    onSelectionChange,
    onUpdateTransient,
    worldPointOf,
  ]);

  // -------------------------------------------------------------------------
  // 滚轮缩放/平移、空格抓手
  // -------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const screen = screenPointOf(event.clientX, event.clientY);
      const currentView = viewRef.current;
      if (event.ctrlKey || event.metaKey) {
        const factor = event.deltaY < 0 ? 1.1 : 0.9;
        onViewChangeRef.current(
          zoomAtPoint(currentView, currentView.zoom * factor, screen),
        );
        return;
      }
      if (event.shiftKey) {
        onViewChangeRef.current({
          ...currentView,
          x: currentView.x + event.deltaY / currentView.zoom,
        });
        return;
      }
      onViewChangeRef.current({
        ...currentView,
        y: currentView.y + event.deltaY / currentView.zoom,
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [screenPointOf]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      const tag = target.tagName.toLowerCase();
      return (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        target.isContentEditable
      );
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !isEditableTarget(event.target)) {
        spaceDownRef.current = true;
        setCursor('grab');
      }
      if (event.key === 'Escape') {
        if (connectSourceRef.current) {
          setConnectSource(null);
          onStatusRef.current('已取消连线');
        }
        if (dragRef.current?.kind === 'connect') {
          finishPointer(true, 0, 0);
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        spaceDownRef.current = false;
        setCursor((value) => (value === 'grab' || value === 'grabbing' ? 'default' : value));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [finishPointer, setConnectSource]);

  // -------------------------------------------------------------------------
  // 双击与文字编辑浮层
  // -------------------------------------------------------------------------

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      if (readOnly) {
        return;
      }
      const currentView = viewRef.current;
      const world = worldPointOf(event.clientX, event.clientY);
      const currentDocument = documentRef.current;
      const node = hitTestNode(currentDocument.nodes, world);
      if (node) {
        beginEditing(node);
        return;
      }
      const edge = hitTestConnector(
        currentDocument.edges,
        currentDocument.nodes,
        world,
        10 / currentView.zoom,
      );
      if (edge) {
        onSelectionChange({ nodeIds: [], edgeIds: [edge.id] });
        onRequestEdgeLabelRef.current(edge.id);
      }
    },
    [beginEditing, onSelectionChange, readOnly, worldPointOf],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      if (readOnly) {
        return;
      }
      const currentDocument = documentRef.current;
      const currentSelection = selectionRef.current;
      const currentView = viewRef.current;
      const world = worldPointOf(event.clientX, event.clientY);
      const node = hitTestNode(currentDocument.nodes, world);
      if (node) {
        if (!currentSelection.nodeIds.includes(node.id)) {
          onSelectionChange({ nodeIds: [node.id], edgeIds: [] });
        }
        onContextMenuRequestRef.current({
          x: event.clientX,
          y: event.clientY,
          target: { kind: 'node', nodeId: node.id },
        });
        return;
      }
      const edge = hitTestConnector(
        currentDocument.edges,
        currentDocument.nodes,
        world,
        10 / currentView.zoom,
      );
      if (edge) {
        if (!currentSelection.edgeIds.includes(edge.id)) {
          onSelectionChange({ nodeIds: [], edgeIds: [edge.id] });
        }
        onContextMenuRequestRef.current({
          x: event.clientX,
          y: event.clientY,
          target: { kind: 'edge', edgeId: edge.id },
        });
        return;
      }
      onSelectionChange({ nodeIds: [], edgeIds: [] });
      onContextMenuRequestRef.current({
        x: event.clientX,
        y: event.clientY,
        target: { kind: 'canvas' },
      });
    },
    [onSelectionChange, readOnly, worldPointOf],
  );

  const editingNode = editing
    ? document.nodes.find((node) => node.id === editing.nodeId) ?? null
    : null;
  const editingStyle = editingNode ? objectStyle(editingNode) : null;
  const editingScreen = editingNode
    ? worldToScreen(view, { x: editingNode.x, y: editingNode.y })
    : null;

  const onTextareaChange = (value: string) => {
    const next = editing ? { ...editing, text: value } : null;
    editingRef.current = next;
    setEditingState(next);
  };

  const canvasClassName = [
    'bw-canvas',
    readOnly ? 'is-readonly' : '',
    tool === 'hand' ? 'is-hand' : '',
    connectSource ? 'is-connecting' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="bw-canvas-wrap">
      <canvas
        ref={canvasRef}
        className={canvasClassName}
        style={{ cursor }}
        tabIndex={0}
        role="application"
        aria-label="画板画布"
        aria-describedby="bw-canvas-help"
        data-readonly={readOnly ? 'true' : 'false'}
        data-tool={tool}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      />
      <p id="bw-canvas-help" className="bw-sr-only">
        选择对象后拖动移动，拖右下角手柄缩放，双击改字。从对象四个锚点拖到另一个对象完成连线。
      </p>
      {editingNode && editingScreen && editingStyle ? (
        <textarea
          ref={textareaRef}
          className="bw-text-editor"
          aria-label="编辑对象文字"
          data-node-id={editingNode.id}
          value={editing?.text ?? ''}
          style={{
            left: `${editingScreen.x}px`,
            top: `${editingScreen.y}px`,
            width: `${Math.max(40, editingNode.width * view.zoom)}px`,
            height: `${Math.max(32, editingNode.height * view.zoom)}px`,
            fontSize: `${Math.max(10, editingStyle.fontSize * view.zoom)}px`,
            fontWeight: editingStyle.bold ? 700 : 400,
            textAlign: editingStyle.textAlign,
            color: editingStyle.textColor,
            borderRadius:
              normalizeObjectType(editingNode.type) === 'ellipse'
                ? '50%'
                : `${Math.max(2, editingStyle.radius * view.zoom)}px`,
          }}
          onChange={(event) => onTextareaChange(event.target.value)}
          onBlur={() => finishEditing(false)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              event.stopPropagation();
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              finishEditing(true);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              finishEditing(false);
            }
            event.stopPropagation();
          }}
          onPointerDown={(event) => event.stopPropagation()}
        />
      ) : null}
    </div>
  );
}

