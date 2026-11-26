/**
 * ZX10-QA-01 独立浏览器验收：任务中心筛选区去重。
 *
 * 只读产品代码，不修改产品/既有测试；用真实 Chromium（CDP）加载 `app/dist`，
 * 注入验收替身 Tauri IPC（tests/harness/fakeTauri.ts），在 1280/1024/900
 * 三档视口下断言 DOM 几何、键盘、深链、视图与空态，并落截图/DOM JSON。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx10-qa-01-browser.mjs
 *
 * 证据：tests/evidence/zx10-qa-01/
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx10-qa-01');
const FAKE_BUNDLE = '/tmp/zx10-qa-01-fake-tauri.js';
const PORT = 8898;
const DEBUG_PORT = 9225;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

fs.mkdirSync(EVIDENCE, { recursive: true });
for (const name of fs.readdirSync(EVIDENCE)) {
  if (/\.(png|json)$/.test(name)) fs.rmSync(path.join(EVIDENCE, name));
}

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
if (bundled.status !== 0) throw new Error(`fakeTauri 打包失败：${bundled.stderr}`);
const fakeBundle = fs.readFileSync(FAKE_BUNDLE, 'utf8');

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
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
  let file = path.join(DIST, pathname);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html');
  }
  response.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const userDataDir = `/tmp/zx10-qa-01-chrome-${Date.now()}`;
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
chrome.stderr.on('data', (chunk) => { chromeStderr += String(chunk); });

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
    } catch {}
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
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(
      (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' '),
    );
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    pageExceptions.push(details.exception?.description ?? details.text ?? 'unknown');
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    consoleErrors.push(message.params.entry.text);
  }
});
function send(method, params = {}) {
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, 20_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
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
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
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
  fs.writeFileSync(path.join(EVIDENCE, name), Buffer.from(result.data, 'base64'));
  console.log(`[evidence] tests/evidence/zx10-qa-01/${name}`);
}
function writeJson(name, value) {
  fs.writeFileSync(path.join(EVIDENCE, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`[evidence] tests/evidence/zx10-qa-01/${name}`);
}
const results = [];
function check(condition, label, details) {
  results.push({ label, pass: Boolean(condition), details });
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}`, details === undefined ? '' : JSON.stringify(details));
  if (!condition) {
    throw new Error(`断言失败：${label}\n${JSON.stringify(details, null, 2)}`);
  }
}

const injection = `(() => {
  try {
    __ZX_FAKE_BUNDLE__
    const empty = location.search.includes('__empty=1');
    const world = ZXFake.createFakeWorld({ empty });
    world.install();
    window.__ZX_WORLD__ = world;
  } catch (error) {
    window.__ZX_INIT_ERROR__ = String(error?.stack ?? error);
  }
})();`.replace('__ZX_FAKE_BUNDLE__', () => fakeBundle);

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: injection });

async function setViewport(width, height = 900) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function navigate(url, ready = '全部任务') {
  const expected = new URL(url);
  await send('Page.navigate', { url });
  await waitFor(
    `document.readyState === 'complete' && location.pathname === ${JSON.stringify(expected.pathname)} && location.search === ${JSON.stringify(expected.search)} && document.body && document.body.innerText.includes(${JSON.stringify(ready)}) && !window.__ZX_RELOAD_MARK__`,
    `页面加载 ${url}`,
  );
  const initError = await evaluate('window.__ZX_INIT_ERROR__ ?? null');
  if (initError) throw new Error(`注入失败：${initError}`);
}

async function reload() {
  await evaluate('window.__ZX_RELOAD_MARK__ = 1');
  await send('Page.reload', { ignoreCache: true });
  await waitFor(
    `window.__ZX_RELOAD_MARK__ === undefined && document.readyState === 'complete' && document.body && document.body.innerText.includes('全部任务')`,
    '刷新后页面就绪',
  );
  const initError = await evaluate('window.__ZX_INIT_ERROR__ ?? null');
  if (initError) throw new Error(`刷新后注入失败：${initError}`);
}

async function tabClick(label) {
  return evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('[aria-label="任务状态"] [role="tab"]'))
      .find((el) => el.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!tab) throw new Error('找不到状态标签：' + ${JSON.stringify(label)});
    tab.click();
    return tab.textContent.trim();
  })()`);
}

async function pressKey(key, code, keyCode) {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
}

async function snapshotFilterArea() {
  return evaluate(`(() => {
    const filter = document.querySelector('.task-center-filters');
    if (!filter) return null;
    const tablists = Array.from(filter.querySelectorAll('[role="tablist"]'));
    const tabs = Array.from(filter.querySelectorAll('[role="tab"]')).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    const rects = tabs.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        label: el.textContent.trim(),
        selected: el.getAttribute('aria-selected'),
        x: Math.round(rect.x * 10) / 10,
        y: Math.round(rect.y * 10) / 10,
        top: Math.round(rect.top * 10) / 10,
        bottom: Math.round(rect.bottom * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      };
    });
    const controls = {
      search: Boolean(filter.querySelector('input[aria-label="搜索任务标题或备注"]')),
      list: Boolean(filter.querySelector('select[aria-label="清单筛选"]')),
      priority: Boolean(filter.querySelector('select[aria-label="优先级筛选"]')),
      date: Boolean(filter.querySelector('select[aria-label="日期筛选"]')),
      status: Boolean(filter.querySelector('.task-center-result')),
    };
    return {
      filterText: filter.innerText,
      tablistCount: tablists.length,
      tablistLabels: tablists.map((el) => el.getAttribute('aria-label')),
      tabCount: tabs.length,
      tabs: rects,
      rowCount: new Set(rects.map((rect) => rect.top)).size,
      statusWidth: Math.round(filter.querySelector('.task-center-statuses')?.getBoundingClientRect().width ?? 0),
      statusScrollWidth: filter.querySelector('.task-center-statuses')?.scrollWidth ?? 0,
      statusClientWidth: filter.querySelector('.task-center-statuses')?.clientWidth ?? 0,
      controls,
      rangeTablist: document.querySelectorAll('[aria-label="任务范围"]').length,
      scopeClassCount: document.querySelectorAll('.task-center-scopes').length,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      bodyOverflow: document.documentElement.scrollWidth > window.innerWidth,
      hasAllUnfinishedText: filter.innerText.includes('全部未完成'),
      hasTopRangeTabs: ['全部未完成', '今天', '接下来', '未安排', '已完成'].every((label) =>
        tabs.some((tab) => tab.textContent.trim().startsWith(label)),
      ),
    };
  })()`);
}

async function readStatusState() {
  return evaluate(`(() => ({
    url: location.search,
    tabs: Array.from(document.querySelectorAll('[aria-label="任务状态"] [role="tab"]')).map((el) => ({
      label: el.textContent.trim(),
      selected: el.getAttribute('aria-selected'),
      count: el.querySelector('.task-tab-count')?.textContent,
    })),
    activeText: document.activeElement?.textContent?.trim() ?? null,
    activeRole: document.activeElement?.getAttribute('role') ?? null,
    rows: Array.from(document.querySelectorAll('.task-row .task-title')).map((el) => el.textContent.trim()),
    emptyHeading: document.querySelector('.task-center-empty h2')?.textContent ?? null,
    overview: Array.from(document.querySelectorAll('.task-overview-card')).map((el) => ({
      label: el.querySelector('.task-overview-label')?.textContent,
      number: el.querySelector('.task-overview-number')?.textContent,
      pressed: el.getAttribute('aria-pressed'),
    })),
  }))()`);
}

async function setSearch(value) {
  await evaluate(`(() => {
    const input = document.querySelector('input[aria-label="搜索任务标题或备注"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
}

async function selectFilter(label, value) {
  return evaluate(`(() => {
    const select = document.querySelector('select[aria-label=${JSON.stringify(label)}]');
    if (!select) throw new Error('找不到筛选：' + ${JSON.stringify(label)});
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
}

function assertOneRow(width, layout, label) {
  check(layout !== null, `${label} 筛选区存在`, layout);
  check(layout.tablistCount === 1, `${label} 筛选区只有 1 个 tablist`, layout.tablistLabels);
  check(layout.tablistLabels[0] === '任务状态', `${label} tablist 为任务状态`, layout.tablistLabels);
  check(layout.tabCount === 4, `${label} 状态 tab 为 4 个`, layout.tabs.map((tab) => tab.label));
  const expected = ['全部', '待办', '进行中', '已完成'];
  check(
    layout.tabs.every((tab, index) => tab.label.startsWith(expected[index])),
    `${label} tab 顺序为 全部/待办/进行中/已完成`,
    layout.tabs.map((tab) => tab.label),
  );
  check(layout.rowCount === 1, `${label} 状态 tab 只有一排`, layout.tabs.map((tab) => tab.top));
  check(layout.rangeTablist === 0, `${label} 不存在「任务范围」tablist`, layout.rangeTablist);
  check(layout.scopeClassCount === 0, `${label} 不存在 task-center-scopes`, layout.scopeClassCount);
  check(!layout.hasAllUnfinishedText, `${label} 筛选区不再出现「全部未完成」`, layout.filterText);
  check(!layout.hasTopRangeTabs, `${label} 不再同时出现五个范围 tab`, layout.tabs.map((tab) => tab.label));
  check(layout.controls.search, `${label} 搜索框仍在`, layout.controls);
  check(layout.controls.list, `${label} 清单筛选仍在`, layout.controls);
  check(layout.controls.priority, `${label} 优先级筛选仍在`, layout.controls);
  check(layout.controls.date, `${label} 日期筛选仍在（全部未完成范围）`, layout.controls);
  check(layout.controls.status, `${label} 结果计数仍在`, layout.controls);
  check(layout.statusScrollWidth <= layout.statusClientWidth + 1, `${label} 状态行未被裁切`, {
    scrollWidth: layout.statusScrollWidth,
    clientWidth: layout.statusClientWidth,
  });
  check(!layout.bodyOverflow, `${label} 无横向溢出`, {
    scrollWidth: layout.documentScrollWidth,
    viewport: layout.viewportWidth,
  });
  check(
    layout.tabs.every((tab) => tab.x >= 0 && tab.x + tab.width <= width + 0.5),
    `${label} 四个 tab 都在视口内`,
    layout.tabs,
  );
}

async function waitUrlIncludes(part, label) {
  await waitFor(`location.search.includes(${JSON.stringify(part)})`, label);
}
async function waitUrlNotIncludes(part, label) {
  await waitFor(`!location.search.includes(${JSON.stringify(part)})`, label);
}

try {
  // ---------------------------------------------------------------- 视口轮询
  const initialRows = [];
  for (const width of [1280, 1024, 900]) {
    await setViewport(width);
    await navigate(`http://127.0.0.1:${PORT}/tasks`);
    await waitFor(
      `document.querySelectorAll('[aria-label="任务状态"] [role="tab"]').length === 4`,
      `${width} 状态 tab 渲染`,
    );
    await waitFor(`document.querySelectorAll('.task-row').length > 0`, `${width} 任务行出现`);
    const layout = await snapshotFilterArea();
    assertOneRow(width, layout, `${width}px`);
    const status = await readStatusState();
    check(status.tabs.map((tab) => tab.count).join('/') === '4/4/0/0', `${width}px 默认状态计数正确`, status.tabs);
    check(status.tabs[0].selected === 'true', `${width}px 默认选中「全部」`, status.tabs);
    if (width === 1280) initialRows.push(...status.rows);
    writeJson(`dom-${width}.json`, { width, layout, status });
    await screenshot(`${width}-filter-row.png`);
  }

  // 回到 1280 做交互
  await setViewport(1280);
  await navigate(`http://127.0.0.1:${PORT}/tasks`);
  await waitFor(`document.querySelectorAll('.task-row').length > 0`, '交互前任务行');

  // ------------------------------------------------------------ 键盘与选中态
  const keyboardChecks = [];
  await evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('[aria-label="任务状态"] [role="tab"]')).find((el) => el.textContent.trim().startsWith('全部'));
    tab.focus();
    return document.activeElement === tab;
  })()`);
  check(
    await evaluate(`document.activeElement?.textContent.trim().startsWith('全部') ?? false`),
    '键盘起点：焦点在「全部」',
  );

  const steps = [
    { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, expect: '待办', url: 'status=todo' },
    { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, expect: '进行中', url: 'status=doing' },
    { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, expect: '待办', url: 'status=todo' },
    { key: 'End', code: 'End', keyCode: 35, expect: '已完成', url: 'status=done' },
    { key: 'Home', code: 'Home', keyCode: 36, expect: '全部', url: null },
    { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, expect: '已完成', url: 'status=done' },
  ];
  for (const step of steps) {
    await pressKey(step.key, step.code, step.keyCode);
    if (step.url) await waitUrlIncludes(step.url, `键盘 ${step.key} 写入 ${step.url}`);
    else await waitUrlNotIncludes('status=', `键盘 ${step.key} 清除 status`);
    await waitFor(
      `document.activeElement?.getAttribute('role') === 'tab' && document.activeElement.textContent.trim().startsWith(${JSON.stringify(step.expect)})`,
      `键盘 ${step.key} 焦点到 ${step.expect}`,
    );
    await waitFor(
      `document.querySelector('[aria-label="任务状态"] [aria-selected="true"]')?.textContent.trim().startsWith(${JSON.stringify(step.expect)})`,
      `键盘 ${step.key} 选中 ${step.expect}`,
    );
    const state = await readStatusState();
    const selected = state.tabs.find((tab) => tab.selected === 'true')?.label;
    check(
      selected?.startsWith(step.expect),
      `键盘 ${step.key} 选中「${step.expect}」`,
      { selected, url: state.url, active: state.activeText },
    );
    keyboardChecks.push({ key: step.key, selected, url: state.url, active: state.activeText });
  }
  writeJson('keyboard-tabs.json', keyboardChecks);
  await tabClick('全部');
  await waitUrlNotIncludes('status=', '点击「全部」清除 status');
  await screenshot('1280-keyboard-end-home.png');

  // --------------------------------------------------------------- 状态筛选
  await tabClick('待办');
  await waitUrlIncludes('status=todo', '点击待办');
  let statusState = await readStatusState();
  check(statusState.rows.length === 4, '待办筛选显示 4 条', statusState.rows);
  check(statusState.tabs.find((tab) => tab.label.startsWith('待办'))?.selected === 'true', '待办选中态', statusState.tabs);

  await tabClick('进行中');
  await waitUrlIncludes('status=doing', '点击进行中');
  statusState = await readStatusState();
  check(statusState.emptyHeading === '没有「进行中」的任务', '进行中空态', statusState.emptyHeading);
  check(statusState.tabs.find((tab) => tab.label.startsWith('进行中'))?.selected === 'true', '进行中选中态', statusState.tabs);

  await evaluate(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === '查看全部').click()`);
  await waitUrlNotIncludes('status=', '查看全部清除 status');
  statusState = await readStatusState();
  check(statusState.rows.length === 4, '「查看全部」恢复 4 条', statusState.rows);
  check(statusState.tabs.find((tab) => tab.selected === 'true')?.label.startsWith('全部'), '「查看全部」恢复全部选中', statusState.tabs);
  await screenshot('1280-status-empty-and-restore.png');

  // 快速连点：同一轮依次点四态，最终必须落在「已完成」，再恢复全部
  await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('[aria-label="任务状态"] [role="tab"]'));
    for (const tab of tabs) tab.click();
    return tabs.map((tab) => tab.textContent.trim());
  })()`);
  await waitUrlIncludes('status=done', '快速连点最终到已完成');
  await waitFor(`document.querySelector('[aria-label="任务状态"] [aria-selected="true"]')?.textContent.trim().startsWith('已完成')`, '快速连点选中已完成');
  const rapid = await readStatusState();
  check(rapid.tabs.find((tab) => tab.selected === 'true')?.label.startsWith('已完成'), '快速连点最终选中已完成', rapid);
  await tabClick('全部');
  await waitUrlNotIncludes('status=', '快速连点后恢复全部');
  const rapidRestored = await readStatusState();
  check(rapidRestored.rows.length === 4, '快速连点后数据仍为 4 条', rapidRestored.rows);

  // -------------------------------------------------------- 搜索/清单/优先级/日期
  await setSearch('交房租');
  await waitUrlIncludes('q=%E4%BA%A4%E6%88%BF%E7%A7%9F', '搜索写入 URL（编码）');
  await waitFor(`document.querySelectorAll('.task-row').length === 1`, '搜索只剩 1 条');
  let filteredState = await readStatusState();
  check(filteredState.rows.join() === '交房租', '搜索命中「交房租」', filteredState.rows);
  check(filteredState.tabs.map((tab) => tab.count).join('/') === '1/1/0/0', '搜索后状态计数更新', filteredState.tabs);
  await evaluate(`document.querySelector('button[aria-label="清空搜索"]').click()`);
  await waitUrlNotIncludes('q=', '清空搜索清除 URL');
  await waitFor(`document.querySelectorAll('.task-row').length === 4`, '清空搜索恢复 4 条');
  await screenshot('1280-search-filter.png');

  await selectFilter('清单筛选', 'work');
  await waitUrlIncludes('list=work', '清单筛选写入 URL');
  await waitFor(`document.querySelectorAll('.task-row').length === 2`, '清单筛选剩 2 条');
  filteredState = await readStatusState();
  check(
    filteredState.rows.sort().join('|') === ['准备周会材料', '完成验收报告'].sort().join('|'),
    '清单筛选只显示工作清单',
    filteredState.rows,
  );
  await selectFilter('清单筛选', '');
  await waitUrlNotIncludes('list=', '清除清单筛选');

  await selectFilter('优先级筛选', '3');
  await waitUrlIncludes('priority=3', '优先级筛选写入 URL');
  await waitFor(`document.querySelectorAll('.task-row').length === 1`, '优先级筛选剩 1 条');
  filteredState = await readStatusState();
  check(filteredState.rows.join() === '完成验收报告', '优先级 3 只显示对应任务', filteredState.rows);
  await selectFilter('优先级筛选', '');
  await waitUrlNotIncludes('priority=', '清除优先级筛选');

  await selectFilter('日期筛选', 'overdue');
  await waitUrlIncludes('date=overdue', '日期筛选写入 URL');
  await waitFor(`document.querySelectorAll('.task-row').length === 1`, '日期逾期剩 1 条');
  filteredState = await readStatusState();
  check(filteredState.rows.join() === '交房租', '日期逾期只显示逾期任务', filteredState.rows);
  await selectFilter('日期筛选', '');
  await waitUrlNotIncludes('date=', '清除日期筛选');

  // ---------------------------------------------------------- 概览卡 + 深链
  await evaluate(`document.querySelectorAll('.task-overview-card')[1].click()`);
  await waitUrlIncludes('filter=today', '概览卡「今天」写入深链');
  await waitFor(`document.querySelectorAll('.task-overview-card')[1].getAttribute('aria-pressed') === 'true'`, '今天卡选中');
  let deep = await readStatusState();
  check(deep.overview.find((card) => card.label === '今天')?.pressed === 'true', '概览「今天」卡 aria-pressed', deep.overview);
  check(deep.rows.includes('完成验收报告') && deep.rows.includes('交房租'), '今天范围含今天与逾期任务', deep.rows);
  check(deep.rows.length === 2, '今天范围共 2 条', deep.rows);
  check(await evaluate(`document.querySelector('[aria-label="日期筛选"]') === null`), '今天范围不显示 open 专属日期筛选');
  await screenshot('1280-filter-today.png');

  await reload();
  deep = await readStatusState();
  check(deep.overview.find((card) => card.label === '今天')?.pressed === 'true', '刷新后今天范围保持', deep.overview);
  check(deep.rows.length === 2, '刷新后今天范围数据保持', deep.rows);
  await screenshot('1280-filter-today-reload.png');

  for (const [filter, expectedCard, expectedRows, expectedHeading] of [
    ['next', '接下来 7 天', ['准备周会材料'], null],
    ['undated', '未安排', ['整理收件箱'], null],
    ['done', null, ['买咖啡豆'], null],
  ]) {
    await navigate(`http://127.0.0.1:${PORT}/tasks?filter=${filter}`);
    await waitFor(`document.querySelector('.task-overview-card') !== null`, `深链 ${filter} 概览渲染`);
    const state = await readStatusState();
    check(state.url.includes(`filter=${filter}`), `深链 ${filter} URL 保留`, state.url);
    check(
      state.rows.sort().join('|') === [...expectedRows].sort().join('|'),
      `深链 ${filter} 显示预期任务`,
      state.rows,
    );
    if (expectedCard) {
      check(
        state.overview.find((card) => card.label === expectedCard)?.pressed === 'true',
        `深链 ${filter} 概览卡选中`,
        state.overview,
      );
    } else {
      check(
        state.overview.every((card) => card.pressed === 'false'),
        '深链 done 不误选概览卡',
        state.overview,
      );
    }
    if (expectedHeading) {
      check(state.rows.length === 0, '深链空范围不渲染任务', state.rows);
    }
    check(
      (await snapshotFilterArea()).tablistCount === 1,
      `深链 ${filter} 仍只有一个状态 tablist`,
    );
  }
  await screenshot('1280-filter-done.png');

  // 四张概览卡逐一点击，验证都能切换 scope（不只依赖深链）
  await navigate(`http://127.0.0.1:${PORT}/tasks`);
  for (const [cardLabel, expectedUrl, expectedRows] of [
    ['逾期', 'date=overdue', ['交房租']],
    ['今天', 'filter=today', ['交房租', '完成验收报告']],
    ['接下来 7 天', 'filter=next', ['准备周会材料']],
    ['未安排', 'filter=undated', ['整理收件箱']],
  ]) {
    await evaluate(`(() => {
      const card = Array.from(document.querySelectorAll('.task-overview-card'))
        .find((el) => el.querySelector('.task-overview-label')?.textContent === ${JSON.stringify(cardLabel)});
      if (!card) throw new Error('找不到概览卡：' + ${JSON.stringify(cardLabel)});
      card.click();
      return true;
    })()`);
    await waitUrlIncludes(expectedUrl, `概览卡 ${cardLabel} 写入 ${expectedUrl}`);
    await waitFor(
      `Array.from(document.querySelectorAll('.task-overview-card')).find((el) => el.querySelector('.task-overview-label')?.textContent === ${JSON.stringify(cardLabel)})?.getAttribute('aria-pressed') === 'true'`,
      `概览卡 ${cardLabel} 选中`,
    );
    await waitFor(`document.querySelectorAll('.task-row').length === ${expectedRows.length}`, `概览卡 ${cardLabel} 结果数`);
    const cardState = await readStatusState();
    check(
      cardState.rows.sort().join('|') === [...expectedRows].sort().join('|'),
      `概览卡 ${cardLabel} 切换 scope`,
      cardState.rows,
    );
    check(cardState.url.includes(expectedUrl), `概览卡 ${cardLabel} URL`, cardState.url);
    check(
      (await snapshotFilterArea()).tablistCount === 1,
      `概览卡 ${cardLabel} 切换后仍只有一个状态 tablist`,
    );
  }
  await screenshot('1280-overview-cards.png');

  // ------------------------------------------------------------ 看板 / 列表 / 批量
  await navigate(`http://127.0.0.1:${PORT}/tasks`);
  await waitFor(`document.querySelectorAll('.task-row').length > 0`, '视图测试任务行');
  await evaluate(`Array.from(document.querySelectorAll('.task-center-views button')).find((el) => el.textContent.trim() === '看板').click()`);
  await waitUrlIncludes('view=board', '切到看板');
  await waitFor(`document.querySelector('.task-board') !== null`, '看板渲染');
  const board = await evaluate(`(() => ({
    columns: Array.from(document.querySelectorAll('.task-board-column')).map((el) => ({
      label: el.getAttribute('aria-label'),
      cards: el.querySelectorAll('.task-card').length,
    })),
    rangeTabs: document.querySelectorAll('[aria-label="任务范围"] [role="tab"]').length,
    statusTabs: document.querySelectorAll('[aria-label="任务状态"] [role="tab"]').length,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }))()`);
  check(board.columns.length === 3, '看板三列', board.columns);
  check(board.columns.map((column) => column.label).join() === '待办列,进行中列,已完成列', '看板列顺序', board.columns);
  check(board.columns[0].cards === 4, '看板待办列 4 张卡', board.columns);
  check(board.rangeTabs === 0, '看板不存在范围 tab', board.rangeTabs);
  check(board.statusTabs === 4, '看板仍有 4 个状态 tab', board.statusTabs);
  check(!board.overflow, '看板 1280 无横向溢出', board);
  await screenshot('1280-board.png');
  await evaluate(`document.querySelector('.task-card').click()`);
  await waitFor(`document.querySelector('#task-detail-title')?.value`, '看板卡片打开详情');
  const detailTitle = await evaluate(`document.querySelector('#task-detail-title')?.value ?? null`);
  check(Boolean(detailTitle), '看板卡片可打开详情', detailTitle);
  await evaluate(`document.querySelector('.task-detail button[aria-label="关闭任务详情"]').click()`);
  await waitFor(`!location.search.includes('task=') && document.querySelector('.task-board') !== null`, '从详情返回看板');

  await evaluate(`Array.from(document.querySelectorAll('.task-center-views button')).find((el) => el.textContent.trim() === '列表').click()`);
  await waitUrlNotIncludes('view=board', '切回列表');
  await waitFor(`document.querySelector('.task-quick-add') !== null`, '列表渲染');

  await evaluate(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === '批量').click()`);
  await waitFor(`document.querySelectorAll('.task-select').length === 4`, '批量复选框 4 个');
  await evaluate(`document.querySelector('.task-select').click()`);
  await waitFor(`document.querySelector('.task-batch-bar') !== null`, '批量条出现');
  const batch = await evaluate(`(() => ({
    selected: document.querySelector('.task-batch-count')?.textContent ?? null,
    checks: document.querySelectorAll('.task-select:checked').length,
    rows: document.querySelectorAll('.task-row').length,
  }))()`);
  check(batch.selected?.includes('1') && batch.checks === 1, '批量选择 1 条', batch);
  check(batch.rows === 4, '批量选择不改变任务数', batch.rows);
  await screenshot('1280-batch.png');
  await evaluate(`Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === '退出批量').click()`);
  await waitFor(`document.querySelectorAll('.task-select').length === 0`, '退出批量');

  // 数据/排序/状态未因筛选而改变
  const afterRows = await evaluate(`Array.from(document.querySelectorAll('.task-row .task-title')).map((el) => el.textContent.trim())`);
  check(afterRows.join('|') === initialRows.join('|'), '筛选/视图操作后任务顺序与状态未变', {
    before: initialRows,
    after: afterRows,
  });

  // ------------------------------------------------------ 空数据 / 不存在项 / 删除
  await navigate(`http://127.0.0.1:${PORT}/tasks?__empty=1`);
  await waitFor(`document.querySelector('.task-center-empty') !== null`, '空库空态');
  const empty = await evaluate(`(() => ({
    heading: document.querySelector('.task-center-empty h2')?.textContent ?? null,
    rows: document.querySelectorAll('.task-row').length,
    statusTabs: document.querySelectorAll('[aria-label="任务状态"] [role="tab"]').length,
    tablists: document.querySelectorAll('.task-center-filters [role="tablist"]').length,
    counts: Array.from(document.querySelectorAll('[aria-label="任务状态"] .task-tab-count')).map((el) => el.textContent),
    overview: Array.from(document.querySelectorAll('.task-overview-number')).map((el) => el.textContent),
    range: document.querySelectorAll('[aria-label="任务范围"]').length,
  }))()`);
  check(empty.heading === '还没有任务', '空库显示空态', empty);
  check(empty.rows === 0, '空库无任务行', empty.rows);
  check(empty.statusTabs === 4 && empty.tablists === 1, '空库仍只有一个 4-tab 状态行', empty);
  check(empty.counts.join('/') === '0/0/0/0', '空库状态计数全 0', empty.counts);
  check(empty.overview.join('/') === '0/0/0/0', '空库概览计数全 0', empty.overview);
  check(empty.range === 0, '空库无范围 tablist', empty.range);
  await screenshot('1280-empty-data.png');
  await reload();
  await waitFor(`document.querySelector('.task-center-empty') !== null`, '空库刷新后空态');
  check(
    await evaluate(`document.querySelectorAll('.task-row').length === 0`),
    '空库刷新后仍无任务',
  );

  // 正常数据下：不存在任务深链 + 删除不存在项的 IPC 语义
  await navigate(`http://127.0.0.1:${PORT}/tasks?task=missing-task-id`);
  await waitFor(`document.body.innerText.includes('这个任务不存在或已被删除')`, '不存在任务提示');  check(
    await evaluate(`document.querySelectorAll('.task-row').length === 4`),
    '不存在任务深链不影响列表',
  );
  await screenshot('1280-missing-task.png');
  const deleteMissing = await evaluate(`(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke('tasks_delete', { id: 'missing-task-id' });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: String(error?.message ?? error) };
    }
  })()`);
  check(deleteMissing.ok === false, '删除不存在项被拒绝且不崩溃', deleteMissing);
  check(String(deleteMissing.message).includes('任务不存在'), '删除不存在项返回明确错误', deleteMissing);

  // 刷新持久化（正常数据 + 状态筛选）
  await navigate(`http://127.0.0.1:${PORT}/tasks?status=todo&filter=today`);
  await waitFor(`document.querySelectorAll('.task-row').length === 2`, '组合深链就绪');
  await reload();
  const persisted = await readStatusState();
  check(persisted.url.includes('status=todo') && persisted.url.includes('filter=today'), '刷新后组合深链保持', persisted.url);
  check(persisted.rows.length === 2, '刷新后组合深链结果保持', persisted.rows);
  check(persisted.tabs.find((tab) => tab.label.startsWith('待办'))?.selected === 'true', '刷新后待办选中态保持', persisted.tabs);

  // ---------------------------------------------------------------- 总结
  check(consoleErrors.length === 0, '控制台零 error', consoleErrors);
  check(pageExceptions.length === 0, '页面零未捕获异常', pageExceptions);
  const summary = {
    width: '1280/1024/900',
    checks: results.length,
    passed: results.filter((item) => item.pass).length,
    consoleErrors,
    pageExceptions,
    screenshots: fs.readdirSync(EVIDENCE).filter((name) => name.endsWith('.png')),
  };
  writeJson('summary.json', summary);
  console.log(`[result] PASS ${summary.passed}/${summary.checks} checks`);
  console.log('[result] consoleErrors=', JSON.stringify(consoleErrors));
  console.log('[result] exceptions=', JSON.stringify(pageExceptions));
} finally {
  try { socket.close(); } catch {}
  chrome.kill('SIGTERM');
  server.close();
}
