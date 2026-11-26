import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { Modal } from '../Modal';
import { getFocusableElements } from '../FocusTrap';

function Harness({ triggerLabel = '打开模态' }: { triggerLabel?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        {triggerLabel}
      </button>
      <button type="button">背景按钮</button>
      <Modal
        open={open}
        title="恢复预览"
        description="测试焦点陷阱"
        onClose={() => setOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setOpen(false)}>
              取消
            </button>
            <button type="button">确认恢复</button>
          </>
        }
      >
        <label>
          名称
          <input aria-label="名称" />
        </label>
        <button type="button" disabled>
          禁用按钮
        </button>
      </Modal>
    </div>
  );
}

describe('FocusTrap 与 Modal', () => {
  it('Tab 在模态内循环，Shift+Tab 反向循环', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: '打开模态' }));

    const dialog = screen.getByRole('dialog', { name: '恢复预览' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('测试焦点陷阱');

    const close = screen.getByRole('button', { name: '关闭对话框' });
    const input = screen.getByRole('textbox', { name: '名称' });
    const cancel = screen.getByRole('button', { name: '取消' });
    const confirm = screen.getByRole('button', { name: '确认恢复' });

    expect(close).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
  });

  it('Esc 关闭并把焦点还给触发按钮', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '打开模态' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('getFocusableElements 排除禁用与隐藏元素', () => {
    const host = document.createElement('div');
    host.innerHTML = `
      <button id="a">A</button>
      <button id="b" disabled>B</button>
      <button id="c" tabindex="-1">C</button>
      <div id="d" tabindex="0">D</div>
      <input id="e" type="hidden" />
      <div aria-hidden="true"><button id="f">F</button></div>
      <a id="g" href="#x">G</a>
    `;
    document.body.appendChild(host);
    expect(getFocusableElements(host).map((element) => element.id)).toEqual([
      'a',
      'd',
      'g',
    ]);
    host.remove();
  });
});
