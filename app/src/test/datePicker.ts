/**
 * 测试用日期选择器驱动：统一走 `DatePicker` 的单行字段与弹层，不依赖原生 date input。
 * 生产代码不引用本文件。
 */

import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

function fieldRoot(field: HTMLElement): HTMLElement {
  const root = field.closest<HTMLElement>('.date-field-group');
  if (!root) {
    throw new Error('未找到 .date-field-group：请传入日期输入框或字段容器');
  }
  return root;
}

/** 传入输入框 / 字段容器均可，返回真正的文本输入框。 */
export function dateFieldInput(field: HTMLElement): HTMLInputElement {
  if (field instanceof HTMLInputElement) {
    return field;
  }
  const input = fieldRoot(field).querySelector<HTMLInputElement>(
    'input.date-field-input',
  );
  if (!input) {
    throw new Error('日期字段内没有 .date-field-input');
  }
  return input;
}

/** 日历图标按钮（打开/关闭弹层）。 */
export function dateFieldTrigger(field: HTMLElement): HTMLButtonElement {
  const trigger = fieldRoot(field).querySelector<HTMLButtonElement>(
    '.date-field-icon',
  );
  if (!trigger) {
    throw new Error('日期字段内没有 .date-field-icon');
  }
  return trigger;
}

/** 点日历图标打开弹层；传入输入框或字段容器均可。 */
export async function openDatePicker(
  user: UserEvent,
  field: HTMLElement,
): Promise<HTMLElement> {
  await user.click(dateFieldTrigger(field));
  return screen.findByRole('dialog', { name: '选择日期' });
}

function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

function targetMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  return `${year}年${month}月`;
}

/** 选日期并点「确定」提交。跨月会自动翻月。 */
export async function pickDate(
  user: UserEvent,
  field: HTMLElement,
  iso: string,
): Promise<void> {
  const panel = await openDatePicker(user, field);
  const target = monthOf(iso);
  let guard = 0;
  while (panel.getAttribute('data-view-month') !== target && guard < 36) {
    const current = panel.getAttribute('data-view-month') ?? '';
    const next = target > current;
    await user.click(
      within(panel).getByRole('button', {
        name: next ? '下个月' : '上个月',
      }),
    );
    guard += 1;
  }
  const cell = panel.querySelector<HTMLElement>(`[data-date="${iso}"]`);
  if (!cell) {
    throw new Error(`日期格 ${iso} 不在 ${targetMonthLabel(target)}`);
  }
  await user.click(cell);
  await user.click(within(panel).getByRole('button', { name: '确定' }));
}

/** 打开弹层并点「清除」，提交 null。 */
export async function clearDate(
  user: UserEvent,
  field: HTMLElement,
): Promise<void> {
  const panel = await openDatePicker(user, field);
  await user.click(within(panel).getByRole('button', { name: '清除' }));
}

/** 清空后手输日期并按 Enter 提交（默认提交，可传 false 只输入）。 */
export async function typeDate(
  user: UserEvent,
  field: HTMLElement,
  text: string,
  { submit = true }: { submit?: boolean } = {},
): Promise<void> {
  const input = dateFieldInput(field);
  await user.clear(input);
  if (text) {
    await user.type(input, text);
  }
  if (submit) {
    await user.keyboard('{Enter}');
  }
}

/** 输入框里的当前文本（YYYY-MM-DD / 空串，或用户未提交的草稿）。 */
export function dateFieldValue(field: HTMLElement): string {
  return dateFieldInput(field).value;
}
