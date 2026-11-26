/**
 * ZX-FORMULA-01 真实 Tauri WebView 探针：KaTeX 公式渲染。
 *
 * 只通过真实产品 IPC 造数据、只派发真实 DOM 事件：
 *   * 块级 / 行内切换与 .katex-display 断言；
 *   * 语法错误、上一版有效预览、修正后恢复；
 *   * 模板插入、缩放、复制与 LaTeX/Markdown/HTML 导出；
 *   * 明暗主题下的计算颜色；
 *   * trust:false 下不产生 javascript: 链接；
 *   * 读回真实 SQLite payload 与 notes.body 兼容缓存；
 *   * 收集 console.error / window.error / unhandledrejection。
 */
(function () {
  const ERROR_KEY = 'zx-formula-01-errors';
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

  const NOTE_ID = 'zx-formula-01-note';
  const NOTE_TITLE = '公式手测';
  const BLOCK_ID = 'zx-formula-01-block';

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
      if (!String(note.id).startsWith('zx-formula-01-')) {
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
        body: '<p>公式手测正文。</p>',
        tags: ['ZX-FORMULA-01'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: BLOCK_ID,
        noteId: NOTE_ID,
        blockType: 'formula',
        orderKey: 1024,
        payload: {
          latex: '\\int_{a}^{b} f(x)\\,\\mathrm{d}x',
          display: 'block',
          renderer: 'katex',
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
    const formula = await waitFor(() => formulaEl(), 10_000);
    if (!formula) throw new Error(`笔记「${title}」公式未渲染`);
    return title;
  }

  function formulaEl() {
    return document.querySelector('.zxe-formula');
  }

  function buttonFor(label) {
    return Array.from(document.querySelectorAll('button')).find(
      (button) =>
        visible(button) &&
        (norm(button.getAttribute('aria-label')) === label ||
          norm(button.textContent) === label),
    );
  }

  /**
   * ZX6-PROPS-01：公式属性条默认隐藏，hover 后才出现。探针通过真实
   * mouseover 进入公式块，再读取模式/编辑/更多入口。
   */
  async function revealFormulaProps() {
    const root = formulaEl();
    if (!root) return;
    root.dispatchEvent(
      new MouseEvent('mouseover', {
        bubbles: true,
        relatedTarget: document.body,
      }),
    );
    await sleep(60);
  }

  async function snapshot() {
    await revealFormulaProps();
    const root = formulaEl();
    if (!root) {
      return { exists: false };
    }
    const preview = root.querySelector('.zxe-formula-preview');
    const katex = root.querySelector('.katex');
    const error = root.querySelector('.zxe-formula-error');
    const source = root.querySelector('.zxe-formula-input');
    const previewStyle = preview ? getComputedStyle(preview) : null;
    const katexStyle = katex ? getComputedStyle(katex) : null;
    const mode = root.querySelector('[data-formula="mode"]');
    const edit = root.querySelector('[data-formula="edit"]');
    const template = root.querySelector('button[aria-label="公式模板"]');
    const previewText = norm(preview?.textContent).slice(0, 240);
    return {
      exists: true,
      state: root.dataset.state,
      renderError: root.dataset.renderError,
      display: root.dataset.display,
      zoom: root.dataset.zoom ? `${root.dataset.zoom}%` : null,
      katexCount: root.querySelectorAll('.katex').length,
      displayCount: root.querySelectorAll('.katex-display').length,
      mathmlCount: root.querySelectorAll('math').length,
      annotationCount: root.querySelectorAll('annotation').length,
      status: norm(root.querySelector('[data-formula-state]')?.textContent),
      previewText,
      emptyText: norm(root.querySelector('.zxe-formula-empty')?.textContent),
      errorText: norm(error?.textContent).slice(0, 400),
      hasErrorPanel: Boolean(error),
      hasFooter: Boolean(root.querySelector('.zxe-formula-foot')),
      hasSource: Boolean(source),
      hasEditButton: Boolean(edit),
      hasTemplateButton: Boolean(template),
      source: source ? source.value : null,
      sourceInText: previewText.includes('\\frac') || previewText.includes('\\int'),
      modeLabel: mode ? norm(mode.textContent) : null,
      fontSize: previewStyle?.fontSize ?? null,
      color: previewStyle?.color ?? null,
      katexColor: katexStyle?.color ?? null,
      linkCount: root.querySelectorAll('a').length,
      hrefs: Array.from(root.querySelectorAll('a')).map((a) =>
        a.getAttribute('href'),
      ),
      templateLabels: Array.from(
        document.querySelectorAll('.zxe-overflow-menu button'),
      ).map((button) => norm(button.textContent)),
    };
  }

  async function openMore() {
    const trigger = buttonFor('更多公式选项');
    if (!trigger) throw new Error('找不到「更多公式选项」按钮');
    trigger.click();
    await sleep(220);
    return snapshot();
  }

  async function enterEdit() {
    const edit = buttonFor('编辑公式');
    if (edit) {
      edit.click();
      await sleep(220);
    }
    return snapshot();
  }

  async function setLatex(command) {
    let root = formulaEl();
    let input = root?.querySelector('.zxe-formula-input');
    if (!input) {
      const edit = buttonFor('编辑公式');
      if (!edit) {
        const add = buttonFor('点击添加公式');
        if (!add) throw new Error('找不到「编辑公式」入口');
        add.click();
      } else {
        edit.click();
      }
      await sleep(180);
      root = formulaEl();
      input = root?.querySelector('.zxe-formula-input');
    }
    if (!input) throw new Error('找不到 LaTeX 源输入框');
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    ).set;
    setter.call(input, command.value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(command.wait ?? 360);
    return snapshot();
  }

  async function clickButton(command) {
    let button = buttonFor(command.label);
    if (!button && command.viaMenu !== false) {
      const more = buttonFor('更多公式选项');
      if (more) {
        more.click();
        await sleep(200);
        button = buttonFor(command.label);
      }
    }
    if (!button && command.template) {
      const template = buttonFor('公式模板');
      if (template) {
        template.click();
        await sleep(200);
        button = buttonFor(command.label);
      }
    }
    if (!button) throw new Error(`找不到按钮「${command.label}」`);
    if (button.disabled) {
      throw new Error(`按钮「${command.label}」被禁用`);
    }
    button.click();
    await sleep(command.wait ?? 260);
    return snapshot();
  }

  async function exportTab(command) {
    let dialog = document.querySelector('[role="dialog"]');
    if (!dialog) {
      let button = buttonFor('导出');
      if (!button) {
        const more = buttonFor('更多公式选项');
        if (more) {
          more.click();
          await sleep(220);
          button = buttonFor('导出');
        }
      }
      if (!button) throw new Error('找不到「导出」按钮');
      button.click();
      dialog = await waitFor(
        () => document.querySelector('[role="dialog"]'),
        4000,
      );
    }
    if (!dialog) throw new Error('导出弹窗未打开');
    const tab = Array.from(dialog.querySelectorAll('[role="tab"]')).find(
      (item) => norm(item.textContent) === command.tab,
    );
    if (!tab) throw new Error(`找不到导出 tab「${command.tab}」`);
    tab.click();
    await sleep(120);
    const pre = dialog.querySelector('[data-fepre]');
    return {
      tab: command.tab,
      text: pre ? pre.textContent : '',
      tabs: Array.from(dialog.querySelectorAll('[role="tab"]')).map((item) =>
        norm(item.textContent),
      ),
    };
  }

  async function closeExport() {
    const dialog = document.querySelector('[role="dialog"]');
    const close = dialog?.querySelector('.zx-modal-close');
    if (close) close.click();
    await sleep(160);
    return true;
  }

  async function theme(command) {
    document.documentElement.dataset.theme = command.name;
    await sleep(160);
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
    async click(command) {
      const button = buttonFor(command.label);
      if (!button) throw new Error(`找不到按钮「${command.label}」`);
      button.click();
      await sleep(command.wait ?? 400);
      return true;
    },
    seed,
    gotoKnowledge,
    async openNote(command) {
      return openNote(command.title || NOTE_TITLE);
    },
    formula: snapshot,
    setLatex,
    clickFormula: clickButton,
    exportTab,
    closeExport,
    theme,
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
