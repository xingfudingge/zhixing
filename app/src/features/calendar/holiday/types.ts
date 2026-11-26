/**
 * 节假日同步源的领域类型、源选择与偏好归一化。
 *
 * 源（upstream）与传输（transport）是两件事：
 * - 内置源只有 3 个独立上游：holiday-cn / chinese-days /
 *   china-mainland-calendar（均为 MIT）。同一仓库的 jsDelivr / GitHub Raw
 *   只是传输，不重复计为源。
 * - 内置离线 2026 包与自定义 URL 独立于这 3 个远端源。
 *
 * 本模块不发起网络请求，也不读写设置；只提供纯函数与错误类型。
 */

import type { HolidayPackage } from '../../../data/calendar/holidays';

/** 当前真正提供数据的 3 个独立内置上游。 */
export const HOLIDAY_SOURCE_IDS = [
  'holiday-cn',
  'chinese-days',
  'china-mainland-calendar',
] as const;

export type HolidaySourceId = (typeof HOLIDAY_SOURCE_IDS)[number];

/** 缓存键里的源：远端上游、自定义 URL 或内置离线包。 */
export type HolidayCacheSourceId = HolidaySourceId | 'custom' | 'builtin';

/**
 * 传输方式。`auto` 表示按源定义顺序选择主传输；
 * `github-raw` / `unpkg` 是同一仓库/包的镜像，不增加独立源计数。
 */
export const HOLIDAY_TRANSPORTS = [
  'auto',
  'jsdelivr',
  'github-raw',
  'unpkg',
] as const;

export type HolidayTransport = (typeof HOLIDAY_TRANSPORTS)[number];
export type HolidayActualTransport = Exclude<HolidayTransport, 'auto'>;
export type HolidayCacheTransport = HolidayActualTransport | 'auto';

export const HOLIDAY_FORMATS = [
  'holiday-cn-json',
  'chinese-days-json',
  'ics',
] as const;

export type HolidayFormat = (typeof HOLIDAY_FORMATS)[number];

/** 偏好模式：内置离线 / 自动 failover / 固定单源 / 自定义 URL。 */
export type HolidayPreferenceMode = 'builtin' | 'auto' | 'single' | 'custom';

/** 旧版本枚举。只作为迁移输入与兼容字段，不再作为 UI 主选项。 */
export type HolidaySourceKind = 'builtin' | 'jsdelivr' | 'github' | 'custom';

export type HolidayPreferences = {
  mode: HolidayPreferenceMode;
  /** 固定源或自动模式的偏好源；内置/自定义模式下仅保留上次选择。 */
  sourceId: HolidaySourceId;
  transport: HolidayTransport;
  /** 仅 `mode=custom` 时使用；支持 `{year}` 占位符。 */
  customUrl: string;
  customFormat: HolidayFormat;
  /** 打开日历页/设置页时是否在后台检查更新；默认关闭。 */
  autoSync: boolean;
  /** 当前源失败时是否按优先级回退到其它内置源/传输。 */
  autoFallback: boolean;
  /**
   * @deprecated 旧字段，仅为兼容 CalendarStore / 旧备份读取。
   * 由 `mode` + `transport` 推导；写回时同步保留，下一大版本再删除。
   */
  source: HolidaySourceKind;
};

export type HolidayCacheRecord = {
  /** `${sourceId}|${transport}|${year}`，IndexedDB 主键。 */
  cacheKey: string;
  sourceId: HolidayCacheSourceId;
  transport: HolidayCacheTransport;
  format: HolidayFormat;
  year: number;
  package: HolidayPackage;
  etag: string | null;
  lastModified: string | null;
  contentHash: string;
  fetchedAt: string;
};

export type HolidaySourceStatus = {
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  cachedYears: number[];
  notPublishedYears: number[];
};

export type HolidaySyncState = {
  /** @deprecated 兼容字段，由 mode/transport 推导。 */
  source: HolidaySourceKind;
  mode: HolidayPreferenceMode;
  sourceId: HolidaySourceId;
  transport: HolidayTransport;
  /** 最近一次实际提供当前年数据的源/传输。 */
  activeSourceId: HolidayCacheSourceId | null;
  activeTransport: HolidayCacheTransport | null;
  lastGoodSourceId: HolidaySourceId | null;
  fallbackUsed: boolean;
  fallbackFromSourceId: HolidaySourceId | null;
  fallbackReason: string | null;
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastErrorSourceId: HolidaySourceId | null;
  nextRetryAt: string | null;
  consecutiveFailures: number;
  version: string;
  cachedYears: number[];
  /** 上游文件存在但 days 为空（例如每年公布前的 2027.json）。 */
  notPublishedYears: number[];
  stale: boolean;
  perSource: Partial<Record<HolidaySourceId, HolidaySourceStatus>>;
};

export type HolidaySyncAttemptStatus =
  | 'success'
  | 'not-modified'
  | 'not-published'
  | 'failed';

export type HolidaySyncAttempt = {
  sourceId: HolidayCacheSourceId;
  transport: HolidayCacheTransport;
  year: number;
  status: HolidaySyncAttemptStatus;
  error: string | null;
};

export type HolidaySyncResult = {
  state: HolidaySyncState;
  packages: HolidayPackage[];
  fetchedYears: number[];
  notModified: boolean;
  notPublishedYears: number[];
  attempts: HolidaySyncAttempt[];
  activeSourceId: HolidayCacheSourceId;
  activeTransport: HolidayCacheTransport;
  fallbackUsed: boolean;
  fallbackFromSourceId: HolidaySourceId | null;
  fallbackReason: string | null;
  /** 当前年成功、下一年失败/未公布时为 true；不能整体标红。 */
  partial: boolean;
  warnings: string[];
};

export class HolidaySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HolidaySourceError';
  }
}

export class HolidayFetchError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'HolidayFetchError';
    this.status = status;
  }
}

export class HolidayParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HolidayParseError';
  }
}

export class HolidayNotPublishedError extends Error {
  readonly year: number;

  constructor(year: number, message: string) {
    super(message);
    this.name = 'HolidayNotPublishedError';
    this.year = year;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isHolidaySourceId(value: unknown): value is HolidaySourceId {
  return (
    typeof value === 'string' &&
    (HOLIDAY_SOURCE_IDS as readonly string[]).includes(value)
  );
}

/** 缓存键里的源包含远端、自定义和内置离线；用于读取持久化 active 字段。 */
function persistedCacheSourceId(value: unknown): HolidayCacheSourceId | null {
  if (value === 'builtin' || value === 'custom') return value;
  return isHolidaySourceId(value) ? value : null;
}

function isHolidayCacheTransport(
  value: unknown,
): value is HolidayCacheTransport {
  return (
    typeof value === 'string' &&
    (HOLIDAY_TRANSPORTS as readonly string[]).includes(value)
  );
}

export function normalizeSourceId(value: unknown): HolidaySourceId {
  const raw = text(value);
  if (
    raw === 'holiday-cn' ||
    raw === 'holidaycn' ||
    raw === 'holiday_cn' ||
    raw === 'nate' ||
    raw === 'natescarlet' ||
    raw === 'jsdelivr' ||
    raw === 'cdn' ||
    raw === 'jsdelivr-cdn' ||
    raw === 'github' ||
    raw === 'github-raw' ||
    raw === 'raw'
  ) {
    return 'holiday-cn';
  }
  if (
    raw === 'chinese-days' ||
    raw === 'chinesedays' ||
    raw === 'chinese_days' ||
    raw === 'vsme'
  ) {
    return 'chinese-days';
  }
  if (
    raw === 'china-mainland-calendar' ||
    raw === 'china-mainland' ||
    raw === 'mainland' ||
    raw === 'lancetwang'
  ) {
    return 'china-mainland-calendar';
  }
  return 'holiday-cn';
}

export function normalizeTransport(value: unknown): HolidayTransport {
  const raw = text(value);
  if (raw === 'github' || raw === 'github-raw' || raw === 'raw') {
    return 'github-raw';
  }
  if (raw === 'unpkg') {
    return 'unpkg';
  }
  if (
    raw === 'jsdelivr' ||
    raw === 'cdn' ||
    raw === 'jsdelivr-cdn'
  ) {
    return 'jsdelivr';
  }
  return 'auto';
}

export function normalizeFormat(value: unknown): HolidayFormat {
  const raw = text(value);
  if (
    raw === 'chinese-days-json' ||
    raw === 'chinese-days' ||
    raw === 'chinesedays'
  ) {
    return 'chinese-days-json';
  }
  if (raw === 'ics' || raw === 'icalendar' || raw === 'text/calendar') {
    return 'ics';
  }
  return 'holiday-cn-json';
}

/**
 * 由 URL 后缀推断自定义源格式：`.ics` → ICS，否则按 holiday-cn JSON。
 * 无法判断时不抛错，设置页会同时显示当前推断结果。
 */
export function inferHolidayCustomFormat(value: string): HolidayFormat {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.endsWith('.ics') || trimmed.includes('.ics?')) {
    return 'ics';
  }
  return 'holiday-cn-json';
}

function normalizeMode(value: unknown): HolidayPreferenceMode {
  const raw = text(value);
  if (raw === 'auto') return 'auto';
  if (raw === 'single' || raw === 'fixed' || raw === 'remote') return 'single';
  if (raw === 'custom' || raw === '自定义' || raw === 'custom-url') {
    return 'custom';
  }
  if (raw === 'builtin' || raw === 'offline' || raw === '内置') {
    return 'builtin';
  }
  return 'builtin';
}

function legacySourceId(value: unknown): HolidaySourceId | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (raw === 'custom') return null;
  if (raw === 'builtin') return 'holiday-cn';
  return normalizeSourceId(raw);
}

function legacyTransport(value: unknown): HolidayTransport | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (raw === 'github' || raw === 'github-raw' || raw === 'raw') {
    return 'github-raw';
  }
  if (raw === 'jsdelivr' || raw === 'cdn' || raw === 'jsdelivr-cdn') {
    return 'jsdelivr';
  }
  return null;
}

export function legacySourceFor(
  mode: HolidayPreferenceMode,
  transport: HolidayTransport,
): HolidaySourceKind {
  if (mode === 'builtin') return 'builtin';
  if (mode === 'custom') return 'custom';
  return transport === 'github-raw' ? 'github' : 'jsdelivr';
}

export const DEFAULT_HOLIDAY_PREFERENCES: HolidayPreferences = {
  mode: 'builtin',
  sourceId: 'holiday-cn',
  transport: 'auto',
  customUrl: '',
  customFormat: 'holiday-cn-json',
  autoSync: false,
  autoFallback: false,
  source: 'builtin',
};

/** 设置页单一选择器：自动 / 3 个独立源 / 内置离线 / 自定义。 */
export const HOLIDAY_SOURCE_CHOICES = [
  {
    value: 'auto',
    label: '自动（holiday-cn → chinese-days → china-mainland-calendar）',
  },
  { value: 'holiday-cn', label: 'holiday-cn（主源 · MIT）' },
  { value: 'chinese-days', label: 'chinese-days（备源 · MIT）' },
  {
    value: 'china-mainland-calendar',
    label: 'china-mainland-calendar（最后备源 · MIT）',
  },
  { value: 'builtin', label: '内置离线 2026（不联网）' },
  { value: 'custom', label: '自定义 URL' },
] as const;

export type HolidaySourceChoice =
  | 'auto'
  | HolidaySourceId
  | 'builtin'
  | 'custom';

export const HOLIDAY_SOURCE_OPTIONS = HOLIDAY_SOURCE_CHOICES;

export function holidaySourceChoice(
  preferences: HolidayPreferences,
): HolidaySourceChoice {
  if (preferences.mode === 'builtin') return 'builtin';
  if (preferences.mode === 'custom') return 'custom';
  if (preferences.mode === 'auto') return 'auto';
  return preferences.sourceId;
}

export function applyHolidaySourceChoice(
  preferences: HolidayPreferences,
  choice: HolidaySourceChoice,
): HolidayPreferences {
  if (choice === 'builtin') {
    return normalizeHolidayPreferences({
      ...preferences,
      mode: 'builtin',
    });
  }
  if (choice === 'custom') {
    return normalizeHolidayPreferences({
      ...preferences,
      mode: 'custom',
    });
  }
  if (choice === 'auto') {
    return normalizeHolidayPreferences({
      ...preferences,
      mode: 'auto',
    });
  }
  return normalizeHolidayPreferences({
    ...preferences,
    mode: 'single',
    sourceId: choice,
  });
}

/**
 * 容错解析设置值。兼容：
 * - 新对象 `{mode, sourceId, transport, customUrl, customFormat, autoSync, autoFallback}`；
 * - 旧对象 `{source: 'builtin'|'jsdelivr'|'github'|'custom', customUrl, autoSync}`；
 * - 旧字符串枚举；
 * - 二次迁移（已有 mode 但缺 sourceId/transport）。
 */
export function normalizeHolidayPreferences(
  value: unknown,
): HolidayPreferences {
  if (typeof value === 'string') {
    const raw = text(value);
    const known = new Set([
      'builtin',
      'offline',
      '内置',
      'jsdelivr',
      'cdn',
      'jsdelivr-cdn',
      'github',
      'github-raw',
      'raw',
      'custom',
      '自定义',
      'custom-url',
    ]);
    return known.has(raw)
      ? normalizeHolidayPreferences({ source: raw })
      : { ...DEFAULT_HOLIDAY_PREFERENCES };
  }
  if (!isRecord(value)) {
    return { ...DEFAULT_HOLIDAY_PREFERENCES };
  }

  const legacy = text(value.source ?? value.kind ?? value.preset);
  const explicitMode = value.mode ?? value.sourceMode;
  const explicitSourceId = value.sourceId ?? value.upstream;
  const explicitTransport = value.transport ?? value.channel;

  let mode: HolidayPreferenceMode;
  if (explicitMode !== undefined) {
    mode = normalizeMode(explicitMode);
  } else if (legacy === 'custom' || legacy === '自定义') {
    mode = 'custom';
  } else if (legacy === 'builtin' || legacy === '内置' || legacy === 'offline') {
    mode = 'builtin';
  } else if (
    legacy === 'jsdelivr' ||
    legacy === 'cdn' ||
    legacy === 'jsdelivr-cdn' ||
    legacy === 'github' ||
    legacy === 'github-raw' ||
    legacy === 'raw'
  ) {
    // 旧 jsdelivr/github 表示“固定 holiday-cn 源 + 对应传输”。
    mode = 'single';
  } else if (explicitSourceId !== undefined) {
    mode = 'single';
  } else {
    mode = 'builtin';
  }

  const mappedLegacySource = legacySourceId(
    explicitSourceId !== undefined ? explicitSourceId : legacy,
  );
  const sourceId =
    mappedLegacySource ?? normalizeSourceId(explicitSourceId ?? legacy);

  let transport = normalizeTransport(
    explicitTransport !== undefined ? explicitTransport : legacy,
  );
  if (mode === 'builtin' || mode === 'custom') {
    transport = 'auto';
  }

  const customUrl =
    typeof value.customUrl === 'string'
      ? value.customUrl.trim()
      : typeof value.url === 'string'
        ? value.url.trim()
        : '';
  const customFormat =
    value.customFormat !== undefined
      ? normalizeFormat(value.customFormat)
      : customUrl
        ? inferHolidayCustomFormat(customUrl)
        : 'holiday-cn-json';

  return {
    mode,
    sourceId,
    transport,
    customUrl,
    customFormat,
    autoSync: value.autoSync === true || value.autoSync === 'true',
    // 旧设置没有该字段：自动模式默认回退；手动固定单源默认尊重用户选择，
    // 只有用户显式打开 autoFallback 才在单源失败时切换。
    autoFallback:
      value.autoFallback === true || value.autoFallback === 'true'
        ? true
        : value.autoFallback === false || value.autoFallback === 'false'
          ? false
          : mode === 'auto',
    source: legacySourceFor(mode, transport),
  };
}

/** 清空一个源状态，保留其余源的最近结果。 */
export function emptySourceStatus(): HolidaySourceStatus {
  return {
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastError: null,
    cachedYears: [],
    notPublishedYears: [],
  };
}

/**
 * 兼容旧 IndexedDB 状态。旧状态只有 `source` 等字段；迁移后仍能显示
 * 当前源、上次同步与缓存年份，不会因为缺少新字段白屏。
 */
export function normalizeHolidaySyncState(
  value: unknown,
): HolidaySyncState | null {
  if (!isRecord(value)) return null;
  const preferences = normalizeHolidayPreferences(value);
  const persistedActiveSourceId = persistedCacheSourceId(value.activeSourceId);
  const legacySource = text(value.source);
  const legacyActiveSourceId: HolidayCacheSourceId | null =
    legacySource === 'builtin'
      ? null
      : legacySource === 'custom'
        ? 'custom'
        : legacySource
          ? preferences.sourceId
          : null;
  // 持久化的 active 是“最近一次真实提供当前年数据的源”，必须优先恢复；
  // 显式 null（例如清除当前源后）也是有效状态，不能再用旧字段推导；
  // 只有字段缺失或非法时才退回旧字段，避免回退后被偏好源覆盖。
  const hasPersistedActive = value.activeSourceId !== undefined;
  const activeSourceId: HolidayCacheSourceId | null = hasPersistedActive
    ? value.activeSourceId === null
      ? null
      : (persistedActiveSourceId ?? legacyActiveSourceId)
    : legacyActiveSourceId;
  const persistedActiveTransport = isHolidayCacheTransport(
    value.activeTransport,
  )
    ? value.activeTransport
    : null;
  const legacyActiveTransport: HolidayCacheTransport | null =
    legacySource === 'jsdelivr' || legacySource === 'github'
      ? (legacyTransport(legacySource) ?? preferences.transport)
      : activeSourceId
        ? preferences.transport === 'auto'
          ? 'jsdelivr'
          : preferences.transport
        : null;
  const activeTransport: HolidayCacheTransport | null =
    persistedActiveSourceId !== null
      ? persistedActiveTransport
      : legacyActiveTransport;

  const cachedYears = Array.isArray(value.cachedYears)
    ? value.cachedYears.filter((item): item is number =>
        typeof item === 'number' && Number.isInteger(item),
      )
    : [];
  const notPublishedYears = Array.isArray(value.notPublishedYears)
    ? value.notPublishedYears.filter((item): item is number =>
        typeof item === 'number' && Number.isInteger(item),
      )
    : [];
  const lastSyncAt = typeof value.lastSyncAt === 'string' ? value.lastSyncAt : null;

  const perSource: Partial<Record<HolidaySourceId, HolidaySourceStatus>> = {};
  if (isRecord(value.perSource)) {
    for (const sourceId of HOLIDAY_SOURCE_IDS) {
      const entry = value.perSource[sourceId];
      if (!isRecord(entry)) continue;
      perSource[sourceId] = {
        lastSuccessAt:
          typeof entry.lastSuccessAt === 'string' ? entry.lastSuccessAt : null,
        lastAttemptAt:
          typeof entry.lastAttemptAt === 'string' ? entry.lastAttemptAt : null,
        lastError: typeof entry.lastError === 'string' ? entry.lastError : null,
        cachedYears: Array.isArray(entry.cachedYears)
          ? entry.cachedYears.filter(
              (item): item is number => typeof item === 'number',
            )
          : [],
        notPublishedYears: Array.isArray(entry.notPublishedYears)
          ? entry.notPublishedYears.filter(
              (item): item is number => typeof item === 'number',
            )
          : [],
      };
    }
  } else if (
    activeSourceId &&
    activeSourceId !== 'custom' &&
    activeSourceId !== 'builtin'
  ) {
    perSource[activeSourceId] = {
      lastSuccessAt: lastSyncAt,
      lastAttemptAt:
        typeof value.lastAttemptAt === 'string' ? value.lastAttemptAt : null,
      lastError: typeof value.lastError === 'string' ? value.lastError : null,
      cachedYears,
      notPublishedYears,
    };
  }
  if (
    Object.keys(perSource).length === 0 &&
    activeSourceId &&
    activeSourceId !== 'custom' &&
    activeSourceId !== 'builtin'
  ) {
    perSource[activeSourceId] = {
      lastSuccessAt: lastSyncAt,
      lastAttemptAt:
        typeof value.lastAttemptAt === 'string' ? value.lastAttemptAt : null,
      lastError: typeof value.lastError === 'string' ? value.lastError : null,
      cachedYears,
      notPublishedYears,
    };
  }

  return {
    source: legacySourceFor(preferences.mode, preferences.transport),
    mode: preferences.mode,
    sourceId: preferences.sourceId,
    transport: preferences.transport,
    activeSourceId,
    activeTransport,
    lastGoodSourceId: isHolidaySourceId(value.lastGoodSourceId)
      ? value.lastGoodSourceId
      : activeSourceId &&
          activeSourceId !== 'custom' &&
          activeSourceId !== 'builtin'
        ? activeSourceId
        : null,
    fallbackUsed: value.fallbackUsed === true,
    fallbackFromSourceId: isHolidaySourceId(value.fallbackFromSourceId)
      ? value.fallbackFromSourceId
      : null,
    fallbackReason:
      typeof value.fallbackReason === 'string' ? value.fallbackReason : null,
    lastSyncAt,
    lastAttemptAt:
      typeof value.lastAttemptAt === 'string' ? value.lastAttemptAt : null,
    lastError: typeof value.lastError === 'string' ? value.lastError : null,
    lastErrorSourceId: isHolidaySourceId(value.lastErrorSourceId)
      ? value.lastErrorSourceId
      : null,
    nextRetryAt:
      typeof value.nextRetryAt === 'string' ? value.nextRetryAt : null,
    consecutiveFailures:
      typeof value.consecutiveFailures === 'number' &&
      Number.isFinite(value.consecutiveFailures) &&
      value.consecutiveFailures >= 0
        ? Math.floor(value.consecutiveFailures)
        : 0,
    version: typeof value.version === 'string' ? value.version : '',
    cachedYears,
    notPublishedYears,
    stale: value.stale === true,
    perSource,
  };
}

/**
 * 校验自定义源 URL：
 * - 只允许 http/https；
 * - 拒绝内嵌账号密码（避免把凭据写进设置/错误信息）；
 * - 允许 `{year}` 占位符，校验时用 2026 代换。
 */
export function validateHolidayCustomUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new HolidaySourceError('请填写自定义节假日 URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed.replaceAll('{year}', '2026'));
  } catch {
    throw new HolidaySourceError('自定义节假日 URL 不是合法地址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HolidaySourceError('自定义节假日 URL 只支持 http/https');
  }
  if (parsed.username || parsed.password) {
    throw new HolidaySourceError(
      '自定义节假日 URL 不能内嵌账号密码；请使用仅含 token 的地址',
    );
  }
  return trimmed;
}

/** 错误信息/UI 里展示的脱敏地址；不把 query/hash 写进日志或错误。 */
export function redactHolidayUrl(value: string): string {
  try {
    const parsed = new URL(value.replaceAll('{year}', '2026'));
    parsed.username = '';
    parsed.password = '';
    parsed.search = parsed.search ? '?…' : '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '(无效地址)';
  }
}
