/**
 * ZX13-FULL-QA-01 桌面只读探针（真实 Tauri 2 + WKWebView + SQLite）。
 *
 * 通过 HTTP 命令队列驱动；只使用真实 DOM 事件与真实产品 IPC。不替换产品
 * IPC、不注入假数据源、不改产品代码。数据由探针经真实 IPC 创建，用于
 * 验证启动、打开笔记、编辑/撤销、滚动稳定、行前选择、任务完成、设置分组、
 * 笔记待办、导出、画板保存与重启持久化。
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

  function setNativeValue(element, value) {
    const proto =
      element.tagName === 'SELECT'
        ? HTMLSelectElement.prototype
        : element.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) throw new Error('无法设置控件值');
    setter.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
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

  async function goto(url, marker = null) {
    history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await sleep(250);
    if (marker) {
      await waitFor(
        () => document.querySelector(marker) || norm(document.body.innerText).includes(marker),
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
    const input = await waitFor(
      () => {
        const node = document.querySelector('input[aria-label="笔记标题"]');
        return node && node.value === title ? node : null;
      },
      10_000,
      `笔记标题 ${title}`,
    );
    await waitFor(
      () =>
        document.querySelectorAll('.zxe-inline[data-inline-editor="true"]')
          .length > 0,
      10_000,
      '正文块就绪',
    );
    return input.value;
  }

  function currentInline() {
    return Array.from(
      document.querySelectorAll('.zxe-inline[data-inline-editor="true"]'),
    ).find((el) => visible(el));
  }

  function editorScroller() {
    return document.querySelector('.zxe-body');
  }

  function inlineForBlock(blockId) {
    const row = document.querySelector(`[data-block-id="${blockId}"]`);
    return row ? row.querySelector('.zxe-inline') : null;
  }

  function editorSnapshot() {
    const scroller = editorScroller();
    const active = document.querySelector('.zxe-row.is-active');
    const selected = Array.from(
      document.querySelectorAll('.zxe-block-select[aria-pressed="true"]'),
    )
      .map((button) => button.closest('[data-block-id]')?.dataset.blockId)
      .filter(Boolean);
    return {
      inline: norm(currentInline()?.textContent || ''),
      blockCount: document.querySelectorAll('.zxe-body [data-block-id]').length,
      activeBlock:
        active?.dataset.blockId ||
        currentInline()?.closest('[data-block-id]')?.dataset.blockId ||
        null,
      scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
      scrollHeight: scroller ? scroller.scrollHeight : null,
      clientHeight: scroller ? scroller.clientHeight : null,
      selected,
      selectedCount: selected.length,
      saveEditor: norm(
        document.querySelector('.zxe-save-state')?.textContent || '',
      ),
      savePage: norm(
        document.querySelector('.kn-save-state')?.textContent || '',
      ),
    };
  }

  function insertText(inline, text) {
    inline.focus();
    const range = document.createRange();
    range.selectNodeContents(inline);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    let inserted = false;
    try {
      inserted = Boolean(
        document.execCommand &&
          document.execCommand('insertText', false, text),
      );
    } catch {
      inserted = false;
    }
    if (!inserted) {
      inline.textContent = `${inline.textContent || ''}${text}`;
      inline.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: text,
        }),
      );
    }
    return inserted;
  }

  async function waitSaved() {
    await waitFor(
      () => {
        const editor = norm(
          document.querySelector('.zxe-save-state')?.textContent || '',
        );
        const page = norm(
          document.querySelector('.kn-save-state')?.textContent || '',
        );
        return (
          (editor.includes('已保存到本机') || editor.includes('已保存')) &&
          (page.includes('已保存到本机') || page.includes('已保存'))
        );
      },
      10_000,
      '保存完成',
    );
    return editorSnapshot();
  }

  async function editUndoRedo(blockId) {
    const inline = blockId
      ? await waitFor(
          () => inlineForBlock(blockId),
          8000,
          `可编辑正文 ${blockId}`,
        )
      : await waitFor(currentInline, 8000, '可编辑正文');
    inline.focus();
    inline.click();
    const original = norm(inline.textContent || '');
    const phrase = 'ZX13十个字输入验收';
    for (const char of phrase) {
      insertText(inline, char);
      await sleep(0);
    }
    const typed = await waitFor(
      () => norm(currentInline()?.textContent || '').includes(phrase),
      6000,
      '输入生效',
    );
    const afterType = editorSnapshot();
    pressKey(currentInline(), { key: 'z', metaKey: true });
    const undone = await waitFor(
      () => norm(currentInline()?.textContent || '') === original,
      6000,
      '撤销回到输入前',
    );
    const afterUndo = editorSnapshot();
    pressKey(currentInline() || inline, {
      key: 'z',
      metaKey: true,
      shiftKey: true,
    });
    const redone = await waitFor(
      () => norm(currentInline()?.textContent || '').includes(phrase),
      6000,
      '重做恢复输入',
    );
    const afterRedo = editorSnapshot();
    // 回到撤销后的原始状态，避免影响后续滚动/选择。
    pressKey(currentInline(), { key: 'z', metaKey: true });
    await waitFor(
      () => norm(currentInline()?.textContent || '') === original,
      6000,
      '收尾撤销',
    );
    await waitSaved();
    return {
      phrase,
      original,
      typed: Boolean(typed),
      afterType,
      undone: Boolean(undone),
      afterUndo,
      redone: Boolean(redone),
      afterRedo,
      final: editorSnapshot(),
    };
  }

  function scrollSnapshot() {
    const scroller = editorScroller();
    return {
      scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
      scrollHeight: scroller ? scroller.scrollHeight : null,
      clientHeight: scroller ? scroller.clientHeight : null,
      activeBlock:
        document.querySelector('.zxe-row.is-active')?.dataset.blockId ||
        currentInline()?.closest('[data-block-id]')?.dataset.blockId ||
        null,
      lastBlockId: (() => {
        const rows = document.querySelectorAll('.zxe-body [data-block-id]');
        return rows.length ? rows[rows.length - 1].dataset.blockId : null;
      })(),
    };
  }

  async function scrollStability() {
    const scroller = await waitFor(editorScroller, 8000, '正文滚动容器');
    scroller.scrollTop = 320;
    await sleep(120);
    const before = scrollSnapshot();

    const target = inlineForBlock('zx13-b6');
    if (!target) throw new Error('找不到 zx13-b6 正文块');
    target.click();
    insertText(target, '·');
    await sleep(160);
    const afterType = scrollSnapshot();
    pressKey(target, { key: 'z', metaKey: true });
    await sleep(160);

    const bodyRect = scroller.getBoundingClientRect();
    scroller.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: bodyRect.left + bodyRect.width / 2,
        clientY: bodyRect.bottom - 12,
      }),
    );
    await sleep(160);
    const afterBlank = scrollSnapshot();

    const maxScroll = Math.max(
      0,
      (before.scrollHeight ?? 0) - (before.clientHeight ?? 0),
    );
    const typeShift = Math.abs(
      (afterType.scrollTop ?? 0) - (before.scrollTop ?? 0),
    );
    const blankShift = Math.abs(
      (afterBlank.scrollTop ?? 0) - (before.scrollTop ?? 0),
    );
    return {
      before,
      afterType,
      afterBlank,
      maxScroll,
      typeShift,
      blankShift,
      typeStable: typeShift <= 80,
      blankStable: blankShift <= 80,
      notBottom: (afterBlank.scrollTop ?? 0) < maxScroll - 100,
      activeNotLast:
        afterType.activeBlock !== before.lastBlockId &&
        afterBlank.activeBlock !== before.lastBlockId,
    };
  }

  async function rowSelection() {
    const row = await waitFor(
      () => document.querySelector('[data-block-id="zx13-b3"]'),
      8000,
      '目标行 zx13-b3',
    );
    const button = row.querySelector('.zxe-block-select');
    if (!button) throw new Error('行前选择控件不存在');
    const before = editorSnapshot();
    button.click();
    await waitFor(
      () =>
        row.querySelector('.zxe-block-select')?.getAttribute('aria-pressed') ===
          'true' ||
        row.classList.contains('is-selected'),
      5000,
      '整行选中',
    );
    const selected = editorSnapshot();
    row.querySelector('.zxe-block-select').click();
    await waitFor(
      () => editorSnapshot().selectedCount === 0,
      5000,
      '取消整行选中',
    );
    const after = editorSnapshot();
    return { before, selected, after };
  }

  async function seed() {
    const today = (() => {
      const now = new Date();
      const pad = (v) => String(v).padStart(2, '0');
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    })();
    const lists = await invoke('lists_list', { query: null });
    const inbox = lists.find((item) => item.isInbox) || lists[0];
    if (!inbox) throw new Error('没有可用清单');

    const note = await invoke('notes_create', {
      input: {
        id: 'zx13-long-note',
        title: 'ZX13 全量长文验收',
        body: '<p></p>',
        tags: ['ZX13'],
        status: 'active',
      },
    });
    for (let index = 1; index <= 40; index += 1) {
      const text =
        index === 6
          ? '第 6 段 ZX13 滚动验收：点击与输入不能让正文跳到底部。'
          : `第 ${index} 段 ZX13 全量回归长文内容，用于验证滚动位置、活动块与行前选择在真实桌面壳中的稳定性。`;
      await invoke('note_blocks_create', {
        input: {
          id: `zx13-b${index}`,
          noteId: note.id,
          blockType: 'paragraph',
          orderKey: index * 1024,
          payload: { runs: [{ text }] },
        },
      });
    }

    const exportNote = await invoke('notes_create', {
      input: {
        id: 'zx13-export-note',
        title: 'ZX13 导出验收',
        body: '<p></p>',
        tags: ['ZX13'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'zx13-export-p1',
        noteId: exportNote.id,
        blockType: 'paragraph',
        orderKey: 1024,
        payload: { runs: [{ text: 'ZX13 导出验收正文：真实文件落盘。' }] },
      },
    });

    const task = await invoke('tasks_create', {
      input: {
        id: 'zx13-task-complete',
        listId: inbox.id,
        title: 'ZX13 完成任务验收',
        status: 'todo',
        priority: 1,
        quadrant: 1,
        dueDate: today,
        sortOrder: 10,
      },
    });
    return {
      noteId: note.id,
      exportNoteId: exportNote.id,
      taskId: task.id,
      inboxId: inbox.id,
      today,
      blocks: 40,
    };
  }

  async function completeTask(title) {
    await goto('/today', '今天');
    const button = await waitFor(
      () =>
        Array.from(document.querySelectorAll('button')).find(
          (el) =>
            visible(el) &&
            norm(el.getAttribute('aria-label')) === `完成任务：${title}`,
        ),
      10_000,
      '完成任务按钮',
    );
    button.click();
    const done = await waitFor(
      async () => {
        const task = await invoke('tasks_get', { id: 'zx13-task-complete' });
        return task.status === 'done' ? task : null;
      },
      10_000,
      '任务完成落库',
    );
    const undo = await waitFor(
      () =>
        Array.from(document.querySelectorAll('button')).find(
          (el) =>
            visible(el) &&
            norm(el.getAttribute('aria-label')) === `撤销完成：${title}`,
        ),
      8000,
      '撤销完成按钮',
    );
    undo.click();
    const reopened = await waitFor(
      async () => {
        const task = await invoke('tasks_get', { id: 'zx13-task-complete' });
        return task.status === 'todo' ? task : null;
      },
      10_000,
      '撤销完成落库',
    );
    return {
      doneStatus: done.status,
      completedAt: done.completedAt,
      undoneStatus: reopened.status,
    };
  }

  function settingsCard() {
    return document.querySelector('.settings-card');
  }

  async function visitSettingsGroups() {
    const groups = [
      ['appearance', '外观与阅读'],
      ['task', '任务与记录'],
      ['calendar', '日历与工作日'],
      ['notify', '提醒与通知'],
      ['ocr', '知识库与 OCR'],
      ['privacy', '隐私与安全'],
      ['sync', '同步与网络'],
      ['data', '数据与备份'],
      ['license', '许可与设备'],
    ];
    const result = [];
    for (const [id, title] of groups) {
      await goto(`/settings/${id}`);
      await waitFor(
        () => norm(settingsCard()?.querySelector('h2')?.textContent) === title,
        10_000,
        `设置分组 ${title}`,
      );
      const text = norm(settingsCard().innerText);
      result.push({
        id,
        title,
        navCount: document.querySelectorAll('.settings-nav a').length,
        comingSoon: text.includes('即将支持') || text.includes('ComingSoon'),
        unimplemented: text.includes('未实现'),
        disabledRows: document.querySelectorAll('.settings-row.is-disabled').length,
        chars: text.length,
      });
    }
    return result;
  }

  async function settingValue(key) {
    const rows = await invoke('settings_list', { query: null });
    return rows.find((item) => item.key === key)?.value;
  }

  async function changeSettings() {
    await goto('/settings/task');
    await waitFor(
      () => document.querySelector('select[aria-label="默认提醒"]'),
      8000,
      '默认提醒控件',
    );
    setNativeValue(
      document.querySelector('select[aria-label="默认提醒"]'),
      '15m',
    );
    await waitFor(
      async () => (await settingValue('tasks.defaultReminder')) === '15m',
      10_000,
      '默认提醒写入',
    );
    setNativeValue(
      document.querySelector('select[aria-label="完成后行为"]'),
      'remove',
    );
    await waitFor(
      async () =>
        (await settingValue('tasks.completionBehavior')) === 'remove',
      10_000,
      '完成后行为写入',
    );

    await goto('/settings/calendar');
    const sunday = await waitFor(
      () =>
        Array.from(
          document.querySelectorAll('[aria-label="周起始日"] button'),
        ).find((button) => norm(button.textContent) === '周日'),
      8000,
      '周起始日周日',
    );
    sunday.click();
    await waitFor(
      async () => (await settingValue('calendar.weekStart')) === 'sunday',
      10_000,
      '周起始日写入',
    );

    await goto('/settings/privacy');
    const diagnostics = await waitFor(
      () => document.querySelector('[role="switch"][aria-label="开启本机诊断记录"]'),
      8000,
      '诊断开关',
    );
    if (diagnostics.getAttribute('aria-checked') !== 'true') diagnostics.click();
    await waitFor(
      async () => (await settingValue('privacy.diagnosticsEnabled')) === true,
      10_000,
      '诊断开关写入',
    );

    await goto('/settings/appearance');
    const dark = await waitFor(
      () =>
        Array.from(document.querySelectorAll('[aria-label="主题"] button')).find(
          (button) => norm(button.textContent) === '深色',
        ),
      8000,
      '深色主题',
    );
    dark.click();
    await waitFor(
      () => document.documentElement.getAttribute('data-theme') === 'dark',
      8000,
      '主题立即生效',
    );

    return {
      defaultReminder: await settingValue('tasks.defaultReminder'),
      completionBehavior: await settingValue('tasks.completionBehavior'),
      weekStart: await settingValue('calendar.weekStart'),
      diagnostics: await settingValue('privacy.diagnosticsEnabled'),
      theme: document.documentElement.getAttribute('data-theme'),
    };
  }

  async function noteTodoProbe() {
    const before = await invoke('note_todos_list', {
      noteId: 'zx13-long-note',
      includeDeleted: false,
    });
    let ipcError = null;
    try {
      await invoke('note_todos_create', {
        input: {
          id: 'zx13-todo-direct',
          noteId: 'zx13-long-note',
          title: 'ZX13 笔记待办直连',
          done: false,
          sortOrder: 100,
        },
      });
    } catch (reason) {
      ipcError = errText(reason);
    }
    const after = await invoke('note_todos_list', {
      noteId: 'zx13-long-note',
      includeDeleted: false,
    });

    // 真实 UI：从块菜单插入待办，观察用户可见结果。
    await openNote('ZX13 全量长文验收');
    const control = await waitFor(
      () =>
        Array.from(document.querySelectorAll('.zxe-block-control')).find(
          (button) => visible(button),
        ),
      8000,
      '块插入按钮',
    );
    control.click();
    const menu = await waitFor(
      () => document.querySelector('[role="menu"][aria-label="插入块"]'),
      6000,
      '插入块菜单',
    );
    const todoItem = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
      (item) => norm(item.textContent).includes('待办'),
    );
    if (!todoItem) throw new Error('块菜单缺少待办');
    const errorBefore = errors.length;
    todoItem.click();
    await sleep(1200);
    const newErrors = errors.slice(errorBefore);
    const afterUi = await invoke('note_todos_list', {
      noteId: 'zx13-long-note',
      includeDeleted: false,
    });
    const alertText = norm(
      document.querySelector('[role="alert"]')?.textContent || '',
    );
    const bodyTail = norm(document.body.innerText).slice(-600);
    return {
      beforeCount: before.length,
      afterCount: after.length,
      afterUiCount: afterUi.length,
      ipcError,
      uiErrors: newErrors,
      alertText,
      bodyTail,
    };
  }

  async function openExportDialog(formatLabel) {
    const trigger = await waitFor(
      () =>
        Array.from(document.querySelectorAll('button')).find(
          (button) =>
            visible(button) &&
            norm(button.getAttribute('aria-label')) === '导出笔记',
        ),
      8000,
      '导出笔记入口',
    );
    trigger.click();
    const menu = await waitFor(
      () => document.querySelector('[role="menu"]'),
      6000,
      '导出菜单',
    );
    const item = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
      (el) => norm(el.textContent).includes(formatLabel),
    );
    if (!item) throw new Error(`导出菜单缺少 ${formatLabel}`);
    item.click();
    const dialog = await waitFor(
      () =>
        Array.from(document.querySelectorAll('[role="dialog"]')).find(visible),
      8000,
      '导出弹层',
    );
    return dialog;
  }

  async function exportFormat(formatLabel) {
    const dialog = await openExportDialog(formatLabel);
    const next = Array.from(dialog.querySelectorAll('button')).find(
      (button) => norm(button.textContent) === '继续',
    );
    if (!next) throw new Error('导出弹层没有继续');
    next.click();
    const done = await waitFor(
      () => {
        const current = Array.from(
          document.querySelectorAll('[role="dialog"]'),
        ).find(visible);
        return current && norm(current.innerText).includes('已导出')
          ? current
          : null;
      },
      30_000,
      '导出完成',
    );
    const text = norm(done.innerText);
    const complete = Array.from(done.querySelectorAll('button')).find(
      (button) => norm(button.textContent) === '完成',
    );
    if (complete) complete.click();
    await sleep(300);
    return { text };
  }

  async function exportAll() {
    await openNote('ZX13 导出验收');
    const results = {};
    for (const [key, label] of [
      ['md', 'Markdown（.md）'],
      ['docx', 'Word 文档（.docx）'],
      ['pdf', 'PDF（.pdf）'],
      ['zxnote', '知行笔记包（.zxnote）'],
    ]) {
      results[key] = await exportFormat(label);
    }
    return results;
  }

  function fitViewport(nodes, width, height, padding = 80) {
    const left = Math.min(...nodes.map((node) => node.x));
    const top = Math.min(...nodes.map((node) => node.y));
    const right = Math.max(...nodes.map((node) => node.x + node.width));
    const bottom = Math.max(...nodes.map((node) => node.y + node.height));
    const boundsWidth = Math.max(1, right - left);
    const boundsHeight = Math.max(1, bottom - top);
    const availableWidth = Math.max(60, width - padding * 2);
    const availableHeight = Math.max(60, height - padding * 2);
    const zoom = Math.max(
      0.3,
      Math.min(4, Math.round(
        Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight, 1.2) * 100,
      ) / 100),
    );
    return {
      x: left + boundsWidth / 2 - width / (2 * zoom),
      y: top + boundsHeight / 2 - height / (2 * zoom),
      zoom,
    };
  }

  function pointer(canvas, type, x, y, buttons = 0) {
    canvas.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        button: type === 'pointerup' ? 0 : 0,
        buttons,
        clientX: x,
        clientY: y,
      }),
    );
  }

  async function boardProbe() {
    const boards = await invoke('boards_list', { query: null });
    const board = boards.find((item) => item.id === 'seed-board-flow');
    if (!board) throw new Error('找不到种子画板');
    await goto('/board/seed-board-flow', '.bw-canvas');
    const canvas = await waitFor(
      () => document.querySelector('.bw-canvas'),
      10_000,
      '画布',
    );
    await sleep(900);
    const nodes = await invoke('board_nodes_list', {
      boardId: board.id,
      includeDeleted: false,
    });
    const target = nodes.find((node) => node.id === 'seed-node-review') || nodes[0];
    if (!target) throw new Error('画板没有节点');
    const rect = canvas.getBoundingClientRect();
    const view = fitViewport(nodes, Math.round(rect.width), Math.round(rect.height));
    const x = rect.left + (target.x + target.width / 2 - view.x) * view.zoom;
    const y = rect.top + (target.y + target.height / 2 - view.y) * view.zoom;
    pointer(canvas, 'pointerdown', x, y, 1);
    pointer(canvas, 'pointermove', x + 120, y + 40, 1);
    pointer(canvas, 'pointerup', x + 120, y + 40, 0);
    await sleep(900);
    const moved = (await invoke('board_nodes_list', {
      boardId: board.id,
      includeDeleted: false,
    })).find((node) => node.id === target.id);
    const inspectorText = norm(
      document.querySelector('.bw-inspector')?.innerText || '',
    );
    const inspectorHeading = norm(
      document.querySelector('.bw-inspector-body h3')?.textContent || '',
    );
    const saveLabel = norm(
      document.querySelector('.bw-save-state')?.innerText || '',
    );
    return {
      boardId: board.id,
      nodeCount: nodes.length,
      targetId: target.id,
      before: { x: target.x, y: target.y },
      after: moved ? { x: moved.x, y: moved.y } : null,
      inspectorBody: Boolean(document.querySelector('.bw-inspector-body')),
      inspectorHeading,
      inspectorText: inspectorText.slice(0, 300),
      saveLabel,
      rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
      view,
      click: { x: Math.round(x), y: Math.round(y) },
    };
  }

  async function boardReopen() {
    await goto('/today', '今天');
    await goto('/board/seed-board-flow', '.bw-canvas');
    await sleep(1200);
    const nodes = await invoke('board_nodes_list', {
      boardId: 'seed-board-flow',
      includeDeleted: false,
    });
    return {
      count: nodes.length,
      position: nodes.find((node) => node.id === 'seed-node-review'),
    };
  }


  async function eventCrud() {
    const pad = (v) => String(v).padStart(2, '0');
    const dateOf = (offset) => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
    };
    const dialog = () =>
      Array.from(document.querySelectorAll('[role="dialog"]')).find(visible);
    const controlByLabel = (root, text) => {
      const label = Array.from(root.querySelectorAll('label')).find(
        (item) => norm(item.textContent) === text,
      );
      if (!label) throw new Error(`找不到字段 ${text}`);
      return label.htmlFor
        ? document.getElementById(label.htmlFor)
        : label.querySelector('input, select, textarea');
    };
    const commitDate = (control, value) => {
      setNativeValue(control, value);
      control.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    };

    await goto('/calendar', '[data-testid="month-grid"]');
    const create = await waitFor(
      () =>
        Array.from(document.querySelectorAll('[aria-label="新建事件"]')).find(
          visible,
        ),
      8000,
      '新建事件入口',
    );
    create.click();
    let root = await waitFor(dialog, 8000, '新建事件弹层');
    const date1 = dateOf(2);
    setNativeValue(controlByLabel(root, '标题'), 'ZX13 事件验收');
    commitDate(controlByLabel(root, '日期'), date1);
    await sleep(120);
    setNativeValue(controlByLabel(root, '时间'), '09:05');
    setNativeValue(controlByLabel(root, '类别'), '工作日程');
    setNativeValue(controlByLabel(root, '重复'), '每年');
    const save = Array.from(root.querySelectorAll('button')).find(
      (button) => norm(button.textContent) === '保存',
    );
    if (!save || save.disabled) throw new Error('保存事件按钮不可用');
    save.click();
    const created = await waitFor(
      async () => {
        const rows = await invoke('events_list', { query: null });
        return rows.find((row) => row.title === 'ZX13 事件验收') || null;
      },
      10_000,
      '事件创建落库',
    );

    const switchEvents = async () => {
      const tab = await waitFor(
        () =>
          Array.from(document.querySelectorAll('[role="tab"]')).find(
            (button) => norm(button.textContent) === '事件',
          ),
        8000,
        '事件分区',
      );
      tab.click();
      await sleep(400);
    };
    await switchEvents();
    const edit = await waitFor(
      () =>
        Array.from(document.querySelectorAll('[aria-label^="编辑事件"]')).find(
          (button) => visible(button),
        ),
      8000,
      '编辑事件入口',
    );
    edit.click();
    root = await waitFor(dialog, 8000, '编辑事件弹层');
    const date2 = dateOf(3);
    setNativeValue(controlByLabel(root, '标题'), 'ZX13 事件验收改');
    commitDate(controlByLabel(root, '日期'), date2);
    setNativeValue(controlByLabel(root, '时间'), '10:15');
    await sleep(120);
    const saveEdit = Array.from(root.querySelectorAll('button')).find(
      (button) => norm(button.textContent) === '保存',
    );
    if (!saveEdit || saveEdit.disabled) throw new Error('保存编辑按钮不可用');
    saveEdit.click();
    const edited = await waitFor(
      async () => {
        const rows = await invoke('events_list', { query: null });
        const row = rows.find((item) => item.id === created.id);
        return row && row.startDate === date2 && row.title === 'ZX13 事件验收改'
          ? row
          : null;
      },
      10_000,
      '事件编辑落库',
    );

    await goto('/today', '今天');
    await goto('/calendar', '[data-testid="month-grid"]');
    const dayCell = await waitFor(
      () => document.querySelector(`[data-testid="day-${date2}"]`),
      8000,
      '事件日期格',
    );
    dayCell.click();
    await sleep(300);
    await switchEvents();
    const persisted = (await invoke('events_list', { query: null })).find(
      (item) => item.id === created.id,
    );
    const remove = await waitFor(
      () =>
        Array.from(
          document.querySelectorAll(`[aria-label="删除事件「${edited.title}」"]`),
        ).find(visible),
      8000,
      '删除事件入口',
    );
    remove.click();
    const confirm = await waitFor(
      () =>
        Array.from(document.querySelectorAll('button')).find(
          (button) => norm(button.textContent) === '删除事件' && visible(button),
        ),
      8000,
      '删除确认',
    );
    confirm.click();
    const removed = await waitFor(
      async () => {
        const rows = await invoke('events_list', { query: null });
        return rows.some((item) => item.id === created.id) ? null : true;
      },
      10_000,
      '事件删除落库',
    );

    return {
      created: {
        id: created.id,
        title: created.title,
        startDate: created.startDate,
        startAt: created.startAt,
        eventType: created.eventType,
        repeatRule: created.repeatRule,
      },
      edited: {
        title: edited.title,
        startDate: edited.startDate,
        startAt: edited.startAt,
      },
      persistedStartDate: persisted?.startDate ?? null,
      removed,
      expected: { date1, date2 },
    };
  }

  async function restartSnapshot() {
    const settings = await invoke('settings_list', { query: null });
    const value = (key) => settings.find((item) => item.key === key)?.value;
    const nodes = await invoke('board_nodes_list', {
      boardId: 'seed-board-flow',
      includeDeleted: false,
    });
    const tasks = await invoke('tasks_list', { query: null });
    return {
      route: location.pathname + location.search,
      theme: document.documentElement.getAttribute('data-theme'),
      trialText: norm(document.body.innerText).slice(0, 400),
      settings: {
        defaultReminder: value('tasks.defaultReminder'),
        completionBehavior: value('tasks.completionBehavior'),
        weekStart: value('calendar.weekStart'),
        diagnostics: value('privacy.diagnosticsEnabled'),
      },
      boardNode: nodes.find((node) => node.id === 'seed-node-review') || null,
      taskUndone:
        tasks.find((item) => item.id === 'zx13-task-complete')?.status ?? null,
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
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
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
      case 'goto':
        return goto(command.url, command.marker);
      case 'seed':
        return seed();
      case 'openNote':
        return { title: await openNote(command.title) };
      case 'editorSnapshot':
        return editorSnapshot();
      case 'editUndoRedo':
        return editUndoRedo(command.blockId);
      case 'scrollStability':
        return scrollStability();
      case 'rowSelection':
        return rowSelection();
      case 'waitSaved':
        return waitSaved();
      case 'completeTask':
        return completeTask(command.title);
      case 'visitSettingsGroups':
        return visitSettingsGroups();
      case 'changeSettings':
        return changeSettings();
      case 'settingValue':
        return settingValue(command.key);
      case 'noteTodoProbe':
        return noteTodoProbe();
      case 'eventCrud':
        return eventCrud();
      case 'exportAll':
        return exportAll();
      case 'boardProbe':
        return boardProbe();
      case 'boardReopen':
        return boardReopen();
      case 'restartSnapshot':
        return restartSnapshot();
      case 'errors':
        return { errors: errors.slice(-80), pageExceptions: pageExceptions.slice(-20) };
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
