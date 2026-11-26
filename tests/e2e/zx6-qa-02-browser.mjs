/**
 * ZX6-QA-02 浏览器复验：日期取消语义 + 弹窗层级/底栏 + JSON 入口。
 *
 * 真实生产构建 + 真实 Chromium（CDP），只注入 tests/harness/fakeTauri.ts
 * 的内存 IPC 替身；产品源码与构建不改。用于给验收报告提供非 jsdom 证据：
 *
 * 1. 日期：取消（Esc / 点外部）后输入框应恢复已提交值，且不得把被取消的
 *    草稿写入（ZX6-DESIGN-01 §9.4/§9.6-6）——本脚本按设计断言，若失败即为
 *    缺陷证据（D13）。
 * 2. 知识页导出/导入弹窗：共享 Modal、z-index 1200、footer 独立于滚动 body，
 *    640 高视口下 footer 仍完整可见（ZX6-DESIGN-02 §5.1/§5.5）。
 * 3. 画板工具栏无独立「JSON」；设置「数据与备份」分组可见且无裸 JSON。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx6-qa-02-browser.mjs
 * 退出码：0 全部符合设计；1 至少一项失败（报告会逐项列出）。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx6-qa-02');
const FAKE_BUNDLE = '/tmp/zx-fake-qa02.js';
const PORT = 8918;
const DEBUG_PORT = 9242;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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

const userDataDir = `/tmp/zx-chrome-zx6-qa-02-${Date.now()}`;
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
  const file = path.join(EVIDENCE, name);
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
}

async function navigate(url) {
  await send('Page.navigate', { url });
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const PAGE_HELPERS = `
window.__ZX_QA2__ = {
  dateInput() { return document.querySelector('.task-dialog .date-field-input'); },
  datePanel() { return document.querySelector('.dp-popover'); },
  setDate(text) {
    const input = this.dateInput();
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value',
    ).set;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },
  press(key) {
    this.dateInput().dispatchEvent(new KeyboardEvent('keydown', {
      key, bubbles: true, cancelable: true,
    }));
  },
  dateSnapshot() {
    return {
      input: this.dateInput()?.value ?? null,
      panelOpen: Boolean(this.datePanel()),
      selected: this.datePanel()
        ?.querySelector('.dp-day.is-selected')?.getAttribute('data-date') ?? null,
    };
  },
  clickByText(selector, text) {
    const node = Array.from(document.querySelectorAll(selector))
      .find((item) => item.textContent.trim() === text);
    if (!node) return false;
    node.click();
    return true;
  },
  clickDialogFooterButton(text) {
    const footer = document.querySelector('.zx-modal-foot');
    const node = footer
      ? Array.from(footer.querySelectorAll('button'))
          .find((item) => item.textContent.trim() === text)
      : null;
    if (!node) return false;
    node.click();
    return true;
  },
};
true;`;

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    ${fakeBundle}
    const world = ZXFake.createFakeWorld();
    world.install();
    window.__ZX_WORLD__ = world;
  })();`,
});

try {
  // -------------------------------------------------------------------------
  // A. 日期取消语义（倒数日新建弹窗，真实组件 + 真实浏览器事件）
  // -------------------------------------------------------------------------
  await navigate(`http://127.0.0.1:${PORT}/calendar`);
  await waitFor(
    `document.readyState === 'complete' && document.body.innerText.includes('倒数日')`,
    '日历页加载',
  );
  await evaluate(PAGE_HELPERS);
  await evaluate(
    `Array.from(document.querySelectorAll('[role="tab"]'))
      .find((tab) => tab.textContent.trim() === '倒数日').click(); true`,
  );
  await waitFor(
    `document.querySelector('[aria-label="倒数日分区新建倒数日"]') !== null`,
    '倒数日分区渲染',
  );
  await evaluate(
    `document.querySelector('[aria-label="倒数日分区新建倒数日"]').click(); true`,
  );
  await waitFor(
    `document.querySelector('.task-dialog h2')?.textContent === '新建倒数日'`,
    '新建倒数日弹层打开',
  );
  await evaluate(`(() => {
    const input = document.querySelector('.task-dialog input');
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value',
    ).set;
    setter.call(input, 'QA 取消语义');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);

  // A1 先提交一个确定日期。
  await evaluate(`document.querySelector('.task-dialog .date-field-icon').click(); true`);
  await waitFor(`window.__ZX_QA2__.dateSnapshot().panelOpen`, '日期面板打开');
  await evaluate(`window.__ZX_QA2__.setDate('2026/12/25'); window.__ZX_QA2__.press('Enter'); true`);
  await waitFor(
    `window.__ZX_QA2__.dateSnapshot().input === '2026-12-25'`,
    '提交 2026-12-25',
  );
  check(true, 'A1', '已提交 2026-12-25', await evaluate('window.__ZX_QA2__.dateSnapshot()'));

  // A2 面板仍打开：输入 2026/12/24，不按 Enter，Esc 取消。
  await waitFor(`window.__ZX_QA2__.dateSnapshot().panelOpen`, '日期面板保持打开');
  await evaluate(`window.__ZX_QA2__.setDate('2026/12/24'); true`);
  await waitFor(
    `window.__ZX_QA2__.dateSnapshot().selected === '2026-12-24'`,
    '手输入驱动面板预览',
  );
  await evaluate(`window.__ZX_QA2__.press('Escape'); true`);
  await waitFor(`!window.__ZX_QA2__.dateSnapshot().panelOpen`, 'Esc 关闭面板');
  const afterEsc = await evaluate('window.__ZX_QA2__.dateSnapshot()');
  check(
    afterEsc.input === '2026-12-25',
    'A2',
    'Esc 取消后输入框恢复已提交值（ZX6-DESIGN-01 §9.6-6）',
    afterEsc.input,
  );
  await screenshot('01-esc-cancel.png');

  // A3 真实鼠标点击名称输入框：失焦后保存，被取消的草稿不得成为倒数日日期。
  const titlePoint = await evaluate(`(() => {
    const el = document.querySelector('.task-dialog input');
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: titlePoint.x,
    y: titlePoint.y,
    button: 'left',
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: titlePoint.x,
    y: titlePoint.y,
    button: 'left',
    clickCount: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const afterBlur = await evaluate('window.__ZX_QA2__.dateSnapshot()');
  await evaluate(
    `window.__ZX_QA2__.clickByText('.task-dialog button', '保存'); true`,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const savedDates = await evaluate(
    `(window.__ZX_WORLD__.db.countdowns ?? []).map((row) => row.targetDate ?? row.target_date ?? null)`,
  );
  const qaCountdown = await evaluate(
    `(window.__ZX_WORLD__.db.countdowns ?? [])
      .filter((row) => row.title === 'QA 取消语义')
      .map((row) => row.targetDate ?? row.target_date ?? null)`,
  );
  check(
    qaCountdown.length > 0 && qaCountdown[0] === '2026-12-25',
    'A3',
    'Esc 取消后失焦/保存不得写入 2026-12-24',
    { afterEsc, afterBlur, savedDates, qaCountdown },
  );

  // A4 点外部取消：先提交 2026-12-26，再输入 2026-12-23 并点外部。
  await evaluate(
    `document.querySelector('[aria-label="倒数日分区新建倒数日"]').click(); true`,
  );
  await waitFor(
    `document.querySelector('.task-dialog h2')?.textContent === '新建倒数日'`,
    '再次打开新建倒数日',
  );
  await evaluate(`document.querySelector('.task-dialog .date-field-icon').click(); true`);
  await waitFor(`window.__ZX_QA2__.dateSnapshot().panelOpen`, '日期面板打开');
  await evaluate(`window.__ZX_QA2__.setDate('2026/12/26'); window.__ZX_QA2__.press('Enter'); true`);
  await waitFor(
    `window.__ZX_QA2__.dateSnapshot().input === '2026-12-26'`,
    '提交 2026-12-26',
  );
  // Enter 提交后面板保持打开：直接输入，不再点图标（点了会关闭面板）。
  await evaluate(`window.__ZX_QA2__.setDate('2026/12/23'); true`);
  await waitFor(
    `window.__ZX_QA2__.dateSnapshot().selected === '2026-12-23'`,
    '手输入驱动面板预览',
  );
  await evaluate(
    `document.querySelector('.task-dialog h2').dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true })); true`,
  );
  await waitFor(`!window.__ZX_QA2__.dateSnapshot().panelOpen`, '点外部关闭面板');
  const afterOutside = await evaluate('window.__ZX_QA2__.dateSnapshot()');
  check(
    afterOutside.input === '2026-12-26',
    'A4',
    '点外部取消后输入框恢复已提交值（设计 §9.4「点外部取消，不写值」）',
    afterOutside.input,
  );
  await screenshot('02-outside-cancel.png');

  // -------------------------------------------------------------------------
  // B. 知识页导出/导入弹窗：共享 Modal、footer 固定、640 高可见
  // -------------------------------------------------------------------------
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await navigate(`http://127.0.0.1:${PORT}/knowledge?note=note-welcome`);
  await waitFor(
    `document.querySelector('button[aria-label="导出笔记"]') !== null`,
    '知识页命令栏',
  );
  await evaluate(`document.querySelector('button[aria-label="导出笔记"]').click(); true`);
  await waitFor(
    `Array.from(document.querySelectorAll('[role="menuitem"]'))
      .some((item) => item.textContent.includes('导出选项'))`,
    '导出菜单',
  );
  await evaluate(
    `Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find((item) => item.textContent.includes('导出选项')).click(); true`,
  );
  await waitFor(`document.querySelector('[role="dialog"]') !== null`, '导出弹窗打开');

  const exportDialog = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const backdrop = dialog.closest('.zx-modal-backdrop');
    const body = dialog.querySelector('.zx-modal-body');
    const footer = dialog.querySelector('.zx-modal-foot');
    const rect = footer?.getBoundingClientRect();
    return {
      zIndex: backdrop ? getComputedStyle(backdrop).zIndex : null,
      legacy: Boolean(document.querySelector('.kn-modal-backdrop, .kn-modal')),
      footerInsideBody: Boolean(body && footer && body.contains(footer)),
      footerBottom: rect ? Math.round(rect.bottom) : null,
      viewportHeight: window.innerHeight,
      footerVisible:
        rect ? rect.top >= 0 && rect.bottom <= window.innerHeight : false,
      bodyOverflow: body ? getComputedStyle(body).overflowY : null,
      title: dialog.querySelector('h2')?.textContent ?? null,
    };
  })()`);
  check(exportDialog.zIndex === '1200', 'B1', '导出弹窗 backdrop z-index=1200', exportDialog);
  check(exportDialog.legacy === false, 'B2', '导出弹窗不再使用 .kn-modal 旧外壳', exportDialog);
  check(exportDialog.footerInsideBody === false, 'B3', 'footer 不在滚动 body 内', exportDialog);
  check(
    exportDialog.footerVisible === true,
    'B4',
    '640 高视口下 footer 完整可见（§5.5-6）',
    exportDialog,
  );
  check(
    exportDialog.bodyOverflow === 'auto',
    'B5',
    'body 是唯一滚动区（overflow:auto）',
    exportDialog,
  );
  await screenshot('03-export-dialog-640.png');

  // 滚动 body 到底：footer 仍可见。
  await evaluate(`(() => {
    const body = document.querySelector('.zx-modal-body');
    if (body) body.scrollTop = body.scrollHeight;
  })(); true`);
  const footerAfterScroll = await evaluate(`(() => {
    const footer = document.querySelector('.zx-modal-foot');
    const rect = footer?.getBoundingClientRect();
    return rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom) } : null;
  })()`);
  check(
    footerAfterScroll !== null &&
      footerAfterScroll.bottom <= 640 &&
      footerAfterScroll.top >= 0,
    'B6',
    '滚动长内容后 footer 仍固定可见',
    footerAfterScroll,
  );
  await screenshot('04-export-dialog-scrolled.png');

  // Esc 关闭；焦点回到页面内。
  await evaluate(
    `document.querySelector('[role="dialog"]').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`,
  );
  await waitFor(`document.querySelector('[role="dialog"]') === null`, 'Esc 关闭导出弹窗');
  check(true, 'B7', 'Esc 关闭导出弹窗且页面无异常');

  // 导入弹窗同样走共享外壳。
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((item) => item.textContent.trim() === '导入笔记');
    if (button) button.click();
  })(); true`);
  await waitFor(
    `document.querySelector('[role="dialog"] h2')?.textContent === '导入笔记'`,
    '导入弹窗打开',
  );
  const importDialog = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const backdrop = dialog.closest('.zx-modal-backdrop');
    const footer = dialog.querySelector('.zx-modal-foot');
    return {
      zIndex: backdrop ? getComputedStyle(backdrop).zIndex : null,
      footerVisible: footer ? footer.getBoundingClientRect().bottom <= window.innerHeight : false,
      legacy: Boolean(document.querySelector('.kn-modal-backdrop, .kn-modal')),
    };
  })()`);
  check(importDialog.zIndex === '1200', 'B8', '导入弹窗 z-index=1200', importDialog);
  check(importDialog.footerVisible === true, 'B9', '640 高下导入弹窗 footer 可见', importDialog);
  check(importDialog.legacy === false, 'B10', '导入弹窗无旧 .kn-modal 外壳', importDialog);
  await screenshot('05-import-dialog-640.png');
  await evaluate(`(() => {
    const footer = document.querySelector('.zx-modal-foot');
    const button = footer
      ? Array.from(footer.querySelectorAll('button'))
          .find((item) => item.textContent.trim() === '关闭')
      : null;
    if (button) button.click();
  })(); true`);
  await new Promise((resolve) => setTimeout(resolve, 100));

  // -------------------------------------------------------------------------
  // C. 设置「数据与备份」分组
  // -------------------------------------------------------------------------
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await navigate(`http://127.0.0.1:${PORT}/settings/data`);
  await waitFor(
    `document.body.innerText.includes('备份与恢复')`,
    '设置数据与备份页',
  );
  const settings = await evaluate(`(() => {
    const text = document.body.innerText;
    const bareJson = Array.from(document.querySelectorAll('button'))
      .some((button) => button.textContent.trim() === 'JSON');
    return {
      hasBackupGroup: text.includes('备份与恢复'),
      hasExportGroup: text.includes('单向导出'),
      bareJson,
      hasJsonExport: Array.from(document.querySelectorAll('button'))
        .some((button) => button.textContent.includes('结构化数据（JSON')),
    };
  })()`);
  check(settings.hasBackupGroup, 'C1', '存在「备份与恢复」分组', settings);
  check(settings.hasExportGroup, 'C2', '存在「单向导出」分组', settings);
  check(settings.bareJson === false, 'C3', '不存在裸「JSON」按钮', settings);
  check(settings.hasJsonExport, 'C4', 'JSON 导出带限定词', settings);
  await screenshot('06-settings-data.png');

  // -------------------------------------------------------------------------
  // D. 画板工具栏无独立 JSON
  // -------------------------------------------------------------------------
  await navigate(`http://127.0.0.1:${PORT}/board/board-acceptance`);
  await waitFor(
    `document.querySelector('.bw-toolbar, .bw-canvas') !== null ||
     document.querySelector('button[aria-label="导入或导出画板包"]') !== null`,
    '画板工作区',
  );
  const board = await evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return {
      json: buttons.some((button) => button.textContent.trim() === 'JSON'),
      restoreJson: buttons.some((button) => button.textContent.includes('恢复 JSON')),
      importExport: buttons.some(
        (button) => button.getAttribute('aria-label') === '导入或导出画板包',
      ),
    };
  })()`);
  check(board.json === false, 'D1', '画板工具栏无独立「JSON」按钮', board);
  check(board.restoreJson === false, 'D2', '画板无「恢复 JSON」按钮', board);
  check(board.importExport === true, 'D3', '保留唯一「导入 / 导出」入口', board);
  await screenshot('07-board-toolbar.png');

  // -------------------------------------------------------------------------
  // E. 控制台
  // -------------------------------------------------------------------------
  check(
    consoleErrors.length === 0,
    'E1',
    '控制台 0 error',
    consoleErrors.slice(0, 5),
  );
  check(
    pageExceptions.length === 0,
    'E2',
    '页面 0 exception',
    pageExceptions.slice(0, 5),
  );
} catch (error) {
  results.push({ id: 'FATAL', ok: false, message: String(error.message ?? error) });
  console.error(`[FATAL] ${error.message ?? error}`);
  try {
    await screenshot('99-failure.png');
  } catch {
    // 截图失败不覆盖原始错误。
  }
} finally {
  const failed = results.filter((item) => !item.ok);
  const summary = {
    card: 'ZX6-QA-02',
    generatedAt: new Date().toISOString(),
    passed: failed.length === 0,
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
  console.log(`\n[zx6-qa-02] ${results.length - failed.length}/${results.length} 通过`);
  socket.close();
  chrome.kill();
  server.close();
  process.exitCode = failed.length === 0 ? 0 : 1;
}
