/**
 * ZX-090 独立验收套件配置。
 *
 * 放在 tests/ 下，不修改产品代码。运行：
 *   pnpm --filter app exec vitest run --config ../tests/vitest.config.ts
 *
 * 这里不使用 @vitejs/plugin-react，只开启 esbuild 的 automatic JSX，
 * 避免测试目录额外安装依赖；产品源码的 React 从 app/node_modules 解析。
 * tests/ 自身没有 react 依赖，automatic JSX 需要显式把 react 运行时指到
 * app/node_modules，否则 jsx-dev-runtime 无法解析。
 */
import { fileURLToPath } from 'node:url';

const appModules = fileURLToPath(new URL('../app/node_modules/', import.meta.url));

export default {
  esbuild: { jsx: 'automatic' as const },
  resolve: {
    alias: [
      { find: /^react$/, replacement: `${appModules}react` },
      { find: /^react\/(.*)$/, replacement: `${appModules}react/$1` },
      { find: /^react-dom$/, replacement: `${appModules}react-dom` },
      { find: /^react-dom\/(.*)$/, replacement: `${appModules}react-dom/$1` },
    ],
  },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
    globals: true,
    setupFiles: ['./setup.ts'],
    css: true,
    include: ['**/*.test.ts', '**/*.test.tsx'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
};
