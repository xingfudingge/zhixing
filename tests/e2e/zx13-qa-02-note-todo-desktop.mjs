/**
 * ZX13-FULL-QA-02 笔记待办独立桌面验收。
 *
 * 真实 Tauri 2 二进制 + WKWebView + SQLite。覆盖卡面必测 1/2：
 * 未启用加密 CRUD/勾选/刷新/重启；启用加密密文写入/锁定/解锁/关闭/重启；
 * 备份原始行。完整 ZIP 恢复由 aud018-desktop.mjs 独立覆盖。
 *
 * 运行：
 *   pnpm --filter app build
 *   cargo build --manifest-path app/src-tauri/Cargo.toml
 *   node tests/e2e/zx13-qa-02-note-todo-desktop.mjs
 *
 * 证据：tests/evidence/zx13-qa-02/
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
const PROBE = path.join(__dirname, 'zx13-qa-02/note-todo-probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx13-qa-02');
const HOME = '/tmp/zx13-qa-02-home';
const PORT = 5173;
const APP_SUPPORT = path.join(
  HOME,
  'Library/Application Support/com.zhixing.desktop',
);
const DB = path.join(APP_SUPPORT, 'zhixing.db');
const PASSPHRASE = 'QA02 correct horse battery';

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
if (!fs.existsSync(BIN)) {
  throw new Error(`桌面二进制不存在：${BIN}`);
}
fs.mkdirSync(EVIDENCE, { recursive: true });

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

let currentProbe = '';
const queue = [];
const pending = new Map();
let commandSeq = 0;
let readyResolve = null;
let readyPromise = null;

function resetReady() {
  readyPromise = new Promise((resolve) => {
    readyResolve = resolve;
  });
}

function indexWithProbe() {
  return fs
    .readFileSync(path.join(DIST, 'index.html'), 'utf8')
    .replace('</body>', '<script src="/__qa02_probe.js"></script></body>');
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (url.pathname === '/__qa02_ready') {
        response.writeHead(204);
        response.end();
        readyResolve?.();
        return;
      }
      if (url.pathname === '/__qa02_result') {
        try {
          const payload = JSON.parse(body);
          if (process.env.QA02_DEBUG) {
            console.log('[qa02-debug] result', payload.id, payload.result?.ok, payload.result?.error || '');
          }
          const waiter = pending.get(payload.id);
          if (waiter) {
            pending.delete(payload.id);
            waiter(payload);
          } else if (process.env.QA02_DEBUG) {
            console.log('[qa02-debug] no waiter for', payload.id);
          }
        } catch (error) {
          if (process.env.QA02_DEBUG) console.log('[qa02-debug] result parse error', String(error));
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
  if (url.pathname === '/__qa02_probe.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(currentProbe.replaceAll('/__probe-ready', '/__qa02_ready').replaceAll('/__result', '/__qa02_result'));
    return;
  }
  if (url.pathname === '/__qa02_next') {
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
  const ext = path.extname(file);
  if (ext === '.html' || file.endsWith('index.html')) {
    response.writeHead(200, {
      'Content-Type': MIME['.html'],
      'Cache-Control': 'no-store',
    });
    response.end(indexWithProbe());
    return;
  }
  response.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  response.end(fs.readFileSync(file));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', resolve);
});

// 探针源码里的轮询地址与注入路径保持一致。
currentProbe = fs
  .readFileSync(PROBE, 'utf8')
  .replaceAll('/__next', '/__qa02_next');

function command(payload, timeout = 60_000) {
  const id = ++commandSeq;
  if (process.env.QA02_DEBUG) console.log('[qa02-debug] send', id, payload.type);
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

const checks = [];
const failures = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  const prefix = ok ? 'PASS' : 'FAIL';
  console.log(
    `[qa02] ${prefix} ${name}`,
    detail === undefined ? '' : JSON.stringify(detail).slice(0, 1500),
  );
  if (!ok) failures.push(`${name}：${JSON.stringify(detail)}`);
  return Boolean(ok);
}

function rmHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
}

function sqliteRows(ids) {
  const quoted = ids.map((id) => `'${id.replaceAll("'", "''")}'`).join(',');
  const result = spawnSync(
    'sqlite3',
    [
      '-separator',
      '|',
      DB,
      `SELECT id, title, encrypted, done, deleted_at IS NOT NULL FROM note_todos WHERE id IN (${quoted}) ORDER BY id;`,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`sqlite3 读取失败：${result.stderr}`);
  }
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, title, encrypted, done, deleted] = line.split('|');
      return {
        id,
        title,
        encrypted: Number(encrypted),
        done: Number(done),
        deleted: Number(deleted) === 1,
      };
    });
}

async function runPhase({ name, fresh, timeoutMs = 180_000, body }) {
  if (fresh) rmHome();
  else fs.mkdirSync(HOME, { recursive: true });
  queue.length = 0;
  pending.clear();
  resetReady();

  const appLog = [];
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
  app.stdout.on('data', (chunk) => appLog.push(String(chunk)));
  app.stderr.on('data', (chunk) => appLog.push(String(chunk)));
  const exited = new Promise((resolve) => app.on('exit', resolve));

  const ready = await Promise.race([
    readyPromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 40_000)),
  ]);
  if (!ready) {
    app.kill('SIGKILL');
    throw new Error(`${name}: 探针未就绪`);
  }

  const result = await (async () => {
    try {
      return { ok: true, value: await body() };
    } catch (error) {
      return { ok: false, error: String((error && error.stack) || error) };
    }
  })();

  try {
    app.kill('SIGTERM');
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (app.exitCode === null) app.kill('SIGKILL');
  } catch {
    /* ignore */
  }

  const evidence = {
    phase: name,
    startedAt: new Date().toISOString(),
    home: HOME,
    appLog: appLog.join(''),
    ...result,
  };
  fs.writeFileSync(
    path.join(EVIDENCE, `${name}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  return evidence;
}

async function enterApp() {
  let env = await command({ type: 'env' });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (
      env.bodyText.includes('开始 7 天试用') ||
      env.bodyText.includes('工作台') ||
      env.route.startsWith('/today')
    ) {
      break;
    }
    await command({ type: 'sleep', ms: 300 });
    env = await command({ type: 'env' });
  }
  if (env.bodyText.includes('开始 7 天试用')) {
    await command({ type: 'clickText', text: '开始 7 天试用' });
  }
  let after = await command({ type: 'env' });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (
      after.route.startsWith('/today') ||
      after.bodyText.includes('工作台') ||
      after.route.startsWith('/knowledge')
    ) {
      break;
    }
    await command({ type: 'sleep', ms: 300 });
    after = await command({ type: 'env' });
  }
  return { env, after };
}

const summary = {
  task: 'ZX13-FULL-QA-02',
  kind: 'macos-desktop-note-todos',
  startedAt: new Date().toISOString(),
  head: spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout.trim(),
  passphrase: PASSPHRASE,
  phases: {},
};

let plainTodoA = null;
let plainTodoB = null;
let encryptedTodo = null;

try {
  summary.phases.plain = await runPhase({
    name: 'plain',
    fresh: true,
    body: async () => {
      const entered = await enterApp();
      check(
        '启动：真实 Tauri IPC 可用并进入主界面',
        entered.env.isTauri === true &&
          (entered.after.route.startsWith('/today') ||
            entered.after.bodyText.includes('工作台') ||
            entered.after.route.startsWith('/knowledge')),
        { env: entered.env, after: entered.after },
      );

      const seeded = await command({ type: 'seedNote' });
      check('准备：真实 IPC 创建验收笔记与正文块', seeded.id === 'qa02-note', seeded);

      await command({ type: 'openNote', title: 'QA02 笔记待办独立验收' });
      const beforeCreate = await command({ type: 'listTodos' });
      const created = await command({ type: 'createViaBlockMenu' }, 60_000);
      const createdRows = created.todos.filter(
        (row) => !beforeCreate.some((old) => old.id === row.id),
      );
      plainTodoA = createdRows[0] || null;
      check(
        '未加密 · 新建：块菜单插入待办真实落库（非“尚未配置笔记加密”）',
        plainTodoA &&
          created.uiErrors.length === 0 &&
          created.alertText === '' &&
          created.summary.present === true &&
          created.summary.count === 1,
        created,
      );
      if (!plainTodoA) throw new Error('块菜单未生成待办');

      const updated = await command(
        {
          type: 'editTodoInline',
          oldTitle: '待办事项',
          newTitle: 'QA02 待办A（已更新）',
        },
        45_000,
      );
      const reopened = await command({ type: 'reopenSnapshot' });
      const updatedRow = reopened.todos.find(
        (row) => row.id === plainTodoA.id,
      );
      check(
        '未加密 · 更新：正文内联改名后刷新笔记读回新标题',
        updated.summary.rows.some(
          (row) => row.title === 'QA02 待办A（已更新）',
        ) &&
          updated.todos.some(
            (row) =>
              row.id === plainTodoA.id &&
              row.title === 'QA02 待办A（已更新）' &&
              row.version > plainTodoA.version,
          ) &&
          updatedRow?.title === 'QA02 待办A（已更新）' &&
          reopened.summary.rows.some(
            (row) => row.title === 'QA02 待办A（已更新）',
          ),
        { updated, reopened, updatedRow },
      );

      const toggled = await command(
        { type: 'toggleViaSummary', label: '标记完成：QA02 待办A（已更新）' },
        30_000,
      );
      const afterToggleReopen = await command({ type: 'reopenSnapshot' });
      check(
        '未加密 · 勾选：文末汇总勾选后落库，刷新后仍为完成',
        toggled.after.done === 1 &&
          toggled.after.rows[0]?.checked === true &&
          afterToggleReopen.todos.some(
            (row) => row.id === plainTodoA.id && row.done === true,
          ) &&
          afterToggleReopen.summary.rows.some(
            (row) => row.id === plainTodoA.id && row.checked === true,
          ),
        { toggled, afterToggleReopen },
      );

      plainTodoB = await command(
        {
          type: 'createTodo',
          input: {
            id: 'qa02-todo-b',
            noteId: 'qa02-note',
            title: 'QA02 待办B（重启保留）',
            done: true,
            sortOrder: 9,
          },
        },
        30_000,
      );

      const deleted = await command(
        {
          type: 'deleteViaSummary',
          label: '删除待办：QA02 待办A（已更新）',
        },
        30_000,
      );
      const deletedA = deleted.allRows.find((row) => row.id === plainTodoA.id);
      const afterDelete = await command({ type: 'reopenSnapshot' });
      check(
        '未加密 · 删除：汇总删除后软删除落库，刷新不再出现，B 保留',
        Boolean(deletedA?.deletedAt) &&
          !afterDelete.todos.some((row) => row.id === plainTodoA.id) &&
          afterDelete.todos.some(
            (row) => row.id === plainTodoB.id && row.done === true,
          ),
        deleted,
      );

      const missing = await command(
        { type: 'deleteTodo', todoId: 'qa02-missing-todo' },
        30_000,
      ).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error: String(error.message) }),
      );
      check(
        '删除不存在项：返回明确错误，不静默成功',
        missing.ok === false &&
          /不存在|not found|笔记待办/i.test(missing.error || ''),
        missing,
      );

      const raw = sqliteRows([plainTodoA.id, plainTodoB.id]);
      const rawA = raw.find((row) => row.id === plainTodoA.id);
      const rawB = raw.find((row) => row.id === plainTodoB.id);
      check(
        '未加密 · SQLite：A 明文且软删除，B 明文且 done=1，encrypted=0',
        rawA &&
          rawA.title === 'QA02 待办A（已更新）' &&
          rawA.encrypted === 0 &&
          rawA.done === 1 &&
          rawA.deleted === true &&
          rawB &&
          rawB.title === 'QA02 待办B（重启保留）' &&
          rawB.encrypted === 0 &&
          rawB.done === 1 &&
          rawB.deleted === false,
        raw,
      );

      const errs = await command({ type: 'errors' });
      const unexpected = errs.errors.filter(
        (line) => !line.includes('笔记待办'),
      );
      check(
        '控制台：未加密流程零 error / 零页面异常，无“尚未配置笔记加密”',
        unexpected.length === 0 &&
          errs.pageExceptions.length === 0 &&
          !JSON.stringify(errs).includes('尚未配置笔记加密'),
        errs,
      );

      return { entered, seeded, created, updated, reopened, toggled, deleted, afterDelete, missing, raw, errs };
    },
  });
  summary.phases.plainResult = summary.phases.plain.ok
    ? 'ok'
    : summary.phases.plain.error;
  if (!summary.phases.plain.ok) throw new Error(summary.phases.plain.error);

  summary.phases.encrypted = await runPhase({
    name: 'encrypted',
    fresh: false,
    body: async () => {
      const entered = await enterApp();
      const beforeEnable = await command({ type: 'listTodos' });
      check(
        '重启（未加密）：上次的 B 仍明文可读、A 已删除不返回',
        beforeEnable.some(
          (row) => row.id === 'qa02-todo-b' && row.done === true && !row.locked,
        ) && !beforeEnable.some((row) => row.id === plainTodoA?.id),
        beforeEnable,
      );

      const enabled = await command(
        { type: 'encryptionEnable', passphrase: PASSPHRASE },
        60_000,
      );
      const status = await command({ type: 'encryptionStatus' });
      check(
        '加密：启用成功且处于已解锁状态',
        enabled &&
          status.enabled === true &&
          status.locked === false &&
          status.configured === true,
        { enabled, status },
      );

      const rowsBeforeUi = await command({ type: 'listTodos' });
      const uiCreated = await command({ type: 'createViaBlockMenu' }, 60_000);
      const newRow = uiCreated.todos.find(
        (row) => !rowsBeforeUi.some((old) => old.id === row.id),
      );
      encryptedTodo = newRow
        ? await command(
            {
              type: 'updateTodo',
              todoId: newRow.id,
              patch: { title: 'QA02 加密待办', done: false, sortOrder: 5 },
            },
            30_000,
          )
        : null;
      check(
        '加密 · 新建：块菜单在启用加密后创建待办成功且返回明文标题',
        encryptedTodo &&
          encryptedTodo.encrypted === true &&
          encryptedTodo.locked === false &&
          encryptedTodo.title === 'QA02 加密待办' &&
          uiCreated.uiErrors.length === 0 &&
          uiCreated.alertText === '',
        { newRow, encryptedTodo, uiCreated },
      );
      if (!encryptedTodo) throw new Error('加密后未创建新待办');

      const exported = await command({ type: 'exportRows' });
      const rawC = exported.find((row) => row.id === encryptedTodo.id);
      const rawB = exported.find((row) => row.id === 'qa02-todo-b');
      check(
        '加密 · 导出原始行：新待办与旧待办均为密文，不含明文',
        rawC &&
          rawC.encrypted === true &&
          rawC.title !== 'QA02 加密待办' &&
          !rawC.title.includes('QA02 加密待办') &&
          rawB &&
          rawB.encrypted === true &&
          !rawB.title.includes('重启保留'),
        { rawC, rawB },
      );

      const dbRows = sqliteRows([encryptedTodo.id, 'qa02-todo-b']);
      check(
        '加密 · SQLite：encrypted=1 且标题为密文（不含明文）',
        dbRows.length === 2 &&
          dbRows.every(
            (row) =>
              row.encrypted === 1 &&
              !row.title.includes('QA02 加密待办') &&
              !row.title.includes('重启保留'),
          ),
        dbRows,
      );

      const locked = await command({ type: 'encryptionLock' });
      const lockedList = await command({ type: 'listTodos' });
      const lockedC = lockedList.find((row) => row.id === encryptedTodo.id);
      const createWhileLocked = await command(
        {
          type: 'createTodo',
          input: {
            id: 'qa02-locked-create',
            noteId: 'qa02-note',
            title: '锁定态不应写入',
            done: false,
            sortOrder: 20,
          },
        },
        30_000,
      ).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error: String(error.message) }),
      );
      const updateWhileLocked = await command(
        {
          type: 'updateTodo',
          todoId: encryptedTodo.id,
          patch: { title: '锁定态不应更新', done: true },
        },
        30_000,
      ).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error: String(error.message) }),
      );
      check(
        '加密 · 锁定：列表不回明文；新建/更新明确拒绝（不降级明文）',
        locked.enabled === true &&
          locked.locked === true &&
          lockedC &&
          lockedC.locked === true &&
          lockedC.title === '' &&
          createWhileLocked.ok === false &&
          /锁定/.test(createWhileLocked.error || '') &&
          updateWhileLocked.ok === false &&
          /锁定/.test(updateWhileLocked.error || ''),
        { locked, lockedC, createWhileLocked, updateWhileLocked },
      );

      const unlocked = await command(
        { type: 'encryptionUnlock', passphrase: PASSPHRASE },
        30_000,
      );
      const unlockedList = await command({ type: 'listTodos' });
      const unlockedC = unlockedList.find((row) => row.id === encryptedTodo.id);
      check(
        '加密 · 解锁：列表恢复明文标题',
        unlocked.locked === false &&
          unlockedC &&
          unlockedC.title === 'QA02 加密待办' &&
          unlockedC.locked === false,
        { unlocked, unlockedC },
      );

      const done = await command(
        {
          type: 'updateTodo',
          todoId: encryptedTodo.id,
          patch: { title: 'QA02 加密待办', done: true },
        },
        30_000,
      );
      const doneExport = await command({ type: 'exportRows' });
      const doneRaw = doneExport.find((row) => row.id === encryptedTodo.id);
      check(
        '加密 · 勾选：更新密文且 done=1 落库',
        done.done === true &&
          done.encrypted === true &&
          doneRaw &&
          doneRaw.encrypted === true &&
          doneRaw.done === true,
        { done, doneRaw },
      );

      const errs = await command({ type: 'errors' });
      check(
        '控制台：加密流程零 error / 零页面异常',
        errs.errors.length === 0 && errs.pageExceptions.length === 0,
        errs,
      );

      return { entered, beforeEnable, enabled, status, uiCreated, encryptedTodo, exported, dbRows, locked, lockedC, createWhileLocked, updateWhileLocked, unlocked, unlockedC, done, doneRaw, errs };
    },
  });
  summary.phases.encryptedResult = summary.phases.encrypted.ok
    ? 'ok'
    : summary.phases.encrypted.error;
  if (!summary.phases.encrypted.ok) throw new Error(summary.phases.encrypted.error);

  summary.phases.encryptedRestart = await runPhase({
    name: 'encrypted-restart',
    fresh: false,
    body: async () => {
      await enterApp();
      const status = await command({ type: 'encryptionStatus' });
      const lockedList = await command({ type: 'listTodos' });
      const lockedC = lockedList.find((row) => row.id === encryptedTodo?.id);
      const rawBeforeUnlock = await command({ type: 'exportRows' });
      const rawCBefore = rawBeforeUnlock.find(
        (row) => row.id === encryptedTodo?.id,
      );
      check(
        '加密 · 重启：默认锁定，待办标题不返回明文，备份仍为密文',
        status.enabled === true &&
          status.locked === true &&
          lockedC &&
          lockedC.locked === true &&
          lockedC.title === '' &&
          rawCBefore &&
          rawCBefore.encrypted === true &&
          !rawCBefore.title.includes('QA02 加密待办'),
        { status, lockedC, rawCBefore },
      );

      const unlocked = await command(
        { type: 'encryptionUnlock', passphrase: PASSPHRASE },
        30_000,
      );
      const unlockedList = await command({ type: 'listTodos' });
      const unlockedC = unlockedList.find((row) => row.id === encryptedTodo?.id);
      check(
        '加密 · 重启后解锁：待办标题与 done 状态完整恢复',
        unlocked.locked === false &&
          unlockedC &&
          unlockedC.title === 'QA02 加密待办' &&
          unlockedC.done === true &&
          unlockedC.locked === false,
        { unlocked, unlockedC },
      );

      const disabled = await command(
        { type: 'encryptionDisable', passphrase: null },
        60_000,
      );
      const afterDisable = await command({ type: 'listTodos' });
      const plainC = afterDisable.find((row) => row.id === encryptedTodo?.id);
      const rawAfterDisable = sqliteRows([encryptedTodo?.id]).find(
        (row) => row.id === encryptedTodo?.id,
      );
      check(
        '加密 · 关闭：待办保留并转回明文，重启前可读',
        disabled.enabled === false &&
          plainC &&
          plainC.title === 'QA02 加密待办' &&
          plainC.encrypted === false &&
          plainC.done === true &&
          rawAfterDisable &&
          rawAfterDisable.encrypted === 0 &&
          rawAfterDisable.title === 'QA02 加密待办',
        { disabled, plainC, rawAfterDisable },
      );

      const errs = await command({ type: 'errors' });
      check(
        '控制台：加密重启/关闭流程零 error / 零页面异常',
        errs.errors.length === 0 && errs.pageExceptions.length === 0,
        errs,
      );

      return { status, lockedC, rawCBefore, unlocked, unlockedC, disabled, plainC, rawAfterDisable, errs };
    },
  });
  summary.phases.encryptedRestartResult = summary.phases.encryptedRestart.ok
    ? 'ok'
    : summary.phases.encryptedRestart.error;
  if (!summary.phases.encryptedRestart.ok) {
    throw new Error(summary.phases.encryptedRestart.error);
  }

  summary.phases.plainRestart = await runPhase({
    name: 'plain-restart',
    fresh: false,
    body: async () => {
      await enterApp();
      const status = await command({ type: 'encryptionStatus' });
      const rows = await command({ type: 'listTodos' });
      const rowC = rows.find((row) => row.id === encryptedTodo?.id);
      const rowB = rows.find((row) => row.id === 'qa02-todo-b');
      check(
        '重启（关闭加密后）：C 与 B 均明文可读，状态保持',
        status.enabled === false &&
          rowC &&
          rowC.title === 'QA02 加密待办' &&
          rowC.done === true &&
          rowC.encrypted === false &&
          rowB &&
          rowB.title === 'QA02 待办B（重启保留）' &&
          rowB.done === true,
        { status, rowC, rowB },
      );

      const missing = await command(
        { type: 'deleteTodo', todoId: 'qa02-missing-todo' },
        30_000,
      ).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error: String(error.message) }),
      );
      check(
        '重启后删除不存在项：仍返回明确错误',
        missing.ok === false && /不存在|not found|笔记待办/i.test(missing.error || ''),
        missing,
      );

      const errs = await command({ type: 'errors' });
      check(
        '控制台：最终重启流程零 error / 零页面异常',
        errs.errors.length === 0 && errs.pageExceptions.length === 0,
        errs,
      );

      return { status, rows, rowC, rowB, missing, errs };
    },
  });
  summary.phases.plainRestartResult = summary.phases.plainRestart.ok
    ? 'ok'
    : summary.phases.plainRestart.error;
  if (!summary.phases.plainRestart.ok) throw new Error(summary.phases.plainRestart.error);
} catch (error) {
  failures.push(`fatal: ${String((error && error.stack) || error)}`);
  console.error('[qa02] FATAL', error);
} finally {
  server.close();
}

const summaryOut = {
  ...summary,
  finishedAt: new Date().toISOString(),
  checks,
  failures,
};
fs.writeFileSync(
  path.join(EVIDENCE, 'summary.json'),
  `${JSON.stringify(summaryOut, null, 2)}\n`,
);

const passed = checks.filter((item) => item.ok).length;
console.log(`\n[qa02] ${passed}/${checks.length} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('[qa02] 失败项：');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('[qa02] PASS');
