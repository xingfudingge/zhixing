/**
 * ZX12-FIX-304-01 浏览器预览验收（真实 Chrome + app/dist + IndexedDB）。
 *
 * 浏览器没有 Tauri/Rust 代理，因此节假日远端同步必须明确提示"需桌面壳"：
 * - 不向远端发起 fetch（PerformanceResourceTiming 无节假日域名）；
 * - 不伪造 304，不更新 lastSyncAt；
 * - 已缓存的数据包保持不动；
 * - 控制台无 CORS 预检错误。
 *
 * 运行：pnpm --filter app build && node tests/e2e/zx12-fix-304-01-browser.mjs
 * 证据：tests/evidence/zx12-fix-304-01/browser.json
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx12-fix-304-01');
const PORT = 8897;
const DEBUG_PORT = 9227;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
if (!fs.existsSync(CHROME)) {
  throw new Error(`Chrome 不存在：${CHROME}`);
}
fs.mkdirSync(EVIDENCE, { recursive: true });

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

const userDataDir = `/tmp/zx12-fix-304-01-chrome-${Date.now()}`;
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

let target;
try {
  target = await waitForDevtools();
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
  async function waitFor(expression, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await evaluate(expression).catch(() => null);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`等待超时：${label}`);
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/settings/calendar` });
  await waitFor(
    `document.querySelector('h1')?.textContent?.trim() === '设置'`,
    '设置页',
    30_000,
  );

  await evaluate(`(() => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const norm = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    window.__qa = { sleep, norm };
    window.__qa.visible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0.5 && rect.height > 0.5;
    };
    window.__qa.byAria = (label) =>
      Array.from(document.querySelectorAll('[aria-label]')).find(
        (el) => el.getAttribute('aria-label') === label && window.__qa.visible(el),
      );
    window.__qa.findButton = (text, root = document, exact = true) =>
      Array.from(root.querySelectorAll('button')).find(
        (button) =>
          window.__qa.visible(button) &&
          (exact
            ? window.__qa.norm(button.textContent) === text
            : window.__qa.norm(button.textContent).includes(text)),
      );
    window.__qa.setNativeValue = (element, value, eventName) => {
      const proto =
        element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
      element.dispatchEvent(new Event(eventName, { bubbles: true }));
    };
    window.__qa.setSelect = (el, value) =>
      window.__qa.setNativeValue(el, value, 'change');
    window.__qa.waitFor = async (checkFn, label, timeout = 30_000) => {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        try {
          last = await checkFn();
          if (last) return last;
        } catch {}
        await sleep(150);
      }
      throw new Error('等待超时：' + label + ' ' + JSON.stringify(last));
    };
    window.__qa.settingsEntry = () => {
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
    window.__qa.settingValue = (path) => {
      const entry = window.__qa.settingsEntry();
      if (!entry) return undefined;
      return path.split('.').reduce((acc, part) => acc?.[part], entry.value);
    };
    window.__qa.waitSetting = (path, predicate, label) =>
      window.__qa.waitFor(() => {
        const value = window.__qa.settingValue(path);
        return predicate(value) ? value : null;
      }, label);
    return true;
  })()`);

  const result = await evaluate(`(async () => {
    const { sleep, norm, waitFor, setSelect, findButton, byAria } = window.__qa;
    const checks = [];
    const failures = [];
    const check = (name, ok, detail) => {
      checks.push({ name, ok: Boolean(ok), detail });
      if (!ok) failures.push(name + '：' + JSON.stringify(detail).slice(0, 2000));
    };
    const body = () => document.querySelector('.settings-body');
    const bodyText = () => norm(body()?.innerText);

    async function setSource(id) {
      const root = body();
      const select = root.querySelector('select[aria-label="节假日数据源"]');
      setSelect(select, id);
      await window.__qa.waitSetting(
        'calendar.holidaySource',
        (value) => value?.mode === 'single' && value?.sourceId === id,
        'source ' + id,
      );
      await sleep(300);
    }
    async function ensureFallbackOff() {
      const toggle = byAria('失败时按优先级回退节假日源');
      if (toggle?.getAttribute('aria-checked') === 'true' && !toggle.disabled) {
        toggle.click();
        await window.__qa.waitSetting(
          'calendar.holidaySource',
          (value) => value?.autoFallback === false,
          'autoFallback false',
        );
        await sleep(200);
      }
    }
    function openDb(name) {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (db.objectStoreNames.contains('packages')) {
            db.deleteObjectStore('packages');
          }
          db.createObjectStore('packages', { keyPath: 'cacheKey' });
          if (!db.objectStoreNames.contains('meta')) {
            db.createObjectStore('meta', { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    function idbGet(name, store, key) {
      return openDb(name).then((db) => new Promise((resolve, reject) => {
        const request = db.transaction(store, 'readonly').objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }));
    }
    function idbAll(name, store) {
      return openDb(name).then((db) => new Promise((resolve, reject) => {
        const request = db.transaction(store, 'readonly').objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result ?? []);
        request.onerror = () => reject(request.error);
      }));
    }
    const stateKey = ['zhixing-holiday', 'meta', 'state'];
    const recordKey = 'holiday-cn|jsdelivr|2026';
    const seededAt = '2026-10-01T00:00:00.000Z';
    const days = [
      { name: '元旦', date: '2026-01-01', isOffDay: true },
      { name: '元旦', date: '2026-01-02', isOffDay: true },
      { name: '元旦', date: '2026-01-03', isOffDay: true },
      { name: '国庆节', date: '2026-10-01', isOffDay: true },
      { name: '国庆节', date: '2026-10-02', isOffDay: true },
    ];
    const db = await openDb('zhixing-holiday');
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['packages', 'meta'], 'readwrite');
      tx.objectStore('packages').put({
        cacheKey: recordKey,
        sourceId: 'holiday-cn',
        transport: 'jsdelivr',
        format: 'holiday-cn-json',
        year: 2026,
        package: {
          year: 2026,
          days,
          source: 'holiday-cn',
          version: 'seeded-v1',
          origin: 'remote',
          fetchedAt: seededAt,
          papers: [],
        },
        etag: '"seeded-v1"',
        lastModified: null,
        contentHash: 'seededhash',
        fetchedAt: seededAt,
      });
      tx.objectStore('meta').put({
        id: 'state',
        source: 'jsdelivr',
        mode: 'single',
        sourceId: 'holiday-cn',
        transport: 'jsdelivr',
        activeSourceId: 'holiday-cn',
        activeTransport: 'jsdelivr',
        lastGoodSourceId: 'holiday-cn',
        fallbackUsed: false,
        fallbackFromSourceId: null,
        fallbackReason: null,
        lastSyncAt: seededAt,
        lastAttemptAt: seededAt,
        lastError: null,
        lastErrorSourceId: null,
        nextRetryAt: null,
        consecutiveFailures: 0,
        version: '2026:seeded-v1',
        cachedYears: [2026],
        notPublishedYears: [],
        stale: false,
        perSource: {},
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });

    await setSource('holiday-cn');
    await ensureFallbackOff();

    const beforeState = await idbGet(...stateKey);
    const beforeRecords = await idbAll('zhixing-holiday', 'packages');
    const beforeResources = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name);
    const button = findButton('立即同步', body(), true);
    if (!button) throw new Error('找不到立即同步');
    button.click();
    await sleep(250);
    await waitFor(
      () => !bodyText().includes('同步中…'),
      '同步结束',
      30_000,
    );
    const afterState = await waitFor(async () => {
      const current = await idbGet(...stateKey);
      return current?.lastAttemptAt && current.lastAttemptAt !== beforeState?.lastAttemptAt
        ? current
        : null;
    }, '状态落盘', 20_000);
    await sleep(400);
    const afterRecords = await idbAll('zhixing-holiday', 'packages');
    const afterResources = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name);
    const holidayHosts =
      /(holiday-cn|chinese-days|china-mainland-calendar|jsdelivr|unpkg|githubusercontent)/i;

    check(
      '浏览器预览明确提示需桌面壳',
      /桌面壳/.test(bodyText()) && /桌面壳/.test(afterState.lastError ?? ''),
      { text: bodyText().slice(0, 1400), lastError: afterState.lastError },
    );
    check(
      '失败不更新 lastSyncAt',
      afterState.lastSyncAt === seededAt,
      { before: beforeState.lastSyncAt, after: afterState.lastSyncAt },
    );
    check(
      '失败更新 lastAttemptAt',
      afterState.lastAttemptAt !== beforeState.lastAttemptAt,
      { before: beforeState.lastAttemptAt, after: afterState.lastAttemptAt },
    );
    check(
      '保留已缓存数据包与版本',
      JSON.stringify(beforeRecords) === JSON.stringify(afterRecords) &&
        afterRecords.some(
          (item) =>
            item.cacheKey === recordKey && item.package?.version === 'seeded-v1',
        ),
      { beforeRecords, afterRecords },
    );
    check(
      '浏览器不向节假日源发请求（不伪造 304）',
      !beforeResources.some((url) => holidayHosts.test(url)) &&
        !afterResources.some((url) => holidayHosts.test(url)) &&
        !afterRecords.some((item) => item.etag === 'seeded-v1' && item.fetchedAt !== seededAt),
      {
        beforeResources: beforeResources.filter((url) => !url.startsWith('http://127.0.0.1')),
        afterResources: afterResources.filter((url) => !url.startsWith('http://127.0.0.1')),
      },
    );

    return {
      checks,
      failures,
      stateBefore: beforeState,
      stateAfter: afterState,
      recordsBefore: beforeRecords,
      recordsAfter: afterRecords,
      externalResources: afterResources.filter(
        (url) => !url.startsWith('http://127.0.0.1'),
      ),
      bodyText: bodyText().slice(0, 1600),
    };
  })()`);

  const unexpectedConsole = consoleErrors.filter(
    (message) =>
      !/DevTools|favicon|net::ERR_FILE_NOT_FOUND|Failed to load resource: the server responded with a status of 404/i.test(
        message,
      ),
  );
  result.checks.push({
    name: '无 CORS/控制台错误',
    ok: unexpectedConsole.length === 0 && pageExceptions.length === 0,
    detail: { consoleErrors, unexpectedConsole, pageExceptions },
  });
  if (!result.checks.at(-1).ok) {
    result.failures.push('无 CORS/控制台错误');
  }
  result.ok = result.failures.length === 0;

  const evidence = {
    phase: 'browser',
    ok: result.ok,
    failures: result.failures,
    checks: result.checks,
    consoleErrors,
    pageExceptions,
    stateBefore: result.stateBefore,
    stateAfter: result.stateAfter,
    recordsBefore: result.recordsBefore,
    recordsAfter: result.recordsAfter,
    externalResources: result.externalResources,
    bodyText: result.bodyText,
  };
  fs.writeFileSync(
    path.join(EVIDENCE, 'browser.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  for (const item of evidence.checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
  }
  for (const failure of evidence.failures) {
    console.error(`FAILURE ${failure}`);
  }
  console.log(
    `\n${evidence.checks.filter((item) => item.ok).length}/${evidence.checks.length} checks passed`,
  );
  console.log(`evidence: ${path.relative(ROOT, path.join(EVIDENCE, 'browser.json'))}`);
  process.exitCode = evidence.ok ? 0 : 1;
} finally {
  try {
    chrome.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  server.close();
}
