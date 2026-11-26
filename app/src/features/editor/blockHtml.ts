/**
 * 块文档 → HTML 兼容缓存。
 *
 * `note_blocks` 是编辑器正文的权威投影；`notes.body` 仍被笔记列表、Markdown
 * 导出、任务回链等旧接口读取。编辑器每次落库后调用这里生成 HTML，写回
 * `notes.body`，保证旧读写接口（NoteSource.update）继续有效。
 *
 * 这里只做结构投影，不承担编辑器渲染。所有文本先转义，链接只保留
 * http / https / mailto 与合法的 `zhixing://note/<id>` 内链，避免兼容缓存
 * 里出现可执行内容；站内内链保留后，反向链接与 Markdown 导出才能继续工作。
 */

import katex from 'katex';
import type { KatexOptions } from 'katex';

import type { BlockPayload } from '../../data/repositories/blocks';
import { runsToHtml, runsToPlainText } from './inline';
import { escapeAttribute, escapeHtml, sanitizeLinkUrl } from './security';
import {
  blockBoard,
  blockChecked,
  blockCode,
  blockFile,
  blockLanguage,
  blockLink,
  blockRuns,
  blockTableModel,
  blockTableRows,
  codeFenceLanguage,
  headingLevel,
  isTextualBlockType,
  tableAnchorAt,
  type TableCell,
  type TableModel,
} from './types';

export type HtmlBlock = {
  type: string;
  payload: BlockPayload;
};

// ---------------------------------------------------------------------------
// 公式（ZX-FORMULA-01）
// ---------------------------------------------------------------------------

export type FormulaDisplayMode = 'block' | 'inline';

/**
 * 公式渲染参数：预览、阅读态与「导出 HTML」共用这一份配置。
 * `trust: false` 禁止 \href / \url / \includegraphics 生成可点击内容；
 * `strict: 'ignore'` 容忍常见非标准写法，避免控制台警告；`maxExpand`
 * 防止宏展开炸弹。KaTeX 是纯离线 JS，不请求 CDN。
 */
export const KATEX_OPTIONS: KatexOptions = {
  throwOnError: true,
  strict: 'ignore',
  trust: false,
  output: 'htmlAndMathml',
  maxExpand: 1000,
};

export type FormulaRenderResult =
  | { status: 'empty'; display: FormulaDisplayMode; source: string }
  | {
      status: 'ok';
      display: FormulaDisplayMode;
      source: string;
      html: string;
    }
  | {
      status: 'error';
      display: FormulaDisplayMode;
      source: string;
      /** KaTeX 原始错误文案（含 position 与上下文）。 */
      message: string;
      /** 去掉 “KaTeX parse error:” 前缀后的简短原因。 */
      rawMessage: string;
      /** 0 基字符位置；无法定位时为 null。 */
      position: number | null;
      line: number | null;
      column: number | null;
      excerpt: string;
      caret: string;
    };

/** payload.display 的防御式读取；旧数据默认块级。 */
export function formulaDisplayMode(
  payload: BlockPayload,
): FormulaDisplayMode {
  return payload.display === 'inline' ? 'inline' : 'block';
}

/**
 * 剥离粘贴/旧数据里成对的 `$…$` / `$$…$$` 定界符。
 * 只剥离“整段就是一对定界符”的情况，避免误伤公式内部的合法字符。
 */
export function splitFormulaDelimiters(latex: string): {
  source: string;
  display: FormulaDisplayMode | null;
} {
  const trimmed = latex.trim();
  if (!trimmed) {
    return { source: latex, display: null };
  }
  const block = /^\$\$([\s\S]+)\$\$$/.exec(trimmed);
  if (block && block[1].trim()) {
    return { source: block[1], display: 'block' };
  }
  const inline = /^\$([^$\n]+)\$$/.exec(trimmed);
  if (inline && inline[1].trim()) {
    return { source: inline[1], display: 'inline' };
  }
  return { source: latex, display: null };
}

function formulaErrorResult(
  error: unknown,
  source: string,
  display: FormulaDisplayMode,
): FormulaRenderResult {
  const fallback =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : '公式渲染失败';
  let message = fallback || '公式渲染失败';
  let rawMessage = message.replace(/^KaTeX parse error:\s*/, '');
  let position: number | null = null;

  if (error instanceof katex.ParseError) {
    message = error.message || fallback;
    rawMessage = error.rawMessage || rawMessage;
    if (Number.isFinite(error.position)) {
      position = Math.max(0, Math.min(error.position, source.length));
    }
  }

  let line: number | null = null;
  let column: number | null = null;
  let excerpt = '';
  let caret = '';
  if (position !== null) {
    const before = source.slice(0, position);
    line = before.split('\n').length;
    const lineStart = before.lastIndexOf('\n');
    column = position - lineStart;
    const lineText = source.split('\n')[line - 1] ?? '';
    const caretIndex = Math.max(0, Math.min(column - 1, lineText.length));
    const windowSize = 48;
    const from = Math.max(0, caretIndex - windowSize);
    const to = Math.min(lineText.length, caretIndex + windowSize);
    const prefix = from > 0 ? '…' : '';
    const suffix = to < lineText.length ? '…' : '';
    excerpt = `${prefix}${lineText.slice(from, to)}${suffix}`;
    caret = `${' '.repeat(prefix.length + caretIndex - from)}^`;
  }

  return {
    status: 'error',
    display,
    source,
    message,
    rawMessage,
    position,
    line,
    column,
    excerpt,
    caret,
  };
}

/**
 * 移除 MathML 里的 `<annotation>`：KaTeX 默认把 LaTeX 源塞进
 * `annotation[encoding="application/x-tex"]`，阅读态/导出的 DOM 文本会因此
 * 混入源码。视觉层与 MathML 语义保持不变。
 */
function stripTexAnnotation(html: string): string {
  return html.replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, '');
}

/**
 * 用 KaTeX 渲染一份公式源。预览、阅读态与导出 HTML 都走这里，保证
 * “预览与导出一致”。错误不会抛出到组件外，而是返回可展示的错误对象。
 */
export function renderFormula(
  latex: string,
  preferredDisplay: FormulaDisplayMode = 'block',
): FormulaRenderResult {
  const { source, display: detected } = splitFormulaDelimiters(latex);
  const display = detected ?? preferredDisplay;
  if (!source.trim()) {
    return { status: 'empty', display, source };
  }
  try {
    const html = stripTexAnnotation(
      katex.renderToString(source, {
        ...KATEX_OPTIONS,
        displayMode: display !== 'inline',
      }),
    );
    return { status: 'ok', display, source, html };
  } catch (error) {
    return formulaErrorResult(error, source, display);
  }
}

/**
 * `notes.body` 兼容缓存里的公式投影。
 *
 * 这里刻意不缓存 KaTeX HTML（渲染结果是派生数据）：块级公式写成带
 * `data-language="latex"` 的 `<pre>`，行内公式写成 `<code>`。这样
 * Markdown 导出得到**逐字符一致**的 LaTeX 源（反斜杠不会被 Markdown
 * 转义二次处理），HTML/PDF/Word 里也有可读的代码表示；真正的富文本
 * HTML 由公式块的「导出」弹窗用同一份 `renderFormula` 生成。
 */
function formulaHtml(block: HtmlBlock): string {
  const latex =
    typeof block.payload.latex === 'string' ? block.payload.latex : '';
  const preferred = formulaDisplayMode(block.payload);
  const { source, display: detected } = splitFormulaDelimiters(latex);
  const display = detected ?? preferred;
  const attrs = `data-latex="${escapeAttribute(latex)}" data-display="${display}"`;
  if (!source.trim()) {
    return `<div class="zx-formula zx-formula-empty" ${attrs}></div>`;
  }
  if (display === 'inline') {
    return `<div class="zx-formula zx-formula-inline" ${attrs}><code class="zx-formula-latex">${escapeHtml(
      source,
    )}</code></div>`;
  }
  return `<div class="zx-formula zx-formula-block" ${attrs}><pre class="zx-formula-source" data-language="latex"><code class="language-latex">${escapeHtml(
    source,
  )}</code></pre></div>`;
}

function paragraphHtml(content: string): string {
  return content ? `<p>${content}</p>` : '<p><br></p>';
}

function listHtml(block: HtmlBlock, ordered: boolean): string {
  const content = runsToHtml(blockRuns(block));
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}><li>${content || '<br>'}</li></${tag}>`;
}

function todoHtml(block: HtmlBlock): string {
  const checked = blockChecked(block) ? ' checked' : '';
  const content = runsToHtml(blockRuns(block));
  return `<p class="zx-todo"><input type="checkbox" disabled${checked}>${
    content ? ` ${content}` : '<br>'
  }</p>`;
}

function codeHtml(block: HtmlBlock): string {
  const language = codeFenceLanguage(blockLanguage(block));
  const code = escapeHtml(blockCode(block));
  if (!language) {
    return `<pre class="zxe-code-fence"><code>${code}</code></pre>`;
  }
  const safe = escapeAttribute(language);
  return `<pre class="zxe-code-fence" data-language="${safe}"><code class="language-${safe}">${code}</code></pre>`;
}

function tableCellHtml(
  cell: TableCell,
  tag: 'th' | 'td',
): string {
  const attrs: string[] = [];
  if (tag === 'th') {
    attrs.push('scope="col"');
  }
  if (cell.rowSpan > 1) {
    attrs.push(`rowspan="${cell.rowSpan}"`);
  }
  if (cell.colSpan > 1) {
    attrs.push(`colspan="${cell.colSpan}"`);
  }
  if (cell.align !== 'left') {
    attrs.push(`style="text-align:${cell.align}"`);
  }
  const content = escapeHtml(cell.text).replace(/\n/g, '<br>');
  const attrText = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
  return `<${tag}${attrText}>${content}</${tag}>`;
}

/**
 * 表格 HTML 导出/兼容缓存。
 *
 * 列宽通过 `<colgroup>` 保留；表头用 `<thead>`；合并保留 rowspan/colspan；
 * 非左对齐写入 style。文本一律转义。这个结果同时用于 `notes.body` 的兼容
 * 投影和表格工具栏的「导出 HTML」。
 */
export function tableToHtml(
  model: TableModel,
  options: { className?: string } = {},
): string {
  const className = options.className ? ` class="${escapeAttribute(options.className)}"` : '';
  const columns = model.widths
    .map((width) => `<col style="width:${width}px">`)
    .join('');
  const rowHtml = (rowIndex: number, tag: 'th' | 'td'): string => {
    const cells = model.rows[rowIndex]
      .map((cell, columnIndex) => {
        if (cell.covered) {
          return '';
        }
        const resolved =
          tableAnchorAt(model, rowIndex, columnIndex)?.cell ?? cell;
        return tableCellHtml(resolved, tag);
      })
      .join('');
    return `<tr>${cells}</tr>`;
  };

  const parts = [`<table${className}>`, `<colgroup>${columns}</colgroup>`];
  if (model.header) {
    parts.push(`<thead>${rowHtml(0, 'th')}</thead>`);
    parts.push('<tbody>');
    for (let row = 1; row < model.rows.length; row += 1) {
      parts.push(rowHtml(row, 'td'));
    }
    parts.push('</tbody>');
  } else {
    parts.push('<tbody>');
    for (let row = 0; row < model.rows.length; row += 1) {
      parts.push(rowHtml(row, 'td'));
    }
    parts.push('</tbody>');
  }
  parts.push('</table>');
  return parts.join('');
}

function tableHtml(block: HtmlBlock): string {
  return tableToHtml(blockTableModel(block).model);
}

function markdownSeparator(align: TableCell['align']): string {
  if (align === 'center') {
    return ':--:';
  }
  if (align === 'right') {
    return '--:';
  }
  return '---';
}

function markdownCell(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * 表格 Markdown 导出。
 *
 * - 有表头时用第 0 行；无表头时生成空表头行（Markdown 语法要求）；
 * - 对齐取表头单元格的 align；
 * - Markdown 不支持合并：锚点文本展开到它覆盖的每个逻辑坐标；
 * - 列宽用 HTML 注释保留可读表示，不改变 Markdown 渲染。
 */
export function tableToMarkdown(
  model: TableModel,
  options: { includeWidths?: boolean } = {},
): string {
  const columnCount = model.widths.length;
  const logicalText = (row: number, column: number): string => {
    const resolved = tableAnchorAt(model, row, column);
    return resolved ? resolved.cell.text : '';
  };
  const header = model.header
    ? model.rows[0].map((_cell, column) =>
        markdownCell(logicalText(0, column)),
      )
    : Array.from({ length: columnCount }, () => '');
  const aligns = model.header
    ? model.rows[0].map(
        (_cell, column) =>
          tableAnchorAt(model, 0, column)?.cell.align ?? 'left',
      )
    : Array.from({ length: columnCount }, () => 'left' as const);
  const firstDataRow = model.header ? 1 : 0;
  const body: string[] = [];
  for (let row = firstDataRow; row < model.rows.length; row += 1) {
    body.push(
      `| ${Array.from({ length: columnCount }, (_, column) =>
        markdownCell(logicalText(row, column)),
      ).join(' | ')} |`,
    );
  }
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${aligns.map(markdownSeparator).join(' | ')} |`,
    ...body,
  ];
  if (options.includeWidths !== false && model.widths.length > 0) {
    lines.push(`<!-- 列宽: ${model.widths.join('px, ')}px -->`);
  }
  return `${lines.join('\n')}\n`;
}

function fileHtml(block: HtmlBlock): string {
  const file = blockFile(block);
  const name = file.fileName || '未选择文件';
  return [
    '<div class="zx-file-card"',
    ` data-file-name="${escapeAttribute(file.fileName)}"`,
    ` data-byte-size="${file.byteSize}"`,
    ` data-status="${file.status}"`,
    '>',
    escapeHtml(name),
    `<span class="zx-file-card-state">${
      file.status === 'available'
        ? '已同步'
        : file.status === 'pending'
          ? '待同步'
          : file.status === 'missing'
            ? '文件缺失'
            : '本机已保存'
    }</span>`,
    '</div>',
  ].join('');
}

function linkHtml(block: HtmlBlock): string {
  const link = blockLink(block);
  const safeUrl = sanitizeLinkUrl(link.url);
  const label = link.title.trim() || safeUrl || link.url;
  if (!safeUrl) {
    return paragraphHtml(escapeHtml(label));
  }
  return `<p><a href="${escapeAttribute(safeUrl)}" rel="noreferrer noopener">${escapeHtml(
    label,
  )}</a></p>`;
}

function blockHtml(block: HtmlBlock): string {
  const type = block.type;
  if (type === 'paragraph') {
    return paragraphHtml(runsToHtml(blockRuns(block)));
  }
  const level = headingLevel(type);
  if (level) {
    return `<h${level}>${runsToHtml(blockRuns(block))}</h${level}>`;
  }
  if (type === 'todo') {
    return todoHtml(block);
  }
  if (type === 'bullet_list') {
    return listHtml(block, false);
  }
  if (type === 'ordered_list') {
    return listHtml(block, true);
  }
  if (type === 'quote') {
    return `<blockquote>${runsToHtml(blockRuns(block))}</blockquote>`;
  }
  if (type === 'code') {
    return codeHtml(block);
  }
  if (type === 'divider') {
    return '<hr>';
  }
  if (type === 'table') {
    return tableHtml(block);
  }
  if (type === 'file') {
    return fileHtml(block);
  }
  if (type === 'board') {
    const board = blockBoard(block);
    return `<div class="zx-board-ref"${
      board.boardId
        ? ` data-board-id="${escapeAttribute(board.boardId)}"`
        : ''
    }>画板：${escapeHtml(board.title)}</div>`;
  }
  if (type === 'formula') {
    return formulaHtml(block);
  }
  if (type === 'link') {
    return linkHtml(block);
  }
  // 未知块保留可读文本（兼容旧版 `text` payload 与插件数据）。
  const text =
    typeof block.payload.text === 'string' ? block.payload.text : '';
  return paragraphHtml(escapeHtml(text));
}

/** 把整篇块文档投影为 `notes.body` 使用的 HTML。 */
export function blocksToHtml(
  blocks: ReadonlyArray<HtmlBlock>,
): string {
  return blocks.map(blockHtml).join('');
}

function blockPlainText(block: HtmlBlock): string {
  const type = block.type;
  if (isTextualBlockType(type)) {
    return runsToPlainText(blockRuns(block));
  }
  if (type === 'code') {
    return blockCode(block);
  }
  if (type === 'table') {
    return blockTableRows(block)
      .map((row) => row.join(' '))
      .join('\n');
  }
  if (type === 'file') {
    return blockFile(block).fileName;
  }
  if (type === 'board') {
    return blockBoard(block).title;
  }
  if (type === 'formula') {
    return typeof block.payload.latex === 'string' ? block.payload.latex : '';
  }
  if (type === 'link') {
    const link = blockLink(block);
    return link.title.trim() || link.url;
  }
  return typeof block.payload.text === 'string' ? block.payload.text : '';
}

/** 字数统计；与 `htmlToPlainText(notes.body)` 的语义保持一致。 */
export function blocksToPlainText(
  blocks: ReadonlyArray<HtmlBlock>,
): string {
  return blocks
    .map(blockPlainText)
    .filter((text) => text.length > 0)
    .join('\n');
}
