/**
 * ZX6-QA-03 独立复验 · D13 日期取消语义（不抄实现者自测）
 *
 * 设计口径（ZX6-DESIGN-01）：
 * - §9.4：Escape「面板打开：关闭并恢复 draft=committed；面板关闭：恢复输入为
 *   committed」；「点外部 | 取消，恢复 draft=committed，不写值」。
 * - §9.6-6：面板打开时输入 2026-12-01 后 Esc：输入恢复 2026-12-25；面板关闭。
 *
 * 本文件只按设计断言，覆盖 zx6-qa-02-findings 之外的取消路径与边界：
 * 关闭按钮、面板点选后取消、非法/越界草稿、空值、快速连点、取消后 Enter/失焦、
 * 正常失焦提交回归、Enter 提交后再取消。
 *
 * 负责卡：`t_44626faa` / ZX6-DATE-03（复验卡 ZX6-QA-03）。
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '../app/node_modules/@testing-library/react/dist/index.js';
import userEvent from '../app/node_modules/@testing-library/user-event/dist/esm/index.js';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DatePicker } from '../app/src/ui/date/DatePicker';

type User = ReturnType<typeof userEvent.setup>;

const COMMITTED = '2026-11-03';

function Harness({
  initial = COMMITTED,
  onChange,
  required,
  min,
  max,
}: {
  initial?: string | null;
  onChange?: (value: string | null) => void;
  required?: boolean;
  min?: string;
  max?: string;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <label htmlFor="qa3-date">日期</label>
      <DatePicker
        id="qa3-date"
        value={value}
        today="2026-10-30"
        required={required}
        min={min}
        max={max}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
      <output data-testid="committed">{value ?? 'null'}</output>
      <button type="button">外部按钮</button>
    </>
  );
}

const input = () => screen.getByLabelText('日期') as HTMLInputElement;
const external = () => screen.getByRole('button', { name: '外部按钮' });
const trigger = (open: boolean) =>
  screen.getByRole('button', {
    name: open ? '关闭日期选择' : '打开日期选择',
  });

async function openPanel(user: User) {
  await user.click(trigger(false));
  await screen.findByRole('dialog', { name: '选择日期' });
}

async function typeDraft(user: User, text: string) {
  await user.click(input());
  await user.clear(input());
  await user.type(input(), text);
}

async function expectPanelClosed() {
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
  );
}

describe('D13 独立复验 · 面板打开时的取消路径', () => {
  it('Esc：不完整草稿恢复已提交值，无行内错误，失焦也不写库', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await openPanel(user);
    await typeDraft(user, '2026-11');

    await user.keyboard('{Escape}');
    await expectPanelClosed();
    expect(input()).toHaveValue(COMMITTED);
    expect(input()).not.toHaveAttribute('aria-invalid');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input());
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
    expect(screen.getByTestId('committed')).toHaveTextContent(COMMITTED);
  });

  it('Esc：越界草稿恢复已提交值并清掉范围错误（min=2026-11-01）', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} min="2026-11-01" />);
    await openPanel(user);
    await typeDraft(user, '2026-10-15');
    // 完整但越界：输入时立即给出范围错误。
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await expectPanelClosed();
    expect(input()).toHaveValue(COMMITTED);
    expect(input()).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('关闭按钮（真实指针）取消：恢复已提交值、焦点回输入框、失焦不写库、重开仍选已提交值', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await openPanel(user);
    await typeDraft(user, '2026/12/24');

    await user.click(trigger(true));
    await expectPanelClosed();
    expect(input()).toHaveValue(COMMITTED);
    expect(input()).toHaveFocus();
    expect(trigger(false)).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input());
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());

    await openPanel(user);
    const selected = document.querySelector('.dp-day.is-selected');
    expect(selected?.getAttribute('data-date')).toBe(COMMITTED);
    expect(document.querySelector('.dp-preview-pending')).toBeNull();
    expect(input()).toHaveValue(COMMITTED);
  });

  it('面板点选日期格后 Esc：取消预览，恢复已提交值', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await openPanel(user);

    const cell = document.querySelector<HTMLElement>('[data-date="2026-11-20"]');
    expect(cell).not.toBeNull();
    await user.click(cell!);
    expect(input()).toHaveValue('2026-11-20');
    expect(document.querySelector('.dp-preview-pending')).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    await expectPanelClosed();
    expect(input()).toHaveValue(COMMITTED);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input());
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
  });

  it('面板点选日期格后点外部：取消预览，恢复已提交值', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await openPanel(user);
    const cell = document.querySelector<HTMLElement>('[data-date="2026-11-20"]');
    await user.click(cell!);
    expect(input()).toHaveValue('2026-11-20');

    fireEvent.mouseDown(document.body);
    await expectPanelClosed();
    expect(input()).toHaveValue(COMMITTED);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input());
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
  });
});

describe('D13 独立复验 · 面板关闭时与边界状态', () => {
  it('面板关闭时 Esc：非法草稿恢复已提交值并清错误，失焦不写库', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await typeDraft(user, '2026-13-45');
    expect(input()).toHaveAttribute('aria-invalid', 'true');

    await user.keyboard('{Escape}');
    expect(input()).toHaveValue(COMMITTED);
    expect(input()).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input());
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
  });

  it('空值（value=null）：打开面板输入后 Esc 回到空，不写库', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={null} onChange={onChange} />);
    expect(input()).toHaveValue('');
    await openPanel(user);
    await typeDraft(user, '2026/12/24');

    await user.keyboard('{Escape}');
    await expectPanelClosed();
    expect(input()).toHaveValue('');
    expect(screen.getByTestId('committed')).toHaveTextContent('null');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input());
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
  });

  it('取消后按 Enter：不得把残留草稿提交（面板已关，输入已是已提交值）', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await openPanel(user);
    await typeDraft(user, '2026/12/24');
    await user.keyboard('{Escape}');
    await expectPanelClosed();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
    expect(input()).toHaveValue(COMMITTED);
    expect(screen.getByTestId('committed')).toHaveTextContent(COMMITTED);
  });

  it('快速连点尾部图标 6 次：面板状态闭合、输入保持已提交值、零 onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    for (let i = 0; i < 6; i += 1) {
      await user.click(i % 2 === 0 ? trigger(false) : trigger(true));
    }
    await expectPanelClosed();
    expect(input()).toHaveValue(COMMITTED);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('连续 5 轮「打开→输入→Esc」：每次都恢复已提交值，零 onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    for (let i = 0; i < 5; i += 1) {
      await openPanel(user);
      await typeDraft(user, `2026/12/${20 + i}`);
      expect(input()).toHaveValue(`2026/12/${20 + i}`);
      await user.keyboard('{Escape}');
      await expectPanelClosed();
      expect(input()).toHaveValue(COMMITTED);
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('committed')).toHaveTextContent(COMMITTED);
  });
});

describe('D13 独立复验 · 修复不得破坏既有提交语义', () => {
  it('面板关闭时正常失焦：合法草稿仍提交一次并归一化（回归）', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await typeDraft(user, '2026/12/25');
    await user.click(external());

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith('2026-12-25');
    expect(input()).toHaveValue('2026-12-25');
    expect(screen.getByTestId('committed')).toHaveTextContent('2026-12-25');
  });

  it('Enter 提交后再输入并 Esc：恢复为刚提交的新值，onChange 只发生一次', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await openPanel(user);
    await typeDraft(user, '2026/12/25');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('2026-12-25'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input()).toHaveValue('2026-12-25');

    await typeDraft(user, '2026/12/24');
    await user.keyboard('{Escape}');
    await expectPanelClosed();
    expect(input()).toHaveValue('2026-12-25');
    expect(onChange).toHaveBeenCalledTimes(1);

    fireEvent.blur(input());
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('committed')).toHaveTextContent('2026-12-25');
  });

  it('面板点选后按「确定」：正常提交点选值（取消路径不得吞掉确定）', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await openPanel(user);
    const cell = document.querySelector<HTMLElement>('[data-date="2026-11-20"]');
    await user.click(cell!);
    await user.click(screen.getByRole('button', { name: '确定' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('2026-11-20'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input()).toHaveValue('2026-11-20');
    await expectPanelClosed();
  });
});
