/**
 * 画布右键菜单：复用知识页/编辑器的共享 `ContextMenu`，不调用浏览器原生菜单。
 *
 * ZX7-MENU-02/03 起：
 * - 分组、分隔线、图标槽、快捷键、禁用原因和危险项都由共享模型渲染；
 * - 菜单定位/clamp、方向键/Home/End、Escape 与焦点归还只保留一份实现；
 * - 文案只走 `menu.*` i18n key，不再在画板里维护第二套中文；
 * - 节点菜单不再同时平铺“置顶/置底/上移/下移”和“层级”子菜单。
 *
 * 动作仍复用工作区已有命令，因此右键与工具栏/检查器共享撤销栈与保存逻辑。
 */

import {
  ContextMenu,
  type ContextMenuCloseReason,
  type ContextMenuItem,
} from '../../knowledge/contextMenu';
import { t, type MenuKey } from '../../../i18n/menu';
import type {
  AlignMode,
  BoardLayerDirection,
} from '../model';
import type {
  BoardConnectorStyle,
  BoardContextMenuState,
  BoardDocument,
  BoardSelection,
} from '../types';

export type BoardContextMenuProps = {
  state: BoardContextMenuState;
  document: BoardDocument;
  selection: BoardSelection;
  clipboardAvailable: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onClose: (reason?: ContextMenuCloseReason) => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onFit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onLayer: (direction: BoardLayerDirection) => void;
  onToggleLock: () => void;
  onDelete: () => void;
  onAlign: (mode: AlignMode) => void;
  onDistribute: (axis: 'x' | 'y') => void;
  onReverseEdge: () => void;
  onChangeEdgeStyle: (patch: Partial<BoardConnectorStyle>) => void;
};

const ALIGN_ITEMS: ReadonlyArray<{ mode: AlignMode; key: MenuKey }> = [
  { mode: 'left', key: 'menu.board.alignLeft' },
  { mode: 'hcenter', key: 'menu.board.alignHCenter' },
  { mode: 'right', key: 'menu.board.alignRight' },
  { mode: 'top', key: 'menu.board.alignTop' },
  { mode: 'vcenter', key: 'menu.board.alignVCenter' },
  { mode: 'bottom', key: 'menu.board.alignBottom' },
];

const ROUTING_ITEMS: ReadonlyArray<{
  routing: 'straight' | 'elbow' | 'curve';
  key: MenuKey;
}> = [
  { routing: 'straight' as const, key: 'menu.board.routingStraight' },
  { routing: 'elbow' as const, key: 'menu.board.routingElbow' },
  { routing: 'curve' as const, key: 'menu.board.routingCurve' },
];

export function BoardContextMenu({
  state,
  document,
  selection,
  clipboardAvailable,
  canUndo,
  canRedo,
  onClose,
  onCopy,
  onPaste,
  onSelectAll,
  onFit,
  onUndo,
  onRedo,
  onLayer,
  onToggleLock,
  onDelete,
  onAlign,
  onDistribute,
  onReverseEdge,
  onChangeEdgeStyle,
}: BoardContextMenuProps) {
  const selectedNodeIds = new Set(selection.nodeIds);
  const selectedEdgeIds = new Set(selection.edgeIds);
  const selectedNodes = document.nodes.filter((node) =>
    selectedNodeIds.has(node.id),
  );
  const selectedEdges = document.edges.filter((edge) =>
    selectedEdgeIds.has(edge.id),
  );
  const nodeCount = selectedNodes.length;
  const edgeCount = selectedEdges.length;
  const multi = nodeCount + edgeCount > 1;
  const allLocked =
    nodeCount > 0 &&
    selectedNodes.every((node) => node.payload.locked === true);
  const commonRouting =
    edgeCount > 0 &&
    selectedEdges.every(
      (edge) => edge.style.routing === selectedEdges[0].style.routing,
    )
      ? (selectedEdges[0].style.routing as string | undefined)
      : undefined;

  /** 共享菜单在执行 `onSelect` 前统一按 `select` 关闭，这里只跑动作。 */
  const run = (action: () => void) => () => {
    action();
  };

  const routingSubmenu = (): ContextMenuItem => ({
    id: 'routing',
    labelKey: 'menu.board.routing',
    icon: '⌁',
    submenu: ROUTING_ITEMS.map((item) => ({
      id: `routing-${item.routing}`,
      labelKey: item.key,
      role: 'menuitemradio' as const,
      checked: commonRouting === item.routing,
      onSelect: run(() => onChangeEdgeStyle({ routing: item.routing })),
    })),
  });

  const alignSubmenu = (): ContextMenuItem => ({
    id: 'align',
    labelKey: 'menu.board.align',
    icon: '⇹',
    disabled: nodeCount < 2,
    submenu: ALIGN_ITEMS.map((item) => ({
      id: `align-${item.mode}`,
      labelKey: item.key,
      onSelect: run(() => onAlign(item.mode)),
    })),
  });

  const distributeSubmenu = (): ContextMenuItem => ({
    id: 'distribute',
    labelKey: 'menu.board.distribute',
    icon: '↔',
    disabled: nodeCount < 3,
    submenu: [
      {
        id: 'distribute-x',
        labelKey: 'menu.board.distributeX',
        onSelect: run(() => onDistribute('x')),
      },
      {
        id: 'distribute-y',
        labelKey: 'menu.board.distributeY',
        onSelect: run(() => onDistribute('y')),
      },
    ],
  });

  const layerSubmenu = (): ContextMenuItem => ({
    id: 'layer',
    labelKey: 'menu.board.layer',
    icon: '▤',
    disabled: nodeCount === 0,
    submenu: [
      {
        id: 'layer-front',
        labelKey: 'menu.board.layerFront',
        onSelect: run(() => onLayer('front')),
      },
      {
        id: 'layer-up',
        labelKey: 'menu.board.layerUp',
        onSelect: run(() => onLayer('up')),
      },
      {
        id: 'layer-down',
        labelKey: 'menu.board.layerDown',
        onSelect: run(() => onLayer('down')),
      },
      {
        id: 'layer-back',
        labelKey: 'menu.board.layerBack',
        onSelect: run(() => onLayer('back')),
      },
    ],
  });

  const lockItem = (): ContextMenuItem => ({
    id: 'lock',
    labelKey: allLocked ? 'menu.board.unlock' : 'menu.board.lock',
    icon: '⌾',
    disabled: nodeCount === 0,
    onSelect: run(onToggleLock),
  });

  let items: ContextMenuItem[] = [];
  if (state.target.kind === 'canvas') {
    items = [
      {
        id: 'paste',
        labelKey: 'menu.board.paste',
        icon: '⇩',
        shortcut: 'Mod+V',
        disabled: !clipboardAvailable,
        hintKey: 'menu.hint.clipboardEmpty',
        onSelect: run(onPaste),
      },
      {
        id: 'select-all',
        labelKey: 'menu.board.selectAll',
        icon: '▣',
        shortcut: 'Mod+A',
        disabled: document.nodes.length === 0 && document.edges.length === 0,
        onSelect: run(onSelectAll),
      },
      {
        id: 'fit',
        labelKey: 'menu.board.fit',
        icon: '⛶',
        shortcut: 'Shift+1',
        onSelect: run(onFit),
      },
      { divider: true },
      {
        id: 'undo',
        labelKey: 'menu.board.undo',
        icon: '↶',
        shortcut: 'Mod+Z',
        disabled: !canUndo,
        hintKey: 'menu.hint.noUndo',
        onSelect: run(onUndo),
      },
      {
        id: 'redo',
        labelKey: 'menu.board.redo',
        icon: '↷',
        shortcut: 'Mod+Shift+Z',
        disabled: !canRedo,
        hintKey: 'menu.hint.noRedo',
        onSelect: run(onRedo),
      },
    ];
  } else if (state.target.kind === 'edge' && nodeCount === 0) {
    items = [
      {
        heading: t('menu.board.label.edge', { count: edgeCount }),
      },
      routingSubmenu(),
      ...(edgeCount === 1
        ? [
            {
              id: 'reverse',
              labelKey: 'menu.board.reverse',
              icon: '⇄',
              onSelect: run(onReverseEdge),
            } satisfies ContextMenuItem,
          ]
        : []),
      { divider: true },
      {
        id: 'delete-edge',
        label:
          edgeCount > 1
            ? t('menu.board.deleteSelection', { count: edgeCount })
            : t('menu.board.deleteEdge'),
        icon: '⌫',
        shortcut: 'Delete',
        danger: true,
        onSelect: run(onDelete),
      },
    ];
  } else if (state.target.kind === 'node' && !multi) {
    items = [
      {
        id: 'copy',
        labelKey: 'menu.board.copy',
        icon: '⧉',
        shortcut: 'Mod+C',
        disabled: nodeCount === 0,
        onSelect: run(onCopy),
      },
      {
        id: 'paste',
        labelKey: 'menu.board.paste',
        icon: '⇩',
        shortcut: 'Mod+V',
        disabled: !clipboardAvailable,
        hintKey: 'menu.hint.clipboardEmpty',
        onSelect: run(onPaste),
      },
      { divider: true },
      layerSubmenu(),
      lockItem(),
      { divider: true },
      {
        id: 'delete',
        labelKey: 'menu.board.delete',
        icon: '⌫',
        shortcut: 'Delete',
        danger: true,
        onSelect: run(onDelete),
      },
    ];
  } else {
    items = [
      {
        heading: t('menu.board.label.multi', {
          nodeCount,
          edgeCount,
        }),
      },
      {
        id: 'copy',
        labelKey: 'menu.board.copy',
        icon: '⧉',
        shortcut: 'Mod+C',
        disabled: nodeCount === 0,
        onSelect: run(onCopy),
      },
      {
        id: 'paste',
        labelKey: 'menu.board.paste',
        icon: '⇩',
        shortcut: 'Mod+V',
        disabled: !clipboardAvailable,
        hintKey: 'menu.hint.clipboardEmpty',
        onSelect: run(onPaste),
      },
      alignSubmenu(),
      distributeSubmenu(),
      layerSubmenu(),
      lockItem(),
      ...(edgeCount > 0 ? [routingSubmenu()] : []),
      ...(edgeCount === 1
        ? [
            {
              id: 'reverse',
              labelKey: 'menu.board.reverse',
              icon: '⇄',
              onSelect: run(onReverseEdge),
            } satisfies ContextMenuItem,
          ]
        : []),
      { divider: true },
      {
        id: 'delete',
        label: t('menu.board.deleteSelection', {
          count: nodeCount + edgeCount,
        }),
        icon: '⌫',
        shortcut: 'Delete',
        danger: true,
        onSelect: run(onDelete),
      },
    ];
  }

  return (
    <ContextMenu
      x={state.x}
      y={state.y}
      label={t('menu.label.board')}
      items={items}
      focusOnOpen={false}
      softDisabled
      className="bw-context-menu"
      onClose={(reason) => onClose(reason)}
    />
  );
}
