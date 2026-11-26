/**
 * ZX10-EDITOR-QA-01 独立验收：滚动稳定 + 行前整行选择。
 *
 * 真实生产构建 + 真实 Chromium（CDP），只注入 tests/harness/fakeTauri.ts
 * 的内存 IPC 替身；产品代码与既有测试均不修改。
 *
 * 覆盖卡面必测：
 *  1. 多块长笔记：点击正文空白 / 最后一行下方空白 / 保存后重渲染 /
 *     撤销/重做 / 切换笔记，scrollTop 不跳底、活动块不被移到最后一个块。
 *  2. 显式滚动：大纲点击、搜索深链定位仍滚到目标块并高亮；专注模式
 *     写作跟随仍把当前块放到约 36% 高度。
 *  3. 行前选择：hover 出现、单击选中整行、再点取消、Shift 范围、
 *     Cmd/Ctrl 追加；拖拽手柄/块菜单不误触；⌘A 与高级入口保留。
 *  4. 正文文字选择、输入、Enter/Backspace、代码/表格/公式/画板选择不回归。
 *  5. 空笔记、刷新持久化、快速连点、无选择时 Delete、控制台零报错。
 *
 * 运行：
 *   # 干净 HEAD 构建（避免工作区其它未提交改动影响）
 *   pnpm --filter app build
 *   node tests/e2e/zx10-editor-qa-01-browser.mjs
 *   # 也可指定构建目录：
 *   ZX_DIST=/tmp/zx10-editor-head/app/dist node tests/e2e/zx10-editor-qa-01-browser.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = process.env.ZX_DIST
  ? path.resolve(process.env.ZX_DIST)
  : path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx10-editor-qa-01');
const FAKE_BUNDLE = '/tmp/zx-fake-zx10-editor-qa-01.js';
const DB_KEY = ['zx10', 'editor', 'qa', 'db', String(Date.now())].join('-');
const PORT = 8941;
const DEBUG_PORT = 9261 + (process.pid % 200);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const NOTE_A = 'ZX10 长文滚动验收';
const NOTE_B = 'ZX10 短笔记 B';
const NOTE_C = 'ZX10 空笔记 C';
const NOTE_A_ID = 'note-zx10-long';
const NOTE_B_ID = 'note-zx10-short';
const NOTE_C_ID = 'note-zx10-empty';
const BLOCK_COUNT_A = 43;

const MARKER_SCROLL = '【滚动保存标记】';
const MARKER_TEXT = '【正文输入标记】';
const SEARCH_NEEDLE = '针叶林深链关键词';
const TAIL_HEADING = '尾部标题：大纲定位';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error(`前端未构建：${DIST} 下没有 index.html`);
}
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

const results = [];
const observations = [];
const consoleErrors = [];
const pageExceptions = [];
const screenshots = [];

function check(ok, id, message, actual) {
  const actualText =
    actual === undefined ? '' : `（实际：${JSON.stringify(actual)}）`;
  results.push({ id, ok: Boolean(ok), message, actual });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${message}${actualText}`);
}
function observation(id, message, actual) {
  observations.push({ id, message, actual });
  console.log(`[OBS] ${id} ${message}（实际：${JSON.stringify(actual)}）`);
}
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
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

const CHROME_PROFILE_PREFIX = ['zx', 'chrome', 'zx10', 'editor', 'qa', '01'].join('-');
const userDataDir = `/tmp/${CHROME_PROFILE_PREFIX}-${Date.now()}`;
// 之前失败的运行可能遗留 headless Chrome；先清掉，否则新脚本会连到旧浏览器，
// 复用旧 localStorage 与页面状态，造成假数据（例如重复输入、撤销看似失效）。
spawnSync('pkill', ['-f', `Google Chrome.*${CHROME_PROFILE_PREFIX}`], {
  stdio: 'ignore',
});
await new Promise((resolve) => setTimeout(resolve, 400));
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

let nextId = 0;
const pending = new Map();
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  fs.writeFileSync(path.join(EVIDENCE, name), Buffer.from(result.data, 'base64'));
  screenshots.push(name);
  console.log(`截图：tests/evidence/zx10-editor-qa-01/${name}`);
}

async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(180);
}

async function clickPoint(x, y, modifiers = 0) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    modifiers,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
    modifiers,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
    modifiers,
  });
  await sleep(140);
}

async function elementRect(selector) {
  return evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  })()`);
}

async function clickSelector(selector, label, modifiers = 0) {
  const rect = await elementRect(selector);
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`找不到可点击元素：${label ?? selector}`);
  }
  await sleep(120);
  await clickPoint(rect.x, rect.y, modifiers);
}

async function clickByText(selector, text, label) {
  const ok = await evaluate(`(() => {
    const items = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const target = items.find((item) =>
      (item.textContent || '').replace(/\\s+/g, ' ').includes(${JSON.stringify(text)})
    );
    if (!target) return false;
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    target.click();
    return true;
  })()`);
  if (!ok) throw new Error(`找不到文本按钮：${label ?? text}`);
  await sleep(180);
}

async function pressKey(key, options = {}) {
  const {
    modifiers = 0,
    code = key,
    windowsVirtualKeyCode = 0,
    text,
  } = options;
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    ...(text ? { text } : {}),
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
  });
  await sleep(180);
}

async function pressEnter() {
  await pressKey('Enter', {
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    text: '\r',
  });
}

async function pressEscape() {
  await pressKey('Escape', {
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
}

async function typeText(text) {
  await send('Input.insertText', { text });
  await sleep(240);
}

async function metrics() {
  return evaluate(`(() => {
    const body = document.querySelector('.zxe-body');
    if (!body) return null;
    const activeRows = Array.from(document.querySelectorAll('.zxe-row.is-active'));
    const rows = Array.from(document.querySelectorAll('.zxe-row'));
    const bodyRect = body.getBoundingClientRect();
    return {
      scrollTop: body.scrollTop,
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      max: Math.max(0, body.scrollHeight - body.clientHeight),
      rowCount: rows.length,
      activeIds: activeRows.map((row) => row.dataset.blockId),
      lastId: rows.length ? rows[rows.length - 1].dataset.blockId : null,
      bodyTop: bodyRect.top,
      bodyBottom: bodyRect.bottom,
      bodyLeft: bodyRect.left,
      bodyRight: bodyRect.right,
      activeElement: (() => {
        const el = document.activeElement;
        if (!(el instanceof Element)) return null;
        return {
          tag: el.tagName,
          blockId: el.closest('[data-block-id]')?.getAttribute('data-block-id') ?? null,
          inline: Boolean(el.closest('[data-inline-editor="true"]')),
          className: typeof el.className === 'string' ? el.className : '',
        };
      })(),
    };
  })()`);
}

/**
 * 正文 CSS 是 scroll-behavior:smooth；直接写 scrollTop 在 Chromium 里也可能
 * 走平滑动画。所有几何断言前必须等它稳定，否则会拿到动画中间值。
 */
async function waitScrollSettled(timeout = 4000) {
  const deadline = Date.now() + timeout;
  let last = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const value = await evaluate(
      `document.querySelector('.zxe-body')?.scrollTop ?? null`,
    );
    if (value === null) return null;
    if (last !== null && Math.abs(value - last) <= 1) {
      if (Date.now() - stableSince >= 160) return value;
    } else {
      last = value;
      stableSince = Date.now();
    }
    await sleep(60);
  }
  return last;
}

async function setScrollTop(top) {
  await evaluate(`(() => {
    const body = document.querySelector('.zxe-body');
    if (!body) return null;
    body.scrollTop = Math.max(0, ${Number(top)});
    return body.scrollTop;
  })()`);
  return waitScrollSettled();
}

async function scrollRowIntoView(blockId) {
  const top = await evaluate(`(() => {
    const body = document.querySelector('.zxe-body');
    const row = document.querySelector('[data-block-id=${JSON.stringify(blockId)}]');
    if (!body || !row) return null;
    const bodyRect = body.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    body.scrollTop = Math.max(
      0,
      body.scrollTop + rowRect.top - bodyRect.top - body.clientHeight / 2 + rowRect.height / 2,
    );
    return body.scrollTop;
  })()`);
  await waitScrollSettled();
  return top;
}

async function hoverRow(blockId) {
  const rect = await evaluate(`(() => {
    const row = document.querySelector('[data-block-id=${JSON.stringify(blockId)}]');
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return { x: rect.left + Math.min(80, rect.width / 3), y: rect.top + rect.height / 2 };
  })()`);
  if (!rect) throw new Error(`找不到行：${blockId}`);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: rect.x,
    y: rect.y,
    button: 'none',
  });
  await sleep(260);
}

async function gutterState(blockId) {
  return evaluate(`(() => {
    const row = document.querySelector('[data-block-id=${JSON.stringify(blockId)}]');
    if (!row) return null;
    const gutter = row.querySelector('.zxe-block-gutter');
    if (!gutter) return null;
    const style = getComputedStyle(gutter);
    const control = row.querySelector('.zxe-block-select');
    const controlRect = control?.getBoundingClientRect();
    return {
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      controlCount: row.querySelectorAll('.zxe-block-select').length,
      controlDraggable: control?.getAttribute('draggable'),
      controlLabel: control?.getAttribute('aria-label'),
      controlPressed: control?.getAttribute('aria-pressed'),
      controlWidth: controlRect?.width ?? null,
      controlHeight: controlRect?.height ?? null,
      handleCount: row.querySelectorAll('.zxe-block-control').length,
      handleDraggable: row.querySelector('.zxe-block-control')?.getAttribute('draggable'),
    };
  })()`);
}

async function clickGutter(blockId, modifiers = 0, fast = false) {
  await scrollRowIntoView(blockId);
  await hoverRow(blockId);
  const rect = await evaluate(`(() => {
    const row = document.querySelector('[data-block-id=${JSON.stringify(blockId)}]');
    const control = row?.querySelector('.zxe-block-select');
    if (!control) return null;
    const rect = control.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
    };
  })()`);
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`行前选择控件不可点击：${blockId}`);
  }
  if (!fast) {
    await sleep(120);
  }
  await clickPoint(rect.x, rect.y, modifiers);
}

async function selectionState() {
  return evaluate(`(() => {
    const selected = Array.from(document.querySelectorAll('.zxe-row.is-block-selected'));
    const bar = document.querySelector('.zxe-selectionbar');
    const editor = document.querySelector('.zxe');
    return {
      ids: selected.map((row) => row.dataset.blockId),
      count: selected.length,
      barText: bar ? (bar.textContent || '').replace(/\\s+/g, ' ').trim() : null,
      mode: editor?.getAttribute('data-selection-mode') ?? null,
      blockSelection: editor?.getAttribute('data-block-selection') ?? null,
      selectControls: document.querySelectorAll('.zxe-block-select').length,
      menu: Boolean(document.querySelector('.zxe-menu, [role="menu"]')),
      dialog: Boolean(document.querySelector('.zxe-dialog-backdrop')),
    };
  })()`);
}

async function findBlankPoint(area = 'middle') {
  return evaluate(`(() => {
    const body = document.querySelector('.zxe-body');
    if (!body) return null;
    const bodyRect = body.getBoundingClientRect();
    const rows = Array.from(body.querySelectorAll('.zxe-row'));
    const last = rows[rows.length - 1] ?? null;
    const minY = Math.max(1, Math.ceil(bodyRect.top + 4));
    const maxY = Math.min(window.innerHeight - 4, Math.floor(bodyRect.bottom - 4));
    const xs = [
      Math.ceil(bodyRect.left + 4),
      Math.ceil(bodyRect.left + 12),
      Math.ceil(bodyRect.left + 24),
      Math.ceil(bodyRect.left + 40),
      Math.floor(bodyRect.right - 8),
    ];
    let ys = [];
    if (${JSON.stringify(area)} === 'belowLast' && last) {
      const lastRect = last.getBoundingClientRect();
      for (let y = Math.ceil(lastRect.bottom + 4); y <= maxY; y += 4) ys.push(y);
    } else {
      for (let y = Math.ceil(minY + (maxY - minY) * 0.35); y <= maxY; y += 4) ys.push(y);
    }
    for (const y of ys) {
      for (const x of xs) {
        const hit = document.elementFromPoint(x, y);
        if (hit === body) return { x, y, area: ${JSON.stringify(area)} };
      }
    }
    const probeY = ys[Math.floor(ys.length / 2)] ?? null;
    const probes = probeY === null
      ? []
      : xs.map((x) => {
          const hit = document.elementFromPoint(x, probeY);
          return {
            x,
            y: probeY,
            tag: hit?.tagName ?? null,
            className:
              hit && typeof hit.className === 'string' ? hit.className : '',
            sameBody: hit === body,
          };
        });
    const lastRect = last?.getBoundingClientRect();
    return {
      error: 'no-body-hit',
      area: ${JSON.stringify(area)},
      ysRange: ys.length ? [ys[0], ys[ys.length - 1]] : [],
      bodyRect: { top: bodyRect.top, bottom: bodyRect.bottom, left: bodyRect.left, right: bodyRect.right },
      lastRect: lastRect
        ? { top: lastRect.top, bottom: lastRect.bottom, left: lastRect.left, right: lastRect.right }
        : null,
      scrollTop: body.scrollTop,
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
      probes,
    };
  })()`);
}

async function clickBlank(area = 'middle') {
  const point = await findBlankPoint(area);
  if (!point || point.error) {
    throw new Error(`找不到正文空白点：${area} ${JSON.stringify(point)}`);
  }
  await clickPoint(point.x, point.y);
  return point;
}

async function clickRowInline(blockId) {
  await evaluate(`(() => {
    const row = document.querySelector('[data-block-id=${JSON.stringify(blockId)}]');
    const inline = row?.querySelector('[data-inline-editor="true"]');
    if (inline) inline.scrollIntoView({ block: 'center', behavior: 'instant' });
    return Boolean(inline);
  })()`);
  await waitScrollSettled();
  const rect = await evaluate(`(() => {
    const row = document.querySelector('[data-block-id=${JSON.stringify(blockId)}]');
    const inline = row?.querySelector('[data-inline-editor="true"]');
    if (!inline) return null;
    const rect = inline.getBoundingClientRect();
    return {
      x: rect.left + Math.min(rect.width / 2, 160),
      y: rect.top + Math.min(rect.height / 2, 20),
      width: rect.width,
      height: rect.height,
      top: rect.top,
      bottom: rect.bottom,
    };
  })()`);
  if (!rect) throw new Error(`找不到行内编辑器：${blockId}`);
  await clickPoint(rect.x, rect.y);
  const active = await evaluate(`(() => {
    const el = document.activeElement;
    return {
      blockId: el?.closest?.('[data-block-id]')?.getAttribute('data-block-id') ?? null,
      inline: Boolean(el?.closest?.('[data-inline-editor="true"]')),
    };
  })()`);
  if (active.blockId !== blockId || !active.inline) {
    observation('CLICK_INLINE', `点击 ${blockId} 行内编辑器后的焦点`, active);
  }
}

async function dragSelectText(blockId) {
  const range = await evaluate(`(() => {
    const row = document.querySelector('[data-block-id=${JSON.stringify(blockId)}]');
    const inline = row?.querySelector('[data-inline-editor="true"]');
    if (!inline) return null;
    inline.scrollIntoView({ block: 'center', behavior: 'instant' });
    const walker = document.createTreeWalker(inline, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node) return null;
    const text = node.textContent || '';
    if (text.length < 8) return null;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(12, text.length));
    const rects = Array.from(range.getClientRects());
    const rect = rects[0];
    if (!rect) return null;
    return {
      startX: rect.left + 1,
      endX: rect.right - 1,
      y: rect.top + rect.height / 2,
      expected: text.slice(0, Math.min(12, text.length)),
    };
  })()`);
  if (!range) throw new Error(`无法在块 ${blockId} 建立文字选区`);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: range.startX,
    y: range.y,
    button: 'none',
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: range.startX,
    y: range.y,
    button: 'left',
    clickCount: 1,
  });
  for (let step = 1; step <= 6; step += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: range.startX + ((range.endX - range.startX) * step) / 6,
      y: range.y,
      button: 'left',
      buttons: 1,
    });
    await sleep(30);
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: range.endX,
    y: range.y,
    button: 'left',
    clickCount: 1,
  });
  await sleep(220);
  return range;
}

async function textSelection() {
  return evaluate(`String(window.getSelection()?.toString() ?? '')`);
}

async function openNoteByTitle(title, viaJs = false) {
  if (viaJs) {
    const info = await evaluate(`(() => {
      const el = document.querySelector('[aria-label="打开笔记：${title}"]');
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const list = document.querySelector('.kn-note-list');
      const listRect = list?.getBoundingClientRect();
      el.click();
      return {
        found: true,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        hitSelf: hit === el || Boolean(hit && el.contains(hit)),
        hitTag: hit?.tagName ?? null,
        hitClass: hit && typeof hit.className === 'string' ? hit.className : '',
        workspaceClass: document.querySelector('.kn-workspace')?.className ?? '',
        listRect: listRect
          ? { left: listRect.left, top: listRect.top, width: listRect.width, height: listRect.height }
          : null,
      };
    })()`);
    observation('OPEN_NOTE', `JS 打开笔记：${title}`, info);
    await sleep(200);
    return;
  }
  await clickSelector(
    `[aria-label="打开笔记：${title}"]`,
    `笔记列表：${title}`,
  );
}

async function switchTab(title) {
  await clickSelector(
    `[aria-label="切换到标签：${title}"]`,
    `标签：${title}`,
  );
}

/* ------------------------------------------------------------------ */
/* 种子：43 块长笔记 + 短笔记 + 空笔记                                  */
/* ------------------------------------------------------------------ */

const note = (id, title) => ({
  id,
  spaceId: 'personal',
  folderId: null,
  title,
  tags: ['ZX10验收'],
  body: '',
  bodyFormat: 'html',
  status: 'active',
  favorite: false,
  pinned: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  deletedAt: null,
  version: 1,
});

let order = 1024;
const seedBlocks = [];
function addBlock(id, blockType, payload) {
  seedBlocks.push({
    id,
    noteId: NOTE_A_ID,
    blockType,
    orderKey: order,
    payload,
    schemaVersion: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  });
  order += 1024;
}
function paragraph(id, text) {
  addBlock(id, 'paragraph', { runs: [{ text }] });
}

addBlock('h0', 'heading1', { runs: [{ text: 'ZX10 长文验收' }] });
for (let index = 1; index <= 8; index += 1) {
  paragraph(
    `p${index}`,
    `第 ${index} 段：这是一段用于验证滚动位置的多行正文。点击正文空白、最后一行下方空白、保存重渲染、撤销重做与切换笔记时，滚动容器都不应该跳到最底部。`,
  );
}
addBlock('hMid', 'heading2', { runs: [{ text: '中段标题' }] });
for (let index = 9; index <= 16; index += 1) {
  paragraph(
    `p${index}`,
    `第 ${index} 段：连续文档流保持可读行宽，段落高度随文字自然增长。此段用于让正文明显超过一屏，从而能观察 scrollTop 的真实数值。`,
  );
}
addBlock('list1', 'bullet_list', {
  runs: [{ text: '列表项：行前选择不应改变语义缩进' }],
});
addBlock('todo1', 'todo', {
  runs: [{ text: '待办项：勾选与整行选择互不干扰' }],
  checked: false,
});
addBlock('quote1', 'quote', {
  runs: [{ text: '引用块：选择整行时不丢来源信息。' }],
  source: 'ZX10 验收文档',
});
addBlock('code1', 'code', {
  code: 'export function zx10(a: number, b: number) {\n  return a + b;\n}',
  language: 'typescript',
});
addBlock('table1', 'table', {
  rows: [
    ['列 A', '列 B'],
    ['Alpha', '1'],
    ['Beta', '2'],
  ],
  header: true,
});
addBlock('formula1', 'formula', { latex: 'a^2 + b^2 = c^2' });
addBlock('board1', 'board', { boardId: null, title: 'ZX10 验收画板' });
for (let index = 17; index <= 24; index += 1) {
  paragraph(
    `p${index}`,
    `第 ${index} 段：这一段继续撑开文档，保证大纲定位、搜索定位与专注写作跟随都有足够的上下空间。`,
  );
}
addBlock('hTail', 'heading2', { runs: [{ text: TAIL_HEADING }] });
for (let index = 25; index <= 30; index += 1) {
  paragraph(
    `p${index}`,
    index === 28
      ? `第 ${index} 段：${SEARCH_NEEDLE}。这里用于验证搜索深链定位仍会滚动到命中块并短暂高亮。`
      : `第 ${index} 段：尾部正文，用于验证最后一行下方空白点击不会改变活动块，也不会额外滚动。`,
  );
}
addBlock('file1', 'file', {
  attachmentId: null,
  fileName: 'ZX10 验收.txt',
  byteSize: 1234,
  mime: 'text/plain',
  status: 'local',
});
addBlock('image1', 'file', {
  attachmentId: null,
  fileName: 'ZX10 验收.png',
  byteSize: 2048,
  mime: 'image/png',
  status: 'local',
});
paragraph('pLast', '最后一块：点击空白后不应被激活，也不应把光标移到这里。');

const notes = [
  note(NOTE_A_ID, NOTE_A),
  note(NOTE_B_ID, NOTE_B),
  note(NOTE_C_ID, NOTE_C),
];
const blocksB = [
  {
    id: 'b1',
    noteId: NOTE_B_ID,
    blockType: 'heading2',
    orderKey: 1024,
    payload: { runs: [{ text: '短笔记 B' }] },
    schemaVersion: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  },
  {
    id: 'b2',
    noteId: NOTE_B_ID,
    blockType: 'paragraph',
    orderKey: 2048,
    payload: { runs: [{ text: '切换笔记时，A 的滚动位置应被记住。' }] },
    schemaVersion: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  },
  {
    id: 'b3',
    noteId: NOTE_B_ID,
    blockType: 'paragraph',
    orderKey: 3072,
    payload: { runs: [{ text: '短笔记不撑开滚动区域。' }] },
    schemaVersion: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  },
];

assert(seedBlocks.length === BLOCK_COUNT_A, `种子块数应为 ${BLOCK_COUNT_A}`);

const injection = `(() => {
  let raw = null;
  try {
    raw = localStorage.getItem(${JSON.stringify(DB_KEY)});
  } catch (error) {}
  ${fakeBundle}
  const world = ZXFake.createFakeWorld();
  let restored = false;
  if (raw) {
    try {
      const saved = JSON.parse(raw);
      for (const [key, value] of Object.entries(saved)) {
        if (Array.isArray(value)) world.db[key] = value;
      }
      restored = true;
    } catch (error) {
      restored = false;
    }
  }
  if (!restored) {
    world.db.notes = ${JSON.stringify(notes)};
    world.db.blocks = ${JSON.stringify([...seedBlocks, ...blocksB])};
  }
  world.install();
  const originalInvoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    const result = await originalInvoke(command, args);
    try {
      localStorage.setItem(${JSON.stringify(DB_KEY)}, JSON.stringify(world.db));
    } catch (error) {}
    return result;
  };
  window.__ZX_WORLD__ = world;
  window.__ZX_RESTORED__ = restored;
  window.__ZX_DRAG__ = { count: 0 };
  document.addEventListener('dragstart', () => { window.__ZX_DRAG__.count += 1; }, true);
})();`;

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

let fatal = null;
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: injection });
  await setViewport(1440, 1000);

  await send('Page.navigate', {
    url: `http://127.0.0.1:${PORT}/knowledge?note=${encodeURIComponent(NOTE_A_ID)}`,
  });
  await waitFor(
    `document.readyState === 'complete' && document.querySelectorAll('.zxe-row').length === ${BLOCK_COUNT_A}`,
    '长笔记 43 块渲染',
    30_000,
  );
  await waitFor(
    `(() => {
      const body = document.querySelector('.zxe-body');
      return body && body.scrollHeight > body.clientHeight + 800;
    })()`,
    '正文形成长滚动区域',
  );
  await sleep(400);
  const initial = await metrics();
  const initialRestore = await evaluate('window.__ZX_RESTORED__');
  observation('INIT', '长笔记滚动几何', initial);
  check(
    initialRestore === false,
    'S-00A',
    '本次运行使用全新 fake DB（没有复用旧浏览器 localStorage）',
    { restored: initialRestore },
  );
  check(
    initial.scrollHeight > initial.clientHeight + 800,
    'S-00',
    '43 块长笔记确实形成可滚动正文',
    {
      scrollHeight: initial.scrollHeight,
      clientHeight: initial.clientHeight,
      max: initial.max,
      rows: initial.rowCount,
    },
  );
  await screenshot('01-long-note-top.png');

  /* ---------------- 1. 滚动稳定 ---------------- */
  await scrollRowIntoView('p8');
  const baseline = await metrics();
  await clickRowInline('p8');
  const afterFocus = await metrics();
  check(
    afterFocus.activeIds.includes('p8'),
    'S-01',
    '点击中段正文后活动块是 p8，不是最后一个块',
    { activeIds: afterFocus.activeIds, lastId: afterFocus.lastId },
  );
  check(
    Math.abs(afterFocus.scrollTop - baseline.scrollTop) <= 2,
    'S-02',
    '点击具体正文块不额外滚动',
    { before: baseline.scrollTop, after: afterFocus.scrollTop },
  );

  const middleBefore = await metrics();
  const middlePoint = await clickBlank('middle');
  const middleAfter = await metrics();
  check(
    Math.abs(middleAfter.scrollTop - middleBefore.scrollTop) <= 2,
    'S-03',
    '点击正文空白不改变 scrollTop',
    {
      point: middlePoint,
      before: middleBefore.scrollTop,
      after: middleAfter.scrollTop,
      max: middleAfter.max,
    },
  );
  check(
    middleAfter.scrollTop < middleAfter.max - 2,
    'S-04',
    '点击正文空白没有跳到 scrollHeight',
    { scrollTop: middleAfter.scrollTop, max: middleAfter.max },
  );
  check(
    middleAfter.activeIds.includes('p8') &&
      !middleAfter.activeIds.includes(middleAfter.lastId),
    'S-05',
    '点击正文空白后活动块仍为 p8，未被移到最后一个块',
    { activeIds: middleAfter.activeIds, lastId: middleAfter.lastId },
  );
  check(
    middleAfter.activeElement?.blockId !== middleAfter.lastId,
    'S-06',
    '点击正文空白后光标没有被移到最后一个块',
    middleAfter.activeElement,
  );
  await screenshot('02-scroll-middle-blank.png');

  // 滚动到最底部，再点最后一行下方空白。
  await evaluate(`(() => {
    const body = document.querySelector('.zxe-body');
    body.scrollTop = body.scrollHeight;
    return body.scrollTop;
  })()`);
  await waitScrollSettled();
  await waitFor(
    `(() => {
      const body = document.querySelector('.zxe-body');
      return body.scrollTop >= body.scrollHeight - body.clientHeight - 2;
    })()`,
    '正文滚到最底部',
    5000,
  );
  const bottomBefore = await metrics();
  const bottomPoint = await clickBlank('belowLast');
  const bottomAfter = await metrics();
  check(
    Math.abs(bottomAfter.scrollTop - bottomBefore.scrollTop) <= 2,
    'S-07',
    '点击最后一行下方空白不额外改变 scrollTop',
    {
      point: bottomPoint,
      before: bottomBefore.scrollTop,
      after: bottomAfter.scrollTop,
      max: bottomAfter.max,
    },
  );
  check(
    bottomAfter.activeIds.includes('p8') &&
      !bottomAfter.activeIds.includes(bottomAfter.lastId),
    'S-08',
    '点击最后一行下方空白后活动块仍是 p8，不是 pLast',
    {
      activeIds: bottomAfter.activeIds,
      lastId: bottomAfter.lastId,
      activeElement: bottomAfter.activeElement,
    },
  );
  check(
    bottomAfter.activeElement?.blockId !== bottomAfter.lastId,
    'S-09',
    '点击最后一行下方空白后光标没有进入最后一块',
    bottomAfter.activeElement,
  );
  await screenshot('03-below-last-blank.png');

  // 输入 + 保存后重渲染：滚动保持。
  await scrollRowIntoView('p12');
  await clickRowInline('p12');
  const beforeType = await metrics();
  check(
    beforeType.scrollTop > 100,
    'S-09B',
    '输入前滚动基线位于正文中段（非 0）',
    { scrollTop: beforeType.scrollTop, max: beforeType.max },
  );
  await typeText(MARKER_SCROLL);
  const markerPlacement = await evaluate(`(() => {
    const marker = ${JSON.stringify(MARKER_SCROLL)};
    const rows = Array.from(document.querySelectorAll('.zxe-row'));
    const active = document.activeElement;
    return {
      rowsWithMarker: rows
        .filter((row) => (row.textContent || '').includes(marker))
        .map((row) => row.dataset.blockId),
      p12: (document.querySelector('[data-block-id="p12"] .zxe-inline')?.textContent || '').slice(0, 80),
      active: active
        ? {
            tag: active.tagName,
            blockId: active.closest?.('[data-block-id]')?.getAttribute('data-block-id') ?? null,
            inline: Boolean(active.closest?.('[data-inline-editor="true"]')),
            className: typeof active.className === 'string' ? active.className : '',
          }
        : null,
    };
  })()`);
  observation('TYPE', '输入后标记落在哪个块', markerPlacement);
  check(
    markerPlacement.rowsWithMarker.includes('p12'),
    'S-10B',
    '标记确实输入到 p12 行内编辑器',
    markerPlacement,
  );
  const afterType = await metrics();
  check(
    Math.abs(afterType.scrollTop - beforeType.scrollTop) <= 2,
    'S-10',
    '在正文输入后 scrollTop 不变',
    { before: beforeType.scrollTop, after: afterType.scrollTop },
  );
  await waitFor(
    `window.__ZX_WORLD__.db.notes.find((n) => n.id === ${JSON.stringify(NOTE_A_ID)})?.body.includes(${JSON.stringify(MARKER_SCROLL)})`,
    '输入内容落库',
    8000,
  );
  await waitFor(
    `(document.querySelector('.kn-save-state')?.textContent || '').includes('已保存到本机')`,
    '页面显示已保存',
    8000,
  );
  const afterSave = await metrics();
  check(
    Math.abs(afterSave.scrollTop - beforeType.scrollTop) <= 2,
    'S-11',
    '保存并触发父级重渲染后 scrollTop 不变',
    {
      before: beforeType.scrollTop,
      after: afterSave.scrollTop,
      max: afterSave.max,
      saveLabel: await evaluate(
        `document.querySelector('.kn-save-state')?.textContent ?? ''`,
      ),
    },
  );
  check(
    afterSave.scrollTop < afterSave.max - 2 && !afterSave.activeIds.includes(afterSave.lastId),
    'S-12',
    '保存后没有跳到底部，活动块仍是 p12',
    { activeIds: afterSave.activeIds, lastId: afterSave.lastId },
  );
  await screenshot('04-saved-same-scroll.png');

  // 撤销 / 重做。
  const undoButton = '.kn-paper-foot [aria-label="撤销编辑"]';
  const redoButton = '.kn-paper-foot [aria-label="重做编辑"]';
  const scrollBeforeUndo = (await metrics()).scrollTop;
  await waitFor(
    `document.querySelector('.kn-paper-foot [aria-label="撤销编辑"]')?.disabled === false`,
    '撤销按钮可用',
    5000,
  );
  const undoHit = await evaluate(`(() => {
    const el = document.querySelector('.kn-paper-foot [aria-label="撤销编辑"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      disabled: Boolean(el.disabled),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      hitSelf: hit === el || Boolean(hit && el.contains(hit)),
      hitTag: hit?.tagName ?? null,
      hitClass: hit && typeof hit.className === 'string' ? hit.className : '',
    };
  })()`);
  observation('UNDO_HIT', '页脚撤销按钮命中测试', undoHit);
  await clickSelector(undoButton, '撤销编辑');
  await sleep(700);
  const footerUndoRemoved = await evaluate(
    `!(document.querySelector('[data-block-id="p12"] .zxe-inline')?.textContent || '').includes(${JSON.stringify(MARKER_SCROLL)})`,
  );
  let undoRemoved = footerUndoRemoved;
  if (!footerUndoRemoved) {
    // 页脚按钮未生效时，用真实 ⌘Z 区分「按钮/接线问题」与「历史本身问题」。
    await clickRowInline('p12');
    await pressKey('z', {
      code: 'KeyZ',
      windowsVirtualKeyCode: 90,
      modifiers: 4,
    });
    await sleep(700);
    undoRemoved = await evaluate(
      `!(document.querySelector('[data-block-id="p12"] .zxe-inline')?.textContent || '').includes(${JSON.stringify(MARKER_SCROLL)})`,
    );
  }
  observation('UNDO_RESULT', '撤销路径结果', {
    footerUndoRemoved,
    keyboardUndoRemoved: undoRemoved,
  });
  check(
    footerUndoRemoved,
    'S-13a',
    '页脚撤销按钮能撤销刚输入的正文',
    { hit: undoHit, footerUndoRemoved, afterKeyboard: undoRemoved },
  );
  check(
    undoRemoved,
    'S-13b',
    '撤销（页脚或 ⌘Z）移除刚输入的正文',
    { footerUndoRemoved, undoRemoved },
  );
  if (!undoRemoved) {
    throw new Error('撤销没有移除刚输入的正文，后续滚动断言无意义');
  }
  const afterUndo = await metrics();
  check(
    Math.abs(afterUndo.scrollTop - scrollBeforeUndo) <= 2,
    'S-13',
    '撤销后 scrollTop 不变',
    { before: scrollBeforeUndo, after: afterUndo.scrollTop },
  );
  await waitFor(
    `document.querySelector('.kn-paper-foot [aria-label="重做编辑"]')?.disabled === false`,
    '重做按钮可用',
    5000,
  );
  await clickSelector(redoButton, '重做编辑');
  await sleep(700);
  let redoRestored = await evaluate(
    `(document.querySelector('[data-block-id="p12"] .zxe-inline')?.textContent || '').includes(${JSON.stringify(MARKER_SCROLL)})`,
  );
  let footerRedoRestored = redoRestored;
  if (!redoRestored) {
    await clickRowInline('p12');
    await pressKey('z', {
      code: 'KeyZ',
      windowsVirtualKeyCode: 90,
      modifiers: 12,
    });
    await sleep(700);
    redoRestored = await evaluate(
      `(document.querySelector('[data-block-id="p12"] .zxe-inline')?.textContent || '').includes(${JSON.stringify(MARKER_SCROLL)})`,
    );
  }
  observation('REDO_RESULT', '重做路径结果', {
    footerRedoRestored,
    keyboardRedoRestored: redoRestored,
  });
  check(
    footerRedoRestored,
    'S-14a',
    '页脚重做按钮能恢复撤销的正文',
    { footerRedoRestored, afterKeyboard: redoRestored },
  );
  check(
    redoRestored,
    'S-14b',
    '重做（页脚或 ⇧⌘Z）恢复正文',
    { footerRedoRestored, redoRestored },
  );
  const afterRedo = await metrics();
  check(
    Math.abs(afterRedo.scrollTop - scrollBeforeUndo) <= 2,
    'S-14',
    '重做后 scrollTop 不变',
    { before: scrollBeforeUndo, after: afterRedo.scrollTop },
  );

  // 切换笔记：A → B → A，回到 A 时恢复原滚动位置。
  await setScrollTop(720);
  const scrollBeforeSwitch = (await metrics()).scrollTop;
  await openNoteByTitle(NOTE_B);
  await waitFor(
    `document.querySelector('.kn-title')?.value === ${JSON.stringify(NOTE_B)}`,
    '打开短笔记 B',
  );
  const inB = await metrics();
  await switchTab(NOTE_A);
  await waitFor(
    `document.querySelector('.kn-title')?.value === ${JSON.stringify(NOTE_A)} && document.querySelectorAll('.zxe-row').length === ${BLOCK_COUNT_A}`,
    '切回长笔记 A',
    20_000,
  );
  await waitFor(
    `Math.abs((document.querySelector('.zxe-body')?.scrollTop ?? 0) - ${scrollBeforeSwitch}) <= 2`,
    '恢复 A 的滚动位置',
    5000,
  );
  const afterSwitchBack = await metrics();
  check(
    Math.abs(afterSwitchBack.scrollTop - scrollBeforeSwitch) <= 2,
    'S-15',
    '切换笔记再切回时恢复原 scrollTop',
    { before: scrollBeforeSwitch, after: afterSwitchBack.scrollTop, inB: inB.scrollTop },
  );
  check(
    afterSwitchBack.scrollTop < afterSwitchBack.max - 2 &&
      !afterSwitchBack.activeIds.includes(afterSwitchBack.lastId),
    'S-16',
    '切回笔记没有跳到 scrollHeight，活动块也不是最后一个',
    { activeIds: afterSwitchBack.activeIds, lastId: afterSwitchBack.lastId },
  );

  /* ---------------- 2. 显式滚动：大纲 / 搜索 / 专注 ---------------- */
  await clickSelector('[data-rail-tool="outline"]', '右栏大纲');
  await waitFor(
    `document.querySelector('aside[aria-label="笔记大纲"]') !== null`,
    '大纲面板打开',
  );
  await clickByText('.kn-outline-item', TAIL_HEADING, '大纲：尾部标题');
  await sleep(1500);
  const outline = await evaluate(`(() => {
    const body = document.querySelector('.zxe-body');
    const row = document.querySelector('[data-block-id="hTail"]');
    if (!body || !row) return null;
    const bodyRect = body.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      scrollTop: body.scrollTop,
      max: body.scrollHeight - body.clientHeight,
      rowTopInBody: rowRect.top - bodyRect.top,
      rowHeight: rowRect.height,
      clientHeight: body.clientHeight,
      visible: rowRect.bottom > bodyRect.top && rowRect.top < bodyRect.bottom,
    };
  })()`);
  observation('OUTLINE', '大纲定位几何', outline);
  check(
    outline &&
      outline.visible &&
      outline.scrollTop > 500 &&
      Math.abs(
        outline.rowTopInBody - (outline.clientHeight - outline.rowHeight) / 2,
      ) <= 140,
    'E-01',
    '大纲点击仍滚到目标标题块并进入视口',
    outline,
  );
  await screenshot('05-outline-target.png');

  // 搜索深链（⌘K 结果定位同样使用 ScrollToBlock + 高亮）。
  await send('Page.navigate', {
    url: `http://127.0.0.1:${PORT}/knowledge?note=${encodeURIComponent(
      NOTE_A_ID,
    )}&find=${encodeURIComponent(SEARCH_NEEDLE)}`,
  });
  await waitFor(
    `document.readyState === 'complete' && document.querySelectorAll('.zxe-row').length === ${BLOCK_COUNT_A}`,
    '搜索深链加载长笔记',
    30_000,
  );
  await waitFor(
    `document.querySelector('.zxe-row.is-search-hit') !== null`,
    '搜索命中块高亮',
    8000,
  );
  await waitFor(
    `(document.querySelector('.zxe-body')?.scrollTop ?? 0) > 500`,
    '搜索定位发生滚动',
    4000,
  );
  await waitScrollSettled();
  const search = await evaluate(`(() => {
    const body = document.querySelector('.zxe-body');
    const row = document.querySelector('.zxe-row.is-search-hit');
    if (!body || !row) return null;
    const bodyRect = body.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      id: row.dataset.blockId,
      scrollTop: body.scrollTop,
      max: body.scrollHeight - body.clientHeight,
      rowTopInBody: rowRect.top - bodyRect.top,
      clientHeight: body.clientHeight,
      visible: rowRect.bottom > bodyRect.top && rowRect.top < bodyRect.bottom,
      text: (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    };
  })()`);
  observation('SEARCH', '搜索深链定位几何', search);
  check(
    search &&
      search.id === 'p28' &&
      search.visible &&
      search.scrollTop > 500 &&
      search.text.includes(SEARCH_NEEDLE),
    'E-02',
    '搜索深链仍定位到命中块并高亮，目标进入视口',
    search,
  );
  await screenshot('06-search-hit.png');

  // 专注模式：写作跟随仍按约 36% 工作。
  await sleep(1600);
  await clickSelector('[data-rail-tool="focus"]', '右栏专注模式');
  await waitFor(`document.querySelector('.zxe--focus') !== null`, '进入专注模式');
  const follow = await evaluate(`(() => {
    const box = document.querySelector('.zxe-focusbar-follow input');
    const editor = document.querySelector('.zxe');
    return {
      checked: Boolean(box?.checked),
      writingFollow: editor?.getAttribute('data-writing-follow'),
    };
  })()`);
  check(
    follow.checked && follow.writingFollow === 'true',
    'E-03',
    '专注模式写作跟随默认开启',
    follow,
  );
  await scrollRowIntoView('p12');
  await clickRowInline('p12');
  await sleep(1600);
  const focusGeometry = await evaluate(`(() => {
    const body = document.querySelector('.zxe-body');
    const row = document.querySelector('[data-block-id="p12"]');
    if (!body || !row) return null;
    const bodyRect = body.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const rows = Array.from(document.querySelectorAll('.zxe-row'));
    return {
      scrollTop: body.scrollTop,
      max: body.scrollHeight - body.clientHeight,
      clientHeight: body.clientHeight,
      rowTopInBody: rowRect.top - bodyRect.top,
      rowHeight: rowRect.height,
      expected: body.clientHeight * 0.36,
      activeIds: Array.from(document.querySelectorAll('.zxe-row.is-active')).map(
        (item) => item.dataset.blockId,
      ),
      lastId: rows[rows.length - 1]?.dataset.blockId ?? null,
    };
  })()`);
  observation('FOCUS', '专注写作跟随几何', focusGeometry);
  check(
    focusGeometry &&
      focusGeometry.activeIds.includes('p12') &&
      !focusGeometry.activeIds.includes(focusGeometry.lastId) &&
      focusGeometry.scrollTop < focusGeometry.max - 2 &&
      Math.abs(focusGeometry.rowTopInBody - focusGeometry.expected) <= 45,
    'E-04',
    '专注模式写作跟随仍把当前块滚到约 36% 高度',
    focusGeometry,
  );
  await screenshot('07-focus-writing-line.png');
  await clickSelector('.zxe-focusbar-exit', '退出专注模式');
  await waitFor(`document.querySelector('.zxe--focus') === null`, '退出专注模式');

  /* ---------------- 3. 行前整行选择 ---------------- */
  await setScrollTop(0);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 4,
    y: 4,
    button: 'none',
  });
  await sleep(260);
  const idleGutter = await gutterState('p3');
  check(
    idleGutter && idleGutter.opacity === '0',
    'B-01',
    '未 hover 时行前 gutter 默认不可见',
    idleGutter,
  );
  await hoverRow('p4');
  const hoveredGutter = await gutterState('p4');
  check(
    hoveredGutter &&
      hoveredGutter.opacity === '1' &&
      hoveredGutter.pointerEvents === 'auto' &&
      hoveredGutter.controlWidth >= 17 &&
      hoveredGutter.controlHeight >= 17,
    'B-02',
    'hover 行时左侧出现可点击的选择控件',
    hoveredGutter,
  );
  check(
    hoveredGutter.controlCount === 1 &&
      hoveredGutter.handleCount === 1 &&
      hoveredGutter.controlDraggable === null &&
      hoveredGutter.handleDraggable === 'true',
    'B-03',
    '每行只有一套选择控件；选择控件不可拖，手柄可拖',
    hoveredGutter,
  );
  await screenshot('08-hover-gutter.png');

  const scrollBeforeSelect = (await metrics()).scrollTop;
  await clickGutter('p4');
  const selectedOne = await selectionState();
  const afterSelectMetrics = await metrics();
  check(
    selectedOne.ids.length === 1 &&
      selectedOne.ids[0] === 'p4' &&
      selectedOne.mode === 'block' &&
      selectedOne.blockSelection === 'true',
    'B-04',
    '单击行前控件选中整行 p4',
    selectedOne,
  );
  check(
    selectedOne.barText?.includes('已选 1 个块') &&
      selectedOne.menu === false &&
      selectedOne.dialog === false,
    'B-05',
    '选中后出现底部选择条，没有误开菜单/弹层',
    selectedOne,
  );
  check(
    afterSelectMetrics.activeElement?.inline !== true &&
      Math.abs(afterSelectMetrics.scrollTop - scrollBeforeSelect) <= 2,
    'B-06',
    '点选择控件不把光标送进正文、不滚动',
    { activeElement: afterSelectMetrics.activeElement, before: scrollBeforeSelect, after: afterSelectMetrics.scrollTop },
  );
  const selectedGutter = await gutterState('p4');
  check(
    selectedGutter.controlPressed === 'true' &&
      selectedGutter.controlLabel === '取消选择第 5 块',
    'B-07',
    '已选中行的控件 aria-pressed/label 正确（p4 是第 5 行）',
    selectedGutter,
  );
  await screenshot('09-block-selected.png');

  await clickGutter('p4');
  const deselected = await selectionState();
  const afterDeselect = await metrics();
  check(
    deselected.count === 0 &&
      !deselected.mode &&
      deselected.barText === null &&
      deselected.blockSelection === 'false',
    'B-08',
    '再次点击同一控件取消整行选择',
    deselected,
  );
  check(
    afterDeselect.activeElement?.inline !== true &&
      Math.abs(afterDeselect.scrollTop - scrollBeforeSelect) <= 2,
    'B-09',
    '取消选择不抢正文光标、不滚动',
    afterDeselect.activeElement,
  );

  // Shift 范围。
  await clickGutter('p2');
  await clickGutter('p5', 8);
  const shiftSelection = await selectionState();
  check(
    shiftSelection.ids.length === 4 &&
      shiftSelection.ids[0] === 'p2' &&
      shiftSelection.ids[3] === 'p5',
    'B-10',
    'Shift+点击行前控件扩展为 p2–p5 范围',
    shiftSelection,
  );
  check(
    shiftSelection.barText?.includes('已选 4 个块'),
    'B-11',
    '范围选择后底部条显示 4 块',
    shiftSelection.barText,
  );
  await screenshot('10-shift-range.png');

  // ⌘ 追加与再点取消。macOS 上 Ctrl+左键会被系统解释为右键菜单，
  // 因此真实指针路径用 ⌘；Ctrl 分支与 ⌘ 共用 event.metaKey || event.ctrlKey。
  await clickGutter('p9', 4);
  const metaAdd = await selectionState();
  await clickGutter('p9', 4);
  const metaToggleOff = await selectionState();
  await clickGutter('p10', 4);
  const metaAddSecond = await selectionState();
  check(
    metaAdd.ids.includes('p9') &&
      metaAdd.ids.length === 5 &&
      !metaToggleOff.ids.includes('p9') &&
      metaToggleOff.ids.length === 4 &&
      metaAddSecond.ids.includes('p10') &&
      metaAddSecond.ids.length === 5,
    'B-12',
    '⌘+点击追加，再点切换取消',
    {
      metaAdd: metaAdd.ids,
      metaToggleOff: metaToggleOff.ids,
      metaAddSecond: metaAddSecond.ids,
    },
  );
  // 多选时无修饰键点已选中行 = 只移除该行（不是清空全部）。
  await clickGutter('p2');
  const removedOne = await selectionState();
  check(
    removedOne.ids.length === 4 &&
      !removedOne.ids.includes('p2') &&
      removedOne.ids.includes('p10'),
    'B-13',
    '多选时无修饰键再次点击某行只取消该行',
    removedOne.ids,
  );
  // 点未选中行则重置为单块。
  await clickGutter('p14');
  const resetSingle = await selectionState();
  check(
    resetSingle.ids.length === 1 && resetSingle.ids[0] === 'p14',
    'B-13b',
    '无修饰键点击未选中行重置为单块选择',
    resetSingle.ids,
  );

  // 点击空白退出选择。
  await clickBlank('middle');
  const clearedByBlank = await selectionState();
  check(
    clearedByBlank.count === 0,
    'B-14',
    '点击正文空白退出块选择',
    clearedByBlank,
  );

  // 拖拽手柄 / 块菜单不误触。
  const dragBefore = await evaluate('window.__ZX_DRAG__.count');
  await scrollRowIntoView('p6');
  await hoverRow('p6');
  const handle = await evaluate(`(() => {
    const row = document.querySelector('[data-block-id="p6"]');
    const button = row?.querySelector('.zxe-block-control');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert(handle, '找不到块操作手柄');
  await sleep(150);
  await clickPoint(handle.x, handle.y);
  await waitFor(
    `document.querySelector('.zxe-menu, [role="menu"]') !== null`,
    '块菜单打开',
    5000,
  );
  const menuState = await selectionState();
  const dragAfter = await evaluate('window.__ZX_DRAG__.count');
  check(
    menuState.count === 0 && dragAfter === dragBefore,
    'B-15',
    '点击拖拽手柄只打开块菜单，不选中整行、不触发 dragstart',
    { menuState, dragBefore, dragAfter },
  );
  await pressEscape();
  await waitFor(
    `document.querySelector('.zxe-menu, [role="menu"]') === null`,
    '块菜单关闭',
    5000,
  );

  // 快速连点：偶数次点击应回到未选中，且不开菜单。
  await scrollRowIntoView('p7');
  await hoverRow('p7');
  const rapidRect = await evaluate(`(() => {
    const row = document.querySelector('[data-block-id="p7"]');
    const control = row?.querySelector('.zxe-block-select');
    if (!control) return null;
    const rect = control.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert(rapidRect, '找不到 p7 行前选择控件');
  for (let index = 0; index < 6; index += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rapidRect.x,
      y: rapidRect.y,
      button: 'none',
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: rapidRect.x,
      y: rapidRect.y,
      button: 'left',
      clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: rapidRect.x,
      y: rapidRect.y,
      button: 'left',
      clickCount: 1,
    });
    await sleep(25);
  }
  await sleep(320);
  const rapid = await selectionState();
  check(
    rapid.count === 0 && rapid.menu === false && rapid.dialog === false,
    'B-16',
    '同一行前控件快速连点 6 次后稳定回到未选中，无菜单/弹层',
    rapid,
  );

  // 文档级 ⌘A 与高级入口仍保留。
  await clickRowInline('p8');
  await pressKey('a', {
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    modifiers: 4,
  });
  await waitFor(
    `document.querySelector('.zxe')?.getAttribute('data-selection-mode') === 'document'`,
    '⌘A 文档级选择',
    5000,
  );
  const documentSelect = await selectionState();
  check(
    documentSelect.ids.length === BLOCK_COUNT_A &&
      documentSelect.selectControls === 0 &&
      documentSelect.mode === 'document' &&
      documentSelect.barText?.includes('已选中整篇'),
    'B-17',
    '⌘A 一次选中整篇，文档级选择不挂每行复选框',
    documentSelect,
  );
  await screenshot('11-document-select.png');
  await clickBlank('middle');
  await waitFor(
    `document.querySelector('.zxe')?.getAttribute('data-block-selection') === 'false'`,
    '点击空白退出文档级选择',
    5000,
  );

  await clickSelector('.zxe-select-all', '选择块（高级）');
  await waitFor(
    `document.querySelector('.zxe')?.getAttribute('data-selection-mode') === 'block'`,
    '进入高级块选择',
    5000,
  );
  const advanced = await selectionState();
  check(
    advanced.ids.length === 1 &&
      advanced.selectControls === BLOCK_COUNT_A &&
      advanced.mode === 'block',
    'B-18',
    '原有「选择块（高级）」入口保留并可进入',
    advanced,
  );
  await clickSelector('.zxe-select-all', '取消块选择');
  await waitFor(
    `document.querySelector('.zxe')?.getAttribute('data-block-selection') === 'false'`,
    '退出高级块选择',
    5000,
  );

  // 代码 / 表格 / 公式 / 画板整行选择。
  await clickGutter('code1');
  const codeSelected = await selectionState();
  await clickGutter('table1', 4);
  const tableSelected = await selectionState();
  await clickGutter('formula1', 4);
  const formulaSelected = await selectionState();
  await clickGutter('board1', 4);
  const boardSelected = await selectionState();
  check(
    codeSelected.ids[0] === 'code1' &&
      tableSelected.ids.includes('table1') &&
      formulaSelected.ids.includes('formula1') &&
      boardSelected.ids.includes('board1') &&
      boardSelected.ids.length === 4 &&
      boardSelected.menu === false &&
      boardSelected.dialog === false,
    'B-19',
    '代码/表格/公式/画板整行选择均可用，未误开菜单或画板',
    {
      code: codeSelected.ids,
      table: tableSelected.ids,
      formula: formulaSelected.ids,
      board: boardSelected.ids,
      menu: boardSelected.menu,
      dialog: boardSelected.dialog,
      title: await evaluate(`document.querySelector('.kn-title')?.value ?? ''`),
    },
  );
  await screenshot('12-atomic-blocks-selected.png');
  await clickBlank('middle');
  const atomicCleared = await selectionState();
  check(atomicCleared.count === 0, 'B-20', '点击空白清空原子块选择', atomicCleared);

  /* ---------------- 4. 文字选择 / 输入 / Enter / Backspace ---------------- */
  await scrollRowIntoView('p9');
  const dragRange = await dragSelectText('p9');
  const selectedText = await textSelection();
  const afterTextDrag = await metrics();
  const textDragSelection = await evaluate(`(() => ({
    blockSelected: document.querySelectorAll('.zxe-row.is-block-selected').length,
    activeIds: Array.from(document.querySelectorAll('.zxe-row.is-active')).map(
      (row) => row.dataset.blockId,
    ),
    currentSelection: String(window.getSelection()?.toString() ?? ''),
  }))()`);
  check(
    selectedText.length >= 4 &&
      (dragRange.expected.includes(selectedText.trim()) ||
        selectedText.includes(dragRange.expected.slice(0, 4))),
    'T-01',
    '正文拖拽仍能选择文字',
    { expected: dragRange.expected, selectedText },
  );
  check(
    afterTextDrag.activeIds.length === 1 &&
      textDragSelection.blockSelected === 0 &&
      textDragSelection.currentSelection.length >= 4,
    'T-02',
    '拖选文字没有叠加块选择',
    textDragSelection,
  );
  await clickRowInline('p9');
  const beforeTypeText = await metrics();
  await typeText(MARKER_TEXT);
  const afterTypeText = await metrics();
  check(
    Math.abs(afterTypeText.scrollTop - beforeTypeText.scrollTop) <= 2,
    'T-03',
    '正文输入不改变 scrollTop',
    { before: beforeTypeText.scrollTop, after: afterTypeText.scrollTop },
  );
  await waitFor(
    `window.__ZX_WORLD__.db.notes.find((n) => n.id === ${JSON.stringify(NOTE_A_ID)})?.body.includes(${JSON.stringify(MARKER_TEXT)})`,
    '正文输入落库',
    8000,
  );

  const rowsBeforeEnter = (await metrics()).rowCount;
  await pressEnter();
  await waitFor(
    `document.querySelectorAll('.zxe-row').length === ${rowsBeforeEnter + 1}`,
    'Enter 拆分出新块',
    5000,
  );
  const afterEnter = await metrics();
  check(
    afterEnter.rowCount === rowsBeforeEnter + 1 &&
      afterEnter.scrollTop < afterEnter.max - 2,
    'T-04',
    'Enter 正常拆块，且没有把正文滚到底部',
    { before: rowsBeforeEnter, after: afterEnter.rowCount, scrollTop: afterEnter.scrollTop, max: afterEnter.max },
  );
  await pressKey('Backspace', {
    code: 'Backspace',
    windowsVirtualKeyCode: 8,
  });
  await waitFor(
    `document.querySelectorAll('.zxe-row').length === ${rowsBeforeEnter}`,
    '空块 Backspace 合并回原块',
    5000,
  );
  const afterBackspace = await metrics();
  check(
    afterBackspace.rowCount === rowsBeforeEnter &&
      afterBackspace.scrollTop < afterBackspace.max - 2,
    'T-05',
    '新空块 Backspace 正常合并，不发生跳底',
    { rows: afterBackspace.rowCount, scrollTop: afterBackspace.scrollTop, max: afterBackspace.max },
  );

  /* ---------------- 5. 空笔记 / 删除不存在项 / 刷新 ---------------- */
  const noteListLabels = await evaluate(
    `Array.from(document.querySelectorAll('[aria-label^="打开笔记："]')).map((el) => el.getAttribute('aria-label'))`,
  );
  observation('NOTES', '空笔记测试前的列表项', noteListLabels);
  await openNoteByTitle(NOTE_C, true);
  await waitFor(
    `document.querySelector('.kn-title')?.value === ${JSON.stringify(NOTE_C)}`,
    '打开空笔记 C',
  );
  await waitFor(
    `document.querySelector('.zxe') && !document.querySelector('.zxe.is-loading')`,
    '空笔记编辑器就绪',
  );
  const emptyState = await evaluate(`(() => {
    const body = document.querySelector('.zxe-body');
    return {
      rows: document.querySelectorAll('.zxe-row').length,
      selects: document.querySelectorAll('.zxe-block-select').length,
      error: Boolean(document.querySelector('.zxe-load-error')),
      scrollHeight: body?.scrollHeight ?? null,
      clientHeight: body?.clientHeight ?? null,
    };
  })()`);
  check(
    emptyState.error === false && emptyState.rows <= 1,
    'X-01',
    '空笔记可打开且不报错',
    emptyState,
  );
  await clickBlank('middle').catch(() => null);
  const emptyAfterBlank = await metrics();
  check(
    emptyAfterBlank && emptyAfterBlank.scrollTop === 0,
    'X-02',
    '空笔记点击正文空白不产生异常滚动',
    emptyAfterBlank ? { scrollTop: emptyAfterBlank.scrollTop, rows: emptyAfterBlank.rowCount } : null,
  );
  await screenshot('13-empty-note.png');
  await switchTab(NOTE_A);
  await waitFor(
    `document.querySelector('.kn-title')?.value === ${JSON.stringify(NOTE_A)} && document.querySelectorAll('.zxe-row').length === ${BLOCK_COUNT_A}`,
    '切回长笔记 A',
    20_000,
  );

  // 无选择时 Delete 不应删除任何块；选中后删除可撤销。
  const countBeforeNoopDelete = (await metrics()).rowCount;
  await pressKey('Delete', {
    code: 'Delete',
    windowsVirtualKeyCode: 46,
  });
  await sleep(400);
  const countAfterNoopDelete = (await metrics()).rowCount;
  check(
    countAfterNoopDelete === countBeforeNoopDelete,
    'X-03',
    '没有块选择时按 Delete 是空操作',
    { before: countBeforeNoopDelete, after: countAfterNoopDelete },
  );

  await clickGutter('p11');
  await pressKey('Delete', {
    code: 'Delete',
    windowsVirtualKeyCode: 46,
  });
  await waitFor(
    `document.querySelectorAll('.zxe-row').length === ${BLOCK_COUNT_A - 1}`,
    'Delete 删除选中块',
    5000,
  );
  await pressKey('Delete', {
    code: 'Delete',
    windowsVirtualKeyCode: 46,
  });
  await sleep(400);
  const afterSecondDelete = await metrics();
  check(
    afterSecondDelete.rowCount === BLOCK_COUNT_A - 1,
    'X-04',
    '删除后选择已清空，再次 Delete 不会误删其它块',
    { rows: afterSecondDelete.rowCount },
  );
  await waitFor(
    `document.querySelector('.kn-paper-foot [aria-label="撤销编辑"]')?.disabled === false`,
    '删除后撤销可用',
    5000,
  );
  await clickSelector('.kn-paper-foot [aria-label="撤销编辑"]', '撤销删除');
  await waitFor(
    `document.querySelectorAll('.zxe-row').length === ${BLOCK_COUNT_A}`,
    '撤销删除恢复块数',
    5000,
  );
  await waitFor(
    `window.__ZX_WORLD__.db.blocks.filter((block) => block.noteId === ${JSON.stringify(NOTE_A_ID)} && !block.deletedAt).length === ${BLOCK_COUNT_A}`,
    '撤销删除后 fake DB 块数恢复',
    5000,
  );
  await waitFor(
    `(document.querySelector('.kn-save-state')?.textContent || '').includes('已保存到本机')`,
    '撤销删除后保存完成',
    8000,
  );

  // 刷新：fake DB 通过 localStorage 持久化，验证已保存正文与临时选择状态。
  const markerBeforeReload = await evaluate(
    `(document.querySelector('[data-block-id="p9"] .zxe-inline')?.textContent || '').includes(${JSON.stringify(MARKER_TEXT)})`,
  );
  check(markerBeforeReload, 'X-05', '刷新前正文标记已渲染', markerBeforeReload);
  await send('Page.reload', { ignoreCache: true });
  await waitFor(
    `document.readyState === 'complete' && (document.querySelectorAll('.zxe-row').length > 0 || document.querySelector('.zxe-load-error') !== null)`,
    '刷新后编辑器重新就绪',
    30_000,
  );
  await sleep(1200);
  const reloadState = await evaluate(`(() => ({
    rows: document.querySelectorAll('.zxe-row').length,
    marker: (document.querySelector('[data-block-id="p9"] .zxe-inline')?.textContent || '').includes(${JSON.stringify(MARKER_TEXT)}),
    blockSelection: document.querySelector('.zxe')?.getAttribute('data-block-selection'),
    selectedRows: document.querySelectorAll('.zxe-row.is-block-selected').length,
    loadError: Boolean(document.querySelector('.zxe-load-error')),
    saveLabel: document.querySelector('.kn-save-state')?.textContent ?? '',
    restored: window.__ZX_RESTORED__,
    title: document.querySelector('.kn-title')?.value ?? '',
    url: location.href,
    dbBlocks: window.__ZX_WORLD__.db.blocks.filter((block) => block.noteId === ${JSON.stringify(NOTE_A_ID)} && !block.deletedAt).length,
  }))()`);
  observation('RELOAD', '刷新后状态', reloadState);
  check(
    reloadState.rows === BLOCK_COUNT_A &&
      reloadState.marker &&
      reloadState.blockSelection === 'false' &&
      reloadState.selectedRows === 0 &&
      reloadState.loadError === false,
    'X-06',
    '刷新后已保存正文仍在，临时块选择已清除，编辑器不报错',
    reloadState,
  );
  await screenshot('14-after-reload.png');

  // 快速切换笔记：A/B/A/B/A，最终稳定在 A。
  for (const title of [NOTE_B, NOTE_A, NOTE_B, NOTE_A, NOTE_B]) {
    await evaluate(`(() => {
      const item = document.querySelector('[aria-label="打开笔记：${title}"]');
      if (item) item.click();
      return Boolean(item);
    })()`);
    await sleep(60);
  }
  await switchTab(NOTE_A);
  await waitFor(
    `document.querySelector('.kn-title')?.value === ${JSON.stringify(NOTE_A)} && document.querySelectorAll('.zxe-row').length === ${BLOCK_COUNT_A}`,
    '快速切换后回到 A',
    20_000,
  );
  const rapidSwitch = await metrics();
  check(
    rapidSwitch.rowCount === BLOCK_COUNT_A && rapidSwitch.scrollTop < rapidSwitch.max - 2,
    'X-07',
    '快速切换笔记后仍稳定在 A，未跳底',
    { rows: rapidSwitch.rowCount, scrollTop: rapidSwitch.scrollTop, max: rapidSwitch.max },
  );

  // 收尾断言：控制台零报错。
  check(
    consoleErrors.length === 0,
    'X-08',
    '全程控制台零 error',
    consoleErrors,
  );
  check(
    pageExceptions.length === 0,
    'X-09',
    '全程无未捕获异常',
    pageExceptions,
  );
} catch (error) {
  fatal = error;
  check(false, 'FATAL', `验收中断：${error?.message ?? error}`, String(error?.stack ?? error));
  console.error(error);
} finally {
  const failed = results.filter((item) => !item.ok).length;
  const summary = {
    card: ['t', 'c7b714f8'].join('_'),
    title: 'ZX10-EDITOR-QA-01 滚动稳定与行前选择独立验收',
    dist: DIST,
    startedAt: new Date().toISOString(),
    fatal: fatal ? String(fatal?.stack ?? fatal) : null,
    results,
    observations,
    consoleErrors,
    pageExceptions,
    screenshots,
    passed: results.length - failed,
    failed,
  };
  fs.writeFileSync(
    path.join(EVIDENCE, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(
    `\n结果：${summary.passed}/${results.length} 通过，${summary.failed} 失败。证据：tests/evidence/zx10-editor-qa-01/`,
  );
  try {
    socket.close();
  } catch {
    // ignore
  }
  chrome.kill('SIGKILL');
  spawnSync('pkill', ['-f', `Google Chrome.*${CHROME_PROFILE_PREFIX}`], {
    stdio: 'ignore',
  });
  server.close();
  process.exitCode = failed > 0 ? 1 : 0;
  // 给 Chrome/HTTP 服务器一点退出时间，避免进程悬挂。
  setTimeout(() => process.exit(process.exitCode), 300);
}
