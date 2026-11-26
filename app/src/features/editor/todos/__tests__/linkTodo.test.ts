import { describe, expect, it } from 'vitest';

import {
  buildTaskInputForTodo,
  createTodoTaskLinkService,
  describeTodoTask,
  linkedTaskIsDeleted,
  sortTaskChoices,
  taskStatusLabel,
} from '../../../tasks/linkTodo';
import { createFakeNoteTodoSource, makeNoteTodo } from './fakeNoteTodoSource';
import {
  createFakeTodoTaskSource,
  makeFakeList,
  makeFakeTask,
} from './fakeTodoTaskSource';

const NOTE_ID = 'note-link-test';

function setup() {
  const noteTodos = createFakeNoteTodoSource([
    makeNoteTodo({
      id: 'todo-a',
      noteId: NOTE_ID,
      title: '写验收清单',
      done: false,
    }),
  ]);
  const tasks = createFakeTodoTaskSource(
    [
      makeFakeTask({ id: 'task-a', title: '整理验收清单', listId: 'work' }),
      makeFakeTask({
        id: 'task-b',
        title: '写发布说明',
        listId: 'work',
        status: 'doing',
        sortOrder: 20,
      }),
      makeFakeTask({
        id: 'task-c',
        title: '已完成的旧任务',
        listId: 'work',
        status: 'done',
        sortOrder: 10,
      }),
    ],
    [
      makeFakeList({ id: 'inbox', name: '收件箱', isInbox: true, sortOrder: 0 }),
      makeFakeList({ id: 'work', name: '工作', sortOrder: 10 }),
    ],
  );
  const service = createTodoTaskLinkService({
    tasks: tasks.tasks,
    lists: tasks.lists,
    noteTodos,
  });
  return { noteTodos, tasks, service };
}

describe('笔记待办关联全局任务', () => {
  it('关联已有任务只改 todo.task_id，todo.done 与 task 状态都不变', async () => {
    const { noteTodos, tasks, service } = setup();
    const todo = noteTodos.snapshot(false)[0];

    const linked = await service.link(todo, 'task-a');

    expect(linked.taskId).toBe('task-a');
    expect(linked.done).toBe(false);
    expect(noteTodos.snapshot(false)[0].taskId).toBe('task-a');
    expect(
      tasks.snapshotTasks(false).find((task) => task.id === 'task-a')?.status,
    ).toBe('todo');
  });

  it('解除关联不删除任务，也不改变 todo 完成状态', async () => {
    const { noteTodos, tasks, service } = setup();
    const linked = await service.link(noteTodos.snapshot(false)[0], 'task-a');

    const unlinked = await service.unlink(linked);

    expect(unlinked.taskId).toBeNull();
    expect(unlinked.done).toBe(false);
    expect(
      tasks.snapshotTasks(true).find((task) => task.id === 'task-a')?.deletedAt,
    ).toBeNull();
  });

  it('新建任务并关联：只有显式调用才创建 task，默认落到收件箱', async () => {
    const { noteTodos, tasks, service } = setup();
    const before = tasks.snapshotTasks(false).length;

    const result = await service.createTask(noteTodos.snapshot(false)[0], {
      title: '来自待办的新任务',
    });

    expect(tasks.snapshotTasks(false)).toHaveLength(before + 1);
    expect(result.task.listId).toBe('inbox');
    expect(result.task.noteId).toBe(NOTE_ID);
    expect(result.task.status).toBe('todo');
    expect(result.task.title).toBe('来自待办的新任务');
    expect(result.todo.taskId).toBe(result.task.id);
    expect(result.todo.done).toBe(false);
  });

  it('任务被软删除后显示已删除，不能再关联但可解除', async () => {
    const { noteTodos, tasks, service } = setup();
    const todo = await service.link(noteTodos.snapshot(false)[0], 'task-a');
    tasks.deleteTask('task-a');

    const states = await service.resolveMany(['task-a']);
    const state = states.get('task-a');
    expect(state && linkedTaskIsDeleted(state)).toBe(true);
    expect(describeTodoTask(state)).toContain('已删除');

    await expect(service.link(todo, 'task-a')).rejects.toThrow('关联任务已删除');
    await expect(service.unlink(todo)).resolves.toMatchObject({ taskId: null });
  });

  it('选择列表只含未删除任务，未完成排在已完成之前', async () => {
    const { tasks, service } = setup();
    tasks.deleteTask('task-b');
    const choices = await service.listChoices();

    expect(choices.map((choice) => choice.id)).toEqual(['task-a', 'task-c']);
    expect(sortTaskChoices(tasks.snapshotTasks(false)).map((item) => item.id)).toEqual([
      'task-a',
      'task-c',
    ]);
    expect(taskStatusLabel('doing')).toBe('进行中');
  });

  it('新建任务输入只带 todo.noteId、清单和标题，不自动设置日期', () => {
    const input = buildTaskInputForTodo(
      { noteId: NOTE_ID, title: '来自待办' },
      'inbox',
    );
    expect(input).toMatchObject({
      listId: 'inbox',
      noteId: NOTE_ID,
      title: '来自待办',
      status: 'todo',
      dueDate: null,
    });
  });
});
