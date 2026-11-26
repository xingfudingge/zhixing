/**
 * 全局快捷键（P1-06）。
 *
 * 只声明“按了什么键 → 要打开什么”的规则，不直接依赖 React：
 * - `⌘K / Ctrl+K`：全局搜索；
 * - `⌘N / Ctrl+N`：快速创建任务；
 * - `⌘⇧N / Ctrl+Shift+N`：快速创建笔记；
 * - `?`：产品导览。
 *
 * 单键 `?` 必须避开输入框、文本域、下拉框和 contenteditable，否则用户在标题里
 * 打问号会莫名打开导览（原型缺陷，正式版在此修正）。带修饰键的命令式快捷键
 * 允许在输入框内使用，但同样会阻止浏览器默认行为（例如 Ctrl+N 新开窗口）。
 */

export type AppCommand =
  | 'search'
  | 'quick-add-task'
  | 'quick-add-note'
  | 'tour';

/** 顶栏按钮与快捷键共用的命令事件名。 */
export const APP_COMMAND_EVENT = 'zhixing:app-command';

export type ShortcutHandlers = {
  onSearch: () => void;
  onQuickAdd: (kind: 'task' | 'note') => void;
  onTour: () => void;
};

export type ShortcutKeyboardEvent = Pick<
  KeyboardEvent,
  | 'key'
  | 'metaKey'
  | 'ctrlKey'
  | 'altKey'
  | 'shiftKey'
  | 'target'
  | 'defaultPrevented'
  | 'isComposing'
>;

export type ShortcutResolution = {
  command: AppCommand;
  preventDefault: boolean;
};

/**
 * 输入控件判定。`closest` 用于命中 contenteditable 内部的行内元素；
 * 在测试或非浏览器环境里拿不到 HTMLElement 时返回 false。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    return true;
  }
  if (target.isContentEditable) {
    return true;
  }
  return target.closest('[contenteditable="true"]') !== null;
}

export function resolveShortcut(
  event: ShortcutKeyboardEvent,
  editable: boolean = isEditableTarget(event.target),
): ShortcutResolution | null {
  if (event.defaultPrevented || event.isComposing) {
    return null;
  }

  const key = event.key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;

  if (mod && !event.altKey) {
    if (key === 'k') {
      return { command: 'search', preventDefault: true };
    }
    if (key === 'n') {
      return {
        command: event.shiftKey ? 'quick-add-note' : 'quick-add-task',
        preventDefault: true,
      };
    }
  }

  // 单键 `?` 只在非输入环境中生效；Shift 是产生 ? 的常规方式，不额外限制。
  if (!mod && !event.altKey && event.key === '?' && !editable) {
    return { command: 'tour', preventDefault: true };
  }

  return null;
}

export function dispatchAppCommand(command: AppCommand): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<AppCommand>(APP_COMMAND_EVENT, { detail: command }),
  );
}

/**
 * 安装全局快捷键并返回卸载函数。真正的 UI 开关由调用方决定，
 * 这里不持有 React 状态，便于在测试里独立验证键盘规则。
 */
export function installGlobalShortcuts(
  handlers: ShortcutHandlers,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    const resolution = resolveShortcut(event);
    if (!resolution) {
      return;
    }
    if (resolution.preventDefault) {
      event.preventDefault();
    }
    switch (resolution.command) {
      case 'search':
        handlers.onSearch();
        break;
      case 'quick-add-task':
        handlers.onQuickAdd('task');
        break;
      case 'quick-add-note':
        handlers.onQuickAdd('note');
        break;
      case 'tour':
        handlers.onTour();
        break;
      default:
        break;
    }
  };

  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
