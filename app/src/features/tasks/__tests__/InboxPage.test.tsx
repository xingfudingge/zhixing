import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { TaskCenterPage } from '../../../pages/Tasks/TaskCenterPage';
import { InboxPage } from '../../../pages/Inbox/InboxPage';
import { TaskWorkspace } from '../TaskWorkspace';
import { createFakeTaskSource, TEST_TODAY } from './fakeTaskSource';

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

function renderRedirect(path: string) {
  const source = createFakeTaskSource();
  render(
    <MemoryRouter initialEntries={[path]}>
      <TaskWorkspace source={source} today={TEST_TODAY}>
        <Routes>
          <Route path="/inbox" element={<InboxPage />} />
          <Route
            path="/tasks"
            element={
              <>
                <TaskCenterPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </TaskWorkspace>
    </MemoryRouter>,
  );
  return source;
}

describe('旧 /inbox 兼容重定向', () => {
  it('/inbox 一跳 replace 到 /tasks，并渲染全部任务', async () => {
    renderRedirect('/inbox');

    expect(
      await screen.findByRole('heading', { level: 1, name: '全部任务' }),
    ).toBeInTheDocument();
    expect(await screen.findByTestId('location')).toHaveTextContent('/tasks');
    expect(screen.queryByText('收件箱')).not.toBeInTheDocument();
  });

  it('/inbox?task= 保留任务深链并打开详情', async () => {
    renderRedirect('/inbox?task=task-idea');

    expect(await screen.findByLabelText('标题')).toHaveValue(
      '记一个想法：把日历和笔记连起来',
    );
    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/tasks?task=task-idea',
    );
  });

  it('只透传白名单参数，丢弃未知参数', async () => {
    renderRedirect('/inbox?filter=undated&priority=2&q=旅行&unknown=1');

    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/tasks?filter=undated&priority=2&q=',
    );
    expect(screen.getByRole('button', { name: /未安排/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.queryByText('收件箱'),
    ).not.toBeInTheDocument();
  });
});
