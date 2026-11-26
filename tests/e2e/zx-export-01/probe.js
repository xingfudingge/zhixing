/**
 * ZX-EXPORT-01 真实 Tauri WebView 探针：单篇笔记导出 Word/PDF/Markdown。
 *
 * 约束：
 * - 只通过真实产品 IPC 造数据、只派发真实 DOM 事件；
 * - 不替换产品 IPC，仅把 `save_attachment_file`（原生保存面板）替换为
 *   同一个 Rust 导出写入命令 `save_export_file`，以便无头环境拿到真实落盘
 *   路径；导出生成、命名、反馈、成功面板全部走产品代码；
 * - 收集 console.error / window.error / unhandledrejection。
 */
(function () {
  const ERROR_KEY = 'zx-export-01-errors';
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

  const NOTE_ID = 'zx-export-01-note';
  const NOTE_TITLE = '导出功能手测';
  const PREFIX = 'zx-export-01-';

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

  const originalInvoke = (() => {
    const fn =
      window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (typeof fn !== 'function') {
      throw new Error('真实 Tauri IPC 不可用');
    }
    return fn.bind(window.__TAURI_INTERNALS__);
  })();

  function invoke(command, args) {
    return originalInvoke(command, args);
  }

  function block(id, type, orderKey, payload) {
    return {
      id,
      noteId: NOTE_ID,
      blockType: type,
      orderKey,
      payload,
    };
  }

  async function seed() {
    try {
      sessionStorage.removeItem(ERROR_KEY);
    } catch {
      /* ignore */
    }
    errors = [];
    window.__zxExport = null;
    window.__zxExportError = null;
    const existing = await invoke('notes_list', {
      query: { includeDeleted: true },
    });
    for (const note of existing) {
      if (String(note.id).startsWith(PREFIX) && String(note.id) !== NOTE_ID) {
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
        body: '<p>导出功能手测正文。</p>',
        tags: ['ZX-EXPORT-01', '导出'],
        status: 'active',
      },
    });

    const blocks = [
      block('zx-export-01-b01', 'heading1', 1024, {
        runs: [{ text: '导出结构' }],
      }),
      block('zx-export-01-b02', 'paragraph', 2048, {
        runs: [
          { text: '重点', marks: { bold: true, color: '#FF403C' } },
          { text: ' 与 ' },
          {
            text: '外链',
            marks: { link: 'https://example.com/doc' },
          },
          { text: ' 与 ' },
          {
            text: '关联笔记',
            marks: { link: 'zhixing://note/zx-export-01-target' },
          },
        ],
      }),
      block('zx-export-01-b03', 'todo', 3072, {
        runs: [{ text: '勾选待办' }],
        checked: true,
      }),
      block('zx-export-01-b04', 'bullet_list', 4096, {
        runs: [{ text: '无序项' }],
      }),
      block('zx-export-01-b05', 'ordered_list', 5120, {
        runs: [{ text: '第一步' }],
      }),
      block('zx-export-01-b06', 'ordered_list', 6144, {
        runs: [{ text: '第二步' }],
      }),
      block('zx-export-01-b07', 'quote', 7168, {
        runs: [{ text: '引用一段原则' }],
        source: '设计规范',
      }),
      block('zx-export-01-b08', 'code', 8192, {
        code: 'const save = await saveFile({ name });',
        language: 'typescript',
      }),
      block('zx-export-01-b09', 'table', 9216, {
        rows: [
          ['模块', '交付物'],
          ['附件', '打开 / 另存为'],
          ['导出', 'Word / PDF / Markdown'],
        ],
        header: true,
      }),
      block('zx-export-01-b10', 'file', 10240, {
        attachmentId: null,
        fileName: '需求说明.pdf',
        byteSize: 1258291,
        mime: 'application/pdf',
        status: 'local',
      }),
      block('zx-export-01-b11', 'formula', 11264, {
        latex: 'E = mc^2',
        display: 'block',
      }),
      block('zx-export-01-b12', 'link', 12288, {
        url: 'https://example.com/',
        title: '示例站点',
      }),
      block('zx-export-01-b13', 'board', 13312, {
        boardId: null,
        title: '发布流程',
      }),
      block('zx-export-01-b14', 'divider', 14336, {}),
    ];
    for (const item of blocks) {
      await invoke('note_blocks_create', { input: item });
    }
    return { noteId: NOTE_ID, title: NOTE_TITLE, blocks: blocks.length };
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
    await waitFor(() => document.querySelector('.zxe-body'), 8000);
    await sleep(500);
    return title;
  }

  function dialog() {
    return Array.from(document.querySelectorAll('[role="dialog"]')).find(
      visible,
    );
  }

  async function openExportDialog() {
    let target = dialog();
    if (target) return target;
    const trigger = await waitFor(
      () =>
        Array.from(document.querySelectorAll('button')).find(
          (button) =>
            visible(button) &&
            norm(button.getAttribute('aria-label')) === '导出笔记',
        ),
      6000,
    );
    if (!trigger) throw new Error('找不到标题区「导出笔记」入口');
    trigger.click();
    target = await waitFor(() => dialog(), 5000);
    if (!target) throw new Error('导出面板未打开');
    return target;
  }

  function formatMatch(format) {
    return format === 'docx'
      ? 'Word 文档'
      : format === 'pdf'
        ? 'PDF'
        : 'Markdown';
  }

  async function exportFormat(command) {
    window.__zxExport = null;
    window.__zxExportError = null;
    const panel = await openExportDialog();
    const formatLabel = formatMatch(command.format);
    const radio = Array.from(panel.querySelectorAll('input[type="radio"]')).find(
      (input) => {
        const label = input.closest('label');
        return label && norm(label.textContent).includes(formatLabel);
      },
    );
    if (!radio) throw new Error(`找不到格式「${formatLabel}」`);
    radio.click();
    await sleep(120);
    const checked = Array.from(
      panel.querySelectorAll('input[type="radio"]'),
    )
      .filter((input) => input.checked)
      .map((input) => norm(input.closest('label')?.textContent));
    const limit =
      formatLabel === 'PDF'
        ? norm(panel.querySelector('.kx-export-limit')?.textContent)
        : null;
    const outline = norm(panel.querySelector('.kx-export-outline')?.textContent);
    const next = Array.from(panel.querySelectorAll('button')).find(
      (button) => norm(button.textContent) === '继续',
    );
    if (!next) throw new Error('找不到「继续」按钮');
    next.click();

    const done = await waitFor(
      () => {
        const current = dialog();
        return current &&
          norm(current.getAttribute('aria-labelledby')) === 'kn-export-done-title'
          ? current
          : null;
      },
      30_000,
    );
    if (!done) {
      const alert = document.querySelector('.kn-field-error[role="alert"]');
      throw new Error(
        `导出未完成：${window.__zxExportError || norm(alert?.textContent) || '超时'}`,
      );
    }
    const pathText = norm(
      done.querySelector('.kx-export-result-path')?.textContent,
    );
    const fileLine = norm(
      done.querySelector('.kx-export-result-file')?.textContent,
    );
    const result = {
      format: formatLabel,
      checked,
      limit,
      outline,
      heading: norm(done.querySelector('h2')?.textContent),
      body: norm(done.textContent).slice(0, 1600),
      warnings: Array.from(done.querySelectorAll('.kx-export-warnings li')).map(
        (item) => norm(item.textContent),
      ),
      file: window.__zxExport || {
        fileName: fileLine,
        path: pathText,
        bytes: null,
      },
      pathText,
      fileLine,
    };
    const finish = Array.from(done.querySelectorAll('button')).find(
      (button) => norm(button.textContent) === '完成',
    );
    finish?.click();
    await sleep(200);
    return result;
  }

  async function dialogSnapshot() {
    const panel = await openExportDialog();
    const radios = Array.from(
      panel.querySelectorAll('input[type="radio"]'),
    ).map((input) => ({
      label: norm(input.closest('label')?.textContent),
      checked: input.checked,
    }));
    return {
      heading: norm(panel.querySelector('h2')?.textContent),
      radios,
      outline: norm(panel.querySelector('.kx-export-outline')?.textContent),
    };
  }

  async function env() {
    return {
      isTauri: Boolean(window.__TAURI_INTERNALS__),
      bodyText: norm(document.body.textContent).slice(0, 200),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  }

  const commands = {
    env,
    async sleep(command) {
      await sleep(command.ms || 500);
      return true;
    },
    async click(command) {
      const button = Array.from(document.querySelectorAll('button')).find(
        (item) =>
          visible(item) &&
          (norm(item.getAttribute('aria-label')) === command.label ||
            norm(item.textContent) === command.label),
      );
      if (!button) throw new Error(`找不到按钮「${command.label}」`);
      button.click();
      await sleep(command.wait || 300);
      return true;
    },
    seed,
    gotoKnowledge,
    openNote: (command) => openNote(command.title),
    dialogSnapshot,
    exportFormat,
    async closeDialogs() {
      const current = dialog();
      if (!current) return true;
      const close = Array.from(current.querySelectorAll('button')).find(
        (button) =>
          norm(button.textContent) === '取消' ||
          norm(button.textContent) === '完成' ||
          norm(button.getAttribute('aria-label')) === '关闭',
      );
      close?.click();
      await sleep(120);
      return !dialog();
    },
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
      await waitFor(() => document.readyState === 'complete', 20_000);
      await fetch('/__probe-ready', { method: 'POST' });
      setInterval(poll, 120);
    } catch (error) {
      await fetch('/__result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: -1,
          result: { ok: false, error: String(error) },
        }),
      });
    }
  }

  void boot();
})();
