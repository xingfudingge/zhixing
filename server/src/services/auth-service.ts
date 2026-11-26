import type { FastifyRequest } from 'fastify';

import type { AppConfig } from '../config.ts';
import type { AdminSessionRow, DeploymentRow } from '../db/rows.ts';
import type { DbPool } from '../db/pool.ts';
import { errors } from '../errors.ts';
import { hashToken, newSessionId, randomToken } from '../security/tokens.ts';

export type AdminSession = {
  id: string;
  token: string;
  expiresAt: Date;
};

export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function getDeployment(pool: DbPool): Promise<DeploymentRow> {
  const result = await pool.query<DeploymentRow>(
    "SELECT * FROM deployment WHERE id = 'default'",
  );
  const row = result.rows[0];
  if (!row) throw new Error('deployment 单例行缺失，请先执行 migration');
  return row;
}

export function deploymentInitialized(row: DeploymentRow): boolean {
  return row.initialized_at !== null && Boolean(row.passphrase_hash);
}

export async function createAdminSession(
  pool: DbPool,
  ttlSeconds: number,
): Promise<AdminSession> {
  const token = randomToken('zxas', 32);
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await pool.query(
    `INSERT INTO admin_sessions (id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [id, hashToken(token), expiresAt],
  );
  return { id, token, expiresAt };
}

export async function findAdminSession(
  pool: DbPool,
  token: string,
): Promise<AdminSessionRow | null> {
  const result = await pool.query<AdminSessionRow>(
    `SELECT * FROM admin_sessions
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND expires_at > now()`,
    [hashToken(token)],
  );
  return result.rows[0] ?? null;
}

function requestUsesCookie(request: FastifyRequest): boolean {
  return !parseBearer(request.headers.authorization);
}

/**
 * 管理员认证：
 * - Bearer token 适用于 API/CLI；
 * - HttpOnly Cookie 适用于 Web，写请求额外要求 X-ZX-CSRF: 1（SameSite=Strict 之外的第二道闸）。
 */
export async function requireAdmin(
  request: FastifyRequest,
  pool: DbPool,
): Promise<AdminSessionRow> {
  const bearer = parseBearer(request.headers.authorization);
  const cookieToken = parseCookie(request.headers.cookie, 'zx_session');
  const token = bearer ?? cookieToken;
  if (!token) throw errors.unauthorized('缺少管理员会话', 'ADMIN_REQUIRED');

  if (
    requestUsesCookie(request) &&
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
    request.headers['x-zx-csrf'] !== '1'
  ) {
    throw errors.forbidden('Cookie 写请求缺少 X-ZX-CSRF 头', 'CSRF_REQUIRED');
  }

  const session = await findAdminSession(pool, token);
  if (!session) throw errors.unauthorized('管理员会话无效或已过期', 'ADMIN_SESSION_INVALID');

  await pool
    .query('UPDATE admin_sessions SET last_seen_at = now() WHERE id = $1', [session.id])
    .catch(() => undefined);
  return session;
}

export function adminCookie(
  session: AdminSession,
  config: AppConfig,
  secure: boolean,
): string {
  const maxAge = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
  const parts = [
    `zx_session=${encodeURIComponent(session.token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (secure || config.nodeEnv === 'production') parts.push('Secure');
  return parts.join('; ');
}

export function isLoopbackIp(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return (
    normalized === '::1' ||
    normalized === 'localhost' ||
    normalized.startsWith('127.')
  );
}
