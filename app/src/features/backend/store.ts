/**
 * 后台服务地址的本机存储。
 *
 * 只保存地址与设备名称；配对码、deviceToken、refreshToken 都不在这里。
 * 配对凭证由 `sync/store.ts` 的 SyncStore 管理。
 */

export type BackendSavedConfig = {
  version: 1;
  baseUrl: string;
  deviceName: string;
  updatedAt: string | null;
};

export interface BackendConfigStore {
  load(): Promise<BackendSavedConfig | null>;
  save(config: BackendSavedConfig): Promise<void>;
  clear(): Promise<void>;
}

const KEY = 'zhixing.backend.config.v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function defaultBackendConfig(): BackendSavedConfig {
  return {
    version: 1,
    baseUrl: '',
    deviceName: '本机',
    updatedAt: null,
  };
}

export class LocalStorageBackendConfigStore implements BackendConfigStore {
  private readonly storage: StorageLike | null;
  private memory: BackendSavedConfig | null = null;

  constructor(storage: StorageLike | null = defaultStorage()) {
    this.storage = storage;
  }

  async load(): Promise<BackendSavedConfig | null> {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(KEY) ?? null;
    } catch {
      raw = null;
    }
    if (!raw) return this.memory;
    try {
      const parsed = JSON.parse(raw) as Partial<BackendSavedConfig>;
      if (parsed.version !== 1 || typeof parsed.baseUrl !== 'string') {
        return null;
      }
      return {
        version: 1,
        baseUrl: parsed.baseUrl,
        deviceName:
          typeof parsed.deviceName === 'string' && parsed.deviceName.trim()
            ? parsed.deviceName
            : '本机',
        updatedAt:
          typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      };
    } catch {
      return null;
    }
  }

  async save(config: BackendSavedConfig): Promise<void> {
    const safe: BackendSavedConfig = {
      version: 1,
      baseUrl: config.baseUrl.trim(),
      deviceName: config.deviceName.trim() || '本机',
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

export class MemoryBackendConfigStore implements BackendConfigStore {
  private config: BackendSavedConfig | null;

  constructor(initial: BackendSavedConfig | null = null) {
    this.config = initial;
  }

  async load(): Promise<BackendSavedConfig | null> {
    return this.config ? { ...this.config } : null;
  }

  async save(config: BackendSavedConfig): Promise<void> {
    this.config = {
      version: 1,
      baseUrl: config.baseUrl.trim(),
      deviceName: config.deviceName.trim() || '本机',
      updatedAt: config.updatedAt,
    };
  }

  async clear(): Promise<void> {
    this.config = null;
  }
}
