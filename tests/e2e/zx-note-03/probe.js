/**
 * ZX-NOTE-03/07 真实 Tauri WebView 探针：文档级全选与多块删除。
 *
 * 语义以《笔记块排版与选择模型 v4》（ZX-DESIGN-09）为准，取代旧「⌘A 三态」：
 *   * ⌘A 一次选中整篇（原生 Range + 整篇块高亮），重复按下不循环；
 *   * 整篇选择不显示每块复选框；复选框只在高级块选择（⌘⇧A / 底部「选择块」）出现；
 *   * checkbox 单选 + Shift+点击范围 + ⌘/Ctrl+点击追加（高级模式内）；
 *   * 批量删除 → 一次 ⌘Z 恢复（验证真实 SQLite 软删除行的恢复）；
 *   * 批量复制写入纯文本 + HTML；
 *   * 批量移动到另一篇笔记 → ⌘Z / ⇧⌘Z 双笔记恢复；
 *   * 点击空白退出块选择；
 *   * 收集 console.error / window.error / unhandledrejection。
 */
(function () {
  const ERROR_KEY = 'zx-note-03-errors';
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

  const NOTE_ID = 'zx-note-03-note';
  const TITLE = 'ZX-NOTE-03 全选与多块删除';
  const TARGET_ID = 'zx-note-03-target';
  const TARGET_TITLE = 'ZX-NOTE-03 移动目标';
  const BLOCK_COUNT = 12;

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

  function body() {
    return document.querySelector('.zxe-body');
  }

  function rowText(row) {
    const inline = row.querySelector('[data-inline-editor="true"]');
    if (inline) return norm(inline.textContent);
    return norm(row.querySelector('.zxe-row-content')?.textContent);
  }

  function rowTexts() {
    return rows().map(rowText);
  }

  function selectedRows() {
    return rows().filter((row) =>
      row.classList.contains('is-block-selected'),
    );
  }

  function toolbarState() {
    const bar = document.querySelector('.zxe-selectionbar');
    return {
      present: Boolean(bar),
      text: norm(bar?.textContent),
      buttons: bar
        ? Array.from(bar.querySelectorAll('button')).map((button) =>
            norm(button.textContent),
          )
        : [],
    };
  }

  function notice() {
    return norm(
      document.querySelector('.zxe-selection-toast')?.textContent,
    );
  }

  function saveLabel() {
    return norm(
      document.querySelector('.kn-save-state')?.textContent || '',
    );
  }

  function historyState() {
    const undo = document.querySelector(
      'button[aria-label="撤销编辑"]',
    );
    const redo = document.querySelector(
      'button[aria-label="重做编辑"]',
    );
    return {
      undoFound: Boolean(undo),
      undoDisabled: undo ? Boolean(undo.disabled) : null,
      redoFound: Boolean(redo),
      redoDisabled: redo ? Boolean(redo.disabled) : null,
    };
  }

  function dispatchKey(target, key, extra = {}) {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    (target || document.activeElement || document.body).dispatchEvent(
      event,
    );
    return event;
  }

  function clickCheckbox(index, extra = {}) {
    const button = rows()[index]?.querySelector('.zxe-block-select');
    if (!button) {
      throw new Error(`第 ${index + 1} 块没有选择 checkbox`);
    }
    button.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ...extra,
      }),
    );
  }

  function clickText(text) {
    const button = Array.from(document.querySelectorAll('button')).find(
      (element) => visible(element) && norm(element.textContent) === text,
    );
    if (!button) {
      throw new Error(`找不到按钮「${text}」`);
    }
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
        const input = document.querySelector(
          'input[aria-label="笔记标题"]',
        );
        return input && input.value === title ? input : null;
      },
      10_000,
    );
    if (!titleInput) throw new Error(`笔记「${title}」标题未就绪`);
    const ready = await waitFor(
      () => rows().length > 0,
      10_000,
    );
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
        tags: ['ZX-NOTE-03'],
        status: 'active',
      },
    });
    for (let index = 0; index < BLOCK_COUNT; index += 1) {
      await invoke('note_blocks_create', {
        input: {
          id: `zx-note-03-b${index + 1}`,
          noteId: NOTE_ID,
          blockType: 'paragraph',
          orderKey: (index + 1) * 1024,
          payload: {
            runs: [
              {
                text: `第 ${index + 1} 段 · ZX-NOTE-03 长笔记，用于验证全选、范围选择与批量删除。`,
              },
            ],
          },
        },
      });
    }
    await invoke('notes_create', {
      input: {
        id: TARGET_ID,
        title: TARGET_TITLE,
        body: '<p></p>',
        tags: ['ZX-NOTE-03'],
        status: 'active',
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'zx-note-03-target-b1',
        noteId: TARGET_ID,
        blockType: 'paragraph',
        orderKey: 1024,
        payload: { runs: [{ text: '目标原有段落' }] },
      },
    });
    return {
      noteId: NOTE_ID,
      title: TITLE,
      targetId: TARGET_ID,
      targetTitle: TARGET_TITLE,
      blocks: BLOCK_COUNT,
    };
  }

  async function targetTexts() {
    const list = await invoke('note_blocks_list', {
      noteId: TARGET_ID,
    });
    return list.map((block) => {
      const runs = block.payload && block.payload.runs;
      return Array.isArray(runs) ? norm(runs.map((run) => run.text).join('')) : '';
    });
  }

  function editorMode() {
    return (
      document.querySelector('.zxe')?.getAttribute('data-selection-mode') || ''
    );
  }

  function hasCheckboxes() {
    return Boolean(document.querySelector('.zxe-block-select'));
  }

  async function selectAllCycle() {
    const second = rows()[1]?.querySelector('[data-inline-editor="true"]');
    if (!second) throw new Error('第二块不可编辑');
    second.focus();
    // 第一次 ⌘A：一次选中整篇（原生 Range + 整篇块高亮），无复选框。
    dispatchKey(second, 'a', { metaKey: true });
    await sleep(160);
    const first = {
      selected: selectedRows().length,
      nativeSelection: String(window.getSelection() || ''),
      toolbar: toolbarState(),
      notice: notice(),
      checkboxes: hasCheckboxes(),
      mode: editorMode(),
    };

    // 第二次 ⌘A：不循环、不选页面，保持整篇。
    dispatchKey(document.activeElement || second, 'a', { metaKey: true });
    await sleep(160);
    const secondState = {
      selected: selectedRows().length,
      ids: selectedRows().map((row) => row.dataset.blockId),
      toolbar: toolbarState(),
      notice: notice(),
      activeClass: document.activeElement?.className || '',
    };

    // ⌘⇧A：退出选择（再次 ⌘⇧A 会进入高级块选择，由 rangeSelection 验证）。
    dispatchKey(document.activeElement || second, 'a', {
      metaKey: true,
      shiftKey: true,
    });
    await sleep(180);
    const third = {
      selected: selectedRows().length,
      toolbar: toolbarState(),
      notice: notice(),
      checkboxes: hasCheckboxes(),
      focusBackInEditor: Boolean(
        document.activeElement?.closest?.('[data-inline-editor="true"]') ||
          document.activeElement === body(),
      ),
    };
    return { first, second: secondState, third };
  }

  async function rangeSelection() {
    dispatchKey(body(), 'Escape');
    await sleep(80);
    // 通过底部「选择块」进入高级块选择，复选框才出现。
    clickText('选择块');
    await sleep(100);
    const checkboxesEntered = hasCheckboxes();
    if (!checkboxesEntered) throw new Error('高级块选择未显示复选框');
    clickCheckbox(2);
    await sleep(80);
    clickCheckbox(5, { shiftKey: true });
    await sleep(120);
    const shiftRange = {
      selected: selectedRows().length,
      ids: selectedRows().map((row) => row.dataset.blockId),
      toolbar: toolbarState(),
    };
    clickCheckbox(0, { ctrlKey: true });
    await sleep(100);
    const additive = {
      selected: selectedRows().length,
      ids: selectedRows().map((row) => row.dataset.blockId),
    };
    dispatchKey(body(), 'Escape');
    await sleep(100);
    return {
      checkboxesEntered,
      shiftRange,
      additive,
      afterEscape: {
        selected: selectedRows().length,
        toolbar: toolbarState(),
      },
    };
  }

  async function batchDeleteUndo() {
    const before = rowTexts();
    // 高级块选择：Esc 清理后重新进入，复选框才出现。
    clickText('选择块');
    await sleep(100);
    clickCheckbox(1);
    await sleep(60);
    clickCheckbox(3, { ctrlKey: true });
    await sleep(60);
    clickCheckbox(5, { ctrlKey: true });
    await sleep(100);
    const selected = selectedRows().map((row) => row.dataset.blockId);

    dispatchKey(body(), 'Delete');
    const deleted = await waitFor(
      () => (rows().length === before.length - 3 ? {
        count: rows().length,
        texts: rowTexts(),
        toolbar: toolbarState(),
        notice: notice(),
        history: historyState(),
      } : null),
      8000,
    );
    if (!deleted) {
      throw new Error(
        `批量删除后块数不正确：${rows().length} / 期望 ${before.length - 3}`,
      );
    }

    dispatchKey(document.activeElement || body(), 'z', { metaKey: true });
    await sleep(900);
    let undone = rows().length === before.length ? {
      count: rows().length,
      texts: rowTexts(),
      history: historyState(),
    } : null;
    if (!undone) {
      const diagnostic = {
        rows: rows().length,
        history: historyState(),
        saveLabel: saveLabel(),
        status: norm(document.querySelector('.zxe-status')?.textContent),
        saveError: norm(
          document.querySelector('.zxe-save-error')?.textContent,
        ),
        notice: notice(),
        errors: errors.slice(),
      };
      const undoButton = document.querySelector(
        'button[aria-label="撤销编辑"]',
      );
      if (undoButton && !undoButton.disabled) {
        undoButton.click();
        await sleep(1200);
        undone = rows().length === before.length ? {
          count: rows().length,
          texts: rowTexts(),
          history: historyState(),
        } : null;
      }
      if (!undone) {
        throw new Error(
          `撤销后块数未恢复：${rows().length} / 期望 ${before.length} ${JSON.stringify(diagnostic)}`,
        );
      }
      return {
        selected,
        deleted,
        undone,
        restoredOrder: JSON.stringify(undone.texts) === JSON.stringify(before),
        saveLabel: saveLabel(),
        viaButtonFallback: true,
        diagnostic,
      };
    }
    await waitFor(
      () => saveLabel().includes('已保存到本机'),
      10_000,
    );
    return {
      selected,
      deleted,
      undone,
      restoredOrder: JSON.stringify(undone.texts) === JSON.stringify(before),
      saveLabel: saveLabel(),
    };
  }

  async function copySelected() {
    const selectAll = document.querySelector('.zxe-select-all');
    if (!selectAll) throw new Error('缺少选择块入口');
    // 高级块选择内 ⌘⇧A 全选所有块（复选框出现）。
    selectAll.click();
    await sleep(120);
    dispatchKey(document.activeElement || body(), 'a', {
      metaKey: true,
      shiftKey: true,
    });
    await sleep(200);
    if (!hasCheckboxes()) {
      // 底部按钮没有进入块选择时（焦点在按钮上），改从正文进入。
      dispatchKey(body(), 'a', { metaKey: true, shiftKey: true });
      await sleep(200);
    }
    if (!hasCheckboxes()) throw new Error('高级全选未显示复选框');
    const data = {};
    const event = new Event('copy', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        setData: (type, value) => {
          data[type] = value;
        },
      },
    });
    document.dispatchEvent(event);
    await sleep(100);
    const result = {
      selected: selectedRows().length,
      prevented: event.defaultPrevented,
      text: data['text/plain'] || '',
      html: data['text/html'] || '',
      notice: notice(),
    };
    dispatchKey(body(), 'Escape');
    await sleep(100);
    return result;
  }

  async function moveToTargetNote() {
    const before = rowTexts();
    clickText('选择块');
    await sleep(100);
    clickCheckbox(1);
    await sleep(60);
    clickCheckbox(2, { ctrlKey: true });
    await sleep(100);
    const movedIds = selectedRows().map((row) => row.dataset.blockId);
    clickText('移动…');
    const dialog = await waitFor(
      () => document.querySelector('.zxe-move-dialog'),
      8000,
    );
    if (!dialog) throw new Error('移动弹层未打开');
    const radio = Array.from(
      dialog.querySelectorAll('input[type="radio"]'),
    ).find((input) => input.value === TARGET_ID);
    if (!radio) throw new Error('移动弹层没有目标笔记');
    radio.click();
    await sleep(80);
    const confirm = Array.from(
      dialog.querySelectorAll('button'),
    ).find((button) => norm(button.textContent) === '移动');
    if (!confirm) throw new Error('移动弹层没有确认按钮');
    confirm.click();

    const moved = await waitFor(
      async () => {
        if (rows().length !== before.length - 2) return null;
        const target = await targetTexts();
        return target.length === 3 ? target : null;
      },
      10_000,
    );
    if (!moved) {
      throw new Error(
        `移动后状态不正确：源 ${rows().length} 块 / 目标 ${JSON.stringify(await targetTexts())}`,
      );
    }
    await waitFor(
      () => saveLabel().includes('已保存到本机'),
      10_000,
    );
    const afterMove = {
      sourceCount: rows().length,
      sourceTexts: rowTexts(),
      targetTexts: moved,
      movedIds,
    };

    dispatchKey(body(), 'z', { metaKey: true });
    const undone = await waitFor(
      async () => {
        if (rows().length !== before.length) return null;
        const target = await targetTexts();
        return target.length === 1 ? target : null;
      },
      10_000,
    );
    if (!undone) {
      throw new Error(
        `撤销移动后状态不正确：源 ${rows().length} 块 / 目标 ${JSON.stringify(await targetTexts())}`,
      );
    }
    const afterUndo = {
      sourceCount: rows().length,
      sourceTexts: rowTexts(),
      targetTexts: undone,
      history: historyState(),
    };

    dispatchKey(body(), 'z', { metaKey: true, shiftKey: true });
    const redone = await waitFor(
      async () => {
        if (rows().length !== before.length - 2) return null;
        const target = await targetTexts();
        return target.length === 3 ? target : null;
      },
      10_000,
    );
    if (!redone) {
      throw new Error(
        `重做移动后状态不正确：源 ${rows().length} 块 / 目标 ${JSON.stringify(await targetTexts())}`,
      );
    }
    await waitFor(
      () => saveLabel().includes('已保存到本机'),
      10_000,
    );
    return {
      afterMove,
      afterUndo,
      afterRedo: {
        sourceCount: rows().length,
        sourceTexts: rowTexts(),
        targetTexts: redone,
      },
    };
  }

  async function blankClickClears() {
    const selectAll = document.querySelector('.zxe-select-all');
    if (!selectAll) throw new Error('缺少选择块入口');
    selectAll.click();
    await sleep(120);
    // 第一次 ⌘⇧A 退出单块选择，第二次进入高级全选（与 copySelected 一致）。
    dispatchKey(body(), 'a', { metaKey: true, shiftKey: true });
    await sleep(200);
    dispatchKey(body(), 'a', { metaKey: true, shiftKey: true });
    await sleep(200);
    if (!hasCheckboxes()) throw new Error('高级全选未显示复选框');
    const before = selectedRows().length;
    body().dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
      }),
    );
    await sleep(120);
    return {
      before,
      after: selectedRows().length,
      toolbar: toolbarState(),
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
    async selectAllCycle() {
      return selectAllCycle();
    },
    async rangeSelection() {
      return rangeSelection();
    },
    async batchDeleteUndo() {
      return batchDeleteUndo();
    },
    async copySelected() {
      return copySelected();
    },
    async moveToTargetNote() {
      return moveToTargetNote();
    },
    async blankClickClears() {
      return blankClickClears();
    },
    snapshot() {
      return {
        rows: rowTexts(),
        selected: selectedRows().length,
        toolbar: toolbarState(),
        saveLabel: saveLabel(),
        history: historyState(),
      };
    },
    targetTexts() {
      return targetTexts();
    },
    errors() {
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
          error:
            (error && (error.message || String(error))) || 'unknown',
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
