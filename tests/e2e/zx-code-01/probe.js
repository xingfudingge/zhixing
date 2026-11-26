/**
 * ZX-CODE-01 真实 Tauri WebView 探针：代码块语言选择 / 高亮 / 复制 / 导出。
 *
 * 只通过真实产品 IPC 造数据、只派发真实 DOM 事件：
 *   * 下拉 25 项、选择 TypeScript、手输未知语言 `zx-dsl`、别名 `ts` 归一化；
 *   * Tab / Enter 编辑缩进；
 *   * 换行 / 行号开关写回 payload；
 *   * 阅读模式只读高亮 + 复制原始代码 + 反馈；
 *   * notes.body 缓存与真实「导出 Markdown」围栏一致；
 *   * 收集 console.error / window.error / unhandledrejection。
 */
(function () {
  const ERROR_KEY = 'zx-code-01-errors';
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

  const NOTE_ID = 'zx-code-01-note';
  const NOTE_TITLE = '代码手测';
  const BLOCK_ID = 'zx-code-01-block';

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
      if (!String(note.id).startsWith('zx-code-01-')) {
        await invoke('notes_delete', { id: note.id });
      }
    }
    try {
      await invoke('notes_delete', { id: NOTE_ID });
    } catch {
      /* not created yet */
    }

    await invoke('notes_create', {
      input: {
        id: NOTE_ID,
        title: NOTE_TITLE,
        body: '<p>代码手测正文。</p>',
        tags: ['ZX-CODE-01'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: BLOCK_ID,
        noteId: NOTE_ID,
        blockType: 'code',
        orderKey: 1024,
        payload: {
          code: 'const answer: number = 42;\nconsole.log(answer);',
          language: '',
          wrap: true,
          lineNumbers: true,
        },
      },
    });

    return {
      noteId: NOTE_ID,
      title: NOTE_TITLE,
      blocks: 1,
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

  function codeEl() {
    return document.querySelector('.zxe-code');
  }

  function codeButton(label) {
    const code = codeEl();
    if (!code) return null;
    return Array.from(code.querySelectorAll('button')).find(
      (button) =>
        visible(button) &&
        (norm(button.getAttribute('aria-label')) === label ||
          norm(button.textContent) === label),
    );
  }

  function railButton(label) {
    return Array.from(document.querySelectorAll('button')).find(
      (button) =>
        visible(button) && norm(button.getAttribute('aria-label')) === label,
    );
  }

  function anyButton(label) {
    return Array.from(document.querySelectorAll('button')).find(
      (button) =>
        visible(button) &&
        (norm(button.getAttribute('aria-label')) === label ||
          norm(button.textContent) === label),
    );
  }

  async function clickButton(command) {
    const button = anyButton(command.label);
    if (!button) throw new Error(`找不到按钮「${command.label}」`);
    if (button.disabled) {
      throw new Error(`按钮「${command.label}」被禁用`);
    }
    button.click();
    await sleep(command.wait ?? 260);
    return snapshot();
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
    const code = await waitFor(() => codeEl(), 10_000);
    if (!code) throw new Error(`笔记「${title}」代码块未渲染`);
    return title;
  }

  function tokenInfo(host) {
    if (!host) return { count: 0, classes: [] };
    const tokens = Array.from(host.querySelectorAll('span[class*="hljs-"]'));
    return {
      count: tokens.length,
      classes: Array.from(
        new Set(
          tokens.map(
            (token) =>
              Array.from(token.classList)
                .find((name) => name.startsWith('hljs-')) || '',
          ),
        ),
      ).filter(Boolean),
    };
  }

  function snapshot() {
    const code = codeEl();
    if (!code) {
      return { exists: false };
    }
    const language = code.querySelector('input[aria-label="代码语言"]');
    const textarea = code.querySelector('textarea[aria-label="代码内容"]');
    const pre = code.querySelector('.zxe-code-pre');
    const highlight = code.querySelector('.zxe-code-highlight');
    const badge = code.querySelector('.zxe-code-lang-badge');
    const copyStatus = code.querySelector('.zxe-code-copy-status');
    const menu = code.querySelector('.zxe-code-lang-menu');
    const codeText = textarea ? textarea.value : (pre?.textContent ?? '');
    const visibleTokens = tokenInfo(textarea ? highlight : pre);
    const wrapButton = codeButton('换行');
    const lineButton = codeButton('行号');
    const copyButton =
      codeButton('复制') || codeButton('已复制') || codeButton('复制失败');
    return {
      exists: true,
      readOnly: !textarea,
      language: language ? language.value : null,
      badge: norm(badge?.textContent),
      badgeTitle: norm(badge?.title),
      code: codeText,
      preText: pre ? pre.textContent : null,
      tokenCount: visibleTokens.count,
      tokenClasses: visibleTokens.classes,
      menuOptions: menu
        ? Array.from(menu.querySelectorAll('[role="option"]')).map((option) =>
            norm(option.textContent),
          )
        : [],
      wrapPressed: wrapButton
        ? wrapButton.getAttribute('aria-pressed')
        : null,
      lineNumbersPressed: lineButton
        ? lineButton.getAttribute('aria-pressed')
        : null,
      gutter: code.querySelectorAll('.zxe-code-gutter span').length,
      copyLabel: copyButton ? norm(copyButton.textContent) : null,
      copyStatus: norm(copyStatus?.textContent),
      fontFamily: getComputedStyle(textarea || pre)?.fontFamily || '',
      dataLanguage: code.getAttribute('data-language'),
      errors: errors.slice(),
    };
  }

  async function setNativeValue(element, value, prototype) {
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function openLanguageMenu() {
    if (!codeEl()?.querySelector('.zxe-code-lang-menu')) {
      const toggle = codeButton('选择代码语言');
      if (!toggle) throw new Error('找不到语言下拉按钮');
      toggle.click();
    }
    await waitFor(() => codeEl()?.querySelector('.zxe-code-lang-menu'), 3000);
    return snapshot();
  }

  async function setLanguage(command) {
    const code = codeEl();
    const input = code?.querySelector('input[aria-label="代码语言"]');
    if (!input) throw new Error('找不到代码语言输入框');
    if (command.option) {
      await openLanguageMenu();
      const option = await waitFor(
        () =>
          Array.from(
            code.querySelectorAll('.zxe-code-lang-menu [role="option"]'),
          ).find((item) => norm(item.textContent).includes(command.option)),
        3000,
      );
      if (!option) throw new Error(`找不到语言选项「${command.option}」`);
      option.click();
    } else {
      input.focus();
      await setNativeValue(input, command.value ?? '', HTMLInputElement.prototype);
      await sleep(120);
      input.blur();
    }
    await sleep(command.wait ?? 420);
    return snapshot();
  }

  async function setCode(command) {
    const textarea = codeEl()?.querySelector(
      'textarea[aria-label="代码内容"]',
    );
    if (!textarea) throw new Error('编辑态没有代码输入框');
    textarea.focus();
    await setNativeValue(
      textarea,
      command.value ?? '',
      HTMLTextAreaElement.prototype,
    );
    await sleep(command.wait ?? 200);
    return snapshot();
  }

  async function pressKey(command) {
    const textarea = codeEl()?.querySelector(
      'textarea[aria-label="代码内容"]',
    );
    if (!textarea) throw new Error('编辑态没有代码输入框');
    textarea.focus();
    const position = command.position ?? textarea.value.length;
    textarea.setSelectionRange(position, position);
    const keyEvent = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: command.key,
      shiftKey: Boolean(command.shift),
    });
    textarea.dispatchEvent(keyEvent);
    await sleep(command.wait ?? 220);
    return snapshot();
  }

  async function clickCodeButton(command) {
    const button = codeButton(command.label);
    if (!button) throw new Error(`找不到代码块按钮「${command.label}」`);
    button.click();
    await sleep(command.wait ?? 300);
    return snapshot();
  }

  async function copyCode() {
    let captured = null;
    let method = 'clipboard';
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            captured = text;
          },
        },
      });
    } catch {
      method = 'execCommand';
    }
    if (method === 'execCommand') {
      document.execCommand = (name) => {
        if (name === 'copy') {
          const active = document.activeElement;
          captured =
            active && 'value' in active ? String(active.value) : null;
        }
        return true;
      };
    }
    const button = codeButton('复制');
    if (!button) throw new Error('找不到复制按钮');
    button.click();
    await waitFor(() => captured !== null, 3000);
    await sleep(120);
    return {
      method,
      captured,
      snapshot: snapshot(),
    };
  }

  async function setTheme(command) {
    const root = document.documentElement;
    const before = root.getAttribute('data-theme');
    root.setAttribute('data-theme', command.theme);
    await sleep(160);
    const code = codeEl();
    const host = code?.querySelector('.zxe-code-highlight code, .zxe-code-pre code');
    const token = code?.querySelector(
      '.hljs-keyword, .hljs-string, .hljs-number, .hljs-title, .hljs-built_in',
    );
    const hostStyle = host ? getComputedStyle(host) : null;
    const tokenStyle = token ? getComputedStyle(token) : null;
    const result = {
      theme: command.theme,
      background: getComputedStyle(code).backgroundColor,
      text: hostStyle ? hostStyle.color : null,
      token: tokenStyle ? tokenStyle.color : null,
      tokenText: token ? token.textContent : null,
      badge: norm(code?.querySelector('.zxe-code-lang-badge')?.textContent),
      menuBackground: code?.querySelector('.zxe-code-lang-menu')
        ? getComputedStyle(code.querySelector('.zxe-code-lang-menu'))
            .backgroundColor
        : null,
    };
    if (before) {
      root.setAttribute('data-theme', before);
    } else {
      root.removeAttribute('data-theme');
    }
    await sleep(120);
    return result;
  }

  async function toggleReadingMode() {
    const button =
      railButton('进入阅读模式') || railButton('进入编辑模式');
    if (!button) throw new Error('找不到阅读/编辑模式按钮');
    button.click();
    await sleep(500);
    return snapshot();
  }

  async function exportMarkdown() {
    if (!document.querySelector('.kn-info[aria-label="笔记信息"]')) {
      const info = railButton('笔记信息');
      if (!info) throw new Error('找不到笔记信息按钮');
      info.click();
      const panel = await waitFor(
        () => document.querySelector('.kn-info[aria-label="笔记信息"]'),
        4000,
      );
      if (!panel) throw new Error('笔记信息面板未打开');
    }
    const exportButton = Array.from(
      document.querySelectorAll('.kn-info[aria-label="笔记信息"] button'),
    ).find((button) => norm(button.textContent) === '导出 Markdown');
    if (!exportButton) throw new Error('找不到「导出 Markdown」按钮');

    let captured = null;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob) => {
      Promise.resolve(blob.text()).then((text) => {
        captured = text;
      });
      return 'blob:zx-code-01';
    };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function noop() {};
    try {
      exportButton.click();
      await waitFor(() => captured !== null, 4000);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      HTMLAnchorElement.prototype.click = originalClick;
    }
    if (captured === null) throw new Error('没有捕获到导出的 Markdown');
    return captured;
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
    code: snapshot,
    click: clickButton,
    openLanguageMenu,
    setLanguage,
    setCode,
    pressKey,
    clickCodeButton,
    copyCode,
    setTheme,
    toggleReadingMode,
    exportMarkdown,
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
