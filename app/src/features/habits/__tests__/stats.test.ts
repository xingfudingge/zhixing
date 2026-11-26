import { describe, expect, it } from 'vitest';

import type { Habit, HabitLog } from '../../../data/db/types';
import {
  activeLogDates,
  addDays,
  bestStreak,
  currentStreak,
  DEFAULT_HABIT_ICON,
  groupLogs,
  HABIT_ICONS,
  habitIconLabel,
  habitStreak,
  habitToneOf,
  isFutureDate,
  monthDates,
  monthLabel,
  normalizeHabitIcon,
  reviewHabitStats,
  shiftMonth,
  weekDates,
  weeklyCompletion,
  weekdayIndex,
} from '../stats';

const TODAY = '2026-10-26';

function makeHabit(overrides: Partial<Habit> & Pick<Habit, 'id'>): Habit {
  return {
    spaceId: 'personal',
    title: overrides.id,
    schedule: '每天',
    icon: '✳',
    color: 'amber',
    goalPerWeek: 7,
    sortOrder: 0,
    archived: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function makeLog(
  habitId: string,
  logDate: string,
  overrides: Partial<HabitLog> = {},
): HabitLog {
  return {
    id: `log-${habitId}-${logDate}`,
    spaceId: 'personal',
    habitId,
    logDate,
    done: true,
    note: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

describe('习惯语义图标', () => {
  it('提供 12 个稳定 ASCII key，每个都有中文标签', () => {
    expect(HABIT_ICONS.map((item) => item.value)).toEqual([
      'read',
      'exercise',
      'water',
      'sleep',
      'meditate',
      'write',
      'study',
      'wake',
      'diet',
      'tidy',
      'music',
      'custom',
    ]);
    for (const item of HABIT_ICONS) {
      expect(item.value).toMatch(/^[a-z]+$/);
      expect(item.label).toMatch(/^[一-龥]+$/);
    }
    expect(DEFAULT_HABIT_ICON).toBe('custom');
  });

  it('旧字符与常见 emoji 映射到语义 key', () => {
    expect(normalizeHabitIcon('☀')).toBe('wake');
    expect(normalizeHabitIcon('▤')).toBe('read');
    expect(normalizeHabitIcon('◉')).toBe('meditate');
    expect(normalizeHabitIcon('✳')).toBe('custom');
    expect(normalizeHabitIcon('⌂')).toBe('custom');
    expect(normalizeHabitIcon('◇')).toBe('custom');
    expect(normalizeHabitIcon('📚')).toBe('read');
    expect(normalizeHabitIcon('🏃')).toBe('exercise');
    expect(normalizeHabitIcon('💧')).toBe('water');
    expect(normalizeHabitIcon('🌙')).toBe('sleep');
    expect(normalizeHabitIcon('🧘')).toBe('meditate');
    expect(normalizeHabitIcon('✍️')).toBe('write');
    expect(normalizeHabitIcon('🎓')).toBe('study');
    expect(normalizeHabitIcon('🌅')).toBe('wake');
    expect(normalizeHabitIcon('🍎')).toBe('diet');
    expect(normalizeHabitIcon('🧹')).toBe('tidy');
    expect(normalizeHabitIcon('🎵')).toBe('music');
  });

  it('新 key 原样保留，空值与未知值落到自定义', () => {
    expect(normalizeHabitIcon('read')).toBe('read');
    expect(normalizeHabitIcon('custom')).toBe('custom');
    expect(normalizeHabitIcon('')).toBe('custom');
    expect(normalizeHabitIcon(undefined)).toBe('custom');
    expect(normalizeHabitIcon('unknown-icon')).toBe('custom');
    expect(habitIconLabel('▤')).toBe('阅读');
    expect(habitIconLabel('📚')).toBe('阅读');
    expect(habitIconLabel('meditate')).toBe('冥想');
    expect(habitIconLabel('')).toBe('自定义');
  });

  it('颜色 tone 只接受四种设计 token，未知值回退琥珀', () => {
    expect(habitToneOf('violet')).toBe('violet');
    expect(habitToneOf('teal')).toBe('teal');
    expect(habitToneOf('red')).toBe('amber');
    expect(habitToneOf('')).toBe('amber');
  });
});

describe('习惯日期网格', () => {
  it('周视图固定周一开始，2026-10-26 是周一', () => {
    expect(weekdayIndex(TODAY)).toBe(0);
    expect(weekDates(TODAY)).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
  });

  it('月热力图覆盖整月，包含闰年二月', () => {
    expect(monthDates('2026-10')).toHaveLength(31);
    expect(monthDates('2024-02')).toHaveLength(29);
    expect(monthDates('2026-11')).toHaveLength(30);
    expect(monthLabel('2026-10')).toBe('2026 年 10 月');
  });

  it('月导航跨年', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
  });

  it('未来日期判定与加天', () => {
    expect(isFutureDate('2026-10-27', TODAY)).toBe(true);
    expect(isFutureDate(TODAY, TODAY)).toBe(false);
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('连续天数与最佳连续', () => {
  it('今天连续三天时当前连续为 3，最佳至少为 3', () => {
    const dates = new Set(['2026-10-24', '2026-10-25', '2026-10-26']);
    expect(currentStreak(dates, TODAY)).toBe(3);
    expect(bestStreak(dates)).toBe(3);
  });

  it('今天未打卡时从昨天向前数', () => {
    const dates = new Set(['2026-10-24', '2026-10-25']);
    expect(currentStreak(dates, TODAY)).toBe(2);
  });

  it('中间断档后重新开始，当前连续只算最近一段', () => {
    const dates = new Set([
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-25',
      '2026-10-26',
    ]);
    expect(currentStreak(dates, TODAY)).toBe(2);
    expect(bestStreak(dates)).toBe(3);
  });

  it('历史补卡把两段连起来，最佳立即重算', () => {
    const before = new Set(['2026-10-23', '2026-10-24', '2026-10-25']);
    expect(bestStreak(before)).toBe(3);
    const after = new Set([...before, '2026-10-22']);
    expect(bestStreak(after)).toBe(4);
  });

  it('软删除的日志不参与统计，done=false 也不参与', () => {
    const logs = [
      makeLog('read', '2026-10-24'),
      makeLog('read', '2026-10-25'),
      makeLog('read', '2026-10-26', { deletedAt: '2026-10-26T01:00:00.000Z' }),
      makeLog('read', '2026-10-23', { done: false }),
    ];
    expect([...activeLogDates(logs)]).toEqual(['2026-10-24', '2026-10-25']);
    expect(habitStreak(logs, TODAY)).toEqual({ current: 2, best: 2 });
  });
});

describe('周完成率与复盘汇总', () => {
  const habits = [makeHabit({ id: 'read' }), makeHabit({ id: 'run' })];
  const logsByHabit = {
    read: [
      makeLog('read', '2026-10-26'),
      makeLog('read', '2026-10-27'),
    ],
    run: [makeLog('run', '2026-10-27')],
  };

  it('周完成 = 本周打卡数 / 习惯数 × 7', () => {
    expect(weeklyCompletion(habits, logsByHabit, TODAY)).toMatchObject({
      checked: 3,
      total: 14,
      percent: 21,
    });
  });

  it('复盘习惯数与最长连续来自同一份日志', () => {
    expect(reviewHabitStats(habits, logsByHabit, TODAY)).toMatchObject({
      habitCount: 2,
      checks: 3,
      best: 2,
      weekStart: '2026-10-26',
      weekEnd: '2026-11-01',
    });
  });

  it('今天新增一次打卡，复盘 checks +1', () => {
    const before = reviewHabitStats(habits, logsByHabit, TODAY);
    const after = reviewHabitStats(
      habits,
      {
        ...logsByHabit,
        run: [...logsByHabit.run, makeLog('run', '2026-10-26')],
      },
      TODAY,
    );
    expect(after.checks).toBe(before.checks + 1);
  });

  it('没有习惯时不除零', () => {
    expect(weeklyCompletion([], {}, TODAY)).toMatchObject({
      checked: 0,
      total: 0,
      percent: 0,
    });
    expect(reviewHabitStats([], {}, TODAY).best).toBe(0);
  });

  it('groupLogs 按习惯顺序建立日志映射', () => {
    const map = groupLogs(habits, [
      [makeLog('read', '2026-10-26')],
      [],
    ]);
    expect(map.read).toHaveLength(1);
    expect(map.run).toEqual([]);
  });
});
