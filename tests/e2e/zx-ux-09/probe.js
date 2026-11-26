/**
 * ZX-UX-09 真实 Tauri WebView 探针。
 *
 * 只通过真实产品 IPC 造数据、只派发真实 DOM 事件：
 * - 在正文输入 10 个字，⌘Z 一次回到输入前，⇧⌘Z 恢复；
 * - 插入表格，⌘Z 移除，⇧⌘Z 恢复；
 * - 撤销/重做按钮位于页脚且不新增工具轨条目；
 * - 等待 300ms 防抖保存后重载 WebView，确认落库为撤销后的状态；
 * - 收集 console.error / window.error / unhandledrejection。
 */
(function () {
  const ERROR_KEY = 'zx-ux-09-errors';
  let errors = [];
  try {
    errors = JSON.parse(sessionStorage.getItem(ERROR_KEY) || '[]');
  } catch {
    errors = [];
  }
  const persistErrors = () => {
    try {
      sessionStorage.setItem(ERROR_KEY, JSON.stringify(errors.slice(-60)));
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

  const NOTE_ID = 'zx-ux-09-note-a';
  const TITLE = 'ZX-UX-09 撤销重做';
  const PHRASE = '这是十个字的输入内容';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function visible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  }

  async function waitFor(check, timeout = 10_000, interval = 60) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = check();
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

  function clickButtonByText(text, root = document) {
    return Array.from(
      root.querySelectorAll('button, [role="menuitem"], [role="option"]'),
    ).find((el) => visible(el) && norm(el.textContent).includes(text));
  }

  async function gotoTab(name, marker) {
    const nav = await waitFor(
      () =>
        Array.from(
          document.querySelectorAll('a.nav-link, button.nav-link'),
        ).find(
          (el) =>
            visible(el) &&
            (norm(el.getAttribute('aria-label')) === name ||
              norm(el.textContent).includes(name)),
        ),
      8000,
    );
    if (!nav) throw new Error(`找不到「${name}」导航入口`);
    nav.click();
    const ready = await waitFor(() => document.querySelector(marker), 10_000);
    if (!ready) throw new Error(`「${name}」页面未加载：${marker}`);
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
    if (!button) {
      const labels = Array.from(
        document.querySelectorAll('[aria-label^="打开笔记："]'),
      ).map((el) => el.getAttribute('aria-label'));
      throw new Error(`找不到笔记「${title}」：${JSON.stringify(labels)}`);
    }
    button.click();
    const titleInput = await waitFor(
      () => {
        const input = document.querySelector('input[aria-label="笔记标题"]');
        return input && input.value === title ? input : null;
      },
      10_000,
    );
    if (!titleInput) throw new Error(`笔记「${title}」标题未就绪`);
    await waitFor(
      () =>
        document.querySelectorAll('.zxe-inline[data-inline-editor="true"]')
          .length > 0,
      10_000,
    );
    return title;
  }

  async function seedNote() {
    try {
      sessionStorage.removeItem(ERROR_KEY);
    } catch {
      /* ignore */
    }
    errors = [];
    const note = await invoke('notes_create', {
      input: {
        id: NOTE_ID,
        title: TITLE,
        body: '<p></p>',
        tags: ['ZX-UX-09'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'zx-ux-09-p1',
        noteId: note.id,
        blockType: 'paragraph',
        orderKey: 1024,
        payload: { runs: [] },
      },
    });
    return { noteId: note.id, title: note.title };
  }

  function currentInline() {
    return Array.from(
      document.querySelectorAll('.zxe-inline[data-inline-editor="true"]'),
    ).find((el) => visible(el));
  }

  function historyState() {
    const undo = document.querySelector('button[aria-label="撤销编辑"]');
    const redo = document.querySelector('button[aria-label="重做编辑"]');
    return {
      undoFound: Boolean(undo),
      redoFound: Boolean(redo),
      undoCount: document.querySelectorAll('button[aria-label="撤销编辑"]')
        .length,
      redoCount: document.querySelectorAll('button[aria-label="重做编辑"]')
        .length,
      undoDisabled: undo ? Boolean(undo.disabled) : null,
      redoDisabled: redo ? Boolean(redo.disabled) : null,
      undoTitle: undo ? undo.getAttribute('title') : null,
      redoTitle: redo ? redo.getAttribute('title') : null,
    };
  }

  function railState() {
    const rail = document.querySelector('nav.kn-rail');
    if (!rail) {
      return { found: false, items: 0, toggle: false };
    }
    const buttons = Array.from(rail.querySelectorAll('button'));
    return {
      found: true,
      items: buttons.filter(
        (button) => !button.classList.contains('kn-rail-toggle'),
      ).length,
      toggle: Boolean(rail.querySelector('.kn-rail-toggle')),
    };
  }

  function setCaretEnd(element) {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function insertChar(element, char) {
    setCaretEnd(element);
    let inserted = false;
    try {
      inserted = Boolean(
        document.execCommand &&
          document.execCommand('insertText', false, char),
      );
    } catch {
      inserted = false;
    }
    if (!inserted) {
      element.textContent = `${element.textContent || ''}${char}`;
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: char,
        }),
      );
    }
  }

  function pressKey(target, options) {
    const event = new KeyboardEvent('keydown', {
      key: options.key,
      metaKey: Boolean(options.metaKey),
      ctrlKey: Boolean(options.ctrlKey),
      shiftKey: Boolean(options.shiftKey),
      altKey: Boolean(options.altKey),
      bubbles: true,
      cancelable: true,
    });
    const notPrevented = target.dispatchEvent(event);
    return { notPrevented, defaultPrevented: event.defaultPrevented };
  }

  function saveLabel() {
    return norm(
      document.querySelector('.kn-save-state')?.textContent || '',
    );
  }

  function tableSnapshot() {
    const table = document.querySelector('table.zxe-table');
    if (!table) {
      return { hasTable: false, rows: 0, cells: 0 };
    }
    return {
      hasTable: true,
      rows: table.querySelectorAll('tr').length,
      cells: table.querySelectorAll('input.zxe-table-cell').length,
    };
  }

  function snapshot() {
    const inline = currentInline();
    return {
      text: inline ? norm(inline.textContent) : null,
      phrasePresent: norm(document.body.textContent).includes(PHRASE),
      table: tableSnapshot(),
      history: historyState(),
      rail: railState(),
      saveLabel: saveLabel(),
      blockCount: document.querySelectorAll('[data-block-id]').length,
      bodyText: norm(document.body.textContent).slice(0, 500),
    };
  }

  async function typeTenAndUndoRedo() {
    const inline = await waitFor(currentInline, 8000);
    if (!inline) throw new Error('找不到正文可编辑块');
    setCaretEnd(inline);
    const typedChars = [];
    for (const char of PHRASE) {
      insertChar(inline, char);
      typedChars.push(char);
      // 保持 10 次输入落在 400ms 合并窗口内。
      await sleep(0);
    }
    const typed = await waitFor(
      () => {
        const text = norm(currentInline()?.textContent || '');
        return text.includes(PHRASE) ? text : null;
      },
      5000,
    );
    if (!typed) {
      throw new Error(
        `输入 10 个字后正文不正确：${norm(currentInline()?.textContent)}`,
      );
    }
    const afterType = snapshot();

    const undoPress = pressKey(currentInline(), { key: 'z', metaKey: true });
    const undone = await waitFor(
      () => norm(currentInline()?.textContent || '') === '',
      5000,
    );
    if (!undone) {
      throw new Error(
        `⌘Z 没有回到输入前：${norm(currentInline()?.textContent)}`,
      );
    }
    const afterUndo = snapshot();

    const redoPress = pressKey(currentInline(), {
      key: 'z',
      metaKey: true,
      shiftKey: true,
    });
    const redone = await waitFor(
      () => norm(currentInline()?.textContent || '').includes(PHRASE),
      5000,
    );
    if (!redone) {
      throw new Error('⇧⌘Z 没有恢复输入内容');
    }
    const afterRedo = snapshot();

    // 最终保留“输入已撤销”的状态，与随后插入表格的撤销/重做组合验证。
    pressKey(currentInline(), { key: 'z', metaKey: true });
    await waitFor(
      () => norm(currentInline()?.textContent || '') === '',
      5000,
    );

    return {
      typed,
      typedLength: typed.length,
      afterType,
      undoNotPrevented: undoPress.notPrevented,
      afterUndo,
      redoNotPrevented: redoPress.notPrevented,
      afterRedo,
      finalText: norm(currentInline()?.textContent || ''),
    };
  }

  async function insertTableUndoRedo() {    const control = await waitFor(
      () =>
        Array.from(document.querySelectorAll('.zxe-block-control')).find(
          (button) =>
            visible(button) &&
            (button.getAttribute('aria-label') === '插入内容' ||
              button.getAttribute('aria-label') === '块操作'),
        ),
      6000,
    );
    if (!control) throw new Error('找不到块插入按钮');
    control.click();
    const menu = await waitFor(
      () =>
        document.querySelector('[role="menu"][aria-label="插入块"]'),
      5000,
    );
    if (!menu) throw new Error('块菜单没有打开');
    const item = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
      (el) => norm(el.textContent).includes('表格'),
    );
    if (!item) throw new Error('块菜单缺少表格');
    item.click();
    const table = await waitFor(
      () => document.querySelector('table.zxe-table'),
      5000,
    );
    if (!table) throw new Error('插入表格失败');
    const inserted = snapshot();

    const cell = table.querySelector('input.zxe-table-cell');
    if (!cell) throw new Error('表格没有可编辑单元格');
    cell.focus();
    const undoPress = pressKey(cell, { key: 'z', metaKey: true });
    const removed = await waitFor(
      () => !document.querySelector('table.zxe-table'),
      5000,
    );
    if (!removed) throw new Error('⌘Z 没有移除表格');
    const afterUndo = snapshot();

    const target = currentInline() || document.activeElement;
    if (!target) throw new Error('撤销后没有可聚焦的正文块');
    const redoPress = pressKey(target, {
      key: 'z',
      metaKey: true,
      shiftKey: true,
    });
    const restored = await waitFor(
      () => document.querySelector('table.zxe-table'),
      5000,
    );
    if (!restored) throw new Error('⇧⌘Z 没有恢复表格');
    const afterRedo = snapshot();

    return {
      inserted,
      undoNotPrevented: undoPress.notPrevented,
      removed: Boolean(removed),
      afterUndo,
      redoNotPrevented: redoPress.notPrevented,
      restored: Boolean(restored),
      afterRedo,
    };
  }

  async function waitSave(timeout = 8000) {
    // 先等块编辑器的 300ms 防抖落库，再等知识页兼容 HTML 的 650ms 保存。
    await sleep(120);
    const editorLabel = await waitFor(
      () => {
        const text = norm(
          document.querySelector('.zxe-save-state')?.textContent || '',
        );
        return text.includes('已保存到本机') ? text : null;
      },
      timeout,
    );
    if (!editorLabel) {
      throw new Error(
        `块保存未完成：${norm(
          document.querySelector('.zxe-save-state')?.textContent || '',
        )}`,
      );
    }
    const label = await waitFor(
      () => {
        const text = saveLabel();
        return text.includes('已保存到本机') ? text : null;
      },
      timeout,
    );
    if (!label) {
      throw new Error(`等待保存超时：${saveLabel()}`);
    }
    return { editorLabel, saveLabel: label };
  }

  async function execute(command) {
    switch (command.type) {
      case 'env':
        return {
          isTauri: Boolean(window.__TAURI_INTERNALS__),
          dataTheme: document.documentElement.getAttribute('data-theme'),
          bodyText: norm(document.body.textContent).slice(0, 200),
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
        };
      case 'clickText': {
        const target = await waitFor(
          () => clickButtonByText(command.text),
          command.timeout ?? 6000,
        );
        if (!target) throw new Error(`找不到按钮：${command.text}`);
        target.click();
        await sleep(400);
        return { clicked: command.text };
      }
      case 'sleep':
        await sleep(command.ms ?? 300);
        return true;
      case 'seedNote':
        return seedNote();
      case 'gotoKnowledge':
        return gotoTab('知识', '.kn-list');
      case 'openNote':
        return openNote(command.title || TITLE);
      case 'typeTenAndUndoRedo':
        return typeTenAndUndoRedo();
      case 'insertTableUndoRedo':
        return insertTableUndoRedo();
      case 'snapshot':
        return snapshot();
      case 'waitSave':
        return waitSave(command.timeout);
      case 'reload':
        setTimeout(() => window.location.reload(), 120);
        return { reloading: true };
      case 'errors':
        return errors.slice(-40);
      default:
        throw new Error(`未知命令：${command.type}`);
    }
  }

  async function post(path, payload) {
    await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  async function boot() {
    try {
      await post('/__probe-ready', {});
    } catch {
      /* server may not be ready yet; retry below */
    }
    for (;;) {
      let command = null;
      try {
        const response = await fetch('/__next', { cache: 'no-store' });
        if (response.status === 200) {
          command = await response.json();
        }
      } catch {
        /* keep polling */
      }
      if (!command) {
        await sleep(120);
        continue;
      }
      let result;
      try {
        result = { ok: true, value: await execute(command) };
      } catch (error) {
        result = {
          ok: false,
          error: String((error && error.stack) || error),
        };
      }
      try {
        await post('/__result', {
          id: command.id,
          result,
          errors: errors.slice(-40),
        });
      } catch {
        /* ignore */
      }
    }
  }

  boot();
})();
