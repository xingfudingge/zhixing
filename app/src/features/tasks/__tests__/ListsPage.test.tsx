import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { SETTING_KEYS } from '../../../data/repositories/settings';
import {
  createDefaultSeed,
  createFakeTaskSource,
  makeList,
  type FakeTaskSource,
} from './fakeTaskSource';
import { makeDeviceSetting, renderLists } from './testUtils';

function withProjectChild(): FakeTaskSource {
  const seed = createDefaultSeed();
  return createFakeTaskSource({
    lists: [
      ...seed.lists,
      makeList({
        id: 'project-a',
        name: '项目 A',
        parentId: 'work',
        sortOrder: 15,
        color: '#3a9b9a',
        icon: 'folder',
      }),
    ],
    tasks: seed.tasks,
    notes: seed.notes,
  });
}

describe('清单页详情（唯一清单树在侧栏）', () => {
  it('/lists 显示清单管理概览，不自动打开树序第一个清单', async () => {
    const source = createFakeTaskSource();
    const view = renderLists(source, '/lists');

    expect(
      await screen.findByRole('heading', { level: 1, name: '清单管理' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('先选择清单；不会自动打开第一个清单。共 3 个清单 · 6 条未完成。'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        '清单只负责分类；任务总账在「任务」。删除清单不会删除任务。',
      ),
    ).toBeInTheDocument();

    // 概览有三张卡，没有默认选中；不会出现「工作」的任务详情。
    expect(view.container.querySelectorAll('[data-list-card]')).toHaveLength(3);
    expect(
      screen.getByRole('button', {
        name: '工作，3 条未完成，1 条已完成',
      }),
    ).toBeInTheDocument();
    expect(view.container.querySelector('[data-selected]')).toBeNull();
    expect(screen.queryByRole('region', { name: '待办' })).toBeNull();
    expect(
      screen.queryByText('完成新版产品需求文档'),
    ).not.toBeInTheDocument();

    // 页面内没有第二棵树，也没有旧的左右两栏布局。
    expect(view.container.querySelector('[data-list-tree]')).toBeNull();
    expect(view.container.querySelector('.list-tree-panel')).toBeNull();
    expect(view.container.querySelector('.lists-layout')).toBeNull();
  });

  it('概览卡片打开具体清单；只有 /lists/:id 才展示任务详情', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderLists(source, '/lists');

    await screen.findByRole('heading', { level: 1, name: '清单管理' });
    await user.click(
      screen.getByRole('button', { name: '生活，2 条未完成，1 条已完成' }),
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: '生活' }),
    ).toBeInTheDocument();
    expect(screen.getByText('交房租')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: '← 返回清单管理' }),
    ).toHaveAttribute('href', '/lists');
  });

  it('选择态不预选；选一张卡后「打开清单」才可用', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    const view = renderLists(source, '/lists?mode=select');

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: '选择要打开的清单',
      }),
    ).toBeInTheDocument();
    const openButton = screen.getByRole('button', { name: '打开清单' });
    expect(openButton).toBeDisabled();
    expect(view.container.querySelector('[data-selected]')).toBeNull();
    expect(
      screen.getByText('还没有选择清单；请点一张卡片。'),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: '工作，3 条未完成，1 条已完成' }),
    );
    expect(screen.getByText('已选「工作」')).toBeInTheDocument();
    expect(openButton).toBeEnabled();
    expect(
      view.container.querySelector('[data-list-card="work"]'),
    ).toHaveAttribute('data-selected', 'true');

    await user.click(openButton);
    expect(
      await screen.findByRole('heading', { level: 1, name: '工作' }),
    ).toBeInTheDocument();
  });

  it('选择态按 Esc 退出，回到概览且不打开任何清单', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderLists(source, '/lists?mode=select');

    await screen.findByRole('heading', {
      level: 1,
      name: '选择要打开的清单',
    });
    await user.keyboard('{Escape}');

    expect(
      await screen.findByRole('heading', { level: 1, name: '清单管理' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '待办' })).toBeNull();
  });

  it('概览卡片菜单可编辑 / 删除，删除后仍停留概览', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderLists(source, '/lists');

    await screen.findByRole('heading', { level: 1, name: '清单管理' });
    await user.click(screen.getByRole('button', { name: '管理清单：阅读' }));
    await user.click(await screen.findByRole('menuitem', { name: '删除清单' }));

    const dialog = await screen.findByRole('dialog', { name: '删除清单' });
    expect(dialog).toHaveTextContent(/删除「阅读」清单/);
    await user.click(within(dialog).getByRole('button', { name: '删除清单' }));

    expect(
      await screen.findByText('清单已删除，1 个任务已移到未安排'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: '清单管理' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /阅读/ }),
    ).not.toBeInTheDocument();
  });

  it('清单详情按待办 / 进行中 / 已完成分组，空组不渲染，任务不重复', async () => {
    const source = createFakeTaskSource();
    renderLists(source, '/lists/life');

    const todo = await screen.findByRole('region', { name: '待办' });
    const done = screen.getByRole('region', { name: '已完成' });

    expect(within(todo).getByText('交房租')).toBeInTheDocument();
    expect(within(todo).getByText('整理旅行清单')).toBeInTheDocument();
    expect(within(done).getByText('买咖啡豆')).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: '进行中' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: '以后' }),
    ).not.toBeInTheDocument();

    expect(screen.getAllByText('交房租')).toHaveLength(1);
    expect(screen.getAllByText('整理旅行清单')).toHaveLength(1);
    expect(screen.getAllByText('买咖啡豆')).toHaveLength(1);
  });

  it('完成后移出：清单活动视图隐藏已完成组，撤销后回到原分组', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource({
      settings: [
        makeDeviceSetting(SETTING_KEYS.taskCompletionBehavior, 'remove'),
      ],
    });
    renderLists(source, '/lists/work');
    await screen.findByRole('heading', { level: 1, name: '工作' });

    expect(
      screen.queryByRole('region', { name: '已完成' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('回复合作方邮件')).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: '完成任务：完成新版产品需求文档',
      }),
    );
    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-review')
          ?.status,
      ).toBe('done');
    });
    expect(
      screen.queryByRole('region', { name: '已完成' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('完成新版产品需求文档'),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-review')
          ?.status,
      ).toBe('todo');
    });
    expect(
      await screen.findByText('完成新版产品需求文档'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: '已完成' }),
    ).not.toBeInTheDocument();
  });

  it('完成后移出：清单全部完成时提示去任务中心查看，而不是误报没有任务', async () => {
    const seed = createDefaultSeed();
    const source = createFakeTaskSource({
      settings: [
        makeDeviceSetting(SETTING_KEYS.taskCompletionBehavior, 'remove'),
      ],
      tasks: [
        ...seed.tasks.filter((task) => task.listId !== 'reading'),
        {
          ...seed.tasks.find((task) => task.id === 'task-reading')!,
          status: 'done' as const,
          completedAt: '2026-10-26T03:00:00.000Z',
        },
      ],
    });
    renderLists(source, '/lists/reading');

    expect(
      await screen.findByRole('heading', { name: '没有未完成任务' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/已完成 1 条已按「完成后移出」设置隐藏/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: '查看已完成' }),
    ).toHaveAttribute('href', '/tasks?filter=done');
  });

  it('清单行内可把待办改为进行中，状态胶囊与任务中心同源', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderLists(source, '/lists/work');
    await screen.findByRole('heading', { level: 1, name: '工作' });

    const row = screen
      .getByText('完成新版产品需求文档')
      .closest<HTMLElement>('[data-task-id]');
    if (!row) {
      throw new Error('找不到任务行');
    }

    await user.click(
      within(row).getByRole('button', {
        name: '任务状态：待办，点击修改',
      }),
    );
    await user.click(
      screen.getByRole('menuitemradio', { name: /进行中/ }),
    );

    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-review')
          ?.status,
      ).toBe('doing');
    });
    const doingGroup = screen.getByRole('region', { name: '进行中' });
    const movedRow = within(doingGroup)
      .getByText('完成新版产品需求文档')
      .closest<HTMLElement>('[data-task-id]');
    expect(movedRow).not.toBeNull();
    expect(
      within(movedRow as HTMLElement).getByRole('button', {
        name: '任务状态：进行中，点击修改',
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: '待办' })).queryByText(
        '完成新版产品需求文档',
      ),
    ).not.toBeInTheDocument();
  });

  it('子清单深链显示父级面包屑、名称和编辑/删除/新任务入口', async () => {
    const source = withProjectChild();
    const view = renderLists(source, '/lists/project-a');

    expect(
      await screen.findByRole('heading', { level: 1, name: '项目 A' }),
    ).toBeInTheDocument();
    const breadcrumb = screen.getByRole('navigation', { name: '清单路径' });
    expect(
      within(breadcrumb).getByRole('link', { name: '全部清单' }),
    ).toHaveAttribute('href', '/lists');
    expect(
      within(breadcrumb).getByRole('link', { name: '工作' }),
    ).toHaveAttribute('href', '/lists/work');
    expect(within(breadcrumb).getByText('项目 A')).toHaveAttribute(
      'aria-current',
      'page',
    );

    expect(screen.getByRole('button', { name: '编辑清单' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除清单' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '＋ 新任务' })).toBeInTheDocument();
    expect(view.container.querySelector('[data-list-tree]')).toBeNull();
  });

  it('删除父清单：子清单上移、任务进收件箱，确认文案含数量', async () => {
    const user = userEvent.setup();
    const source = withProjectChild();
    renderLists(source, '/lists/work');
    await screen.findByRole('heading', { level: 1, name: '工作' });

    await user.click(screen.getByRole('button', { name: '删除清单' }));
    const dialog = await screen.findByRole('dialog', { name: '删除清单' });
    expect(dialog).toHaveTextContent(
      /4 个任务会移到未安排，1 个子清单会上移一级/,
    );

    await user.click(within(dialog).getByRole('button', { name: '删除清单' }));

    await waitFor(() => {
      const snapshot = source.snapshot();
      const work = snapshot.lists.find((item) => item.id === 'work');
      expect(work?.deletedAt).not.toBeNull();
      const child = snapshot.lists.find((item) => item.id === 'project-a');
      expect(child?.parentId).toBeNull();
      for (const id of ['task-review', 'task-design', 'task-weekly', 'task-mail']) {
        expect(snapshot.tasks.find((task) => task.id === id)?.listId).toBe(
          'inbox',
        );
      }
      expect(
        snapshot.tasks.find((task) => task.id === 'task-overdue')?.listId,
      ).toBe('life');
    });

    expect(
      await screen.findByText(
        '清单已删除，4 个任务已移到未安排，1 个子清单已上移',
      ),
    ).toBeInTheDocument();
    // 删除当前清单回到管理概览，不自动打开项目 A / 生活 / 阅读中的任何一个。
    expect(
      await screen.findByRole('heading', { level: 1, name: '清单管理' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '项目 A，0 条未完成，0 条已完成' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '待办' })).toBeNull();
    expect(
      screen.queryByText('和设计师确认首页信息架构'),
    ).not.toBeInTheDocument();
  });

  it('打开系统 capture 清单会被导向任务中心未安排筛选，不提供删除入口', async () => {
    const source = createFakeTaskSource();
    renderLists(source, '/lists/inbox', '2026-10-26');

    expect(await screen.findByText('任务中心页面')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '删除清单' }),
    ).not.toBeInTheDocument();
  });

  it('侧栏“新建清单”查询参数打开新建弹层，保存后进入新清单', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderLists(source, '/lists?new=root');

    const dialog = await screen.findByRole('dialog', { name: '新建清单' });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      '请先写清单名称',
    );

    await user.type(within(dialog).getByLabelText('名称'), '工作');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      '同一父级下已存在同名清单',
    );

    await user.clear(within(dialog).getByLabelText('名称'));
    await user.type(within(dialog).getByLabelText('名称'), '学习');
    await user.click(
      within(dialog).getByRole('button', { name: '颜色：青色' }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: '图标：星标' }),
    );
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(
      await screen.findByRole('heading', { name: '学习' }),
    ).toBeInTheDocument();
    const created = source
      .snapshot()
      .lists.find((list) => list.name === '学习');
    expect(created?.color).toBe('#3a9b9a');
    expect(created?.icon).toBe('star');
    expect(created?.parentId).toBeNull();
    expect(created?.deletedAt).toBeNull();
  });

  it('侧栏“新建子清单”查询参数打开子清单弹层并绑定父级', async () => {
    const user = userEvent.setup();
    const source = withProjectChild();
    renderLists(source, '/lists/work?newChild=project-a');

    const dialog = await screen.findByRole('dialog', {
      name: '新建子清单',
    });
    const nameInput = within(dialog).getByLabelText('名称');
    await user.type(nameInput, '子项目');
    await user.click(
      within(dialog).getByRole('button', { name: '图标：文件夹' }),
    );
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: '子项目' }),
    ).toBeInTheDocument();
    const child = source
      .snapshot()
      .lists.find((list) => list.name === '子项目');
    expect(child?.parentId).toBe('project-a');
    expect(child?.icon).toBe('folder');
  });

  it('侧栏“移动到…”查询参数打开移动弹层，Esc 取消无变化', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    const view = renderLists(source, '/lists/reading?move=reading');

    await screen.findByRole('dialog', {
      name: '移动「阅读」',
    });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: '移动「阅读」' }),
      ).not.toBeInTheDocument();
    });
    expect(
      source.snapshot().lists.find((list) => list.id === 'reading')?.parentId,
    ).toBeNull();
    view.unmount();

    renderLists(source, '/lists/reading?move=reading');
    const nextDialog = await screen.findByRole('dialog', {
      name: '移动「阅读」',
    });
    await user.selectOptions(
      within(nextDialog).getByLabelText('移动到'),
      'life',
    );
    await user.click(within(nextDialog).getByRole('button', { name: '移动' }));

    await waitFor(() => {
      expect(
        source.snapshot().lists.find((list) => list.id === 'reading')?.parentId,
      ).toBe('life');
    });
    expect(await screen.findByText('已移动「阅读」')).toBeInTheDocument();
  });

  it('编辑清单名称、颜色与图标后立即生效', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderLists(source, '/lists/reading');
    await screen.findByRole('heading', { name: '阅读' });

    await user.click(screen.getByRole('button', { name: '编辑清单' }));
    const dialog = await screen.findByRole('dialog', { name: '编辑清单' });
    await user.clear(within(dialog).getByLabelText('名称'));
    await user.type(within(dialog).getByLabelText('名称'), '读书');
    await user.click(
      within(dialog).getByRole('button', { name: '颜色：绿色' }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: '图标：书' }),
    );
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(
      await screen.findByRole('heading', { name: '读书' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      const list = source
        .snapshot()
        .lists.find((item) => item.id === 'reading');
      expect(list?.name).toBe('读书');
      expect(list?.color).toBe('#2f9e73');
      expect(list?.icon).toBe('book');
    });
  });

  it('没有用户清单时只显示页面空态，不补偿第二棵树', async () => {
    const seed = createDefaultSeed();
    const source = createFakeTaskSource({
      lists: seed.lists.filter((list) => list.isInbox),
      tasks: [],
      notes: [],
    });
    const view = renderLists(source, '/lists');
    expect(
      await screen.findByRole('heading', { level: 1, name: '清单管理' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('还没有清单').length).toBeGreaterThan(0);
    expect(
      screen.queryByRole('link', { name: /收件箱/ }),
    ).not.toBeInTheDocument();
    expect(view.container.querySelector('[data-list-tree]')).toBeNull();
  });

  it('不存在的清单显示可返回的空态，不回退到第一个清单', async () => {
    const source = createFakeTaskSource();
    renderLists(source, '/lists/missing-list');

    expect(
      await screen.findByRole('heading', {
        name: '这个清单不存在或已被删除',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: '返回清单管理' }),
    ).toHaveAttribute('href', '/lists');
    expect(screen.queryByRole('region', { name: '待办' })).toBeNull();
    expect(
      screen.queryByText('完成新版产品需求文档'),
    ).not.toBeInTheDocument();
  });
});
