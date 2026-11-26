/**
 * ZX11-QA-01 独立浏览器验收（真实 Chromium + app/dist + localStorage）。
 *
 * 只读产品代码；不注入 Tauri 替身，验证真正的“浏览器预览”分支：
 *   - 设置 9 分组全部渲染，无 ComingSoonRow / “即将支持”；
 *   - OCR 明确提示“当前为浏览器预览，需桌面壳”，不误报“系统没有 OCR”；
 *   - 隐私：诊断默认关闭、加密仅桌面壳、开关真实可操作；
 *   - 日历：周起始/工作日/节假日/个人例外写入 localStorage，刷新保持；
 *   - 偏好备份 v5 导出/导入往返（含新键）；v1 迁移补默认；坏文件报错；
 *   - 快速连点、空数据、控制台零报错。
 *
 * 运行：pnpm --filter app build && node tests/e2e/zx11-qa-01-browser.mjs
 * 证据：tests/evidence/zx11-qa-01/browser/
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx11-qa-01/browser');
const DOWNLOADS = '/tmp/zx11-qa-01-downloads';
const FIXTURES = path.join(ROOT, 'tests/evidence/zx11-qa-01/fixtures');
const PORT = 8896;
const DEBUG_PORT = 9226;
const CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
fs.mkdirSync(EVIDENCE, { recursive: true });
fs.rmSync(DOWNLOADS, { recursive: true, force: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });
for (const name of fs.readdirSync(EVIDENCE)) {
  if (/\.(png|json|txt)$/.test(name)) fs.rmSync(path.join(EVIDENCE, name));
}

const holiday = (year, days) => JSON.stringify({ year, papers: [], days });
const HOLIDAYS = {
  '/__holiday/2026.json': {
    body: holiday(2026, [
      { name: '验收跨年假日', date: '2026-12-31', isOffDay: true },
    ]),
  },
  '/__holiday/2027.json': { body: holiday(2027, []) },
  '/__holiday/full/2026.json': {
    body: holiday(2026, [
      { name: '验收跨年假日', date: '2026-12-31', isOffDay: true },
    ]),
  },
  '/__holiday/full/2027.json': {
    body: holiday(2027, [
      { name: '元旦验收', date: '2027-01-01', isOffDay: true },
    ]),
  },
  '/__holiday/fail.json': { body: '{not json' },
  '/__holiday/bad.json': { body: '{not json' },
};

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
  const url = new URL(request.url ?? '/', 'http://x');
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith('/__holiday/')) {
    const fixture = HOLIDAYS[pathname];
    if (fixture) {
      response.writeHead(fixture.status ?? 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'ETag, Last-Modified',
        ETag: `"zx11-${pathname}"`,
        'Cache-Control': 'no-store',
      });
      response.end(fixture.body);
    } else {
      response.writeHead(404, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      response.end('{"error":"not found"}');
    }
    return;
  }
  if (pathname.startsWith('/__fixtures/')) {
    const file = path.join(FIXTURES, pathname.slice('/__fixtures/'.length));
    if (file.startsWith(FIXTURES) && fs.existsSync(file)) {
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(file).pipe(response);
      return;
    }
  }
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

const userDataDir = `/tmp/zx11-qa-01-chrome-${Date.now()}`;
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
    }, 30_000);
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
  // 把 this 绑定到 window.__qa，便于页面内测试片段调用 __qa 帮助方法；
  // HELPERS 自身在首次注入时也会通过这里执行（此时 __qa 尚未赋值）。
  // 去掉表达式末尾的单个分号，避免 `return ((() => {...})();)` 语法错误。
  const body = expression.replace(/;\s*$/, '');
  const wrapped = `(function(){ return (${body}); }).call(window.__qa);`;
  const result = await send('Runtime.evaluate', {
    expression: wrapped,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        '页面执行失败',
    );
  }
  return result.result?.value;
}

async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  fs.writeFileSync(path.join(EVIDENCE, `${name}.png`), Buffer.from(data, 'base64'));
}

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Browser.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: DOWNLOADS,
  eventsEnabled: true,
});

const HELPERS = `(() => {
  window.__qa = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    norm: (value) => String(value ?? '').replace(/\\s+/g, ' ').trim(),
    visible(el) {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0.5 && rect.height > 0.5;
    },
    async waitFor(check, timeout = 10000, label = 'condition') {
      const start = Date.now();
      let last;
      while (Date.now() - start < timeout) {
        last = check();
        if (last) return last;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      throw new Error('等待超时：' + label);
    },
    async go(path, heading) {
      history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
      await this.waitFor(
        () => document.querySelector('h1')?.textContent?.includes(heading),
        12000,
        path + ' 页面标题',
      );
      await this.sleep(250);
    },
    setSelect(el, value) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value',
      ).set;
      setter.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    setInput(el, value) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    button(text, root = document) {
      return Array.from(root.querySelectorAll('button')).find(
        (item) => this.visible(item) && this.norm(item.textContent).includes(text),
      );
    },
    byLabel(label, root = document) {
      return root.querySelector('[aria-label="' + label + '"]');
    },
    async clickText(text, root = document) {
      const el = await this.waitFor(
        () => this.button(text, root),
        8000,
        '按钮 ' + text,
      );
      el.click();
      await this.sleep(150);
    },
    async settingsMirror() {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && parsed.calendar && parsed.privacy) {
            return { key, value: parsed };
          }
        } catch {
          /* ignore */
        }
      }
      return null;
    },
    async importBackup(text, name) {
      const input = document.querySelector('input[aria-label="选择偏好备份文件"]');
      if (!input) throw new Error('找不到偏好备份文件输入框');
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([text], name || 'backup.json', { type: 'application/json' }),
      );
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await this.sleep(800);
    },
  };
})();`;

async function pageReady() {
  await evaluate(`(async () => {
    const start = Date.now();
    while (Date.now() - start < 30000) {
      if (document.querySelector('.shell') || document.querySelector('.settings-page')) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('应用未就绪：' + document.body.innerText.slice(0, 300));
  })()`);
  await evaluate(HELPERS);
}

async function go(path, heading) {
  await evaluate(
    `window.__qa.go(${JSON.stringify(path)}, ${JSON.stringify(heading)})`,
  );
}

await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/settings/appearance` });
await pageReady();

const result = {
  task: 'ZX11-QA-01',
  kind: 'browser-preview',
  startedAt: new Date().toISOString(),
  head: fs.readFileSync(path.join(ROOT, 'tests/evidence/zx11-qa-01/head.txt'), 'utf8'),
  checks: [],
  failures: [],
  consoleErrors,
  pageExceptions,
};

const check = (name, ok, detail) => {
  result.checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) result.failures.push(`${name}：${JSON.stringify(detail)}`);
  console.log(`[zx11-browser] ${ok ? 'PASS' : 'FAIL'} ${name}`, detail ?? '');
};

try {
  const GROUPS = [
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
  const groupScan = [];
  for (const [id, label] of GROUPS) {
    await go(`/settings/${id}`, '设置');
    const scan = await evaluate(`(() => {
      const body = document.querySelector('.settings-body');
      const rows = Array.from(body.querySelectorAll('.settings-row'));
      const disabled = Array.from(body.querySelectorAll('button:disabled, select:disabled, input:disabled'))
        .map((el) => this.norm(el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.tagName));
      return {
        navCount: document.querySelectorAll('.settings-nav a').length,
        activeNav: document.querySelector('.settings-nav a.is-active')?.textContent ?? null,
        cardTitle: body.querySelector('h2')?.textContent ?? null,
        rowCount: rows.length,
        comingSoon: body.innerText.includes('即将支持') || body.innerText.includes('尚未实现'),
        disabled,
        text: this.norm(body.innerText).slice(0, 260),
        href: location.pathname,
      };
    })()`);
    await screenshot(`settings-${id}`);
    groupScan.push({ id, label, scan });
    check(
      `设置分组 ${label} 渲染`,
      scan.href === `/settings/${id}` &&
        scan.navCount === 9 &&
        Boolean(scan.cardTitle),
      scan,
    );
    check(`设置分组 ${label} 无 ComingSoon`, !scan.comingSoon, {
      text: scan.text,
    });
  }
  result.groups = groupScan;
  check(
    '设置导航为 9 分组',
    groupScan.every((group) => group.scan.navCount === 9),
    groupScan.map((group) => group.scan.navCount),
  );

  // OCR 浏览器预览：必须提示需桌面壳，不误报系统没有 OCR。
  await go('/settings/ocr', '设置');
  const ocr = await evaluate(`(async () => {
    const panel = document.querySelector('[aria-label="图片 OCR"]');
    await this.waitFor(() => panel && panel.innerText.includes('浏览器预览'), 12000, 'OCR 浏览器提示');
    const text = this.norm(panel.innerText);
    const status = this.norm(panel.querySelector('.zx-ocr-status-main')?.innerText ?? '');
    await this.clickText('测试引擎可用性', panel);
    await this.sleep(600);
    const afterProbe = this.norm(panel.querySelector('.zx-ocr-status-main')?.innerText ?? '');
    // 处理队列按产品规则在总开关关闭时禁用；先真实开启 OCR，再判定它是否永久禁用。
    const toggle = panel.querySelector('.zx-ocr-toggle input[type="checkbox"]');
    if (toggle && !toggle.checked) {
      toggle.click();
      await this.sleep(300);
    }
    const scope = panel.querySelector('select') && Array.from(panel.querySelectorAll('select'))[1];
    this.setSelect(scope, 'folder');
    await this.sleep(300);
    const scopeText = this.norm(panel.querySelector('[aria-label="OCR 数据去向"]')?.innerText ?? '');
    const fileInput = panel.querySelector('input[type="file"]');
    const processButton = Array.from(panel.querySelectorAll('button')).find((b) => (b.textContent || '').includes('处理队列'));
    const processEnabled = Boolean(processButton && !processButton.disabled);
    let processError = '';
    if (processEnabled) {
      processButton.click();
      await this.sleep(500);
      processError = this.norm(panel.querySelector('.zx-ocr-error')?.innerText ?? '');
    }
    return {
      text,
      status,
      afterProbe,
      saysNeedsDesktop: text.includes('需桌面壳'),
      falselySaysNoOcr: /系统没有\\s*OCR|系统未提供\\s*OCR|WebView 未提供 TextDetector/.test(text),
      hasTextDetectorPreview: text.includes('TextDetector'),
      scopeValue: scope?.value ?? null,
      scopeText,
      hasFolderPicker: Boolean(panel.querySelector('[aria-label*="目录"]')),
      ocrEnabled: Boolean(toggle?.checked),
      processDisabled: Boolean(processButton?.disabled),
      processTitle: processButton?.title ?? null,
      processError,
      fileInputDisabled: Boolean(fileInput?.disabled),
      queueEmpty: text.includes('暂无 OCR 作业'),
      engineText: text,
    };
  })()`);
  await screenshot('settings-ocr-browser');
  check('OCR 浏览器预览提示需桌面壳', ocr.saysNeedsDesktop, ocr);
  check(
    'OCR 不误报“系统没有 OCR”',
    !ocr.text.includes('当前系统/WebView 未提供 TextDetector') &&
      !ocr.text.includes('当前系统没有 OCR') &&
      !ocr.text.includes('当前 WebView 没有 OCR'),
    ocr,
  );
  // 识别范围“指定目录”必须有目录选择；否则就是“存了但没生效”。
  check('OCR 指定目录有目录选择器', ocr.hasFolderPicker, ocr);
  // 处理队列必须真实可用，而不是长期禁用（前置条件：OCR 已开启）。
  check('OCR 浏览器预览开启 OCR 成功', ocr.ocrEnabled, ocr);
  check(
    'OCR 设置页处理队列可用',
    !ocr.processDisabled,
    { disabled: ocr.processDisabled, title: ocr.processTitle },
  );
  check('OCR 处理队列真实可点击且无错误', !ocr.processError, {
    error: ocr.processError,
  });
  check('OCR 空队列空态真实', ocr.queueEmpty, ocr);

  // 静态核对：scope / textStorage 是否真的有消费方（不是只写设置）。
  const ocrServiceSource = fs.readFileSync(
    path.join(ROOT, 'app/src/features/ocr/service.ts'),
    'utf8',
  );
  const ocrActionSource = fs.readFileSync(
    path.join(ROOT, 'app/src/features/ocr/OcrImageAction.tsx'),
    'utf8',
  );
  const syncRoots = [
    path.join(ROOT, 'app/src/features/sync'),
    path.join(ROOT, 'app/src/sync'),
    path.join(ROOT, 'packages/sync-webdav/src'),
  ];
  const syncSources = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (name === '__tests__') continue;
        walk(full);
      } else if (
        /\.(ts|tsx)$/.test(name) &&
        !name.endsWith('.test.ts') &&
        !name.endsWith('.test.tsx')
      ) {
        syncSources.push(fs.readFileSync(full, 'utf8'));
      }
    }
  };
  for (const root of syncRoots) walk(root);
  const scopeConsumed =
    /settings\.scope|\.scope\s*===|scope\s*===/.test(ocrServiceSource) ||
    /settings\.scope|\.scope\s*===|scope\s*===/.test(ocrActionSource);
  const textStorageConsumed = syncSources.some((source) =>
    source.includes('textStorage'),
  );
  check('OCR scope 有真实消费方（非只存设置）', scopeConsumed, {
    service: /scope/.test(ocrServiceSource),
    action: /scope/.test(ocrActionSource),
  });
  check('OCR textStorage=sync 有真实同步消费方', textStorageConsumed, {
    syncFiles: syncSources.length,
  });

  // 隐私：默认关闭、加密仅桌面壳、开关可操作。
  await go('/settings/privacy', '设置');
  const privacy = await evaluate(`(async () => {
    const body = document.querySelector('.settings-body');
    await this.sleep(400);
    const diagnostics = body.querySelector('button[role="switch"][aria-label="开启本机诊断记录"]');
    const download = Array.from(body.querySelectorAll('button')).find((b) => (b.textContent || '').includes('下载诊断 JSON'));
    const mirror = await this.settingsMirror();
    return {
      diagnosticsChecked: diagnostics?.getAttribute('aria-checked'),
      downloadDisabled: Boolean(download?.disabled),
      encryptionBadge: body.innerText.includes('仅桌面壳'),
      hasEncryptionEnableButton: body.innerText.includes('设置口令并加密全部笔记'),
      hideOnBlur: Boolean(body.querySelector('button[role="switch"][aria-label="失焦时遮挡内容"]')),
      clipboard: Boolean(body.querySelector('select[aria-label="剪贴板自动清空"]')),
      diagnosticsMirror: mirror?.value?.privacy?.diagnosticsEnabled ?? null,
      text: this.norm(body.innerText).slice(0, 300),
    };
  })()`);
  await screenshot('settings-privacy-browser');
  check('诊断默认关闭（UI）', privacy.diagnosticsChecked === 'false', privacy);
  check('诊断下载默认禁用', privacy.downloadDisabled, privacy);
  check('浏览器加密仅桌面壳且无假开关', privacy.encryptionBadge && !privacy.hasEncryptionEnableButton, privacy);
  check('隐私开关真实可操作', privacy.hideOnBlur && privacy.clipboard, privacy);

  // 快速连点诊断开关：最终状态与 UI 一致，无报错。
  const rapid = await evaluate(`(async () => {
    const body = document.querySelector('.settings-body');
    const toggle = body.querySelector('button[role="switch"][aria-label="开启本机诊断记录"]');
    for (let index = 0; index < 9; index += 1) {
      toggle.click();
    }
    await this.sleep(1200);
    const mirror = await this.settingsMirror();
    return {
      aria: toggle.getAttribute('aria-checked'),
      stored: mirror?.value?.privacy?.diagnosticsEnabled ?? null,
    };
  })()`);
  check('诊断快速连点 9 次后 UI 与存储一致', rapid.aria === String(rapid.stored), rapid);
  await screenshot('settings-privacy-rapid');

  // 恢复诊断关闭，减少后续状态干扰；同时确认关闭状态已写回存储。
  const diagnosticsOff = await evaluate(`(async () => {
    const toggle = document.querySelector('button[role="switch"][aria-label="开启本机诊断记录"]');
    if (toggle.getAttribute('aria-checked') === 'true') {
      toggle.click();
      await this.sleep(700);
    }
    const mirror = await this.settingsMirror();
    return {
      aria: toggle.getAttribute('aria-checked'),
      stored: mirror?.value?.privacy?.diagnosticsEnabled ?? null,
    };
  })()`);
  check(
    '诊断关闭后 UI 与 localStorage 一致',
    diagnosticsOff.aria === 'false' && diagnosticsOff.stored === false,
    diagnosticsOff,
  );

  // 日历设置：周起始、工作日、节假日源、个人例外写 localStorage 并刷新保持。
  await go('/settings/calendar', '设置');
  const calendar = await evaluate(`(async () => {
    const body = document.querySelector('.settings-body');
    await this.waitFor(() => body.querySelector('select[aria-label="工作日规则"]'), 8000, '工作日规则');
    const segmented = body.querySelector('[aria-label="周起始日"]');
    const sunday = Array.from(segmented.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '周日');
    sunday.click();
    await this.sleep(500);
    const rule = body.querySelector('select[aria-label="工作日规则"]');
    this.setSelect(rule, 'single');
    await this.sleep(500);
    const source = body.querySelector('select[aria-label="节假日数据源"]');
    this.setSelect(source, 'custom');
    await this.sleep(400);
    const urlInput = await this.waitFor(() => body.querySelector('input[aria-label="自定义节假日 URL"]'), 8000, '自定义 URL');
    this.setInput(urlInput, 'http://127.0.0.1:${PORT}/__holiday/{year}.json');
    await this.clickText('保存地址', body);
    await this.sleep(700);
    const mirror = await this.settingsMirror();
    return {
      weekStart: mirror?.value?.calendar?.weekStart,
      rule: mirror?.value?.calendar?.workdayRule?.rule,
      source: mirror?.value?.calendar?.holidaySource?.source,
      customUrl: mirror?.value?.calendar?.holidaySource?.customUrl,
      autoSyncDisabled: Boolean(body.querySelector('button[role="switch"][aria-label="自动同步节假日"]')?.disabled) === false,
      exceptionCount: (mirror?.value?.calendar?.dateExceptions ?? []).length,
      text: this.norm(body.innerText).slice(0, 400),
    };
  })()`);
  await screenshot('settings-calendar-browser');
  check('周起始改为周日写入 localStorage', calendar.weekStart === 'sunday', calendar);
  check('工作日规则单休写入 localStorage', calendar.rule === 'single', calendar);
  check('节假日自定义源写入 localStorage', calendar.source === 'custom' && calendar.customUrl.includes('/__holiday/'), calendar);

  // 添加个人例外：优先用真实日期面板；面板未打开时退化为在输入框键入。
  const exception = await evaluate(`(async () => {
    const debug = {
      popoverOpened: false,
      triggerExists: false,
      triggerDisabled: null,
      triggerOuter: null,
      dateValue: '',
      dataValue: '',
      firstCount: null,
      secondCount: null,
      exceptions: [],
      listText: '',
      error: null,
      bodyText: '',
    };
    try {
      const body = document.querySelector('.settings-body');
      const input = body.querySelector('input[aria-label="例外日期"]');
      const group = input.closest('.date-field-group');
      const trigger = group.querySelector('button[aria-label="打开日期选择"]');
      debug.triggerExists = Boolean(trigger);
      debug.triggerOuter = trigger ? trigger.outerHTML.slice(0, 240) : null;
      if (trigger) {
        debug.triggerDisabled = trigger.disabled;
        trigger.click();
        try {
          await this.waitFor(() => document.querySelector('.dp-popover'), 2500, '日期面板');
          debug.popoverOpened = true;
        } catch {
          debug.popoverOpened = false;
        }
      }
      if (debug.popoverOpened) {
        const popover = document.querySelector('.dp-popover');
        const day = await this.waitFor(
          () => Array.from(popover.querySelectorAll('.dp-day')).find((b) => (b.getAttribute('aria-label') || '').includes('2026年11月7日')),
          6000,
          '2026-11-07',
        );
        day.click();
        const confirm = Array.from(popover.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '确定');
        confirm.click();
        await this.sleep(400);
      } else {
        input.focus();
        this.setInput(input, '2026-11-07');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        input.blur();
        await this.sleep(600);
      }
      debug.dateValue = input.value;
      debug.dataValue = input.getAttribute('data-value') || '';
      const kind = body.querySelector('select[aria-label="例外类型"]');
      this.setSelect(kind, 'rest');
      const note = body.querySelector('input[aria-label="例外备注"]');
      this.setInput(note, '验收例外');
      await this.clickText('添加例外', body);
      await this.sleep(700);
      const first = await this.settingsMirror();
      debug.firstCount = (first?.value?.calendar?.dateExceptions ?? []).length;
      // 同日再次保存，改备注，应更新而不是追加。
      const item = await this.waitFor(
        () => body.querySelector('.settings-exception-item'),
        5000,
        '例外列表项',
      );
      await this.clickText('编辑', item);
      await this.waitFor(
        () => this.button('更新例外', body),
        5000,
        '更新例外按钮',
      );
      const noteAgain = body.querySelector('input[aria-label="例外备注"]');
      this.setInput(noteAgain, '验收例外更新');
      await this.clickText('更新例外', body);
      await this.sleep(700);
      const second = await this.settingsMirror();
      debug.secondCount = (second?.value?.calendar?.dateExceptions ?? []).length;
      debug.exceptions = second?.value?.calendar?.dateExceptions ?? [];
      debug.listText = this.norm(body.querySelector('.settings-exception-list')?.innerText ?? '');
      return debug;
    } catch (reason) {
      debug.error = String(reason);
      debug.bodyText = this.norm(document.querySelector('.settings-body')?.innerText ?? '').slice(0, 900);
      return debug;
    }
  })()`);
  await screenshot('settings-calendar-exception-browser');
  check('个人例外日期选择器可用', exception.dateValue === '2026-11-07', exception);
  check('个人例外添加成功', exception.firstCount === 1, exception);
  check('同日再次保存为更新而非追加', exception.secondCount === 1, exception);
  check('个人例外备注更新', exception.exceptions?.[0]?.note === '验收例外更新', exception);

  // 删除个人例外。
  const deleted = await evaluate(`(async () => {
    const body = document.querySelector('.settings-body');
    await this.clickText('删除', body);
    await this.sleep(700);
    const mirror = await this.settingsMirror();
    return { count: (mirror?.value?.calendar?.dateExceptions ?? []).length };
  })()`);
  check('个人例外删除成功', deleted.count === 0, deleted);

  // 刷新后保持周起始/工作日/节假日源。
  await send('Page.reload', { ignoreCache: true });
  await pageReady();
  await go('/settings/calendar', '设置');
  const afterReload = await evaluate(`(async () => {
    const body = document.querySelector('.settings-body');
    await this.waitFor(() => body.querySelector('select[aria-label="工作日规则"]'), 8000, '工作日规则');
    const mirror = await this.settingsMirror();
    return {
      weekStart: mirror?.value?.calendar?.weekStart,
      rule: mirror?.value?.calendar?.workdayRule?.rule,
      activeWeekStart: Array.from(body.querySelectorAll('[aria-label="周起始日"] button')).find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent,
      ruleValue: body.querySelector('select[aria-label="工作日规则"]')?.value,
    };
  })()`);
  check('刷新后周起始保持周日', afterReload.weekStart === 'sunday' && afterReload.activeWeekStart === '周日', afterReload);
  check('刷新后工作日保持单休', afterReload.rule === 'single' && afterReload.ruleValue === 'single', afterReload);

  // 节假日同步：成功 + 跨年空包提示 + 失败保留缓存。
  const holidaySync = await evaluate(`(async () => {
    const body = document.querySelector('.settings-body');
    await this.clickText('立即同步', body);
    await this.waitFor(() => !body.innerText.includes('同步中…'), 20000, '同步完成');
    await this.sleep(500);
    const firstText = this.norm(body.innerText);
    const firstState = this.norm(body.querySelector('[aria-label="设置"]')?.innerText ?? '');
    // 失败 URL
    const urlInput = body.querySelector('input[aria-label="自定义节假日 URL"]');
    this.setInput(urlInput, 'http://127.0.0.1:${PORT}/__holiday/fail.json');
    await this.clickText('保存地址', body);
    await this.sleep(500);
    await this.clickText('立即同步', body);
    await this.waitFor(() => !body.innerText.includes('同步中…'), 20000, '失败同步完成');
    await this.sleep(500);
    const secondText = this.norm(body.innerText);
    return {
      firstHasUnpublished: firstText.includes('2027') && firstText.includes('尚未公布'),
      firstHasSynced:
        firstText.includes('上次同步') ||
        firstText.includes('已同步') ||
        firstText.includes('同步完成'),
      firstHasError: firstText.includes('节假日同步失败'),
      secondHasError: secondText.includes('节假日同步失败'),
      secondRetains2026: secondText.includes('2026'),
      firstText: firstText.slice(0, 700),
      secondText: secondText.slice(0, 700),
    };
  })()`);
  await screenshot('settings-calendar-sync-browser');
  check('节假日同步成功且 2027 未公布提示', holidaySync.firstHasSynced && holidaySync.firstHasUnpublished, holidaySync);
  check('节假日同步失败明确报错并保留 2026 缓存', holidaySync.secondHasError && holidaySync.secondRetains2026, holidaySync);

  // 坏 URL 校验。
  const badUrl = await evaluate(`(async () => {
    const body = document.querySelector('.settings-body');
    const urlInput = body.querySelector('input[aria-label="自定义节假日 URL"]');
    this.setInput(urlInput, 'ftp://example.com/a.json');
    await this.clickText('保存地址', body);
    await this.sleep(500);
    return { hasError: body.innerText.includes('只支持 http/https') };
  })()`);
  check('自定义节假日 URL 拒绝 ftp', badUrl.hasError, badUrl);

  // 偏好备份：导出 v5；导入往返必须保留默认提醒等新键。
  await go('/settings/task', '设置');
  await evaluate(`(async () => {
    const body = document.querySelector('.settings-body');
    const select = body.querySelector('select[aria-label="默认提醒"]');
    this.setSelect(select, '15m');
    await this.sleep(500);
    const completion = body.querySelector('select[aria-label="完成后行为"]');
    this.setSelect(completion, 'remove');
    await this.sleep(500);
  })()`);
  await go('/settings/data', '设置');
  await evaluate(`(async () => {
    await this.clickText('导出 JSON', document.querySelector('.settings-body'));
  })()`);
  let exported = null;
  for (let index = 0; index < 60; index += 1) {
    const files = fs.existsSync(DOWNLOADS)
      ? fs.readdirSync(DOWNLOADS).filter((name) => name.endsWith('.json'))
      : [];
    if (files.length > 0) {
      const file = path.join(DOWNLOADS, files[0]);
      try {
        exported = { file, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
        break;
      } catch {
        /* still writing */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check('偏好备份导出 JSON', Boolean(exported), exported?.file ?? null);
  if (exported) {
    result.backup = exported.json;
    check('备份版本为 5', exported.json.version === 5, exported.json.version);
    check(
      '备份包含默认提醒 15m',
      exported.json.settings?.task?.defaultReminder === '15m',
      exported.json.settings?.task,
    );
    check(
      '备份包含完成后行为 remove',
      exported.json.settings?.task?.completionBehavior === 'remove',
      exported.json.settings?.task,
    );

    // 改掉本地值，再导入刚导出的备份，验证往返恢复。
    await go('/settings/task', '设置');
    await evaluate(`(async () => {
      const body = document.querySelector('.settings-body');
      this.setSelect(body.querySelector('select[aria-label="默认提醒"]'), '');
      await this.sleep(400);
      this.setSelect(body.querySelector('select[aria-label="完成后行为"]'), 'keep');
      await this.sleep(400);
    })()`);
    await go('/settings/data', '设置');
    await evaluate(
      `window.__qa.importBackup(${JSON.stringify(
        JSON.stringify(exported.json),
      )}, 'exported.json')`,
    );
    await go('/settings/task', '设置');
    const roundTrip = await evaluate(`(async () => {
      const body = document.querySelector('.settings-body');
      return {
        reminder: body.querySelector('select[aria-label="默认提醒"]')?.value,
        completion: body.querySelector('select[aria-label="完成后行为"]')?.value,
        error: this.norm(body.querySelector('.settings-banner.is-error')?.innerText ?? ''),
      };
    })()`);
    check('备份导入恢复默认提醒 15m', roundTrip.reminder === '15m', roundTrip);
    check('备份导入恢复完成后行为 remove', roundTrip.completion === 'remove', roundTrip);

    // v1 迁移：构造缺少新键的备份，新键应回默认。
    const v1 = {
      app: 'zhixing',
      kind: 'settings',
      version: 1,
      exportedAt: new Date().toISOString(),
      appearance: exported.json.appearance,
      settings: {
        editor: exported.json.settings.editor,
        task: {
          defaultListId: null,
          noteFolderId: exported.json.settings.task.noteFolderId,
        },
        calendar: { showLunar: true },
        export: { directory: null },
      },
    };
    const v1File = path.join(EVIDENCE, 'backup-v1.json');
    fs.writeFileSync(v1File, JSON.stringify(v1, null, 2));
    await go('/settings/data', '设置');
    await evaluate(
      `window.__qa.importBackup(${JSON.stringify(JSON.stringify(v1))}, 'backup-v1.json')`,
    );
    await go('/settings/task', '设置');
    const migrated = await evaluate(`(async () => {
      const body = document.querySelector('.settings-body');
      return {
        reminder: body.querySelector('select[aria-label="默认提醒"]')?.value,
        completion: body.querySelector('select[aria-label="完成后行为"]')?.value,
      };
    })()`);
    check('v1 备份迁移：默认提醒回默认关闭', migrated.reminder === '', migrated);
    check('v1 备份迁移：完成后行为回 keep', migrated.completion === 'keep', migrated);

    // 坏文件：必须报错，不崩溃。
    const badFile = path.join(EVIDENCE, 'backup-bad.json');
    fs.writeFileSync(badFile, '{not json');
    await go('/settings/data', '设置');
    await evaluate(`window.__qa.importBackup('{not json', 'backup-bad.json')`);
    const badImport = await evaluate(`(() => {
      const body = document.querySelector('.settings-body');
      return { text: this.norm(body.innerText), hasError: body.innerText.includes('文件不是有效的 JSON') };
    })()`);
    check('坏备份文件明确报错', badImport.hasError, badImport);
  }

  // 空数据：OCR 队列空、通知计划空、例外空、任务不可用提示。
  await go('/settings/ocr', '设置');
  const empty = await evaluate(`(() => {
    const body = document.querySelector('.settings-body');
    return {
      ocrQueueEmpty: body.innerText.includes('暂无 OCR 作业'),
      text: this.norm(body.innerText).slice(0, 160),
    };
  })()`);
  check('浏览器空 OCR 队列空态', empty.ocrQueueEmpty, empty);
  await go('/today', '今天');
  const todayEmpty = await evaluate(`(() => {
    const text = document.body.innerText;
    return {
      needsDesktop: text.includes('桌面壳') || text.includes('浏览器预览'),
      text: text.slice(0, 260),
    };
  })()`);
  check('浏览器任务区明确需桌面壳，不伪造数据', todayEmpty.needsDesktop, todayEmpty);

  // 快速连点周起始与完成后行为（不保存失败）。
  await go('/settings/calendar', '设置');
  const rapidCalendar = await evaluate(`(async () => {
    const body = document.querySelector('.settings-body');
    const buttons = Array.from(body.querySelectorAll('[aria-label="周起始日"] button'));
    for (let index = 0; index < 14; index += 1) {
      buttons[index % 2].click();
    }
    await this.sleep(1200);
    const mirror = await this.settingsMirror();
    return {
      weekStart: mirror?.value?.calendar?.weekStart,
      pressed: buttons.map((b) => ({
        text: b.textContent.trim(),
        pressed: b.getAttribute('aria-pressed'),
      })),
      hasError: body.innerText.includes('设置操作失败'),
    };
  })()`);
  check('周起始快速连点无报错且 UI 一致', !rapidCalendar.hasError, rapidCalendar);

  result.finishedAt = new Date().toISOString();
  result.ok = result.failures.length === 0;
  result.consoleErrors = consoleErrors;
  result.pageExceptions = pageExceptions;
  check('浏览器控制台零报错', consoleErrors.length === 0 && pageExceptions.length === 0, {
    consoleErrors,
    pageExceptions,
  });
  result.ok = result.failures.length === 0;
} catch (reason) {
  result.failures.push(
    `未捕获异常：${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`,
  );
  result.ok = false;
} finally {
  result.finishedAt = new Date().toISOString();
  result.consoleErrors = consoleErrors;
  result.pageExceptions = pageExceptions;
  fs.writeFileSync(
    path.join(EVIDENCE, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  try {
    chrome.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  server.close();
}

console.log(
  JSON.stringify(
    {
      ok: result.ok,
      failures: result.failures,
      checks: result.checks.length,
      consoleErrors: result.consoleErrors,
      pageExceptions: result.pageExceptions,
    },
    null,
    2,
  ),
);
if (!result.ok) process.exitCode = 1;
// CDP WebSocket 与 Chrome 子进程会阻止 Node 退出；显式收尾。
try {
  socket.close();
} catch {
  /* ignore */
}
try {
  chrome.kill('SIGKILL');
} catch {
  /* ignore */
}
server.close();
process.exit(result.ok ? 0 : 1);
