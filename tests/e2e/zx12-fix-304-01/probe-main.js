/*
 * ZX12-FIX-304-01 桌面探针（真实 Tauri/WKWebView + Rust http_fetch_text）。
 *
 * 只操作产品 DOM；节假日远端请求必须经 Rust 代理，探针包装
 * window.__TAURI_INTERNALS__.invoke 记录 http_fetch_text 的 URL、条件头与
 * 真实状态码。三个源各同步两次，第二次必须出现 304；同时记录 window.fetch
 * 是否出现任何节假日远端直连（应为 0）。
 */
(() => {
  const state = {
    startedAt: new Date().toISOString(),
    checks: [],
    steps: [],
    failures: [],
    consoleErrors: [],
    pageExceptions: [],
    cspViolations: [],
    proxyLog: [],
    ipcLog: [],
    fetchLog: [],
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
  document.addEventListener('securitypolicyviolation', (event) => {
    state.cspViolations.push({
      blockedURI: event.blockedURI,
      violatedDirective: event.violatedDirective,
    });
  });

  // 记录所有 WebView fetch；节假日链路不应出现任何远端直连。
  // Tauri v2 的 IPC 也走 fetch(ipc://localhost/<command>)，因此这里同时
  // 抓取 http_fetch_text 的请求参数与响应正文，作为真实代理证据。
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input && typeof input === 'object' && 'url' in input
          ? input.url
          : String(input);
    const isProxy = url.includes('/http_fetch_text');
    state.fetchLog.push({
      url,
      at: new Date().toISOString(),
      requestBody: isProxy && typeof init?.body === 'string' ? init.body : null,
    });
    const response = await nativeFetch(input, init);
    if (isProxy) {
      try {
        const text = await response.clone().text();
        state.ipcLog.push({
          url,
          requestBody: isProxy && typeof init?.body === 'string' ? init.body : null,
          responseText: text,
          status: response.status,
          at: new Date().toISOString(),
        });
      } catch (error) {
        state.ipcLog.push({
          url,
          error: String(error),
          at: new Date().toISOString(),
        });
      }
    }
    return response;
  };

  // 记录 Rust 受限代理调用；包装后仍走真实 IPC，不替换产品实现。
  // Tauri 在 WebView 初始化后才挂__TAURI_INTERNALS__，因此启动完成后再包装。
  function installProxyLog() {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') return false;
    if (internals.__zx12Fix304Wrapped) return true;
    const originalInvoke = internals.invoke.bind(internals);
    internals.__zx12Fix304Wrapped = true;
    internals.invoke = (command, args, options) => {
      if (command !== 'http_fetch_text') {
        return originalInvoke(command, args, options);
      }
      const entry = {
        command,
        url: args?.url ?? null,
        ifNoneMatch: args?.headers?.['if-none-match'] ?? null,
        ifModifiedSince: args?.headers?.['if-modified-since'] ?? null,
        timeoutMs: args?.timeoutMs ?? null,
        status: null,
        etag: null,
        error: null,
        at: new Date().toISOString(),
      };
      return originalInvoke(command, args, options).then(
        (data) => {
          entry.status = data?.status ?? null;
          entry.etag = data?.etag ?? null;
          state.proxyLog.push(entry);
          return data;
        },
        (error) => {
          entry.error = String(error);
          state.proxyLog.push(entry);
          throw error;
        },
      );
    };
    return true;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const bodyRoot = () => document.querySelector('.settings-body');
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
  const setNativeValue = (element, value, eventName) => {
    const proto =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
    element.dispatchEvent(new Event(eventName, { bubbles: true }));
  };
  const setSelect = (element, value) =>
    setNativeValue(element, value, 'change');
  const setInput = (element, value) => {
    setNativeValue(element, value, 'input');
    setNativeValue(element, value, 'change');
  };
  const invoke = (command, args) => {
    const fn = window.__TAURI_INTERNALS__?.invoke;
    if (typeof fn !== 'function') throw new Error('真实 Tauri IPC 不可用');
    return fn(command, args);
  };
  const errText = (reason) => {
    if (reason && typeof reason === 'object') {
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
    if (!ok) state.failures.push(`${name}：${errText(detail)}`);
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
      20_000,
      `${url} 页面标题`,
    );
    await sleep(350);
  }

  async function settings() {
    return invoke('settings_list', { query: null });
  }
  async function settingValue(key) {
    const rows = await settings();
    const row = rows.find((item) => item.key === key);
    return row?.value;
  }
  async function waitSetting(key, predicate, label = key) {
    return waitFor(async () => {
      const value = await settingValue(key);
      return predicate(value) ? value : null;
    }, 15_000, `设置 ${label}`);
  }

  function openDb(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error(`打开 ${name} 失败`));
    });
  }
  function idbGet(name, store, key) {
    return openDb(name).then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(store, 'readonly');
          const request = transaction.objectStore(store).get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () =>
            reject(request.error ?? new Error(`${name}.${store} 读取失败`));
        }),
    );
  }
  function idbAll(name, store) {
    return openDb(name).then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(store, 'readonly');
          const request = transaction.objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result ?? []);
          request.onerror = () =>
            reject(request.error ?? new Error(`${name}.${store} 读取失败`));
        }),
    );
  }
  const holidayState = () => idbGet('zhixing-holiday', 'meta', 'state');
  const holidayRecords = () => idbAll('zhixing-holiday', 'packages');

  function deleteDb(name) {
    return new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
      setTimeout(() => resolve(false), 4000);
    });
  }

  function sourceChoiceFor(id) {
    if (id === 'auto') return { mode: 'auto' };
    if (id === 'builtin') return { mode: 'builtin' };
    if (id === 'custom') return { mode: 'custom' };
    return { mode: 'single', sourceId: id };
  }

  async function setHolidaySource(id) {
    const body = await waitFor(bodyRoot, 10_000, '设置体');
    const select = await waitFor(
      () => body.querySelector('select[aria-label="节假日数据源"]'),
      10_000,
      '节假日数据源',
    );
    setSelect(select, id);
    const expected = sourceChoiceFor(id);
    await waitSetting(
      'calendar.holidaySource',
      (value) =>
        value &&
        value.mode === expected.mode &&
        (expected.sourceId === undefined || value.sourceId === expected.sourceId),
      `holidaySource ${id}`,
    );
    await sleep(350);
    return body;
  }

  async function ensureFallbackOff() {
    const toggle = await waitFor(
      () => byAria('失败时按优先级回退节假日源'),
      8000,
      '失败回退开关',
    );
    if (toggle.getAttribute('aria-checked') === 'true' && !toggle.disabled) {
      toggle.click();
      await waitSetting(
        'calendar.holidaySource',
        (value) => value && value.autoFallback === false,
        'autoFallback false',
      );
      await sleep(250);
    }
    return toggle.getAttribute('aria-checked');
  }

  async function setCustomUrl(url) {
    const body = await waitFor(bodyRoot, 10_000, '设置体');
    const input = await waitFor(
      () => body.querySelector('input[aria-label="自定义节假日 URL"]'),
      10_000,
      '自定义节假日 URL',
    );
    setInput(input, url);
    const save = await waitFor(
      () => findButton('保存地址', body, true),
      8000,
      '保存自定义地址',
    );
    save.click();
    await waitSetting(
      'calendar.holidaySource',
      (value) =>
        value?.mode === 'custom' && value?.customUrl === url,
      `customUrl ${url}`,
    );
    await sleep(350);
  }

  async function syncHoliday(label) {
    const body = document.querySelector('.settings-body');
    const before = await holidayState();
    const button = await waitFor(
      () => findButton('立即同步', body, true),
      10_000,
      `${label} 立即同步`,
    );
    button.click();
    await sleep(250);
    await waitFor(
      () => !norm(body.innerText).includes('同步中…'),
      90_000,
      `${label} 同步结束`,
    );
    const after = await waitFor(
      async () => {
        const current = await holidayState();
        return current &&
          current.lastAttemptAt &&
          current.lastAttemptAt !== before?.lastAttemptAt
          ? current
          : null;
      },
      90_000,
      `${label} 状态落盘`,
    );
    await sleep(600);
    return {
      text: norm(body.innerText),
      state: after,
      records: await holidayRecords(),
    };
  }

  function parseMaybeJson(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  /** 兼容 invoke 包装（若可写）与 Tauri IPC fetch 正文两种观察方式。 */
  function observedProxyCalls() {
    const calls = state.proxyLog.map((entry) => ({ ...entry }));
    for (const entry of state.ipcLog) {
      try {
        const args = parseMaybeJson(entry.requestBody) ?? {};
        let result = parseMaybeJson(entry.responseText);
        if (typeof result === 'string') result = parseMaybeJson(result);
        calls.push({
          source: 'ipc-fetch',
          url: args.url ?? null,
          ifNoneMatch: args.headers?.['if-none-match'] ?? null,
          ifModifiedSince: args.headers?.['if-modified-since'] ?? null,
          timeoutMs: args.timeoutMs ?? null,
          status: result?.status ?? null,
          etag: result?.etag ?? null,
          error: entry.error ?? null,
          at: entry.at,
          ipcStatus: entry.status,
          responseText: entry.responseText,
        });
      } catch (error) {
        calls.push({
          source: 'ipc-fetch',
          url: null,
          status: null,
          error: `${entry.error ?? ''} ${String(error)}`,
          at: entry.at,
        });
      }
    }
    return calls;
  }

  function recordFingerprint(records, sourceId) {
    return records
      .filter((item) => item.sourceId === sourceId)
      .map((item) =>
        [
          item.cacheKey,
          item.package?.version ?? '',
          item.fetchedAt ?? '',
          item.etag ?? '',
          item.contentHash ?? '',
        ].join('|'),
      )
      .sort();
  }

  async function boot() {
    await waitFor(
      () =>
        document.querySelector('.shell') ||
        document.body.innerText.includes('开始 7 天试用'),
      30_000,
      '应用启动',
    );
    if (!document.querySelector('.shell')) {
      const trial = findButton('开始 7 天试用');
      if (!trial) throw new Error('激活页找不到“开始 7 天试用”');
      trial.click();
      await waitFor(
        () => document.querySelector('.shell'),
        25_000,
        '试用后进入外壳',
      );
    }
    const wrapped = installProxyLog();
    if (!wrapped) throw new Error('无法包装 Tauri invoke，无法记录 http_fetch_text');
    record('boot', { shell: true, proxyLog: wrapped });
  }

  (async () => {
    try {
      await boot();
      // 上一轮 WebView 数据目录可能残留缓存；先清空，保证“首次同步”真实。
      const holidayDeleted = await deleteDb('zhixing-holiday');
      record('cleared-indexeddb', { holidayDeleted });
      await go('/settings/calendar', '设置');

      const sources = [
        {
          id: 'holiday-cn',
          host: 'holiday-cn',
          url: 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json',
        },
        {
          id: 'chinese-days',
          host: 'chinese-days',
          url: 'https://cdn.jsdelivr.net/npm/chinese-days@1.5.9/dist/years/2026.json',
        },
        {
          id: 'china-mainland-calendar',
          host: 'china-mainland-calendar',
          url: 'https://cdn.jsdelivr.net/gh/Lancetwang/china-mainland-calendar@main/china-mainland.ics',
        },
      ];

      const summary = {};
      for (const source of sources) {
        await setHolidaySource(source.id);
        await ensureFallbackOff();

        const first = await syncHoliday(`${source.id} 首次`);
        const firstFingerprint = recordFingerprint(first.records, source.id);
        const firstRecord = first.records.find(
          (item) => item.sourceId === source.id && item.year === 2026,
        );
        check(
          `源 ${source.id} 首次同步成功`,
          !first.text.includes('节假日同步失败') &&
            first.state.activeSourceId === source.id &&
            Boolean(firstRecord),
          {
            active: first.state.activeSourceId,
            text: first.text.slice(0, 1200),
            keys: first.records.map((item) => item.cacheKey),
          },
        );
        check(
          `源 ${source.id} 首次拿到 ETag/Last-Modified`,
          Boolean(firstRecord?.etag || firstRecord?.lastModified),
          {
            etag: firstRecord?.etag ?? null,
            lastModified: firstRecord?.lastModified ?? null,
          },
        );

        const proxyMark = observedProxyCalls().length;
        const second = await syncHoliday(`${source.id} 二次`);
        const recent = observedProxyCalls().slice(proxyMark);
        const notModified = recent.filter(
          (entry) => entry.status === 304 && entry.url === source.url,
        );
        check(
          `源 ${source.id} 二次同步代理返回真实 304`,
          notModified.length === 1 &&
            notModified[0].ifNoneMatch === (firstRecord?.etag ?? notModified[0].ifNoneMatch),
          { recent, expectedUrl: source.url, etag: firstRecord?.etag ?? null },
        );
        check(
          `源 ${source.id} 二次同步未被 UI 误报为失败/回退`,
          !second.text.includes('节假日同步失败') &&
            !second.text.includes('已回退') &&
            !second.state.lastError,
          second.text.slice(0, 1400),
        );
        check(
          `源 ${source.id} 304 不重写缓存与版本`,
          JSON.stringify(recordFingerprint(second.records, source.id)) ===
            JSON.stringify(firstFingerprint),
          {
            first: firstFingerprint,
            second: recordFingerprint(second.records, source.id),
          },
        );
        check(
          `源 ${source.id} 304 更新 lastAttempt/lastSync 且无错误`,
          second.state.lastAttemptAt !== first.state.lastAttemptAt &&
            second.state.lastSyncAt === second.state.lastAttemptAt &&
            !second.state.lastError,
          {
            firstAttempt: first.state.lastAttemptAt,
            secondAttempt: second.state.lastAttemptAt,
            lastSyncAt: second.state.lastSyncAt,
            lastError: second.state.lastError,
          },
        );

        summary[source.id] = {
          active: second.state.activeSourceId,
          firstAttempt: first.state.lastAttemptAt,
          secondAttempt: second.state.lastAttemptAt,
          lastSyncAt: second.state.lastSyncAt,
          etag: firstRecord?.etag ?? null,
          proxy: recent,
          recordFingerprint: recordFingerprint(second.records, source.id),
          text: second.text.slice(0, 1200),
        };
      }
      record('sources-304', summary);

      // ------------------------------------------------------------------
      // 3. 坏包 / 超时 / 断网：真实 Rust 代理失败时保留上次成功缓存
      // ------------------------------------------------------------------
      const base = location.origin;
      await setHolidaySource('custom');
      await setCustomUrl(`${base}/holiday/ok.json`);
      const customOk = await syncHoliday('自定义源首次');
      const customRecord = customOk.records.find(
        (item) => item.sourceId === 'custom' && item.year === 2026,
      );
      const customFingerprint = recordFingerprint(customOk.records, 'custom');
      check(
        '自定义源首次同步成功并写缓存',
        !customOk.text.includes('节假日同步失败') &&
          customOk.state.activeSourceId === 'custom' &&
          Boolean(customRecord),
        {
          active: customOk.state.activeSourceId,
          keys: customOk.records.map((item) => item.cacheKey),
          text: customOk.text.slice(0, 1000),
        },
      );
      const okSyncAt = customOk.state.lastSyncAt;

      const failureCases = [
        {
          label: '坏包',
          url: `${base}/holiday/bad.json`,
          keyword: /JSON|格式/i,
        },
        {
          label: '超时',
          url: `${base}/holiday/slow.json`,
          keyword: /超时/,
        },
        {
          label: '断网',
          url: `${base}/holiday/offline.json`,
          keyword: /连接|网络|失败/,
        },
      ];
      const failureSummary = {};
      for (const item of failureCases) {
        await setCustomUrl(item.url);
        const failed = await syncHoliday(`自定义源${item.label}`);
        const afterFingerprint = recordFingerprint(failed.records, 'custom');
        check(
          `自定义源${item.label}时保留缓存且不更新 lastSyncAt`,
          Boolean(failed.state.lastError) &&
            item.keyword.test(failed.state.lastError ?? '') &&
            failed.state.lastSyncAt === okSyncAt &&
            JSON.stringify(afterFingerprint) === JSON.stringify(customFingerprint),
          {
            lastError: failed.state.lastError,
            lastSyncAt: failed.state.lastSyncAt,
            okSyncAt,
            before: customFingerprint,
            after: afterFingerprint,
            text: failed.text.slice(0, 1200),
          },
        );
        failureSummary[item.label] = {
          lastError: failed.state.lastError,
          lastSyncAt: failed.state.lastSyncAt,
          lastAttemptAt: failed.state.lastAttemptAt,
          fingerprint: afterFingerprint,
        };
      }
      record('failure-cache', failureSummary);

      const holidayHosts =
        /(holiday-cn|chinese-days|china-mainland-calendar|jsdelivr|unpkg|githubusercontent)/i;
      const directFetches = state.fetchLog.filter((entry) =>
        holidayHosts.test(entry.url),
      );
      check('节假日远端请求没有 WebView fetch 直连', directFetches.length === 0, {
        directFetches,
        allFetches: state.fetchLog,
      });
      const observed = observedProxyCalls();
      check(
        '三个源均出现 http_fetch_text 真实 304',
        sources.every((source) =>
          observed.some(
            (entry) => entry.url === source.url && entry.status === 304,
          ),
        ),
        observed,
      );

      check(
        '控制台零意外报错',
        state.consoleErrors.length === 0 && state.pageExceptions.length === 0,
        {
          consoleErrors: state.consoleErrors,
          pageExceptions: state.pageExceptions,
        },
      );
      check('无 CSP 违规', state.cspViolations.length === 0, state.cspViolations);
      const localHolidayPrefix = `${location.origin}/holiday/`;
      check(
        '代理只接收条件头/accept',
        observed.length > 0 &&
          observed.every(
            (entry) =>
              entry.url?.startsWith('https://') ||
              entry.url?.startsWith(localHolidayPrefix),
          ),
        observed,
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
        `未捕获异常：${
          reason instanceof Error
            ? `${reason.message}\n${reason.stack ?? ''}`
            : String(reason)
        }`,
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
