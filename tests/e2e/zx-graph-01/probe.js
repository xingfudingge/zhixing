/**
 * ZX-GRAPH-01 真实 Tauri WebView 探针：笔记内链关系图。
 *
 * 只通过真实产品 IPC 造数据、只派发真实 DOM 事件：
 *   * 关系图按 zhixing://note/<id> 生成有向边，节点显示标题；
 *   * 外部网页链接不进入图；
 *   * 指向不存在/回收站笔记的内链显示为断链；
 *   * 一跳 / 两跳 / 全部筛选；
 *   * 放大、重置、拖拽平移；
 *   * 点击节点打开目标笔记；
 *   * 空图有解释；
 *   * 收集 console.error / window.error / unhandledrejection。
 */
(function () {
  const ERROR_KEY = 'zx-graph-01-errors';
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

  const ROOT_ID = 'zx-graph-01-root';
  const ROOT_TITLE = '关系图来源';
  const MID_ID = 'zx-graph-01-mid';
  const MID_TITLE = '二跳来源';
  const DEEP_ID = 'zx-graph-01-deep';
  const DEEP_TITLE = '二跳笔记';
  const ISOLATED_ID = 'zx-graph-01-isolated';
  const ISOLATED_TITLE = '孤立笔记';
  const TRASHED_ID = 'zx-graph-01-trashed';
  const TRASHED_TITLE = '回收站目标';
  const MISSING_ID = 'zx-graph-01-missing';

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

  async function seed() {
    try {
      sessionStorage.removeItem(ERROR_KEY);
    } catch {
      /* ignore */
    }
    errors = [];
    // 清掉内置欢迎笔记，保证关系图统计只包含本卡种子数据。
    const existing = await invoke('notes_list', {
      query: { includeDeleted: true },
    });
    for (const note of existing) {
      if (!String(note.id).startsWith('zx-graph-01-')) {
        await invoke('notes_delete', { id: note.id });
      }
    }
    const notes = [
      {
        id: ROOT_ID,
        title: ROOT_TITLE,
        body: [
          `<p><a href="zhixing://note/${MID_ID}">${MID_TITLE}</a></p>`,
          '<p><a href="https://example.com/outside">外部链接</a></p>',
          `<p>zhixing://note/${MISSING_ID}</p>`,
          `<p>zhixing://note/${TRASHED_ID}</p>`,
        ].join(''),
        tags: ['ZX-GRAPH-01'],
      },
      {
        id: MID_ID,
        title: MID_TITLE,
        body: `<p><a href="zhixing://note/${DEEP_ID}">${DEEP_TITLE}</a></p>`,
        tags: ['ZX-GRAPH-01'],
      },
      {
        id: DEEP_ID,
        title: DEEP_TITLE,
        body: '<p>二跳正文。</p>',
        tags: ['ZX-GRAPH-01'],
      },
      {
        id: ISOLATED_ID,
        title: ISOLATED_TITLE,
        body: '<p>没有内链的孤立笔记。</p>',
        tags: ['ZX-GRAPH-01'],
      },
      {
        id: TRASHED_ID,
        title: TRASHED_TITLE,
        body: '<p>已在回收站。</p>',
        status: 'trashed',
        tags: ['ZX-GRAPH-01'],
      },
    ];
    for (const note of notes) {
      await invoke('notes_create', {
        input: { ...note, status: note.status || 'active' },
      });
    }
    // 给根笔记一个真实正文块，避免打开后编辑器为空导致后续行为不稳定。
    for (const [index, note] of [
      [0, ROOT_ID],
      [1, MID_ID],
      [2, DEEP_ID],
      [3, ISOLATED_ID],
    ]) {
      await invoke('note_blocks_create', {
        input: {
          id: `zx-graph-01-b${index}`,
          noteId: note,
          blockType: 'paragraph',
          orderKey: 1024,
          payload: {
            runs: [
              {
                text:
                  note === ROOT_ID
                    ? '关系图来源正文。'
                    : `正文 ${index}`,
              },
            ],
          },
        },
      });
    }
    return {
      rootId: ROOT_ID,
      rootTitle: ROOT_TITLE,
      midTitle: MID_TITLE,
      deepTitle: DEEP_TITLE,
      isolatedTitle: ISOLATED_TITLE,
      trashedTitle: TRASHED_TITLE,
      notes: notes.length,
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
    return title;
  }

  function panel() {
    return document.querySelector('aside[aria-label="笔记链接"]');
  }

  function graphSvg() {
    return document.querySelector('svg[aria-label="笔记关系图"]');
  }

  function clickText(root, text) {
    const button = Array.from(root.querySelectorAll('button')).find(
      (element) => visible(element) && norm(element.textContent) === text,
    );
    if (!button) throw new Error(`找不到按钮「${text}」`);
    button.click();
    return true;
  }

  async function openGraph() {
    const rail = await waitFor(
      () =>
        Array.from(document.querySelectorAll('button[aria-label]')).find(
          (el) =>
            visible(el) && norm(el.getAttribute('aria-label')) === '笔记链接',
        ),
      6000,
    );
    if (!rail) throw new Error('找不到「笔记链接」工具轨按钮');
    if (!panel()) {
      rail.click();
    }
    const aside = await waitFor(() => panel(), 6000);
    if (!aside) throw new Error('笔记链接面板未打开');
    const graphTab = Array.from(
      aside.querySelectorAll('[role="tab"]'),
    ).find((tab) => norm(tab.textContent) === '关系图');
    if (!graphTab) throw new Error('找不到「关系图」视图标签');
    graphTab.click();
    const svg = await waitFor(() => graphSvg(), 6000);
    if (!svg) throw new Error('关系图未渲染');
    return true;
  }

  function graphSnapshot() {
    const aside = panel();
    if (!aside) return null;
    const svg = graphSvg();
    const nodes = svg
      ? Array.from(svg.querySelectorAll('g[aria-label]')).map((node) => ({
          label: norm(node.getAttribute('aria-label')),
          text: norm(node.textContent),
          className: node.getAttribute('class'),
          transform: node.getAttribute('transform'),
        }))
      : [];
    const edges = svg
      ? Array.from(svg.querySelectorAll('path[data-direction]')).map(
          (path) => ({
            direction: path.getAttribute('data-direction'),
            broken: path.classList.contains('is-broken'),
            marker: path.getAttribute('marker-end'),
            title: norm(path.querySelector('title')?.textContent),
          }),
        )
      : [];
    return {
      stats: norm(aside.querySelector('.kn-graph-stats')?.textContent),
      nodes,
      edges,
      empty: norm(aside.querySelector('.kn-graph-empty')?.textContent),
      scope: norm(aside.querySelector('.kn-graph-scope')?.textContent),
      filter: Array.from(
        aside.querySelectorAll('.kn-graph-filter button'),
      ).map((button) => ({
        label: norm(button.textContent),
        pressed: button.getAttribute('aria-pressed'),
      })),
      zoom: svg ? svg.getAttribute('data-zoom') : null,
      svgWidth: svg ? svg.getBoundingClientRect().width : null,
      panelWidth: aside.getBoundingClientRect().width,
      panelPosition: getComputedStyle(aside).position,
    };
  }

  async function setDepth(command) {
    const aside = await waitFor(() => panel(), 4000);
    if (!aside) throw new Error('笔记链接面板未打开');
    clickText(
      aside.querySelector('.kn-graph-filter'),
      command.label || command.text,
    );
    await sleep(180);
    return graphSnapshot();
  }

  async function zoomAndPan() {
    const aside = await waitFor(() => panel(), 4000);
    if (!aside) throw new Error('笔记链接面板未打开');
    const svg = graphSvg();
    if (!svg) throw new Error('关系图未渲染');
    const group = svg.querySelector('g[transform]');
    const beforeZoom = svg.getAttribute('data-zoom');
    const beforeTransform = group?.getAttribute('transform') ?? null;

    const zoomIn = aside.querySelector('button[aria-label="放大关系图"]');
    if (!zoomIn) throw new Error('缺少放大按钮');
    zoomIn.click();
    await sleep(120);
    const afterZoom = svg.getAttribute('data-zoom');

    const rect = svg.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startY = rect.top + rect.height / 2;
    const pointer = (type, x, y) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: 'mouse',
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: y,
      });
    svg.dispatchEvent(pointer('pointerdown', startX, startY));
    svg.dispatchEvent(pointer('pointermove', startX + 70, startY + 36));
    svg.dispatchEvent(pointer('pointerup', startX + 70, startY + 36));
    await sleep(150);
    const afterPan = svg.querySelector('g[transform]')?.getAttribute('transform');

    const reset = aside.querySelector('button[aria-label="重置关系图"]');
    if (!reset) throw new Error('缺少重置按钮');
    reset.click();
    await sleep(120);
    const afterReset = svg.getAttribute('data-zoom');
    const resetTransform = svg
      .querySelector('g[transform]')
      ?.getAttribute('transform');

    return {
      beforeZoom,
      afterZoom,
      beforeTransform,
      afterPan,
      afterReset,
      resetTransform,
      panned: Boolean(beforeTransform && afterPan && beforeTransform !== afterPan),
    };
  }

  async function openGraphNode(command) {
    const labelPart = command.labelPart;
    const node = await waitFor(
      () =>
        Array.from(
          document.querySelectorAll(
            'svg[aria-label="笔记关系图"] g[aria-label^="打开关系图笔记："]',
          ),
        ).find((element) =>
          norm(element.getAttribute('aria-label')).includes(labelPart),
        ),
      6000,
    );
    if (!node) throw new Error(`关系图中找不到节点「${labelPart}」`);
    // 按真实点击顺序：pointerdown → pointerup → click，目标都是节点。
    node.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 9,
        pointerType: 'mouse',
        button: 0,
        buttons: 1,
      }),
    );
    node.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        pointerId: 9,
        pointerType: 'mouse',
        button: 0,
        buttons: 0,
      }),
    );
    node.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await sleep(60);
    const expected = command.expectTitle || labelPart;
    const title = await waitFor(
      () => {
        const input = document.querySelector('input[aria-label="笔记标题"]');
        return input && input.value.includes(expected) ? input.value : null;
      },
      8000,
    );
    return {
      openedTitle:
        document.querySelector('input[aria-label="笔记标题"]')?.value ?? null,
      expected,
      matched: Boolean(title),
    };
  }

  async function emptyState(command) {
    await openNote(command.title || ISOLATED_TITLE);
    await openGraph();
    await sleep(160);
    return graphSnapshot();
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
    async resize(command) {
      window.resizeTo(command.width, command.height);
      await sleep(500);
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
      };
    },
    async viewport() {
      const aside = panel();
      const svg = graphSvg();
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        panelWidth: aside ? aside.getBoundingClientRect().width : null,
        panelPosition: aside ? getComputedStyle(aside).position : null,
        svgWidth: svg ? svg.getBoundingClientRect().width : null,
        svgHeight: svg ? svg.getBoundingClientRect().height : null,
        paperWidth: document.querySelector('.kn-paper')
          ? document.querySelector('.kn-paper').getBoundingClientRect().width
          : null,
      };
    },
    seed,
    gotoKnowledge,
    async openNote(command) {
      return openNote(command.title || ROOT_TITLE);
    },
    openGraph,
    graph: graphSnapshot,
    setDepth,
    zoomAndPan,
    openGraphNode,
    emptyState,
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
