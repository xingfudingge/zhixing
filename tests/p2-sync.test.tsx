// @ts-nocheck
/**
 * AUD-012 独立验收 · P2 WebDAV / 后台同步。
 *
 * - 生产路由 /settings/sync 下，WebDAV 连接测试走真实 WebDavClient；网络失败
 *   必须显示错误且禁止保存，不写 localStorage；
 * - 后台配对走真实 SyncEngine / SyncHttpClient + 本地 HTTP 服务器；成功显示
 *   设备、清空配对码并持久化配置，失败显示服务端错误且不伪造“已配对”；
 * - 同步模式写入 localStorage，重挂载后保持；
 * - WebDAV 成功保存用注入 tester（不伪造真实网络结果），验证密码不落盘、
 *   配置可回填。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
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
import { MemoryRouter } from '../app/node_modules/react-router-dom/dist/index.mjs';

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
  vi.unstubAllGlobals();
});

async function mountApp(world, path) {
  world.install();
  window.history.replaceState({}, '', path);
  const { default: App } = await import('../app/src/App');
  const view = render(React.createElement(App));
  // App 不再有启动授权门禁；等首轮 data-load 的 effect 落定，避免测试在
  // 初始状态尚未回填时交互，导致 act 警告/竞态（不是产品行为差异）。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return view;
}

function pairResponse(port, name = '验收设备') {
  return {
    ok: true,
    deviceId: 'device-aud012',
    deviceName: name,
    deviceToken: 'token-aud012',
    refreshToken: 'refresh-aud012',
    accessExpiresAt: '2026-11-26T00:00:00.000Z',
    refreshExpiresAt: '2027-01-26T00:00:00.000Z',
    features: { sync: true, attachments: true },
    serverTime: '2026-10-27T00:00:00.000Z',
    apiVersion: '1',
    port,
  };
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function stopServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

describe('P2 同步 · WebDAV 真实探测失败', () => {
  it('网络失败显示原因、保存禁用、不落盘配置', async () => {
    // 真实 WebDavClient 的 HTTP 错误分支：401 非重试，立即返回认证失败。
    const fetchMock = vi.fn(async () =>
      new Response('unauthorized', { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const world = createFakeWorld();
    const user = userEvent.setup();
    await mountApp(world, '/settings/sync');
    await screen.findByRole('heading', { level: 1, name: '设置' });

    const webdav = await screen.findByRole('region', {
      name: 'WebDAV（OpenList / Alist）',
    });
    await user.type(
      within(webdav).getByLabelText('WebDAV 地址'),
      'https://dav.invalid/dav',
    );
    await user.click(within(webdav).getByRole('button', { name: '测试连接' }));

    expect(await screen.findByText('连接测试未通过')).toBeInTheDocument();
    expect(
      within(webdav).getAllByText(/WebDAV 认证失败/).length,
    ).toBeGreaterThan(0);
    expect(
      within(webdav).getByRole('button', { name: '保存连接信息' }),
    ).toBeDisabled();
    expect(window.localStorage.getItem('zhixing.webdav.config.v1')).toBeNull();
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toContain('https://dav.invalid/dav');
    expect(consoleErrors).toEqual([]);
  });
});

describe('P2 同步 · 后台配对与模式持久化', () => {
  it('真实 HTTP 配对成功：显示设备、清空配对码、保存配置、切换模式并重挂载保持', async () => {
    const calls = [];
    const { server, port } = await startServer((req, res) => {
      calls.push({ url: req.url, method: req.method });
      if (req.url === '/api/v1/devices/pair' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(pairResponse(port)));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '没有这个接口' } }));
    });

    try {
      const world = createFakeWorld();
      const user = userEvent.setup();
      const view = await mountApp(world, '/settings/sync');
      await screen.findByRole('heading', { level: 1, name: '设置' });

      const backend = await screen.findByRole('region', {
        name: '后台直连（知行服务端）',
      });
      await user.type(
        within(backend).getByLabelText('后台地址'),
        `http://127.0.0.1:${port}`,
      );
      await user.type(within(backend).getByLabelText('配对码'), 'PAIR-1234');
      await user.clear(within(backend).getByLabelText('设备名称'));
      await user.type(within(backend).getByLabelText('设备名称'), '验收设备');
      await user.click(within(backend).getByRole('button', { name: '配对设备' }));

      expect(await within(backend).findByText('已配对')).toBeInTheDocument();
      expect(within(backend).getByText('验收设备')).toBeInTheDocument();
      expect(within(backend).getByLabelText('配对码')).toHaveValue('');
      expect(calls[0]).toMatchObject({
        url: '/api/v1/devices/pair',
        method: 'POST',
      });
      const savedConfig = JSON.parse(
        window.localStorage.getItem('zhixing.backend.config.v1'),
      );
      expect(savedConfig).toMatchObject({
        baseUrl: `http://127.0.0.1:${port}`,
        deviceName: '验收设备',
      });

      // 切到后台直连：profile ready → 直接切换并写模式。
      await user.click(
        screen.getByRole('button', { name: '同步模式：后台直连' }),
      );
      expect(
        await screen.findByText(/已切换到后台直连模式/),
      ).toBeInTheDocument();
      expect(window.localStorage.getItem('zhixing.sync.mode.v1')).toBe(
        'backend',
      );

      // 重挂载：模式与配对状态从本机存储恢复。
      view.unmount();
      const remounted = await mountApp(world, '/settings/sync');
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: '同步模式：后台直连' }),
        ).toHaveAttribute('aria-pressed', 'true');
      });
      const backendAgain = await screen.findByRole('region', {
        name: '后台直连（知行服务端）',
      });
      expect(within(backendAgain).getByText('已配对')).toBeInTheDocument();
      expect(within(backendAgain).getByText('验收设备')).toBeInTheDocument();
      expect(consoleErrors).toEqual([]);
      remounted.unmount();
    } finally {
      await stopServer(server);
    }
  });

  it('配对失败显示服务端错误，保持未配对且不写配置', async () => {
    const { server, port } = await startServer((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'PAIR_CODE_INVALID', message: '配对码无效或已过期' },
        }),
      );
    });
    try {
      const world = createFakeWorld();
      const user = userEvent.setup();
      await mountApp(world, '/settings/sync');
      await screen.findByRole('heading', { level: 1, name: '设置' });
      const backend = await screen.findByRole('region', {
        name: '后台直连（知行服务端）',
      });
      await user.type(
        within(backend).getByLabelText('后台地址'),
        `http://127.0.0.1:${port}`,
      );
      await user.type(within(backend).getByLabelText('配对码'), 'BAD');
      await user.click(within(backend).getByRole('button', { name: '配对设备' }));

      expect(await within(backend).findByRole('alert')).toHaveTextContent(
        '配对码无效或已过期',
      );
      expect(within(backend).getByText('未配对')).toBeInTheDocument();
      // 失败只允许保存“地址/设备名”，绝不能保存配对 profile/token。
      expect(
        JSON.parse(
          window.localStorage.getItem('zhixing.sync.v1') ?? '{}',
        ).profile ?? null,
      ).toBeNull();
      expect(consoleErrors).toEqual([]);
    } finally {
      await stopServer(server);
    }
  });
});

describe('P2 同步 · WebDAV 配置保存与回填（注入 tester）', () => {
  it('测试通过后才能保存；密码不落盘；重挂载回填地址与根目录', async () => {
    const { SyncGroup } = await import(
      '../app/src/features/settings/groups/SyncGroup'
    );
    const { MemoryWebDavConfigStore } = await import(
      '../app/src/sync/webdav/configStore'
    );
    const { MemoryWebDavModeStore } = await import(
      '../app/src/sync/webdav/modeController'
    );
    const configStore = new MemoryWebDavConfigStore();
    const modeStore = new MemoryWebDavModeStore('local');
    const tester = vi.fn(async (values) => ({
      ok: true,
      baseUrl: values.baseUrl,
      root: values.root,
      checks: [
        { id: 'propfind', label: 'PROPFIND 根目录', status: 'ok' },
      ],
      error: null,
      testedAt: '2026-10-27T10:00:00.000Z',
    }));
    const renderGroup = () =>
      render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/settings/sync'] },
          React.createElement(SyncGroup, {
            sourceMode: 'sqlite',
            platform: 'darwin',
            modeStore,
            webdavConfigStore: configStore,
            webdavTester: tester,
          }),
        ),
      );

    const user = userEvent.setup();
    const view = renderGroup();
    const webdav = await screen.findByRole('region', {
      name: 'WebDAV（OpenList / Alist）',
    });
    const save = within(webdav).getByRole('button', { name: '保存连接信息' });
    expect(save).toBeDisabled();
    await user.type(
      within(webdav).getByLabelText('WebDAV 地址'),
      'https://dav.example.com/dav',
    );
    await user.type(within(webdav).getByLabelText('WebDAV 用户名'), 'alice');
    await user.type(within(webdav).getByLabelText('WebDAV 应用密码'), 'secret-123');
    await user.click(within(webdav).getByRole('button', { name: '测试连接' }));
    expect(await within(webdav).findByText('PROPFIND 根目录')).toBeInTheDocument();
    expect(save).toBeEnabled();
    await user.click(save);

    expect(
      await screen.findByText(/连接信息已保存；应用密码不落盘/),
    ).toBeInTheDocument();
    const saved = await configStore.load();
    expect(saved).toMatchObject({
      baseUrl: 'https://dav.example.com/dav',
      username: 'alice',
      passwordSaved: false,
    });
    expect(JSON.stringify(saved)).not.toContain('secret-123');

    view.unmount();
    renderGroup();
    const webdavAgain = await screen.findByRole('region', {
      name: 'WebDAV（OpenList / Alist）',
    });
    expect(within(webdavAgain).getByLabelText('WebDAV 地址')).toHaveValue(
      'https://dav.example.com/dav',
    );
    expect(within(webdavAgain).getByLabelText('WebDAV 用户名')).toHaveValue(
      'alice',
    );
    expect(
      within(webdavAgain).getByLabelText('WebDAV 应用密码'),
    ).toHaveValue('');
    expect(consoleErrors).toEqual([]);
  });
});
