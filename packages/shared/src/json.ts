import type { JsonObject, JsonValue } from './types.ts';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** 递归校验 payload：只允许 JSON 值，拒绝原型污染键。 */
export function sanitizeJsonObject(value: unknown, depth = 0): JsonObject {
  if (!isPlainObject(value)) throw new Error('payload 必须是 JSON 对象');
  if (depth > 12) throw new Error('payload 嵌套过深');
  const output: JsonObject = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key.length === 0 || key.length > 200) throw new Error(`非法字段名: ${key}`);
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`非法字段名: ${key}`);
    output[key] = sanitizeJsonValue(raw, depth + 1);
  }
  return output;
}

export function sanitizeJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 12) throw new Error('payload 嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('payload 包含非有限数字');
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    return sanitizeJsonObject(value, depth + 1);
  }
  throw new Error('payload 包含非 JSON 值');
}

/** 稳定序列化：对象键排序，用于值比较与哈希。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

export function jsonEquals(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
