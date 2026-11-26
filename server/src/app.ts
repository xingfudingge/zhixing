import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { HlcClock, uuidv7 } from '../../packages/shared/src/index.ts';
import type { AppConfig } from './config.ts';
import { createPool, type DbPool } from './db/pool.ts';
import { ApiError } from './errors.ts';
import { RateLimiter } from './security/rate-limit.ts';
import { AttachmentService } from './services/attachment-service.ts';
import { StorageService } from './services/storage.ts';
import { SyncService } from './services/sync-service.ts';
import { registerAttachmentRoutes } from './routes/attachments.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerDeviceRoutes } from './routes/devices.ts';
import { registerDiscoveryRoutes, registerHealthRoutes } from './routes/health.ts';
import { registerSyncRoutes } from './routes/sync.ts';

export type BuildAppOptions = {
  config: AppConfig;
  pool?: DbPool;
  storage?: StorageService;
  clock?: HlcClock;
};

function corsOrigin(config: AppConfig, request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  if (!origin) return null;
  return config.corsOrigins.includes(origin) ? origin : null;
}

/**
 * 组装 Fastify 应用。测试直接传 pg.Pool 与 test config，生产由 index.ts 注入。
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const ownsPool = !options.pool;
  const pool = options.pool ?? createPool(config);
  const storage = options.storage ?? new StorageService(config.storage);
  const clock = options.clock ?? new HlcClock('server');
  const sync = new SyncService(pool, storage, clock);
  const attachments = new AttachmentService(pool, storage);
  const limiter = new RateLimiter();

  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
            ],
          },
    bodyLimit: 8 * 1024 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 30_000,
    trustProxy: config.trustProxy,
    genReqId: () => uuidv7(),
  });

  app.decorate('zx', {
    config,
    pool,
    limiter,
    storage,
    sync,
    attachments,
    clock,
  });

  app.addHook('onRequest', async (request, reply) => {
    const origin = corsOrigin(config, request);
    if (origin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      reply.header(
        'access-control-allow-headers',
        'Authorization,Content-Type,X-ZX-Device,X-ZX-CSRF,X-Request-Id',
      );
      reply.header('access-control-max-age', '600');
      reply.code(204).send();
      return reply;
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (request.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
    }
    reply.header('x-request-id', request.id);
    return payload;
  });

  app.register(async (api) => {
    registerHealthRoutes(api);
    registerAuthRoutes(api);
    registerDeviceRoutes(api);
    registerSyncRoutes(api);
    registerAttachmentRoutes(api);
  }, { prefix: '/api/v1' });

  registerDiscoveryRoutes(app);

  app.get('/', async () => ({
    name: '知行后台同步服务',
    apiVersion: '1',
    health: '/api/v1/health',
    discovery: '/.well-known/zhixing',
    mode: 'single-user-device-pairing',
  }));

  app.setNotFoundHandler(async (request, reply) => {
    reply.code(404);
    return {
      error: {
        code: 'NOT_FOUND',
        message: `未找到 ${request.method} ${request.url}`,
      },
    };
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.statusCode);
      return {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      };
    }

    const fastifyError = error as Error & {
      statusCode?: number;
      code?: string;
      validation?: unknown;
    };
    if (fastifyError.validation) {
      reply.code(400);
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: '请求参数不合法',
          details: fastifyError.validation,
        },
      };
    }
    if (fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reply.code(413);
      return {
        error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' },
      };
    }
    if (fastifyError.statusCode === 400) {
      reply.code(400);
      return {
        error: {
          code: 'BAD_REQUEST',
          message: fastifyError.message || '请求体不合法',
        },
      };
    }
    if (fastifyError.code === '23505') {
      reply.code(409);
      return {
        error: { code: 'CONFLICT', message: '唯一约束冲突' },
      };
    }

    request.log.error({ err: error }, 'unhandled request error');
    reply.code(fastifyError.statusCode && fastifyError.statusCode < 500 ? fastifyError.statusCode : 500);
    return {
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务器内部错误',
        requestId: request.id,
      },
    };
  });

  if (ownsPool) {
    app.addHook('onClose', async () => {
      await pool.end();
    });
  }

  return app;
}
