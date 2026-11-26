/**
 * 节假日内置源注册表、URL、各源适配器与通用校验。
 *
 * 独立性以“上游仓库/维护者/数据管线”为准：
 * - holiday-cn：https://github.com/NateScarlet/holiday-cn（MIT）
 * - chinese-days：https://github.com/vsme/chinese-days（MIT）
 * - china-mainland-calendar：https://github.com/Lancetwang/china-mainland-calendar（MIT）
 *
 * jsDelivr / GitHub Raw / unpkg 只是同一上游的传输镜像，不增加源计数。
 * 所有源只读取数据，不复制代码；GPL/AGPL 源不内置。
 */

import { addDaysISO, isValidISODate } from '../../../data/calendar/date';
import type { HolidayDay, HolidayPackage } from '../../../data/calendar/holidays';
import {
  HolidayNotPublishedError,
  HolidayParseError,
  HolidaySourceError,
  normalizeHolidayPreferences,
  validateHolidayCustomUrl,
  type HolidayActualTransport,
  type HolidayFormat,
  type HolidayPreferences,
  type HolidaySourceId,
  type HolidayTransport,
} from './types';

export const HOLIDAY_CN_REPO_URL = 'https://github.com/NateScarlet/holiday-cn';
export const HOLIDAY_CN_LICENSE = 'MIT';
export const HOLIDAY_CN_AUDITED_COMMIT =
  '2fa4d1e5fb471bc89bdabeb630c141fee6201575';
export const HOLIDAY_CN_DATA_FILE = '2026.json';
export const HOLIDAY_CN_SCHEMA_FILE = 'schema.json';

/** 单个年份文件最多接受的天数，防止坏源返回超大数组。 */
const MAX_HOLIDAY_DAYS = 1000;
/** 当前年最少天数：低于该值视为坏包，不覆盖 last-good。 */
const MIN_CURRENT_YEAR_DAYS = 5;
/** 单条 ICS 连续休假最多展开 31 天（国庆 7、春节 9 都在范围内）。 */
const MAX_ICS_RANGE_DAYS = 31;

export type HolidayTransportDefinition = {
  id: HolidayActualTransport;
  label: string;
  urlTemplate: string;
  /** 同一上游的镜像传输；不计入独立源数量。 */
  mirror: boolean;
  /** URL 是否带 `{year}` 占位符。 */
  yearAware: boolean;
};

export type HolidaySourceDefinition = {
  id: HolidaySourceId;
  name: string;
  shortName: string;
  repository: string;
  license: 'MIT';
  priority: number;
  format: HolidayFormat;
  coverage: { from: number; to: number };
  coverageLabel: string;
  /** 审计日实测可用性；UI 与排障时直接展示，避免“多源”只是说法。 */
  availability: string;
  description: string;
  independent: true;
  transports: readonly HolidayTransportDefinition[];
};

export const HOLIDAY_SOURCE_DEFINITIONS: readonly HolidaySourceDefinition[] = [
  {
    id: 'holiday-cn',
    name: 'NateScarlet/holiday-cn',
    shortName: 'holiday-cn',
    repository: HOLIDAY_CN_REPO_URL,
    license: 'MIT',
    priority: 1,
    format: 'holiday-cn-json',
    coverage: { from: 2007, to: 2027 },
    coverageLabel: '2007–2027（2027 公布前为空包）',
    availability: '2026-11-01 实测 200（4843 B）；2027 空包',
    description:
      '主源。国务院公告自动抓取，JSON 含 papers 来源链接；2027 文件在公布前 days 为空，只能标记“未公布”。',
    independent: true,
    transports: [
      {
        id: 'jsdelivr',
        label: 'jsDelivr',
        urlTemplate:
          'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
        mirror: false,
        yearAware: true,
      },
      {
        id: 'github-raw',
        label: 'GitHub Raw（同源镜像）',
        urlTemplate:
          'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json',
        mirror: true,
        yearAware: true,
      },
    ],
  },
  {
    id: 'chinese-days',
    name: 'vsme/chinese-days',
    shortName: 'chinese-days',
    repository: 'https://github.com/vsme/chinese-days',
    license: 'MIT',
    priority: 2,
    format: 'chinese-days-json',
    coverage: { from: 2004, to: 2026 },
    coverageLabel: '2004–2026',
    availability: '2026-11-01 实测 200（1856 B）；无 2027 文件',
    description:
      '备源。独立仓库与数据管线；holidays/workdays 分列，schema 无 year 字段，按请求年校验。',
    independent: true,
    transports: [
      {
        id: 'jsdelivr',
        label: 'jsDelivr（npm 固定版本）',
        urlTemplate:
          'https://cdn.jsdelivr.net/npm/chinese-days@1.5.9/dist/years/{year}.json',
        mirror: false,
        yearAware: true,
      },
      {
        id: 'unpkg',
        label: 'unpkg（同包镜像）',
        urlTemplate:
          'https://unpkg.com/chinese-days@1.5.9/dist/years/{year}.json',
        mirror: true,
        yearAware: true,
      },
    ],
  },
  {
    id: 'china-mainland-calendar',
    name: 'Lancetwang/china-mainland-calendar',
    shortName: 'china-mainland-calendar',
    repository: 'https://github.com/Lancetwang/china-mainland-calendar',
    license: 'MIT',
    priority: 3,
    format: 'ics',
    coverage: { from: 2026, to: 2026 },
    coverageLabel: '2026（单年 ICS）',
    availability: '2026-11-01 实测 200（33325 B）；仅 2026',
    description:
      '最后备源。ICS 内含节气/纪念日，必须按 CATEGORIES 只取法定节日、连续休假与调休补班。',
    independent: true,
    transports: [
      {
        id: 'jsdelivr',
        label: 'jsDelivr',
        urlTemplate:
          'https://cdn.jsdelivr.net/gh/Lancetwang/china-mainland-calendar@main/china-mainland.ics',
        mirror: false,
        yearAware: false,
      },
      {
        id: 'github-raw',
        label: 'GitHub Raw（同源镜像）',
        urlTemplate:
          'https://raw.githubusercontent.com/Lancetwang/china-mainland-calendar/main/china-mainland.ics',
        mirror: true,
        yearAware: false,
      },
    ],
  },
] as const;

/** 内置离线包独立标注；不计入 3 个远端源，也不参与自动 failover 计数。 */
export const BUILTIN_OFFLINE_SOURCE = {
  id: 'builtin',
  name: '内置离线包',
  license: '国务院办公厅公告（随应用发布）',
  coverageLabel: '2026',
  description: '随应用发布的 2026 离线数据，不联网、不可被远端源覆盖版本号。',
} as const;

export const CUSTOM_HOLIDAY_SOURCE = {
  id: 'custom',
  name: '自定义 URL',
  license: '由用户提供',
  coverageLabel: '由 URL 决定',
  description: '只在用户明确选择时使用；不进入自动 failover。',
} as const;

export function holidaySourceDefinition(
  id: HolidaySourceId,
): HolidaySourceDefinition {
  return (
    HOLIDAY_SOURCE_DEFINITIONS.find((item) => item.id === id) ??
    HOLIDAY_SOURCE_DEFINITIONS[0]!
  );
}

export function holidaySourceLabel(id: HolidaySourceId): string {
  return holidaySourceDefinition(id).shortName;
}

export function isHolidaySourceCovered(
  id: HolidaySourceId,
  year: number,
): boolean {
  const definition = holidaySourceDefinition(id);
  return year >= definition.coverage.from && year <= definition.coverage.to;
}

/**
 * 解析源 + 传输。`auto` 返回该源的主传输与镜像传输（按定义顺序）；
 * 显式传输只返回支持的项，避免把 GitHub Raw 发给 chinese-days。
 */
export function resolveHolidayTransports(
  sourceId: HolidaySourceId,
  transport: HolidayTransport,
): readonly HolidayTransportDefinition[] {
  const definition = holidaySourceDefinition(sourceId);
  if (transport === 'auto') {
    return definition.transports;
  }
  const explicit = definition.transports.find((item) => item.id === transport);
  return explicit ? [explicit] : [];
}

/** 旧导出保留：jsDelivr / GitHub Raw 是 holiday-cn 的两种传输，不是两个源。 */
export const HOLIDAY_SOURCE_ENDPOINTS = {
  jsdelivr: holidaySourceDefinition('holiday-cn').transports[0]!.urlTemplate,
  github: holidaySourceDefinition('holiday-cn').transports[1]!.urlTemplate,
} as const;

export type ParsedHolidayPayload = {
  year: number;
  days: HolidayDay[];
  papers: string[];
};

export type HolidayRequest = {
  /** 该请求期望的年份；自定义单文件源不带 `{year}` 时为 null。 */
  expectedYear: number | null;
  url: string;
  sourceId: HolidaySourceId | 'custom';
  transport: HolidayActualTransport | 'auto';
  format: HolidayFormat;
  yearAware: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 同步默认检查今年和明年：跨年时不能只拿今年文件。
 * 明年文件为空/越界时只记录“未公布”，不覆盖今年的有效数据。
 */
export function holidayTargetYears(now: Date = new Date()): number[] {
  const year = now.getFullYear();
  return [year, year + 1];
}

/**
 * 构造某个年份的请求。
 * - 内置离线源不联网，返回 null；
 * - 内置远端源按源定义选择传输；不覆盖该年时返回 null；
 * - 自定义 URL 带 `{year}` 时按年展开；不带时只请求一次，并以响应内的 year 为准。
 */
export function holidayRequestForYear(
  preferences: HolidayPreferences,
  year: number,
): HolidayRequest | null {
  const normalized = normalizeHolidayPreferences(preferences);
  if (normalized.mode === 'builtin') {
    return null;
  }
  if (normalized.mode === 'custom') {
    const pattern = validateHolidayCustomUrl(normalized.customUrl);
    const hasYear = pattern.includes('{year}');
    return {
      expectedYear: hasYear ? year : null,
      url: hasYear ? pattern.replaceAll('{year}', String(year)) : pattern,
      sourceId: 'custom',
      transport: 'auto',
      format: normalized.customFormat,
      yearAware: hasYear,
    };
  }
  const definition = holidaySourceDefinition(normalized.sourceId);
  if (!isHolidaySourceCovered(definition.id, year)) {
    return null;
  }
  const translations = resolveHolidayTransports(
    definition.id,
    normalized.transport,
  );
  const transport = translations[0];
  if (!transport) {
    return null;
  }
  return {
    expectedYear: year,
    url: transport.urlTemplate.replaceAll('{year}', String(year)),
    sourceId: definition.id,
    transport: transport.id,
    format: definition.format,
    yearAware: transport.yearAware,
  };
}

/** 所有传输的请求（用于传输 failover）；同一源/年份按定义顺序排列。 */
export function holidayRequestsForYear(
  preferences: HolidayPreferences,
  year: number,
): HolidayRequest[] {
  const normalized = normalizeHolidayPreferences(preferences);
  if (normalized.mode === 'builtin') return [];
  if (normalized.mode === 'custom') {
    const request = holidayRequestForYear(normalized, year);
    return request ? [request] : [];
  }
  const definition = holidaySourceDefinition(normalized.sourceId);
  if (!isHolidaySourceCovered(definition.id, year)) return [];
  return resolveHolidayTransports(definition.id, normalized.transport).map(
    (transport) => ({
      expectedYear: year,
      url: transport.urlTemplate.replaceAll('{year}', String(year)),
      sourceId: definition.id,
      transport: transport.id,
      format: definition.format,
      yearAware: transport.yearAware,
    }),
  );
}

/** 通用日粒度校验；失败一律抛错，绝不返回空数组冒充成功。 */
export function assertHolidayDays(
  year: number,
  days: readonly HolidayDay[],
  options: { minDays?: number } = {},
): void {
  if (year < 2000 || year > 2200) {
    throw new HolidayParseError(`节假日数据年份异常：${year}`);
  }
  if (days.length > MAX_HOLIDAY_DAYS) {
    throw new HolidayParseError(
      `节假日数据超过 ${MAX_HOLIDAY_DAYS} 天，拒绝导入`,
    );
  }
  if (days.length < (options.minDays ?? 0)) {
    throw new HolidayParseError(
      `${year} 年节假日数据仅 ${days.length} 天，低于可信下限 ${options.minDays} 天`,
    );
  }
  const seen = new Map<string, boolean>();
  for (const day of days) {
    if (!isValidISODate(day.date)) {
      throw new HolidayParseError(`节假日数据存在非法日期：${day.date}`);
    }
    if (Number(day.date.slice(0, 4)) !== year) {
      throw new HolidayParseError(
        `节假日数据日期不属于 ${year} 年：${day.date}`,
      );
    }
    const name = day.name.trim();
    if (!name) {
      throw new HolidayParseError('节假日数据存在空名称');
    }
    if (name.length > 80) {
      throw new HolidayParseError(`节假日名称过长：${day.date}`);
    }
    if (typeof day.isOffDay !== 'boolean') {
      throw new HolidayParseError(`节假日数据存在非法 isOffDay：${day.date}`);
    }
    const existing = seen.get(day.date);
    if (existing !== undefined && existing !== day.isOffDay) {
      throw new HolidayParseError(
        `节假日数据同一天既休又班：${day.date}`,
      );
    }
    seen.set(day.date, day.isOffDay);
  }
}

function collectHolidayDays(
  entries: ReadonlyArray<HolidayDay>,
): HolidayDay[] {
  const byDate = new Map<string, HolidayDay>();
  for (const entry of entries) {
    const existing = byDate.get(entry.date);
    if (existing && existing.isOffDay !== entry.isOffDay) {
      throw new HolidayParseError(
        `节假日数据同一天既休又班：${entry.date}`,
      );
    }
    if (!existing) {
      byDate.set(entry.date, {
        date: entry.date,
        name: entry.name.trim(),
        isOffDay: entry.isOffDay,
      });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 解析 holiday-cn 官方 JSON。
 *
 * 失败一律抛出明确错误，绝不返回空数组冒充成功：
 * - 非 JSON / 结构错误 -> HolidayParseError；
 * - year 与请求年份不一致 -> HolidayParseError；
 * - 日期跨年 / 同日休班冲突 -> HolidayParseError；
 * - days 为空 -> HolidayNotPublishedError（“尚未公布”）。
 */
export function parseHolidayPayload(
  text: string,
  expectedYear: number | null,
): ParsedHolidayPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HolidayParseError('节假日数据不是有效 JSON');
  }
  if (!isRecord(raw)) {
    throw new HolidayParseError('节假日数据顶层必须是对象');
  }

  const year = raw.year;
  if (typeof year !== 'number' || !Number.isInteger(year)) {
    throw new HolidayParseError('节假日数据缺少合法的 year');
  }
  if (expectedYear !== null && year !== expectedYear) {
    throw new HolidayParseError(
      `节假日数据年份不匹配：期望 ${expectedYear}，实际 ${year}`,
    );
  }
  if (year < 2000 || year > 2200) {
    throw new HolidayParseError(`节假日数据年份异常：${year}`);
  }

  if (!Array.isArray(raw.days)) {
    throw new HolidayParseError('节假日数据缺少 days 数组');
  }
  if (raw.days.length === 0) {
    throw new HolidayNotPublishedError(
      year,
      `${year} 年节假日数据尚未公布（上游 days 为空）`,
    );
  }
  if (raw.days.length > MAX_HOLIDAY_DAYS) {
    throw new HolidayParseError(
      `节假日数据超过 ${MAX_HOLIDAY_DAYS} 天，拒绝导入`,
    );
  }

  const entries: HolidayDay[] = [];
  for (const item of raw.days) {
    if (!isRecord(item)) {
      throw new HolidayParseError('节假日数据包含非对象条目');
    }
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const date = typeof item.date === 'string' ? item.date.trim() : '';
    if (!name) {
      throw new HolidayParseError('节假日数据存在空名称');
    }
    if (!isValidISODate(date)) {
      throw new HolidayParseError(`节假日数据存在非法日期：${String(item.date)}`);
    }
    if (typeof item.isOffDay !== 'boolean') {
      throw new HolidayParseError(`节假日数据存在非法 isOffDay：${date}`);
    }
    entries.push({ date, name, isOffDay: item.isOffDay });
  }

  const days = collectHolidayDays(entries);
  assertHolidayDays(year, days);

  const papers = Array.isArray(raw.papers)
    ? raw.papers.filter(
        (item): item is string => typeof item === 'string' && item.trim() !== '',
      )
    : [];

  return {
    year,
    days,
    papers,
  };
}

function chineseDaysName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    return parts[1]!;
  }
  return parts[0] ?? '';
}

function inferChineseDaysYear(raw: Record<string, unknown>): number | null {
  for (const key of ['holidays', 'workdays']) {
    const value = raw[key];
    if (!isRecord(value)) continue;
    for (const date of Object.keys(value)) {
      const match = /^(\d{4})-\d{2}-\d{2}$/.exec(date);
      if (match) return Number(match[1]);
    }
  }
  return null;
}

/**
 * 解析 vsme/chinese-days 的年份文件。
 *
 * schema：{ holidays: {date: "English,中文,type"}, workdays: {...},
 * inLieuDays: {...} }。`inLieuDays` 是 holidays 的说明子集，不单独生成日条目。
 * 文件没有 year 字段，必须用请求年过滤；只要出现本年的休/班，就算有效数据。
 */
export function parseChineseDaysPayload(
  text: string,
  expectedYear: number | null,
): ParsedHolidayPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HolidayParseError('节假日数据不是有效 JSON');
  }
  if (!isRecord(raw)) {
    throw new HolidayParseError('节假日数据顶层必须是对象');
  }
  const datasets = [raw.holidays, raw.workdays].filter(isRecord);
  const years = datasets.flatMap((value) => Object.keys(value));
  if (datasets.length === 0) {
    throw new HolidayParseError('chinese-days 数据缺少 holidays/workdays');
  }
  if (years.length === 0) {
    const year = expectedYear;
    throw new HolidayNotPublishedError(
      year ?? 0,
      `${year ?? '目标'} 年节假日数据尚未公布（chinese-days 无条目）`,
    );
  }
  const year = expectedYear ?? inferChineseDaysYear(raw);
  if (year === null) {
    throw new HolidayParseError('chinese-days 数据无法确定年份');
  }

  const entries: HolidayDay[] = [];
  const pushEntries = (value: unknown, isOffDay: boolean) => {
    if (value === undefined) return;
    if (!isRecord(value)) {
      throw new HolidayParseError('chinese-days 数据缺少对象结构');
    }
    for (const [date, label] of Object.entries(value)) {
      if (!isValidISODate(date)) {
        throw new HolidayParseError(`节假日数据存在非法日期：${date}`);
      }
      if (Number(date.slice(0, 4)) !== year) continue;
      const name = chineseDaysName(label);
      if (!name) {
        throw new HolidayParseError(`节假日数据存在空名称：${date}`);
      }
      entries.push({ date, name, isOffDay });
    }
  };
  pushEntries(raw.holidays, true);
  pushEntries(raw.workdays, false);

  if (entries.length === 0) {
    throw new HolidayNotPublishedError(
      year,
      `${year} 年节假日数据尚未公布（chinese-days 无本年条目）`,
    );
  }

  const days = collectHolidayDays(entries);
  assertHolidayDays(year, days);
  return { year, days, papers: [] };
}

function unfoldIcs(raw: string): string[] {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function propertyValue(line: string): { name: string; value: string } | null {
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
  const semicolon = left.indexOf(';');
  return {
    name: (semicolon >= 0 ? left.slice(0, semicolon) : left).toUpperCase(),
    value: line.slice(colon + 1),
  };
}

function icsDate(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T.*)?$/.exec(value.trim());
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  return isValidISODate(date) ? date : null;
}

function unescapeIcsSummary(value: string): string {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

const ICS_OFF_CATEGORIES = new Set(['法定节日', '连续休假']);
const ICS_WORK_CATEGORIES = new Set(['调休补班']);

/**
 * 解析 Lancetwang/china-mainland-calendar 的 ICS。
 *
 * 只取 CATEGORIES 含“法定节日/连续休假”（休）或“调休补班”（班）的事件；
 * 节气、纪念日、传统节日、部分公民节日全部忽略。DTEND 为排他日。
 */
export function parseChinaMainlandCalendarPayload(
  text: string,
  expectedYear: number | null,
): ParsedHolidayPayload {
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new HolidayParseError('节假日数据不是有效 ICS');
  }
  const lines = unfoldIcs(text);
  const entries: HolidayDay[] = [];
  let inEvent = false;
  let summary = '';
  let categories: string[] = [];
  let start: string | null = null;
  let end: string | null = null;

  const flush = () => {
    if (!start) return;
    const off = categories.some((item) => ICS_OFF_CATEGORIES.has(item));
    const work = categories.some((item) => ICS_WORK_CATEGORIES.has(item));
    if (!off && !work) return;
    if (off && work) {
      throw new HolidayParseError(`节假日数据同一事件既休又班：${summary}`);
    }
    if (!summary) {
      throw new HolidayParseError('节假日数据存在空名称');
    }
    const stop = end && end > start ? end : addDaysISO(start, 1);
    let date = start;
    let count = 0;
    while (date < stop) {
      count += 1;
      if (count > MAX_ICS_RANGE_DAYS) {
        throw new HolidayParseError(
          `节假日数据连续区间超过 ${MAX_ICS_RANGE_DAYS} 天：${summary}`,
        );
      }
      if (Number(date.slice(0, 4)) === expectedYear || expectedYear === null) {
        entries.push({ date, name: summary, isOffDay: off });
      }
      date = addDaysISO(date, 1);
    }
  };

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      inEvent = true;
      summary = '';
      categories = [];
      start = null;
      end = null;
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (inEvent) flush();
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;
    const property = propertyValue(line);
    if (!property) continue;
    if (property.name === 'SUMMARY') {
      summary = unescapeIcsSummary(property.value);
    } else if (property.name === 'CATEGORIES') {
      categories = property.value
        .split(/[,;；]/)
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (property.name === 'DTSTART') {
      start = icsDate(property.value);
    } else if (property.name === 'DTEND') {
      end = icsDate(property.value);
    }
  }

  const year = expectedYear ?? inferIcsYear(entries);
  if (year === null) {
    throw new HolidayParseError('china-mainland-calendar 数据无法确定年份');
  }
  const days = collectHolidayDays(entries);
  if (days.length === 0) {
    throw new HolidayNotPublishedError(
      year,
      `${year} 年节假日数据尚未公布（ICS 无本年节假日事件）`,
    );
  }
  assertHolidayDays(year, days);
  return { year, days, papers: [] };
}

function inferIcsYear(entries: readonly HolidayDay[]): number | null {
  const first = entries[0];
  return first ? Number(first.date.slice(0, 4)) : null;
}

/** 按源格式分派解析器。 */
export function parseHolidaySourcePayload(
  format: HolidayFormat,
  text: string,
  expectedYear: number | null,
): ParsedHolidayPayload {
  if (format === 'chinese-days-json') {
    return parseChineseDaysPayload(text, expectedYear);
  }
  if (format === 'ics') {
    return parseChinaMainlandCalendarPayload(text, expectedYear);
  }
  return parseHolidayPayload(text, expectedYear);
}

/** 当前年要求至少 5 天；下一年允许空包/无数据（标记未公布）。 */
export function holidayMinimumDays(year: number, now: Date): number {
  return year <= now.getFullYear() ? MIN_CURRENT_YEAR_DAYS : 0;
}

/** 远程版本标识：优先 ETag，其次 Last-Modified，最后同步时间。 */
export function holidayPackageVersion(
  etag: string | null,
  lastModified: string | null,
  fetchedAt: string,
): string {
  const etagText = etag?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (etagText) {
    return etagText;
  }
  if (lastModified?.trim()) {
    return lastModified.trim();
  }
  return fetchedAt;
}

/** 轻量内容哈希（FNV-1a 32 位），用于缓存来源指纹，不用于安全校验。 */
export function holidayContentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function holidayPackageFromParsed(
  parsed: ParsedHolidayPayload,
  source: string,
  version: string,
  fetchedAt: string,
): HolidayPackage {
  return {
    year: parsed.year,
    days: parsed.days,
    source,
    version,
    origin: 'remote',
    fetchedAt,
    papers: parsed.papers,
  };
}

export function assertRemoteSource(
  preferences: HolidayPreferences,
): asserts preferences is HolidayPreferences & {
  source: Exclude<HolidayPreferences['source'], 'builtin'>;
} {
  const normalized = normalizeHolidayPreferences(preferences);
  if (normalized.mode === 'builtin') {
    throw new HolidaySourceError('内置节假日数据无需联网同步');
  }
}
