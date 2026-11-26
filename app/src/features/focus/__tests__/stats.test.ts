import { describe, expect, it } from 'vitest';

import {
  addDays,
  focusMinutesBetween,
  focusMinutesOn,
  formatMinutes,
  localDateFromMs,
  localIsoFromMs,
  recentFocusSessions,
  summarizeFocus,
} from '../stats';
import { makeSession, TEST_TODAY } from './fakeFocusSource';

describe('专注统计', () => {
  it('今日次数/分钟与最近 7 天分钟从同一批事实记录汇总', () => {
    const sessions = [
      makeSession({
        id: 'focus-today',
        taskId: 'task-review',
        minutes: 25,
        startedAt: '2026-10-26T09:00:00+08:00',
      }),
      makeSession({
        id: 'focus-today-2',
        taskId: 'task-review',
        minutes: 15,
        startedAt: '2026-10-26T14:00:00+08:00',
        mode: 'countdown',
      }),
      makeSession({
        id: 'focus-week',
        taskId: 'task-review',
        minutes: 30,
        startedAt: '2026-10-22T09:00:00+08:00',
        mode: 'manual',
      }),
      makeSession({
        id: 'focus-old',
        taskId: 'task-review',
        minutes: 50,
        startedAt: '2026-10-10T09:00:00+08:00',
      }),
      makeSession({
        id: 'focus-deleted',
        taskId: 'task-review',
        minutes: 90,
        startedAt: '2026-10-26T10:00:00+08:00',
        deletedAt: '2026-10-26T11:00:00.000Z',
      }),
    ];

    expect(summarizeFocus(sessions, TEST_TODAY, 7)).toEqual({
      todayCount: 2,
      todayMinutes: 40,
      weekCount: 3,
      weekMinutes: 70,
    });
    expect(focusMinutesOn(sessions, TEST_TODAY)).toBe(40);
    expect(focusMinutesBetween(sessions, '2026-10-20', TEST_TODAY)).toBe(70);
  });

  it('最近记录按开始时间倒序，过滤软删除', () => {
    const sessions = [
      makeSession({
        id: 'focus-old',
        taskId: 'task-review',
        minutes: 25,
        startedAt: '2026-10-24T09:00:00+08:00',
      }),
      makeSession({
        id: 'focus-new',
        taskId: 'task-review',
        minutes: 45,
        startedAt: '2026-10-26T09:00:00+08:00',
      }),
      makeSession({
        id: 'focus-deleted',
        taskId: 'task-review',
        minutes: 60,
        startedAt: '2026-10-27T09:00:00+08:00',
        deletedAt: '2026-10-27T10:00:00.000Z',
      }),
    ];

    expect(
      recentFocusSessions(sessions, 5).map((session) => session.id),
    ).toEqual(['focus-new', 'focus-old']);
  });

  it('日期加减与本地 ISO 保留本机日历日', () => {
    expect(addDays('2026-10-26', -6)).toBe('2026-10-20');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');

    const noon = new Date(2026, 9, 26, 12, 30, 5).getTime();
    expect(localDateFromMs(noon)).toBe('2026-10-26');
    expect(localIsoFromMs(noon)).toMatch(
      /^2026-10-26T12:30:05[+-]\d{2}:\d{2}$/,
    );
  });

  it('分钟文案在小时与分钟之间切换', () => {
    expect(formatMinutes(0)).toBe('0 分钟');
    expect(formatMinutes(45)).toBe('45 分钟');
    expect(formatMinutes(60)).toBe('1 小时');
    expect(formatMinutes(95)).toBe('1 小时 35 分钟');
  });
});
