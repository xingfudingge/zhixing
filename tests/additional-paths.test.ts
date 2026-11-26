// @ts-nocheck
/**
 * ZX-090 独立验收 · 原型已确认能力的补充路径。
 * 覆盖收件箱分诊、清单删除迁移、任务详情/子任务/执行笔记、日历拖拽/倒数日、
 * 全局搜索/快速创建/导览、设置农历开关。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from '../app/node_modules/react/index.js';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '../app/node_modules/@testing-library/react/dist/index.js';
import userEvent from '../app/node_modules/@testing-library/user-event/dist/esm/index.js';

import { createFakeWorld } from './harness/fakeTauri';
import { pickDate } from '../app/src/test/datePicker';

let consoleErrors = [];
let consoleWarns = [];
let restoreConsole = null;

beforeEach(() => {
  consoleErrors = [];
  consoleWarns = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(args.map(String).join(' '));
  });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
    consoleWarns.push(args.map(String).join(' '));
  });
  restoreConsole = () => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  };
  window.localStorage.clear();
  for (const attr of ['data-theme', 'data-theme-preference', 'data-accent', 'data-density']) {
    document.documentElement.removeAttribute(attr);
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  restoreConsole?.();
  delete window.__TAURI_INTERNALS__;
});

async function mountApp(world, path = '/today') {
  world.install();
  window.history.replaceState({}, '', path);
  const { default: App } = await import('../app/src/App');
  const view = render(React.createElement(App));
  // App 已去掉授权门禁；等首轮 data-load effect 落定，避免测试与初始状态竞态。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return view;
}

function addDays(date, days) {
  const next = new Date(`${date}T12:00:00`);
  next.setDate(next.getDate() + days);
  const pad = (value) => String(value).padStart(2, '0');
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

describe('收件箱与清单', () => {
  it('未安排任务分诊后离开未安排；删除清单后任务迁移到系统清单', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    const template = world.db.tasks.find((task) => task.id === 'task-inbox');
    world.db.tasks.push(
      { ...template, id: 'task-triage-tomorrow', title: '明天分诊任务' },
      { ...template, id: 'task-triage-work', title: '工作分诊任务' },
    );
    const view = await mountApp(world, '/tasks?filter=undated');
    await screen.findByText('整理收件箱');
    await screen.findByText('明天分诊任务');
    await screen.findByText('工作分诊任务');

    const rowOf = (id) => document.querySelector(`[data-task-id="${id}"]`);
    await user.click(within(rowOf('task-inbox')).getByRole('button', { name: '今天' }));
    await waitFor(() => {
      const task = world.db.tasks.find((item) => item.id === 'task-inbox');
      expect(task.dueDate).toBe(world.today);
      expect(task.listId).toBe('work');
    });
    const tomorrow = addDays(world.today, 1);
    await user.click(
      within(rowOf('task-triage-tomorrow')).getByRole('button', { name: '明天' }),
    );
    await waitFor(() => {
      const task = world.db.tasks.find(
        (item) => item.id === 'task-triage-tomorrow',
      );
      expect(task.dueDate).toBe(tomorrow);
      expect(task.listId).toBe('work');
    });
    await user.click(
      within(rowOf('task-triage-work')).getByRole('button', { name: '工作' }),
    );
    await waitFor(() => {
      const task = world.db.tasks.find(
        (item) => item.id === 'task-triage-work',
      );
      expect(task.dueDate).toBe(world.today);
      expect(task.listId).toBe('work');
    });
    expect(screen.queryByText('整理收件箱')).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: '管理清单' }));
    await screen.findByRole('heading', { level: 1, name: '清单管理' });
    await user.click(await screen.findByRole('button', { name: /^工作，/ }));
    await screen.findByRole('heading', { level: 1, name: '工作' });
    await user.click(screen.getByRole('button', { name: '删除清单' }));
    const deleteDialog = await screen.findByRole('dialog', {
      name: '删除清单',
    });
    await user.click(
      within(deleteDialog).getByRole('button', { name: '删除清单' }),
    );
    await waitFor(() => {
      const work = world.db.lists.find((list) => list.id === 'work');
      expect(work.deletedAt).not.toBeNull();
      for (const task of world.db.tasks.filter((task) => task.deletedAt === null)) {
        if (['task-acceptance', 'task-future', 'task-inbox'].includes(task.id)) {
          expect(task.listId).toBe('inbox');
        }
      }
    });
    // 删除当前清单后回到管理概览，不落到其他清单；再从概览新建 / 重名拒绝。
    await screen.findByRole('heading', { level: 1, name: '清单管理' });
    expect(screen.queryByRole('region', { name: '待办' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '新建清单' }));
    const createDialog = await screen.findByRole('dialog', { name: '新建清单' });
    await user.type(within(createDialog).getByLabelText('名称'), '验收清单');
    await user.click(within(createDialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(world.db.lists.some((list) => list.name === '验收清单')).toBe(true);
    });

    await user.click(screen.getByRole('link', { name: '管理清单' }));
    await screen.findByRole('heading', { level: 1, name: '清单管理' });
    await user.click(screen.getByRole('button', { name: '新建清单' }));
    const duplicate = await screen.findByRole('dialog', { name: '新建清单' });
    await user.type(within(duplicate).getByLabelText('名称'), '验收清单');
    await user.click(within(duplicate).getByRole('button', { name: '保存' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('同一父级下已存在同名清单');

    expect(consoleErrors).toEqual([]);
    view.unmount();
  });
});

describe('任务详情', () => {
  it('添加子任务、显示创建时间而不是到期日、创建执行笔记并回链', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/today');
    await screen.findByText('完成验收报告');

    await user.click(
      screen.getByRole('button', { name: '查看任务：完成验收报告' }),
    );
    const detail = await screen.findByRole('complementary', { name: '任务详情' });
    expect(within(detail).getByText(/创建于/)).toHaveTextContent(
      '创建于 2026-10-01',
    );

    const subtaskInput = within(detail).getByLabelText('新子任务');
    await user.type(subtaskInput, '确认验收范围{Enter}');
    await waitFor(() => {
      expect(
        world.db.subtasks.some(
          (subtask) =>
            subtask.taskId === 'task-acceptance' &&
            subtask.title === '确认验收范围',
        ),
      ).toBe(true);
    });

    await user.click(
      within(detail).getByRole('button', { name: '＋ 创建执行笔记' }),
    );
    await waitFor(() => {
      const task = world.db.tasks.find((item) => item.id === 'task-acceptance');
      expect(task.noteId).toBeTruthy();
      const note = world.db.notes.find((item) => item.id === task.noteId);
      expect(note.title).toBe('执行笔记 · 完成验收报告');
      expect(note.tags).toContain('执行');
      expect(note.body).toContain('data-task-id="task-acceptance"');
      expect(note.body).toContain('/today?task=task-acceptance');
    });
    expect(consoleErrors).toEqual([]);
  });
});

describe('日历拖拽与倒数日', () => {
  it('月视图拖动任务只改 dueDate、保留 dueTime；新建倒数日写入仓储', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/calendar');
    const grid = await screen.findByTestId('month-grid');
    const tomorrow = addDays(world.today, 1);

    const chip = grid.querySelector('[data-task-id="task-acceptance"]');
    expect(chip).not.toBeNull();
    const target = grid.querySelector(`[data-date="${tomorrow}"]`);
    expect(target).not.toBeNull();

    fireEvent.dragStart(chip, {
      dataTransfer: { setData: () => undefined, effectAllowed: 'move' },
    });
    fireEvent.dragOver(target);
    fireEvent.drop(target, { dataTransfer: { getData: () => '' } });
    await waitFor(() => {
      const task = world.db.tasks.find((item) => item.id === 'task-acceptance');
      expect(task.dueDate).toBe(tomorrow);
      expect(task.dueTime).toBe('10:30');
    });

    await user.click(screen.getByRole('tab', { name: '倒数日' }));
    await user.click(
      await screen.findByRole('button', { name: '倒数日分区新建倒数日' }),
    );
    const dialog = await screen.findByRole('dialog', { name: '新建倒数日' });
    await user.type(within(dialog).getByLabelText('名称'), '验收纪念日');
    await pickDate(user, within(dialog).getByLabelText('目标日期'), '2027-05-20');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(
        world.db.countdowns.some(
          (countdown) =>
            countdown.title === '验收纪念日' &&
            countdown.targetDate === '2027-05-20',
        ),
      ).toBe(true);
    });
    expect(consoleErrors).toEqual([]);
  });
});

describe('全局入口', () => {
  it('⌘K 搜索打开任务详情；⌘N 快速创建任务；导览跳四象限', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/today');
    await screen.findByText('完成验收报告');

    await user.click(screen.getByRole('button', { name: '全局搜索（⌘K）' }));
    const search = await screen.findByRole('dialog', { name: '全局搜索' });
    await user.type(
      within(search).getByRole('combobox', { name: '搜索本机数据' }),
      '验收',
    );
    const results = await screen.findByRole('listbox', { name: '搜索结果' });
    await user.click(
      await within(results).findByRole('option', { name: /完成验收报告/ }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: '今天' }),
    ).toBeInTheDocument();
    const detail = await screen.findByRole('complementary', {
      name: '任务详情',
    });
    expect(within(detail).getByLabelText('标题')).toHaveValue('完成验收报告');

    await user.click(screen.getByRole('button', { name: '快速创建' }));
    const quick = await screen.findByRole('dialog', { name: '快速创建' });
    await user.type(within(quick).getByLabelText('任务标题'), '快速创建验收任务');
    await user.click(within(quick).getByRole('button', { name: '创建任务' }));
    await waitFor(() => {
      expect(
        world.db.tasks.some((task) => task.title === '快速创建验收任务'),
      ).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: '产品导览' }));
    const tour = await screen.findByRole('dialog', { name: '产品导览' });
    await user.click(within(tour).getByRole('button', { name: '先看四象限' }));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '四象限' }),
      ).toHaveAttribute('aria-pressed', 'true');
    });
    expect(consoleErrors).toEqual([]);
  });
});

describe('设置与日历联动', () => {
  it('关闭显示农历后日历不再渲染农历标签，重新开启后恢复', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/settings/calendar');
    await screen.findByRole('heading', { level: 1, name: '设置' });

    const lunarSwitch = screen.getByRole('switch', { name: '显示农历与节气' });
    expect(lunarSwitch).toHaveAttribute('aria-checked', 'true');
    await user.click(lunarSwitch);
    await waitFor(() => {
      expect(
        world.db.settings.find((row) => row.key === 'calendar.showLunar')?.value,
      ).toBe(false);
    });

    await user.click(screen.getByRole('link', { name: '日历' }));
    await screen.findByTestId('month-grid');
    expect(document.querySelectorAll('.calendar-lunar').length).toBe(0);

    await user.click(screen.getByRole('link', { name: '设置' }));
    await screen.findByRole('heading', { level: 1, name: '设置' });
    await user.click(screen.getByRole('link', { name: '日历与工作日' }));
    await screen.findByRole('heading', { level: 1, name: '设置' });
    await user.click(
      screen.getByRole('switch', { name: '显示农历与节气' }),
    );
    await waitFor(() => {
      expect(
        world.db.settings.find((row) => row.key === 'calendar.showLunar')?.value,
      ).toBe(true);
    });
    await user.click(screen.getByRole('link', { name: '日历' }));
    await screen.findByTestId('month-grid');
    expect(document.querySelectorAll('.calendar-lunar').length).toBeGreaterThan(0);
    expect(consoleErrors).toEqual([]);
  });
});

describe('偏好备份导入', () => {
  it('有效备份覆盖外观/排版/农历；非法 JSON 报错且不覆盖', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/settings/data');
    await screen.findByRole('heading', { level: 1, name: '设置' });

    const backup = {
      app: 'zhixing',
      kind: 'settings',
      version: 1,
      exportedAt: '2026-10-26T00:00:00.000Z',
      appearance: { theme: 'dark', accent: 'violet', density: 'compact' },
      settings: {
        editor: {
          fontSize: 20,
          paragraphSpacing: 12,
          textIndent: 2,
          width: 1024,
          titleMode: 'date',
          showBlockIcon: false,
          textColor: 'auto',
        },
        task: { defaultListId: 'work', noteFolderId: 'f2' },
        calendar: { showLunar: false },
      },
    };
    const input = screen.getByLabelText('选择偏好备份文件');
    await user.upload(
      input,
      new File([JSON.stringify(backup)], 'prefs.json', {
        type: 'application/json',
      }),
    );
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(document.documentElement.dataset.accent).toBe('violet');
      expect(document.documentElement.dataset.density).toBe('compact');
    });
    await waitFor(() => {
      expect(
        world.db.settings.find((row) => row.key === 'editor.fontSize')?.value,
      ).toBe(20);
      expect(
        world.db.settings.find((row) => row.key === 'editor.width')?.value,
      ).toBe(1024);
      expect(
        world.db.settings.find((row) => row.key === 'calendar.showLunar')?.value,
      ).toBe(false);
      expect(
        world.db.settings.find((row) => row.key === 'tasks.defaultListId')
          ?.value,
      ).toBe('work');
    });

    const before = world.db.settings.length;
    await user.upload(
      input,
      new File(['not-json'], 'broken.json', { type: 'application/json' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '文件不是有效的 JSON',
    );
    expect(world.db.settings.length).toBe(before);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(consoleErrors).toEqual([]);
  });
});

describe('画板编辑与保存', () => {
  it('改标题、插入矩形并保存到仓储', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    // 画板是笔记内对象，深链直接打开对应画板编辑器。
    await mountApp(world, '/board/board-acceptance');
    expect(window.location.pathname).toBe('/board/board-acceptance');
    // loading 草稿 → ready 会重挂载 BoardEditor；等标题值落定后再取节点。
    const title = await screen.findByDisplayValue('验收画板');
    await user.click(title);
    await user.keyboard('{End}');
    for (let index = 0; index < 12; index += 1) {
      await user.keyboard('{Backspace}');
    }
    await user.type(title, '验收画板 v2');
    expect(title).toHaveValue('验收画板 v2');
    await user.tab();
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(
      () => {
        expect(
          world.db.boards.find((board) => board.id === 'board-acceptance')
            ?.title,
        ).toBe('验收画板 v2');
      },
      { timeout: 3000 },
    );

    await user.click(screen.getByRole('button', { name: '插入矩形' }));
    await waitFor(() => {
      expect(
        world.db.nodes.filter(
          (node) => node.boardId === 'board-acceptance' && node.deletedAt === null,
        ),
      ).toHaveLength(3);
    });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByText('3 个对象 · 1 条连线')).toBeInTheDocument();
    });
    expect(consoleErrors).toEqual([]);
  });
});
