/**
 * 侧栏清单树的数据摘要。
 *
 * 按规范只读取“未删除清单 + 未完成任务计数”，不把 TaskStore 提升到 Shell；
 * TaskStore 每次真实刷新后广播 `zhixing:tasks-changed`，这里在 100ms 内重新读取。
 * 浏览器预览没有 IPC 时进入 unavailable，不伪造清单。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { db, isTauriRuntime } from '../../data/db/client';
import type { List } from '../../data/db/types';
import {
  countOpenTasks,
  type ListCounts,
} from '../../pages/Lists/tree';
import { NOTIFICATION_TASKS_CHANGED_EVENT } from '../../features/notifications/runtime';

export type ListsSummaryStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export type ListsSummary = {
  status: ListsSummaryStatus;
  lists: List[];
  counts: ListCounts;
  error: string | null;
  refresh: () => void;
};

const EMPTY_COUNTS: ListCounts = {
  byId: new Map(),
  openTotal: 0,
  inbox: 0,
};

function formatError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message || '清单加载失败';
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '清单加载失败';
}

export function useListsSummary(): ListsSummary {
  const available = isTauriRuntime();
  const [status, setStatus] = useState<ListsSummaryStatus>(
    available ? 'loading' : 'unavailable',
  );
  const [lists, setLists] = useState<List[]>([]);
  const [counts, setCounts] = useState<ListCounts>(EMPTY_COUNTS);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, []);

  const load = useCallback(async () => {
    if (!available) {
      setStatus('unavailable');
      return;
    }
    try {
      const [nextLists, nextTasks] = await Promise.all([
        db.lists.list(),
        db.tasks.list(),
      ]);
      if (!mounted.current) {
        return;
      }
      setLists(nextLists);
      setCounts(countOpenTasks(nextLists, nextTasks));
      setError(null);
      setStatus('ready');
    } catch (reason) {
      if (!mounted.current) {
        return;
      }
      setError(formatError(reason));
      setStatus((current) => (current === 'ready' ? 'ready' : 'error'));
    }
  }, [available]);

  useEffect(() => {
    if (!available) {
      setStatus('unavailable');
      return;
    }
    void load();
    const schedule = () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => {
        timer.current = null;
        void load();
      }, 100);
    };
    window.addEventListener(NOTIFICATION_TASKS_CHANGED_EVENT, schedule);
    return () => {
      window.removeEventListener(NOTIFICATION_TASKS_CHANGED_EVENT, schedule);
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [available, load]);

  const refresh = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      void load();
    }, 0);
  }, [load]);

  return { status, lists, counts, error, refresh };
}
