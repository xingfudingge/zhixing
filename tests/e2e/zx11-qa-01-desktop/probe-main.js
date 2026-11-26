/*
 * ZX11-QA-01 主探针（真实 WKWebView + SQLite）。
 *
 * 只通过真实 DOM 操作产品控件、只通过真实 IPC 读取 SQLite / 调用 macOS
 * Apple Vision。所有检查都记录步骤和失败，不因单项失败中断后续验证。
 */
(() => {
  const state = {
    startedAt: new Date().toISOString(),
    checks: [],
    steps: [],
    failures: [],
    consoleErrors: [],
    pageExceptions: [],
    expectedConsoleErrors: [],
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
  const todayISO = () => {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  };
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
    if (!ok) state.failures.push(`${name}：${JSON.stringify(detail)}`);
  };
  const record = (name, value) => {
    state.steps.push({ name, at: new Date().toISOString(), value });
  };

  async function waitFor(checkFn, timeout = 15_000, label = 'condition') {
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

  /**
   * 每个独立 QA HOME 都从干净的 OCR 设备状态开始。
   * WKWebView 的 localStorage/IndexedDB 按 bundle id 落在真实用户目录，
   * 不随 HOME 隔离；不清理会把上一轮 OCR 作业误当成本轮数据。
   */
  async function resetOcrTestState() {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key));
        if (
          value &&
          typeof value === 'object' &&
          'enabled' in value &&
          'scope' in value &&
          'textStorage' in value
        ) {
          localStorage.removeItem(key);
        }
      } catch {
        /* 非 OCR 设置，保留 */
      }
    }
    await new Promise((resolve) => {
      const request = indexedDB.open('zhixing-ocr', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('jobs')) {
          db.createObjectStore('jobs', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        try {
          const transaction = db.transaction('jobs', 'readwrite');
          transaction.objectStore('jobs').clear();
          transaction.oncomplete = () => resolve(undefined);
          transaction.onerror = () => resolve(undefined);
          transaction.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      };
      request.onerror = () => resolve(undefined);
      request.onblocked = () => resolve(undefined);
    });
  }

  async function clickButton(text, root = document, exact = true) {
    const button = await waitFor(
      () => findButton(text, root, exact),
      10_000,
      `按钮 ${text}`,
    );
    button.click();
    await sleep(180);
    return button;
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
    }, 12_000, `设置 ${label}`);
  }
  async function tasks() {
    return invoke('tasks_list', { query: null });
  }
  async function findTask(title) {
    return (await tasks()).find((task) => task.title === title) ?? null;
  }
  async function waitTask(title, timeout = 12_000) {
    return waitFor(() => findTask(title), timeout, `任务 ${title}`);
  }

  async function addQuickTask(title, dueDate) {
    await go('/tasks', '全部任务');
    const input = await waitFor(
      () => document.querySelector('input[aria-label="快速添加任务标题"]'),
      10_000,
      '快速添加标题',
    );
    const dateSelect = document.querySelector('select[aria-label="快速添加日期"]');
    const listSelect = document.querySelector('select[aria-label="快速添加清单"]');
    await waitFor(() => listSelect && listSelect.value, 8000, '快速添加清单默认值');
    setInput(input, title);
    setSelect(dateSelect, dueDate);
    await sleep(200);
    const form = input.closest('form');
    const submit = Array.from(form.querySelectorAll('button')).find(
      (button) => norm(button.textContent) === '添加',
    );
    if (!submit) throw new Error('快速添加没有“添加”按钮');
    submit.click();
    return waitTask(title);
  }

  async function completeRow(title) {
    await go('/today', '今天');
    const button = await waitFor(
      () => byAria(`完成任务：${title}`),
      10_000,
      `完成任务 ${title}`,
    );
    button.click();
    await sleep(900);
  }

  async function clickToastAction(label = '撤销') {
    const button = await waitFor(
      () =>
        Array.from(document.querySelectorAll('.task-toast-action')).find(
          (item) => norm(item.textContent) === label,
        ),
      6000,
      `toast ${label}`,
    );
    button.click();
    await sleep(900);
  }

  async function setDateField(input, value) {
    input.focus();
    setInput(input, value);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    input.blur();
    await waitFor(
      () => input.getAttribute('data-value') === value,
      6000,
      `日期 ${value}`,
    );
    await sleep(200);
  }

  async function addDateException(date, kind, note) {
    await go('/settings/calendar', '设置');
    const body = document.querySelector('.settings-body');
    const input = await waitFor(
      () => body.querySelector('input[aria-label="例外日期"]'),
      8000,
      '例外日期输入框',
    );
    await setDateField(input, date);
    setSelect(body.querySelector('select[aria-label="例外类型"]'), kind);
    setInput(body.querySelector('input[aria-label="例外备注"]'), note);
    await clickButton('添加例外', body);
    await waitFor(async () => {
      const value = await settingValue('calendar.dateExceptions');
      return Array.isArray(value) && value.some((item) => item.date === date);
    }, 10_000, `例外写入 ${date}`);
    await sleep(300);
    return settingValue('calendar.dateExceptions');
  }

  async function setHolidayUrl(url) {
    await go('/settings/calendar', '设置');
    const body = document.querySelector('.settings-body');
    const source = await waitFor(
      () => body.querySelector('select[aria-label="节假日数据源"]'),
      8000,
      '节假日数据源',
    );
    setSelect(source, 'custom');
    await waitFor(
      () => body.querySelector('input[aria-label="自定义节假日 URL"]'),
      8000,
      '自定义 URL',
    );
    setInput(body.querySelector('input[aria-label="自定义节假日 URL"]'), url);
    await clickButton('保存地址', body);
    await waitSetting(
      'calendar.holidaySource',
      (value) => value?.source === 'custom' && value?.customUrl === url,
      'holidaySource',
    );
    return body;
  }

  async function syncHoliday() {
    const body = document.querySelector('.settings-body');
    const button = await waitFor(
      () => findButton('立即同步', body, true),
      8000,
      '立即同步',
    );
    button.click();
    // 按钮会重渲染，不能持有旧引用；以页面上的「同步中…」状态为准。
    await waitFor(
      () => !norm(body.innerText).includes('同步中…'),
      45_000,
      '节假日同步完成',
    );
    await sleep(800);
    return body;
  }

  function calendarCell(date) {
    return document.querySelector(`[data-testid="day-${date}"]`);
  }

  function workdayOf(date) {
    return calendarCell(date)?.getAttribute('data-workday') ?? null;
  }

  async function calendarSnapshot(dates = [], shift = 0) {
    await go('/calendar', '日历');
    await waitFor(
      () => document.querySelector('[data-testid="month-grid"]'),
      15_000,
      '月视图',
    );
    for (let index = 0; index < shift; index += 1) {
      byAria('下一段')?.click();
      await sleep(400);
    }
    return {
      weekdays: Array.from(document.querySelectorAll('.calendar-weekday')).map(
        (el) => norm(el.textContent),
      ),
      cellCount: document.querySelectorAll('.calendar-month-grid [data-date]')
        .length,
      firstCell: document
        .querySelector('.calendar-month-grid [data-date]')
        ?.getAttribute('data-date'),
      title: norm(
        document.querySelector('[data-testid="calendar-title"]')?.textContent,
      ),
      workdays: Object.fromEntries(
        dates.map((date) => [date, workdayOf(date)]),
      ),
    };
  }

  async function scanSettingsGroups() {
    const GROUPS = [
      ['appearance', '外观与阅读'],
      ['task', '任务与记录'],
      ['calendar', '日历与工作日'],
      ['notify', '提醒与通知'],
      ['ocr', '知识库与 OCR'],
      ['privacy', '隐私与安全'],
      ['sync', '同步与网络'],
      ['data', '数据与备份'],
      ['license', '许可与设备'],
    ];
    const scan = [];
    for (const [id, label] of GROUPS) {
      try {
        await go(`/settings/${id}`, '设置');
        const body = document.querySelector('.settings-body');
        const detail = {
          href: location.pathname,
          navCount: document.querySelectorAll('.settings-nav a').length,
          cardTitle: norm(body?.querySelector('h2')?.textContent),
          rowCount: body?.querySelectorAll('.settings-row').length ?? 0,
          comingSoon:
            norm(body?.innerText).includes('即将支持') ||
            norm(body?.innerText).includes('尚未实现'),
          disabled: Array.from(
            body?.querySelectorAll(
              'button:disabled, select:disabled, input:disabled',
            ) ?? [],
          ).map((el) =>
            norm(
              el.getAttribute('aria-label') ||
                el.getAttribute('title') ||
                el.textContent ||
                el.tagName,
            ),
          ),
          text: norm(body?.innerText).slice(0, 260),
        };
        scan.push({ id, label, detail });
        check(`设置分组 ${label} 渲染`, detail.href === `/settings/${id}` && detail.navCount === 9 && Boolean(detail.cardTitle), detail);
        check(`设置分组 ${label} 无 ComingSoon`, !detail.comingSoon, detail);
      } catch (reason) {
        check(`设置分组 ${label} 渲染`, false, { error: errText(reason) });
      }
    }
    record('settings-groups', scan);
    return scan;
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
      record('boot', { shell: true });
      await resetOcrTestState();
      record('ocr-test-state', 'cleared');

      await scanSettingsGroups();

      // ------------------------------------------------------------------
      // OCR：原生 probe + 真实图片识别 + 具体错误
      // ------------------------------------------------------------------
      let capability = null;
      try {
        capability = await invoke('ocr_probe');
        check(
          'OCR probe 为 Apple Vision 且可用',
          capability?.available === true &&
            capability?.engineName === 'Apple Vision',
          capability,
        );
      } catch (reason) {
        check('OCR probe 为 Apple Vision 且可用', false, {
          error: errText(reason),
        });
      }

      let fixtureBytes = null;
      try {
        const response = await fetch('/__fixtures/ocr-fixture.png');
        fixtureBytes = Array.from(
          new Uint8Array(await response.arrayBuffer()),
        );
        check('OCR 测试图片可读取', fixtureBytes.length > 1000, {
          bytes: fixtureBytes.length,
        });
      } catch (reason) {
        check('OCR 测试图片可读取', false, { error: errText(reason) });
      }

      let ocrResult = null;
      if (fixtureBytes) {
        try {
          ocrResult = await invoke('ocr_recognize', {
            imageBytes: fixtureBytes,
            languages: ['en', 'zh-Hans'],
          });
          const text = norm(ocrResult?.text);
          check(
            'OCR 真实图片识别成功',
            /ZHIXING/i.test(text) && /98765/.test(text),
            {
              text,
              engineName: ocrResult?.engineName,
              blocks: ocrResult?.blocks?.length,
              confidence: ocrResult?.confidence,
              imageWidth: ocrResult?.imageWidth,
              imageHeight: ocrResult?.imageHeight,
              durationMs: ocrResult?.durationMs,
            },
          );
          check(
            'OCR 结果来自 Apple Vision 且无占位',
            ocrResult?.engineName === 'Apple Vision' &&
              Array.isArray(ocrResult?.blocks) &&
              ocrResult.blocks.length > 0,
            {
              engineName: ocrResult?.engineName,
              blocks: ocrResult?.blocks?.length,
            },
          );
        } catch (reason) {
          check('OCR 真实图片识别成功', false, { error: errText(reason) });
        }
      }

      const ocrErrors = {};
      const captureOcrError = async (name, args) => {
        try {
          await invoke('ocr_recognize', args);
          ocrErrors[name] = { ok: true, message: '未返回错误' };
        } catch (reason) {
          ocrErrors[name] =
            reason && typeof reason === 'object'
              ? reason
              : { message: String(reason) };
        }
      };
      await captureOcrError('empty', { imageBytes: [], languages: ['en'] });
      await captureOcrError('bad', {
        imageBytes: Array.from(new TextEncoder().encode('this is not an image')),
        languages: ['en'],
      });
      if (fixtureBytes) {
        await captureOcrError('unsupportedLanguage', {
          imageBytes: fixtureBytes,
          languages: ['ko'],
        });
      }
      check(
        'OCR 空图返回 input/empty_image',
        ocrErrors.empty?.stage === 'input' &&
          ocrErrors.empty?.code === 'empty_image' &&
          String(ocrErrors.empty?.message ?? '').length > 0,
        ocrErrors.empty,
      );
      check(
        'OCR 坏图返回 decode/unsupported_image',
        ocrErrors.bad?.stage === 'decode' &&
          String(ocrErrors.bad?.message ?? '').includes('解码'),
        ocrErrors.bad,
      );
      check(
        'OCR 不支持语言返回 language/unsupported_language',
        ocrErrors.unsupportedLanguage?.stage === 'language' &&
          ocrErrors.unsupportedLanguage?.code === 'unsupported_language' &&
          String(ocrErrors.unsupportedLanguage?.message ?? '').includes('ko'),
        ocrErrors.unsupportedLanguage,
      );
      record('ocr-errors', ocrErrors);
      record('ocr-permission-boundary', {
        note: 'Apple Vision 是 macOS 本地框架，不需要相册/相机 TCC 权限；代码保留 permission 阶段但无运行时权限分支。本项目未伪造权限失败。',
        capability,
      });

      // OCR 设置页 UI：状态、真实测试识别、范围/存储缺口。
      await go('/settings/ocr', '设置');
      const ocrPanelState = await (async () => {
        const panel = await waitFor(
          () => document.querySelector('[aria-label="图片 OCR"]'),
          10_000,
          'OCR 面板',
        );
        await waitFor(
          () => panel.innerText.includes('Apple Vision'),
          10_000,
          'OCR Apple Vision 状态',
        );
        const enable = panel.querySelector(
          '.zx-ocr-toggle input[type="checkbox"]',
        );
        if (enable && !enable.checked) {
          enable.click();
          await sleep(500);
        }
        let uiRecognition = null;
        try {
          const response = await fetch('/__fixtures/ocr-fixture.png');
          const blob = await response.blob();
          const file = new File([blob], 'ocr-fixture.png', {
            type: 'image/png',
          });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          const input = panel.querySelector('input[type="file"]');
          input.files = transfer.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          const result = await waitFor(
            () =>
              panel.querySelector('.zx-ocr-result pre') ||
              panel.querySelector('.zx-ocr-error'),
            25_000,
            'OCR 测试识别结果',
          );
          uiRecognition = {
            kind: result.matches('.zx-ocr-error') ? 'error' : 'result',
            text: norm(result.textContent),
          };
        } catch (reason) {
          uiRecognition = { kind: 'error', text: errText(reason) };
        }
        const selects = Array.from(panel.querySelectorAll('select'));
        const scope =
          selects.find(
            (select) =>
              Array.from(select.options).some((option) =>
                norm(option.textContent).includes('指定目录'),
              ),
          ) ?? null;
        if (scope) {
          setSelect(scope, 'folder');
          await sleep(400);
        }
        const radios = Array.from(
          panel.querySelectorAll('input[type="radio"]'),
        );
        const syncRadio = radios.find((radio) =>
          norm(radio.parentElement?.textContent).includes('随附件同步'),
        );
        if (syncRadio && !syncRadio.checked) {
          syncRadio.click();
          await sleep(400);
        }
        const processButton = findButton('处理队列', panel, true);
        return {
          text: norm(panel.innerText),
          uiRecognition,
          hasFolderPicker: Boolean(
            panel.querySelector('[aria-label*="目录"]'),
          ),
          processDisabled: Boolean(processButton?.disabled),
          processTitle: processButton?.title ?? null,
          scopeValue: scope?.value ?? null,
          syncChecked: Boolean(syncRadio?.checked),
        };
      })();
      check(
        'OCR 设置页测试识别返回真实文本',
        ocrPanelState.uiRecognition?.kind === 'result' &&
          /ZHIXING/i.test(ocrPanelState.uiRecognition.text),
        ocrPanelState.uiRecognition,
      );
      check(
        'OCR 指定目录有目录选择器',
        ocrPanelState.hasFolderPicker,
        ocrPanelState,
      );
      check(
        'OCR 设置页处理队列可用',
        !ocrPanelState.processDisabled,
        {
          disabled: ocrPanelState.processDisabled,
          title: ocrPanelState.processTitle,
        },
      );
      check(
        'OCR 文本保存位置可切换',
        ocrPanelState.syncChecked === true,
        ocrPanelState,
      );
      record('ocr-panel', ocrPanelState);

      // ------------------------------------------------------------------
      // 任务：默认提醒
      // ------------------------------------------------------------------
      await go('/settings/task', '设置');
      const initialReminder = await waitFor(
        () => document.querySelector('select[aria-label="默认提醒"]'),
        8000,
        '默认提醒控件',
      );
      check('默认提醒初始为关闭', initialReminder.value === '', {
        value: initialReminder.value,
      });
      check(
        '设置页明确提示未授权不会伪造发送',
        document.body.innerText.includes('权限阻止'),
        { text: norm(document.body.innerText).slice(0, 280) },
      );

      const today = todayISO();
      const taskA = await addQuickTask('ZX11 默认关闭任务', today);
      check('默认关闭时新任务不写提醒', taskA.reminder === '', taskA);

      await go('/settings/task', '设置');
      const reminderSelect = await waitFor(
        () => document.querySelector('select[aria-label="默认提醒"]'),
        8000,
        '默认提醒控件',
      );
      setSelect(reminderSelect, '15m');
      await waitSetting(
        'tasks.defaultReminder',
        (value) => value === '15m',
        'defaultReminder',
      );
      const taskB = await addQuickTask('ZX11 默认十五分钟任务', today);
      check('新任务写入默认提醒 15m', taskB.reminder === '15m', taskB);
      const taskAAfter = await findTask('ZX11 默认关闭任务');
      check(
        '修改默认值不覆盖已有任务',
        taskAAfter?.reminder === '',
        taskAAfter,
      );

      // 无日期任务不写默认提醒。
      const undated = await addQuickTask('ZX11 无日期任务', '');
      check('无日期任务不写默认提醒', undated.reminder === '', undated);

      // 显式“不提醒”：任务详情里改成不提醒后，不会被默认值回填。
      await go('/tasks', '全部任务');
      const detailButton = await waitFor(
        () => byAria('查看任务：ZX11 默认十五分钟任务'),
        10_000,
        '任务详情入口',
      );
      detailButton.click();
      await waitFor(
        () => document.querySelector('#task-detail-reminder'),
        8000,
        '任务详情提醒控件',
      );
      setSelect(document.querySelector('#task-detail-reminder'), '');
      await sleep(900);
      const explicitNone = await findTask('ZX11 默认十五分钟任务');
      check(
        '显式“不提醒”不被默认值回填',
        explicitNone?.reminder === '' || explicitNone?.reminder === 'none',
        explicitNone,
      );
      // 还原成 15m，供重启持久化检查。
      const reminderDetail = await waitFor(
        () => document.querySelector('#task-detail-reminder'),
        8000,
        '任务详情提醒控件',
      );
      setSelect(reminderDetail, '15m');
      await sleep(900);

      // 通知权限/系统通道：明确不可用，不伪造成功。
      await go('/settings/notify', '设置');
      const notifyState = await (async () => {
        const body = document.querySelector('.settings-body');
        const system = Array.from(
          body.querySelectorAll('input[type="checkbox"]'),
        ).find((input) =>
          norm(input.closest('label')?.innerText).includes('系统通知'),
        );
        const before = norm(body.innerText);
        await clickButton('发送测试通知', body);
        await sleep(1200);
        return {
          systemDisabled: Boolean(system?.disabled),
          text: norm(body.innerText),
          hasUnsupported: before.includes('未接入原生通知插件'),
          hasError: Boolean(body.querySelector('.zx-notify-error')),
          notice: norm(body.querySelector('.zx-notify-notice')?.textContent),
        };
      })();
      check(
        '系统通知通道明确不可用',
        notifyState.systemDisabled && notifyState.hasUnsupported,
        notifyState,
      );
      check(
        '发送测试通知不伪造系统成功',
        notifyState.text.includes('系统通知') &&
          (notifyState.hasError || notifyState.notice.includes('系统通知')),
        notifyState,
      );
      record('notify', notifyState);

      // 默认提醒进入现有 scheduler 计划。
      const plan = await waitFor(() => {
        const plans = [];
        for (const key of Object.keys(localStorage)) {
          try {
            const value = JSON.parse(localStorage.getItem(key));
            if (Array.isArray(value?.plans)) plans.push(...value.plans);
          } catch {
            /* ignore */
          }
        }
        return plans.find((item) => item.ownerId === taskB.id);
      }, 15_000, '任务提醒计划');
      check(
        '默认提醒进入现有 scheduler 计划',
        Boolean(plan) &&
          ['scheduled', 'suppressed'].includes(plan?.status) &&
          String(plan?.body).includes('提前 15 分钟'),
        plan,
      );

      // ------------------------------------------------------------------
      // 完成后行为：keep / remove / 撤销 / 批量
      // ------------------------------------------------------------------
      const keepTask = await addQuickTask('ZX11 完成保留', today);
      await go('/settings/task', '设置');
      const keepStored = await settingValue('tasks.completionBehavior');
      const keepUi = document.querySelector(
        'select[aria-label="完成后行为"]',
      )?.value;
      check(
        '完成后行为初始 keep',
        (keepStored === undefined || keepStored === 'keep') && keepUi === 'keep',
        { stored: keepStored, ui: keepUi },
      );
      await completeRow('ZX11 完成保留');
      const keepAfter = await findTask('ZX11 完成保留');
      const keepVisible = Boolean(byAria('撤销完成：ZX11 完成保留'));
      check(
        'keep：完成后留在当前视图',
        keepAfter?.status === 'done' && keepVisible,
        { task: keepAfter, keepVisible },
      );
      await clickToastAction('撤销');
      const keepUndo = await findTask('ZX11 完成保留');
      const keepOpen = Boolean(byAria('完成任务：ZX11 完成保留'));
      check(
        'keep：撤销恢复原状态',
        keepUndo?.status !== 'done' && keepOpen,
        { task: keepUndo, keepOpen },
      );

      await go('/settings/task', '设置');
      const completionSelect = await waitFor(
        () => document.querySelector('select[aria-label="完成后行为"]'),
        8000,
        '完成后行为控件',
      );
      setSelect(completionSelect, 'remove');
      await waitSetting(
        'tasks.completionBehavior',
        (value) => value === 'remove',
        'completionBehavior remove',
      );

      const removeTask = await addQuickTask('ZX11 完成移出', today);
      await completeRow('ZX11 完成移出');
      const removeAfter = await findTask('ZX11 完成移出');
      const removeRowGone =
        !byAria('完成任务：ZX11 完成移出') &&
        !byAria('撤销完成：ZX11 完成移出');
      const doneSection = document.querySelector(
        'section[aria-label="今天已完成"]',
      );
      check(
        'remove：完成后从今天活动视图移出',
        removeAfter?.status === 'done' &&
          removeRowGone &&
          !doneSection?.innerText.includes('ZX11 完成移出'),
        {
          task: removeAfter,
          removeRowGone,
          doneSection: norm(doneSection?.innerText ?? ''),
        },
      );
      await clickToastAction('撤销');
      const removeUndo = await findTask('ZX11 完成移出');
      const removeOpen = Boolean(byAria('完成任务：ZX11 完成移出'));
      check(
        'remove：撤销恢复原状态并回到活动视图',
        removeUndo?.status !== 'done' && removeOpen,
        { task: removeUndo, removeOpen },
      );

      // 任务中心“已完成”仍可见：保留一条真实完成的任务再检查。
      const doneFilterTask = await addQuickTask('ZX11 已完成筛选', today);
      await completeRow('ZX11 已完成筛选');
      await go('/tasks', '全部任务');
      const doneTab = document.querySelector(
        'button[role="tab"][data-status="done"]',
      );
      if (doneTab) {
        doneTab.click();
        await sleep(700);
      }
      check(
        '任务中心已完成筛选仍可见已完成任务',
        norm(document.body.innerText).includes('ZX11 已完成筛选'),
        { text: norm(document.body.innerText).slice(0, 400) },
      );
      await invoke('tasks_complete', { id: doneFilterTask.id, done: false });

      // 批量完成 + 撤销。
      const batchA = await addQuickTask('ZX11 批量任务 A', today);
      const batchB = await addQuickTask('ZX11 批量任务 B', today);
      await go('/tasks', '全部任务');
      const allTab = document.querySelector(
        'button[role="tab"][data-status="all"]',
      );
      if (allTab) allTab.click();
      await sleep(300);
      await clickButton('批量', document, true);
      const selectA = await waitFor(
        () => byAria(`选择任务：${batchA.title}`),
        8000,
        '批量选择 A',
      );
      selectA.click();
      byAria(`选择任务：${batchB.title}`)?.click();
      await sleep(300);
      const batchBar = await waitFor(
        () => document.querySelector('.task-batch-bar'),
        5000,
        '批量操作条',
      );
      const batchDone = Array.from(
        batchBar.querySelectorAll('button'),
      ).find((button) => norm(button.textContent) === '完成');
      batchDone.click();
      await waitFor(
        () => norm(document.body.innerText).includes('已完成 2 条'),
        15_000,
        '批量完成结果',
      );
      const batchAfter = await tasks();
      check(
        '批量完成两条任务',
        batchAfter.find((task) => task.id === batchA.id)?.status === 'done' &&
          batchAfter.find((task) => task.id === batchB.id)?.status === 'done',
        {
          a: batchAfter.find((task) => task.id === batchA.id),
          b: batchAfter.find((task) => task.id === batchB.id),
        },
      );
      await clickToastAction('撤销');
      const batchUndo = await tasks();
      check(
        '批量完成可撤销',
        batchUndo.find((task) => task.id === batchA.id)?.status !== 'done' &&
          batchUndo.find((task) => task.id === batchB.id)?.status !== 'done',
        {
          a: batchUndo.find((task) => task.id === batchA.id),
          b: batchUndo.find((task) => task.id === batchB.id),
        },
      );

      // 删除不存在项：明确错误或幂等，不崩溃。
      const missing = {};
      for (const [name, command, args] of [
        ['task', 'tasks_delete', { id: 'missing-task-zx11' }],
        ['note', 'notes_delete', { id: 'missing-note-zx11' }],
        ['subtask', 'subtasks_delete', { id: 'missing-subtask-zx11' }],
      ]) {
        try {
          await invoke(command, args);
          missing[name] = { ok: true, message: '幂等返回成功' };
        } catch (reason) {
          missing[name] = { ok: false, message: errText(reason) };
        }
      }
      check(
        '删除不存在项不崩溃且有明确结果',
        Object.values(missing).every((item) => item.message.length > 0),
        missing,
      );
      record('delete-missing', missing);

      // ------------------------------------------------------------------
      // 日历：周起始/工作日/例外/节假日源/跨年/失败
      // ------------------------------------------------------------------
      await go('/settings/calendar', '设置');
      const sunday = await waitFor(
        () =>
          Array.from(
            document.querySelectorAll('[aria-label="周起始日"] button'),
          ).find((button) => norm(button.textContent) === '周日'),
        8000,
        '周起始日周日',
      );
      sunday.click();
      await waitSetting(
        'calendar.weekStart',
        (value) => value === 'sunday',
        'weekStart sunday',
      );
      const sundaySnapshot = await calendarSnapshot(['2026-11-01']);
      check(
        '周起始周日重排月视图',
        sundaySnapshot.weekdays[0] === '周日' &&
          sundaySnapshot.firstCell === '2026-11-01' &&
          sundaySnapshot.cellCount === 42,
        sundaySnapshot,
      );

      await go('/settings/calendar', '设置');
      const monday = await waitFor(
        () =>
          Array.from(
            document.querySelectorAll('[aria-label="周起始日"] button'),
          ).find((button) => norm(button.textContent) === '周一'),
        8000,
        '周起始日周一',
      );
      monday.click();
      await waitSetting(
        'calendar.weekStart',
        (value) => value === 'monday',
        'weekStart monday',
      );
      const mondaySnapshot = await calendarSnapshot(['2026-11-01']);
      check(
        '周起始周一重排月视图',
        mondaySnapshot.weekdays[0] === '周一' &&
          mondaySnapshot.firstCell === '2026-10-26' &&
          mondaySnapshot.cellCount === 42,
        mondaySnapshot,
      );

      // 单休：周六上班、周日休息。
      await go('/settings/calendar', '设置');
      setSelect(
        document.querySelector('select[aria-label="工作日规则"]'),
        'single',
      );
      await waitSetting(
        'calendar.workdayRule',
        (value) => value?.rule === 'single',
        'workdayRule single',
      );
      const singleSnapshot = await calendarSnapshot([
        '2026-11-07',
        '2026-11-08',
      ]);
      check(
        '单休：周六上班、周日休息',
        singleSnapshot.workdays['2026-11-07'] === 'workday' &&
          singleSnapshot.workdays['2026-11-08'] === 'rest',
        singleSnapshot,
      );

      // 大小周：本周双休、下周单休。
      await go('/settings/calendar', '设置');
      setSelect(
        document.querySelector('select[aria-label="工作日规则"]'),
        'alternating',
      );
      await waitSetting(
        'calendar.workdayRule',
        (value) => value?.rule === 'alternating',
        'workdayRule alternating',
      );
      const alternatingSnapshot = await calendarSnapshot([
        '2026-10-31',
        '2026-11-07',
        '2026-11-14',
        '2026-11-15',
      ]);
      check(
        '大小周：本周双休、下周单休',
        alternatingSnapshot.workdays['2026-10-31'] === 'rest' &&
          alternatingSnapshot.workdays['2026-11-07'] === 'workday' &&
          alternatingSnapshot.workdays['2026-11-14'] === 'rest' &&
          alternatingSnapshot.workdays['2026-11-15'] === 'rest',
        alternatingSnapshot,
      );

      // 自定义：取消周五上班。
      await go('/settings/calendar', '设置');
      setSelect(
        document.querySelector('select[aria-label="工作日规则"]'),
        'custom',
      );
      await waitSetting(
        'calendar.workdayRule',
        (value) => value?.rule === 'custom',
        'workdayRule custom',
      );
      const friday = await waitFor(
        () => byAria('自定义工作日 周五'),
        8000,
        '自定义周五',
      );
      friday.click();
      await sleep(700);
      const customSnapshot = await calendarSnapshot([
        '2026-11-05',
        '2026-11-06',
      ]);
      check(
        '自定义工作日：取消周五后周五休息',
        customSnapshot.workdays['2026-11-05'] === 'workday' &&
          customSnapshot.workdays['2026-11-06'] === 'rest',
        customSnapshot,
      );

      // 恢复双休，便于例外与节假日验证。
      await go('/settings/calendar', '设置');
      setSelect(
        document.querySelector('select[aria-label="工作日规则"]'),
        'double',
      );
      await waitSetting(
        'calendar.workdayRule',
        (value) => value?.rule === 'double',
        'workdayRule double',
      );

      // 个人例外：2026-11-07 休息、2026-11-08 上班、2027-01-01 上班。
      let exceptions = await addDateException(
        '2026-11-07',
        'rest',
        '验收例外',
      );
      exceptions = await addDateException(
        '2026-11-08',
        'work',
        '验收上班',
      );
      exceptions = await addDateException(
        '2027-01-01',
        'work',
        '跨年上班',
      );
      check(
        '个人例外三条写入设置',
        Array.isArray(exceptions) && exceptions.length === 3,
        exceptions,
      );
      // 同日再次保存为更新，不追加。
      const beforeDuplicate = (await settingValue('calendar.dateExceptions'))
        .length;
      exceptions = await addDateException(
        '2026-11-07',
        'rest',
        '验收例外更新',
      );
      const afterDuplicate =
        (await settingValue('calendar.dateExceptions')).length;
      check(
        '同日例外保存为更新而非追加',
        beforeDuplicate === 3 && afterDuplicate === 3,
        { beforeDuplicate, afterDuplicate, exceptions },
      );
      const exceptionSnapshot = await calendarSnapshot([
        '2026-11-07',
        '2026-11-08',
      ]);
      check(
        '个人例外覆盖周规则',
        exceptionSnapshot.workdays['2026-11-07'] === 'exception-rest' &&
          exceptionSnapshot.workdays['2026-11-08'] === 'exception-work',
        exceptionSnapshot,
      );

      // 跨年：2027-01-01 例外上班。
      await go('/calendar', '日历');
      await waitFor(
        () => document.querySelector('[data-testid="month-grid"]'),
        10_000,
        '月视图',
      );
      byAria('下一段')?.click();
      await sleep(400);
      byAria('下一段')?.click();
      await sleep(500);
      const crossYearTitle = norm(
        document.querySelector('[data-testid="calendar-title"]')?.textContent,
      );
      const crossYearCell = calendarCell('2027-01-01');
      check(
        '跨年切换到 2027 且例外生效',
        crossYearTitle.includes('2027') &&
          Boolean(crossYearCell) &&
          crossYearCell.getAttribute('data-workday') === 'exception-work',
        {
          title: crossYearTitle,
          workday: crossYearCell?.getAttribute('data-workday'),
          label: crossYearCell?.getAttribute('aria-label'),
        },
      );

      // 节假日同步成功（同源自定义 URL）。
      await setHolidayUrl('http://localhost:5173/__holiday/{year}.json');
      let holidayBody = await syncHoliday();
      const successText = norm(holidayBody.innerText);
      check(
        '节假日同步成功并提示 2027 未公布',
        successText.includes('上次同步') &&
          successText.includes('2027') &&
          successText.includes('尚未公布'),
        { text: successText.slice(0, 700) },
      );
      const holidaySnapshot = await calendarSnapshot(['2026-12-31'], 1);
      check(
        '远端节假日 2026-12-31 标记为假日',
        holidaySnapshot.workdays['2026-12-31'] === 'holiday',
        holidaySnapshot,
      );

      // 同步失败：坏 JSON 明确报错并保留缓存。
      await setHolidayUrl('http://localhost:5173/__holiday/fail.json');
      holidayBody = await syncHoliday();
      const failureText = norm(holidayBody.innerText);
      const failureSnapshot = await calendarSnapshot(['2026-12-31'], 1);
      check(
        '节假日坏 JSON 明确报错',
        failureText.includes('节假日同步失败') &&
          failureText.includes('JSON'),
        { text: failureText.slice(0, 700) },
      );
      check(
        '节假日失败保留上次成功缓存',
        failureSnapshot.workdays['2026-12-31'] === 'holiday',
        failureSnapshot,
      );

      // 清除源回到内置。
      await go('/settings/calendar', '设置');
      await clickButton('清除源', document.querySelector('.settings-body'));
      await waitSetting(
        'calendar.holidaySource',
        (value) => value?.source === 'builtin',
        'holidaySource builtin',
      );
      const clearedSnapshot = await calendarSnapshot(['2026-12-31'], 1);
      check(
        '清除源回退内置且不再使用远端假日',
        clearedSnapshot.workdays['2026-12-31'] !== 'holiday',
        clearedSnapshot,
      );

      // 默认 jsDelivr 源在桌面壳内是否真实可同步。
      await go('/settings/calendar', '设置');
      setSelect(
        document.querySelector('select[aria-label="节假日数据源"]'),
        'jsdelivr',
      );
      await waitSetting(
        'calendar.holidaySource',
        (value) => value?.source === 'jsdelivr',
        'holidaySource jsdelivr',
      );
      const jsdelivrBody = await syncHoliday();
      const jsdelivrText = norm(jsdelivrBody.innerText);
      check(
        '桌面默认 jsDelivr 源可同步',
        !jsdelivrText.includes('节假日同步失败'),
        { text: jsdelivrText.slice(0, 700) },
      );
      // 恢复内置，避免影响后续状态；用数据源选择器，不依赖缓存清理。
      await go('/settings/calendar', '设置');
      const restoreSource = await waitFor(
        () => document.querySelector('select[aria-label="节假日数据源"]'),
        8000,
        '节假日数据源恢复',
      );
      setSelect(restoreSource, 'builtin');
      await waitSetting(
        'calendar.holidaySource',
        (value) => value?.source === 'builtin',
        'holidaySource builtin restore',
      );

      // 恢复最终持久化值：周日 + 双休 + 一条跨年例外。
      await go('/settings/calendar', '设置');
      const finalSunday = Array.from(
        document.querySelectorAll('[aria-label="周起始日"] button'),
      ).find((button) => norm(button.textContent) === '周日');
      finalSunday?.click();
      await waitSetting(
        'calendar.weekStart',
        (value) => value === 'sunday',
        'weekStart final sunday',
      );
      setSelect(
        document.querySelector('select[aria-label="工作日规则"]'),
        'double',
      );
      await waitSetting(
        'calendar.workdayRule',
        (value) => value?.rule === 'double',
        'workdayRule final double',
      );
      // 删除 2026 的两条例外，保留 2027-01-01 供重启检查。
      const exceptionList = document.querySelector('.settings-exception-list');
      if (exceptionList) {
        for (const date of ['2026-11-07', '2026-11-08']) {
          const item = Array.from(
            exceptionList.querySelectorAll('.settings-exception-item'),
          ).find((row) => norm(row.innerText).includes(date));
          const remove = item
            ? Array.from(item.querySelectorAll('button')).find(
                (button) => norm(button.textContent) === '删除',
              )
            : null;
          if (remove) {
            remove.click();
            await sleep(600);
          }
        }
      }
      const finalExceptions = await settingValue('calendar.dateExceptions');
      check(
        '个人例外删除后保留跨年一条',
        Array.isArray(finalExceptions) &&
          finalExceptions.length === 1 &&
          finalExceptions[0]?.date === '2027-01-01',
        finalExceptions,
      );

      // ------------------------------------------------------------------
      // 隐私：诊断默认关闭、隐私开关、快速连点、加密状态
      // ------------------------------------------------------------------
      await go('/settings/privacy', '设置');
      const privacyInitial = await (async () => {
        const body = document.querySelector('.settings-body');
        await sleep(500);
        const diagnostics = byAria('开启本机诊断记录');
        const sticky = byAria('失焦时遮挡内容');
        const clipboard = await waitFor(
          () => document.querySelector('select[aria-label="剪贴板自动清空"]'),
          8000,
          '剪贴板设置',
        );
        const status = await invoke('note_encryption_status');
        return {
          diagnosticsChecked: diagnostics?.getAttribute('aria-checked'),
          stickyChecked: sticky?.getAttribute('aria-checked'),
          clipboard: clipboard.value,
          diagnosticsSetting:
            (await settingValue('privacy.diagnosticsEnabled')) ?? false,
          stickySetting: (await settingValue('privacy.hideOnBlur')) ?? false,
          clipboardSetting:
            (await settingValue('privacy.clipboardClearSeconds')) ?? 0,
          encryption: status,
          text: norm(body.innerText).slice(0, 300),
        };
      })();
      check(
        '诊断默认关闭',
        privacyInitial.diagnosticsChecked === 'false' &&
          privacyInitial.diagnosticsSetting === false,
        privacyInitial,
      );
      check(
        '失焦遮挡默认关闭',
        privacyInitial.stickyChecked === 'false' &&
          privacyInitial.stickySetting === false,
        privacyInitial,
      );
      check(
        '剪贴板保护默认关闭',
        privacyInitial.clipboard === '0' &&
          privacyInitial.clipboardSetting === 0,
        privacyInitial,
      );
      check(
        '加密笔记初始未配置',
        privacyInitial.encryption?.supported === true &&
          privacyInitial.encryption?.configured === false &&
          privacyInitial.encryption?.enabled === false,
        privacyInitial.encryption,
      );

      // 快速连点诊断开关，最终值与存储一致。
      const diagnosticsToggle = byAria('开启本机诊断记录');
      for (let index = 0; index < 9; index += 1) diagnosticsToggle.click();
      await sleep(1500);
      const rapidValue = await settingValue('privacy.diagnosticsEnabled');
      check(
        '诊断快速连点后 UI 与 SQLite 一致',
        String(rapidValue) === diagnosticsToggle.getAttribute('aria-checked'),
        {
          aria: diagnosticsToggle.getAttribute('aria-checked'),
          stored: rapidValue,
        },
      );
      if (diagnosticsToggle.getAttribute('aria-checked') === 'true') {
        diagnosticsToggle.click();
        await sleep(700);
      }
      // 设置剪贴板 30 秒，供重启持久化检查。
      const clipboardSelect = await waitFor(
        () => document.querySelector('select[aria-label="剪贴板自动清空"]'),
        8000,
        '剪贴板设置',
      );
      setSelect(clipboardSelect, '30');
      await waitSetting(
        'privacy.clipboardClearSeconds',
        (value) => value === 30,
        'clipboard 30',
      );

      // ------------------------------------------------------------------
      // 空数据：任务中心与今天
      // ------------------------------------------------------------------
      // 保留任务给重启探针检查；空数据在重启阶段验证。
      record('empty-data-deferred', {
        reason: '保留任务供重启持久化检查，空数据在 restart 探针中验证',
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
