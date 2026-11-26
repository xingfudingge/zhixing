/**
 * 设置页同步面板的视图模型。
 *
 * 这里只放 UI 需要的安全字段：不包含设备令牌、刷新令牌、WebDAV 密码或
 * 配对码。真正落盘的凭证仍由 `sync/store.ts` 管理。
 */

import type { Platform } from '../../../../packages/sync-webdav/src/index.ts';

export type SyncMode = 'local' | 'webdav' | 'backend';

export type SyncIssue = {
  id: string;
  entityType: string | null;
  message: string;
  attempts: number;
  /** 0 表示可以立即重试。 */
  nextAttemptAt: number | null;
};

export type BackendProfileView = {
  baseUrl: string;
  deviceId: string;
  deviceName: string;
  lastSyncAt: string | null;
  lastError: string | null;
};

export type SyncStatus = {
  mode: SyncMode;
  pendingUploads: number;
  pendingConflicts: number;
  lastSyncAt: string | null;
  lastError: string | null;
  issues: SyncIssue[];
  backendProfile: BackendProfileView | null;
  webdavConfigured: boolean;
  webdavBaseUrl: string | null;
};

export type SyncRunOutcome = {
  kind: 'synced' | 'skipped' | 'failed';
  message: string;
  pushed: number;
  pulled: number;
  pendingUploads: number;
  status: SyncStatus;
};

export type BackendPairInput = {
  baseUrl: string;
  code: string;
  deviceName: string;
};

export type WebDavRuntimeValues = {
  baseUrl: string;
  username: string;
  password: string;
  root: string;
  spaceId: string;
  deviceId: string;
  deviceName: string;
};

export interface SyncRuntime {
  readonly platform: Platform;
  /** 只读本机状态；任何模式下都不会发出网络请求。 */
  readStatus(
    mode: SyncMode,
    webdav?: Partial<WebDavRuntimeValues>,
  ): Promise<SyncStatus>;
  /** 仅 webdav/backend 会联网；local 必须短路。 */
  syncNow(
    mode: SyncMode,
    webdav?: Partial<WebDavRuntimeValues>,
  ): Promise<SyncRunOutcome>;
  /** 用户显式点击“配对设备”时才会联网。 */
  pairBackend(input: BackendPairInput): Promise<BackendProfileView>;
}
