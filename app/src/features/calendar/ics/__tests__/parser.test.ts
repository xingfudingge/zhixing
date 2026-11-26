import { describe, expect, it } from 'vitest';

import {
  expandOccurrences,
  occurrenceToDraft,
  parseIcs,
  unescapeIcsText,
} from '../parser';
import { IcsParseError, sourceForSubscription } from '../types';

const CRLF = '\r\n';

function calendar(body: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Zhixing Test//CN',
    body,
    'END:VCALENDAR',
  ].join(CRLF);
}

describe('ICS 解析器', () => {
  it('解析折行、转义与全天事件', () => {
    const raw = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'X-WR-CALNAME:团队日历',
      'BEGIN:VEVENT',
      'UID:event-1',
      'DTSTART;VALUE=DATE:20261026',
      'DTEND;VALUE=DATE:20261027',
      'SUMMARY:项目启动\\, 全',
      ' 员',
      'DESCRIPTION:第一行\\n第二行',
      'LOCATION:A 会议室',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join(CRLF);
    const parsed = parseIcs(raw);
    expect(parsed.calendarName).toBe('团队日历');
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]).toMatchObject({
      uid: 'event-1',
      summary: '项目启动, 全员',
      description: '第一行\n第二行',
      location: 'A 会议室',
      start: { date: '2026-10-26', time: null, allDay: true },
    });
    expect(unescapeIcsText('a\\;b\\\\c')).toBe('a;b\\c');
  });

  it('解析带 TZID 的定时事件并忽略 VALARM', () => {
    const raw = calendar(
      [
        'BEGIN:VEVENT',
        'UID:event-2',
        'DTSTART;TZID=Asia/Shanghai:20261026T150000',
        'DTEND;TZID=Asia/Shanghai:20261026T160000',
        'SUMMARY:周会',
        'BEGIN:VALARM',
        'TRIGGER:-PT15M',
        'ACTION:DISPLAY',
        'END:VALARM',
        'END:VEVENT',
      ].join(CRLF),
    );
    const parsed = parseIcs(raw);
    expect(parsed.events[0]?.start).toMatchObject({
      date: '2026-10-26',
      time: '15:00',
      timeZone: 'Asia/Shanghai',
      allDay: false,
    });
    expect(parsed.events).toHaveLength(1);
  });

  it('展开 DAILY + COUNT + EXDATE', () => {
    const raw = calendar(
      [
        'BEGIN:VEVENT',
        'UID:daily-1',
        'DTSTART;VALUE=DATE:20261020',
        'RRULE:FREQ=DAILY;COUNT=5',
        'EXDATE;VALUE=DATE:20261022',
        'SUMMARY:每日站会',
        'END:VEVENT',
      ].join(CRLF),
    );
    const parsed = parseIcs(raw);
    const occurrences = expandOccurrences(parsed.events, {
      from: new Date(2026, 9, 19),
      to: new Date(2026, 9, 30),
    });
    expect(occurrences.map((item) => item.start.date)).toEqual([
      '2026-10-20',
      '2026-10-21',
      '2026-10-23',
      '2026-10-24',
    ]);
    expect(occurrences[0]?.instanceKey).toBe('daily-1#2026-10-20');
  });

  it('展开 WEEKLY BYDAY 并限制 COUNT', () => {
    const raw = calendar(
      [
        'BEGIN:VEVENT',
        'UID:weekly-1',
        'DTSTART;VALUE=DATE:20261019',
        'RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO,WE',
        'SUMMARY:每周例会',
        'END:VEVENT',
      ].join(CRLF),
    );
    const parsed = parseIcs(raw);
    const occurrences = expandOccurrences(parsed.events, {
      from: new Date(2026, 9, 19),
      to: new Date(2026, 10, 1),
    });
    expect(occurrences.map((item) => item.start.date)).toEqual([
      '2026-10-19',
      '2026-10-21',
      '2026-10-26',
      '2026-10-28',
    ]);
  });

  it('RECURRENCE-ID 覆盖单个实例', () => {
    const raw = calendar(
      [
        'BEGIN:VEVENT',
        'UID:rec-1',
        'DTSTART;VALUE=DATE:20261020',
        'RRULE:FREQ=DAILY;COUNT=3',
        'SUMMARY:原标题',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:rec-1',
        'RECURRENCE-ID;VALUE=DATE:20261021',
        'DTSTART;VALUE=DATE:20261021',
        'SUMMARY:改后的标题',
        'END:VEVENT',
      ].join(CRLF),
    );
    const parsed = parseIcs(raw);
    const occurrences = expandOccurrences(parsed.events, {
      from: new Date(2026, 9, 19),
      to: new Date(2026, 9, 30),
    });
    expect(occurrences).toHaveLength(3);
    expect(
      occurrences.find((item) => item.start.date === '2026-10-21')?.event
        .summary,
    ).toBe('改后的标题');
  });

  it('缺少 UID/DTSTART 的事件跳过并记录警告，不编造事件', () => {
    const raw = calendar(
      [
        'BEGIN:VEVENT',
        'DTSTART;VALUE=DATE:20261026',
        'SUMMARY:没有 UID',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:no-start',
        'SUMMARY:没有开始时间',
        'END:VEVENT',
      ].join(CRLF),
    );
    const parsed = parseIcs(raw);
    expect(parsed.events).toEqual([]);
    expect(parsed.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('无效 ICS 明确报错', () => {
    expect(() => parseIcs('not a calendar')).toThrow(IcsParseError);
    expect(() =>
      parseIcs('BEGIN:VCALENDAR\nEND:VCALENDAR'),
    ).not.toThrow();
  });

  it('映射为本地事件草案时保持只读来源与稳定 externalUid', () => {
    const raw = calendar(
      [
        'BEGIN:VEVENT',
        'UID:all-day-1',
        'DTSTART;VALUE=DATE:20261026',
        'SUMMARY:纪念日',
        'END:VEVENT',
      ].join(CRLF),
    );
    const parsed = parseIcs(raw);
    const [occurrence] = expandOccurrences(parsed.events, {
      from: new Date(2026, 9, 20),
      to: new Date(2026, 10, 1),
    });
    const draft = occurrenceToDraft(occurrence!, 'sub-1', '#5579d5');
    expect(draft).toMatchObject({
      title: '纪念日',
      allDay: true,
      startDate: '2026-10-26',
      source: sourceForSubscription('sub-1'),
      externalUid: 'all-day-1#2026-10-26',
      repeatRule: '单次',
      // 外部日历实例本身是公历日期，不带农历标记（AUD-024）。
      calendarType: 'solar',
    });
    expect(draft.source).toBe('ics:sub-1');
  });
});
