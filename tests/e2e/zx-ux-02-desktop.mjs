/**
 * ZX-UX-02/11 真实 Tauri 窗口验收：清单树、唯一「任务」入口、拖拽/子清单/图标/删除迁移、任务中心深链。
 *
 * 形态：
 *   * 启动真实 `app/src-tauri/target/debug/zhixing`（真实 WKWebView + SQLite）；
 *   * 本地静态服务注入只读探针，不替换产品 IPC；
 *   * 拖拽使用 WebView 内真实 PointerEvent（6px 阈值 + elementFromPoint）；
 *   * DOM 与 SQLite（IPC）双重校验，并刷新页面验证持久化。
 *
 * 运行：
 *   pnpm --filter app build
 *   node tests/e2e/zx-ux-02-desktop.mjs
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
const PROBE = path.join(__dirname, 'zx-ux-02/probe.js');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-ux-02');
const HOME = '/tmp/zx-ux-02-home';
const PORT = 5173;
const APP_ID = 'com.zhixing.desktop';

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
  task: 'ZX-UX-02',
  steps: [],
  consoleErrors: [],
  appLog: '',
};

function record(name, value) {
  evidence.steps.push({ name, at: new Date().toISOString(), value });
  console.log(`[zx-ux-02] ${name}: ${JSON.stringify(value)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// 静态服务 + 探针命令队列
// ---------------------------------------------------------------------------
let readyResolve;
const probeReady = new Promise((resolve) => {
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
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (url.pathname === '/__probe-ready') {
        readyResolve?.();
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

function command(payload, timeout = 20_000) {
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

try {
  const ready = await Promise.race([
    probeReady.then(() => true),
    sleep(30_000).then(() => false),
  ]);
  if (!ready) throw new Error('探针 30s 内未就绪');
  await command({ type: 'sleep', ms: 900 });

  let env = await command({ type: 'env' });
  record('startup', {
    url: env.url,
    isTauri: env.isTauri,
    headings: env.headings,
    bodyText: env.bodyText.slice(0, 180),
  });

  if (env.bodyText.includes('开始 7 天试用')) {
    await command({ type: 'clickText', text: '开始 7 天试用' });
    await command({ type: 'sleep', ms: 700 });
  }

  const status = await command({ type: 'ipc', command: 'db_status' });
  record('db-status', {
    schemaVersion: status.schemaVersion,
    ready: status.ready,
    error: status.error,
  });
  assert(status.schemaVersion === 5, `schemaVersion 应为 5，实际 ${status.schemaVersion}`);

  // -------------------------------------------------------------------------
  // 入口：侧栏只有「任务」一个一级入口；清单树不渲染系统清单行
  // -------------------------------------------------------------------------
  env = await command({ type: 'env' });
  const inboxLinks = await command({
    type: 'ipc',
    command: 'lists_list',
    args: { includeDeleted: false },
  });
  record('seed-lists', inboxLinks.map((list) => ({
    id: list.id,
    name: list.name,
    parentId: list.parentId,
    isInbox: list.isInbox,
  })));

  // WKWebView 的 localStorage 不随 HOME 重置；清掉折叠状态后重新加载，
  // 保证本轮从“全展开”的默认状态开始。
  await command({ type: 'clearCollapsed' });
  await command({ type: 'reload' });
  await sleep(4500);
  await command({ type: 'goto', path: '/lists' });
  await command({ type: 'waitSelector', selector: '#lists-title' });
  const treeBefore = await command({ type: 'tree' });
  record('tree-before', treeBefore);
  const pageTreeCount = await command({
    type: 'count',
    selector: '.list-tree-panel--page',
  });
  assert(pageTreeCount === 0, `清单页不应再渲染页面级清单树，实际 ${pageTreeCount} 棵`);
  const listsLayoutCount = await command({
    type: 'count',
    selector: '.lists-layout',
  });
  assert(listsLayoutCount === 0, '清单页不应再有 lists-layout 左栏');
  const layout1280 = await command({ type: 'layout' });
  record('layout-1280', layout1280);
  assert(!layout1280.overflow, '1280 宽度下清单页不应横向溢出');
  assert(
    layout1280.detail?.clientWidth === layout1280.page?.clientWidth,
    '详情区应占满清单页可用宽度',
  );
  const sidebarInbox = treeBefore.filter(
    (row) => row.name === '收件箱',
  );
  assert(sidebarInbox.length === 0, '清单树不应再渲染系统收件箱行');
  assert(
    treeBefore.some((row) => row.name === '工作' && row.scope === 'sidebar'),
    '侧栏树里应有「工作」',
  );
  const entryEnv = await command({ type: 'env' });
  assert(entryEnv.bodyText.includes('任务'), '侧栏应有「任务」入口');
  assert(!entryEnv.bodyText.includes('收件箱'), '侧栏不应再出现「收件箱」');

  // 真实窗口里点击侧栏清单，页面详情随深链切换（唯一清单树的选中态）。
  await command({
    type: 'clickSelector',
    selector: '.list-tree-panel--sidebar [data-list-id="life"] .list-tree-link',
  });
  const switchedEnv = await command({ type: 'env' });
  record('switch-list', {
    url: switchedEnv.url,
    headings: switchedEnv.headings,
  });
  assert(
    switchedEnv.headings.includes('生活'),
    `点击侧栏「生活」后应显示生活清单，实际 ${JSON.stringify(switchedEnv.headings)}`,
  );
  await command({ type: 'goto', path: '/lists' });

  // -------------------------------------------------------------------------
  // 拖拽：阅读计划 → 工作 中部，成为子清单
  // -------------------------------------------------------------------------
  const drag = await command(
    {
      type: 'dragList',
      sourceId: 'reading',
      targetId: 'work',
      zone: 'child',
    },
    15_000,
  );
  record('drag-reading-under-work', drag);
  assert(drag.during.ghost, '拖拽期间应出现 ghost');
  assert(drag.during.dropChild, '目标行中部应显示成为子清单的落点');
  const listsAfterDrag = await command({ type: 'lists' });
  const reading = listsAfterDrag.find((list) => list.id === 'reading');
  assert(reading?.parentId === 'work', `阅读计划 parentId 应为 work，实际 ${reading?.parentId}`);
  const treeAfterDrag = await command({ type: 'tree' });
  record('tree-after-drag', treeAfterDrag);
  record('storage-after-drag', await command({ type: 'storage' }));
  const readingRow = treeAfterDrag.find(
    (row) => row.name === '阅读计划' && row.scope === 'sidebar',
  );
  assert(readingRow?.depth === 2, `侧栏树中阅读计划应为第 2 层，实际 ${readingRow?.depth}`);

  // -------------------------------------------------------------------------
  // 新建第 3 层子清单 + 图标
  // -------------------------------------------------------------------------
  await command({ type: 'openMenu', name: '阅读计划', item: '新建子清单' });
  let dialog = await command({ type: 'dialog' });
  assert(dialog.open && dialog.text.includes('新建子清单'), '应打开新建子清单弹层');
  await command({ type: 'fillLabel', label: '名称', value: '项目 X' });
  await command({
    type: 'clickSelector',
    selector: '[aria-label="图标：星标"]',
  });
  await command({ type: 'clickDialogButton', text: '保存' });
  await command({ type: 'waitText', text: '项目 X' });
  let lists = await command({ type: 'lists' });
  const project = lists.find((list) => list.name === '项目 X');
  assert(project, '应创建项目 X');
  assert(project.parentId === 'reading', '项目 X 应挂在阅读计划下');
  assert(project.icon === 'star', `图标应为 star，实际 ${project.icon}`);
  record('child-created', {
    id: project.id,
    parentId: project.parentId,
    icon: project.icon,
  });

  // 第 3 层不再出现“新建子清单”。
  await command({ type: 'openMenu', name: '项目 X', item: '移动到…' });
  dialog = await command({ type: 'dialog' });
  assert(dialog.open && dialog.text.includes('移动「项目 X」'), '第 3 层应提供移动弹层');
  await command({ type: 'clickDialogButton', text: '取消' });

  // -------------------------------------------------------------------------
  // 重命名 / 颜色 / 图标（页头编辑）
  // -------------------------------------------------------------------------
  await command({ type: 'goto', path: `/lists/${project.id}` });
  await command({ type: 'waitText', text: '项目 X' });
  await command({ type: 'clickText', text: '编辑清单' });
  await command({ type: 'fillLabel', label: '名称', value: '项目 X2' });
  await command({
    type: 'clickSelector',
    selector: '[aria-label="颜色：绿色"]',
  });
  await command({
    type: 'clickSelector',
    selector: '[aria-label="图标：闪电"]',
  });
  await command({ type: 'clickDialogButton', text: '保存' });
  await command({ type: 'waitText', text: '项目 X2' });
  const breadcrumb = await command({
    type: 'text',
    selector: '.lists-breadcrumb',
  });
  record('breadcrumb', breadcrumb);
  assert(
    breadcrumb.includes('工作') &&
      breadcrumb.includes('阅读计划') &&
      breadcrumb.includes('项目 X2'),
    `深层清单应显示完整面包屑，实际 ${breadcrumb}`,
  );
  lists = await command({ type: 'lists' });
  const renamed = lists.find((list) => list.id === project.id);
  record('renamed', {
    name: renamed?.name,
    color: renamed?.color,
    icon: renamed?.icon,
  });
  assert(renamed?.name === '项目 X2', '名称应更新为项目 X2');
  assert(renamed?.color === '#2f9e73', '颜色应为绿色');
  assert(renamed?.icon === 'bolt', '图标应为闪电');

  // -------------------------------------------------------------------------
  // 折叠 / 展开（侧栏唯一清单树）
  // -------------------------------------------------------------------------
  await command({ type: 'goto', path: '/lists/work' });
  await command({
    type: 'clickSelector',
    selector: '.list-tree-panel--sidebar [aria-label="折叠 工作"]',
  });
  await command({ type: 'sleep', ms: 250 });
  let collapsedTree = await command({ type: 'tree' });
  assert(
    !collapsedTree.some(
      (row) => row.name === '阅读计划' && row.scope === 'sidebar',
    ),
    '折叠工作后侧栏树不应显示子清单',
  );
  await command({
    type: 'clickSelector',
    selector: '.list-tree-panel--sidebar [aria-label="展开 工作"]',
  });
  await command({ type: 'sleep', ms: 250 });
  collapsedTree = await command({ type: 'tree' });
  assert(
    collapsedTree.some(
      (row) => row.name === '阅读计划' && row.scope === 'sidebar',
    ),
    '展开工作后侧栏树应恢复子清单',
  );
  record('collapse-toggle', collapsedTree.map((row) => row.name));

  // -------------------------------------------------------------------------
  // 删除「工作」：4 个任务进收件箱，1 个直接子清单上移
  // -------------------------------------------------------------------------
  await command({ type: 'goto', path: '/lists/work' });
  await command({ type: 'waitText', text: '工作' });
  await command({ type: 'clickText', text: '删除清单' });
  dialog = await command({ type: 'dialog' });
  record('delete-dialog', dialog.text);
  assert(
    dialog.text.includes('2 个任务会移到未安排') &&
      dialog.text.includes('1 个子清单会上移一级'),
    '确认文案应包含任务数与子清单数',
  );
  await command({ type: 'clickDialogButton', text: '删除清单' });
  await command({ type: 'sleep', ms: 900 });
  const listsAfterDelete = await command({ type: 'lists' });
  const work = listsAfterDelete.find((list) => list.id === 'work');
  const readingAfter = listsAfterDelete.find((list) => list.id === 'reading');
  const projectAfter = listsAfterDelete.find((list) => list.id === project.id);
  const tasksAfter = await command({ type: 'tasks' });
  const movedTaskIds = ['seed-task-review', 'seed-task-done'];
  record('delete-result', {
    workDeletedAt: work?.deletedAt,
    readingParentId: readingAfter?.parentId,
    projectParentId: projectAfter?.parentId,
    moved: movedTaskIds.map((id) => ({
      id,
      listId: tasksAfter.find((task) => task.id === id)?.listId,
    })),
  });
  assert(work?.deletedAt, '工作清单应软删除');
  assert(readingAfter?.parentId === null, '阅读计划应上移到根级');
  assert(
    projectAfter?.parentId === 'reading',
    '项目 X2 应保留在阅读计划下（孙辈不直接上移）',
  );
  for (const id of movedTaskIds) {
    assert(
      tasksAfter.find((task) => task.id === id)?.listId === 'inbox',
      `${id} 应移到系统 capture 清单`,
    );
  }

  // 任务中心：无日期任务出现在「未安排」，UI 不再出现「收件箱」。
  await command({ type: 'goto', path: '/tasks?filter=undated' });
  await command({ type: 'waitText', text: '未安排' });
  const tasksEnv = await command({ type: 'env' });
  record('tasks-undated', {
    url: tasksEnv.url,
    headings: tasksEnv.headings,
    bodyText: tasksEnv.bodyText.slice(0, 240),
  });
  assert(!tasksEnv.bodyText.includes('收件箱'), '任务中心 UI 不应出现「收件箱」');
  assert(tasksEnv.bodyText.includes('全部任务'), '任务中心标题应为「全部任务」');

  // -------------------------------------------------------------------------
  // /inbox?task= 旧深链 → /tasks?task= + 刷新持久化
  // -------------------------------------------------------------------------
  await command({ type: 'goto', path: '/inbox?task=seed-task-inbox' });
  await command({ type: 'waitSelector', selector: '#task-detail-title' });
  const deepLink = await command({ type: 'openTaskDetail' });
  const deepLinkEnv = await command({ type: 'env' });
  record('deep-link', { ...deepLink, url: deepLinkEnv.url });
  assert(
    deepLinkEnv.url.includes('/tasks?task=seed-task-inbox'),
    `旧深链应重定向到 /tasks?task=，实际 ${deepLinkEnv.url}`,
  );
  assert(
    deepLink.value === '记一个想法：把日历和笔记连起来',
    '深链应打开对应任务详情',
  );

  await command({ type: 'reload' });
  await sleep(4500);
  await command({ type: 'goto', path: '/lists', wait: 1200 });
  const treeAfterReload = await command({ type: 'tree' });
  const listsAfterReload = await command({ type: 'lists' });
  record('after-reload', {
    tree: treeAfterReload.map((row) => ({ name: row.name, depth: row.depth })),
    readingParentId: listsAfterReload.find((list) => list.id === 'reading')?.parentId,
    workDeletedAt: listsAfterReload.find((list) => list.id === 'work')?.deletedAt,
  });
  assert(
    !treeAfterReload.some((row) => row.name === '工作'),
    '刷新后被删除的工作清单不应出现',
  );
  assert(
    treeAfterReload.some((row) => row.name === '阅读计划' && row.depth === 1),
    '刷新后阅读计划应保持根级',
  );
  assert(
    treeAfterReload.some((row) => row.name === '项目 X2' && row.depth === 2),
    '刷新后项目 X2 应保持在阅读计划下',
  );

  const finalEnv = await command({ type: 'env' });
  evidence.consoleErrors = finalEnv.errors ?? [];
  assert(
    evidence.consoleErrors.length === 0,
    `控制台不应有 error：${evidence.consoleErrors.join(' | ')}`,
  );

  evidence.verdict = {
    schemaVersion: status.schemaVersion,
    singleTaskEntry:
      entryEnv.bodyText.includes('任务') &&
      !entryEnv.bodyText.includes('收件箱'),
    dragChild: reading.parentId === 'work',
    childAndIcon: project.icon === 'star',
    renamed: renamed?.name === '项目 X2' && renamed?.icon === 'bolt',
    deleteMigration:
      readingAfter?.parentId === null && projectAfter?.parentId === 'reading',
    deepLink: deepLink.value,
    consoleErrors: evidence.consoleErrors,
  };
} catch (error) {
  evidence.error = String(error?.stack || error);
  console.error(`[zx-ux-02] FAILED: ${evidence.error}`);
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

console.log(JSON.stringify(evidence.verdict ?? { failed: true }, null, 2));
process.exit(evidence.failed ? 1 : 0);
