/**
 * ICS 只读订阅领域类型。
 *
 * ICS 不是双向日历：订阅对象只有 `readOnly: true`，本模块不提供写回、
 * 删除远端事件或“同步修改到日历”的能力。导入的事件仅作为本地镜像。
 */

import type { NewEvent } from '../../../data/db/types';

export type IcsSubscription = {
  id: string;
  name: string;
  url: string;
  color: string;
  enabled: boolean;
  /** 类型层面固定；UI 不得出现可写状态。 */
  readOnly: true;
  etag: string | null;
  lastModified: string | null;
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  /** 最近一次成功解析中的警告（缺 UID/坏日期等）；重启后仍可回显。 */
  lastWarning: string | null;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
};

export type IcsDateValue = {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM（本地墙上时间）；全天事件为 null。 */
  time: string | null;
  timeZone: string | null;
  utc: boolean;
  allDay: boolean;
};

export type IcsRecurrence = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  until: string | null;
  byDay: string[];
};

export type IcsEvent = {
  uid: string;
  recurrenceId: string | null;
  summary: string;
  description: string;
  location: string;
  start: IcsDateValue;
  end: IcsDateValue | null;
  rrule: IcsRecurrence | null;
  exdates: string[];
  status: string | null;
  sequence: number;
};

export type IcsParseResult = {
  calendarName: string | null;
  events: IcsEvent[];
  warnings: string[];
};

export type IcsOccurrence = {
  event: IcsEvent;
  start: IcsDateValue;
  end: IcsDateValue | null;
  /** 用于 idempotent 映射：uid + 实例开始时间。 */
  instanceKey: string;
};

export type IcsCache = {
  subscriptionId: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: string;
  raw: string;
  events: IcsEvent[];
  /** 上次展开实例的窗口（YYYY-MM-DD），窗口变化时需要重新物化。 */
  windowFrom: string | null;
  windowTo: string | null;
  /** 最近一次成功解析中的警告；旧缓存可能没有该字段，读取时按空数组处理。 */
  warnings: string[];
};

export class IcsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcsParseError';
  }
}

export class IcsFetchError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'IcsFetchError';
    this.status = status;
  }
}

export class IcsSubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcsSubscriptionError';
  }
}

export type IcsEventDraft = NewEvent & {
  externalUid: string;
  source: string;
};

export function redactIcsUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = parsed.search ? '?…' : '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '(无效地址)';
  }
}

export const ICS_SOURCE_PREFIX = 'ics:';

export function sourceForSubscription(subscriptionId: string): string {
  return `${ICS_SOURCE_PREFIX}${subscriptionId}`;
}

/**
 * 判断事件是否来自 ICS 只读镜像。
 *
 * 外部事件会物化到本地 `events` 表（source=`ics:<订阅id>`）供日历视图读取；
 * UI 据此隐藏编辑/删除入口，只保留查看与“建任务”等本地派生操作。
 */
export function isIcsSource(source: string | null | undefined): boolean {
  return typeof source === 'string' && source.startsWith(ICS_SOURCE_PREFIX);
}

export function isIcsEvent(event: { source?: string | null }): boolean {
  return isIcsSource(event.source);
}
