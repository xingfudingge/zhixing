/**
 * ZX-TASK-01 浏览器验收：静态 dist + fakeTauri，真实 Chromium 点击与截图。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/task-center-browser.mjs
 *
 * 截图写到 /tmp/zx-task-evidence（可用 ZX_EVIDENCE 覆盖），不提交二进制。
 * 覆盖：1280/900 布局、概览卡、五范围、列表/看板、快速新建、批量、
 * 空态、900 抽屉、Esc 关闭与焦点返回、控制台零错误。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = process.env.ZX_EVIDENCE ?? '/tmp/zx-task-evidence';
const FAKE_BUNDLE = '/tmp/zx-fake-task.js';
const PORT = 8897;
const DEBUG_PORT = 9224;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

fs.mkdirSync(EVIDENCE, { recursive: true });
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
if (bundled.status !== 0) throw new Error(`fakeTauri 打包失败：${bundled.stderr}`);
const fakeBundle = fs.readFileSync(FAKE_BUNDLE, 'utf8');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
  let file = path.join(DIST, pathname);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html');
  }
  response.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const userDataDir = `/tmp/zx-chrome-task-${Date.now()}`;
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
chrome.stderr.on('data', (chunk) => { chromeStderr += String(chunk); });

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
    } catch {}
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
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(
      (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' '),
    );
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    pageExceptions.push(details.exception?.description ?? details.text ?? 'unknown');
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
    }, 20_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
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
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  }
  return result.result?.value;
}
async function waitFor(expression, label, timeout = 12_000) {
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
  console.log(`[evidence] ${EVIDENCE}/${name}`);
}

const injection = `(() => {
  try {
    __ZX_FAKE_BUNDLE__
    const world = ZXFake.createFakeWorld();
    world.install();
    window.__ZX_WORLD__ = world;
  } catch (error) {
    window.__ZX_INIT_ERROR__ = String(error?.stack ?? error);
  }
})();`.replace('__ZX_FAKE_BUNDLE__', () => fakeBundle);

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.addScriptToEvaluateOnNewDocument', { source: injection });

async function navigate(url, readyText = '全部任务') {
  await send('Page.navigate', { url });
  await waitFor(
    `document.readyState === 'complete' && document.body && document.body.innerText.includes(${JSON.stringify(readyText)})`,
    `页面加载 ${url}`,
  );
  const initError = await evaluate('window.__ZX_INIT_ERROR__ ?? null');
  if (initError) throw new Error(`注入失败：${initError}`);
  await waitFor(`document.querySelectorAll('.task-row').length > 0`, '任务行出现');
}

try {
  await navigate(`http://127.0.0.1:${PORT}/tasks`);

  const initial = await evaluate(`(() => ({
    title: document.querySelector('h1')?.textContent,
    cards: Array.from(document.querySelectorAll('.task-overview-card')).map((el) => el.querySelector('.task-overview-number')?.textContent),
    scopes: Array.from(document.querySelectorAll('[aria-label="任务范围"] [role="tab"]')).map((el) => el.textContent.trim()),
    statuses: Array.from(document.querySelectorAll('[aria-label="任务状态"] [role="tab"]')).map((el) => el.textContent.trim()),
    rowCount: document.querySelectorAll('.task-row').length,
    checkboxes: document.querySelectorAll('.task-select').length,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }))()`);
  console.log('[check] initial', JSON.stringify(initial));
  if (initial.title !== '全部任务') throw new Error('标题不是全部任务');
  if (initial.cards.length !== 4) throw new Error('概览卡不是 4 张');
  if (initial.scopes.length !== 5) throw new Error('范围标签不是 5 个');
  if (initial.statuses.length !== 4) throw new Error('状态标签不是 4 个');
  if (initial.checkboxes !== 0) throw new Error('默认不应显示批量复选框');
  if (initial.overflow) throw new Error('1280 出现横向溢出');
  await screenshot('01-tasks-1280.png');

  // 概览卡 -> 今天
  await evaluate(`document.querySelectorAll('.task-overview-card')[1].click()`);
  await waitFor(`location.search.includes('filter=today')`, '点击今天卡写 URL');
  const todayState = await evaluate(`(() => ({
    groups: Array.from(document.querySelectorAll('.task-section-head')).map((el) => el.textContent.replace(/\\d+$/, '').trim()),
    active: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim(),
  }))()`);
  console.log('[check] today scope', JSON.stringify(todayState));
  await screenshot('02-today-scope.png');

  // 接下来范围
  await evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).find((el) => el.textContent.includes('接下来')).click()`);
  await waitFor(`location.search.includes('filter=next')`, '切到接下来');
  console.log(
    '[check] next groups',
    JSON.stringify(await evaluate(`Array.from(document.querySelectorAll('.task-section-head')).map((el) => el.textContent.replace(/\\d+$/, '').trim())`)),
  );

  // 看板
  await evaluate(`Array.from(document.querySelectorAll('.task-center-views button')).find((el) => el.textContent === '看板').click()`);
  await waitFor(`document.querySelector('.task-board') !== null`, '看板出现');
  const board = await evaluate(`(() => ({
    columns: Array.from(document.querySelectorAll('.task-board-column')).map((el) => ({ name: el.getAttribute('aria-label'), count: el.querySelectorAll('.task-card').length })),
    url: location.search,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }))()`);
  console.log('[check] board', JSON.stringify(board));
  if (board.columns.length !== 3) throw new Error('看板列数不是 3');
  if (board.overflow) throw new Error('看板 1280 横向溢出');
  await screenshot('03-board-1280.png');

  // 列表 + 快速新建
  await evaluate(`Array.from(document.querySelectorAll('.task-center-views button')).find((el) => el.textContent === '列表').click()`);
  await waitFor(`document.querySelector('.task-quick-add') !== null`, '列表与快速新建出现');
  const before = await evaluate(`document.querySelectorAll('.task-row').length`);
  await evaluate(`(() => {
    const input = document.querySelector('.task-quick-add input[type="text"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '浏览器验收新增任务');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`);
  await waitFor(`document.body.innerText.includes('浏览器验收新增任务')`, '快速新建任务出现');
  const after = await evaluate(`document.querySelectorAll('.task-row').length`);
  console.log('[check] quick add rows', before, '->', after);
  await screenshot('04-quick-add.png');

  // 批量模式
  await evaluate(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === '批量').click()`);
  await waitFor(`document.querySelectorAll('.task-select').length > 0`, '批量复选框出现');
  await evaluate(`document.querySelector('.task-select').click()`);
  await waitFor(`document.querySelector('.task-batch-bar') !== null`, '批量条出现');
  console.log(
    '[check] batch',
    JSON.stringify(await evaluate(`({
      selected: document.querySelector('.task-batch-count')?.textContent,
      bar: Boolean(document.querySelector('.task-batch-bar')),
    })`)),
  );
  await screenshot('05-batch.png');
  await evaluate(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === '退出批量').click()`);

  // 筛选空态
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/tasks?q=绝对不存在的关键词` });
  await waitFor(`document.body.innerText.includes('没有匹配的任务')`, '筛选空态');
  await screenshot('06-empty.png');

  // 900 宽与详情抽屉
  await send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await navigate(`http://127.0.0.1:${PORT}/tasks`);
  const narrow = await evaluate(`(() => ({
    overviewCols: getComputedStyle(document.querySelector('.task-center-overview')).gridTemplateColumns,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    detailVisible: getComputedStyle(document.querySelector('.task-center-detail')).display !== 'none',
  }))()`);
  console.log('[check] 900', JSON.stringify(narrow));
  if (narrow.overflow) throw new Error('900 出现横向溢出');
  if (narrow.detailVisible) throw new Error('900 未选中时不应显示详情面板');
  await screenshot('07-tasks-900.png');
  await evaluate(`document.querySelector('.task-row-body').click()`);
  await waitFor(`document.querySelector('.task-center-detail.is-drawer-open') !== null`, '900 详情抽屉打开');
  const drawer = await evaluate(`(() => {
    const el = document.querySelector('.task-center-detail.is-drawer-open');
    const rect = el.getBoundingClientRect();
    return { width: Math.round(rect.width), top: Math.round(rect.top), right: Math.round(window.innerWidth - rect.right), overflow: document.documentElement.scrollWidth > window.innerWidth };
  })()`);
  console.log('[check] 900 drawer', JSON.stringify(drawer));
  if (drawer.width !== 372) throw new Error(`抽屉宽度不是 372：${drawer.width}`);
  if (drawer.overflow) throw new Error('900 抽屉打开后横向溢出');
  await screenshot('08-tasks-900-drawer.png');

  // Esc 关闭抽屉与焦点返回
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await waitFor(`document.querySelector('.task-center-detail.is-drawer-open') === null`, 'Esc 关闭抽屉');
  console.log('[check] esc closed, focus=', await evaluate(`document.activeElement?.getAttribute('aria-label')`));

  console.log('[result] consoleErrors=', JSON.stringify(consoleErrors));
  console.log('[result] exceptions=', JSON.stringify(pageExceptions));
  if (consoleErrors.length || pageExceptions.length) {
    throw new Error('控制台存在错误');
  }
  console.log('[result] PASS');
} finally {
  try { socket.close(); } catch {}
  chrome.kill('SIGTERM');
  server.close();
}
