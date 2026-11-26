import type { FastifyInstance } from 'fastify';

import { deploymentInitialized, getDeployment } from '../services/auth-service.ts';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health', async (request, reply) => {
    const started = performance.now();
    let databaseOk = false;
    let databaseError: string | null = null;
    try {
      await app.zx.pool.query('SELECT 1');
      databaseOk = true;
    } catch (error) {
      databaseError = (error as Error).message;
    }

    let initialized = false;
    if (databaseOk) {
      try {
        initialized = deploymentInitialized(await getDeployment(app.zx.pool));
      } catch {
        initialized = false;
      }
    }

    if (request.query && (request.query as { deep?: string }).deep === '1' && app.zx.storage.configured) {
      await app.zx.storage.health().catch(() => undefined);
    }

    const body = {
      ok: databaseOk,
      service: 'zhixing-server',
      apiVersion: '1',
      minClientVersion: '0.1.0',
      database: {
        ok: databaseOk,
        latencyMs: Number((performance.now() - started).toFixed(1)),
        error: databaseError,
      },
      storage: app.zx.storage.status(),
      initialized,
      features: {
        backendSync: true,
        webdav: false,
        attachments: true,
        realtime: false,
        search: false,
      },
      serverTime: new Date().toISOString(),
    };

    if (!databaseOk) {
      reply.code(503);
    }
    return body;
  });
}

export function registerDiscoveryRoutes(app: FastifyInstance): void {
  app.get('/.well-known/zhixing', async () => {
    const deployment = await getDeployment(app.zx.pool);
    return {
      name: deployment.name,
      apiVersion: '1',
      minClientVersion: '0.1.0',
      deploymentId: 'default',
      initialized: deploymentInitialized(deployment),
      features: {
        backendSync: true,
        webdav: false,
        attachments: true,
        realtime: false,
        search: false,
      },
      endpoints: {
        health: '/api/v1/health',
        pair: '/api/v1/devices/pair',
        sync: '/api/v1/sync',
      },
    };
  });
}
