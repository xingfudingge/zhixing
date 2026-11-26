import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { errors } from '../errors.ts';
import { hashPassword, validatePassphrase, verifyPassword } from '../security/password.ts';
import { hashToken } from '../security/tokens.ts';
import {
  adminCookie,
  createAdminSession,
  deploymentInitialized,
  getDeployment,
  isLoopbackIp,
  parseBearer,
  parseCookie,
  requireAdmin,
} from '../services/auth-service.ts';
import { parseWith } from './validation.ts';

const setupSchema = z.object({
  setupToken: z.string().min(1).max(256),
  passphrase: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(80).optional(),
});

const loginSchema = z.object({
  passphrase: z.string().min(1).max(200),
});

function safeEqualString(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

function clientIp(request: FastifyRequest): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/setup', async (request, reply) => {
    const ip = clientIp(request);
    const gate = app.zx.limiter.hit(`setup:${ip}`, 10, 10 * 60 * 1000);
    if (!gate.allowed) {
      throw errors.tooManyRequests('初始化尝试过于频繁', gate.retryAfterSeconds);
    }
    if (!app.zx.config.setupAllowRemote && !isLoopbackIp(request.ip)) {
      throw errors.forbidden(
        '首次初始化只允许服务器本机访问；如确需远程，请显式设置 ZX_SETUP_ALLOW_REMOTE=true',
        'SETUP_LOCAL_ONLY',
      );
    }

    const body = parseWith(setupSchema, request.body);
    if (!safeEqualString(body.setupToken, app.zx.config.setupToken)) {
      throw errors.unauthorized('setup token 无效', 'SETUP_TOKEN_INVALID');
    }

    const deployment = await getDeployment(app.zx.pool);
    if (deploymentInitialized(deployment)) {
      throw errors.conflict('部署已初始化，setup 已永久关闭', 'ALREADY_INITIALIZED');
    }

    let passphrase: string;
    try {
      passphrase = validatePassphrase(body.passphrase);
    } catch (error) {
      throw errors.badRequest((error as Error).message);
    }
    const password = await hashPassword(passphrase);

    const updated = await app.zx.pool.query(
      `UPDATE deployment
          SET name = COALESCE($1, name),
              passphrase_hash = $2,
              passphrase_salt = $3,
              passphrase_scheme = $4,
              initialized_at = now(),
              updated_at = now()
        WHERE id = 'default' AND initialized_at IS NULL
        RETURNING id, name, initialized_at`,
      [body.name ?? null, password.hash, password.salt, password.scheme],
    );
    if (!updated.rows[0]) {
      throw errors.conflict('部署已初始化，setup 已永久关闭', 'ALREADY_INITIALIZED');
    }

    const session = await createAdminSession(
      app.zx.pool,
      app.zx.config.adminSessionTtlSeconds,
    );
    reply.header(
      'set-cookie',
      adminCookie(session, app.zx.config, request.protocol === 'https'),
    );
    return {
      ok: true,
      adminToken: session.token,
      adminExpiresAt: session.expiresAt.toISOString(),
      deployment: { id: 'default', name: updated.rows[0].name },
      serverTime: new Date().toISOString(),
    };
  });

  app.post('/auth/login', async (request, reply) => {
    const ip = clientIp(request);
    const lockSeconds = app.zx.limiter.isLocked(`login:${ip}`);
    if (lockSeconds > 0) {
      throw errors.tooManyRequests('登录失败次数过多，请稍后再试', lockSeconds);
    }
    const gate = app.zx.limiter.hit(`login-ip:${ip}`, 30, 15 * 60 * 1000);
    if (!gate.allowed) {
      throw errors.tooManyRequests('登录尝试过于频繁', gate.retryAfterSeconds);
    }

    const body = parseWith(loginSchema, request.body);
    const deployment = await getDeployment(app.zx.pool);
    if (!deploymentInitialized(deployment)) {
      throw errors.conflict('部署尚未初始化', 'SETUP_REQUIRED');
    }

    const valid = await verifyPassword(body.passphrase, {
      hash: deployment.passphrase_hash,
      salt: deployment.passphrase_salt,
    });
    if (!valid) {
      const locked = app.zx.limiter.recordFailure(`login:${ip}`, 5, 15 * 60 * 1000);
      if (locked > 0) {
        throw errors.tooManyRequests('登录失败次数过多，已锁定 15 分钟', locked);
      }
      throw errors.unauthorized('管理口令错误', 'PASSPHRASE_INVALID');
    }

    app.zx.limiter.clear(`login:${ip}`);
    const session = await createAdminSession(
      app.zx.pool,
      app.zx.config.adminSessionTtlSeconds,
    );
    reply.header(
      'set-cookie',
      adminCookie(session, app.zx.config, request.protocol === 'https'),
    );
    return {
      ok: true,
      adminToken: session.token,
      adminExpiresAt: session.expiresAt.toISOString(),
      serverTime: new Date().toISOString(),
    };
  });

  app.post('/auth/logout', async (request, reply) => {
    const token =
      parseBearer(request.headers.authorization) ??
      parseCookie(request.headers.cookie, 'zx_session');
    if (token) {
      await app.zx.pool.query(
        'UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1',
        [hashToken(token)],
      );
    }
    reply.header('set-cookie', 'zx_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    return { ok: true };
  });

  app.get('/auth/status', async (request) => {
    const session = await requireAdmin(request, app.zx.pool);
    const deployment = await getDeployment(app.zx.pool);
    return {
      ok: true,
      initialized: deploymentInitialized(deployment),
      deployment: { id: 'default', name: deployment.name },
      session: { id: session.id, expiresAt: session.expires_at.toISOString() },
      serverTime: new Date().toISOString(),
    };
  });
}
