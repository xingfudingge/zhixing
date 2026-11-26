/**
 * AUD-017 浏览器实测：F-035 响应式断点（1024 / 900 / 768 / 390）。
 *
 * 覆盖卡面要求的 4 视口 × 4 页面 = 16 个组合：
 *   knowledge（知识工作区，含笔记列表/编辑器）、board（独立画板）、
 *   settings（设置 · 外观与阅读）、table（笔记正文中的表格块）。
 *
 * 关于「表格页面」的口径（重要）：
 *   正式 app 与原型都没有独立的「表格」路由/页面。产品里的表格只有两处：
 *   ① 笔记块编辑器的 `table` 块（`app/src/features/editor/blocks/TableBlock.tsx`）；
 *   ② 日历月视图的 `role="grid"` 表格（`MonthView.tsx:63`）。
 *   本卡按 ① 验收：进入知识页并打开一篇含 3×3 表格块的笔记，把表格滚到
 *   视口内截图，再断言页面级横向溢出与表格自身可用性（单元格可点、行列
 *   按钮可见可点）。② 属于日历页面，不在本卡「知识库/画板/设置/表格」
 *   四页范围内，未验收。该口径在报告中显式写明，避免把「不存在的页面」
 *   写成通过。
 *
 * 每个组合采集：
 *   * 截图 `tests/evidence/aud017/<width>-<page>.png`；
 *   * `document.documentElement.scrollWidth` vs `clientWidth`（卡面断言）
 *     以及 body 的同一对比；
 *   * 视口内可见元素的越界清单（区分「被自身的横向滚动容器裁剪」与
 *     「真的把文档撑宽」）；
 *   * 关键控件命中测试（elementFromPoint 中心点是否回到该控件）——
 *     覆盖「按钮不可点」；
 *   * 页面特有的可用性探针（知识列表是否隐藏/是否有返回列表入口、画板
 *     检查器是否覆盖画布且无法关闭、设置是否为单列、表格单元格是否可点）。
 *
 * 另外补三项纪律检查（卡面 out-of-scope 之外的通用纪律，仅做最小覆盖）：
 *   * 空数据：390 下知识库无笔记、画板无对象，空态不得横向溢出；
 *   * 刷新持久化：390 下刷新后页面仍渲染、无溢出、无控制台报错；
 *   * 快速连点：390 下设置分组导航/知识工具栏连续点击，不产生异常。
 *
 * 边界（不写成「真机通过」）：
 *   * Tauri IPC 由 `tests/harness/fakeTauri.ts` 的内存命令路由替代，并按命令
 *     写 localStorage，使刷新后仍读同一份数据；产品代码与构建未改。
 *   * 视口用 CDP `Emulation.setDeviceMetricsOverride` 覆盖，不是真实窗口缩放，
 *     也不是真实移动设备；没有触控手势、软键盘、iOS/Android WebView 验证。
 *   * Headless Chrome 字体/缩放与桌面 WebView 可能有细微差异。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/aud017-browser.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/aud017');
const FAKE_BUNDLE = '/tmp/zx-aud017-fake.js';
const PORT = 8905;
const DEBUG_PORT = 9227;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DB_KEY = 'zx_aud017_db';
const EMPTY_KEY = 'zx_aud017_empty';

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
  console.log(`[aud017] ${line}`);
}

function record(meta, verdict, actual, evidence) {
  results.push({
    id: meta.id,
    feature: meta.feature,
    name: meta.name,
    viewport: meta.viewport ?? null,
    page: meta.page ?? null,
    expected: meta.expected,
    actual,
    verdict,
    evidence: evidence ? `tests/evidence/aud017/${evidence}` : null,
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

const userDataDir = `/tmp/zx-chrome-aud017-${Date.now()}`;
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

// ---------------------------------------------------------------------------
// 真实鼠标（CDP Input）：用于验证「不可点 / 被遮挡」不是只看坐标推断
// ---------------------------------------------------------------------------

async function clickAt(x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: px,
    y: py,
    button: 'none',
    buttons: 0,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: px,
    y: py,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: px,
    y: py,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await sleep(180);
}

/** 元素中心点真实点击；返回点击坐标与命中的元素描述。 */
async function clickElement(selector) {
  const point = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const top = document.elementFromPoint(x, y);
    return {
      x,
      y,
      hitBy: top
        ? {
            tag: top.tagName.toLowerCase(),
            cls: typeof top.className === 'string' ? top.className : '',
            text: (top.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
          }
        : null,
    };
  })()`);
  if (!point) throw new Error(`找不到元素：${selector}`);
  await clickAt(point.x, point.y);
  return point;
}

/** 真实鼠标拖动（按下 → 多步移动 → 松开），用于画布对象移动。 */
async function dragFromTo(from, to, steps = 10) {
  const x1 = Math.round(from.x);
  const y1 = Math.round(from.y);
  const x2 = Math.round(to.x);
  const y2 = Math.round(to.y);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: x1,
    y: y1,
    button: 'none',
    buttons: 0,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: x1,
    y: y1,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps;
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x1 + (x2 - x1) * ratio),
      y: Math.round(y1 + (y2 - y1) * ratio),
      button: 'left',
      buttons: 1,
    });
    await sleep(16);
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: x2,
    y: y2,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await sleep(200);
}

async function typeText(text) {
  await send('Input.insertText', { text });
  await sleep(160);
}

// ---------------------------------------------------------------------------
// 注入：fakeTauri + 断点探针
// ---------------------------------------------------------------------------

/**
 * 表格场景：笔记正文里放一张 3×3 表格，列头与单元格都有中文内容，
 * 让「表格宽度」在窄视口下真的有压力，而不是空表恰好放得下。
 */
const TABLE_NOTE_BODY = `
<h2>季度复盘 · 表格验收</h2>
<p>这张表用于 F-035 断点验收：表格在窄屏必须留在页面内，不把整页撑宽。</p>
<table>
  <tbody>
    <tr><th>目标</th><th>负责人</th><th>截止日期</th></tr>
    <tr><td>完成响应式验收</td><td>知行 QA</td><td>2026-10-27</td></tr>
    <tr><td>补齐 1024/900/768/390 截图</td><td>知行 QA</td><td>2026-10-28</td></tr>
  </tbody>
</table>
<p>表格之后仍要有正文，便于验证滚动位置与阅读宽度。</p>
`.trim();

const BOARD_SEED = {
  board: {
    id: 'board-aud017',
    spaceId: 'personal',
    noteId: 'note-welcome',
    title: 'AUD-017 断点画板',
    background: 'dot',
    snapshot: { version: 1, nodeCount: 4, edgeCount: 1 },
    thumbnailKey: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  },
  nodes: [
    {
      id: 'node-a',
      boardId: 'board-aud017',
      nodeType: 'process',
      x: 140,
      y: 160,
      width: 190,
      height: 66,
      rotation: 0,
      zIndex: 0,
      text: '收集需求',
      payload: { style: { fill: '#ffffff', stroke: '#cbd6e2' }, locked: false },
      createdAt: '2026-10-01T00:00:01.000Z',
      updatedAt: '2026-10-01T00:00:01.000Z',
      deletedAt: null,
      version: 1,
    },
    {
      id: 'node-b',
      boardId: 'board-aud017',
      nodeType: 'decision',
      x: 470,
      y: 300,
      width: 180,
      height: 96,
      rotation: 0,
      zIndex: 1,
      text: '是否通过？',
      payload: { style: { fill: '#fff8e9', stroke: '#e5c477' }, locked: false },
      createdAt: '2026-10-01T00:00:02.000Z',
      updatedAt: '2026-10-01T00:00:02.000Z',
      deletedAt: null,
      version: 1,
    },
    {
      id: 'node-c',
      boardId: 'board-aud017',
      nodeType: 'sticky',
      x: 820,
      y: 180,
      width: 180,
      height: 120,
      rotation: 0,
      zIndex: 2,
      text: '窄屏也要能拖动与缩放',
      payload: { style: { fill: '#fff7d9', stroke: '#e8d77a' }, locked: false },
      createdAt: '2026-10-01T00:00:03.000Z',
      updatedAt: '2026-10-01T00:00:03.000Z',
      deletedAt: null,
      version: 1,
    },
    {
      id: 'node-d',
      boardId: 'board-aud017',
      nodeType: 'round',
      x: 470,
      y: 560,
      width: 180,
      height: 66,
      rotation: 0,
      zIndex: 3,
      text: '结束',
      payload: { style: { fill: '#e8eefb', stroke: '#9bbca5' }, locked: false },
      createdAt: '2026-10-01T00:00:04.000Z',
      updatedAt: '2026-10-01T00:00:04.000Z',
      deletedAt: null,
      version: 1,
    },
  ],
  edges: [
    {
      id: 'edge-ab',
      boardId: 'board-aud017',
      fromNodeId: 'node-a',
      toNodeId: 'node-b',
      label: '下一步',
      style: {
        routing: 'straight',
        arrow: 'end',
        color: '#93a3b8',
        width: 1.5,
        dashed: false,
        fromSide: 'r',
        toSide: 'l',
      },
      createdAt: '2026-10-01T00:00:06.000Z',
      updatedAt: '2026-10-01T00:00:06.000Z',
      deletedAt: null,
      version: 1,
    },
  ],
};

const injection = `(() => {
  let raw = null;
  let emptyKeys = [];
  try {
    raw = localStorage.getItem(${JSON.stringify(DB_KEY)});
    emptyKeys = JSON.parse(localStorage.getItem(${JSON.stringify(EMPTY_KEY)}) || '[]');
    if (!Array.isArray(emptyKeys)) emptyKeys = [];
  } catch (error) {}

  __ZX_FAKE_BUNDLE__
  const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const all = (selector) => Array.from(document.querySelectorAll(selector));

  try {
    const world = ZXFake.createFakeWorld();
    if (raw) {
      const saved = JSON.parse(raw);
      for (const [key, value] of Object.entries(saved)) {
        if (Array.isArray(value) && Array.isArray(world.db[key])) {
          world.db[key] = value;
        }
      }
    } else {
      // 首次打开：表格场景 + 断点画板。
      const tableNote = world.db.notes.find((note) => note.id === 'note-welcome');
      if (tableNote) {
        tableNote.body = ${JSON.stringify(TABLE_NOTE_BODY)};
        tableNote.title = '响应式表格验收';
      }
      const seed = ${JSON.stringify(BOARD_SEED)};
      world.db.boards = [JSON.parse(JSON.stringify(seed.board))];
      world.db.nodes = JSON.parse(JSON.stringify(seed.nodes));
      world.db.edges = JSON.parse(JSON.stringify(seed.edges));
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

    // ---- 几何探针 ----
    function visible(el) {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0.5 && rect.height > 0.5;
    }

    function describe(el) {
      if (!el) return null;
      const parts = [el.tagName.toLowerCase()];
      if (el.id) parts.push('#' + el.id);
      if (el.className && typeof el.className === 'string') {
        parts.push('.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.'));
      }
      const text = norm(el.textContent).slice(0, 40);
      return { selector: parts.join(''), text };
    }

    function rectOf(el) {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        left: Math.round(rect.left * 10) / 10,
        top: Math.round(rect.top * 10) / 10,
        right: Math.round(rect.right * 10) / 10,
        bottom: Math.round(rect.bottom * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      };
    }

    function overflowXAncestor(el) {
      let node = el.parentElement;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (
          (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
          node.scrollWidth > node.clientWidth + 1
        ) {
          return node;
        }
        node = node.parentElement;
      }
      return null;
    }

    function measure() {
      const doc = document.documentElement;
      const body = document.body;
      const width = window.innerWidth;
      const offenders = [];
      const clipped = [];
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        if (!visible(el)) continue;
        const rect = el.getBoundingClientRect();
        const outside = rect.right > width + 1 || rect.left < -1;
        if (!outside) continue;
        const clip = overflowXAncestor(el);
        const info = {
          ...describe(el),
          rect: rectOf(el),
          clippedBy: clip ? describe(clip) : null,
        };
        if (clip) {
          clipped.push(info);
        } else if (offenders.length < 12) {
          offenders.push(info);
        }
      }
      const scrollers = [];
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const style = getComputedStyle(el);
        if (
          style.overflowX !== 'auto' &&
          style.overflowX !== 'scroll'
        ) {
          continue;
        }
        if (!visible(el)) continue;
        if (el.scrollWidth > el.clientWidth + 1) {
          scrollers.push({
            ...describe(el),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            rect: rectOf(el),
          });
        }
      }
      return {
        innerWidth: width,
        docScrollWidth: doc.scrollWidth,
        docClientWidth: doc.clientWidth,
        bodyScrollWidth: body.scrollWidth,
        bodyClientWidth: body.clientWidth,
        hasHorizontalOverflow:
          doc.scrollWidth > doc.clientWidth ||
          body.scrollWidth > body.clientWidth,
        offenders,
        clipped,
        clippedCount: clipped.length,
        scrollers,
      };
    }

    function hitTest(selector) {
      const el = document.querySelector(selector);
      if (!el) return { found: false, selector };
      if (!visible(el)) {
        return { found: true, visible: false, selector };
      }
      const rect = el.getBoundingClientRect();
      if (
        rect.left < 0 ||
        rect.top < 0 ||
        rect.right > window.innerWidth ||
        rect.bottom > window.innerHeight
      ) {
        return {
          found: true,
          visible: true,
          inViewport: false,
          rect: rectOf(el),
          selector,
        };
      }
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const top = document.elementFromPoint(x, y);
      return {
        found: true,
        visible: true,
        inViewport: true,
        hit: top === el || (top ? el.contains(top) : false),
        hitBy: describe(top),
        rect: rectOf(el),
        selector,
      };
    }

    function pageInfo(page) {
      const info = { page, width: window.innerWidth, height: window.innerHeight };
      info.measure = measure();
      info.bodyText = norm(document.body.innerText).slice(0, 160);
      if (page === 'knowledge' || page === 'table') {
        const list = document.querySelector('.kn-list');
        const tree = document.querySelector('.kn-tree');
        const rail = document.querySelector('.kn-rail');
        const editor = document.querySelector('.kn-editor');
        const backToList = all('button, a')
          .filter((el) => visible(el))
          .filter((el) => /返回列表|笔记列表|回到列表/.test(norm(el.textContent) + ' ' + (el.getAttribute('aria-label') || '')))
          .map(describe);
        info.knowledge = {
          listVisible: visible(list),
          listRect: rectOf(list),
          treeVisible: visible(tree),
          treeRect: rectOf(tree),
          railVisible: visible(rail),
          railRect: rectOf(rail),
          editorRect: rectOf(editor),
          backToListControls: backToList,
        };
        const wrap = document.querySelector('.zxe-table-wrap');
        if (page === 'table') {
          const cells = all('.zxe-table-cell');
          info.table = {
            wrapRect: rectOf(wrap),
            wrapScrollWidth: wrap ? wrap.scrollWidth : null,
            wrapClientWidth: wrap ? wrap.clientWidth : null,
            cellCount: cells.length,
            actionButtons: all('.zxe-table-actions button').map((button) => ({
              label: button.getAttribute('aria-label'),
              visible: visible(button),
            })),
          };
        }
      }
      if (page === 'board') {
        const inspector = document.querySelector('.bw-inspector');
        const stage = document.querySelector('.bw-stage');
        const canvas = document.querySelector('.bw-canvas');
        const inspectorRect = rectOf(inspector);
        const stageRect = rectOf(stage);
        let overlapRatio = 0;
        if (inspectorRect && stageRect) {
          const width =
            Math.min(inspectorRect.right, stageRect.right) -
            Math.max(inspectorRect.left, stageRect.left);
          const height =
            Math.min(inspectorRect.bottom, stageRect.bottom) -
            Math.max(inspectorRect.top, stageRect.top);
          const area = Math.max(0, width) * Math.max(0, height);
          overlapRatio = stageRect.width * stageRect.height
            ? Math.round((area / (stageRect.width * stageRect.height)) * 1000) / 1000
            : 0;
        }
        const dismiss = all('.bw-inspector button')
          .filter((el) => visible(el))
          .filter((el) =>
            /关闭|收起|×/.test(norm(el.textContent) + ' ' + (el.getAttribute('aria-label') || '')),
          )
          .map((el) => ({ label: el.getAttribute('aria-label'), text: norm(el.textContent) }));
        // 画布中心点是否被检查器挡住。
        let canvasCenterHit = null;
        if (stageRect && canvas) {
          const x = Math.round(stageRect.left + stageRect.width / 2);
          const y = Math.round(stageRect.top + stageRect.height / 2);
          const top = document.elementFromPoint(x, y);
          canvasCenterHit = {
            x,
            y,
            hit: top === canvas || (top ? canvas.contains(top) : false),
            hitBy: describe(top),
          };
        }
        info.board = {
          inspectorVisible: visible(inspector),
          inspectorRect,
          stageRect,
          overlapRatio,
          dismissControls: dismiss,
          canvasCenterHit,
          zoomLabel: norm(document.querySelector('.bw-zoom-value')?.textContent),
          statusText: norm(document.querySelector('.bw-status-text')?.textContent),
          railButtons: all('.bw-rail button').filter(visible).length,
          headRect: rectOf(document.querySelector('.bw-head')),
        };
      }
      if (page === 'settings') {
        const layout = document.querySelector('.settings-layout');
        const nav = document.querySelector('.settings-nav');
        const bodyArea = document.querySelector('.settings-body');
        const card = document.querySelector('.settings-card');
        const style = layout ? getComputedStyle(layout) : null;
        // 设置行内控件是否超出卡片（卡片自身不横向滚动时即为裁切）。
        const rowOverflow = [];
        for (const row of all('.settings-row')) {
          if (!visible(row)) continue;
          const rowRect = row.getBoundingClientRect();
          const cardRect = card?.getBoundingClientRect();
          if (cardRect && rowRect.right > cardRect.right + 1) {
            rowOverflow.push({ row: describe(row), rect: rectOf(row) });
          }
        }
        info.settings = {
          layoutColumns: style ? style.gridTemplateColumns : null,
          navScrollWidth: nav ? nav.scrollWidth : null,
          navClientWidth: nav ? nav.clientWidth : null,
          navHorizontalScroll:
            nav ? nav.scrollWidth > nav.clientWidth + 1 : null,
          navRect: rectOf(nav),
          bodyRect: rectOf(bodyArea),
          cardRect: rectOf(card),
          rowOverflow: rowOverflow.slice(0, 6),
          groupLinks: all('.settings-nav-link').length,
        };
      }
      return info;
    }

    window.__ZX017__ = {
      pageInfo,
      measure,
      hitTest,
      setEmptyKeys(keys) {
        localStorage.setItem(${JSON.stringify(EMPTY_KEY)}, JSON.stringify(keys));
        return true;
      },
      clearEmptyKeys() {
        localStorage.removeItem(${JSON.stringify(EMPTY_KEY)});
        return true;
      },
      clearSavedDb() {
        localStorage.removeItem(${JSON.stringify(DB_KEY)});
        localStorage.removeItem(${JSON.stringify(EMPTY_KEY)});
        return true;
      },
      clickSelector(selector) {
        const el = document.querySelector(selector);
        if (!el) throw new Error('找不到元素：' + selector);
        el.click();
        return true;
      },
      clickByLabel(label) {
        const el = all('[aria-label]').find(
          (node) => node.getAttribute('aria-label') === label,
        );
        if (!el) throw new Error('找不到 aria-label：' + label);
        el.click();
        return true;
      },
      clickText(text, scope) {
        const root = scope ? document.querySelector(scope) : document;
        const el = all((scope || '') + ' button, ' + (scope || '') + ' a').find(
          (node) => norm(node.textContent) === text,
        );
        if (!el) throw new Error('找不到文本按钮：' + text);
        el.click();
        return true;
      },
      zoomLabel() {
        return norm(document.querySelector('.bw-zoom-value')?.textContent);
      },
      activeNav() {
        return norm(
          document.querySelector('.settings-nav-link.is-active')?.textContent,
        );
      },
      url() {
        return location.pathname + location.search;
      },
      noteListVisible() {
        const list = document.querySelector('.kn-list');
        return visible(list);
      },
      tableCellFocus() {
        const cell = document.querySelector('.zxe-table-cell');
        if (!cell) return null;
        cell.focus();
        return document.activeElement === cell;
      },
      /** 390 定向探针：窄屏下「还能不能切换笔记」「表格文字是否被裁切」。 */
      narrowProbes() {
        const result = {};
        // 1) 笔记切换入口：笔记列表行 / 目录树 / 任何“打开笔记”按钮。
        const switchEntries = all('[aria-label^="打开笔记"], .kn-note-row')
          .filter((el) => visible(el))
          .map(describe);
        const treeVisible = visible(document.querySelector('.kn-tree'));
        const listVisible = visible(document.querySelector('.kn-list'));
        const newNote = all('button, [role="button"]')
          .filter(visible)
          .filter((el) => /新建|＋/.test(norm(el.textContent) + (el.getAttribute('aria-label') || '')))
          .map(describe);
        result.knowledge = {
          treeVisible,
          listVisible,
          switchEntryCount: switchEntries.length,
          switchEntries: switchEntries.slice(0, 4),
          newNoteEntries: newNote.slice(0, 4),
          tabsVisible: visible(document.querySelector('.kn-tabs')),
          activeNoteTitle: norm(document.querySelector('.kn-paper h1, .kn-paper-title')?.textContent),
        };
        // 2) 表格：每个单元格的文字是否被裁切（input scrollWidth > clientWidth）。
        const cells = all('.zxe-table-cell').map((input) => ({
          value: input.value,
          scrollWidth: input.scrollWidth,
          clientWidth: input.clientWidth,
          clipped: input.scrollWidth > input.clientWidth + 1,
        }));
        result.table = {
          cells,
          clippedCount: cells.filter((cell) => cell.clipped).length,
          wrapScrollable: (() => {
            const wrap = document.querySelector('.zxe-table-wrap');
            return wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : null;
          })(),
        };
        // 3) 设置：分组导航里完整落在可视区内的分组数。
        const nav = document.querySelector('.settings-nav');
        const navRect = nav?.getBoundingClientRect();
        const links = all('.settings-nav-link');
        const fullyVisible = links.filter((link) => {
          const rect = link.getBoundingClientRect();
          if (!navRect) return false;
          return rect.left >= navRect.left - 1 && rect.right <= navRect.right + 1;
        });
        result.settings = {
          linkCount: links.length,
          fullyVisibleInNav: fullyVisible.length,
          visibleLabels: fullyVisible.map((link) => norm(link.textContent)),
          navScrollLeft: nav?.scrollLeft ?? null,
          navScrollWidth: nav?.scrollWidth ?? null,
          navClientWidth: nav?.clientWidth ?? null,
        };
        // 4) 画板：画布可见区域比例 + 选中/删除空选择是否安全。
        const stage = document.querySelector('.bw-stage');
        const inspector = document.querySelector('.bw-inspector');
        const stageRect = stage?.getBoundingClientRect();
        const inspectorRect = inspector?.getBoundingClientRect();
        let covered = 0;
        if (stageRect && inspectorRect) {
          const width =
            Math.min(stageRect.right, inspectorRect.right) -
            Math.max(stageRect.left, inspectorRect.left);
          covered = Math.max(0, width) / Math.max(1, stageRect.width);
        }
        result.board = {
          stageWidth: stageRect ? Math.round(stageRect.width) : null,
          visibleCanvasWidth:
            stageRect && inspectorRect
              ? Math.round(
                  Math.max(0, inspectorRect.left - stageRect.left) ||
                    Math.max(0, stageRect.right - inspectorRect.right),
                )
              : null,
          inspectorWidth: inspectorRect ? Math.round(inspectorRect.width) : null,
          coveredRatio: Math.round(covered * 1000) / 1000,
          inspectorHasDismiss: all('.bw-inspector button').some(
            (button) =>
              visible(button) &&
              /关闭|收起|×/.test(
                norm(button.textContent) + (button.getAttribute('aria-label') || ''),
              ),
          ),
          titleInputCovered: (() => {
            const input = document.querySelector('.bw-title-input');
            if (!input) return null;
            const rect = input.getBoundingClientRect();
            const top = document.elementFromPoint(
              Math.round(rect.left + rect.width / 2),
              Math.round(rect.top + rect.height / 2),
            );
            return !(top === input || (top && input.contains(top)));
          })(),
        };
        return result;
      },
      /** 画板：左键点画布可见条带，返回是否产生了选中。 */
      boardClickVisibleStrip() {
        const stage = document.querySelector('.bw-stage');
        const canvas = document.querySelector('.bw-canvas');
        if (!stage || !canvas) return { error: '画布不存在' };
        const stageRect = stage.getBoundingClientRect();
        const inspectorRect =
          document.querySelector('.bw-inspector')?.getBoundingClientRect() ?? null;
        const stripRight = inspectorRect ? inspectorRect.left : stageRect.right;
        const x = Math.round(stageRect.left + Math.max(10, (stripRight - stageRect.left) / 2));
        const y = Math.round(stageRect.top + stageRect.height / 2);
        return {
          x,
          y,
          stageRect: rectOf(stage),
          stripWidth: Math.round(stripRight - stageRect.left),
          hitBy: describe(document.elementFromPoint(x, y)),
        };
      },
      pressDelete() {
        const canvas = document.querySelector('.bw-canvas');
        if (canvas) canvas.focus();
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Delete',
            code: 'Delete',
            keyCode: 46,
            bubbles: true,
            metaKey: true,
          }),
        );
        return norm(document.querySelector('.bw-status-text')?.textContent);
      },
      boardCounts() {
        return norm(document.querySelector('.bw-counts')?.textContent);
      },
      /**
       * 复刻产品 fitViewport（模型同 app/src/features/board/model.ts:1052），
       * 给出对象中心的屏幕坐标，供 CDP 真实拖动使用。只读计算，不改视图。
       */
      boardDragPoints(boardId, padding = 80) {
        const canvas = document.querySelector('.bw-canvas');
        const rect = canvas?.getBoundingClientRect();
        if (!rect) return null;
        let saved = null;
        try {
          saved = JSON.parse(localStorage.getItem(${JSON.stringify(DB_KEY)}) || 'null');
        } catch (error) {
          saved = null;
        }
        const nodes = saved
          ? saved.nodes
              .filter(
                (row) => row.boardId === boardId && row.deletedAt === null,
              )
              .sort((a, b) => a.zIndex - b.zIndex)
          : [];
        if (nodes.length === 0) return null;
        const left = Math.min(...nodes.map((row) => row.x));
        const top = Math.min(...nodes.map((row) => row.y));
        const right = Math.max(...nodes.map((row) => row.x + row.width));
        const bottom = Math.max(...nodes.map((row) => row.y + row.height));
        const boundsWidth = Math.max(1, right - left);
        const boundsHeight = Math.max(1, bottom - top);
        const availableWidth = Math.max(60, rect.width - padding * 2);
        const availableHeight = Math.max(60, rect.height - padding * 2);
        const clampZoom = (value) =>
          Math.round(Math.min(2, Math.max(0.3, value)) * 100) / 100;
        const zoom = clampZoom(
          Math.min(
            availableWidth / boundsWidth,
            availableHeight / boundsHeight,
            1.2,
          ),
        );
        const view = {
          x: left + boundsWidth / 2 - rect.width / (2 * zoom),
          y: top + boundsHeight / 2 - rect.height / (2 * zoom),
          zoom,
        };
        const screenOf = (node) => ({
          x: Math.round(rect.left + (node.x + node.width / 2 - view.x) * zoom),
          y: Math.round(rect.top + (node.y + node.height / 2 - view.y) * zoom),
        });
        return {
          view,
          canvasRect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
          nodes: nodes.map((row) => {
            const screen = screenOf(row);
            return {
              id: row.id,
              x: row.x,
              y: row.y,
              text: row.text,
              screen,
              onScreen:
                screen.x >= rect.left &&
                screen.x <= rect.right &&
                screen.y >= rect.top &&
                screen.y <= rect.bottom,
            };
          }),
        };
      },
      savedNode(id) {
        try {
          const saved = JSON.parse(
            localStorage.getItem(${JSON.stringify(DB_KEY)}) || 'null',
          );
          const row = saved?.nodes.find((item) => item.id === id) || null;
          return row ? { id: row.id, x: row.x, y: row.y, text: row.text } : null;
        } catch (error) {
          return null;
        }
      },
      hitAtScreen(x, y) {
        const top = document.elementFromPoint(Math.round(x), Math.round(y));
        return {
          onCanvas: top?.tagName === 'CANVAS',
          hitBy: describe(top),
        };
      },
      /** 画板画布矩形与当前已落库对象（只读，用于算真实鼠标拖动坐标）。 */
      boardGeometry(boardId) {
        const canvas = document.querySelector('.bw-canvas');
        const rect = canvas?.getBoundingClientRect();
        let saved = null;
        try {
          saved = JSON.parse(localStorage.getItem(${JSON.stringify(DB_KEY)}) || 'null');
        } catch (error) {
          saved = null;
        }
        const nodes = saved
          ? saved.nodes
              .filter(
                (row) => row.boardId === boardId && row.deletedAt === null,
              )
              .sort((a, b) => a.zIndex - b.zIndex)
          : [];
        return {
          canvasRect: rect
            ? {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              }
            : null,
          canvasScroll: canvas
            ? { width: canvas.width, height: canvas.height }
            : null,
          nodes: nodes.map((row) => ({
            id: row.id,
            x: row.x,
            y: row.y,
            width: row.width,
            height: row.height,
            text: row.text,
          })),
          hitAt(point) {
            const top = document.elementFromPoint(
              Math.round(point.x),
              Math.round(point.y),
            );
            return {
              hit: top === canvas,
              hitBy: describe(top),
            };
          },
        };
      },
      /** ⌘K 全局搜索是否仍能在窄屏知识页打开另一篇笔记（作为「无返回列表」的替代通道）。 */
      async openSearch(query) {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            code: 'KeyK',
            keyCode: 75,
            metaKey: true,
            bubbles: true,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 350));
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return { opened: false };
        const input = dialog.querySelector('input[aria-label="搜索本机数据"]');
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        ).set;
        nativeSetter.call(input, query);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 520));
        const options = Array.from(dialog.querySelectorAll('[role="option"]'));
        return {
          opened: true,
          inputValue: input.value,
          optionCount: options.length,
          options: options.map((el) => norm(el.textContent).slice(0, 30)).slice(0, 6),
        };
      },
      closeSearch() {
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            bubbles: true,
          }),
        );
        return document.querySelector('[role="dialog"]') === null;
      },
      async searchOpensNote() {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            code: 'KeyK',
            keyCode: 75,
            metaKey: true,
            bubbles: true,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 350));
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return { opened: false };
        const input = dialog.querySelector('input[aria-label="搜索本机数据"]');
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        ).set;
        nativeSetter.call(input, '任务');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 520));
        const options = Array.from(dialog.querySelectorAll('[role="option"]'));
        const noteOption = options.find((el) =>
          /笔记|任务、笔记与日历/.test(el.textContent || ''),
        );
        if (!noteOption) {
          return {
            opened: true,
            optionCount: options.length,
            options: options.map((el) => norm(el.textContent).slice(0, 30)).slice(0, 6),
            clickedNote: false,
          };
        }
        noteOption.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
        const titleControl = document.querySelector(
          'input[aria-label="笔记标题"], .kn-paper h1',
        );
        return {
          opened: true,
          optionCount: options.length,
          clickedNote: true,
          url: location.pathname + location.search,
          title:
            titleControl instanceof HTMLInputElement
              ? titleControl.value
              : norm(titleControl?.textContent),
        };
      },
      /** 取空态卡片按钮的中心坐标，交给 CDP 真实点击。 */
      emptyBoardActionPoint(text) {
        const button = all('.bw-empty-card button').find(
          (el) => norm(el.textContent) === text,
        );
        if (!button) return null;
        const rect = button.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const top = document.elementFromPoint(x, y);
        return {
          x,
          y,
          hit: top === button || (top ? button.contains(top) : false),
          hitBy: describe(top),
          rect: rectOf(button),
        };
      },
      /** 空画板：空态卡片是否渲染、是否被检查器盖住。 */
      emptyBoardProbe() {
        const card = document.querySelector('.bw-empty-card');
        const cardRect = card?.getBoundingClientRect();
        const inspectorRect =
          document.querySelector('.bw-inspector')?.getBoundingClientRect() ?? null;
        let covered = 0;
        if (cardRect && inspectorRect) {
          const width =
            Math.min(cardRect.right, inspectorRect.right) -
            Math.max(cardRect.left, inspectorRect.left);
          const height =
            Math.min(cardRect.bottom, inspectorRect.bottom) -
            Math.max(cardRect.top, inspectorRect.top);
          covered =
            (Math.max(0, width) * Math.max(0, height)) /
            Math.max(1, cardRect.width * cardRect.height);
        }
        let hit = null;
        if (cardRect) {
          const x = Math.round(cardRect.left + cardRect.width / 2);
          const y = Math.round(cardRect.top + cardRect.height / 2);
          const top = document.elementFromPoint(x, y);
          hit = {
            hit: top === card || (top ? card.contains(top) : false),
            hitBy: describe(top),
          };
        }
        return {
          present: !!card,
          text: norm(card?.textContent).slice(0, 80),
          rect: rectOf(card),
          coveredRatio: Math.round(covered * 1000) / 1000,
          centerHit: hit,
          actions: all('.bw-empty-card button').map((button) => ({
            text: norm(button.textContent),
            visible: visible(button),
          })),
        };
      },
    };
  } catch (error) {
    window.__ZX_INIT_ERROR__ = String(error?.stack ?? error);
  }
})();`.replace('  __ZX_FAKE_BUNDLE__\n', () => fakeBundle);

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: injection });

const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 900, height: 700 },
  { width: 768, height: 700 },
  { width: 390, height: 844 },
];

const PAGES = [
  {
    id: 'knowledge',
    url: '/knowledge?note=note-welcome',
    ready:
      "document.querySelector('.kn-workspace') !== null && document.querySelector('.kn-note-row') !== null",
    label: '知识工作区',
  },
  {
    id: 'board',
    url: '/board/board-aud017',
    ready:
      "document.querySelector('.bw-canvas') !== null && (document.querySelector('.bw-save-state')?.textContent || '').includes('已保存')",
    label: '独立画板',
  },
  {
    id: 'settings',
    url: '/settings/appearance',
    ready:
      "document.querySelector('.settings-layout') !== null && document.querySelector('.settings-card') !== null",
    label: '设置 · 外观与阅读',
  },
  {
    id: 'table',
    url: '/knowledge?note=note-welcome',
    ready:
      "document.querySelector('.zxe-table') !== null && document.querySelector('.zxe-table-cell') !== null",
    label: '笔记正文表格块',
    prepare: `(async () => {
      const wrap = document.querySelector('.zxe-table-wrap');
      if (wrap) wrap.scrollIntoView({ block: 'center' });
      await new Promise((resolve) => setTimeout(resolve, 120));
      return true;
    })()`,
  },
];

async function setViewport(viewport) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(120);
}

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

function resetConsole() {
  consoleErrors.length = 0;
  consoleWarns.length = 0;
  pageExceptions.length = 0;
}

function collectConsole() {
  return {
    errors: [...consoleErrors],
    warnings: [...consoleWarns],
    exceptions: [...pageExceptions],
  };
}

/** 组合判定：溢出为硬失败；可用性问题单独列，不掩盖溢出结论。 */
async function runCombo(viewport, page) {
  const comboId = `F-035-${viewport.width}-${page.id}`;
  resetConsole();
  const meta = {
    id: comboId,
    feature: 'F-035 响应式断点',
    name: `${viewport.width}×${viewport.height} · ${page.label}`,
    viewport: `${viewport.width}x${viewport.height}`,
    page: page.id,
    expected:
      'document.documentElement.scrollWidth <= clientWidth；body 同样不溢出；关键控件可命中；控制台零报错',
  };
  const shot = `${viewport.width}-${page.id}.png`;
  try {
    await setViewport(viewport);
    await navigate(`http://127.0.0.1:${PORT}${page.url}`);
    await waitFor(page.ready, `${viewport.width} ${page.id} 就绪`, 20_000);
    if (page.prepare) {
      await evaluate(page.prepare);
    }
    await sleep(320);

    const info = await evaluate(`window.__ZX017__.pageInfo(${JSON.stringify(page.id)})`);
    const hits = {};
    if (page.id === 'knowledge' || page.id === 'table') {
      hits.tree = await evaluate("window.__ZX017__.hitTest('.kn-tree')");
      hits.rail = await evaluate("window.__ZX017__.hitTest('.kn-rail button')");
      hits.more = await evaluate(
        "window.__ZX017__.hitTest('.kn-more')",
      );
      hits.editor = await evaluate("window.__ZX017__.hitTest('.kn-editor')");
    }
    if (page.id === 'table') {
      hits.tableAddRow = await evaluate(
        "window.__ZX017__.hitTest('[aria-label=\"添加表格行\"]')",
      );
      hits.tableCell = await evaluate(
        "window.__ZX017__.hitTest('.zxe-table-cell')",
      );
      hits.cellFocus = await evaluate('window.__ZX017__.tableCellFocus()');
      // 真实点击第一个单元格，确认窄屏下表格可编辑（只验证焦点，不改内容，
      // 避免污染其它组合的截图与断言）。
      const cellPoint = await clickElement('.zxe-table-cell');
      const activeTag = await evaluate(
        "document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName",
      );
      const cellValue = await evaluate(
        "document.querySelector('.zxe-table-cell')?.value ?? null",
      );
      hits.tableCellClick = {
        point: cellPoint,
        active: activeTag,
        value: cellValue,
        editable: /第 1 行第 1 列/.test(String(activeTag)),
      };
      // 保留焦点环到截图：让 table 组合的证据截图与 knowledge 组合可区分。
      await sleep(160);
    }
    if (page.id === 'settings') {
      hits.navFirst = await evaluate(
        "window.__ZX017__.hitTest('.settings-nav-link')",
      );
      hits.themeDark = await evaluate(
        "window.__ZX017__.hitTest('[aria-label=\"主题\"] button')",
      );
      hits.card = await evaluate("window.__ZX017__.hitTest('.settings-card')");
    }
    if (page.id === 'board') {
      hits.zoomIn = await evaluate("window.__ZX017__.hitTest('[aria-label=\"放大\"]')");
      hits.railSelect = await evaluate(
        "window.__ZX017__.hitTest('[aria-label=\"选择与移动\"]')",
      );
      hits.title = await evaluate(
        "window.__ZX017__.hitTest('.bw-title-input')",
      );
      // 真实点一次放大，确认窄屏下缩放仍可操作。
      const before = await evaluate('window.__ZX017__.zoomLabel()');
      await evaluate('window.__ZX017__.clickByLabel("放大")');
      await sleep(220);
      const after = await evaluate('window.__ZX017__.zoomLabel()');
      info.board.zoomBefore = before;
      info.board.zoomAfter = after;
      info.board.zoomWorked = before !== after;
    }

    if (page.id === 'table') {
      const narrow = await evaluate('window.__ZX017__.narrowProbes()');
      info.table.cellClipping = {
        clippedCount: narrow.table.clippedCount,
        total: narrow.table.cells.length,
        samples: narrow.table.cells.filter((cell) => cell.clipped).slice(0, 4),
      };
      info.table.firstColumnWidth = await evaluate(
        "Math.round(document.querySelector('.zxe-table th, .zxe-table td')?.getBoundingClientRect().width ?? 0)",
      );
    }
    await screenshot(shot);

    const consoleState = collectConsole();
    const overflow = info.measure.hasHorizontalOverflow;
    const actual = {
      viewport: `${viewport.width}x${viewport.height}`,
      page: page.id,
      scrollWidth: info.measure.docScrollWidth,
      clientWidth: info.measure.docClientWidth,
      bodyScrollWidth: info.measure.bodyScrollWidth,
      bodyClientWidth: info.measure.bodyClientWidth,
      hasHorizontalOverflow: overflow,
      offenders: info.measure.offenders,
      clippedByScroller: info.measure.clippedCount,
      scrollers: info.measure.scrollers,
      hitTests: hits,
      knowledge: info.knowledge ?? null,
      board: info.board ?? null,
      settings: info.settings ?? null,
      table: info.table ?? null,
      console: consoleState,
    };

    const problems = [];
    if (overflow) problems.push('页面横向溢出');
    if (consoleState.errors.length > 0) problems.push(`控制台错误 ${consoleState.errors.length} 条`);
    if (consoleState.exceptions.length > 0) problems.push(`未捕获异常 ${consoleState.exceptions.length} 条`);
    for (const [key, hit] of Object.entries(hits)) {
      if (hit && hit.found && hit.visible && hit.inViewport && hit.hit === false) {
        problems.push(`控件被遮挡/不可点：${key}`);
      }
    }
    if (page.id === 'board' && actual.board?.zoomWorked === false) {
      problems.push('缩放按钮点击后百分比未变化');
    }
    if (page.id === 'table' && hits.cellFocus === false) {
      problems.push('表格单元格无法聚焦');
    }
    if (page.id === 'table' && hits.tableCellClick?.editable === false) {
      problems.push(
        `真实点击表格单元格未取得焦点（active=${hits.tableCellClick.active}）`,
      );
    }
    // PRD §3.6.19 验收 2 是编号验收标准（1024 → 知识目录隐藏），按标准判定。
    if (
      page.id === 'knowledge' &&
      viewport.width === 1024 &&
      actual.knowledge?.treeVisible
    ) {
      problems.push(
        'PRD §3.6.19 验收 2 未满足：1024px 知识目录应隐藏，实际目录树仍可见',
      );
    }

    // 可用性问题（不改变「无横向溢出」这一硬结论，但必须进报告）。
    const usability = [];
    if (page.id === 'knowledge' || page.id === 'table') {
      const knowledge = actual.knowledge;
      if (!knowledge.listVisible && knowledge.backToListControls.length === 0) {
        usability.push({
          issue: '笔记列表被隐藏且无「返回列表」入口，无法打开其它笔记（只能依赖已打开标签）',
          detail: {
            listVisible: knowledge.listVisible,
            treeVisible: knowledge.treeVisible,
            backToListControls: knowledge.backToListControls,
          },
        });
      }
      if (knowledge.treeVisible && viewport.width === 1024) {
        usability.push({
          issue:
            'PRD §3.6.19 验收 2 期望 1024 隐藏知识目录（笔记列表+编辑器可见）；实际目录树仍显示（app 的目录断点是 980px）',
          detail: {
            treeVisible: knowledge.treeVisible,
            treeWidth: knowledge.treeRect?.width ?? null,
            width: viewport.width,
          },
        });
      }
    }
    // 表格页与知识页共享同一布局，1024 目录问题只按 knowledge 组合计一次，
    // 表格组合仅在 usability 里重复引用，避免同一事实被计成两个缺陷。
    if (page.id === 'table' && actual.table?.cellClipping?.clippedCount > 0) {
      usability.push({
        issue: `表格单元格文字被裁切 ${actual.table.cellClipping.clippedCount}/${actual.table.cellClipping.total}（列宽固定为等分，内容溢出不可见）`,
        detail: {
          firstColumnWidth: actual.table.firstColumnWidth,
          samples: actual.table.cellClipping.samples,
        },
      });
    }
    if (page.id === 'settings' && actual.settings?.navHorizontalScroll) {
      usability.push({
        issue: '设置分组导航在单列布局下变成横向滚动条，末位分组（数据与备份/许可与设备）需横向滚动才能看到',
        detail: {
          navScrollWidth: actual.settings.navScrollWidth,
          navClientWidth: actual.settings.navClientWidth,
        },
      });
    }
    if (page.id === 'board') {
      if (actual.board?.inspectorVisible && actual.board.overlapRatio >= 0.3) {
        usability.push({
          issue: `画板检查器覆盖画布 ${Math.round(actual.board.overlapRatio * 100)}%，且无关闭入口`,
          detail: {
            overlapRatio: actual.board.overlapRatio,
            dismissControls: actual.board.dismissControls,
            stageWidth: actual.board.stageRect?.width,
            inspectorWidth: actual.board.inspectorRect?.width,
          },
        });
      }
      if (hits.title && hits.title.found && hits.title.hit === false) {
        usability.push({
          issue: '画板标题输入被顶栏「阅读/JSON/保存」按钮覆盖，窄屏下无法点中',
          detail: { rect: hits.title.rect, hitBy: hits.title.hitBy },
        });
      }
    }

    const verdict = problems.length === 0 ? 'PASS' : 'FAIL';
    record(meta, verdict, { ...actual, problems, usability }, shot);
    return { comboId, verdict, actual, problems, usability };
  } catch (error) {
    let failShot = shot.replace(/\.png$/, '-FAIL.png');
    try {
      await screenshot(failShot);
    } catch {
      failShot = null;
    }
    record(
      meta,
      'FAIL',
      {
        error: error?.message ?? String(error),
        console: collectConsole(),
      },
      failShot,
    );
    return {
      comboId,
      verdict: 'FAIL',
      actual: { error: error?.message ?? String(error) },
      problems: [error?.message ?? String(error)],
    };
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const combos = [];
try {
  note('视口与页面组合开始', {
    viewports: VIEWPORTS.map((item) => `${item.width}x${item.height}`),
    pages: PAGES.map((item) => item.id),
    total: VIEWPORTS.length * PAGES.length,
  });

  for (const viewport of VIEWPORTS) {
    for (const page of PAGES) {
      const result = await runCombo(viewport, page);
      combos.push(result);
    }
  }

  // ---- 补充 0：窄屏定向复现（真实鼠标点击，不只看坐标推断） ----
  resetConsole();
  {
    const meta = {
      id: 'F-035-390-board-repro',
      feature: 'F-035 响应式断点',
      name: '390×844 · 画板标题输入被顶栏按钮覆盖 + 检查器覆盖画布且无法关闭（真实点击复现）',
      viewport: '390x844',
      page: 'board',
      expected:
        '标题输入可聚焦并输入；检查器覆盖画布时有关闭入口；画布可见区可点选对象；控制台零报错',
    };
    const shot = '390-board-head-repro.png';
    try {
      await setViewport(VIEWPORTS[3]);
      await navigate(`http://127.0.0.1:${PORT}/board/board-aud017`);
      await waitFor(
        "document.querySelector('.bw-canvas') !== null && (document.querySelector('.bw-save-state')?.textContent || '').includes('已保存')",
        '画板就绪',
      );
      await sleep(320);

      const before = await evaluate(`(() => {
        const input = document.querySelector('.bw-title-input');
        const rect = input.getBoundingClientRect();
        const head = document.querySelector('.bw-head');
        const headRect = head.getBoundingClientRect();
        const buttons = Array.from(document.querySelectorAll('.bw-head-actions button, .bw-head-actions a'));
        const overlap = buttons
          .map((button) => ({ button, rect: button.getBoundingClientRect() }))
          .filter(({ rect: r }) =>
            r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top,
          )
          .map(({ button, rect: r }) => ({
            text: (button.textContent || '').replace(/\\s+/g, ' ').trim(),
            rect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) },
          }));
        return {
          title: input.value,
          titleRect: { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom) },
          headRect: { left: Math.round(headRect.left), top: Math.round(headRect.top), right: Math.round(headRect.right), bottom: Math.round(headRect.bottom) },
          headScrollWidth: head.scrollWidth,
          headClientWidth: head.clientWidth,
          overlappingButtons: overlap,
          titleWidth: Math.round(rect.width),
        };
      })()`);

      // 真实点击标题中心并输入；若被按钮压住，焦点会跑到按钮上。
      const click = await clickElement('.bw-title-input');
      const activeAfterClick = await evaluate(
        "(() => { const el = document.activeElement; return el ? { tag: el.tagName.toLowerCase(), cls: typeof el.className === 'string' ? el.className : '', text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 20) } : null; })()",
      );
      await typeText('X');
      const titleAfter = await evaluate(
        "document.querySelector('.bw-title-input').value",
      );

      // 检查器是否覆盖画布、是否有可关闭入口；点画布可见条带。
      const probes = await evaluate('window.__ZX017__.narrowProbes()');
      const strip = await evaluate('window.__ZX017__.boardClickVisibleStrip()');
      await screenshot(shot);
      const consoleState = collectConsole();

      const problems = [];
      if (!/input/.test(activeAfterClick?.tag ?? '')) {
        problems.push(
          `点击标题中心后焦点落在 ${activeAfterClick?.tag}.${activeAfterClick?.cls}（${activeAfterClick?.text}），标题无法编辑`,
        );
      }
      if (!titleAfter.includes('X')) {
        problems.push('输入未写入标题');
      }
      if (before.overlappingButtons.length > 0) {
        problems.push(
          `顶栏按钮与标题输入重叠：${before.overlappingButtons.map((item) => item.text).join('/')}`,
        );
      }
      if (probes.board.inspectorHasDismiss === false) {
        problems.push('检查器无关闭入口');
      }
      if (probes.board.coveredRatio >= 0.5) {
        problems.push(`检查器覆盖画布 ${Math.round(probes.board.coveredRatio * 100)}%`);
      }
      if (consoleState.errors.length > 0) problems.push('控制台错误');

      record(
        meta,
        problems.length ? 'FAIL' : 'PASS',
        {
          head: before,
          clickPoint: click,
          activeAfterClick,
          titleAfter,
          probes: probes.board,
          visibleStrip: strip,
          console: consoleState,
          problems,
        },
        shot,
      );
    } catch (error) {
      record(meta, 'FAIL', { error: error?.message ?? String(error) }, null);
    }
  }

  // ---- 补充 0c：口径澄清——日历月视图本身也是「表格」（role=grid） ----
  {
    const meta = {
      id: 'F-035-calendar-grid',
      feature: 'F-035 响应式断点（口径补充）',
      name: '1024/900/768/390 · 日历月视图 grid（若「表格」指日历表格）',
      viewport: '1024x768 / 900x700 / 768x700 / 390x844',
      page: 'calendar',
      expected:
        '日历月视图 role=grid 在四个断点均不把页面撑宽；周视图内部横向滚动被允许（PRD 未要求周视图无横向滚动）',
    };
    const shots = [];
    const outcomes = {};
    const problems = [];
    try {
      for (const viewport of VIEWPORTS) {
        await setViewport(viewport);
        await navigate(`http://127.0.0.1:${PORT}/calendar`);
        await waitFor(
          "document.querySelector('[role=\\\"grid\\\"][aria-label=\\\"月视图\\\"]') !== null",
          `月视图 ${viewport.width}`,
        );
        await sleep(260);
        const outcome = await evaluate(`(() => {
          const grid = document.querySelector('[role="grid"][aria-label="月视图"]');
          const rect = grid.getBoundingClientRect();
          const doc = document.documentElement;
          return {
            gridWidth: Math.round(rect.width),
            gridLeft: Math.round(rect.left),
            gridRight: Math.round(rect.right),
            scrollWidth: doc.scrollWidth,
            clientWidth: doc.clientWidth,
            overflow: doc.scrollWidth > doc.clientWidth,
            viewportWidth: window.innerWidth,
          };
        })()`);
        const shot = `${viewport.width}-calendar-grid.png`;
        await screenshot(shot);
        shots.push(shot);
        outcomes[viewport.width] = outcome;
        if (outcome.overflow || outcome.gridRight > outcome.viewportWidth + 1) {
          problems.push(`${viewport.width}：日历月视图横向溢出`);
        }
      }
      record(
        meta,
        problems.length ? 'FAIL' : 'PASS',
        { outcomes, problems },
        shots[0],
      );
    } catch (error) {
      record(meta, 'FAIL', { error: error?.message ?? String(error) }, null);
    }
  }

  // ---- 补充 0a：PRD 验收 4（768 画布仍可缩放/拖动）与 390 画布可操作性 ----
  resetConsole();
  {
    const meta = {
      id: 'F-035-768-390-board-drag',
      feature: 'F-035 响应式断点',
      name: '768/390 · 画布仍可缩放与拖动（CDP 真实鼠标）',
      viewport: '768x700 / 390x844',
      page: 'board',
      expected:
        'PRD §3.6.19 验收 4：768 画布占满且仍可缩放/拖动；390 只要求「能显示」，但可见区若够点中对象应能拖动',
    };
    const resultsByWidth = {};
    const problems = [];
    try {
      for (const viewport of [
        { width: 768, height: 700 },
        { width: 390, height: 844 },
      ]) {
        await setViewport(viewport);
        await navigate(`http://127.0.0.1:${PORT}/board/board-aud017`);
        await waitFor(
          "document.querySelector('.bw-canvas') !== null && (document.querySelector('.bw-save-state')?.textContent || '').includes('已保存')",
          `画板就绪 ${viewport.width}`,
        );
        await sleep(420);

        const geometry = await evaluate(
          "window.__ZX017__.boardDragPoints('board-aud017')",
        );
        // 先「放大」再「缩小」：390 的首屏 zoom 已被 clamp 到 30% 下限，
        // 先点「缩小」本来就不会变化，不能据此判失败。
        const zoomBefore = await evaluate('window.__ZX017__.zoomLabel()');
        await evaluate('window.__ZX017__.clickByLabel("放大")');
        await sleep(220);
        const zoomAfterOut = await evaluate('window.__ZX017__.zoomLabel()');
        await evaluate('window.__ZX017__.clickByLabel("缩小")');
        await sleep(220);
        const zoomAfterIn = await evaluate('window.__ZX017__.zoomLabel()');
        // 用「适配画布」恢复首屏视图，保证拖动坐标与 fitViewport 一致。
        await evaluate('window.__ZX017__.clickByLabel("适配画布")');
        await sleep(300);

        // 选一个中心点落在可见画布、且不被检查器盖住的对象。
        let target = null;
        let hit = null;
        const nodeProbes = [];
        for (const node of geometry?.nodes ?? []) {
          if (!node.onScreen) continue;
          const probe = await evaluate(
            `window.__ZX017__.hitAtScreen(${node.screen.x}, ${node.screen.y})`,
          );
          nodeProbes.push({
            id: node.id,
            text: node.text,
            screen: node.screen,
            onCanvas: probe.onCanvas,
            hitBy: probe.hitBy,
          });
          if (probe.onCanvas && !target) {
            target = node;
            hit = probe;
          }
        }

        let drag = null;
        if (target) {
          const before = await evaluate(
            `window.__ZX017__.savedNode(${JSON.stringify(target.id)})`,
          );
          await dragFromTo(target.screen, {
            x: target.screen.x + 40,
            y: target.screen.y + 30,
          });
          await sleep(900);
          const after = await evaluate(
            `window.__ZX017__.savedNode(${JSON.stringify(target.id)})`,
          );
          drag = { target: target.id, text: target.text, before, after };
        }

        resultsByWidth[viewport.width] = {
          zoom: { before: zoomBefore, out: zoomAfterOut, backIn: zoomAfterIn },
          zoomWorked: zoomBefore !== zoomAfterOut && zoomAfterOut !== zoomAfterIn,
          candidateNodes: (geometry?.nodes ?? []).map((node) => ({
            id: node.id,
            onScreen: node.onScreen,
            screen: node.screen,
          })),
          nodeProbes,
          dragTarget: target?.id ?? null,
          dragTargetHit: hit,
          drag,
        };
      }

      const at768 = resultsByWidth[768];
      const at390 = resultsByWidth[390];
      if (!at768.zoomWorked) problems.push('768：缩放按钮无变化');
      if (!at768.drag || at768.drag.before.x === at768.drag.after.x) {
        problems.push(
          `768：画布对象无法拖动（${at768.drag ? `${at768.drag.before.x} → ${at768.drag.after.x}` : '没有可选中的对象'}）`,
        );
      }
      if (!at390.zoomWorked) problems.push('390：缩放按钮无变化');
      if (!at390.drag) {
        problems.push('390：可见区内没有可点中的对象（检查器覆盖后无法拖动）');
      } else if (at390.drag.before.x === at390.drag.after.x) {
        problems.push('390：可见对象拖动后位置未变');
      }
      record(
        meta,
        problems.length ? 'FAIL' : 'PASS',
        { views: resultsByWidth, problems },
        '768-board-drag.png',
      );
    } catch (error) {
      record(meta, 'FAIL', { error: error?.message ?? String(error) }, null);
    }
  }

  // ---- 补充 0b：768/390 知识页无法打开其它笔记（无列表/目录，也无返回入口） ----
  {
    const meta = {
      id: 'F-035-768-390-knowledge-entry',
      feature: 'F-035 响应式断点',
      name: '768/390 · 知识页隐藏目录与列表后仍应提供「返回列表」入口',
      viewport: '768x700 / 390x844',
      page: 'knowledge',
      expected:
        'PRD §3.6.19 ≤820px：隐藏笔记列表，只留编辑器+工具轨，需提供返回列表入口（原型说明与 PRD 已知边界同）',
    };
    const shots = [];
    try {
      const outcomes = {};
      for (const viewport of [
        { width: 768, height: 700 },
        { width: 390, height: 844 },
      ]) {
        await setViewport(viewport);
        await navigate(`http://127.0.0.1:${PORT}/knowledge?note=note-welcome`);
        await waitFor("document.querySelector('.kn-editor') !== null", '知识页就绪');
        await sleep(260);
        const probes = await evaluate('window.__ZX017__.narrowProbes()');
        // 尝试用标签页切到另一篇笔记，确认是否还有任何入口。
        const tabCount = await evaluate(
          "Array.from(document.querySelectorAll('.kn-tabs [role=\\\"tab\\\"]')).filter((el) => el.getBoundingClientRect().width > 0).length",
        );
        const shot = `${viewport.width}-knowledge-entry.png`;
        // 先把「无入口」的页面态单独留证，再截一张「⌘K 搜索兜底」的弹层，
        // 两张图的页面状态不同，避免与 F-035-*-knowledge 组合的截图重复。
        await screenshot(shot);
        shots.push(shot);
        const searchPanel = await evaluate(
          "window.__ZX017__.openSearch('任务')",
        );
        await screenshot(`${viewport.width}-knowledge-entry-search.png`);
        await evaluate('window.__ZX017__.closeSearch()');
        await sleep(200);
        // 记录是否存在「替代通道」：仅影响严重度描述，不改变「无返回列表入口」的事实。
        const searchFallback = await evaluate(
          'window.__ZX017__.searchOpensNote()',
        );
        outcomes[viewport.width] = {
          treeVisible: probes.knowledge.treeVisible,
          listVisible: probes.knowledge.listVisible,
          switchEntryCount: probes.knowledge.switchEntryCount,
          newNoteEntries: probes.knowledge.newNoteEntries,
          tabsVisible: probes.knowledge.tabsVisible,
          tabCount,
          searchPanel,
          searchFallback,
          backToList: await evaluate(`(() => {
            const rx = /返回列表|笔记列表|回到列表/;
            return Array.from(document.querySelectorAll('button, a'))
              .filter((el) => el.getBoundingClientRect().width > 0)
              .map((el) => (el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''))
              .filter((text) => rx.test(text));
          })()`),
        };
      }
      const problems = [];
      for (const [width, outcome] of Object.entries(outcomes)) {
        if (!outcome.listVisible && outcome.backToList.length === 0) {
          problems.push(
            `${width}px：笔记列表隐藏且没有返回列表入口（仅剩 ${outcome.tabCount} 个已打开标签可切换，无法打开其它笔记）`,
          );
        }
      }
      record(
        meta,
        problems.length ? 'FAIL' : 'PASS',
        { outcomes, problems },
        shots[0],
      );
    } catch (error) {
      record(meta, 'FAIL', { error: error?.message ?? String(error) }, null);
    }
  }

  // ---- 补充 1：390 空数据（知识库无笔记 / 画板无对象） ----
  resetConsole();
  {
    const meta = {
      id: 'F-035-390-empty',
      feature: 'F-035 响应式断点',
      name: '390×844 · 空数据（知识库无笔记 / 画板无对象）',
      viewport: '390x844',
      page: 'knowledge+board',
      expected: '空态页面不横向溢出、不出现空白页、控制台零报错',
    };
    const shot = '390-empty-knowledge.png';
    try {
      await setViewport(VIEWPORTS[3]);
      await evaluate(
        "window.__ZX017__.setEmptyKeys(['notes','blocks','todos','boards','nodes','edges'])",
      );
      await navigate(`http://127.0.0.1:${PORT}/knowledge`);
      await waitFor(
        "document.querySelector('.kn-empty, .kn-state-card, .kn-workspace') !== null",
        '知识空态',
      );
      await sleep(300);
      const knowledgeInfo = await evaluate("window.__ZX017__.pageInfo('knowledge')");
      await screenshot(shot);
      await navigate(`http://127.0.0.1:${PORT}/board`);
      await waitFor(
        "document.querySelector('.bw-empty-card, .bw-canvas') !== null",
        '画板空态',
        20_000,
      );
      await sleep(400);
      const boardInfo = await evaluate("window.__ZX017__.pageInfo('board')");
      const emptyBoard = await evaluate('window.__ZX017__.emptyBoardProbe()');
      // 真实点击「插入矩形」：390 空态卡片被检查器盖住时应当点不中。
      const emptyActionPoint = await evaluate(
        'window.__ZX017__.emptyBoardActionPoint("插入矩形")',
      );
      let emptyActionWorked = null;
      if (emptyActionPoint) {
        const beforeCounts = await evaluate('window.__ZX017__.boardCounts()');
        await clickAt(emptyActionPoint.x, emptyActionPoint.y);
        await sleep(500);
        const afterCounts = await evaluate('window.__ZX017__.boardCounts()');
        emptyActionWorked = {
          before: beforeCounts,
          after: afterCounts,
          changed: beforeCounts !== afterCounts,
        };
      }
      await screenshot('390-empty-board.png');
      const consoleState = collectConsole();
      const overflow =
        knowledgeInfo.measure.hasHorizontalOverflow ||
        boardInfo.measure.hasHorizontalOverflow;
      const problems = [];
      if (overflow) problems.push('空态横向溢出');
      if (consoleState.errors.length > 0) problems.push('控制台错误');
      if (emptyActionPoint && emptyActionPoint.hit === false) {
        // 空态卡片被检查器完全盖住：这是「按钮不可点」的硬失败，不是观察项。
        problems.push(
          `空画板「插入矩形」被 ${emptyActionPoint.hitBy?.selector ?? '未知元素'} 覆盖，点击无效（对象数 ${emptyActionWorked?.before} → ${emptyActionWorked?.after}）`,
        );
      }
      if (!/没有笔记|新建|笔记库|还没有/.test(knowledgeInfo.bodyText)) {
        problems.push('知识空态文案缺失');
      }
      if (!/空白画板|起步结构/.test(boardInfo.bodyText)) {
        problems.push('画板空态文案缺失');
      }
      record(
        meta,
        problems.length ? 'FAIL' : 'PASS',
        {
          knowledge: {
            overflow: knowledgeInfo.measure.hasHorizontalOverflow,
            scrollWidth: knowledgeInfo.measure.docScrollWidth,
            clientWidth: knowledgeInfo.measure.docClientWidth,
            text: knowledgeInfo.bodyText,
          },
          board: {
            overflow: boardInfo.measure.hasHorizontalOverflow,
            scrollWidth: boardInfo.measure.docScrollWidth,
            clientWidth: boardInfo.measure.docClientWidth,
            emptyCard: /空白画板/.test(boardInfo.bodyText),
            emptyCardProbe: emptyBoard,
            emptyActionPoint,
            emptyActionWorked,
          },
          console: consoleState,
          problems,
        },
        shot,
      );
    } catch (error) {
      record(meta, 'FAIL', { error: error?.message ?? String(error) }, null);
    } finally {
      await evaluate('window.__ZX017__.clearEmptyKeys()').catch(() => undefined);
      await evaluate('window.__ZX017__.clearSavedDb()').catch(() => undefined);
    }
  }

  // ---- 补充 2b：390 边界操作（不存在笔记/画板、表格删到最小行数、空选择删除） ----
  resetConsole();
  {
    const meta = {
      id: 'F-035-390-boundary',
      feature: 'F-035 响应式断点',
      name: '390×844 · 边界：不存在笔记/画板深链、表格删到最小、画板空选择删除',
      viewport: '390x844',
      page: 'knowledge+board+table',
      expected:
        '不存在的笔记/画板不白屏且无横向溢出；表格最多删到 1 行 1 列后按钮禁用；空选择按 Delete 不改变对象计数；控制台零报错',
    };
    const shot = '390-boundary.png';
    try {
      await setViewport(VIEWPORTS[3]);
      const outcomes = {};

      await navigate(`http://127.0.0.1:${PORT}/knowledge?note=does-not-exist`);
      await waitFor(
        "document.querySelector('.kn-workspace, .kn-state-card') !== null",
        '不存在笔记深链渲染',
      );
      await sleep(320);
      const missingNote = await evaluate(`(() => {
        const m = window.__ZX017__.measure();
        return {
          overflow: m.hasHorizontalOverflow,
          scrollWidth: m.docScrollWidth,
          clientWidth: m.docClientWidth,
          text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
          editorShown: !!document.querySelector('.kn-editor'),
        };
      })()`);
      outcomes.missingNote = missingNote;
      await screenshot('390-boundary-missing-note.png');

      await navigate(`http://127.0.0.1:${PORT}/board/does-not-exist`);
      await waitFor(
        "document.querySelector('.bw-root, .task-state-card') !== null",
        '不存在画板深链渲染',
      );
      await sleep(420);
      const missingBoard = await evaluate(`(() => {
        const m = window.__ZX017__.measure();
        return {
          overflow: m.hasHorizontalOverflow,
          scrollWidth: m.docScrollWidth,
          clientWidth: m.docClientWidth,
          text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 140),
          hasCanvas: !!document.querySelector('.bw-canvas'),
          errorShown: !!document.querySelector('.bw-notice.is-error, [role="alert"]'),
        };
      })()`);
      outcomes.missingBoard = missingBoard;

      // 表格删到最小：真实点击「− 行」「− 列」直到禁用。
      await navigate(`http://127.0.0.1:${PORT}/knowledge?note=note-welcome`);
      await waitFor("document.querySelector('.zxe-table-cell') !== null", '表格就绪');
      await evaluate(
        "document.querySelector('.zxe-table-wrap').scrollIntoView({ block: 'center' })",
      );
      await sleep(200);
      const rowBefore = await evaluate(
        "document.querySelectorAll('.zxe-table tr').length",
      );
      const clickCount = { row: 0, column: 0 };
      for (let index = 0; index < 6; index += 1) {
        const disabled = await evaluate(
          "document.querySelector('[aria-label=\"删除表格最后一行\"]')?.disabled ?? true",
        );
        if (disabled) break;
        const point = await clickElement('[aria-label="删除表格最后一行"]');
        clickCount.row += 1;
        if (!point) break;
      }
      for (let index = 0; index < 6; index += 1) {
        const disabled = await evaluate(
          "document.querySelector('[aria-label=\"删除表格最后一列\"]')?.disabled ?? true",
        );
        if (disabled) break;
        await clickElement('[aria-label="删除表格最后一列"]');
        clickCount.column += 1;
      }
      await sleep(500);
      const tableAfter = await evaluate(`(() => {
        const rows = document.querySelectorAll('.zxe-table tr');
        const firstRowCells = rows[0] ? rows[0].children.length : 0;
        const m = window.__ZX017__.measure();
        return {
          rowCount: rows.length,
          columnCount: firstRowCells,
          removeRowDisabled: document.querySelector('[aria-label="删除表格最后一行"]')?.disabled ?? null,
          removeColumnDisabled: document.querySelector('[aria-label="删除表格最后一列"]')?.disabled ?? null,
          overflow: m.hasHorizontalOverflow,
          cellValue: document.querySelector('.zxe-table-cell')?.value ?? null,
        };
      })()`);
      outcomes.tableMinimum = { rowBefore, clickCount, after: tableAfter };
      await screenshot('390-boundary-table-min.png');

      // 空选择 Delete：对象计数不应变化。
      await navigate(`http://127.0.0.1:${PORT}/board/board-aud017`);
      await waitFor(
        "document.querySelector('.bw-canvas') !== null && (document.querySelector('.bw-save-state')?.textContent || '').includes('已保存')",
        '画板就绪（边界）',
      );
      await sleep(320);
      const countsBefore = await evaluate('window.__ZX017__.boardCounts()');
      const statusAfterDelete = await evaluate('window.__ZX017__.pressDelete()');
      await sleep(250);
      const countsAfter = await evaluate('window.__ZX017__.boardCounts()');
      outcomes.emptySelectionDelete = {
        countsBefore,
        countsAfter,
        statusAfterDelete,
      };

      const consoleState = collectConsole();
      const problems = [];
      if (missingNote.overflow) problems.push('不存在笔记深链横向溢出');
      if (missingBoard.overflow) problems.push('不存在画板深链横向溢出');
      if (tableAfter.rowCount < 1 || tableAfter.columnCount < 1) {
        problems.push('表格被删到 0 行/0 列');
      }
      if (tableAfter.removeRowDisabled !== true) {
        problems.push('删到 1 行后「− 行」仍可点');
      }
      if (tableAfter.removeColumnDisabled !== true) {
        problems.push('删到 1 列后「− 列」仍可点');
      }
      if (tableAfter.overflow) problems.push('表格删减后横向溢出');
      if (countsBefore !== countsAfter) {
        problems.push(`空选择 Delete 改变了对象数：${countsBefore} → ${countsAfter}`);
      }
      if (consoleState.errors.length > 0) problems.push('控制台错误');
      record(
        meta,
        problems.length ? 'FAIL' : 'PASS',
        { outcomes, console: consoleState, problems },
        shot,
      );
    } catch (error) {
      record(meta, 'FAIL', { error: error?.message ?? String(error) }, null);
    }
  }

  // ---- 补充 2a：1024/768 刷新持久化（知识页笔记 + 画板对象） ----
  resetConsole();
  {
    const meta = {
      id: 'F-035-refresh-persist',
      feature: 'F-035 响应式断点',
      name: '1024/768 · 刷新后知识页与画板仍渲染且无横向溢出',
      viewport: '1024x768 / 768x700',
      page: 'knowledge+board',
      expected: '刷新后同一 URL 仍显示笔记/画板对象，scrollWidth<=clientWidth，控制台零报错',
    };
    const outcomes = {};
    const problems = [];
    try {
      for (const viewport of [
        { width: 1024, height: 768 },
        { width: 768, height: 700 },
      ]) {
        await setViewport(viewport);
        await navigate(`http://127.0.0.1:${PORT}/knowledge?note=note-welcome`);
        await waitFor("document.querySelector('.kn-note-row') !== null", '知识页就绪');
        await sleep(260);
        await reload();
        await waitFor("document.querySelector('.kn-note-row') !== null", '知识刷新后');
        await sleep(320);
        const knowledge = await evaluate(`(() => {
          const doc = document.documentElement;
          const title = document.querySelector('input[aria-label="笔记标题"]');
          return {
            title: title ? title.value : null,
            overflow: doc.scrollWidth > doc.clientWidth,
            scrollWidth: doc.scrollWidth,
            clientWidth: doc.clientWidth,
            tablePresent: !!document.querySelector('.zxe-table'),
          };
        })()`);

        await navigate(`http://127.0.0.1:${PORT}/board/board-aud017`);
        await waitFor(
          "document.querySelector('.bw-canvas') !== null && (document.querySelector('.bw-save-state')?.textContent || '').includes('已保存')",
          '画板就绪',
        );
        await sleep(320);
        const before = await evaluate('window.__ZX017__.boardCounts()');
        await reload();
        await waitFor(
          "document.querySelector('.bw-canvas') !== null && (document.querySelector('.bw-save-state')?.textContent || '').includes('已保存')",
          '画板刷新后',
        );
        await sleep(400);
        const after = await evaluate(`(() => {
          const doc = document.documentElement;
          return {
            counts: (document.querySelector('.bw-counts')?.textContent || '').replace(/\\s+/g, ' ').trim(),
            title: document.querySelector('.bw-title-input')?.value ?? null,
            overflow: doc.scrollWidth > doc.clientWidth,
            scrollWidth: doc.scrollWidth,
            clientWidth: doc.clientWidth,
          };
        })()`);
        outcomes[viewport.width] = { knowledge, board: { before, after } };
        if (knowledge.overflow) problems.push(`${viewport.width}：知识刷新后横向溢出`);
        if (!knowledge.title || !knowledge.tablePresent) {
          problems.push(`${viewport.width}：知识刷新后标题/表格缺失`);
        }
        if (after.overflow) problems.push(`${viewport.width}：画板刷新后横向溢出`);
        if (before !== after.counts) {
          problems.push(`${viewport.width}：画板刷新后对象数变化 ${before} → ${after.counts}`);
        }
      }
      const consoleState = collectConsole();
      if (consoleState.errors.length > 0) problems.push('控制台错误');
      record(
        meta,
        problems.length ? 'FAIL' : 'PASS',
        { outcomes, console: consoleState, problems },
        '1024-refresh.png',
      );
    } catch (error) {
      record(meta, 'FAIL', { error: error?.message ?? String(error) }, null);
    }
  }

  // ---- 补充 2：390 刷新持久化 + 快速连点 ----
  resetConsole();
  {
    const meta = {
      id: 'F-035-390-interaction',
      feature: 'F-035 响应式断点',
      name: '390×844 · 刷新持久化 + 设置分组快速连点 + 知识工具栏连点',
      viewport: '390x844',
      page: 'settings+knowledge',
      expected: '刷新后仍渲染、无溢出；连续点击 9 个设置分组与工具栏切换不出异常，最终激活态与最后一个入口一致',
    };
    const shot = '390-interaction.png';
    try {
      await setViewport(VIEWPORTS[3]);
      // 重新种数据：空态阶段清掉过 localStorage。
      await navigate(`http://127.0.0.1:${PORT}/settings/appearance`);
      await waitFor(
        "document.querySelector('.settings-layout') !== null",
        '设置页就绪',
      );
      const beforeReload = await evaluate("window.__ZX017__.pageInfo('settings')");
      await reload();
      await waitFor(
        "document.querySelector('.settings-layout') !== null",
        '刷新后设置页就绪',
      );
      await sleep(300);
      const afterReload = await evaluate("window.__ZX017__.pageInfo('settings')");

      // 快速连点：9 个分组的 NavLink 依次点击两次（共 18 次），再回到外观。
      const rapid = await evaluate(`(async () => {
        const links = Array.from(document.querySelectorAll('.settings-nav-link'));
        for (let round = 0; round < 2; round += 1) {
          for (const link of links) {
            link.click();
            await new Promise((resolve) => setTimeout(resolve, 12));
          }
        }
        links[0].click();
        await new Promise((resolve) => setTimeout(resolve, 260));
        return {
          clicked: links.length * 2 + 1,
          url: location.pathname,
          active: (document.querySelector('.settings-nav-link.is-active')?.textContent || '').replace(/\\s+/g, ' ').trim(),
          bodyShown: document.querySelector('.settings-card') !== null,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        };
      })()`);
      await screenshot(shot);

      // 知识页：连点工具栏收起/展开 10 次。
      await navigate(`http://127.0.0.1:${PORT}/knowledge?note=note-welcome`);
      await waitFor("document.querySelector('.kn-note-row') !== null", '知识页就绪');
      await sleep(300);
      const railRapid = await evaluate(`(async () => {
        const toggle = document.querySelector('.kn-rail-toggle');
        if (!toggle) return { error: '工具栏切换按钮不存在' };
        for (let index = 0; index < 10; index += 1) {
          toggle.click();
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return {
          url: location.pathname,
          expanded: toggle.getAttribute('aria-expanded'),
          railVisible: !!document.querySelector('.kn-rail'),
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        };
      })()`);

      const consoleState = collectConsole();
      const problems = [];
      if (
        beforeReload.measure.hasHorizontalOverflow ||
        afterReload.measure.hasHorizontalOverflow
      ) {
        problems.push('设置页在刷新前后出现横向溢出');
      }
      if (rapid.url !== '/settings/appearance') {
        problems.push(`设置连点后 URL 不符：${rapid.url}`);
      }
      if (!rapid.bodyShown) problems.push('设置连点后内容区为空');
      if (rapid.scrollWidth > rapid.clientWidth) {
        problems.push('设置连点后横向溢出');
      }
      if (railRapid.error) problems.push(railRapid.error);
      if (railRapid.scrollWidth > railRapid.clientWidth) {
        problems.push('知识工具栏连点后横向溢出');
      }
      if (consoleState.errors.length > 0) problems.push('控制台错误');
      record(
        meta,
        problems.length ? 'FAIL' : 'PASS',
        {
          settingsBefore: {
            overflow: beforeReload.measure.hasHorizontalOverflow,
            text: beforeReload.bodyText,
          },
          settingsAfterReload: {
            overflow: afterReload.measure.hasHorizontalOverflow,
            text: afterReload.bodyText,
          },
          rapidSettings: rapid,
          rapidKnowledgeRail: railRapid,
          console: consoleState,
          problems,
        },
        shot,
      );
    } catch (error) {
      record(meta, 'FAIL', { error: error?.message ?? String(error) }, null);
    }
  }

  // ---- 汇总 ----
  const failed = combos.filter((item) => item.verdict !== 'PASS');
  const summary = {
    generatedAt: new Date().toISOString(),
    viewports: VIEWPORTS,
    pages: PAGES.map((item) => ({ id: item.id, label: item.label, url: item.url })),
    comboCount: combos.length,
    combos: combos.map((item) => ({
      id: item.comboId,
      verdict: item.verdict,
      problems: item.problems,
      usability: item.usability ?? [],
      scrollWidth: item.actual?.scrollWidth ?? null,
      clientWidth: item.actual?.clientWidth ?? null,
      evidence: `tests/evidence/aud017/${item.actual?.viewport ? item.comboId.split('-')[2] + '-' + item.actual.page + '.png' : ''}`,
    })),
    results,
    consoleErrors,
    consoleWarns,
    pageExceptions,
  };
  fs.writeFileSync(
    path.join(EVIDENCE, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  note(`结果已写入 tests/evidence/aud017/summary.json`);

  if (failed.length > 0) {
    console.log('\nAUD017_BROWSER_RESULT=FAIL');
    for (const item of failed) {
      console.log(` - ${item.comboId}: ${item.problems.join('；')}`);
    }
    process.exitCode = 1;
  } else if (results.some((item) => item.verdict !== 'PASS')) {
    console.log('\nAUD017_BROWSER_RESULT=FAIL（补充用例）');
    for (const item of results.filter((entry) => entry.verdict !== 'PASS')) {
      console.log(` - ${item.id}: ${JSON.stringify(item.actual).slice(0, 300)}`);
    }
    process.exitCode = 1;
  } else {
    console.log('\nAUD017_BROWSER_RESULT=PASS');
  }
} catch (error) {
  console.error('[aud017] 失败：', error);
  fs.writeFileSync(
    path.join(EVIDENCE, 'summary.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        error: error?.stack ?? String(error),
        results,
        consoleErrors,
        consoleWarns,
        pageExceptions,
      },
      null,
      2,
    )}\n`,
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
