/**
 * ZX-UX-05 真实 Tauri WebView 探针。
 *
 * 通过真实产品 IPC（notes_create / note_blocks_create / note_todos_create）
 * 造一篇含 3 条待办的笔记，再走真实知识页导航打开它。
 * 只读观察 + 真实 DOM 事件；不替换产品 IPC、不注入假数据源。
 */
(function () {
  const errors = [];
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    errors.push(args.map(String).join(' '));
    originalError(...args);
  };
  window.addEventListener('error', (event) => {
    errors.push(`[window.error] ${event.message} @ ${event.filename}:${event.lineno}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    errors.push(
      `[unhandledrejection] ${
        (event.reason && (event.reason.message || event.reason)) || 'unknown'
      }`,
    );
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function visible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  }

  function center(el) {
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  async function waitFor(check, timeout = 8000, interval = 80) {
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

  async function seedTodoNote(title, todos) {
    if (!Array.isArray(todos) || todos.length !== 3) {
      throw new Error('seedTodoNote 需要恰好 3 条待办');
    }
    const note = await invoke('notes_create', {
      input: {
        id: 'zx-ux-05-note',
        title,
        body: '',
        tags: ['ZX-UX-05'],
        status: 'active',
      },
    });
    const blocks = [];
    const rows = [];
    for (let index = 0; index < todos.length; index += 1) {
      const todo = todos[index];
      const todoId = `zx-ux-05-todo-${index + 1}`;
      const block = await invoke('note_blocks_create', {
        input: {
          id: `zx-ux-05-block-${index + 1}`,
          noteId: note.id,
          blockType: 'todo',
          orderKey: (index + 1) * 1024,
          payload: {
            runs: [{ text: todo.title }],
            checked: Boolean(todo.done),
            todoId,
          },
        },
      });
      const row = await invoke('note_todos_create', {
        input: {
          id: todoId,
          noteId: note.id,
          title: todo.title,
          done: Boolean(todo.done),
          sortOrder: index + 1,
        },
      });
      blocks.push(block.id);
      rows.push(row.id);
    }
    return { noteId: note.id, blockIds: blocks, todoIds: rows };
  }

  async function gotoKnowledge(title) {
    const nav = Array.from(
      document.querySelectorAll('a.nav-link, button.nav-link'),
    ).find(
      (el) =>
        visible(el) &&
        (norm(el.querySelector('.nav-label')?.textContent) === '知识' ||
          norm(el.textContent).includes('知识')),
    );
    if (!nav) throw new Error('找不到「知识」导航入口');
    nav.click();
    const list = await waitFor(
      () => document.querySelector('.kn-list'),
      8000,
    );
    if (!list) throw new Error('知识页笔记列表未加载');
    const noteButton = await waitFor(
      () =>
        Array.from(
          document.querySelectorAll('[aria-label^="打开笔记："]'),
        ).find((el) => visible(el) && norm(el.getAttribute('aria-label')).includes(title)),
      8000,
    );
    if (!noteButton) {
      const labels = Array.from(
        document.querySelectorAll('[aria-label^="打开笔记："]'),
      ).map((el) => el.getAttribute('aria-label'));
      throw new Error(`找不到笔记「${title}」：${JSON.stringify(labels)}`);
    }
    noteButton.click();
    const ready = await waitFor(
      () =>
        document.querySelectorAll('.zxe-todo-check').length === 3 &&
        document.querySelectorAll('.zxt-summary-check').length === 3,
      10000,
    );
    if (!ready) {
      throw new Error(
        `待办复选框未就绪：inline=${document.querySelectorAll('.zxe-todo-check').length} summary=${document.querySelectorAll('.zxt-summary-check').length}`,
      );
    }
    return {
      title,
      inline: document.querySelectorAll('.zxe-todo-check').length,
      summary: document.querySelectorAll('.zxt-summary-check').length,
    };
  }

  async function trashAndReopen(title) {
    const clickText = async (text, timeout = 4000) => {
      const target = await waitFor(
        () =>
          Array.from(
            document.querySelectorAll(
              'button, [role="menuitem"], [role="button"]',
            ),
          ).find((el) => visible(el) && norm(el.textContent).includes(text)),
        timeout,
      );
      if (!target) throw new Error(`找不到按钮：${text}`);
      target.click();
      await sleep(250);
      return target;
    };

    const more = document.querySelector(
      `[aria-label="更多操作：${title}"]`,
    );
    if (!more) throw new Error(`找不到更多操作：${title}`);
    more.click();
    await clickText('删除笔记');
    const confirmed = await waitFor(
      () =>
        Array.from(document.querySelectorAll('button')).find(
          (el) => visible(el) && norm(el.textContent) === '确认删除',
        ),
      4000,
    );
    if (!confirmed) throw new Error('删除确认框未出现');
    confirmed.click();
    await waitFor(
      () =>
        !document.querySelector(`[aria-label="更多操作：${title}"]`),
      6000,
    );

    const trashEntry = document.querySelector('[aria-label="回收站"]');
    if (!trashEntry) throw new Error('找不到回收站入口');
    trashEntry.click();
    const noteButton = await waitFor(
      () =>
        Array.from(
          document.querySelectorAll('[aria-label^="打开笔记："]'),
        ).find(
          (el) =>
            visible(el) &&
            norm(el.getAttribute('aria-label')).includes(title),
        ),
      8000,
    );
    if (!noteButton) throw new Error('回收站里找不到刚删除的笔记');
    noteButton.click();
    const ready = await waitFor(
      () =>
        document.querySelectorAll('.zxe-todo-check').length === 3 &&
        document.querySelectorAll('.zxt-summary-check').length === 3 &&
        Array.from(
          document.querySelectorAll(
            '.zxe-todo-check, .zxt-summary-check',
          ),
        ).every((el) => el.disabled),
      10000,
    );
    if (!ready) throw new Error('待办复选框未进入只读/禁用状态');
    return {
      readOnly: document
        .querySelector('.zxe')
        ?.getAttribute('data-read-only'),
      disabled: Array.from(
        document.querySelectorAll(
          '.zxe-todo-check, .zxt-summary-check',
        ),
      ).map((el) => el.disabled),
    };
  }

  function parseColor(value) {
    const match = String(value || '').match(
      /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i,
    );
    if (!match) return null;
    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      a: match[4] === undefined ? 1 : Number(match[4]),
    };
  }

  function luminance(color) {
    const channels = [color.r, color.g, color.b].map((channel) => {
      const value = channel / 255;
      return value <= 0.03928
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4);
    });
    return (
      0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
    );
  }

  function contrast(foreground, background) {
    const fg = parseColor(foreground);
    const bg = parseColor(background);
    if (!fg || !bg || fg.a === 0 || bg.a === 0) return null;
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    return Number(
      ((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2),
    );
  }

  function cssRule(selector) {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules = [];
      try {
        rules = Array.from(sheet.cssRules || []);
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (rule && rule.selectorText === selector) {
          return rule.style.cssText;
        }
      }
    }
    return null;
  }

  function measureCheck(el, index) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const checked = el.getAttribute('aria-checked') === 'true';
    return {
      index,
      className: el.className,
      ariaChecked: checked,
      ariaLabel: el.getAttribute('aria-label'),
      disabled: el.disabled,
      rect: {
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2)),
        center: center(el),
      },
      border: {
        width: style.borderTopWidth,
        style: style.borderTopStyle,
        color: style.borderTopColor,
      },
      background: style.backgroundColor,
      color: style.color,
      borderRadius: style.borderTopLeftRadius,
      opacity: style.opacity,
      outline: {
        style: style.outlineStyle,
        width: style.outlineWidth,
        color: style.outlineColor,
        offset: style.outlineOffset,
      },
      glyph: norm(el.textContent),
      borderContrast: contrast(style.borderTopColor, style.backgroundColor),
      glyphContrast: contrast(style.color, style.backgroundColor),
    };
  }

  function measureAll(theme) {
    const inline = Array.from(
      document.querySelectorAll('.zxe-todo-check'),
    ).map((el, index) => measureCheck(el, index));
    const summary = Array.from(
      document.querySelectorAll('.zxt-summary-check'),
    ).map((el, index) => measureCheck(el, index));
    const surface =
      document.querySelector('.zxe')
        ? getComputedStyle(document.querySelector('.zxe')).backgroundColor
        : null;
    return {
      theme,
      dataTheme: document.documentElement.getAttribute('data-theme'),
      surface,
      inline,
      summary,
      rules: {
        base: cssRule('.zxe-todo-check'),
        baseSummary: cssRule('.zxt-summary-check'),
        hover: cssRule('.zxe-todo-check:hover:not(:disabled)'),
        hoverSummary: cssRule('.zxt-summary-check:hover:not(:disabled)'),
        focus: cssRule('.zxe-todo-check:focus'),
        focusSummary: cssRule('.zxt-summary-check:focus'),
        disabled: cssRule('.zxe-todo-check:disabled'),
        disabledSummary: cssRule('.zxt-summary-check:disabled'),
        done: cssRule('.zxe-todo.is-done .zxe-todo-check'),
        doneSummary: cssRule('.zxt-summary-row.is-done .zxt-summary-check'),
        reset: cssRule(':where(.zxe) button'),
        oldReset: cssRule('.zxe button'),
      },
    };
  }

  function focusFirstCheckbox() {
    const el = document.querySelector('.zxe-todo-check');
    if (!el) throw new Error('找不到内联待办复选框');
    el.focus();
    return {
      focused: document.activeElement === el,
      activeClass: document.activeElement?.className,
      hasFocus: document.hasFocus(),
    };
  }

  function measureFocus() {
    const active = document.activeElement;
    if (!active || !active.classList?.contains('zxe-todo-check')) {
      return {
        focused: false,
        hasFocus: document.hasFocus(),
        activeClass: active?.className ?? null,
        activeTag: active?.tagName ?? null,
      };
    }
    const surface = active.closest('.zxe')
      ? getComputedStyle(active.closest('.zxe')).backgroundColor
      : null;
    const check = measureCheck(active, 0);
    check.outline.contrast = contrast(check.outline.color, surface);
    return { focused: true, hasFocus: document.hasFocus(), surface, check };
  }

  async function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    await sleep(180);
    return measureAll(theme);
  }

  async function hover(selector, index) {
    const el = document.querySelectorAll(selector)[index];
    if (!el) throw new Error(`hover 找不到 ${selector}[${index}]`);
    const rect = el.getBoundingClientRect();
    return {
      rect: {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        center: center(el),
      },
      window: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      },
      before: measureCheck(el, index),
    };
  }

  async function afterHover(selector, index) {
    const el = document.querySelectorAll(selector)[index];
    if (!el) throw new Error(`afterHover 找不到 ${selector}[${index}]`);
    return measureCheck(el, index);
  }

  function windowInfo() {
    return {
      url: location.href,
      isTauri: '__TAURI_INTERNALS__' in window,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dataTheme: document.documentElement.getAttribute('data-theme'),
      bodyText: norm(document.body.innerText).slice(0, 300),
      errors: errors.slice(-30),
    };
  }

  async function execute(command) {
    switch (command.type) {
      case 'env':
        return windowInfo();
      case 'clickText': {
        const nodes = Array.from(
          document.querySelectorAll('button, a, [role="button"], [role="link"]'),
        ).filter(visible);
        const target =
          nodes.find((el) => norm(el.textContent) === command.text) ||
          nodes.find((el) => norm(el.textContent).includes(command.text));
        if (!target) throw new Error(`找不到可点击元素：${command.text}`);
        target.click();
        await sleep(command.wait ?? 500);
        return windowInfo();
      }
      case 'seedTodoNote':
        return seedTodoNote(command.title, command.todos);
      case 'gotoKnowledge':
        return gotoKnowledge(command.title);
      case 'trashAndReopen':
        return trashAndReopen(command.title);
      case 'measure':
        return measureAll(command.theme ?? document.documentElement.getAttribute('data-theme'));
      case 'focusFirstCheckbox':
        return focusFirstCheckbox();
      case 'measureFocus':
        return measureFocus();
      case 'setTheme':
        return setTheme(command.theme);
      case 'hover':
        return hover(command.selector, command.index ?? 0);
      case 'afterHover':
        return afterHover(command.selector, command.index ?? 0);
      case 'sleep':
        await sleep(command.ms ?? 300);
        return true;
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
