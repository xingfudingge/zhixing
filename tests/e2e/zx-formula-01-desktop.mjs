/**
 * ZX-FORMULA-01 桌面验收：KaTeX 公式真实渲染（真实 Tauri WebView + SQLite）。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`；
 *   * 本地静态服务注入只读探针，不替换产品 IPC、不注入假数据源；
 *   * 探针经产品 IPC 造一篇公式笔记；
 *   * 真实点击块级/行内、错误/恢复、模板、缩放、复制与三种导出；
 *   * 真实切换 data-theme 校验明暗主题计算颜色；
 *   * 读回 SQLite payload 与 notes.body，收集控制台异常。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-formula-01-desktop.mjs
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
const PROBE = path.join(__dirname, 'zx-formula-01/probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-formula-01');
const HOME = '/tmp/zx-formula-01-home';
const PORT = 5173;
const NOTE_TITLE = '公式手测';

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
  task: 'ZX-FORMULA-01',
  title: 'KaTeX 公式真实渲染（真实桌面手测）',
  steps: [],
  consoleErrors: [],
  appLog: '',
  failures: [],
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-formula-01] ${name}: ${JSON.stringify(value)}`);
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
  '.ttf': 'font/ttf',
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
  assert(seeded.blocks === 1, `种子公式块数不正确：${seeded.blocks}`);

  await command({ type: 'gotoKnowledge' });
  await command({ type: 'openNote', title: NOTE_TITLE });

  let formula = await command({ type: 'formula' });
  record('initial', {
    state: formula.state,
    renderError: formula.renderError,
    display: formula.display,
    katexCount: formula.katexCount,
    displayCount: formula.displayCount,
    mathmlCount: formula.mathmlCount,
    annotationCount: formula.annotationCount,
    hasSource: formula.hasSource,
    hasFooter: formula.hasFooter,
    hasEditButton: formula.hasEditButton,
    hasTemplateButton: formula.hasTemplateButton,
    color: formula.color,
    katexColor: formula.katexColor,
    templates: formula.templateLabels,
  });
  assert(formula.exists, '公式块未渲染');
  assert(formula.state === 'view', `初始块状态不是 view：${formula.state}`);
  assert(formula.renderError === 'false', '初始公式被标记为错误');
  assert(formula.display === 'block', `初始 display 不是 block：${formula.display}`);
  assert(formula.katexCount >= 1, '没有 .katex 输出');
  assert(formula.displayCount === 1, `块级公式 .katex-display 数量不是 1：${formula.displayCount}`);
  assert(formula.mathmlCount >= 1, '没有 MathML');
  assert(formula.annotationCount === 0, '阅读态 MathML 仍带有 LaTeX annotation');
  assert(!formula.hasSource, '阅读态仍渲染 LaTeX textarea');
  assert(!formula.hasFooter, '阅读态仍显示公式状态栏');
  assert(!formula.hasTemplateButton, '阅读态仍显示模板入口');
  assert(formula.hasEditButton, '阅读态缺少显式「编辑公式」入口');
  assert(!formula.sourceInText, '阅读态 DOM 文本混入 LaTeX 源');
  assert(
    formula.color === 'rgb(37, 44, 56)',
    `浅色主题预览颜色不是 #252c38：${formula.color}`,
  );
  assert(
    formula.katexColor === formula.color,
    `KaTeX 颜色没有继承 --ink：${formula.katexColor}`,
  );
  assert(!formula.previewText.includes('未渲染'), '预览仍出现“未渲染”');

  const editing = await command({ type: 'clickFormula', label: '编辑公式' });
  record('enter-edit', {
    state: editing.state,
    hasSource: editing.hasSource,
    hasFooter: editing.hasFooter,
    source: editing.source,
    annotationCount: editing.annotationCount,
  });
  assert(editing.state === 'edit', `点击编辑后块状态不是 edit：${editing.state}`);
  assert(editing.hasSource, '编辑态没有 LaTeX textarea');
  assert(editing.hasFooter, '编辑态没有状态栏');
  assert(
    editing.source === '\\int_{a}^{b} f(x)\\,\\mathrm{d}x',
    `编辑态源码不正确：${editing.source}`,
  );
  assert(editing.annotationCount === 0, '编辑态预览 MathML 仍带 annotation');

  const templates = await command({
    type: 'clickFormula',
    label: '公式模板',
  });
  record('templates', { labels: templates.templateLabels });
  assert(
    templates.templateLabels.includes('矩阵') &&
      templates.templateLabels.includes('分段') &&
      templates.templateLabels.includes('希腊'),
    `模板缺少矩阵/分段/希腊：${templates.templateLabels}`,
  );
  const done = await command({ type: 'clickFormula', label: '完成' });
  record('exit-edit', {
    state: done.state,
    hasSource: done.hasSource,
    hasFooter: done.hasFooter,
  });
  assert(done.state === 'view', `完成后块状态不是 view：${done.state}`);
  assert(!done.hasSource, '完成后 textarea 仍在');
  assert(!done.hasFooter, '完成后状态栏仍在');

  const dark = await command({ type: 'theme', name: 'dark' });
  record('dark-theme', {
    color: dark.color,
    katexColor: dark.katexColor,
  });
  assert(
    dark.color === 'rgb(231, 234, 241)',
    `深色主题预览颜色不是 #e7eaf1：${dark.color}`,
  );
  assert(
    dark.katexColor === dark.color,
    `深色主题 KaTeX 颜色没有继承 --ink：${dark.katexColor}`,
  );
  await command({ type: 'theme', name: 'light' });

  let inline = await command({ type: 'clickFormula', label: '切换为行内' });
  record('inline-mode', {
    display: inline.display,
    displayCount: inline.displayCount,
    modeLabel: inline.modeLabel,
    preview: inline.previewText.slice(0, 80),
  });
  assert(inline.display === 'inline', `切换行内失败：${inline.display}`);
  assert(inline.displayCount === 0, '行内模式仍有 .katex-display');
  assert(inline.modeLabel === '行内', `模式 chip 文案不是「行内」：${inline.modeLabel}`);
  assert(inline.previewText.includes('行内预览'), '行内模式缺少上下文');

  let block = await command({ type: 'clickFormula', label: '切换为块级' });
  record('block-mode', {
    display: block.display,
    displayCount: block.displayCount,
    modeLabel: block.modeLabel,
  });
  assert(block.display === 'block', '切回块级失败');
  assert(block.displayCount === 1, '切回块级后 .katex-display 不是 1');

  const failed = await command({
    type: 'setLatex',
    value: '\\frac{a}{b',
  });
  record('parse-error', {
    renderError: failed.renderError,
    katexCount: failed.katexCount,
    state: failed.state,
    status: failed.status,
    hasErrorPanel: failed.hasErrorPanel,
    errorText: failed.errorText.slice(0, 160),
  });
  assert(failed.renderError === 'true', '语法错误未标记 data-render-error');
  assert(failed.hasErrorPanel, '语法错误没有错误条');
  assert(failed.errorText.includes('KaTeX parse error'), '错误条缺少 KaTeX 原文');
  assert(failed.errorText.includes('位置：第 1 行'), `错误条缺少行列位置：${failed.errorText}`);
  assert(failed.katexCount === 0, '错误态仍保留上一版半成品预览');
  assert(
    failed.status.includes('解析错误'),
    `错误状态不正确：${failed.status}`,
  );
  assert(failed.source === '\\frac{a}{b', '错误时源被改写');

  const recovered = await command({
    type: 'setLatex',
    value: '\\frac{a}{b}',
  });
  record('recovered', {
    renderError: recovered.renderError,
    katexCount: recovered.katexCount,
    state: recovered.state,
    status: recovered.status,
  });
  assert(recovered.renderError === 'false', '修正后仍标记错误');
  assert(!recovered.hasErrorPanel, '修正后错误条仍存在');
  assert(recovered.katexCount >= 1, '修正后没有 KaTeX 输出');
  assert(recovered.status.includes('渲染成功'), `修正后状态不正确：${recovered.status}`);

  await command({ type: 'setLatex', value: 'x=' });
  const templateMenu = await command({
    type: 'clickFormula',
    label: '公式模板',
  });
  assert(
    templateMenu.templateLabels.includes('矩阵'),
    `模板菜单缺少矩阵：${templateMenu.templateLabels}`,
  );
  const matrix = await command({ type: 'clickFormula', label: '矩阵' });
  record('template-matrix', {
    source: matrix.source,
    katexCount: matrix.katexCount,
    fontSize: matrix.fontSize,
  });
  assert(
    matrix.source.includes('\\begin{pmatrix}'),
    `矩阵模板未插入：${matrix.source}`,
  );
  assert(matrix.katexCount >= 1, '矩阵模板没有渲染');

  const zoomed = await command({ type: 'clickFormula', label: '放大公式' });
  record('zoom', {
    zoom: zoomed.zoom,
    fontSize: zoomed.fontSize,
  });
  assert(zoomed.zoom === '110%', `放大后比例不是 110%：${zoomed.zoom}`);
  assert(
    parseFloat(zoomed.fontSize) > parseFloat(matrix.fontSize),
    `放大后字号没有增加：${matrix.fontSize} → ${zoomed.fontSize}`,
  );
  const reset = await command({ type: 'clickFormula', label: '重置公式缩放' });
  assert(reset.zoom === '100%', `重置后比例不是 100%：${reset.zoom}`);

  const latexTab = await command({ type: 'exportTab', tab: 'LaTeX' });
  record('export-tabs', latexTab.tabs);
  assert(
    latexTab.tabs.join(',') === 'LaTeX,Markdown,HTML',
    `导出 tab 不正确：${latexTab.tabs}`,
  );
  assert(latexTab.text.includes('\\begin{pmatrix}'), 'LaTeX tab 缺少源');

  const markdownTab = await command({ type: 'exportTab', tab: 'Markdown' });
  record('export-markdown', { text: markdownTab.text });
  assert(markdownTab.text.includes('$$'), 'Markdown 缺少 $$ 包裹');
  assert(markdownTab.text.includes('\\begin{pmatrix}'), 'Markdown 丢失 LaTeX 源');

  const htmlTab = await command({ type: 'exportTab', tab: 'HTML' });
  record('export-html', { length: htmlTab.text.length });
  assert(htmlTab.text.includes('class="katex"'), 'HTML 缺少 KaTeX 视觉层');
  assert(htmlTab.text.includes('katex-mathml'), 'HTML 缺少 MathML');
  assert(htmlTab.text.includes('<math'), 'HTML 缺少 math 元素');
  await command({ type: 'closeExport' });

  const unsafe = await command({
    type: 'setLatex',
    value: '\\href{javascript:alert(1)}{x}',
  });
  record('trust-false', {
    linkCount: unsafe.linkCount,
    hrefs: unsafe.hrefs,
  });
  assert(unsafe.linkCount === 0, 'trust:false 下仍生成了链接');
  assert(
    !unsafe.hrefs.some((href) => String(href).startsWith('javascript:')),
    '出现了 javascript: 链接',
  );

  await command({ type: 'setLatex', value: '\\frac{a}{b' });
  const errorHtml = await command({ type: 'exportTab', tab: 'HTML' });
  record('error-html', { text: errorHtml.text.slice(0, 160) });
  assert(
    errorHtml.text.includes('⚠ 公式无法渲染'),
    '错误 HTML 缺少可见占位',
  );
  assert(
    !errorHtml.text.includes('class="katex"'),
    '错误 HTML 伪造了公式',
  );
  assert(
    !errorHtml.text.includes('\\frac{a}{b'),
    '错误 HTML 把 LaTeX 源当正文输出',
  );
  await command({ type: 'closeExport' });

  const errorView = await command({ type: 'formula' });
  record('error-view', {
    state: errorView.state,
    hasSource: errorView.hasSource,
    hasErrorPanel: errorView.hasErrorPanel,
    previewText: errorView.previewText,
  });
  assert(errorView.state === 'view', `错误公式导出后不是 view：${errorView.state}`);
  assert(!errorView.hasSource, '阅读态错误公式仍显示 textarea');
  assert(!errorView.hasErrorPanel, '阅读态错误公式仍显示位置/摘录');
  assert(
    errorView.previewText.includes('公式无法渲染'),
    `阅读态错误占位不正确：${errorView.previewText}`,
  );
  assert(
    !errorView.previewText.includes('\\frac{a}{b'),
    '阅读态错误公式裸奔 LaTeX 源',
  );

  await command({ type: 'sleep', ms: 1800 });
  const stored = await command({ type: 'stored' });
  record('stored', {
    latex: stored.payload?.latex,
    display: stored.payload?.display,
    renderer: stored.payload?.renderer,
    bodyHasFormula: stored.body.includes('zx-formula'),
    bodyHasLatexLanguage: stored.body.includes('data-language="latex"'),
    body: stored.body.slice(0, 240),
  });
  assert(
    stored.payload?.latex === '\\frac{a}{b',
    `SQLite payload latex 不正确：${stored.payload?.latex}`,
  );
  assert(
    stored.payload?.renderer === 'katex',
    `SQLite payload renderer 不是 katex：${stored.payload?.renderer}`,
  );
  assert(
    stored.payload?.display === 'block',
    `SQLite payload display 不是 block：${stored.payload?.display}`,
  );
  assert(stored.body.includes('zx-formula'), 'notes.body 缺少公式投影');
  assert(
    stored.body.includes('data-language="latex"'),
    'notes.body 缺少 LaTeX 源表示',
  );

  const errors = await command({ type: 'errors' });
  evidence.consoleErrors = errors;
  record('console-errors', errors);
  assert(errors.length === 0, `控制台/页面异常：${JSON.stringify(errors)}`);

  console.log('[zx-formula-01] 结果：全部通过');
} catch (error) {
  evidence.failures.push(error.message || String(error));
  console.error(`[zx-formula-01] 失败：${error.message || error}`);
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
