import { describe, expect, it } from 'vitest';

import {
  HlcClock,
  advanceVv,
  applyOperation,
  type EntityState,
  type SyncConflictRecord,
  type SyncOp,
  type SyncOpWithCursor,
  type SyncStatusResponse,
} from '../../../../packages/shared/src/index.ts';
import { SyncHttpClient, type FetchLike } from '../client.ts';
import { SyncEngine, SyncEngineError } from '../engine.ts';
import { LocalStorageSyncStore, MemorySyncStore } from '../store.ts';
import type { SyncDeviceProfile } from '../types.ts';

type FakeDevice = {
  id: string;
  name: string;
  platform: string;
  token: string;
  refreshToken: string;
  accessExpired: boolean;
};

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

function entityKey(type: string, id: string): string {
  return `${type}\u0000${id}`;
}

/**
 * 测试用后台：实现与真实 Fastify 服务相同的 op 幂等与合并语义，
 * 用来验证客户端引擎的 outbox / 游标 / 离线重试 / 冲突副本。
 */
class FakeBackend {
  readonly devices = new Map<string, FakeDevice>();
  readonly ops: SyncOpWithCursor[] = [];
  readonly entities = new Map<string, EntityState>();
  readonly conflicts: SyncConflictRecord[] = [];
  private readonly serverClock = new HlcClock('server');
  private seq = 0;
  private pairCounter = 0;
  offline = false;
  refreshCalls = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  private nextSeq(): string {
    this.seq += 1;
    return String(this.seq);
  }

  private findDevice(id: string): FakeDevice | undefined {
    return this.devices.get(id);
  }

  expireAccess(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) device.accessExpired = true;
  }

  readonly fetch: FetchLike = async (input, init) => {
    if (this.offline) throw new TypeError('fetch failed: offline');
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;

    if (path === '/devices/pair' && method === 'POST') {
      if (typeof body?.code !== 'string' || body.code.length < 4) {
        return errorResponse(401, 'PAIRING_CODE_INVALID', '配对码无效');
      }
      this.pairCounter += 1;
      const device: FakeDevice = {
        id: `dev_fake_${this.pairCounter}`,
        name: String(body.name ?? '设备'),
        platform: String(body.platform ?? 'macos'),
        token: `zxdt_token_${this.pairCounter}`,
        refreshToken: `zxrt_refresh_${this.pairCounter}`,
        accessExpired: false,
      };
      this.devices.set(device.id, device);
      return jsonResponse(200, {
        ok: true,
        deviceId: device.id,
        deviceName: device.name,
        deviceToken: device.token,
        refreshToken: device.refreshToken,
        accessExpiresAt: new Date(this.now() + 86_400_000).toISOString(),
        refreshExpiresAt: new Date(this.now() + 2_592_000_000).toISOString(),
        features: { sync: true, attachments: true },
        serverTime: new Date(this.now()).toISOString(),
        apiVersion: '1',
      });
    }

    if (path === '/devices/refresh' && method === 'POST') {
      this.refreshCalls += 1;
      const device = [...this.devices.values()].find(
        (item) => item.refreshToken === body?.refreshToken,
      );
      if (!device) return errorResponse(401, 'REFRESH_TOKEN_INVALID', '刷新令牌无效');
      device.token = `${device.token}_r${this.refreshCalls}`;
      device.refreshToken = `${device.refreshToken}_r${this.refreshCalls}`;
      device.accessExpired = false;
      return jsonResponse(200, {
        ok: true,
        deviceToken: device.token,
        refreshToken: device.refreshToken,
        accessExpiresAt: new Date(this.now() + 86_400_000).toISOString(),
        refreshExpiresAt: new Date(this.now() + 2_592_000_000).toISOString(),
        serverTime: new Date(this.now()).toISOString(),
      });
    }

    const headers = (init?.headers ?? {}) as Record<string, string>;
    const deviceId = headers['x-zx-device'];
    const token = (headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const device = deviceId ? this.findDevice(deviceId) : undefined;
    if (!device || device.token !== token) {
      return errorResponse(401, 'DEVICE_TOKEN_INVALID', '设备令牌无效');
    }
    if (device.accessExpired) {
      return errorResponse(401, 'DEVICE_TOKEN_EXPIRED', '设备令牌已过期');
    }

    if (path === '/sync/push' && method === 'POST') {
      const incoming = (body?.ops ?? []) as SyncOp[];
      const applied: { opId: string; cursor: string; duplicate: boolean }[] = [];
      const duplicates: { opId: string; cursor: string; duplicate: boolean }[] = [];
      const newConflicts: SyncConflictRecord[] = [];
      for (const op of incoming) {
        const existing = this.ops.find((item) => item.op_id === op.op_id);
        if (existing) {
          duplicates.push({ opId: op.op_id, cursor: existing.cursor, duplicate: true });
          continue;
        }
        const cursor = this.nextSeq();
        this.ops.push({ ...op, cursor, origin: 'client' });
        const key = entityKey(op.entity_type, op.entity_id);
        const current = this.entities.get(key) ?? null;
        const result = applyOperation(current, op);
        this.entities.set(key, result.state);

        for (const copy of result.conflictCopies) {
          const hlc = this.serverClock.receive(op.hlc, this.now());
          const vvAfter = advanceVv(copy.vv, 'server');
          const copyState: EntityState = {
            ...copy,
            vv: vvAfter,
            hlc,
            fieldClocks: Object.fromEntries(
              Object.keys(copy.fields).map((field) => [field, { ...hlc }]),
            ),
            fieldVvs: Object.fromEntries(
              Object.keys(copy.fields).map((field) => [field, { ...vvAfter }]),
            ),
          };
          this.entities.set(entityKey(copy.entityType, copy.entityId), copyState);
          const copyCursor = this.nextSeq();
          this.ops.push({
            op_id: `srv_${op.op_id}_${copy.entityId.slice(-8)}`,
            space_id: op.space_id,
            device_id: 'server',
            entity_type: copy.entityType,
            entity_id: copy.entityId,
            op_type: 'upsert',
            hlc,
            base_vv: copy.vv,
            payload: copyState.fields,
            created_at: new Date(this.now()).toISOString(),
            cursor: copyCursor,
            origin: 'server',
          });
          for (const conflict of result.conflicts.filter(
            (item) => item.copyEntityId === copy.entityId,
          )) {
            newConflicts.push({
              id: `cf_${op.op_id}_${conflict.field}`,
              spaceId: op.space_id,
              entityType: op.entity_type,
              entityId: op.entity_id,
              field: conflict.field,
              kind: conflict.kind,
              incomingOpId: op.op_id,
              incomingDeviceId: op.device_id,
              winner: conflict.winner,
              localValue: conflict.localValue,
              incomingValue: conflict.incomingValue,
              copyEntityType: copy.entityType,
              copyEntityId: copy.entityId,
              cursor: copyCursor,
              createdAt: new Date(this.now()).toISOString(),
            });
          }
        }
        for (const conflict of result.conflicts.filter((item) => !item.copyEntityId)) {
          newConflicts.push({
            id: `cf_${op.op_id}_${conflict.field}`,
            spaceId: op.space_id,
            entityType: op.entity_type,
            entityId: op.entity_id,
            field: conflict.field,
            kind: conflict.kind,
            incomingOpId: op.op_id,
            incomingDeviceId: op.device_id,
            winner: conflict.winner,
            localValue: conflict.localValue,
            incomingValue: conflict.incomingValue,
            cursor,
            createdAt: new Date(this.now()).toISOString(),
          });
        }
        applied.push({ opId: op.op_id, cursor, duplicate: false });
      }
      const deduped = new Map(newConflicts.map((item) => [item.id, item]));
      this.conflicts.push(...deduped.values());
      return jsonResponse(200, {
        ok: true,
        applied,
        duplicates,
        conflicts: [...deduped.values()],
        warnings: [],
        nextCursor: String(this.seq),
        latestCursor: String(this.seq),
        serverTime: new Date(this.now()).toISOString(),
      });
    }

    if (path === '/sync/pull' && method === 'GET') {
      const cursor = Number(url.searchParams.get('cursor') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '200');
      const candidates = this.ops.filter((op) => Number(op.cursor) > cursor);
      const page = candidates.slice(0, limit);
      const nextCursor = page.length ? page[page.length - 1]!.cursor : String(cursor);
      const newConflicts = this.conflicts.filter(
        (item) => Number(item.cursor) > cursor && Number(item.cursor) <= Number(nextCursor),
      );
      return jsonResponse(200, {
        ok: true,
        ops: page,
        nextCursor,
        latestCursor: String(this.seq),
        hasMore: candidates.length > limit,
        conflicts: newConflicts,
        serverTime: new Date(this.now()).toISOString(),
      });
    }

    if (path === '/sync/status' && method === 'GET') {
      const status: SyncStatusResponse = {
        ok: true,
        device: {
          id: device.id,
          name: device.name,
          platform: device.platform,
          pairedAt: new Date(this.now()).toISOString(),
          lastSeenAt: new Date(this.now()).toISOString(),
          accessExpiresAt: new Date(this.now() + 86_400_000).toISOString(),
        },
        spaceId: 'personal',
        cursor: '0',
        latestCursor: String(this.seq),
        appliedOps: this.ops.length,
        lastPullAt: null,
        lastPushAt: null,
        entityCounts: {},
        unresolvedConflicts: this.conflicts.length,
        conflicts: this.conflicts.slice(-20),
        storage: {
          configured: true,
          bucket: 'fake',
          driver: 'minio',
          lastError: null,
        },
        serverTime: new Date(this.now()).toISOString(),
      };
      return jsonResponse(200, status);
    }

    return errorResponse(404, 'NOT_FOUND', `未找到 ${path}`);
  };
}

function sharedClock() {
  let current = 1_700_000_000_000;
  return {
    now: () => {
      current += 10;
      return current;
    },
  };
}

async function pairedEngine(
  backend: FakeBackend,
  now: () => number,
  name: string,
): Promise<{ engine: SyncEngine; store: MemorySyncStore; profile: SyncDeviceProfile }> {
  const store = new MemorySyncStore();
  const engine = new SyncEngine({ store, fetchImpl: backend.fetch, now });
  const profile = await engine.pair({
    baseUrl: 'http://server.test',
    code: 'ZX-TEST-CODE',
    name,
    platform: 'macos',
  });
  return { engine, store, profile };
}

describe('SyncEngine 配对与 outbox', () => {
  it('配对后持久化 profile，未配对时禁止入队', async () => {
    const clock = sharedClock();
    const backend = new FakeBackend(clock.now);
    const store = new MemorySyncStore();
    const engine = new SyncEngine({ store, fetchImpl: backend.fetch, now: clock.now });

    await expect(
      engine.enqueue({ entityType: 'task', entityId: 't1', payload: { title: 'x' } }),
    ).rejects.toBeInstanceOf(SyncEngineError);

    const profile = await engine.pair({
      baseUrl: 'http://server.test/',
      code: 'ZX-TEST-CODE',
      name: 'MacBook',
      platform: 'macos',
    });
    expect(profile.deviceId).toBe('dev_fake_1');
    expect(profile.baseUrl).toBe('http://server.test');
    expect(profile.lastPullCursor).toBe('0');
    expect(await store.loadProfile()).toMatchObject({ deviceId: 'dev_fake_1' });

    const status = await engine.status();
    expect(status).toMatchObject({ paired: true, outbox: 0, authPaused: false });
  });

  it('非法 payload 被拒绝，不写 outbox', async () => {
    const clock = sharedClock();
    const backend = new FakeBackend(clock.now);
    const { engine, store } = await pairedEngine(backend, clock.now, 'Mac');
    await expect(
      engine.enqueue({
        entityType: 'task',
        entityId: 't1',
        payload: JSON.parse('{"__proto__":{"bad":true}}'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(await store.listOutbox()).toHaveLength(0);
  });
});

describe('SyncEngine 多端合并', () => {
  it('两台客户端改同一任务不同字段→合并为同一实体', async () => {
    const clock = sharedClock();
    const backend = new FakeBackend(clock.now);
    const a = await pairedEngine(backend, clock.now, '设备 A');
    const b = await pairedEngine(backend, clock.now, '设备 B');

    await a.engine.enqueue({
      entityType: 'task',
      entityId: 'task-1',
      payload: { title: '写周报', status: 'todo' },
    });
    const aFirst = await a.engine.sync();
    expect(aFirst).toMatchObject({ ok: true, pushed: 1, outbox: 0 });

    const bPull = await b.engine.sync();
    expect(bPull.pulled).toBe(1);
    expect((await b.store.getEntity('task', 'task-1'))?.fields.title).toBe('写周报');

    await b.engine.enqueue({
      entityType: 'task',
      entityId: 'task-1',
      payload: { due_date: '2026-10-30' },
    });
    await b.engine.sync();
    await a.engine.sync();

    const fromA = await a.store.getEntity('task', 'task-1');
    const fromB = await b.store.getEntity('task', 'task-1');
    expect(fromA?.fields).toMatchObject({
      title: '写周报',
      status: 'todo',
      due_date: '2026-10-30',
    });
    expect(fromB?.fields).toEqual(fromA?.fields);
  });

  it('两台客户端并发改正文→主正文保留赢家，落败正文进入可见冲突副本', async () => {
    const clock = sharedClock();
    const backend = new FakeBackend(clock.now);
    const a = await pairedEngine(backend, clock.now, '设备 A');
    const b = await pairedEngine(backend, clock.now, '设备 B');

    await a.engine.enqueue({
      entityType: 'note',
      entityId: 'note-1',
      payload: { title: '会议记录', body: '原始正文', status: 'active' },
    });
    await a.engine.sync();
    await b.engine.sync();

    await a.engine.enqueue({
      entityType: 'note',
      entityId: 'note-1',
      payload: { body: 'A 的新正文' },
    });
    await b.engine.enqueue({
      entityType: 'note',
      entityId: 'note-1',
      payload: { body: 'B 的新正文' },
    });

    await a.engine.sync();
    const bRun = await b.engine.sync();
    expect(bRun.ok).toBe(true);
    expect(bRun.conflicts.some((item) => item.kind === 'body_concurrent')).toBe(true);
    const copyId = bRun.conflicts.find((item) => item.kind === 'body_concurrent')!
      .copyEntityId!;
    expect(copyId).toContain('conflict');

    await a.engine.sync();

    for (const side of [a, b]) {
      const main = await side.store.getEntity('note', 'note-1');
      const copy = await side.store.getEntity('note', copyId);
      expect(main?.fields.body).toBe('B 的新正文');
      expect(copy?.fields.body).toBe('A 的新正文');
      expect(copy?.fields.title).toContain('冲突副本');
      expect(copy?.fields.conflict_of).toBe('note-1');
      const conflicts = await side.engine.listConflicts();
      expect(conflicts.some((item) => item.kind === 'body_concurrent')).toBe(true);
    }

    const notes = await a.engine.listEntities('note');
    expect(notes).toHaveLength(2);
    expect(notes.map((note) => note.entityId)).toContain(copyId);
  });
});

describe('SyncEngine 离线、幂等与令牌刷新', () => {
  it('断网时保留 outbox，恢复后补传且重复同步不重复写入', async () => {
    const clock = sharedClock();
    const backend = new FakeBackend(clock.now);
    const a = await pairedEngine(backend, clock.now, '设备 A');

    backend.offline = true;
    await a.engine.enqueue({
      entityType: 'task',
      entityId: 'task-offline',
      payload: { title: '断网期间的新任务' },
    });
    const offlineRun = await a.engine.sync();
    expect(offlineRun).toMatchObject({
      ok: false,
      online: false,
      pushed: 0,
      outbox: 1,
    });
    expect(offlineRun.error).toContain('offline');
    expect(backend.ops).toHaveLength(0);

    backend.offline = false;
    const recovered = await a.engine.sync({ force: true });
    expect(recovered).toMatchObject({ ok: true, online: true, pushed: 1, outbox: 0 });
    expect(backend.ops).toHaveLength(1);

    const again = await a.engine.sync({ force: true });
    expect(again.pushed).toBe(0);
    expect(backend.ops).toHaveLength(1);
    const entity = await a.store.getEntity('task', 'task-offline');
    expect(entity?.version).toBe(1);
  });

  it('访问令牌过期时自动用 refresh token 轮换并重试', async () => {
    const clock = sharedClock();
    const backend = new FakeBackend(clock.now);
    const a = await pairedEngine(backend, clock.now, '设备 A');
    await a.engine.sync();
    backend.expireAccess(a.profile.deviceId);

    const run = await a.engine.sync({ force: true });
    expect(run).toMatchObject({ ok: true, authPaused: false });
    expect(backend.refreshCalls).toBe(1);
    const profile = await a.store.loadProfile();
    expect(profile?.deviceToken).toContain('_r1');

    const status = await a.engine.status({ includeRemote: true });
    expect(status.remoteStatus?.ok).toBe(true);
  });

  it('直接调用 HTTP 客户端重复 push 同一 op_id，服务端只应用一次', async () => {
    const clock = sharedClock();
    const backend = new FakeBackend(clock.now);
    const a = await pairedEngine(backend, clock.now, '设备 A');
    const client = new SyncHttpClient({ baseUrl: 'http://server.test', fetchImpl: backend.fetch });
    const op: SyncOp = {
      op_id: 'op-client-dup-1',
      space_id: 'personal',
      device_id: a.profile.deviceId,
      entity_type: 'task',
      entity_id: 'task-dup',
      op_type: 'upsert',
      hlc: { ms: clock.now(), c: 0, d: a.profile.deviceId },
      base_vv: {},
      payload: { title: '一次' },
    };
    const first = await client.push(a.profile, [op]);
    const second = await client.push(a.profile, [op]);
    expect(first.applied).toHaveLength(1);
    expect(second.applied).toHaveLength(0);
    expect(second.duplicates).toHaveLength(1);
    expect(backend.ops.filter((item) => item.op_id === op.op_id)).toHaveLength(1);
  });
});

describe('LocalStorageSyncStore', () => {
  it('同一 storage 上重建 store 仍能读到 profile、实体与 outbox', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    };
    const store = new LocalStorageSyncStore(storage);
    await store.saveProfile({
      baseUrl: 'http://server.test',
      spaceId: 'personal',
      deviceId: 'dev_1',
      deviceName: 'Mac',
      platform: 'macos',
      deviceToken: 'zxdt_x',
      refreshToken: 'zxrt_y',
      accessExpiresAt: new Date(0).toISOString(),
      refreshExpiresAt: new Date(0).toISOString(),
      features: {},
      lastPullCursor: '0',
      lastSyncAt: null,
      lastError: null,
    });
    await store.putEntity({
      spaceId: 'personal',
      entityType: 'task',
      entityId: 't1',
      fields: { title: '持久化' },
      fieldClocks: {},
      fieldVvs: {},
      vv: {},
      deleted: false,
      hlc: null,
      version: 1,
    });
    await store.putOutbox({
      op: {
        op_id: 'op-persist-1',
        space_id: 'personal',
        device_id: 'dev_1',
        entity_type: 'task',
        entity_id: 't1',
        op_type: 'upsert',
        hlc: { ms: 1, c: 0, d: 'dev_1' },
        base_vv: {},
        payload: { title: '持久化' },
      },
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    });

    const reopened = new LocalStorageSyncStore(storage);
    expect((await reopened.loadProfile())?.deviceId).toBe('dev_1');
    expect((await reopened.getEntity('task', 't1'))?.fields.title).toBe('持久化');
    expect(await reopened.listOutbox()).toHaveLength(1);
  });
});
