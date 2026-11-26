import type { EntityState, Hlc, SyncConflictRecord } from '../../../packages/shared/src/index.ts';
import type {
  LocalEntityState,
  OutboxEntry,
  SyncDeviceProfile,
  SyncStore,
} from './types.ts';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const STORAGE_KEY = 'zhixing.sync.v1';

type SyncDocument = {
  version: 1;
  profile: SyncDeviceProfile | null;
  hlc: Hlc | null;
  outbox: Record<string, OutboxEntry>;
  entities: Record<string, LocalEntityState>;
  conflicts: Record<string, SyncConflictRecord>;
};

function emptyDocument(): SyncDocument {
  return {
    version: 1,
    profile: null,
    hlc: null,
    outbox: {},
    entities: {},
    conflicts: {},
  };
}

function entityKey(entityType: string, entityId: string): string {
  return `${entityType}\u0000${entityId}`;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * 同步读取已配对设备画像，供设置页/OCR 文案判断“同步目标是否存在”。
 * 只读本机 localStorage，不联网；与 `LocalStorageSyncStore.loadProfile`
 * 使用同一份文档结构。
 */
export function readStoredSyncProfile(
  storage: StorageLike | null = defaultStorage(),
): SyncDeviceProfile | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncDocument>;
    if (parsed.version !== 1) return null;
    const profile = parsed.profile;
    return profile && typeof profile.baseUrl === 'string' ? profile : null;
  } catch {
    return null;
  }
}

/**
 * 浏览器/Tauri 渲染层的默认同步存储。
 * 正式桌面版会换成 SQLite 适配器；本类保留相同的异步接口。
 */
export class LocalStorageSyncStore implements SyncStore {
  private readonly storage: StorageLike | null;
  private readonly key: string;
  private memory: string | null = null;

  constructor(storage: StorageLike | null = defaultStorage(), key = STORAGE_KEY) {
    this.storage = storage;
    this.key = key;
  }

  private read(): SyncDocument {
    let raw: string | null = null;
    try {
      raw = this.storage ? this.storage.getItem(this.key) : this.memory;
    } catch {
      raw = this.memory;
    }
    if (!raw) return emptyDocument();
    try {
      const parsed = JSON.parse(raw) as Partial<SyncDocument>;
      if (parsed.version !== 1) return emptyDocument();
      return {
        version: 1,
        profile: parsed.profile ?? null,
        hlc: parsed.hlc ?? null,
        outbox: parsed.outbox ?? {},
        entities: parsed.entities ?? {},
        conflicts: parsed.conflicts ?? {},
      };
    } catch {
      return emptyDocument();
    }
  }

  private write(document: SyncDocument): void {
    const raw = JSON.stringify(document);
    this.memory = raw;
    try {
      this.storage?.setItem(this.key, raw);
    } catch {
      // 隐私模式或存储配额不足时退回内存，至少不丢当前会话。
    }
  }

  private mutate(fn: (document: SyncDocument) => void): void {
    const document = this.read();
    fn(document);
    this.write(document);
  }

  async loadProfile(): Promise<SyncDeviceProfile | null> {
    return this.read().profile;
  }

  async saveProfile(profile: SyncDeviceProfile): Promise<void> {
    this.mutate((document) => {
      document.profile = profile;
    });
  }

  async loadHlc(): Promise<Hlc | null> {
    return this.read().hlc;
  }

  async saveHlc(hlc: Hlc): Promise<void> {
    this.mutate((document) => {
      document.hlc = hlc;
    });
  }

  async listOutbox(): Promise<OutboxEntry[]> {
    return Object.values(this.read().outbox);
  }

  async putOutbox(entry: OutboxEntry): Promise<void> {
    this.mutate((document) => {
      document.outbox[entry.op.op_id] = entry;
    });
  }

  async removeOutbox(opId: string): Promise<void> {
    this.mutate((document) => {
      delete document.outbox[opId];
    });
  }

  async getEntity(entityType: string, entityId: string): Promise<LocalEntityState | null> {
    return this.read().entities[entityKey(entityType, entityId)] ?? null;
  }

  async putEntity(state: LocalEntityState): Promise<void> {
    this.mutate((document) => {
      document.entities[entityKey(state.entityType, state.entityId)] = state;
    });
  }

  async listEntities(entityType?: string): Promise<LocalEntityState[]> {
    const entities = Object.values(this.read().entities);
    return entityType ? entities.filter((entity) => entity.entityType === entityType) : entities;
  }

  async listConflicts(): Promise<SyncConflictRecord[]> {
    return Object.values(this.read().conflicts);
  }

  async putConflict(conflict: SyncConflictRecord): Promise<void> {
    this.mutate((document) => {
      document.conflicts[conflict.id] = conflict;
    });
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

/** 测试/内存运行使用；接口与持久化实现一致。 */
export class MemorySyncStore implements SyncStore {
  private profile: SyncDeviceProfile | null = null;
  private hlc: Hlc | null = null;
  private readonly outbox = new Map<string, OutboxEntry>();
  private readonly entities = new Map<string, EntityState>();
  private readonly conflicts = new Map<string, SyncConflictRecord>();

  async loadProfile(): Promise<SyncDeviceProfile | null> {
    return this.profile;
  }

  async saveProfile(profile: SyncDeviceProfile): Promise<void> {
    this.profile = profile;
  }

  async loadHlc(): Promise<Hlc | null> {
    return this.hlc;
  }

  async saveHlc(hlc: Hlc): Promise<void> {
    this.hlc = hlc;
  }

  async listOutbox(): Promise<OutboxEntry[]> {
    return Array.from(this.outbox.values());
  }

  async putOutbox(entry: OutboxEntry): Promise<void> {
    this.outbox.set(entry.op.op_id, entry);
  }

  async removeOutbox(opId: string): Promise<void> {
    this.outbox.delete(opId);
  }

  async getEntity(entityType: string, entityId: string): Promise<LocalEntityState | null> {
    return this.entities.get(entityKey(entityType, entityId)) ?? null;
  }

  async putEntity(state: LocalEntityState): Promise<void> {
    this.entities.set(entityKey(state.entityType, state.entityId), state);
  }

  async listEntities(entityType?: string): Promise<LocalEntityState[]> {
    const values = Array.from(this.entities.values());
    return entityType ? values.filter((entity) => entity.entityType === entityType) : values;
  }

  async listConflicts(): Promise<SyncConflictRecord[]> {
    return Array.from(this.conflicts.values());
  }

  async putConflict(conflict: SyncConflictRecord): Promise<void> {
    this.conflicts.set(conflict.id, conflict);
  }

  reset(): void {
    this.profile = null;
    this.hlc = null;
    this.outbox.clear();
    this.entities.clear();
    this.conflicts.clear();
  }
}
