/**
 * ZX11-TASK-REMINDER-01 真实 Tauri WebView 探针。
 *
 * 只通过真实 DOM 操作产品控件、只通过真实 IPC 读取 SQLite：
 * 1. 新库默认提醒必须为“关闭”；
 * 2. 默认关闭时新建任务不写提醒；
 * 3. 设置“提前 15 分钟”后新建任务写入 15m，旧任务仍为空；
 * 4. 现有通知 scheduler 生成 15 分钟提前的待触发计划；
 * 5. 设置页明确说明未授权时不会伪造发送。
 */
(function () {
  const steps = [];
  const failures = [];
  const errors = [];

  const originalError = console.error.bind(console);
  console.error = (...args) => {
    errors.push(args.map(String).join(' '));
    originalError(...args);
  };
  window.addEventListener('error', (event) => {
    errors.push(
      `[window.error] ${event.message} @ ${event.filename}:${event.lineno}`,
    );
  });
  window.addEventListener('unhandledrejection', (event) => {
    errors.push(
      `[unhandledrejection] ${
        (event.reason && (event.reason.message || event.reason)) || 'unknown'
      }`,
    );
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function record(name, value) {
    steps.push({ name, at: new Date().toISOString(), value });
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function visible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  }

  async function waitFor(check, timeout = 10_000, interval = 80) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await sleep(interval);
    }
    return null;
  }

  function invoke(command, args) {
    const invokeFn =
      window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (typeof invokeFn !== 'function') {
      throw new Error('真实 Tauri IPC 不可用');
    }
    return invokeFn(command, args);
  }

  function findButton(text, root = document) {
    return Array.from(root.querySelectorAll('button')).find(
      (button) => visible(button) && norm(button.textContent).includes(text),
    );
  }

  function setNativeValue(element, value, eventName) {
    const proto =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    descriptor.set.call(element, value);
    element.dispatchEvent(new Event(eventName, { bubbles: true }));
  }

  async function navigate(label) {
    const link = await waitFor(
      () =>
        Array.from(document.querySelectorAll('a.nav-link')).find(
          (item) => visible(item) && norm(item.textContent).includes(label),
        ),
      12_000,
    );
    assert(
      link,
      `侧栏找不到导航：${label}；当前正文：${document.body.innerText.slice(0, 300)}`,
    );
    link.click();
    await sleep(700);
  }

  async function openTaskSettings() {
    await navigate('设置');
    const groupLink = await waitFor(
      () => document.querySelector('a[href="/settings/task"]'),
      10_000,
    );
    assert(groupLink, '设置页找不到“任务与记录”分组');
    groupLink.click();
    await sleep(700);
  }

  async function listTasks() {
    return invoke('tasks_list', { query: null });
  }

  async function listSettings() {
    return invoke('settings_list', { query: null });
  }

  async function findTaskByTitle(title) {
    const tasks = await listTasks();
    return tasks.find((task) => task.title === title) ?? null;
  }

  async function waitTask(title, timeout = 12_000) {
    return waitFor(async () => findTaskByTitle(title), timeout);
  }

  async function createTask(title) {
    await navigate('今天');
    const addButton = await waitFor(
      () => findButton('添加任务') ?? findButton('新建任务'),
      12_000,
    );
    assert(addButton, '今天页找不到“添加任务”按钮');
    addButton.click();
    const dialog = await waitFor(
      () => document.querySelector('.task-dialog'),
      8_000,
    );
    assert(dialog, '新建任务弹层没有打开');

    const titleInput = dialog.querySelector('input[placeholder="要做什么？"]');
    assert(titleInput, '新建任务弹层没有标题输入框');
    setNativeValue(titleInput, title, 'input');

    const timeInput = dialog.querySelector('input[type="time"]');
    assert(timeInput && !timeInput.disabled, '时间输入框不可用');
    setNativeValue(timeInput, '23:59', 'input');
    setNativeValue(timeInput, '23:59', 'change');

    const submit = findButton('创建', dialog);
    assert(submit, '新建任务弹层没有“创建”按钮');
    submit.click();
    const closed = await waitFor(
      () => !document.querySelector('.task-dialog'),
      10_000,
    );
    assert(closed, '提交后新建任务弹层没有关闭');
    const task = await waitTask(title);
    assert(task, `任务没有写入 SQLite：${title}`);
    return task;
  }

  function readPlans() {
    const plans = [];
    for (const key of Object.keys(localStorage)) {
      try {
        const value = JSON.parse(localStorage.getItem(key));
        if (Array.isArray(value?.plans)) plans.push(...value.plans);
      } catch {
        /* 非 JSON 键忽略 */
      }
    }
    return plans;
  }

  (async () => {
    try {
      await waitFor(
        () =>
          document.querySelector('a.nav-link') ||
          document.body.innerText.includes('开始 7 天试用'),
        20_000,
      );
      record('boot', {
        navReady: Boolean(document.querySelector('a.nav-link')),
      });
      if (document.body.innerText.includes('开始 7 天试用')) {
        const trial = findButton('开始 7 天试用');
        assert(trial, '找不到“开始 7 天试用”按钮');
        trial.click();
        await waitFor(
          () => !document.body.innerText.includes('开始 7 天试用'),
          10_000,
        );
        record('trial-started', true);
        await waitFor(() => document.querySelector('a.nav-link'), 12_000);
      }

      await openTaskSettings();
      const select = await waitFor(
        () => document.querySelector('select[aria-label="默认提醒"]'),
        12_000,
      );
      if (!select) {
        record('settings-body', document.body.innerText.slice(0, 600));
      }
      assert(select, '设置页找不到“默认提醒”控件');
      record('initial-default-reminder', select.value);
      assert(select.value === '', '新库默认提醒不是关闭');
      assert(
        document.body.innerText.includes('权限阻止'),
        '设置页没有明确提示未授权时的调度结果',
      );

      const taskA = await createTask('ZX11 默认关闭任务');
      record('task-a', { id: taskA.id, reminder: taskA.reminder });
      assert(taskA.reminder === '', '默认关闭时新任务仍被写入提醒');

      await openTaskSettings();
      const selectAgain = await waitFor(
        () => document.querySelector('select[aria-label="默认提醒"]'),
        10_000,
      );
      assert(selectAgain, '返回设置页后找不到默认提醒控件');
      setNativeValue(selectAgain, '15m', 'change');
      await sleep(1200);
      const settings = await listSettings();
      const setting = settings.find(
        (row) => row.key === 'tasks.defaultReminder',
      );
      record('saved-setting', setting?.value);
      assert(setting?.value === '15m', '默认提醒没有写入 SQLite');

      const taskB = await createTask('ZX11 默认十五分钟任务');
      record('task-b', { id: taskB.id, reminder: taskB.reminder });
      assert(taskB.reminder === '15m', '新任务没有写入默认提醒 15m');

      const taskAAfter = await findTaskByTitle('ZX11 默认关闭任务');
      record('task-a-after', { reminder: taskAAfter?.reminder });
      assert(
        taskAAfter?.reminder === '',
        '修改默认值后已有任务的提醒被改写',
      );

      const plan = await waitFor(
        () => readPlans().find((item) => item.ownerId === taskB.id),
        15_000,
      );
      record('plan', plan ? { status: plan.status, body: plan.body } : null);
      assert(plan, '现有通知 scheduler 没有为新任务生成计划');
      assert(plan.status === 'scheduled', `计划状态不是待触发：${plan.status}`);
      assert(
        plan.body.includes('提前 15 分钟'),
        `计划没有使用默认提醒：${plan.body}`,
      );
      assert(
        !readPlans().some((item) => item.ownerId === taskA.id),
        '默认关闭的任务被错误排程',
      );
      assert(errors.length === 0, `控制台错误：${errors.join(' | ')}`);
    } catch (error) {
      failures.push(String(error?.stack || error));
      record('failure', String(error?.message || error));
    }

    await fetch('/__result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: failures.length === 0,
        failures,
        errors,
        steps,
      }),
    }).catch(() => undefined);
  })();
})();
