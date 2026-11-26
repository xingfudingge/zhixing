import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { authenticateDevice } from '../services/device-service.ts';
import { parseSpaceId, parseWith } from './validation.ts';

const initSchema = z.object({
  spaceId: z.string().regex(/^[a-z0-9_-]{1,64}$/).optional(),
  noteId: z.string().max(200).nullable().optional(),
  blockId: z.string().max(200).nullable().optional(),
  fileName: z.string().trim().min(1).max(255),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 必须是 64 位小写十六进制'),
  byteSize: z.number().int().min(0).max(5 * 1024 * 1024 * 1024),
  mime: z.string().trim().min(1).max(200),
});

async function requireDevice(request: FastifyRequest, app: FastifyInstance) {
  if (request.device) return request.device;
  const device = await authenticateDevice(request, app.zx.pool);
  request.device = device;
  return device;
}

export function registerAttachmentRoutes(app: FastifyInstance): void {
  app.post('/attachments/init', async (request) => {
    const device = await requireDevice(request, app);
    const body = parseWith(initSchema, request.body);
    const spaceId = parseSpaceId(body.spaceId);
    const result = await app.zx.attachments.init(device, {
      spaceId,
      noteId: body.noteId ?? null,
      blockId: body.blockId ?? null,
      fileName: body.fileName,
      sha256: body.sha256,
      byteSize: body.byteSize,
      mime: body.mime,
    });
    return {
      ok: true,
      ...result,
      serverTime: new Date().toISOString(),
    };
  });

  app.post<{ Params: { id: string } }>(
    '/attachments/:id/complete',
    async (request) => {
      const device = await requireDevice(request, app);
      const result = await app.zx.attachments.complete(device, request.params.id);
      return { ok: true, ...result, serverTime: new Date().toISOString() };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/attachments/:id/download',
    async (request) => {
      const device = await requireDevice(request, app);
      const result = await app.zx.attachments.getDownloadUrl(device, request.params.id);
      return { ok: true, ...result, serverTime: new Date().toISOString() };
    },
  );

  app.get<{ Querystring: { noteId?: string; spaceId?: string } }>(
    '/attachments',
    async (request) => {
      await requireDevice(request, app);
      const spaceId = parseSpaceId(request.query.spaceId);
      const noteId = request.query.noteId ?? null;
      return {
        ok: true,
        attachments: await app.zx.attachments.list(spaceId, noteId),
        serverTime: new Date().toISOString(),
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/attachments/:id',
    async (request) => {
      const device = await requireDevice(request, app);
      const attachment = await app.zx.attachments.remove(device, request.params.id);
      return { ok: true, attachment, serverTime: new Date().toISOString() };
    },
  );
}
