/**
 * 本机偏好备份（P1-05）。
 *
 * 只包含外观、编辑器排版、默认清单/目录/提醒/完成后行为、导出目录、
 * 农历显示、周起始日与工作日规则；不含任务、笔记、画板、附件等业务数据。
 * 导入前校验格式，不静默吞掉坏文件，也不覆盖未在备份里的业务数据。
 *
 * v2 起包含 `calendar.weekStart` / `calendar.workdayRule`；v3 起包含
 * `calendar.holidaySource` / `calendar.dateExceptions`；v4 起包含
 * `privacy.hideOnBlur` / `privacy.clipboardClearSeconds`；v5 起包含
 * `privacy.diagnosticsEnabled`。v1/v2/v3/v4 备份仍可导入，
 * 缺失字段按默认值补齐（周一 / 双休 / 内置源 / 无个人例外 / 隐私保护关闭）。
 */

import type { Appearance } from '../../app/shell/appearance';
import { browserDownloader } from '../../features/export/download';
import {
  DEFAULT_APP_SETTINGS,
  EDITOR_FONT_SIZES,
  EDITOR_PARAGRAPH_SPACINGS,
  EDITOR_TEXT_COLORS,
  EDITOR_TEXT_INDENTS,
  EDITOR_TITLE_MODES,
  EDITOR_WIDTHS,
  normalizeAppSettings,
  normalizeTaskCompletionBehavior,
  normalizeTaskDefaultReminder,
  type AppSettings,
} from '../../data/repositories/settings';
import {
  normalizeWeekStart,
  normalizeWorkdayRule,
} from '../calendar/workweek';
import { normalizeDateExceptions } from '../../data/calendar/exceptions';
import { normalizeHolidayPreferences } from '../calendar/holiday/types';

export const SETTINGS_BACKUP_APP = 'zhixing';
export const SETTINGS_BACKUP_KIND = 'settings';
export const SETTINGS_BACKUP_VERSION = 5;
export const SETTINGS_BACKUP_MIN_VERSION = 1;

export type SettingsBackup = {
  app: typeof SETTINGS_BACKUP_APP;
  kind: typeof SETTINGS_BACKUP_KIND;
  version: typeof SETTINGS_BACKUP_VERSION;
  exportedAt: string;
  appearance: Appearance;
  settings: AppSettings;
};

export class SettingsBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsBackupError';
  }
}

const THEMES: readonly Appearance['theme'][] = ['light', 'dark', 'auto'];
const ACCENTS: readonly Appearance['accent'][] = [
  'blue',
  'violet',
  'coral',
  'teal',
  'amber',
];
const DENSITIES: readonly Appearance['density'][] = [
  'comfortable',
  'compact',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SettingsBackupError(`${label}必须是布尔值`);
  }
  return value;
}

function requireEnum<T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new SettingsBackupError(`${label}的值无效`);
  }
  return value as T;
}

function requireNumber(
  value: unknown,
  allowed: readonly number[],
  label: string,
): number {
  if (typeof value !== 'number' || !allowed.includes(value)) {
    throw new SettingsBackupError(`${label}的值无效`);
  }
  return value;
}

function parseAppearance(raw: unknown): Appearance {
  if (!isRecord(raw)) {
    throw new SettingsBackupError('备份缺少外观设置');
  }
  return {
    theme: requireEnum(raw.theme, THEMES, '主题'),
    accent: requireEnum(raw.accent, ACCENTS, '强调色'),
    density: requireEnum(raw.density, DENSITIES, '密度'),
  };
}

function parseSettings(raw: unknown): AppSettings {
  if (!isRecord(raw)) {
    throw new SettingsBackupError('备份缺少偏好设置');
  }
  const editor = raw.editor;
  const task = raw.task;
  const calendar = raw.calendar;
  const exportLocation = raw.export;
  if (!isRecord(editor) || !isRecord(task) || !isRecord(calendar)) {
    throw new SettingsBackupError('偏好设置结构不完整');
  }

  if (
    task.defaultListId !== null &&
    typeof task.defaultListId !== 'string'
  ) {
    throw new SettingsBackupError('默认清单 ID 无效');
  }
  if (
    task.noteFolderId !== null &&
    typeof task.noteFolderId !== 'string'
  ) {
    throw new SettingsBackupError('默认目录 ID 无效');
  }

  const strict = {
    editor: {
      fontSize: requireNumber(
        editor.fontSize,
        EDITOR_FONT_SIZES,
        '正文字号',
      ),
      paragraphSpacing: requireNumber(
        editor.paragraphSpacing,
        EDITOR_PARAGRAPH_SPACINGS,
        '段落间距',
      ),
      textIndent: requireNumber(
        editor.textIndent,
        EDITOR_TEXT_INDENTS,
        '首行缩进',
      ),
      width: requireEnum(editor.width, EDITOR_WIDTHS, '编辑区宽度'),
      titleMode: requireEnum(
        editor.titleMode,
        EDITOR_TITLE_MODES,
        '默认标题',
      ),
      showBlockIcon: requireBoolean(editor.showBlockIcon, '块图标'),
      textColor: requireEnum(
        editor.textColor,
        EDITOR_TEXT_COLORS,
        '正文默认色',
      ),
    },
    task: {
      defaultListId: task.defaultListId as string | null,
      // v1–v5 备份都可能缺少/写坏该键；缺失或非法值回退“关闭”，
      // 与设置仓库的白名单/旧文案迁移保持一致。
      defaultReminder: normalizeTaskDefaultReminder(task.defaultReminder),
      completionBehavior: normalizeTaskCompletionBehavior(
        task.completionBehavior,
      ),
      noteFolderId: task.noteFolderId as string | null,
    },
    calendar: {
      showLunar: requireBoolean(calendar.showLunar, '显示农历'),
      // v1 备份没有这两个键；非法值由 normalizeWorkdayRule 回退双休。
      weekStart: normalizeWeekStart(
        calendar.weekStart ?? calendar.weekStartsOn,
      ),
      workdayRule: normalizeWorkdayRule(
        calendar.workdayRule ?? calendar.workdays,
      ),
      // v1/v2 备份没有这两个键；缺失时补内置源与空例外。
      holidaySource: normalizeHolidayPreferences(
        calendar.holidaySource ?? calendar.holidaySourceKind,
      ),
      dateExceptions: normalizeDateExceptions(
        calendar.dateExceptions ?? calendar.exceptions,
      ),
    },
    // v1–v3 备份没有 privacy；缺失时由 normalizeAppSettings 回退为关闭。
    privacy: isRecord(raw.privacy)
      ? {
          hideOnBlur:
            typeof raw.privacy.hideOnBlur === 'boolean'
              ? raw.privacy.hideOnBlur
              : false,
          clipboardClearSeconds: raw.privacy
            .clipboardClearSeconds as number,
          diagnosticsEnabled:
            typeof raw.privacy.diagnosticsEnabled === 'boolean'
              ? raw.privacy.diagnosticsEnabled
              : false,
        }
      : {
          hideOnBlur: false,
          clipboardClearSeconds: 0,
          diagnosticsEnabled: false,
        },
    export: {
      // 旧备份没有 export；新备份保留用户选的目录，换机后若失效会在保存时
      // 返回可恢复提示，不会静默落到其他目录。
      directory:
        exportLocation === undefined
          ? null
          : !isRecord(exportLocation)
            ? null
            : exportLocation.directory === null ||
                exportLocation.directory === undefined ||
                exportLocation.directory === ''
              ? null
              : typeof exportLocation.directory === 'string'
                ? exportLocation.directory
                : null,
    },
  };

  // 目录必须是当前知识页支持的目录；未知目录回退默认并保证导入可用。
  return normalizeAppSettings(strict);
}

export function createSettingsBackup(
  settings: AppSettings,
  appearance: Appearance,
  now: Date = new Date(),
): SettingsBackup {
  return {
    app: SETTINGS_BACKUP_APP,
    kind: SETTINGS_BACKUP_KIND,
    version: SETTINGS_BACKUP_VERSION,
    exportedAt: now.toISOString(),
    appearance,
    settings: normalizeAppSettings(settings),
  };
}

export function serializeSettingsBackup(
  settings: AppSettings,
  appearance: Appearance,
  now: Date = new Date(),
): string {
  return JSON.stringify(
    createSettingsBackup(settings, appearance, now),
    null,
    2,
  );
}

export function parseSettingsBackup(text: string): SettingsBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SettingsBackupError('文件不是有效的 JSON');
  }

  if (!isRecord(raw)) {
    throw new SettingsBackupError('备份文件结构无效');
  }
  if (raw.app !== SETTINGS_BACKUP_APP || raw.kind !== SETTINGS_BACKUP_KIND) {
    throw new SettingsBackupError('这不是知行偏好备份文件');
  }
  if (
    typeof raw.version !== 'number' ||
    !Number.isInteger(raw.version) ||
    raw.version < SETTINGS_BACKUP_MIN_VERSION ||
    raw.version > SETTINGS_BACKUP_VERSION
  ) {
    throw new SettingsBackupError(
      `备份版本 ${String(raw.version)} 不受支持（当前为 ${SETTINGS_BACKUP_VERSION}）`,
    );
  }

  return {
    app: SETTINGS_BACKUP_APP,
    kind: SETTINGS_BACKUP_KIND,
    version: SETTINGS_BACKUP_VERSION,
    exportedAt:
      typeof raw.exportedAt === 'string' ? raw.exportedAt : new Date(0).toISOString(),
    appearance: parseAppearance(raw.appearance),
    settings: parseSettings(raw.settings),
  };
}

export function defaultBackupSettings(): AppSettings {
  return normalizeAppSettings(DEFAULT_APP_SETTINGS);
}

/** 导出本机偏好：桌面写 app data/exports；浏览器保留 Blob 下载作为降级。 */
export async function downloadTextFile(fileName: string, text: string): Promise<boolean> {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  return browserDownloader({ fileName, blob });
}
