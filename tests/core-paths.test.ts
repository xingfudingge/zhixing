// @ts-nocheck
/**
 * ZX-090 独立验收 · 核心路径回归。
 * 每个用例都渲染真实 App/router/页面/store，只把 Tauri IPC 换成内存实现。
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

let consoleErrors: string[] = [];
let consoleWarns: string[] = [];
let restoreConsole: (() => void) | null = null;

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

async function go(user, label, heading, path) {
  await user.click(screen.getByRole('link', { name: label }));
  expect(
    await screen.findByRole('heading', { level: 1, name: heading }),
  ).toBeInTheDocument();
  if (path) expect(window.location.pathname).toBe(path);
}

describe('任务核心路径', () => {
  it('新建任务 → 完成 → 快速双点 → 卸载重挂载后仍在', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    const view = await mountApp(world, '/today');
    await screen.findByText('完成验收报告');

    await user.click(screen.getByRole('button', { name: /＋ 新任务|新任务/ }));
    const dialog = await screen.findByRole('dialog', { name: '新建任务' });
    await user.type(within(dialog).getByLabelText('标题'), '验收新增任务');
    await user.click(within(dialog).getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(
        world.db.tasks.some((task) => task.title === '验收新增任务'),
      ).toBe(true);
    });
    expect(await screen.findByText('验收新增任务')).toBeInTheDocument();

    const created = world.db.tasks.find((task) => task.title === '验收新增任务');
    expect(created.dueDate).toBe(world.today);
    expect(created.listId).toBe('work');

    view.unmount();
    const remounted = await mountApp(world, '/today');
    expect(await screen.findByText('验收新增任务')).toBeInTheDocument();

    const check = screen.getByRole('button', {
      name: '完成任务：完成验收报告',
    });
    // 快速连点：第二次点击发生在第一次异步写入完成前后，都不能崩溃或丢任务。
    fireEvent.click(check);
    fireEvent.click(check);
    await waitFor(() => {
      expect(
        world.db.tasks.find((task) => task.id === 'task-acceptance')?.status,
      ).toBe('done');
    });
    expect(consoleErrors).toEqual([]);
    remounted.unmount();
  });

  it('删除不存在的任务/清单：报错但不删除、不崩溃', async () => {
    const world = createFakeWorld();
    const { createDbClient } = await import('../app/src/data/db/client');
    const { createTaskRepository } = await import(
      '../app/src/data/repositories/tasks'
    );
    const { createListRepository } = await import(
      '../app/src/data/repositories/lists'
    );
    const { TaskWorkspace } = await import(
      '../app/src/features/tasks/TaskWorkspace'
    );
    const { useTaskStore } = await import('../app/src/features/tasks/TaskStore');
    const client = createDbClient(world.invoke);
    const source = {
      tasks: createTaskRepository(client),
      lists: createListRepository(client),
      settings: {
        list: (query) => client.settings.list(query),
        set: (input) => client.settings.set(input),
      },
      notes: {
        list: (query) => client.notes.list(query),
        get: (id) => client.notes.get(id),
        create: (input) => client.notes.create(input),
        remove: (id) => client.notes.remove(id),
      },
    };

    function Probe() {
      const store = useTaskStore();
      const [messages, setMessages] = React.useState([]);
      return React.createElement(
        'div',
        null,
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: async () => {
              const next = [];
              try {
                await store.removeTask('missing-task');
              } catch (error) {
                next.push(`task:${error.message}`);
              }
              try {
                await store.restoreTask('missing-task');
              } catch (error) {
                next.push(`restore:${error.message}`);
              }
              try {
                await store.deleteList('missing-list');
              } catch (error) {
                next.push(`list:${error.message}`);
              }
              setMessages(next);
            },
          },
          '删除不存在',
        ),
        React.createElement('output', { 'data-testid': 'errors' }, messages.join('|')),
      );
    }

    world.install();
    render(
      React.createElement(
        TaskWorkspace,
        { source, today: world.today },
        React.createElement(Probe),
      ),
    );
    await screen.findByRole('button', { name: '删除不存在' });
    fireEvent.click(screen.getByRole('button', { name: '删除不存在' }));
    await waitFor(() => {
      expect(screen.getByTestId('errors').textContent).toContain(
        '任务不存在：missing-task',
      );
      expect(screen.getByTestId('errors').textContent).toContain(
        '清单不存在：missing-list',
      );
    });
    expect(world.db.tasks).toHaveLength(5);
    expect(world.db.lists).toHaveLength(3);
    expect(consoleErrors).toEqual([]);
  });
});

describe('日历核心路径', () => {
  it('月视图显示任务与事件；新建事件后日历与仓储同步', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/calendar');

    const grid = await screen.findByTestId('month-grid');
    expect(within(grid).getAllByRole('gridcell')).toHaveLength(42);
    expect(screen.getAllByText('产品评审会').length).toBeGreaterThan(0);
    expect(screen.getAllByText('完成验收报告').length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole('button', { name: '新建事件' })[0]);
    const dialog = await screen.findByRole('dialog', { name: '新建事件' });
    await user.type(within(dialog).getByLabelText('标题'), '验收会议');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(
        world.db.events.some((event) => event.title === '验收会议'),
      ).toBe(true);
    });
    expect(screen.getAllByText('验收会议').length).toBeGreaterThan(0);
    expect(consoleErrors).toEqual([]);
  });

  it('新建农历生日事件：弹层有历法字段，保存后 DB 与列表都记农历', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/calendar');
    await screen.findByTestId('month-grid');
    await user.click(screen.getByRole('tab', { name: '事件' }));
    await screen.findByRole('region', { name: '当天事件' });

    await user.click(screen.getAllByRole('button', { name: '新建事件' })[0]);
    const dialog = await screen.findByRole('dialog', { name: '新建事件' });
    // DEF-AUD014-02：原型 evCal 的「历法：公历/农历」必须存在。
    const calendar = within(dialog).getByLabelText('历法');
    expect(calendar).toHaveValue('solar');
    expect(
      Array.from((calendar as HTMLSelectElement).options).map(
        (option) => option.textContent,
      ),
    ).toEqual(['公历', '农历']);

    await user.type(within(dialog).getByLabelText('标题'), '外婆农历生日');
    await user.selectOptions(within(dialog).getByLabelText('类别'), '生日');
    await user.selectOptions(calendar, 'lunar');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(
        world.db.events.some(
          (event) =>
            event.title === '外婆农历生日' && event.calendarType === 'lunar',
        ),
      ).toBe(true);
    });
    const row = (
      await screen.findAllByText('外婆农历生日')
    )
      .map((node) => node.closest('[data-event-id]'))
      .find(Boolean) as HTMLElement;
    expect(row.textContent).toContain('农历');
    expect(consoleErrors).toEqual([]);
  });

  it('倒数日分区可查看已有倒数日', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/calendar');
    await screen.findByTestId('month-grid');

    await user.click(screen.getByRole('tab', { name: '倒数日' }));
    expect(await screen.findByText('元旦')).toBeInTheDocument();
    expect(consoleErrors).toEqual([]);
  });
});

describe('习惯核心路径', () => {
  it('今日打卡可撤销/恢复；未来日期不可打卡；安排行动生成今天任务', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/habits');
    await screen.findByRole('button', { name: '安排行动：阅读 20 分钟' });
    const habitList = document.querySelector('[aria-label="习惯列表"]');
    expect(habitList).not.toBeNull();

    const todayButton = within(habitList).getByRole('button', {
      name: `阅读 20 分钟 ${world.today} 已打卡`,
    });
    await user.click(todayButton);
    await waitFor(() => {
      expect(
        world.db.logs.filter(
          (log) =>
            log.habitId === 'habit-read' &&
            log.logDate === world.today &&
            log.deletedAt === null,
        ),
      ).toHaveLength(0);
    });
    await user.click(
      await within(habitList).findByRole('button', {
        name: `阅读 20 分钟 ${world.today} 未打卡`,
      }),
    );
    await waitFor(() => {
      expect(
        world.db.logs.filter(
          (log) =>
            log.habitId === 'habit-read' &&
            log.logDate === world.today &&
            log.deletedAt === null,
        ),
      ).toHaveLength(1);
    });

    const future = new Date(`${world.today}T12:00:00`);
    future.setDate(future.getDate() + 1);
    const pad = (value) => String(value).padStart(2, '0');
    const tomorrow = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(
      future.getDate(),
    )}`;
    const futureButton = within(habitList).queryByRole('button', {
      name: `阅读 20 分钟 ${tomorrow} 未打卡（未来日期，不可打卡）`,
    });
    if (futureButton) {
      await user.click(futureButton);
      expect(
        world.db.logs.some(
          (log) => log.habitId === 'habit-read' && log.logDate === tomorrow,
        ),
      ).toBe(false);
    }

    await user.click(
      within(habitList).getByRole('button', { name: '安排行动：阅读 20 分钟' }),
    );
    await waitFor(() => {
      const task = world.db.tasks.find(
        (item) => item.title === '习惯：阅读 20 分钟',
      );
      expect(task).toBeTruthy();
      expect(task.dueDate).toBe(world.today);
      expect(task.listId).toBe('life');
    });
    expect(consoleErrors).toEqual([]);
  });
});

describe('知识核心路径', () => {
  it('打开笔记、改标题/正文；新建笔记；删除进回收站并恢复', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/knowledge');

    await screen.findByRole('heading', { level: 1, name: '知识' });
    await screen.findByRole('button', { name: '打开笔记：欢迎使用知行' });
    await user.click(
      screen.getByRole('button', { name: '打开笔记：欢迎使用知行' }),
    );
    const title = await screen.findByLabelText('笔记标题');
    expect(title).toHaveValue('欢迎使用知行');

    await user.clear(title);
    await user.type(title, '欢迎使用知行（验收）');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(
        world.db.notes.find((note) => note.id === 'note-welcome')?.title,
      ).toBe('欢迎使用知行（验收）');
    });

    // AUD-002：正文已换成块编辑器，不再有单个「笔记正文」contentEditable。
    // 旧 HTML 会被投影成块；这里编辑第一个段落块并等回写 notes.body。
    const paragraphs = await screen.findAllByRole('textbox', { name: '正文' });
    expect(paragraphs.length).toBeGreaterThan(0);
    const body = paragraphs[0];
    expect(body).toHaveAttribute('contenteditable', 'true');
    body.textContent = '验收正文：任务、知识与时间。';
    fireEvent.input(body);
    await waitFor(
      () => {
        expect(
          world.db.notes.find((note) => note.id === 'note-welcome')?.body,
        ).toContain('验收正文');
      },
      { timeout: 3000 },
    );

    await user.click(screen.getAllByRole('button', { name: '新建笔记' })[0]);
    await waitFor(() => {
      expect(world.db.notes).toHaveLength(3);
      expect(screen.getByLabelText('笔记标题')).toHaveValue('未命名笔记');
    });

    await user.click(
      screen.getByRole('button', { name: '打开笔记：欢迎使用知行（验收）' }),
    );
    await user.click(
      screen.getByRole('button', { name: '更多操作：欢迎使用知行（验收）' }),
    );
    await user.click(
      screen.getByRole('menuitem', { name: /^删除笔记/ }),
    );
    const dialog = await screen.findByRole('dialog', { name: '删除笔记' });
    await user.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() => {
      expect(
        world.db.notes.find((note) => note.id === 'note-welcome')?.status,
      ).toBe('trashed');
    });

    await user.click(screen.getByRole('button', { name: '回收站' }));
    await user.click(
      await screen.findByRole('button', {
        name: '更多操作：欢迎使用知行（验收）',
      }),
    );
    await user.click(
      screen.getByRole('menuitem', { name: /^恢复笔记/ }),
    );
    await waitFor(() => {
      expect(
        world.db.notes.find((note) => note.id === 'note-welcome')?.status,
      ).toBe('active');
    });
    expect(consoleErrors).toEqual([]);
  });
});

describe('复盘核心路径', () => {
  it('三卡与来源数据一致；保存为复盘笔记；重复保存幂等', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/review');

    const tasksCard = await screen.findByRole('article', { name: '完成任务' });
    const focusCard = screen.getByRole('article', { name: '专注时长' });
    const habitsCard = screen.getByRole('article', { name: '习惯打卡' });
    expect(within(tasksCard).getByText('1')).toBeInTheDocument();
    expect(focusCard).toHaveTextContent('25');
    expect(within(habitsCard).getByText('1')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('NaN');

    await user.click(
      screen.getByRole('button', { name: '保存为复盘笔记' }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: '知识' }),
    ).toBeInTheDocument();
    expect(
      (await screen.findAllByText(`复盘 · ${world.today}`)).length,
    ).toBeGreaterThan(0);
    expect(world.db.snapshots).toHaveLength(1);
    expect(world.db.snapshots[0]).toMatchObject({
      rangeStart: (() => {
        const date = new Date(`${world.today}T12:00:00`);
        date.setDate(date.getDate() - 6);
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      })(),
      rangeEnd: world.today,
      taskIds: ['task-done'],
      focusIds: ['focus-today'],
      habitIds: ['habit-read'],
    });

    await go(user, '复盘', '复盘', '/review');
    await screen.findByRole('article', { name: '完成任务' });
    await user.click(
      screen.getByRole('button', { name: '保存为复盘笔记' }),
    );
    await screen.findByRole('heading', { level: 1, name: '知识' });
    expect(world.db.snapshots).toHaveLength(1);
    expect(consoleErrors).toEqual([]);
  });
});

describe('画板核心路径', () => {
  it('加载已有画板的节点/连线，阅读模式可切换', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    // 画板没有独立列表页：深链直接进入笔记内的画板编辑器。
    await mountApp(world, '/board/board-acceptance');
    expect(window.location.pathname).toBe('/board/board-acceptance');
    // 画板先渲染 loading 草稿，加载完成后 BoardEditor 会以 ready 关键帧重挂载；
    // 先等已加载标识，避免拿住即将被替换的 canvas/title 节点。
    expect(
      await screen.findByText('2 个对象 · 1 条连线'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('application', { name: '画板画布' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('画板标题')).toHaveValue('验收画板');

    await user.click(screen.getByRole('button', { name: '阅读' }));
    expect(screen.getByRole('button', { name: '退出阅读' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: '退出阅读' }));
    expect(screen.getByRole('button', { name: '阅读' })).toBeInTheDocument();
    expect(consoleErrors).toEqual([]);
  });
});

describe('设置核心路径', () => {
  it('深色/字号/宽度即时生效，重挂载后保持；偏好重置回到默认', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    const view = await mountApp(world, '/settings/appearance');
    await screen.findByRole('heading', { level: 1, name: '设置' });

    const themeGroup = screen.getByRole('group', { name: '主题' });
    await user.click(within(themeGroup).getByRole('button', { name: '深色' }));
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
    });
    expect(window.localStorage.getItem('zhixing.appearance.v1')).toContain(
      '"theme":"dark"',
    );

    await user.selectOptions(screen.getByLabelText('正文字号'), '20');
    await waitFor(() => {
      expect(
        world.db.settings.find((row) => row.key === 'editor.fontSize')?.value,
      ).toBe(20);
    });
    await user.click(
      within(screen.getByRole('group', { name: '编辑区宽度' })).getByRole(
        'button',
        { name: '1024' },
      ),
    );
    await waitFor(() => {
      expect(
        world.db.settings.find((row) => row.key === 'editor.width')?.value,
      ).toBe(1024);
    });

    view.unmount();
    await mountApp(world, '/settings/appearance');
    await screen.findByRole('heading', { level: 1, name: '设置' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByLabelText('正文字号')).toHaveValue('20');
    expect(
      within(screen.getByRole('group', { name: '编辑区宽度' })).getByRole(
        'button',
        { name: '1024' },
      ),
    ).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('link', { name: '数据与备份' }));
    await screen.findByRole('button', { name: '重置本机偏好' });
    await user.click(
      screen.getByRole('button', { name: '重置本机偏好' }),
    );
    await user.click(
      await screen.findByRole('button', { name: '确认重置' }),
    );
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('light');
    });
    expect(consoleErrors).toEqual([]);
  });
});
