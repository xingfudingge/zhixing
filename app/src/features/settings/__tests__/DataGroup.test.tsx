/**
 * ZX-EXPORT-06：设置页「默认导出目录」。
 *
 * - 未设置时明确显示“每次保存时选择”；
 * - 选择后保存到设备偏好，并回显用户选中的实际路径；
 * - 清除后恢复每次询问；
 * - 目录失效/无权限时显示可恢复提示，不吞掉错误。
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from '../../../data/repositories/settings';
import type { SettingsWorkspaceValue } from '../useSettingsWorkspace';
import { DataGroup } from '../groups/DataGroup';

function workspaceWith(
  directory: string | null,
  updateExportDirectory: (value: string | null) => Promise<unknown>,
): SettingsWorkspaceValue {
  const settings: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    export: { directory },
  };
  return {
    sourceMode: 'sqlite',
    settings,
    dbStatus: null,
    status: 'ready',
    saveState: 'saved',
    error: null,
    notice: null,
    updateExportDirectory,
  } as unknown as SettingsWorkspaceValue;
}

function renderDataGroup(
  workspace: SettingsWorkspaceValue,
  options: {
    pickDirectory?: () => Promise<string | null>;
    desktop?: boolean;
  } = {},
) {
  return render(
    <DataGroup
      workspace={workspace}
      backupSource={null}
      restoreTarget={null}
      resetTarget={null}
      pickDirectory={options.pickDirectory}
      desktop={options.desktop}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('默认导出目录设置', () => {
  it('未设置时显示每次保存时选择，且不显示清除按钮', () => {
    renderDataGroup(workspaceWith(null, vi.fn()), { desktop: true });

    expect(screen.getByText('未设置（每次保存时选择）')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择目录' })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: '清除' }),
    ).not.toBeInTheDocument();
  });

  it('选择目录后把实际路径写入设备偏好并回显', async () => {
    const user = userEvent.setup();
    const update = vi.fn().mockResolvedValue(undefined);
    const pick = vi.fn().mockResolvedValue('/Users/me/Documents/知行导出');
    const workspace = workspaceWith(null, update);

    const { rerender } = renderDataGroup(workspace, {
      pickDirectory: pick,
      desktop: true,
    });

    await user.click(screen.getByRole('button', { name: '选择目录' }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith('/Users/me/Documents/知行导出');
    });

    // 保存成功后设置对象会带新路径重新渲染；这里复现同一回显。
    rerender(
      <DataGroup
        workspace={workspaceWith('/Users/me/Documents/知行导出', update)}
        backupSource={null}
        restoreTarget={null}
        resetTarget={null}
        desktop
      />,
    );
    expect(
      screen.getByText('/Users/me/Documents/知行导出'),
    ).toBeInTheDocument();
  });

  it('取消目录选择不修改设置', async () => {
    const user = userEvent.setup();
    const update = vi.fn();

    renderDataGroup(workspaceWith(null, update), {
      pickDirectory: vi.fn().mockResolvedValue(null),
      desktop: true,
    });

    await user.click(screen.getByRole('button', { name: '选择目录' }));

    expect(update).not.toHaveBeenCalled();
  });

  it('清除后恢复每次询问', async () => {
    const user = userEvent.setup();
    const update = vi.fn().mockResolvedValue(undefined);

    renderDataGroup(workspaceWith('/Users/me/Exports', update), {
      desktop: true,
    });

    await user.click(screen.getByRole('button', { name: '清除' }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith(null);
    });
  });

  it('目录失效或无权限时显示可恢复提示', async () => {
    const user = userEvent.setup();
    const update = vi.fn();

    renderDataGroup(workspaceWith(null, update), {
      pickDirectory: vi
        .fn()
        .mockRejectedValue(
          '默认导出目录不可写：/Volumes/离线盘 没有写入权限。请在「设置 → 数据与备份」中重新选择默认导出目录，或清除默认目录后每次手动选择。',
        ),
      desktop: true,
    });

    await user.click(screen.getByRole('button', { name: '选择目录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /没有写入权限/,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/重新选择/);
    expect(update).not.toHaveBeenCalled();
  });

  it('浏览器预览禁用固定目录并说明原因', () => {
    renderDataGroup(workspaceWith(null, vi.fn()), { desktop: false });

    expect(screen.getByRole('button', { name: '选择目录' })).toBeDisabled();
    expect(
      screen.getByText(/浏览器预览不支持固定目录/),
    ).toBeInTheDocument();
  });
});
