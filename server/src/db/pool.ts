import pg from 'pg';

import type { AppConfig } from '../config.ts';

const { Pool } = pg;

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;

export function createPool(config: AppConfig): DbPool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'zhixing-server',
    statement_timeout: 20_000,
  });
  pool.on('error', (error) => {
    // 空闲连接被数据库断开时不要让进程崩溃。
    console.error('[db] idle client error', error);
  });
  return pool;
}
