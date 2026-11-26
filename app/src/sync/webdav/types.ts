import type {
  Platform,
  RemoteState,
  WebDavClientOptions,
} from '../../../../packages/sync-webdav/src/index.ts';
import type { SyncConflictRecord } from '../../../../packages/shared/src/index.ts';
import type { SyncPlatform } from '../types.ts';
import type { WebDavSnapshotMark } from './cursors.ts';

export type WebDavEngineConfig = WebDavClientOptions & {
  platform: Platform;
  deviceName?: string;
  /** 深度 1 不可用时的退化探测列表。 */
  knownDeviceIds?: string[];
  /** 每累计多少个 op 自动写一次快照，默认 50；0 关闭。 */
  snapshotIntervalOps?: number;
};

export type WebDavSyncRunResult = {
  ok: boolean;
  online: boolean;
  pushed: number;
  pulled: number;
  outbox: number;
  conflicts: SyncConflictRecord[];
  warnings: string[];
  error: string | null;
  serverTime: string | null;
};

export type WebDavEngineStatus = {
  mode: 'webdav';
  configured: boolean;
  platform: Platform | SyncPlatform;
  baseUrl: string;
  root: string;
  spaceId: string;
  deviceId: string;
  deviceName: string;
  outbox: number;
  pendingConflicts: number;
  entities: number;
  lastSyncAt: string | null;
  lastError: string | null;
  warnings: string[];
  snapshot: WebDavSnapshotMark | null;
  remote: RemoteState | null;
};
