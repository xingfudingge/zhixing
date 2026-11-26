/*
 * ZX11-FIX-OCR-01 主探针（真实 WKWebView + SQLite + Apple Vision）。
 *
 * 通过真实 IPC 创建一条笔记与一条图片附件，然后用真实 DOM 完成：
 * 启用 OCR → 指定目录（未选目录时按钮禁用）→ 选择目录 → 选择随附件同步
 * → 按范围排队 → 处理队列。所有结果来自 Apple Vision 与真实队列状态。
 */
(() => {
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
  const findButton = (text, exact = true) =>
    Array.from(document.querySelectorAll('button')).find(
      (button) =>
        visible(button) &&
        (exact
          ? norm(button.textContent) === text
          : norm(button.textContent).includes(text)),
    );
  const labelWith = (text) =>
    Array.from(document.querySelectorAll('label')).find((label) =>
      norm(label.textContent).includes(text),
    );
  const setSelect = (element, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    );
    descriptor.set.call(element, value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const invoke = (command, args) => {
    const fn = window.__TAURI_INTERNALS__?.invoke;
    if (typeof fn !== 'function') throw new Error('真实 Tauri IPC 不可用');
    return fn(command, args);
  };
  const errText = (reason) => {
    if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
    if (reason && typeof reason === 'object') {
      if (typeof reason.message === 'string') return reason.message;
      try {
        return JSON.stringify(reason);
      } catch {
        return String(reason);
      }
    }
    return String(reason);
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
    let last;
    while (Date.now() < deadline) {
      try {
        last = await checkFn();
        if (last) return last;
      } catch {
        /* retry */
      }
      await sleep(100);
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

  async function clickButton(text, exact = true) {
    const button = await waitFor(
      () => findButton(text, exact),
      10_000,
      `按钮 ${text}`,
    );
    button.click();
    await sleep(200);
    return button;
  }

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  async function putAttachmentData(blob, attachmentId, sha256) {
    const open = await new Promise((resolve, reject) => {
      const request = indexedDB.open('zhixing-attachments', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('blobs')) {
          db.createObjectStore('blobs');
        }
        if (!db.objectStoreNames.contains('attachment_state')) {
          db.createObjectStore('attachment_state', { keyPath: 'attachmentId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = open.transaction(
      ['blobs', 'attachment_state'],
      'readwrite',
    );
    transaction.objectStore('blobs').put(blob, `attachments/${sha256}`);
    transaction
      .objectStore('attachment_state')
      .put({
        attachmentId,
        status: 'local',
        localBlobKey: `attachments/${sha256}`,
        remoteId: null,
        uploadedPartIndexes: [],
        lastError: null,
        downloadedAt: null,
        updatedAt: new Date().toISOString(),
      });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    open.close();
  }

  function ocrSettings() {
    for (const key of Object.keys(localStorage)) {
      try {
        const parsed = JSON.parse(localStorage.getItem(key));
        if (
          parsed &&
          typeof parsed === 'object' &&
          'scope' in parsed &&
          'textStorage' in parsed &&
          'languages' in parsed
        ) {
          return parsed;
        }
      } catch {
        /* not JSON */
      }
    }
    return null;
  }

  /**
   * WKWebView 的 localStorage/IndexedDB 不随 HOME 重置而清空；探针必须在
   * 主阶段显式清掉上一次运行留下的 OCR 设置/作业，才能验证“未选目录”初始态。
   */
  async function resetOcrState() {
    for (const key of Object.keys(localStorage)) {
      try {
        const parsed = JSON.parse(localStorage.getItem(key));
        if (
          parsed &&
          typeof parsed === 'object' &&
          'scope' in parsed &&
          'textStorage' in parsed &&
          'languages' in parsed
        ) {
          localStorage.removeItem(key);
        }
      } catch {
        /* not JSON */
      }
    }
    localStorage.removeItem('zx-ocr-probe-stage');
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('zhixing-ocr');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
      setTimeout(resolve, 1500);
    });
  }

  async function report() {
    state.ok = state.failures.length === 0;
    await fetch('/__result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state),
    });
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
        await waitFor(
          () => document.querySelector('.shell'),
          20_000,
          '试用后进入外壳',
        );
      }

      await resetOcrState();

      // 真实数据：一条 f1 目录笔记 + 一张真实 PNG 附件。
      const note = await invoke('notes_create', {
        input: {
          id: 'ocr_probe_note_1',
          spaceId: 'personal',
          title: 'ZX11 OCR 探针笔记',
          folderId: 'f1',
          tags: ['ocr-probe'],
          body: '真实图片 OCR 探针',
          bodyFormat: 'html',
          status: 'active',
        },
      });
      check('创建 f1 目录笔记', note?.folderId === 'f1', {
        id: note?.id,
        folderId: note?.folderId,
      });

      const response = await fetch('/__fixtures/ocr-fixture.png');
      const blob = await response.blob();
      const bytes = await blob.arrayBuffer();
      const sha256 = await sha256Hex(bytes);
      const attachmentId = 'ocr_probe_attachment_1';
      await putAttachmentData(blob, attachmentId, sha256);
      await invoke('attachments_create', {
        input: {
          id: attachmentId,
          spaceId: 'personal',
          noteId: note.id,
          blockId: null,
          fileName: 'ocr-probe.png',
          sha256,
          byteSize: bytes.byteLength,
          mime: 'image/png',
          storageKey: `spaces/personal/assets/${sha256}`,
        },
      });
      check('创建真实图片附件', true, {
        attachmentId,
        byteSize: bytes.byteLength,
        sha256: sha256.slice(0, 12),
      });

      const capability = await invoke('ocr_probe');
      check(
        'Apple Vision 可用',
        capability?.available === true &&
          capability?.engineName === 'Apple Vision',
        capability,
      );

      await go('/settings/ocr', '设置');
      await waitFor(
        () => document.querySelector('.zx-ocr'),
        15_000,
        'OCR 面板',
      );

      const toggle = document.querySelector(
        '.zx-ocr-toggle input[type="checkbox"]',
      );
      if (!toggle) throw new Error('找不到启用图片 OCR 开关');
      toggle.click();
      await waitFor(() => toggle.checked === true, 5_000, 'OCR 开关生效');
      check('启用图片 OCR', toggle.checked === true, { checked: toggle.checked });

      const scope = document.querySelector('select[aria-label="识别范围"]');
      if (!scope) throw new Error('找不到识别范围选择器');
      setSelect(scope, 'folder');
      await waitFor(
        () =>
          document.querySelector('select[aria-label="OCR 指定目录"]'),
        10_000,
        '目录选择器',
      );
      check('指定目录出现目录选择器', true, {
        value: document.querySelector('select[aria-label="OCR 指定目录"]').value,
      });

      const disabledQueueButton = await waitFor(
        () => {
          const button = findButton('按范围排队');
          return button && button.disabled ? button : null;
        },
        10_000,
        '未选目录时按范围排队禁用',
      );
      check('未选目录时按范围排队禁用', disabledQueueButton.disabled === true, {
        disabled: disabledQueueButton.disabled,
      });
      check(
        '未选目录时明确提示',
        norm(document.body.innerText).includes('尚未选择知识库目录'),
        {
          text: norm(document.querySelector('.zx-ocr')?.innerText).slice(0, 500),
        },
      );

      const folder = document.querySelector('select[aria-label="OCR 指定目录"]');
      setSelect(folder, 'f1');
      const queueButton = await waitFor(
        () => {
          const button = findButton('按范围排队');
          return button && !button.disabled ? button : null;
        },
        10_000,
        '选择目录后按范围排队可用',
      );
      const savedScope = ocrSettings();
      check(
        '目录选择写入设备偏好',
        savedScope?.scope === 'folder' && savedScope?.scopeFolderId === 'f1',
        savedScope,
      );
      check('选择目录后按范围排队可用', queueButton.disabled === false, {
        disabled: queueButton.disabled,
      });

      const syncRadio = labelWith('随附件同步')?.querySelector(
        'input[type="radio"]',
      );
      if (!syncRadio) throw new Error('找不到随附件同步选项');
      syncRadio.click();
      await sleep(250);
      const savedStorage = ocrSettings();
      check(
        '文本保存位置=sync 写入设备偏好',
        savedStorage?.textStorage === 'sync',
        savedStorage?.textStorage,
      );
      check(
        '仅本机模式明确说明同步不可用',
        norm(document.body.innerText).includes('当前同步模式为仅本机'),
        { text: norm(document.body.innerText).slice(0, 400) },
      );

      const processButton = await waitFor(
        () => findButton('处理队列'),
        10_000,
        '处理队列按钮',
      );
      check('处理队列按钮可用', processButton.disabled === false, {
        disabled: processButton.disabled,
      });

      queueButton.click();
      await waitFor(
        () => norm(document.querySelector('.zx-ocr-queue')?.innerText).includes(attachmentId),
        20_000,
        '队列出现真实附件',
      );
      const queuedText = norm(document.querySelector('.zx-ocr-queue')?.innerText);
      check('按范围排队生成待处理作业', queuedText.includes('待处理'), {
        queue: queuedText.slice(0, 500),
      });

      processButton.click();
      await waitFor(
        () => norm(document.querySelector('.zx-ocr-queue')?.innerText).includes('已完成'),
        40_000,
        'OCR 作业完成',
      );
      const completedText = norm(document.querySelector('.zx-ocr-queue')?.innerText);
      check(
        '处理队列使用真实原图并完成 Apple Vision 识别',
        /ZHIXING|ACCEPTANCE/i.test(completedText),
        { queue: completedText.slice(0, 800) },
      );
      check(
        'sync 作业真实尝试并被明确标记失败（仅本机模式）',
        completedText.includes('同步入队失败') &&
          completedText.includes('仅本机'),
        { queue: completedText.slice(0, 800) },
      );

      check('页面无未处理异常', state.pageExceptions.length === 0, {
        pageExceptions: state.pageExceptions,
      });
      check('控制台无错误', state.consoleErrors.length === 0, {
        consoleErrors: state.consoleErrors,
      });

      localStorage.setItem('zx-ocr-probe-stage', 'restart');
      record('stage', 'main-complete');
    } catch (reason) {
      check('探针未捕获异常', false, { error: errText(reason) });
    } finally {
      await report();
    }
  })();
})();
