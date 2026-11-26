/**
 * ZX-UX-09 桌面验收：笔记编辑器撤销/重做（块级历史）。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`（真实 WKWebView + SQLite）；
 *   * 本地静态服务注入只读探针，不替换产品 IPC、不注入假数据源；
 *   * 探针经产品 IPC 造笔记，再走真实知识页正文操作：
 *       - 输入 10 个字 → ⌘Z 一次回到输入前 → ⇧⌘Z 恢复；
 *       - 插入表格 → ⌘Z 移除 → ⇧⌘Z 恢复；
 *       - 页脚撤销/重做按钮位置、禁用态与工具轨 12 项；
 *       - 300ms 防抖保存后重载 WebView，确认内容为撤销后的状态；
 *   * 收集 console.error / window.error / unhandledrejection。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-ux-09-desktop.mjs
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
const PROBE = path.join(__dirname, 'zx-ux-09/probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-ux-09');
const HOME = '/tmp/zx-ux-09-home';
const PORT = 5173;
const TITLE = 'ZX-UX-09 撤销重做';
const PHRASE = '这是十个字的输入内容';

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
  task: 'ZX-UX-09',
  title: TITLE,
  steps: [],
  consoleErrors: [],
  appLog: '',
  failures: [],
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-ux-09] ${name}: ${JSON.stringify(value)}`);
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
let readyResolve = null;
function nextProbeReady(timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      readyResolve = null;
      reject(new Error('探针未在超时内就绪'));
    }, timeout);
    readyResolve = () => {
      clearTimeout(timer);
      readyResolve = null;
      resolve(true);
    };
  });
}

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
        response.writeHead(204);
        response.end();
        readyResolve?.();
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
  await nextProbeReady();
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

  const seeded = await command({ type: 'seedNote' });
  record('seeded', seeded);

  await command({ type: 'gotoKnowledge' });
  const opened = await command({ type: 'openNote', title: TITLE });
  record('opened-note', opened);
  record('initial-snapshot', await command({ type: 'snapshot' }));

  const typing = await command({ type: 'typeTenAndUndoRedo' });
  record('typing-undo-redo', typing);
  assert(
    typing.typedLength === PHRASE.length,
    `输入字符数不是 10：${typing.typedLength}`,
  );
  assert(
    typing.undoNotPrevented === false,
    '⌘Z 没有被应用层接管（原生 undo 仍会执行）',
  );
  assert(
    typing.afterUndo.text === '',
    `⌘Z 后正文应为空：${JSON.stringify(typing.afterUndo.text)}`,
  );
  assert(
    typing.afterUndo.history.undoDisabled === true,
    '撤销到起点后撤销按钮未禁用',
  );
  assert(
    typing.afterUndo.history.redoDisabled === false,
    '撤销后重做按钮未启用',
  );
  assert(
    typing.afterRedo.text?.includes(PHRASE),
    `⇧⌘Z 未恢复正文：${JSON.stringify(typing.afterRedo.text)}`,
  );
  assert(
    typing.redoNotPrevented === false,
    '⇧⌘Z 没有被应用层接管',
  );
  assert(typing.finalText === '', '最终状态没有停留在输入已撤销');

  const table = await command({ type: 'insertTableUndoRedo' });
  record('table-undo-redo', table);
  assert(table.inserted.table.hasTable, '插入表格失败');
  assert(table.undoNotPrevented === false, '表格内 ⌘Z 没有被应用层接管');
  assert(table.removed, '⌘Z 没有移除表格');
  assert(
    table.afterUndo.table.hasTable === false,
    '撤销后表格仍在',
  );
  assert(table.restored, '⇧⌘Z 没有恢复表格');
  assert(table.afterRedo.table.hasTable, '重做后表格不存在');
  assert(
    table.afterRedo.text === '',
    `最终正文不应包含已撤销的 10 个字：${JSON.stringify(table.afterRedo.text)}`,
  );

  const savedState = await command({ type: 'waitSave' });
  record('saved-state', savedState);
  const saved = await command({ type: 'snapshot' });
  record('after-save', saved);
  assert(
    saved.saveLabel.includes('已保存到本机'),
    `保存状态不是已保存到本机：${saved.saveLabel}`,
  );
  assert(saved.table.hasTable, '保存前表格丢失');
  assert(!saved.phrasePresent, '保存前已撤销的输入又出现');
  assert(
    saved.history.undoCount === 1 && saved.history.redoCount === 1,
    `页脚应只有一组撤销/重做按钮：${JSON.stringify(saved.history)}`,
  );
  assert(
    saved.history.undoTitle?.includes('⌘Z') &&
      saved.history.redoTitle?.includes('⇧⌘Z'),
    '撤销/重做按钮缺少快捷键 title',
  );
  assert(saved.rail.found, '找不到右侧工具轨');
  assert(
    saved.rail.items === 9 && saved.rail.toggle,
    `工具轨应保持 9 项 + 折叠按钮：${JSON.stringify(saved.rail)}`,
  );

  // 重载真实 WebView：从 SQLite 重新读取块，确认撤销后的状态已落库。
  await command({ type: 'reload' });
  await nextProbeReady(30_000);
  await sleep(1200);
  let env2 = await command({ type: 'env' });
  if (env2.bodyText.includes('开始 7 天试用')) {
    await command({ type: 'clickText', text: '开始 7 天试用' });
    await command({ type: 'sleep', ms: 800 });
  }
  await command({ type: 'gotoKnowledge' });
  await command({ type: 'openNote', title: TITLE });
  await sleep(500);
  await command({ type: 'waitSave' });
  const reopened = await command({ type: 'snapshot' });
  record('reopened', reopened);
  assert(reopened.table.hasTable, '重开后表格没有持久化');
  assert(
    !reopened.phrasePresent,
    '重开后已撤销的 10 个字仍然存在',
  );
  assert(
    reopened.saveLabel.includes('已保存到本机'),
    `重开后保存状态异常：${reopened.saveLabel}`,
  );

  const probeErrors = await command({ type: 'errors' });
  evidence.consoleErrors = probeErrors;
  record('console-errors', probeErrors);
  assert(probeErrors.length === 0, `控制台错误：${probeErrors.join(' | ')}`);
} catch (error) {
  evidence.failures.push(String(error?.stack || error));
  record('failure', String(error?.message || error));
} finally {
  const target = writeEvidence();
  await cleanup();
  console.log(`[zx-ux-09] evidence: ${target}`);
  if (evidence.failures.length > 0) {
    console.error(`[zx-ux-09] FAILED: ${evidence.failures.length} 项`);
    process.exitCode = 1;
  } else {
    console.log('[zx-ux-09] PASS');
  }
}
