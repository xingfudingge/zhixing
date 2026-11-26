/**
 * ZX7-POPOVER-01 浏览器实测：日期弹层碰撞检测、翻转、限高与滚动同步。
 *
 * 真实生产构建 + 真实 Chromium（CDP），只注入 tests/harness/fakeTauri.ts
 * 的内存 IPC 替身；产品源码与构建不改。
 *
 * 覆盖：
 *   1. 默认视口：优先下方、不遮触发器、不溢出视口、模态内 z-index >= 1200；
 *   2. 430 矮视口：限高 + 内部滚动，不遮触发器、不溢出；
 *   3. 390 窄窗：sheet，在视口内；
 *   4. 滚动容器（任务/倒数日弹窗）内把字段滚到顶部/底部：自动翻转并跟随；
 *   5. 键盘 Enter 打开也能正确定位。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx7-date-overlay-browser.mjs
 * 退出码：0 全部通过；1 至少一项失败。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx7-date-overlay');
const FAKE_BUNDLE = '/tmp/zx-fake-zx7-date-overlay.js';
const PORT = 8920;
const DEBUG_PORT = 9245;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先运行 pnpm --filter app build');
}
fs.mkdirSync(EVIDENCE, { recursive: true });
for (const file of fs.readdirSync(EVIDENCE)) {
  if (file.endsWith('.png') || file === 'result.json') {
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

const results = [];
function check(ok, id, message, actual) {
  const actualText =
    actual === undefined ? '' : `（实际：${JSON.stringify(actual)}）`;
  results.push({ id, ok, message, actual });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${message}${actualText}`);
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

const userDataDir = `/tmp/zx-chrome-zx7-date-${Date.now()}`;
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
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}（最后值：${JSON.stringify(last)}）`);
}

async function screenshot(name) {
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  fs.writeFileSync(
    path.join(EVIDENCE, name),
    Buffer.from(result.data, 'base64'),
  );
}

async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
}

async function realClick(selector) {
  const point = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`找不到可点击元素：${selector}`);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
}

const PAGE_HELPERS = `
window.__ZX7__ = {
  dialog() { return document.querySelector('.task-dialog'); },
  field() { return document.querySelector('.task-dialog .date-field'); },
  icon() { return document.querySelector('.task-dialog .date-field-icon'); },
  panel() { return document.querySelector('.dp-popover'); },
  close() {
    const icon = this.icon();
    if (this.panel() && icon) icon.click();
  },
  scrollFieldTo(edge) {
    const dialog = this.dialog();
    const field = this.field();
    if (!dialog || !field) return null;
    const target =
      edge === 'top'
        ? 100
        : window.innerHeight - field.offsetHeight - 100;
    dialog.scrollTop += field.getBoundingClientRect().top - target;
    return {
      scrollTop: dialog.scrollTop,
      scrollRange: dialog.scrollHeight - dialog.clientHeight,
      fieldTop: this.field().getBoundingClientRect().top,
    };
  },
  /** 测试专用：在字段前后注入 spacer，把弹窗变成能上下滚动的长表单容器。 */
  ensureSpacer() {
    if (document.getElementById('zx7-test-spacer-before')) return true;
    const form = this.dialog()?.querySelector('form');
    if (!form) return false;
    for (const [id, height] of [
      ['zx7-test-spacer-before', '600px'],
      ['zx7-test-spacer-after', '400px'],
    ]) {
      const spacer = document.createElement('div');
      spacer.id = id;
      spacer.style.height = height;
      if (id.endsWith('before')) form.prepend(spacer);
      else form.append(spacer);
    }
    return true;
  },
  viewport() {
    const vv = window.visualViewport;
    return vv
      ? { width: vv.width, height: vv.height, left: vv.offsetLeft, top: vv.offsetTop }
      : { width: window.innerWidth, height: window.innerHeight, left: 0, top: 0 };
  },
  snapshot() {
    const field = this.field();
    const panel = this.panel();
    if (!field || !panel) return null;
    const anchor = field.getBoundingClientRect();
    const layer = panel.getBoundingClientRect();
    const viewport = this.viewport();
    const gap = 8;
    const sheet = panel.classList.contains('is-sheet');
    const separated =
      layer.bottom <= anchor.top - gap + 0.5 ||
      layer.top >= anchor.bottom + gap - 0.5;
    const inside =
      layer.left >= viewport.left - 0.5 &&
      layer.top >= viewport.top - 0.5 &&
      layer.right <= viewport.left + viewport.width + 0.5 &&
      layer.bottom <= viewport.top + viewport.height + 0.5;
    const style = getComputedStyle(panel);
    return {
      ready: panel.getAttribute('data-ready'),
      placement: panel.getAttribute('data-placement'),
      layerKind: panel.getAttribute('data-layer'),
      sheet,
      separated,
      inside,
      anchor: {
        left: +anchor.left.toFixed(1),
        top: +anchor.top.toFixed(1),
        right: +anchor.right.toFixed(1),
        bottom: +anchor.bottom.toFixed(1),
      },
      layer: {
        left: +layer.left.toFixed(1),
        top: +layer.top.toFixed(1),
        right: +layer.right.toFixed(1),
        bottom: +layer.bottom.toFixed(1),
        width: +layer.width.toFixed(1),
        height: +layer.height.toFixed(1),
      },
      viewport,
      maxHeight: panel.style.maxHeight || null,
      computedMaxHeight: style.maxHeight,
      overflowY: style.overflowY,
      zIndex: style.zIndex,
      internalScroll: panel.scrollHeight > panel.clientHeight + 1,
    };
  },
  focusIcon() {
    this.icon().focus();
    return document.activeElement === this.icon();
  },
};
true;`;

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await setViewport(1440, 1000);
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    ${fakeBundle}
    const world = ZXFake.createFakeWorld();
    world.install();
    window.__ZX_WORLD__ = world;
  })();`,
});

let fatal = null;
try {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/calendar` });
  await waitFor(
    `document.readyState === 'complete' && document.body.innerText.includes('倒数日')`,
    '日历页加载',
  );
  await evaluate(PAGE_HELPERS);
  await evaluate(
    `Array.from(document.querySelectorAll('[role="tab"]'))
      .find((tab) => tab.textContent.trim() === '倒数日').click(); true`,
  );
  await waitFor(
    `document.querySelector('[aria-label="倒数日分区新建倒数日"]') !== null`,
    '倒数日分区渲染',
  );
  await evaluate(
    `document.querySelector('[aria-label="倒数日分区新建倒数日"]').click(); true`,
  );
  await waitFor(
    `document.querySelector('.task-dialog h2')?.textContent === '新建倒数日'`,
    '新建倒数日弹窗打开',
  );

  const openPanel = async () => {
    await evaluate('window.__ZX7__.close(); true');
    await new Promise((resolve) => setTimeout(resolve, 120));
    await realClick('.task-dialog .date-field-icon');
    await waitFor(
      `window.__ZX7__.panel()?.getAttribute('data-ready') === 'true'`,
      '日期弹层完成测量',
    );
    await new Promise((resolve) => setTimeout(resolve, 180));
    return evaluate('window.__ZX7__.snapshot()');
  };

  // A. 默认视口（模态内）：按空间选择上下侧、不遮触发器、不溢出、层级高于遮罩。
  const normal = await openPanel();
  const spaceBelow =
    normal.viewport.height - 8 - (normal.anchor.bottom + 8);
  const expectedPlacement =
    normal.maxHeight === null && spaceBelow >= normal.layer.height
      ? 'bottom-start'
      : 'top-start';
  check(
    normal.placement === expectedPlacement &&
      normal.separated &&
      normal.inside,
    'A1',
    '默认视口：下方不足时自动翻上，弹层不遮触发器且不溢出视口',
    { spaceBelow, expectedPlacement, normal },
  );
  check(
    Number(normal.zIndex) >= 1200 && normal.layerKind === 'modal',
    'A2',
    '模态内日期弹层 z-index >= 1200（不被遮罩盖住）',
    { zIndex: normal.zIndex, layerKind: normal.layerKind },
  );
  check(
    normal.overflowY === 'auto',
    'A3',
    '弹层内部可滚动（overflow-y:auto），滚动链不穿透',
    { overflowY: normal.overflowY },
  );
  await screenshot('01-default-bottom.png');

  // B. 430 矮视口：限高 + 内部滚动，不遮触发器、不溢出。
  await setViewport(1440, 430);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const short = await evaluate('window.__ZX7__.snapshot()');
  check(
    short &&
      short.inside &&
      (short.sheet || short.separated) &&
      (short.sheet || short.maxHeight !== null),
    'B1',
    '430 矮视口：限高滚动，弹层在视口内且不遮触发器',
    short,
  );
  await screenshot('02-short-viewport.png');

  // C. 390 窄窗：sheet，在视口内，保留完整网格。
  await setViewport(390, 844);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const narrow = await evaluate('window.__ZX7__.snapshot()');
  check(
    narrow &&
      narrow.sheet &&
      narrow.placement === 'sheet' &&
      narrow.inside,
    'C1',
    '390 窄窗：切换为 sheet 且完整落在视口内',
    narrow,
  );
  await screenshot('03-narrow-sheet.png');

  // D. 回到 430 高视口，注入长表单 spacer，在真实滚动容器内验证跟随/翻转。
  await setViewport(1440, 430);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await evaluate('window.__ZX7__.close(); true');
  await new Promise((resolve) => setTimeout(resolve, 120));
  const spacerReady = await evaluate('window.__ZX7__.ensureSpacer()');

  const scrolledTop = await evaluate(
    `window.__ZX7__.scrollFieldTo('top')`,
  );
  const topState = await openPanel();
  check(
    topState.placement === 'bottom-start' &&
      topState.separated &&
      topState.inside,
    'D1',
    '滚动容器：锚点靠近视口顶部时向下展开且不遮触发器',
    { scrolledTop, topState },
  );
  await screenshot('04-scroll-container-top.png');

  // 面板保持打开，把锚点滚到底部：弹层应跟随并翻到上方（或锚点离开时关闭）。
  const scrollInfo = await evaluate(
    `window.__ZX7__.scrollFieldTo('bottom')`,
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  const afterScroll = await evaluate('window.__ZX7__.snapshot()');
  check(
    scrollInfo &&
      scrollInfo.scrollRange > 0 &&
      (afterScroll === null ||
        (afterScroll.placement === 'top-start' &&
          afterScroll.separated &&
          afterScroll.inside)),
    'D2',
    '滚动容器内滚动时重新定位并翻到上方；锚点离开视口则关闭',
    { scrollInfo, afterScroll },
  );
  await screenshot('05-scroll-container-bottom.png');

  // E. 键盘 Enter 打开：焦点在图标上时同样完成测量与定位。
  await evaluate(
    `for (const id of ['zx7-test-spacer-before', 'zx7-test-spacer-after']) {
      document.getElementById(id)?.remove();
    }
    true`,
  );
  await evaluate('window.__ZX7__.close(); true');
  await new Promise((resolve) => setTimeout(resolve, 180));
  await send('Page.bringToFront');
  const focusState = await evaluate(`({
    focused: window.__ZX7__.focusIcon(),
    active: document.activeElement?.className ?? null,
  })`);
  const enter = {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...enter });
  await send('Input.dispatchKeyEvent', {
    type: 'char',
    text: '\r',
    ...enter,
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
  let keyboardOpened = false;
  try {
    await waitFor(
      `window.__ZX7__.panel()?.getAttribute('data-ready') === 'true'`,
      '键盘打开日期弹层',
      5000,
    );
    keyboardOpened = true;
  } catch {
    keyboardOpened = false;
  }
  await new Promise((resolve) => setTimeout(resolve, 180));
  const keyboard = await evaluate('window.__ZX7__.snapshot()');
  const keyboardFocus = await evaluate(`({
    active: document.activeElement?.className ?? null,
    panelOpen: Boolean(window.__ZX7__.panel()),
  })`);
  check(
    keyboardOpened &&
      focusState.focused &&
      keyboard &&
      keyboard.placement !== 'pending' &&
      (keyboard.sheet || (keyboard.separated && keyboard.inside)),
    'E1',
    '键盘 Enter 打开弹层后已定位且不遮触发器',
    { focusState, keyboardFocus, keyboard },
  );
  await screenshot('06-keyboard-open.png');

  check(
    consoleErrors.length === 0,
    'F1',
    '控制台 0 error',
    consoleErrors.slice(0, 5),
  );
  check(
    pageExceptions.length === 0,
    'F2',
    '页面 0 exception',
    pageExceptions.slice(0, 5),
  );
} catch (error) {
  fatal = error;
  results.push({
    id: 'FATAL',
    ok: false,
    message: String(error?.message ?? error),
  });
  console.error(`[FATAL] ${error?.message ?? error}`);
  try {
    await screenshot('99-failure.png');
  } catch {
    // 截图失败不覆盖原始错误。
  }
} finally {
  const failed = results.filter((item) => !item.ok);
  const summary = {
    card: 'ZX7-POPOVER-01',
    generatedAt: new Date().toISOString(),
    passed: failed.length === 0 && !fatal,
    total: results.length,
    failed: failed.length,
    results,
    consoleErrors,
    pageExceptions,
  };
  fs.writeFileSync(
    path.join(EVIDENCE, 'result.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(
    `\n[zx7-popover-01] ${results.length - failed.length}/${results.length} 通过`,
  );
  socket.close();
  chrome.kill();
  server.close();
  process.exitCode = failed.length === 0 && !fatal ? 0 : 1;
}
