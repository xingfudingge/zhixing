import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { errors } from '../errors.ts';
import { requireAdmin } from '../services/auth-service.ts';
import {
  createPairingCode,
  listDevices,
  pairDevice,
  refreshDevice,
  revokeDevice,
} from '../services/device-service.ts';
import { parseWith } from './validation.ts';

const pairCodeSchema = z.object({
  label: z.string().trim().max(80).optional(),
});

const pairSchema = z.object({
  code: z.string().min(4).max(64),
  name: z.string().trim().min(1).max(80),
  platform: z.enum(['macos', 'windows', 'linux', 'ios', 'android', 'web']),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(512),
});

function clientIp(request: FastifyRequest): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

export function registerDeviceRoutes(app: FastifyInstance): void {
  app.post('/devices/pair-code', async (request) => {
    await requireAdmin(request, app.zx.pool);
    const gate = app.zx.limiter.hit('pair-code', 60, 60 * 1000);
    if (!gate.allowed) {
      throw errors.tooManyRequests('生成配对码过于频繁', gate.retryAfterSeconds);
    }
    const body = parseWith(pairCodeSchema, request.body ?? {});
    const pairing = await createPairingCode(
      app.zx.pool,
      app.zx.config,
      body.label ?? '桌面设备',
    );
    return {
      ok: true,
      code: pairing.code,
      label: pairing.label,
      expiresAt: pairing.expiresAt.toISOString(),
      ttlSeconds: app.zx.config.pairingTtlSeconds,
      serverTime: new Date().toISOString(),
    };
  });

  app.post('/devices/pair', async (request) => {
    const ip = clientIp(request);
    const gate = app.zx.limiter.hit(`pair:${ip}`, 12, 10 * 60 * 1000);
    if (!gate.allowed) {
      throw errors.tooManyRequests('配对尝试过于频繁', gate.retryAfterSeconds);
    }
    const body = parseWith(pairSchema, request.body);
    const paired = await pairDevice(app.zx.pool, app.zx.config, body);
    return {
      ok: true,
      deviceId: paired.deviceId,
      deviceName: paired.deviceName,
      deviceToken: paired.deviceToken,
      refreshToken: paired.refreshToken,
      accessExpiresAt: paired.accessExpiresAt.toISOString(),
      refreshExpiresAt: paired.refreshExpiresAt.toISOString(),
      features: paired.features,
      serverTime: new Date().toISOString(),
      apiVersion: '1',
    };
  });

  app.post('/devices/refresh', async (request) => {
    const ip = clientIp(request);
    const gate = app.zx.limiter.hit(`refresh:${ip}`, 60, 10 * 60 * 1000);
    if (!gate.allowed) {
      throw errors.tooManyRequests('刷新令牌过于频繁', gate.retryAfterSeconds);
    }
    const body = parseWith(refreshSchema, request.body);
    const refreshed = await refreshDevice(app.zx.pool, app.zx.config, body.refreshToken);
    return {
      ok: true,
      deviceToken: refreshed.deviceToken,
      refreshToken: refreshed.refreshToken,
      accessExpiresAt: refreshed.accessExpiresAt.toISOString(),
      refreshExpiresAt: refreshed.refreshExpiresAt.toISOString(),
      serverTime: new Date().toISOString(),
    };
  });

  app.get('/devices', async (request) => {
    await requireAdmin(request, app.zx.pool);
    return {
      ok: true,
      devices: await listDevices(app.zx.pool),
      serverTime: new Date().toISOString(),
    };
  });

  app.delete<{ Params: { id: string } }>('/devices/:id', async (request) => {
    await requireAdmin(request, app.zx.pool);
    const device = await revokeDevice(app.zx.pool, request.params.id);
    return { ok: true, device, serverTime: new Date().toISOString() };
  });
}
