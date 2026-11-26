/**
 * ZX-NOTE-04 真实 Tauri WebView 探针：引用块出处与来源。
 *
 * 只通过真实产品 IPC 造数据、只派发真实 DOM 事件：
 *   * 引用块显示出处 / 关联笔记 / 外链来源；
 *   * 出处弹层校验 javascript: 与 121 字出处；
 *   * 保存只改引用 payload，相邻段落不变；
 *   * 关联笔记被删除后 chip 禁用，弹层保存会清除关联；
 *   * 点关联笔记 chip 打开目标笔记，返回后引用仍在；
 *   * 导出 Markdown 仍保留引用正文与相邻段落；
 *   * 收集 console.error / window.error / unhandledrejection。
 */
(function () {
  const ERROR_KEY = 'zx-note-04-errors';
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

  const NOTE_ID = 'zx-note-04-note';
  const TITLE = 'ZX-NOTE-04 引用块增强';
  const TARGET_ID = 'zx-note-04-target';
  const TARGET_TITLE = '任务与笔记的关系是一等数据';
  const GONE_ID = 'zx-note-04-gone';
  const GONE_TITLE = 'ZX-NOTE-04 待删除来源';
  const QUOTE_ID = 'zx-note-04-q1';
  const MISSING_QUOTE_ID = 'zx-note-04-q2';
  const SOURCE_TEXT = '《任务与知识融合设计》评审记录';
  const EXTERNAL_URL = 'https://example.com/source';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function visible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
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

  function rows() {
    return Array.from(
      document.querySelectorAll('.zxe-body [data-block-id]'),
    );
  }

  function rowById(id) {
    return document.querySelector(`[data-block-id="${id}"]`);
  }

  function rowText(row) {
    if (!row) return '';
    const inline = row.querySelector('[data-inline-editor="true"]');
    if (inline) return norm(inline.textContent);
    return norm(row.querySelector('.zxe-row-content')?.textContent);
  }

  function saveLabel() {
    return norm(
      document.querySelector('.kn-save-state')?.textContent ||
        document.querySelector('.zxe-save-state')?.textContent ||
        '',
    );
  }

  function dispatchKey(target, key, extra = {}) {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    (target || document.activeElement || document.body).dispatchEvent(event);
    return event;
  }

  async function clickText(text) {
    const button = Array.from(
      document.querySelectorAll('button, a'),
    ).find((element) => visible(element) && norm(element.textContent) === text);
    if (!button) throw new Error(`找不到按钮「${text}」`);
    button.click();
    return true;
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
    const ready = await waitFor(
      () => document.querySelector(marker),
      10_000,
    );
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
    const ready = await waitFor(() => rows().length > 0, 10_000);
    if (!ready) throw new Error(`笔记「${title}」正文未就绪`);
    return title;
  }

  async function seed() {
    try {
      sessionStorage.removeItem(ERROR_KEY);
    } catch {
      /* ignore */
    }
    errors = [];
    await invoke('notes_create', {
      input: {
        id: NOTE_ID,
        title: TITLE,
        body: '<p></p>',
        tags: ['ZX-NOTE-04'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'zx-note-04-b1',
        noteId: NOTE_ID,
        blockType: 'paragraph',
        orderKey: 1024,
        payload: { runs: [{ text: '前一段：引用增强不应影响我。' }] },
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: QUOTE_ID,
        noteId: NOTE_ID,
        blockType: 'quote',
        orderKey: 2048,
        payload: {
          runs: [{ text: '任务与笔记的关系是一等数据。' }],
          source: SOURCE_TEXT,
          noteId: TARGET_ID,
          sourceUrl: EXTERNAL_URL,
        },
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: MISSING_QUOTE_ID,
        noteId: NOTE_ID,
        blockType: 'quote',
        orderKey: 3072,
        payload: {
          runs: [{ text: '这条引用指向即将删除的笔记。' }],
          source: '待删除关联',
          noteId: GONE_ID,
        },
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'zx-note-04-b3',
        noteId: NOTE_ID,
        blockType: 'paragraph',
        orderKey: 4096,
        payload: { runs: [{ text: '后一段：导出必须保留我。' }] },
      },
    });

    await invoke('notes_create', {
      input: {
        id: TARGET_ID,
        title: TARGET_TITLE,
        body: '<p></p>',
        tags: ['ZX-NOTE-04'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'zx-note-04-target-b1',
        noteId: TARGET_ID,
        blockType: 'paragraph',
        orderKey: 1024,
        payload: { runs: [{ text: '目标笔记正文。' }] },
      },
    });

    await invoke('notes_create', {
      input: {
        id: GONE_ID,
        title: GONE_TITLE,
        body: '<p></p>',
        tags: ['ZX-NOTE-04'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'zx-note-04-gone-b1',
        noteId: GONE_ID,
        blockType: 'paragraph',
        orderKey: 1024,
        payload: { runs: [{ text: '即将随笔记一起消失。' }] },
      },
    });
    // 软删除笔记：引用保留 noteId，UI 必须显示失效态。
    await invoke('notes_delete', { id: GONE_ID });

    return {
      noteId: NOTE_ID,
      title: TITLE,
      targetId: TARGET_ID,
      targetTitle: TARGET_TITLE,
      goneId: GONE_ID,
      blocks: 4,
    };
  }

  function quoteState(blockId) {
    const row = rowById(blockId);
    if (!row) return null;
    const source = row.querySelector('.zxe-quote-source');
    const note = row.querySelector('.zxe-quote-note');
    const url = row.querySelector('.zxe-quote-url');
    return {
      text: rowText(row),
      sourceText: norm(source?.textContent),
      noteText: norm(note?.textContent),
      noteTag: note ? note.tagName.toLowerCase() : null,
      noteDisabled: note?.getAttribute('aria-disabled') || null,
      noteTitle: note?.getAttribute('title') || null,
      urlText: norm(url?.textContent),
      urlTag: url ? url.tagName.toLowerCase() : null,
      urlHref: url ? url.getAttribute('href') : null,
      addSource: Boolean(row.querySelector('.zxe-quote-add-source')),
      editButton: Boolean(row.querySelector('.zxe-quote-edit')),
    };
  }

  function setInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function setSelect(select, value) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    ).set;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function dialogSnapshot() {
    const dialog = document.querySelector('.zxe-quote-dialog');
    if (!dialog) return null;
    return {
      present: Boolean(dialog),
      source: dialog.querySelector('input[aria-label="出处"]')?.value || '',
      note: dialog.querySelector('select[aria-label="关联笔记"]')?.value || '',
      url: dialog.querySelector('input[aria-label="来源链接"]')?.value || '',
      error: norm(dialog.querySelector('.zxe-dialog-error')?.textContent),
      warning: norm(dialog.querySelector('.zxe-dialog-warning')?.textContent),
      options: Array.from(dialog.querySelectorAll('option')).map((option) =>
        norm(option.textContent),
      ),
      buttons: Array.from(dialog.querySelectorAll('button')).map((button) =>
        norm(button.textContent),
      ),
    };
  }

  async function openQuoteDialog(blockId) {
    const row = rowById(blockId);
    if (!row) throw new Error(`找不到引用块：${blockId}`);
    const trigger =
      row.querySelector('.zxe-quote-source') ||
      row.querySelector('.zxe-quote-add-source') ||
      row.querySelector('.zxe-quote-edit');
    if (!trigger) throw new Error(`引用块没有出处入口：${blockId}`);
    trigger.click();
    const dialog = await waitFor(
      () => document.querySelector('.zxe-quote-dialog'),
      8000,
    );
    if (!dialog) throw new Error('出处弹层未打开');
    return dialogSnapshot();
  }

  async function fillDialog(values) {
    const dialog = document.querySelector('.zxe-quote-dialog');
    if (!dialog) throw new Error('出处弹层未打开');
    if (values.source !== undefined) {
      setInput(
        dialog.querySelector('input[aria-label="出处"]'),
        values.source,
      );
    }
    if (values.noteId !== undefined) {
      setSelect(
        dialog.querySelector('select[aria-label="关联笔记"]'),
        values.noteId,
      );
    }
    if (values.url !== undefined) {
      setInput(
        dialog.querySelector('input[aria-label="来源链接"]'),
        values.url,
      );
    }
    await sleep(60);
    return dialogSnapshot();
  }

  async function saveDialog() {
    const dialog = document.querySelector('.zxe-quote-dialog');
    if (!dialog) throw new Error('出处弹层未打开');
    const save = Array.from(dialog.querySelectorAll('button')).find(
      (button) => norm(button.textContent) === '保存',
    );
    if (!save) throw new Error('出处弹层没有保存按钮');
    save.click();
    await sleep(180);
    return {
      open: Boolean(document.querySelector('.zxe-quote-dialog')),
      snapshot: dialogSnapshot(),
    };
  }

  async function cancelDialog() {
    const dialog = document.querySelector('.zxe-quote-dialog');
    if (!dialog) return false;
    const cancel = Array.from(dialog.querySelectorAll('button')).find(
      (button) => norm(button.textContent) === '取消',
    );
    cancel?.click();
    await sleep(120);
    return !document.querySelector('.zxe-quote-dialog');
  }

  async function waitSaved() {
    const label = await waitFor(
      () => {
        const text = saveLabel();
        return text.includes('已保存到本机') ? text : null;
      },
      12_000,
    );
    await sleep(250);
    return label || saveLabel();
  }

  async function savedBlocks() {
    return invoke('note_blocks_list', { noteId: NOTE_ID });
  }

  function payloadOf(blocks, id) {
    const block = blocks.find((item) => item.id === id);
    return block ? block.payload : null;
  }

  async function initialState() {
    return {
      rows: rows().map((row) => ({
        id: row.dataset.blockId,
        type: row.dataset.blockType,
        text: rowText(row),
      })),
      quote: quoteState(QUOTE_ID),
      missingQuote: quoteState(MISSING_QUOTE_ID),
      saveLabel: saveLabel(),
    };
  }

  async function invalidValidation() {
    const before = await openQuoteDialog(QUOTE_ID);
    await fillDialog({ url: 'javascript:alert(1)' });
    const dangerous = await saveDialog();
    await fillDialog({ url: '', source: '啊'.repeat(121) });
    const tooLong = await saveDialog();
    await cancelDialog();
    return {
      before,
      dangerous,
      tooLong,
      closed: !document.querySelector('.zxe-quote-dialog'),
    };
  }

  async function editSource() {
    const before = await openQuoteDialog(QUOTE_ID);
    await fillDialog({
      source: '《卡片笔记写作法》第 6 章',
      url: 'https://example.com/book',
    });
    const filled = dialogSnapshot();
    const saved = await saveDialog();
    await waitSaved();
    const blocks = await savedBlocks();
    return {
      before,
      filled,
      saved,
      quote: quoteState(QUOTE_ID),
      payload: payloadOf(blocks, QUOTE_ID),
      beforePayload: payloadOf(blocks, 'zx-note-04-b1'),
      afterPayload: payloadOf(blocks, 'zx-note-04-b3'),
    };
  }

  async function openTargetFromQuote() {
    const row = rowById(QUOTE_ID);
    const chip = row?.querySelector('button.zxe-quote-note');
    if (!chip) throw new Error('引用块没有可点击的关联笔记 chip');
    chip.click();
    const titleInput = await waitFor(
      () => {
        const input = document.querySelector('input[aria-label="笔记标题"]');
        return input && input.value === TARGET_TITLE ? input : null;
      },
      10_000,
    );
    if (!titleInput) {
      throw new Error(
        `点击 chip 后没有打开目标笔记：${
          document.querySelector('input[aria-label="笔记标题"]')?.value
        }`,
      );
    }
    await openNote(TITLE);
    await waitSaved();
    return {
      openTarget: true,
      returned: Boolean(rowById(QUOTE_ID)),
      quote: quoteState(QUOTE_ID),
    };
  }

  async function clearMissingNote() {
    const before = quoteState(MISSING_QUOTE_ID);
    const dialog = await openQuoteDialog(MISSING_QUOTE_ID);
    const saved = await saveDialog();
    await waitSaved();
    const blocks = await savedBlocks();
    return {
      before,
      dialog,
      saved,
      after: quoteState(MISSING_QUOTE_ID),
      payload: payloadOf(blocks, MISSING_QUOTE_ID),
    };
  }

  async function exportMarkdown() {
    const infoTrigger = Array.from(
      document.querySelectorAll('button'),
    ).find(
      (button) =>
        visible(button) &&
        button.getAttribute('aria-label') === '笔记信息',
    );
    if (!infoTrigger) throw new Error('找不到「笔记信息」入口');
    infoTrigger.click();
    const infoPanel = await waitFor(
      () => document.querySelector('.kn-info'),
      8000,
    );
    if (!infoPanel) throw new Error('笔记信息面板未打开');

    const originalCreate = URL.createObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    let blob = null;
    let downloadName = '';
    URL.createObjectURL = (value) => {
      blob = value;
      return originalCreate.call(URL, value);
    };
    HTMLAnchorElement.prototype.click = function () {
      downloadName = this.download || '';
    };
    try {
      await clickText('导出 Markdown');
      const captured = await waitFor(() => blob, 8000);
      const text = captured ? await captured.text() : '';
      return {
        blobCaptured: Boolean(captured),
        downloadName,
        text,
        toast: norm(
          Array.from(document.querySelectorAll('[role="status"]'))
            .map((node) => node.textContent)
            .find((value) => String(value || '').includes('已导出')),
        ),
      };
    } finally {
      URL.createObjectURL = originalCreate;
      HTMLAnchorElement.prototype.click = originalClick;
    }
  }

  const commands = {
    async env() {
      return {
        isTauri: Boolean(window.__TAURI_INTERNALS__),
        bodyText: norm(document.body.innerText).slice(0, 160),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    },
    sleep(command) {
      return sleep(command.ms || 100);
    },
    clickText(command) {
      return clickText(command.text);
    },
    async seed() {
      return seed();
    },
    async gotoKnowledge() {
      return gotoTab('知识', '.kn-workspace');
    },
    async openNote(command) {
      return openNote(command.title || TITLE);
    },
    async initialState() {
      return initialState();
    },
    async invalidValidation() {
      return invalidValidation();
    },
    async editSource() {
      return editSource();
    },
    async openTargetFromQuote() {
      return openTargetFromQuote();
    },
    async clearMissingNote() {
      return clearMissingNote();
    },
    async exportMarkdown() {
      return exportMarkdown();
    },
    async quoteState(command) {
      return quoteState(command.blockId);
    },
    async dialog() {
      return dialogSnapshot();
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
