import { describe, expect, it } from 'vitest';

import type { List, Task } from '../../../data/db/types';
import {
  ancestorIds,
  buildListTree,
  countOpenTasks,
  listPath,
  nextSortOrder,
  orderedUserLists,
  resolveDefaultList,
  sortOrderForDrop,
  subtreeIds,
  validateListMove,
} from '../tree';

function list(overrides: Partial<List> & Pick<List, 'id' | 'name'>): List {
  return {
    spaceId: 'personal',
    color: '#5579d5',
    icon: '',
    parentId: null,
    sortOrder: 10,
    isInbox: false,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function task(
  overrides: Partial<Task> & Pick<Task, 'id' | 'title' | 'listId'>,
): Task {
  return {
    spaceId: 'personal',
    parentId: null,
    noteId: null,
    notes: '',
    status: 'todo',
    priority: 0,
    quadrant: 4,
    dueDate: null,
    dueTime: null,
    dueAt: null,
    tz: 'Asia/Shanghai',
    reminder: '',
    sortOrder: 0,
    completedAt: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

const baseLists: List[] = [
  list({ id: 'inbox', name: '收件箱', isInbox: true, sortOrder: 0 }),
  list({ id: 'work', name: '工作', sortOrder: 10 }),
  list({ id: 'life', name: '生活', sortOrder: 20 }),
  list({ id: 'project', name: '项目 A', parentId: 'work', sortOrder: 10 }),
  list({ id: 'detail', name: '细节', parentId: 'project', sortOrder: 10 }),
];

describe('清单树模型', () => {
  it('按树序展开，收件箱不进入用户清单树', () => {
    const tree = buildListTree(baseLists);
    expect(tree.map((node) => node.list.id)).toEqual(['work', 'life']);
    expect(tree[0].children.map((node) => node.list.id)).toEqual(['project']);
    expect(tree[0].children[0].children.map((node) => node.list.id)).toEqual([
      'detail',
    ]);
    expect(orderedUserLists(baseLists).map((item) => item.id)).toEqual([
      'work',
      'project',
      'detail',
      'life',
    ]);
  });

  it('父级缺失的历史数据按根级兜底，不丢清单', () => {
    const tree = buildListTree([
      ...baseLists,
      list({ id: 'orphan', name: '孤儿', parentId: 'missing' }),
    ]);
    expect(tree.some((node) => node.list.id === 'orphan')).toBe(true);
  });

  it('计数为子树未完成合计；同时提供全部未完成数', () => {
    const tasks = [
      task({ id: 't1', title: '工作直接', listId: 'work' }),
      task({ id: 't2', title: '项目任务', listId: 'project' }),
      task({ id: 't3', title: '生活无日期', listId: 'life' }),
      task({
        id: 't4',
        title: '已完成',
        listId: 'project',
        status: 'done',
      }),
      task({
        id: 't5',
        title: '有日期',
        listId: 'work',
        dueDate: '2026-10-26',
      }),
      task({ id: 't6', title: '收件箱任务', listId: 'inbox' }),
    ];
    const counts = countOpenTasks(baseLists, tasks);
    expect(counts.byId.get('work')).toBe(3);
    expect(counts.byId.get('project')).toBe(1);
    expect(counts.byId.get('life')).toBe(1);
    // 无日期任务：t1/t2/t3/t6，共 4 条（含其他清单里的无日期任务）。
    expect(counts.inbox).toBe(4);
    expect(counts.openTotal).toBe(5);
  });

  it('默认清单：优先设置项，其次树序第一个，最后 null', () => {
    expect(resolveDefaultList(baseLists, 'life')?.id).toBe('life');
    expect(resolveDefaultList(baseLists, 'inbox')?.id).toBe('work');
    expect(resolveDefaultList(baseLists, 'missing')?.id).toBe('work');
    expect(
      resolveDefaultList([list({ id: 'inbox', name: '收件箱', isInbox: true })]),
    ).toBeNull();
  });

  it('拒绝移到系统清单、子孙节点与第 4 层', () => {
    expect(validateListMove(baseLists, 'work', 'inbox')).toBe(
      '不能把清单放到系统清单下',
    );
    expect(validateListMove(baseLists, 'work', 'detail')).toBe(
      '清单不能移动到自己的子清单下',
    );
    expect(validateListMove(baseLists, 'work', 'project')).toBe(
      '清单不能移动到自己的子清单下',
    );
    const deeper = [
      ...baseLists,
      list({ id: 'other', name: '另一棵', sortOrder: 30 }),
      list({ id: 'other-child', name: '另一棵子', parentId: 'other', sortOrder: 10 }),
    ];
    expect(validateListMove(deeper, 'project', 'other-child')).toBe(
      '最多支持 3 层清单',
    );
    expect(validateListMove(baseLists, 'inbox', null)).toBe(
      '系统清单不能移动',
    );
    expect(validateListMove(baseLists, 'detail', 'life')).toBeNull();
  });

  it('排序：同级末尾 +10，中间取中点', () => {
    expect(nextSortOrder(baseLists, 'work')).toBe(20);
    expect(sortOrderForDrop(baseLists, 'life', null, 0)).toBe(0);
    expect(sortOrderForDrop(baseLists, 'detail', null, 1)).toBe(15);
    expect(sortOrderForDrop(baseLists, 'work', null, 1)).toBe(30);
  });

  it('祖先、子树与路径', () => {
    expect([...subtreeIds(baseLists, 'work')].sort()).toEqual([
      'detail',
      'project',
      'work',
    ]);
    expect(ancestorIds(baseLists, 'detail')).toEqual(['project', 'work']);
    expect(listPath(baseLists, 'detail')).toBe('工作 / 项目 A / 细节');
  });
});
