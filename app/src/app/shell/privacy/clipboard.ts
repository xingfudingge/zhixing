/**
 * 剪贴板保护核心。
 *
 * 上游参考（ZX11-AUDIT-01 R7）：Tauri 官方插件
 * `tauri-apps/plugins-workspace` → `plugins/clipboard-manager`（npm 2.5.0；
 * 审计记录仓库提交 74a44c1d5694，2026-10-28）。桌面端只用其
 * `readText` / `clear`；写入仍走各入口原有路径，避免改变复制语义。
 *
 * 设计约束（ZX11-PRIVACY-LOCK-01）：
 * - 只在设置开启、且复制内容来自敏感视图时计时；
 * - 只记录“内容指纹”（长度 + 摘要），不把复制内容写入 localStorage/日志；
 * - 清空前重新读取系统剪贴板并比对指纹；用户后来复制了别的内容时不清空；
 * - 任一环节无法确认（读取失败、权限被拒）都选择“不清空”，不误伤用户数据。
 */

export type ClipboardBackend = {
  /** 空剪贴板在 Tauri 插件里返回 null；两者都按“空”处理。 */
  readText: () => Promise<string | null>;
  clear: () => Promise<void>;
};

export type ClipboardFingerprint = {
  length: number;
  digest: string;
};

export type ClipboardGuardEvent =
  | { type: 'scheduled'; seconds: number }
  | { type: 'cleared' }
  | { type: 'cancelled' }
  | { type: 'skipped'; reason: 'changed' | 'unreadable' | 'empty' }
  | { type: 'failed' };

export type ClipboardGuardOptions = {
  backend: ClipboardBackend;
  /** 每次计时开始时读取当前设置；返回 0 表示关闭。 */
  clearSeconds: () => number;
  /** 调用发生时的敏感视图判定。 */
  isSensitive: () => boolean;
  onEvent?: (event: ClipboardGuardEvent) => void;
  setTimeout?: (handler: () => void, delay: number) => number;
  clearTimeout?: (handle: number) => void;
};

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 当前路由是否包含敏感内容。任务/知识/画板等业务页默认为敏感；
 * 设置页只包含偏好与开关，不存在需要保护的复制来源。
 */
export function isSensitiveCopyPath(pathname: string): boolean {
  return !pathname.startsWith('/settings');
}

function toBytes(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text);
  }
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

/** `crypto.subtle` 不可用时的纯内存回退；不涉及存储，也不可逆。 */
function fallbackDigest(bytes: Uint8Array): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const byte of bytes) {
    left = Math.imul(left ^ byte, 0x01000193) >>> 0;
    right = Math.imul(right ^ byte, 0x85ebca6b) >>> 0;
    right = ((right << 13) | (right >>> 19)) >>> 0;
  }
  return `${left.toString(16).padStart(8, '0')}${right
    .toString(16)
    .padStart(8, '0')}`;
}

/**
 * 只在内存里比对复制内容；不返回原文，也不写任何持久化介质。
 *
 * 刻意使用同步摘要：复制发生后立即开始计时，不把首次清空时间交给
 * WebCrypto 的异步调度；摘要只是内存比对，不用于安全签名。
 */
export function fingerprintText(text: string): ClipboardFingerprint {
  const bytes = toBytes(text);
  return { length: bytes.length, digest: fallbackDigest(bytes) };
}

function sameFingerprint(
  left: ClipboardFingerprint,
  right: ClipboardFingerprint,
): boolean {
  return left.length === right.length && left.digest === right.digest;
}

export type ClipboardGuard = {
  /**
   * 记录一次复制。`sensitive` 为 false 时取消尚未执行的清空，
   * 因为用户已经主动复制了其他内容。
   */
  handleCopy: (text: string, sensitive: boolean) => void;
  cancel: () => void;
  dispose: () => void;
};

export function createClipboardGuard(
  options: ClipboardGuardOptions,
): ClipboardGuard {
  let timer: number | null = null;
  let pending: ClipboardFingerprint | null = null;
  let disposed = false;

  const setTimer =
    options.setTimeout ??
    ((handler: () => void, delay: number) =>
      window.setTimeout(handler, delay));
  const clearTimer =
    options.clearTimeout ??
    ((handle: number) => window.clearTimeout(handle));

  const emit = (event: ClipboardGuardEvent) => {
    options.onEvent?.(event);
  };

  const cancel = (notify = true) => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const hadPending = pending !== null;
    pending = null;
    if (notify && hadPending) {
      emit({ type: 'cancelled' });
    }
  };

  const verifyAndClear = async (
    fingerprint: ClipboardFingerprint,
  ): Promise<void> => {
    timer = null;
    if (disposed || pending !== fingerprint) {
      return;
    }
    pending = null;

    let current: string | null;
    try {
      current = await options.backend.readText();
    } catch {
      emit({ type: 'skipped', reason: 'unreadable' });
      return;
    }

    if (!current || current.length === 0) {
      emit({ type: 'skipped', reason: 'empty' });
      return;
    }

    const currentFingerprint = fingerprintText(current);
    if (!sameFingerprint(fingerprint, currentFingerprint)) {
      emit({ type: 'skipped', reason: 'changed' });
      return;
    }

    try {
      await options.backend.clear();
      emit({ type: 'cleared' });
    } catch {
      emit({ type: 'failed' });
    }
  };

  const schedule = (text: string, sensitive: boolean): void => {
    if (!sensitive) {
      cancel();
      return;
    }

    const seconds = options.clearSeconds();
    if (disposed || seconds <= 0 || text.length === 0) {
      cancel();
      return;
    }

    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const fingerprint = fingerprintText(text);
    pending = fingerprint;
    timer = setTimer(() => {
      void verifyAndClear(fingerprint);
    }, seconds * 1000);
    emit({ type: 'scheduled', seconds });
  };

  return {
    handleCopy(text, sensitive) {
      schedule(text, sensitive);
    },
    cancel: () => cancel(),
    dispose() {
      disposed = true;
      cancel(false);
    },
  };
}

/**
 * 浏览器剪贴板后端。`clear` 捕获创建时的原始 `writeText`，
 * 避免被外层保护包装再次拦截而重新计时。
 */
export function createBrowserClipboardBackend(): ClipboardBackend {
  const clipboard =
    typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  const readText = clipboard?.readText?.bind(clipboard);
  const writeText = clipboard?.writeText?.bind(clipboard);

  return {
    async readText() {
      if (!readText) {
        throw new Error('clipboard_unavailable');
      }
      return readText();
    },
    async clear() {
      if (!writeText) {
        throw new Error('clipboard_unavailable');
      }
      // 空字符串写入是 Web 端清空剪贴板的通用做法。
      await writeText('');
    },
  };
}

/**
 * 桌面端优先使用 Tauri 官方 clipboard-manager（R7）；插件不可用时退回
 * Web Clipboard API。后端只负责“读/清”，复制本身仍由各入口原样完成。
 */
export async function resolveClipboardBackend(): Promise<ClipboardBackend> {
  if (!isTauriRuntime()) {
    return createBrowserClipboardBackend();
  }
  try {
    const plugin = await import('@tauri-apps/plugin-clipboard-manager');
    return {
      readText: () => plugin.readText(),
      clear: () => plugin.clear(),
    };
  } catch {
    return createBrowserClipboardBackend();
  }
}
