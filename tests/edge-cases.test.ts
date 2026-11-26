// @ts-nocheck
/**
 * ZX-090 独立验收 · 边界与空数据。
 * 覆盖：全空库、控制台零报错、专注无任务拒绝/手动补记、设置业务数据重置缺口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from '../app/node_modules/react/index.js';
import {
  cleanup,
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
  return render(React.createElement(App));
}

describe('空数据与空态', () => {
  it('全空库下所有模块可打开，显示空态且零控制台报错', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld({ empty: true });
    await mountApp(world, '/today');

    expect(
      await screen.findByText('今天还没有任务，先加一件最重要的事'),
    ).toBeInTheDocument();

    const routes = [
      ['任务', '全部任务', '还没有任务'],
      ['日历', '日历', null],
      ['习惯', '习惯', '还没有习惯'],
      ['专注', '专注', '还没有专注记录'],
      ['复盘', '复盘', '这段时间还没有完成任务'],
      ['管理清单', '清单管理', '还没有清单'],
      ['知识', '知识', '还没有笔记'],
      ['设置', '设置', null],
    ];
    for (const [label, heading, text] of routes) {
      await user.click(screen.getByRole('link', { name: new RegExp(`^${label}`) }));
      expect(
        await screen.findByRole('heading', { level: 1, name: heading }),
      ).toBeInTheDocument();
      if (text) {
        expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
      }
    }

    // 复盘空数据不能出现 NaN/Infinity。
    await user.click(screen.getByRole('link', { name: '复盘' }));
    await screen.findByRole('article', { name: '完成任务' });
    expect(document.body.textContent).not.toContain('NaN');
    expect(document.body.textContent).not.toContain('Infinity');

    expect(consoleErrors).toEqual([]);
    expect(consoleWarns).toEqual([]);
  });
});

describe('专注边界', () => {
  it('未选任务完成/补记均被拒绝且不写记录；选任务后补记 30 分钟入账', async () => {
    const world = createFakeWorld();
    world.install();
    const { createDbClient } = await import('../app/src/data/db/client');
    const { createFocusSource, FocusRuntime } = await import(
      '../app/src/features/focus/FocusRuntime'
    );
    const { FocusPage } = await import('../app/src/features/focus/FocusPage');
    const { NO_TASK_MESSAGE } = await import(
      '../app/src/data/repositories/focus'
    );

    const client = createDbClient(world.invoke);
    const runtime = new FocusRuntime({
      source: createFocusSource(client),
      available: true,
      today: world.today,
      tickMs: 60 * 60 * 1000,
      now: () => Date.now(),
    });
    const user = userEvent.setup();
    render(React.createElement(FocusPage, { runtime }));

    await screen.findByRole('heading', { level: 1, name: '专注' });
    await screen.findByRole('option', { name: '完成验收报告' });
    expect(world.db.sessions).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '完成并记录' }));
    expect(await screen.findByTestId('focus-toast')).toHaveTextContent(
      NO_TASK_MESSAGE,
    );
    expect(world.db.sessions).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '手动补记' }));
    expect(await screen.findByTestId('focus-toast')).toHaveTextContent(
      NO_TASK_MESSAGE,
    );
    expect(world.db.sessions).toHaveLength(1);

    await user.selectOptions(
      screen.getByLabelText('关联任务'),
      'task-acceptance',
    );
    await user.clear(screen.getByLabelText('补记分钟'));
    await user.type(screen.getByLabelText('补记分钟'), '30');
    await user.click(screen.getByRole('button', { name: '手动补记' }));

    await waitFor(() => {
      expect(world.db.sessions).toHaveLength(2);
    });
    const manual = world.db.sessions.find((session) => session.mode === 'manual');
    expect(manual).toMatchObject({ taskId: 'task-acceptance', minutes: 30 });
    expect(await screen.findByTestId('focus-toast')).toHaveTextContent(
      '已补记 30 分钟专注',
    );
    expect(consoleErrors).toEqual([]);
    runtime.dispose();
  });
});

describe('设置 · 数据与备份', () => {
  it('偏好重置可用；业务数据重置需确认，清空后回到种子并保留偏好', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/settings/data');
    await screen.findByRole('heading', { level: 1, name: '设置' });

    // 偏好重置是已实现能力。
    await user.click(screen.getByRole('button', { name: '重置本机偏好' }));
    await user.click(await screen.findByRole('button', { name: '确认重置' }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('已保存到本机');
    });

    // 造一条用户业务数据与一条设备偏好，验证“业务清空、偏好保留”。
    const customTask = await world.invoke('tasks_create', {
      input: { title: '重置前的用户任务', listId: 'work' },
    });
    await world.invoke('settings_set', {
      input: { scope: 'device', key: 'test.keep', value: 'yes' },
    });
    expect(world.db.tasks.some((task) => task.id === customTask.id)).toBe(true);

    await user.click(screen.getByRole('button', { name: '重置全部数据' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/重置前请先导出完整备份/),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole('checkbox', { name: /重置不可撤销/ }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: '确认重置业务数据' }),
    );

    await waitFor(() => {
      expect(within(dialog).getByText('业务数据已重置')).toBeInTheDocument();
    });
    expect(
      world.calls.some((call) => call.command === 'db_reset_domain'),
    ).toBe(true);

    // 业务数据回到种子，用户任务消失；设备偏好保留。
    expect(world.db.tasks.some((task) => task.id === customTask.id)).toBe(false);
    expect(
      world.db.tasks.some((task) => task.id === 'task-acceptance'),
    ).toBe(true);
    expect(
      world.db.settings.some(
        (row) => row.scope === 'device' && row.key === 'test.keep',
      ),
    ).toBe(true);
    expect(screen.queryByText('未实现')).not.toBeInTheDocument();
    expect(consoleErrors).toEqual([]);
  });
});
