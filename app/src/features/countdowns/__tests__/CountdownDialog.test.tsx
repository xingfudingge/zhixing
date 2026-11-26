/**
 * 倒数日弹窗：农历模式下只能出现一条农历提示。
 * 日期字段自身不渲染辅助行（showHelper={false}），农历信息由
 * `countdown-lunar-preview` 统一回显，避免同一信息出现两遍。
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CountdownDialog } from '../CountdownDialog';

function renderDialog() {
  render(
    <CountdownDialog
      open
      initialDate="2026-10-28"
      countdown={null}
      onClose={vi.fn()}
      onSubmit={vi.fn(async () => undefined)}
    />,
  );
}

describe('CountdownDialog 农历提示', () => {
  it('切到农历后只保留一条农历提示', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.selectOptions(screen.getByLabelText('历法'), 'lunar');

    // 日期字段不重复渲染 .date-field-help；唯一提示来自弹窗预览。
    expect(document.querySelectorAll('.date-field-help')).toHaveLength(0);
    expect(screen.getByTestId('countdown-lunar-preview')).toHaveTextContent(
      '农历九月十九',
    );
    expect(
      screen.getAllByText(/目标公历日对应/),
    ).toHaveLength(1);
  });
});
