/**
 * `@zhixing/sync-webdav`：面向 OpenList/Alist 的 WebDAV 同步核心。
 *
 * 这个包不依赖 React、Tauri 或 Node 专属 API，可同时运行在：
 * - Tauri 桌面 WebView（app/src/sync/webdav/engine.ts 使用）；
 * - Node 20+ 测试（server/test/webdav/）；
 * - 未来移动端。
 */

export * from './types.ts';
export * from './base64.ts';
export * from './errors.ts';
export * from './paths.ts';
export * from './layout.ts';
export * from './mode.ts';
export * from './retry.ts';
export * from './sha256.ts';
export * from './gzip.ts';
export { WebDavClient, createRandomId, validateSnapshotData } from './client.ts';
export { propfindBody, parseMultiStatus } from './xml.ts';
