/**
 * ZX13-FULL-QA-01 真实 Chromium 冒烟：设置 / 日历 / 知识基础。
 *
 * 真实生产构建 + 真实 Chromium（CDP）+ tests/harness/fakeTauri 的内存 IPC
 * 替身；产品代码与既有测试不改。用于补充桌面壳之外的浏览器口径。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx13-full-qa-browser.mjs
 *
 * 证据：tests/evidence/zx13-full-qa/browser/
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx13-full-qa/browser');
const FAKE_BUNDLE = '/tmp/zx13-full-qa-fake-tauri.js';
const PORT = 8960;
const DEBUG_PORT = 9230;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
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
if (bundled.status !== 0) {
  throw new Error(`fakeTauri 打包失败：${bundled.stderr}`);
}
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
  const pathname = decodeURIComponent(
    new URL(request.url ?? '/', 'http://x').pathname,
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

const userDataDir = `/tmp/zx13-full-qa-chrome-${Date.now()}`;
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
      /* retry */
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
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    pageExceptions.push(
      details.exception?.description ?? details.text ?? 'unknown',
    );
  }
  if (
    message.method === 'Log.entryAdded' &&
    message.params.entry.level === 'error'
  ) {
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

const checks = [];
const failures = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(
    `[zx13-browser] ${ok ? 'PASS' : 'FAIL'} ${name}`,
    detail === undefined ? '' : JSON.stringify(detail).slice(0, 1200),
  );
  if (!ok) failures.push(`${name}：${JSON.stringify(detail)}`);
}

const injection = `(() => {
  try {
    __ZX_FAKE_BUNDLE__
    const world = ZXFake.createFakeWorld({});
    world.install();
    window.__ZX_WORLD__ = world;
  } catch (error) {
    window.__ZX_INIT_ERROR__ = String(error && error.stack ? error.stack : error);
  }
})();`.replace('__ZX_FAKE_BUNDLE__', () => fakeBundle);

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: injection });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/today` });
  await waitFor(
    `document.body.innerText.includes('工作台') && !window.__ZX_INIT_ERROR__`,
    '浏览器加载工作台',
    25_000,
  );
  check('浏览器：生产构建启动并进入今天', true, {
    url: await evaluate('location.pathname'),
    initError: await evaluate('window.__ZX_INIT_ERROR__ || null'),
  });
  await screenshot('01-today.png');

  const groups = [
    ['appearance', '外观与阅读'],
    ['task', '任务与记录'],
    ['calendar', '日历与工作日'],
    ['notify', '提醒与通知'],
    ['ocr', '知识库与 OCR'],
    ['privacy', '隐私与安全'],
    ['sync', '同步与网络'],
    ['data', '数据与备份'],
    ['license', '许可与设备'],
  ];
  const settings = [];
  for (const [id, title] of groups) {
    await evaluate(
      `history.pushState({}, '', '/settings/${id}'); window.dispatchEvent(new PopStateEvent('popstate')); true`,
    );
    await waitFor(
      `document.querySelector('.settings-card h2') && document.querySelector('.settings-card h2').textContent.trim() === ${JSON.stringify(title)}`,
      `设置分组 ${title}`,
    );
    const state = await evaluate(`(() => {
      const card = document.querySelector('.settings-card');
      const text = card ? card.innerText.replace(/\\s+/g, ' ').trim() : '';
      return {
        title: card && card.querySelector('h2') ? card.querySelector('h2').textContent.trim() : '',
        navCount: document.querySelectorAll('.settings-nav a').length,
        comingSoon: text.includes('即将支持') || text.includes('ComingSoon'),
        // fakeTauri 未实现 ocr_capability / note_encryption_status 时返回的是
        // 真实错误文案（“未实现的 IPC 命令”），属于浏览器替身边界，不是 UI
        // 假完成；真正的“未实现/即将支持”入口仍会被判失败。
        unimplemented: text
          .split('未实现')
          .slice(1)
          .some((rest) => !rest.startsWith('的 IPC 命令')),
        unimplementedText: (() => {
          const index = text.indexOf('未实现');
          return index < 0 ? null : text.slice(Math.max(0, index - 60), index + 80);
        })(),
        chars: text.length,
      };
    })()`);
    settings.push({ id, ...state });
  }
  check(
    '设置：浏览器 9 个分组全部渲染，无 ComingSoon/未实现',
    settings.length === 9 &&
      settings.every(
        (item) =>
          item.navCount === 9 && !item.comingSoon && !item.unimplemented,
      ),
    settings,
  );
  await screenshot('02-settings.png');

  await evaluate(
    `history.pushState({}, '', '/calendar'); window.dispatchEvent(new PopStateEvent('popstate')); true`,
  );
  await waitFor(
    `document.querySelector('[data-testid="month-grid"]') !== null`,
    '日历月视图',
  );
  const month = await evaluate(`(() => ({
    title: document.querySelector('[data-testid="calendar-title"]')?.textContent.trim(),
    cells: document.querySelectorAll('[data-testid="month-grid"] [data-testid^="day-"]').length,
    cards: document.querySelectorAll('[data-testid="month-grid"] .calendar-chip').length,
  }))()`);
  check(
    '日历：浏览器月视图 42 格并渲染种子任务',
    month.cells === 42 && month.cards > 0,
    month,
  );
  await screenshot('03-calendar-month.png');

  await evaluate(
    `Array.from(document.querySelectorAll('[aria-label="日历视图"] button')).find((b) => b.getAttribute('aria-label') === '周视图').click(); true`,
  );
  await waitFor(
    `document.querySelector('[data-testid="week-grid"]') !== null`,
    '日历周视图',
  );
  const week = await evaluate(`(() => ({
    title: document.querySelector('[data-testid="calendar-title"]')?.textContent.trim(),
    columns: document.querySelectorAll('[data-testid="week-grid"] .calendar-week-column').length,
  }))()`);
  check('日历：浏览器周视图渲染', week.columns >= 7, week);
  await screenshot('04-calendar-week.png');

  await evaluate(
    `Array.from(document.querySelectorAll('[aria-label="日历视图"] button')).find((b) => b.getAttribute('aria-label') === '日视图').click(); true`,
  );
  await waitFor(
    `document.querySelector('[data-testid="day-view"]') !== null`,
    '日历日视图',
  );
  const day = await evaluate(`(() => ({
    title: document.querySelector('[data-testid="calendar-title"]')?.textContent.trim(),
    timeline: Boolean(document.querySelector('[data-testid="day-timeline"]')),
  }))()`);
  check('日历：浏览器日视图渲染时间轴', day.timeline === true, day);
  await screenshot('05-calendar-day.png');

  await evaluate(
    `history.pushState({}, '', '/knowledge'); window.dispatchEvent(new PopStateEvent('popstate')); true`,
  );
  await waitFor(
    `document.querySelectorAll('[aria-label^="打开笔记："]').length > 0`,
    '知识笔记列表',
  );
  const firstLabel = await evaluate(
    `document.querySelector('[aria-label^="打开笔记："]').getAttribute('aria-label')`,
  );
  await evaluate(
    `document.querySelector('[aria-label^="打开笔记："]').click(); true`,
  );
  await waitFor(
    `document.querySelector('input[aria-label="笔记标题"]') && document.querySelectorAll('.zxe-inline[data-inline-editor="true"]').length > 0`,
    '知识编辑器',
  );
  const knowledge = await evaluate(`(() => {
    const inline = document.querySelector('.zxe-inline[data-inline-editor="true"]');
    inline.focus();
    const range = document.createRange();
    range.selectNodeContents(inline);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, 'ZX13浏览器输入');
    return {
      title: document.querySelector('input[aria-label="笔记标题"]').value,
      text: inline.textContent,
      blocks: document.querySelectorAll('.zxe-body [data-block-id]').length,
      rail: document.querySelectorAll('nav.kn-rail button').length,
    };
  })()`);
  await waitFor(
    `document.body.innerText.includes('ZX13浏览器输入')`,
    '知识输入生效',
  );
  check(
    '知识：浏览器打开真实笔记并输入正文',
    knowledge.blocks > 0 &&
      knowledge.rail >= 9 &&
      knowledge.text.includes('ZX13浏览器输入'),
    { firstLabel, ...knowledge },
  );
  await screenshot('06-knowledge.png');

  const errors = consoleErrors.filter(
    (line) =>
      !line.includes('Not implemented') &&
      !line.includes('React Router') &&
      !line.includes('Download the React DevTools'),
  );
  check(
    '控制台：浏览器设置/日历/知识基础流程零 error / 零异常',
    errors.length === 0 && pageExceptions.length === 0,
    { consoleErrors: errors, pageExceptions },
  );
} catch (error) {
  failures.push(`fatal: ${String((error && error.stack) || error)}`);
  console.error('[zx13-browser] FATAL', error);
} finally {
  try {
    socket.close();
  } catch {
    /* ignore */
  }
  chrome.kill('SIGTERM');
  server.close();
}

const summary = {
  task: 'ZX13-FULL-QA-01',
  kind: 'chromium-browser',
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  head: spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout.trim(),
  checks,
  failures,
  consoleErrors: consoleErrors.filter(
    (line) =>
      !line.includes('Not implemented') &&
      !line.includes('React Router') &&
      !line.includes('Download the React DevTools'),
  ),
  pageExceptions,
};
fs.writeFileSync(
  path.join(EVIDENCE, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);

const passed = checks.filter((item) => item.ok).length;
console.log(
  `\n[zx13-browser] ${passed}/${checks.length} 项通过，${failures.length} 项失败`,
);
if (failures.length) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('[zx13-browser] PASS');
