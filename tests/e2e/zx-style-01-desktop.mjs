/**
 * ZX-STYLE-01 真实桌面视觉实测（1440×1000，Chrome DevTools Protocol）。
 *
 * 覆盖：
 *   - 今天、知识、设置三页的浅色 / 暗色截图；
 *   - 页面标题 20/650、卡片 13、按钮 32/28 + 8/6、控件 32；
 *   - 主按钮在蓝色 / 紫色强调色下只改 --accent 系，语义红不变；
 *   - :focus-visible 使用 2px --focus-ring；
 *   - 控制台零错误。
 *
 * 运行：pnpm build && node tests/e2e/zx-style-01-desktop.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/ZX-STYLE-01');
const FAKE_BUNDLE = '/tmp/zx-style-01-fake.js';
const PORT = 8899;
const DEBUG_PORT = 9227;
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

const userDataDir = `/tmp/zx-style-01-chrome-${Date.now()}`;
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
  const file = path.join(EVIDENCE, name);
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  console.log(`截图：${path.relative(ROOT, file)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function assertEqual(actual, expected, message) {
  assert(
    actual === expected,
    `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`,
  );
}

function assertNear(actual, expected, message, tolerance = 0.6) {
  assert(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}（期望 ${expected}±${tolerance}，实际 ${actual}）`,
  );
}

const appearanceScript = (theme, accent) =>
  `localStorage.setItem('zhixing.appearance.v1', JSON.stringify({theme:${JSON.stringify(
    theme,
  )},accent:${JSON.stringify(accent)},density:'comfortable'}));true`;

async function setAppearance(theme, accent) {
  await evaluate(appearanceScript(theme, accent));
}

async function navigate(url) {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${url}` });
}

const styleOf = (selector, properties) => `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return null;
  const style = getComputedStyle(node);
  return Object.fromEntries(${JSON.stringify(properties)}.map((property) => [
    property,
    style.getPropertyValue(property),
  ]));
})()`;

async function style(selector, properties) {
  const value = await evaluate(styleOf(selector, properties));
  assert(value, `找不到元素 ${selector}`);
  return value;
}

function px(value) {
  return Number.parseFloat(String(value).replace('px', ''));
}

function rgb(value) {
  const match = String(value).match(
    /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/,
  );
  if (!match) return null;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function luminance({ r, g, b }) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground, background) {
  const left = luminance(rgb(foreground));
  const right = luminance(rgb(background));
  const lighter = Math.max(left, right);
  const darker = Math.min(left, right);
  return (lighter + 0.05) / (darker + 0.05);
}

async function focusPrimary(selector) {
  // 先制造键盘交互，确保 Chrome 走 :focus-visible 分支。
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Shift',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 16,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Shift',
    code: 'ShiftLeft',
    windowsVirtualKeyCode: 16,
  });
  await evaluate(
    `document.querySelector(${JSON.stringify(selector)}).focus({preventScroll:true});true`,
  );
  return style(selector, [
    'outline-style',
    'outline-width',
    'outline-color',
    'outline-offset',
  ]);
}

const injection = `(() => {
  try {
    if (!localStorage.getItem('zhixing.appearance.v1')) {
      localStorage.setItem('zhixing.appearance.v1', JSON.stringify({
        theme: 'light', accent: 'blue', density: 'comfortable',
      }));
    }
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
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });

  /* ================= 浅色 ================= */
  // 初始外观由注入脚本写入 light/blue，避免在 about:blank 上访问 localStorage。
  await navigate('/today');
  await waitFor('Boolean(document.querySelector(".task-page-head h1"))', '今天页标题');
  const initError = await evaluate('window.__ZX_INIT_ERROR__ ?? null');
  if (initError) throw new Error(String(initError));
  await new Promise((resolve) => setTimeout(resolve, 500));

  const todayTitle = await style('.task-page-head h1', [
    'font-size',
    'font-weight',
    'color',
  ]);
  assertNear(px(todayTitle['font-size']), 20, '今天页标题字号应为 20');
  assertEqual(todayTitle['font-weight'], '650', '今天页标题字重应为 650');
  assertEqual(todayTitle.color, 'rgb(37, 44, 56)', '浅色标题应使用 --ink');

  const todayPrimary = await style('.task-button--primary', [
    'height',
    'border-radius',
    'font-size',
    'background-color',
    'color',
  ]);
  assertNear(px(todayPrimary.height), 32, '主按钮高度应为 32');
  assertNear(px(todayPrimary['border-radius']), 8, '主按钮圆角应为 8');
  assertNear(px(todayPrimary['font-size']), 12, '主按钮字号应为 12');
  assertEqual(todayPrimary['background-color'], 'rgb(85, 121, 213)', '蓝色主按钮背景');
  assertEqual(todayPrimary.color, 'rgb(255, 255, 255)', '主按钮文字应为 on-accent');

  const todayBrief = await style('.today-brief', ['border-radius', 'background-color']);
  assertNear(px(todayBrief['border-radius']), 13, '卡片圆角应为 13');

  const todaySub = await style('.task-page-sub', ['font-size', 'color']);
  assertNear(px(todaySub['font-size']), 12.5, '副标题字号应为 12.5');
  assertEqual(todaySub.color, 'rgb(127, 137, 153)', '浅色说明文字应使用 --muted');

  const todayFocus = await focusPrimary('.task-button--primary');
  assertEqual(todayFocus['outline-style'], 'solid', '按钮焦点环应为实线');
  assertNear(px(todayFocus['outline-width']), 2, '焦点环宽度应为 2');
  assertEqual(todayFocus['outline-color'], 'rgb(138, 166, 234)', '焦点环颜色');
  assertNear(px(todayFocus['outline-offset']), 2, '焦点环偏移应为 2');

  await screenshot('today-light.png');

  await navigate('/tasks');
  await waitFor('Boolean(document.querySelector(".task-center-page h1"))', '任务中心标题');
  await new Promise((resolve) => setTimeout(resolve, 500));

  const tasksTitle = await style('.task-center-page h1', ['font-size', 'font-weight']);
  assertNear(px(tasksTitle['font-size']), 20, '任务中心标题字号应为 20');
  assertEqual(tasksTitle['font-weight'], '650', '任务中心标题字重应为 650');

  const tasksPrimary = await style('.task-center-page .task-head-actions .task-button--primary', [
    'height',
    'border-radius',
    'background-color',
  ]);
  assertNear(px(tasksPrimary.height), 32, '任务中心主按钮高度应为 32');
  assertNear(px(tasksPrimary['border-radius']), 8, '任务中心主按钮圆角应为 8');
  assertEqual(tasksPrimary['background-color'], 'rgb(85, 121, 213)', '任务中心唯一主按钮');

  const quickAddPrimary = await evaluate(
    styleOf('.task-quick-add .task-button--primary', ['background-color']),
  );
  if (quickAddPrimary) {
    assertEqual(
      quickAddPrimary['background-color'],
      'rgb(255, 255, 255)',
      '快速新建按钮应降为次按钮，避免一屏两个主行动',
    );
  }

  const overviewCard = await style('.task-overview-card', ['border-radius']);
  assertNear(px(overviewCard['border-radius']), 13, '任务概览卡圆角应为 13');
  const filterPanel = await style('.task-center-filters', ['border-radius']);
  assertNear(px(filterPanel['border-radius']), 13, '筛选面板圆角应为 13');
  await screenshot('tasks-light.png');

  await navigate('/lists');
  await waitFor('Boolean(document.querySelector(".lists-page h1"))', '清单页标题');
  await new Promise((resolve) => setTimeout(resolve, 500));

  const listsTitle = await style('.lists-page h1', ['font-size', 'font-weight']);
  assertNear(px(listsTitle['font-size']), 20, '清单页标题字号应为 20');
  assertEqual(listsTitle['font-weight'], '650', '清单页标题字重应为 650');
  const listButton = await style('.lists-page .task-button', ['height', 'border-radius']);
  assertNear(px(listButton.height), 32, '清单页按钮高度应为 32');
  assertNear(px(listButton['border-radius']), 8, '清单页按钮圆角应为 8');
  const listCard = await evaluate(styleOf('.list-card', ['border-radius']));
  if (listCard) {
    assertNear(px(listCard['border-radius']), 13, '清单卡片圆角应为 13');
  }
  await screenshot('lists-light.png');

  await navigate('/knowledge');
  await waitFor('Boolean(document.querySelector(".kn-primary-button"))', '知识页新建按钮');
  await new Promise((resolve) => setTimeout(resolve, 500));

  const noteButton = await style('.kn-primary-button', [
    'height',
    'border-radius',
    'font-size',
  ]);
  assertNear(px(noteButton.height), 32, '知识页主按钮高度应为 32');
  assertNear(px(noteButton['border-radius']), 8, '知识页主按钮圆角应为 8');
  assertNear(px(noteButton['font-size']), 12, '知识页主按钮字号应为 12');

  const noteIcon = await style('.kn-icon-button', ['width', 'height', 'border-radius']);
  assertNear(px(noteIcon.width), 32, '知识页图标按钮宽应为 32');
  assertNear(px(noteIcon.height), 32, '知识页图标按钮高应为 32');
  assertNear(px(noteIcon['border-radius']), 8, '知识页图标按钮圆角应为 8');

  const emptyIcon = await evaluate(
    styleOf('.kn-editor-empty > span', ['font-size']),
  );
  if (emptyIcon) {
    assertNear(px(emptyIcon['font-size']), 28, '知识页空态图标应为 28');
  }

  const noteRows = await evaluate('document.querySelectorAll(".kn-note-open").length');
  if (noteRows > 0) {
    await evaluate('document.querySelector(".kn-note-open").click();true');
    await waitFor('Boolean(document.querySelector(".kn-title"))', '笔记标题');
    const noteTitle = await style('.kn-title', ['font-size', 'font-weight']);
    assertNear(px(noteTitle['font-size']), 24, '笔记标题字号应为 24');
    assertEqual(noteTitle['font-weight'], '700', '笔记标题字重应为 700');
    const noteMeta = await style('.kn-paper-meta', ['font-size', 'color']);
    assertNear(px(noteMeta['font-size']), 10.5, '笔记元信息字号应为 10.5');
    assertEqual(noteMeta.color, 'rgb(127, 137, 153)', '笔记元信息应使用 --muted');
  }

  await screenshot('knowledge-light.png');

  await navigate('/settings/appearance');
  await waitFor('Boolean(document.querySelector(".settings-head h1"))', '设置页标题');
  await new Promise((resolve) => setTimeout(resolve, 500));

  const settingsTitle = await style('.settings-head h1', [
    'font-size',
    'font-weight',
  ]);
  assertNear(px(settingsTitle['font-size']), 20, '设置页标题字号应为 20');
  assertEqual(settingsTitle['font-weight'], '650', '设置页标题字重应为 650');

  const settingsCard = await style('.settings-card', [
    'border-radius',
    'background-color',
  ]);
  assertNear(px(settingsCard['border-radius']), 13, '设置卡片圆角应为 13');
  assertEqual(settingsCard['background-color'], 'rgb(255, 255, 255)', '浅色卡片表面');

  const settingsButton = await style('.settings-button', [
    'height',
    'border-radius',
    'font-size',
  ]);
  assertNear(px(settingsButton.height), 32, '设置按钮高度应为 32');
  assertNear(px(settingsButton['border-radius']), 8, '设置按钮圆角应为 8');
  assertNear(px(settingsButton['font-size']), 12, '设置按钮字号应为 12');

  const segmented = await style('.settings-segmented-button', ['height', 'border-radius']);
  assertNear(px(segmented.height), 28, '分段按钮高度应为 28');
  assertNear(px(segmented['border-radius']), 6, '分段按钮圆角应为 6');

  const select = await style('.settings-select', ['height', 'border-radius']);
  assertNear(px(select.height), 32, '下拉框高度应为 32');
  assertNear(px(select['border-radius']), 8, '下拉框圆角应为 8');

  const swatch = await style('.settings-swatch', ['background-color']);
  assertEqual(swatch['background-color'], 'rgb(85, 121, 213)', '强调色色板应来自固定色板令牌');

  await screenshot('settings-light.png');

  /* ================= 强调色：紫色 ================= */
  await setAppearance('light', 'violet');
  await navigate('/today');
  await waitFor('Boolean(document.querySelector(".task-button--primary"))', '紫色强调色今天页');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const violetPrimary = await style('.task-button--primary', ['background-color']);
  assertEqual(
    violetPrimary['background-color'],
    'rgb(128, 102, 199)',
    '紫色强调色应只替换主色',
  );
  const violetTitle = await style('.task-page-head h1', ['color']);
  assertEqual(violetTitle.color, 'rgb(37, 44, 56)', '强调色不应改正文标题颜色');
  const semanticRed = await evaluate(
    `getComputedStyle(document.documentElement).getPropertyValue('--red').trim()`,
  );
  assertEqual(semanticRed, '#cf5f59', '强调色不应改语义红');
  await screenshot('today-accent-violet.png');

  /* ================= 暗色 ================= */
  await setAppearance('dark', 'blue');
  await navigate('/today');
  await waitFor('Boolean(document.querySelector(".task-page-head h1"))', '暗色今天页');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const darkMeta = await evaluate(`(() => ({
    theme: document.documentElement.dataset.theme,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    title: (() => {
      const style = getComputedStyle(document.querySelector('.task-page-head h1'));
      return { color: style.color, size: style.fontSize, weight: style.fontWeight };
    })(),
    card: (() => {
      const style = getComputedStyle(document.querySelector('.today-brief'));
      return { bg: style.backgroundColor, radius: style.borderRadius };
    })(),
    surface: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  }))()`);
  assertEqual(darkMeta.theme, 'dark', 'html 应写入 data-theme=dark');
  assertEqual(darkMeta.bodyBg, 'rgb(23, 27, 36)', '暗色应用底色');
  assertEqual(darkMeta.title.color, 'rgb(231, 234, 241)', '暗色标题使用 --ink');
  assertNear(px(darkMeta.title.size), 20, '暗色标题字号仍为 20');
  assertEqual(darkMeta.title.weight, '650', '暗色标题字重仍为 650');
  assertEqual(darkMeta.card.bg, 'rgb(32, 38, 51)', '暗色卡片使用 --surface');
  assertNear(px(darkMeta.card.radius), 13, '暗色卡片圆角仍为 13');
  assert(
    contrast(darkMeta.title.color, darkMeta.card.bg) >= 7,
    '暗色标题与卡片表面对比度应 ≥ 7:1',
  );
  assert(darkMeta.surface !== darkMeta.bg, '暗色表面应与底色分层');
  await screenshot('today-dark.png');

  await navigate('/tasks');
  await waitFor('Boolean(document.querySelector(".task-center-page h1"))', '暗色任务中心');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const darkTaskCenter = await evaluate(`(() => ({
    bg: getComputedStyle(document.body).backgroundColor,
    card: getComputedStyle(document.querySelector('.task-overview-card')).backgroundColor,
    title: getComputedStyle(document.querySelector('.task-center-page h1')).color,
    button: getComputedStyle(document.querySelector('.task-center-page .task-head-actions .task-button--primary')).height,
  }))()`);
  assertEqual(darkTaskCenter.card, 'rgb(32, 38, 51)', '暗色任务概览卡表面');
  assertEqual(darkTaskCenter.title, 'rgb(231, 234, 241)', '暗色任务中心标题');
  assertNear(px(darkTaskCenter.button), 32, '暗色任务中心主按钮高度');
  await screenshot('tasks-dark.png');

  await navigate('/lists');
  await waitFor('Boolean(document.querySelector(".lists-page h1"))', '暗色清单页');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const darkLists = await evaluate(`(() => ({
    title: getComputedStyle(document.querySelector('.lists-page h1')).color,
    button: getComputedStyle(document.querySelector('.lists-page .task-button')).height,
    card: document.querySelector('.list-card')
      ? getComputedStyle(document.querySelector('.list-card')).backgroundColor
      : null,
  }))()`);
  assertEqual(darkLists.title, 'rgb(231, 234, 241)', '暗色清单页标题');
  assertNear(px(darkLists.button), 32, '暗色清单页按钮高度');
  if (darkLists.card) {
    assertEqual(darkLists.card, 'rgb(32, 38, 51)', '暗色清单卡片表面');
  }
  await screenshot('lists-dark.png');

  await navigate('/knowledge');
  await waitFor('Boolean(document.querySelector(".kn-primary-button"))', '暗色知识页');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const darkNoteButton = await style('.kn-primary-button', ['background-color']);
  assertEqual(darkNoteButton['background-color'], 'rgb(85, 121, 213)', '暗色主按钮仍用强调色');
  await screenshot('knowledge-dark.png');

  await navigate('/settings/appearance');
  await waitFor('Boolean(document.querySelector(".settings-head h1"))', '暗色设置页');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const darkSettings = await evaluate(`(() => ({
    card: getComputedStyle(document.querySelector('.settings-card')).backgroundColor,
    title: getComputedStyle(document.querySelector('.settings-head h1')).color,
    cardRadius: getComputedStyle(document.querySelector('.settings-card')).borderRadius,
    buttonHeight: getComputedStyle(document.querySelector('.settings-button')).height,
  }))()`);
  assertEqual(darkSettings.card, 'rgb(32, 38, 51)', '暗色设置卡片表面');
  assertEqual(darkSettings.title, 'rgb(231, 234, 241)', '暗色设置标题');
  assertNear(px(darkSettings.cardRadius), 13, '暗色设置卡片圆角');
  assertNear(px(darkSettings.buttonHeight), 32, '暗色设置按钮高度');
  await screenshot('settings-dark.png');

  console.log(
    '验收摘要：',
    JSON.stringify({
      light: {
        title: `${todayTitle['font-size']}/${todayTitle['font-weight']}`,
        primary: `${todayPrimary.height}/${todayPrimary['border-radius']}`,
        card: todayBrief['border-radius'],
        focus: `${todayFocus['outline-width']} ${todayFocus['outline-color']}`,
      },
      dark: {
        bg: darkMeta.bodyBg,
        surface: darkMeta.card.bg,
        title: darkMeta.title.color,
        contrast: Number(contrast(darkMeta.title.color, darkMeta.card.bg).toFixed(2)),
      },
      accent: { violet: violetPrimary['background-color'], red: semanticRed },
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
