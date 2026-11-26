/**
 * P2-04 端到端（jsdom）：真实组件 + 内存数据源/写入目标。
 * 覆盖验收命令 `pnpm --filter app test:e2e` 中的导出、导入预览、冲突确认、
 * 关系保留、Tab 焦点循环与 Esc 关闭。
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { readZip } from '../zip';
import { DataBackupPanel } from '../DataBackupPanel';
import { createMemoryDownloader } from '../download';
import { createMemoryRestoreTarget } from '../../import/__tests__/memoryTarget';
import {
  FIXED_NOW,
  makeDataset,
  makeMemorySource,
  makePayload,
} from './testFixtures';


function fileFromBlob(blob: Blob, name: string): File {
  return new File([blob], name, { type: blob.type || 'application/zip' });
}

describe('完整备份端到端', () => {
  it('导出 ZIP 含 manifest/附件哈希/画板 JSON；冲突选择保留两者后恢复', async () => {
    const user = userEvent.setup();
    const payload = makePayload();
    const backupBody = payload.dataset.notes.find((note) => note.id === 'note-a')!.body;
    const source = makeMemorySource(payload);
    const target = createMemoryRestoreTarget(makeDataset());
    const downloads = createMemoryDownloader();

    render(
      <DataBackupPanel
        source={source}
        target={target}
        downloader={downloads.downloader}
        now={() => FIXED_NOW}
      />,
    );

    await user.click(screen.getByRole('button', { name: '导出 ZIP' }));
    await waitFor(() => expect(downloads.files).toHaveLength(1));
    const download = downloads.last()!;
    expect(download.fileName).toMatch(/^zhixing-backup-.*\.zip$/);

    const bytes = new Uint8Array(await download.blob.arrayBuffer());
    const entries = await readZip(bytes);
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain('manifest.json');
    expect(paths).toContain('data/relations.json');
    expect(paths.some((path) => path.startsWith('boards/'))).toBe(true);
    expect(paths.some((path) => path.startsWith('attachments/'))).toBe(true);
    const manifest = JSON.parse(
      new TextDecoder().decode(entries.find((entry) => entry.path === 'manifest.json')!.data),
    );
    expect(manifest.attachments[0].sha256).toHaveLength(64);
    expect(manifest.attachments[0].path).toBeTruthy();
    expect(manifest.boards[0].title).toBe('发布流程');
    expect(manifest.relations.total).toBeGreaterThan(0);

    // 导出一份旧备份后，本机笔记正文被修改，制造恢复冲突。
    const localBody = '<p>本机冲突版本</p>';
    payload.dataset.notes.find((note) => note.id === 'note-a')!.body = localBody;
    target.dataset.notes.find((note) => note.id === 'note-a')!.body = localBody;

    const input = screen.getByLabelText('选择完整备份文件');
    await user.upload(input, fileFromBlob(download.blob, download.fileName));

    const dialog = await screen.findByRole('dialog', { name: '恢复预览' });
    expect(within(dialog).getByText(/本机冲突版本/)).toBeInTheDocument();
    const keepBoth = within(dialog).getAllByRole('radio', { name: '保留两者' })[0]!;
    await user.click(keepBoth);
    expect(keepBoth).toBeChecked();

    await user.click(within(dialog).getByRole('button', { name: '确认恢复' }));
    await within(dialog).findByText('恢复完成');

    const copies = target.dataset.notes.filter((note) => note.title === '发布检查');
    expect(copies).toHaveLength(2);
    expect(copies.find((note) => note.id === 'note-a')!.body).toBe(localBody);
    const copy = copies.find((note) => note.id !== 'note-a')!;
    expect(copy.body).toBe(backupBody);
    expect(
      target.dataset.noteBlocks.some((block) => block.noteId === copy.id),
    ).toBe(true);
    expect(target.dataset.noteTodos.some((todo) => todo.noteId === copy.id)).toBe(true);
    // 关系全部可达。
    expect(
      target.dataset.tasks.find((task) => task.id === 'task-deleted')?.noteId,
    ).toBe('note-a');

    await user.click(within(dialog).getByRole('button', { name: '完成' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/恢复完成：新增/)).toBeInTheDocument();
  });

  it('默认跳过冲突；Tab 停留在模态内，Esc 关闭', async () => {
    const user = userEvent.setup();
    const payload = makePayload();
    const source = makeMemorySource(payload);
    const target = createMemoryRestoreTarget(makeDataset());
    const downloads = createMemoryDownloader();

    render(
      <DataBackupPanel
        source={source}
        target={target}
        downloader={downloads.downloader}
        now={() => FIXED_NOW}
      />,
    );

    await user.click(screen.getByRole('button', { name: '导出 ZIP' }));
    await waitFor(() => expect(downloads.files).toHaveLength(1));
    const download = downloads.last()!;
    payload.dataset.notes.find((note) => note.id === 'note-a')!.body = '<p>只在本机</p>';
    target.dataset.notes.find((note) => note.id === 'note-a')!.body = '<p>只在本机</p>';

    await user.upload(
      screen.getByLabelText('选择完整备份文件'),
      fileFromBlob(download.blob, download.fileName),
    );
    const dialog = await screen.findByRole('dialog', { name: '恢复预览' });
    const skip = within(dialog).getAllByRole('radio', { name: '跳过（保留本机）' })[0]!;
    expect(skip).toBeChecked();

    // Tab 与 Shift+Tab 都不会把焦点送出模态。
    for (let index = 0; index < 6; index += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    const restoreTrigger = screen.getByRole('button', { name: '选择备份文件' });
    await waitFor(() => expect(restoreTrigger).toHaveFocus());
    expect(
      target.dataset.notes.find((note) => note.id === 'note-a')?.body,
    ).toBe('<p>只在本机</p>');
  });
});
