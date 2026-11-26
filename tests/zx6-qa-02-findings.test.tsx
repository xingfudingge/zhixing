/**
 * ZX6-QA-02 独立复验 · 新发现缺陷（按设计预期断言，当前失败）
 *
 * 本文件只记录 ZX6-QA-02 复验中新发现的、与 ZX6-DESIGN-01 §9.4/§9.6-6
 * 冲突的日期取消语义问题（D13）。断言按设计写，不按现状改。
 *
 * 设计原文：
 * - §9.4：「Escape | 面板打开：关闭并恢复 draft=committed；面板关闭：恢复
 *   输入为 committed」；「点外部 | 取消，恢复 draft=committed，不写值」。
 * - §9.6-6：「面板打开时输入 2026-12-01 后 Esc：输入恢复 2026-12-25；面板关闭。」
 *
 * 复现（真实行为）：
 * 1. 已提交 2026-11-03，打开面板，输入 2026-12-24（不按 Enter）；
 * 2. 按 Esc / 点外部：面板关闭，但输入框仍显示 2026-12-24；
 * 3. 焦点离开输入框：onChange 收到 2026-12-24 —— 被取消的草稿仍被写入。
 *
 * 负责卡：`t_18ca5a24` / ZX6-DATE-02。
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

function DateHarness({
  onChange,
}: {
  onChange?: (value: string | null) => void;
}) {
  const [value, setValue] = useState<string | null>('2026-11-03');
  return (
    <>
      <label htmlFor="qa2-finding-date">日期</label>
      <DatePicker
        id="qa2-finding-date"
        value={value}
        today="2026-10-30"
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

function dateInput() {
  return screen.getByLabelText('日期') as HTMLInputElement;
}

async function openAndType(user: User, text: string) {
  await user.click(screen.getByRole('button', { name: /打开日期选择/ }));
  await screen.findByRole('dialog', { name: '选择日期' });
  const input = dateInput();
  await user.clear(input);
  await user.type(input, text);
  return input;
}

describe('D13 · 取消没有恢复已提交值，且被取消的草稿仍会提交（ZX6-DESIGN-01 §9.4/§9.6-6）', () => {
  it('面板打开时输入合法日期后按 Esc：输入框应立即恢复 2026-11-03', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateHarness onChange={onChange} />);
    const input = await openAndType(user, '2026-12-24');

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );

    expect(input).toHaveValue('2026-11-03');
    expect(screen.getByTestId('committed')).toHaveTextContent('2026-11-03');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Esc 取消后失焦：不得把被取消的草稿写入', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateHarness onChange={onChange} />);
    const input = await openAndType(user, '2026-12-24');

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    fireEvent.blur(input);
    await waitFor(() => {
      expect(onChange).not.toHaveBeenCalled();
    });
    expect(screen.getByTestId('committed')).toHaveTextContent('2026-11-03');
  });

  it('点外部取消：输入恢复已提交值，失焦后也不写入', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateHarness onChange={onChange} />);
    const input = await openAndType(user, '2026-12-24');

    fireEvent.mouseDown(document.body);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    expect(input).toHaveValue('2026-11-03');

    fireEvent.blur(input);
    await waitFor(() => {
      expect(onChange).not.toHaveBeenCalled();
    });
    expect(screen.getByTestId('committed')).toHaveTextContent('2026-11-03');
  });
});
