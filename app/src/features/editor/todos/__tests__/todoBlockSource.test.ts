import { describe, expect, it } from 'vitest';

import type { BlockDraft } from '../../../../data/repositories/blocks';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
} from '../../__tests__/fakeBlockSource';
import { createNoteTodoBlockSource } from '../todoBlockSource';
import {
  createFakeNoteTodoSource,
  makeNoteTodo,
} from './fakeNoteTodoSource';

function todoBlock(id: string, text: string, todoId?: string) {
  return makeBlock({
    id,
    type: 'todo',
    payload: {
      runs: text ? [{ text }] : [],
      checked: false,
      ...(todoId ? { todoId } : {}),
    },
  });
}

function asDraft(block: {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}): BlockDraft {
  return {
    id: block.id,
    type: block.type,
    payload: block.payload as BlockDraft['payload'],
  };
}

describe('正文待办块 ↔ note_todos 一致性', () => {
  it('旧正文待办块加载时补齐 note_todos，并回填 todoId', async () => {
    const blocks = createFakeBlockSource([
      todoBlock('b1', '第一条'),
      todoBlock('b2', '第二条'),
      makeBlock({ id: 'b3', type: 'paragraph' }),
    ]);
    const noteTodos = createFakeNoteTodoSource();
    const source = createNoteTodoBlockSource({
      noteId: FAKE_NOTE_ID,
      blocks,
      noteTodos,
    });

    const loaded = await source.list(FAKE_NOTE_ID);

    expect(await source.listTodos()).toHaveLength(2);
    const todoIds = loaded
      .filter((block) => block.type === 'todo')
      .map((block) => block.payload.todoId);
    expect(todoIds.every((id) => typeof id === 'string' && id)).toBe(true);
    expect(source.todoBlocks().size).toBe(2);
  });

  it('正文删除待办块 → note_todo 软删除，不触碰外部任务', async () => {
    const blocks = createFakeBlockSource([
      todoBlock('b1', '会被删掉'),
      makeBlock({ id: 'b2', type: 'paragraph' }),
    ]);
    const noteTodos = createFakeNoteTodoSource();
    const source = createNoteTodoBlockSource({
      noteId: FAKE_NOTE_ID,
      blocks,
      noteTodos,
    });

    const loaded = await source.list(FAKE_NOTE_ID);
    const paragraph = loaded.find((block) => block.id === 'b2');
    expect(paragraph).toBeDefined();

    await source.saveDocument(FAKE_NOTE_ID, [asDraft(paragraph!)]);

    expect(await source.listTodos()).toHaveLength(0);
    expect(noteTodos.snapshot(false)).toHaveLength(0);
    expect(
      blocks.snapshot().find((block) => block.id === 'b1')?.deletedAt,
    ).not.toBeNull();
  });

  it('待办块转换成段落 → note_todo 软删除', async () => {
    const blocks = createFakeBlockSource([
      todoBlock('b1', '原本是待办', 'todo-a'),
      makeBlock({ id: 'b2', type: 'paragraph' }),
    ]);
    const noteTodos = createFakeNoteTodoSource([
      makeNoteTodo({
        id: 'todo-a',
        noteId: FAKE_NOTE_ID,
        title: '原本是待办',
      }),
    ]);
    const source = createNoteTodoBlockSource({
      noteId: FAKE_NOTE_ID,
      blocks,
      noteTodos,
    });

    await source.list(FAKE_NOTE_ID);
    await source.saveDocument(FAKE_NOTE_ID, [
      {
        id: 'b1',
        type: 'paragraph',
        payload: { runs: [{ text: '原本是待办' }] },
      },
      { id: 'b2', type: 'paragraph', payload: { runs: [] } },
    ]);

    expect(await source.listTodos()).toHaveLength(0);
    const saved = blocks.snapshot().find((block) => block.id === 'b1');
    expect(saved?.type).toBe('paragraph');
    expect(saved?.payload.todoId).toBeUndefined();
  });

  it('新插入待办块保存 → 创建 note_todo；不创建全局任务', async () => {
    const blocks = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph' }),
    ]);
    const noteTodos = createFakeNoteTodoSource();
    const source = createNoteTodoBlockSource({
      noteId: FAKE_NOTE_ID,
      blocks,
      noteTodos,
    });

    await source.list(FAKE_NOTE_ID);
    await source.saveDocument(FAKE_NOTE_ID, [
      { id: 'b1', type: 'paragraph', payload: { runs: [] } },
      {
        id: 'b2',
        type: 'todo',
        payload: { runs: [{ text: '新的待办' }], checked: false },
      },
    ]);

    const todos = await source.listTodos();
    expect(todos).toHaveLength(1);
    expect(todos[0].title).toBe('新的待办');
    expect(todos[0].done).toBe(false);
    expect(todos[0].taskId).toBeNull();
  });

  it('删除待办快照 → 撤销以新 id 恢复正文与 task 关联', async () => {
    const blocks = createFakeBlockSource([
      todoBlock('b1', '带关联的待办', 'todo-a'),
      makeBlock({ id: 'b2', type: 'paragraph' }),
    ]);
    const noteTodos = createFakeNoteTodoSource([
      makeNoteTodo({
        id: 'todo-a',
        noteId: FAKE_NOTE_ID,
        title: '带关联的待办',
        taskId: 'task-a',
        done: true,
      }),
    ]);
    const source = createNoteTodoBlockSource({
      noteId: FAKE_NOTE_ID,
      blocks,
      noteTodos,
    });
    await source.list(FAKE_NOTE_ID);

    const snapshot = await source.deleteTodo('todo-a');
    expect(snapshot.todo.taskId).toBe('task-a');
    expect(await source.listTodos()).toHaveLength(0);

    const restored = await source.restoreTodo(snapshot);
    expect(restored.todo.id).not.toBe('todo-a');
    expect(restored.todo.taskId).toBe('task-a');
    expect(restored.todo.done).toBe(true);
    const todos = await source.listTodos();
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe(restored.todo.id);
    expect(
      (await blocks.list(FAKE_NOTE_ID)).find(
        (block) => block.id === restored.block.id,
      )?.payload.todoId,
    ).toBe(restored.todo.id);
    // 旧墓碑仍在，恢复是新行；不是镜像或物理复活。
    expect(noteTodos.snapshot(true).filter((todo) => todo.id === 'todo-a')).toHaveLength(
      1,
    );
  });

  it('汇总直接切换完成状态 → 正文 checked 与 todo.done 同步', async () => {
    const blocks = createFakeBlockSource([
      todoBlock('b1', '直接切换', 'todo-a'),
    ]);
    const noteTodos = createFakeNoteTodoSource([
      makeNoteTodo({ id: 'todo-a', noteId: FAKE_NOTE_ID, title: '直接切换' }),
    ]);
    const source = createNoteTodoBlockSource({
      noteId: FAKE_NOTE_ID,
      blocks,
      noteTodos,
    });
    await source.list(FAKE_NOTE_ID);

    await source.toggleTodo('todo-a', true);

    expect((await source.listTodos())[0].done).toBe(true);
    expect(
      (await blocks.list(FAKE_NOTE_ID))[0].payload.checked,
    ).toBe(true);
  });
});
