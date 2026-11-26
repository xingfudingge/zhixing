// @ts-nocheck
/**
 * AUD-012 独立验收 · AUD-003 / AUD-020 回归。
 *
 * AUD-003：知识页正文待办与文末汇总共用 note_todos；勾选不镜像任务，
 *          删除可撤销，绑定任务状态独立读取。
 * AUD-020：桌面导出必须调用 save_export_file（Rust 写 app_data_dir/exports），
 *          浏览器才降级为 <a download>；Rust 落点不再使用 Downloads。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as React from '../app/node_modules/react/index.js';
import {
  act,
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
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
});

async function mountApp(world, pathname) {
  world.install();
  window.history.replaceState({}, '', pathname);
  const { default: App } = await import('../app/src/App');
  const view = render(React.createElement(App));
  // App 已去掉授权门禁；等首轮 data-load effect 落定，避免测试与初始状态竞态。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return view;
}

describe('AUD-003 · 笔记待办（note_todos）', () => {
  it('正文/汇总同源、勾选不镜像任务、删除可撤销、关联状态独立', async () => {
    const world = createFakeWorld();
    world.db.todos.push({
      id: 'todo-aud012',
      spaceId: 'personal',
      noteId: 'note-welcome',
      taskId: 'task-acceptance',
      title: '写验收清单',
      done: false,
      dueDate: null,
      reminderEnabled: false,
      sortOrder: 1024,
      createdAt: '2026-10-27T00:00:00.000Z',
      updatedAt: '2026-10-27T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    });

    const user = userEvent.setup();
    await mountApp(world, '/knowledge');
    await user.click(
      await screen.findByRole('button', { name: '打开笔记：欢迎使用知行' }),
    );

    const summary = await screen.findByRole('region', { name: '本篇待办' });
    expect(within(summary).getByText('0/1 已完成')).toBeInTheDocument();
    expect(
      within(summary).getByRole('button', {
        name: '已关联任务：完成验收报告（待办）',
      }),
    ).toBeInTheDocument();

    await user.click(
      within(summary).getByRole('checkbox', { name: '标记完成：写验收清单' }),
    );
    await waitFor(() => {
      expect(world.db.todos.find((row) => row.id === 'todo-aud012')?.done).toBe(
        true,
      );
    });
    expect(within(summary).getByText('1/1 已完成')).toBeInTheDocument();
    // 勾选笔记待办不镜像全局任务状态。
    expect(
      world.db.tasks.find((row) => row.id === 'task-acceptance')?.status,
    ).toBe('todo');
    expect(
      world.db.tasks.find((row) => row.id === 'task-acceptance')?.completedAt,
    ).toBeNull();

    // 删除 → 撤销窗口 → 恢复同一条待办与关联。
    await user.click(
      within(summary).getByRole('button', { name: '删除待办：写验收清单' }),
    );
    await waitFor(() => {
      expect(
        world.db.todos.find((row) => row.id === 'todo-aud012')?.deletedAt,
      ).not.toBeNull();
    });
    await user.click(await screen.findByRole('button', { name: '撤销' }));
    await waitFor(() => {
      // 产品语义：撤销以“新 id 重建同内容对象”，旧行作为墓碑保留。
      const active = world.db.todos.filter(
        (row) => row.deletedAt === null && row.title === '写验收清单',
      );
      expect(active).toHaveLength(1);
      expect(active[0].taskId).toBe('task-acceptance');
    });
    expect(
      within(await screen.findByRole('region', { name: '本篇待办' })).getByText(
        '写验收清单',
      ),
    ).toBeInTheDocument();
    expect(consoleErrors).toEqual([]);
    expect(consoleWarns).toEqual([]);
  });
});

describe('AUD-020 · 导出落点', () => {
  it('Tauri 桌面调用 save_export_file，不触发浏览器下载；浏览器才降级', async () => {
    const world = createFakeWorld();
    world.install();
    URL.createObjectURL = vi.fn(() => 'blob:aud012-export');
    URL.revokeObjectURL = vi.fn();
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const { browserDownloader } = await import(
      '../app/src/features/export/download'
    );

    const blob = new Blob(['验收导出内容'], { type: 'application/zip' });
    const ok = await browserDownloader({
      fileName: '验收导出.zip',
      blob,
    });
    expect(ok).toBe(true);
    expect(world.exportsWritten).toHaveLength(1);
    expect(world.exportsWritten[0].fileName).toBe('验收导出.zip');
    expect(world.exportsWritten[0].bytes.length).toBeGreaterThan(0);
    expect(world.exportsWritten[0].path).toContain('/exports/验收导出.zip');
    expect(anchorClick).not.toHaveBeenCalled();

    // 无 Tauri IPC = 浏览器预览：允许 Blob 下载降级。
    delete window.__TAURI_INTERNALS__;
    const fallbackOk = await browserDownloader({
      fileName: '浏览器降级.zip',
      blob,
    });
    expect(fallbackOk).toBe(true);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(world.exportsWritten).toHaveLength(1);
  });

  it('Rust save_export_file 落点为 app_data_dir/exports，不使用 Downloads', () => {
    let repoRoot = process.cwd();
    for (let index = 0; index < 6; index += 1) {
      if (fs.existsSync(path.join(repoRoot, 'app/src-tauri/src/lib.rs'))) {
        break;
      }
      repoRoot = path.dirname(repoRoot);
    }
    const source = fs.readFileSync(
      path.join(repoRoot, 'app/src-tauri/src/lib.rs'),
      'utf8',
    );
    expect(source).toContain('.join("exports")');
    // 注释可提到 Downloads（说明为何不写那里），但代码不得调用 download_dir。
    expect(source).not.toMatch(/\.download_dir\(/);
    expect(source).toContain('fn save_export_file');
  });
});
