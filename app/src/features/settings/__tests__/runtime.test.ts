import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbClient } from '../../../data/db/client';
import type { List, NewNote, NewTask, Note, Task } from '../../../data/db/types';
import { SHOW_LUNAR_KEY as CALENDAR_SHOW_LUNAR_KEY } from '../../calendar/CalendarStore';
import { createTaskRepository } from '../../../data/repositories/tasks';
import { createNoteRepository } from '../../../data/repositories/notes';
import {
  DEFAULT_APP_SETTINGS,
  SHOW_LUNAR_KEY,
  type AppSettings,
} from '../../../data/repositories/settings';
import {
  applyNoteDefaults,
  applySettingsToDocument,
  applyTaskDefaults,
  defaultNoteTitle,
  installSettingsBridge,
  setRuntimeSettings,
} from '../runtime';

const lists: List[] = [
  {
    id: 'inbox',
    spaceId: 'personal',
    name: '收件箱',
    color: '#8b96a3',
    icon: 'inbox',
    parentId: null,
    sortOrder: 0,
    isInbox: true,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  },
  {
    id: 'work',
    spaceId: 'personal',
    name: '工作',
    color: '#5579d5',
    icon: 'list',
    parentId: null,
    sortOrder: 1,
    isInbox: false,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  },
  {
    id: 'life',
    spaceId: 'personal',
    name: '生活',
    color: '#d89338',
    icon: 'list',
    parentId: null,
    sortOrder: 2,
    isInbox: false,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  },
];

const settingsWithDefaults: AppSettings = {
  ...DEFAULT_APP_SETTINGS,
  editor: { ...DEFAULT_APP_SETTINGS.editor, titleMode: 'date' },
  task: {
    defaultListId: 'life',
    defaultReminder: '15m',
    completionBehavior: 'keep',
    noteFolderId: 'f2',
  },
  calendar: {
    ...DEFAULT_APP_SETTINGS.calendar,
    showLunar: false,
  },
};

const baseTask: NewTask = {
  title: '写方案',
  listId: 'work',
  dueDate: '2026-10-26',
  status: 'todo',
};

const baseNote: NewNote = {
  title: '未命名笔记',
  folderId: 'f1',
  body: '<p><br></p>',
  bodyFormat: 'html',
};

function fakeClient() {
  const taskInputs: NewTask[] = [];
  const noteInputs: NewNote[] = [];
  const client = {
    tasks: {
      create: async (input: NewTask) => {
        taskInputs.push(input);
        return { id: 'task-1', ...input } as Task;
      },
    },
    notes: {
      create: async (input: NewNote) => {
        noteInputs.push(input);
        return { id: 'note-1', ...input } as Note;
      },
    },
    lists: {
      list: async () => lists,
    },
  } as unknown as DbClient;
  return { client, taskInputs, noteInputs };
}

beforeEach(() => {
  window.localStorage.clear();
  setRuntimeSettings(DEFAULT_APP_SETTINGS);
});

afterEach(() => {
  setRuntimeSettings(DEFAULT_APP_SETTINGS);
  window.localStorage.clear();
});

describe('运行时设置映射', () => {
  it('农历键与日历仓储一致', () => {
    expect(SHOW_LUNAR_KEY).toBe(CALENDAR_SHOW_LUNAR_KEY);
  });

  it('编辑器设置写入 CSS 变量与 data 属性', () => {
    const root = document.documentElement;
    applySettingsToDocument(settingsWithDefaults);

    expect(root.style.getPropertyValue('--editor-font-size')).toBe('15px');
    expect(root.style.getPropertyValue('--editor-paragraph-gap')).toBe('8px');
    expect(root.style.getPropertyValue('--editor-indent')).toBe('0em');
    expect(root.style.getPropertyValue('--editor-width')).toBe('800px');
    expect(root.style.getPropertyValue('--editor-ink')).toBe('var(--ink)');
    expect(root.dataset.editorTitleMode).toBe('date');
    expect(root.dataset.editorBlockIcons).toBe('on');
    expect(root.dataset.editorWidth).toBe('800');
  });

  it('100% 宽度与关闭块图标写入不同值', () => {
    const root = document.documentElement;
    applySettingsToDocument({
      ...settingsWithDefaults,
      editor: {
        ...settingsWithDefaults.editor,
        width: '100%',
        showBlockIcon: false,
        textColor: '#2f5d8a',
      },
    });

    expect(root.style.getPropertyValue('--editor-width')).toBe('100%');
    expect(root.style.getPropertyValue('--editor-ink')).toBe('#2f5d8a');
    expect(root.dataset.editorBlockIcons).toBe('off');
    expect(root.dataset.editorWidth).toBe('100%');
  });

  it('默认标题支持空白、日期与日期时间', () => {
    const at = new Date(2026, 9, 26, 8, 5);
    expect(defaultNoteTitle('empty', at)).toBe('未命名笔记');
    expect(defaultNoteTitle('date', at)).toBe('2026-10-26');
    expect(defaultNoteTitle('datetime', at)).toBe('2026-10-26 08:05');
  });
});

describe('默认清单', () => {
  it('有默认清单时替换自动选择的第一个清单', () => {
    const result = applyTaskDefaults(baseTask, lists, settingsWithDefaults);
    expect(result.listId).toBe('life');
  });

  it('用户显式选择非自动清单时尊重用户', () => {
    // 清单顺序为收件箱、生活、工作；自动项是“生活”，用户明确选了“工作”。
    const result = applyTaskDefaults(
      { ...baseTask, listId: 'work' },
      [lists[0], lists[2], lists[1]],
      settingsWithDefaults,
    );
    expect(result.listId).toBe('work');
  });

  it('显式选 life 时保留 life', () => {
    const result = applyTaskDefaults(
      { ...baseTask, listId: 'life' },
      lists,
      settingsWithDefaults,
    );
    expect(result.listId).toBe('life');
  });

  it('无日期任务保持收件箱规则', () => {
    const result = applyTaskDefaults(
      { ...baseTask, listId: 'inbox', dueDate: null },
      lists,
      settingsWithDefaults,
    );
    expect(result.listId).toBe('inbox');
  });

  it('默认清单已不存在时回退原值', () => {
    const result = applyTaskDefaults(baseTask, lists, {
      ...settingsWithDefaults,
      task: { ...settingsWithDefaults.task, defaultListId: 'deleted' },
    });
    expect(result.listId).toBe('work');
  });

  it('没有默认清单时保持第一个清单', () => {
    const result = applyTaskDefaults(baseTask, lists, {
      ...settingsWithDefaults,
      task: { ...settingsWithDefaults.task, defaultListId: null },
    });
    expect(result.listId).toBe('work');
  });
});

describe('默认笔记目录与标题', () => {
  it('通用新笔记应用默认目录与日期标题', () => {
    const result = applyNoteDefaults(
      baseNote,
      settingsWithDefaults,
      new Date(2026, 9, 26, 8, 5),
    );
    expect(result.folderId).toBe('f2');
    expect(result.title).toBe('2026-10-26');
  });

  it('用户在其他目录新建时保留目标目录', () => {
    const result = applyNoteDefaults(
      { ...baseNote, folderId: 'f3' },
      settingsWithDefaults,
      new Date(2026, 9, 26, 8, 5),
    );
    expect(result.folderId).toBe('f3');
  });

  it('带业务标题的笔记不受影响', () => {
    const result = applyNoteDefaults(
      { ...baseNote, title: '执行笔记 · 写方案', folderId: null },
      settingsWithDefaults,
    );
    expect(result.title).toBe('执行笔记 · 写方案');
    expect(result.folderId).toBeNull();
  });

  it('空白标题模式保留未命名笔记', () => {
    const result = applyNoteDefaults(baseNote, {
      ...settingsWithDefaults,
      editor: { ...settingsWithDefaults.editor, titleMode: 'empty' },
    });
    expect(result.title).toBe('未命名笔记');
  });
});

describe('运行时桥', () => {
  it('包住 create 后默认清单与默认目录真实生效', async () => {
    const { client, taskInputs, noteInputs } = fakeClient();
    setRuntimeSettings(settingsWithDefaults);
    installSettingsBridge(client);

    await client.tasks.create(baseTask);
    await client.notes.create(baseNote);

    expect(taskInputs[0].listId).toBe('life');
    expect(noteInputs[0].folderId).toBe('f2');
    expect(noteInputs[0].title).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('同一 client 只安装一次，不会重复包裹', async () => {
    const { client, taskInputs } = fakeClient();
    setRuntimeSettings(settingsWithDefaults);
    installSettingsBridge(client);
    installSettingsBridge(client);

    await client.tasks.create(baseTask);

    expect(taskInputs).toHaveLength(1);
  });

  it('任务/笔记仓储封装同样经过运行时桥', async () => {
    const { client, taskInputs, noteInputs } = fakeClient();
    setRuntimeSettings(settingsWithDefaults);
    installSettingsBridge(client);
    const tasks = createTaskRepository(client);
    const notes = createNoteRepository(client);

    await tasks.create(baseTask);
    await notes.create(baseNote);

    expect(taskInputs[0].listId).toBe('life');
    expect(noteInputs[0].folderId).toBe('f2');
    expect(noteInputs[0].title).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
