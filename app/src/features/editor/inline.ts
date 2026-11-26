/**
 * 行内富文本：DOM ↔ 结构化 runs。
 *
 * 权威数据是 `InlineRun[]`（文本 + marks），DOM 只是视图：
 * - 输入时从 DOM 读回 runs；
 * - 应用格式时在 runs 上做区间变换，再写回 DOM；
 * - 全程不调用 `document.execCommand`。
 */

import {
  canonicalColor,
  escapeAttribute,
  escapeHtml,
  sanitizeLinkUrl,
} from './security';
import type { InlineMarks, InlineRun } from './types';
import { normalizeMarks } from './types';

export type InlineSelection = {
  start: number;
  end: number;
};

export type SelectionRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type InlineSelectionInfo = InlineSelection & {
  blockId: string;
  rect: SelectionRect;
};

const BLOCKISH_TAGS = new Set(['div', 'p']);

function markKey(marks: InlineMarks | undefined): string {
  if (!marks) {
    return '';
  }
  return Object.entries(marks)
    .filter(([, value]) => value !== undefined && value !== false)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${String(value)}`)
    .join('|');
}

export function mergeRuns(runs: ReadonlyArray<InlineRun>): InlineRun[] {
  const merged: InlineRun[] = [];
  for (const run of runs) {
    if (!run.text) {
      continue;
    }
    const marks = normalizeMarks(run.marks);
    const previous = merged[merged.length - 1];
    if (previous && markKey(previous.marks) === markKey(marks)) {
      previous.text += run.text;
      continue;
    }
    merged.push(marks ? { text: run.text, marks } : { text: run.text });
  }
  return merged;
}

export function runsEqual(
  a: ReadonlyArray<InlineRun>,
  b: ReadonlyArray<InlineRun>,
): boolean {
  const left = mergeRuns(a);
  const right = mergeRuns(b);
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].text !== right[index].text) {
      return false;
    }
    if (markKey(left[index].marks) !== markKey(right[index].marks)) {
      return false;
    }
  }
  return true;
}

export function runsToPlainText(
  runs: ReadonlyArray<InlineRun>,
): string {
  return runs.map((run) => run.text).join('');
}

/** 把结构化 runs 转成安全 HTML；文本永远先转义。 */
export function runsToHtml(runs: ReadonlyArray<InlineRun>): string {
  return mergeRuns(runs)
    .map((run) => {
      let html = escapeHtml(run.text).replace(/\n/g, '<br>');
      if (!html) {
        return '';
      }
      const marks = run.marks;
      if (!marks) {
        return html;
      }
      if (marks.code) {
        html = `<code>${html}</code>`;
      }
      if (marks.strike) {
        html = `<s>${html}</s>`;
      }
      if (marks.underline) {
        html = `<u>${html}</u>`;
      }
      if (marks.italic) {
        html = `<em>${html}</em>`;
      }
      if (marks.bold) {
        html = `<strong>${html}</strong>`;
      }
      if (marks.color || marks.background) {
        const style: string[] = [];
        const color = canonicalColor(marks.color) ?? null;
        const background = canonicalColor(marks.background) ?? null;
        if (color) {
          style.push(`color:${color}`);
        }
        if (background) {
          style.push(`background-color:${background}`);
        }
        if (style.length > 0) {
          html = `<span style="${style.join(';')}">${html}</span>`;
        }
      }
      if (marks.link && sanitizeLinkUrl(marks.link)) {
        html = `<a href="${escapeAttribute(
          marks.link,
        )}" rel="noreferrer noopener">${html}</a>`;
      }
      return html;
    })
    .join('');
}

type InheritedMarks = InlineMarks;

function applyElementMarks(
  tag: string,
  element: HTMLElement,
  inherited: InheritedMarks,
): InheritedMarks {
  const marks: InheritedMarks = { ...inherited };
  switch (tag) {
    case 'strong':
    case 'b':
      marks.bold = true;
      break;
    case 'em':
    case 'i':
      marks.italic = true;
      break;
    case 'u':
      marks.underline = true;
      break;
    case 's':
    case 'strike':
    case 'del':
      marks.strike = true;
      break;
    case 'code':
      marks.code = true;
      break;
    case 'a': {
      const href = sanitizeLinkUrl(element.getAttribute('href'));
      if (href) {
        marks.link = href;
      }
      break;
    }
    case 'font': {
      const color = canonicalColor(element.getAttribute('color'));
      if (color) {
        marks.color = color;
      }
      break;
    }
    default:
      break;
  }
  if (tag === 'span' || tag === 'font' || BLOCKISH_TAGS.has(tag)) {
    const color = canonicalColor(element.style?.color);
    if (color) {
      marks.color = color;
    }
    const background = canonicalColor(
      element.style?.backgroundColor || element.style?.background,
    );
    if (background) {
      marks.background = background;
    }
  }
  return marks;
}

function walkInline(node: Node, inherited: InheritedMarks, out: InlineRun[]): void {
  if (node.nodeType === 3) {
    const text = (node.nodeValue ?? '').replace(/ /g, ' ');
    if (text) {
      out.push({ text, marks: normalizeMarks(inherited) });
    }
    return;
  }
  if (node.nodeType !== 1) {
    return;
  }
  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (
    tag === 'script' ||
    tag === 'style' ||
    tag === 'template' ||
    tag === 'noscript'
  ) {
    return;
  }
  if (tag === 'br') {
    out.push({ text: '\n', marks: normalizeMarks(inherited) });
    return;
  }
  const marks = applyElementMarks(tag, element, inherited);
  for (const child of Array.from(element.childNodes)) {
    walkInline(child, marks, out);
  }
  if (BLOCKISH_TAGS.has(tag) && out.length > 0) {
    const previous = out[out.length - 1];
    if (!previous.text.endsWith('\n')) {
      previous.text += '\n';
    }
  }
}

/** 从 contenteditable 根节点读取结构化 runs。 */
export function inlineRunsFromNode(root: Node): InlineRun[] {
  const runs: InlineRun[] = [];
  for (const child of Array.from(root.childNodes)) {
    walkInline(child, {}, runs);
  }
  const merged = mergeRuns(runs);
  // 浏览器空块会留下 <br>；不要把它当成真实换行持久化。
  if (merged.every((run) => run.text.replace(/\n/g, '') === '')) {
    return [];
  }
  return merged;
}

export function normalizeEditorRuns(runs: ReadonlyArray<InlineRun>): InlineRun[] {
  const merged = mergeRuns(runs);
  if (merged.every((run) => run.text.replace(/\n/g, '') === '')) {
    return [];
  }
  return merged;
}

export function inlineRunsFromHtml(html: string): InlineRun[] {
  if (typeof DOMParser === 'undefined') {
    return html ? [{ text: stripTags(html) }] : [];
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return inlineRunsFromNode(doc.body);
}

export function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ---------------------------------------------------------------------------
// runs 区间变换
// ---------------------------------------------------------------------------

function clampRange(
  runs: ReadonlyArray<InlineRun>,
  start: number,
  end: number,
): { start: number; end: number } {
  const length = runsToPlainText(runs).length;
  const from = Math.max(0, Math.min(length, start));
  const to = Math.max(0, Math.min(length, end));
  return from <= to ? { start: from, end: to } : { start: to, end: from };
}

function rewriteRange(
  runs: ReadonlyArray<InlineRun>,
  start: number,
  end: number,
  update: (marks: InlineMarks | undefined) => InlineMarks | undefined,
): InlineRun[] {
  const range = clampRange(runs, start, end);
  if (range.start === range.end) {
    return mergeRuns(runs);
  }
  const out: InlineRun[] = [];
  let cursor = 0;
  for (const run of runs) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;
    const from = Math.max(range.start, runStart);
    const to = Math.min(range.end, runEnd);
    if (from >= to) {
      out.push(run);
      continue;
    }
    const localStart = from - runStart;
    const localEnd = to - runStart;
    if (localStart > 0) {
      out.push({ ...run, text: run.text.slice(0, localStart) });
    }
    out.push({
      ...run,
      text: run.text.slice(localStart, localEnd),
      marks: update(run.marks),
    });
    if (localEnd < run.text.length) {
      out.push({ ...run, text: run.text.slice(localEnd) });
    }
  }
  return mergeRuns(out);
}

export function setMarksInRange(
  runs: ReadonlyArray<InlineRun>,
  start: number,
  end: number,
  marks: InlineMarks | undefined,
): InlineRun[] {
  return rewriteRange(runs, start, end, () => normalizeMarks(marks));
}

export function rangeHasMark(
  runs: ReadonlyArray<InlineRun>,
  start: number,
  end: number,
  key: keyof InlineMarks,
  value?: string | boolean,
): boolean {
  const range = clampRange(runs, start, end);
  if (range.start === range.end) {
    return false;
  }
  let cursor = 0;
  let sawText = false;
  for (const run of runs) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;
    if (runEnd <= range.start || runStart >= range.end) {
      continue;
    }
    sawText = true;
    const actual = run.marks?.[key];
    const expected = value === undefined ? true : value;
    if (actual !== expected) {
      return false;
    }
  }
  return sawText;
}

/** 对区间内同一 marks 键做「全有则清、否则设」的切换。 */
export function toggleMarksInRange(
  runs: ReadonlyArray<InlineRun>,
  start: number,
  end: number,
  patch: Partial<InlineMarks>,
): InlineRun[] {
  const keys = Object.keys(patch) as Array<keyof InlineMarks>;
  const hasAll = keys.every((key) =>
    rangeHasMark(runs, start, end, key, patch[key]),
  );
  return rewriteRange(runs, start, end, (marks) => {
    const next: InlineMarks = { ...(marks ?? {}) };
    for (const key of keys) {
      if (hasAll) {
        delete next[key];
      } else {
        const value = patch[key];
        if (value === undefined || value === false) {
          delete next[key];
        } else {
          next[key] = value as never;
        }
      }
    }
    return normalizeMarks(next);
  });
}

export function clearMarksInRange(
  runs: ReadonlyArray<InlineRun>,
  start: number,
  end: number,
): InlineRun[] {
  return rewriteRange(runs, start, end, () => undefined);
}

export function splitRunsForEnter(
  runs: ReadonlyArray<InlineRun>,
  start: number,
  end: number,
): { before: InlineRun[]; after: InlineRun[] } {
  const [before] = splitRunsAt(runs, start);
  const [, after] = splitRunsAt(runs, end);
  return { before, after };
}

export function splitRunsAt(
  runs: ReadonlyArray<InlineRun>,
  offset: number,
): [InlineRun[], InlineRun[]] {
  const range = clampRange(runs, offset, offset);
  const before: InlineRun[] = [];
  const after: InlineRun[] = [];
  let cursor = 0;
  for (const run of runs) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;
    if (runEnd <= range.start) {
      before.push(run);
      continue;
    }
    if (runStart >= range.start) {
      after.push(run);
      continue;
    }
    const local = range.start - runStart;
    before.push({ ...run, text: run.text.slice(0, local) });
    after.push({ ...run, text: run.text.slice(local) });
  }
  return [mergeRuns(before), mergeRuns(after)];
}

export function sliceRuns(
  runs: ReadonlyArray<InlineRun>,
  start: number,
  end: number,
): InlineRun[] {
  const range = clampRange(runs, start, end);
  const out: InlineRun[] = [];
  let cursor = 0;
  for (const run of runs) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;
    const from = Math.max(range.start, runStart);
    const to = Math.min(range.end, runEnd);
    if (from < to) {
      out.push({
        ...run,
        text: run.text.slice(from - runStart, to - runStart),
      });
    }
  }
  return mergeRuns(out);
}

export function insertRunsAt(
  runs: ReadonlyArray<InlineRun>,
  offset: number,
  inserted: ReadonlyArray<InlineRun>,
): InlineRun[] {
  const [before, after] = splitRunsAt(runs, offset);
  return mergeRuns([...before, ...inserted, ...after]);
}

export function replaceRangeWithRuns(
  runs: ReadonlyArray<InlineRun>,
  start: number,
  end: number,
  inserted: ReadonlyArray<InlineRun>,
): InlineRun[] {
  const range = clampRange(runs, start, end);
  const [before] = splitRunsAt(runs, range.start);
  const [, after] = splitRunsAt(runs, range.end);
  return mergeRuns([...before, ...inserted, ...after]);
}

export function concatRuns(
  a: ReadonlyArray<InlineRun>,
  b: ReadonlyArray<InlineRun>,
): InlineRun[] {
  return mergeRuns([...a, ...b]);
}

// ---------------------------------------------------------------------------
// Selection（DOM 偏移 ↔ runs 文本偏移）
// ---------------------------------------------------------------------------

function textLengthOf(node: Node): number {
  if (node.nodeType === 3) {
    return node.nodeValue?.length ?? 0;
  }
  if (node.nodeType !== 1) {
    return 0;
  }
  const element = node as HTMLElement;
  if (element.tagName.toLowerCase() === 'br') {
    return 1;
  }
  let total = 0;
  for (const child of Array.from(element.childNodes)) {
    total += textLengthOf(child);
  }
  return total;
}

function offsetOfPoint(
  root: HTMLElement,
  container: Node,
  offset: number,
): number {
  let count = 0;
  let found = false;

  const visit = (node: Node): boolean => {
    if (node === container) {
      if (node.nodeType === 3) {
        count += Math.max(
          0,
          Math.min(offset, (node.nodeValue ?? '').length),
        );
      } else {
        const children = Array.from(node.childNodes);
        const take = Math.max(0, Math.min(offset, children.length));
        for (let index = 0; index < take; index += 1) {
          count += textLengthOf(children[index]);
        }
      }
      found = true;
      return true;
    }
    if (node.nodeType === 3) {
      count += node.nodeValue?.length ?? 0;
      return false;
    }
    if (node.nodeType === 1 && (node as HTMLElement).tagName.toLowerCase() === 'br') {
      count += 1;
      return false;
    }
    if (node.nodeType === 1) {
      for (const child of Array.from(node.childNodes)) {
        if (visit(child)) {
          return true;
        }
      }
    }
    return false;
  };

  visit(root);
  return found ? count : textLengthOf(root);
}

export function selectionOffsetsIn(
  root: HTMLElement,
): InlineSelection | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }
  const start = offsetOfPoint(root, range.startContainer, range.startOffset);
  const end = offsetOfPoint(root, range.endContainer, range.endOffset);
  return start <= end ? { start, end } : { start: end, end: start };
}

function locateOffset(
  root: HTMLElement,
  target: number,
): { container: Node; offset: number } | null {
  let remaining = Math.max(0, target);

  const visit = (node: Node): { container: Node; offset: number } | null => {
    if (node.nodeType === 3) {
      const length = node.nodeValue?.length ?? 0;
      if (remaining <= length) {
        return { container: node, offset: remaining };
      }
      remaining -= length;
      return null;
    }
    if (node.nodeType !== 1) {
      return null;
    }
    const element = node as HTMLElement;
    if (element.tagName.toLowerCase() === 'br') {
      if (remaining === 0) {
        const parent = node.parentNode;
        if (parent) {
          return {
            container: parent,
            offset: Array.from(parent.childNodes).indexOf(node as ChildNode),
          };
        }
      }
      remaining -= 1;
      return null;
    }
    if (remaining === 0) {
      return { container: node, offset: 0 };
    }
    for (const child of Array.from(element.childNodes)) {
      const found = visit(child);
      if (found) {
        return found;
      }
    }
    if (remaining === 0) {
      return { container: node, offset: node.childNodes.length };
    }
    return null;
  };

  return visit(root);
}

export function restoreSelectionByOffsets(
  root: HTMLElement,
  start: number,
  end: number = start,
): void {
  if (typeof window === 'undefined') {
    return;
  }
  const startPoint = locateOffset(root, start);
  const endPoint = locateOffset(root, end);
  if (!startPoint || !endPoint) {
    return;
  }
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  try {
    const range = document.createRange();
    range.setStart(startPoint.container, startPoint.offset);
    range.setEnd(endPoint.container, endPoint.offset);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // DOM 在重渲染中被替换时 offset 可能暂时失效；下一次输入会重新定位。
  }
}

export function selectionRect(): SelectionRect {
  if (typeof window === 'undefined') {
    return { top: 0, left: 0, width: 0, height: 0 };
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return { top: 0, left: 0, width: 0, height: 0 };
  }
  try {
    const range = selection.getRangeAt(0);
    if (typeof range.getBoundingClientRect !== 'function') {
      return { top: 0, left: 0, width: 0, height: 0 };
    }
    const rect = range.getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  } catch {
    // 某些测试环境/旧 WebView 未实现 Range.getBoundingClientRect；
    // 浮条仍应出现，位置回退到视口左上。
    return { top: 0, left: 0, width: 0, height: 0 };
  }
}
