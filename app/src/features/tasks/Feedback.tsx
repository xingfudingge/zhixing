/**
 * 应用内提示：toast + 确认弹层。
 *
 * 任务域禁止使用 window.confirm / prompt / alert；错误和确认都走这里，
 * 这样桌面壳与浏览器预览的表现一致，也方便测试。
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

export type ToastTone = 'info' | 'success' | 'danger';

export type ToastAction = {
  label: string;
  onClick: () => void | Promise<void>;
};

export type ToastOptions = {
  tone?: ToastTone;
  action?: ToastAction;
};

type ToastItem = {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
};

type ToastContextValue = {
  pushToast: (message: string, options?: ToastOptions) => number;
  dismissToast: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION = 4200;

export function ToastProvider({ children }: { children: ReactNode }) {
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
    (message: string, options: ToastOptions = {}) => {
      nextId.current += 1;
      const id = nextId.current;
      const item: ToastItem = {
        id,
        message,
        tone: options.tone ?? 'info',
        action: options.action,
      };
      setToasts((current) => [...current.slice(-2), item]);
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
        <div className="task-toasts" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div
              className={`task-toast task-toast--${toast.tone}`}
              key={toast.id}
            >
              <span>{toast.message}</span>
              {toast.action ? (
                <button
                  type="button"
                  className="task-toast-action"
                  onClick={() => {
                    dismissToast(toast.id);
                    void Promise.resolve(toast.action?.onClick()).catch(
                      () => undefined,
                    );
                  }}
                >
                  {toast.action.label}
                </button>
              ) : null}
              <button
                type="button"
                className="task-toast-close"
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

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast 必须在 ToastProvider 内使用');
  }
  return context.pushToast;
}

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
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
    <div className="task-overlay" role="presentation" onMouseDown={onCancel}>
      <div
        className="task-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>{title}</h2>
        <div className="task-dialog-desc">{description}</div>
        <div className="task-dialog-actions">
          <button type="button" className="task-button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={
              danger
                ? 'task-button task-button--danger-solid'
                : 'task-button task-button--primary'
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
