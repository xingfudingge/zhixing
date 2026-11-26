/**
 * 领域仓储门面。业务页面从这里取数据，不直接接触 IPC 命令名。
 */

import { db, type DbClient } from '../db/client';
import type { List } from '../db/types';
import { createReviewRepository } from './review';

export function createRepositories(client: DbClient = db) {
  return {
    system: client.system,
    lists: {
      ...client.lists,
      async inbox(): Promise<List | null> {
        const lists = await client.lists.list();
        return lists.find((list) => list.isInbox) ?? null;
      },
    },
    tasks: client.tasks,
    notes: client.notes,
    noteTodos: client.noteTodos,
    events: client.events,
    countdowns: client.countdowns,
    habits: client.habits,
    focusSessions: client.focusSessions,
    review: createReviewRepository(client),
    boards: client.boards,
    attachments: client.attachments,
    settings: client.settings,
  };
}

export type Repositories = ReturnType<typeof createRepositories>;

export const repositories = createRepositories();
