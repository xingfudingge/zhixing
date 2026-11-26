/**
 * ⌘K / ⌘N / ? 共用的模态壳。
 *
 * 只做四件事：遮罩、Esc 关闭、Tab 焦点陷阱、关闭后把焦点还给触发者。
 * 内容区域由搜索、快速创建、导览各自实现，避免三套对话框行为不一致。
 */

import {
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';

import './command.css';

export type CommandDialogProps = {
  open: boolean;
  label: string;
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
};

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (item) =>
      !item.hasAttribute('hidden') &&
      item.getAttribute('aria-hidden') !== 'true',
  );
}

export function CommandDialog({
  open,
  label,
  className,
  initialFocusRef,
  onClose,
  children,
}: CommandDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      return;
    }

    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const timer = window.setTimeout(() => {
      const root = dialogRef.current;
      if (!root) {
        return;
      }
      const target = initialFocusRef?.current ?? focusableItems(root)[0] ?? root;
      target.focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const root = dialogRef.current;
      if (!root) {
        return;
      }
      const items = focusableItems(root);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, [open, initialFocusRef]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="command-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={className ? `command-dialog ${className}` : 'command-dialog'}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
