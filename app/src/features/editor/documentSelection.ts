/**
 * 文档级选择（ZX-NOTE-07 / 规范《笔记块排版与选择模型 v4》§5.3）。
 *
 * `⌘/Ctrl+A` 的语义是「一次选中整篇可复制内容」：段落文字、代码、表格
 * 单元格、文件名、画板标题、公式 LaTeX，全部进入同一个原生 Range；
 * gutter 按钮、操作条、toast 等控件文案绝不进入选区。
 *
 * 纯 DOM 函数，便于在组件、探针与测试里复用。
 */

const IGNORE_SELECTOR = [
  '.zxe-block-gutter',
  '.zxe-selectionbar',
  '.zxe-selection-toast',
  '.zxe-block-menu',
  '.zxe-menu',
  'button',
  'script',
  'style',
  '[data-doc-select-ignore="true"]',
].join(',');

function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

/** TreeWalker 的过滤：跳过控件文案与隐藏节点，只保留可复制文本。 */
function acceptNode(node: Node): number {
  if (node.nodeType !== Node.TEXT_NODE) {
    return NodeFilter.FILTER_REJECT;
  }
  const text = node.nodeValue ?? '';
  if (text.trim() === '') {
    return NodeFilter.FILTER_REJECT;
  }
  const parent = node.parentElement;
  if (!parent) {
    return NodeFilter.FILTER_REJECT;
  }
  if (parent.closest(IGNORE_SELECTOR)) {
    return NodeFilter.FILTER_REJECT;
  }
  if (parent.closest('[contenteditable="false"] [contenteditable="true"]')) {
    return NodeFilter.FILTER_REJECT;
  }
  // jsdom 的 getComputedStyle 在部分节点上会抛错；真实浏览器里用于
  // 跳过 display:none / visibility:hidden 的控件文案。
  try {
    const style = window.getComputedStyle(parent);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) {
      return NodeFilter.FILTER_REJECT;
    }
  } catch {
    /* 样式不可用时按可见处理 */
  }
  return NodeFilter.FILTER_ACCEPT;
}

export type DocumentSelectionResult = {
  ok: boolean;
  /** 选中范围内的可复制文本长度（不含纯空白节点）。 */
  textLength: number;
  /** 命中的可复制文本节点数；0 说明正文没有可复制内容。 */
  textNodes: number;
};

/**
 * 用原生 Range 选中容器内全部可复制文本；控件文案（gutter 按钮、
 * 操作条、toast、菜单）被排除。已有选区先清空。
 */
export function selectDocumentContent(
  container: HTMLElement | null,
): DocumentSelectionResult {
  if (!container || typeof document === 'undefined') {
    return { ok: false, textLength: 0, textNodes: 0 };
  }
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    { acceptNode },
  );
  const first = walker.nextNode();
  if (!first) {
    return { ok: false, textLength: 0, textNodes: 0 };
  }
  let last: Node | null = first;
  let textLength = 0;
  let textNodes = 1;
  let current: Node | null = first;
  while ((current = walker.nextNode())) {
    last = current;
    textNodes += 1;
  }
  // 重新走一遍统计长度；节点通常只有几十个，不值得缓存。
  const counter = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    { acceptNode },
  );
  while (counter.nextNode()) {
    textLength += (counter.currentNode.nodeValue ?? '').length;
  }

  const range = document.createRange();
  range.setStartBefore(first);
  range.setEndAfter(last as Node);
  const domSelection = window.getSelection();
  domSelection?.removeAllRanges();
  domSelection?.addRange(range);
  return { ok: true, textLength, textNodes };
}

/** 判断事件目标是否属于局部输入控件；这类控件保留浏览器原生全选。 */
export function isLocalInputTarget(target: Element | null): boolean {
  if (!target) {
    return false;
  }
  return Boolean(
    target.closest(
      '.zxe-dialog-backdrop, .zxe-menu, input, textarea, select, [data-local-input="true"]',
    ),
  );
}

export { isElement };
