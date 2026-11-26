import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * P2-04 端到端流程（jsdom）。
 *
 * 当前仓库没有 Playwright/Tauri 测试驱动；这里用真实 React 组件 + 内存
 * 数据源/写入目标跑通「导出 ZIP → 解析校验 → 冲突预览 → 确认恢复」与
 * 键盘焦点/Esc，不依赖真实窗口。真实 Tauri IPC 仍由 test:rust 与手工验收覆盖。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost/' },
    },
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    include: ['src/**/*.e2e.tsx'],
    testTimeout: 30_000,
  },
});
