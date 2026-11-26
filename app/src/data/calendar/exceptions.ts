/**
 * 个人日期例外（调休 / 请假 / 临时上班）。
 *
 * 例外是用户自己的工作日事实，优先级高于法定节假日/调休，也高于周规则：
 *
 *   个人日期例外 > 法定节假日/调休 > 周规则
 *
 * 本模块只做纯数据归一化，不读写设置、不碰任务与提醒时区。
 */

import { isValidISODate } from './date';

export type DateExceptionKind = 'work' | 'rest';

export type DateException = {
  /** 本地日历日 `YYYY-MM-DD`。 */
  date: string;
  /** work=临时上班/调休上班；rest=请假/调休休息。 */
  kind: DateExceptionKind;
  /** 可选备注；只存用户输入，不写日志。 */
  note: string;
};

export const DATE_EXCEPTION_KIND_LABELS: Readonly<
  Record<DateExceptionKind, string>
> = {
  work: '上班',
  rest: '休息',
};

export const MAX_DATE_EXCEPTION_NOTE_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeKind(value: unknown): DateExceptionKind | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim().toLowerCase();
  if (text === 'work' || text === '上班' || text === '临时上班' || text === '调休上班') {
    return 'work';
  }
  if (text === 'rest' || text === '休息' || text === '请假' || text === '调休休息') {
    return 'rest';
  }
  return null;
}

function normalizeNote(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, MAX_DATE_EXCEPTION_NOTE_LENGTH);
}

/**
 * 容错解析例外数组。
 *
 * - 坏日期、坏类型直接丢弃，不伪造例外；
 * - 同一天多条时后出现的覆盖先出现的（与设置页“改同一天=更新”一致）；
 * - 结果按日期升序，便于设置页与日历稳定展示。
 */
export function normalizeDateExceptions(value: unknown): DateException[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const byDate = new Map<string, DateException>();
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const date = typeof item.date === 'string' ? item.date.trim() : '';
    if (!isValidISODate(date)) {
      continue;
    }
    const kind = normalizeKind(item.kind);
    if (!kind) {
      continue;
    }
    byDate.set(date, {
      date,
      kind,
      note: normalizeNote(item.note),
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function dateExceptionOn(
  date: string,
  exceptions: readonly DateException[] | null | undefined,
): DateException | null {
  if (!exceptions || exceptions.length === 0) {
    return null;
  }
  return exceptions.find((item) => item.date === date) ?? null;
}

/** 新增或更新同一天的例外；返回排序后的新数组，不修改入参。 */
export function upsertDateException(
  exceptions: readonly DateException[],
  next: DateException,
): DateException[] {
  const normalized = normalizeDateExceptions([
    ...exceptions.filter((item) => item.date !== next.date),
    next,
  ]);
  return normalized;
}

/** 删除某天的例外；日期非法时不改变列表。 */
export function removeDateException(
  exceptions: readonly DateException[],
  date: string,
): DateException[] {
  if (!isValidISODate(date)) {
    return normalizeDateExceptions(exceptions);
  }
  return normalizeDateExceptions(
    exceptions.filter((item) => item.date !== date),
  );
}

export function dateExceptionLabel(exception: DateException): string {
  return `${DATE_EXCEPTION_KIND_LABELS[exception.kind]}${
    exception.note ? ` · ${exception.note}` : ''
  }`;
}
