/**
 * ZX14-QA-01 真实桌面探针：验证无授权模块。
 *
 * 只使用真实 Tauri IPC 与真实 DOM，不注入替身。
 * 结果 POST 回 Node 侧；截图由 Node 侧 screencapture 完成。
 */
(function () {
  const errors = [];
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    errors.push(args.map(String).join(' '));
    originalError(...args);
  };
  window.addEventListener('error', (event) => {
    errors.push(`[window.error] ${event.message} @ ${event.filename}:${event.lineno}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    errors.push(
      `[unhandledrejection] ${
        (event.reason && (event.reason.message || event.reason)) || 'unknown'
      }`,
    );
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  async function waitFor(check, timeout = 20_000, label = 'condition') {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        if (await check()) return true;
      } catch {
        /* retry */
      }
      await sleep(100);
    }
    throw new Error(`等待超时：${label}`);
  }

  function invoke(command) {
    const fn = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (typeof fn !== 'function') throw new Error('真实 Tauri IPC 不可用');
    return fn(command, {});
  }

  async function probeInvoke(command) {
    try {
      const value = await invoke(command);
      return { command, ok: true, value };
    } catch (error) {
      return {
        command,
        ok: false,
        error: String(
          (error && (error.message || error.toString())) || error,
        ),
      };
    }
  }

  function scanForbidden() {
    const needles = [
      '开始 7 天试用',
      '试用 7 天',
      '已授权',
      '未授权',
      '许可与设备',
      '激活',
      'LC1-',
      '授权码',
      '安装 ID',
    ];
    const body = document.body.innerText;
    const html = document.documentElement.outerHTML;
    const attrs = Array.from(document.querySelectorAll('*')).flatMap((el) => [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('href'),
      el.getAttribute('placeholder'),
    ]);
    const haystack = [body, ...attrs].filter(Boolean).join('\n');
    return {
      bodyHits: needles.filter((needle) => body.includes(needle)),
      attrHits: needles.filter((needle) => haystack.includes(needle)),
      htmlHits: needles.filter((needle) => html.includes(needle)),
    };
  }

  async function main() {
    const result = {
      isTauri: Boolean(window.__TAURI_INTERNALS__),
      route: location.pathname + location.search,
      title: document.title,
      bodyText: '',
      topbarText: '',
      navLinks: [],
      settingsGroups: [],
      settingsLicenseRoute: null,
      forbidden: null,
      ipc: [],
      localStorageKeys: [],
      consoleErrors: errors,
    };

    await waitFor(
      () =>
        document.body.innerText.includes('今天') ||
        location.pathname.startsWith('/today'),
      25_000,
      '主界面',
    );
    await sleep(1200);

    result.route = location.pathname + location.search;
    result.bodyText = norm(document.body.innerText).slice(0, 4000);
    const topbar = document.querySelector('header.topbar');
    result.topbarText = topbar ? norm(topbar.innerText) : null;
    result.navLinks = Array.from(document.querySelectorAll('a[href]')).map(
      (a) => ({ href: a.getAttribute('href'), text: norm(a.textContent) }),
    );
    result.forbidden = scanForbidden();

    // 主界面已就绪：通知 Node 侧先截一张主界面图，再继续导航到设置。
    await fetch('/__ready', { method: 'POST' });
    await sleep(900);

    for (const command of [
      'get_license_state',
      'get_install_id',
      'activate_license',
      'start_trial',
      'deactivate_license',
    ]) {
      result.ipc.push(await probeInvoke(command));
    }

    // 设置：真实导航到 /settings，再访问已删除的 /settings/license。
    history.pushState({}, '', '/settings');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(
      () => document.body.innerText.includes('设置'),
      10_000,
      '设置页',
    );
    await sleep(600);
    result.settingsGroups = Array.from(
      document.querySelectorAll('nav[aria-label="设置分组"] a'),
    ).map((a) => ({
      href: a.getAttribute('href'),
      text: norm(a.textContent),
    }));

    history.pushState({}, '', '/settings/license');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await sleep(900);
    result.settingsLicenseRoute = {
      path: location.pathname,
      bodyHasLicense: document.body.innerText.includes('许可'),
    };

    result.localStorageKeys = Object.keys(localStorage);
    result.consoleErrors = errors;
    result.routeAfter = location.pathname + location.search;

    await fetch('/__result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, result }),
    });
  }

  main().catch(async (error) => {
    await fetch('/__result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: false,
        error: String((error && error.stack) || error),
        partial: {
          route: location.pathname,
          bodyText: norm(document.body.innerText).slice(0, 2000),
          consoleErrors: errors,
        },
      }),
    });
  });
})();
