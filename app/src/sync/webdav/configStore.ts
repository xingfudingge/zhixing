/**
 * WebDAV 连接配置的本机存储。
 *
 * 明确不保存密码：浏览器 localStorage 不是 OS 安全存储。正式桌面版接入
 * Tauri 安全存储后，只需替换这个 store 的凭证部分，同步引擎无需改动。
 */

import { createRandomId } from '../../../../packages/sync-webdav/src/index.ts';

export type WebDavSavedConfig = {
  version: 1;
  baseUrl: string;
  username: string;
  root: string;
  spaceId: string;
  deviceId: string;
  deviceName: string;
  /** 让 UI 明确展示“密码没有落盘”。 */
  passwordSaved: false;
  updatedAt: string | null;
};

export interface WebDavConfigStore {
  load(): Promise<WebDavSavedConfig | null>;
  save(config: WebDavSavedConfig): Promise<void>;
  clear(): Promise<void>;
}

const KEY = 'zhixing.webdav.config.v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * 同步读取已保存的 WebDAV 配置，供 OCR 文案判断“是否已有同步目标”。
 * 只读本机 localStorage；不包含密码。
 */
export function readStoredWebDavConfig(
  storage: StorageLike | null = defaultStorage(),
): WebDavSavedConfig | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WebDavSavedConfig>;
    if (parsed.version !== 1 || typeof parsed.baseUrl !== 'string') {
      return null;
    }
    return {
      version: 1,
      baseUrl: parsed.baseUrl,
      username: typeof parsed.username === 'string' ? parsed.username : '',
      root: typeof parsed.root === 'string' ? parsed.root : '/zhixing',
      spaceId:
        typeof parsed.spaceId === 'string' ? parsed.spaceId : 'personal',
      deviceId:
        typeof parsed.deviceId === 'string' && parsed.deviceId
          ? parsed.deviceId
          : createRandomId('device'),
      deviceName:
        typeof parsed.deviceName === 'string' ? parsed.deviceName : '本机',
      passwordSaved: false,
      updatedAt:
        typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch {
    return null;
  }
}

export function defaultWebDavConfig(): WebDavSavedConfig {
  return {
    version: 1,
    baseUrl: '',
    username: '',
    root: '/zhixing',
    spaceId: 'personal',
    deviceId: createRandomId('device'),
    deviceName: '本机',
    passwordSaved: false,
    updatedAt: null,
  };
}

export class LocalStorageWebDavConfigStore implements WebDavConfigStore {
  private readonly storage: StorageLike | null;
  private memory: WebDavSavedConfig | null = null;

  constructor(storage: StorageLike | null = defaultStorage()) {
    this.storage = storage;
  }

  async load(): Promise<WebDavSavedConfig | null> {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(KEY) ?? null;
    } catch {
      raw = null;
    }
    if (!raw) return this.memory;
    try {
      const parsed = JSON.parse(raw) as Partial<WebDavSavedConfig>;
      if (parsed.version !== 1 || typeof parsed.baseUrl !== 'string') {
        return null;
      }
      return {
        version: 1,
        baseUrl: parsed.baseUrl,
        username: typeof parsed.username === 'string' ? parsed.username : '',
        root: typeof parsed.root === 'string' ? parsed.root : '/zhixing',
        spaceId:
          typeof parsed.spaceId === 'string' ? parsed.spaceId : 'personal',
        deviceId:
          typeof parsed.deviceId === 'string' && parsed.deviceId
            ? parsed.deviceId
            : createRandomId('device'),
        deviceName:
          typeof parsed.deviceName === 'string' ? parsed.deviceName : '本机',
        passwordSaved: false,
        updatedAt:
          typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      };
    } catch {
      return null;
    }
  }

  async save(config: WebDavSavedConfig): Promise<void> {
    // 无论调用方传入什么，落盘对象都不含 password 字段。
    const safe: WebDavSavedConfig = {
      version: 1,
      baseUrl: config.baseUrl,
      username: config.username,
      root: config.root,
      spaceId: config.spaceId,
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      passwordSaved: false,
      updatedAt: config.updatedAt,
    };
    this.memory = safe;
    try {
      this.storage?.setItem(KEY, JSON.stringify(safe));
    } catch {
      // 隐私模式/配额不足时保留内存配置。
    }
  }

  async clear(): Promise<void> {
    this.memory = null;
    try {
      this.storage?.removeItem(KEY);
    } catch {
      // ignore
    }
  }
}

export class MemoryWebDavConfigStore implements WebDavConfigStore {
  private config: WebDavSavedConfig | null;

  constructor(initial: WebDavSavedConfig | null = null) {
    this.config = initial;
  }

  async load(): Promise<WebDavSavedConfig | null> {
    return this.config ? { ...this.config } : null;
  }

  async save(config: WebDavSavedConfig): Promise<void> {
    this.config = {
      version: 1,
      baseUrl: config.baseUrl,
      username: config.username,
      root: config.root,
      spaceId: config.spaceId,
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      passwordSaved: false,
      updatedAt: config.updatedAt,
    };
  }

  async clear(): Promise<void> {
    this.config = null;
  }
}
