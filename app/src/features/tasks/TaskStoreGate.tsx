/** 本地库状态门禁：加载中 / 浏览器不可用 / 加载失败 / 就绪。 */

import type { ReactNode } from 'react';

import { useTaskStore } from './TaskStore';

export function TaskStoreGate({ children }: { children: ReactNode }) {
  const { status, error, refresh } = useTaskStore();

  if (status === 'loading') {
    return (
      <div className="task-state-card" role="status" aria-live="polite">
        <h2>正在读取本地任务库…</h2>
        <p>任务、清单和子任务都从本机 SQLite 读取。</p>
      </div>
    );
  }

  if (status === 'unavailable') {
    return (
      <div className="task-state-card">
        <span className="task-state-mark" aria-hidden="true">
          库
        </span>
        <h2>需在桌面壳内使用任务库</h2>
        <p>
          任务数据保存在本机 SQLite，浏览器预览没有 Tauri IPC 通道。请使用
          <code>pnpm --filter app tauri dev</code>
          启动桌面壳后再使用任务、今天和清单。
        </p>
        <p className="task-state-note">
          这里不会回退到 localStorage，也不会生成演示数据。
        </p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="task-state-card" role="alert">
        <h2>本地任务库读取失败</h2>
        <p>{error ?? '未知错误，请稍后重试。'}</p>
        <button
          type="button"
          className="task-button"
          onClick={() => {
            void refresh().catch(() => undefined);
          }}
        >
          重试
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
