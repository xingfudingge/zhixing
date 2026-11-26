/**
 * AUD-015 浏览器实测（真实 Chromium + 生产构建 app/dist）。
 *
 * 覆盖 F-016 习惯（查看/创建/编辑/删除/整月补卡/撤销/未来拒绝/安排行动/复盘联动）
 * 与 F-017 专注（番茄循环/暂停继续/重置/倒计时/正计时/白噪音/切页/统计/补记）。
 *
 * 边界与替身（不写成“真机通过”）：
 * * Tauri IPC 由 tests/harness/fakeTauri.ts 的内存命令路由替代，并按命令写
 *   localStorage，使刷新后仍读取同一份数据；页面代码与产品构建未改。
 * * 25 分钟番茄循环用“可观测时钟探针”推进：覆盖 Date.now 偏移，真实
 *   setInterval 仍在跑，计时引擎按真实时间差计算；报告明确标注哪些是虚拟时间。
 * * 白噪音用 AudioContext 替身观测 start/stop/gain；headless 无声音输出。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/aud015-browser.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/aud015');
const FAKE_BUNDLE = '/tmp/zx-aud015-fake.js';
const PORT = 8903;
const DEBUG_PORT = 9225;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DB_KEY = 'zx_aud015_db';
const EMPTY_KEY = 'zx_aud015_empty';

fs.mkdirSync(EVIDENCE, { recursive: true });
for (const file of fs.readdirSync(EVIDENCE)) {
  if (file.endsWith('.png') || file === 'summary.json') {
    fs.unlinkSync(path.join(EVIDENCE, file));
  }
}

const esbuild = path.join(ROOT, 'node_modules/.pnpm/node_modules/.bin/esbuild');
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
  const line =
    data === undefined ? message : `${message} ${JSON.stringify(data)}`;
  summaries.push(line);
  console.log(`[aud015-browser] ${line}`);
}

function record(meta, verdict, actual, evidence) {
  results.push({
    id: meta.id,
    feature: meta.feature,
    name: meta.name,
    expected: meta.expected,
    actual,
    verdict,
    evidence: evidence ? `tests/evidence/aud015/${evidence}` : null,
  });
  note(`[${verdict}] ${meta.id} ${meta.name}`, {
    expected: meta.expected,
    actual,
    evidence,
  });
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
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

const userDataDir = `/tmp/zx-chrome-aud015-${Date.now()}`;
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
    await sleep(80);
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
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
    };
  })()`);
  if (!point) throw new Error(`找不到点击目标：${label}`);
  return point;
}

async function clickSelector(selector, label = selector) {
  const point = await pointFor(
    `document.querySelector(${JSON.stringify(selector)})`,
    label,
  );
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

async function doubleClickSelector(selector, label = selector) {
  const point = await pointFor(
    `document.querySelector(${JSON.stringify(selector)})`,
    label,
  );
  await clickPoint(point, 1);
  await sleep(40);
  await clickPoint(point, 2);
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

function secondsOf(clock) {
  const [minutes, secs] = String(clock).split(':').map(Number);
  return minutes * 60 + secs;
}

async function focusClock() {
  return evaluate(
    `document.querySelector('[data-testid="focus-clock"]')?.textContent.replace(/\\s+/g, '')`,
  );
}

/**
 * 每个专注用例的干净起点。
 *
 * 计时状态只存在内存，且模式配置（例如倒计时 45 分钟）会跨用例保留；
 * 因此先重新加载 /focus，再显式等待“番茄循环 + 25:00 + 开始专注”，
 * 不沿用上一用例的倒计时/正计时状态。刷新同时把可观测时钟偏移归零。
 */
async function resetFocusPage(label = '专注用例干净起点') {
  await navigate(`http://127.0.0.1:${PORT}/focus`);
  await waitFocusReady(label);
  if ((await evaluate('window.__ZX_CLOCK__.offset')) !== 0) {
    // 同 URL 导航若被浏览器优化成 no-op，显式 reload 保证内存计时被清空。
    await reload();
    await waitFocusReady(label);
  }
  await waitFor(
    `document.querySelector('.focus-mode.is-active')?.textContent.trim() === '番茄循环' &&
     Array.from(document.querySelectorAll('.focus-actions button')).some(
       (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === '开始专注') &&
     !Array.from(document.querySelectorAll('.focus-actions button')).some(
       (el) => ['暂停', '继续专注', '继续计时', '开始计时'].includes(
         (el.textContent || '').replace(/\\s+/g, ' ').trim())) &&
     document.querySelector('[data-testid="focus-clock"]')?.textContent.replace(/\\s+/g, '') === '25:00' &&
     document.querySelector('[data-testid="focus-phase"]')?.textContent.includes('专注中') &&
     document.querySelector('[data-testid="focus-phase"]')?.textContent.includes('第 1 / 4 轮') &&
     document.querySelector('#focus-task option[value="task-acceptance"]') !== null &&
     !document.querySelector('.focus-banner') &&
     window.__ZX_CLOCK__.offset === 0`,
    `${label}（番茄 25:00 空闲）`,
    15_000,
  );
}

/** 按可见文本精确匹配 `.focus-actions` 按钮，不依赖 DOM 顺序。 */
async function focusAction(text) {
  return (
    (await evaluate(
      `Array.from(document.querySelectorAll('.focus-actions button')).find(
        (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`,
    )) ?? null
  );
}

async function waitFocusAction(text, label = `专注按钮「${text}」出现`) {
  await waitFor(
    `Array.from(document.querySelectorAll('.focus-actions button')).some(
      (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)})`,
    label,
  );
}

async function clickFocusAction(text) {
  await waitFocusAction(text, `专注按钮「${text}」出现`);
  const point = await pointFor(
    `Array.from(document.querySelectorAll('.focus-actions button')).find(
      (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)})`,
    `.focus-actions 按钮 文本=${text}`,
  );
  await clickPoint(point);
  return point;
}

/** 按可见文本精确匹配计时模式按钮，并等待该模式激活。 */
async function clickFocusMode(text) {
  const point = await pointFor(
    `Array.from(document.querySelectorAll('.focus-mode')).find(
      (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)})`,
    `专注模式 文本=${text}`,
  );
  await clickPoint(point);
  await waitFor(
    `document.querySelector('.focus-mode.is-active')?.textContent.trim() === ${JSON.stringify(text)}`,
    `模式切换为 ${text}`,
  );
  return point;
}

/** 等待时钟数值满足比较（用于“推进虚拟时钟后再渲染”的确定性断言）。 */
async function waitClock(operator, seconds, label, timeout = 10_000) {
  return waitFor(
    `(() => {
      const text = document.querySelector('[data-testid="focus-clock"]')?.textContent.replace(/\\s+/g, '') || '';
      const parts = text.split(':').map(Number);
      if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) return false;
      return parts[0] * 60 + parts[1] ${operator} ${seconds};
    })()`,
    label,
    timeout,
  );
}

/** 双击按钮：两次真实鼠标点击紧邻发送，用于验证保存中锁/幂等。 */
async function doubleClickPointFast(point) {
  ensure(point, '双击目标不存在');
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
  });
  for (let clickCount = 1; clickCount <= 2; clickCount += 1) {
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
    await sleep(20);
  }
  await sleep(150);
}

/** 热力图必须停在“今天所在月”，避免上一条用例切月后串味。 */
async function ensureHeatmapMonth(prefix) {
  const target = `${Number(prefix.slice(0, 4))} 年 ${Number(prefix.slice(5, 7))} 月热力图`;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const heading = await evaluate(
      `document.querySelector('[aria-label="习惯月热力图"] h2')?.textContent || ''`,
    );
    if (heading === target) return heading;
    if (!heading) break;
    const match = heading.match(/(\d{4}) 年 (\d{1,2}) 月/);
    const current = match ? Number(match[1]) * 12 + Number(match[2]) : 0;
    const wanted =
      Number(prefix.slice(0, 4)) * 12 + Number(prefix.slice(5, 7));
    await clickAria(current < wanted ? '下个月' : '上个月');
    await sleep(120);
  }
  throw new Error(`无法切回 ${target}`);
}

async function focusClockText() {
  return evaluate(
    `document.querySelector('[data-testid="focus-clock"]')?.textContent.replace(/\\s+/g, '')`,
  );
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

const injection = `(() => {
  let raw = null;
  let emptyKeys = [];
  try {
    raw = localStorage.getItem(${JSON.stringify(DB_KEY)});
    emptyKeys = JSON.parse(localStorage.getItem(${JSON.stringify(EMPTY_KEY)}) || '[]');
    if (!Array.isArray(emptyKeys)) emptyKeys = [];
  } catch (error) {}

  // 可观测时钟：Date.now 偏移，setInterval 仍是真实定时器。
  try {
    const realNow = Date.now.bind(Date);
    window.__ZX_CLOCK__ = { offset: 0, realNow };
    Date.now = () => realNow() + window.__ZX_CLOCK__.offset;
  } catch (error) {}

  // 可观测 AudioContext：记录 source.start/stop 与 gain 值，避免 headless 无声。
  try {
    window.__ZX_AUDIO__ = { contexts: 0, starts: 0, stops: 0, sources: [], gains: [], filters: [] };
    class FakeAudioContext {
      constructor() {
        this.state = 'running';
        this.sampleRate = 8000;
        this.destination = {};
        window.__ZX_AUDIO__.contexts += 1;
      }
      createBuffer(channels, length) {
        return {
          length,
          getChannelData: () => new Float32Array(Math.min(length, 64)),
        };
      }
      createBufferSource() {
        const source = {
          buffer: null,
          loop: false,
          connect() {},
          disconnect() {},
          start() {
            source.started = true;
            window.__ZX_AUDIO__.starts += 1;
          },
          stop() {
            source.stopped = true;
            window.__ZX_AUDIO__.stops += 1;
          },
        };
        window.__ZX_AUDIO__.sources.push(source);
        return source;
      }
      createBiquadFilter() {
        const filter = {
          type: '',
          frequency: { value: 0 },
          Q: { value: 0 },
          connect() {},
          disconnect() {},
        };
        window.__ZX_AUDIO__.filters.push(filter);
        return filter;
      }
      createGain() {
        const node = {
          gain: { value: 0 },
          connect() {},
          disconnect() {},
        };
        window.__ZX_AUDIO__.gains.push(node);
        return node;
      }
      resume() {
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: FakeAudioContext,
    });
  } catch (error) {
    window.__ZX_AUDIO__ = { installError: String(error) };
  }

  __ZX_FAKE_BUNDLE__
  try {
    const world = ZXFake.createFakeWorld();
    if (raw) {
      const saved = JSON.parse(raw);
      for (const [key, value] of Object.entries(saved)) {
        if (Array.isArray(value) && Array.isArray(world.db[key])) {
          world.db[key] = value;
        }
      }
    }
    for (const key of emptyKeys) {
      if (Array.isArray(world.db[key])) world.db[key] = [];
    }
    world.install();

    const originalInvoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await originalInvoke(command, args);
      if (emptyKeys.length === 0) {
        try {
          localStorage.setItem(${JSON.stringify(DB_KEY)}, JSON.stringify(world.db));
        } catch (error) {}
      }
      return result;
    };

    const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const all = (selector) => Array.from(document.querySelectorAll(selector));
    const findAria = (label) =>
      all('[aria-label]').find(
        (el) => el.getAttribute('aria-label') === label,
      ) || null;
    const activeHabits = () => world.db.habits.filter((h) => h.deletedAt === null);
    const activeLogs = (habitId) =>
      world.db.logs.filter(
        (log) =>
          log.deletedAt === null &&
          (habitId === undefined || log.habitId === habitId),
      );
    const activeSessions = () =>
      world.db.sessions.filter((row) => row.deletedAt === null);
    const activeTasks = () => world.db.tasks.filter((row) => row.deletedAt === null);
    const habitDialogRoot = () => document.querySelector('.habit-dialog');

    function labelControlIn(root, labelText) {
      const label = all('label').find((item) => {
        if (!root.contains(item)) return false;
        const span = item.querySelector(':scope > span');
        const text = norm(span ? span.textContent : item.textContent);
        return text === labelText || text.startsWith(labelText);
      });
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

    const focusPrimary = () => {
      const buttons = all('.focus-actions button');
      return buttons[0] ? norm(buttons[0].textContent) : null;
    };

    window.__ZX_WORLD__ = world;
    window.__ZX_TEST__ = {
      today: world.today,
      habits() {
        return JSON.parse(JSON.stringify(activeHabits()));
      },
      habit(id) {
        const row = world.db.habits.find((item) => item.id === id) || null;
        return row ? JSON.parse(JSON.stringify(row)) : null;
      },
      logDates(habitId) {
        return activeLogs(habitId).map((log) => log.logDate).sort();
      },
      logRows(habitId) {
        return JSON.parse(
          JSON.stringify(world.db.logs.filter((log) => log.habitId === habitId)),
        );
      },
      sessions() {
        // 最新写入在前：db 数组按写入顺序追加，反转即最近优先。
        return JSON.parse(JSON.stringify(activeSessions())).reverse();
      },
      sessionsNewest() {
        return JSON.parse(JSON.stringify(activeSessions()))
          .slice()
          .reverse();
      },
      tasks() {
        return JSON.parse(JSON.stringify(activeTasks()));
      },
      tasksByTitle(title) {
        return activeTasks().filter((task) => task.title === title).length;
      },
      taskByTitle(title) {
        const row = activeTasks().find((task) => task.title === title);
        return row ? JSON.parse(JSON.stringify(row)) : null;
      },
      dbSnapshot() {
        return JSON.parse(
          JSON.stringify({
            habits: world.db.habits,
            logs: world.db.logs,
            sessions: world.db.sessions,
            tasks: world.db.tasks,
          }),
        );
      },
      weekRate() {
        return norm(document.querySelector('[data-testid="habit-week-rate"]')?.textContent);
      },
      weekChecks() {
        return document.querySelector('[data-testid="habit-week-checks"]')?.textContent ?? null;
      },
      longestBest() {
        return document.querySelector('[data-testid="habit-longest-best"]')?.textContent ?? null;
      },
      habitRow(habitId) {
        // 热力格同样带 data-habit-id，必须限定在列表行内，否则会命中格子。
        const row = document.querySelector('.habit-row[data-habit-id="' + habitId + '"]');
        if (!row) return null;
        const week = row.querySelector('.habit-week');
        return {
          text: norm(row.textContent),
          title: norm(row.querySelector('.habit-title-line b')?.textContent),
          schedule: norm(row.querySelector('.habit-title-line small')?.textContent),
          icon: norm(row.querySelector('.habit-icon')?.textContent),
          streakLabel: row.querySelector('.habit-streak')?.getAttribute('aria-label'),
          week: week
            ? Array.from(week.querySelectorAll('button')).map((button) => ({
                date: button.getAttribute('data-date'),
                checked: button.getAttribute('data-checked'),
                label: button.getAttribute('aria-label'),
                disabled: button.getAttribute('aria-disabled'),
              }))
            : [],
        };
      },
      heatmap() {
        const card = document.querySelector('[aria-label="习惯月热力图"]');
        if (!card) return null;
        const cells = Array.from(card.querySelectorAll('.habit-cell'));
        const rowIds = Array.from(
          new Set(cells.map((cell) => cell.getAttribute('data-habit-id'))),
        );
        return {
          heading: norm(card.querySelector('h2')?.textContent),
          dayColumns: card.querySelectorAll('.habit-heatmap-daynum').length,
          cells: cells.length,
          rowIds,
          checked: cells
            .filter((cell) => cell.getAttribute('data-checked') === 'true')
            .map((cell) => ({
              habitId: cell.getAttribute('data-habit-id'),
              date: cell.getAttribute('data-date'),
            })),
        };
      },
      cell(habitId, date) {
        const cell = document.querySelector(
          '.habit-cell[data-habit-id="' + habitId + '"][data-date="' + date + '"]',
        );
        if (!cell) return null;
        return {
          checked: cell.getAttribute('data-checked'),
          disabled: cell.getAttribute('aria-disabled'),
          className: cell.className,
          label: cell.getAttribute('aria-label'),
        };
      },
      weekDot(habitId, date) {
        const row = document.querySelector('.habit-row[data-habit-id="' + habitId + '"]');
        const dot = row?.querySelector('.habit-week button[data-date="' + date + '"]');
        if (!dot) return null;
        return {
          checked: dot.getAttribute('data-checked'),
          disabled: dot.getAttribute('aria-disabled'),
          className: dot.className,
          label: dot.getAttribute('aria-label'),
          text: norm(dot.textContent),
        };
      },
      habitEmptyText() {
        const empty = document.querySelector('.habit-empty');
        return empty ? norm(empty.textContent) : null;
      },
      toasts() {
        return all('.habit-toast').map((toast) => norm(toast.textContent));
      },
      focusToasts() {
        return all('.focus-toast').map((toast) => norm(toast.textContent));
      },
      dismissToasts() {
        let closed = 0;
        for (const button of all('.habit-toast-close')) {
          button.click();
          closed += 1;
        }
        return closed;
      },
      dialogs() {
        return all('.task-dialog, .habit-dialog').map((dialog) => norm(dialog.textContent));
      },
      habitDialog() {
        const root = habitDialogRoot();
        if (!root) return null;
        return {
          title: norm(root.querySelector('h2')?.textContent),
          text: norm(root.textContent).slice(0, 300),
          values: {
            title: labelControlIn(root, '名称').value,
            schedule: labelControlIn(root, '频率/时间').value,
            icon: labelControlIn(root, '图标').value,
            color: labelControlIn(root, '颜色').value,
          },
          buttons: all('.habit-dialog button').map((button) => norm(button.textContent)),
        };
      },
      setHabitField(label, value) {
        const root = habitDialogRoot();
        if (!root) throw new Error('习惯弹层未打开');
        return setControlValue(labelControlIn(root, label), value);
      },
      clickHabitDialogButton(text) {
        const root = habitDialogRoot();
        if (!root) throw new Error('习惯弹层未打开');
        const button = all('.habit-dialog button').find(
          (el) => norm(el.textContent) === text,
        );
        if (!button) throw new Error('找不到习惯弹层按钮：' + text);
        button.click();
        return true;
      },
      confirmText() {
        const dialog = document.querySelector('.habit-dialog--confirm');
        return dialog ? norm(dialog.textContent) : null;
      },
      focus() {
        const clock = document.querySelector('[data-testid="focus-clock"]');
        if (!clock) return null;
        const phase = document.querySelector('[data-testid="focus-phase"]');
        const modes = all('.focus-mode').map((button) => ({
          label: norm(button.textContent),
          pressed: button.getAttribute('aria-pressed'),
          disabled: button.disabled,
        }));
        const dots = all('.focus-round-dot').map((dot) => ({
          done: dot.className.includes('is-done'),
          current: dot.className.includes('is-current'),
        }));
        const noiseState = document.querySelector('[data-testid="noise-state"]');
        const volume = document.querySelector('#focus-noise-volume');
        const activeNoise = all('.focus-noise-button').find(
          (button) => button.getAttribute('aria-pressed') === 'true',
        );
        const recent = all('.focus-recent li').map((item) => norm(item.textContent));
        return {
          clock: norm(clock.textContent),
          clockLabel: clock.getAttribute('aria-label'),
          phase: norm(phase?.textContent),
          primary: focusPrimary(),
          modes,
          dots,
          selectedTask: document.querySelector('#focus-task')?.value ?? null,
          taskOptions: all('#focus-task option')
            .map((option) => ({ value: option.value, label: norm(option.textContent) }))
            .filter((option) => option.value),
          todayMinutes: norm(
            document.querySelector('[data-testid="focus-today-minutes"]')?.textContent,
          ),
          todayCount: norm(
            document.querySelector('[data-testid="focus-today-count"]')?.textContent,
          ),
          weekMinutes: norm(
            document.querySelector('[data-testid="focus-week-minutes"]')?.textContent,
          ),
          recent,
          noiseState: norm(noiseState?.textContent),
          noiseActive: activeNoise ? norm(activeNoise.textContent) : null,
          volume: volume ? volume.value : null,
          inlineError: norm(
            document.querySelector('.focus-inline-error')?.textContent,
          ),
          notice: norm(
            document.querySelector('[data-testid="focus-toast"]')?.textContent,
          ),
        };
      },
      audio() {
        return JSON.parse(JSON.stringify(window.__ZX_AUDIO__ || {}));
      },
      resetAudioCounters() {
        window.__ZX_AUDIO__.starts = 0;
        window.__ZX_AUDIO__.stops = 0;
        window.__ZX_AUDIO__.sources = [];
        window.__ZX_AUDIO__.gains = [];
        return true;
      },
      focusSummaryText() {
        const card = document.querySelector('[aria-label="今日与本周统计"]');
        return card ? norm(card.textContent) : null;
      },
      reviewStats() {
        const cards = all('.review-stat');
        const map = {};
        for (const card of cards) {
          map[card.getAttribute('aria-label')] = norm(card.textContent);
        }
        return map;
      },
      reviewStatus() {
        return norm(document.querySelector('.review-state-card')?.textContent);
      },
      setFocusSelect(selector, value) {
        const control = document.querySelector(selector);
        if (!control) throw new Error('找不到控件：' + selector);
        return setControlValue(control, value);
      },
      setRangeValue(value) {
        const control = document.querySelector('#focus-noise-volume');
        if (!control) throw new Error('找不到音量滑杆');
        return setControlValue(control, value);
      },
      clickText(selector, text) {
        const element = all(selector).find((el) => norm(el.textContent) === norm(text));
        if (!element) throw new Error('找不到文本：' + selector + ' / ' + text);
        element.click();
        return true;
      },
      clickAria(label) {
        const element = findAria(label);
        if (!element) throw new Error('找不到 aria-label：' + label);
        element.click();
        return true;
      },
      existsAria(label) {
        return Boolean(findAria(label));
      },
      ariaText(label) {
        const element = findAria(label);
        return element ? norm(element.textContent) : null;
      },
      bodyText() {
        return norm(document.body.innerText);
      },
      clockOffset() {
        return window.__ZX_CLOCK__.offset;
      },
      advanceClock(ms) {
        window.__ZX_CLOCK__.offset += ms;
        return window.__ZX_CLOCK__.offset;
      },
      resetClock() {
        window.__ZX_CLOCK__.offset = 0;
        return true;
      },
      setEmptyKeys(keys) {
        localStorage.setItem(${JSON.stringify(EMPTY_KEY)}, JSON.stringify(keys));
        return true;
      },
      clearEmptyKeys() {
        localStorage.removeItem(${JSON.stringify(EMPTY_KEY)});
        return true;
      },
      invoke(command, args) {
        return world.invoke(command, args);
      },
      savedDbSize() {
        try {
          return (localStorage.getItem(${JSON.stringify(DB_KEY)}) || '').length;
        } catch (error) {
          return -1;
        }
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
    `document.readyState === 'complete' && document.body && document.body.innerText.length > 0`,
    `页面加载 ${url}`,
  );
  const initError = await evaluate('window.__ZX_INIT_ERROR__ ?? null');
  if (initError) throw new Error(`注入初始化失败：${initError}`);
}

async function reload() {
  await send('Page.reload');
  await waitFor(
    `document.readyState === 'complete' && document.body && document.body.innerText.length > 0`,
    '页面刷新完成',
  );
  const initError = await evaluate('window.__ZX_INIT_ERROR__ ?? null');
  if (initError) throw new Error(`刷新注入失败：${initError}`);
}

async function waitHabitsReady(label = '习惯页就绪') {
  await waitFor(
    `document.querySelector('h1')?.textContent.trim() === '习惯' &&
      (document.querySelector('.habit-row') !== null ||
       document.querySelector('.habit-empty') !== null)`,
    label,
  );
}

async function waitFocusReady(label = '专注页就绪') {
  await waitFor(
    `document.querySelector('h1')?.textContent.trim() === '专注' &&
      document.querySelector('[data-testid="focus-clock"]') !== null`,
    label,
  );
}

async function openNav(label) {
  const point = await pointFor(
    `Array.from(document.querySelectorAll('.nav-link')).find((link) => (link.querySelector('.nav-label')?.textContent || '').trim() === ${JSON.stringify(label)})`,
    `导航 ${label}`,
  );
  await clickPoint(point);
  await sleep(250);
}

async function clockIs(text, label = `计时显示 ${text}`) {
  await waitFor(
    `document.querySelector('[data-testid="focus-clock"]')?.textContent.replace(/\\s+/g, '') === ${JSON.stringify(text.replace(/\s+/g, ''))}`,
    label,
    8000,
  );
}

async function runCase(meta, fn, shot) {
  try {
    const actual = await fn();
    if (shot) await screenshot(shot);
    record(meta, 'PASS', actual, shot);
    return actual;
  } catch (error) {
    const failShot = shot ? shot.replace(/\.png$/, '-FAIL.png') : null;
    if (failShot) {
      try {
        await screenshot(failShot);
      } catch {
        // 截图失败不覆盖原始错误。
      }
    }
    record(meta, 'FAIL', error?.message ?? String(error), failShot);
    return null;
  }
}

async function observeCase(meta, fn, shot) {
  try {
    const actual = await fn();
    if (shot) await screenshot(shot);
    const verdict = actual?.verdict ?? 'PASS';
    const detail = actual?.detail ?? actual;
    record(meta, verdict, detail, shot);
    return actual;
  } catch (error) {
    const failShot = shot ? shot.replace(/\.png$/, '-FAIL.png') : null;
    if (failShot) {
      try {
        await screenshot(failShot);
      } catch {
        // 忽略。
      }
    }
    record(meta, 'FAIL', error?.message ?? String(error), failShot);
    return null;
  }
}

try {
  await navigate(`http://127.0.0.1:${PORT}/habits`);
  await waitHabitsReady();
  const today = await evaluate('window.__ZX_WORLD__.today');
  const [year, month] = today.split('-').map(Number);
  const monthDays = new Date(year, month, 0).getDate();
  const monthPrefix = today.slice(0, 7);
  const firstOfMonth = `${monthPrefix}-01`;
  const futureDate = `${monthPrefix}-${String(monthDays).padStart(2, '0')}`;
  const seedHabitId = 'habit-read';
  note('真实 Chromium 已加载知行生产构建', {
    today,
    monthDays,
    firstOfMonth,
    futureDate,
    seed: await evaluate('window.__ZX_TEST__.dbSnapshot()'),
  });
  await screenshot('00-habits-initial.png');

  // ------------------------------------------------------------------
  // F-016 习惯：查看 / 创建 / 编辑 / 整月补卡 / 撤销 / 删除
  // ------------------------------------------------------------------
  await runCase(
    {
      id: 'F-016-01',
      feature: 'F-016 习惯',
      name: '查看：页头统计、周视图、月热力图与连续记录',
      expected:
        '种子习惯「阅读 20 分钟」显示在本周圆点与月热力图；本周 1 / 7 次·完成度 14%；今天已打卡；连续 1 天、最佳 1',
    },
    async () => {
      const rate = await evaluate('window.__ZX_TEST__.weekRate()');
      const checks = await evaluate('window.__ZX_TEST__.weekChecks()');
      const best = await evaluate('window.__ZX_TEST__.longestBest()');
      const heatmap = await evaluate('window.__ZX_TEST__.heatmap()');
      const row = await evaluate(
        `window.__ZX_TEST__.habitRow('${seedHabitId}')`,
      );
      const todayDot = await evaluate(
        `window.__ZX_TEST__.weekDot('${seedHabitId}', '${today}')`,
      );
      ensure(rate === '1 / 7 次 · 完成度 14%', `本周统计不符：${rate}`);
      ensure(checks === '1', `本周打卡数不符：${checks}`);
      ensure(best === '1', `最长连续不符：${best}`);
      ensure(heatmap?.heading === `${year} 年 ${month} 月热力图`, `热力图标题不符：${heatmap?.heading}`);
      ensure(heatmap?.dayColumns === monthDays, `热力图列数应为 ${monthDays}，实际 ${heatmap?.dayColumns}`);
      ensure(row?.title === '阅读 20 分钟', `列表标题不符：${row?.title}`);
      ensure(row?.streakLabel === '当前连续 1 天，最佳 1 天', `连续标签不符：${row?.streakLabel}`);
      ensure(todayDot?.checked === 'true', '今天圆点未显示已打卡');
      ensure(todayDot?.text === '✓', `今天圆点文本应为 ✓：${todayDot?.text}`);
      const futureCell = await evaluate(
        `window.__ZX_TEST__.cell('${seedHabitId}', '${futureDate}')`,
      );
      ensure(futureCell?.disabled === 'true', '未来格未标记为禁用');
      return { rate, checks, best, heatmap, row, todayDot, futureCell };
    },
    '01-habits-view.png',
  );

  let newHabitId = null;
  await runCase(
    {
      id: 'F-016-02',
      feature: 'F-016 习惯',
      name: '创建：空名称拒绝，填名称/频率/图标/颜色后保存',
      expected:
        '空名称提示「先写个名称」；保存后列表与热力图出现「验收习惯A」，字段为每天 · 07:00、▤、violet',
    },
    async () => {
      await clickText('.habit-button', '＋ 新习惯');
      await waitFor('!!document.querySelector(".habit-dialog")', '新建习惯弹层');
      const dialog = await evaluate('window.__ZX_TEST__.habitDialog()');
      ensure(dialog?.title === '新建习惯', `弹层标题不符：${dialog?.title}`);
      ensure(
        dialog.buttons.includes('保存') && dialog.buttons.includes('取消'),
        `弹层按钮不符：${JSON.stringify(dialog.buttons)}`,
      );
      ensure(!dialog.buttons.includes('删除'), '新建弹层不应有删除按钮');
      await evaluate(`window.__ZX_TEST__.clickHabitDialogButton('保存')`);
      await waitFor(
        `document.querySelector('.habit-dialog-error')?.textContent.includes('先写个名称')`,
        '空名称校验',
      );
      const errorText = await evaluate(
        `document.querySelector('.habit-dialog-error')?.textContent`,
      );
      ensure(
        (await evaluate('window.__ZX_TEST__.habits().length')) === 1,
        '空名称不应创建习惯',
      );
      await evaluate(`window.__ZX_TEST__.setHabitField('名称', '验收习惯A')`);
      await evaluate(`window.__ZX_TEST__.setHabitField('频率/时间', '每天 · 07:00')`);
      await evaluate(`window.__ZX_TEST__.setHabitField('图标', '▤')`);
      await evaluate(`window.__ZX_TEST__.setHabitField('颜色', 'violet')`);
      const draft = await evaluate('window.__ZX_TEST__.habitDialog().values');
      await screenshot('02-habit-create-dialog.png');
      await evaluate(`window.__ZX_TEST__.clickHabitDialogButton('保存')`);
      await waitFor(
        `!document.querySelector('.habit-dialog') && window.__ZX_TEST__.habits().some((h) => h.title === '验收习惯A')`,
        '习惯保存',
      );
      const created = await evaluate(
        `window.__ZX_TEST__.habits().find((h) => h.title === '验收习惯A')`,
      );
      newHabitId = created.id;
      const row = await evaluate(`window.__ZX_TEST__.habitRow('${newHabitId}')`);
      const heatmap = await evaluate('window.__ZX_TEST__.heatmap()');
      ensure(draft.title === '验收习惯A', '弹层草稿标题不符');
      ensure(created.schedule === '每天 · 07:00', `频率不符：${created.schedule}`);
      ensure(created.icon === '▤', `图标不符：${created.icon}`);
      ensure(created.color === 'violet', `颜色不符：${created.color}`);
      ensure(row?.title === '验收习惯A', `列表未出现新习惯：${row?.title}`);
      ensure(row?.schedule === '每天 · 07:00', `列表频率不符：${row?.schedule}`);
      ensure(heatmap?.rowIds.includes(newHabitId), '热力图未出现新习惯行');
      ensure(await evaluate('window.__ZX_TEST__.weekRate()') === '1 / 14 次 · 完成度 7%', '新增习惯后完成率未重算');
      return { errorText, draft, created, row, heatmap };
    },
    '03-habit-created.png',
  );

  await runCase(
    {
      id: 'F-016-03',
      feature: 'F-016 习惯',
      name: '编辑：回填字段并改名/频率/图标/颜色',
      expected:
        '编辑弹层回填原值；保存后列表、周视图 aria-label 与热力图标题同步为「验收习惯A改」、工作日 · 08:00、◉、blue，版本号递增',
    },
    async () => {
      const before = await evaluate(`window.__ZX_TEST__.habit('${newHabitId}')`);
      await clickAria('编辑习惯：验收习惯A');
      await waitFor(
        `window.__ZX_TEST__.habitDialog()?.title === '编辑习惯'`,
        '编辑习惯弹层',
      );
      const initial = await evaluate('window.__ZX_TEST__.habitDialog()');
      ensure(initial.values.title === '验收习惯A', '编辑弹层未回填名称');
      ensure(initial.values.schedule === '每天 · 07:00', '编辑弹层未回填频率');
      ensure(initial.values.icon === '▤', '编辑弹层未回填图标');
      ensure(initial.values.color === 'violet', '编辑弹层未回填颜色');
      ensure(initial.buttons.includes('删除'), '编辑弹层缺少删除按钮');
      await evaluate(`window.__ZX_TEST__.setHabitField('名称', '验收习惯A改')`);
      await evaluate(`window.__ZX_TEST__.setHabitField('频率/时间', '工作日 · 08:00')`);
      await evaluate(`window.__ZX_TEST__.setHabitField('图标', '◉')`);
      await evaluate(`window.__ZX_TEST__.setHabitField('颜色', 'blue')`);
      await screenshot('04-habit-edit-dialog.png');
      await evaluate(`window.__ZX_TEST__.clickHabitDialogButton('保存')`);
      await waitFor(
        `!document.querySelector('.habit-dialog') && window.__ZX_TEST__.habit('${newHabitId}')?.title === '验收习惯A改'`,
        '习惯编辑保存',
      );
      const updated = await evaluate(`window.__ZX_TEST__.habit('${newHabitId}')`);
      const row = await evaluate(`window.__ZX_TEST__.habitRow('${newHabitId}')`);
      const cell = await evaluate(
        `window.__ZX_TEST__.cell('${newHabitId}', '${today}')`,
      );
      ensure(updated.schedule === '工作日 · 08:00', `频率未更新：${updated.schedule}`);
      ensure(updated.icon === '◉', `图标未更新：${updated.icon}`);
      ensure(updated.color === 'blue', `颜色未更新：${updated.color}`);
      ensure(updated.version > before.version, '版本号未递增');
      ensure(row?.title === '验收习惯A改', `列表未同步：${row?.title}`);
      ensure(row?.icon === '◉', `列表图标未同步：${row?.icon}`);
      ensure(
        String(cell?.label).startsWith('验收习惯A改'),
        `热力图 aria-label 未同步：${cell?.label}`,
      );
      return { initial, updated, row, cell };
    },
    '05-habit-edited.png',
  );

  // 整月补卡：2026-10-01 → today 逐格真实点击。
  const backfillDates = [];
  for (let day = 1; day <= Number(today.slice(-2)); day += 1) {
    backfillDates.push(`${monthPrefix}-${String(day).padStart(2, '0')}`);
  }
  await runCase(
    {
      id: 'F-016-04',
      feature: 'F-016 习惯',
      name: `整月补卡：从 ${backfillDates[0]} 到 ${today} 逐格点击`,
      expected: `月热力图 ${backfillDates[0]}～${today} 共 ${backfillDates.length} 格逐格补卡成功；连续 27 天、最佳 27；本周 3 / 14 次`,
    },
    async () => {
      const daily = [];
      await ensureHeatmapMonth(monthPrefix);
      for (const date of backfillDates) {
        // toast 在右下角固定层，可能盖住热力格；每次点击前先清掉。
        await evaluate('window.__ZX_TEST__.dismissToasts()');
        const before = await evaluate(
          `window.__ZX_TEST__.cell('${newHabitId}', '${date}')`,
        );
        ensure(before, `热力图缺少格子：${date}`);
        ensure(before.checked === 'false', `补卡前 ${date} 已是打卡状态`);
        await clickSelector(
          `.habit-cell[data-habit-id="${newHabitId}"][data-date="${date}"]`,
          `热力格 ${date}`,
        );
        await waitFor(
          `window.__ZX_TEST__.cell('${newHabitId}', '${date}')?.checked === 'true'`,
          `补卡 ${date}`,
        );
        daily.push({ date, checked: 'true' });
      }
      await evaluate('window.__ZX_TEST__.dismissToasts()');
      const dates = await evaluate(`window.__ZX_TEST__.logDates('${newHabitId}')`);
      const row = await evaluate(`window.__ZX_TEST__.habitRow('${newHabitId}')`);
      const rate = await evaluate('window.__ZX_TEST__.weekRate()');
      ensure(dates.length === backfillDates.length, `日志数量应为 ${backfillDates.length}，实际 ${dates.length}`);
      ensure(
        JSON.stringify(dates) === JSON.stringify(backfillDates),
        '补卡日期集合与点击范围不一致',
      );
      ensure(row?.streakLabel === '当前连续 27 天，最佳 27 天', `连续未重算：${row?.streakLabel}`);
      ensure(rate === '3 / 14 次 · 完成度 21%', `本周统计未重算：${rate}`);
      ensure(await evaluate('window.__ZX_TEST__.longestBest()') === '27', '页头最长连续未更新');
      return {
        scope: { from: backfillDates[0], to: today, clicks: backfillDates.length },
        logCount: dates.length,
        streak: row?.streakLabel,
        weekRate: rate,
        dailyFailures: daily.filter((item) => item.checked !== 'true'),
      };
    },
    '06-habit-month-backfill.png',
  );

  await runCase(
    {
      id: 'F-016-05',
      feature: 'F-016 习惯',
      name: '补卡撤销与连续重算，再补回',
      expected:
        '撤销 10-20 后连续 7 天、最佳 19；再次补 10-20 后恢复连续 27 天、最佳 27；日志始终无重复',
    },
    async () => {
      const target = `${monthPrefix}-20`;
      await ensureHeatmapMonth(monthPrefix);
      await evaluate('window.__ZX_TEST__.dismissToasts()');
      await clickSelector(
        `.habit-cell[data-habit-id="${newHabitId}"][data-date="${target}"]`,
        `撤销 ${target}`,
      );
      await waitFor(
        `window.__ZX_TEST__.cell('${newHabitId}', '${target}')?.checked === 'false'`,
        `撤销 ${target}`,
      );
      const rowAfterUndo = await evaluate(
        `window.__ZX_TEST__.habitRow('${newHabitId}')`,
      );
      const afterUndo = await evaluate('window.__ZX_TEST__.logDates("' + newHabitId + '")');
      ensure(rowAfterUndo?.streakLabel === '当前连续 7 天，最佳 19 天', `撤销后连续/最佳不符：${rowAfterUndo?.streakLabel}`);
      ensure(afterUndo.length === backfillDates.length - 1, '撤销后日志数不对');

      await clickSelector(
        `.habit-cell[data-habit-id="${newHabitId}"][data-date="${target}"]`,
        `补回 ${target}`,
      );
      await waitFor(
        `window.__ZX_TEST__.cell('${newHabitId}', '${target}')?.checked === 'true'`,
        `补回 ${target}`,
      );
      const rowAfterRedo = await evaluate(
        `window.__ZX_TEST__.habitRow('${newHabitId}')`,
      );
      const logs = await evaluate(`window.__ZX_TEST__.logRows('${newHabitId}')`);
      const activeDates = logs.filter((log) => log.deletedAt === null).map((log) => log.logDate);
      ensure(rowAfterRedo?.streakLabel === '当前连续 27 天，最佳 27 天', `补回后连续不符：${rowAfterRedo?.streakLabel}`);
      ensure(
        new Set(activeDates).size === activeDates.length,
        `存在重复打卡日期：${JSON.stringify(activeDates)}`,
      );
      return { afterUndo: rowAfterUndo?.streakLabel, afterRedo: rowAfterRedo?.streakLabel, logs: logs.length };
    },
    '07-habit-undo-redo.png',
  );

  await runCase(
    {
      id: 'F-016-06',
      feature: 'F-016 习惯',
      name: '月热力图切到上个月并跨月补卡',
      expected: '点「‹」显示 2026 年 9 月热力图（30 列）；补卡 2026-09-15 成功且不改变当前连续；返回 10 月',
    },
    async () => {
      await clickAria('上个月');
      await waitFor(
        `document.querySelector('[aria-label="习惯月热力图"] h2')?.textContent.includes('9 月')`,
        '切换到 9 月',
      );
      const september = await evaluate('window.__ZX_TEST__.heatmap()');
      ensure(september?.dayColumns === 30, `9 月列数应为 30，实际 ${september?.dayColumns}`);
      await clickSelector(
        `.habit-cell[data-habit-id="${newHabitId}"][data-date="2026-09-15"]`,
        '9 月 15 日补卡',
      );
      await waitFor(
        `window.__ZX_TEST__.cell('${newHabitId}', '2026-09-15')?.checked === 'true'`,
        '跨月补卡',
      );
      const row = await evaluate(`window.__ZX_TEST__.habitRow('${newHabitId}')`);
      ensure(row?.streakLabel === '当前连续 27 天，最佳 27 天', `跨月补卡不应改变连续：${row?.streakLabel}`);
      await clickAria('下个月');
      await waitFor(
        `document.querySelector('[aria-label="习惯月热力图"] h2')?.textContent.includes('10 月')`,
        '返回 10 月',
      );
      const dates = await evaluate(`window.__ZX_TEST__.logDates('${newHabitId}')`);
      ensure(dates.includes('2026-09-15'), '9 月 15 日打卡未写入');
      return { septemberHeading: september?.heading, columns: september?.dayColumns, dates: dates.length };
    },
    '08-habit-cross-month.png',
  );

  await runCase(
    {
      id: 'F-016-07',
      feature: 'F-016 习惯',
      name: '未来日期补卡被拒绝',
      expected: `点击 ${futureDate} 出现「还没到这一天」提示，不写日志，格子仍为未打卡`,
    },
    async () => {
      await ensureHeatmapMonth(monthPrefix);
      await evaluate('window.__ZX_TEST__.dismissToasts()');
      await clickSelector(
        `.habit-cell[data-habit-id="${newHabitId}"][data-date="${futureDate}"]`,
        `未来格 ${futureDate}`,
      );
      await waitFor(
        `window.__ZX_TEST__.toasts().some((text) => text.includes('还没到这一天'))`,
        '未来日期提示',
      );
      const toasts = await evaluate('window.__ZX_TEST__.toasts()');
      const cell = await evaluate(
        `window.__ZX_TEST__.cell('${newHabitId}', '${futureDate}')`,
      );
      const dates = await evaluate(`window.__ZX_TEST__.logDates('${newHabitId}')`);
      ensure(cell?.checked === 'false', '未来日期不应写打卡');
      ensure(!dates.includes(futureDate), '未来日期出现在日志中');
      ensure(cell?.disabled === 'true', '未来格禁用样式缺失');
      return { toasts, cell, logCount: dates.length };
    },
    '09-habit-future-rejected.png',
  );

  await observeCase(
    {
      id: 'F-016-08',
      feature: 'F-016 习惯',
      name: '快速连点同一热力格（双击）',
      expected: '快速双击是两次切换；不应产生重复日志行或数据错乱，最终状态可解释',
    },
    async () => {
      const target = `${monthPrefix}-10`;
      const before = await evaluate(
        `window.__ZX_TEST__.cell('${newHabitId}', '${target}')`,
      );
      await doubleClickSelector(
        `.habit-cell[data-habit-id="${newHabitId}"][data-date="${target}"]`,
        `热力格双击 ${target}`,
      );
      await sleep(900);
      const after = await evaluate(
        `window.__ZX_TEST__.cell('${newHabitId}', '${target}')`,
      );
      const rows = await evaluate(`window.__ZX_TEST__.logRows('${newHabitId}')`);
      const rowsForDate = rows.filter((log) => log.logDate === target);
      const activeForDate = rowsForDate.filter((log) => log.deletedAt === null);
      const toasts = await evaluate('window.__ZX_TEST__.toasts()');
      const next = await evaluate(
        `window.__ZX_TEST__.cell('${newHabitId}', '${target}')`,
      );
      if (next?.checked === 'false') {
        await clickSelector(
          `.habit-cell[data-habit-id="${newHabitId}"][data-date="${target}"]`,
          `恢复 ${target}`,
        );
        await waitFor(
          `window.__ZX_TEST__.cell('${newHabitId}', '${target}')?.checked === 'true'`,
          `恢复 ${target} 打卡`,
        );
      }
      const duplicated = activeForDate.length > 1;
      const totalRows = rowsForDate.length;
      return {
        verdict: duplicated ? 'FAIL' : 'PASS',
        detail: {
          before: before?.checked,
          after: after?.checked,
          activeRowsForDate: activeForDate.length,
          totalRowsForDate: totalRows,
          toasts,
          note: '双击=两次切换，最终回到初始状态属 toggle 语义；关键是无重复行',
        },
      };
    },
    '10-habit-double-click.png',
  );

  await runCase(
    {
      id: 'F-016-09',
      feature: 'F-016 习惯',
      name: '刷新后习惯与整月打卡持久化',
      expected: '刷新后「验收习惯A改」仍在，打卡 28 条（10 月 27 格 + 9-15）保留，连续 27 天、本周 3 / 14',
    },
    async () => {
      await reload();
      await waitHabitsReady('刷新后习惯页');
      await waitFor(
        `window.__ZX_TEST__.habits().some((habit) => habit.title === '验收习惯A改')`,
        '刷新后习惯仍在',
      );
      const dates = await evaluate(`window.__ZX_TEST__.logDates('${newHabitId}')`);
      const row = await evaluate(`window.__ZX_TEST__.habitRow('${newHabitId}')`);
      const rate = await evaluate('window.__ZX_TEST__.weekRate()');
      ensure(dates.length === backfillDates.length + 1, `刷新后日志数应为 ${backfillDates.length + 1}，实际 ${dates.length}`);
      ensure(row?.streakLabel === '当前连续 27 天，最佳 27 天', `刷新后连续丢失：${row?.streakLabel}`);
      ensure(rate === '3 / 14 次 · 完成度 21%', `刷新后本周统计不符：${rate}`);
      return { logCount: dates.length, streak: row?.streakLabel, weekRate: rate };
    },
    '11-habit-after-reload.png',
  );

  await runCase(
    {
      id: 'F-016-10',
      feature: 'F-016 习惯',
      name: '安排行动：生成普通任务且不自动打卡',
      expected:
        '今天出现「习惯：验收习惯A改」：清单生活、象限 2、优先级 3、到期今天、备注「来自习惯」；习惯打卡不变、无习惯-任务关系',
    },
    async () => {
      const logsBefore = await evaluate(`window.__ZX_TEST__.logDates('${newHabitId}')`);
      await clickAria('安排行动：验收习惯A改');
      await waitFor(
        `window.__ZX_TEST__.tasksByTitle('习惯：验收习惯A改') > 0`,
        '安排行动创建任务',
      );
      const task = await evaluate(
        `window.__ZX_TEST__.taskByTitle('习惯：验收习惯A改')`,
      );
      const logsAfter = await evaluate(`window.__ZX_TEST__.logDates('${newHabitId}')`);
      ensure(task.listId === 'life', `清单应为 life：${task.listId}`);
      ensure(task.quadrant === 2, `象限应为 2：${task.quadrant}`);
      ensure(task.priority === 3, `优先级应为 3：${task.priority}`);
      ensure(task.dueDate === today, `到期日应为今天：${task.dueDate}`);
      ensure(task.notes === '来自习惯', `备注不符：${task.notes}`);
      ensure(task.status === 'todo', `状态应为 todo：${task.status}`);
      ensure(task.noteId === null, '安排行动不应关联笔记');
      ensure(
        JSON.stringify(logsAfter) === JSON.stringify(logsBefore),
        '安排行动不应改变打卡状态',
      );
      const toast = await evaluate('window.__ZX_TEST__.toasts()');
      return { task, toast, logCount: logsAfter.length };
    },
    '12-habit-arrange-task.png',
  );

  await observeCase(
    {
      id: 'F-016-11',
      feature: 'F-016 习惯',
      name: '快速连点「安排行动」',
      expected: '一次双击用户意图只应创建 1 条任务（或明确拒绝重复）',
    },
    async () => {
      await evaluate('window.__ZX_TEST__.dismissToasts()');
      const before = await evaluate(
        `window.__ZX_TEST__.tasksByTitle('习惯：阅读 20 分钟')`,
      );
      await doubleClickAria('安排行动：阅读 20 分钟');
      await sleep(1200);
      const after = await evaluate(
        `window.__ZX_TEST__.tasksByTitle('习惯：阅读 20 分钟')`,
      );
      const created = after - before;
      return {
        verdict: created <= 1 ? 'PASS' : 'FAIL',
        detail: {
          before,
          after,
          created,
          defect: created > 1 ? 'DEF-AUD015-01 待开卡' : null,
          toasts: await evaluate('window.__ZX_TEST__.toasts()'),
        },
      };
    },
    '13-habit-rapid-arrange.png',
  );

  await runCase(
    {
      id: 'F-016-12',
      feature: 'F-016 习惯',
      name: '习惯打卡计入复盘「习惯打卡」卡',
      expected: `复盘最近 7 天「习惯打卡」= 8 次（阅读今天 1 + 验收习惯 10-21～10-27 共 7），今天柱为 2，2 个习惯`,
    },
    async () => {
      await openNav('复盘');
      await waitFor(
        `document.querySelector('h1')?.textContent.trim() === '复盘'`,
        '复盘页打开',
      );
      await waitFor(
        `!!document.querySelector('.review-stat[aria-label="习惯打卡"]')`,
        '复盘习惯卡渲染',
      );
      const stats = await evaluate('window.__ZX_TEST__.reviewStats()');
      const habitCard = String(stats['习惯打卡']);
      ensure(habitCard.includes('8'), `复盘习惯打卡不含 8：${habitCard}`);
      ensure(habitCard.includes('2 个习惯'), `复盘习惯数应为 2：${habitCard}`);
      const bars = await evaluate(
        `Array.from(document.querySelectorAll('.review-mini-bar--habits')).map((bar) => ({ date: bar.getAttribute('data-date'), value: bar.getAttribute('data-value') }))`,
      );
      const todayBar = bars.find((bar) => bar.date === today);
      ensure(todayBar?.value === '2', `今天习惯柱应为 2：${JSON.stringify(todayBar)}`);
      return { habitCard, todayBar, bars };
    },
    '14-habit-review-link.png',
  );

  await runCase(
    {
      id: 'F-016-13',
      feature: 'F-016 习惯',
      name: '删除习惯：取消→确认→日志同步删除→任务保留',
      expected:
        '确认弹层写明删除习惯与全部打卡；取消后习惯仍在；确认后习惯、热力图行消失，日志全部软删除，已安排任务保留',
    },
    async () => {
      await openNav('习惯');
      await waitHabitsReady();
      await clickAria('编辑习惯：验收习惯A改');
      await waitFor(
        `window.__ZX_TEST__.habitDialog()?.title === '编辑习惯'`,
        '删除前的编辑弹层',
      );
      await evaluate(`window.__ZX_TEST__.clickHabitDialogButton('删除')`);
      await waitFor(
        `!!document.querySelector('.habit-dialog--confirm')`,
        '删除确认弹层',
      );
      const confirmText = await evaluate('window.__ZX_TEST__.confirmText()');
      ensure(
        String(confirmText).includes('将删除「验收习惯A改」和它的全部打卡记录'),
        `删除说明不符：${confirmText}`,
      );
      await screenshot('15-habit-delete-confirm.png');
      await pressEscape();
      await waitFor(
        `!document.querySelector('.habit-dialog--confirm')`,
        'ESC 取消删除确认',
      );
      const backToEdit = await evaluate('window.__ZX_TEST__.habitDialog()');
      ensure(backToEdit?.title === '编辑习惯', '取消删除后应回到编辑弹层');
      ensure(
        await evaluate(`window.__ZX_TEST__.habit('${newHabitId}')?.deletedAt === null`),
        '取消后习惯不应被删除',
      );
      await evaluate(`window.__ZX_TEST__.clickHabitDialogButton('取消')`);
      await waitFor(`!document.querySelector('.habit-dialog')`, '关闭编辑弹层');

      await clickAria('编辑习惯：验收习惯A改');
      await waitFor(
        `window.__ZX_TEST__.habitDialog()?.title === '编辑习惯'`,
        '再次打开编辑弹层',
      );
      await evaluate(`window.__ZX_TEST__.clickHabitDialogButton('删除')`);
      await waitFor(`!!document.querySelector('.habit-dialog--confirm')`, '再次确认弹层');
      await clickText('.habit-dialog--confirm button', '删除');
      await waitFor(
        `window.__ZX_TEST__.habit('${newHabitId}')?.deletedAt !== null`,
        '习惯软删除',
      );
      await waitFor(
        `document.querySelector('.habit-row[data-habit-id="${newHabitId}"]') === null`,
        '习惯行消失',
      );
      const heatmap = await evaluate('window.__ZX_TEST__.heatmap()');
      ensure(!heatmap?.rowIds.includes(newHabitId), '热力图仍显示已删除习惯');
      const logs = await evaluate(`window.__ZX_TEST__.logRows('${newHabitId}')`);
      ensure(
        logs.every((log) => log.deletedAt !== null),
        `仍有未删除日志：${JSON.stringify(logs.filter((log) => log.deletedAt === null))}`,
      );
      const task = await evaluate(
        `window.__ZX_TEST__.taskByTitle('习惯：验收习惯A改')`,
      );
      ensure(task?.deletedAt === null, '删除习惯不应删除已安排任务');
      const remaining = await evaluate('window.__ZX_TEST__.habits()');
      ensure(remaining.length === 1 && remaining[0].id === seedHabitId, '其他习惯不应受影响');
      ensure(await evaluate('window.__ZX_TEST__.weekRate()') === '1 / 7 次 · 完成度 14%', '删除后本周统计未恢复');
      return {
        confirmText,
        logTotal: logs.length,
        logDeleted: logs.filter((log) => log.deletedAt !== null).length,
        taskKept: task?.id,
        remaining,
      };
    },
    '16-habit-deleted.png',
  );

  await runCase(
    {
      id: 'F-016-14',
      feature: 'F-016 习惯',
      name: '删除/编辑不存在的习惯与非法打卡',
      expected:
        '深链 ?habit=不存在 提示「习惯不存在或已被删除」；IPC 删除不存在习惯报错且数量不变；删除不存在打卡报错',
    },
    async () => {
      const before = await evaluate('window.__ZX_TEST__.dbSnapshot()');
      await navigate(`http://127.0.0.1:${PORT}/habits?habit=missing-aud015`);
      await waitHabitsReady();
      await waitFor(
        `window.__ZX_TEST__.toasts().some((text) => text.includes('习惯不存在或已被删除'))`,
        '深链缺失习惯提示',
      );
      const toasts = await evaluate('window.__ZX_TEST__.toasts()');
      const deleteError = await evaluate(`(async () => {
        try {
          await window.__ZX_TEST__.invoke('habits_delete', { id: 'missing-habit-aud015' });
          return 'unexpected-ok';
        } catch (error) {
          return 'error:' + (error?.message ?? String(error));
        }
      })()`);
      const logError = await evaluate(`(async () => {
        try {
          await window.__ZX_TEST__.invoke('habit_logs_delete', { habitId: '${seedHabitId}', date: '2026-10-05' });
          return 'unexpected-ok';
        } catch (error) {
          return 'error:' + (error?.message ?? String(error));
        }
      })()`);
      const after = await evaluate('window.__ZX_TEST__.dbSnapshot()');
      ensure(deleteError.startsWith('error:'), `删除不存在习惯未报错：${deleteError}`);
      ensure(logError.startsWith('error:'), `删除不存在打卡未报错：${logError}`);
      ensure(after.habits.length === before.habits.length, '删除不存在习惯改变了数据');
      ensure(
        after.logs.filter((log) => log.deletedAt === null).length ===
          before.logs.filter((log) => log.deletedAt === null).length,
        '删除不存在打卡改变了日志',
      );
      return { toasts, deleteError, logError };
    },
    '17-habit-missing.png',
  );

  // ------------------------------------------------------------------
  // F-017 专注
  // ------------------------------------------------------------------
  await resetFocusPage('专注页首次进入');
  note('专注页已就绪', await evaluate('window.__ZX_TEST__.focus()'));

  await runCase(
    {
      id: 'F-017-01',
      feature: 'F-017 专注',
      name: '默认配置与三种计时模式切换',
      expected:
        '默认番茄 25/5/15/4，时钟 25:00、专注中、第 1 / 4 轮；切倒计时 25:00；切正计时 00:00 且隐藏番茄配置',
    },
    async () => {
      const initial = await evaluate('window.__ZX_TEST__.focus()');
      const config = await evaluate(`({
        focus: document.querySelector('#focus-minutes')?.value,
        short: document.querySelector('#focus-short-break')?.value,
        long: document.querySelector('#focus-long-break')?.value,
        rounds: document.querySelector('#focus-rounds')?.value,
        autoStart: document.querySelector('#focus-auto-start')?.checked,
      })`);
      ensure(initial.clock === '25:00', `默认时钟应为 25:00：${initial.clock}`);
      ensure(initial.phase.includes('专注中'), `默认阶段应为专注中：${initial.phase}`);
      ensure(initial.phase.includes('第 1 / 4 轮'), `默认轮次显示不符：${initial.phase}`);
      ensure(initial.primary === '开始专注', `默认按钮应为开始专注：${initial.primary}`);
      ensure(config.focus === '25' && config.short === '5' && config.long === '15' && config.rounds === '4', `默认配置不符：${JSON.stringify(config)}`);
      ensure(config.autoStart === true, '默认应勾选自动进入下一段');

      await clickFocusMode('倒计时');
      const countdown = await evaluate('window.__ZX_TEST__.focus()');
      ensure(countdown.clock === '25:00', `倒计时默认应为 25:00：${countdown.clock}`);
      ensure(!countdown.phase.includes('第'), `倒计时不应显示轮次：${countdown.phase}`);
      const countdownSelect = await evaluate(
        `document.querySelector('#focus-countdown-minutes')?.value`,
      );
      ensure(countdownSelect === '25', `倒计时时长控件应为 25：${countdownSelect}`);

      await clickFocusMode('正计时');
      const countup = await evaluate('window.__ZX_TEST__.focus()');
      ensure(countup.clock === '00:00', `正计时默认应为 00:00：${countup.clock}`);
      ensure(countup.primary === '开始计时', `正计时按钮应为开始计时：${countup.primary}`);
      const hint = await evaluate(
        `document.querySelector('.focus-config-hint')?.textContent`,
      );
      ensure(String(hint).includes('从 0 向上累计'), `正计时提示缺失：${hint}`);

      await clickFocusMode('番茄循环');
      return { initial, config, countdown, countup };
    },
    '20-focus-modes.png',
  );

  await runCase(
    {
      id: 'F-017-02',
      feature: 'F-017 专注',
      name: '真实计时：开始/暂停/继续，暂停期间不流逝',
      expected:
        '开始后 3 秒真实时间内时钟递减约 3 秒；暂停后 2 秒真实时间时钟不动且按钮为「继续专注」；继续后继续递减',
    },
    async () => {
      await resetFocusPage('F-017-02 起点');
      await clickFocusAction('开始专注');
      await waitFor(
        `Array.from(document.querySelectorAll('.focus-actions button')).some((el) => el.textContent.includes('暂停'))`,
        '开始后按钮变暂停',
      );
      const startedClock = await focusClock();
      await sleep(3000);
      const after3s = await focusClock();
      const seconds = (clock) => {
        const [minutes, secs] = clock.split(':').map(Number);
        return minutes * 60 + secs;
      };
      const drop = seconds(startedClock) - seconds(after3s);
      ensure(drop >= 1 && drop <= 5, `3 秒真实时间递减异常：${startedClock} → ${after3s}`);

      await clickFocusAction('暂停');
      await waitFor(
        `Array.from(document.querySelectorAll('.focus-actions button')).some((el) => el.textContent.includes('继续专注'))`,
        '暂停后按钮变继续',
      );
      const pausedAt = await focusClock();
      await sleep(2000);
      const afterPauseWait = await focusClock();
      ensure(pausedAt === afterPauseWait, `暂停期间计时仍走动：${pausedAt} → ${afterPauseWait}`);

      await clickFocusAction('继续专注');
      await waitFor(
        `Array.from(document.querySelectorAll('.focus-actions button')).some((el) => el.textContent.includes('暂停'))`,
        '继续后按钮变暂停',
      );
      await sleep(2000);
      const afterResume = await focusClock();
      ensure(
        seconds(pausedAt) - seconds(afterResume) >= 1,
        `继续后计时未前进：${pausedAt} → ${afterResume}`,
      );
      return { startedClock, after3s, dropSeconds: drop, pausedAt, afterPauseWait, afterResume };
    },
    '21-focus-real-timing.png',
  );

  await runCase(
    {
      id: 'F-017-03',
      feature: 'F-017 专注',
      name: '重置：回到 25:00 且不产生记录',
      expected: '点重置后提示「计时已重置」，时钟 25:00、按钮「开始专注」、轮次回到第 1 / 4 轮，专注记录数量不变',
    },
    async () => {
      await resetFocusPage('F-017-03 起点');
      const before = await evaluate('window.__ZX_TEST__.sessions().length');
      // 先真实开表并推进，确保“重置”确实清理正在进行的状态。
      await clickFocusAction('开始专注');
      await evaluate('window.__ZX_TEST__.advanceClock(90_000)');
      await waitClock('<=', 25 * 60 - 30, '重置前计时已推进');
      const running = await evaluate('window.__ZX_TEST__.focus()');
      ensure(running.primary === '暂停', `重置前应处于运行中：${running.primary}`);

      await clickFocusAction('重置');
      await waitFor(
        `window.__ZX_TEST__.focusToasts().some((text) => text.includes('计时已重置'))`,
        '重置提示',
      );
      await waitFor(
        `document.querySelector('[data-testid="focus-clock"]')?.textContent.replace(/\\s+/g, '') === '25:00'`,
        '重置回 25:00',
      );
      const state = await evaluate('window.__ZX_TEST__.focus()');
      const after = await evaluate('window.__ZX_TEST__.sessions().length');
      ensure(state.primary === '开始专注', `重置后按钮不符：${state.primary}`);
      ensure(state.phase.includes('第 1 / 4 轮'), `重置后轮次不符：${state.phase}`);
      ensure(before === after, '重置不应写专注记录');
      ensure(
        state.dots.every((dot) => !dot.done),
        '重置后完成圆点未清空',
      );
      return { running: { clock: running.clock, primary: running.primary }, state: { clock: state.clock, phase: state.phase, primary: state.primary }, records: after };
    },
    '22-focus-reset.png',
  );

  await runCase(
    {
      id: 'F-017-04',
      feature: 'F-017 专注',
      name: '番茄循环：专注→短休→专注→长休→回到专注（虚拟时钟）',
      expected:
        '设 2 轮 + 自动进入下一段；每轮 25 分钟写 1 条记录；第 1 轮后短休 05:00，第 2 轮后长休 15:00，长休结束回到专注 25:00、第 1 / 2 轮',
    },
    async () => {
      await resetFocusPage('F-017-04 起点');
      const sessionBefore = await evaluate('window.__ZX_TEST__.sessions().length');
      const summaryBefore = await evaluate('window.__ZX_TEST__.focus()');
      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-rounds', '2')`);
      ensure(
        (await evaluate(`document.querySelector('#focus-rounds')?.value`)) === '2',
        '轮数未设为 2',
      );
      ensure(
        (await evaluate(`document.querySelector('#focus-auto-start')?.checked`)) === true,
        '自动进入下一段未勾选',
      );
      const taskId = await evaluate(
        `document.querySelector('#focus-task option[value="task-acceptance"]')?.value`,
      );
      ensure(taskId === 'task-acceptance', '关联任务选项缺失');
      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-task', 'task-acceptance')`);
      await waitFor(
        `document.querySelector('#focus-task')?.value === 'task-acceptance'`,
        '选择关联任务',
      );

      const advance = async (minutes) => {
        await evaluate(`window.__ZX_TEST__.advanceClock(${minutes * 60_000})`);
      };

      await clickFocusAction('开始专注');
      await waitFor(
        `Array.from(document.querySelectorAll('.focus-actions button')).some((el) => el.textContent.includes('暂停'))`,
        '第 1 轮开始',
      );
      const round1Start = await evaluate('window.__ZX_TEST__.focus()');
      await advance(25);
      await waitFor(
        `document.querySelector('[data-testid="focus-phase"]')?.textContent.includes('短休息')`,
        '第 1 轮结束进入短休息',
        10_000,
      );
      const shortBreak = await evaluate('window.__ZX_TEST__.focus()');
      ensure(
        Math.abs(secondsOf(shortBreak.clock) - 300) <= 2,
        `短休应为 05:00±2s：${shortBreak.clock}`,
      );
      ensure(shortBreak.primary === '暂停', `自动进入短休后应继续运行：${shortBreak.primary}`);
      const afterRound1 = await evaluate('window.__ZX_TEST__.sessions()');
      ensure(afterRound1.length === sessionBefore + 1, `第 1 轮应写 1 条记录：${afterRound1.length}`);
      ensure(afterRound1[0].minutes === 25, `第 1 轮分钟应为 25：${afterRound1[0].minutes}`);
      ensure(afterRound1[0].mode === 'pomodoro', `记录模式应为 pomodoro：${afterRound1[0].mode}`);
      ensure(afterRound1[0].taskId === 'task-acceptance', '记录未关联所选任务');
      await screenshot('23-focus-short-break.png');

      await advance(5);
      await waitFor(
        `document.querySelector('[data-testid="focus-phase"]')?.textContent.includes('专注中')`,
        '短休结束回到专注',
        10_000,
      );
      const round2 = await evaluate('window.__ZX_TEST__.focus()');
      ensure(
        Math.abs(secondsOf(round2.clock) - 1500) <= 3,
        `第 2 轮应为 25:00±3s：${round2.clock}`,
      );
      ensure(round2.phase.includes('第 2 / 2 轮'), `第 2 轮轮次显示不符：${round2.phase}`);

      await advance(25);
      await waitFor(
        `document.querySelector('[data-testid="focus-phase"]')?.textContent.includes('长休息')`,
        '第 2 轮结束进入长休息',
        10_000,
      );
      const longBreak = await evaluate('window.__ZX_TEST__.focus()');
      ensure(
        Math.abs(secondsOf(longBreak.clock) - 900) <= 2,
        `长休应为 15:00±2s：${longBreak.clock}`,
      );
      ensure(longBreak.phase.includes('第 2 / 2 轮'), `长休轮次显示不符：${longBreak.phase}`);
      const afterRound2 = await evaluate('window.__ZX_TEST__.sessions()');
      ensure(afterRound2.length === sessionBefore + 2, `第 2 轮应再写 1 条：${afterRound2.length}`);
      await screenshot('24-focus-long-break.png');

      await advance(15);
      await waitFor(
        `document.querySelector('[data-testid="focus-phase"]')?.textContent.includes('专注中')`,
        '长休结束回到专注',
        10_000,
      );
      const reset = await evaluate('window.__ZX_TEST__.focus()');
      ensure(
        Math.abs(secondsOf(reset.clock) - 1500) <= 3,
        `长休后应回到 25:00±3s：${reset.clock}`,
      );
      ensure(reset.phase.includes('第 1 / 2 轮'), `长休后轮次应重置：${reset.phase}`);
      ensure(reset.primary === '暂停', `长休后应自动开始：${reset.primary}`);
      const expectedToday =
        Number(String(summaryBefore.todayMinutes).replace(/[^\d]/g, '')) + 50;
      const summary = await evaluate('window.__ZX_TEST__.focusSummaryText()');
      ensure(
        String(reset.todayMinutes).startsWith(String(expectedToday)),
        `今日专注分钟应为 ${expectedToday}：${reset.todayMinutes}`,
      );
      return {
        round1Start: { clock: round1Start.clock, phase: round1Start.phase },
        shortBreak: { clock: shortBreak.clock, primary: shortBreak.primary },
        round2: { clock: round2.clock, phase: round2.phase },
        longBreak: { clock: longBreak.clock, phase: longBreak.phase },
        afterLongBreak: { clock: reset.clock, phase: reset.phase, primary: reset.primary },
        sessions: afterRound2.map((row) => ({ id: row.id, minutes: row.minutes, mode: row.mode, taskId: row.taskId })),
        todayMinutesBefore: summaryBefore.todayMinutes,
        todayMinutesAfter: reset.todayMinutes,
        summary,
      };
    },
    '25-focus-pomodoro-cycle.png',
  );

  await runCase(
    {
      id: 'F-017-05',
      feature: 'F-017 专注',
      name: '倒计时 45 分钟，1 分 30 秒后提前完成并记录',
      expected: '按已过分钟写入 1 条 2 分钟记录，模式 countdown，时钟回到 45:00，今日分钟 +2',
    },
    async () => {
      await resetFocusPage('F-017-05 起点');
      const before = await evaluate('window.__ZX_TEST__.sessions()');
      await clickFocusMode('倒计时');
      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-countdown-minutes', '45')`);
      await waitFor(
        `document.querySelector('#focus-countdown-minutes')?.value === '45' &&
          document.querySelector('[data-testid="focus-clock"]')?.textContent.replace(/\\s+/g, '') === '45:00'`,
        '倒计时时长设为 45 分钟',
      );
      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-task', 'task-acceptance')`);
      await waitFor(`document.querySelector('#focus-task')?.value === 'task-acceptance'`, '选择任务');
      await clickFocusAction('开始专注');
      await evaluate('window.__ZX_TEST__.advanceClock(90_000)');
      // 确定性等待：虚拟时钟推进 90 秒后，界面必须先渲染出“已过 90 秒”，
      // 再读取并断言；不用固定 sleep 猜测 tick 何时刷新。
      await waitClock('<=', 45 * 60 - 90, '倒计时 1.5 分钟后剩余时间更新');
      const mid = await evaluate('window.__ZX_TEST__.focus()');
      const midSeconds = secondsOf(mid.clock);
      ensure(
        midSeconds <= 45 * 60 - 90 && midSeconds >= 45 * 60 - 105,
        `1.5 分钟后应剩约 43:30：${mid.clock}`,
      );
      ensure(mid.primary === '暂停', `倒计时不应提前停表：${mid.primary}`);
      await clickFocusAction('完成并记录');
      await waitFor(
        `window.__ZX_TEST__.focusToasts().some((text) => text.includes('已记录 2 分钟专注'))`,
        '倒计时完成记录提示',
      );
      await waitFor(
        `document.querySelector('[data-testid="focus-clock"]')?.textContent.replace(/\\s+/g, '') === '45:00' &&
          Array.from(document.querySelectorAll('.focus-actions button')).some(
            (el) => el.textContent.replace(/\\s+/g, ' ').trim() === '开始专注')`,
        '倒计时重置到 45:00 且停表',
      );
      const after = await evaluate('window.__ZX_TEST__.sessions()');
      ensure(after.length === before.length + 1, `应新增 1 条记录：${after.length}`);
      const latest = after[0];
      ensure(latest.minutes === 2, `记录分钟应为 2：${latest.minutes}`);
      ensure(latest.mode === 'countdown', `模式应为 countdown：${latest.mode}`);
      ensure(latest.taskId === 'task-acceptance', '未记录任务');
      const state = await evaluate('window.__ZX_TEST__.focus()');
      const totals = { before: before.length, after: after.length };
      return { mid: { clock: mid.clock, phase: mid.phase }, latest, state: { clock: state.clock, primary: state.primary }, totals };
    },
    '26-focus-countdown.png',
  );

  await runCase(
    {
      id: 'F-017-06',
      feature: 'F-017 专注',
      name: '正计时 90 秒后完成并记录',
      expected: '记录 2 分钟、模式 countup；记录后时钟归零 00:00，按钮「开始计时」',
    },
    async () => {
      await resetFocusPage('F-017-06 起点');
      const before = await evaluate('window.__ZX_TEST__.sessions()');
      await clickFocusMode('正计时');
      await waitFor(
        `document.querySelector('[data-testid="focus-clock"]')?.textContent.replace(/\\s+/g, '') === '00:00'`,
        '正计时从 00:00 开始',
      );
      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-task', 'task-acceptance')`);
      await waitFor(`document.querySelector('#focus-task')?.value === 'task-acceptance'`, '选择任务');
      await clickFocusAction('开始计时');
      await evaluate('window.__ZX_TEST__.advanceClock(90_000)');
      // 正计时只会继续增大；等待“至少 90 秒”而不是精确等于 01:30。
      await waitClock('>=', 90, '正计时已累计 90 秒');
      const mid = await evaluate('window.__ZX_TEST__.focus()');
      const elapsed = secondsOf(mid.clock);
      ensure(
        elapsed >= 90 && elapsed <= 130,
        `正计时 90 秒后应约 01:30（不超过 02:10）：${mid.clock}`,
      );
      await clickFocusAction('完成并记录');
      await waitFor(
        `window.__ZX_TEST__.focusToasts().some((text) => text.includes('已记录 2 分钟专注'))`,
        '正计时记录提示',
      );
      await waitFor(
        `document.querySelector('[data-testid="focus-clock"]')?.textContent.replace(/\\s+/g, '') === '00:00'`,
        '正计时归零',
      );
      const after = await evaluate('window.__ZX_TEST__.sessions()');
      ensure(after.length === before.length + 1, '正计时记录数不符');
      ensure(after[0].minutes === 2, `正计时分钟应为 2：${after[0].minutes}`);
      ensure(after[0].mode === 'countup', `模式应为 countup：${after[0].mode}`);
      const state = await evaluate('window.__ZX_TEST__.focus()');
      ensure(state.primary === '开始计时', `归零后按钮不符：${state.primary}`);
      return { elapsed: mid.clock, latest: after[0], state: { clock: state.clock, primary: state.primary } };
    },
    '27-focus-countup.png',
  );

  await runCase(
    {
      id: 'F-017-07',
      feature: 'F-017 专注',
      name: '未选任务时「完成并记录」被拒绝且不写记录，可恢复',
      expected:
        '不选任务完成 → 提示「先选择一个任务，本次专注不会记录」，记录数不变；选任务后可再记录 2 分钟',
    },
    async () => {
      await resetFocusPage('F-017-07 起点');
      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-task', '')`);
      await waitFor(`document.querySelector('#focus-task')?.value === ''`, '清空关联任务');
      const before = await evaluate('window.__ZX_TEST__.sessions()');
      await clickFocusAction('开始专注');
      await evaluate('window.__ZX_TEST__.advanceClock(120_000)');
      await waitClock('<=', 25 * 60 - 110, '无任务用例计时已推进约 2 分钟');
      await clickFocusAction('完成并记录');
      await waitFor(
        `window.__ZX_TEST__.focusToasts().some((text) => text.includes('先选择一个任务'))`,
        '无任务拒绝提示',
      );
      const mid = await evaluate('window.__ZX_TEST__.focus()');
      const afterReject = await evaluate('window.__ZX_TEST__.sessions()');
      ensure(afterReject.length === before.length, '无任务时不应写记录');
      ensure(String(mid.inlineError).includes('先选择一个任务'), `缺行内错误：${mid.inlineError}`);

      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-task', 'task-acceptance')`);
      await waitFor(`document.querySelector('#focus-task')?.value === 'task-acceptance'`, '重新选择任务');
      await clickFocusAction('完成并记录');
      await waitFor(
        `window.__ZX_TEST__.sessions().length === ${before.length + 1}`,
        '选任务后补记成功',
      );
      const recovered = await evaluate('window.__ZX_TEST__.sessions()');
      ensure(recovered[0].minutes === 2, `恢复记录分钟应为 2：${recovered[0].minutes}`);
      return { inlineError: mid.inlineError, recordsBefore: before.length, recordsAfterReject: afterReject.length, recovered: recovered[0] };
    },
    '28-focus-no-task.png',
  );

  await runCase(
    {
      id: 'F-017-08',
      feature: 'F-017 专注',
      name: '手动补记 30 分钟计入今日/本周并出现在最近记录',
      expected: '补记 30 分钟写入 mode=manual、关联所选任务；最近记录首行为 30 分钟 + 补记标签，今日/本周分钟同步增加',
    },
    async () => {
      await resetFocusPage('F-017-08 起点');
      const before = await evaluate('window.__ZX_TEST__.focus()');
      const sessionsBefore = await evaluate('window.__ZX_TEST__.sessions()');
      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-task', 'task-acceptance')`);
      await waitFor(`document.querySelector('#focus-task')?.value === 'task-acceptance'`, '选择补记任务');
      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-manual-minutes', '30')`);
      await clickText('.focus-manual button', '手动补记');
      await waitFor(
        `window.__ZX_TEST__.focusToasts().some((text) => text.includes('已补记 30 分钟专注'))`,
        '补记提示',
      );
      const after = await evaluate('window.__ZX_TEST__.focus()');
      const sessionsAfter = await evaluate('window.__ZX_TEST__.sessions()');
      ensure(sessionsAfter.length === sessionsBefore.length + 1, '补记未写记录');
      ensure(sessionsAfter[0].minutes === 30, `补记分钟不符：${sessionsAfter[0].minutes}`);
      ensure(sessionsAfter[0].mode === 'manual', `补记模式不符：${sessionsAfter[0].mode}`);
      // 最近记录按 startedAt 倒序；本用例之前的番茄循环推进了虚拟时钟，
      // 其记录时间晚于当前真实时间，因此只断言补记行出现在列表中，而不是首行。
      const manualRow = after.recent.find(
        (row) => String(row).includes('30 分钟') && String(row).includes('补记'),
      );
      ensure(manualRow, `最近记录缺少 30 分钟补记行：${JSON.stringify(after.recent)}`);
      const toNum = (text) => Number(String(text).replace(/[^\d]/g, ''));
      ensure(
        toNum(after.todayMinutes) === toNum(before.todayMinutes) + 30,
        `今日分钟未 +30：${before.todayMinutes} → ${after.todayMinutes}`,
      );
      ensure(
        toNum(after.weekMinutes) === toNum(before.weekMinutes) + 30,
        `本周分钟未 +30：${before.weekMinutes} → ${after.weekMinutes}`,
      );
      return { before: { today: before.todayMinutes, week: before.weekMinutes }, after: { today: after.todayMinutes, week: after.weekMinutes }, recentTop: after.recent[0], manualRow };
    },
    '29-focus-manual.png',
  );

  await runCase(
    {
      id: 'F-017-09',
      feature: 'F-017 专注',
      name: '无任务时手动补记被拒绝',
      expected: '清空任务后补记 30 分钟提示缺少任务，不写记录',
    },
    async () => {
      await resetFocusPage('F-017-09 起点');
      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-task', '')`);
      await waitFor(`document.querySelector('#focus-task')?.value === ''`, '清空关联任务');
      const before = await evaluate('window.__ZX_TEST__.sessions().length');
      await clickText('.focus-manual button', '手动补记');
      await waitFor(
        `window.__ZX_TEST__.focusToasts().some((text) => text.includes('先选择一个任务'))`,
        '补记无任务提示',
      );
      const after = await evaluate('window.__ZX_TEST__.sessions().length');
      ensure(after === before, '无任务补记不应写记录');
      return { before, after, toast: await evaluate('window.__ZX_TEST__.focusToasts()') };
    },
    '30-focus-manual-no-task.png',
  );

  await runCase(
    {
      id: 'F-017-10',
      feature: 'F-017 专注',
      name: '快速连点「完成并记录」只产生 1 条记录',
      expected: '计时 2 分钟后双击「完成并记录」，只写 1 条记录（第二次点击被保存中状态拦截）',
    },
    async () => {
      await resetFocusPage('F-017-10 起点');
      const before = await evaluate('window.__ZX_TEST__.sessions().length');
      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-task', 'task-acceptance')`);
      await waitFor(`document.querySelector('#focus-task')?.value === 'task-acceptance'`, '选择任务');
      await clickFocusAction('开始专注');
      await evaluate('window.__ZX_TEST__.advanceClock(120_000)');
      await waitClock('<=', 25 * 60 - 110, '连点用例计时已推进约 2 分钟');
      const point = await pointFor(
        `Array.from(document.querySelectorAll('.focus-actions button')).find(
          (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === '完成并记录')`,
        '.focus-actions 按钮 文本=完成并记录',
      );
      // 两次真实鼠标点击紧邻发送（20ms），验证保存中锁而不是慢速顺序点击。
      await doubleClickPointFast(point);
      await waitFor(
        `window.__ZX_TEST__.sessions().length === ${before + 1}`,
        '双击后写入 1 条记录',
      );
      await sleep(1200);
      const after = await evaluate('window.__ZX_TEST__.sessions().length');
      const added = after - before;
      ensure(added === 1, `双击应只产生 1 条记录，实际 ${added} 条`);
      return {
        before,
        after,
        added,
        toasts: await evaluate('window.__ZX_TEST__.focusToasts()'),
      };
    },
    '31-focus-rapid-finish.png',
  );

  await runCase(
    {
      id: 'F-017-11',
      feature: 'F-017 专注',
      name: '白噪音：雨声/音量/切换/关闭（AudioContext 替身）',
      expected:
        '选雨声后状态「播放中 · 雨声」、音量 50%、gain=0.08；调 70% → gain=0.112；切棕噪 → 旧 source 停止并新建；关闭 → 状态「未播放」且 source 停止',
    },
    async () => {
      await resetFocusPage('F-017-11 起点');
      await evaluate('window.__ZX_TEST__.resetAudioCounters()');
      const initial = await evaluate('window.__ZX_TEST__.focus()');
      ensure(initial.noiseState === '未播放', `初始噪声状态不符：${initial.noiseState}`);
      await clickText('.focus-noise-button', '雨声');
      await waitFor(
        `document.querySelector('[data-testid="noise-state"]')?.textContent.includes('播放中')`,
        '雨声播放状态',
      );
      const rain = await evaluate('window.__ZX_TEST__.focus()');
      const audioAfterRain = await evaluate('window.__ZX_TEST__.audio()');
      ensure(rain.noiseState === '播放中 · 雨声', `雨声状态不符：${rain.noiseState}`);
      ensure(rain.volume === '50', `默认音量应为 50：${rain.volume}`);
      ensure(audioAfterRain.starts === 1, `应创建 1 个 source：${audioAfterRain.starts}`);
      const gainRain = audioAfterRain.gains.at(-1)?.gain?.value;
      ensure(Math.abs(gainRain - 0.08) < 1e-6, `50% 对应 gain 应为 0.08：${gainRain}`);
      const filterRain = audioAfterRain.filters.at(-1);
      ensure(filterRain?.type === 'bandpass', `雨声应使用 bandpass：${filterRain?.type}`);

      await evaluate('window.__ZX_TEST__.setRangeValue(70)');
      await waitFor(
        `document.querySelector('#focus-noise-volume')?.value === '70'`,
        '音量调到 70',
      );
      const audioAfterVolume = await evaluate('window.__ZX_TEST__.audio()');
      const gainVolume = audioAfterVolume.gains.at(-1)?.gain?.value;
      ensure(Math.abs(gainVolume - 0.112) < 1e-6, `70% 对应 gain 应为 0.112：${gainVolume}`);

      await clickText('.focus-noise-button', '棕噪');
      await waitFor(
        `document.querySelector('[data-testid="noise-state"]')?.textContent.includes('棕噪')`,
        '切换棕噪',
      );
      const audioAfterBrown = await evaluate('window.__ZX_TEST__.audio()');
      ensure(audioAfterBrown.starts === 2, `切换后应再建 source：${audioAfterBrown.starts}`);
      ensure(audioAfterBrown.stops >= 1, '切换后旧 source 未停止');
      const brownFilter = audioAfterBrown.filters.at(-1);
      ensure(brownFilter?.type === 'lowpass', `棕噪应使用 lowpass：${brownFilter?.type}`);
      await screenshot('32-focus-noise.png');

      await clickText('.focus-noise-button', '关闭');
      await waitFor(
        `document.querySelector('[data-testid="noise-state"]')?.textContent.trim() === '未播放'`,
        '关闭噪声',
      );
      const audioClosed = await evaluate('window.__ZX_TEST__.audio()');
      ensure(
        audioClosed.sources.filter((source) => source.started && !source.stopped).length === 0,
        '关闭后仍有播放中的 source',
      );
      const state = await evaluate('window.__ZX_TEST__.focus()');
      ensure(state.noiseActive === '关闭', `关闭后激活按钮应为关闭：${state.noiseActive}`);
      return {
        rain: { state: rain.noiseState, volume: rain.volume, gain: gainRain, filter: filterRain?.type },
        volume70Gain: gainVolume,
        brown: { starts: audioAfterBrown.starts, stops: audioAfterBrown.stops, filter: brownFilter?.type },
        closed: { state: state.noiseState, starts: audioClosed.starts, stops: audioClosed.stops },
      };
    },
    '33-focus-noise-closed.png',
  );

  await runCase(
    {
      id: 'F-017-12',
      feature: 'F-017 专注',
      name: '白噪音与计时切页：离开专注页后继续',
      expected:
        '雨声+70%+计时运行，切到「今天」再回「专注」：计时继续（约 22:00）、白噪音仍播放且音量 70%、任务选择保留',
    },
    async () => {
      await resetFocusPage('F-017-12 起点');
      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-task', 'task-acceptance')`);
      await waitFor(`document.querySelector('#focus-task')?.value === 'task-acceptance'`, '选择任务');
      await clickText('.focus-noise-button', '雨声');
      await waitFor(
        `document.querySelector('[data-testid="noise-state"]')?.textContent.includes('雨声')`,
        '再次播放雨声',
      );
      await evaluate('window.__ZX_TEST__.setRangeValue(70)');
      await waitFor(
        `document.querySelector('#focus-noise-volume')?.value === '70'`,
        '音量调到 70',
      );
      const audioBeforeLeave = await evaluate('window.__ZX_TEST__.audio()');
      await clickFocusAction('开始专注');
      await evaluate('window.__ZX_TEST__.advanceClock(180_000)');
      await waitClock('<=', 25 * 60 - 170, '切页前虚拟时钟已推进约 3 分钟');
      const beforeLeave = await evaluate('window.__ZX_TEST__.focus()');
      const wallBeforeLeave = await evaluate('window.__ZX_CLOCK__.realNow()');
      const beforeSeconds = secondsOf(beforeLeave.clock);
      ensure(
        beforeSeconds <= 25 * 60 - 170 && beforeSeconds >= 25 * 60 - 200,
        `切页前应约 22:00：${beforeLeave.clock}`,
      );
      await screenshot('34-focus-before-leave.png');

      await openNav('今天');
      await waitFor(
        `document.querySelector('h1')?.textContent.trim() === '今天'`,
        '切到今天页',
      );
      await sleep(1500);
      await openNav('专注');
      await waitFocusReady('回到专注页');
      await waitFor(
        `Array.from(document.querySelectorAll('.focus-actions button')).some(
          (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === '暂停')`,
        '回到专注页后计时仍在运行',
      );
      const afterReturn = await evaluate('window.__ZX_TEST__.focus()');
      const wallAfterReturn = await evaluate('window.__ZX_CLOCK__.realNow()');
      const audioAfterReturn = await evaluate('window.__ZX_TEST__.audio()');
      const toSeconds = (text) => {
        const [minutes, secs] = String(text).split(':').map(Number);
        return minutes * 60 + secs;
      };
      const afterSeconds = toSeconds(afterReturn.clock);
      const elapsedWhileAway = beforeSeconds - afterSeconds;
      const wallSeconds = (wallAfterReturn - wallBeforeLeave) / 1000;
      // 只断言边界：计时继续（不是归零/回到 25:00），且落差与真实离开时长一致。
      ensure(afterReturn.primary === '暂停', `切页后计时停止运行：${afterReturn.primary}`);
      ensure(afterSeconds > 0 && afterSeconds < 25 * 60, `切页后计时归零或重置：${afterReturn.clock}`);
      ensure(
        elapsedWhileAway >= 1,
        `切页期间计时未继续：${beforeLeave.clock} → ${afterReturn.clock}（离开 ${wallSeconds.toFixed(1)}s）`,
      );
      ensure(
        elapsedWhileAway <= Math.ceil(wallSeconds) + 8,
        `切页期间计时跳变：${beforeLeave.clock} → ${afterReturn.clock}（离开 ${wallSeconds.toFixed(1)}s）`,
      );
      ensure(afterReturn.noiseState === '播放中 · 雨声', `切页后噪声状态不符：${afterReturn.noiseState}`);
      ensure(afterReturn.volume === '70', `切页后音量丢失：${afterReturn.volume}`);
      ensure(
        audioAfterReturn.stops === audioBeforeLeave.stops,
        `切页导致 source 被停止：${audioBeforeLeave.stops} → ${audioAfterReturn.stops}`,
      );
      ensure(afterReturn.selectedTask === 'task-acceptance', '切页后关联任务丢失');

      await evaluate('window.__ZX_TEST__.advanceClock(60_000)');
      await waitClock('<=', afterSeconds - 30, '切页返回后计时继续前进');
      const afterAdvance = await evaluate('window.__ZX_TEST__.focus()');
      ensure(
        afterSeconds - toSeconds(afterAdvance.clock) >= 30,
        `切页返回后计时不再前进：${afterReturn.clock} → ${afterAdvance.clock}`,
      );
      return {
        beforeLeave: { clock: beforeLeave.clock, phase: beforeLeave.phase, noise: beforeLeave.noiseState },
        afterReturn: { clock: afterReturn.clock, phase: afterReturn.phase, noise: afterReturn.noiseState, volume: afterReturn.volume, task: afterReturn.selectedTask },
        elapsedWhileAway,
        wallSeconds: Number(wallSeconds.toFixed(1)),
        stops: { before: audioBeforeLeave.stops, after: audioAfterReturn.stops },
        afterAdvance: afterAdvance.clock,
      };
    },
    '35-focus-after-return.png',
  );

  await observeCase(
    {
      id: 'F-017-13',
      feature: 'F-017 专注',
      name: '刷新页面：内存计时丢失（PRD 边界），已记录数据保留',
      expected:
        'PRD 说明刷新/关闭即结束本次内存计时；刷新后计时回到 25:00 未运行、白噪音停止，但已写入记录仍在',
    },
    async () => {
      await resetFocusPage('F-017-13 起点');
      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-task', 'task-acceptance')`);
      await waitFor(`document.querySelector('#focus-task')?.value === 'task-acceptance'`, '选择任务');
      await clickText('.focus-noise-button', '雨声');
      await waitFor(
        `document.querySelector('[data-testid="noise-state"]')?.textContent.includes('雨声')`,
        '刷新前播放雨声',
      );
      await clickFocusAction('开始专注');
      await evaluate('window.__ZX_TEST__.advanceClock(60_000)');
      await waitClock('<=', 25 * 60 - 45, '刷新前计时已推进');
      const sessionsBefore = await evaluate('window.__ZX_TEST__.sessions().length');
      const runningBefore = await evaluate('window.__ZX_TEST__.focus()');
      ensure(runningBefore.primary === '暂停', `刷新前应处于运行中：${runningBefore.primary}`);
      await reload();
      await waitFocusReady('刷新后专注页');
      const after = await evaluate('window.__ZX_TEST__.focus()');
      const sessionsAfter = await evaluate('window.__ZX_TEST__.sessions().length');
      ensure(after.primary === '开始专注', `刷新后不应仍在计时：${after.primary}`);
      ensure(after.clock === '25:00', `刷新后时钟应为 25:00：${after.clock}`);
      ensure(after.noiseState === '未播放', `刷新后噪声应为未播放：${after.noiseState}`);
      ensure(sessionsAfter === sessionsBefore, `刷新不应改变记录数：${sessionsBefore} → ${sessionsAfter}`);
      ensure(sessionsAfter > 0, '刷新后历史记录丢失');
      return {
        verdict: 'OBSERVED',
        detail: {
          runningBefore: { clock: runningBefore.clock, phase: runningBefore.phase },
          afterReload: { clock: after.clock, phase: after.phase, primary: after.primary, noise: after.noiseState },
          sessions: sessionsAfter,
          prd: 'PRD §3.6.10 切页继续、刷新丢失为原型/正式版边界',
        },
      };
    },
    '36-focus-after-reload.png',
  );

  await runCase(
    {
      id: 'F-017-14',
      feature: 'F-017 专注',
      name: '删除不存在的专注记录/非法分钟数',
      expected: 'IPC 删除不存在记录报错且数量不变；补记 0 或 1441 分钟被拒绝且不写记录',
    },
    async () => {
      await resetFocusPage('F-017-14 起点');
      const before = await evaluate('window.__ZX_TEST__.sessions()');
      const deleteError = await evaluate(`(async () => {
        try {
          await window.__ZX_TEST__.invoke('focus_sessions_delete', { id: 'missing-focus-aud015' });
          return 'unexpected-ok';
        } catch (error) {
          return 'error:' + (error?.message ?? String(error));
        }
      })()`);

      // 0 分钟：input[type=number][min=1] 由浏览器原生约束拦截，提交事件不会到达业务层。
      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-manual-minutes', '0')`);
      await sleep(150);
      await clickText('.focus-manual button', '手动补记');
      await sleep(400);
      const zero = await evaluate(`(() => {
        const input = document.querySelector('#focus-manual-minutes');
        const form = document.querySelector('.focus-manual');
        return {
          value: input?.value,
          rangeUnderflow: input?.validity?.rangeUnderflow ?? null,
          formValid: form?.checkValidity() ?? null,
          validationMessage: input?.validationMessage || '',
          toasts: window.__ZX_TEST__.focusToasts(),
        };
      })()`);
      ensure(zero.value === '0', `0 分钟输入值不符：${zero.value}`);
      ensure(zero.rangeUnderflow === true, '0 分钟应被浏览器原生 min 约束拦截');
      ensure(zero.formValid === false, '0 分钟表单不应通过原生校验');
      ensure(
        !zero.toasts.some((text) => text.includes('已补记')),
        `0 分钟不应产生补记提示：${JSON.stringify(zero.toasts)}`,
      );
      const afterZero = await evaluate('window.__ZX_TEST__.sessions()');
      ensure(afterZero.length === before.length, '0 分钟补记改变了记录数');

      // 业务层兜底：绕过原生校验直接派发 submit，仍应给出 1–1440 拒绝提示。
      await evaluate(
        `document.querySelector('.focus-manual').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))`,
      );
      await waitFor(
        `window.__ZX_TEST__.focusToasts().some((text) => text.includes('1–1440'))`,
        '0 分钟业务层拒绝提示',
      );

      // 1441 分钟：input[max=1440] 同样由原生约束拦截；业务层兜底也拒绝。
      await evaluate(`window.__ZX_TEST__.setFocusSelect('#focus-manual-minutes', '1441')`);
      await sleep(150);
      await clickText('.focus-manual button', '手动补记');
      await sleep(400);
      const overflow = await evaluate(`(() => {
        const input = document.querySelector('#focus-manual-minutes');
        return {
          value: input?.value,
          rangeOverflow: input?.validity?.rangeOverflow ?? null,
          formValid: document.querySelector('.focus-manual')?.checkValidity() ?? null,
        };
      })()`);
      ensure(overflow.value === '1441', `1441 分钟输入值不符：${overflow.value}`);
      ensure(overflow.rangeOverflow === true, '1441 分钟应被浏览器原生 max 约束拦截');
      ensure(overflow.formValid === false, '1441 分钟表单不应通过原生校验');
      await evaluate(
        `document.querySelector('.focus-manual').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))`,
      );
      await waitFor(
        `window.__ZX_TEST__.focusToasts().some((text) => text.includes('1–1440'))`,
        '1441 分钟业务层拒绝提示',
      );

      const after = await evaluate('window.__ZX_TEST__.sessions()');
      ensure(deleteError.startsWith('error:'), `删除不存在专注记录未报错：${deleteError}`);
      ensure(after.length === before.length, '非法操作改变了记录数');
      const negative = await evaluate(`(async () => {
        try {
          await window.__ZX_TEST__.invoke('focus_sessions_create', { input: { taskId: 'task-acceptance', minutes: 0, startedAt: '2026-10-27T10:00:00+08:00' } });
          return 'unexpected-ok';
        } catch (error) {
          return 'error:' + (error?.message ?? String(error));
        }
      })()`);
      ensure(negative.startsWith('error:'), 'IPC 应拒绝 0 分钟记录');
      return {
        deleteError,
        negative,
        records: after.length,
        zero: { value: zero.value, rangeUnderflow: zero.rangeUnderflow, formValid: zero.formValid },
        overflow: { value: overflow.value, rangeOverflow: overflow.rangeOverflow, formValid: overflow.formValid },
        toasts: await evaluate('window.__ZX_TEST__.focusToasts()'),
      };
    },
    '37-focus-invalid.png',
  );

  // ------------------------------------------------------------------
  // 空数据：习惯 / 专注
  // ------------------------------------------------------------------
  let emptyChecked = false;
  await runCase(
    {
      id: 'GLOBAL-02',
      feature: '全局',
      name: '空数据：习惯空态与专注空态',
      expected:
        '清空 habits/logs/sessions 后：习惯显示「还没有习惯」+ 新建入口；专注显示 0 分钟 0 段、最近记录「还没有专注记录」，无 NaN/undefined',
    },
    async () => {
      await evaluate(`window.__ZX_TEST__.setEmptyKeys(['habits','logs','sessions'])`);
      await navigate(`http://127.0.0.1:${PORT}/habits`);
      await waitHabitsReady('空数据习惯页');
      const emptyText = await evaluate('window.__ZX_TEST__.habitEmptyText()');
      ensure(String(emptyText).includes('还没有习惯'), `习惯空态缺失：${emptyText}`);
      ensure(String(emptyText).includes('新建第一个习惯'), '习惯空态缺少新建入口');
      const heatmap = await evaluate('window.__ZX_TEST__.heatmap()');
      ensure(heatmap === null, '空数据不应渲染热力图');
      await screenshot('40-empty-habits.png');

      await navigate(`http://127.0.0.1:${PORT}/focus`);
      await waitFocusReady('空数据专注页');
      const focus = await evaluate('window.__ZX_TEST__.focus()');
      const body = await evaluate('window.__ZX_TEST__.bodyText()');
      ensure(focus.todayMinutes === '0 分钟', `空数据今日分钟不符：${focus.todayMinutes}`);
      ensure(focus.todayCount === '0', `空数据今日段数不符：${focus.todayCount}`);
      ensure(focus.recent.length === 0, `空数据不应有最近记录：${focus.recent}`);
      ensure(body.includes('还没有专注记录'), '专注空态文案缺失');
      ensure(!/NaN|undefined|Infinity/.test(body), '空数据出现 NaN/undefined/Infinity');
      await screenshot('41-empty-focus.png');
      emptyChecked = true;
      return { emptyText, heatmap, focus: { todayMinutes: focus.todayMinutes, todayCount: focus.todayCount, recent: focus.recent } };
    },
    null,
  );

  await runCase(
    {
      id: 'GLOBAL-01',
      feature: '全局',
      name: '控制台零错误/零页面异常',
      expected: 'console.error=0，page exception=0；记录 console.warn',
    },
    async () => {
      ensure(emptyChecked, '空数据检查未执行');
      ensure(
        consoleErrors.length === 0,
        `控制台错误：${JSON.stringify(consoleErrors)}`,
      );
      ensure(
        pageExceptions.length === 0,
        `页面异常：${JSON.stringify(pageExceptions)}`,
      );
      return { consoleErrors, pageExceptions, consoleWarns };
    },
    '42-console.png',
  );

  note('AUD-015 浏览器实测完成');
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
  console.log('\nAUD015_BROWSER_SUMMARY\n' + summaries.join('\n'));
  const counts = results.reduce(
    (acc, item) => {
      acc[item.verdict] = (acc[item.verdict] ?? 0) + 1;
      return acc;
    },
    {},
  );
  console.log('\nAUD015_COUNTS=' + JSON.stringify(counts));
  if (failed.length > 0) {
    console.error(`\nAUD015_FAILURES=${failed.length}`);
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
    console.log('\nAUD015_BROWSER_EXIT=0');
  }
} catch (error) {
  console.error('[aud015-browser] 失败：', error);
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
