import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/*
 * Node 26 自带一个未启用的全局 localStorage（只有传 --localstorage-file
 * 才有值）。Vitest 的 jsdom 环境在 populateGlobal 时会跳过已经存在于
 * global 上的键，导致 `window.localStorage` 为 undefined。这里把 jsdom
 * 自己实现、带同源 storage 的对象接回全局，保持测试与浏览器一致。
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
