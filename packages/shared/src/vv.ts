import type { VersionVector } from './types.ts';

export type VvRelation = 'equal' | 'dominant' | 'dominated' | 'concurrent';

function keysOf(a: VersionVector, b: VersionVector): string[] {
  return Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
}

/**
 * 比较 a 与 b：
 * - dominant：a 包含 b 的全部因果信息（a >= b），且至少一项更大；
 * - dominated：a <= b；
 * - concurrent：互不包含。
 */
export function compareVv(a: VersionVector, b: VersionVector): VvRelation {
  let aGreater = false;
  let bGreater = false;
  for (const key of keysOf(a, b)) {
    const av = a[key] ?? 0;
    const bv = b[key] ?? 0;
    if (av > bv) aGreater = true;
    else if (bv > av) bGreater = true;
  }
  if (aGreater && bGreater) return 'concurrent';
  if (aGreater) return 'dominant';
  if (bGreater) return 'dominated';
  return 'equal';
}

export function dominatesOrEqual(a: VersionVector, b: VersionVector): boolean {
  const relation = compareVv(a, b);
  return relation === 'dominant' || relation === 'equal';
}

export function isConcurrent(a: VersionVector, b: VersionVector): boolean {
  return compareVv(a, b) === 'concurrent';
}

export function mergeVv(...vectors: VersionVector[]): VersionVector {
  const result: VersionVector = {};
  for (const vector of vectors) {
    for (const [device, value] of Object.entries(vector)) {
      if (!Number.isSafeInteger(value) || value < 0) continue;
      const current = result[device] ?? 0;
      if (value > current) result[device] = value;
    }
  }
  return result;
}

/**
 * 应用一个 op 后的版本向量：op 的 base_vv 加上本设备计数 +1。
 * 若本地已见过更高计数（例如批量重放），取 max + 1，避免 VV 回退。
 */
export function advanceVv(
  base: VersionVector,
  deviceId: string,
  current?: VersionVector,
): VersionVector {
  const merged = mergeVv(base, current ?? {});
  const seen = Math.max(base[deviceId] ?? 0, current?.[deviceId] ?? 0);
  merged[deviceId] = seen + 1;
  return merged;
}

export function vvSize(vv: VersionVector): number {
  return Object.keys(vv).length;
}

export function sanitizeVv(value: unknown, maxDevices = 200): VersionVector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: VersionVector = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(result).length >= maxDevices) break;
    if (key.length === 0 || key.length > 64) continue;
    if (!Number.isSafeInteger(raw) || (raw as number) < 0) continue;
    result[key] = raw as number;
  }
  return result;
}
