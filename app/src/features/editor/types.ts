/**
 * 块编辑器的领域类型与防御式读取。
 *
 * 数据库里 payload_json 是任意 JSON；这里所有 `*Of` 函数都必须在脏数据下
 * 仍然返回可渲染的值，不能因为一个坏字段让整篇笔记打不开。
 */

import type {
  BlockDocument,
  BlockDocumentBlock,
  BlockPayload,
  EditorBlock,
} from '../../data/repositories/blocks';
import {
  canonicalColor,
  internalNoteIdFromUrl,
  internalNoteUrl,
  isSafeLinkUrl,
  sanitizeLinkUrl,
} from './security';

export type TextAlign = 'left' | 'center' | 'right';

export type InlineMarks = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  color?: string;
  background?: string;
  link?: string;
};

export type InlineRun = {
  text: string;
  marks?: InlineMarks;
};

export type TextPayload = {
  runs: InlineRun[];
  align?: TextAlign;
  indent?: number;
};

export type TodoPayload = TextPayload & {
  checked: boolean;
  /** P1-03 接入 note_todos 后用于稳定关联；P1-02 不创建全局待办。 */
  todoId?: string | null;
};

export type CodePayload = {
  code: string;
  language?: string;
  /** 自动换行，默认 true；旧数据缺省按 true 读取。 */
  wrap?: boolean;
  /** 行号开关，默认 true；换行时视觉上隐藏。 */
  lineNumbers?: boolean;
};

/** 旧版（v1）表格 payload；读取时由 `blockTableModel` 迁移到 v2。 */
export type TablePayload = {
  rows: string[][];
  header?: boolean;
};

export const TABLE_MAX_ROWS = 40;
export const TABLE_MAX_COLUMNS = 16;
export const TABLE_DEFAULT_COL_WIDTH = 140;
export const TABLE_MIN_COL_WIDTH = 64;
export const TABLE_MAX_COL_WIDTH = 520;

/**
 * 表格 v2 单元格。
 *
 * `table` 是表格级元数据（表头开关、列宽）。编辑器的 payload patch 契约只
 * 携带 `rows`，因此元数据随行数据持久化在左上锚点（0,0）上；读取端同时
 * 兼容未来放在 payload 顶层的 `header` / `widths`。这样表头、列宽、合并
 * 与内容编辑都会走同一条 `onChange(rows)` 路径，撤销/重做天然覆盖。
 */
export type TableCell = {
  text: string;
  align: TextAlign;
  rowSpan: number;
  colSpan: number;
  covered: boolean;
  table?: TableMeta;
};

export type TableMeta = {
  /** 表格 payload 版本；随行数据持久化，便于后续无损迁移。 */
  schemaVersion?: 2;
  header: boolean;
  widths: number[];
};

export type TableModel = {
  schemaVersion: 2;
  header: boolean;
  widths: number[];
  rows: TableCell[][];
};

export type TableModelState = {
  model: TableModel;
  /** 行/列数或合并跨度被裁剪过；UI 需要提示用户。 */
  repaired: boolean;
  /** payload 完全不可读，已回退到 3×3 空表。 */
  invalid: boolean;
};

export type FilePayload = {
  attachmentId: string | null;
  fileName: string;
  byteSize: number;
  mime: string;
  status: 'local' | 'pending' | 'available' | 'missing';
};

export type BoardPayload = {
  boardId: string | null;
  title: string;
};

export type FormulaPayload = {
  latex: string;
  renderer: 'none';
};

export type LinkPayload = {
  url: string;
  title: string;
};

/** 引用块：正文沿用 runs，来源信息三字段可独立留空（ZX-NOTE-04）。 */
export type QuotePayload = TextPayload & {
  source?: string;
  noteId?: string;
  sourceUrl?: string;
};

export type QuoteMeta = {
  source: string;
  noteId: string;
  sourceUrl: string;
};

export const QUOTE_SOURCE_MAX_LENGTH = 120;
export const QUOTE_SOURCE_URL_MAX_LENGTH = 2048;

export type KnownBlockType =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'todo'
  | 'bullet_list'
  | 'ordered_list'
  | 'quote'
  | 'code'
  | 'divider'
  | 'table'
  | 'file'
  | 'board'
  | 'formula'
  | 'link';

export const TEXT_COLORS: ReadonlyArray<string> = [
  '#FF403C',
  '#FF8B01',
  '#F2C750',
  '#0D9C6C',
  '#448AFF',
  '#8251DD',
  '#7084A4',
];

/** 与原型一致：7 个文字色、14 个底色。 */
export const BACKGROUND_COLORS: ReadonlyArray<string> = [
  '#FFDBDC',
  '#FFE0AD',
  '#FFF48E',
  '#CEF2DF',
  '#D1E6FF',
  '#E9DFFF',
  '#E6E9ED',
  '#FF6F64',
  '#FFA72B',
  '#FDE645',
  '#28D17B',
  '#89B5FF',
  '#CB90FD',
  '#B9BFC8',
];

const ALIGNMENTS = new Set<TextAlign>(['left', 'center', 'right']);

export function isKnownBlockType(value: string): value is KnownBlockType {
  return (
    value === 'paragraph' ||
    value === 'heading1' ||
    value === 'heading2' ||
    value === 'heading3' ||
    value === 'heading4' ||
    value === 'heading5' ||
    value === 'todo' ||
    value === 'bullet_list' ||
    value === 'ordered_list' ||
    value === 'quote' ||
    value === 'code' ||
    value === 'divider' ||
    value === 'table' ||
    value === 'file' ||
    value === 'board' ||
    value === 'formula' ||
    value === 'link'
  );
}

export function isTextualBlockType(type: string): boolean {
  return (
    type === 'paragraph' ||
    type === 'heading1' ||
    type === 'heading2' ||
    type === 'heading3' ||
    type === 'heading4' ||
    type === 'heading5' ||
    type === 'todo' ||
    type === 'bullet_list' ||
    type === 'ordered_list' ||
    type === 'quote'
  );
}

export function isHeadingBlockType(type: string): boolean {
  return /^heading[1-5]$/.test(type);
}

export function headingLevel(type: string): number | null {
  const match = /^heading([1-5])$/.exec(type);
  return match ? Number(match[1]) : null;
}

export function normalizeMarks(value: unknown): InlineMarks | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const marks: InlineMarks = {};
  if (raw.bold === true) {
    marks.bold = true;
  }
  if (raw.italic === true) {
    marks.italic = true;
  }
  if (raw.underline === true) {
    marks.underline = true;
  }
  if (raw.strike === true) {
    marks.strike = true;
  }
  if (raw.code === true) {
    marks.code = true;
  }
  const color = canonicalColor(raw.color);
  if (color) {
    marks.color = color;
  }
  const background = canonicalColor(raw.background);
  if (background) {
    marks.background = background;
  }
  if (isSafeLinkUrl(raw.link)) {
    marks.link = raw.link.trim();
  }
  return Object.keys(marks).length > 0 ? marks : undefined;
}

export function normalizeInlineRun(value: unknown): InlineRun | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.text !== 'string' || raw.text.length === 0) {
    return null;
  }
  const marks = normalizeMarks(raw.marks);
  return marks ? { text: raw.text, marks } : { text: raw.text };
}

export function normalizeInlineRuns(value: unknown): InlineRun[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const runs: InlineRun[] = [];
  for (const item of value) {
    const run = normalizeInlineRun(item);
    if (run) {
      runs.push(run);
    }
  }
  return runs;
}

export function blockRuns(block: Pick<EditorBlock, 'payload'>): InlineRun[] {
  return normalizeInlineRuns(block.payload.runs);
}

export function payloadRuns(payload: BlockPayload): InlineRun[] {
  return normalizeInlineRuns(payload.runs);
}

export function blockAlign(
  block: Pick<EditorBlock, 'payload'>,
): TextAlign | undefined {
  const align = block.payload.align;
  return typeof align === 'string' && ALIGNMENTS.has(align as TextAlign)
    ? (align as TextAlign)
    : undefined;
}

export function blockIndent(
  block: Pick<EditorBlock, 'payload'>,
): number {
  const indent = block.payload.indent;
  if (typeof indent !== 'number' || !Number.isFinite(indent)) {
    return 0;
  }
  return Math.max(0, Math.min(6, Math.round(indent)));
}

export function blockChecked(block: Pick<EditorBlock, 'payload'>): boolean {
  return block.payload.checked === true;
}

export function blockCode(block: Pick<EditorBlock, 'payload'>): string {
  return typeof block.payload.code === 'string' ? block.payload.code : '';
}

export function blockLanguage(
  block: Pick<EditorBlock, 'payload'>,
): string {
  const language = block.payload.language;
  return typeof language === 'string' ? sanitizeCodeLanguage(language) : '';
}

export function blockCodeWrap(block: Pick<EditorBlock, 'payload'>): boolean {
  return block.payload.wrap !== false;
}

export function blockCodeLineNumbers(
  block: Pick<EditorBlock, 'payload'>,
): boolean {
  return block.payload.lineNumbers !== false;
}

/**
 * 代码块常用语言目录（与知识块规范 §4.4 的 25 项一致）。
 *
 * `id` 是持久化与 Markdown 围栏使用的标准值；`label` 只用于界面；`aliases`
 * 用于失焦/回车时把 `ts`、`sh`、`c++` 这类手输值归一化。下拉只列这里登记的
 * 语言，但手输任意值仍会保留，未知语言按纯文本显示。
 */
export type CodeLanguageOption = {
  id: string;
  label: string;
  aliases: readonly string[];
};

export const CODE_LANGUAGES: ReadonlyArray<CodeLanguageOption> = [
  { id: 'plaintext', label: '纯文本', aliases: ['text', 'txt', 'plain'] },
  {
    id: 'javascript',
    label: 'JavaScript',
    aliases: ['js', 'mjs', 'cjs', 'jsx'],
  },
  { id: 'typescript', label: 'TypeScript', aliases: ['ts', 'tsx'] },
  { id: 'python', label: 'Python', aliases: ['py'] },
  { id: 'json', label: 'JSON', aliases: ['jsonc'] },
  {
    id: 'bash',
    label: 'Shell',
    aliases: ['sh', 'shell', 'zsh', 'console'],
  },
  {
    id: 'sql',
    label: 'SQL',
    aliases: ['mysql', 'postgres', 'postgresql', 'pgsql'],
  },
  { id: 'html', label: 'HTML', aliases: ['xml'] },
  { id: 'css', label: 'CSS', aliases: ['scss', 'less'] },
  { id: 'go', label: 'Go', aliases: ['golang'] },
  { id: 'rust', label: 'Rust', aliases: ['rs'] },
  { id: 'java', label: 'Java', aliases: [] },
  { id: 'c', label: 'C', aliases: [] },
  { id: 'cpp', label: 'C++', aliases: ['c++', 'cc', 'hpp', 'hxx'] },
  { id: 'csharp', label: 'C#', aliases: ['cs', 'c#'] },
  { id: 'yaml', label: 'YAML', aliases: ['yml'] },
  { id: 'markdown', label: 'Markdown', aliases: ['md', 'mdown'] },
  { id: 'kotlin', label: 'Kotlin', aliases: ['kt', 'kts'] },
  { id: 'swift', label: 'Swift', aliases: [] },
  { id: 'php', label: 'PHP', aliases: [] },
  { id: 'ruby', label: 'Ruby', aliases: ['rb'] },
  { id: 'lua', label: 'Lua', aliases: [] },
  { id: 'r', label: 'R', aliases: ['rscript'] },
  { id: 'diff', label: 'Diff', aliases: ['patch'] },
  { id: 'ini', label: 'INI / TOML', aliases: ['toml', 'conf'] },
];

const CODE_LANGUAGE_ALIASES = new Map<string, string>();
for (const option of CODE_LANGUAGES) {
  CODE_LANGUAGE_ALIASES.set(option.id, option.id);
  for (const alias of option.aliases) {
    CODE_LANGUAGE_ALIASES.set(alias, option.id);
  }
}

const CODE_LANGUAGE_CHARS = /[^a-z0-9+#._-]/g;

/** 输入时清洗语言：小写、去空白、只保留白名单字符、≤24 字符。 */
export function sanitizeCodeLanguage(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(CODE_LANGUAGE_CHARS, '')
    .slice(0, 24);
}

/** 命中 id/别名时替换为标准 id；未知值原样保留（仍可手输）。 */
export function canonicalCodeLanguage(raw: string): string {
  const value = sanitizeCodeLanguage(raw);
  if (!value) {
    return '';
  }
  return CODE_LANGUAGE_ALIASES.get(value) ?? value;
}

export function codeLanguageOption(
  raw: string,
): CodeLanguageOption | undefined {
  const id = canonicalCodeLanguage(raw);
  return CODE_LANGUAGES.find((option) => option.id === id);
}

/** 已识别语言返回 label；空值显示纯文本；未知值原样显示。 */
export function codeLanguageLabel(raw: string): string {
  if (!raw.trim()) {
    return '纯文本';
  }
  return codeLanguageOption(raw)?.label ?? raw;
}

/** highlight.js 的语言键；纯文本或未知语言返回 null（按纯文本渲染）。 */
export function codeHighlightLanguage(raw: string): string | null {
  const option = codeLanguageOption(raw);
  if (!option || option.id === 'plaintext') {
    return null;
  }
  // highlight.js 用 xml 注册 HTML；其余 id 与 catalog 一致。
  return option.id === 'html' ? 'xml' : option.id;
}

/** 代码缩进单位：Python 4 空格，其余 2 空格。 */
export function codeIndentUnit(raw: string): string {
  return canonicalCodeLanguage(raw) === 'python' ? '    ' : '  ';
}

/**
 * Markdown 围栏语言。
 *
 * - 纯文本/空语言 → 空串，导出为无语言围栏；
 * - 已知语言 → 标准 id；
 * - 未知语言 → 清洗后的原值，保留用户手输，不报错。
 */
export function codeFenceLanguage(raw: string): string {
  if (!raw.trim()) {
    return '';
  }
  const canonical = canonicalCodeLanguage(raw);
  return canonical === 'plaintext' ? '' : canonical;
}

function emptyTableCell(): TableCell {
  return {
    text: '',
    align: 'left',
    rowSpan: 1,
    colSpan: 1,
    covered: false,
  };
}

function coveredTableCell(): TableCell {
  return {
    text: '',
    align: 'left',
    rowSpan: 1,
    colSpan: 1,
    covered: true,
  };
}

function clampInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

type ParsedTableCell = {
  text: string;
  align: TextAlign;
  rowSpan: number;
  colSpan: number;
  covered: boolean;
  meta: unknown;
};

function parseTableCell(value: unknown): ParsedTableCell {
  if (typeof value === 'string') {
    return {
      text: value,
      align: 'left',
      rowSpan: 1,
      colSpan: 1,
      covered: false,
      meta: undefined,
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      text: '',
      align: 'left',
      rowSpan: 1,
      colSpan: 1,
      covered: false,
      meta: undefined,
    };
  }
  const raw = value as Record<string, unknown>;
  const align =
    raw.align === 'center' || raw.align === 'right' ? raw.align : 'left';
  return {
    text: typeof raw.text === 'string' ? raw.text : '',
    align,
    rowSpan: clampInteger(raw.rowSpan, 1, TABLE_MAX_ROWS),
    colSpan: clampInteger(raw.colSpan, 1, TABLE_MAX_COLUMNS),
    covered: raw.covered === true,
    meta: raw.table,
  };
}

function readTableMeta(value: unknown): TableMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  return {
    header: raw.header !== false,
    widths: Array.isArray(raw.widths) ? raw.widths : [],
  };
}

function normalizeTableWidths(
  value: unknown,
  columnCount: number,
  fallback: number,
): { widths: number[]; repaired: boolean } {
  let repaired = false;
  const raw = Array.isArray(value) ? value : [];
  if (raw.length > columnCount) {
    repaired = true;
  }
  const widths: number[] = [];
  for (let index = 0; index < columnCount; index += 1) {
    const candidate = raw[index];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      widths.push(fallback);
      if (candidate !== undefined) {
        repaired = true;
      }
      continue;
    }
    const rounded = Math.round(candidate);
    const clamped = Math.max(
      TABLE_MIN_COL_WIDTH,
      Math.min(TABLE_MAX_COL_WIDTH, rounded),
    );
    if (rounded !== candidate || clamped !== rounded) {
      repaired = true;
    }
    widths.push(clamped);
  }
  return { widths, repaired };
}

/**
 * 防御式读取表格 v2 模型。
 *
 * 兼容三种来源：
 * 1. v1 `rows: string[][]` + `header`；
 * 2. v2 `rows: TableCell[][]`（左上锚点携带 `table` 元数据）；
 * 3. 未来/嵌套形态 `rows: { schemaVersion, header, widths, rows }`。
 *
 * 修复采用行优先“先到先得”：裁剪越界/重叠跨度，孤儿覆盖格变成空白锚点。
 */
export function blockTableModel(
  block: Pick<EditorBlock, 'payload'>,
): TableModelState {
  const rawRows = block.payload.rows;
  let rowsInput: unknown = rawRows;
  let headerInput: unknown = block.payload.header;
  let widthsInput: unknown = block.payload.widths;

  if (rawRows && typeof rawRows === 'object' && !Array.isArray(rawRows)) {
    const nested = rawRows as Record<string, unknown>;
    rowsInput = nested.rows;
    if (nested.header !== undefined) {
      headerInput = nested.header;
    }
    if (nested.widths !== undefined) {
      widthsInput = nested.widths;
    }
  }

  if (!Array.isArray(rowsInput) || rowsInput.length === 0) {
    const widths = Array.from(
      { length: 3 },
      () => TABLE_DEFAULT_COL_WIDTH,
    );
    return {
      model: {
        schemaVersion: 2,
        header: headerInput !== false,
        widths,
        rows: Array.from({ length: 3 }, () =>
          Array.from({ length: 3 }, emptyTableCell),
        ),
      },
      repaired: false,
      invalid: true,
    };
  }

  let repaired = false;
  const sourceRows: ParsedTableCell[][] = [];
  for (const rawRow of rowsInput.slice(0, TABLE_MAX_ROWS)) {
    if (!Array.isArray(rawRow)) {
      repaired = true;
      continue;
    }
    if (rawRow.length > TABLE_MAX_COLUMNS) {
      repaired = true;
    }
    sourceRows.push(
      rawRow
        .slice(0, TABLE_MAX_COLUMNS)
        .map((cell) => parseTableCell(cell)),
    );
  }
  if (rowsInput.length > TABLE_MAX_ROWS) {
    repaired = true;
  }
  if (sourceRows.length === 0) {
    return {
      model: {
        schemaVersion: 2,
        header: headerInput !== false,
        widths: Array.from(
          { length: 3 },
          () => TABLE_DEFAULT_COL_WIDTH,
        ),
        rows: Array.from({ length: 3 }, () =>
          Array.from({ length: 3 }, emptyTableCell),
        ),
      },
      repaired: true,
      invalid: true,
    };
  }

  let columnCount = 1;
  for (const row of sourceRows) {
    columnCount = Math.max(columnCount, row.length);
  }
  columnCount = Math.min(TABLE_MAX_COLUMNS, columnCount);

  for (const row of sourceRows) {
    if (row.length !== columnCount) {
      repaired = true;
      while (row.length < columnCount) {
        row.push(parseTableCell(''));
      }
    }
  }

  // 表格级元数据只信任左上锚点；也扫描其它格，兼容手工迁移数据。
  let meta: TableMeta | null = null;
  for (const row of sourceRows) {
    for (const cell of row) {
      const parsed = readTableMeta(cell.meta);
      if (parsed) {
        meta ??= parsed;
      }
    }
  }

  const occupied = Array.from({ length: sourceRows.length }, () =>
    Array.from({ length: columnCount }, () => false),
  );
  const rows: TableCell[][] = Array.from({ length: sourceRows.length }, () =>
    Array.from({ length: columnCount }, emptyTableCell),
  );

  for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex += 1) {
    for (
      let columnIndex = 0;
      columnIndex < columnCount;
      columnIndex += 1
    ) {
      if (occupied[rowIndex][columnIndex]) {
        continue;
      }
      const source = sourceRows[rowIndex][columnIndex];
      if (source.covered) {
        // 没有锚点的覆盖格：按规范降级成空白锚点。
        repaired = true;
        occupied[rowIndex][columnIndex] = true;
        rows[rowIndex][columnIndex] = emptyTableCell();
        continue;
      }

      let rowSpan = Math.min(
        source.rowSpan,
        sourceRows.length - rowIndex,
      );
      let colSpan = Math.min(source.colSpan, columnCount - columnIndex);
      if (rowSpan !== source.rowSpan || colSpan !== source.colSpan) {
        repaired = true;
      }

      // 先到先得：与已占用区域重叠时收缩跨度。
      for (;;) {
        let overlaps = false;
        for (let r = rowIndex; r < rowIndex + rowSpan && !overlaps; r += 1) {
          for (
            let c = columnIndex;
            c < columnIndex + colSpan;
            c += 1
          ) {
            if (occupied[r][c]) {
              overlaps = true;
              break;
            }
          }
        }
        if (!overlaps) {
          break;
        }
        repaired = true;
        if (colSpan > 1) {
          colSpan -= 1;
        } else if (rowSpan > 1) {
          rowSpan -= 1;
        } else {
          break;
        }
      }

      const anchor: TableCell = {
        text: source.text,
        align: source.align,
        rowSpan,
        colSpan,
        covered: false,
      };
      rows[rowIndex][columnIndex] = anchor;
      occupied[rowIndex][columnIndex] = true;

      for (let r = rowIndex; r < rowIndex + rowSpan; r += 1) {
        for (let c = columnIndex; c < columnIndex + colSpan; c += 1) {
          if (r === rowIndex && c === columnIndex) {
            continue;
          }
          if (occupied[r][c]) {
            repaired = true;
            continue;
          }
          occupied[r][c] = true;
          rows[r][c] = coveredTableCell();
          const swallowed = sourceRows[r][c];
          if (
            !swallowed.covered ||
            swallowed.text !== '' ||
            swallowed.rowSpan !== 1 ||
            swallowed.colSpan !== 1
          ) {
            // 被合并区域吞掉的可见内容/子锚点，说明原数据有冲突。
            repaired = true;
          }
        }
      }
    }
  }

  const normalizedWidths = normalizeTableWidths(
    meta?.widths ?? widthsInput,
    columnCount,
    TABLE_DEFAULT_COL_WIDTH,
  );
  if (normalizedWidths.repaired) {
    repaired = true;
  }

  return {
    model: {
      schemaVersion: 2,
      header: meta?.header ?? headerInput !== false,
      widths: normalizedWidths.widths,
      rows,
    },
    repaired,
    invalid: false,
  };
}

/** 把模型写回 payload.rows；元数据挂在 (0,0) 锚点，保持 rows 为纯 JSON 数组。 */
export function tablePayloadRows(model: TableModel): TableCell[][] {
  const rows = model.rows.map((row) =>
    row.map((cell) => {
      const next: TableCell = {
        text: cell.text,
        align: cell.align,
        rowSpan: cell.rowSpan,
        colSpan: cell.colSpan,
        covered: cell.covered,
      };
      return next;
    }),
  );
  const anchor = rows[0]?.[0];
  if (anchor) {
    anchor.table = {
      schemaVersion: 2,
      header: model.header,
      widths: [...model.widths],
    };
  }
  return rows;
}

/** 找到覆盖指定逻辑坐标的锚点；坐标越界返回 null。 */
export function tableAnchorAt(
  model: TableModel,
  row: number,
  column: number,
): { row: number; column: number; cell: TableCell } | null {
  const direct = model.rows[row]?.[column];
  if (!direct) {
    return null;
  }
  if (!direct.covered) {
    return { row, column, cell: direct };
  }
  for (let r = Math.min(row, model.rows.length - 1); r >= 0; r -= 1) {
    for (let c = Math.min(column, (model.rows[r]?.length ?? 0) - 1); c >= 0; c -= 1) {
      const cell = model.rows[r]?.[c];
      if (!cell || cell.covered) {
        continue;
      }
      if (
        r <= row &&
        row < r + cell.rowSpan &&
        c <= column &&
        column < c + cell.colSpan
      ) {
        return { row: r, column: c, cell };
      }
    }
  }
  return null;
}

export function blockTableRows(
  block: Pick<EditorBlock, 'payload'>,
): string[][] {
  return blockTableModel(block).model.rows.map((row) =>
    row.map((cell) => (cell.covered ? '' : cell.text)),
  );
}

export function blockHeaderRow(
  block: Pick<EditorBlock, 'payload'>,
): boolean {
  return blockTableModel(block).model.header;
}

export function blockTableWidths(
  block: Pick<EditorBlock, 'payload'>,
): number[] {
  return blockTableModel(block).model.widths;
}

export function blockFile(
  block: Pick<EditorBlock, 'payload'>,
): FilePayload {
  const raw = block.payload;
  return {
    attachmentId:
      typeof raw.attachmentId === 'string' ? raw.attachmentId : null,
    fileName: typeof raw.fileName === 'string' ? raw.fileName : '',
    byteSize:
      typeof raw.byteSize === 'number' && Number.isFinite(raw.byteSize)
        ? Math.max(0, raw.byteSize)
        : 0,
    mime: typeof raw.mime === 'string' ? raw.mime : '',
    status:
      raw.status === 'pending' ||
      raw.status === 'available' ||
      raw.status === 'missing' ||
      raw.status === 'local'
        ? raw.status
        : 'local',
  };
}

export function blockBoard(
  block: Pick<EditorBlock, 'payload'>,
): BoardPayload {
  return {
    boardId:
      typeof block.payload.boardId === 'string'
        ? block.payload.boardId
        : null,
    title:
      typeof block.payload.title === 'string'
        ? block.payload.title
        : '未命名画板',
  };
}

export function blockFormula(
  block: Pick<EditorBlock, 'payload'>,
): FormulaPayload {
  return {
    latex:
      typeof block.payload.latex === 'string' ? block.payload.latex : '',
    renderer: 'none',
  };
}

export function blockLink(
  block: Pick<EditorBlock, 'payload'>,
): LinkPayload {
  return {
    url: typeof block.payload.url === 'string' ? block.payload.url : '',
    title: typeof block.payload.title === 'string' ? block.payload.title : '',
  };
}

/**
 * 引用来源的防御式读取。
 *
 * 历史数据可能只写 `runs`，也可能留下超长出处、非法内链或 `javascript:`
 * 链接；这里只做 trim 与类型收敛，不截断、不丢弃，交给 UI 显示与保存校验。
 */
export function quoteMetaOf(
  payload: BlockPayload,
): QuoteMeta {
  return {
    source:
      typeof payload.source === 'string' ? payload.source.trim() : '',
    noteId:
      typeof payload.noteId === 'string' ? payload.noteId.trim() : '',
    sourceUrl:
      typeof payload.sourceUrl === 'string'
        ? payload.sourceUrl.trim()
        : '',
  };
}

export function blockQuoteMeta(
  block: Pick<EditorBlock, 'payload'>,
): QuoteMeta {
  return quoteMetaOf(block.payload);
}

export function blockQuote(
  block: Pick<EditorBlock, 'payload'>,
): QuotePayload {
  return {
    runs: blockRuns(block),
    ...quoteMetaOf(block.payload),
  };
}

export function blockQuoteHasMeta(
  block: Pick<EditorBlock, 'payload'>,
): boolean {
  const meta = quoteMetaOf(block.payload);
  return Boolean(meta.source || meta.noteId || meta.sourceUrl);
}

export type QuoteMetaCheck = {
  /** 通过校验后的值；被删除的关联笔记会在保存时清除 noteId。 */
  meta: QuoteMeta;
  error: string | null;
  /** noteId 曾经存在但已不在可选笔记中（已删除/回收站）。 */
  noteMissing: boolean;
};

/**
 * 引用来源保存校验（与链接块共用 `sanitizeLinkUrl` 内链契约）。
 *
 * - 出处 trim 后 ≤120 字，超长就地报错、不截断；
 * - noteId 必须是合法 id；目标被删除时不报错，由保存动作清除关联；
 * - sourceUrl 支持 http / https / mailto 与 `zhixing://note/<id>`。
 */
export function checkQuoteMeta(
  input: QuoteMeta,
  notes?: readonly { id: string }[],
): QuoteMetaCheck {
  const source = input.source.trim();
  const sourceUrl = input.sourceUrl.trim();
  let noteId = input.noteId.trim();

  if (source.length > QUOTE_SOURCE_MAX_LENGTH) {
    return {
      meta: { source, noteId, sourceUrl },
      error: `出处最多 ${QUOTE_SOURCE_MAX_LENGTH} 字（当前 ${source.length} 字）`,
      noteMissing: false,
    };
  }

  if (noteId && !internalNoteUrl(noteId)) {
    return {
      meta: { source, noteId, sourceUrl },
      error: '关联笔记 id 不合法',
      noteMissing: false,
    };
  }

  const noteMissing =
    Boolean(noteId) &&
    notes !== undefined &&
    !notes.some((note) => note.id === noteId);
  if (noteMissing) {
    noteId = '';
  }

  if (sourceUrl) {
    if (sourceUrl.length > QUOTE_SOURCE_URL_MAX_LENGTH) {
      return {
        meta: { source, noteId, sourceUrl },
        error: `链接过长（最多 ${QUOTE_SOURCE_URL_MAX_LENGTH} 字符）`,
        noteMissing,
      };
    }
    if (
      sourceUrl.toLowerCase().startsWith('zhixing:') &&
      !internalNoteIdFromUrl(sourceUrl)
    ) {
      return {
        meta: { source, noteId, sourceUrl },
        error: '内链 id 不合法',
        noteMissing,
      };
    }
    if (!sanitizeLinkUrl(sourceUrl)) {
      return {
        meta: { source, noteId, sourceUrl },
        error: '仅支持 http / https / mailto 或站内笔记内链',
        noteMissing,
      };
    }
  }

  return {
    meta: { source, noteId, sourceUrl },
    error: null,
    noteMissing,
  };
}


export type { BlockDocument, BlockDocumentBlock, BlockPayload, EditorBlock };
