/**
 * OCR 设备偏好。只保存开关、引擎选择和端点，不保存任何密钥/令牌。
 * 默认关闭；坏数据回退默认值，避免设置页因一条坏记录白屏。
 */

import {
  DEFAULT_OCR_SETTINGS,
  type OcrEngineKind,
  type OcrSettings,
} from './types';

export const OCR_SETTINGS_KEY = 'zhixing.ocr.v1';
export const OCR_LANGUAGES = [
  { id: 'zh-Hans', label: '简体中文' },
  { id: 'zh-Hant', label: '繁体中文' },
  { id: 'en', label: '英文' },
  { id: 'ja', label: '日文' },
] as const;

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEngine(value: unknown): value is OcrEngineKind {
  return value === 'system-local' || value === 'custom-adapter' || value === 'none';
}

function normalizeScopeFolderId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // 目录 ID 由知识库维护；这里只做安全字符与长度边界，不伪造目录。
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : null;
}

export function normalizeEndpoint(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

export function normalizeOcrSettings(raw: unknown): OcrSettings {
  const source = isRecord(raw) ? raw : {};
  const custom = isRecord(source.custom) ? source.custom : {};
  const languages = Array.isArray(source.languages)
    ? source.languages.filter(
        (value): value is string =>
          typeof value === 'string' &&
          OCR_LANGUAGES.some((language) => language.id === value),
      )
    : [];
  const timeout =
    typeof custom.timeoutMs === 'number' && Number.isFinite(custom.timeoutMs)
      ? Math.max(1_000, Math.min(120_000, Math.round(custom.timeoutMs)))
      : DEFAULT_OCR_SETTINGS.custom.timeoutMs;
  return {
    enabled: source.enabled === true,
    engine: isEngine(source.engine)
      ? source.engine
      : DEFAULT_OCR_SETTINGS.engine,
    scope:
      source.scope === 'all-images' || source.scope === 'folder'
        ? source.scope
        : 'new-images',
    scopeFolderId: normalizeScopeFolderId(source.scopeFolderId),
    languages:
      languages.length > 0
        ? Array.from(new Set(languages))
        : [...DEFAULT_OCR_SETTINGS.languages],
    textStorage: source.textStorage === 'sync' ? 'sync' : 'local',
    custom: {
      endpoint: normalizeEndpoint(custom.endpoint),
      allowRemoteImages: custom.allowRemoteImages === true,
      timeoutMs: timeout,
    },
  };
}

export interface OcrSettingsStore {
  load(): OcrSettings;
  save(settings: OcrSettings): OcrSettings;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class LocalStorageOcrSettingsStore implements OcrSettingsStore {
  private readonly storage: StorageLike | null;
  private readonly key: string;

  constructor(
    storage: StorageLike | null = defaultStorage(),
    key = OCR_SETTINGS_KEY,
  ) {
    this.storage = storage;
    this.key = key;
  }

  load(): OcrSettings {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(this.key) ?? null;
    } catch {
      raw = null;
    }
    if (!raw) return structuredCloneSettings(DEFAULT_OCR_SETTINGS);
    try {
      return normalizeOcrSettings(JSON.parse(raw) as unknown);
    } catch {
      return structuredCloneSettings(DEFAULT_OCR_SETTINGS);
    }
  }

  save(settings: OcrSettings): OcrSettings {
    const normalized = normalizeOcrSettings(settings);
    try {
      this.storage?.setItem(this.key, JSON.stringify(normalized));
    } catch {
      // 隐私模式/配额不足：本次修改仍在内存中由调用方持有。
    }
    return normalized;
  }
}

export class MemoryOcrSettingsStore implements OcrSettingsStore {
  private settings: OcrSettings;

  constructor(initial: OcrSettings = DEFAULT_OCR_SETTINGS) {
    this.settings = structuredCloneSettings(initial);
  }

  load(): OcrSettings {
    return structuredCloneSettings(this.settings);
  }

  save(settings: OcrSettings): OcrSettings {
    this.settings = normalizeOcrSettings(settings);
    return structuredCloneSettings(this.settings);
  }
}

export function structuredCloneSettings(settings: OcrSettings): OcrSettings {
  return {
    ...settings,
    languages: [...settings.languages],
    custom: { ...settings.custom },
  };
}

export function defaultOcrSettingsStore(): OcrSettingsStore {
  return new LocalStorageOcrSettingsStore();
}
