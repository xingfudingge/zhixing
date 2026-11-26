/**
 * ZX-TABLE-01 桌面验收：知识表格（真实 Tauri WebView + SQLite）。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`；
 *   * 本地静态服务注入只读探针，不替换产品 IPC、不注入假数据源；
 *   * 探针经产品 IPC 造 3×3 表格笔记与 40×16 边界笔记；
 *   * 走真实知识页表格工具栏：
 *       表头、对齐、列宽拖拽、任意插入/删除、区域选择、合并/拆分、
 *       Tab/Enter 导航、TSV 复制粘贴、Markdown/HTML 导出、撤销/重做；
 *   * 每一步读回真实 SQLite payload 与 notes.body；
 *   * 收集 console.error / window.error / unhandledrejection。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-table-01-desktop.mjs
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
const PROBE = path.join(__dirname, 'zx-table-01/probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-table-01');
const HOME = '/tmp/zx-table-01-home';
const PORT = 5173;
const NOTE_TITLE = '表格手测';
const LIMIT_TITLE = '表格边界';

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
  task: 'ZX-TABLE-01',
  title: '知识表格（真实桌面手测）',
  steps: [],
  consoleErrors: [],
  appLog: '',
  failures: [],
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-table-01] ${name}: ${JSON.stringify(value)}`);
}

function assert(condition, message) {
  if (!condition) {
    evidence.failures.push(message);
    throw new Error(message);
  }
}

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

function cellValues(snapshot) {
  return Object.fromEntries(
    snapshot.cells.map((cell) => [cell.label, cell.value]),
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
    await command({ type: 'click', label: '开始 7 天试用', wait: 900 });
    env = await command({ type: 'env' });
    record('trial-started', { bodyText: env.bodyText.slice(0, 120) });
  }

  const seeded = await command({ type: 'seed' });
  record('seeded', seeded);
  assert(seeded.notes === 2, `种子笔记不是 2 篇：${seeded.notes}`);

  await command({ type: 'gotoKnowledge' });
  await command({ type: 'openNote', title: NOTE_TITLE });
  let table = await command({ type: 'table' });
  record('initial', {
    headerCount: table.headerCount,
    rowCount: table.rowCount,
    columnCount: table.columnCount,
    widths: table.widths,
  });
  assert(table.exists, '表格未渲染');
  assert(table.headerCount === 3, `表头单元格不是 3：${table.headerCount}`);
  assert(table.rowCount === 3, `行数不是 3：${table.rowCount}`);
  assert(table.columnCount === 3, `列数不是 3：${table.columnCount}`);
  assert(table.hasThead, '默认表头没有渲染 thead');
  assert(table.hasColgroup, '表格缺少 colgroup 列宽表示');
  assert(
    table.widths.every((width) => width === '140px'),
    `默认列宽不是 140px：${JSON.stringify(table.widths)}`,
  );

  table = await command({
    type: 'setCell',
    row: 0,
    column: 0,
    value: '知识表格',
    wait: 200,
  });
  assert(
    cellValues(table)['第 1 行第 1 列'] === '知识表格',
    '单元格输入未反映到 DOM',
  );
  await command({ type: 'sleep', ms: 1800 });
  let stored = await command({ type: 'stored' });
  record('stored-content', {
    cell: stored.payload?.rows?.[0]?.[0]?.text,
    bodyHasTable: stored.body.includes('<table'),
    body: stored.body.slice(0, 240),
  });
  assert(
    stored.payload?.rows?.[0]?.[0]?.text === '知识表格',
    '单元格内容没有写入 SQLite payload',
  );
  assert(
    stored.body.includes('<table') &&
      stored.body.includes('知识表格'),
    'notes.body 兼容缓存没有表格内容',
  );

  let next = await command({ type: 'click', label: '表头' });
  record('header-off', {
    headerCount: next.headerCount,
    status: next.status,
  });
  assert(next.headerCount === 0, '关闭表头后仍有 th');
  next = await command({ type: 'click', label: '表头' });
  assert(next.headerCount === 3, '重新开启表头后 th 数不正确');

  table = await command({
    type: 'selectRect',
    r0: 0,
    c0: 0,
    r1: 0,
    c1: 0,
  });
  assert(
    table.count.includes('已选 1×1'),
    `单选统计不正确：${table.count}`,
  );
  table = await command({ type: 'click', label: '中对齐' });
  record('align', {
    status: table.status,
    htmlHasCenter: table.html.includes('text-align: center'),
  });
  assert(
    table.html.includes('text-align: center'),
    '居中对齐没有渲染 text-align: center',
  );
  await command({ type: 'sleep', ms: 1800 });
  stored = await command({ type: 'stored' });
  assert(
    stored.payload?.rows?.[0]?.[0]?.align === 'center',
    '对齐没有写入 SQLite payload',
  );

  table = await command({
    type: 'selectRect',
    r0: 1,
    c0: 1,
    r1: 2,
    c1: 2,
  });
  assert(
    table.count.includes('已选 2×2'),
    `区域选择统计不正确：${table.count}`,
  );
  table = await command({ type: 'click', label: '合并' });
  record('merged', {
    merged: table.merged,
    status: table.status,
  });
  assert(table.merged.colspan === '2', '合并后缺少 colspan=2');
  assert(table.merged.rowspan === '2', '合并后缺少 rowspan=2');

  table = await command({ type: 'click', label: '删除当前行' });
  record('delete-crossing-merge', {
    status: table.status,
    rowCount: table.rowCount,
  });
  assert(
    table.status.includes('请先拆分'),
    `删除合并行没有拒绝原因：${table.status}`,
  );
  assert(table.rowCount === 3, '删除合并行被拒绝后行数发生变化');

  table = await command({ type: 'click', label: '拆分' });
  record('split', { merged: table.merged, status: table.status });
  assert(table.merged.colspan === null, '拆分后仍有 colspan');
  assert(table.merged.rowspan === null, '拆分后仍有 rowspan');

  table = await command({
    type: 'selectRect',
    r0: 1,
    c0: 0,
    r1: 1,
    c1: 0,
  });
  table = await command({ type: 'click', label: '上方插入行' });
  record('insert-row', { rowCount: table.rowCount, status: table.status });
  assert(table.rowCount === 4, '上方插入行后行数不是 4');
  table = await command({ type: 'click', label: '右侧插入列' });
  record('insert-column', {
    columnCount: table.columnCount,
    status: table.status,
  });
  assert(table.columnCount === 4, '右侧插入列后列数不是 4');

  table = await command({ type: 'undoRedo', action: 'undo' });
  record('undo-column', { columnCount: table.columnCount });
  assert(table.columnCount === 3, '撤销插入列后列数不是 3');
  table = await command({ type: 'undoRedo', action: 'undo' });
  record('undo-row', { rowCount: table.rowCount });
  assert(table.rowCount === 3, '撤销插入行后行数不是 3');
  table = await command({ type: 'undoRedo', action: 'redo' });
  record('redo-row', { rowCount: table.rowCount });
  assert(table.rowCount === 4, '重做插入行后行数不是 4');
  await command({ type: 'undoRedo', action: 'undo' });

  table = await command({ type: 'key', row: 0, column: 0, key: 'Tab' });
  record('tab-next', { active: table.active });
  assert(
    table.active === '第 1 行第 2 列',
    `Tab 没有移动到下一格：${table.active}`,
  );
  table = await command({
    type: 'key',
    row: 2,
    column: 2,
    key: 'Tab',
    wait: 320,
  });
  record('tab-append', {
    rowCount: table.rowCount,
    status: table.status,
  });
  assert(table.rowCount === 4, '末格 Tab 没有追加一行');
  table = await command({ type: 'undoRedo', action: 'undo' });
  assert(table.rowCount === 3, '撤销 Tab 追加行失败');

  table = await command({ type: 'key', row: 2, column: 2, key: 'Enter' });
  record('enter-append', {
    rowCount: table.rowCount,
    status: table.status,
  });
  assert(table.rowCount === 4, 'Enter 在末行没有追加一行');
  table = await command({ type: 'undoRedo', action: 'undo' });
  assert(table.rowCount === 3, '撤销 Enter 追加行失败');

  table = await command({
    type: 'selectRect',
    r0: 0,
    c0: 0,
    r1: 1,
    c1: 1,
  });
  const copied = await command({
    type: 'copySelection',
    row: 0,
    column: 0,
  });
  record('copy', {
    text: copied.text,
    htmlHasTable: copied.html.includes('<table'),
  });
  assert(
    copied.text.includes('\t') && copied.text.includes('\n'),
    `复制不是 TSV：${JSON.stringify(copied.text)}`,
  );

  table = await command({
    type: 'selectRect',
    r0: 2,
    c0: 2,
    r1: 2,
    c1: 2,
  });
  table = await command({
    type: 'pasteTsv',
    row: 2,
    column: 2,
    text: '甲\t乙\n丙\t丁',
  });
  record('paste', {
    rowCount: table.rowCount,
    columnCount: table.columnCount,
    status: table.status,
  });
  assert(table.rowCount >= 4, '粘贴 2×2 没有扩行');
  assert(table.columnCount >= 4, '粘贴 2×2 没有扩列');
  const pasted = cellValues(table);
  assert(pasted['第 3 行第 3 列'] === '甲', '粘贴起点内容不正确');
  assert(pasted['第 4 行第 4 列'] === '丁', '粘贴右下角内容不正确');

  table = await command({ type: 'dragWidth', delta: 36 });
  record('width-drag', { widths: table.widths, status: table.status });
  assert(
    table.widths[0] === '176px',
    `拖拽 +36px 后列宽不是 176px：${table.widths[0]}`,
  );

  const markdown = await command({ type: 'export', mode: 'markdown' });
  record('export-markdown', { text: markdown });
  assert(markdown.includes('| ---') || markdown.includes('| :--:'), 'Markdown 缺少对齐行');
  assert(markdown.includes(':--:'), 'Markdown 未保留表头居中对齐');
  assert(markdown.includes('<!-- 列宽: 176px'), 'Markdown 缺少列宽可读表示');

  const html = await command({ type: 'export', mode: 'html' });
  record('export-html', { html });
  assert(html.includes('<colgroup>'), 'HTML 导出缺少 colgroup');
  assert(html.includes('<thead>'), 'HTML 导出缺少 thead');
  assert(html.includes('width:176px'), 'HTML 导出缺少列宽');
  assert(html.includes('text-align:center'), 'HTML 导出缺少对齐');

  await command({ type: 'sleep', ms: 1800 });
  stored = await command({ type: 'stored' });
  const widths = stored.payload?.rows?.[0]?.[0]?.table?.widths;
  record('stored-widths', { widths });
  assert(Array.isArray(widths) && widths[0] === 176, '列宽没有写入 SQLite');

  await command({ type: 'openNote', title: LIMIT_TITLE });
  const limit = await command({ type: 'table' });
  record('limit-table', {
    rowCount: limit.rowCount,
    columnCount: limit.columnCount,
    toolbar: limit.toolbar.filter((item) => item.disabled),
  });
  assert(limit.rowCount === 40, `边界表行数不是 40：${limit.rowCount}`);
  assert(limit.columnCount === 16, `边界表列数不是 16：${limit.columnCount}`);
  const insertRowButton = limit.toolbar.find(
    (item) => item.label === '下方插入行',
  );
  const insertColumnButton = limit.toolbar.find(
    (item) => item.label === '右侧插入列',
  );
  assert(insertRowButton?.disabled, '40 行时插入行按钮未禁用');
  assert(
    insertRowButton?.title === '表格最多 40 行',
    `40 行禁用原因不正确：${insertRowButton?.title}`,
  );
  assert(insertColumnButton?.disabled, '16 列时插入列按钮未禁用');
  assert(
    insertColumnButton?.title === '表格最多 16 列',
    `16 列禁用原因不正确：${insertColumnButton?.title}`,
  );

  const errors = await command({ type: 'errors' });
  evidence.consoleErrors = errors;
  record('console-errors', errors);
  assert(errors.length === 0, `控制台/页面异常：${JSON.stringify(errors)}`);

  console.log('[zx-table-01] 结果：全部通过');
} catch (error) {
  evidence.failures.push(error.message || String(error));
  console.error(`[zx-table-01] 失败：${error.message || error}`);
  try {
    const errors = await command({ type: 'errors' }, 5000);
    evidence.consoleErrors = errors;
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
} finally {
  writeEvidence();
  await cleanup();
}
