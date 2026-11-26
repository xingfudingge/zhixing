/**
 * 链接块的统一打开/复制动作（ZX-LINK-03）。
 *
 * 约束：
 * - 所有外链在离开渲染层前重新走 `parseLinkInput`，不信任渲染时的分类；
 * - 桌面端只通过 `tauri-plugin-opener` 交给系统默认浏览器/邮件客户端，
 *   不把外链加载进应用 WebView；
 * - 浏览器预览用 `window.open`，打开失败时明确抛错，避免被拦截后静默无反应；
 * - 站内链只允许应用内跳转，绝不交给系统协议处理器。
 */

import { openUrl } from '@tauri-apps/plugin-opener';

import { isTauriRuntime } from '../../data/db/client';
import { parseLinkInput } from './security';

export class LinkOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkOpenError';
  }
}

function reasonMessage(reason: unknown, fallback: string): string {
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }
  if (reason && typeof reason === 'object') {
    const value = reason as { message?: unknown };
    if (typeof value.message === 'string' && value.message.trim()) {
      return value.message;
    }
  }
  return fallback;
}

/**
 * 用系统默认浏览器/邮件客户端打开外链。
 *
 * 调用方负责把抛出的 `LinkOpenError` 展示给用户；这里不吞错误，避免
 * “点了没反应”。站内链不是本函数的职责，会直接拒绝。
 */
export async function openExternalLink(rawUrl: string): Promise<void> {
  const parsed = parseLinkInput(rawUrl);
  if (parsed.kind === 'note') {
    throw new LinkOpenError('站内笔记链接只能在应用内打开');
  }
  if (parsed.kind === 'invalid') {
    throw new LinkOpenError(parsed.reason);
  }

  if (isTauriRuntime()) {
    try {
      await openUrl(parsed.url);
    } catch (reason) {
      throw new LinkOpenError(
        `无法用系统默认应用打开链接：${reasonMessage(
          reason,
          '请检查本机是否设置了默认浏览器/邮件客户端。',
        )}`,
      );
    }
    return;
  }

  // 不传 'noopener'：现代浏览器在该参数下会按规范返回 null，无法区分
  // “被拦截”和“已打开”。这里打开后立刻断开 opener，行为同样安全。
  const opened =
    typeof window.open === 'function' ? window.open(parsed.url, '_blank') : null;
  if (!opened) {
    throw new LinkOpenError(
      '浏览器拦截了新窗口，请允许弹出窗口后重试，或复制链接到浏览器打开。',
    );
  }
  try {
    opened.opener = null;
  } catch {
    // 跨域窗口可能禁止改写；链接仍已打开。
  }
}

/** 复制链接文本：Clipboard API 优先，Tauri WebView 下退回 execCommand。 */
export async function copyLinkText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走兜底路径
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
