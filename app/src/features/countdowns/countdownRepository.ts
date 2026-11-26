/**
 * 倒数日仓储封装。写入前收敛「历法 + 重复」组合，避免出现
 * 农历 + 每年（公历）这类语义冲突的数据。
 */

import type { DbClient } from '../../data/db/client';
import type {
  Countdown,
  CountdownQuery,
  CountdownUpdate,
  NewCountdown,
} from '../../data/db/types';
import {
  deriveLunarFields,
  normalizeCalendarType,
  normalizeCountdownRepeat,
} from '../../data/calendar/countdowns';

export type CountdownRepository = {
  list: (query?: CountdownQuery) => Promise<Countdown[]>;
  create: (input: NewCountdown) => Promise<Countdown>;
  update: (id: string, input: CountdownUpdate) => Promise<Countdown>;
  remove: (id: string) => Promise<void>;
};

export function createCountdownRepository(
  client: DbClient,
): CountdownRepository {
  return {
    list: (query: CountdownQuery = {}) => client.countdowns.list(query),
    create: (input: NewCountdown) => client.countdowns.create(input),
    update: (id: string, input: CountdownUpdate) =>
      client.countdowns.update(id, input),
    remove: (id: string) => client.countdowns.remove(id),
  };
}

export type CountdownPatch = Partial<
  Pick<
    Countdown,
    | 'title'
    | 'category'
    | 'calendarType'
    | 'targetDate'
    | 'repeatRule'
    | 'lunarMonth'
    | 'lunarDay'
    | 'note'
    | 'color'
  >
>;

export function toCountdownUpdate(
  countdown: Countdown,
  patch: CountdownPatch,
): CountdownUpdate {
  const next = { ...countdown, ...patch };
  return {
    title: next.title.trim(),
    category: next.category || '自定义',
    calendarType: normalizeCalendarType(next.calendarType),
    targetDate: next.targetDate,
    repeatRule: next.repeatRule || '单次',
    lunarMonth: next.lunarMonth,
    lunarDay: next.lunarDay,
    note: next.note,
    color: next.color || '',
  };
}

export type CountdownDraft = {
  title: string;
  category: string;
  calendarType: 'solar' | 'lunar';
  targetDate: string;
  repeatRule: string;
  note: string;
};

/** 表单草稿 -> 仓储输入；农历模式从目标公历日派生农历月/日。 */
export function toNewCountdown(draft: CountdownDraft): NewCountdown {
  const calendarType = normalizeCalendarType(draft.calendarType);
  const repeatRule = normalizeCountdownRepeat(calendarType, draft.repeatRule);
  const lunar =
    calendarType === 'lunar' ? deriveLunarFields(draft.targetDate) : null;
  return {
    title: draft.title.trim(),
    category: draft.category,
    calendarType,
    targetDate: draft.targetDate,
    repeatRule,
    lunarMonth: lunar?.lunarMonth ?? null,
    lunarDay: lunar?.lunarDay ?? null,
    note: draft.note,
    color: '',
  };
}
