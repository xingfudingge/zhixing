/*
 * ZX11-QA-01 加密/诊断探针（独立 HOME，真实 SQLite + 真实 WKWebView）。
 *
 * 创建明文哨兵笔记 → 启用加密 → 锁定 → 读取/搜索/导出均不得出现明文；
 * 错误口令必须给具体错误；正确口令恢复；更改口令后旧口令失效；
 * 导出的信封不含明文/口令；诊断默认关闭。
 */
(() => {
  const PASS = 'zx11-test-passphrase-2026';
  const NEW_PASS = 'zx11-test-passphrase-2027';
  const WRONG = 'zx11-wrong-passphrase-2026';
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
  const byAria = (label) =>
    Array.from(document.querySelectorAll('[aria-label]')).find(
      (el) => el.getAttribute('aria-label') === label && visible(el),
    );
  const findButton = (text, root = document, exact = true) =>
    Array.from(root.querySelectorAll('button')).find(
      (button) =>
        visible(button) &&
        (exact
          ? norm(button.textContent) === text
          : norm(button.textContent).includes(text)),
    );
  const setInput = (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
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
  async function go(url, heading) {
    history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(
      () => norm(document.querySelector('h1')?.textContent).includes(heading),
      15_000,
      `${url} 页面标题`,
    );
    await sleep(300);
  }
  async function settings() {
    return invoke('settings_list', { query: null });
  }
  async function settingValue(key) {
    return (await settings()).find((row) => row.key === key)?.value;
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
      check(
        '诊断默认关闭',
        (await settingValue('privacy.diagnosticsEnabled')) === undefined ||
          (await settingValue('privacy.diagnosticsEnabled')) === false,
        await settingValue('privacy.diagnosticsEnabled'),
      );

      // 创建明文哨兵笔记。
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

      // 启用加密。
      let report = null;
      try {
        report = await invoke('note_encryption_enable', { passphrase: PASS });
        record('enable-report', report);
        check(
          '启用加密成功且报告真实计数',
          report?.transformed?.notes >= 1,
          report,
        );
      } catch (reason) {
        check('启用加密成功且报告真实计数', false, {
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
          unlockedStatus?.encryptedNotes >= 1,
        unlockedStatus,
      );
      const unlockedNote = await invoke('notes_get', { id: note.id });
      check(
        '解锁时可读明文',
        String(unlockedNote?.body).includes(SENTINEL) &&
          unlockedNote?.locked !== true,
        unlockedNote,
      );

      // 锁定：读取、列表、搜索、导出都不得出现明文。
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
        { count: lockedList?.length, sample: lockedList?.[0] },
      );
      const exportRows = await invoke('notes_export_rows');
      check(
        '锁定后完整备份原始行不含明文',
        !JSON.stringify(exportRows).includes(SENTINEL),
        { count: exportRows?.length },
      );

      // 搜索 UI 不返回明文。
      await go('/knowledge', '知识');
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
      );
      let searchState = null;
      try {
        const input = await waitFor(
          () => document.querySelector('input[aria-label="搜索本机数据"]'),
          8000,
          '搜索输入框',
        );
        setInput(input, SENTINEL);
        await sleep(1200);
        const bodyText = norm(document.querySelector('[role="dialog"]')?.innerText ?? document.body.innerText);
        searchState = {
          opened: true,
          includesSentinel: bodyText.includes(SENTINEL),
          text: bodyText.slice(0, 400),
        };
        check(
          '锁定笔记不参与搜索',
          !searchState.includesSentinel,
          searchState,
        );
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        await sleep(300);
      } catch (reason) {
        searchState = { opened: false, error: errText(reason) };
        check('锁定笔记不参与搜索', false, searchState);
      }

      // 锁定笔记深链只显示锁定卡，不含正文哨兵。
      await go(`/knowledge?note=${encodeURIComponent(note.id)}`, '知识');
      const lockedView = await (async () => {
        await waitFor(
          () => document.querySelector('.kn-locked-note'),
          10_000,
          '锁定笔记卡',
        );
        const text = norm(document.body.innerText);
        return {
          text: text.slice(0, 500),
          includesSentinel: text.includes(SENTINEL),
          includesLockedCopy: text.includes('这篇笔记已加密并锁定'),
        };
      })();
      check(
        '锁定笔记页不泄漏正文',
        lockedView.includesLockedCopy && !lockedView.includesSentinel,
        lockedView,
      );

      // 错误口令：IPC 与 UI 都必须具体报错。
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

      await go('/settings/privacy', '设置');
      const wrongUi = await (async () => {
        const actions = await waitFor(
          () => document.querySelector('.settings-encryption-actions'),
          10_000,
          '加密操作区',
        );
        const unlock = Array.from(actions.querySelectorAll('button')).find(
          (button) => norm(button.textContent) === '解锁',
        );
        if (!unlock) throw new Error('找不到解锁按钮');
        unlock.click();
        const dialog = await waitFor(
          () => document.querySelector('[role="dialog"]'),
          6000,
          '解锁弹层',
        );
        const input = dialog.querySelector('input[type="password"]');
        if (!input) throw new Error('解锁弹层没有口令输入框');
        setInput(input, WRONG);
        const submit = Array.from(dialog.querySelectorAll('button')).find(
          (button) => norm(button.textContent) === '解锁',
        );
        if (!submit) throw new Error('解锁弹层没有提交按钮');
        submit.click();
        const error = await waitFor(
          () => dialog.querySelector('.settings-error'),
          12000,
          '错误口令提示',
        );
        const text = norm(error.textContent);
        const cancel = Array.from(dialog.querySelectorAll('button')).find(
          (button) => norm(button.textContent) === '取消',
        );
        cancel?.click();
        await sleep(400);
        return { text };
      })();
      check(
        '错误口令 UI 显示具体错误',
        /口令|密钥|解密|错误|不正确/.test(wrongUi.text),
        wrongUi,
      );

      // 正确口令恢复明文。
      const unlocked = await invoke('note_encryption_unlock', { passphrase: PASS });
      record('unlocked-again', unlocked);
      const restored = await invoke('notes_get', { id: note.id });
      check(
        '正确口令恢复明文',
        restored?.locked !== true &&
          String(restored?.body).includes(SENTINEL),
        restored,
      );

      // 更改口令：旧口令失效，新口令可解锁。
      let changeWrong = null;
      try {
        await invoke('note_encryption_change_passphrase', {
          currentPassphrase: WRONG,
          nextPassphrase: NEW_PASS,
        });
        changeWrong = { ok: true };
      } catch (reason) {
        changeWrong = { ok: false, message: errText(reason) };
      }
      check(
        '更改口令时旧口令错误被拒绝',
        changeWrong.ok === false && /口令|错误|不正确|解密/.test(changeWrong.message),
        changeWrong,
      );
      const changed = await invoke('note_encryption_change_passphrase', {
        currentPassphrase: PASS,
        nextPassphrase: NEW_PASS,
      });
      record('changed-passphrase', changed);
      await invoke('note_encryption_lock');
      let oldAfterChange = null;
      try {
        await invoke('note_encryption_unlock', { passphrase: PASS });
        oldAfterChange = { ok: true };
      } catch (reason) {
        oldAfterChange = { ok: false, message: errText(reason) };
      }
      check(
        '更改口令后旧口令失效',
        oldAfterChange.ok === false,
        oldAfterChange,
      );
      const newUnlock = await invoke('note_encryption_unlock', {
        passphrase: NEW_PASS,
      });
      check(
        '更改口令后新口令可解锁',
        newUnlock?.locked === false,
        newUnlock,
      );

      // 信封导出不含明文/口令；再锁定供重启探针检查。
      const envelope = await invoke('note_encryption_export_envelope');
      record('envelope', {
        length: typeof envelope === 'string' ? envelope.length : null,
        includesSentinel: String(envelope).includes(SENTINEL),
        includesPassphrase:
          String(envelope).includes(PASS) || String(envelope).includes(NEW_PASS),
        preview: typeof envelope === 'string' ? envelope.slice(0, 120) : null,
      });
      check(
        '导出的密钥信封不含明文/口令',
        typeof envelope === 'string' &&
          envelope.length > 20 &&
          !envelope.includes(SENTINEL) &&
          !envelope.includes(PASS) &&
          !envelope.includes(NEW_PASS),
        {
          length: typeof envelope === 'string' ? envelope.length : null,
          includesSentinel: String(envelope).includes(SENTINEL),
          includesPassphrase:
            String(envelope).includes(PASS) ||
            String(envelope).includes(NEW_PASS),
        },
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

      // 诊断 UI 默认关闭且无上传承诺。
      await go('/settings/privacy', '设置');
      const diagnostics = await (async () => {
        const switchEl = await waitFor(
          () => byAria('开启本机诊断记录'),
          8000,
          '诊断开关',
        );
        await sleep(400);
        return {
          checked: switchEl.getAttribute('aria-checked'),
          stored: (await settingValue('privacy.diagnosticsEnabled')) ?? false,
          text: norm(document.querySelector('.settings-body')?.innerText).slice(
            0,
            1600,
          ),
        };
      })();
      check(
        '诊断默认关闭且说明仅本机',
        diagnostics.checked === 'false' &&
          diagnostics.stored === false &&
          diagnostics.text.includes('本机') &&
          diagnostics.text.includes('没有任何上传端点'),
        diagnostics,
      );

      state.finishedAt = new Date().toISOString();
      state.ok = state.failures.length === 0;
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
