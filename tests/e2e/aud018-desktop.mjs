/**
 * AUD-018 真实桌面链路验收：导出 ZIP/JSON/Markdown/CSV/PDF + 恢复。
 *
 * 形态（为什么这样跑）：
 *   * 启动**真实 Tauri 桌面进程**（`app/src-tauri/target/debug/zhixing`）：
 *     真实 Rust 仓储命令、真实 SQLite（schema v4）、真实 `save_export_file`
 *     写入 `app_data_dir/exports/`；
 *   * 两个独立实例、两个独立 HOME（互不共用数据库）：
 *       A = 造数据 + 五种格式导出 + 冲突/覆盖/保留两者/删除语义；
 *       B = 全新库（只有种子）→ 恢复 A 导出的 ZIP，验证「新机器恢复」；
 *   * macOS WKWebView 没有 CDP/WebDriver，本机屏幕录制权限也拿不到窗口画面，
 *     所以页面内注入 `tests/e2e/aud018/probe.js`：**不替换**产品 IPC，只用真实
 *     DOM `click()` / `<input type=file>` + `DataTransfer` 驱动产品自己的处理器；
 *   * Node 侧是外部校验器：独立解压 ZIP、独立算 SHA-256/CRC32、独立解析 PDF、
 *     直接读 SQLite 与页面 IndexedDB，核对导出与恢复前后一致。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/aud018-desktop.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const BIN = path.join(ROOT, 'app/src-tauri/target/debug/zhixing');
const PROBE = path.join(__dirname, 'aud018/probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/aud018');
const WORK = '/tmp/zx-aud018-run';
const PORT = 5173;
const APP_ID = 'com.zhixing.desktop';

for (const dir of [EVIDENCE, WORK]) fs.mkdirSync(dir, { recursive: true });
// 只清理本脚本生成的证据；保留人工维护的缺陷记录与命令日志。
const PRESERVED_EVIDENCE = new Set([
  'defect-DEF-AUD018-01.md',
  'defect-DEF-AUD018-02.md',
  'build-output.txt',
  'test-output.txt',
  'test-output-flaky-failure.txt',
  'file-checksums.txt',
  'run-output.txt',
  'app-a.log.txt',
  'app-b.log.txt',
  'app-c.log.txt',
]);
for (const file of fs.readdirSync(EVIDENCE)) {
  if (PRESERVED_EVIDENCE.has(file)) continue;
  fs.rmSync(path.join(EVIDENCE, file), { recursive: true, force: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const notes = [];
const evidence = { startedAt: new Date().toISOString(), exports: [], restores: [] };

function log(message, data) {
  console.log(`[aud018] ${data === undefined ? message : `${message} ${JSON.stringify(data)}`}`);
}

function record(id, feature, name, verdict, expected, actual, evidencePath = null) {
  results.push({ id, feature, name, verdict, expected, actual, evidence: evidencePath });
  log(`${verdict.toUpperCase()} ${id} ${name}`, { expected, actual, evidence: evidencePath });
}

// ---------------------------------------------------------------------------
// 静态服务 + 探针命令队列（应用 devUrl 固定 http://localhost:5173）
// ---------------------------------------------------------------------------
let probeReadyResolve = null;
let probeReady = new Promise((resolve) => {
  probeReadyResolve = resolve;
});
const queue = [];
const pending = new Map();
let commandSeq = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function indexWithProbe() {
  return fs
    .readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .replace('</body>', '<script src="/__probe.js"></script></body>');
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (url.pathname === '/__probe-ready') {
        probeReadyResolve?.();
        response.writeHead(204);
        response.end();
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
  if (url.pathname === '/__probe.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(PROBE));
    return;
  }
  if (url.pathname === '/__next') {
    const command = queue.shift();
    if (command) {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(command));
    } else {
      response.writeHead(204);
      response.end();
    }
    return;
  }
  if (url.pathname === '/__file') {
    const file = url.searchParams.get('path');
    if (!file || !fs.existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const buffer = fs.readFileSync(file);
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length });
    response.end(buffer);
    return;
  }
  let file = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html');
  }
  const body = file.endsWith('index.html') ? indexWithProbe() : fs.readFileSync(file);
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
log(`静态服务 http://localhost:${PORT}（含探针注入）`);

// ---------------------------------------------------------------------------
// 桌面实例
// ---------------------------------------------------------------------------
class Desktop {
  constructor(label) {
    this.label = label;
    this.home = path.join(WORK, `${label}-home`);
    fs.rmSync(this.home, { recursive: true, force: true });
    fs.mkdirSync(this.home, { recursive: true });
    this.appData = path.join(this.home, 'Library/Application Support', APP_ID);
    this.dbPath = path.join(this.appData, 'zhixing.db');
    this.exportDir = path.join(this.appData, 'exports');
    fs.mkdirSync(this.exportDir, { recursive: true });
    this.log = '';
    this.exited = null;
    this.proc = null;
  }

  async start() {
    probeReady = new Promise((resolve) => {
      probeReadyResolve = resolve;
    });
    this.proc = spawn(BIN, [], {
      cwd: this.home,
      env: {
        ...process.env,
        HOME: this.home,
        ZHIXING_LICENSE_STORE: 'file',
        ZHIXING_LICENSE_FILE: path.join(this.home, 'license.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (chunk) => {
      this.log += String(chunk);
    });
    this.proc.stderr.on('data', (chunk) => {
      this.log += String(chunk);
    });
    this.proc.on('exit', (code) => {
      this.exited = code;
    });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const ready = await Promise.race([probeReady.then(() => true), sleep(250).then(() => false)]);
      if (ready) break;
      if (this.exited !== null) throw new Error(`${this.label} 提前退出 code=${this.exited}\n${this.log.slice(-3000)}`);
    }
    if (this.exited !== null) throw new Error(`${this.label} 启动失败\n${this.log.slice(-3000)}`);
    // 探针会在脚本注入时立刻上报 ready；此时 React 还没挂载，必须先等首屏。
    const boot0 = await call('waitAppReady', 60_000);
    if (!boot0.ready) throw new Error(`${this.label} 首屏未渲染：${JSON.stringify(boot0)}`);
    // 首次启动停在激活页：点真实「开始 7 天试用」。
    if (/未检测到本机授权|激活知行/.test(boot0.text)) {
      await call('click', '开始 7 天试用');
      const after = await call('waitForText', '今天', 30_000);
      if (!after) throw new Error(`${this.label} 试用后仍未进入主界面：${JSON.stringify(await call('state')).slice(0, 400)}`);
      this.trial = true;
    } else {
      this.trial = false;
    }
    const status = await call('invoke', 'db_status', {});
    this.status = status;
    return this;
  }

  async stop() {
    if (!this.proc) return;
    this.proc.kill('SIGTERM');
    const deadline = Date.now() + 10_000;
    while (this.exited === null && Date.now() < deadline) await sleep(120);
    if (this.exited === null) this.proc.kill('SIGKILL');
    await sleep(400);
    fs.writeFileSync(path.join(EVIDENCE, `app-${this.label}.log`), this.log);
    // `.log` 被仓库 .gitignore 忽略；同时写一份可入库的 .log.txt。
    fs.writeFileSync(path.join(EVIDENCE, `app-${this.label}.log.txt`), this.log);
  }

  listExports() {
    if (!fs.existsSync(this.exportDir)) return [];
    return fs
      .readdirSync(this.exportDir)
      .map((name) => {
        const file = path.join(this.exportDir, name);
        const stat = fs.statSync(file);
        return { name, file, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  async waitNewExport(before, timeout = 120_000) {
    const seen = new Set(before.map((item) => item.file));
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const fresh = this.listExports().filter((item) => !seen.has(item.file));
      if (fresh.length > 0) return fresh[fresh.length - 1];
      await sleep(150);
    }
    throw new Error('save_export_file 未在应用数据目录产生新文件');
  }

  async openDb() {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(this.dbPath, { readOnly: true });
  }
}

let active = null;

async function call(name, ...args) {
  if (!active) throw new Error('没有活动桌面实例');
  const id = ++commandSeq;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`探针命令超时：${name}`));
    }, 180_000);
    pending.set(id, (payload) => {
      clearTimeout(timer);
      if (payload.ok) resolve(payload.value);
      else reject(new Error(payload.error));
    });
  });
  queue.push({ id, name, args });
  return promise;
}

const ipc = (command, args = {}) => call('invoke', command, args);

async function waitPanelSettled(timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await call('busy');
    if (last.disabled === false) return last;
    await sleep(120);
  }
  return last;
}

async function openDataPanel() {
  const opened = await call('openDataPanel');
  if (!opened.ok) throw new Error(`打不开「数据与备份」分组：${JSON.stringify(opened)}`);
  return opened;
}

async function chooseBackup(file) {
  return call('chooseBackupFile', `/__file?path=${encodeURIComponent(file)}`, path.basename(file));
}

// ---------------------------------------------------------------------------
// 外部校验工具
// ---------------------------------------------------------------------------
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readZip(buffer) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 66_000); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 缺少 EOCD');
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录签名错误');
    const method = buffer.readUInt16LE(offset + 10);
    const crcExpected = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const declaredSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`本地头签名错误：${name}`);
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(start, start + compressedSize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`不支持的压缩方法 ${method}：${name}`);
    entries.push({
      path: name,
      method,
      byteSize: data.length,
      declaredSize,
      crcOk: crc32(data) === crcExpected,
      sha256: sha256(data),
      data,
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inspectPdf(buffer) {
  const text = buffer.toString('latin1');
  const xref = /startxref\s+(\d+)/.exec(text);
  return {
    header: text.slice(0, 8),
    headerOk: text.startsWith('%PDF-'),
    byteSize: buffer.length,
    pageCount: (text.match(/\/Type\s*\/Page[^s]/g) || []).length,
    jpegCount: (text.match(/\/DCTDecode/g) || []).length,
    imageObjects: (text.match(/\/Subtype\s*\/Image/g) || []).length,
    hasEof: text.trimEnd().endsWith('%%EOF'),
    xrefOk: Boolean(xref) && text.startsWith('xref', Number(xref[1])),
  };
}

const fileStat = (file) => {
  const buffer = fs.readFileSync(file);
  return { file, byteSize: buffer.length, sha256: sha256(buffer), buffer };
};

function collectRelations(dataset) {
  const relations = [];
  const add = (kind, fromCollection, fromId, field, toCollection, toId) => {
    if (!toId) return;
    relations.push({ kind, fromCollection, fromId, field, toCollection, toId });
  };
  for (const task of dataset.tasks || []) {
    add('task.list', 'tasks', task.id, 'listId', 'lists', task.listId);
    add('task.parent', 'tasks', task.id, 'parentId', 'tasks', task.parentId);
    add('task.note', 'tasks', task.id, 'noteId', 'notes', task.noteId);
  }
  for (const subtask of dataset.subtasks || []) add('subtask.task', 'subtasks', subtask.id, 'taskId', 'tasks', subtask.taskId);
  for (const block of dataset.noteBlocks || []) add('note.block', 'noteBlocks', block.id, 'noteId', 'notes', block.noteId);
  for (const todo of dataset.noteTodos || []) {
    add('note.todo', 'noteTodos', todo.id, 'noteId', 'notes', todo.noteId);
    add('todo.task', 'noteTodos', todo.id, 'taskId', 'tasks', todo.taskId);
  }
  for (const event of dataset.events || []) add('event.note', 'events', event.id, 'noteId', 'notes', event.noteId);
  for (const session of dataset.focusSessions || []) add('focus.task', 'focusSessions', session.id, 'taskId', 'tasks', session.taskId);
  for (const log of dataset.habitLogs || []) add('habit.log', 'habitLogs', log.id, 'habitId', 'habits', log.habitId);
  for (const board of dataset.boards || []) {
    add('board.note', 'boards', board.board.id, 'noteId', 'notes', board.board.noteId);
    for (const node of board.nodes) add('board.node', 'boardNodes', node.id, 'boardId', 'boards', board.board.id);
    for (const edge of board.edges) {
      add('board.edge.from', 'boardEdges', edge.id, 'fromNodeId', 'boardNodes', edge.fromNodeId);
      add('board.edge.to', 'boardEdges', edge.id, 'toNodeId', 'boardNodes', edge.toNodeId);
    }
  }
  for (const attachment of dataset.attachments || []) {
    add('attachment.note', 'attachments', attachment.id, 'noteId', 'notes', attachment.noteId);
    add('attachment.block', 'attachments', attachment.id, 'blockId', 'noteBlocks', attachment.blockId);
  }
  for (const snapshot of dataset.reviewSnapshots || []) {
    add('review.note', 'reviewSnapshots', snapshot.id, 'noteId', 'notes', snapshot.noteId);
    for (const taskId of snapshot.taskIds || []) add('review.task', 'reviewSnapshots', snapshot.id, 'taskIds', 'tasks', taskId);
    for (const focusId of snapshot.focusIds || []) add('review.focus', 'reviewSnapshots', snapshot.id, 'focusIds', 'focusSessions', focusId);
    for (const habitId of snapshot.habitIds || []) add('review.habit', 'reviewSnapshots', snapshot.id, 'habitIds', 'habits', habitId);
  }
  return relations.sort((a, b) =>
    `${a.fromCollection}|${a.fromId}|${a.field}|${a.toCollection}|${a.toId}|${a.kind}`.localeCompare(
      `${b.fromCollection}|${b.fromId}|${b.field}|${b.toCollection}|${b.toId}|${b.kind}`,
    ),
  );
}

const relationKey = (relation) =>
  `${relation.kind}|${relation.fromCollection}|${relation.fromId}|${relation.field}|${relation.toCollection}|${relation.toId}`;

/**
 * 关系比较用的规范化键：打卡记录的 id 恢复时重新生成（产品文档 §4），
 * 关系本身（habitId + 日期 → 习惯）必须等价，所以把 habit.log 的
 * fromId 换成「habitId|logDate」再比较，避免把 id 变化误判成关系丢失。
 */
function normalizedRelationKeys(relations, datasetKeyOfLog) {
  return relations.map((relation) => {
    if (relation.kind !== 'habit.log') return relationKey(relation);
    const key = datasetKeyOfLog.get(relation.fromId);
    return `${relation.kind}|habitLogs|${key ?? relation.fromId}|${relation.field}|${relation.toCollection}|${relation.toId}`;
  });
}

function relationSetDiff(beforeRelations, afterRelations, beforeDataset, afterDataset) {
  const keyOf = (dataset) =>
    new Map((dataset.habitLogs ?? []).map((log) => [log.id, `${log.habitId}|${log.logDate}`]));
  const before = new Set(normalizedRelationKeys(beforeRelations, keyOf(beforeDataset)));
  const after = new Set(normalizedRelationKeys(afterRelations, keyOf(afterDataset)));
  return {
    before: before.size,
    after: after.size,
    missing: [...before].filter((key) => !after.has(key)).slice(0, 10),
    extra: [...after].filter((key) => !before.has(key)).slice(0, 10),
  };
}

function relationDiff(before, after) {
  const left = new Set(before.map(relationKey));
  const right = new Set(after.map(relationKey));
  return {
    before: left.size,
    after: right.size,
    missing: [...left].filter((key) => !right.has(key)).slice(0, 10),
    extra: [...right].filter((key) => !left.has(key)).slice(0, 10),
  };
}

const META_KEYS = new Set(['createdAt', 'updatedAt', 'version']);
/** 备份只包含 settings 白名单键（app/src/data/repositories/settings.ts SETTING_KEYS）。 */
const SAFE_SETTING_KEYS = new Set([
  'editor.fontSize',
  'editor.paragraphSpacing',
  'editor.textIndent',
  'editor.width',
  'editor.titleMode',
  'editor.showBlockIcon',
  'editor.textColor',
  'tasks.defaultListId',
  'notes.defaultFolderId',
  'calendar.showLunar',
]);

function contentNormalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(contentNormalize);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (META_KEYS.has(key)) continue;
    output[key] = contentNormalize(value[key]);
  }
  return output;
}

/**
 * 内容哈希：忽略 createdAt/updatedAt/version（产品文档声明时间戳与版本不保留），
 * 并把 settings 收敛到备份白名单——本机可能存在刻意不导出的敏感键。
 */
function contentHash(dataset) {
  return sha256(Buffer.from(JSON.stringify(contentNormalize({
    lists: dataset.lists,
    tasks: dataset.tasks,
    subtasks: dataset.subtasks,
    notes: dataset.notes,
    noteBlocks: dataset.noteBlocks,
    noteTodos: dataset.noteTodos,
    events: dataset.events,
    countdowns: dataset.countdowns,
    habits: dataset.habits,
    habitLogs: dataset.habitLogs,
    focusSessions: dataset.focusSessions,
    reviewSnapshots: dataset.reviewSnapshots,
    boards: dataset.boards,
    attachments: dataset.attachments,
    settings: (dataset.settings || []).filter((row) => SAFE_SETTING_KEYS.has(row.key)),
  }))));
}

function csvParse(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r') continue;
    else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function bundleFromZip(file) {
  const entries = readZip(fs.readFileSync(file));
  const map = new Map(entries.map((entry) => [entry.path, entry]));
  const manifest = JSON.parse(map.get('manifest.json').data.toString('utf8'));
  const entities = JSON.parse(map.get('data/entities.json').data.toString('utf8'));
  const relationsDoc = JSON.parse(map.get('data/relations.json').data.toString('utf8'));
  const boards = manifest.boards.map((boardEntry) => {
    const doc = JSON.parse(map.get(boardEntry.path).data.toString('utf8'));
    return { board: doc.board, nodes: doc.nodes, edges: doc.edges };
  });
  return { entries, map, manifest, dataset: { ...entities.dataset, boards }, relationsDoc };
}

function zipIntegrity(bundle) {
  const checked = bundle.manifest.entries.map((entry) => {
    const file = bundle.map.get(entry.path);
    return {
      path: entry.path,
      present: Boolean(file),
      sizeOk: Boolean(file) && file.byteSize === entry.byteSize,
      shaOk: Boolean(file) && file.sha256 === entry.sha256,
      crcOk: Boolean(file) && file.crcOk,
    };
  });
  return {
    entries: bundle.entries.length,
    checked: checked.length,
    allPresent: checked.every((item) => item.present),
    allSizeOk: checked.every((item) => item.sizeOk),
    allShaOk: checked.every((item) => item.shaOk),
    allCrcOk: checked.every((item) => item.crcOk),
    failures: checked.filter((item) => !item.present || !item.sizeOk || !item.shaOk || !item.crcOk),
  };
}

function datasetFromCollect(collected) {
  return {
    lists: collected.lists,
    tasks: collected.tasks,
    subtasks: collected.subtasks,
    notes: collected.notes,
    noteBlocks: collected.noteBlocks,
    noteTodos: collected.noteTodos,
    events: collected.events,
    countdowns: collected.countdowns,
    habits: collected.habits,
    habitLogs: collected.habitLogs,
    focusSessions: collected.focusSessions,
    reviewSnapshots: collected.reviewSnapshots,
    boards: collected.boards,
    attachments: collected.attachments,
    settings: collected.settings,
  };
}

async function dbSnapshot(desktop) {
  const db = await desktop.openDb();
  try {
    const tables = {
      lists: 'lists', tasks: 'tasks', subtasks: 'subtasks', notes: 'notes',
      noteBlocks: 'note_blocks', noteTodos: 'note_todos', events: 'events',
      countdowns: 'countdowns', habits: 'habits', habitLogs: 'habit_logs',
      focusSessions: 'focus_sessions', reviewSnapshots: 'review_snapshots',
      boards: 'boards', boardNodes: 'board_nodes', boardEdges: 'board_edges',
      attachments: 'attachments', settings: 'settings',
    };
    const all = {};
    const activeCounts = {};
    for (const [key, table] of Object.entries(tables)) {
      all[key] = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
      activeCounts[key] = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE deleted_at IS NULL`).get().c;
    }
    return {
      all,
      active: activeCounts,
      attachments: db.prepare('SELECT id, sha256, byte_size, note_id, deleted_at FROM attachments').all().map((row) => ({ ...row })),
      detach: db.prepare('PRAGMA foreign_key_check').all().length,
    };
  } finally {
    db.close();
  }
}

const ATTACHMENT_TEXT = 'AUD-018 attachment payload\n第二行：附件内容\n';
const ATTACHMENT_SHA = sha256(Buffer.from(ATTACHMENT_TEXT));
const BYTES = Buffer.byteLength(ATTACHMENT_TEXT);

let exitCode = 0;
let fatal = null;

async function step(id, feature, name, fn) {
  try {
    return { id, ok: true, value: await fn() };
  } catch (error) {
    notes.push(`步骤 ${id}（${name}）异常：${error.message}`);
    return { id, ok: false, error };
  }
}

/**
 * 恢复保真度：逐字段比较备份 dataset 与本机 collect()（含回收站）。
 *
 * 忽略字段（产品文档 `docs/release/export-format.md` 第 3、4 节明示）：
 *   * createdAt / updatedAt / version：恢复时由本机重新生成；
 *   * completedAt：备份不保留（fingerprint 同口径）；
 *   * habitLogs.id：打卡记录通过 habit_logs_set 写入，id 不保留；
 *   * settings：只比较备份白名单键，且按 (scope,key) 身份匹配。
 * 其余字段（含 deletedAt）必须逐字节一致，出现差异即视为恢复丢字段。
 */
const IGNORED_KEYS = new Set(['createdAt', 'updatedAt', 'version', 'completedAt']);
/**
 * deletedAt 只比较「是否在回收站」：恢复会重新生成本机删除时间，产品文档
 * 明确「时间戳由本机写入时重新生成」。但 deleted 状态必须一致。
 */
function stripVolatile(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripVolatile);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (IGNORED_KEYS.has(key)) continue;
    // 回收站标记只比较真假：恢复会重新生成本机删除时间（产品文档 §3/§4）。
    if (key === 'deletedAt') {
      output.deletedAt = value.deletedAt === null ? null : 'trashed';
      continue;
    }
    // 打卡 id 不保留（产品文档 §4：habit_logs_set 写入，id 不保留）。
    if (key === 'id' && typeof value.habitId === 'string' && typeof value.logDate === 'string') {
      continue;
    }
    output[key] = stripVolatile(value[key]);
  }
  return output;
}

const boardKey = (bundle) => ({
  board: stripVolatile(bundle.board),
  nodes: bundle.nodes.map(stripVolatile).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  edges: bundle.edges.map(stripVolatile).sort((a, b) => String(a.id).localeCompare(String(b.id))),
});

const ROW_KEYS = {
  lists: (row) => row.id,
  tasks: (row) => row.id,
  subtasks: (row) => row.id,
  notes: (row) => row.id,
  noteBlocks: (row) => row.id,
  noteTodos: (row) => row.id,
  events: (row) => row.id,
  countdowns: (row) => row.id,
  habits: (row) => row.id,
  habitLogs: (row) => `${row.habitId}|${row.logDate}`,
  focusSessions: (row) => row.id,
  reviewSnapshots: (row) => row.id,
  attachments: (row) => row.id,
  settings: (row) => `${row.scope}:${row.key}`,
};

/**
 * @param {object} backup 备份 dataset
 * @param {object} local  collect() 结果（settings 已含本机额外键）
 * @param {string[]} ignoreCollections 明确不参与比较的集合
 */
function fidelityDiff(backup, local, ignoreCollections = []) {
  const ignored = new Set(ignoreCollections);
  const problems = [];
  const summary = {};
  for (const collection of Object.keys(ROW_KEYS)) {
    if (ignored.has(collection)) continue;
    const keyOf = ROW_KEYS[collection];
    let expected = backup[collection] ?? [];
    let actual = local[collection] ?? [];
    if (collection === 'settings') {
      expected = expected.filter((row) => SAFE_SETTING_KEYS.has(row.key));
      actual = actual.filter((row) => SAFE_SETTING_KEYS.has(row.key));
    }
    const expectedMap = new Map(expected.map((row) => [keyOf(row), row]));
    const actualMap = new Map(actual.map((row) => [keyOf(row), row]));
    void 0;
    let matched = 0;
    for (const [key, row] of expectedMap) {
      const other = actualMap.get(key);
      if (!other) {
        problems.push({ collection, key, kind: 'missing' });
        continue;
      }
      matched += 1;
      const left = JSON.stringify(stripVolatile(row));
      const right = JSON.stringify(stripVolatile(other));
      if (left !== right) problems.push({ collection, key, kind: 'value', backup: left, local: right });
    }
    for (const key of actualMap.keys()) {
      if (!expectedMap.has(key)) problems.push({ collection, key, kind: 'extra' });
    }
    summary[collection] = { backup: expectedMap.size, local: actualMap.size, matched };
  }
  // 画板整包比较（节点/连线按 id 排序）
  const expectedBoards = new Map((backup.boards ?? []).map((bundle) => [bundle.board.id, bundle]));
  const actualBoards = new Map((local.boards ?? []).map((bundle) => [bundle.board.id, bundle]));
  for (const [id, bundle] of expectedBoards) {
    const other = actualBoards.get(id);
    if (!other) {
      problems.push({ collection: 'boards', key: id, kind: 'missing' });
      continue;
    }
    const left = JSON.stringify(boardKey(bundle));
    const right = JSON.stringify(boardKey(other));
    if (left !== right) problems.push({ collection: 'boards', key: id, kind: 'value', backup: left, local: right });
  }
  for (const id of actualBoards.keys()) {
    if (!expectedBoards.has(id)) problems.push({ collection: 'boards', key: id, kind: 'extra' });
  }
  summary.boards = { backup: expectedBoards.size, local: actualBoards.size };
  return { problems, summary, ok: problems.length === 0 };
}

// ---------------------------------------------------------------------------
// 阶段 A：造数据 + 五种格式导出 + 冲突/删除语义
// ---------------------------------------------------------------------------
const fixture = { ids: {}, counts: {} };
let exportBy = {};
let zipBundle = null;

async function phaseA() {
  const desktop = new Desktop('a');
  active = desktop;
  await desktop.start();
  evidence.runtimeA = {
    label: 'A',
    binary: BIN,
    dbPath: desktop.dbPath,
    trial: desktop.trial,
    status: desktop.status,
    binMtime: fs.statSync(BIN).mtime.toISOString(),
    distMtime: fs.statSync(path.join(DIST, 'index.html')).mtime.toISOString(),
    node: process.version,
  };
  log('实例 A 就绪', evidence.runtimeA);

  // A1 造数据
  await step('A-1', 'F-036', '造数据', async () => {
    const lists = await ipc('lists_list', { includeDeleted: true });
    const work = lists.find((list) => list.name === '工作') ?? lists[0];
    const inbox = lists.find((list) => list.isInbox) ?? lists[0];
    const noteA = await ipc('notes_create', {
      input: {
        id: 'aud018-note-relations',
        title: 'AUD-018 关系总集',
        folderId: 'aud018-folder',
        tags: ['验收', '关系'],
        body: '<h2>关系总集</h2><p>任务、事件、画板、附件都指向这篇笔记。</p>',
        favorite: true,
      },
    });
    const noteB = await ipc('notes_create', { input: { id: 'aud018-note-deleted', title: 'AUD-018 回收站笔记', body: '<p>待恢复</p>' } });
    const block = await ipc('note_blocks_create', {
      input: { id: 'aud018-block', noteId: noteA.id, blockType: 'paragraph', orderKey: 10, payload: { text: '块投影：被任务与附件引用' } },
    });
    const taskMain = await ipc('tasks_create', {
      input: {
        id: 'aud018-task-main', listId: work.id, noteId: noteA.id, title: 'AUD-018 主任务（关联笔记）',
        notes: '任务的执行要点', dueDate: '2026-10-30', dueTime: '09:00', priority: 3, quadrant: 1, sortOrder: 10,
      },
    });
    await ipc('subtasks_create', { input: { id: 'aud018-subtask', taskId: taskMain.id, title: '子任务：导出 ZIP', sortOrder: 1 } });
    const taskChild = await ipc('tasks_create', {
      input: { id: 'aud018-task-child', listId: inbox.id, parentId: taskMain.id, title: 'AUD-018 子任务（parent 关系）', sortOrder: 20 },
    });
    await ipc('note_todos_create', {
      input: { id: 'aud018-todo', noteId: noteA.id, taskId: taskMain.id, title: '笔记待办：关联任务', sortOrder: 1 },
    });
    await ipc('events_create', {
      input: { id: 'aud018-event', title: 'AUD-018 评审会', eventType: '工作', startDate: '2026-10-30', startAt: '2026-10-30T10:00', endAt: '2026-10-30T11:00', noteId: noteA.id, calendarType: 'solar' },
    });
    await ipc('countdowns_create', {
      input: { id: 'aud018-countdown', title: 'AUD-018 验收截止', category: '自定义', targetDate: '2026-11-15', calendarType: 'lunar', lunarMonth: '十月初一', lunarDay: 1 },
    });
    const habit = await ipc('habits_create', { input: { id: 'aud018-habit', title: 'AUD-018 每日复盘', goalPerWeek: 5, icon: '📝' } });
    await ipc('habit_logs_set', { habitId: habit.id, date: '2026-10-26', note: '打卡' });
    await ipc('habit_logs_set', { habitId: habit.id, date: '2026-10-27', note: '打卡' });
    const focus = await ipc('focus_sessions_create', {
      input: { id: 'aud018-focus', taskId: taskMain.id, minutes: 25, startedAt: '2026-10-27T01:00:00.000Z', endedAt: '2026-10-27T01:25:00.000Z', mode: 'pomodoro', note: '专注记录' },
    });
    const review = await ipc('review_snapshots_save', {
      input: {
        id: 'aud018-review', rangeStart: '2026-10-20', rangeEnd: '2026-10-26',
        taskIds: [taskMain.id], focusIds: [focus.id], habitIds: [habit.id],
        note: { id: 'aud018-review-note', title: 'AUD-018 周复盘', body: '<p>复盘正文</p>' },
      },
    });
    const board = await ipc('boards_create', {
      input: { id: 'aud018-board', noteId: noteA.id, title: 'AUD-018 关系画板', background: 'dot', snapshot: { version: 1, nodeCount: 2, edgeCount: 1 } },
    });
    const node1 = await ipc('board_nodes_create', {
      input: { id: 'aud018-node-1', boardId: board.id, nodeType: 'process', x: 100, y: 100, width: 180, height: 60, zIndex: 0, text: '导出', payload: { style: { fill: '#ffffff' } } },
    });
    const node2 = await ipc('board_nodes_create', {
      input: { id: 'aud018-node-2', boardId: board.id, nodeType: 'process', x: 380, y: 100, width: 180, height: 60, zIndex: 1, text: '恢复', payload: { style: { fill: '#ffffff' } } },
    });
    await ipc('board_edges_create', {
      input: { id: 'aud018-edge', boardId: board.id, fromNodeId: node1.id, toNodeId: node2.id, label: '下一步', style: { routing: 'straight', arrow: 'end' } },
    });
    const blob = await call('putBlob', ATTACHMENT_SHA, Buffer.from(ATTACHMENT_TEXT).toString('base64'));
    await ipc('attachments_create', {
      input: {
        id: 'aud018-attachment', noteId: noteA.id, blockId: block.id, fileName: 'aud018-attachment.txt',
        sha256: ATTACHMENT_SHA, byteSize: BYTES, mime: 'text/plain', storageKey: `attachments/${ATTACHMENT_SHA}`,
      },
    });
    await ipc('notes_delete', { id: noteB.id });
    const trashTask = await ipc('tasks_create', {
      input: { id: 'aud018-task-trash', listId: work.id, noteId: noteA.id, title: 'AUD-018 已删除任务（回收站）', sortOrder: 30 },
    });
    await ipc('tasks_delete', { id: trashTask.id });
    await ipc('settings_set', { input: { id: 'aud018-setting-editor', scope: 'device', key: 'editor.fontSize', value: 17 } });
    await ipc('settings_set', { input: { id: 'aud018-setting-secret', scope: 'device', key: 'sync.webdavPassword', value: 'super-secret' } });
    await ipc('settings_set', { input: { id: 'aud018-setting-unknown', scope: 'device', key: 'custom.random', value: 'x' } });

    const collected = await call('collect');
    Object.assign(fixture.ids, {
      noteA: noteA.id, noteB: noteB.id, block: block.id, taskMain: taskMain.id,
      child: taskChild.id, event: 'aud018-event', habit: habit.id, focus: focus.id,
      review: review.snapshot.id, board: board.id, attachment: 'aud018-attachment', trashTask: trashTask.id,
    });
    Object.assign(fixture.counts, {
      lists: collected.lists.length, tasks: collected.tasks.length, notes: collected.notes.length,
      noteBlocks: collected.noteBlocks.length, noteTodos: collected.noteTodos.length,
      events: collected.events.length, countdowns: collected.countdowns.length,
      habits: collected.habits.length, habitLogs: collected.habitLogs.length,
      focusSessions: collected.focusSessions.length, reviewSnapshots: collected.reviewSnapshots.length,
      boards: collected.boards.length, attachments: collected.attachments.length, settings: collected.settings.length,
      trashTasks: collected.tasks.filter((row) => row.deletedAt).length,
      trashNotes: collected.notes.filter((row) => row.deletedAt).length,
    });
    return { blob, trashTask: trashTask.id, child: taskChild.id };
  }).then((result) => {
    if (!result.ok) {
      fatal = result.error;
      return;
    }
    if (!result.value.blob || result.value.blob.size !== BYTES) {
      fatal = new Error('附件二进制未写入 IndexedDB');
      return;
    }
    record(
      'A-1', 'F-036', '真实 SQLite 造数据（关系/回收站/附件二进制/敏感设置）', 'pass',
      '通过真实 IPC 写入并能在列表中读回',
      `清单 ${fixture.counts.lists} / 任务 ${fixture.counts.tasks}（回收站 ${fixture.counts.trashTasks}）/ 笔记 ${fixture.counts.notes}（回收站 ${fixture.counts.trashNotes}）/ 块 ${fixture.counts.noteBlocks} / 待办 ${fixture.counts.noteTodos} / 事件 ${fixture.counts.events} / 倒数日 ${fixture.counts.countdowns} / 习惯 ${fixture.counts.habits}+${fixture.counts.habitLogs} 打卡 / 专注 ${fixture.counts.focusSessions} / 复盘 ${fixture.counts.reviewSnapshots} / 画板 ${fixture.counts.boards} / 附件 ${fixture.counts.attachments}（IndexedDB ${result.value.blob.size} B）/ 设置 ${fixture.counts.settings}`,
    );
  });
  if (fatal) throw fatal;

  // A2 面板
  await step('A-2', 'F-036', '打开数据与备份面板', async () => {
    const opened = await openDataPanel();
    const panel = await call('panel');
    const html = (await call('html', '.settings-body')) ?? '';
    fs.writeFileSync(path.join(EVIDENCE, '01-settings-data-panel.html'), html);
    if (!panel.route.includes('/settings/data')) throw new Error(`路由未进入设置数据页：${panel.route}`);
    if (panel.exportButtons.length !== 5) throw new Error(`导出按钮异常：${JSON.stringify(panel.exportButtons)}`);
    return { route: panel.route, buttons: panel.exportButtons, opened };
  }).then((result) => {
    if (!result.ok) {
      fatal = result.error;
      return;
    }
    record('A-2', 'F-036', '设置·数据与备份显示 5 个导出按钮与恢复入口', 'pass',
      'ZIP/JSON/Markdown/CSV/PDF 五个按钮 + 选择备份文件',
      `route=${result.value.route}，按钮=${result.value.buttons.map((b) => b.text).join('/')}`,
      'tests/evidence/aud018/01-settings-data-panel.html');
  });
  if (fatal) throw fatal;

  // A3 五种格式导出
  const FORMATS = [
    { key: 'zip', label: '导出 ZIP', scope: '.settings-body' },
    { key: 'json', label: 'JSON' },
    { key: 'markdown', label: 'Markdown' },
    { key: 'csv', label: 'CSV' },
    { key: 'pdf', label: 'PDF' },
  ];
  for (const format of FORMATS) {
    await step(`B-${format.key}`, 'F-036', `导出 ${format.label}`, async () => {
      const before = desktop.listExports();
      const startedAt = Date.now();
      const clicked = await call('click', format.label, format.scope ?? '.backup-actions');
      const busyDuring = await call('busy');
      const file = await desktop.waitNewExport(before);
      const durationMs = Date.now() - startedAt;
      const settled = await waitPanelSettled();
      const stat = fileStat(file.file);
      const panel = await call('panel');
      return { clicked, file, busyDuring, settled, durationMs, stat, notice: panel.notice, warnings: panel.warnings };
    }).then((result) => {
      if (!result.ok) {
        record(`B-${format.key}`, 'F-036', `导出 ${format.label}`, 'fail', '生成真实文件', `异常：${result.error.message}`);
        return;
      }
      const value = result.value;
      evidence.exports.push({
        kind: format.key, file: value.file.file, byteSize: value.stat.byteSize, sha256: value.stat.sha256,
        durationMs: value.durationMs, notice: value.notice, warnings: value.warnings,
        busyDuring: value.busyDuring, settled: value.settled,
      });
      exportBy[format.key] = value.file.file;
      record(`B-${format.key}`, 'F-036', `导出 ${format.label}`,
        value.stat.byteSize > 0 ? 'pass' : 'fail',
        '真实文件 > 0 字节，路径与 SHA-256 可复核',
        `${value.file.file} · ${value.stat.byteSize} B · sha256=${value.stat.sha256.slice(0, 16)}… · ${value.durationMs}ms · 提示「${value.notice}」`,
        value.file.file);
    });
  }
  if (!exportBy.zip) throw new Error('ZIP 导出失败，后续无法继续');
  fs.writeFileSync(path.join(EVIDENCE, 'exports.json'), JSON.stringify(evidence.exports, null, 2));

  // A4 独立校验
  await step('C-zip', 'F-036', 'ZIP 独立校验', async () => {
    zipBundle = bundleFromZip(exportBy.zip);
    const integrity = zipIntegrity(zipBundle);
    const collected = await call('collect');
    const localRelations = collectRelations(datasetFromCollect(collected));
    const diff = relationDiff(localRelations, zipBundle.relationsDoc.relations);
    const manifestCounts = zipBundle.manifest.counts;
    const localCounts = {
      lists: collected.lists.length, tasks: collected.tasks.length, subtasks: collected.subtasks.length,
      notes: collected.notes.length, noteBlocks: collected.noteBlocks.length, noteTodos: collected.noteTodos.length,
      events: collected.events.length, countdowns: collected.countdowns.length, habits: collected.habits.length,
      habitLogs: collected.habitLogs.length, focusSessions: collected.focusSessions.length,
      reviewSnapshots: collected.reviewSnapshots.length, boards: collected.boards.length,
      boardNodes: collected.boards.reduce((sum, board) => sum + board.nodes.length, 0),
      boardEdges: collected.boards.reduce((sum, board) => sum + board.edges.length, 0),
      attachments: collected.attachments.length,
    };
    const countMismatch = Object.entries(manifestCounts)
      .filter(([key, value]) => key !== 'settings' && localCounts[key] !== value)
      .map(([key, value]) => `${key}: manifest=${value} local=${localCounts[key]}`);
    const attachmentEntry = zipBundle.manifest.attachments.find((item) => item.id === fixture.ids.attachment);
    const attachmentFile = attachmentEntry?.path ? zipBundle.map.get(attachmentEntry.path) : null;
    const boardEntry = zipBundle.manifest.boards.find((item) => item.id === fixture.ids.board);
    const boardFile = boardEntry ? zipBundle.map.get(boardEntry.path) : null;
    const boardDoc = boardFile ? JSON.parse(boardFile.data.toString('utf8')) : null;
    const exportedKeys = zipBundle.manifest.settings.exportedKeys;
    const report = {
      entries: zipBundle.entries.length,
      paths: zipBundle.entries.map((entry) => entry.path),
      integrity,
      relationsInZip: zipBundle.relationsDoc.relations.length,
      relationsLocal: localRelations.length,
      relationDiff: diff,
      dangling: zipBundle.relationsDoc.dangling.length,
      manifestCounts,
      localCounts,
      countMismatch,
      attachment: { id: fixture.ids.attachment, present: Boolean(attachmentFile), shaOk: Boolean(attachmentFile) && attachmentFile.sha256 === ATTACHMENT_SHA, byteSize: attachmentFile?.byteSize, declaredSize: attachmentEntry?.byteSize },
      board: { nodes: boardDoc?.nodes?.length, edges: boardDoc?.edges?.length, shaOk: Boolean(boardFile) && boardEntry.sha256 === boardFile.sha256 },
      settings: { exportedKeys, excludedKeys: zipBundle.manifest.settings.excludedKeys, hasSecretValue: zipBundle.entries.some((entry) => entry.data.includes('super-secret')) },
      security: zipBundle.manifest.security,
      exportedAt: zipBundle.manifest.exportedAt,
      appVersion: zipBundle.manifest.appVersion,
      schemaVersion: zipBundle.manifest.schemaVersion,
    };
    fs.writeFileSync(path.join(EVIDENCE, '02-zip-verification.json'), JSON.stringify(report, null, 2));
    const pass =
      integrity.allPresent && integrity.allSizeOk && integrity.allShaOk && integrity.allCrcOk &&
      countMismatch.length === 0 && diff.missing.length === 0 && diff.extra.length === 0 &&
      report.attachment.present && report.attachment.shaOk &&
      report.board.shaOk && report.board.nodes === 2 && report.board.edges === 1 &&
      !report.settings.hasSecretValue &&
      !exportedKeys.includes('sync.webdavPassword') &&
      zipBundle.manifest.settings.excludedKeys.includes('sync.webdavPassword') &&
      report.dangling === 0;
    return { pass, report };
  }).then((result) => {
    if (!result.ok) {
      record('C-zip', 'F-036', 'ZIP 独立校验', 'fail', 'manifest/哈希/计数/关系一致', `异常：${result.error.message}`);
      return;
    }
    const report = result.value.report;
    record('C-zip', 'F-036',
      'ZIP：manifest 条目 SHA-256/大小/CRC 全一致，计数与关系无丢失，附件二进制可还原，敏感设置被排除',
      result.value.pass ? 'pass' : 'fail',
      'integrity 全绿、countMismatch=[]、relationDiff 无缺失、dangling=0、附件 SHA 一致、无 webdavPassword',
      `entries=${report.entries}；integrity=${JSON.stringify(report.integrity)}；关系 备份=${report.relationsInZip} 本机=${report.relationsLocal}；dangling=${report.dangling}；countMismatch=${JSON.stringify(report.countMismatch)}；附件 shaOk=${report.attachment.shaOk} (${report.attachment.byteSize}/${report.attachment.declaredSize} B)；画板 ${report.board.nodes} 节点/${report.board.edges} 连线；排除键=${report.settings.excludedKeys.join(',')}`,
      'tests/evidence/aud018/02-zip-verification.json');
  });

  await step('C-json', 'F-036', 'JSON 独立校验', async () => {
    const doc = JSON.parse(fs.readFileSync(exportBy.json, 'utf8'));
    const collected = await call('collect');
    const diff = relationDiff(collectRelations(datasetFromCollect(collected)), doc.relations);
    const report = {
      app: doc.app, kind: doc.kind, formatVersion: doc.formatVersion,
      exportedAt: doc.exportedAt, appVersion: doc.appVersion, schemaVersion: doc.schemaVersion,
      counts: doc.manifest.counts,
      notesInDataset: doc.dataset.notes.length, tasksInDataset: doc.dataset.tasks.length,
      boardsInDataset: doc.dataset.boards.length,
      relationTotal: doc.relations.length, relationDiff: diff, dangling: doc.manifest.relations.dangling.length,
      excludedSettings: doc.excludedSettings,
      excludedHasSecret: (doc.excludedSettings ?? []).includes('sync.webdavPassword'),
      attachmentPathField: doc.manifest.attachments.length === 0
        ? 'none'
        : Object.prototype.hasOwnProperty.call(doc.manifest.attachments[0], 'path')
          ? doc.manifest.attachments[0].path
          : 'missing',
      blobLeak: JSON.stringify(doc).includes('AUD-018 attachment payload'),
      secretLeak: JSON.stringify(doc).includes('super-secret'),
    };
    fs.writeFileSync(path.join(EVIDENCE, '03-json-verification.json'), JSON.stringify(report, null, 2));
    const pass =
      doc.app === 'zhixing' && doc.kind === 'backup' && doc.formatVersion === 1 &&
      diff.missing.length === 0 && diff.extra.length === 0 && report.dangling === 0 &&
      report.notesInDataset === report.counts.notes && report.tasksInDataset === report.counts.tasks &&
      (report.attachmentPathField === null || report.attachmentPathField === 'none') &&
      !report.blobLeak && !report.secretLeak && report.excludedHasSecret;
    return { pass, report };
  }).then((result) => {
    record('C-json', 'F-036',
      'JSON：formatVersion=1，计数一致，关系零差异，附件仅元数据，敏感设置排除',
      result.ok && result.value.pass ? 'pass' : 'fail',
      '关系 zero diff、dangling=0、dataset 计数=manifest、attachments[].path=null、无二进制/敏感值',
      result.ok
        ? JSON.stringify({
            counts: result.value.report.counts,
            relations: result.value.report.relationTotal,
            diff: result.value.report.relationDiff,
            dangling: result.value.report.dangling,
            excluded: result.value.report.excludedSettings,
            attachmentPath: result.value.report.attachmentPathField,
            blobLeak: result.value.report.blobLeak,
            secretLeak: result.value.report.secretLeak,
          })
        : `异常：${result.error.message}`,
      'tests/evidence/aud018/03-json-verification.json');
  });

  await step('C-markdown', 'F-036', 'Markdown 独立校验', async () => {
    const text = fs.readFileSync(exportBy.markdown, 'utf8');
    const collected = await call('collect');
    const relations = collectRelations(datasetFromCollect(collected));
    const relationLines = text.split('\n').filter((line) => /^- .+ `.+` · .+ → .+ `.+`（.+）$/.test(line));
    const report = {
      byteSize: Buffer.byteLength(text),
      titleLine: text.split('\n')[0],
      hasTask: text.includes('AUD-018 主任务（关联笔记）'),
      hasTrashTask: text.includes('AUD-018 已删除任务（回收站）'),
      hasNote: text.includes('### AUD-018 关系总集'),
      hasTrashNote: text.includes('AUD-018 回收站笔记（回收站）'),
      hasBoard: text.includes('### AUD-018 关系画板'),
      hasAttachment: text.includes('aud018-attachment.txt') && text.includes(ATTACHMENT_SHA),
      hasSettings: text.includes('`editor.fontSize` = 17'),
      hasSecret: text.includes('super-secret') || text.includes('webdavPassword'),
      relationLines: relationLines.length,
      relationsLocal: relations.length,
      blobLeak: text.includes('AUD-018 attachment payload'),
    };
    fs.writeFileSync(path.join(EVIDENCE, '04-markdown-head.txt'), `${text.split('\n').slice(0, 70).join('\n')}\n`);
    const pass =
      report.titleLine === '# 知行 · 完整导出' && report.hasTask && report.hasTrashTask && report.hasNote &&
      report.hasTrashNote && report.hasBoard && report.hasAttachment && report.hasSettings &&
      !report.hasSecret && !report.blobLeak && report.relationLines === report.relationsLocal;
    return { pass, report };
  }).then((result) => {
    record('C-markdown', 'F-036',
      'Markdown：任务/笔记/画板/附件哈希/关系/白名单设置齐全，不含附件二进制与敏感键',
      result.ok && result.value.pass ? 'pass' : 'fail',
      '标题行正确、关键对象存在、关系行数=关系总数、无敏感值',
      result.ok
        ? JSON.stringify({
            size: result.value.report.byteSize,
            relationLines: result.value.report.relationLines,
            relationsLocal: result.value.report.relationsLocal,
            hasSecret: result.value.report.hasSecret,
            blobLeak: result.value.report.blobLeak,
            flags: ['hasTask', 'hasTrashTask', 'hasNote', 'hasTrashNote', 'hasBoard', 'hasAttachment', 'hasSettings'].filter((key) => result.value.report[key] === false),
          })
        : `异常：${result.error.message}`,
      'tests/evidence/aud018/04-markdown-head.txt');
  });

  await step('C-csv', 'F-036', 'CSV 独立校验', async () => {
    const csvEntries = readZip(fs.readFileSync(exportBy.csv));
    const map = new Map(csvEntries.map((entry) => [entry.path, entry]));
    const parse = (name) => {
      const entry = map.get(name);
      if (!entry) return null;
      const rows = csvParse(entry.data.toString('utf8').replace(/^﻿/, ''));
      return { header: rows[0], rows: rows.slice(1).filter((row) => row.length > 1) };
    };
    const names = ['lists.csv', 'tasks.csv', 'subtasks.csv', 'notes.csv', 'note_blocks.csv', 'note_todos.csv',
      'events.csv', 'countdowns.csv', 'habits.csv', 'habit_logs.csv', 'focus_sessions.csv',
      'review_snapshots.csv', 'boards.csv', 'attachments.csv', 'settings.csv', 'relations.csv'];
    const tables = Object.fromEntries(names.map((name) => [name, parse(name)]));
    const collected = await call('collect');
    const relations = collectRelations(datasetFromCollect(collected));
    const counts = {
      tasks: tables['tasks.csv'].rows.length, notes: tables['notes.csv'].rows.length,
      subtasks: tables['subtasks.csv'].rows.length, noteBlocks: tables['note_blocks.csv'].rows.length,
      noteTodos: tables['note_todos.csv'].rows.length, events: tables['events.csv'].rows.length,
      habits: tables['habits.csv'].rows.length, habitLogs: tables['habit_logs.csv'].rows.length,
      focusSessions: tables['focus_sessions.csv'].rows.length,
      reviewSnapshots: tables['review_snapshots.csv'].rows.length,
      boards: tables['boards.csv'].rows.length, attachments: tables['attachments.csv'].rows.length,
      relations: tables['relations.csv'].rows.length,
    };
    const local = {
      tasks: collected.tasks.length, notes: collected.notes.length, subtasks: collected.subtasks.length,
      noteBlocks: collected.noteBlocks.length, noteTodos: collected.noteTodos.length,
      events: collected.events.length, habits: collected.habits.length, habitLogs: collected.habitLogs.length,
      focusSessions: collected.focusSessions.length, reviewSnapshots: collected.reviewSnapshots.length,
      boards: collected.boards.length, attachments: collected.attachments.length, relations: relations.length,
    };
    const tasksCsv = map.get('tasks.csv').data;
    const report = {
      files: csvEntries.map((entry) => entry.path),
      manifest: JSON.parse(map.get('manifest.json').data.toString('utf8')),
      counts, local,
      bom: `${tasksCsv[0]},${tasksCsv[1]},${tasksCsv[2]}` === '239,187,191',
      crcAllOk: csvEntries.every((entry) => entry.crcOk),
      noteBodyQuoted: tables['notes.csv'].rows.some((row) => row.join(',').includes('<h2>关系总集</h2>')),
      missingTables: names.filter((name) => !tables[name]),
    };
    fs.writeFileSync(path.join(EVIDENCE, '05-csv-verification.json'), JSON.stringify(report, null, 2));
    const mismatch = Object.entries(counts).filter(([key, value]) => local[key] !== value);
    return { pass: report.missingTables.length === 0 && mismatch.length === 0 && report.crcAllOk && report.bom && report.noteBodyQuoted, report, mismatch };
  }).then((result) => {
    record('C-csv', 'F-036',
      'CSV：16 张表行数与数据库一致，关系表=关系总数，UTF-8 BOM 与 CRC 正确',
      result.ok && result.value.pass ? 'pass' : 'fail',
      '每张表行数=本机行数、relations.csv=关系总数、BOM 存在、CRC 全通过',
      result.ok
        ? `counts=${JSON.stringify(result.value.report.counts)}；mismatch=${JSON.stringify(result.value.mismatch)}；crc=${result.value.report.crcAllOk}；bom=${result.value.report.bom}；noteBodyQuoted=${result.value.report.noteBodyQuoted}；missing=${JSON.stringify(result.value.report.missingTables)}`
        : `异常：${result.error.message}`,
      'tests/evidence/aud018/05-csv-verification.json');
  });

  await step('C-pdf', 'F-036', 'PDF 独立校验', async () => {
    const stat = fileStat(exportBy.pdf);
    const info = inspectPdf(stat.buffer);
    fs.writeFileSync(path.join(EVIDENCE, '06-pdf-verification.json'), JSON.stringify({ ...info, file: stat.file, sha256: stat.sha256 }, null, 2));
    return { pass: info.headerOk && info.pageCount > 0 && info.jpegCount > 0 && info.hasEof && info.xrefOk, info };
  }).then((result) => {
    record('C-pdf', 'F-036',
      'PDF：真实 PDF（%PDF-1.4 头、页对象、DCTDecode JPEG、xref、%%EOF）',
      result.ok && result.value.pass ? 'pass' : 'fail',
      'headerOk、pageCount>0、jpegCount>0、xrefOk、hasEof',
      result.ok ? JSON.stringify(result.value.info) : `异常：${result.error.message}`,
      'tests/evidence/aud018/06-pdf-verification.json');
  });

  // A5 冲突：修改本机同 ID 对象
  await step('F-1', 'F-036', '制造冲突', async () => {
    const note = await ipc('notes_get', { id: fixture.ids.noteA });
    await ipc('notes_update', {
      id: note.id,
      input: {
        title: 'AUD-018 关系总集（本机修改版）', folderId: note.folderId, tags: [...note.tags, '本机'],
        body: '<p>本机修改的正文 —— 冲突来源</p>', bodyFormat: note.bodyFormat, favorite: note.favorite, pinned: note.pinned,
      },
    });
    const task = await ipc('tasks_get', { id: fixture.ids.taskMain });
    for (let index = 0; index < 4; index += 1) {
      await ipc('tasks_update', {
        id: task.id,
        input: {
          listId: task.listId, parentId: task.parentId, noteId: task.noteId,
          title: `AUD-018 主任务（本机改名 v${index + 2}）`, notes: `本机改写的要点 ${index + 2}`,
          status: task.status, priority: 2, quadrant: 2, dueDate: task.dueDate, dueTime: task.dueTime,
          dueAt: task.dueAt, tz: task.tz, reminder: task.reminder, sortOrder: task.sortOrder,
        },
      });
    }
    const duplicate = await ipc('lists_create', { input: { id: 'aud018-list-same-name', name: '工作', sortOrder: 99 } });
    const localTask = await ipc('tasks_get', { id: fixture.ids.taskMain });
    const localNote = await ipc('notes_get', { id: fixture.ids.noteA });
    const backupTask = zipBundle.dataset.tasks.find((row) => row.id === fixture.ids.taskMain);
    return {
      localTaskVersion: localTask.version, backupTaskVersion: backupTask.version,
      localTaskTitle: localTask.title, localNoteTitle: localNote.title, duplicateListName: duplicate.name,
    };
  }).then((result) => {
    record('F-1', 'F-036',
      '制造冲突（同 ID 内容修改 + version 提升 + 同名清单）',
      result.ok && result.value.localTaskVersion > result.value.backupTaskVersion ? 'pass' : 'fail',
      '本机 version > 备份 version',
      result.ok ? JSON.stringify(result.value) : `异常：${result.error.message}`);
  });

  await step('F-2', 'F-036', '冲突预览', async () => {
    await openDataPanel();
    await chooseBackup(exportBy.zip);
    const dialog = await call('waitDialog', 60_000);
    if (!dialog) throw new Error('未打开恢复预览');
    fs.writeFileSync(path.join(EVIDENCE, '10-conflict-preview.html'), (await call('html', '[role="dialog"]')) ?? '');
    return dialog;
  }).then((result) => {
    if (!result.ok) {
      record('F-2', 'F-036', '冲突预览列出冲突并默认跳过', 'fail', '冲突数 > 0 且默认 skip', `异常：${result.error.message}`);
      return;
    }
    const dialog = result.value;
    const defaultsAllSkip = dialog.conflicts.every((conflict) => {
      const checked = conflict.choices.find((choice) => choice.checked);
      return !checked || checked.value === 'skip';
    });
    evidence.conflictDialog = dialog;
    record('F-2', 'F-036',
      '冲突预览列出冲突项、默认「跳过（保留本机）」',
      dialog.conflicts.length > 0 && defaultsAllSkip ? 'pass' : 'fail',
      '冲突数 > 0，默认 skip',
      `冲突 ${dialog.conflicts.length} 项：${dialog.conflicts.map((c) => `${c.label}[${c.choices.map((x) => `${x.value}${x.checked ? '*' : ''}${x.disabled ? '(禁用)' : ''}`).join('/')}]`).join('；')}；${dialog.inline}`,
      'tests/evidence/aud018/10-conflict-preview.html');
  });

  await step('F-3', 'F-036', '默认跳过执行', async () => {
    await call('click', '确认恢复', '[role="dialog"]');
    await call('waitText', '恢复完成', 180_000);
    const finished = await call('dialog');
    await call('click', '完成', '[role="dialog"]');
    await sleep(400);
    const note = await ipc('notes_get', { id: fixture.ids.noteA });
    const task = await ipc('tasks_get', { id: fixture.ids.taskMain });
    return { success: finished.success, summary: finished.tiles, noteTitle: note.title, noteBody: note.body, taskTitle: task.title, taskVersion: task.version };
  }).then((result) => {
    const value = result.ok ? result.value : {};
    const pass = result.ok && value.noteTitle.includes('本机修改版') && value.noteBody.includes('本机修改的正文') && value.taskTitle.includes('本机改名');
    record('F-3', 'F-036',
      '默认跳过：冲突对象保持本机版本（不静默覆盖）',
      pass ? 'pass' : 'fail',
      '笔记标题含「本机修改版」、正文含「本机修改的正文」、任务标题含「本机改名」',
      result.ok ? JSON.stringify(value) : `异常：${result.error.message}`);
  });

  await step('F-4', 'F-036', '保留两者', async () => {
    await openDataPanel();
    await chooseBackup(exportBy.zip);
    const dialog = await call('waitDialog', 60_000);
    if (!dialog) throw new Error('未打开恢复预览');
    const noteConflict = dialog.conflicts.find((c) => c.label.includes('AUD-018 关系总集'));
    const taskConflictKeep = dialog.conflicts.find((c) => c.label.includes('AUD-018 主任务'));
    if (!noteConflict) throw new Error(`找不到笔记冲突项：${JSON.stringify(dialog.conflicts.map((c) => c.label))}`);
    const pick = await call('conflict', noteConflict.label, '保留两者');
    // 笔记待办指向主任务；主任务也选「保留两者」，引用才能解析到新任务而不是被阻止
    // （产品文档：父对象被跳过/阻止时，依赖它的新对象也会被阻止）。
    const taskPick = taskConflictKeep
      ? await call('conflict', taskConflictKeep.label, '保留两者')
      : null;
    await sleep(250);
    const dialog2 = await call('dialog');
    const planSteps = (await call('operationSteps')) ?? [];
    const blockedBefore = dialog2.blocked;
    const tilesBefore = Object.fromEntries(dialog2.tiles.map((tile) => [tile.label, tile.value]));
    await call('click', '确认恢复', '[role="dialog"]');
    await call('waitText', '恢复完成', 180_000);
    const finished = await call('dialog');
    await call('click', '完成', '[role="dialog"]');
    await sleep(400);
    const collected = await call('collect');
    const named = collected.notes.filter((note) => note.title.includes('AUD-018 关系总集'));
    const copy = named.find((note) => note.id !== fixture.ids.noteA);
    const copyTodo = copy ? collected.noteTodos.find((todo) => todo.noteId === copy.id) : null;
    const newTask = collected.tasks.find((task) => task.id !== fixture.ids.taskMain && task.title === 'AUD-018 主任务（关联笔记）');
    return {
      pick, taskPick, steps: dialog2.steps, planSteps: planSteps.slice(0, 8), blockedBefore, tilesBefore,
      success: finished.success, summary: finished.tiles,
      copyTodoTaskId: copyTodo?.taskId ?? null,
      newTaskId: newTask?.id ?? null,
      copyTodoRemapped: Boolean(copyTodo && newTask && copyTodo.taskId === newTask.id),
      notes: named.map((note) => ({ id: note.id, title: note.title, deleted: Boolean(note.deletedAt) })),
      copyId: copy?.id ?? null,
      copyTitle: copy?.title ?? null,
      copyBlocks: copy ? collected.noteBlocks.filter((block) => block.noteId === copy.id).length : 0,
      copyTodos: copy ? collected.noteTodos.filter((todo) => todo.noteId === copy.id).length : 0,
      copyLinks: copy ? {
        events: collected.events.filter((event) => event.noteId === copy.id).length,
        boards: collected.boards.filter((bundle) => bundle.board.noteId === copy.id).length,
        attachments: collected.attachments.filter((att) => att.noteId === copy.id).length,
        tasks: collected.tasks.filter((task) => task.noteId === copy.id).length,
      } : null,
      originalBlocks: collected.noteBlocks.filter((block) => block.noteId === fixture.ids.noteA).length,
      originalTodos: collected.noteTodos.filter((todo) => todo.noteId === fixture.ids.noteA).length,
    };
  }).then((result) => {
    const value = result.ok ? result.value : {};
    const pass = result.ok && Boolean(value.copyId) && value.copyId !== fixture.ids.noteA &&
      value.copyBlocks >= 1 && value.copyTodos >= 1 && value.copyTodoRemapped;
    record('F-4', 'F-036',
      '「保留两者」生成新笔记 ID，直属块/待办随复制，待办引用重映射到新任务',
      pass ? 'pass' : 'fail',
      '新笔记 id ≠ 原 id、直属块≥1、待办≥1、待办 taskId = 新任务 id（不是原任务）',
      result.ok ? JSON.stringify(value) : `异常：${result.error.message}`);
  });

  await step('F-5', 'F-036', '覆盖需显式勾选', async () => {
    await openDataPanel();
    await chooseBackup(exportBy.zip);
    let dialog = await call('waitDialog', 60_000);
    if (!dialog) throw new Error('未打开恢复预览');
    const noteConflict = dialog.conflicts.find((c) => c.label.includes('AUD-018 关系总集'));
    const taskConflict = dialog.conflicts.find((c) => c.label.includes('AUD-018 主任务'));
    if (!noteConflict) throw new Error('找不到笔记冲突项');
    const beforeToggle = await call('conflict', noteConflict.label, '覆盖本机');
    await call('overwrite', true);
    await sleep(250);
    const afterToggle = await call('conflict', noteConflict.label, '覆盖本机');
    if (taskConflict) await call('conflict', taskConflict.label, '覆盖本机');
    await sleep(250);
    dialog = await call('dialog');
    const overwriteStates = dialog.conflicts.map((c) => ({
      label: c.label,
      checked: c.choices.find((choice) => choice.checked)?.value ?? null,
      overwriteDisabled: c.choices.find((choice) => choice.value === 'overwrite')?.disabled ?? null,
    }));
    await call('click', '确认恢复', '[role="dialog"]');
    await call('waitText', '恢复完成', 180_000);
    const finished = await call('dialog');
    await call('click', '完成', '[role="dialog"]');
    await sleep(400);
    const note = await ipc('notes_get', { id: fixture.ids.noteA });
    const task = await ipc('tasks_get', { id: fixture.ids.taskMain });
    const collected = await call('collect');
    const diff = relationDiff(collectRelations(zipBundle.dataset), collectRelations(datasetFromCollect(collected)));
    return { beforeToggle, afterToggle, overwriteStates, success: finished.success, summary: finished.tiles, noteTitle: note.title, noteBody: note.body, taskTitle: task.title, relationDiff: diff };
  }).then((result) => {
    const value = result.ok ? result.value : {};
    const pass =
      result.ok && value.beforeToggle?.disabled === true && value.afterToggle?.disabled === false &&
      value.noteTitle === 'AUD-018 关系总集' && value.noteBody.includes('关系总集') &&
      value.taskTitle === 'AUD-018 主任务（关联笔记）' && value.relationDiff.missing.length === 0;
    record('F-5', 'F-036',
      '覆盖需显式勾选；勾选后本机被备份覆盖，关系不回退为 null',
      pass ? 'pass' : 'fail',
      '未勾选 overwrite 禁用；勾选后笔记/任务回到备份内容；关系零缺失',
      result.ok ? JSON.stringify(value) : `异常：${result.error.message}`);
  });

  // A6 删除语义
  await step('G-1', 'F-036', '恢复删除语义', async () => {
    await ipc('tasks_restore', { id: fixture.ids.trashTask });
    const active = await ipc('tasks_get', { id: fixture.ids.trashTask });
    await openDataPanel();
    await chooseBackup(exportBy.zip);
    const dialog = await call('waitDialog', 60_000);
    if (!dialog) throw new Error('未打开恢复预览');
    const tiles = Object.fromEntries(dialog.tiles.map((tile) => [tile.label, tile.value]));
    const trashConflict = dialog.conflicts.find((c) => c.label.includes('AUD-018 已删除任务'));
    const noteConflict = dialog.conflicts.find((c) => c.label.includes('AUD-018 回收站笔记'));
    await call('overwrite', true);
    if (trashConflict) await call('conflict', trashConflict.label, '覆盖本机');
    if (noteConflict) await call('conflict', noteConflict.label, '覆盖本机');
    await sleep(250);
    const dialog2 = await call('dialog');
    await call('click', '确认恢复', '[role="dialog"]');
    await call('waitText', '恢复完成', 180_000);
    const finished = await call('dialog');
    await call('click', '完成', '[role="dialog"]');
    await sleep(400);
    const rows = await call('collect');
    const task = rows.tasks.find((row) => row.id === fixture.ids.trashTask);
    const note = rows.notes.find((row) => row.id === fixture.ids.noteB);
    return {
      activeBefore: !active.deletedAt,
      tiles,
      tilesAfterChoice: Object.fromEntries(dialog2.tiles.map((tile) => [tile.label, tile.value])),
      conflicts: dialog.conflicts.map((c) => c.label),
      success: finished.success,
      trashTaskDeletedAfter: Boolean(task?.deletedAt),
      trashNoteDeletedAfter: Boolean(note?.deletedAt),
    };
  }).then((result) => {
    const value = result.ok ? result.value : {};
    record('G-1', 'F-036',
      '恢复删除语义：备份里的回收站对象在本机保持回收站（不静默复活）',
      result.ok && value.trashTaskDeletedAfter && value.trashNoteDeletedAfter ? 'pass' : 'fail',
      '本机原先活动 → 恢复后 deleted_at 非空；回收站笔记保持回收站',
      result.ok ? JSON.stringify(value) : `异常：${result.error.message}`);
  });

  // A7 快速连点（真实物理节奏 60ms，另记录同任务 0ms 的极限情况）
  await step('H-1', 'F-036', '快速连点导出', async () => {
    await openDataPanel();
    await call('clearConsole');
    const before = desktop.listExports().length;
    const rapid = await call('clickTwice', '导出 ZIP', 60);
    await waitPanelSettled();
    await sleep(1500);
    const after = desktop.listExports().length;
    const consoleState = await call('console');
    // 同一事件里连点两次（真实双击最快形态），单独取证。
    const beforeSameTick = desktop.listExports().length;
    const sameTick = await call('evalExpr', `(() => {
      const btn = Array.from(document.querySelectorAll('.settings-body button')).find((b) => b.textContent.trim() === '导出 ZIP');
      const states = [{ tag: 'before', disabled: btn.disabled }];
      btn.click(); states.push({ tag: 'after1', disabled: btn.disabled });
      btn.click(); states.push({ tag: 'after2', disabled: btn.disabled });
      return states;
    })()`);
    await waitPanelSettled();
    await sleep(1500);
    const afterSameTick = desktop.listExports().length;
    const finalConsole = await call('console');
    const fresh = desktop.listExports().slice(before);
    return {
      rapid, before, after, delta: after - before,
      sameTick, sameTickDelta: afterSameTick - beforeSameTick,
      errors: finalConsole.errors, warns: finalConsole.warns,
      files: fresh.map((item) => ({ name: item.name, size: item.size })),
    };
  }).then((result) => {
    const value = result.ok ? result.value : {};
    // 两个子场景分开判定：60ms 间隔属于真实连续点击；同 tick 双击是极限形态。
    const spacedOk = (value.delta ?? 2) <= 1;
    const busyApplied = value.rapid?.afterFirst === true || value.rapid?.afterSecond === true;
    record('H-1', 'F-036',
      '快速连点导出 ZIP（60ms 间隔，真实连续点击）：首击后按钮 busy，只落一个文件',
      result.ok && spacedOk && busyApplied && (value.errors ?? []).length === 0 ? 'pass' : 'fail',
      '真实导出目录新增 ≤ 1 个文件；首击后按钮 disabled=true；控制台无错误',
      result.ok ? JSON.stringify(value) : `异常：${result.error.message}`);
  });

  // A7b 极快双击（同一次事件循环内两次 click）：单独记录产品行为。
  await step('H-1b', 'F-036', '同一事件内双击导出', async () => {
    await openDataPanel();
    const before = desktop.listExports().length;
    const states = await call('evalExpr', `(() => {
      const btn = Array.from(document.querySelectorAll('.settings-body button')).find((b) => b.textContent.trim() === '导出 ZIP');
      const out = [{ tag: 'before', disabled: btn.disabled }];
      btn.click(); out.push({ tag: 'after1', disabled: btn.disabled });
      btn.click(); out.push({ tag: 'after2', disabled: btn.disabled });
      return out;
    })()`);
    await waitPanelSettled();
    await sleep(1500);
    const after = desktop.listExports().length;
    return { states, before, after, delta: after - before };
  }).then((result) => {
    const value = result.ok ? result.value : {};
    record('H-1b', 'F-036',
      '同一事件循环内连点两次「导出 ZIP」：是否被 busy 互斥拦截',
      result.ok && (value.delta ?? 2) <= 1 ? 'pass' : 'fail',
      '两次 click 落在同一 React 提交前，第二次不应再产生文件',
      result.ok ? JSON.stringify(value) : `异常：${result.error.message}`);
  });

  // A8 同一数据重复导出：内容与关系必须稳定
  await step('C-stable', 'F-036', '重复导出稳定性', async () => {
    // 基准必须是「同一库状态下的连续两次导出」；不能用很早之前的 exportBy.zip。
    await openDataPanel();
    const beforeFirst = desktop.listExports();
    await call('click', '导出 ZIP', '.settings-body');
    const firstFile = await desktop.waitNewExport(beforeFirst);
    await waitPanelSettled();
    await sleep(300);
    const beforeSecond = desktop.listExports();
    await call('click', '导出 ZIP', '.settings-body');
    const secondFile = await desktop.waitNewExport(beforeSecond);
    await waitPanelSettled();
    const file = secondFile;
    const first = bundleFromZip(firstFile.file);
    const second = bundleFromZip(secondFile.file);
    const second2 = bundleFromZip(secondFile.file);
    const diff = fidelityDiff(first.dataset, second.dataset);
    const relationsSame = relationSetDiff(
      collectRelations(first.dataset),
      collectRelations(second.dataset),
      first.dataset,
      second.dataset,
    );
    // 同一份备份连读两次，哈希必须完全一致（排除 ZIP 读取不确定性）。
    const readStability = sha256(Buffer.from(JSON.stringify(stripVolatile(second.dataset)))) ===
      sha256(Buffer.from(JSON.stringify(stripVolatile(second2.dataset))));
    return {
      fidelity: { ok: diff.ok, problems: diff.problems.slice(0, 6), summary: diff.summary },
      relationsSame,
      readStability,
      firstFile: firstFile.file,
      secondFile: secondFile.file,
      firstSha: fileStat(firstFile.file).sha256,
      secondSha: fileStat(secondFile.file).sha256,
    };
  }).then((result) => {
    const value = result.ok ? result.value : {};
    record('C-stable', 'F-036',
      '同一数据重复导出：内容与关系集合一致（只有导出时间戳不同）',
      result.ok && value.fidelity.ok && value.relationsSame.missing.length === 0 &&
        value.relationsSame.extra.length === 0 && value.readStability ? 'pass' : 'fail',
      '两次导出的 dataset 逐字段一致、关系零差异；文件级 SHA 允许不同（含导出时间）',
      result.ok ? JSON.stringify(value) : `异常：${result.error.message}`);
  });

  evidence.zipDataset = {
    relations: collectRelations(zipBundle.dataset).length,
    counts: zipBundle.manifest.counts,
  };
  await desktop.stop();
  active = null;
}

// ---------------------------------------------------------------------------
// 阶段 B：全新库恢复 + 空数据 + 坏文件 + 刷新持久化
// ---------------------------------------------------------------------------
async function phaseB() {
  const desktop = new Desktop('b');
  active = desktop;
  await desktop.start();
  evidence.runtimeB = { label: 'B', dbPath: desktop.dbPath, trial: desktop.trial, status: desktop.status };
  log('实例 B（全新库）就绪', evidence.runtimeB);

  const before = await dbSnapshot(desktop);
  evidence.cleanBefore = before;

  // B1 坏文件
  await step('D-corrupt', 'F-036', '坏备份被拒绝', async () => {
    const zipBuffer = fs.readFileSync(exportBy.zip);
    const tampered = Buffer.from(zipBuffer);
    const idx = tampered.indexOf('AUD-018 关系总集');
    if (idx < 0) throw new Error('ZIP 内找不到可篡改内容');
    tampered[idx] = 'X'.charCodeAt(0);
    const files = {
      'tampered.zip': tampered,
      'empty.zip': Buffer.alloc(0),
      'no-manifest.zip': Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]),
      'not-zip.json': Buffer.from('{"hello":1}'),
    };
    const uploads = path.join(WORK, 'bad-files');
    fs.mkdirSync(uploads, { recursive: true });
    const outcomes = [];
    for (const [name, buffer] of Object.entries(files)) {
      const file = path.join(uploads, name);
      fs.writeFileSync(file, buffer);
      await openDataPanel();
      await chooseBackup(file);
      await sleep(1500);
      const state = await call('state');
      outcomes.push({ file: name, dialogOpen: state.modalOpen, error: state.panel.error, notice: state.panel.notice });
    }
    fs.writeFileSync(path.join(EVIDENCE, '07-bad-files.json'), JSON.stringify(outcomes, null, 2));
    return outcomes;
  }).then((result) => {
    const outcomes = result.ok ? result.value : [];
    const pass = result.ok && outcomes.length === 4 && outcomes.every((item) => item.dialogOpen === false && item.error && item.error.length > 0);
    record('D-corrupt', 'F-036',
      '损坏/空/缺 manifest/非 ZIP 备份被拒绝（不打开恢复预览，给出错误文案）',
      pass ? 'pass' : 'fail',
      '四种坏文件都不打开预览且显示错误',
      result.ok ? JSON.stringify(outcomes) : `异常：${result.error.message}`,
      'tests/evidence/aud018/07-bad-files.json');
  });

  // B2 干净库恢复 ZIP
  const cleanBefore = await call('collect');
  const relationsBackup = collectRelations(zipBundle.dataset);
  // macOS WKWebView 的 IndexedDB 不随 HOME 隔离：先清空，才能证明 ZIP 恢复自己写入附件。
  await call('clearAttachmentStore');
  const blobBeforeRestore = await call('blobStat', ATTACHMENT_SHA);
  await step('E-2', 'F-036', '全新库从 ZIP 恢复', async () => {
    await openDataPanel();
    await chooseBackup(exportBy.zip);
    const dialog = await call('waitDialog', 60_000);
    if (!dialog) throw new Error('ZIP 未打开恢复预览');
    const previewTiles = Object.fromEntries(dialog.tiles.map((tile) => [tile.label, tile.value]));
    const previewInline = dialog.inline;
    const conflicts = dialog.conflicts.map((c) => ({ label: c.label, checked: c.choices.find((x) => x.checked)?.value ?? null }));
    fs.writeFileSync(path.join(EVIDENCE, '08-restore-preview.html'), (await call('html', '[role="dialog"]')) ?? '');
    // 全新库仍带种子（收件箱/工作/示例笔记…），同 ID 对象默认「跳过」——
    // 这是产品既定语义。要真正复刻备份，必须显式勾选覆盖（与真实用户操作一致）。
    const overwrite = await call('overwriteAll');
    await sleep(300);
    const dialogAfterChoice = await call('dialog');
    await call('click', '确认恢复', '[role="dialog"]');
    await call('waitText', '恢复完成', 240_000);
    const finished = await call('dialog');
    fs.writeFileSync(path.join(EVIDENCE, '09-restore-result.html'), (await call('html', '[role="dialog"]')) ?? '');
    await call('click', '完成', '[role="dialog"]');
    await sleep(600);
    const after = await call('collect');
    const afterDataset = datasetFromCollect(after);
    const diff = relationSetDiff(relationsBackup, collectRelations(afterDataset), zipBundle.dataset, afterDataset);
    const fidelity = fidelityDiff(zipBundle.dataset, after);
    const blob = await call('blobStat', ATTACHMENT_SHA);
    return {
      previewTiles, previewInline, conflicts, overwrite,
      previewTilesAfterChoice: Object.fromEntries(dialogAfterChoice.tiles.map((tile) => [tile.label, tile.value])),
      success: finished.success, summary: finished.tiles,
      progress: finished.progress, steps: finished.steps,
      relationDiff: diff,
      fidelity: { ok: fidelity.ok, problems: fidelity.problems.slice(0, 8), summary: fidelity.summary },
      blobBefore: blobBeforeRestore,
      blob,
      activeAfter: {
        tasks: after.tasks.filter((row) => !row.deletedAt).length,
        notes: after.notes.filter((row) => !row.deletedAt).length,
        boards: after.boards.filter((bundle) => !bundle.board.deletedAt).length,
        boardNodes: after.boards.reduce((sum, b) => sum + b.nodes.filter((n) => !n.deletedAt).length, 0),
        boardEdges: after.boards.reduce((sum, b) => sum + b.edges.filter((e) => !e.deletedAt).length, 0),
        attachments: after.attachments.filter((row) => !row.deletedAt).length,
        settings: after.settings.filter((row) => !row.deletedAt && SAFE_SETTING_KEYS.has(row.key)).length,
        events: after.events.filter((row) => !row.deletedAt).length,
        habits: after.habits.filter((row) => !row.deletedAt).length,
        focusSessions: after.focusSessions.filter((row) => !row.deletedAt).length,
        reviewSnapshots: after.reviewSnapshots.filter((row) => !row.deletedAt).length,
      },
      trash: { tasks: after.tasks.filter((row) => row.deletedAt).length, notes: after.notes.filter((row) => row.deletedAt).length },
      errors: (await call('console')).errors,
    };
  }).then((result) => {
    if (!result.ok) {
      record('E-2', 'F-036', '全新库从 ZIP 恢复', 'fail', '预览→确认→恢复完成', `异常：${result.error.message}`);
      return;
    }
    const value = result.value;
    evidence.restores.push({ scenario: 'fresh-db-zip', ...value });
    const pass =
      value.success &&
      (value.previewTiles['阻止'] ?? -1) === 0 &&
      value.fidelity.ok &&
      value.relationDiff.missing.length === 0 && value.relationDiff.extra.length === 0 &&
      value.activeAfter.boards === 2 && value.activeAfter.boardNodes === 6 && value.activeAfter.boardEdges === 4 &&
      value.activeAfter.attachments === 1 &&
      value.blobBefore === null &&
      value.blob && value.blob.size === BYTES &&
      value.trash.tasks >= 1 && value.trash.notes >= 1 &&
      value.errors.length === 0;
    record('E-2', 'F-036',
      '全新库（含种子）显式覆盖后从 ZIP 恢复：逐字段保真、关系零丢失、附件二进制落盘',
      pass ? 'pass' : 'fail',
      '恢复后每个对象逐字段等于备份（忽略 createdAt/updatedAt/version/completedAt）、关系零差异、画板 2/节点 6/连线 4、回收站对象仍在、附件二进制可读',
      JSON.stringify({
        previewTiles: value.previewTiles,
        previewTilesAfterChoice: value.previewTilesAfterChoice,
        previewInline: value.previewInline,
        overwriteApplied: value.overwrite.applied.filter((item) => item.overwritten).length,
        success: value.success,
        summary: value.summary,
        steps: value.steps,
        conflicts: value.conflicts.length,
        fidelity: value.fidelity,
        relationDiff: value.relationDiff,
        activeAfter: value.activeAfter,
        trash: value.trash,
        blobBefore: value.blobBefore,
        blob: value.blob,
      }),
      'tests/evidence/aud018/09-restore-result.html');
  });

  // B3 SQLite 直读交叉核验
  await step('I-1', 'F-036', 'SQLite 直读', async () => {
    const snapshot = await dbSnapshot(desktop);
    const db = await desktop.openDb();
    try {
      const attachment = db.prepare('SELECT id, sha256, byte_size, note_id FROM attachments').all().map((row) => ({ ...row }));
      const board = db.prepare('SELECT id, title, note_id FROM boards WHERE deleted_at IS NULL').all().map((row) => ({ ...row }));
      const foreignKeyCheck = db.prepare('PRAGMA foreign_key_check').all().length;
      const orphanChecks = {
        tasksWithoutList: db.prepare('SELECT COUNT(*) AS c FROM tasks t LEFT JOIN lists l ON l.id = t.list_id WHERE l.id IS NULL').get().c,
        blocksWithoutNote: db.prepare('SELECT COUNT(*) AS c FROM note_blocks b LEFT JOIN notes n ON n.id = b.note_id WHERE n.id IS NULL').get().c,
        nodesWithoutBoard: db.prepare('SELECT COUNT(*) AS c FROM board_nodes n LEFT JOIN boards b ON b.id = n.board_id WHERE b.id IS NULL').get().c,
        edgesWithoutNodes: db.prepare('SELECT COUNT(*) AS c FROM board_edges e LEFT JOIN board_nodes f ON f.id = e.from_node_id LEFT JOIN board_nodes t ON t.id = e.to_node_id WHERE f.id IS NULL OR t.id IS NULL').get().c,
      };
      fs.writeFileSync(path.join(EVIDENCE, '13-sqlite-snapshot.json'), JSON.stringify({ snapshot, attachment, board, foreignKeyCheck, orphanChecks }, null, 2));
      return { snapshot, attachment, board, foreignKeyCheck, orphanChecks };
    } finally {
      db.close();
    }
  }).then((result) => {
    const value = result.ok ? result.value : {};
    const pass =
      result.ok && value.foreignKeyCheck === 0 &&
      Object.values(value.orphanChecks ?? {}).every((count) => count === 0) &&
      value.attachment.length === 1 && value.attachment[0].sha256 === ATTACHMENT_SHA &&
      value.board.length === 2 &&
      value.snapshot.all.boardNodes === 6 && value.snapshot.all.boardEdges === 4;
    record('I-1', 'F-036',
      'SQLite 直读：外键/孤儿检查为 0，附件哈希一致，画板 2/节点 6/连线 4',
      pass ? 'pass' : 'fail',
      'foreign_key_check=0、无孤儿行、attachments.sha256=验收文本哈希、画板与节点连线数量与备份一致',
      result.ok ? JSON.stringify(value) : `异常：${result.error.message}`,
      'tests/evidence/aud018/13-sqlite-snapshot.json');
  });

  // B4 刷新持久化
  await step('H-4', 'F-036', '刷新持久化', async () => {
    await call('reload');
    await sleep(1200);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const state = await call('state');
        if (state.route) break;
      } catch {
        /* 页面重载中 */
      }
      await sleep(400);
    }
    await sleep(1200);
    const rows = await call('collect');
    const note = rows.notes.find((row) => row.id === fixture.ids.noteA);
    const task = rows.tasks.find((row) => row.id === fixture.ids.taskMain);
    await call('navigate', '/knowledge');
    await sleep(1500);
    const knowledge = await call('state');
    return { noteTitle: note?.title, taskTitle: task?.title, route: knowledge.route, body: knowledge.body.slice(0, 160) };
  }).then((result) => {
    const value = result.ok ? result.value : {};
    record('H-4', 'F-036',
      '刷新页面后恢复结果仍在（真实 SQLite 持久化）',
      result.ok && value.noteTitle === 'AUD-018 关系总集' && value.route === '/knowledge' ? 'pass' : 'fail',
      'reload 后笔记/任务仍在，知识页可进入',
      result.ok ? JSON.stringify(value) : `异常：${result.error.message}`);
  });

  // B5 空数据导出/恢复
  await step('H-2', 'F-036', '空数据导出', async () => {
    await ipc('db_reset_domain');
    await sleep(800);
    const rows = await call('collect');
    const activeCounts = {
      tasks: rows.tasks.filter((row) => !row.deletedAt).length,
      notes: rows.notes.filter((row) => !row.deletedAt).length,
      boards: rows.boards.filter((bundle) => !bundle.board.deletedAt).length,
      attachments: rows.attachments.filter((row) => !row.deletedAt).length,
    };
    // 产品只提供「重置全部数据 → 回种子」；用真实 IPC 把所有业务行软删除，
    // 得到一个「只有回收站、没有活动对象」的库，验证导出/恢复对空活动集的健壮性。
    for (const task of rows.tasks) if (!task.deletedAt) await ipc('tasks_delete', { id: task.id });
    for (const note of rows.notes) if (!note.deletedAt) await ipc('notes_delete', { id: note.id });
    for (const event of rows.events) if (!event.deletedAt) await ipc('events_delete', { id: event.id });
    for (const countdown of rows.countdowns) if (!countdown.deletedAt) await ipc('countdowns_delete', { id: countdown.id });
    for (const habit of rows.habits) if (!habit.deletedAt) await ipc('habits_delete', { id: habit.id });
    for (const session of rows.focusSessions) if (!session.deletedAt) await ipc('focus_sessions_delete', { id: session.id });
    for (const board of rows.boards) if (!board.board.deletedAt) await ipc('boards_delete', { id: board.board.id });
    for (const attachment of rows.attachments) if (!attachment.deletedAt) await ipc('attachments_delete', { id: attachment.id });
    for (const setting of rows.settings) if (!setting.deletedAt) await ipc('settings_delete', { id: setting.id });
    for (const list of rows.lists) if (!list.isInbox && !list.deletedAt) await ipc('lists_delete', { id: list.id });
    const afterWipe = await call('collect');
    const activeAfterWipe = {
      tasks: afterWipe.tasks.filter((row) => !row.deletedAt).length,
      notes: afterWipe.notes.filter((row) => !row.deletedAt).length,
      boards: afterWipe.boards.filter((bundle) => !bundle.board.deletedAt).length,
      attachments: afterWipe.attachments.filter((row) => !row.deletedAt).length,
      events: afterWipe.events.filter((row) => !row.deletedAt).length,
      habits: afterWipe.habits.filter((row) => !row.deletedAt).length,
    };
    await openDataPanel();
    const before = desktop.listExports();
    await call('click', '导出 ZIP', '.settings-body');
    const file = await desktop.waitNewExport(before);
    await waitPanelSettled();
    const bundle = bundleFromZip(file.file);
    const stat = fileStat(file.file);
    const integrity = zipIntegrity(bundle);
    const emptyCopy = path.join(WORK, 'empty-dataset.zip');
    fs.copyFileSync(file.file, emptyCopy);
    fs.writeFileSync(path.join(EVIDENCE, '11-empty-export.json'),
      JSON.stringify({ path: file.file, sha256: stat.sha256, byteSize: stat.byteSize, counts: bundle.manifest.counts, integrity, activeAfterWipe }, null, 2));
    return { activeCounts, activeAfterWipe, path: file.file, sha256: stat.sha256, byteSize: stat.byteSize, counts: bundle.manifest.counts, integrity, emptyCopy };
  }).then((result) => {
    const value = result.ok ? result.value : {};
    const pass =
      result.ok &&
      value.byteSize > 0 &&
      value.integrity?.allShaOk && value.integrity?.allCrcOk && value.integrity?.allPresent &&
      Object.values(value.activeAfterWipe ?? { tasks: -1 }).every((count) => count === 0) &&
      // 备份包含回收站，因此 tasks/notes/boards 计数可以非 0；但活动对象必须为 0。
      value.counts.events === 0 && value.counts.attachments === 0;
    record('H-2', 'F-036',
      '空活动集导出：ZIP 合法（manifest 哈希/CRC 全通过），活动对象为 0，回收站对象仍随备份',
      pass ? 'pass' : 'fail',
      'activity=0、ZIP integrity 全绿、文件 > 0 字节',
      result.ok
        ? JSON.stringify({ activeAfterWipe: value.activeAfterWipe, counts: value.counts, integrity: { sha: value.integrity?.allShaOk, crc: value.integrity?.allCrcOk, present: value.integrity?.allPresent }, sha256: value.sha256.slice(0, 16), byteSize: value.byteSize })
        : `异常：${result.error.message}`,
      'tests/evidence/aud018/11-empty-export.json');
  });

  await step('H-3', 'F-036', '空活动集备份恢复预览', async () => {
    const emptyZip = path.join(WORK, 'empty-dataset.zip');
    await openDataPanel();
    await chooseBackup(emptyZip);
    const dialog = await call('waitDialog', 60_000);
    if (!dialog) throw new Error('空备份未打开恢复预览');
    const confirm = dialog.buttons.find((button) => button.text === '确认恢复');
    const steps = await call('operationSteps');
    fs.writeFileSync(path.join(EVIDENCE, '12-empty-restore-preview.html'), (await call('html', '[role="dialog"]')) ?? '');
    // 勾掉外观偏好后，若备份里只剩本机完全相同的对象，操作应为 0 步。
    const appearance = await call('setAppearance', false);
    await sleep(250);
    const dialogNoAppearance = await call('dialog');
    const stepsNoAppearance = await call('operationSteps');
    const confirmNoAppearance = dialogNoAppearance.buttons.find((button) => button.text === '确认恢复');
    await call('click', '取消', '[role="dialog"]');
    return {
      tiles: dialog.tiles,
      steps: steps?.length ?? dialog.steps,
      stepLabels: (steps ?? []).slice(0, 5),
      confirmDisabled: confirm?.disabled ?? null,
      appearance,
      stepsNoAppearance: stepsNoAppearance?.length ?? dialogNoAppearance.steps,
      confirmDisabledNoAppearance: confirmNoAppearance?.disabled ?? null,
      inline: dialog.inline,
    };
  }).then((result) => {
    const value = result.ok ? result.value : {};
    // 空活动集 + 关闭外观恢复 = 没有任何可写变更：0 步 + 确认禁用。
    const pass = result.ok && value.stepsNoAppearance === 0 && value.confirmDisabledNoAppearance === true;
    record('H-3', 'F-036',
      '空活动集备份：关掉外观恢复后 0 步操作、「确认恢复」禁用（不产生空写）',
      pass ? 'pass' : 'fail',
      'operations=0 且确认按钮禁用；仅外观恢复时也只有 1 步外观操作',
      result.ok ? JSON.stringify(value) : `异常：${result.error.message}`,
      'tests/evidence/aud018/12-empty-restore-preview.html');
  });

  // B6 控制台与日志
  await step('H-5', 'F-036', '控制台与日志', async () => {
    const consoleState = await call('console');
    const appErrors = desktop.log.split('\n').filter((line) => /\[ERROR\]/.test(line)).slice(0, 20);
    return { errors: consoleState.errors, warns: consoleState.warns, appErrors };
  }).then((result) => {
    const value = result.ok ? result.value : {};
    const pass = result.ok && (value.errors ?? []).length === 0 && (value.appErrors ?? []).length === 0;
    record('H-5', 'F-036',
      '整轮导出/恢复后 WebView 控制台与桌面日志无错误',
      pass ? 'pass' : 'fail',
      'console.error 空、Rust 日志无 [ERROR]',
      result.ok ? JSON.stringify({ errors: value.errors.slice(0, 8), appErrors: value.appErrors, warnCount: value.warns.length }) : `异常：${result.error.message}`);
  });

  await desktop.stop();
  active = null;
}

// ---------------------------------------------------------------------------
// 阶段 C：全新库从 JSON 备份恢复（JSON 只含附件元数据，不含二进制）
// ---------------------------------------------------------------------------
async function phaseC() {
  const desktop = new Desktop('c');
  active = desktop;
  await desktop.start();
  evidence.runtimeC = {
    label: 'C',
    dbPath: desktop.dbPath,
    trial: desktop.trial,
    status: desktop.status,
  };
  log('实例 C（全新库）就绪', evidence.runtimeC);

  await step('E-json', 'F-036', '全新库从 JSON 恢复', async () => {
    const relationsBackup = collectRelations(zipBundle.dataset);
    await call('clearAttachmentStore');
    const blobBeforeRestore = await call('blobStat', ATTACHMENT_SHA);
    await openDataPanel();
    await chooseBackup(exportBy.json);
    const dialog = await call('waitDialog', 60_000);
    if (!dialog) throw new Error('JSON 未打开恢复预览');
    const previewTiles = Object.fromEntries(dialog.tiles.map((tile) => [tile.label, tile.value]));
    const previewInline = dialog.inline;
    fs.writeFileSync(path.join(EVIDENCE, '14-json-restore-preview.html'), (await call('html', '[role="dialog"]')) ?? '');
    const overwrite = await call('overwriteAll');
    await sleep(300);
    await call('click', '确认恢复', '[role="dialog"]');
    await call('waitText', '恢复完成', 240_000);
    const finished = await call('dialog');
    fs.writeFileSync(path.join(EVIDENCE, '15-json-restore-result.html'), (await call('html', '[role="dialog"]')) ?? '');
    await call('click', '完成', '[role="dialog"]');
    await sleep(600);
    const after = await call('collect');
    const afterDataset = datasetFromCollect(after);
    const diff = relationSetDiff(relationsBackup, collectRelations(afterDataset), zipBundle.dataset, afterDataset);
    const fidelity = fidelityDiff(zipBundle.dataset, after);
    const blob = await call('blobStat', ATTACHMENT_SHA);
    const consoleState = await call('console');
    return {
      previewTiles, previewInline, overwrite,
      success: finished.success, steps: finished.steps, progress: finished.progress,
      relationDiff: diff,
      fidelity: { ok: fidelity.ok, problems: fidelity.problems.slice(0, 8), summary: fidelity.summary },
      blobBefore: blobBeforeRestore,
      blob,
      activeAfter: {
        tasks: after.tasks.filter((row) => !row.deletedAt).length,
        notes: after.notes.filter((row) => !row.deletedAt).length,
        boards: after.boards.filter((bundle) => !bundle.board.deletedAt).length,
        boardNodes: after.boards.reduce((sum, b) => sum + b.nodes.filter((node) => !node.deletedAt).length, 0),
        boardEdges: after.boards.reduce((sum, b) => sum + b.edges.filter((edge) => !edge.deletedAt).length, 0),
        attachments: after.attachments.filter((row) => !row.deletedAt).length,
      },
      errors: consoleState.errors,
    };
  }).then((result) => {
    if (!result.ok) {
      record('E-json', 'F-036', '全新库从 JSON 恢复', 'fail', '预览→确认→恢复完成', `异常：${result.error.message}`);
      return;
    }
    const value = result.value;
    evidence.restores.push({ scenario: 'fresh-db-json', ...value });
    const tileTotal = ['新增', '更新', '移入回收站', '跳过', '阻止']
      .reduce((sum, key) => sum + (value.previewTiles[key] ?? 0), 0);
    const pass =
      value.success &&
      tileTotal === value.steps &&
      value.steps === 21 &&
      value.relationDiff.missing.length === 0 && value.relationDiff.extra.length === 0 &&
      value.fidelity.ok &&
      value.blobBefore === null &&
      value.blob === null &&
      value.activeAfter.boards === 2 && value.activeAfter.boardNodes === 6 && value.activeAfter.boardEdges === 4 &&
      value.errors.length === 0;
    record('E-json', 'F-036',
      '全新库从 JSON 恢复：预览 21 步=实际 21 步，关系零丢失；附件按文档只恢复元数据、不写二进制',
      pass ? 'pass' : 'fail',
      '预览条目合计=实际 steps=21、关系 zero diff、逐字段保真、blob=null（JSON 不含二进制）、控制台无错误',
      JSON.stringify(value),
      'tests/evidence/aud018/15-json-restore-result.html');
  });

  await desktop.stop();
  active = null;
}

try {
  if (!fs.existsSync(BIN)) throw new Error(`桌面二进制不存在：${BIN}（先 pnpm --filter app tauri build --debug 或 cargo build）`);
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('前端未构建：先 pnpm --filter app build');
  await phaseA();
  await phaseB();
  await phaseC();
} catch (error) {
  notes.push(`致命错误：${error.message}`);
  log(`致命错误：${error.message}`);
  exitCode = 1;
} finally {
  if (active) {
    try {
      await active.stop();
    } catch {
      /* ignore */
    }
  }
  const failed = results.filter((item) => item.verdict === 'fail');
  const summary = {
    startedAt: evidence.startedAt,
    finishedAt: new Date().toISOString(),
    runtimeA: evidence.runtimeA,
    runtimeB: evidence.runtimeB,
    runtimeC: evidence.runtimeC,
    cleanBefore: evidence.cleanBefore,
    fixture,
    zipDataset: evidence.zipDataset,
    exports: evidence.exports,
    restores: evidence.restores,
    results,
    notes,
    totals: { pass: results.length - failed.length, fail: failed.length, total: results.length },
  };
  fs.writeFileSync(path.join(EVIDENCE, 'summary.json'), JSON.stringify(summary, null, 2));
  log(`完成：${summary.totals.pass}/${summary.totals.total} 通过`);
  if (failed.length > 0) {
    exitCode = 1;
    log('失败项', failed.map((item) => `${item.id}(${item.name})`));
  }
  server.close();
  await sleep(300);
  process.exit(exitCode);
}
