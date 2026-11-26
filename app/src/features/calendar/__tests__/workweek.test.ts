import { describe, expect, it } from 'vitest';

import {
  dateExceptionOn,
  normalizeDateExceptions,
  removeDateException,
  upsertDateException,
} from '../../../data/calendar/exceptions';
import {
  builtinHolidayLookup,
  createHolidayLookup,
  holidayOn,
  type HolidayPackage,
} from '../../../data/calendar/holidays';
import {
  DEFAULT_WORKDAY_RULE,
  isAlternatingDoubleWeek,
  isRestStatus,
  isWorkday,
  monthGrid,
  normalizeWeekStart,
  normalizeWorkdayRule,
  startOfWeekISO,
  toggleCustomWorkday,
  weekDaysISO,
  weekNumberFor,
  weekdayLabels,
  weeklyWorkday,
  workdayStatus,
} from '../workweek';

describe('周起始', () => {
  it('默认周一；兼容 0/1 与旧文案', () => {
    expect(normalizeWeekStart(undefined)).toBe('monday');
    expect(normalizeWeekStart(1)).toBe('monday');
    expect(normalizeWeekStart(0)).toBe('sunday');
    expect(normalizeWeekStart('周日')).toBe('sunday');
    expect(normalizeWeekStart('monday')).toBe('monday');
    expect(normalizeWeekStart('乱写')).toBe('monday');
  });

  it('周一/周日周起始在跨月、跨年时都不经过 UTC 切日', () => {
    expect(weekDaysISO('2026-01-01', 'monday')).toEqual([
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
    expect(weekDaysISO('2026-01-01', 'sunday')).toEqual([
      '2025-12-28',
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ]);
    expect(startOfWeekISO('2026-01-01', 'sunday')).toBe('2025-12-28');
    expect(startOfWeekISO('2025-12-31', 'monday')).toBe('2025-12-29');
  });

  it('月视图固定 42 格；周起始只影响排列，不丢跨月日期', () => {
    const monday = monthGrid('2026-10', 'monday');
    const sunday = monthGrid('2026-10', 'sunday');

    expect(monday).toHaveLength(42);
    expect(sunday).toHaveLength(42);
    expect(monday[0].date).toBe('2026-09-28');
    expect(monday[41].date).toBe('2026-11-08');
    expect(sunday[0].date).toBe('2026-09-27');
    expect(sunday[41].date).toBe('2026-11-07');
    expect(monday.filter((cell) => cell.inMonth)).toHaveLength(31);
    expect(sunday.filter((cell) => cell.inMonth)).toHaveLength(31);

    // 跨年：2026-01 的周一开头从 2025-12-29 开始。
    expect(monthGrid('2026-01', 'monday')[0].date).toBe('2025-12-29');
    expect(monthGrid('2026-01', 'sunday')[0].date).toBe('2025-12-28');
    expect(monthGrid('2026-01', 'monday')[41].date).toBe('2026-02-08');
  });

  it('列头顺序随周起始调整', () => {
    expect(weekdayLabels('monday')).toEqual([
      '周一',
      '周二',
      '周三',
      '周四',
      '周五',
      '周六',
      '周日',
    ]);
    expect(weekdayLabels('sunday')).toEqual([
      '周日',
      '周一',
      '周二',
      '周三',
      '周四',
      '周五',
      '周六',
    ]);
  });

  it('周序号仍按 ISO 周一计算，周日开头取该行周一的周号', () => {
    expect(weekNumberFor('2026-09-28', 'monday')).toBe(40);
    expect(weekNumberFor('2026-09-27', 'sunday')).toBe(40);
    expect(weekNumberFor('2025-12-29', 'monday')).toBe(1);
    expect(weekNumberFor('2025-12-28', 'sunday')).toBe(1);
  });
});

describe('工作日规则', () => {
  it('双休：周一至周五上班，周末休息', () => {
    expect(weeklyWorkday('2026-10-30')).toBe(true); // 周五
    expect(weeklyWorkday('2026-10-31')).toBe(false); // 周六
    expect(weeklyWorkday('2026-11-01')).toBe(false); // 周日
  });

  it('单休：周一至周六上班，周日休息', () => {
    const rule = normalizeWorkdayRule('单休');
    expect(weeklyWorkday('2026-10-31', rule)).toBe(true);
    expect(weeklyWorkday('2026-11-01', rule)).toBe(false);
  });

  it('大小周：以锚点周为双休周，下一周周六上班', () => {
    const rule = normalizeWorkdayRule({
      rule: 'alternating',
      anchorMonday: '2026-10-19',
    });

    expect(rule.anchorMonday).toBe('2026-10-19');
    expect(isAlternatingDoubleWeek('2026-10-20', rule)).toBe(true);
    expect(weeklyWorkday('2026-10-24', rule)).toBe(false); // 双休周周六
    expect(isAlternatingDoubleWeek('2026-10-27', rule)).toBe(false);
    expect(weeklyWorkday('2026-10-31', rule)).toBe(true); // 单休周周六
    expect(weeklyWorkday('2026-11-01', rule)).toBe(false); // 周日始终休息
    expect(weeklyWorkday('2026-10-30', rule)).toBe(true);
  });

  it('自定义：只认勾选的周几，且至少保留一天', () => {
    const fourDay = normalizeWorkdayRule({
      rule: 'custom',
      customWorkdays: [1, 2, 3, 4],
    });
    expect(weeklyWorkday('2026-10-29', fourDay)).toBe(true); // 周四
    expect(weeklyWorkday('2026-10-30', fourDay)).toBe(false); // 周五

    let rule = normalizeWorkdayRule({ rule: 'custom', customWorkdays: [6] });
    rule = toggleCustomWorkday(rule, 7);
    expect(rule.customWorkdays).toEqual([6, 7]);
    rule = toggleCustomWorkday(rule, 7);
    expect(rule.customWorkdays).toEqual([6]);
    rule = toggleCustomWorkday(rule, 6);
    expect(rule.customWorkdays).toEqual([6]);
  });

  it('法定节假日/调休优先于周规则', () => {
    expect(workdayStatus('2026-10-01')).toBe('holiday');
    expect(isWorkday('2026-10-01')).toBe(false);
    expect(workdayStatus('2026-10-10')).toBe('makeup');
    expect(isWorkday('2026-10-10')).toBe(true);
    // 关闭官方覆盖后回到周六休息。
    expect(isWorkday('2026-10-10', DEFAULT_WORKDAY_RULE, {
      officialHolidays: false,
    })).toBe(false);
  });

  it('非法规则回退双休，不把坏值写进计算', () => {
    const rule = normalizeWorkdayRule({
      rule: 'unknown',
      anchorMonday: '2026-02-30',
      customWorkdays: [0, 1, 8, '5', 5],
    });
    expect(rule.rule).toBe('double');
    expect(rule.anchorMonday).toBeNull();
    expect(rule.customWorkdays).toEqual([1, 5]);
    expect(isWorkday('2026-10-26', rule)).toBe(true);

    // 旧数据可能只存自定义周几数组。
    const legacyArray = normalizeWorkdayRule([2, 4]);
    expect(legacyArray.rule).toBe('custom');
    expect(legacyArray.customWorkdays).toEqual([2, 4]);
  });
});

describe('个人日期例外与远程节假日包', () => {
  it('归一化时丢弃坏日期/坏类型，同日后者覆盖前者并排序', () => {
    const normalized = normalizeDateExceptions([
      { date: '2026-10-08', kind: 'rest', note: ' 请假 ' },
      { date: '2026-02-30', kind: 'work' },
      { date: '2026-10-09', kind: 'unknown' },
      { date: '2026-10-08', kind: 'work', note: '补班' },
      { date: '2025-12-31', kind: 'work' },
    ]);
    expect(normalized).toEqual([
      { date: '2025-12-31', kind: 'work', note: '' },
      { date: '2026-10-08', kind: 'work', note: '补班' },
    ]);
    expect(dateExceptionOn('2026-10-08', normalized)?.note).toBe('补班');
  });

  it('例外的增删改：同日更新而不是追加', () => {
    let list = upsertDateException([], {
      date: '2026-10-08',
      kind: 'rest',
      note: '请假',
    });
    expect(list).toHaveLength(1);
    list = upsertDateException(list, {
      date: '2026-10-08',
      kind: 'work',
      note: '临时上班',
    });
    expect(list).toEqual([
      { date: '2026-10-08', kind: 'work', note: '临时上班' },
    ]);
    expect(removeDateException(list, '2026-10-08')).toEqual([]);
  });

  it('个人例外 > 法定节假日/调休 > 周规则', () => {
    // 2026-10-01 法定节假日；例外上班应覆盖为工作。
    const holidayWork = normalizeDateExceptions([
      { date: '2026-10-01', kind: 'work', note: '值班' },
    ]);
    expect(workdayStatus('2026-10-01', DEFAULT_WORKDAY_RULE, {
      exceptions: holidayWork,
    })).toBe('exception-work');
    expect(isWorkday('2026-10-01', DEFAULT_WORKDAY_RULE, {
      exceptions: holidayWork,
    })).toBe(true);

    // 2026-10-10 法定调休上班；例外休息应覆盖为休息。
    const makeupRest = normalizeDateExceptions([
      { date: '2026-10-10', kind: 'rest', note: '请假' },
    ]);
    expect(workdayStatus('2026-10-10', DEFAULT_WORKDAY_RULE, {
      exceptions: makeupRest,
    })).toBe('exception-rest');
    expect(isWorkday('2026-10-10', DEFAULT_WORKDAY_RULE, {
      exceptions: makeupRest,
    })).toBe(false);
    expect(isRestStatus('exception-rest')).toBe(true);
    expect(isRestStatus('exception-work')).toBe(false);

    // 普通周六没有官方数据时，例外上班同样生效。
    const weekendWork = normalizeDateExceptions([
      { date: '2026-10-31', kind: 'work', note: '' },
    ]);
    expect(workdayStatus('2026-10-31', DEFAULT_WORKDAY_RULE, {
      exceptions: weekendWork,
    })).toBe('exception-work');
    expect(isWorkday('2026-10-31', DEFAULT_WORKDAY_RULE, {
      exceptions: weekendWork,
    })).toBe(true);
  });

  it('跨年例外与跨年日期都能命中', () => {
    const exceptions = normalizeDateExceptions([
      { date: '2025-12-31', kind: 'work', note: '跨年值班' },
      { date: '2026-01-01', kind: 'rest', note: '调休休息' },
    ]);
    expect(workdayStatus('2025-12-31', DEFAULT_WORKDAY_RULE, {
      exceptions,
    })).toBe('exception-work');
    expect(workdayStatus('2026-01-01', DEFAULT_WORKDAY_RULE, {
      exceptions,
    })).toBe('exception-rest');
    // 没有例外的跨年日期仍按官方节假日计算。
    expect(workdayStatus('2026-01-02', DEFAULT_WORKDAY_RULE, {
      exceptions,
    })).toBe('holiday');
  });

  it('远程包按年覆盖内置包，未覆盖年份继续用内置回退', () => {
    const remote: HolidayPackage = {
      year: 2026,
      days: [
        { date: '2026-03-01', name: '自定义假', isOffDay: true },
        { date: '2026-03-02', name: '自定义班', isOffDay: false },
      ],
      source: 'custom',
      version: 'fixture-1',
      origin: 'remote',
      fetchedAt: '2026-10-26T10:00:00.000Z',
      papers: [],
    };
    const lookup = createHolidayLookup([remote]);
    expect(holidayOn('2026-03-01', lookup)?.kind).toBe('holiday');
    expect(holidayOn('2026-03-02', lookup)?.kind).toBe('makeup');
    // 同年的内置国庆被远程包整体替换，避免同一年两份事实。
    expect(holidayOn('2026-10-01', lookup)).toBeNull();

    // 只缓存了其他年份时，2026 内置包仍继续生效。
    const remote2025: HolidayPackage = {
      ...remote,
      year: 2025,
      days: [{ date: '2025-05-01', name: '自定义假', isOffDay: true }],
    };
    const mixed = createHolidayLookup([remote2025]);
    expect(holidayOn('2026-10-01', mixed)?.kind).toBe('holiday');
    expect(holidayOn('2025-05-01', mixed)?.kind).toBe('holiday');
    expect(createHolidayLookup([])).toBe(builtinHolidayLookup);
  });
});
