/**
 * 单篇导出偏好。
 *
 * 规范 §8 要求默认格式/元信息/图片/纸张写入 SQLite `settings` 表，不写
 * localStorage；浏览器预览或测试没有 SQLite 时静默回退默认值，不影响导出。
 */

import type { DbClient } from '../../../data/db/client';
import type { NoteExportFormat, NoteExportPreferences, NotePdfPaper } from './types';

export const NOTE_EXPORT_SETTING_KEYS = {
  format: 'export.defaultFormat',
  includeMetadata: 'export.includeMetadata',
  includeImages: 'export.includeImages',
  pdfPaper: 'export.pdfPaper',
} as const;

export const DEFAULT_NOTE_EXPORT_PREFERENCES: NoteExportPreferences = {
  format: 'docx',
  includeMetadata: true,
  includeImages: true,
  pdfPaper: 'A4',
};

export type NoteExportSettingsClient = Pick<DbClient, 'settings'>;

function isFormat(value: unknown): value is NoteExportFormat {
  return value === 'docx' || value === 'pdf' || value === 'md';
}

function isPaper(value: unknown): value is NotePdfPaper {
  return value === 'A4' || value === 'Letter';
}

export async function loadNoteExportPreferences(
  client: NoteExportSettingsClient,
): Promise<NoteExportPreferences> {
  try {
    const rows = await client.settings.list({ scope: 'device' });
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    const format = byKey.get(NOTE_EXPORT_SETTING_KEYS.format);
    const includeMetadata = byKey.get(NOTE_EXPORT_SETTING_KEYS.includeMetadata);
    const includeImages = byKey.get(NOTE_EXPORT_SETTING_KEYS.includeImages);
    const paper = byKey.get(NOTE_EXPORT_SETTING_KEYS.pdfPaper);
    return {
      format: isFormat(format) ? format : DEFAULT_NOTE_EXPORT_PREFERENCES.format,
      includeMetadata:
        typeof includeMetadata === 'boolean'
          ? includeMetadata
          : DEFAULT_NOTE_EXPORT_PREFERENCES.includeMetadata,
      includeImages:
        typeof includeImages === 'boolean'
          ? includeImages
          : DEFAULT_NOTE_EXPORT_PREFERENCES.includeImages,
      pdfPaper: isPaper(paper)
        ? paper
        : DEFAULT_NOTE_EXPORT_PREFERENCES.pdfPaper,
    };
  } catch {
    return { ...DEFAULT_NOTE_EXPORT_PREFERENCES };
  }
}

/**
 * 保存失败不回滚导出：偏好只是默认值，写设置失败不应让已经生成的文件丢失。
 * 调用方可以忽略返回的 `false`，或在设置页复用时提示。
 */
export async function saveNoteExportPreferences(
  client: NoteExportSettingsClient,
  preferences: NoteExportPreferences,
): Promise<boolean> {
  try {
    await client.settings.set({
      scope: 'device',
      key: NOTE_EXPORT_SETTING_KEYS.format,
      value: preferences.format,
    });
    await client.settings.set({
      scope: 'device',
      key: NOTE_EXPORT_SETTING_KEYS.includeMetadata,
      value: preferences.includeMetadata,
    });
    await client.settings.set({
      scope: 'device',
      key: NOTE_EXPORT_SETTING_KEYS.includeImages,
      value: preferences.includeImages,
    });
    await client.settings.set({
      scope: 'device',
      key: NOTE_EXPORT_SETTING_KEYS.pdfPaper,
      value: preferences.pdfPaper,
    });
    return true;
  } catch {
    return false;
  }
}
