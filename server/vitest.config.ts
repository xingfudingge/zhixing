import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', '../packages/shared/test/**/*.test.ts'],
    // 集成测试共享一个 PostgreSQL 数据库，串行执行避免相互清理。
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
