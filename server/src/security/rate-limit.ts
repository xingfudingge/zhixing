type Bucket = {
  count: number;
  resetAt: number;
};

export type RateResult = {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
};

/**
 * 进程内限流器。单用户私有部署只需挡住暴力尝试；
 * 多实例部署应换成 Redis/网关限流（见 server/README.md）。
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly locks = new Map<string, number>();

  private cleanup(now: number): void {
    if (this.buckets.size < 2000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    for (const [key, until] of this.locks) {
      if (until <= now) this.locks.delete(key);
    }
  }

  hit(key: string, limit: number, windowMs: number, now = Date.now()): RateResult {
    this.cleanup(now);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.max(0, limit - 1) };
    }
    bucket.count += 1;
    const allowed = bucket.count <= limit;
    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : Math.ceil((bucket.resetAt - now) / 1000),
      remaining: Math.max(0, limit - bucket.count),
    };
  }

  isLocked(key: string, now = Date.now()): number {
    const until = this.locks.get(key);
    if (!until) return 0;
    if (until <= now) {
      this.locks.delete(key);
      return 0;
    }
    return Math.ceil((until - now) / 1000);
  }

  recordFailure(key: string, limit: number, windowMs: number, now = Date.now()): number {
    const bucket = this.buckets.get(`fail:${key}`);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(`fail:${key}`, { count: 1, resetAt: now + windowMs });
      return 0;
    }
    bucket.count += 1;
    if (bucket.count >= limit) {
      this.locks.set(key, now + windowMs);
      return Math.ceil(windowMs / 1000);
    }
    return 0;
  }

  clear(key: string): void {
    this.buckets.delete(key);
    this.buckets.delete(`fail:${key}`);
    this.locks.delete(key);
  }

  reset(): void {
    this.buckets.clear();
    this.locks.clear();
  }
}
