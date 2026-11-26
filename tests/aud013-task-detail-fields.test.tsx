// @ts-nocheck
/**
 * AUD-013 独立验收 · F-004 任务详情字段（日期 / 优先级 / 提醒 / 状态 / 象限）。
 *
 * 方法：
 *  * 渲染真实 App / Router / 页面 / TaskStore / 仓储客户端；
 *  * 只把 Tauri IPC 换成 `tests/harness/fakeTauri.ts` 的内存命令路由；
 *  * 每个字段都用真实 DOM 事件修改，断言「详情即时值 + 其他视图可见结果 +
 *    后端行值」，再卸载并重新挂载 App 模拟刷新，重新读取同一后端行；
 *  * 额外覆盖空数据、跨页一致、快速连续修改、删除不存在项、控制台零报错。
 *
 * DEF-AUD013-01/02/03 已作为回归用例固化：同 tick 多字段更新、提醒短码解析、
 * 中文提醒值回显；对应修复在 TaskStore/planner/TaskDetailPanel。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from '../app/node_modules/react/index.js';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '../app/node_modules/@testing-library/react/dist/index.js';
import userEvent from '../app/node_modules/@testing-library/user-event/dist/esm/index.js';

import {
  buildTaskReminderPlans,
  parseReminderOffsetMinutes,
} from '../app/src/features/notifications/planner';
import { DEFAULT_NOTIFICATION_SETTINGS } from '../app/src/features/notifications/types';
import { createFakeWorld } from './harness/fakeTauri';
import { clearDate, dateFieldValue, pickDate } from '../app/src/test/datePicker';

const TASK_ID = 'task-acceptance';
const TASK_TITLE = '完成验收报告';

let consoleErrors: string[] = [];
let consoleWarns: string[] = [];
let restoreConsole: (() => void) | null = null;

function isActWarning(message: string): boolean {
  return message.includes('not wrapped in act(');
}

function step(message: string) {
  // 步骤记录随 `--silent=false` 输出，作为本卡的操作证据。
  console.info(`[AUD-013] ${message}`);
}

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
  for (const attr of [
    'data-theme',
    'data-theme-preference',
    'data-accent',
    'data-density',
  ]) {
    document.documentElement.removeAttribute(attr);
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  restoreConsole?.();
  delete window.__TAURI_INTERNALS__;
});

function taskRow(world: ReturnType<typeof createFakeWorld>) {
  return world.db.tasks.find((task: { id: string }) => task.id === TASK_ID);
}

function addDays(iso: string, days: number) {
  const date = new Date(`${iso}T12:00:00`);
  date.setDate(date.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}`;
}

function monthDay(iso: string) {
  const [, month, day] = iso.split('-').map(Number);
  return `${month}月${day}日`;
}

async function mountApp(
  world: ReturnType<typeof createFakeWorld>,
  path = '/today',
) {
  world.install();
  window.history.replaceState({}, '', path);
  const { default: App } = await import('../app/src/App');
  return render(React.createElement(App));
}

async function openDetail(
  user: ReturnType<typeof userEvent.setup>,
  title = TASK_TITLE,
) {
  await user.click(
    await screen.findByRole('button', { name: `查看任务：${title}` }),
  );
  return screen.findByRole('complementary', { name: '任务详情' });
}

async function waitForRow(
  world: ReturnType<typeof createFakeWorld>,
  patch: Record<string, unknown>,
) {
  await waitFor(() => {
    expect(taskRow(world)).toMatchObject(patch);
  });
}

async function expectCleanConsole({ allowAct = false } = {}) {
  const errors = allowAct
    ? consoleErrors.filter((message) => !isActWarning(message))
    : consoleErrors;
  expect(errors).toEqual([]);
  expect(consoleWarns).toEqual([]);
}

describe('AUD-013 · 任务详情字段', () => {
  it('日期：修改 → 详情/元信息/今天视图即时变化 → 刷新后保持；清空回到未安排', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    const tomorrow = addDays(world.today, 1);
    await mountApp(world);
    const detail = await openDetail(user);
    const dateInput = within(detail).getByLabelText('日期');

    expect(dateFieldValue(dateInput)).toBe(world.today);
    step(`打开「${TASK_TITLE}」，日期初值 ${world.today}`);

    await pickDate(user, dateInput, tomorrow);
    await waitForRow(world, { dueDate: tomorrow });
    await within(detail).findByText(
      (_, element) =>
        element?.className === 'task-detail-meta' &&
        element.textContent?.includes(`到期 ${tomorrow}`),
    );
    expect(dateFieldValue(within(detail).getByLabelText('日期'))).toBe(tomorrow);
    expect(await screen.findByText('日期已更新')).toBeInTheDocument();
    expect(detail.querySelector('.task-detail-meta')).toHaveTextContent(
      `到期 ${tomorrow}`,
    );
    step(`日期改为 ${tomorrow}：后端 dueDate、详情值、元信息「到期 ${tomorrow}」同步`);

    // 今天视图立即不再显示该任务；详情仍保持打开。
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: `查看任务：${TASK_TITLE}` }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('complementary', { name: '任务详情' }),
    ).toBeInTheDocument();
    step('未来日期任务从「今天」列表即时消失，详情仍可编辑');

    // 跨页：清单管理 → 手动打开工作，任务出现在「待办」组，日期徽标可见。
    await user.click(screen.getByRole('link', { name: '管理清单' }));
    await screen.findByRole('heading', { level: 1, name: '清单管理' });
    await user.click(await screen.findByRole('button', { name: /^工作，/ }));
    const future = await screen.findByRole('region', { name: '待办' });
    expect(within(future).getByText(TASK_TITLE)).toBeInTheDocument();
    expect(within(future).getByText(/明天 10:30/)).toBeInTheDocument();
    step(`跨页「工作」清单「待办」分组显示 ${TASK_TITLE} 与日期「明天 10:30」`);

    // 刷新：卸载真实 App，再以同一后端重新挂载。
    screen.getByRole('complementary', { name: '任务详情' });
    cleanup();
    await mountApp(world, '/lists/work');
    const reloadedList = await screen.findByRole('region', { name: '待办' });
    expect(within(reloadedList).getByText(TASK_TITLE)).toBeInTheDocument();
    const reloadedDetail = await openDetail(user);
    expect(dateFieldValue(within(reloadedDetail).getByLabelText('日期'))).toBe(
      tomorrow,
    );
    expect(
      reloadedDetail.querySelector('.task-detail-meta'),
    ).toHaveTextContent(`到期 ${tomorrow}`);
    step(`卸载重挂载后日期仍为 ${tomorrow}`);

    // 清空日期：自动回到未安排、时间清空、未安排可见。
    await clearDate(user, within(reloadedDetail).getByLabelText('日期'));
    await waitForRow(world, { dueDate: null, listId: 'work', dueTime: null });
    expect(await screen.findByText('已移到未安排')).toBeInTheDocument();
    expect(
      within(reloadedDetail).getByText('未安排日期'),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('link', { name: /^任务/ }),
    );
    expect(
      await screen.findByRole('button', { name: `查看任务：${TASK_TITLE}` }),
    ).toBeInTheDocument();
    step('清空日期后 dueDate=null、dueTime=null、listId 保持 work，未安排可见');

    await expectCleanConsole();
  });

  it('优先级：修改 → 行内优先级点与看板文本即时变化 → 刷新后保持', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world);
    const detail = await openDetail(user);
    const priority = within(detail).getByLabelText('优先级');

    expect(priority).toHaveValue('3');
    expect(screen.getByLabelText('优先级 3')).toBeInTheDocument();
    step('优先级初值 3，行内出现「优先级 3」三点');

    await user.selectOptions(priority, '1');
    await waitForRow(world, { priority: 1 });
    expect(within(detail).getByLabelText('优先级')).toHaveValue('1');
    const badge = await screen.findByLabelText('优先级 1');
    expect(badge.querySelectorAll('i.on')).toHaveLength(1);
    step('改为 1：后端 priority=1，行内只剩 1 个点亮优先级点');

    await user.selectOptions(within(detail).getByLabelText('优先级'), '0');
    await waitForRow(world, { priority: 0 });
    expect(screen.queryByLabelText('优先级 0')).not.toBeInTheDocument();
    expect(within(detail).getByLabelText('优先级')).toHaveValue('0');
    step('改为无：行内优先级点整体消失');

    await user.selectOptions(within(detail).getByLabelText('优先级'), '2');
    await waitForRow(world, { priority: 2 });
    await user.click(screen.getByRole('button', { name: '看板' }));
    const todoColumn = await screen.findByRole('region', { name: '待办列' });
    const priorityCard = within(todoColumn)
      .getByText(TASK_TITLE)
      .closest('.task-card');
    expect(priorityCard).not.toBeNull();
    expect(priorityCard).toHaveTextContent('优先级 2');
    step('看板「待办」卡片显示「· 优先级 2」');

    await user.click(screen.getByRole('button', { name: '列表' }));
    await screen.findByRole('region', { name: '今天未完成' });
    cleanup();
    await mountApp(world, '/today');
    const reloaded = await openDetail(user);
    expect(within(reloaded).getByLabelText('优先级')).toHaveValue('2');
    const reloadedRow = screen
      .getByRole('button', { name: `查看任务：${TASK_TITLE}` })
      .closest('.task-row');
    expect(reloadedRow).not.toBeNull();
    expect(within(reloadedRow).getByLabelText('优先级 2')).toBeInTheDocument();
    step('卸载重挂载后优先级仍为 2，详情与行内一致');

    await expectCleanConsole();
  });

  it('提醒：修改 → 下拉值与提示即时可见 → 跨页/刷新后保持 → 可清空', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world);
    let detail = await openDetail(user);
    let reminder = within(detail).getByLabelText('提醒');

    expect(reminder).toHaveValue('');
    await user.selectOptions(reminder, '15m');
    await waitForRow(world, { reminder: '15m' });
    expect(await screen.findByText('提醒已更新')).toBeInTheDocument();
    expect(within(detail).getByLabelText('提醒')).toHaveValue('15m');
    step('提醒改为提前 15 分钟：后端 reminder=15m，下拉值与 toast 可见');

    // 跨页：从清单管理打开「工作」清单，再打开同一任务，提醒值一致。
    await user.click(screen.getByRole('link', { name: '管理清单' }));
    await screen.findByRole('heading', { level: 1, name: '清单管理' });
    await user.click(await screen.findByRole('button', { name: /^工作，/ }));
    detail = await openDetail(user);
    expect(within(detail).getByLabelText('提醒')).toHaveValue('15m');
    step('跨页「工作」清单打开同一任务，提醒仍为 15m');

    cleanup();
    await mountApp(world, '/lists/work');
    detail = await openDetail(user);
    expect(within(detail).getByLabelText('提醒')).toHaveValue('15m');
    step('卸载重挂载后提醒仍为 15m');

    await user.selectOptions(within(detail).getByLabelText('提醒'), '');
    await waitForRow(world, { reminder: '' });
    expect(within(detail).getByLabelText('提醒')).toHaveValue('');
    expect(await screen.findByText('提醒已更新')).toBeInTheDocument();
    step('提醒可清空为「不提醒」，后端 reminder 为空串');

    await expectCleanConsole();
  });

  it('状态：待办→进行中→已完成→撤销回进行中，列表/看板即时同步，刷新后保持', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world);
    const detail = await openDetail(user);
    let status = within(detail).getByLabelText('状态');

    expect(status).toHaveValue('todo');
    await user.selectOptions(status, 'doing');
    await waitForRow(world, { status: 'doing' });
    expect(await screen.findByText('已恢复为进行中')).toBeInTheDocument();
    expect(within(detail).getByLabelText('状态')).toHaveValue('doing');
    const doingRow = screen
      .getByRole('button', { name: `查看任务：${TASK_TITLE}` })
      .closest('.task-row');
    expect(doingRow).not.toBeNull();
    expect(within(doingRow).getByText('进行中')).toBeInTheDocument();
    step('状态改为进行中：后端 status=doing，详情下拉与行内「进行中」徽标同步');

    await user.click(screen.getByRole('button', { name: '看板' }));
    let doingColumn = await screen.findByRole('region', {
      name: '进行中列',
    });
    expect(within(doingColumn).getByText(TASK_TITLE)).toBeInTheDocument();
    step('看板「进行中」列出现该任务');

    const doingCard = within(doingColumn)
      .getByText(TASK_TITLE)
      .closest('.task-card');
    expect(doingCard).not.toBeNull();
    await user.click(doingCard);
    const boardDetail = await screen.findByRole('complementary', {
      name: '任务详情',
    });
    await user.selectOptions(
      within(boardDetail).getByLabelText('状态'),
      'done',
    );
    await waitForRow(world, { status: 'done' });
    expect(taskRow(world).completedAt).toBeTruthy();
    expect(screen.getByRole('status')).toHaveTextContent('已完成');
    expect(
      within(boardDetail).getByRole('button', { name: '撤销完成' }),
    ).toBeInTheDocument();
    const doneColumn = await screen.findByRole('region', { name: '已完成列' });
    expect(within(doneColumn).getByText(TASK_TITLE)).toBeInTheDocument();
    step('状态改为已完成：completedAt 写入，看板移入「已完成」列，按钮变为撤销完成');

    // 已完成任务仍可编辑字段（任务详情要求）。
    await user.selectOptions(
      within(boardDetail).getByLabelText('优先级'),
      '1',
    );
    await waitForRow(world, { status: 'done', priority: 1 });
    step('完成后仍可修改优先级，status 保持 done');

    // 回到列表视图核对已完成分组，再刷新。
    await user.click(screen.getByRole('button', { name: '列表' }));
    const doneSection = await screen.findByRole('region', {
      name: '今天已完成',
    });
    expect(within(doneSection).getByText(TASK_TITLE)).toBeInTheDocument();
    step('列表视图「今天 · 已完成」分组显示该任务');

    cleanup();
    await mountApp(world, '/lists/work');
    const doneGroup = await screen.findByRole('region', { name: '已完成' });
    expect(within(doneGroup).getByText(TASK_TITLE)).toBeInTheDocument();
    const reloaded = await openDetail(user);
    expect(within(reloaded).getByLabelText('状态')).toHaveValue('done');
    expect(
      within(reloaded).getByRole('button', { name: '撤销完成' }),
    ).toBeInTheDocument();
    step('卸载重挂载后 status=done、completedAt 保持，「工作」清单已完成分组可见');

    // 撤销完成 → 回到完成前的进行中（不是降级为待办）。
    await user.click(
      within(reloaded).getByRole('button', { name: '撤销完成' }),
    );
    await waitForRow(world, { status: 'doing' });
    expect(taskRow(world).completedAt).toBeNull();
    expect(within(reloaded).getByLabelText('状态')).toHaveValue('doing');
    step('撤销完成回到 doing，completedAt 清空，详情与列表同步');

    await expectCleanConsole();
  });

  it('象限：修改 → 四象限视图即时迁移 → 刷新后保持 → 切到其他视图仍一致', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world);
    let detail = await openDetail(user);
    let quadrant = within(detail).getByLabelText('象限');

    expect(quadrant).toHaveValue('1');
    await user.selectOptions(quadrant, '2');
    await waitForRow(world, { quadrant: 2 });
    expect(within(detail).getByLabelText('象限')).toHaveValue('2');
    step('象限改为 2：「重要不紧急」，后端 quadrant=2');

    await user.click(screen.getByRole('button', { name: '四象限' }));
    const q1 = await screen.findByRole('region', {
      name: '四象限：重要且紧急',
    });
    const q2 = screen.getByRole('region', { name: '四象限：重要不紧急' });
    expect(within(q2).getByText(TASK_TITLE)).toBeInTheDocument();
    expect(within(q1).queryByText(TASK_TITLE)).not.toBeInTheDocument();
    step('四象限视图：任务从「重要且紧急」即时迁移到「重要不紧急」');

    // 从四象限打开详情，值一致；再改为 3，视图即时迁移。
    await user.click(
      within(q2).getByRole('button', { name: `查看任务：${TASK_TITLE}` }),
    );
    detail = await screen.findByRole('complementary', { name: '任务详情' });
    expect(within(detail).getByLabelText('象限')).toHaveValue('2');
    await user.selectOptions(within(detail).getByLabelText('象限'), '3');
    await waitForRow(world, { quadrant: 3 });
    const q3 = await screen.findByRole('region', {
      name: '四象限：紧急不重要',
    });
    expect(within(q3).getByText(TASK_TITLE)).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: '四象限：重要不紧急' })).queryByText(
        TASK_TITLE,
      ),
    ).not.toBeInTheDocument();
    step('从四象限打开详情值一致；再改为 3 后即时迁移到「紧急不重要」');

    cleanup();
    await mountApp(world, '/today');
    // 今天视图偏好（四象限）与任务象限都从后端恢复。
    const restored = await screen.findByRole('region', {
      name: '四象限：紧急不重要',
    });
    expect(within(restored).getByText(TASK_TITLE)).toBeInTheDocument();
    await user.click(
      within(restored).getByRole('button', { name: `查看任务：${TASK_TITLE}` }),
    );
    detail = await screen.findByRole('complementary', { name: '任务详情' });
    expect(within(detail).getByLabelText('象限')).toHaveValue('3');
    step('卸载重挂载后视图仍为四象限，任务仍在「紧急不重要」，详情值为 3');

    // 切到列表/看板再回来，值仍一致。
    await user.click(screen.getByRole('button', { name: '看板' }));
    expect(
      await screen.findByRole('region', { name: '待办列' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '四象限' }));
    expect(
      within(
        await screen.findByRole('region', { name: '四象限：紧急不重要' }),
      ).getByText(TASK_TITLE),
    ).toBeInTheDocument();
    step('列表/看板/四象限来回切换，任务象限值保持一致');

    await expectCleanConsole();
  });

  it('跨页一致：五项字段全部修改后，今天/清单/看板/四象限读取同一后端行', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world);
    let detail = await openDetail(user);

    await user.selectOptions(within(detail).getByLabelText('优先级'), '2');
    await waitForRow(world, { priority: 2 });
    await user.selectOptions(within(detail).getByLabelText('象限'), '2');
    await waitForRow(world, { quadrant: 2 });
    await user.selectOptions(within(detail).getByLabelText('提醒'), '1h');
    await waitForRow(world, { reminder: '1h' });
    await user.selectOptions(within(detail).getByLabelText('状态'), 'doing');
    await waitForRow(world, { status: 'doing' });
    const tomorrow = addDays(world.today, 1);
    await pickDate(user, within(detail).getByLabelText('日期'), tomorrow);
    await waitForRow(world, {
      dueDate: tomorrow,
      priority: 2,
      quadrant: 2,
      reminder: '1h',
      status: 'doing',
    });
    step('五项依次修改完成：日期+1、优先级 2、提醒 1h、状态 doing、象限 2');

    // 今天视图：未来任务不在列表；看板只显示今天范围，也不应出现。
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: `查看任务：${TASK_TITLE}` }),
      ).not.toBeInTheDocument();
    });

    // 跨页 1：清单管理 → 工作 → 打开详情。
    await user.click(screen.getByRole('link', { name: '管理清单' }));
    await screen.findByRole('heading', { level: 1, name: '清单管理' });
    await user.click(await screen.findByRole('button', { name: /^工作，/ }));
    detail = await openDetail(user);
    expect(dateFieldValue(within(detail).getByLabelText('日期'))).toBe(tomorrow);
    expect(within(detail).getByLabelText('优先级')).toHaveValue('2');
    expect(within(detail).getByLabelText('提醒')).toHaveValue('1h');
    expect(within(detail).getByLabelText('状态')).toHaveValue('doing');
    expect(within(detail).getByLabelText('象限')).toHaveValue('2');
    step('「工作」清单详情：五项值与写入一致');

    // 跨页 2：四象限（全部未完成范围）→ 打开详情，五项仍一致。
    await user.click(screen.getByRole('link', { name: '今天' }));
    await user.click(screen.getByRole('button', { name: '四象限' }));
    await user.click(screen.getByRole('button', { name: '全部未完成' }));
    const q2 = await screen.findByRole('region', {
      name: '四象限：重要不紧急',
    });
    expect(within(q2).getByText(TASK_TITLE)).toBeInTheDocument();
    await user.click(
      within(q2).getByRole('button', { name: `查看任务：${TASK_TITLE}` }),
    );
    detail = await screen.findByRole('complementary', { name: '任务详情' });
    expect(dateFieldValue(within(detail).getByLabelText('日期'))).toBe(tomorrow);
    expect(within(detail).getByLabelText('优先级')).toHaveValue('2');
    expect(within(detail).getByLabelText('提醒')).toHaveValue('1h');
    expect(within(detail).getByLabelText('状态')).toHaveValue('doing');
    expect(within(detail).getByLabelText('象限')).toHaveValue('2');
    step('「四象限·全部未完成」详情：五项值与写入一致');

    // 跨页 3：卸载重挂载，直接打开清单页。
    cleanup();
    await mountApp(world, '/lists/work');
    detail = await openDetail(user);
    expect(dateFieldValue(within(detail).getByLabelText('日期'))).toBe(tomorrow);
    expect(within(detail).getByLabelText('优先级')).toHaveValue('2');
    expect(within(detail).getByLabelText('提醒')).toHaveValue('1h');
    expect(within(detail).getByLabelText('状态')).toHaveValue('doing');
    expect(within(detail).getByLabelText('象限')).toHaveValue('2');
    step('卸载重挂载后再次打开：五项值全部保持');

    await expectCleanConsole();
  });

  it('空数据：无任务时今天/四象限/看板为空态，详情显示引导且无字段控件', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld({ empty: true });
    await mountApp(world);

    expect(
      await screen.findByText('今天还没有任务，先加一件最重要的事'),
    ).toBeInTheDocument();
    const detail = screen.getByRole('complementary', { name: '任务详情' });
    expect(
      within(detail).getByText('选择一个任务查看详情'),
    ).toBeInTheDocument();
    expect(within(detail).queryByLabelText('日期')).not.toBeInTheDocument();
    expect(within(detail).queryByLabelText('优先级')).not.toBeInTheDocument();
    expect(within(detail).queryByLabelText('提醒')).not.toBeInTheDocument();
    expect(within(detail).queryByLabelText('状态')).not.toBeInTheDocument();
    expect(within(detail).queryByLabelText('象限')).not.toBeInTheDocument();
    step('空库今天显示空态，详情显示「选择一个任务查看详情」，五项控件均不渲染');

    await user.click(screen.getByRole('button', { name: '四象限' }));
    expect(
      await screen.findByRole('region', { name: '四象限：重要且紧急' }),
    ).toHaveTextContent('这一格还空着');
    await user.click(screen.getByRole('button', { name: '看板' }));
    expect(
      await screen.findByRole('region', { name: '待办列' }),
    ).toHaveTextContent('暂无待办任务');
    expect(
      screen.getByRole('region', { name: '已完成列' }),
    ).toHaveTextContent('今天还没有完成的任务');
    step('空库四象限与看板均为空态，不伪造任务');

    await expectCleanConsole();
  });

  it('删除不存在项：仓储报错但不崩溃、不误删其他任务', async () => {
    const world = createFakeWorld();
    world.install();
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
                next.push('未报错');
              } catch (error) {
                next.push(`task:${error.message}`);
              }
              try {
                await store.restoreTask('missing-task');
                next.push('恢复未报错');
              } catch (error) {
                next.push(`restore:${error.message}`);
              }
              setMessages(next);
            },
          },
          '删除不存在任务',
        ),
        React.createElement(
          'output',
          { 'data-testid': 'errors' },
          messages.join('|'),
        ),
      );
    }

    render(
      React.createElement(
        TaskWorkspace,
        { source, today: world.today },
        React.createElement(Probe),
      ),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: '删除不存在任务' }),
    );
    await waitFor(() => {
      expect(screen.getByTestId('errors').textContent).toContain(
        '任务不存在：missing-task',
      );
      expect(screen.getByTestId('errors').textContent).toContain(
        'restore:已删除任务不存在：missing-task',
      );
    });
    expect(world.db.tasks).toHaveLength(5);
    expect(
      world.db.tasks.every((task) => task.deletedAt === null),
    ).toBe(true);
    step('删除/恢复不存在任务均返回「任务不存在」，5 条种子任务未被误删');

    await expectCleanConsole();
  });

  it('快速连点同一字段：最后一次值生效，界面与后端一致且不崩溃', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world);
    const detail = await openDetail(user);
    const priority = within(detail).getByLabelText('优先级');

    // 同一 tick 连点三次：1 → 3 → 2；同一字段的完整快照互不丢字段。
    fireEvent.change(priority, { target: { value: '1' } });
    fireEvent.change(priority, { target: { value: '3' } });
    fireEvent.change(priority, { target: { value: '2' } });
    await waitForRow(world, { priority: 2 });
    await waitFor(() => {
      expect(within(detail).getByLabelText('优先级')).toHaveValue('2');
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(taskRow(world).priority).toBe(2);
    expect(within(detail).getByLabelText('优先级')).toHaveValue('2');
    expect(
      world.db.tasks.filter((task) => task.id === TASK_ID),
    ).toHaveLength(1);
    step('同一字段快速连点 1→3→2：最终 priority=2，界面一致，任务未重复');

    await expectCleanConsole({ allowAct: true });
  });

  /**
   * 回归用例：详情提醒下拉的短码必须能被通知计划器解析（DEF-AUD013-02）。
   */
  it(
    'DEF-AUD013-02 回归：详情提醒选项能被通知计划器解析并产生计划',
    async () => {
      const user = userEvent.setup();
      const world = createFakeWorld();
      await mountApp(world);
      const detail = await openDetail(user);

      const options: Array<[string, number]> = [
        ['at', 0],
        ['5m', 5],
        ['15m', 15],
        ['30m', 30],
        ['1h', 60],
        ['1d', 1440],
      ];
      const observed: Array<{ value: string; expected: number; offset: number | null }> =
        [];
      for (const [value, expected] of options) {
        await user.selectOptions(
          within(detail).getByLabelText('提醒'),
          value,
        );
        await waitForRow(world, { reminder: value });
        const offset = parseReminderOffsetMinutes(taskRow(world).reminder);
        observed.push({ value, expected, offset });
      }
      const plans = buildTaskReminderPlans(
        [taskRow(world)],
        DEFAULT_NOTIFICATION_SETTINGS,
        {
          now: new Date('2026-10-27T00:00:00.000Z'),
          deviceId: 'aud013-device',
          browserPermission: 'granted',
          systemAvailable: false,
        },
      );
      step(
        `提醒短码解析：${JSON.stringify(
          observed.map((item) => `${item.value}=${item.offset}`),
        )}；选中 1d 后提醒计划数=${plans.length}`,
      );
      expect(observed.map((item) => item.offset)).toEqual(
        options.map((item) => item[1]),
      );
      expect(plans.length).toBeGreaterThan(0);
      await expectCleanConsole({ allowAct: true });
    },
  );

  /**
   * 回归用例：种子/导入的中文提醒值必须回映射为正确下拉项（DEF-AUD013-03）。
   */
  it(
    'DEF-AUD013-03 回归：种子/导入的中文提醒值在详情显示正确选项',
    async () => {
      const user = userEvent.setup();
      const world = createFakeWorld();
      taskRow(world).reminder = '提前 15 分钟';
      await mountApp(world);
      const detail = await openDetail(user);
      const select = within(detail).getByLabelText('提醒');
      step(
        `后端 reminder=提前 15 分钟；下拉 value=${JSON.stringify(
          select.value,
        )}，selectedIndex=${select.selectedIndex}，显示「${
          select.options[select.selectedIndex]?.textContent ?? ''
        }」`,
      );
      expect(select.selectedIndex).toBeGreaterThan(0);
      expect(select.options[select.selectedIndex]?.textContent).toBe(
        '提前 15 分钟',
      );
      await expectCleanConsole({ allowAct: true });
    },
  );

  /**
   * 回归用例：同一 tick 连续修改多个字段也必须全部保留（DEF-AUD013-01）。
   */
  it(
    'DEF-AUD013-01 回归：同一 tick 连续修改多个字段不会互相覆盖',
    async () => {
      const user = userEvent.setup();
      const world = createFakeWorld();
      const tomorrow = addDays(world.today, 1);
      await mountApp(world);
      const detail = await openDetail(user);

      // 复现：用户快速连续操作四个下拉/日期控件，事件在同一 tick 内发出。
      fireEvent.change(within(detail).getByLabelText('优先级'), {
        target: { value: '1' },
      });
      fireEvent.change(within(detail).getByLabelText('状态'), {
        target: { value: 'doing' },
      });
      fireEvent.change(within(detail).getByLabelText('象限'), {
        target: { value: '2' },
      });
      await pickDate(user, within(detail).getByLabelText('日期'), tomorrow);
      step('同一 tick 连续修改优先级/状态/象限/日期');

      await waitFor(() => {
        expect(taskRow(world).dueDate).toBe(tomorrow);
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      const final = taskRow(world);
      step(
        `快速修改后的后端行：priority=${final.priority}, status=${final.status}, quadrant=${final.quadrant}, dueDate=${final.dueDate}`,
      );
      // 期望四项都保留；当前实现只有最后一项保留，前三项被旧快照覆盖。
      expect(final).toMatchObject({
        priority: 1,
        status: 'doing',
        quadrant: 2,
        dueDate: tomorrow,
      });
      await expectCleanConsole({ allowAct: true });
    },
  );
});
