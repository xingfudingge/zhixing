import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { SearchPalette } from '../SearchPalette';
import type { SearchSource } from '../source';
import {
  createFakeSearchSource,
  makeSearchDataset,
  TEST_TODAY,
} from './fixtures';

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

function Harness({
  source,
  available = true,
  onClose,
}: {
  source: SearchSource;
  available?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <SearchPalette
        open={open}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
        source={source}
        available={available}
        today={TEST_TODAY}
      />
      <Routes>
        <Route path="/today" element={<LocationProbe />} />
        <Route path="/tasks" element={<LocationProbe />} />
        <Route path="/knowledge" element={<LocationProbe />} />
        <Route path="/calendar" element={<LocationProbe />} />
        <Route path="/habits" element={<LocationProbe />} />
      </Routes>
    </>
  );
}

function renderPalette(options: {
  source?: SearchSource;
  available?: boolean;
  onClose?: () => void;
} = {}) {
  const source = options.source ?? createFakeSearchSource();
  const view = render(
    <MemoryRouter initialEntries={['/today']}>
      <Harness
        source={source}
        available={options.available}
        onClose={options.onClose}
      />
    </MemoryRouter>,
  );
  return { ...view, source };
}

async function search(query: string) {
  const input = await screen.findByRole('combobox', {
    name: '搜索本机数据',
  });
  const user = userEvent.setup();
  await user.type(input, query);
  return { input, user };
}

describe('⌘K 搜索面板', () => {
  it('搜「复盘」按五类分组，点击结果打开笔记深链', async () => {
    const user = userEvent.setup();
    renderPalette();

    const input = await screen.findByRole('combobox', {
      name: '搜索本机数据',
    });
    await user.type(input, '复盘');

    expect(
      await screen.findByRole('group', { name: '任务' }),
    ).toBeInTheDocument();
    for (const label of ['任务', '笔记', '事件', '倒数日', '习惯']) {
      expect(screen.getByRole('group', { name: label })).toBeInTheDocument();
    }

    const notes = screen.getByRole('group', { name: '笔记' });
    await user.click(
      within(notes).getByRole('option', { name: /周复盘模板/ }),
    );

    expect(screen.queryByRole('dialog', { name: '全局搜索' })).toBeNull();
    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/knowledge?note=note-review',
    );
  });

  it('键盘 ↑↓ 选择、↵ 打开任务；无日期任务进入任务中心', async () => {
    renderPalette();

    const { user } = await search('复盘');
    await screen.findByRole('group', { name: '任务' });

    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/today?task=task-review',
    );

    cleanup();
    renderPalette();
    const second = await search('复盘');
    await screen.findByRole('group', { name: '任务' });
    await second.user.keyboard('{ArrowDown}');
    await second.user.keyboard('{Enter}');
    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/tasks?task=task-inbox',
    );
  });

  it('空查询展示最近笔记，最近笔记也可直接打开', async () => {
    const user = userEvent.setup();
    renderPalette();

    const group = await screen.findByRole('group', { name: '最近笔记' });
    const options = within(group).getAllByRole('option');
    expect(options[0]).toHaveTextContent('周复盘模板');
    expect(
      options.some((item) => item.textContent?.includes('复盘回收站笔记')),
    ).toBe(false);

    await user.click(
      within(group).getByRole('option', { name: /周复盘模板/ }),
    );
    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/knowledge?note=note-review',
    );
  });

  it('没有结果时给出空态，并明确不搜附件、标签与 OCR', async () => {
    renderPalette();
    await search('完全不存在的关键词');
    expect(await screen.findByText('没有匹配结果')).toBeInTheDocument();
    expect(
      screen.getByText(/不含附件、标签和 OCR/),
    ).toBeInTheDocument();
  });

  it('Esc 关闭面板并归还焦点', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPalette({ onClose });

    await screen.findByRole('dialog', { name: '全局搜索' });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: '全局搜索' }),
      ).toBeNull();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('浏览器预览没有 IPC 时明确空态，不伪造结果', async () => {
    const source = createFakeSearchSource();
    renderPalette({ source, available: false });

    expect(await screen.findByText('需在桌面壳内搜索')).toBeInTheDocument();
    expect(source.loadCount()).toBe(0);
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('读取失败显示错误并可重试', async () => {
    let attempts = 0;
    const source = createFakeSearchSource(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('磁盘暂时不可读');
      }
      return makeSearchDataset();
    });
    const user = userEvent.setup();
    renderPalette({ source });

    expect(await screen.findByText('搜索读取失败')).toBeInTheDocument();
    expect(screen.getByText('磁盘暂时不可读')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('group', { name: '最近笔记' })).toBeInTheDocument();
    expect(source.loadCount()).toBe(2);
  });
});
