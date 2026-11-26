/*
 * ZX11-FIX-OCR-01 重启探针：同一 HOME 下重新启动应用，验证 OCR 设置与队列
 * 作业真实持久化（localStorage + IndexedDB），不是内存态。
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
  const findButton = (text) =>
    Array.from(document.querySelectorAll('button')).find(
      (button) => visible(button) && norm(button.textContent) === text,
    );
  const check = (name, ok, detail) => {
    state.checks.push({ name, ok: Boolean(ok), detail });
    if (!ok) state.failures.push(`${name}：${JSON.stringify(detail)}`);
  };
  const errText = (reason) =>
    reason && typeof reason === 'object'
      ? JSON.stringify(reason)
      : String(reason);

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
        const trial = Array.from(document.querySelectorAll('button')).find(
          (button) => norm(button.textContent) === '开始 7 天试用',
        );
        if (!trial) throw new Error('激活页找不到“开始 7 天试用”');
        trial.click();
        await waitFor(
          () => document.querySelector('.shell'),
          20_000,
          '试用后进入外壳',
        );
      }

      check(
        '重启前的探针阶段标记存在',
        localStorage.getItem('zx-ocr-probe-stage') === 'restart',
        { stage: localStorage.getItem('zx-ocr-probe-stage') },
      );

      await go('/settings/ocr', '设置');
      await waitFor(
        () => document.querySelector('.zx-ocr'),
        15_000,
        'OCR 面板',
      );

      const toggle = Array.from(document.querySelectorAll('label'))
        .find((label) => norm(label.textContent).includes('启用图片 OCR'))
        ?.querySelector('input[type="checkbox"]');
      check('重启后 OCR 仍启用', toggle?.checked === true, {
        checked: toggle?.checked,
      });

      const scope = document.querySelector('select[aria-label="识别范围"]');
      check('重启后识别范围保持 folder', scope?.value === 'folder', {
        value: scope?.value,
      });
      const folder = document.querySelector('select[aria-label="OCR 指定目录"]');
      check('重启后目录选择保持 f1', folder?.value === 'f1', {
        value: folder?.value,
      });

      const syncRadio = Array.from(document.querySelectorAll('label'))
        .find((label) => norm(label.textContent).includes('随附件同步'))
        ?.querySelector('input[type="radio"]');
      check('重启后文本保存位置保持 sync', syncRadio?.checked === true, {
        checked: syncRadio?.checked,
      });
      check(
        '重启后仍明确提示仅本机模式不能同步',
        norm(document.body.innerText).includes('当前同步模式为仅本机'),
        { text: norm(document.body.innerText).slice(0, 400) },
      );

      const processButton = await waitFor(
        () => findButton('处理队列'),
        10_000,
        '处理队列按钮',
      );
      check('重启后处理队列按钮仍可用', processButton.disabled === false, {
        disabled: processButton.disabled,
      });

      const queueText = norm(document.querySelector('.zx-ocr-queue')?.innerText);
      check('重启后队列作业从 IndexedDB 恢复', queueText.includes('已完成'), {
        queue: queueText.slice(0, 800),
      });
      check(
        '重启后识别文本仍可读',
        /ZHIXING|ACCEPTANCE/i.test(queueText),
        { queue: queueText.slice(0, 800) },
      );

      check('页面无未处理异常', state.pageExceptions.length === 0, {
        pageExceptions: state.pageExceptions,
      });
      check('控制台无错误', state.consoleErrors.length === 0, {
        consoleErrors: state.consoleErrors,
      });
    } catch (reason) {
      check('重启探针未捕获异常', false, { error: errText(reason) });
    } finally {
      await report();
    }
  })();
})();
