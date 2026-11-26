/**
 * 习惯域的应用内提示：toast + 确认弹层。
 *
 * 不使用 window.confirm / alert，保证桌面壳与浏览器预览一致，也便于测试。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type HabitToastTone = 'info' | 'success' | 'danger';

type ToastItem = {
  id: number;
  message: string;
  tone: HabitToastTone;
};

type ToastContextValue = {
  pushToast: (message: string, tone?: HabitToastTone) => number;
  dismissToast: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION = 4200;

export function HabitToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismissToast = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (message: string, tone: HabitToastTone = 'info') => {
      nextId.current += 1;
      const id = nextId.current;
      setToasts((current) => [
        ...current.slice(-2),
        { id, message, tone },
      ]);
      const timer = window.setTimeout(() => dismissToast(id), TOAST_DURATION);
      timers.current.set(id, timer);
      return id;
    },
    [dismissToast],
  );

  useEffect(() => {
    const current = timers.current;
    return () => {
      for (const timer of current.values()) {
        window.clearTimeout(timer);
      }
      current.clear();
    };
  }, []);

  const value = useMemo(
    () => ({ pushToast, dismissToast }),
    [pushToast, dismissToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0 ? (
        <div className="habit-toasts" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div
              className={`habit-toast habit-toast--${toast.tone}`}
              key={toast.id}
            >
              <span>{toast.message}</span>
              <button
                type="button"
                className="habit-toast-close"
                aria-label="关闭提示"
                onClick={() => dismissToast(toast.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useHabitToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useHabitToast 必须在 HabitToastProvider 内使用');
  }
  return context.pushToast;
}

export function formatError(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '操作失败，请重试';
}

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) {
    return null;
  }

  return (
    <div className="habit-overlay" role="presentation" onMouseDown={onCancel}>
      <div
        className="habit-dialog habit-dialog--confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>{title}</h2>
        <div className="habit-dialog-desc">{description}</div>
        <div className="habit-dialog-actions">
          <button
            type="button"
            className="habit-button"
            onClick={onCancel}
            disabled={pending}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={
              danger
                ? 'habit-button habit-button--danger-solid'
                : 'habit-button habit-button--primary'
            }
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
