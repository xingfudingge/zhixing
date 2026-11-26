/**
 * 从全局任务创建「执行笔记」。
 *
 * 这是一条显式的跨域用例，不做任何隐式镜像：
 *   1. 在知识域新建一篇普通笔记（标签「执行」，正文含任务回链）；
 *   2. 把任务唯一的 `noteId` 指向新笔记；
 *   3. 不创建 / 勾选 / 同步任何 `note_todos`，也不删除原任务。
 *
 * 任务侧只允许一篇直接关联笔记（数据模型 `tasks.note_id`）。多对多关系属于
 * 后续卡，这里不伪造关系表。
 */

import type { NewNote, Note, Task } from '../../data/db/types';

export const EXECUTION_NOTE_TAG = '执行';
export const EXECUTION_NOTES_CHANGED = 'zhixing:notes-changed';

export type ExecutionNoteTemplate = 'blank' | 'meeting' | 'research' | 'review';

export const EXECUTION_NOTE_TEMPLATES: ReadonlyArray<{
  value: ExecutionNoteTemplate;
  label: string;
}> = [
  { value: 'blank', label: '空白执行笔记' },
  { value: 'meeting', label: '会议纪要' },
  { value: 'research', label: '研究资料' },
  { value: 'review', label: '复盘' },
];

export type ExecutionNoteOptions = {
  template?: ExecutionNoteTemplate;
  /** 用于正文回链；缺省时只写任务 id。 */
  listName?: string | null;
  /** 固定“今天”，便于测试与跨午夜一致性。 */
  today?: string;
};

export type ExecutionNoteSource = {
  notes: {
    create: (input: NewNote) => Promise<Note>;
    remove?: (id: string) => Promise<void>;
  };
  tasks: {
    patch: (
      task: Task,
      patch: { noteId: string | null },
    ) => Promise<Task>;
  };
};

type NoteSection = [heading: string, hint: string];

const TEMPLATE_SECTIONS: Record<ExecutionNoteTemplate, NoteSection[]> = {
  blank: [
    ['背景', '记录为什么要做、约束和已有资料。'],
    ['执行方案', '把步骤拆成可以逐项完成的小动作。'],
    ['结果', '完成后记录产出、结论和遗留问题。'],
  ],
  meeting: [
    ['参会人', ''],
    ['议题', ''],
    ['结论', ''],
    ['行动项', ''],
  ],
  research: [
    ['问题', '这次要回答的核心问题。'],
    ['资料', '链接、来源和关键摘录。'],
    ['结论', '目前能确认的事实与假设。'],
  ],
  review: [
    ['目标', '原本想达成什么。'],
    ['过程', '实际发生了什么。'],
    ['结果', '哪些做成了，哪些没有。'],
    ['下一步', '下一次要调整什么。'],
  ],
};

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

export function executionNoteTitle(task: Pick<Task, 'title'>): string {
  return `执行笔记 · ${task.title.trim()}`;
}

export function taskBacklinkPath(
  taskId: string,
  dueDate: string | null = null,
): string {
  const id = encodeURIComponent(taskId);
  return dueDate ? `/today?task=${id}` : `/tasks?task=${id}`;
}

export function buildExecutionNoteBody(
  task: Task,
  options: ExecutionNoteOptions = {},
): string {
  const template = options.template ?? 'blank';
  const sections = TEMPLATE_SECTIONS[template] ?? TEMPLATE_SECTIONS.blank;
  const title = escapeHtml(task.title);
  const list = options.listName ? escapeHtml(options.listName) : '未分组清单';
  const due = task.dueDate
    ? `${escapeHtml(task.dueDate)}${task.dueTime ? ` ${escapeHtml(task.dueTime)}` : ''}`
    : '未安排日期';

  const body = sections
    .map(
      ([heading, hint]) =>
        `<h2>${escapeHtml(heading)}</h2><p>${escapeHtml(hint)}</p>`,
    )
    .join('');

  return [
    `<div class="callout zx-task-backlink" data-task-id="${escapeHtml(task.id)}" data-task-title="${title}">`,
    `<p>来自任务：<a href="${taskBacklinkPath(task.id, task.dueDate)}">${title}</a></p>`,
    `<p>${list} · ${due}</p>`,
    `</div>`,
    body,
  ].join('');
}

export function buildExecutionNoteInput(
  task: Task,
  options: ExecutionNoteOptions = {},
): NewNote {
  return {
    title: executionNoteTitle(task),
    folderId: null,
    tags: [EXECUTION_NOTE_TAG],
    body: buildExecutionNoteBody(task, options),
    bodyFormat: 'html',
    status: 'active',
    favorite: false,
    pinned: false,
  };
}

/**
 * 从正文里读取任务回链。只认本模块生成的 `data-task-*` 标记，
 * 不按标题猜测，避免把普通链接误认成任务来源。
 */
export function extractTaskBacklink(
  body: string,
): { taskId: string; title: string; path: string | null } | null {
  const match = body.match(
    /data-task-id="([^"]+)"[^>]*data-task-title="([^"]*)"/,
  );
  if (!match) {
    return null;
  }
  // 旧笔记可能没有锚点；新笔记的回链 href 能保留 /today 或 /tasks 上下文。
  const start = match.index ?? 0;
  const window = body.slice(start, start + 600);
  const href = window.match(/<a href="([^"]+)"/);
  return {
    taskId: decodeHtml(match[1]),
    title: decodeHtml(match[2]),
    path: href ? decodeHtml(href[1]) : null,
  };
}

export function notifyNotesChanged(noteId?: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(EXECUTION_NOTES_CHANGED, { detail: { noteId } }),
  );
}

/**
 * 创建执行笔记并回填任务 `noteId`。
 *
 * 当前客户端没有跨仓储事务；如果任务回填失败，会把刚创建的笔记软删除，
 * 避免出现“知识库有一篇孤儿执行笔记、任务却没有任何入口”的半成品。
 */
export async function createExecutionNote(
  source: ExecutionNoteSource,
  task: Task,
  options: ExecutionNoteOptions = {},
): Promise<{ note: Note; task: Task }> {
  if (!task.title.trim()) {
    throw new Error('任务标题为空，无法创建执行笔记');
  }
  if (task.noteId) {
    throw new Error('这个任务已经关联了笔记');
  }

  const note = await source.notes.create(buildExecutionNoteInput(task, options));

  try {
    const nextTask = await source.tasks.patch(task, { noteId: note.id });
    notifyNotesChanged(note.id);
    return { note, task: nextTask };
  } catch (reason) {
    if (source.notes.remove) {
      try {
        await source.notes.remove(note.id);
      } catch {
        // 补偿失败不掩盖原始错误；笔记仍可通过知识页回收站处理。
      }
    }
    throw reason;
  }
}
