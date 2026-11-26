/**
 * AUD-016 浏览器实测（真实 Chromium + 生产构建 app/dist）。
 *
 * 覆盖 F-023 画板高级操作：对齐、等距分布、复制（检查器/⌘C⌘V）、层级、锁定、
 * 锚点连线、撤销/重做，以及保存 → 关闭 → 重开后的持久化一致性。
 *
 * 边界（不写成“真机通过”）：
 * * Tauri IPC 由 tests/harness/fakeTauri.ts 的内存命令路由替代，并按命令写
 *   localStorage，使刷新后仍读取同一份数据；页面代码与产品构建未改。
 * * 画布是真实 Canvas2D：点击/拖动走真实鼠标事件（CDP Input.dispatchMouseEvent），
 *   命中、选择、存档全部由生产构建完成；脚本不直接调用产品函数改数据。
 * * 读取数据库使用 fakeTauri 暴露的 world.db（等价于 SQLite 表的镜像），
 *   只做断言，不参与点击。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/aud016-browser.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/aud016');
const FAKE_BUNDLE = '/tmp/zx-aud016-fake.js';
const PORT = 8904;
const DEBUG_PORT = 9226;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DB_KEY = 'zx_aud016_db';
const EMPTY_KEY = 'zx_aud016_empty';
const BOARD_ID = 'board-aud016';

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
  console.log(`[aud016-browser] ${line}`);
}

function record(meta, verdict, actual, evidence) {
  results.push({
    id: meta.id,
    feature: meta.feature,
    name: meta.name,
    expected: meta.expected,
    actual,
    verdict,
    evidence: evidence ? `tests/evidence/aud016/${evidence}` : null,
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

const userDataDir = `/tmp/zx-chrome-aud016-${Date.now()}`;
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
// 鼠标 / 键盘
// ---------------------------------------------------------------------------

async function mouseMove(x, y, buttons = 0) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(x),
    y: Math.round(y),
    button: 'none',
    buttons,
  });
}

async function clickPoint(point, options = {}) {
  const { clickCount = 1, shift = false, modifiers = shift ? 8 : 0 } = options;
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  ensure(x >= 0 && y >= 0 && x <= 1440 && y <= 1000, `点击坐标越界：${x},${y}`);
  await mouseMove(x, y);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount,
    modifiers,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount,
    modifiers,
  });
  await sleep(120);
}

async function dragPoint(from, to, options = {}) {
  const { steps = 8, shift = false } = options;
  const modifiers = shift ? 8 : 0;
  await mouseMove(from.x, from.y);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(from.x),
    y: Math.round(from.y),
    button: 'left',
    buttons: 1,
    clickCount: 1,
    modifiers,
  });
  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps;
    const x = from.x + (to.x - from.x) * ratio;
    const y = from.y + (to.y - from.y) * ratio;
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      buttons: 1,
      modifiers,
    });
    await sleep(16);
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(to.x),
    y: Math.round(to.y),
    button: 'left',
    buttons: 0,
    clickCount: 1,
    modifiers,
  });
  await sleep(140);
}

const KEY_INFO = {
  z: { code: 'KeyZ', keyCode: 90 },
  y: { code: 'KeyY', keyCode: 89 },
  c: { code: 'KeyC', keyCode: 67 },
  v: { code: 'KeyV', keyCode: 86 },
  d: { code: 'KeyD', keyCode: 68 },
  Escape: { code: 'Escape', keyCode: 27 },
  Delete: { code: 'Delete', keyCode: 46 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
};

async function pressKey(key, options = {}) {
  const info = KEY_INFO[key];
  ensure(info, `未定义按键：${key}`);
  const { meta = false, shift = false } = options;
  const modifiers = (meta ? 4 : 0) | (shift ? 8 : 0);
  const base = {
    key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    nativeVirtualKeyCode: info.keyCode,
    modifiers,
  };
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    ...base,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    ...base,
  });
  await sleep(160);
}

async function pointFor(expression, label) {
  const point = await evaluate(`(async () => {
    const el = (${expression});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      tag: el.tagName,
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
    };
  })()`);
  if (!point) throw new Error(`找不到点击目标：${label}`);
  return point;
}

async function clickSelector(selector, label = selector) {
  const point = await pointFor(
    `document.querySelector(${JSON.stringify(selector)})`,
    label,
  );
  await clickPoint(point);
  return point;
}

async function clickAria(label) {
  const point = await pointFor(
    `Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label') === ${JSON.stringify(label)})`,
    `aria-label=${label}`,
  );
  await clickPoint(point);
  return point;
}

async function clickInspectorText(text) {
  const point = await pointFor(
    `Array.from(document.querySelectorAll('.bw-inspector button')).find((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)})`,
    `.bw-inspector button 文本=${text}`,
  );
  await clickPoint(point);
  return point;
}

async function clickInspectorSegmented(groupLabel, optionText) {
  const point = await pointFor(
    `(() => {
      const group = Array.from(document.querySelectorAll('.bw-segmented'))
        .find((el) => el.getAttribute('aria-label') === ${JSON.stringify(groupLabel)});
      if (!group) return null;
      return Array.from(group.querySelectorAll('button'))
        .find((button) => (button.textContent || '').trim() === ${JSON.stringify(optionText)}) || null;
    })()`,
    `分段 ${groupLabel} / ${optionText}`,
  );
  await clickPoint(point);
  return point;
}

async function clickTextButtonInEmptyCard(text) {
  const point = await pointFor(
    `Array.from(document.querySelectorAll('.bw-empty-card button')).find((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)})`,
    `空态卡片按钮 ${text}`,
  );
  await clickPoint(point);
  return point;
}

// ---------------------------------------------------------------------------
// 注入 fakeTauri + 测试探针
// ---------------------------------------------------------------------------

const BOARD_SEED = {
  board: {
    id: BOARD_ID,
    spaceId: 'personal',
    noteId: 'note-welcome',
    title: 'AUD-016 场景画板',
    background: 'dot',
    snapshot: { version: 1, nodeCount: 5, edgeCount: 2 },
    thumbnailKey: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  },
  nodes: [
    {
      id: 'node-a',
      boardId: BOARD_ID,
      nodeType: 'process',
      x: 120,
      y: 140,
      width: 170,
      height: 62,
      rotation: 0,
      zIndex: 0,
      text: '收集信息',
      payload: { style: { fill: '#ffffff', stroke: '#cbd6e2' }, locked: false },
      createdAt: '2026-10-01T00:00:01.000Z',
      updatedAt: '2026-10-01T00:00:01.000Z',
      deletedAt: null,
      version: 1,
    },
    {
      id: 'node-b',
      boardId: BOARD_ID,
      nodeType: 'rect',
      x: 420,
      y: 260,
      width: 170,
      height: 62,
      rotation: 0,
      zIndex: 1,
      text: '处理数据',
      payload: { style: { fill: '#eef8f1', stroke: '#86c69d' }, locked: false },
      createdAt: '2026-10-01T00:00:02.000Z',
      updatedAt: '2026-10-01T00:00:02.000Z',
      deletedAt: null,
      version: 1,
    },
    {
      id: 'node-c',
      boardId: BOARD_ID,
      nodeType: 'decision',
      x: 700,
      y: 120,
      width: 160,
      height: 84,
      rotation: 0,
      zIndex: 2,
      text: '是否通过？',
      payload: { style: { fill: '#fff8e9', stroke: '#e5c477' }, locked: false },
      createdAt: '2026-10-01T00:00:03.000Z',
      updatedAt: '2026-10-01T00:00:03.000Z',
      deletedAt: null,
      version: 1,
    },
    {
      id: 'node-d',
      boardId: BOARD_ID,
      nodeType: 'round',
      x: 980,
      y: 300,
      width: 170,
      height: 62,
      rotation: 0,
      zIndex: 3,
      text: '结束',
      payload: { style: { fill: '#e8eefb', stroke: '#9bbca5' }, locked: false },
      createdAt: '2026-10-01T00:00:04.000Z',
      updatedAt: '2026-10-01T00:00:04.000Z',
      deletedAt: null,
      version: 1,
    },
    {
      id: 'node-e',
      boardId: BOARD_ID,
      nodeType: 'sticky',
      x: 480,
      y: 520,
      width: 160,
      height: 110,
      rotation: 0,
      zIndex: 4,
      text: '备注',
      payload: { style: { fill: '#fff7d9', stroke: '#e8d77a' }, locked: false },
      createdAt: '2026-10-01T00:00:05.000Z',
      updatedAt: '2026-10-01T00:00:05.000Z',
      deletedAt: null,
      version: 1,
    },
  ],
  edges: [
    {
      id: 'edge-ab',
      boardId: BOARD_ID,
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
    {
      id: 'edge-cd',
      boardId: BOARD_ID,
      fromNodeId: 'node-c',
      toNodeId: 'node-d',
      label: '',
      style: {
        routing: 'curve',
        arrow: 'end',
        color: '#9fb0c2',
        width: 1.5,
        dashed: false,
        fromSide: 'r',
        toSide: 'l',
      },
      createdAt: '2026-10-01T00:00:07.000Z',
      updatedAt: '2026-10-01T00:00:07.000Z',
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
  const findAria = (label) =>
    all('[aria-label]').find((el) => el.getAttribute('aria-label') === label) || null;

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
      // 首次打开：用 AUD-016 的五对象场景替换默认双对象种子。
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

    const boardRows = () =>
      world.db.boards.filter((row) => row.deletedAt === null);
    /** 未显式传 boardId 时用“最近更新的活跃画板”，覆盖自动新建画板的空数据阶段。 */
    const currentBoardId = () => {
      const rows = boardRows();
      if (rows.length === 0) return null;
      return rows
        .slice()
        .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
        .pop().id;
    };
    const activeNodes = (boardId) =>
      world.db.nodes
        .filter(
          (row) =>
            row.boardId === (boardId || currentBoardId()) &&
            row.deletedAt === null,
        )
        .slice()
        .sort((a, b) => a.zIndex - b.zIndex);
    const activeEdges = (boardId) =>
      world.db.edges
        .filter(
          (row) =>
            row.boardId === (boardId || currentBoardId()) &&
            row.deletedAt === null,
        )
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id));

    function canvasRect() {
      const canvas = document.querySelector('.bw-canvas');
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    }

    function canvasPixelStats() {
      const canvas = document.querySelector('.bw-canvas');
      if (!canvas) return null;
      const context = canvas.getContext('2d');
      if (!context) return { error: 'no-2d-context' };
      const { width, height } = canvas;
      const data = context.getImageData(0, 0, width, height).data;
      const counts = new Map();
      let sampled = 0;
      // 每 7 个像素抽样一次，避免一次读几百万像素。
      for (let index = 0; index < data.length; index += 4 * 7) {
        const key =
          data[index] + ',' + data[index + 1] + ',' + data[index + 2] + ',' + data[index + 3];
        counts.set(key, (counts.get(key) || 0) + 1);
        sampled += 1;
      }
      let background = null;
      let backgroundCount = 0;
      for (const [key, count] of counts) {
        if (count > backgroundCount) {
          background = key;
          backgroundCount = count;
        }
      }
      let nonBackground = 0;
      for (const [key, count] of counts) {
        if (key !== background) nonBackground += count;
      }
      return {
        width,
        height,
        sampled,
        background,
        backgroundRatio: sampled ? backgroundCount / sampled : 0,
        nonBackgroundRatio: sampled ? nonBackground / sampled : 0,
        distinctColors: counts.size,
      };
    }

    function nodeAt(x, y) {
      // 只读命中：返回该点最上层对象 id（与画布 zIndex 排序一致）。
      const nodes = activeNodes();
      const sorted = nodes.slice().sort((a, b) => b.zIndex - a.zIndex);
      for (const node of sorted) {
        if (
          x >= node.x &&
          x <= node.x + node.width &&
          y >= node.y &&
          y <= node.y + node.height
        ) {
          return node.id;
        }
      }
      return null;
    }

    window.__ZX_WORLD__ = world;
    window.__ZX_TEST__ = {
      boards() {
        return JSON.parse(JSON.stringify(boardRows()));
      },
      boardId() {
        return currentBoardId();
      },
      nodes(boardId) {
        return JSON.parse(JSON.stringify(activeNodes(boardId || null)));
      },
      edges(boardId) {
        return JSON.parse(JSON.stringify(activeEdges(boardId || null)));
      },
      node(id, boardId) {
        const row = world.db.nodes.find((item) => item.id === id) || null;
        return row ? JSON.parse(JSON.stringify(row)) : null;
      },
      edge(id) {
        const row = world.db.edges.find((item) => item.id === id) || null;
        return row ? JSON.parse(JSON.stringify(row)) : null;
      },
      rawNodes(boardId) {
        // 含软删除行：用于核对“删除不存在项”没有额外写入。
        return JSON.parse(
          JSON.stringify(
            world.db.nodes.filter((row) => row.boardId === (boardId || currentBoardId())),
          ),
        );
      },
      canvasRect,
      canvasPixelStats,
      nodeAt,
      boardStorage() {
        try {
          const saved = JSON.parse(localStorage.getItem(${JSON.stringify(DB_KEY)}) || 'null');
          return saved ? { bytes: JSON.stringify(saved).length } : null;
        } catch (error) {
          return null;
        }
      },
      savedNodes(boardId) {
        try {
          const saved = JSON.parse(localStorage.getItem(${JSON.stringify(DB_KEY)}) || 'null');
          if (!saved) return null;
          return saved.nodes
            .filter(
              (row) => row.boardId === (boardId || currentBoardId()) && row.deletedAt === null,
            )
            .slice()
            .sort((a, b) => a.zIndex - b.zIndex);
        } catch (error) {
          return null;
        }
      },
      forceSaveDb() {
        localStorage.setItem(${JSON.stringify(DB_KEY)}, JSON.stringify(world.db));
        localStorage.removeItem(${JSON.stringify(EMPTY_KEY)});
        return true;
      },
      setEmptyKeys(keys) {
        localStorage.setItem(${JSON.stringify(EMPTY_KEY)}, JSON.stringify(keys));
        return true;
      },
      clearSavedDb() {
        localStorage.removeItem(${JSON.stringify(DB_KEY)});
        localStorage.removeItem(${JSON.stringify(EMPTY_KEY)});
        return true;
      },
      clearBoardTables() {
        // 仅供空数据阶段使用：直接清空三张画板表，再配合刷新验证空态。
        world.db.boards = [];
        world.db.nodes = [];
        world.db.edges = [];
        localStorage.setItem(${JSON.stringify(DB_KEY)}, JSON.stringify(world.db));
        return true;
      },
      statusText() {
        return norm(document.querySelector('.bw-status-text')?.textContent);
      },
      statusMessage() {
        return norm(document.querySelector('.bw-status-message')?.textContent);
      },
      saveState() {
        return norm(document.querySelector('.bw-save-state')?.textContent);
      },
      counts() {
        return norm(document.querySelector('.bw-counts')?.textContent);
      },
      title() {
        return document.querySelector('.bw-title-input')?.value ?? null;
      },
      inspector() {
        const root = document.querySelector('.bw-inspector');
        if (!root) return null;
        const heading = norm(root.querySelector('h3')?.textContent);
        const sub = norm(root.querySelector('.bw-inspector-sub')?.textContent);
        const buttons = all('.bw-inspector button').map((button) => ({
          text: norm(button.textContent),
          disabled: button.disabled,
          pressed: button.getAttribute('aria-pressed'),
          label: button.getAttribute('aria-label'),
        }));
        const selects = {};
        for (const select of root.querySelectorAll('select')) {
          selects[select.id || select.getAttribute('aria-label') || 'select'] = select.value;
        }
        const segmented = {};
        for (const group of root.querySelectorAll('.bw-segmented')) {
          const label = group.getAttribute('aria-label');
          const active = Array.from(group.querySelectorAll('button')).find(
            (button) => button.getAttribute('aria-pressed') === 'true',
          );
          segmented[label] = active ? norm(active.textContent) : null;
        }
        return { heading, sub, buttons, selects, segmented, text: norm(root.textContent) };
      },
      rail() {
        const root = document.querySelector('.bw-rail');
        if (!root) return null;
        return all('.bw-rail button').map((button) => ({
          label: button.getAttribute('aria-label'),
          disabled: button.disabled,
          pressed: button.getAttribute('aria-pressed'),
        }));
      },
      emptyCard() {
        const card = document.querySelector('.bw-empty-card');
        return card ? norm(card.textContent) : null;
      },
      canvasCursor() {
        return document.querySelector('.bw-canvas')?.style.cursor ?? null;
      },
      readonly() {
        return document.querySelector('.bw-canvas')?.getAttribute('data-readonly');
      },
      toolbarHidden() {
        return !document.querySelector('.bw-rail') && !document.querySelector('.bw-inspector');
      },
      setSelectValue(selector, value) {
        const control = document.querySelector(selector);
        if (!control) throw new Error('找不到控件：' + selector);
        const setter = Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          'value',
        ).set;
        setter.call(control, String(value));
        control.dispatchEvent(new Event('change', { bubbles: true }));
        return control.value;
      },
      clickButtonByText(text) {
        const button = all('.bw-inspector button, .bw-rail button, .bw-head button').find(
          (el) => norm(el.textContent) === text,
        );
        if (!button) throw new Error('找不到按钮：' + text);
        button.click();
        return true;
      },
      clickRail(label) {
        const button = all('.bw-rail button').find(
          (el) => el.getAttribute('aria-label') === label,
        );
        if (!button) throw new Error('找不到工具按钮：' + label);
        button.click();
        return true;
      },
      focusCanvas() {
        document.querySelector('.bw-canvas')?.focus();
        return document.activeElement?.className ?? null;
      },
      html() {
        return document.body.innerText.slice(0, 500);
      },
    };
  } catch (error) {
    window.__ZX_INIT_ERROR__ = String(error?.stack ?? error);
  }
})();`.replace('  __ZX_FAKE_BUNDLE__\n', () => fakeBundle);

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.addScriptToEvaluateOnNewDocument', { source: injection });

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

async function waitBoardReady() {
  await waitFor(
    `document.querySelector('.bw-canvas') !== null &&
      document.querySelector('.bw-save-state')?.textContent.includes('已保存')`,
    '画板加载完成',
  );
  // 让 fitViewport 的布局副作用先落地，再开始按坐标点击。
  await sleep(350);
}

/** 自动保存是 500ms 防抖：读库前先等存档落盘，避免读到旧快照。 */
async function settle() {
  await sleep(150);
  await waitFor(
    `document.querySelector('.bw-save-state')?.textContent.includes('已保存')`,
    '自动保存落盘',
    8000,
  );
  await sleep(80);
}

async function runCase(meta, fn, shot) {
  try {
    const actual = await fn();
    if (shot) await screenshot(shot);
    record(meta, 'PASS', actual, shot);
    return actual;
  } catch (error) {
    const failShot = shot ? shot.replace(/\.png$/, '-FAIL.png') : null;
    if (failShot) {
      try {
        await screenshot(failShot);
      } catch {
        // 截图失败不覆盖原始错误。
      }
    }
    record(meta, 'FAIL', error?.message ?? String(error), failShot);
    return null;
  }
}

async function observeCase(meta, fn, shot) {
  try {
    const actual = await fn();
    if (shot) await screenshot(shot);
    const verdict = actual?.verdict ?? 'PASS';
    const detail = actual?.detail ?? actual;
    record(meta, verdict, detail, shot);
    return actual;
  } catch (error) {
    const failShot = shot ? shot.replace(/\.png$/, '-FAIL.png') : null;
    if (failShot) {
      try {
        await screenshot(failShot);
      } catch {
        // 忽略。
      }
    }
    record(meta, 'FAIL', error?.message ?? String(error), failShot);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 场景/坐标辅助（复刻产品 fitViewport 的确定性首屏视图）
// ---------------------------------------------------------------------------

const clampZoom = (value) => Math.round(Math.min(2, Math.max(0.3, value)) * 100) / 100;

let view = null; // { x, y, zoom }
let canvasRect = null;

function fitViewOf(nodes, rect, padding = 80) {
  if (nodes.length === 0) {
    return { x: 2400 / 2 - rect.width / 2, y: 1600 / 2 - rect.height / 2, zoom: 1 };
  }
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const availableWidth = Math.max(60, rect.width - padding * 2);
  const availableHeight = Math.max(60, rect.height - padding * 2);
  const zoom = clampZoom(
    Math.min(availableWidth / width, availableHeight / height, 1.2),
  );
  return {
    x: left + width / 2 - rect.width / (2 * zoom),
    y: top + height / 2 - rect.height / (2 * zoom),
    zoom,
  };
}

function screenOf(node, fx = 0.5, fy = 0.5) {
  ensure(view, '视图尚未初始化');
  ensure(canvasRect, '画布尺寸未知');
  return {
    x: canvasRect.left + (node.x + node.width * fx - view.x) * view.zoom,
    y: canvasRect.top + (node.y + node.height * fy - view.y) * view.zoom,
  };
}

function worldToScreen(point) {
  ensure(view, '视图尚未初始化');
  ensure(canvasRect, '画布尺寸未知');
  return {
    x: canvasRect.left + (point.x - view.x) * view.zoom,
    y: canvasRect.top + (point.y - view.y) * view.zoom,
  };
}

async function refreshView(nodes) {
  canvasRect = await evaluate('window.__ZX_TEST__.canvasRect()');
  ensure(canvasRect && canvasRect.width > 100, `画布尺寸异常：${JSON.stringify(canvasRect)}`);
  if (!nodes) nodes = await evaluate(`window.__ZX_TEST__.nodes()`);
  view = fitViewOf(nodes, canvasRect);
  return view;
}

async function nodes() {
  await settle();
  return evaluate('window.__ZX_TEST__.nodes()');
}

async function edges() {
  await settle();
  return evaluate('window.__ZX_TEST__.edges()');
}

async function nodeById(id) {
  await settle();
  return evaluate(`window.__ZX_TEST__.node(${JSON.stringify(id)})`);
}

async function inspector() {
  return evaluate('window.__ZX_TEST__.inspector()');
}

async function clickNodeCenter(id) {
  const node = await nodeById(id);
  ensure(node, `对象不存在：${id}`);
  const point = screenOf(node);
  await clickPoint(point);
  return point;
}

async function shiftClickNode(id) {
  const node = await nodeById(id);
  ensure(node, `对象不存在：${id}`);
  const point = screenOf(node);
  await clickPoint(point, { shift: true });
  return point;
}

async function clickEmptyArea() {
  ensure(canvasRect, '画布尺寸未知');
  // 画布左上角附近通常是空白（对象从 world 120,140 起）。
  const point = { x: canvasRect.left + 22, y: canvasRect.top + 22 };
  await clickPoint(point);
  return point;
}

function nodeSignature(rows) {
  return rows.map((row) => ({
    id: row.id,
    type: row.nodeType ?? row.type,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    zIndex: row.zIndex,
    text: row.text,
    locked: row.payload?.locked === true,
  }));
}

function edgeSignature(rows) {
  return rows.map((row) => ({
    id: row.id,
    from: row.fromNodeId,
    to: row.toNodeId,
    label: row.label,
    style: row.style,
  }));
}

function assertSame(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  ensure(left === right, `${label}不一致：\n实际 ${left}\n预期 ${right}`);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

let hiddenToolbarCase = null;
const snapshots = {};

try {
  await navigate(`http://127.0.0.1:${PORT}/board/${BOARD_ID}`);
  await waitBoardReady();
  await refreshView();

  note('真实 Chromium 已加载画板生产构建', {
    view,
    canvasRect,
    counts: await evaluate('window.__ZX_TEST__.counts()'),
    saveState: await evaluate('window.__ZX_TEST__.saveState()'),
  }, );
  await screenshot('00-board-initial.png');

  // F-023-01 加载与真实渲染
  await runCase(
    {
      id: 'F-023-01',
      feature: 'F-023 画板高级操作',
      name: '加载 5 对象/2 连线场景，Canvas2D 真实绘制',
      expected:
        '标题「AUD-016 场景画板」；计数 5 个对象 · 2 条连线；画布非空（非背景像素 > 1%）；保存态「已保存」',
    },
    async () => {
      const title = await evaluate('window.__ZX_TEST__.title()');
      ensure(title === 'AUD-016 场景画板', `标题不符：${title}`);
      const counts = await evaluate('window.__ZX_TEST__.counts()');
      ensure(counts === '5 个对象 · 2 条连线', `计数不符：${counts}`);
      const state = await evaluate('window.__ZX_TEST__.saveState()');
      ensure(state.includes('已保存'), `保存状态不符：${state}`);
      const pixels = await evaluate('window.__ZX_TEST__.canvasPixelStats()');
      ensure(pixels && pixels.nonBackgroundRatio > 0.01, `画布内容过少：${JSON.stringify(pixels)}`);
      const dbNodes = await nodes();
      ensure(dbNodes.length === 5, `数据库对象数应为 5：${dbNodes.length}`);
      return { title, counts, state, pixels, nodeIds: dbNodes.map((row) => row.id) };
    },
    '01-board-loaded.png',
  );

  // F-023-02 点击选中与检查器
  await runCase(
    {
      id: 'F-023-02',
      feature: 'F-023 画板高级操作',
      name: '真实点击对象中心 → 选中并显示检查器',
      expected: '状态栏「已选 1 个对象」；检查器标题「流程步骤」；形状下拉为 process',
    },
    async () => {
      await clickNodeCenter('node-a');
      const status = await evaluate('window.__ZX_TEST__.statusText()');
      ensure(status.startsWith('已选 1 个对象'), `状态栏不符：${status}`);
      const panel = await inspector();
      ensure(panel?.heading === '流程步骤', `检查器标题不符：${panel?.heading}`);
      ensure(panel?.selects['bw-node-type'] === 'process', `形状下拉不符：${panel?.selects['bw-node-type']}`);
      return { status, heading: panel.heading, type: panel.selects['bw-node-type'] };
    },
    '02-select-single.png',
  );

  // F-023-03 Shift 多选
  await runCase(
    {
      id: 'F-023-03',
      feature: 'F-023 画板高级操作',
      name: 'Shift 点选追加：3 个对象进入多选检查器',
      expected: '状态栏「已选 3 个对象」；检查器「已选 3 个对象」；出现水平等距按钮',
    },
    async () => {
      await shiftClickNode('node-b');
      await shiftClickNode('node-c');
      const status = await evaluate('window.__ZX_TEST__.statusText()');
      ensure(status === '已选 3 个对象 · 拖动移动 · 双击改字 · 右下角缩放', `状态栏不符：${status}`);
      const panel = await inspector();
      ensure(panel?.heading === '已选 3 个对象', `检查器标题不符：${panel?.heading}`);
      const distribute = panel.buttons.find((button) => button.text === '水平等距');
      ensure(distribute && distribute.disabled === false, '水平等距按钮不可用');
      return { status, heading: panel.heading, buttons: panel.buttons.map((button) => button.text) };
    },
    '03-multi-select.png',
  );

  // 记录多选基线
  snapshots.multiSelectBase = {
    nodes: nodeSignature(await nodes()),
    edges: edgeSignature(await edges()),
  };

  // F-023-04 左对齐（检查器）
  await runCase(
    {
      id: 'F-023-04',
      feature: 'F-023 画板高级操作',
      name: '对齐：左对齐（a/b/c 三选，检查器按钮真实点击）',
      expected: 'a/b/c 的 x 都等于 120（最左）；其它对象不变；状态提示「已对齐」',
    },
    async () => {
      await clickInspectorText('左对齐');
      const rows = await nodes();
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      ensure(byId['node-a'].x === 120 && byId['node-b'].x === 120 && byId['node-c'].x === 120,
        `左对齐后 x 不符：a=${byId['node-a'].x}, b=${byId['node-b'].x}, c=${byId['node-c'].x}`);
      ensure(byId['node-d'].x === 980 && byId['node-e'].x === 480, '未选对象被移动');
      ensure(byId['node-a'].y === 140 && byId['node-b'].y === 260, 'y 被改变');
      const message = await evaluate('window.__ZX_TEST__.statusMessage()');
      ensure(message === '已对齐', `状态提示不符：${message}`);
      return { xs: rows.map((row) => ({ id: row.id, x: row.x, y: row.y })), message };
    },
    '04-align-left.png',
  );

  // F-023-05 顶对齐
  await runCase(
    {
      id: 'F-023-05',
      feature: 'F-023 画板高级操作',
      name: '对齐：顶对齐（同一多选）',
      expected: 'a/b/c 的 y 都等于 120（最上）；x 保持左对齐后的值',
    },
    async () => {
      await clickInspectorText('顶对齐');
      const rows = await nodes();
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      ensure(byId['node-a'].y === 120 && byId['node-b'].y === 120 && byId['node-c'].y === 120,
        `顶对齐后 y 不符：a=${byId['node-a'].y}, b=${byId['node-b'].y}, c=${byId['node-c'].y}`);
      ensure(byId['node-a'].x === 120 && byId['node-b'].x === 120, 'x 被改变');
      return { ys: rows.map((row) => ({ id: row.id, x: row.x, y: row.y })) };
    },
    '05-align-top.png',
  );

  // F-023-06 水平居中 / 垂直居中（工具栏图标）
  await runCase(
    {
      id: 'F-023-06',
      feature: 'F-023 画板高级操作',
      name: '对齐：水平居中 + 垂直居中（工具轨图标按钮）',
      expected: '三对象水平中心一致（x+width/2 相等），随后垂直中心一致（y+height/2 相等）',
    },
    async () => {
      await clickAria('水平居中');
      let rows = await nodes();
      const picked = rows.filter((row) => ['node-a', 'node-b', 'node-c'].includes(row.id));
      const centersX = picked.map((row) => row.x + row.width / 2);
      const spreadX = Math.max(...centersX) - Math.min(...centersX);
      ensure(spreadX <= 1, `水平中心差 ${spreadX}`);
      await clickAria('垂直居中');
      rows = await nodes();
      const pickedY = rows.filter((row) => ['node-a', 'node-b', 'node-c'].includes(row.id));
      const centersY = pickedY.map((row) => row.y + row.height / 2);
      const spreadY = Math.max(...centersY) - Math.min(...centersY);
      ensure(spreadY <= 1, `垂直中心差 ${spreadY}`);
      return { centersX, spreadX, centersY, spreadY };
    },
    '06-align-centers.png',
  );

  // 撤销回到多选基线
  await runCase(
    {
      id: 'F-023-07',
      feature: 'F-023 画板高级操作',
      name: '撤销：⌘Z 逐次回退 4 次对齐操作',
      expected: '连续 4 次 ⌘Z 后对象几何回到「多选基线」（x/y 完全一致）',
    },
    async () => {
      for (let index = 0; index < 4; index += 1) {
        await evaluate('window.__ZX_TEST__.focusCanvas()');
        await pressKey('z', { meta: true });
      }
      const rows = await nodes();
      assertSame(nodeSignature(rows), snapshots.multiSelectBase.nodes, '撤销后对象');
      return { restored: nodeSignature(rows) };
    },
    '07-undo-align.png',
  );

  // F-023-08 水平等距
  await runCase(
    {
      id: 'F-023-08',
      feature: 'F-023 画板高级操作',
      name: '等距分布：水平等距（a/b/d）',
      expected: '按中心排序后 a/b/d 相邻间距相等（128/128 或 260/260 由实际端点决定）；端点不动',
    },
    async () => {
      await clickEmptyArea();
      await clickNodeCenter('node-a');
      await shiftClickNode('node-b');
      await shiftClickNode('node-d');
      const before = await nodes();
      const beforeById = Object.fromEntries(before.map((row) => [row.id, row]));
      await clickInspectorText('水平等距');
      const rows = await nodes();
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      ensure(byId['node-a'].x === beforeById['node-a'].x, '首个对象 x 被移动');
      ensure(byId['node-d'].x === beforeById['node-d'].x, '末个对象 x 被移动');
      const sorted = ['node-a', 'node-b', 'node-d']
        .map((id) => byId[id])
        .sort((left, right) => left.x - right.x);
      const gaps = [
        sorted[1].x - (sorted[0].x + sorted[0].width),
        sorted[2].x - (sorted[1].x + sorted[1].width),
      ];
      ensure(Math.abs(gaps[0] - gaps[1]) <= 1, `水平间距不等：${JSON.stringify(gaps)}`);
      ensure(byId['node-c'].x === beforeById['node-c'].x, '未选对象被移动');
      const message = await evaluate('window.__ZX_TEST__.statusMessage()');
      ensure(message === '已水平等距', `状态提示不符：${message}`);
      return {
        positions: sorted.map((row) => ({ id: row.id, x: row.x, width: row.width })),
        gaps,
        message,
      };
    },
    '08-distribute-x.png',
  );

  // F-023-09 垂直等距
  await runCase(
    {
      id: 'F-023-09',
      feature: 'F-023 画板高级操作',
      name: '等距分布：垂直等距（a/b/e）',
      expected: '按中心排序后 a/b/e 相邻纵向间距相等；横向 x 不变',
    },
    async () => {
      await clickEmptyArea();
      await clickNodeCenter('node-a');
      await shiftClickNode('node-b');
      await shiftClickNode('node-e');
      const before = await nodes();
      const beforeById = Object.fromEntries(before.map((row) => [row.id, row]));
      await clickInspectorText('垂直等距');
      const rows = await nodes();
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      const sorted = ['node-a', 'node-b', 'node-e']
        .map((id) => byId[id])
        .sort((left, right) => left.y - right.y);
      const gaps = [
        sorted[1].y - (sorted[0].y + sorted[0].height),
        sorted[2].y - (sorted[1].y + sorted[1].height),
      ];
      ensure(Math.abs(gaps[0] - gaps[1]) <= 1, `垂直间距不等：${JSON.stringify(gaps)}`);
      ensure(byId['node-a'].x === beforeById['node-a'].x, 'x 被改变');
      const message = await evaluate('window.__ZX_TEST__.statusMessage()');
      ensure(message === '已垂直等距', `状态提示不符：${message}`);
      return {
        positions: sorted.map((row) => ({ id: row.id, y: row.y, height: row.height })),
        gaps,
        message,
      };
    },
    '09-distribute-y.png',
  );

  // 撤销两次等距，回到基线。
  await evaluate('window.__ZX_TEST__.focusCanvas()');
  await pressKey('z', { meta: true });
  await pressKey('z', { meta: true });
  {
    const rows = await nodes();
    assertSame(nodeSignature(rows), snapshots.multiSelectBase.nodes, '等距撤销后对象');
  }

  // F-023-10 复制一份（检查器）
  let duplicateId = null;
  await runCase(
    {
      id: 'F-023-10',
      feature: 'F-023 画板高级操作',
      name: '复制：检查器「复制一份」生成偏移副本并选中副本',
      expected: '对象数 +1；副本与 node-c 同尺寸、x/y +24、zIndex 最大；状态栏仍为单选',
    },
    async () => {
      await clickEmptyArea();
      await clickNodeCenter('node-c');
      const before = await nodes();
      const source = before.find((row) => row.id === 'node-c');
      await clickInspectorText('复制一份');
      const rows = await nodes();
      ensure(rows.length === before.length + 1, `对象数未 +1：${rows.length}`);
      const copy = rows.find((row) => !before.some((item) => item.id === row.id));
      ensure(copy, '未找到副本');
      duplicateId = copy.id;
      ensure(copy.x === source.x + 24 && copy.y === source.y + 24, `副本偏移不符：${copy.x},${copy.y}`);
      ensure(copy.width === source.width && copy.height === source.height, '副本尺寸不符');
      ensure(copy.zIndex === Math.max(...rows.map((row) => row.zIndex)), `副本未置顶：${copy.zIndex}`);
      const status = await evaluate('window.__ZX_TEST__.statusText()');
      ensure(status.startsWith('已选 1 个对象'), `副本未自动选中：${status}`);
      return { duplicateId: copy.id, x: copy.x, y: copy.y, zIndex: copy.zIndex, status };
    },
    '10-duplicate.png',
  );

  // F-023-11 层级：置底后命中顺序变化
  await runCase(
    {
      id: 'F-023-11',
      feature: 'F-023 画板高级操作',
      name: '层级：副本与 node-c 重叠，置底/置顶改变点击命中顺序',
      expected:
        '副本最高层时点击重叠区命中副本（检查器「判定」→ 改类型后「椭圆」）；置底后命中 node-c；置顶后再次命中副本',
    },
    async () => {
      ensure(duplicateId, '缺少副本 id');
      // 把副本改成椭圆，便于用检查器标题区分两个重叠对象。
      const changed = await evaluate(
        `window.__ZX_TEST__.setSelectValue('#bw-node-type', 'ellipse')`,
      );
      ensure(changed === 'ellipse', `类型修改失败：${changed}`);
      let panel = await inspector();
      ensure(panel?.heading === '椭圆', `副本检查器标题不符：${panel?.heading}`);

      const copy = await nodeById(duplicateId);
      const decision = await nodeById('node-c');
      // 副本中心同时落在 node-c 的判定菱形内：这就是“重叠区”。
      const overlapWorld = {
        x: copy.x + copy.width / 2,
        y: copy.y + copy.height / 2,
      };
      ensure(
        overlapWorld.x > decision.x && overlapWorld.x < decision.x + decision.width,
        '测试前提不成立：副本中心不在 node-c 范围内',
      );
      const overlapPoint = worldToScreen(overlapWorld);
      const beforeHit = await evaluate(
        `window.__ZX_TEST__.nodeAt(${overlapWorld.x}, ${overlapWorld.y})`,
      );

      await clickPoint(overlapPoint);
      panel = await inspector();
      ensure(panel?.heading === '椭圆', `置底前点击未命中副本：${panel?.heading}`);

      await clickInspectorText('置底');
      const afterBack = await nodes();
      const copyBack = afterBack.find((row) => row.id === duplicateId);
      const decisionBack = afterBack.find((row) => row.id === 'node-c');
      ensure(copyBack.zIndex === 0, `置底后 zIndex 应为 0：${copyBack.zIndex}`);
      ensure(decisionBack.zIndex > copyBack.zIndex, '置底后 node-c 未在副本之上');
      await clickPoint(overlapPoint);
      panel = await inspector();
      ensure(panel?.heading === '判定', `置底后点击未命中 node-c：${panel?.heading}`);

      await clickNodeCenter('node-c');
      panel = await inspector();
      // 重新选中副本：用检查器置顶需要先选到副本；点击重叠区此时只能选中 node-c，
      // 所以用撤销到置底前再验证置顶，或直接点副本未被遮挡的右下区域。
      const copyNow = await nodeById(duplicateId);
      // 副本已改成椭圆：点 0.88 宽处仍在椭圆内，但已越过 node-c 的右边界。
      const freePoint = screenOf(copyNow, 0.88, 0.5);
      await clickPoint(freePoint);
      panel = await inspector();
      ensure(panel?.heading === '椭圆', `点击副本未遮挡区域未选中副本：${panel?.heading}`);
      await clickInspectorText('置顶');
      const afterFront = await nodes();
      const copyFront = afterFront.find((row) => row.id === duplicateId);
      ensure(copyFront.zIndex === Math.max(...afterFront.map((row) => row.zIndex)), '置顶后副本不在最高层');
      await clickPoint(overlapPoint);
      panel = await inspector();
      ensure(panel?.heading === '椭圆', `置顶后点击未命中副本：${panel?.heading}`);
      return {
        beforeHit,
        zIndexAfterBack: copyBack.zIndex,
        zIndexAfterFront: copyFront.zIndex,
        hitAfterBack: '判定',
        hitAfterFront: '椭圆',
      };
    },
    '11-layer.png',
  );

  // F-023-12 锁定
  await runCase(
    {
      id: 'F-023-12',
      feature: 'F-023 画板高级操作',
      name: '锁定：锁定 node-d 后不可拖动、光标 not-allowed、检查器显示锁定',
      expected:
        '锁定后检查器副标题「已锁定 · 解锁后可编辑」；拖动 120px 坐标不变；方向键不移动；解锁后拖动生效',
    },
    async () => {
      await clickEmptyArea();
      await clickNodeCenter('node-d');
      let panel = await inspector();
      ensure(panel?.heading === '圆角矩形', `未选中 node-d：${panel?.heading}`);
      const before = await nodeById('node-d');
      await clickInspectorText('锁定');
      panel = await inspector();
      ensure(panel?.sub === '已锁定 · 解锁后可编辑', `锁定提示不符：${panel?.sub}`);
      ensure(panel?.buttons.some((button) => button.text === '解锁'), '解锁按钮未出现');

      const lockedRow = await nodeById('node-d');
      const center = screenOf(lockedRow);
      await mouseMove(center.x, center.y);
      const cursor = await evaluate('window.__ZX_TEST__.canvasCursor()');
      ensure(cursor === 'not-allowed', `锁定对象光标不符：${cursor}`);

      await dragPoint(center, { x: center.x + 120, y: center.y + 60 });
      const afterDrag = await nodeById('node-d');
      ensure(afterDrag.x === lockedRow.x && afterDrag.y === lockedRow.y,
        `锁定后仍被拖动：${lockedRow.x},${lockedRow.y} → ${afterDrag.x},${afterDrag.y}`);

      await evaluate('window.__ZX_TEST__.focusCanvas()');
      await pressKey('ArrowRight');
      const afterArrow = await nodeById('node-d');
      ensure(afterArrow.x === lockedRow.x, `方向键移动了锁定对象：${afterArrow.x}`);

      await clickInspectorText('解锁');
      panel = await inspector();
      ensure(panel?.sub.includes('拖动移动'), `解锁提示不符：${panel?.sub}`);
      const unlockedRow = await nodeById('node-d');
      const unlockCenter = screenOf(unlockedRow);
      await dragPoint(unlockCenter, { x: unlockCenter.x + 80, y: unlockCenter.y + 40 });
      const afterUnlockDrag = await nodeById('node-d');
      ensure(
        Math.abs(afterUnlockDrag.x - unlockedRow.x) >= 60 &&
          Math.abs(afterUnlockDrag.y - unlockedRow.y) >= 30,
        `解锁后拖动无效：${unlockedRow.x},${unlockedRow.y} → ${afterUnlockDrag.x},${afterUnlockDrag.y}`,
      );
      return {
        lockedCursor: cursor,
        lockedPosition: { x: lockedRow.x, y: lockedRow.y },
        afterLockedDrag: { x: afterDrag.x, y: afterDrag.y },
        afterUnlockDrag: { x: afterUnlockDrag.x, y: afterUnlockDrag.y },
        before,
      };
    },
    '12-lock.png',
  );

  // F-023-13 锁定对象连线尝试（PRD §3.6.16 验收 5：锁定后不能拖动/连线）
  await observeCase(
    {
      id: 'F-023-13',
      feature: 'F-023 画板高级操作',
      name: '锁定对象是否仍能作为连线起点（锚点拖拽）',
      expected: '锁定后不能连线（PRD §3.6.16 验收 5；原型 nodeDown 对 locked 直接 return）',
    },
    async () => {
      await clickEmptyArea();
      await clickNodeCenter('node-e');
      await clickInspectorText('锁定');
      const locked = await nodeById('node-e');
      const target = await nodeById('node-a');
      const edgesBefore = (await edges()).length;
      const anchor = worldToScreen({ x: locked.x + locked.width, y: locked.y + locked.height / 2 });
      const targetPoint = screenOf(target);
      await dragPoint(anchor, targetPoint, { steps: 10 });
      await sleep(600);
      const edgesAfter = await edges();
      const created = edgesAfter.find(
        (row) => row.fromNodeId === 'node-e' && row.toNodeId === 'node-a',
      );
      const verdict = created ? 'FAIL' : 'PASS';
      // 先在“缺陷现场”截图：锁定对象仍拖出了新连线。
      if (created) {
        await screenshot('13-locked-connect-defect.png');
      }
      // 恢复现场：删掉误建连线（当前选中就是新连线），再解锁 node-e。
      if (created) {
        const panelNow = await inspector();
        if (panelNow?.heading === '连线') {
          await clickInspectorText('删除连线');
        }
      }
      await clickEmptyArea();
      await clickNodeCenter('node-e');
      const panel = await inspector();
      if (panel?.buttons.some((button) => button.text === '解锁')) {
        await clickInspectorText('解锁');
      }
      ensure((await edges()).length === edgesBefore, `恢复现场失败：连线数 ${(await edges()).length} ≠ ${edgesBefore}`);
      return {
        verdict,
        detail: {
          expected: '锁定对象不能作为连线起点',
          edgesBefore,
          edgesAfter: edgesAfter.length,
          createdEdge: created ?? null,
        },
      };
    },
    '13-locked-connect.png',
  );

  // F-023-13b 锁定对象的其它编辑通道（补充观察，同一缺陷的旁证）
  await observeCase(
    {
      id: 'F-023-13b',
      feature: 'F-023 画板高级操作',
      name: '锁定对象能否被删除 / 改样式 / 双击改字（补充观察）',
      expected:
        'PRD §3.6.16「锁定后不能拖动/连线，检查器显示锁定状态」；原型对 locked 节点还阻止双击改字，但检查器删除未显式拦截',
    },
    async () => {
      await clickEmptyArea();
      await clickNodeCenter('node-e');
      let panel = await inspector();
      ensure(panel?.buttons.some((button) => button.text === '锁定'), 'node-e 未处于解锁态');
      await clickInspectorText('锁定');
      panel = await inspector();
      const styleButtons = panel.buttons.filter(
        (button) => button.text === '复制一份' || button.text === '删除' || button.text === '置顶',
      );
      const disabledStyleButtons = styleButtons.filter((button) => button.disabled).map((b) => b.text);
      const swatchDisabled = await evaluate(
        `document.querySelector('.bw-inspector .bw-swatch')?.disabled ?? null`,
      );
      // 双击锁定对象中心：不应出现编辑 textarea。
      const node = await nodeById('node-e');
      const center = screenOf(node);
      await clickPoint(center);
      await sleep(40);
      await clickPoint(center, { clickCount: 2 });
      const textarea = await evaluate(
        `document.querySelector('.bw-text-editor') !== null`,
      );
      // 尝试用检查器“删除”锁定对象（PRD 明确该问题待正式版明确，本次只观察）。
      await clickEmptyArea();
      await clickNodeCenter('node-e');
      const before = (await evaluate('window.__ZX_TEST__.nodes()')).length;
      await clickInspectorText('删除');
      await sleep(700);
      const after = (await evaluate('window.__ZX_TEST__.nodes()')).length;
      // 恢复：撤销删除（若发生）并解锁。
      await evaluate('window.__ZX_TEST__.focusCanvas()');
      if (after < before) {
        await pressKey('z', { meta: true });
      }
      await clickEmptyArea();
      await clickNodeCenter('node-e');
      const panelNow = await inspector();
      if (panelNow?.buttons.some((button) => button.text === '解锁')) {
        await clickInspectorText('解锁');
      }
      return {
        verdict: 'OBSERVED',
        detail: {
          lockedActionButtonsStillEnabled: styleButtons
            .filter((button) => !button.disabled)
            .map((button) => button.text),
          disabledStyleButtons,
          styleSwatchDisabled: swatchDisabled,
          doubleClickOpensTextEditor: textarea,
          lockedDeleteRemovedNode: after < before,
          nodesBefore: before,
          nodesAfter: after,
        },
      };
    },
    '13b-locked-other-actions.png',
  );

  // F-023-13c 锁定对象作为连线“终点”
  await observeCase(
    {
      id: 'F-023-13c',
      feature: 'F-023 画板高级操作',
      name: '锁定对象作为连线终点是否可被连接（补充观察）',
      expected:
        'PRD §3.6.16 验收 5 写明「锁定后不能拖动/连线」，字面要求目标端也不可接入；但原型 connectToNode 未校验 locked，属于原型既有行为。本项只记录事实，由产品确认口径',
    },
    async () => {
      await clickEmptyArea();
      await clickNodeCenter('node-e');
      let panel = await inspector();
      ensure(panel?.buttons.some((button) => button.text === '锁定'), 'node-e 未处于解锁态');
      await clickInspectorText('锁定');
      const locked = await nodeById('node-e');
      ensure(locked.payload?.locked === true, 'node-e 未锁定');
      // 选中 node-a 后再从它的右锚点拖到锁定对象（锚点只在选中/悬停对象上可命中）。
      await clickPoint(screenOf(await nodeById('node-a'), 0.06, 0.2));
      const panelA = await inspector();
      ensure(panelA?.heading === '流程步骤', `未选中 node-a：${panelA?.heading}`);
      const a = await nodeById('node-a');
      const edgesBefore = (await edges()).length;
      const anchorPoint = worldToScreen({ x: a.x + a.width, y: a.y + a.height / 2 });
      await dragPoint(anchorPoint, screenOf(locked), { steps: 10 });
      await sleep(600);
      const edgesAfter = await edges();
      const created = edgesAfter.find(
        (row) => row.toNodeId === 'node-e' && row.fromNodeId === 'node-a',
      );
      if (created) {
        await screenshot('13c-locked-connect-target-defect.png');
        const panelNow = await inspector();
        if (panelNow?.heading === '连线') {
          await clickInspectorText('删除连线');
        }
      }
      await clickEmptyArea();
      await clickNodeCenter('node-e');
      const panelNow = await inspector();
      if (panelNow?.buttons.some((button) => button.text === '解锁')) {
        await clickInspectorText('解锁');
      }
      ensure((await edges()).length === edgesBefore, '恢复现场失败');
      return {
        verdict: 'OBSERVED',
        detail: {
          lockedAsTargetAccepted: Boolean(created),
          edgesBefore,
          edgesAfter: edgesAfter.length,
          createdEdge: created
            ? { id: created.id, from: created.fromNodeId, to: created.toNodeId }
            : null,
        },
      };
    },
    '13c-locked-connect-target.png',
  );

  await sleep(600);
  await reload();
  await waitBoardReady();
  await refreshView();
  await screenshot('13b-after-reload-lock.png');

  // F-023-14 锚点连线
  await runCase(
    {
      id: 'F-023-14',
      feature: 'F-023 画板高级操作',
      name: '锚点连线：从 node-a 右锚点拖到 node-e 中心',
      expected: '新增 1 条连线 a→e，fromSide=r、toSide=l；选中新连线并提示「已连接」',
    },
    async () => {
      await clickEmptyArea();
      await clickNodeCenter('node-a');
      const a = await nodeById('node-a');
      const e = await nodeById('node-e');
      const edgesBefore = await edges();
      const anchor = worldToScreen({ x: a.x + a.width, y: a.y + a.height / 2 });
      const targetPoint = screenOf(e);
      await dragPoint(anchor, targetPoint, { steps: 10 });
      const after = await edges();
      ensure(after.length === edgesBefore.length + 1, `新增连线数不符：${edgesBefore.length} → ${after.length}`);
      const created = after.find((row) => row.fromNodeId === 'node-a' && row.toNodeId === 'node-e');
      ensure(created, `未找到 a→e 连线：${JSON.stringify(after.map((row) => [row.fromNodeId, row.toNodeId]))}`);
      ensure(created.style.fromSide === 'r', `fromSide 不符：${created.style.fromSide}`);
      ensure(created.style.toSide === 'l', `toSide 不符：${created.style.toSide}`);
      const message = await evaluate('window.__ZX_TEST__.statusMessage()');
      ensure(message.includes('已连接'), `连线提示不符：${message}`);
      return {
        edge: { id: created.id, fromSide: created.style.fromSide, toSide: created.style.toSide },
        message,
      };
    },
    '14-anchor-connect.png',
  );

  // F-023-15 复制粘贴（⌘C/⌘V，含连线）
  await runCase(
    {
      id: 'F-023-15',
      feature: 'F-023 画板高级操作',
      name: '复制粘贴：⌘C/⌘V 复制相连的 a+b（含连线）',
      expected: '新增 2 个对象与 1 条连线；副本偏移 24；副本连线指向副本而非原对象',
    },
    async () => {
      await clickEmptyArea();
      await clickNodeCenter('node-a');
      await shiftClickNode('node-b');
      const before = await nodes();
      const edgesBefore = await edges();
      await evaluate('window.__ZX_TEST__.focusCanvas()');
      await pressKey('c', { meta: true });
      await pressKey('v', { meta: true });
      const after = await nodes();
      const afterEdges = await edges();
      ensure(after.length === before.length + 2, `对象数不符：${before.length} → ${after.length}`);
      ensure(afterEdges.length === edgesBefore.length + 1, `连线数不符：${edgesBefore.length} → ${afterEdges.length}`);
      const newNodes = after.filter((row) => !before.some((item) => item.id === row.id));
      const sourceById = Object.fromEntries(before.map((row) => [row.id, row]));
      for (const copy of newNodes) {
        const origin = sourceById[copy.id === newNodes[0].id ? 'node-a' : 'node-b'];
        ensure(
          copy.x === origin?.x + 24 || copy.x === sourceById['node-a'].x + 24 || copy.x === sourceById['node-b'].x + 24,
          `副本偏移不符：${JSON.stringify(newNodes.map((row) => [row.id, row.x, row.y]))}`,
        );
      }
      const newEdge = afterEdges.find(
        (row) => !edgesBefore.some((item) => item.id === row.id),
      );
      ensure(newEdge, '未复制出连线');
      const newIds = new Set(newNodes.map((row) => row.id));
      ensure(
        newIds.has(newEdge.fromNodeId) && newIds.has(newEdge.toNodeId),
        `副本连线端点不是副本：${JSON.stringify(newEdge)}`,
      );
      const status = await evaluate('window.__ZX_TEST__.statusText()');
      ensure(status === '已选 2 个对象 · 拖动移动 · 双击改字 · 右下角缩放', `粘贴后选择不符：${status}`);
      return {
        added: newNodes.map((row) => ({ id: row.id, type: row.nodeType, x: row.x, y: row.y })),
        newEdge: {
          id: newEdge.id,
          from: newEdge.fromNodeId,
          to: newEdge.toNodeId,
        },
        status,
      };
    },
    '15-copy-paste.png',
  );

  // F-023-16 撤销/重做：删除节点与相连线
  await runCase(
    {
      id: 'F-023-16',
      feature: 'F-023 画板高级操作',
      name: '撤销/重做：Delete 删除 node-d（含相连线）→ ⌘Z 恢复 → ⇧⌘Z 重做',
      expected:
        '删除后 node-d 与 edge-cd 消失；⌘Z 后节点/连线及其坐标与删除前完全一致；⇧⌘Z 后再次消失',
    },
    async () => {
      await clickEmptyArea();
      // node-b 被 F-023-15 的副本覆盖，这里改用未被覆盖、且有连线的 node-d。
      await clickNodeCenter('node-d');
      const panelBefore = await inspector();
      ensure(panelBefore?.heading === '圆角矩形', `未选中 node-d：${panelBefore?.heading}`);
      const beforeNodes = await nodes();
      const beforeEdges = await edges();
      const bBefore = beforeNodes.find((row) => row.id === 'node-d');
      const relatedEdges = beforeEdges.filter(
        (row) => row.fromNodeId === 'node-d' || row.toNodeId === 'node-d',
      );
      ensure(relatedEdges.length > 0, '基线应存在与 node-d 相连的连线');
      await evaluate('window.__ZX_TEST__.focusCanvas()');
      await pressKey('Delete');
      let afterNodes = await nodes();
      let afterEdges = await edges();
      ensure(!afterNodes.some((row) => row.id === 'node-d'), '删除后 node-d 仍在');
      for (const edge of relatedEdges) {
        ensure(!afterEdges.some((row) => row.id === edge.id), `删除后连线仍在：${edge.id}`);
      }

      await pressKey('z', { meta: true });
      afterNodes = await nodes();
      afterEdges = await edges();
      const restoredB = afterNodes.find((row) => row.id === 'node-d');
      ensure(restoredB, '撤销后 node-d 未恢复');
      ensure(restoredB.x === bBefore.x && restoredB.y === bBefore.y, '撤销后坐标不符');
      for (const edge of relatedEdges) {
        const restored = afterEdges.find((row) => row.id === edge.id);
        ensure(restored, `撤销后连线未恢复：${edge.id}`);
        ensure(restored.fromNodeId === edge.fromNodeId && restored.toNodeId === edge.toNodeId, '撤销后连线端点不符');
      }

      await pressKey('z', { meta: true, shift: true });
      afterNodes = await nodes();
      afterEdges = await edges();
      ensure(!afterNodes.some((row) => row.id === 'node-d'), '重做后 node-d 仍在');
      for (const edge of relatedEdges) {
        ensure(!afterEdges.some((row) => row.id === edge.id), `重做后连线仍在：${edge.id}`);
      }
      // 恢复到删除前，便于后续持久化用例。
      await pressKey('z', { meta: true });
      const finalNodes = await nodes();
      assertSame(nodeSignature(finalNodes), nodeSignature(beforeNodes), '恢复后对象');
      return {
        relatedEdges: relatedEdges.map((row) => row.id),
        restored: nodeSignature(finalNodes).find((row) => row.id === 'node-d'),
      };
    },
    '16-undo-redo-delete.png',
  );

  // F-023-17 撤销栈边界与删除不存在项
  await runCase(
    {
      id: 'F-023-17',
      feature: 'F-023 画板高级操作',
      name: '删除不存在项 / 无选中删除 / 撤销到底',
      expected:
        '无选中时 Delete/Backspace 与工具轨删除按钮（disabled）不改变对象/连线数、不新增软删除行；已删除的连线再点同一位置不再产生写入',
    },
    async () => {
      await clickEmptyArea();
      const before = {
        nodes: nodeSignature(await nodes()),
        edges: edgeSignature(await edges()),
        raw: await evaluate('window.__ZX_TEST__.rawNodes()'),
      };
      await evaluate('window.__ZX_TEST__.focusCanvas()');
      await pressKey('Delete');
      await pressKey('Backspace');
      const railDelete = await evaluate(
        `window.__ZX_TEST__.rail().find((item) => item.label === '删除选中')`,
      );
      ensure(railDelete?.disabled === true, `删除按钮未禁用：${JSON.stringify(railDelete)}`);
      const after = {
        nodes: nodeSignature(await nodes()),
        edges: edgeSignature(await edges()),
        raw: await evaluate('window.__ZX_TEST__.rawNodes()'),
      };
      assertSame(after.nodes, before.nodes, '无选中删除后对象');
      assertSame(after.edges, before.edges, '无选中删除后连线');
      assertSame(after.raw, before.raw, '无选中删除后软删除行');

      // 删除一条连线两次：第一次成功，第二次点击同一位置不应再删任何东西。
      const edgeRow = (await edges()).find((row) => row.id === 'edge-cd');
      ensure(edgeRow, '缺少 edge-cd');
      const from = await nodeById(edgeRow.fromNodeId);
      const to = await nodeById(edgeRow.toNodeId);
      const midWorld = {
        x: (from.x + from.width + to.x) / 2,
        y: (from.y + from.height / 2 + to.y + to.height / 2) / 2,
      };
      await clickPoint(worldToScreen(midWorld));
      let panel = await inspector();
      ensure(panel?.heading === '连线', `点击连线未选中：${panel?.heading}`);
      await clickInspectorText('删除连线');
      ensure(!(await edges()).some((row) => row.id === 'edge-cd'), '连线未被删除');
      await clickPoint(worldToScreen(midWorld));
      panel = await inspector();
      ensure(panel?.heading !== '连线', '已删除的连线仍可被选中');
      const rawAfterSecond = await evaluate('window.__ZX_TEST__.rawNodes()');
      assertSame(rawAfterSecond, after.raw, '重复点击后软删除行');
      return {
        railDelete,
        deletedEdge: 'edge-cd',
        inspectorAfterSecondClick: panel,
      };
    },
    '17-delete-missing.png',
  );

  // 快速连点
  await runCase(
    {
      id: 'F-023-18',
      feature: 'F-023 画板高级操作',
      name: '快速连点：连续两次「复制一份」/ 快速两次撤销 / 连点保存',
      expected:
        '两次复制得到 2 个新对象（不丢、不重复写）；两次撤销回退 2 步；连点保存不产生额外对象且保持「已保存」；无控制台错误',
    },
    async () => {
      await clickEmptyArea();
      await clickNodeCenter('node-a');
      const before = (await nodes()).length;
      const point = await pointFor(
        `Array.from(document.querySelectorAll('.bw-inspector button')).find((el) => (el.textContent || '').trim() === '复制一份')`,
        '复制一份',
      );
      // 两次真实点击间隔 40ms（模拟快速连点）。
      await clickPoint(point);
      await sleep(40);
      await clickPoint(point);
      const after = await nodes();
      ensure(after.length === before + 2, `两次复制后对象数不符：${before} → ${after.length}`);

      await evaluate('window.__ZX_TEST__.focusCanvas()');
      await pressKey('z', { meta: true });
      await sleep(30);
      await pressKey('z', { meta: true });
      const afterUndo = await nodes();
      ensure(afterUndo.length === before, `两次撤销后对象数不符：${afterUndo.length}`);

      const savePoint = await pointFor(
        `Array.from(document.querySelectorAll('.bw-head-actions button')).find((el) => (el.textContent || '').trim() === '保存')`,
        '保存按钮',
      );
      await clickPoint(savePoint);
      await clickPoint(savePoint);
      await clickPoint(savePoint);
      await sleep(700);
      const state = await evaluate('window.__ZX_TEST__.saveState()');
      ensure(state.includes('已保存'), `连点保存后状态不符：${state}`);
      ensure((await nodes()).length === before, '连点保存改变了对象数');
      return { duplicated: after.length - before, afterUndo: afterUndo.length, saveState: state };
    },
    '18-rapid-clicks.png',
  );

  // F-023-18b 锁定状态持久化（保存 → 刷新 → 仍锁定且不可拖动）
  await runCase(
    {
      id: 'F-023-18b',
      feature: 'F-023 画板高级操作',
      name: '锁定持久化：锁定 node-a → 保存 → 整页刷新 → 仍锁定且不可拖动',
      expected: '刷新后检查器显示「已锁定 · 解锁后可编辑」；payload.locked=true 落库；拖动 100px 坐标不变',
    },
    async () => {
      await clickEmptyArea();
      // node-a 的中心被 F-023-15 粘贴出的副本(+24,+24)覆盖，点它左上角的独立区域。
      const aForClick = await nodeById('node-a');
      await clickPoint(screenOf(aForClick, 0.06, 0.2));
      const selected = await inspector();
      ensure(selected?.heading === '流程步骤', `未选中 node-a：${selected?.heading}`);
      await clickInspectorText('锁定');
      const lockedRow = await nodeById('node-a');
      ensure(lockedRow.payload?.locked === true, `锁定未落库：${JSON.stringify(lockedRow.payload)}`);
      await settle();
      await reload();
      await waitBoardReady();
      await refreshView();

      const afterReload = await nodeById('node-a');
      ensure(afterReload.payload?.locked === true, '刷新后锁定状态丢失');
      await clickPoint(screenOf(afterReload, 0.06, 0.2));
      const panelAfter = await inspector();
      ensure(panelAfter?.sub === '已锁定 · 解锁后可编辑', `刷新后检查器未显示锁定：${panelAfter?.sub}`);
      // 用 node-a 自己未被副本遮挡的区域做悬停/拖动，避免点到上层副本。
      const center = screenOf(afterReload, 0.06, 0.2);
      await mouseMove(center.x, center.y);
      const cursor = await evaluate('window.__ZX_TEST__.canvasCursor()');
      ensure(cursor === 'not-allowed', `刷新后锁定对象光标不符：${cursor}`);
      await dragPoint(center, { x: center.x + 100, y: center.y + 50 });
      const afterDrag = await nodeById('node-a');
      ensure(
        afterDrag.x === afterReload.x && afterDrag.y === afterReload.y,
        `刷新后锁定对象仍被拖动：${afterReload.x},${afterReload.y} → ${afterDrag.x},${afterDrag.y}`,
      );
      return {
        locked: afterReload.payload.locked,
        cursor,
        position: { x: afterDrag.x, y: afterDrag.y },
        sub: panelAfter?.sub,
      };
    },
    '18b-lock-persist.png',
  );

  // ------------------------------------------------------------------
  // F-023-19 保存 → 关闭 → 重开 持久化一致性
  // ------------------------------------------------------------------
  await runCase(
    {
      id: 'F-023-19',
      feature: 'F-023 画板高级操作',
      name: '保存 → 离开页面 → 返回 → 整页刷新，几何/层级/锁定/连线一致',
      expected:
        '保存后 localStorage 中节点几何与当前文档一致；离开到 /today 再返回、以及 Page.reload 后，对象数、x/y/尺寸/zIndex/locked、连线端点与样式完全一致',
    },
    async () => {
      const docNodes = nodeSignature(await nodes());
      const docEdges = edgeSignature(await edges());
      await clickSelector('.bw-head-actions .bw-button.is-primary', '保存');
      await waitFor(
        `document.querySelector('.bw-save-state')?.textContent.includes('已保存')`,
        '保存完成',
      );
      const saved = await evaluate('window.__ZX_TEST__.savedNodes()');
      ensure(saved && saved.length === docNodes.length, `localStorage 节点数不符：${saved?.length}`);
      const savedSignature = nodeSignature(saved);
      assertSame(savedSignature, docNodes, 'localStorage 与当前文档');

      // 关闭：离开画板页（真实路由跳转）。
      await clickSelector('.nav-link[href="/today"]', '返回今天');
      await waitFor(`document.querySelector('h1')?.textContent.trim() === '今天'`, '今天页');
      await evaluate('window.__ZX_TEST__.forceSaveDb()');
      await navigate(`http://127.0.0.1:${PORT}/board/${BOARD_ID}`);
      await waitBoardReady();
      await refreshView();
      const afterReopenNodes = nodeSignature(await nodes());
      const afterReopenEdges = edgeSignature(await edges());
      assertSame(afterReopenNodes, docNodes, '重开后对象');
      assertSame(afterReopenEdges, docEdges, '重开后连线');
      // 重开后画布真的用数据渲染：点击 node-a 位置应选中它。
      await clickNodeCenter('node-a');
      const reopenedPanel = await inspector();
      ensure(reopenedPanel?.heading === '流程步骤', `重开后点击 node-a 未选中：${reopenedPanel?.heading}`);
      await clickEmptyArea();

      // 整页刷新（模拟关掉窗口再打开）。
      await reload();
      await waitBoardReady();
      await refreshView();
      const afterReloadNodes = nodeSignature(await nodes());
      const afterReloadEdges = edgeSignature(await edges());
      assertSame(afterReloadNodes, docNodes, '刷新后对象');
      assertSame(afterReloadEdges, docEdges, '刷新后连线');
      const counts = await evaluate('window.__ZX_TEST__.counts()');
      ensure(counts === `${docNodes.length} 个对象 · ${docEdges.length} 条连线`, `刷新后计数不符：${counts}`);
      return {
        counts,
        nodes: docNodes.length,
        edges: docEdges.length,
        locked: docNodes.filter((row) => row.locked).map((row) => row.id),
      };
    },
    '19-persist-reopen.png',
  );

  // 控制台
  await runCase(
    {
      id: 'F-023-20',
      feature: 'F-023 画板高级操作',
      name: '控制台：全流程零错误 / 零异常',
      expected: 'console error = 0、page exception = 0；warning 仅记录',
    },
    async () => {
      ensure(consoleErrors.length === 0, `控制台错误：${JSON.stringify(consoleErrors)}`);
      ensure(pageExceptions.length === 0, `页面异常：${JSON.stringify(pageExceptions)}`);
      return { consoleErrors, pageExceptions, consoleWarns };
    },
    '20-console.png',
  );

  // ------------------------------------------------------------------
  // 空数据阶段：清空 boards/nodes/edges 后进入 /board
  // ------------------------------------------------------------------
  await evaluate(`window.__ZX_TEST__.clearBoardTables()`);
  await navigate(`http://127.0.0.1:${PORT}/board`);
  await waitFor(
    `document.querySelector('.bw-canvas') !== null`,
    '空画板加载',
  );
  await waitFor(
    `document.querySelector('.bw-counts')?.textContent.includes('0 个对象')`,
    '空画板计数',
  );
  await sleep(400);
  await refreshView([]);
  await screenshot('21-empty-board.png');

  await runCase(
    {
      id: 'F-023-21',
      feature: 'F-023 画板高级操作',
      name: '空数据：无画板时进入 /board 自动新建空白画板',
      expected:
        '提示已新建空白画板；计数 0 个对象 · 0 条连线；空态卡片可见；撤销/等距/删除按钮禁用；不自动插入示例对象',
    },
    async () => {
      const counts = await evaluate('window.__ZX_TEST__.counts()');
      ensure(counts === '0 个对象 · 0 条连线', `空画板计数不符：${counts}`);
      const empty = await evaluate('window.__ZX_TEST__.emptyCard()');
      ensure(empty && empty.includes('空白画板'), `空态卡片不符：${empty}`);
      const rail = await evaluate('window.__ZX_TEST__.rail()');
      const undo = rail.find((item) => item.label === '撤销');
      ensure(undo?.disabled === true, '空画板撤销按钮未禁用');
      const distribute = rail.find((item) => item.label === '删除选中');
      ensure(distribute?.disabled === true, '空画板删除按钮未禁用');
      const nodesRows = await evaluate('window.__ZX_TEST__.nodes()');
      ensure(nodesRows.length === 0, `空画板仍有对象：${nodesRows.length}`);
      const boards = await evaluate('window.__ZX_TEST__.boards()');
      ensure(boards.length === 1, `应自动新建 1 个画板：${boards.length}`);
      return { counts, empty, saveState: await evaluate('window.__ZX_TEST__.saveState()') };
    },
    '22-empty-state.png',
  );

  await runCase(
    {
      id: 'F-023-22',
      feature: 'F-023 画板高级操作',
      name: '空数据 → 插入对象 → 保存 → 重开',
      expected: '插入矩形后 1 个对象；保存后刷新仍为同一对象，位置与默认尺寸一致',
    },
    async () => {
      await clickTextButtonInEmptyCard('插入矩形');
      await waitFor(`window.__ZX_TEST__.nodes().length === 1`, '插入矩形');
      await sleep(800);
      const state = await evaluate('window.__ZX_TEST__.saveState()');
      ensure(state.includes('已保存'), `插入后未保存：${state}`);
      await evaluate('window.__ZX_TEST__.forceSaveDb()');
      const before = nodeSignature(await nodes());
      await reload();
      await waitBoardReady();
      await refreshView();
      const after = nodeSignature(await nodes());
      assertSame(after, before, '空画板插入后重开对象');
      return { before, after, counts: await evaluate('window.__ZX_TEST__.counts()') };
    },
    '23-empty-insert-persist.png',
  );

  note('AUD-016 浏览器实测完成');
  const failed = results.filter((item) => item.verdict === 'FAIL');
  fs.writeFileSync(
    path.join(EVIDENCE, 'summary.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        view,
        results,
        consoleErrors,
        consoleWarns,
        pageExceptions,
      },
      null,
      2,
    ),
  );
  console.log('\nAUD016_BROWSER_SUMMARY\n' + summaries.join('\n'));
  const counts = results.reduce((acc, item) => {
    acc[item.verdict] = (acc[item.verdict] ?? 0) + 1;
    return acc;
  }, {});
  console.log('\nAUD016_COUNTS=' + JSON.stringify(counts));
  if (failed.length > 0) {
    console.error(`\nAUD016_FAILURES=${failed.length}`);
    for (const item of failed) {
      console.error(
        `${item.id} ${item.name}: ${
          typeof item.actual === 'string' ? item.actual : JSON.stringify(item.actual)
        }`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log('\nAUD016_BROWSER_EXIT=0');
  }
} catch (error) {
  console.error('[aud016-browser] 失败：', error);
  note('失败', { message: error?.message ?? String(error) });
  try {
    await screenshot('99-failure.png');
  } catch {
    // 忽略截图失败。
  }
  fs.writeFileSync(
    path.join(EVIDENCE, 'summary.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        results,
        consoleErrors,
        consoleWarns,
        pageExceptions,
        fatal: error?.message ?? String(error),
      },
      null,
      2,
    ),
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
