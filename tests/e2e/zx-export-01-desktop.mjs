/**
 * ZX-EXPORT-01 真实桌面验收：单篇笔记导出 Word / PDF / Markdown。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`（真实 Tauri WebView + SQLite）；
 *   * 探针通过真实 IPC 造一篇覆盖标题/列表/待办/引用/表格/代码/公式/文件卡/
 *     画板/内链的笔记；
 *   * 真实点击标题区「导出笔记」→ 格式卡 → 继续；原生保存面板无法在无头
 *     环境自动确认，探针只把 `save_attachment_file` 换成同一个 Rust 写入命令
 *     `save_export_file`，导出生成/命名/成功面板仍走产品代码；
 *   * Node 侧独立检查三份真实文件：Markdown 文本、DOCX 的 `unzip -t` 与
 *     `word/document.xml`、PDF 头/页对象，并用 `open` 打开；
 *   * 控制台 error 必须为 0。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-export-01-desktop.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const BIN = path.join(ROOT, 'app/src-tauri/target/debug/zhixing');
const PROBE = path.join(__dirname, 'zx-export-01/probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-export-01');
const HOME = '/tmp/zx-export-01-home';
const PORT = 5173;

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
  task: 'ZX-EXPORT-01',
  title: '单篇笔记导出 Word/PDF/Markdown（真实桌面）',
  steps: [],
  files: [],
  consoleErrors: [],
  appLog: '',
  failures: [],
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-export-01] ${name}: ${JSON.stringify(value)}`);
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
  let body = file.endsWith('index.html')
    ? indexWithProbe()
    : fs.readFileSync(file);
  // 测试注入：原生保存面板无法在无头环境自动确认。只把前端调用同一个
  // Rust 写入命令 `save_export_file`（应用导出目录），产品源码与其余 IPC
  // 不变；导出生成、命名、成功面板、控制台仍走产品代码。
  if (file.endsWith('.js')) {
    const text = body.toString('utf8');
    if (text.includes('"save_attachment_file"')) {
      body = Buffer.from(
        text.split('"save_attachment_file"').join('"save_export_file"'),
        'utf8',
      );
      evidence.instrumentation = {
        file: path.basename(file),
        replaced: 'save_attachment_file -> save_export_file',
      };
    }
  }
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

function command(payload, timeout = 60_000) {
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
  // 保留真实导出的三份文件，便于人工打开核对（脚本下一轮会清理 HOME）。
  for (const file of evidence.files) {
    try {
      fs.copyFileSync(
        file.path,
        path.join(EVIDENCE, path.basename(file.path)),
      );
    } catch {
      /* 文件可能已被清理 */
    }
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.ok = evidence.failures.length === 0;
  fs.writeFileSync(
    path.join(EVIDENCE, 'result.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

function verifyMarkdown(file) {
  const text = fs.readFileSync(file, 'utf8');
  assert(text.startsWith('# 导出功能手测'), 'Markdown 缺少 H1 标题');
  assert(text.includes('> 创建：'), 'Markdown 缺少元信息');
  assert(text.includes('| 模块 | 交付物 |'), 'Markdown 缺少表格');
  assert(text.includes('```typescript'), 'Markdown 缺少代码围栏');
  assert(text.includes('$$\nE = mc^2\n$$'), 'Markdown 缺少公式');
  assert(
    text.includes('zhixing://note/zx-export-01-target'),
    'Markdown 缺少站内内链',
  );
  assert(text.includes('📎 需求说明.pdf'), 'Markdown 缺少文件卡');
  assert(text.includes('🖼 画板：发布流程'), 'Markdown 缺少画板占位');
  assert(text.endsWith('\n'), 'Markdown 末尾缺少换行');
  return { bytes: Buffer.byteLength(text), lines: text.split('\n').length };
}

function verifyDocx(file) {
  const test = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
  assert(test.status === 0, `DOCX unzip -t 失败：${test.stderr}`);
  const xml = spawnSync(
    'unzip',
    ['-p', file, 'word/document.xml'],
    { encoding: 'utf8' },
  );
  assert(xml.status === 0, 'DOCX 缺少 word/document.xml');
  const documentXml = xml.stdout;
  assert(documentXml.includes('导出功能手测'), 'DOCX 缺少标题');
  assert(documentXml.includes('<w:tbl>'), 'DOCX 缺少表格');
  assert(documentXml.includes('<w:numPr>'), 'DOCX 缺少列表编号');
  assert(documentXml.includes('E = mc^2'), 'DOCX 缺少公式源');
  assert(documentXml.includes('<w:hyperlink'), 'DOCX 缺少外链超链接');
  assert(documentXml.includes('☑'), 'DOCX 缺少待办勾选');
  const styles = spawnSync('unzip', ['-p', file, 'word/styles.xml'], {
    encoding: 'utf8',
  });
  assert(styles.status === 0, 'DOCX 缺少 styles.xml');
  assert(styles.stdout.includes('Heading1'), 'DOCX 缺少标题样式');
  return {
    bytes: fs.statSync(file).size,
    xmlBytes: Buffer.byteLength(documentXml),
  };
}

function verifyPdf(file) {
  const bytes = fs.readFileSync(file);
  const head = bytes.subarray(0, 8).toString('latin1');
  assert(head.startsWith('%PDF-1.4'), `PDF 头不正确：${head}`);
  const body = bytes.toString('latin1');
  assert(body.includes('/Type /Page'), 'PDF 缺少页对象');
  assert(body.includes('/Count '), 'PDF 缺少页数');
  assert(body.includes('%%EOF'), 'PDF 缺少 EOF');
  return {
    bytes: bytes.length,
    pages: (body.match(/\/Type \/Page\b/g) ?? []).length,
  };
}

function openFile(file) {
  const result = spawnSync('open', [file], { encoding: 'utf8' });
  return {
    status: result.status,
    error: result.status === 0 ? null : result.stderr || result.stdout,
  };
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
  assert(seeded.blocks === 14, `种子块数不正确：${seeded.blocks}`);

  await command({ type: 'gotoKnowledge' });
  await command({ type: 'openNote', title: seeded.title });

  const initial = await command({ type: 'dialogSnapshot' });
  record('dialog', initial);
  assert(
    initial.radios.find((radio) => radio.checked)?.label.includes('Word 文档'),
    '导出面板默认格式不是 Word',
  );
  assert(initial.outline.includes('个块'), '导出面板缺少内容清单');
  await command({ type: 'closeDialogs' });

  const expected = [
    ['docx', /\.docx$/],
    ['pdf', /\.pdf$/],
    ['md', /\.md$/],
  ];
  const results = new Map();
  for (const [format, pattern] of expected) {
    const result = await command({ type: 'exportFormat', format }, 90_000);
    record(`export-${format}`, {
      heading: result.heading,
      warnings: result.warnings.length,
      file: result.file,
      pathText: result.pathText,
      fileLine: result.fileLine,
    });
    assert(result.heading.startsWith('已导出'), `${format} 成功面板标题不正确`);
    assert(result.file?.path, `${format} 没有拿到真实落盘路径`);
    const filePath = path.resolve(result.file.path);
    assert(pattern.test(filePath), `${format} 扩展名不正确：${filePath}`);
    assert(fs.existsSync(filePath), `${format} 文件不存在：${filePath}`);
    assert(fs.statSync(filePath).size > 100, `${format} 文件过小`);
    assert(
      result.body.includes(result.file.path) ||
        result.body.includes(path.basename(filePath)),
      `${format} 成功面板没有显示实际路径/文件名`,
    );
    result.file.path = filePath;
    results.set(format, result);
  }

  const files = {};
  for (const format of ['docx', 'pdf', 'md']) {
    const result = results.get(format);
    const file = result.file.path;
    const verified =
      format === 'md'
        ? verifyMarkdown(file)
        : format === 'docx'
          ? verifyDocx(file)
          : verifyPdf(file);
    const opened = openFile(file);
    record(`verify-${format}`, { file, ...verified, open: opened });
    assert(opened.status === 0, `${format} 无法用系统默认应用打开`);
    evidence.files.push({ format, path: file, ...verified, open: opened });
    files[format] = file;
  }

  assert(
    results.get('pdf').warnings.some((item) => item.includes('不可选中')),
    'PDF 报告未标注不可选中限制',
  );
  assert(
    results.get('docx').warnings.some((item) => item.includes('公式')),
    'Word 报告未列出公式降级',
  );
  assert(
    results.get('md').warnings.some((item) => item.includes('颜色')),
    'Markdown 报告未列出颜色丢失',
  );

  const finalErrors = await command({ type: 'errors' });
  evidence.consoleErrors = finalErrors;
  record('console-errors', finalErrors);
  assert(finalErrors.length === 0, `控制台存在错误：${finalErrors}`);

  console.log('[zx-export-01] PASS');
} catch (error) {
  evidence.failures.push(error.message || String(error));
  console.error('[zx-export-01] FAIL', error);
  process.exitCode = 1;
} finally {
  await cleanup();
  writeEvidence();
}
