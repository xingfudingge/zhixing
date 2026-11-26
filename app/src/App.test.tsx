import {
  act,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import { APPEARANCE_STORAGE_KEY } from './app/shell/appearance';

const NAV_ROUTES = [
  { path: '/today', label: '今天' },
  { path: '/tasks', label: '全部任务', navLabel: '任务' },
  { path: '/calendar', label: '日历' },
  { path: '/habits', label: '习惯' },
  { path: '/focus', label: '专注' },
  { path: '/review', label: '复盘' },
  { path: '/lists', label: '清单管理', navLabel: '管理清单' },
  { path: '/knowledge', label: '知识' },
  { path: '/settings/appearance', label: '设置' },
];

const SETTINGS_GROUPS = [
  'appearance',
  'task',
  'calendar',
  'notify',
  'ocr',
  'privacy',
  'sync',
  'data',
];

function resetShellState() {
  window.history.replaceState({}, '', '/');
  window.localStorage.clear();
  const root = document.documentElement;
  for (const attribute of [
    'data-theme',
    'data-theme-preference',
    'data-accent',
    'data-density',
  ]) {
    root.removeAttribute(attribute);
  }
}

beforeEach(() => {
  resetShellState();
});

describe('知行全局外壳与路由', () => {
  it('从根路径重定向到 /today，并保留 P0-01 的本地库探针', async () => {
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: '今天' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/today');
    expect(screen.getByText('工程骨架')).toBeInTheDocument();
    expect(screen.getByLabelText('本地库状态')).toHaveTextContent(
      '浏览器预览',
    );
    expect(
      await screen.findByText('需在桌面壳内使用任务库'),
    ).toBeInTheDocument();
  });

  it('根路径始终进入今天，不恢复上次停留的任务页', async () => {
    const user = userEvent.setup();
    const firstLaunch = render(<App />);

    await screen.findByRole('heading', { level: 1, name: '今天' });
    await user.click(screen.getByRole('link', { name: '任务' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: '全部任务' }),
    ).toBeInTheDocument();
    firstLaunch.unmount();

    // 模拟重新启动：历史记录同时存在任务页与根路径，根路径仍应落到今天。
    window.history.replaceState({}, '', '/tasks');
    window.history.replaceState({}, '', '/');
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: '今天' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/today');
    expect(screen.getByRole('link', { name: '今天' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('侧栏顺序为 今天 → 任务 → 日历，清单树位于任务分组与节奏之间', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: '今天' });

    const nav = screen.getByRole('navigation', { name: '主导航' });
    const navGroups = nav.querySelector('.nav-groups');
    expect(navGroups).not.toBeNull();

    const groups = Array.from(navGroups!.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement &&
        element.classList.contains('nav-group'),
    );

    // 工作台、清单、节奏、知识；设置单独固定在底部。
    expect(groups).toHaveLength(4);
    expect(groups[1]).toHaveClass('nav-group--lists');
    expect(groups[1]).toHaveTextContent('清单');
    expect(groups[2]).toHaveTextContent('节奏');
    expect(groups[3]).toHaveTextContent('知识');
    expect(groups[3]).not.toHaveTextContent('画板');

    const workspaceLabels = Array.from(
      groups[0]!.querySelectorAll('.nav-label'),
    ).map((label) => label.textContent);
    expect(workspaceLabels).toEqual(['今天', '任务', '日历']);

    expect(
      within(groups[0]!).getByRole('link', { name: '今天' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      within(groups[0]!).getByRole('link', { name: '任务' }),
    ).toHaveAttribute('href', '/tasks');
    expect(
      within(groups[0]!).getByRole('link', { name: '日历' }),
    ).toHaveAttribute('href', '/calendar');
  });

  it('从任务页可经侧栏回到今天，两个入口始终可点击', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/tasks');
    render(<App />);

    await screen.findByRole('heading', { level: 1, name: '全部任务' });
    const todayLink = screen.getByRole('link', { name: '今天' });
    expect(todayLink).toHaveAttribute('href', '/today');

    await user.click(todayLink);

    expect(
      await screen.findByRole('heading', { level: 1, name: '今天' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/today');
    expect(screen.getByRole('link', { name: '任务' })).toHaveAttribute(
      'href',
      '/tasks',
    );
  });

  it.each(NAV_ROUTES)(
    '空路由 $path 可直接访问、刷新保持 URL 且导航高亮',
    async ({ path, label, navLabel }) => {
      window.history.replaceState({}, '', path);
      render(<App />);

      expect(
        await screen.findByRole('heading', { level: 1, name: label }),
      ).toBeInTheDocument();
      expect(window.location.pathname).toBe(path);

      const link = screen.getByRole('link', { name: navLabel ?? label });
      expect(link).toHaveAttribute('aria-current', 'page');
      expect(link).toHaveAttribute('href', path);
    },
  );

  it('点击侧栏从今天切换到任务，并同步 URL 与高亮', async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole('heading', { level: 1, name: '今天' });
    await user.click(screen.getByRole('link', { name: '任务' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: '全部任务' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/tasks');
    expect(screen.getAllByRole('link', { name: '任务' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: '任务' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: '今天' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('/lists 进入清单管理概览，只保留侧栏一棵清单树', async () => {
    window.history.replaceState({}, '', '/lists');
    const view = render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: '清单管理' }),
    ).toBeInTheDocument();
    expect(view.container.querySelectorAll('[data-list-tree]')).toHaveLength(1);
    expect(
      view.container.querySelector('.list-tree-panel--page'),
    ).toBeNull();
    expect(view.container.querySelector('.lists-layout')).toBeNull();
  });

  it('/inbox 兼容重定向到 /tasks，不保留第二个入口', async () => {
    window.history.replaceState({}, '', '/inbox');
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: '全部任务' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/tasks');
    expect(screen.getByRole('link', { name: '任务' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      screen.queryByRole('link', { name: /^收件箱/ }),
    ).not.toBeInTheDocument();
  });

  it('画板不再是导航项，/board 兼容重定向到 /knowledge', async () => {
    window.history.replaceState({}, '', '/board');
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: '知识' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/knowledge');
    expect(
      screen.queryByRole('link', { name: '画板' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '知识' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('/board/:boardId 保留为笔记内全屏编辑深链', async () => {
    window.history.replaceState({}, '', '/board/board-1?note=note-1');
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: '画板' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/board/board-1');
    expect(window.location.search).toBe('?note=note-1');
    expect(
      screen.queryByRole('link', { name: '画板' }),
    ).not.toBeInTheDocument();
  });

  it('/settings 重定向到外观分组，设置入口在所有分组下保持高亮', async () => {
    window.history.replaceState({}, '', '/settings');
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: '设置' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings/appearance');
    expect(screen.getByRole('link', { name: '设置' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it.each(SETTINGS_GROUPS)(
    '设置分组 /settings/%s 可访问且保持设置导航高亮',
    async (group) => {
      window.history.replaceState({}, '', `/settings/${group}`);
      render(<App />);

      expect(
        await screen.findByRole('heading', { level: 1, name: '设置' }),
      ).toBeInTheDocument();
      expect(window.location.pathname).toBe(`/settings/${group}`);
      expect(screen.getByRole('link', { name: '设置' })).toHaveAttribute(
        'aria-current',
        'page',
      );
    },
  );

  it('未知设置分组回到外观分组', async () => {
    window.history.replaceState({}, '', '/settings/not-a-group');
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: '设置' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings/appearance');
  });

  it('未知路由回到 /today，而不是白屏或 404', async () => {
    window.history.replaceState({}, '', '/not-a-route');
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: '今天' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/today');
    expect(screen.getByRole('link', { name: '今天' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it.each([
    { path: '/knowledge', label: '知识' },
  ])('$path 使用全高工作区，隐藏全局顶栏但保留左侧导航', async ({ path, label }) => {
    window.history.replaceState({}, '', path);
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: label }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(
      screen.getByRole('complementary', { name: '全局导航' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('navigation', { name: '主导航' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: label })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText('全高工作区 · 顶栏隐藏')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('普通页面显示搜索、快速创建、同步与导览入口', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: '今天' });

    expect(
      screen.getByRole('button', { name: '全局搜索（⌘K）' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '快速创建' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '产品导览' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '本机 · 已保存' })).toHaveAttribute(
      'href',
      '/settings/sync',
    );
  });

  it('顶栏搜索、快速创建与导览按钮打开对应面板，Esc 关闭', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: '今天' });

    await user.click(screen.getByRole('button', { name: '全局搜索（⌘K）' }));
    expect(
      await screen.findByRole('dialog', { name: '全局搜索' }),
    ).toBeInTheDocument();
    expect(screen.getByText('需在桌面壳内搜索')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: '全局搜索' }),
      ).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: '快速创建' }));
    expect(
      await screen.findByRole('dialog', { name: '快速创建' }),
    ).toBeInTheDocument();
    expect(screen.getByText('需在桌面壳内快速创建')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: '快速创建' }),
      ).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: '产品导览' }));
    expect(
      await screen.findByRole('dialog', { name: '产品导览' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '先看四象限' }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: '产品导览' }),
      ).not.toBeInTheDocument();
    });
  });

  it('外观菜单切换深色、强调色与密度，并写入本机偏好', async () => {
    const user = userEvent.setup();
    const root = document.documentElement;
    render(<App />);

    await screen.findByRole('heading', { level: 1, name: '今天' });
    expect(root).toHaveAttribute('data-theme', 'light');
    expect(root).toHaveAttribute('data-accent', 'blue');
    expect(root).toHaveAttribute('data-density', 'comfortable');

    await user.click(screen.getByRole('button', { name: '外观设置' }));
    const dialog = await screen.findByRole('dialog', { name: '外观设置' });

    await user.click(within(dialog).getByRole('button', { name: '深色' }));
    expect(root).toHaveAttribute('data-theme', 'dark');
    expect(root).toHaveAttribute('data-theme-preference', 'dark');

    await user.click(
      within(dialog).getByRole('button', { name: '强调色：紫色' }),
    );
    expect(root).toHaveAttribute('data-accent', 'violet');

    await user.click(within(dialog).getByRole('button', { name: '紧凑' }));
    expect(root).toHaveAttribute('data-density', 'compact');

    expect(
      JSON.parse(
        window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? 'null',
      ),
    ).toEqual({
      theme: 'dark',
      accent: 'violet',
      density: 'compact',
    });
  });

  it('跟随系统时监听系统深浅色变化', async () => {
    let systemDark = true;
    const listeners = new Set<() => void>();

    const addEventListener = vi.fn(
      (_event: string, listener: EventListenerOrEventListenerObject) => {
        listeners.add(() => {
          if (typeof listener === 'function') {
            listener(new Event('change'));
          } else {
            listener.handleEvent(new Event('change'));
          }
        });
      },
    );

    const mediaQueryList = {
      get matches() {
        return systemDark;
      },
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener,
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList;

    vi.stubGlobal('matchMedia', vi.fn(() => mediaQueryList));
    window.localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ theme: 'auto', accent: 'blue', density: 'comfortable' }),
    );

    try {
      render(<App />);
      await screen.findByRole('heading', { level: 1, name: '今天' });

      const root = document.documentElement;
      expect(root).toHaveAttribute('data-theme', 'dark');
      expect(root).toHaveAttribute('data-theme-preference', 'auto');

      await act(async () => {
        systemDark = false;
        for (const listener of listeners) {
          listener();
        }
      });

      expect(root).toHaveAttribute('data-theme', 'light');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('渲染与路由切换过程中不产生 console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();

    try {
      render(<App />);
      await screen.findByRole('heading', { level: 1, name: '今天' });
      await user.click(screen.getByRole('link', { name: '知识' }));
      await screen.findByRole('heading', { level: 1, name: '知识' });
      await user.click(screen.getByRole('link', { name: '设置' }));
      await screen.findByRole('heading', { level: 1, name: '设置' });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
