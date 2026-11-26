/**
 * RFC 5545（iCalendar）只读解析器。
 *
 * 覆盖 v1 需要的子集：VEVENT、UID、SUMMARY、DESCRIPTION、LOCATION、
 * DTSTART/DTEND（DATE 与 DATE-TIME、TZID、Z）、RRULE（DAILY/WEEKLY/
 * MONTHLY/YEARLY + INTERVAL/COUNT/UNTIL/BYDAY）、EXDATE、RECURRENCE-ID、
 * 折行与文本转义。VALARM 被忽略。
 *
 * 解析失败会明确抛出 `IcsParseError`；缺少 UID/DTSTART 的事件跳过并记录
 * 警告，不会编造事件。
 */

import { zonedDateTimeToUtc } from '../../notifications/planner';
import {
  IcsParseError,
  type IcsDateValue,
  type IcsEvent,
  type IcsEventDraft,
  type IcsOccurrence,
  type IcsParseResult,
  type IcsRecurrence,
  sourceForSubscription,
} from './types';

type Property = {
  name: string;
  params: Record<string, string>;
  value: string;
};

const WEEKDAY: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

function unfold(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const unfolded = normalized.replace(/\n[ \t]/g, '');
  return unfolded
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);
}

function splitParams(input: string): {
  head: string;
  params: Record<string, string>;
} {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === ';' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  const head = parts.shift() ?? '';
  const params: Record<string, string> = {};
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    params[part.slice(0, index).toUpperCase()] = part
      .slice(index + 1)
      .replace(/^"|"$/g, '');
  }
  return { head, params };
}

function parseProperty(line: string): Property | null {
  let colon = -1;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    if (char === ':' && !quoted) {
      colon = index;
      break;
    }
  }
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const { head, params } = splitParams(left);
  return { name: head.toUpperCase(), params, value };
}

export function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\N/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseDateValue(value: string, params: Record<string, string>): IcsDateValue | null {
  const raw = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (dateOnly) {
    return {
      date: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`,
      time: null,
      timeZone: params.TZID ?? null,
      utc: false,
      allDay: true,
    };
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i.exec(raw);
  if (!dateTime) return null;
  const hour = dateTime[4]!;
  const minute = dateTime[5]!;
  if (Number(hour) > 23 || Number(minute) > 59) return null;
  return {
    date: `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}`,
    time: `${hour}:${minute}`,
    timeZone: dateTime[7] ? 'UTC' : (params.TZID ?? null),
    utc: Boolean(dateTime[7]),
    allDay: params.VALUE === 'DATE',
  };
}

function parseDuration(value: string): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  return ((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000;
}

function parseRecurrence(value: string): IcsRecurrence | null {
  const parts = new Map<string, string>();
  for (const chunk of value.split(';')) {
    const index = chunk.indexOf('=');
    if (index > 0) {
      parts.set(chunk.slice(0, index).toUpperCase(), chunk.slice(index + 1));
    }
  }
  const freq = parts.get('FREQ')?.toUpperCase();
  if (
    freq !== 'DAILY' &&
    freq !== 'WEEKLY' &&
    freq !== 'MONTHLY' &&
    freq !== 'YEARLY'
  ) {
    return null;
  }
  const interval = Number(parts.get('INTERVAL') ?? 1);
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : null;
  const until = parts.get('UNTIL') ?? null;
  const byDay = (parts.get('BYDAY') ?? '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((item) => item in WEEKDAY);
  return {
    freq,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 1,
    count: count !== null && Number.isFinite(count) && count > 0 ? count : null,
    until,
    byDay,
  };
}

function appendProperty(
  target: Record<string, string[]>,
  property: Property,
): void {
  const list = target[property.name] ?? [];
  list.push(property.value);
  target[property.name] = list;
}

type RawEvent = {
  props: Record<string, string[]>;
  dtstart: Property | null;
  dtend: Property | null;
  duration: number | null;
  recurrenceId: Property | null;
  exdates: string[];
  rrule: IcsRecurrence | null;
};

function rawToEvent(raw: RawEvent, warnings: string[]): IcsEvent | null {
  const uid = raw.props.UID?.[0]?.trim();
  if (!uid) {
    warnings.push('跳过缺少 UID 的事件');
    return null;
  }
  if (!raw.dtstart) {
    warnings.push(`事件 ${uid} 缺少 DTSTART，已跳过`);
    return null;
  }
  const start = parseDateValue(raw.dtstart.value, raw.dtstart.params);
  if (!start) {
    warnings.push(`事件 ${uid} 的 DTSTART 无法解析，已跳过`);
    return null;
  }
  const end = raw.dtend
    ? parseDateValue(raw.dtend.value, raw.dtend.params)
    : null;
  const recurrenceRaw = raw.recurrenceId
    ? parseDateValue(raw.recurrenceId.value, raw.recurrenceId.params)
    : null;
  const recurrenceId = recurrenceRaw
    ? toDateValue(
        startInstant(recurrenceRaw),
        recurrenceRaw.allDay,
      )
    : null;
  return {
    uid,
    recurrenceId: recurrenceId
      ? `${recurrenceId.date}${recurrenceId.time ? `T${recurrenceId.time}` : ''}`
      : null,
    summary: unescapeIcsText(raw.props.SUMMARY?.[0] ?? '').trim(),
    description: unescapeIcsText(raw.props.DESCRIPTION?.[0] ?? '').trim(),
    location: unescapeIcsText(raw.props.LOCATION?.[0] ?? '').trim(),
    start,
    end,
    rrule: raw.rrule,
    exdates: raw.exdates,
    status: raw.props.STATUS?.[0]?.toUpperCase() ?? null,
    sequence: Number(raw.props.SEQUENCE?.[0] ?? 0) || 0,
  };
}

export function parseIcs(raw: string): IcsParseResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new IcsParseError('ICS 内容为空');
  }
  const lines = unfold(raw);
  if (!lines.some((line) => /^BEGIN:VCALENDAR$/i.test(line.trim()))) {
    throw new IcsParseError('不是有效的 ICS：缺少 BEGIN:VCALENDAR');
  }
  if (!lines.some((line) => /^END:VCALENDAR$/i.test(line.trim()))) {
    throw new IcsParseError('ICS 内容不完整：缺少 END:VCALENDAR');
  }

  const warnings: string[] = [];
  const events: IcsEvent[] = [];
  let calendarName: string | null = null;
  let current: RawEvent | null = null;
  let alarm = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^BEGIN:VEVENT$/i.test(trimmed)) {
      current = {
        props: {},
        dtstart: null,
        dtend: null,
        duration: null,
        recurrenceId: null,
        exdates: [],
        rrule: null,
      };
      continue;
    }
    if (/^END:VEVENT$/i.test(trimmed)) {
      if (current) {
        const event = rawToEvent(current, warnings);
        if (event) events.push(event);
      }
      current = null;
      continue;
    }
    if (/^BEGIN:VALARM$/i.test(trimmed)) {
      alarm = true;
      continue;
    }
    if (/^END:VALARM$/i.test(trimmed)) {
      alarm = false;
      continue;
    }
    const property = parseProperty(line);
    if (!property) continue;
    if (!current) {
      if (property.name === 'X-WR-CALNAME') {
        calendarName = unescapeIcsText(property.value).trim() || null;
      }
      continue;
    }
    if (alarm) continue;
    appendProperty(current.props, property);
    switch (property.name) {
      case 'DTSTART':
        current.dtstart = property;
        break;
      case 'DTEND':
        current.dtend = property;
        break;
      case 'DURATION':
        current.duration = parseDuration(property.value);
        break;
      case 'RECURRENCE-ID':
        current.recurrenceId = property;
        break;
      case 'RRULE':
        current.rrule = parseRecurrence(property.value);
        break;
      case 'EXDATE':
        for (const item of property.value.split(',')) {
          const parsed = parseDateValue(item.trim(), property.params);
          if (parsed) {
            current.exdates.push(
              `${parsed.date}${parsed.time ? `T${parsed.time}` : ''}`,
            );
          }
        }
        break;
    }
  }

  return { calendarName, events, warnings };
}

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function startInstant(value: IcsDateValue): Date {
  if (value.allDay) {
    return new Date(`${value.date}T00:00:00`);
  }
  if (!value.time) {
    return new Date(`${value.date}T00:00:00`);
  }
  if (value.utc) {
    return new Date(`${value.date}T${value.time}:00Z`);
  }
  if (value.timeZone) {
    const zoned = zonedDateTimeToUtc(value.date, value.time, value.timeZone);
    if (zoned) return zoned;
  }
  return new Date(`${value.date}T${value.time}:00`);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function datePartsInZone(date: Date, timeZone: string): {
  date: string;
  time: string;
} {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const values: Record<string, string> = {};
    for (const part of formatter.formatToParts(date)) {
      values[part.type] = part.value;
    }
    return {
      date: `${values.year}-${values.month}-${values.day}`,
      time: `${values.hour}:${values.minute}`,
    };
  } catch {
    return {
      date: date.toISOString().slice(0, 10),
      time: date.toISOString().slice(11, 16),
    };
  }
}

function toDateValue(instant: Date, allDay: boolean): IcsDateValue {
  const local = localZone();
  const parts = datePartsInZone(instant, local);
  if (allDay) {
    return {
      date: parts.date,
      time: null,
      timeZone: local,
      utc: false,
      allDay: true,
    };
  }
  return {
    date: parts.date,
    time: parts.time,
    timeZone: local,
    utc: false,
    allDay: false,
  };
}

function dateValueKey(value: IcsDateValue): string {
  return `${value.date}${value.time ? `T${value.time}` : ''}`;
}

function addMonths(date: Date, months: number): Date {
  const day = date.getDate();
  const next = new Date(date);
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}

function addYears(date: Date, years: number): Date {
  const next = new Date(date);
  next.setFullYear(next.getFullYear() + years);
  return next;
}

function expandBase(
  event: IcsEvent,
  from: Date,
  to: Date,
  maxInstances: number,
): IcsOccurrence[] {
  const durationMs = event.end
    ? startInstant(event.end).getTime() - startInstant(event.start).getTime()
    : 0;
  const first = startInstant(event.start);
  const exdates = new Set(event.exdates);
  const occurrences: IcsOccurrence[] = [];
  const rrule = event.rrule;
  if (!rrule) {
    const startValue = toDateValue(
      startInstant(event.start),
      event.start.allDay,
    );
    const endValue = event.end
      ? toDateValue(startInstant(event.end), event.end.allDay)
      : null;
    return [
      {
        event,
        start: startValue,
        end: endValue,
        instanceKey: `${event.uid}#${dateValueKey(startValue)}`,
      },
    ];
  }

  const until = rrule.until ? parseDateValue(rrule.until, {}) : null;
  const untilInstant = until ? startInstant(until) : null;
  const interval = rrule.interval;
  let index = 0;
  let generated = 0;

  while (generated < maxInstances) {
    let current: Date;
    if (rrule.freq === 'DAILY') {
      current = addDays(first, index * interval);
    } else if (rrule.freq === 'WEEKLY') {
      if (rrule.byDay.length > 0) {
        const weekStart = addDays(first, Math.floor(index / rrule.byDay.length) * 7 * interval);
        const day = WEEKDAY[rrule.byDay[index % rrule.byDay.length]!];
        const offset = (day ?? first.getDay()) - first.getDay();
        current = addDays(weekStart, offset);
      } else {
        current = addDays(first, index * 7 * interval);
      }
    } else if (rrule.freq === 'MONTHLY') {
      current = addMonths(first, index * interval);
    } else {
      current = addYears(first, index * interval);
    }
    index += 1;
    if (untilInstant && current.getTime() > untilInstant.getTime()) break;
    if (current.getTime() < first.getTime()) continue;
    if (rrule.count !== null && generated >= rrule.count) break;
    generated += 1;

    const startValue = toDateValue(current, event.start.allDay);
    if (exdates.has(dateValueKey(startValue))) continue;
    if (current.getTime() > to.getTime() + 24 * 60 * 60 * 1000) break;
    if (current.getTime() < from.getTime()) continue;
    occurrences.push({
      event,
      start: startValue,
      end: event.end
        ? toDateValue(new Date(current.getTime() + durationMs), event.start.allDay)
        : null,
      instanceKey: `${event.uid}#${dateValueKey(startValue)}`,
    });
  }
  return occurrences;
}

/**
 * 展开单次与重复事件，处理 RECURRENCE-ID 覆盖。
 */
export function expandOccurrences(
  events: ReadonlyArray<IcsEvent>,
  options: { from: Date; to: Date; maxInstances?: number },
): IcsOccurrence[] {
  const maxInstances = options.maxInstances ?? 500;
  const bases = events.filter((event) => event.recurrenceId === null);
  const overrides = new Map<string, IcsEvent>();
  const orphanOverrides: IcsEvent[] = [];
  for (const event of events) {
    if (event.recurrenceId === null) continue;
    const key = `${event.uid}#${event.recurrenceId}`;
    overrides.set(key, event);
  }
  const baseUids = new Set(bases.map((event) => event.uid));
  for (const event of events) {
    if (event.recurrenceId !== null && !baseUids.has(event.uid)) {
      orphanOverrides.push(event);
    }
  }

  const occurrences: IcsOccurrence[] = [];
  for (const base of bases) {
    for (const occurrence of expandBase(
      base,
      options.from,
      options.to,
      maxInstances,
    )) {
      const override = overrides.get(occurrence.instanceKey);
      if (override) {
        occurrences.push({
          event: override,
          start: toDateValue(startInstant(override.start), override.start.allDay),
          end: override.end
            ? toDateValue(startInstant(override.end), override.end.allDay)
            : null,
          instanceKey: occurrence.instanceKey,
        });
      } else {
        occurrences.push(occurrence);
      }
    }
  }
  for (const override of orphanOverrides) {
    const startValue = toDateValue(
      startInstant(override.start),
      override.start.allDay,
    );
    occurrences.push({
      event: override,
      start: startValue,
      end: override.end
        ? toDateValue(startInstant(override.end), override.end.allDay)
        : null,
      instanceKey: `${override.uid}#${dateValueKey(startValue)}`,
    });
  }
  return occurrences.sort(
    (a, b) => startInstant(a.start).getTime() - startInstant(b.start).getTime(),
  );
}

/** 把事件实例映射为知行的 `events` 草案。所有时间转成本机墙上时间显示。 */
export function occurrenceToDraft(
  occurrence: IcsOccurrence,
  subscriptionId: string,
  color = '',
): IcsEventDraft {
  const start = occurrence.start;
  const startAt = start.allDay ? null : `${start.date}T${start.time ?? '00:00'}:00`;
  const endAt =
    occurrence.end && !start.allDay && occurrence.end.time
      ? `${occurrence.end.date}T${occurrence.end.time}:00`
      : occurrence.end && !start.allDay
        ? `${occurrence.end.date}T00:00:00`
        : null;
  return {
    title: occurrence.event.summary || '（无标题事件）',
    eventType: '个人日程',
    allDay: start.allDay,
    startDate: start.date,
    startAt,
    endAt,
    tz: localZone(),
    source: sourceForSubscription(subscriptionId),
    externalUid: occurrence.instanceKey,
    repeatRule: '单次',
    // 外部日历的时间已是公历实例；农历标记不适用于 ICS 事件。
    calendarType: 'solar',
    noteId: null,
    color,
  };
}
