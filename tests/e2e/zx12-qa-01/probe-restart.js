/*
 * ZX12-QA-01 重启探针：同一 HOME / 同一 WKWebView 数据目录重新启动，
 * 验证设置（SQLite）、节假日缓存与 ICS 订阅/事件（IndexedDB + SQLite）保持。
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
  const byAria = (label) =>
    Array.from(document.querySelectorAll('[aria-label]')).find(
      (el) => el.getAttribute('aria-label') === label && visible(el),
    );
  const findButton = (text, root = document, exact = true) =>
    Array.from(root.querySelectorAll('button')).find(
      (button) =>
        visible(button) &&
        (exact ? norm(button.textContent) === text : norm(button.textContent).includes(text)),
    );
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
  const record = (name, value) =>
    state.steps.push({ name, at: new Date().toISOString(), value });

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
    await sleep(400);
  }
  async function settings() {
    return invoke('settings_list', { query: null });
  }
  async function settingValue(key) {
    const rows = await settings();
    return rows.find((item) => item.key === key)?.value;
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
  function calendarCell(date) {
    return document.querySelector(`[data-testid="day-${date}"]`);
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
        dates.map((date) => [
          date,
          calendarCell(date)?.getAttribute('data-workday') ?? null,
        ]),
      ),
      cells: Object.fromEntries(
        dates.map((date) => [date, norm(calendarCell(date)?.innerText)]),
      ),
    };
  }

  (async () => {
    try {
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

      await go('/settings/calendar', '设置');
      const text = norm(document.querySelector('.settings-body')?.innerText);
      const source = await settingValue('calendar.holidaySource');
      const exceptions = await settingValue('calendar.dateExceptions');
      const hState = await holidayState();
      const hRecords = await holidayRecords();
      const subscriptions = await icsSubscriptions();
      const caches = await icsCaches();
      const allEvents = await events();

      check(
        '重启后节假日源偏好保持',
        source?.mode === 'single' && source?.sourceId === 'holiday-cn',
        source,
      );
      check(
        '重启后个人例外保持',
        Array.isArray(exceptions) &&
          exceptions.some(
            (item) => item.date === '2027-01-01' && item.kind === 'work',
          ),
        exceptions,
      );
      check(
        '重启后节假日缓存按源保持',
        hRecords.some(
          (item) =>
            item.sourceId === 'holiday-cn' &&
            item.year === 2026 &&
            item.package?.days?.length >= 5,
        ) && hState?.activeSourceId === 'holiday-cn',
        {
          keys: hRecords.map((item) => item.cacheKey),
          active: hState?.activeSourceId,
        },
      );
      check(
        '重开设置页显示上次成功与缓存',
        text.includes('上次成功') &&
          text.includes('缓存 2026') &&
          text.includes('holiday-cn'),
        text.slice(0, 1500),
      );
      check(
        '重启后 ICS 订阅只剩未删除项',
        subscriptions.length === 1 &&
          subscriptions[0].name === '验收订阅B' &&
          subscriptions[0].eventCount === 1 &&
          Boolean(subscriptions[0].lastSyncAt) &&
          !subscriptions[0].lastError,
        subscriptions,
      );
      check(
        '重启后 ICS 缓存保持',
        caches.some(
          (cache) =>
            cache.subscriptionId === subscriptions[0]?.id &&
            Array.isArray(cache.events) &&
            cache.events.length > 0,
        ),
        caches.map((cache) => ({
          id: cache.subscriptionId,
          events: cache.events?.length,
        })),
      );
      check(
        '重启后已导入事件保持（含已删订阅的事件）',
        allEvents.filter(
          (event) =>
            event.title === '验收外部会议A' ||
            event.title === '验收外部会议B' ||
            event.title === '验收第二订阅',
        ).length === 3,
        allEvents
          .filter((event) => String(event.source).startsWith('ics:'))
          .map((event) => ({ title: event.title, source: event.source })),
      );

      // 同一进程内离开再进入设置页，模拟“重新打开设置页”。
      await go('/calendar', '日历');
      await go('/settings/calendar', '设置');
      const reopened = norm(document.querySelector('.settings-body')?.innerText);
      check(
        '重新打开设置页状态保持',
        reopened.includes('缓存 2026') &&
          reopened.includes('验收订阅B') &&
          reopened.includes('2027-01-01'),
        reopened.slice(0, 1700),
      );

      const october = await calendarSnapshot(['2026-10-01'], -1);
      check(
        '重启后真实节假日仍用于日历',
        october.workdays['2026-10-01'] === 'holiday',
        october,
      );
      const january = await calendarSnapshot(['2027-01-01'], 2);
      check(
        '重启后跨年个人例外仍生效',
        january.title.includes('2027') &&
          january.workdays['2027-01-01'] === 'exception-work',
        january,
      );
      const november = await calendarSnapshot(['2026-11-03'], 0);
      check(
        '重启后已删订阅的事件仍在日历',
        november.cells['2026-11-03'].includes('验收外部会议A'),
        november,
      );

      const unexpectedConsole = state.consoleErrors.filter(
        (message) => !/ZX12 QA|injected/.test(message),
      );
      check(
        '重启后控制台零意外报错',
        unexpectedConsole.length === 0 && state.pageExceptions.length === 0,
        {
          consoleErrors: unexpectedConsole,
          pageExceptions: state.pageExceptions,
        },
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
