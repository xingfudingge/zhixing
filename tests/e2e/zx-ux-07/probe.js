/**
 * ZX-UX-07 真实 Tauri WebView 探针。
 *
 * 只通过真实产品 IPC 造数据、只派发真实 DOM 事件：
 * - 内链：划词 → 格式条「链接」→「笔记内链」→ 搜索选择目标笔记；
 * - 点击内链打开目标笔记，目标的反向链接出现来源；
 * - 删除目标后再点内链，出现“笔记不存在或已删除”；
 * - ⌘K 搜索正文词，回车后定位并高亮首个命中块，1.4s 后褪去；
 * - 脏 find 参数没有命中时提示“未找到匹配位置”。
 */
(function () {
  const errors = [];
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    errors.push(args.map(String).join(' '));
    originalError(...args);
  };
  window.addEventListener('error', (event) => {
    errors.push(
      `[window.error] ${event.message} @ ${event.filename}:${event.lineno}`,
    );
  });
  window.addEventListener('unhandledrejection', (event) => {
    errors.push(
      `[unhandledrejection] ${
        (event.reason && (event.reason.message || event.reason)) || 'unknown'
      }`,
    );
  });

  const NOTE_A = 'zx-ux-07-note-a';
  const NOTE_B = 'zx-ux-07-note-b';
  const NOTE_C = 'zx-ux-07-note-c';
  const TITLE_A = 'ZX-UX-07 来源笔记';
  const TITLE_B = 'ZX-UX-07 目标笔记';
  const TITLE_C = 'ZX-UX-07 搜索定位';
  const LINK_TEXT = '去看目标笔记';
  const SEARCH_PHRASE = '响应式布局要点';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function visible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  }

  async function waitFor(check, timeout = 10_000, interval = 80) {
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

  function setNativeValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    );
    descriptor.set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function selectText(element, start, end) {
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null,
    );
    const node = walker.nextNode();
    if (!node) throw new Error('目标块没有文本节点');
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    document.dispatchEvent(new Event('selectionchange'));
    return norm(selection.toString());
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
          (el) => visible(el) && norm(el.getAttribute('aria-label')).includes(title),
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
      () => document.querySelectorAll('.zxe-inline[data-inline-editor="true"]').length > 0,
      10_000,
    );
    return title;
  }

  async function seedNotes() {
    const a = await invoke('notes_create', {
      input: {
        id: NOTE_A,
        title: TITLE_A,
        body: `<p>${LINK_TEXT}</p>`,
        tags: ['ZX-UX-07'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'zx-ux-07-a-1',
        noteId: a.id,
        blockType: 'paragraph',
        orderKey: 1024,
        payload: { runs: [{ text: LINK_TEXT }] },
      },
    });

    const b = await invoke('notes_create', {
      input: {
        id: NOTE_B,
        title: TITLE_B,
        body: '<p>目标正文</p>',
        tags: ['ZX-UX-07'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'zx-ux-07-b-1',
        noteId: b.id,
        blockType: 'paragraph',
        orderKey: 1024,
        payload: { runs: [{ text: '目标正文' }] },
      },
    });

    const c = await invoke('notes_create', {
      input: {
        id: NOTE_C,
        title: TITLE_C,
        body: '<p>开头</p><p>响应式布局要点</p>',
        tags: ['ZX-UX-07'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'zx-ux-07-c-1',
        noteId: c.id,
        blockType: 'paragraph',
        orderKey: 1024,
        payload: { runs: [{ text: '开头' }] },
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'zx-ux-07-c-2',
        noteId: c.id,
        blockType: 'paragraph',
        orderKey: 2048,
        payload: { runs: [{ text: SEARCH_PHRASE }] },
      },
    });

    return { a: a.id, b: b.id, c: c.id };
  }

  async function insertInternalLink() {
    const inline = await waitFor(
      () =>
        Array.from(
          document.querySelectorAll('.zxe-inline[data-inline-editor="true"]'),
        ).find((el) => norm(el.textContent).includes(LINK_TEXT)),
      10_000,
    );
    if (!inline) throw new Error('找不到来源段落');

    const selected = selectText(inline, 0, 4);
    const bar = await waitFor(
      () => document.querySelector('.zxe-formatbar'),
      6000,
    );
    if (!bar) throw new Error('划词后格式条未出现');
    const linkButton = bar.querySelector('button[aria-label="链接"]');
    if (!linkButton) throw new Error('格式条缺少链接按钮');
    linkButton.click();

    const dialog = await waitFor(
      () =>
        document.querySelector('[role="dialog"][aria-label="插入链接"]'),
      6000,
    );
    if (!dialog) throw new Error('插入链接弹层未出现');
    const noteTab = clickButtonByText('笔记内链', dialog);
    if (!noteTab) throw new Error('缺少「笔记内链」类型');
    noteTab.click();
    const search = await waitFor(
      () => dialog.querySelector('input[aria-label="搜索笔记"]'),
      4000,
    );
    if (!search) throw new Error('缺少笔记搜索输入框');
    setNativeValue(search, '目标');
    const option = await waitFor(
      () => clickButtonByText('目标笔记', dialog),
      6000,
    );
    if (!option) throw new Error('笔记选择器没有目标笔记');
    option.click();

    const anchor = await waitFor(
      () =>
        document.querySelector(
          `.zxe-inline a[href="zhixing://note/${NOTE_B}"]`,
        ),
      10_000,
    );
    if (!anchor) throw new Error('正文没有生成站内内链');
    const saved = await (async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const row = await invoke('notes_get', { id: NOTE_A });
        if (String(row.body || '').includes(`zhixing://note/${NOTE_B}`)) {
          return row;
        }
        await sleep(200);
      }
      return null;
    })();
    if (!saved) throw new Error('内链未写回 notes.body');

    const blocks = await invoke('note_blocks_list', { noteId: NOTE_A });
    const linkedRun = blocks
      .flatMap((block) =>
        Array.isArray(block.payload?.runs) ? block.payload.runs : [],
      )
      .find((run) => run?.marks?.link === `zhixing://note/${NOTE_B}`);

    return {
      selected,
      anchorText: norm(anchor.textContent),
      href: anchor.getAttribute('href'),
      bodyHasLink: true,
      runHasLink: Boolean(linkedRun),
      formatBar: true,
      noteTab: true,
      noteSearch: true,
    };
  }

  async function openInternalLink() {
    const anchor = await waitFor(
      () =>
        document.querySelector(
          `.zxe-inline a[href="zhixing://note/${NOTE_B}"]`,
        ),
      6000,
    );
    if (!anchor) throw new Error('找不到正文内链');
    anchor.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        metaKey: true,
      }),
    );
    const title = await waitFor(
      () => {
        const input = document.querySelector('input[aria-label="笔记标题"]');
        return input && input.value === TITLE_B ? input.value : null;
      },
      10_000,
    );
    if (!title) throw new Error('Cmd+点击内链没有打开目标笔记');
    return {
      activeTitle: title,
      href: location.pathname + location.search,
      bodyText: norm(document.querySelector('.zxe')?.textContent).slice(0, 80),
    };
  }

  async function openLinksPanel(expectTitle) {
    const rail = await waitFor(
      () => document.querySelector('button[aria-label="笔记链接"]'),
      6000,
    );
    if (!rail) throw new Error('找不到「笔记链接」工具');
    rail.click();
    const panel = await waitFor(
      () => document.querySelector('aside[aria-label="笔记链接"]'),
      6000,
    );
    if (!panel) throw new Error('笔记链接面板未打开');
    const found = await waitFor(
      () =>
        Array.from(panel.querySelectorAll('button')).find((el) =>
          norm(el.textContent).includes(expectTitle),
        ),
      6000,
    );
    if (!found) throw new Error(`反向链接没有出现「${expectTitle}」`);
    return {
      backlinkText: norm(found.textContent),
      panelText: norm(panel.textContent).slice(0, 160),
    };
  }

  async function deleteNoteThroughUi(title) {
    const more = await waitFor(
      () => document.querySelector(`button[aria-label="更多操作：${title}"]`),
      6000,
    );
    if (!more) throw new Error(`找不到「更多操作：${title}」`);
    more.click();
    const remove = await waitFor(() => clickButtonByText('删除笔记'), 4000);
    if (!remove) throw new Error('右键菜单没有「删除笔记」');
    remove.click();
    const confirm = await waitFor(() => clickButtonByText('确认删除'), 4000);
    if (!confirm) throw new Error('删除确认框未出现');
    confirm.click();
    await waitFor(
      () => !document.querySelector(`button[aria-label="更多操作：${title}"]`),
      8000,
    );
    return true;
  }

  async function clickInternalLinkAgain() {
    const anchor = await waitFor(
      () =>
        document.querySelector(
          `.zxe-inline a[href="zhixing://note/${NOTE_B}"]`,
        ),
      10_000,
    );
    if (!anchor) throw new Error('返回来源笔记后找不到内链');
    const before = Array.from(
      document.querySelectorAll('[role="status"], .kn-toast'),
    ).map((el) => norm(el.textContent));
    anchor.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        metaKey: true,
      }),
    );
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const toasts = Array.from(
        document.querySelectorAll('[role="status"], .kn-toast'),
      ).map((el) => norm(el.textContent));
      const toast = toasts.find((text) => text.includes('笔记不存在或已删除'));
      if (toast) {
        return { toast, href: location.pathname + location.search };
      }
      await sleep(120);
    }
    return {
      toast: null,
      before,
      bodyText: norm(document.body.textContent).slice(0, 400),
      activeTitle: document.querySelector('input[aria-label="笔记标题"]')?.value,
      listLabels: Array.from(
        document.querySelectorAll('[aria-label^="打开笔记："]'),
      ).map((el) => el.getAttribute('aria-label')),
      anchorHtml: anchor.outerHTML,
      href: location.pathname + location.search,
    };
  }

  async function searchLocate() {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    const input = await waitFor(
      () => document.querySelector('input.search-bar-input'),
      8000,
    );
    if (!input) throw new Error('⌘K 没有打开搜索面板');
    setNativeValue(input, '响应式');
    const option = await waitFor(
      () =>
        Array.from(document.querySelectorAll('.search-result')).find((el) =>
          norm(el.textContent).includes(TITLE_C),
        ),
      10_000,
    );
    if (!option) throw new Error('搜索没有返回目标笔记');
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
    const hit = await waitFor(
      () => document.querySelector('.zxe-row.is-search-hit'),
      10_000,
    );
    if (!hit) throw new Error('回车后没有定位/高亮命中块');
    const rect = hit.getBoundingClientRect();
    const animation = getComputedStyle(hit);
    const state = {
      href: location.pathname + location.search,
      blockId: hit.getAttribute('data-block-id'),
      text: norm(hit.textContent),
      animationName: animation.animationName,
      inViewport: rect.bottom > 0 && rect.top < window.innerHeight,
      background: animation.backgroundColor,
    };
    await sleep(1800);
    return {
      ...state,
      highlightCleared: !document.querySelector('.zxe-row.is-search-hit'),
    };
  }

  async function dirtyFind() {
    history.pushState(
      {},
      '',
      `/knowledge?note=${NOTE_C}&find=${encodeURIComponent('不存在的词')}`,
    );
    window.dispatchEvent(new PopStateEvent('popstate'));
    const toast = await waitFor(
      () =>
        Array.from(document.querySelectorAll('[role="status"], .kn-toast'))
          .map((el) => norm(el.textContent))
          .find((text) => text.includes('未找到匹配位置')),
      8000,
    );
    if (!toast) {
      throw new Error(
        `脏 find 没有提示；url=${location.search} body=${norm(document.body.textContent).slice(0, 200)}`,
      );
    }
    return { toast, href: location.pathname + location.search };
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
      case 'seedNotes':
        return seedNotes();
      case 'gotoKnowledge':
        return gotoTab('知识', '.kn-list');
      case 'openNote':
        return openNote(command.title);
      case 'insertInternalLink':
        return insertInternalLink();
      case 'openInternalLink':
        return openInternalLink();
      case 'openLinksPanel':
        return openLinksPanel(command.expectTitle);
      case 'deleteNote':
        return deleteNoteThroughUi(command.title);
      case 'clickInternalLinkAgain':
        return clickInternalLinkAgain();
      case 'searchLocate':
        return searchLocate();
      case 'dirtyFind':
        return dirtyFind();
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
