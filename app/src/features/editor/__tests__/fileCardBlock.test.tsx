import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { FileCardBlock } from '../blocks/FileCardBlock';
import { makeBlock } from './fakeBlockSource';

function fileBlock(fileName = '季度复盘.docx') {
  return makeBlock({
    id: 'file-1',
    type: 'file',
    payload: {
      attachmentId: 'att_1',
      fileName,
      byteSize: 131072,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      status: 'pending',
    },
  });
}

function renderCard(
  props: Partial<ComponentProps<typeof FileCardBlock>> = {},
) {
  const onChangeName = vi.fn();
  const onCommitName = vi.fn();
  const view = render(
    <FileCardBlock
      block={fileBlock()}
      readOnly={false}
      onChangeName={onChangeName}
      onCommitName={onCommitName}
      localState="local"
      {...props}
    />,
  );
  return { ...view, onChangeName, onCommitName };
}

describe('FileCardBlock · 紧凑文件行（ZX-FILE-05）', () => {
  it('默认是一行附件行：图标 + 文件名 + 大小 + 状态，不再显示“待上传”', () => {
    const { container } = renderCard({ onOpen: vi.fn() });

    const row = screen.getByRole('group', { name: '文件卡：季度复盘.docx' });
    expect(row).toHaveClass('zxe-filecard', 'zxe-filerow');
    expect(row).toHaveAttribute('data-file-state', 'local');
    expect(row.querySelector('.zxe-filecard-icon')).toHaveTextContent('W');
    expect(
      screen.getByRole('button', {
        name: '重命名文件 季度复盘.docx：双击或按 F2',
      }),
    ).toHaveTextContent('季度复盘.docx');
    expect(screen.getByText('DOCX · 128 KB')).toBeInTheDocument();
    expect(screen.getByText('本机已保存')).toBeInTheDocument();
    expect(screen.queryByText(/待上传/)).toBeNull();

    const actions = container.querySelector('.zxe-filecard-side');
    expect(actions).not.toBeNull();
    expect(
      within(actions as HTMLElement).getAllByRole('button').map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual(['打开文件 季度复盘.docx', '更多文件操作 季度复盘.docx']);
  });

  it('双击文件名进入行内重命名，Enter 提交块与附件名', async () => {
    const user = userEvent.setup();
    const { onChangeName, onCommitName } = renderCard();

    await user.dblClick(
      screen.getByRole('button', {
        name: '重命名文件 季度复盘.docx：双击或按 F2',
      }),
    );
    const input = screen.getByLabelText('文件名');
    expect(input).toHaveValue('季度复盘.docx');
    await user.clear(input);
    await user.type(input, '2026 季度复盘.docx{Enter}');

    expect(onChangeName).toHaveBeenCalledWith('2026 季度复盘.docx');
    expect(onCommitName).toHaveBeenCalledWith('2026 季度复盘.docx');
    expect(screen.queryByLabelText('文件名')).toBeNull();
    expect(
      screen.getByRole('button', {
        name: '重命名文件 季度复盘.docx：双击或按 F2',
      }),
    ).toBeInTheDocument();
  });

  it('文件名获得焦点后按 F2 / Enter 可重命名，Esc 取消不写回', async () => {
    const user = userEvent.setup();
    const { onChangeName, onCommitName } = renderCard();
    const name = screen.getByRole('button', {
      name: '重命名文件 季度复盘.docx：双击或按 F2',
    });

    name.focus();
    await user.keyboard('{F2}');
    const input = screen.getByLabelText('文件名');
    fireEvent.change(input, { target: { value: '改名.docx' } });
    await user.keyboard('{Escape}');

    expect(onChangeName).not.toHaveBeenCalled();
    expect(onCommitName).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('文件名')).toBeNull();

    name.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('文件名')).toHaveValue('季度复盘.docx');
  });

  it('更多菜单提供重命名、另存、打开、删除，且动作不因窄窗 CSS 丢失', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onDownload = vi.fn();
    const onRemove = vi.fn();
    renderCard({ onOpen, onDownload, onRemove });

    await user.click(
      screen.getByRole('button', {
        name: '更多文件操作 季度复盘.docx',
      }),
    );
    const menu = await screen.findByRole('menu', {
      name: '更多文件操作 季度复盘.docx',
    });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['打开', '另存为…', '重命名…', '删除文件卡']);

    await user.click(within(menu).getByRole('menuitem', { name: '打开' }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole('button', {
        name: '更多文件操作 季度复盘.docx',
      }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', {
          name: '更多文件操作 季度复盘.docx',
        }),
      ).getByRole('menuitem', { name: '重命名…' }),
    );
    expect(screen.getByLabelText('文件名')).toHaveValue('季度复盘.docx');

    fireEvent.blur(screen.getByLabelText('文件名'));
    await user.click(
      screen.getByRole('button', {
        name: '更多文件操作 季度复盘.docx',
      }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', {
          name: '更多文件操作 季度复盘.docx',
        }),
      ).getByRole('menuitem', { name: '另存为…' }),
    );
    expect(onDownload).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole('button', {
        name: '更多文件操作 季度复盘.docx',
      }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', {
          name: '更多文件操作 季度复盘.docx',
        }),
      ).getByRole('menuitem', { name: '删除文件卡' }),
    );
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('缺失态显示紧凑 badge，不显示打开，可从菜单重新选择或远端下载', async () => {
    const user = userEvent.setup();
    const onRemoteDownload = vi.fn();
    const onReselect = vi.fn();
    renderCard({
      localState: 'missing',
      onRemoteDownload,
      onReselect,
      onRemove: vi.fn(),
    });

    const row = screen.getByRole('group', { name: '文件卡：季度复盘.docx' });
    expect(row).toHaveAttribute('data-file-state', 'missing');
    expect(screen.getByRole('alert')).toHaveTextContent('文件缺失');
    expect(
      screen.queryByRole('button', { name: '打开文件 季度复盘.docx' }),
    ).toBeNull();

    await user.click(
      screen.getByRole('button', {
        name: '更多文件操作 季度复盘.docx',
      }),
    );
    const menu = await screen.findByRole('menu', {
      name: '更多文件操作 季度复盘.docx',
    });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      '从服务器下载',
      '重新选择文件…',
      '重命名…',
      '删除文件卡',
    ]);

    await user.click(
      within(menu).getByRole('menuitem', { name: '从服务器下载' }),
    );
    expect(onRemoteDownload).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole('button', {
        name: '更多文件操作 季度复盘.docx',
      }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', {
          name: '更多文件操作 季度复盘.docx',
        }),
      ).getByRole('menuitem', { name: '重新选择文件…' }),
    );
    expect(onReselect).toHaveBeenCalledTimes(1);
  });

  it('仅远端态不伪装可打开，显式下载后才交还打开能力', async () => {
    const user = userEvent.setup();
    const onRemoteDownload = vi.fn();
    renderCard({ localState: 'remote', onRemoteDownload });

    expect(screen.getByText('远端可用 · 需下载')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '打开文件 季度复盘.docx' }),
    ).toBeNull();

    await user.click(
      screen.getByRole('button', {
        name: '更多文件操作 季度复盘.docx',
      }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', {
          name: '更多文件操作 季度复盘.docx',
        }),
      ).getByRole('menuitem', { name: '从服务器下载' }),
    );
    expect(onRemoteDownload).toHaveBeenCalledTimes(1);
  });

  it('附件服务不可用时不提供打开、下载或重新选择，只保留重命名与删除', async () => {
    const user = userEvent.setup();
    const onReselect = vi.fn();
    renderCard({
      localState: 'unavailable',
      onReselect,
      onRemove: vi.fn(),
    });

    expect(screen.getByText('附件服务不可用')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '打开文件 季度复盘.docx' }),
    ).toBeNull();

    await user.click(
      screen.getByRole('button', {
        name: '更多文件操作 季度复盘.docx',
      }),
    );
    const menu = await screen.findByRole('menu', {
      name: '更多文件操作 季度复盘.docx',
    });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['重命名…', '删除文件卡']);
    expect(onReselect).not.toHaveBeenCalled();
  });

  it('块 payload 的 pending 快照不决定文案：local 显示本机已保存，只有同步队列显示待同步', () => {
    const { rerender } = renderCard({ syncState: 'local_only' });
    expect(screen.getByText('本机已保存')).toBeInTheDocument();
    expect(screen.queryByText('待同步')).toBeNull();

    rerender(
      <FileCardBlock
        block={fileBlock()}
        readOnly={false}
        onChangeName={vi.fn()}
        localState="local"
        syncState="pending_sync"
      />,
    );
    expect(screen.getByText('待同步')).toBeInTheDocument();
    expect(screen.queryByText('本机已保存')).toBeNull();
  });

  it('打开/另存失败时在文件行内明确报错，不伪装成功', async () => {
    const user = userEvent.setup();
    const onOpen = vi
      .fn()
      .mockRejectedValue(new Error('这条文件卡还没有关联附件，请重新选择文件'));
    renderCard({ onOpen });

    await user.click(
      screen.getByRole('button', { name: '打开文件 季度复盘.docx' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '这条文件卡还没有关联附件，请重新选择文件',
    );
  });

  it('无附件记录的旧文件卡提供“选择文件…”，状态为仅文件信息', async () => {
    const user = userEvent.setup();
    const onReselect = vi.fn();
    renderCard({
      localState: 'none',
      block: makeBlock({
        id: 'file-old',
        type: 'file',
        payload: {
          attachmentId: null,
          fileName: '旧文件.pdf',
          byteSize: 0,
          mime: 'application/pdf',
          status: 'local',
        },
      }),
      onReselect,
    });

    expect(screen.getByText('仅文件信息')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: '更多文件操作 旧文件.pdf',
      }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', {
          name: '更多文件操作 旧文件.pdf',
        }),
      ).getByRole('menuitem', { name: '选择文件…' }),
    );
    expect(onReselect).toHaveBeenCalledTimes(1);
  });

  it('只读模式不提供重命名与删除，文件名是不可编辑文本', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    renderCard({ readOnly: true, onOpen: vi.fn(), onRemove });

    expect(
      screen.queryByRole('button', { name: /重命名文件/ }),
    ).toBeNull();
    expect(screen.getByText('季度复盘.docx')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: '更多文件操作 季度复盘.docx',
      }),
    );
    const menu = await screen.findByRole('menu', {
      name: '更多文件操作 季度复盘.docx',
    });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['打开']);
    expect(onRemove).not.toHaveBeenCalled();
  });
});
