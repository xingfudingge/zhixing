/*
 * ZX11-FIX-ENC-01 桌面加密后端探针（独立 HOME，真实 Tauri IPC + 真实 SQLite）。
 *
 * 只验证本卡范围：明文哨兵笔记 → 启用加密 → 锁定 → 退出前，
 * IPC 不再返回明文，且启用报告中的旧页清理没有 warning。
 * UI 路由/弹层时序由既有 probe-encryption.js 覆盖；本探针避免 UI flake
 * 掩盖后端加密与明文清理结论。
 */
(() => {
  const PASS = 'zx11-fix-enc-correct-passphrase';
  const WRONG = 'zx11-fix-enc-wrong-passphrase';
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
  const findButton = (text, root = document, exact = true) =>
    Array.from(root.querySelectorAll('button')).find(
      (button) =>
        visible(button) &&
        (exact
          ? norm(button.textContent) === text
          : norm(button.textContent).includes(text)),
    );
  const invoke = (command, args) => {
    const fn = window.__TAURI_INTERNALS__?.invoke;
    if (typeof fn !== 'function') throw new Error('真实 Tauri IPC 不可用');
    return fn(command, args);
  };
  const errText = (reason) =>
    reason && typeof reason === 'object'
      ? (() => {
          try {
            return JSON.stringify(reason);
          } catch {
            return String(reason);
          }
        })()
      : String(reason);
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

      const initialStatus = await invoke('note_encryption_status');
      record('initial-status', initialStatus);
      check(
        '加密初始未配置',
        initialStatus?.supported === true &&
          initialStatus?.configured === false &&
          initialStatus?.enabled === false,
        initialStatus,
      );

      const note = await invoke('notes_create', {
        input: {
          title: `ZX11 加密验收 ${SENTINEL}`,
          body: `<p>${SENTINEL} 正文不得泄漏</p>`,
          bodyFormat: 'html',
          folderId: null,
        },
      });
      record('created-note', {
        id: note.id,
        title: note.title,
        body: note.body,
      });
      check(
        '明文哨兵笔记创建成功',
        String(note.title).includes(SENTINEL) &&
          String(note.body).includes(SENTINEL),
        note,
      );

      let report = null;
      try {
        report = await invoke('note_encryption_enable', { passphrase: PASS });
        record('enable-report', report);
        check(
          '启用加密成功且旧页清理无 warning',
          report?.transformed?.notes >= 1 && report?.warning === null,
          report,
        );
      } catch (reason) {
        check('启用加密成功且旧页清理无 warning', false, {
          error: errText(reason),
        });
      }

      const unlockedStatus = await invoke('note_encryption_status');
      record('unlocked-status', unlockedStatus);
      check(
        '启用后状态为已加密未锁定',
        unlockedStatus?.configured === true &&
          unlockedStatus?.enabled === true &&
          unlockedStatus?.locked === false &&
          unlockedStatus?.encryptedNotes >= 1 &&
          unlockedStatus?.plaintextNotes === 0,
        unlockedStatus,
      );
      const unlockedNote = await invoke('notes_get', { id: note.id });
      check(
        '解锁时可读明文',
        String(unlockedNote?.body).includes(SENTINEL) &&
          unlockedNote?.locked !== true,
        unlockedNote,
      );

      const lockedStatus = await invoke('note_encryption_lock');
      record('locked-status', lockedStatus);
      check(
        '锁定后状态为 locked',
        lockedStatus?.locked === true && lockedStatus?.enabled === true,
        lockedStatus,
      );
      const lockedNote = await invoke('notes_get', { id: note.id });
      record('locked-note', {
        id: lockedNote?.id,
        title: lockedNote?.title,
        body: lockedNote?.body,
        locked: lockedNote?.locked,
        encrypted: lockedNote?.encrypted,
      });
      check(
        '锁定后单篇不返回明文',
        lockedNote?.locked === true &&
          !String(lockedNote?.title ?? '').includes(SENTINEL) &&
          !String(lockedNote?.body ?? '').includes(SENTINEL),
        lockedNote,
      );
      const lockedList = await invoke('notes_list', { query: null });
      check(
        '锁定后列表不返回明文',
        !JSON.stringify(lockedList).includes(SENTINEL),
        { count: lockedList?.length },
      );
      const exportRows = await invoke('notes_export_rows');
      check(
        '锁定后完整备份原始行不含明文',
        !JSON.stringify(exportRows).includes(SENTINEL),
        { count: exportRows?.length },
      );

      let wrongIpc = null;
      try {
        await invoke('note_encryption_unlock', { passphrase: WRONG });
        wrongIpc = { ok: true, message: '错误口令被接受' };
      } catch (reason) {
        wrongIpc = { ok: false, message: errText(reason) };
      }
      check(
        '错误口令 IPC 返回具体错误',
        wrongIpc.ok === false &&
          /口令|密钥|解密|错误|不正确/.test(wrongIpc.message) &&
          !/未知错误|undefined/.test(wrongIpc.message),
        wrongIpc,
      );

      const unlocked = await invoke('note_encryption_unlock', { passphrase: PASS });
      record('unlocked-again', unlocked);
      const restored = await invoke('notes_get', { id: note.id });
      check(
        '正确口令恢复明文',
        restored?.locked !== true &&
          String(restored?.body).includes(SENTINEL),
        restored,
      );

      const finalLock = await invoke('note_encryption_lock');
      record('final-lock', finalLock);
      const finalNote = await invoke('notes_get', { id: note.id });
      check(
        '退出前保持锁定且无明文',
        finalLock?.locked === true &&
          finalNote?.locked === true &&
          !String(finalNote?.body ?? '').includes(SENTINEL),
        { lock: finalLock, note: finalNote },
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
