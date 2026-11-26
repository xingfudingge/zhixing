/**
 * 节假日同步服务（源模型 v2）。
 *
 * 行为约束：
 * - 内置离线源不联网；默认手动同步，自动同步最多 24h 一次；
 * - 自动/允许回退时按 holiday-cn → chinese-days → china-mainland-calendar
 *   的优先级 failover；失败原因、回退源写入状态，UI 不得静默成功；
 * - 当前年 404/坏包/超时/未覆盖是失败；下一年 404/空包只标记“未公布”；
 * - 缓存按 source + transport + year 隔离，回退绝不复用另一源的 ETag；
 * - 失败/超时/格式错误保留上一次成功缓存，同时写 lastAttemptAt/lastError；
 * - 错误信息只包含脱敏 URL，不写远程响应正文，也不写自定义 URL 的 query。
 *
 * 传输（ZX12-FIX-304-01）：
 * - 桌面生产 CSP 的 `connect-src` 只允许 IPC，WebView 直接 fetch 会被拦；
 * - 浏览器直连时 `If-None-Match` / `If-Modified-Since` 会触发 CORS 预检，
 *   不少源（含 jsDelivr）不允许，第二次同步必失败；
 * - 因此桌面所有远端请求统一走 Rust `http_fetch_text`，条件头不经 CORS；
 * - 无 Tauri 的浏览器预览不做远端请求，明确提示“需桌面壳”，不伪造 304；
 * - 只有真实 HTTP 304 才标记 notModified；镜像 200 不冒充“未变化”。
 */

import { invoke } from '@tauri-apps/api/core';

import { BUILTIN_HOLIDAY_PACKAGE } from '../../../data/calendar/holidays';
import {
  assertHolidayDays,
  holidayContentHash,
  holidayMinimumDays,
  holidayPackageFromParsed,
  holidayPackageVersion,
  holidayRequestsForYear,
  holidaySourceDefinition,
  holidayTargetYears,
  isHolidaySourceCovered,
  parseHolidaySourcePayload,
  resolveHolidayTransports,
  type HolidayRequest,
} from './package';
import type { HolidayPackageStore } from './store';
import {
  HOLIDAY_SOURCE_IDS,
  HolidayFetchError,
  HolidayNotPublishedError,
  HolidayParseError,
  HolidaySourceError,
  emptySourceStatus,
  legacySourceFor,
  normalizeHolidayPreferences,
  normalizeHolidaySyncState,
  redactHolidayUrl,
  type HolidayCacheRecord,
  type HolidayCacheSourceId,
  type HolidayCacheTransport,
  type HolidayPreferences,
  type HolidaySourceId,
  type HolidaySourceStatus,
  type HolidaySyncAttempt,
  type HolidaySyncResult,
  type HolidaySyncState,
} from './types';

export type HolidayFetchLike = (
  input: string,
  init?: RequestInit & { timeoutMs?: number },
) => Promise<Response>;

export type HolidayInvokeLike = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export type HolidayHttpTransportKind = 'desktop-proxy' | 'browser' | 'custom';

/**
 * 节假日远端传输。桌面走 Rust 受限代理；浏览器预览不直连远端；
 * 测试/高级调用方可注入 fetch 并按完整能力处理条件请求。
 */
export type HolidayHttpClient = {
  readonly kind: HolidayHttpTransportKind;
  fetch: HolidayFetchLike;
  /** 条件请求头/304 在该地址上是否真实可用（不经 CORS 预检）。 */
  supportsConditionalHeaders(url: string): boolean;
};

type HttpFetchCommandResponse = {
  status?: number;
  statusText?: string;
  etag?: string | null;
  lastModified?: string | null;
  contentType?: string | null;
  body?: string;
  finalUrl?: string;
};

export type HolidaySyncServiceOptions = {
  store: HolidayPackageStore;
  /** 测试/高级调用方注入 fetch；默认按运行时选择桌面代理或浏览器分支。 */
  fetchImpl?: HolidayFetchLike;
  /** 显式注入传输层（优先于 fetchImpl）。 */
  httpClient?: HolidayHttpClient;
  /** 测试可注入 IPC 实现，验证桌面代理契约。 */
  invokeImpl?: HolidayInvokeLike;
  /** 测试可显式覆盖 Tauri 运行时探测。 */
  runtime?: boolean;
  now?: () => Date;
  timeoutMs?: number;
  /** 自动同步的最小间隔；默认 24h。 */
  autoSyncIntervalMs?: number;
  /** 测试可固定目标年份；正式运行取今年+明年。 */
  targetYears?: (now: Date) => number[];
};

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function toProxyResponse(data: HttpFetchCommandResponse): Response {
  const status = data.status;
  if (
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599
  ) {
    throw new HolidayFetchError(
      `桌面网络代理返回了无效状态码：${String(status)}`,
    );
  }
  const headers = new Headers();
  if (data.etag) headers.set('etag', data.etag);
  if (data.lastModified) headers.set('last-modified', data.lastModified);
  if (data.contentType) headers.set('content-type', data.contentType);
  const body =
    status === 204 || status === 205 || status === 304 ? null : (data.body ?? '');
  return new Response(body, {
    status,
    statusText: data.statusText ?? '',
    headers,
  });
}

function proxyErrorMessage(reason: unknown): string {
  const raw = errorMessage(reason);
  // Rust 的错误已带“桌面网络代理 …”阶段前缀；不要重复包装。
  if (raw.startsWith('桌面网络代理')) return raw;
  if (/unknown command|command .* not found|not registered|未实现/i.test(raw)) {
    return `桌面网络代理命令未注册（http_fetch_text）：${raw}。请更新或重启桌面应用。`;
  }
  if (/permission|not allowed|denied|capabilit|acl/i.test(raw)) {
    return `桌面网络代理未授权：${raw}`;
  }
  if (/超时|timeout|timed out|deadline/i.test(raw)) {
    return `桌面网络代理请求超时：${raw}`;
  }
  return `桌面网络代理失败：${raw}`;
}

function createDesktopHttpClient(invokeImpl: HolidayInvokeLike): HolidayHttpClient {
  return {
    kind: 'desktop-proxy',
    supportsConditionalHeaders: () => true,
    fetch: async (input, init) => {
      const headers = init?.headers
        ? Object.fromEntries(new Headers(init.headers).entries())
        : {};
      try {
        const data = (await invokeImpl('http_fetch_text', {
          url: input,
          headers,
          timeoutMs: init?.timeoutMs,
        })) as HttpFetchCommandResponse;
        return toProxyResponse(data);
      } catch (reason) {
        if (reason instanceof HolidayFetchError) throw reason;
        throw new HolidayFetchError(proxyErrorMessage(reason));
      }
    },
  };
}

function createBrowserHttpClient(): HolidayHttpClient {
  return {
    kind: 'browser',
    // 浏览器直连无法可靠携带条件头：不请求、不伪造 304。
    supportsConditionalHeaders: () => false,
    fetch: async () => {
      throw new HolidayFetchError(
        '当前是浏览器预览：节假日远端同步需桌面壳的受限网络代理（Rust http_fetch_text），浏览器不会直接请求远端，也不会伪造 304。请打开知行桌面应用后重试。',
      );
    },
  };
}

function createCustomHttpClient(fetchImpl: HolidayFetchLike): HolidayHttpClient {
  return {
    kind: 'custom',
    supportsConditionalHeaders: () => true,
    fetch: fetchImpl,
  };
}

function createHolidayHttpClient(
  options: HolidaySyncServiceOptions,
): HolidayHttpClient {
  if (options.httpClient) return options.httpClient;
  if (options.fetchImpl) return createCustomHttpClient(options.fetchImpl);
  const runtime = options.runtime ?? isTauriRuntime();
  if (!runtime) return createBrowserHttpClient();
  return createDesktopHttpClient(
    options.invokeImpl ??
      ((command, args) => invoke(command, args as Record<string, unknown>)),
  );
}

export const DEFAULT_HOLIDAY_AUTO_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = [
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
];

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  return '未知错误';
}

function uniqueYears(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function yearsFromRecords(records: readonly HolidayCacheRecord[]): number[] {
  return uniqueYears(records.map((record) => record.year));
}

function describeVersion(
  packages: ReadonlyArray<{ year: number; version: string }>,
): string {
  if (packages.length === 0) {
    return BUILTIN_HOLIDAY_PACKAGE.version;
  }
  return packages
    .map((item) => `${item.year}:${item.version}`)
    .join(' · ');
}

function sourceName(sourceId: HolidayCacheSourceId): string {
  if (sourceId === 'custom') return '自定义 URL';
  if (sourceId === 'builtin') return '内置离线包';
  return holidaySourceDefinition(sourceId).shortName;
}

export function defaultHolidaySyncState(): HolidaySyncState {
  return {
    source: 'builtin',
    mode: 'builtin',
    sourceId: 'holiday-cn',
    transport: 'auto',
    activeSourceId: null,
    activeTransport: null,
    lastGoodSourceId: null,
    fallbackUsed: false,
    fallbackFromSourceId: null,
    fallbackReason: null,
    lastSyncAt: null,
    lastAttemptAt: null,
    lastError: null,
    lastErrorSourceId: null,
    nextRetryAt: null,
    consecutiveFailures: 0,
    version: BUILTIN_HOLIDAY_PACKAGE.version,
    cachedYears: [BUILTIN_HOLIDAY_PACKAGE.year],
    notPublishedYears: [],
    stale: false,
    perSource: {},
  };
}

type SourceRun = {
  sourceId: HolidayCacheSourceId;
  transport: HolidayCacheTransport;
  attempts: HolidaySyncAttempt[];
  fetchedYears: number[];
  notPublishedYears: number[];
  notModified: boolean;
  currentYearOk: boolean;
  /** 当前年成功、下一年硬失败。 */
  partial: boolean;
  warnings: string[];
  errors: string[];
  lastError: string | null;
  dataFailure: boolean;
  transportFallback: boolean;
  cachedYears: number[];
};

function emptyRun(
  sourceId: HolidayCacheSourceId,
  transport: HolidayCacheTransport,
): SourceRun {
  return {
    sourceId,
    transport,
    attempts: [],
    fetchedYears: [],
    notPublishedYears: [],
    notModified: false,
    currentYearOk: false,
    partial: false,
    warnings: [],
    errors: [],
    lastError: null,
    dataFailure: false,
    transportFallback: false,
    cachedYears: [],
  };
}

type ResolvedActiveCache = {
  sourceId: HolidayCacheSourceId;
  transport: HolidayCacheTransport;
};

function newestRecord(
  records: readonly HolidayCacheRecord[],
): HolidayCacheRecord {
  return records.reduce((latest, record) =>
    record.fetchedAt >= latest.fetchedAt ? record : latest,
  );
}

/** 查找状态声明的 active 源在当前年是否有真实缓存。 */
function activeCacheForYear(
  state: HolidaySyncState,
  records: readonly HolidayCacheRecord[],
  year: number,
): ResolvedActiveCache | null {
  const sourceId = state.activeSourceId;
  if (!sourceId) return null;
  if (sourceId === 'builtin') {
    return {
      sourceId: 'builtin',
      transport: state.activeTransport ?? 'auto',
    };
  }
  const candidates = records.filter(
    (record) => record.sourceId === sourceId && record.year === year,
  );
  if (candidates.length === 0) return null;
  // 传输可能被手动改过；只要该源当前年有缓存就仍算有效，并回报真实传输。
  const exact =
    state.activeTransport && state.activeTransport !== 'auto'
      ? candidates.filter(
          (record) => record.transport === state.activeTransport,
        )
      : [];
  const record = newestRecord(exact.length > 0 ? exact : candidates);
  return { sourceId: record.sourceId, transport: record.transport };
}

function activePreferenceOrder(state: HolidaySyncState): HolidayCacheSourceId[] {
  if (state.mode === 'builtin') return ['builtin'];
  if (state.mode === 'custom') return ['custom'];
  const byPriority = [...HOLIDAY_SOURCE_IDS].sort(
    (a, b) =>
      holidaySourceDefinition(a).priority -
      holidaySourceDefinition(b).priority,
  );
  if (state.mode === 'auto') return byPriority;
  return [state.sourceId, ...byPriority.filter((item) => item !== state.sourceId)];
}

/** active 缓存失效时，按用户偏好与 failover 顺序推导真实可用的源。 */
function deriveActiveCache(
  state: HolidaySyncState,
  records: readonly HolidayCacheRecord[],
  year: number,
): ResolvedActiveCache | null {
  for (const sourceId of activePreferenceOrder(state)) {
    if (sourceId === 'builtin') {
      return { sourceId: 'builtin', transport: 'auto' };
    }
    const candidates = records.filter(
      (record) => record.sourceId === sourceId && record.year === year,
    );
    if (candidates.length === 0) continue;
    const exact =
      state.transport !== 'auto'
        ? candidates.filter((record) => record.transport === state.transport)
        : [];
    const record = newestRecord(exact.length > 0 ? exact : candidates);
    return { sourceId: record.sourceId, transport: record.transport };
  }
  return null;
}

function hasExplicitActiveSource(stored: HolidaySyncState | null): boolean {
  return (
    stored !== null &&
    Object.prototype.hasOwnProperty.call(stored, 'activeSourceId')
  );
}

/**
 * 只在新状态（带 activeSourceId）上校验；旧 IndexedDB 状态没有真实
 * active 字段，继续按 legacy source 迁移，避免把可用缓存误判为空。
 */
function resolveActiveState(
  state: HolidaySyncState,
  records: readonly HolidayCacheRecord[],
  year: number,
  explicit: boolean,
): HolidaySyncState {
  if (!explicit || state.activeSourceId === null) return state;
  const active = activeCacheForYear(state, records, year);
  if (active) {
    if (
      active.sourceId === state.activeSourceId &&
      active.transport === state.activeTransport
    ) {
      return state;
    }
    return {
      ...state,
      activeSourceId: active.sourceId,
      activeTransport: active.transport,
    };
  }
  const derived = deriveActiveCache(state, records, year);
  return {
    ...state,
    activeSourceId: derived?.sourceId ?? null,
    activeTransport: derived?.transport ?? null,
    lastGoodSourceId:
      derived &&
      derived.sourceId !== 'custom' &&
      derived.sourceId !== 'builtin'
        ? derived.sourceId
        : null,
    fallbackUsed: false,
    fallbackFromSourceId: null,
    fallbackReason: null,
  };
}

export class HolidaySyncService {
  private readonly store: HolidayPackageStore;
  private readonly http: HolidayHttpClient;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly autoSyncIntervalMs: number;
  private readonly targetYears: (now: Date) => number[];
  private readonly inFlight = new Map<string, Promise<HolidaySyncResult>>();

  constructor(options: HolidaySyncServiceOptions) {
    this.store = options.store;
    this.http = createHolidayHttpClient(options);
    this.now = options.now ?? (() => new Date());
    // jsDelivr 冷缓存偶发 20s+；桌面代理与 JS 定时器使用同一预算。
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.autoSyncIntervalMs =
      options.autoSyncIntervalMs ?? DEFAULT_HOLIDAY_AUTO_SYNC_INTERVAL_MS;
    this.targetYears = options.targetYears ?? holidayTargetYears;
  }

  /** 供诊断/测试说明当前走桌面代理、浏览器分支还是注入传输。 */
  get transportKind(): HolidayHttpTransportKind {
    return this.http.kind;
  }

  private async resolveStoredState(): Promise<{
    records: HolidayCacheRecord[];
    normalized: HolidaySyncState | null;
    resolved: HolidaySyncState | null;
    repaired: boolean;
  }> {
    const [stored, records] = await Promise.all([
      this.store.getState(),
      this.store.listRecords(),
    ]);
    const normalized = normalizeHolidaySyncState(stored);
    if (!normalized) {
      return { records, normalized: null, resolved: null, repaired: false };
    }
    const resolved = resolveActiveState(
      normalized,
      records,
      this.now().getFullYear(),
      hasExplicitActiveSource(stored),
    );
    const repaired =
      resolved.activeSourceId !== normalized.activeSourceId ||
      resolved.activeTransport !== normalized.activeTransport ||
      resolved.lastGoodSourceId !== normalized.lastGoodSourceId ||
      resolved.fallbackUsed !== normalized.fallbackUsed;
    return { records, normalized, resolved, repaired };
  }

  private activePackages(
    state: HolidaySyncState,
  ): Promise<Awaited<ReturnType<HolidayPackageStore['listPackages']>>> {
    if (!state.activeSourceId || state.activeSourceId === 'builtin') {
      return Promise.resolve([]);
    }
    const transport =
      state.activeTransport && state.activeTransport !== 'auto'
        ? state.activeTransport
        : undefined;
    return this.store.listPackages(state.activeSourceId, transport);
  }

  async listPackages(): Promise<
    Awaited<ReturnType<HolidayPackageStore['listPackages']>>
  > {
    const { normalized, resolved } = await this.resolveStoredState();
    if (!normalized || !resolved) return this.store.listPackages();
    return this.activePackages(resolved);
  }

  async getState(): Promise<HolidaySyncState> {
    const { records, normalized, resolved, repaired } =
      await this.resolveStoredState();
    if (!normalized || !resolved) {
      const packages = await this.store.listPackages();
      return {
        ...defaultHolidaySyncState(),
        cachedYears:
          packages.length > 0
            ? uniqueYears(packages.map((item) => item.year))
            : [BUILTIN_HOLIDAY_PACKAGE.year],
        version:
          packages.length > 0
            ? describeVersion(packages)
            : BUILTIN_HOLIDAY_PACKAGE.version,
      };
    }
    const packages = await this.activePackages(resolved);
    const transport =
      resolved.activeTransport && resolved.activeTransport !== 'auto'
        ? resolved.activeTransport
        : undefined;
    const activeRecords =
      resolved.activeSourceId && resolved.activeSourceId !== 'builtin'
        ? records.filter(
            (record) =>
              record.sourceId === resolved.activeSourceId &&
              (transport === undefined || record.transport === transport),
          )
        : [];
    // 失效时把推导结果写回，避免 IndexedDB 里继续保留错误的 active。
    if (repaired) {
      await this.store.putState(resolved);
    }
    return {
      ...resolved,
      version:
        resolved.version ||
        (packages.length > 0
          ? describeVersion(packages)
          : BUILTIN_HOLIDAY_PACKAGE.version),
      cachedYears:
        resolved.activeSourceId === 'builtin'
          ? [BUILTIN_HOLIDAY_PACKAGE.year]
          : activeRecords.length > 0
            ? yearsFromRecords(activeRecords)
            : resolved.cachedYears.length > 0
              ? resolved.cachedYears
              : [BUILTIN_HOLIDAY_PACKAGE.year],
    };
  }

  /**
   * 只清除真实 active 源的缓存；不删除偏好源或其它源，也不触碰个人例外。
   * 清除后明确回退到内置离线包，直到用户再次同步或手动选源。
   * 返回实际删除的源；当前没有远端 active 缓存时返回 builtin/null。
   */
  async clearCurrent(
    preferences: HolidayPreferences,
  ): Promise<HolidayCacheSourceId | null> {
    const normalized = normalizeHolidayPreferences(preferences);
    const state = await this.getState();
    const target: HolidayCacheSourceId | null =
      normalized.mode === 'builtin' ? 'builtin' : state.activeSourceId;
    if (!target) return null;
    if (target === 'builtin') return 'builtin';

    await this.store.deleteSource(target);
    const previous = normalizeHolidaySyncState(await this.store.getState());
    const perSource = { ...(previous?.perSource ?? state.perSource) };
    if (target !== 'custom') {
      delete perSource[target as HolidaySourceId];
    }
    const currentYear = this.now().getFullYear();
    await this.store.putState({
      ...state,
      activeSourceId: 'builtin',
      activeTransport: 'auto',
      lastGoodSourceId: null,
      lastSyncAt: null,
      lastError: null,
      lastErrorSourceId: null,
      nextRetryAt: null,
      consecutiveFailures: 0,
      fallbackUsed: false,
      fallbackFromSourceId: null,
      fallbackReason: null,
      version: BUILTIN_HOLIDAY_PACKAGE.version,
      cachedYears: [BUILTIN_HOLIDAY_PACKAGE.year],
      notPublishedYears: [],
      stale: BUILTIN_HOLIDAY_PACKAGE.year !== currentYear,
      perSource,
    });
    return target;
  }

  /** 清除全部公共节假日缓存；个人日期例外仍在设置表，不受影响。 */
  async clearAll(): Promise<void> {
    await this.store.clear();
  }

  /** @deprecated 保留旧调用；语义等同清除全部公共缓存。 */
  async clear(): Promise<void> {
    await this.clearAll();
  }

  /**
   * 自动同步：只在开关打开、远端源、且未到退避/24h 节流时执行。
   * 返回 null 表示本次跳过（内置源/关闭/未到期/离线）。
   */
  async maybeAutoSync(
    preferences: HolidayPreferences,
  ): Promise<HolidaySyncResult | null> {
    const normalized = normalizeHolidayPreferences(preferences);
    if (normalized.mode === 'builtin' || !normalized.autoSync) {
      return null;
    }
    if (
      typeof navigator !== 'undefined' &&
      navigator.onLine === false
    ) {
      // 离线不是“同步失败”；不写 lastError，保留缓存等联网后重试。
      return null;
    }
    const state = await this.getState();
    const nowMs = this.now().getTime();
    if (state.lastError) {
      const retryAt =
        state.nextRetryAt ??
        (state.lastAttemptAt
          ? new Date(
              Date.parse(state.lastAttemptAt) + FAILURE_BACKOFF_MS[0]!,
            ).toISOString()
          : null);
      if (retryAt) {
        const retryMs = Date.parse(retryAt);
        if (Number.isFinite(retryMs) && nowMs < retryMs) {
          return null;
        }
      }
    } else {
      const last = state.lastSyncAt;
      if (last) {
        const elapsed = nowMs - Date.parse(last);
        if (
          Number.isFinite(elapsed) &&
          elapsed >= 0 &&
          elapsed < this.autoSyncIntervalMs
        ) {
          return null;
        }
      }
    }
    return this.sync(normalized);
  }

  /** 同一服务实例按偏好去重；不同源/传输同时触发时不会互相复用结果。 */
  sync(preferences: HolidayPreferences): Promise<HolidaySyncResult> {
    const normalized = normalizeHolidayPreferences(preferences);
    const key = JSON.stringify([
      normalized.mode,
      normalized.sourceId,
      normalized.transport,
      normalized.customUrl,
      normalized.customFormat,
    ]);
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    const pending = this.performSync(normalized).finally(() => {
      if (this.inFlight.get(key) === pending) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  private candidatesFor(
    preferences: HolidayPreferences,
  ): Array<HolidaySourceId | 'custom'> {
    if (preferences.mode === 'custom') {
      return ['custom'];
    }
    if (preferences.mode === 'builtin') {
      return [];
    }
    if (preferences.mode === 'auto') {
      return [...HOLIDAY_SOURCE_IDS];
    }
    const ordered = [...HOLIDAY_SOURCE_IDS].sort(
      (a, b) =>
        holidaySourceDefinition(a).priority -
        holidaySourceDefinition(b).priority,
    );
    if (!preferences.autoFallback) {
      return [preferences.sourceId];
    }
    return [
      preferences.sourceId,
      ...ordered.filter((item) => item !== preferences.sourceId),
    ];
  }

  private async performSync(
    preferences: HolidayPreferences,
  ): Promise<HolidaySyncResult> {
    const attemptAt = this.now().toISOString();

    if (preferences.mode === 'builtin') {
      const [records, packages, stored] = await Promise.all([
        this.store.listRecords(),
        this.store.listPackages(),
        this.store.getState(),
      ]);
      const builtinState: HolidaySyncState = {
        ...defaultHolidaySyncState(),
        source: 'builtin',
        mode: 'builtin',
        sourceId: preferences.sourceId,
        transport: 'auto',
        lastSyncAt: attemptAt,
        lastAttemptAt: attemptAt,
        version: BUILTIN_HOLIDAY_PACKAGE.version,
        cachedYears:
          packages.length > 0
            ? uniqueYears(packages.map((item) => item.year))
            : [BUILTIN_HOLIDAY_PACKAGE.year],
        stale: false,
        perSource: this.perSourceFromRecords(
          records,
          normalizeHolidaySyncState(stored),
        ),
      };
      await this.store.putState(builtinState);
      return {
        state: builtinState,
        packages,
        fetchedYears: [],
        notModified: false,
        notPublishedYears: [],
        attempts: [],
        activeSourceId: 'builtin',
        activeTransport: 'auto',
        fallbackUsed: false,
        fallbackFromSourceId: null,
        fallbackReason: null,
        partial: false,
        warnings: [],
      };
    }

    const candidates = this.candidatesFor(preferences);
    if (candidates.length === 0) {
      const reason = new HolidaySourceError('没有可同步的节假日地址');
      await this.recordAllFailure(preferences, attemptAt, [reason.message], []);
      throw reason;
    }

    const attempts: HolidaySyncAttempt[] = [];
    const failures: string[] = [];
    const previousState = normalizeHolidaySyncState(
      await this.store.getState(),
    );
    const perSource: Partial<Record<HolidaySourceId, HolidaySourceStatus>> = {
      ...(previousState?.perSource ?? {}),
    };
    let lastRun: SourceRun | null = null;

    for (const candidate of candidates) {
      const run = await this.syncSource(preferences, candidate);
      lastRun = run;
      attempts.push(...run.attempts);
      if (candidate !== 'custom') {
        const previousStatus =
          perSource[candidate] ?? emptySourceStatus();
        perSource[candidate] = {
          lastSuccessAt: run.currentYearOk
            ? attemptAt
            : (previousStatus.lastSuccessAt ?? null),
          lastAttemptAt: attemptAt,
          lastError: run.currentYearOk
            ? null
            : (run.lastError ?? run.errors[0] ?? null),
          cachedYears: run.cachedYears,
          notPublishedYears: run.notPublishedYears,
        };
      }
      if (run.currentYearOk) {
        const fallbackFromSourceId =
          candidate !== candidates[0] &&
          candidates[0] !== 'custom' &&
          candidate !== 'custom'
            ? (candidates[0] as HolidaySourceId)
            : null;
        const fallbackUsed =
          candidates.indexOf(candidate) > 0 || run.transportFallback;
        const fallbackReason =
          failures.length > 0
            ? failures.join('；')
            : run.transportFallback && run.errors.length > 0
              ? `${sourceName(candidate)}：${run.errors[0]}`
              : null;
        const packages = await this.store.listPackages(
          candidate,
          run.transport,
        );
        const state: HolidaySyncState = {
          source: legacySourceFor(preferences.mode, preferences.transport),
          mode: preferences.mode,
          sourceId: preferences.sourceId,
          transport: preferences.transport,
          activeSourceId: candidate,
          activeTransport: run.transport,
          lastGoodSourceId: candidate === 'custom' ? null : candidate,
          fallbackUsed,
          fallbackFromSourceId,
          fallbackReason,
          lastSyncAt: attemptAt,
          lastAttemptAt: attemptAt,
          lastError: null,
          lastErrorSourceId: null,
          nextRetryAt: null,
          consecutiveFailures: 0,
          version: describeVersion(packages),
          cachedYears: run.cachedYears,
          notPublishedYears: run.notPublishedYears,
          stale: false,
          perSource,
        };
        await this.store.putState(state);
        return {
          state,
          packages,
          fetchedYears: run.fetchedYears,
          notModified: run.notModified,
          notPublishedYears: run.notPublishedYears,
          attempts,
          activeSourceId: candidate,
          activeTransport: run.transport,
          fallbackUsed,
          fallbackFromSourceId,
          fallbackReason,
          partial: run.partial,
          warnings: run.warnings,
        };
      }
      if (run.errors.length > 0) {
        failures.push(
          `${sourceName(candidate)}：${run.errors[0] ?? '同步失败'}`,
        );
      } else if (run.notPublishedYears.length > 0) {
        failures.push(
          `${sourceName(candidate)}：${run.notPublishedYears.join('、')} 年数据未公布`,
        );
      } else {
        failures.push(`${sourceName(candidate)}：同步失败`);
      }
    }

    const message = `所有节假日源均失败：${failures.join('；') || '未知错误'}`;
    await this.recordAllFailure(
      preferences,
      attemptAt,
      failures.length > 0 ? failures : [message],
      attempts,
      perSource,
      lastRun,
    );
    throw new HolidaySourceError(message);
  }

  private async syncSource(
    preferences: HolidayPreferences,
    sourceId: HolidaySourceId | 'custom',
  ): Promise<SourceRun> {
    if (sourceId === 'custom') {
      return this.runTransport(preferences, 'custom', 'auto');
    }
    const definition = holidaySourceDefinition(sourceId);
    const transports = resolveHolidayTransports(
      sourceId,
      preferences.transport,
    );
    if (transports.length === 0) {
      const run = emptyRun(sourceId, 'auto');
      const error = `不支持的传输方式：${preferences.transport}`;
      run.errors.push(error);
      run.lastError = error;
      run.attempts.push({
        sourceId,
        transport: preferences.transport,
        year: this.now().getFullYear(),
        status: 'failed',
        error,
      });
      return run;
    }
    let merged = emptyRun(sourceId, transports[0]!.id);
    for (const transport of transports) {
      const run = await this.runTransport(
        preferences,
        sourceId,
        transport.id,
      );
      merged = {
        ...run,
        attempts: [...merged.attempts, ...run.attempts],
        errors: [...merged.errors, ...run.errors],
        warnings: [...merged.warnings, ...run.warnings],
        transportFallback: merged.attempts.length > 0,
      };
      if (run.currentYearOk) {
        merged.transportFallback = merged.attempts.length > run.attempts.length;
        return merged;
      }
      if (run.dataFailure) {
        // 同一上游的镜像不会修复坏数据，直接换下一个独立源。
        return merged;
      }
      if (definition.transports.length === 1) {
        return merged;
      }
    }
    return merged;
  }

  private async runTransport(
    preferences: HolidayPreferences,
    sourceId: HolidaySourceId | 'custom',
    transport: HolidayCacheTransport,
  ): Promise<SourceRun> {
    const run = emptyRun(sourceId, transport);
    const currentYear = this.now().getFullYear();
    const targets = uniqueYears(this.targetYears(this.now()));
    let requests: Array<{ year: number; request: HolidayRequest }>;
    try {
      requests = this.requestsFor(
        preferences,
        sourceId,
        transport,
        targets,
        currentYear,
        run,
      );
    } catch (reason) {
      const error = errorMessage(reason);
      run.errors.push(error);
      run.lastError = error;
      run.dataFailure = true;
      run.attempts.push({
        sourceId,
        transport,
        year: currentYear,
        status: 'failed',
        error,
      });
      return run;
    }

    if (requests.length === 0) {
      if (run.errors.length === 0) {
        run.lastError = '没有可同步的节假日地址';
        run.errors.push(run.lastError);
      }
      return run;
    }

    for (const { year, request } of requests) {
      let cached: HolidayCacheRecord | null = null;
      if (sourceId === 'custom') {
        cached = await this.findCustomRecord(year);
      } else {
        cached = await this.store.getRecord(sourceId, transport, year);
      }
      const headers: Record<string, string> = {
        accept: 'application/json, text/calendar, text/plain;q=0.8',
      };
      // 只在能真实到达源、且不会被 CORS 预检拒绝的传输上带条件头。
      if (this.http.supportsConditionalHeaders(request.url)) {
        if (cached?.etag) headers['if-none-match'] = cached.etag;
        if (cached?.lastModified) {
          headers['if-modified-since'] = cached.lastModified;
        }
      }

      let response: Response;
      try {
        response = await this.fetchWithTimeout(request.url, headers);
      } catch (reason) {
        const error = errorMessage(reason);
        run.errors.push(error);
        run.lastError = error;
        run.attempts.push({
          sourceId,
          transport,
          year,
          status: 'failed',
          error,
        });
        if (year === currentYear) {
          // 传输失败：允许尝试同一源的镜像传输。
          break;
        }
        run.partial = true;
        run.warnings.push(`${year} 年拉取失败：${error}`);
        break;
      }

      if (response.status === 304) {
        if (!cached) {
          const error = `上游返回 304，但本地没有可用的 ${year} 年缓存`;
          run.errors.push(error);
          run.lastError = error;
          run.attempts.push({
            sourceId,
            transport,
            year,
            status: 'failed',
            error,
          });
          run.dataFailure = true;
          break;
        }
        run.notModified = true;
        run.attempts.push({
          sourceId,
          transport,
          year,
          status: 'not-modified',
          error: null,
        });
        if (year === currentYear) {
          run.currentYearOk = true;
        }
        continue;
      }

      if (!response.ok) {
        // 明年文件在公布前可能是 404；今年 404 仍是真实失败。
        if (response.status === 404 && year > currentYear) {
          run.notPublishedYears.push(year);
          run.attempts.push({
            sourceId,
            transport,
            year,
            status: 'not-published',
            error: null,
          });
          continue;
        }
        const error = `节假日拉取失败（HTTP ${response.status}）：${redactHolidayUrl(
          request.url,
        )}`;
        run.errors.push(error);
        run.lastError = error;
        run.attempts.push({
          sourceId,
          transport,
          year,
          status: 'failed',
          error,
        });
        if (year === currentYear) {
          break;
        }
        run.partial = true;
        run.warnings.push(`${year} 年拉取失败：HTTP ${response.status}`);
        break;
      }

      let raw: string;
      try {
        raw = await this.readWithTimeout(response, request.url);
      } catch (reason) {
        const error = errorMessage(reason);
        run.errors.push(error);
        run.lastError = error;
        run.attempts.push({
          sourceId,
          transport,
          year,
          status: 'failed',
          error,
        });
        if (year !== currentYear) {
          run.partial = true;
          run.warnings.push(`${year} 年内容读取失败：${error}`);
        }
        break;
      }

      let parsed;
      try {
        parsed = parseHolidaySourcePayload(
          request.format,
          raw,
          request.expectedYear,
        );
        assertHolidayDays(parsed.year, parsed.days, {
          minDays: holidayMinimumDays(parsed.year, this.now()),
        });
      } catch (reason) {
        if (reason instanceof HolidayNotPublishedError) {
          run.notPublishedYears.push(reason.year);
          run.attempts.push({
            sourceId,
            transport,
            year,
            status: 'not-published',
            error: null,
          });
          if (year === currentYear) {
            const error = `${sourceName(sourceId)} 当前年 ${reason.year} 数据尚未公布`;
            run.errors.push(error);
            run.lastError = error;
          } else {
            run.warnings.push(`${reason.year} 年数据尚未公布`);
          }
          continue;
        }
        const error =
          reason instanceof HolidayParseError
            ? reason.message
            : `节假日数据格式错误：${errorMessage(reason)}`;
        run.errors.push(error);
        run.lastError = error;
        run.dataFailure = true;
        run.attempts.push({
          sourceId,
          transport,
          year,
          status: 'failed',
          error,
        });
        if (year !== currentYear) {
          run.partial = true;
          run.warnings.push(`${year} 年数据不可用：${error}`);
        }
        break;
      }

      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');
      const fetchedAt = this.now().toISOString();
      const version = holidayPackageVersion(etag, lastModified, fetchedAt);
      const pack = holidayPackageFromParsed(
        parsed,
        sourceId,
        version,
        fetchedAt,
      );
      const record: HolidayCacheRecord = {
        cacheKey: `${sourceId}|${transport}|${pack.year}`,
        sourceId,
        transport,
        format: request.format,
        year: pack.year,
        package: pack,
        etag,
        lastModified,
        contentHash: holidayContentHash(raw),
        fetchedAt,
      };
      await this.store.putRecord(record);
      run.fetchedYears.push(pack.year);
      run.notModified = false;
      run.attempts.push({
        sourceId,
        transport,
        year: pack.year,
        status: 'success',
        error: null,
      });
      if (pack.year === currentYear) {
        run.currentYearOk = true;
      }
    }

    const records = await this.store.listRecords(
      sourceId === 'custom' ? 'custom' : sourceId,
    );
    run.cachedYears = yearsFromRecords(
      sourceId === 'custom'
        ? records
        : records.filter((record) => record.transport === transport),
    );
    if (!run.currentYearOk && !run.lastError) {
      const covered = run.notPublishedYears.includes(currentYear);
      const error = covered
        ? `${sourceName(sourceId)} 当前年数据尚未公布`
        : `${sourceName(sourceId)} 没有返回当前年数据`;
      run.errors.push(error);
      run.lastError = error;
    }
    return run;
  }

  private requestsFor(
    preferences: HolidayPreferences,
    sourceId: HolidaySourceId | 'custom',
    transport: HolidayCacheTransport,
    targets: readonly number[],
    currentYear: number,
    run: SourceRun,
  ): Array<{ year: number; request: HolidayRequest }> {
    if (sourceId === 'custom') {
      const requests: Array<{ year: number; request: HolidayRequest }> = [];
      const seen = new Set<string>();
      for (const year of targets) {
        const request = holidayRequestsForYear(preferences, year)[0];
        if (!request || seen.has(request.url)) continue;
        seen.add(request.url);
        requests.push({ year, request });
      }
      return requests;
    }

    const definition = holidaySourceDefinition(sourceId);
    const result: Array<{ year: number; request: HolidayRequest }> = [];
    for (const year of targets) {
      if (!isHolidaySourceCovered(definition.id, year)) {
        if (year > currentYear) {
          run.notPublishedYears.push(year);
          run.attempts.push({
            sourceId,
            transport,
            year,
            status: 'not-published',
            error: null,
          });
        } else {
          const error = `${definition.shortName} 不覆盖当前年 ${year}`;
          run.errors.push(error);
          run.lastError = error;
          run.dataFailure = true;
          run.attempts.push({
            sourceId,
            transport,
            year,
            status: 'failed',
            error,
          });
        }
        continue;
      }
      const request = holidayRequestsForYear(
        {
          ...preferences,
          mode: 'single',
          sourceId: definition.id,
          transport:
            transport === 'auto' ? preferences.transport : transport,
        },
        year,
      ).find((item) => item.transport === transport);
      if (!request) continue;
      if (result.some((item) => item.request.url === request.url)) continue;
      result.push({ year, request });
    }
    return result;
  }

  private async findCustomRecord(year: number): Promise<HolidayCacheRecord | null> {
    const records = await this.store.listRecords('custom');
    return (
      records.find((record) => record.year === year) ??
      records[records.length - 1] ??
      null
    );
  }

  private async fetchWithTimeout(
    url: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const timeoutError = new HolidayFetchError(
      `节假日同步超时（超过 ${this.timeoutMs} ms）：${redactHolidayUrl(url)}`,
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([
        this.http.fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
          timeoutMs: this.timeoutMs,
        }),
        timeoutPromise,
      ]);
    } catch (reason) {
      if (timedOut) {
        throw timeoutError;
      }
      if (reason instanceof HolidayFetchError) {
        throw reason;
      }
      throw new HolidayFetchError(
        `无法获取节假日数据（${redactHolidayUrl(url)}）：${errorMessage(reason)}`,
      );
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  private async readWithTimeout(
    response: Response,
    url: string,
  ): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const timeoutError = new HolidayFetchError(
      `读取节假日内容超时（超过 ${this.timeoutMs} ms）：${redactHolidayUrl(url)}`,
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(timeoutError);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([response.text(), timeoutPromise]);
    } catch (reason) {
      if (timedOut) {
        throw timeoutError;
      }
      if (reason instanceof HolidayFetchError) {
        throw reason;
      }
      throw new HolidayFetchError(
        `读取节假日内容失败（${redactHolidayUrl(url)}）：${errorMessage(reason)}`,
      );
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }

  private perSourceFromRecords(
    records: readonly HolidayCacheRecord[],
    previous: HolidaySyncState | null,
  ): Partial<Record<HolidaySourceId, HolidaySourceStatus>> {
    const perSource: Partial<Record<HolidaySourceId, HolidaySourceStatus>> = {
      ...(previous?.perSource ?? {}),
    };
    for (const sourceId of HOLIDAY_SOURCE_IDS) {
      const sourceRecords = records.filter(
        (record) => record.sourceId === sourceId,
      );
      if (sourceRecords.length === 0 && !perSource[sourceId]) continue;
      const status = perSource[sourceId] ?? emptySourceStatus();
      perSource[sourceId] = {
        ...status,
        cachedYears: yearsFromRecords(sourceRecords),
      };
    }
    return perSource;
  }

  private async recordAllFailure(
    preferences: HolidayPreferences,
    attemptAt: string,
    failures: readonly string[],
    attempts: readonly HolidaySyncAttempt[],
    perSourceInput: Partial<Record<HolidaySourceId, HolidaySourceStatus>> = {},
    lastRun: SourceRun | null = null,
  ): Promise<void> {
    const [records, stored] = await Promise.all([
      this.store.listRecords(),
      this.store.getState(),
    ]);
    const previous = normalizeHolidaySyncState(stored);
    const perSource = this.perSourceFromRecords(records, previous);
    for (const [key, value] of Object.entries(perSourceInput)) {
      perSource[key as HolidaySourceId] = value;
    }
    const currentYear = this.now().getFullYear();
    const hasCurrentYearCache = records.some(
      (record) => record.year === currentYear,
    );
    const activeSourceId =
      previous?.activeSourceId ??
      (hasCurrentYearCache
        ? records.find((record) => record.year === currentYear)?.sourceId
        : null) ??
      null;
    const activeTransport =
      previous?.activeTransport ??
      (activeSourceId
        ? (records.find(
            (record) =>
              record.sourceId === activeSourceId &&
              record.year === currentYear,
          )?.transport ?? null)
        : null);
    const activeRecords = activeSourceId
      ? records.filter((record) => record.sourceId === activeSourceId)
      : records;
    const failuresCount = (previous?.consecutiveFailures ?? 0) + 1;
    const backoff =
      FAILURE_BACKOFF_MS[
        Math.min(failuresCount - 1, FAILURE_BACKOFF_MS.length - 1)
      ]!;
    const lastErrorSourceId =
      lastRun && lastRun.sourceId !== 'custom' && lastRun.sourceId !== 'builtin'
        ? lastRun.sourceId
        : null;
    const nextRetryAt = new Date(
      this.now().getTime() + backoff,
    ).toISOString();

    await this.store.putState({
      source: legacySourceFor(preferences.mode, preferences.transport),
      mode: preferences.mode,
      sourceId: preferences.sourceId,
      transport: preferences.transport,
      activeSourceId,
      activeTransport,
      lastGoodSourceId:
        previous?.lastGoodSourceId ??
        (activeSourceId &&
        activeSourceId !== 'builtin' &&
        activeSourceId !== 'custom'
          ? activeSourceId
          : null),
      fallbackUsed: false,
      fallbackFromSourceId:
        attempts.length > 0 && attempts[0]!.sourceId !== 'custom'
          ? (attempts[0]!.sourceId as HolidaySourceId)
          : null,
      fallbackReason: null,
      lastSyncAt: previous?.lastSyncAt ?? null,
      lastAttemptAt: attemptAt,
      lastError: failures.join('；') || '所有节假日源均失败',
      lastErrorSourceId,
      nextRetryAt,
      consecutiveFailures: failuresCount,
      version:
        activeRecords.length > 0
          ? describeVersion(
              activeRecords.map((record) => ({
                year: record.year,
                version: record.package.version,
              })),
            )
          : BUILTIN_HOLIDAY_PACKAGE.version,
      cachedYears:
        activeRecords.length > 0
          ? yearsFromRecords(activeRecords)
          : [BUILTIN_HOLIDAY_PACKAGE.year],
      notPublishedYears: uniqueYears(
        attempts
          .filter((attempt) => attempt.status === 'not-published')
          .map((attempt) => attempt.year),
      ),
      stale: !hasCurrentYearCache,
      perSource,
    });
  }
}

export function createHolidaySyncService(
  options: HolidaySyncServiceOptions,
): HolidaySyncService {
  return new HolidaySyncService(options);
}
