// @ts-nocheck
/**
 * AUD-012 独立验收 · P2 ICS 外部日历。
 *
 * 使用真实 HTTP 服务器（Node http）提供 ICS，走真实 App 路由
 * /settings/calendar 与产品默认 IcsSyncService / parser / 事件仓储：
 *   - 首次拉取 200：解析并以只读事件写入 SQLite（fakeTauri）；
 *   - 再次同步携带 If-None-Match，304 不重复物化；
 *   - 500 明确显示错误，订阅保留 lastError；
 *   - 日历页显示“外部日历 · 只读”，点击不打开编辑弹层；
 *   - 删除订阅不删除已导入的本地事件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
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

async function mountApp(world, path) {
  world.install();
  window.history.replaceState({}, '', path);
  const { default: App } = await import('../app/src/App');
  return render(React.createElement(App));
}

function icsFor(dateCompact) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Zhixing Acceptance//AUD-012//CN',
    'X-WR-CALNAME:验收外部日历',
    'BEGIN:VEVENT',
    'UID:aud012-external-1',
    `DTSTART;VALUE=DATE:${dateCompact}`,
    'SUMMARY:验收外部会议',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

describe('P2 ICS · 真实 URL 拉取/只读展示/刷新/错误', () => {
  it('200 导入、304 刷新、500 报错、删除订阅保留事件', async () => {
    const world = createFakeWorld();
    const day = world.today; // 2026-10-27
    const compact = day.replaceAll('-', '');
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({
        url: req.url,
        method: req.method,
        ifNoneMatch: req.headers['if-none-match'] ?? null,
      });
      if (req.url === '/ok.ics') {
        const etag = '"aud012-v1"';
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag });
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/calendar; charset=utf-8',
          ETag: etag,
        });
        res.end(icsFor(compact));
        return;
      }
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const user = userEvent.setup();
      await mountApp(world, '/settings/calendar');
      await screen.findByRole('heading', { level: 1, name: '设置' });
      const panel = await screen.findByRole('region', { name: '外部日历订阅' });

      await user.type(
        within(panel).getByPlaceholderText('例如：团队日历'),
        '验收外部日历',
      );
      await user.type(
        within(panel).getByPlaceholderText('https://example.com/calendar.ics'),
        `http://127.0.0.1:${port}/ok.ics`,
      );
      await user.click(within(panel).getByRole('button', { name: '添加订阅' }));

      expect(
        await screen.findByText(/同步完成：1 个事件实例，只读导入/),
      ).toBeInTheDocument();
      expect(requests[0]).toMatchObject({ method: 'GET', url: '/ok.ics' });
      const imported = world.db.events.find(
        (event) => event.externalUid === `aud012-external-1#${day}`,
      );
      expect(imported).toBeTruthy();
      expect(imported).toMatchObject({
        title: '验收外部会议',
        startDate: day,
        source: expect.stringMatching(/^ics:/),
      });
      expect(within(panel).getAllByText('只读').length).toBeGreaterThanOrEqual(2);
      expect(within(panel).queryByText(/写回 ICS/)).toBeNull();

      // 第二次同步：带 If-None-Match，服务端 304。
      await user.click(
        within(panel).getByRole('button', {
          name: '立即同步订阅 验收外部日历',
        }),
      );
      expect(
        await screen.findByText(/订阅未变化（服务端 304）/),
      ).toBeInTheDocument();
      expect(requests[1]).toMatchObject({
        method: 'GET',
        ifNoneMatch: '"aud012-v1"',
      });
      expect(
        world.db.events.filter((event) => event.externalUid?.startsWith('aud012-external-1')),
      ).toHaveLength(1);

      // 500 错误：订阅保留，lastError 展示，不伪造已同步。
      await user.type(
        within(panel).getByPlaceholderText('例如：团队日历'),
        '坏订阅',
      );
      await user.type(
        within(panel).getByPlaceholderText('https://example.com/calendar.ics'),
        `http://127.0.0.1:${port}/broken.ics`,
      );
      await user.click(within(panel).getByRole('button', { name: '添加订阅' }));
      const alerts = await within(panel).findAllByRole('alert');
      expect(
        alerts.some((node) => node.textContent?.includes('HTTP 500')),
      ).toBe(true);
      const brokenRow = within(panel)
        .getByText('坏订阅')
        .closest('[data-subscription-id]');
      expect(brokenRow).not.toBeNull();
      expect(within(brokenRow).getByText(/HTTP 500/)).toBeInTheDocument();

      // 删除订阅：二次确认；订阅消失，已导入的本地事件保留。
      await user.click(
        within(panel).getByRole('button', {
          name: '删除订阅 验收外部日历',
        }),
      );
      expect(
        within(panel).getByText(/只删除订阅和缓存，已导入的事件与任务保留/),
      ).toBeInTheDocument();
      await user.click(
        within(panel).getByRole('button', {
          name: '确认删除订阅 验收外部日历',
        }),
      );
      expect(
        await screen.findByText(/只删除了订阅和缓存，已导入的本地事件与任务保留/),
      ).toBeInTheDocument();
      expect(
        within(panel).queryByText('验收外部日历'),
      ).not.toBeInTheDocument();
      expect(
        world.db.events.some((event) =>
          event.externalUid?.startsWith('aud012-external-1'),
        ),
      ).toBe(true);

      // 日历页：外部事件只读，点击不打开编辑弹层。
      await user.click(screen.getByRole('link', { name: '日历', exact: true }));
      const cell = await screen.findByTestId(`day-${day}`);
      const chip = await within(cell).findByRole('button', {
        name: '事件：验收外部会议（只读）',
      });
      expect(chip).toHaveAttribute('data-readonly', 'true');
      await user.click(chip);
      expect(
        await screen.findByText(/外部日历事件为只读/),
      ).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByText('外部日历 · 只读')).toBeInTheDocument();

      // 重新打开设置页：订阅列表、失败状态仍在（浏览器预览用模块级兜底 store，
      // 桌面/浏览器有 IndexedDB 时由 IndexedDB 持久化）。
      await user.click(screen.getByRole('link', { name: '设置', exact: true }));
      await user.click(
        await screen.findByRole('link', { name: '日历与工作日' }),
      );
      const panelAgain = await screen.findByRole('region', {
        name: '外部日历订阅',
      });
      const brokenAgain = (await within(panelAgain).findByText('坏订阅')).closest(
        '[data-subscription-id]',
      );
      expect(brokenAgain).not.toBeNull();
      expect(within(brokenAgain).getByText(/HTTP 500/)).toBeInTheDocument();

      expect(consoleErrors).toEqual([]);
      expect(consoleWarns).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
