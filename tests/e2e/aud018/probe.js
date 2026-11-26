/**
 * AUD-018 桌面实测探针（运行在真实 Tauri WebView 内）。
 *
 * 只读观察 + 真实 DOM 事件；不修改产品代码、不替换产品 IPC。
 * 由 tests/e2e/aud018-desktop.mjs 通过 HTTP 命令队列驱动。
 */
(function () {
  const errors = [];
  const warns = [];

  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);
  console.error = (...args) => {
    errors.push(args.map(String).join(' '));
    originalError(...args);
  };
  console.warn = (...args) => {
    warns.push(args.map(String).join(' '));
    originalWarn(...args);
  };
  window.addEventListener('error', (event) => {
    errors.push(`[window.error] ${event.message} @ ${event.filename}:${event.lineno}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    errors.push(
      `[unhandledrejection] ${(event.reason && (event.reason.message || event.reason)) || 'unknown'}`,
    );
  });

  // Tauri 在 WebView 里把 __TAURI_INTERNALS__.invoke 定义成不可写/不可配置属性，
  // 因此探针**不**包 invoke（也不该包）。落盘事实由 Node 侧轮询真实导出目录确认，
  // 这里只记录页面可观察到的面板提示与导出按钮状态。
  let wrapped = false;

  const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  };
  const describe = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      cls: typeof el.className === 'string' ? el.className : '',
      text: norm(el.textContent).slice(0, 120),
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      visible: visible(el),
    };
  };

  function findButton(label, scope) {
    const root = scope ? document.querySelector(scope) : document;
    if (!root) return null;
    const nodes = Array.from(root.querySelectorAll('button, a, [role="button"]'));
    return (
      nodes.find((el) => norm(el.textContent) === label) ||
      nodes.find((el) => norm(el.getAttribute('aria-label')) === label) ||
      nodes.find((el) => norm(el.textContent).includes(label))
    );
  }

  async function waitFor(check, timeout = 20000, interval = 120) {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
      last = check();
      if (last) return last;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return null;
  }

  function dialogSummary() {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return null;
    const tiles = Array.from(dialog.querySelectorAll('.backup-summary-tile')).map((tile) => ({
      label: norm(tile.querySelector('span')?.textContent),
      value: Number(norm(tile.querySelector('b')?.textContent)),
    }));
    const inline = norm(dialog.querySelector('.backup-inline-note')?.textContent);
    const success = norm(dialog.querySelector('.backup-success')?.textContent);
    const errorText = norm(dialog.querySelector('.settings-banner.is-error')?.textContent);
    const conflicts = Array.from(dialog.querySelectorAll('.backup-conflict')).map((fieldset) => ({
      label: norm(fieldset.querySelector('.backup-conflict-label')?.textContent),
      meta: norm(fieldset.querySelector('.backup-conflict-meta')?.textContent),
      local: norm(fieldset.querySelectorAll('.backup-compare-detail')[0]?.textContent),
      backup: norm(fieldset.querySelectorAll('.backup-compare-detail')[1]?.textContent),
      choices: Array.from(fieldset.querySelectorAll('input[type="radio"]')).map((input) => ({
        value: input.value,
        label: norm(input.parentElement?.textContent),
        checked: input.checked,
        disabled: input.disabled,
      })),
    }));
    const blocked = Array.from(dialog.querySelectorAll('.backup-issue-list li.is-blocked')).map(
      (li) => norm(li.textContent),
    );
    const steps = dialog.querySelectorAll('.backup-operation-list li').length;
    const progress = norm(dialog.querySelector('.backup-progress span')?.textContent);
    return {
      title: norm(dialog.getAttribute('aria-label') || dialog.querySelector('h2')?.textContent),
      tiles,
      inline,
      success,
      error: errorText,
      conflicts,
      blocked,
      steps,
      progress,
      buttons: Array.from(dialog.querySelectorAll('button')).map((b) => ({
        text: norm(b.textContent),
        disabled: b.disabled,
      })),
    };
  }

  function panelState() {
    const body = document.querySelector('.settings-body');
    return {
      route: location.pathname,
      panelText: norm(body ? body.innerText : '').slice(0, 4000),
      notice: norm(document.querySelector('.settings-banner[role="status"] span')?.textContent),
      banner: norm(document.querySelector('.settings-banner[role="status"]')?.textContent),
      error: norm(document.querySelector('.settings-error')?.textContent),
      lastExport: norm(document.querySelector('.settings-subhead span')?.textContent),
      // ZIP 入口在「备份与恢复」行，JSON/Markdown/CSV/PDF 在「单向导出」组；
      // 偏好备份的「导出 JSON」不属于完整备份入口，不能算进这 5 个按钮。
      exportButtons: [
        ...Array.from(document.querySelectorAll('.backup-actions button')),
        ...Array.from(document.querySelectorAll('.settings-body button')).filter((b) =>
          norm(b.textContent).startsWith('导出 ZIP'),
        ),
      ].map((b) => ({
        text: norm(b.textContent),
        disabled: b.disabled,
      })),
      warnings: Array.from(document.querySelectorAll('.backup-last-warnings li')).map((li) =>
        norm(li.textContent),
      ),
      resetVisible: Boolean(findButton('重置全部数据')),
    };
  }

  async function clickLabel(label, scope) {
    const button = await waitFor(() => {
      const found = findButton(label, scope);
      return found && visible(found) ? found : null;
    }, 15000);
    if (!button) throw new Error(`找不到可点击控件：${label}`);
    button.scrollIntoView({ block: 'center' });
    button.click();
    return describe(button);
  }

  /**
   * 选择完整备份文件。必须按 aria-label 定位：设置页里「偏好备份」与
   * 「完整数据备份」两个 <input type=file> 共用 `.settings-file-input` 类，
   * 按类选择会选到偏好备份输入框。
   */
  async function setRestoreFile(url, fileName) {
    return setInputFiles('input[aria-label="选择完整备份文件"]', url, fileName);
  }

  async function setInputFiles(selector, url, fileName) {
    const input = document.querySelector(selector);
    if (!input) throw new Error(`找不到文件输入：${selector}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取备份文件失败：${response.status}`);
    const buffer = await response.arrayBuffer();
    const file = new File([buffer], fileName, { type: 'application/zip' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { bytes: buffer.byteLength, fileName };
  }

  async function chooseConflict(label, choiceLabel) {
    const fieldsets = Array.from(document.querySelectorAll('.backup-conflict'));
    const fieldset = fieldsets.find((item) => norm(item.getAttribute('aria-label')) === label);
    if (!fieldset) throw new Error(`找不到冲突项：${label}`);
    const input = Array.from(fieldset.querySelectorAll('label')).find(
      (l) => norm(l.textContent) === choiceLabel,
    )?.querySelector('input');
    if (!input) throw new Error(`冲突项 ${label} 没有选项：${choiceLabel}`);
    if (input.disabled) return { clicked: false, disabled: true, value: input.value };
    input.click();
    return { clicked: true, disabled: false, value: input.value, checked: input.checked };
  }

  async function setOverwrite(enabled) {
    const label = Array.from(document.querySelectorAll('.backup-overwrite-toggle')).find((el) =>
      norm(el.textContent).includes('允许覆盖本机同 ID 对象'),
    );
    if (!label) throw new Error('找不到覆盖开关');
    const input = label.querySelector('input');
    if (input.checked !== enabled) input.click();
    return { checked: input.checked, disabled: input.disabled };
  }

  async function invoke(command, args) {
    return window.__TAURI_INTERNALS__.invoke(command, args);
  }

  async function putAttachmentBlob(sha, base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const blob = new Blob([bytes], { type: 'text/plain' });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('zhixing-attachments', 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('blobs')) database.createObjectStore('blobs');
        if (!database.objectStoreNames.contains('attachment_state')) {
          database.createObjectStore('attachment_state', { keyPath: 'attachmentId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put(blob, `attachments/${sha}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { key: `attachments/${sha}`, size: blob.size };
  }

  async function blobStat(sha) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('zhixing-attachments', 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('blobs')) database.createObjectStore('blobs');
        if (!database.objectStoreNames.contains('attachment_state')) {
          database.createObjectStore('attachment_state', { keyPath: 'attachmentId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', 'readonly');
      const req = tx.objectStore('blobs').get(`attachments/${sha}`);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return value ? { size: value.size, type: value.type } : null;
  }

  /**
   * 清空附件 IndexedDB。macOS WKWebView 的 WebKit 数据目录不随 HOME 隔离，
   * 三个临时实例会共享 blobs store；恢复前必须清空，才能证明是恢复链路
   * 自己写入了附件二进制，而不是读到了前一个实例的缓存。
   */
  async function clearAttachmentStore() {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('zhixing-attachments', 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('blobs')) database.createObjectStore('blobs');
        if (!database.objectStoreNames.contains('attachment_state')) {
          database.createObjectStore('attachment_state', { keyPath: 'attachmentId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['blobs', 'attachment_state'], 'readwrite');
      tx.objectStore('blobs').clear();
      tx.objectStore('attachment_state').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  }

  /** 通过真实 IPC 收集全部业务行（含回收站），供 Node 侧独立计算哈希。 */
  async function collectAll() {
    const call = (command, args) => invoke(command, args);
    const [lists, tasks, notes, events, countdowns, habits, focusSessions, reviewSnapshots, attachments, settings, boards] =
      await Promise.all([
        call('lists_list', { includeDeleted: true }),
        call('tasks_list', { query: { includeDeleted: true } }),
        call('notes_list', { query: { includeDeleted: true } }),
        call('events_list', { query: { includeDeleted: true } }),
        call('countdowns_list', { query: { includeDeleted: true } }),
        call('habits_list', { query: { includeDeleted: true, includeArchived: true } }),
        call('focus_sessions_list', { query: { includeDeleted: true } }),
        call('review_snapshots_list', { query: { includeDeleted: true } }),
        call('attachments_list', { query: { includeDeleted: true } }),
        call('settings_list', { query: { includeDeleted: true } }),
        call('boards_list', { query: { includeDeleted: true } }),
      ]);
    const subtasks = [];
    for (const task of tasks) {
      subtasks.push(...(await call('subtasks_list', { taskId: task.id, includeDeleted: true })));
    }
    const noteBlocks = [];
    const noteTodos = [];
    for (const note of notes) {
      noteBlocks.push(...(await call('note_blocks_list', { noteId: note.id, includeDeleted: true })));
      noteTodos.push(...(await call('note_todos_list', { noteId: note.id, includeDeleted: true })));
    }
    const habitLogs = [];
    for (const habit of habits) {
      habitLogs.push(
        ...(await call('habit_logs_list', { habitId: habit.id, query: { includeDeleted: true } })),
      );
    }
    const boardBundles = [];
    for (const board of boards) {
      boardBundles.push({
        board,
        nodes: await call('board_nodes_list', { boardId: board.id, includeDeleted: true }),
        edges: await call('board_edges_list', { boardId: board.id, includeDeleted: true }),
      });
    }
    return {
      lists,
      tasks,
      subtasks,
      notes,
      noteBlocks,
      noteTodos,
      events,
      countdowns,
      habits,
      habitLogs,
      focusSessions,
      reviewSnapshots,
      boards: boardBundles,
      attachments,
      settings,
    };
  }

  const api = {
    async evalExpr(expression) {
      // 仅供验收排查：在页面上下文里求值（默认不开；命令队列只由本脚本下发）。
      // eslint-disable-next-line no-new-func
      return new Function(`return (${expression});`)();
    },
    async debug() {
      const descriptor = Object.getOwnPropertyDescriptor(window.__TAURI_INTERNALS__ ?? {}, 'invoke');
      return {
        hasInternals: Boolean(window.__TAURI_INTERNALS__),
        invoke: {
          writable: descriptor?.writable ?? null,
          configurable: descriptor?.configurable ?? null,
          type: typeof window.__TAURI_INTERNALS__?.invoke,
        },
      };
    },
    async collect() {
      return collectAll();
    },
    /** 恢复预览里的「恢复外观偏好」勾选。 */
    async setAppearance(enabled) {
      const input = document.querySelector('.backup-appearance input[type="checkbox"]');
      if (!input) throw new Error('找不到外观偏好复选框');
      if (input.disabled) return { disabled: true, checked: input.checked };
      if (input.checked !== enabled) input.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { disabled: false, checked: input.checked };
    },
    /** 恢复预览里列出的操作步骤（用于确认是否有业务写入）。 */
    async operationSteps() {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;
      return Array.from(dialog.querySelectorAll('.backup-operation-list li')).map((li) =>
        norm(li.textContent),
      );
    },
    /** 等首屏渲染（激活页或主界面）出现正文，避免在空白 DOM 上误判。 */
    async waitAppReady(timeout = 60000) {
      const found = await waitFor(
        () => (norm(document.body.innerText).length > 20 ? norm(document.body.innerText) : null),
        timeout,
      );
      return { ready: Boolean(found), text: (found ?? '').slice(0, 160), route: location.pathname };
    },
    async state() {
      return {
        route: location.pathname,
        body: norm(document.body.innerText).slice(0, 1500),
        panel: panelState(),
        dialog: dialogSummary(),
        modalOpen: Boolean(document.querySelector('[role="dialog"]')),
      };
    },
    async panel() {
      return panelState();
    },
    async dialog() {
      return dialogSummary();
    },
    async goto(path) {
      location.assign(path);
      return { path };
    },
    async navigate(path) {
      // 通过真实 SPA 路由跳转：优先点真实链接，其次用 history + popstate 兜底。
      const link = document.querySelector(`a[href="${path}"]`);
      if (link) {
        link.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (location.pathname === path) return { path: location.pathname, via: 'link' };
      }
      history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { path: location.pathname, via: 'history' };
    },
    /** 真实点击：侧栏「设置」→ 设置分组「数据与备份」。 */
    async openDataPanel() {
      const findGroup = () =>
        Array.from(document.querySelectorAll('.settings-nav-link')).find((a) =>
          norm(a.textContent).includes('数据与备份'),
        );
      if (!findGroup()) {
        const sidebar = Array.from(document.querySelectorAll('a')).find(
          (a) => /^设置/.test(norm(a.textContent)) && a.getAttribute('href')?.startsWith('/settings'),
        );
        if (!sidebar) return { ok: false, route: location.pathname, reason: '找不到侧栏设置入口' };
        sidebar.click();
        await waitFor(() => findGroup(), 15000);
      }
      const groupLink = findGroup();
      if (!groupLink) return { ok: false, route: location.pathname, reason: '找不到设置分组链接' };
      groupLink.click();
      const found = await waitFor(() => norm(document.body.innerText).includes('备份与恢复'), 20000);
      return { ok: Boolean(found), route: location.pathname };
    },
    async reload() {
      setTimeout(() => location.reload(), 60);
      return true;
    },
    async html(selector) {
      const el = document.querySelector(selector);
      return el ? el.outerHTML : null;
    },
    async click(label, scope) {
      return clickLabel(label, scope);
    },
    async clickSelector(selector) {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`找不到元素：${selector}`);
      el.scrollIntoView({ block: 'center' });
      el.click();
      return describe(el);
    },
    async clickTwice(label, gapMs = 60) {
      const button = findButton(label);
      if (!button) throw new Error(`找不到控件：${label}`);
      const before = button.disabled;
      button.click();
      const afterFirst = button.disabled;
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
      button.click();
      return { before, afterFirst, afterSecond: button.disabled, label };
    },
    async chooseBackupFile(url, fileName) {
      return setRestoreFile(url, fileName);
    },
    async setFile(selector, url, fileName) {
      return setInputFiles(selector, url, fileName);
    },
    async conflict(label, choice) {
      return chooseConflict(label, choice);
    },
    async overwrite(enabled) {
      return setOverwrite(enabled);
    },
    /** 把所有支持 overwrite 的冲突项设为覆盖（恢复自己备份的必经操作）。 */
    async overwriteAll() {
      const toggle = await setOverwrite(true);
      const fieldsets = Array.from(document.querySelectorAll('.backup-conflict'));
      const applied = [];
      for (const fieldset of fieldsets) {
        const label = norm(fieldset.getAttribute('aria-label'));
        const input = Array.from(fieldset.querySelectorAll('label'))
          .find((element) => norm(element.textContent) === '覆盖本机')
          ?.querySelector('input');
        if (!input || input.disabled) {
          applied.push({ label, overwritten: false });
          continue;
        }
        input.click();
        applied.push({ label, overwritten: true });
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { toggle, applied };
    },
    async invoke(command, args) {
      return invoke(command, args);
    },
    async putBlob(sha, base64) {
      return putAttachmentBlob(sha, base64);
    },
    async blobStat(sha) {
      return blobStat(sha);
    },
    async clearAttachmentStore() {
      return clearAttachmentStore();
    },
    async panelNotice() {
      return panelState().notice;
    },
    async console() {
      return { errors, warns };
    },
    async clearConsole() {
      errors.length = 0;
      warns.length = 0;
      return true;
    },
    async waitDialog(timeout = 20000) {
      const found = await waitFor(
        () => (document.querySelector('[role="dialog"]') ? dialogSummary() : null),
        timeout,
      );
      return found;
    },
    async waitForText(text, timeout = 20000) {
      return waitFor(() => (norm(document.body.innerText).includes(text) ? true : null), timeout);
    },
    async waitText(text, timeout = 20000) {
      const found = await waitFor(
        () => (norm(document.body.innerText).includes(text) ? true : null),
        timeout,
      );
      return Boolean(found);
    },
    /** 面板是否仍在 busy（导出按钮 disabled 表示生成中）。 */
    async busy() {
      const buttons = Array.from(document.querySelectorAll('.backup-actions button'));
      return { disabled: buttons.some((button) => button.disabled), count: buttons.length };
    },
  };

  window.__Z = api;
  try {
    fetch('/__probe-ready', { method: 'POST' }).catch(() => {});
  } catch (error) {
    /* noop */
  }

  // 命令轮询：Node 下发命令，页面执行并回传结果。
  async function poll() {
    try {
      const response = await fetch('/__next', { cache: 'no-store' });
      if (response.status === 200) {
        const command = await response.json();
        let payload;
        try {
          const fn = api[command.name];
          if (!fn) throw new Error(`未知探针命令：${command.name}`);
          payload = { id: command.id, ok: true, value: await fn(...(command.args || [])) };
        } catch (error) {
          payload = {
            id: command.id,
            ok: false,
            error: String((error && (error.message || error)) || error),
          };
        }
        await fetch('/__result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      }
    } catch (error) {
      /* 服务器暂不可用，继续轮询 */
    }
    setTimeout(poll, 90);
  }
  poll();
})();
