// @ts-nocheck
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
  return view;
}

describe('ZX-090 独立验收 · 真实 App 全链路（注入 IPC）', () => {
  it('今天：加载种子、完成/撤销、跨页面导航，控制台零报错', async () => {
    const user = userEvent.setup();
    const world = createFakeWorld();
    await mountApp(world, '/today');

    expect(
      await screen.findByRole('heading', { level: 1, name: '今天' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('完成验收报告')).toBeInTheDocument();
    expect(screen.getByText('交房租')).toBeInTheDocument();
    expect(screen.getByText('买咖啡豆')).toBeInTheDocument();
    expect(screen.getByText('逾期 1 天')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /今日完成 1\/\d+/ }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: '完成任务：完成验收报告' }),
    );
    await waitFor(() => {
      expect(
        world.db.tasks.find((task) => task.id === 'task-acceptance')?.status,
      ).toBe('done');
    });
    expect(
      await screen.findByRole('img', { name: /今日完成 2\/\d+/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => {
      expect(
        world.db.tasks.find((task) => task.id === 'task-acceptance')?.status,
      ).toBe('todo');
    });

    for (const [label, path, heading] of [
      ['任务', '/tasks', '全部任务'],
      ['日历', '/calendar', '日历'],
      ['习惯', '/habits', '习惯'],
      ['专注', '/focus', '专注'],
      ['复盘', '/review', '复盘'],
      ['管理清单', '/lists', '清单管理'],
      ['知识', '/knowledge', '知识'],
      ['设置', '/settings/appearance', '设置'],
    ]) {
      await user.click(screen.getByRole('link', { name: new RegExp(`^${label}`) }));
      expect(
        await screen.findByRole('heading', { level: 1, name: heading }),
      ).toBeInTheDocument();
      expect(window.location.pathname).toBe(
        label === '设置' ? '/settings/appearance' : path,
      );
    }

    expect(consoleErrors).toEqual([]);
    expect(consoleWarns).toEqual([]);
  });
});
