/**
 * 页面共用的任务动作：统一错误 toast、完成/撤销。
 * 所有状态写入仍走 TaskStore → SQLite 仓储。
 */

import { useCallback } from 'react';

import type { Task } from '../../data/db/types';
import { useToast, type ToastAction, type ToastTone } from './Feedback';
import { formatError, useTaskStore } from './TaskStore';

type RunOptions<T> = {
  success?: string | ((result: T) => string);
  tone?: ToastTone;
  action?: ToastAction;
};

/** 执行一个异步动作：成功可选 toast，失败统一转成应用内错误提示。 */
export function useTaskAction() {
  const toast = useToast();

  return useCallback(
    async function run<T>(
      action: () => Promise<T>,
      options: RunOptions<T> = {},
    ): Promise<T | undefined> {
      try {
        const result = await action();
        if (options.success) {
          toast(
            typeof options.success === 'function'
              ? options.success(result)
              : options.success,
            { tone: options.tone ?? 'success', action: options.action },
          );
        }
        return result;
      } catch (reason) {
        toast(formatError(reason), { tone: 'danger' });
        return undefined;
      }
    },
    [toast],
  );
}

/**
 * 完成 / 撤销完成。撤销会恢复完成前的状态（doing 不会被降级成 todo），
 * 并让列表、看板、完成环在 refresh 后保持计数一致。
 */
export function useTaskCompletion() {
  const store = useTaskStore();
  const toast = useToast();

  return useCallback(
    async (task: Task) => {
      try {
        if (task.status === 'done') {
          await store.setTaskStatus(task.id, 'todo');
          toast('已恢复到待办', { tone: 'success' });
          return;
        }

        const previousStatus = task.status;
        await store.completeTask(task.id, true);
        toast('已完成', {
          tone: 'success',
          action: {
            label: '撤销',
            onClick: async () => {
              try {
                await store.setTaskStatus(task.id, previousStatus);
                toast('已恢复', { tone: 'success' });
              } catch (reason) {
                toast(formatError(reason), { tone: 'danger' });
              }
            },
          },
        });
      } catch (reason) {
        toast(formatError(reason), { tone: 'danger' });
      }
    },
    [store, toast],
  );
}
