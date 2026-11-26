import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  MAX_PUSH_OPS,
  sanitizeJsonObject,
  sanitizeVv,
  validateOpEnvelope,
  type JsonObject,
  type SyncOp,
} from '../../../packages/shared/src/index.ts';
import { errors } from '../errors.ts';
import { authenticateDevice } from '../services/device-service.ts';
import { parseSpaceId, parseWith } from './validation.ts';

const pushSchema = z.object({
  ops: z.array(z.unknown()).min(1).max(MAX_PUSH_OPS),
});

const MAX_OP_PAYLOAD_BYTES = 1024 * 1024;

async function requireDevice(request: FastifyRequest, app: FastifyInstance) {
  if (request.device) return request.device;
  const device = await authenticateDevice(request, app.zx.pool);
  request.device = device;
  return device;
}

function normalizeOp(raw: unknown, deviceId: string): SyncOp {
  try {
    validateOpEnvelope(raw);
  } catch (error) {
    throw errors.badRequest((error as Error).message, {
      opId: (raw as { op_id?: string } | null)?.op_id ?? null,
    });
  }
  if (raw.device_id !== deviceId) {
    throw errors.forbidden('op.device_id 与设备令牌不匹配', 'OP_DEVICE_MISMATCH');
  }
  if (raw.hlc.d !== deviceId) {
    throw errors.badRequest('op.hlc.d 必须等于当前设备 ID', {
      opId: raw.op_id,
      expected: deviceId,
      actual: raw.hlc.d,
    });
  }
  if (raw.created_at && Number.isNaN(Date.parse(raw.created_at))) {
    throw errors.badRequest('op.created_at 不是合法时间', { opId: raw.op_id });
  }

  let payload: JsonObject;
  try {
    payload = sanitizeJsonObject(raw.payload);
  } catch (error) {
    throw errors.badRequest(`op.payload 非法: ${(error as Error).message}`, {
      opId: raw.op_id,
    });
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_OP_PAYLOAD_BYTES) {
    throw errors.payloadTooLarge(`单个 op payload 超过 ${MAX_OP_PAYLOAD_BYTES} 字节`);
  }

  return {
    op_id: raw.op_id,
    space_id: raw.space_id || 'personal',
    device_id: raw.device_id,
    entity_type: raw.entity_type,
    entity_id: raw.entity_id,
    op_type: raw.op_type,
    hlc: { ...raw.hlc },
    base_vv: sanitizeVv(raw.base_vv),
    payload,
    created_at: raw.created_at,
  };
}

export function registerSyncRoutes(app: FastifyInstance): void {
  app.post('/sync/push', async (request) => {
    const device = await requireDevice(request, app);
    const body = parseWith(pushSchema, request.body);
    const ops = body.ops.map((raw) => normalizeOp(raw, device.id));
    return app.zx.sync.push(device, ops);
  });

  app.get<{ Querystring: { cursor?: string; limit?: string; spaceId?: string } }>(
    '/sync/pull',
    async (request) => {
      const device = await requireDevice(request, app);
      const spaceId = parseSpaceId(request.query.spaceId);
      return app.zx.sync.pull(
        device,
        request.query.cursor,
        request.query.limit,
        spaceId,
      );
    },
  );

  app.get<{ Querystring: { spaceId?: string } }>('/sync/status', async (request) => {
    const device = await requireDevice(request, app);
    return app.zx.sync.status(device, parseSpaceId(request.query.spaceId));
  });

  app.get<{ Querystring: { spaceId?: string } }>('/sync/conflicts', async (request) => {
    await requireDevice(request, app);
    return {
      ok: true,
      conflicts: await app.zx.sync.listConflicts(parseSpaceId(request.query.spaceId)),
      serverTime: new Date().toISOString(),
    };
  });

  app.get<{
    Params: { entityType: string; entityId: string };
    Querystring: { spaceId?: string };
  }>('/sync/entity/:entityType/:entityId', async (request) => {
    const device = await requireDevice(request, app);
    const { entityType, entityId } = request.params;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(entityType)) {
      throw errors.badRequest('entityType 非法');
    }
    if (!entityId || entityId.length > 200) {
      throw errors.badRequest('entityId 非法');
    }
    const found = await app.zx.sync.getEntity(
      device,
      parseSpaceId(request.query.spaceId),
      entityType,
      entityId,
    );
    return { ok: true, ...found, serverTime: new Date().toISOString() };
  });
}
