import type {
  EntityState,
  Hlc,
  JsonObject,
  SyncConflictRecord,
  SyncOp,
  SyncStatusResponse,
} from '../../../packages/shared/src/index.ts';

export type SyncPlatform = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'web';

export type SyncDeviceProfile = {
  baseUrl: string;
  spaceId: string;
  deviceId: string;
  deviceName: string;
  platform: SyncPlatform;
  deviceToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  features: Record<string, boolean>;
  lastPullCursor: string;
  lastSyncAt: string | null;
  lastError: string | null;
};

export type OutboxEntry = {
  op: SyncOp;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
};

export type LocalEntityState = EntityState;

/**
 * 客户端同步存储边界。
 * - 浏览器/原型调试使用 LocalStorageSyncStore；
 * - 桌面正式版应实现同一接口的 SQLite 适配器（op_outbox / sync_cursor / conflicts），
 *   业务与重试逻辑无需改动。
 */
export interface SyncStore {
  loadProfile(): Promise<SyncDeviceProfile | null>;
  saveProfile(profile: SyncDeviceProfile): Promise<void>;
  loadHlc(): Promise<Hlc | null>;
  saveHlc(hlc: Hlc): Promise<void>;

  listOutbox(): Promise<OutboxEntry[]>;
  putOutbox(entry: OutboxEntry): Promise<void>;
  removeOutbox(opId: string): Promise<void>;

  getEntity(entityType: string, entityId: string): Promise<LocalEntityState | null>;
  putEntity(state: LocalEntityState): Promise<void>;
  listEntities(entityType?: string): Promise<LocalEntityState[]>;

  listConflicts(): Promise<SyncConflictRecord[]>;
  putConflict(conflict: SyncConflictRecord): Promise<void>;
}

export type PairDeviceInput = {
  baseUrl: string;
  code: string;
  name: string;
  platform: SyncPlatform;
  spaceId?: string;
};

export type EnqueueInput = {
  entityType: string;
  entityId: string;
  payload: JsonObject;
  opType?: 'upsert' | 'patch' | 'delete' | 'yupdate';
  spaceId?: string;
};

export type SyncRunResult = {
  ok: boolean;
  online: boolean;
  authPaused: boolean;
  pushed: number;
  pulled: number;
  outbox: number;
  conflicts: SyncConflictRecord[];
  error: string | null;
  serverTime: string | null;
};

export type SyncEngineStatus = {
  paired: boolean;
  profile: SyncDeviceProfile | null;
  outbox: number;
  pendingConflicts: number;
  entities: number;
  lastError: string | null;
  authPaused: boolean;
  remoteStatus: SyncStatusResponse | null;
};

export type SyncTransport = {
  pair(input: PairDeviceInput): Promise<SyncDeviceProfile>;
  refresh(profile: SyncDeviceProfile): Promise<SyncDeviceProfile>;
  push(ops: SyncOp[]): Promise<{
    applied: { opId: string; cursor: string; duplicate: boolean }[];
    duplicates: { opId: string; cursor: string; duplicate: boolean }[];
    conflicts: SyncConflictRecord[];
    nextCursor: string;
    serverTime: string;
  }>;
  pull(cursor: string, limit: number): Promise<{
    ops: SyncOp[];
    nextCursor: string;
    hasMore: boolean;
    conflicts: SyncConflictRecord[];
    serverTime: string;
  }>;
  status(): Promise<SyncStatusResponse>;
};
