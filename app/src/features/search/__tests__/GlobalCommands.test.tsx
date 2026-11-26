import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { Topbar } from '../../../app/shell/Topbar';
import { readAppearance } from '../../../app/shell/appearance';
import { GlobalCommands } from '../GlobalCommands';
import { createFakeSearchSource } from './fixtures';
import { createFakeQuickAddSource } from '../../quickAdd/__tests__/fakeQuickAddSource';

const TODAY = '2026-10-26';

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

function renderCommands() {
  const searchSource = createFakeSearchSource();
  const quickAddSource = createFakeQuickAddSource();
  render(
    <MemoryRouter initialEntries={['/today']}>
      <Topbar
        appearance={readAppearance()}
        onAppearanceChange={() => undefined}
      />
      <GlobalCommands
        searchSource={searchSource}
        quickAddSource={quickAddSource}
        available
        today={TODAY}
      />
      <Routes>
        <Route path="/today" element={<LocationProbe />} />
        <Route path="/tasks" element={<LocationProbe />} />
        <Route path="/knowledge" element={<LocationProbe />} />
        <Route path="/calendar" element={<LocationProbe />} />
        <Route path="/habits" element={<LocationProbe />} />
        <Route path="/settings/sync" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  return { searchSource, quickAddSource };
}

describe('顶栏入口与全局快捷键', () => {
  it('顶栏搜索按钮打开 ⌘K 面板，结果深链打开对象', async () => {
    const user = userEvent.setup();
    renderCommands();

    await user.click(screen.getByRole('button', { name: '全局搜索（⌘K）' }));
    const input = await screen.findByRole('combobox', {
      name: '搜索本机数据',
    });
    await user.type(input, '复盘');
    await screen.findByRole('group', { name: '笔记' });
    await user.click(
      screen.getByRole('option', { name: /周复盘模板/ }),
    );

    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/knowledge?note=note-review',
    );
  });

  it('Ctrl+K 打开搜索；输入框里的 ? 不会打开导览；Esc 关闭', async () => {
    const user = userEvent.setup();
    renderCommands();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox', {
      name: '搜索本机数据',
    });
    await user.type(input, '?');
    expect(
      screen.queryByRole('dialog', { name: '产品导览' }),
    ).toBeNull();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: '全局搜索' }),
      ).toBeNull();
    });
  });

  it('普通区域按 ? 打开导览，先看四象限跳到 /today?view=quadrant', async () => {
    const user = userEvent.setup();
    renderCommands();

    fireEvent.keyDown(window, { key: '?', shiftKey: true });
    expect(
      await screen.findByRole('dialog', { name: '产品导览' }),
    ).toBeInTheDocument();
    expect(screen.getByText('快捷键')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '先看四象限' }));
    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/today?view=quadrant',
    );
  });

  it('Ctrl+N 打开快速创建，顶栏 ＋ 打开同一个面板', async () => {
    const user = userEvent.setup();
    const { quickAddSource } = renderCommands();

    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    const title = await screen.findByRole('textbox', { name: '任务标题' });
    await user.type(title, '用快捷键创建');
    await user.click(screen.getByRole('button', { name: '创建任务' }));

    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/today?task=task-1',
    );
    expect(quickAddSource.snapshot().tasks[0].title).toBe('用快捷键创建');

    await user.click(screen.getByRole('button', { name: '快速创建' }));
    expect(
      await screen.findByRole('dialog', { name: '快速创建' }),
    ).toBeInTheDocument();
  });

  it('同步胶囊跳到同步与网络分组', async () => {
    const user = userEvent.setup();
    renderCommands();

    await user.click(screen.getByRole('link', { name: '本机 · 已保存' }));
    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/settings/sync',
    );
  });
});
