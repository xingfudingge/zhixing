import type {
  PairDeviceResponse,
  PullResponse,
  PushResponse,
  RefreshDeviceResponse,
  SyncConflictRecord,
  SyncOp,
  SyncStatusResponse,
} from '../../../packages/shared/src/index.ts';
import type { PairDeviceInput, SyncDeviceProfile, SyncPlatform } from './types.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class SyncHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'SyncHttpError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export class SyncNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SyncNetworkError';
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function apiBase(baseUrl: string): string {
  const root = normalizeBaseUrl(baseUrl);
  return root.endsWith('/api/v1') ? root : `${root}/api/v1`;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const defaultFetch: FetchLike = (input, init) => {
  if (typeof fetch !== 'function') {
    return Promise.reject(new SyncNetworkError('当前运行环境没有 fetch'));
  }
  return fetch(input, init);
};

export class SyncHttpClient {
  readonly rootUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl: string; fetchImpl?: FetchLike; timeoutMs?: number }) {
    this.rootUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async request<T>(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'DELETE';
      body?: unknown;
      auth?: { deviceId: string; token: string };
    } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.auth) {
      headers.authorization = `Bearer ${options.auth.token}`;
      headers['x-zx-device'] = options.auth.deviceId;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${apiBase(this.rootUrl)}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof SyncHttpError) throw error;
      const message =
        (error as Error)?.name === 'AbortError'
          ? '同步请求超时'
          : `网络不可达：${(error as Error)?.message ?? 'unknown'}`;
      throw new SyncNetworkError(message, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }

    if (!response.ok) {
      const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
      throw new SyncHttpError(
        response.status,
        error?.code ?? `HTTP_${response.status}`,
        error?.message ?? `同步请求失败（HTTP ${response.status}）`,
        isRetryableStatus(response.status),
      );
    }
    return body as T;
  }

  private auth(profile: SyncDeviceProfile) {
    return { deviceId: profile.deviceId, token: profile.deviceToken };
  }

  async pair(input: PairDeviceInput): Promise<SyncDeviceProfile> {
    const response = await this.request<PairDeviceResponse>('/devices/pair', {
      method: 'POST',
      body: {
        code: input.code,
        name: input.name,
        platform: input.platform,
      },
    });
    return {
      baseUrl: this.rootUrl,
      spaceId: input.spaceId ?? 'personal',
      deviceId: response.deviceId,
      deviceName: response.deviceName,
      platform: input.platform as SyncPlatform,
      deviceToken: response.deviceToken,
      refreshToken: response.refreshToken,
      accessExpiresAt: response.accessExpiresAt,
      refreshExpiresAt: response.refreshExpiresAt,
      features: response.features ?? {},
      lastPullCursor: '0',
      lastSyncAt: null,
      lastError: null,
    };
  }

  async refresh(profile: SyncDeviceProfile): Promise<SyncDeviceProfile> {
    const response = await this.request<RefreshDeviceResponse>('/devices/refresh', {
      method: 'POST',
      body: { refreshToken: profile.refreshToken },
    });
    return {
      ...profile,
      deviceToken: response.deviceToken,
      refreshToken: response.refreshToken,
      accessExpiresAt: response.accessExpiresAt,
      refreshExpiresAt: response.refreshExpiresAt,
      lastError: null,
    };
  }

  async push(
    profile: SyncDeviceProfile,
    ops: SyncOp[],
  ): Promise<{
    applied: PushResponse['applied'];
    duplicates: PushResponse['duplicates'];
    conflicts: SyncConflictRecord[];
    nextCursor: string;
    serverTime: string;
  }> {
    const response = await this.request<PushResponse>('/sync/push', {
      method: 'POST',
      body: { ops },
      auth: this.auth(profile),
    });
    return {
      applied: response.applied,
      duplicates: response.duplicates,
      conflicts: response.conflicts,
      nextCursor: response.nextCursor,
      serverTime: response.serverTime,
    };
  }

  async pull(
    profile: SyncDeviceProfile,
    cursor: string,
    limit = 200,
  ): Promise<{
    ops: PullResponse['ops'];
    nextCursor: string;
    hasMore: boolean;
    conflicts: SyncConflictRecord[];
    serverTime: string;
  }> {
    const query = new URLSearchParams({ cursor, limit: String(limit) });
    const response = await this.request<PullResponse>(`/sync/pull?${query.toString()}`, {
      auth: this.auth(profile),
    });
    return {
      ops: response.ops,
      nextCursor: response.nextCursor,
      hasMore: response.hasMore,
      conflicts: response.conflicts,
      serverTime: response.serverTime,
    };
  }

  async status(profile: SyncDeviceProfile): Promise<SyncStatusResponse> {
    return this.request<SyncStatusResponse>('/sync/status', {
      auth: this.auth(profile),
    });
  }
}
