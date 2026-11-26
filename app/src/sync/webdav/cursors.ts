/**
 * WebDAV 设备游标持久化。
 *
 * 游标只表示“某设备目录已应用到第几个 seq 文件”；它不是可变 manifest，
 * 也不需要原子更新。应用完 op 后再保存游标；崩溃窗口内重放是幂等的。
 */

import { sha256Hex } from '../../../../packages/sync-webdav/src/index.ts';

export type WebDavSnapshotMark = {
  name: string;
  coveredSeq: number;
};

export type WebDavCursorState = {
  version: 1;
  baseUrl: string;
  root: string;
  spaceId: string;
  cursors: Record<string, number>;
  lastSyncAt: string | null;
  lastError: string | null;
  lastSnapshot: WebDavSnapshotMark | null;
  warnings: string[];
};

export interface WebDavCursorStore {
  load(): Promise<WebDavCursorState>;
  save(state: WebDavCursorState): Promise<void>;
  clear(): Promise<void>;
}

export type WebDavCursorStoreOptions = {
  baseUrl: string;
  root: string;
  spaceId: string;
};

export function emptyCursorState(
  options: WebDavCursorStoreOptions,
): WebDavCursorState {
  return {
    version: 1,
    baseUrl: options.baseUrl,
    root: options.root,
    spaceId: options.spaceId,
    cursors: {},
    lastSyncAt: null,
    lastError: null,
    lastSnapshot: null,
    warnings: [],
  };
}

function storageKey(options: WebDavCursorStoreOptions): string {
  const fingerprint = sha256Hex(
    `${options.baseUrl}\u0000${options.root}\u0000${options.spaceId}`,
  ).slice(0, 20);
  return `zhixing.webdav.cursors.v1:${fingerprint}`;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class LocalStorageWebDavCursorStore implements WebDavCursorStore {
  private readonly options: WebDavCursorStoreOptions;
  private readonly storage: StorageLike | null;
  private readonly key: string;
  private memory: string | null = null;

  constructor(
    options: WebDavCursorStoreOptions,
    storage: StorageLike | null = defaultStorage(),
  ) {
    this.options = options;
    this.storage = storage;
    this.key = storageKey(options);
  }

  async load(): Promise<WebDavCursorState> {
    let raw: string | null = null;
    try {
      raw = this.storage ? this.storage.getItem(this.key) : this.memory;
    } catch {
      raw = this.memory;
    }
    if (!raw) return emptyCursorState(this.options);
    try {
      const parsed = JSON.parse(raw) as Partial<WebDavCursorState>;
      if (parsed.version !== 1) return emptyCursorState(this.options);
      return {
        ...emptyCursorState(this.options),
        cursors: sanitizeCursors(parsed.cursors),
        lastSyncAt:
          typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
        lastSnapshot:
          parsed.lastSnapshot &&
          typeof parsed.lastSnapshot.name === 'string' &&
          typeof parsed.lastSnapshot.coveredSeq === 'number'
            ? {
                name: parsed.lastSnapshot.name,
                coveredSeq: parsed.lastSnapshot.coveredSeq,
              }
            : null,
        warnings: Array.isArray(parsed.warnings)
          ? parsed.warnings.filter((item): item is string => typeof item === 'string')
          : [],
      };
    } catch {
      return emptyCursorState(this.options);
    }
  }

  async save(state: WebDavCursorState): Promise<void> {
    const raw = JSON.stringify(state);
    this.memory = raw;
    try {
      this.storage?.setItem(this.key, raw);
    } catch {
      // 隐私模式/配额不足时保留内存状态，不阻断同步。
    }
  }

  async clear(): Promise<void> {
    this.memory = null;
    try {
      this.storage?.removeItem(this.key);
    } catch {
      // ignore
    }
  }
}

export class MemoryWebDavCursorStore implements WebDavCursorStore {
  private state: WebDavCursorState;

  constructor(options: WebDavCursorStoreOptions, initial?: Partial<WebDavCursorState>) {
    this.state = {
      ...emptyCursorState(options),
      ...initial,
      cursors: sanitizeCursors(initial?.cursors),
    };
  }

  async load(): Promise<WebDavCursorState> {
    return {
      ...this.state,
      cursors: { ...this.state.cursors },
      warnings: [...this.state.warnings],
    };
  }

  async save(state: WebDavCursorState): Promise<void> {
    this.state = {
      ...state,
      cursors: { ...state.cursors },
      warnings: [...state.warnings],
    };
  }

  async clear(): Promise<void> {
    this.state = {
      ...emptyCursorState({
        baseUrl: this.state.baseUrl,
        root: this.state.root,
        spaceId: this.state.spaceId,
      }),
    };
  }
}

function sanitizeCursors(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  const output: Record<string, number> = {};
  for (const [device, seq] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(device)) continue;
    if (!Number.isSafeInteger(seq) || (seq as number) < 0) continue;
    output[device] = seq as number;
  }
  return output;
}
