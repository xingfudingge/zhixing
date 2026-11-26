/**
 * ZX-UX-01 真实 Tauri WebView 探针。
 *
 * 只读观察 + 真实 DOM 事件；不修改产品代码、不替换产品 IPC。
 * * `pointerDragSynthetic`：在真实 WKWebView 里派发 PointerEvent，
 *   验证产品自己的 pointerdown/move/up 处理链（不是 jsdom）。
 * * `rects`：返回元素 viewport 坐标与窗口信息，供外部 CGEvent 真鼠标拖拽。
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

  function findByText(selector, text) {
    return Array.from(document.querySelectorAll(selector)).find(
      (el) => visible(el) && norm(el.textContent).includes(text),
    );
  }

  function taskElement(title) {
    return Array.from(document.querySelectorAll('[data-task-id]')).find(
      (el) => visible(el) && norm(el.textContent).includes(title),
    );
  }

  function clickTab(label) {
    const tab = Array.from(
      document.querySelectorAll('.task-tabs button'),
    ).find((el) => norm(el.textContent) === label);
    if (!tab) throw new Error(`找不到视图标签：${label}`);
    tab.click();
    return true;
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

  function quadrantState() {
    return Array.from(document.querySelectorAll('[data-drop-quadrant]')).map(
      (section) => ({
        quadrant: Number(section.getAttribute('data-drop-quadrant')),
        label: norm(section.getAttribute('aria-label')),
        over: section.classList.contains('is-over'),
        tasks: Array.from(section.querySelectorAll('[data-task-id]')).map(
          (el) => norm(el.querySelector('.task-title')?.textContent),
        ),
      }),
    );
  }

  function boardState() {
    return Array.from(document.querySelectorAll('[data-drop-status]')).map(
      (section) => ({
        status: section.getAttribute('data-drop-status'),
        label: norm(section.getAttribute('aria-label')),
        over: section.classList.contains('is-over'),
        tasks: Array.from(section.querySelectorAll('[data-task-id]')).map(
          (el) => norm(el.querySelector('.task-card-title')?.textContent),
        ),
      }),
    );
  }

  function windowInfo() {
    const active = document.querySelector('.task-tab[aria-pressed="true"]');
    return {
      url: location.href,
      title: document.title,
      isTauri: '__TAURI_INTERNALS__' in window,
      hasPointerEvent: typeof PointerEvent === 'function',
      hasElementFromPoint: typeof document.elementFromPoint === 'function',
      screenX: window.screenX,
      screenY: window.screenY,
      screenLeft: window.screenLeft,
      screenTop: window.screenTop,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      activeTab: active ? norm(active.textContent) : null,
      hasTodayTitle: !!document.querySelector('#today-title'),
      bodyText: norm(document.body.innerText).slice(0, 400),
      errors: errors.slice(-20),
    };
  }

  function pointerEvent(type, x, y) {
    return new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 41,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y,
    });
  }

  async function pointerDragSynthetic(kind, title, targetLabel) {
    const source = taskElement(title);
    if (!source) throw new Error(`找不到任务：${title}`);
    const targetAttribute = kind === 'quadrant' ? 'data-drop-quadrant' : 'data-drop-status';
    const target = Array.from(document.querySelectorAll(`[${targetAttribute}]`)).find(
      (section) =>
        norm(section.getAttribute('aria-label')).includes(targetLabel),
    );
    if (!target) throw new Error(`找不到目标列：${targetLabel}`);

    const start = center(source);
    const end = center(target);
    source.dispatchEvent(pointerEvent('pointerdown', start.x, start.y));
    await sleep(50);
    source.dispatchEvent(
      pointerEvent('pointermove', start.x + 24, start.y + 18),
    );
    await sleep(60);
    const atTarget = document.elementFromPoint(end.x, end.y) || target;
    atTarget.dispatchEvent(pointerEvent('pointermove', end.x, end.y));
    await sleep(80);
    const during = {
      ghost: !!document.querySelector('.task-drag-ghost'),
      ghostText: norm(document.querySelector('.task-drag-ghost')?.textContent),
      sourceDragging: source.classList.contains('is-dragging'),
      targetOver: target.classList.contains('is-over'),
      bodyDragging: document.body.classList.contains('task-pointer-dragging'),
    };
    atTarget.dispatchEvent(pointerEvent('pointerup', end.x, end.y));
    await sleep(300);
    return {
      during,
      after: {
        ghost: !!document.querySelector('.task-drag-ghost'),
        targetOver: target.classList.contains('is-over'),
        bodyDragging: document.body.classList.contains('task-pointer-dragging'),
      },
      quadrant: quadrantState(),
      board: boardState(),
    };
  }

  async function pointerCancelSynthetic(title, targetLabel) {
    const source = taskElement(title);
    const target = Array.from(
      document.querySelectorAll('[data-drop-quadrant]'),
    ).find((section) =>
      norm(section.getAttribute('aria-label')).includes(targetLabel),
    );
    if (!source || !target) throw new Error('取消用例找不到源/目标');
    const start = center(source);
    const end = center(target);
    source.dispatchEvent(pointerEvent('pointerdown', start.x, start.y));
    await sleep(40);
    target.dispatchEvent(pointerEvent('pointermove', end.x, end.y));
    await sleep(60);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(60);
    const afterEscape = {
      ghost: !!document.querySelector('.task-drag-ghost'),
      targetOver: target.classList.contains('is-over'),
    };
    target.dispatchEvent(pointerEvent('pointerup', end.x, end.y));
    await sleep(200);
    return { afterEscape, quadrant: quadrantState() };
  }

  function rects(kind, title, targetLabel) {
    const source = taskElement(title);
    const attr = kind === 'quadrant' ? 'data-drop-quadrant' : 'data-drop-status';
    const target = Array.from(document.querySelectorAll(`[${attr}]`)).find(
      (section) => norm(section.getAttribute('aria-label')).includes(targetLabel),
    );
    if (!source || !target) throw new Error('rects 找不到源/目标');
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return {
      window: windowInfo(),
      source: {
        x: sourceRect.left,
        y: sourceRect.top,
        w: sourceRect.width,
        h: sourceRect.height,
        center: center(source),
      },
      target: {
        x: targetRect.left,
        y: targetRect.top,
        w: targetRect.width,
        h: targetRect.height,
        center: center(target),
      },
    };
  }

  async function execute(command) {
    switch (command.type) {
      case 'env':
        return windowInfo();
      case 'clickText': {
        const selector =
          command.selector || 'button, a, [role="button"], [role="link"]';
        const nodes = Array.from(document.querySelectorAll(selector)).filter(visible);
        const target =
          nodes.find((el) => norm(el.textContent) === command.text) ||
          nodes.find((el) => norm(el.textContent).includes(command.text)) ||
          nodes.find((el) => norm(el.getAttribute('aria-label')) === command.text);
        if (!target) {
          throw new Error(`找不到可点击元素：${command.text}`);
        }
        target.click();
        await sleep(command.wait ?? 500);
        return windowInfo();
      }
      case 'gotoToday': {
        const nav = Array.from(
          document.querySelectorAll('a, button, [role="link"], [role="button"]'),
        ).find((el) => visible(el) && norm(el.textContent).includes('今天'));
        if (!nav) throw new Error('找不到「今天」入口');
        nav.click();
        const ready = await waitFor(
          () => document.querySelector('#today-title'),
          8000,
        );
        return { ready: !!ready, ...windowInfo() };
      }
      case 'view':
        clickTab(command.label);
        await sleep(250);
        return {
          activeTab: norm(
            document.querySelector('.task-tab[aria-pressed="true"]')?.textContent,
          ),
          quadrant: quadrantState(),
          board: boardState(),
        };
      case 'state':
        return { ...windowInfo(), quadrant: quadrantState(), board: boardState() };
      case 'rects':
        return rects(command.kind, command.title, command.targetLabel);
      case 'pointerDrag':
        return pointerDragSynthetic(command.kind, command.title, command.targetLabel);
      case 'pointerCancel':
        return pointerCancelSynthetic(command.title, command.targetLabel);
      case 'waitTask': {
        const found = await waitFor(() => {
          const section = Array.from(
            document.querySelectorAll(
              command.kind === 'quadrant'
                ? '[data-drop-quadrant]'
                : '[data-drop-status]',
            ),
          ).find((el) =>
            norm(el.getAttribute('aria-label')).includes(command.targetLabel),
          );
          return section &&
            Array.from(section.querySelectorAll('[data-task-id]')).some((el) =>
              norm(el.textContent).includes(command.title),
            );
        }, command.timeout ?? 5000);
        return { found: !!found, ...windowInfo(), quadrant: quadrantState(), board: boardState() };
      }
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
