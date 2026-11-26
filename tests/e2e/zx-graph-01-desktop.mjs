/**
 * ZX-GRAPH-01 桌面验收：笔记内链关系图（真实 Tauri WebView + SQLite）。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`；
 *   * 本地静态服务注入只读探针，不替换产品 IPC、不注入假数据源；
 *   * 探针经产品 IPC 造 5 篇笔记（外链 / 断链 / 回收站 / 孤立）；
 *   * 走真实知识页右侧「笔记链接 → 关系图」：
 *       - 有向边、节点标题、断链与孤立标注；
 *       - 一跳 / 两跳 / 全部筛选；
 *       - 放大、重置、拖拽平移；
 *       - 点击节点打开目标笔记；
 *       - 空图给出解释；
 *       - 1280 / 900 宽度下面板与画布可用；
 *   * 收集 console.error / window.error / unhandledrejection。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-graph-01-desktop.mjs
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
const PROBE = path.join(__dirname, 'zx-graph-01/probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-graph-01');
const HOME = '/tmp/zx-graph-01-home';
const PORT = 5173;
const ROOT_TITLE = '关系图来源';
const DEEP_TITLE = '二跳笔记';
const ISOLATED_TITLE = '孤立笔记';

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
  task: 'ZX-GRAPH-01',
  title: '笔记内链关系图（真实桌面手测）',
  steps: [],
  consoleErrors: [],
  appLog: '',
  failures: [],
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-graph-01] ${name}: ${JSON.stringify(value)}`);
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

function labels(snapshot) {
  return (snapshot?.nodes ?? []).map((node) => node.label);
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
  assert(seeded.notes === 5, `种子笔记不是 5 篇：${seeded.notes}`);

  await command({ type: 'gotoKnowledge' });
  await command({ type: 'openNote', title: ROOT_TITLE });
  await command({ type: 'openGraph' });
  await command({ type: 'sleep', ms: 300 });

  const initial = await command({ type: 'graph' });
  record('graph-initial', initial);
  assert(
    initial.stats.includes('2 篇笔记 · 1 条内链 · 2 条断链'),
    `默认一跳统计不正确：${initial.stats}`,
  );
  assert(
    labels(initial).some((label) => label.includes(ROOT_TITLE)) &&
      labels(initial).some((label) => label.includes('二跳来源')),
    `一跳节点缺少当前/直接邻居：${JSON.stringify(labels(initial))}`,
  );
  assert(
    !labels(initial).some((label) => label.includes(DEEP_TITLE)),
    '一跳图不应出现二跳笔记',
  );
  assert(
    labels(initial).some((label) => label.startsWith('断链：')),
    '断链节点未标注',
  );
  assert(
    labels(initial).some((label) => label.includes('回收站目标')),
    '回收站断链节点缺少标题',
  );
  const edge = initial.edges.find(
    (item) =>
      item.direction ===
      'zx-graph-01-root->zx-graph-01-mid',
  );
  assert(edge, `缺少有向边：${JSON.stringify(initial.edges)}`);
  assert(!edge.broken, '有效内链被标记为断链');
  assert(
    String(edge.marker).includes('url(#') && String(edge.marker).includes('arrow'),
    `边缺少箭头 marker：${edge.marker}`,
  );
  assert(
    !initial.edges.some((item) =>
      String(item.direction).includes('example.com'),
    ),
    '外部链接进入关系图',
  );
  assert(
    initial.scope.includes('跨应用不可跳转') &&
      initial.scope.includes('外部链接不进入关系图'),
    `内链范围说明缺失：${initial.scope}`,
  );

  const twoHop = await command({ type: 'setDepth', label: '两跳' });
  record('graph-two-hop', twoHop);
  assert(
    twoHop.stats.includes('3 篇笔记 · 2 条内链 · 2 条断链'),
    `两跳统计不正确：${twoHop.stats}`,
  );
  assert(
    labels(twoHop).some((label) => label.includes(DEEP_TITLE)),
    '两跳图缺少二跳笔记',
  );

  const all = await command({ type: 'setDepth', label: '全部' });
  record('graph-all', all);
  assert(
    all.stats.includes('4 篇笔记 · 2 条内链 · 2 条断链 · 1 个孤立'),
    `全部统计不正确：${all.stats}`,
  );
  assert(
    labels(all).some(
      (label) =>
        label.includes(ISOLATED_TITLE) && label.includes('孤立笔记'),
    ),
    '孤立笔记未标注',
  );

  const interaction = await command({ type: 'zoomAndPan' });
  record('zoom-pan', interaction);
  assert(
    interaction.beforeZoom === '1.00' && interaction.afterZoom === '1.25',
    `放大无效：${interaction.beforeZoom} -> ${interaction.afterZoom}`,
  );
  assert(interaction.panned, '拖拽平移未改变 transform');
  assert(
    interaction.afterReset === '1.00' &&
      interaction.resetTransform === 'translate(0 0) scale(1)',
    `重置无效：${interaction.afterReset} / ${interaction.resetTransform}`,
  );

  const opened = await command({
    type: 'openGraphNode',
    labelPart: DEEP_TITLE,
  });
  record('open-node', opened);
  assert(
    opened.matched && opened.openedTitle === DEEP_TITLE,
    `点击节点没有打开目标笔记：${opened.openedTitle}`,
  );

  const empty = await command({ type: 'emptyState', title: ISOLATED_TITLE });
  record('empty-graph', empty);
  assert(
    empty.stats.includes('1 篇笔记 · 0 条内链 · 1 个孤立'),
    `空图统计不正确：${empty.stats}`,
  );
  assert(
    empty.empty.includes('当前笔记还没有站内内链'),
    `空图缺少解释：${empty.empty}`,
  );

  // 1280 / 900 宽度：关系图面板与画布都必须有可点击面积。
  for (const [width, height] of [
    [1280, 900],
    [900, 900],
  ]) {
    const resized = await command({
      type: 'resize',
      width,
      height,
    });
    record(`resize-${width}`, resized);
    await command({ type: 'openNote', title: ROOT_TITLE });
    await command({ type: 'openGraph' });
    await command({ type: 'sleep', ms: 300 });
    const viewport = await command({ type: 'viewport' });
    record(`viewport-${width}`, viewport);
    if (resized.innerWidth === width) {
      assert(
        viewport.svgWidth > 240 && viewport.svgHeight > 240,
        `${width} 宽度下关系图画布不可用：${JSON.stringify(viewport)}`,
      );
      assert(
        viewport.panelWidth >= 300,
        `${width} 宽度下关系图面板过窄：${viewport.panelWidth}`,
      );
    } else {
      record('resize-unsupported', {
        requested: width,
        actual: resized.innerWidth,
      });
    }
  }

  const errors = await command({ type: 'errors' });
  evidence.consoleErrors = errors;
  record('console-errors', errors);
  assert(errors.length === 0, `控制台/页面异常：${JSON.stringify(errors)}`);

  console.log('[zx-graph-01] 结果：全部通过');
} catch (error) {
  evidence.failures.push(error.message || String(error));
  console.error(`[zx-graph-01] 失败：${error.message || error}`);
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
