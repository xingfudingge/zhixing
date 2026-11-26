/**
 * 节假日同步入口。
 *
 *   const service = createDefaultHolidaySyncService();
 *   const result = await service.sync(
 *     normalizeHolidayPreferences({ mode: 'auto', autoSync: true }),
 *   );
 *
 * 缓存放 IndexedDB；测试/无 IndexedDB 的浏览器预览使用模块级内存缓存，
 * 保证设置页功能可点击，但刷新后不保留（UI 会说明）。
 */

import {
  IndexedDbHolidayPackageStore,
  MemoryHolidayPackageStore,
  holidayCacheKey,
  isIndexedDbAvailableForHolidays,
  resetHolidayDb,
} from './store';
import {
  HolidaySyncService,
  createHolidaySyncService,
  defaultHolidaySyncState,
  type HolidayFetchLike,
  type HolidayHttpClient,
  type HolidayHttpTransportKind,
  type HolidayInvokeLike,
  type HolidaySyncServiceOptions,
} from './sync';

export { HolidaySyncService, createHolidaySyncService, defaultHolidaySyncState };
export type {
  HolidayFetchLike,
  HolidayHttpClient,
  HolidayHttpTransportKind,
  HolidayInvokeLike,
  HolidaySyncServiceOptions,
};
export {
  IndexedDbHolidayPackageStore,
  MemoryHolidayPackageStore,
  holidayCacheKey,
  isIndexedDbAvailableForHolidays,
  resetHolidayDb,
};
export type { HolidayPackageStore } from './store';
export {
  BUILTIN_OFFLINE_SOURCE,
  CUSTOM_HOLIDAY_SOURCE,
  HOLIDAY_CN_AUDITED_COMMIT,
  HOLIDAY_CN_DATA_FILE,
  HOLIDAY_CN_LICENSE,
  HOLIDAY_CN_REPO_URL,
  HOLIDAY_CN_SCHEMA_FILE,
  HOLIDAY_SOURCE_DEFINITIONS,
  HOLIDAY_SOURCE_ENDPOINTS,
  assertHolidayDays,
  holidayContentHash,
  holidayMinimumDays,
  holidayPackageFromParsed,
  holidayPackageVersion,
  holidayRequestForYear,
  holidayRequestsForYear,
  holidaySourceDefinition,
  holidaySourceLabel,
  holidayTargetYears,
  isHolidaySourceCovered,
  parseChinaMainlandCalendarPayload,
  parseChineseDaysPayload,
  parseHolidayPayload,
  parseHolidaySourcePayload,
  resolveHolidayTransports,
} from './package';
export type {
  HolidayRequest,
  HolidaySourceDefinition,
  HolidayTransportDefinition,
  ParsedHolidayPayload,
} from './package';
export {
  DEFAULT_HOLIDAY_PREFERENCES,
  HOLIDAY_FORMATS,
  HOLIDAY_SOURCE_CHOICES,
  HOLIDAY_SOURCE_IDS,
  HOLIDAY_SOURCE_OPTIONS,
  HOLIDAY_TRANSPORTS,
  HolidayFetchError,
  HolidayNotPublishedError,
  HolidayParseError,
  HolidaySourceError,
  applyHolidaySourceChoice,
  emptySourceStatus,
  holidaySourceChoice,
  inferHolidayCustomFormat,
  legacySourceFor,
  normalizeFormat,
  normalizeHolidayPreferences,
  normalizeHolidaySyncState,
  normalizeSourceId,
  normalizeTransport,
  redactHolidayUrl,
  validateHolidayCustomUrl,
} from './types';
export type {
  HolidayCacheRecord,
  HolidayCacheSourceId,
  HolidayCacheTransport,
  HolidayFormat,
  HolidayPreferenceMode,
  HolidayPreferences,
  HolidaySourceChoice,
  HolidaySourceId,
  HolidaySourceKind,
  HolidaySourceStatus,
  HolidaySyncAttempt,
  HolidaySyncAttemptStatus,
  HolidaySyncResult,
  HolidaySyncState,
  HolidayTransport,
} from './types';
export {
  getRuntimeHolidayLookup,
  setRuntimeHolidayPackages,
} from './runtime';

let fallbackStore: MemoryHolidayPackageStore | null = null;

function defaultStore() {
  if (isIndexedDbAvailableForHolidays()) {
    return new IndexedDbHolidayPackageStore();
  }
  fallbackStore ??= new MemoryHolidayPackageStore();
  return fallbackStore;
}

export function createDefaultHolidaySyncService(
  options: Partial<
    Pick<HolidaySyncServiceOptions, 'fetchImpl' | 'now' | 'timeoutMs'>
  > = {},
): HolidaySyncService {
  return createHolidaySyncService({
    store: defaultStore(),
    ...options,
  });
}
