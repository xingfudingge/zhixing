import { fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { installGlobalModalFocusTrap } from '../globalFocusTrap';

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = '';
});

describe('全局模态焦点兜底', () => {
  it('Tab/Shift+Tab 在历史对话框内循环，关闭后焦点归还', async () => {
    const user = userEvent.setup();
    const trigger = document.createElement('button');
    trigger.textContent = '打开';
    document.body.appendChild(trigger);
    trigger.focus();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = '<button id="a">A</button><button id="b">B</button>';
    document.body.appendChild(dialog);

    cleanup = installGlobalModalFocusTrap(document);
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    await user.tab();
    expect(document.activeElement?.id).toBe('a');
    await user.tab();
    expect(document.activeElement?.id).toBe('b');
    await user.tab();
    expect(document.activeElement?.id).toBe('a');
    await user.tab({ shift: true });
    expect(document.activeElement?.id).toBe('b');

    dialog.remove();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('标记 data-a11y-managed 的自带 FocusTrap 对话框不被全局接管', async () => {
    const user = userEvent.setup();
    const trigger = document.createElement('button');
    trigger.textContent = '打开';
    const background = document.createElement('button');
    background.textContent = '背景';
    document.body.append(trigger, background);
    trigger.focus();

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('data-a11y-managed', 'true');
    dialog.innerHTML = '<button id="inside">inside</button>';
    document.body.appendChild(dialog);

    cleanup = installGlobalModalFocusTrap(document);
    await user.tab();
    expect(document.activeElement).toBe(background);
    fireEvent.focusIn(dialog.querySelector('#inside')!);
    expect(document.activeElement).toBe(background);
  });
});
