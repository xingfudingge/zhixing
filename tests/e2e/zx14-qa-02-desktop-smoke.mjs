/**
 * ZX14-QA-02 无授权模块最终复验 · 真实桌面启动冒烟。
 *
 * 只做启动级验证，不伪造/替换产品 IPC：
 *   * 启动真实 app/src-tauri/target/debug/zhixing；
 *   * 本地静态服务托管 app/dist 并注入只读探针；
 *   * 断言：进入 /today、可见文案无「许可/试用/激活/安装 ID」、无许可胶囊、
 *     设置页 8 个分组齐全；控制台无 error。
 *
 * 运行：pnpm --filter app build && node tests/e2e/zx14-qa-02-desktop-smoke.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const BIN = path.join(ROOT, 'app/src-tauri/target/debug/zhixing');
const HOME = '/tmp/zx14-qa-02-home';
const PORT = 5173;
const LICENSE_WORDS = ['许可', '试用状态', '安装 ID', '激活码', 'license', 'License'];

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
if (!fs.existsSync(BIN)) {
  throw new Error(`桌面二进制不存在：${BIN}`);
}

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const errs = [];
  window.addEventListener('error', (e) => errs.push('window.error:' + e.message));
  window.addEventListener('unhandledrejection', (e) => errs.push('unhandledrejection:' + String(e.reason)));
  const waitFor = async (fn, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await sleep(100); }
    return false;
  };
  const post = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  try {
    await waitFor(() => document.body.innerText.includes('今天') && document.querySelector('h1'), 25000);
    const result = { isTauri: '__TAURI_INTERNALS__' in window, path: location.pathname };
    const body = document.body.innerText;
    result.hasTodayHeading = !!Array.from(document.querySelectorAll('h1')).find((h) => h.textContent.trim() === '今天');
    result.licenseWordHits = ${JSON.stringify(LICENSE_WORDS)}.filter((w) => body.includes(w));
    result.licenseDomNodes = document.querySelectorAll('[class*="license"],[class*="trial"],[data-license],[data-trial]').length;
    result.startupConsoleErrors = errs.slice();

    const settingsLink = document.querySelector('a[href="/settings/appearance"]');
    if (settingsLink) {
      settingsLink.click();
      await waitFor(() => location.pathname.startsWith('/settings'), 10000);
      await sleep(800);
    }
    result.settingsPath = location.pathname;
    const sbody = document.body.innerText;
    result.settingsLicenseWordHits = ${JSON.stringify(LICENSE_WORDS)}.filter((w) => sbody.includes(w));
    const nav = document.querySelector('.settings-nav');
    result.settingsGroups = nav
      ? Array.from(nav.querySelectorAll('a,button'))
          .map((b) => b.getAttribute('aria-label') || b.textContent.trim())
          .filter(Boolean)
      : [];
    await post('/__result', result);
  } catch (e) {
    await post('/__result', { error: String((e && e.stack) || e) });
  }
})();`;

const indexWithProbe = () =>
  fs
    .readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .replace('</body>', '<script src="/__zx_qa02_probe.js"></script></body>');

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

let resolveResult;
const resultPromise = new Promise((resolve) => {
  resolveResult = resolve;
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (url.pathname === '/__result') {
        try {
          resolveResult(JSON.parse(body));
        } catch {
          resolveResult({ error: 'bad result json' });
        }
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    return;
  }
  if (url.pathname === '/__zx_qa02_probe.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(PROBE);
    return;
  }
  let file = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html');
  }
  const body = file.endsWith('index.html') ? indexWithProbe() : fs.readFileSync(file);
  response.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  response.end(body);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', resolve);
});

const app = spawn(BIN, [], {
  cwd: HOME,
  env: { ...process.env, HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appLog = '';
app.stdout.on('data', (chunk) => {
  appLog += String(chunk);
});
app.stderr.on('data', (chunk) => {
  appLog += String(chunk);
});

const timeout = new Promise((resolve) =>
  setTimeout(() => resolve({ error: 'probe timeout', appLog: appLog.slice(-2000) }), 60_000),
);

let result;
try {
  result = await Promise.race([resultPromise, timeout]);
} finally {
  app.kill('SIGTERM');
  await sleep(500);
  if (app.exitCode === null) app.kill('SIGKILL');
  server.close();
}

const failures = [];
if (result.error) failures.push(`探针错误：${result.error}`);
if (result.isTauri !== true) failures.push('不是真实 Tauri WebView');
if (result.path !== '/today') failures.push(`未进入 /today（${result.path}）`);
if (result.hasTodayHeading !== true) failures.push('缺少「今天」一级标题');
if ((result.licenseWordHits ?? ['?']).length) failures.push(`今天页出现许可字样：${result.licenseWordHits.join(',')}`);
if (result.licenseDomNodes) failures.push(`存在许可/试用 DOM 节点：${result.licenseDomNodes}`);
if ((result.startupConsoleErrors ?? []).length) failures.push(`启动控制台错误：${result.startupConsoleErrors.join(' | ')}`);
if (result.settingsPath !== '/settings/appearance') failures.push(`设置未落到外观页（${result.settingsPath}）`);
if ((result.settingsGroups ?? []).length !== 8) failures.push(`设置分组不是 8 个：${JSON.stringify(result.settingsGroups)}`);
if ((result.settingsLicenseWordHits ?? ['?']).length) failures.push(`设置页出现许可字样：${result.settingsLicenseWordHits.join(',')}`);

console.log(JSON.stringify({ ok: failures.length === 0, failures, result, appLogTail: appLog.slice(-1000) }, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
