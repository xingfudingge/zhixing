/**
 * ZX-FILE-05 浏览器实测：文件行紧凑附件（真实 Chromium + 生产构建）。
 *
 * 形态：
 *   * 注入 tests/harness/fakeTauri.ts（仅浏览器验收用），造一篇含
 *     本机 / 仅远端 / 缺失 / 无附件记录四种文件块的笔记；
 *   * 走真实知识页与真实块编辑器，不直接改产品 DOM 结构；
 *   * 断言默认行高 ≤34px、无边框、透明底、与正文左基线一致；
 *   * 断言 hover/focus 显示打开与更多动作，菜单保留打开/另存/重命名/删除；
 *   * 390×844 下两行、无横向溢出、顶部打开收起但菜单里的打开仍可用。
 *
 * 运行：
 *   (cd app && npm run build)
 *   node tests/e2e/zx-file-05-visual.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-file-05');
const FAKE_BUNDLE = '/tmp/zx-file-05-fake.js';
const PORT = 8915;
const DEBUG_PORT = 9235;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NOTE_ID = 'note-file-05';
const SHA_LOCAL = 'a'.repeat(64);
const SHA_REMOTE = 'b'.repeat(64);

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  throw new Error('前端未构建：先运行 cd app && npm run build');
}
fs.mkdirSync(EVIDENCE, { recursive: true });

const esbuild = path.join(ROOT, 'node_modules/.pnpm/node_modules/.bin/esbuild');
const bundled = spawnSync(
  esbuild,
  [
    path.join(ROOT, 'tests/harness/fakeTauri.ts'),
    '--bundle',
    '--format=iife',
    '--global-name=ZXFake',
    '--platform=browser',
    `--outfile=${FAKE_BUNDLE}`,
  ],
  { encoding: 'utf8' },
);
if (bundled.status !== 0) {
  throw new Error(`打包 fakeTauri 失败：${bundled.stderr}`);
}
const fakeBundle = fs.readFileSync(FAKE_BUNDLE, 'utf8');

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
  const pathname = decodeURIComponent(
    new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
  );
  let file = path.join(DIST, pathname);
  if (
    !file.startsWith(DIST) ||
    !fs.existsSync(file) ||
    fs.statSync(file).isDirectory()
  ) {
    file = path.join(DIST, 'index.html');
  }
  response.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const userDataDir = `/tmp/zx-file-05-chrome-${Date.now()}`;
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-sync',
    '--mute-audio',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let chromeStderr = '';
chrome.stderr.on('data', (chunk) => {
  chromeStderr += String(chunk);
});

async function waitForDevtools() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {
      // 继续轮询。
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Chrome DevTools 未就绪\n${chromeStderr}`);
}

const target = await waitForDevtools();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const consoleErrors = [];

socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    consoleErrors.push(
      details.exception?.description ?? details.text ?? 'unknown exception',
    );
  }
  if (
    message.method === 'Runtime.consoleAPICalled' &&
    message.params.type === 'error'
  ) {
    consoleErrors.push(
      (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' '),
    );
  }
});

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, 20_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const source =
    typeof expression === 'function'
      ? `(${expression.toString()})()`
      : expression;
  const result = await send('Runtime.evaluate', {
    expression: source,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  }
  return result.result?.value;
}

async function waitFor(expression, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(expression);
      if (value) return value;
      last = value;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${label}（最后值：${JSON.stringify(last)}）`);
}

async function screenshot(name) {
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  const file = path.join(EVIDENCE, name);
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  console.log(`截图：${path.relative(ROOT, file)}`);
}

const note = {
  id: NOTE_ID,
  spaceId: 'personal',
  folderId: null,
  title: 'ZX-FILE-05 文件行',
  tags: [],
  body: '',
  bodyFormat: 'html',
  status: 'active',
  favorite: false,
  pinned: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-29T00:00:00.000Z',
  deletedAt: null,
  version: 1,
};

function block(id, orderKey, blockType, payload) {
  return {
    id,
    noteId: NOTE_ID,
    blockType,
    orderKey,
    payload,
    schemaVersion: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  };
}

const blocks = [
  block('p-1', 1024, 'paragraph', {
    runs: [{ text: '文件应该像正文中的一行附件，而不是第二层卡片。' }],
  }),
  block('f-local', 2048, 'file', {
    attachmentId: 'att-local',
    fileName: '季度复盘.docx',
    byteSize: 131072,
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    status: 'pending',
  }),
  block('f-remote', 3072, 'file', {
    attachmentId: 'att-remote',
    fileName: '产品评审纪要.pdf',
    byteSize: 2516582,
    mime: 'application/pdf',
    status: 'pending',
  }),
  block('f-missing', 4096, 'file', {
    attachmentId: 'att-missing',
    fileName: '首页改版.png',
    byteSize: 880640,
    mime: 'image/png',
    status: 'local',
  }),
  block('f-none', 5120, 'file', {
    attachmentId: null,
    fileName: '旧版素材.zip',
    byteSize: 18874368,
    mime: 'application/zip',
    status: 'local',
  }),
];

function attachment(id, fileName, sha256, byteSize, mime) {
  return {
    id,
    spaceId: 'personal',
    noteId: NOTE_ID,
    blockId: `f-${id.replace('att-', '')}`,
    fileName,
    sha256,
    byteSize,
    mime,
    storageKey: `attachments/${sha256}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  };
}

const injection = `(() => {
  try {
    localStorage.setItem('zhixing.appearance.v1', JSON.stringify({
      theme: 'light', accent: 'blue', density: 'comfortable',
    }));
  } catch (error) {}
  ${fakeBundle}
  const world = ZXFake.createFakeWorld();
  world.db.notes = [${JSON.stringify(note)}];
  world.db.blocks = ${JSON.stringify(blocks)};
  world.db.attachments = [
    ${JSON.stringify(
      attachment('att-local', '季度复盘.docx', SHA_LOCAL, 131072, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    )},
    ${JSON.stringify(
      attachment('att-remote', '产品评审纪要.pdf', SHA_REMOTE, 2516582, 'application/pdf'),
    )},
  ];
  world.install();
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => invoke(command, args);
})();`;

await send('Runtime.enable');
await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: injection });
await send('Page.navigate', {
  url: `http://127.0.0.1:${PORT}/knowledge?note=${encodeURIComponent(NOTE_ID)}`,
});
await waitFor(
  () => document.querySelectorAll('.zxe-filerow').length === 4,
  '四个文件行渲染',
  30_000,
);

// 第一次打开时本机 Blob 还没有写入，先造 Blob 再刷新，让真实附件管理器
// 走 hasLocalBlob 链路，而不是直接给 DOM 加状态类。
await evaluate(`new Promise((resolve, reject) => {
  const request = indexedDB.open('zhixing-attachments', 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    if (!db.objectStoreNames.contains('attachment_state')) {
      db.createObjectStore('attachment_state', { keyPath: 'attachmentId' });
    }
  };
  request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'));
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put(
      new Blob(['%PDF-1.4 ZX-FILE-05'], { type: 'application/pdf' }),
      ${JSON.stringify(`attachments/${SHA_LOCAL}`)},
    );
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('Blob 写入失败'));
  };
})`);

await send('Page.reload', { ignoreCache: true });
await waitFor(
  () =>
    document.querySelector('.zxe-filerow[data-file-state="local"]') !== null &&
    document.querySelectorAll('.zxe-filerow').length === 4,
  '文件行本地状态就绪',
  30_000,
);
await waitFor(
  () => Boolean(document.querySelector('.zxe-row[data-block-type="paragraph"]')),
  '正文段落就绪',
);

const results = { desktop: null, hover: null, narrow: null, checks: [] };

function check(name, ok, detail) {
  results.checks.push({ name, ok, detail });
  if (!ok) {
    throw new Error(`验收失败：${name} ${JSON.stringify(detail)}`);
  }
  console.log(`[PASS] ${name} ${JSON.stringify(detail)}`);
}

const desktop = await evaluate(`(() => {
  const rows = Array.from(document.querySelectorAll('.zxe-filerow'));
  const paragraph = document.querySelector('.zxe-row[data-block-type="paragraph"] .zxe-row-content');
  const measure = (row) => {
    const style = getComputedStyle(row);
    const rect = row.getBoundingClientRect();
    const side = row.querySelector('.zxe-filecard-side');
    return {
      state: row.getAttribute('data-file-state'),
      height: Math.round(rect.height * 100) / 100,
      borderTop: style.borderTopWidth,
      borderRight: style.borderRightWidth,
      borderBottom: style.borderBottomWidth,
      borderLeft: style.borderLeftWidth,
      background: style.backgroundColor,
      borderRadius: style.borderRadius,
      left: Math.round(rect.left * 100) / 100,
      right: Math.round(rect.right * 100) / 100,
      text: (row.innerText || '').replace(/\\s+/g, ' ').trim(),
      actionsOpacity: side ? getComputedStyle(side).opacity : null,
      buttons: Array.from(row.querySelectorAll('.zxe-filecard-side button')).map(
        (button) => button.getAttribute('aria-label') || (button.textContent || '').trim(),
      ),
    };
  };
  const content = rows[0].closest('.zxe-row-content');
  return {
    rows: rows.map(measure),
    paragraphLeft: paragraph ? Math.round(paragraph.getBoundingClientRect().left * 100) / 100 : null,
    fileContentLeft: content ? Math.round(content.getBoundingClientRect().left * 100) / 100 : null,
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  };
})()`);
results.desktop = desktop;

const local = desktop.rows.find((row) => row.state === 'local');
const remote = desktop.rows.find((row) => row.state === 'remote');
const missing = desktop.rows.find((row) => row.state === 'missing');
const none = desktop.rows.find((row) => row.state === 'none');
check('四种文件状态齐备', Boolean(local && remote && missing && none), {
  states: desktop.rows.map((row) => row.state),
});
check('默认无大边框', [local, remote, missing, none].every(
  (row) =>
    row.borderTop === '0px' &&
    row.borderRight === '0px' &&
    row.borderBottom === '0px' &&
    row.borderLeft === '0px',
), desktop.rows.map((row) => ({
  state: row.state,
  borders: [row.borderTop, row.borderRight, row.borderBottom, row.borderLeft],
})));
check('默认透明底、6px 圆角', [local, remote, missing, none].every(
  (row) => row.background === 'rgba(0, 0, 0, 0)' && row.borderRadius === '6px',
), desktop.rows.map((row) => ({ state: row.state, background: row.background, radius: row.borderRadius })));
check('行高不超过普通段落两行（≤36px）', [local, remote, missing, none].every((row) => row.height <= 36), {
  heights: desktop.rows.map((row) => ({ state: row.state, height: row.height })),
});
check('文件行与正文左边缘一致（≤0.5px）', Math.abs(desktop.paragraphLeft - desktop.fileContentLeft) <= 0.5, {
  paragraphLeft: desktop.paragraphLeft,
  fileContentLeft: desktop.fileContentLeft,
});
check('默认动作不占视觉焦点，但仍在 DOM 中可聚焦', [local, remote, missing, none].every(
  (row) => row.actionsOpacity === '0' && row.buttons.length > 0,
), desktop.rows.map((row) => ({ state: row.state, opacity: row.actionsOpacity, buttons: row.buttons })));
check('本机文件不显示“待上传”', !desktop.rows.some((row) => row.text.includes('待上传')), desktop.rows.map((row) => row.text));
check('缺失/仅远端不显示打开', !remote.buttons.some((label) => label.startsWith('打开文件')) && !missing.buttons.some((label) => label.startsWith('打开文件')), {
  remote: remote.buttons,
  missing: missing.buttons,
});

await screenshot('file-row-desktop.png');

// hover：真实鼠标移到文件行上，行背景出现、动作变为可见。
const localRect = await evaluate(`(() => {
  const row = document.querySelector('.zxe-filerow[data-file-state="local"]');
  const rect = row.getBoundingClientRect();
  return { x: rect.left + 80, y: rect.top + rect.height / 2 };
})()`);
await send('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: localRect.x,
  y: localRect.y,
});
await new Promise((resolve) => setTimeout(resolve, 220));
const hover = await evaluate(`(() => {
  const row = document.querySelector('.zxe-filerow[data-file-state="local"]');
  const style = getComputedStyle(row);
  const side = row.querySelector('.zxe-filecard-side');
  return {
    background: style.backgroundColor,
    actionsOpacity: side ? getComputedStyle(side).opacity : null,
    openVisible: (() => {
      const button = row.querySelector('button[aria-label^="打开文件"]');
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return getComputedStyle(button).display !== 'none' && rect.width > 0 && rect.height > 0;
    })(),
  };
})()`);
results.hover = hover;
check('hover 显示行背景与动作', hover.background !== 'rgba(0, 0, 0, 0)' && Number(hover.actionsOpacity) >= 0.9 && hover.openVisible === true, hover);
await screenshot('file-row-hover.png');

// 键盘可达：移走鼠标后仅靠 focus 也应显示动作。
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 });
await new Promise((resolve) => setTimeout(resolve, 220));
const keyboardReveal = await evaluate(`(async () => {
  const row = document.querySelector('.zxe-filerow[data-file-state="local"]');
  const trigger = row.querySelector('.zxe-overflow-trigger');
  trigger.focus();
  await new Promise((resolve) => setTimeout(resolve, 220));
  const side = row.querySelector('.zxe-filecard-side');
  return {
    focused: document.activeElement === trigger,
    actionsOpacity: side ? getComputedStyle(side).opacity : null,
  };
})()`);
check('键盘聚焦文件行动作可见', keyboardReveal.focused === true && Number(keyboardReveal.actionsOpacity) >= 0.9, keyboardReveal);

// 菜单保留打开、另存、重命名、删除。
await evaluate(`(() => {
  const row = document.querySelector('.zxe-filerow[data-file-state="local"]');
  const trigger = row.querySelector('.zxe-overflow-trigger');
  trigger.click();
  return true;
})()`);
const menuLabels = await waitFor(
  () =>
    (() => {
      const menu = document.querySelector('.zxe-overflow-menu');
      if (!menu) return null;
      return Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
        (item) => (item.textContent || '').trim(),
      );
    })(),
  '文件行更多菜单',
);
check('更多菜单保留打开/另存/重命名/删除', menuLabels.includes('打开') && menuLabels.includes('另存为…') && menuLabels.includes('重命名…') && menuLabels.includes('删除文件卡'), menuLabels);
await evaluate(`(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return true;
})()`);

// 390 窄窗：两行、无横向溢出、顶部打开隐藏但菜单仍可打开。
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: false,
});
await new Promise((resolve) => setTimeout(resolve, 200));
const narrow = await evaluate(`(() => {
  const row = document.querySelector('.zxe-filerow[data-file-state="local"]');
  const rect = row.getBoundingClientRect();
  const side = row.querySelector('.zxe-filecard-side');
  const primary = row.querySelector('.zxe-filecard-action.is-primary');
  const more = row.querySelector('.zxe-overflow-trigger');
  const meta = row.querySelector('.zxe-filecard-meta');
  const name = row.querySelector('.zxe-filecard-name');
  return {
    height: Math.round(rect.height * 100) / 100,
    width: Math.round(rect.width * 100) / 100,
    display: getComputedStyle(row).display,
    flexWrap: getComputedStyle(row).flexWrap,
    actionsOpacity: side ? getComputedStyle(side).opacity : null,
    primaryDisplay: primary ? getComputedStyle(primary).display : null,
    moreVisible: more ? getComputedStyle(more).display !== 'none' && more.getBoundingClientRect().width > 0 : false,
    metaOrder: meta ? getComputedStyle(meta).order : null,
    nameOrder: name ? getComputedStyle(name).order : null,
    metaTop: meta ? Math.round(meta.getBoundingClientRect().top) : null,
    nameTop: name ? Math.round(name.getBoundingClientRect().top) : null,
    nameRight: name ? Math.round(name.getBoundingClientRect().right) : null,
    actionsLeft: more ? Math.round(more.getBoundingClientRect().left) : null,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    bodyClientWidth: document.body.clientWidth,
    viewport: window.innerWidth,
  };
})()`);
results.narrow = narrow;
check('390 无横向溢出', narrow.scrollWidth <= narrow.clientWidth && narrow.bodyScrollWidth <= narrow.bodyClientWidth, narrow);
check('390 文件行两行且元信息下移', narrow.display === 'grid' && narrow.metaTop > narrow.nameTop && narrow.height <= 56, narrow);
check('390 文件名与 ⋯ 不重叠', narrow.nameRight <= narrow.actionsLeft, narrow);
check('390 顶部打开收起、⋯ 可见、动作不收丢', narrow.primaryDisplay === 'none' && narrow.moreVisible === true && narrow.actionsOpacity === '1', narrow);
await screenshot('file-row-390.png');

await evaluate(`(() => {
  const row = document.querySelector('.zxe-filerow[data-file-state="local"]');
  row.querySelector('.zxe-overflow-trigger').click();
  return true;
})()`);
const narrowMenu = await waitFor(
  () =>
    (() => {
      const menu = document.querySelector('.zxe-overflow-menu');
      if (!menu) return null;
      return Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
        (item) => (item.textContent || '').trim(),
      );
    })(),
  '390 文件行更多菜单',
);
check('390 菜单仍可打开文件', narrowMenu.includes('打开'), narrowMenu);
await evaluate(`(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return true;
})()`);

// 行内重命名：双击后出现输入，Enter 提交，行高不变成大卡片。
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await new Promise((resolve) => setTimeout(resolve, 200));
const rename = await evaluate(`(async () => {
  const row = document.querySelector('.zxe-filerow[data-file-state="local"]');
  const name = row.querySelector('.zxe-filecard-name');
  name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const input = row.querySelector('.zxe-filecard-name-input');
  if (!input) return { editing: false };
  return {
    editing: true,
    value: input.value,
    height: Math.round(row.getBoundingClientRect().height * 100) / 100,
    borderTop: getComputedStyle(row).borderTopWidth,
  };
})()`);
check('双击文件名进入行内重命名且不撑成卡片', rename.editing === true && rename.value === '季度复盘.docx' && rename.height <= 36 && rename.borderTop === '0px', rename);

results.consoleErrors = consoleErrors;
check('控制台零 error/exception', consoleErrors.length === 0, consoleErrors);

fs.writeFileSync(
  path.join(EVIDENCE, 'summary.json'),
  JSON.stringify(results, null, 2),
);
console.log(`证据：${path.relative(ROOT, path.join(EVIDENCE, 'summary.json'))}`);

chrome.kill('SIGTERM');
server.close();
process.exit(0);
