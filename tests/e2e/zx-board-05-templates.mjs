/**
 * ZX-BOARD-05 画板模板库实测。
 *
 * 用真实构建产物 app/dist + Chrome DevTools Protocol：
 *   1. 注入 tests/harness/fakeTauri.ts，得到可持久化的浏览器内 Tauri IPC；
 *   2. 每个模板单独开一块空画板，从「起步结构」弹层点击插入；
 *   3. 校验持久化到 fake DB 的对象数量、几何、连线、未锁定、无模板模式字段；
 *   4. 逐个截图；最后插入「时间线 + 增长飞轮」并刷新页面验证保存重开；
 *   5. 控制台零错误。
 *
 * 运行：pnpm build && node tests/e2e/zx-board-05-templates.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/ZX-BOARD-05');
const FAKE_BUNDLE = '/tmp/zx-board-05-fake.js';
const STORAGE_KEY = 'zx_board05_db';
const PORT = 8897;
const DEBUG_PORT = 9226;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('找不到 app/dist，请先运行 pnpm build');
}
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

const userDataDir = `/tmp/zx-board-05-chrome-${Date.now()}`;
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

async function clearLocalStorage() {
  await send('Storage.clearDataForOrigin', {
    origin: ORIGIN,
    storageTypes: 'local_storage',
  });
}

async function openBoard() {
  await send('Page.navigate', { url: `${ORIGIN}/board` });
  await waitFor('Boolean(document.querySelector(".bw-canvas"))', '画板加载');
  await waitFor(
    'document.body.textContent.includes("空白画板")',
    '空画板首屏',
  );
  const initError = await evaluate('window.__ZX_INIT_ERROR__ ?? null');
  if (initError) throw new Error(String(initError));
}

async function openStarterDialog() {
  const opened = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (item) =>
        (item.textContent || '').includes('起步结构') ||
        item.getAttribute('aria-label') === '起步结构',
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!opened) throw new Error('找不到「起步结构」入口');
  await waitFor(
    'Boolean(document.querySelector(".bw-starter-card"))',
    '模板弹层',
  );
}

async function clickTemplate(title) {
  const clicked = await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.bw-starter-card')).find(
      (item) => (item.querySelector('strong')?.textContent || '').trim() === ${JSON.stringify(title)},
    );
    if (!card) return false;
    card.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`找不到模板卡片：${title}`);
  await waitFor(
    '!document.querySelector(".bw-starter-card")',
    `模板弹层关闭：${title}`,
  );
}

async function dismissSelection() {
  await evaluate(`(() => {
    const canvas = document.querySelector('.bw-canvas');
    if (!canvas) return false;
    canvas.focus();
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function readBoard() {
  return evaluate(`(() => {
    const db = window.__ZX_WORLD__.db;
    const nodes = db.nodes.filter((node) => !node.deletedAt).map((node) => ({
      id: node.id,
      type: node.nodeType,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      text: node.text,
      zIndex: node.zIndex,
      payload: node.payload ?? {},
    }));
    const edges = db.edges.filter((edge) => !edge.deletedAt).map((edge) => ({
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      style: edge.style ?? {},
    }));
    return { nodes, edges };
  })()`);
}

function fail(message) {
  throw new Error(`断言失败：${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${message}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`);
  }
}

function countTypes(nodes, type) {
  return nodes.filter((node) => node.type === type).length;
}

const TEMPLATES = [
  {
    kind: 'flow',
    title: '流程图',
    nodes: 6,
    edges: 5,
    verify(board) {
      assertEqual(
        {
          pill: countTypes(board.nodes, 'pill'),
          rect: countTypes(board.nodes, 'rect'),
          diamond: countTypes(board.nodes, 'diamond'),
        },
        { pill: 2, rect: 3, diamond: 1 },
        '流程图类型构成',
      );
    },
  },
  {
    kind: 'timeline',
    title: '时间线',
    nodes: 12,
    edges: 0,
    verify(board) {
      const rect = board.nodes.filter((node) => node.type === 'rect');
      assertEqual(rect.length, 1, '时间线轴数量');
      assertEqual(
        [rect[0].x, rect[0].y, rect[0].width, rect[0].height],
        [0, 120, 760, 6],
        '时间线轴几何',
      );
      const dots = board.nodes.filter((node) => node.type === 'ellipse');
      assertEqual(dots.length, 5, '时间线圆点数量');
      assert(
        dots.every((dot) => dot.width === 24 && dot.height === 24),
        '时间线圆点尺寸',
      );
      assertEqual(countTypes(board.nodes, 'text'), 6, '时间线文字对象数量');
    },
  },
  {
    kind: 'lane',
    title: '泳道 · 横向',
    nodes: 9,
    edges: 0,
    verify(board) {
      const frames = board.nodes.filter((node) => node.type === 'frame');
      const stickies = board.nodes.filter((node) => node.type === 'sticky');
      assertEqual(frames.length, 3, '横向泳道容器数量');
      assertEqual(stickies.length, 6, '横向泳道便签数量');
      assert(
        frames.every((frame) => frame.width === 880 && frame.height === 140),
        '横向泳道容器尺寸',
      );
      assert(
        stickies.every((sticky) => sticky.width === 180 && sticky.height === 76),
        '横向泳道便签尺寸',
      );
      assert(
        Math.min(...stickies.map((sticky) => sticky.zIndex)) >
          Math.max(...frames.map((frame) => frame.zIndex)),
        '便签应在容器上层',
      );
    },
  },
  {
    kind: 'lane-vertical',
    title: '泳道 · 纵向',
    nodes: 9,
    edges: 0,
    verify(board) {
      const frames = board.nodes.filter((node) => node.type === 'frame');
      const stickies = board.nodes.filter((node) => node.type === 'sticky');
      assertEqual(frames.length, 3, '纵向泳道容器数量');
      assertEqual(stickies.length, 6, '纵向泳道便签数量');
      assert(
        frames.every((frame) => frame.width === 280 && frame.height === 420),
        '纵向泳道容器尺寸',
      );
      assert(
        stickies.every((sticky) => sticky.width === 220 && sticky.height === 100),
        '纵向泳道便签尺寸',
      );
    },
  },
  {
    kind: 'org',
    title: '组织架构',
    nodes: 10,
    edges: 9,
    verify(board) {
      assertEqual(countTypes(board.nodes, 'round'), 1, '组织架构负责人数量');
      assertEqual(countTypes(board.nodes, 'rect'), 9, '组织架构部门/小组数量');
      assert(
        board.edges.every(
          (edge) => edge.style.routing === 'elbow' && edge.style.fromSide === 'b',
        ),
        '组织架构应使用向下折线',
      );
    },
  },
  {
    kind: 'sys',
    title: '系统架构',
    nodes: 12,
    edges: 6,
    verify(board) {
      const frames = board.nodes.filter((node) => node.type === 'frame');
      const blocks = board.nodes.filter((node) => node.type === 'round');
      assertEqual(frames.length, 3, '系统架构层容器数量');
      assertEqual(blocks.length, 9, '系统架构方块数量');
      assert(
        frames.every((frame) => frame.width === 760 && frame.height === 120),
        '系统架构层容器尺寸',
      );
      assert(
        board.edges.every((edge) => edge.style.routing === 'straight'),
        '系统架构应使用直线',
      );
    },
  },
  {
    kind: 'pyramid',
    title: '金字塔',
    nodes: 4,
    edges: 0,
    verify(board) {
      const widths = board.nodes.map((node) => node.width);
      assertEqual(widths, [600, 460, 320, 180], '金字塔层宽递减');
      assert(
        board.nodes.every((node) => node.x + node.width / 2 === 380),
        '金字塔层应水平居中',
      );
    },
  },
  {
    kind: 'mind',
    title: '思维导图',
    nodes: 6,
    edges: 5,
    verify(board) {
      assertEqual(countTypes(board.nodes, 'ellipse'), 1, '思维导图中心数量');
      assertEqual(countTypes(board.nodes, 'round'), 5, '思维导图分支数量');
      assert(
        board.edges.every((edge) => edge.style.routing === 'curve'),
        '思维导图应使用曲线',
      );
    },
  },
  {
    kind: 'flywheel',
    title: '增长飞轮',
    nodes: 6,
    edges: 5,
    verify(board) {
      const pills = board.nodes.filter((node) => node.type === 'pill');
      assertEqual(pills.length, 5, '增长飞轮环节数量');
      assertEqual(countTypes(board.nodes, 'text'), 1, '增长飞轮中心标题数量');
      assert(
        board.edges.every(
          (edge) =>
            edge.style.routing === 'curve' &&
            String(edge.style.color).includes('--board-teal-stroke'),
        ),
        '增长飞轮应为 5 条闭合曲线',
      );
      const ids = pills.map((pill) => pill.id);
      assertEqual(
        board.edges.map((edge) => [edge.fromNodeId, edge.toNodeId]),
        pills.map((pill, index) => [pill.id, ids[(index + 1) % 5]]),
        '增长飞轮首尾相接',
      );
    },
  },
];

const injection = `(() => {
  try {
    localStorage.setItem('zhixing.appearance.v1', JSON.stringify({
      theme: 'light', accent: 'blue', density: 'comfortable',
    }));
  } catch (error) {}
  __ZX_FAKE_BUNDLE__
  try {
    const saved = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
    const world = ZXFake.createFakeWorld({ empty: true });
    world.db.boards = [];
    world.db.nodes = [];
    world.db.edges = [];
    if (saved) {
      const snapshot = JSON.parse(saved);
      if (Array.isArray(snapshot.boards)) world.db.boards = snapshot.boards;
      if (Array.isArray(snapshot.nodes)) world.db.nodes = snapshot.nodes;
      if (Array.isArray(snapshot.edges)) world.db.edges = snapshot.edges;
    }
    world.install();
    const originalInvoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await originalInvoke(command, args);
      try {
        localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, JSON.stringify({
          boards: world.db.boards,
          nodes: world.db.nodes,
          edges: world.db.edges,
        }));
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

  for (const [index, template] of TEMPLATES.entries()) {
    await clearLocalStorage();
    await openBoard();
    await openStarterDialog();

    const library = await evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('.bw-starter-card'));
      return {
        cards: cards.length,
        groups: Array.from(document.querySelectorAll('.bw-starter-group h3')).map(
          (heading) => heading.textContent,
        ),
        previews: cards.filter((card) => card.querySelector('.bw-starter-preview svg')).length,
        titles: cards.map((card) => card.querySelector('strong')?.textContent ?? ''),
        firstFocused: document.activeElement?.classList.contains('bw-starter-card') === true,
      };
    })()`);
    assertEqual(library.cards, 9, '模板卡片数量');
    assertEqual(
      library.groups,
      ['流程与阶段', '结构与系统', '发散与闭环'],
      '模板分组',
    );
    assertEqual(library.previews, 9, '每个模板都有缩略预览');
    assert(library.firstFocused, '弹层打开后首卡应自动聚焦');
    if (index === 0) {
      await screenshot('01-template-library.png');
    }

    await clickTemplate(template.title);
    await waitFor(
      `(() => {
        const db = window.__ZX_WORLD__.db;
        return db.nodes.filter((row) => !row.deletedAt).length === ${template.nodes};
      })()`,
      `${template.title} 对象落库`,
    );
    await waitFor(
      `(() => {
        const db = window.__ZX_WORLD__.db;
        return db.edges.filter((row) => !row.deletedAt).length === ${template.edges};
      })()`,
      `${template.title} 连线落库`,
    );

    const board = await readBoard();
    assertEqual(board.nodes.length, template.nodes, `${template.title} 对象数量`);
    assertEqual(board.edges.length, template.edges, `${template.title} 连线数量`);
    assert(
      board.nodes.every((node) => node.payload.locked === false),
      `${template.title} 对象不应锁定`,
    );
    assert(
      board.nodes.every(
        (node) =>
          node.payload.templateId === undefined &&
          node.payload.groupId === undefined,
      ),
      `${template.title} 不应写模板/分组模式字段`,
    );
    template.verify(board);

    const headerCounts = await evaluate(
      'document.querySelector(".bw-counts")?.textContent ?? ""',
    );
    assert(
      headerCounts.includes(`${template.nodes} 个对象`) &&
        headerCounts.includes(`${template.edges} 条连线`),
      `${template.title} 顶部计数：${headerCounts}`,
    );

    await dismissSelection();
    await screenshot(
      `${String(index + 2).padStart(2, '0')}-template-${template.kind}.png`,
    );
    console.log(
      `模板通过：${template.title} · ${template.nodes} 个对象 · ${template.edges} 条连线`,
    );
  }

  // 已有内容下方插入 + 保存重开。
  await clearLocalStorage();
  await openBoard();
  await openStarterDialog();
  await clickTemplate('时间线');
  await waitFor(
    '(() => window.__ZX_WORLD__.db.nodes.filter((row) => !row.deletedAt).length === 12)()',
    '时间线落库',
  );
  const timeline = await readBoard();
  const timelineBottom = Math.max(
    ...timeline.nodes.map((node) => node.y + node.height),
  );

  await openStarterDialog();
  await clickTemplate('增长飞轮');
  await waitFor(
    '(() => window.__ZX_WORLD__.db.nodes.filter((row) => !row.deletedAt).length === 18)()',
    '增长飞轮落库',
  );
  const combined = await readBoard();
  const timelineIds = new Set(timeline.nodes.map((node) => node.id));
  const flywheelNodes = combined.nodes.filter(
    (node) => !timelineIds.has(node.id),
  );
  assertEqual(flywheelNodes.length, 6, '第二个模板对象数量');
  assertEqual(
    Math.min(...flywheelNodes.map((node) => node.y)),
    timelineBottom + 80,
    '第二个模板应放在现有内容下方 80',
  );
  assert(
    flywheelNodes.every((node) => node.y >= timelineBottom + 80),
    '第二个模板不应覆盖现有内容',
  );
  assertEqual(combined.edges.length, 5, '时间线 + 飞轮连线数量');

  await waitFor(
    `(() => {
      const saved = JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) || '{}');
      return (saved.nodes ?? []).filter((row) => !row.deletedAt).length === 18;
    })()`,
    '保存到 localStorage',
  );
  await dismissSelection();
  await screenshot('11-before-reopen.png');

  await send('Page.navigate', { url: `${ORIGIN}/board` });
  await waitFor('Boolean(document.querySelector(".bw-canvas"))', '重开画板加载');
  await waitFor(
    'document.body.textContent.includes("18 个对象 · 5 条连线")',
    '重开后保持 18 个对象/5 条连线',
  );
  const reopened = await readBoard();
  assertEqual(reopened.nodes.length, 18, '重开后对象数量');
  assertEqual(reopened.edges.length, 5, '重开后连线数量');
  assertEqual(
    Math.min(...reopened.nodes.filter((node) => !timelineIds.has(node.id)).map((node) => node.y)),
    timelineBottom + 80,
    '重开后模板位置保持',
  );
  await dismissSelection();
  await screenshot('12-after-reopen.png');
  console.log('保存重开通过：18 个对象 · 5 条连线，模板位置保持');

  const summary = await evaluate(`(() => ({
    counts: document.querySelector('.bw-counts')?.textContent ?? '',
    zoom: document.querySelector('.bw-zoom-value')?.textContent ?? '',
    canvas: Boolean(document.querySelector('.bw-canvas')),
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
