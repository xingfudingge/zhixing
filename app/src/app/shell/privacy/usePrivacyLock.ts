import { useCallback, useEffect, useState } from 'react';

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 失焦遮挡状态。
 *
 * 覆盖触发条件：
 * - 窗口失焦（`window.blur` / Tauri `onFocusChanged(false)`）；
 * - 页面进入后台（Page Visibility `hidden`）；
 * - macOS 系统锁屏（Rust 侧监听 `com.apple.screenIsLocked` 后发事件）。
 *
 * 恢复时刻意不监听 focus/visible 来自动揭开：内容只在用户点击
 * 「显示内容」后重新出现，避免回焦瞬间把正文暴露给旁人。
 *
 * 上游参考（ZX11-AUDIT-01 R22）：Tauri Window `onFocusChanged`
 * https://v2.tauri.app/reference/javascript/api/namespacewindow/
 * 与 MDN Page Visibility
 * https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
 * macOS 锁屏由 Rust 侧 `privacy.rs` 监听系统分布式通知后发 Tauri 事件。
 */
export function usePrivacyLock(enabled: boolean): {
  covered: boolean;
  reveal: () => void;
} {
  const [covered, setCovered] = useState(false);
  const reveal = useCallback(() => setCovered(false), []);

  useEffect(() => {
    if (!enabled) {
      setCovered(false);
      return;
    }

    let disposed = false;
    const cleanups: Array<() => void> = [];
    const cover = () => setCovered(true);

    window.addEventListener('blur', cover);
    cleanups.push(() => window.removeEventListener('blur', cover));

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        cover();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    cleanups.push(() =>
      document.removeEventListener('visibilitychange', onVisibilityChange),
    );

    if (document.visibilityState === 'hidden') {
      setCovered(true);
    }

    if (isTauriRuntime()) {
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) =>
          getCurrentWindow().onFocusChanged(({ payload }) => {
            if (!payload) {
              cover();
            }
          }),
        )
        .then((unlisten) => {
          if (disposed) {
            unlisten();
          } else {
            cleanups.push(unlisten);
          }
        })
        .catch(() => undefined);

      void import('@tauri-apps/api/event')
        .then(({ listen }) => listen('privacy://screen-locked', cover))
        .then((unlisten) => {
          if (disposed) {
            unlisten();
          } else {
            cleanups.push(unlisten);
          }
        })
        .catch(() => undefined);
    }

    return () => {
      disposed = true;
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [enabled]);

  return { covered, reveal };
}
