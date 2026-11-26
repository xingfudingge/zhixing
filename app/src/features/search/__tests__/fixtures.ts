/**
 * 搜索测试夹具。只服务 P1-06 的单元/组件测试，不参与产品运行路径。
 */

import type {
  Countdown,
  Event,
  Habit,
  List,
  Note,
  Task,
} from '../../../data/db/types';
import type { SearchDataset } from '../model';
import type { SearchSource } from '../source';

const NOW = '2026-10-20T08:00:00.000Z';

export function makeList(
  overrides: Partial<List> & Pick<List, 'id' | 'name'>,
): List {
  return {
    spaceId: 'personal',
    color: '#5579d5',
    icon: '',
    parentId: null,
    sortOrder: 10,
    isInbox: false,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function makeTask(
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
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function makeNote(
  overrides: Partial<Note> & Pick<Note, 'id' | 'title'>,
): Note {
  return {
    spaceId: 'personal',
    folderId: null,
    tags: [],
    body: '',
    bodyFormat: 'html',
    status: 'active',
    favorite: false,
    pinned: false,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function makeEvent(
  overrides: Partial<Event> & Pick<Event, 'id' | 'title' | 'startDate'>,
): Event {
  return {
    spaceId: 'personal',
    eventType: '个人日程',
    allDay: false,
    startAt: null,
    endAt: null,
    tz: 'Asia/Shanghai',
    source: 'local',
    externalUid: null,
    repeatRule: '单次',
    calendarType: 'solar',
    noteId: null,
    color: '',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function makeCountdown(
  overrides: Partial<Countdown> &
    Pick<Countdown, 'id' | 'title' | 'targetDate'>,
): Countdown {
  return {
    spaceId: 'personal',
    category: '自定义',
    calendarType: 'solar',
    repeatRule: '单次',
    lunarMonth: null,
    lunarDay: null,
    note: '',
    color: '',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export function makeHabit(
  overrides: Partial<Habit> & Pick<Habit, 'id' | 'title'>,
): Habit {
  return {
    spaceId: 'personal',
    schedule: '每天',
    icon: '✳',
    color: 'amber',
    goalPerWeek: 7,
    sortOrder: 0,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

export const TEST_TODAY = '2026-10-26';

export function makeSearchDataset(
  overrides: Partial<SearchDataset> = {},
): SearchDataset {
  const lists = [
    makeList({ id: 'inbox', name: '收件箱', isInbox: true, sortOrder: 0 }),
    makeList({ id: 'work', name: '工作', sortOrder: 10 }),
    makeList({ id: 'life', name: '生活', sortOrder: 20 }),
  ];

  return {
    lists,
    tasks: [
      makeTask({
        id: 'task-review',
        title: '完成产品复盘',
        notes: '整理复盘要点',
        listId: 'work',
        dueDate: TEST_TODAY,
        dueTime: '10:30',
        updatedAt: '2026-10-25T09:00:00.000Z',
      }),
      makeTask({
        id: 'task-inbox',
        title: '复盘收件箱想法',
        listId: 'inbox',
        updatedAt: '2026-10-24T09:00:00.000Z',
      }),
      makeTask({
        id: 'task-deleted',
        title: '复盘已删除任务',
        listId: 'work',
        deletedAt: NOW,
      }),
    ],
    notes: [
      makeNote({
        id: 'note-review',
        title: '周复盘模板',
        folderId: 'f4',
        tags: ['复盘'],
        body: '<h2>每周复盘</h2><p>记录三个问题：做成了什么、卡在哪里、下周做什么。</p>',
        updatedAt: '2026-10-26T09:00:00.000Z',
      }),
      makeNote({
        id: 'note-tag-only',
        title: '标签陷阱',
        folderId: 'f1',
        tags: ['复盘'],
        body: '<p>正文里没有那个关键词。</p>',
        updatedAt: '2026-10-25T07:00:00.000Z',
      }),
      makeNote({
        id: 'note-old',
        title: '旧会议纪要',
        folderId: 'f3',
        body: '<p>讨论路线图与排期。</p>',
        updatedAt: '2026-10-21T07:00:00.000Z',
      }),
      makeNote({
        id: 'note-trash',
        title: '复盘回收站笔记',
        status: 'trashed',
        deletedAt: NOW,
        updatedAt: '2026-10-26T10:00:00.000Z',
      }),
    ],
    events: [
      makeEvent({
        id: 'event-review',
        title: '复盘会',
        startDate: '2026-10-27',
        startAt: '2026-10-27T14:00:00',
        updatedAt: '2026-10-24T09:00:00.000Z',
      }),
      makeEvent({
        id: 'event-deleted',
        title: '复盘已删除事件',
        startDate: '2026-10-28',
        deletedAt: NOW,
      }),
    ],
    countdowns: [
      makeCountdown({
        id: 'countdown-review',
        title: '季度复盘日',
        note: '回顾季度目标',
        targetDate: '2026-12-31',
        updatedAt: '2026-10-23T09:00:00.000Z',
      }),
    ],
    habits: [
      makeHabit({
        id: 'habit-review',
        title: '每日复盘',
        schedule: '每天 21:00',
        updatedAt: '2026-10-22T09:00:00.000Z',
      }),
      makeHabit({
        id: 'habit-deleted',
        title: '复盘已删除习惯',
        deletedAt: NOW,
      }),
    ],
    ...overrides,
  };
}

export type FakeSearchSource = SearchSource & {
  loadCount: () => number;
};

export function createFakeSearchSource(
  loader: () => Promise<SearchDataset> = async () => makeSearchDataset(),
): FakeSearchSource {
  let count = 0;
  return {
    async load() {
      count += 1;
      return loader();
    },
    loadCount: () => count,
  };
}
