/**
 * ZX12-QA-01 独立桌面验收 harness。
 *
 * 真实 Tauri 2 二进制 + WKWebView + SQLite + Rust HTTP 代理；本地静态服务只
 * 提供 app/dist 与可控 ICS 端点和探针注入，不替换产品 IPC，不伪造节假日源。
 *
 * 运行：
 *   pnpm --filter app build
 *   cargo build --manifest-path app/src-tauri/Cargo.toml
 *   node tests/e2e/zx12-qa-01-desktop.mjs
 *
 * 证据：tests/evidence/zx12-qa-01/desktop/
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
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx12-qa-01/desktop');
const HOME_MAIN = '/tmp/zx12-qa-01-main-home';
const PORT = 5173;

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
if (!fs.existsSync(BIN)) {
  throw new Error(`桌面二进制不存在：${BIN}`);
}
fs.mkdirSync(EVIDENCE, { recursive: true });
for (const name of fs.readdirSync(EVIDENCE)) {
  if (/\.(json|log|txt|png)$/.test(name)) fs.rmSync(path.join(EVIDENCE, name));
}

const icsOk = (stamp) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ZX12 QA//CN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:zx12-ok-1-${stamp}`,
    'DTSTART;VALUE=DATE:20261103',
    'DTEND;VALUE=DATE:20261104',
    'SUMMARY:验收外部会议A',
    'END:VEVENT',
    'BEGIN:VEVENT',
    `UID:zx12-ok-2-${stamp}`,
    'DTSTART;VALUE=DATE:20261104',
    'DTEND;VALUE=DATE:20261105',
    'SUMMARY:验收外部会议B',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

const icsSecond = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//ZX12 QA//CN',
  'BEGIN:VEVENT',
  'UID:zx12-second-1',
  'DTSTART;VALUE=DATE:20261105',
  'DTEND;VALUE=DATE:20261106',
  'SUMMARY:验收第二订阅',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

let currentProbe = '';
let resolveResult = null;
let resultPromise = null;
let icsFailureRoute = '';
const icsRequests = [];

function resetResult() {
  resultPromise = new Promise((resolve) => {
    resolveResult = resolve;
  });
}

function indexWithProbe() {
  return fs
    .readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .replace('</body>', '<script src="/__zx12_probe.js"></script></body>');
}

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

  if (pathname === '/__zx12_probe.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(currentProbe);
    return;
  }

  if (pathname === '/__ics_fail') {
    icsFailureRoute = url.searchParams.get('route') ?? '';
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    response.end(JSON.stringify({ icsFailureRoute }));
    return;
  }

  if (pathname === '/__ics_log') {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    response.end(JSON.stringify(icsRequests));
    return;
  }

  if (pathname.startsWith('/ics/')) {
    const requestedUrl = `${request.method} ${pathname}`;
    const failMode =
      icsFailureRoute !== '' && pathname.includes(icsFailureRoute);
    const logEntry = {
      at: new Date().toISOString(),
      url: requestedUrl,
      ifNoneMatch: request.headers['if-none-match'] ?? null,
      ifModifiedSince: request.headers['if-modified-since'] ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      failMode,
      status: null,
    };
    icsRequests.push(logEntry);
    response.on('finish', () => {
      logEntry.status = response.statusCode;
    });
    if (failMode) {
      logEntry.status = 500;
      response.writeHead(500, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end('zx12 injected upstream failure');
      return;
    }
    if (pathname === '/ics/ok.ics') {
      const etag = '"zx12-ok-v1"';
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304, {
          ETag: etag,
          'Cache-Control': 'no-store',
        });
        response.end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        ETag: etag,
        'Last-Modified': 'Sun, 01 Nov 2026 12:00:00 GMT',
        'Cache-Control': 'no-store',
      });
      response.end(icsOk('v1'));
      return;
    }
    if (pathname === '/ics/second.ics') {
      const etag = '"zx12-second-v1"';
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        ETag: etag,
        'Cache-Control': 'no-store',
      });
      response.end(icsSecond);
      return;
    }
    if (pathname === '/ics/bad.ics') {
      response.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end('this is not an ics file');
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
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

function rmHome(home) {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
}

async function runPhase({ name, home, probe, timeoutMs, fresh }) {
  if (fresh) rmHome(home);
  else fs.mkdirSync(home, { recursive: true });
  currentProbe = fs.readFileSync(
    path.join(__dirname, 'zx12-qa-01', probe),
    'utf8',
  );
  icsFailureRoute = '';
  icsRequests.length = 0;
  resetResult();
  const appLog = [];
  const app = spawn(BIN, [], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      ZHIXING_LICENSE_STORE: 'file',
      ZHIXING_LICENSE_FILE: path.join(home, 'license.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (chunk) => appLog.push(String(chunk)));
  app.stderr.on('data', (chunk) => appLog.push(String(chunk)));
  const exited = new Promise((resolve) => app.on('exit', resolve));

  const timedOut = new Promise((resolve) =>
    setTimeout(
      () => resolve({ ok: false, failures: [`${name} 探针超时`] }),
      timeoutMs,
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

  const evidence = {
    phase: name,
    startedAt: new Date().toISOString(),
    home,
    icsRequests: [...icsRequests],
    appLog: appLog.join(''),
    ...result,
  };
  fs.writeFileSync(
    path.join(EVIDENCE, `${name}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  return evidence;
}

const summary = {
  task: 'ZX12-QA-01',
  kind: 'macos-desktop',
  startedAt: new Date().toISOString(),
  head: fs.readFileSync(
    path.join(ROOT, 'tests/evidence/zx12-qa-01/head.txt'),
    'utf8',
  ),
  phases: {},
};
const ONLY = (process.env.ZX12_ONLY ?? '').trim();
const wants = (name) => !ONLY || ONLY === name;

try {
  if (wants('main')) {
    summary.phases.main = await runPhase({
      name: 'main',
      home: HOME_MAIN,
      probe: process.env.ZX12_MAIN_PROBE ?? 'probe-main.js',
      timeoutMs: 360_000,
      fresh: true,
    });
  }
  if (wants('restart')) {
    summary.phases.restart = await runPhase({
      name: 'restart',
      home: HOME_MAIN,
      probe: 'probe-restart.js',
      timeoutMs: 180_000,
      fresh: false,
    });
  }
} finally {
  server.close();
}

fs.writeFileSync(
  path.join(EVIDENCE, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);

for (const [name, phase] of Object.entries(summary.phases)) {
  const failures = phase.failures ?? [];
  console.log(
    `${name}: ${phase.ok ? 'PASS' : 'FAIL'} (${phase.checks?.length ?? 0} checks, ${failures.length} failures)`,
  );
  for (const failure of failures) console.log(`  - ${failure}`);
}
const failed = Object.values(summary.phases).some((phase) => !phase.ok);
process.exitCode = failed ? 1 : 0;
