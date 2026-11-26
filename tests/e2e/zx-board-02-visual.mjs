/**
 * ZX-BOARD-02 画板默认视觉实测：浅色 / 暗色截图。
 *
 * 用真实构建产物 app/dist + Chrome DevTools Protocol：
 *   1. 注入 tests/harness/fakeTauri.ts（仅浏览器验收用），清空画板种子；
 *   2. 从空画板点击「起步结构」，依次插入流程图与横向泳道；
 *   3. 浅色截图后切换 data-theme=dark（真实外观链路），再截一张。
 *
 * 运行：pnpm build && node tests/e2e/zx-board-02-visual.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/ZX-BOARD-02');
const FAKE_BUNDLE = '/tmp/zx-board-02-fake.js';
const PORT = 8898;
const DEBUG_PORT = 9225;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('找不到 app/dist，请先运行 pnpm build');
}
fs.mkdirSync(EVIDENCE, { recursive: true });

const esbuild = path.join(
  ROOT,
  'node_modules/.pnpm/node_modules/.bin/esbuild',
);
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

const userDataDir = `/tmp/zx-board-02-chrome-${Date.now()}`;
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
const consoleErrors = [];

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
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    consoleErrors.push(
      details.exception?.description ?? details.text ?? 'unknown exception',
    );
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
  const file = path.join(EVIDENCE, name);
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  console.log(`截图：${path.relative(ROOT, file)}`);
}

async function clickButtonByText(text) {
  const ok = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (item) => (item.textContent || '').trim().includes(${JSON.stringify(text)}),
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!ok) throw new Error(`找不到按钮：${text}`);
}

async function clickRailButton(label) {
  const ok = await evaluate(`(() => {
    const button = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!ok) throw new Error(`找不到工具栏按钮：${label}`);
}

const injection = `(() => {
  try {
    localStorage.setItem('zhixing.appearance.v1', JSON.stringify({
      theme: 'light', accent: 'blue', density: 'comfortable',
    }));
  } catch (error) {}
  __ZX_FAKE_BUNDLE__
  try {
    const world = ZXFake.createFakeWorld();
    // 空画板首屏：让工作区自动创建一块新画板。
    world.db.boards = [];
    world.db.nodes = [];
    world.db.edges = [];
    world.install();
    const originalInvoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await originalInvoke(command, args);
      try {
        localStorage.setItem('zx_board02_db', JSON.stringify(world.db));
      } catch (error) {}
      return result;
    };
    window.__ZX_WORLD__ = world;
  } catch (error) {
    window.__ZX_INIT_ERROR__ = String(error?.stack ?? error);
  }
})();`.replace('  __ZX_FAKE_BUNDLE__\n', () => fakeBundle);

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: injection });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/board` });

  await waitFor('Boolean(document.querySelector(".bw-canvas"))', '画板加载');
  await waitFor(
    'document.body.textContent.includes("空白画板")',
    '空画板首屏',
  );
  const initError = await evaluate('window.__ZX_INIT_ERROR__ ?? null');
  if (initError) throw new Error(String(initError));

  await clickButtonByText('起步结构');
  await waitFor('Boolean(document.querySelector(".bw-starter-card"))', '起步结构弹窗');
  await clickButtonByText('流程图');
  await waitFor(
    'document.body.textContent.includes("6 个对象 · 5 条连线")',
    '流程图插入',
  );

  await clickRailButton('起步结构');
  await waitFor('Boolean(document.querySelector(".bw-starter-card"))', '起步结构弹窗');
  await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.bw-starter-card')).find(
      (item) => (item.textContent || '').includes('泳道 · 横向'),
    );
    if (!card) return false;
    card.click();
    return true;
  })()`);
  await waitFor(
    'document.body.textContent.includes("15 个对象 · 5 条连线")',
    '泳道插入',
  );

  // 取消刚插入时的全选，截图展示对象本身而不是一堆选择框。
  await evaluate(`(() => {
    const canvas = document.querySelector('.bw-canvas');
    if (!canvas) return false;
    canvas.focus();
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));

  await screenshot('board-light.png');

  await evaluate(`(() => {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.dataset.themePreference = 'dark';
    return document.documentElement.dataset.theme;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const darkTheme = await evaluate(
    'document.documentElement.getAttribute("data-theme")',
  );
  if (darkTheme !== 'dark') throw new Error('暗色主题未生效');
  await screenshot('board-dark.png');

  const summary = await evaluate(`(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    accent: document.documentElement.getAttribute('data-accent'),
    counts: document.querySelector('.bw-counts')?.textContent ?? '',
    frameFill: getComputedStyle(document.documentElement).getPropertyValue('--board-frame-fill').trim(),
    stickyFill: getComputedStyle(document.documentElement).getPropertyValue('--board-sticky-fill').trim(),
    processFill: getComputedStyle(document.documentElement).getPropertyValue('--board-process-fill').trim(),
  }))()`);
  console.log('验收摘要：', JSON.stringify(summary));
  if (consoleErrors.length > 0) {
    console.error('控制台错误：', consoleErrors);
    process.exitCode = 1;
  } else {
    console.log('控制台无错误');
  }
} finally {
  socket.close();
  chrome.kill('SIGTERM');
  server.close();
}
