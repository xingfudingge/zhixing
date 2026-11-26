/**
 * ZX13-FULL-QA-01 真实 macOS 桌面全量回归 harness。
 *
 * 真实 Tauri 2 二进制 + WKWebView + SQLite；本地静态服务只注入验收探针，
 * 不替换产品 IPC、不注入假数据源。导出流程为在“测试服务返回的构建产物”
 * 中把保存面板命令 `save_attachment_file` 指到同一 Rust 写入命令
 * `save_export_file`，以便无头环境拿到真实文件；产品源码不改。
 *
 * 运行：
 *   pnpm --filter app build
 *   cargo build --manifest-path app/src-tauri/Cargo.toml
 *   node tests/e2e/zx13-full-qa-desktop.mjs
 *
 * 证据：tests/evidence/zx13-full-qa/desktop/
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
const PROBE = path.join(__dirname, 'zx13-full-qa/desktop-probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx13-full-qa/desktop');
const HOME = '/tmp/zx13-full-qa-home';
const PORT = 5173;
const APP_SUPPORT = path.join(
  HOME,
  'Library/Application Support/com.zhixing.desktop',
);
const EXPORTS = path.join(APP_SUPPORT, 'exports');

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先 pnpm --filter app build');
}
if (!fs.existsSync(BIN)) {
  throw new Error(`桌面二进制不存在：${BIN}`);
}
fs.mkdirSync(EVIDENCE, { recursive: true });
for (const name of fs.readdirSync(EVIDENCE)) {
  if (/\.(json|log|txt)$/.test(name)) fs.rmSync(path.join(EVIDENCE, name));
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
    .replace('</body>', '<script src="/__zx13_probe.js"></script></body>');
}

function serveAsset(file) {
  const ext = path.extname(file);
  const body = fs.readFileSync(file);
  if (ext !== '.js') return body;
  // 仅测试服务内的构建产物替换：把系统保存面板命令映射到可自动确认的
  // Rust 导出写入命令。产品代码与磁盘上的 dist 不动。
  return Buffer.from(
    body
      .toString('utf8')
      .split('"save_attachment_file"')
      .join('"save_export_file"'),
    'utf8',
  );
}

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
  if (url.pathname === '/__zx13_probe.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(currentProbe);
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
    : serveAsset(file);
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

const checks = [];
const failures = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  const prefix = ok ? 'PASS' : 'FAIL';
  console.log(`[zx13] ${prefix} ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 1200));
  if (!ok) failures.push(`${name}：${JSON.stringify(detail)}`);
  return Boolean(ok);
}

function rmHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
}

function listExports() {
  if (!fs.existsSync(EXPORTS)) return [];
  return fs
    .readdirSync(EXPORTS)
    .map((name) => {
      const file = path.join(EXPORTS, name);
      const stat = fs.statSync(file);
      return { name, size: stat.size, mtimeMs: stat.mtimeMs, file };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

async function runPhase({ name, probe, fresh, home = HOME, timeoutMs = 180_000 }) {
  if (fresh) rmHome();
  else fs.mkdirSync(home, { recursive: true });
  currentProbe = fs.readFileSync(path.join(__dirname, 'zx13-full-qa', probe), 'utf8');
  queue.length = 0;
  pending.clear();
  resetReady();

  const appLog = [];
  const app = spawn(BIN, [], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      ZHIXING_LICENSE_STORE: 'file',
      ZHIXING_LICENSE_FILE: path.join(home, 'license.json'),
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

  const run = async (fn) => {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, error: String((error && error.stack) || error) };
    }
  };

  let result = null;
  if (name === 'main') {
    result = await run(async () => {
      let env = await command({ type: 'env' });
      check('启动：真实 Tauri IPC 可用', env.isTauri === true, env);
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
      let afterTrial = await command({ type: 'env' });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (
          afterTrial.route.startsWith('/today') ||
          afterTrial.bodyText.includes('工作台')
        ) {
          break;
        }
        await command({ type: 'sleep', ms: 300 });
        afterTrial = await command({ type: 'env' });
      }
      check(
        '启动：7 天试用后进入工作台',
        afterTrial.route.startsWith('/today') ||
          afterTrial.bodyText.includes('工作台'),
        afterTrial,
      );

      const seeded = await command({ type: 'seed' }, 120_000);
      check(
        '准备：真实 IPC 创建 40 块长笔记、导出笔记与今日任务',
        seeded.blocks === 40 && Boolean(seeded.taskId),
        seeded,
      );

      const opened = await command({ type: 'openNote', title: 'ZX13 全量长文验收' });
      const initial = await command({ type: 'editorSnapshot' });
      check(
        '笔记：列表点击打开真实笔记，40 块正文加载',
        opened.title === 'ZX13 全量长文验收' && initial.blockCount >= 40,
        { opened, initial },
      );

      const edited = await command(
        { type: 'editUndoRedo', blockId: 'zx13-b1' },
        60_000,
      );
      check(
        '编辑/撤销/重做：输入 10 字后 ⌘Z 回退、⇧⌘Z 恢复、再撤销并保存',
        edited.typed &&
          edited.undone &&
          edited.redone &&
          edited.final.inline === edited.original &&
          edited.final.saveEditor.includes('已保存'),
        {
          original: edited.original,
          typed: edited.afterType.inline,
          undone: edited.afterUndo.inline,
          redone: edited.afterRedo.inline,
          final: edited.final,
        },
      );

      const scroll = await command({ type: 'scrollStability' }, 60_000);
      check(
        '滚动：点击第 6 块并输入后 scrollTop 不跳底、活动块不是最后一块',
        scroll.typeStable &&
          scroll.blankStable &&
          scroll.notBottom &&
          scroll.activeNotLast,
        scroll,
      );

      const selection = await command({ type: 'rowSelection' }, 30_000);
      check(
        '行前选择：单击选择 zx13-b3 整行，再点取消',
        selection.selected.selectedCount === 1 &&
          selection.selected.selected[0] === 'zx13-b3' &&
          selection.after.selectedCount === 0,
        selection,
      );

      const completed = await command({ type: 'completeTask', title: 'ZX13 完成任务验收' });
      check(
        '任务：今天页真实点击完成并撤回落库',
        completed.doneStatus === 'done' && completed.undoneStatus === 'todo',
        completed,
      );

      const eventCrud = await command({ type: 'eventCrud' }, 90_000);
      check(
        '日历：真实 UI 新建/编辑/重开/删除事件均落库',
        eventCrud.created.startDate === eventCrud.expected.date1 &&
          eventCrud.created.startAt === `${eventCrud.expected.date1}T09:05:00` &&
          eventCrud.created.eventType === '工作日程' &&
          eventCrud.created.repeatRule === '每年' &&
          eventCrud.edited.startDate === eventCrud.expected.date2 &&
          eventCrud.edited.startAt === `${eventCrud.expected.date2}T10:15:00` &&
          eventCrud.persistedStartDate === eventCrud.expected.date2 &&
          eventCrud.removed === true,
        eventCrud,
      );

      const groups = await command({ type: 'visitSettingsGroups' }, 90_000);
      check(
        '设置：9 个分组全部渲染、无 ComingSoon/未实现、无禁用行',
        groups.length === 9 &&
          groups.every(
            (group) =>
              group.navCount === 9 &&
              !group.comingSoon &&
              !group.unimplemented &&
              group.disabledRows === 0,
          ),
        groups,
      );

      const settings = await command({ type: 'changeSettings' }, 60_000);
      check(
        '设置生效：默认提醒/完成后行为/周起始/诊断/深色主题即时写入',
        settings.defaultReminder === '15m' &&
          settings.completionBehavior === 'remove' &&
          settings.weekStart === 'sunday' &&
          settings.diagnostics === true &&
          settings.theme === 'dark',
        settings,
      );

      const preNoteErrors = await command({ type: 'errors' });
      check(
        '控制台：笔记待办复现前零 console.error / 零页面异常',
        preNoteErrors.errors.length === 0 &&
          preNoteErrors.pageExceptions.length === 0,
        preNoteErrors,
      );

      const todo = await command({ type: 'noteTodoProbe' }, 60_000);
      check(
        '笔记待办：默认未启用加密的新库可创建待办（真实 IPC + 块菜单）',
        todo.ipcError === null &&
          todo.afterCount === todo.beforeCount + 1 &&
          // 直连 IPC 写入 1 条后，块菜单再插入 1 条；两条都应真实落库。
          todo.afterUiCount === todo.afterCount + 1 &&
          todo.uiErrors.length === 0 &&
          todo.alertText === '',
        todo,
      );

      const beforeFiles = listExports();
      const exported = await command({ type: 'exportAll' }, 180_000);
      const afterFiles = listExports();
      const newFiles = afterFiles.filter(
        (file) => !beforeFiles.some((old) => old.name === file.name),
      );
      const byExt = (ext) => newFiles.find((file) => file.name.endsWith(ext));
      const md = byExt('.md');
      const docx = byExt('.docx');
      const pdf = byExt('.pdf');
      const zxnote = byExt('.zxnote');
      let mdText = '';
      if (md) mdText = fs.readFileSync(md.file, 'utf8');
      const docxList = docx
        ? spawnSync('unzip', ['-l', docx.file], { encoding: 'utf8' })
        : null;
      const zxnoteList = zxnote
        ? spawnSync('unzip', ['-l', zxnote.file], { encoding: 'utf8' })
        : null;
      const pdfHead = pdf
        ? fs.readFileSync(pdf.file).subarray(0, 5).toString('latin1')
        : '';
      check(
        '导出：命令栏四种格式均生成真实文件并落应用数据目录',
        Boolean(md && docx && pdf && zxnote) &&
          mdText.includes('ZX13 导出验收正文') &&
          docxList?.status === 0 &&
          docxList.stdout.includes('word/document.xml') &&
          pdfHead === '%PDF-' &&
          zxnoteList?.status === 0,
        {
          exported: Object.fromEntries(
            Object.entries(exported).map(([key, value]) => [
              key,
              value.text.slice(0, 160),
            ]),
          ),
          files: newFiles.map((file) => ({ name: file.name, size: file.size })),
          mdHasBody: mdText.includes('ZX13 导出验收正文'),
          docxOk: docxList?.status === 0,
          pdfHead,
          zxnoteOk: zxnoteList?.status === 0,
        },
      );

      const board = await command({ type: 'boardProbe' }, 60_000);
      const moved =
        board.after &&
        (Math.abs(board.after.x - board.before.x) > 40 ||
          Math.abs(board.after.y - board.before.y) > 20);
      check(
        '画板：真实指针拖动节点并落库、检查器与保存状态可见',
        moved &&
          board.saveLabel.includes('已保存') &&
          board.inspectorBody === true &&
          board.inspectorHeading.length > 0,
        board,
      );

      const reopen = await command({ type: 'boardReopen' }, 40_000);
      check(
        '画板：离开再打开后节点位置与拖动结果一致',
        reopen.position &&
          Math.abs(reopen.position.x - board.after.x) < 1 &&
          Math.abs(reopen.position.y - board.after.y) < 1,
        reopen,
      );

      const finalErrors = await command({ type: 'errors' });
      const unexpected = finalErrors.errors.filter(
        (line) => !line.includes('尚未配置笔记加密') && !line.includes('note_todos'),
      );
      check(
        '控制台：除已复现的笔记待办缺陷外零 console.error / 零页面异常',
        unexpected.length === 0 && finalErrors.pageExceptions.length === 0,
        { errors: finalErrors.errors, pageExceptions: finalErrors.pageExceptions },
      );

      return {
        env,
        afterTrial,
        seeded,
        initial,
        edited,
        scroll,
        selection,
        completed,
        groups,
        settings,
        todo,
        exported,
        newFiles: newFiles.map((file) => ({
          name: file.name,
          size: file.size,
        })),
        board,
        reopen,
        finalErrors,
      };
    });
  } else {
    result = await run(async () => {
      const snapshot = await command({ type: 'restartSnapshot' }, 30_000);
      return { snapshot };
    });
  }

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
    home,
    appLog: appLog.join(''),
    ...result,
  };
  fs.writeFileSync(
    path.join(EVIDENCE, `${name}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  return evidence;
}

const summary = {
  task: 'ZX13-FULL-QA-01',
  kind: 'macos-desktop',
  startedAt: new Date().toISOString(),
  head: spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout.trim(),
  phases: {},
};

try {
  summary.phases.main = await runPhase({
    name: 'main',
    probe: 'desktop-probe.js',
    fresh: true,
    timeoutMs: 300_000,
  });

  const main = summary.phases.main;
  if (!main.ok) {
    check('主流程执行完成', false, main.error);
  }
  if (main.ok) {
    const s = main.value;
    const restart = await runPhase({
      name: 'restart',
      probe: 'desktop-probe.js',
      fresh: false,
    });
    summary.phases.restart = restart;
    if (restart.ok) {
      const snap = restart.value.snapshot;
      check(
        '重启持久化：默认提醒/完成后行为/周起始/诊断仍保持',
        snap.settings.defaultReminder === '15m' &&
          snap.settings.completionBehavior === 'remove' &&
          snap.settings.weekStart === 'sunday' &&
          snap.settings.diagnostics === true,
        snap.settings,
      );
      check(
        '重启持久化：画板节点位置保持',
        snap.boardNode &&
          Math.abs(snap.boardNode.x - s.board.after.x) < 1 &&
          Math.abs(snap.boardNode.y - s.board.after.y) < 1,
        { boardNode: snap.boardNode, expected: s.board.after },
      );
      check(
        '重启持久化：测试任务仍为待办（撤销完成落库）',
        snap.taskUndone === 'todo',
        snap.taskUndone,
      );
    } else {
      check('重启阶段执行', false, restart.error);
    }
  }
} catch (error) {
  failures.push(`fatal: ${String((error && error.stack) || error)}`);
  console.error('[zx13] FATAL', error);
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
console.log(
  `\n[zx13] ${passed}/${checks.length} 项通过，${failures.length} 项失败`,
);
if (failures.length) {
  console.log('[zx13] 失败项：');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('[zx13] PASS');
