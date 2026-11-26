/**
 * ZX-GRAPH-01 浏览器布局验收（真实 Chromium + 产品构建 + Tauri IPC 替身）。
 *
 * 真实桌面 WebView 已验证关系图交互；这里补 1280 / 900 两档宽度：
 *   * 关系图面板是覆盖式抽屉时，正文宽度不被挤到不可用；
 *   * 面板 >= 300px、画布 >= 240px，仍可缩放/平移；
 *   * 保存两档截图与 result.json。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-graph-01-browser.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-graph-01');
const USER_DATA = '/tmp/zx-graph-01-chrome';
const PORT = 5188;
const DEBUG_PORT = 9331;
const CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT_TITLE = '关系图来源';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
fs.mkdirSync(EVIDENCE, { recursive: true });
fs.rmSync(USER_DATA, { recursive: true, force: true });

const esbuild = path.join(
  ROOT,
  'node_modules/.pnpm/node_modules/.bin/esbuild',
);
const fakeBundlePath = '/tmp/zx-graph-01-fake.js';
const bundled = spawnSync(
  esbuild,
  [
    path.join(ROOT, 'tests/harness/fakeTauri.ts'),
    '--bundle',
    '--format=iife',
    '--global-name=ZXFake',
    '--platform=browser',
    `--outfile=${fakeBundlePath}`,
  ],
  { encoding: 'utf8' },
);
if (bundled.status !== 0) {
  throw new Error(`打包 fakeTauri 失败：${bundled.stderr}`);
}
const fakeBundle = fs.readFileSync(fakeBundlePath, 'utf8');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};
const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  let file = path.join(
    DIST,
    url.pathname === '/' ? 'index.html' : url.pathname,
  );
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
    `--user-data-dir=${USER_DATA}`,
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
  if (message.method === 'Runtime.consoleAPICalled') {
    if (message.params.type === 'error') {
      consoleErrors.push(
        (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? '')
          .join(' '),
      );
    }
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    consoleErrors.push(
      details.exception?.description ?? details.text ?? 'unknown exception',
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

async function waitFor(expression, label, timeout = 20_000) {
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

const injection = `(() => {
  __ZX_FAKE_BUNDLE__
  try {
    const world = ZXFake.createFakeWorld();
    world.install();
    window.__ZX_WORLD__ = world;
  } catch (error) {
    window.__ZX_INIT_ERROR__ = String(error?.stack ?? error);
  }
})();`.replace('  __ZX_FAKE_BUNDLE__\n', () => fakeBundle);

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.addScriptToEvaluateOnNewDocument', { source: injection });

const evidence = {
  startedAt: new Date().toISOString(),
  task: 'ZX-GRAPH-01',
  title: '关系图 1280/900 布局（真实 Chromium）',
  steps: [],
  consoleErrors,
  failures: [],
  ok: false,
};
function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-graph-01-browser] ${name}: ${JSON.stringify(value)}`);
}
function assert(condition, message) {
  if (!condition) {
    evidence.failures.push(message);
    throw new Error(message);
  }
}

try {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/today` });
  await waitFor(
    `document.readyState === 'complete' && document.body.innerText.includes('今天')`,
    '首页加载',
  );
  const initError = await evaluate('window.__ZX_INIT_ERROR__ ?? null');
  if (initError) throw new Error(`注入初始化失败：${initError}`);

  if (await evaluate(`document.body.innerText.includes('开始 7 天试用')`)) {
    await evaluate(`Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent.trim() === '开始 7 天试用')?.click()`);
    await waitFor(
      `document.body.innerText.includes('试用 · 剩 7 天')`,
      '试用开始',
    );
  }

  const seeded = await evaluate(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const existing = await invoke('notes_list', { query: { includeDeleted: true } });
    for (const note of existing) {
      await invoke('notes_delete', { id: note.id });
    }
    const notes = [
      {
        id: 'graph-a',
        title: '${ROOT_TITLE}',
        body: '<p><a href="zhixing://note/graph-b">二跳来源</a></p><p><a href="https://example.com/x">外链</a></p><p>zhixing://note/graph-gone</p>',
      },
      {
        id: 'graph-b',
        title: '二跳来源',
        body: '<p>zhixing://note/graph-c</p>',
      },
      { id: 'graph-c', title: '二跳笔记', body: '<p>正文</p>' },
      { id: 'graph-d', title: '孤立笔记', body: '<p>没有内链</p>' },
    ];
    for (const note of notes) {
      await invoke('notes_create', { input: note });
    }
    return notes.length;
  })()`);
  record('seeded', seeded);

  await evaluate(`Array.from(document.querySelectorAll('a.nav-link, button.nav-link'))
    .find((el) => (el.getAttribute('aria-label') || el.textContent || '').includes('知识'))?.click()`);
  await waitFor(`document.querySelector('.kn-workspace') !== null`, '知识页加载');
  await evaluate(`Array.from(document.querySelectorAll('[aria-label^="打开笔记："]'))
    .find((el) => el.getAttribute('aria-label').includes('${ROOT_TITLE}'))?.click()`);
  await waitFor(
    `document.querySelector('input[aria-label="笔记标题"]')?.value === '${ROOT_TITLE}'`,
    '打开根笔记',
  );
  await evaluate(`Array.from(document.querySelectorAll('button[aria-label]'))
    .find((el) => el.getAttribute('aria-label') === '笔记链接')?.click()`);
  await waitFor(`document.querySelector('aside[aria-label="笔记链接"]') !== null`, '链接面板');
  await evaluate(`Array.from(document.querySelectorAll('[role="tab"]'))
    .find((el) => el.textContent.trim() === '关系图')?.click()`);
  await waitFor(`document.querySelector('svg[aria-label="笔记关系图"]') !== null`, '关系图渲染');

  for (const [width, height] of [
    [1280, 900],
    [900, 900],
  ]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const viewport = await evaluate(`(() => {
      const aside = document.querySelector('aside[aria-label="笔记链接"]');
      const svg = document.querySelector('svg[aria-label="笔记关系图"]');
      const paper = document.querySelector('.kn-paper');
      const rect = (el) => {
        if (!el) return null;
        const box = el.getBoundingClientRect();
        return {
          width: Math.round(box.width * 10) / 10,
          height: Math.round(box.height * 10) / 10,
          left: Math.round(box.left * 10) / 10,
          top: Math.round(box.top * 10) / 10,
        };
      };
      const style = aside ? getComputedStyle(aside) : null;
      return {
        innerWidth: window.innerWidth,
        panel: rect(aside),
        panelPosition: style ? style.position : null,
        svg: rect(svg),
        paper: rect(paper),
        stats: aside?.querySelector('.kn-graph-stats')?.textContent ?? '',
      };
    })()`);
    record(`viewport-${width}`, viewport);
    assert(
      viewport.innerWidth === width,
      `${width} 宽度未生效：${viewport.innerWidth}`,
    );
    assert(
      viewport.panel.width >= 300 && viewport.panel.height > 300,
      `${width} 宽度下关系图面板过小：${JSON.stringify(viewport.panel)}`,
    );
    assert(
      viewport.svg.width > 240 && viewport.svg.height > 240,
      `${width} 宽度下关系图画布过小：${JSON.stringify(viewport.svg)}`,
    );
    assert(
      viewport.paper.width >= 320,
      `${width} 宽度下正文被挤压：${JSON.stringify(viewport.paper)}`,
    );
    assert(
      viewport.stats.includes('2 篇笔记 · 1 条内链'),
      `${width} 宽度下关系图数据异常：${viewport.stats}`,
    );
    await screenshot(`viewport-${width}.png`);
  }

  record('console-errors', consoleErrors);
  assert(consoleErrors.length === 0, `控制台异常：${JSON.stringify(consoleErrors)}`);
  evidence.ok = true;
  console.log('[zx-graph-01-browser] 结果：全部通过');
} catch (error) {
  evidence.failures.push(error.message || String(error));
  console.error(`[zx-graph-01-browser] 失败：${error.message || error}`);
  process.exitCode = 1;
} finally {
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(EVIDENCE, 'browser-result.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  try {
    chrome.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  server.close();
}
