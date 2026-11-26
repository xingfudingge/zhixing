import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import App from '../../../App';
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  applyAppearance,
} from '../../../app/shell/appearance';
import {
  DEFAULT_APP_SETTINGS,
  SETTINGS_STORAGE_KEY,
} from '../../../data/repositories/settings';
import { applySettingsToDocument } from '../runtime';

function resetShellState() {
  window.history.replaceState({}, '', '/');
  window.localStorage.clear();
  applyAppearance(DEFAULT_APPEARANCE);
  applySettingsToDocument(DEFAULT_APP_SETTINGS);
}

beforeEach(() => {
  resetShellState();
});

afterEach(() => {
  resetShellState();
});

describe('设置页与全局外壳', () => {
  it('设置页切深色后顶栏外观菜单同步回显', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/settings/appearance');
    render(<App />);

    await screen.findByRole('heading', { level: 1, name: '设置' });
    await user.click(screen.getByRole('button', { name: '深色' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');

    await user.click(screen.getByRole('button', { name: '外观设置' }));
    const dialog = await screen.findByRole('dialog', { name: '外观设置' });
    expect(
      within(dialog).getByRole('button', { name: '深色' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('顶栏改密度后设置页回显同步', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/settings/appearance');
    render(<App />);

    await screen.findByRole('heading', { level: 1, name: '设置' });
    await user.click(screen.getByRole('button', { name: '外观设置' }));
    const dialog = await screen.findByRole('dialog', { name: '外观设置' });
    await user.click(within(dialog).getByRole('button', { name: '紧凑' }));
    await user.keyboard('{Escape}');

    expect(
      screen.getByRole('button', { name: '紧凑' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement).toHaveAttribute(
      'data-density',
      'compact',
    );
  });

  it('外观与编辑器偏好写入 localStorage，重新挂载后保持', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/settings/appearance');
    const view = render(<App />);

    await screen.findByRole('heading', { level: 1, name: '设置' });
    await user.click(screen.getByRole('button', { name: '深色' }));
    await user.selectOptions(screen.getByLabelText('正文字号'), '20');
    await user.click(screen.getByRole('button', { name: '1024' }));

    expect(
      JSON.parse(
        window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? 'null',
      ).theme,
    ).toBe('dark');
    expect(
      JSON.parse(
        window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null',
      ).editor,
    ).toMatchObject({ fontSize: 20, width: 1024 });

    view.unmount();
    render(<App />);

    await screen.findByRole('heading', { level: 1, name: '设置' });
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(
      document.documentElement.style.getPropertyValue('--editor-font-size'),
    ).toBe('20px');
    expect(
      document.documentElement.style.getPropertyValue('--editor-width'),
    ).toBe('1024px');
  });
});
