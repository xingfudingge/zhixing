/**
 * 复盘域的纯函数：最近 7 天范围、三卡汇总、日柱、最近完成、专注 Top5
 * 与复盘笔记正文。
 *
 * 数据只读：
 * * 任务完成日只看 `completedAt`，绝不回退到 `dueDate`（P0-09 禁区）；
 * * 专注按 `startedAt` 的本地日历日归属；
 * * 习惯按 `habit_logs.log_date` 归属；
 * * 所有计算不修改传入的任务 / 专注 / 打卡对象。
 *
 * 柱高归一化对 0 或非法值返回 0，不会出现 NaN。
 */

import type {
  FocusSession,
  Habit,
  HabitLog,
  List,
  Task,
} from '../../data/db/types';
import {
  addDaysISO,
  formatWeekday,
  todayISO,
} from '../../data/calendar/date';

export const REVIEW_DAYS = 7;

export type ReviewRange = {
  from: string;
  to: string;
};

export type ReviewDay = {
  date: string;
  weekday: string;
  taskCount: number;
  focusMinutes: number;
  habitChecks: number;
};

export type ReviewMetric = 'tasks' | 'focus' | 'habits';

export const REVIEW_METRICS: ReadonlyArray<{
  value: ReviewMetric;
  label: string;
  ariaLabel: string;
}> = [
  { value: 'tasks', label: '完成任务', ariaLabel: '完成任务' },
  { value: 'focus', label: '专注分钟', ariaLabel: '专注分钟' },
  { value: 'habits', label: '习惯打卡', ariaLabel: '习惯打卡' },
];

export type ReviewCompletedItem = {
  id: string;
  title: string;
  listName: string;
  completedAt: string;
  completedDate: string;
};

export type ReviewFocusRank = {
  taskId: string;
  title: string;
  minutes: number;
  share: number;
};

export type ReviewSourceIds = {
  taskIds: string[];
  focusIds: string[];
  habitIds: string[];
};

export type ReviewNoteContent = {
  title: string;
  body: string;
  tags: string[];
};

export type ReviewAggregate = {
  range: ReviewRange;
  rangeLabel: string;
  days: ReviewDay[];
  totals: {
    tasks: number;
    focusMinutes: number;
    habits: number;
  };
  habitCount: number;
  recentCompleted: ReviewCompletedItem[];
  focusTop: ReviewFocusRank[];
  sourceIds: ReviewSourceIds;
  note: ReviewNoteContent;
};

export type BuildReviewInput = {
  today: string;
  days?: number;
  tasks: Task[];
  sessions: FocusSession[];
  habits: Habit[];
  logsByHabit: Record<string, HabitLog[]>;
  lists?: List[];
};

/** 今天及前 n-1 天，升序；全部使用本地日历日。 */
export function reviewRange(today: string, days = REVIEW_DAYS): ReviewRange {
  const span = Math.max(1, Math.floor(days));
  return { from: addDaysISO(today, -(span - 1)), to: today };
}

export function reviewDates(range: ReviewRange, days = REVIEW_DAYS): string[] {
  const span = Math.max(1, Math.floor(days));
  return Array.from({ length: span }, (_, index) =>
    addDaysISO(range.from, index),
  );
}

/**
 * 时间戳的本地日历日。`completedAt` 由 SQLite 以 UTC `Z` 写入，
 * 直接截前 10 位会在东八区跨日；这里按本地时区换算。
 */
export function localDateOfTimestamp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    const date = new Date(parsed);
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate(),
    )}`;
  }
  const prefix = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(prefix) ? prefix : null;
}

export function focusSessionDate(session: FocusSession): string {
  return session.startedAt.slice(0, 10);
}

function inRange(date: string, range: ReviewRange): boolean {
  return date >= range.from && date <= range.to;
}

function activeLogs(logs: HabitLog[] | undefined, range: ReviewRange): HabitLog[] {
  return (logs ?? []).filter(
    (log) => log.done && log.deletedAt === null && inRange(log.logDate, range),
  );
}

/** 柱高：0 或非法值返回 0，非零至少 4%，最大 100%。 */
export function barPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  return Math.max(4, Math.min(100, Math.round((value / safeMax) * 100)));
}

export function metricValue(day: ReviewDay, metric: ReviewMetric): number {
  if (metric === 'focus') {
    return day.focusMinutes;
  }
  if (metric === 'habits') {
    return day.habitChecks;
  }
  return day.taskCount;
}

export function metricTotal(
  aggregate: Pick<ReviewAggregate, 'totals'>,
  metric: ReviewMetric,
): number {
  if (metric === 'focus') {
    return aggregate.totals.focusMinutes;
  }
  if (metric === 'habits') {
    return aggregate.totals.habits;
  }
  return aggregate.totals.tasks;
}

export function metricMax(days: ReviewDay[], metric: ReviewMetric): number {
  return Math.max(1, ...days.map((day) => metricValue(day, metric)));
}

export function formatDuration(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  if (safe < 60) {
    return `${safe} 分钟`;
  }
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/** 统计卡主数值：不足 1 小时用分钟，否则用小时（保留 1 位）。 */
export function focusCardValue(minutes: number): {
  value: string;
  unit: string;
} {
  const safe = Math.max(0, Math.round(minutes));
  if (safe < 60) {
    return { value: String(safe), unit: '分钟' };
  }
  return { value: (safe / 60).toFixed(1).replace(/\.0$/, ''), unit: '小时' };
}

const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]);
}

function summarizeDay(day: ReviewDay): string {
  return `${formatWeekday(day.date)}：完成任务 ${day.taskCount} 项 · 专注 ${day.focusMinutes} 分钟 · 习惯打卡 ${day.habitChecks} 次`;
}

/**
 * 复盘笔记正文是保存那一刻的快照文本；编辑正文不会影响源数据，
 * 再次统计仍从任务 / 专注 / 习惯事实行读取。
 */
export function buildReviewNoteBody(input: {
  range: ReviewRange;
  days: ReviewDay[];
  totals: ReviewAggregate['totals'];
  recentCompleted: ReviewCompletedItem[];
  focusTop: ReviewFocusRank[];
  sourceIds: ReviewSourceIds;
  tasks: Task[];
  sessions: FocusSession[];
  habits: Habit[];
}): string {
  const {
    range,
    days,
    totals,
    recentCompleted,
    focusTop,
    sourceIds,
    tasks,
    sessions,
    habits,
  } = input;

  const taskTitles = new Map(tasks.map((task) => [task.id, task.title]));
  const habitTitles = new Map(habits.map((habit) => [habit.id, habit.title]));

  const completedList = recentCompleted.length
    ? recentCompleted
        .map(
          (item) =>
            `<li>${escapeHtml(item.title)}（${escapeHtml(item.listName)} · ${escapeHtml(item.completedDate)}）</li>`,
        )
        .join('')
    : '<li>这段时间还没有完成任务</li>';

  const focusList = focusTop.length
    ? focusTop
        .map(
          (item) =>
            `<li>${escapeHtml(item.title)} · ${item.minutes} 分钟（${item.share}%）</li>`,
        )
        .join('')
    : '<li>还没有专注记录</li>';

  const dayList = days
    .map((day) => `<li>${escapeHtml(summarizeDay(day))}</li>`)
    .join('');

  const taskSources = sourceIds.taskIds
    .map(
      (id) =>
        `<li data-source-type="task" data-source-id="${escapeHtml(id)}">任务：${escapeHtml(
          taskTitles.get(id) ?? id,
        )}</li>`,
    )
    .join('');
  const focusSources = sourceIds.focusIds
    .map((id) => {
      const session = sessions.find((item) => item.id === id);
      return `<li data-source-type="focus" data-source-id="${escapeHtml(
        id,
      )}">专注：${escapeHtml(
        session ? `${focusSessionDate(session)} · ${session.minutes} 分钟` : id,
      )}</li>`;
    })
    .join('');
  const habitSources = sourceIds.habitIds
    .map(
      (id) =>
        `<li data-source-type="habit" data-source-id="${escapeHtml(id)}">习惯：${escapeHtml(
          habitTitles.get(id) ?? id,
        )}</li>`,
    )
    .join('');
  const sourceItems = [taskSources, focusSources, habitSources].join('');

  return [
    `<div class="review-note-snapshot" data-review-range-start="${escapeHtml(
      range.from,
    )}" data-review-range-end="${escapeHtml(range.to)}">`,
    `<p><strong>复盘范围</strong>：${escapeHtml(range.from)} 至 ${escapeHtml(
      range.to,
    )}（最近 ${days.length} 天）</p>`,
    `<h2>本周数据</h2>`,
    `<ul>`,
    `<li>完成任务：${totals.tasks} 项</li>`,
    `<li>专注时长：${totals.focusMinutes} 分钟</li>`,
    `<li>习惯打卡：${totals.habits} 次</li>`,
    `</ul>`,
    `<h2>最近完成</h2>`,
    `<ul>${completedList}</ul>`,
    `<h2>专注分布</h2>`,
    `<ul>${focusList}</ul>`,
    `<h2>分日明细</h2>`,
    `<ul>${dayList}</ul>`,
    `<h2>来源</h2>`,
    `<p>以下来源仅用于回链，复盘不会修改任务、专注或习惯记录。</p>`,
    `<ul>${sourceItems || '<li>本范围没有来源记录</li>'}</ul>`,
    `</div>`,
  ].join('');
}

export function buildReviewAggregate(input: BuildReviewInput): ReviewAggregate {
  const days = Math.max(1, Math.floor(input.days ?? REVIEW_DAYS));
  const range = reviewRange(input.today, days);
  const dates = reviewDates(range, days);
  const taskRows = input.tasks.filter(
    (task) => task.deletedAt === null && task.status === 'done',
  );
  const completedRows = taskRows.filter((task) => {
    const date = localDateOfTimestamp(task.completedAt);
    return date !== null && inRange(date, range);
  });
  const sessionRows = input.sessions.filter(
    (session) =>
      session.deletedAt === null && inRange(focusSessionDate(session), range),
  );
  const logRows = input.habits.flatMap((habit) =>
    activeLogs(input.logsByHabit[habit.id], range),
  );

  const taskCountByDate = new Map<string, number>();
  for (const task of completedRows) {
    const date = localDateOfTimestamp(task.completedAt);
    if (date) {
      taskCountByDate.set(date, (taskCountByDate.get(date) ?? 0) + 1);
    }
  }

  const focusByDate = new Map<string, number>();
  for (const session of sessionRows) {
    const date = focusSessionDate(session);
    focusByDate.set(date, (focusByDate.get(date) ?? 0) + session.minutes);
  }

  const habitChecksByDate = new Map<string, number>();
  for (const log of logRows) {
    habitChecksByDate.set(
      log.logDate,
      (habitChecksByDate.get(log.logDate) ?? 0) + 1,
    );
  }

  const reviewDays: ReviewDay[] = dates.map((date) => ({
    date,
    weekday: formatWeekday(date),
    taskCount: taskCountByDate.get(date) ?? 0,
    focusMinutes: focusByDate.get(date) ?? 0,
    habitChecks: habitChecksByDate.get(date) ?? 0,
  }));

  const totals = {
    tasks: completedRows.length,
    focusMinutes: sessionRows.reduce((sum, session) => sum + session.minutes, 0),
    habits: logRows.length,
  };

  const listNames = new Map(
    (input.lists ?? []).map((list) => [list.id, list.name]),
  );
  const recentCompleted = completedRows
    .slice()
    .sort((left, right) => {
      const leftTime = left.completedAt ? Date.parse(left.completedAt) : 0;
      const rightTime = right.completedAt ? Date.parse(right.completedAt) : 0;
      const diff =
        (Number.isFinite(rightTime) ? rightTime : 0) -
        (Number.isFinite(leftTime) ? leftTime : 0);
      return diff !== 0 ? diff : left.id.localeCompare(right.id);
    })
    .slice(0, 6)
    .map((task) => ({
      id: task.id,
      title: task.title,
      listName: listNames.get(task.listId) ?? '未分组清单',
      completedAt: task.completedAt ?? '',
      completedDate:
        localDateOfTimestamp(task.completedAt) ?? task.completedAt?.slice(0, 10) ?? '',
    }));

  const focusByTask = new Map<string, number>();
  for (const session of sessionRows) {
    focusByTask.set(
      session.taskId,
      (focusByTask.get(session.taskId) ?? 0) + session.minutes,
    );
  }
  const taskTitles = new Map(input.tasks.map((task) => [task.id, task.title]));
  const focusTotal = totals.focusMinutes;
  const focusTop = [...focusByTask.entries()]
    .sort((left, right) => {
      const diff = right[1] - left[1];
      return diff !== 0 ? diff : left[0].localeCompare(right[0]);
    })
    .slice(0, 5)
    .map(([taskId, minutes]) => ({
      taskId,
      title: taskTitles.get(taskId) ?? '已删除任务',
      minutes,
      share: focusTotal > 0 ? Math.round((minutes / focusTotal) * 100) : 0,
    }));

  const sourceIds: ReviewSourceIds = {
    taskIds: completedRows.map((task) => task.id),
    focusIds: sessionRows.map((session) => session.id),
    habitIds: [...new Set(logRows.map((log) => log.habitId))],
  };

  const note: ReviewNoteContent = {
    title: `复盘 · ${range.to}`,
    tags: ['复盘'],
    body: buildReviewNoteBody({
      range,
      days: reviewDays,
      totals,
      recentCompleted,
      focusTop,
      sourceIds,
      tasks: input.tasks,
      sessions: input.sessions,
      habits: input.habits,
    }),
  };

  return {
    range,
    rangeLabel: `${range.from} 至 ${range.to}`,
    days: reviewDays,
    totals,
    habitCount: input.habits.length,
    recentCompleted,
    focusTop,
    sourceIds,
    note,
  };
}

/** 页面默认“今天”；测试注入固定日期。 */
export function currentReviewToday(): string {
  return todayISO();
}
