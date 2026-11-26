/**
 * ZX12-FIX-ACTIVE-01 真实浏览器回归（Chromium + app/dist + IndexedDB）。
 *
 * 浏览器预览按 ZX12-FIX-304-01 的约束不直连远端，因此本脚本不复刻网络
 * 同步，只复刻 F2 的持久化前提：在真实 IndexedDB 中预置一条“自动回退后
 * active=chinese-days、偏好仍为 china-mainland-calendar”的真实缓存状态，
 * 再通过真实设置页验证：
 *   - 重新打开/刷新后“当前使用/回退情况”仍指向真实 active；
 *   - 清除当前源只删除 chinese-days，保留 holiday-cn 与偏好；
 *   - 清除后回退内置离线，刷新后仍保持；
 *   - 控制台零意外报错。
 *
 * 运行：pnpm --filter app build && node tests/e2e/zx12-fix-active-01-browser.mjs
 * 证据：tests/evidence/zx12-fix-active-01/browser/
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx12-fix-active-01/browser');
const PORT = 8898;
const DEBUG_PORT = 9228;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
fs.mkdirSync(EVIDENCE, { recursive: true });
for (const name of fs.readdirSync(EVIDENCE)) {
  if (/\.(png|json|txt|log)$/.test(name)) fs.rmSync(path.join(EVIDENCE, name));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);
  let file = path.join(DIST, pathname);
  if (
    !file.startsWith(DIST) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  ) {
    file = path.join(DIST, 'index.html');
  }
  response.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  response.end(fs.readFileSync(file));
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', resolve);
});

const userDataDir = `/tmp/zx12-fix-active-chrome-${Date.now()}`;
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-sync',
    '--mute-audio',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let chromeStderr = '';
chrome.stderr.on('data', (chunk) => {
  chromeStderr += String(chunk);
});

async function waitForDevtools() {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Chrome DevTools 未就绪\n${chromeStderr}`);
}

const target = await waitForDevtools();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let messageId = 0;
const pending = new Map();
const consoleErrors = [];
const pageExceptions = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
    return;
  }
  if (
    message.method === 'Runtime.consoleAPICalled' &&
    message.params.type === 'error'
  ) {
    consoleErrors.push(
      (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' '),
    );
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    pageExceptions.push(
      details.exception?.description ?? details.text ?? 'unknown',
    );
  }
  if (
    message.method === 'Log.entryAdded' &&
    message.params.entry.level === 'error'
  ) {
    consoleErrors.push(message.params.entry.text);
  }
});
function send(method, params = {}) {
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, 60_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        '页面执行失败',
    );
  }
  return result.result?.value;
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  fs.writeFileSync(
    path.join(EVIDENCE, `${name}.png`),
    Buffer.from(data, 'base64'),
  );
}
async function waitFor(expression, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(expression).catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`等待超时：${label}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
const failures = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures.push(`${name}：${JSON.stringify(detail).slice(0, 2200)}`);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Page.navigate', {
  url: `http://127.0.0.1:${PORT}/settings/calendar`,
});
await waitFor(
  `document.querySelector('h1')?.textContent?.trim() === '设置'`,
  '设置页',
);

// 页面内助手：只操作真实 DOM / IndexedDB，不 import 产品模块。
// 刷新会丢页面上下文，因此抽成字符串，每次加载后重新注入。
const INSTALL_HELPERS = `(() => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  };
  const byAria = (label) =>
    Array.from(document.querySelectorAll('[aria-label]')).find(
      (el) => el.getAttribute('aria-label') === label && visible(el),
    );
  const setNativeValue = (element, value, eventName) => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
      .set.call(element, value);
    element.dispatchEvent(new Event(eventName, { bubbles: true }));
  };
  const openHolidayDb = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open('zhixing-holiday', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('packages')) {
          db.createObjectStore('packages', { keyPath: 'cacheKey' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const readAll = async (storeName) => {
    const db = await openHolidayDb();
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows;
  };
  const readState = async () =>
    (await readAll('meta')).find((row) => row.id === 'state') ?? null;
  const setSource = (value) => {
    const select = byAria('节假日数据源');
    if (!select) throw new Error('找不到节假日数据源');
    setNativeValue(select, value, 'change');
  };
  const activeRow = () => {
    const row = Array.from(document.querySelectorAll('.settings-row')).find(
      (item) => norm(item.innerText).startsWith('当前使用'),
    );
    return norm(row?.innerText);
  };
  const fallbackRow = () => {
    const row = Array.from(document.querySelectorAll('.settings-row')).find(
      (item) => norm(item.innerText).startsWith('回退情况'),
    );
    return norm(row?.innerText);
  };
  const seedFallback = async () => {
    const priorFetch = '2026-11-01T12:00:00.000Z';
    const days = [
      { name: '元旦', date: '2026-01-01', isOffDay: true },
      { name: '元旦', date: '2026-01-02', isOffDay: true },
      { name: '元旦', date: '2026-01-03', isOffDay: true },
      { name: '国庆节', date: '2026-10-01', isOffDay: true },
      { name: '国庆节', date: '2026-10-02', isOffDay: true },
    ];
    const record = (sourceId, format) => ({
      cacheKey: sourceId + '|jsdelivr|2026',
      sourceId,
      transport: 'jsdelivr',
      format,
      year: 2026,
      package: {
        year: 2026,
        days,
        source: sourceId,
        version: sourceId + '-v1',
        origin: 'remote',
        fetchedAt: priorFetch,
        papers: [],
      },
      etag: '"' + sourceId + '-v1"',
      lastModified: null,
      contentHash: sourceId + '-hash',
      fetchedAt: priorFetch,
    });
    const state = {
      id: 'state',
      source: 'jsdelivr',
      mode: 'auto',
      sourceId: 'china-mainland-calendar',
      transport: 'auto',
      activeSourceId: 'chinese-days',
      activeTransport: 'jsdelivr',
      lastGoodSourceId: 'chinese-days',
      fallbackUsed: true,
      fallbackFromSourceId: 'holiday-cn',
      fallbackReason: 'holiday-cn：节假日拉取失败（HTTP 500）',
      lastSyncAt: priorFetch,
      lastAttemptAt: priorFetch,
      lastError: null,
      lastErrorSourceId: null,
      nextRetryAt: null,
      consecutiveFailures: 0,
      version: '2026:chinese-days-v1',
      cachedYears: [2026],
      notPublishedYears: [],
      stale: false,
      perSource: {
        'chinese-days': {
          lastSuccessAt: priorFetch,
          lastAttemptAt: priorFetch,
          lastError: null,
          cachedYears: [2026],
          notPublishedYears: [],
        },
        'holiday-cn': {
          lastSuccessAt: '2026-10-31T12:00:00.000Z',
          lastAttemptAt: priorFetch,
          lastError: 'holiday-cn：节假日拉取失败（HTTP 500）',
          cachedYears: [2026],
          notPublishedYears: [],
        },
      },
    };
    const db = await openHolidayDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['packages', 'meta'], 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.objectStore('packages').put(record('chinese-days', 'chinese-days-json'));
      tx.objectStore('packages').put(record('holiday-cn', 'holiday-cn-json'));
      tx.objectStore('meta').put(state);
    });
    db.close();
    return true;
  };
  window.__f2 = {
    sleep,
    norm,
    setSource,
    activeRow,
    fallbackRow,
    seedFallback,
    holidayRecords: () => readAll('packages'),
    holidayState: readState,
    bodyText: () => norm(document.querySelector('.settings-body')?.innerText),
    findButton: (text) =>
      Array.from(document.querySelectorAll('button')).find(
        (button) => visible(button) && norm(button.textContent) === text,
      ),
    scrollActive: () => {
      const row = Array.from(document.querySelectorAll('.settings-row')).find(
        (item) => norm(item.innerText).startsWith('当前使用'),
      );
      row?.scrollIntoView({ block: 'center' });
      return true;
    },
  };
  return true;
})()`;
await evaluate(INSTALL_HELPERS);

// 1. 先把设置页切到自动模式（浏览器不联网，autoSync 默认关闭）。
await evaluate(`window.__f2.setSource('auto')`);
await sleep(500);
const autoSource = await evaluate(
  `document.querySelector('[aria-label="节假日数据源"]')?.value ?? null`,
);
check('设置页已切到自动模式', autoSource === 'auto', autoSource);

// 2. 预置“自动回退后 active=chinese-days、偏好=china-mainland-calendar”的真实 IndexedDB。
const seeded = await evaluate('window.__f2.seedFallback()');
check('预置回退后的真实 IndexedDB 状态与两源缓存', seeded === true, seeded);

// 3. 重新打开设置页（刷新）后读取当前源/回退文案。
await send('Page.reload', { ignoreCache: true });
await waitFor(
  `document.querySelector('h1')?.textContent?.trim() === '设置'`,
  '刷新后的设置页',
);
await evaluate(INSTALL_HELPERS);
await sleep(800);
const activeAfterReopen = await evaluate('window.__f2.activeRow()');
const fallbackAfterReopen = await evaluate('window.__f2.fallbackRow()');
const stateAfterReopen = await evaluate('window.__f2.holidayState()');
check(
  '刷新/重开设置页后当前使用仍为真实 active chinese-days',
  activeAfterReopen.includes('chinese-days') &&
    activeAfterReopen.includes('jsdelivr') &&
    !activeAfterReopen.includes('china-mainland-calendar'),
  activeAfterReopen,
);
check(
  '刷新/重开设置页后回退文案指向 chinese-days',
  fallbackAfterReopen.includes('从 holiday-cn 回退到 chinese-days'),
  fallbackAfterReopen,
);
check(
  'pref 仍是 china-mainland-calendar，未被 failover 覆盖',
  stateAfterReopen?.sourceId === 'china-mainland-calendar' &&
    stateAfterReopen?.mode === 'auto',
  {
    mode: stateAfterReopen?.mode,
    sourceId: stateAfterReopen?.sourceId,
    activeSourceId: stateAfterReopen?.activeSourceId,
  },
);
await evaluate('window.__f2.scrollActive()');
await screenshot('01-fallback-reopen-active-source');

// 4. 清除当前源：只删 chinese-days，保留 holiday-cn。
const beforeClear = await evaluate('window.__f2.holidayRecords()');
await evaluate(`window.__f2.findButton('清除当前源缓存')?.click()`);
await waitFor(
  `document.querySelector('[aria-label="内置节假日源"]') !== null`,
  '清除后的设置页',
);
await sleep(1200);
const afterClear = await evaluate('window.__f2.holidayRecords()');
const stateAfterClear = await evaluate('window.__f2.holidayState()');
const bodyAfterClear = await evaluate('window.__f2.bodyText()');
const beforeKeys = beforeClear.map((item) => item.cacheKey).sort();
const afterKeys = afterClear.map((item) => item.cacheKey).sort();
check(
  '清除当前源只删 chinese-days 缓存',
  beforeKeys.some((key) => key.startsWith('chinese-days|')) &&
    !afterKeys.some((key) => key.startsWith('chinese-days|')) &&
    afterKeys.some((key) => key.startsWith('holiday-cn|')),
  { beforeKeys, afterKeys },
);
check(
  '清除后 active 明确回退内置离线，偏好源不变',
  stateAfterClear?.activeSourceId === 'builtin' &&
    stateAfterClear?.sourceId === 'china-mainland-calendar' &&
    stateAfterClear?.mode === 'auto',
  {
    active: stateAfterClear?.activeSourceId,
    mode: stateAfterClear?.mode,
    sourceId: stateAfterClear?.sourceId,
  },
);
check(
  '清除提示与当前使用文案一致',
  bodyAfterClear.includes('已清除当前源缓存') &&
    bodyAfterClear.includes('内置离线 2026'),
  bodyAfterClear.slice(-1200),
);
await evaluate(
  `Array.from(document.querySelectorAll('.settings-row')).find((item) => __f2.norm(item.innerText).startsWith('当前使用'))?.scrollIntoView({ block: 'center' })`,
);
await screenshot('02-clear-current-source');

// 5. 再次刷新，确认清除后的回退状态也持久化。
await send('Page.reload', { ignoreCache: true });
await waitFor(
  `document.querySelector('h1')?.textContent?.trim() === '设置'`,
  '二次刷新后的设置页',
);
await evaluate(INSTALL_HELPERS);
await sleep(800);
const stateAfterSecondReload = await evaluate('window.__f2.holidayState()');
const activeAfterSecondReload = await evaluate('window.__f2.activeRow()');
check(
  '二次刷新后仍保持内置离线回退',
  stateAfterSecondReload?.activeSourceId === 'builtin' &&
    activeAfterSecondReload.includes('内置离线 2026'),
  { active: stateAfterSecondReload?.activeSourceId, row: activeAfterSecondReload },
);

const unexpectedConsoleErrors = consoleErrors.filter(
  (item) => !/favicon|net::ERR_FILE_NOT_FOUND/i.test(item),
);
check(
  '浏览器控制台零意外报错',
  unexpectedConsoleErrors.length === 0 && pageExceptions.length === 0,
  { consoleErrors: unexpectedConsoleErrors, pageExceptions },
);

const report = {
  task: 'ZX12-FIX-ACTIVE-01',
  kind: 'chromium-browser-indexeddb',
  startedAt: new Date().toISOString(),
  seeded: {
    scenario: '自动回退后 active=chinese-days，偏好残留 china-mainland-calendar',
    note: '浏览器预览不直连远端；此处预置回退结果的真实 IndexedDB 状态，验证读取/清除持久化路径',
  },
  checks,
  failures,
  activeAfterReopen,
  fallbackAfterReopen,
  beforeKeys,
  afterKeys,
  stateAfterClear,
  consoleErrors: unexpectedConsoleErrors,
  pageExceptions,
  ok: failures.length === 0,
};
fs.writeFileSync(
  path.join(EVIDENCE, 'summary.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);

socket.close();
chrome.kill('SIGTERM');
await new Promise((resolve) => setTimeout(resolve, 800));
server.close();

console.log(
  `browser: ${report.ok ? 'PASS' : 'FAIL'} (${checks.length} checks, ${
    failures.length
  } failures)`,
);
for (const failure of failures) console.log(`  - ${failure}`);
if (!report.ok) process.exitCode = 1;
