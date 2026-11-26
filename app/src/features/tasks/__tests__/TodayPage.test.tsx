import {
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { clearDate } from '../../../test/datePicker';
import { SETTING_KEYS } from '../../../data/repositories/settings';
import { createFakeTaskSource } from './fakeTaskSource';
import { makeDeviceSetting, renderToday } from './testUtils';

async function openToday(source: ReturnType<typeof createFakeTaskSource>) {
  const view = renderToday(source);
  await screen.findByText('交房租');
  return view;
}

function pointer(
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
) {
  return {
    pointerId: 7,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    ...extra,
  };
}

/** 真实 WKWebView 走 pointer 事件，不再依赖 HTML5 DragEvent。 */
function pointerDrag(source: Element, target: Element) {
  fireEvent.pointerDown(source, pointer(20, 20));
  fireEvent.pointerMove(target, pointer(120, 120));
  fireEvent.pointerUp(target, pointer(120, 120, { buttons: 0 }));
}

describe('今天页', () => {
  it('列表按逾期 / 今天未完成 / 今天已完成分组，未来与无日期任务不进入今天', async () => {
    const source = createFakeTaskSource();
    await openToday(source);

    expect(screen.getByRole('region', { name: '逾期任务' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '今天未完成' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '今天已完成' })).toBeInTheDocument();
    expect(screen.getByText('逾期 1 天')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: '今日完成 1/5' }),
    ).toBeInTheDocument();

    expect(screen.getByText('交房租')).toBeInTheDocument();
    expect(screen.getByText('完成新版产品需求文档')).toBeInTheDocument();
    expect(screen.getByText('和设计师确认首页信息架构')).toBeInTheDocument();
    expect(screen.getByText('读《设计中的设计》第二章')).toBeInTheDocument();
    expect(screen.getByText('买咖啡豆')).toBeInTheDocument();

    expect(screen.queryByText('准备周会材料')).not.toBeInTheDocument();
    expect(
      screen.queryByText('记一个想法：把日历和笔记连起来'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('整理旅行清单')).not.toBeInTheDocument();

    // 过期任务只出现在「逾期」，不会被复制到「今天未完成」。
    expect(screen.getAllByText('交房租')).toHaveLength(1);
  });

  it('四象限范围在今天（含逾期）和全部未完成之间切换，并写入设置后重载保持', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    const view = await openToday(source);

    await user.click(screen.getByRole('button', { name: '四象限' }));
    expect(
      await screen.findByRole('region', { name: '四象限：重要且紧急' }),
    ).toBeInTheDocument();

    expect(screen.getByText('交房租')).toBeInTheDocument();
    expect(screen.queryByText('准备周会材料')).not.toBeInTheDocument();
    expect(
      screen.queryByText('记一个想法：把日历和笔记连起来'),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '全部未完成' }));
    expect(await screen.findByText('准备周会材料')).toBeInTheDocument();
    expect(
      screen.getByText('记一个想法：把日历和笔记连起来'),
    ).toBeInTheDocument();

    await waitFor(() => {
      const stored = source
        .snapshot()
        .settings.find((setting) => setting.key === 'tasks.quadrantScope');
      expect(stored?.value).toBe('all');
    });

    view.unmount();
    renderToday(source);
    await screen.findByRole('region', { name: '四象限：重要且紧急' });
    expect(
      screen.getByRole('button', { name: '全部未完成' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('准备周会材料')).toBeInTheDocument();
  });

  it('拖动任务改象限并刷新保持', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    const view = await openToday(source);

    await user.click(screen.getByRole('button', { name: '四象限' }));
    const q1 = await screen.findByRole('region', {
      name: '四象限：重要且紧急',
    });
    const q2 = screen.getByRole('region', { name: '四象限：重要不紧急' });
    const row = within(q1).getByText('交房租').closest('[data-task-id]');
    expect(row).not.toBeNull();

    fireEvent.dragStart(row as Element);
    fireEvent.dragOver(q2);
    fireEvent.drop(q2);

    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-overdue')
          ?.quadrant,
      ).toBe(2);
    });
    expect(await within(q2).findByText('交房租')).toBeInTheDocument();
    expect(
      within(q1).queryByText('交房租'),
    ).not.toBeInTheDocument();

    await waitFor(() => {
      expect(
        source
          .snapshot()
          .settings.find((setting) => setting.key === 'tasks.todayView')
          ?.value,
      ).toBe('quadrant');
    });

    view.unmount();
    renderToday(source);
    const reloadedQ2 = await screen.findByRole('region', {
      name: '四象限：重要不紧急',
    });
    expect(within(reloadedQ2).getByText('交房租')).toBeInTheDocument();
  });

  it('指针拖拽（pointer 事件）移入另一象限：ghost/占位/高亮生效且不打开详情', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    await openToday(source);

    await user.click(screen.getByRole('button', { name: '四象限' }));
    const q1 = await screen.findByRole('region', {
      name: '四象限：重要且紧急',
    });
    const q2 = screen.getByRole('region', { name: '四象限：重要不紧急' });
    const row = within(q1)
      .getByText('交房租')
      .closest('[data-task-id]') as HTMLElement;

    fireEvent.pointerDown(row, pointer(20, 20));
    fireEvent.pointerMove(q2, pointer(120, 120));

    // 越过阈值后才出现 ghost，原行留下占位态，目标象限高亮。
    const ghost = document.querySelector('.task-drag-ghost');
    expect(ghost).not.toBeNull();
    expect(ghost).toHaveTextContent('交房租');
    expect(row).toHaveClass('is-dragging');
    expect(q2).toHaveClass('is-over');
    expect(document.body).toHaveClass('task-pointer-dragging');

    fireEvent.pointerUp(q2, pointer(120, 120, { buttons: 0 }));

    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-overdue')
          ?.quadrant,
      ).toBe(2);
    });
    expect(await within(q2).findByText('交房租')).toBeInTheDocument();
    expect(within(q1).queryByText('交房租')).not.toBeInTheDocument();
    expect(document.querySelector('.task-drag-ghost')).toBeNull();
    expect(document.body).not.toHaveClass('task-pointer-dragging');
    expect(q2).not.toHaveClass('is-over');

    // 拖拽后的补发 click 不应选中任务、打开详情。
    fireEvent.click(row);
    expect(
      within(
        screen.getByRole('complementary', { name: '任务详情' }),
      ).getByText('选择一个任务查看详情'),
    ).toBeInTheDocument();
  });

  it('指针拖拽看板卡片：待办 → 进行中 → 已完成，完成逻辑与计数同步', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    await openToday(source);

    await user.click(screen.getByRole('button', { name: '看板' }));
    const todo = await screen.findByRole('region', { name: '待办列' });
    const doing = screen.getByRole('region', { name: '进行中列' });
    const done = screen.getByRole('region', { name: '已完成列' });

    const card = within(todo)
      .getByText('完成新版产品需求文档')
      .closest('[data-task-id]') as HTMLElement;
    fireEvent.pointerDown(card, pointer(20, 20));
    fireEvent.pointerMove(doing, pointer(120, 120));
    expect(card).toHaveClass('is-dragging');
    expect(doing).toHaveClass('is-over');
    fireEvent.pointerUp(doing, pointer(120, 120, { buttons: 0 }));

    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-review')
          ?.status,
      ).toBe('doing');
    });
    expect(
      await within(doing).findByText('完成新版产品需求文档'),
    ).toBeInTheDocument();

    const movedCard = within(doing)
      .getByText('完成新版产品需求文档')
      .closest('[data-task-id]') as HTMLElement;
    pointerDrag(movedCard, done);

    await waitFor(() => {
      const task = source
        .snapshot()
        .tasks.find((item) => item.id === 'task-review');
      expect(task?.status).toBe('done');
      expect(task?.completedAt).not.toBeNull();
    });
    expect(
      await screen.findByRole('img', { name: '今日完成 2/5' }),
    ).toBeInTheDocument();
    expect(
      await within(done).findByText('完成新版产品需求文档'),
    ).toBeInTheDocument();
  });

  it('Tauri 运行时关闭原生 draggable，pointer 拖拽仍可用', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    try {
      const user = userEvent.setup();
      const source = createFakeTaskSource();
      await openToday(source);

      await user.click(screen.getByRole('button', { name: '四象限' }));
      const q1 = await screen.findByRole('region', {
        name: '四象限：重要且紧急',
      });
      const q2 = screen.getByRole('region', { name: '四象限：重要不紧急' });
      const row = within(q1)
        .getByText('交房租')
        .closest('[data-task-id]') as HTMLElement;
      expect(row).toHaveAttribute('draggable', 'false');

      pointerDrag(row, q2);
      await waitFor(() => {
        expect(
          source.snapshot().tasks.find((task) => task.id === 'task-overdue')
            ?.quadrant,
        ).toBe(2);
      });
      expect(await within(q2).findByText('交房租')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: '看板' }));
      const todo = await screen.findByRole('region', { name: '待办列' });
      const card = within(todo)
        .getByText('完成新版产品需求文档')
        .closest('[data-task-id]') as HTMLElement;
      expect(card).toHaveAttribute('draggable', 'false');
    } finally {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it('看板拖拽写入失败时提示错误，任务留在原列（可重试）', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    source.tasks.patch = async () => {
      throw new Error('模拟写入失败');
    };
    await openToday(source);

    await user.click(screen.getByRole('button', { name: '看板' }));
    const todo = await screen.findByRole('region', { name: '待办列' });
    const doing = screen.getByRole('region', { name: '进行中列' });
    const card = within(todo)
      .getByText('完成新版产品需求文档')
      .closest('[data-task-id]') as HTMLElement;

    pointerDrag(card, doing);

    expect(await screen.findByText('模拟写入失败')).toBeInTheDocument();
    expect(within(todo).getByText('完成新版产品需求文档')).toBeInTheDocument();
    expect(within(doing).queryByText('完成新版产品需求文档')).not.toBeInTheDocument();
    expect(
      source.snapshot().tasks.find((task) => task.id === 'task-review')
        ?.status,
    ).toBe('todo');
    expect(doing).not.toHaveClass('is-over');
  });

  it('Esc / 拖到空白区域取消指针拖拽：不改象限、无残留高亮', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    await openToday(source);

    await user.click(screen.getByRole('button', { name: '四象限' }));
    const q1 = await screen.findByRole('region', {
      name: '四象限：重要且紧急',
    });
    const q2 = screen.getByRole('region', { name: '四象限：重要不紧急' });
    const row = within(q1)
      .getByText('交房租')
      .closest('[data-task-id]') as HTMLElement;

    fireEvent.pointerDown(row, pointer(20, 20));
    fireEvent.pointerMove(q2, pointer(120, 120));
    expect(q2).toHaveClass('is-over');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('.task-drag-ghost')).toBeNull();
    expect(q2).not.toHaveClass('is-over');
    fireEvent.pointerUp(q2, pointer(120, 120, { buttons: 0 }));

    // 拖到空白区域（body）同样不产生副作用。
    fireEvent.pointerDown(row, pointer(20, 20));
    fireEvent.pointerMove(document.body, pointer(400, 400));
    expect(q2).not.toHaveClass('is-over');
    fireEvent.pointerUp(document.body, pointer(400, 400, { buttons: 0 }));

    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-overdue')
          ?.quadrant,
      ).toBe(1);
    });
    expect(document.querySelector('.task-drag-ghost')).toBeNull();
    expect(document.body).not.toHaveClass('task-pointer-dragging');
    expect(within(q1).getByText('交房租')).toBeInTheDocument();
  });

  it('小位移不触发拖拽，仍可点击打开详情', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    await openToday(source);

    await user.click(screen.getByRole('button', { name: '四象限' }));
    const q1 = await screen.findByRole('region', {
      name: '四象限：重要且紧急',
    });
    const row = within(q1)
      .getByText('交房租')
      .closest('[data-task-id]') as HTMLElement;

    fireEvent.pointerDown(row, pointer(20, 20));
    fireEvent.pointerMove(row, pointer(23, 23));
    fireEvent.pointerUp(row, pointer(23, 23, { buttons: 0 }));
    expect(document.querySelector('.task-drag-ghost')).toBeNull();

    await user.click(
      within(q1).getByRole('button', { name: '查看任务：交房租' }),
    );
    expect(
      await screen.findByRole('complementary', { name: '任务详情' }),
    ).toBeInTheDocument();
    expect(
      source.snapshot().tasks.find((task) => task.id === 'task-overdue')
        ?.quadrant,
    ).toBe(1);
  });

  it('看板拖状态：待办 → 进行中 → 已完成，完成环与列计数同步', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    await openToday(source);

    await user.click(screen.getByRole('button', { name: '看板' }));
    const todo = await screen.findByRole('region', { name: '待办列' });
    const doing = screen.getByRole('region', { name: '进行中列' });
    const done = screen.getByRole('region', { name: '已完成列' });

    expect(within(todo).getByText('完成新版产品需求文档')).toBeInTheDocument();
    expect(within(todo).queryByText('准备周会材料')).not.toBeInTheDocument();
    expect(
      within(todo).queryByText('记一个想法：把日历和笔记连起来'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: '今日完成 1/5' }),
    ).toBeInTheDocument();

    const reviewCard = within(todo)
      .getByText('完成新版产品需求文档')
      .closest('[data-task-id]');
    fireEvent.dragStart(reviewCard as Element);
    fireEvent.dragOver(doing);
    fireEvent.drop(doing);

    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-review')
          ?.status,
      ).toBe('doing');
    });
    expect(
      await within(doing).findByText('完成新版产品需求文档'),
    ).toBeInTheDocument();

    const movedCard = within(doing)
      .getByText('完成新版产品需求文档')
      .closest('[data-task-id]');
    fireEvent.dragStart(movedCard as Element);
    fireEvent.dragOver(done);
    fireEvent.drop(done);

    await waitFor(() => {
      const task = source
        .snapshot()
        .tasks.find((item) => item.id === 'task-review');
      expect(task?.status).toBe('done');
      expect(task?.completedAt).not.toBeNull();
    });
    expect(
      await screen.findByRole('img', { name: '今日完成 2/5' }),
    ).toBeInTheDocument();
    expect(
      await within(done).findByText('完成新版产品需求文档'),
    ).toBeInTheDocument();

    const coffeeCard = within(done)
      .getByText('买咖啡豆')
      .closest('[data-task-id]');
    fireEvent.dragStart(coffeeCard as Element);
    fireEvent.dragOver(todo);
    fireEvent.drop(todo);

    await waitFor(() => {
      const task = source
        .snapshot()
        .tasks.find((item) => item.id === 'task-coffee');
      expect(task?.status).toBe('todo');
      expect(task?.completedAt).toBeNull();
    });
    expect(
      await screen.findByRole('img', { name: '今日完成 1/5' }),
    ).toBeInTheDocument();
    expect(
      await within(todo).findByText('买咖啡豆'),
    ).toBeInTheDocument();
  });

  it('今天看板卡片状态胶囊可改状态，点击胶囊不打开详情', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    await openToday(source);

    await user.click(screen.getByRole('button', { name: '看板' }));
    const doing = await screen.findByRole('region', { name: '进行中列' });
    await user.click(
      within(doing).getByRole('button', {
        name: '任务状态：进行中，点击修改',
      }),
    );
    await user.click(
      screen.getByRole('menuitemradio', { name: /已完成/ }),
    );

    await waitFor(() => {
      const task = source
        .snapshot()
        .tasks.find((item) => item.id === 'task-design');
      expect(task?.status).toBe('done');
      expect(task?.completedAt).not.toBeNull();
    });
    expect(
      await within(
        screen.getByRole('region', { name: '已完成列' }),
      ).findByText('和设计师确认首页信息架构'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('标题')).not.toBeInTheDocument();
  });

  it('完成与撤销同步计数，撤销恢复原状态（进行中不会降级为待办）', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    await openToday(source);

    await user.click(
      screen.getByRole('button', {
        name: '完成任务：完成新版产品需求文档',
      }),
    );
    expect(
      await screen.findByRole('img', { name: '今日完成 2/5' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-review')
          ?.status,
      ).toBe('done');
    });

    await user.click(screen.getByRole('button', { name: '撤销' }));
    expect(
      await screen.findByRole('img', { name: '今日完成 1/5' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      const task = source
        .snapshot()
        .tasks.find((item) => item.id === 'task-review');
      expect(task?.status).toBe('todo');
      expect(task?.completedAt).toBeNull();
    });

    await user.click(
      screen.getByRole('button', {
        name: '完成任务：和设计师确认首页信息架构',
      }),
    );
    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-design')
          ?.status,
      ).toBe('done');
    });
    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-design')
          ?.status,
      ).toBe('doing');
    });
    expect(
      await screen.findByRole('img', { name: '今日完成 1/5' }),
    ).toBeInTheDocument();
  });

  it('完成后移出：勾选后立即从今天活动视图消失，撤销恢复原状态', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource({
      settings: [
        makeDeviceSetting(SETTING_KEYS.taskCompletionBehavior, 'remove'),
      ],
    });
    await openToday(source);

    // 已有完成项也不出现在活动视图，但完成计数仍按真实数据展示。
    expect(screen.queryByText('买咖啡豆')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: '今天已完成' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: '今日完成 1/5' }),
    ).toBeInTheDocument();

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
      document.querySelector('[data-task-id="task-review"]'),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole('img', { name: '今日完成 2/5' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => {
      const task = source
        .snapshot()
        .tasks.find((item) => item.id === 'task-review');
      expect(task?.status).toBe('todo');
      expect(task?.completedAt).toBeNull();
    });
    expect(
      await screen.findByText('完成新版产品需求文档'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: '今日完成 1/5' }),
    ).toBeInTheDocument();
  });

  it('完成后移出：详情改状态与看板拖动完成使用同一过滤与撤销', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource({
      settings: [
        makeDeviceSetting(SETTING_KEYS.taskCompletionBehavior, 'remove'),
      ],
    });
    await openToday(source);

    // 详情状态改为已完成：任务从活动视图消失，但详情仍可撤销。
    await user.click(screen.getByText('完成新版产品需求文档'));
    const status = await screen.findByLabelText('状态');
    await user.selectOptions(status, 'done');
    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-review')
          ?.status,
      ).toBe('done');
    });
    expect(
      document.querySelector('[data-task-id="task-review"]'),
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

    // 看板拖到已完成：卡片从完成列移出，空态明确说明是设置导致。
    await user.click(screen.getByRole('button', { name: '看板' }));
    const todo = screen.getByRole('region', { name: '待办列' });
    const done = screen.getByRole('region', { name: '已完成列' });
    expect(within(done).getByText('完成后已按设置移出当前视图')).toBeInTheDocument();
    pointerDrag(
      within(todo).getByText('完成新版产品需求文档'),
      done,
    );
    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-review')
          ?.status,
      ).toBe('done');
    });
    expect(
      within(done).queryByText('完成新版产品需求文档'),
    ).not.toBeInTheDocument();
  });

  it('行内状态胶囊可把待办改为进行中；已完成圆点直接撤销回原状态', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    await openToday(source);

    const reviewRow = screen
      .getByText('完成新版产品需求文档')
      .closest<HTMLElement>('[data-task-id]');
    if (!reviewRow) {
      throw new Error('找不到任务行');
    }
    await user.click(
      within(reviewRow).getByRole('button', {
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
    expect(
      within(reviewRow).getByRole('button', {
        name: '任务状态：进行中，点击修改',
      }),
    ).toBeInTheDocument();

    // 进行中任务完成后，再点已完成圆点（不是 toast 撤销）也应回到进行中。
    await user.click(
      screen.getByRole('button', {
        name: '完成任务：完成新版产品需求文档',
      }),
    );
    const doneRow = await screen.findByRole('region', {
      name: '今天已完成',
    });
    await user.click(
      within(doneRow).getByRole('button', {
        name: '撤销完成：完成新版产品需求文档',
      }),
    );
    await waitFor(() => {
      const task = source
        .snapshot()
        .tasks.find((item) => item.id === 'task-review');
      expect(task?.status).toBe('doing');
      expect(task?.completedAt).toBeNull();
    });
  });

  it('详情里清空日期：任务进入未安排并离开今天，清单保持不变', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    const view = await openToday(source);

    await user.click(
      screen.getByRole('button', {
        name: '查看任务：读《设计中的设计》第二章',
      }),
    );
    const detail = screen.getByRole('complementary', { name: '任务详情' });
    await clearDate(user, within(detail).getByLabelText('日期'));

    await waitFor(() => {
      const task = source
        .snapshot()
        .tasks.find((item) => item.id === 'task-reading');
      expect(task?.dueDate).toBeNull();
      expect(task?.listId).toBe('reading');
    });
    await waitFor(() => {
      expect(
        screen.queryByText('读《设计中的设计》第二章'),
      ).not.toBeInTheDocument();
    });

    view.unmount();
    renderToday(source);
    await screen.findByText('交房租');
    expect(
      screen.queryByText('读《设计中的设计》第二章'),
    ).not.toBeInTheDocument();
  });

  it('新建任务标题必填；无日期进入未安排但仍属于默认清单', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    await openToday(source);

    await user.click(screen.getByRole('button', { name: '＋ 新任务' }));
    const dialog = await screen.findByRole('dialog', { name: '新建任务' });
    await user.click(within(dialog).getByRole('button', { name: '创建' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      '请先写任务标题',
    );
    expect(source.snapshot().tasks).toHaveLength(9);

    await user.type(
      within(dialog).getByLabelText('标题'),
      '给未来留个想法',
    );
    await clearDate(user, within(dialog).getByLabelText('日期'));
    await user.click(within(dialog).getByRole('button', { name: '创建' }));

    await waitFor(() => {
      const created = source
        .snapshot()
        .tasks.find((task) => task.title === '给未来留个想法');
      expect(created?.listId).toBe('work');
      expect(created?.dueDate).toBeNull();
    });
    expect(screen.queryByRole('dialog', { name: '新建任务' })).toBeNull();
    expect(await screen.findByText('已加入未安排')).toBeInTheDocument();
    expect(screen.queryByText('给未来留个想法')).not.toBeInTheDocument();
  });

  it('新建任务默认今天与默认清单，并支持预录子任务', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    await openToday(source);

    await user.click(screen.getByRole('button', { name: '＋ 新任务' }));
    const dialog = await screen.findByRole('dialog', { name: '新建任务' });
    expect(within(dialog).getByLabelText('日期')).toHaveAttribute(
      'data-value',
      '2026-10-26',
    );
    expect(within(dialog).getByLabelText('清单')).toHaveValue('work');

    await user.type(within(dialog).getByLabelText('标题'), '新增今日任务');
    await user.type(
      within(dialog).getByLabelText('新子任务'),
      '先确认范围',
    );
    await user.click(within(dialog).getByRole('button', { name: '添加' }));
    await user.click(within(dialog).getByRole('button', { name: '创建' }));

    expect(await screen.findByText('新增今日任务')).toBeInTheDocument();
    const created = source
      .snapshot()
      .tasks.find((task) => task.title === '新增今日任务');
    expect(created?.dueDate).toBe('2026-10-26');
    expect(created?.listId).toBe('work');
    expect(
      source
        .snapshot()
        .subtasks.filter((subtask) => subtask.taskId === created?.id),
    ).toHaveLength(1);
  });
});
