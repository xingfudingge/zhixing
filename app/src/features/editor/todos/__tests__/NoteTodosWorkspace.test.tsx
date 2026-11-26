import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NoteTodo } from '../../../../data/db/types';
import type { EditorBlock } from '../../../../data/repositories/blocks';
import { restoreSelectionByOffsets } from '../../inline';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
} from '../../__tests__/fakeBlockSource';
import { NoteTodosWorkspace } from '../NoteTodosWorkspace';
import {
  createFakeNoteTodoSource,
  makeNoteTodo,
} from './fakeNoteTodoSource';
import {
  createFakeTodoTaskSource,
  makeFakeList,
  makeFakeTask,
} from './fakeTodoTaskSource';

const scrollSpy = vi.fn();

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollSpy,
  });
});

beforeEach(() => {
  scrollSpy.mockReset();
});

function todoBlock(
  id: string,
  text: string,
  options: { todoId?: string; checked?: boolean } = {},
): EditorBlock {
  return makeBlock({
    id,
    type: 'todo',
    payload: {
      runs: text ? [{ text }] : [],
      checked: options.checked ?? false,
      ...(options.todoId ? { todoId: options.todoId } : {}),
    },
  });
}

function renderWorkspace(options: {
  blocks?: EditorBlock[];
  todos?: NoteTodo[];
  tasks?: ReturnType<typeof makeFakeTask>[];
  lists?: ReturnType<typeof makeFakeList>[];
} = {}) {
  const blockSource = createFakeBlockSource(
    options.blocks ?? [makeBlock({ id: 'b1', type: 'paragraph' })] ,
  );
  const noteTodos = createFakeNoteTodoSource(options.todos ?? []);
  const tasks = createFakeTodoTaskSource(
    options.tasks ?? [
      makeFakeTask({ id: 'task-a', title: '整理验收清单', listId: 'work' }),
      makeFakeTask({
        id: 'task-b',
        title: '写发布说明',
        listId: 'work',
        status: 'doing',
        sortOrder: 10,
      }),
    ],
    options.lists ?? [
      makeFakeList({ id: 'inbox', name: '收件箱', isInbox: true, sortOrder: 0 }),
      makeFakeList({ id: 'work', name: '工作', sortOrder: 10 }),
    ],
  );

  const view = render(
    <NoteTodosWorkspace
      noteId={FAKE_NOTE_ID}
      blockSource={blockSource}
      noteTodoSource={noteTodos}
      taskSource={{ tasks: tasks.tasks, lists: tasks.lists }}
      saveDelayMs={0}
    />,
  );

  return { ...view, blockSource, noteTodos, tasks };
}

function typeInto(element: HTMLElement, text: string) {
  element.textContent = text;
  fireEvent.input(element);
  // jsdom 不会像真实输入那样自动把光标放到末尾；回车拆分前显式定位，
  // 否则光标停在 0 会把整段文字推进新块。
  restoreSelectionByOffsets(element, text.length, text.length);
}

describe('笔记待办 · 内联与文末汇总', () => {
  it('插入两条待办 → 0/2；勾选一条 → 1/2，且不创建全局任务', async () => {
    const user = userEvent.setup();
    const { noteTodos, tasks } = renderWorkspace();

    await user.click(
      await screen.findByRole('button', { name: '插入内容' }),
    );
    await user.click(
      within(await screen.findByRole('menu', { name: '插入块' })).getByRole(
        'menuitem',
        { name: /待办事项/ },
      ),
    );

    const firstBox = await screen.findByRole('textbox', { name: '待办内容' });
    typeInto(firstBox, '写验收清单');
    fireEvent.keyDown(firstBox, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getAllByRole('textbox', { name: '待办内容' })).toHaveLength(
        2,
      );
    });
    const boxes = screen.getAllByRole('textbox', { name: '待办内容' });
    typeInto(boxes[1], '补充回归用例');

    expect(await screen.findByText('0/2 已完成')).toBeInTheDocument();
    expect(noteTodos.snapshot(false)).toHaveLength(2);
    expect(tasks.snapshotTasks(false)).toHaveLength(2);
    expect(tasks.snapshotTasks(false).every((task) => task.status !== 'done')).toBe(
      true,
    );

    await user.click(
      screen.getByRole('checkbox', { name: '标记完成：写验收清单' }),
    );

    expect(await screen.findByText('1/2 已完成')).toBeInTheDocument();
    const done = noteTodos
      .snapshot(false)
      .find((todo) => todo.title === '写验收清单');
    expect(done?.done).toBe(true);
    // 勾选笔记待办不产生、不完成全局任务。
    expect(tasks.snapshotTasks(false).map((task) => task.status)).toEqual([
      'todo',
      'doing',
    ]);
  });

  it('汇总点击标题 → 正文滚动并高亮定位', async () => {
    const user = userEvent.setup();
    const { container } = renderWorkspace({
      blocks: [todoBlock('b1', '定位我'), todoBlock('b2', '另一条')],
    });

    await screen.findByText('0/2 已完成');
    await user.click(screen.getByRole('button', { name: '定位待办：定位我' }));

    expect(scrollSpy).toHaveBeenCalled();
    const row = container.querySelector<HTMLElement>(
      '[data-block-type="todo"]',
    );
    expect(row?.classList.contains('zxt-locate-flash')).toBe(true);
  });
});

describe('笔记待办 · 与全局任务状态独立', () => {
  it('关联已有任务后勾待办：note_todo 完成、task 状态不变', async () => {
    const user = userEvent.setup();
    const { noteTodos, tasks } = renderWorkspace({
      blocks: [todoBlock('b1', '写验收清单')],
    });

    await screen.findByText('0/1 已完成');
    await user.click(
      screen.getByRole('button', { name: '关联任务：写验收清单' }),
    );
    await user.selectOptions(
      await screen.findByLabelText('选择已有任务'),
      'task-a',
    );
    await user.click(screen.getByRole('button', { name: '保存关联' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(
      await screen.findByRole('button', { name: /已关联任务：整理验收清单/ }),
    ).toBeInTheDocument();
    expect(noteTodos.snapshot(false)[0].taskId).toBe('task-a');

    await user.click(
      screen.getByRole('checkbox', { name: '标记完成：写验收清单' }),
    );
    await screen.findByText('1/1 已完成');

    const todo = noteTodos.snapshot(false)[0];
    expect(todo.done).toBe(true);
    expect(todo.taskId).toBe('task-a');
    const task = tasks.snapshotTasks(false).find((item) => item.id === 'task-a');
    expect(task?.status).toBe('todo');
    expect(task?.completedAt).toBeNull();
  });

  it('新建任务并关联：显式创建后才出现全局任务，默认收件箱', async () => {
    const user = userEvent.setup();
    const { noteTodos, tasks } = renderWorkspace({
      blocks: [todoBlock('b1', '写验收清单')],
    });

    await screen.findByText('0/1 已完成');
    const before = tasks.snapshotTasks(false).length;
    await user.click(
      screen.getByRole('button', { name: '关联任务：写验收清单' }),
    );

    const titleInput = await screen.findByLabelText('新任务标题');
    await user.clear(titleInput);
    await user.type(titleInput, '从待办创建的任务');
    await user.click(
      screen.getByRole('button', { name: '新建任务并关联' }),
    );

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(tasks.snapshotTasks(false)).toHaveLength(before + 1);
    const created = tasks
      .snapshotTasks(false)
      .find((task) => task.title === '从待办创建的任务');
    expect(created).toMatchObject({
      listId: 'inbox',
      noteId: FAKE_NOTE_ID,
      status: 'todo',
    });
    const todo = noteTodos.snapshot(false)[0];
    expect(todo.taskId).toBe(created?.id);
    expect(todo.done).toBe(false);
  });

  it('完成任务 → 笔记待办状态不变；关联任务显示已完成', async () => {
    const user = userEvent.setup();
    const { noteTodos, tasks } = renderWorkspace({
      blocks: [todoBlock('b1', '写验收清单', { todoId: 'todo-a' })],
      todos: [
        makeNoteTodo({
          id: 'todo-a',
          noteId: FAKE_NOTE_ID,
          title: '写验收清单',
          taskId: 'task-a',
        }),
      ],
    });

    await screen.findByText('0/1 已完成');
    tasks.completeTask('task-a');
    await user.click(
      screen.getByRole('button', { name: '刷新关联任务状态' }),
    );

    expect(
      await screen.findByRole('button', { name: /已关联任务：整理验收清单（已完成）/ }),
    ).toBeInTheDocument();
    const todo = noteTodos.snapshot(false)[0];
    expect(todo.done).toBe(false);
    expect(todo.taskId).toBe('task-a');
  });

  it('关联任务删除后显示“已删除”，可解除且不删除任务', async () => {
    const user = userEvent.setup();
    const { noteTodos, tasks } = renderWorkspace({
      blocks: [todoBlock('b1', '写验收清单', { todoId: 'todo-a' })],
      todos: [
        makeNoteTodo({
          id: 'todo-a',
          noteId: FAKE_NOTE_ID,
          title: '写验收清单',
          taskId: 'task-a',
        }),
      ],
    });

    await screen.findByText('0/1 已完成');
    tasks.deleteTask('task-a');
    await user.click(
      screen.getByRole('button', { name: '刷新关联任务状态' }),
    );

    const deleted = await screen.findByRole('button', {
      name: '关联任务已删除：写验收清单',
    });
    expect(deleted).toHaveTextContent('已删除');

    await user.click(deleted);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: '解除关联',
      }),
    );

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(noteTodos.snapshot(false)[0].taskId).toBeNull();
    const tombstone = tasks
      .snapshotTasks(true)
      .find((task) => task.id === 'task-a');
    expect(tombstone?.deletedAt).not.toBeNull();
    expect(screen.getByRole('button', { name: '关联任务：写验收清单' })).toBeInTheDocument();
  });
});

describe('笔记待办 · 删除撤销与正文一致性', () => {
  it('正文删除待办块 → 撤销恢复正文、汇总与任务关联；重做再删除', async () => {
    const user = userEvent.setup();
    const { container, noteTodos } = renderWorkspace({
      blocks: [
        todoBlock('todo-block', '写验收清单', {
          todoId: 'todo-a',
          checked: false,
        }),
        makeBlock({
          id: 'after-todo',
          type: 'paragraph',
          orderKey: 2048,
          payload: { runs: [] },
        }),
      ],
      todos: [
        makeNoteTodo({
          id: 'todo-a',
          noteId: FAKE_NOTE_ID,
          title: '写验收清单',
          taskId: 'task-a',
        }),
      ],
    });

    await screen.findByText('0/1 已完成');
    await user.click(screen.getByRole('button', { name: '块操作' }));
    const menu = await screen.findByRole('menu', { name: '插入块' });
    await user.click(within(menu).getByRole('menuitem', { name: '删除块' }));

    await waitFor(() => {
      expect(screen.queryByText('0/1 已完成')).toBeNull();
    });
    expect(container.querySelector('[data-block-type="todo"]')).toBeNull();
    expect(noteTodos.snapshot(false)).toHaveLength(0);

    // 撤销走块历史（不是 5 秒删除 toast）：正文、汇总、taskId 一起回来。
    await user.click(screen.getByRole('button', { name: '撤销编辑' }));
    expect(await screen.findByText('0/1 已完成')).toBeInTheDocument();
    expect(container.querySelector('[data-block-type="todo"]')).not.toBeNull();
    const restored = noteTodos.snapshot(false);
    expect(restored).toHaveLength(1);
    expect(restored[0].taskId).toBe('task-a');
    expect(restored[0].title).toBe('写验收清单');

    // 重做删除后再撤销，仍只有一条待办，不产生重复。
    await user.click(screen.getByRole('button', { name: '重做编辑' }));
    await waitFor(() => {
      expect(screen.queryByText('0/1 已完成')).toBeNull();
    });
    expect(noteTodos.snapshot(false)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: '撤销编辑' }));
    expect(await screen.findByText('0/1 已完成')).toBeInTheDocument();
    expect(noteTodos.snapshot(false)).toHaveLength(1);
    expect(noteTodos.snapshot(false)[0].taskId).toBe('task-a');
  });

  it('汇总删除待办 → 正文消失；撤销恢复正文与任务关联', async () => {
    const user = userEvent.setup();
    const { container, noteTodos, tasks } = renderWorkspace({
      blocks: [todoBlock('b1', '写验收清单', { todoId: 'todo-a' })],
      todos: [
        makeNoteTodo({
          id: 'todo-a',
          noteId: FAKE_NOTE_ID,
          title: '写验收清单',
          taskId: 'task-a',
        }),
      ],
    });

    await screen.findByText('0/1 已完成');
    await user.click(
      screen.getByRole('button', { name: '删除待办：写验收清单' }),
    );

    await waitFor(() => {
      expect(screen.queryByLabelText('本篇待办')).toBeNull();
    });
    expect(container.querySelector('[data-block-type="todo"]')).toBeNull();
    expect(noteTodos.snapshot(false)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: '撤销' }));

    expect(await screen.findByText('0/1 已完成')).toBeInTheDocument();
    expect(container.querySelector('[data-block-type="todo"]')).not.toBeNull();
    const restored = noteTodos.snapshot(false);
    expect(restored).toHaveLength(1);
    expect(restored[0].taskId).toBe('task-a');
    expect(restored[0].title).toBe('写验收清单');
    expect(
      tasks.snapshotTasks(true).find((task) => task.id === 'task-a')?.deletedAt,
    ).toBeNull();
  });
});
