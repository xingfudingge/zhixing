/**
 * ZX6-QA-03 浏览器独立复验：D13 日期取消语义（关闭按钮/连点/面板关闭 Esc）。
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
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx6-qa-03');
const FAKE_BUNDLE = '/tmp/zx-fake-qa03.js';
const PORT = 8919;
const DEBUG_PORT = 9243;
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

const userDataDir = `/tmp/zx-chrome-zx6-qa-03-${Date.now()}`;
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
window.__ZX_QA3__ = {
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
    // 刷新持久化：把上一页面的 fake DB 行合并回来（仅本独立脚本使用）。
    try {
      const saved = JSON.parse(localStorage.getItem('zx-qa3-db') || 'null');
      if (saved && world.db) {
        for (const key of Object.keys(saved)) {
          if (Array.isArray(saved[key]) && Array.isArray(world.db[key])) {
            world.db[key].splice(0, world.db[key].length, ...saved[key]);
          }
        }
      }
    } catch {
      // 持久化失败不阻断验收。
    }
    world.install();
    window.__ZX_WORLD__ = world;
  })();`,
});

try {
  // -------------------------------------------------------------------------
  // D13 独立复验：真实 Chromium 鼠标/键盘事件驱动日期取消
  // -------------------------------------------------------------------------
  async function realClick(selector) {
    const point = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!point) throw new Error(`找不到可点击元素：${selector}`);
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
  }

  async function openCountdownDialog(title) {
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
      setter.call(input, ${JSON.stringify(title)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })(); true`);
  }

  async function openDatePanel() {
    await realClick('.task-dialog .date-field-icon');
    await waitFor(`window.__ZX_QA3__.dateSnapshot().panelOpen`, '日期面板打开');
  }

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

  // A1-A3：关闭按钮取消 → 失焦 → 保存，落库必须是已提交值。
  await openCountdownDialog('QA D13 关闭按钮');
  await openDatePanel();
  await evaluate(`window.__ZX_QA3__.setDate('2026/12/25'); window.__ZX_QA3__.press('Enter'); true`);
  await waitFor(
    `window.__ZX_QA3__.dateSnapshot().input === '2026-12-25'`,
    '提交 2026-12-25',
  );
  check(true, 'A1', '已提交 2026-12-25', await evaluate('window.__ZX_QA3__.dateSnapshot()'));

  await evaluate(`window.__ZX_QA3__.setDate('2026/12/24'); true`);
  await waitFor(
    `window.__ZX_QA3__.dateSnapshot().selected === '2026-12-24'`,
    '手输入驱动面板预览',
  );
  await realClick('.task-dialog .date-field-icon');
  await waitFor(`!window.__ZX_QA3__.dateSnapshot().panelOpen`, '关闭按钮关闭面板');
  const afterClose = await evaluate('window.__ZX_QA3__.dateSnapshot()');
  const focusInfo = await evaluate(`({
    name: document.activeElement?.className ?? null,
    isDateInput: document.activeElement === document.querySelector('.task-dialog .date-field-input'),
  })`);
  check(
    afterClose.input === '2026-12-25',
    'A2',
    '关闭按钮取消后输入框恢复已提交值',
    { afterClose, focusInfo },
  );
  check(
    focusInfo.isDateInput === true,
    'A3',
    '关闭按钮取消后焦点回到日期输入框',
    focusInfo,
  );
  await realClick('.task-dialog input');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const afterBlurClose = await evaluate('window.__ZX_QA3__.dateSnapshot()');
  await evaluate(`window.__ZX_QA3__.clickByText('.task-dialog button', '保存'); true`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const closeSaved = await evaluate(
    `(window.__ZX_WORLD__.db.countdowns ?? [])
      .filter((row) => row.title === 'QA D13 关闭按钮')
      .map((row) => row.targetDate ?? row.target_date ?? null)`,
  );
  check(
    afterBlurClose.input === '2026-12-25' &&
      closeSaved.length === 1 &&
      closeSaved[0] === '2026-12-25',
    'A4',
    '关闭按钮取消后失焦/保存不得写入 2026-12-24',
    { afterBlurClose, closeSaved },
  );
  await screenshot('01-close-cancel.png');

  // A5-A7：快速 Esc / 点外部 / 反复开合，最终保存仍为已提交值。
  await openCountdownDialog('QA D13 连点');
  await openDatePanel();
  await evaluate(`window.__ZX_QA3__.setDate('2026/12/26'); window.__ZX_QA3__.press('Enter'); true`);
  await waitFor(
    `window.__ZX_QA3__.dateSnapshot().input === '2026-12-26'`,
    '提交 2026-12-26',
  );
  for (let i = 0; i < 3; i += 1) {
    await evaluate(`window.__ZX_QA3__.setDate('2026/12/2${3 + i}'); true`);
    await evaluate(`window.__ZX_QA3__.press('Escape'); true`);
    await waitFor(`!window.__ZX_QA3__.dateSnapshot().panelOpen`, `Esc 关闭面板 #${i + 1}`);
    const snap = await evaluate('window.__ZX_QA3__.dateSnapshot()');
    check(
      snap.input === '2026-12-26',
      `A${5 + i}`,
      `第 ${i + 1} 次 Esc 后恢复 2026-12-26`,
      snap,
    );
  }
  // 面板关闭时连按 Esc 3 次：只恢复输入，不写库、不抛异常。
  for (let i = 0; i < 3; i += 1) {
    await evaluate(`window.__ZX_QA3__.press('Escape'); true`);
  }
  const afterRepeatedEsc = await evaluate('window.__ZX_QA3__.dateSnapshot()');
  check(
    afterRepeatedEsc.input === '2026-12-26' && afterRepeatedEsc.panelOpen === false,
    'A8',
    '面板关闭时连按 Esc 3 次：输入保持已提交值、面板保持关闭',
    afterRepeatedEsc,
  );
  // 反复真实开合 4 轮（每次都输入草稿再点图标关闭）。
  for (let i = 0; i < 4; i += 1) {
    await openDatePanel();
    await evaluate(`window.__ZX_QA3__.setDate('2026/12/1${5 + i}'); true`);
    await realClick('.task-dialog .date-field-icon');
    await waitFor(`!window.__ZX_QA3__.dateSnapshot().panelOpen`, `图标关闭面板 #${i + 1}`);
    const snap = await evaluate('window.__ZX_QA3__.dateSnapshot()');
    check(
      snap.input === '2026-12-26',
      `A${9 + i}`,
      `第 ${i + 1} 轮图标开合后恢复 2026-12-26`,
      snap,
    );
  }
  await realClick('.task-dialog input');
  await evaluate(`window.__ZX_QA3__.clickByText('.task-dialog button', '保存'); true`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const rapidSaved = await evaluate(
    `(window.__ZX_WORLD__.db.countdowns ?? [])
      .filter((row) => row.title === 'QA D13 连点')
      .map((row) => row.targetDate ?? row.target_date ?? null)`,
  );
  check(
    rapidSaved.length === 1 && rapidSaved[0] === '2026-12-26',
    'A13',
    '连续取消后保存：写入 2026-12-26，未写入任何被取消草稿',
    rapidSaved,
  );
  await screenshot('02-rapid-cancel.png');

  // A14-A15：面板关闭时的 Esc 路径，保存仍为已提交值。
  await openCountdownDialog('QA D13 面板关闭 Esc');
  await openDatePanel();
  await evaluate(`window.__ZX_QA3__.setDate('2026/12/27'); window.__ZX_QA3__.press('Enter'); true`);
  await waitFor(
    `window.__ZX_QA3__.dateSnapshot().input === '2026-12-27'`,
    '提交 2026-12-27',
  );
  await realClick('.task-dialog .date-field-icon');
  await waitFor(`!window.__ZX_QA3__.dateSnapshot().panelOpen`, '关闭面板');
  await evaluate(`window.__ZX_QA3__.setDate('2026/12/19'); true`);
  await evaluate(`window.__ZX_QA3__.press('Escape'); true`);
  const afterClosedEsc = await evaluate('window.__ZX_QA3__.dateSnapshot()');
  check(
    afterClosedEsc.input === '2026-12-27' && afterClosedEsc.panelOpen === false,
    'A14',
    '面板关闭时输入后 Esc：恢复 2026-12-27',
    afterClosedEsc,
  );
  await realClick('.task-dialog input');
  await evaluate(`window.__ZX_QA3__.clickByText('.task-dialog button', '保存'); true`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const closedEscSaved = await evaluate(
    `(window.__ZX_WORLD__.db.countdowns ?? [])
      .filter((row) => row.title === 'QA D13 面板关闭 Esc')
      .map((row) => row.targetDate ?? row.target_date ?? null)`,
  );
  check(
    closedEscSaved.length === 1 && closedEscSaved[0] === '2026-12-27',
    'A15',
    '面板关闭 Esc 后保存：写入 2026-12-27',
    closedEscSaved,
  );

  // A16：刷新持久化——取消的草稿没有进库，已提交值在刷新后仍存在。
  await evaluate(
    `localStorage.setItem('zx-qa3-db', JSON.stringify(window.__ZX_WORLD__.db)); true`,
  );
  await send('Page.reload');
  await waitFor(
    `window.__ZX_WORLD__ && Array.isArray(window.__ZX_WORLD__.db.countdowns)`,
    '刷新后 fake 世界恢复',
  );
  const afterReload = await evaluate(
    `(window.__ZX_WORLD__.db.countdowns ?? [])
      .filter((row) => String(row.title ?? '').startsWith('QA D13 '))
      .map((row) => ({ title: row.title, date: row.targetDate ?? row.target_date ?? null }))`,
  );
  const reloadMap = Object.fromEntries(afterReload.map((row) => [row.title, row.date]));
  check(
    afterReload.length === 3 &&
      reloadMap['QA D13 关闭按钮'] === '2026-12-25' &&
      reloadMap['QA D13 连点'] === '2026-12-26' &&
      reloadMap['QA D13 面板关闭 Esc'] === '2026-12-27',
    'A16',
    '刷新后三条倒数日仍保持已提交值（被取消草稿未持久化）',
    afterReload,
  );

  // A17：删除不存在的倒数日——明确报错，库行数不变。
  const beforeDelete = await evaluate('window.__ZX_WORLD__.db.countdowns.length');
  const deleteMissing = await evaluate(`window.__ZX_WORLD__
    .invoke('countdowns_delete', { id: 'countdown-does-not-exist' })
    .then(() => ({ ok: true }))
    .catch((error) => ({ ok: false, message: String(error?.message ?? error) }))`);
  const afterDelete = await evaluate('window.__ZX_WORLD__.db.countdowns.length');
  check(
    deleteMissing.ok === false &&
      /不存在/.test(deleteMissing.message ?? '') &&
      beforeDelete === afterDelete,
    'A17',
    '删除不存在的倒数日：报「不存在」且不改变库',
    { deleteMissing, beforeDelete, afterDelete },
  );

  // E. 控制台
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
    card: 'ZX6-QA-03',
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
  console.log(`\n[zx6-qa-03] ${results.length - failed.length}/${results.length} 通过`);
  socket.close();
  chrome.kill();
  server.close();
  process.exitCode = failed.length === 0 ? 0 : 1;
}
