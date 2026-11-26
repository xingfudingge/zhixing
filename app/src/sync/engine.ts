import {
  HlcClock,
  applyOperation,
  sanitizeJsonObject,
  uuidv7,
  type JsonObject,
  type SyncConflictRecord,
  type SyncOp,
  type SyncStatusResponse,
} from '../../../packages/shared/src/index.ts';
import {
  SyncHttpClient,
  SyncHttpError,
  SyncNetworkError,
  type FetchLike,
} from './client.ts';
import { LocalStorageSyncStore } from './store.ts';
import type {
  EnqueueInput,
  LocalEntityState,
  OutboxEntry,
  PairDeviceInput,
  SyncDeviceProfile,
  SyncEngineStatus,
  SyncRunResult,
  SyncStore,
} from './types.ts';

export class SyncEngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SyncEngineError';
    this.code = code;
  }
}

export type SyncEngineOptions = {
  store?: SyncStore;
  fetchImpl?: FetchLike;
  now?: () => number;
  batchSize?: number;
  pullLimit?: number;
  maxPullPages?: number;
};

/**
 * 客户端同步引擎。
 *
 * - 本地写入先合并、立即可见，再进 outbox；
 * - 恢复网络后按 operation_id 幂等上传，服务端不会重复写入；
 * - 按 cursor 增量拉取；断网/401 会暂停并按指数退避重试；
 * - 服务端生成的冲突副本会作为普通 note/board op 拉回本地，列表可直接显示。
 */
export class SyncEngine {
  private readonly store: SyncStore;
  private readonly fetchImpl?: FetchLike;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly pullLimit: number;
  private readonly maxPullPages: number;

  private profile: SyncDeviceProfile | null = null;
  private clock: HlcClock | null = null;
  private client: SyncHttpClient | null = null;
  private initialized = false;
  private syncing = false;
  private authPaused = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onlineHandler: (() => void) | null = null;

  constructor(options: SyncEngineOptions = {}) {
    this.store = options.store ?? new LocalStorageSyncStore();
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? (() => Date.now());
    this.batchSize = Math.max(1, options.batchSize ?? 200);
    this.pullLimit = Math.max(1, options.pullLimit ?? 200);
    this.maxPullPages = Math.max(1, options.maxPullPages ?? 20);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.profile = await this.store.loadProfile();
    if (this.profile) {
      this.clock = new HlcClock(this.profile.deviceId);
      this.clock.restore(await this.store.loadHlc());
      this.client = new SyncHttpClient({
        baseUrl: this.profile.baseUrl,
        fetchImpl: this.fetchImpl,
      });
    }
    this.initialized = true;
  }

  getProfile(): SyncDeviceProfile | null {
    return this.profile ? { ...this.profile } : null;
  }

  async pair(input: PairDeviceInput): Promise<SyncDeviceProfile> {
    await this.init();
    const existing = await this.store.listOutbox();
    if (existing.length > 0) {
      throw new SyncEngineError(
        'PAIR_WITH_PENDING',
        '本地还有未上传的修改，请先同步或确认后再重新配对',
      );
    }
    const client = new SyncHttpClient({
      baseUrl: input.baseUrl,
      fetchImpl: this.fetchImpl,
    });
    const profile = await client.pair(input);
    this.profile = profile;
    this.client = client;
    this.clock = new HlcClock(profile.deviceId);
    await this.store.saveProfile(profile);
    await this.store.saveHlc(this.clock.peek());
    this.authPaused = false;
    this.initialized = true;
    return { ...profile };
  }

  async enqueue(input: EnqueueInput): Promise<SyncOp> {
    await this.init();
    const profile = this.requireProfile();
    const clock = this.requireClock();

    let payload: JsonObject;
    try {
      payload = sanitizeJsonObject(input.payload);
    } catch (error) {
      throw new SyncEngineError('INVALID_PAYLOAD', (error as Error).message);
    }
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.entityType)) {
      throw new SyncEngineError('INVALID_ENTITY_TYPE', 'entityType 非法');
    }
    if (!input.entityId || input.entityId.length > 200) {
      throw new SyncEngineError('INVALID_ENTITY_ID', 'entityId 非法');
    }

    const existing = await this.store.getEntity(input.entityType, input.entityId);
    const now = this.now();
    const hlc = clock.next(now);
    const op: SyncOp = {
      op_id: uuidv7(now),
      space_id: input.spaceId ?? profile.spaceId,
      device_id: profile.deviceId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      op_type: input.opType ?? (existing ? 'patch' : 'upsert'),
      hlc,
      base_vv: existing?.vv ?? {},
      payload,
      created_at: new Date(now).toISOString(),
    };

    const merged = applyOperation(existing, op);
    await this.store.putEntity(merged.state);
    for (const copy of merged.conflictCopies) {
      await this.store.putEntity(copy);
    }
    await this.store.putOutbox({
      op,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    });
    await this.store.saveHlc(hlc);
    return op;
  }

  async sync(options: { force?: boolean } = {}): Promise<SyncRunResult> {
    await this.init();
    const profile = this.requireProfile();
    if (this.syncing) {
      return {
        ok: false,
        online: true,
        authPaused: this.authPaused,
        pushed: 0,
        pulled: 0,
        outbox: (await this.store.listOutbox()).length,
        conflicts: [],
        error: '同步正在进行中',
        serverTime: null,
      };
    }
    if (this.authPaused && !options.force) {
      return {
        ok: false,
        online: true,
        authPaused: true,
        pushed: 0,
        pulled: 0,
        outbox: (await this.store.listOutbox()).length,
        conflicts: [],
        error: profile.lastError ?? '设备授权已失效，请重新配对或刷新令牌',
        serverTime: null,
      };
    }

    this.syncing = true;
    let pushed = 0;
    let pulled = 0;
    const conflicts: SyncConflictRecord[] = [];
    let serverTime: string | null = null;
    try {
      const pushResult = await this.pushPending(options.force ?? false, conflicts);
      pushed = pushResult.pushed;
      serverTime = pushResult.serverTime ?? serverTime;
      if (pushResult.stop !== null) {
        const offline = pushResult.stop === 'network';
        return this.finishRun({
          ok: false,
          online: !offline,
          pushed,
          pulled,
          conflicts,
          serverTime,
          error: this.requireProfile().lastError,
        });
      }

      const pullResult = await this.pullPending(conflicts);
      pulled = pullResult.pulled;
      serverTime = pullResult.serverTime ?? serverTime;
      if (pullResult.stop !== null) {
        return this.finishRun({
          ok: false,
          online: pullResult.stop !== 'network',
          pushed,
          pulled,
          conflicts,
          serverTime,
          error: this.requireProfile().lastError,
        });
      }

      const current = this.requireProfile();
      current.lastSyncAt = new Date(this.now()).toISOString();
      current.lastError = null;
      this.authPaused = false;
      await this.store.saveProfile(current);
      return this.finishRun({
        ok: true,
        online: true,
        pushed,
        pulled,
        conflicts,
        serverTime,
        error: null,
      });
    } catch (error) {
      if (error instanceof SyncNetworkError) {
        const current = this.requireProfile();
        current.lastError = error.message;
        await this.store.saveProfile(current);
        return this.finishRun({
          ok: false,
          online: false,
          pushed,
          pulled,
          conflicts,
          serverTime,
          error: error.message,
        });
      }
      if (error instanceof SyncHttpError) {
        const current = this.requireProfile();
        current.lastError = error.message;
        if (error.status === 401 || error.status === 403) this.authPaused = true;
        await this.store.saveProfile(current);
        return this.finishRun({
          ok: false,
          online: error.retryable,
          pushed,
          pulled,
          conflicts,
          serverTime,
          error: error.message,
        });
      }
      const message = (error as Error).message;
      const current = this.requireProfile();
      current.lastError = message;
      await this.store.saveProfile(current);
      return this.finishRun({
        ok: false,
        online: true,
        pushed,
        pulled,
        conflicts,
        serverTime,
        error: message,
      });
    } finally {
      this.syncing = false;
    }
  }

  private async finishRun(input: {
    ok: boolean;
    online: boolean;
    pushed: number;
    pulled: number;
    conflicts: SyncConflictRecord[];
    serverTime: string | null;
    error: string | null;
  }): Promise<SyncRunResult> {
    return {
      ...input,
      authPaused: this.authPaused,
      outbox: (await this.store.listOutbox()).length,
    };
  }

  private async pushPending(
    force: boolean,
    conflicts: SyncConflictRecord[],
  ): Promise<{
    pushed: number;
    stop: 'network' | 'auth' | 'error' | null;
    serverTime: string | null;
  }> {
    const client = this.requireClient();
    let pushed = 0;
    let serverTime: string | null = null;

    for (;;) {
      const activeProfile = this.requireProfile();
      const entries = (await this.store.listOutbox())
        .filter((entry) => force || entry.nextAttemptAt <= this.now())
        .sort((a, b) =>
          (a.op.created_at ?? '') < (b.op.created_at ?? '')
            ? -1
            : (a.op.created_at ?? '') > (b.op.created_at ?? '')
              ? 1
              : 0,
        );
      if (entries.length === 0) return { pushed, stop: null, serverTime };

      const batch = entries.slice(0, this.batchSize);
      let response;
      try {
        response = await client.push(activeProfile, batch.map((entry) => entry.op));
      } catch (error) {
        if (error instanceof SyncHttpError && error.status === 401) {
          const refreshed = await this.tryRefresh();
          if (!refreshed) {
            this.authPaused = true;
            return { pushed, stop: 'auth', serverTime };
          }
          continue;
        }
        if (error instanceof SyncHttpError && error.status === 403) {
          this.authPaused = true;
          activeProfile.lastError = error.message;
          await this.store.saveProfile(activeProfile);
          return { pushed, stop: 'auth', serverTime };
        }
        if (error instanceof SyncNetworkError) {
          await this.markFailed(batch, error.message);
          activeProfile.lastError = error.message;
          await this.store.saveProfile(activeProfile);
          return { pushed, stop: 'network', serverTime };
        }
        const message = (error as Error).message;
        await this.markFailed(batch, message, error instanceof SyncHttpError && !error.retryable);
        activeProfile.lastError = message;
        await this.store.saveProfile(activeProfile);
        return { pushed, stop: 'error', serverTime };
      }

      const accepted = [...response.applied, ...response.duplicates];
      if (accepted.length === 0) {
        const message = '服务端未确认任何 op，已保留 outbox';
        await this.markFailed(batch, message);
        activeProfile.lastError = message;
        await this.store.saveProfile(activeProfile);
        return { pushed, stop: 'error', serverTime };
      }
      for (const item of accepted) {
        await this.store.removeOutbox(item.opId);
      }
      for (const conflict of response.conflicts) {
        await this.store.putConflict(conflict);
        if (!conflicts.some((item) => item.id === conflict.id)) conflicts.push(conflict);
      }
      pushed += response.applied.length;
      serverTime = response.serverTime;
      activeProfile.lastError = null;
      await this.store.saveProfile(activeProfile);
    }
  }

  private async pullPending(
    conflicts: SyncConflictRecord[],
  ): Promise<{ pulled: number; stop: 'network' | 'auth' | 'error' | null; serverTime: string | null }> {
    let profile = this.requireProfile();
    const client = this.requireClient();
    let pulled = 0;
    let serverTime: string | null = null;
    let refreshed = false;

    for (let page = 0; page < this.maxPullPages; page += 1) {
      let response;
      try {
        response = await client.pull(profile, profile.lastPullCursor, this.pullLimit);
      } catch (error) {
        if (error instanceof SyncHttpError && error.status === 401 && !refreshed) {
          refreshed = true;
          const ok = await this.tryRefresh();
          if (!ok) {
            this.authPaused = true;
            return { pulled, stop: 'auth', serverTime };
          }
          profile = this.requireProfile();
          continue;
        }
        if (error instanceof SyncHttpError && error.status === 403) {
          this.authPaused = true;
          return { pulled, stop: 'auth', serverTime };
        }
        if (error instanceof SyncNetworkError) {
          profile.lastError = error.message;
          await this.store.saveProfile(profile);
          return { pulled, stop: 'network', serverTime };
        }
        profile.lastError = (error as Error).message;
        await this.store.saveProfile(profile);
        return { pulled, stop: 'error', serverTime };
      }

      for (const op of response.ops) {
        await this.applyRemoteOp(op);
        pulled += 1;
      }
      for (const conflict of response.conflicts) {
        await this.store.putConflict(conflict);
        if (!conflicts.some((item) => item.id === conflict.id)) conflicts.push(conflict);
      }
      serverTime = response.serverTime;
      profile.lastPullCursor = response.nextCursor;
      await this.store.saveProfile(profile);
      if (!response.hasMore) return { pulled, stop: null, serverTime };
    }
    return { pulled, stop: null, serverTime };
  }

  private async applyRemoteOp(op: SyncOp): Promise<void> {
    const existing = await this.store.getEntity(op.entity_type, op.entity_id);
    const result = applyOperation(existing, op);
    await this.store.putEntity(result.state);
    for (const copy of result.conflictCopies) {
      await this.store.putEntity(copy);
    }
    const clock = this.clock;
    if (clock) {
      clock.receive(op.hlc, this.now());
      await this.store.saveHlc(clock.peek());
    }
  }

  private async tryRefresh(): Promise<boolean> {
    const profile = this.requireProfile();
    const client = this.requireClient();
    try {
      const refreshed = await client.refresh(profile);
      this.profile = refreshed;
      await this.store.saveProfile(refreshed);
      this.authPaused = false;
      return true;
    } catch (error) {
      this.authPaused = true;
      const current = this.requireProfile();
      current.lastError =
        error instanceof SyncNetworkError
          ? error.message
          : `刷新设备令牌失败：${(error as Error).message}`;
      await this.store.saveProfile(current);
      return false;
    }
  }

  private async markFailed(
    entries: OutboxEntry[],
    message: string,
    nonRetryable = false,
  ): Promise<void> {
    const now = this.now();
    for (const entry of entries) {
      const attempts = entry.attempts + 1;
      const exponential = Math.min(300_000, 1000 * 2 ** Math.min(attempts - 1, 8));
      const jitter = 1 + Math.random() * 0.2;
      const delay = nonRetryable ? 5 * 60_000 : Math.round(exponential * jitter);
      await this.store.putOutbox({
        ...entry,
        attempts,
        nextAttemptAt: now + delay,
        lastError: message,
      });
    }
  }

  async status(options: { includeRemote?: boolean } = {}): Promise<SyncEngineStatus> {
    await this.init();
    const outbox = await this.store.listOutbox();
    const entities = await this.store.listEntities();
    const conflicts = await this.store.listConflicts();
    let remote: SyncStatusResponse | null = null;
    if (options.includeRemote && this.profile && !this.authPaused) {
      try {
        remote = await this.requireClient().status(this.profile);
      } catch {
        remote = null;
      }
    }
    return {
      paired: Boolean(this.profile),
      profile: this.profile ? { ...this.profile } : null,
      outbox: outbox.length,
      pendingConflicts: conflicts.length,
      entities: entities.filter((entity) => !entity.deleted).length,
      lastError: this.profile?.lastError ?? null,
      authPaused: this.authPaused,
      remoteStatus: remote,
    };
  }

  async listEntities(entityType?: string): Promise<LocalEntityState[]> {
    await this.init();
    return this.store.listEntities(entityType);
  }

  async listConflicts(): Promise<SyncConflictRecord[]> {
    await this.init();
    return this.store.listConflicts();
  }

  /** 后台同步：启动时立即同步一次，之后定时；网络恢复时强制重试。 */
  start(intervalMs = 60_000): void {
    if (this.timer !== null) return;
    void this.init().then(() => this.sync({ force: true }));
    this.timer = setInterval(() => {
      void this.sync({ force: true });
    }, Math.max(5_000, intervalMs));
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.onlineHandler = () => {
        void this.sync({ force: true });
      };
      window.addEventListener('online', this.onlineHandler);
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
  }

  private requireProfile(): SyncDeviceProfile {
    if (!this.profile) {
      throw new SyncEngineError('NOT_PAIRED', '尚未配对设备，请先在设置中输入服务器地址与配对码');
    }
    return this.profile;
  }

  private requireClock(): HlcClock {
    if (!this.clock) {
      throw new SyncEngineError('NOT_PAIRED', '同步时钟尚未初始化');
    }
    return this.clock;
  }

  private requireClient(): SyncHttpClient {
    if (!this.client) {
      throw new SyncEngineError('NOT_PAIRED', '同步客户端尚未初始化');
    }
    return this.client;
  }
}
