import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  deviceHeaders,
  integrationEnabled,
  makeOp,
  pairTestDevice,
  createTestContext,
  type PairedTestDevice,
  type TestContext,
} from '../helpers/test-env.ts';
import type { FastifyInstance } from 'fastify';

const suite = integrationEnabled ? describe : describe.skip;

suite('backend sync API（真实 PostgreSQL 16）', () => {
  let ctx: TestContext;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  beforeEach(async () => {
    await ctx.reset();
    adminToken = await ctx.setup();
  });

  async function push(
    app: FastifyInstance,
    device: PairedTestDevice,
    ops: unknown[],
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: deviceHeaders(device),
      payload: { ops },
    });
  }

  async function getEntity(
    app: FastifyInstance,
    device: PairedTestDevice,
    type: string,
    id: string,
  ) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/sync/entity/${type}/${encodeURIComponent(id)}`,
      headers: deviceHeaders(device),
    });
  }

  it('健康检查、发现接口与无 users 表', async () => {
    await ctx.pool.query(
      `UPDATE deployment SET initialized_at = NULL, passphrase_hash = NULL`,
    );

    const health = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.statusCode).toBe(200);
    const body = health.json();
    expect(body).toMatchObject({
      ok: true,
      apiVersion: '1',
      database: { ok: true },
      initialized: false,
      features: { backendSync: true, webdav: false },
    });

    const discovery = await ctx.app.inject({
      method: 'GET',
      url: '/.well-known/zhixing',
    });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toMatchObject({
      apiVersion: '1',
      deploymentId: 'default',
      features: { backendSync: true, webdav: false },
    });

    const tables = await ctx.pool.query<{
      users: string | null;
      accounts: string | null;
      memberships: string | null;
      seats: string | null;
    }>(`SELECT
         to_regclass('public.users')::text AS users,
         to_regclass('public.accounts')::text AS accounts,
         to_regclass('public.memberships')::text AS memberships,
         to_regclass('public.seats')::text AS seats`);
    expect(tables.rows[0]).toEqual({
      users: null,
      accounts: null,
      memberships: null,
      seats: null,
    });
  });

  it('setup 一次性、口令登录、错误口令被拒绝', async () => {
    await ctx.reset();
    const wrongToken = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { setupToken: 'wrong', passphrase: 'long-enough-pass' },
      remoteAddress: '127.0.0.1',
    });
    expect(wrongToken.statusCode).toBe(401);

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: {
        setupToken: 'test-setup-token',
        passphrase: 'owner-pass-123',
        name: '我的知行',
      },
      remoteAddress: '127.0.0.1',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().adminToken).toMatch(/^zxas_/);
    expect(first.headers['set-cookie']).toContain('zx_session=');

    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { setupToken: 'test-setup-token', passphrase: 'owner-pass-123' },
      remoteAddress: '127.0.0.1',
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('ALREADY_INITIALIZED');

    const wrongLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { passphrase: 'not-the-passphrase' },
    });
    expect(wrongLogin.statusCode).toBe(401);

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { passphrase: 'owner-pass-123' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().adminToken).toMatch(/^zxas_/);

    const status = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/status',
      headers: { authorization: `Bearer ${login.json().adminToken}` },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().initialized).toBe(true);
  });

  it('配对码一次性、过期拒绝，两台设备可同时配对', async () => {
    const codeResponse = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair-code',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { label: 'MacBook' },
    });
    expect(codeResponse.statusCode).toBe(200);
    const code = codeResponse.json().code as string;
    expect(code).toMatch(/^ZX-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const firstPair = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { code, name: 'MacBook', platform: 'macos' },
    });
    expect(firstPair.statusCode).toBe(200);
    expect(firstPair.json().deviceToken).toMatch(/^zxdt_/);
    expect(firstPair.json().features).toMatchObject({ sync: true });

    const reuse = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { code, name: '重复使用', platform: 'windows' },
    });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error.code).toBe('PAIRING_CODE_USED');

    const expiredCodeResponse = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair-code',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { label: '过期码' },
    });
    const expiredCode = expiredCodeResponse.json().code as string;
    await ctx.pool.query(
      `UPDATE pairing_codes SET expires_at = now() - interval '1 minute'
        WHERE used_at IS NULL`,
    );
    const expired = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { code: expiredCode, name: '过期设备', platform: 'linux' },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.code).toBe('PAIRING_CODE_EXPIRED');

    const phone = await pairTestDevice(ctx.app, adminToken, '手机', 'web');
    const devices = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(devices.statusCode).toBe(200);
    expect(devices.json().devices).toHaveLength(2);
    const serialized = JSON.stringify(devices.json());
    expect(serialized).not.toContain(phone.token);
    expect(serialized).not.toContain('token_hash');
  });

  it('两台设备改同一任务不同字段→字段合并', async () => {
    const deviceA = await pairTestDevice(ctx.app, adminToken, '设备 A');
    const deviceB = await pairTestDevice(ctx.app, adminToken, '设备 B');

    const create = await push(ctx.app, deviceA, [
      makeOp(deviceA, {
        op_id: 'op-a-task-create',
        ms: 1000,
        payload: { title: '写周报', status: 'todo', priority: 1 },
      }),
    ]);
    expect(create.statusCode).toBe(200);

    const fromB = await push(ctx.app, deviceB, [
      makeOp(deviceB, {
        op_id: 'op-b-task-fields',
        ms: 2000,
        base_vv: { [deviceA.id]: 1 },
        op_type: 'patch',
        payload: { due_date: '2026-10-30', priority: 3 },
      }),
    ]);
    expect(fromB.statusCode).toBe(200);
    expect(fromB.json().conflicts).toHaveLength(0);

    const merged = await getEntity(ctx.app, deviceA, 'task', 'task-1');
    expect(merged.statusCode).toBe(200);
    const entity = merged.json().entity;
    expect(entity.fields).toMatchObject({
      title: '写周报',
      status: 'todo',
      due_date: '2026-10-30',
      priority: 3,
    });
    expect(entity.version).toBe(2);

    const pullA = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/sync/pull?cursor=0&limit=50',
      headers: deviceHeaders(deviceA),
    });
    expect(pullA.statusCode).toBe(200);
    expect(pullA.json().ops.map((op: { op_id: string }) => op.op_id)).toEqual([
      'op-a-task-create',
      'op-b-task-fields',
    ]);
  });

  it('并发改同一正文→冲突副本可见，正文不被静默覆盖', async () => {
    const deviceA = await pairTestDevice(ctx.app, adminToken, '设备 A');
    const deviceB = await pairTestDevice(ctx.app, adminToken, '设备 B');

    await push(ctx.app, deviceA, [
      makeOp(deviceA, {
        op_id: 'op-a-note-create',
        entity_type: 'note',
        entity_id: 'note-1',
        ms: 1000,
        payload: { title: '会议记录', body: '原始正文', status: 'active' },
      }),
    ]);
    await push(ctx.app, deviceA, [
      makeOp(deviceA, {
        op_id: 'op-a-note-body',
        entity_type: 'note',
        entity_id: 'note-1',
        ms: 2000,
        base_vv: { [deviceA.id]: 1 },
        payload: { body: 'A 的新正文' },
      }),
    ]);

    const conflictPush = await push(ctx.app, deviceB, [
      makeOp(deviceB, {
        op_id: 'op-b-note-body',
        entity_type: 'note',
        entity_id: 'note-1',
        ms: 2100,
        base_vv: { [deviceA.id]: 1 },
        payload: { body: 'B 的新正文' },
      }),
    ]);
    expect(conflictPush.statusCode).toBe(200);
    const conflicts = conflictPush.json().conflicts as Array<{
      kind: string;
      field: string;
      copyEntityId: string;
      winner: string;
    }>;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      kind: 'body_concurrent',
      field: 'body',
      winner: 'incoming',
    });
    const copyId = conflicts[0]!.copyEntityId;
    expect(copyId).toContain('conflict');

    const main = await getEntity(ctx.app, deviceA, 'note', 'note-1');
    expect(main.json().entity.fields.body).toBe('B 的新正文');

    const copy = await getEntity(ctx.app, deviceA, 'note', copyId);
    expect(copy.statusCode).toBe(200);
    expect(copy.json().entity.fields.body).toBe('A 的新正文');
    expect(copy.json().entity.fields.title).toContain('冲突副本');
    expect(copy.json().entity.fields.conflict_of).toBe('note-1');
    expect(copy.json().entity.fields.status).toBe('active');

    const pull = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/sync/pull?cursor=0&limit=100',
      headers: deviceHeaders(deviceA),
    });
    const body = pull.json();
    const serverCopyOp = body.ops.find(
      (op: { entity_id: string; origin: string }) =>
        op.entity_id === copyId && op.origin === 'server',
    );
    expect(serverCopyOp).toBeTruthy();
    expect(serverCopyOp.payload.body).toBe('A 的新正文');
    expect(body.conflicts[0].copyEntityId).toBe(copyId);

    const conflictList = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/sync/conflicts',
      headers: deviceHeaders(deviceB),
    });
    expect(conflictList.json().conflicts).toHaveLength(1);
  });

  it('重复 operation_id 不重复写入、不重复生成冲突副本', async () => {
    const deviceA = await pairTestDevice(ctx.app, adminToken, '设备 A');
    const deviceB = await pairTestDevice(ctx.app, adminToken, '设备 B');
    const duplicate = makeOp(deviceA, {
      op_id: 'op-duplicate-001',
      ms: 1000,
      payload: { title: '只写一次' },
    });

    const first = await push(ctx.app, deviceA, [duplicate]);
    const second = await push(ctx.app, deviceA, [duplicate]);
    expect(first.json().applied).toHaveLength(1);
    expect(second.json().applied).toHaveLength(0);
    expect(second.json().duplicates).toHaveLength(1);
    expect(second.json().duplicates[0].opId).toBe('op-duplicate-001');

    const count = await ctx.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sync_ops WHERE op_id = $1',
      ['op-duplicate-001'],
    );
    expect(count.rows[0]!.count).toBe('1');
    const entity = await getEntity(ctx.app, deviceA, 'task', 'task-1');
    expect(entity.json().entity.version).toBe(1);

    // 同一批次内重复 op 也只写一次
    const batch = await push(ctx.app, deviceB, [
      makeOp(deviceB, {
        op_id: 'op-batch-dup-1',
        entity_type: 'note',
        entity_id: 'note-dup',
        ms: 2000,
        payload: { body: '一次' },
      }),
      makeOp(deviceB, {
        op_id: 'op-batch-dup-1',
        entity_type: 'note',
        entity_id: 'note-dup',
        ms: 2000,
        payload: { body: '一次' },
      }),
    ]);
    expect(batch.statusCode).toBe(200);
    expect(batch.json().applied).toHaveLength(1);
    expect(batch.json().duplicates).toHaveLength(1);
    const ops = await ctx.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sync_ops WHERE op_id = $1',
      ['op-batch-dup-1'],
    );
    expect(ops.rows[0]!.count).toBe('1');
  });

  it('游标增量拉取：断网期间的 op 恢复后按 cursor 补齐', async () => {
    const deviceA = await pairTestDevice(ctx.app, adminToken, '设备 A');

    await push(ctx.app, deviceA, [
      makeOp(deviceA, { op_id: 'op-cursor-1', ms: 1000, payload: { title: '第一条' } }),
    ]);
    const firstPull = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/sync/pull?cursor=0&limit=1',
      headers: deviceHeaders(deviceA),
    });
    const firstBody = firstPull.json();
    expect(firstBody.ops).toHaveLength(1);
    expect(firstBody.hasMore).toBe(false);
    const cursor = firstBody.nextCursor;
    expect(cursor).not.toBe('0');

    // 模拟断网期间本地继续写入；恢复后服务端已多出一条 op。
    await push(ctx.app, deviceA, [
      makeOp(deviceA, {
        op_id: 'op-cursor-2',
        ms: 2000,
        base_vv: { [deviceA.id]: 1 },
        op_type: 'patch',
        payload: { due_date: '2026-11-01' },
      }),
    ]);
    const secondPull = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/sync/pull?cursor=${cursor}&limit=10`,
      headers: deviceHeaders(deviceA),
    });
    const secondBody = secondPull.json();
    expect(secondBody.ops.map((op: { op_id: string }) => op.op_id)).toEqual([
      'op-cursor-2',
    ]);
    expect(secondBody.nextCursor).not.toBe(cursor);

    const thirdPull = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/sync/pull?cursor=${secondBody.nextCursor}&limit=10`,
      headers: deviceHeaders(deviceA),
    });
    expect(thirdPull.json().ops).toHaveLength(0);

    const status = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/sync/status',
      headers: deviceHeaders(deviceA),
    });
    const statusBody = status.json();
    expect(statusBody.cursor).toBe(secondBody.nextCursor);
    expect(statusBody.appliedOps).toBe(2);
    expect(statusBody.latestCursor).toBe(secondBody.nextCursor);
    expect(statusBody.device.id).toBe(deviceA.id);
    expect(statusBody.storage).toMatchObject({
      configured: true,
      bucket: 'zhixing-test',
    });
  });

  it('撤销设备后令牌立即失效', async () => {
    const deviceA = await pairTestDevice(ctx.app, adminToken, '设备 A');
    const deviceB = await pairTestDevice(ctx.app, adminToken, '设备 B');

    const revoke = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${deviceB.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().device.revokedAt).toBeTruthy();

    const rejected = await push(ctx.app, deviceB, [
      makeOp(deviceB, { op_id: 'op-revoked-1', payload: { title: '不应写入' } }),
    ]);
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().error.code).toBe('DEVICE_REVOKED');

    const stillWorks = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/sync/status',
      headers: deviceHeaders(deviceA),
    });
    expect(stillWorks.statusCode).toBe(200);
  });

  it('刷新令牌轮换后旧令牌失效', async () => {
    const device = await pairTestDevice(ctx.app, adminToken, '设备 A');
    const refresh = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/devices/refresh',
      payload: { refreshToken: device.refreshToken },
    });
    expect(refresh.statusCode).toBe(200);
    const rotated = refresh.json();
    expect(rotated.deviceToken).not.toBe(device.token);

    const oldToken = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/sync/status',
      headers: deviceHeaders(device),
    });
    expect(oldToken.statusCode).toBe(401);
    expect(oldToken.json().error.code).toBe('DEVICE_TOKEN_INVALID');

    const newToken = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/sync/status',
      headers: {
        'x-zx-device': device.id,
        authorization: `Bearer ${rotated.deviceToken}`,
      },
    });
    expect(newToken.statusCode).toBe(200);
  });

  it('附件元数据写入 PostgreSQL，上传 URL 由 MinIO 预签名生成', async () => {
    const device = await pairTestDevice(ctx.app, adminToken, '设备 A');
    const sha256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    const init = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/attachments/init',
      headers: deviceHeaders(device),
      payload: {
        fileName: 'hello.txt',
        sha256,
        byteSize: 5,
        mime: 'text/plain',
        noteId: 'note-1',
      },
    });
    expect(init.statusCode).toBe(200);
    const body = init.json();
    expect(body.attachment).toMatchObject({
      fileName: 'hello.txt',
      sha256,
      byteSize: 5,
      status: 'pending',
      storageKey: `spaces/personal/assets/${sha256}`,
    });
    expect(body.uploadUrl).toContain('X-Amz-Signature');
    expect(body.uploadUrl).toContain(`zhixing-test/spaces/personal/assets/${sha256}`);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/attachments?noteId=note-1',
      headers: deviceHeaders(device),
    });
    expect(list.json().attachments).toHaveLength(1);

    const download = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${body.attachment.id}/download`,
      headers: deviceHeaders(device),
    });
    expect(download.statusCode).toBe(409);
    expect(download.json().error.code).toBe('ATTACHMENT_NOT_READY');
  });

  it('设备鉴权、op 校验与限流失败路径', async () => {
    const device = await pairTestDevice(ctx.app, adminToken, '设备 A');

    const anonymous = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      payload: { ops: [makeOp(device)] },
    });
    expect(anonymous.statusCode).toBe(401);

    const spoofed = await push(ctx.app, device, [
      {
        ...makeOp(device, { op_id: 'op-spoof-0001' }),
        device_id: 'dev_someone_else',
      },
    ]);
    expect(spoofed.statusCode).toBe(403);
    expect(spoofed.json().error.code).toBe('OP_DEVICE_MISMATCH');

    const tooMany = await push(
      ctx.app,
      device,
      Array.from({ length: 201 }, (_, index) =>
        makeOp(device, { op_id: `op-limit-${String(index).padStart(4, '0')}` }),
      ),
    );
    expect(tooMany.statusCode).toBe(400);

    const badPayload = await push(ctx.app, device, [
      {
        ...makeOp(device, { op_id: 'op-proto-0001' }),
        payload: JSON.parse('{"__proto__":{"polluted":true}}'),
      },
    ]);
    expect(badPayload.statusCode).toBe(400);
    expect(badPayload.json().error.code).toBe('BAD_REQUEST');
  });
});
