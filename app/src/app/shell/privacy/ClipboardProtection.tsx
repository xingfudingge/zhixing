import { useEffect, useRef, useState } from 'react';

import {
  createClipboardGuard,
  resolveClipboardBackend,
  type ClipboardBackend,
  type ClipboardGuard,
  type ClipboardGuardEvent,
} from './clipboard';

type Notice =
  | { kind: 'scheduled'; seconds: number }
  | { kind: 'cleared' }
  | { kind: 'cancelled' }
  | { kind: 'skipped' }
  | { kind: 'failed' };

function messageOf(notice: Notice): string {
  switch (notice.kind) {
    case 'scheduled':
      return `已复制敏感内容，将在 ${notice.seconds} 秒后自动清空剪贴板。`;
    case 'cleared':
      return '剪贴板已清空。';
    case 'cancelled':
      return '已取消本次自动清空。';
    case 'skipped':
      return '剪贴板内容已变化或无法确认，未清空。';
    case 'failed':
      return '剪贴板清空失败，未执行其他操作。';
  }
}

function eventToNotice(event: ClipboardGuardEvent): Notice | null {
  switch (event.type) {
    case 'scheduled':
      return { kind: 'scheduled', seconds: event.seconds };
    case 'cleared':
      return { kind: 'cleared' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'skipped':
    case 'failed':
      return { kind: event.type };
  }
}

/** 同时兼容 DOM 划词与 textarea/input 的 execCommand 兜底选区。 */
function selectedCopyText(): string {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) {
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
    return end > start ? active.value.slice(start, end) : '';
  }
  if (active instanceof HTMLInputElement) {
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
    return end > start ? active.value.slice(start, end) : '';
  }
  return window.getSelection()?.toString() ?? '';
}

/**
 * 剪贴板保护宿主。
 *
 * - 监听原生 `copy`（划词/⌘C）与 `navigator.clipboard.writeText/write`
 *   （编辑器操作条、安装 ID 等按钮复制）；
 * - 只在当前视图敏感且设置开启时计时；
 * - 通过提示条提供「撤销清空」，不记录复制内容。
 */
export function ClipboardProtection({
  enabled,
  seconds,
  sensitive,
  backend: injectedBackend,
}: {
  enabled: boolean;
  seconds: number;
  sensitive: boolean;
  /** 测试注入；不传时桌面端用官方插件、浏览器用 Web Clipboard API。 */
  backend?: ClipboardBackend;
}) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const guardRef = useRef<ClipboardGuard | null>(null);
  const sensitiveRef = useRef(sensitive);
  const secondsRef = useRef(seconds);
  sensitiveRef.current = sensitive;
  secondsRef.current = seconds;

  useEffect(() => {
    if (!enabled) {
      setNotice(null);
      guardRef.current = null;
      return;
    }

    let disposed = false;
    let disposeInstalled: (() => void) | null = null;

    const install = (backend: ClipboardBackend) => {
      if (disposed) {
        return;
      }
      const guard = createClipboardGuard({
        backend,
        clearSeconds: () => secondsRef.current,
        isSensitive: () => sensitiveRef.current,
        onEvent: (event) => setNotice(eventToNotice(event)),
      });
      guardRef.current = guard;

      const cleanups: Array<() => void> = [];

      const onCopy = () => {
        const selection = window.getSelection();
        const text = selection?.toString() ?? '';
        if (text.length === 0) {
          return;
        }
        const anchor = selection?.anchorNode ?? null;
        const element =
          anchor instanceof Element
            ? anchor
            : anchor?.parentElement ?? null;
        const fromSensitiveView = Boolean(
          element?.closest('[data-sensitive-copy]'),
        );
        guard.handleCopy(text, fromSensitiveView || sensitiveRef.current);
      };
      document.addEventListener('copy', onCopy);
      cleanups.push(() => document.removeEventListener('copy', onCopy));

      const clipboard =
        typeof navigator !== 'undefined' ? navigator.clipboard : undefined;

      if (clipboard?.writeText) {
        const original = clipboard.writeText;
        const descriptor = Object.getOwnPropertyDescriptor(
          clipboard,
          'writeText',
        );
        const wrapped = async (text: string) => {
          await original.call(clipboard, text);
          guard.handleCopy(text, sensitiveRef.current);
        };
        try {
          Object.defineProperty(clipboard, 'writeText', {
            configurable: true,
            writable: true,
            value: wrapped,
          });
          cleanups.push(() => {
            if (descriptor) {
              Object.defineProperty(clipboard, 'writeText', descriptor);
            } else {
              delete (clipboard as { writeText?: unknown }).writeText;
            }
          });
        } catch {
          // 个别 WebView 不允许改 native 方法；原生 copy 监听仍然生效。
        }
      }

      if (clipboard?.write) {
        const original = clipboard.write;
        const descriptor = Object.getOwnPropertyDescriptor(clipboard, 'write');
        const wrapped = async (data: ClipboardItem[]) => {
          await original.call(clipboard, data);
          if (!sensitiveRef.current) {
            return;
          }
          for (const item of data) {
            if (!item.types?.includes('text/plain')) {
              continue;
            }
            try {
              const blob = await item.getType('text/plain');
              guard.handleCopy(await blob.text(), true);
            } catch {
              // 双格式剪贴板里没有可读纯文本时不影响原复制结果。
            }
            break;
          }
        };
        try {
          Object.defineProperty(clipboard, 'write', {
            configurable: true,
            writable: true,
            value: wrapped,
          });
          cleanups.push(() => {
            if (descriptor) {
              Object.defineProperty(clipboard, 'write', descriptor);
            } else {
              delete (clipboard as { write?: unknown }).write;
            }
          });
        } catch {
          // 同上：不因为保护包装失败而破坏复制流程。
        }
      }

      // Tauri/WKWebView 在部分版本没有 navigator.clipboard.writeText，
      // 编辑器与安装 ID 会退回 document.execCommand('copy')。包一层以覆盖
      // 这条真实路径；仍然原样返回原命令结果，不改变复制行为。
      if (typeof document.execCommand === 'function') {
        const original = document.execCommand;
        const descriptor = Object.getOwnPropertyDescriptor(
          document,
          'execCommand',
        );
        const wrapped = (
          commandId: string,
          showUI?: boolean,
          value?: string,
        ) => {
          const result = original.call(document, commandId, showUI, value);
          if (commandId === 'copy' && result) {
            const text = selectedCopyText();
            if (text.length > 0) {
              guard.handleCopy(text, sensitiveRef.current);
            }
          }
          return result;
        };
        try {
          Object.defineProperty(document, 'execCommand', {
            configurable: true,
            writable: true,
            value: wrapped,
          });
          cleanups.push(() => {
            if (descriptor) {
              Object.defineProperty(document, 'execCommand', descriptor);
            } else {
              delete (document as { execCommand?: unknown }).execCommand;
            }
          });
        } catch {
          // 不允许覆盖时仍保留原生 copy 监听。
        }
      }

      disposeInstalled = () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
        guard.dispose();
        guardRef.current = null;
      };
    };

    if (injectedBackend) {
      install(injectedBackend);
    } else {
      void resolveClipboardBackend().then(install).catch(() => {
        // 后端不可用时保持原复制流程；不伪造“已保护”。
      });
    }

    return () => {
      disposed = true;
      disposeInstalled?.();
    };
  }, [enabled, injectedBackend]);

  useEffect(() => {
    if (!notice || notice.kind === 'scheduled') {
      return;
    }
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!notice) {
    return null;
  }

  return (
    <div
      className={`privacy-clipboard-toast is-${notice.kind}`}
      role="status"
      aria-live="polite"
    >
      <span>{messageOf(notice)}</span>
      {notice.kind === 'scheduled' ? (
        <button
          type="button"
          className="privacy-clipboard-action"
          onClick={() => {
            guardRef.current?.cancel();
            setNotice(null);
          }}
        >
          撤销清空
        </button>
      ) : null}
      <button
        type="button"
        className="privacy-clipboard-dismiss"
        aria-label="关闭剪贴板提示"
        onClick={() => setNotice(null)}
      >
        ×
      </button>
    </div>
  );
}
