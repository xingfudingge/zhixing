/**
 * ZX8-RAILPOP-01 浏览器实测：右栏浮窗贴右边缘、层级、滚动/缩放/折叠/窄屏。
 *
 * 真实生产构建 + 真实 Chromium（CDP），只注入 tests/harness/fakeTauri.ts
 * 的内存 IPC 替身；产品源码与构建不改。
 *
 * 覆盖：
 *   1. 1280 / 1024：浮窗 position:fixed，右缘距右栏左缘 ≤1.5px，不压右栏；
 *   2. 打开浮窗不改变正文纸面 rect（不推动正文）；
 *   3. 浮窗 z=340 < 命令栏菜单 z=420，两矩形交集面积为 0；
 *   4. 滚动正文 500px 后浮窗 top/right 不变；
 *   5. 折叠右栏后锚点宽度 32px，浮窗继续贴边；
 *   6. 900 / 390：右栏隐藏，面板为右侧 sheet，不出现抽屉+浮窗双浮层；
 *   7. 控制台 0 error、页面 0 exception。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx8-railpop-browser.mjs
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
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx8-railpop');
const FAKE_BUNDLE = '/tmp/zx-fake-zx8-railpop.js';
const PORT = 8922;
const DEBUG_PORT = 9247;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NOTE_TITLE = '右栏浮窗验收';

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

const userDataDir = `/tmp/zx-chrome-zx8-railpop-${Date.now()}`;
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
}

const PAGE_HELPERS = `
window.__ZX8__ = {
  rect(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      left: +r.left.toFixed(1),
      top: +r.top.toFixed(1),
      right: +r.right.toFixed(1),
      bottom: +r.bottom.toFixed(1),
      width: +r.width.toFixed(1),
      height: +r.height.toFixed(1),
    };
  },
  rail() { return document.querySelector('.kn-rail'); },
  toggle() { return document.querySelector('.kn-rail-toggle'); },
  flyout() { return document.querySelector('[data-kn-rail-flyout]'); },
  paper() { return document.querySelector('.kn-paper'); },
  menu() { return document.querySelector('.kn-context-menu'); },
  tools() { return document.querySelector('.kn-cmd-tools'); },
  drawer() { return document.querySelector('.kn-tools-drawer'); },
  openTool(key) {
    const button = document.querySelector('[data-rail-tool="' + key + '"]');
    if (!button) return false;
    button.click();
    return true;
  },
  openFromDrawer(key) {
    const row = Array.from(
      document.querySelectorAll('.kn-tools-drawer .kn-drawer-row'),
    ).find((item) => item.getAttribute('aria-label') === key);
    if (!row) return false;
    row.click();
    return true;
  },
  openMenu() {
    const button = document.querySelector('[aria-label="更多文档操作"]');
    if (!button) return false;
    button.click();
    return true;
  },
  closeFlyout() {
    const panel = this.flyout();
    const button = panel?.querySelector('.kn-info-head button');
    if (!button) return false;
    button.click();
    return true;
  },
  collapse() {
    const button = this.toggle();
    if (!button) return false;
    button.click();
    return true;
  },
  scrollBody(top) {
    const body = document.querySelector('.zxe-body');
    if (!body) return null;
    const previous = body.style.scrollBehavior;
    body.style.scrollBehavior = 'auto';
    body.scrollTop = top;
    const result = { scrollTop: body.scrollTop, scrollHeight: body.scrollHeight };
    body.style.scrollBehavior = previous;
    return result;
  },
  snapshot() {
    const flyout = this.flyout();
    const rail = this.rail();
    const menu = this.menu();
    const paper = this.paper();
    const style = flyout ? getComputedStyle(flyout) : null;
    const menuStyle = menu ? getComputedStyle(menu) : null;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      rail: this.rect(rail),
      railWidth: rail ? getComputedStyle(rail).width : null,
      flyout: this.rect(flyout),
      paper: this.rect(paper),
      menu: this.rect(menu),
      position: style?.position ?? null,
      right: style?.right ?? null,
      zIndex: style ? Number(style.zIndex) : null,
      menuZIndex: menuStyle ? Number(menuStyle.zIndex) : null,
      drawer: Boolean(this.drawer()),
      activeClass: document.activeElement?.className ?? null,
    };
  },
};
true;`;

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await setViewport(1280, 900);

const seedNote = {
  id: 'note-zx8-railpop',
  spaceId: 'personal',
  folderId: null,
  title: NOTE_TITLE,
  tags: ['验收'],
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
const seedBlocks = [
  ...Array.from({ length: 60 }, (_, index) => ({
    id: `block-zx8-fill-${index}`,
    noteId: seedNote.id,
    blockType: index === 0 ? 'heading2' : 'paragraph',
    orderKey: 100 + index,
    payload: {
      runs: [
        {
          text:
            index === 0
              ? '浮窗滚动验收'
              : `正文段落 ${index + 1}：用于撑开编辑器滚动区域，验证固定浮窗不随滚动漂移。`,
        },
      ],
    },
    schemaVersion: 1,
    createdAt: seedNote.createdAt,
    updatedAt: seedNote.updatedAt,
    deletedAt: null,
    version: 1,
  })),
];

await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    ${fakeBundle}
    const world = ZXFake.createFakeWorld();
    world.install();
    world.db.notes.push(${JSON.stringify(seedNote)});
    world.db.blocks.push(...${JSON.stringify(seedBlocks)});
    window.__ZX_WORLD__ = world;
  })();`,
});

function gap(flyout, rail) {
  return +(rail.left - flyout.right).toFixed(1);
}

function intersection(a, b) {
  const width = Math.max(
    0,
    Math.min(a.right, b.right) - Math.max(a.left, b.left),
  );
  const height = Math.max(
    0,
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
  );
  return +(width * height).toFixed(1);
}

let fatal = null;
try {
  await send('Page.navigate', {
    url: `http://127.0.0.1:${PORT}/knowledge`,
  });
  await waitFor(
    `document.readyState === 'complete' && document.body.innerText.includes('知识')`,
    '知识页加载',
  );
  await waitFor(
    `document.querySelector('[aria-label="打开笔记：${NOTE_TITLE}"]') !== null`,
    '种子笔记出现在列表',
  );
  await evaluate(
    `document.querySelector('[aria-label="打开笔记：${NOTE_TITLE}"]').click(); true`,
  );
  await waitFor(
    `document.querySelector('.kn-rail [data-rail-tool="outline"]') !== null`,
    '右栏渲染',
  );
  await evaluate(PAGE_HELPERS);

  const beforeOpen = await evaluate('window.__ZX8__.snapshot()');
  check(
    Boolean(beforeOpen.rail) && beforeOpen.flyout === null,
    'B-00',
    '初始状态：右栏存在、无浮窗',
    { rail: beforeOpen.rail, flyout: beforeOpen.flyout },
  );

  await evaluate(`window.__ZX8__.openTool('outline'); true`);
  await waitFor(`window.__ZX8__.flyout() !== null`, '1280 浮窗打开');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const wide = await evaluate('window.__ZX8__.snapshot()');
  const wideGap = gap(wide.flyout, wide.rail);
  check(
    wide.position === 'fixed',
    'B-01',
    '1280：浮窗 position:fixed',
    wide.position,
  );
  check(
    Math.abs(wideGap - 1) <= 1.5,
    'B-02',
    '1280：浮窗右缘贴右栏左缘（间距 1px，容差 1.5px）',
    { gap: wideGap, rail: wide.rail, flyout: wide.flyout },
  );
  check(
    wide.flyout.right <= wide.rail.left &&
      wide.flyout.left >= 0 &&
      wide.flyout.right <= wide.innerWidth,
    'B-03',
    '1280：浮窗不盖右栏、不溢出视口',
    wide.flyout,
  );
  check(
    Math.abs(wide.paper.left - beforeOpen.paper.left) <= 1 &&
      Math.abs(wide.paper.width - beforeOpen.paper.width) <= 1,
    'B-04',
    '1280：打开浮窗不推动正文（paper rect 不变）',
    { before: beforeOpen.paper, after: wide.paper },
  );
  check(
    wide.zIndex === 340,
    'B-05',
    '1280：浮窗 z-index = 340（右栏 10 < 浮窗 340 < 菜单 420）',
    wide.zIndex,
  );
  await screenshot('zx8-1280-flyout.png');

  await evaluate(`window.__ZX8__.openMenu(); true`);
  await waitFor(`window.__ZX8__.menu() !== null`, '更多菜单打开');
  await new Promise((resolve) => setTimeout(resolve, 120));
  const withMenu = await evaluate('window.__ZX8__.snapshot()');
  check(
    withMenu.menuZIndex === 420 && withMenu.zIndex === 340,
    'B-06',
    '菜单 z=420 高于浮窗 z=340',
    { menu: withMenu.menuZIndex, flyout: withMenu.zIndex },
  );
  check(
    intersection(withMenu.flyout, withMenu.menu) === 0,
    'B-07',
    '浮窗与命令栏菜单同开时交集面积为 0',
    { flyout: withMenu.flyout, menu: withMenu.menu },
  );
  await screenshot('zx8-1280-menu.png');
  await evaluate(`window.__ZX8__.openMenu(); true`);
  await waitFor(`window.__ZX8__.menu() === null`, '更多菜单关闭');

  const scrollResult = await evaluate(`window.__ZX8__.scrollBody(500)`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const scrolled = await evaluate('window.__ZX8__.snapshot()');
  check(
    scrollResult && scrollResult.scrollTop > 300,
    'B-08',
    '正文可滚动且实际滚动 > 300px',
    scrollResult,
  );
  check(
    Math.abs(scrolled.flyout.top - wide.flyout.top) <= 1 &&
      Math.abs(scrolled.flyout.right - wide.flyout.right) <= 1,
    'B-09',
    '滚动 500px 后浮窗 top/right 不偏移（±1px）',
    { before: wide.flyout, after: scrolled.flyout },
  );

  await evaluate(`window.__ZX8__.collapse(); true`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const collapsed = await evaluate('window.__ZX8__.snapshot()');
  check(
    collapsed.railWidth === '32px',
    'B-10',
    '折叠右栏为 32px',
    collapsed.railWidth,
  );
  check(
    Math.abs(gap(collapsed.flyout, collapsed.rail) - 1) <= 1.5,
    'B-11',
    '折叠后浮窗仍贴右栏左缘（间距 1px）',
    { gap: gap(collapsed.flyout, collapsed.rail) },
  );
  await screenshot('zx8-1280-collapsed.png');
  await evaluate(`window.__ZX8__.collapse(); true`);
  await evaluate(`window.__ZX8__.closeFlyout(); true`);
  await waitFor(`window.__ZX8__.flyout() === null`, '1280 浮窗关闭');

  // 1024：36px 右栏，仍贴边。
  await setViewport(1024, 900);
  await waitFor(
    `window.__ZX8__.rail() !== null && getComputedStyle(window.__ZX8__.rail()).width === '36px'`,
    '1024 右栏 36px',
  );
  await evaluate(`window.__ZX8__.openTool('outline'); true`);
  await waitFor(`window.__ZX8__.flyout() !== null`, '1024 浮窗打开');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const medium = await evaluate('window.__ZX8__.snapshot()');
  check(
    Math.abs(gap(medium.flyout, medium.rail) - 1) <= 1.5,
    'B-12',
    '1024：36px 右栏，浮窗仍贴左缘（间距 1px）',
    { gap: gap(medium.flyout, medium.rail), rail: medium.rail },
  );
  check(
    medium.flyout.width <= 320 && medium.flyout.left >= 0,
    'B-13',
    '1024：浮窗宽度 ≤320px 且不溢出',
    medium.flyout,
  );
  await screenshot('zx8-1024-flyout.png');
  await evaluate(`window.__ZX8__.closeFlyout(); true`);
  await waitFor(`window.__ZX8__.flyout() === null`, '1024 浮窗关闭');

  // 900：右栏隐藏，工具抽屉 -> 右侧 sheet，不同时存在两层。
  await setViewport(900, 700);
  await waitFor(`window.__ZX8__.rail() === null`, '900 右栏隐藏');
  await evaluate(`window.__ZX8__.tools().click(); true`);
  await waitFor(`window.__ZX8__.drawer() !== null`, '900 工具抽屉打开');
  await evaluate(`window.__ZX8__.openFromDrawer('大纲'); true`);
  await waitFor(`window.__ZX8__.flyout() !== null`, '900 sheet 打开');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const narrow900 = await evaluate('window.__ZX8__.snapshot()');
  check(
    !narrow900.drawer && narrow900.rail === null,
    'B-14',
    '900：选择面板后抽屉关闭，且无常驻右栏（无双浮层）',
    { drawer: narrow900.drawer, rail: narrow900.rail },
  );
  check(
    Math.abs(narrow900.flyout.right - narrow900.innerWidth) <= 1 &&
      Math.abs(narrow900.flyout.top) <= 1,
    'B-15',
    '900：sheet 贴视口右缘与顶部',
    narrow900.flyout,
  );
  check(
    narrow900.flyout.width <= 900 * 0.92 + 1 &&
      narrow900.scrollWidth <= narrow900.innerWidth,
    'B-16',
    '900：sheet 宽度 ≤92vw，无横向滚动',
    {
      width: narrow900.flyout.width,
      scrollWidth: narrow900.scrollWidth,
      innerWidth: narrow900.innerWidth,
    },
  );
  await screenshot('zx8-900-sheet.png');

  await pressEscape();
  await waitFor(`window.__ZX8__.flyout() === null`, '900 Esc 关闭 sheet');
  const focusAfterEsc = await evaluate(
    `document.activeElement === window.__ZX8__.tools()`,
  );
  check(
    focusAfterEsc === true,
    'B-17',
    '900：Esc 关闭 sheet 后焦点回到「工具」按钮',
    focusAfterEsc,
  );

  // 390：同抽屉入口，sheet 宽度受 92vw 限制。
  await setViewport(390, 844);
  await waitFor(`window.__ZX8__.rail() === null`, '390 右栏隐藏');
  await evaluate(`window.__ZX8__.tools().click(); true`);
  await waitFor(`window.__ZX8__.drawer() !== null`, '390 工具抽屉打开');
  await evaluate(`window.__ZX8__.openFromDrawer('大纲'); true`);
  await waitFor(`window.__ZX8__.flyout() !== null`, '390 sheet 打开');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const narrow390 = await evaluate('window.__ZX8__.snapshot()');
  check(
    Math.abs(narrow390.flyout.right - narrow390.innerWidth) <= 1 &&
      narrow390.flyout.width <= 390 * 0.92 + 1,
    'B-18',
    '390：sheet 贴右缘且宽度 ≤92vw',
    narrow390.flyout,
  );
  check(
    narrow390.scrollWidth <= narrow390.innerWidth,
    'B-19',
    '390：无横向滚动',
    {
      scrollWidth: narrow390.scrollWidth,
      innerWidth: narrow390.innerWidth,
    },
  );
  await screenshot('zx8-390-sheet.png');

  check(
    consoleErrors.length === 0 && pageExceptions.length === 0,
    'B-20',
    '控制台 0 error、页面 0 exception',
    { consoleErrors, pageExceptions },
  );
} catch (error) {
  fatal = error;
  check(false, 'FATAL', error instanceof Error ? error.message : String(error));
} finally {
  fs.writeFileSync(
    path.join(EVIDENCE, 'result.json'),
    JSON.stringify(
      {
        fatal: fatal ? String(fatal) : null,
        results,
        consoleErrors,
        pageExceptions,
      },
      null,
      2,
    ),
  );
  try {
    await send('Browser.close');
  } catch {
    // 已关闭。
  }
  socket.close();
  server.close();
  chrome.kill('SIGKILL');
}

const failed = results.filter((result) => !result.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `；失败：${failed.map((item) => item.id).join(', ')}` : ''),
);
process.exit(failed.length === 0 ? 0 : 1);
