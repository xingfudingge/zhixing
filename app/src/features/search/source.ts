/**
 * 搜索数据源：只读本机五类领域表，不发网络请求。
 *
 * 页面可以注入 `SearchSource` 做测试；正式运行时走 Tauri IPC → SQLite。
 * 这里刻意不读取附件、标签索引或 OCR 文本，避免把“未来能力”写进搜索。
 */

import { db, type DbClient } from '../../data/db/client';
import type { SearchDataset } from './model';

export type SearchSource = {
  load: () => Promise<SearchDataset>;
};

export function createSearchSource(client: DbClient = db): SearchSource {
  return {
    load: async () => {
      const [tasks, notes, events, countdowns, habits, lists] =
        await Promise.all([
          client.tasks.list(),
          client.notes.list({ status: 'active' }),
          client.events.list(),
          client.countdowns.list(),
          client.habits.list(),
          client.lists.list(),
        ]);
      return { tasks, notes, events, countdowns, habits, lists };
    },
  };
}
