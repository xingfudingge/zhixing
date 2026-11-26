/**
 * AUD-014 浏览器实测（真实 Chromium + 生产构建 app/dist）。
 *
 * 覆盖 F-012 事件编辑/删除/建任务、F-013 农历「每年下一次」、
 * F-014 小工具转换、F-015 沉浸时钟主题/数字模拟/12-24/秒/常亮。
 *
 * 边界：Tauri IPC 由 tests/harness/fakeTauri.ts 的内存命令路由替代，
 * 页面、React 状态、真实 DOM 事件与截图都来自生产构建；不是 Tauri WebView，
 * 也不是真实 Rust/SQLite。Wake Lock / Fullscreen 用可观测替身验证调用与释放。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/aud014-browser.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/aud014');
const FAKE_BUNDLE = '/tmp/zx-aud014-fake.js';
const PORT = 8902;
const DEBUG_PORT = 9224;
const CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DB_KEY = 'zx_aud014_db';
const EMPTY_KEY = 'zx_aud014_empty';

fs.mkdirSync(EVIDENCE, { recursive: true });
for (const file of fs.readdirSync(EVIDENCE)) {
  if (file.endsWith('.png') || file === 'summary.json') {
    fs.unlinkSync(path.join(EVIDENCE, file));
  }
}

const esbuild = path.join(
  ROOT,
  'node_modules/.pnpm/node_modules/.bin/esbuild',
);
if (!fs.existsSync(esbuild)) {
  throw new Error(`找不到 esbuild：${esbuild}`);
}
const bundled = spawnSync(
  esbuild,
  [
    path.join(ROOT, 'tests/harness/fakeTauri.ts'),
    '--bundle',
    '--format=iife',
    '--global-name=ZXFake',
    '--platform=browser',
    `--outfile=${FAKE_BUNDLE}`,
  ],
  { encoding: 'utf8' },
);
if (bundled.status !== 0) {
  throw new Error(`打包 fakeTauri 失败：${bundled.stderr}`);
}
const fakeBundle = fs.readFileSync(FAKE_BUNDLE, 'utf8');

const summaries = [];
const results = [];
function note(message, data) {
  const line = data === undefined ? message : `${message} ${JSON.stringify(data)}`;
  summaries.push(line);
  console.log(`[aud014-browser] ${line}`);
}

function record(meta, verdict, actual, evidence) {
  results.push({
    id: meta.id,
    feature: meta.feature,
    name: meta.name,
    expected: meta.expected,
    actual,
    verdict,
    evidence: evidence ? `tests/evidence/aud014/${evidence}` : null,
  });
  note(`[${verdict}] ${meta.id} ${meta.name}`, {
    expected: meta.expected,
    actual,
    evidence,
  });
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runCase(meta, fn, shot) {
  try {
    const actual = await fn();
    await screenshot(shot);
    record(meta, 'PASS', actual, shot);
    return actual;
  } catch (error) {
    const failShot = shot.replace(/\.png$/, '-FAIL.png');
    try {
      await screenshot(failShot);
    } catch {
      // 截图失败不覆盖原始错误。
    }
    record(meta, 'FAIL', error?.message ?? String(error), failShot);
    throw error;
  }
}

async function observeCase(meta, fn, shot) {
  try {
    const actual = await fn();
    await screenshot(shot);
    const verdict = actual?.verdict ?? 'PASS';
    const detail = actual?.detail ?? actual;
    record(meta, verdict, detail, shot);
    return actual;
  } catch (error) {
    const failShot = shot.replace(/\.png$/, '-FAIL.png');
    try {
      await screenshot(failShot);
    } catch {
      // 截图失败不覆盖原始错误。
    }
    record(meta, 'FAIL', error?.message ?? String(error), failShot);
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(
    new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
  );
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
  fs.createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
note(`静态服务已启动 http://127.0.0.1:${PORT}（SPA fallback）`);

const userDataDir = `/tmp/zx-chrome-aud014-${Date.now()}`;
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
    '--window-size=1440,1000',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let chromeStderr = '';
chrome.stderr.on('data', (chunk) => {
  chromeStderr += String(chunk);
});

async function waitForDevtools() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${DEBUG_PORT}/json/list`,
      );
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {
      // 继续轮询。
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
const consoleWarns = [];
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
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (message.params.args ?? [])
      .map((arg) => arg.value ?? arg.description ?? '')
      .join(' ');
    if (message.params.type === 'error') consoleErrors.push(text);
    if (message.params.type === 'warning') consoleWarns.push(text);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    pageExceptions.push(
      details.exception?.description ?? details.text ?? 'unknown exception',
    );
  }
  if (message.method === 'Log.entryAdded') {
    const entry = message.params.entry;
    if (entry.level === 'error') consoleErrors.push(entry.text);
    if (entry.level === 'warning') consoleWarns.push(entry.text);
  }
});

let nextId = 0;
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, 20_000);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        result.exceptionDetails.text,
    );
  }
  return result.result?.value;
}

async function waitFor(expression, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(expression);
      if (value) return value;
      last = value;
    } catch (error) {
      last = error.message;
    }
    await sleep(100);
  }
  throw new Error(`等待超时：${label}（最后值：${JSON.stringify(last)}）`);
}

async function screenshot(name) {
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  const file = path.join(EVIDENCE, name);
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  note(`截图已保存 ${path.relative(ROOT, file)}`);
}

async function clickPoint(point, clickCount = 1) {
  ensure(point, '点击目标不存在');
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  ensure(x >= 0 && y >= 0 && x <= 1440 && y <= 1000, `点击坐标越界：${x},${y}`);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount,
  });
  await sleep(120);
}

async function pointFor(expression, label) {
  const point = await evaluate(`(async () => {
    const el = (${expression});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      tag: el.tagName,
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    };
  })()`);
  if (!point) throw new Error(`找不到点击目标：${label}`);
  return point;
}

async function clickSelector(selector, label = selector) {
  const point = await pointFor(`document.querySelector(${JSON.stringify(selector)})`, label);
  await clickPoint(point);
  return point;
}

async function clickSelectorOffset(selector, offsetX, offsetY, label = selector) {
  const point = await evaluate(`(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + ${offsetX},
      y: rect.top + ${offsetY},
      tag: el.tagName,
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    };
  })()`);
  if (!point) throw new Error(`找不到点击目标：${label}`);
  await clickPoint(point);
  return point;
}

async function clickAria(label) {
  const point = await pointFor(
    `Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label') === ${JSON.stringify(label)})`,
    `aria-label=${label}`,
  );
  await clickPoint(point);
  return point;
}

async function clickText(selector, text) {
  const point = await pointFor(
    `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)})`,
    `${selector} 文本=${text}`,
  );
  await clickPoint(point);
  return point;
}

async function doubleClickAria(label) {
  const point = await pointFor(
    `Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label') === ${JSON.stringify(label)})`,
    `aria-label=${label}`,
  );
  await clickPoint(point, 1);
  await sleep(40);
  await clickPoint(point, 2);
  return point;
}

async function pressEscape() {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await sleep(150);
}

function addDays(date, days) {
  const next = new Date(`${date}T12:00:00`);
  next.setDate(next.getDate() + days);
  const pad = (value) => String(value).padStart(2, '0');
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

function diffDays(from, to) {
  const left = new Date(`${from}T12:00:00`);
  const right = new Date(`${to}T12:00:00`);
  return Math.round((right - left) / 86_400_000);
}

const injection = `(() => {
  let raw = null;
  let emptyFlag = false;
  try {
    raw = localStorage.getItem(${JSON.stringify(DB_KEY)});
    emptyFlag = localStorage.getItem(${JSON.stringify(EMPTY_KEY)}) === '1';
  } catch (error) {}
  __ZX_FAKE_BUNDLE__
  try {
    const world = ZXFake.createFakeWorld();
    if (raw) {
      const saved = JSON.parse(raw);
      for (const [key, value] of Object.entries(saved)) {
        if (Array.isArray(value)) world.db[key] = value;
      }
    }
    if (emptyFlag) {
      world.db.events = [];
      world.db.countdowns = [];
    }
    world.install();

    const originalInvoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await originalInvoke(command, args);
      if (!emptyFlag) {
        try {
          localStorage.setItem(${JSON.stringify(DB_KEY)}, JSON.stringify(world.db));
        } catch (error) {}
      }
      return result;
    };

    // Wake Lock 可观测替身：验证「常亮」请求/释放，以及拒绝时降级。
    window.__ZX_WAKE__ = {
      requests: [],
      releases: 0,
      mode: 'ok',
      installError: null,
    };
    try {
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: {
          request(type) {
            window.__ZX_WAKE__.requests.push(type);
            if (window.__ZX_WAKE__.mode === 'reject') {
              return Promise.reject(new Error('wake-lock-denied'));
            }
            return Promise.resolve({
              release() {
                window.__ZX_WAKE__.releases += 1;
                return Promise.resolve();
              },
            });
          },
        },
      });
    } catch (error) {
      window.__ZX_WAKE__.installError = String(error);
    }

    // Fullscreen 可观测替身：headless 没有用户手势，真实 API 会拒绝。
    // 注入发生在 documentElement 尚未创建时，必须挂在原型上。
    window.__ZX_FULLSCREEN__ = { requests: 0, exits: 0, installError: null };
    try {
      Object.defineProperty(Element.prototype, 'requestFullscreen', {
        configurable: true,
        value() {
          window.__ZX_FULLSCREEN__.requests += 1;
          return Promise.resolve();
        },
      });
      Object.defineProperty(Document.prototype, 'exitFullscreen', {
        configurable: true,
        value() {
          window.__ZX_FULLSCREEN__.exits += 1;
          return Promise.resolve();
        },
      });
    } catch (error) {
      window.__ZX_FULLSCREEN__.installError = String(error);
    }

    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const active = (rows) => rows.filter((row) => row.deletedAt === null);
    const findAria = (label) =>
      Array.from(document.querySelectorAll('[aria-label]')).find(
        (el) => el.getAttribute('aria-label') === label,
      ) || null;
    const findText = (selector, text) =>
      Array.from(document.querySelectorAll(selector)).find(
        (el) => normalize(el.textContent) === normalize(text),
      ) || null;

    function labelControl(root, labelText) {
      const label = Array.from(root.querySelectorAll('label')).find(
        (item) => normalize(item.textContent) === normalize(labelText),
      );
      if (!label) throw new Error('找不到字段：' + labelText);
      const control = label.htmlFor
        ? document.getElementById(label.htmlFor)
        : label.querySelector('input, select, textarea');
      if (!control) throw new Error('字段没有控件：' + labelText);
      return control;
    }

    function setControlValue(control, value) {
      const proto =
        control.tagName === 'SELECT'
          ? HTMLSelectElement.prototype
          : control.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) throw new Error('无法设置控件值');
      setter.call(control, String(value));
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
      return control.value;
    }

    function dialogRoot() {
      return document.querySelector('.task-dialog');
    }

    window.__ZX_WORLD__ = world;
    window.__ZX_TEST__ = {
      today: world.today,
      events() {
        return active(world.db.events);
      },
      event(id) {
        return world.db.events.find((row) => row.id === id) || null;
      },
      countdowns() {
        return active(world.db.countdowns);
      },
      countdown(id) {
        return world.db.countdowns.find((row) => row.id === id) || null;
      },
      tasks() {
        return active(world.db.tasks);
      },
      taskByTitle(title) {
        return active(world.db.tasks).find((row) => row.title === title) || null;
      },
      tasksByTitle(title) {
        return active(world.db.tasks).filter((row) => row.title === title);
      },
      dialog() {
        const root = dialogRoot();
        if (!root) return null;
        return {
          title: normalize(root.querySelector('h2')?.textContent),
          text: normalize(root.textContent).slice(0, 500),
        };
      },
      dialogOpen() {
        return Boolean(dialogRoot());
      },
      dialogValue(label) {
        const root = dialogRoot();
        if (!root) throw new Error('弹层未打开');
        return labelControl(root, label).value;
      },
      setDialogField(label, value) {
        const root = dialogRoot();
        if (!root) throw new Error('弹层未打开');
        return setControlValue(labelControl(root, label), value);
      },
      clickDialogButton(text) {
        const root = dialogRoot();
        if (!root) throw new Error('弹层未打开');
        const button = findText('.task-dialog button', text) || findText('button', text);
        if (!button) throw new Error('找不到弹层按钮：' + text);
        button.click();
        return true;
      },
      clickAria(label) {
        const element = findAria(label);
        if (!element) throw new Error('找不到 aria-label：' + label);
        element.click();
        return true;
      },
      clickText(selector, text) {
        const element = findText(selector, text);
        if (!element) throw new Error('找不到文本：' + selector + ' / ' + text);
        element.click();
        return true;
      },
      click(selector) {
        const element = document.querySelector(selector);
        if (!element) throw new Error('找不到元素：' + selector);
        element.click();
        return true;
      },
      existsAria(label) {
        return Boolean(findAria(label));
      },
      ariaText(label) {
        const element = findAria(label);
        return element ? normalize(element.textContent) : null;
      },
      rowText(id) {
        const row = document.querySelector('[data-event-id="' + id + '"]');
        return row ? normalize(row.textContent) : null;
      },
      countdownRowText(id) {
        const row = document.querySelector('[data-countdown-id="' + id + '"]');
        return row ? normalize(row.textContent) : null;
      },
      cellLabels(date) {
        const cell = document.querySelector('[data-testid="day-' + date + '"]');
        if (!cell) return null;
        return Array.from(cell.querySelectorAll('[aria-label]')).map((el) =>
          el.getAttribute('aria-label'),
        );
      },
      chipDay(label) {
        const element = findAria(label);
        return element
          ? element.closest('[data-date]')?.getAttribute('data-date') || null
          : null;
      },
      tabSelected(name) {
        const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(
          (el) => normalize(el.textContent) === normalize(name),
        );
        return tab ? tab.getAttribute('aria-selected') === 'true' : false;
      },
      toolSet(sectionLabel, labelText, value) {
        const section = findAria(sectionLabel);
        if (!section) throw new Error('找不到工具区：' + sectionLabel);
        return setControlValue(labelControl(section, labelText), value);
      },
      toolValue(sectionLabel, labelText) {
        const section = findAria(sectionLabel);
        if (!section) throw new Error('找不到工具区：' + sectionLabel);
        return labelControl(section, labelText).value;
      },
      toolText(sectionLabel, selector) {
        const section = findAria(sectionLabel);
        if (!section) throw new Error('找不到工具区：' + sectionLabel);
        const element = section.querySelector(selector);
        return element ? normalize(element.textContent) : null;
      },
      toolButton(sectionLabel, text) {
        const section = findAria(sectionLabel);
        if (!section) throw new Error('找不到工具区：' + sectionLabel);
        const button = findText('button', text) || Array.from(section.querySelectorAll('button')).find(
          (el) => normalize(el.textContent) === normalize(text),
        );
        if (!button) throw new Error('找不到工具按钮：' + sectionLabel + ' / ' + text);
        button.click();
        return true;
      },
      daysResult() {
        return document.querySelector('[data-testid="days-result"]')?.textContent ?? null;
      },
      lunarResult() {
        return document.querySelector('[data-testid="lunar-result"]')?.textContent ?? null;
      },
      clockState() {
        const overlay = document.querySelector('[aria-label="沉浸时钟"]');
        if (!overlay) return null;
        const digital = overlay.querySelector('.clock-digital');
        return {
          theme: overlay.getAttribute('data-theme'),
          mode: overlay.getAttribute('data-mode'),
          digitalText: digital ? normalize(digital.textContent) : null,
          analog: Boolean(overlay.querySelector('.clock-analog')),
          seconds: overlay.querySelector('.clock-seconds')?.textContent ?? null,
          ampm: overlay.querySelector('.clock-ampm')?.textContent ?? null,
          controls: Array.from(overlay.querySelectorAll('.clock-control')).map(
            (el) => normalize(el.textContent),
          ),
          background: getComputedStyle(overlay).backgroundColor,
          backgroundImage: getComputedStyle(overlay).backgroundImage,
        };
      },
      clockButton(text) {
        const overlay = document.querySelector('[aria-label="沉浸时钟"]');
        if (!overlay) throw new Error('时钟未打开');
        const button = Array.from(overlay.querySelectorAll('button')).find(
          (el) => normalize(el.textContent) === normalize(text),
        );
        if (!button) throw new Error('找不到时钟按钮：' + text);
        button.click();
        return true;
      },
      wake() {
        return JSON.parse(JSON.stringify(window.__ZX_WAKE__));
      },
      setWakeMode(mode) {
        window.__ZX_WAKE__.mode = mode;
      },
      fullscreen() {
        return JSON.parse(JSON.stringify(window.__ZX_FULLSCREEN__));
      },
      setWakeCounters() {
        window.__ZX_WAKE__.requests = [];
        window.__ZX_WAKE__.releases = 0;
        window.__ZX_FULLSCREEN__.requests = 0;
        return true;
      },
      invoke(command, args) {
        return world.invoke(command, args);
      },
      countTasks() {
        return active(world.db.tasks).length;
      },
      bodyText() {
        return normalize(document.body.innerText);
      },
      snapshot() {
        return {
          events: JSON.parse(JSON.stringify(world.db.events)),
          countdowns: JSON.parse(JSON.stringify(world.db.countdowns)),
          tasks: JSON.parse(JSON.stringify(world.db.tasks)),
        };
      },
    };
  } catch (error) {
    window.__ZX_INIT_ERROR__ = String(error?.stack ?? error);
  }
})();`.replace('  __ZX_FAKE_BUNDLE__\n', () => fakeBundle);

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.addScriptToEvaluateOnNewDocument', { source: injection });

async function navigate(url) {
  await send('Page.navigate', { url });
  await waitFor(
    `document.readyState === 'complete' && document.body && document.body.innerText.includes('今天')`,
    `页面加载 ${url}`,
  );
  const initError = await evaluate('window.__ZX_INIT_ERROR__ ?? null');
  if (initError) throw new Error(`注入初始化失败：${initError}`);
}

async function reload() {
  await send('Page.reload');
  await waitFor(
    `document.readyState === 'complete' && document.body && document.body.innerText.includes('今天')`,
    '页面刷新完成',
  );
  const initError = await evaluate('window.__ZX_INIT_ERROR__ ?? null');
  if (initError) throw new Error(`刷新注入失败：${initError}`);
}

async function waitCalendarTabs() {
  await waitFor(
    `document.querySelectorAll('[role="tab"]').length === 4 && Array.from(document.querySelectorAll('[role="tab"]')).some((el) => el.textContent.trim() === '事件')`,
    '日历分区就绪',
  );
}

async function selectCalendarDay(date) {
  // 点日期格左上角的日号区域，避开格内任务/事件芯片（芯片点击会跳转详情）。
  await clickSelectorOffset(
    `[data-testid="day-${date}"]`,
    24,
    18,
    `日期格 ${date}`,
  );
  await waitFor(
    `document.querySelector('[data-testid="day-${date}"]')?.getAttribute('aria-selected') === 'true'`,
    `选中日期 ${date}`,
  );
}

async function openCalendarTab(name) {
  await clickText('[role="tab"]', name);
  await waitFor(
    `Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.textContent.trim() === ${JSON.stringify(name)})?.getAttribute('aria-selected') === 'true'`,
    `切换到 ${name} 分区`,
  );
}

async function openTool(name) {
  await clickText('.calendar-tool-tab', name);
  await sleep(150);
}

async function openClock() {
  await clickText('.calendar-tool-tab', '全屏时钟');
  await waitFor(
    `Array.from(document.querySelectorAll('.calendar-tool-tab')).some((el) => el.textContent.trim() === '全屏时钟')`,
    '全屏时钟工具卡',
  );
  await clickText('.calendar-clock-card button', '打开全屏时钟');
  await waitFor(
    `document.querySelector('[aria-label="沉浸时钟"]') !== null`,
    '沉浸时钟打开',
  );
  await sleep(250);
}

async function closeClockByEscape() {
  await pressEscape();
  await waitFor(
    `document.querySelector('[aria-label="沉浸时钟"]') === null`,
    '按 ESC 关闭沉浸时钟',
  );
  await sleep(150);
}

try {
  await navigate(`http://127.0.0.1:${PORT}/calendar`);
  await waitCalendarTabs();
  const today = await evaluate('window.__ZX_WORLD__.today');
  const tomorrow = addDays(today, 1);
  const dayAfter = addDays(today, 2);
  const dayAfter2 = addDays(today, 3);
  const springTarget = '2026-02-17';
  const nextSpring = '2027-02-07';
  const expectedSpringDays = diffDays(today, nextSpring);
  note('真实 Chromium 已加载知行生产构建', {
    today,
    tomorrow,
    dayAfter,
    dayAfter2,
    nextSpring,
    expectedSpringDays,
    fakeWorld: await evaluate('window.__ZX_TEST__.snapshot()'),
  });
  await screenshot('00-calendar-initial.png');

  // ------------------------------------------------------------------
  // F-012 事件：空态 / 新建 / 编辑 / 建任务 / 删除 / 刷新
  // ------------------------------------------------------------------
  await runCase(
    {
      id: 'F-012-01',
      feature: 'F-012 事件',
      name: '空日期事件分区空态',
      expected: '选中无事件日期后，事件分区显示「这一天没有事件」',
    },
    async () => {
      await selectCalendarDay(tomorrow);
      await openCalendarTab('事件');
      await waitFor(
        `document.querySelector('[aria-label="当天事件"]')?.innerText.includes('这一天没有事件')`,
        '事件空态',
      );
      return await evaluate(
        `document.querySelector('[aria-label="当天事件"]')?.innerText`,
      );
    },
    '01-events-empty.png',
  );

  {
    const meta = {
      id: 'F-012-12',
      feature: 'F-012 事件',
      name: '事件历法（公历/农历）字段',
      expected:
        '新建事件弹层包含「历法：公历/农历」；保存后事件带 calendarType（PRD §3.6.8 验收 5）',
    };
    let verdict = 'FAIL';
    let actual = null;
    try {
      await clickAria('事件分区新建事件');
      await waitFor(`!!document.querySelector('.task-dialog')`, '新建事件弹层（历法检查）');
      const labels = await evaluate(
        `Array.from(document.querySelectorAll('.task-dialog label')).map((label) => (label.childNodes[0]?.textContent || '').trim()).filter(Boolean)`,
      );
      let fieldError = null;
      try {
        await evaluate(`window.__ZX_TEST__.setDialogField('历法', 'lunar')`);
      } catch (error) {
        fieldError = error?.message ?? String(error);
      }
      const modelHasField = await evaluate(
        `Object.prototype.hasOwnProperty.call(window.__ZX_TEST__.event('event-review'), 'calendarType')`,
      );
      await screenshot('02a-event-dialog-fields.png');
      actual = { labels, fieldError, modelHasField };
      verdict =
        labels.some((label) => label.includes('历法')) &&
        !fieldError &&
        modelHasField
          ? 'PASS'
          : 'FAIL';
      record(
        meta,
        verdict,
        {
          ...actual,
          defect: verdict === 'FAIL' ? 'DEF-AUD014-02 待开卡' : null,
        },
        '02a-event-dialog-fields.png',
      );
    } catch (error) {
      actual = error?.message ?? String(error);
      try {
        await screenshot('02a-event-dialog-fields-FAIL.png');
      } catch {
        // 忽略截图失败。
      }
      record(meta, 'FAIL', actual, '02a-event-dialog-fields-FAIL.png');
    } finally {
      const open = await evaluate(
        `document.querySelector('.task-dialog') !== null`,
      ).catch(() => false);
      if (open) {
        await clickText('.task-dialog-actions button', '取消').catch(() => {});
        await waitFor(
          `document.querySelector('.task-dialog') === null`,
          '关闭历法检查弹层',
        ).catch(() => {});
      }
    }
  }

  await runCase(
    {
      id: 'F-012-02',
      feature: 'F-012 事件',
      name: '新建事件（标题/日期/时间/类别/重复/关联笔记）',
      expected:
        '保存后事件写入本地库，字段为日期 tomorrow、14:30、会议、每周、关联笔记 note-welcome',
    },
    async () => {
      await clickAria('事件分区新建事件');
      await waitFor(`!!document.querySelector('.task-dialog')`, '新建事件弹层');
      const dialogTitle = await evaluate('window.__ZX_TEST__.dialog().title');
      await evaluate(`window.__ZX_TEST__.setDialogField('标题', '验收事件A')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('日期', '${tomorrow}')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('时间', '14:30')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('类别', '会议')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('重复', '每周')`);
      await waitFor(
        `Array.from(document.querySelectorAll('.task-dialog option')).some((option) => option.value === 'note-welcome')`,
        '关联笔记选项加载',
      );
      await evaluate(
        `window.__ZX_TEST__.setDialogField('关联笔记', 'note-welcome')`,
      );
      const draft = {
        title: await evaluate(`window.__ZX_TEST__.dialogValue('标题')`),
        date: await evaluate(`window.__ZX_TEST__.dialogValue('日期')`),
        time: await evaluate(`window.__ZX_TEST__.dialogValue('时间')`),
        type: await evaluate(`window.__ZX_TEST__.dialogValue('类别')`),
        repeat: await evaluate(`window.__ZX_TEST__.dialogValue('重复')`),
        note: await evaluate(`window.__ZX_TEST__.dialogValue('关联笔记')`),
      };
      await screenshot('02-event-dialog.png');
      await clickText('.task-dialog-actions button', '保存');
      await waitFor(
        `!document.querySelector('.task-dialog') && window.__ZX_TEST__.events().some((row) => row.title === '验收事件A')`,
        '事件保存并刷新',
      );
      const event = await evaluate(
        `window.__ZX_TEST__.events().find((row) => row.title === '验收事件A')`,
      );
      ensure(dialogTitle === '新建事件', `弹层标题应为新建事件，实际 ${dialogTitle}`);
      ensure(event.startDate === tomorrow, `日期应为 ${tomorrow}`);
      ensure(event.startAt === `${tomorrow}T14:30:00`, `startAt 应为 14:30`);
      ensure(event.allDay === false, 'allDay 应为 false');
      ensure(event.eventType === '会议', `类别应为会议，实际 ${event.eventType}`);
      ensure(event.repeatRule === '每周', `重复应为每周，实际 ${event.repeatRule}`);
      ensure(event.noteId === 'note-welcome', `关联笔记应为 note-welcome`);
      return { dialogTitle, draft, event };
    },
    '03-event-created.png',
  );

  await runCase(
    {
      id: 'F-012-03',
      feature: 'F-012 事件',
      name: '事件列表展示且没有完成状态',
      expected: '当天事件行显示 14:30 / 会议 / 每周 / 关联笔记，且没有 checkbox 或「完成」按钮',
    },
    async () => {
      const event = await evaluate(
        `window.__ZX_TEST__.events().find((row) => row.title === '验收事件A')`,
      );
      await waitFor(
        `document.querySelector('[data-event-id="${event.id}"]') !== null`,
        '事件行出现',
      );
      const row = await evaluate(
        `(() => {
          const row = document.querySelector('[data-event-id="${event.id}"]');
          return {
            text: (row?.textContent || '').replace(/\\s+/g, ' ').trim(),
            checkbox: Boolean(row?.querySelector('input[type="checkbox"]')),
            done: Array.from(row?.querySelectorAll('button') || []).some((el) => (el.textContent || '').includes('完成')),
          };
        })()`,
      );
      ensure(row.text.includes('验收事件A'), '事件行缺少标题');
      ensure(row.text.includes('14:30'), '事件行缺少时间');
      ensure(row.text.includes('会议'), '事件行缺少类别');
      ensure(row.text.includes('每周'), '事件行缺少重复');
      ensure(row.text.includes('关联笔记'), '事件行缺少关联笔记标记');
      ensure(!row.checkbox && !row.done, '事件不应有完成控件');
      return row;
    },
    '04-event-row.png',
  );

  await runCase(
    {
      id: 'F-012-04',
      feature: 'F-012 事件',
      name: '新建事件同步投影到月历',
      expected: '日历月视图中 tomorrow 日期格出现「事件：验收事件A」芯片',
    },
    async () => {
      await openCalendarTab('日历');
      await waitFor(
        `document.querySelector('[data-testid="month-grid"]') !== null`,
        '月视图',
      );
      await selectCalendarDay(tomorrow);
      const labels = await evaluate(
        `window.__ZX_TEST__.cellLabels('${tomorrow}')`,
      );
      ensure(
        labels?.includes('事件：验收事件A'),
        `月历缺少事件芯片：${JSON.stringify(labels)}`,
      );
      return labels;
    },
    '05-event-calendar-chip.png',
  );

  await runCase(
    {
      id: 'F-012-05',
      feature: 'F-012 事件',
      name: '刷新后事件仍在（localStorage 持久化）',
      expected: '刷新并重新选择 tomorrow 后，事件行仍存在且字段不变',
    },
    async () => {
      await reload();
      await waitCalendarTabs();
      await selectCalendarDay(tomorrow);
      await openCalendarTab('事件');
      await waitFor(
        `document.querySelector('[aria-label="当天事件"]')?.innerText.includes('验收事件A')`,
        '刷新后事件仍在',
      );
      const event = await evaluate(
        `window.__ZX_TEST__.events().find((row) => row.title === '验收事件A')`,
      );
      ensure(event?.startAt === `${tomorrow}T14:30:00`, '刷新后时间丢失');
      return {
        text: await evaluate(
          `document.querySelector('[aria-label="当天事件"]')?.innerText`,
        ),
        startAt: event.startAt,
      };
    },
    '06-event-after-reload.png',
  );

  await runCase(
    {
      id: 'F-012-06',
      feature: 'F-012 事件',
      name: '编辑事件（标题/日期/时间/类别/重复）',
      expected:
        '保存后事件改到 dayAfter 09:05、工作日程、每年；旧日期芯片消失，新日期芯片出现',
    },
    async () => {
      const event = await evaluate(
        `window.__ZX_TEST__.events().find((row) => row.title === '验收事件A')`,
      );
      await clickAria(`编辑事件「验收事件A」`);
      await waitFor(
        `window.__ZX_TEST__.dialog()?.title === '编辑事件'`,
        '编辑事件弹层',
      );
      await waitFor(
        `window.__ZX_TEST__.dialogValue('关联笔记') === 'note-welcome'`,
        '编辑弹层关联笔记回填',
      );
      const initial = {
        title: await evaluate(`window.__ZX_TEST__.dialogValue('标题')`),
        date: await evaluate(`window.__ZX_TEST__.dialogValue('日期')`),
        time: await evaluate(`window.__ZX_TEST__.dialogValue('时间')`),
        type: await evaluate(`window.__ZX_TEST__.dialogValue('类别')`),
        repeat: await evaluate(`window.__ZX_TEST__.dialogValue('重复')`),
        note: await evaluate(`window.__ZX_TEST__.dialogValue('关联笔记')`),
      };
      ensure(initial.title === '验收事件A', '编辑弹层未回填标题');
      ensure(initial.date === tomorrow, '编辑弹层未回填日期');
      ensure(initial.time === '14:30', '编辑弹层未回填时间');
      ensure(initial.type === '会议', '编辑弹层未回填类别');
      ensure(initial.repeat === '每周', '编辑弹层未回填重复');
      ensure(initial.note === 'note-welcome', '编辑弹层未回填关联笔记');

      await evaluate(`window.__ZX_TEST__.setDialogField('标题', '验收事件A改')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('日期', '${dayAfter}')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('时间', '09:05')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('类别', '工作日程')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('重复', '每年')`);
      await screenshot('07-event-edit-dialog.png');
      await clickText('.task-dialog-actions button', '保存');
      await waitFor(
        `window.__ZX_TEST__.events().some((row) => row.title === '验收事件A改')`,
        '事件编辑保存',
      );
      const updated = await evaluate(
        `window.__ZX_TEST__.event('${event.id}')`,
      );
      ensure(updated.startDate === dayAfter, `日期应改为 ${dayAfter}`);
      ensure(updated.startAt === `${dayAfter}T09:05:00`, '时间应改为 09:05');
      ensure(updated.allDay === false, '编辑后 allDay 应为 false');
      ensure(updated.eventType === '工作日程', '类别应改为工作日程');
      ensure(updated.repeatRule === '每年', '重复应改为每年');
      ensure(updated.noteId === 'note-welcome', '关联笔记应保留');
      ensure(updated.version > event.version, '版本号应递增');

      await openCalendarTab('日历');
      await selectCalendarDay(tomorrow);
      const oldLabels = await evaluate(
        `window.__ZX_TEST__.cellLabels('${tomorrow}')`,
      );
      await selectCalendarDay(dayAfter);
      const newLabels = await evaluate(
        `window.__ZX_TEST__.cellLabels('${dayAfter}')`,
      );
      ensure(
        !oldLabels?.includes('事件：验收事件A改'),
        '旧日期不应再显示事件',
      );
      ensure(
        newLabels?.includes('事件：验收事件A改'),
        '新日期应显示事件',
      );
      return { initial, updated, oldLabels, newLabels };
    },
    '08-event-edited.png',
  );

  let eventTaskTitle = '准备：验收事件A改';
  await runCase(
    {
      id: 'F-012-07',
      feature: 'F-012 事件',
      name: '从事件创建独立任务',
      expected:
        '生成「准备：验收事件A改」任务：工作清单、象限 1、优先级 3、日期/时间沿用事件、notes 含关联事件；事件本身保留不变',
    },
    async () => {
      await openCalendarTab('事件');
      const event = await evaluate(
        `window.__ZX_TEST__.events().find((row) => row.title === '验收事件A改')`,
      );
      await clickAria('从事件「验收事件A改」建任务');
      await waitFor(
        `window.__ZX_TEST__.tasks().some((row) => row.title === '${eventTaskTitle}')`,
        '事件建任务',
      );
      const task = await evaluate(
        `window.__ZX_TEST__.taskByTitle('${eventTaskTitle}')`,
      );
      const eventAfter = await evaluate(
        `window.__ZX_TEST__.event('${event.id}')`,
      );
      ensure(task.listId === 'work', `任务清单应为 work，实际 ${task.listId}`);
      ensure(task.quadrant === 1, `任务象限应为 1，实际 ${task.quadrant}`);
      ensure(task.priority === 3, `任务优先级应为 3，实际 ${task.priority}`);
      ensure(task.dueDate === dayAfter, `任务日期应为 ${dayAfter}`);
      ensure(task.dueTime === '09:05', '任务时间应为 09:05');
      ensure(task.status === 'todo', '任务状态应为 todo');
      ensure(
        String(task.notes).includes('关联事件：验收事件A改'),
        '任务备注应含关联事件',
      );
      ensure(eventAfter.deletedAt === null, '建任务后事件不应被删除');
      ensure(eventAfter.version === event.version, '建任务不应修改事件');
      return { task, eventAfter };
    },
    '09-event-to-task.png',
  );

  await runCase(
    {
      id: 'F-012-08',
      feature: 'F-012 事件',
      name: '删除事件（先取消，再确认）且不影响已建任务',
      expected:
        '取消后事件保留；再次删除确认后事件软删除并从列表/月历消失，已创建任务仍存在',
    },
    async () => {
      const event = await evaluate(
        `window.__ZX_TEST__.events().find((row) => row.title === '验收事件A改')`,
      );
      await clickAria('删除事件「验收事件A改」');
      await waitFor(
        `window.__ZX_TEST__.dialog()?.title === '删除这个事件？'`,
        '删除事件确认弹层',
      );
      const confirmText = await evaluate('window.__ZX_TEST__.dialog().text');
      await screenshot('10-event-delete-confirm.png');
      await clickText('.task-dialog-actions button', '取消');
      await waitFor(`!document.querySelector('.task-dialog')`, '取消删除');
      const afterCancel = await evaluate(
        `window.__ZX_TEST__.event('${event.id}')`,
      );
      ensure(afterCancel.deletedAt === null, '取消后事件不应被删除');

      await clickAria('删除事件「验收事件A改」');
      await waitFor(
        `window.__ZX_TEST__.dialog()?.title === '删除这个事件？'`,
        '再次打开删除确认',
      );
      await clickText('.task-dialog-actions button', '删除事件');
      await waitFor(
        `window.__ZX_TEST__.event('${event.id}')?.deletedAt !== null`,
        '事件软删除',
      );
      const rowGone = await waitFor(
        `document.querySelector('[data-event-id="${event.id}"]') === null`,
        '事件行消失',
      );
      const taskStill = await evaluate(
        `window.__ZX_TEST__.taskByTitle('${eventTaskTitle}')`,
      );
      ensure(taskStill?.deletedAt === null, '删除事件不应删除已建任务');
      await openCalendarTab('日历');
      await selectCalendarDay(dayAfter);
      const labels = await evaluate(
        `window.__ZX_TEST__.cellLabels('${dayAfter}')`,
      );
      ensure(
        !labels?.includes('事件：验收事件A改'),
        '删除后月历不应再有事件芯片',
      );
      return { confirmText, rowGone, taskStill: taskStill?.id };
    },
    '11-event-deleted.png',
  );

  await runCase(
    {
      id: 'F-012-11',
      feature: 'F-012 事件',
      name: '删除事件后任务仍可在工作清单打开',
      expected:
        '删除事件后，「准备：验收事件A改」仍在工作清单中可见且可打开',
    },
    async () => {
      const deleted = await evaluate(
        `window.__ZX_TEST__.event('event-1')?.deletedAt !== null`,
      );
      ensure(deleted, '事件未删除，无法验证任务独立性');
      await navigate(`http://127.0.0.1:${PORT}/lists/work`);
      await waitFor(
        `window.__ZX_TEST__.existsAria('查看任务：${eventTaskTitle}')`,
        '工作清单出现事件创建的任务',
      );
      const text = await evaluate(
        `window.__ZX_TEST__.ariaText('查看任务：${eventTaskTitle}')`,
      );
      ensure(String(text).includes(eventTaskTitle), '工作清单任务标题错误');
      await navigate(`http://127.0.0.1:${PORT}/calendar`);
      await waitCalendarTabs();
      return { text, deleted };
    },
    '12-event-task-list.png',
  );

  await observeCase(
    {
      id: 'F-012-09',
      feature: 'F-012 事件',
      name: '快速连点「从事件建任务」',
      expected: '一次用户意图（双击）只应创建一个任务',
    },
    async () => {
      await openCalendarTab('日历');
      await selectCalendarDay(today);
      await openCalendarTab('事件');
      await waitFor(
        `window.__ZX_TEST__.existsAria('从事件「产品评审会」建任务')`,
        '种子事件行',
      );
      const before = await evaluate(
        `window.__ZX_TEST__.tasksByTitle('准备：产品评审会').length`,
      );
      await doubleClickAria('从事件「产品评审会」建任务');
      await sleep(1200);
      const after = await evaluate(
        `window.__ZX_TEST__.tasksByTitle('准备：产品评审会').length`,
      );
      const created = after - before;
      return {
        verdict: created <= 1 ? 'PASS' : 'FAIL',
        detail: {
          before,
          after,
          created,
          defect: created > 1 ? 'DEF-AUD014-01 待开卡' : null,
        },
      };
    },
    '13-event-rapid-create-task.png',
  );

  await runCase(
    {
      id: 'F-012-10',
      feature: 'F-012 事件',
      name: '删除不存在的事件/倒数日',
      expected: 'IPC 返回明确错误，事件与倒数日数量不变',
    },
    async () => {
      const before = await evaluate('window.__ZX_TEST__.snapshot()');
      const eventError = await evaluate(`(async () => {
        try {
          await window.__ZX_TEST__.invoke('events_delete', { id: 'missing-event-aud014' });
          return 'unexpected-ok';
        } catch (error) {
          return 'error:' + (error?.message ?? String(error));
        }
      })()`);
      const countdownError = await evaluate(`(async () => {
        try {
          await window.__ZX_TEST__.invoke('countdowns_delete', { id: 'missing-countdown-aud014' });
          return 'unexpected-ok';
        } catch (error) {
          return 'error:' + (error?.message ?? String(error));
        }
      })()`);
      const after = await evaluate('window.__ZX_TEST__.snapshot()');
      ensure(eventError.startsWith('error:'), `删除不存在事件未报错：${eventError}`);
      ensure(
        countdownError.startsWith('error:'),
        `删除不存在倒数日未报错：${countdownError}`,
      );
      ensure(
        before.events.length === after.events.length,
        '删除不存在事件改变了事件数据',
      );
      ensure(
        before.countdowns.length === after.countdowns.length,
        '删除不存在倒数日改变了倒数日数据',
      );
      return { eventError, countdownError };
    },
    '14-delete-missing.png',
  );

  // ------------------------------------------------------------------
  // F-013 倒数日：农历「每年下一次」
  // ------------------------------------------------------------------

  let springId = null;
  await runCase(
    {
      id: 'F-013-01',
      feature: 'F-013 倒数日',
      name: '新建农历「每年（农历）」倒数日',
      expected:
        '保存为农历、每年（农历），派生 lunarMonth=正月、lunarDay=1，目标日 2026-02-17',
    },
    async () => {
      await openCalendarTab('倒数日');
      await clickAria('新建倒数日');
      await waitFor(`window.__ZX_TEST__.dialog()?.title === '新建倒数日'`, '倒数日弹层');
      await evaluate(`window.__ZX_TEST__.setDialogField('名称', '春节验收')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('分类', '热门节日')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('历法', 'lunar')`);
      await evaluate(
        `window.__ZX_TEST__.setDialogField('目标日期', '${springTarget}')`,
      );
      await waitFor(
        `Array.from(document.querySelectorAll('.task-dialog option')).some((option) => option.value === '每年（农历）')`,
        '农历每年重复选项',
      );
      await evaluate(
        `window.__ZX_TEST__.setDialogField('重复', '每年（农历）')`,
      );
      await evaluate(`window.__ZX_TEST__.setDialogField('备注', '农历新年')`);
      const preview = await evaluate(
        `document.querySelector('[data-testid="countdown-lunar-preview"]')?.textContent ?? null`,
      );
      const draft = {
        name: await evaluate(`window.__ZX_TEST__.dialogValue('名称')`),
        category: await evaluate(`window.__ZX_TEST__.dialogValue('分类')`),
        calendar: await evaluate(`window.__ZX_TEST__.dialogValue('历法')`),
        date: await evaluate(`window.__ZX_TEST__.dialogValue('目标日期')`),
        repeat: await evaluate(`window.__ZX_TEST__.dialogValue('重复')`),
        note: await evaluate(`window.__ZX_TEST__.dialogValue('备注')`),
      };
      ensure(draft.calendar === 'lunar', '历法应为 lunar');
      ensure(draft.repeat === '每年（农历）', '重复应为每年（农历）');
      ensure(
        String(preview).includes('正月初一'),
        `农历预览不正确：${preview}`,
      );
      ensure(String(preview).includes('生肖马'), `农历预览缺少生肖：${preview}`);
      await screenshot('15-countdown-dialog.png');
      await clickText('.task-dialog-actions button', '保存');
      await waitFor(
        `window.__ZX_TEST__.countdowns().some((row) => row.title === '春节验收')`,
        '倒数日保存',
      );
      const countdown = await evaluate(
        `window.__ZX_TEST__.countdowns().find((row) => row.title === '春节验收')`,
      );
      ensure(countdown.calendarType === 'lunar', 'calendarType 应为 lunar');
      ensure(
        countdown.repeatRule === '每年（农历）',
        `repeatRule 应为每年（农历），实际 ${countdown.repeatRule}`,
      );
      ensure(countdown.targetDate === springTarget, 'targetDate 应为 2026-02-17');
      ensure(countdown.lunarMonth === '正月', `lunarMonth 应为正月，实际 ${countdown.lunarMonth}`);
      ensure(countdown.lunarDay === 1, `lunarDay 应为 1，实际 ${countdown.lunarDay}`);
      springId = countdown.id;
      return { preview, draft, countdown };
    },
    '16-countdown-created.png',
  );

  await runCase(
    {
      id: 'F-013-02',
      feature: 'F-013 倒数日',
      name: '农历每年在列表显示下一次公历日与剩余天数',
      expected: `列表显示「农历 正月初一 · ${nextSpring} · 每年（农历） · 热门节日」，剩余 ${expectedSpringDays} 天`,
    },
    async () => {
      const row = await evaluate(
        `window.__ZX_TEST__.countdownRowText('${springId}')`,
      );
      ensure(String(row).includes('农历 正月初一'), `列表缺少农历：${row}`);
      ensure(String(row).includes(nextSpring), `列表缺少下一次公历日：${row}`);
      ensure(String(row).includes('每年（农历）'), `列表缺少重复规则：${row}`);
      ensure(
        String(row).includes(String(expectedSpringDays)),
        `列表剩余天数应为 ${expectedSpringDays}：${row}`,
      );
      return row;
    },
    '17-countdown-next-lunar.png',
  );

  await runCase(
    {
      id: 'F-013-03',
      feature: 'F-013 倒数日',
      name: '下一次农历日期投影到月历',
      expected: `${nextSpring} 日期格出现「倒数日：春节验收」芯片`,
    },
    async () => {
      await openCalendarTab('日历');
      for (let index = 0; index < 4; index += 1) {
        await clickAria('下一段');
        await sleep(120);
      }
      await waitFor(
        `document.querySelector('[data-testid="day-${nextSpring}"]') !== null`,
        `月历跳到 ${nextSpring}`,
      );
      const labels = await evaluate(
        `window.__ZX_TEST__.cellLabels('${nextSpring}')`,
      );
      ensure(
        labels?.includes('倒数日：春节验收'),
        `${nextSpring} 缺少倒数日芯片：${JSON.stringify(labels)}`,
      );
      return labels;
    },
    '18-countdown-calendar.png',
  );

  await runCase(
    {
      id: 'F-013-04',
      feature: 'F-013 倒数日',
      name: '刷新后农历下一次日期仍正确',
      expected: '刷新进入倒数日分区后，行内仍显示 2027-02-07 与正月初一',
    },
    async () => {
      await reload();
      await waitCalendarTabs();
      await openCalendarTab('倒数日');
      await waitFor(
        `window.__ZX_TEST__.countdowns().some((row) => row.title === '春节验收')`,
        '刷新后倒数日仍在',
      );
      const row = await evaluate(
        `window.__ZX_TEST__.countdownRowText('${springId}')`,
      );
      ensure(String(row).includes(nextSpring), `刷新后下一次日期丢失：${row}`);
      ensure(String(row).includes('农历 正月初一'), `刷新后农历丢失：${row}`);
      return row;
    },
    '19-countdown-after-reload.png',
  );

  await runCase(
    {
      id: 'F-013-05',
      feature: 'F-013 倒数日',
      name: '编辑/删除倒数日不产生任务；单次过去显示',
      expected:
        '编辑后字段更新；单次过去显示「已过去 N 天」；删除后行消失；任务总数全程不变',
    },
    async () => {
      const tasksBefore = await evaluate('window.__ZX_TEST__.countTasks()');
      await clickAria('编辑倒数日「春节验收」');
      await waitFor(`window.__ZX_TEST__.dialog()?.title === '编辑倒数日'`, '编辑倒数日弹层');
      await evaluate(`window.__ZX_TEST__.setDialogField('名称', '春节验收改')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('分类', '自定义')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('目标日期', '2026-03-01')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('重复', '单次')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('备注', '已改')`);
      await screenshot('20-countdown-edit-dialog.png');
      await clickText('.task-dialog-actions button', '保存');
      await waitFor(
        `window.__ZX_TEST__.countdown('${springId}')?.title === '春节验收改'`,
        '倒数日编辑保存',
      );
      const updated = await evaluate(
        `window.__ZX_TEST__.countdown('${springId}')`,
      );
      ensure(updated.category === '自定义', '分类应改为自定义');
      ensure(updated.targetDate === '2026-03-01', '目标日期应改为 2026-03-01');
      ensure(updated.repeatRule === '单次', '重复应改为单次');
      ensure(updated.note === '已改', '备注应更新');
      const pastRow = await evaluate(
        `window.__ZX_TEST__.countdownRowText('${springId}')`,
      );
      const pastDays = Math.abs(diffDays(today, '2026-03-01'));
      ensure(String(pastRow).includes('已过去'), `单次过去应显示已过去：${pastRow}`);
      ensure(
        String(pastRow).includes(String(pastDays)),
        `单次过去天数应为 ${pastDays}：${pastRow}`,
      );
      await clickAria('删除倒数日「春节验收改」');
      await waitFor(
        `window.__ZX_TEST__.dialog()?.title === '删除这个倒数日？'`,
        '删除倒数日确认',
      );
      await screenshot('21-countdown-delete-confirm.png');
      await clickText('.task-dialog-actions button', '删除倒数日');
      await waitFor(
        `window.__ZX_TEST__.countdown('${springId}')?.deletedAt !== null`,
        '倒数日软删除',
      );
      await waitFor(
        `document.querySelector('[data-countdown-id="${springId}"]') === null`,
        '倒数日行消失',
      );
      const tasksAfter = await evaluate('window.__ZX_TEST__.countTasks()');
      ensure(tasksAfter === tasksBefore, '倒数日编辑/删除不应创建任务');
      return { updated, pastRow, pastDays, tasksBefore, tasksAfter };
    },
    '22-countdown-deleted.png',
  );

  await runCase(
    {
      id: 'F-013-06',
      feature: 'F-013 倒数日',
      name: '公历「每年」下一次公历日',
      expected:
        '目标 2026-01-01 + 每年 → 下一次 2027-01-01，列表显示剩余天数；删除后不产生任务',
    },
    async () => {
      const solarNext = '2027-01-01';
      const expectedDays = diffDays(today, solarNext);
      const tasksBefore = await evaluate('window.__ZX_TEST__.countTasks()');
      await openCalendarTab('倒数日');
      await clickAria('新建倒数日');
      await waitFor(`window.__ZX_TEST__.dialog()?.title === '新建倒数日'`, '公历倒数日弹层');
      await evaluate(`window.__ZX_TEST__.setDialogField('名称', '元旦验收')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('分类', '节假日')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('历法', 'solar')`);
      await evaluate(`window.__ZX_TEST__.setDialogField('目标日期', '2026-01-01')`);
      await waitFor(
        `Array.from(document.querySelectorAll('.task-dialog option')).some((option) => option.value === '每年')`,
        '公历每年选项',
      );
      await evaluate(`window.__ZX_TEST__.setDialogField('重复', '每年')`);
      await clickText('.task-dialog-actions button', '保存');
      await waitFor(
        `window.__ZX_TEST__.countdowns().some((row) => row.title === '元旦验收')`,
        '公历倒数日保存',
      );
      const countdown = await evaluate(
        `window.__ZX_TEST__.countdowns().find((row) => row.title === '元旦验收')`,
      );
      ensure(countdown.calendarType === 'solar', '历法应为 solar');
      ensure(countdown.repeatRule === '每年', `重复应为每年，实际 ${countdown.repeatRule}`);
      ensure(countdown.targetDate === '2026-01-01', '目标日期应为 2026-01-01');
      const row = await evaluate(
        `window.__ZX_TEST__.countdownRowText('${countdown.id}')`,
      );
      ensure(String(row).includes(solarNext), `列表应显示下一次 ${solarNext}：${row}`);
      ensure(String(row).includes('每年'), `列表应显示每年：${row}`);
      ensure(
        String(row).includes(String(expectedDays)),
        `列表剩余天数应为 ${expectedDays}：${row}`,
      );
      await clickAria('删除倒数日「元旦验收」');
      await waitFor(
        `window.__ZX_TEST__.dialog()?.title === '删除这个倒数日？'`,
        '删除公历倒数日确认',
      );
      await clickText('.task-dialog-actions button', '删除倒数日');
      await waitFor(
        `window.__ZX_TEST__.countdown('${countdown.id}')?.deletedAt !== null`,
        '公历倒数日软删除',
      );
      const tasksAfter = await evaluate('window.__ZX_TEST__.countTasks()');
      ensure(tasksAfter === tasksBefore, '公历倒数日不应创建任务');
      return { countdown, row, expectedDays, tasksBefore, tasksAfter };
    },
    '22a-countdown-solar-yearly.png',
  );

  // ------------------------------------------------------------------
  // F-014 小工具
  // ------------------------------------------------------------------
  await runCase(
    {
      id: 'F-014-01',
      feature: 'F-014 小工具',
      name: '天数计算、包含首尾与 +7 天快捷',
      expected:
        '2026-01-01 至 2026-01-31 相隔 30；包含首尾 31；切回 30；+7 天把日期 2 改为 2026-10-08 且结果 7',
    },
    async () => {
      await openCalendarTab('小工具');
      await waitFor(
        `document.querySelector('[aria-label="天数计算"]') !== null`,
        '天数计算卡',
      );
      await evaluate(`window.__ZX_TEST__.toolSet('天数计算', '时间 1', '2026-01-01')`);
      await evaluate(`window.__ZX_TEST__.toolSet('天数计算', '时间 2', '2026-01-31')`);
      await waitFor(
        `document.querySelector('[data-testid="days-result"]')?.textContent === '30'`,
        '天数 30',
      );
      const normal = await evaluate('window.__ZX_TEST__.daysResult()');
      await evaluate(`window.__ZX_TEST__.toolButton('天数计算', '切换：包含首尾')`);
      await waitFor(
        `document.querySelector('[data-testid="days-result"]')?.textContent === '31'`,
        '包含首尾 31',
      );
      const inclusive = await evaluate('window.__ZX_TEST__.daysResult()');
      await evaluate(`window.__ZX_TEST__.toolButton('天数计算', '切换：不包含首尾')`);
      await waitFor(
        `document.querySelector('[data-testid="days-result"]')?.textContent === '30'`,
        '切回 30',
      );
      const back = await evaluate('window.__ZX_TEST__.daysResult()');
      ensure(normal === '30', `相隔天数应为 30，实际 ${normal}`);
      ensure(inclusive === '31', `包含首尾应为 31，实际 ${inclusive}`);
      ensure(back === '30', `切回应为 30，实际 ${back}`);

      await evaluate(
        `window.__ZX_TEST__.toolSet('天数计算', '时间 1', '2026-10-01')`,
      );
      await evaluate(`window.__ZX_TEST__.toolButton('天数计算', '+7 天')`);
      await waitFor(
        `window.__ZX_TEST__.toolValue('天数计算', '时间 2') === '2026-10-08'`,
        '+7 天更新日期 2',
      );
      const plus7 = {
        dateB: await evaluate(
          `window.__ZX_TEST__.toolValue('天数计算', '时间 2')`,
        ),
        result: await evaluate('window.__ZX_TEST__.daysResult()'),
      };
      ensure(plus7.result === '7', `+7 天后结果应为 7，实际 ${plus7.result}`);
      return { normal, inclusive, back, plus7 };
    },
    '23-tools-days.png',
  );

  await runCase(
    {
      id: 'F-014-02',
      feature: 'F-014 小工具',
      name: '农历转换',
      expected: '2026-02-17 对应「丙午年 正月初一 生肖马」',
    },
    async () => {
      await openTool('农历转换');
      await waitFor(
        `document.querySelector('[aria-label="农历转换"]') !== null`,
        '农历转换卡',
      );
      await evaluate(
        `window.__ZX_TEST__.toolSet('农历转换', '公历日期', '${springTarget}')`,
      );
      await waitFor(
        `document.querySelector('[data-testid="lunar-result"]')?.textContent?.includes('正月初一')`,
        '农历转换结果',
      );
      const text = await evaluate('window.__ZX_TEST__.lunarResult()');
      ensure(String(text).includes('丙午年'), `农历结果缺少年份：${text}`);
      ensure(String(text).includes('正月初一'), `农历结果缺少月日：${text}`);
      ensure(String(text).includes('生肖马'), `农历结果缺少生肖：${text}`);
      return text;
    },
    '24-tools-lunar.png',
  );

  await runCase(
    {
      id: 'F-014-03',
      feature: 'F-014 小工具',
      name: '生肖查询（含 1899 越界）',
      expected:
        '1990 年属马，并列出 1990/1978/1966/1954 出生年份；1899 仍按公式渲染、不崩溃',
    },
    async () => {
      await openTool('生肖查询');
      await waitFor(
        `document.querySelector('[aria-label="生肖查询"]') !== null`,
        '生肖查询卡',
      );
      await evaluate(`window.__ZX_TEST__.toolSet('生肖查询', '查询年份', '1990')`);
      await waitFor(
        `document.querySelector('[aria-label="生肖查询"]')?.innerText.includes('1990 年 · 属马')`,
        '生肖查询结果',
      );
      const text = await evaluate(
        `document.querySelector('[aria-label="生肖查询"]')?.innerText`,
      );
      ensure(String(text).includes('1990 年 · 属马'), '生肖结果不正确');
      for (const year of ['1990', '1978', '1966', '1954']) {
        ensure(String(text).includes(`${year} 年出生`), `缺少 ${year} 出生年份`);
      }
      await evaluate(`window.__ZX_TEST__.toolSet('生肖查询', '查询年份', '1899')`);
      await waitFor(
        `document.querySelector('[aria-label="生肖查询"]')?.innerText.includes('1899 年 · 属')`,
        '1899 年边界仍可计算',
      );
      const boundaryText = await evaluate(
        `document.querySelector('[aria-label="生肖查询"]')?.innerText`,
      );
      ensure(String(boundaryText).includes('1899 年 · 属'), '1899 年边界未渲染');
      return { text, boundary: boundaryText };
    },
    '25-tools-zodiac.png',
  );

  let toolCountdownId = null;
  await runCase(
    {
      id: 'F-014-04',
      feature: 'F-014 小工具',
      name: '农历转换「加入倒数日」预填并保存',
      expected:
        '切到倒数日并打开预填弹层：农历纪念日/纪念日·生日/农历/2026-02-17/每年（农历）；保存后生成倒数日且不新建任务',
    },
    async () => {
      const tasksBefore = await evaluate('window.__ZX_TEST__.countTasks()');
      await openTool('农历转换');
      await evaluate(
        `window.__ZX_TEST__.toolSet('农历转换', '公历日期', '${springTarget}')`,
      );
      await evaluate(`window.__ZX_TEST__.toolButton('农历转换', '加入倒数日')`);
      await waitFor(
        `window.__ZX_TEST__.dialog()?.title === '新建倒数日'`,
        '工具转倒数日弹层',
      );
      await waitFor(
        `window.__ZX_TEST__.tabSelected('倒数日')`,
        '切到倒数日分区',
      );
      const prefill = {
        name: await evaluate(`window.__ZX_TEST__.dialogValue('名称')`),
        category: await evaluate(`window.__ZX_TEST__.dialogValue('分类')`),
        calendar: await evaluate(`window.__ZX_TEST__.dialogValue('历法')`),
        date: await evaluate(`window.__ZX_TEST__.dialogValue('目标日期')`),
        repeat: await evaluate(`window.__ZX_TEST__.dialogValue('重复')`),
        note: await evaluate(`window.__ZX_TEST__.dialogValue('备注')`),
      };
      ensure(prefill.name === '农历纪念日', `预填名称错误：${prefill.name}`);
      ensure(
        prefill.category === '纪念日·生日',
        `预填分类错误：${prefill.category}`,
      );
      ensure(prefill.calendar === 'lunar', '预填历法应为农历');
      ensure(prefill.date === springTarget, '预填目标日期错误');
      ensure(
        prefill.repeat === '每年（农历）',
        `预填重复错误：${prefill.repeat}`,
      );
      ensure(
        String(prefill.note).includes('由农历转换创建'),
        `预填备注错误：${prefill.note}`,
      );
      await screenshot('26-tools-prefill-dialog.png');
      await clickText('.task-dialog-actions button', '保存');
      await waitFor(
        `window.__ZX_TEST__.countdowns().some((row) => row.title === '农历纪念日')`,
        '工具倒数日保存',
      );
      const countdown = await evaluate(
        `window.__ZX_TEST__.countdowns().find((row) => row.title === '农历纪念日')`,
      );
      ensure(countdown.calendarType === 'lunar', '保存后历法应为农历');
      ensure(
        countdown.repeatRule === '每年（农历）',
        `保存后重复应为每年（农历），实际 ${countdown.repeatRule}`,
      );
      ensure(countdown.lunarMonth === '正月', '保存后应派生正月');
      ensure(countdown.lunarDay === 1, '保存后应派生初一');
      toolCountdownId = countdown.id;
      const tasksAfter = await evaluate('window.__ZX_TEST__.countTasks()');
      ensure(tasksAfter === tasksBefore, '加入倒数日不应创建任务');
      const row = await evaluate(
        `window.__ZX_TEST__.countdownRowText('${countdown.id}')`,
      );
      ensure(String(row).includes(nextSpring), `工具倒数日缺少下一次日期：${row}`);
      return { prefill, countdown, tasksBefore, tasksAfter, row };
    },
    '27-tools-countdown-saved.png',
  );

  await runCase(
    {
      id: 'F-014-05',
      feature: 'F-014 小工具',
      name: '无效日期与空分类',
      expected:
        '清空农历日期显示「农历数据暂不可用」且「加入倒数日」不打开弹层；节气分类显示空态',
    },
    async () => {
      await openCalendarTab('小工具');
      await openTool('农历转换');
      await evaluate(`window.__ZX_TEST__.toolSet('农历转换', '公历日期', '')`);
      await waitFor(
        `document.querySelector('[data-testid="lunar-result"]')?.textContent === '农历数据暂不可用'`,
        '无效农历日期提示',
      );
      const invalidText = await evaluate('window.__ZX_TEST__.lunarResult()');
      const beforeDialog = await evaluate('window.__ZX_TEST__.dialogOpen()');
      await evaluate(`window.__ZX_TEST__.toolButton('农历转换', '加入倒数日')`);
      await sleep(300);
      const afterDialog = await evaluate('window.__ZX_TEST__.dialogOpen()');
      ensure(invalidText === '农历数据暂不可用', `无效日期提示错误：${invalidText}`);
      ensure(!beforeDialog && !afterDialog, '无效日期不应打开倒数日弹层');

      await openTool('天数计算');
      await evaluate(`window.__ZX_TEST__.toolSet('天数计算', '时间 1', '')`);
      await sleep(200);
      const daysInvalid = await evaluate('window.__ZX_TEST__.daysResult()');
      ensure(daysInvalid === '—', `无效天数结果应为 —，实际 ${daysInvalid}`);

      await openCalendarTab('倒数日');
      const categories = await evaluate(
        `Array.from(document.querySelectorAll('.countdown-category')).map((el) => (el.textContent || '').trim())`,
      );
      for (const category of [
        '全部',
        '纪念日·生日',
        '节假日',
        '热门节日',
        '节气',
        '自定义',
      ]) {
        ensure(categories.includes(category), `倒数日缺少分类：${category}`);
      }
      await clickText('.countdown-category', '节气');
      await waitFor(
        `document.querySelector('.countdown-empty')?.textContent.includes('这个分类还没有倒数日')`,
        '倒数日空分类',
      );
      const emptyText = await evaluate(
        `document.querySelector('.countdown-empty')?.textContent`,
      );
      return { invalidText, daysInvalid, emptyText, categories };
    },
    '28-tools-invalid-empty.png',
  );

  // ------------------------------------------------------------------
  // F-015 沉浸时钟
  // ------------------------------------------------------------------
  await runCase(
    {
      id: 'F-015-01',
      feature: 'F-015 时钟',
      name: '打开全屏时钟并请求常亮/全屏',
      expected:
        '沉浸时钟显示、默认极夜+数字+24 小时+不显示秒；Wake Lock 请求 screen；requestFullscreen 被调用',
    },
    async () => {
      await openCalendarTab('小工具');
      await evaluate('window.__ZX_TEST__.setWakeCounters()');
      await openClock();
      const state = await evaluate('window.__ZX_TEST__.clockState()');
      const wake = await evaluate('window.__ZX_TEST__.wake()');
      const fullscreen = await evaluate('window.__ZX_TEST__.fullscreen()');
      ensure(state?.theme === 'midnight', `默认主题应为极夜：${state?.theme}`);
      ensure(state?.mode === 'digital', `默认模式应为数字：${state?.mode}`);
      ensure(state?.digitalText, '数字时钟应有时间');
      ensure(!state?.seconds, '默认不应显示秒');
      ensure(!state?.ampm, '默认 24 小时不应有 AM/PM');
      ensure(
        wake.requests.includes('screen'),
        `未请求 Wake Lock：${JSON.stringify(wake)}`,
      );
      ensure(
        fullscreen.requests >= 1,
        `未调用 requestFullscreen：${JSON.stringify(fullscreen)}`,
      );
      return { state, wake, fullscreen };
    },
    '29-clock-initial.png',
  );

  await runCase(
    {
      id: 'F-015-02',
      feature: 'F-015 时钟',
      name: '主题切换：极夜/晨雾/暖砂',
      expected: 'data-theme 与背景色依次变化为 midnight/dawn/paper',
    },
    async () => {
      const midnight = await evaluate('window.__ZX_TEST__.clockState()');
      await evaluate(`window.__ZX_TEST__.clockButton('晨雾')`);
      await sleep(150);
      const dawn = await evaluate('window.__ZX_TEST__.clockState()');
      await screenshot('30-clock-dawn.png');
      await evaluate(`window.__ZX_TEST__.clockButton('暖砂')`);
      await sleep(150);
      const paper = await evaluate('window.__ZX_TEST__.clockState()');
      ensure(dawn.theme === 'dawn', `晨雾主题未生效：${dawn.theme}`);
      ensure(paper.theme === 'paper', `暖砂主题未生效：${paper.theme}`);
      const backgrounds = [
        midnight.backgroundImage,
        dawn.backgroundImage,
        paper.backgroundImage,
      ];
      ensure(
        new Set(backgrounds).size === 3,
        `三主题背景应不同：${JSON.stringify(backgrounds)}`,
      );
      return {
        midnight: midnight.backgroundImage,
        dawn: dawn.backgroundImage,
        paper: paper.backgroundImage,
      };
    },
    '31-clock-paper.png',
  );

  await runCase(
    {
      id: 'F-015-03',
      feature: 'F-015 时钟',
      name: '数字/模拟切换',
      expected: '切模拟时出现 SVG 模拟时钟，切数字时恢复数字时间',
    },
    async () => {
      await evaluate(`window.__ZX_TEST__.clockButton('模拟')`);
      await sleep(150);
      const analog = await evaluate('window.__ZX_TEST__.clockState()');
      ensure(analog.mode === 'analog', `模拟模式未生效：${analog.mode}`);
      ensure(analog.analog, '模拟模式缺少 SVG 时钟');
      ensure(!analog.digitalText, '模拟模式不应显示数字时间');
      await screenshot('32-clock-analog.png');
      await evaluate(`window.__ZX_TEST__.clockButton('数字')`);
      await sleep(150);
      const digital = await evaluate('window.__ZX_TEST__.clockState()');
      ensure(digital.mode === 'digital', '切回数字模式失败');
      ensure(Boolean(digital.digitalText), '数字模式缺少时间');
      return { analog, digital };
    },
    '33-clock-digital.png',
  );

  await runCase(
    {
      id: 'F-015-04',
      feature: 'F-015 时钟',
      name: '12/24 小时切换',
      expected: '点「24 小时」后按钮变「12 小时」并显示 AM/PM；再点恢复 24 小时且无 AM/PM',
    },
    async () => {
      await evaluate(`window.__ZX_TEST__.clockButton('24 小时')`);
      await sleep(150);
      const twelve = await evaluate('window.__ZX_TEST__.clockState()');
      ensure(twelve.controls.includes('12 小时'), '按钮未切换为 12 小时');
      ensure(Boolean(twelve.ampm), '12 小时模式缺少 AM/PM');
      await screenshot('34-clock-12h.png');
      await evaluate(`window.__ZX_TEST__.clockButton('12 小时')`);
      await sleep(150);
      const twentyFour = await evaluate('window.__ZX_TEST__.clockState()');
      ensure(twentyFour.controls.includes('24 小时'), '按钮未切回 24 小时');
      ensure(!twentyFour.ampm, '24 小时模式不应有 AM/PM');
      return { twelve, twentyFour };
    },
    '35-clock-24h.png',
  );

  await runCase(
    {
      id: 'F-015-05',
      feature: 'F-015 时钟',
      name: '秒显示开关',
      expected: '显示秒后出现秒数字并在 1.5 秒后变化；隐藏秒后消失',
    },
    async () => {
      await evaluate(`window.__ZX_TEST__.clockButton('显示秒')`);
      await sleep(150);
      const first = await evaluate('window.__ZX_TEST__.clockState()');
      ensure(first.seconds, '显示秒后缺少秒数字');
      await sleep(1500);
      const second = await evaluate('window.__ZX_TEST__.clockState()');
      ensure(
        first.seconds !== second.seconds,
        `秒数字未变化：${first.seconds} / ${second.seconds}`,
      );
      await screenshot('36-clock-seconds.png');
      await evaluate(`window.__ZX_TEST__.clockButton('隐藏秒')`);
      await sleep(150);
      const hidden = await evaluate('window.__ZX_TEST__.clockState()');
      ensure(!hidden.seconds, '隐藏秒后秒数字仍存在');
      return { first: first.seconds, second: second.seconds };
    },
    '37-clock-seconds-hidden.png',
  );

  await runCase(
    {
      id: 'F-015-06',
      feature: 'F-015 时钟',
      name: 'ESC 退出并释放常亮',
      expected: '按 ESC 关闭沉浸时钟，Wake Lock release 被调用',
    },
    async () => {
      const before = await evaluate('window.__ZX_TEST__.wake()');
      await closeClockByEscape();
      await sleep(250);
      const after = await evaluate('window.__ZX_TEST__.wake()');
      ensure(after.releases >= before.releases + 1, '关闭时钟未释放 Wake Lock');
      const overlay = await evaluate(
        `document.querySelector('[aria-label="沉浸时钟"]') === null`,
      );
      ensure(overlay, 'ESC 后沉浸时钟仍在');
      return { before, after };
    },
    '38-clock-exited.png',
  );

  await runCase(
    {
      id: 'F-015-07',
      feature: 'F-015 时钟',
      name: '常亮被拒绝时时钟仍可用',
      expected: 'Wake Lock reject 后时钟仍显示，并可用「退出 ESC」关闭',
    },
    async () => {
      await evaluate(`window.__ZX_TEST__.setWakeMode('reject')`);
      await evaluate('window.__ZX_TEST__.setWakeCounters()');
      await openClock();
      const state = await evaluate('window.__ZX_TEST__.clockState()');
      const wake = await evaluate('window.__ZX_TEST__.wake()');
      ensure(Boolean(state), 'Wake Lock 拒绝后时钟未显示');
      ensure(
        wake.requests.includes('screen'),
        '拒绝场景未尝试请求 Wake Lock',
      );
      await screenshot('39-clock-wakelock-rejected.png');
      await clickText('.clock-exit', '退出 ESC');
      await waitFor(
        `document.querySelector('[aria-label="沉浸时钟"]') === null`,
        '按钮退出时钟',
      );
      await sleep(200);
      await evaluate(`window.__ZX_TEST__.setWakeMode('ok')`);
      return { state, wake };
    },
    '40-clock-rejected-exited.png',
  );

  await observeCase(
    {
      id: 'F-015-OBS-01',
      feature: 'F-015 时钟',
      name: '会话内保留范围（补充观察，不计入 PASS/FAIL）',
      expected:
        '关闭再打开保持当前主题；切换日历分区后设置是否保持（PRD「本次会话」表述需产品确认）',
    },
    async () => {
      await openCalendarTab('小工具');
      await openClock();
      const reopened = await evaluate('window.__ZX_TEST__.clockState()');
      await closeClockByEscape();
      await openCalendarTab('倒数日');
      await openCalendarTab('小工具');
      await openClock();
      const afterTabSwitch = await evaluate('window.__ZX_TEST__.clockState()');
      await closeClockByEscape();
      return {
        verdict: 'OBSERVED',
        detail: {
          reopenedTheme: reopened?.theme,
          afterTabSwitchTheme: afterTabSwitch?.theme,
          note:
            afterTabSwitch?.theme === reopened?.theme
              ? '跨分区保持'
              : '切换日历分区后回到默认极夜；仅组件挂载期间保持',
        },
      };
    },
    '41-clock-session-observation.png',
  );

  await runCase(
    {
      id: 'F-015-08',
      feature: 'F-015 时钟',
      name: '空数据下时钟与日历不崩溃',
      expected:
        '清空事件/倒数日后重新加载，日历分区正常显示，时钟仍可打开与关闭',
    },
    async () => {
      await evaluate(
        `localStorage.setItem(${JSON.stringify(EMPTY_KEY)}, '1')`,
      );
      await reload();
      await waitCalendarTabs();
      const snapshot = await evaluate('window.__ZX_TEST__.snapshot()');
      ensure(snapshot.events.length === 0, '空数据事件未清空');
      ensure(snapshot.countdowns.length === 0, '空数据倒数日未清空');
      await openCalendarTab('事件');
      const eventsText = await evaluate(
        `document.querySelector('[aria-label="当天事件"]')?.innerText`,
      );
      ensure(String(eventsText).includes('这一天没有事件'), '空数据事件分区无空态');
      await openCalendarTab('倒数日');
      const countdownText = await evaluate(
        `document.querySelector('.countdown-empty')?.textContent`,
      );
      ensure(
        String(countdownText).includes('还没有倒数日'),
        `空数据倒数日无空态：${countdownText}`,
      );
      await openCalendarTab('小工具');
      await openClock();
      const clock = await evaluate('window.__ZX_TEST__.clockState()');
      ensure(Boolean(clock), '空数据下时钟无法打开');
      await closeClockByEscape();
      return { snapshot: { events: 0, countdowns: 0 }, eventsText, countdownText };
    },
    '42-empty-clock.png',
  );

  // ------------------------------------------------------------------
  // 控制台与汇总
  // ------------------------------------------------------------------
  await runCase(
    {
      id: 'GLOBAL-01',
      feature: '全局',
      name: '控制台零错误',
      expected: 'console.error / page exception 为 0；记录 console.warn',
    },
    async () => {
      const wakeInstall = await evaluate(
        'window.__ZX_TEST__.wake().installError',
      );
      const fullscreenInstall = await evaluate(
        'window.__ZX_TEST__.fullscreen().installError',
      );
      ensure(!wakeInstall, `Wake Lock 替身注入失败：${wakeInstall}`);
      ensure(
        !fullscreenInstall,
        `Fullscreen 替身注入失败：${fullscreenInstall}`,
      );
      ensure(
        consoleErrors.length === 0,
        `控制台错误：${JSON.stringify(consoleErrors)}`,
      );
      ensure(
        pageExceptions.length === 0,
        `页面异常：${JSON.stringify(pageExceptions)}`,
      );
      return {
        consoleErrors,
        pageExceptions,
        consoleWarns,
      };
    },
    '43-console.png',
  );

  note('AUD-014 浏览器实测完成');
  const failed = results.filter((item) => item.verdict === 'FAIL');
  fs.writeFileSync(
    path.join(EVIDENCE, 'summary.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        today,
        results,
        consoleErrors,
        consoleWarns,
        pageExceptions,
      },
      null,
      2,
    ),
  );
  console.log('\nAUD014_BROWSER_SUMMARY\n' + summaries.join('\n'));
  if (failed.length > 0) {
    console.error(`\nAUD014_FAILURES=${failed.length}`);
    for (const item of failed) {
      console.error(
        `${item.id} ${item.name}: ${
          typeof item.actual === 'string'
            ? item.actual
            : JSON.stringify(item.actual)
        }`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log('\nAUD014_BROWSER_EXIT=0');
  }
} catch (error) {
  console.error('[aud014-browser] 失败：', error);
  note('失败', { message: error?.message ?? String(error) });
  try {
    await screenshot('99-failure.png');
  } catch {
    // 忽略截图失败。
  }
  fs.writeFileSync(
    path.join(EVIDENCE, 'summary.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        results,
        consoleErrors,
        consoleWarns,
        pageExceptions,
        fatal: error?.message ?? String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  try {
    socket.close();
  } catch {
    // 忽略。
  }
  chrome.kill('SIGKILL');
  server.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
