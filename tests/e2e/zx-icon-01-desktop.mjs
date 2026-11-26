/**
 * ZX-ICON-01 真实桌面实测（1280×900，Chrome DevTools Protocol）：
 *
 * - 画板工具轨：分组标题、24 个按钮、18px SVG、常显标签、无原始字形；
 * - 笔记工具轨：编辑/面板/视图分组、10 个按钮、16px SVG、常显标签；
 * - 1280 宽保持带标签布局，<1280 / <1180 收为纯图标；
 * - 截图留证到 tests/evidence/ZX-ICON-01，并检查控制台零错误。
 *
 * 运行：pnpm build && node tests/e2e/zx-icon-01-desktop.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/ZX-ICON-01');
const FAKE_BUNDLE = '/tmp/zx-icon-01-fake.js';
const PORT = 8897;
const DEBUG_PORT = 9226;
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

const userDataDir = `/tmp/zx-icon-01-chrome-${Date.now()}`;
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

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

const BANNED = [
  '⌖', '✋', '▭', '▢', '○', '◇', '▤', '▥', '▦', '↗', '✦', '╱', '⌐',
  '⌒', '↶', '↷', '⇤', '↔', '⇥', '⇧', '↕', '⇩', '⌫', '◐', '✎', '⌸',
  '◌', '◉', '≡', '▧', '⛶', '⇄', '☰', 'ⓘ', '⌁', '‹', '›', '⠿', '＋',
];

const inspection = (selector) => `(() => {
  const rail = document.querySelector(${JSON.stringify(selector)});
  if (!rail) return null;
  const buttons = Array.from(rail.querySelectorAll('button'));
  const svgs = buttons.map((button) => button.querySelector('svg'));
  return {
    width: Math.round(rail.getBoundingClientRect().width),
    height: Math.round(rail.getBoundingClientRect().height),
    texts: Array.from(rail.querySelectorAll('.bw-rail-title, .kn-rail-title')).map((node) => node.textContent.trim()),
    captions: Array.from(rail.querySelectorAll('.bw-tool-caption, .kn-rail-caption'))
      .filter((node) => getComputedStyle(node).display !== 'none')
      .map((node) => node.textContent.trim()),
    buttonCount: buttons.length,
    buttons: buttons.map((button) => ({
      label: button.getAttribute('aria-label'),
      title: button.getAttribute('title'),
      hasSvg: Boolean(button.querySelector('svg')),
      viewBox: button.querySelector('svg')?.getAttribute('viewBox') ?? '',
      stroke: button.querySelector('svg')?.getAttribute('stroke') ?? '',
      width: button.querySelector('svg')?.getAttribute('width') ?? '',
      hidden: button.querySelector('svg')?.getAttribute('aria-hidden') ?? '',
      icon: button.querySelector('svg')?.getAttribute('data-icon') ?? '',
    })),
    svgCount: svgs.filter(Boolean).length,
    text: rail.textContent || '',
  };
})()`;

const injection = `(() => {
  try {
    localStorage.setItem('zhixing.appearance.v1', JSON.stringify({
      theme: 'light', accent: 'blue', density: 'comfortable',
    }));
  } catch (error) {}
  __ZX_FAKE_BUNDLE__
  try {
    const world = ZXFake.createFakeWorld();
    world.install();
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
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  /* ---------- 画板 1280×900 ---------- */
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/board` });
  await waitFor('Boolean(document.querySelector(".bw-rail"))', '画板工具轨');
  const initError = await evaluate('window.__ZX_INIT_ERROR__ ?? null');
  if (initError) throw new Error(String(initError));
  await new Promise((resolve) => setTimeout(resolve, 400));

  const board = await evaluate(inspection('.bw-rail'));
  assert(board, '画板工具轨不存在');
  assert(board.width === 76, `1280 宽工具轨应为 76px，实际 ${board.width}`);
  assert(board.buttonCount === 24, `画板按钮应为 24，实际 ${board.buttonCount}`);
  assert(board.svgCount === 24, `24 个按钮都应含 SVG，实际 ${board.svgCount}`);
  assert(
    board.texts.join('/') === '选择/形状/连线/编辑/对齐',
    `分组标题错误：${board.texts.join('/')}`,
  );
  assert(board.captions.length === 15, `常显标签应为 15，实际 ${board.captions.length}`);
  for (const button of board.buttons) {
    assert(button.label, `按钮缺少 aria-label：${button.icon}`);
    assert(button.title, `按钮缺少 title：${button.icon}`);
    assert(button.hasSvg, `按钮缺少 SVG：${button.label}`);
    assert(button.viewBox === '0 0 24 24', `viewBox 错误：${button.label}`);
    assert(button.stroke === 'currentColor', `颜色未用 currentColor：${button.label}`);
    assert(button.width === '18', `图标尺寸应为 18：${button.label} ${button.width}`);
    assert(button.hidden === 'true', `图标未 aria-hidden：${button.label}`);
  }
  for (const glyph of BANNED) {
    assert(!board.text.includes(glyph), `画板工具轨仍含原始字形：${glyph}`);
  }
  await screenshot('board-1280x900.png');

  /* ---------- 笔记 1280×900 ---------- */
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/knowledge` });
  await waitFor('Boolean(document.querySelector(".kn-rail"))', '笔记工具轨');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const note = await evaluate(inspection('.kn-rail'));
  assert(note, '笔记工具轨不存在');
  assert(note.width === 60, `1280 宽笔记工具轨应为 60px，实际 ${note.width}`);
  assert(note.buttonCount === 11, `笔记按钮应为 11（含折叠），实际 ${note.buttonCount}`);
  assert(note.svgCount === 11, `11 个按钮都应含 SVG，实际 ${note.svgCount}`);
  assert(
    note.texts.join('/') === '编辑/面板/视图',
    `笔记分组标题错误：${note.texts.join('/')}`,
  );
  assert(note.captions.length === 10, `笔记常显标签应为 10，实际 ${note.captions.length}`);
  for (const button of note.buttons) {
    assert(button.label, `笔记按钮缺少 aria-label：${button.icon}`);
    assert(button.title, `笔记按钮缺少 title：${button.icon}`);
    assert(button.hasSvg, `笔记按钮缺少 SVG：${button.label}`);
    assert(button.viewBox === '0 0 24 24', `笔记 viewBox 错误：${button.label}`);
    assert(button.stroke === 'currentColor', `笔记颜色未用 currentColor：${button.label}`);
    assert(button.width === '16' || button.width === '14', `笔记图标尺寸错误：${button.label} ${button.width}`);
    assert(button.hidden === 'true', `笔记图标未 aria-hidden：${button.label}`);
  }
  for (const glyph of BANNED) {
    assert(!note.text.includes(glyph), `笔记工具轨仍含原始字形：${glyph}`);
  }
  await screenshot('knowledge-1280x900.png');

  /* ---------- 响应式：1179 宽纯图标 ---------- */
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1179,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const narrowNote = await evaluate(inspection('.kn-rail'));
  assert(narrowNote.width === 36, `1179 宽笔记工具轨应为 36px，实际 ${narrowNote.width}`);
  assert(narrowNote.captions.length === 0, '1179 宽笔记标签应收起');
  // 画板页未同时渲染，48px 规则由 CSS 媒体查询覆盖，这里切换页面复核。
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/board` });
  await waitFor('Boolean(document.querySelector(".bw-rail"))', '窄屏画板工具轨');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const narrowBoardRail = await evaluate(inspection('.bw-rail'));
  assert(
    narrowBoardRail.width === 48,
    `1179 宽画板工具轨应为 48px，实际 ${narrowBoardRail.width}`,
  );
  assert(narrowBoardRail.captions.length === 0, '1179 宽画板标签应收起');
  console.log(
    '响应式摘要：',
    JSON.stringify({
      noteWidth: narrowNote.width,
      noteCaptions: narrowNote.captions.length,
      boardWidth: narrowBoardRail.width,
      boardCaptions: narrowBoardRail.captions.length,
      boardHeight: narrowBoardRail.height,
    }),
  );

  console.log(
    '验收摘要：',
    JSON.stringify({
      board: { width: board.width, buttons: board.buttonCount, captions: board.captions.length },
      note: { width: note.width, buttons: note.buttonCount, captions: note.captions.length },
    }),
  );
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
