/**
 * 平台判定与 WebDAV 入口保护。
 *
 * 产品硬约束：Web 端只连 backend，不出现 WebDAV 表单/入口。
 * 判定顺序很重要：先看 Tauri，再看浏览器；浏览器即使跑在 macOS 上也是 `web`。
 */

import type { Platform } from '../../../../packages/sync-webdav/src/index.ts';
import { WebDavError } from '../../../../packages/sync-webdav/src/index.ts';

export function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  );
}

export function detectPlatform(): Platform {
  if (!isTauriRuntime()) {
    return 'web';
  }
  if (typeof navigator === 'undefined') {
    return 'linux';
  }
  const userAgent = navigator.userAgent;
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  if (/windows/i.test(userAgent)) return 'windows';
  if (/macintosh|mac os x/i.test(userAgent)) return 'macos';
  return 'linux';
}

export function isWebPlatform(platform: Platform = detectPlatform()): boolean {
  return platform === 'web';
}

/** UI 入口层最后一道保护；核心 client 也会拒绝 platform=web。 */
export function assertWebDavEntry(platform: Platform = detectPlatform()): void {
  if (isWebPlatform(platform)) {
    throw new WebDavError(
      'WEBDAV_UNSUPPORTED_ON_WEB',
      'Web 端只连接知行后台，不提供 WebDAV 入口',
    );
  }
}
