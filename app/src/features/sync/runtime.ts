/**
 * 设置页同步运行时。
 *
 * 设计边界：
 * - `readStatus` 只读本机存储和游标，绝不联网；
 * - `local` 模式下 `syncNow` 立即短路，不创建任何 transport；
 * - WebDAV / 后台只在用户明确切换模式并点击“立即同步”后发出请求；
 * - 后台配对是用户显式动作，使用既有 `SyncEngine.pair`，不新增协议。
 */

import {
  WebDavClient,
  normalizeBaseUrl,
  normalizeRoot,
  type Platform,
} from '../../../../packages/sync-webdav/src/index.ts';
import type { FetchLike } from '../../sync/client.ts';
import type { SyncEngine } from '../../sync/engine.ts';
import { createSyncEngine } from '../../sync/index.ts';
import { LocalStorageSyncStore } from '../../sync/store.ts';
import type { SyncStore } from '../../sync/types.ts';
import {
  LocalStorageWebDavConfigStore,
  defaultWebDavConfig,
  type WebDavConfigStore,
  type WebDavSavedConfig,
} from '../../sync/webdav/configStore.ts';
import { LocalStorageWebDavCursorStore } from '../../sync/webdav/cursors.ts';
import { WebDavSyncEngine } from '../../sync/webdav/engine.ts';
import type {
  BackendPairInput,
  BackendProfileView,
  SyncMode,
  SyncRunOutcome,
  SyncRuntime,
  SyncStatus,
  WebDavRuntimeValues,
} from './types.ts';

export class SyncFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncFeatureError';
  }
}

export type SyncRuntimeOptions = {
  platform: Platform;
  store?: SyncStore;
  webdavConfigStore?: WebDavConfigStore;
  fetchImpl?: FetchLike;
  now?: () => number;
};

function formatError(reason: unknown, fallback = '操作失败，请重试'): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return fallback;
}

function profileView(profile: {
  baseUrl: string;
  deviceId: string;
  deviceName: string;
  lastSyncAt: string | null;
  lastError: string | null;
}): BackendProfileView {
  return {
    baseUrl: profile.baseUrl,
    deviceId: profile.deviceId,
    deviceName: profile.deviceName,
    lastSyncAt: profile.lastSyncAt,
    lastError: profile.lastError,
  };
}

function validateBackendInput(input: BackendPairInput): {
  baseUrl: string;
  code: string;
  deviceName: string;
} {
  const baseUrl = input.baseUrl.trim();
  if (!baseUrl) {
    throw new SyncFeatureError('请填写后台服务地址');
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new SyncFeatureError('后台服务地址不是有效的 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SyncFeatureError('后台服务地址只支持 http 或 https');
  }
  const code = input.code.trim();
  if (!code) {
    throw new SyncFeatureError('请填写配对码');
  }
  return {
    baseUrl,
    code,
    deviceName: input.deviceName.trim() || '本机',
  };
}

export function createSyncRuntime(options: SyncRuntimeOptions): SyncRuntime {
  const platform = options.platform;
  const store = options.store ?? new LocalStorageSyncStore();
  const webdavConfigStore =
    options.webdavConfigStore ?? new LocalStorageWebDavConfigStore();
  const fetchImpl = options.fetchImpl;
  const now = options.now ?? (() => Date.now());

  async function loadWebDavConfig(): Promise<WebDavSavedConfig | null> {
    try {
      return await webdavConfigStore.load();
    } catch {
      return null;
    }
  }

  function webdavCursorStore(
    values: Partial<WebDavRuntimeValues>,
    saved: WebDavSavedConfig | null,
  ) {
    const baseUrl = normalizeBaseUrl(
      values.baseUrl?.trim() || saved?.baseUrl || '',
    );
    return new LocalStorageWebDavCursorStore({
      baseUrl,
      root: normalizeRoot(values.root || saved?.root || '/zhixing'),
      spaceId: values.spaceId?.trim() || saved?.spaceId || 'personal',
    });
  }

  async function readStatus(
    mode: SyncMode,
    webdav?: Partial<WebDavRuntimeValues>,
  ): Promise<SyncStatus> {
    const [outbox, conflicts, profile, saved] = await Promise.all([
      store.listOutbox(),
      store.listConflicts(),
      store.loadProfile(),
      loadWebDavConfig(),
    ]);

    const issues = outbox
      .filter((entry) => Boolean(entry.lastError))
      .map((entry) => ({
        id: entry.op.op_id,
        entityType: entry.op.entity_type ?? null,
        message: entry.lastError ?? '上次同步失败',
        attempts: entry.attempts,
        nextAttemptAt: entry.nextAttemptAt > 0 ? entry.nextAttemptAt : null,
      }))
      .slice(0, 20);

    const savedBaseUrl = saved?.baseUrl?.trim() || null;
    const effectiveBaseUrl = webdav?.baseUrl?.trim() || savedBaseUrl || null;
    let lastSyncAt: string | null = null;
    let lastError: string | null = null;

    if (mode === 'webdav' && effectiveBaseUrl) {
      try {
        const state = await webdavCursorStore(
          {
            ...webdav,
            baseUrl: effectiveBaseUrl,
          },
          saved,
        ).load();
        lastSyncAt = state.lastSyncAt;
        lastError = state.lastError;
      } catch {
        lastError = 'WebDAV 游标读取失败';
      }
    } else if (mode === 'backend') {
      lastSyncAt = profile?.lastSyncAt ?? null;
      lastError = profile?.lastError ?? null;
    }

    return {
      mode,
      pendingUploads: outbox.length,
      pendingConflicts: conflicts.length,
      lastSyncAt,
      lastError,
      issues,
      backendProfile: profile ? profileView(profile) : null,
      webdavConfigured: Boolean(savedBaseUrl),
      webdavBaseUrl: effectiveBaseUrl,
    };
  }

  function skipped(
    message: string,
    status: SyncStatus,
  ): SyncRunOutcome {
    return {
      kind: 'skipped',
      message,
      pushed: 0,
      pulled: 0,
      pendingUploads: status.pendingUploads,
      status,
    };
  }

  function failed(
    message: string,
    status: SyncStatus,
  ): SyncRunOutcome {
    return {
      kind: 'failed',
      message,
      pushed: 0,
      pulled: 0,
      pendingUploads: status.pendingUploads,
      status,
    };
  }

  async function syncWebDav(
    webdav?: Partial<WebDavRuntimeValues>,
  ): Promise<SyncRunOutcome> {
    if (platform === 'web') {
      const status = await readStatus('webdav', webdav);
      return skipped('Web 端不提供 WebDAV 同步', status);
    }

    const saved = await loadWebDavConfig();
    const defaults = defaultWebDavConfig();
    const values: WebDavRuntimeValues = {
      baseUrl: webdav?.baseUrl?.trim() || saved?.baseUrl?.trim() || '',
      username: webdav?.username ?? saved?.username ?? '',
      password: webdav?.password ?? '',
      root: webdav?.root?.trim() || saved?.root?.trim() || defaults.root,
      spaceId:
        webdav?.spaceId?.trim() || saved?.spaceId?.trim() || defaults.spaceId,
      deviceId: webdav?.deviceId || saved?.deviceId || defaults.deviceId,
      deviceName:
        webdav?.deviceName?.trim() ||
        saved?.deviceName?.trim() ||
        defaults.deviceName,
    };

    if (!values.baseUrl) {
      const status = await readStatus('webdav', values);
      return failed(
        '尚未配置 WebDAV 地址：请先填写并测试连接，再保存配置',
        status,
      );
    }

    try {
      const client = new WebDavClient({
        baseUrl: values.baseUrl,
        username: values.username,
        password: values.password,
        root: values.root,
        spaceId: values.spaceId,
        deviceId: values.deviceId,
        platform,
        fetchImpl,
      });
      const engine = new WebDavSyncEngine(
        {
          baseUrl: values.baseUrl,
          username: values.username,
          password: values.password,
          root: values.root,
          spaceId: values.spaceId,
          deviceId: values.deviceId,
          deviceName: values.deviceName,
          platform,
        },
        {
          store,
          client,
          now,
          cursors: webdavCursorStore(values, saved),
        },
      );
      const result = await engine.sync({ force: true });
      const status = await readStatus('webdav', values);
      return {
        kind: result.ok ? 'synced' : 'failed',
        message: result.ok
          ? `WebDAV 同步完成：上传 ${result.pushed}，下载 ${result.pulled}，待上传 ${result.outbox}`
          : `WebDAV 同步失败：${result.error ?? '未知错误'}`,
        pushed: result.pushed,
        pulled: result.pulled,
        pendingUploads: result.outbox,
        status,
      };
    } catch (error) {
      const status = await readStatus('webdav', values);
      return failed(`WebDAV 同步失败：${formatError(error)}`, status);
    }
  }

  async function syncBackend(): Promise<SyncRunOutcome> {
    const engine: SyncEngine = createSyncEngine({ store, fetchImpl, now });
    try {
      await engine.init();
      const current = await engine.status();
      if (!current.paired) {
        const status = await readStatus('backend');
        return failed(
          '尚未配对后台设备：请先填写后台地址与配对码并完成配对',
          status,
        );
      }
      const result = await engine.sync({ force: true });
      const status = await readStatus('backend');
      return {
        kind: result.ok ? 'synced' : 'failed',
        message: result.ok
          ? `后台同步完成：上传 ${result.pushed}，下载 ${result.pulled}，待上传 ${result.outbox}`
          : `后台同步失败：${result.error ?? '未知错误'}`,
        pushed: result.pushed,
        pulled: result.pulled,
        pendingUploads: result.outbox,
        status,
      };
    } catch (error) {
      const status = await readStatus('backend');
      return failed(`后台同步失败：${formatError(error)}`, status);
    }
  }

  return {
    platform,

    readStatus,

    async syncNow(mode, webdav) {
      if (mode === 'local') {
        // 产品硬约束：仅本机模式必须短路，连 transport 都不创建。
        const status = await readStatus('local');
        return skipped('仅本机模式不会发起任何同步网络请求', status);
      }
      if (mode === 'webdav') {
        return syncWebDav(webdav);
      }
      return syncBackend();
    },

    async pairBackend(input) {
      const valid = validateBackendInput(input);
      const engine = createSyncEngine({ store, fetchImpl, now });
      await engine.init();
      try {
        const profile = await engine.pair({
          baseUrl: valid.baseUrl,
          code: valid.code,
          name: valid.deviceName,
          platform,
        });
        return profileView(profile);
      } catch (error) {
        throw new SyncFeatureError(formatError(error, '配对失败'));
      }
    },
  };
}
