/**
 * 可访问的模态外壳（P2-04）。
 *
 * 所有 P2-04 新增对话框都走这里：role="dialog"、aria-modal、
 * aria-labelledby/aria-describedby、焦点陷阱、Esc 关闭、背景滚动锁、
 * 关闭后焦点归还。按钮使用原生 button，Tab 顺序即 DOM 顺序。
 */

import { useEffect, useId, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { FocusTrap } from './FocusTrap';
import './a11y.css';

export type ModalProps = {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  size?: 'md' | 'lg';
  closeLabel?: string;
  className?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  busy = false,
  size = 'md',
  closeLabel = '关闭对话框',
  className,
  returnFocusRef,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className="zx-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <FocusTrap
        active={open}
        onEscape={busy ? undefined : onClose}
        className={`zx-modal-shell${size === 'lg' ? ' zx-modal-shell--lg' : ''}`}
        returnFocusRef={returnFocusRef}
      >
        <div
          role="dialog"
          aria-modal="true"
          data-a11y-managed="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          aria-busy={busy || undefined}
          className={`zx-modal zx-modal--${size}${className ? ` ${className}` : ''}`}
        >
          <header className="zx-modal-head">
            <div className="zx-modal-heading">
              <h2 id={titleId}>{title}</h2>
              {description ? (
                <p id={descriptionId} className="zx-modal-description">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              className="zx-modal-close"
              aria-label={closeLabel}
              onClick={onClose}
              disabled={busy}
            >
              ×
            </button>
          </header>
          <div className="zx-modal-body">{children}</div>
          {footer ? <footer className="zx-modal-foot">{footer}</footer> : null}
        </div>
      </FocusTrap>
    </div>,
    document.body,
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="zx-visually-hidden">{children}</span>;
}
