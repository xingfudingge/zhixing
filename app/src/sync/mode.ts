/**
 * 每设备单一同步模式的同步读取入口。
 *
 * 正式版由 SQLite/设置表提供；原型与当前桌面壳沿用 WebDAV 模式控制器的
 * localStorage 键。附件状态文案必须按当前模式分流，因此这里提供同步读取，
 * 避免为了判断“是否 local”而发一次异步请求。
 */

import type { SyncMode } from '../features/sync/types';

export const SYNC_MODE_STORAGE_KEY = 'zhixing.sync.mode.v1';

export function isSyncMode(value: unknown): value is SyncMode {
  return value === 'local' || value === 'webdav' || value === 'backend';
}

type StorageLike = Pick<Storage, 'getItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * 读取模式；缺失/损坏/不可访问时回退 local。
 * local 是最安全的默认值：不会把本机文件误报成“待同步”。
 */
export function readStoredSyncMode(storage: StorageLike | null = defaultStorage()): SyncMode {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(SYNC_MODE_STORAGE_KEY) ?? null;
  } catch {
    raw = null;
  }
  return isSyncMode(raw) ? raw : 'local';
}
