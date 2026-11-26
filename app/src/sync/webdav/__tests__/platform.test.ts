import { describe, expect, it } from 'vitest';

import {
  evaluateModeSwitch,
  isWebDavPlatformSupported,
  WebDavClient,
  WebDavError,
} from '../../../../../packages/sync-webdav/src/index.ts';
import {
  assertWebDavEntry,
  detectPlatform,
  isWebPlatform,
} from '../platform.ts';

describe('WebDAV 平台保护', () => {
  it('浏览器环境判定为 web，桌面 Tauri 才允许 WebDAV', () => {
    expect(detectPlatform()).toBe('web');
    expect(isWebPlatform('web')).toBe(true);
    expect(isWebDavPlatformSupported('web')).toBe(false);
    expect(isWebDavPlatformSupported('macos')).toBe(true);
    expect(isWebDavPlatformSupported('windows')).toBe(true);
    expect(isWebDavPlatformSupported('android')).toBe(true);
  });

  it('Web 入口与核心 client 都拒绝 WebDAV', () => {
    expect(() => assertWebDavEntry('web')).toThrow(WebDavError);
    expect(() =>
      new WebDavClient({
        baseUrl: 'https://dav.example.com/dav',
        deviceId: 'device-a',
        platform: 'web',
      }),
    ).toThrow(/Web 端/);
  });

  it('Web 端模式切换只允许 backend', () => {
    const webdav = evaluateModeSwitch({
      platform: 'web',
      from: 'backend',
      to: 'webdav',
      pendingUploads: 0,
    });
    expect(webdav.allowed).toBe(false);
    expect(webdav.code).toBe('WEBDAV_WEB_UNSUPPORTED');

    const local = evaluateModeSwitch({
      platform: 'web',
      from: 'backend',
      to: 'local',
      pendingUploads: 0,
    });
    expect(local.allowed).toBe(false);
    expect(local.code).toBe('WEB_ONLY_BACKEND');

    const backend = evaluateModeSwitch({
      platform: 'web',
      from: 'backend',
      to: 'backend',
      pendingUploads: 0,
    });
    expect(backend.allowed).toBe(true);
    expect(backend.code).toBe('NOOP');
  });
});
