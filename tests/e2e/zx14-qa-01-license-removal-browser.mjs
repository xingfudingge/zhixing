/**
 * ZX14-QA-01 无授权模块独立验收（真实 Chromium + app/dist 浏览器预览）。
 *
 * 覆盖：
 *   - 全新 profile / 空 localStorage 直接进入 /today，无激活/试用/许可页；
 *   - 顶栏、导航、设置分组无许可入口；
 *   - /settings/license 直接访问回落到 /settings/appearance；
 *   - 全局搜索面板无许可命令；
 *   - 刷新两次仍直接进入主界面；
 *   - 快速连点 8 个设置分组不崩溃、控制台零错误。
 * 证据：tests/evidence/zx14-qa-01/browser/
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx14-qa-01/browser');
const PORT = 8898;
const DEBUG_PORT = 9231;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
fs.rmSync(EVIDENCE, { recursive: true, force: true });
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
  let file = path.join(DIST, url.pathname);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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

const userDataDir = `/tmp/zx14-qa-01-chrome-${Date.now()}`;
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

let nextId = 0;
const pending = new Map();
const consoleErrors = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    consoleErrors.push(details.exception?.description ?? details.text ?? 'unknown exception');
  }
  if (
    message.method === 'Runtime.consoleAPICalled' &&
    message.params.type === 'error'
  ) {
    consoleErrors.push(
      message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '),
    );
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP 超时：${method}`)), 25_000);
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
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  }
  return result.result?.value;
}

async function waitFor(expression, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(expression).catch(() => false);
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`等待超时：${label}（最后值：${JSON.stringify(last)}）`);
}

async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  const file = path.join(EVIDENCE, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`截图：${path.relative(ROOT, file)}`);
}

async function navigate(url) {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${url}` });
}

const checks = [];
const failures = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`[zx14-browser] ${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail).slice(0, 1200)}`}`);
  if (!ok) failures.push(`${name}：${JSON.stringify(detail)}`);
}

try {
  await send('Runtime.enable');
  await send('Page.enable');

  // 1) 全新 profile + 空 localStorage 直接进入主界面。
  await navigate('/');
  await waitFor(
    `location.pathname === '/today' && document.querySelector('h1')?.textContent.includes('今天')`,
    '直接进入 /today',
  );
  const first = await evaluate(`(() => {
    const norm = (v) => String(v ?? '').replace(/\\s+/g, ' ').trim();
    const topbar = document.querySelector('header.topbar');
    return {
      path: location.pathname,
      topbar: topbar ? norm(topbar.innerText) : null,
      body: norm(document.body.innerText).slice(0, 3000),
      nav: Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')),
      storageKeys: Object.keys(localStorage),
    };
  })()`);
  const needles = ['开始 7 天试用', '试用 7 天', '已授权', '未授权', '许可与设备', '激活', 'LC1-', '授权码', '安装 ID'];
  check('全新浏览器直接进入 /today', first.path === '/today', first.path);
  check('顶栏无许可/试用/授权状态', !/试用|已授权|未授权|许可/i.test(first.topbar ?? ''), first.topbar);
  check('页面无激活/试用/许可文案', !needles.some((needle) => first.body.includes(needle)), needles.filter((needle) => first.body.includes(needle)));
  check('导航无 /settings/license', !first.nav.includes('/settings/license'), first.nav);
  check('全新浏览器 localStorage 无 license 键', !first.storageKeys.some((key) => /license|trial/i.test(key)), first.storageKeys);
  await screenshot('browser-today.png');

  // 2) 全局搜索面板无许可命令。
  await evaluate(`document.querySelector('[aria-label^="全局搜索"]')?.click()`);
  await waitFor(`Boolean(document.querySelector('[role="dialog"]'))`, '全局搜索面板');
  const dialogText = await evaluate(`document.querySelector('[role="dialog"]')?.innerText ?? ''`);
  check('全局搜索面板无许可命令', !/许可|授权|试用|license/i.test(dialogText), dialogText.slice(0, 800));
  await screenshot('browser-search.png');
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 3) 直接访问已删除的 /settings/license。
  await navigate('/settings/license');
  await waitFor(`location.pathname === '/settings/appearance'`, '/settings/license 回落');
  const fallback = await evaluate(`(() => {
    const groups = Array.from(document.querySelectorAll('nav[aria-label="设置分组"] a')).map((a) => a.getAttribute('href'));
    return { path: location.pathname, groups, body: document.body.innerText };
  })()`);
  check('直接访问 /settings/license 回落到外观', fallback.path === '/settings/appearance', fallback.path);
  check('设置分组 8 个且无许可', fallback.groups.length === 8 && !fallback.groups.includes('/settings/license'), fallback.groups);
  check('设置页不渲染许可内容', !/许可与设备|授权码|安装 ID|试用/.test(fallback.body), fallback.body.slice(0, 500));
  await screenshot('browser-settings-license-fallback.png');

  // 4) 快速连点 8 个设置分组。
  await evaluate(`(async () => {
    const groups = Array.from(document.querySelectorAll('nav[aria-label="设置分组"] a'));
    for (let round = 0; round < 3; round += 1) {
      for (const group of groups) group.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const afterRapid = await evaluate(`({ path: location.pathname, text: document.body.innerText })`);
  check(
    '快速连点 8 个设置分组后停在合法分组且无许可',
    /^\/settings\/(appearance|task|calendar|notify|ocr|privacy|sync|data)$/.test(afterRapid.path) &&
      !/许可与设备|授权码|安装 ID/.test(afterRapid.text),
    afterRapid.path,
  );

  // 5) 刷新两次，仍直接进入主界面。
  for (let round = 0; round < 2; round += 1) {
    await navigate('/');
    await waitFor(`location.pathname === '/today'`, `第 ${round + 1} 次刷新进入 /today`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const refreshed = await evaluate(`({ path: location.pathname, body: document.body.innerText })`);
  check('刷新后仍直接进入主界面且无激活页', refreshed.path === '/today' && !/开始 7 天试用|激活|许可与设备/.test(refreshed.body), refreshed.path);

  check('控制台零错误', consoleErrors.length === 0, consoleErrors);
} finally {
  try {
    socket.close();
  } catch {
    /* ignore */
  }
  chrome.kill('SIGTERM');
  server.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Chrome 退出时可能仍在写 profile；清理失败不影响验收结论。
  }
}

const summary = {
  task: 'ZX14-QA-01',
  kind: 'browser-preview-license-removal',
  startedAt: new Date().toISOString(),
  checks,
  failures,
  consoleErrors,
};
fs.writeFileSync(path.join(EVIDENCE, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`[zx14-browser] ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAIL`}`);
if (failures.length > 0) process.exitCode = 1;
