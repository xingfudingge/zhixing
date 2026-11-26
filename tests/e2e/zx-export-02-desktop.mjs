/**
 * ZX-EXPORT-02 真实桌面验收：画板导出 PNG、插入笔记并预览。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`（真实 Tauri WebView +
 *     Canvas2D + SQLite + IndexedDB 附件库）；
 *   * 探针通过真实 IPC 造一块包含泳道/便签/文字/连线的画板；
 *   * 真实点击「导出 PNG」→ 透明/白底切换 → 保存；原生保存面板无法在
 *     无头环境自动确认，探针只把 `save_board_export_file` 换成同一个 Rust
 *     写入命令 `save_export_file`（应用导出目录），PNG 生成仍走产品代码；
 *   * Node 侧检查 PNG 签名/IHDR 尺寸，并用 `open` 打开图片；
 *   * 再点「插入到笔记」，核对笔记块/附件元数据，回到笔记点开文件卡，
 *     断言图片预览真实加载；前后对比画板节点/连线，确认未改动原画板。
 *
 * 运行：
 *   pnpm --filter app build
 *   ~/.cargo/bin/cargo build --manifest-path app/src-tauri/Cargo.toml --bin zhixing
 *   node tests/e2e/zx-export-02-desktop.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const BIN = path.join(ROOT, 'app/src-tauri/target/debug/zhixing');
const PROBE = path.join(__dirname, 'zx-export-02/probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-export-02');
const HOME = '/tmp/zx-export-02-home';
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
  task: 'ZX-EXPORT-02',
  title: '画板导出 PNG / 插入笔记预览（真实桌面）',
  steps: [],
  files: [],
  consoleErrors: [],
  appLog: '',
  failures: [],
  instrumentation: null,
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-export-02] ${name}: ${JSON.stringify(value)}`);
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
  if (file.endsWith('.js')) {
    const text = body.toString('utf8');
    if (text.includes('"save_board_export_file"')) {
      body = Buffer.from(
        text.split('"save_board_export_file"').join('"save_export_file"'),
        'utf8',
      );
      evidence.instrumentation = {
        file: path.basename(file),
        replaced: 'save_board_export_file -> save_export_file',
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

function command(payload, timeout = 90_000) {
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

/** 解码 PNG 第一行第一个像素，确认透明/不透明背景真的写进了文件。 */
function firstPngPixel(bytes, width, colorType) {
  const idat = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') {
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * bpp;
  const filter = raw[0];
  const out = Buffer.alloc(stride);
  for (let index = 0; index < stride; index += 1) {
    const value = raw[1 + index];
    const left = index >= bpp ? out[index - bpp] : 0;
    if (filter === 0) out[index] = value;
    else if (filter === 1) out[index] = (value + left) & 255;
    else out[index] = value; // 首行没有上一行，Up/Average/Paeth 退化为 0。
  }
  return Array.from(out.subarray(0, bpp));
}

function pngInfo(filePath) {
  const bytes = fs.readFileSync(filePath);
  assert(bytes.length > 64, `PNG 文件过小：${bytes.length} 字节`);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert(bytes.subarray(0, 8).equals(signature), 'PNG 签名不正确');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colorType = bytes[25];
  return {
    length: bytes.length,
    width,
    height,
    colorType,
    firstPixel: firstPngPixel(bytes, width, colorType),
    sha256: spawnSync('shasum', ['-a', '256', filePath], {
      encoding: 'utf8',
    }).stdout.trim().split(/\s+/)[0],
  };
}

function copyEvidence(filePath, name) {
  const target = path.join(EVIDENCE, name);
  fs.copyFileSync(filePath, target);
  evidence.files.push({
    name,
    path: filePath,
    copiedTo: target,
    ...pngInfo(filePath),
  });
  return target;
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

  const env = await command({ type: 'env' });
  record('startup', env);
  assert(env.isTauri, '不是真实 Tauri WebView');
  if (env.bodyText.includes('开始 7 天试用')) {
    await command({ type: 'click', label: '开始 7 天试用' });
    await command({ type: 'sleep', ms: 800 });
    record('trial-started', await command({ type: 'env' }));
  }

  const seeded = await command({ type: 'seed' });
  record('seeded', seeded);

  await command({ type: 'openBoard' });
  await command({ type: 'sleep', ms: 800 });
  const before = await command({ type: 'boardSnapshot' });
  record('board-before', before);

  const panel = await command({ type: 'exportPanel' });
  record('export-panel', panel);
  assert(panel.heading === '导出画板 PNG', `导出面板标题异常：${panel.heading}`);
  assert(panel.backgrounds.length >= 3, '背景选项少于 3 种');
  assert(panel.scales.length === 2, '清晰度选项不是 1x/2x');
  assert(panel.summary.includes('输出尺寸'), '导出面板缺少输出尺寸');

  await command({ type: 'setOption', name: 'bw-export-background', value: 'transparent' });
  const transparent = await command({ type: 'savePng' });
  record('transparent-saved', transparent);
  assert(transparent.path, '透明背景保存未返回路径');
  const transparentInfo = pngInfo(transparent.path);
  record('transparent-png', transparentInfo);
  assert(transparentInfo.width > 100 && transparentInfo.height > 100, '透明 PNG 尺寸异常');
  assert(
    transparentInfo.firstPixel[3] === 0,
    `透明背景像素不是全透明：${transparentInfo.firstPixel}`,
  );
  copyEvidence(transparent.path, 'board-transparent.png');

  await command({ type: 'setOption', name: 'bw-export-background', value: 'white' });
  const white = await command({ type: 'savePng' });
  record('white-saved', white);
  assert(white.path && white.path !== transparent.path, '白底导出未落成独立文件');
  const whiteInfo = pngInfo(white.path);
  record('white-png', whiteInfo);
  assert(
    whiteInfo.width === transparentInfo.width &&
      whiteInfo.height === transparentInfo.height,
    '两种背景的导出尺寸不一致',
  );
  assert(
    whiteInfo.firstPixel[3] === 255 &&
      whiteInfo.firstPixel[0] === 255 &&
      whiteInfo.firstPixel[1] === 255 &&
      whiteInfo.firstPixel[2] === 255,
    `白底像素不是不透明白色：${whiteInfo.firstPixel}`,
  );
  copyEvidence(white.path, 'board-white.png');

  await command({ type: 'setOption', name: 'bw-export-background', value: 'theme' });
  const inserted = await command({ type: 'insertIntoNote' });
  record('inserted', inserted);

  const noteState = await command({ type: 'noteSnapshot' });
  record('note-snapshot', noteState);
  assert(noteState.fileBlocks.length === 1, `笔记文件卡数量异常：${noteState.fileBlocks.length}`);
  assert(noteState.fileBlocks[0].mime === 'image/png', '插入的附件不是 PNG');
  assert(
    /\.png$/i.test(noteState.fileBlocks[0].fileName ?? ''),
    '插入的文件卡没有 .png 文件名',
  );
  assert(noteState.attachment, '附件元数据未写入 SQLite');

  const after = await command({ type: 'boardSnapshot' });
  record('board-after', after);
  assert(
    JSON.stringify(before.nodes) === JSON.stringify(after.nodes),
    '插入笔记后画板节点被改动',
  );
  assert(
    JSON.stringify(before.edges) === JSON.stringify(after.edges),
    '插入笔记后画板连线被改动',
  );

  await command({ type: 'closeDialogs' });
  const preview = await command({ type: 'openNoteAndPreview' });
  record('note-preview', preview);
  assert(preview.fileCardLabel.includes('.png'), '文件卡名称不是导出的 PNG');
  assert(preview.imgNaturalWidth > 0, '图片预览未真实加载');

  const errors = await command({ type: 'errors' });
  evidence.consoleErrors = errors;
  assert(errors.length === 0, `控制台 error：${errors.join(' | ')}`);

  // 真实桌面打开导出的 PNG，确认系统能识别文件。
  const opened = spawnSync('open', [transparent.path], { encoding: 'utf8' });
  record('open-png', {
    status: opened.status,
    stderr: opened.stderr.trim(),
  });
  assert(opened.status === 0, '系统默认应用未能打开导出的 PNG');
  await sleep(1200);

  record('evidence-files', evidence.files);
  writeEvidence();
  console.log(
    `[zx-export-02] PASS: ${evidence.files.length} 个 PNG，笔记预览 ${preview.imgNaturalWidth}px`,
  );
} catch (error) {
  evidence.failures.push(error instanceof Error ? error.message : String(error));
  try {
    evidence.consoleErrors = await command({ type: 'errors' }, 3000);
  } catch {
    /* ignore */
  }
  writeEvidence();
  console.error(`[zx-export-02] FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
