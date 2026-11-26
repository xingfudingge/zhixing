import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DatePicker,
  computeDatePopoverLayout,
  parseDateInput,
} from '../DatePicker';

const TODAY = '2026-10-28';

function Harness({
  initial = TODAY,
  required = false,
  disabled = false,
  readOnly = false,
  showHelper = true,
  min,
  max,
  today = TODAY,
  weekStart,
  onChange,
}: {
  initial?: string | null;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  showHelper?: boolean;
  min?: string;
  max?: string;
  today?: string;
  weekStart?: 'monday' | 'sunday';
  onChange?: (value: string | null) => void;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <label htmlFor="test-date">日期</label>
      <DatePicker
        id="test-date"
        value={value}
        required={required}
        disabled={disabled}
        readOnly={readOnly}
        showHelper={showHelper}
        min={min}
        max={max}
        today={today}
        weekStart={weekStart}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
      <output data-testid="value">{value ?? 'null'}</output>
    </>
  );
}

function field() {
  return screen.getByLabelText('日期') as HTMLInputElement;
}

function trigger() {
  return screen.getByRole('button', { name: /打开日期选择|关闭日期选择/ });
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  return screen.findByRole('dialog', { name: '选择日期' });
}

function popover() {
  return screen.getByRole('dialog', { name: '选择日期' });
}

function dayButton(date: string) {
  const button = popover().querySelector<HTMLElement>(`[data-date="${date}"]`);
  if (!button) {
    throw new Error(`未找到日期格 ${date}`);
  }
  return button;
}

async function typeInto(text: string) {
  const user = userEvent.setup();
  const input = field();
  await user.clear(input);
  if (text) {
    await user.type(input, text);
  }
  await user.keyboard('{Enter}');
  return user;
}

describe('日期输入解析', () => {
  it('接受 YYYY-MM-DD、YYYY/M/D、YYYY年M月D日 并归一化', () => {
    expect(parseDateInput('2026-10-28')).toEqual({
      ok: true,
      value: '2026-10-28',
    });
    expect(parseDateInput('2026/1/3')).toEqual({
      ok: true,
      value: '2026-01-03',
    });
    expect(parseDateInput('  2026年1月3日  ')).toEqual({
      ok: true,
      value: '2026-01-03',
    });
  });

  it('拒绝格式错误、不存在的日期与大小月', () => {
    expect(parseDateInput('2026.10.28')).toMatchObject({
      ok: false,
      reason: 'format',
    });
    expect(parseDateInput('10-28')).toMatchObject({
      ok: false,
      reason: 'format',
    });
    expect(parseDateInput('20261028')).toMatchObject({
      ok: false,
      reason: 'format',
    });
    expect(parseDateInput('2026-13-01')).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(parseDateInput('2026-02-30')).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(parseDateInput('2026-04-31')).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('闰日按真实日历判断', () => {
    expect(parseDateInput('2024-02-29')).toEqual({
      ok: true,
      value: '2024-02-29',
    });
    expect(parseDateInput('2026-02-29')).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
  });

  it('空值与 min/max 边界', () => {
    expect(parseDateInput('')).toEqual({ ok: true, value: null });
    expect(parseDateInput('', { required: true })).toMatchObject({
      ok: false,
      reason: 'required',
      message: '请选择日期',
    });
    expect(
      parseDateInput('2026-09-30', { min: '2026-10-01', max: '2026-10-31' }),
    ).toMatchObject({
      ok: false,
      reason: 'range',
      message: '日期需在 2026-10-01 至 2026-10-31 之间',
    });
    expect(
      parseDateInput('2026-11-01', { min: '2026-10-01', max: '2026-10-31' }),
    ).toMatchObject({ ok: false, reason: 'range' });
    expect(
      parseDateInput('2026-10-01', { min: '2026-10-01', max: '2026-10-31' }),
    ).toEqual({ ok: true, value: '2026-10-01' });
  });
});

describe('统一日期选择器', () => {
  it('单行字段：文本输入 + 日历图标，显示规范值与农历辅助行', () => {
    render(<Harness />);

    const input = field();
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveValue(TODAY);
    expect(input).toHaveAttribute('data-value', TODAY);
    expect(document.querySelector('input[type=date]')).toBeNull();
    expect(document.querySelector('.date-field-primary')).toBeNull();
    expect(document.querySelector('.date-field-lunar')).toBeNull();

    const iconButton = trigger();
    expect(iconButton).toHaveAttribute('aria-haspopup', 'dialog');
    expect(iconButton).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.getByText('2026年10月28日 周三 · 农历丙午年九月十九'),
    ).toBeInTheDocument();
  });

  it('紧凑场景不渲染辅助行', () => {
    render(<Harness showHelper={false} />);
    expect(document.querySelector('.date-field-help')).toBeNull();
    expect(field()).toHaveValue(TODAY);
  });

  it('手输三种格式后 Enter 提交并归一化，不提交外层表单', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <Harness onChange={onChange} />
        <button type="submit">保存</button>
      </form>,
    );

    const input = field();
    await user.clear(input);
    await user.type(input, '2026/11/3');
    // 输入过程中不提交，data-value 仍是旧值。
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('2026/11/3');
    expect(input).toHaveAttribute('data-value', TODAY);

    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('2026-11-03');
    expect(input).toHaveValue('2026-11-03');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('value')).toHaveTextContent('2026-11-03');
  });

  it('中文格式与前后空格也接受', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const input = field();
    await user.clear(input);
    await user.type(input, ' 2026年1月3日 ');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('2026-01-03');
    expect(input).toHaveValue('2026-01-03');
  });

  it('非法日期保留原文、显示行内错误、不写值、不改成今天', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const input = field();
    await user.clear(input);
    await user.type(input, '2026-02-30');
    await user.keyboard('{Enter}');

    expect(input).toHaveValue('2026-02-30');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(
      '日期不存在，请检查年月日',
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('value')).toHaveTextContent(TODAY);

    // 继续编辑即清除错误，但仍不提交。
    await user.type(input, '1');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('格式错误给出格式文案', async () => {
    render(<Harness />);
    const input = field();
    await typeInto('2026.10.28');
    expect(screen.getByRole('alert')).toHaveTextContent(
      '日期格式无效，请按 YYYY-MM-DD 输入',
    );
    expect(input).toHaveValue('2026.10.28');
  });

  it('Esc 恢复最后一次已提交值并清错误', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = field();
    await user.clear(input);
    await user.type(input, '2026-02-30');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(input).toHaveValue(TODAY);
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('失焦提交合法值；非法值保留并保持错误', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Harness onChange={onChange} />
        <button type="button">外部</button>
      </>,
    );

    const input = field();
    await user.clear(input);
    await user.type(input, '2026-11-03');
    await user.click(screen.getByRole('button', { name: '外部' }));
    expect(onChange).toHaveBeenCalledWith('2026-11-03');
    expect(input).toHaveValue('2026-11-03');

    await user.clear(input);
    await user.type(input, '2026-02-30');
    await user.click(screen.getByRole('button', { name: '外部' }));
    expect(input).toHaveValue('2026-02-30');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('非必填清空后 Enter/失焦提交 null；必填空值报错', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { unmount } = render(<Harness onChange={onChange} />);

    await user.clear(field());
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(null);
    expect(screen.getByTestId('value')).toHaveTextContent('null');
    expect(field()).toHaveValue('');
    expect(field()).toHaveAttribute('placeholder', '选择日期');
    unmount();

    const requiredChange = vi.fn();
    render(<Harness initial={null} required onChange={requiredChange} />);
    const input = field();
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('请选择日期');
    expect(requiredChange).not.toHaveBeenCalled();
  });

  it('min/max 越界给范围错误，弹层对应日格禁用', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        min="2026-10-01"
        max="2026-10-31"
        onChange={onChange}
      />,
    );

    await typeInto('2026-11-03');
    expect(screen.getByRole('alert')).toHaveTextContent(
      '日期需在 2026-10-01 至 2026-10-31 之间',
    );
    expect(onChange).not.toHaveBeenCalled();

    const panel = await openPicker(user);
    await user.click(within(panel).getByRole('button', { name: '下个月' }));
    expect(dayButton('2026-11-03')).toBeDisabled();
    expect(dayButton('2026-11-01')).toBeDisabled();
  });

  it('min 越界的今天禁用并说明原因，明天可用且键盘不可选禁用项', async () => {
    const user = userEvent.setup();
    render(
      <Harness min="2026-10-31" max="2026-12-31" today="2026-10-30" />,
    );
    const panel = await openPicker(user);

    const today = within(panel).getByRole('button', { name: '今天' });
    const tomorrow = within(panel).getByRole('button', { name: '明天' });
    expect(today).toBeDisabled();
    expect(today.getAttribute('title')).toContain('2026-10-30');
    expect(today.getAttribute('title')).toContain('2026-10-31');
    expect(tomorrow).toBeEnabled();
    expect(tomorrow).not.toHaveAttribute('title');

    // 禁用项不在 Tab 顺序内，也不能用脚本聚焦。
    today.focus();
    expect(today).not.toHaveFocus();
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>('button:not([disabled])'),
    );
    expect(focusables).toContain(tomorrow);
    expect(focusables).not.toContain(today);
  });

  it('输入框聚焦时点日格只回写待提交值，Esc 取消恢复已提交值', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = field();
    const panel = await openPicker(user);

    await user.click(input);
    await user.click(
      within(panel).getByRole('button', { name: /^2026年10月20日/ }),
    );
    // 失焦发生在弹层内，不得提前提交。
    expect(input).toHaveValue('2026-10-20');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('value')).toHaveTextContent(TODAY);

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    expect(input).toHaveValue(TODAY);
    expect(input).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('IME 组合输入中的 Enter 不提交', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = field();
    fireEvent.change(input, { target: { value: '2026/11/3' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('2026/11/3');
  });

  it('输入合法日期后点日历图标：先提交草稿，弹层打开到该日期', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const input = field();
    await user.clear(input);
    await user.type(input, '2026/11/3');
    await user.click(trigger());
    const panel = await screen.findByRole('dialog', { name: '选择日期' });
    expect(onChange).toHaveBeenCalledWith('2026-11-03');
    expect(input).toHaveValue('2026-11-03');
    expect(within(panel).getByText('2026年11月')).toBeInTheDocument();
  });

  it('面板打开时手输合法日期：面板月份/选中与输入框实时联动，焦点留在输入框', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = await openPicker(user);

    // 点输入框不开/不关弹层，可以直接手输。
    await user.click(field());
    expect(panel).toBeInTheDocument();
    await user.clear(field());
    await user.type(field(), '2026/12/25');

    // 未按 Enter 面板就应立即跟随，但仍不写库。
    expect(panel.getAttribute('data-view-month')).toBe('2026-12');
    expect(within(panel).getByText('2026年12月')).toBeInTheDocument();
    expect(
      panel.querySelector('.dp-day.is-selected')?.getAttribute('data-date'),
    ).toBe('2026-12-25');
    expect(panel.textContent).toMatch(/待确定/);
    expect(screen.getByTestId('value')).toHaveTextContent(TODAY);
    expect(field()).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(field()).toHaveValue('2026-12-25');
    expect(field()).toHaveFocus();
    expect(screen.getByTestId('value')).toHaveTextContent('2026-12-25');
    expect(panel.getAttribute('data-view-month')).toBe('2026-12');
    expect(
      within(panel).getByText('2026年12月25日 周五'),
    ).toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/待确定/);
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it('手输日期提交后再次打开面板定位到该日期', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.clear(field());
    await user.type(field(), '2026年12月25日');
    await user.keyboard('{Enter}');

    const panel = await openPicker(user);
    expect(panel.getAttribute('data-view-month')).toBe('2026-12');
    expect(
      panel.querySelector('.dp-day.is-selected')?.getAttribute('data-date'),
    ).toBe('2026-12-25');
    expect(field()).toHaveValue('2026-12-25');
  });

  it('面板打开时输入非法日期：保留草稿与行内错误，面板与已提交值不变', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = await openPicker(user);

    await user.click(field());
    await user.clear(field());
    await user.type(field(), '2026-02-30');
    await user.keyboard('{Enter}');

    expect(field()).toHaveValue('2026-02-30');
    expect(screen.getByRole('alert')).toHaveTextContent(
      '日期不存在，请检查年月日',
    );
    expect(screen.getByTestId('value')).toHaveTextContent(TODAY);
    expect(panel.getAttribute('data-view-month')).toBe('2026-10');
    expect(
      panel.querySelector('.dp-day.is-selected')?.getAttribute('data-date'),
    ).toBe(TODAY);
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it('面板打开时清空非必填日期：提交 null，面板回到今天所在月份', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = await openPicker(user);

    await user.click(field());
    await user.clear(field());
    await user.keyboard('{Enter}');

    expect(field()).toHaveValue('');
    expect(field()).toHaveAttribute('placeholder', '选择日期');
    expect(screen.getByTestId('value')).toHaveTextContent('null');
    expect(panel.getAttribute('data-view-month')).toBe('2026-10');
    expect(within(panel).getByText('2026年10月28日 周三')).toBeInTheDocument();
  });

  it('面板打开时外部改值：仍打开的弹层跟随新值', async () => {
    function Controlled({ value }: { value: string | null }) {
      return (
        <>
          <label htmlFor="external-date">日期</label>
          <DatePicker
            id="external-date"
            value={value}
            today={TODAY}
            onChange={() => {}}
          />
        </>
      );
    }
    const user = userEvent.setup();
    const { rerender } = render(<Controlled value={TODAY} />);
    const panel = await openPicker(user);

    rerender(<Controlled value="2027-03-05" />);

    expect(field()).toHaveValue('2027-03-05');
    expect(panel.getAttribute('data-view-month')).toBe('2027-03');
    expect(
      panel.querySelector('.dp-day.is-selected')?.getAttribute('data-date'),
    ).toBe('2027-03-05');
  });

  it('周日周起始：列头与 6×7 网格从周日排列', async () => {
    const user = userEvent.setup();
    render(<Harness weekStart="sunday" />);

    const panel = await openPicker(user);
    expect(
      panel.querySelector('.dp-weekdays')?.textContent,
    ).toBe('日一二三四五六');
    expect(panel.querySelector('[data-date="2026-09-27"]')).not.toBeNull();
    expect(panel.querySelectorAll('.dp-day')).toHaveLength(42);
    expect(
      panel.querySelector('[data-date="2026-10-11"]')?.getAttribute(
        'data-workday',
      ),
    ).toBe('rest');
  });

  it('打开后显示 6×7 网格、农历短标签与页脚完整农历', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const panel = await openPicker(user);
    expect(panel).toHaveClass('dp-popover');
    expect(within(panel).getByText('2026年10月')).toBeInTheDocument();
    expect(panel.querySelectorAll('.dp-day')).toHaveLength(42);
    expect(panel.querySelectorAll('.dp-day-lunar')).toHaveLength(42);
    expect(within(panel).getByText('农历丙午年九月十九')).toBeInTheDocument();
    expect(
      within(panel).getByRole('button', { name: /^2026年10月10日/ }),
    ).toHaveTextContent('九月');
    expect(
      within(panel).getByRole('button', { name: /^2026年10月28日/ }),
    ).toHaveClass('is-selected', 'is-today');
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it('点日期：输入框立即显示待提交值，确定后才提交并关闭、焦点回到输入框', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={null} onChange={onChange} />);

    const input = field();
    expect(input).toHaveValue('');
    const panel = await openPicker(user);

    await user.click(
      within(panel).getByRole('button', { name: /^2026年10月1日/ }),
    );
    // 面板 → 输入框实时回写，但只有「确定」才写库。
    expect(input).toHaveValue('2026-10-01');
    expect(within(panel).getByText('2026年10月1日 周四')).toBeInTheDocument();
    expect(panel.textContent).toMatch(/待确定/);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('value')).toHaveTextContent('null');

    await user.click(within(panel).getByRole('button', { name: '确定' }));
    expect(onChange).toHaveBeenCalledWith('2026-10-01');
    expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull();
    expect(input).toHaveFocus();
    expect(input).toHaveValue('2026-10-01');
  });

  it('今天/明天立即提交；清除只对非必填可用', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);

    let panel = await openPicker(user);
    await user.click(within(panel).getByRole('button', { name: '明天' }));
    expect(screen.getByTestId('value')).toHaveTextContent('2026-10-29');
    expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull();

    panel = await openPicker(user);
    await user.click(within(panel).getByRole('button', { name: '清除' }));
    expect(screen.getByTestId('value')).toHaveTextContent('null');
    expect(field()).toHaveValue('');
    expect(field()).toHaveAttribute('placeholder', '选择日期');
    unmount();

    render(<Harness required />);
    panel = await openPicker(user);
    expect(
      within(panel).queryByRole('button', { name: '清除' }),
    ).toBeNull();
  });

  it('Esc 取消且不改值；Enter 提交焦点日；焦点回到输入框', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={null} onChange={onChange} />);

    const input = field();
    await openPicker(user);
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    expect(input).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();

    await openPicker(user);
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(TODAY);
    expect(input).toHaveFocus();
    expect(input).toHaveValue(TODAY);
  });

  it('方向键跨日/跨月，PageDown 换月，Home/End 到周一/周日', async () => {
    const user = userEvent.setup();
    render(<Harness initial="2026-10-31" />);

    const panel = await openPicker(user);
    expect(dayButton('2026-10-31')).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(within(panel).getByText('2026年11月')).toBeInTheDocument();
    expect(dayButton('2026-11-01')).toHaveFocus();

    await user.keyboard('{PageDown}');
    expect(within(panel).getByText('2026年12月')).toBeInTheDocument();
    expect(dayButton('2026-12-01')).toHaveFocus();

    await user.keyboard('{Home}');
    expect(dayButton('2026-11-30')).toHaveFocus();
    await user.keyboard('{End}');
    expect(dayButton('2026-12-06')).toHaveFocus();
  });

  it('双击日期格直接提交', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await openPicker(user);
    await user.dblClick(dayButton('2026-10-20'));
    expect(onChange).toHaveBeenCalledWith('2026-10-20');
    expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull();
  });

  it('点外部取消；旧数据非法值按空值展示，打开今天', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Harness onChange={onChange} initial={'2026-13-40' as string} />
        <button type="button">外部</button>
      </>,
    );

    expect(field()).toHaveValue('');
    expect(field()).toHaveAttribute('placeholder', '选择日期');
    const panel = await openPicker(user);
    expect(within(panel).getByText('2026年10月')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '外部' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('月份切换不改变选中值与预览', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = await openPicker(user);

    await user.click(within(panel).getByRole('button', { name: '下个月' }));
    expect(within(panel).getByText('2026年11月')).toBeInTheDocument();
    expect(within(panel).getByText('2026年10月28日 周三')).toBeInTheDocument();
    expect(dayButton('2026-11-05')).toBeInTheDocument();
    expect(dayButton('2026-10-28')).toHaveClass('is-selected');
  });

  it('≤480px 变为底部弹层，仍保留 42 格', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 390,
    });
    try {
      const user = userEvent.setup();
      render(<Harness />);
      const panel = await openPicker(user);
      expect(panel).toHaveClass('is-sheet');
      expect(panel.querySelectorAll('.dp-day')).toHaveLength(42);
      expect(panel.style.left).toBe('');
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: original,
      });
    }
  });

  it('Tab 在弹层内循环，不逃出弹层', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = await openPicker(user);

    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>('button:not([disabled])'),
    );
    expect(focusables.length).toBeGreaterThan(4);
    focusables[focusables.length - 1].focus();
    await user.tab();
    expect(focusables[0]).toHaveFocus();
    await user.tab({ shift: true });
    expect(focusables[focusables.length - 1]).toHaveFocus();
  });

  it('禁用时输入框与图标都不可用，且不打开弹层', async () => {
    const user = userEvent.setup();
    render(<Harness disabled />);
    const input = field();
    expect(input).toBeDisabled();
    expect(trigger()).toBeDisabled();
    await user.click(trigger());
    expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull();
  });

  it('只读时可聚焦/复制但不能编辑或打开弹层', async () => {
    const user = userEvent.setup();
    render(<Harness readOnly />);
    const input = field();
    expect(input).toHaveAttribute('readonly');
    expect(input).toHaveAttribute('aria-readonly', 'true');
    expect(trigger()).toBeDisabled();
    await user.type(input, '2026-11-03');
    expect(input).toHaveValue(TODAY);
    await user.click(trigger());
    expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull();
  });

  it('图标按钮通过 Enter 打开弹层；aria 状态与辅助行关联正确', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = field();
    const help = document.getElementById(`${input.id}-help`);
    expect(help).not.toBeNull();
    expect(input.getAttribute('aria-describedby')).toContain(`${input.id}-help`);

    trigger().focus();
    await user.keyboard('{Enter}');
    const panel = await screen.findByRole('dialog', { name: '选择日期' });
    expect(panel).toHaveAttribute('id', `${input.id}-panel`);
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute(
      'aria-controls',
      `${input.id}-panel`,
    );
  });
});

describe('取消语义：Esc / 点外部 / 关闭按钮回滚草稿（ZX6-DATE-03 · D13）', () => {
  /** 面板打开时手输一个合法草稿（未提交），返回面板与输入框。 */
  async function typeUncommittedDraft(user: ReturnType<typeof userEvent.setup>) {
    const panel = await openPicker(user);
    const input = field();
    await user.click(input);
    await user.clear(input);
    await user.type(input, '2026/12/24');
    // 实时联动仍生效，但未提交。
    expect(panel.getAttribute('data-view-month')).toBe('2026-12');
    expect(screen.getByTestId('value')).toHaveTextContent(TODAY);
    return { panel, input };
  }

  it('面板打开时输入合法日期后 Esc：恢复已提交值，取消后失焦也不写库', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Harness onChange={onChange} />
        <button type="button">外部</button>
      </>,
    );
    const { input } = await typeUncommittedDraft(user);

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    expect(input).toHaveValue(TODAY);
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();

    // 取消已清 dirty：随后真实失焦不得把被取消的草稿写回。
    fireEvent.blur(input);
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
    expect(screen.getByTestId('value')).toHaveTextContent(TODAY);
  });

  it('面板打开时点外部：恢复已提交值，失焦后也不写库', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Harness onChange={onChange} />
        <button type="button">外部</button>
      </>,
    );
    const { panel, input } = await typeUncommittedDraft(user);

    fireEvent.mouseDown(document.body);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    expect(panel).not.toBeInTheDocument();
    expect(input).toHaveValue(TODAY);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input);
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
    expect(screen.getByTestId('value')).toHaveTextContent(TODAY);
  });

  it('面板打开时点日历图标关闭：按取消恢复已提交值，不写库', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const { panel, input } = await typeUncommittedDraft(user);

    // 关闭按钮：点图标的 pointerdown 先让输入框失焦，再触发 click 关闭。
    await user.click(trigger());
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    expect(panel).not.toBeInTheDocument();
    expect(input).toHaveValue(TODAY);
    expect(input).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.blur(input);
    await waitFor(() => expect(onChange).not.toHaveBeenCalled());
  });

  it('Enter 提交后面板仍打开；再次输入并 Esc 恢复为刚提交的新值', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const panel = await openPicker(user);
    const input = field();

    await user.click(input);
    await user.clear(input);
    await user.type(input, '2026/12/25');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('2026-12-25');
    expect(screen.getByTestId('value')).toHaveTextContent('2026-12-25');
    expect(panel).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, '2026/12/24');
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    expect(input).toHaveValue('2026-12-25');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('value')).toHaveTextContent('2026-12-25');
  });
});

describe('日期弹层定位：碰撞、翻转与滚动同步（ZX7-POPOVER-01）', () => {
  const originalViewport = {
    width: window.innerWidth,
    height: window.innerHeight,
  };

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: originalViewport.width,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalViewport.height,
    });
    vi.restoreAllMocks();
  });

  function setViewport(width: number, height: number) {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: width,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: height,
    });
  }

  function rectOf(rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  }): DOMRect {
    return {
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      toJSON: () => ({}),
    } as DOMRect;
  }

  /** 固定触发器在视口中的矩形；返回可再次调用的 setter，模拟滚动。 */
  function stubAnchor(initial: {
    left: number;
    top: number;
    width?: number;
    height?: number;
  }) {
    const anchor = field().closest('.date-field');
    if (!anchor) {
      throw new Error('未找到 .date-field');
    }
    const spy = vi.spyOn(anchor, 'getBoundingClientRect');
    const apply = (next: {
      left: number;
      top: number;
      width?: number;
      height?: number;
    }) => {
      spy.mockReturnValue(
        rectOf({
          left: next.left,
          top: next.top,
          width: next.width ?? 240,
          height: next.height ?? 40,
        }),
      );
    };
    apply(initial);
    return apply;
  }

  async function openPositioned(user: ReturnType<typeof userEvent.setup>) {
    const panel = await openPicker(user);
    await waitFor(() =>
      expect(panel.getAttribute('data-ready')).toBe('true'),
    );
    return panel;
  }

  function px(value: string): number {
    return Number.parseFloat(value || '0');
  }

  it('下方空间足够时放在下方，不遮触发器', async () => {
    setViewport(1024, 768);
    const user = userEvent.setup();
    render(<Harness />);
    stubAnchor({ left: 120, top: 20 });

    const panel = await openPositioned(user);
    expect(panel).toHaveAttribute('data-placement', 'bottom-start');
    const top = px(panel.style.top);
    const left = px(panel.style.left);
    expect(top).toBe(68); // 20(top) + 40(height) + 8(gap)
    expect(top).toBeGreaterThanOrEqual(20 + 40 + 8);
    expect(left).toBe(120);
    expect(panel.style.visibility).toBe('');
  });

  it('底部字段自动翻到上方，且弹层底边不进入触发器', async () => {
    setViewport(1024, 768);
    const user = userEvent.setup();
    render(<Harness />);
    stubAnchor({ left: 120, top: 700 });

    const panel = await openPositioned(user);
    expect(panel).toHaveAttribute('data-placement', 'top-start');
    const top = px(panel.style.top);
    // 回退高度 430（jsdom 无布局），底边必须停在触发器上方 gap 处。
    expect(top + 430).toBeLessThanOrEqual(700 - 8);
    expect(top).toBeGreaterThanOrEqual(8);
  });

  it('左边缘夹取到视口内，右边缘改为右对齐且不溢出', async () => {
    setViewport(1024, 768);
    const user = userEvent.setup();
    render(<Harness />);
    const apply = stubAnchor({ left: 0, top: 200 });

    let panel = await openPositioned(user);
    expect(px(panel.style.left)).toBe(8);

    apply({ left: 900, top: 200, width: 120 });
    window.dispatchEvent(new Event('scroll'));
    await waitFor(() => expect(px(panel.style.left)).toBe(696));
    expect(px(panel.style.left) + 320).toBeLessThanOrEqual(1024 - 8);
  });

  it('短视口按可用空间较大的一侧限高，弹层在视口内且不遮触发器', async () => {
    setViewport(1024, 430);
    const user = userEvent.setup();
    render(<Harness />);
    stubAnchor({ left: 120, top: 200 });

    const panel = await openPositioned(user);
    expect(panel).toHaveAttribute('data-placement', 'top-start');
    const top = px(panel.style.top);
    const maxHeight = px(panel.style.maxHeight);
    expect(maxHeight).toBe(184);
    expect(top).toBe(8);
    expect(top + maxHeight).toBeLessThanOrEqual(200 - 8);
    expect(top + maxHeight).toBeLessThanOrEqual(430 - 8);
  });

  it('上下可用空间都小于 120px 时回退 sheet（即使视口并不窄）', async () => {
    setViewport(1024, 400);
    const user = userEvent.setup();
    render(<Harness />);
    stubAnchor({ left: 120, top: 120, height: 160 });

    const panel = await openPositioned(user);
    expect(panel).toHaveClass('is-sheet');
    expect(panel).toHaveAttribute('data-placement', 'sheet');
    expect(px(panel.style.maxHeight)).toBe(376);
    expect(panel.style.left).toBe('');
  });

  it('390 窄窗使用 sheet，限高在 visual viewport 内并保留 42 格', async () => {
    setViewport(390, 844);
    const user = userEvent.setup();
    render(<Harness />);
    stubAnchor({ left: 120, top: 700 });

    const panel = await openPositioned(user);
    expect(panel).toHaveClass('is-sheet');
    expect(panel).toHaveAttribute('data-placement', 'sheet');
    expect(px(panel.style.maxHeight)).toBe(820);
    expect(panel.querySelectorAll('.dp-day')).toHaveLength(42);
  });

  it('键盘（图标 Enter / Space）打开时同样完成测量与定位', async () => {
    setViewport(1024, 768);
    const user = userEvent.setup();
    render(<Harness />);
    stubAnchor({ left: 120, top: 20 });

    trigger().focus();
    await user.keyboard('{Enter}');
    let panel = await screen.findByRole('dialog', { name: '选择日期' });
    await waitFor(() =>
      expect(panel.getAttribute('data-ready')).toBe('true'),
    );
    expect(panel).toHaveAttribute('data-placement', 'bottom-start');
    expect(px(panel.style.top)).toBe(68);

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    trigger().focus();
    await user.keyboard(' ');
    panel = await screen.findByRole('dialog', { name: '选择日期' });
    await waitFor(() =>
      expect(panel.getAttribute('data-ready')).toBe('true'),
    );
    expect(panel).toHaveAttribute('data-placement', 'bottom-start');
    expect(px(panel.style.top)).toBe(68);
  });

  it('长页面滚动时跟随锚点；滚动容器内同样生效', async () => {
    setViewport(1024, 768);
    const user = userEvent.setup();
    render(
      <div data-testid="scroller" style={{ height: 200, overflow: 'auto' }}>
        <Harness />
      </div>,
    );
    const apply = stubAnchor({ left: 120, top: 20 });

    const panel = await openPositioned(user);
    expect(panel).toHaveAttribute('data-placement', 'bottom-start');

    apply({ left: 120, top: 700 });
    screen.getByTestId('scroller').dispatchEvent(new Event('scroll'));
    await waitFor(() =>
      expect(panel).toHaveAttribute('data-placement', 'top-start'),
    );
    expect(px(panel.style.top) + 430).toBeLessThanOrEqual(700 - 8);

    apply({ left: 120, top: 10 });
    window.dispatchEvent(new Event('scroll'));
    await waitFor(() =>
      expect(panel).toHaveAttribute('data-placement', 'bottom-start'),
    );
    expect(px(panel.style.top)).toBe(58);
  });

  it('锚点滚出视口超过 24px 时关闭弹层，且不抢焦点', async () => {
    setViewport(1024, 768);
    const user = userEvent.setup();
    render(<Harness />);
    const apply = stubAnchor({ left: 120, top: 20 });

    await openPositioned(user);
    const input = field();
    input.blur();
    apply({ left: 120, top: -100 });
    window.dispatchEvent(new Event('scroll'));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择日期' })).toBeNull(),
    );
    expect(input).not.toHaveFocus();
  });
});

describe('日期弹层几何计算（纯函数）', () => {
  const viewport = {
    left: 0,
    top: 0,
    right: 1024,
    bottom: 768,
    width: 1024,
    height: 768,
  };

  it('下方放得下时 bottom-start，水平 start 对齐并夹取', () => {
    const layout = computeDatePopoverLayout({
      anchor: { left: 0, top: 20, right: 240, bottom: 60 },
      layer: { width: 320, height: 430 },
      viewport,
    });
    expect(layout).toMatchObject({
      placement: 'bottom-start',
      left: 8,
      top: 68,
      maxHeight: null,
      layer: 'base',
    });
  });

  it('下方放不下、上方放得下时翻到 top-start', () => {
    const layout = computeDatePopoverLayout({
      anchor: { left: 120, top: 700, right: 360, bottom: 740 },
      layer: { width: 320, height: 430 },
      viewport,
    });
    expect(layout.placement).toBe('top-start');
    expect(layout.top + 430).toBeLessThanOrEqual(700 - 8);
  });

  it('两侧都放不下时取空间大的一侧并限高', () => {
    const layout = computeDatePopoverLayout({
      anchor: { left: 120, top: 30, right: 360, bottom: 70 },
      layer: { width: 320, height: 430 },
      viewport: { ...viewport, height: 400, bottom: 400 },
    });
    expect(layout.placement).toBe('bottom-start');
    expect(layout.maxHeight).toBe(314);
    expect(layout.top + (layout.maxHeight ?? 0)).toBeLessThanOrEqual(400 - 8);
  });

  it('右侧溢出改为 end 对齐，最后仍夹取在视口内', () => {
    const layout = computeDatePopoverLayout({
      anchor: { left: 900, top: 20, right: 1020, bottom: 60 },
      layer: { width: 320, height: 430 },
      viewport,
    });
    expect(layout.left).toBe(696);
    expect(layout.left + 320).toBeLessThanOrEqual(1024 - 8);
  });

  it('窄窗 / 矮视口 / 两侧局促都回退 sheet，且模态内使用 modal 层', () => {
    for (const input of [
      {
        anchor: { left: 40, top: 20, right: 280, bottom: 60 },
        viewport: { ...viewport, width: 390, right: 390 },
      },
      {
        anchor: { left: 40, top: 20, right: 280, bottom: 60 },
        viewport: { ...viewport, height: 320, bottom: 320 },
      },
      {
        anchor: { left: 40, top: 120, right: 280, bottom: 280 },
        viewport: { ...viewport, height: 400, bottom: 400 },
      },
    ] as const) {
      const layout = computeDatePopoverLayout({
        anchor: input.anchor,
        layer: { width: 320, height: 430 },
        viewport: input.viewport,
        inModal: true,
      });
      expect(layout.placement).toBe('sheet');
      expect(layout.layer).toBe('modal');
      expect(layout.maxHeight).toBe(input.viewport.height - 24);
    }
  });
});
