import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { createFakeBlockSource } from '../../editor/__tests__/fakeBlockSource';
import { createFakeNoteTodoSource } from '../../editor/todos/__tests__/fakeNoteTodoSource';
import { createFakeTaskSource } from '../../tasks/__tests__/fakeTaskSource';
import { createExecutionNote } from '../createFromTask';
import { KnowledgePage } from '../../../pages/KnowledgePage';

async function renderKnowledgeWithExecutionNote() {
  const source = createFakeTaskSource();
  const notes = source.notes;
  const task = source.snapshot().tasks.find((item) => item.id === 'task-review');
  if (!task || !notes) {
    throw new Error('缺少测试任务或笔记仓储');
  }
  const { note } = await createExecutionNote(
    {
      notes,
      tasks: { patch: source.tasks.patch },
    },
    task,
    { listName: '工作', template: 'blank' },
  );

  render(
    <MemoryRouter initialEntries={[`/knowledge?note=${note.id}`]}>
      <Routes>
        <Route
          path="/knowledge"
          element={
            <KnowledgePage
              source={notes}
              blockSource={createFakeBlockSource()}
              noteTodoSource={createFakeNoteTodoSource()}
              taskSource={{ tasks: source.tasks, lists: source.lists }}
            />
          }
        />
        <Route path="/today" element={<h1>今天</h1>} />
      </Routes>
    </MemoryRouter>,
  );

  return { source, note, task };
}

describe('知识页 · 任务执行笔记', () => {
  it('列出从任务创建的笔记，展示正文与来源任务回链', async () => {
    const { note } = await renderKnowledgeWithExecutionNote();

    expect(
      await screen.findByRole('heading', { level: 1, name: '知识' }),
    ).toBeInTheDocument();
    expect(
      await screen.findAllByText('执行笔记 · 完成新版产品需求文档'),
    ).not.toHaveLength(0);

    const preview = screen.getByRole('article', { name: '笔记内容' });
    expect(within(preview).getByText('执行笔记 · 完成新版产品需求文档'))
      .toBeInTheDocument();
    expect(await within(preview).findByText('背景')).toBeInTheDocument();

    const backlinkBox = preview.querySelector('.knowledge-backlink');
    expect(backlinkBox).not.toBeNull();
    expect(
      within(backlinkBox as HTMLElement).getByText('来源任务'),
    ).toBeInTheDocument();
    const backlink = within(preview).getAllByRole('link', {
      name: '完成新版产品需求文档',
    })[0];
    expect(backlink).toHaveAttribute('href', '/today?task=task-review');
    expect(note.body).toContain('data-task-id="task-review"');
  });

  it('点击来源任务跳到 /today?task=任务 id', async () => {
    const user = userEvent.setup();
    await renderKnowledgeWithExecutionNote();

    const preview = await screen.findByRole('article', {
      name: '笔记内容',
    });
    const backlinkBox = preview.querySelector('.knowledge-backlink');
    expect(backlinkBox).not.toBeNull();
    await user.click(
      within(backlinkBox as HTMLElement).getByRole('link', {
        name: '完成新版产品需求文档',
      }),
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: '今天' }),
    ).toBeInTheDocument();
  });
});
