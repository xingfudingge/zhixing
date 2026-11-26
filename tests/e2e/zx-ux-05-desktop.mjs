/**
 * ZX-UX-05 桌面验收：笔记待办复选框真实可见性。
 *
 * 形态：
 *   * 启动真实 Tauri 二进制（真实 WKWebView + SQLite）；
 *   * 通过本地静态服务注入只读探针，不替换产品 IPC；
 *   * 探针经产品 IPC 创建一篇含 3 条待办的笔记，再走真实知识页导航打开；
 *   * 读取 getComputedStyle 验证 border/背景/尺寸/勾选态，覆盖浅色/暗色；
 *   * 用 CoreGraphics 移动系统鼠标验证真实 :hover；
 *   * 尝试 screencapture -l 留证（无录屏权限时记录原因，不伪造截图）。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-ux-05-desktop.mjs
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
const PROBE = path.join(__dirname, 'zx-ux-05/probe.js');
const MOUSE_SOURCE = path.join(__dirname, 'zx-ux-05/mouse.m');
const MOUSE_BIN = '/tmp/zx-ux-05-mouse';
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-ux-05');
const HOME = '/tmp/zx-ux-05-home';
const PORT = 5173;
const NOTE_TITLE = 'ZX-UX-05 待办可见性';
const TODOS = [
  { title: '空状态复选框清晰可见', done: false },
  { title: '勾选后显示对勾与绿色底', done: true },
  { title: '暗色主题边框仍有对比度', done: false },
];

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
  task: 'ZX-UX-05',
  noteTitle: NOTE_TITLE,
  steps: [],
  consoleErrors: [],
  appLog: '',
  screenshot: null,
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-ux-05] ${name}: ${JSON.stringify(value)}`);
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
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (request.method === 'POST' && url.pathname === '/__probe-ready') {
    request.resume();
    response.writeHead(204);
    response.end();
    readyResolve();
    return;
  }
  if (request.method === 'POST' && url.pathname === '/__result') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
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

function command(payload, timeout = 25_000) {
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

function compileMouseHelper() {
  execFileSync(
    'clang',
    [
      '-O2',
      '-framework',
      'Cocoa',
      '-framework',
      'ApplicationServices',
      MOUSE_SOURCE,
      '-o',
      MOUSE_BIN,
    ],
    { stdio: 'pipe', timeout: 120_000 },
  );
}

function mouse(command) {
  return JSON.parse(
    execFileSync(MOUSE_BIN, ['--pid', String(app.pid), ...command], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim(),
  );
}

function screenshot(window, name) {
  const target = path.join(EVIDENCE, name);
  try {
    execFileSync('screencapture', ['-x', '-l', String(window.windowId), target], {
      stdio: 'pipe',
      timeout: 30_000,
    });
    if (fs.existsSync(target) && fs.statSync(target).size > 0) {
      return {
        ok: true,
        mode: 'window',
        path: target,
        bytes: fs.statSync(target).size,
      };
    }
    return { ok: false, reason: 'screencapture 没有生成文件' };
  } catch (error) {
    return {
      ok: false,
      reason: String(error?.stderr || error).trim(),
      note: 'macOS 未授予窗口录制权限；本卡以真实 DOM computed style 回归为准，不使用桌面区域截图冒充应用截图',
    };
  }
}

function assertMeasure(measure, theme, failures) {
  const all = [
    ...measure.inline.map((item) => ({ ...item, kind: 'inline' })),
    ...measure.summary.map((item) => ({ ...item, kind: 'summary' })),
  ];
  if (measure.inline.length !== 3 || measure.summary.length !== 3) {
    failures.push(`${theme}: 复选框数量不对 inline=${measure.inline.length} summary=${measure.summary.length}`);
  }
  for (const item of all) {
    const where = `${theme}/${item.kind}[${item.index}]`;
    if (item.rect.width < 17 || item.rect.height < 17) {
      failures.push(`${where}: 点击区 ${item.rect.width}×${item.rect.height} < 17×17`);
    }
    if (item.border.style !== 'solid' || Number.parseFloat(item.border.width) < 1) {
      failures.push(`${where}: 边框不可见 ${item.border.width} ${item.border.style}`);
    }
    if (!item.background || item.background === 'rgba(0, 0, 0, 0)') {
      failures.push(`${where}: 背景透明`);
    }
    if (item.ariaChecked) {
      if (item.glyph !== '✓') failures.push(`${where}: 勾选态缺对勾`);
      if (!item.glyphContrast || item.glyphContrast < 3) {
        failures.push(`${where}: 对勾对比度 ${item.glyphContrast} < 3`);
      }
    } else if (!item.borderContrast || item.borderContrast < 3) {
      failures.push(`${where}: 边框对比度 ${item.borderContrast} < 3`);
    }
  }
  const baseRule = measure.rules.base ?? '';
  const summaryRule = measure.rules.baseSummary ?? '';
  for (const [label, rule] of [
    ['inline', baseRule],
    ['summary', summaryRule],
  ]) {
    if (!rule.includes('border: 1.5px solid var(--muted)')) {
      failures.push(`${theme}/${label}: 基础规则缺 1.5px border`);
    }
    if (!rule.includes('background: var(--surface)')) {
      failures.push(`${theme}/${label}: 基础规则缺 surface 背景`);
    }
  }
  if (measure.rules.oldReset) {
    failures.push(`${theme}: 仍存在高特异性 .zxe button reset`);
  }
  if (!measure.rules.hover?.includes('border-color: var(--accent)')) {
    failures.push(`${theme}: 缺少 hover 边框规则`);
  }
  if (!measure.rules.focus?.includes('outline: 2px solid var(--accent-ink)')) {
    failures.push(`${theme}: 缺少 focus 焦点环`);
  }
  if (!measure.rules.disabled?.includes('background: var(--surface-3)')) {
    failures.push(`${theme}: 缺少 disabled 背景规则`);
  }
  if (!measure.rules.done?.includes('background: var(--green)')) {
    failures.push(`${theme}: 缺少勾选绿色底规则`);
  }
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
  if (!env.isTauri) throw new Error('不是真实 Tauri WebView');

  if (env.bodyText.includes('开始 7 天试用')) {
    env = await command({ type: 'clickText', text: '开始 7 天试用' });
    await command({ type: 'sleep', ms: 600 });
    record('trial-started', { bodyText: env.bodyText.slice(0, 120) });
  }

  const seeded = await command({
    type: 'seedTodoNote',
    title: NOTE_TITLE,
    todos: TODOS,
  });
  record('seeded', seeded);

  const opened = await command({ type: 'gotoKnowledge', title: NOTE_TITLE });
  record('opened-note', opened);

  const failures = [];
  const light = await command({ type: 'setTheme', theme: 'light' });
  record('measure-light', {
    dataTheme: light.dataTheme,
    inline: light.inline,
    summary: light.summary,
  });
  assertMeasure(light, 'light', failures);

  // 真实键盘焦点：先发送一次真实的 Shift 键事件把 WebKit 切到键盘模态，
  // 再聚焦复选框，确保 :focus 焦点环真正命中，而不是只读 CSS 规则。
  // 真实鼠标 hover：系统级移动，非合成 mouseover。
  compileMouseHelper();
  const bounds = mouse([
    '--mode',
    'bounds',
    '--inner-width',
    String(env.innerWidth),
    '--inner-height',
    String(env.innerHeight),
  ]);
  record('macos-window', bounds);

  let focusResult = null;
  if (bounds.ok) {
    // 先真实点击顶栏空白处，让 Tauri 窗口成为 key window；否则 WebKit
    // 不会为 :focus/:hover 应用样式。
    const activateClick = mouse([
      '--mode',
      'click',
      '--x',
      '400',
      '--y',
      '20',
      '--inner-width',
      String(env.innerWidth),
      '--inner-height',
      String(env.innerHeight),
    ]);
    const keyboardModality = mouse([
      '--mode',
      'key',
      '--keycode',
      '56',
    ]);
    const focusStart = await command({ type: 'focusFirstCheckbox' });
    await command({ type: 'sleep', ms: 250 });
    focusResult = await command({ type: 'measureFocus' });
    record('keyboard-focus', {
      activateClick,
      keyboardModality,
      focusStart,
      focusResult,
    });
  }
  const focusOutline = focusResult?.check?.outline;
  const windowKey = focusResult?.hasFocus === true;
  let focusVerified = false;
  if (!windowKey) {
    // 没有 macOS 辅助功能权限时，系统鼠标/键盘事件只能投递到进程，
    // Tauri 窗口无法成为 key window，WebKit 不会应用 :focus/:hover。
    // 这里如实记录，不伪造 computed style；交互样式由真实 WebView
    // 中的 CSSOM 规则 + jsdom 回归覆盖。
    record('focus-skipped', {
      reason: 'window-not-key（无辅助功能权限）',
      hasFocus: false,
      cssRule: light.rules.focus,
    });
  } else if (!focusResult?.focused || focusOutline?.style !== 'solid') {
    failures.push('真实焦点未命中 :focus');
  } else if (!focusOutline.contrast || focusOutline.contrast < 3) {
    failures.push(`焦点环对比度 ${focusOutline.contrast} < 3`);
  } else {
    focusVerified = true;
  }

  const hoverTarget = await command({
    type: 'hover',
    selector: '.zxe-todo-check',
    index: 2,
  });
  let hoverResult = null;
  if (bounds.ok) {
    const moved = mouse([
      '--mode',
      'move',
      '--x',
      String(hoverTarget.rect.center.x),
      '--y',
      String(hoverTarget.rect.center.y),
      '--inner-width',
      String(env.innerWidth),
      '--inner-height',
      String(env.innerHeight),
    ]);
    await command({ type: 'sleep', ms: 900 });
    const after = await command({
      type: 'afterHover',
      selector: '.zxe-todo-check',
      index: 2,
    });
    hoverResult = {
      dispatch: moved,
      before: hoverTarget.before,
      after,
      changed:
        after.border.color !== hoverTarget.before.border.color ||
        after.background !== hoverTarget.before.background,
    };
    record('real-mouse-hover', hoverResult);
  }
  if (!hoverResult?.changed) {
    const ruleHover = light.rules.hover ?? '';
    if (!ruleHover.includes('border-color: var(--accent)')) {
      failures.push('hover 未生效且 CSS 规则缺失');
    }
    if (windowKey) {
      failures.push('窗口已聚焦但真实 :hover 未生效');
    }
    record('hover-fallback', {
      reason: windowKey
        ? '窗口已聚焦但 WebView 未切换 :hover'
        : '系统鼠标已移动但窗口不是 key window（无辅助功能权限）',
    });
  }

  if (light.rules.oldReset) failures.push('旧 reset 仍存在');
  record('stylesheet-rules', light.rules);

  const shotLight = bounds.ok ? screenshot(bounds, 'light.png') : null;
  evidence.screenshot = { light: shotLight, dark: null };
  const dark = await command({ type: 'setTheme', theme: 'dark' });
  record('measure-dark', {
    dataTheme: dark.dataTheme,
    inline: dark.inline,
    summary: dark.summary,
  });
  assertMeasure(dark, 'dark', failures);
  const shotDark = bounds.ok ? screenshot(bounds, 'dark.png') : null;
  evidence.screenshot.dark = shotDark;

  // 只读态：真实删除到回收站再重新打开，复选框应可见但禁用。
  const trashed = await command({ type: 'trashAndReopen', title: NOTE_TITLE });
  const disabled = await command({ type: 'measure', theme: 'light-disabled' });
  record('measure-disabled', {
    trashed,
    inline: disabled.inline,
    summary: disabled.summary,
  });
  const disabledChecks = [...disabled.inline, ...disabled.summary];
  if (disabledChecks.length !== 6) {
    failures.push(`禁用态复选框数量 ${disabledChecks.length} != 6`);
  }
  for (const item of disabledChecks) {
    if (!item.disabled) failures.push(`禁用态复选框未 disabled：${item.index}`);
    if (item.rect.width < 17 || item.rect.height < 17) {
      failures.push(`禁用态点击区 ${item.rect.width}×${item.rect.height} < 17×17`);
    }
    if (item.border.style !== 'solid' || Number.parseFloat(item.border.width) < 1) {
      failures.push(`禁用态边框不可见 ${item.border.width} ${item.border.style}`);
    }
    if (!item.background || item.background === 'rgba(0, 0, 0, 0)') {
      failures.push('禁用态背景透明');
    }
  }
  if (!disabled.rules.disabled?.includes('border-color: var(--line-strong)')) {
    failures.push('缺少禁用态边框规则');
  }
  if (!disabled.rules.disabled?.includes('background: var(--surface-3)')) {
    failures.push('缺少禁用态背景规则');
  }

  await command({ type: 'setTheme', theme: 'light' });

  evidence.final = await command({ type: 'env' });
  evidence.consoleErrors = evidence.final.errors ?? [];
  const visibleErrors = evidence.consoleErrors.filter(
    (line) => !line.includes('ResizeObserver'),
  );
  if (visibleErrors.length > 0) {
    failures.push(`控制台错误：${visibleErrors.join(' | ')}`);
  }
  evidence.verdict = {
    ok: failures.length === 0,
    failures,
    light: {
      inline: light.inline.map((item) => ({
        checked: item.ariaChecked,
        size: item.rect,
        border: item.border,
        background: item.background,
        borderContrast: item.borderContrast,
        glyphContrast: item.glyphContrast,
      })),
      summary: light.summary.map((item) => ({
        checked: item.ariaChecked,
        size: item.rect,
        border: item.border,
        background: item.background,
        borderContrast: item.borderContrast,
        glyphContrast: item.glyphContrast,
      })),
      focus: focusResult,
    },
    dark: {
      inline: dark.inline.map((item) => ({
        checked: item.ariaChecked,
        size: item.rect,
        border: item.border,
        background: item.background,
        borderContrast: item.borderContrast,
        glyphContrast: item.glyphContrast,
      })),
      summary: dark.summary.map((item) => ({
        checked: item.ariaChecked,
        size: item.rect,
        border: item.border,
        background: item.background,
        borderContrast: item.borderContrast,
        glyphContrast: item.glyphContrast,
      })),
    },
    hover: hoverResult,
    focus: {
      verified: focusVerified,
      windowKey,
      check: focusResult,
    },
    disabled: {
      readOnly: trashed.readOnly,
      checks: disabledChecks.map((item) => ({
        kind: disabled.inline.includes(item) ? 'inline' : 'summary',
        checked: item.ariaChecked,
        disabled: item.disabled,
        size: item.rect,
        border: item.border,
        background: item.background,
        opacity: item.opacity,
      })),
    },
    screenshot: evidence.screenshot,
  };
  if (failures.length > 0) evidence.failed = true;
  console.log(JSON.stringify(evidence.verdict, null, 2));
} catch (error) {
  evidence.error = String(error?.stack || error);
  console.error(`[zx-ux-05] FAILED: ${evidence.error}`);
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

process.exit(evidence.failed ? 1 : 0);
