/**
 * WebDAV 同步核心类型。
 *
 * 这套实现的假设来自产品决策：目标服务器是 OpenList / Alist 一类弱能力
 * WebDAV，**不要求** ETag、If-Match、LOCK、MOVE，也不依赖深度 2 的 PROPFIND。
 * 远端状态完全由“不可变文件名 + 目录清单”推导。
 */

import type { EntityState, SyncOp } from '../../shared/src/types.ts';

export type Platform = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'web';

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type RetryOptions = {
  /** 总尝试次数（含第一次）。默认 4。 */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: RetryInfo) => void;
};

export type RetryInfo = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  method: string;
  path: string;
  status: number | null;
  code: string;
  message: string;
};

export type WebDavClientOptions = {
  /** WebDAV 根地址，例如 `https://dav.example.com/dav` 或 `http://127.0.0.1:5244/dav`。 */
  baseUrl: string;
  username?: string;
  /** 应用密码；只保存在内存/OS 安全存储，不写入 localStorage。 */
  password?: string;
  /** 知行数据目录，默认 `/zhixing`。 */
  root?: string;
  /** 同步空间，默认 `personal`。 */
  spaceId?: string;
  /** 本设备 ID；文件名的一部分，必须为 ASCII。 */
  deviceId: string;
  timeoutMs?: number;
  /** 超过该字节数走分片写入，默认 4 MiB。 */
  chunkSize?: number;
  retry?: RetryOptions;
  fetchImpl?: FetchLike;
  /** 允许 http 仅限 loopback（本地 OpenList/Alist 验收）。默认 true。 */
  allowInsecureLoopback?: boolean;
  now?: () => number;
  platform?: Platform;
};

export type DavEntry = {
  /** 相对 WebDAV 根的路径（以 `/` 开头，无尾斜杠）。 */
  path: string;
  /** 文件/目录名，已做 URL 解码。 */
  name: string;
  isDirectory: boolean;
  size: number | null;
  lastModified: string | null;
  /** 服务器返回的 HTTP 状态；200/207 都视为存在。 */
  status: number;
};

export type RemoteOpFile = {
  seq: number;
  opId: string;
  name: string;
  path: string;
};

export type DeviceOps = {
  deviceId: string;
  files: RemoteOpFile[];
  maxSeq: number;
};

export type SnapshotRef = {
  name: string;
  path: string;
  sha256Path: string;
  coveredSeq: number;
  deviceId: string;
};

export type SnapshotData = {
  version: 1;
  spaceId: string;
  deviceId: string;
  coveredSeq: number;
  createdAt: string;
  /** 每台设备已经包含进快照的最大 seq；读取方据此继续拉增量。 */
  cursors: Record<string, number>;
  entities: EntityState[];
};

export type SnapshotReadResult = {
  snapshot: SnapshotData;
  ref: SnapshotRef;
  /** 校验失败的更早候选，便于日志展示。 */
  skipped: { name: string; reason: string }[];
};

export type PutResult = {
  path: string;
  created: boolean;
  existed: boolean;
  size: number;
  sha256: string;
};

export type AppendOpResult = {
  opId: string;
  path: string;
  seq: number;
  created: boolean;
  skipped: boolean;
};

export type AppendOpsResult = {
  results: AppendOpResult[];
  maxSeq: number;
};

export type ReadOpsResult = {
  deviceId: string;
  ops: { op: SyncOp; seq: number; path: string }[];
  /** 已读取文件名的最大 seq；调用方应用完 op 后再推进游标。 */
  maxSeq: number;
  warnings: { file: string; message: string }[];
};

export type RemoteState = {
  spaceId: string;
  devices: DeviceOps[];
  snapshots: SnapshotRef[];
  maxSeqByDevice: Record<string, number>;
};

export type AssetRef = {
  sha256: string;
  size: number;
  /** 小文件为 `assets/{sha}`，大文件为 `assets/.parts/{sha}/complete.json`。 */
  path: string;
  chunked: boolean;
  created: boolean;
};

export type CapabilityName =
  | 'propfind'
  | 'depth1'
  | 'mkcol'
  | 'put'
  | 'get'
  | 'delete'
  | 'write'
  | 'chunked'
  | 'auth';

export type ConnectionCheck = {
  id: CapabilityName;
  label: string;
  status: 'ok' | 'failed' | 'skipped';
  detail?: string;
};

export type ConnectionTestResult = {
  ok: boolean;
  baseUrl: string;
  root: string;
  checks: ConnectionCheck[];
  /** 探测失败时的首个错误；成功为 null。 */
  error: {
    code: string;
    message: string;
    hint?: string;
  } | null;
  testedAt: string;
};

/** 大文件分片清单：`assets/.parts/{sha}/complete.json`。 */
export type ChunkManifest = {
  version: 1;
  sha256: string;
  size: number;
  chunks: number;
  chunkSize: number;
  createdAt: string;
};
