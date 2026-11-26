/**
 * AUD-013 浏览器实测（Chrome DevTools Protocol）。
 *
 * 目的：在真实 Chromium DOM 里点击任务详情的日期/优先级/提醒/状态/象限，
 * 截图留证，刷新页面验证持久化，并复核跨页一致性与已知缺陷。
 *
 * 做法：静态服务 app/dist；用 Page.addScriptToEvaluateOnNewDocument 在任何
 * 页面脚本之前注入 tests/harness/fakeTauri.ts 的内存 IPC 替身，并把 db 写入
 * localStorage，使 reload 后仍读取同一份后端数据。产品代码不参与修改。
 *
 * 运行（脚本会自行用 esbuild 打包 harness）：
 *   pnpm build
 *   node tests/e2e/aud013-browser.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/aud013');
const FAKE_BUNDLE = '/tmp/zx-fake.js';
const PORT = 8899;
const DEBUG_PORT = 9223;
const CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TASK_TITLE = '完成验收报告';
const TASK_ID = 'task-acceptance';

fs.mkdirSync(EVIDENCE, { recursive: true });
for (const file of fs.readdirSync(EVIDENCE)) {
  if (file.endsWith('.png')) fs.unlinkSync(path.join(EVIDENCE, file));
}

const esbuild = path.join(
  ROOT,
  'node_modules/.pnpm/node_modules/.bin/esbuild',
);
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
function note(message, data) {
  const line = data === undefined ? message : `${message} ${JSON.stringify(data)}`;
  summaries.push(line);
  console.log(`[aud013-browser] ${line}`);
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

const userDataDir = `/tmp/zx-chrome-aud013-${Date.now()}`;
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
  note(`截图已保存 ${path.relative(ROOT, file)}`);
}

const injection = `(() => {
  let raw = null;
  let emptyFlag = false;
  try {
    raw = localStorage.getItem('zx_aud013_db');
    emptyFlag = localStorage.getItem('zx_aud013_empty') === '1';
  } catch (error) {}
  __ZX_FAKE_BUNDLE__
  try {
    const world = ZXFake.createFakeWorld();
    if (raw) {
      const saved = JSON.parse(raw);
      for (const [key, value] of Object.entries(saved)) {
        if (Array.isArray(value)) world.db[key] = value;
      }
    }
    if (emptyFlag) {
      world.db.tasks = [];
      world.db.subtasks = [];
    }
    world.install();
    const originalInvoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await originalInvoke(command, args);
      if (!emptyFlag) {
        try {
          localStorage.setItem('zx_aud013_db', JSON.stringify(world.db));
        } catch (error) {}
      }
      return result;
    };
    window.__ZX_WORLD__ = world;
    window.__ZX_TEST__ = {
      task() {
        return world.db.tasks.find((item) => item.id === '${TASK_ID}') ?? null;
      },
      click(selector) {
        const element = document.querySelector(selector);
        if (!element) throw new Error('找不到元素：' + selector);
        element.click();
        return true;
      },
      clickText(rootSelector, text) {
        const element = Array.from(
          document.querySelectorAll(rootSelector),
        ).find((item) => (item.textContent || '').trim() === text);
        if (!element) throw new Error('找不到文本：' + rootSelector + ' / ' + text);
        element.click();
        return true;
      },
      openTask() {
        const row = document.querySelector(
          '[aria-label="查看任务：${TASK_TITLE}"]',
        );
        const card = document.querySelector(
          '.task-card[data-task-id="${TASK_ID}"]',
        );
        const element = row || card;
        if (!element) throw new Error('找不到任务行/卡片');
        element.click();
        return true;
      },
      setSelect(id, value) {
        const element = document.getElementById(id);
        if (!element) throw new Error('找不到下拉：' + id);
        const setter = Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          'value',
        ).set;
        setter.call(element, value);
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      setDate(value) {
        const element = document.getElementById('task-detail-date');
        if (!element) throw new Error('找不到日期输入');
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        ).set;
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      fields() {
        const read = (id) => {
          const element = document.getElementById(id);
          return element ? element.value : null;
        };
        return {
          date: read('task-detail-date'),
          priority: read('task-detail-priority'),
          reminder: read('task-detail-reminder'),
          status: read('task-detail-status'),
          quadrant: read('task-detail-quadrant'),
        };
      },
      detailOpen() {
        const input = document.getElementById('task-detail-title');
        return Boolean(input);
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
    `document.readyState === 'complete' && document.body && document.body.innerText.includes('今天')`,
    `页面加载 ${url}`,
  );
  const initError = await evaluate('window.__ZX_INIT_ERROR__ ?? null');
  if (initError) throw new Error(`注入初始化失败：${initError}`);
}

async function openDetail() {
  await evaluate(`window.__ZX_TEST__.openTask()`);
  await waitFor(`window.__ZX_TEST__.detailOpen()`, '任务详情打开');
}

async function expectFields(expected, label) {
  const actual = await evaluate('window.__ZX_TEST__.fields()');
  const keys = Object.keys(expected);
  for (const key of keys) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `${label}：${key} 期望 ${expected[key]}，实际 ${actual[key]}（${JSON.stringify(actual)}）`,
      );
    }
  }
  note(`${label} 详情字段一致`, actual);
  return actual;
}

try {
  await navigate(`http://127.0.0.1:${PORT}/today`);
  await waitFor(
    `document.querySelector('[aria-label="查看任务：${TASK_TITLE}"]') !== null`,
    '今天列表出现种子任务',
  );
  const worldToday = await evaluate('window.__ZX_WORLD__.today');
  const tomorrow = await evaluate(`(() => {
    const date = new Date(window.__ZX_WORLD__.today + 'T12:00:00');
    date.setDate(date.getDate() + 1);
    const pad = (value) => String(value).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  })()`);
  note('真实 Chromium 已加载知行生产构建', {
    today: worldToday,
    tomorrow,
    task: await evaluate('window.__ZX_TEST__.task()'),
  });
  await screenshot('00-today-initial.png');

  await openDetail();
  await expectFields(
    {
      date: worldToday,
      priority: '3',
      reminder: '',
      status: 'todo',
      quadrant: '1',
    },
    '初始值',
  );

  // 1. 日期
  await evaluate(`window.__ZX_TEST__.setDate('${tomorrow}')`);
  await waitFor(
    `window.__ZX_TEST__.task().dueDate === '${tomorrow}'`,
    '日期写入后端',
  );
  await waitFor(
    `document.querySelector('.task-detail-meta')?.textContent.includes('到期 ${tomorrow}')`,
    '详情元信息显示新日期',
  );
  note('日期修改后立即可见', {
    db: await evaluate('window.__ZX_TEST__.task().dueDate'),
    meta: await evaluate(
      `document.querySelector('.task-detail-meta')?.textContent`,
    ),
  });
  await screenshot('01-date.png');
  await evaluate(`window.__ZX_TEST__.setDate('${worldToday}')`);
  await waitFor(
    `window.__ZX_TEST__.task().dueDate === '${worldToday}'`,
    '日期恢复今天',
  );

  // 2. 优先级
  await evaluate(`window.__ZX_TEST__.setSelect('task-detail-priority', '1')`);
  await waitFor(
    `window.__ZX_TEST__.task().priority === 1`,
    '优先级写入后端',
  );
  await waitFor(
    `document.querySelector('[aria-label="优先级 1"]') !== null`,
    '行内优先级点更新',
  );
  note('优先级修改后行内点与详情同步', {
    db: await evaluate('window.__ZX_TEST__.task().priority'),
    badge: await evaluate(
      `document.querySelector('.task-row [aria-label="优先级 1"]')?.querySelectorAll('i.on').length`,
    ),
  });
  await screenshot('02-priority.png');

  // 3. 提醒
  await evaluate(`window.__ZX_TEST__.setSelect('task-detail-reminder', '15m')`);
  await waitFor(
    `window.__ZX_TEST__.task().reminder === '15m'`,
    '提醒写入后端',
  );
  await waitFor(
    `document.body.innerText.includes('提醒已更新')`,
    '提醒 toast',
  );
  note('提醒修改后下拉与 toast 可见', {
    db: await evaluate('window.__ZX_TEST__.task().reminder'),
    select: await evaluate(
      `document.getElementById('task-detail-reminder').value`,
    ),
  });
  await screenshot('03-reminder.png');

  // 4. 状态
  await evaluate(`window.__ZX_TEST__.setSelect('task-detail-status', 'doing')`);
  await waitFor(
    `window.__ZX_TEST__.task().status === 'doing'`,
    '状态写入后端',
  );
  await waitFor(
    `document.querySelector('[data-task-id="${TASK_ID}"]')?.textContent.includes('进行中')`,
    '行内进行中徽标',
  );
  await evaluate(`window.__ZX_TEST__.clickText('.task-tabs button', '看板')`);
  await waitFor(
    `document.querySelector('[aria-label="进行中列"] [data-task-id="${TASK_ID}"]') !== null`,
    '看板进行中列出现任务',
  );
  note('状态修改后列表徽标与看板列同步', {
    db: await evaluate('window.__ZX_TEST__.task().status'),
    board: await evaluate(
      `document.querySelector('[aria-label="进行中列"]')?.textContent`,
    ),
  });
  await screenshot('04-status-board.png');
  await evaluate(`window.__ZX_TEST__.clickText('.task-tabs button', '列表')`);

  // 5. 象限
  await evaluate(`window.__ZX_TEST__.setSelect('task-detail-quadrant', '2')`);
  await waitFor(
    `window.__ZX_TEST__.task().quadrant === 2`,
    '象限写入后端',
  );
  await evaluate(`window.__ZX_TEST__.clickText('.task-tabs button', '四象限')`);
  await waitFor(
    `document.querySelector('[aria-label="四象限：重要不紧急"] [data-task-id="${TASK_ID}"]') !== null`,
    '四象限视图迁移',
  );
  const q1HasTask = await evaluate(
    `document.querySelector('[aria-label="四象限：重要且紧急"] [data-task-id="${TASK_ID}"]') !== null`,
  );
  note('象限修改后四象限视图迁移', {
    db: await evaluate('window.__ZX_TEST__.task().quadrant'),
    q1HasTask,
  });
  await screenshot('05-quadrant.png');

  // 6. 刷新持久化（视图偏好也持久化）
  await send('Page.reload');
  await waitFor(
    `document.querySelector('[aria-label="四象限：重要不紧急"] [data-task-id="${TASK_ID}"]') !== null`,
    '刷新后恢复四象限与任务',
  );
  await openDetail();
  await expectFields(
    {
      date: worldToday,
      priority: '1',
      reminder: '15m',
      status: 'doing',
      quadrant: '2',
    },
    '刷新后',
  );
  await screenshot('06-after-reload.png');

  // 7. 跨页一致：工作清单
  await evaluate(`window.__ZX_TEST__.click('a[href="/lists"]')`);
  await waitFor(
    `document.querySelector('a[href="/lists/work"]') !== null`,
    '我的清单页面',
  );
  await evaluate(`window.__ZX_TEST__.click('a[href="/lists/work"]')`);
  await waitFor(
    `document.querySelector('[aria-label="查看任务：${TASK_TITLE}"]') !== null`,
    '工作清单出现任务',
  );
  await openDetail();
  await expectFields(
    {
      date: worldToday,
      priority: '1',
      reminder: '15m',
      status: 'doing',
      quadrant: '2',
    },
    '跨页「工作」清单',
  );
  await screenshot('07-cross-page-list.png');

  // 8. 空数据
  await evaluate(`localStorage.setItem('zx_aud013_empty', '1')`);
  await navigate(`http://127.0.0.1:${PORT}/today?view=list`);
  await waitFor(
    `document.body.innerText.includes('今天还没有任务，先加一件最重要的事')`,
    '空数据今天空态',
  );
  const emptyDetail = await evaluate('window.__ZX_TEST__.detailOpen()');
  note('空数据：今天空态与详情引导', {
    emptyDetail,
    text: await evaluate(
      `document.querySelector('.task-detail')?.textContent`,
    ),
  });
  await screenshot('08-empty.png');
  await evaluate(`localStorage.removeItem('zx_aud013_empty')`);

  // 9. 已知缺陷 DEF-AUD013-03：真实 SQLite 种子的中文提醒值
  await navigate(`http://127.0.0.1:${PORT}/today?view=list`);
  await waitFor(
    `document.querySelector('[aria-label="查看任务：${TASK_TITLE}"]') !== null`,
    '恢复任务后今天列表',
  );
  await evaluate(`(() => {
    const task = window.__ZX_TEST__.task();
    task.reminder = '提前 15 分钟';
    localStorage.setItem('zx_aud013_db', JSON.stringify(window.__ZX_WORLD__.db));
    return true;
  })()`);
  await send('Page.reload');
  await waitFor(
    `document.querySelector('[aria-label="查看任务：${TASK_TITLE}"]') !== null`,
    '中文提醒写入后刷新',
  );
  await openDetail();
  const seedReminder = await evaluate(`(() => {
    const element = document.getElementById('task-detail-reminder');
    return {
      value: element.value,
      selectedIndex: element.selectedIndex,
      text: element.options[element.selectedIndex]?.textContent ?? '',
      db: window.__ZX_TEST__.task().reminder,
    };
  })()`);
  note('DEF-AUD013-03 真实浏览器复现：种子中文提醒显示', seedReminder);
  await screenshot('09-reminder-seed.png');

  // 10. 已知缺陷 DEF-AUD013-01：真实 Chromium 中同一 tick 修改多个字段
  await evaluate(`(() => {
    window.__ZX_TEST__.setSelect('task-detail-priority', '0');
    window.__ZX_TEST__.setSelect('task-detail-status', 'todo');
    window.__ZX_TEST__.setSelect('task-detail-quadrant', '3');
    window.__ZX_TEST__.setDate('${tomorrow}');
    return true;
  })()`);
  await waitFor(
    `window.__ZX_TEST__.task().dueDate === '${tomorrow}'`,
    '快速修改最后一项写入',
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  const rapid = await evaluate('window.__ZX_TEST__.task()');
  const rapidFields = await evaluate('window.__ZX_TEST__.fields()');
  note('DEF-AUD013-01 真实浏览器复现', {
    expected: { priority: 0, status: 'todo', quadrant: 3, dueDate: tomorrow },
    actualDb: {
      priority: rapid.priority,
      status: rapid.status,
      quadrant: rapid.quadrant,
      dueDate: rapid.dueDate,
    },
    actualFields: rapidFields,
  });
  await screenshot('10-rapid-defect.png');

  // 11. 删除不存在项：直接走 IPC，验证错误可捕获且不误删
  const beforeCount = await evaluate('window.__ZX_WORLD__.db.tasks.length');
  const deleteMissing = await evaluate(`(async () => {
    try {
      await window.__ZX_WORLD__.invoke('tasks_delete', { id: 'missing-task' });
      return 'unexpected-ok';
    } catch (error) {
      return 'error:' + (error?.message ?? String(error));
    }
  })()`);
  const afterCount = await evaluate('window.__ZX_WORLD__.db.tasks.length');
  note('删除不存在任务', {
    deleteMissing,
    beforeCount,
    afterCount,
  });
  if (!deleteMissing.startsWith('error:') || beforeCount !== afterCount) {
    throw new Error('删除不存在任务行为不符合预期');
  }

  note('控制台错误', { consoleErrors, pageExceptions, consoleWarns });
  if (consoleErrors.length > 0 || pageExceptions.length > 0) {
    throw new Error(
      `控制台存在错误：${JSON.stringify({ consoleErrors, pageExceptions })}`,
    );
  }
  note('浏览器实测完成，控制台零错误');
  console.log('\nAUD013_BROWSER_SUMMARY\n' + summaries.join('\n'));
} catch (error) {
  console.error('[aud013-browser] 失败：', error);
  note('失败', { message: error?.message ?? String(error) });
  try {
    await screenshot('99-failure.png');
  } catch {
    // 忽略截图失败。
  }
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
