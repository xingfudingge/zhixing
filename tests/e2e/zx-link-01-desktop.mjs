/**
 * ZX-LINK-01 / ZX-LINK-03 桌面验收：链接块真实链接卡片（真实 Tauri WebView + SQLite）。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`；
 *   * 本地静态服务注入只读探针，不替换产品 IPC、不注入假数据源；
 *   * 探针经产品 IPC 造 5 块笔记 + 目标笔记；
 *   * 走真实知识页正文：
 *       - 外链卡显示标题 / 域名 / 打开按钮，不抓取 favicon；
 *       - 内链卡显示目标笔记标题与「站内笔记」；
 *       - 危险协议显示原始 URL 与原因，不可点；
 *       - 编辑弹层可改标题 / 地址，并拒绝 javascript: 与不存在内链；
 *       - 编辑态单击外链/内链标题直接打开，不弹编辑框；
 *       - 显式「编辑 / 修复」按钮打开弹层；失效内链可复制、无打开动作；
 *       - 内链打开目标笔记，来源标签保留可返回；
 *   * 收集 console.error / window.error / unhandledrejection。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-link-01-desktop.mjs
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
const PROBE = path.join(__dirname, 'zx-link-01/probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-link-01');
const HOME = '/tmp/zx-link-01-home';
const PORT = 5173;
const TITLE = 'ZX-LINK-01 链接块';
const TARGET_TITLE = '任务与笔记的关系是一等数据';
const EXTERNAL_URL = 'https://www.feishu.cn/doc/abc';

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
  task: 'ZX-LINK-01',
  title: '链接块真实链接卡片（真实桌面手测）',
  steps: [],
  consoleErrors: [],
  appLog: '',
  failures: [],
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-link-01] ${name}: ${JSON.stringify(value)}`);
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
  assert(seeded.blocks === 5, `种子块数不是 5：${seeded.blocks}`);

  await command({ type: 'gotoKnowledge' });
  await command({ type: 'openNote', title: TITLE });
  await command({ type: 'sleep', ms: 500 });

  const initial = await command({ type: 'initialState' });
  record('initial-state', initial);
  // 5 个种子块 + 编辑器在末尾补的空段落。
  assert(initial.blockCount === 6, `正文块数不是 6：${initial.blockCount}`);
  assert(initial.linkCards === 4, `链接卡不是 4 张：${initial.linkCards}`);
  assert(initial.imgs === 0, `链接卡出现图片/favicon：${initial.imgs}`);
  assert(
    initial.external.kind === 'external' &&
      initial.external.invalid === 'false' &&
      initial.external.title === '飞书画板 · 单人创作指南' &&
      initial.external.meta === 'www.feishu.cn' &&
      initial.external.titleTag === 'button' &&
      initial.external.openTag === 'button' &&
      initial.external.openHref === null &&
      initial.external.openTarget === null &&
      initial.external.rawUrls.length === 0,
    `外链卡不正确：${JSON.stringify(initial.external)}`,
  );
  assert(
    initial.internal.kind === 'note' &&
      initial.internal.invalid === 'false' &&
      initial.internal.title === TARGET_TITLE &&
      initial.internal.meta === '站内笔记' &&
      initial.internal.openTag === 'button' &&
      String(initial.internal.openLabel).includes('打开笔记'),
    `内链卡不正确：${JSON.stringify(initial.internal)}`,
  );
  assert(
    initial.invalid.kind === 'invalid' &&
      initial.invalid.invalid === 'true' &&
      initial.invalid.title === '危险链接' &&
      initial.invalid.titleTag === 'button' &&
      initial.invalid.meta.includes('javascript:alert(1)') &&
      initial.invalid.meta.includes(
        '仅支持 http / https / mailto 或站内笔记内链',
      ) &&
      initial.invalid.openTag === null &&
      initial.invalid.rawUrls.length === 0,
    `危险协议卡不正确：${JSON.stringify(initial.invalid)}`,
  );
  assert(
    initial.missing.kind === 'note' &&
      initial.missing.invalid === 'true' &&
      initial.missing.meta === '笔记不存在或已删除' &&
      initial.missing.openTag === null,
    `失效内链卡不正确：${JSON.stringify(initial.missing)}`,
  );

  const anchor = await command({ type: 'externalAnchor' });
  record('external-anchor', anchor);
  assert(
    anchor.tag === 'button' &&
      anchor.href === null &&
      anchor.target === null &&
      anchor.titleTag === 'button' &&
      String(anchor.titleTitle).startsWith('打开链接'),
    `外链标题/打开入口没有统一走打开服务：${JSON.stringify(anchor)}`,
  );

  const edited = await command({ type: 'editValidation' });
  record('edit-validation', {
    error: edited.error,
    targetHint: edited.targetHint,
    closed: edited.closed,
    afterBad: edited.afterBad,
    afterGood: edited.afterGood,
  });
  assert(
    edited.error.includes('仅支持 http / https / mailto 或站内笔记内链'),
    `javascript: 未被拦截：${edited.error}`,
  );
  assert(
    edited.afterBad.kind === 'external' &&
      edited.afterBad.title === '飞书画板 · 单人创作指南' &&
      edited.afterBad.openTag === 'button' &&
      edited.afterBad.openHref === null,
    `校验失败后卡片被改写：${JSON.stringify(edited.afterBad)}`,
  );
  assert(
    edited.targetHint.includes(`目标笔记：${TARGET_TITLE}`),
    `编辑弹层未显示目标笔记：${edited.targetHint}`,
  );
  assert(edited.closed, '保存后编辑弹层未关闭');
  assert(
    edited.afterGood.kind === 'note' &&
      edited.afterGood.invalid === 'false' &&
      edited.afterGood.title === '飞书画板' &&
      edited.afterGood.meta === `站内笔记 · ${TARGET_TITLE}` &&
      edited.afterGood.openTag === 'button' &&
      String(edited.afterGood.openLabel).includes('打开笔记'),
    `保存后没有变成内链卡：${JSON.stringify(edited.afterGood)}`,
  );

  const titleOpen = await command({ type: 'editTitleOpensTarget' });
  record('edit-title-opens-target', titleOpen);
  assert(
    titleOpen.navigated && !titleOpen.dialogBefore && !titleOpen.dialogAfter,
    `编辑态单击内链标题没有直接跳转或误开弹层：${JSON.stringify(
      titleOpen,
    )}`,
  );
  assert(titleOpen.returned, '从目标笔记返回来源笔记失败');

  const navigated = await command({ type: 'openInternalAndReturn' });
  record('open-internal-and-return', navigated);
  assert(navigated.openedTarget, '点击内链卡没有打开目标笔记');
  assert(
    navigated.tabs.some((tab) => tab.includes(TITLE)),
    `来源标签未保留：${JSON.stringify(navigated.tabs)}`,
  );
  assert(navigated.returned, '从目标笔记返回来源笔记失败');
  assert(navigated.cardBack, '返回后链接卡消失');

  const missing = await command({ type: 'missingOpenDisabled' });
  record('missing-link-disabled', missing);
  assert(
    missing.meta.includes('笔记不存在或已删除') &&
      missing.hasOpen === false &&
      missing.hasRepair === true &&
      missing.hasCopy === true,
    `失效内链仍可打开或缺修复/复制入口：${JSON.stringify(missing)}`,
  );

  const errors = await command({ type: 'errors' });
  evidence.consoleErrors = errors;
  record('console-errors', errors);
  assert(errors.length === 0, `控制台/页面异常：${JSON.stringify(errors)}`);

  console.log('[zx-link-01] 结果：全部通过');
} catch (error) {
  evidence.failures.push(error.message || String(error));
  console.error(`[zx-link-01] 失败：${error.message || error}`);
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
