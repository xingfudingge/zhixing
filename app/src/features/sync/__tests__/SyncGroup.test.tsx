import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { WebDavError } from '../../../../../packages/sync-webdav/src/index.ts';
import {
  defaultWebDavConfig,
  MemoryWebDavConfigStore,
} from '../../../sync/webdav/configStore.ts';
import { MemoryWebDavModeStore } from '../../../sync/webdav/modeController.ts';
import type { WebDavConnectionTester } from '../../../sync/webdav/WebDavSettingsPanel.tsx';
import { MemoryBackendConfigStore } from '../../backend/store.ts';
import { SyncGroup } from '../../settings/groups/SyncGroup.tsx';
import type { SyncRuntime } from '../types.ts';
import type { SyncStatus } from '../types.ts';
import { createSyncRuntime } from '../runtime.ts';
import { MemorySyncStore } from '../../../sync/store.ts';
import type { FetchLike } from '../../../sync/client.ts';

const successResult = {
  ok: true,
  baseUrl: 'http://127.0.0.1:5244/dav',
  root: '/zhixing',
  checks: [
    { id: 'propfind' as const, label: 'PROPFIND 根目录', status: 'ok' as const },
    { id: 'mkcol' as const, label: '递归创建目录', status: 'ok' as const },
  ],
  error: null,
  testedAt: '2026-10-26T12:00:00.000Z',
};

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    mode: 'local',
    pendingUploads: 0,
    pendingConflicts: 0,
    lastSyncAt: null,
    lastError: null,
    issues: [],
    backendProfile: null,
    webdavConfigured: false,
    webdavBaseUrl: null,
    ...overrides,
  };
}

function fakeRuntime(
  initial: SyncStatus,
  overrides: Partial<SyncRuntime> = {},
): SyncRuntime {
  let current = initial;
  return {
    platform: 'macos',
    readStatus: vi.fn(async (mode) => ({ ...current, mode })),
    syncNow: vi.fn(async (mode) => {
      const next = { ...current, mode };
      return {
        kind: 'skipped' as const,
        message: '测试同步入口',
        pushed: 0,
        pulled: 0,
        pendingUploads: next.pendingUploads,
        status: next,
      };
    }),
    pairBackend: vi.fn(async (input) => {
      const profile = {
        baseUrl: input.baseUrl,
        deviceId: 'dev_test_1',
        deviceName: input.deviceName,
        lastSyncAt: null,
        lastError: null,
      };
      current = { ...current, backendProfile: profile };
      return profile;
    }),
    ...overrides,
  };
}

function webdavConfig(baseUrl = 'http://127.0.0.1:5244/dav') {
  return new MemoryWebDavConfigStore({
    ...defaultWebDavConfig(),
    baseUrl,
    username: 'alice',
    deviceId: 'device-a',
  });
}

function renderSyncGroup(
  props: Partial<Parameters<typeof SyncGroup>[0]> = {},
) {
  return render(
    <MemoryRouter>
      <SyncGroup sourceMode="sqlite" platform="macos" {...props} />
    </MemoryRouter>,
  );
}

describe('同步与网络设置', () => {
  it('桌面端三模式可切换，WebDAV 选择重载后保持', async () => {
    const user = userEvent.setup();
    const modeStore = new MemoryWebDavModeStore('local');
    const runtime = fakeRuntime(
      status({ webdavConfigured: true, webdavBaseUrl: 'https://dav.example.com' }),
    );
    const { unmount } = renderSyncGroup({
      modeStore,
      runtime,
      webdavConfigStore: webdavConfig(),
      backendConfigStore: new MemoryBackendConfigStore(),
    });

    expect(
      screen.getByRole('button', { name: '同步模式：仅本机' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '同步模式：后台直连' }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: '同步模式：WebDAV' }),
    );

    await waitFor(async () => {
      expect(await modeStore.load()).toBe('webdav');
    });
    expect(
      screen.getByRole('button', { name: '同步模式：WebDAV' }),
    ).toHaveAttribute('aria-pressed', 'true');

    unmount();
    renderSyncGroup({
      modeStore,
      runtime: fakeRuntime(status({ webdavConfigured: true })),
      webdavConfigStore: webdavConfig(),
      backendConfigStore: new MemoryBackendConfigStore(),
    });

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '同步模式：WebDAV' }),
      ).toHaveAttribute('aria-pressed', 'true'),
    );
  });

  it('后台配对完成后可切换到后台直连', async () => {
    const user = userEvent.setup();
    const modeStore = new MemoryWebDavModeStore('local');
    const runtime = fakeRuntime(
      status({
        backendProfile: {
          baseUrl: 'https://sync.example.com',
          deviceId: 'dev_test_1',
          deviceName: '本机',
          lastSyncAt: null,
          lastError: null,
        },
      }),
    );
    renderSyncGroup({
      modeStore,
      runtime,
      webdavConfigStore: webdavConfig(),
      backendConfigStore: new MemoryBackendConfigStore(),
    });

    await user.click(
      screen.getByRole('button', { name: '同步模式：后台直连' }),
    );

    await waitFor(async () => {
      expect(await modeStore.load()).toBe('backend');
    });
    expect(
      screen.getByRole('button', { name: '同步模式：后台直连' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('WebDAV 测试连接展示真实成功结果', async () => {
    const user = userEvent.setup();
    const tester = vi
      .fn<WebDavConnectionTester>()
      .mockResolvedValue(successResult);
    renderSyncGroup({
      modeStore: new MemoryWebDavModeStore('local'),
      runtime: fakeRuntime(status()),
      webdavConfigStore: webdavConfig(),
      webdavTester: tester,
      backendConfigStore: new MemoryBackendConfigStore(),
    });

    await waitFor(() =>
      expect(screen.getByLabelText('WebDAV 地址')).toHaveValue(
        'http://127.0.0.1:5244/dav',
      ),
    );
    await user.click(screen.getByRole('button', { name: '测试连接' }));

    expect(await screen.findByText('连接可用')).toBeInTheDocument();
    expect(screen.getByText('PROPFIND 根目录')).toBeInTheDocument();
    expect(tester).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://127.0.0.1:5244/dav' }),
      'macos',
    );
  });

  it('WebDAV 测试连接失败展示可读错误', async () => {
    const user = userEvent.setup();
    const tester = vi
      .fn<WebDavConnectionTester>()
      .mockRejectedValue(
        new WebDavError('AUTH_FAILED', 'WebDAV 认证失败，请检查用户名与应用密码'),
      );
    renderSyncGroup({
      modeStore: new MemoryWebDavModeStore('local'),
      runtime: fakeRuntime(status()),
      webdavConfigStore: webdavConfig(),
      webdavTester: tester,
      backendConfigStore: new MemoryBackendConfigStore(),
    });

    await waitFor(() =>
      expect(screen.getByLabelText('WebDAV 地址')).toHaveValue(
        'http://127.0.0.1:5244/dav',
      ),
    );
    await user.click(screen.getByRole('button', { name: '测试连接' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('认证失败');
    expect(alert).toHaveTextContent('应用密码');
  });

  it('后台地址与配对码可填写，配对成功后显示配对状态', async () => {
    const user = userEvent.setup();
    const runtime = fakeRuntime(status());
    renderSyncGroup({
      modeStore: new MemoryWebDavModeStore('local'),
      runtime,
      webdavConfigStore: webdavConfig(),
      backendConfigStore: new MemoryBackendConfigStore(),
    });

    const baseUrl = screen.getByLabelText('后台地址');
    await user.type(baseUrl, 'https://sync.example.com');
    await user.type(screen.getByLabelText('配对码'), 'ABCD-1234');
    await user.click(screen.getByRole('button', { name: '配对设备' }));

    await waitFor(() =>
      expect(runtime.pairBackend).toHaveBeenCalledWith({
        baseUrl: 'https://sync.example.com',
        code: 'ABCD-1234',
        deviceName: '本机',
      }),
    );
    expect((await screen.findAllByText('已配对')).length).toBeGreaterThan(0);
    expect(screen.getByText('dev_test_1')).toBeInTheDocument();
    expect(
      (await screen.findAllByText(/配对成功/)).length,
    ).toBeGreaterThan(0);
  });

  it('存在未上传队列时切换模式必须先勾选确认', async () => {
    const user = userEvent.setup();
    const modeStore = new MemoryWebDavModeStore('webdav');
    const runtime = fakeRuntime(
      status({
        pendingUploads: 2,
        webdavConfigured: true,
        issues: [
          {
            id: 'op-1',
            entityType: 'note',
            message: '网络不可达',
            attempts: 1,
            nextAttemptAt: null,
          },
        ],
      }),
    );
    renderSyncGroup({
      modeStore,
      runtime,
      webdavConfigStore: webdavConfig(),
      backendConfigStore: new MemoryBackendConfigStore(),
    });

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '同步模式：WebDAV' }),
      ).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(await screen.findByText('2 条')).toBeInTheDocument();
    expect(await screen.findByText('网络不可达')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: '同步模式：仅本机' }),
    );

    const dialog = await screen.findByRole('dialog', {
      name: '确认切换同步模式',
    });
    expect(dialog).toHaveTextContent(/2 条修改未上传/);
    const confirm = screen.getByRole('button', { name: '确认切换' });
    expect(confirm).toBeDisabled();

    await user.click(
      screen.getByRole('checkbox', {
        name: /我已了解未上传修改的影响/,
      }),
    );
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(async () => {
      expect(await modeStore.load()).toBe('local');
    });
    expect(
      screen.queryByRole('dialog', { name: '确认切换同步模式' }),
    ).not.toBeInTheDocument();
  });

  it('仅本机模式点击立即同步不发出网络请求', async () => {
    const user = userEvent.setup();
    const fetchImpl = vi.fn();
    const store = new MemorySyncStore();
    const configStore = webdavConfig();
    const runtime = createSyncRuntime({
      platform: 'macos',
      store,
      webdavConfigStore: configStore,
      fetchImpl: fetchImpl as unknown as FetchLike,
    });

    renderSyncGroup({
      modeStore: new MemoryWebDavModeStore('local'),
      runtime,
      webdavConfigStore: configStore,
      backendConfigStore: new MemoryBackendConfigStore(),
    });

    await user.click(screen.getByRole('button', { name: '立即同步' }));

    expect(
      await screen.findByText('仅本机模式不会发起任何同步网络请求'),
    ).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Web 端不出现 WebDAV 入口，只显示后台直连', async () => {
    renderSyncGroup({
      platform: 'web',
      modeStore: new MemoryWebDavModeStore('webdav'),
      runtime: fakeRuntime(status(), { platform: 'web' }),
      webdavConfigStore: webdavConfig(),
      backendConfigStore: new MemoryBackendConfigStore(),
    });

    expect(screen.getByText('Web 唯一')).toBeInTheDocument();
    expect(screen.getByLabelText('后台地址')).toBeInTheDocument();
    expect(screen.queryByLabelText('WebDAV 地址')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '同步模式：WebDAV' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '同步模式：仅本机' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '立即同步' }),
    ).toBeInTheDocument();
  });
});
