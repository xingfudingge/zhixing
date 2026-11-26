import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { cloneDefaultSettings } from '../../../data/repositories/settings';
import {
  clearDate,
  openDatePicker,
  typeDate,
} from '../../../test/datePicker';
import { QuickAddDialog } from '../QuickAddDialog';
import { createFakeQuickAddSource } from './fakeQuickAddSource';

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

function testSettings() {
  const settings = cloneDefaultSettings();
  settings.task.defaultListId = 'life';
  settings.task.noteFolderId = 'f2';
  return settings;
}

const SETTINGS = testSettings();

function Harness({
  source,
  available = true,
  onClose,
}: {
  source: ReturnType<typeof createFakeQuickAddSource>;
  available?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <QuickAddDialog
        open={open}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
        source={source}
        settings={SETTINGS}
        available={available}
        today={TODAY}
      />
      <Routes>
        <Route path="/today" element={<LocationProbe />} />
        <Route path="/tasks" element={<LocationProbe />} />
        <Route path="/knowledge" element={<LocationProbe />} />
      </Routes>
    </>
  );
}

function renderQuickAdd(options: {
  source?: ReturnType<typeof createFakeQuickAddSource>;
  available?: boolean;
  onClose?: () => void;
} = {}) {
  const source = options.source ?? createFakeQuickAddSource();
  const view = render(
    <MemoryRouter initialEntries={['/today']}>
      <Harness
        source={source}
        available={options.available}
        onClose={options.onClose}
      />
    </MemoryRouter>,
  );
  return { ...view, source };
}

async function openTaskForm() {
  return screen.findByRole('textbox', { name: '任务标题' });
}

describe('⌘N 快速创建', () => {
  it('任务默认今天 / 设置默认清单 / 象限 4，字段按输入保存并深链打开详情', async () => {
    const user = userEvent.setup();
    const { source } = renderQuickAdd();

    const title = await openTaskForm();
    expect(screen.getByLabelText('日期')).toHaveAttribute('data-value', TODAY);
    expect(screen.getByLabelText('清单')).toHaveValue('life');
    expect(screen.getByLabelText('象限')).toHaveValue('4');
    expect(screen.getByLabelText('优先级')).toHaveValue('0');

    await user.type(title, '整理复盘材料');
    await user.type(screen.getByLabelText('时间'), '10:30');
    await user.selectOptions(screen.getByLabelText('优先级'), '2');
    await user.selectOptions(screen.getByLabelText('象限'), '1');
    await user.selectOptions(screen.getByLabelText('关联笔记'), 'note-1');
    await user.click(screen.getByRole('button', { name: '创建任务' }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/today?task=task-1',
      ),
    );

    const snapshot = source.snapshot();
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      title: '整理复盘材料',
      listId: 'life',
      status: 'todo',
      priority: 2,
      quadrant: 1,
      dueDate: TODAY,
      dueTime: '10:30',
      noteId: 'note-1',
    });
  });

  it('清空日期后自动进入未安排，创建后跳到任务中心详情', async () => {
    const user = userEvent.setup();
    const { source } = renderQuickAdd();

    const title = await openTaskForm();
    await user.type(title, '记一个想法');
    await clearDate(user, screen.getByLabelText('日期'));

    const list = screen.getByLabelText('清单');
    expect(list).toBeDisabled();
    expect(list).toHaveValue('inbox');
    expect(screen.getByText(/创建后进入未安排/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '创建任务' }));
    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/tasks?task=task-1',
    );
    expect(source.snapshot().tasks[0]).toMatchObject({
      listId: 'inbox',
      dueDate: null,
      dueTime: null,
    });
  });

  it('非法日期草稿禁用创建，修正后恢复', async () => {
    const user = userEvent.setup();
    renderQuickAdd();
    await openTaskForm();
    await user.type(await openTaskForm(), '带非法日期的任务');

    const date = screen.getByLabelText('日期');
    const create = screen.getByRole('button', { name: '创建任务' });
    expect(create).toBeEnabled();

    await typeDate(user, date, '2026-02-30');
    expect(date).toHaveValue('2026-02-30');
    expect(create).toBeDisabled();

    await typeDate(user, date, '2026-11-03');
    expect(date).toHaveValue('2026-11-03');
    expect(create).toBeEnabled();
  });

  it('日期弹层的 Esc/Enter 只作用于日期，不关闭快速创建、不提交任务', async () => {
    const user = userEvent.setup();
    const { source } = renderQuickAdd();
    await openTaskForm();

    const field = screen.getByLabelText('日期');
    await openDatePicker(user, field);
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    expect(
      screen.getByRole('dialog', { name: '快速创建' }),
    ).toBeInTheDocument();

    await openDatePicker(user, field);
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    expect(
      screen.getByRole('dialog', { name: '快速创建' }),
    ).toBeInTheDocument();
    expect(field).toHaveAttribute('data-value', TODAY);
    expect(source.snapshot().tasks).toHaveLength(0);
  });

  it('笔记页签使用设置默认目录并打开知识页对应笔记', async () => {
    const user = userEvent.setup();
    const { source } = renderQuickAdd();

    await openTaskForm();
    await user.click(screen.getByRole('tab', { name: '笔记' }));

    const title = await screen.findByRole('textbox', { name: '笔记标题' });
    expect(screen.getByLabelText('目录')).toHaveValue('f2');
    await user.type(title, '新的复盘笔记');
    await user.click(screen.getByRole('button', { name: '创建笔记' }));

    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/knowledge?note=note-1',
    );
    expect(source.snapshot().notes[0]).toMatchObject({
      title: '新的复盘笔记',
      folderId: 'f2',
      body: '',
      status: 'active',
    });
  });

  it('标题必填，错误留在应用内提示', async () => {
    const user = userEvent.setup();
    renderQuickAdd();

    await openTaskForm();
    await user.click(screen.getByRole('button', { name: '创建任务' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '请先写任务标题',
    );
  });

  it('Esc 关闭面板，不创建数据', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { source } = renderQuickAdd({ onClose });

    await openTaskForm();
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '快速创建' })).toBeNull();
    });
    expect(onClose).toHaveBeenCalled();
    expect(source.snapshot().tasks).toHaveLength(0);
    expect(source.snapshot().notes).toHaveLength(0);
  });

  it('浏览器预览没有 IPC 时显示空态，不能伪造创建', async () => {
    renderQuickAdd({ available: false });
    expect(
      await screen.findByText('需在桌面壳内快速创建'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '创建任务' }),
    ).toBeDisabled();
  });
});
