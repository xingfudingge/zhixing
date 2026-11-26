/**
 * 设置仓储（P1-05）。
 *
 * 设置分两类：
 * - 设备外观（主题/强调色/密度）继续由 `app/shell/appearance.ts` 写 localStorage，
 *   因为它必须在 SQLite 就绪前决定首屏颜色；
 * - 其余偏好（编辑器排版、默认清单/目录/提醒、完成后行为、农历）以 SQLite `settings` 表为准，
 *   同时镜像到 localStorage，供首屏立即应用和浏览器预览使用。
 *
 * 这里只存键值，不存账号、令牌或任何授权信息。渲染层不拼 SQL。
 */

import {
  DEFAULT_WORKDAY_RULE,
  normalizeWeekStart,
  normalizeWorkdayRule,
  type WeekStart,
  type WorkdayRule,
} from '../../features/calendar/workweek';
import {
  DEFAULT_HOLIDAY_PREFERENCES,
  normalizeHolidayPreferences,
  type HolidayPreferences,
} from '../../features/calendar/holiday/types';
import {
  normalizeDateExceptions,
  type DateException,
} from '../calendar/exceptions';
import type { DbClient } from '../db/client';
import type {
  JsonValue,
  NewSetting,
  Setting,
  SettingQuery,
} from '../db/types';
import {
  EXPORT_DIRECTORY_SETTING_KEY,
  SETTINGS_STORAGE_KEY,
} from '../settingsStorage';
import { NOTE_FOLDERS } from './notes';

export { SETTINGS_STORAGE_KEY } from '../settingsStorage';

export const SETTINGS_SCOPE = 'device' as const;

/** 与 `features/calendar/CalendarStore.tsx` 保持同一个键，日历页据此显示/隐藏农历。 */
export const SHOW_LUNAR_KEY = 'calendar.showLunar';

export const SETTING_KEYS = {
  editorFontSize: 'editor.fontSize',
  editorParagraphSpacing: 'editor.paragraphSpacing',
  editorTextIndent: 'editor.textIndent',
  editorWidth: 'editor.width',
  editorTitleMode: 'editor.titleMode',
  editorShowBlockIcon: 'editor.showBlockIcon',
  editorTextColor: 'editor.textColor',
  taskDefaultList: 'tasks.defaultListId',
  taskDefaultReminder: 'tasks.defaultReminder',
  taskCompletionBehavior: 'tasks.completionBehavior',
  noteDefaultFolder: 'notes.defaultFolderId',
  privacyHideOnBlur: 'privacy.hideOnBlur',
  privacyClipboardClearSeconds: 'privacy.clipboardClearSeconds',
  privacyDiagnosticsEnabled: 'privacy.diagnosticsEnabled',
  showLunar: SHOW_LUNAR_KEY,
  calendarWeekStart: 'calendar.weekStart',
  calendarWorkdayRule: 'calendar.workdayRule',
  calendarHolidaySource: 'calendar.holidaySource',
  calendarDateExceptions: 'calendar.dateExceptions',
  exportDirectory: EXPORT_DIRECTORY_SETTING_KEY,
} as const;

/**
 * 旧键兼容：
 * - 审计稿曾建议 `calendar.weekStartsOn`（1/0）；
 * - 更早的原型把工作日规则存成字符串/数组。
 * 读取时兼容，写入仍走新键，避免双写产生两份事实。
 */
export const LEGACY_SETTING_KEYS = {
  calendarWeekStartsOn: 'calendar.weekStartsOn',
  calendarWorkdays: 'calendar.workdays',
} as const;

export const EDITOR_FONT_SIZES = Array.from(
  { length: 11 },
  (_, index) => index + 14,
) as readonly number[];

export const EDITOR_PARAGRAPH_SPACINGS = Array.from(
  { length: 24 },
  (_, index) => index + 8,
) as readonly number[];

export const EDITOR_TEXT_INDENTS = Array.from(
  { length: 15 },
  (_, index) => index,
) as readonly number[];

export const EDITOR_WIDTHS = [800, 1024, '100%'] as const;
export type EditorWidth = (typeof EDITOR_WIDTHS)[number];

export const EDITOR_TITLE_MODES = ['empty', 'date', 'datetime'] as const;
export type EditorTitleMode = (typeof EDITOR_TITLE_MODES)[number];

export const EDITOR_TEXT_COLORS = [
  'auto',
  '#3f4b58',
  '#59636f',
  '#2f5d8a',
  '#6b4f8a',
] as const;
export type EditorTextColor = (typeof EDITOR_TEXT_COLORS)[number];

export type EditorSettings = {
  fontSize: number;
  paragraphSpacing: number;
  textIndent: number;
  width: EditorWidth;
  titleMode: EditorTitleMode;
  showBlockIcon: boolean;
  textColor: EditorTextColor;
};

/**
 * 新任务默认提醒。只提供“关闭 / 准时 / 提前 5/15/30 分钟 / 提前 1 小时”，
 * 与上游 super-productivity 的全局默认一致：更长提前量（1 天、1 周）仍可在
 * 单条任务里选择，但不作为全局默认，避免新任务在创建当天就已经“提前触发”。
 */
export const TASK_DEFAULT_REMINDERS = [
  '',
  'at',
  '5m',
  '15m',
  '30m',
  '1h',
] as const;

export type TaskDefaultReminder = (typeof TASK_DEFAULT_REMINDERS)[number];

const LEGACY_REMINDER_VALUES: Record<string, TaskDefaultReminder> = {
  '': '',
  none: '',
  '不提醒': '',
  '关闭': '',
  '关闭提醒': '',
  at: 'at',
  '准时': 'at',
  '到期时': 'at',
  '到点': 'at',
  'on time': 'at',
  '5m': '5m',
  '提前5分钟': '5m',
  '提前 5 分钟': '5m',
  '15m': '15m',
  '提前15分钟': '15m',
  '提前 15 分钟': '15m',
  '30m': '30m',
  '提前30分钟': '30m',
  '提前 30 分钟': '30m',
  '1h': '1h',
  '提前1小时': '1h',
  '提前 1 小时': '1h',
  '60m': '1h',
};

/** 非法值回退“关闭”；中文旧文案映射到短码，保证设置页不白屏。 */
export function normalizeTaskDefaultReminder(
  value: unknown,
): TaskDefaultReminder {
  if (typeof value !== 'string') {
    return '';
  }
  const text = value.trim().toLowerCase();
  const direct = LEGACY_REMINDER_VALUES[text];
  if (direct !== undefined) {
    return direct;
  }
  const minutes = /^(?:提前\s*)?(\d+)\s*(?:分钟|分|m|min)$/.exec(text);
  if (minutes) {
    const parsed = Number(minutes[1]);
    if (parsed === 0) return 'at';
    if (parsed === 5) return '5m';
    if (parsed === 15) return '15m';
    if (parsed === 30) return '30m';
    if (parsed === 60) return '1h';
  }
  return '';
}

/**
 * 完成后行为。只决定已完成任务是否继续出现在今天/清单/四象限/看板等
 * 活动视图，不改变任务状态、完成时间，也不影响任务中心的「已完成」筛选与搜索。
 * 审计稿曾使用 `hide` 作为候选值，这里以产品文案 `remove` 为规范值并兼容旧值。
 */
export const TASK_COMPLETION_BEHAVIORS = ['keep', 'remove'] as const;

export type TaskCompletionBehavior =
  (typeof TASK_COMPLETION_BEHAVIORS)[number];

/** 非法/缺省值回退 `keep`（保持既有行为）；旧 `hide` 迁移为 `remove`。 */
export function normalizeTaskCompletionBehavior(
  value: unknown,
): TaskCompletionBehavior {
  if (typeof value !== 'string') {
    return 'keep';
  }
  const text = value.trim().toLowerCase();
  if (text === 'remove' || text === 'hide') {
    return 'remove';
  }
  if (
    text === 'keep' ||
    text === '保留' ||
    text === '留在当前视图' ||
    text === '保留在当前视图'
  ) {
    return 'keep';
  }
  if (text === '移出' || text === '立即移出' || text === '完成后移出') {
    return 'remove';
  }
  return 'keep';
}

/** 非法值回退 0（关闭）；只接受 0/15/30/60，数字字符串也接受。 */
export function normalizePrivacyClipboardClearSeconds(
  value: unknown,
): PrivacyClipboardClearSeconds {
  if (typeof value === 'number') {
    return PRIVACY_CLIPBOARD_CLEAR_SECONDS.includes(
      value as PrivacyClipboardClearSeconds,
    )
      ? (value as PrivacyClipboardClearSeconds)
      : 0;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (
      Number.isFinite(parsed) &&
      PRIVACY_CLIPBOARD_CLEAR_SECONDS.includes(
        parsed as PrivacyClipboardClearSeconds,
      )
    ) {
      return parsed as PrivacyClipboardClearSeconds;
    }
  }
  return 0;
}

export type TaskDefaults = {
  /** null 表示跟随清单顺序（第一个非收件箱清单）。 */
  defaultListId: string | null;
  /** 新任务未单独设置提醒时使用；空字符串表示默认关闭。 */
  defaultReminder: TaskDefaultReminder;
  /** 勾选完成后是否把任务移出当前活动视图。 */
  completionBehavior: TaskCompletionBehavior;
  /** 新建笔记的默认目录；必须来自 NOTE_FOLDERS。 */
  noteFolderId: string | null;
};

/**
 * 剪贴板自动清空的延迟选项。0 表示关闭；只允许 15/30/60 秒，
 * 避免用户填一个无法验证的任意值。
 */
export const PRIVACY_CLIPBOARD_CLEAR_SECONDS = [0, 15, 30, 60] as const;

export type PrivacyClipboardClearSeconds =
  (typeof PRIVACY_CLIPBOARD_CLEAR_SECONDS)[number];

export type PrivacyPreferences = {
  /** 应用失焦/系统锁屏/进入后台时覆盖窗口内容；恢复后需用户手动显示。 */
  hideOnBlur: boolean;
  /** 复制敏感内容后延迟清空系统剪贴板；0 表示关闭。 */
  clipboardClearSeconds: PrivacyClipboardClearSeconds;
  /** 本机脱敏诊断记录；默认关闭，不上传，用户可清除。 */
  diagnosticsEnabled: boolean;
};

export type CalendarPreferences = {
  showLunar: boolean;
  /** 周起始日：周一或周日；月/周/日期选择器与任务「本周」共用。 */
  weekStart: WeekStart;
  /** 双休/单休/大小周/自定义；个人例外 > 法定节假日与调休 > 周规则。 */
  workdayRule: WorkdayRule;
  /** 节假日同步源与自动同步开关。 */
  holidaySource: HolidayPreferences;
  /** 个人日期例外（调休/请假/临时上班），优先于法定节假日。 */
  dateExceptions: DateException[];
};

/**
 * 导出位置偏好。
 *
 * `directory === null` 表示不预设目录：每次保存都由用户可见的保存面板
 * 选择，系统会使用自己上次的位置，应用绝不静默落到 Downloads/Documents。
 * 设置后只作为保存面板的起始目录，仍然由用户确认最终文件名与位置。
 */
export type ExportLocationPreferences = {
  directory: string | null;
};

export type AppSettings = {
  editor: EditorSettings;
  task: TaskDefaults;
  calendar: CalendarPreferences;
  privacy: PrivacyPreferences;
  export: ExportLocationPreferences;
};

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontSize: 15,
  paragraphSpacing: 8,
  textIndent: 0,
  width: 800,
  titleMode: 'empty',
  showBlockIcon: true,
  textColor: 'auto',
};

export const DEFAULT_TASK_DEFAULTS: TaskDefaults = {
  defaultListId: null,
  defaultReminder: '',
  completionBehavior: 'keep',
  noteFolderId: NOTE_FOLDERS[0]?.id ?? null,
};

export const DEFAULT_CALENDAR_PREFERENCES: CalendarPreferences = {
  showLunar: true,
  weekStart: 'monday',
  workdayRule: {
    ...DEFAULT_WORKDAY_RULE,
    customWorkdays: [...DEFAULT_WORKDAY_RULE.customWorkdays],
  },
  holidaySource: { ...DEFAULT_HOLIDAY_PREFERENCES },
  dateExceptions: [],
};

/** 深拷贝规则，避免两个设置对象共用同一个 customWorkdays 数组。 */
function cloneWorkdayRule(rule: WorkdayRule): WorkdayRule {
  return {
    rule: rule.rule,
    anchorMonday: rule.anchorMonday,
    customWorkdays: [...rule.customWorkdays],
  };
}

export const DEFAULT_EXPORT_LOCATION_PREFERENCES: ExportLocationPreferences = {
  directory: null,
};

export const DEFAULT_PRIVACY_PREFERENCES: PrivacyPreferences = {
  hideOnBlur: false,
  clipboardClearSeconds: 0,
  diagnosticsEnabled: false,
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  editor: DEFAULT_EDITOR_SETTINGS,
  task: DEFAULT_TASK_DEFAULTS,
  calendar: DEFAULT_CALENDAR_PREFERENCES,
  privacy: DEFAULT_PRIVACY_PREFERENCES,
  export: DEFAULT_EXPORT_LOCATION_PREFERENCES,
};

export function cloneAppSettings(settings: AppSettings): AppSettings {
  return {
    editor: { ...settings.editor },
    task: { ...settings.task },
    calendar: {
      ...settings.calendar,
      workdayRule: cloneWorkdayRule(settings.calendar.workdayRule),
      holidaySource: { ...settings.calendar.holidaySource },
      dateExceptions: settings.calendar.dateExceptions.map((item) => ({
        ...item,
      })),
    },
    privacy: { ...settings.privacy },
    export: { ...settings.export },
  };
}

export function cloneDefaultSettings(): AppSettings {
  return cloneAppSettings(DEFAULT_APP_SETTINGS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickNumber(
  value: unknown,
  allowed: readonly number[],
  fallback: number,
): number {
  if (typeof value === 'number' && allowed.includes(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && allowed.includes(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function pickWidth(value: unknown, fallback: EditorWidth): EditorWidth {
  if (value === '100%') {
    return '100%';
  }
  if (value === 800 || value === 1024) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '100%') {
      return '100%';
    }
    const parsed = Number(trimmed);
    if (parsed === 800 || parsed === 1024) {
      return parsed;
    }
  }
  return fallback;
}

function pickTitleMode(
  value: unknown,
  fallback: EditorTitleMode,
): EditorTitleMode {
  return typeof value === 'string' &&
    EDITOR_TITLE_MODES.includes(value as EditorTitleMode)
    ? (value as EditorTitleMode)
    : fallback;
}

function pickTextColor(
  value: unknown,
  fallback: EditorTextColor,
): EditorTextColor {
  return typeof value === 'string' &&
    EDITOR_TEXT_COLORS.includes(value as EditorTextColor)
    ? (value as EditorTextColor)
    : fallback;
}

function pickFolderId(value: unknown, fallback: string | null): string | null {
  if (value === null || value === '') {
    return null;
  }
  if (
    typeof value === 'string' &&
    NOTE_FOLDERS.some((folder) => folder.id === value)
  ) {
    return value;
  }
  return fallback;
}

/**
 * 容错解析（DB 旧值 / 手工改 localStorage）。非法值回退默认值，
 * 不让设置页或编辑器因为一条坏记录白屏。
 */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const source = isRecord(raw) ? raw : {};
  const editor = isRecord(source.editor) ? source.editor : {};
  const task = isRecord(source.task) ? source.task : {};
  const calendar = isRecord(source.calendar) ? source.calendar : {};
  const privacy = isRecord(source.privacy) ? source.privacy : {};
  const exportLocation = isRecord(source.export) ? source.export : {};

  const defaultListId =
    task.defaultListId === null || task.defaultListId === ''
      ? null
      : typeof task.defaultListId === 'string' &&
          task.defaultListId.trim() !== ''
        ? task.defaultListId.trim()
        : DEFAULT_TASK_DEFAULTS.defaultListId;

  return {
    editor: {
      fontSize: pickNumber(
        editor.fontSize,
        EDITOR_FONT_SIZES,
        DEFAULT_EDITOR_SETTINGS.fontSize,
      ),
      paragraphSpacing: pickNumber(
        editor.paragraphSpacing,
        EDITOR_PARAGRAPH_SPACINGS,
        DEFAULT_EDITOR_SETTINGS.paragraphSpacing,
      ),
      textIndent: pickNumber(
        editor.textIndent,
        EDITOR_TEXT_INDENTS,
        DEFAULT_EDITOR_SETTINGS.textIndent,
      ),
      width: pickWidth(editor.width, DEFAULT_EDITOR_SETTINGS.width),
      titleMode: pickTitleMode(
        editor.titleMode,
        DEFAULT_EDITOR_SETTINGS.titleMode,
      ),
      showBlockIcon:
        typeof editor.showBlockIcon === 'boolean'
          ? editor.showBlockIcon
          : DEFAULT_EDITOR_SETTINGS.showBlockIcon,
      textColor: pickTextColor(
        editor.textColor,
        DEFAULT_EDITOR_SETTINGS.textColor,
      ),
    },
    task: {
      defaultListId,
      defaultReminder: normalizeTaskDefaultReminder(task.defaultReminder),
      completionBehavior: normalizeTaskCompletionBehavior(
        task.completionBehavior,
      ),
      noteFolderId: pickFolderId(
        task.noteFolderId,
        DEFAULT_TASK_DEFAULTS.noteFolderId,
      ),
    },
    calendar: {
      showLunar:
        typeof calendar.showLunar === 'boolean'
          ? calendar.showLunar
          : DEFAULT_CALENDAR_PREFERENCES.showLunar,
      // 旧键 calendar.weekStartsOn（1/0）同样接受；非法值回退周一。
      weekStart: normalizeWeekStart(
        calendar.weekStart ?? calendar.weekStartsOn,
      ),
      workdayRule: normalizeWorkdayRule(
        calendar.workdayRule ?? calendar.workdays,
      ),
      holidaySource: normalizeHolidayPreferences(
        calendar.holidaySource ?? calendar.holidaySourceKind,
      ),
      dateExceptions: normalizeDateExceptions(
        calendar.dateExceptions ?? calendar.exceptions,
      ),
    },
    privacy: {
      hideOnBlur:
        typeof privacy.hideOnBlur === 'boolean'
          ? privacy.hideOnBlur
          : DEFAULT_PRIVACY_PREFERENCES.hideOnBlur,
      clipboardClearSeconds: normalizePrivacyClipboardClearSeconds(
        privacy.clipboardClearSeconds,
      ),
      diagnosticsEnabled:
        typeof privacy.diagnosticsEnabled === 'boolean'
          ? privacy.diagnosticsEnabled
          : DEFAULT_PRIVACY_PREFERENCES.diagnosticsEnabled,
    },
    export: {
      // 只保存用户明确选择的非空路径；路径是否存在由保存命令在落盘前校验。
      directory:
        typeof exportLocation.directory === 'string' &&
        exportLocation.directory.trim() !== ''
          ? exportLocation.directory.trim()
          : DEFAULT_EXPORT_LOCATION_PREFERENCES.directory,
    },
  };
}

export function parseStoredSettings(
  settings: readonly Setting[],
): AppSettings {
  const values = new Map<string, JsonValue>();
  for (const setting of settings) {
    if (setting.scope === SETTINGS_SCOPE && setting.deletedAt === null) {
      values.set(setting.key, setting.value);
    }
  }

  return normalizeAppSettings({
    editor: {
      fontSize: values.get(SETTING_KEYS.editorFontSize),
      paragraphSpacing: values.get(SETTING_KEYS.editorParagraphSpacing),
      textIndent: values.get(SETTING_KEYS.editorTextIndent),
      width: values.get(SETTING_KEYS.editorWidth),
      titleMode: values.get(SETTING_KEYS.editorTitleMode),
      showBlockIcon: values.get(SETTING_KEYS.editorShowBlockIcon),
      textColor: values.get(SETTING_KEYS.editorTextColor),
    },
    task: {
      defaultListId: values.get(SETTING_KEYS.taskDefaultList),
      defaultReminder: values.get(SETTING_KEYS.taskDefaultReminder),
      completionBehavior: values.get(SETTING_KEYS.taskCompletionBehavior),
      noteFolderId: values.get(SETTING_KEYS.noteDefaultFolder),
    },
    calendar: {
      showLunar: values.get(SETTING_KEYS.showLunar),
      weekStart:
        values.get(SETTING_KEYS.calendarWeekStart) ??
        values.get(LEGACY_SETTING_KEYS.calendarWeekStartsOn),
      workdayRule:
        values.get(SETTING_KEYS.calendarWorkdayRule) ??
        values.get(LEGACY_SETTING_KEYS.calendarWorkdays),
      holidaySource: values.get(SETTING_KEYS.calendarHolidaySource),
      dateExceptions: values.get(SETTING_KEYS.calendarDateExceptions),
    },
    privacy: {
      hideOnBlur: values.get(SETTING_KEYS.privacyHideOnBlur),
      clipboardClearSeconds: values.get(
        SETTING_KEYS.privacyClipboardClearSeconds,
      ),
      diagnosticsEnabled: values.get(SETTING_KEYS.privacyDiagnosticsEnabled),
    },
    export: {
      directory: values.get(SETTING_KEYS.exportDirectory),
    },
  });
}

function input(key: string, value: JsonValue): NewSetting {
  return { scope: SETTINGS_SCOPE, key, value };
}

function workdayRuleJson(rule: WorkdayRule): JsonValue {
  return {
    rule: rule.rule,
    anchorMonday: rule.anchorMonday,
    customWorkdays: [...rule.customWorkdays],
  };
}

function holidaySourceJson(source: HolidayPreferences): JsonValue {
  return {
    // v2 源模型：源（上游）与传输分离；同一仓库镜像不重复计数。
    mode: source.mode,
    sourceId: source.sourceId,
    transport: source.transport,
    customUrl: source.customUrl,
    customFormat: source.customFormat,
    autoSync: source.autoSync,
    autoFallback: source.autoFallback,
    // 兼容旧版读取/回滚；下一大版本再删除。
    source: source.source,
  };
}

function dateExceptionsJson(exceptions: readonly DateException[]): JsonValue {
  return exceptions.map((item) => ({
    date: item.date,
    kind: item.kind,
    note: item.note,
  }));
}

export function settingsToInputs(settings: AppSettings): NewSetting[] {
  return [
    input(SETTING_KEYS.editorFontSize, settings.editor.fontSize),
    input(
      SETTING_KEYS.editorParagraphSpacing,
      settings.editor.paragraphSpacing,
    ),
    input(SETTING_KEYS.editorTextIndent, settings.editor.textIndent),
    input(SETTING_KEYS.editorWidth, settings.editor.width),
    input(SETTING_KEYS.editorTitleMode, settings.editor.titleMode),
    input(SETTING_KEYS.editorShowBlockIcon, settings.editor.showBlockIcon),
    input(SETTING_KEYS.editorTextColor, settings.editor.textColor),
    input(SETTING_KEYS.taskDefaultList, settings.task.defaultListId),
    input(SETTING_KEYS.taskDefaultReminder, settings.task.defaultReminder),
    input(
      SETTING_KEYS.taskCompletionBehavior,
      settings.task.completionBehavior,
    ),
    input(SETTING_KEYS.noteDefaultFolder, settings.task.noteFolderId),
    input(SETTING_KEYS.showLunar, settings.calendar.showLunar),
    input(SETTING_KEYS.calendarWeekStart, settings.calendar.weekStart),
    input(
      SETTING_KEYS.calendarWorkdayRule,
      workdayRuleJson(settings.calendar.workdayRule),
    ),
    input(
      SETTING_KEYS.calendarHolidaySource,
      holidaySourceJson(settings.calendar.holidaySource),
    ),
    input(
      SETTING_KEYS.calendarDateExceptions,
      dateExceptionsJson(settings.calendar.dateExceptions),
    ),
    input(SETTING_KEYS.privacyHideOnBlur, settings.privacy.hideOnBlur),
    input(
      SETTING_KEYS.privacyClipboardClearSeconds,
      settings.privacy.clipboardClearSeconds,
    ),
    input(
      SETTING_KEYS.privacyDiagnosticsEnabled,
      settings.privacy.diagnosticsEnabled,
    ),
    input(SETTING_KEYS.exportDirectory, settings.export.directory),
  ];
}

export function diffSettings(
  previous: AppSettings,
  next: AppSettings,
): NewSetting[] {
  const before = new Map(
    settingsToInputs(previous).map((item) => [item.key, item.value]),
  );
  return settingsToInputs(next).filter(
    (item) =>
      JSON.stringify(before.get(item.key)) !== JSON.stringify(item.value),
  );
}

/**
 * 把单条设置应用到一个完整设置对象上。仅用于浏览器预览的 localStorage 源；
 * 非法值保持原值，避免编辑器在运行中突然跳回默认。
 */
export function applySettingValue(
  current: AppSettings,
  key: string,
  value: JsonValue,
): AppSettings {
  const next = cloneAppSettings(current);

  switch (key) {
    case SETTING_KEYS.editorFontSize:
      next.editor.fontSize = pickNumber(
        value,
        EDITOR_FONT_SIZES,
        current.editor.fontSize,
      );
      break;
    case SETTING_KEYS.editorParagraphSpacing:
      next.editor.paragraphSpacing = pickNumber(
        value,
        EDITOR_PARAGRAPH_SPACINGS,
        current.editor.paragraphSpacing,
      );
      break;
    case SETTING_KEYS.editorTextIndent:
      next.editor.textIndent = pickNumber(
        value,
        EDITOR_TEXT_INDENTS,
        current.editor.textIndent,
      );
      break;
    case SETTING_KEYS.editorWidth:
      next.editor.width = pickWidth(value, current.editor.width);
      break;
    case SETTING_KEYS.editorTitleMode:
      next.editor.titleMode = pickTitleMode(
        value,
        current.editor.titleMode,
      );
      break;
    case SETTING_KEYS.editorShowBlockIcon:
      if (typeof value === 'boolean') {
        next.editor.showBlockIcon = value;
      }
      break;
    case SETTING_KEYS.editorTextColor:
      next.editor.textColor = pickTextColor(
        value,
        current.editor.textColor,
      );
      break;
    case SETTING_KEYS.taskDefaultList:
      next.task.defaultListId =
        value === null || value === ''
          ? null
          : typeof value === 'string'
            ? value.trim() || null
            : current.task.defaultListId;
      break;
    case SETTING_KEYS.taskDefaultReminder:
      next.task.defaultReminder = normalizeTaskDefaultReminder(value);
      break;
    case SETTING_KEYS.taskCompletionBehavior:
      next.task.completionBehavior = normalizeTaskCompletionBehavior(value);
      break;
    case SETTING_KEYS.noteDefaultFolder:
      next.task.noteFolderId = pickFolderId(
        value,
        current.task.noteFolderId,
      );
      break;
    case SETTING_KEYS.showLunar:
      if (typeof value === 'boolean') {
        next.calendar.showLunar = value;
      }
      break;
    case SETTING_KEYS.calendarWeekStart:
    case LEGACY_SETTING_KEYS.calendarWeekStartsOn:
      next.calendar.weekStart = normalizeWeekStart(value);
      break;
    case SETTING_KEYS.calendarWorkdayRule:
    case LEGACY_SETTING_KEYS.calendarWorkdays:
      next.calendar.workdayRule = normalizeWorkdayRule(value);
      break;
    case SETTING_KEYS.calendarHolidaySource:
      next.calendar.holidaySource = normalizeHolidayPreferences(value);
      break;
    case SETTING_KEYS.calendarDateExceptions:
      next.calendar.dateExceptions = normalizeDateExceptions(value);
      break;
    case SETTING_KEYS.privacyHideOnBlur:
      if (typeof value === 'boolean') {
        next.privacy.hideOnBlur = value;
      }
      break;
    case SETTING_KEYS.privacyClipboardClearSeconds:
      next.privacy.clipboardClearSeconds =
        normalizePrivacyClipboardClearSeconds(value);
      break;
    case SETTING_KEYS.privacyDiagnosticsEnabled:
      if (typeof value === 'boolean') {
        next.privacy.diagnosticsEnabled = value;
      }
      break;
    case SETTING_KEYS.exportDirectory:
      next.export.directory =
        value === null || value === ''
          ? null
          : typeof value === 'string'
            ? value.trim() || null
            : current.export.directory;
      break;
    default:
      break;
  }

  return next;
}

function nowISO(): string {
  return new Date().toISOString();
}

/** 浏览器预览源用的 Setting 行；id 稳定，便于测试与调试。 */
export function appSettingsToRows(
  settings: AppSettings,
  timestamp = nowISO(),
): Setting[] {
  return settingsToInputs(settings).map((item) => ({
    id: `local:${item.key}`,
    spaceId: 'personal',
    scope: SETTINGS_SCOPE,
    key: item.key,
    value: item.value,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    version: 1,
  }));
}

export function readLocalSettings(): AppSettings {
  if (typeof window === 'undefined') {
    return cloneDefaultSettings();
  }
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return cloneDefaultSettings();
    }
    return normalizeAppSettings(JSON.parse(raw));
  } catch {
    return cloneDefaultSettings();
  }
}

export function writeLocalSettings(settings: AppSettings): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify(settings),
    );
  } catch {
    // 隐私模式 / 配额受限时只保留当前会话；SQLite 仍是桌面端权威。
  }
}

export function createSettingsRepository(client: DbClient) {
  return {
    list: (query: SettingQuery = {}): Promise<Setting[]> =>
      client.settings.list(query),

    /** 从 SQLite 读取并镜像到 localStorage；返回解析后的完整偏好。 */
    async load(): Promise<AppSettings> {
      const rows = await client.settings.list({ scope: SETTINGS_SCOPE });
      const settings = parseStoredSettings(rows);
      writeLocalSettings(settings);
      return settings;
    },

    /** 全量写入（导入/重置用）。逐条执行，避免 SQLite 写锁竞争。 */
    async save(settings: AppSettings): Promise<void> {
      const normalized = normalizeAppSettings(settings);
      for (const item of settingsToInputs(normalized)) {
        await client.settings.set(item);
      }
      writeLocalSettings(normalized);
    },

    /** 只写入变化项（设置页每次改一项）。 */
    async saveChanged(
      previous: AppSettings,
      next: AppSettings,
    ): Promise<AppSettings> {
      const normalized = normalizeAppSettings(next);
      for (const item of diffSettings(previous, normalized)) {
        await client.settings.set(item);
      }
      writeLocalSettings(normalized);
      return normalized;
    },

    async reset(): Promise<AppSettings> {
      const defaults = cloneDefaultSettings();
      await this.save(defaults);
      return defaults;
    },
  };
}

export type SettingsRepository = ReturnType<typeof createSettingsRepository>;
