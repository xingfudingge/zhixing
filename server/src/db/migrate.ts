import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { DbPool } from './pool.ts';

const MIGRATION_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export type MigrationResult = {
  applied: string[];
  alreadyApplied: string[];
};

/**
 * 顺序执行 SQL migration。用 PostgreSQL advisory lock 防止多实例同时迁移。
 * 每个文件在独立事务中执行，失败回滚且不记录版本。
 */
export async function runMigrations(pool: DbPool): Promise<MigrationResult> {
  const files = (await readdir(MIGRATION_DIR))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  try {
    await client.query(`SELECT pg_advisory_lock(807878701)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const existing = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    );
    const done = new Set(existing.rows.map((row) => row.name));

    for (const file of files) {
      if (done.has(file)) {
        alreadyApplied.push(file);
        continue;
      }
      const sql = await readFile(`${MIGRATION_DIR}${file}`, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(807878701)').catch(() => undefined);
    client.release();
  }

  return { applied, alreadyApplied };
}
