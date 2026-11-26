/**
 * 全局模态焦点兜底（P2-04）。
 *
 * 应用里既有对话框各自处理 Esc；这里补上统一的 Tab 循环与关闭后焦点归还，
 * 不需要逐个改动历史组件。P2-04 的 Modal 已自带 FocusTrap，通过
 * `data-a11y-managed="true"` 标记，交给组件自身处理，避免双重陷阱。
 */

import { getFocusableElements } from './FocusTrap';

const MANAGED_MARKER = '[data-a11y-managed="true"]';

function dialogList(root: Document): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
  ).filter((dialog) => !dialog.closest(MANAGED_MARKER));
}

export function installGlobalModalFocusTrap(
  doc: Document | undefined = typeof document === 'undefined'
    ? undefined
    : document,
): () => void {
  if (!doc || !doc.body) {
    return () => {};
  }

  let activeDialog: HTMLElement | null = null;
  let previousFocus: HTMLElement | null = null;
  let observer: MutationObserver | null = null;

  const reconcile = () => {
    const list = dialogList(doc);
    const next = list.length > 0 ? list[list.length - 1]! : null;
    if (next === activeDialog) return;
    if (!activeDialog && next) {
      previousFocus =
        doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    }
    activeDialog = next;
    if (!activeDialog && previousFocus && previousFocus.isConnected) {
      previousFocus.focus();
      previousFocus = null;
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const list = dialogList(doc);
    const dialog = list.length > 0 ? list[list.length - 1]! : null;
    if (!dialog) return;
    const focusable = getFocusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const current =
      doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    if (!current || !dialog.contains(current)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && current === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleFocusIn = (event: FocusEvent) => {
    const target = event.target;
    const list = dialogList(doc);
    const dialog = list.length > 0 ? list[list.length - 1]! : null;
    if (!dialog) return;
    if (target instanceof Node && dialog.contains(target)) return;
    const focusable = getFocusableElements(dialog);
    if (focusable.length > 0) {
      focusable[0]!.focus();
    } else {
      if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
      dialog.focus();
    }
  };

  observer = new MutationObserver(reconcile);
  observer.observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener('keydown', handleKeyDown, true);
  doc.addEventListener('focusin', handleFocusIn, true);
  reconcile();

  return () => {
    observer?.disconnect();
    observer = null;
    doc.removeEventListener('keydown', handleKeyDown, true);
    doc.removeEventListener('focusin', handleFocusIn, true);
    if (previousFocus && previousFocus.isConnected) {
      previousFocus.focus();
    }
    previousFocus = null;
    activeDialog = null;
  };
}
