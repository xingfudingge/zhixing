/**
 * ZX8-QA-01 独立浏览器验收：右栏浮窗贴边 + ESC 展开/还原/冲突。
 *
 * 真实生产构建 + 真实 Chromium（CDP），只注入 tests/harness/fakeTauri.ts
 * 的内存 IPC 替身；不改产品源码。
 *
 * 覆盖：
 *   A. 1280 / 1024 / 900 / 390、80%–150% 缩放模拟、滚动、折叠后的浮窗几何；
 *      浮窗与命令栏菜单/笔记行菜单同开时矩形不相交；
 *   B. ESC 展开/还原：左树/列表收为 0、内容区左移、无 scrim/置灰、
 *      滚动保持、焦点不落 body、还原后焦点回到来源；
 *   C. 冲突：输入框/正文/公式、菜单、模态、工具抽屉、沉浸、专注、
 *      长按 repeat、IME 组合态，每次只消费一层；
 *   D. 快速连按 2/3 次 ESC 的最终状态；390 下 no-op + Toast。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx8-qa-01-acceptance.mjs
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
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx8-qa-01');
const FAKE_BUNDLE = '/tmp/zx-fake-zx8-qa-01.js';
const PORT = 8925;
const DEBUG_PORT = 9251;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NOTE_TITLE = 'ZX8 QA 验收笔记';

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
  results.push({ id, ok: Boolean(ok), message, actual });
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

const userDataDir = `/tmp/zx-chrome-zx8-qa-01-${Date.now()}`;
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

/**
 * headless Chromium 在 Page.navigate 后会把 CSS transition 动画时钟停在 0；
 * 几何断言前先 finish() 到终态，避免把“动画未播放”误判为布局错误。
 * 真实浏览器中这些 transition 会在 180ms 内自然结束。
 */
async function finishAnimations() {
  await evaluate(
    `document.getAnimations().forEach((animation) => { try { animation.finish(); } catch {} }); true`,
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
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

async function setViewport(width, height, deviceScaleFactor = 1) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor,
    mobile: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function pressEscape(extra = {}) {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
    ...extra,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
}

async function pressEnter() {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    text: '\r',
    unmodifiedText: '\r',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

const PAGE_HELPERS = `
window.__ZXQA__ = {
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
  el(selector) { return document.querySelector(selector); },
  rail() { return document.querySelector('.kn-rail'); },
  toggle() { return document.querySelector('.kn-rail-toggle'); },
  flyout() { return document.querySelector('[data-kn-rail-flyout]'); },
  workspace() { return document.querySelector('.kn-workspace'); },
  tree() { return document.querySelector('.kn-tree'); },
  list() { return document.querySelector('.kn-list'); },
  paper() { return document.querySelector('.kn-paper'); },
  editor() { return document.querySelector('.kn-editor'); },
  menu() { return document.querySelector('.kn-context-menu'); },
  tools() { return document.querySelector('.kn-cmd-tools'); },
  drawer() { return document.querySelector('.kn-tools-drawer'); },
  titleInput() { return document.querySelector('.kn-title'); },
  formulaInput() { return document.querySelector('.zxe-formula-input'); },
  formulaPreview() { return document.querySelector('.zxe-formula-preview'); },
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
  scrollTop() {
    return document.querySelector('.zxe-body')?.scrollTop ?? null;
  },
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
  openMore() {
    const button = document.querySelector('[aria-label="更多文档操作"]');
    if (!button) return false;
    button.click();
    return true;
  },
  openExport() {
    const button = document.querySelector('[aria-label="导出笔记"]');
    if (!button) return false;
    button.click();
    return true;
  },
  openNoteMore() {
    const button = document.querySelector('[aria-label="更多操作：${NOTE_TITLE}"]');
    if (!button) return false;
    button.click();
    return true;
  },
  clickMenuText(text) {
    const item = Array.from(
      document.querySelectorAll('.kn-context-menu button'),
    ).find((button) => (button.textContent || '').includes(text));
    if (!item) return false;
    item.click();
    return true;
  },
  closeFlyout() {
    const panel = this.flyout();
    const button = panel?.querySelector('.kn-info-head button');
    if (!button) return false;
    button.click();
    return true;
  },
  collapseRail() {
    const button = this.toggle();
    if (!button) return false;
    button.click();
    return true;
  },
  focus(selector) {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.focus({ preventScroll: true });
    return document.activeElement === el;
  },
  click(selector) {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.click();
    return true;
  },
  active() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return { tag: null };
    return {
      tag: active.tagName,
      cls: typeof active.className === 'string' ? active.className : '',
      label: active.getAttribute('aria-label'),
      text: (active.textContent || '').trim().slice(0, 40),
      isBody: active === document.body || active === document.documentElement,
      inTree: Boolean(active.closest('.kn-tree')),
      inList: Boolean(active.closest('.kn-list')),
      inPaper: Boolean(active.closest('.kn-paper')),
      inMenu: Boolean(active.closest('.kn-context-menu')),
    };
  },
  visibleScrims() {
    return Array.from(
      document.querySelectorAll(
        '.kn-tools-scrim,.zxe-dialog-backdrop,[class*="scrim"],[class*="backdrop"]',
      ),
    )
      .filter((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .map((el) => ({
        cls: typeof el.className === 'string' ? el.className : '',
        rect: this.rect(el),
        background: getComputedStyle(el).backgroundColor,
      }));
  },
  snapshot() {
    const flyout = this.flyout();
    const rail = this.rail();
    const menu = this.menu();
    const paper = this.paper();
    const tree = this.tree();
    const list = this.list();
    const workspace = this.workspace();
    const flyoutStyle = flyout ? getComputedStyle(flyout) : null;
    const menuStyle = menu ? getComputedStyle(menu) : null;
    const paperStyle = paper ? getComputedStyle(paper) : null;
    const railStyle = rail ? getComputedStyle(rail) : null;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      expanded: workspace?.dataset.expanded ?? null,
      workspaceClass: workspace?.className ?? null,
      rail: this.rect(rail),
      railWidth: railStyle?.width ?? null,
      railDisplay: railStyle?.display ?? null,
      flyout: this.rect(flyout),
      flyoutPosition: flyoutStyle?.position ?? null,
      flyoutZ: flyoutStyle ? Number(flyoutStyle.zIndex) : null,
      menu: this.rect(menu),
      menuZ: menuStyle ? Number(menuStyle.zIndex) : null,
      tree: this.rect(tree),
      treeVisibility: tree ? getComputedStyle(tree).visibility : null,
      treeInert: tree?.inert ?? null,
      treeAriaHidden: tree?.getAttribute('aria-hidden') ?? null,
      list: this.rect(list),
      listVisibility: list ? getComputedStyle(list).visibility : null,
      listInert: list?.inert ?? null,
      paper: this.rect(paper),
      paperStyle: paperStyle
        ? {
            opacity: paperStyle.opacity,
            filter: paperStyle.filter,
            pointerEvents: paperStyle.pointerEvents,
          }
        : null,
      railStyle: railStyle
        ? { opacity: railStyle.opacity, filter: railStyle.filter }
        : null,
      paperScrollTop: this.scrollTop(),
      paperScrollBehavior: document.querySelector('.zxe-body')
        ? getComputedStyle(document.querySelector('.zxe-body')).scrollBehavior
        : null,
      paperScrollHeight: document.querySelector('.zxe-body')?.scrollHeight ?? null,
      paperClientHeight: document.querySelector('.zxe-body')?.clientHeight ?? null,
      active: this.active(),
      scrims: this.visibleScrims(),
      cmdExpandedButton: Boolean(
        document.querySelector('[aria-label="还原目录与列表"]'),
      ),
      toast: document.querySelector('.kn-toast')?.textContent ?? null,
      dialog: document.querySelector('[role="dialog"]')?.getAttribute('aria-label') ?? null,
      immersive: Boolean(document.querySelector('.knowledge-shell.is-immersive')),
      focusMode: Boolean(document.querySelector('.kn-workspace.is-focus')),
      drawer: Boolean(this.drawer()),
    };
  },
};
true;`;

async function loadKnowledge(width, height) {
  await setViewport(width, height);
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
    `document.querySelector('.kn-editor') !== null`,
    '编辑器渲染',
  );
  if (width <= 900) {
    await waitFor(
      `document.querySelector('.kn-editor')?.classList.contains('is-narrow') === true`,
      '窄屏状态归一化',
    );
  }
  await evaluate(PAGE_HELPERS);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await setViewport(1280, 900);

const seedNote = {
  id: 'note-zx8-qa-01',
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
    id: `block-zx8-qa-fill-${index}`,
    noteId: seedNote.id,
    blockType: index === 0 ? 'heading2' : 'paragraph',
    orderKey: 100 + index,
    payload: {
      runs: [
        {
          text:
            index === 0
              ? 'ESC 展开验收'
              : `正文段落 ${index + 1}：用于撑开编辑器滚动区域，验证滚动位置在展开/还原时保持。`,
        },
      ],
    },
    schemaVersion: 1,
    createdAt: seedNote.createdAt,
    updatedAt: seedNote.updatedAt,
    deletedAt: null,
    version: 1,
  })),
  {
    id: 'block-zx8-qa-formula',
    noteId: seedNote.id,
    blockType: 'formula',
    orderKey: 100 + 60,
    payload: { latex: 'E=mc^2', display: 'block', renderer: 'katex' },
    schemaVersion: 1,
    createdAt: seedNote.createdAt,
    updatedAt: seedNote.updatedAt,
    deletedAt: null,
    version: 1,
  },
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
  if (!a || !b) return 0;
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

function near(a, b, tolerance = 1.5) {
  return Math.abs(a - b) <= tolerance;
}

async function closeAnyMenuOrFlyout() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await evaluate('window.__ZXQA__.snapshot()');
    if (!state.menu && !state.flyout && !state.drawer) return;
    if (state.menu) {
      await pressEscape();
    } else if (state.flyout) {
      await evaluate('window.__ZXQA__.closeFlyout(); true');
      await waitFor('window.__ZXQA__.flyout() === null', '关闭浮窗');
    } else if (state.drawer) {
      await pressEscape();
      await waitFor('!window.__ZXQA__.drawer()', '关闭抽屉');
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function resetCollapsed() {
  await closeAnyMenuOrFlyout();
  let state = await evaluate('window.__ZXQA__.snapshot()');
  if (state.expanded === 'true') {
    await pressEscape();
    await waitFor(`window.__ZXQA__.snapshot().expanded === 'false'`, '还原布局');
    state = await evaluate('window.__ZXQA__.snapshot()');
  }
  if (state.active.isBody) {
    await evaluate('window.__ZXQA__.focus(".kn-tree-item")');
  }
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

  // ------------------------------------------------------------------
  // A. 右栏浮窗几何
  // ------------------------------------------------------------------
  const initial = await evaluate('window.__ZXQA__.snapshot()');
  check(
    Boolean(initial.rail) && initial.flyout === null && initial.expanded === 'false',
    'A-00',
    '初始状态：右栏存在、无浮窗、未展开',
    {
      rail: initial.rail,
      flyout: initial.flyout,
      expanded: initial.expanded,
      active: initial.active,
    },
  );

  await evaluate(`window.__ZXQA__.openTool('outline'); true`);
  await waitFor('window.__ZXQA__.flyout() !== null', '1280 浮窗打开');
  await new Promise((resolve) => setTimeout(resolve, 220));
  const wide = await evaluate('window.__ZXQA__.snapshot()');
  check(
    wide.flyoutPosition === 'fixed' && near(gap(wide.flyout, wide.rail), 1),
    'A-01',
    '1280：浮窗 fixed，右缘距右栏左缘 1px（±1.5px）',
    { gap: gap(wide.flyout, wide.rail), position: wide.flyoutPosition },
  );
  check(
    wide.flyout.right <= wide.rail.left &&
      wide.flyout.left >= 0 &&
      wide.flyout.right <= wide.innerWidth &&
      wide.flyoutZ === 340 &&
      wide.railStyle?.opacity === '1',
    'A-02',
    '1280：浮窗不盖右栏、不溢出、z=340、右栏不置灰',
    {
      flyout: wide.flyout,
      rail: wide.rail,
      z: wide.flyoutZ,
      railOpacity: wide.railStyle?.opacity,
    },
  );
  check(
    near(wide.paper.left, initial.paper.left) &&
      near(wide.paper.width, initial.paper.width),
    'A-03',
    '1280：打开浮窗不推动正文（paper rect 不变）',
    { before: initial.paper, after: wide.paper },
  );

  await evaluate('window.__ZXQA__.openMore(); true');
  await waitFor('window.__ZXQA__.menu() !== null', '命令栏菜单打开');
  await new Promise((resolve) => setTimeout(resolve, 150));
  let state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    state.menuZ === 420 &&
      state.flyoutZ === 340 &&
      intersection(state.menu, state.flyout) === 0,
    'A-04',
    '1280：命令栏菜单 z=420，与浮窗交集面积为 0',
    { menu: state.menu, flyout: state.flyout, intersection: intersection(state.menu, state.flyout) },
  );
  await pressEscape();
  await waitFor('window.__ZXQA__.menu() === null', '菜单 Esc 关闭');
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    Boolean(state.flyout) && state.expanded === 'false',
    'A-05',
    '菜单 Esc 只关菜单：浮窗仍在、未触发展开',
    { flyout: Boolean(state.flyout), expanded: state.expanded },
  );

  await evaluate('window.__ZXQA__.openNoteMore(); true');
  await waitFor('window.__ZXQA__.menu() !== null', '笔记行菜单打开');
  await new Promise((resolve) => setTimeout(resolve, 150));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    intersection(state.menu, state.flyout) === 0 &&
      state.menu.right <= state.flyout.left - 7,
    'A-06',
    '1280：笔记行菜单避让浮窗（right ≤ flyout.left - 8）',
    { menu: state.menu, flyout: state.flyout, intersection: intersection(state.menu, state.flyout) },
  );
  await pressEscape();
  await waitFor('window.__ZXQA__.menu() === null', '笔记行菜单 Esc 关闭');
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    Boolean(state.flyout) && state.expanded === 'false',
    'A-07',
    '笔记行菜单 Esc 只关菜单：浮窗仍在、未展开',
    { flyout: Boolean(state.flyout), expanded: state.expanded },
  );

  const scrollResult = await evaluate('window.__ZXQA__.scrollBody(500)');
  await new Promise((resolve) => setTimeout(resolve, 220));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    scrollResult && scrollResult.scrollTop > 300 &&
      near(state.flyout.top, wide.flyout.top) &&
      near(state.flyout.right, wide.flyout.right),
    'A-08',
    '1280：正文滚动 500px 后浮窗 top/right 不偏移（±1px）',
    { before: wide.flyout, after: state.flyout, scroll: scrollResult },
  );
  await screenshot('zx8-qa-01-1280-flyout.png');

  await evaluate('window.__ZXQA__.collapseRail(); true');
  await new Promise((resolve) => setTimeout(resolve, 180));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    state.railWidth === '32px' && near(gap(state.flyout, state.rail), 1),
    'A-09',
    '1280：折叠右栏 32px 后浮窗仍贴左缘',
    { railWidth: state.railWidth, gap: gap(state.flyout, state.rail) },
  );
  await screenshot('zx8-qa-01-1280-collapsed.png');
  await evaluate('window.__ZXQA__.collapseRail(); true');
  await new Promise((resolve) => setTimeout(resolve, 180));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    state.railWidth === '48px' && near(gap(state.flyout, state.rail), 1),
    'A-10',
    '1280：展开右栏后浮窗恢复贴边',
    { railWidth: state.railWidth, gap: gap(state.flyout, state.rail) },
  );

  // 模拟浏览器缩放：CSS 视口随缩放变化，物理窗口仍按 1280 计。
  await setViewport(1600, 900);
  await waitFor('window.innerWidth === 1600', '80% 缩放视口');
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    near(gap(state.flyout, state.rail), 1) &&
      state.flyout.right <= state.rail.left,
    'A-11',
    '80% 缩放（1600 CSS px）：浮窗仍贴右栏左缘',
    { innerWidth: state.innerWidth, gap: gap(state.flyout, state.rail) },
  );
  await setViewport(1280, 900);
  await waitFor('window.innerWidth === 1280', '100% 视口');
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    near(gap(state.flyout, state.rail), 1),
    'A-12',
    '100% 缩放（1280 CSS px）：浮窗仍贴右栏左缘',
    { gap: gap(state.flyout, state.rail) },
  );
  await setViewport(1024, 900, 1.25);
  await waitFor(
    `window.innerWidth === 1024 && getComputedStyle(window.__ZXQA__.rail()).width === '36px'`,
    '125% 缩放视口/36px 右栏',
  );
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    near(gap(state.flyout, state.rail), 1) &&
      state.flyout.width <= 320 &&
      state.flyout.right <= state.rail.left,
    'A-13',
    '125% 缩放（1024 CSS px）：36px 右栏，浮窗贴边且不溢出',
    {
      gap: gap(state.flyout, state.rail),
      flyout: state.flyout,
      rail: state.rail,
    },
  );
  await screenshot('zx8-qa-01-1024-flyout.png');
  const flyout1024 = state.flyout;
  await evaluate('window.__ZXQA__.openMore(); true');
  await waitFor('window.__ZXQA__.menu() !== null', '1024 菜单打开');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const menu1024 = await evaluate('window.__ZXQA__.snapshot()');
  check(
    intersection(menu1024.menu, menu1024.flyout) === 0 &&
      menu1024.menu.right <= menu1024.flyout.left - 7,
    'A-13c',
    '1024：命令栏菜单避让浮窗，交集面积为 0',
    {
      menu: menu1024.menu,
      flyout: menu1024.flyout,
      intersection: intersection(menu1024.menu, menu1024.flyout),
    },
  );
  await pressEscape();
  await waitFor('window.__ZXQA__.menu() === null', '1024 菜单关闭');
  const flyoutStill1024 = await evaluate('window.__ZXQA__.snapshot()');
  check(
    Boolean(flyoutStill1024.flyout),
    'A-13d',
    '1024：菜单 Esc 后浮窗仍在（只消费一层）',
    { flyout: Boolean(flyoutStill1024.flyout) },
  );
  await evaluate('window.__ZXQA__.scrollBody(500)');
  await new Promise((resolve) => setTimeout(resolve, 200));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    near(state.flyout.top, flyout1024.top) &&
      near(state.flyout.right, flyout1024.right),
    'A-13b',
    '1024：正文滚动 500px 后浮窗 top/right 不偏移',
    { before: flyout1024, after: state.flyout },
  );

  await setViewport(853, 900, 1.5);
  await waitFor(
    `window.innerWidth === 853 && document.querySelector('.kn-rail') === null`,
    '150% 缩放视口（右栏隐藏）',
  );
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    state.flyoutPosition === 'fixed' &&
      near(state.flyout.right, state.innerWidth) &&
      near(state.flyout.top, 0),
    'A-14',
    '150% 缩放（853 CSS px）：右栏隐藏，浮窗退化为贴右缘 sheet',
    { flyout: state.flyout, innerWidth: state.innerWidth },
  );

  // 900：右栏隐藏，工具抽屉进入 sheet，Esc 关闭后回焦。
  await setViewport(900, 700);
  await waitFor(
    `window.innerWidth === 900 && document.querySelector('.kn-rail') === null`,
    '900 右栏隐藏',
  );
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    state.flyoutPosition === 'fixed' &&
      near(state.flyout.right, state.innerWidth) &&
      near(state.flyout.top, 0) &&
      state.scrollWidth <= state.innerWidth,
    'A-15',
    '900：sheet 贴视口右缘/顶部，无横向滚动',
    { flyout: state.flyout, scrollWidth: state.scrollWidth },
  );
  await pressEscape();
  await waitFor('window.__ZXQA__.flyout() === null', '900 sheet Esc 关闭');
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    state.active.label === '工具' && state.expanded === 'false',
    'A-16',
    '900：Esc 关闭 sheet 后焦点回「工具」，未展开',
    { active: state.active, expanded: state.expanded },
  );
  await screenshot('zx8-qa-01-900-sheet.png');

  // 390：抽屉 -> sheet；贴右缘且无横向滚动。
  await setViewport(390, 844);
  await waitFor(
    `window.innerWidth === 390 && document.querySelector('.kn-rail') === null`,
    '390 右栏隐藏',
  );
  await waitFor(
    `document.querySelector('.kn-cmd-tools') !== null`,
    '390 工具入口出现',
  );
  await evaluate('window.__ZXQA__.tools().click(); true');
  await waitFor('Boolean(window.__ZXQA__.drawer())', '390 工具抽屉打开');
  await evaluate(`window.__ZXQA__.openFromDrawer('大纲'); true`);
  await waitFor('window.__ZXQA__.flyout() !== null', '390 sheet 打开');
  await new Promise((resolve) => setTimeout(resolve, 220));
  state = await evaluate('window.__ZXQA__.snapshot()');
  const sheet390 = state.flyout;
  await evaluate('window.__ZXQA__.scrollBody(500)');
  await new Promise((resolve) => setTimeout(resolve, 200));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    near(state.flyout.right, state.innerWidth) &&
      near(state.flyout.top, sheet390.top) &&
      near(state.flyout.right, sheet390.right) &&
      state.flyout.width <= 390 * 0.92 + 1 &&
      state.scrollWidth <= state.innerWidth &&
      state.drawer === false,
    'A-17',
    '390：sheet 贴右缘、≤92vw、无横向滚动、抽屉已收起',
    {
      flyout: state.flyout,
      innerWidth: state.innerWidth,
      scrollWidth: state.scrollWidth,
      drawer: state.drawer,
    },
  );
  await screenshot('zx8-qa-01-390-sheet.png');

  // 390 空间不足时菜单应关闭 sheet 再打开，不能两块浮层叠在一起。
  // sheet 不设焦点陷阱，键盘仍可到达被覆盖的命令栏按钮，用键盘路径验证。
  await evaluate(`(() => {
    const button = document.querySelector('[aria-label="更多文档操作"]');
    if (!button) return false;
    button.focus({ preventScroll: true });
    return document.activeElement === button;
  })()`);
  await pressEnter();
  await waitFor('window.__ZXQA__.menu() !== null', '390 菜单（键盘）打开');
  await new Promise((resolve) => setTimeout(resolve, 180));
  const menu390 = await evaluate('window.__ZXQA__.snapshot()');
  check(
    intersection(menu390.menu, menu390.flyout) === 0 &&
      (!menu390.flyout || menu390.menu.right <= menu390.flyout.left - 7),
    'A-17b',
    '390：菜单与 sheet 不重叠；空间不足时只保留菜单',
    {
      menu: menu390.menu,
      flyout: menu390.flyout,
      intersection: intersection(menu390.menu, menu390.flyout),
    },
  );
  await pressEscape();
  await waitFor('window.__ZXQA__.menu() === null', '390 菜单关闭');
  const afterMenu390 = await evaluate('window.__ZXQA__.snapshot()');
  if (afterMenu390.flyout) {
    await pressEscape();
    await waitFor('window.__ZXQA__.flyout() === null', '390 sheet 关闭');
  }

  // 390 下 ESC 展开 no-op：只提示，不进入展开。
  await pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 250));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    state.expanded === 'false' && (state.toast || '').includes('已无可收起列'),
    'A-18',
    '390：ESC 展开 no-op，保持三栏并提示已无可收起列',
    { expanded: state.expanded, toast: state.toast },
  );

  // ------------------------------------------------------------------
  // B. ESC 展开/还原（1280）
  // ------------------------------------------------------------------
  await setViewport(1280, 900);
  await waitFor(
    `window.innerWidth === 1280 && document.querySelector('.kn-rail') !== null`,
    '回到 1280',
  );
  await closeAnyMenuOrFlyout();
  await resetCollapsed();
  await evaluate('window.__ZXQA__.scrollBody(500)');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const focusedTree = await evaluate(
    `window.__ZXQA__.focus('.kn-tree-item') && window.__ZXQA__.active().inTree`,
  );
  const beforeExpand = await evaluate('window.__ZXQA__.snapshot()');
  check(
    focusedTree === true &&
      beforeExpand.expanded === 'false' &&
      beforeExpand.paperScrollTop > 300,
    'B-00',
    '展开前：焦点在目录、未展开、正文已滚动',
    {
      focusedTree,
      expanded: beforeExpand.expanded,
      scrollTop: beforeExpand.paperScrollTop,
      active: beforeExpand.active,
    },
  );

  // headless 下 smooth scroll 动画也可能被节流；关闭平滑滚动以断言逻辑终值。
  await evaluate(
    `document.querySelector('.zxe-body').style.scrollBehavior = 'auto'; true`,
  );
  await pressEscape();
  await finishAnimations();
  const expanded = await evaluate('window.__ZXQA__.snapshot()');
  check(
    expanded.expanded === 'true' &&
      expanded.workspaceClass?.includes('is-expanded') &&
      Boolean(expanded.cmdExpandedButton),
    'B-01',
    '第一次 ESC：进入展开，命令栏出现「还原目录与列表」',
    {
      expanded: expanded.expanded,
      workspaceClass: expanded.workspaceClass,
      cmdExpandedButton: expanded.cmdExpandedButton,
    },
  );
  check(
    expanded.tree.width === 0 &&
      expanded.list.width === 0 &&
      expanded.treeInert === true &&
      expanded.listInert === true &&
      expanded.treeAriaHidden === 'true' &&
      expanded.listVisibility !== 'visible',
    'B-02',
    '展开后左树/列表收为 0，inert + aria-hidden 防焦点落入',
    {
      tree: expanded.tree,
      list: expanded.list,
      treeInert: expanded.treeInert,
      listInert: expanded.listInert,
      treeAriaHidden: expanded.treeAriaHidden,
      listVisibility: expanded.listVisibility,
    },
  );
  check(
    expanded.paper.left < beforeExpand.paper.left - 300 &&
      expanded.paper.right === beforeExpand.paper.right &&
      near(expanded.paper.width, beforeExpand.paper.width + (beforeExpand.paper.left - expanded.paper.left)),
    'B-03',
    '展开后内容区向左扩展，右缘不越过右栏',
    { before: beforeExpand.paper, after: expanded.paper, rail: expanded.rail },
  );
  check(
    expanded.rail !== null &&
      expanded.railStyle?.opacity === '1' &&
      expanded.paperStyle?.opacity === '1' &&
      expanded.paperStyle?.filter === 'none' &&
      expanded.paperStyle?.pointerEvents !== 'none' &&
      expanded.scrims.length === 0 &&
      expanded.dialog === null,
    'B-04',
    '展开无 scrim/置灰：paper opacity=1 filter=none，无遮罩，右栏保留',
    {
      paperStyle: expanded.paperStyle,
      railOpacity: expanded.railStyle?.opacity,
      scrims: expanded.scrims,
      dialog: expanded.dialog,
    },
  );
  const expandMaxScroll = Math.max(
    0,
    (expanded.paperScrollHeight ?? 0) - (expanded.paperClientHeight ?? 0),
  );
  check(
    expanded.paperScrollTop ===
      Math.min(beforeExpand.paperScrollTop, expandMaxScroll),
    'B-05',
    '展开后正文滚动位置保持（内容重排后只可能被最大滚动值截断）',
    {
      before: beforeExpand.paperScrollTop,
      after: expanded.paperScrollTop,
      maxScroll: expandMaxScroll,
    },
  );
  check(
    expanded.active.isBody === false && expanded.active.inPaper === true,
    'B-06',
    '展开后焦点移到正文纸面，不落 body',
    { active: expanded.active },
  );
  await screenshot('zx8-qa-01-1280-expanded.png');

  await pressEscape();
  await finishAnimations();
  const restored = await evaluate('window.__ZXQA__.snapshot()');
  check(
    restored.expanded === 'false' &&
      restored.tree.width > 100 &&
      restored.list.width > 100 &&
      restored.treeAriaHidden === null &&
      restored.treeInert === false,
    'B-07',
    '第二次 ESC：还原左树/列表',
    {
      expanded: restored.expanded,
      tree: restored.tree,
      list: restored.list,
      treeAriaHidden: restored.treeAriaHidden,
      treeInert: restored.treeInert,
    },
  );
  check(
    near(restored.paper.left, beforeExpand.paper.left) &&
      near(restored.paper.width, beforeExpand.paper.width),
    'B-08',
    '还原后正文 rect 回到展开前',
    { before: beforeExpand.paper, after: restored.paper },
  );
  check(
    near(restored.paperScrollTop, beforeExpand.paperScrollTop, 2),
    'B-09',
    '还原后正文滚动位置保持',
    { before: beforeExpand.paperScrollTop, after: restored.paperScrollTop },
  );
  check(
    restored.active.isBody === false &&
      (restored.active.inTree || restored.active.inPaper),
    'B-10',
    '还原后焦点回到来源（目录项）或正文，不落 body',
    { active: restored.active },
  );
  await screenshot('zx8-qa-01-1280-restored.png');

  // 诊断：展开滚动跳变是否由浏览器 scroll anchoring 引起（不改产品代码）。
  await evaluate('window.__ZXQA__.scrollBody(500)');
  await new Promise((resolve) => setTimeout(resolve, 120));
  await evaluate(
    `document.querySelector('.zxe-body').style.overflowAnchor = 'none'; true`,
  );
  await pressEscape();
  await finishAnimations();
  const anchorOff = await evaluate('window.__ZXQA__.snapshot()');
  console.log('[DIAG overflow-anchor:none]', JSON.stringify({
    before: 500,
    after: anchorOff.paperScrollTop,
    maxScroll: (anchorOff.paperScrollHeight ?? 0) - (anchorOff.paperClientHeight ?? 0),
  }));
  await pressEscape();
  await finishAnimations();
  await evaluate(
    `document.querySelector('.zxe-body').style.overflowAnchor = ''; window.__ZXQA__.scrollBody(500); true`,
  );

  // 快速连按：2 次应回到未展开，3 次应进入展开（不被 repeat 吞掉）。
  await pressEscape();
  await pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const rapidTwo = await evaluate('window.__ZXQA__.snapshot()');
  check(
    rapidTwo.expanded === 'false' && rapidTwo.active.isBody === false,
    'B-11',
    '快速连按 2 次 ESC：回到未展开且焦点不落 body',
    { expanded: rapidTwo.expanded, active: rapidTwo.active },
  );
  await pressEscape();
  await pressEscape();
  await pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const rapidThree = await evaluate('window.__ZXQA__.snapshot()');
  check(
    rapidThree.expanded === 'true',
    'B-12',
    '快速连按 3 次 ESC：最终为展开',
    { expanded: rapidThree.expanded },
  );
  await pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 长按 repeat：带 autoRepeat 的 keyDown 不得切换。
  await pressEscape({ autoRepeat: true });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const repeated = await evaluate('window.__ZXQA__.snapshot()');
  check(
    repeated.expanded === 'false',
    'B-13',
    '长按 repeat 的 ESC 被忽略，不展开',
    { expanded: repeated.expanded },
  );

  // IME 组合态：合成 KeyboardEvent(isComposing=true) 不得展开。
  await evaluate(`(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27,
      isComposing: true, bubbles: true, cancelable: true,
    });
    event.isComposing = true;
    window.dispatchEvent(event);
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const composing = await evaluate('window.__ZXQA__.snapshot()');
  check(
    composing.expanded === 'false',
    'B-14',
    'IME 组合态 ESC 被忽略，不展开（合成事件模拟）',
    { expanded: composing.expanded },
  );

  // ------------------------------------------------------------------
  // C. ESC 冲突
  // ------------------------------------------------------------------
  await resetCollapsed();

  // C-01 标题输入框
  await evaluate('window.__ZXQA__.focus(".kn-title")');
  const titleFocused = await evaluate(
    `document.activeElement === document.querySelector('.kn-title')`,
  );
  await pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 220));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    titleFocused === true &&
      state.expanded === 'false' &&
      state.active.tag === 'INPUT' &&
      state.active.cls.includes('kn-title'),
    'C-01',
    '标题输入框内 ESC：不展开，焦点留在输入框',
    { expanded: state.expanded, active: state.active },
  );

  // C-02 contenteditable 正文
  const paraFocused = await evaluate(
    `(() => {
      const para = document.querySelector('.zxe-body [contenteditable="true"]');
      if (!para) return false;
      para.focus({ preventScroll: true });
      return document.activeElement === para;
    })()`,
  );
  await pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 220));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    paraFocused === true && state.expanded === 'false',
    'C-02',
    '正文 contenteditable 内 ESC：不展开',
    { paraFocused, expanded: state.expanded, active: state.active },
  );

  // C-03 公式 textarea
  const formulaReady = await evaluate(
    `(() => {
      const preview = document.querySelector('.zxe-formula-preview');
      if (!preview) return false;
      preview.click();
      return true;
    })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 220));
  const formulaFocused = await evaluate(
    `(() => {
      const input = document.querySelector('.zxe-formula-input');
      if (!input) return false;
      input.focus({ preventScroll: true });
      return document.activeElement === input;
    })()`,
  );
  await pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 220));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    formulaReady === true &&
      formulaFocused === true &&
      state.expanded === 'false',
    'C-03',
    '公式编辑器内 ESC：不展开（保留公式编辑退出语义）',
    { formulaReady, formulaFocused, expanded: state.expanded, active: state.active },
  );

  // C-04 右栏浮窗：Esc 关闭并回焦触发按钮
  await evaluate(`window.__ZXQA__.openTool('outline'); true`);
  await waitFor('window.__ZXQA__.flyout() !== null', '大纲浮窗打开');
  await new Promise((resolve) => setTimeout(resolve, 180));
  await pressEscape();
  await waitFor('window.__ZXQA__.flyout() === null', '浮窗 Esc 关闭');
  await new Promise((resolve) => setTimeout(resolve, 160));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    state.expanded === 'false' &&
      state.active.label === '大纲' &&
      state.active.cls.includes('is-active') === false,
    'C-04',
    '浮窗 ESC：关闭并回焦「大纲」按钮，不展开',
    { expanded: state.expanded, active: state.active },
  );

  // C-05 浮窗 + 菜单：第一次 Esc 只关菜单，第二次关浮窗
  await evaluate(`window.__ZXQA__.openTool('outline'); true`);
  await waitFor('window.__ZXQA__.flyout() !== null', '浮窗再次打开');
  await evaluate('window.__ZXQA__.openMore(); true');
  await waitFor('window.__ZXQA__.menu() !== null', '菜单再次打开');
  await pressEscape();
  await waitFor('window.__ZXQA__.menu() === null', '菜单第一层关闭');
  state = await evaluate('window.__ZXQA__.snapshot()');
  const menuOnce = Boolean(state.flyout) && state.expanded === 'false';
  await pressEscape();
  await waitFor('window.__ZXQA__.flyout() === null', '浮窗第二层关闭');
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    menuOnce &&
      state.expanded === 'false' &&
      state.active.label === '大纲',
    'C-05',
    '浮窗+菜单：两次 ESC 逐层关菜单/浮窗，均不展开',
    { menuOnce, expanded: state.expanded, active: state.active },
  );

  // C-06 模态：更多 -> 快捷键与说明；Esc 只关模态
  await evaluate('window.__ZXQA__.openMore(); true');
  await waitFor('window.__ZXQA__.menu() !== null', '帮助菜单打开');
  const openedHelp = await evaluate(
    `window.__ZXQA__.clickMenuText('快捷键与说明')`,
  );
  await waitFor(
    `document.querySelector('[role="dialog"]') !== null`,
    '帮助模态打开',
  );
  await new Promise((resolve) => setTimeout(resolve, 160));
  await pressEscape();
  await waitFor(
    `document.querySelector('[role="dialog"]') === null`,
    '帮助模态 Esc 关闭',
  );
  await new Promise((resolve) => setTimeout(resolve, 220));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    openedHelp === true && state.expanded === 'false' && state.active.isBody === false,
    'C-06',
    '模态 ESC：只关模态、不展开，焦点不落 body',
    { openedHelp, expanded: state.expanded, active: state.active },
  );

  // C-07 ≤900 工具抽屉：Esc 只关抽屉
  // Chromium 的 Emulation.setDeviceMetricsOverride 在 1280→900 时偶发不派发
  // MediaQueryList change 事件；按 900 重新加载，等价于真实 900 窗口冷启动。
  await loadKnowledge(900, 700);
  await evaluate('window.__ZXQA__.tools().click(); true');
  await waitFor('Boolean(window.__ZXQA__.drawer())', '工具抽屉打开');
  await pressEscape();
  await waitFor('!window.__ZXQA__.drawer()', '工具抽屉 Esc 关闭');
  await new Promise((resolve) => setTimeout(resolve, 220));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    state.expanded === 'false' &&
      state.active.label === '工具' &&
      state.toast === null,
    'C-07',
    '工具抽屉 ESC：只关抽屉、回焦「工具」、不展开',
    { expanded: state.expanded, active: state.active, toast: state.toast },
  );

  // 900 档展开：收 238px 列表，不进入全屏。
  await pressEscape();
  await finishAnimations();
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    state.expanded === 'true' &&
      state.list.width === 0 &&
      state.rail === null &&
      state.scrims.length === 0,
    'C-08',
    '900：ESC 展开收列表、右栏仍隐藏、无遮罩',
    {
      expanded: state.expanded,
      list: state.list,
      listVisibility: state.listVisibility,
      rail: state.rail,
      scrims: state.scrims,
      grid: await evaluate(
        `getComputedStyle(document.querySelector('.kn-workspace')).gridTemplateColumns`,
      ),
    },
  );
  await pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 300));

  // C-09 沉浸阅读：Esc 退出且不进入展开
  await loadKnowledge(1280, 900);
  await resetCollapsed();
  await evaluate(`window.__ZXQA__.openTool('immersive'); true`);
  await waitFor('window.__ZXQA__.snapshot().immersive === true', '进入沉浸阅读');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await pressEscape();
  await waitFor('window.__ZXQA__.snapshot().immersive === false', '退出沉浸阅读');
  await new Promise((resolve) => setTimeout(resolve, 300));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    state.immersive === false && state.expanded === 'false',
    'C-09',
    '沉浸阅读 ESC：退出沉浸且不进入展开',
    { immersive: state.immersive, expanded: state.expanded, active: state.active },
  );

  // C-10 沉浸前已展开：Esc 退出后恢复展开，第二次 Esc 才还原
  await resetCollapsed();
  await pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 350));
  const beforeImmersive = await evaluate('window.__ZXQA__.snapshot()');
  await evaluate(`window.__ZXQA__.openTool('immersive'); true`);
  await waitFor('window.__ZXQA__.snapshot().immersive === true', '展开态进入沉浸');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const inImmersive = await evaluate('window.__ZXQA__.snapshot()');
  await pressEscape();
  await waitFor('window.__ZXQA__.snapshot().immersive === false', '展开态退出沉浸');
  await new Promise((resolve) => setTimeout(resolve, 350));
  const afterImmersive = await evaluate('window.__ZXQA__.snapshot()');
  check(
    beforeImmersive.expanded === 'true' &&
      inImmersive.expanded === 'false' &&
      afterImmersive.expanded === 'true',
    'C-10',
    '展开态进沉浸再 ESC：恢复展开（不把恢复误当第二次展开）',
    {
      before: beforeImmersive.expanded,
      inImmersive: inImmersive.expanded,
      after: afterImmersive.expanded,
    },
  );
  await pressEscape();
  await new Promise((resolve) => setTimeout(resolve, 300));
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    state.expanded === 'false',
    'C-11',
    '沉浸恢复展开后，再按 ESC 才还原',
    { expanded: state.expanded },
  );

  // C-12 专注模式：Esc 退出专注且不展开
  await resetCollapsed();
  await evaluate(`window.__ZXQA__.openTool('focus'); true`);
  await waitFor('window.__ZXQA__.snapshot().focusMode === true', '进入专注');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await pressEscape();
  await waitFor('window.__ZXQA__.snapshot().focusMode === false', '退出专注');
  await finishAnimations();
  state = await evaluate('window.__ZXQA__.snapshot()');
  check(
    state.focusMode === false && state.expanded === 'false',
    'C-12',
    '专注模式 ESC：退出专注且不进入展开',
    { focusMode: state.focusMode, expanded: state.expanded, active: state.active },
  );

  // C-13 展开态 + 面板：第一次 ESC 关面板，第二次才还原。
  await resetCollapsed();
  await pressEscape();
  await finishAnimations();
  const expandedBeforePanel = await evaluate('window.__ZXQA__.snapshot()');
  await evaluate(`window.__ZXQA__.openTool('outline'); true`);
  await waitFor('window.__ZXQA__.flyout() !== null', '展开态打开面板');
  await pressEscape();
  await waitFor('window.__ZXQA__.flyout() === null', '展开态面板 Esc 关闭');
  const panelClosed = await evaluate('window.__ZXQA__.snapshot()');
  await pressEscape();
  await finishAnimations();
  const expandedClosed = await evaluate('window.__ZXQA__.snapshot()');
  check(
    expandedBeforePanel.expanded === 'true' &&
      panelClosed.expanded === 'true' &&
      panelClosed.active.label === '大纲' &&
      expandedClosed.expanded === 'false',
    'C-13',
    '展开态 + 面板：两次 ESC 逐层关面板/还原，不一次收两层',
    {
      before: expandedBeforePanel.expanded,
      afterPanel: panelClosed.expanded,
      afterSecond: expandedClosed.expanded,
      activeAfterPanel: panelClosed.active,
    },
  );

  check(
    consoleErrors.length === 0 && pageExceptions.length === 0,
    'D-00',
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
        viewport: await evaluate('({ width: window.innerWidth, height: window.innerHeight })').catch(() => null),
        userAgent: await evaluate('navigator.userAgent').catch(() => null),
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
