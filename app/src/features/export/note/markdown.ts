/**
 * 单篇笔记 → Markdown（规范 §5.7）。
 *
 * 约定：
 * - UTF-8 无 BOM、`\n` 换行、文件末尾保留一个换行；
 * - 图片默认 base64，单张 ≤ 2 MB、合计 ≤ 20 MB；超限转占位符并报告；
 * - 表格复用 `tableToMarkdown`，保留表头/对齐/合并展开；
 * - 公式保留 LaTeX 源；内链保留 `zhixing://note/<id>`；
 * - Markdown 无法表达颜色/底色/列宽，降级项进入报告。
 */

import { codeFenceLanguage, type TableModel } from '../../editor/types';
import { tableToMarkdown } from '../../editor/blockHtml';
import { formatBytes } from '../utils';
import { noteMetaLines } from './document';
import type {
  NoteExportDocument,
  NoteExportRenderResult,
  NoteExportRun,
  NoteExportBlock,
} from './types';

const IMAGE_LIMIT_SINGLE = 2 * 1024 * 1024;
const IMAGE_LIMIT_TOTAL = 20 * 1024 * 1024;
const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64FromBytes(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const combined = (first << 16) | (second << 8) | third;
    output += BASE64[(combined >>> 18) & 63];
    output += BASE64[(combined >>> 12) & 63];
    output += index + 1 < bytes.length ? BASE64[(combined >>> 6) & 63] : '=';
    output += index + 2 < bytes.length ? BASE64[combined & 63] : '=';
  }
  return output;
}

function escapeMarkdownText(text: string): string {
  return text
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/([\\`*_[\]<>])/g, '\\$1');
}

function wrapInlineCode(text: string): string {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = '`'.repeat(Math.max(1, longest + 1));
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

function runMarkdown(run: NoteExportRun): string {
  const text = run.code ? run.text : escapeMarkdownText(run.text);
  if (!text) {
    return '';
  }
  let output = run.code ? wrapInlineCode(text) : text;
  if (run.underline) {
    output = `<u>${output}</u>`;
  }
  if (run.strike) {
    output = `~~${output}~~`;
  }
  if (run.italic) {
    output = `*${output}*`;
  }
  if (run.bold) {
    output = `**${output}**`;
  }
  if (run.link) {
    output = `[${output}](${run.link.href})`;
  }
  return output;
}

function runsMarkdown(runs: ReadonlyArray<NoteExportRun>): string {
  return runs.map(runMarkdown).join('');
}

function indentFor(indent: number): string {
  return '  '.repeat(Math.max(0, Math.min(6, indent)));
}

function safeParagraphStart(text: string): string {
  if (/^#{1,6}\s/.test(text)) {
    return `\\${text}`;
  }
  if (/^[-+>]\s/.test(text) || /^\d+\.\s/.test(text)) {
    return `\\${text}`;
  }
  return text;
}

function quoteLines(text: string, sourceLine: string): string {
  const lines = text.split('\n');
  const quoted = lines.map((line) => (line ? `> ${line}` : '>'));
  if (sourceLine) {
    quoted.push(`> — ${sourceLine}`);
  }
  return quoted.join('\n');
}

function quoteSource(block: Extract<NoteExportBlock, { kind: 'quote' }>): string {
  return [
    block.source,
    block.noteTitle ? `关联笔记《${block.noteTitle}》` : '',
    block.sourceUrl,
  ]
    .filter(Boolean)
    .join(' · ');
}

function imageMime(block: Extract<NoteExportBlock, { kind: 'image' }>): string {
  if (block.mime) {
    return block.mime;
  }
  const extension = block.fileName.split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'bmp') return 'image/bmp';
  if (extension === 'svg') return 'image/svg+xml';
  return 'image/png';
}

function tableMarkdown(model: TableModel): string {
  return tableToMarkdown(model, { includeWidths: false }).trimEnd();
}

function markdownBlock(
  block: NoteExportBlock,
  options: { includeImages: boolean; imageWarnings: string[]; state: { imageBytes: number } },
): string {
  switch (block.kind) {
    case 'paragraph': {
      const text = runsMarkdown(block.runs);
      return text ? safeParagraphStart(text) : '';
    }
    case 'heading':
      return `${'#'.repeat(Math.max(1, Math.min(5, block.level)))} ${runsMarkdown(
        block.runs,
      )}`;
    case 'todo':
      return `${indentFor(block.indent)}- [${block.checked ? 'x' : ' '}] ${runsMarkdown(
        block.runs,
      )}`;
    case 'bullet':
      return `${indentFor(block.indent)}- ${runsMarkdown(block.runs)}`;
    case 'ordered':
      return `${indentFor(block.indent)}${block.number}. ${runsMarkdown(
        block.runs,
      )}`;
    case 'quote':
      return quoteLines(runsMarkdown(block.runs), quoteSource(block));
    case 'code': {
      const language = codeFenceLanguage(block.language);
      const runs = block.code.match(/`+/g) ?? [];
      const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return `${fence}${language}\n${block.code}\n${fence}`;
    }
    case 'divider':
      return '---';
    case 'table':
      return tableMarkdown(block.model);
    case 'image': {
      const alt = escapeMarkdownText(block.alt || block.fileName || '图片');
      if (!options.includeImages || !block.asset) {
        return `![${alt}](图片未包含：导出时已关闭图片)`;
      }
      if (
        block.asset.status !== 'available' ||
        !block.asset.bytes ||
        !block.asset.blob
      ) {
        return `![${alt}](缺失：${escapeMarkdownText(
          block.fileName || block.asset.fileName || '图片',
        )})`;
      }
      const bytes = block.asset.bytes;
      if (bytes.byteLength > IMAGE_LIMIT_SINGLE) {
        options.imageWarnings.push(
          `图片「${block.fileName || block.asset.fileName}」超过 2 MB，Markdown 未内嵌。`,
        );
        return `![${alt}](图片未内嵌：超过大小上限)`;
      }
      if (options.state.imageBytes + bytes.byteLength > IMAGE_LIMIT_TOTAL) {
        options.imageWarnings.push(
          `图片「${block.fileName || block.asset.fileName}」超过 Markdown 合计 20 MB 上限，未内嵌。`,
        );
        return `![${alt}](图片未内嵌：超过合计大小上限)`;
      }
      options.state.imageBytes += bytes.byteLength;
      return `![${alt}](data:${imageMime(block)};base64,${base64FromBytes(
        bytes,
      )})`;
    }
    case 'file':
      return `📎 ${escapeMarkdownText(block.file.fileName || '未命名文件')}（${formatBytes(
        block.file.byteSize,
      )}）${
        block.file.status === 'missing' ? ' · 文件缺失' : ''
      }`;
    case 'board':
      return `🖼 画板：${escapeMarkdownText(block.title)}（在知心中打开）`;
    case 'formula':
      if (!block.latex.trim()) {
        return '（空公式）';
      }
      return block.display === 'inline'
        ? `$${block.latex}$`
        : `$$\n${block.latex}\n$$`;
    case 'link': {
      const label = escapeMarkdownText(block.title || block.url || '链接');
      return block.url ? `[${label}](${block.url})` : label;
    }
    case 'unknown': {
      if (block.blockType === 'legacy-html') {
        return block.text;
      }
      return block.text
        ? `［无法导出的块：${block.blockType}］ ${block.text}`
        : `［无法导出的块：${block.blockType}］`;
    }
  }
}

function tocMarkdown(document: NoteExportDocument): string {
  if (document.toc.length === 0) {
    return '';
  }
  return [
    '## 目录',
    '',
    ...document.toc.map(
      (heading) => `${'  '.repeat(Math.max(0, heading.level - 1))}- ${heading.text}`,
    ),
  ].join('\n');
}

function dedupe(items: ReadonlyArray<string>): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

export function renderNoteMarkdown(
  document: NoteExportDocument,
): NoteExportRenderResult {
  const warnings: string[] = [...document.warnings];
  const imageWarnings: string[] = [];
  const parts: string[] = [`# ${document.title}`, ''];

  if (document.options.includeMetadata) {
    const meta = noteMetaLines(document.meta);
    parts.push(meta.map((line) => `> ${line}`).join('\n'));
    parts.push('');
  }

  const toc = tocMarkdown(document);
  if (toc) {
    parts.push(toc);
    parts.push('');
  }

  if (document.blocks.length === 0) {
    parts.push('（空笔记）');
  } else {
    const state = { imageBytes: 0 };
    const body = document.blocks
      .map((block) =>
        markdownBlock(block, {
          includeImages: document.options.includeImages,
          imageWarnings,
          state,
        }),
      )
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (body) {
      parts.push(body);
    } else {
      parts.push('（空笔记）');
    }
  }

  if (document.facts.coloredRuns > 0) {
    warnings.push(
      `Markdown 不支持文字颜色/底色，${document.facts.coloredRuns} 处颜色未保留。`,
    );
  }
  if (document.facts.tables > 0) {
    warnings.push('Markdown 不支持表格列宽，列宽未保留（表头/对齐/合并已展开）。');
  }
  if (document.facts.internalLinks > 0) {
    warnings.push(
      `${document.facts.internalLinks} 个站内内链在导出文件外不可跳转，链接地址已保留。`,
    );
  }
  warnings.push(...imageWarnings);

  const markdown = `${parts.join('\n').replace(/\n+$/, '')}\n`;
  return {
    bytes: new TextEncoder().encode(markdown),
    mime: 'text/markdown;charset=utf-8',
    warnings: dedupe(warnings),
  };
}
