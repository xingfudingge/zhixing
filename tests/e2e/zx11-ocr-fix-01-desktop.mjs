/**
 * ZX11-FIX-OCR-01 桌面探针。
 *
 * 真实 Tauri 2 + WKWebView + SQLite + macOS Apple Vision。只通过真实 DOM
 * 操作和真实 IPC 验证：
 *   - 识别范围 folder 的目录选择、无目录禁用与 localStorage 持久化；
 *   - 设置页“处理队列”使用真实附件原图，作业从待处理变为已完成；
 *   - textStorage=sync 进入真实同步消费方；仅本机模式下明确失败而不是伪报；
 *   - 重启后 OCR 设置（范围/目录/文本保存位置）保持。
 *
 * 运行：
 *   pnpm --filter app build
 *   cargo build --manifest-path app/src-tauri/Cargo.toml
 *   node tests/e2e/zx11-ocr-fix-01-desktop.mjs
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
const FIXTURES = path.join(ROOT, 'tests/evidence/zx11-qa-01/fixtures');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx11-ocr-fix-01');
const HOME = '/tmp/zx11-ocr-fix-01-home';
const PORT = Number(process.env.ZX11_OCR_PORT ?? 5173);

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
if (!fs.existsSync(BIN)) {
  throw new Error(`桌面二进制不存在：${BIN}`);
}
fs.mkdirSync(EVIDENCE, { recursive: true });
for (const name of fs.readdirSync(EVIDENCE)) {
  if (/\.(json|log|txt)$/.test(name)) fs.rmSync(path.join(EVIDENCE, name));
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

let currentProbe = '';
let resolveResult = null;
let resultPromise = null;
function resetResult() {
  resultPromise = new Promise((resolve) => {
    resolveResult = resolve;
  });
}

function indexWithProbe() {
  return fs
    .readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .replace('</body>', '<script src="/__ocr_probe.js"></script></body>');
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);
  if (request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (url.pathname === '/__result') {
        try {
          resolveResult?.(JSON.parse(body));
        } catch {
          resolveResult?.({ ok: false, failures: ['探针结果不是 JSON'] });
        }
      }
      response.writeHead(204);
      response.end();
    });
    return;
  }
  if (pathname === '/__ocr_probe.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(currentProbe);
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
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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

function resetHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
}

async function runPhase({ name, probe, timeoutMs, fresh }) {
  if (fresh) resetHome();
  else fs.mkdirSync(HOME, { recursive: true });
  currentProbe = fs.readFileSync(
    path.join(__dirname, 'zx11-ocr-fix-01', probe),
    'utf8',
  );
  resetResult();
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
      () => resolve({ ok: false, failures: [`${name} 探针超时`] }),
      timeoutMs,
    ),
  );
  const result = await Promise.race([resultPromise, timedOut]);
  try {
    app.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (app.exitCode === null) app.kill('SIGKILL');
  } catch {
    /* ignore */
  }

  const evidence = {
    phase: name,
    startedAt: new Date().toISOString(),
    home: HOME,
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
  task: 'ZX11-FIX-OCR-01',
  kind: 'macos-desktop',
  startedAt: new Date().toISOString(),
  head: fs.readFileSync(
    path.join(ROOT, 'tests/evidence/zx11-qa-01/head.txt'),
    'utf8',
  ),
  phases: {},
};

try {
  summary.phases.main = await runPhase({
    name: 'main',
    probe: 'probe-main.js',
    timeoutMs: 240_000,
    fresh: true,
  });
  summary.phases.restart = await runPhase({
    name: 'restart',
    probe: 'probe-restart.js',
    timeoutMs: 120_000,
    fresh: false,
  });
} catch (reason) {
  summary.failures = [
    `未捕获异常：${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`,
  ];
}

const phaseFailures = Object.entries(summary.phases).flatMap(([name, phase]) =>
  (phase.failures ?? []).map((failure) => `${name}: ${failure}`),
);
summary.failures = [...(summary.failures ?? []), ...phaseFailures];
summary.ok = summary.failures.length === 0;
summary.finishedAt = new Date().toISOString();

fs.writeFileSync(
  path.join(EVIDENCE, 'result.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
server.close();

console.log(
  JSON.stringify(
    {
      ok: summary.ok,
      failures: summary.failures,
      phases: Object.fromEntries(
        Object.entries(summary.phases).map(([name, phase]) => [
          name,
          {
            ok: phase.ok,
            checks: phase.checks?.length ?? 0,
            failures: phase.failures?.length ?? 0,
          },
        ]),
      ),
    },
    null,
    2,
  ),
);
process.exit(summary.ok ? 0 : 1);
