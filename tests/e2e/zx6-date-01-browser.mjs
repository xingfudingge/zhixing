/**
 * ZX6-DATE-01 浏览器实测：日期输入与面板双向联动 + 新建倒数日控件视觉一致。
 *
 * 做法：静态服务 app/dist；在页面脚本前注入 tests/harness/fakeTauri.ts 的
 * 内存 IPC 替身；用 Chrome DevTools Protocol 打开「日历 → 新建倒数日」，
 * 实测输入/面板同步、非法输入阻断与控件盒模型，并截图留证。
 *
 * 运行：
 *   pnpm build
 *   node tests/e2e/zx6-date-01-browser.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx6-date-01');
const FAKE_BUNDLE = '/tmp/zx-fake-date.js';
const PORT = 8913;
const DEBUG_PORT = 9231;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

fs.mkdirSync(EVIDENCE, { recursive: true });
for (const file of fs.readdirSync(EVIDENCE)) {
  if (file.endsWith('.png')) fs.unlinkSync(path.join(EVIDENCE, file));
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
function note(message, data) {
  const line = data === undefined ? message : `${message} ${JSON.stringify(data)}`;
  summaries.push(line);
  console.log(`[zx6-date-01] ${line}`);
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
note(`静态服务已启动 http://127.0.0.1:${PORT}`);

const userDataDir = `/tmp/zx-chrome-zx6-date-01-${Date.now()}`;
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
  note(`截图已保存 ${path.relative(ROOT, file)}`);
}

function assert(condition, message, actual) {
  if (!condition) {
    throw new Error(
      actual === undefined ? message : `${message}（实际：${JSON.stringify(actual)}）`,
    );
  }
}

/** 面板与输入框共用的读取函数，注入到页面里供多次调用。 */
const PAGE_HELPERS = `
window.__ZX_DATE__ = {
  panel() { return document.querySelector('.dp-popover'); },
  input() { return document.querySelector('.task-dialog .date-field-input'); },
  field() { return document.querySelector('.task-dialog .date-field'); },
  todayField() { return this.field()?.closest('.task-field') ?? null; },
  setInput(text) {
    const input = this.input();
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value',
    ).set;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },
  pressEnter() {
    this.input().dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }));
  },
  pressEscape() {
    const target = document.activeElement ?? this.input();
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }));
  },
  setCalendar(value) {
    const label = Array.from(document.querySelectorAll('.task-dialog label'))
      .find((item) => item.textContent.trim() === '历法');
    const select = label ? document.getElementById(label.htmlFor) : null;
    if (!select) return false;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype, 'value',
    ).set;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },
  snapshot() {
    const panel = this.panel();
    return {
      input: this.input()?.value ?? null,
      active: document.activeElement?.className ?? null,
      panelOpen: Boolean(panel),
      month: panel?.getAttribute('data-view-month') ?? null,
      title: panel?.querySelector('.dp-title')?.textContent ?? null,
      selected: panel?.querySelector('.dp-day.is-selected')?.getAttribute('data-date') ?? null,
      footer: panel?.querySelector('.dp-preview strong')?.textContent ?? null,
      // ZX6-DESIGN-01 §9.6-9：倒数日日期字段为紧凑字段（showHelper=false），
      // 农历信息只允许 countdown-lunar-preview 一条，不能同时出现辅助行。
      helper: document.querySelector('.task-dialog .date-field-help')?.textContent ?? null,
      lunarPreview: document.querySelector(
        '.task-dialog [data-testid="countdown-lunar-preview"]',
      )?.textContent ?? null,
      lunarHintCount: document.querySelectorAll(
        '.task-dialog .date-field-help, .task-dialog [data-testid="countdown-lunar-preview"]',
      ).length,
      error: document.querySelector('.task-dialog .date-field-error')?.textContent ?? null,
    };
  },
  styles() {
    const read = (element, props) => {
      const style = getComputedStyle(element);
      return Object.fromEntries(props.map((prop) => [prop, style[prop]]));
    };
    const field = this.field();
    const input = this.input();
    const select = this.todayField()?.parentElement?.querySelector('select');
    return {
      dateField: read(field, [
        'height', 'borderTopWidth', 'borderTopColor', 'borderTopStyle',
        'borderRadius', 'backgroundColor',
      ]),
      dateInput: read(input, [
        'fontSize', 'paddingLeft', 'paddingRight', 'lineHeight',
      ]),
      siblingSelect: read(select, [
        'height', 'borderTopWidth', 'borderTopColor', 'borderTopStyle',
        'borderRadius', 'backgroundColor', 'fontSize', 'paddingLeft', 'paddingRight',
      ]),
    };
  },
  nativeDateInputs() {
    return document.querySelectorAll('input[type="date"]').length;
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

const evidence = {
  card: 'ZX6-DATE-01',
  generatedAt: new Date().toISOString(),
  sync: {},
  styles: {},
  invalid: {},
};

async function run() {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/calendar` });
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
  note('新建倒数日弹层已打开');
  await screenshot('01-countdown-dialog.png');

  // 1) 同一行盒模型：日期字段 vs 分类/重复 select
  const styles = await evaluate('window.__ZX_DATE__.styles()');
  evidence.styles = styles;
  for (const prop of [
    'height',
    'borderTopWidth',
    'borderTopColor',
    'borderTopStyle',
    'borderRadius',
    'backgroundColor',
  ]) {
    assert(
      styles.dateField[prop] === styles.siblingSelect[prop],
      `日期字段与 select 的 ${prop} 不一致`,
      { date: styles.dateField[prop], select: styles.siblingSelect[prop] },
    );
  }
  assert(
    styles.dateInput.fontSize === styles.siblingSelect.fontSize,
    '日期输入框与 select 字号不一致',
    { date: styles.dateInput.fontSize, select: styles.siblingSelect.fontSize },
  );
  note('新建倒数日：日期字段与 select 盒模型一致', {
    height: styles.dateField.height,
    radius: styles.dateField.borderRadius,
    border: `${styles.dateField.borderTopWidth} ${styles.dateField.borderTopColor}`,
    fontSize: styles.dateInput.fontSize,
  });

  // 2) 面板打开 + 手输合法日期：未按 Enter 面板就应实时联动
  await evaluate(`document.querySelector('.task-dialog .date-field-icon').click(); true`);
  await waitFor(`Boolean(window.__ZX_DATE__.panel())`, '日期面板打开');
  await evaluate(`window.__ZX_DATE__.setInput('2026/12/25'); true`);
  await waitFor(
    `window.__ZX_DATE__.snapshot().month === '2026-12' &&
     window.__ZX_DATE__.snapshot().selected === '2026-12-25'`,
    '手输合法日期后面板实时联动',
  );
  const live = await evaluate('window.__ZX_DATE__.snapshot()');
  evidence.sync.typedLive = live;
  assert(live.input === '2026/12/25', '手输原文被提前改写', live.input);
  assert(live.month === '2026-12', '未按 Enter 面板月份未联动', live.month);
  assert(live.selected === '2026-12-25', '未按 Enter 面板选中未联动', live.selected);
  note('未按 Enter：手输合法日期面板已实时联动（不提交）');
  await screenshot('02a-input-live-panel.png');

  // 3) Enter：输入框与面板最终同步并提交
  await evaluate(`window.__ZX_DATE__.pressEnter(); true`);
  await waitFor(
    `window.__ZX_DATE__.snapshot().month === '2026-12'`,
    '面板月份跟随手输日期',
  );
  const typed = await evaluate('window.__ZX_DATE__.snapshot()');
  evidence.sync.typed = typed;
  assert(typed.input === '2026-12-25', '输入框未归一化', typed.input);
  assert(typed.selected === '2026-12-25', '面板选中日期未同步', typed.selected);
  assert(typed.month === '2026-12', '面板月份未同步', typed.month);
  assert(typed.title === '2026年12月', '面板标题未同步', typed.title);
  assert(
    typed.footer === '2026年12月25日 周五',
    '面板页脚预览未同步',
    typed.footer,
  );
  // ZX6-DESIGN-01 §9.6-9：倒数日日期字段是紧凑字段，不应有辅助行；
  // 农历信息只有一条（countdown-lunar-preview），见下一步。
  assert(
    typed.helper === null,
    '倒数日日期字段不应出现辅助行（设计 §9.6-9）',
    typed.helper,
  );
  assert(
    typed.active === 'date-field-input',
    '提交后焦点被面板抢走',
    typed.active,
  );
  expectNoError(typed);
  await screenshot('02-input-syncs-panel.png');
  note('面板打开时手输合法日期：输入框、月份、选中高亮、页脚全部同步，无重复辅助行');

  // 3b) 农历提示只有一条：切到农历后辅助行仍为 0，预告行恰为 1
  await evaluate(`window.__ZX_DATE__.setCalendar('lunar'); true`);
  await waitFor(
    `window.__ZX_DATE__.snapshot().lunarHintCount === 1`,
    '农历提示只有一条',
  );
  const lunar = await evaluate('window.__ZX_DATE__.snapshot()');
  evidence.sync.lunar = lunar;
  assert(lunar.helper === null, '农历模式下出现日期辅助行', lunar.helper);
  assert(
    lunar.lunarPreview?.includes('农历'),
    '农历预告行缺少农历信息',
    lunar.lunarPreview,
  );
  note('农历模式：日期字段无辅助行，农历预告行恰为 1 条', {
    lunarPreview: lunar.lunarPreview,
  });
  await screenshot('02b-lunar-single-hint.png');

  // 3) 关闭再打开：定位到刚才的日期
  await evaluate(`window.__ZX_DATE__.pressEscape(); true`);
  await waitFor(`!window.__ZX_DATE__.panel()`, 'Esc 关闭面板');
  await evaluate(`document.querySelector('.task-dialog .date-field-icon').click(); true`);
  await waitFor(`Boolean(window.__ZX_DATE__.panel())`, '再次打开面板');
  const reopened = await evaluate('window.__ZX_DATE__.snapshot()');
  evidence.sync.reopened = reopened;
  assert(reopened.month === '2026-12', '再次打开未定位到日期所在月', reopened.month);
  assert(reopened.selected === '2026-12-25', '再次打开未选中该日期', reopened.selected);
  note('再次打开面板定位到已提交日期', {
    month: reopened.month,
    selected: reopened.selected,
  });

  // 4) 非法输入：行内错误、不跳今天、面板不动、保存被阻断
  await evaluate(`window.__ZX_DATE__.setInput('2026-02-30'); window.__ZX_DATE__.pressEnter(); true`);
  await waitFor(
    `Boolean(window.__ZX_DATE__.snapshot().error)`,
    '非法输入行内错误',
  );
  const invalid = await evaluate(`(() => {
    const snapshot = window.__ZX_DATE__.snapshot();
    const save = Array.from(document.querySelectorAll('.task-dialog button'))
      .find((button) => button.textContent.trim() === '保存');
    return { ...snapshot, saveDisabled: save?.disabled ?? null };
  })()`);
  evidence.invalid = invalid;
  assert(
    invalid.error === '日期不存在，请检查年月日',
    '非法日期文案不符',
    invalid.error,
  );
  assert(invalid.input === '2026-02-30', '非法草稿被覆盖', invalid.input);
  assert(invalid.month === '2026-12', '非法输入把面板跳到今天/别的月份', invalid.month);
  assert(invalid.selected === '2026-12-25', '非法输入改动了面板选中日', invalid.selected);
  assert(invalid.saveDisabled === true, '非法草稿未阻断保存', invalid.saveDisabled);
  note('非法输入：保留原文 + 行内错误 + 不跳今天 + 保存禁用');
  await screenshot('03-invalid-while-panel-open.png');

  // 4b) 关掉面板后行内错误可见（错误文案不被弹层遮挡）
  await evaluate(`window.__ZX_DATE__.pressEscape(); true`);
  await waitFor(`!window.__ZX_DATE__.panel()`, 'Esc 关闭日期面板');
  const inlineError = await evaluate(`(() => {
    const error = document.querySelector('.task-dialog .date-field-error');
    const field = window.__ZX_DATE__.field();
    return {
      text: error?.textContent ?? null,
      redBorder: getComputedStyle(field).borderTopColor,
      saveDisabled: Array.from(document.querySelectorAll('.task-dialog button'))
        .find((button) => button.textContent.trim() === '保存')?.disabled ?? null,
    };
  })()`);
  evidence.invalid.inline = inlineError;
  assert(
    inlineError.text === '日期不存在，请检查年月日',
    '面板关闭后行内错误不可见',
    inlineError.text,
  );
  await screenshot('04-inline-error-visible.png');

  // 5) 再次非法输入后 Esc 恢复已提交值并清错误
  await evaluate(`window.__ZX_DATE__.setInput('2026-13-01'); true`);
  await waitFor(
    `window.__ZX_DATE__.snapshot().input === '2026-13-01'`,
    '非法草稿进入输入框',
  );
  await evaluate(`window.__ZX_DATE__.pressEnter(); true`);
  await waitFor(
    `window.__ZX_DATE__.snapshot().error === '日期不存在，请检查年月日'`,
    '第二次非法输入报错',
  );
  await evaluate(`window.__ZX_DATE__.pressEscape(); true`);
  await waitFor(
    `window.__ZX_DATE__.snapshot().input === '2026-12-25'`,
    'Esc 恢复已提交值',
  );
  const restored = await evaluate('window.__ZX_DATE__.snapshot()');
  evidence.sync.restored = restored;
  assert(restored.error === null, 'Esc 后错误未清除', restored.error);
  note('Esc 恢复最后一次已提交值并清除错误');

  // 5b) 390×844：面板完整在视口内、无页面横向滚动（设计 §9.6-8）
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(`document.querySelector('.task-dialog .date-field-icon').click(); true`);
  await waitFor(`Boolean(window.__ZX_DATE__.panel())`, '窄窗日期面板打开');
  const narrow = await evaluate(`(() => {
    const panel = document.querySelector('.dp-popover');
    const rect = panel.getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  })()`);
  evidence.narrow = narrow;
  assert(
    narrow.left >= 0 && narrow.right <= narrow.innerWidth,
    '390 宽下面板横向越界',
    narrow,
  );
  assert(
    narrow.top >= 0 && narrow.bottom <= narrow.innerHeight,
    '390×844 下面板纵向越界',
    narrow,
  );
  assert(
    narrow.scrollWidth === narrow.clientWidth,
    '390 宽出现页面横向滚动',
    narrow,
  );
  await screenshot('05-date-390.png');
  note('390×844：面板完整在视口内、无页面横向滚动', narrow);
  await evaluate(`window.__ZX_DATE__.pressEscape(); true`);
  await waitFor(`!window.__ZX_DATE__.panel()`, '窄窗 Esc 关闭面板');

  // 6) 门禁：页面不存在原生 date input
  const nativeCount = await evaluate('window.__ZX_DATE__.nativeDateInputs()');
  evidence.nativeDateInputs = nativeCount;
  assert(nativeCount === 0, '出现了 input[type=date]', nativeCount);
  note('页面无 input[type=date]');

  assert(pageExceptions.length === 0, '页面异常', pageExceptions);
  assert(consoleErrors.length === 0, '控制台 error', consoleErrors);
  note('控制台 0 error、0 页面异常');
}

function expectNoError(snapshot) {
  assert(snapshot.error === null, '合法输入不应出现行内错误', snapshot.error);
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
  note(`失败：${error.message}`);
  try {
    await screenshot('99-failure.png');
  } catch {
    // 截图失败不覆盖原始错误。
  }
} finally {
  evidence.consoleErrors = consoleErrors;
  evidence.pageExceptions = pageExceptions;
  evidence.passed = failure === null;
  fs.writeFileSync(
    path.join(EVIDENCE, 'result.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  note(`结果已写入 ${path.relative(ROOT, path.join(EVIDENCE, 'result.json'))}`);
  socket.close();
  chrome.kill();
  server.close();
}

if (failure) {
  console.error(`\n[zx6-date-01] 实测失败：${failure.message}`);
  process.exitCode = 1;
} else {
  console.log('\n[zx6-date-01] 全部实测通过');
}
