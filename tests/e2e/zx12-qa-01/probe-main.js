/*
 * ZX12-QA-01 主探针（真实 WKWebView + SQLite + Rust HTTP 代理）。
 *
 * 只通过真实 DOM 操作产品控件；真实节假日源走外网，真实 ICS 走 Rust
 * http_fetch_text。坏包/超时/断网用 window.fetch 故障注入（不替换同步
 * 服务、不改产品代码），并在结果中明确标注注入。
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
    fetchLog: [],
    injected: [],
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

  // 产品远端请求已改为 Rust http_fetch_text IPC（ZX12-FIX-304-01）。
  // Tauri 的 invoke 属性不可写，因此在它底层的 fetch 上观测/注入：
  // 正常请求回读 IPC 响应 JSON 里的远端 status；故障请求直接构造
  // Tauri IPC 响应（Tauri-Response: ok/error），不替换产品同步服务。
  let activeHttpFault = null;
  const headerOf = (headers, name) => {
    if (!headers || typeof headers !== 'object') return null;
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name) return value;
    }
    return null;
  };
  const ipcHttpPayload = (init) => {
    if (!init || typeof init.body !== 'string') return null;
    try {
      const payload = JSON.parse(init.body);
      if (!payload || typeof payload.url !== 'string') return null;
      return {
        url: payload.url,
        headers:
          payload.headers && typeof payload.headers === 'object'
            ? payload.headers
            : {},
      };
    } catch {
      return null;
    }
  };
  const tauriIpcResponse = (body, ok = true) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Tauri-Response': ok ? 'ok' : 'error',
      },
    });

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input && typeof input === 'object' && 'url' in input
          ? input.url
          : String(input);
    const isHttpIpc =
      url.startsWith('ipc://') && url.includes('http_fetch_text');
    const payload = isHttpIpc ? ipcHttpPayload(init) : null;
    let header = null;
    try {
      if (payload) {
        header = headerOf(payload.headers, 'if-none-match');
      } else if (init && init.headers) {
        header =
          init.headers instanceof Headers
            ? init.headers.get('if-none-match')
            : init.headers['if-none-match'] ??
              init.headers['If-None-Match'] ??
              null;
      }
    } catch {
      /* ignore */
    }

    if (payload) {
      const fault =
        activeHttpFault && activeHttpFault.match(payload.url)
          ? activeHttpFault
          : null;
      if (fault) {
        if (fault.mode === 'offline') {
          state.fetchLog.push({
            url: payload.url,
            status: null,
            ifNoneMatch: header,
            injected: fault.mode,
            error: 'ZX12 QA offline injection',
          });
          return tauriIpcResponse('无法获取（ZX12 QA 断网注入）', false);
        }
        if (fault.mode === 'timeout') {
          state.fetchLog.push({
            url: payload.url,
            status: null,
            ifNoneMatch: header,
            injected: fault.mode,
            error: 'ZX12 QA timeout injection',
          });
          return tauriIpcResponse(
            '桌面网络代理请求超时（ZX12 QA 超时注入）',
            false,
          );
        }
        const status = fault.mode === 'http-500' ? 500 : 200;
        const body =
          fault.mode === 'bad-ics'
            ? 'this is not an ics file'
            : fault.mode === 'bad-json'
              ? '{not json'
              : 'injected upstream failure';
        const contentType =
          fault.mode === 'bad-ics'
            ? 'text/calendar'
            : fault.mode === 'bad-json'
              ? 'application/json'
              : 'text/plain';
        state.fetchLog.push({
          url: payload.url,
          status,
          ifNoneMatch: header,
          injected: fault.mode,
        });
        return tauriIpcResponse({
          status,
          statusText: status === 500 ? 'Internal Server Error' : 'OK',
          contentType,
          body,
          etag: null,
          lastModified: null,
          finalUrl: payload.url,
        });
      }
    }

    try {
      const response = await realFetch(input, init);
      let status = response.status;
      let loggedUrl = url;
      if (payload) {
        loggedUrl = payload.url;
        try {
          const data = await response.clone().json();
          if (typeof data?.status === 'number') status = data.status;
        } catch {
          /* 非 JSON IPC 响应：保留传输层状态码 */
        }
      }
      state.fetchLog.push({
        url: loggedUrl,
        status,
        ifNoneMatch: header,
      });
      return response;
    } catch (error) {
      state.fetchLog.push({
        url: payload?.url ?? url,
        status: null,
        ifNoneMatch: header,
        error: String(error && error.message ? error.message : error),
      });
      throw error;
    }
  };

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
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    descriptor.set.call(element, value);
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
  async function events() {
    return invoke('events_list', { query: null });
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
  const icsSubscriptions = () => idbAll('zhixing-ics', 'subscriptions');
  const icsCaches = () => idbAll('zhixing-ics', 'cache');

  function deleteDb(name) {
    return new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
      setTimeout(() => resolve(false), 4000);
    });
  }

  async function clickButton(text, root = document, exact = true) {
    const button = await waitFor(
      () => findButton(text, root, exact),
      12_000,
      `按钮 ${text}`,
    );
    button.click();
    await sleep(200);
    return button;
  }

  async function setDateField(input, value) {
    input.focus();
    setInput(input, value);
    // React 19 的受控输入在离散事件后刷新；给一帧再提交 Enter，避免
    // commitDraft 读到上一版 draft 而把值清空。
    await sleep(200);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await sleep(150);
    if (input.getAttribute('data-value') !== value) {
      // 兜底：失焦提交（DatePicker 的合法值提交路径之一）。
      input.blur();
    }
    await waitFor(
      () => input.getAttribute('data-value') === value,
      8000,
      `日期 ${value}`,
    );
    await sleep(250);
  }

  function sourceChoiceFor(id) {
    if (id === 'auto') return { mode: 'auto' };
    if (id === 'builtin') return { mode: 'builtin' };
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
    const body = document.querySelector('.settings-body') ?? document.body;
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

  function recordsKey(records) {
    return records.map((item) => item.cacheKey).sort();
  }

  function sourceRowTexts() {
    const list = document.querySelector('[aria-label="内置节假日源"]');
    return Array.from(list?.querySelectorAll('.settings-exception-item') ?? []).map(
      (item) => norm(item.innerText),
    );
  }

  function installFetchFault({ mode, match, label }) {
    state.injected.push({ mode, match, label, at: new Date().toISOString() });
    activeHttpFault = { mode, match, label };
  }
  function restoreFetch() {
    activeHttpFault = null;
  }

  function icsPanel() {
    return document.querySelector('.zx-ics');
  }
  function icsRow(name) {
    return Array.from(
      icsPanel()?.querySelectorAll('.zx-ics-list > li') ?? [],
    ).find((row) => norm(row.querySelector('b')?.textContent) === name);
  }
  async function addSubscription(name, url) {
    const panel = await waitFor(icsPanel, 10_000, 'ICS 面板');
    const nameInput = panel.querySelector('.zx-ics-form input[type="text"]');
    const urlInput = panel.querySelector('.zx-ics-form input[type="url"]');
    setInput(nameInput, name);
    setInput(urlInput, url);
    const button = await waitFor(
      () => findButton('添加订阅', panel, true),
      8000,
      '添加订阅按钮',
    );
    button.click();
    // 快速连点：第二次点击应被 adding/disabled 挡住，不产生重复订阅。
    await sleep(30);
    button.click();
    await waitFor(
      () => !findButton('添加中…', panel, true),
      30_000,
      `${name} 添加完成`,
    );
    await waitFor(
      async () => {
        const subscriptions = await icsSubscriptions();
        return subscriptions.some((item) => item.name === name) ? true : null;
      },
      20_000,
      `${name} 写入订阅`,
    );
    // 首次同步在添加后自动触发，等待 lastAttemptAt 出现或错误出现。
    const subscription = await waitFor(
      async () => {
        const subscriptions = await icsSubscriptions();
        const item = subscriptions.find((row) => row.name === name);
        return item && (item.lastAttemptAt || item.lastError) ? item : null;
      },
      30_000,
      `${name} 首次同步结束`,
    );
    await sleep(500);
    return subscription;
  }
  async function syncSubscription(name, waitMs = 30_000) {
    const row = await waitFor(() => icsRow(name), 10_000, `${name} 行`);
    const before = (await icsSubscriptions()).find((item) => item.name === name);
    const button = row.querySelector(
      `button[aria-label="立即同步订阅 ${name}"]`,
    );
    if (!button) throw new Error(`${name} 缺少立即同步按钮`);
    button.click();
    await waitFor(
      () =>
        !row.querySelector('button[aria-label="立即同步订阅 ' + name + '"]')
          ? true
          : norm(
              row.querySelector(
                'button[aria-label="立即同步订阅 ' + name + '"]',
              )?.textContent,
            ) !== '同步中…',
      waitMs,
      `${name} 同步结束`,
    );
    const after = await waitFor(
      async () => {
        const items = await icsSubscriptions();
        const item = items.find((entry) => entry.name === name);
        return item &&
          item.lastAttemptAt &&
          item.lastAttemptAt !== before?.lastAttemptAt
          ? item
          : null;
      },
      waitMs,
      `${name} 状态落盘`,
    );
    await sleep(500);
    return { after, rowText: norm(row.innerText), panelText: norm(icsPanel().innerText) };
  }
  async function removeSubscription(name) {
    const row = await waitFor(() => icsRow(name), 10_000, `${name} 行`);
    const deleteButton = row.querySelector(`button[aria-label="删除订阅 ${name}"]`);
    if (!deleteButton) throw new Error(`${name} 缺少删除按钮`);
    deleteButton.click();
    const confirm = await waitFor(
      () => icsPanel()?.querySelector(`button[aria-label="确认删除订阅 ${name}"]`),
      8000,
      `${name} 确认删除`,
    );
    confirm.click();
    // 快速连点确认删除：第二击不应留下未捕获异常或复活订阅。
    await sleep(30);
    try {
      confirm.click();
    } catch {
      /* DOM 已卸载 */
    }
    await waitFor(() => !icsRow(name), 20_000, `${name} 删除完成`);
    await sleep(600);
    const subscriptions = await icsSubscriptions();
    return {
      subscriptions,
      caches: await icsCaches(),
      panelText: norm(icsPanel().innerText),
    };
  }

  function calendarCell(date) {
    return document.querySelector(`[data-testid="day-${date}"]`);
  }
  function workdayOf(date) {
    return calendarCell(date)?.getAttribute('data-workday') ?? null;
  }
  async function calendarSnapshot(dates = [], move = 0) {
    await go('/calendar', '日历');
    await waitFor(
      () => document.querySelector('[data-testid="month-grid"]'),
      20_000,
      '月视图',
    );
    // 路由保持同一个 /calendar 时 CalendarPage 不卸载，月份会累积；
    // 每次快照先回“今天”，再用相对位移，保证断言不依赖上一段。
    const todayButton = findButton('今天', document, true);
    if (todayButton) {
      todayButton.click();
      await sleep(500);
    }
    for (let index = 0; index < Math.abs(move); index += 1) {
      byAria(move > 0 ? '下一段' : '上一段')?.click();
      await sleep(450);
    }
    return {
      title: norm(
        document.querySelector('[data-testid="calendar-title"]')?.textContent,
      ),
      workdays: Object.fromEntries(
        dates.map((date) => [date, workdayOf(date)]),
      ),
      cells: Object.fromEntries(
        dates.map((date) => [date, norm(calendarCell(date)?.innerText)]),
      ),
    };
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
    record('boot', { shell: true });
  }

  (async () => {
    try {
      await boot();

      // 共享 IndexedDB 不受 HOME 隔离；每次从干净缓存开始，避免上一轮误判。
      const holidayDeleted = await deleteDb('zhixing-holiday');
      const icsDeleted = await deleteDb('zhixing-ics');
      record('cleared-indexeddb', { holidayDeleted, icsDeleted });

      // ------------------------------------------------------------------
      // 1. 设置页：3 个独立内置源、License/状态、空态
      // ------------------------------------------------------------------
      await go('/settings/calendar', '设置');
      const initialText = norm(bodyRoot().innerText);
      const rows = sourceRowTexts();
      const sourceRows = rows.filter((text) => text.includes('github.com/'));
      const repos = sourceRows.map((text) => {
        const match = text.match(/https:\/\/github\.com\/[^\s]+/);
        return match ? match[0] : '';
      });
      check(
        '设置页显示 3 个独立内置源',
        sourceRows.length === 3 && new Set(repos).size === 3,
        { sourceRows, repos },
      );
      check(
        '每个源都有 License 与状态',
        sourceRows.every((text) => text.includes('MIT')) &&
          sourceRows.every(
            (text) =>
              text.includes('主源') ||
              text.includes('备源') ||
              text.includes('最后备源'),
          ),
        { sourceRows },
      );
      check(
        '明确说明镜像不重复计源',
        initialText.includes('传输镜像') &&
          initialText.includes('不重复计源'),
        initialText.slice(0, 900),
      );
      const sourceSelect = bodyRoot().querySelector(
        'select[aria-label="节假日数据源"]',
      );
      const optionValues = Array.from(sourceSelect?.querySelectorAll('option') ?? []).map(
        (option) => option.value,
      );
      check(
        '数据源选项含自动/3 源/内置/自定义',
        ['auto', 'holiday-cn', 'chinese-days', 'china-mainland-calendar', 'builtin', 'custom'].every(
          (value) => optionValues.includes(value),
        ),
        optionValues,
      );
      check(
        '初始为空缓存但显示内置 2026',
        initialText.includes('内置离线 2026') &&
          initialText.includes('还没有个人日期例外'),
        initialText.slice(0, 900),
      );
      check(
        '设置页无 ComingSoon',
        !initialText.includes('即将支持') && !initialText.includes('尚未实现'),
        initialText.slice(0, 900),
      );
      const emptyIcs = norm(icsPanel()?.innerText);
      check(
        'ICS 空态明确',
        emptyIcs.includes('还没有 ICS 订阅') && emptyIcs.includes('只读'),
        emptyIcs.slice(0, 500),
      );

      // ------------------------------------------------------------------
      // 2. 3 个源逐个真实同步（外网）+ 304 + 缓存隔离
      // ------------------------------------------------------------------
      const sources = [
        { id: 'holiday-cn', name: 'holiday-cn', host: 'holiday-cn' },
        { id: 'chinese-days', name: 'chinese-days', host: 'chinese-days' },
        {
          id: 'china-mainland-calendar',
          name: 'china-mainland-calendar',
          host: 'china-mainland-calendar',
        },
      ];
      const sourceResults = {};
      for (const source of sources) {
        await setHolidaySource(source.id);
        await ensureFallbackOff();
        const result = await syncHoliday(`${source.name} 首次`);
        sourceResults[source.id] = result;
        const keys = recordsKey(result.records);
        const ownRecord = result.records.find(
          (item) =>
            item.sourceId === source.id &&
            item.year === 2026 &&
            item.package?.days?.length >= 5,
        );
        check(
          `源 ${source.name} 真实同步成功`,
          !result.text.includes('节假日同步失败') &&
            result.state.activeSourceId === source.id &&
            result.state.perSource?.[source.id]?.lastSuccessAt &&
            Boolean(ownRecord),
          {
            text: result.text.slice(0, 1000),
            active: result.state.activeSourceId,
            keys,
            days: ownRecord?.package?.days?.length ?? null,
          },
        );
        check(
          `源 ${source.name} 按源+年份隔离缓存`,
          keys.includes(`${source.id}|jsdelivr|2026`) &&
            !result.records.some(
              (item) => item.sourceId === source.id && item.year === 2027,
            ),
          keys,
        );
        check(
          `源 ${source.name} 2027 未公布不覆盖 2026`,
          result.state.notPublishedYears?.includes(2027) &&
            Boolean(ownRecord) &&
            (result.text.includes('2027') || result.text.includes('2027 年')),
          {
            notPublished: result.state.notPublishedYears,
            text: result.text.slice(0, 1400),
          },
        );
        check(
          `源 ${source.name} UI 显示当前源与缓存`,
          result.text.includes('当前使用') &&
            result.text.includes('缓存 2026') &&
            result.text.includes(source.name),
          result.text.slice(0, 1400),
        );
        check(
          `切换源后旧源缓存仍保留`,
          sources
            .filter((item) => item.id !== source.id)
            .every(
              (item) =>
                !sourceResults[item.id] ||
                result.records.some((record) => record.sourceId === item.id),
            ),
          keys,
        );

        const beforeCount = state.fetchLog.length;
        const second = await syncHoliday(`${source.name} 二次`);
        const recent = state.fetchLog.slice(beforeCount);
        const has304 = recent.some(
          (entry) => entry.url.includes(source.host) && entry.status === 304,
        );
        check(
          `源 ${source.name} 二次同步真实 304`,
          has304,
          {
            recent,
            state: {
              lastSyncAt: second.state.lastSyncAt,
              active: second.state.activeSourceId,
            },
          },
        );
        check(
          `源 ${source.name} 304 不写 2027 缓存`,
          !second.records.some(
            (item) => item.sourceId === source.id && item.year === 2027,
          ),
          {
            keys: second.records.map((item) => item.cacheKey),
            lastError: second.state.perSource?.[source.id]?.lastError,
          },
        );
      }
      record('source-first-sync', Object.fromEntries(
        Object.entries(sourceResults).map(([id, result]) => [
          id,
          {
            active: result.state.activeSourceId,
            cachedYears: result.state.cachedYears,
            keys: recordsKey(result.records),
            text: result.text.slice(0, 1200),
          },
        ]),
      ));

      // ------------------------------------------------------------------
      // 3. 每源失败：坏包/超时/断网，明确显示源与原因，保留缓存
      // ------------------------------------------------------------------
      const failureCases = [
        {
          id: 'holiday-cn',
          name: 'holiday-cn',
          mode: 'bad-json',
          match: (url) => url.includes('holiday-cn'),
          keyword: 'JSON',
          label: '坏 JSON',
        },
        {
          id: 'holiday-cn',
          name: 'holiday-cn',
          mode: 'timeout',
          match: (url) => url.includes('holiday-cn'),
          keyword: '超时',
          label: '超时',
        },
        {
          id: 'chinese-days',
          name: 'chinese-days',
          mode: 'bad-json',
          match: (url) => url.includes('chinese-days'),
          keyword: 'JSON',
          label: '坏 JSON',
        },
        {
          id: 'chinese-days',
          name: 'chinese-days',
          mode: 'offline',
          match: (url) => url.includes('chinese-days'),
          keyword: '无法获取',
          label: '断网',
        },
        {
          id: 'china-mainland-calendar',
          name: 'china-mainland-calendar',
          mode: 'bad-ics',
          match: (url) => url.includes('china-mainland-calendar'),
          keyword: 'ICS',
          label: '坏 ICS',
        },
        {
          id: 'china-mainland-calendar',
          name: 'china-mainland-calendar',
          mode: 'offline',
          match: (url) => url.includes('china-mainland-calendar'),
          keyword: '无法获取',
          label: '断网',
        },
      ];
      const failureResults = [];
      for (const item of failureCases) {
        await setHolidaySource(item.id);
        await ensureFallbackOff();
        const before = await holidayState();
        const beforeRecords = await holidayRecords();
        installFetchFault(item);
        let result;
        try {
          result = await syncHoliday(`${item.name} ${item.label}`);
        } finally {
          restoreFetch();
        }
        const afterRecords = result.records;
        const cachedBefore = beforeRecords.find(
          (record) => record.sourceId === item.id && record.year === 2026,
        );
        const cachedAfter = afterRecords.find(
          (record) => record.sourceId === item.id && record.year === 2026,
        );
        const status = result.state.perSource?.[item.id];
        failureResults.push({
          id: item.id,
          mode: item.mode,
          text: result.text.slice(0, 1200),
          lastError: status?.lastError,
          active: result.state.activeSourceId,
          hasCache: Boolean(cachedAfter),
        });
        check(
          `源 ${item.name} ${item.label} 明确失败不静默`,
          result.text.includes('节假日同步失败') &&
            result.text.includes(item.name) &&
            result.text.includes(item.keyword),
          result.text.slice(0, 1600),
        );
        check(
          `源 ${item.name} ${item.label} 显示当前源/原因`,
          result.state.lastErrorSourceId === item.id &&
            Boolean(status?.lastError),
          {
            lastErrorSourceId: result.state.lastErrorSourceId,
            lastError: status?.lastError,
            active: result.state.activeSourceId,
          },
        );
        check(
          `源 ${item.name} ${item.label} 保留上次成功缓存`,
          Boolean(cachedBefore) &&
            Boolean(cachedAfter) &&
            cachedAfter.package.days.length === cachedBefore.package.days.length &&
            Boolean(status?.lastError),
          {
            beforeDays: cachedBefore?.package?.days?.length ?? null,
            afterDays: cachedAfter?.package?.days?.length ?? null,
            active: result.state.activeSourceId,
            lastError: status?.lastError,
          },
        );
        check(
          `源 ${item.name} ${item.label} 不写 304/成功时间`,
          result.state.lastSyncAt === before.lastSyncAt,
          { before: before.lastSyncAt, after: result.state.lastSyncAt },
        );
      }
      record('failure-cases', failureResults);

      // ------------------------------------------------------------------
      // 4. 自动回退：holiday-cn 失败 → chinese-days 成功，原因可见
      // ------------------------------------------------------------------
      record('auto-source-start');
      await setHolidaySource('auto');
      record('auto-source-set', await holidayState());
      const beforeFallback = await holidayRecords();
      installFetchFault({
        mode: 'http-500',
        match: (url) => url.includes('holiday-cn'),
        label: 'auto fallback holiday-cn 500',
      });
      record('auto-injected');
      let fallback;
      try {
        fallback = await syncHoliday('自动回退');
      } finally {
        restoreFetch();
      }
      record('auto-sync-done', {
        active: fallback.state.activeSourceId,
        fallbackUsed: fallback.state.fallbackUsed,
        lastAttemptAt: fallback.state.lastAttemptAt,
      });
      check(
        '自动模式回退到 chinese-days',
        fallback.state.fallbackUsed === true &&
          fallback.state.activeSourceId === 'chinese-days' &&
          fallback.state.fallbackFromSourceId === 'holiday-cn',
        {
          active: fallback.state.activeSourceId,
          from: fallback.state.fallbackFromSourceId,
          used: fallback.state.fallbackUsed,
          reason: fallback.state.fallbackReason,
        },
      );
      check(
        '回退原因含源名与 HTTP 500，不静默成功',
        /holiday-cn/.test(fallback.state.fallbackReason ?? '') &&
          /500/.test(fallback.state.fallbackReason ?? '') &&
          fallback.text.includes('已回退') &&
          fallback.text.includes('chinese-days'),
        {
          reason: fallback.state.fallbackReason,
          text: fallback.text.slice(0, 1600),
        },
      );
      check(
        '回退不清空原源缓存',
        beforeFallback.some((item) => item.sourceId === 'holiday-cn') &&
          fallback.records.some((item) => item.sourceId === 'holiday-cn') &&
          fallback.records.some(
            (item) => item.sourceId === 'chinese-days' && item.year === 2026,
          ),
        fallback.records.map((item) => item.cacheKey),
      );

      // 重新打开设置页：activeSource 必须仍指向实际提供数据的 chinese-days，
      // 不能退回到偏好里残留的 china-mainland-calendar。
      await go('/calendar', '日历');
      await go('/settings/calendar', '设置');
      const reopenedAfterFallback = norm(bodyRoot().innerText);
      const activeRow =
        Array.from(bodyRoot().querySelectorAll('.settings-row')).find((row) =>
          norm(row.innerText).startsWith('当前使用'),
        ) ?? null;
      record('reopened-after-fallback', {
        activeRow: norm(activeRow?.innerText),
        text: reopenedAfterFallback.slice(0, 1500),
      });
      check(
        '重新打开设置页保持回退后的当前源',
        norm(activeRow?.innerText).includes('chinese-days'),
        { activeRow: norm(activeRow?.innerText) },
      );

      // ------------------------------------------------------------------
      // 5. 个人例外、清除当前源/全部缓存
      // ------------------------------------------------------------------
      record('exception-section-start');
      await go('/settings/calendar', '设置');
      const dateInput = await waitFor(
        () => bodyRoot().querySelector('input[aria-label="例外日期"]'),
        10_000,
        '例外日期输入',
      );
      record('exception-input-found');
      await setDateField(dateInput, '2027-01-01');
      record('exception-date-committed', {
        value: dateInput.value,
        dataValue: dateInput.getAttribute('data-value'),
      });
      setSelect(
        bodyRoot().querySelector('select[aria-label="例外类型"]'),
        'work',
      );
      setInput(
        bodyRoot().querySelector('input[aria-label="例外备注"]'),
        'ZX12 验收补班',
      );
      await sleep(300);
      const addExceptionButton = findButton('添加例外', bodyRoot(), true);
      record('exception-button', {
        found: Boolean(addExceptionButton),
        disabled: addExceptionButton?.disabled ?? null,
        text: norm(addExceptionButton?.textContent),
        bodyHasDisabled: norm(bodyRoot().innerText).includes('添加例外'),
      });
      await clickButton('添加例外', bodyRoot());
      record('exception-button-clicked');
      const exceptions = await waitSetting(
        'calendar.dateExceptions',
        (value) =>
          Array.isArray(value) &&
          value.some(
            (item) => item.date === '2027-01-01' && item.kind === 'work',
          ),
        '例外写入',
      );
      check('个人例外通过 DatePicker 写入', Boolean(exceptions), exceptions);

      await setHolidaySource('chinese-days');
      record('clear-source-set');
      const beforeClearRecords = await holidayRecords();
      record('clear-before', recordsKey(beforeClearRecords));
      await clickButton('清除当前源缓存', bodyRoot());
      record('clear-current-clicked');
      // IndexedDB 在 WKWebView 里的 clear 事务提交后，短时间内新建连接可能
      // 仍读到旧快照；以“等待稳定 + 最终断言”为准，不用紧轮询判定失败。
      await sleep(1500);
      record('clear-current-waited', await holidayRecords().then((rows) => rows.length));
      await sleep(600);
      const afterClearRecords = await holidayRecords();
      const afterClearText = norm(bodyRoot().innerText);
      const afterClearExceptions = await settingValue('calendar.dateExceptions');
      const afterClearPref = await settingValue('calendar.holidaySource');
      check(
        '清除当前源只删该源缓存',
        beforeClearRecords.some((item) => item.sourceId === 'chinese-days') &&
          !afterClearRecords.some((item) => item.sourceId === 'chinese-days') &&
          afterClearRecords.some((item) => item.sourceId === 'holiday-cn'),
        {
          before: recordsKey(beforeClearRecords),
          after: recordsKey(afterClearRecords),
          rawActive: (await holidayState())?.activeSourceId,
        },
      );
      check(
        '清除当前源不删个人例外/源设置',
        Array.isArray(afterClearExceptions) &&
          afterClearExceptions.some((item) => item.date === '2027-01-01') &&
          afterClearPref?.mode === 'single' &&
          afterClearPref?.sourceId === 'chinese-days' &&
          afterClearText.includes('个人日期例外均保留'),
        {
          exceptions: afterClearExceptions,
          pref: afterClearPref,
          text: afterClearText.slice(0, 1200),
        },
      );

      await clickButton('清除全部缓存', bodyRoot());
      record('clear-all-clicked');
      await sleep(1500);
      const afterClearAllRecords = await holidayRecords();
      record('clear-all-waited', afterClearAllRecords.length);
      await sleep(600);
      const clearedAllExceptions = await settingValue('calendar.dateExceptions');
      check(
        '清除全部缓存删除全部源缓存',
        afterClearAllRecords.length === 0,
        afterClearAllRecords.map((item) => item.cacheKey),
      );
      check(
        '清除全部缓存后仍保留个人例外',
        Array.isArray(clearedAllExceptions) &&
          clearedAllExceptions.some((item) => item.date === '2027-01-01'),
        clearedAllExceptions,
      );

      // 为重启检查重建 holiday-cn 真实缓存。
      record('rebuild-source-start');
      await setHolidaySource('holiday-cn');
      record('rebuild-source-set');
      const rebuilt = await syncHoliday('重建 holiday-cn');
      record('rebuild-sync-done');
      check(
        '清除后可重新同步 holiday-cn',
        rebuilt.records.some(
          (item) => item.sourceId === 'holiday-cn' && item.year === 2026,
        ),
        rebuilt.records.map((item) => item.cacheKey),
      );

      // ------------------------------------------------------------------
      // 6. ICS：真实添加/首同步/304/失败保留/多订阅/删除/错误
      // ------------------------------------------------------------------
      await go('/settings/calendar', '设置');
      const subA = await addSubscription(
        '验收订阅A',
        'http://127.0.0.1:5173/ics/ok.ics',
      );
      check(
        'ICS 首次添加自动同步 2 个事件',
        subA.eventCount === 2 &&
          Boolean(subA.lastSyncAt) &&
          !subA.lastError,
        subA,
      );
      const eventsAfterA = await events();
      check(
        'ICS 事件以 ics:<id> 只读物化',
        eventsAfterA.filter(
          (event) =>
            event.source === `ics:${subA.id}` &&
            ['验收外部会议A', '验收外部会议B'].includes(event.title),
        ).length === 2,
        eventsAfterA
          .filter((event) => event.source === `ics:${subA.id}`)
          .map((event) => event.title),
      );

      const syncA2 = await syncSubscription('验收订阅A');
      check(
        'ICS 第二次同步 HTTP 304 且不重复物化',
        syncA2.after.lastSyncAt !== subA.lastSyncAt &&
          syncA2.after.eventCount === 2 &&
          syncA2.panelText.includes('304'),
        {
          first: subA.lastSyncAt,
          second: syncA2.after.lastSyncAt,
          count: syncA2.after.eventCount,
          text: syncA2.panelText.slice(-700),
        },
      );
      const eventsAfter304 = await events();
      check(
        'ICS 304 后事件仍为 2 条',
        eventsAfter304.filter((event) => event.source === `ics:${subA.id}`).length === 2,
        eventsAfter304.filter((event) => event.source === `ics:${subA.id}`).length,
      );

      const subB = await addSubscription(
        '验收订阅B',
        'http://127.0.0.1:5173/ics/second.ics',
      );
      check(
        'ICS 多订阅独立记录',
        subB.eventCount === 1 &&
          (await icsSubscriptions()).filter(
            (item) => item.name === '验收订阅A' || item.name === '验收订阅B',
          ).length === 2,
        await icsSubscriptions(),
      );

      await realFetch('/__ics_fail?route=ok.ics').catch(() => undefined);
      const syncAFail = await syncSubscription('验收订阅A');
      check(
        'ICS HTTP 500 明确报错',
        syncAFail.panelText.includes('HTTP 500') &&
          /HTTP 500/.test(syncAFail.after.lastError ?? ''),
        {
          lastError: syncAFail.after.lastError,
          text: syncAFail.panelText.slice(-900),
        },
      );
      check(
        'ICS 失败保留缓存与已导入事件',
        syncAFail.after.lastSyncAt === syncA2.after.lastSyncAt &&
          syncAFail.after.eventCount === 2 &&
          (await icsCaches()).some((cache) => cache.subscriptionId === subA.id) &&
          (await events()).filter((event) => event.source === `ics:${subA.id}`).length === 2,
        {
          lastSyncAt: syncAFail.after.lastSyncAt,
          previous: syncA2.after.lastSyncAt,
          count: syncAFail.after.eventCount,
        },
      );

      const syncAllFail = await (async () => {
        const body = icsPanel();
        const button = await waitFor(
          () => findButton('全部同步', body, true),
          8000,
          '全部同步按钮',
        );
        button.click();
        await waitFor(
          () => !findButton('全部同步中…', body, true),
          40_000,
          '全部同步结束',
        );
        await sleep(800);
        return norm(body.innerText);
      })();
      check(
        'ICS 全部同步单条失败不阻断并列出失败',
        syncAllFail.includes('个成功') &&
          syncAllFail.includes('个失败') &&
          syncAllFail.includes('验收订阅A') &&
          syncAllFail.includes('HTTP 500'),
        syncAllFail.slice(-1200),
      );
      await realFetch('/__ics_fail?route=').catch(() => undefined);

      const bad = await addSubscription(
        '坏订阅',
        'http://127.0.0.1:5173/ics/bad.ics',
      );
      check(
        '坏 ICS 添加后明确失败且不物化事件',
        /不是有效的 ICS|没有可导入/.test(bad.lastError ?? '') &&
          (await events()).every((event) => event.source !== `ics:${bad.id}`),
        {
          lastError: bad.lastError,
          events: (await events())
            .filter((event) => event.source === `ics:${bad.id}`)
            .length,
        },
      );
      const duplicate = await (async () => {
        try {
          await addSubscription(
            '重复订阅',
            'http://127.0.0.1:5173/ics/ok.ics',
          );
          return { error: null };
        } catch (error) {
          return { error: String(error && error.message ? error.message : error) };
        }
      })();
      // addSubscription 等订阅写入；重复地址在产品里应抛“已经订阅过了”。
      const duplicateText = norm(icsPanel().innerText);
      check(
        '重复 ICS 地址被拒绝',
        /已经订阅过了/.test(duplicateText) ||
          /已经订阅过了/.test(duplicate.error ?? ''),
        { duplicate, text: duplicateText.slice(-700) },
      );

      const publicIcs = await addSubscription(
        '真实公共日历',
        'https://cdn.jsdelivr.net/gh/Lancetwang/china-mainland-calendar@main/china-mainland.ics',
      );
      check(
        '真实外网 ICS 通过 Rust 代理同步',
        Boolean(publicIcs.lastSyncAt) &&
          publicIcs.eventCount > 0 &&
          !publicIcs.lastError,
        {
          lastSyncAt: publicIcs.lastSyncAt,
          eventCount: publicIcs.eventCount,
          lastError: publicIcs.lastError,
        },
      );
      const publicSync2 = await syncSubscription('真实公共日历', 40_000);
      check(
        '真实外网 ICS 二次同步 304',
        publicSync2.after.eventCount === publicIcs.eventCount &&
          publicSync2.panelText.includes('304'),
        {
          first: publicIcs.lastSyncAt,
          second: publicSync2.after.lastSyncAt,
          text: publicSync2.panelText.slice(-800),
        },
      );

      const removedA = await removeSubscription('验收订阅A');
      check(
        '删除订阅只删订阅与缓存',
        !removedA.subscriptions.some((item) => item.id === subA.id) &&
          !removedA.caches.some((cache) => cache.subscriptionId === subA.id) &&
          removedA.subscriptions.some((item) => item.name === '验收订阅B'),
        {
          subscriptions: removedA.subscriptions.map((item) => item.name),
          caches: removedA.caches.map((cache) => cache.subscriptionId),
        },
      );
      check(
        '删除订阅保留已导入事件',
        (await events()).filter((event) => event.source === `ics:${subA.id}`).length === 2,
        (await events())
          .filter((event) => event.source === `ics:${subA.id}`)
          .map((event) => event.title),
      );
      await removeSubscription('坏订阅');
      await removeSubscription('真实公共日历');
      check(
        '删除订阅后仍保留真实公共日历事件',
        (await events()).filter((event) => event.source === `ics:${publicIcs.id}`).length >
          0,
        (await events()).filter((event) => event.source === `ics:${publicIcs.id}`).length,
      );

      // ------------------------------------------------------------------
      // 7. 日历/工作日/任务分组回归
      // ------------------------------------------------------------------
      await go('/calendar', '日历');
      await waitFor(
        () => document.querySelector('[data-testid="month-grid"]'),
        20_000,
        '月视图',
      );
      const monthTitle = norm(
        document.querySelector('[data-testid="calendar-title"]')?.textContent,
      );
      check('月视图默认可用', monthTitle.includes('2026'), monthTitle);
      await waitFor(() => byAria('周视图'), 8000, '周视图按钮');
      byAria('周视图').click();
      await waitFor(
        () => document.querySelector('[data-testid="week-grid"]'),
        8000,
        '周视图',
      );
      await waitFor(() => byAria('日视图'), 8000, '日视图按钮');
      byAria('日视图').click();
      await waitFor(
        () => document.querySelector('[data-testid="day-view"]'),
        8000,
        '日视图',
      );
      await waitFor(() => byAria('月视图'), 8000, '月视图按钮');
      byAria('月视图').click();
      await waitFor(
        () => document.querySelector('[data-testid="month-grid"]'),
        8000,
        '回到月视图',
      );
      check('日历月/周/日视图切换', true, { monthTitle });

      const october = await calendarSnapshot(['2026-10-01'], -1);
      check(
        '真实 holiday-cn 数据用于工作日标记',
        october.workdays['2026-10-01'] === 'holiday' &&
          october.cells['2026-10-01'].includes('国庆'),
        october,
      );
      const january = await calendarSnapshot(['2027-01-01'], 2);
      check(
        '跨年 2026→2027 与个人例外优先',
        january.title.includes('2027') &&
          january.workdays['2027-01-01'] === 'exception-work',
        january,
      );
      const icsCell = await calendarSnapshot(['2026-11-03'], 0);
      check(
        'ICS 只读事件显示在日历',
        icsCell.cells['2026-11-03'].includes('验收外部会议A'),
        icsCell,
      );

      await go('/tasks', '全部任务');
      const groupSections = Array.from(
        document.querySelectorAll('.task-section'),
      ).map((section) => ({
        label: section.getAttribute('aria-label'),
        heading: norm(section.querySelector('h2')?.textContent),
        rows: section.querySelectorAll('.task-row').length,
      }));
      check(
        '任务中心分组未回归',
        groupSections.length > 0 &&
          groupSections.every((group) => group.label && group.heading),
        groupSections,
      );

      // ------------------------------------------------------------------
      // 8. 结果与 console 干净度
      // ------------------------------------------------------------------
      const expectedNoise = (message) =>
        /ZX12 QA|injected|Failed to fetch/.test(message);
      const unexpectedConsole = state.consoleErrors.filter(
        (message) => !expectedNoise(message),
      );
      check(
        '控制台零意外报错',
        unexpectedConsole.length === 0 && state.pageExceptions.length === 0,
        {
          consoleErrors: unexpectedConsole,
          pageExceptions: state.pageExceptions,
          allConsole: state.consoleErrors,
        },
      );
      check(
        '无 CSP 违规',
        state.cspViolations.length === 0,
        state.cspViolations,
      );
      record('persisted-for-restart', {
        source: await settingValue('calendar.holidaySource'),
        exceptions: await settingValue('calendar.dateExceptions'),
        holidayKeys: recordsKey(await holidayRecords()),
        subscriptions: (await icsSubscriptions()).map((item) => ({
          id: item.id,
          name: item.name,
          lastSyncAt: item.lastSyncAt,
          eventCount: item.eventCount,
        })),
        eventCount: (await events()).length,
      });

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
