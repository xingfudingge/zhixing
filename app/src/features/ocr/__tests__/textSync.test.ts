import { describe, expect, it } from 'vitest';

import { SyncEngine } from '../../../sync/engine.ts';
import { MemorySyncStore } from '../../../sync/store.ts';
import type { SyncDeviceProfile } from '../../../sync/types.ts';
import { MemoryWebDavConfigStore } from '../../../sync/webdav/configStore.ts';
import {
  OCR_TEXT_ENTITY_TYPE,
  createOcrTextSyncSink,
  describeTextSyncAvailability,
} from '../textSync';
import type { OcrJob } from '../types';

const PROFILE: SyncDeviceProfile = {
  baseUrl: 'https://sync.example.com',
  spaceId: 'personal',
  deviceId: 'dev_ocr_test',
  deviceName: 'OCR 测试设备',
  platform: 'macos',
  deviceToken: 'token',
  refreshToken: 'refresh',
  accessExpiresAt: '2026-11-02T00:00:00.000Z',
  refreshExpiresAt: '2026-12-02T00:00:00.000Z',
  features: { sync: true },
  lastPullCursor: '0',
  lastSyncAt: null,
  lastError: null,
};

function job(overrides: Partial<OcrJob> = {}): OcrJob {
  return {
    id: 'ocr_job_1',
    attachmentId: 'att_ocr_1',
    status: 'succeeded',
    engineId: 'system-local',
    dedupeKey: 'att_ocr_1:system-local:hash',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:02.000Z',
    attempts: 1,
    text: '发票编号 123',
    language: 'zh-Hans',
    error: null,
    textStorage: 'sync',
    textSyncState: 'pending',
    textSyncError: null,
    sourceSha256: 'a'.repeat(64),
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

describe('OCR 文本同步消费方', () => {
  it('仅本机模式明确显示不可同步，不写 outbox', async () => {
    const store = new MemorySyncStore();
    await store.saveProfile(PROFILE);
    const availability = describeTextSyncAvailability({ mode: 'local' });
    expect(availability.ready).toBe(false);
    expect(availability.reason).toContain('仅本机');

    const sink = createOcrTextSyncSink({ store, mode: () => 'local' });
    await expect(sink(job())).rejects.toThrow(/仅本机/);
    expect(await store.listOutbox()).toHaveLength(0);
  });

  it('后台已配对时写入现有 outbox，并由 SyncEngine 真实推送消费', async () => {
    const store = new MemorySyncStore();
    await store.saveProfile(PROFILE);
    const availability = describeTextSyncAvailability({
      mode: 'backend',
      backendProfile: PROFILE,
    });
    expect(availability.ready).toBe(true);

    const sink = createOcrTextSyncSink({ store, mode: () => 'backend' });
    const output = await sink(job());
    expect(output.queued).toBe(true);
    expect(output.entityId).toBe('att_ocr_1');

    const outbox = await store.listOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.op.entity_type).toBe(OCR_TEXT_ENTITY_TYPE);
    expect(outbox[0]!.op.entity_id).toBe('att_ocr_1');
    expect(outbox[0]!.op.payload).toMatchObject({
      attachmentId: 'att_ocr_1',
      text: '发票编号 123',
      language: 'zh-Hans',
      sourceSha256: 'a'.repeat(64),
    });

    const pushed: unknown[] = [];
    const fetchImpl = async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/sync/push')) {
        const body = JSON.parse(String(init?.body)) as {
          ops: { op_id: string }[];
        };
        pushed.push(body.ops);
        return jsonResponse(200, {
          applied: body.ops.map((op, index) => ({
            opId: op.op_id,
            cursor: String(index + 1),
            duplicate: false,
          })),
          duplicates: [],
          conflicts: [],
          nextCursor: String(body.ops.length),
          serverTime: '2026-11-01T10:00:03.000Z',
        });
      }
      return jsonResponse(200, {
        ops: [],
        nextCursor: '0',
        hasMore: false,
        conflicts: [],
        serverTime: '2026-11-01T10:00:03.000Z',
      });
    };
    const engine = new SyncEngine({ store, fetchImpl });
    const result = await engine.sync({ force: true });
    expect(result.ok).toBe(true);
    expect(result.pushed).toBe(1);
    expect(await store.listOutbox()).toHaveLength(0);
    expect(pushed).toHaveLength(1);
    expect(
      (pushed[0] as { entity_type: string }[])[0]!.entity_type,
    ).toBe(OCR_TEXT_ENTITY_TYPE);
  });

  it('后台未配对时拒绝入队并说明原因', async () => {
    const store = new MemorySyncStore();
    const sink = createOcrTextSyncSink({ store, mode: () => 'backend' });
    await expect(sink(job())).rejects.toThrow(/尚未配对/);
    expect(await store.listOutbox()).toHaveLength(0);
  });

  it('WebDAV 已配置时写入同一 outbox；未配置时明确拒绝', async () => {
    const store = new MemorySyncStore();
    const sink = createOcrTextSyncSink({
      store,
      mode: () => 'webdav',
      platform: () => 'macos',
      webdavConfigStore: new MemoryWebDavConfigStore(null),
    });
    await expect(sink(job())).rejects.toThrow(/WebDAV 尚未配置/);

    const configured = createOcrTextSyncSink({
      store,
      mode: () => 'webdav',
      platform: () => 'macos',
      webdavConfigStore: new MemoryWebDavConfigStore({
        version: 1,
        baseUrl: 'https://dav.example.com',
        username: 'me',
        root: '/zhixing',
        spaceId: 'personal',
        deviceId: 'dev_webdav',
        deviceName: '测试设备',
        passwordSaved: false,
        updatedAt: null,
      }),
    });
    const output = await configured(job());
    expect(output.queued).toBe(true);
    expect(await store.listOutbox()).toHaveLength(1);
  });
});
