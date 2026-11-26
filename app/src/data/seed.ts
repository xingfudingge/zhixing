/**
 * 种子数据契约。
 *
 * 真正的写入在 Rust `repositories::seed`（迁移后自动执行一次，不覆盖用户数据）；
 * 这里只暴露固定 ID 与只读概览，供 UI / 测试引用，避免魔法字符串散落。
 */

import type { DbClient } from './db/client';
import type { Board, List, Note, Task } from './db/types';

export const SEED_VERSION = '0002_domain';
export const SEED_MARKER_KEY = 'domain_seed';

export const SEED_IDS = {
  lists: {
    inbox: 'inbox',
    work: 'work',
    life: 'life',
    reading: 'reading',
  },
  notes: {
    welcome: 'seed-note-welcome',
    workflow: 'seed-note-workflow',
  },
  tasks: {
    review: 'seed-task-review',
    inbox: 'seed-task-inbox',
    done: 'seed-task-done',
  },
  board: 'seed-board-flow',
  boardNodes: {
    start: 'seed-node-start',
    review: 'seed-node-review',
    decision: 'seed-node-decision',
    sticky: 'seed-node-sticky',
  },
  settings: {
    theme: 'seed-setting-theme',
  },
} as const;

export type SeedOverview = {
  lists: List[];
  tasks: Task[];
  notes: Note[];
  boards: Board[];
};

/** 只读加载种子概览；不会创建或修改任何数据。 */
export async function loadSeedOverview(
  client: DbClient,
): Promise<SeedOverview> {
  const [lists, tasks, notes, boards] = await Promise.all([
    client.lists.list(),
    client.tasks.list(),
    client.notes.list(),
    client.boards.list(),
  ]);
  return { lists, tasks, notes, boards };
}

export function hasSeedData(overview: SeedOverview): boolean {
  return (
    overview.lists.some((list) => list.id === SEED_IDS.lists.inbox) &&
    overview.tasks.some((task) => task.id === SEED_IDS.tasks.review) &&
    overview.notes.some((note) => note.id === SEED_IDS.notes.welcome) &&
    overview.boards.some((board) => board.id === SEED_IDS.board)
  );
}
