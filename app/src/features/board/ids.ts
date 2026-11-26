import type { IdFactory } from './types';

let fallbackCounter = 0;

/**
 * 生成稳定前缀的本地 id。优先使用 crypto.randomUUID；旧 WebView 或测试
 * 环境没有 randomUUID 时退回时间戳 + 进程内计数器，仍保证同一会话内唯一。
 */
export function createBoardId(prefix: 'node' | 'edge'): string {
  const cryptoObject =
    typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return `${prefix}-${cryptoObject.randomUUID()}`;
  }
  fallbackCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

export const boardIdFactory: IdFactory = (prefix) => createBoardId(prefix);
