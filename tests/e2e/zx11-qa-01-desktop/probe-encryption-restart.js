/*
 * ZX11-FIX-ENC-01 重启探针：同一独立 HOME 二次启动，验证逻辑仍是加密且未泄漏明文。
 * 不修改数据，只读 IPC。
 */
(() => {
  const SENTINEL = 'ZX11-PLAINTEXT-SENTINEL-9f3a';
  const state = {
    startedAt: new Date().toISOString(),
    checks: [],
    steps: [],
    failures: [],
    consoleErrors: [],
    pageExceptions: [],
  };
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    state.consoleErrors.push(args.map(String).join(' '));
    originalError(...args);
  };
  window.addEventListener('error', (event) => {
    state.pageExceptions.push(
      `[window.error] ${event.message} @ ${event.filename}:${event.lineno}`,
    );
  });
  window.addEventListener('unhandledrejection', (event) => {
    state.pageExceptions.push(
      `[unhandledrejection] ${
        (event.reason && (event.reason.message || event.reason)) || 'unknown'
      }`,
    );
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  };
  const findButton = (text, root = document) =>
    Array.from(root.querySelectorAll('button')).find(
      (button) => visible(button) && norm(button.textContent) === text,
    );
  const invoke = (command, args) => {
    const fn = window.__TAURI_INTERNALS__?.invoke;
    if (typeof fn !== 'function') throw new Error('真实 Tauri IPC 不可用');
    return fn(command, args);
  };
  const check = (name, ok, detail) => {
    state.checks.push({ name, ok: Boolean(ok), detail });
    if (!ok) state.failures.push(`${name}：${JSON.stringify(detail)}`);
  };
  const record = (name, value) => {
    state.steps.push({ name, at: new Date().toISOString(), value });
  };
  async function waitFor(checkFn, timeout = 20_000, label = 'condition') {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const value = await checkFn();
        if (value) return value;
      } catch {
        /* retry */
      }
      await sleep(120);
    }
    throw new Error(`等待超时：${label}`);
  }

  (async () => {
    try {
      await waitFor(
        () =>
          document.querySelector('.shell') ||
          document.body.innerText.includes('开始 7 天试用'),
        25_000,
        '应用启动',
      );
      if (!document.querySelector('.shell')) {
        const trial = findButton('开始 7 天试用');
        if (!trial) throw new Error('激活页找不到“开始 7 天试用”');
        trial.click();
        await waitFor(() => document.querySelector('.shell'), 20_000, '试用后外壳');
      }

      const status = await invoke('note_encryption_status');
      record('restart-status', status);
      check(
        '重启后仍为已加密并锁定',
        status?.configured === true &&
          status?.enabled === true &&
          status?.locked === true &&
          status?.encryptedNotes >= 1 &&
          status?.plaintextNotes === 0,
        status,
      );

      const list = await invoke('notes_list', { query: null });
      check(
        '重启后列表不返回明文',
        !JSON.stringify(list).includes(SENTINEL) && list?.length >= 1,
        { count: list?.length },
      );
      const rows = await invoke('notes_export_rows');
      check(
        '重启后原始备份行仍为密文',
        !JSON.stringify(rows).includes(SENTINEL),
        { count: rows?.length },
      );

      state.finishedAt = new Date().toISOString();
      state.ok =
        state.failures.length === 0 &&
        state.consoleErrors.length === 0 &&
        state.pageExceptions.length === 0;
      fetch('/__result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      }).catch(() => undefined);
    } catch (reason) {
      state.failures.push(
        `未捕获异常：${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`,
      );
      state.finishedAt = new Date().toISOString();
      state.ok = false;
      fetch('/__result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      }).catch(() => undefined);
    }
  })();
})();
