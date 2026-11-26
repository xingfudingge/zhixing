import type { z } from 'zod';

import { errors } from '../errors.ts';

export function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw errors.badRequest(
      '请求参数不合法',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

export function parseSpaceId(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'personal';
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(value)) {
    throw errors.badRequest('spaceId 非法');
  }
  return value;
}
