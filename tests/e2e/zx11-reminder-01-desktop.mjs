/**
 * ZX11-TASK-REMINDER-01 真实桌面验收：默认提醒写入新任务并进入调度器。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`（真实 WKWebView + SQLite）；
 *   * 本地静态服务只注入只读探针，不替换产品 IPC、不注入假数据源；
 *   * 探针通过真实 DOM 操作设置页与新建任务弹层，再用真实 IPC 校验 SQLite；
 *   * 校验顺序：默认关闭 → 新建任务无提醒 → 设置“提前 15 分钟” →
 *     新任务写入 15m → 旧任务仍为空 → 通知计划已由现有 scheduler 生成。
 *
 * 运行：
 *   pnpm --filter app build
 *   cargo build --manifest-path app/src-tauri/Cargo.toml
 *   node tests/e2e/zx11-reminder-01-desktop.mjs
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
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx11-reminder-01');
const HOME = '/tmp/zx11-reminder-01-home';
const PORT = 5173;

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
if (!fs.existsSync(BIN)) {
  throw new Error(`桌面二进制不存在：${BIN}`);
}
fs.mkdirSync(EVIDENCE, { recursive: true });
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
};

function indexWithProbe() {
  return fs
    .readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .replace('</body>', '<script src="/__zx11_probe.js"></script></body>');
}

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
          resolveResult({ ok: false, failures: ['探针结果不是 JSON'] });
        }
      }
      response.writeHead(204);
      response.end();
    });
    return;
  }
  if (url.pathname === '/__zx11_probe.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(fs.readFileSync(path.join(__dirname, 'zx11-reminder-01/probe.js')));
    return;
  }
  let file = path.join(
    DIST,
    url.pathname === '/' ? 'index.html' : url.pathname,
  );
  if (
    !file.startsWith(DIST) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  ) {
    file = path.join(DIST, 'index.html');
  }
  const body = file.endsWith('index.html')
    ? indexWithProbe()
    : fs.readFileSync(file);
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

const appLog = [];
const app = spawn(BIN, [], {
  cwd: HOME,
  env: {
    ...process.env,
    HOME,
    ZHIXING_LICENSE_STORE: 'file',
    ZHIXING_LICENSE_FILE: path.join(HOME, 'license.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', (chunk) => appLog.push(String(chunk)));
app.stderr.on('data', (chunk) => appLog.push(String(chunk)));
const exited = new Promise((resolve) => app.on('exit', resolve));

const timeout = new Promise((resolve) =>
  setTimeout(() => resolve({ ok: false, failures: ['探针 60s 内未返回'] }), 60_000),
);
const result = await Promise.race([resultPromise, timeout]);

const evidence = {
  task: 'ZX11-TASK-REMINDER-01',
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  appLog: appLog.join(''),
  ...result,
};
fs.writeFileSync(
  path.join(EVIDENCE, 'result.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
);

try {
  app.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (app.exitCode === null) app.kill('SIGKILL');
} catch {
  /* ignore */
}
server.close();

console.log(JSON.stringify(evidence, null, 2));
if (!evidence.ok) {
  process.exitCode = 1;
}
