import type { Hlc } from './types.ts';

/**
 * Hybrid Logical Clock。
 * - 不依赖设备时钟准确：取 max(本地物理时间, 上次时钟, 收到的时钟)；
 * - 同一毫秒内用 c 递增，保证可排序；
 * - 比较时最后用设备 ID 兜底，保证跨设备确定性。
 */
export class HlcClock {
  private last: Hlc = { ms: 0, c: 0, d: '' };
  private readonly deviceId: string;

  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  /** 生成下一个 HLC。physicalNow 可注入，便于测试。 */
  next(physicalNow = Date.now()): Hlc {
    const ms = Math.max(physicalNow, this.last.ms);
    const c = ms === this.last.ms ? this.last.c + 1 : 0;
    this.last = { ms, c, d: this.deviceId };
    return { ...this.last };
  }

  /** 收到远端 HLC 后推进本地时钟（用于服务端生成冲突副本 op）。 */
  receive(remote: Hlc, physicalNow = Date.now()): Hlc {
    let next: Hlc;
    if (physicalNow > this.last.ms && physicalNow > remote.ms) {
      next = { ms: physicalNow, c: 0, d: this.deviceId };
    } else if (this.last.ms === remote.ms) {
      next = { ms: this.last.ms, c: Math.max(this.last.c, remote.c) + 1, d: this.deviceId };
    } else if (this.last.ms > remote.ms) {
      next = { ms: this.last.ms, c: this.last.c + 1, d: this.deviceId };
    } else {
      next = { ms: remote.ms, c: remote.c + 1, d: this.deviceId };
    }
    this.last = next;
    return { ...next };
  }

  /** 恢复持久化的最后时钟（重启后仍保持单调）。 */
  restore(hlc: Hlc | null | undefined): void {
    if (hlc && isValidHlc(hlc) && compareHlc(hlc, this.last) > 0) {
      this.last = { ...hlc, d: this.deviceId };
    }
  }

  peek(): Hlc {
    return { ...this.last };
  }
}

export function isValidHlc(value: unknown): value is Hlc {
  if (!value || typeof value !== 'object') return false;
  const hlc = value as Partial<Hlc>;
  return (
    Number.isSafeInteger(hlc.ms) &&
    (hlc.ms ?? -1) >= 0 &&
    Number.isSafeInteger(hlc.c) &&
    (hlc.c ?? -1) >= 0 &&
    typeof hlc.d === 'string' &&
    hlc.d.length > 0 &&
    hlc.d.length <= 64
  );
}

export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.c !== b.c) return a.c < b.c ? -1 : 1;
  if (a.d === b.d) return 0;
  return a.d < b.d ? -1 : 1;
}

export function maxHlc(a: Hlc | null, b: Hlc | null): Hlc | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return compareHlc(a, b) >= 0 ? { ...a } : { ...b };
}

export function hlcToString(hlc: Hlc): string {
  return `${hlc.ms.toString(36)}:${hlc.c.toString(36)}:${hlc.d}`;
}
