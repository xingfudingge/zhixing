/**
 * ICS 订阅的 HTTP 传输适配器。
 *
 * 背景（ZX12-AUDIT-01）：
 * - 桌面生产 CSP 的 `connect-src` 只允许 IPC，WebView 直接 `fetch` 会被拦；
 * - 浏览器直连时，`If-None-Match` / `If-Modified-Since` 会触发 CORS 预检，
 *   部分订阅源不允许，第二次同步会失败；
 * - 跨域 304 响应也经常缺少 `Access-Control-Allow-Origin`。
 *
 * 因此桌面壳走 Rust 的受限 `http_fetch_text`，浏览器预览保持直连但在跨域时
 * 不发送条件头（改用 200 + 原文对比判断“未变化”），同源仍然使用 304。
 * 测试可注入 `fetchImpl`，按完整能力（允许条件请求）处理。
 */

import { invoke } from '@tauri-apps/api/core';

import { IcsFetchError } from './types';

export type FetchLike = (
  input: string,
  init?: RequestInit & { timeoutMs?: number },
) => Promise<Response>;

export type IcsHttpTransportKind = 'desktop' | 'browser' | 'custom';

export type IcsHttpClient = {
  readonly kind: IcsHttpTransportKind;
  fetch: FetchLike;
  /** 条件请求头/304 在该地址上是否安全可用（不触发 CORS 预检与 304 缺头）。 */
  supportsConditionalHeaders(url: string): boolean;
};

export type InvokeLike = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

type HttpFetchCommandResponse = {
  status?: number;
  statusText?: string;
  etag?: string | null;
  lastModified?: string | null;
  contentType?: string | null;
  body?: string;
  finalUrl?: string;
};

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return '未知错误';
  }
}

function toResponse(data: HttpFetchCommandResponse): Response {
  const status = data.status;
  if (
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599
  ) {
    throw new IcsFetchError(
      `桌面网络代理返回了无效状态码：${String(status)}`,
    );
  }
  const headers = new Headers();
  if (data.etag) headers.set('etag', data.etag);
  if (data.lastModified) headers.set('last-modified', data.lastModified);
  if (data.contentType) headers.set('content-type', data.contentType);
  const body =
    status === 204 || status === 205 || status === 304 ? null : (data.body ?? '');
  return new Response(body, {
    status,
    statusText: data.statusText ?? '',
    headers,
  });
}

function desktopErrorMessage(reason: unknown): string {
  const raw = errorMessage(reason);
  if (/unknown command|command .* not found|not registered|未实现/i.test(raw)) {
    return `桌面网络代理命令未注册（http_fetch_text）：${raw}。请更新或重启桌面应用。`;
  }
  if (/permission|not allowed|denied|capabilit|acl/i.test(raw)) {
    return `桌面网络代理未授权：${raw}`;
  }
  if (/超时|timeout|timed out|deadline/i.test(raw)) {
    return `桌面网络代理请求超时：${raw}`;
  }
  return `桌面网络代理失败：${raw}`;
}

function createDesktopClient(invokeImpl: InvokeLike): IcsHttpClient {
  return {
    kind: 'desktop',
    supportsConditionalHeaders: () => true,
    fetch: async (input, init) => {
      const headers = init?.headers
        ? Object.fromEntries(new Headers(init.headers).entries())
        : {};
      try {
        const data = (await invokeImpl('http_fetch_text', {
          url: input,
          headers,
          timeoutMs: init?.timeoutMs,
        })) as HttpFetchCommandResponse;
        return toResponse(data);
      } catch (reason) {
        if (reason instanceof IcsFetchError) throw reason;
        throw new IcsFetchError(desktopErrorMessage(reason));
      }
    },
  };
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function createBrowserClient(
  fetchImpl: FetchLike,
  origin: string,
): IcsHttpClient {
  return {
    kind: 'browser',
    // 跨域条件请求会先发 OPTIONS；不是所有订阅源都允许这些头。
    supportsConditionalHeaders: (url) => sameOrigin(url, origin),
    fetch: async (input, init) => {
      try {
        return await fetchImpl(input, init);
      } catch (reason) {
        const detail = errorMessage(reason);
        if (/failed to fetch|networkerror|load failed|network error/i.test(detail)) {
          throw new IcsFetchError(
            sameOrigin(input, origin)
              ? `浏览器网络请求失败：${detail}。请检查地址、网络或证书。`
              : `浏览器预览无法跨域读取 ICS（CORS/网络拦截）：${detail}。请在桌面壳内同步，或让订阅源返回 Access-Control-Allow-Origin。`,
          );
        }
        throw new IcsFetchError(`浏览器网络请求失败：${detail}`);
      }
    },
  };
}

function createCustomClient(fetchImpl: FetchLike): IcsHttpClient {
  return {
    kind: 'custom',
    supportsConditionalHeaders: () => true,
    fetch: fetchImpl,
  };
}

export type IcsHttpClientOptions = {
  /** 显式覆盖运行时探测（测试用）。 */
  runtime?: boolean;
  /** 浏览器预览的页面 origin，默认 `window.location.origin`。 */
  origin?: string;
  fetchImpl?: FetchLike;
  invokeImpl?: InvokeLike;
};

export function createIcsHttpClient(
  options: IcsHttpClientOptions = {},
): IcsHttpClient {
  // runtime:false 明确要求浏览器路径时，fetchImpl 用于模拟浏览器网络。
  if (options.fetchImpl && options.runtime !== false) {
    return createCustomClient(options.fetchImpl);
  }
  const runtime = options.runtime ?? isTauriRuntime();
  if (runtime) {
    return createDesktopClient(
      options.invokeImpl ??
        ((command, args) => invoke(command, args as Record<string, unknown>)),
    );
  }
  const origin =
    options.origin ??
    (typeof window !== 'undefined' ? window.location.origin : 'null');
  const browserFetch: FetchLike =
    options.fetchImpl ??
    (typeof fetch === 'function'
      ? (input, init) => fetch(input, init)
      : () => Promise.reject(new Error('当前环境没有 fetch')));
  return createBrowserClient(browserFetch, origin);
}
