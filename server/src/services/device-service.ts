import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

import type { AppConfig } from '../config.ts';
import type { DbPool } from '../db/pool.ts';
import type { DeviceRow } from '../db/rows.ts';
import { errors } from '../errors.ts';
import { parseBearer } from './auth-service.ts';
import {
  generatePairingCode,
  hashToken,
  newDeviceId,
  newPairingCodeId,
  normalizePairingCode,
  pairingCodeHash,
  randomToken,
} from '../security/tokens.ts';

export const PLATFORMS = ['macos', 'windows', 'linux', 'ios', 'android', 'web'] as const;
export type Platform = (typeof PLATFORMS)[number];

const DEFAULT_FEATURES = { sync: true, attachments: true };

export type PairingCode = {
  id: string;
  code: string;
  label: string;
  expiresAt: Date;
};

export type PairedDevice = {
  deviceId: string;
  deviceName: string;
  deviceToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  features: Record<string, boolean>;
};

export type DeviceSummary = {
  id: string;
  name: string;
  platform: string;
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  features: Record<string, boolean>;
};

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export async function createPairingCode(
  pool: DbPool,
  config: AppConfig,
  label: string,
): Promise<PairingCode> {
  const id = newPairingCodeId();
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + config.pairingTtlSeconds * 1000);
  await pool.query(
    `INSERT INTO pairing_codes (id, code_hash, label, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [id, pairingCodeHash(code), label.trim().slice(0, 80), expiresAt],
  );
  return { id, code, label: label.trim().slice(0, 80), expiresAt };
}

export async function pairDevice(
  pool: DbPool,
  config: AppConfig,
  input: { code: string; name: string; platform: Platform },
): Promise<PairedDevice> {
  const normalized = normalizePairingCode(input.code);
  if (normalized.length < 6) {
    throw errors.unauthorized('配对码无效或已过期', 'PAIRING_CODE_INVALID');
  }
  const deviceName = input.name.trim().slice(0, 80);
  if (!deviceName) throw errors.badRequest('设备名称不能为空');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const codeResult = await client.query<{
      id: string;
      used_at: Date | null;
      expires_at: Date;
    }>(
      `SELECT id, used_at, expires_at
       FROM pairing_codes
       WHERE code_hash = $1
       FOR UPDATE`,
      [pairingCodeHash(normalized)],
    );
    const pairing = codeResult.rows[0];
    if (!pairing) {
      throw errors.unauthorized('配对码无效或已过期', 'PAIRING_CODE_INVALID');
    }
    if (pairing.used_at) {
      throw errors.conflict('配对码已被使用，请重新生成', 'PAIRING_CODE_USED');
    }
    if (pairing.expires_at.getTime() <= Date.now()) {
      throw errors.unauthorized('配对码已过期', 'PAIRING_CODE_EXPIRED');
    }

    const countResult = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM devices WHERE revoked_at IS NULL',
    );
    if (Number(countResult.rows[0]?.count ?? 0) >= config.maxDevices) {
      throw errors.conflict(
        '设备数量达到本部署上限；请先在设备页撤销不用的设备',
        'DEVICE_LIMIT_REACHED',
      );
    }

    const deviceId = newDeviceId();
    const deviceToken = randomToken('zxdt', 32);
    const refreshToken = randomToken('zxrt', 48);
    const accessExpiresAt = new Date(Date.now() + config.accessTtlSeconds * 1000);
    const refreshExpiresAt = new Date(Date.now() + config.refreshTtlSeconds * 1000);

    await client.query(
      `INSERT INTO devices
         (id, name, platform, token_hash, refresh_token_hash,
          access_expires_at, refresh_expires_at, features, pairing_code_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        deviceId,
        deviceName,
        input.platform,
        hashToken(deviceToken),
        hashToken(refreshToken),
        accessExpiresAt,
        refreshExpiresAt,
        JSON.stringify(DEFAULT_FEATURES),
        pairing.id,
      ],
    );
    await client.query(
      `INSERT INTO device_sync_state (device_id) VALUES ($1)`,
      [deviceId],
    );
    await client.query(
      `UPDATE pairing_codes
         SET used_at = now(), used_by_device_id = $1
       WHERE id = $2`,
      [deviceId, pairing.id],
    );
    await client.query('COMMIT');

    return {
      deviceId,
      deviceName,
      deviceToken,
      refreshToken,
      accessExpiresAt,
      refreshExpiresAt,
      features: DEFAULT_FEATURES,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateDevice(
  request: FastifyRequest,
  pool: DbPool,
): Promise<DeviceRow> {
  const deviceId = request.headers['x-zx-device'];
  const token = parseBearer(request.headers.authorization);
  if (typeof deviceId !== 'string' || !deviceId || !token) {
    throw errors.unauthorized('缺少设备 ID 或设备令牌', 'DEVICE_AUTH_REQUIRED');
  }

  const result = await pool.query<DeviceRow>(
    'SELECT * FROM devices WHERE id = $1',
    [deviceId],
  );
  const device = result.rows[0];
  if (!device) throw errors.unauthorized('设备不存在', 'DEVICE_UNKNOWN');
  if (device.revoked_at) {
    throw errors.unauthorized('设备已被撤销，请重新配对', 'DEVICE_REVOKED');
  }
  if (!safeEqualHex(device.token_hash, hashToken(token))) {
    throw errors.unauthorized('设备令牌无效', 'DEVICE_TOKEN_INVALID');
  }
  if (device.access_expires_at.getTime() <= Date.now()) {
    throw errors.unauthorized('设备令牌已过期，请刷新', 'DEVICE_TOKEN_EXPIRED');
  }

  const now = new Date();
  await pool.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [deviceId]);
  return { ...device, last_seen_at: now };
}

export async function refreshDevice(
  pool: DbPool,
  config: AppConfig,
  refreshToken: string,
): Promise<{
  deviceToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}> {
  if (typeof refreshToken !== 'string' || refreshToken.length < 20) {
    throw errors.unauthorized('刷新令牌无效', 'REFRESH_TOKEN_INVALID');
  }
  const result = await pool.query<DeviceRow>(
    'SELECT * FROM devices WHERE refresh_token_hash = $1',
    [hashToken(refreshToken)],
  );
  const device = result.rows[0];
  if (!device) throw errors.unauthorized('刷新令牌无效', 'REFRESH_TOKEN_INVALID');
  if (device.revoked_at) {
    throw errors.unauthorized('设备已被撤销，请重新配对', 'DEVICE_REVOKED');
  }
  if (device.refresh_expires_at.getTime() <= Date.now()) {
    throw errors.unauthorized('刷新令牌已过期，请重新配对', 'REFRESH_TOKEN_EXPIRED');
  }

  const deviceToken = randomToken('zxdt', 32);
  const nextRefreshToken = randomToken('zxrt', 48);
  const accessExpiresAt = new Date(Date.now() + config.accessTtlSeconds * 1000);
  const refreshExpiresAt = new Date(Date.now() + config.refreshTtlSeconds * 1000);

  await pool.query(
    `UPDATE devices
        SET token_hash = $1,
            refresh_token_hash = $2,
            access_expires_at = $3,
            refresh_expires_at = $4
      WHERE id = $5`,
    [
      hashToken(deviceToken),
      hashToken(nextRefreshToken),
      accessExpiresAt,
      refreshExpiresAt,
      device.id,
    ],
  );

  return { deviceToken, refreshToken: nextRefreshToken, accessExpiresAt, refreshExpiresAt };
}

export function toDeviceSummary(row: DeviceRow): DeviceSummary {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    pairedAt: row.paired_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    accessExpiresAt: row.access_expires_at.toISOString(),
    refreshExpiresAt: row.refresh_expires_at.toISOString(),
    features: row.features ?? {},
  };
}

export async function listDevices(pool: DbPool): Promise<DeviceSummary[]> {
  const result = await pool.query<DeviceRow>(
    'SELECT * FROM devices ORDER BY paired_at DESC',
  );
  return result.rows.map(toDeviceSummary);
}

export async function revokeDevice(
  pool: DbPool,
  deviceId: string,
): Promise<DeviceSummary> {
  const result = await pool.query<DeviceRow>(
    `UPDATE devices
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1
      RETURNING *`,
    [deviceId],
  );
  const device = result.rows[0];
  if (!device) throw errors.notFound('设备不存在', 'DEVICE_NOT_FOUND');
  return toDeviceSummary(device);
}
