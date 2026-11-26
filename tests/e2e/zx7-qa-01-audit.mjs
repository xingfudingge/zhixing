/**
 * ZX7-QA-01 独立浏览器审计（真实生产构建 + 真实 Chromium/CDP）。
 *
 * 与实现卡脚本分开，只做卡面未被覆盖的三件事：
 *   1. 日期弹层在触发器贴近视口左/右边缘时仍不遮触发器、不溢出；
 *   2. 390×844 下菜单是否按设计 §6.10 变成底部 sheet；
 *   3. 表格宽单元格、caret 在最左侧时，工具条是否真的跟随 caret。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx7-qa-01-audit.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx7-qa-01');
const FAKE_BUNDLE = '/tmp/zx-fake-zx7-qa-01.js';
const PORT = 8931;
const DEBUG_PORT = 9246;
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
  throw new Error(`打包 fakeIpc 失败：${bundled.stderr}`);
}
const fakeBundle = fs.readFileSync(FAKE_BUNDLE, 'utf8');

const results = [];
function record(id, message, actual) {
  results.push({ id, message, actual });
  console.log(`[AUDIT] ${id} ${message}（实际：${JSON.stringify(actual)}）`);
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

const userDataDir = `/tmp/zx-chrome-zx7-qa-01-${Date.now()}`;
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
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    consoleErrors.push(message.params.entry.text);
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
  fs.writeFileSync(path.join(EVIDENCE, name), Buffer.from(result.data, 'base64'));
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

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await setViewport(1440, 1000);

const note = {
  id: 'note-zx7-qa',
  spaceId: 'personal',
  folderId: null,
  title: 'QA 宽单元格',
  tags: [],
  body: '',
  bodyFormat: 'html',
  status: 'active',
  favorite: false,
  pinned: false,
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
  deletedAt: null,
  version: 1,
};
const wideTable = {
  id: 'block-zx7-qa-table',
  noteId: note.id,
  blockType: 'table',
  orderKey: 1000,
  payload: {
    header: false,
    rows: [
      ['这是一个很宽的单元格，用来验证 caret 位于最左侧时工具条是否跟随光标', 'B', 'C'],
      ['D', 'E', 'F'],
    ],
    widths: [600, 140, 140],
  },
  schemaVersion: 2,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
  deletedAt: null,
  version: 1,
};

await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    ${fakeBundle}
    const world = ZXFake.createFakeWorld();
    world.install();
    world.db.notes.push(${JSON.stringify(note)});
    world.db.blocks.push(${JSON.stringify(wideTable)});
    window.__ZX_WORLD__ = world;
  })();`,
});

const PAGE_HELPERS = `
window.__ZXA__ = {
  dialog() { return document.querySelector('.task-dialog'); },
  fieldGroup() { return document.querySelector('.task-dialog .date-field-group'); },
  icon() { return document.querySelector('.task-dialog .date-field-icon'); },
  panel() { return document.querySelector('.dp-popover'); },
  closePanel() {
    const icon = this.icon();
    if (this.panel() && icon) icon.click();
  },
  panelSnapshot() {
    const panel = this.panel();
    const anchor = this.fieldGroup()?.getBoundingClientRect();
    if (!panel || !anchor) return null;
    const rect = panel.getBoundingClientRect();
    const viewport = {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    };
    const separated =
      rect.bottom <= anchor.top - 1 ||
      rect.top >= anchor.bottom + 1 ||
      rect.right <= anchor.left - 1 ||
      rect.left >= anchor.right + 1;
    return {
      placement: panel.getAttribute('data-placement'),
      ready: panel.getAttribute('data-ready'),
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      anchor: { left: anchor.left, top: anchor.top, right: anchor.right, bottom: anchor.bottom },
      viewport,
      separated,
      inside:
        rect.left >= -0.5 &&
        rect.top >= -0.5 &&
        rect.right <= viewport.width + 0.5 &&
        rect.bottom <= viewport.height + 0.5,
    };
  },
  menuSnapshot() {
    const menu = document.querySelector('.kn-context-menu');
    if (!menu) return null;
    const rect = menu.getBoundingClientRect();
    const style = getComputedStyle(menu);
    return {
      className: menu.className,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      position: style.position,
      bottom: style.bottom,
      left: style.left,
      right: style.right,
      inside:
        rect.left >= -0.5 &&
        rect.top >= -0.5 &&
        rect.right <= document.documentElement.clientWidth + 0.5 &&
        rect.bottom <= document.documentElement.clientHeight + 0.5,
    };
  },
  tableSnapshot() {
    const cell = document.querySelector('.zxe-table [data-row="0"][data-column="0"] input.zxe-table-cell');
    const toolbar = document.querySelector('.zxe-table-toolbar');
    if (!cell || !toolbar) return null;
    const cellRect = cell.getBoundingClientRect();
    const barRect = toolbar.getBoundingClientRect();
    const style = getComputedStyle(cell);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = style.font;
    const caretOffset = cell.selectionStart ?? 0;
    const caretX = cellRect.left + parseFloat(style.paddingLeft || '0') + ctx.measureText(cell.value.slice(0, caretOffset)).width - cell.scrollLeft;
    const dx = Math.max(barRect.left - caretX, caretX - barRect.right, 0);
    const dy = Math.max(barRect.top - cellRect.bottom, cellRect.top - barRect.bottom, 0);
    return {
      cell: { left: cellRect.left, top: cellRect.top, right: cellRect.right, bottom: cellRect.bottom, width: cellRect.width, height: cellRect.height },
      bar: { left: barRect.left, top: barRect.top, right: barRect.right, bottom: barRect.bottom, width: barRect.width, height: barRect.height },
      caretX,
      dx,
      dy,
      distance: Math.sqrt(dx * dx + dy * dy),
      selectionStart: caretOffset,
      textLength: cell.value.length,
    };
  },
};
true;`;

let fatal = null;
try {
  /* ---------------- 1. 日期弹层左右边缘 ---------------- */
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

  for (const side of ['left', 'right']) {
    await evaluate(`(() => {
      const group = window.__ZXA__.fieldGroup();
      if (!group) return false;
      group.style.position = 'fixed';
      group.style.top = '420px';
      group.style.width = '220px';
      group.style.left = ${side === 'left' ? "'8px'" : "'calc(100vw - 228px)'"};
      group.style.zIndex = '1300';
      return true;
    })()`);
    await evaluate('window.__ZXA__.closePanel(); true');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await realClick('.task-dialog .date-field-icon');
    await waitFor(
      `window.__ZXA__.panel()?.getAttribute('data-ready') === 'true'`,
      `日期弹层 ${side} 测量完成`,
    );
    await new Promise((resolve) => setTimeout(resolve, 220));
    const snapshot = await evaluate('window.__ZXA__.panelSnapshot()');
    record(
      `date-${side}`,
      `${side} 边缘弹层不遮触发器且不溢出视口`,
      snapshot,
    );
    await screenshot(`date-${side}-edge.png`);
  }
  await evaluate('window.__ZXA__.closePanel(); true');

  /* 390 窄窗：sheet 形态与遮罩（设计 §3.4） */
  await setViewport(390, 844);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await realClick('.task-dialog .date-field-icon');
  await waitFor(
    `window.__ZXA__.panel()?.getAttribute('data-ready') === 'true'`,
    '390 日期弹层测量完成',
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  const sheet = await evaluate(`(() => {
    const panel = window.__ZXA__.panel();
    const rect = panel.getBoundingClientRect();
    const backdrop = document.querySelector(
      '.dp-backdrop, .dp-sheet-backdrop, .date-backdrop, [data-date-backdrop]'
    );
    return {
      className: panel.className,
      placement: panel.getAttribute('data-placement'),
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      inside:
        rect.left >= -0.5 &&
        rect.top >= -0.5 &&
        rect.right <= document.documentElement.clientWidth + 0.5 &&
        rect.bottom <= document.documentElement.clientHeight + 0.5,
      backdrop: Boolean(backdrop),
      parent: panel.parentElement?.id || panel.parentElement?.className || panel.parentElement?.tagName,
    };
  })()`);
  record('date-390-sheet', '390 sheet 在视口内且有遮罩（设计 §3.4）', sheet);
  await screenshot('date-390-sheet.png');
  await evaluate('window.__ZXA__.closePanel(); true');

  /* ---------------- 2. 表格宽单元格 caret ---------------- */
  await setViewport(1280, 900);
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/knowledge` });
  await waitFor(
    `document.querySelector('[aria-label="打开笔记：QA 宽单元格"]') !== null`,
    'QA 笔记出现在列表',
  );
  await evaluate(PAGE_HELPERS);
  await evaluate(
    `document.querySelector('[aria-label="打开笔记：QA 宽单元格"]').click(); true`,
  );
  await waitFor(
    `document.querySelectorAll('.zxe-table [data-row="0"]').length > 0`,
    '宽表格渲染',
  );
  await evaluate('window.__ZXA__.tableSnapshot()');
  const cellPoint = await evaluate(`(() => {
    const el = document.querySelector('.zxe-table [data-row="0"][data-column="0"] input.zxe-table-cell');
    const rect = el.getBoundingClientRect();
    return { x: rect.left + 12, y: rect.top + rect.height / 2 };
  })()`);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: cellPoint.x, y: cellPoint.y, button: 'left', clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: cellPoint.x, y: cellPoint.y, button: 'left', clickCount: 1,
  });
  await waitFor(
    `document.querySelector('.zxe-table-toolbar')?.getAttribute('data-positioned') === 'true'`,
    '表格工具条定位',
  );
  await evaluate(`(() => {
    const el = document.querySelector('.zxe-table [data-row="0"][data-column="0"] input.zxe-table-cell');
    el.focus();
    el.setSelectionRange(0, 0);
    el.dispatchEvent(new Event('keyup', { bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const table = await evaluate('window.__ZXA__.tableSnapshot()');
  record('table-caret', '宽单元格 caret 在 0 时工具条到 caret 的距离', table);
  await screenshot('table-wide-caret-left.png');

  /* ---------------- 3. 390 菜单形态 ---------------- */
  await setViewport(390, 844);
  await evaluate(`(() => {
    const button = document.querySelector('[aria-label="打开笔记：QA 宽单元格"]');
    button.focus();
    button.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'F10', shiftKey: true, bubbles: true,
    }));
    return true;
  })()`);
  await waitFor(
    `document.querySelector('.kn-context-menu') !== null`,
    '390 菜单打开',
  );
  await new Promise((resolve) => setTimeout(resolve, 220));
  const menu = await evaluate('window.__ZXA__.menuSnapshot()');
  record('menu-390', '390 宽菜单是否为底部 sheet（设计 §6.10）', menu);
  await screenshot('menu-390.png');

  record('console', '控制台 error / 页面异常', {
    consoleErrors,
    pageExceptions,
  });
} catch (error) {
  fatal = error;
  console.error('[FATAL]', error.message);
} finally {
  fs.writeFileSync(
    path.join(EVIDENCE, 'result.json'),
    JSON.stringify({ fatal: fatal?.message ?? null, results, consoleErrors, pageExceptions }, null, 2),
  );
  try {
    await send('Browser.close');
  } catch {
    // 忽略关闭失败。
  }
  chrome.kill('SIGKILL');
  server.close();
}

if (fatal) process.exitCode = 1;
