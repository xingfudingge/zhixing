/**
 * 全局搜索的纯投影层。
 *
 * 事实来源仍是领域表：任务 / 笔记 / 事件 / 倒数日 / 习惯五类。
 * 明确不搜索附件、标签、OCR 文本，也不发网络请求；离线、单用户、本机库。
 *
 * 这里不包含 IPC，方便用固定数据测试匹配、排序、截断与空态。
 */

import { eventTime } from '../events/eventRepository';
import type {
  Countdown,
  Event,
  Habit,
  List,
  Note,
  Task,
} from '../../data/db/types';
import {
  htmlToPlainText,
  noteFolderName,
} from '../../data/repositories/notes';

export type SearchKind = 'task' | 'note' | 'event' | 'countdown' | 'habit';

export type SearchDataset = {
  tasks: Task[];
  notes: Note[];
  events: Event[];
  countdowns: Countdown[];
  habits: Habit[];
  lists: List[];
};

export type SearchHit = {
  key: string;
  kind: SearchKind;
  id: string;
  title: string;
  meta: string;
  excerpt: string | null;
  score: number;
  /** 结果深链：打开原始对象，而不是复制一份搜索结果。 */
  path: string;
};

export type SearchGroup = {
  kind: SearchKind;
  label: string;
  hits: SearchHit[];
};

export type SearchResults = {
  query: string;
  groups: SearchGroup[];
  total: number;
};

export const SEARCH_GROUP_LABELS: Record<SearchKind, string> = {
  task: '任务',
  note: '笔记',
  event: '事件',
  countdown: '倒数日',
  habit: '习惯',
};

export const SEARCH_GROUP_ORDER: readonly SearchKind[] = [
  'task',
  'note',
  'event',
  'countdown',
  'habit',
];

export const SEARCH_LIMITS: Record<SearchKind, number> = {
  task: 6,
  note: 6,
  event: 4,
  countdown: 4,
  habit: 3,
};

export const RECENT_NOTES_LIMIT = 5;

function activeTask(task: Task): boolean {
  return task.deletedAt === null;
}

function activeEvent(event: Event): boolean {
  return event.deletedAt === null;
}

function activeCountdown(countdown: Countdown): boolean {
  return countdown.deletedAt === null;
}

function activeHabit(habit: Habit): boolean {
  return habit.deletedAt === null;
}

/** 只保留仍在使用的笔记；回收站不进入搜索。 */
function activeNote(note: Note): boolean {
  return note.status === 'active' && note.deletedAt === null;
}

export function tokenizeSearchQuery(value: string): string[] {
  return value
    .trim()
    .toLocaleLowerCase('zh-Hans-CN')
    .split(/\s+/)
    .filter(Boolean);
}

function normalized(value: string): string {
  return value.toLocaleLowerCase('zh-Hans-CN');
}

/**
 * 标题命中给更高权重；正文命中仍可命中并显示摘录。
 * 标签、附件名和 OCR 不在任何 text 参数里，因此不会被“顺带搜到”。
 */
function scoreText(
  title: string,
  body: string,
  tokens: readonly string[],
): number {
  if (tokens.length === 0) {
    return 0;
  }
  const titleText = normalized(title);
  const allText = `${titleText}\n${normalized(body)}`;
  if (!tokens.every((token) => allText.includes(token))) {
    return 0;
  }
  if (tokens.every((token) => titleText.includes(token))) {
    return normalized(title.trim()) === tokens.join(' ') ? 6 : 4;
  }
  return 1;
}

function excerptAround(
  text: string,
  tokens: readonly string[],
  maxLength = 58,
): string | null {
  const source = text.replace(/\s+/g, ' ').trim();
  if (!source) {
    return null;
  }
  const lower = normalized(source);
  let index = -1;
  for (const token of tokens) {
    const found = lower.indexOf(token);
    if (found >= 0 && (index < 0 || found < index)) {
      index = found;
    }
  }
  if (index < 0) {
    return source.length > maxLength
      ? `${source.slice(0, maxLength)}…`
      : source;
  }
  const half = Math.floor(maxLength / 2);
  const start = Math.max(0, index - half);
  const end = Math.min(source.length, start + maxLength);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < source.length ? '…' : '';
  return `${prefix}${source.slice(start, end)}${suffix}`;
}

function taskMeta(task: Task, lists: readonly List[], today: string): string {
  const list = lists.find((item) => item.id === task.listId);
  const listName = !list || list.isInbox
    ? '未安排'
    : list.name;
  let when = '无日期';
  if (task.dueDate) {
    when = task.dueDate === today ? '今天' : task.dueDate;
    if (task.dueTime) {
      when += ` ${task.dueTime}`;
    }
  }
  if (task.status === 'done') {
    when = `已完成 · ${when}`;
  }
  return `${listName} · ${when}`;
}

function noteMeta(note: Note): string {
  const folder = noteFolderName(note.folderId);
  const updated = note.updatedAt.slice(0, 10);
  return updated ? `${folder} · 更新 ${updated}` : folder;
}

function eventMeta(event: Event): string {
  const time = eventTime(event);
  return time ? `${event.startDate} ${time}` : `${event.startDate} 全天`;
}

function countdownMeta(countdown: Countdown): string {
  return `${countdown.targetDate} · ${countdown.category || '自定义'}`;
}

function habitMeta(habit: Habit): string {
  return habit.schedule || '每天';
}

function taskBody(task: Task): string {
  return task.notes || '';
}

function noteBody(note: Note): string {
  return htmlToPlainText(note.body);
}

/**
 * 笔记正文命中的首个关键词（N-18）。标题命中但正文没有该词时返回 null，
 * 避免打开笔记后做一次注定失败的定位。
 */
function noteFindToken(note: Note, tokens: readonly string[]): string | null {
  if (tokens.length === 0) {
    return null;
  }
  const body = normalized(noteBody(note));
  return tokens.find((token) => body.includes(token)) ?? null;
}

function notePath(note: Note, tokens: readonly string[]): string {
  const path = `/knowledge?note=${encodeURIComponent(note.id)}`;
  const find = noteFindToken(note, tokens);
  return find ? `${path}&find=${encodeURIComponent(find)}` : path;
}

function countdownBody(countdown: Countdown): string {
  return countdown.note || '';
}

function sortByScoreThenUpdated(
  items: Array<{ hit: SearchHit; updatedAt: string }>,
): SearchHit[] {
  return items
    .sort((a, b) => {
      if (a.hit.score !== b.hit.score) {
        return b.hit.score - a.hit.score;
      }
      if (a.updatedAt !== b.updatedAt) {
        return a.updatedAt < b.updatedAt ? 1 : -1;
      }
      return a.hit.title.localeCompare(b.hit.title, 'zh-Hans-CN');
    })
    .map((item) => item.hit);
}

function groupOf(kind: SearchKind, hits: SearchHit[]): SearchGroup | null {
  if (hits.length === 0) {
    return null;
  }
  return {
    kind,
    label: SEARCH_GROUP_LABELS[kind],
    hits: hits.slice(0, SEARCH_LIMITS[kind]),
  };
}

export function buildRecentNotes(
  notes: readonly Note[],
  limit = RECENT_NOTES_LIMIT,
): SearchHit[] {
  return notes
    .filter(activeNote)
    .slice()
    .sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) {
        return a.updatedAt < b.updatedAt ? 1 : -1;
      }
      return a.title.localeCompare(b.title, 'zh-Hans-CN');
    })
    .slice(0, limit)
    .map((note) => ({
      key: `note:${note.id}`,
      kind: 'note',
      id: note.id,
      title: note.title,
      meta: noteMeta(note),
      excerpt: excerptAround(noteBody(note), [], 52),
      score: 0,
      path: `/knowledge?note=${encodeURIComponent(note.id)}`,
    }));
}

/**
 * 主搜索入口。空查询返回空分组，由 UI 单独展示“最近笔记”。
 */
export function searchDataset(
  dataset: SearchDataset,
  rawQuery: string,
  today: string,
): SearchResults {
  const tokens = tokenizeSearchQuery(rawQuery);
  if (tokens.length === 0) {
    return { query: '', groups: [], total: 0 };
  }

  const tasks: Array<{ hit: SearchHit; updatedAt: string }> = [];
  for (const task of dataset.tasks.filter(activeTask)) {
    const score = scoreText(task.title, taskBody(task), tokens);
    if (score === 0) {
      continue;
    }
    tasks.push({
      updatedAt: task.updatedAt,
      hit: {
        key: `task:${task.id}`,
        kind: 'task',
        id: task.id,
        title: task.title,
        meta: taskMeta(task, dataset.lists, today),
        excerpt:
          score < 4 ? excerptAround(taskBody(task), tokens) : null,
        score,
        path: task.dueDate
          ? `/today?task=${encodeURIComponent(task.id)}`
          : `/tasks?task=${encodeURIComponent(task.id)}`,
      },
    });
  }

  const notes: Array<{ hit: SearchHit; updatedAt: string }> = [];
  for (const note of dataset.notes.filter(activeNote)) {
    const body = noteBody(note);
    const score = scoreText(note.title, body, tokens);
    if (score === 0) {
      continue;
    }
    notes.push({
      updatedAt: note.updatedAt,
      hit: {
        key: `note:${note.id}`,
        kind: 'note',
        id: note.id,
        title: note.title,
        meta: noteMeta(note),
        excerpt: excerptAround(body, tokens),
        score,
        path: notePath(note, tokens),
      },
    });
  }

  const events: Array<{ hit: SearchHit; updatedAt: string }> = [];
  for (const event of dataset.events.filter(activeEvent)) {
    const score = scoreText(event.title, '', tokens);
    if (score === 0) {
      continue;
    }
    events.push({
      updatedAt: event.updatedAt,
      hit: {
        key: `event:${event.id}`,
        kind: 'event',
        id: event.id,
        title: event.title,
        meta: eventMeta(event),
        excerpt: null,
        score,
        path: `/calendar?tab=events&event=${encodeURIComponent(event.id)}`,
      },
    });
  }

  const countdowns: Array<{ hit: SearchHit; updatedAt: string }> = [];
  for (const countdown of dataset.countdowns.filter(activeCountdown)) {
    const body = countdownBody(countdown);
    const score = scoreText(countdown.title, body, tokens);
    if (score === 0) {
      continue;
    }
    countdowns.push({
      updatedAt: countdown.updatedAt,
      hit: {
        key: `countdown:${countdown.id}`,
        kind: 'countdown',
        id: countdown.id,
        title: countdown.title,
        meta: countdownMeta(countdown),
        excerpt: excerptAround(body, tokens),
        score,
        path: `/calendar?tab=countdowns&countdown=${encodeURIComponent(
          countdown.id,
        )}`,
      },
    });
  }

  const habits: Array<{ hit: SearchHit; updatedAt: string }> = [];
  for (const habit of dataset.habits.filter(activeHabit)) {
    const score = scoreText(habit.title, '', tokens);
    if (score === 0) {
      continue;
    }
    habits.push({
      updatedAt: habit.updatedAt,
      hit: {
        key: `habit:${habit.id}`,
        kind: 'habit',
        id: habit.id,
        title: habit.title,
        meta: habitMeta(habit),
        excerpt: null,
        score,
        path: `/habits?habit=${encodeURIComponent(habit.id)}`,
      },
    });
  }

  const groups = [
    groupOf('task', sortByScoreThenUpdated(tasks)),
    groupOf('note', sortByScoreThenUpdated(notes)),
    groupOf('event', sortByScoreThenUpdated(events)),
    groupOf('countdown', sortByScoreThenUpdated(countdowns)),
    groupOf('habit', sortByScoreThenUpdated(habits)),
  ].filter((group): group is SearchGroup => group !== null);

  return {
    query: rawQuery.trim(),
    groups,
    total: groups.reduce((sum, group) => sum + group.hits.length, 0),
  };
}
