/**
 * ICS 只读订阅同步。
 *
 * - 传输：桌面走 Rust 受限 HTTP 代理（见 `http.ts`），浏览器预览同源走条件
 *   请求、跨域用 200 原文对比；两者都不写回远端；
 * - 条件请求：ETag / Last-Modified；304 视为成功但不重复物化；
 * - 断网/解析失败保留最近一次成功缓存，并记录 lastAttemptAt/lastError；
 * - 只管理 `source === ics:<subscriptionId>` 的事件，绝不写回远端；
 * - 取消订阅只删除订阅与缓存，不删除已经导入的本地事件。
 */

import {
  toEventUpdate,
  type EventRepository,
} from '../../events/eventRepository';
import type { Event } from '../../../data/db/types';
import {
  expandOccurrences,
  occurrenceToDraft,
  parseIcs,
} from './parser';
import {
  createIcsHttpClient,
  type FetchLike,
  type IcsHttpClient,
} from './http';
import type { IcsStore } from './store';
import {
  IcsFetchError,
  IcsParseError,
  IcsSubscriptionError,
  redactIcsUrl,
  sourceForSubscription,
  type IcsCache,
  type IcsEventDraft,
  type IcsOccurrence,
  type IcsSubscription,
} from './types';

export type { FetchLike } from './http';

export type IcsSyncServiceOptions = {
  store: IcsStore;
  events: EventRepository;
  /** 测试/高级调用方可直接注入 fetch；默认按运行时选择桌面代理或浏览器 fetch。 */
  fetchImpl?: FetchLike;
  /** 显式注入传输层（优先于 fetchImpl）。 */
  httpClient?: IcsHttpClient;
  now?: () => Date;
  newId?: () => string;
  timeoutMs?: number;
  pastDays?: number;
  futureDays?: number;
  maxInstances?: number;
};

export type IcsSyncResult = {
  subscription: IcsSubscription;
  notModified: boolean;
  /** 未变化来源：HTTP 304，或浏览器跨域下 200 原文一致。 */
  notModifiedReason: 'http-304' | 'content-equal' | null;
  eventCount: number;
  /** 解析期间跳过的条目（缺 UID/DTSTART/坏日期等），成功同步也会回显。 */
  warnings: string[];
};

export type IcsSyncFailure = {
  subscriptionId: string;
  name: string;
  message: string;
};

export type IcsSyncAllReport = {
  results: IcsSyncResult[];
  failures: IcsSyncFailure[];
};

function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ics_${crypto.randomUUID()}`;
  }
  return `ics_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function validateIcsUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new IcsSubscriptionError('请填写 ICS 订阅地址');
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new IcsSubscriptionError('ICS 地址不是合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IcsSubscriptionError('ICS 订阅只支持 http/https，且为只读');
  }
  if (url.username || url.password) {
    throw new IcsSubscriptionError(
      'ICS 地址不能内嵌账号密码；请使用仅含订阅 token 的 URL',
    );
  }
  url.hash = '';
  return url.toString();
}

/**
 * 订阅去重键：忽略 hash、默认端口、host 大小写与尾部斜杠。
 *
 * 请求仍使用用户原始 URL（规范化只用于判重）；不改变 query，避免把
 * 不同的订阅 token 误判为同一个。
 */
function subscriptionKey(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return value;
  }
}

function nameFromUrl(url: string): string {
  try {
    return new URL(url).hostname || 'ICS 订阅';
  } catch {
    return 'ICS 订阅';
  }
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return '未知错误';
}

/**
 * 同一 `uid#实例开始时间` 只保留一条，避免上游重复 VEVENT 让本地镜像翻倍。
 * 多条候选时保留 SEQUENCE 更高的那条（RFC 5545 修订语义）。
 */
function dedupeOccurrences(
  occurrences: ReadonlyArray<IcsOccurrence>,
): IcsOccurrence[] {
  const byKey = new Map<string, IcsOccurrence>();
  for (const occurrence of occurrences) {
    const current = byKey.get(occurrence.instanceKey);
    if (!current || occurrence.event.sequence >= current.event.sequence) {
      byKey.set(occurrence.instanceKey, occurrence);
    }
  }
  return Array.from(byKey.values());
}

export class IcsSyncService {
  private readonly store: IcsStore;
  private readonly events: EventRepository;
  private readonly http: IcsHttpClient;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly timeoutMs: number;
  private readonly pastDays: number;
  private readonly futureDays: number;
  private readonly maxInstances: number;

  constructor(options: IcsSyncServiceOptions) {
    this.store = options.store;
    this.events = options.events;
    this.http =
      options.httpClient ??
      createIcsHttpClient(
        options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
      );
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultNewId;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.pastDays = options.pastDays ?? 90;
    this.futureDays = options.futureDays ?? 365;
    this.maxInstances = options.maxInstances ?? 500;
  }

  /** 供设置页说明当前是桌面代理还是浏览器直连。 */
  get transportKind(): IcsHttpClient['kind'] {
    return this.http.kind;
  }

  async listSubscriptions(): Promise<IcsSubscription[]> {
    return this.store.listSubscriptions();
  }

  async getSubscription(id: string): Promise<IcsSubscription | null> {
    return this.store.getSubscription(id);
  }

  async addSubscription(input: {
    name?: string;
    url: string;
    color?: string;
  }): Promise<IcsSubscription> {
    const url = validateIcsUrl(input.url);
    const key = subscriptionKey(url);
    const existing = await this.store.listSubscriptions();
    if (existing.some((item) => subscriptionKey(item.url) === key)) {
      throw new IcsSubscriptionError('这个 ICS 地址已经订阅过了');
    }
    const timestamp = this.now().toISOString();
    const subscription: IcsSubscription = {
      id: this.newId(),
      name: input.name?.trim() || nameFromUrl(url),
      url,
      color: input.color?.trim() || '',
      enabled: true,
      readOnly: true,
      etag: null,
      lastModified: null,
      lastSyncAt: null,
      lastAttemptAt: null,
      lastError: null,
      lastWarning: null,
      eventCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.putSubscription(subscription);
    return subscription;
  }

  async removeSubscription(id: string): Promise<void> {
    const subscription = await this.store.getSubscription(id);
    if (!subscription) {
      throw new IcsSubscriptionError('订阅不存在');
    }
    // 只删订阅与缓存；已导入的本地事件保留，避免“取消连接=删数据”。
    await this.store.deleteSubscription(id);
    await this.store.deleteCache(id);
  }

  async getCached(id: string): Promise<IcsCache | null> {
    return this.store.getCache(id);
  }

  async sync(id: string): Promise<IcsSyncResult> {
    const subscription = await this.store.getSubscription(id);
    if (!subscription) throw new IcsSubscriptionError('订阅不存在');
    if (!subscription.enabled) {
      throw new IcsSubscriptionError('订阅已停用');
    }
    const cache = await this.store.getCache(id);
    const attemptAt = this.now().toISOString();
    const controller = new AbortController();
    const timeoutError = new IcsFetchError(
      `ICS 拉取超时（超过 ${this.timeoutMs} ms）：${redactIcsUrl(subscription.url)}`,
    );
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    // 仅靠 AbortController 不够：测试替身或不支持 signal 的 transport 可能
    // 永远不返回。这里同时用 Promise.race 让超时一定 reject，避免“同步中”
    // 永久悬挂，也避免把失败误显示成已同步。
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(timeoutError);
      }, this.timeoutMs);
    });
    const headers: Record<string, string> = {
      accept: 'text/calendar, text/plain;q=0.8',
    };
    // 桌面代理可以安全携带条件头；浏览器跨域会触发预检（部分源拒绝）
    // 且 304 可能缺 CORS 头，因此只在同源时发送。
    if (this.http.supportsConditionalHeaders(subscription.url)) {
      if (cache?.etag) headers['if-none-match'] = cache.etag;
      if (cache?.lastModified) headers['if-modified-since'] = cache.lastModified;
    }

    let response: Response;
    try {
      response = await Promise.race([
        this.http.fetch(subscription.url, {
          method: 'GET',
          headers,
          signal: controller.signal,
          timeoutMs: this.timeoutMs,
        }),
        timeoutPromise,
      ]);
    } catch (reason) {
      clearTimer();
      const message = timedOut
        ? timeoutError.message
        : `无法获取 ICS（${redactIcsUrl(subscription.url)}）：${errorMessage(reason)}`;
      await this.recordFailure(subscription, attemptAt, message);
      throw timedOut
        ? timeoutError
        : new IcsFetchError(message);
    }

    if (response.status === 304) {
      clearTimer();
      // 没有缓存却收到 304 不能算同步成功，否则会伪造 lastSyncAt。
      if (!cache) {
        const message = `服务端返回 304，但本地没有可复用的缓存：${redactIcsUrl(subscription.url)}`;
        await this.recordFailure(subscription, attemptAt, message);
        throw new IcsFetchError(message, 304);
      }
      const etag = response.headers.get('etag') ?? cache.etag;
      const lastModified =
        response.headers.get('last-modified') ?? cache.lastModified;
      await this.store.putCache({
        ...cache,
        etag,
        lastModified,
        fetchedAt: attemptAt,
      });
      const updated: IcsSubscription = {
        ...subscription,
        etag,
        lastModified,
        lastSyncAt: attemptAt,
        lastAttemptAt: attemptAt,
        lastError: null,
        eventCount: subscription.eventCount,
        updatedAt: attemptAt,
      };
      await this.store.putSubscription(updated);
      return {
        subscription: updated,
        notModified: true,
        notModifiedReason: 'http-304',
        eventCount: updated.eventCount,
        warnings: cache.warnings ?? [],
      };
    }

    if (!response.ok) {
      clearTimer();
      const statusText = response.statusText ? ` ${response.statusText}` : '';
      const message = `HTTP ${response.status}${statusText}`;
      await this.recordFailure(subscription, attemptAt, message);
      throw new IcsFetchError(
        `ICS 拉取失败（${message}）`,
        response.status,
      );
    }

    let raw: string;
    try {
      raw = await Promise.race([response.text(), timeoutPromise]);
    } catch (reason) {
      clearTimer();
      const message = timedOut
        ? timeoutError.message
        : `读取 ICS 内容失败（${redactIcsUrl(subscription.url)}）：${errorMessage(reason)}`;
      await this.recordFailure(subscription, attemptAt, message);
      throw timedOut ? timeoutError : new IcsFetchError(message);
    }
    clearTimer();
    let parsed;
    try {
      parsed = parseIcs(raw);
    } catch (reason) {
      await this.recordFailure(subscription, attemptAt, reason);
      throw reason instanceof IcsParseError
        ? reason
        : new IcsParseError(`ICS 解析失败：${errorMessage(reason)}`);
    }

    if (parsed.events.length === 0 && parsed.warnings.length > 0) {
      await this.recordFailure(
        subscription,
        attemptAt,
        `ICS 中没有可导入的事件：${parsed.warnings.join('；')}`,
      );
      throw new IcsParseError(
        `ICS 中没有可导入的事件：${parsed.warnings.join('；')}`,
      );
    }

    const now = this.now();
    const from = new Date(now.getTime() - this.pastDays * 24 * 60 * 60 * 1000);
    const to = new Date(now.getTime() + this.futureDays * 24 * 60 * 60 * 1000);
    const windowFrom = from.toISOString().slice(0, 10);
    const windowTo = to.toISOString().slice(0, 10);
    const occurrences = dedupeOccurrences(
      expandOccurrences(parsed.events, {
        from,
        to,
        maxInstances: this.maxInstances,
      }),
    );
    const drafts = occurrences.map((occurrence) =>
      occurrenceToDraft(occurrence, subscription.id, subscription.color),
    );

    try {
      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');
      // 浏览器跨域无法可靠拿到 304：用原文 + 展开窗口对比达到同样效果。
      // 两者都没变且本地镜像数量一致时不重复物化，避免无意义 updatedAt 变化。
      const sameContent =
        cache !== null &&
        cache.raw === raw &&
        cache.windowFrom === windowFrom &&
        cache.windowTo === windowTo;
      const mirrorCount = sameContent
        ? (await this.mirrorEvents(subscription.id)).length
        : -1;
      const shouldMaterialize =
        !sameContent || mirrorCount !== subscription.eventCount;
      if (shouldMaterialize) {
        await this.materialize(subscription.id, drafts);
      }

      const nextCache: IcsCache = {
        subscriptionId: subscription.id,
        etag,
        lastModified,
        fetchedAt: attemptAt,
        raw,
        events: parsed.events,
        windowFrom,
        windowTo,
        warnings: parsed.warnings,
      };
      await this.store.putCache(nextCache);
      const eventCount = shouldMaterialize
        ? drafts.length
        : subscription.eventCount;
      const updated: IcsSubscription = {
        ...subscription,
        etag,
        lastModified,
        lastSyncAt: attemptAt,
        lastAttemptAt: attemptAt,
        lastError: null,
        lastWarning:
          parsed.warnings.length > 0 ? parsed.warnings.join('；') : null,
        eventCount,
        updatedAt: attemptAt,
      };
      await this.store.putSubscription(updated);
      return {
        subscription: updated,
        notModified: sameContent,
        notModifiedReason: sameContent ? 'content-equal' : null,
        eventCount,
        warnings: parsed.warnings,
      };
    } catch (reason) {
      // 写入本地镜像/缓存失败同样是导入失败：记录 lastAttemptAt/lastError，
      // 不把 lastSyncAt 改成当前时间，避免出现“看起来同步成功”。
      await this.recordFailure(subscription, attemptAt, reason);
      if (
        reason instanceof IcsSubscriptionError ||
        reason instanceof IcsParseError ||
        reason instanceof IcsFetchError
      ) {
        throw reason;
      }
      throw new IcsSubscriptionError(
        `导入 ICS 失败：${errorMessage(reason)}`,
      );
    }
  }

  async syncAll(): Promise<IcsSyncAllReport> {
    const subscriptions = await this.store.listSubscriptions();
    const report: IcsSyncAllReport = { results: [], failures: [] };
    for (const subscription of subscriptions) {
      if (!subscription.enabled) continue;
      try {
        report.results.push(await this.sync(subscription.id));
      } catch (reason) {
        // 单个失败不阻断其他订阅；具体原因写入 report 与订阅 lastError。
        report.failures.push({
          subscriptionId: subscription.id,
          name: subscription.name,
          message: errorMessage(reason),
        });
      }
    }
    return report;
  }

  private async mirrorEvents(subscriptionId: string): Promise<Event[]> {
    const source = sourceForSubscription(subscriptionId);
    return (await this.events.list()).filter(
      (event) => event.source === source && !event.deletedAt,
    );
  }

  private async materialize(
    subscriptionId: string,
    drafts: IcsEventDraft[],
  ): Promise<void> {
    const source = sourceForSubscription(subscriptionId);
    const existing = (await this.events.list()).filter(
      (event) => event.source === source,
    );
    const byUid = new Map<string, Event>();
    const duplicates: Event[] = [];
    for (const event of existing) {
      if (!event.externalUid) continue;
      // 旧版本如果曾写入重复 externalUid，这里保留第一条并清掉其余，
      // 保证后续同步按 uid#实例 幂等。
      if (byUid.has(event.externalUid)) {
        duplicates.push(event);
      } else {
        byUid.set(event.externalUid, event);
      }
    }
    for (const duplicate of duplicates) {
      await this.events.remove(duplicate.id);
    }
    const removedIds = new Set(duplicates.map((event) => event.id));
    const seen = new Set<string>();

    for (const draft of drafts) {
      seen.add(draft.externalUid);
      const current = byUid.get(draft.externalUid);
      if (current) {
        if (current.deletedAt) continue;
        const patch = toEventUpdate(current, {
          title: draft.title,
          eventType: draft.eventType,
          allDay: draft.allDay,
          startDate: draft.startDate,
          startAt: draft.startAt,
          endAt: draft.endAt,
          tz: draft.tz,
          source: draft.source,
          externalUid: draft.externalUid,
          repeatRule: '单次',
          color: draft.color,
        });
        await this.events.update(current.id, patch);
      } else {
        await this.events.create(draft);
      }
    }

    for (const event of existing) {
      if (removedIds.has(event.id)) continue;
      if (!event.externalUid || !seen.has(event.externalUid)) {
        await this.events.remove(event.id);
      }
    }
  }

  private async recordFailure(
    subscription: IcsSubscription,
    attemptAt: string,
    reason: unknown,
  ): Promise<void> {
    await this.store.putSubscription({
      ...subscription,
      lastAttemptAt: attemptAt,
      lastError: errorMessage(reason),
      updatedAt: attemptAt,
    });
  }
}

export function createIcsSyncService(
  options: IcsSyncServiceOptions,
): IcsSyncService {
  return new IcsSyncService(options);
}
