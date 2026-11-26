import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    // jsdom 29 默认 about:blank，opaque origin 下没有 localStorage；
    // 外壳外观偏好与 App 路由测试需要稳定的同源地址。
    environmentOptions: {
      jsdom: { url: 'http://localhost/' },
    },
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // 知识页/画板的重型 jsdom 用例在并行时会超过默认 5s；统一给 15s，
    // 避免把环境抖动误判为产品回归（单测仍会在真实失败时报错）。
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
