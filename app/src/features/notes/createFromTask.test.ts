import { describe, expect, it, vi } from 'vitest';

import type { Note, Task } from '../../data/db/types';
import {
  buildExecutionNoteBody,
  buildExecutionNoteInput,
  createExecutionNote,
  executionNoteTitle,
  extractTaskBacklink,
} from './createFromTask';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    spaceId: 'personal',
    listId: 'work',
    parentId: null,
    noteId: null,
    title: '完成新版产品需求文档',
    notes: '',
    status: 'todo',
    priority: 2,
    quadrant: 1,
    dueDate: '2026-10-26',
    dueTime: '10:30',
    dueAt: null,
    tz: 'Asia/Shanghai',
    reminder: '',
    sortOrder: 1,
    completedAt: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    spaceId: 'personal',
    title: '执行笔记',
    folderId: null,
    tags: ['执行'],
    body: '',
    bodyFormat: 'html',
    status: 'active',
    favorite: false,
    pinned: false,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

describe('createFromTask', () => {
  it('生成执行笔记标题、标签与任务回链，且不产生笔记待办字段', () => {
    const task = makeTask();
    const input = buildExecutionNoteInput(task, {
      listName: '工作',
      template: 'meeting',
    });

    expect(input.title).toBe('执行笔记 · 完成新版产品需求文档');
    expect(input.tags).toEqual(['执行']);
    expect(input.folderId).toBeNull();
    expect(input.bodyFormat).toBe('html');
    expect(input.body).toContain('data-task-id="task-1"');
    expect(input.body).toContain('href="/today?task=task-1"');
    expect(input.body).toContain('工作 · 2026-10-26 10:30');
    expect(input.body).toContain('<h2>参会人</h2>');
    expect(input).not.toHaveProperty('noteTodos');
    expect(input).not.toHaveProperty('taskId');
  });

  it('正文转义标题与清单名，回链解析不会误伤普通链接', () => {
    const task = makeTask({
      title: 'A <B> & "C"',
      dueDate: null,
    });
    const body = buildExecutionNoteBody(task, { listName: '<工作>' });

    expect(body).toContain('A &lt;B&gt; &amp; &quot;C&quot;');
    expect(body).toContain('&lt;工作&gt;');
    expect(body).toContain('未安排日期');

    expect(extractTaskBacklink(body)).toEqual({
      taskId: 'task-1',
      title: 'A <B> & "C"',
      path: '/tasks?task=task-1',
    });
    expect(
      extractTaskBacklink('<p><a href="/today?task=x">普通链接</a></p>'),
    ).toBeNull();
  });

  it('创建笔记后把任务 noteId 指回新笔记', async () => {
    const task = makeTask();
    const note = makeNote({ id: 'note-new', title: executionNoteTitle(task) });
    const create = vi.fn(async () => note);
    const patch = vi.fn(
      async (current: Task, update: { noteId: string | null }) => ({
        ...current,
        noteId: update.noteId,
      }),
    );

    const result = await createExecutionNote(
      { notes: { create, remove: vi.fn() }, tasks: { patch } },
      task,
      { listName: '工作' },
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(task, { noteId: 'note-new' });
    expect(result.note).toBe(note);
    expect(result.task.noteId).toBe('note-new');
  });

  it('任务回填失败时软删除刚创建的笔记，避免孤儿笔记', async () => {
    const task = makeTask();
    const note = makeNote({ id: 'note-orphan' });
    const remove = vi.fn(async () => undefined);

    await expect(
      createExecutionNote(
        {
          notes: { create: async () => note, remove },
          tasks: {
            patch: async () => {
              throw new Error('任务写入失败');
            },
          },
        },
        task,
      ),
    ).rejects.toThrow('任务写入失败');

    expect(remove).toHaveBeenCalledWith('note-orphan');
  });

  it('一个任务只保留一个直接关联笔记，已有 noteId 时拒绝再建', async () => {
    const task = makeTask({ noteId: 'note-existing' });

    await expect(
      createExecutionNote(
        {
          notes: { create: vi.fn() },
          tasks: { patch: vi.fn() },
        },
        task,
      ),
    ).rejects.toThrow('已经关联了笔记');
  });
});
