/**
 * 快速创建的纯表单模型。
 *
 * 任务字段与 P0-04/P0-05 的 NewTaskDialog 对齐：
 * 无日期 → 内部 capture 清单（UI 显示未安排）；有日期 → 默认清单
 * （设置页配置或第一个用户清单）。
 * 笔记只先写标题与目录，正文到知识页继续。
 */

import type { List, NewNote, NewTask } from '../../data/db/types';
import { NOTE_FOLDERS } from '../../data/repositories/notes';

export type QuickAddTab = 'task' | 'note';

export type QuickTaskForm = {
  title: string;
  listId: string;
  date: string;
  time: string;
  priority: number;
  quadrant: number;
  noteId: string;
};

export type QuickNoteForm = {
  title: string;
  folderId: string;
};

export class QuickAddError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuickAddError';
  }
}

export function inboxOf(lists: readonly List[]): List | null {
  return lists.find((list) => list.isInbox) ?? null;
}

/** 有日期任务不能落在 capture 清单；这里只返回真实用户清单。 */
export function firstUsableList(lists: readonly List[]): List | null {
  return lists.find((list) => !list.isInbox) ?? null;
}

/**
 * 新建任务时预选清单。无日期时只能是内部 capture 清单；有日期时优先设置页的
 * 默认清单，配置失效再回退到第一个用户清单。
 */
export function resolveTaskListId(
  lists: readonly List[],
  configuredListId: string | null,
  date: string,
): string {
  if (!date.trim()) {
    return inboxOf(lists)?.id ?? '';
  }
  const configured = lists.find(
    (list) => list.id === configuredListId && !list.isInbox,
  );
  return configured?.id ?? firstUsableList(lists)?.id ?? '';
}

export function resolveNoteFolderId(configuredFolderId: string | null): string {
  if (
    configuredFolderId &&
    NOTE_FOLDERS.some((folder) => folder.id === configuredFolderId)
  ) {
    return configuredFolderId;
  }
  return NOTE_FOLDERS[0]?.id ?? '';
}

export function requireQuickAddTitle(value: string, label = '标题'): string {
  const title = value.trim();
  if (!title) {
    throw new QuickAddError(`请先写${label}`);
  }
  return title;
}

export function buildQuickTask(
  form: QuickTaskForm,
  lists: readonly List[],
): NewTask {
  const title = requireQuickAddTitle(form.title, '任务标题');
  const date = form.date.trim() || null;
  const selectedList = lists.find(
    (list) => list.id === form.listId && !list.isInbox,
  );
  const listId = date
    ? selectedList?.id ?? resolveTaskListId(lists, null, date)
    : inboxOf(lists)?.id ?? '';
  if (!listId) {
    throw new QuickAddError('找不到可用清单，无法创建任务');
  }
  return {
    title,
    listId,
    status: 'todo',
    priority: Number.isFinite(form.priority) ? form.priority : 0,
    quadrant: Number.isFinite(form.quadrant) ? form.quadrant : 4,
    dueDate: date,
    dueTime: date && form.time.trim() ? form.time.trim() : null,
    noteId: form.noteId || null,
    notes: '',
  };
}

export function buildQuickNote(form: QuickNoteForm): NewNote {
  const title = requireQuickAddTitle(form.title, '笔记标题');
  return {
    title,
    folderId: form.folderId || resolveNoteFolderId(null),
    tags: [],
    body: '',
    bodyFormat: 'html',
    status: 'active',
  };
}

export function taskDestination(task: Pick<NewTask, 'dueDate'> & {
  id?: string;
}): string {
  const id = encodeURIComponent(task.id ?? '');
  return task.dueDate ? `/today?task=${id}` : `/tasks?task=${id}`;
}

export function noteDestination(note: { id: string }): string {
  return `/knowledge?note=${encodeURIComponent(note.id)}`;
}

/** 显示用目的地，帮助用户在创建前确认任务会落到今天还是未安排。 */
export function quickTaskDestinationLabel(
  date: string,
  lists: readonly List[],
  listId: string,
  today: string,
): string {
  if (!date.trim()) {
    return '未安排';
  }
  const list =
    lists.find((item) => item.id === listId) ?? firstUsableList(lists);
  const when = date === today ? '今天' : date;
  return `${when} · ${list?.name ?? '清单'}`;
}
