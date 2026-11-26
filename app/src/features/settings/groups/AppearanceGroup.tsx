import type { CSSProperties } from 'react';

import type {
  AccentName,
  DensityName,
  ThemePreference,
} from '../../../app/shell/appearance';
import {
  DEFAULT_EDITOR_SETTINGS,
  EDITOR_FONT_SIZES,
  EDITOR_PARAGRAPH_SPACINGS,
  EDITOR_TEXT_COLORS,
  EDITOR_TEXT_INDENTS,
  type EditorTitleMode,
  type EditorWidth,
} from '../../../data/repositories/settings';
import type { SettingsWorkspaceValue } from '../useSettingsWorkspace';
import {
  Segmented,
  SelectField,
  SettingsCard,
  SettingsRow,
  SettingsSwitch,
} from './Controls';

const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
}> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'auto', label: '跟随系统' },
];

const ACCENT_OPTIONS: ReadonlyArray<{
  value: AccentName;
  label: string;
  swatch: string;
}> = [
  { value: 'blue', label: '蓝色', swatch: 'var(--palette-blue)' },
  { value: 'violet', label: '紫色', swatch: 'var(--palette-violet)' },
  { value: 'coral', label: '珊瑚', swatch: 'var(--palette-coral)' },
  { value: 'teal', label: '青色', swatch: 'var(--palette-teal)' },
  { value: 'amber', label: '琥珀', swatch: 'var(--palette-amber)' },
];

const DENSITY_OPTIONS: ReadonlyArray<{
  value: DensityName;
  label: string;
}> = [
  { value: 'comfortable', label: '舒适' },
  { value: 'compact', label: '紧凑' },
];

const TITLE_OPTIONS: ReadonlyArray<{
  value: EditorTitleMode;
  label: string;
}> = [
  { value: 'empty', label: '空白（未命名笔记）' },
  { value: 'date', label: '日期（YYYY-MM-DD）' },
  { value: 'datetime', label: '日期 + 时间' },
];

const WIDTH_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '800', label: '800' },
  { value: '1024', label: '1024' },
  { value: '100%', label: '100%' },
];

const TEXT_COLOR_LABELS: Record<string, string> = {
  auto: '跟随主题',
  '#3f4b58': '深灰',
  '#59636f': '柔和',
  '#2f5d8a': '蓝灰',
  '#6b4f8a': '紫灰',
};

function widthValue(width: EditorWidth): string {
  return width === '100%' ? '100%' : String(width);
}

function parseWidth(value: string): EditorWidth {
  if (value === '100%') {
    return '100%';
  }
  return value === '1024' ? 1024 : 800;
}

export function AppearanceGroup({
  workspace,
}: {
  workspace: SettingsWorkspaceValue;
}) {
  const { appearance, settings, updateAppearance, updateEditor } = workspace;
  const editor = settings.editor;
  const previewStyle = {
    fontSize: `${editor.fontSize}px`,
    color:
      editor.textColor === 'auto' ? 'var(--ink)' : editor.textColor,
  } as CSSProperties;
  const paragraphStyle = {
    marginBottom: `${editor.paragraphSpacing}px`,
    textIndent: `${editor.textIndent}em`,
  } as CSSProperties;

  const change = (patch: Parameters<typeof updateEditor>[0]) => {
    void updateEditor(patch).catch(() => undefined);
  };

  return (
    <SettingsCard
      title="外观与阅读"
      description="界面主题与编辑器排版分开设置；修改后立即预览，并只影响本机显示。"
    >
      <SettingsRow
        label="主题"
        description="跟随系统会随 macOS / Windows 深浅色切换"
      >
        <Segmented
          label="主题"
          value={appearance.theme}
          options={THEME_OPTIONS}
          onChange={(value) =>
            updateAppearance({ theme: value as ThemePreference })
          }
        />
      </SettingsRow>

      <SettingsRow
        label="强调色"
        description="只影响选中、进度与主按钮，不改正文与语义色"
      >
        <div className="settings-swatches" role="group" aria-label="强调色">
          {ACCENT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="settings-swatch"
              style={{ '--swatch': option.swatch } as CSSProperties}
              aria-label={`强调色：${option.label}`}
              title={option.label}
              aria-pressed={appearance.accent === option.value}
              onClick={() => updateAppearance({ accent: option.value })}
            />
          ))}
        </div>
      </SettingsRow>

      <SettingsRow
        label="信息密度"
        description="影响任务行、笔记列表与日历格的高度"
      >
        <Segmented
          label="信息密度"
          value={appearance.density}
          options={DENSITY_OPTIONS}
          onChange={(value) =>
            updateAppearance({ density: value as DensityName })
          }
        />
      </SettingsRow>

      <div className="settings-subhead">
        <b>编辑器排版</b>
        <span>字号、段距、缩进、宽度与正文色会即时作用到知识页编辑器</span>
      </div>

      <SettingsRow label="正文字号" description="14–24 px">
        <SelectField
          label="正文字号"
          value={String(editor.fontSize)}
          onChange={(value) => change({ fontSize: Number(value) })}
        >
          {EDITOR_FONT_SIZES.map((size) => (
            <option key={size} value={size}>
              {size} px
            </option>
          ))}
        </SelectField>
      </SettingsRow>

      <SettingsRow label="段落间距" description="8–31 px">
        <SelectField
          label="段落间距"
          value={String(editor.paragraphSpacing)}
          onChange={(value) => change({ paragraphSpacing: Number(value) })}
        >
          {EDITOR_PARAGRAPH_SPACINGS.map((size) => (
            <option key={size} value={size}>
              {size} px
            </option>
          ))}
        </SelectField>
      </SettingsRow>

      <SettingsRow label="首行缩进" description="0–14 字符">
        <SelectField
          label="首行缩进"
          value={String(editor.textIndent)}
          onChange={(value) => change({ textIndent: Number(value) })}
        >
          {EDITOR_TEXT_INDENTS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </SelectField>
      </SettingsRow>

      <SettingsRow
        label="编辑区宽度"
        description="窄屏会自动降到 100%"
      >
        <Segmented
          label="编辑区宽度"
          value={widthValue(editor.width)}
          options={WIDTH_OPTIONS}
          onChange={(value) => change({ width: parseWidth(value) })}
        />
      </SettingsRow>

      <SettingsRow
        label="默认标题"
        description="新建通用笔记时的标题形态"
      >
        <SelectField
          label="默认标题"
          value={editor.titleMode}
          onChange={(value) =>
            change({ titleMode: value as EditorTitleMode })
          }
        >
          {TITLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
      </SettingsRow>

      <SettingsRow
        label="显示块图标"
        description="悬停正文块时显示 ＋ / ⠿"
      >
        <SettingsSwitch
          label="显示块图标"
          checked={editor.showBlockIcon}
          onChange={(next) => change({ showBlockIcon: next })}
        />
      </SettingsRow>

      <SettingsRow
        label="正文默认色"
        description="划词仍可单独设置颜色与底色"
      >
        <div className="settings-swatches" role="group" aria-label="正文默认色">
          <button
            type="button"
            className="settings-swatch settings-swatch--auto"
            aria-label="正文默认色：跟随主题"
            title="跟随主题"
            aria-pressed={editor.textColor === 'auto'}
            onClick={() => change({ textColor: 'auto' })}
          />
          {EDITOR_TEXT_COLORS.filter((color) => color !== 'auto').map(
            (color) => (
              <button
                key={color}
                type="button"
                className="settings-swatch"
                style={{ '--swatch': color } as CSSProperties}
                aria-label={`正文默认色：${TEXT_COLOR_LABELS[color] ?? color}`}
                title={TEXT_COLOR_LABELS[color] ?? color}
                aria-pressed={editor.textColor === color}
                onClick={() =>
                  change({
                    textColor:
                      color as (typeof EDITOR_TEXT_COLORS)[number],
                  })
                }
              />
            ),
          )}
        </div>
      </SettingsRow>

      <div className="settings-preview" aria-label="编辑器排版实时预览">
        <span className="settings-preview-label">实时预览</span>
        <div
          className="settings-preview-body"
          style={{
            ...previewStyle,
            maxWidth:
              editor.width === '100%' ? '100%' : `${editor.width}px`,
          }}
        >
          <h3>把行动写进知识里</h3>
          <p style={paragraphStyle}>
            任务和笔记不是两套系统：一条待办可以从笔记里长出来，完成后回到原文。
          </p>
          <p
            className="settings-preview-muted"
            style={{ ...paragraphStyle, marginBottom: 0 }}
          >
            右侧预览会随字号、段距、缩进、宽度与正文色变化。
          </p>
        </div>
      </div>

      <div className="settings-actions">
        <button
          type="button"
          className="settings-button"
          onClick={() => change(DEFAULT_EDITOR_SETTINGS)}
        >
          恢复编辑器默认
        </button>
        <span className="settings-hint">
          不影响任务、日历与笔记内容
        </span>
      </div>
    </SettingsCard>
  );
}
