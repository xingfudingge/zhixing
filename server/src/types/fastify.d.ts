import type { AppConfig } from '../config.ts';
import type { DbPool } from '../db/pool.ts';
import type { DeviceRow } from '../db/rows.ts';
import type { RateLimiter } from '../security/rate-limit.ts';
import type { HlcClock } from '../../../packages/shared/src/index.ts';
import type { AttachmentService } from '../services/attachment-service.ts';
import type { StorageService } from '../services/storage.ts';
import type { SyncService } from '../services/sync-service.ts';

declare module 'fastify' {
  interface FastifyInstance {
    zx: {
      config: AppConfig;
      pool: DbPool;
      limiter: RateLimiter;
      storage: StorageService;
      sync: SyncService;
      attachments: AttachmentService;
      clock: HlcClock;
    };
  }

  interface FastifyRequest {
    device?: DeviceRow;
    adminSession?: { id: string; expiresAt: Date };
  }
}
