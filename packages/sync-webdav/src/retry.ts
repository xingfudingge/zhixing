/**
 * WebDAV 重试。
 *
 * - 只重试网络错误、超时、429、5xx；401/403/404/409 立即失败。
 * - 指数退避 + 抖动；429/503 有 Retry-After 时优先使用。
 * - 重试的是“幂等操作”（PUT 到不可变文件名 / GET / PROPFIND），
 *   因此断网恢复后不会产生重复 op 文件。
 */

import { WebDavError } from './errors.ts';
import type { RetryInfo, RetryOptions } from './types.ts';

export const DEFAULT_MAX_ATTEMPTS = 4;
export const DEFAULT_BASE_DELAY_MS = 300;
export const DEFAULT_MAX_DELAY_MS = 8_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay(
  attempt: number,
  options: Required<Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs'>>,
  random: () => number,
): number {
  const exponential = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const factor = 0.75 + random() * 0.5;
  return Math.max(0, Math.round(exponential * factor));
}

export async function withRetry<T>(
  method: string,
  path: string,
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await operation(attempt);
    } catch (error) {
      const retryable = error instanceof WebDavError && error.retryable;
      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }
      const explicitDelay =
        error instanceof WebDavError ? error.retryAfterMs : null;
      const delayMs =
        explicitDelay !== null && explicitDelay >= 0
          ? Math.min(explicitDelay, maxDelayMs)
          : jitteredDelay(attempt, { baseDelayMs, maxDelayMs }, random);
      const info: RetryInfo = {
        attempt,
        maxAttempts,
        delayMs,
        method,
        path,
        status: error instanceof WebDavError ? error.status : null,
        code: error instanceof WebDavError ? error.code : 'UNKNOWN',
        message: error instanceof Error ? error.message : '未知错误',
      };
      options.onRetry?.(info);
      await sleep(delayMs);
    }
  }
}
