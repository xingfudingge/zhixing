import { describe, expect, it } from 'vitest';

import {
  buildRecentNotes,
  searchDataset,
  SEARCH_LIMITS,
  type SearchDataset,
} from '../model';
import {
  makeCountdown,
  makeEvent,
  makeHabit,
  makeNote,
  makeSearchDataset,
  makeTask,
  TEST_TODAY,
} from './fixtures';

function allHitIds(query: string, dataset: SearchDataset = makeSearchDataset()) {
  return searchDataset(dataset, query, TEST_TODAY).groups.flatMap((group) =>
    group.hits.map((hit) => hit.id),
  );
}

describe('全局搜索投影', () => {
  it('搜「复盘」同时返回任务、笔记、事件、倒数日、习惯五类', () => {
    const result = searchDataset(makeSearchDataset(), '复盘', TEST_TODAY);

    expect(result.groups.map((group) => group.kind)).toEqual([
      'task',
      'note',
      'event',
      'countdown',
      'habit',
    ]);
    expect(result.groups.map((group) => group.label)).toEqual([
      '任务',
      '笔记',
      '事件',
      '倒数日',
      '习惯',
    ]);
    expect(allHitIds('复盘')).toEqual(
      expect.arrayContaining([
        'task-review',
        'task-inbox',
        'note-review',
        'event-review',
        'countdown-review',
        'habit-review',
      ]),
    );
    expect(result.total).toBe(6);
  });

  it('回收站笔记、软删除任务/事件/倒数日/习惯不进入结果', () => {
    const ids = allHitIds('复盘');
    expect(ids).not.toContain('task-deleted');
    expect(ids).not.toContain('note-trash');
    expect(ids).not.toContain('event-deleted');
    expect(ids).not.toContain('habit-deleted');
  });

  it('不搜索笔记标签；只命中标题或正文', () => {
    const ids = allHitIds('复盘');
    expect(ids).not.toContain('note-tag-only');
    expect(ids).toContain('note-review');
  });

  it('笔记正文按纯文本搜索，HTML 标签不会造成误命中', () => {
    const dataset = makeSearchDataset({
      notes: [
        makeNote({
          id: 'note-html',
          title: '设计记录',
          body: '<p>按钮 <strong>颜色</strong> 需要统一。</p>',
        }),
      ],
      tasks: [],
      events: [],
      countdowns: [],
      habits: [],
    });
    expect(allHitIds('颜色', dataset)).toEqual(['note-html']);
    expect(allHitIds('<strong>', dataset)).toEqual([]);
  });

  it('多关键词按 AND 匹配，英文大小写不敏感', () => {
    const dataset = makeSearchDataset({
      tasks: [
        makeTask({
          id: 'task-a',
          title: 'Weekly REVIEW',
          notes: '整理 next steps',
          listId: 'work',
        }),
        makeTask({
          id: 'task-b',
          title: 'Weekly review',
          notes: '别的备注',
          listId: 'work',
        }),
      ],
      notes: [],
      events: [],
      countdowns: [],
      habits: [],
    });

    expect(allHitIds('weekly review', dataset).sort()).toEqual([
      'task-a',
      'task-b',
    ]);
    expect(allHitIds('review next', dataset)).toEqual(['task-a']);
    expect(allHitIds('review missing', dataset)).toEqual([]);
  });

  it('每类结果按上限截断，且标题命中优先于正文命中', () => {
    const tasks = Array.from({ length: 9 }, (_, index) =>
      makeTask({
        id: `body-${index}`,
        title: `第 ${index} 条`,
        notes: '关键词在备注里',
        listId: 'work',
        updatedAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    tasks.push(
      makeTask({
        id: 'title-hit',
        title: '关键词在标题',
        listId: 'work',
        updatedAt: '2026-09-01T00:00:00.000Z',
      }),
    );
    const result = searchDataset(
      makeSearchDataset({
        tasks,
        notes: [],
        events: [],
        countdowns: [],
        habits: [],
      }),
      '关键词',
      TEST_TODAY,
    );
    const group = result.groups[0];
    expect(group.hits).toHaveLength(SEARCH_LIMITS.task);
    expect(group.hits[0].id).toBe('title-hit');
  });

  it('空查询不返回分组；最近笔记按更新时间倒序且排除回收站', () => {
    const dataset = makeSearchDataset();
    expect(searchDataset(dataset, '   ', TEST_TODAY)).toEqual({
      query: '',
      groups: [],
      total: 0,
    });

    const recent = buildRecentNotes(dataset.notes);
    expect(recent.map((hit) => hit.id)).toEqual([
      'note-review',
      'note-tag-only',
      'note-old',
    ]);
    expect(recent[0].excerpt).toContain('每周复盘');
    expect(buildRecentNotes(dataset.notes, 1)).toHaveLength(1);
  });

  it('结果深链打开原始对象：有日期任务进今天，无日期任务进任务中心', () => {
    const result = searchDataset(makeSearchDataset(), '复盘', TEST_TODAY);
    const hits = result.groups.flatMap((group) => group.hits);
    const find = (id: string) => hits.find((hit) => hit.id === id);

    expect(find('task-review')?.path).toBe('/today?task=task-review');
    expect(find('task-inbox')?.path).toBe('/tasks?task=task-inbox');
    expect(find('note-review')?.path).toBe(
      '/knowledge?note=note-review&find=%E5%A4%8D%E7%9B%98',
    );
    expect(find('event-review')?.path).toBe(
      '/calendar?tab=events&event=event-review',
    );
    expect(find('countdown-review')?.path).toBe(
      '/calendar?tab=countdowns&countdown=countdown-review',
    );
    expect(find('habit-review')?.path).toBe('/habits?habit=habit-review');
  });

  it('笔记正文命中带上首个关键词，标题命中但正文没有时不带定位参数', () => {
    const dataset = makeSearchDataset({
      tasks: [],
      notes: [
        makeNote({
          id: 'note-title-only',
          title: '复盘标题',
          body: '<p>正文没有那个词。</p>',
        }),
      ],
      events: [],
      countdowns: [],
      habits: [],
    });
    const result = searchDataset(dataset, '复盘', TEST_TODAY);
    const hit = result.groups
      .flatMap((group) => group.hits)
      .find((item) => item.id === 'note-title-only');
    expect(hit?.path).toBe('/knowledge?note=note-title-only');
  });

  it('正文命中时给出关键词附近的摘录，事件/习惯只用标题匹配', () => {
    const dataset = makeSearchDataset({
      events: [
        makeEvent({
          id: 'event-type',
          title: '周会',
          startDate: '2026-10-27',
          eventType: '复盘',
        }),
      ],
      habits: [
        makeHabit({
          id: 'habit-schedule',
          title: '阅读',
          schedule: '每天复盘',
        }),
      ],
      notes: [
        makeNote({
          id: 'note-long',
          title: '长文',
          body: `<p>${'前'.repeat(30)}关键词${'后'.repeat(30)}</p>`,
        }),
      ],
      tasks: [],
      countdowns: [],
    });

    const ids = allHitIds('复盘', dataset);
    expect(ids).not.toContain('event-type');
    expect(ids).not.toContain('habit-schedule');

    const noteResult = searchDataset(dataset, '关键词', TEST_TODAY);
    expect(noteResult.groups[0].hits[0].excerpt).toContain('关键词');
    expect(noteResult.groups[0].hits[0].excerpt?.startsWith('…')).toBe(true);
  });

  it('倒数日备注可搜索，任务备注命中时显示摘录', () => {
    const dataset = makeSearchDataset({
      tasks: [
        makeTask({
          id: 'task-note',
          title: '准备材料',
          notes: '给复盘会准备数据',
          listId: 'work',
        }),
      ],
      countdowns: [
        makeCountdown({
          id: 'countdown-note',
          title: '年度纪念',
          targetDate: '2026-12-31',
          note: '写年度复盘',
        }),
      ],
      notes: [],
      events: [],
      habits: [],
    });

    const result = searchDataset(dataset, '复盘', TEST_TODAY);
    const taskHit = result.groups
      .find((group) => group.kind === 'task')
      ?.hits.find((hit) => hit.id === 'task-note');
    const countdownHit = result.groups
      .find((group) => group.kind === 'countdown')
      ?.hits.find((hit) => hit.id === 'countdown-note');

    expect(taskHit?.excerpt).toContain('复盘');
    expect(countdownHit?.excerpt).toContain('复盘');
  });
});
