/**
 * ZX-CODE-01 桌面验收：代码块语言选择 / 高亮 / 复制 / Markdown 导出。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`；
 *   * 本地静态服务注入只读探针，不替换产品 IPC、不注入假数据源；
 *   * 探针经产品 IPC 造一篇含代码块的笔记；
 *   * 走真实知识页：下拉 25 项、TypeScript 高亮、手输未知语言、别名归一化、
 *     Tab/Enter 缩进、换行/行号、阅读模式复制、真实「导出 Markdown」下载；
 *   * 每一步读回真实 SQLite payload 与 notes.body；
 *   * 收集 console.error / window.error / unhandledrejection。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-code-01-desktop.mjs
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
const PROBE = path.join(__dirname, 'zx-code-01/probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-code-01');
const HOME = '/tmp/zx-code-01-home';
const PORT = 5173;
const NOTE_TITLE = '代码手测';
const CODE_LINES = [
  'const a = 1;',
  'const b = 2;',
  'console.log(a + b);',
].join('\n');

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
  task: 'ZX-CODE-01',
  title: '代码块语言选择/高亮/复制（真实桌面手测）',
  steps: [],
  consoleErrors: [],
  appLog: '',
  failures: [],
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-code-01] ${name}: ${JSON.stringify(value)}`);
}

function assert(condition, message) {
  if (!condition) {
    evidence.failures.push(message);
    throw new Error(message);
  }
}

function parseRgb(value) {
  const parts = String(value).match(/[\d.]+/g);
  if (!parts || parts.length < 3) {
    throw new Error(`无法解析颜色：${value}`);
  }
  return parts.slice(0, 3).map(Number);
}

function luminance(rgb) {
  const channels = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  );
}

function contrast(foreground, background) {
  const [light, dark] = [
    luminance(parseRgb(foreground)),
    luminance(parseRgb(background)),
  ].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
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
    await command({ type: 'click', label: '开始 7 天试用', wait: 900 });
    env = await command({ type: 'env' });
    record('trial-started', { bodyText: env.bodyText.slice(0, 120) });
  }

  const seeded = await command({ type: 'seed' });
  record('seeded', seeded);
  assert(seeded.blocks === 1, `种子块不是 1 个：${seeded.blocks}`);

  await command({ type: 'gotoKnowledge' });
  await command({ type: 'openNote', title: NOTE_TITLE });

  let code = await command({ type: 'code' });
  record('initial', {
    readOnly: code.readOnly,
    language: code.language,
    badge: code.badge,
    tokenCount: code.tokenCount,
    fontFamily: code.fontFamily,
    code: code.code,
  });
  assert(code.exists, '代码块未渲染');
  assert(!code.readOnly, '初始不是编辑态');
  assert(code.language === '', `初始语言不是空：${code.language}`);
  assert(code.badge === '纯文本', `初始徽标不是纯文本：${code.badge}`);
  assert(
    code.code.includes('console.log(answer);'),
    '初始代码内容丢失',
  );
  assert(
    /mono|Menlo|Consolas|SFMono/i.test(code.fontFamily),
    `代码未使用等宽字体：${code.fontFamily}`,
  );

  code = await command({ type: 'openLanguageMenu' });
  record('language-menu', {
    count: code.menuOptions.length,
    first: code.menuOptions.slice(0, 4),
    last: code.menuOptions.slice(-3),
  });
  assert(
    code.menuOptions.length === 25,
    `语言下拉不是 25 项：${code.menuOptions.length}`,
  );

  code = await command({ type: 'setLanguage', option: 'TypeScript' });
  record('select-typescript', {
    language: code.language,
    badge: code.badge,
    tokenCount: code.tokenCount,
    tokenClasses: code.tokenClasses,
  });
  assert(code.language === 'typescript', '下拉未选中 typescript');
  assert(code.badge === 'TypeScript', `徽标不是 TypeScript：${code.badge}`);
  assert(
    code.tokenCount >= 3,
    `TypeScript 高亮 token 少于 3：${code.tokenCount}`,
  );

  code = await command({ type: 'setLanguage', value: 'zx-dsl' });
  record('unknown-language', {
    language: code.language,
    badge: code.badge,
    badgeTitle: code.badgeTitle,
    tokenCount: code.tokenCount,
    errors: code.errors,
  });
  assert(code.language === 'zx-dsl', '未知语言被丢弃');
  assert(
    code.badge === '未识别 · 纯文本',
    `未知语言徽标不正确：${code.badge}`,
  );
  assert(code.tokenCount === 0, '未知语言不应产生高亮 token');
  assert(code.errors.length === 0, `未知语言产生控制台错误：${code.errors}`);

  code = await command({ type: 'setLanguage', value: 'ts' });
  record('alias-normalized', {
    language: code.language,
    badge: code.badge,
  });
  assert(code.language === 'typescript', '别名 ts 未归一化为 typescript');

  code = await command({ type: 'setCode', value: 'if (ready) {' });
  assert(code.code === 'if (ready) {', '设置代码失败');
  code = await command({ type: 'pressKey', key: 'Enter' });
  record('enter-auto-indent', { code: code.code });
  assert(
    code.code === 'if (ready) {\n  ',
    `Enter 未自动缩进 2 空格：${JSON.stringify(code.code)}`,
  );

  code = await command({ type: 'setCode', value: CODE_LINES });
  code = await command({ type: 'pressKey', key: 'Tab' });
  record('tab-indent', { tail: code.code.slice(-8) });
  assert(
    code.code === `${CODE_LINES}  `,
    'Tab 未插入 2 空格缩进',
  );

  code = await command({ type: 'setCode', value: CODE_LINES });
  code = await command({ type: 'clickCodeButton', label: '换行' });
  record('wrap-off', {
    pressed: code.wrapPressed,
    gutter: code.gutter,
  });
  assert(code.wrapPressed === 'false', '换行开关未关闭');
  assert(code.gutter === 3, `关闭换行后行号不是 3：${code.gutter}`);

  code = await command({ type: 'clickCodeButton', label: '行号' });
  record('line-numbers-off', {
    pressed: code.lineNumbersPressed,
    gutter: code.gutter,
  });
  assert(code.lineNumbersPressed === 'false', '行号开关未关闭');
  assert(code.gutter === 0, '关闭行号后行号列仍在');

  await command({ type: 'sleep', ms: 1800 });
  let stored = await command({ type: 'stored' });
  record('stored', {
    language: stored.payload?.language,
    wrap: stored.payload?.wrap,
    lineNumbers: stored.payload?.lineNumbers,
    code: stored.payload?.code,
    body: stored.body.slice(0, 220),
  });
  assert(
    stored.payload?.language === 'typescript',
    '语言没有写入 SQLite payload',
  );
  assert(stored.payload?.wrap === false, '换行设置没有写入 payload');
  assert(
    stored.payload?.lineNumbers === false,
    '行号设置没有写入 payload',
  );
  assert(stored.payload?.code === CODE_LINES, '代码没有写入 payload');
  assert(
    stored.body.includes('data-language="typescript"'),
    'notes.body 缺少 data-language="typescript"',
  );
  assert(
    stored.body.includes('class="language-typescript"'),
    'notes.body 缺少 language-typescript',
  );

  for (const theme of ['light', 'dark']) {
    const appearance = await command({ type: 'setTheme', theme });
    const textRatio = contrast(appearance.text, appearance.background);
    const tokenRatio = contrast(appearance.token, appearance.background);
    record(`theme-${theme}`, {
      background: appearance.background,
      text: appearance.text,
      token: appearance.token,
      tokenText: appearance.tokenText,
      textRatio: Number(textRatio.toFixed(2)),
      tokenRatio: Number(tokenRatio.toFixed(2)),
    });
    assert(
      textRatio >= 4.5,
      `${theme} 主题代码正文对比度不足：${textRatio.toFixed(2)}`,
    );
    assert(
      tokenRatio >= 4.5,
      `${theme} 主题高亮 token 对比度不足：${tokenRatio.toFixed(2)}`,
    );
  }

  code = await command({ type: 'toggleReadingMode' });
  record('reading-mode', {
    readOnly: code.readOnly,
    preText: code.preText,
    tokenCount: code.tokenCount,
    badge: code.badge,
  });
  assert(code.readOnly, '没有进入阅读模式');
  assert(code.preText === CODE_LINES, '阅读态代码文本不完整');
  assert(
    code.tokenCount >= 3,
    `阅读态高亮 token 少于 3：${code.tokenCount}`,
  );

  const copied = await command({ type: 'copyCode' });
  record('copy', {
    method: copied.method,
    captured: copied.captured,
    label: copied.snapshot.copyLabel,
    status: copied.snapshot.copyStatus,
  });
  assert(copied.captured === CODE_LINES, '复制内容不是原始代码');
  assert(
    copied.snapshot.copyLabel === '已复制',
    `复制按钮没有反馈：${copied.snapshot.copyLabel}`,
  );
  assert(
    copied.snapshot.copyStatus === '已复制代码',
    `复制状态没有反馈：${copied.snapshot.copyStatus}`,
  );

  code = await command({ type: 'toggleReadingMode' });
  assert(!code.readOnly, '没有回到编辑模式');

  const markdown = await command({ type: 'exportMarkdown' });
  record('export-markdown', { markdown });
  assert(markdown.startsWith('# 代码手测'), '导出 Markdown 缺少标题');
  assert(
    markdown.includes('```typescript\nconst a = 1;'),
    '导出 Markdown 围栏语言/内容不一致',
  );
  assert(
    markdown.includes('console.log(a + b);\n```'),
    '导出 Markdown 代码围栏未闭合',
  );

  const finalErrors = await command({ type: 'errors' });
  evidence.consoleErrors = finalErrors;
  record('console-errors', finalErrors);
  assert(finalErrors.length === 0, `控制台存在错误：${finalErrors}`);

  console.log('[zx-code-01] PASS');
} catch (error) {
  evidence.failures.push(error.message || String(error));
  console.error('[zx-code-01] FAIL', error);
  process.exitCode = 1;
} finally {
  await cleanup();
  writeEvidence();
}
