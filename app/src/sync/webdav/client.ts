/**
 * 兼容入口：应用层通常从这里拿 WebDAV client。
 * 协议/实现位于 `packages/sync-webdav/src/client.ts`。
 */

export {
  WebDavClient,
  createRandomId,
  createSpaceLayout,
  deriveDeviceIds,
  deriveDeviceOps,
  deriveRemoteState,
  deriveSnapshotRefs,
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
  ReadOpsResult,
  RemoteState,
  SnapshotData,
  SnapshotRef,
  WebDavClientOptions,
} from '../../../../packages/sync-webdav/src/index.ts';
