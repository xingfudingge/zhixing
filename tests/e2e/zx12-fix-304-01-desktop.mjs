/**
 * ZX12-FIX-304-01 桌面验收 harness。
 *
 * 真实 Tauri 2 二进制 + WKWebView + Rust `http_fetch_text`；本地静态服务只
 * 提供 app/dist 与探针注入，不替换产品 IPC、不伪造节假日源响应。
 *
 * 运行：
 *   pnpm --filter app build
 *   ~/.cargo/bin/cargo build --manifest-path app/src-tauri/Cargo.toml
 *   node tests/e2e/zx12-fix-304-01-desktop.mjs
 *
 * 证据：tests/evidence/zx12-fix-304-01/desktop.json
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
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx12-fix-304-01');
const HOME = '/tmp/zx12-fix-304-01-home';
const PORT = 5173;
const PROBE = fs.readFileSync(
  path.join(__dirname, 'zx12-fix-304-01/probe-main.js'),
  'utf8',
);

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
if (!fs.existsSync(BIN)) {
  throw new Error(`桌面二进制不存在：${BIN}`);
}
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

function indexWithProbe() {
  return fs
    .readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .replace('</body>', '<script src="/__zx12_fix_304_probe.js"></script></body>');
}

let resolveResult = null;
let resultPromise = new Promise((resolve) => {
  resolveResult = resolve;
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  if (request.method === 'POST' && pathname === '/__result') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolveResult?.(JSON.parse(body));
      } catch {
        resolveResult?.({ ok: false, failures: ['探针结果不是 JSON'] });
      }
      response.writeHead(204);
      response.end();
    });
    return;
  }

  if (pathname === '/__zx12_fix_304_probe.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(PROBE);
    return;
  }

  // 受控自定义源：验证坏包/超时/断网时产品保留上次成功缓存。
  if (pathname === '/holiday/ok.json') {
    const body = JSON.stringify({
      year: 2026,
      papers: [],
      days: [
        { name: '元旦', date: '2026-01-01', isOffDay: true },
        { name: '元旦', date: '2026-01-02', isOffDay: true },
        { name: '元旦', date: '2026-01-03', isOffDay: true },
        { name: '国庆节', date: '2026-10-01', isOffDay: true },
        { name: '国庆节', date: '2026-10-02', isOffDay: true },
      ],
    });
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      ETag: '"zx12-custom-v1"',
      'Cache-Control': 'no-store',
    });
    response.end(body);
    return;
  }
  if (pathname === '/holiday/bad.json') {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end('{not json');
    return;
  }
  if (pathname === '/holiday/slow.json') {
    // 永远不完成响应：触发 Rust 代理/前端超时。
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.write('{');
    setTimeout(() => response.socket?.destroy(), 45_000).unref();
    return;
  }
  if (pathname === '/holiday/offline.json') {
    request.socket.destroy();
    return;
  }

  let file = path.join(DIST, pathname);
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

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

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

const timedOut = new Promise((resolve) =>
  setTimeout(
    () => resolve({ ok: false, failures: ['桌面探针超时（240s）'] }),
    240_000,
  ),
);
const result = await Promise.race([resultPromise, timedOut]);

try {
  app.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (app.exitCode === null) app.kill('SIGKILL');
} catch {
  /* ignore */
}

server.close();

const evidence = {
  phase: 'main',
  startedAt: result.startedAt ?? null,
  finishedAt: result.finishedAt ?? null,
  ok: result.ok === true,
  failures: result.failures ?? [],
  checks: result.checks ?? [],
  steps: result.steps ?? [],
  consoleErrors: result.consoleErrors ?? [],
  pageExceptions: result.pageExceptions ?? [],
  cspViolations: result.cspViolations ?? [],
  proxyLog: result.proxyLog ?? [],
  ipcLog: result.ipcLog ?? [],
  fetchLog: result.fetchLog ?? [],
  appLog: appLog.slice(-80),
};
fs.writeFileSync(
  path.join(EVIDENCE, 'desktop.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
);

for (const item of evidence.checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
}
for (const failure of evidence.failures) {
  console.error(`FAILURE ${failure}`);
}
console.log(
  `\n${evidence.checks.filter((item) => item.ok).length}/${evidence.checks.length} checks passed`,
);
console.log(`evidence: ${path.relative(ROOT, path.join(EVIDENCE, 'desktop.json'))}`);
process.exit(evidence.ok ? 0 : 1);
