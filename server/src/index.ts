import { loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { runMigrations } from './db/migrate.ts';
import { buildApp } from './app.ts';
import { StorageService } from './services/storage.ts';

const config = loadConfig();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase(pool: ReturnType<typeof createPool>): Promise<void> {
  const attempts = 30;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      console.log(`[db] 等待数据库就绪 ${attempt}/${attempts}`);
      await sleep(1000);
    }
  }
}

async function ensureBucket(storage: StorageService): Promise<void> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      await storage.ensureBucket();
      console.log(`[storage] bucket 就绪: ${storage.config.bucket}`);
      return;
    } catch (error) {
      if (attempt === 60) {
        console.warn('[storage] bucket 初始化失败，附件接口将返回 503:', (error as Error).message);
        return;
      }
      await sleep(1000);
    }
  }
}

const pool = createPool(config);

try {
  await waitForDatabase(pool);
  const migration = await runMigrations(pool);
  console.log(
    `[db] migration 完成（执行 ${migration.applied.length} 个，已存在 ${migration.alreadyApplied.length} 个）`,
  );

  const storage = new StorageService(config.storage);
  if (config.storage.enabled && config.storage.autoCreateBucket) {
    await ensureBucket(storage);
  }
  if (!config.storage.enabled) {
    console.warn('[storage] 未配置 MinIO/S3，附件接口将返回 503');
  }

  const app = await buildApp({ config, pool, storage });
  await app.listen({ port: config.port, host: config.host });

  console.log(`[server] 知行后台已启动: http://${config.host}:${config.port}`);
  console.log(`[server] 健康检查: http://localhost:${config.port}/api/v1/health`);
  if (config.setupTokenGenerated) {
    console.log('='.repeat(72));
    console.log('[setup] 首次初始化 token（仅本次启动生成，请立即使用）:');
    console.log(`        ${config.setupToken}`);
    console.log('        POST /api/v1/setup {"setupToken":"...","passphrase":"..."}');
    console.log('='.repeat(72));
  }
  if (config.setupAllowRemote) {
    console.warn('[setup] ZX_SETUP_ALLOW_REMOTE=true：初始化接口允许非本机访问，请勿暴露到公网');
  }

  const shutdown = async (signal: string) => {
    console.log(`[server] 收到 ${signal}，正在关闭…`);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
} catch (error) {
  console.error('[server] 启动失败:', error);
  await pool.end().catch(() => undefined);
  process.exit(1);
}
