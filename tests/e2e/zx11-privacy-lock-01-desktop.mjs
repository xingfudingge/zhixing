/**
 * ZX11-PRIVACY-LOCK-01 真实 macOS 桌面验收。
 *
 * 运行：
 *   pnpm --filter app build
 *   cargo build --manifest-path app/src-tauri/Cargo.toml
 *   node tests/e2e/zx11-privacy-lock-01-desktop.mjs
 *
 * 覆盖：
 *   - 真实 WKWebView + SQLite 桌面壳；
 *   - 设置页开启失焦遮挡 / 剪贴板 15 秒，并校验 localStorage 镜像；
 *   - 用 Finder 夺焦触发真实 macOS 失焦，遮挡层覆盖窗口；
 *   - 回焦不自动揭开，点击「显示内容」才恢复；
 *   - 官方 clipboard-manager 读/清真实系统剪贴板；
 *   - 用户后来复制的内容不被误清。
 *
 * 证据：tests/evidence/zx11-privacy-lock-01/
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const BIN = path.join(ROOT, 'app/src-tauri/target/debug/zhixing');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx11-privacy-lock-01');
const HOME = '/tmp/zx11-privacy-lock-01-home';
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
  '.ttf': 'font/ttf',
  '.png': 'image/png',
};

function indexWithProbe() {
  return fs
    .readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .replace('</body>', '<script src="/__zx11_privacy_probe.js"></script></body>');
}

let resolveReady;
const readyPromise = new Promise((resolve) => {
  resolveReady = resolve;
});
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
      if (url.pathname === '/__ready') {
        resolveReady({ ok: true });
      } else if (url.pathname === '/__result') {
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
  if (url.pathname === '/__zx11_privacy_probe.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(
      fs.readFileSync(path.join(__dirname, 'zx11-privacy-lock-01/probe.js')),
    );
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

let appActivationError = null;
let blurScreenshot = false;
let revealScreenshot = false;
let frontmostAfterBlur = null;
let frontmostAfterActivation = null;

const runOsa = (script) => {
  try {
    execFileSync('osascript', ['-e', script], {
      stdio: 'pipe',
      timeout: 10_000,
    });
    return null;
  } catch (reason) {
    return reason instanceof Error ? reason.message : String(reason);
  }
};

const osaOutput = (script) => {
  try {
    return execFileSync('osascript', ['-e', script], {
      stdio: 'pipe',
      timeout: 10_000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

const ready = await Promise.race([
  readyPromise,
  new Promise((resolve) =>
    setTimeout(() => resolve({ ok: false, timeout: true }), 60_000),
  ),
]);

if (ready.timeout) {
  appLog.push('\n[harness] 探针 60s 内未 ready\n');
} else {
  // 真实失焦：把 Finder 激活到前台。
  runOsa('tell application "Finder" to activate');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  frontmostAfterBlur = osaOutput(
    'tell application "System Events" to get unix id of first application process whose frontmost is true',
  );
  try {
    execFileSync('screencapture', ['-x', path.join(EVIDENCE, 'macos-blur.png')], {
      timeout: 10_000,
    });
    blurScreenshot = true;
  } catch (reason) {
    appLog.push(`\n[harness] 失焦截图失败：${String(reason)}\n`);
  }

  // 回焦必须精确到本次测试的 pid；机器上可能还有一个同名的已安装版本。
  appActivationError = runOsa(
    `tell application "System Events" to set frontmost of (first application process whose unix id is ${app.pid}) to true`,
  );
  if (appActivationError) {
    appLog.push(`\n[harness] 回焦失败：${appActivationError}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  frontmostAfterActivation = osaOutput(
    'tell application "System Events" to get unix id of first application process whose frontmost is true',
  );
  if (String(frontmostAfterActivation) !== String(app.pid)) {
    appLog.push(
      `\n[harness] 回焦后前台 pid=${String(
        frontmostAfterActivation,
      )}，期望 ${String(app.pid)}\n`,
    );
  }
}

const result = await Promise.race([
  resultPromise,
  new Promise((resolve) =>
    setTimeout(
      () => resolve({ ok: false, failures: ['探针 120s 内未返回'] }),
      120_000,
    ),
  ),
]);

try {
  execFileSync(
    'screencapture',
    ['-x', path.join(EVIDENCE, 'macos-revealed.png')],
    { timeout: 10_000 },
  );
  revealScreenshot = true;
} catch (reason) {
  appLog.push(`\n[harness] 恢复截图失败：${String(reason)}\n`);
}

const evidence = {
  task: 'ZX11-PRIVACY-LOCK-01',
  platform: process.platform,
  arch: process.arch,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  ready,
  appPid: app.pid,
  frontmostAfterBlur,
  frontmostAfterActivation,
  appActivationError,
  blurScreenshot,
  revealScreenshot,
  appLog: appLog.join(''),
  ...result,
};
fs.writeFileSync(
  path.join(EVIDENCE, 'result.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
);

try {
  app.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (app.exitCode === null) app.kill('SIGKILL');
} finally {
  server.close();
}

console.log(JSON.stringify(evidence, null, 2));
if (!evidence.ok) {
  process.exitCode = 1;
}
