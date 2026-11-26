// @ts-nocheck
/**
 * ZX-090 独立验收 · 原型对齐补充。
 * 覆盖四象限/看板拖拽、任务删除撤销、日历周/日/小工具/时钟，
 * 并记录知识页未接入块编辑器/笔记待办的缺口。
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

function pointer(x, y, extra = {}) {
  return {
    pointerId: 7,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    ...extra,
  };
}

/** Tauri 桌面走 pointer 事件，验收也必须模拟真实指针链路。 */
function pointerDrag(source, target) {
  fireEvent.pointerDown(source, pointer(20, 20));
  fireEvent.pointerMove(target, pointer(120, 120));
  fireEvent.pointerUp(target, pointer(120, 120, { buttons: 0 }));
}

describe('今天 · 四象限与看板', () => {
  it('拖卡改象限；拖卡改状态；卸载重挂载后视图与数据保持', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    const view = await mountApp(world, '/today');
    await screen.findByText('完成验收报告');

    await user.click(screen.getByRole('button', { name: '四象限' }));
    const q1 = await screen.findByRole('region', {
      name: '四象限：重要且紧急',
    });
    const q2 = screen.getByRole('region', { name: '四象限：重要不紧急' });
    const row = within(q1).getByText('完成验收报告').closest('[data-task-id]');
    pointerDrag(row, q2);
    await waitFor(() => {
      expect(
        world.db.tasks.find((task) => task.id === 'task-acceptance')?.quadrant,
      ).toBe(2);
    });

    await user.click(screen.getByRole('button', { name: '看板' }));
    const todo = await screen.findByRole('region', { name: '待办列' });
    const doing = screen.getByRole('region', { name: '进行中列' });
    const done = screen.getByRole('region', { name: '已完成列' });
    const card = within(todo)
      .getByText('完成验收报告')
      .closest('[data-task-id]');
    pointerDrag(card, doing);
    await waitFor(() => {
      expect(
        world.db.tasks.find((task) => task.id === 'task-acceptance')?.status,
      ).toBe('doing');
    });

    const moved = within(doing)
      .getByText('完成验收报告')
      .closest('[data-task-id]');
    pointerDrag(moved, done);
    await waitFor(() => {
      const task = world.db.tasks.find((item) => item.id === 'task-acceptance');
      expect(task.status).toBe('done');
      expect(task.completedAt).toBeTruthy();
    });

    view.unmount();
    await mountApp(world, '/today');
    const restoredDone = await screen.findByRole('region', { name: '已完成列' });
    expect(
      within(restoredDone).getByText('完成验收报告'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '看板' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(consoleErrors).toEqual([]);
  });
});

describe('任务删除与撤销', () => {
  it('删除进入撤销窗口，撤销后任务与子任务/笔记关联恢复', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    world.db.tasks.find((task) => task.id === 'task-acceptance').noteId = 'note-welcome';
    world.db.subtasks.push({
      id: 'sub-existing',
      taskId: 'task-acceptance',
      title: '既有子任务',
      done: false,
      sortOrder: 0,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    });
    await mountApp(world, '/today');
    await screen.findByText('完成验收报告');
    await user.click(
      screen.getByRole('button', { name: '查看任务：完成验收报告' }),
    );
    const detail = await screen.findByRole('complementary', { name: '任务详情' });
    await user.click(within(detail).getByRole('button', { name: '删除任务' }));
    const dialog = await screen.findByRole('dialog', { name: '删除任务' });
    await user.click(within(dialog).getByRole('button', { name: '删除任务' }));

    await waitFor(() => {
      const task = world.db.tasks.find((item) => item.id === 'task-acceptance');
      expect(task.deletedAt).not.toBeNull();
    });
    expect(screen.queryByText('完成验收报告')).not.toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: '撤销' }));
    await waitFor(() => {
      const task = world.db.tasks.find((item) => item.id === 'task-acceptance');
      expect(task.deletedAt).toBeNull();
    });
    expect(
      world.db.subtasks.find((task) => task.id === 'sub-existing'),
    ).toBeTruthy();
    expect(
      world.db.tasks.find((item) => item.id === 'task-acceptance')?.noteId,
    ).toBe('note-welcome');
    expect(consoleErrors).toEqual([]);
  });
});

describe('日历周/日、小工具与时钟', () => {
  it('周/日视图可切换；天数/生肖结果正确；沉浸时钟可开关', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/calendar?date=2026-10-01');
    await screen.findByTestId('month-grid');
    // ?date=2026-10-01 由 CalendarPage 在数据就绪后的 effect 消费；不能只等
    // month-grid 出现（默认月是运行当天，11 月没有法定节假日会误判为 0）。
    await waitFor(() => {
      expect(
        screen.getByTestId('month-grid').querySelectorAll('.calendar-holiday')
          .length,
      ).toBeGreaterThan(0);
    });
    expect(
      screen
        .getByTestId('month-grid')
        .querySelectorAll('.calendar-lunar').length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: '周视图' }));
    expect(
      screen.getByTestId('week-grid').querySelectorAll('[data-date]'),
    ).toHaveLength(7);
    await user.click(screen.getByRole('button', { name: '日视图' }));
    expect(screen.getByTestId('day-view')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '月视图' }));

    await user.click(screen.getByRole('tab', { name: '小工具' }));
    const daysCard = await screen.findByRole('region', { name: '天数计算' });
    await pickDate(user, within(daysCard).getByLabelText('时间 1'), '2026-10-01');
    await pickDate(user, within(daysCard).getByLabelText('时间 2'), '2026-10-07');
    expect(within(daysCard).getByTestId('days-result')).toHaveTextContent('6');
    await user.click(
      within(daysCard).getByRole('button', { name: '切换：包含首尾' }),
    );
    expect(within(daysCard).getByTestId('days-result')).toHaveTextContent('7');

    await user.click(screen.getByRole('button', { name: '生肖查询' }));
    const zodiac = await screen.findByRole('region', { name: '生肖查询' });
    await user.clear(within(zodiac).getByLabelText('查询年份'));
    await user.type(within(zodiac).getByLabelText('查询年份'), '1990');
    expect(within(zodiac).getByText('1990 年 · 属马')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '全屏时钟' }));
    await user.click(
      await screen.findByRole('button', { name: '打开全屏时钟' }),
    );
    const clock = await screen.findByRole('dialog', { name: '沉浸时钟' });
    await user.click(within(clock).getByRole('button', { name: '模拟' }));
    expect(clock.querySelector('[aria-label="模拟时钟"]')).not.toBeNull();
    await user.click(within(clock).getByRole('button', { name: '退出 ESC' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '沉浸时钟' })).not.toBeInTheDocument();
    });
    expect(consoleErrors).toEqual([]);
  });
});

describe('知识页编辑器接线（AUD-002 / AUD-004）', () => {
  it('正文使用块编辑器且无固定格式栏；命令栏、右栏与菜单入口已接入', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/knowledge');
    await screen.findByRole('heading', { level: 1, name: '知识' });
    await user.click(
      await screen.findByRole('button', { name: '打开笔记：欢迎使用知行' }),
    );

    // AUD-002：正文已从单个 HTML contentEditable 换成块编辑器。
    expect(
      await screen.findByRole('region', { name: '块编辑器' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: '笔记正文' }),
    ).not.toBeInTheDocument();
    // 顶部没有固定格式栏；划词条只会在选中文字后浮出。
    expect(screen.queryByRole('toolbar', { name: '文字格式' })).toBeNull();
    // 空块显示「＋ 插入内容」，非空块显示「⠿ 块操作」；同一页面会有多个块级入口，
    // 不能再用唯一的 findByRole 正则匹配（AUD-002 接线后的真实 DOM）。
    const blockEntryPoints = [
      ...screen.queryAllByRole('button', { name: '插入内容' }),
      ...screen.queryAllByRole('button', { name: '块操作' }),
    ];
    expect(blockEntryPoints.length).toBeGreaterThan(0);

    // AUD-004 / ZX-TOOLBAR-02：顶层命令栏、右栏面板、更多/插入菜单均可达；
    // 分享/评论入口仍按单用户边界移除。
    const commandbar = screen.getByRole('toolbar', { name: '文档命令' });
    for (const name of [
      /样式菜单/,
      '插入菜单',
      '插入链接',
      '导出笔记',
      '更多文档操作',
    ]) {
      expect(
        within(commandbar).getByRole('button', { name }),
        `命令栏缺少入口：${String(name)}`,
      ).toBeEnabled();
    }

    // ZX-DESIGN-15 §3.1：右栏恢复 9 项，顺序与原型一致。
    const railLabels = [
      '阅读模式',
      '样式',
      '笔记链接',
      '大纲',
      '笔记信息',
      '附件',
      '专注模式',
      '新建画板',
      '全屏阅读',
    ];
    const rail = screen.getByRole('navigation', { name: '笔记面板' });
    const railItems = Array.from(rail.querySelectorAll('button')).filter(
      (button) => !button.classList.contains('kn-rail-toggle'),
    );
    expect(
      railItems.map((button) => button.getAttribute('aria-label')),
    ).toEqual(railLabels);
    for (const label of railLabels) {
      expect(
        within(rail).getByRole('button', { name: label }),
        `右栏缺少入口：${label}`,
      ).toBeEnabled();
    }

    await user.click(
      within(commandbar).getByRole('button', { name: '更多文档操作' }),
    );
    const moreMenu = await screen.findByRole('menu', { name: '更多' });
    for (const label of [/阅读模式/, /专注模式/, /全屏阅读/]) {
      expect(
        within(moreMenu).getByRole('menuitem', { name: label }),
        `更多菜单缺少：${String(label)}`,
      ).toBeInTheDocument();
    }
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: '更多' })).toBeNull();
    });

    await user.click(
      within(commandbar).getByRole('button', { name: '插入菜单' }),
    );
    const insertMenu = await screen.findByRole('menu', { name: '插入块' });
    expect(
      within(insertMenu).getByRole('menuitem', { name: /画板/ }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: '插入块' })).toBeNull();
    });

    expect(screen.queryByRole('button', { name: '分享' })).toBeNull();
    expect(screen.queryByRole('button', { name: '评论' })).toBeNull();

    // 文末待办属于另一张卡（P1-03），本卡不伪造。
    expect(screen.queryByRole('region', { name: '本篇待办' })).toBeNull();
    expect(consoleErrors).toEqual([]);
  });

  it('≤900 右栏改为工具抽屉，9 项仍可打开而不是消失', async () => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('900px'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    try {
      const user = userEvent.setup();
      const world = createFakeWorld();
      await mountApp(world, '/knowledge');
      await screen.findByRole('heading', { level: 1, name: '知识' });
      await user.click(
        await screen.findByRole('button', { name: '打开笔记：欢迎使用知行' }),
      );

      expect(
        screen.queryByRole('navigation', { name: '笔记面板' }),
      ).toBeNull();
      const commandbar = screen.getByRole('toolbar', { name: '文档命令' });
      const tools = within(commandbar).getByRole('button', { name: '工具' });
      expect(tools).toHaveAttribute('aria-haspopup', 'dialog');

      await user.click(tools);
      const drawer = await screen.findByRole('dialog', { name: '笔记工具' });
      const rows = Array.from(drawer.querySelectorAll('.kn-drawer-row'));
      expect(
        rows.map((row) => row.getAttribute('aria-label')),
      ).toEqual([
        '阅读模式',
        '样式',
        '笔记链接',
        '大纲',
        '笔记信息',
        '附件',
        '专注模式',
        '新建画板',
        '全屏阅读',
      ]);

      await user.click(within(drawer).getByRole('button', { name: '大纲' }));
      expect(
        screen.queryByRole('dialog', { name: '笔记工具' }),
      ).toBeNull();
      expect(
        screen.getByRole('complementary', { name: '笔记大纲' }),
      ).toBeInTheDocument();
      expect(tools).toHaveFocus();
      expect(consoleErrors).toEqual([]);
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: original,
      });
    }
  });
});

describe('事件历法（AUD-024 / DEF-AUD014-02）', () => {
  it('事件弹层与事件行包含原型已确认的公历/农历字段', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/calendar');
    await screen.findByTestId('month-grid');
    await user.click(screen.getByRole('tab', { name: '事件' }));
    await screen.findByRole('region', { name: '当天事件' });

    await user.click(screen.getAllByRole('button', { name: '新建事件' })[0]);
    const dialog = await screen.findByRole('dialog', { name: '新建事件' });
    const select = within(dialog).getByLabelText('历法');
    const appOptions = Array.from(select.options).map((option) => ({
      value: option.value,
      label: option.textContent,
    }));

    // 产品现行历法选项（原型文件已移出代码仓库，不再作为测试依赖）。
    expect(appOptions).toEqual([
      { value: 'solar', label: '公历' },
      { value: 'lunar', label: '农历' },
    ]);

    await user.type(within(dialog).getByLabelText('标题'), '原型对齐农历事件');
    await user.selectOptions(select, 'lunar');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(
        world.db.events.find((event) => event.title === '原型对齐农历事件')
          ?.calendarType,
      ).toBe('lunar');
    });
    // 原型事件行：类别 · 公历/农历 · 重复。
    const row = (
      await screen.findAllByText('原型对齐农历事件')
    )
      .map((node) => node.closest('[data-event-id]'))
      .find(Boolean);
    expect(row?.textContent).toContain('农历');
    expect(consoleErrors).toEqual([]);
  });
});
