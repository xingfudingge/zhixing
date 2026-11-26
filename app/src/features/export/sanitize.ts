/**
 * 备份安全边界（P2-04）。
 *
 * 完整备份只导出「业务数据 + 白名单内的设备偏好」。账号、令牌、密钥、
 * WebDAV 密码、同步游标与设备密钥一律不进入备份；设置表按
 * SETTING_KEYS 白名单过滤，未知键默认排除，并在 manifest 中列名。
 */

import type { JsonValue, Setting } from '../../data/db/types';
import { SETTING_KEYS } from '../../data/repositories/settings';
import { sha256Bytes } from '../attachments/sha256';

export const SAFE_SETTING_KEYS: ReadonlyArray<string> = Object.values(
  SETTING_KEYS,
);

const SECRET_KEY_PATTERN =
  /(?:^|[._-])(?:token|secret|password|passwd|credential|credentials|authorization|auth|api[._-]?key|apikey|license|licence|install[._-]?id|device[._-]?id|sync[._-]?cursor)(?:$|[._-])/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export function isSafeSettingKey(key: string): boolean {
  return SAFE_SETTING_KEYS.includes(key) && !isSecretKey(key);
}

export type FilteredSettings = {
  safe: Setting[];
  excludedKeys: string[];
};

export function filterSafeSettings(
  rows: ReadonlyArray<Setting>,
): FilteredSettings {
  const safe: Setting[] = [];
  const excluded = new Set<string>();
  for (const row of rows) {
    if (isSafeSettingKey(row.key)) {
      safe.push({ ...row, value: cloneJson(row.value) });
    } else {
      excluded.add(redactSecrets(row.key));
    }
  }
  return {
    safe: safe.sort((a, b) => a.key.localeCompare(b.key)),
    excludedKeys: Array.from(excluded).sort(),
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function stableStringify(value: unknown): string {
  const seen = new Set<object>();
  const walk = (input: unknown): string => {
    if (input === null) return 'null';
    if (typeof input === 'number') {
      return Number.isFinite(input) ? JSON.stringify(input) : 'null';
    }
    if (typeof input === 'boolean' || typeof input === 'string') {
      return JSON.stringify(input);
    }
    if (Array.isArray(input)) {
      return `[${input.map((item) => walk(item)).join(',')}]`;
    }
    if (typeof input === 'object') {
      if (seen.has(input)) {
        throw new Error('备份数据包含循环引用');
      }
      seen.add(input);
      const record = input as Record<string, unknown>;
      const body = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${walk(record[key])}`)
        .join(',');
      seen.delete(input);
      return `{${body}}`;
    }
    return 'null';
  };
  return walk(value);
}

export function sha256Text(text: string): string {
  return sha256Bytes(new TextEncoder().encode(text));
}

export function sha256Json(value: unknown): string {
  return sha256Text(stableStringify(value));
}

export function sanitizeFileName(value: string, fallback = '未命名'): string {
  const cleaned = value
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

export function backupTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]'],
  [
    /(?:token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*["']?[^"'\s,}]+/gi,
    '凭证=[已隐藏]',
  ],
  [/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱已隐藏]'],
  [/\b[A-Fa-f0-9]{64}\b/g, '[长哈希已隐藏]'],
];

/** 诊断信息与错误日志在落地/下载前统一脱敏。 */
export function redactSecrets(value: string): string {
  let result = value;
  for (const [pattern, replacement] of REDACTIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function settingIdentity(row: Pick<Setting, 'scope' | 'key'>): string {
  return `${row.scope}:${row.key}`;
}

export function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}
