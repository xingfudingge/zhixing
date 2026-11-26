/**
 * 模态键盘焦点陷阱（P2-04）。
 *
 * 规则与 WAI-ARIA Authoring Practices 的 Dialog 模式一致：
 * - 打开时把焦点移入对话框；
 * - Tab / Shift+Tab 在对话框内循环，不跑到背景；
 * - Esc 关闭（由调用方决定是否允许）；
 * - 关闭后把焦点还给打开它的元素。
 */

import {
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  'audio[controls]',
  'video[controls]',
  'summary',
].join(',');

function isElementVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;
  if (element.closest('[hidden], [aria-hidden="true"]')) return false;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return true;
}

export function getFocusableElements(
  container: HTMLElement | null,
): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      !element.hasAttribute('disabled') &&
      element.tabIndex !== -1 &&
      isElementVisible(element),
  );
}

export type FocusTrapProps = {
  active?: boolean;
  onEscape?: () => void;
  restoreFocus?: boolean;
  autoFocus?: boolean;
  className?: string;
  /** 关闭后优先把焦点还给这个元素；默认还给打开前的 activeElement。 */
  returnFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
};

export function FocusTrap({
  active = true,
  onEscape,
  restoreFocus = true,
  autoFocus = true,
  className,
  returnFocusRef,
  children,
}: FocusTrapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const focusInside = () => {
      const focusable = getFocusableElements(container);
      if (focusable.length > 0) {
        focusable[0]!.focus();
      } else {
        container.focus();
      }
    };

    if (autoFocus) {
      focusInside();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && escapeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        escapeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      if (!current || !container.contains(current)) {
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
      if (!(target instanceof HTMLElement)) return;
      if (container.contains(target)) return;
      const otherDialog = target.closest('[aria-modal="true"]');
      if (otherDialog && otherDialog !== container) return;
      focusInside();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      if (restoreFocus) {
        const target = returnFocusRef?.current ?? previous;
        if (target && target.isConnected) {
          target.focus();
        }
      }
    };
  }, [active, autoFocus, restoreFocus, returnFocusRef]);

  return (
    <div ref={containerRef} className={className} tabIndex={-1}>
      {children}
    </div>
  );
}
