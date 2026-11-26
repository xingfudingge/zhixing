import { describe, expect, it } from 'vitest';

import {
  countdownDayLabel,
  countdownDays,
  countdownMetaText,
  nextCountdownDate,
  normalizeCountdownRepeat,
} from '../countdowns';
import {
  formatDayTitle,
  formatMonthTitle,
  formatWeekRange,
  isoWeekNumber,
  monthGrid,
  weekDaysISO,
} from '../date';
import { dayMeta, holidayOn } from '../holidays';
import {
  formatLunarText,
  lunarDayLabel,
  lunarInfo,
  nextLunarDate,
} from '../lunar';
import { solarTermOn } from '../terms';

const TODAY = '2026-10-26';

describe('日历日期与月网格', () => {
  it('月网格固定 42 格（6×7）且周一开头', () => {
    const cells = monthGrid('2026-10');
    expect(cells).toHaveLength(42);
    expect(cells[0].date).toBe('2026-09-28');
    expect(cells[41].date).toBe('2026-11-08');
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(31);
  });

  it('周视图 7 列从周一开始，标题跨月也完整', () => {
    const days = weekDaysISO('2026-10-26');
    expect(days).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
    expect(formatWeekRange('2026-10-26')).toBe('10月26日 – 11月1日');
    expect(formatDayTitle('2026-10-26')).toBe('10月26日 周一');
    expect(formatMonthTitle('2026-10')).toBe('2026 年 10 月');
    expect(isoWeekNumber('2026-10-26')).toBe(44);
  });
});

describe('农历、节气与 2026 休班数据包', () => {
  it('公历转农历：春节正月初一、干支与生肖', () => {
    const info = lunarInfo('2026-02-17');
    expect(info).toMatchObject({
      month: '正月',
      day: 1,
      yearName: '丙午',
      zodiac: '马',
      leap: false,
    });
    expect(lunarDayLabel(17)).toBe('十七');
    expect(lunarDayLabel(20)).toBe('二十');
    expect(lunarDayLabel(30)).toBe('三十');
    expect(formatLunarText('2026-02-17', {
      includeYear: true,
      includeZodiac: true,
    })).toBe('丙午年 正月初一 生肖马');
  });

  it('下一次农历正月初一 = 2027-02-07（跳过 2027-02-06 的腊月三十）', () => {
    expect(nextLunarDate('正月', 1, TODAY)).toBe('2027-02-07');
  });

  it('2026 休/班与节气标记正确', () => {
    expect(holidayOn('2026-10-01')).toMatchObject({
      name: '国庆',
      kind: 'holiday',
      label: '休',
    });
    expect(holidayOn('2026-10-10')).toMatchObject({
      kind: 'makeup',
      label: '班',
    });
    expect(solarTermOn('2026-10-08')).toBe('寒露');
    const meta = dayMeta('2026-10-08');
    expect(meta.solarTerm).toBe('寒露');
    expect(meta.lunarLabel).toBe('寒露');
    expect(dayMeta('2026-10-26').lunarLabel).toBe('十七');
  });
});

describe('倒数日：单次、每年、每年（农历）', () => {
  it('农历每年：从今天找下一次公历日并计算剩余天数', () => {
    const countdown = {
      calendarType: 'lunar' as const,
      targetDate: '2026-02-17',
      repeatRule: '每年（农历）',
      lunarMonth: '正月',
      lunarDay: 1,
    };
    expect(nextCountdownDate(countdown, TODAY)).toBe('2027-02-07');
    expect(countdownDays(countdown, TODAY)).toBe(104);
    expect(countdownDayLabel(countdown, TODAY)).toBe('还有 104 天');
    expect(countdownMetaText(
      { ...countdown, category: '热门节日' },
      TODAY,
    )).toContain('农历 正月初一 · 2027-02-07');
  });

  it('公历每年：今年已过则取明年', () => {
    const countdown = {
      calendarType: 'solar' as const,
      targetDate: '2026-01-01',
      repeatRule: '每年',
      lunarMonth: null,
      lunarDay: null,
    };
    expect(nextCountdownDate(countdown, TODAY)).toBe('2027-01-01');
    expect(countdownDays(countdown, TODAY)).toBe(67);
  });

  it('单次过去显示「已过去 N 天」，今天显示「就是今天」', () => {
    const past = {
      calendarType: 'solar' as const,
      targetDate: '2026-10-01',
      repeatRule: '单次',
      lunarMonth: null,
      lunarDay: null,
    };
    expect(countdownDays(past, TODAY)).toBe(-25);
    expect(countdownDayLabel(past, TODAY)).toBe('已过去 25 天');

    const todayCountdown = { ...past, targetDate: TODAY };
    expect(countdownDays(todayCountdown, TODAY)).toBe(0);
    expect(countdownDayLabel(todayCountdown, TODAY)).toBe('就是今天');
  });

  it('农历 + 每年收敛为「每年（农历）」，公历 + 每年收敛为「每年」', () => {
    expect(normalizeCountdownRepeat('lunar', '每年')).toBe('每年（农历）');
    expect(normalizeCountdownRepeat('solar', '每年（农历）')).toBe('每年');
    expect(normalizeCountdownRepeat('lunar', '单次')).toBe('单次');
  });

  it('2 月 29 日每年按构造日期滚动到 3 月 1 日（原型边界）', () => {
    const leap = {
      calendarType: 'solar' as const,
      targetDate: '2024-02-29',
      repeatRule: '每年',
      lunarMonth: null,
      lunarDay: null,
    };
    expect(nextCountdownDate(leap, TODAY)).toBe('2027-03-01');
  });
});
