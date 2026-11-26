/**
 * 知行 WebDAV 同步入口。
 *
 * 典型用法（桌面设置页）：
 *
 * ```ts
 * const engine = createWebDavSyncEngine({ ...savedConfig, password, platform });
 * const panel = <WebDavSettingsPanel platform={platform} />;
 * const controller = new WebDavModeController({ engine, platform });
 * await controller.switchMode('webdav', { confirmed: false });
 * ```
 *
 * Web 平台请在渲染面板前判断 `isWebPlatform()`；`WebDavSyncEngine` 与
 * `WebDavClient` 也会拒绝 `platform: 'web'`，避免“入口藏了但代码仍能连”。
 */

import type { SyncStore } from '../types.ts';
import {
  WebDavClient,
  type ConnectionTestResult,
  type Platform,
  type WebDavClientOptions,
} from '../../../../packages/sync-webdav/src/index.ts';
import { WebDavSyncEngine, type WebDavEngineOptions } from './engine.ts';
import type { WebDavEngineConfig } from './types.ts';
import type { WebDavCursorStore } from './cursors.ts';

export * from './types.ts';
export * from './cursors.ts';
export * from './configStore.ts';
export * from './engine.ts';
export * from './modeController.ts';
export * from './platform.ts';
export { WebDavSettingsPanel } from './WebDavSettingsPanel.tsx';
export type {
  WebDavFormValues,
  WebDavConnectionTester,
  WebDavSettingsPanelProps,
} from './WebDavSettingsPanel.tsx';

export {
  WebDavClient,
  WebDavError,
  toUserFacingError,
  createSpaceLayout,
  deriveDeviceOps,
  deriveDeviceIds,
  deriveRemoteState,
  deriveSnapshotRefs,
  isWebDavPlatformSupported,
  normalizeBaseUrl,
  normalizeRoot,
  parseOpFileName,
  parseSnapshotName,
  sha256Hex,
  validateSnapshotData,
} from '../../../../packages/sync-webdav/src/index.ts';
export type {
  AppendOpsResult,
  AssetRef,
  ConnectionCheck,
  ConnectionTestResult,
  DavEntry,
  DeviceOps,
  Platform,
  ReadOpsResult,
  RemoteState,
  RetryOptions,
  SnapshotData,
  SnapshotRef,
  WebDavClientOptions,
} from '../../../../packages/sync-webdav/src/index.ts';

export type WebDavEngineFactoryOptions = WebDavEngineOptions & {
  store?: SyncStore;
  cursors?: WebDavCursorStore;
  client?: WebDavClient;
};

export function createWebDavSyncEngine(
  config: WebDavEngineConfig,
  options: WebDavEngineFactoryOptions = {},
): WebDavSyncEngine {
  return new WebDavSyncEngine(config, options);
}

export type WebDavCreateOptions = WebDavClientOptions & {
  platform: Platform;
};

export function createWebDavClient(options: WebDavCreateOptions): WebDavClient {
  return new WebDavClient(options);
}

/** 测试/设置页可复用的安全探测函数（不会把密码放进返回值）。 */
export async function testWebDavConnection(
  options: WebDavCreateOptions,
): Promise<ConnectionTestResult> {
  const client = new WebDavClient(options);
  return client.testConnection();
}
