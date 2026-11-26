/**
 * ZX13-FULL-QA-02 笔记待办独立桌面探针（真实 Tauri 2 + WKWebView + SQLite）。
 *
 * 只使用真实产品 IPC 与真实 DOM 事件；不替换 IPC、不注入假数据源。
 * 覆盖：未启用加密的 create/update/勾选/删除/刷新/重启；
 *       启用加密后的密文写入、锁定读取、解锁、关闭加密、重启；
 *       备份导出原始行与恢复。
 */
(function () {
  const errors = [];
  const pageExceptions = [];
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    errors.push(args.map(String).join(' '));
    originalError(...args);
  };
  window.addEventListener('error', (event) => {
    pageExceptions.push(
      `[window.error] ${event.message} @ ${event.filename}:${event.lineno}`,
    );
  });
  window.addEventListener('unhandledrejection', (event) => {
    pageExceptions.push(
      `[unhandledrejection] ${
        (event.reason && (event.reason.message || event.reason)) || 'unknown'
      }`,
    );
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  };
  const invoke = (command, args) => {
    const fn = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (typeof fn !== 'function') throw new Error('真实 Tauri IPC 不可用');
    return fn(command, args);
  };
  const errText = (reason) =>
    reason && typeof reason === 'object'
      ? (() => {
          try {
            return JSON.stringify(reason);
          } catch {
            return String(reason);
          }
        })()
      : String(reason);

  async function waitFor(check, timeout = 12_000, label = 'condition') {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await check();
        if (last) return last;
      } catch {
        /* retry */
      }
      await sleep(80);
    }
    throw new Error(`等待超时：${label}（最后值：${JSON.stringify(last)}）`);
  }

  function findButton(text, root = document, exact = false) {
    return Array.from(
      (root || document).querySelectorAll(
        'button, a, [role="menuitem"], [role="button"], [role="option"]',
      ),
    ).find((el) => {
      if (!visible(el)) return false;
      const label = norm(el.textContent);
      const aria = norm(el.getAttribute('aria-label'));
      return exact
        ? label === text || aria === text
        : label.includes(text) || aria.includes(text);
    });
  }

  async function goto(url, marker = null) {
    history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await sleep(250);
    if (marker) {
      await waitFor(
        () =>
          document.querySelector(marker) ||
          norm(document.body.innerText).includes(marker),
        15_000,
        `页面 ${url}`,
      );
    }
    return { url: location.pathname + location.search };
  }

  async function openNote(title) {
    await goto('/knowledge', '.kn-list');
    const button = await waitFor(
      () =>
        Array.from(document.querySelectorAll('[aria-label^="打开笔记："]')).find(
          (el) =>
            visible(el) && norm(el.getAttribute('aria-label')).includes(title),
        ),
      10_000,
      `打开笔记 ${title}`,
    );
    button.click();
    await waitFor(
      () =>
        document.querySelector('.zxe-block') ||
        norm(document.body.innerText).includes(title),
      10_000,
      `笔记正文 ${title}`,
    );
    await sleep(400);
    return title;
  }

  function summary() {
    const section = document.querySelector('[aria-label="本篇待办"]');
    if (!section) {
      return { present: false, count: 0, done: 0, rows: [], text: '' };
    }
    const rows = Array.from(
      section.querySelectorAll('[data-note-todo-id]'),
    ).map((row) => ({
      id: row.getAttribute('data-note-todo-id'),
      title: norm(row.querySelector('.zxt-summary-title')?.textContent),
      checked:
        row.querySelector('button[role="checkbox"]')?.getAttribute(
          'aria-checked',
        ) === 'true',
      checkboxLabel: norm(
        row.querySelector('button[role="checkbox"]')?.getAttribute('aria-label'),
      ),
      deleteLabel: norm(
        row.querySelector('.zxt-summary-delete')?.getAttribute('aria-label'),
      ),
    }));
    return {
      present: true,
      count: rows.length,
      done: rows.filter((row) => row.checked).length,
      rows,
      text: norm(section.textContent).slice(0, 300),
    };
  }

  async function listTodos(noteId, includeDeleted = false) {
    return invoke('note_todos_list', {
      noteId,
      includeDeleted,
    });
  }

  async function createTodo(input) {
    return invoke('note_todos_create', { input });
  }

  async function updateTodo(id, patch) {
    return invoke('note_todos_update', {
      id,
      input: {
        taskId: null,
        title: patch.title,
        done: Boolean(patch.done),
        dueDate: patch.dueDate ?? null,
        reminderEnabled: false,
        sortOrder: patch.sortOrder ?? 1,
      },
    });
  }

  async function removeTodo(id) {
    return invoke('note_todos_delete', { id });
  }

  async function seedNote() {
    const existing = await invoke('notes_list', { query: {} }).catch(
      () => [],
    );
    const found = existing.find((note) => note.id === 'qa02-note');
    if (found) return { id: found.id, reused: true };
    const note = await invoke('notes_create', {
      input: {
        id: 'qa02-note',
        title: 'QA02 笔记待办独立验收',
        body: '<p></p>',
        tags: ['QA02'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'qa02-block-1',
        noteId: note.id,
        blockType: 'paragraph',
        orderKey: 1024,
        payload: { runs: [{ text: 'QA02 笔记待办独立验收正文。' }] },
      },
    });
    return { id: note.id, reused: false };
  }

  async function createViaBlockMenu() {
    await openNote('QA02 笔记待办独立验收');
    const control = await waitFor(
      () =>
        Array.from(document.querySelectorAll('.zxe-block-control')).find(
          (button) => visible(button),
        ),
      10_000,
      '块插入按钮',
    );
    control.click();
    const menu = await waitFor(
      () => document.querySelector('[role="menu"][aria-label="插入块"]'),
      6_000,
      '插入块菜单',
    );
    const item = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
      (el) => norm(el.textContent).includes('待办'),
    );
    if (!item) throw new Error('插入块菜单缺少待办');
    const errorBefore = errors.length;
    item.click();
    const section = await waitFor(
      () => document.querySelector('[aria-label="本篇待办"]'),
      10_000,
      '本篇待办汇总',
    );
    await sleep(800);
    const rows = await listTodos('qa02-note', false);
    return {
      summary: summary(),
      todos: rows,
      uiErrors: errors.slice(errorBefore),
      alertText: norm(
        document.querySelector('[role="alert"]')?.textContent || '',
      ),
      sectionText: norm(section.textContent).slice(0, 200),
    };
  }


  async function editTodoInline(oldTitle, newTitle) {
    await openNote('QA02 笔记待办独立验收');
    const row = await waitFor(
      () =>
        Array.from(
          document.querySelectorAll('.zxe-body [data-block-id]'),
        ).find((item) => item.getAttribute('data-block-type') === 'todo'),
      10_000,
      `定位正文待办 ${oldTitle}`,
    );
    const inline = row.querySelector('.zxe-todo-text');
    if (!inline) throw new Error('正文待办不可编辑');
    inline.focus();
    const range = document.createRange();
    range.selectNodeContents(inline);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    let inserted = false;
    try {
      inserted = Boolean(
        document.execCommand &&
          document.execCommand('insertText', false, newTitle),
      );
    } catch {
      inserted = false;
    }
    if (!inserted) {
      inline.textContent = newTitle;
      inline.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: newTitle,
        }),
      );
    }
    await waitFor(
      async () => {
        const rows = await listTodos('qa02-note', false);
        return rows.some((item) => item.title === newTitle) ? true : null;
      },
      12_000,
      '正文待办标题落库',
    );
    await sleep(500);
    return {
      summary: summary(),
      todos: await listTodos('qa02-note', false),
      saveLabel: norm(
        document.querySelector('.kn-save-state, .zxe-save-state')?.textContent ||
          '',
      ),
      alertText: norm(
        document.querySelector('[role="alert"]')?.textContent || '',
      ),
      inlineText: norm(inline.textContent),
    };
  }

  async function toggleViaSummary(label) {
    const button = await waitFor(
      () =>
        Array.from(
          document.querySelectorAll(
            '[aria-label="本篇待办"] button[role="checkbox"]',
          ),
        ).find((el) => norm(el.getAttribute('aria-label')) === label),
      8_000,
      `待办勾选 ${label}`,
    );
    const before = summary();
    button.click();
    await waitFor(
      async () => {
        const rows = await listTodos('qa02-note', false);
        const target = rows.find((row) => row.title.includes('QA02 待办A'));
        return target && target.done === true ? true : null;
      },
      10_000,
      '勾选落库',
    );
    await sleep(500);
    return { before, after: summary() };
  }

  async function deleteViaSummary(label) {
    const button = await waitFor(
      () =>
        Array.from(
          document.querySelectorAll(
            '[aria-label="本篇待办"] .zxt-summary-delete',
          ),
        ).find((el) => norm(el.getAttribute('aria-label')) === label),
      8_000,
      `删除待办 ${label}`,
    );
    button.click();
    await sleep(600);
    const rows = await listTodos('qa02-note', true);
    return {
      summary: summary(),
      allRows: rows,
      notice: norm(
        document.querySelector('.zxt-notice')?.textContent || '',
      ),
    };
  }

  async function reopenSnapshot() {
    await openNote('QA02 笔记待办独立验收');
    return {
      summary: summary(),
      todos: await listTodos('qa02-note', false),
      alertText: norm(
        document.querySelector('[role="alert"]')?.textContent || '',
      ),
    };
  }

  async function encryptionStatus() {
    return invoke('note_encryption_status', {});
  }

  async function exportRows() {
    return invoke('note_todos_export_rows', {});
  }

  async function restartSnapshot() {
    const status = await encryptionStatus();
    const rows = await listTodos('qa02-note', false);
    return {
      status,
      rows,
      summary: summary(),
      route: location.pathname + location.search,
      bodyText: norm(document.body.innerText).slice(0, 500),
    };
  }

  async function execute(command) {
    switch (command.type) {
      case 'env':
        return {
          isTauri: Boolean(window.__TAURI_INTERNALS__),
          route: location.pathname + location.search,
          bodyText: norm(document.body.innerText).slice(0, 500),
          theme: document.documentElement.getAttribute('data-theme'),
        };
      case 'clickText': {
        const target = await waitFor(
          () => findButton(command.text),
          command.timeout ?? 8000,
          `按钮 ${command.text}`,
        );
        target.click();
        await sleep(command.pause ?? 500);
        return { clicked: command.text };
      }
      case 'sleep':
        await sleep(command.ms ?? 300);
        return true;
      case 'seedNote':
        return seedNote();
      case 'openNote':
        return { title: await openNote(command.title) };
      case 'createViaBlockMenu':
        return createViaBlockMenu();
      case 'listTodos':
        return listTodos(command.noteId || 'qa02-note', Boolean(command.includeDeleted));
      case 'createTodo':
        return createTodo(command.input);
      case 'updateTodo':
        return updateTodo(command.todoId, command.patch);
      case 'deleteTodo':
        return removeTodo(command.todoId);
      case 'editTodoInline':
        return editTodoInline(command.oldTitle, command.newTitle);
      case 'toggleViaSummary':
        return toggleViaSummary(command.label);
      case 'deleteViaSummary':
        return deleteViaSummary(command.label);
      case 'reopenSnapshot':
        return reopenSnapshot();
      case 'encryptionEnable':
        return invoke('note_encryption_enable', {
          passphrase: command.passphrase,
        });
      case 'encryptionLock':
        return invoke('note_encryption_lock', {});
      case 'encryptionUnlock':
        return invoke('note_encryption_unlock', {
          passphrase: command.passphrase,
        });
      case 'encryptionDisable':
        return invoke('note_encryption_disable', {
          passphrase: command.passphrase ?? null,
        });
      case 'encryptionStatus':
        return encryptionStatus();
      case 'exportRows':
        return exportRows();
      case 'restartSnapshot':
        return restartSnapshot();
      case 'errors':
        return {
          errors: errors.slice(-80),
          pageExceptions: pageExceptions.slice(-20),
        };
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
      /* retry below */
    }
    for (;;) {
      let command = null;
      try {
        const response = await fetch('/__next', { cache: 'no-store' });
        if (response.status === 200) command = await response.json();
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
          error: `${
            error && error.message ? `${error.message} | ` : ''
          }${String((error && error.stack) || error)}`,
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
