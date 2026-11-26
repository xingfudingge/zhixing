/**
 * P2-01 端到端验收脚本。
 *
 * 需要：Fastify 服务已启动（localhost:8787）、PostgreSQL 可连、MinIO 可用。
 * 覆盖：
 *   1. 健康检查
 *   2. 两台客户端配对
 *   3. 同一任务不同字段合并
 *   4. 同一正文并发 → 冲突副本可见且只有一份
 *   5. 重复 operation_id 不重复写入
 *   6. 断网修改 → 恢复后补传
 *   7. 数据库无 users/accounts/memberships/seats 表
 *   8. 附件预签名上传 → 服务端哈希校验 → 下载内容一致
 */
import { createHash } from 'node:crypto';

import pg from 'pg';

import type { FetchLike } from '../../app/src/sync/client.ts';
import { SyncEngine } from '../../app/src/sync/engine.ts';
import { MemorySyncStore } from '../../app/src/sync/store.ts';
import type { SyncDeviceProfile } from '../../app/src/sync/types.ts';

const BASE_URL = (process.env.ZX_ACCEPTANCE_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const SETUP_TOKEN = process.env.ZX_SETUP_TOKEN ?? 'dev-setup-token';
const PASSPHRASE = process.env.ZX_ACCEPTANCE_PASSPHRASE ?? 'acceptance-pass-123';
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const SUFFIX = Date.now().toString(36);

type Json = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`验收失败：${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const realFetch: FetchLike = (input, init) => fetch(input, init);

async function api<T extends Json>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    adminToken?: string;
    device?: SyncDeviceProfile;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.adminToken) headers.authorization = `Bearer ${options.adminToken}`;
  if (options.device) {
    headers.authorization = `Bearer ${options.device.deviceToken}`;
    headers['x-zx-device'] = options.device.deviceId;
  }
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as Json) : {};
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} → ${response.status} ${text}`);
  }
  return body as T;
}

async function ensureAdmin(): Promise<string> {
  const health = await api<{ ok: boolean; initialized: boolean }>('/api/v1/health');
  assert(health.ok, 'health.ok 必须为 true');
  if (!health.initialized) {
    const setup = await api<{ adminToken: string }>('/api/v1/setup', {
      method: 'POST',
      body: { setupToken: SETUP_TOKEN, passphrase: PASSPHRASE, name: '知行验收部署' },
    });
    return setup.adminToken;
  }
  const login = await api<{ adminToken: string }>('/api/v1/auth/login', {
    method: 'POST',
    body: { passphrase: PASSPHRASE },
  });
  return login.adminToken;
}

async function createPairCode(adminToken: string, label: string): Promise<string> {
  const result = await api<{ code: string }>('/api/v1/devices/pair-code', {
    method: 'POST',
    adminToken,
    body: { label },
  });
  return result.code;
}

type Client = {
  engine: SyncEngine;
  store: MemorySyncStore;
  profile: SyncDeviceProfile;
};

async function pairClient(
  adminToken: string,
  name: string,
  fetchImpl: FetchLike = realFetch,
): Promise<Client> {
  const code = await createPairCode(adminToken, name);
  const store = new MemorySyncStore();
  const engine = new SyncEngine({ store, fetchImpl });
  const profile = await engine.pair({
    baseUrl: BASE_URL,
    code,
    name,
    platform: 'macos',
  });
  return { engine, store, profile };
}

async function main(): Promise<void> {
  const summary: Record<string, unknown> = {
    baseUrl: BASE_URL,
    suffix: SUFFIX,
  };

  const health = await api<{
    ok: boolean;
    database: { ok: boolean };
    storage: { configured: boolean; bucket: string };
    features: { backendSync: boolean; webdav: boolean };
  }>('/api/v1/health');
  summary.health = health;

  const adminToken = await ensureAdmin();
  summary.admin = 'ok';

  const clientA = await pairClient(adminToken, `验收设备 A ${SUFFIX}`);
  const clientB = await pairClient(adminToken, `验收设备 B ${SUFFIX}`);
  summary.pairedDevices = [clientA.profile.deviceId, clientB.profile.deviceId];

  // 1) 同一任务不同字段 → 合并
  const taskId = `task-${SUFFIX}`;
  await clientA.engine.enqueue({
    entityType: 'task',
    entityId: taskId,
    payload: { title: '后台同步验收任务', status: 'todo' },
  });
  const runA1 = await clientA.engine.sync();
  assert(runA1.ok, `设备 A 首次同步失败：${runA1.error ?? ''}`);
  await clientB.engine.sync();
  await clientB.engine.enqueue({
    entityType: 'task',
    entityId: taskId,
    payload: { due_date: '2026-11-11' },
  });
  const runB1 = await clientB.engine.sync();
  assert(runB1.ok, `设备 B 同步失败：${runB1.error ?? ''}`);
  await clientA.engine.sync();
  const taskA = (await clientA.engine.listEntities('task')).find(
    (entity) => entity.entityId === taskId,
  );
  const taskB = (await clientB.engine.listEntities('task')).find(
    (entity) => entity.entityId === taskId,
  );
  assert(taskA?.fields.title === '后台同步验收任务', 'A 端标题丢失');
  assert(taskA?.fields.due_date === '2026-11-11', '不同字段未合并（A 端）');
  assert(taskB?.fields.title === '后台同步验收任务', 'B 端标题丢失');
  summary.differentFieldsMerge = {
    title: taskA.fields.title,
    dueDate: taskA.fields.due_date,
    version: taskA.version,
  };

  // 2) 同一正文并发 → 冲突副本
  const noteId = `note-${SUFFIX}`;
  await clientA.engine.enqueue({
    entityType: 'note',
    entityId: noteId,
    payload: { title: '验收笔记', body: '原始正文', status: 'active' },
  });
  await clientA.engine.sync();
  await clientB.engine.sync();

  await clientA.engine.enqueue({
    entityType: 'note',
    entityId: noteId,
    payload: { body: 'A 的正文' },
  });
  await sleep(5);
  await clientB.engine.enqueue({
    entityType: 'note',
    entityId: noteId,
    payload: { body: 'B 的正文' },
  });
  await clientA.engine.sync();
  const runBody = await clientB.engine.sync();
  assert(runBody.ok, `正文冲突同步失败：${runBody.error ?? ''}`);
  await clientA.engine.sync();

  const conflicts = await clientB.engine.listConflicts();
  assert(
    conflicts.some((conflict) => conflict.kind === 'body_concurrent'),
    '服务端未记录正文冲突',
  );
  const notesA = await clientA.engine.listEntities('note');
  const main = notesA.find((entity) => entity.entityId === noteId);
  const copies = notesA.filter(
    (entity) => entity.fields.conflict_of === noteId && !entity.deleted,
  );
  assert(main, '主笔记不存在');
  assert(copies.length === 1, `冲突副本数量应为 1，实际 ${copies.length}`);
  const copy = copies[0]!;
  const bodies = [String(main.fields.body), String(copy.fields.body)].sort();
  assert(
    bodies[0] === 'A 的正文' && bodies[1] === 'B 的正文',
    `主正文与副本正文必须都保留，实际 ${JSON.stringify(bodies)}`,
  );
  assert(String(copy.fields.title).includes('冲突副本'), '冲突副本标题缺少标记');
  summary.bodyConflict = {
    mainBody: main.fields.body,
    copyId: copy.entityId,
    copyBody: copy.fields.body,
    conflictKind: conflicts.find((item) => item.kind === 'body_concurrent')?.kind,
  };

  // 3) 重复 operation_id
  const dupOpId = `accept-dup-${SUFFIX}`;
  const dupEntityId = `task-dup-${SUFFIX}`;
  const op = {
    op_id: dupOpId,
    space_id: 'personal',
    device_id: clientA.profile.deviceId,
    entity_type: 'task',
    entity_id: dupEntityId,
    op_type: 'upsert',
    hlc: { ms: Date.now(), c: 0, d: clientA.profile.deviceId },
    base_vv: {},
    payload: { title: '重复 op 只写一次' },
    created_at: new Date().toISOString(),
  };
  const firstPush = await api<{ applied: unknown[]; duplicates: unknown[] }>('/api/v1/sync/push', {
    method: 'POST',
    device: clientA.profile,
    body: { ops: [op] },
  });
  const secondPush = await api<{ applied: unknown[]; duplicates: unknown[] }>('/api/v1/sync/push', {
    method: 'POST',
    device: clientA.profile,
    body: { ops: [op] },
  });
  assert(firstPush.applied.length === 1, '首次 push 应写入一条');
  assert(secondPush.applied.length === 0 && secondPush.duplicates.length === 1, '重复 op_id 必须幂等');
  const dupEntity = await api<{ entity: { version: number; fields: Json } }>(
    `/api/v1/sync/entity/task/${dupEntityId}`,
    { device: clientA.profile },
  );
  assert(dupEntity.entity.version === 1, '重复 op 导致版本号重复递增');
  summary.duplicateOperation = {
    opId: dupOpId,
    appliedFirst: firstPush.applied.length,
    appliedSecond: secondPush.applied.length,
    duplicatesSecond: secondPush.duplicates.length,
    entityVersion: dupEntity.entity.version,
  };

  // 4) 断网修改 → 恢复同步
  let offline = false;
  const flakyFetch: FetchLike = (input, init) =>
    offline ? Promise.reject(new TypeError('simulated offline')) : fetch(input, init);
  const clientC = await pairClient(adminToken, `验收设备 C ${SUFFIX}`, flakyFetch);
  const offlineTaskId = `task-offline-${SUFFIX}`;
  offline = true;
  await clientC.engine.enqueue({
    entityType: 'task',
    entityId: offlineTaskId,
    payload: { title: '断网期间创建' },
  });
  const offlineRun = await clientC.engine.sync({ force: true });
  assert(!offlineRun.ok && !offlineRun.online, '断网同步应失败且标记离线');
  assert(offlineRun.outbox === 1, '断网时 outbox 应保留 1 条');
  offline = false;
  const recovered = await clientC.engine.sync({ force: true });
  assert(recovered.ok && recovered.outbox === 0, '恢复网络后 outbox 应清空');
  await clientA.engine.sync();
  const offlineTask = (await clientA.engine.listEntities('task')).find(
    (entity) => entity.entityId === offlineTaskId,
  );
  assert(offlineTask?.fields.title === '断网期间创建', '另一设备未收到断网期间的修改');
  summary.offlineResume = {
    offlineOutbox: offlineRun.outbox,
    recoveredPushed: recovered.pushed,
    otherDeviceSawIt: true,
  };

  // 5) 数据库无 users / accounts / memberships / seats
  if (DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      const result = await pool.query<{
        users: string | null;
        accounts: string | null;
        memberships: string | null;
        seats: string | null;
      }>(`SELECT
           to_regclass('public.users')::text AS users,
           to_regclass('public.accounts')::text AS accounts,
           to_regclass('public.memberships')::text AS memberships,
           to_regclass('public.seats')::text AS seats`);
      const row = result.rows[0]!;
      assert(
        row.users === null && row.accounts === null && row.memberships === null && row.seats === null,
        `数据库出现账号/席位表：${JSON.stringify(row)}`,
      );
      summary.noUsersTable = row;
    } finally {
      await pool.end();
    }
  } else {
    summary.noUsersTable = 'skipped（未设置 DATABASE_URL）';
  }

  // 6) MinIO 附件：预签名上传 → 哈希校验 → 下载
  const content = Buffer.from(`知行附件验收 ${SUFFIX}`);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const init = await api<{
    attachment: { id: string; status: string; sha256: string };
    uploadUrl: string;
  }>('/api/v1/attachments/init', {
    method: 'POST',
    device: clientA.profile,
    body: {
      fileName: `acceptance-${SUFFIX}.txt`,
      sha256,
      byteSize: content.byteLength,
      mime: 'text/plain',
    },
  });
  assert(init.uploadUrl.includes('X-Amz-Signature'), '缺少预签名上传 URL');
  const upload = await fetch(init.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: new Uint8Array(content),
  });
  assert(upload.ok, `MinIO 上传失败：${upload.status} ${await upload.text()}`);
  const completed = await api<{ attachment: { status: string } }>(
    `/api/v1/attachments/${init.attachment.id}/complete`,
    { method: 'POST', device: clientA.profile },
  );
  assert(completed.attachment.status === 'available', '附件完成校验后应为 available');
  const download = await api<{ downloadUrl: string }>(
    `/api/v1/attachments/${init.attachment.id}/download`,
    { device: clientA.profile },
  );
  const downloaded = Buffer.from(await (await fetch(download.downloadUrl)).arrayBuffer());
  const downloadedHash = createHash('sha256').update(downloaded).digest('hex');
  assert(downloadedHash === sha256, '下载内容哈希不一致');
  summary.attachment = {
    id: init.attachment.id,
    sha256,
    bytes: downloaded.byteLength,
    status: completed.attachment.status,
    hashVerified: true,
  };

  // 清理设备（撤销不删除数据），避免重复验收累积有效设备
  for (const client of [clientA, clientB, clientC]) {
    await api(`/api/v1/devices/${client.profile.deviceId}`, {
      method: 'DELETE',
      adminToken,
    }).catch(() => undefined);
  }

  console.log(JSON.stringify({ ok: true, acceptance: summary }, null, 2));
  console.log('\nACCEPTANCE OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
