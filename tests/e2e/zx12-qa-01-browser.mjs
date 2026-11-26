/**
 * ZX12-QA-01 独立浏览器验收（真实 Chromium + app/dist + localStorage）。
 *
 * 只验证浏览器预览分支；生产桌面分支由 zx12-qa-01-desktop.mjs（真实
 * Tauri/WKWebView/SQLite/Rust 代理）覆盖。本脚本提供真实点击截图：
 *   - 设置 → 日历与工作日：3 个独立内置源、License/状态；
 *   - 三个源逐个真实外网同步、2027 未公布、缓存隔离；
 *   - 二次同步条件请求与 304 的真实表现；
 *   - 自动回退、重新打开设置页的当前源、清除当前源；
 *   - 个人例外/DatePicker、跨年、日历月周日视图、任务分组；
 *   - 空态、刷新持久化、控制台零意外报错。
 *
 * 运行：pnpm --filter app build && node tests/e2e/zx12-qa-01-browser.mjs
 * 证据：tests/evidence/zx12-qa-01/browser/
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx12-qa-01/browser');
const PORT = 8897;
const DEBUG_PORT = 9227;
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

const userDataDir = `/tmp/zx12-qa-01-chrome-${Date.now()}`;
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
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
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
  fs.writeFileSync(path.join(EVIDENCE, `${name}.png`), Buffer.from(data, 'base64'));
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
  30_000,
);

// 页面内 QA 助手：只操作真实 DOM / localStorage / IndexedDB，不 import 产品模块。
await evaluate(`(() => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  };
  const findButton = (text, root = document, exact = true) =>
    Array.from(root.querySelectorAll('button')).find(
      (button) =>
        visible(button) &&
        (exact ? norm(button.textContent) === text : norm(button.textContent).includes(text)),
    );
  const byAria = (label) =>
    Array.from(document.querySelectorAll('[aria-label]')).find(
      (el) => el.getAttribute('aria-label') === label && visible(el),
    );
  const setNativeValue = (element, value, eventName) => {
    const proto =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
    element.dispatchEvent(new Event(eventName, { bubbles: true }));
  };
  const setSelect = (el, value) => setNativeValue(el, value, 'change');
  const setInput = (el, value) => {
    setNativeValue(el, value, 'input');
    setNativeValue(el, value, 'change');
  };
  const nativeFetch = window.fetch.bind(window);
  const fetchLog = [];
  const captureFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    let header = null;
    try {
      if (init?.headers) {
        header = init.headers instanceof Headers
          ? init.headers.get('if-none-match')
          : init.headers['if-none-match'] ?? init.headers['If-None-Match'] ?? null;
      }
    } catch {}
    try {
      const response = await nativeFetch(input, init);
      fetchLog.push({ url, status: response.status, ifNoneMatch: header });
      return response;
    } catch (error) {
      fetchLog.push({ url, status: null, ifNoneMatch: header, error: String(error?.message ?? error) });
      throw error;
    }
  };
  window.fetch = captureFetch;
  const settingsEntry = () => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key));
        if (parsed && typeof parsed === 'object' && parsed.calendar) {
          return { key, value: parsed };
        }
      } catch {}
    }
    return null;
  };
  const settingValue = (path) => {
    const entry = settingsEntry();
    if (!entry) return undefined;
    return path.split('.').reduce((acc, part) => acc?.[part], entry.value);
  };
  const waitSetting = async (path, predicate, label, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = settingValue(path);
      if (predicate(value)) return value;
      await sleep(100);
    }
    throw new Error('等待设置超时：' + label);
  };
  const go = async (url, heading) => {
    history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (norm(document.querySelector('h1')?.textContent).includes(heading)) {
        await sleep(350);
        return true;
      }
      await sleep(100);
    }
    throw new Error('页面切换超时：' + url);
  };
  const setSource = async (id) => {
    const body = document.querySelector('.settings-body');
    const select = body.querySelector('select[aria-label="节假日数据源"]');
    setSelect(select, id);
    const expected =
      id === 'auto'
        ? (value) => value?.mode === 'auto'
        : id === 'builtin'
          ? (value) => value?.mode === 'builtin'
          : (value) => value?.mode === 'single' && value?.sourceId === id;
    await waitSetting('calendar.holidaySource', expected, 'source ' + id);
    await sleep(300);
  };
  const ensureFallbackOff = async () => {
    const toggle = byAria('失败时按优先级回退节假日源');
    if (!toggle) throw new Error('找不到失败回退开关');
    if (toggle.getAttribute('aria-checked') === 'true' && !toggle.disabled) {
      toggle.click();
      await waitSetting(
        'calendar.holidaySource',
        (value) => value?.autoFallback === false,
        'autoFallback false',
      );
      await sleep(200);
    }
  };
  const openDb = (name) => new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const idbGet = (name, store, key) => openDb(name).then((db) => new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
  const idbAll = (name, store) => openDb(name).then((db) => new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  }));
  const holidayState = () => idbGet('zhixing-holiday', 'meta', 'state');
  const holidayRecords = () => idbAll('zhixing-holiday', 'packages');
  const syncHoliday = async () => {
    const body = document.querySelector('.settings-body');
    const before = await holidayState();
    const button = findButton('立即同步', body, true);
    if (!button) throw new Error('找不到立即同步');
    button.click();
    await sleep(250);
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (!norm(body.innerText).includes('同步中…')) break;
      await sleep(150);
    }
    const after = await (async () => {
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        const current = await holidayState();
        if (current?.lastAttemptAt && current.lastAttemptAt !== before?.lastAttemptAt) {
          return current;
        }
        await sleep(150);
      }
      throw new Error('节假日同步状态未落盘');
    })();
    await sleep(500);
    return {
      text: norm(body.innerText),
      state: after,
      records: await holidayRecords(),
    };
  };
  const installFault = (mode, match) => {
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      if (match(url)) {
        if (mode === 'http-500') return new Response('down', { status: 500 });
        if (mode === 'offline') throw new TypeError('Failed to fetch (ZX12 QA)');
        if (mode === 'bad-json') {
          return new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } });
        }
      }
      return captureFetch(input, init);
    };
  };
  const restoreFetch = () => { window.fetch = captureFetch; };
  const rows = () => {
    const list = document.querySelector('[aria-label="内置节假日源"]');
    return Array.from(list?.querySelectorAll('.settings-exception-item') ?? []).map(
      (item) => norm(item.innerText),
    );
  };
  const activeRow = () => {
    const row = Array.from(document.querySelectorAll('.settings-row')).find(
      (item) => norm(item.innerText).startsWith('当前使用'),
    );
    return norm(row?.innerText);
  };
  const addException = async (date) => {
    const body = document.querySelector('.settings-body');
    const input = body.querySelector('input[aria-label="例外日期"]');
    input.focus();
    setInput(input, date);
    await sleep(250);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(200);
    if (input.getAttribute('data-value') !== date) input.blur();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && input.getAttribute('data-value') !== date) {
      await sleep(100);
    }
    setSelect(body.querySelector('select[aria-label="例外类型"]'), 'work');
    setInput(body.querySelector('input[aria-label="例外备注"]'), 'ZX12 浏览器验收补班');
    await sleep(250);
    findButton('添加例外', body, true).click();
    await waitSetting(
      'calendar.dateExceptions',
      (value) => Array.isArray(value) && value.some((item) => item.date === date && item.kind === 'work'),
      'exception',
    );
  };
  const calendarSnapshot = async (dates, move) => {
    await go('/calendar', '日历');
    const end = Date.now() + 20000;
    while (Date.now() < end && !document.querySelector('[data-testid="month-grid"]')) {
      await sleep(150);
    }
    const today = findButton('今天', document, true);
    if (today) {
      today.click();
      await sleep(500);
    }
    for (let index = 0; index < Math.abs(move); index += 1) {
      byAria(move > 0 ? '下一段' : '上一段')?.click();
      await sleep(450);
    }
    const cell = (date) => document.querySelector('[data-testid="day-' + date + '"]');
    return {
      title: norm(document.querySelector('[data-testid="calendar-title"]')?.textContent),
      workdays: Object.fromEntries(dates.map((date) => [date, cell(date)?.getAttribute('data-workday') ?? null])),
      cells: Object.fromEntries(dates.map((date) => [date, norm(cell(date)?.innerText)])),
    };
  };
  window.__qa = {
    sleep, norm, visible, findButton, byAria, setSelect, setInput,
    settingValue, waitSetting, go, setSource, ensureFallbackOff,
    holidayState, holidayRecords, syncHoliday, installFault, restoreFetch,
    rows, activeRow, addException, calendarSnapshot, fetchLog,
    bodyText: () => norm(document.querySelector('.settings-body')?.innerText),
    scrollTo: async (selector) => {
      const el = document.querySelector(selector);
      if (el) el.scrollIntoView({ block: 'center' });
      await sleep(350);
      return true;
    },
  };
  return true;
})()`);

// ---------------------------------------------------------------------------
// 1. 设置页 3 源与空态
// ---------------------------------------------------------------------------
const initial = await evaluate(`({
  text: __qa.bodyText(),
  rows: __qa.rows(),
  options: Array.from(document.querySelectorAll('select[aria-label="节假日数据源"] option')).map((o) => o.value),
  ics: __qa.norm(document.querySelector('.zx-ics')?.innerText),
})`);
const sourceRows = initial.rows.filter((text) => text.includes('github.com/'));
const repos = sourceRows.map((text) => (text.match(/https:\/\/github\.com\/[^\s]+/) ?? [''])[0]);
check('3 个独立内置源 + 不同仓库', sourceRows.length === 3 && new Set(repos).size === 3, {
  sourceRows,
  repos,
});
check(
  '每个源 License/状态',
  sourceRows.every((text) => text.includes('MIT')) &&
    sourceRows.every((text) => /主源|备源|最后备源/.test(text)),
  sourceRows,
);
check(
  '数据源选项完整',
  ['auto', 'holiday-cn', 'chinese-days', 'china-mainland-calendar', 'builtin', 'custom'].every((value) =>
    initial.options.includes(value),
  ),
  initial.options,
);
check(
  '空态与镜像不计源说明',
  initial.text.includes('还没有个人日期例外') &&
    initial.text.includes('不重复计源') &&
    initial.ics.includes('还没有 ICS 订阅'),
  { text: initial.text.slice(0, 800), ics: initial.ics.slice(0, 400) },
);
await evaluate(`__qa.scrollTo('[aria-label="内置节假日源"]')`);
await screenshot('01-settings-3-sources');

// ---------------------------------------------------------------------------
// 2. 三源真实同步、缓存隔离、二次 304 表现
// ---------------------------------------------------------------------------
const sourceIds = ['holiday-cn', 'chinese-days', 'china-mainland-calendar'];
const firstResults = {};
for (const [index, id] of sourceIds.entries()) {
  await evaluate(`__qa.setSource(${JSON.stringify(id)})`);
  await evaluate('__qa.ensureFallbackOff()');
  const result = await evaluate('__qa.syncHoliday()');
  firstResults[id] = result;
  const keys = result.records.map((item) => item.cacheKey).sort();
  const own = result.records.find(
    (item) => item.sourceId === id && item.year === 2026 && item.package?.days?.length >= 5,
  );
  check(
    `${id} 真实同步成功`,
    !result.text.includes('节假日同步失败') && result.state.activeSourceId === id && Boolean(own),
    { text: result.text.slice(0, 900), keys, active: result.state.activeSourceId },
  );
  check(
    `${id} 缓存按源+年份隔离`,
    keys.includes(`${id}|jsdelivr|2026`) &&
      !result.records.some((item) => item.sourceId === id && item.year === 2027),
    keys,
  );
  check(
    `${id} 2027 未公布且不覆盖 2026`,
    result.state.notPublishedYears?.includes(2027) && Boolean(own),
    { notPublished: result.state.notPublishedYears, keys },
  );
  await evaluate(`__qa.scrollTo('[aria-label="内置节假日源"]')`);
  await screenshot(`02-holiday-${index + 1}-${id}`);

  const beforeLog = await evaluate('__qa.fetchLog.length');
  const second = await evaluate('__qa.syncHoliday()');
  const recent = await evaluate(`__qa.fetchLog.slice(${beforeLog})`);
  const has304 = recent.some((entry) => entry.url.includes(id) && entry.status === 304);
  check(`${id} 二次同步真实 304`, has304, {
    recent,
    state: { lastSyncAt: second.state.lastSyncAt, active: second.state.activeSourceId },
  });
}

// ---------------------------------------------------------------------------
// 3. 自动回退 + 重新打开设置页当前源 + 清除当前源
// ---------------------------------------------------------------------------
await evaluate(`__qa.setSource('auto')`);
await evaluate(`__qa.installFault('http-500', (url) => url.includes('holiday-cn'))`);
const fallback = await evaluate('__qa.syncHoliday()');
await evaluate('__qa.restoreFetch()');
check(
  '自动回退到 chinese-days 且原因可见',
  fallback.state.fallbackUsed === true &&
    fallback.state.activeSourceId === 'chinese-days' &&
    /holiday-cn/.test(fallback.state.fallbackReason ?? '') &&
    /500/.test(fallback.state.fallbackReason ?? '') &&
    fallback.text.includes('已回退'),
  {
    active: fallback.state.activeSourceId,
    reason: fallback.state.fallbackReason,
    text: fallback.text.slice(0, 1200),
  },
);
await evaluate(`__qa.go('/calendar', '日历')`);
await evaluate(`__qa.go('/settings/calendar', '设置')`);
const activeAfterReopen = await evaluate('__qa.activeRow()');
check(
  '重新打开设置页保持回退后的当前源',
  activeAfterReopen.includes('chinese-days'),
  activeAfterReopen,
);
await evaluate(`__qa.scrollTo('.settings-row:nth-of-type(1)')`);
await evaluate(`(() => {
  const row = Array.from(document.querySelectorAll('.settings-row')).find((item) => __qa.norm(item.innerText).startsWith('当前使用'));
  row?.scrollIntoView({ block: 'center' });
  return true;
})()`);
await screenshot('03-fallback-reopen-active-source');

await evaluate(`__qa.setSource('chinese-days')`);
const beforeClear = await evaluate('__qa.holidayRecords()');
const clearResult = await evaluate(`(async () => {
  const body = document.querySelector('.settings-body');
  __qa.findButton('清除当前源缓存', body, true).click();
  await __qa.sleep(1800);
  return { records: await __qa.holidayRecords(), text: __qa.bodyText() };
})()`);
const beforeKeys = beforeClear.map((item) => item.cacheKey).sort();
const afterKeys = clearResult.records.map((item) => item.cacheKey).sort();
check(
  '清除当前源只删 chinese-days 缓存',
  !afterKeys.some((key) => key.startsWith('chinese-days|')) &&
    afterKeys.some((key) => key.startsWith('holiday-cn|')),
  { beforeKeys, afterKeys, text: clearResult.text.slice(-500) },
);
await evaluate(`__qa.scrollTo('[aria-label="内置节假日源"]')`);
await screenshot('04-clear-current-source');

// ---------------------------------------------------------------------------
// 4. 个人例外/DatePicker、跨年、日历视图、任务分组
// ---------------------------------------------------------------------------
await evaluate(`__qa.setSource('chinese-days')`);
await evaluate(`__qa.addException('2027-01-01')`);
check(
  'DatePicker 写入个人例外',
  (await evaluate(`__qa.settingValue('calendar.dateExceptions')`)).some(
    (item) => item.date === '2027-01-01' && item.kind === 'work',
  ),
  await evaluate(`__qa.settingValue('calendar.dateExceptions')`),
);
// 浏览器预览没有 Tauri IPC，日历/任务页明确显示不可用；月周日与任务分组回归
// 由桌面探针覆盖。这里只验证设置页 DatePicker 与 localStorage 持久化。
const browserCalendarGate = await evaluate(`(async () => {
  await __qa.go('/calendar', '日历');
  await __qa.sleep(500);
  return __qa.norm(document.body.innerText);
})()`);
check(
  '浏览器预览日历门禁明确',
  browserCalendarGate.includes('需在桌面壳内'),
  browserCalendarGate.slice(0, 600),
);
await screenshot('05-calendar-browser-gate');

// ---------------------------------------------------------------------------
// 5. 刷新持久化 + 控制台
// ---------------------------------------------------------------------------
await evaluate(`__qa.go('/settings/calendar', '设置')`);
const fetchLogBeforeReload = await evaluate('__qa.fetchLog').catch(() => []);
await send('Page.reload', { ignoreCache: true });
await waitFor(`document.querySelector('h1')?.textContent?.trim() === '设置'`, '刷新设置页');
const afterReload = await evaluate(`(() => {
  let entry = null;
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      if (parsed && typeof parsed === 'object' && parsed.calendar) {
        entry = parsed;
        break;
      }
    } catch {}
  }
  return {
    source: entry?.calendar?.holidaySource,
    exceptions: entry?.calendar?.dateExceptions,
    text: String(document.querySelector('.settings-body')?.innerText ?? '').replace(/\s+/g, ' ').trim(),
  };
})()`);
check(
  '刷新后源/例外保持',
  afterReload.source?.sourceId === 'chinese-days' &&
    afterReload.exceptions?.some((item) => item.date === '2027-01-01'),
  { source: afterReload.source, exceptions: afterReload.exceptions },
);

const corsConsole = consoleErrors.filter(
  (message) =>
    /CORS policy/.test(message) && /if-none-match/i.test(message),
);
check(
  '条件请求不产生 CORS 控制台报错（与 304 同根因）',
  corsConsole.length === 0,
  corsConsole,
);
const unexpectedConsole = consoleErrors.filter(
  (message) =>
    !/CORS policy|if-none-match|net::ERR_FAILED|Failed to fetch|ZX12 QA|Load failed/i.test(
      message,
    ),
);
check(
  '控制台零其它意外报错',
  unexpectedConsole.length === 0 && pageExceptions.length === 0,
  { consoleErrors: unexpectedConsole, pageExceptions },
);

const summary = {
  task: 'ZX12-QA-01',
  kind: 'chromium-browser',
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  checks,
  failures,
  consoleErrors,
  pageExceptions,
  fetchLog: fetchLogBeforeReload,
  ok: failures.length === 0,
};
fs.writeFileSync(
  path.join(EVIDENCE, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(
  `browser: ${summary.ok ? 'PASS' : 'FAIL'} (${checks.length} checks, ${failures.length} failures)`,
);
for (const failure of failures) console.log(`  - ${failure}`);

chrome.kill('SIGTERM');
server.close();
process.exitCode = summary.ok ? 0 : 1;
