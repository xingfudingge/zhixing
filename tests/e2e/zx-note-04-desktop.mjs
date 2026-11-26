/**
 * ZX-NOTE-04 桌面验收：引用块出处与来源（真实 Tauri WebView + SQLite）。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`；
 *   * 本地静态服务注入只读探针，不替换产品 IPC、不注入假数据源；
 *   * 探针经产品 IPC 造 4 块笔记 + 目标笔记 + 待删除笔记；
 *   * 走真实知识页正文：
 *       - 引用块显示出处 / 关联笔记 / 外链来源；
 *       - 出处弹层拦截 javascript: 与 121 字出处；
 *       - 保存只改引用 payload，相邻段落不变；
 *       - 关联笔记删除后 chip 禁用，保存清除关联；
 *       - 点关联笔记 chip 打开目标笔记，返回后引用仍在；
 *       - 导出 Markdown 保留引用正文与相邻段落；
 *   * 收集 console.error / window.error / unhandledrejection。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-note-04-desktop.mjs
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
const PROBE = path.join(__dirname, 'zx-note-04/probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-note-04');
const HOME = '/tmp/zx-note-04-home';
const PORT = 5173;
const TITLE = 'ZX-NOTE-04 引用块增强';

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
  task: 'ZX-NOTE-04',
  title: '引用块出处与来源（真实桌面手测）',
  steps: [],
  consoleErrors: [],
  appLog: '',
  failures: [],
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-note-04] ${name}: ${JSON.stringify(value)}`);
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
  assert(seeded.blocks === 4, `种子块数不是 4：${seeded.blocks}`);

  await command({ type: 'gotoKnowledge' });
  await command({ type: 'openNote', title: TITLE });
  await command({ type: 'sleep', ms: 500 });

  const initial = await command({ type: 'initialState' });
  record('initial-state', initial);
  assert(initial.rows.length === 4, `正文块数不是 4：${initial.rows.length}`);
  assert(
    initial.quote.text.includes('任务与笔记的关系是一等数据。'),
    `引用正文缺失：${initial.quote.text}`,
  );
  assert(
    initial.quote.sourceText.includes('— 《任务与知识融合设计》评审记录'),
    `出处未显示：${initial.quote.sourceText}`,
  );
  assert(
    initial.quote.noteText.includes('⌁ 任务与笔记的关系是一等数据'),
    `关联笔记 chip 未显示：${initial.quote.noteText}`,
  );
  assert(
    initial.quote.urlHref === 'https://example.com/source',
    `外链来源 href 不正确：${initial.quote.urlHref}`,
  );
  assert(
    initial.missingQuote.noteText.includes('关联笔记已删除') &&
      initial.missingQuote.noteDisabled === 'true',
    `删除笔记的引用未进入失效态：${JSON.stringify(initial.missingQuote)}`,
  );

  // 1. 校验：javascript: 与 121 字出处 -------------------------------------
  const invalid = await command({ type: 'invalidValidation' });
  record('invalid-validation', {
    dangerous: invalid.dangerous.snapshot,
    tooLong: invalid.tooLong.snapshot,
    closed: invalid.closed,
  });
  assert(
    invalid.dangerous.open &&
      invalid.dangerous.snapshot.error.includes(
        '仅支持 http / https / mailto 或站内笔记内链',
      ),
    `javascript: 未被拦截：${JSON.stringify(invalid.dangerous)}`,
  );
  assert(
    invalid.tooLong.open &&
      invalid.tooLong.snapshot.error.includes('出处最多 120 字（当前 121 字）'),
    `121 字出处未被拦截：${JSON.stringify(invalid.tooLong)}`,
  );
  assert(invalid.closed, '取消后弹层未关闭');

  // 2. 编辑出处与来源 ------------------------------------------------------
  const edited = await command({ type: 'editSource' });
  record('edit-source', {
    before: edited.before,
    filled: edited.filled,
    saved: edited.saved,
    quote: edited.quote,
    payload: edited.payload,
  });
  assert(
    edited.filled.source === '《卡片笔记写作法》第 6 章' &&
      edited.filled.url === 'https://example.com/book',
    '弹层字段未按输入更新',
  );
  assert(
    !edited.saved.open &&
      edited.quote.sourceText.includes('— 《卡片笔记写作法》第 6 章'),
    `保存后出处未即时更新：${JSON.stringify(edited.quote)}`,
  );
  assert(
    edited.quote.noteText.includes('⌁ 任务与笔记的关系是一等数据'),
    `保存出处后关联笔记丢失：${edited.quote.noteText}`,
  );
  assert(
    edited.quote.urlHref === 'https://example.com/book',
    `保存后来源链接不正确：${edited.quote.urlHref}`,
  );
  assert(
    edited.payload &&
      edited.payload.source === '《卡片笔记写作法》第 6 章' &&
      edited.payload.noteId === seeded.targetId &&
      edited.payload.sourceUrl === 'https://example.com/book',
    `SQLite 中引用 payload 不正确：${JSON.stringify(edited.payload)}`,
  );
  assert(
    JSON.stringify(edited.beforePayload) ===
      JSON.stringify({ runs: [{ text: '前一段：引用增强不应影响我。' }] }) &&
      JSON.stringify(edited.afterPayload) ===
        JSON.stringify({ runs: [{ text: '后一段：导出必须保留我。' }] }),
    '引用编辑影响了相邻段落',
  );

  // 3. 点关联笔记 chip，返回后引用仍在 ------------------------------------
  const navigated = await command({ type: 'openTargetFromQuote' });
  record('open-target-and-return', navigated);
  assert(navigated.openTarget, '关联笔记 chip 没有打开目标笔记');
  assert(navigated.returned, '返回主笔记后引用块消失');
  assert(
    navigated.quote.sourceText.includes('《卡片笔记写作法》第 6 章'),
    `返回后出处丢失：${navigated.quote.sourceText}`,
  );

  // 4. 目标笔记删除后的失效态与清除 --------------------------------------
  const cleared = await command({ type: 'clearMissingNote' });
  record('clear-missing-note', {
    before: cleared.before,
    dialog: cleared.dialog,
    saved: cleared.saved,
    after: cleared.after,
    payload: cleared.payload,
  });
  assert(
    cleared.before.noteDisabled === 'true' &&
      cleared.before.noteText.includes('关联笔记已删除'),
    `失效 chip 状态不正确：${JSON.stringify(cleared.before)}`,
  );
  assert(
    cleared.dialog.warning.includes('保存后会清除该关联'),
    `弹层未提示保存会清除关联：${cleared.dialog.warning}`,
  );
  assert(
    !cleared.saved.open && !cleared.after.noteText,
    `保存后失效关联未清除：${JSON.stringify(cleared.after)}`,
  );
  assert(
    cleared.after.text.includes('这条引用指向即将删除的笔记。') &&
      cleared.payload.source === '待删除关联' &&
      cleared.payload.noteId === '',
    `清除失效关联时误改正文/出处：${JSON.stringify(cleared.payload)}`,
  );

  // 5. 导出 Markdown -------------------------------------------------------
  const exported = await command({ type: 'exportMarkdown' }, 60_000);
  record('export-markdown', {
    blobCaptured: exported.blobCaptured,
    downloadName: exported.downloadName,
    toast: exported.toast,
    textLength: exported.text.length,
    head: exported.text.slice(0, 400),
  });
  assert(exported.blobCaptured, '导出没有生成 Blob');
  assert(
    exported.downloadName.includes('ZX-NOTE-04 引用块增强'),
    `导出文件名不正确：${exported.downloadName}`,
  );
  assert(
    exported.text.includes('> 任务与笔记的关系是一等数据。'),
    `导出缺少引用块正文：${exported.text.slice(0, 400)}`,
  );
  assert(
    exported.text.includes('前一段：引用增强不应影响我。') &&
      exported.text.includes('后一段：导出必须保留我。'),
    `导出缺少引用相邻段落：${exported.text.slice(0, 400)}`,
  );
  assert(
    !exported.text.includes('javascript:'),
    '导出文本包含危险协议',
  );

  const errors = await command({ type: 'errors' });
  evidence.consoleErrors = errors;
  record('console-errors', errors);
  assert(errors.length === 0, `控制台/页面异常：${JSON.stringify(errors)}`);

  console.log('[zx-note-04] 结果：全部通过');
} catch (error) {
  evidence.failures.push(error.message || String(error));
  console.error(`[zx-note-04] 失败：${error.message || error}`);
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
