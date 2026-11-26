/**
 * ZX-NOTE-02 真实 Tauri WebView 探针：长文打字机/专注重定义。
 *
 * 只通过真实产品 IPC 造数据、只派发真实 DOM 事件：
 *   * 造一篇 26 块长文（含标题/引用），验证页面无独立「打字机」按钮；
 *   * 专注模式状态条（写作跟随勾选 + 当前表现 + 退出）与周边隐藏；
 *   * 非当前块 opacity 轻淡、当前块整亮 + 左侧竖线、正文 ≤ 760px；
 *   * 写作跟随把点选块滚到视口约 36% 处（长文滚动位移明显）；
 *   * 关闭写作跟随后只切换高亮不再滚动；Esc 退出后滚动位置保持；
 *   * ⌘⇧F 切换专注；输入/撤销/保存/阅读不受影响；
 *   * 收集 console.error / window.error / unhandledrejection。
 */
(function () {
  const ERROR_KEY = 'zx-note-02-errors';
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

  const NOTE_ID = 'zx-note-02-note';
  const TITLE = 'ZX-NOTE-02 长文专注';
  const BLOCK_COUNT = 26;

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

  function rows() {
    return Array.from(
      document.querySelectorAll('.zxe-body [data-block-id]'),
    );
  }

  function scroller() {
    return document.querySelector('.zxe-body');
  }

  function activeRow() {
    return document.querySelector('.zxe-row.is-active');
  }

  function railState() {
    const rail = document.querySelector('nav.kn-rail');
    if (!rail) {
      return { found: false, items: 0, toggle: false, captions: [] };
    }
    const buttons = Array.from(rail.querySelectorAll('button'));
    return {
      found: true,
      items: buttons.filter(
        (button) => !button.classList.contains('kn-rail-toggle'),
      ).length,
      toggle: Boolean(rail.querySelector('.kn-rail-toggle')),
      captions: Array.from(rail.querySelectorAll('.kn-rail-caption')).map(
        (node) => norm(node.textContent),
      ),
    };
  }

  function saveLabel() {
    return norm(
      document.querySelector('.kn-save-state')?.textContent || '',
    );
  }

  function historyState() {
    const undo = document.querySelector('button[aria-label="撤销编辑"]');
    return {
      undoFound: Boolean(undo),
      undoDisabled: undo ? Boolean(undo.disabled) : null,
    };
  }

  function typewriterButtons() {
    return Array.from(document.querySelectorAll('button'))
      .filter((button) => {
        const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`;
        return label.includes('打字机');
      })
      .map((button) => button.getAttribute('aria-label'));
  }

  function focusState() {
    const root = document.querySelector('.zxe');
    const bar = document.querySelector('.zxe-focusbar');
    const followInput = bar
      ? bar.querySelector('input[type="checkbox"]')
      : null;
    const body = scroller();
    const active = activeRow();
    const allRows = rows();
    const otherRow = allRows.find((row) => row !== active);
    const bodyRect = body ? body.getBoundingClientRect() : null;
    const activeRect = active ? active.getBoundingClientRect() : null;
    let activeLine = null;
    if (active) {
      const style = getComputedStyle(active, '::before');
      activeLine = {
        content: style.content,
        background: style.backgroundColor,
        width: style.width,
      };
    }
    const tree = document.querySelector('.kn-tree');
    return {
      dataFocus: root ? root.getAttribute('data-focus') : null,
      dataFollow: root ? root.getAttribute('data-writing-follow') : null,
      workspaceFocus: Boolean(
        document.querySelector('.kn-workspace.is-focus'),
      ),
      treeDisplay: tree ? getComputedStyle(tree).display : null,
      barPresent: Boolean(bar),
      barText: norm(bar ? bar.textContent : ''),
      followChecked: followInput ? followInput.checked : null,
      activeBlockId: active ? active.dataset.blockId : null,
      activeOpacity: active ? getComputedStyle(active).opacity : null,
      otherOpacity: otherRow ? getComputedStyle(otherRow).opacity : null,
      activeLine,
      rowWidth: allRows[0]
        ? Math.round(allRows[0].getBoundingClientRect().width)
        : null,
      blockCount: allRows.length,
      firstBlockText: norm(allRows[0] ? allRows[0].textContent : ''),
      scrollTop: body ? Math.round(body.scrollTop) : null,
      scrollHeight: body ? body.scrollHeight : null,
      clientHeight: body ? body.clientHeight : null,
      activeTopInBody:
        active && body
          ? Math.round(activeRect.top - bodyRect.top)
          : null,
      bodyInnerHasTypewriter: document.body.innerText.includes('打字机'),
      typewriterButtons: typewriterButtons(),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      rail: railState(),
      saveLabel: saveLabel(),
      history: historyState(),
    };
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

  async function seedLongNote() {
    try {
      sessionStorage.removeItem(ERROR_KEY);
    } catch {
      /* ignore */
    }
    errors = [];
    // 回到「默认开启」的初始态（设备偏好 editor.focus.follow 不进笔记数据）。
    try {
      window.localStorage.removeItem('editor.focus.follow');
    } catch {
      /* ignore */
    }
    const note = await invoke('notes_create', {
      input: {
        id: NOTE_ID,
        title: TITLE,
        body: '<p></p>',
        tags: ['ZX-NOTE-02'],
        status: 'active',
      },
    });
    for (let index = 0; index < BLOCK_COUNT; index += 1) {
      const id = `zx-note-02-b${index + 1}`;
      const orderKey = (index + 1) * 1024;
      if (index === 3) {
        await invoke('note_blocks_create', {
          input: {
            id,
            noteId: note.id,
            blockType: 'heading2',
            orderKey,
            payload: { runs: [{ text: `第 ${index + 1} 节 · 专注模式验证` }] },
          },
        });
        continue;
      }
      if (index === 9) {
        await invoke('note_blocks_create', {
          input: {
            id,
            noteId: note.id,
            blockType: 'quote',
            orderKey,
            payload: {
              runs: [
                {
                  text: `第 ${index + 1} 段 · 引用块整块居中；行级跟随属于正式版增强。`,
                },
              ],
            },
          },
        });
        continue;
      }
      await invoke('note_blocks_create', {
        input: {
          id,
          noteId: note.id,
          blockType: 'paragraph',
          orderKey,
          payload: {
            runs: [
              {
                text: `第 ${index + 1} 段 · 知行专注模式长文验证段落，用于确认写作跟随的滚动反馈。`,
              },
            ],
          },
        },
      });
    }
    return { noteId: note.id, title: note.title, blocks: BLOCK_COUNT };
  }

  function railButton(label) {
    return Array.from(
      document.querySelectorAll('nav.kn-rail button'),
    ).find((button) => button.getAttribute('aria-label') === label);
  }

  async function enterFocus() {
    const button = await waitFor(() => railButton('专注模式'), 6000);
    if (!button) throw new Error('找不到工具轨「专注模式」按钮');
    button.click();
    await sleep(800);
    return focusState();
  }

  async function exitViaButton() {
    const bar = await waitFor(
      () => document.querySelector('.zxe-focusbar'),
      6000,
    );
    if (!bar) throw new Error('专注状态条不存在');
    const exit = Array.from(bar.querySelectorAll('button')).find(
      (button) => norm(button.textContent) === '退出',
    );
    if (!exit) throw new Error('专注状态条没有「退出」按钮');
    exit.click();
    await sleep(500);
    return focusState();
  }

  async function clickBlock(index) {
    const row = rows()[index];
    if (!row) throw new Error(`没有第 ${index} 个块`);
    const inline = row.querySelector('[data-inline-editor="true"]');
    if (inline) {
      inline.focus();
      const range = document.createRange();
      range.selectNodeContents(inline);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      row.click();
    }
    return row.dataset.blockId;
  }

  async function scrollByFollowing(index) {
    const body = scroller();
    if (!body) throw new Error('没有 .zxe-body 滚动容器');
    const scrollTopBefore = body.scrollTop;
    const blockId = await clickBlock(index);
    await sleep(900);
    const row = rows()[index];
    const bodyRect = body.getBoundingClientRect();
    const activeTop = row.getBoundingClientRect().top - bodyRect.top;
    return {
      index,
      blockId,
      scrollTopBefore: Math.round(scrollTopBefore),
      scrollTopAfter: Math.round(body.scrollTop),
      delta: Math.round(body.scrollTop - scrollTopBefore),
      activeTopInBody: Math.round(activeTop),
      clientHeight: body.clientHeight,
      ratio: Number((activeTop / body.clientHeight).toFixed(3)),
      isNowActive: row.classList.contains('is-active'),
    };
  }

  async function toggleFollow() {
    const input = await waitFor(
      () => document.querySelector('.zxe-focusbar input[type="checkbox"]'),
      6000,
    );
    if (!input) throw new Error('找不到写作跟随勾选框');
    input.click();
    await sleep(400);
    return focusState();
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

  async function pressEsc() {
    pressKey(document, { key: 'Escape' });
    await sleep(500);
    return focusState();
  }

  async function pressShortcut() {
    pressKey(document, { key: 'f', metaKey: true, shiftKey: true });
    await sleep(800);
    return focusState();
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

  async function typingUndoSave() {
    const inline = await waitFor(
      () =>
        rows()[0]?.querySelector('[data-inline-editor="true"]') || null,
      8000,
    );
    if (!inline) throw new Error('找不到正文可编辑块');
    const before = norm(inline.textContent);
    insertChar(inline, '审');
    await sleep(300);
    const typed = norm(inline.textContent);
    const undoEnabled = await waitFor(
      () => {
        const undo = document.querySelector('button[aria-label="撤销编辑"]');
        return undo && !undo.disabled ? undo : null;
      },
      4000,
    );
    pressKey(inline, { key: 'z', metaKey: true });
    const undone = await waitFor(
      () => norm(inline.textContent) === before,
      5000,
    );
    const label = await waitFor(() => {
      const text = saveLabel();
      return text.includes('已保存到本机') ? text : null;
    }, 8000);
    return {
      before,
      typed,
      undoEnabled: Boolean(undoEnabled),
      undone: Boolean(undone),
      afterUndo: norm(inline.textContent),
      saveLabel: label,
    };
  }

  async function readingToggle() {
    const toRead = await waitFor(() => railButton('进入阅读模式'), 6000);
    if (!toRead) throw new Error('找不到「进入阅读模式」按钮');
    toRead.click();
    await sleep(500);
    const inline = rows()[0]?.querySelector('[data-inline-editor="true"]');
    const readState = {
      readOnly: document
        .querySelector('.zxe')
        ?.getAttribute('data-read-only'),
      contentEditable: inline ? inline.getAttribute('contenteditable') : null,
      blockControls: document.querySelectorAll('.zxe-block-control').length,
    };
    const toEdit = await waitFor(() => railButton('进入编辑模式'), 6000);
    if (!toEdit) throw new Error('找不到「进入编辑模式」按钮');
    toEdit.click();
    await sleep(500);
    const inlineBack = rows()[0]?.querySelector(
      '[data-inline-editor="true"]',
    );
    return {
      read: readState,
      backToEdit: {
        readOnly: document
          .querySelector('.zxe')
          ?.getAttribute('data-read-only'),
        contentEditable: inlineBack
          ? inlineBack.getAttribute('contenteditable')
          : null,
      },
    };
  }

  function clickButtonByText(text, root = document) {
    return Array.from(
      root.querySelectorAll('button, [role="menuitem"], [role="option"]'),
    ).find((el) => visible(el) && norm(el.textContent).includes(text));
  }

  async function waitSave(timeout = 8000) {
    const label = await waitFor(() => {
      const text = saveLabel();
      return text.includes('已保存到本机') ? text : null;
    }, timeout);
    if (!label) {
      throw new Error(`等待保存超时：${saveLabel()}`);
    }
    return label;
  }

  async function execute(command) {
    switch (command.type) {
      case 'env':
        return {
          isTauri: Boolean(window.__TAURI_INTERNALS__),
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
      case 'seedLongNote':
        return seedLongNote();
      case 'gotoKnowledge':
        return gotoTab('知识', '.kn-list');
      case 'openNote':
        return openNote(command.title || TITLE);
      case 'snapshot':
        return focusState();
      case 'enterFocus':
        return enterFocus();
      case 'exitViaButton':
        return exitViaButton();
      case 'scrollByFollowing':
        return scrollByFollowing(command.index ?? 20);
      case 'toggleFollow':
        return toggleFollow();
      case 'pressEsc':
        return pressEsc();
      case 'pressShortcut':
        return pressShortcut();
      case 'typingUndoSave':
        return typingUndoSave();
      case 'waitSave':
        return waitSave(command.timeout);
      case 'readingToggle':
        return readingToggle();
      case 'errors':
        return errors.slice(-40);
      case 'reload':
        setTimeout(() => window.location.reload(), 120);
        return { reloading: true };
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
          error: String((error && error.message) || error),
        };
      }
      try {
        await post('/__result', { id: command.id, result });
      } catch {
        /* ignore */
      }
    }
  }

  void boot();
})();
