import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BoardExportDialog } from '../BoardExportDialog';
import { planBoardExport } from '../../export/image';
import { createEmptyDocument } from '../../model';
import { sampleDocument } from '../../__tests__/fakeBoardSource';

const NOW = () => new Date(2026, 9, 28, 9, 5);

function png() {
  return new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
}

function fakeRender(document: ReturnType<typeof sampleDocument>) {
  return vi.fn(async () => ({
    blob: png(),
    plan: planBoardExport(document),
  }));
}

describe('画板导出面板', () => {
  it('空画板给出提示并禁用保存', () => {
    const document = createEmptyDocument({
      boardId: 'board-empty',
      noteId: 'note-1',
      title: '空白画板',
    });
    render(
      <BoardExportDialog
        open
        document={document}
        noteId="note-1"
        onClose={() => undefined}
        now={NOW}
      />,
    );
    expect(
      screen.getByText(/空白画板没有可导出的内容/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存 PNG' })).toBeDisabled();
    expect(screen.queryByText(/输出尺寸/)).not.toBeInTheDocument();
  });

  it('展示输出尺寸，切换白底/透明与 1x/2x', async () => {
    const user = userEvent.setup();
    const document = sampleDocument();
    render(
      <BoardExportDialog
        open
        document={document}
        noteId="note-1"
        onClose={() => undefined}
        now={NOW}
      />,
    );

    const summary = screen.getByLabelText('导出信息');
    expect(summary).toHaveTextContent(/PNG · 不透明/);
    expect(summary).toHaveTextContent(/测试画板-20261028-0905\.png/);

    await user.click(screen.getByRole('radio', { name: /透明背景/ }));
    expect(screen.getByLabelText('导出信息')).toHaveTextContent(/PNG · 透明/);

    await user.click(screen.getByRole('radio', { name: /1x 标准/ }));
    expect(
      screen.getByRole('radio', { name: /1x 标准/ }),
    ).toBeChecked();
  });

  it('保存走注入的保存面板，取消时明确说明未写入', async () => {
    const user = userEvent.setup();
    const document = sampleDocument();
    const savePng = vi.fn(
      async (_blob: Blob, _fileName: string) => ({ status: 'canceled' as const }),
    );
    render(
      <BoardExportDialog
        open
        document={document}
        noteId="note-1"
        onClose={() => undefined}
        renderPng={fakeRender(document)}
        savePng={savePng}
        now={NOW}
      />,
    );

    await user.click(screen.getByRole('button', { name: '保存 PNG' }));
    await waitFor(() => expect(savePng).toHaveBeenCalledTimes(1));
    const [blob, fileName] = savePng.mock.calls[0]!;
    expect(blob.type).toBe('image/png');
    expect(fileName).toBe('测试画板-20261028-0905.png');
    expect(
      await screen.findByText(/已取消保存，未写入任何文件/),
    ).toBeInTheDocument();
  });

  it('保存成功显示真实路径；插入笔记调用注入回调', async () => {
    const user = userEvent.setup();
    const document = sampleDocument();
    const savePng = vi.fn(
      async (_blob: Blob, _fileName: string) => ({
        status: 'saved' as const,
        path: '/Users/me/Documents/测试画板-20261028-0905.png',
        target: 'desktop' as const,
      }),
    );
    const onInsertIntoNote = vi.fn(
      async (_file: { fileName: string; blob: Blob }) => undefined,
    );
    render(
      <BoardExportDialog
        open
        document={document}
        noteId="note-1"
        onClose={() => undefined}
        onInsertIntoNote={onInsertIntoNote}
        renderPng={fakeRender(document)}
        savePng={savePng}
        now={NOW}
      />,
    );

    await user.click(screen.getByRole('button', { name: '保存 PNG' }));
    expect(
      await screen.findByText(/已保存 PNG：测试画板-20261028-0905\.png/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '插入到笔记' }));
    await waitFor(() => expect(onInsertIntoNote).toHaveBeenCalledTimes(1));
    const inserted = onInsertIntoNote.mock.calls[0]![0] as {
      fileName: string;
      blob: Blob;
    };
    expect(inserted.fileName).toBe('测试画板-20261028-0905.png');
    expect(inserted.blob.type).toBe('image/png');
    expect(
      await screen.findByText(/已插入当前笔记末尾/),
    ).toBeInTheDocument();
  });

  it('没有关联笔记时不显示插入按钮', () => {
    const document = sampleDocument();
    render(
      <BoardExportDialog
        open
        document={document}
        onClose={() => undefined}
        onInsertIntoNote={async () => undefined}
        now={NOW}
      />,
    );
    expect(
      screen.queryByRole('button', { name: '插入到笔记' }),
    ).not.toBeInTheDocument();
  });

  it('大画板显示等比缩小提示', () => {
    const document = sampleDocument();
    document.nodes[0] = {
      ...document.nodes[0]!,
      x: 0,
      y: 0,
      width: 40_000,
      height: 30_000,
    };
    render(
      <BoardExportDialog
        open
        document={document}
        noteId="note-1"
        onClose={() => undefined}
        now={NOW}
      />,
    );
    expect(screen.getByText(/已按单边 8192px/)).toBeInTheDocument();
  });

  it('保存进行中：取消、关闭 X、插入与保存全部禁用；完成后恢复', async () => {
    const user = userEvent.setup();
    const document = sampleDocument();
    let finishSave: ((result: { status: 'canceled' }) => void) | null = null;
    const savePng = vi.fn(
      () =>
        new Promise<{ status: 'canceled' }>((resolve) => {
          finishSave = resolve;
        }),
    );
    render(
      <BoardExportDialog
        open
        document={document}
        noteId="note-1"
        onClose={() => undefined}
        onInsertIntoNote={async () => undefined}
        renderPng={fakeRender(document)}
        savePng={savePng}
        now={NOW}
      />,
    );

    await user.click(screen.getByRole('button', { name: '保存 PNG' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '正在导出…' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '插入到笔记' })).toBeDisabled();

    await act(async () => {
      finishSave?.({ status: 'canceled' });
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '保存 PNG' })).not.toBeDisabled();
    });
    expect(screen.getByRole('button', { name: '取消' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭' })).not.toBeDisabled();
    expect(
      screen.getByRole('button', { name: '插入到笔记' }),
    ).not.toBeDisabled();
  });
});
