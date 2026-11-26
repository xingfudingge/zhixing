import { randomBytes } from 'node:crypto';

export type StorageConfig = {
  enabled: boolean;
  endpoint: string;
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
  autoCreateBucket: boolean;
};

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databaseUrl: string;
  setupToken: string;
  setupTokenGenerated: boolean;
  setupAllowRemote: boolean;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  pairingTtlSeconds: number;
  adminSessionTtlSeconds: number;
  maxDevices: number;
  trustProxy: boolean;
  corsOrigins: string[];
  publicUrl: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  storage: StorageConfig;
};

function intFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv =
    env.NODE_ENV === 'production'
      ? 'production'
      : env.NODE_ENV === 'test'
        ? 'test'
        : 'development';

  const configuredSetupToken = env.ZX_SETUP_TOKEN?.trim();
  const setupToken = configuredSetupToken || randomBytes(24).toString('base64url');
  const port = intFromEnv(env.PORT, 8787);

  return {
    nodeEnv,
    port,
    host: env.HOST?.trim() || '0.0.0.0',
    databaseUrl:
      env.DATABASE_URL?.trim() ||
      'postgres://zhixing:zhixing@localhost:5432/zhixing',
    setupToken,
    setupTokenGenerated: !configuredSetupToken,
    setupAllowRemote: boolFromEnv(env.ZX_SETUP_ALLOW_REMOTE, false),
    accessTtlSeconds: intFromEnv(env.ZX_ACCESS_TTL, 24 * 60 * 60),
    refreshTtlSeconds: intFromEnv(env.ZX_REFRESH_TTL, 30 * 24 * 60 * 60),
    pairingTtlSeconds: intFromEnv(env.ZX_PAIRING_TTL, 10 * 60),
    adminSessionTtlSeconds: intFromEnv(env.ZX_ADMIN_SESSION_TTL, 12 * 60 * 60),
    maxDevices: intFromEnv(env.ZX_MAX_DEVICES, 20),
    trustProxy: boolFromEnv(env.ZX_TRUST_PROXY, false),
    corsOrigins: (env.ZX_CORS_ORIGINS ??
      'http://localhost:5173,http://127.0.0.1:5173,http://tauri.localhost,tauri://localhost')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    publicUrl: env.ZX_PUBLIC_URL?.trim() || `http://localhost:${port}`,
    logLevel: (env.ZX_LOG_LEVEL?.trim() as AppConfig['logLevel']) || 'info',
    storage: {
      enabled: Boolean(env.ZX_S3_ENDPOINT || env.ZX_S3_BUCKET),
      endpoint: env.ZX_S3_ENDPOINT?.trim() || 'http://localhost:9000',
      publicEndpoint:
        env.ZX_S3_PUBLIC_ENDPOINT?.trim() ||
        env.ZX_S3_ENDPOINT?.trim() ||
        'http://localhost:9000',
      region: env.ZX_S3_REGION?.trim() || 'us-east-1',
      bucket: env.ZX_S3_BUCKET?.trim() || 'zhixing',
      accessKey: env.ZX_S3_ACCESS_KEY?.trim() || 'minioadmin',
      secretKey: env.ZX_S3_SECRET_KEY?.trim() || 'minioadmin',
      forcePathStyle: boolFromEnv(env.ZX_S3_FORCE_PATH_STYLE, true),
      autoCreateBucket: boolFromEnv(env.ZX_S3_AUTO_CREATE_BUCKET, false),
    },
  };
}
