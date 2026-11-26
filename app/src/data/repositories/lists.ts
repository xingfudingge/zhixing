/**
 * 清单仓储封装。收件箱是产品不变量：
 * * 不可删除；
 * * 删除普通清单时由 Rust 在同一事务内把任务移到收件箱。
 *
 * 这里再挡一次收件箱删除，保证浏览器端不需要等 IPC 往返就能给出明确提示。
 */

import type { DbClient } from '../db/client';
import type {
  List,
  ListDeleteResult,
  ListMove,
  ListUpdate,
  NewList,
} from '../db/types';

export const INBOX_DELETE_ERROR = '系统清单不能删除';

/** 侧栏树直接写库后通知任务页刷新（与 TaskStore 的刷新广播区分，避免循环）。 */
export const LISTS_CHANGED_EVENT = 'zhixing:lists-changed';

export function createListRepository(client: DbClient) {
  const lists = client.lists;

  return {
    list: (includeDeleted = false): Promise<List[]> =>
      lists.list(includeDeleted),
    get: (id: string): Promise<List> => lists.get(id),
    create: (input: NewList): Promise<List> => lists.create(input),
    update: (id: string, input: ListUpdate): Promise<List> =>
      lists.update(id, input),
    /** 唯一修改父级与同级顺序的入口。 */
    move: (id: string, input: ListMove): Promise<List> =>
      lists.move(id, input),
    async remove(id: string): Promise<ListDeleteResult> {
      const target = await lists.get(id);
      if (target.isInbox) {
        throw new Error(INBOX_DELETE_ERROR);
      }
      return lists.remove(id);
    },
    async inbox(): Promise<List | null> {
      const rows = await lists.list();
      return rows.find((list) => list.isInbox) ?? null;
    },
  };
}

export type ListRepository = ReturnType<typeof createListRepository>;
