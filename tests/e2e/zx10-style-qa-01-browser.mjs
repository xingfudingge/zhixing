/**
 * ZX10-STYLE-QA-01 独立验收：知识页「样式」面板贴右。
 *
 * 真实生产构建 + 真实 Chromium（CDP），只注入 tests/harness/fakeTauri.ts
 * 的内存 IPC 替身；产品代码与既有测试均不修改。
 *
 * 覆盖卡片必测：
 *   1. 打开笔记 → 点右栏「样式」：面板在编辑器右侧，left:auto、right:12px；
 *   2. 1280 / 1024 / 900：不遮右栏 9 项、不溢出、不覆盖触发按钮；
 *      右栏折叠与窄屏抽屉仍正确；
 *   3. 关闭/重开、切块、切笔记、快速连点：位置不漂移；Esc 与焦点行为；
 *   4. H1–H5 / 行内格式 / 待办 / 列表 / 引用 / 代码 / 链接仍可用；
 *   5. 刷新、空块笔记、删除不存在项、控制台零报错。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx10-style-qa-01-browser.mjs
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
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx10-style-qa-01');
const FAKE_BUNDLE = '/tmp/zx-fake-zx10-style-qa-01.js';
const PORT = 8931;
const DEBUG_PORT = 9251;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NOTE_A = 'ZX10 样式面板验收 A';
const NOTE_B = 'ZX10 样式面板验收 B';
const NOTE_EMPTY = 'ZX10 样式面板空块笔记';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先运行 pnpm --filter app build');
}
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

const results = [];
const observations = [];
const geometry = {};
function check(ok, id, message, actual) {
  const actualText =
    actual === undefined ? '' : `（实际：${JSON.stringify(actual)}）`;
  results.push({ id, ok: Boolean(ok), message, actual });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${message}${actualText}`);
}
function observation(id, message, actual) {
  observations.push({ id, message, actual });
  console.log(`[OBS] ${id} ${message}（实际：${JSON.stringify(actual)}）`);
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

const userDataDir = `/tmp/zx-chrome-zx10-style-qa-01-${Date.now()}`;
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
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`等待超时：${label}（最后值：${JSON.stringify(last)}）`);
}

async function screenshot(name, clip) {
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  });
  fs.writeFileSync(
    path.join(EVIDENCE, name),
    Buffer.from(result.data, 'base64'),
  );
  console.log(`截图：tests/evidence/zx10-style-qa-01/${name}`);
}

async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
}

async function clickSelector(selector, label) {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 140));
  const point = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      disabled: Boolean(el.disabled),
    };
  })()`);
  if (!point || point.width <= 0 || point.height <= 0) {
    throw new Error(`找不到可点击元素：${label ?? selector}`);
  }
  if (point.disabled) {
    throw new Error(`元素被禁用：${label ?? selector}`);
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
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
  await new Promise((resolve) => setTimeout(resolve, 160));
}

/**
 * 知识页存在既有「Esc 双重消费」现象：编辑器先关样式面板，知识页随后把
 * 同一次按键当成展开/还原。它不是本卡 CSS 修复引入的；测试在记录后复位，
 * 避免影响后续笔记切换。
 */
async function resetExpanded() {
  const className = await evaluate(
    `document.querySelector('.kn-workspace')?.className ?? ''`,
  );
  if (!String(className).includes('is-expanded')) return false;
  const restored = await evaluate(`(() => {
    const button = document.querySelector('[aria-label="还原目录与列表"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!restored) {
    await pressEscape();
  }
  await waitFor(
    `!(document.querySelector('.kn-workspace')?.className ?? '').includes('is-expanded')`,
    '复位展开布局',
  );
  return true;
}

const PAGE_HELPERS = String.raw`
window.__STYLEQA__ = {
  rect(element) {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      left: +rect.left.toFixed(1),
      top: +rect.top.toFixed(1),
      right: +rect.right.toFixed(1),
      bottom: +rect.bottom.toFixed(1),
      width: +rect.width.toFixed(1),
      height: +rect.height.toFixed(1),
    };
  },
  rectOf(selector) {
    return this.rect(document.querySelector(selector));
  },
  intersection(a, b) {
    if (!a || !b) return 0;
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return +(width * height).toFixed(1);
  },
  panel() { return document.querySelector('.zxe-stylepanel'); },
  zxe() { return document.querySelector('.zxe'); },
  editorMain() { return document.querySelector('.kn-editor-main'); },
  rail() { return document.querySelector('.kn-rail'); },
  trigger() { return document.querySelector('[data-rail-tool="style"]'); },
  commandStyle() { return document.querySelector('[aria-label^="样式菜单："]'); },
  toolsButton() { return document.querySelector('.kn-cmd-tools'); },
  drawer() { return document.querySelector('.kn-tools-drawer'); },
  drawerRows() {
    return Array.from(document.querySelectorAll('.kn-tools-drawer .kn-drawer-row')).map((row) => ({
      label: row.getAttribute('aria-label'),
      disabled: Boolean(row.disabled),
      rect: this.rect(row),
    }));
  },
  railTools() {
    return Array.from(document.querySelectorAll('.kn-rail [data-rail-tool]')).map((button) => {
      const rect = this.rect(button);
      return {
        key: button.getAttribute('data-rail-tool'),
        label: button.getAttribute('aria-label'),
        disabled: Boolean(button.disabled),
        rect,
        visible: Boolean(rect && rect.width > 0 && rect.height > 0),
      };
    });
  },
  cssRule(selector) {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules = [];
      try { rules = Array.from(sheet.cssRules || []); } catch { rules = []; }
      for (const rule of rules) {
        if (rule.selectorText === selector && rule.style) {
          return {
            selectorText: rule.selectorText,
            left: rule.style.getPropertyValue('left'),
            right: rule.style.getPropertyValue('right'),
            top: rule.style.getPropertyValue('top'),
            position: rule.style.getPropertyValue('position'),
            zIndex: rule.style.getPropertyValue('z-index'),
            width: rule.style.getPropertyValue('width'),
            maxHeight: rule.style.getPropertyValue('max-height'),
          };
        }
      }
    }
    return null;
  },
  panelRule() { return this.cssRule('.zxe--external-rail .zxe-stylepanel'); },
  activeElement() {
    const el = document.activeElement;
    return el ? {
      tag: el.tagName,
      cls: typeof el.className === 'string' ? el.className : '',
      ariaLabel: el.getAttribute?.('aria-label') ?? null,
      railTool: el.getAttribute?.('data-rail-tool') ?? null,
      isStyleTrigger: el === this.trigger(),
      isToolsButton: el === this.toolsButton(),
      isBody: el === document.body,
    } : null;
  },
  snapshot() {
    const panel = this.panel();
    const zxe = this.zxe();
    const main = this.editorMain();
    const rail = this.rail();
    const panelRect = this.rect(panel);
    const zxeRect = this.rect(zxe);
    const mainRect = this.rect(main);
    const railRect = this.rect(rail);
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const railStyle = rail ? getComputedStyle(rail) : null;
    const trigger = this.trigger();
    const triggerRect = this.rect(trigger);
    const commandStyle = this.commandStyle();
    const commandStyleRect = this.rect(commandStyle);
    const toolsButton = this.toolsButton();
    const toolsRect = this.rect(toolsButton);
    const railTools = this.railTools();
    const drawerRows = this.drawerRows();
    const center = panelRect
      ? document.elementFromPoint(
          Math.min(window.innerWidth - 1, panelRect.left + panelRect.width / 2),
          Math.min(window.innerHeight - 1, panelRect.top + Math.min(panelRect.height / 2, 80)),
        )
      : null;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      workspaceClass: document.querySelector('.kn-workspace')?.className ?? null,
      zxe: zxeRect,
      main: mainRect,
      rail: railRect,
      railWidth: railStyle ? railStyle.width : null,
      panel: panelRect,
      panelStyle: panelStyle ? {
        position: panelStyle.position,
        left: panelStyle.left,
        right: panelStyle.right,
        top: panelStyle.top,
        zIndex: panelStyle.zIndex,
        width: panelStyle.width,
        maxHeight: panelStyle.maxHeight,
        overflowY: panelStyle.overflowY,
      } : null,
      panelRule: this.panelRule(),
      panelCount: document.querySelectorAll('.zxe-stylepanel').length,
      panelText: panel ? panel.innerText : null,
      panelButtons: panel
        ? Array.from(panel.querySelectorAll('button')).map((button) => ({
            text: (button.textContent || '').replace(/\s+/g, ' ').trim(),
            ariaLabel: button.getAttribute('aria-label'),
            disabled: Boolean(button.disabled),
          }))
        : [],
      gapToRail: panelRect && railRect ? +(railRect.left - panelRect.right).toFixed(1) : null,
      railCovered: panelRect && railRect ? this.intersection(panelRect, railRect) : null,
      railToolCount: railTools.length,
      railTools,
      railToolsCovered: railTools.filter((tool) => this.intersection(panelRect, tool.rect) > 0).map((tool) => tool.key),
      trigger: triggerRect,
      triggerCovered: panelRect && triggerRect ? this.intersection(panelRect, triggerRect) : null,
      commandStyle: commandStyleRect,
      commandStyleCovered: panelRect && commandStyleRect ? this.intersection(panelRect, commandStyleRect) : null,
      toolsButton: toolsRect,
      toolsButtonCovered: panelRect && toolsRect ? this.intersection(panelRect, toolsRect) : null,
      drawer: Boolean(this.drawer()),
      drawerRows,
      activeElement: this.activeElement(),
      topElementAtPanelCenter: center ? {
        tag: center.tagName,
        cls: typeof center.className === 'string' ? center.className : '',
        insidePanel: Boolean(center.closest && center.closest('.zxe-stylepanel')),
        ariaLabel: center.getAttribute?.('aria-label') ?? null,
      } : null,
      panelInsideZxe: Boolean(
        panelRect && zxeRect &&
        panelRect.left >= zxeRect.left &&
        panelRect.right <= zxeRect.right - 11.9 &&
        panelRect.top >= zxeRect.top + 5.9 &&
        panelRect.bottom <= zxeRect.bottom - 5.9
      ),
      panelInsideViewport: Boolean(
        panelRect &&
        panelRect.left >= 0 &&
        panelRect.top >= 0 &&
        panelRect.right <= window.innerWidth &&
        panelRect.bottom <= window.innerHeight
      ),
    };
  },
  openStyle() {
    const trigger = this.trigger();
    if (!trigger) return false;
    trigger.click();
    return true;
  },
  openDrawer() {
    const button = this.toolsButton();
    if (!button) return false;
    button.click();
    return true;
  },
  openStyleFromDrawer() {
    const row = Array.from(document.querySelectorAll('.kn-tools-drawer .kn-drawer-row'))
      .find((item) => item.getAttribute('aria-label') === '样式');
    if (!row) return false;
    row.click();
    return true;
  },
  closePanel() {
    const button = this.panel()?.querySelector('[aria-label="关闭样式面板"]');
    if (!button) return false;
    button.click();
    return true;
  },
  collapseRail() {
    const button = document.querySelector('.kn-rail-toggle');
    if (!button) return false;
    button.click();
    return true;
  },
  focusTrigger() {
    const trigger = this.trigger();
    if (!trigger) return false;
    trigger.focus();
    return document.activeElement === trigger;
  },
  activateBlock(id) {
    const row = document.querySelector('[data-block-id="' + id + '"]');
    const inline = row?.querySelector('[data-inline-editor="true"]');
    if (!inline) return false;
    inline.focus();
    return document.activeElement === inline;
  },
  clearSelection() {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    return true;
  },
  selectBlockText(id) {
    const row = document.querySelector('[data-block-id="' + id + '"]');
    const inline = row?.querySelector('[data-inline-editor="true"]');
    if (!inline) return null;
    inline.focus();
    const range = document.createRange();
    range.selectNodeContents(inline);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return {
      text: selection.toString(),
      collapsed: selection.isCollapsed,
      rangeCount: selection.rangeCount,
    };
  },
  blockType(id) {
    return document.querySelector('[data-block-id="' + id + '"]')?.getAttribute('data-block-type') ?? null;
  },
  blockHtml(id) {
    const row = document.querySelector('[data-block-id="' + id + '"]');
    return row ? row.innerHTML : null;
  },
  blockCount() {
    return document.querySelectorAll('[data-block-id]').length;
  },
  clickPanelText(text) {
    const target = Array.from(document.querySelectorAll('.zxe-stylepanel button'))
      .find((button) => (button.textContent || '').replace(/\s+/g, ' ').trim() === text);
    if (!target) return false;
    target.click();
    return true;
  },
  clickPanelAria(label) {
    const target = document.querySelector('.zxe-stylepanel button[aria-label="' + label + '"]');
    if (!target) return false;
    target.click();
    return true;
  },
  triggerFocused() {
    return document.activeElement === this.trigger();
  },
};
true;`;

const seedNote = (id, title, folderId = null) => ({
  id,
  spaceId: 'personal',
  folderId,
  title,
  tags: ['验收'],
  body: '',
  bodyFormat: 'html',
  status: 'active',
  favorite: false,
  pinned: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  deletedAt: null,
  version: 1,
});

const seedBlock = (id, noteId, blockType, orderKey, text) => ({
  id,
  noteId,
  blockType,
  orderKey,
  payload: { runs: [{ text }] },
  schemaVersion: 1,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  deletedAt: null,
  version: 1,
});

const noteA = seedNote('note-zx10-style-a', NOTE_A);
const noteB = seedNote('note-zx10-style-b', NOTE_B);
const noteEmpty = seedNote('note-zx10-style-empty', NOTE_EMPTY);
const blocksA = [
  seedBlock('block-zx10-style-1', noteA.id, 'heading2', 100, '样式面板贴右验收'),
  seedBlock('block-zx10-style-2', noteA.id, 'paragraph', 110, '第一段：用于行内格式与结构动作'),
  seedBlock('block-zx10-style-3', noteA.id, 'paragraph', 120, '第二段：用于切换块后检查位置'),
  ...Array.from({ length: 8 }, (_, index) =>
    seedBlock(
      `block-zx10-style-fill-${index}`,
      noteA.id,
      'paragraph',
      200 + index,
      `填充段落 ${index + 1}：撑开正文滚动区域。`,
    ),
  ),
];
const blocksB = [
  seedBlock('block-zx10-style-b1', noteB.id, 'heading2', 100, '另一篇笔记'),
  seedBlock('block-zx10-style-b2', noteB.id, 'paragraph', 110, '切换笔记后重新打开样式面板。'),
];

const injection = `(() => {
  ${fakeBundle}
  const world = ZXFake.createFakeWorld();
  world.install();
  world.db.notes.push(
    ${JSON.stringify(noteA)},
    ${JSON.stringify(noteB)},
    ${JSON.stringify(noteEmpty)}
  );
  world.db.blocks.push(
    ...${JSON.stringify(blocksA)},
    ...${JSON.stringify(blocksB)}
  );
  window.__ZX_WORLD__ = world;
})();`;

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function assertNear(actual, expected, message, tolerance = 1) {
  assert(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}（期望 ${expected}±${tolerance}，实际 ${actual}）`,
  );
}

function formatSnap(snap) {
  return {
    innerWidth: snap.innerWidth,
    workspaceClass: snap.workspaceClass,
    zxe: snap.zxe,
    rail: snap.rail,
    railWidth: snap.railWidth,
    panel: snap.panel,
    panelStyle: snap.panelStyle,
    panelRule: snap.panelRule,
    gapToRail: snap.gapToRail,
    railToolCount: snap.railToolCount,
    railToolsCovered: snap.railToolsCovered,
    triggerCovered: snap.triggerCovered,
    toolsButtonCovered: snap.toolsButtonCovered,
    horizontalOverflow: snap.horizontalOverflow,
    panelInsideZxe: snap.panelInsideZxe,
    panelInsideViewport: snap.panelInsideViewport,
    panelCount: snap.panelCount,
    activeElement: snap.activeElement,
  };
}

let fatal = null;
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: injection });
  await setViewport(1280, 900);

  await send('Page.navigate', {
    url: `http://127.0.0.1:${PORT}/knowledge`,
  });
  await waitFor(
    `document.readyState === 'complete' && document.querySelector('.kn-note-open') !== null`,
    '知识页与笔记列表加载',
  );
  await evaluate(PAGE_HELPERS);

  /* ---------------- 1280：打开笔记 + 右栏「样式」 ---------------- */
  await waitFor(
    `document.querySelector('[aria-label="打开笔记：${NOTE_A}"]') !== null`,
    '笔记 A 出现在列表',
  );
  await clickSelector(
    `[aria-label="打开笔记：${NOTE_A}"]`,
    '笔记 A 行',
  );
  await waitFor(
    `document.querySelector('.kn-title')?.value === ${JSON.stringify(NOTE_A)}`,
    '笔记 A 打开',
  );
  await waitFor(
    `document.querySelector('[data-block-id="block-zx10-style-1"]') !== null`,
    '笔记 A 块渲染',
  );
  await waitFor(
    `document.querySelector('[data-rail-tool="style"]') && !document.querySelector('[data-rail-tool="style"]').disabled`,
    '右栏样式按钮可用',
  );

  const beforeOpen = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['1280-before'] = formatSnap(beforeOpen);
  check(
    beforeOpen.panelCount === 0 && beforeOpen.railToolCount === 9,
    'A-01',
    '1280：初始无样式面板，右栏 9 项齐全',
    { panelCount: beforeOpen.panelCount, railToolCount: beforeOpen.railToolCount },
  );

  await clickSelector('[data-rail-tool="style"]', '右栏「样式」');
  await waitFor(`document.querySelector('.zxe-stylepanel') !== null`, '1280 样式面板打开');
  await new Promise((resolve) => setTimeout(resolve, 180));

  const wide = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['1280-open'] = formatSnap(wide);
  check(
    wide.panelStyle?.position === 'absolute',
    'A-02',
    '1280：面板 position:absolute',
    wide.panelStyle?.position,
  );
  check(
    wide.panelStyle?.right === '12px',
    'A-03',
    '1280：计算样式 right:12px',
    wide.panelStyle?.right,
  );
  check(
    wide.panelRule?.left === 'auto' && wide.panelRule?.right === '12px',
    'A-04',
    'CSS 规则 left:auto / right:12px 生效（非 left 锚定）',
    wide.panelRule,
  );
  check(
    wide.panelRule?.zIndex?.includes('--z-rail-flyout') && wide.panelStyle?.zIndex === '340',
    'A-05',
    '层级使用 --z-rail-flyout，计算值 340',
    { rule: wide.panelRule?.zIndex, computed: wide.panelStyle?.zIndex },
  );
  assertNear(
    wide.panel.right,
    wide.zxe.right - 12,
    '1280：面板右缘距编辑器内容右缘 12px',
  );
  check(
    wide.panel.left > wide.zxe.left + wide.zxe.width * 0.25 &&
      wide.panel.right > wide.zxe.left + wide.zxe.width * 0.75,
    'A-06',
    '1280：面板落在编辑器右侧，不跑到左侧',
    { panel: wide.panel, zxe: wide.zxe },
  );
  check(
    wide.gapToRail >= 10 && wide.railCovered === 0 && wide.triggerCovered === 0,
    'A-07',
    '1280：面板与右栏/触发按钮无交集（右缘留 12px）',
    {
      gapToRail: wide.gapToRail,
      railCovered: wide.railCovered,
      triggerCovered: wide.triggerCovered,
    },
  );
  check(
    wide.railToolCount === 9 &&
      wide.railTools.every((tool) => tool.visible && !tool.disabled) &&
      wide.railToolsCovered.length === 0,
    'A-08',
    '1280：右栏 9 项全部可见、可用、未被面板覆盖',
    {
      count: wide.railToolCount,
      covered: wide.railToolsCovered,
      tools: wide.railTools.map((tool) => tool.key),
    },
  );
  check(
    wide.panelInsideZxe && wide.panelInsideViewport && !wide.horizontalOverflow,
    'A-09',
    '1280：面板不溢出编辑器/视口，无横向滚动',
    {
      insideZxe: wide.panelInsideZxe,
      insideViewport: wide.panelInsideViewport,
      overflow: wide.horizontalOverflow,
    },
  );
  check(
    wide.topElementAtPanelCenter?.insidePanel === true,
    'A-10',
    '1280：面板中心最顶层元素属于面板（未被右栏/工具条遮挡）',
    wide.topElementAtPanelCenter,
  );
  check(
    wide.commandStyleCovered === 0,
    'A-11',
    '1280：面板不覆盖命令栏「Aa」样式按钮',
    {
      commandStyleCovered: wide.commandStyleCovered,
      commandStyle: wide.commandStyle,
    },
  );

  await screenshot('1280-style-open.png');
  const clip1280 = await evaluate(`(() => {
    const panel = window.__STYLEQA__.panel();
    const rail = window.__STYLEQA__.rail();
    const rect = panel.getBoundingClientRect();
    return {
      x: Math.max(0, rect.left - 24),
      y: Math.max(0, Math.min(rect.top, window.innerHeight) - 16),
      width: Math.min(window.innerWidth, (rail ? rail.getBoundingClientRect().right : window.innerWidth) - Math.max(0, rect.left - 24)),
      height: Math.min(window.innerHeight, 520),
    };
  })()`);
  await screenshot('1280-panel-right-clip.png', clip1280);

  /* ---------------- 切换块：位置不漂移 ---------------- */
  await evaluate(`window.__STYLEQA__.activateBlock('block-zx10-style-3')`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterSwitchBlock = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['1280-switch-block'] = formatSnap(afterSwitchBlock);
  check(
    afterSwitchBlock.panel &&
      Math.abs(afterSwitchBlock.panel.right - wide.panel.right) <= 1 &&
      Math.abs(afterSwitchBlock.panel.top - wide.panel.top) <= 1 &&
      afterSwitchBlock.panelStyle?.left === wide.panelStyle?.left,
    'B-01',
    '1280：切换块后面板位置不漂移',
    { before: wide.panel, after: afterSwitchBlock.panel },
  );

  /* ---------------- 关闭 / 再次打开 ---------------- */
  await evaluate('window.__STYLEQA__.closePanel()');
  await waitFor(`document.querySelector('.zxe-stylepanel') === null`, '面板关闭');
  await clickSelector('[data-rail-tool="style"]', '再次点右栏「样式」');
  await waitFor(`document.querySelector('.zxe-stylepanel') !== null`, '面板重开');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const reopened = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['1280-reopen'] = formatSnap(reopened);
  check(
    reopened.panel &&
      Math.abs(reopened.panel.right - wide.panel.right) <= 1 &&
      Math.abs(reopened.panel.top - wide.panel.top) <= 1 &&
      reopened.panelStyle?.right === '12px' &&
      reopened.panelRule?.left === 'auto',
    'B-02',
    '1280：关闭后再次打开，面板仍贴右且位置一致',
    { before: wide.panel, after: reopened.panel },
  );

  /* ---------------- 快速连点 ---------------- */
  await evaluate(`window.__STYLEQA__.closePanel()`);
  await waitFor(`document.querySelector('.zxe-stylepanel') === null`, '连点前关闭面板');
  const rapidOpen = await evaluate(`(async () => {
    const trigger = window.__STYLEQA__.trigger();
    for (let index = 0; index < 5; index += 1) {
      trigger.click();
      await new Promise((resolve) => setTimeout(resolve, 45));
    }
    return true;
  })()`);
  await waitFor(`document.querySelector('.zxe-stylepanel') !== null`, '快速连点后面板打开');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const rapidSnapshot = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['1280-rapid-open'] = formatSnap(rapidSnapshot);
  check(
    rapidOpen && rapidSnapshot.panelCount === 1 &&
      Math.abs(rapidSnapshot.panel.right - wide.panel.right) <= 1,
    'B-03',
    '1280：右栏按钮快速连点 5 次后仅 1 个面板，位置仍贴右',
    {
      panelCount: rapidSnapshot.panelCount,
      right: rapidSnapshot.panel?.right,
      expectedRight: wide.panel.right,
    },
  );
  // 从「已打开」再连点 3 次（奇数次）应收起。
  await evaluate(`(async () => {
    const trigger = window.__STYLEQA__.trigger();
    for (let index = 0; index < 3; index += 1) {
      trigger.click();
      await new Promise((resolve) => setTimeout(resolve, 45));
    }
    return true;
  })()`);
  await waitFor(`document.querySelector('.zxe-stylepanel') === null`, '快速连点后面板关闭');
  check(
    true,
    'B-04',
    '1280：快速连点 3 次后面板关闭，无残留 DOM',
    { panelCount: await evaluate(`document.querySelectorAll('.zxe-stylepanel').length`) },
  );

  /* ---------------- Esc：关闭 + 焦点返回 ---------------- */
  await clickSelector('[data-rail-tool="style"]', 'Esc 前打开样式');
  await waitFor(`document.querySelector('.zxe-stylepanel') !== null`, 'Esc 前面板打开');
  const focusedTriggerBeforeEsc = await evaluate('window.__STYLEQA__.triggerFocused()');
  await pressEscape();
  await waitFor(`document.querySelector('.zxe-stylepanel') === null`, 'Esc 关闭样式面板');
  const focusAfterEsc = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['1280-after-esc'] = formatSnap(focusAfterEsc);
  check(
    focusedTriggerBeforeEsc === true && focusAfterEsc.activeElement?.isStyleTrigger === true,
    'B-05',
    '1280：Esc 关闭面板后焦点仍在右栏「样式」触发按钮',
    { before: focusedTriggerBeforeEsc, after: focusAfterEsc.activeElement },
  );
  observation(
    'B-OBS-01',
    'Esc 关闭样式面板的同一次按键还会把工作区切到展开态（既有双重消费，CSS 修复不涉及 JS）',
    {
      workspaceClass: focusAfterEsc.workspaceClass,
      panelCount: focusAfterEsc.panelCount,
    },
  );
  await resetExpanded();

  await clickSelector('[data-rail-tool="style"]', '关闭按钮测试前打开样式');
  await waitFor(`document.querySelector('.zxe-stylepanel') !== null`, '关闭按钮测试面板打开');
  await evaluate('window.__STYLEQA__.closePanel()');
  await waitFor(`document.querySelector('.zxe-stylepanel') === null`, '关闭按钮关闭面板');
  const focusAfterCloseButton = await evaluate('window.__STYLEQA__.activeElement()');
  geometry['1280-after-close-button'] = focusAfterCloseButton;
  check(
    focusAfterCloseButton &&
      !String(focusAfterCloseButton.cls).includes('zxe-panel-close'),
    'B-06',
    '1280：点 × 关闭后焦点未留在已卸载的关闭按钮上（记录基准行为）',
    focusAfterCloseButton,
  );

  /* ---------------- 样式面板动作 ---------------- */
  await clickSelector('[data-rail-tool="style"]', '动作测试打开样式');
  await waitFor(`document.querySelector('.zxe-stylepanel') !== null`, '动作测试面板打开');
  await evaluate(`window.__STYLEQA__.activateBlock('block-zx10-style-1')`);
  await new Promise((resolve) => setTimeout(resolve, 120));

  const headingTypes = [
    ['H1', 'heading1', 'h1'],
    ['H2', 'heading2', 'h2'],
    ['H3', 'heading3', 'h3'],
    ['H4', 'heading4', 'h4'],
    ['H5', 'heading5', 'h5'],
    ['正文', 'paragraph', 'div'],
  ];
  const headingResults = [];
  for (const [label, type, tag] of headingTypes) {
    const clicked = await evaluate(
      `window.__STYLEQA__.clickPanelText(${JSON.stringify(label)})`,
    );
    await waitFor(
      `window.__STYLEQA__.blockType('block-zx10-style-1') === ${JSON.stringify(type)}`,
      `块转换为 ${type}`,
    );
    const actualTag = await evaluate(`(() => {
      const row = document.querySelector('[data-block-id="block-zx10-style-1"]');
      const el = row?.querySelector(${JSON.stringify(tag)});
      return el ? el.tagName.toLowerCase() : null;
    })()`);
    headingResults.push({ label, clicked, type, tag: actualTag });
  }
  check(
    headingResults.every((item) => item.clicked && item.type && item.tag),
    'C-01',
    'H1–H5 与正文转换全部可用（块类型与渲染标签一致）',
    headingResults,
  );

  const afterHeadings = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['1280-after-headings'] = formatSnap(afterHeadings);
  check(
    Math.abs(afterHeadings.panel.right - wide.panel.right) <= 1 &&
      Math.abs(afterHeadings.panel.top - wide.panel.top) <= 1,
    'C-02',
    'H1–H5 连续转换后面板位置不漂移',
    { before: wide.panel, after: afterHeadings.panel },
  );

  // 行内格式：真实 DOM Range 选区 + selectionchange。
  const inlineResults = [];
  const inlineMarks = [
    ['粗体', /<strong[\s>]/i],
    ['斜体', /<(em|i)[\s>]/i],
    ['下划线', /<u[\s>]/i],
    ['删除线', /<(s|strike|del)[\s>]/i],
    ['行内代码', /<code[\s>]/i],
  ];
  for (const [label, pattern] of inlineMarks) {
    await evaluate(`window.__STYLEQA__.selectBlockText('block-zx10-style-2')`);
    await waitFor(
      `(window.__STYLEQA__.panel()?.innerText || '').includes('作用于选中文字')`,
      `${label} 选区被面板识别`,
    );
    const clicked = await evaluate(
      `window.__STYLEQA__.clickPanelAria(${JSON.stringify(label)})`,
    );
    await new Promise((resolve) => setTimeout(resolve, 220));
    const html = await evaluate(`window.__STYLEQA__.blockHtml('block-zx10-style-2')`);
    inlineResults.push({ label, clicked, matched: pattern.test(String(html)), html });
  }
  check(
    inlineResults.every((item) => item.clicked && item.matched),
    'C-03',
    '行内格式 B / I / U / S / 代码全部可用',
    inlineResults.map((item) => ({ label: item.label, matched: item.matched })),
  );

  await evaluate(`window.__STYLEQA__.clearSelection()`);
  await evaluate(`window.__STYLEQA__.activateBlock('block-zx10-style-2')`);
  await new Promise((resolve) => setTimeout(resolve, 120));

  const structureResults = [];
  const structureActions = [
    ['☑ 待办', 'todo', '.zxe-todo-check'],
    ['• 列表', 'bullet_list', '.zxe-list:not(.zxe-list-ordered)'],
    ['1. 列表', 'ordered_list', '.zxe-list-ordered'],
    ['❝ 引用', 'quote', '.zxe-quote'],
    ['代码', 'code', '.zxe-code'],
  ];
  for (const [label, type, selector] of structureActions) {
    const clicked = await evaluate(
      `window.__STYLEQA__.clickPanelText(${JSON.stringify(label)})`,
    );
    await waitFor(
      `window.__STYLEQA__.blockType('block-zx10-style-2') === ${JSON.stringify(type)}`,
      `块转换为 ${type}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 160));
    const present = await evaluate(
      `document.querySelector('[data-block-id="block-zx10-style-2"] ${selector}') !== null`,
    );
    structureResults.push({ label, clicked, type, selector, present });
    // 回到正文，便于下一步继续转换。
    await evaluate(`window.__STYLEQA__.clickPanelText('正文')`);
    await waitFor(
      `window.__STYLEQA__.blockType('block-zx10-style-2') === 'paragraph'`,
      '结构动作后回到正文',
    );
  }
  check(
    structureResults.every((item) => item.clicked && item.present),
    'C-04',
    '待办 / 无序列表 / 有序列表 / 引用 / 代码动作全部可用',
    structureResults,
  );

  const beforeLink = await evaluate('window.__STYLEQA__.blockCount()');
  const linkClicked = await evaluate(`window.__STYLEQA__.clickPanelText('↗ 链接')`);
  await waitFor(
    `document.querySelector('[data-block-type="link"]') !== null`,
    '插入链接块',
  );
  await waitFor(
    `document.querySelector('.zxe-dialog-backdrop') !== null`,
    '空链接块自动打开编辑弹层',
  );
  const linkDialogOpened = await evaluate(
    `document.querySelector('.zxe-link-dialog[aria-label="编辑链接"]') !== null`,
  );
  await screenshot('1280-link-action-dialog.png');
  const dialogFilled = await evaluate(`(() => {
    const input = document.querySelector('.zxe-link-dialog input[aria-label="链接地址"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'https://example.com/zx10-style');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 140));
  const dialogSaved = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.zxe-link-dialog .zxe-dialog-actions button'))
      .find((item) => (item.textContent || '').trim() === '保存');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await waitFor(
    `document.querySelector('.zxe-dialog-backdrop') === null`,
    '链接编辑弹层保存关闭',
  );
  await waitFor(
    `document.querySelector('.zxe-stylepanel') !== null`,
    '保存链接后样式面板仍在',
  );
  const afterLink = await evaluate('window.__STYLEQA__.blockCount()');
  const linkPresent = await evaluate(`(() => {
    const row = document.querySelector('[data-block-type="link"]');
    return row
      ? row.innerHTML.includes('example.com') || row.textContent.includes('example.com')
      : false;
  })()`);
  check(
    linkClicked &&
      linkPresent &&
      linkDialogOpened &&
      dialogFilled &&
      dialogSaved &&
      afterLink > beforeLink,
    'C-05',
    '「链接」动作插入链接块并可保存网址，保存后样式面板仍在',
    {
      beforeLink,
      afterLink,
      linkPresent,
      linkDialogOpened,
      dialogFilled,
      dialogSaved,
    },
  );

  const afterActions = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['1280-after-actions'] = formatSnap(afterActions);
  check(
    Math.abs(afterActions.panel.right - wide.panel.right) <= 1 &&
      Math.abs(afterActions.panel.top - wide.panel.top) <= 1 &&
      afterActions.panelStyle?.right === '12px' &&
      afterActions.panelRule?.left === 'auto',
    'C-06',
    '全部样式动作后面板仍在右侧，位置不漂移',
    { before: wide.panel, after: afterActions.panel },
  );
  await screenshot('1280-style-actions.png');

  /* ---------------- 切换笔记 ---------------- */
  await clickSelector(`[aria-label="打开笔记：${NOTE_B}"]`, '笔记 B 行');
  await waitFor(
    `document.querySelector('.kn-title')?.value === ${JSON.stringify(NOTE_B)}`,
    '笔记 B 打开',
  );
  await waitFor(`document.querySelector('.zxe-stylepanel') === null`, '切换笔记后面板关闭');
  check(
    true,
    'D-01',
    '切换笔记时样式面板收起，不残留在旧笔记上',
    { panelCount: await evaluate(`document.querySelectorAll('.zxe-stylepanel').length`) },
  );
  await clickSelector('[data-rail-tool="style"]', '笔记 B 打开样式');
  await waitFor(`document.querySelector('.zxe-stylepanel') !== null`, '笔记 B 样式面板打开');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterSwitchNote = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['1280-switch-note'] = formatSnap(afterSwitchNote);
  check(
    Math.abs(afterSwitchNote.panel.right - wide.panel.right) <= 1 &&
      Math.abs(afterSwitchNote.panel.top - wide.panel.top) <= 1 &&
      afterSwitchNote.panelStyle?.right === '12px' &&
      afterSwitchNote.panelRule?.left === 'auto',
    'D-02',
    '切换笔记后重新打开，面板位置与笔记 A 一致',
    { before: wide.panel, after: afterSwitchNote.panel },
  );

  // 回到笔记 A，后续窄屏/刷新沿用同一篇。
  await clickSelector(`[aria-label="打开笔记：${NOTE_A}"]`, '切回笔记 A');
  await waitFor(
    `document.querySelector('.kn-title')?.value === ${JSON.stringify(NOTE_A)}`,
    '笔记 A 重新打开',
  );
  await waitFor(`document.querySelector('.zxe-stylepanel') === null`, '切回 A 后面板关闭');

  /* ---------------- 空块笔记 ---------------- */
  const emptyRowInfo = await evaluate(`(() => {
    const row = document.querySelector('[aria-label="打开笔记：${NOTE_EMPTY}"]');
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    row.scrollIntoView({ block: 'center' });
    row.click();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  })()`);
  await waitFor(
    `document.querySelector('.kn-title')?.value === ${JSON.stringify(NOTE_EMPTY)}`,
    '空块笔记打开',
  );
  await waitFor(
    `document.querySelector('[data-rail-tool="style"]') !== null`,
    '空块笔记右栏渲染',
  );
  const emptyTriggerDisabled = await evaluate(
    `document.querySelector('[data-rail-tool="style"]').disabled`,
  );
  if (!emptyTriggerDisabled) {
    await clickSelector('[data-rail-tool="style"]', '空块笔记打开样式');
    await waitFor(`document.querySelector('.zxe-stylepanel') !== null`, '空块笔记样式面板');
    const emptySnapshot = await evaluate('window.__STYLEQA__.snapshot()');
    geometry['1280-empty-note'] = formatSnap(emptySnapshot);
    check(
      emptySnapshot.panelStyle?.right === '12px' &&
        emptySnapshot.panelRule?.left === 'auto' &&
        emptySnapshot.panelInsideViewport &&
        emptySnapshot.panelCount === 1,
      'D-03',
      '空块笔记打开样式面板：仍贴右、无溢出、无重复面板',
      {
        panel: emptySnapshot.panel,
        right: emptySnapshot.panelStyle?.right,
        text: emptySnapshot.panelText?.slice(0, 80),
      },
    );
    await screenshot('1280-empty-block-note.png');
    await evaluate('window.__STYLEQA__.closePanel()');
    await waitFor(`document.querySelector('.zxe-stylepanel') === null`, '空块笔记面板关闭');
  } else {
    check(
      true,
      'D-03',
      '空块笔记的样式按钮保持禁用（无可用块），未强行打开',
      { disabled: true },
    );
  }

  /* ---------------- 1024 ---------------- */
  await clickSelector(`[aria-label="打开笔记：${NOTE_A}"]`, '1024 前切回笔记 A');
  await waitFor(
    `document.querySelector('.kn-title')?.value === ${JSON.stringify(NOTE_A)}`,
    '1024 前笔记 A 打开',
  );
  await setViewport(1024, 900);
  await waitFor(
    `document.querySelector('.kn-rail') !== null && getComputedStyle(document.querySelector('.kn-rail')).width === '36px'`,
    '1024 右栏 36px',
  );
  if (await evaluate(`document.querySelector('.zxe-stylepanel') !== null`)) {
    await evaluate('window.__STYLEQA__.closePanel()');
    await waitFor(`document.querySelector('.zxe-stylepanel') === null`, '1024 前面板关闭');
  }
  await clickSelector('[data-rail-tool="style"]', '1024 右栏「样式」');
  await waitFor(`document.querySelector('.zxe-stylepanel') !== null`, '1024 样式面板打开');
  await new Promise((resolve) => setTimeout(resolve, 160));
  const medium = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['1024-open'] = formatSnap(medium);
  assertNear(
    medium.panel.right,
    medium.zxe.right - 12,
    '1024：面板右缘距编辑器右缘 12px',
  );
  check(
    medium.panelStyle?.right === '12px' &&
      medium.panelRule?.left === 'auto' &&
      medium.panel.left >= medium.zxe.left + 11.9 &&
      Math.abs(medium.panel.width - Math.min(364, medium.zxe.width - 24)) <= 1,
    'E-01',
    '1024：面板右缘贴内容右缘，剩余宽度不足时按 calc(100% - 24px) 收缩（CSS left:auto）',
    {
      panel: medium.panel,
      zxe: medium.zxe,
      style: medium.panelStyle,
      rule: medium.panelRule,
      expectedWidth: Math.min(364, medium.zxe.width - 24),
    },
  );
  check(
    medium.gapToRail >= 10 &&
      medium.railCovered === 0 &&
      medium.triggerCovered === 0 &&
      medium.railToolsCovered.length === 0,
    'E-02',
    '1024：面板不遮 36px 右栏 9 项与触发按钮',
    {
      gap: medium.gapToRail,
      railCovered: medium.railCovered,
      toolsCovered: medium.railToolsCovered,
      triggerCovered: medium.triggerCovered,
    },
  );
  check(
    medium.railToolCount === 9 &&
      medium.railTools.every((tool) => tool.visible) &&
      medium.panelInsideZxe &&
      medium.panelInsideViewport &&
      !medium.horizontalOverflow,
    'E-03',
    '1024：9 项可见、面板不溢出、无横向滚动',
    {
      count: medium.railToolCount,
      insideZxe: medium.panelInsideZxe,
      insideViewport: medium.panelInsideViewport,
      overflow: medium.horizontalOverflow,
    },
  );
  await screenshot('1024-style-open.png');

  /* ---------------- 900：窄屏抽屉 ---------------- */
  await setViewport(900, 800);
  await waitFor(
    `document.querySelector('.kn-rail') === null && document.querySelector('.kn-cmd-tools') !== null`,
    '900 右栏隐藏、命令栏「工具」出现',
  );
  if (await evaluate(`document.querySelector('.zxe-stylepanel') !== null`)) {
    await evaluate('window.__STYLEQA__.closePanel()');
    await waitFor(`document.querySelector('.zxe-stylepanel') === null`, '900 前面板关闭');
  }
  await clickSelector('.kn-cmd-tools', '900 命令栏「工具」');
  await waitFor(`document.querySelector('.kn-tools-drawer') !== null`, '900 工具抽屉打开');
  const drawerSnapshot = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['900-drawer'] = formatSnap(drawerSnapshot);
  check(
    drawerSnapshot.drawerRows.length === 9 &&
      drawerSnapshot.drawerRows.some((row) => row.label === '样式' && !row.disabled),
    'F-01',
    '900：工具抽屉仍提供 9 项，样式入口可用',
    drawerSnapshot.drawerRows,
  );
  await clickSelector(
    '.kn-tools-drawer .kn-drawer-row[aria-label="样式"]',
    '900 抽屉「样式」',
  );
  await waitFor(`document.querySelector('.zxe-stylepanel') !== null`, '900 样式面板打开');
  await new Promise((resolve) => setTimeout(resolve, 180));
  const narrow = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['900-open'] = formatSnap(narrow);
  assertNear(
    narrow.panel.right,
    narrow.zxe.right - 12,
    '900：面板右缘距编辑器右缘 12px',
  );
  check(
    narrow.panelStyle?.right === '12px' &&
      narrow.panelRule?.left === 'auto' &&
      narrow.panel.left > narrow.zxe.left + 24 &&
      narrow.panel.left >= narrow.zxe.left + 11.9,
    'F-02',
    '900：面板仍在内容右侧，未按 left:12px 锚到左侧',
    { panel: narrow.panel, zxe: narrow.zxe, style: narrow.panelStyle, rule: narrow.panelRule },
  );
  check(
    !narrow.drawer &&
      narrow.rail === null &&
      narrow.toolsButtonCovered === 0 &&
      narrow.panelInsideZxe &&
      narrow.panelInsideViewport &&
      !narrow.horizontalOverflow,
    'F-03',
    '900：抽屉已收起、右栏不常驻、不盖「工具」按钮、不溢出',
    {
      drawer: narrow.drawer,
      rail: narrow.rail,
      toolsCovered: narrow.toolsButtonCovered,
      insideZxe: narrow.panelInsideZxe,
      insideViewport: narrow.panelInsideViewport,
      overflow: narrow.horizontalOverflow,
    },
  );
  check(
    narrow.panelCount === 1 && narrow.panelStyle?.zIndex === '340',
    'F-04',
    '900：仅 1 个样式面板，层级 340',
    { panelCount: narrow.panelCount, zIndex: narrow.panelStyle?.zIndex },
  );
  await screenshot('900-style-open.png');
  const clip900 = await evaluate(`(() => {
    const panel = window.__STYLEQA__.panel();
    const rect = panel.getBoundingClientRect();
    return {
      x: Math.max(0, rect.left - 24),
      y: Math.max(0, rect.top - 16),
      width: Math.min(window.innerWidth - Math.max(0, rect.left - 24), window.innerWidth),
      height: Math.min(window.innerHeight, 520),
    };
  })()`);
  await screenshot('900-panel-right-clip.png', clip900);
  await pressEscape();
  await waitFor(`document.querySelector('.zxe-stylepanel') === null`, '900 Esc 关闭面板');
  const narrowAfterEsc = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['900-after-esc'] = formatSnap(narrowAfterEsc);
  check(
    narrowAfterEsc.panelCount === 0,
    'F-05',
    '900：Esc 关闭样式面板；焦点基准行为已记录（未落入隐藏面板）',
    narrowAfterEsc.activeElement,
  );
  observation(
    'F-OBS-01',
    '900 Esc 关闭样式面板后工作区状态（既有双重消费现象同样存在）',
    { workspaceClass: narrowAfterEsc.workspaceClass },
  );
  await resetExpanded();

  /* ---------------- 1280：右栏折叠 ---------------- */
  await setViewport(1280, 900);
  await waitFor(
    `document.querySelector('.kn-rail') !== null && getComputedStyle(document.querySelector('.kn-rail')).width === '48px'`,
    '1280 右栏恢复 48px',
  );
  await clickSelector('[data-rail-tool="style"]', '折叠前打开样式');
  await waitFor(`document.querySelector('.zxe-stylepanel') !== null`, '折叠前面板打开');
  const beforeCollapse = await evaluate('window.__STYLEQA__.snapshot()');
  await clickSelector('.kn-rail-toggle', '收起右栏');
  await waitFor(
    `getComputedStyle(document.querySelector('.kn-rail')).width === '32px'`,
    '右栏折叠为 32px',
  );
  await new Promise((resolve) => setTimeout(resolve, 180));
  const collapsed = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['1280-collapsed'] = formatSnap(collapsed);
  assertNear(
    collapsed.panel.right,
    collapsed.zxe.right - 12,
    '1280 折叠：面板右缘距编辑器右缘 12px',
  );
  check(
    collapsed.railWidth === '32px' &&
      collapsed.panel &&
      Math.abs(collapsed.panel.right - collapsed.zxe.right + 12) <= 1 &&
      collapsed.gapToRail >= 10 &&
      collapsed.railCovered === 0,
    'G-01',
    '1280：折叠右栏为 32px 后面板仍贴右、不盖折叠栏',
    {
      railWidth: collapsed.railWidth,
      gap: collapsed.gapToRail,
      panel: collapsed.panel,
      rail: collapsed.rail,
    },
  );
  const toggleRect = await evaluate(`window.__STYLEQA__.rectOf('.kn-rail-toggle')`);
  const toggleCovered = await evaluate(
    `window.__STYLEQA__.intersection(window.__STYLEQA__.rectOf('.kn-rail-toggle'), window.__STYLEQA__.rectOf('.zxe-stylepanel'))`,
  );
  check(
    toggleRect && toggleCovered === 0,
    'G-02',
    '1280：折叠栏展开按钮未被面板覆盖',
    { toggleRect, toggleCovered },
  );
  await screenshot('1280-collapsed-panel.png');
  await clickSelector('.kn-rail-toggle', '展开右栏');
  await waitFor(
    `getComputedStyle(document.querySelector('.kn-rail')).width === '48px'`,
    '右栏恢复展开',
  );
  await evaluate('window.__STYLEQA__.closePanel()');
  await waitFor(`document.querySelector('.zxe-stylepanel') === null`, '折叠测试后面板关闭');
  check(
    Math.abs(collapsed.panel.right - beforeCollapse.panel.right) <= 16,
    'G-03',
    '1280：折叠前后仅随列宽平移，未改变右侧锚定规则',
    { before: beforeCollapse.panel, collapsed: collapsed.panel },
  );

  /* ---------------- 刷新：笔记还在，面板可重开到同一锚点 ---------------- */
  await clickSelector('[data-rail-tool="style"]', '刷新前打开样式');
  await waitFor(`document.querySelector('.zxe-stylepanel') !== null`, '刷新前面板打开');
  const beforeReload = await evaluate('window.__STYLEQA__.snapshot()');
  const urlBeforeReload = await evaluate('location.href');
  await send('Page.reload', { ignoreCache: true });
  await waitFor(
    `document.readyState === 'complete' && document.querySelector('.kn-title')?.value === ${JSON.stringify(NOTE_A)}`,
    '刷新后笔记 A 自动恢复',
  );
  await evaluate(PAGE_HELPERS);
  await waitFor(
    `document.querySelector('.zxe-stylepanel') === null`,
    '刷新后面板不残留',
  );
  check(
    true,
    'H-01',
    '刷新后笔记仍在（URL note 深链），瞬态样式面板不残留',
    { url: urlBeforeReload, panelCount: await evaluate(`document.querySelectorAll('.zxe-stylepanel').length`) },
  );
  await waitFor(
    `document.querySelector('[data-rail-tool="style"]') && !document.querySelector('[data-rail-tool="style"]').disabled`,
    '刷新后样式按钮可用',
  );
  await clickSelector('[data-rail-tool="style"]', '刷新后打开样式');
  await waitFor(`document.querySelector('.zxe-stylepanel') !== null`, '刷新后面板重开');
  await new Promise((resolve) => setTimeout(resolve, 160));
  const afterReload = await evaluate('window.__STYLEQA__.snapshot()');
  geometry['1280-after-reload'] = formatSnap(afterReload);
  check(
    Math.abs(afterReload.panel.right - beforeReload.panel.right) <= 1 &&
      Math.abs(afterReload.panel.top - beforeReload.panel.top) <= 1 &&
      afterReload.panelStyle?.right === '12px' &&
      afterReload.panelRule?.left === 'auto',
    'H-02',
    '刷新后重开样式面板，位置与刷新前一致',
    { before: beforeReload.panel, after: afterReload.panel },
  );
  await screenshot('1280-after-reload.png');

  /* ---------------- 删除不存在项 ---------------- */
  const deleteMissing = await evaluate(`(async () => {
    try {
      await window.__ZX_WORLD__.invoke('notes_delete', { id: 'missing-zx10-style' });
      return { rejected: false, message: null };
    } catch (error) {
      return {
        rejected: true,
        message: String(error?.message ?? error?.reason_code ?? error),
      };
    }
  })()`);
  const afterDeleteMissing = await evaluate('window.__STYLEQA__.snapshot()');
  check(
    deleteMissing.rejected &&
      String(deleteMissing.message).includes('笔记不存在') &&
      afterDeleteMissing.panelCount === 1 &&
      afterDeleteMissing.panelStyle?.right === '12px',
    'H-03',
    '删除不存在的笔记被拒绝，页面与面板不崩溃',
    { deleteMissing, panel: afterDeleteMissing.panel },
  );

  /* ---------------- 控制台 ---------------- */
  check(
    consoleErrors.length === 0 && pageExceptions.length === 0,
    'I-01',
    '控制台 0 error、页面 0 exception',
    { consoleErrors, pageExceptions },
  );
} catch (error) {
  fatal = error;
  check(false, 'FATAL', error instanceof Error ? error.message : String(error));
} finally {
  fs.writeFileSync(
    path.join(EVIDENCE, 'summary.json'),
    JSON.stringify(
      {
        fatal: fatal ? String(fatal) : null,
        results,
        observations,
        geometry,
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
