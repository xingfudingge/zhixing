/**
 * ZX11-QA-01 独立 macOS 桌面验收。
 *
 * 真实 Tauri 2 + WKWebView + SQLite + macOS Apple Vision。启动的是当前源码
 * 构建的 debug 二进制；本地静态服务只注入“只读探针”，不替换产品 IPC、不
 * 注入假数据源。探针通过真实 DOM 与真实 IPC 验证：
 *   - 设置 9 分组、任务默认提醒/完成后行为/撤销/批量/权限失败；
 *   - 日历周起始/工作日/节假日源/个人例外/跨年/同步失败；
 *   - OCR Apple Vision probe + 真实图片识别 + 空图/坏图/语言错误；
 *   - 隐私诊断默认关闭、删除不存在项、空数据、控制台零报错；
 *   - 重启后设置持久化；
 *   - 加密笔记锁定后不可读、错误口令具体报错、DB/信封无明文（单独 HOME）。
 *
 * 运行：
 *   pnpm --filter app build
 *   cargo build --manifest-path app/src-tauri/Cargo.toml
 *   node tests/e2e/zx11-qa-01-desktop.mjs
 *
 * 证据：tests/evidence/zx11-qa-01/desktop/
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
const EVIDENCE = process.env.ZX11_EVIDENCE_DIR
  ? path.resolve(ROOT, process.env.ZX11_EVIDENCE_DIR)
  : path.join(ROOT, 'tests/evidence/zx11-qa-01/desktop');
const FIXTURES = path.join(ROOT, 'tests/evidence/zx11-qa-01/fixtures');
const HOME_MAIN = '/tmp/zx11-qa-01-main-home';
const HOME_ENC = '/tmp/zx11-qa-01-enc-home';
const PORT = 5173;
// 可选：只跑部分阶段，便于加密修复单独复跑且不覆盖其它证据。
// 例：ZX11_PHASES=encryption,restart-enc node tests/e2e/zx11-qa-01-desktop.mjs
const PHASE_FILTER = (process.env.ZX11_PHASES ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const wants = (name) => PHASE_FILTER.length === 0 || PHASE_FILTER.includes(name);

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
if (!fs.existsSync(BIN)) {
  throw new Error(`桌面二进制不存在：${BIN}`);
}
fs.mkdirSync(EVIDENCE, { recursive: true });
if (PHASE_FILTER.length === 0) {
  for (const name of fs.readdirSync(EVIDENCE)) {
    if (/\.(json|log|txt|png)$/.test(name)) fs.rmSync(path.join(EVIDENCE, name));
  }
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
    .replace('</body>', '<script src="/__zx11_probe.js"></script></body>');
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
  if (pathname === '/__zx11_probe.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(currentProbe);
    return;
  }
  if (pathname.startsWith('/__holiday/')) {
    const fixture = HOLIDAYS[pathname];
    if (fixture) {
      response.writeHead(200, {
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
    path.join(__dirname, 'zx11-qa-01-desktop', probe),
    'utf8',
  );
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
    setTimeout(() => resolve({ ok: false, failures: [`${name} 探针超时`] }), timeoutMs),
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
    home,
    appLog: appLog.join(''),
    ...result,
  };
  fs.writeFileSync(
    path.join(EVIDENCE, `${name}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  return evidence;
}

function collectFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) collectFiles(full, out);
    else out.push(full);
  }
  return out;
}

function scanPlaintext(home, needles) {
  const dataDir = path.join(
    home,
    'Library/Application Support/com.zhixing.desktop',
  );
  const findings = [];
  for (const file of collectFiles(dataDir)) {
    if (/\.(db|db-wal|db-shm|json|log)$/.test(file) || !path.extname(file)) {
      let buffer;
      try {
        buffer = fs.readFileSync(file);
      } catch {
        continue;
      }
      const text = buffer.toString('utf8');
      for (const needle of needles) {
        if (text.includes(needle)) {
          findings.push({ file: path.relative(home, file), needle });
        }
      }
    }
  }
  return findings;
}

const summary = {
  task: 'ZX11-QA-01',
  kind: 'macos-desktop',
  startedAt: new Date().toISOString(),
  head: fs.readFileSync(path.join(ROOT, 'tests/evidence/zx11-qa-01/head.txt'), 'utf8'),
  phases: {},
  plaintextFindings: [],
};

try {
  if (wants('main')) {
    summary.phases.main = await runPhase({
      name: 'main',
      home: HOME_MAIN,
      probe: 'probe-main.js',
      timeoutMs: 240_000,
      fresh: true,
    });
  }
  if (wants('restart')) {
    summary.phases.restart = await runPhase({
      name: 'restart',
      home: HOME_MAIN,
      probe: 'probe-restart.js',
      timeoutMs: 120_000,
      fresh: false,
    });
  }
  if (wants('encryption')) {
    summary.phases.encryption = await runPhase({
      name: 'encryption',
      home: HOME_ENC,
      probe: process.env.ZX11_ENCRYPTION_PROBE ?? 'probe-encryption.js',
      timeoutMs: 180_000,
      fresh: true,
    });
  }
  if (wants('restart-enc')) {
    summary.phases['restart-enc'] = await runPhase({
      name: 'restart-enc',
      home: HOME_ENC,
      probe: 'probe-encryption-restart.js',
      timeoutMs: 120_000,
      fresh: false,
    });
  }
  // 清理本测试写入的钥匙串条目（运行前已确认不存在同名 account）。
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync(
      'security',
      [
        'delete-generic-password',
        '-s',
        'com.zhixing.desktop',
        '-a',
        'note-encryption-v1',
      ],
      { stdio: 'ignore' },
    );
    summary.keychainCleanup = 'deleted';
  } catch {
    summary.keychainCleanup = 'not-found-or-denied';
  }
  summary.plaintextFindings = scanPlaintext(HOME_ENC, [
    'ZX11-PLAINTEXT-SENTINEL-9f3a',
  ]);
  summary.plaintextScan = {
    home: HOME_ENC,
    dataDir: path.join(
      HOME_ENC,
      'Library/Application Support/com.zhixing.desktop',
    ),
    files: collectFiles(
      path.join(HOME_ENC, 'Library/Application Support/com.zhixing.desktop'),
    ).map((file) => path.relative(HOME_ENC, file)),
  };
  const encryptionDataDir = path.join(
    HOME_ENC,
    'Library/Application Support/com.zhixing.desktop',
  );
  summary.fileModes = {
    dataDir: fs.existsSync(encryptionDataDir)
      ? (fs.statSync(encryptionDataDir).mode & 0o777).toString(8)
      : null,
    files: collectFiles(encryptionDataDir).map((file) => ({
      file: path.relative(HOME_ENC, file),
      mode: (fs.statSync(file).mode & 0o777).toString(8),
      size: fs.statSync(file).size,
    })),
  };
} catch (reason) {
  summary.failures = [
    `未捕获异常：${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`,
  ];
  summary.ok = false;
}

summary.finishedAt = new Date().toISOString();
const phaseFailures = Object.entries(summary.phases).flatMap(([name, phase]) =>
  (phase.failures ?? []).map((failure) => `${name}: ${failure}`),
);
summary.failures = [...(summary.failures ?? []), ...phaseFailures];
if (summary.plaintextFindings.length > 0) {
  summary.failures.push(
    `加密后磁盘仍含明文：${JSON.stringify(summary.plaintextFindings)}`,
  );
}
summary.ok = summary.failures.length === 0;

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
            checks: phase.checks?.length ?? phase.steps?.length ?? 0,
            failures: phase.failures?.length ?? 0,
          },
        ]),
      ),
      plaintextFindings: summary.plaintextFindings,
    },
    null,
    2,
  ),
);
process.exit(summary.ok ? 0 : 1);
