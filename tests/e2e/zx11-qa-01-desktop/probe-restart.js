/*
 * ZX11-QA-01 重启探针：同一 HOME 二次启动，验证设置/任务/OCR 偏好持久化，
 * 然后清空任务验证空数据状态。
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
        (exact
          ? norm(button.textContent) === text
          : norm(button.textContent).includes(text)),
    );
  const setSelect = (element, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    ).set;
    setter.call(element, value);
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
  async function waitFor(checkFn, timeout = 12_000, label = 'condition') {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const value = await checkFn();
        if (value) return value;
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
    await sleep(250);
  }
  async function settings() {
    return invoke('settings_list', { query: null });
  }
  async function settingValue(key) {
    return (await settings()).find((row) => row.key === key)?.value;
  }
  async function tasks() {
    return invoke('tasks_list', { query: null });
  }
  function ocrSettingsMirror() {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key));
        if (
          value &&
          typeof value === 'object' &&
          'enabled' in value &&
          'engine' in value &&
          'scope' in value &&
          'textStorage' in value
        ) {
          return { key, value };
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  (async () => {
    try {
      await waitFor(
        () => document.querySelector('.shell'),
        25_000,
        '重启后进入外壳',
      );
      record('boot', { shell: true });

      const values = {};
      for (const key of [
        'tasks.defaultReminder',
        'tasks.completionBehavior',
        'calendar.weekStart',
        'calendar.workdayRule',
        'calendar.holidaySource',
        'calendar.dateExceptions',
        'privacy.hideOnBlur',
        'privacy.clipboardClearSeconds',
        'privacy.diagnosticsEnabled',
      ]) {
        values[key] = await settingValue(key);
      }
      record('settings-after-restart', values);
      check('重启后默认提醒保持 15m', values['tasks.defaultReminder'] === '15m', values);
      check(
        '重启后完成后行为保持 remove',
        values['tasks.completionBehavior'] === 'remove',
        values,
      );
      check(
        '重启后周起始保持周日',
        values['calendar.weekStart'] === 'sunday',
        values,
      );
      check(
        '重启后工作日保持双休',
        values['calendar.workdayRule']?.rule === 'double',
        values,
      );
      check(
        '重启后节假日源回内置',
        values['calendar.holidaySource']?.source === 'builtin',
        values,
      );
      check(
        '重启后个人例外保留跨年一条',
        Array.isArray(values['calendar.dateExceptions']) &&
          values['calendar.dateExceptions'].length === 1 &&
          values['calendar.dateExceptions'][0]?.date === '2027-01-01',
        values['calendar.dateExceptions'],
      );
      check(
        '重启后隐私设置保持',
        (values['privacy.hideOnBlur'] ?? false) === false &&
          values['privacy.clipboardClearSeconds'] === 30 &&
          values['privacy.diagnosticsEnabled'] === false,
        values,
      );

      await go('/settings/task', '设置');
      const taskControls = await (async () => {
        const reminder = await waitFor(
          () => document.querySelector('select[aria-label="默认提醒"]'),
          8000,
          '默认提醒',
        );
        const completion = document.querySelector(
          'select[aria-label="完成后行为"]',
        );
        return { reminder: reminder.value, completion: completion?.value };
      })();
      check(
        '重启后任务设置 UI 回显',
        taskControls.reminder === '15m' &&
          taskControls.completion === 'remove',
        taskControls,
      );

      await go('/settings/calendar', '设置');
      const calendarControls = await (async () => {
        const rule = await waitFor(
          () => document.querySelector('select[aria-label="工作日规则"]'),
          8000,
          '工作日规则',
        );
        const week = Array.from(
          document.querySelectorAll('[aria-label="周起始日"] button'),
        ).find((button) => button.getAttribute('aria-pressed') === 'true');
        return {
          rule: rule.value,
          week: norm(week?.textContent),
          holidaySource: document.querySelector(
            'select[aria-label="节假日数据源"]',
          )?.value,
        };
      })();
      check(
        '重启后日历设置 UI 回显',
        calendarControls.rule === 'double' &&
          calendarControls.week === '周日' &&
          calendarControls.holidaySource === 'builtin',
        calendarControls,
      );

      await go('/settings/privacy', '设置');
      const privacyControls = await (async () => {
        const diagnostics = byAria('开启本机诊断记录');
        const sticky = byAria('失焦时遮挡内容');
        const clipboard = document.querySelector(
          'select[aria-label="剪贴板自动清空"]',
        );
        return {
          diagnostics: diagnostics?.getAttribute('aria-checked'),
          sticky: sticky?.getAttribute('aria-checked'),
          clipboard: clipboard?.value,
        };
      })();
      check(
        '重启后隐私设置 UI 回显',
        privacyControls.diagnostics === 'false' &&
          privacyControls.sticky === 'false' &&
          privacyControls.clipboard === '30',
        privacyControls,
      );

      const ocr = ocrSettingsMirror();
      record('ocr-settings-after-restart', ocr);
      check(
        '重启后 OCR 设置保持',
        ocr?.value?.enabled === true &&
          ocr?.value?.scope === 'folder' &&
          ocr?.value?.textStorage === 'sync',
        ocr,
      );

      const persistedTask = (await tasks()).find(
        (task) => task.title === 'ZX11 默认十五分钟任务',
      );
      check(
        '重启后任务提醒仍为 15m',
        persistedTask?.reminder === '15m',
        persistedTask,
      );

      // 空数据：清空所有任务后，今天与任务中心必须是真实空态。
      const all = await tasks();
      for (const task of all) {
        try {
          await invoke('tasks_delete', { id: task.id });
        } catch {
          /* ignore */
        }
      }
      const emptyTasks = await tasks();
      await go('/today', '今天');
      const todayText = norm(document.body.innerText);
      check(
        '空任务：今天页真实空态',
        emptyTasks.length === 0 &&
          (todayText.includes('今天还没有任务') ||
            todayText.includes('今天没有未完成任务')),
        { count: emptyTasks.length, text: todayText.slice(0, 300) },
      );
      await go('/tasks', '全部任务');
      const tasksText = norm(document.body.innerText);
      check(
        '空任务：任务中心计数为 0',
        tasksText.includes('共 0 条'),
        { text: tasksText.slice(0, 300) },
      );

      await go('/settings/ocr', '设置');
      let ocrPanelText = '';
      try {
        ocrPanelText = await waitFor(() => {
          const text = norm(document.querySelector('.zx-ocr')?.innerText ?? '');
          return text.includes('暂无 OCR 作业') ? text : null;
        }, 8000, 'OCR 空队列空态');
      } catch {
        ocrPanelText = norm(
          document.querySelector('.zx-ocr')?.innerText ??
            document.querySelector('.settings-body')?.innerText ??
            '',
        );
      }
      check(
        '空 OCR 队列空态',
        ocrPanelText.includes('暂无 OCR 作业'),
        {
          hasQueueEmpty: ocrPanelText.includes('暂无 OCR 作业'),
          tail: ocrPanelText.slice(-400),
        },
      );

      await go('/settings/calendar', '设置');
      const exceptionList = document.querySelector('.settings-exception-list');
      const removeButton = exceptionList
        ? Array.from(exceptionList.querySelectorAll('button')).find(
            (button) => norm(button.textContent) === '删除',
          )
        : null;
      if (removeButton) {
        removeButton.click();
        await sleep(700);
      }
      const afterDelete = await settingValue('calendar.dateExceptions');
      check(
        '个人例外删除后为空',
        Array.isArray(afterDelete) && afterDelete.length === 0,
        afterDelete,
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
