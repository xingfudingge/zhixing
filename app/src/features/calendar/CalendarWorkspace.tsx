/** 日历页注入边界：Toast/Undo → 任务数据 → 日历数据 → 日历工作台。 */

import type { TaskSource } from '../tasks/TaskStore';
import { TaskWorkspace } from '../tasks/TaskWorkspace';
import { CalendarPage } from './CalendarPage';
import {
  CalendarDataProvider,
  type CalendarSource,
} from './CalendarStore';
import type { CalendarTab, CalendarView } from './viewModel';

export type CalendarWorkspaceProps = {
  taskSource?: TaskSource;
  calendarSource?: CalendarSource;
  today?: string;
  available?: boolean;
  initialView?: CalendarView;
  initialTab?: CalendarTab;
  initialDate?: string;
};

export function CalendarWorkspace({
  taskSource,
  calendarSource,
  today,
  available,
  initialView,
  initialTab,
  initialDate,
}: CalendarWorkspaceProps) {
  return (
    <TaskWorkspace source={taskSource} today={today} available={available}>
      <CalendarDataProvider source={calendarSource} available={available}>
        <CalendarPage
          initialView={initialView}
          initialTab={initialTab}
          initialDate={initialDate}
        />
      </CalendarDataProvider>
    </TaskWorkspace>
  );
}
