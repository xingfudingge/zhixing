/**
 * ZX-EXPORT-02 真实 Tauri WebView 探针：画板导出 PNG → 插入笔记 → 预览。
 *
 * 约束：
 * - 只通过真实产品 IPC 造数据、只派发真实 DOM 事件；
 * - 不替换前端保存逻辑，仅把原生保存面板命令换成同一个 Rust 写入命令
 *   （见 Node 侧对 dist JS 的 `save_board_export_file -> save_export_file`
 *   注入），PNG 生成、尺寸计划、插入笔记全部走产品代码；
 * - 收集 console.error / window.error / unhandledrejection。
 */
(function () {
  const ERROR_KEY = 'zx-export-02-errors';
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

  const NOTE_ID = 'zx-export-02-note';
  const NOTE_TITLE = '画板导出验收';
  const BOARD_ID = 'zx-export-02-board';
  const BOARD_TITLE = '发布流程导出画板';
  const PREFIX = 'zx-export-02-';

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

  async function waitFor(check, timeout = 15_000, interval = 60) {
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

  function dialog() {
    return Array.from(document.querySelectorAll('[role="dialog"]')).find(
      visible,
    );
  }

  function buttonByLabel(label) {
    return Array.from(document.querySelectorAll('button')).find(
      (button) =>
        visible(button) &&
        (norm(button.getAttribute('aria-label')) === label ||
          norm(button.textContent) === label),
    );
  }

  function radioLabel(input) {
    return norm(input.closest('label')?.textContent);
  }

  function navigate(pathname) {
    history.pushState({}, '', pathname);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  async function seed() {
    try {
      sessionStorage.removeItem(ERROR_KEY);
    } catch {
      /* ignore */
    }
    errors = [];

    const existingBoards = await invoke('boards_list', { query: {} });
    for (const board of existingBoards) {
      if (String(board.id).startsWith(PREFIX)) {
        try {
          await invoke('boards_delete', { id: board.id });
        } catch {
          /* ignore */
        }
      }
    }
    const existingNotes = await invoke('notes_list', {
      query: { includeDeleted: true },
    });
    for (const note of existingNotes) {
      if (String(note.id).startsWith(PREFIX)) {
        try {
          await invoke('notes_delete', { id: note.id });
        } catch {
          /* ignore */
        }
      }
    }

    await invoke('notes_create', {
      input: {
        id: NOTE_ID,
        title: NOTE_TITLE,
        body: '<p>画板导出与插入验收。</p>',
        bodyFormat: 'html',
        status: 'active',
      },
    });

    await invoke('note_blocks_create', {
      input: {
        id: 'zx-export-02-b01',
        noteId: NOTE_ID,
        blockType: 'paragraph',
        orderKey: 1024,
        payload: { runs: [{ text: '画板导出与插入验收。' }] },
      },
    });
    await invoke('note_blocks_create', {
      input: {
        id: 'zx-export-02-b02',
        noteId: NOTE_ID,
        blockType: 'board',
        orderKey: 2048,
        payload: { boardId: BOARD_ID, title: BOARD_TITLE },
      },
    });

    await invoke('boards_create', {
      input: {
        id: BOARD_ID,
        noteId: NOTE_ID,
        title: BOARD_TITLE,
        background: 'dot',
        snapshot: { version: 1 },
      },
    });

    const nodes = [
      {
        id: 'zx-export-02-lane',
        nodeType: 'frame',
        x: 40,
        y: 40,
        width: 760,
        height: 320,
        zIndex: 0,
        text: '泳道：发布流程',
        payload: {
          style: { fill: '#f4f7fc', stroke: '#c9d6e8' },
        },
      },
      {
        id: 'zx-export-02-sticky',
        nodeType: 'sticky',
        x: 90,
        y: 130,
        width: 170,
        height: 100,
        zIndex: 1,
        text: '便签：导出完整',
        payload: {
          style: { fill: '#fbf4df', stroke: '#e2cf9e' },
        },
      },
      {
        id: 'zx-export-02-rect',
        nodeType: 'rect',
        x: 380,
        y: 140,
        width: 190,
        height: 80,
        zIndex: 2,
        text: '矩形节点',
        payload: {},
      },
      {
        id: 'zx-export-02-text',
        nodeType: 'text',
        x: 620,
        y: 150,
        width: 150,
        height: 40,
        zIndex: 3,
        text: '文字对象',
        payload: {},
      },
    ];
    for (const node of nodes) {
      await invoke('board_nodes_create', {
        input: { ...node, boardId: BOARD_ID },
      });
    }
    const edges = [
      {
        id: 'zx-export-02-edge-1',
        fromNodeId: 'zx-export-02-sticky',
        toNodeId: 'zx-export-02-rect',
        label: '数据流',
        style: {
          routing: 'elbow',
          arrow: 'end',
          color: 'var(--board-connector)',
          width: 2,
          fromSide: 'r',
          toSide: 'l',
        },
      },
      {
        id: 'zx-export-02-edge-2',
        fromNodeId: 'zx-export-02-rect',
        toNodeId: 'zx-export-02-text',
        label: '完成',
        style: {
          routing: 'curve',
          arrow: 'both',
          color: 'var(--board-connector)',
          width: 2,
          fromSide: 'r',
          toSide: 'l',
        },
      },
    ];
    for (const edge of edges) {
      await invoke('board_edges_create', {
        input: { ...edge, boardId: BOARD_ID },
      });
    }

    return {
      noteId: NOTE_ID,
      boardId: BOARD_ID,
      nodes: nodes.length,
      edges: edges.length,
    };
  }

  async function openBoard() {
    navigate(
      `/board/${encodeURIComponent(BOARD_ID)}?note=${encodeURIComponent(
        NOTE_ID,
      )}`,
    );
    const root = await waitFor(() => document.querySelector('.bw-root'), 15_000);
    if (!root) throw new Error('画板工作区未加载');
    const title = await waitFor(() => {
      const input = document.querySelector('input.bw-title-input');
      return input && input.value === BOARD_TITLE ? input : null;
    }, 10_000);
    if (!title) throw new Error('画板标题未就绪');
    await waitFor(
      () => norm(document.body.textContent).includes('4 个对象'),
      10_000,
    );
    return true;
  }

  async function exportPanel() {
    let panel = dialog();
    if (!panel) {
      const trigger = await waitFor(
        () => buttonByLabel('导出画板 PNG'),
        6000,
      );
      if (!trigger) throw new Error('找不到「导出 PNG」入口');
      trigger.click();
      panel = await waitFor(() => dialog(), 5000);
    }
    if (!panel) throw new Error('导出面板未打开');
    const backgrounds = Array.from(
      panel.querySelectorAll('input[name="bw-export-background"]'),
    ).map(radioLabel);
    const scales = Array.from(
      panel.querySelectorAll('input[name="bw-export-scale"]'),
    ).map(radioLabel);
    return {
      heading: norm(panel.querySelector('h2')?.textContent),
      backgrounds,
      scales,
      summary: norm(panel.querySelector('.bw-export-summary')?.textContent),
      warning: norm(panel.querySelector('.bw-export-warning')?.textContent),
    };
  }

  async function setOption(command) {
    const panel = dialog();
    if (!panel) throw new Error('导出面板未打开');
    const input = panel.querySelector(
      `input[name="${command.name}"][value="${command.value}"]`,
    );
    if (!input) throw new Error(`找不到选项 ${command.name}=${command.value}`);
    input.click();
    await sleep(160);
    return {
      name: command.name,
      value: command.value,
      checked: input.checked,
      summary: norm(panel.querySelector('.bw-export-summary')?.textContent),
    };
  }

  async function waitExportMessage(fragment, timeout = 25_000) {
    return waitFor(() => {
      const panel = dialog();
      const message = panel?.querySelector('.bw-export-message');
      return message && norm(message.textContent).includes(fragment)
        ? message
        : null;
    }, timeout);
  }

  async function savePng() {
    if (!dialog()) await exportPanel();
    const panel = dialog();
    if (!panel) throw new Error('导出面板未打开');
    const save = Array.from(panel.querySelectorAll('button')).find(
      (button) => norm(button.textContent) === '保存 PNG',
    );
    if (!save) throw new Error('找不到「保存 PNG」按钮');
    if (save.disabled) throw new Error('「保存 PNG」按钮不可用');
    const previous = norm(
      panel.querySelector('.bw-export-message')?.textContent,
    );
    save.click();
    const message = await waitFor(() => {
      const current = dialog();
      const next = current?.querySelector('.bw-export-message');
      const text = norm(next?.textContent);
      return text && text.includes('已保存 PNG') && text !== previous
        ? next
        : null;
    }, 25_000);
    if (!message) throw new Error('保存 PNG 未完成');
    const text = norm(message.textContent);
    const match = text.match(/（(\/[^）]+?\.png)）/i);
    if (!match) throw new Error(`保存消息里没有真实路径：${text}`);
    return { text, path: match[1] };
  }

  async function insertIntoNote() {
    if (!dialog()) await exportPanel();
    const panel = dialog();
    if (!panel) throw new Error('导出面板未打开');
    const insert = Array.from(panel.querySelectorAll('button')).find(
      (button) => norm(button.textContent) === '插入到笔记',
    );
    if (!insert) throw new Error('导出面板没有「插入到笔记」');
    if (insert.disabled) throw new Error('「插入到笔记」按钮不可用');
    insert.click();
    const message = await waitExportMessage('已插入当前笔记末尾', 30_000);
    if (!message) throw new Error('插入笔记未完成');
    await sleep(600);
    return { text: norm(message.textContent) };
  }

  async function boardSnapshot() {
    const [board, nodes, edges] = await Promise.all([
      invoke('boards_get', { id: BOARD_ID }),
      invoke('board_nodes_list', { boardId: BOARD_ID, includeDeleted: false }),
      invoke('board_edges_list', { boardId: BOARD_ID, includeDeleted: false }),
    ]);
    const pickNode = (node) => ({
      id: node.id,
      type: node.nodeType ?? node.type,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      text: node.text,
      payload: node.payload,
    });
    const pickEdge = (edge) => ({
      id: edge.id,
      from: edge.fromNodeId,
      to: edge.toNodeId,
      label: edge.label,
      style: edge.style,
    });
    return {
      title: board.title,
      nodes: nodes.map(pickNode).sort((a, b) => a.id.localeCompare(b.id)),
      edges: edges.map(pickEdge).sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  async function noteSnapshot() {
    const blocks = await invoke('note_blocks_list', {
      noteId: NOTE_ID,
      includeDeleted: false,
    });
    const fileBlocks = blocks
      .filter((block) => block.blockType === 'file')
      .map((block) => ({
        id: block.id,
        fileName: block.payload?.fileName,
        mime: block.payload?.mime,
        attachmentId: block.payload?.attachmentId,
      }));
    const attachments = await invoke('attachments_list', { query: {} });
    const target = fileBlocks[0];
    const attachment = target
      ? attachments.find((item) => item.id === target.attachmentId) ?? null
      : null;
    return {
      blockCount: blocks.length,
      fileBlocks,
      attachment: attachment
        ? {
            id: attachment.id,
            noteId: attachment.noteId,
            blockId: attachment.blockId,
            fileName: attachment.fileName,
            mime: attachment.mime,
            byteSize: attachment.byteSize,
          }
        : null,
    };
  }

  async function openNoteAndPreview() {
    navigate(`/knowledge?note=${encodeURIComponent(NOTE_ID)}`);
    const title = await waitFor(() => {
      const input = document.querySelector('input[aria-label="笔记标题"]');
      return input && input.value === NOTE_TITLE ? input : null;
    }, 15_000);
    if (!title) throw new Error('笔记标题未就绪');

    const card = await waitFor(
      () => document.querySelector('.zxe-filecard'),
      15_000,
    );
    if (!card) throw new Error('正文里没有导出的文件卡');
    const label = norm(card.getAttribute('aria-label')).replace(/^文件卡：/, '');

    const local = await waitFor(
      () => {
        const current = document.querySelector('.zxe-filecard');
        return current?.getAttribute('data-file-state') === 'local'
          ? current
          : null;
      },
      15_000,
    );
    if (!local) {
      const current = document.querySelector('.zxe-filecard');
      throw new Error(
        `文件卡不是本机可用状态：${current?.getAttribute(
          'data-file-state',
        )} ${norm(current?.textContent)}`,
      );
    }

    const open = Array.from(local.querySelectorAll('button')).find((button) =>
      norm(button.getAttribute('aria-label')).startsWith('打开文件 '),
    );
    if (!open) throw new Error('文件卡没有「打开」按钮');
    open.click();

    const preview = await waitFor(() => {
      const current = Array.from(
        document.querySelectorAll('[role="dialog"]'),
      ).find(
        (item) =>
          visible(item) &&
          norm(item.getAttribute('aria-label')).startsWith('图片预览：'),
      );
      const img = current?.querySelector('img');
      return img && img.complete && img.naturalWidth > 0
        ? { dialog: current, img }
        : null;
    }, 15_000);
    if (!preview) throw new Error('图片预览未真实加载');

    return {
      fileCardLabel: label,
      dialogLabel: norm(preview.dialog.getAttribute('aria-label')),
      imgNaturalWidth: preview.img.naturalWidth,
      imgNaturalHeight: preview.img.naturalHeight,
      srcPrefix: String(preview.img.src).slice(0, 24),
    };
  }

  async function closeDialogs() {
    let closed = true;
    for (let index = 0; index < 4; index += 1) {
      const current = dialog();
      if (!current) break;
      const close = Array.from(current.querySelectorAll('button')).find(
        (button) =>
          norm(button.textContent) === '取消' ||
          norm(button.textContent) === '关闭' ||
          norm(button.getAttribute('aria-label')) === '关闭' ||
          norm(button.getAttribute('aria-label')) === '关闭图片预览',
      );
      if (!close) {
        closed = false;
        break;
      }
      close.click();
      await sleep(160);
    }
    return closed && !dialog();
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
      const button = await waitFor(() => buttonByLabel(command.label), 6000);
      if (!button) throw new Error(`找不到按钮「${command.label}」`);
      button.click();
      await sleep(command.wait || 300);
      return true;
    },
    seed,
    openBoard,
    exportPanel,
    setOption,
    savePng,
    insertIntoNote,
    boardSnapshot,
    noteSnapshot,
    openNoteAndPreview,
    closeDialogs,
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
