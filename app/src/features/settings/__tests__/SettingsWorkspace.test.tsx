import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';

import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  applyAppearance,
} from '../../../app/shell/appearance';
import { settingsGroupOf } from '../../../app/shell/navigation';
import {
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  readLocalSettings,
  SETTING_KEYS,
  type AppSettings,
} from '../../../data/repositories/settings';
import { OCR_SETTINGS_KEY } from '../../ocr/settings';
import { applySettingsToDocument } from '../runtime';
import { SettingsWorkspace } from '../SettingsWorkspace';
import type { SettingsSource } from '../source';
import {
  createFakeSettingsSource,
  type FakeSettingsSourceOptions,
} from './fakeSettingsSource';

const NOW = () => new Date('2026-10-26T08:05:00.000Z');

function Harness({ source }: { source: SettingsSource }) {
  const { group } = useParams();
  const meta = settingsGroupOf(group) ?? settingsGroupOf('appearance')!;
  return (
    <SettingsWorkspace group={meta.id} source={source} now={NOW} />
  );
}

function renderGroup(
  group: string,
  options: FakeSettingsSourceOptions = {},
) {
  const fake = createFakeSettingsSource(options);
  const view = render(
    <MemoryRouter initialEntries={[`/settings/${group}`]}>
      <Routes>
        <Route path="/settings/:group" element={<Harness source={fake.source} />} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...fake, ...view };
}

function nav() {
  return screen.getByRole('navigation', { name: '设置分组' });
}

beforeEach(() => {
  window.localStorage.clear();
  applyAppearance(DEFAULT_APPEARANCE);
  applySettingsToDocument(DEFAULT_APP_SETTINGS);
});

afterEach(() => {
  window.localStorage.clear();
  applyAppearance(DEFAULT_APPEARANCE);
  applySettingsToDocument(DEFAULT_APP_SETTINGS);
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  vi.restoreAllMocks();
});

describe('设置页结构', () => {
  it('8 个分组全部可达，当前分组高亮', () => {
    renderGroup('appearance');

    expect(
      screen.getByRole('heading', { level: 1, name: '设置' }),
    ).toBeInTheDocument();
    const links = within(nav()).getAllByRole('link');
    expect(links).toHaveLength(8);
    expect(
      within(nav()).getByRole('link', { name: '外观与阅读' }),
    ).toHaveAttribute('aria-current', 'page');
    expect(
      screen.getByRole('heading', { level: 2, name: '外观与阅读' }),
    ).toBeInTheDocument();
  });

  it('切换左侧分组后渲染对应表单', async () => {
    const user = userEvent.setup();
    renderGroup('appearance');

    await user.click(within(nav()).getByRole('link', { name: '日历与工作日' }));

    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: '日历与工作日',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: '显示农历与节气' }),
    ).toBeInTheDocument();
  });
});

describe('外观与编辑器排版', () => {
  it('深色、强调色与紧凑密度即时写入 <html> 与 localStorage', async () => {
    const user = userEvent.setup();
    renderGroup('appearance');
    const root = document.documentElement;

    await user.click(screen.getByRole('button', { name: '深色' }));
    expect(root).toHaveAttribute('data-theme', 'dark');
    expect(root).toHaveAttribute('data-theme-preference', 'dark');

    await user.click(
      screen.getByRole('button', { name: '强调色：紫色' }),
    );
    expect(root).toHaveAttribute('data-accent', 'violet');

    await user.click(screen.getByRole('button', { name: '紧凑' }));
    expect(root).toHaveAttribute('data-density', 'compact');

    expect(
      JSON.parse(
        window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? 'null',
      ),
    ).toEqual({
      theme: 'dark',
      accent: 'violet',
      density: 'compact',
    });
  });

  it('字号 20、段距 24、缩进 2、宽度 800 即时生效并持久化', async () => {
    const user = userEvent.setup();
    const { source } = renderGroup('appearance');
    const root = document.documentElement;

    await user.selectOptions(screen.getByLabelText('正文字号'), '20');
    await user.selectOptions(screen.getByLabelText('段落间距'), '24');
    await user.selectOptions(screen.getByLabelText('首行缩进'), '2');
    await user.click(screen.getByRole('button', { name: '1024' }));
    await user.click(screen.getByRole('button', { name: '800' }));

    expect(root.style.getPropertyValue('--editor-font-size')).toBe('20px');
    expect(root.style.getPropertyValue('--editor-paragraph-gap')).toBe(
      '24px',
    );
    expect(root.style.getPropertyValue('--editor-indent')).toBe('2em');
    expect(root.style.getPropertyValue('--editor-width')).toBe('800px');
    expect(root.dataset.editorFontSize).toBe('20');

    const stored = readLocalSettings();
    expect(stored.editor.fontSize).toBe(20);
    expect(stored.editor.paragraphSpacing).toBe(24);
    expect(stored.editor.textIndent).toBe(2);
    expect(stored.editor.width).toBe(800);

    const rows = await source.settings.list({ scope: 'device' });
    expect(
      rows.find((row) => row.key === SETTING_KEYS.editorFontSize)?.value,
    ).toBe(20);
  });

  it('默认标题、块图标与正文色真实写入并应用到编辑器 CSS', async () => {
    const user = userEvent.setup();
    const { source } = renderGroup('appearance');
    const root = document.documentElement;

    await user.selectOptions(screen.getByLabelText('默认标题'), 'datetime');
    await user.click(screen.getByRole('switch', { name: '显示块图标' }));
    await user.click(
      screen.getByRole('button', { name: '正文默认色：蓝灰' }),
    );

    expect(root.dataset.editorTitleMode).toBe('datetime');
    expect(root.dataset.editorBlockIcons).toBe('off');
    expect(root.style.getPropertyValue('--editor-ink')).toBe('#2f5d8a');

    const rows = await source.settings.list({ scope: 'device' });
    const values = new Map(rows.map((row) => [row.key, row.value]));
    expect(values.get(SETTING_KEYS.editorTitleMode)).toBe('datetime');
    expect(values.get(SETTING_KEYS.editorShowBlockIcon)).toBe(false);
    expect(values.get(SETTING_KEYS.editorTextColor)).toBe('#2f5d8a');
  });

  it('卸载后重新挂载仍读取已保存的字号与宽度', async () => {
    const initial: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      editor: {
        ...DEFAULT_APP_SETTINGS.editor,
        fontSize: 20,
        width: 800,
      },
    };
    const { source, unmount } = renderGroup('appearance', { initial });
    await waitFor(() =>
      expect(screen.getByLabelText('正文字号')).toHaveValue('20'),
    );
    expect(document.documentElement.style.getPropertyValue('--editor-font-size')).toBe(
      '20px',
    );

    unmount();
    render(
      <MemoryRouter initialEntries={['/settings/appearance']}>
        <Routes>
          <Route path="/settings/:group" element={<Harness source={source} />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByLabelText('正文字号')).toHaveValue('20'),
    );
    expect(document.documentElement.style.getPropertyValue('--editor-width')).toBe(
      '800px',
    );
  });

  it('恢复编辑器默认会写回默认值', async () => {
    const user = userEvent.setup();
    renderGroup('appearance', {
      initial: {
        ...DEFAULT_APP_SETTINGS,
        editor: { ...DEFAULT_APP_SETTINGS.editor, fontSize: 22 },
      },
    });
    await waitFor(() =>
      expect(screen.getByLabelText('正文字号')).toHaveValue('22'),
    );

    await user.click(
      screen.getByRole('button', { name: '恢复编辑器默认' }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText('正文字号')).toHaveValue('15'),
    );
    expect(readLocalSettings().editor.fontSize).toBe(15);
  });
});

describe('任务与记录', () => {
  it('默认清单与新笔记目录写入设置源', async () => {
    const user = userEvent.setup();
    const { source, writes } = renderGroup('task');

    await screen.findByRole('option', { name: '生活' });
    await user.selectOptions(screen.getByLabelText('默认清单'), 'life');
    await user.selectOptions(screen.getByLabelText('新笔记默认目录'), 'f2');

    const rows = await source.settings.list({ scope: 'device' });
    const values = new Map(rows.map((row) => [row.key, row.value]));
    expect(values.get(SETTING_KEYS.taskDefaultList)).toBe('life');
    expect(values.get(SETTING_KEYS.noteDefaultFolder)).toBe('f2');
    expect(
      writes.some((item) => item.key === SETTING_KEYS.taskDefaultList),
    ).toBe(true);
  });

  it('默认提醒可设置并写入设置源', async () => {
    const user = userEvent.setup();
    const { source, writes } = renderGroup('task');

    const select = await screen.findByLabelText('默认提醒');
    expect(select).toBeEnabled();
    expect(select).toHaveValue('');
    await user.selectOptions(select, '15m');

    const rows = await source.settings.list({ scope: 'device' });
    const values = new Map(rows.map((row) => [row.key, row.value]));
    expect(values.get(SETTING_KEYS.taskDefaultReminder)).toBe('15m');
    expect(
      writes.some(
        (item) =>
          item.key === SETTING_KEYS.taskDefaultReminder &&
          item.value === '15m',
      ),
    ).toBe(true);
  });

  it('完成后行为可设置并写入设置源，默认保留', async () => {
    const user = userEvent.setup();
    const { source, writes } = renderGroup('task');

    const select = await screen.findByLabelText('完成后行为');
    expect(select).toBeEnabled();
    expect(select).toHaveValue('keep');
    await user.selectOptions(select, 'remove');

    const rows = await source.settings.list({ scope: 'device' });
    const values = new Map(rows.map((row) => [row.key, row.value]));
    expect(values.get(SETTING_KEYS.taskCompletionBehavior)).toBe('remove');
    expect(
      writes.some(
        (item) =>
          item.key === SETTING_KEYS.taskCompletionBehavior &&
          item.value === 'remove',
      ),
    ).toBe(true);
  });

  it('浏览器预览没有清单时禁用默认清单并说明原因', async () => {
    renderGroup('task', { mode: 'browser' });

    expect(
      await screen.findByText(
        '需在桌面壳内读取真实清单；浏览器预览不能设置默认清单。',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('默认清单')).toBeDisabled();
    expect(screen.getByLabelText('新笔记默认目录')).toBeEnabled();
  });
});

describe('隐私与安全', () => {
  it('失焦遮挡与剪贴板清空写入设置源、localStorage，并在重挂载后回显', async () => {
    const user = userEvent.setup();
    const first = renderGroup('privacy');

    const toggle = screen.getByRole('switch', { name: '失焦时遮挡内容' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(toggle).toBeChecked();

    const select = screen.getByLabelText('剪贴板自动清空');
    expect(select).toHaveValue('0');
    await user.selectOptions(select, '30');
    expect(select).toHaveValue('30');

    const rows = await first.source.settings.list({ scope: 'device' });
    const values = new Map(rows.map((row) => [row.key, row.value]));
    expect(values.get(SETTING_KEYS.privacyHideOnBlur)).toBe(true);
    expect(values.get(SETTING_KEYS.privacyClipboardClearSeconds)).toBe(30);
    expect(
      first.writes.some(
        (item) =>
          item.key === SETTING_KEYS.privacyClipboardClearSeconds &&
          item.value === 30,
      ),
    ).toBe(true);
    expect(readLocalSettings().privacy).toEqual({
      hideOnBlur: true,
      clipboardClearSeconds: 30,
      diagnosticsEnabled: false,
    });

    const saved = first.getSettings();
    first.unmount();
    renderGroup('privacy', { initial: saved });

    expect(
      screen.getByRole('switch', { name: '失焦时遮挡内容' }),
    ).toBeChecked();
    expect(screen.getByLabelText('剪贴板自动清空')).toHaveValue('30');
  });

  it('非法剪贴板秒数回退关闭，不产生假的保护状态', () => {
    const settings = normalizeAppSettings({
      ...DEFAULT_APP_SETTINGS,
      privacy: { hideOnBlur: 'yes', clipboardClearSeconds: 7 },
    });

    expect(settings.privacy).toEqual({
      hideOnBlur: false,
      clipboardClearSeconds: 0,
      diagnosticsEnabled: false,
    });
  });
});

describe('日历、通知与未实现分组', () => {
  it('关闭显示农历写入与日历页一致的键', async () => {
    const user = userEvent.setup();
    const { source, writes } = renderGroup('calendar');

    await user.click(
      screen.getByRole('switch', { name: '显示农历与节气' }),
    );

    expect(
      writes.some(
        (item) =>
          item.key === SETTING_KEYS.showLunar && item.value === false,
      ),
    ).toBe(true);
    const rows = await source.settings.list({ scope: 'device' });
    expect(
      rows.find((row) => row.key === SETTING_KEYS.showLunar)?.value,
    ).toBe(false);
    expect(screen.getByLabelText('节假日数据源')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: '自动同步节假日' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: '添加例外' }),
    ).toBeDisabled();
  });

  it('周起始与工作日规则真实写入设置，并共用同一份回显', async () => {
    const user = userEvent.setup();
    const { source } = renderGroup('calendar');

    await user.click(screen.getByRole('button', { name: '周日' }));
    await waitFor(async () => {
      const rows = await source.settings.list({ scope: 'device' });
      expect(
        rows.find((row) => row.key === SETTING_KEYS.calendarWeekStart)
          ?.value,
      ).toBe('sunday');
    });

    await user.selectOptions(
      screen.getByLabelText('工作日规则'),
      'single',
    );
    await waitFor(async () => {
      const rows = await source.settings.list({ scope: 'device' });
      expect(
        rows.find(
          (row) => row.key === SETTING_KEYS.calendarWorkdayRule,
        )?.value,
      ).toMatchObject({ rule: 'single' });
    });

    await user.selectOptions(
      screen.getByLabelText('工作日规则'),
      'custom',
    );
    const monday = await screen.findByRole('button', {
      name: '自定义工作日 周一',
    });
    expect(monday).toHaveAttribute('aria-pressed', 'true');
    await user.click(monday);
    expect(monday).toHaveAttribute('aria-pressed', 'false');
    await waitFor(async () => {
      const rows = await source.settings.list({ scope: 'device' });
      expect(
        rows.find(
          (row) => row.key === SETTING_KEYS.calendarWorkdayRule,
        )?.value,
      ).toMatchObject({
        rule: 'custom',
        customWorkdays: [2, 3, 4, 5],
      });
    });
  });

  it('通知页展示真实权限与可操作开关，不显示“已授权”', async () => {
    renderGroup('notify');

    expect(
      screen.getByRole('heading', { level: 2, name: '提醒与通知' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/浏览器权限：/)).toBeInTheDocument();
    expect(screen.queryByText('已授权')).not.toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /^应用内提醒/ }),
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /^浏览器通知/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /^系统通知/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: '刷新权限状态' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '发送测试通知' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/只在点击开启时请求/).length).toBeGreaterThan(0);
  });

  it('OCR 默认关闭，显示真实引擎状态、数据去向与测试入口', async () => {
    window.localStorage.removeItem(OCR_SETTINGS_KEY);
    const { unmount } = renderGroup('ocr');

    const toggle = screen.getByRole('checkbox', { name: /启用图片 OCR/ });
    expect(toggle).not.toBeChecked();
    expect(
      await screen.findByText(/当前为浏览器预览，需桌面壳/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/当前系统\/WebView 未提供 TextDetector/),
    ).not.toBeInTheDocument();
    expect(screen.getByText('引擎不可用')).toBeInTheDocument();
    expect(screen.getByText('数据去向')).toBeInTheDocument();
    expect(
      screen.getByText(/图片 OCR 当前关闭，不会读取或上传任何图片/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('选择 OCR 测试图片')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: '测试引擎可用性' }),
    ).toBeInTheDocument();
    unmount();
    window.localStorage.removeItem(OCR_SETTINGS_KEY);

    renderGroup('privacy');
    expect(
      screen.getByRole('switch', { name: '失焦时遮挡内容' }),
    ).not.toBeChecked();
    expect(screen.getByLabelText('剪贴板自动清空')).toHaveValue('0');
    expect(screen.getByText('本机 SQLite')).toBeInTheDocument();
    expect(screen.getByText('仅桌面壳')).toBeInTheDocument();
    expect(
      screen.getByText('默认关闭 · 匿名本机摘要 · 不上传 · 可清除'),
    ).toBeInTheDocument();
  });

  it('Web 预览的同步页只显示后台直连，不出现 WebDAV 入口', () => {
    renderGroup('sync');

    expect(screen.getByText('Web 唯一')).toBeInTheDocument();
    expect(screen.getByLabelText('后台地址')).toBeInTheDocument();
    expect(screen.getByLabelText('配对码')).toBeInTheDocument();
    expect(screen.queryByLabelText('WebDAV 地址')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '同步模式：WebDAV' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '同步模式：仅本机' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('登录')).not.toBeInTheDocument();
    expect(screen.getByText(/没有账号/)).toBeInTheDocument();
  });

});

describe('数据与备份', () => {
  it('导出包含当前偏好与外观，导入后状态一致', async () => {
    const user = userEvent.setup();
    const initial: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      editor: { ...DEFAULT_APP_SETTINGS.editor, fontSize: 20 },
      task: {
        defaultListId: 'life',
        defaultReminder: '',
        completionBehavior: 'keep',
        noteFolderId: 'f3',
      },
    };
    const { source } = renderGroup('data', { initial });

    const createObjectURL = vi.fn((_blob: Blob) => 'blob:preferences');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    await user.click(screen.getByRole('button', { name: '导出 JSON' }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as unknown as Blob;
    const text = await blob.text();
    const backup = JSON.parse(text);
    expect(backup.settings.editor.fontSize).toBe(20);
    expect(backup.settings.task.defaultListId).toBe('life');
    expect(backup.appearance).toBeTruthy();

    // 导入另一份偏好：字号 22、默认清单工作、农历关闭。
    const imported = {
      ...backup,
      settings: {
        ...backup.settings,
        editor: { ...backup.settings.editor, fontSize: 22 },
        task: { defaultListId: 'work', noteFolderId: 'f2' },
        calendar: { showLunar: false },
      },
    };
    const file = new File(
      [JSON.stringify(imported)],
      'preferences.json',
      { type: 'application/json' },
    );
    await user.upload(
      screen.getByLabelText('选择偏好备份文件'),
      file,
    );

    await waitFor(async () => {
      const rows = await source.settings.list({ scope: 'device' });
      const values = new Map(rows.map((row) => [row.key, row.value]));
      expect(values.get(SETTING_KEYS.editorFontSize)).toBe(22);
      expect(values.get(SETTING_KEYS.taskDefaultList)).toBe('work');
      expect(values.get(SETTING_KEYS.showLunar)).toBe(false);
    });
    expect(readLocalSettings().editor.fontSize).toBe(22);
  });

  it('导出→导入往返保留默认提醒 15m（备份 F6 回归）', async () => {
    const user = userEvent.setup();
    const initial: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      task: {
        ...DEFAULT_APP_SETTINGS.task,
        defaultReminder: '15m',
        completionBehavior: 'remove',
      },
    };
    const exportView = renderGroup('data', { initial });

    const createObjectURL = vi.fn((_blob: Blob) => 'blob:preferences');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      () => undefined,
    );

    await user.click(screen.getByRole('button', { name: '导出 JSON' }));
    const blob = createObjectURL.mock.calls[0][0] as unknown as Blob;
    const text = await blob.text();
    expect(JSON.parse(text).settings.task.defaultReminder).toBe('15m');
    exportView.unmount();

    // 换成一个默认提醒关闭的干净设置，再导入刚导出的备份。
    const { source } = renderGroup('data');
    const file = new File([text], 'preferences.json', {
      type: 'application/json',
    });
    await user.upload(screen.getByLabelText('选择偏好备份文件'), file);

    await waitFor(async () => {
      const rows = await source.settings.list({ scope: 'device' });
      const values = new Map(rows.map((row) => [row.key, row.value]));
      expect(values.get(SETTING_KEYS.taskDefaultReminder)).toBe('15m');
      expect(values.get(SETTING_KEYS.taskCompletionBehavior)).toBe('remove');
    });
  });

  it('导入坏文件显示错误且不改变当前偏好', async () => {
    const user = userEvent.setup();
    const { source } = renderGroup('data');
    const before = await source.settings.list({ scope: 'device' });
    const file = new File(['{broken'], 'broken.json', {
      type: 'application/json',
    });

    await user.upload(
      screen.getByLabelText('选择偏好备份文件'),
      file,
    );

    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent('文件不是有效的 JSON');
    const after = await source.settings.list({ scope: 'device' });
    expect(after).toEqual(before);
  });

  it('重置本机偏好需要二次确认，并只重置偏好', async () => {
    const user = userEvent.setup();
    renderGroup('data', {
      initial: {
        ...DEFAULT_APP_SETTINGS,
        editor: { ...DEFAULT_APP_SETTINGS.editor, fontSize: 22 },
      },
    });

    await user.click(
      screen.getByRole('button', { name: '重置本机偏好' }),
    );
    expect(
      screen.getByRole('group', { name: '确认重置本机偏好' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认重置' }));

    await waitFor(() => {
      expect(readLocalSettings()).toEqual(DEFAULT_APP_SETTINGS);
    });
    expect(
      JSON.parse(
        window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? 'null',
      ),
    ).toEqual(DEFAULT_APPEARANCE);
  });

  it('备份与恢复明确标注需桌面壳，不放可点击按钮', async () => {
    renderGroup('data');

    expect(screen.getByText('备份与恢复')).toBeInTheDocument();
    expect(screen.getByText('单向导出')).toBeInTheDocument();
    expect(screen.getByText('导出完整备份（ZIP）')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '导出完整备份（ZIP）' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'JSON' })).toBeNull();
    expect(
      screen.getByText(/偏好备份始终可用；完整业务备份与业务数据重置需要桌面壳/),
    ).toBeInTheDocument();
    expect(await screen.findByText('v4 · WAL')).toBeInTheDocument();
  });

  it('浏览器分支明确业务数据重置需要桌面壳，不再显示“未实现”', () => {
    renderGroup('data');

    expect(screen.getByText('重置全部数据')).toBeInTheDocument();
    expect(
      screen.getByText(/业务数据重置只在桌面壳内可用/),
    ).toBeInTheDocument();
    expect(screen.queryByText('未实现')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '重置全部数据' }),
    ).not.toBeInTheDocument();
  });
});

describe('保存失败回滚', () => {
  it('设置源写入失败时恢复上一个值并显示错误', async () => {
    const user = userEvent.setup();
    renderGroup('appearance', { failSet: true });

    await user.selectOptions(screen.getByLabelText('正文字号'), '20');

    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent('本机设置写入失败');
    await waitFor(() => {
      expect(screen.getByLabelText('正文字号')).toHaveValue('15');
    });
    expect(
      document.documentElement.style.getPropertyValue('--editor-font-size'),
    ).toBe('15px');
    expect(readLocalSettings().editor.fontSize).toBe(15);
  });
});
