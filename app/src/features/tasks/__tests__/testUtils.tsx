import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import type { JsonValue, Setting } from '../../../data/db/types';
import { InboxPage } from '../../../pages/Inbox/InboxPage';
import { TaskCenterPage } from '../../../pages/Tasks/TaskCenterPage';
import { ListsPage } from '../../../pages/Lists/ListsPage';
import { TodayPage } from '../../../pages/Today/TodayPage';
import { TaskWorkspace } from '../TaskWorkspace';
import { TEST_TODAY, type FakeTaskSource } from './fakeTaskSource';

/** 测试种子：device scope 的单条设置。 */
export function makeDeviceSetting(key: string, value: JsonValue): Setting {
  return {
    id: `setting-${key}`,
    spaceId: 'personal',
    scope: 'device',
    key,
    value,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  };
}

export function renderToday(source: FakeTaskSource, today = TEST_TODAY) {
  return render(
    <MemoryRouter initialEntries={['/today']}>
      <TaskWorkspace source={source} today={today}>
        <TodayPage />
      </TaskWorkspace>
    </MemoryRouter>,
  );
}

export function renderTasks(
  source: FakeTaskSource,
  path = '/tasks',
  today = TEST_TODAY,
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TaskWorkspace source={source} today={today}>
        <TaskCenterPage />
      </TaskWorkspace>
    </MemoryRouter>,
  );
}

/** 旧 `/inbox` 一跳重定向到 `/tasks`，验证参数白名单与详情深链。 */
export function renderInbox(
  source: FakeTaskSource,
  path = '/inbox',
  today = TEST_TODAY,
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TaskWorkspace source={source} today={today}>
        <Routes>
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/tasks" element={<TaskCenterPage />} />
          <Route path="*" element={<div>未匹配路由</div>} />
        </Routes>
      </TaskWorkspace>
    </MemoryRouter>,
  );
}

export function renderLists(
  source: FakeTaskSource,
  path = '/lists',
  today = TEST_TODAY,
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TaskWorkspace source={source} today={today}>
        <Routes>
          <Route path="/lists" element={<ListsPage />} />
          <Route path="/lists/:listId" element={<ListsPage />} />
          <Route path="/tasks" element={<div>任务中心页面</div>} />
        </Routes>
      </TaskWorkspace>
    </MemoryRouter>,
  );
}
