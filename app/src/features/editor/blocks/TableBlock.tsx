import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  ClipboardEvent as ReactClipboardEvent,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import type { EditorBlock } from '../../../data/repositories/blocks';
import { tableToHtml, tableToMarkdown } from '../blockHtml';
import {
  TOOLBAR_HOVER_HIDE_MS,
  getFloatingLayer,
  useAnchoredToolbar,
  type ToolbarAnchor,
} from '../toolbarPlacement';
import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu';
import {
  TABLE_DEFAULT_COL_WIDTH,
  TABLE_MAX_COLUMNS,
  TABLE_MAX_COL_WIDTH,
  TABLE_MAX_ROWS,
  TABLE_MIN_COL_WIDTH,
  blockTableModel,
  tableAnchorAt,
  tablePayloadRows,
  type TableCell,
  type TableModel,
  type TextAlign,
} from '../types';

type TableBlockProps = {
  block: EditorBlock;
  readOnly: boolean;
  /** cell 仅单元格文本提交时传入，用于把连续输入合并成一步历史。 */
  onChange: (
    rows: TableCell[][],
    cell?: { row: number; column: number },
  ) => void;
  /**
   * 编辑器右键菜单是否正打开该表格。受控时工具条隐藏；独立渲染
   * （例如单测直接挂 TableBlock）不传，仍由组件内部右键状态兜底。
   */
  contextMenuOpen?: boolean;
  /** 右键在表格非文本选区时回调；菜单本身由编辑器统一渲染。 */
  onContextMenu?: (state: TableContextMenuState) => void;
};

type CellCoord = { row: number; column: number };

type Selection = {
  anchor: CellCoord;
  focus: CellCoord;
};

type SelectionRect = {
  top: number;
  left: number;
  bottom: number;
  right: number;
  height: number;
  width: number;
  area: number;
};

export type TableExportMode = 'markdown' | 'html';

/**
 * 表格右键菜单需要的实时状态与动作。动作在编辑器菜单项被点击时执行，
 * 因此都通过 ref 读取最新选区，避免「右键先建立选区 → 菜单闭包仍是旧值」。
 */
export type TableContextMenuState = {
  x: number;
  y: number;
  readOnly: boolean;
  rowCount: number;
  columnCount: number;
  hasSelection: boolean;
  selectionSize: { rows: number; columns: number } | null;
  canMerge: boolean;
  hasMerge: boolean;
  canInsertRow: boolean;
  canInsertColumn: boolean;
  canRemoveRow: boolean;
  canRemoveColumn: boolean;
  header: boolean;
  align: TextAlign;
  actions: {
    cutSelection: () => void;
    copySelection: () => void;
    paste: () => void;
    merge: () => void;
    split: () => void;
    insertRow: (mode: 'above' | 'below') => void;
    insertColumn: (mode: 'left' | 'right') => void;
    removeRow: () => void;
    removeColumn: () => void;
    setAlign: (align: TextAlign) => void;
    toggleHeader: () => void;
    averageWidths: () => void;
    resetColumnWidth: () => void;
    clearSelection: () => void;
    exportTable: (mode: TableExportMode) => void;
    copyExport: (mode: TableExportMode) => void;
    restoreFocus: () => void;
  };
};

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

const ALIGN_OPTIONS: ReadonlyArray<{ value: TextAlign; label: string }> = [
  { value: 'left', label: '左' },
  { value: 'center', label: '中' },
  { value: 'right', label: '右' },
];

/** 状态气泡停留时间（ZX6 第六轮 §5.3）。 */
const MESSAGE_DURATION_MS = 1600;

function cellKey(row: number, column: number): string {
  return `${row}:${column}`;
}

function clampColumnWidth(value: number): number {
  return Math.max(
    TABLE_MIN_COL_WIDTH,
    Math.min(TABLE_MAX_COL_WIDTH, Math.round(value)),
  );
}

function emptyCell(): TableCell {
  return {
    text: '',
    align: 'left',
    rowSpan: 1,
    colSpan: 1,
    covered: false,
  };
}

function coveredCell(): TableCell {
  return {
    text: '',
    align: 'left',
    rowSpan: 1,
    colSpan: 1,
    covered: true,
  };
}

function cloneTable(model: TableModel): TableModel {
  return {
    schemaVersion: 2,
    header: model.header,
    widths: [...model.widths],
    rows: model.rows.map((row) => row.map((cell) => ({ ...cell }))),
  };
}

function selectionRectOf(selection: Selection | null): SelectionRect | null {
  if (!selection) {
    return null;
  }
  const top = Math.min(selection.anchor.row, selection.focus.row);
  const bottom = Math.max(selection.anchor.row, selection.focus.row);
  const left = Math.min(selection.anchor.column, selection.focus.column);
  const right = Math.max(selection.anchor.column, selection.focus.column);
  return {
    top,
    left,
    bottom,
    right,
    height: bottom - top + 1,
    width: right - left + 1,
    area: (bottom - top + 1) * (right - left + 1),
  };
}

function inRect(row: number, column: number, rect: SelectionRect | null) {
  return Boolean(
    rect &&
      row >= rect.top &&
      row <= rect.bottom &&
      column >= rect.left &&
      column <= rect.right,
  );
}

function anchorList(model: TableModel): CellCoord[] {
  const coordinates: CellCoord[] = [];
  model.rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      if (!cell.covered) {
        coordinates.push({ row: rowIndex, column: columnIndex });
      }
    });
  });
  return coordinates;
}

function firstAnchorInRow(model: TableModel, row: number): CellCoord | null {
  const cells = model.rows[row];
  if (!cells) {
    return null;
  }
  for (let column = 0; column < cells.length; column += 1) {
    if (!cells[column].covered) {
      return { row, column };
    }
  }
  return null;
}

function tableIsEmpty(model: TableModel): boolean {
  return model.rows.every((row) =>
    row.every((cell) => cell.covered || cell.text.trim() === ''),
  );
}

function tsvForRect(model: TableModel, rect: SelectionRect): string {
  const lines: string[] = [];
  for (let row = rect.top; row <= rect.bottom; row += 1) {
    const cells: string[] = [];
    for (let column = rect.left; column <= rect.right; column += 1) {
      const cell = model.rows[row]?.[column];
      cells.push(
        !cell || cell.covered ? '' : cell.text.replace(/\r?\n/g, ' '),
      );
    }
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

/** 选区 HTML：按逻辑坐标展开合并，只复制用户选中的矩形。 */
function htmlForRect(model: TableModel, rect: SelectionRect): string {
  const rows: TableCell[][] = [];
  for (let row = rect.top; row <= rect.bottom; row += 1) {
    const cells: TableCell[] = [];
    for (let column = rect.left; column <= rect.right; column += 1) {
      const anchor = tableAnchorAt(model, row, column);
      cells.push({
        text: anchor?.cell.text ?? '',
        align: anchor?.cell.align ?? 'left',
        rowSpan: 1,
        colSpan: 1,
        covered: false,
      });
    }
    rows.push(cells);
  }
  return tableToHtml(
    {
      schemaVersion: 2,
      header: false,
      widths: Array.from(
        { length: rect.width },
        () => TABLE_DEFAULT_COL_WIDTH,
      ),
      rows,
    },
    { className: 'zx-table' },
  );
}

/** 在 `at` 行前插入一行；若插入点落在纵向合并内部，锚点 rowSpan +1。 */
function insertRowAt(model: TableModel, at: number): CellCoord {
  const width = model.widths.length;
  const crossing: TableCell[] = [];
  const seen = new Set<TableCell>();
  model.rows.forEach((row, rowIndex) => {
    row.forEach((cell) => {
      if (
        !cell.covered &&
        cell.rowSpan > 1 &&
        rowIndex < at &&
        rowIndex + cell.rowSpan > at &&
        !seen.has(cell)
      ) {
        seen.add(cell);
        crossing.push(cell);
      }
    });
  });

  const newRow = Array.from({ length: width }, emptyCell);
  for (const anchor of crossing) {
    anchor.rowSpan += 1;
  }
  // 合并区域跨过插入线时，新行对应列必须是 covered。
  model.rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      if (cell.covered || cell.rowSpan < 2) {
        return;
      }
      if (rowIndex < at && rowIndex + cell.rowSpan > at) {
        for (
          let column = columnIndex;
          column < columnIndex + cell.colSpan && column < width;
          column += 1
        ) {
          newRow[column] = coveredCell();
        }
      }
    });
  });

  model.rows.splice(at, 0, newRow);
  return firstAnchorInRow(model, at) ?? { row: at, column: 0 };
}

/** 在 `at` 列前插入一列；若插入点落在横向合并内部，锚点 colSpan +1。 */
function insertColumnAt(model: TableModel, at: number): CellCoord {
  const seen = new Set<TableCell>();
  const crossing: Array<{ cell: TableCell; row: number; column: number }> =
    [];
  model.rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      if (
        !cell.covered &&
        cell.colSpan > 1 &&
        columnIndex < at &&
        columnIndex + cell.colSpan > at &&
        !seen.has(cell)
      ) {
        seen.add(cell);
        crossing.push({ cell, row: rowIndex, column: columnIndex });
      }
    });
  });
  for (const item of crossing) {
    item.cell.colSpan += 1;
  }
  model.rows.forEach((row, rowIndex) => {
    const isCovered = crossing.some(
      (item) =>
        item.row <= rowIndex && rowIndex < item.row + item.cell.rowSpan,
    );
    row.splice(at, 0, isCovered ? coveredCell() : emptyCell());
  });
  model.widths.splice(at, 0, TABLE_DEFAULT_COL_WIDTH);
  return { row: 0, column: at };
}

export function TableBlock({
  block,
  readOnly,
  onChange,
  contextMenuOpen,
  onContextMenu,
}: TableBlockProps) {
  const tableState = useMemo(() => blockTableModel(block), [block]);
  const model = tableState.model;
  const rows = model.rows;
  const columnCount = model.widths.length;

  const [selection, setSelection] = useState<Selection | null>(null);
  const [pendingFocus, setPendingFocus] = useState<CellCoord | null>(null);
  const [message, setMessage] = useState<{ text: string } | null>(null);
  const announce = useCallback((text: string | null) => {
    // 每次都生成新对象，相同文案也能重新计时。
    setMessage(text === null ? null : { text });
  }, []);
  const [exportMode, setExportMode] = useState<'none' | 'markdown' | 'html'>(
    'none',
  );
  const [liveWidths, setLiveWidths] = useState<number[] | null>(null);
  const [copyState, setCopyState] = useState('');
  const [localContextMenuOpen, setLocalContextMenuOpen] = useState(false);
  /**
   * 属性/工具条默认不渲染；单元格聚焦、hover 轻提示或「更多」菜单打开时
   * 才浮出。选区本身不再单独维持可见：失焦/点外部后必须隐藏
   *（ZX7-TOOLBAR-01 §4.3）。
   */
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  /** 最近获得焦点的单元格：工具条锚点跟随它的 caret，而不是表格外壳。 */
  const [focusedCell, setFocusedCell] = useState<CellCoord | null>(null);
  /** 输入/方向键/选区变化时自增，驱动工具条在 React 提交后重新测量。 */
  const [caretTick, setCaretTick] = useState(0);
  /** 对齐等单元格动作的禁用说明（ZX6-TABLE-02）。 */
  const alignHintId = useId();
  const widths = liveWidths ?? model.widths;

  const wrapRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLPreElement>(null);
  const cellRefs = useRef(new Map<string, HTMLInputElement>());
  const draggingSelectionRef = useRef(false);
  const selectionRef = useRef<Selection | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const resizeRef = useRef<{
    column: number;
    startX: number;
    startWidth: number;
    widths: number[];
  } | null>(null);
  const liveWidthsRef = useRef<number[] | null>(null);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  const rect = selectionRectOf(selection);
  const activeAnchor = tableAnchorAt(
    model,
    selection?.focus.row ?? 0,
    selection?.focus.column ?? 0,
  );
  const activeAlign = activeAnchor?.cell.align ?? 'left';
  const empty = tableIsEmpty(model);
  /** 工具条在单元格聚焦 / hover 轻提示 / 「更多」菜单打开时浮出；右键菜单打开时不叠加。 */
  const menuOpen = contextMenuOpen ?? localContextMenuOpen;
  const toolbarVisible =
    !readOnly &&
    !menuOpen &&
    (focusWithin || hovered || moreMenuOpen);

  const bumpCaret = useCallback(() => {
    setCaretTick((tick) => tick + 1);
  }, []);

  /**
   * 计算工具条锚点：
   * - 多选：所有选中单元格的视口包围盒（右上角即锚点边）；
   * - 单元格聚焦：焦点单元格的 `getBoundingClientRect()`；
   * - 仅 hover：表格本身的右上角，只作概览，不冒充 caret。
   */
  const getToolbarAnchor = useCallback((): ToolbarAnchor | null => {
    const wrap = wrapRef.current;
    if (!wrap) {
      return null;
    }
    const wrapRect = wrap.getBoundingClientRect();
    const area = selectionRectOf(selection);
    const focus = focusedCell ?? selection?.focus ?? null;

    if (focusWithin && area) {
      if (area.area > 1) {
        let left = Number.POSITIVE_INFINITY;
        let top = Number.POSITIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        for (let row = area.top; row <= area.bottom; row += 1) {
          for (let column = area.left; column <= area.right; column += 1) {
            const cell = wrap.querySelector<HTMLElement>(
              `[data-row="${row}"][data-column="${column}"]`,
            );
            if (!cell) {
              continue;
            }
            const bounds = cell.getBoundingClientRect();
            if (bounds.width === 0 && bounds.height === 0) {
              continue;
            }
            left = Math.min(left, bounds.left);
            top = Math.min(top, bounds.top);
            right = Math.max(right, bounds.right);
            bottom = Math.max(bottom, bounds.bottom);
          }
        }
        if (Number.isFinite(left)) {
          return {
            rect: {
              left,
              top,
              right,
              bottom,
              width: right - left,
              height: bottom - top,
            },
            contentLeft: wrapRect.left,
          };
        }
      }
      if (focus) {
        const input = cellRefs.current.get(cellKey(focus.row, focus.column));
        const cell =
          input ??
          wrap.querySelector<HTMLElement>(
            `[data-row="${focus.row}"][data-column="${focus.column}"]`,
          );
        if (cell) {
          return {
            rect: cell.getBoundingClientRect(),
            contentLeft: wrapRect.left,
          };
        }
      }
    }

    const table = wrap.querySelector<HTMLElement>('.zxe-table') ?? wrap;
    return {
      rect: table.getBoundingClientRect(),
      contentLeft: wrapRect.left,
    };
  }, [focusWithin, focusedCell, selection]);

  const selectionSignature = selection
    ? `${selection.anchor.row}:${selection.anchor.column}>${selection.focus.row}:${selection.focus.column}`
    : 'none';
  const toolbar = useAnchoredToolbar({
    open: toolbarVisible,
    getAnchor: getToolbarAnchor,
    signature: `${caretTick}|${focusWithin ? 1 : 0}|${hovered ? 1 : 0}|${moreMenuOpen ? 1 : 0}|${selectionSignature}|${widths.join(',')}`,
  });
  const toolbarBelow = toolbar.placement?.side === 'bottom';

  const showHover = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHovered(true);
  }, []);

  /** 指针跨到 body 上的 portal 工具条时给 120ms 缓冲，避免工具条先卸载。 */
  const hideHoverSoon = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      setHovered(false);
    }, TOOLBAR_HOVER_HIDE_MS);
  }, []);

  useEffect(
    () => () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    },
    [],
  );

  // 光标在单元格内移动（方向键、鼠标拖选、输入）时重新测量 caret 锚点。
  useEffect(() => {
    if (!focusWithin || readOnly) {
      return;
    }
    const onSelectionChange = () => {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active.classList.contains('zxe-table-cell') &&
        wrapRef.current?.contains(active)
      ) {
        bumpCaret();
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () =>
      document.removeEventListener('selectionchange', onSelectionChange);
  }, [focusWithin, readOnly, bumpCaret]);

  const commit = useCallback(
    (next: TableModel, cell?: CellCoord) => {
      onChange(
        tablePayloadRows(next),
        cell ? { row: cell.row, column: cell.column } : undefined,
      );
    },
    [onChange],
  );

  /** 动作执行时读取最新选区：右键会先建立选区，菜单闭包不能依赖旧 render。 */
  const rectNow = () => selectionRectOf(selectionRef.current);
  const activeAnchorNow = () => {
    const focus = selectionRef.current?.focus;
    return tableAnchorAt(model, focus?.row ?? 0, focus?.column ?? 0);
  };

  useEffect(() => {
    if (readOnly) {
      setSelection(null);
      selectionRef.current = null;
      setExportMode('none');
      setLocalContextMenuOpen(false);
      setHovered(false);
      setFocusWithin(false);
      setMoreMenuOpen(false);
      setFocusedCell(null);
    }
  }, [readOnly]);

  useEffect(() => {
    if (!message) {
      return;
    }
    const timer = window.setTimeout(() => announce(null), MESSAGE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [announce, message]);

  // 点击表格外清空选区，工具条随之隐藏；表格内点击保持选区。
  useEffect(() => {
    if (readOnly || !selection) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const wrap = wrapRef.current;
      const target = event.target;
      if (
        wrap &&
        target instanceof Node &&
        wrap.contains(target)
      ) {
        return;
      }
      // 菜单与工具条挂在 body 的 portal 上，点它们不算“离开表格”。
      if (
        target instanceof Element &&
        (target.closest('.zxe-overflow-menu, .zxe-context-menu') ||
          toolbar.ref.current?.contains(target))
      ) {
        return;
      }
      setSelection(null);
      selectionRef.current = null;
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () =>
      document.removeEventListener('pointerdown', onPointerDown, true);
  }, [readOnly, selection]);

  // 独立渲染时（没有编辑器受控菜单）右键仍隐藏工具条；下一次交互恢复。
  useEffect(() => {
    if (contextMenuOpen !== undefined || !localContextMenuOpen) {
      return;
    }
    const close = () => setLocalContextMenuOpen(false);
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', close, true);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', close, true);
      document.removeEventListener('scroll', close, true);
    };
  }, [contextMenuOpen, localContextMenuOpen]);

  useEffect(() => {
    if (!pendingFocus) {
      return;
    }
    const input = cellRefs.current.get(
      cellKey(pendingFocus.row, pendingFocus.column),
    );
    if (input) {
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
      setPendingFocus(null);
    }
  }, [pendingFocus, block]);

  useEffect(() => {
    const onMouseUp = () => {
      draggingSelectionRef.current = false;
    };
    window.addEventListener('mouseup', onMouseUp);
    return () => window.removeEventListener('mouseup', onMouseUp);
  }, []);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const drag = resizeRef.current;
      if (!drag) {
        return;
      }
      const next = [...drag.widths];
      next[drag.column] = clampColumnWidth(
        drag.startWidth + event.clientX - drag.startX,
      );
      liveWidthsRef.current = next;
      setLiveWidths(next);
    };
    const onUp = () => {
      const drag = resizeRef.current;
      if (!drag) {
        return;
      }
      const next = liveWidthsRef.current;
      resizeRef.current = null;
      liveWidthsRef.current = null;
      setLiveWidths(null);
      if (next) {
        const nextModel = cloneTable(model);
        nextModel.widths = next;
        commit(nextModel);
        announce(
          `第 ${drag.column + 1} 列列宽 ${next[drag.column]}px`,
        );
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [commit, model]);

  const focusCell = (coord: CellCoord) => {
    setSelection({ anchor: coord, focus: coord });
    setPendingFocus(coord);
  };

  const updateCell = (
    rowIndex: number,
    columnIndex: number,
    value: string,
  ) => {
    const next = cloneTable(model);
    const anchor = tableAnchorAt(next, rowIndex, columnIndex);
    if (!anchor) {
      return;
    }
    anchor.cell.text = value;
    commit(next, { row: anchor.row, column: anchor.column });
  };

  const toggleHeader = () => {
    const next = cloneTable(model);
    next.header = !next.header;
    commit(next);
    announce(next.header ? '表头已开启' : '表头已关闭');
  };

  const setAlign = (align: TextAlign) => {
    const area = rectNow();
    if (!area) {
      // 无选区时不静默修改第一个单元格。
      announce('请先选择单元格');
      return;
    }
    const next = cloneTable(model);
    const targets = new Set<TableCell>();
    for (let row = area.top; row <= area.bottom; row += 1) {
      for (let column = area.left; column <= area.right; column += 1) {
        const anchor = tableAnchorAt(next, row, column);
        if (anchor) {
          targets.add(anchor.cell);
        }
      }
    }
    if (targets.size === 0) {
      announce('请先选择单元格');
      return;
    }
    for (const cell of targets) {
      cell.align = align;
    }
    commit(next);
    announce(
      `已${align === 'left' ? '左' : align === 'center' ? '中' : '右'}对齐 ${targets.size} 个单元格`,
    );
  };

  const insertRow = (mode: 'above' | 'below') => {
    if (rows.length >= TABLE_MAX_ROWS) {
      announce(`表格最多 ${TABLE_MAX_ROWS} 行`);
      return;
    }
    const area = rectNow();
    const anchor = activeAnchorNow();
    const base = area
      ? mode === 'above'
        ? area.top
        : area.bottom + 1
      : mode === 'above'
        ? anchor?.row ?? 0
        : (anchor?.row ?? 0) + 1;
    const at = Math.max(0, Math.min(rows.length, base));
    const next = cloneTable(model);
    const target = insertRowAt(next, at);
    commit(next);
    setSelection({ anchor: target, focus: target });
    setPendingFocus(target);
    announce(mode === 'above' ? '已在上方插入行' : '已在下方插入行');
  };

  const insertColumn = (mode: 'left' | 'right') => {
    if (columnCount >= TABLE_MAX_COLUMNS) {
      announce(`表格最多 ${TABLE_MAX_COLUMNS} 列`);
      return;
    }
    const area = rectNow();
    const anchor = activeAnchorNow();
    const base = area
      ? mode === 'left'
        ? area.left
        : area.right + 1
      : mode === 'left'
        ? anchor?.column ?? 0
        : (anchor?.column ?? 0) + 1;
    const at = Math.max(0, Math.min(columnCount, base));
    const next = cloneTable(model);
    insertColumnAt(next, at);
    const focusRow = Math.min(
      selectionRef.current?.focus.row ?? 0,
      next.rows.length - 1,
    );
    const target =
      firstAnchorInRow(next, focusRow) ?? { row: focusRow, column: at };
    commit(next);
    setSelection({ anchor: target, focus: target });
    setPendingFocus(target);
    announce(mode === 'left' ? '已在左侧插入列' : '已在右侧插入列');
  };

  const removeRow = () => {
    if (rows.length <= 1) {
      announce('至少保留 1 行');
      return;
    }
    const area = rectNow();
    const anchor = activeAnchorNow();
    const rowIndex = Math.max(
      0,
      Math.min(rows.length - 1, area?.top ?? anchor?.row ?? 0),
    );
    const crossing = rows.some(
      (row, r) =>
        r < rows.length &&
        row.some(
          (cell) =>
            !cell.covered &&
            cell.rowSpan > 1 &&
            r <= rowIndex &&
            rowIndex < r + cell.rowSpan,
        ),
    );
    if (crossing) {
      announce('该行包含合并单元格，请先拆分');
      return;
    }
    const next = cloneTable(model);
    next.rows.splice(rowIndex, 1);
    commit(next);
    const targetRow = Math.min(rowIndex, next.rows.length - 1);
    const target =
      firstAnchorInRow(next, targetRow) ?? { row: targetRow, column: 0 };
    setSelection({ anchor: target, focus: target });
    setPendingFocus(target);
    announce('已删除行');
  };

  const removeColumn = () => {
    if (columnCount <= 1) {
      announce('至少保留 1 列');
      return;
    }
    const area = rectNow();
    const anchor = activeAnchorNow();
    const columnIndex = Math.max(
      0,
      Math.min(columnCount - 1, area?.left ?? anchor?.column ?? 0),
    );
    const crossing = rows.some((row) =>
      row.some(
        (cell, c) =>
          !cell.covered &&
          cell.colSpan > 1 &&
          c <= columnIndex &&
          columnIndex < c + cell.colSpan,
      ),
    );
    if (crossing) {
      announce('该列包含合并单元格，请先拆分');
      return;
    }
    const next = cloneTable(model);
    for (const row of next.rows) {
      row.splice(columnIndex, 1);
    }
    next.widths.splice(columnIndex, 1);
    commit(next);
    const targetRow = Math.min(
      selectionRef.current?.focus.row ?? 0,
      next.rows.length - 1,
    );
    const target =
      firstAnchorInRow(next, targetRow) ?? { row: targetRow, column: 0 };
    setSelection({ anchor: target, focus: target });
    setPendingFocus(target);
    announce('已删除列');
  };

  const mergeSelection = () => {
    const area = rectNow();
    if (!area || area.area < 2) {
      announce('请先选择至少 2 个单元格再合并');
      return;
    }
    const conflicts: string[] = [];
    rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        if (cell.covered) {
          return;
        }
        const intersects =
          rowIndex <= area.bottom &&
          rowIndex + cell.rowSpan - 1 >= area.top &&
          columnIndex <= area.right &&
          columnIndex + cell.colSpan - 1 >= area.left;
        if (!intersects) {
          return;
        }
        const fullyInside =
          rowIndex >= area.top &&
          rowIndex + cell.rowSpan - 1 <= area.bottom &&
          columnIndex >= area.left &&
          columnIndex + cell.colSpan - 1 <= area.right;
        if (!fullyInside) {
          conflicts.push(cellKey(rowIndex, columnIndex));
        }
      });
    });
    if (conflicts.length > 0) {
      announce('选区包含跨区合并的单元格，请先拆分或调整选区');
      return;
    }
    const next = cloneTable(model);
    const anchor = next.rows[area.top][area.left];
    for (let row = area.top; row <= area.bottom; row += 1) {
      for (let column = area.left; column <= area.right; column += 1) {
        if (row === area.top && column === area.left) {
          continue;
        }
        next.rows[row][column] = coveredCell();
      }
    }
    anchor.rowSpan = area.height;
    anchor.colSpan = area.width;
    anchor.covered = false;
    commit(next);
    announce(`已合并 ${area.area} 个单元格，仅保留左上内容`);
  };

  const splitSelection = () => {
    const current = rectNow();
    const anchor = activeAnchorNow();
    const area = current ?? {
      top: anchor?.row ?? 0,
      left: anchor?.column ?? 0,
      bottom: anchor?.row ?? 0,
      right: anchor?.column ?? 0,
      height: 1,
      width: 1,
      area: 1,
    };
    const targets: Array<{ row: number; column: number }> = [];
    for (let row = area.top; row <= area.bottom; row += 1) {
      for (let column = area.left; column <= area.right; column += 1) {
        const cell = rows[row]?.[column];
        if (cell && !cell.covered && (cell.rowSpan > 1 || cell.colSpan > 1)) {
          targets.push({ row, column });
        }
      }
    }
    if (targets.length === 0) {
      announce('选区内没有合并单元格');
      return;
    }
    const next = cloneTable(model);
    for (const target of targets) {
      const cell = next.rows[target.row][target.column];
      const rowSpan = cell.rowSpan;
      const colSpan = cell.colSpan;
      cell.rowSpan = 1;
      cell.colSpan = 1;
      for (let row = target.row; row < target.row + rowSpan; row += 1) {
        for (let column = target.column; column < target.column + colSpan; column += 1) {
          if (row === target.row && column === target.column) {
            continue;
          }
          next.rows[row][column] = emptyCell();
        }
      }
    }
    commit(next);
    announce(`已拆分 ${targets.length} 个合并区域`);
  };

  const clearSelection = () => {
    const area = rectNow();
    if (!area) {
      announce('请先选择要清空的单元格');
      return;
    }
    const next = cloneTable(model);
    for (let row = area.top; row <= area.bottom; row += 1) {
      for (let column = area.left; column <= area.right; column += 1) {
        const anchor = tableAnchorAt(next, row, column);
        if (anchor) {
          anchor.cell.text = '';
        }
      }
    }
    commit(next);
    announce('已清空选区内容');
  };

  const averageWidths = () => {
    if (columnCount === 0) {
      return;
    }
    const value = clampColumnWidth(Math.max(96, Math.round(640 / columnCount)));
    const next = cloneTable(model);
    next.widths = Array.from({ length: columnCount }, () => value);
    commit(next);
    announce(`已平均列宽 ${value}px`);
  };

  const beginResize = (
    event: ReactMouseEvent<HTMLSpanElement>,
    column: number,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      column,
      startX: event.clientX,
      startWidth: widths[column] ?? TABLE_DEFAULT_COL_WIDTH,
      widths: [...widths],
    };
    liveWidthsRef.current = [...widths];
    setLiveWidths([...widths]);
    announce(null);
  };

  const resetColumnWidthAt = (column: number) => {
    const next = cloneTable(model);
    next.widths[column] = TABLE_DEFAULT_COL_WIDTH;
    commit(next);
    announce(`第 ${column + 1} 列列宽 ${TABLE_DEFAULT_COL_WIDTH}px`);
  };

  const resetWidth = (
    event: ReactMouseEvent<HTMLSpanElement>,
    column: number,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    resetColumnWidthAt(column);
  };

  const resetCurrentColumnWidth = () => {
    const area = rectNow();
    const anchor = activeAnchorNow();
    const column = Math.max(
      0,
      Math.min(
        Math.max(0, columnCount - 1),
        area?.left ?? anchor?.column ?? 0,
      ),
    );
    resetColumnWidthAt(column);
  };

  const selectAll = () => {
    if (rows.length === 0) {
      return;
    }
    setSelection({
      anchor: { row: 0, column: 0 },
      focus: {
        row: rows.length - 1,
        column: Math.max(0, columnCount - 1),
      },
    });
    announce('已选中全部单元格');
  };

  const navigate = (from: CellCoord, delta: number) => {
    const list = anchorList(model);
    const index = list.findIndex(
      (coord) => coord.row === from.row && coord.column === from.column,
    );
    const targetIndex = (index < 0 ? 0 : index) + delta;
    if (targetIndex < 0) {
      return;
    }
    if (targetIndex >= list.length) {
      if (delta > 0 && rows.length < TABLE_MAX_ROWS) {
        const next = cloneTable(model);
        const target = insertRowAt(next, rows.length);
        commit(next);
        setSelection({ anchor: target, focus: target });
        setPendingFocus(target);
        announce('已在末尾追加一行');
      } else if (delta > 0) {
        announce(`表格最多 ${TABLE_MAX_ROWS} 行`);
      }
      return;
    }
    focusCell(list[targetIndex]);
  };

  const moveDown = (from: CellCoord) => {
    const below = from.row + 1;
    if (below >= rows.length) {
      if (rows.length >= TABLE_MAX_ROWS) {
        announce(`表格最多 ${TABLE_MAX_ROWS} 行`);
        return;
      }
      const next = cloneTable(model);
      const target = insertRowAt(next, rows.length);
      commit(next);
      setSelection({ anchor: target, focus: target });
      setPendingFocus(target);
      announce('已在末尾追加一行');
      return;
    }
    const anchor = tableAnchorAt(model, below, from.column);
    if (anchor) {
      focusCell({ row: anchor.row, column: anchor.column });
    }
  };

  const handleCellKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
    row: number,
    column: number,
  ) => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && (event.key === 'a' || event.key === 'A')) {
      event.preventDefault();
      selectAll();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      navigate({ row, column }, event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      moveDown({ row, column });
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setSelection({ anchor: { row, column }, focus: { row, column } });
      return;
    }
    if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      rect &&
      rect.area > 1
    ) {
      event.preventDefault();
      clearSelection();
    }
  };

  const handleCellMouseDown = (
    event: ReactMouseEvent<HTMLTableCellElement>,
    row: number,
    column: number,
  ) => {
    if (readOnly || event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest('.zxe-col-resize')) {
      return;
    }
    if (event.shiftKey && selection) {
      setSelection({ ...selection, focus: { row, column } });
    } else {
      setSelection({ anchor: { row, column }, focus: { row, column } });
    }
    draggingSelectionRef.current = true;
  };

  const handleCellMouseEnter = (row: number, column: number) => {
    if (readOnly || !draggingSelectionRef.current || !selection) {
      return;
    }
    setSelection((current) =>
      current ? { ...current, focus: { row, column } } : current,
    );
    window.getSelection()?.removeAllRanges();
  };

  const fullSelectionRect = (): SelectionRect => ({
    top: 0,
    left: 0,
    bottom: rows.length - 1,
    right: columnCount - 1,
    height: rows.length,
    width: columnCount,
    area: rows.length * columnCount,
  });

  const handleCopy = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (readOnly) {
      return;
    }
    if (!rect || rect.area <= 1) {
      return;
    }
    event.preventDefault();
    event.clipboardData.setData('text/plain', tsvForRect(model, rect));
    event.clipboardData.setData('text/html', htmlForRect(model, rect));
    announce(`已复制 ${rect.height}×${rect.width} 选区`);
  };

  /** 粘贴 TSV/多行文本；原生粘贴和右键菜单「粘贴」共用。 */
  const pasteMatrix = (text: string) => {
    if (readOnly) {
      return;
    }
    const area = rectNow();
    const anchor = activeAnchorNow();
    const start = area
      ? { row: area.top, column: area.left }
      : anchor
        ? { row: anchor.row, column: anchor.column }
        : { row: 0, column: 0 };

    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    const matrix = lines.map((line) => line.split('\t'));
    if (matrix.length === 0) {
      return;
    }
    const wantedRows = matrix.length;
    const wantedColumns = Math.max(...matrix.map((line) => line.length));
    const clippedRows = Math.min(
      wantedRows,
      TABLE_MAX_ROWS - start.row,
    );
    const clippedColumns = Math.min(
      wantedColumns,
      TABLE_MAX_COLUMNS - start.column,
    );

    const next = cloneTable(model);
    const requiredRows = Math.min(
      TABLE_MAX_ROWS,
      Math.max(next.rows.length, start.row + clippedRows),
    );
    while (next.rows.length < requiredRows) {
      next.rows.push(
        Array.from({ length: columnCount }, emptyCell),
      );
    }
    const requiredColumns = Math.min(
      TABLE_MAX_COLUMNS,
      Math.max(columnCount, start.column + clippedColumns),
    );
    while (next.widths.length < requiredColumns) {
      next.widths.push(TABLE_DEFAULT_COL_WIDTH);
      for (const row of next.rows) {
        row.push(emptyCell());
      }
    }

    let pastedRows = 0;
    let pastedColumns = 0;
    for (let rowOffset = 0; rowOffset < clippedRows; rowOffset += 1) {
      const targetRow = start.row + rowOffset;
      for (
        let columnOffset = 0;
        columnOffset < clippedColumns;
        columnOffset += 1
      ) {
        const targetColumn = start.column + columnOffset;
        const target = next.rows[targetRow]?.[targetColumn];
        if (!target || target.covered) {
          continue;
        }
        target.text = matrix[rowOffset][columnOffset] ?? '';
        pastedRows = Math.max(pastedRows, rowOffset + 1);
        pastedColumns = Math.max(pastedColumns, columnOffset + 1);
      }
    }

    commit(next);
    if (pastedRows > 0 && pastedColumns > 0) {
      const nextSelection = {
        anchor: start,
        focus: {
          row: start.row + pastedRows - 1,
          column: start.column + pastedColumns - 1,
        },
      };
      selectionRef.current = nextSelection;
      setSelection(nextSelection);
    }
    const truncated =
      wantedRows > clippedRows || wantedColumns > clippedColumns;
    announce(
      truncated
        ? `已粘贴，超出 ${TABLE_MAX_ROWS}×${TABLE_MAX_COLUMNS} 的部分被截断`
        : `已粘贴 ${pastedRows} 行 × ${pastedColumns} 列`,
    );
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (readOnly) {
      return;
    }
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!/[\t\n\r]/.test(text)) {
      // 单元格内纯文本粘贴交给浏览器原生行为。
      return;
    }
    event.preventDefault();
    pasteMatrix(text);
  };

  const copySelection = async (): Promise<boolean> => {
    const target = rectNow() ?? fullSelectionRect();
    const text = tsvForRect(model, target);
    const ok = await writeClipboardText(text);
    announce(
      ok
        ? `已复制 ${target.height}×${target.width} 选区`
        : '无法写入剪贴板，请用 ⌘C / Ctrl+C 复制',
    );
    return ok;
  };

  const cutSelection = async () => {
    if (!rectNow()) {
      announce('请先选择要剪切的单元格');
      return;
    }
    const ok = await copySelection();
    if (ok) {
      clearSelection();
    }
  };

  const pasteFromClipboard = async () => {
    if (readOnly) {
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        announce('剪贴板为空');
        return;
      }
      pasteMatrix(text);
    } catch {
      announce('无法读取剪贴板，请用 ⌘V / Ctrl+V 粘贴');
    }
  };

  const exportText = useMemo(() => {
    if (exportMode === 'markdown') {
      return tableToMarkdown(model);
    }
    if (exportMode === 'html') {
      return tableToHtml(model, { className: 'zx-table' });
    }
    return '';
  }, [exportMode, model]);

  const copyExport = async () => {
    if (!exportText) {
      return;
    }
    const ok = await writeClipboardText(exportText);
    if (ok) {
      setCopyState('已复制');
      return;
    }
    const node = exportRef.current;
    if (node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selectionApi = window.getSelection();
      selectionApi?.removeAllRanges();
      selectionApi?.addRange(range);
    }
    setCopyState('无法写入剪贴板，请手动复制上方文本');
  };

  const copyTableSource = async (mode: TableExportMode) => {
    const text =
      mode === 'markdown'
        ? tableToMarkdown(model)
        : tableToHtml(model, { className: 'zx-table' });
    const ok = await writeClipboardText(text);
    announce(
      ok
        ? `已复制 ${mode === 'markdown' ? 'Markdown' : 'HTML'} 源码`
        : '无法写入剪贴板，请改用导出预览',
    );
  };

  const openExport = (mode: TableExportMode) => {
    setCopyState('');
    setExportMode(mode);
  };

  const toggleExport = (mode: TableExportMode) => {
    setCopyState('');
    setExportMode((current) => (current === mode ? 'none' : mode));
  };

  const selectionHasMerge = (area = rect): boolean => {
    const effective =
      area ??
      (activeAnchor
        ? {
            top: activeAnchor.row,
            left: activeAnchor.column,
            bottom: activeAnchor.row,
            right: activeAnchor.column,
          }
        : null);
    if (!effective) {
      return false;
    }
    for (let row = effective.top; row <= effective.bottom; row += 1) {
      for (let column = effective.left; column <= effective.right; column += 1) {
        const cell = rows[row]?.[column];
        if (cell && !cell.covered && (cell.rowSpan > 1 || cell.colSpan > 1)) {
          return true;
        }
      }
    }
    return false;
  };

  const isInsideTableUi = (node: Node | null): boolean => {
    if (!node) {
      return false;
    }
    if (wrapRef.current?.contains(node)) {
      return true;
    }
    if (toolbar.ref.current?.contains(node)) {
      return true;
    }
    return (
      node instanceof Element && Boolean(node.closest('.zxe-overflow-menu'))
    );
  };

  const handleWrapBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (isInsideTableUi(next)) {
      return;
    }
    setFocusWithin(false);
  };

  const handleMoreMenuOpenChange = (open: boolean) => {
    setMoreMenuOpen(open);
    if (open) {
      setFocusWithin(true);
      return;
    }
    setFocusWithin(isInsideTableUi(document.activeElement));
  };

  const focusToolbarFirst = () => {
    const first = toolbar.ref.current?.querySelector<HTMLButtonElement>(
      'button:not(:disabled)',
    );
    first?.focus();
  };

  const focusActiveCell = () => {
    const focus = selectionRef.current?.focus;
    const input = focus
      ? cellRefs.current.get(cellKey(focus.row, focus.column))
      : null;
    if (input?.isConnected) {
      input.focus({ preventScroll: true });
      const end = input.value.length;
      input.setSelectionRange(end, end);
      return;
    }
    wrapRef.current?.focus({ preventScroll: true });
  };

  /** Alt+F10 进入工具条；方向键循环，Esc 回单元格（ZX7-DESIGN-01 §4.3）。 */
  const handleToolbarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // React portal 事件沿 React 树冒泡：菜单虽然挂在 body，也会到这里。
    // 菜单自己的键盘逻辑优先，工具条不抢 End/Home/方向键。
    if (
      event.target instanceof Element &&
      event.target.closest('.zxe-overflow-menu')
    ) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      focusActiveCell();
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

  const handleWrapKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey && event.key === 'F10' && toolbarVisible) {
      event.preventDefault();
      focusToolbarFirst();
      return;
    }
    // 工具条 portal 到 body 后，容器上的 Tab 仍应先进入工具条，保持旧焦点顺序。
    if (
      event.key === 'Tab' &&
      !event.shiftKey &&
      event.target === wrapRef.current &&
      toolbarVisible
    ) {
      event.preventDefault();
      focusToolbarFirst();
    }
  };

  const canMerge = Boolean(rect && rect.area >= 2);
  const mergedInSelection = selectionHasMerge();
  const rowLimitReached = rows.length >= TABLE_MAX_ROWS;
  const columnLimitReached = columnCount >= TABLE_MAX_COLUMNS;

  const moreItems: OverflowMenuItem[] = [
    {
      id: 'merge',
      label: '合并选区',
      disabled: !canMerge,
      hint: canMerge ? undefined : '选择至少 2 个单元格',
      onSelect: mergeSelection,
    },
    {
      id: 'split',
      label: '拆分单元格',
      disabled: !mergedInSelection,
      hint: mergedInSelection ? undefined : '选区没有合并单元格',
      onSelect: splitSelection,
    },
    { id: 'separator-cells', separator: true },
    {
      id: 'row-above',
      label: '上方插入行',
      disabled: rowLimitReached,
      hint: rowLimitReached ? `表格最多 ${TABLE_MAX_ROWS} 行` : undefined,
      onSelect: () => insertRow('above'),
    },
    {
      id: 'row-below',
      label: '下方插入行',
      disabled: rowLimitReached,
      hint: rowLimitReached ? `表格最多 ${TABLE_MAX_ROWS} 行` : undefined,
      onSelect: () => insertRow('below'),
    },
    {
      id: 'column-left',
      label: '左侧插入列',
      disabled: columnLimitReached,
      hint: columnLimitReached
        ? `表格最多 ${TABLE_MAX_COLUMNS} 列`
        : undefined,
      onSelect: () => insertColumn('left'),
    },
    {
      id: 'column-right',
      label: '右侧插入列',
      disabled: columnLimitReached,
      hint: columnLimitReached
        ? `表格最多 ${TABLE_MAX_COLUMNS} 列`
        : undefined,
      onSelect: () => insertColumn('right'),
    },
    {
      id: 'row-remove',
      label: '删除当前行',
      disabled: rows.length <= 1,
      hint: rows.length <= 1 ? '至少保留 1 行' : undefined,
      onSelect: removeRow,
    },
    {
      id: 'column-remove',
      label: '删除当前列',
      disabled: columnCount <= 1,
      hint: columnCount <= 1 ? '至少保留 1 列' : undefined,
      onSelect: removeColumn,
    },
    { id: 'separator-layout', separator: true },
    {
      id: 'width-average',
      label: '平均列宽',
      onSelect: averageWidths,
    },
    {
      id: 'selection-clear',
      label: '清空选区',
      disabled: !rect,
      hint: rect ? undefined : '请先选择要清空的单元格',
      onSelect: clearSelection,
    },
    {
      id: 'selection-copy',
      label: '复制选区',
      onSelect: () => void copySelection(),
    },
    { id: 'separator-export', separator: true },
    {
      id: 'export-markdown',
      label: '导出 Markdown',
      pressed: exportMode === 'markdown',
      onSelect: () => toggleExport('markdown'),
    },
    {
      id: 'export-html',
      label: '导出 HTML',
      pressed: exportMode === 'html',
      onSelect: () => toggleExport('html'),
    },
  ];

  const renderRow = (rowIndex: number, tag: 'th' | 'td') => {
    const cells = rows[rowIndex];
    if (!cells) {
      return null;
    }
    return (
      <tr key={`row-${rowIndex}`}>
        {cells.map((cell, columnIndex) => {
          if (cell.covered) {
            return null;
          }
          const selected = inRect(rowIndex, columnIndex, rect);
          const active =
            Boolean(selection) &&
            selection?.focus.row === rowIndex &&
            selection?.focus.column === columnIndex;
          const className = [
            'zxe-table-anchor',
            `zxe-table-align-${cell.align}`,
            selected ? 'is-selected' : '',
            active ? 'is-active' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const Tag = tag;
          return (
            <Tag
              key={`cell-${rowIndex}-${columnIndex}`}
              className={className}
              rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
              colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
              style={{ textAlign: cell.align }}
              data-row={rowIndex}
              data-column={columnIndex}
              aria-selected={selected}
              onMouseDown={(event) =>
                handleCellMouseDown(event, rowIndex, columnIndex)
              }
              onMouseEnter={() =>
                handleCellMouseEnter(rowIndex, columnIndex)
              }
            >
              {readOnly ? (
                <span className="zxe-table-text">
                  {cell.text || ' '}
                </span>
              ) : (
                <input
                  ref={(element) => {
                    const key = cellKey(rowIndex, columnIndex);
                    if (element) {
                      cellRefs.current.set(key, element);
                    } else {
                      cellRefs.current.delete(key);
                    }
                  }}
                  id={`zxe-table-cell-${block.id}-${rowIndex}-${columnIndex}`}
                  className="zxe-table-cell"
                  aria-label={`第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列`}
                  value={cell.text}
                  placeholder={
                    empty && rowIndex === 0 && columnIndex === 0
                      ? '输入内容，Tab 下一格'
                      : model.header && rowIndex === 0
                        ? `列 ${columnIndex + 1}`
                        : ''
                  }
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    updateCell(rowIndex, columnIndex, event.target.value)
                  }
                  onInput={bumpCaret}
                  onKeyUp={bumpCaret}
                  onClick={bumpCaret}
                  onSelect={bumpCaret}
                  onKeyDown={(event) =>
                    handleCellKeyDown(event, rowIndex, columnIndex)
                  }
                  onFocus={() => {
                    setFocusedCell({ row: rowIndex, column: columnIndex });
                    if (!selection) {
                      setSelection({
                        anchor: { row: rowIndex, column: columnIndex },
                        focus: { row: rowIndex, column: columnIndex },
                      });
                    }
                  }}
                />
              )}
              {!readOnly && rowIndex === 0 && cell.colSpan === 1 ? (
                <span
                  className="zxe-col-resize"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`调整第 ${columnIndex + 1} 列列宽`}
                  title={`拖拽调整第 ${columnIndex + 1} 列列宽，双击恢复 ${TABLE_DEFAULT_COL_WIDTH}px`}
                  onMouseDown={(event) =>
                    beginResize(event, columnIndex)
                  }
                  onDoubleClick={(event) =>
                    resetWidth(event, columnIndex)
                  }
                />
              ) : null}
            </Tag>
          );
        })}
      </tr>
    );
  };

  const totalWidth = widths.reduce((sum, width) => sum + width, 0);

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    const input = target.closest<HTMLInputElement>('input.zxe-table-cell');
    const originSelection = input
      ? {
          start: input.selectionStart ?? 0,
          end: input.selectionEnd ?? input.selectionStart ?? 0,
        }
      : null;
    // 单元格内已经选中文字时保留原生文本菜单；caret 折叠时才进入表格菜单。
    if (originSelection && originSelection.start !== originSelection.end) {
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const cell = target.closest<HTMLElement>('[data-row][data-column]');
    const coord =
      cell && cell.dataset.row !== undefined && cell.dataset.column !== undefined
        ? {
            row: Number(cell.dataset.row),
            column: Number(cell.dataset.column),
          }
        : null;

    let effective = selectionRef.current;
    if (coord) {
      const area = selectionRectOf(effective);
      if (!area || !inRect(coord.row, coord.column, area)) {
        // 右键先建立该单元格选区，菜单的合并/删除行等动作才有明确目标。
        effective = { anchor: coord, focus: coord };
        selectionRef.current = effective;
        setSelection(effective);
      }
    }

    const area = selectionRectOf(effective);
    const focus = effective?.focus ?? coord ?? { row: 0, column: 0 };
    const align =
      tableAnchorAt(model, focus.row, focus.column)?.cell.align ?? 'left';
    const originCoord = coord ?? effective?.focus ?? null;
    const originInput =
      input ??
      (originCoord
        ? cellRefs.current.get(cellKey(originCoord.row, originCoord.column)) ??
          null
        : null);

    const restoreFocus = () => {
      const nextInput = originInput?.isConnected
        ? originInput
        : originCoord
          ? cellRefs.current.get(
              cellKey(originCoord.row, originCoord.column),
            ) ?? null
          : null;
      if (nextInput) {
        nextInput.focus({ preventScroll: true });
        const end =
          originSelection?.end ?? nextInput.value.length;
        const start = originSelection?.start ?? end;
        nextInput.setSelectionRange(start, end);
        return;
      }
      wrapRef.current?.focus({ preventScroll: true });
    };

    setLocalContextMenuOpen(true);
    onContextMenu?.({
      x: event.clientX,
      y: event.clientY,
      readOnly,
      rowCount: rows.length,
      columnCount,
      hasSelection: Boolean(area),
      selectionSize: area
        ? { rows: area.height, columns: area.width }
        : null,
      canMerge: Boolean(area && area.area >= 2),
      hasMerge: selectionHasMerge(area),
      canInsertRow: rows.length < TABLE_MAX_ROWS,
      canInsertColumn: columnCount < TABLE_MAX_COLUMNS,
      canRemoveRow: rows.length > 1,
      canRemoveColumn: columnCount > 1,
      header: model.header,
      align,
      actions: {
        cutSelection: () => {
          void cutSelection();
        },
        copySelection: () => {
          void copySelection();
        },
        paste: () => {
          void pasteFromClipboard();
        },
        merge: mergeSelection,
        split: splitSelection,
        insertRow,
        insertColumn,
        removeRow,
        removeColumn,
        setAlign,
        toggleHeader,
        averageWidths,
        resetColumnWidth: resetCurrentColumnWidth,
        clearSelection,
        exportTable: openExport,
        copyExport: (mode) => {
          void copyTableSource(mode);
        },
        restoreFocus,
      },
    });
  };

  // 编辑态表格容器可聚焦：键盘进入对象时先落到容器，属性工具条随之浮出；
  // 只读态没有工具条，不额外占用 Tab 停靠点。
  const ariaCell = focusedCell ?? selection?.focus ?? null;
  return (
    <div
      className={`zxe-table-wrap${toolbarBelow ? ' is-toolbar-below' : ''}`}
      role="group"
      aria-label="表格"
      ref={wrapRef}
      tabIndex={readOnly ? -1 : 0}
      data-meta-visible={toolbarVisible ? 'true' : 'false'}
      onCopy={handleCopy}
      onPaste={handlePaste}
      onContextMenu={handleContextMenu}
      onKeyDown={handleWrapKeyDown}
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
      onFocus={() => setFocusWithin(true)}
      onBlur={handleWrapBlur}
    >
      {tableState.invalid ? (
        <p className="zxe-table-error" role="alert">
          表格数据异常，已显示空白表格；继续编辑会写回规范结构。
        </p>
      ) : tableState.repaired ? (
        <p className="zxe-table-error" role="alert">
          表格数据有重叠或越界，已按规范裁剪；未被采用的原数据仍保留在正文缓存中。
        </p>
      ) : null}

      {toolbarVisible
        ? createPortal(
            <div
              ref={toolbar.ref}
              className="zxe-table-toolbar"
              role="toolbar"
              aria-label="表格工具栏"
              aria-controls={
                ariaCell
                  ? `zxe-table-cell-${block.id}-${ariaCell.row}-${ariaCell.column}`
                  : undefined
              }
              data-positioned={toolbar.placement ? 'true' : 'false'}
              data-side={toolbar.placement?.side}
              style={toolbar.style}
              onKeyDown={handleToolbarKeyDown}
              onMouseDown={(event) => {
                // 不把焦点从单元格带走：悬停/点击工具条后仍保持选区与 caret。
                event.preventDefault();
              }}
              onMouseEnter={showHover}
              onMouseLeave={hideHoverSoon}
            >
              <div className="zxe-table-group">
                <button
                  type="button"
                  className={model.header ? 'is-on' : ''}
                  aria-pressed={model.header}
                  onClick={toggleHeader}
                >
                  表头
                </button>
              </div>
              <div
                className="zxe-table-group"
                role="group"
                aria-label="单元格对齐"
              >
                {!rect ? (
                  <span id={alignHintId} className="zx-visually-hidden">
                    请先选择单元格再设置对齐
                  </span>
                ) : null}
                {ALIGN_OPTIONS.map((option) => {
                  // 对齐只作用于选区：hover 浮出但未选单元格时禁用，
                  // 不再等点击后才给提示（ZX6-TABLE-02）。
                  const disabled = !rect;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={activeAlign === option.value ? 'is-on' : ''}
                      aria-pressed={activeAlign === option.value}
                      aria-label={`${option.label}对齐`}
                      aria-describedby={disabled ? alignHintId : undefined}
                      title={
                        disabled
                          ? '请先选择单元格再设置对齐'
                          : `${option.label}对齐`
                      }
                      disabled={disabled}
                      onClick={() => setAlign(option.value)}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <div className="zxe-table-group zxe-table-more">
                <OverflowMenu
                  label="更多表格操作"
                  triggerTitle="合并拆分、插入删除行列、列宽、选区与导出"
                  triggerContent="更多"
                  triggerClassName="zxe-table-more-trigger"
                  onOpenChange={handleMoreMenuOpenChange}
                  items={moreItems}
                />
              </div>
              {rect && rect.area > 1 ? (
                <span className="zxe-table-selection-chip">
                  {rect.height}×{rect.width}
                </span>
              ) : null}
            </div>,
            getFloatingLayer() ?? document.body,
          )
        : null}

      <div className="zxe-table-scroll">
        <table
          className="zxe-table"
          role="grid"
          aria-label="表格"
          aria-rowcount={rows.length}
          aria-colcount={columnCount}
          aria-multiselectable="true"
          style={{ width: `${Math.max(320, totalWidth)}px` }}
        >
          <colgroup>
            {widths.map((width, column) => (
              <col
                key={`col-${column}`}
                style={{ width: `${width}px` }}
              />
            ))}
          </colgroup>
          {model.header ? (
            <thead>{renderRow(0, 'th')}</thead>
          ) : null}
          <tbody>
            {rows.map((_row, rowIndex) =>
              model.header && rowIndex === 0
                ? null
                : renderRow(rowIndex, 'td'),
            )}
          </tbody>
        </table>
      </div>

      {message && !readOnly ? (
        <div className="zxe-table-toast" role="status" aria-live="polite">
          {message.text}
        </div>
      ) : null}

      {exportMode !== 'none' && !readOnly ? (
        <div
          className="zxe-table-export"
          role="dialog"
          aria-label="表格导出预览"
        >
          <div className="zxe-table-export-head">
            <strong>
              {exportMode === 'markdown' ? 'Markdown' : 'HTML'} 导出
            </strong>
            <button
              type="button"
              aria-label="关闭导出预览"
              onClick={() => {
                setExportMode('none');
                setCopyState('');
              }}
            >
              关闭
            </button>
          </div>
          <pre
            className="zxe-table-export-body"
            ref={exportRef}
            tabIndex={0}
          >
            {exportText}
          </pre>
          <div className="zxe-table-export-actions">
            <button type="button" onClick={() => void copyExport()}>
              复制
            </button>
            <span role="status">{copyState}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
