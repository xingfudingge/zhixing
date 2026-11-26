/**
 * 应用级通知宿主。
 *
 * 挂在 Shell 内，负责：
 * - 周期/前台/任务变更时从本机任务库重算提醒计划并检查到点计划；
 * - 监听 `IN_APP_NOTIFICATION_EVENT`，渲染确定可用的应用内提醒；
 * - 设置变化后立即重新调和，避免必须重启应用才生效。
 *
 * 浏览器预览没有任务库时只运行应用内设置与测试通知，不伪造任务提醒。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  IN_APP_NOTIFICATION_EVENT,
  NOTIFICATION_SETTINGS_CHANGED_EVENT,
  type NotificationScheduler,
} from './scheduler';
import {
  getDefaultNotificationScheduler,
  NOTIFICATION_TASKS_CHANGED_EVENT,
  loadNotificationTasks,
} from './runtime';
import type { NotificationTask, ReminderPlan } from './types';

const TOAST_DURATION = 10_000;
const MAX_TOASTS = 3;

type InAppToast = {
  id: number;
  dedupeKey: string;
  title: string;
  body: string;
};

export type NotificationRuntimeProps = {
  /** 测试注入；不传时使用应用级单例调度器。 */
  scheduler?: NotificationScheduler;
  /** 测试注入；不传时桌面壳读取 SQLite，浏览器预览返回空任务。 */
  loadTasks?: () => Promise<ReadonlyArray<NotificationTask>>;
  /** 固定时间，便于测试。 */
  now?: () => Date;
  /** 周期检查间隔；到点计划仍由调度器定时器精确触发。 */
  pollIntervalMs?: number;
};

export function NotificationRuntime({
  scheduler: injected,
  loadTasks,
  now,
  pollIntervalMs = 30_000,
}: NotificationRuntimeProps) {
  const scheduler = injected ?? getDefaultNotificationScheduler();
  const [toasts, setToasts] = useState<InAppToast[]>([]);
  const nextToastId = useRef(0);
  const timers = useRef(new Map<number, number>());
  const shown = useRef(new Set<string>());
  const running = useRef(false);
  const loadRef = useRef(loadTasks ?? loadNotificationTasks);
  loadRef.current = loadTasks ?? loadNotificationTasks;
  const nowRef = useRef(now);
  nowRef.current = now;

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (plan: ReminderPlan) => {
      // 同一去重键只显示一次，避免定时器/手动检查重叠时重复弹窗。
      if (shown.current.has(plan.dedupeKey)) return;
      shown.current.add(plan.dedupeKey);
      nextToastId.current += 1;
      const id = nextToastId.current;
      const timer = window.setTimeout(() => dismiss(id), TOAST_DURATION);
      timers.current.set(id, timer);
      setToasts((current) => [
        ...current.slice(-(MAX_TOASTS - 1)),
        {
          id,
          dedupeKey: plan.dedupeKey,
          title: plan.title,
          body: plan.body,
        },
      ]);
    },
    [dismiss],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const plan = (event as CustomEvent<ReminderPlan>).detail;
      if (plan && typeof plan.title === 'string') {
        pushToast(plan);
      }
    };
    window.addEventListener(IN_APP_NOTIFICATION_EVENT, handler);
    return () => {
      window.removeEventListener(IN_APP_NOTIFICATION_EVENT, handler);
    };
  }, [pushToast]);

  useEffect(() => {
    const currentTimers = timers.current;
    return () => {
      for (const timer of currentTimers.values()) {
        window.clearTimeout(timer);
      }
      currentTimers.clear();
    };
  }, []);

  const sync = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      let tasks: ReadonlyArray<NotificationTask> | null = null;
      try {
        tasks = await loadRef.current();
      } catch {
        // 任务库读取失败时不要用空数组调和，否则会把已有计划全部撤销。
        tasks = null;
      }
      if (tasks) {
        await scheduler.reconcile(tasks);
      }
      await scheduler.checkNow(nowRef.current?.());
    } catch {
      // 调度器的失败原因会写入计划/发送记录；宿主不打断页面。
    } finally {
      running.current = false;
    }
  }, [scheduler]);

  useEffect(() => {
    let disposed = false;
    const run = () => {
      if (!disposed) void sync();
    };

    run();
    const interval = window.setInterval(run, pollIntervalMs);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') run();
    };
    window.addEventListener('focus', run);
    window.addEventListener(NOTIFICATION_TASKS_CHANGED_EVENT, run);
    window.addEventListener(NOTIFICATION_SETTINGS_CHANGED_EVENT, run);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', run);
      window.removeEventListener(NOTIFICATION_TASKS_CHANGED_EVENT, run);
      window.removeEventListener(NOTIFICATION_SETTINGS_CHANGED_EVENT, run);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pollIntervalMs, sync]);

  if (toasts.length === 0) {
    return null;
  }

  return (
    <div
      className="zx-notify-toasts"
      role="status"
      aria-live="polite"
      aria-label="应用内提醒"
    >
      {toasts.map((toast) => (
        <article className="zx-notify-toast" key={toast.id}>
          <div>
            <b>{toast.title}</b>
            <p>{toast.body}</p>
          </div>
          <button
            type="button"
            className="zx-notify-toast-close"
            aria-label="关闭提醒"
            onClick={() => dismiss(toast.id)}
          >
            ×
          </button>
        </article>
      ))}
    </div>
  );
}
