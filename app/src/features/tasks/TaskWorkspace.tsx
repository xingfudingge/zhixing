/** 任务页共享的注入边界：Toast → SQLite 数据容器 → 页面。 */

import type { ReactNode } from 'react';

import { UndoProvider } from '../../app/undo';
import { ToastProvider } from './Feedback';
import { TaskStoreProvider, type TaskSource } from './TaskStore';
import './tasks.css';

export type TaskWorkspaceProps = {
  children: ReactNode;
  source?: TaskSource;
  today?: string;
  available?: boolean;
};

export function TaskWorkspace({
  children,
  source,
  today,
  available,
}: TaskWorkspaceProps) {
  return (
    <ToastProvider>
      <UndoProvider>
        <TaskStoreProvider source={source} today={today} available={available}>
          {children}
        </TaskStoreProvider>
      </UndoProvider>
    </ToastProvider>
  );
}
