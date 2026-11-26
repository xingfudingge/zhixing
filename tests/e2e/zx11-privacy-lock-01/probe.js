/*
 * ZX11-PRIVACY-LOCK-01 桌面探针。
 *
 * 在真实 WKWebView 里：
 *   1. 打开设置 → 隐私与安全，开启失焦遮挡并把剪贴板清空设为 15 秒；
 *   2. 通知宿主用 Finder 夺焦（真实 macOS 失焦），确认遮挡层出现且不出现正文哨兵；
 *   3. 回焦后确认遮挡不会自动揭开，点击「显示内容」才恢复；
 *   4. 在 /tasks 敏感视图复制哨兵内容，确认 15 秒后系统剪贴板被清空；
 *   5. 再次复制后写入“用户其他内容”，确认到期不会误清。
 *
 * 探针只读取 DOM/剪贴板做验收，不修改产品业务数据。
 */
(() => {
  const state = {
    startedAt: new Date().toISOString(),
    failures: [],
    logs: [],
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = (message) => {
    state.logs.push(String(message));
  };
  const fail = (message) => {
    state.failures.push(String(message));
    log(`FAIL ${message}`);
  };
  const post = async (path, data) => {
    await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  };

  async function waitFor(check, timeout = 10_000, label = 'condition') {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const value = check();
      if (value) return value;
      await sleep(100);
    }
    throw new Error(`等待超时：${label}`);
  }

  function heading(match) {
    return Array.from(document.querySelectorAll('h1, h2')).find((element) =>
      (element.textContent ?? '').includes(match),
    );
  }

  async function go(path, headingText) {
    if (location.pathname !== path) {
      history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    await waitFor(
      () => heading(headingText) && document.querySelector('.shell'),
      10_000,
      `${path} 页面`,
    );
    await sleep(300);
  }

  function readPrivacyMirror() {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.privacy) {
          return parsed.privacy;
        }
      } catch {
        // 非 JSON 键跳过。
      }
    }
    return null;
  }

  function dispatchSyntheticCopy(text) {
    const host = document.createElement('span');
    host.textContent = text;
    host.style.position = 'fixed';
    host.style.left = '-9999px';
    host.style.top = '0';
    const container = document.querySelector('main') ?? document.body;
    container.appendChild(host);
    const range = document.createRange();
    range.selectNodeContents(host);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }));
    selection.removeAllRanges();
    host.remove();
  }

  function execCommandCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } finally {
      area.remove();
    }
    return ok;
  }

  async function invokeClipboard(command, args) {
    return window.__TAURI_INTERNALS__.invoke(command, args);
  }

  async function main() {
    await waitFor(
      () =>
        document.querySelector('.shell') ||
        document.body.innerText.includes('开始 7 天试用'),
      20_000,
      '应用启动',
    );
    if (!document.querySelector('.shell')) {
      const trial = Array.from(document.querySelectorAll('button')).find(
        (button) => (button.textContent ?? '').includes('开始 7 天试用'),
      );
      if (!trial) {
        fail('首次启动停在激活页，但找不到「开始 7 天试用」按钮');
      } else {
        trial.click();
        log('clicked start trial');
      }
    }
    await waitFor(
      () => document.querySelector('.shell'),
      20_000,
      '试用后进入应用外壳',
    );

    let blurCount = 0;
    let focusReturnedAt = 0;
    window.addEventListener('blur', () => {
      blurCount += 1;
      log('window blur');
    });
    window.addEventListener('focus', () => {
      focusReturnedAt = Date.now();
      log('window focus');
    });

    // 1. 设置页：开启两项真实设置。
    await go('/settings/privacy', '隐私与安全');
    const toggle = await waitFor(
      () =>
        document.querySelector(
          'button[role="switch"][aria-label="失焦时遮挡内容"]',
        ),
      10_000,
      '失焦遮挡开关',
    );
    if (toggle.getAttribute('aria-checked') !== 'true') {
      toggle.click();
      await waitFor(
        () => toggle.getAttribute('aria-checked') === 'true',
        5_000,
        '失焦遮挡开启',
      );
    }

    const select = await waitFor(
      () => document.querySelector('select[aria-label="剪贴板自动清空"]'),
      5_000,
      '剪贴板清空选择',
    );
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    ).set;
    setValue.call(select, '15');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => select.value === '15', 5_000, '剪贴板 15 秒');

    const mirror = readPrivacyMirror();
    state.settings = {
      hideOnBlur: mirror?.hideOnBlur ?? null,
      clipboardClearSeconds: mirror?.clipboardClearSeconds ?? null,
      toggleChecked: toggle.getAttribute('aria-checked') === 'true',
      selectValue: select.value,
    };
    state.window = {
      screenX: window.screenX,
      screenY: window.screenY,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    };
    if (!mirror || mirror.hideOnBlur !== true) {
      fail('localStorage 镜像没有 hideOnBlur=true');
    }
    if (mirror?.clipboardClearSeconds !== 15) {
      fail('localStorage 镜像没有 clipboardClearSeconds=15');
    }

    // 2. 真实失焦：宿主收到 ready 后用 Finder 夺焦。
    const sentinel = document.createElement('span');
    sentinel.textContent = 'ZX11-PRIVACY-SECRET-TITLE';
    sentinel.style.position = 'fixed';
    sentinel.style.left = '-9999px';
    document.querySelector('main').appendChild(sentinel);
    await post('/__ready', { ok: true });

    let overlay = null;
    try {
      overlay = await waitFor(
        () => document.querySelector('[data-testid="privacy-lock-overlay"]'),
        10_000,
        '失焦遮挡层',
      );
    } catch (reason) {
      fail(`失焦后没有出现遮挡层：${reason.message}`);
    }

    if (overlay) {
      const rect = overlay.getBoundingClientRect();
      const style = getComputedStyle(overlay);
      const shell = document.querySelector('.shell');
      state.lock = {
        appeared: true,
        blurCount,
        coversViewport:
          Math.abs(rect.left) < 1 &&
          Math.abs(rect.top) < 1 &&
          rect.width >= window.innerWidth - 1 &&
          rect.height >= window.innerHeight - 1,
        background: style.backgroundColor,
        opacity: style.opacity,
        overlayTextIncludesSecret: (overlay.innerText ?? '').includes(
          'ZX11-PRIVACY-SECRET-TITLE',
        ),
        shellAriaHidden: shell?.getAttribute('aria-hidden') ?? null,
        shellInert:
          shell?.hasAttribute('inert') === true ||
          Boolean(shell && shell.inert),
        focusInsideOverlay:
          overlay.contains(document.activeElement) ||
          overlay === document.activeElement,
      };
      if (!state.lock.coversViewport) fail('遮挡层没有覆盖整个窗口');
      if (style.opacity !== '1') fail('遮挡层不是不透明');
      if (state.lock.overlayTextIncludesSecret) {
        fail('遮挡层 DOM 里出现了正文哨兵');
      }
      if (state.lock.shellAriaHidden !== 'true') {
        fail('外壳没有标记 aria-hidden');
      }
      if (!state.lock.shellInert) fail('外壳没有标记 inert');

      // 等宿主把焦点交还给应用；回焦后遮挡必须仍在。
      const focusStart = Date.now();
      while (focusReturnedAt === 0 && Date.now() - focusStart < 8_000) {
        await sleep(100);
      }
      await sleep(400);
      state.lock.focusReturned = focusReturnedAt > 0;
      state.lock.stillCoveredAfterFocus = Boolean(
        document.querySelector('[data-testid="privacy-lock-overlay"]'),
      );
      if (!state.lock.focusReturned) {
        fail('8 秒内没有收到回焦事件（宿主可能无法激活应用）');
      }
      if (!state.lock.stillCoveredAfterFocus) {
        fail('回焦后遮挡被自动揭开');
      }

      const revealButton = overlay.querySelector(
        'button.privacy-lock-reveal',
      );
      if (!revealButton) {
        fail('遮挡层缺少「显示内容」按钮');
      } else {
        revealButton.click();
        await sleep(300);
        state.lock.revealWorked =
          document.querySelector('[data-testid="privacy-lock-overlay"]') ===
          null;
        if (!state.lock.revealWorked) fail('点击「显示内容」后遮挡未消失');
      }
    } else {
      state.lock = { appeared: false, blurCount };
    }
    sentinel.remove();

    // 3. 真实剪贴板：敏感路由复制 → 15 秒后清空；用户后来复制的内容不清。
    await go('/tasks', '全部任务');
    await sleep(600);
    state.clipboard = { sensitiveRoute: false };
    const mainElement = document.querySelector('main');
    state.clipboard.sensitiveRoute =
      mainElement?.getAttribute('data-sensitive-copy') === 'true';
    if (!state.clipboard.sensitiveRoute) {
      fail('/tasks 主内容没有 data-sensitive-copy');
    }

    const originalClipboard = await invokeClipboard(
      'plugin:clipboard-manager|read_text',
    ).catch(() => null);

    const sentinelText = 'ZX11-PRIVACY-CLIPBOARD-SENTINEL';
    const otherText = 'ZX11-PRIVACY-USER-OTHER';

    await invokeClipboard('plugin:clipboard-manager|clear').catch(() => {});
    let copyPath = 'navigator';
    let toastSeen = false;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        throw new Error('navigator.clipboard.writeText unavailable');
      }
      await navigator.clipboard.writeText(sentinelText);
      await sleep(700);
      toastSeen = Boolean(
        document.querySelector('.privacy-clipboard-toast'),
      );
      if (!toastSeen) copyPath = 'execCommand';
    } catch {
      copyPath = 'execCommand';
    }
    if (copyPath === 'execCommand') {
      state.clipboard.execCommandOk = execCommandCopy(sentinelText);
      await sleep(700);
      toastSeen = Boolean(document.querySelector('.privacy-clipboard-toast'));
      if (!toastSeen) {
        copyPath = 'native-event-fallback';
        await invokeClipboard('plugin:clipboard-manager|write_text', {
          text: sentinelText,
        });
        dispatchSyntheticCopy(sentinelText);
        await sleep(700);
        toastSeen = Boolean(
          document.querySelector('.privacy-clipboard-toast'),
        );
      }
    }
    state.clipboard.copyPath = copyPath;
    state.clipboard.toastSeen = toastSeen;
    if (!toastSeen) fail('复制后没有出现剪贴板保护提示');

    const beforeClear = await invokeClipboard(
      'plugin:clipboard-manager|read_text',
    ).catch(() => null);
    state.clipboard.beforeClear = beforeClear;
    if (beforeClear !== sentinelText) {
      fail(`复制后剪贴板不是哨兵内容，实际为：${String(beforeClear)}`);
    }

    await sleep(16_000);
    const afterClear = await invokeClipboard(
      'plugin:clipboard-manager|read_text',
    ).catch(() => null);
    state.clipboard.afterClear = afterClear;
    // Tauri 插件在空剪贴板时返回 null；两种都算已清空。
    state.clipboard.cleared = afterClear === '' || afterClear === null;
    if (!state.clipboard.cleared) {
      fail(`15 秒后剪贴板没有清空，实际为：${String(afterClear)}`);
    }

    // 第二次：复制哨兵后，模拟用户在其他应用复制了别的内容。
    await invokeClipboard('plugin:clipboard-manager|write_text', {
      text: sentinelText,
    });
    dispatchSyntheticCopy(sentinelText);
    await sleep(700);
    state.clipboard.secondToastSeen = Boolean(
      document.querySelector('.privacy-clipboard-toast'),
    );
    await invokeClipboard('plugin:clipboard-manager|write_text', {
      text: otherText,
    });
    await sleep(16_000);
    const afterOther = await invokeClipboard(
      'plugin:clipboard-manager|read_text',
    ).catch(() => null);
    state.clipboard.afterOther = afterOther;
    state.clipboard.didNotClearOther = afterOther === otherText;
    if (!state.clipboard.didNotClearOther) {
      fail(`用户后来复制的内容被误清，实际为：${String(afterOther)}`);
    }

    if (typeof originalClipboard === 'string') {
      await invokeClipboard('plugin:clipboard-manager|write_text', {
        text: originalClipboard,
      }).catch(() => {});
    } else {
      await invokeClipboard('plugin:clipboard-manager|clear').catch(() => {});
    }

    state.finishedAt = new Date().toISOString();
    state.ok = state.failures.length === 0;
    await post('/__result', state);
  }

  main().catch(async (reason) => {
    fail(reason instanceof Error ? reason.message : String(reason));
    state.finishedAt = new Date().toISOString();
    state.ok = false;
    await post('/__result', state).catch(() => {});
  });
})();
