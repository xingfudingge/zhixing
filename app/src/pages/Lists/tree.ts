/**
 * 清单树的纯函数模型（ZX-UX-02）。
 *
 * 约定：
 * * 内部 capture 清单（is_inbox=1）不是普通树的节点，也不在树上渲染。
 * * 用户清单按 `sortOrder → name → id` 排序，最多 3 层。
 * * 计数统一为“未完成”，父节点是子树合计（含自身）。
 * * 所有函数只读入数据，不访问 IPC/localStorage，便于单测与侧栏/清单页共享。
 */

import type { List, Task } from '../../data/db/types';

export const MAX_LIST_DEPTH = 3;

export type ListNode = {
  list: List;
  depth: number;
  children: ListNode[];
};

export function isActiveList(list: List): boolean {
  return list.deletedAt === null;
}

/** 同一父级下的确定性排序。 */
export function compareSiblingLists(a: List, b: List): number {
  if (a.sortOrder !== b.sortOrder) {
    return a.sortOrder - b.sortOrder;
  }
  if (a.name !== b.name) {
    return a.name < b.name ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
}

export function childLists(lists: List[], parentId: string | null): List[] {
  return lists
    .filter(
      (list) => isActiveList(list) && !list.isInbox && list.parentId === parentId,
    )
    .slice()
    .sort(compareSiblingLists);
}

export function buildListTree(lists: List[]): ListNode[] {
  const active = lists.filter(isActiveList);
  const ids = new Set(active.map((list) => list.id));
  const childrenOf = (parentId: string) =>
    active
      .filter((list) => !list.isInbox && list.parentId === parentId)
      .slice()
      .sort(compareSiblingLists);

  const visited = new Set<string>();
  const build = (list: List, depth: number, ancestry: Set<string>): ListNode => {
    visited.add(list.id);
    const nextAncestry = new Set(ancestry).add(list.id);
    const children =
      depth < MAX_LIST_DEPTH
        ? childrenOf(list.id)
            .filter((child) => !nextAncestry.has(child.id))
            .map((child) => build(child, depth + 1, nextAncestry))
        : [];
    return { list, depth, children };
  };

  const roots = active
    .filter(
      (list) =>
        !list.isInbox &&
        (list.parentId === null || !ids.has(list.parentId)),
    )
    .sort(compareSiblingLists)
    .map((list) => build(list, 1, new Set()));

  // 环或父级缺失导致未挂载的节点，按根级兜底展示，避免整棵树消失。
  for (const list of active.filter((item) => !item.isInbox)) {
    if (!visited.has(list.id)) {
      roots.push(build(list, 1, new Set()));
    }
  }
  return roots;
}

export function flattenListTree(nodes: ListNode[]): ListNode[] {
  return nodes.flatMap((node) => [node, ...flattenListTree(node.children)]);
}

/** 树序（根→子→孙），用于默认清单解析与下拉选项。 */
export function orderedUserLists(lists: List[]): List[] {
  return flattenListTree(buildListTree(lists)).map((node) => node.list);
}

export function listDepthOf(lists: List[], id: string): number {
  const byId = new Map(lists.filter(isActiveList).map((list) => [list.id, list]));
  let current = byId.get(id);
  let depth = 0;
  while (current && depth < 32) {
    depth += 1;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return depth;
}

export function subtreeIds(lists: List[], id: string): Set<string> {
  const result = new Set<string>([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const list of lists) {
      if (
        isActiveList(list) &&
        list.parentId !== null &&
        result.has(list.parentId) &&
        !result.has(list.id)
      ) {
        result.add(list.id);
        changed = true;
      }
    }
  }
  return result;
}

export function subtreeHeight(
  lists: List[],
  id: string,
  seen: Set<string> = new Set(),
): number {
  if (seen.has(id)) {
    return 1;
  }
  const next = new Set(seen).add(id);
  const children = childLists(lists, id).filter(
    (child) => !next.has(child.id),
  );
  if (children.length === 0) {
    return 1;
  }
  return (
    1 + Math.max(...children.map((child) => subtreeHeight(lists, child.id, next)))
  );
}

export function isDescendantOf(
  lists: List[],
  candidateId: string,
  ancestorId: string,
): boolean {
  return subtreeIds(lists, ancestorId).has(candidateId);
}

/**
 * 返回 null 表示允许移动；否则返回要展示给用户的拒绝原因。
 * 与 Rust `lists_move` 的校验保持一致，UI 只做提前反馈，库层仍是权威。
 */
export function validateListMove(
  lists: List[],
  id: string,
  parentId: string | null,
): string | null {
  const target = lists.find((list) => list.id === id && isActiveList(list));
  if (!target) {
    return '清单不存在或已被删除';
  }
  if (target.isInbox) {
    return '系统清单不能移动';
  }
  if (parentId === null) {
    return null;
  }
  if (parentId === id) {
    return '清单不能移动到自己的子清单下';
  }
  const parent = lists.find((list) => list.id === parentId && isActiveList(list));
  if (!parent) {
    return '目标清单不存在或已被删除';
  }
  if (parent.isInbox) {
    return '不能把清单放到系统清单下';
  }
  if (isDescendantOf(lists, parentId, id)) {
    return '清单不能移动到自己的子清单下';
  }
  if (listDepthOf(lists, parentId) + subtreeHeight(lists, id) > MAX_LIST_DEPTH) {
    return '最多支持 3 层清单';
  }
  return null;
}

export function nextSortOrder(
  lists: List[],
  parentId: string | null,
): number {
  const siblings = childLists(lists, parentId);
  return Math.max(0, ...siblings.map((list) => list.sortOrder)) + 10;
}

/** 拖到同级第 index 个位置（已排除被拖节点）时建议的小数 sortOrder。 */
export function sortOrderForDrop(
  lists: List[],
  movingId: string,
  parentId: string | null,
  index: number,
): number {
  const siblings = childLists(lists, parentId).filter(
    (list) => list.id !== movingId,
  );
  const bounded = Math.max(0, Math.min(index, siblings.length));
  if (siblings.length === 0) {
    return 10;
  }
  if (bounded === 0) {
    return siblings[0].sortOrder - 10;
  }
  if (bounded >= siblings.length) {
    return siblings[siblings.length - 1].sortOrder + 10;
  }
  return (siblings[bounded - 1].sortOrder + siblings[bounded].sortOrder) / 2;
}

export type ListCounts = {
  /** 普通清单：自身 + 全部后代的未完成任务数。 */
  byId: Map<string, number>;
  /** 全部未删除、未完成任务（跨清单、含无日期）；侧栏「任务」徽标口径。 */
  openTotal: number;
  /**
   * 无日期未完成投影计数。
   * 仅保留给历史纯函数测试；UI 不再渲染系统清单行，也不再依赖它。
   */
  inbox: number;
};

export function countOpenTasks(
  lists: List[],
  tasks: Task[],
): ListCounts {
  const openTasks = tasks.filter(
    (task) => task.deletedAt === null && task.status !== 'done',
  );
  const direct = new Map<string, number>();
  for (const list of lists) {
    direct.set(list.id, 0);
  }
  for (const task of openTasks) {
    direct.set(task.listId, (direct.get(task.listId) ?? 0) + 1);
  }

  const byId = new Map<string, number>();
  const accumulate = (nodes: ListNode[]): number => {
    let total = 0;
    for (const node of nodes) {
      const own = direct.get(node.list.id) ?? 0;
      const children = accumulate(node.children);
      const value = own + children;
      byId.set(node.list.id, value);
      total += value;
    }
    return total;
  };
  accumulate(buildListTree(lists));

  for (const list of lists) {
    if (!list.isInbox && !byId.has(list.id)) {
      byId.set(list.id, direct.get(list.id) ?? 0);
    }
  }

  return {
    byId,
    openTotal: openTasks.length,
    inbox: openTasks.filter((task) => task.dueDate === null).length,
  };
}

/**
 * 默认清单解析器（D-IA-8）：
 * settings.task.defaultListId → 树序第一个用户清单 → null。
 */
export function resolveDefaultList(
  lists: List[],
  preferredId?: string | null,
): List | null {
  if (preferredId) {
    const preferred = lists.find(
      (list) =>
        list.id === preferredId && isActiveList(list) && !list.isInbox,
    );
    if (preferred) {
      return preferred;
    }
  }
  return orderedUserLists(lists)[0] ?? null;
}

export function ancestorIds(lists: List[], id: string): string[] {
  const byId = new Map(lists.filter(isActiveList).map((list) => [list.id, list]));
  const result: string[] = [];
  let current = byId.get(id);
  let guard = 0;
  while (current?.parentId && guard < 32) {
    result.push(current.parentId);
    current = byId.get(current.parentId);
    guard += 1;
  }
  return result;
}

export function listPath(lists: List[], id: string): string {
  const byId = new Map(lists.filter(isActiveList).map((list) => [list.id, list]));
  const names: string[] = [];
  let current = byId.get(id);
  let guard = 0;
  while (current && guard < 32) {
    names.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
    guard += 1;
  }
  return names.join(' / ');
}

export function collapsedStorageValue(ids: Iterable<string>): string {
  return JSON.stringify([...ids]);
}

export function parseCollapsedStorage(value: string | null): Set<string> {
  if (!value) {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((item): item is string => typeof item === 'string'));
  } catch {
    return new Set();
  }
}
