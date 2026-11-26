import { loadConfig } from '../config.ts';
import { createPool } from './pool.ts';
import { runMigrations } from './migrate.ts';

const config = loadConfig();
const pool = createPool(config);

try {
  const result = await runMigrations(pool);
  console.log(
    JSON.stringify(
      {
        ok: true,
        applied: result.applied,
        alreadyApplied: result.alreadyApplied,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error('[migrate] 失败:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
