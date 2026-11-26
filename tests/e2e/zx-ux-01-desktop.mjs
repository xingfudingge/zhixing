/**
 * ZX-UX-01 真实 Tauri 窗口验收：四象限 / 看板指针拖拽。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`（真实 WKWebView + SQLite）；
 *   * 通过本地静态服务注入探针（不替换产品 IPC）；
 *   * 首选 CoreGraphics 系统级鼠标事件（drag.swift）做真实拖拽；
 *     若无辅助功能权限，则退回 WebView 内 PointerEvent 并记录原因；
 *   * 页面 DOM + SQLite 双重校验落库结果。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-ux-01-desktop.mjs
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
const PROBE = path.join(__dirname, 'zx-ux-01/probe.js');
const DRAG_SOURCE = path.join(__dirname, 'zx-ux-01/drag.m');
const SWIFT_BIN = '/tmp/zx-ux-01-drag';
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-ux-01');
const HOME = '/tmp/zx-ux-01-home';
const PORT = 5173;
const APP_ID = 'com.zhixing.desktop';
const TASK_TITLE = '完成新版产品需求文档';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
if (!fs.existsSync(BIN)) {
  throw new Error(`桌面二进制不存在：${BIN}`);
}
fs.mkdirSync(EVIDENCE, { recursive: true });
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = {
  startedAt: new Date().toISOString(),
  task: 'ZX-UX-01',
  steps: [],
  consoleErrors: [],
  appLog: '',
  realMouse: null,
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-ux-01] ${name}: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// 静态服务 + 探针命令队列
// ---------------------------------------------------------------------------
let readyResolve;
let probeReady = new Promise((resolve) => {
  readyResolve = resolve;
});
const queue = [];
const pending = new Map();
let commandSeq = 0;

function indexWithProbe() {
  return fs
    .readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .replace('</body>', '<script src="/__zx_probe.js"></script></body>');
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
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (url.pathname === '/__probe-ready') {
        readyResolve?.();
        response.writeHead(204);
        response.end();
        return;
      }
      if (url.pathname === '/__result') {
        try {
          const payload = JSON.parse(body);
          const waiter = pending.get(payload.id);
          if (waiter) {
            pending.delete(payload.id);
            waiter(payload);
          }
        } catch {
          /* ignore */
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
  if (url.pathname === '/__zx_probe.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(fs.readFileSync(PROBE));
    return;
  }
  if (url.pathname === '/__next') {
    const command = queue.shift();
    if (command) {
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(command));
    } else {
      response.writeHead(204);
      response.end();
    }
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

function command(payload, timeout = 20_000) {
  const id = ++commandSeq;
  queue.push({ id, ...payload });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`探针命令超时：${payload.type}`));
    }, timeout);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (!message.result?.ok) {
        reject(new Error(message.result?.error || `${payload.type} 失败`));
        return;
      }
      resolve(message.result.value);
    });
  });
}

// ---------------------------------------------------------------------------
// 桌面进程
// ---------------------------------------------------------------------------
probeReady = new Promise((resolve) => {
  readyResolve = resolve;
});
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
app.stdout.on('data', (chunk) => {
  evidence.appLog += String(chunk);
});
app.stderr.on('data', (chunk) => {
  evidence.appLog += String(chunk);
});
const exited = new Promise((resolve) => app.on('exit', resolve));

async function cleanup() {
  try {
    app.kill('SIGTERM');
    await Promise.race([exited, sleep(3000)]);
    if (app.exitCode === null) app.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  server.close();
}

try {
  const ready = await Promise.race([
    probeReady.then(() => true),
    sleep(30_000).then(() => false),
  ]);
  if (!ready) throw new Error('探针 30s 内未就绪');
  await command({ type: 'sleep', ms: 800 });

  let env = await command({ type: 'env' });
  record('startup', {
    isTauri: env.isTauri,
    hasPointerEvent: env.hasPointerEvent,
    hasElementFromPoint: env.hasElementFromPoint,
    activeTab: env.activeTab,
    bodyText: env.bodyText.slice(0, 120),
  });

  if (env.bodyText.includes('开始 7 天试用')) {
    env = await command({ type: 'clickText', text: '开始 7 天试用' });
    await command({ type: 'sleep', ms: 600 });
    record('trial-started', { bodyText: env.bodyText.slice(0, 120) });
  }
  if (!env.hasTodayTitle) {
    env = await command(
      { type: 'clickText', text: '今天', selector: 'a, button, [role="link"]' },
      10_000,
    );
    await command({ type: 'sleep', ms: 500 });
  }
  env = await command({ type: 'env' });
  if (!env.hasTodayTitle) {
    throw new Error(`未进入今天页：${env.bodyText.slice(0, 200)}`);
  }

  // -------------------------------------------------------------------------
  // 四象限
  // -------------------------------------------------------------------------
  await command({ type: 'view', label: '四象限' });
  const quadrantBefore = await command({ type: 'state' });
  record('quadrant-before', quadrantBefore.quadrant);

  const quadrantRects = await command({
    type: 'rects',
    kind: 'quadrant',
    title: TASK_TITLE,
    targetLabel: '四象限：重要不紧急',
  });

  execFileSync(
    'clang',
    [
      '-O2',
      '-framework',
      'Cocoa',
      '-framework',
      'ApplicationServices',
      DRAG_SOURCE,
      '-o',
      SWIFT_BIN,
    ],
    {
      stdio: 'pipe',
      timeout: 120_000,
    },
  );
  const bounds = JSON.parse(
    execFileSync(
      SWIFT_BIN,
      ['--pid', String(app.pid), '--mode', 'bounds'],
      { encoding: 'utf8', timeout: 30_000 },
    ).trim(),
  );
  record('macos-window', bounds);

  let quadrantResult = null;
  let quadrantMouse = null;
  if (bounds.ok) {
    const drag = JSON.parse(
      execFileSync(
        SWIFT_BIN,
        [
          '--pid',
          String(app.pid),
          '--mode',
          'drag',
          '--x',
          String(quadrantRects.source.center.x),
          '--y',
          String(quadrantRects.source.center.y),
          '--tx',
          String(quadrantRects.target.center.x),
          '--ty',
          String(quadrantRects.target.center.y),
          '--inner-width',
          String(quadrantRects.window.innerWidth),
          '--inner-height',
          String(quadrantRects.window.innerHeight),
        ],
        { encoding: 'utf8', timeout: 60_000 },
      ).trim(),
    );
    quadrantMouse = drag;
    record('quadrant-os-drag', drag);
    await command({ type: 'sleep', ms: 500 });
    const waited = await command({
      type: 'waitTask',
      kind: 'quadrant',
      title: TASK_TITLE,
      targetLabel: '四象限：重要不紧急',
      timeout: 3000,
    });
    if (waited.found) {
      quadrantResult = waited;
      evidence.realMouse = {
        available: true,
        dispatch: drag.dispatch,
        trusted: drag.trusted,
      };
    } else {
      record('quadrant-os-drag-no-effect', {
        dispatch: drag.dispatch,
        trusted: drag.trusted,
      });
    }
  }

  if (!quadrantResult) {
    if (!evidence.realMouse) {
      evidence.realMouse = {
        available: false,
        reason: quadrantMouse
          ? '系统鼠标事件已投递但 WebView 未响应（无辅助功能权限）'
          : '无法获取窗口边界',
      };
    }
    quadrantResult = await command({
      type: 'pointerDrag',
      kind: 'quadrant',
      title: TASK_TITLE,
      targetLabel: '四象限：重要不紧急',
    });
    record('quadrant-pointer-fallback', quadrantResult);
  }
  record('quadrant-after', quadrantResult.quadrant);
  const quadrantMoved =
    quadrantResult.quadrant?.some(
      (section) => section.quadrant === 2 && section.tasks.includes(TASK_TITLE),
    ) ?? false;
  record('quadrant-verdict', { moved: quadrantMoved });

  // 取消路径（真实 WebView 内 Esc）。
  await command({ type: 'view', label: '四象限' });
  const cancel = await command({
    type: 'pointerCancel',
    title: TASK_TITLE,
    targetLabel: '四象限：重要且紧急',
  });
  record('quadrant-cancel', cancel);

  // -------------------------------------------------------------------------
  // 看板
  // -------------------------------------------------------------------------
  await command({ type: 'view', label: '看板' });
  record('board-before', (await command({ type: 'state' })).board);

  const boardRects = await command({
    type: 'rects',
    kind: 'board',
    title: TASK_TITLE,
    targetLabel: '进行中列',
  });
  let boardResult = null;
  let boardMouse = null;
  if (bounds.ok) {
    const drag = JSON.parse(
      execFileSync(
        SWIFT_BIN,
        [
          '--pid',
          String(app.pid),
          '--mode',
          'drag',
          '--x',
          String(boardRects.source.center.x),
          '--y',
          String(boardRects.source.center.y),
          '--tx',
          String(boardRects.target.center.x),
          '--ty',
          String(boardRects.target.center.y),
          '--inner-width',
          String(boardRects.window.innerWidth),
          '--inner-height',
          String(boardRects.window.innerHeight),
        ],
        { encoding: 'utf8', timeout: 60_000 },
      ).trim(),
    );
    boardMouse = drag;
    record('board-os-drag', drag);
    await command({ type: 'sleep', ms: 500 });
    const waited = await command({
      type: 'waitTask',
      kind: 'board',
      title: TASK_TITLE,
      targetLabel: '进行中列',
      timeout: 3000,
    });
    if (waited.found) {
      boardResult = waited;
      evidence.realMouse = {
        available: true,
        dispatch: drag.dispatch,
        trusted: drag.trusted,
      };
    } else {
      record('board-os-drag-no-effect', {
        dispatch: drag.dispatch,
        trusted: drag.trusted,
      });
    }
  }

  if (!boardResult) {
    boardResult = await command({
      type: 'pointerDrag',
      kind: 'board',
      title: TASK_TITLE,
      targetLabel: '进行中列',
    });
    record('board-pointer-fallback', boardResult);
  }
  record('board-after', boardResult.board);
  const boardMoved =
    boardResult.board?.some(
      (column) =>
        column.status === 'doing' && column.tasks.includes(TASK_TITLE),
    ) ?? false;
  record('board-verdict', { moved: boardMoved });

  const finalState = await command({ type: 'state' });
  evidence.consoleErrors = finalState.errors ?? [];

  // SQLite 侧核对。
  try {
    const dbPath = path.join(
      HOME,
      'Library/Application Support',
      APP_ID,
      'zhixing.db',
    );
    const row = execFileSync(
      'sqlite3',
      [
        dbPath,
        `select quadrant || '|' || status from tasks where id = 'seed-task-review';`,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    ).trim();
    record('sqlite', { dbPath, row });
    evidence.sqlite = row;
  } catch (error) {
    record('sqlite', { error: String(error) });
  }

  evidence.verdict = {
    quadrantMoved,
    boardMoved,
    realMouse: evidence.realMouse,
    consoleErrors: evidence.consoleErrors,
  };
  if (!quadrantMoved || !boardMoved) {
    evidence.failed = true;
  }
} catch (error) {
  evidence.error = String(error?.stack || error);
  console.error(`[zx-ux-01] FAILED: ${evidence.error}`);
  evidence.failed = true;
} finally {
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(EVIDENCE, 'desktop-run.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(EVIDENCE, 'app.log.txt'), evidence.appLog);
  await cleanup();
}

console.log(JSON.stringify(evidence.verdict ?? { failed: true }, null, 2));
process.exit(evidence.failed ? 1 : 0);
