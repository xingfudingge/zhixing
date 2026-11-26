/**
 * 知行同步协议共享类型。
 *
 * 服务端（Fastify）与客户端（app/src/sync）使用同一份定义，避免
 * “服务端能跑、客户端类型对不上”的漂移。协议只认设备，不认账号。
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** Hybrid Logical Clock：物理毫秒 + 逻辑计数 + 设备 ID（同毫秒同计数时的确定性排序）。 */
export type Hlc = {
  ms: number;
  c: number;
  d: string;
};

/** 版本向量：设备 ID → 已见逻辑序号。仅用于因果判断，不参与字段值比较。 */
export type VersionVector = Record<string, number>;

export type FieldClocks = Record<string, Hlc>;
export type FieldVvs = Record<string, VersionVector>;

export const OP_TYPES = ['upsert', 'patch', 'delete', 'yupdate'] as const;
export type OpType = (typeof OP_TYPES)[number];

export const ENTITY_TYPES = [
  'task',
  'list',
  'note',
  'note_block',
  'note_todo',
  'subtask',
  'event',
  'countdown',
  'habit',
  'habit_log',
  'focus_session',
  'review_snapshot',
  'board',
  'board_node',
  'board_edge',
  'attachment',
  'setting',
  'relation',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number] | string;

/** Op 信封：所有同步模式（backend / webdav）共用。 */
export type SyncOp = {
  op_id: string;
  space_id: string;
  device_id: string;
  entity_type: EntityType;
  entity_id: string;
  op_type: OpType;
  hlc: Hlc;
  base_vv: VersionVector;
  payload: JsonObject;
  created_at?: string;
};

export type SyncOpWithCursor = SyncOp & {
  cursor: string;
  origin: 'client' | 'server';
};

/** 服务端/客户端合并后的实体投影。业务表可由此派生，但不反向依赖。 */
export type EntityState = {
  spaceId: string;
  entityType: EntityType;
  entityId: string;
  fields: JsonObject;
  fieldClocks: FieldClocks;
  fieldVvs: FieldVvs;
  vv: VersionVector;
  deleted: boolean;
  hlc: Hlc | null;
  version: number;
};

export type ConflictKind = 'body_concurrent' | 'field_lww' | 'delete_lww';

export type MergeConflict = {
  kind: ConflictKind;
  entityType: EntityType;
  entityId: string;
  field: string;
  winner: 'incoming' | 'existing';
  incomingHlc: Hlc;
  existingHlc?: Hlc;
  localValue?: JsonValue;
  incomingValue?: JsonValue;
  /** 正文/画板并发时生成的冲突副本（独立实体，客户端必须显示）。 */
  copyEntityType?: EntityType;
  copyEntityId?: string;
};

export type ApplyResult = {
  state: EntityState;
  changedFields: string[];
  conflicts: MergeConflict[];
  /** 冲突副本实体；服务端会把它写成 server op，客户端拉取后可见。 */
  conflictCopies: EntityState[];
  /** 本次 op 是否改变了字段或墓碑（重复 op 为 false）。 */
  applied: boolean;
};

/** 服务端持久化的冲突审计行。 */
export type SyncConflictRecord = {
  id: string;
  spaceId: string;
  entityType: EntityType;
  entityId: string;
  field: string;
  kind: ConflictKind;
  incomingOpId: string;
  incomingDeviceId: string | null;
  winner: 'incoming' | 'existing';
  localValue?: JsonValue;
  incomingValue?: JsonValue;
  copyEntityType?: EntityType;
  copyEntityId?: string;
  cursor: string;
  createdAt: string;
};

export type AppliedOp = {
  opId: string;
  cursor: string;
  duplicate: boolean;
};

export type PushResponse = {
  ok: true;
  applied: AppliedOp[];
  duplicates: AppliedOp[];
  conflicts: SyncConflictRecord[];
  warnings: { opId: string; warning: string }[];
  nextCursor: string;
  latestCursor: string;
  serverTime: string;
};

export type PullResponse = {
  ok: true;
  ops: SyncOpWithCursor[];
  nextCursor: string;
  latestCursor: string;
  hasMore: boolean;
  conflicts: SyncConflictRecord[];
  serverTime: string;
};

export type SyncStatusResponse = {
  ok: true;
  device: {
    id: string;
    name: string;
    platform: string;
    pairedAt: string;
    lastSeenAt: string | null;
    accessExpiresAt: string;
  };
  spaceId: string;
  cursor: string;
  latestCursor: string;
  appliedOps: number;
  lastPullAt: string | null;
  lastPushAt: string | null;
  entityCounts: Record<string, number>;
  unresolvedConflicts: number;
  conflicts: SyncConflictRecord[];
  storage: {
    configured: boolean;
    bucket: string;
    driver: 's3' | 'minio';
    lastError: string | null;
  };
  serverTime: string;
};

export type EntityResponse = {
  ok: true;
  entity: EntityState;
  conflicts: SyncConflictRecord[];
};

export type PairDeviceResponse = {
  ok: true;
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  features: Record<string, boolean>;
  serverTime: string;
  apiVersion: string;
};

export type PairCodeResponse = {
  ok: true;
  code: string;
  label: string;
  expiresAt: string;
};

export type RefreshDeviceResponse = {
  ok: true;
  deviceToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  serverTime: string;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export const API_VERSION = '1';
export const MAX_PUSH_OPS = 200;
export const MAX_PULL_LIMIT = 500;
export const DEFAULT_PULL_LIMIT = 200;
export const DEFAULT_SPACE_ID = 'personal';
export const PROTECTED_FIELDS = ['body', 'snapshot', 'snapshot_json', 'snapshotJson'] as const;
export const CLOCK_SKEW_WARNING_MS = 5 * 60 * 1000;
