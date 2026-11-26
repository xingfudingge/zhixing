/**
 * ZX-TABLE-01 真实 Tauri WebView 探针：知识表格。
 *
 * 只通过真实产品 IPC 造数据、只派发真实 DOM 事件：
 *   * 表头开关、单元格对齐、列宽拖拽；
 *   * 任意位置插入/删除行列；
 *   * 区域选择、合并/拆分与合并冲突拒绝；
 *   * Tab / Enter 导航与末行追加；
 *   * TSV 复制/粘贴扩行扩列；
 *   * Markdown / HTML 导出；
 *   * 40×16 边界禁用；
 *   * 所有编辑经 300ms 防抖落库，读回真实 SQLite payload / notes.body。
 */
(function () {
  const ERROR_KEY = 'zx-table-01-errors';
  let errors = [];
  try {
    errors = JSON.parse(sessionStorage.getItem(ERROR_KEY) || '[]');
  } catch {
    errors = [];
  }
  const persistErrors = () => {
    try {
      sessionStorage.setItem(ERROR_KEY, JSON.stringify(errors.slice(-80)));
    } catch {
      /* ignore */
    }
  };
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    errors.push(args.map(String).join(' '));
    persistErrors();
    originalError(...args);
  };
  window.addEventListener('error', (event) => {
    errors.push(
      `[window.error] ${event.message} @ ${event.filename}:${event.lineno}`,
    );
    persistErrors();
  });
  window.addEventListener('unhandledrejection', (event) => {
    errors.push(
      `[unhandledrejection] ${
        (event.reason && (event.reason.message || event.reason)) || 'unknown'
      }`,
    );
    persistErrors();
  });

  const NOTE_ID = 'zx-table-01-note';
  const NOTE_TITLE = '表格手测';
  const LIMIT_ID = 'zx-table-01-limit';
  const LIMIT_TITLE = '表格边界';
  const BLOCK_ID = 'zx-table-01-block';
  const LIMIT_BLOCK_ID = 'zx-table-01-limit-block';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function visible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  }

  async function waitFor(check, timeout = 12_000, interval = 60) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await check();
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  function invoke(command, args) {
    const invokeFn =
      window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (typeof invokeFn !== 'function') {
      throw new Error('真实 Tauri IPC 不可用');
    }
    return invokeFn(command, args);
  }

  async function seed() {
    try {
      sessionStorage.removeItem(ERROR_KEY);
    } catch {
      /* ignore */
    }
    errors = [];
    const existing = await invoke('notes_list', {
      query: { includeDeleted: true },
    });
    for (const note of existing) {
      if (!String(note.id).startsWith('zx-table-01-')) {
        await invoke('notes_delete', { id: note.id });
      }
    }
    for (const note of [NOTE_ID, LIMIT_ID]) {
      try {
        await invoke('notes_delete', { id: note });
      } catch {
        /* not created yet */
      }
    }

    const limitRows = Array.from({ length: 40 }, (_, row) =>
      Array.from({ length: 16 }, (_, column) => `${row}-${column}`),
    );

    await invoke('notes_create', {
      input: {
        id: NOTE_ID,
        title: NOTE_TITLE,
        body: '<p>表格手测正文。</p>',
        tags: ['ZX-TABLE-01'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: BLOCK_ID,
        noteId: NOTE_ID,
        blockType: 'table',
        orderKey: 1024,
        payload: {
          header: true,
          rows: [
            ['模块', '状态', '负责人'],
            ['表格', '进行中', '吴瑾'],
            ['导出', '待验收', '吴瑾'],
          ],
        },
      },
    });

    await invoke('notes_create', {
      input: {
        id: LIMIT_ID,
        title: LIMIT_TITLE,
        body: '<p>表格边界。</p>',
        tags: ['ZX-TABLE-01'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: LIMIT_BLOCK_ID,
        noteId: LIMIT_ID,
        blockType: 'table',
        orderKey: 1024,
        payload: { header: true, rows: limitRows },
      },
    });

    return {
      noteId: NOTE_ID,
      title: NOTE_TITLE,
      limitId: LIMIT_ID,
      limitTitle: LIMIT_TITLE,
      notes: 2,
      limitRows: limitRows.length,
      limitColumns: limitRows[0].length,
    };
  }

  async function gotoKnowledge() {
    const nav = await waitFor(
      () =>
        Array.from(
          document.querySelectorAll('a.nav-link, button.nav-link'),
        ).find(
          (el) =>
            visible(el) &&
            (norm(el.getAttribute('aria-label')) === '知识' ||
              norm(el.textContent).includes('知识')),
        ),
      8000,
    );
    if (!nav) throw new Error('找不到「知识」导航入口');
    nav.click();
    const ready = await waitFor(
      () => document.querySelector('.kn-workspace'),
      10_000,
    );
    if (!ready) throw new Error('知识页未加载');
    return true;
  }

  async function openNote(title) {
    const button = await waitFor(
      () =>
        Array.from(
          document.querySelectorAll('[aria-label^="打开笔记："]'),
        ).find(
          (el) =>
            visible(el) &&
            norm(el.getAttribute('aria-label')).includes(title),
        ),
      10_000,
    );
    if (!button) throw new Error(`找不到笔记「${title}」`);
    button.click();
    const titleInput = await waitFor(
      () => {
        const input = document.querySelector('input[aria-label="笔记标题"]');
        return input && input.value === title ? input : null;
      },
      10_000,
    );
    if (!titleInput) throw new Error(`笔记「${title}」标题未就绪`);
    const table = await waitFor(() => tableEl(), 10_000);
    if (!table) throw new Error(`笔记「${title}」表格未渲染`);
    return title;
  }

  function tableEl() {
    return document.querySelector('.zxe-table');
  }

  function inputFor(row, column) {
    return document.querySelector(
      `input[aria-label="第 ${row + 1} 行第 ${column + 1} 列"]`,
    );
  }

  function tdFor(row, column) {
    return inputFor(row, column)?.closest('td,th') ?? null;
  }

  function buttonFor(label) {
    return Array.from(document.querySelectorAll('button')).find(
      (button) =>
        visible(button) &&
        (norm(button.getAttribute('aria-label')) === label ||
          norm(button.textContent) === label),
    );
  }

  function buttonStates() {
    return Array.from(
      document.querySelectorAll('.zxe-table-toolbar button'),
    ).map((button) => ({
      label:
        norm(button.getAttribute('aria-label')) || norm(button.textContent),
      disabled: button.disabled,
      title: norm(button.getAttribute('title')),
      pressed: button.getAttribute('aria-pressed'),
    }));
  }

  function snapshot() {
    const table = tableEl();
    if (!table) {
      return { exists: false };
    }
    const cells = Array.from(table.querySelectorAll('input')).map(
      (input) => ({
        label: norm(input.getAttribute('aria-label')),
        value: input.value,
      }),
    );
    return {
      exists: true,
      headerCount: table.querySelectorAll('th').length,
      rowCount: table.querySelectorAll('tr').length,
      columnCount: table.querySelectorAll('col').length,
      widths: Array.from(table.querySelectorAll('col')).map(
        (col) => col.style.width,
      ),
      html: table.outerHTML,
      cells,
      status: norm(
        document.querySelector('.zxe-table-status')?.textContent,
      ),
      count: norm(document.querySelector('.zxe-table-count')?.textContent),
      emptyHint: norm(
        document.querySelector('.zxe-table-empty')?.textContent,
      ),
      active: document.activeElement?.getAttribute('aria-label') || null,
      toolbar: buttonStates(),
      exportMarkdown: norm(
        document.querySelector('.zxe-table-export-body')?.textContent,
      ),
      hasColgroup: Boolean(table.querySelector('colgroup')),
      hasThead: Boolean(table.querySelector('thead')),
      merged: {
        colspan:
          table.querySelector('[colspan]')?.getAttribute('colspan') ?? null,
        rowspan:
          table.querySelector('[rowspan]')?.getAttribute('rowspan') ?? null,
      },
    };
  }

  async function clickButton(command) {
    const button = buttonFor(command.label);
    if (!button) throw new Error(`找不到按钮「${command.label}」`);
    if (button.disabled) {
      throw new Error(`按钮「${command.label}」被禁用：${button.title}`);
    }
    button.click();
    await sleep(command.wait ?? 260);
    return snapshot();
  }

  async function setCell(command) {
    const input = inputFor(command.row, command.column);
    if (!input) {
      throw new Error(
        `找不到单元格 ${command.row + 1},${command.column + 1}`,
      );
    }
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(input, command.value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(command.wait ?? 160);
    return snapshot();
  }

  async function selectRect(command) {
    const start = tdFor(command.r0, command.c0);
    const end = tdFor(command.r1, command.c1);
    if (!start || !end) throw new Error('选区坐标越界');
    start.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      }),
    );
    await sleep(80);
    start.dispatchEvent(
      new MouseEvent('mouseout', {
        bubbles: true,
        relatedTarget: end,
      }),
    );
    end.dispatchEvent(
      new MouseEvent('mouseover', {
        bubbles: true,
        relatedTarget: start,
      }),
    );
    await sleep(80);
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(140);
    return snapshot();
  }

  async function key(command) {
    const input = inputFor(command.row, command.column);
    if (!input) throw new Error('导航起点不存在');
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: command.key,
        metaKey: Boolean(command.meta),
        ctrlKey: Boolean(command.meta),
        shiftKey: Boolean(command.shift),
      }),
    );
    await sleep(command.wait ?? 180);
    return snapshot();
  }

  async function dragWidth(command) {
    const handle = document.querySelector('.zxe-col-resize');
    if (!handle) throw new Error('找不到列宽手柄');
    handle.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: command.startX ?? 100,
      }),
    );
    window.dispatchEvent(
      new MouseEvent('mousemove', {
        bubbles: true,
        clientX: (command.startX ?? 100) + (command.delta ?? 36),
      }),
    );
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(320);
    return snapshot();
  }

  function clipboardEvent(type, data) {
    const transfer = new DataTransfer();
    if (data) {
      transfer.setData('text/plain', data);
    }
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    return event;
  }

  async function copySelection(command) {
    const input = inputFor(command.row ?? 0, command.column ?? 0);
    if (!input) throw new Error('复制起点不存在');
    const event = clipboardEvent('copy');
    input.dispatchEvent(event);
    await sleep(140);
    return {
      text: event.clipboardData.getData('text/plain'),
      html: event.clipboardData.getData('text/html'),
      snapshot: snapshot(),
    };
  }

  async function pasteTsv(command) {
    const input = inputFor(command.row ?? 0, command.column ?? 0);
    if (!input) throw new Error('粘贴起点不存在');
    input.dispatchEvent(clipboardEvent('paste', command.text));
    await sleep(260);
    return snapshot();
  }

  async function exportTable(command) {
    const label =
      command.mode === 'html' ? '导出 HTML' : '导出 Markdown';
    const button = buttonFor(label);
    if (!button) throw new Error(`找不到「${label}」`);
    button.click();
    const body = await waitFor(
      () => document.querySelector('.zxe-table-export-body'),
      4000,
    );
    if (!body) throw new Error('导出预览未打开');
    await sleep(120);
    return norm(body.textContent);
  }

  async function undoRedo(command) {
    const button = buttonFor(command.action === 'redo' ? '重做编辑' : '撤销编辑');
    if (!button) throw new Error(`找不到${command.action}按钮`);
    button.click();
    await sleep(320);
    return snapshot();
  }

  async function stored() {
    const blocks = await invoke('note_blocks_list', { noteId: NOTE_ID });
    const note = await invoke('notes_get', { id: NOTE_ID });
    const block = blocks.find((item) => item.id === BLOCK_ID);
    return {
      payload: block ? block.payload : null,
      body: note.body,
      blocks: blocks.length,
    };
  }

  const commands = {
    async sleep(command) {
      await sleep(command.ms || 200);
      return true;
    },
    async env() {
      return {
        isTauri: Boolean(window.__TAURI_INTERNALS__),
        bodyText: norm(document.body.innerText).slice(0, 200),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    },
    seed,
    gotoKnowledge,
    async openNote(command) {
      return openNote(command.title || NOTE_TITLE);
    },
    table: snapshot,
    click: clickButton,
    setCell,
    selectRect,
    key,
    dragWidth,
    copySelection,
    pasteTsv,
    export: exportTable,
    undoRedo,
    stored,
    async errors() {
      return errors.slice();
    },
  };

  let busy = false;
  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch('/__next', { cache: 'no-store' });
      if (response.status === 204) return;
      const command = await response.json();
      let result;
      try {
        const handler = commands[command.type];
        if (!handler) throw new Error(`未知命令：${command.type}`);
        result = { ok: true, value: await handler(command) };
      } catch (error) {
        result = {
          ok: false,
          error: (error && (error.message || String(error))) || 'unknown',
        };
      }
      await fetch('/__result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: command.id, result }),
      });
    } finally {
      busy = false;
    }
  }

  async function boot() {
    try {
      await fetch('/__probe-ready', { method: 'POST' });
    } catch {
      /* ignore */
    }
    window.setInterval(poll, 120);
    poll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
