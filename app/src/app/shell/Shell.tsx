import { invoke } from '@tauri-apps/api/core';
import { useEffect, useLayoutEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import {
  applyAppearance,
  readAppearance,
  saveAppearance,
  watchSystemTheme,
  type Appearance,
} from './appearance';
import {
  APPEARANCE_CHANGED_EVENT,
  SETTINGS_CHANGED_EVENT,
} from '../../features/settings/events';
import { getRuntimeSettings } from '../../features/settings/runtime';
import type { PrivacyPreferences } from '../../data/repositories/settings';
import { NotificationRuntime } from '../../features/notifications';
import { GlobalCommands } from '../../features/search';
import { isImmersivePath } from './navigation';
import { ClipboardProtection } from './privacy/ClipboardProtection';
import { isSensitiveCopyPath } from './privacy/clipboard';
import { LockOverlay } from './privacy/LockOverlay';
import { usePrivacyLock } from './privacy/usePrivacyLock';

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function Shell() {
  const { pathname } = useLocation();
  const immersive = isImmersivePath(pathname);
  const [appearance, setAppearance] = useState<Appearance>(() =>
    readAppearance(),
  );
  const [privacy, setPrivacy] = useState<PrivacyPreferences>(
    () => getRuntimeSettings().privacy,
  );
  const { covered, reveal } = usePrivacyLock(privacy.hideOnBlur);
  const clipboardSensitive = isSensitiveCopyPath(pathname);

  useLayoutEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  useEffect(() => {
    if (appearance.theme !== 'auto') {
      return;
    }
    return watchSystemTheme(() => {
      applyAppearance(appearance);
    });
  }, [appearance]);

  // 设置页与顶栏外观菜单共用 localStorage。任一侧修改后广播事件，
  // 让 Shell 的菜单回显与设置页表单保持一致。
  useEffect(() => {
    const sync = () => setAppearance(readAppearance());
    window.addEventListener(APPEARANCE_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener(APPEARANCE_CHANGED_EVENT, sync);
    };
  }, []);

  // 设置页保存完整偏好后广播；隐私开关无需重启应用即可生效。
  useEffect(() => {
    const sync = () => setPrivacy(getRuntimeSettings().privacy);
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }
    void invoke('shell_ready', { route: pathname }).catch(() => {
      // IPC 不可用时保持外壳可渲染；本地库状态由侧栏探针展示。
    });
  }, [pathname]);

  const updateAppearance = (next: Appearance) => {
    setAppearance(next);
    saveAppearance(next);
    window.dispatchEvent(
      new CustomEvent(APPEARANCE_CHANGED_EVENT, { detail: next }),
    );
  };

  return (
    <>
      <div
        className={immersive ? 'shell shell--immersive' : 'shell'}
        aria-hidden={covered ? true : undefined}
        inert={covered ? true : undefined}
      >
        <a className="skip-link" href="#main-content">
          跳到主要内容
        </a>

        {immersive ? null : (
          <Topbar
            appearance={appearance}
            onAppearanceChange={updateAppearance}
          />
        )}

        <Sidebar immersive={immersive} />

        <main
          id="main-content"
          className={immersive ? 'content content--workspace' : 'content'}
          tabIndex={-1}
          data-sensitive-copy={clipboardSensitive ? 'true' : undefined}
        >
          <Outlet />
        </main>

        <GlobalCommands />
        <NotificationRuntime />
      </div>

      <LockOverlay covered={covered} onReveal={reveal} />
      <ClipboardProtection
        enabled={privacy.clipboardClearSeconds > 0}
        seconds={privacy.clipboardClearSeconds}
        sensitive={clipboardSensitive}
      />
    </>
  );
}
