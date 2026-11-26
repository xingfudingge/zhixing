/**
 * 模式切换编排：预检 → 连接探测 → 上传/追平 → 写模式。
 * 任何一步失败都不写模式，保留原 transport 与本地数据。
 */

import {
  evaluateModeSwitch,
  ModeSwitchBlockedError,
  WebDavError,
  type ModeSwitchDecision,
  type Platform,
  type SyncMode,
} from '../../../../packages/sync-webdav/src/index.ts';
import type { WebDavSyncEngine } from './engine.ts';
import { isSyncMode, SYNC_MODE_STORAGE_KEY } from '../mode.ts';

export type { ModeSwitchContext, ModeSwitchDecision, SyncMode } from '../../../../packages/sync-webdav/src/index.ts';
export { evaluateModeSwitch, ModeSwitchBlockedError } from '../../../../packages/sync-webdav/src/index.ts';

export interface WebDavModeStore {
  load(): Promise<SyncMode | null>;
  save(mode: SyncMode): Promise<void>;
  clear(): Promise<void>;
}

const MODE_KEY = SYNC_MODE_STORAGE_KEY;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class LocalStorageWebDavModeStore implements WebDavModeStore {
  private readonly storage: StorageLike | null;
  private memory: SyncMode | null = null;

  constructor(storage: StorageLike | null = defaultStorage()) {
    this.storage = storage;
  }

  async load(): Promise<SyncMode | null> {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(MODE_KEY) ?? null;
    } catch {
      raw = null;
    }
    if (isSyncMode(raw)) {
      return raw;
    }
    return this.memory;
  }

  async save(mode: SyncMode): Promise<void> {
    this.memory = mode;
    try {
      this.storage?.setItem(MODE_KEY, mode);
    } catch {
      // ignore
    }
  }

  async clear(): Promise<void> {
    this.memory = null;
    try {
      this.storage?.removeItem(MODE_KEY);
    } catch {
      // ignore
    }
  }
}

export class MemoryWebDavModeStore implements WebDavModeStore {
  private mode: SyncMode | null;

  constructor(initial: SyncMode | null = null) {
    this.mode = initial;
  }

  async load(): Promise<SyncMode | null> {
    return this.mode;
  }

  async save(mode: SyncMode): Promise<void> {
    this.mode = mode;
  }

  async clear(): Promise<void> {
    this.mode = null;
  }
}

export type WebDavModeSwitchOptions = {
  confirmed?: boolean;
  activeOperation?: boolean;
  pendingDownloads?: number;
  localSynced?: boolean;
  backendReady?: boolean;
  backendCursorDrained?: boolean;
  /** 测试可跳过真实探测；默认执行。 */
  runConnectionTest?: boolean;
};

export class WebDavModeController {
  private readonly engine: WebDavSyncEngine;
  private readonly platform: Platform;
  private readonly store: WebDavModeStore;
  private switching = false;

  constructor(options: {
    engine: WebDavSyncEngine;
    platform: Platform;
    store?: WebDavModeStore;
  }) {
    this.engine = options.engine;
    this.platform = options.platform;
    this.store = options.store ?? new LocalStorageWebDavModeStore();
  }

  async currentMode(): Promise<SyncMode> {
    return (await this.store.load()) ?? 'local';
  }

  async preview(
    target: SyncMode,
    extra: Omit<WebDavModeSwitchOptions, 'runConnectionTest'> = {},
  ): Promise<ModeSwitchDecision> {
    const from = await this.currentMode();
    const pendingUploads = await this.engine.pendingCount();
    return evaluateModeSwitch({
      platform: this.platform,
      from,
      to: target,
      pendingUploads,
      pendingDownloads: extra.pendingDownloads,
      localSynced: extra.localSynced,
      backendReady: extra.backendReady,
      backendCursorDrained: extra.backendCursorDrained,
      activeOperation: this.switching || extra.activeOperation,
      confirmed: extra.confirmed,
    });
  }

  async switchMode(
    target: SyncMode,
    options: WebDavModeSwitchOptions = {},
  ): Promise<ModeSwitchDecision> {
    if (this.switching) {
      throw new ModeSwitchBlockedError(
        evaluateModeSwitch({
          platform: this.platform,
          from: await this.currentMode(),
          to: target,
          pendingUploads: 0,
          activeOperation: true,
        }),
      );
    }
    const from = await this.currentMode();
    const pendingUploads = await this.engine.pendingCount();
    const decision = evaluateModeSwitch({
      platform: this.platform,
      from,
      to: target,
      pendingUploads,
      pendingDownloads: options.pendingDownloads,
      localSynced: options.localSynced,
      backendReady: options.backendReady,
      backendCursorDrained: options.backendCursorDrained,
      activeOperation: options.activeOperation,
      confirmed: options.confirmed,
    });
    if (!decision.allowed) {
      throw new ModeSwitchBlockedError(decision);
    }
    if (decision.code === 'NOOP') {
      return decision;
    }

    this.switching = true;
    try {
      if (target === 'webdav') {
        if (options.runConnectionTest !== false) {
          const test = await this.engine.testConnection();
          if (!test.ok) {
            throw new WebDavError(
              'MODE_SWITCH_BLOCKED',
              `WebDAV 连接探测失败：${
                test.error?.message ?? '请检查地址与权限'
              }`,
            );
          }
        }
        // 先把本地实体写成远端快照（如果已有数据），再上传 outbox。
        const status = await this.engine.status();
        if (status.entities > 0) {
          await this.engine.writeSnapshotNow();
        }
        const result = await this.engine.sync({ force: true });
        if (!result.ok) {
          throw new WebDavError(
            'MODE_SWITCH_BLOCKED',
            `首次 WebDAV 同步失败，仍保持 ${from} 模式：${
              result.error ?? '未知错误'
            }`,
          );
        }
      } else {
        this.engine.stop();
      }

      await this.store.save(target);
      return decision;
    } finally {
      this.switching = false;
    }
  }
}
