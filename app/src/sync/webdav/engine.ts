/**
 * WebDAV 同步引擎。
 *
 * 与后台 SyncEngine 共享 SyncStore / HLC / outbox 语义，但 transport 是
 * WebDAV：没有账号、没有设备令牌、没有服务端游标、没有实时推送。
 *
 * 关键点：
 * - push 只写本设备目录，文件名是不可变 `{seq}-{opId}.ndjson`；
 * - pull 先看快照（coveredSeq 最大且 sha256 校验通过），再按设备目录拉增量；
 * - 重试同一 op 不会重复：已存在的同 op_id 文件会被识别并跳过；
 * - 每次同步只允许一个在跑；失败按 outbox 指数退避，不阻塞本地写入。
 */

import {
  HlcClock,
  applyOperation,
  compareHlc,
  sanitizeJsonObject,
  stableHash,
  uuidv7,
  type MergeConflict,
  type SyncConflictRecord,
  type SyncOp,
} from '../../../../packages/shared/src/index.ts';
import {
  WebDavClient,
  WebDavError,
  type ConnectionTestResult,
  type SnapshotData,
} from '../../../../packages/sync-webdav/src/index.ts';
import { LocalStorageSyncStore } from '../store.ts';
import type {
  EnqueueInput,
  OutboxEntry,
  SyncStore,
} from '../types.ts';
import {
  LocalStorageWebDavCursorStore,
  type WebDavCursorState,
  type WebDavCursorStore,
} from './cursors.ts';
import type {
  WebDavEngineConfig,
  WebDavEngineStatus,
  WebDavSyncRunResult,
} from './types.ts';

export class WebDavSyncError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WebDavSyncError';
    this.code = code;
  }
}

export type WebDavEngineOptions = {
  store?: SyncStore;
  cursors?: WebDavCursorStore;
  client?: WebDavClient;
  now?: () => number;
  batchSize?: number;
};

export class WebDavSyncEngine {
  readonly config: WebDavEngineConfig;
  readonly client: WebDavClient;

  private readonly store: SyncStore;
  private readonly cursors: WebDavCursorStore;
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly snapshotIntervalOps: number;

  private clock: HlcClock | null = null;
  private cursorState: WebDavCursorState;
  private initialized = false;
  private syncing = false;
  private snapshotAttempted = false;
  private opsSinceSnapshot = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onlineHandler: (() => void) | null = null;

  constructor(config: WebDavEngineConfig, options: WebDavEngineOptions = {}) {
    if (config.platform === 'web') {
      throw new WebDavSyncError(
        'WEBDAV_UNSUPPORTED_ON_WEB',
        'Web 端只连接知行后台，不提供 WebDAV 同步',
      );
    }
    this.config = config;
    this.client = options.client ?? new WebDavClient(config);
    this.store = options.store ?? new LocalStorageSyncStore();
    this.cursors =
      options.cursors ??
      new LocalStorageWebDavCursorStore({
        baseUrl: this.client.baseUrl,
        root: this.client.root,
        spaceId: this.client.spaceId,
      });
    this.now = options.now ?? (() => Date.now());
    this.batchSize = Math.max(1, options.batchSize ?? 200);
    this.snapshotIntervalOps = Math.max(
      0,
      config.snapshotIntervalOps ?? 50,
    );
    this.cursorState = {
      version: 1,
      baseUrl: this.client.baseUrl,
      root: this.client.root,
      spaceId: this.client.spaceId,
      cursors: {},
      lastSyncAt: null,
      lastError: null,
      lastSnapshot: null,
      warnings: [],
    };
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.clock = new HlcClock(this.client.deviceId);
    this.clock.restore(await this.store.loadHlc());
    this.cursorState = await this.cursors.load();
    this.initialized = true;
  }

  getConfig(): Omit<WebDavEngineConfig, 'password'> {
    const safe = { ...this.config };
    delete (safe as { password?: string }).password;
    return safe;
  }

  async enqueue(input: EnqueueInput): Promise<SyncOp> {
    await this.init();
    const clock = this.requireClock();

    let payload;
    try {
      payload = sanitizeJsonObject(input.payload);
    } catch (error) {
      throw new WebDavSyncError('INVALID_PAYLOAD', (error as Error).message);
    }
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.entityType)) {
      throw new WebDavSyncError('INVALID_ENTITY_TYPE', 'entityType 非法');
    }
    if (!input.entityId || input.entityId.length > 200) {
      throw new WebDavSyncError('INVALID_ENTITY_ID', 'entityId 非法');
    }

    const spaceId = input.spaceId ?? this.client.spaceId;
    if (spaceId !== this.client.spaceId) {
      throw new WebDavSyncError(
        'INVALID_SPACE',
        `op 的 spaceId（${spaceId}）与当前同步空间（${this.client.spaceId}）不一致`,
      );
    }
    const existing = await this.store.getEntity(
      input.entityType,
      input.entityId,
    );
    const now = this.now();
    const hlc = clock.next(now);
    const op: SyncOp = {
      op_id: uuidv7(now),
      space_id: spaceId,
      device_id: this.client.deviceId,
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
    for (const conflict of merged.conflicts) {
      await this.store.putConflict(
        conflictRecord(op, 0, conflict, this.now()),
      );
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

  async sync(options: { force?: boolean } = {}): Promise<WebDavSyncRunResult> {
    await this.init();
    if (this.syncing) {
      return this.result({
        ok: false,
        online: true,
        pushed: 0,
        pulled: 0,
        conflicts: [],
        warnings: [],
        error: '同步正在进行中',
      });
    }

    this.syncing = true;
    let pushed = 0;
    let pulled = 0;
    const conflicts: SyncConflictRecord[] = [];
    const warnings: string[] = [];
    try {
      const push = await this.pushPending(options.force ?? false);
      pushed = push.pushed;
      warnings.push(...push.warnings);
      if (push.stop !== null) {
        return this.failRun(
          push.stop,
          pushed,
          pulled,
          conflicts,
          warnings,
        );
      }

      const pull = await this.pullPending(conflicts, warnings);
      pulled = pull.pulled;
      if (pull.stop !== null) {
        return this.failRun(
          pull.stop,
          pushed,
          pulled,
          conflicts,
          warnings,
        );
      }

      this.cursorState.lastSyncAt = new Date(this.now()).toISOString();
      this.cursorState.lastError = null;
      this.cursorState.warnings = warnings.slice(-50);
      await this.cursors.save(this.cursorState);

      this.opsSinceSnapshot += pushed + pulled;
      if (
        this.snapshotIntervalOps > 0 &&
        this.opsSinceSnapshot >= this.snapshotIntervalOps
      ) {
        try {
          await this.writeSnapshotNow();
          this.opsSinceSnapshot = 0;
        } catch (error) {
          warnings.push(
            `快照写入失败：${
              error instanceof Error ? error.message : '未知错误'
            }`,
          );
        }
      }

      return this.result({
        ok: true,
        online: true,
        pushed,
        pulled,
        conflicts,
        warnings,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '同步失败';
      this.cursorState.lastError = message;
      this.cursorState.warnings = warnings.slice(-50);
      await this.cursors.save(this.cursorState);
      const online = !isOfflineError(error);
      return this.result({
        ok: false,
        online,
        pushed,
        pulled,
        conflicts,
        warnings,
        error: message,
      });
    } finally {
      this.syncing = false;
    }
  }

  private async failRun(
    stop: 'network' | 'auth' | 'error',
    pushed: number,
    pulled: number,
    conflicts: SyncConflictRecord[],
    warnings: string[],
  ): Promise<WebDavSyncRunResult> {
    this.cursorState.warnings = warnings.slice(-50);
    await this.cursors.save(this.cursorState);
    return this.result({
      ok: false,
      online: stop !== 'network',
      pushed,
      pulled,
      conflicts,
      warnings,
      error: this.cursorState.lastError ?? '同步失败',
    });
  }

  private result(input: {
    ok: boolean;
    online: boolean;
    pushed: number;
    pulled: number;
    conflicts: SyncConflictRecord[];
    warnings: string[];
    error: string | null;
  }): Promise<WebDavSyncRunResult> {
    return (async () => ({
      ...input,
      outbox: (await this.store.listOutbox()).length,
      serverTime: new Date(this.now()).toISOString(),
    }))();
  }

  private async pushPending(
    force: boolean,
  ): Promise<{
    pushed: number;
    stop: 'network' | 'auth' | 'error' | null;
    warnings: string[];
  }> {
    let pushed = 0;
    const warnings: string[] = [];

    for (;;) {
      const entries = (await this.store.listOutbox())
        .filter((entry) => force || entry.nextAttemptAt <= this.now())
        .sort((a, b) => compareOps(a.op, b.op));
      if (entries.length === 0) {
        return { pushed, stop: null, warnings };
      }
      const batch = entries.slice(0, this.batchSize);
      try {
        const result = await this.client.appendOps(
          batch.map((entry) => entry.op),
        );
        const accepted = new Set(result.results.map((item) => item.opId));
        for (const entry of batch) {
          if (accepted.has(entry.op.op_id)) {
            await this.store.removeOutbox(entry.op.op_id);
          }
        }
        pushed += result.results.filter((item) => item.created).length;
        const skipped = result.results.filter((item) => item.skipped).length;
        if (skipped > 0) {
          warnings.push(
            `远端已有 ${skipped} 个相同 op，已跳过（断网重试不会重复写入）`,
          );
        }
        this.cursorState.lastError = null;
        await this.cursors.save(this.cursorState);
      } catch (error) {
        const message = error instanceof Error ? error.message : '上传失败';
        await this.markFailed(batch, message);
        this.cursorState.lastError = message;
        await this.cursors.save(this.cursorState);
        return {
          pushed,
          stop: isOfflineError(error) ? 'network' : 'error',
          warnings,
        };
      }
    }
  }

  private async pullPending(
    conflicts: SyncConflictRecord[],
    warnings: string[],
  ): Promise<{ pulled: number; stop: 'network' | 'auth' | 'error' | null }> {
    let pulled = 0;

    if (!this.snapshotAttempted) {
      const local = await this.store.listEntities();
      if (local.length === 0) {
        // 网络失败时不要标记已尝试，否则恢复网络后永远不会再拉快照。
        const snapshot = await this.client.readBestSnapshot();
        this.snapshotAttempted = true;
        if (snapshot) {
          for (const entity of snapshot.snapshot.entities) {
            await this.store.putEntity(entity);
          }
          for (const [device, seq] of Object.entries(
            snapshot.snapshot.cursors,
          )) {
            this.cursorState.cursors[device] = Math.max(
              this.cursorState.cursors[device] ?? 0,
              seq,
            );
          }
          this.cursorState.lastSnapshot = {
            name: snapshot.ref.name,
            coveredSeq: snapshot.ref.coveredSeq,
          };
          await this.cursors.save(this.cursorState);
          pulled += snapshot.snapshot.entities.length;
        }
      } else {
        this.snapshotAttempted = true;
      }
    }

    const known = new Set<string>([
      this.client.deviceId,
      ...(this.config.knownDeviceIds ?? []),
      ...Object.keys(this.cursorState.cursors),
    ]);
    const devices = await this.client.listDeviceDirectories([...known]);
    if (!devices.includes(this.client.deviceId)) devices.push(this.client.deviceId);

    for (const deviceId of devices) {
      const cursor = this.cursorState.cursors[deviceId] ?? 0;
      const remote = await this.client.readOps(deviceId, cursor);
      for (const warning of remote.warnings) {
        warnings.push(`${deviceId}/${warning.file}: ${warning.message}`);
      }
      for (const item of remote.ops) {
        const applied = await this.applyRemoteOp(item.op, item.seq, conflicts);
        if (applied) pulled += 1;
      }
      if (remote.maxSeq > cursor) {
        this.cursorState.cursors[deviceId] = remote.maxSeq;
        await this.cursors.save(this.cursorState);
      }
    }

    return { pulled, stop: null };
  }

  private async applyRemoteOp(
    op: SyncOp,
    seq: number,
    conflicts: SyncConflictRecord[],
  ): Promise<boolean> {
    const existing = await this.store.getEntity(op.entity_type, op.entity_id);
    const merged = applyOperation(existing, op, { now: new Date(this.now()) });
    await this.store.putEntity(merged.state);
    for (const copy of merged.conflictCopies) {
      await this.store.putEntity(copy);
    }
    for (const conflict of merged.conflicts) {
      const record = conflictRecord(op, seq, conflict, this.now());
      await this.store.putConflict(record);
      if (!conflicts.some((item) => item.id === record.id)) {
        conflicts.push(record);
      }
    }
    const clock = this.clock;
    if (clock) {
      clock.receive(op.hlc, this.now());
      await this.store.saveHlc(clock.peek());
    }
    return merged.applied;
  }

  private async markFailed(
    entries: OutboxEntry[],
    message: string,
  ): Promise<void> {
    const now = this.now();
    for (const entry of entries) {
      const attempts = entry.attempts + 1;
      const exponential = Math.min(
        300_000,
        1_000 * 2 ** Math.min(attempts - 1, 8),
      );
      const jitter = 1 + Math.random() * 0.2;
      await this.store.putOutbox({
        ...entry,
        attempts,
        nextAttemptAt: now + Math.round(exponential * jitter),
        lastError: message,
      });
    }
  }

  async writeSnapshotNow(): Promise<{
    name: string;
    coveredSeq: number;
  }> {
    await this.init();
    const entities = await this.store.listEntities();
    const coveredSeq = Math.max(
      0,
      ...Object.values(this.cursorState.cursors),
    );
    const written = await this.client.writeSnapshot({
      entities,
      cursors: this.cursorState.cursors,
      coveredSeq,
    });
    this.cursorState.lastSnapshot = {
      name: written.ref.name,
      coveredSeq: written.ref.coveredSeq,
    };
    await this.cursors.save(this.cursorState);
    return {
      name: written.ref.name,
      coveredSeq: written.ref.coveredSeq,
    };
  }

  /** 读取最大 coveredSeq 且校验通过的快照并返回（不自动应用）。 */
  async inspectSnapshot(): Promise<SnapshotData | null> {
    const result = await this.client.readBestSnapshot();
    return result?.snapshot ?? null;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    await this.init();
    return this.client.testConnection();
  }

  async pendingCount(): Promise<number> {
    await this.init();
    return (await this.store.listOutbox()).length;
  }

  async status(options: { includeRemote?: boolean } = {}): Promise<WebDavEngineStatus> {
    await this.init();
    const outbox = await this.store.listOutbox();
    const conflicts = await this.store.listConflicts();
    const entities = await this.store.listEntities();
    let remote = null;
    if (options.includeRemote) {
      try {
        remote = await this.client.readRemoteState([
          this.client.deviceId,
          ...(this.config.knownDeviceIds ?? []),
        ]);
      } catch {
        remote = null;
      }
    }
    return {
      mode: 'webdav',
      configured: true,
      platform: this.config.platform,
      baseUrl: this.client.baseUrl,
      root: this.client.root,
      spaceId: this.client.spaceId,
      deviceId: this.client.deviceId,
      deviceName: this.config.deviceName ?? '本机',
      outbox: outbox.length,
      pendingConflicts: conflicts.length,
      entities: entities.filter((entity) => !entity.deleted).length,
      lastSyncAt: this.cursorState.lastSyncAt,
      lastError: this.cursorState.lastError,
      warnings: [...this.cursorState.warnings],
      snapshot: this.cursorState.lastSnapshot,
      remote,
    };
  }

  /** 定时同步：60s + 网络恢复；与后台引擎一致，失败不停止本地写入。 */
  start(intervalMs = 60_000): void {
    if (this.timer !== null) return;
    void this.init().then(() => this.sync({ force: true }));
    this.timer = setInterval(() => {
      void this.sync({ force: true });
    }, Math.max(5_000, intervalMs));
    if (
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
    ) {
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

  private requireClock(): HlcClock {
    if (!this.clock) {
      throw new WebDavSyncError('NOT_INITIALIZED', '同步时钟尚未初始化');
    }
    return this.clock;
  }
}

function compareOps(a: SyncOp, b: SyncOp): number {
  const created = (a.created_at ?? '').localeCompare(b.created_at ?? '');
  if (created !== 0) return created;
  return compareHlc(a.hlc, b.hlc);
}

function isOfflineError(error: unknown): boolean {
  return (
    error instanceof WebDavError &&
    (error.code === 'NETWORK' || error.code === 'TIMEOUT')
  );
}

function conflictRecord(
  op: SyncOp,
  seq: number,
  conflict: MergeConflict,
  now: number,
): SyncConflictRecord {
  const id = stableHash(
    `${op.op_id}\u0000${conflict.kind}\u0000${conflict.entityType}\u0000${conflict.entityId}\u0000${conflict.field}\u0000${seq}`,
  );
  return {
    id,
    spaceId: op.space_id,
    entityType: conflict.entityType,
    entityId: conflict.entityId,
    field: conflict.field,
    kind: conflict.kind,
    incomingOpId: op.op_id,
    incomingDeviceId: op.device_id,
    winner: conflict.winner,
    localValue: conflict.localValue,
    incomingValue: conflict.incomingValue,
    copyEntityType: conflict.copyEntityType,
    copyEntityId: conflict.copyEntityId,
    cursor: `${op.device_id}:${seq}`,
    createdAt: new Date(now).toISOString(),
  };
}
