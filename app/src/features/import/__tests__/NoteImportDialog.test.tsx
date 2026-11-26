import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { ImportNoteInput, Note } from '../../../data/db/types';
import { buildNotePackage } from '../../export/note/package';
import { buildInput } from '../../export/note/__tests__/packageFixtures';
import {
  NoteImportDialog,
  type NotePackageImportInput,
} from '../NoteImportDialog';

function makeNote(id: string, title: string): Note {
  return {
    id,
    spaceId: 'personal',
    title,
    folderId: null,
    tags: [],
    body: '',
    bodyFormat: 'html',
    status: 'active',
    favorite: false,
    pinned: false,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  };
}

function renderDialog(overrides: {
  importNote?: (input: ImportNoteInput) => Promise<Note>;
  importPackage?: (input: NotePackageImportInput) => Promise<Note>;
} = {}) {
  const importNote = vi.fn(
    overrides.importNote ??
      (async (input: ImportNoteInput) =>
        makeNote('note-imported', input.note.title)),
  );
  const importPackage = vi.fn(
    overrides.importPackage ??
      (async (input: NotePackageImportInput) =>
        makeNote('note-package', input.parsed.preview.title)),
  );
  const onOpenNote = vi.fn();
  render(
    <NoteImportDialog
      folders={[{ id: 'f1', name: '产品设计' }]}
      defaultFolderId={null}
      existingTitles={() => new Set()}
      importNote={importNote}
      importPackage={importPackage}
      onClose={vi.fn()}
      onOpenNote={onOpenNote}
    />,
  );
  return { importNote, importPackage, onOpenNote };
}

async function upload(
  user: ReturnType<typeof userEvent.setup>,
  file: File,
) {
  const input = screen.getByLabelText('选择要导入的文件');
  await user.upload(input, file);
}

describe('NoteImportDialog · .zxnote 预览与导入（ZX5-IO-06）', () => {
  it('选择 .zxnote 后显示块/画板/附件/待办预览，并通过包写入入口导入', async () => {
    const user = userEvent.setup();
    const report = await buildNotePackage(buildInput());
    const { importPackage, importNote } = renderDialog();

    await upload(
      user,
      new File([report.bytes.slice().buffer], '发布流程.zxnote', {
        type: 'application/x-zhixing-note+zip',
      }),
    );

    expect(
      await screen.findByText(/知行笔记包 v1 · 5 个块 · 1 张画板/),
    ).toBeInTheDocument();
    expect(screen.getByText('标题：发布流程')).toBeInTheDocument();
    expect(screen.getByText(/1 个附件/)).toBeInTheDocument();
    expect(screen.getByText(/1 个待办/)).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: /开始导入（1）/ }),
    );

    await waitFor(() => expect(importPackage).toHaveBeenCalledTimes(1));
    expect(importPackage.mock.calls[0]![0]).toMatchObject({
      folderId: null,
      parsed: {
        preview: { title: '发布流程', blockCount: 5 },
      },
    });
    expect(importNote).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/全部导入成功：成功 1 篇/),
    ).toBeInTheDocument();
  });

  it('损坏的 .zxnote 显示校验错误并禁用导入按钮', async () => {
    const user = userEvent.setup();
    const { importPackage } = renderDialog();
    await upload(
      user,
      new File([new Uint8Array([1, 2, 3, 4])], '损坏包.zxnote'),
    );

    expect(await screen.findByText(/ZXNOTE_ZIP_INVALID/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /开始导入/ }),
    ).toBeDisabled();
    expect(importPackage).not.toHaveBeenCalled();
  });

  it('Markdown 旧入口保留：仍走 importNote 而不是笔记包入口', async () => {
    const user = userEvent.setup();
    const { importNote, importPackage } = renderDialog();
    await upload(
      user,
      new File(['# 项目 A\n\n第一段正文\n'], '项目.md', {
        type: 'text/markdown',
      }),
    );

    expect(await screen.findByText('标题：项目 A')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: /开始导入（1）/ }),
    );
    await waitFor(() => expect(importNote).toHaveBeenCalledTimes(1));
    expect(importPackage).not.toHaveBeenCalled();
    expect(importNote.mock.calls[0]![0].note.title).toBe('项目 A');
  });
});

function ImportHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开导入
      </button>
      {open ? (
        <NoteImportDialog
          folders={[{ id: 'f1', name: '产品设计' }]}
          defaultFolderId={null}
          existingTitles={() => new Set()}
          importNote={async (input) => makeNote('note-imported', input.note.title)}
          importPackage={async (input) =>
            makeNote('note-package', input.parsed.preview.title)
          }
          onClose={() => {
            setOpen(false);
            onClose();
          }}
          onOpenNote={vi.fn()}
        />
      ) : null}
    </>
  );
}

describe('NoteImportDialog · 共享 Modal（ZX6-DIALOG-02）', () => {
  it('portal 到 body，header/body/footer 分离；Escape 关闭并归还焦点', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ImportHarness onClose={onClose} />);

    const trigger = screen.getByRole('button', { name: '打开导入' });
    trigger.focus();
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: '导入笔记' });
    expect(dialog.closest('.zx-modal-backdrop')).not.toBeNull();
    expect(document.querySelector('.kn-modal-backdrop')).toBeNull();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);

    const body = dialog.querySelector('.zx-modal-body');
    const footer = dialog.querySelector('.zx-modal-foot');
    expect(body).not.toBeNull();
    expect(footer).not.toBeNull();
    // 导入列表再长也只滚 body，关闭/导入按钮固定在 footer。
    expect(body!.contains(footer)).toBe(false);
    expect(
      within(footer as HTMLElement).getByRole('button', { name: '关闭' }),
    ).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
