/**
 * 附件分片上传路由（需与现有 `/attachments/init` 配合）：
 *   POST /attachments/:id/upload-session   申请缺失分片预签名 PUT
 *   POST /attachments/:id/upload-complete  逐片回读校验并置 available
 *   GET  /attachments/:id/download-manifest 下载清单 + 分片预签名 GET
 *
 * 该插件只依赖 `app.zx.pool` / `app.zx.storage`，由部署方挂载到
 * `/api/v1` 前缀下；测试与验收脚本会显式注册。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { errors } from '../errors.ts';
import { authenticateDevice } from '../services/device-service.ts';
import { parseWith } from '../routes/validation.ts';
import {
  AttachmentChunkService,
  type AttachmentChunkServiceOptions,
} from './chunked-upload-service.ts';

const paramsSchema = z.object({
  id: z.string().min(1).max(200),
});

const sessionSchema = z.object({
  chunkSize: z.number().int().positive().optional(),
});

const completeSchema = z.object({
  chunkSize: z.number().int().positive(),
  partCount: z.number().int().positive().max(10_000),
  completeSha256: z.string().regex(/^[0-9a-f]{64}$/, 'completeSha256 不合法'),
  parts: z
    .array(
      z.object({
        index: z.number().int().min(0).max(9_999),
        size: z.number().int().min(0).max(64 * 1024 * 1024),
        sha256: z.string().regex(/^[0-9a-f]{64}$/, '分片 sha256 不合法'),
      }),
    )
    .min(1)
    .max(10_000),
});

async function requireDevice(request: FastifyRequest, app: FastifyInstance) {
  if (request.device) return request.device;
  const device = await authenticateDevice(request, app.zx.pool);
  request.device = device;
  return device;
}

export function registerAttachmentChunkRoutes(
  app: FastifyInstance,
  options: AttachmentChunkServiceOptions = {},
): void {
  const service = new AttachmentChunkService(
    app.zx.pool,
    app.zx.storage,
    options,
  );

  app.post<{ Params: { id: string } }>(
    '/attachments/:id/upload-session',
    async (request) => {
      const device = await requireDevice(request, app);
      const { id } = parseWith(paramsSchema, request.params);
      const body = parseWith(sessionSchema, request.body ?? {});
      const result = await service.createSession(device, id, body.chunkSize);
      return {
        ok: true,
        ...result,
        serverTime: new Date().toISOString(),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/attachments/:id/upload-complete',
    async (request) => {
      const device = await requireDevice(request, app);
      const { id } = parseWith(paramsSchema, request.params);
      const body = parseWith(completeSchema, request.body);
      const result = await service.complete(device, id, body);
      return {
        ok: true,
        ...result,
        serverTime: new Date().toISOString(),
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { chunkSize?: string } }>(
    '/attachments/:id/download-manifest',
    async (request) => {
      const device = await requireDevice(request, app);
      const { id } = parseWith(paramsSchema, request.params);
      const raw = request.query.chunkSize;
      const chunkSize =
        typeof raw === 'string' && raw.trim() !== ''
          ? Number(raw)
          : undefined;
      if (chunkSize !== undefined && (!Number.isFinite(chunkSize) || chunkSize <= 0)) {
        throw errors.badRequest('chunkSize 不合法');
      }
      const result = await service.downloadManifest(device, id, chunkSize);
      return {
        ok: true,
        ...result,
        serverTime: new Date().toISOString(),
      };
    },
  );
}
