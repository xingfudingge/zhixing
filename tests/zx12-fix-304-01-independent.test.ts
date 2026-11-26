// @ts-nocheck
/**
 * ZX12-FIX-304-01 独立验收（不依赖浏览器/桌面进程）。
 *
 * 断言：
 * 1. 生产 CSP 的 connect-src 只允许 IPC，不给 WebView 远程直连开口；
 * 2. 节假日同步源码默认调用 Rust `http_fetch_text`，浏览器分支不直连；
 * 3. Rust 代理只转发 accept / if-none-match / if-modified-since；
 * 4. 经代理第二次同步发送 If-None-Match 并接收真实 304，缓存/版本不变；
 * 5. 无 Tauri 时明确"需桌面壳"，保留缓存且不更新 lastSyncAt。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MemoryHolidayPackageStore, holidayCacheKey } from '../app/src/features/calendar/holiday/store';
import { HolidaySyncService } from '../app/src/features/calendar/holiday/sync';
import { normalizeHolidayPreferences } from '../app/src/features/calendar/holiday/types';

const ROOT = join(__dirname, '..');
const APP = join(ROOT, 'app');
const NOW = new Date('2026-11-01T12:00:00.000Z');
const ATTEMPT = NOW.toISOString();
const PREVIOUS = '2026-10-01T00:00:00.000Z';

function read(path) {
  return readFileSync(join(APP, path), 'utf8');
}

const PAYLOAD = JSON.stringify({
  year: 2026,
  papers: [],
  days: [
    { name: '元旦', date: '2026-01-01', isOffDay: true },
    { name: '元旦', date: '2026-01-02', isOffDay: true },
    { name: '元旦', date: '2026-01-03', isOffDay: true },
    { name: '国庆节', date: '2026-10-01', isOffDay: true },
    { name: '国庆节', date: '2026-10-02', isOffDay: true },
  ],
});

function single(sourceId = 'holiday-cn') {
  return normalizeHolidayPreferences({
    mode: 'single',
    sourceId,
    transport: 'jsdelivr',
    autoFallback: false,
  });
}

async function seed(store) {
  await store.putRecord({
    cacheKey: holidayCacheKey('holiday-cn', 'jsdelivr', 2026),
    sourceId: 'holiday-cn',
    transport: 'jsdelivr',
    format: 'holiday-cn-json',
    year: 2026,
    package: {
      year: 2026,
      days: JSON.parse(PAYLOAD).days,
      source: 'holiday-cn',
      version: 'cached-v1',
      origin: 'remote',
      fetchedAt: PREVIOUS,
      papers: [],
    },
    etag: '"cached-v1"',
    lastModified: null,
    contentHash: 'deadbeef',
    fetchedAt: PREVIOUS,
  });
  await store.putState({
    source: 'jsdelivr',
    mode: 'single',
    sourceId: 'holiday-cn',
    transport: 'jsdelivr',
    activeSourceId: 'holiday-cn',
    activeTransport: 'jsdelivr',
    lastGoodSourceId: 'holiday-cn',
    fallbackUsed: false,
    fallbackFromSourceId: null,
    fallbackReason: null,
    lastSyncAt: PREVIOUS,
    lastAttemptAt: PREVIOUS,
    lastError: null,
    lastErrorSourceId: null,
    nextRetryAt: null,
    consecutiveFailures: 0,
    version: '2026:cached-v1',
    cachedYears: [2026],
    notPublishedYears: [],
    stale: false,
    perSource: {},
  });
}

describe('ZX12-FIX-304-01 CSP 与代理契约', () => {
  it('生产 CSP connect-src 只允许 IPC，不允许远程直连', () => {
    const config = JSON.parse(read('src-tauri/tauri.conf.json'));
    const csp = config.app.security.csp;
    const connect = csp
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('connect-src '));
    expect(connect).toBeTruthy();
    expect(connect).toContain('ipc:');
    expect(connect).toContain('http://ipc.localhost');
    expect(connect).not.toContain('https:');
    expect(connect).not.toMatch(/https?:\/\/\*/);
    expect(connect).not.toContain('*');
    expect(connect).not.toContain('jsdelivr');
    expect(connect).not.toContain('unpkg');
    expect(connect).not.toContain('github');
  });

  it('节假日同步默认走 Rust http_fetch_text，浏览器分支不直连 fetch', () => {
    const source = read('src/features/calendar/holiday/sync.ts');
    expect(source).toContain("invokeImpl('http_fetch_text'");
    expect(source).toContain('createBrowserHttpClient');
    expect(source).toContain('需桌面壳');
    expect(source).toContain('supportsConditionalHeaders');
    // 不再保留“没有 fetchImpl 就 window.fetch”的生产兜底。
    expect(source).not.toMatch(/typeof fetch !== 'function'/);
  });

  it('Rust 代理只转发条件请求允许头，拒绝 authorization', () => {
    const rust = read('src-tauri/src/http.rs');
    expect(rust).toContain(
      'const ALLOWED_HEADERS: [&str; 3] = ["accept", "if-none-match", "if-modified-since"]',
    );
    expect(rust).toContain('不允许的请求头');
    expect(rust).toContain('http_fetch_text');
  });
});

describe('ZX12-FIX-304-01 真实 304 与浏览器分支', () => {
  it('代理第二次同步发送 If-None-Match 并原样返回 304，缓存版本不变', async () => {
    const store = new MemoryHolidayPackageStore();
    const calls = [];
    const responses = [
      {
        status: 200,
        statusText: 'OK',
        etag: '"proxy-v1"',
        lastModified: null,
        contentType: 'application/json',
        body: PAYLOAD,
        finalUrl: 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json',
      },
      {
        status: 304,
        statusText: 'Not Modified',
        etag: '"proxy-v1"',
        lastModified: null,
        contentType: null,
        body: '',
        finalUrl: 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json',
      },
    ];
    const service = new HolidaySyncService({
      store,
      runtime: true,
      invokeImpl: async (command, args) => {
        calls.push({ command, args });
        return responses.shift();
      },
      now: () => NOW,
      timeoutMs: 50,
      targetYears: () => [2026],
    });

    const first = await service.sync(single());
    expect(first.fetchedYears).toEqual([2026]);
    const record = await store.getRecord('holiday-cn', 'jsdelivr', 2026);
    expect(record?.etag).toBe('"proxy-v1"');
    const firstFetchedAt = record?.fetchedAt;

    const second = await service.sync(single());

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.command)).toEqual([
      'http_fetch_text',
      'http_fetch_text',
    ]);
    expect(
      calls[1].args.headers['if-none-match'],
    ).toBe('"proxy-v1"');
    expect(calls[1].args.timeoutMs).toBe(50);
    expect(second.notModified).toBe(true);
    expect(second.fetchedYears).toEqual([]);
    expect(second.state.lastSyncAt).toBe(ATTEMPT);
    expect(second.state.lastAttemptAt).toBe(ATTEMPT);
    expect(second.state.lastError).toBeNull();

    const after = await store.getRecord('holiday-cn', 'jsdelivr', 2026);
    expect(after?.etag).toBe('"proxy-v1"');
    expect(after?.fetchedAt).toBe(firstFetchedAt);
    expect(after?.package.version).toBe(first.packages[0].version);
  });

  it('无 Tauri 时明确需桌面壳、不发远端请求、保留缓存', async () => {
    const store = new MemoryHolidayPackageStore();
    await seed(store);
    const service = new HolidaySyncService({
      store,
      runtime: false,
      now: () => NOW,
      timeoutMs: 50,
      targetYears: () => [2026],
    });

    expect(service.transportKind).toBe('browser');
    await expect(service.sync(single())).rejects.toThrow(/需桌面壳/);

    const state = await service.getState();
    expect(state.lastSyncAt).toBe(PREVIOUS);
    expect(state.lastAttemptAt).toBe(ATTEMPT);
    expect(state.lastError).toContain('桌面壳');
    expect(
      (await store.getRecord('holiday-cn', 'jsdelivr', 2026))?.package.version,
    ).toBe('cached-v1');
  });
});
