/**
 * 客户端同步入口。
 *
 * 用法：
 *   const engine = createSyncEngine();
 *   await engine.init();
 *   await engine.pair({ baseUrl, code, name, platform: 'macos' });
 *   await engine.sync();
 *
 * 桌面正式版的 SQLite 同步表通过实现 SyncStore 接口接入；当前默认
 * LocalStorageSyncStore 仅用于 Web/原型验证与离线演示。
 */
export * from './types.ts';
export { SyncHttpClient, SyncHttpError, SyncNetworkError, normalizeBaseUrl } from './client.ts';
export type { FetchLike } from './client.ts';
export { SyncEngine, SyncEngineError } from './engine.ts';
export type { SyncEngineOptions } from './engine.ts';
export { LocalStorageSyncStore, MemorySyncStore } from './store.ts';

import { SyncEngine, type SyncEngineOptions } from './engine.ts';

export function createSyncEngine(options: SyncEngineOptions = {}): SyncEngine {
  return new SyncEngine(options);
}
