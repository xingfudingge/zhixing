/**
 * 笔记基础导入（ZX-IO-04）。
 *
 * 只做「文件字节 → 结构化块」的纯解析，不写数据库、不挂载 DOM：
 * - Markdown / HTML / TXT 分别映射到现有块模型，绝不把一整段 HTML 当正文；
 * - HTML 先走粘贴白名单清洗（丢弃 script/style/iframe/img 等），脚本不会执行；
 * - 解析失败抛 `NoteImportError`，页面据此逐文件报告；
 * - 真正落库由 `NoteSource.import` / Rust `notes_import` 在单事务内完成。
 */

import type { ImportNoteInput } from '../../data/db/types';
import type {
  BlockPayload,
  EditorBlock,
} from '../../data/repositories/blocks';
import { blocksToHtml } from '../editor/blockHtml';
import {
  inlineRunsFromNode,
  mergeRuns,
  runsToPlainText,
  sliceRuns,
} from '../editor/inline';
import { sanitizePastedHtml } from '../editor/paste';
import { sanitizeLinkUrl } from '../editor/security';
import {
  codeFenceLanguage,
  normalizeInlineRuns,
  tablePayloadRows,
  TABLE_DEFAULT_COL_WIDTH,
  TABLE_MAX_COLUMNS,
  TABLE_MAX_ROWS,
  type InlineMarks,
  type InlineRun,
  type KnownBlockType,
  type TableModel,
  type TextAlign,
} from '../editor/types';

export const NOTE_IMPORT_MAX_FILES = 50;
export const NOTE_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const NOTE_IMPORT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export const NOTE_IMPORT_ACCEPT =
  '.md,.markdown,.html,.htm,.txt,.zxnote,text/markdown,text/html,text/plain,application/x-zhixing-note+zip';

export type NoteImportFormat = 'markdown' | 'html' | 'text';

export type NoteImportErrorCode =
  | 'IMPORT_UNSUPPORTED_FORMAT'
  | 'IMPORT_TOO_LARGE'
  | 'IMPORT_EMPTY'
  | 'IMPORT_NO_CONTENT'
  | 'IMPORT_ENCODING_UNKNOWN'
  | 'IMPORT_PARSE_FAILED';

export class NoteImportError extends Error {
  readonly code: NoteImportErrorCode;
  readonly fileName: string | null;

  constructor(
    code: NoteImportErrorCode,
    message: string,
    fileName: string | null = null,
  ) {
    super(message);
    this.name = 'NoteImportError';
    this.code = code;
    this.fileName = fileName;
  }
}

export type ImportedBlockDraft = {
  type: KnownBlockType;
  payload: BlockPayload;
};

export type ImportedTodoDraft = {
  /** 对应 `blocks` 中 `type === 'todo'` 的下标。 */
  blockIndex: number;
  title: string;
  done: boolean;
};

export type ParsedNoteImport = {
  title: string;
  format: NoteImportFormat;
  blocks: ImportedBlockDraft[];
  todos: ImportedTodoDraft[];
  warnings: string[];
};

export type ParsedNoteFile = ParsedNoteImport & {
  fileName: string;
  byteSize: number;
};

const FORMAT_BY_EXTENSION: Readonly<Record<string, NoteImportFormat>> = {
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  txt: 'text',
};

export function noteImportFormatOf(
  fileName: string,
): NoteImportFormat | null {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  if (!match) {
    return null;
  }
  return FORMAT_BY_EXTENSION[match[1].toLowerCase()] ?? null;
}

export function noteImportFormatLabel(format: NoteImportFormat): string {
  if (format === 'markdown') return 'Markdown';
  if (format === 'html') return 'HTML';
  return '纯文本';
}

function baseName(fileName: string): string {
  return fileName.split(/[\\/]/).pop() ?? fileName;
}

function cleanTitle(value: string, fallback: string): string {
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return text || fallback;
}

function fallbackTitle(fileName: string): string {
  const base = baseName(fileName).replace(/\.[^.]+$/, '');
  return cleanTitle(base, '未命名笔记');
}

/** UTF-8 BOM / UTF-16 BOM → UTF-8 → GB18030；都失败才报编码未知。 */
export function decodeNoteImportBytes(bytes: Uint8Array): string {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // 继续尝试中文常见的历史编码。
  }
  try {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes);
  } catch {
    throw new NoteImportError(
      'IMPORT_ENCODING_UNKNOWN',
      '无法识别文件编码；请另存为 UTF-8 后重试',
    );
  }
}

function normalizeText(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '');
}

function markValue(marks: InlineMarks): InlineMarks | undefined {
  const entries = Object.entries(marks).filter(
    ([, value]) => value !== undefined && value !== false,
  );
  return entries.length > 0 ? ({ ...marks } as InlineMarks) : undefined;
}

function pushRun(
  out: InlineRun[],
  text: string,
  marks: InlineMarks,
): void {
  if (!text) {
    return;
  }
  const normalized = markValue(marks);
  out.push(normalized ? { text, marks: normalized } : { text });
}

function trimRuns(runs: ReadonlyArray<InlineRun>): InlineRun[] {
  const merged = mergeRuns(runs);
  const text = runsToPlainText(merged);
  const leading = text.length - text.trimStart().length;
  const trailing = text.length - text.trimEnd().length;
  return sliceRuns(merged, leading, text.length - trailing);
}

function findClosingBracket(text: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function findClosingParen(text: string, openIndex: number): number {
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === ')') {
      return index;
    }
  }
  return -1;
}

function findToken(
  text: string,
  from: number,
  token: string,
): number {
  let index = text.indexOf(token, from);
  while (index >= 0) {
    if (text[index - 1] !== '\\') {
      return index;
    }
    index = text.indexOf(token, index + token.length);
  }
  return -1;
}

/**
 * 轻量 Markdown 行内格式：粗体、斜体、删除线、行内代码、链接与图片占位。
 * 不支持表格/公式等块级语法；未知反斜杠转义按字面保留。
 */
function parseInlineMarkdown(
  text: string,
  warnings: string[],
  baseMarks: InlineMarks = {},
): InlineRun[] {
  const out: InlineRun[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) {
      pushRun(out, buffer, baseMarks);
      buffer = '';
    }
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index];

    if (char === '\\' && index + 1 < text.length) {
      buffer += text[index + 1];
      index += 2;
      continue;
    }

    if (char === '`') {
      const open = /^(`+)/.exec(text.slice(index));
      const marker = open?.[1] ?? '`';
      const close = findToken(text, index + marker.length, marker);
      if (close >= 0) {
        flush();
        pushRun(
          out,
          text.slice(index + marker.length, close),
          { ...baseMarks, code: true },
        );
        index = close + marker.length;
        continue;
      }
      buffer += marker;
      index += marker.length;
      continue;
    }

    if (char === '!' && text[index + 1] === '[') {
      const closeBracket = findClosingBracket(text, index + 1);
      if (closeBracket >= 0 && text[closeBracket + 1] === '(') {
        const closeParen = findClosingParen(text, closeBracket + 2);
        if (closeParen >= 0) {
          const alt = text.slice(index + 2, closeBracket).trim();
          const src = text
            .slice(closeBracket + 2, closeParen)
            .trim()
            .split(/\s+/)[0];
          warnings.push(
            `图片未导入（Markdown 只保留占位）：${src || alt || '未命名图片'}`,
          );
          buffer += alt ? `[图片：${alt}]` : '[图片]';
          index = closeParen + 1;
          continue;
        }
      }
    }

    if (char === '[') {
      const closeBracket = findClosingBracket(text, index);
      if (closeBracket >= 0 && text[closeBracket + 1] === '(') {
        const closeParen = findClosingParen(text, closeBracket + 2);
        if (closeParen >= 0) {
          flush();
          const label = text.slice(index + 1, closeBracket);
          const rawTarget = text.slice(closeBracket + 2, closeParen).trim();
          const url = rawTarget
            .split(/\s+/)[0]
            .replace(/^<|>$/g, '');
          const safeUrl = url ? sanitizeLinkUrl(url) : null;
          if (safeUrl) {
            const inner = parseInlineMarkdown(label || safeUrl, warnings, {
              ...baseMarks,
              link: safeUrl,
            });
            out.push(...inner);
          } else {
            if (url) {
              warnings.push(`链接协议不安全，已按纯文本导入：${url}`);
            }
            out.push(...parseInlineMarkdown(label || url, warnings, baseMarks));
          }
          index = closeParen + 1;
          continue;
        }
      }
    }

    if (text.startsWith('**', index) || text.startsWith('__', index)) {
      const marker = text.slice(index, index + 2);
      const close = findToken(text, index + 2, marker);
      if (close > index + 2) {
        flush();
        out.push(
          ...parseInlineMarkdown(
            text.slice(index + 2, close),
            warnings,
            { ...baseMarks, bold: true },
          ),
        );
        index = close + marker.length;
        continue;
      }
    }

    if (text.startsWith('~~', index)) {
      const close = findToken(text, index + 2, '~~');
      if (close > index + 2) {
        flush();
        out.push(
          ...parseInlineMarkdown(
            text.slice(index + 2, close),
            warnings,
            { ...baseMarks, strike: true },
          ),
        );
        index = close + 2;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      const previous = index > 0 ? text[index - 1] : '';
      if (char !== '_' || !previous || !/[A-Za-z0-9]/.test(previous)) {
        const close = findToken(text, index + 1, char);
        if (close > index + 1) {
          flush();
          out.push(
            ...parseInlineMarkdown(
              text.slice(index + 1, close),
              warnings,
              { ...baseMarks, italic: true },
            ),
          );
          index = close + 1;
          continue;
        }
      }
    }

    buffer += char;
    index += 1;
  }

  flush();
  return mergeRuns(out);
}

/*
 * `sanitizeLinkUrl` 位于安全模块；这里只复用现有规则，不复制第二份。
 */
function runsOf(block: ImportedBlockDraft): InlineRun[] {
  return normalizeInlineRuns(block.payload.runs);
}

function blockPlainText(block: ImportedBlockDraft): string {
  return runsToPlainText(runsOf(block)).trim();
}

function paragraphBlock(
  content: string,
  warnings: string[],
): ImportedBlockDraft | null {
  const runs = trimRuns(parseInlineMarkdown(content, warnings));
  if (runs.length === 0) {
    return null;
  }
  return {
    type: 'paragraph',
    payload: { runs } as unknown as BlockPayload,
  };
}

/**
 * 纯文本段落：不猜 Markdown 语法，`*`、`#`、`-` 都按字面保留。
 */
function plainParagraphBlock(text: string): ImportedBlockDraft | null {
  const runs = trimRuns([{ text }]);
  if (runs.length === 0) {
    return null;
  }
  return {
    type: 'paragraph',
    payload: { runs } as unknown as BlockPayload,
  };
}

/**
 * HTML 段落用 DOM 读取行内 marks（粗体/斜体/链接/颜色），而不是只取
 * textContent；这样清洗后的格式仍能在编辑器里继续编辑。
 */
function elementParagraphBlock(element: Element): ImportedBlockDraft | null {
  const runs = trimRuns(inlineRunsFromNode(element));
  if (runs.length === 0) {
    return null;
  }
  return {
    type: 'paragraph',
    payload: { runs } as unknown as BlockPayload,
  };
}

function dividerBlock(): ImportedBlockDraft {
  return { type: 'divider', payload: {} };
}

function pushDivider(blocks: ImportedBlockDraft[]): void {
  if (blocks[blocks.length - 1]?.type !== 'divider') {
    blocks.push(dividerBlock());
  }
}

function listIndent(raw: string): number {
  const width = raw.replace(/\t/g, '  ').length;
  return Math.max(0, Math.min(4, Math.floor(width / 2)));
}

const TODO_LINE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const BULLET_LINE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_LINE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;

function listBlock(
  line: string,
  warnings: string[],
): {
  block: ImportedBlockDraft;
  todo: Omit<ImportedTodoDraft, 'blockIndex'> | null;
} | null {
  const todoMatch = TODO_LINE.exec(line);
  if (todoMatch) {
    const runs = trimRuns(parseInlineMarkdown(todoMatch[3], warnings));
    const title = runsToPlainText(runs).trim();
    if (!title) {
      return null;
    }
    return {
      block: {
        type: 'todo',
        payload: {
          runs,
          checked: todoMatch[2].toLowerCase() === 'x',
        } as unknown as BlockPayload,
      },
      todo: {
        title,
        done: todoMatch[2].toLowerCase() === 'x',
      },
    };
  }
  const bullet = BULLET_LINE.exec(line);
  if (bullet) {
    const runs = trimRuns(parseInlineMarkdown(bullet[2], warnings));
    if (runs.length === 0) {
      return null;
    }
    return {
      block: {
        type: 'bullet_list',
        payload: {
          runs,
          indent: listIndent(bullet[1]),
        } as unknown as BlockPayload,
      },
      todo: null,
    };
  }
  const ordered = ORDERED_LINE.exec(line);
  if (ordered) {
    const runs = trimRuns(parseInlineMarkdown(ordered[3], warnings));
    if (runs.length === 0) {
      return null;
    }
    return {
      block: {
        type: 'ordered_list',
        payload: {
          runs,
          indent: listIndent(ordered[1]),
        } as unknown as BlockPayload,
      },
      todo: null,
    };
  }
  return null;
}

function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) {
    text = text.slice(1);
  }
  if (text.endsWith('|')) {
    text = text.slice(0, -1);
  }
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += char === '|' ? '|' : `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (escaped) {
    current += '\\';
  }
  cells.push(current.trim());
  return cells;
}

function tableAlignments(line: string): TextAlign[] | null {
  const cells = splitTableRow(line);
  if (cells.length === 0) {
    return null;
  }
  const aligns: TextAlign[] = [];
  for (const cell of cells) {
    const match = /^(:?)-{3,}(:?)$/.exec(cell.trim());
    if (!match) {
      return null;
    }
    aligns.push(match[1] && match[2] ? 'center' : match[2] ? 'right' : 'left');
  }
  return aligns;
}

function tableBlock(
  headerLine: string,
  separatorLine: string,
  bodyLines: ReadonlyArray<string>,
  warnings: string[],
): ImportedBlockDraft {
  const aligns = tableAlignments(separatorLine) ?? [];
  let rows = [splitTableRow(headerLine), ...bodyLines.map(splitTableRow)];
  if (rows.length > TABLE_MAX_ROWS) {
    warnings.push(`表格超过 ${TABLE_MAX_ROWS} 行，已截断多余内容`);
    rows = rows.slice(0, TABLE_MAX_ROWS);
  }
  const widest = Math.max(1, ...rows.map((row) => row.length));
  const width = Math.min(TABLE_MAX_COLUMNS, widest);
  if (widest > TABLE_MAX_COLUMNS) {
    warnings.push(`表格超过 ${TABLE_MAX_COLUMNS} 列，已截断多余列`);
  }
  const normalized = rows.map((row) =>
    Array.from({ length: width }, (_, index) => row[index] ?? ''),
  );
  const model: TableModel = {
    schemaVersion: 2,
    header: true,
    widths: Array.from({ length: width }, () => TABLE_DEFAULT_COL_WIDTH),
    rows: normalized.map((row) =>
      row.map((text, column) => ({
        text,
        align: aligns[column] ?? 'left',
        rowSpan: 1,
        colSpan: 1,
        covered: false,
      })),
    ),
  };
  return {
    type: 'table',
    payload: {
      rows: tablePayloadRows(model),
    } as unknown as BlockPayload,
  };
}

function isFenceLine(line: string): RegExpExecArray | null {
  return /^\s{0,3}(`{3,}|~{3,})\s*(.*)$/.exec(line);
}

function isTableSeparatorCandidate(line: string): boolean {
  return line.includes('|') && tableAlignments(line) !== null;
}

function isThematicBreak(line: string): boolean {
  return /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
}

/** Setext 标题的前一行必须是普通段落，不能是列表/引用/围栏等块标记。 */
function isParagraphLikeLine(line: string): boolean {
  return (
    line.trim().length > 0 &&
    !isFenceLine(line) &&
    !/^\s{0,3}(?:#{1,6}\s|>|[-*+]\s|\d{1,9}[.)]\s)/.test(line)
  );
}

function parseMarkdown(
  text: string,
  fallback: string,
): Omit<ParsedNoteImport, 'format'> {
  const warnings: string[] = [];
  const blocks: ImportedBlockDraft[] = [];
  const todos: ImportedTodoDraft[] = [];
  const lines = text.split('\n');
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    const content = paragraph.join('\n').replace(/^\n+|\n+$/g, '');
    paragraph = [];
    if (!content.trim()) {
      return;
    }
    if (/<[a-z][\w-]*(?:\s[^>]*)?>/i.test(content)) {
      warnings.push('Markdown 中的内嵌 HTML 已按纯文本导入');
    }
    const block = paragraphBlock(content, warnings);
    if (block) {
      blocks.push(block);
    }
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = isFenceLine(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1];
      const language = codeFenceLanguage(fence[2].split(/\s+/)[0] ?? '');
      const codeLines: string[] = [];
      let cursor = index + 1;
      const closing = new RegExp(
        `^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`,
      );
      while (cursor < lines.length && !closing.test(lines[cursor])) {
        codeLines.push(lines[cursor]);
        cursor += 1;
      }
      const closed = cursor < lines.length;
      if (!closed) {
        warnings.push('未闭合的代码围栏已按文件末尾处理');
      } else {
        cursor += 1;
      }
      const code = codeLines.join('\n').replace(/\n+$/, '');
      if (code.trim()) {
        blocks.push({
          type: 'code',
          payload: { code, language } as unknown as BlockPayload,
        });
      }
      index = cursor;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const raw = heading[2].replace(/\s+#+\s*$/, '').trim();
      if (raw) {
        const runs = trimRuns(parseInlineMarkdown(raw, warnings));
        if (runs.length > 0) {
          const level = Math.min(5, heading[1].length);
          blocks.push({
            type: `heading${level}` as KnownBlockType,
            payload: { runs } as unknown as BlockPayload,
          });
        }
      }
      index += 1;
      continue;
    }

    if (
      index + 1 < lines.length &&
      /^\s{0,3}=+\s*$/.test(lines[index + 1]) &&
      isParagraphLikeLine(line)
    ) {
      flushParagraph();
      const runs = trimRuns(parseInlineMarkdown(line, warnings));
      if (runs.length > 0) {
        blocks.push({
          type: 'heading1',
          payload: { runs } as unknown as BlockPayload,
        });
      }
      index += 2;
      continue;
    }

    if (
      index + 1 < lines.length &&
      /^\s{0,3}-{2,}\s*$/.test(lines[index + 1]) &&
      isParagraphLikeLine(line) &&
      !line.includes('|')
    ) {
      flushParagraph();
      const runs = trimRuns(parseInlineMarkdown(line, warnings));
      if (runs.length > 0) {
        blocks.push({
          type: 'heading2',
          payload: { runs } as unknown as BlockPayload,
        });
      }
      index += 2;
      continue;
    }

    if (isThematicBreak(line)) {
      flushParagraph();
      pushDivider(blocks);
      index += 1;
      continue;
    }

    if (
      index + 1 < lines.length &&
      isTableSeparatorCandidate(lines[index + 1]) &&
      line.includes('|')
    ) {
      flushParagraph();
      const bodyLines: string[] = [];
      let cursor = index + 2;
      while (
        cursor < lines.length &&
        lines[cursor].trim() &&
        lines[cursor].includes('|') &&
        !/^\s{0,3}>/.test(lines[cursor]) &&
        !isFenceLine(lines[cursor])
      ) {
        bodyLines.push(lines[cursor]);
        cursor += 1;
      }
      blocks.push(
        tableBlock(line, lines[index + 1], bodyLines, warnings),
      );
      index = cursor;
      continue;
    }

    const listed = listBlock(line, warnings);
    if (listed) {
      flushParagraph();
      if (listed.todo) {
        todos.push({
          blockIndex: blocks.length,
          ...listed.todo,
        });
      }
      blocks.push(listed.block);
      index += 1;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      flushParagraph();
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        quoteLines.push(
          lines[index].replace(/^\s{0,3}>\s?/, ''),
        );
        index += 1;
      }
      const content = quoteLines.join('\n').replace(/\n+$/, '');
      const runs = trimRuns(parseInlineMarkdown(content, warnings));
      if (runs.length > 0) {
        blocks.push({
          type: 'quote',
          payload: { runs } as unknown as BlockPayload,
        });
      }
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flushParagraph();

  let title = fallback;
  const heading1Index = blocks.findIndex(
    (block) => block.type === 'heading1' && blockPlainText(block),
  );
  if (heading1Index >= 0 && blocks.length > 1) {
    title = cleanTitle(blockPlainText(blocks[heading1Index]), fallback);
    blocks.splice(heading1Index, 1);
    for (const todo of todos) {
      if (todo.blockIndex > heading1Index) {
        todo.blockIndex -= 1;
      }
    }
  }

  return { title, blocks, todos, warnings };
}

type HtmlWalkContext = {
  warnings: string[];
  preLanguages: string[];
  preIndex: number;
};

function htmlElementChildren(element: Element): boolean {
  return Array.from(element.children).some((child) =>
    [
      'address',
      'article',
      'aside',
      'blockquote',
      'div',
      'dl',
      'fieldset',
      'figcaption',
      'figure',
      'footer',
      'form',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'header',
      'hr',
      'li',
      'main',
      'nav',
      'ol',
      'p',
      'pre',
      'section',
      'table',
      'ul',
    ].includes(child.tagName.toLowerCase()),
  );
}

function collectHtmlList(
  list: Element,
  ordered: boolean,
  indent: number,
  out: ImportedBlockDraft[],
  context: HtmlWalkContext,
): void {
  for (const item of Array.from(list.children)) {
    if (item.tagName.toLowerCase() !== 'li') {
      continue;
    }
    const nested = Array.from(item.children).filter((child) =>
      ['ul', 'ol'].includes(child.tagName.toLowerCase()),
    );
    const clone = item.cloneNode(true) as Element;
    clone.querySelectorAll('ul, ol').forEach((node) => node.remove());
    const runs = trimRuns(inlineRunsFromNode(clone));
    if (runs.length > 0) {
      out.push({
        type: ordered ? 'ordered_list' : 'bullet_list',
        payload: {
          runs,
          indent: Math.min(4, indent),
        } as unknown as BlockPayload,
      });
    }
    for (const child of nested) {
      collectHtmlList(
        child,
        child.tagName.toLowerCase() === 'ol',
        Math.min(4, indent + 1),
        out,
        context,
      );
    }
  }
}

function htmlTableBlock(
  table: Element,
  warnings: string[],
): ImportedBlockDraft | null {
  const rowElements = Array.from(table.querySelectorAll('tr'));
  const header = Boolean(table.querySelector('thead'));
  let rows = rowElements
    .map((row) =>
      Array.from(row.children)
        .filter((cell) => ['td', 'th'].includes(cell.tagName.toLowerCase()))
        .map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()),
    )
    .filter((row) => row.length > 0);
  if (rows.length === 0) {
    return null;
  }
  if (rows.length > TABLE_MAX_ROWS) {
    warnings.push(`表格超过 ${TABLE_MAX_ROWS} 行，已截断多余内容`);
    rows = rows.slice(0, TABLE_MAX_ROWS);
  }
  const widest = Math.max(1, ...rows.map((row) => row.length));
  const width = Math.min(TABLE_MAX_COLUMNS, widest);
  if (widest > TABLE_MAX_COLUMNS) {
    warnings.push(`表格超过 ${TABLE_MAX_COLUMNS} 列，已截断多余列`);
  }
  const normalized = rows.map((row) =>
    Array.from({ length: width }, (_, index) => row[index] ?? ''),
  );
  const model: TableModel = {
    schemaVersion: 2,
    header,
    widths: Array.from({ length: width }, () => TABLE_DEFAULT_COL_WIDTH),
    rows: normalized.map((row) =>
      row.map((text) => ({
        text,
        align: 'left',
        rowSpan: 1,
        colSpan: 1,
        covered: false,
      })),
    ),
  };
  return {
    type: 'table',
    payload: {
      rows: tablePayloadRows(model),
    } as unknown as BlockPayload,
  };
}

function walkHtml(
  parent: Node,
  out: ImportedBlockDraft[],
  context: HtmlWalkContext,
): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? '';
      if (text.trim()) {
        const block = plainParagraphBlock(text);
        if (block) {
          out.push(block);
        }
      }
      continue;
    }
    if (node.nodeType !== 1) {
      continue;
    }
    const element = node as Element;
    const tag = element.tagName.toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      const level = Math.min(5, Number(tag.slice(1)));
      const runs = trimRuns(inlineRunsFromNode(element));
      if (runs.length > 0) {
        out.push({
          type: `heading${level}` as KnownBlockType,
          payload: { runs } as unknown as BlockPayload,
        });
      }
      continue;
    }

    if (tag === 'p') {
      if (htmlElementChildren(element)) {
        walkHtml(element, out, context);
        continue;
      }
      const block = elementParagraphBlock(element);
      if (block) {
        out.push(block);
      }
      continue;
    }

    if (tag === 'ul' || tag === 'ol') {
      collectHtmlList(element, tag === 'ol', 0, out, context);
      continue;
    }

    if (tag === 'blockquote') {
      const runs = trimRuns(inlineRunsFromNode(element));
      if (runs.length > 0) {
        out.push({
          type: 'quote',
          payload: { runs } as unknown as BlockPayload,
        });
      } else {
        walkHtml(element, out, context);
      }
      continue;
    }

    if (tag === 'pre') {
      const language = context.preLanguages[context.preIndex] ?? '';
      context.preIndex += 1;
      const code = (element.textContent ?? '').replace(/\n+$/, '');
      if (code.trim()) {
        out.push({
          type: 'code',
          payload: {
            code,
            language: codeFenceLanguage(language),
          } as unknown as BlockPayload,
        });
      }
      continue;
    }

    if (tag === 'hr') {
      pushDivider(out);
      continue;
    }

    if (tag === 'table') {
      const tableBlock = htmlTableBlock(element, context.warnings);
      if (tableBlock) {
        out.push(tableBlock);
      }
      continue;
    }

    if (
      [
        'div',
        'section',
        'article',
        'header',
        'footer',
        'main',
        'nav',
        'aside',
        'figure',
        'figcaption',
      ].includes(tag)
    ) {
      if (htmlElementChildren(element)) {
        walkHtml(element, out, context);
      } else {
        const block = elementParagraphBlock(element);
        if (block) {
          out.push(block);
        }
      }
      continue;
    }

    const block = elementParagraphBlock(element);
    if (block) {
      out.push(block);
    }
  }
}

function collectPreLanguages(doc: Document): string[] {
  return Array.from(doc.querySelectorAll('pre')).map((pre) => {
    const code = pre.querySelector('code');
    const className =
      code
        ?.getAttribute('class')
        ?.split(/\s+/)
        .find((name) => name.startsWith('language-')) ?? '';
    return (
      code?.getAttribute('data-language') ||
      pre.getAttribute('data-language') ||
      (className ? className.slice('language-'.length) : '')
    );
  });
}

function parseHtml(
  html: string,
  fallback: string,
): Omit<ParsedNoteImport, 'format'> {
  const warnings: string[] = [];
  let rawDoc: Document;
  try {
    rawDoc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    throw new NoteImportError(
      'IMPORT_PARSE_FAILED',
      'HTML 无法解析；请确认文件结构完整',
    );
  }

  const documentTitle = cleanTitle(rawDoc.title ?? '', '');
  const firstHeading = cleanTitle(
    rawDoc.querySelector('h1')?.textContent ?? '',
    '',
  );
  let title = documentTitle || firstHeading || fallback;

  const sanitized = sanitizePastedHtml(html);
  if (!sanitized.trim()) {
    throw new NoteImportError(
      'IMPORT_NO_CONTENT',
      'HTML 清洗后没有可导入的正文（只有脚本/样式或空白）',
    );
  }

  const doc = new DOMParser().parseFromString(sanitized, 'text/html');
  const context: HtmlWalkContext = {
    warnings,
    preLanguages: collectPreLanguages(rawDoc),
    preIndex: 0,
  };
  const blocks: ImportedBlockDraft[] = [];
  walkHtml(doc.body, blocks, context);

  if (blocks.length === 0) {
    throw new NoteImportError(
      'IMPORT_NO_CONTENT',
      'HTML 清洗后没有可导入的正文',
    );
  }

  /*
   * 常见网页的 `<title>` 与首个 `<h1>` 相同；此时把 h1 视为标题，避免正文
   * 里再出现一次同名大标题。标题不同则保留 h1，它属于正文结构。
   */
  if (firstHeading && (!documentTitle || documentTitle === firstHeading)) {
    const headingIndex = blocks.findIndex(
      (block) =>
        block.type === 'heading1' && blockPlainText(block) === firstHeading,
    );
    if (headingIndex >= 0 && blocks.length > 1) {
      blocks.splice(headingIndex, 1);
    } else if (headingIndex >= 0 && blocks.length === 1) {
      title = fallback;
    }
  }

  return { title, blocks, todos: [], warnings };
}

function looksLikeTextTitle(line: string): boolean {
  const text = line.trim();
  if (!text || text.length > 60) {
    return false;
  }
  if (/^(#{1,6}\s|[-*+]\s|>\s?|\d{1,9}[.)]\s)/.test(text)) {
    return false;
  }
  if (/[|]/.test(text)) {
    return false;
  }
  return !/[。！？.!?;；:：,，]$/.test(text);
}

function parseText(
  text: string,
  fallback: string,
): Omit<ParsedNoteImport, 'format'> {
  const paragraphs = text
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.replace(/^[ \t]+|[ \t]+$/g, ''))
    .filter((paragraph) => paragraph.trim());

  if (paragraphs.length === 0) {
    throw new NoteImportError('IMPORT_EMPTY', '文件没有可导入的正文');
  }

  let title = fallback;
  let body = paragraphs;
  if (paragraphs.length > 1 && looksLikeTextTitle(paragraphs[0])) {
    title = cleanTitle(paragraphs[0], fallback);
    body = paragraphs.slice(1);
  } else if (paragraphs.length === 1) {
    const lines = paragraphs[0].split('\n');
    if (lines.length > 1 && looksLikeTextTitle(lines[0])) {
      title = cleanTitle(lines[0], fallback);
      body = [lines.slice(1).join('\n')].filter((line) => line.trim());
    }
  }

  const blocks: ImportedBlockDraft[] = body
    .map((paragraph) => plainParagraphBlock(paragraph))
    .filter((block): block is ImportedBlockDraft => block !== null);
  if (blocks.length === 0) {
    // 首行被当作标题后没有正文：退回“文件名作标题 + 首行作正文”，
    // 不让一个只有标题的文件变成空笔记。
    title = fallback;
    const fallbackBlocks = paragraphs
      .map((paragraph) => plainParagraphBlock(paragraph))
      .filter((block): block is ImportedBlockDraft => block !== null);
    blocks.push(...fallbackBlocks);
  }
  return { title, blocks, todos: [], warnings: [] };
}

export function parseNoteImportFile(input: {
  fileName: string;
  bytes: Uint8Array;
}): ParsedNoteFile {
  const fileName = baseName(input.fileName);
  const format = noteImportFormatOf(fileName);
  if (!format) {
    throw new NoteImportError(
      'IMPORT_UNSUPPORTED_FORMAT',
      '仅支持 Markdown（.md/.markdown）、HTML（.html/.htm）和纯文本（.txt）',
      fileName,
    );
  }
  if (input.bytes.byteLength > NOTE_IMPORT_MAX_FILE_BYTES) {
    throw new NoteImportError(
      'IMPORT_TOO_LARGE',
      '单个文件超过 10 MB，请拆分后再导入',
      fileName,
    );
  }

  let text: string;
  try {
    text = normalizeText(decodeNoteImportBytes(input.bytes));
  } catch (error) {
    if (error instanceof NoteImportError) {
      throw new NoteImportError(error.code, error.message, fileName);
    }
    throw new NoteImportError(
      'IMPORT_ENCODING_UNKNOWN',
      '无法识别文件编码；请另存为 UTF-8 后重试',
      fileName,
    );
  }

  if (!text.trim()) {
    throw new NoteImportError('IMPORT_EMPTY', '文件为空或只有空白', fileName);
  }

  const fallback = fallbackTitle(fileName);
  let parsed: Omit<ParsedNoteImport, 'format'>;
  try {
    if (format === 'markdown') {
      parsed = parseMarkdown(text, fallback);
    } else if (format === 'html') {
      parsed = parseHtml(text, fallback);
    } else {
      parsed = parseText(text, fallback);
    }
  } catch (error) {
    if (error instanceof NoteImportError) {
      throw new NoteImportError(error.code, error.message, fileName);
    }
    throw new NoteImportError(
      'IMPORT_PARSE_FAILED',
      error instanceof Error ? error.message : '解析失败',
      fileName,
    );
  }

  if (parsed.blocks.length === 0) {
    throw new NoteImportError(
      'IMPORT_NO_CONTENT',
      '文件没有可导入的正文',
      fileName,
    );
  }

  return {
    ...parsed,
    title: cleanTitle(parsed.title, fallback),
    format,
    fileName,
    byteSize: input.bytes.byteLength,
  };
}

function importId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export type NoteImportBundleOptions = {
  folderId: string | null;
  /** 测试注入稳定 ID；正式运行使用随机 UUID。 */
  idFactory?: (prefix: string) => string;
};

/**
 * 把解析结果物化为一次原子写入的输入。块和待办在这里才生成稳定 ID；
 * 待办块 payload.todoId 与 note_todos.id 指向同一条记录。
 */
export function createNoteImportBundle(
  parsed: ParsedNoteImport,
  options: NoteImportBundleOptions,
): ImportNoteInput {
  const newId = options.idFactory ?? importId;
  const todoIds = new Map<number, string>();
  for (const todo of parsed.todos) {
    todoIds.set(todo.blockIndex, newId('todo'));
  }

  const blocks = parsed.blocks.map((block, index) => {
    const todoId = todoIds.get(index);
    const payload =
      block.type === 'todo' && todoId
        ? ({ ...block.payload, todoId } as BlockPayload)
        : block.payload;
    return {
      id: newId('block'),
      blockType: block.type,
      orderKey: (index + 1) * 1024,
      payload,
      schemaVersion: 1,
    };
  });

  return {
    note: {
      title: cleanTitle(parsed.title, '未命名笔记'),
      folderId: options.folderId,
      tags: [],
      body: blocksToHtml(
        blocks.map((block) => ({
          type: block.blockType,
          payload: block.payload,
        })),
      ),
      bodyFormat: 'html',
    },
    blocks,
    todos: parsed.todos.map((todo, index) => ({
      id: todoIds.get(todo.blockIndex) ?? newId('todo'),
      title: todo.title,
      done: todo.done,
      sortOrder: index,
    })),
  };
}

/** 测试辅助：把导入 bundle 转成编辑器块，便于验证“导入后可编辑/导出”。 */
export function noteImportBundleToEditorBlocks(
  bundle: ImportNoteInput,
  noteId: string,
): EditorBlock[] {
  const now = new Date().toISOString();
  return bundle.blocks.map((block) => ({
    id: block.id,
    noteId,
    type: block.blockType,
    orderKey: block.orderKey,
    payload: block.payload as unknown as BlockPayload,
    schemaVersion: block.schemaVersion ?? 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 1,
  }));
}
