import pg from 'pg';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { StorageService } from '../../src/services/storage.ts';

const { Pool } = pg;

export const TEST_DATABASE_URL =
  process.env.ZX_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';

export const integrationEnabled = Boolean(TEST_DATABASE_URL);

export type TestContext = {
  app: FastifyInstance;
  pool: pg.Pool;
  config: AppConfig;
  adminToken: string;
  setup(): Promise<string>;
  reset(): Promise<void>;
};

export function testConfig(): AppConfig {
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    ZX_SETUP_TOKEN: 'test-setup-token',
    ZX_SETUP_ALLOW_REMOTE: 'true',
    ZX_PAIRING_TTL: '600',
    ZX_S3_ENDPOINT: 'http://127.0.0.1:19000',
    ZX_S3_BUCKET: 'zhixing-test',
    ZX_S3_ACCESS_KEY: 'test-key',
    ZX_S3_SECRET_KEY: 'test-secret',
    ZX_S3_AUTO_CREATE_BUCKET: 'false',
    ZX_LOG_LEVEL: 'silent',
  });
}

export async function createTestContext(): Promise<TestContext> {
  const config = testConfig();
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  await runMigrations(pool);
  const storage = new StorageService(config.storage);
  const app = await buildApp({ config, pool, storage });

  const reset = async (): Promise<void> => {
    app.zx.limiter.reset();
    await pool.query(`
      TRUNCATE TABLE
        conflicts, sync_ops, sync_entities, device_sync_state,
        attachments, devices, pairing_codes, admin_sessions
      RESTART IDENTITY CASCADE
    `);
    await pool.query(
      `UPDATE deployment
          SET passphrase_hash = NULL,
              passphrase_salt = NULL,
              passphrase_scheme = NULL,
              initialized_at = NULL,
              name = '知行',
              updated_at = now()
        WHERE id = 'default'`,
    );
  };

  const setup = async (): Promise<string> => {
    await reset();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: {
        setupToken: 'test-setup-token',
        passphrase: 'test-passphrase-123',
        name: '测试部署',
      },
      remoteAddress: '127.0.0.1',
    });
    if (response.statusCode !== 200) {
      throw new Error(`setup failed: ${response.statusCode} ${response.body}`);
    }
    const body = response.json() as { adminToken: string };
    return body.adminToken;
  };

  const adminToken = await setup();

  return { app, pool, config, adminToken, setup, reset };
}

export type PairedTestDevice = {
  id: string;
  token: string;
  refreshToken: string;
  name: string;
};

export async function pairTestDevice(
  app: FastifyInstance,
  adminToken: string,
  name: string,
  platform: 'macos' | 'windows' | 'linux' | 'web' = 'macos',
): Promise<PairedTestDevice> {
  const codeResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/devices/pair-code',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { label: name },
  });
  if (codeResponse.statusCode !== 200) {
    throw new Error(`pair-code failed: ${codeResponse.statusCode} ${codeResponse.body}`);
  }
  const code = (codeResponse.json() as { code: string }).code;
  const pairResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/devices/pair',
    payload: { code, name, platform },
  });
  if (pairResponse.statusCode !== 200) {
    throw new Error(`pair failed: ${pairResponse.statusCode} ${pairResponse.body}`);
  }
  const paired = pairResponse.json() as {
    deviceId: string;
    deviceToken: string;
    refreshToken: string;
  };
  return {
    id: paired.deviceId,
    token: paired.deviceToken,
    refreshToken: paired.refreshToken,
    name,
  };
}

export function deviceHeaders(device: PairedTestDevice): Record<string, string> {
  return {
    'x-zx-device': device.id,
    authorization: `Bearer ${device.token}`,
  };
}

export type TestOpOverrides = {
  op_id?: string;
  entity_type?: string;
  entity_id?: string;
  op_type?: 'upsert' | 'patch' | 'delete' | 'yupdate';
  ms?: number;
  c?: number;
  base_vv?: Record<string, number>;
  payload?: Record<string, unknown>;
  space_id?: string;
};

export function makeOp(device: PairedTestDevice, overrides: TestOpOverrides = {}) {
  return {
    op_id: overrides.op_id ?? `op-${Math.random().toString(36).slice(2, 12)}`,
    space_id: overrides.space_id ?? 'personal',
    device_id: device.id,
    entity_type: overrides.entity_type ?? 'task',
    entity_id: overrides.entity_id ?? 'task-1',
    op_type: overrides.op_type ?? 'upsert',
    hlc: {
      ms: overrides.ms ?? Date.now(),
      c: overrides.c ?? 0,
      d: device.id,
    },
    base_vv: overrides.base_vv ?? {},
    payload: overrides.payload ?? {},
    created_at: new Date().toISOString(),
  };
}
