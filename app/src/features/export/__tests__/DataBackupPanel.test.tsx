import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { createMemoryRestoreTarget } from '../../import/__tests__/memoryTarget';
import { monitor } from '../monitoring';
import { DataBackupPanel } from '../DataBackupPanel';
import { createMemoryDownloader } from '../download';
import type { BusinessResetTarget, ResetDomainReport } from '../reset';
import { makeDataset, makeMemorySource, makePayload } from './testFixtures';

const RESET_REPORT: ResetDomainReport = {
  deletedRows: 12,
  preservedSettings: 4,
  seedApplied: true,
  samplesInserted: 28,
  inboxCreated: true,
  workCreated: true,
  seedMarker: '0002_domain',
};

function fakeResetTarget(
  implementation: () => Promise<ResetDomainReport> = async () => RESET_REPORT,
): BusinessResetTarget & { reset: ReturnType<typeof vi.fn> } {
  return { reset: vi.fn(implementation) };
}

describe('完整备份面板', () => {
  it('浏览器/无 SQLite 时不伪造完整备份入口，并明确业务重置需桌面壳', () => {
    render(<DataBackupPanel source={null} target={null} />);
    expect(screen.getAllByText('需桌面壳')).toHaveLength(4);
    expect(
      screen.queryByRole('button', { name: '导出 ZIP' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '重置全部数据' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('未实现')).not.toBeInTheDocument();
    expect(screen.getByText(/业务数据重置只在桌面壳内可用/)).toBeInTheDocument();
    expect(screen.getByText(/偏好备份/)).toBeInTheDocument();
  });

  it('可下载脱敏诊断 JSON', async () => {
    monitor.setEnabled(true);
    monitor.reset();
    monitor.error('test', new Error('token=secret-value'));
    const user = userEvent.setup();
    const downloads = createMemoryDownloader();
    render(
      <DataBackupPanel
        source={makeMemorySource(makePayload())}
        target={createMemoryRestoreTarget(makeDataset())}
        downloader={downloads.downloader}
      />,
    );
    await user.click(screen.getByRole('button', { name: '下载诊断 JSON' }));
    await waitFor(() => expect(downloads.files).toHaveLength(1));
    const text = await downloads.last()!.blob.text();
    expect(text).toContain('generatedAt');
    expect(text).not.toContain('secret-value');
    monitor.setEnabled(false);
    monitor.reset();
  });

  it('单向导出：结构化数据 JSON 可下载，并在面板显示成功状态', async () => {
    const user = userEvent.setup();
    const downloads = createMemoryDownloader();
    render(
      <DataBackupPanel
        source={makeMemorySource(makePayload())}
        target={createMemoryRestoreTarget(makeDataset())}
        downloader={downloads.downloader}
      />,
    );

    await user.click(
      screen.getByRole('button', { name: /结构化数据（JSON，供开发\/迁移）/ }),
    );
    await waitFor(() => expect(downloads.files).toHaveLength(1));
    expect(downloads.last()!.fileName).toMatch(/^zhixing-backup-.*\.json$/);
    const text = await downloads.last()!.blob.text();
    expect(text).toContain('"kind": "backup"');
    expect(
      screen.getByText(/已导出 结构化数据（JSON）/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('设置分组：备份与恢复 / 单向导出分开，不暴露裸 JSON 按钮', () => {
    const downloads = createMemoryDownloader();
    render(
      <DataBackupPanel
        source={makeMemorySource(makePayload())}
        target={createMemoryRestoreTarget(makeDataset())}
        downloader={downloads.downloader}
      />,
    );

    expect(screen.getByText('备份与恢复')).toBeInTheDocument();
    expect(screen.getByText('单向导出')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'JSON' })).toBeNull();
    // ZIP 完整备份属于可回导组，Markdown/CSV/PDF 属于单向导出组。
    const backupHeading = screen.getByText('备份与恢复');
    const oneWayHeading = screen.getByText('单向导出');
    const zip = screen.getByRole('button', { name: '导出 ZIP' });
    const markdown = screen.getByRole('button', { name: 'Markdown' });
    expect(
      backupHeading.compareDocumentPosition(zip) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      oneWayHeading.compareDocumentPosition(markdown) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      backupHeading.compareDocumentPosition(markdown) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('业务数据重置：勾选确认后才调用目标，成功后显示删除/种子/偏好保留', async () => {
    const user = userEvent.setup();
    const resetTarget = fakeResetTarget();
    render(
      <DataBackupPanel
        source={makeMemorySource(makePayload())}
        target={createMemoryRestoreTarget(makeDataset())}
        resetTarget={resetTarget}
      />,
    );

    await user.click(screen.getByRole('button', { name: '重置全部数据' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/重置前请先导出完整备份/),
    ).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', {
      name: '确认重置业务数据',
    });
    expect(confirm).toBeDisabled();

    await user.click(
      within(dialog).getByRole('checkbox', { name: /重置不可撤销/ }),
    );
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(resetTarget.reset).toHaveBeenCalledTimes(1));
    expect(
      await within(dialog).findByText('业务数据已重置'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/已删除 12 行业务数据/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/保留 4 条设备\/空间偏好/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/已重置业务数据：删除 12 行/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('取消确认不会调用重置目标', async () => {
    const user = userEvent.setup();
    const resetTarget = fakeResetTarget();
    render(
      <DataBackupPanel
        source={makeMemorySource(makePayload())}
        target={createMemoryRestoreTarget(makeDataset())}
        resetTarget={resetTarget}
      />,
    );

    await user.click(screen.getByRole('button', { name: '重置全部数据' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('checkbox', { name: /重置不可撤销/ }),
    );
    await user.click(within(dialog).getByRole('button', { name: '取消' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(resetTarget.reset).not.toHaveBeenCalled();
    expect(screen.queryByText(/业务数据已重置/)).not.toBeInTheDocument();
  });

  it('重置失败时保持弹层并提示事务已回滚，不显示成功', async () => {
    const user = userEvent.setup();
    const resetTarget = fakeResetTarget(async () => {
      throw new Error('数据库被占用');
    });
    render(
      <DataBackupPanel
        source={makeMemorySource(makePayload())}
        target={createMemoryRestoreTarget(makeDataset())}
        resetTarget={resetTarget}
      />,
    );

    await user.click(screen.getByRole('button', { name: '重置全部数据' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('checkbox', { name: /重置不可撤销/ }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: '确认重置业务数据' }),
    );

    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        /重置失败，业务数据未改动（事务已回滚）：数据库被占用/,
      ),
    );
    expect(within(dialog).queryByText('业务数据已重置')).not.toBeInTheDocument();
    expect(screen.queryByText(/已重置业务数据/)).not.toBeInTheDocument();
    // 失败后仍可重试，未被关闭。
    expect(
      within(dialog).getByRole('button', { name: '确认重置业务数据' }),
    ).toBeEnabled();
  });

  it('重置前可在弹层内先导出 ZIP 备份', async () => {
    const user = userEvent.setup();
    const downloads = createMemoryDownloader();
    const resetTarget = fakeResetTarget();
    render(
      <DataBackupPanel
        source={makeMemorySource(makePayload())}
        target={createMemoryRestoreTarget(makeDataset())}
        resetTarget={resetTarget}
        downloader={downloads.downloader}
      />,
    );

    await user.click(screen.getByRole('button', { name: '重置全部数据' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: '先导出 ZIP 备份' }),
    );

    await waitFor(() => expect(downloads.files).toHaveLength(1));
    expect(downloads.last()!.fileName).toMatch(/^zhixing-backup-.*\.zip$/);
    expect(
      await within(dialog).findByText(/已生成 ZIP 备份/),
    ).toBeInTheDocument();
    expect(resetTarget.reset).not.toHaveBeenCalled();
  });

  it('同一 tick 连续点击导出只落一份文件', async () => {
    const downloads = createMemoryDownloader();
    render(
      <DataBackupPanel
        source={makeMemorySource(makePayload())}
        target={createMemoryRestoreTarget(makeDataset())}
        downloader={downloads.downloader}
      />,
    );
    const button = screen.getByRole('button', { name: '导出 ZIP' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(downloads.files).toHaveLength(1));
    expect(downloads.files).toHaveLength(1);
  });
});
