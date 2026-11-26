import { Navigate, Route, Routes } from 'react-router-dom';

import { Shell } from './shell/Shell';
import { BoardPage } from '../pages/BoardPage';
import { CalendarPage } from '../pages/CalendarPage';
import { FocusPage } from '../pages/FocusPage';
import { HabitsPage } from '../pages/HabitsPage';
import { KnowledgePage } from '../pages/KnowledgePage';
import { ReviewPage } from '../pages/ReviewPage';
import { SettingsPage } from '../pages/SettingsPage';
import { InboxPage } from '../pages/Inbox/InboxPage';
import { ListsPage } from '../pages/Lists/ListsPage';
import { TaskCenterPage } from '../pages/Tasks/TaskCenterPage';
import { TodayPage } from '../pages/Today/TodayPage';
import { TaskWorkspace } from '../features/tasks/TaskWorkspace';

export function AppRouter() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/today" replace />} />
        <Route
          path="today"
          element={
            <TaskWorkspace>
              <TodayPage />
            </TaskWorkspace>
          }
        />
        <Route
          path="tasks"
          element={
            <TaskWorkspace>
              <TaskCenterPage />
            </TaskWorkspace>
          }
        />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="habits" element={<HabitsPage />} />
        <Route path="focus" element={<FocusPage />} />
        <Route path="review" element={<ReviewPage />} />
        <Route
          path="lists"
          element={
            <TaskWorkspace>
              <ListsPage />
            </TaskWorkspace>
          }
        />
        <Route
          path="lists/:listId"
          element={
            <TaskWorkspace>
              <ListsPage />
            </TaskWorkspace>
          }
        />
        <Route path="knowledge" element={<KnowledgePage />} />
        {/* 画板没有独立落地页：旧书签回到知识页，笔记内深链仍走 board/:boardId。 */}
        <Route path="board" element={<Navigate to="/knowledge" replace />} />
        <Route path="board/:boardId" element={<BoardPage />} />
        <Route
          path="settings"
          element={<Navigate to="/settings/appearance" replace />}
        />
        <Route path="settings/:group" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/today" replace />} />
      </Route>
    </Routes>
  );
}
