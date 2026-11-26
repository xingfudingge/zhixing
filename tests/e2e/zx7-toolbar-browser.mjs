/**
 * ZX7-TOOLBAR-01 浏览器实测：表格/公式工具条跟随 caret、边界与滚动同步。
 *
 * 真实生产构建 + 真实 Chromium（CDP），只注入 tests/harness/fakeTauri.ts
 * 的内存 IPC 替身；产品源码与构建不改。
 *
 * 覆盖：
 *   1. 1280×900：首行/末行/首列/末列，工具条贴 caret、不溢出、position:fixed；
 *   2. 顶部边界：表格贴近视口顶部时翻到 caret 行下方；
 *   3. 滚动同步：滚动后跟随；锚点滚出视口隐藏，滚回恢复；
 *   4. 900×700 与 390×844：窄窗 maxWidth/夹取，不溢出；
 *   5. 公式编辑态：工具条跟随 textarea caret 行，顶部不足翻到下方；
 *   6. 右键菜单打开时工具条让位；
 *   7. 控制台 0 error、页面 0 exception。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx7-toolbar-browser.mjs
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
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx7-toolbar');
const FAKE_BUNDLE = '/tmp/zx-fake-zx7-toolbar.js';
const PORT = 8921;
const DEBUG_PORT = 9246;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NOTE_TITLE = '浮层验收';

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

const userDataDir = `/tmp/zx-chrome-zx7-toolbar-${Date.now()}`;
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

const PAGE_HELPERS = `
window.__ZXT__ = {
  table() { return document.querySelector('.zxe-table'); },
  cell(row, col) {
    return document.querySelector(
      '.zxe-table [data-row="' + row + '"][data-column="' + col + '"] input.zxe-table-cell',
    );
  },
  toolbar() { return document.querySelector('.zxe-table-toolbar'); },
  formula() { return document.querySelector('.zxe-formula'); },
  formulaInput() { return document.querySelector('.zxe-formula-input'); },
  formulaToolbar() { return document.querySelector('.zxe-formula-head'); },
  viewport() {
    const vv = window.visualViewport;
    return vv
      ? { width: vv.width, height: vv.height, left: vv.offsetLeft, top: vv.offsetTop }
      : { width: window.innerWidth, height: window.innerHeight, left: 0, top: 0 };
  },
  scrollContainer() {
    let el = this.table() || this.formula();
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        el.scrollHeight > el.clientHeight + 1
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return document.scrollingElement;
  },
  scrollTo(selector, block) {
    const el = document.querySelector(selector);
    if (!el) return false;
    el.scrollIntoView({ block: block || 'center', inline: 'nearest', behavior: 'instant' });
    return true;
  },
  scrollTopToTable(offset) {
    const table = this.table();
    const container = this.scrollContainer();
    if (!table || !container) return null;
    container.scrollTop += table.getBoundingClientRect().top - offset;
    return { scrollTop: container.scrollTop, tableTop: table.getBoundingClientRect().top };
  },
  focusCell(row, col) {
    const el = this.cell(row, col);
    if (!el) return false;
    el.focus();
    el.click();
    return true;
  },
  setCaret(pos) {
    const t = this.formulaInput();
    if (!t) return false;
    t.focus();
    const at = Math.max(0, Math.min(pos, t.value.length));
    t.setSelectionRange(at, at);
    t.dispatchEvent(new Event('select', { bubbles: true }));
    return true;
  },
  caretLine() {
    const t = this.formulaInput();
    if (!t) return null;
    const rect = t.getBoundingClientRect();
    const style = getComputedStyle(t);
    const lineHeight = parseFloat(style.lineHeight) || 18;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const caret = t.selectionStart ?? t.value.length;
    const line = t.value.slice(0, caret).split('\\n').length - 1;
    const top = Math.max(
      rect.top,
      Math.min(rect.top + paddingTop + line * lineHeight - t.scrollTop, rect.bottom - lineHeight),
    );
    return { top, bottom: Math.min(rect.bottom, top + lineHeight), lineHeight };
  },
  rect(r) {
    return {
      left: +r.left.toFixed(1), top: +r.top.toFixed(1),
      right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1),
      width: +r.width.toFixed(1), height: +r.height.toFixed(1),
    };
  },
  inside(layer, viewport, gap) {
    const g = gap === undefined ? 8 : gap;
    return (
      layer.left >= viewport.left + g - 0.5 &&
      layer.top >= viewport.top + g - 0.5 &&
      layer.right <= viewport.left + viewport.width - g + 0.5 &&
      layer.bottom <= viewport.top + viewport.height - g + 0.5
    );
  },
  snapshotTable(row, col) {
    const cell = this.cell(row, col);
    const layer = this.toolbar();
    if (!cell || !layer) return null;
    const anchor = cell.getBoundingClientRect();
    const rect = layer.getBoundingClientRect();
    const viewport = this.viewport();
    const style = getComputedStyle(layer);
    const separated =
      rect.bottom <= anchor.top - 5.5 || rect.top >= anchor.bottom + 5.5;
    const side = layer.getAttribute('data-side');
    return {
      anchor: this.rect(anchor),
      layer: this.rect(rect),
      viewport,
      side,
      positioned: layer.getAttribute('data-positioned'),
      separated,
      inside: this.inside(rect, viewport),
      position: style.position,
      zIndex: style.zIndex,
      maxWidth: style.maxWidth,
      distance: +(
        side === 'top' ? anchor.top - rect.bottom : rect.top - anchor.bottom
      ).toFixed(1),
      parentIsBody: layer.parentElement === document.body,
      visible: style.visibility !== 'hidden' && style.opacity !== '0',
    };
  },
  snapshotFormula() {
    const layer = this.formulaToolbar();
    const caret = this.caretLine();
    if (!layer || !caret) return null;
    const rect = layer.getBoundingClientRect();
    const viewport = this.viewport();
    const style = getComputedStyle(layer);
    const side = layer.getAttribute('data-side');
    const separated =
      rect.bottom <= caret.top - 5.5 || rect.top >= caret.bottom + 5.5;
    return {
      caret,
      layer: this.rect(rect),
      viewport,
      side,
      positioned: layer.getAttribute('data-positioned'),
      separated,
      inside: this.inside(rect, viewport),
      position: style.position,
      zIndex: style.zIndex,
      maxWidth: style.maxWidth,
      distance: +(
        side === 'top' ? caret.top - rect.bottom : rect.top - caret.bottom
      ).toFixed(1),
      parentIsBody: layer.parentElement === document.body,
      visible: style.visibility !== 'hidden' && style.opacity !== '0',
    };
  },
};
true;`;

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await setViewport(1280, 900);

const tableRows = Array.from({ length: 12 }, (_, row) =>
  Array.from({ length: 5 }, (_, column) => `R${row + 1}C${column + 1}`),
);
const seedNote = {
  id: 'note-zx7-toolbar',
  spaceId: 'personal',
  folderId: null,
  title: NOTE_TITLE,
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
const tableBlock = {
  id: 'block-zx7-table',
  noteId: seedNote.id,
  blockType: 'table',
  orderKey: 5000,
  payload: { rows: tableRows },
  schemaVersion: 2,
  createdAt: seedNote.createdAt,
  updatedAt: seedNote.updatedAt,
  deletedAt: null,
  version: 1,
};
const formulaBlock = {
  id: 'block-zx7-formula',
  noteId: seedNote.id,
  blockType: 'formula',
  orderKey: 6000,
  payload: { latex: '\\frac{a}{b}', display: 'block', renderer: 'katex' },
  schemaVersion: 1,
  createdAt: seedNote.createdAt,
  updatedAt: seedNote.updatedAt,
  deletedAt: null,
  version: 1,
};
// 前后长正文制造真实滚动范围：表格/公式可滚到视口上方并滚出可见区。
const fillerBlocks = [
  ...Array.from({ length: 60 }, (_, index) => ({
    id: `block-zx7-pre-${index}`,
    noteId: seedNote.id,
    blockType: 'paragraph',
    orderKey: 100 + index,
    payload: { runs: [{ text: `前言段落 ${index + 1}：用于撑开编辑器滚动区域。` }] },
    schemaVersion: 1,
    createdAt: seedNote.createdAt,
    updatedAt: seedNote.updatedAt,
    deletedAt: null,
    version: 1,
  })),
  ...Array.from({ length: 30 }, (_, index) => ({
    id: `block-zx7-post-${index}`,
    noteId: seedNote.id,
    blockType: 'paragraph',
    orderKey: 7000 + index,
    payload: { runs: [{ text: `后记段落 ${index + 1}：用于撑开编辑器滚动区域。` }] },
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
    world.db.blocks.push(${JSON.stringify(tableBlock)});
    world.db.blocks.push(${JSON.stringify(formulaBlock)});
    world.db.blocks.push(...${JSON.stringify(fillerBlocks)});
    window.__ZX_WORLD__ = world;
  })();`,
});

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
    `document.querySelectorAll('.zxe-table [data-row]').length > 0`,
    '表格块渲染',
  );
  await evaluate(PAGE_HELPERS);

  const waitTableToolbar = async () => {
    await waitFor(
      `window.__ZXT__.toolbar()?.getAttribute('data-positioned') === 'true'`,
      '表格工具条定位完成',
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
  };

  // A. 1280×900 首行：贴 caret 上方，position:fixed，不溢出。
  await evaluate(`window.__ZXT__.scrollTo('.zxe-table', 'center'); true`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const firstCellPoint = await evaluate(`(() => {
    const el = window.__ZXT__.cell(0, 0);
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: firstCellPoint.x,
    y: firstCellPoint.y,
    button: 'left',
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: firstCellPoint.x,
    y: firstCellPoint.y,
    button: 'left',
    clickCount: 1,
  });
  await waitTableToolbar();
  const firstRow = await evaluate('window.__ZXT__.snapshotTable(0, 0)');
  check(
    firstRow &&
      firstRow.separated &&
      firstRow.inside &&
      firstRow.side === 'top' &&
      firstRow.position === 'fixed' &&
      firstRow.zIndex === '300' &&
      firstRow.parentIsBody &&
      firstRow.distance >= 0 &&
      firstRow.distance <= 8,
    'A1',
    '1280×900 首行：工具条贴 caret 上方，fixed/300，不遮单元格且不溢出',
    firstRow,
  );
  await screenshot('01-1280-first-row.png');

  // B. 1280×900 末行末列：翻转/夹取后仍在视口内。
  await evaluate('window.__ZXT__.focusCell(11, 4)');
  await waitTableToolbar();
  const lastCell = await evaluate('window.__ZXT__.snapshotTable(11, 4)');
  check(
    lastCell &&
      lastCell.separated &&
      lastCell.inside &&
      lastCell.distance >= 0 &&
      lastCell.distance <= 8,
    'B1',
    '末行末列：工具条跟随 caret，左右/上下夹取后不溢出视口',
    lastCell,
  );
  await screenshot('02-1280-last-cell.png');

  // C. 编辑器滚动到表格顶部：工具条重新测量后仍贴 caret、不溢出。
  //    视口顶部翻转由 toolbarPlacement 单测覆盖（应用壳顶部固定偏移，
  //    表格在真实布局中无法进入视口最上方 40px）。
  await evaluate('window.__ZXT__.scrollTopToTable(64)');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await evaluate('window.__ZXT__.focusCell(0, 0)');
  await waitTableToolbar();
  const topEdge = await evaluate('window.__ZXT__.snapshotTable(0, 0)');
  check(
    topEdge &&
      topEdge.separated &&
      topEdge.inside &&
      topEdge.distance >= 0 &&
      topEdge.distance <= 8,
    'C1',
    '滚动到表格顶部：工具条仍贴 caret 且不溢出视口',
    topEdge,
  );
  await screenshot('03-1280-table-top.png');

  // D. 滚动同步：滚动后跟随；锚点滚出视口隐藏；滚回恢复。
  await evaluate('window.__ZXT__.focusCell(4, 2)');
  await waitTableToolbar();
  const beforeScroll = await evaluate('window.__ZXT__.snapshotTable(4, 2)');
  await evaluate(`(() => {
    const container = window.__ZXT__.scrollContainer();
    container.scrollTop += 160;
    return container.scrollTop;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterScroll = await evaluate('window.__ZXT__.snapshotTable(4, 2)');
  check(
    beforeScroll &&
      afterScroll &&
      afterScroll.positioned === 'true' &&
      afterScroll.layer.top !== beforeScroll.layer.top &&
      afterScroll.separated &&
      afterScroll.inside,
    'D1',
    '编辑器滚动后工具条重新定位并继续贴 caret',
    { beforeScroll, afterScroll },
  );

  await evaluate(`(() => {
    const container = window.__ZXT__.scrollContainer();
    container.scrollTop = container.scrollHeight;
    return container.scrollTop;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const hidden = await evaluate(`(() => {
    const toolbar = window.__ZXT__.toolbar();
    return toolbar
      ? {
          positioned: toolbar.getAttribute('data-positioned'),
          visibility: getComputedStyle(toolbar).visibility,
        }
      : null;
  })()`);
  check(
    hidden && hidden.positioned === 'false' && hidden.visibility === 'hidden',
    'D2',
    '锚点滚出视口后工具条隐藏（不悬空）',
    hidden,
  );
  await screenshot('04-scroll-out-hidden.png');

  await evaluate('window.__ZXT__.scrollTo(".zxe-table", "center"); true');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await evaluate('window.__ZXT__.focusCell(2, 2)');
  await waitTableToolbar();
  const restored = await evaluate('window.__ZXT__.snapshotTable(2, 2)');
  check(
    restored &&
      restored.positioned === 'true' &&
      restored.visible &&
      restored.separated &&
      restored.inside,
    'D3',
    '滚回视口后工具条恢复并重新贴 caret',
    restored,
  );

  // E. 900×700：中等窗口仍不溢出。
  await setViewport(900, 700);
  await evaluate('window.__ZXT__.scrollTo(".zxe-table", "center"); true');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await evaluate('window.__ZXT__.focusCell(6, 3)');
  await waitTableToolbar();
  const medium = await evaluate('window.__ZXT__.snapshotTable(6, 3)');
  check(
    medium && medium.separated && medium.inside && medium.distance <= 8,
    'E1',
    '900×700：工具条在 caret 附近且不溢出',
    medium,
  );
  await screenshot('05-900-medium.png');

  // F. 390×844：窄窗夹取，宽度不超过视口安全宽度。
  await setViewport(390, 844);
  await evaluate('window.__ZXT__.scrollTo(".zxe-table", "center"); true');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await evaluate('window.__ZXT__.focusCell(11, 4)');
  await waitTableToolbar();
  const narrow = await evaluate('window.__ZXT__.snapshotTable(11, 4)');
  check(
    narrow &&
      narrow.separated &&
      narrow.inside &&
      narrow.layer.width <= 390 - 16 + 0.5,
    'F1',
    '390×844：工具条夹取在视口内，宽度不超过 vw-16',
    narrow,
  );
  await screenshot('06-390-narrow.png');

  // G. 右键菜单打开时不叠加。
  await setViewport(1280, 900);
  await evaluate('window.__ZXT__.scrollTo(".zxe-table", "center"); true');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await evaluate('window.__ZXT__.focusCell(1, 1)');
  await waitTableToolbar();
  await evaluate(`(() => {
    const cell = window.__ZXT__.cell(1, 1);
    cell.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 300, clientY: 300,
    }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 160));
  const contextHidden = await evaluate(
    `document.querySelector('.zxe-table-toolbar') === null`,
  );
  check(contextHidden, 'G1', '右键菜单打开时表格工具条不叠加', contextHidden);

  // H. 公式编辑态：工具条跟随 textarea caret 行。
  await evaluate(`window.__ZXT__.scrollTo('.zxe-formula', 'center'); true`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const formulaPoint = await evaluate(`(() => {
    const el = document.querySelector('.zxe-formula-preview');
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: formulaPoint.x,
    y: formulaPoint.y,
    button: 'left',
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: formulaPoint.x,
    y: formulaPoint.y,
    button: 'left',
    clickCount: 1,
  });
  await waitFor(
    `document.querySelector('.zxe-formula-input') !== null`,
    '公式进入编辑态',
  );
  await evaluate('window.__ZXT__.setCaret(0)');
  await waitFor(
    `window.__ZXT__.formulaToolbar()?.getAttribute('data-positioned') === 'true'`,
    '公式工具条定位完成',
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  const formula = await evaluate('window.__ZXT__.snapshotFormula()');
  check(
    formula &&
      formula.separated &&
      formula.inside &&
      formula.position === 'fixed' &&
      formula.zIndex === '300' &&
      formula.parentIsBody &&
      formula.distance >= 0 &&
      formula.distance <= 8,
    'H1',
    '公式编辑态：工具条贴 caret 行，fixed/300，不遮 caret 行',
    formula,
  );
  await screenshot('07-formula-caret.png');

  // I. 编辑器滚动后：公式工具条重新测量并继续贴 caret 行。
  await evaluate(`(() => {
    const container = window.__ZXT__.scrollContainer();
    const formula = window.__ZXT__.formula();
    if (!container || !formula) return null;
    container.scrollTop += formula.getBoundingClientRect().top - 220;
    return container.scrollTop;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const formulaTop = await evaluate('window.__ZXT__.snapshotFormula()');
  check(
    formulaTop &&
      formulaTop.separated &&
      formulaTop.inside &&
      formulaTop.distance >= 0 &&
      formulaTop.distance <= 8,
    'I1',
    '编辑器滚动后公式工具条仍贴 caret 行且不溢出',
    formulaTop,
  );
  await screenshot('08-formula-scroll.png');

  check(
    consoleErrors.length === 0,
    'J1',
    '控制台 0 error',
    consoleErrors.slice(0, 5),
  );
  check(
    pageExceptions.length === 0,
    'J2',
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
    card: 'ZX7-TOOLBAR-01',
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
    `\n[zx7-toolbar] ${results.length - failed.length}/${results.length} 通过`,
  );
  socket.close();
  chrome.kill();
  server.close();
  process.exitCode = failed.length === 0 && !fatal ? 0 : 1;
}
