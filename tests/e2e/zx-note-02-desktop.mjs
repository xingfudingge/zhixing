/**
 * ZX-NOTE-02 桌面验收：知识打字机模式重定义（长文手测）。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`（真实 WKWebView + SQLite）；
 *   * 本地静态服务注入只读探针，不替换产品 IPC、不注入假数据源；
 *   * 探针经产品 IPC 造 26 块长文（含标题/引用），再走真实知识页正文：
 *       - 页面无独立「打字机」按钮，工具轨 9 项；
 *       - 专注模式：周边隐藏、状态条（写作跟随/居中说明/退出）、
 *         非当前块 opacity .42、当前块整亮 + 左侧竖线、正文 ≤ 760px；
 *       - 写作跟随把点选块滚到视口约 36% 处（长文位移明显）；
 *       - 关闭写作跟随后只切高亮不滚动；Esc 退出后滚动位置保持；
 *       - ⌘⇧F 切换专注；输入/撤销/保存/阅读不受影响；
 *   * 收集 console.error / window.error / unhandledrejection。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-note-02-desktop.mjs
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
const PROBE = path.join(__dirname, 'zx-note-02/probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-note-02');
const HOME = '/tmp/zx-note-02-home';
const PORT = 5173;
const TITLE = 'ZX-NOTE-02 长文专注';
const RAIL_CAPTIONS = ['阅读', '专注', '样式', '链接', '大纲', '信息', '附件', '画板', '全屏'];

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
  task: 'ZX-NOTE-02',
  title: '知识打字机模式重定义（长文手测）',
  steps: [],
  consoleErrors: [],
  appLog: '',
  failures: [],
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-note-02] ${name}: ${JSON.stringify(value)}`);
}

function assert(condition, message) {
  if (!condition) {
    evidence.failures.push(message);
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// 静态服务 + 探针命令队列（与 zx-ux-09 相同的协议）
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
    bodyText: env.bodyText.slice(0, 120),
  });
  assert(env.isTauri, '不是真实 Tauri WebView');

  if (env.bodyText.includes('开始 7 天试用')) {
    await command({ type: 'clickText', text: '开始 7 天试用' });
    await command({ type: 'sleep', ms: 800 });
    env = await command({ type: 'env' });
    record('trial-started', { bodyText: env.bodyText.slice(0, 120) });
  }

  const seeded = await command({ type: 'seedLongNote' });
  record('seeded', seeded);
  assert(seeded.blocks === 26, `长文块数不是 26：${seeded.blocks}`);

  await command({ type: 'gotoKnowledge' });
  await command({ type: 'openNote', title: TITLE });
  await command({ type: 'sleep', ms: 500 });

  const snap0 = await command({ type: 'snapshot' });
  record('initial-snapshot', snap0);
  assert(
    snap0.bodyInnerHasTypewriter === false,
    'document.body.innerText 仍含「打字机」',
  );
  assert(
    snap0.typewriterButtons.length === 0,
    `仍存在打字机按钮：${JSON.stringify(snap0.typewriterButtons)}`,
  );
  assert(snap0.rail.items === 9, `工具轨不是 9 项：${JSON.stringify(snap0.rail)}`);
  assert(
    JSON.stringify(snap0.rail.captions) === JSON.stringify(RAIL_CAPTIONS),
    `工具轨短标签不符：${JSON.stringify(snap0.rail.captions)}`,
  );
  assert(snap0.blockCount === 26, `正文块数不是 26：${snap0.blockCount}`);

  let focus = await command({ type: 'enterFocus' });
  record('enter-focus', focus);
  assert(focus.dataFocus === 'true', 'data-focus 不是 true');
  assert(focus.workspaceFocus, 'kn-workspace 未进入 is-focus');
  assert(focus.treeDisplay === 'none', `目录树未隐藏：${focus.treeDisplay}`);
  assert(focus.barPresent, '专注状态条未出现');
  assert(
    focus.barText.includes('专注模式') &&
      focus.barText.includes('写作跟随') &&
      focus.barText.includes('Esc 退出'),
    `状态条文案不完整：${focus.barText}`,
  );
  assert(focus.activeOpacity === '1', `当前块不亮：${focus.activeOpacity}`);
  assert(
    Number(focus.otherOpacity) <= 0.5,
    `非当前块没有轻淡：${focus.otherOpacity}`,
  );
  assert(
    focus.activeLine && focus.activeLine.content !== 'none',
    `当前块左侧竖线缺失：${JSON.stringify(focus.activeLine)}`,
  );
  assert(
    focus.rowWidth <= 770,
    `正文宽度超过 760 上限：${focus.rowWidth}`,
  );
  if (focus.innerWidth >= 1000) {
    assert(
      focus.rowWidth >= 700,
      `窗口够宽但正文没有收到 760 居中：${focus.rowWidth}（innerWidth ${focus.innerWidth}）`,
    );
  }
  assert(
    Math.abs(focus.activeTopInBody ?? 999) <= 24,
    `进入专注后当前块未归位：${focus.activeTopInBody}`,
  );
  // 写作跟随是设备偏好：上一轮关掉后这次可能带进来（这正是持久化）。
  // 两种初始态都归一到「开启」再验证跟随滚动。
  if (focus.followChecked === false) {
    record('follow-preference-persisted-off', {
      note: '上一轮运行关闭的写作跟随跨会话保持（editor.focus.follow）',
    });
    focus = await command({ type: 'toggleFollow' });
    record('follow-on', {
      dataFollow: focus.dataFollow,
      barText: focus.barText,
    });
  }
  assert(focus.followChecked === true, '写作跟随默认未开启');
  assert(focus.dataFollow === 'true', 'data-writing-follow 不是 true');
  assert(
    focus.barText.includes('当前段落居中'),
    `状态条没有说明开启后的行为：${focus.barText}`,
  );

  // 取中段块：靠后的块会被文档尾部 clamp 到不了 36%。
  const followed = await command({ type: 'scrollByFollowing', index: 12 });
  record('follow-scroll', followed);
  assert(followed.isNowActive, '点选块没有变成当前块');
  assert(
    followed.ratio >= 0.3 && followed.ratio <= 0.42,
    `写作跟随没有把块放到 36% 处：${followed.ratio}`,
  );
  assert(
    followed.delta >= 150,
    `长文滚动位移不明显（看不出效果）：${followed.delta}`,
  );

  const off = await command({ type: 'toggleFollow' });
  record('follow-off', off);
  assert(off.dataFollow === 'false', 'data-writing-follow 不是 false');
  assert(off.followChecked === false, '写作跟随勾选框仍为选中');
  assert(
    off.barText.includes('只保留当前块高亮'),
    `状态条没有说明关闭后的行为：${off.barText}`,
  );

  // 关闭跟随后点视口内可见块：不居中、不滚动，只切高亮
  //（点视口外块时浏览器原生 focus 会最小滚动，那是 UA 行为不是写作跟随）。
  const noFollow = await command({ type: 'scrollByFollowing', index: 15 });
  record('no-follow-scroll', noFollow);
  assert(noFollow.isNowActive, '关闭跟随后当前块高亮没有切换');
  assert(
    Math.abs(noFollow.delta) <= 4,
    `关闭写作跟随后仍然滚动：${noFollow.delta}`,
  );

  const escaped = await command({ type: 'pressEsc' });
  record('esc-exit', escaped);
  assert(escaped.dataFocus === 'false', 'Esc 没有退出专注');
  assert(!escaped.workspaceFocus, 'Esc 后 kn-workspace 仍 is-focus');
  assert(escaped.treeDisplay !== 'none', 'Esc 后目录树未恢复');
  assert(!escaped.barPresent, 'Esc 后状态条仍存在');
  assert(
    Math.abs((escaped.scrollTop ?? 0) - (noFollow.scrollTopAfter ?? 0)) <= 4,
    `退出专注后滚动位置回跳：${escaped.scrollTop} vs ${noFollow.scrollTopAfter}`,
  );

  const shortcut = await command({ type: 'pressShortcut' });
  record('shortcut-toggle', shortcut);
  assert(shortcut.dataFocus === 'true', '⌘⇧F 没有进入专注');
  assert(shortcut.barPresent, '⌘⇧F 进入后状态条缺失');

  const typing = await command({ type: 'typingUndoSave' });
  record('typing-undo-save', typing);
  assert(typing.undoEnabled, '输入后撤销按钮未启用');
  assert(typing.undone, `⌘Z 未撤销输入：${typing.afterUndo}`);
  assert(
    typing.afterUndo === typing.before,
    `撤销后正文不正确：${JSON.stringify(typing.afterUndo)}`,
  );
  assert(
    (typing.saveLabel || '').includes('已保存到本机'),
    `保存状态异常：${typing.saveLabel}`,
  );

  const exitedFocus = await command({ type: 'exitViaButton' });
  record('exit-button', exitedFocus);
  assert(exitedFocus.dataFocus === 'false', '「退出」按钮没有退出专注');

  const reading = await command({ type: 'readingToggle' });
  record('reading-toggle', reading);
  assert(reading.read.readOnly === 'true', '阅读模式 data-read-only 不是 true');
  assert(
    reading.read.contentEditable === 'false',
    '阅读模式正文仍可编辑',
  );
  assert(reading.read.blockControls === 0, '阅读模式仍显示块控制');
  assert(
    reading.backToEdit.readOnly === 'false' &&
      reading.backToEdit.contentEditable === 'true',
    '返回编辑未恢复',
  );

  // 撤销后的残留 debounce 必须最终落库：保存状态要回到「已保存到本机」。
  const settled = await command({ type: 'waitSave', timeout: 10000 });
  record('save-settled', { saveLabel: settled });
  assert(
    settled.includes('已保存到本机'),
    `保存没有收敛：${settled}`,
  );

  // 写作跟随的关闭态要跨会话保持（editor.focus.follow）。
  await command({ type: 'reload' });
  await nextProbeReady(30_000);
  await sleep(1200);
  env = await command({ type: 'env' });
  if (env.bodyText.includes('开始 7 天试用')) {
    await command({ type: 'clickText', text: '开始 7 天试用' });
    await command({ type: 'sleep', ms: 800 });
  }
  await command({ type: 'gotoKnowledge' });
  await command({ type: 'openNote', title: TITLE });
  await command({ type: 'sleep', ms: 400 });
  const persisted = await command({ type: 'enterFocus' });
  record('follow-persisted', {
    dataFollow: persisted.dataFollow,
    followChecked: persisted.followChecked,
    barText: persisted.barText,
    firstBlockText: persisted.firstBlockText,
  });
  assert(
    persisted.followChecked === false && persisted.dataFollow === 'false',
    `写作跟随关闭态没有跨会话保持：${JSON.stringify(persisted)}`,
  );
  assert(
    persisted.barText.includes('只保留当前块高亮'),
    `重开后状态条未反映跟随关闭：${persisted.barText}`,
  );
  assert(
    !persisted.firstBlockText.includes('审'),
    `重开后已撤销的输入又出现：${persisted.firstBlockText}`,
  );
  await command({ type: 'exitViaButton' });

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
  console.log(`[zx-note-02] evidence: ${target}`);
  if (evidence.failures.length > 0) {
    console.error(`[zx-note-02] FAILED: ${evidence.failures.length} 项`);
    process.exitCode = 1;
  } else {
    console.log('[zx-note-02] PASS');
  }
}
