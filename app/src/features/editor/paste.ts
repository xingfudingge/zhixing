/**
 * 粘贴清洗与 HTML → 块。
 *
 * 粘贴内容先进入一个游离的 DOMParser 文档，按白名单删/拆标签、剥属性，
 * 再转成结构化 runs；原始 HTML 绝不会直接写进编辑器 DOM。
 *
 * 白名单之外的元素一律“去标签留文字”（script/style/iframe 等直接删除），
 * 事件属性、class/id、data-*、javascript: 链接全部丢弃。
 */

import type { BlockPayload } from '../../data/repositories/blocks';
import { inlineRunsFromNode, mergeRuns, stripTags } from './inline';
import { canonicalColor, escapeHtml, sanitizeLinkUrl } from './security';
import type { InlineRun, KnownBlockType } from './types';
import { normalizeInlineRuns } from './types';

export type PastedBlock = {
  type: KnownBlockType;
  payload: BlockPayload;
};

const DROP_TAGS = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'svg',
  'math',
  'canvas',
  'audio',
  'video',
  'source',
  'track',
]);

const ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
  'div',
  'em',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'section',
  'span',
  'strike',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);

function cleanAttributes(element: Element): void {
  const tag = element.tagName.toLowerCase();
  const href =
    tag === 'a' ? sanitizeLinkUrl(element.getAttribute('href')) : null;
  const color =
    tag === 'font' ? element.getAttribute('color') : null;
  const styleColor = canonicalColor((element as HTMLElement).style?.color);
  const styleBackground = canonicalColor(
    (element as HTMLElement).style?.backgroundColor ||
      (element as HTMLElement).style?.background,
  );
  const textAlign = (element as HTMLElement).style?.textAlign;
  const colspan = element.getAttribute('colspan');
  const rowspan = element.getAttribute('rowspan');

  for (const attribute of Array.from(element.attributes)) {
    element.removeAttribute(attribute.name);
  }

  if (tag === 'a' && href) {
    element.setAttribute('href', href);
    element.setAttribute('rel', 'noreferrer noopener');
  }
  const fontColor = canonicalColor(color);
  if (tag === 'font' && fontColor) {
    element.setAttribute('color', fontColor);
  }
  if (tag === 'span' || tag === 'font') {
    if (styleColor) {
      (element as HTMLElement).style.color = styleColor;
    }
    if (styleBackground) {
      (element as HTMLElement).style.backgroundColor = styleBackground;
    }
    if (
      textAlign === 'left' ||
      textAlign === 'center' ||
      textAlign === 'right' ||
      textAlign === 'justify'
    ) {
      (element as HTMLElement).style.textAlign = textAlign;
    }
  }
  if (tag === 'td' || tag === 'th') {
    const safeSpan = (value: string | null): string | null => {
      if (!value) {
        return null;
      }
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) && parsed >= 1 && parsed <= 20
        ? String(parsed)
        : null;
    };
    const safeColspan = safeSpan(colspan);
    const safeRowspan = safeSpan(rowspan);
    if (safeColspan) {
      element.setAttribute('colspan', safeColspan);
    }
    if (safeRowspan) {
      element.setAttribute('rowspan', safeRowspan);
    }
  }
}

function sanitizeChildren(parent: Node, doc: Document): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 8) {
      node.parentNode?.removeChild(node);
      continue;
    }
    if (node.nodeType === 3) {
      continue;
    }
    if (node.nodeType !== 1) {
      node.parentNode?.removeChild(node);
      continue;
    }
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    if (tag === 'img') {
      const alt = (element.getAttribute('alt') ?? '').trim();
      element.replaceWith(doc.createTextNode(alt ? `[图片：${alt}]` : '[图片]'));
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      // 保留子节点文本，丢弃未知标签本身。
      const fragment = doc.createDocumentFragment();
      while (element.firstChild) {
        fragment.appendChild(element.firstChild);
      }
      element.replaceWith(fragment);
      sanitizeChildren(fragment, doc);
      continue;
    }
    cleanAttributes(element);
    sanitizeChildren(element, doc);
  }
}

export function sanitizePastedHtml(html: string): string {
  if (!html.trim()) {
    return '';
  }
  if (typeof DOMParser === 'undefined') {
    return escapeHtml(stripTags(html));
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  sanitizeChildren(doc.body, doc);
  return doc.body.innerHTML;
}

function textBlock(
  type: KnownBlockType,
  runs: ReadonlyArray<InlineRun>,
  extra: Record<string, unknown> = {},
): PastedBlock | null {
  if (runs.length === 0) {
    return null;
  }
  return {
    type,
    payload: { runs: [...runs], ...extra } as unknown as BlockPayload,
  };
}

function collectList(
  list: Element,
  ordered: boolean,
  indent: number,
  out: PastedBlock[],
): void {
  for (const item of Array.from(list.children)) {
    if (item.tagName.toLowerCase() !== 'li') {
      continue;
    }
    const nested = Array.from(item.children).filter((child) =>
      ['ul', 'ol'].includes(child.tagName.toLowerCase()),
    );
    const clone = item.cloneNode(true) as Element;
    clone
      .querySelectorAll('ul,ol')
      .forEach((nestedList) => nestedList.remove());
    const runs = mergeRuns(inlineRunsFromNode(clone));
    if (runs.length > 0) {
      out.push({
        type: ordered ? 'ordered_list' : 'bullet_list',
        payload: { runs, indent },
      });
    }
    for (const child of nested) {
      collectList(
        child,
        child.tagName.toLowerCase() === 'ol',
        Math.min(6, indent + 1),
        out,
      );
    }
  }
}

function collectTable(table: Element): PastedBlock {
  const rows = Array.from(table.querySelectorAll('tr'))
    .slice(0, 40)
    .map((row) =>
      Array.from(row.children)
        .slice(0, 16)
        .map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()),
    )
    .filter((row) => row.length > 0);
  const width = Math.max(1, ...rows.map((row) => row.length));
  const normalized = rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ''),
  ]);
  return {
    type: 'table',
    payload: {
      rows:
        normalized.length > 0
          ? normalized
          : [['列 1', '列 2', '列 3'], ['', '', ''], ['', '', '']],
      header: true,
    },
  };
}

function collectBlocks(parent: Node, out: PastedBlock[]): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? '';
      if (text.trim()) {
        out.push({
          type: 'paragraph',
          payload: { runs: [{ text }] },
        });
      }
      continue;
    }
    if (node.nodeType !== 1) {
      continue;
    }
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5') {
      const block = textBlock(
        `heading${tag.slice(1)}` as KnownBlockType,
        inlineRunsFromNode(element),
      );
      if (block) {
        out.push(block);
      }
      continue;
    }
    if (tag === 'h6') {
      const block = textBlock('paragraph', inlineRunsFromNode(element));
      if (block) {
        out.push(block);
      }
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      collectList(element, tag === 'ol', 0, out);
      continue;
    }
    if (tag === 'blockquote') {
      const runs = mergeRuns(inlineRunsFromNode(element));
      if (runs.length > 0) {
        out.push({ type: 'quote', payload: { runs } });
      } else {
        collectBlocks(element, out);
      }
      continue;
    }
    if (tag === 'pre') {
      const code = (element.textContent ?? '').replace(/\n+$/, '');
      if (code) {
        out.push({ type: 'code', payload: { code, language: '' } });
      }
      continue;
    }
    if (tag === 'hr') {
      out.push({ type: 'divider', payload: {} });
      continue;
    }
    if (tag === 'table') {
      out.push(collectTable(element));
      continue;
    }
    if (tag === 'p' || tag === 'div' || tag === 'section') {
      const hasBlockChildren = Array.from(element.children).some((child) =>
        [
          'p',
          'div',
          'section',
          'ul',
          'ol',
          'blockquote',
          'pre',
          'table',
          'hr',
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
        ].includes(child.tagName.toLowerCase()),
      );
      if (hasBlockChildren) {
        collectBlocks(element, out);
        continue;
      }
      const block = textBlock('paragraph', inlineRunsFromNode(element));
      if (block) {
        out.push(block);
      }
      continue;
    }
    const block = textBlock('paragraph', inlineRunsFromNode(element));
    if (block) {
      out.push(block);
    }
  }
}

/**
 * 把粘贴 HTML 拆成块。单段文本会返回一个 paragraph；标题/列表/表格/代码
 * 会保留结构。函数只读取游离 DOM，不执行脚本。
 */
export function pastedBlocksFromHtml(html: string): PastedBlock[] {
  const sanitized = sanitizePastedHtml(html);
  if (!sanitized.trim() || typeof DOMParser === 'undefined') {
    return [];
  }
  const doc = new DOMParser().parseFromString(sanitized, 'text/html');
  const blocks: PastedBlock[] = [];
  collectBlocks(doc.body, blocks);
  return blocks;
}

export function pastedTextRuns(text: string): InlineRun[] {
  return normalizeInlineRuns([{ text: text.replace(/\r\n?/g, '\n') }]);
}

/** 把清洗后的 HTML 直接转成 runs（测试与链接弹层复用）。 */
export function sanitizedHtmlToRuns(html: string): InlineRun[] {
  const sanitized = sanitizePastedHtml(html);
  if (!sanitized || typeof DOMParser === 'undefined') {
    return [];
  }
  const doc = new DOMParser().parseFromString(sanitized, 'text/html');
  return mergeRuns(inlineRunsFromNode(doc.body));
}
