/**
 * 专注统计的纯函数。
 *
 * 统计只读取 `focus_sessions` 事实行，不再维护一份独立计数器；今日/本周/
 * 复盘都从同一批记录推导，避免“记录成功但统计没动”的两套真相。
 *
 * 时间约定：
 * * 写入时使用本地时间 + 时区偏移（如 `2026-10-26T09:00:00+08:00`），
 *   数据库按 `substr(started_at, 1, 10)` 过滤时得到的是本机日历日；
 * * “本周”沿用原型的最近 7 天（含今天），与复盘“最近 7 天”一致。
 */

import type { FocusSession } from '../../data/db/types';

const pad2 = (value: number) => String(value).padStart(2, '0');

/** 本机日历日 `YYYY-MM-DD`，不经过 UTC，避免东八区跨日。 */
export function localDateFromMs(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate(),
  )}`;
}

/**
 * 带本机时区偏移的 ISO 时间。SQLite 的日期过滤只取前 10 位，
 * 因此这里必须保留本地日期，不能直接 `toISOString()`（UTC）。
 */
export function localIsoFromMs(ms: number): string {
  const date = new Date(ms);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(
    absolute % 60,
  )}`;
  return `${localDateFromMs(ms)}T${pad2(date.getHours())}:${pad2(
    date.getMinutes(),
  )}:${pad2(date.getSeconds())}${offset}`;
}

/** 记录归属日：与 Rust 查询 `substr(started_at, 1, 10)` 保持一致。 */
export function focusSessionDate(session: FocusSession): string {
  return session.startedAt.slice(0, 10);
}

/** 在 `YYYY-MM-DD` 上加减天数，使用本地日历。 */
export function addDays(date: string, delta: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(year, month - 1, day + delta);
  return localDateFromMs(next.getTime());
}

/** 最近 n 天（含今天），升序。 */
export function recentDates(today: string, days: number): string[] {
  return Array.from({ length: Math.max(0, days) }, (_, index) =>
    addDays(today, index - (days - 1)),
  );
}

export function focusSessionsOn(
  sessions: FocusSession[],
  date: string,
): FocusSession[] {
  return sessions.filter(
    (session) => session.deletedAt === null && focusSessionDate(session) === date,
  );
}

export function focusMinutesOn(
  sessions: FocusSession[],
  date: string,
): number {
  return focusSessionsOn(sessions, date).reduce(
    (total, session) => total + session.minutes,
    0,
  );
}

/** 闭区间分钟合计，供复盘按范围取数。 */
export function focusMinutesBetween(
  sessions: FocusSession[],
  from: string,
  to: string,
): number {
  return sessions
    .filter((session) => {
      if (session.deletedAt !== null) {
        return false;
      }
      const date = focusSessionDate(session);
      return date >= from && date <= to;
    })
    .reduce((total, session) => total + session.minutes, 0);
}

export type FocusSummary = {
  todayCount: number;
  todayMinutes: number;
  weekCount: number;
  weekMinutes: number;
};

export function summarizeFocus(
  sessions: FocusSession[],
  today: string,
  days = 7,
): FocusSummary {
  const dates = new Set(recentDates(today, days));
  let todayCount = 0;
  let todayMinutes = 0;
  let weekCount = 0;
  let weekMinutes = 0;

  for (const session of sessions) {
    if (session.deletedAt !== null) {
      continue;
    }
    const date = focusSessionDate(session);
    if (date === today) {
      todayCount += 1;
      todayMinutes += session.minutes;
    }
    if (dates.has(date)) {
      weekCount += 1;
      weekMinutes += session.minutes;
    }
  }

  return { todayCount, todayMinutes, weekCount, weekMinutes };
}

function sessionTime(session: FocusSession): number {
  const parsed = Date.parse(session.startedAt);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  const created = Date.parse(session.createdAt);
  return Number.isFinite(created) ? created : 0;
}

/** 最近记录：按开始时间倒序，时间相同时用 id 保证稳定。 */
export function recentFocusSessions(
  sessions: FocusSession[],
  limit = 6,
): FocusSession[] {
  return sessions
    .filter((session) => session.deletedAt === null)
    .slice()
    .sort((left, right) => {
      const diff = sessionTime(right) - sessionTime(left);
      return diff !== 0 ? diff : right.id.localeCompare(left.id);
    })
    .slice(0, Math.max(0, limit));
}

export function formatMinutes(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  if (safe < 60) {
    return `${safe} 分钟`;
  }
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}
