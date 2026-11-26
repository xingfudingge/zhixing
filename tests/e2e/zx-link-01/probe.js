/**
 * ZX-LINK-01 / ZX-LINK-03 真实 Tauri WebView 探针：链接块卡片。
 *
 * 只通过真实产品 IPC 造数据、只派发真实 DOM 事件：
 *   * 外链卡显示标题 / 域名 / 打开按钮，不抓取 favicon；
 *   * 内链卡显示目标笔记标题与「站内笔记」；
 *   * 危险协议显示原始 URL 与原因，不可点；
 *   * 编辑弹层可改标题 / 地址，并拒绝 javascript: 与不存在内链；
 *   * 编辑态单击外链/内链标题直接打开，不再抢占编辑入口；
 *   * 显式「编辑 / 修复」按钮才打开弹层；失效内链无打开动作、可复制；
 *   * 内链打开目标笔记，来源标签保留可返回；
 *   * 收集 console.error / window.error / unhandledrejection。
 */
(function () {
  const ERROR_KEY = 'zx-link-01-errors';
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

  const NOTE_ID = 'zx-link-01-note';
  const TITLE = 'ZX-LINK-01 链接块';
  const TARGET_ID = 'zx-link-01-target';
  const TARGET_TITLE = '任务与笔记的关系是一等数据';
  const MISSING_ID = 'zx-link-01-gone';
  const EXTERNAL_ID = 'zx-link-01-l-external';
  const INTERNAL_ID = 'zx-link-01-l-internal';
  const INVALID_ID = 'zx-link-01-l-invalid';
  const MISSING_LINK_ID = 'zx-link-01-l-missing';
  const EXTERNAL_URL = 'https://www.feishu.cn/doc/abc';

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

  function cardById(id) {
    return rowById(id)?.querySelector('.zxe-linkblock') || null;
  }

  function cardState(id) {
    const card = cardById(id);
    if (!card) return null;
    const open = card.querySelector('.zxe-linkblock-action[aria-label^="打开"]');
    return {
      kind: card.getAttribute('data-kind'),
      invalid: card.getAttribute('data-invalid'),
      title: norm(card.querySelector('.zxe-linkblock-title')?.textContent),
      titleTag: card
        .querySelector('.zxe-linkblock-title')
        ?.tagName.toLowerCase(),
      meta: norm(card.querySelector('.zxe-linkblock-meta')?.textContent),
      alert: card
        .querySelector('.zxe-linkblock-meta[role="alert"]')
        ? norm(card.querySelector('.zxe-linkblock-meta')?.textContent)
        : null,
      icon: norm(card.querySelector('.zxe-linkblock-icon')?.textContent),
      openTag: open ? open.tagName.toLowerCase() : null,
      openHref: open ? open.getAttribute('href') : null,
      openTarget: open ? open.getAttribute('target') : null,
      openLabel: open ? open.getAttribute('aria-label') : null,
      openDisabled: open ? open.hasAttribute('disabled') : null,
      images: card.querySelectorAll('img, picture, svg').length,
      rawUrls: Array.from(card.querySelectorAll('[href]')).map((el) =>
        el.getAttribute('href'),
      ),
    };
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
        tags: ['ZX-LINK-01'],
        status: 'active',
      },
    });
    await invoke('notes_create', {
      input: {
        id: TARGET_ID,
        title: TARGET_TITLE,
        body: '<p></p>',
        tags: ['ZX-LINK-01'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'zx-link-01-b1',
        noteId: NOTE_ID,
        blockType: 'paragraph',
        orderKey: 512,
        payload: { runs: [{ text: '链接卡片验收。' }] },
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: EXTERNAL_ID,
        noteId: NOTE_ID,
        blockType: 'link',
        orderKey: 1024,
        payload: {
          url: EXTERNAL_URL,
          title: '飞书画板 · 单人创作指南',
        },
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: INTERNAL_ID,
        noteId: NOTE_ID,
        blockType: 'link',
        orderKey: 2048,
        payload: { url: `zhixing://note/${TARGET_ID}`, title: '' },
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: INVALID_ID,
        noteId: NOTE_ID,
        blockType: 'link',
        orderKey: 3072,
        payload: { url: 'javascript:alert(1)', title: '危险链接' },
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: MISSING_LINK_ID,
        noteId: NOTE_ID,
        blockType: 'link',
        orderKey: 4096,
        payload: {
          url: `zhixing://note/${MISSING_ID}`,
          title: '已删除旧笔记',
        },
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'zx-link-01-target-b1',
        noteId: TARGET_ID,
        blockType: 'paragraph',
        orderKey: 1024,
        payload: { runs: [{ text: '目标笔记正文。' }] },
      },
    });
    return {
      noteId: NOTE_ID,
      title: TITLE,
      targetId: TARGET_ID,
      targetTitle: TARGET_TITLE,
      blocks: 5,
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
    const ready = await waitFor(() => rows().length > 0, 10_000);
    if (!ready) throw new Error(`笔记「${title}」正文未就绪`);
    return title;
  }

  function initialState() {
    return {
      blockCount: rows().length,
      external: cardState(EXTERNAL_ID),
      internal: cardState(INTERNAL_ID),
      invalid: cardState(INVALID_ID),
      missing: cardState(MISSING_LINK_ID),
      linkCards: document.querySelectorAll('.zxe-linkblock').length,
      imgs: document.querySelectorAll('.zxe-linkblock img').length,
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

  async function openEditor(blockId) {
    const card = cardById(blockId);
    if (!card) throw new Error(`缺少链接卡 ${blockId}`);
    card.querySelector('.zxe-linkblock-action[aria-label="编辑链接"]').click();
    const dialog = await waitFor(
      () => document.querySelector('.zxe-link-dialog'),
      6000,
    );
    if (!dialog) throw new Error('链接编辑弹层未打开');
    return dialog;
  }

  function dialogSnapshot() {
    const dialog = document.querySelector('.zxe-link-dialog');
    if (!dialog) return null;
    return {
      present: true,
      title: dialog.querySelector('input[aria-label="链接标题"]')?.value || '',
      url: dialog.querySelector('input[aria-label="链接地址"]')?.value || '',
      target: norm(dialog.querySelector('.zxe-link-target')?.textContent),
      error: norm(dialog.querySelector('.zxe-dialog-error')?.textContent),
      notice: norm(dialog.querySelector('[role="status"]')?.textContent),
      buttons: Array.from(dialog.querySelectorAll('button')).map((button) =>
        norm(button.textContent),
      ),
    };
  }

  async function editValidation() {
    const dialog = await openEditor(EXTERNAL_ID);
    const urlInput = dialog.querySelector('input[aria-label="链接地址"]');
    const titleInput = dialog.querySelector('input[aria-label="链接标题"]');
    setInput(urlInput, 'javascript:alert(1)');
    await sleep(40);
    const buttons = Array.from(dialog.querySelectorAll('button'));
    buttons.find((button) => norm(button.textContent) === '保存').click();
    const error = await waitFor(
      () => norm(dialog.querySelector('.zxe-dialog-error')?.textContent),
      4000,
    );
    const afterBad = cardState(EXTERNAL_ID);

    setInput(titleInput, '飞书画板');
    setInput(urlInput, `zhixing://note/${TARGET_ID}`);
    await sleep(40);
    const targetHint = norm(
      dialog.querySelector('.zxe-link-target')?.textContent,
    );
    Array.from(dialog.querySelectorAll('button'))
      .find((button) => norm(button.textContent) === '保存')
      .click();
    const closed = await waitFor(
      () => !document.querySelector('.zxe-link-dialog'),
      4000,
    );
    const afterGood = cardState(EXTERNAL_ID);
    return {
      error,
      targetHint,
      closed: Boolean(closed),
      afterBad,
      afterGood,
      dialog: dialogSnapshot(),
    };
  }

  async function editTitleOpensTarget() {
    const beforeNote = document.querySelector(
      'input[aria-label="笔记标题"]',
    )?.value;
    const dialogBefore = Boolean(document.querySelector('.zxe-link-dialog'));
    const card = cardById(INTERNAL_ID);
    card.querySelector('.zxe-linkblock-title').click();
    const target = await waitFor(
      () => {
        const input = document.querySelector('input[aria-label="笔记标题"]');
        return input && input.value === TARGET_TITLE ? input : null;
      },
      10_000,
    );
    const dialogAfter = Boolean(document.querySelector('.zxe-link-dialog'));
    const back = Array.from(document.querySelectorAll('[role="tab"]')).find(
      (tab) => norm(tab.textContent).includes(TITLE),
    );
    if (back) back.click();
    const returned = await waitFor(
      () => {
        const input = document.querySelector('input[aria-label="笔记标题"]');
        return input && input.value === TITLE ? input : null;
      },
      10_000,
    );
    return {
      beforeNote,
      navigated: Boolean(target),
      dialogBefore,
      dialogAfter,
      returned: Boolean(returned),
    };
  }

  async function openInternalAndReturn() {
    const card = cardById(INTERNAL_ID);
    const open = card.querySelector(
      '.zxe-linkblock-action[aria-label^="打开笔记"]',
    );
    open.click();
    const target = await waitFor(
      () => {
        const input = document.querySelector('input[aria-label="笔记标题"]');
        return input && input.value === TARGET_TITLE ? input : null;
      },
      10_000,
    );
    const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map(
      (tab) => norm(tab.textContent),
    );
    const back = Array.from(document.querySelectorAll('[role="tab"]')).find(
      (tab) => norm(tab.textContent).includes(TITLE),
    );
    if (back) back.click();
    const returned = await waitFor(
      () => {
        const input = document.querySelector('input[aria-label="笔记标题"]');
        return input && input.value === TITLE ? input : null;
      },
      10_000,
    );
    return {
      openedTarget: Boolean(target),
      tabs,
      returned: Boolean(returned),
      cardBack: Boolean(cardById(INTERNAL_ID)),
    };
  }

  async function missingOpenDisabled() {
    const card = cardById(MISSING_LINK_ID);
    const actions = Array.from(
      card.querySelectorAll('.zxe-linkblock-action'),
    );
    const labels = actions.map((el) => el.getAttribute('aria-label'));
    return {
      openLabels: labels,
      hasOpen: labels.some((label) => String(label).startsWith('打开')),
      hasRepair: labels.includes('修复链接'),
      hasCopy: labels.includes('复制链接'),
      meta: norm(card.querySelector('.zxe-linkblock-meta')?.textContent),
    };
  }

  async function externalAnchor() {
    const card = cardById(EXTERNAL_ID);
    const open = card.querySelector(
      '.zxe-linkblock-action[aria-label^="打开链接"]',
    );
    const titleControl = card.querySelector('.zxe-linkblock-title');
    return {
      tag: open ? open.tagName.toLowerCase() : null,
      href: open ? open.getAttribute('href') : null,
      target: open ? open.getAttribute('target') : null,
      titleTag: titleControl
        ? titleControl.tagName.toLowerCase()
        : null,
      titleTitle: titleControl ? titleControl.getAttribute('title') : null,
    };
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
    async clickText(command) {
      const button = Array.from(
        document.querySelectorAll('button, a'),
      ).find(
        (element) =>
          visible(element) && norm(element.textContent) === command.text,
      );
      if (!button) throw new Error(`找不到按钮「${command.text}」`);
      button.click();
      return true;
    },
    seed,
    gotoKnowledge,
    async openNote(command) {
      return openNote(command.title || TITLE);
    },
    initialState,
    editValidation,
    editTitleOpensTarget,
    openInternalAndReturn,
    missingOpenDisabled,
    externalAnchor,
    dialog: dialogSnapshot,
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
