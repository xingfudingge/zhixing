/**
 * ZX14-QA-01 无授权模块独立验收（真实 macOS 桌面）。
 *
 * 不修改产品代码；用全新 HOME、不设置任何 ZHIXING_LICENSE_* 环境变量启动
 * 真实 Tauri 2 二进制 + WKWebView + SQLite，验证：
 *   1. 直接进入主界面，无激活/试用/许可页；
 *   2. 顶栏无“试用/已授权/未授权”，设置无“许可与设备”；
 *   3. 5 个授权 IPC 命令均不存在；
 *   4. /settings/license 回落到外观分组；
 *   5. 真实截图 + 控制台错误。
 *
 * 运行：
 *   pnpm --filter app build
 *   cargo build --manifest-path app/src-tauri/Cargo.toml
 *   node tests/e2e/zx14-qa-01-license-removal-desktop.mjs
 * 证据：tests/evidence/zx14-qa-01/
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const BIN = path.join(ROOT, 'app/src-tauri/target/debug/zhixing');
const PROBE = path.join(__dirname, 'zx14-qa-01-license-removal/desktop-probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx14-qa-01');
const HOME = '/tmp/zx14-qa-01-home';
const PORT = 5173;

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
if (!fs.existsSync(BIN)) {
  throw new Error(`桌面二进制不存在：${BIN}`);
}
fs.rmSync(EVIDENCE, { recursive: true, force: true });
fs.mkdirSync(EVIDENCE, { recursive: true });

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

const probeSource = fs.readFileSync(PROBE, 'utf8');
const indexWithProbe = () =>
  fs
    .readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .replace('</body>', '<script src="/__zx14_probe.js"></script></body>');

let resolveResult;
const resultPromise = new Promise((resolve) => {
  resolveResult = resolve;
});
let resolveReady;
const readyPromise = new Promise((resolve) => {
  resolveReady = resolve;
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (request.method === 'POST' && url.pathname === '/__zx14_ready') {
    resolveReady(true);
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === 'POST' && url.pathname === '/__zx14_result') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolveResult(JSON.parse(body));
      } catch (error) {
        resolveResult({ ok: false, error: `结果解析失败：${error}` });
      }
      response.writeHead(204);
      response.end();
    });
    return;
  }
  if (url.pathname === '/__zx14_probe.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(
      probeSource
        .replaceAll('/__result', '/__zx14_result')
        .replaceAll('/__ready', '/__zx14_ready'),
    );
    return;
  }
  let file = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
  if (
    !file.startsWith(DIST) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  ) {
    file = path.join(DIST, 'index.html');
  }
  const ext = path.extname(file);
  response.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  response.end(file.endsWith('index.html') ? indexWithProbe() : fs.readFileSync(file));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', resolve);
});

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

const appLog = [];
const env = { ...process.env, HOME };
delete env.ZHIXING_LICENSE_STORE;
delete env.ZHIXING_LICENSE_FILE;

const app = spawn(BIN, [], {
  cwd: HOME,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', (chunk) => appLog.push(String(chunk)));
app.stderr.on('data', (chunk) => appLog.push(String(chunk)));
const exited = new Promise((resolve) => app.on('exit', resolve));

function captureWindow(name, pid) {
  try {
    execFileSync(
      'osascript',
      ['-e', `tell application "System Events" to set frontmost of (first application process whose unix id is ${pid}) to true`],
      { stdio: 'pipe', timeout: 10_000 },
    );
  } catch {
    // 无辅助访问权限时不阻断证据采集。
  }
  const target = path.join(EVIDENCE, name);
  let bounds = null;
  try {
    bounds = execFileSync(
      'osascript',
      [
        '-e',
        `tell application "System Events" to tell (first application process whose unix id is ${pid}) to get {position of window 1, size of window 1}`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    ).trim();
  } catch {
    // 本机未授予 osascript 辅助访问时退化为整屏截图，证据仍然真实。
  }
  const [x, y, width, height] = (bounds ?? '').split(', ').map(Number);
  if ([x, y, width, height].every(Number.isFinite) && width > 200 && height > 200) {
    execFileSync(
      'screencapture',
      ['-x', `-R${x},${y},${width},${height}`, target],
      { timeout: 10_000 },
    );
    return { file: target, mode: 'window', bounds };
  }
  execFileSync('screencapture', ['-x', target], { timeout: 10_000 });
  return { file: target, mode: 'screen', bounds: null };
}

const ready = await Promise.race([
  readyPromise,
  new Promise((resolve) => setTimeout(() => resolve(false), 60_000)),
]);
const captureMain = ready
  ? captureWindow('desktop-main.png', app.pid)
  : { file: null, mode: 'not-ready' };

const payload = await Promise.race([
  resultPromise,
  new Promise((resolve) =>
    setTimeout(() => resolve({ ok: false, error: '探针 90s 内未返回' }), 90_000),
  ),
]);

const captureSettings = captureWindow('desktop-settings-license-fallback.png', app.pid);

try {
  app.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (app.exitCode === null) app.kill('SIGKILL');
} catch {
  /* ignore */
}

// 独立核对二进制中不再包含授权命令符号。
const nm = spawnSync('nm', ['-gU', BIN], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const nmText = `${nm.stdout ?? ''}\n${nm.stderr ?? ''}`;
const binaryLicenseSymbols = [
  'get_license_state',
  'get_install_id',
  'activate_license',
  'start_trial',
  'deactivate_license',
].filter((symbol) => nmText.includes(symbol));

const checks = [];
const failures = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`[zx14] ${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail).slice(0, 1200)}`}`);
  if (!ok) failures.push(`${name}：${JSON.stringify(detail)}`);
}

const result = payload.result ?? null;
check('探针返回', payload.ok === true, payload.error ?? payload.partial);
if (result) {
  check('真实 Tauri IPC 可用', result.isTauri === true, result.isTauri);
  check('启动直接进入主界面 /today', result.route === '/today', result.route);
  check('顶栏无试用/已授权/未授权/许可', !/试用|已授权|未授权|许可|License/i.test(result.topbarText ?? ''), result.topbarText);
  check('页面无激活/试用/许可文案', result.forbidden.bodyHits.length === 0, result.forbidden.bodyHits);
  check('页面无授权控件属性', result.forbidden.attrHits.length === 0, result.forbidden.attrHits);
  check('导航无 /settings/license', !result.navLinks.some((link) => link.href === '/settings/license'), result.navLinks);
  check('设置分组为 8 个且无许可与设备', result.settingsGroups.length === 8 && !result.settingsGroups.some((g) => /许可|license/i.test(`${g.href}${g.text}`)), result.settingsGroups);
  check('/settings/license 回落到 /settings/appearance', result.settingsLicenseRoute?.path === '/settings/appearance' && result.settingsLicenseRoute?.bodyHasLicense === false, result.settingsLicenseRoute);
  check('5 个授权 IPC 命令均不存在', result.ipc.length === 5 && result.ipc.every((item) => item.ok === false), result.ipc);
  check('控制台零错误', result.consoleErrors.length === 0, result.consoleErrors);
}
check('二进制无授权命令符号', binaryLicenseSymbols.length === 0, binaryLicenseSymbols);

const summary = {
  task: 'ZX14-QA-01',
  kind: 'macos-desktop-license-removal',
  head: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
  startedAt: new Date().toISOString(),
  home: HOME,
  checks,
  failures,
  payload,
  captures: { main: captureMain, settings: captureSettings },
  binaryLicenseSymbols,
  appLog: appLog.join(''),
};
fs.writeFileSync(path.join(EVIDENCE, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

server.close();
console.log(`[zx14] ${failures.length === 0 ? 'ALL PASS' : `${failures.length} FAIL`}`);
if (failures.length > 0) process.exitCode = 1;
