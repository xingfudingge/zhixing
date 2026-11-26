/**
 * 会话内撤销条。
 *
 * 只负责“在固定窗口内保留一个可撤销回调”，不直接访问 SQLite：
 * 调用方先完成领域写入，再把恢复动作注册进来。窗口结束后仅移除回调；
 * 领域数据是否保留由领域本身决定（任务删除是软删除，后续回收区可继续恢复）。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import './undo.css';

export const UNDO_WINDOW_MS = 5000;

export type UndoRequest = {
  message: string;
  undoLabel?: string;
  onUndo: () => void | Promise<void>;
  /** 窗口自然结束（没有点撤销）时调用；关闭提示不会触发。 */
  onExpire?: () => void;
  /** 撤销动作自身失败时调用，便于页面提示。 */
  onUndoError?: (reason: unknown) => void;
};

type UndoEntry = UndoRequest & {
  id: number;
  expiresAt: number;
};

export type UndoContextValue = {
  schedule: (request: UndoRequest) => number;
  undo: (id?: number) => Promise<void>;
  dismiss: (id?: number) => void;
  pending: ReadonlyArray<UndoEntry>;
};

const UndoContext = createContext<UndoContextValue | null>(null);

export function undoSeconds(): number {
  return Math.round(UNDO_WINDOW_MS / 1000);
}

export function UndoProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<UndoEntry[]>([]);
  const entriesRef = useRef<UndoEntry[]>([]);
  const timers = useRef(new Map<number, number>());
  const nextId = useRef(0);

  const commitEntries = useCallback((next: UndoEntry[]) => {
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const clearTimer = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const removeEntry = useCallback(
    (id: number) => {
      clearTimer(id);
      commitEntries(entriesRef.current.filter((entry) => entry.id !== id));
    },
    [clearTimer, commitEntries],
  );

  const schedule = useCallback(
    (request: UndoRequest) => {
      nextId.current += 1;
      const id = nextId.current;
      const entry: UndoEntry = {
        ...request,
        id,
        expiresAt: Date.now() + UNDO_WINDOW_MS,
      };
      const kept = entriesRef.current.slice(-2);
      for (const dropped of entriesRef.current.slice(0, -2)) {
        clearTimer(dropped.id);
      }
      commitEntries([...kept, entry]);

      const timer = window.setTimeout(() => {
        timers.current.delete(id);
        commitEntries(entriesRef.current.filter((item) => item.id !== id));
        void Promise.resolve(request.onExpire?.()).catch(() => undefined);
      }, UNDO_WINDOW_MS);
      timers.current.set(id, timer);
      return id;
    },
    [clearTimer, commitEntries],
  );

  const undo = useCallback(
    async (id?: number) => {
      const target = id ?? entriesRef.current[entriesRef.current.length - 1]?.id;
      if (target === undefined) {
        return;
      }
      const entry = entriesRef.current.find((item) => item.id === target);
      if (!entry) {
        return;
      }
      removeEntry(target);
      try {
        await entry.onUndo();
      } catch (reason) {
        entry.onUndoError?.(reason);
      }
    },
    [removeEntry],
  );

  const dismiss = useCallback(
    (id?: number) => {
      const target = id ?? entriesRef.current[entriesRef.current.length - 1]?.id;
      if (target !== undefined) {
        removeEntry(target);
      }
    },
    [removeEntry],
  );

  useEffect(() => {
    const currentTimers = timers.current;
    return () => {
      for (const timer of currentTimers.values()) {
        window.clearTimeout(timer);
      }
      currentTimers.clear();
    };
  }, []);

  const value = useMemo<UndoContextValue>(
    () => ({
      schedule,
      undo,
      dismiss,
      pending: entries,
    }),
    [schedule, undo, dismiss, entries],
  );

  return (
    <UndoContext.Provider value={value}>
      {children}
      {entries.length > 0 ? (
        <div className="zx-undo-stack" aria-label="可撤销操作">
          {entries.map((entry) => (
            <div className="zx-undo-toast" role="status" key={entry.id}>
              <span className="zx-undo-message">{entry.message}</span>
              <span className="zx-undo-window">
                {undoSeconds()} 秒内可撤销
              </span>
              <button
                type="button"
                className="zx-undo-action"
                onClick={() => void undo(entry.id)}
              >
                {entry.undoLabel ?? '撤销'}
              </button>
              <button
                type="button"
                className="zx-undo-close"
                aria-label="关闭撤销提示"
                onClick={() => dismiss(entry.id)}
              >
                ×
              </button>
              <span
                className="zx-undo-progress"
                aria-hidden="true"
                style={{
                  animationDuration: `${UNDO_WINDOW_MS}ms`,
                }}
              />
            </div>
          ))}
        </div>
      ) : null}
    </UndoContext.Provider>
  );
}

export function useOptionalUndo(): UndoContextValue | null {
  return useContext(UndoContext);
}

export function useUndo(): UndoContextValue {
  const context = useContext(UndoContext);
  if (!context) {
    throw new Error('useUndo 必须在 UndoProvider 内使用');
  }
  return context;
}
