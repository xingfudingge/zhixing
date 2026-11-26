/**
 * ZX-NOTE-03/07 桌面验收：文档级全选与多块删除（长文手测）。
 *
 * 语义以《笔记块排版与选择模型 v4》（ZX-DESIGN-09）为准，取代旧「⌘A 三态」。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`（真实 WKWebView + SQLite）；
 *   * 本地静态服务注入只读探针，不替换产品 IPC、不注入假数据源；
 *   * 探针经产品 IPC 造 12 块长笔记 + 1 篇移动目标笔记，再走真实知识页正文：
 *       - ⌘A 一次选中整篇（原生 Range + 整篇块高亮、无复选框），再按不循环；
 *       - ⌘⇧A 退出选择；底部「选择块」进入高级块选择（复选框 + Shift 范围）；
 *       - checkbox 单选 + Shift+点击范围 + Ctrl/⌘+点击追加 + Esc 退出；
 *       - 批量删除 3 块 → 一次 ⌘Z 恢复顺序（真实 SQLite 软删除行）；
 *       - 批量复制写入纯文本 + HTML；
 *       - 批量移动 2 块到目标笔记 → ⌘Z / ⇧⌘Z 同时恢复两篇笔记；
 *       - 点击空白退出块选择；
 *   * 收集 console.error / window.error / unhandledrejection。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-note-03-desktop.mjs
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
const PROBE = path.join(__dirname, 'zx-note-03/probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-note-03');
const HOME = '/tmp/zx-note-03-home';
const PORT = 5173;
const TITLE = 'ZX-NOTE-03 全选与多块删除';

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
  task: 'ZX-NOTE-03',
  title: '知识全选与多块删除（长文手测）',
  steps: [],
  consoleErrors: [],
  appLog: '',
  failures: [],
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-note-03] ${name}: ${JSON.stringify(value)}`);
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
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
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

function command(payload, timeout = 40_000) {
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
  fs.writeFileSync(
    path.join(EVIDENCE, 'result.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

try {
  await nextProbeReady();
  await command({ type: 'sleep', ms: 800 });

  let env = await command({ type: 'env' });
  record('startup', {
    isTauri: env.isTauri,
    bodyText: env.bodyText.slice(0, 120),
    size: `${env.innerWidth}×${env.innerHeight}`,
  });
  assert(env.isTauri, '不是真实 Tauri WebView');

  if (env.bodyText.includes('开始 7 天试用')) {
    await command({ type: 'clickText', text: '开始 7 天试用' });
    await command({ type: 'sleep', ms: 800 });
    env = await command({ type: 'env' });
    record('trial-started', { bodyText: env.bodyText.slice(0, 120) });
  }

  const seeded = await command({ type: 'seed' });
  record('seeded', seeded);
  assert(seeded.blocks === 12, `长文块数不是 12：${seeded.blocks}`);

  await command({ type: 'gotoKnowledge' });
  await command({ type: 'openNote', title: TITLE });
  await command({ type: 'sleep', ms: 500 });

  const snapshot0 = await command({ type: 'snapshot' });
  record('initial-snapshot', snapshot0);
  assert(snapshot0.rows.length === 12, `正文块数不是 12：${snapshot0.rows.length}`);

  // 1. ⌘A 文档级全选（ZX-NOTE-07 语义）-------------------------------------
  const cycle = await command({ type: 'selectAllCycle' });
  record('select-all-cycle', cycle);
  assert(
    cycle.first.selected === 12,
    `第一次 ⌘A 应一次选中整篇 12 块：${cycle.first.selected}`,
  );
  assert(
    cycle.first.nativeSelection.includes('第 1 段'),
    `第一次 ⌘A 原生选区没有覆盖正文开头：${cycle.first.nativeSelection}`,
  );
  assert(
    cycle.first.notice.includes('已选中整篇'),
    `第一次 ⌘A 提示缺失：${cycle.first.notice}`,
  );
  assert(
    cycle.first.checkboxes === false && cycle.first.mode === 'document',
    '整篇选择不应显示每块复选框',
  );
  assert(
    cycle.second.selected === 12,
    `第二次 ⌘A 没有保持整篇 12 块：${cycle.second.selected}`,
  );
  assert(
    cycle.second.toolbar.text.includes('已选中整篇 · 12 个块'),
    `操作条计数不正确：${cycle.second.toolbar.text}`,
  );
  assert(
    cycle.second.toolbar.buttons.includes('复制') &&
      cycle.second.toolbar.buttons.includes('移动…') &&
      cycle.second.toolbar.buttons.includes('删除'),
    `操作条按钮缺失：${JSON.stringify(cycle.second.toolbar.buttons)}`,
  );
  assert(
    cycle.second.notice.includes('已是整篇'),
    `第二次 ⌘A 应提示已是整篇：${cycle.second.notice}`,
  );
  assert(
    cycle.third.selected === 0 && !cycle.third.toolbar.present,
    `⌘⇧A 没有退出选择：${cycle.third.selected}`,
  );
  assert(
    cycle.third.focusBackInEditor,
    '⌘⇧A 后焦点没有回到正文',
  );

  // 2. 高级块选择：单选 / Shift 范围 / Ctrl 追加 / Esc ----------------------
  const range = await command({ type: 'rangeSelection' });
  record('range-selection', range);
  assert(
    range.checkboxesEntered === true,
    '底部「选择块」没有进入高级块选择',
  );
  assert(
    range.shiftRange.selected === 4,
    `Shift+点击范围不是 4 块：${range.shiftRange.selected}`,
  );
  assert(
    range.shiftRange.ids[0] === 'zx-note-03-b3' &&
      range.shiftRange.ids[3] === 'zx-note-03-b6',
    `Shift 范围 id 不正确：${JSON.stringify(range.shiftRange.ids)}`,
  );
  assert(
    range.additive.selected === 5,
    `Ctrl+点击追加后不是 5 块：${range.additive.selected}`,
  );
  assert(
    range.afterEscape.selected === 0 && !range.afterEscape.toolbar.present,
    'Esc 没有退出块选择',
  );

  // 3. 批量删除 + 一次 ⌘Z 撤销 -------------------------------------------
  const deleted = await command({ type: 'batchDeleteUndo' });
  record('batch-delete-undo', deleted);
  assert(
    deleted.deleted.count === 9,
    `删除 3 块后剩 9 块：${deleted.deleted.count}`,
  );
  assert(
    deleted.deleted.notice.includes('已删除 3 个块'),
    `删除提示缺失：${deleted.deleted.notice}`,
  );
  assert(
    deleted.deleted.history.undoDisabled === false,
    '删除后撤销按钮不可用',
  );
  assert(
    deleted.undone.count === 12,
    `撤销后没有恢复 12 块：${deleted.undone.count}`,
  );
  assert(deleted.restoredOrder, '撤销后块顺序/内容不一致');
  assert(
    deleted.saveLabel.includes('已保存到本机'),
    `撤销后未保存：${deleted.saveLabel}`,
  );

  // 4. 批量复制 ------------------------------------------------------------
  const copied = await command({ type: 'copySelected' });
  record('copy-selected', {
    selected: copied.selected,
    prevented: copied.prevented,
    textLength: copied.text.length,
    htmlLength: copied.html.length,
    notice: copied.notice,
    textHead: copied.text.slice(0, 60),
    textTail: copied.text.slice(-60),
  });
  assert(copied.selected === 12, `复制前没有全选：${copied.selected}`);
  assert(copied.prevented, '⌘C 没有被应用接管');
  assert(
    copied.text.includes('第 1 段') && copied.text.includes('第 12 段'),
    '复制纯文本缺少首尾块',
  );
  assert(
    copied.text.split('\n\n').length === 12,
    `复制纯文本块间距不正确：${copied.text.split('\n\n').length}`,
  );
  assert(
    copied.html.includes('<p>') && copied.html.includes('第 1 段'),
    '复制 HTML 没有保持段落结构',
  );
  assert(
    copied.notice.includes('已复制 12 个块'),
    `复制提示缺失：${copied.notice}`,
  );

  // 5. 批量移动到另一篇笔记 + 撤销/重做 -----------------------------------
  const moved = await command({ type: 'moveToTargetNote' });
  record('move-to-target', moved);
  assert(
    moved.afterMove.sourceCount === 10,
    `移动后源笔记不是 10 块：${moved.afterMove.sourceCount}`,
  );
  assert(
    moved.afterMove.targetTexts.length === 3 &&
      moved.afterMove.targetTexts[0] === '目标原有段落' &&
      moved.afterMove.targetTexts[1].includes('第 2 段') &&
      moved.afterMove.targetTexts[2].includes('第 3 段'),
    `移动后目标笔记内容不正确：${JSON.stringify(moved.afterMove.targetTexts)}`,
  );
  assert(
    moved.afterUndo.sourceCount === 12 &&
      moved.afterUndo.targetTexts.length === 1,
    `撤销移动没有同时恢复两篇笔记：${JSON.stringify(moved.afterUndo)}`,
  );
  assert(
    moved.afterRedo.sourceCount === 10 &&
      moved.afterRedo.targetTexts.length === 3,
    `重做移动没有同时恢复两篇笔记：${JSON.stringify(moved.afterRedo)}`,
  );

  // 6. 点击空白退出块选择 --------------------------------------------------
  const blank = await command({ type: 'blankClickClears' });
  record('blank-click-clears', blank);
  assert(blank.before === 10, `空白点击前应全选重做后剩下的 10 块：${blank.before}`);
  assert(
    blank.after === 0 && !blank.toolbar.present,
    `点击空白没有退出块选择：${JSON.stringify(blank)}`,
  );

  const errors = await command({ type: 'errors' });
  evidence.consoleErrors = errors;
  record('console-errors', errors);
  assert(errors.length === 0, `控制台有错误：${JSON.stringify(errors)}`);
} catch (error) {
  evidence.failures.push(
    (error && (error.stack || error.message || String(error))) || 'unknown',
  );
  console.error(`[zx-note-03] FAILED: ${error}`);
} finally {
  writeEvidence();
  await cleanup();
}

const target = path.join(EVIDENCE, 'result.json');
console.log(`[zx-note-03] evidence: ${target}`);
if (evidence.failures.length > 0) {
  console.error(`[zx-note-03] failures: ${JSON.stringify(evidence.failures)}`);
  process.exit(1);
}
