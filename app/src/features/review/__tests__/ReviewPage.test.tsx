import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { createFakeBlockSource } from '../../editor/__tests__/fakeBlockSource';
import { createFakeNoteTodoSource } from '../../editor/todos/__tests__/fakeNoteTodoSource';
import { KnowledgePage } from '../../../pages/KnowledgePage';
import { ReviewPage } from '../ReviewPage';
import {
  createFakeReviewSource,
  TEST_TODAY,
  type FakeReviewSource,
} from './fakeReviewSource';

function renderReview(source: FakeReviewSource) {
  return render(
    <MemoryRouter initialEntries={['/review']}>
      <Routes>
        <Route
          path="/review"
          element={<ReviewPage source={source} today={TEST_TODAY} />}
        />
        <Route
          path="/knowledge"
          element={
            <KnowledgePage
              source={source.notes}
              blockSource={createFakeBlockSource()}
              noteTodoSource={createFakeNoteTodoSource()}
            />
          }
        />
        <Route path="/habits" element={<h1>习惯</h1>} />
        <Route path="/focus" element={<h1>专注</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

function bar(metric: string, date = TEST_TODAY): HTMLElement | null {
  return document.querySelector(
    `[data-date="${date}"][data-metric="${metric}"]`,
  );
}

describe('复盘页', () => {
  it('三卡数字与今天柱一致：完成任务 2 / 专注 30 / 打卡 1', async () => {
    const source = createFakeReviewSource();
    renderReview(source);

    expect(
      await screen.findByRole('heading', { level: 1, name: '复盘' }),
    ).toBeInTheDocument();

    const tasksCard = await screen.findByRole('article', { name: '完成任务' });
    const focusCard = screen.getByRole('article', { name: '专注时长' });
    const habitsCard = screen.getByRole('article', { name: '习惯打卡' });

    expect(within(tasksCard).getByText('2')).toBeInTheDocument();
    expect(within(focusCard).getByText('30')).toBeInTheDocument();
    expect(within(habitsCard).getByText('1')).toBeInTheDocument();

    expect(bar('tasks')).toHaveAttribute('data-value', '2');
    expect(bar('tasks')).toHaveAttribute('data-percent', '100');
    expect(bar('focus')).toHaveAttribute('data-value', '30');
    expect(bar('tasks', '2026-10-20')).toHaveAttribute('data-value', '0');
    expect(bar('tasks', '2026-10-20')).toHaveAttribute('data-percent', '0');

    expect(screen.getByText('最近 7 天 · 共 2 项已完成')).toBeInTheDocument();
    expect(screen.getByText('2 段记录 · 30 分钟')).toBeInTheDocument();
    expect(screen.getByText('1 个习惯 · 最近 7 天')).toBeInTheDocument();
  });

  it('切换柱状图指标后仍与对应卡片一致', async () => {
    const user = userEvent.setup();
    const source = createFakeReviewSource();
    renderReview(source);
    await screen.findByRole('article', { name: '完成任务' });

    await user.click(screen.getByRole('button', { name: '专注分钟' }));
    expect(bar('focus')).toHaveAttribute('data-value', '30');
    expect(bar('focus')).toHaveAttribute('data-percent', '100');

    await user.click(screen.getByRole('button', { name: '习惯打卡' }));
    expect(bar('habits')).toHaveAttribute('data-value', '1');
    expect(bar('habits')).toHaveAttribute('data-percent', '100');
  });

  it('无数据时三卡为 0、柱为空，不出现 NaN', async () => {
    const source = createFakeReviewSource({
      tasks: [],
      sessions: [],
      habits: [],
      logsByHabit: {},
      lists: [],
    });
    renderReview(source);

    await screen.findByRole('article', { name: '完成任务' });
    expect(screen.getByText('这段时间还没有完成任务')).toBeInTheDocument();
    expect(screen.getByText('还没有专注记录')).toBeInTheDocument();

    const bars = Array.from(
      document.querySelectorAll<HTMLElement>('[data-metric="tasks"]'),
    );
    // 三张卡片各 7 根迷你柱 + 主日柱 7 根。
    expect(bars).toHaveLength(14);
    for (const item of bars) {
      expect(item).toHaveAttribute('data-value', '0');
      expect(item).toHaveAttribute('data-percent', '0');
      expect(item.getAttribute('style')).toContain('height: 0%');
    }
    expect(document.body.textContent).not.toContain('NaN');
    expect(document.body.textContent).not.toContain('Infinity');
  });

  it('保存后知识页出现「复盘 · 日期」，快照含三类来源 ID', async () => {
    const user = userEvent.setup();
    const source = createFakeReviewSource();
    renderReview(source);
    await screen.findByRole('article', { name: '完成任务' });

    await user.click(
      screen.getByRole('button', { name: '保存为复盘笔记' }),
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: '知识' }),
    ).toBeInTheDocument();
    expect((await screen.findAllByText('复盘 · 2026-10-26')).length).toBeGreaterThan(
      0,
    );

    const state = source.state();
    expect(state.snapshots).toHaveLength(1);
    expect(state.notes).toHaveLength(1);
    expect(state.snapshots[0]).toMatchObject({
      rangeStart: '2026-10-20',
      rangeEnd: '2026-10-26',
      taskIds: ['task-1', 'task-2'],
      focusIds: ['focus-1', 'focus-2'],
      habitIds: ['habit-read'],
      noteId: state.notes[0].id,
    });
    expect(state.notes[0].tags).toEqual(['复盘']);
    expect(state.notes[0].body).toContain('data-source-id="task-1"');
    expect(state.notes[0].body).toContain('data-source-id="focus-1"');
    expect(state.notes[0].body).toContain('data-source-id="habit-read"');
    expect(state.notes[0].body).toContain('完成任务：2 项');
  });

  it('同范围重复保存幂等：不新增快照或笔记', async () => {
    const user = userEvent.setup();
    const source = createFakeReviewSource();

    renderReview(source);
    await screen.findByRole('article', { name: '完成任务' });
    await user.click(screen.getByRole('button', { name: '保存为复盘笔记' }));
    await screen.findByRole('heading', { level: 1, name: '知识' });
    const first = source.state();
    expect(first.snapshots).toHaveLength(1);

    cleanup();
    renderReview(source);
    await screen.findByRole('article', { name: '完成任务' });
    await user.click(screen.getByRole('button', { name: '保存为复盘笔记' }));
    await screen.findByRole('heading', { level: 1, name: '知识' });

    const second = source.state();
    expect(second.snapshots).toHaveLength(1);
    expect(second.notes).toHaveLength(1);
    expect(second.snapshots[0].id).toBe(first.snapshots[0].id);
    expect(second.notes[0].id).toBe(first.notes[0].id);
  });

  it('修改复盘笔记正文后，复盘统计保持不变', async () => {
    const user = userEvent.setup();
    const source = createFakeReviewSource();
    renderReview(source);
    await screen.findByRole('article', { name: '完成任务' });
    await user.click(screen.getByRole('button', { name: '保存为复盘笔记' }));
    await screen.findByRole('heading', { level: 1, name: '知识' });

    const note = source.state().notes[0];
    await source.notes.update(note.id, {
      title: note.title,
      folderId: null,
      tags: note.tags,
      body: `${note.body}<h2>我的补充</h2><p>写完这段不应该影响统计。</p>`,
      bodyFormat: 'html',
      favorite: false,
      pinned: false,
    });

    cleanup();
    renderReview(source);
    await screen.findByRole('article', { name: '完成任务' });
    expect(
      within(screen.getByRole('article', { name: '完成任务' })).getByText('2'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('article', { name: '专注时长' })).getByText('30'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('article', { name: '习惯打卡' })).getByText('1'),
    ).toBeInTheDocument();
    expect(bar('tasks')).toHaveAttribute('data-value', '2');
  });

  it('渲染、切换指标与保存过程中不产生 console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    const source = createFakeReviewSource();

    try {
      renderReview(source);
      await screen.findByRole('article', { name: '完成任务' });
      await user.click(screen.getByRole('button', { name: '专注分钟' }));
      await user.click(screen.getByRole('button', { name: '保存为复盘笔记' }));
      await screen.findByRole('heading', { level: 1, name: '知识' });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('浏览器预览没有 IPC 时明确提示，不伪造统计或保存', async () => {
    render(
      <MemoryRouter initialEntries={['/review']}>
        <Routes>
          <Route path="/review" element={<ReviewPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: '复盘' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('浏览器预览');
    expect(
      screen.getByRole('button', { name: '保存为复盘笔记' }),
    ).toBeDisabled();
    expect(screen.queryByRole('article', { name: '完成任务' })).toBeNull();
  });
});
