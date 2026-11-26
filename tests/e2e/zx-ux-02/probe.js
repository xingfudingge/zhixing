/**
 * ZX-UX-02 真实 Tauri WebView 探针。
 *
 * 只观察 DOM / 派发真实事件 / 调用产品 IPC，不替换产品代码。
 * 覆盖：清单树入口、折叠、指针拖拽、新建子清单、图标、删除迁移、深链、刷新。
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

  function rowById(id) {
    return document.querySelector(`[data-list-row][data-list-id="${id}"]`);
  }

  function rowByText(text, root = document) {
    return Array.from(root.querySelectorAll('[data-list-row]')).find(
      (row) => visible(row) && norm(row.querySelector('.list-tree-name')?.textContent) === text,
    );
  }

  function listIdForName(name) {
    const row = rowByText(name);
    if (!row) throw new Error(`找不到清单行：${name}`);
    return row.getAttribute('data-list-id');
  }

  function treeState() {
    return Array.from(document.querySelectorAll('[data-list-row]')).filter(visible).map((row) => {
      const toggle = row.querySelector('.list-tree-toggle');
      const count = row.querySelector('.list-tree-count');
      const depth = Number(
        getComputedStyle(row).getPropertyValue('--tree-depth') || 1,
      );
      const nested = row.closest('.list-tree-children');
      return {
        id: row.getAttribute('data-list-id'),
        name: norm(row.querySelector('.list-tree-name')?.textContent),
        depth: Number.isFinite(depth) ? depth : 1,
        nested: !!nested,
        count: count ? norm(count.getAttribute('aria-label')) : null,
        countText: count ? norm(count.textContent) : null,
        active: row.classList.contains('is-active'),
        expanded: toggle ? toggle.getAttribute('aria-expanded') : null,
        hasChildren: !!toggle,
        scope: row.closest('.list-tree-panel--sidebar')
          ? 'sidebar'
          : row.closest('.list-tree-panel--page')
            ? 'page'
            : 'unknown',
      };
    });
  }

  function windowInfo() {
    return {
      url: location.href,
      title: document.title,
      isTauri: '__TAURI_INTERNALS__' in window,
      hasElementFromPoint: typeof document.elementFromPoint === 'function',
      bodyText: norm(document.body.innerText).slice(0, 600),
      headings: Array.from(document.querySelectorAll('h1, h2')).map((h) => norm(h.textContent)),
      errors: errors.slice(-40),
    };
  }

  function setNativeValue(element, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype,
      'value',
    );
    descriptor.set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function labelControl(labelText) {
    const labels = Array.from(document.querySelectorAll('label'));
    const label = labels.find((item) => norm(item.textContent) === labelText);
    if (!label) throw new Error(`找不到标签：${labelText}`);
    const id = label.getAttribute('for');
    const control = id ? document.getElementById(id) : label.querySelector('input, select, textarea');
    if (!control) throw new Error(`标签没有控件：${labelText}`);
    return control;
  }

  function clickText(text, selector) {
    const nodes = Array.from(
      document.querySelectorAll(selector || 'button, a, [role="button"], [role="link"], [role="menuitem"]'),
    ).filter(visible);
    const target =
      nodes.find((el) => norm(el.textContent) === text) ||
      nodes.find((el) => norm(el.textContent).includes(text)) ||
      nodes.find((el) => norm(el.getAttribute('aria-label')) === text);
    if (!target) throw new Error(`找不到可点击元素：${text}`);
    target.click();
    return true;
  }

  function clickSelector(selector) {
    const target = document.querySelector(selector);
    if (!target || !visible(target)) throw new Error(`找不到可见元素：${selector}`);
    target.click();
    return true;
  }

  function clickDialogButton(text) {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error('没有打开的弹层');
    const button = Array.from(dialog.querySelectorAll('button')).find(
      (item) => norm(item.textContent) === text,
    );
    if (!button) throw new Error(`弹层里找不到按钮：${text}`);
    button.click();
    return true;
  }

  async function waitFor(check, timeout = 6000, interval = 80) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  async function dragList(sourceId, targetId, zone) {
    const source = rowById(sourceId);
    const target = rowById(targetId);
    if (!source || !target) throw new Error(`拖拽找不到行：${sourceId} → ${targetId}`);
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const start = center(source);
    const ratio = zone === 'before' ? 0.1 : zone === 'after' ? 0.9 : 0.5;
    const end = {
      x: targetRect.left + targetRect.width / 2,
      y: targetRect.top + targetRect.height * ratio,
    };
    const pointer = (type, x, y) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 77,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: y,
        screenX: window.screenX + x,
        screenY: window.screenY + y,
      });

    source.dispatchEvent(pointer('pointerdown', start.x, start.y));
    await sleep(60);
    source.dispatchEvent(pointer('pointermove', start.x + 24, start.y + 18));
    await sleep(80);
    const atTarget = document.elementFromPoint(end.x, end.y) || target;
    atTarget.dispatchEvent(pointer('pointermove', end.x, end.y));
    await sleep(120);
    const during = {
      ghost: !!document.querySelector('.list-drag-ghost'),
      dropChild: target.classList.contains('is-drop-child'),
      dropBefore: target.classList.contains('is-drop-before'),
      dropAfter: target.classList.contains('is-drop-after'),
      bodyDragging: document.body.classList.contains('list-pointer-dragging'),
    };
    atTarget.dispatchEvent(pointer('pointerup', end.x, end.y));
    await sleep(600);
    return { during, tree: treeState() };
  }

  async function ipc(command, args) {
    if (!window.__TAURI_INTERNALS__?.invoke) {
      throw new Error('没有 Tauri IPC');
    }
    return window.__TAURI_INTERNALS__.invoke(command, args || {});
  }

  async function listRows() {
    return ipc('lists_list', { includeDeleted: true });
  }

  async function taskRows() {
    return ipc('tasks_list', { query: {} });
  }

  async function execute(command) {
    switch (command.type) {
      case 'env':
        return windowInfo();
      case 'tree':
        return treeState();
      case 'sleep':
        await sleep(command.ms ?? 300);
        return true;
      case 'clickText':
        clickText(command.text, command.selector);
        await sleep(command.wait ?? 450);
        return windowInfo();
      case 'clickSelector':
        clickSelector(command.selector);
        await sleep(command.wait ?? 450);
        return windowInfo();
      case 'clickDialogButton':
        clickDialogButton(command.text);
        await sleep(command.wait ?? 700);
        return windowInfo();
      case 'openMenu': {
        const id = listIdForName(command.name);
        clickSelector(`[aria-label="清单操作：${command.name}"]`);
        await sleep(200);
        clickText(command.item, '[role="menuitem"]');
        await sleep(450);
        return { id, ...windowInfo(), tree: treeState() };
      }
      case 'fillLabel': {
        const control = labelControl(command.label);
        setNativeValue(control, command.value);
        await sleep(120);
        return { value: control.value };
      }
      case 'selectLabel': {
        const control = labelControl(command.label);
        setNativeValue(control, command.value);
        await sleep(120);
        return { value: control.value };
      }
      case 'dialog':
        return {
          open: !!document.querySelector('[role="dialog"]'),
          text: norm(document.querySelector('[role="dialog"]')?.textContent),
        };
      case 'dragList':
        return dragList(command.sourceId, command.targetId, command.zone);
      case 'waitText': {
        const found = await waitFor(
          () => norm(document.body.innerText).includes(command.text),
          command.timeout ?? 6000,
        );
        return { found: !!found, ...windowInfo() };
      }
      case 'waitSelector': {
        const found = await waitFor(
          () => document.querySelector(command.selector),
          command.timeout ?? 6000,
        );
        return { found: !!found, ...windowInfo() };
      }
      case 'valueOf': {
        const control = labelControl(command.label);
        return { value: control.value };
      }
      case 'clearCollapsed':
        localStorage.removeItem('zx.lists.tree.collapsed.v1');
        return { removed: true };
      case 'storage':
        return {
          collapsed: localStorage.getItem('zx.lists.tree.collapsed.v1'),
          keys: Object.keys(localStorage),
        };
      case 'count':
        return document.querySelectorAll(command.selector).length;
      case 'text':
        return norm(
          document.querySelector(command.selector)?.textContent ?? '',
        );
      case 'layout': {
        const doc = document.documentElement;
        const body = document.body;
        const page = document.querySelector('.lists-page');
        const detail = document.querySelector('.task-workspace');
        const measure = (element) =>
          element
            ? {
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
                overflow: element.scrollWidth > element.clientWidth + 1,
              }
            : null;
        return {
          innerWidth: window.innerWidth,
          documentClientWidth: doc.clientWidth,
          documentScrollWidth: Math.max(doc.scrollWidth, body.scrollWidth),
          overflow:
            Math.max(doc.scrollWidth, body.scrollWidth) > doc.clientWidth + 1,
          page: measure(page),
          detail: measure(detail),
        };
      }
      case 'ipc':
        return ipc(command.command, command.args);
      case 'lists':
        return listRows();
      case 'tasks':
        return taskRows();
      case 'goto': {
        history.pushState({}, '', command.path);
        window.dispatchEvent(new PopStateEvent('popstate'));
        await sleep(command.wait ?? 700);
        return windowInfo();
      }
      case 'reload':
        setTimeout(() => location.reload(), 100);
        return true;
      case 'openTaskDetail':
        return {
          value: document.getElementById('task-detail-title')?.value ?? null,
        };
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
        result = { ok: false, error: String((error && error.stack) || error) };
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
