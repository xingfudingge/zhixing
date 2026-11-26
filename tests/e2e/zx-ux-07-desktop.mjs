/**
 * ZX-UX-07 桌面验收：内链插入/跳转与搜索命中定位。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`（真实 WKWebView + SQLite）；
 *   * 本地静态服务注入只读探针，不替换产品 IPC、不注入假数据源；
 *   * 探针经产品 IPC 造 3 篇笔记，再走真实知识页/格式条/搜索面板操作；
 *   * 覆盖：笔记内链选择器、Cmd+点击跳转、反向链接、删除目标后的缺失提示、
 *     ⌘K 正文搜索定位/1.4s 高亮、脏 find 参数提示。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-ux-07-desktop.mjs
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
const PROBE = path.join(__dirname, 'zx-ux-07/probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-ux-07');
const HOME = '/tmp/zx-ux-07-home';
const PORT = 5173;
const TITLE_A = 'ZX-UX-07 来源笔记';
const TITLE_B = 'ZX-UX-07 目标笔记';
const TITLE_C = 'ZX-UX-07 搜索定位';

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
  task: 'ZX-UX-07',
  steps: [],
  consoleErrors: [],
  appLog: '',
  failures: [],
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-ux-07] ${name}: ${JSON.stringify(value)}`);
}

function assert(condition, message) {
  if (!condition) {
    evidence.failures.push(message);
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// 静态服务 + 探针命令队列
// ---------------------------------------------------------------------------
let readyResolve;
const probeReady = new Promise((resolve) => {
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
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
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

function command(payload, timeout = 30_000) {
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
      evidence.consoleErrors.push(...(message.errors ?? []));
      resolve(message.result.value);
    });
  });
}

// ---------------------------------------------------------------------------
// 桌面进程
// ---------------------------------------------------------------------------
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

function writeEvidence() {
  evidence.finishedAt = new Date().toISOString();
  evidence.ok = evidence.failures.length === 0;
  const target = path.join(EVIDENCE, 'result.json');
  fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
  return target;
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
    dataTheme: env.dataTheme,
    bodyText: env.bodyText.slice(0, 120),
  });
  assert(env.isTauri, '不是真实 Tauri WebView');

  if (env.bodyText.includes('开始 7 天试用')) {
    await command({ type: 'clickText', text: '开始 7 天试用' });
    await command({ type: 'sleep', ms: 800 });
    env = await command({ type: 'env' });
    record('trial-started', { bodyText: env.bodyText.slice(0, 120) });
  }

  const seeded = await command({ type: 'seedNotes' });
  record('seeded', seeded);

  await command({ type: 'gotoKnowledge' });
  const openedA = await command({ type: 'openNote', title: TITLE_A });
  record('opened-source', openedA);

  const inserted = await command({ type: 'insertInternalLink' });
  record('inserted-internal-link', inserted);
  assert(inserted.runHasLink, '块的 runs 没有 link mark');
  assert(inserted.bodyHasLink, 'notes.body 没有站内内链');
  assert(
    inserted.href === 'zhixing://note/zx-ux-07-note-b',
    `内链 href 不正确：${inserted.href}`,
  );
  assert(inserted.selected.length > 0, '划词没有生效');

  const jumped = await command({ type: 'openInternalLink' });
  record('opened-target', jumped);
  assert(jumped.activeTitle === TITLE_B, 'Cmd+点击未打开目标笔记');
  assert(
    decodeURIComponent(jumped.href).includes('note=zx-ux-07-note-b'),
    `URL 未切换到目标笔记：${jumped.href}`,
  );

  const backlink = await command({
    type: 'openLinksPanel',
    expectTitle: TITLE_A,
  });
  record('backlink', backlink);
  assert(
    backlink.backlinkText.includes(TITLE_A),
    '目标笔记的反向链接没有来源笔记',
  );

  await command({ type: 'deleteNote', title: TITLE_B });
  record('deleted-target', { title: TITLE_B });
  await command({ type: 'openNote', title: TITLE_A });
  const missing = await command({ type: 'clickInternalLinkAgain' });
  record('missing-target', missing);
  assert(
    typeof missing.toast === 'string' &&
      missing.toast.includes('笔记不存在或已删除'),
    `删除目标后缺少缺失提示：${JSON.stringify(missing).slice(0, 600)}`,
  );

  await command({ type: 'openNote', title: TITLE_C });
  const located = await command({ type: 'searchLocate' });
  record('search-locate', located);
  assert(
    decodeURIComponent(located.href).includes('find=响应式'),
    `搜索深链没有 find 参数：${located.href}`,
  );
  assert(located.text.includes('响应式布局要点'), '高亮块不是命中块');
  assert(located.animationName === 'zxe-search-flash', '命中块没有高亮动画');
  assert(located.inViewport, '命中块不在视口内');
  assert(located.highlightCleared, '1.4s 后高亮没有褪去');

  const dirty = await command({ type: 'dirtyFind' });
  record('dirty-find', dirty);
  assert(
    dirty.toast.includes('未找到匹配位置'),
    '脏 find 没有提示未找到匹配位置',
  );

  const probeErrors = await command({ type: 'errors' });
  record('console-errors', probeErrors);
  assert(probeErrors.length === 0, `控制台错误：${probeErrors.join(' | ')}`);
} catch (error) {
  evidence.failures.push(String(error?.stack || error));
  record('failure', String(error?.message || error));
} finally {
  const target = writeEvidence();
  await cleanup();
  console.log(`[zx-ux-07] evidence: ${target}`);
  if (evidence.failures.length > 0) {
    console.error(`[zx-ux-07] FAILED: ${evidence.failures.length} 项`);
    process.exitCode = 1;
  } else {
    console.log('[zx-ux-07] PASS');
  }
}
