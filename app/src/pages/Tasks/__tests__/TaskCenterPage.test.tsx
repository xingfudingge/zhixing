import {
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { SETTING_KEYS } from '../../../data/repositories/settings';
import {
  createDefaultSeed,
  createFakeTaskSource,
  makeList,
  makeTask,
  type FakeTaskSource,
} from '../../../features/tasks/__tests__/fakeTaskSource';
import {
  makeDeviceSetting,
  renderTasks,
} from '../../../features/tasks/__tests__/testUtils';
import { clearDate, pickDate, typeDate } from '../../../test/datePicker';

function taskRow(title: string): HTMLElement {
  const row = screen.getByText(title).closest<HTMLElement>('[data-task-id]');
  if (!row) {
    throw new Error(`找不到任务行：${title}`);
  }
  return row;
}

async function openUndated(source: FakeTaskSource) {
  const view = renderTasks(source, '/tasks?filter=undated');
  await screen.findByText('记一个想法：把日历和笔记连起来');
  return view;
}

function cloneSeedWith(
  overrides: Partial<ReturnType<typeof createDefaultSeed>>,
) {
  const seed = createDefaultSeed();
  return createFakeTaskSource({
    lists: overrides.lists ?? seed.lists,
    tasks: overrides.tasks ?? seed.tasks,
    notes: seed.notes,
  });
}

describe('任务中心：范围、分组与筛选', () => {
  it('默认展示全部未完成，按逾期/今天/本周/以后/未安排分组，不含已完成', async () => {
    renderTasks(createFakeTaskSource());

    expect(
      await screen.findByRole('heading', { level: 1, name: '全部任务' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('共 9 条 · 未完成 7 · 已完成 2'),
    ).toBeInTheDocument();

    const overdue = screen.getByRole('region', { name: '逾期' });
    expect(within(overdue).getByText('交房租')).toBeInTheDocument();

    const today = screen.getByRole('region', { name: '今天' });
    expect(within(today).getByText('完成新版产品需求文档')).toBeInTheDocument();
    expect(within(today).getByText('和设计师确认首页信息架构')).toBeInTheDocument();
    expect(within(today).getByText('读《设计中的设计》第二章')).toBeInTheDocument();

    const week = screen.getByRole('region', { name: '本周' });
    expect(within(week).getByText('准备周会材料')).toBeInTheDocument();

    expect(screen.queryByRole('region', { name: '以后' })).not.toBeInTheDocument();

    const undated = screen.getByRole('region', { name: '未安排' });
    expect(
      within(undated).getByText('记一个想法：把日历和笔记连起来'),
    ).toBeInTheDocument();
    expect(within(undated).getByText('整理旅行清单')).toBeInTheDocument();

    expect(screen.queryByText('买咖啡豆')).not.toBeInTheDocument();
    expect(screen.queryByText('回复合作方邮件')).not.toBeInTheDocument();
  });

  it('筛选区只保留状态行，不再渲染任务范围 tablist', async () => {
    renderTasks(createFakeTaskSource());
    await screen.findByText('交房租');

    expect(
      screen.queryByRole('tablist', { name: '任务范围' }),
    ).not.toBeInTheDocument();
    const tablists = screen.getAllByRole('tablist');
    expect(tablists).toHaveLength(1);
    expect(tablists[0]).toHaveAccessibleName('任务状态');
    expect(within(tablists[0]).getAllByRole('tab')).toHaveLength(4);
  });

  it('状态标签：三态计数、筛选即时生效，空结果给「查看全部」', async () => {
    const user = userEvent.setup();
    renderTasks(createFakeTaskSource());
    await screen.findByText('交房租');

    const statuses = screen.getByRole('tablist', { name: '任务状态' });
    expect(
      within(statuses).getByRole('tab', { name: /全部/ }),
    ).toHaveTextContent('7');
    expect(
      within(statuses).getByRole('tab', { name: /待办/ }),
    ).toHaveTextContent('6');
    expect(
      within(statuses).getByRole('tab', { name: /进行中/ }),
    ).toHaveTextContent('1');
    expect(
      within(statuses).getByRole('tab', { name: /已完成/ }),
    ).toHaveTextContent('0');

    await user.click(within(statuses).getByRole('tab', { name: /进行中/ }));
    expect(
      within(statuses).getByRole('tab', { name: /进行中/ }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('和设计师确认首页信息架构')).toBeInTheDocument();
    expect(
      screen.queryByText('完成新版产品需求文档'),
    ).not.toBeInTheDocument();

    await user.click(within(statuses).getByRole('tab', { name: /已完成/ }));
    expect(
      await screen.findByRole('heading', {
        name: '没有「已完成」的任务',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('和设计师确认首页信息架构'),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看全部' }));
    expect(
      within(statuses).getByRole('tab', { name: /全部/ }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(
      await screen.findByText('和设计师确认首页信息架构'),
    ).toBeInTheDocument();
  });

  it('完成后移出设置不影响任务中心「已完成」筛选与搜索', async () => {
    const source = createFakeTaskSource({
      settings: [
        makeDeviceSetting(SETTING_KEYS.taskCompletionBehavior, 'remove'),
      ],
    });

    const doneView = renderTasks(source, '/tasks?filter=done');
    expect(await screen.findByText('买咖啡豆')).toBeInTheDocument();
    expect(screen.getByText('回复合作方邮件')).toBeInTheDocument();
    doneView.unmount();

    renderTasks(source, '/tasks?filter=done&q=咖啡');
    expect(await screen.findByText('买咖啡豆')).toBeInTheDocument();
    expect(screen.queryByText('回复合作方邮件')).not.toBeInTheDocument();
  });

  it('status 深链筛选进行中；非法 status 归一为全部', async () => {
    const first = renderTasks(
      createFakeTaskSource(),
      '/tasks?status=doing',
    );
    expect(
      await screen.findByRole('tab', { name: /进行中/ }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('和设计师确认首页信息架构')).toBeInTheDocument();
    expect(
      screen.queryByText('完成新版产品需求文档'),
    ).not.toBeInTheDocument();
    first.unmount();

    renderTasks(createFakeTaskSource(), '/tasks?status=blocked');
    const statuses = await screen.findByRole('tablist', {
      name: '任务状态',
    });
    expect(
      await within(statuses).findByRole('tab', { name: /^全部/ }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('完成新版产品需求文档')).toBeInTheDocument();
  });

  it('清单筛选包含全部后代，不包含兄弟清单', async () => {
    const seed = createDefaultSeed();
    const source = createFakeTaskSource({
      lists: [
        ...seed.lists,
        makeList({
          id: 'project-a',
          name: '项目 A',
          parentId: 'work',
          sortOrder: 15,
        }),
      ],
      tasks: [
        ...seed.tasks,
        makeTask({
          id: 'task-project',
          title: '项目内任务',
          listId: 'project-a',
          dueDate: '2026-10-26',
        }),
      ],
      notes: seed.notes,
    });
    renderTasks(source, '/tasks?list=work');

    expect(await screen.findByText('项目内任务')).toBeInTheDocument();
    expect(screen.getByText('完成新版产品需求文档')).toBeInTheDocument();
    expect(screen.queryByText('交房租')).not.toBeInTheDocument();
    expect(screen.queryByText('整理旅行清单')).not.toBeInTheDocument();
  });

  it('优先级 0 是有效筛选值，日期筛选只保留对应组', async () => {
    const priorityView = renderTasks(
      createFakeTaskSource(),
      '/tasks?priority=3',
    );
    expect(await screen.findByText('完成新版产品需求文档')).toBeInTheDocument();
    expect(screen.queryByText('交房租')).not.toBeInTheDocument();
    priorityView.unmount();

    const dateView = renderTasks(
      createFakeTaskSource(),
      '/tasks?date=overdue',
    );
    expect(await screen.findByText('交房租')).toBeInTheDocument();
    expect(screen.queryByText('完成新版产品需求文档')).not.toBeInTheDocument();
    dateView.unmount();

    renderTasks(createFakeTaskSource(), '/tasks?priority=0');
    expect(await screen.findByText('整理旅行清单')).toBeInTheDocument();
    expect(screen.queryByText('交房租')).not.toBeInTheDocument();
  });

  it('搜索标题与备注；备注命中显示「备注命中」', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderTasks(source);
    await screen.findByText('交房租');

    const search = screen.getByLabelText('搜索任务标题或备注');
    await user.type(search, '收敛');

    expect(await screen.findByText('备注命中')).toBeInTheDocument();
    expect(screen.getByText('完成新版产品需求文档')).toBeInTheDocument();
    expect(screen.queryByText('交房租')).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, '周会');
    expect(await screen.findByText('准备周会材料')).toBeInTheDocument();
    expect(screen.queryByText('完成新版产品需求文档')).not.toBeInTheDocument();
  });

  it('筛选无结果时给出清除筛选空态', async () => {
    renderTasks(createFakeTaskSource(), '/tasks?q=不存在');

    expect(
      await screen.findByRole('heading', { name: '没有匹配的任务' }),
    ).toBeInTheDocument();
    const emptyCard = screen
      .getByRole('heading', { name: '没有匹配的任务' })
      .closest('.task-empty-card');
    expect(emptyCard).not.toBeNull();
    expect(
      within(emptyCard as HTMLElement).getByRole('button', {
        name: '清除筛选',
      }),
    ).toBeInTheDocument();
  });
});

describe('任务中心：单条操作', () => {
  it('未安排行可 triage 到今天 / 明天 / 工作', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    const view = await openUndated(source);

    await user.click(
      within(taskRow('记一个想法：把日历和笔记连起来')).getByRole('button', {
        name: '今天',
      }),
    );
    await waitFor(() => {
      const task = source
        .snapshot()
        .tasks.find((item) => item.id === 'task-idea');
      expect(task?.dueDate).toBe('2026-10-26');
      expect(task?.listId).toBe('work');
    });
    expect(await screen.findByText('已安排到今天')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByText('记一个想法：把日历和笔记连起来'),
      ).not.toBeInTheDocument();
    });

    await user.click(
      within(taskRow('整理旅行清单')).getByRole('button', { name: '明天' }),
    );
    await waitFor(() => {
      const task = source
        .snapshot()
        .tasks.find((item) => item.id === 'task-travel');
      expect(task?.dueDate).toBe('2026-10-27');
      expect(task?.listId).toBe('life');
    });
    expect(await screen.findByText(/已安排到明天/)).toBeInTheDocument();
    view.unmount();
  });

  it('未安排行 triage 到工作清单', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    await openUndated(source);

    await user.click(
      within(taskRow('整理旅行清单')).getByRole('button', { name: '工作' }),
    );
    await waitFor(() => {
      const task = source
        .snapshot()
        .tasks.find((item) => item.id === 'task-travel');
      expect(task?.listId).toBe('work');
      expect(task?.dueDate).toBe('2026-10-26');
    });
    expect(
      await screen.findByText('已移到工作，并安排到今天'),
    ).toBeInTheDocument();
  });

  it('详情改日期不改变清单；清空日期只回到未安排', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    const view = renderTasks(
      source,
      '/tasks?filter=undated&task=task-idea',
    );

    const titleInput = await screen.findByLabelText('标题');
    expect(titleInput).toHaveValue('记一个想法：把日历和笔记连起来');
    const detail = screen.getByRole('complementary', { name: '任务详情' });
    const list = within(detail).getByLabelText('清单');
    expect(within(list).getByRole('option', { name: '未安排' })).toBeDisabled();

    await pickDate(user, within(detail).getByLabelText('日期'), '2026-10-26');
    await waitFor(() => {
      const task = source
        .snapshot()
        .tasks.find((item) => item.id === 'task-idea');
      expect(task?.dueDate).toBe('2026-10-26');
      expect(task?.listId).toBe('inbox');
    });
    expect(await screen.findByText('日期已更新')).toBeInTheDocument();
    view.unmount();

    const second = createFakeTaskSource();
    renderTasks(second, '/tasks?task=task-review');
    const secondDate = await screen.findByLabelText('日期');
    const secondDetail = screen.getByRole('complementary', {
      name: '任务详情',
    });
    expect(
      within(secondDetail).queryByRole('option', { name: '未安排' }),
    ).not.toBeInTheDocument();
    await clearDate(user, secondDate);
    await waitFor(() => {
      const task = second
        .snapshot()
        .tasks.find((item) => item.id === 'task-review');
      expect(task?.dueDate).toBeNull();
      expect(task?.listId).toBe('work');
    });
    expect(await screen.findByText('已移到未安排')).toBeInTheDocument();
  });

  it('未安排任务在详情中可直接改清单，日期仍为空', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderTasks(source, '/tasks?filter=undated&task=task-idea');
    await screen.findByLabelText('标题');
    const detail = screen.getByRole('complementary', {
      name: '任务详情',
    });

    await user.selectOptions(within(detail).getByLabelText('清单'), 'work');
    await waitFor(() => {
      const task = source
        .snapshot()
        .tasks.find((item) => item.id === 'task-idea');
      expect(task?.listId).toBe('work');
      expect(task?.dueDate).toBeNull();
    });
    expect(await screen.findByText('清单已更新')).toBeInTheDocument();
  });

  it('完成 / 撤销完成即时刷新计数', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderTasks(source);
    await screen.findByText('交房租');

    expect(
      screen.getByText('共 9 条 · 未完成 7 · 已完成 2'),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: '完成任务：完成新版产品需求文档',
      }),
    );
    await waitFor(() => {
      expect(
        source
          .snapshot()
          .tasks.find((item) => item.id === 'task-review')?.status,
      ).toBe('done');
    });
    expect(
      await screen.findByText(/已完成「完成新版产品需求文档」/, {
        selector: '.task-toast span',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('共 9 条 · 未完成 6 · 已完成 3'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByText('完成新版产品需求文档'),
      ).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => {
      expect(
        source
          .snapshot()
          .tasks.find((item) => item.id === 'task-review')?.status,
      ).toBe('todo');
    });
    expect(await screen.findByText('已恢复为待办')).toBeInTheDocument();
    expect(
      await screen.findByText('共 9 条 · 未完成 7 · 已完成 2'),
    ).toBeInTheDocument();
  });

  it('新建无日期任务进入未安排并打开详情', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    await openUndated(source);

    await user.click(screen.getByRole('button', { name: '＋ 新任务' }));
    const dialog = await screen.findByRole('dialog', { name: '新建任务' });
    expect(within(dialog).getByLabelText('日期')).toHaveAttribute(
      'data-value',
      '',
    );
    expect(
      within(dialog).getByText(
        '未安排日期：创建后进入「未安排」，仍属于所选清单。',
      ),
    ).toBeInTheDocument();
    const list = within(dialog).getByLabelText('清单');
    expect(list).not.toBeDisabled();
    expect(list).toHaveValue('work');
    expect(
      within(list).queryByRole('option', { name: '未安排' }),
    ).not.toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('标题'), '随手记一条');
    await user.click(within(dialog).getByRole('button', { name: '创建' }));

    expect(await screen.findByText('已加入未安排')).toBeInTheDocument();
    await waitFor(() => {
      const created = source
        .snapshot()
        .tasks.find((task) => task.title === '随手记一条');
      expect(created?.listId).toBe('work');
      expect(created?.dueDate).toBeNull();
    });
    // 详情面板按 task.id 重新挂载（TaskDetailPanel 内部 key），创建瞬间空态
    // aside 会被新节点替换。只断言 aside 存在会拿到已被卸载的旧节点，因此
    // 这里反复查询详情，直到创建后的标题内容稳定出现。
    await waitFor(() => {
      const detail = screen.getByRole('complementary', { name: '任务详情' });
      expect(
        within(detail).getByDisplayValue('随手记一条'),
      ).toBeInTheDocument();
    });
    expect(
      screen.getAllByRole('complementary', { name: '任务详情' }),
    ).toHaveLength(1);
  });

  it('新建任务不在当前筛选时提示并可查看任务', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderTasks(source, '/tasks?filter=done');
    await screen.findByText('买咖啡豆');

    await user.click(screen.getByRole('button', { name: '＋ 新任务' }));
    const dialog = await screen.findByRole('dialog', { name: '新建任务' });
    await user.type(within(dialog).getByLabelText('标题'), '筛选外的新任务');
    await user.click(within(dialog).getByRole('button', { name: '创建' }));

    expect(
      await screen.findByText('已创建任务，但不在当前筛选内'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看任务' }));
    expect(await screen.findByLabelText('标题')).toHaveValue('筛选外的新任务');
  });
});

describe('任务中心：概览、视图与快速新建', () => {
  it('「接下来」范围按明天 / 2–3 天后 / 4–7 天后分组', async () => {
    const seed = createDefaultSeed();
    const source = createFakeTaskSource({
      lists: seed.lists,
      tasks: [
        ...seed.tasks,
        makeTask({
          id: 'task-d2',
          title: '两天后的任务',
          listId: 'work',
          dueDate: '2026-10-28',
        }),
        makeTask({
          id: 'task-d5',
          title: '五天后的任务',
          listId: 'work',
          dueDate: '2026-10-31',
        }),
      ],
      notes: seed.notes,
    });
    renderTasks(source, '/tasks?filter=next');
    expect(
      await screen.findByRole('region', { name: '明天' }),
    ).toHaveTextContent('准备周会材料');
    expect(screen.getByRole('region', { name: '2–3 天后' })).toHaveTextContent(
      '两天后的任务',
    );
    expect(screen.getByRole('region', { name: '4–7 天后' })).toHaveTextContent(
      '五天后的任务',
    );
    expect(screen.queryByText('交房租')).not.toBeInTheDocument();
  });

  it('「未安排」按清单筛选仍生效', async () => {
    renderTasks(createFakeTaskSource(), '/tasks?filter=undated&list=life');
    expect(await screen.findByText('整理旅行清单')).toBeInTheDocument();
    expect(
      screen.queryByText('记一个想法：把日历和笔记连起来'),
    ).not.toBeInTheDocument();
  });

  it('四张概览卡显示全量计数，点击「今天」切到今天范围', async () => {
    const user = userEvent.setup();
    renderTasks(createFakeTaskSource());
    await screen.findByText('交房租');

    const overview = screen.getByRole('region', { name: '任务概览' });
    const cards = within(overview).getAllByRole('button');
    expect(cards).toHaveLength(4);
    expect(cards.map((card) => card.querySelector('.task-overview-label')?.textContent)).toEqual([
      '逾期',
      '今天',
      '接下来 7 天',
      '未安排',
    ]);
    expect(
      cards[0].querySelector('.task-overview-number')?.textContent,
    ).toBe('1');
    // 「今天」卡只算今天到期（3 条），不含逾期；范围标签的今天才是 4。
    expect(
      cards[1].querySelector('.task-overview-number')?.textContent,
    ).toBe('3');
    expect(
      cards[2].querySelector('.task-overview-number')?.textContent,
    ).toBe('1');
    expect(
      cards[3].querySelector('.task-overview-number')?.textContent,
    ).toBe('2');

    await user.click(cards[1]);
    await waitFor(() => {
      expect(cards[1]).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByRole('region', { name: '逾期' })).toBeInTheDocument();
    expect(screen.getByText('完成新版产品需求文档')).toBeInTheDocument();
    expect(screen.queryByText('准备周会材料')).not.toBeInTheDocument();
  });

  it('概览「逾期」卡切换到全部未完成 + 日期=逾期', async () => {
    const user = userEvent.setup();
    renderTasks(createFakeTaskSource());
    await screen.findByText('交房租');

    const overdueCard = within(
      screen.getByRole('region', { name: '任务概览' }),
    ).getByRole('button', { name: /逾期/ });
    await user.click(overdueCard);

    await waitFor(() => {
      expect(overdueCard).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByLabelText('日期筛选')).toHaveValue('overdue');
    expect(screen.getByText('交房租')).toBeInTheDocument();
    expect(screen.queryByText('完成新版产品需求文档')).not.toBeInTheDocument();
  });

  it('看板视图按状态三列展示，点卡片打开详情', async () => {
    const user = userEvent.setup();
    renderTasks(createFakeTaskSource(), '/tasks?view=board');
    await screen.findByRole('region', { name: '待办列' });

    expect(screen.getByRole('button', { name: '看板' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const todo = screen.getByRole('region', { name: '待办列' });
    const doing = screen.getByRole('region', { name: '进行中列' });
    const done = screen.getByRole('region', { name: '已完成列' });
    expect(within(todo).getByText('完成新版产品需求文档')).toBeInTheDocument();
    expect(
      within(doing).getByText('和设计师确认首页信息架构'),
    ).toBeInTheDocument();
    expect(within(done).getByText('当前范围不含已完成')).toBeInTheDocument();

    await user.click(
      within(todo).getByRole('button', { name: /完成新版产品需求文档/ }),
    );
    expect(await screen.findByLabelText('标题')).toHaveValue(
      '完成新版产品需求文档',
    );
  });

  it('看板指针拖拽到「进行中」会改状态', async () => {
    const source = createFakeTaskSource();
    renderTasks(source, '/tasks?view=board');
    const todo = await screen.findByRole('region', { name: '待办列' });
    const card = within(todo).getByRole('button', {
      name: /完成新版产品需求文档/,
    });

    fireEvent.pointerDown(card, {
      pointerId: 1,
      button: 0,
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: 40,
      clientY: 40,
    });
    const doing = screen.getByRole('region', { name: '进行中列' });
    fireEvent.pointerUp(doing, {
      pointerId: 1,
      clientX: 40,
      clientY: 40,
    });

    await waitFor(() => {
      expect(
        source
          .snapshot()
          .tasks.find((task) => task.id === 'task-review')?.status,
      ).toBe('doing');
    });
  });

  it('看板卡片状态胶囊可改状态，点击胶囊不打开详情', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderTasks(source, '/tasks?view=board');
    const doing = await screen.findByRole('region', { name: '进行中列' });

    await user.click(
      within(doing).getByRole('button', {
        name: '任务状态：进行中，点击修改',
      }),
    );
    await user.click(
      screen.getByRole('menuitemradio', { name: /待办/ }),
    );

    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-design')
          ?.status,
      ).toBe('todo');
    });
    expect(screen.queryByLabelText('标题')).not.toBeInTheDocument();
    expect(
      await within(
        screen.getByRole('region', { name: '待办列' }),
      ).findByText('和设计师确认首页信息架构'),
    ).toBeInTheDocument();
  });

  it('「已完成」范围看板只显示完成列', async () => {
    renderTasks(createFakeTaskSource(), '/tasks?filter=done&view=board');
    await screen.findByRole('region', { name: '已完成列' });
    expect(
      screen.queryByRole('region', { name: '待办列' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: '进行中列' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('买咖啡豆')).toBeInTheDocument();
  });

  it('快速新建：回车创建、清空输入、留在当前页并高亮新行', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderTasks(source);
    await screen.findByText('交房租');

    const input = screen.getByLabelText('快速添加任务标题');
    await user.type(input, '快速记下的一件事{enter}');

    expect(await screen.findByText('快速记下的一件事')).toBeInTheDocument();
    await waitFor(() => {
      const created = source
        .snapshot()
        .tasks.find((task) => task.title === '快速记下的一件事');
      expect(created?.dueDate).toBeNull();
      expect(created?.listId).toBe('work');
    });
    expect(input).toHaveValue('');
    expect(
      screen.getByText('快速记下的一件事').closest('.task-row'),
    ).toHaveClass('is-highlight');
  });

  it('快速新建为空时提示且不创建任务', async () => {
    const source = createFakeTaskSource();
    renderTasks(source);
    await screen.findByText('交房租');

    const input = screen.getByLabelText('快速添加任务标题');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '请输入任务标题',
    );
    expect(source.snapshot().tasks).toHaveLength(9);
  });

  it('默认不显示批量复选框，进入批量后才出现', async () => {
    const user = userEvent.setup();
    renderTasks(createFakeTaskSource());
    await screen.findByText('交房租');

    expect(
      screen.queryByRole('checkbox', { name: /选择任务/ }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '批量' }));
    expect(
      screen.getByRole('checkbox', { name: '选择任务：交房租' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '退出批量' }));
    expect(
      screen.queryByRole('checkbox', { name: /选择任务/ }),
    ).not.toBeInTheDocument();
  });

  it('快捷键 / 聚焦搜索，N 打开新建任务', async () => {
    renderTasks(createFakeTaskSource());
    await screen.findByText('交房租');

    fireEvent.keyDown(window, { key: '/' });
    expect(screen.getByLabelText('搜索任务标题或备注')).toHaveFocus();

    fireEvent.keyDown(window, { key: 'n' });
    expect(
      await screen.findByRole(
        'dialog',
        { name: '新建任务' },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  });
});

describe('任务中心：批量操作', () => {
  function enterBatch() {
    fireEvent.click(screen.getByRole('button', { name: '批量' }));
  }

  function selectTask(title: string) {
    fireEvent.click(
      screen.getByRole('checkbox', { name: `选择任务：${title}` }),
    );
  }

  it('批量完成 3 条并撤销，doing 保持 doing', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderTasks(source);
    await screen.findByText('交房租');
    enterBatch();

    selectTask('完成新版产品需求文档');
    selectTask('和设计师确认首页信息架构');
    selectTask('准备周会材料');

    const batch = screen.getByRole('region', { name: '批量操作' });
    expect(batch).toHaveTextContent('已选 3 条');
    await user.click(within(batch).getByRole('button', { name: '完成' }));

    expect(await screen.findByText('已完成 3 条')).toBeInTheDocument();
    await waitFor(() => {
      const tasks = source.snapshot().tasks;
      for (const id of ['task-review', 'task-design', 'task-weekly']) {
        expect(tasks.find((task) => task.id === id)?.status).toBe('done');
      }
    });

    await user.click(screen.getByRole('button', { name: '撤销' }));
    expect(await screen.findByText('已恢复 3 条')).toBeInTheDocument();
    await waitFor(() => {
      const tasks = source.snapshot().tasks;
      expect(tasks.find((task) => task.id === 'task-review')?.status).toBe(
        'todo',
      );
      expect(tasks.find((task) => task.id === 'task-design')?.status).toBe(
        'doing',
      );
      expect(tasks.find((task) => task.id === 'task-weekly')?.status).toBe(
        'todo',
      );
    });
  });

  it('完成后移出设置下批量完成仍统一落库，撤销恢复原状态', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource({
      settings: [
        makeDeviceSetting(SETTING_KEYS.taskCompletionBehavior, 'remove'),
      ],
    });
    renderTasks(source);
    await screen.findByText('交房租');
    enterBatch();

    selectTask('完成新版产品需求文档');
    selectTask('和设计师确认首页信息架构');
    await user.click(
      within(screen.getByRole('region', { name: '批量操作' })).getByRole(
        'button',
        { name: '完成' },
      ),
    );

    expect(await screen.findByText('已完成 2 条')).toBeInTheDocument();
    await waitFor(() => {
      const tasks = source.snapshot().tasks;
      expect(tasks.find((task) => task.id === 'task-review')?.status).toBe(
        'done',
      );
      expect(tasks.find((task) => task.id === 'task-design')?.status).toBe(
        'done',
      );
    });
    expect(
      screen.queryByText('完成新版产品需求文档'),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '撤销' }));
    expect(await screen.findByText('已恢复 2 条')).toBeInTheDocument();
    await waitFor(() => {
      const tasks = source.snapshot().tasks;
      expect(tasks.find((task) => task.id === 'task-review')?.status).toBe(
        'todo',
      );
      expect(tasks.find((task) => task.id === 'task-design')?.status).toBe(
        'doing',
      );
    });
  });

  it('批量完成部分失败：成功项消失，失败项保留选中并可重试', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    const original = source.tasks.complete.bind(source.tasks);
    source.tasks.complete = async (id, done) => {
      if (id === 'task-weekly') {
        throw new Error('模拟失败');
      }
      return original(id, done);
    };
    renderTasks(source);
    await screen.findByText('交房租');
    enterBatch();

    selectTask('完成新版产品需求文档');
    selectTask('准备周会材料');
    await user.click(
      within(screen.getByRole('region', { name: '批量操作' })).getByRole(
        'button',
        { name: '完成' },
      ),
    );

    expect(
      await screen.findByText('已完成 1 条，1 条失败：模拟失败'),
    ).toBeInTheDocument();
    expect(
      source.snapshot().tasks.find((task) => task.id === 'task-review')?.status,
    ).toBe('done');
    expect(
      source.snapshot().tasks.find((task) => task.id === 'task-weekly')?.status,
    ).toBe('todo');
    expect(
      screen.getByRole('checkbox', { name: '选择任务：准备周会材料' }),
    ).toBeChecked();

    source.tasks.complete = original;
    await user.click(screen.getByRole('button', { name: '重试失败项' }));
    expect(await screen.findByText('已完成 1 条')).toBeInTheDocument();
    await waitFor(() => {
      expect(
        source
          .snapshot()
          .tasks.find((task) => task.id === 'task-weekly')?.status,
      ).toBe('done');
    });
  });

  it('批量改期：capture 任务落到默认清单，撤销恢复原值', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderTasks(source);
    await screen.findByText('交房租');
    enterBatch();

    selectTask('记一个想法：把日历和笔记连起来');
    selectTask('准备周会材料');

    await user.click(
      within(screen.getByRole('region', { name: '批量操作' })).getByRole(
        'button',
        { name: /改期/ },
      ),
    );
    await user.click(screen.getByRole('menuitem', { name: '今天' }));

    expect(await screen.findByText('已改期 2 条')).toBeInTheDocument();
    await waitFor(() => {
      const tasks = source.snapshot().tasks;
      const idea = tasks.find((task) => task.id === 'task-idea');
      const weekly = tasks.find((task) => task.id === 'task-weekly');
      expect(idea?.dueDate).toBe('2026-10-26');
      expect(idea?.listId).toBe('work');
      expect(weekly?.dueDate).toBe('2026-10-26');
    });

    await user.click(screen.getByRole('button', { name: '撤销' }));
    expect(await screen.findByText('已恢复 2 条')).toBeInTheDocument();
    await waitFor(() => {
      const tasks = source.snapshot().tasks;
      const idea = tasks.find((task) => task.id === 'task-idea');
      const weekly = tasks.find((task) => task.id === 'task-weekly');
      expect(idea?.dueDate).toBeNull();
      expect(idea?.listId).toBe('inbox');
      expect(weekly?.dueDate).toBe('2026-10-27');
    });
  });

  it('批量改期「选择日期」使用统一日期弹层', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderTasks(source);
    await screen.findByText('交房租');
    enterBatch();
    selectTask('准备周会材料');

    await user.click(
      within(screen.getByRole('region', { name: '批量操作' })).getByRole(
        'button',
        { name: /改期/ },
      ),
    );
    await user.click(screen.getByRole('menuitem', { name: '选择日期…' }));

    const field = screen.getByLabelText('批量改期日期');
    await pickDate(user, field, '2026-11-05');

    const apply = screen.getByRole('button', { name: '应用' });
    expect(apply).toBeEnabled();
    await user.click(apply);

    expect(await screen.findByText('已改期 1 条')).toBeInTheDocument();
    await waitFor(() => {
      const weekly = source
        .snapshot()
        .tasks.find((task) => task.id === 'task-weekly');
      expect(weekly?.dueDate).toBe('2026-11-05');
    });
  });

  it('批量改期空白或非法日期时「应用」禁用', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderTasks(source);
    await screen.findByText('交房租');
    enterBatch();
    selectTask('准备周会材料');

    await user.click(
      within(screen.getByRole('region', { name: '批量操作' })).getByRole(
        'button',
        { name: /改期/ },
      ),
    );
    await user.click(screen.getByRole('menuitem', { name: '选择日期…' }));

    const field = screen.getByLabelText('批量改期日期');
    const apply = screen.getByRole('button', { name: '应用' });
    expect(apply).toBeDisabled();

    await typeDate(user, field, '2026-02-30');
    expect(field).toHaveValue('2026-02-30');
    expect(apply).toBeDisabled();

    await typeDate(user, field, '2026-11-05');
    expect(apply).toBeEnabled();
  });

  it('没有默认清单时整批阻止改期', async () => {
    const user = userEvent.setup();
    const seed = createDefaultSeed();
    const source = createFakeTaskSource({
      lists: seed.lists.filter((list) => list.isInbox),
      tasks: [makeTask({ id: 'task-only', title: '只有一件事', listId: 'inbox' })],
      notes: [],
    });
    renderTasks(source);
    await screen.findByText('只有一件事');
    enterBatch();

    fireEvent.click(
      screen.getByRole('checkbox', { name: '选择任务：只有一件事' }),
    );
    await user.click(
      within(screen.getByRole('region', { name: '批量操作' })).getByRole(
        'button',
        { name: /改期/ },
      ),
    );
    await user.click(screen.getByRole('menuitem', { name: '明天' }));

    expect(
      await screen.findByText('请先创建一个清单再安排日期'),
    ).toBeInTheDocument();
    expect(
      source.snapshot().tasks.find((task) => task.id === 'task-only')
        ?.dueDate,
    ).toBeNull();
  });

  it('筛选变更清空选择，避免批量操作隐藏任务', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    renderTasks(source);
    await screen.findByText('交房租');
    enterBatch();

    selectTask('完成新版产品需求文档');
    expect(
      screen.getByRole('region', { name: '批量操作' }),
    ).toBeInTheDocument();

    await user.click(
      within(screen.getByRole('region', { name: '任务概览' })).getByRole(
        'button',
        { name: /今天/ },
      ),
    );

    expect(
      await screen.findByText('筛选已变更，已清空选择'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole('region', { name: '批量操作' }),
      ).not.toBeInTheDocument();
    });
  });
});

describe('任务中心：空态与深链', () => {
  it('没有任何任务', async () => {
    renderTasks(cloneSeedWith({ tasks: [] }));
    expect(
      await screen.findByRole('heading', { name: '还没有任务' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '＋ 新建任务' })).toBeInTheDocument();
  });

  it('未安排为空', async () => {
    const seed = createDefaultSeed();
    renderTasks(
      cloneSeedWith({
        tasks: seed.tasks.filter((task) => task.dueDate !== null),
      }),
      '/tasks?filter=undated',
    );
    expect(
      await screen.findByRole('heading', { name: '没有未安排的任务' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看全部未完成' })).toBeInTheDocument();
  });

  it('今天没有任务', async () => {
    const seed = createDefaultSeed();
    renderTasks(
      cloneSeedWith({
        tasks: seed.tasks.filter(
          (task) =>
            task.dueDate === null ||
            (task.dueDate !== null && task.dueDate > '2026-10-26'),
        ),
      }),
      '/tasks?filter=today',
    );
    expect(
      await screen.findByRole('heading', { name: '今天没有到期任务' }),
    ).toBeInTheDocument();
  });

  it('还没有已完成任务', async () => {
    const seed = createDefaultSeed();
    renderTasks(
      cloneSeedWith({
        tasks: seed.tasks.filter((task) => task.status !== 'done'),
      }),
      '/tasks?filter=done',
    );
    expect(
      await screen.findByRole('heading', { name: '还没有已完成的任务' }),
    ).toBeInTheDocument();
  });

  it('清单不存在时提示并按全部清单展示', async () => {
    renderTasks(createFakeTaskSource(), '/tasks?list=missing');
    expect(
      await screen.findByText('这个清单不存在或已被删除'),
    ).toBeInTheDocument();
    expect(screen.getByText('交房租')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '清除清单筛选' }),
    ).toBeInTheDocument();
  });

  it('深链任务不存在', async () => {
    renderTasks(createFakeTaskSource(), '/tasks?task=missing');
    expect(
      await screen.findByRole('heading', { name: '这个任务不存在或已被删除' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
    expect(screen.getByText('交房租')).toBeInTheDocument();
  });

  it('深链任务不在当前筛选：详情保持，列表给出提示', async () => {
    renderTasks(
      createFakeTaskSource(),
      '/tasks?filter=done&task=task-review',
    );

    expect(await screen.findByLabelText('标题')).toHaveValue(
      '完成新版产品需求文档',
    );
    expect(
      screen.getByText('当前任务不在筛选结果中'),
    ).toBeInTheDocument();
    expect(screen.getByText('买咖啡豆')).toBeInTheDocument();
  });
});

describe('任务中心：周起始设置', () => {
  function weekSource(weekStart: 'monday' | 'sunday') {
    const seed = createDefaultSeed();
    return createFakeTaskSource({
      lists: seed.lists,
      notes: seed.notes,
      settings: [makeDeviceSetting('calendar.weekStart', weekStart)],
      tasks: [
        makeTask({
          id: 'sunday-today',
          title: '周日今天',
          listId: 'work',
          dueDate: '2026-11-01',
        }),
        makeTask({
          id: 'monday-next',
          title: '周一任务',
          listId: 'work',
          dueDate: '2026-11-02',
        }),
        makeTask({
          id: 'saturday-end',
          title: '周六任务',
          listId: 'work',
          dueDate: '2026-11-07',
        }),
        makeTask({
          id: 'next-sunday',
          title: '下周日任务',
          listId: 'work',
          dueDate: '2026-11-08',
        }),
      ],
    });
  }

  it('周一开头时周日是本周最后一天，11月2日属于「以后」', async () => {
    renderTasks(weekSource('monday'), '/tasks', '2026-11-01');
    expect(await screen.findByText('周一任务')).toBeInTheDocument();

    expect(
      screen.queryByRole('region', { name: '本周' }),
    ).not.toBeInTheDocument();
    const later = screen.getByRole('region', { name: '以后' });
    expect(within(later).getByText('周一任务')).toBeInTheDocument();
    expect(within(later).getByText('周六任务')).toBeInTheDocument();
    expect(within(later).getByText('下周日任务')).toBeInTheDocument();
  });

  it('周日开头时 11月2日–11月7日进入「本周」', async () => {
    renderTasks(weekSource('sunday'), '/tasks', '2026-11-01');
    expect(await screen.findByText('周一任务')).toBeInTheDocument();

    const week = screen.getByRole('region', { name: '本周' });
    expect(within(week).getByText('周一任务')).toBeInTheDocument();
    expect(within(week).getByText('周六任务')).toBeInTheDocument();
    expect(within(week).queryByText('下周日任务')).not.toBeInTheDocument();
    const later = screen.getByRole('region', { name: '以后' });
    expect(within(later).getByText('下周日任务')).toBeInTheDocument();
  });
});
