import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { WebDavError } from '../../../../../packages/sync-webdav/src/index.ts';
import {
  defaultWebDavConfig,
  MemoryWebDavConfigStore,
} from '../configStore.ts';
import {
  WebDavSettingsPanel,
  type WebDavConnectionTester,
  type WebDavFormValues,
} from '../WebDavSettingsPanel.tsx';

const values: WebDavFormValues = {
  baseUrl: 'http://127.0.0.1:5244/dav',
  username: 'alice',
  password: 'app-password',
  root: '/zhixing',
  spaceId: 'personal',
  deviceId: 'device-a',
  deviceName: '本机',
};

const successResult = {
  ok: true,
  baseUrl: 'http://127.0.0.1:5244/dav',
  root: '/zhixing',
  checks: [
    { id: 'propfind' as const, label: 'PROPFIND 根目录', status: 'ok' as const },
    { id: 'mkcol' as const, label: '递归创建目录', status: 'ok' as const },
    { id: 'chunked' as const, label: '分片写入与整体校验', status: 'ok' as const },
  ],
  error: null,
  testedAt: '2026-10-26T12:00:00.000Z',
};

function renderPanel(
  props: Partial<Parameters<typeof WebDavSettingsPanel>[0]> = {},
) {
  return render(
    <WebDavSettingsPanel
      platform="macos"
      initialValues={values}
      {...props}
    />,
  );
}

describe('WebDAV 设置面板', () => {
  it('Web 端不渲染任何输入框或按钮，只说明只连后台', () => {
    renderPanel({ platform: 'web' });

    expect(
      screen.getByText(/Web 端只连接知行后台，不提供 WebDAV 入口/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('WebDAV 地址')).toBeNull();
  });

  it('桌面端测试连接显示逐项结果，并可保存不含密码的配置', async () => {
    const user = userEvent.setup();
    const tester = vi.fn<WebDavConnectionTester>().mockResolvedValue(successResult);
    const configStore = new MemoryWebDavConfigStore();
    renderPanel({ tester, configStore });

    expect(screen.getByLabelText('WebDAV 地址')).toHaveValue(values.baseUrl);
    expect(screen.getByLabelText('WebDAV 应用密码')).toHaveValue('app-password');

    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() =>
      expect(screen.getByText('连接可用')).toBeInTheDocument(),
    );
    expect(tester).toHaveBeenCalledWith(values, 'macos');
    expect(screen.getByText('PROPFIND 根目录')).toBeInTheDocument();
    expect(screen.getByText('分片写入与整体校验')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '保存连接信息' }));
    await waitFor(() =>
      expect(screen.getByText(/连接信息已保存/)).toBeInTheDocument(),
    );
    const saved = await configStore.load();
    expect(saved?.baseUrl).toBe(values.baseUrl);
    expect(saved?.passwordSaved).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(saved, 'password'),
    ).toBe(false);
  });

  it('没有 initialValues 时回填已保存配置，但不回填密码', async () => {
    const configStore = new MemoryWebDavConfigStore({
      ...defaultWebDavConfig(),
      baseUrl: 'https://saved.example.com/dav',
      username: 'saved-user',
      deviceId: 'saved-device',
      passwordSaved: false,
    });
    render(
      <WebDavSettingsPanel platform="macos" configStore={configStore} />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText('WebDAV 地址')).toHaveValue(
        'https://saved.example.com/dav',
      ),
    );
    expect(screen.getByLabelText('WebDAV 用户名')).toHaveValue('saved-user');
    expect(screen.getByLabelText('WebDAV 应用密码')).toHaveValue('');
  });

  it('认证/网络错误展示可读文案，而不是只抛异常', async () => {
    const user = userEvent.setup();
    const tester = vi.fn<WebDavConnectionTester>().mockRejectedValue(
      new WebDavError('AUTH_FAILED', 'WebDAV 认证失败，请检查用户名与应用密码'),
    );
    renderPanel({ tester });

    await user.click(screen.getByRole('button', { name: '测试连接' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toBeInTheDocument(),
    );
    expect(screen.getByText('认证失败')).toBeInTheDocument();
    expect(
      screen.getByText(/请检查用户名与应用密码/),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/应用密码/);
  });

  it('从 WebDAV 切到仅本机且有未上传时，必须勾选确认后才回调', async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    renderPanel({
      currentMode: 'webdav',
      pendingUploads: 2,
      onModeChange,
    });

    expect(screen.getByText(/本机有 2 条修改待上传/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '仅本机' }));

    const dialog = screen.getByRole('dialog', { name: '确认切换同步模式' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/这些修改不会再自动上传/)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: '确认切换' });
    expect(confirm).toBeDisabled();

    await user.click(
      screen.getByRole('checkbox', {
        name: /我已了解未上传修改的影响/,
      }),
    );
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(onModeChange).toHaveBeenCalledTimes(1);
    expect(onModeChange.mock.calls[0][0]).toBe('local');
    expect(onModeChange.mock.calls[0][1]).toMatchObject({
      allowed: true,
      code: 'OK',
    });
  });

  it('从仅本机切到 WebDAV 有未上传时，同样先确认再回调', async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    renderPanel({
      currentMode: 'local',
      pendingUploads: 1,
      onModeChange,
    });

    await user.click(screen.getByRole('button', { name: 'WebDAV' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: '确认切换' }));

    expect(onModeChange).toHaveBeenCalledWith(
      'webdav',
      expect.objectContaining({ allowed: true }),
    );
  });

  it('提供宿主回调前不伪造模式切换按钮行为', () => {
    renderPanel({ currentMode: 'local', pendingUploads: 0 });
    expect(screen.getByRole('button', { name: 'WebDAV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '后台直连' })).toBeDisabled();
    expect(screen.getByText(/不伪造切换按钮行为/)).toBeInTheDocument();
  });
});
