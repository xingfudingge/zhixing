import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { TodayPage } from '../../../../pages/Today/TodayPage';
import {
  AttachmentManager,
  AttachmentUploader,
  MemoryAttachmentMetadataRepository,
  MemoryAttachmentStateStore,
  MemoryBlobStore,
} from '../../../attachments';
import { createFakeTransport } from '../../../attachments/__tests__/fakeTransport';
import { sha256Blob } from '../../../attachments/sha256';
import { pickDate, typeDate } from '../../../../test/datePicker';
import { TaskWorkspace } from '../../TaskWorkspace';
import {
  createFakeTaskSource,
  TEST_TODAY,
} from '../../__tests__/fakeTaskSource';
import { renderToday } from '../../__tests__/testUtils';
import { TaskDetailPanel } from '../TaskDetailPanel';

async function openDetail(title: string) {
  const user = userEvent.setup();
  const source = createFakeTaskSource();
  renderToday(source);
  await screen.findByText('交房租');
  await user.click(
    screen.getByRole('button', { name: `查看任务：${title}` }),
  );
  const detail = await screen.findByRole('complementary', {
    name: '任务详情',
  });
  return { user, source, detail };
}

describe('任务详情', () => {
  it('创建时间读取 createdAt，到期日单独显示，不再把到期日当创建时间', async () => {
    const { detail } = await openDetail('完成新版产品需求文档');

    const meta = screen.getByText(/创建于/).closest('.task-detail-meta');
    expect(meta).not.toBeNull();
    expect(meta).toHaveTextContent(/创建于/);
    expect(meta).toHaveTextContent('2026-10-20');
    expect(meta).toHaveTextContent('到期 2026-10-26');
    expect(
      within(detail).getByText('2026-10-20', { exact: false }),
    ).toBeInTheDocument();
  });

  it('新增两个子任务并勾选一个，计数显示 1/2 且只改子任务状态', async () => {
    const { user, source } = await openDetail('完成新版产品需求文档');

    const input = screen.getByLabelText('新子任务');
    await user.type(input, '写提纲');
    await user.click(screen.getByRole('button', { name: '添加' }));
    await screen.findByText('写提纲');

    await user.type(screen.getByLabelText('新子任务'), '补案例');
    await user.click(screen.getByRole('button', { name: '添加' }));
    await screen.findByText('补案例');

    expect(await screen.findByText('子任务 · 0/2')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: '完成子任务：写提纲' }),
    );

    expect(await screen.findByText('子任务 · 1/2')).toBeInTheDocument();
    await waitFor(() => {
      const rows = source
        .snapshot()
        .subtasks.filter((subtask) => subtask.taskId === 'task-review');
      expect(rows).toHaveLength(2);
      expect(rows.filter((subtask) => subtask.done)).toHaveLength(1);
      expect(
        source
          .snapshot()
          .tasks.find((task) => task.id === 'task-review')?.status,
      ).toBe('todo');
    });
  });

  it('创建执行笔记：任务 noteId 回填、知识域出现笔记、正文含任务回链', async () => {
    const { user, source } = await openDetail('完成新版产品需求文档');

    await user.click(
      await screen.findByRole('button', { name: '＋ 创建执行笔记' }),
    );

    const open = await screen.findByRole('link', { name: '打开笔记' });
    expect(open).toHaveAttribute('href', expect.stringContaining('/knowledge?note='));

    await waitFor(() => {
      const snapshot = source.snapshot();
      const task = snapshot.tasks.find((item) => item.id === 'task-review');
      expect(task?.noteId).toBeTruthy();
      const note = snapshot.notes.find((item) => item.id === task?.noteId);
      expect(note).toBeDefined();
      expect(note?.title).toBe('执行笔记 · 完成新版产品需求文档');
      expect(note?.tags).toContain('执行');
      expect(note?.body).toContain('data-task-id="task-review"');
      expect(note?.body).toContain('来自任务');
    });

    // 关联笔记只有一个直接入口；不生成笔记待办。
    expect(
      source.snapshot().notes.filter((note) =>
        note.title.startsWith('执行笔记'),
      ),
    ).toHaveLength(1);
  });

  it('删除任务先确认，5 秒撤销恢复子任务与关联笔记，且不删除笔记', async () => {
    const { user, source } = await openDetail('完成新版产品需求文档');

    // 准备一个子任务和一篇执行笔记。
    await user.type(screen.getByLabelText('新子任务'), '保留我');
    await user.click(screen.getByRole('button', { name: '添加' }));
    await screen.findByText('保留我');
    await user.click(
      await screen.findByRole('button', { name: '＋ 创建执行笔记' }),
    );
    const linked = await screen.findByRole('link', { name: '打开笔记' });
    expect(linked).toBeInTheDocument();

    const noteBefore = source
      .snapshot()
      .tasks.find((task) => task.id === 'task-review')?.noteId;
    expect(noteBefore).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '删除任务' }));
    const dialog = await screen.findByRole('dialog', { name: '删除任务' });
    expect(dialog).toHaveTextContent('子任务和关联笔记会保留');
    await user.click(
      within(dialog).getByRole('button', { name: '删除任务' }),
    );

    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-review')
          ?.deletedAt,
      ).not.toBeNull();
    });
    expect(
      source.snapshot().notes.some((note) => note.id === noteBefore),
    ).toBe(true);
    expect(
      source
        .snapshot()
        .subtasks.filter((subtask) => subtask.taskId === 'task-review'),
    ).toHaveLength(1);

    expect(await screen.findByText('5 秒内可撤销')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '撤销' }));

    await waitFor(() => {
      const task = source
        .snapshot()
        .tasks.find((item) => item.id === 'task-review');
      expect(task?.deletedAt).toBeNull();
      expect(task?.noteId).toBe(noteBefore);
    });
    expect(
      source.snapshot().notes.some((note) => note.id === noteBefore),
    ).toBe(true);

    expect(
      await screen.findByText('已恢复任务及其子任务与关联笔记'),
    ).toBeInTheDocument();
    await screen.findByText('保留我');
    expect(
      source
        .snapshot()
        .subtasks.filter((subtask) => subtask.taskId === 'task-review'),
    ).toHaveLength(1);
  });

  it('修改优先级、日期、象限即时写入仓储并刷新视图', async () => {
    const { user, source, detail } = await openDetail('完成新版产品需求文档');

    await user.selectOptions(
      within(detail).getByLabelText('优先级'),
      '3',
    );
    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-review')
          ?.priority,
      ).toBe(3);
    });
    expect(
      await screen.findByLabelText('优先级 3'),
    ).toBeInTheDocument();

    await user.selectOptions(
      within(detail).getByLabelText('象限'),
      '2',
    );
    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-review')
          ?.quadrant,
      ).toBe(2);
    });

    const date = within(detail).getByLabelText('日期');
    await pickDate(user, date, '2026-10-27');
    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-review')
          ?.dueDate,
      ).toBe('2026-10-27');
    });
    // 改到明天后从“今天未完成”消失，但详情仍然打开。
    await waitFor(() => {
      expect(
        screen.queryByRole('button', {
          name: '查看任务：完成新版产品需求文档',
        }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('complementary', { name: '任务详情' }),
    ).toBeInTheDocument();
  });

  it('任务详情非法日期不写库，保留草稿并显示行内错误', async () => {
    const { user, source, detail } = await openDetail(
      '完成新版产品需求文档',
    );
    const before = source
      .snapshot()
      .tasks.find((task) => task.id === 'task-review')?.dueDate;
    const field = within(detail).getByLabelText('日期');

    await typeDate(user, field, '2026-02-30');
    expect(field).toHaveValue('2026-02-30');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(
      within(detail).getByText('日期不存在，请检查年月日'),
    ).toBeInTheDocument();
    expect(
      source.snapshot().tasks.find((task) => task.id === 'task-review')
        ?.dueDate,
    ).toBe(before);
  });

  it('可关联已有笔记，卡片跳转到知识页对应笔记', async () => {
    const { user, source, detail } = await openDetail('完成新版产品需求文档');

    await user.selectOptions(
      within(detail).getByLabelText('关联已有笔记'),
      'note-welcome',
    );

    await waitFor(() => {
      expect(
        source.snapshot().tasks.find((task) => task.id === 'task-review')
          ?.noteId,
      ).toBe('note-welcome');
    });
    expect(
      screen.getByRole('link', { name: '打开笔记' }),
    ).toHaveAttribute('href', '/knowledge?note=note-welcome');
  });

  it('/today?task=id 可直接打开来自知识笔记的任务回链', async () => {
    const source = createFakeTaskSource();
    render(
      <MemoryRouter initialEntries={['/today?task=task-review']}>
        <TaskWorkspace source={source} today={TEST_TODAY}>
          <TodayPage />
        </TaskWorkspace>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('complementary', { name: '任务详情' }),
    ).toBeInTheDocument();
    const title = await screen.findByLabelText('标题');
    expect(title).toHaveValue('完成新版产品需求文档');
  });

  it('任务详情附件入口：上传、哈希、任务归属与删除闭环', async () => {
    const user = userEvent.setup();
    const source = createFakeTaskSource();
    const snapshot = source.snapshot();
    const task = snapshot.tasks.find((item) => item.id === 'task-review')!;
    const lists = snapshot.lists;
    const repository = new MemoryAttachmentMetadataRepository();
    const manager = new AttachmentManager({
      repository,
      blobStore: new MemoryBlobStore(),
      stateStore: new MemoryAttachmentStateStore(),
      newId: () => 'att_task_1',
    });
    const uploader = new AttachmentUploader({
      manager,
      transport: createFakeTransport(),
      chunkSize: 64 * 1024,
    });

    render(
      <MemoryRouter>
        <TaskWorkspace source={source} today={TEST_TODAY}>
          <TaskDetailPanel
            task={task}
            lists={lists}
            inboxId={snapshot.lists.find((item) => item.isInbox)?.id ?? null}
            defaultListId="work"
            today={TEST_TODAY}
            onToggleTask={() => undefined}
            attachmentManager={manager}
            attachmentUploader={uploader}
          />
        </TaskWorkspace>
      </MemoryRouter>,
    );

    const detail = await screen.findByRole('complementary', {
      name: '任务详情',
    });
    const panel = await within(detail).findByRole('region', {
      name: '任务附件',
    });

    const file = new File([new Uint8Array([1, 3, 3, 7])], '需求附件.pdf', {
      type: 'application/pdf',
    });
    const sha = await sha256Blob(file);
    fireEvent.change(within(panel).getByLabelText('选择附件文件'), {
      target: { files: [file] },
    });
    expect(await within(panel).findByText('需求附件.pdf')).toBeInTheDocument();
    expect(within(panel).getByText(sha)).toBeInTheDocument();

    await user.click(
      within(panel).getByRole('button', { name: '上传附件 需求附件.pdf' }),
    );
    expect(
      await within(panel).findByText('已同步'),
    ).toBeInTheDocument();

    const [stored] = repository.all();
    expect(stored).toMatchObject({
      noteId: null,
      blockId: 'task:task-review',
      fileName: '需求附件.pdf',
      sha256: sha,
    });

    await user.click(
      within(panel).getByRole('button', { name: '删除附件 需求附件.pdf' }),
    );
    await waitFor(() => {
      expect(
        within(panel).queryByText('需求附件.pdf'),
      ).not.toBeInTheDocument();
    });
    expect(repository.all()).toHaveLength(0);
  });
});
