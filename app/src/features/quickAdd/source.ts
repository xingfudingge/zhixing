/**
 * 快速创建数据源。页面可注入内存实现做测试，正式运行走 Tauri IPC → SQLite。
 * 任务/笔记创建仍走领域仓储，默认清单与默认目录由 P1-05 设置桥补齐。
 */

import { db, type DbClient } from '../../data/db/client';
import type { List, NewNote, NewTask, Note, Task } from '../../data/db/types';

export type QuickAddSource = {
  lists: () => Promise<List[]>;
  notes: () => Promise<Note[]>;
  createTask: (input: NewTask) => Promise<Task>;
  createNote: (input: NewNote) => Promise<Note>;
};

export function createQuickAddSource(client: DbClient = db): QuickAddSource {
  return {
    lists: () => client.lists.list(),
    notes: () => client.notes.list({ status: 'active' }),
    createTask: (input) => client.tasks.create(input),
    createNote: (input) => client.notes.create(input),
  };
}
