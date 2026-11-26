// 独立验收套件：用相对路径加载 app 已安装的测试依赖，避免 tests/ 再引一套 node_modules。
import '../app/node_modules/@testing-library/jest-dom/dist/vitest.mjs';

import { cleanup } from '../app/node_modules/@testing-library/react/dist/index.js';
import { afterEach } from 'vitest';

/*
 * Node 26 自带未启用的全局 localStorage；Vitest 的 jsdom 环境会跳过
 * 已存在的全局键。这里把 jsdom 的同源 storage 接回全局。
 */
const jsdomWindow = (
  globalThis as typeof globalThis & {
    jsdom?: { window?: Window & typeof globalThis };
  }
).jsdom?.window;

if (jsdomWindow?.localStorage) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: jsdomWindow.localStorage,
  });
}
if (jsdomWindow?.sessionStorage) {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: jsdomWindow.sessionStorage,
  });
}

afterEach(() => {
  cleanup();
});
