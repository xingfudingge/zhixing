/**
 * ZX-NOTE-08 浏览器实测：内容块连续排版与去框化（真实 Chromium + 生产构建）。
 *
 * 形态：
 *   * 注入 tests/harness/fakeTauri.ts（仅浏览器验收用），造一篇同时包含
 *     标题/段落/列表/待办/代码/表格/公式/画板/链接/文件块的笔记；
 *   * 走真实知识页与真实块编辑器，不直接改产品 DOM 结构；
 *   * 几何断言：文本块无 border/background/圆角、正文左基线一致（≤0.5px）、
 *     gutter 绝对定位且默认不占正文宽、对象 surface 圆角/边线统一；
 *   * hover / 搜索命中只出现左侧竖线或浅色文本背景，不给整行铺卡片；
 *   * 桌面、专注模式、390 窄窗均无横向溢出。
 *
 * 运行：
 *   (cd app && npm run build)
 *   node tests/e2e/zx-note-08-visual.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'app/dist');
const EVIDENCE = path.join(ROOT, 'tests/evidence/zx-note-08');
const FAKE_BUNDLE = '/tmp/zx-note-08-fake.js';
const PORT = 8916;
const DEBUG_PORT = 9236;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NOTE_ID = 'note-note-08';

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

const userDataDir = `/tmp/zx-note-08-chrome-${Date.now()}`;
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
    await new Promise((resolve) => setTimeout(resolve, 60));
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

function rounded(value) {
  return Math.round(value * 100) / 100;
}

const note = {
  id: NOTE_ID,
  spaceId: 'personal',
  folderId: null,
  title: 'ZX-NOTE-08 连续排版',
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
  block('h2', 1024, 'heading2', {
    runs: [{ text: '连续排版验收' }],
  }),
  block('p1', 2048, 'paragraph', {
    runs: [
      {
        text:
          '正文应该是一张连续的纸：段落、标题、列表、待办共享同一条左基线，默认没有独立边框、整块背景和大圆角。',
      },
    ],
  }),
  block('p2', 3072, 'paragraph', {
    runs: [
      {
        text:
          '这段文字用来确认两段正文之间没有卡片缝，也没有每块 56px 的内缩；块手柄只在 hover 或键盘聚焦时出现在左侧页边距。',
      },
    ],
  }),
  block('quote1', 3584, 'quote', {
    runs: [{ text: '引用块只保留左侧竖线与浅底，不画外框。' }],
    source: '验收文档',
  }),
  block('ul', 4096, 'bullet_list', {
    runs: [{ text: '列表标记属于语义缩进，不改变内容列左基线' }],
  }),
  block('todo1', 5120, 'todo', {
    runs: [{ text: '待办复选框同样不制造卡片' }],
    checked: false,
  }),
  block('code1', 6144, 'code', {
    code: 'export function add(a: number, b: number) {\n  return a + b;\n}',
    language: 'typescript',
  }),
  block('table1', 7168, 'table', {
    rows: [
      ['列 A', '列 B'],
      ['Alpha', '1'],
      ['Beta', '2'],
    ],
    header: true,
  }),
  block('formula1', 8192, 'formula', {
    latex: 'a^2 + b^2 = c^2',
  }),
  block('board1', 9216, 'board', {
    boardId: null,
    title: '排版验收画板',
  }),
  block('link1', 10240, 'link', {
    url: 'https://example.com/zx-note-08',
    title: '连续排版验收链接',
  }),
  block('file1', 11264, 'file', {
    attachmentId: null,
    fileName: '排版验收.txt',
    byteSize: 1234,
    mime: 'text/plain',
    status: 'local',
  }),
  // 图片块复用文件行（mime=image/*）：外壳同样不能是卡片。
  block('image1', 12288, 'file', {
    attachmentId: null,
    fileName: '排版验收.png',
    byteSize: 2048,
    mime: 'image/png',
    status: 'local',
  }),
];

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
  () =>
    document.querySelectorAll('.zxe-row').length >= 11 &&
    Boolean(document.querySelector('.zxe-row[data-block-type="paragraph"]')),
  '正文块渲染',
  30_000,
);

const results = { desktop: null, hover: null, active: null, search: null, focus: null, widths: [], narrow: null, checks: [] };

function check(name, ok, detail) {
  results.checks.push({ name, ok, detail });
  if (!ok) {
    throw new Error(`验收失败：${name} ${JSON.stringify(detail)}`);
  }
  console.log(`[PASS] ${name} ${JSON.stringify(detail)}`);
}

function measureExpression() {
  return `(() => {
    const round = (value) => Math.round(value * 100) / 100;
    const rowInfo = (row) => {
      const style = getComputedStyle(row);
      const content = row.querySelector('.zxe-row-content');
      const gutter = row.querySelector('.zxe-block-gutter');
      const contentRect = content.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const gutterRect = gutter ? gutter.getBoundingClientRect() : null;
      return {
        id: row.dataset.blockId,
        type: row.dataset.blockType,
        className: row.className,
        borderTop: style.borderTopWidth,
        borderRight: style.borderRightWidth,
        borderBottom: style.borderBottomWidth,
        borderLeft: style.borderLeftWidth,
        background: style.backgroundColor,
        borderRadius: style.borderRadius,
        paddingLeft: style.paddingLeft,
        rowLeft: round(rowRect.left),
        rowRight: round(rowRect.right),
        rowWidth: round(rowRect.width),
        contentLeft: round(contentRect.left),
        contentRight: round(contentRect.right),
        contentWidth: round(contentRect.width),
        contentPaddingLeft: getComputedStyle(content).paddingLeft,
        contentBackground: getComputedStyle(content).backgroundColor,
        gutter: gutter ? {
          position: getComputedStyle(gutter).position,
          width: getComputedStyle(gutter).width,
          opacity: getComputedStyle(gutter).opacity,
          pointerEvents: getComputedStyle(gutter).pointerEvents,
          left: round(gutterRect.left),
          right: round(gutterRect.right),
          rowLeft: round(rowRect.left),
        } : null,
      };
    };
    const rows = Array.from(document.querySelectorAll('.zxe-row'));
    const byId = Object.fromEntries(rows.map((row) => [row.dataset.blockId, rowInfo(row)]));
    const surface = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        borderTop: style.borderTopWidth,
        borderRight: style.borderRightWidth,
        borderBottom: style.borderBottomWidth,
        borderLeft: style.borderLeftWidth,
        borderRadius: style.borderRadius,
        background: style.backgroundColor,
        boxShadow: style.boxShadow,
        rect: (() => {
          const rect = el.getBoundingClientRect();
          return { left: round(rect.left), width: round(rect.width), height: round(rect.height) };
        })(),
      };
    };
    return {
      rows: byId,
      order: rows.map((row) => row.dataset.blockId),
      textRows: rows.filter((row) =>
        ['paragraph', 'heading2', 'bullet_list', 'todo'].includes(row.dataset.blockType),
      ).map((row) => rowInfo(row)),
      code: surface('.zxe-code'),
      codeBody: surface('.zxe-code-body'),
      table: surface('.zxe-table-wrap'),
      tableCell: (() => {
        const el = document.querySelector('.zxe-table tbody td, .zxe-table td');
        if (!el) return null;
        const style = getComputedStyle(el);
        return {
          borderRight: style.borderRightWidth,
          borderBottom: style.borderBottomWidth,
        };
      })(),
      formula: surface('.zxe-formula'),
      quote: surface('.zxe-quote'),
      board: surface('.zxe-board .bw-embed'),
      link: surface('.zxe-linkblock'),
      file: byId.file1,
      fileCard: (() => {
        const el = document.querySelector('.zxe-filerow');
        if (!el) return null;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          height: round(rect.height),
          borderTop: style.borderTopWidth,
          borderRight: style.borderRightWidth,
          borderBottom: style.borderBottomWidth,
          borderLeft: style.borderLeftWidth,
          background: style.backgroundColor,
          borderRadius: style.borderRadius,
        };
      })(),
      imageCard: (() => {
        const el = document.querySelector(
          '.zxe-row[data-block-id="image1"] .zxe-filerow',
        );
        if (!el) return null;
        const style = getComputedStyle(el);
        return {
          borderTop: style.borderTopWidth,
          borderRight: style.borderRightWidth,
          borderBottom: style.borderBottomWidth,
          borderLeft: style.borderLeftWidth,
          background: style.backgroundColor,
          borderRadius: style.borderRadius,
          boxShadow: style.boxShadow,
        };
      })(),
      bodyPaddingLeft: getComputedStyle(document.querySelector('.zxe-body')).paddingLeft,
      bodyPaddingRight: getComputedStyle(document.querySelector('.zxe-body')).paddingRight,
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
    };
  })()`;
}

const desktop = await evaluate(measureExpression());
results.desktop = desktop;

const textLefts = desktop.textRows.map((row) => row.contentLeft);
const allContentLefts = Object.values(desktop.rows)
  .filter((row) => row.type !== 'divider')
  .map((row) => row.contentLeft);
check(
  '普通文本块无边框、透明底、无圆角',
  desktop.textRows.every(
    (row) =>
      row.borderTop === '0px' &&
      row.borderRight === '0px' &&
      row.borderBottom === '0px' &&
      row.borderLeft === '0px' &&
      row.background === 'rgba(0, 0, 0, 0)' &&
      row.borderRadius === '0px',
  ),
  desktop.textRows,
);
check(
  '文本块行容器没有 56px 内缩',
  desktop.textRows.every(
    (row) => row.paddingLeft === '0px' && row.contentPaddingLeft === '0px',
  ),
  desktop.textRows.map((row) => ({
    id: row.id,
    paddingLeft: row.paddingLeft,
    contentPaddingLeft: row.contentPaddingLeft,
  })),
);
check(
  '正文/标题/列表/待办共享左基线（≤0.5px）',
  Math.max(...textLefts) - Math.min(...textLefts) <= 0.5,
  textLefts,
);
check(
  '对象与文件块也落在同一内容列（≤0.5px）',
  Math.max(...allContentLefts) - Math.min(...allContentLefts) <= 0.5,
  allContentLefts,
);
check(
  'gutter 绝对定位、44px、默认 opacity 0 / pointer-events none',
  Object.values(desktop.rows).every(
    (row) =>
      !row.gutter ||
      (row.gutter.position === 'absolute' &&
        row.gutter.width === '44px' &&
        row.gutter.opacity === '0' &&
        row.gutter.pointerEvents === 'none'),
  ),
  Object.values(desktop.rows).map((row) => ({ id: row.id, gutter: row.gutter })),
);
check(
  'gutter 位于内容列之外的页边距，不占正文宽度',
  desktop.rows.p1.gutter.right <= desktop.rows.p1.contentLeft + 0.5 &&
    Math.abs(desktop.rows.p1.contentWidth - desktop.rows.p1.rowWidth) <= 0.5,
  {
    gutter: desktop.rows.p1.gutter,
    contentLeft: desktop.rows.p1.contentLeft,
    contentWidth: desktop.rows.p1.contentWidth,
    rowWidth: desktop.rows.p1.rowWidth,
  },
);
check(
  '对象块外壳无边框/圆角/阴影（ZX6-BLOCK-01）',
  [desktop.code, desktop.table, desktop.formula, desktop.board, desktop.link].every(
    (surface) =>
      surface &&
      surface.borderTop === '0px' &&
      surface.borderRight === '0px' &&
      surface.borderBottom === '0px' &&
      surface.borderLeft === '0px' &&
      surface.borderRadius === '0px' &&
      surface.background === 'rgba(0, 0, 0, 0)' &&
      surface.boxShadow === 'none',
  ),
  {
    code: desktop.code,
    table: desktop.table,
    formula: desktop.formula,
    board: desktop.board,
    link: desktop.link,
  },
);
check(
  '语义边界保留：代码内容面底色、表格网格、引用左侧竖线',
  desktop.codeBody &&
    desktop.codeBody.background !== 'rgba(0, 0, 0, 0)' &&
    desktop.tableCell &&
    desktop.tableCell.borderRight === '1px' &&
    desktop.tableCell.borderBottom === '1px' &&
    desktop.quote &&
    desktop.quote.borderLeft === '3px' &&
    desktop.quote.borderTop === '0px' &&
    desktop.quote.boxShadow === 'none',
  {
    codeBody: desktop.codeBody,
    tableCell: desktop.tableCell,
    quote: desktop.quote,
  },
);
check(
  '文件行保持 34px 紧凑行：无边框、透明底、6px 圆角',
  desktop.fileCard &&
    desktop.fileCard.height <= 36 &&
    desktop.fileCard.borderTop === '0px' &&
    desktop.fileCard.borderRight === '0px' &&
    desktop.fileCard.borderBottom === '0px' &&
    desktop.fileCard.borderLeft === '0px' &&
    desktop.fileCard.background === 'rgba(0, 0, 0, 0)' &&
    desktop.fileCard.borderRadius === '6px',
  desktop.fileCard,
);
check(
  '图片块（文件行）无边框、透明底、无阴影',
  desktop.imageCard &&
    desktop.imageCard.borderTop === '0px' &&
    desktop.imageCard.borderRight === '0px' &&
    desktop.imageCard.borderBottom === '0px' &&
    desktop.imageCard.borderLeft === '0px' &&
    desktop.imageCard.background === 'rgba(0, 0, 0, 0)' &&
    desktop.imageCard.borderRadius === '6px' &&
    desktop.imageCard.boxShadow === 'none',
  desktop.imageCard,
);
check('桌面无横向溢出', desktop.scrollWidth <= desktop.clientWidth, {
  scrollWidth: desktop.scrollWidth,
  clientWidth: desktop.clientWidth,
});
await screenshot('note-flow-desktop.png');

// hover：真实鼠标移到第一段，只出现左侧竖线与 gutter，无整行背景。
const p1Rect = await evaluate(`(() => {
  const row = document.querySelector('.zxe-row[data-block-id="p1"]');
  const rect = row.getBoundingClientRect();
  return { x: rect.left + 80, y: rect.top + rect.height / 2, left: rect.left };
})()`);
await send('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: p1Rect.x,
  y: p1Rect.y,
});
await new Promise((resolve) => setTimeout(resolve, 240));
const hover = await evaluate(`(() => {
  const row = document.querySelector('.zxe-row[data-block-id="p1"]');
  const content = row.querySelector('.zxe-row-content');
  const gutter = row.querySelector('.zxe-block-gutter');
  return {
    background: getComputedStyle(row).backgroundColor,
    contentLeft: Math.round(content.getBoundingClientRect().left * 100) / 100,
    gutterOpacity: getComputedStyle(gutter).opacity,
    gutterPointerEvents: getComputedStyle(gutter).pointerEvents,
    beforeOpacity: getComputedStyle(row, '::before').opacity,
    gutterRight: Math.round(gutter.getBoundingClientRect().right * 100) / 100,
  };
})()`);
results.hover = hover;
check(
  'hover 只显示左侧竖线与 gutter，不铺整行背景',
  hover.background === 'rgba(0, 0, 0, 0)' &&
    Number(hover.beforeOpacity) >= 0.3 &&
    hover.gutterOpacity === '1' &&
    hover.gutterPointerEvents === 'auto',
  hover,
);
check(
  'hover 不改变正文左基线/宽度',
  Math.abs(hover.contentLeft - desktop.rows.p1.contentLeft) <= 0.5,
  { hover: hover.contentLeft, before: desktop.rows.p1.contentLeft },
);
await screenshot('note-flow-hover.png');

// active：点击正文，左侧竖线加深，但不出现整行背景。
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: p1Rect.x,
  y: p1Rect.y,
  button: 'left',
  clickCount: 1,
});
await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: p1Rect.x,
  y: p1Rect.y,
  button: 'left',
  clickCount: 1,
});
await new Promise((resolve) => setTimeout(resolve, 160));
const active = await evaluate(`(() => {
  const row = document.querySelector('.zxe-row[data-block-id="p1"]');
  return {
    active: row.classList.contains('is-active'),
    background: getComputedStyle(row).backgroundColor,
    beforeOpacity: getComputedStyle(row, '::before').opacity,
    contentLeft: Math.round(row.querySelector('.zxe-row-content').getBoundingClientRect().left * 100) / 100,
  };
})()`);
results.active = active;
check(
  'active 块只显示左侧竖线，仍无整行背景',
  active.active === true &&
    active.background === 'rgba(0, 0, 0, 0)' &&
    Number(active.beforeOpacity) === 1,
  active,
);

// 搜索结果：真实 URL find 参数触发块高亮；检查是轻量文本底/竖线而非整行卡片。
await send('Page.navigate', {
  url: `http://127.0.0.1:${PORT}/knowledge?note=${encodeURIComponent(NOTE_ID)}&find=${encodeURIComponent('连续排版')}`,
});
await waitFor(
  () => Boolean(document.querySelector('.zxe-row.is-search-hit')),
  '搜索结果块高亮',
  15_000,
);
const search = await evaluate(`(() => {
  const row = document.querySelector('.zxe-row.is-search-hit');
  const content = row.querySelector('.zxe-row-content');
  return {
    id: row.dataset.blockId,
    rowBackground: getComputedStyle(row).backgroundColor,
    contentBackground: getComputedStyle(content).backgroundColor,
    beforeOpacity: getComputedStyle(row, '::before').opacity,
    beforeColor: getComputedStyle(row, '::before').backgroundColor,
  };
})()`);
results.search = search;
check(
  '搜索命中只给内容层浅色底 + 左侧竖线，不给整行铺背景',
  search.rowBackground === 'rgba(0, 0, 0, 0)' &&
    Number(search.beforeOpacity) === 1 &&
    search.contentBackground !== 'rgba(0, 0, 0, 0)',
  search,
);
await screenshot('note-flow-search.png');

// 等搜索高亮自然褪去，再验证专注/窄窗，避免证据图被 1.4s 命中态干扰。
await new Promise((resolve) => setTimeout(resolve, 1600));
await evaluate(
  () => document.querySelectorAll('.zxe-row.is-search-hit').length === 0,
);

// 专注模式：⌘⇧F 进入，左基线不变，无横向溢出。
await evaluate(
  `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: true, shiftKey: true, bubbles: true }))`,
);
await waitFor(
  () => document.querySelector('.zxe')?.getAttribute('data-focus') === 'true',
  '进入专注模式',
  10_000,
);
await new Promise((resolve) => setTimeout(resolve, 180));
const focus = await evaluate(measureExpression());
results.focus = focus;
const focusLefts = Object.values(focus.rows).map((row) => row.contentLeft);
check(
  '专注模式左基线仍一致',
  Math.max(...focusLefts) - Math.min(...focusLefts) <= 0.5,
  focusLefts,
);
check('专注模式无横向溢出', focus.scrollWidth <= focus.clientWidth, {
  scrollWidth: focus.scrollWidth,
  clientWidth: focus.clientWidth,
});
await screenshot('note-flow-focus.png');
await evaluate(
  `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
);
await waitFor(
  () => document.querySelector('.zxe')?.getAttribute('data-focus') === 'false',
  '退出专注模式',
  10_000,
);

// 1280 / 1024 / 900 三档桌面宽度：对象外壳仍无边框，且不产生横向溢出。
for (const width of [1280, 1024, 900]) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 220));
  const snapshot = await evaluate(measureExpression());
  results.widths.push({
    width,
    scrollWidth: snapshot.scrollWidth,
    clientWidth: snapshot.clientWidth,
    code: snapshot.code,
    table: snapshot.table,
    formula: snapshot.formula,
    link: snapshot.link,
    board: snapshot.board,
  });
  check(
    `${width}px 无横向溢出且对象外壳无边框`,
    snapshot.scrollWidth <= snapshot.clientWidth &&
      [snapshot.code, snapshot.table, snapshot.formula, snapshot.link, snapshot.board].every(
        (surface) =>
          surface &&
          surface.borderTop === '0px' &&
          surface.borderLeft === '0px' &&
          surface.boxShadow === 'none',
      ),
    {
      width,
      scrollWidth: snapshot.scrollWidth,
      clientWidth: snapshot.clientWidth,
      code: snapshot.code,
      formula: snapshot.formula,
    },
  );
  await screenshot(`note-flow-width-${width}.png`);
}

// 390 窄窗：正文左基线一致，gutter 移到右侧且不挤压正文，无横向滚动。
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: false,
});
await new Promise((resolve) => setTimeout(resolve, 220));
const narrow = await evaluate(measureExpression());
results.narrow = narrow;
const narrowTextLefts = narrow.textRows.map((row) => row.contentLeft);
check(
  '390 窄窗无横向溢出',
  narrow.scrollWidth <= narrow.clientWidth &&
    narrow.bodyScrollWidth <= narrow.bodyClientWidth,
  narrow,
);
check(
  '390 窄窗文本块左基线一致',
  Math.max(...narrowTextLefts) - Math.min(...narrowTextLefts) <= 0.5,
  narrowTextLefts,
);
check(
  '390 窄窗 gutter 移到右侧，不占正文宽度',
  narrow.rows.p1.gutter.left >= narrow.rows.p1.contentRight - 0.5 &&
    Math.abs(narrow.rows.p1.contentWidth - narrow.rows.p1.rowWidth) <= 0.5,
  {
    gutter: narrow.rows.p1.gutter,
    contentRight: narrow.rows.p1.contentRight,
    contentWidth: narrow.rows.p1.contentWidth,
    rowWidth: narrow.rows.p1.rowWidth,
  },
);
await screenshot('note-flow-narrow-390.png');

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
