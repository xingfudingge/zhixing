import { describe, expect, it, vi } from 'vitest';

import {
  APP_COMMAND_EVENT,
  dispatchAppCommand,
  installGlobalShortcuts,
  isEditableTarget,
  resolveShortcut,
  type ShortcutKeyboardEvent,
} from '../../../app/shortcuts';

function key(
  overrides: Partial<ShortcutKeyboardEvent> & Pick<ShortcutKeyboardEvent, 'key'>,
): ShortcutKeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: document.body,
    defaultPrevented: false,
    isComposing: false,
    ...overrides,
  };
}

describe('全局快捷键规则', () => {
  it('⌘K / Ctrl+K 打开搜索，⌘N 建任务，⌘⇧N 建笔记', () => {
    expect(resolveShortcut(key({ key: 'k', metaKey: true }))).toEqual({
      command: 'search',
      preventDefault: true,
    });
    expect(resolveShortcut(key({ key: 'K', ctrlKey: true }))).toEqual({
      command: 'search',
      preventDefault: true,
    });
    expect(resolveShortcut(key({ key: 'n', metaKey: true }))).toEqual({
      command: 'quick-add-task',
      preventDefault: true,
    });
    expect(
      resolveShortcut(key({ key: 'n', metaKey: true, shiftKey: true })),
    ).toEqual({
      command: 'quick-add-note',
      preventDefault: true,
    });
  });

  it('单键 ? 在正文/输入框里不触发，在普通区域打开导览', () => {
    expect(resolveShortcut(key({ key: '?' }))).toEqual({
      command: 'tour',
      preventDefault: true,
    });
    expect(resolveShortcut(key({ key: '?' }), true)).toBeNull();
  });

  it('输入框聚焦时修饰键快捷键仍然可用', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(isEditableTarget(input)).toBe(true);
    expect(
      resolveShortcut(
        key({ key: 'k', metaKey: true, target: input }),
      ),
    ).toEqual({ command: 'search', preventDefault: true });
    expect(
      resolveShortcut(key({ key: '?', target: input })),
    ).toBeNull();
    input.remove();
  });

  it('contenteditable、textarea、select 都算输入环境', () => {
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    document.body.append(editor, textarea, select);

    expect(isEditableTarget(editor)).toBe(true);
    expect(isEditableTarget(textarea)).toBe(true);
    expect(isEditableTarget(select)).toBe(true);
    expect(isEditableTarget(document.body)).toBe(false);

    editor.remove();
    textarea.remove();
    select.remove();
  });

  it('输入法组合、已 preventDefault、Alt 组合都不触发', () => {
    expect(
      resolveShortcut(key({ key: '?', isComposing: true })),
    ).toBeNull();
    expect(
      resolveShortcut(
        key({ key: 'k', metaKey: true, defaultPrevented: true }),
      ),
    ).toBeNull();
    expect(
      resolveShortcut(key({ key: 'k', metaKey: true, altKey: true })),
    ).toBeNull();
  });

  it('安装后拦截按键并回调，卸载后不再触发', () => {
    const onSearch = vi.fn();
    const onQuickAdd = vi.fn();
    const onTour = vi.fn();
    const remove = installGlobalShortcuts({
      onSearch,
      onQuickAdd,
      onTour,
    });

    const search = new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: true,
      cancelable: true,
    });
    window.dispatchEvent(search);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(search.defaultPrevented).toBe(true);

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'n',
        ctrlKey: true,
        cancelable: true,
      }),
    );
    expect(onQuickAdd).toHaveBeenCalledWith('task');

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '?',
        shiftKey: true,
        cancelable: true,
      }),
    );
    expect(onTour).toHaveBeenCalledTimes(1);

    remove();
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        metaKey: true,
        cancelable: true,
      }),
    );
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('顶栏按钮与快捷键共用同一个命令事件', () => {
    const handler = vi.fn();
    window.addEventListener(APP_COMMAND_EVENT, handler);
    dispatchAppCommand('search');
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0] as CustomEvent<string>;
    expect(event.detail).toBe('search');
    window.removeEventListener(APP_COMMAND_EVENT, handler);
  });
});
