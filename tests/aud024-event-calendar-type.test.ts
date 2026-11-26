/**
 * AUD-024 / DEF-AUD014-02 回归：事件历法（公历/农历）。
 *
 * 覆盖：
 *  1. 备份恢复（恢复计划 → DB 恢复目标）把 events.calendarType 原样写回 IPC，
 *     而不是像修复前那样在 `create`/`update` 里丢掉。
 *  2. 旧备份没有该字段时回退为公历，且不阻断恢复。
 */
import { describe, expect, it } from 'vitest';

import { createDbClient } from '../app/src/data/db/client';
import { buildJsonBackup } from '../app/src/features/export/serialize';
import {
  FIXED_NOW,
  makeDataset,
  makePayload,
} from '../app/src/features/export/__tests__/testFixtures';
import { parseBackupFile } from '../app/src/features/import/parseBackup';
import { createDbRestoreTarget } from '../app/src/features/import/restoreTarget';
import type { RestoreOperation } from '../app/src/features/export/types';

type Call = { command: string; args?: Record<string, unknown> };

function recordingClient() {
  const calls: Call[] = [];
  const invoker = async <T>(command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === 'events_create' || command === 'events_update') {
      return { id: (args?.input as { id?: string } | undefined)?.id ?? 'evt' } as T;
    }
    return undefined as T;
  };
  return { calls, client: createDbClient(invoker) };
}

const baseRow = {
  id: 'event-lunar',
  spaceId: 'personal',
  title: '外婆农历生日',
  eventType: '生日',
  allDay: true,
  startDate: '2026-11-01',
  startAt: null,
  endAt: null,
  tz: 'Asia/Shanghai',
  source: 'local',
  externalUid: null,
  repeatRule: '每年',
  calendarType: 'lunar',
  noteId: null,
  color: '',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  deletedAt: null,
  version: 1,
};

function eventOperation(
  type: 'create' | 'update',
  row: Record<string, unknown> = baseRow,
): RestoreOperation {
  return {
    type,
    collection: 'events',
    row: row as never,
  } as RestoreOperation;
}

describe('事件历法恢复（AUD-024）', () => {
  it('恢复 create/update 都把 calendarType 传给 IPC', async () => {
    const { calls, client } = recordingClient();
    const target = createDbRestoreTarget(client, {
      now: () => '2026-10-27T00:00:00.000Z',
    });

    await target.apply(eventOperation('create'));
    await target.apply(eventOperation('update'));

    const create = calls.find((call) => call.command === 'events_create');
    const update = calls.find((call) => call.command === 'events_update');
    expect(
      (create?.args?.input as Record<string, unknown> | undefined)?.calendarType,
    ).toBe('lunar');
    expect(
      (update?.args?.input as Record<string, unknown> | undefined)?.calendarType,
    ).toBe('lunar');
  });

  it('v3 旧备份的事件缺字段时按公历恢复', async () => {
    // 真实走一遍：v3 JSON 备份（无 calendarType）→ 解析 → 恢复目标 → IPC。
    const payload = makePayload(makeDataset());
    const legacy = payload.dataset.events[0] as Record<string, unknown>;
    delete legacy.calendarType;
    const parsed = await parseBackupFile(
      buildJsonBackup(payload, FIXED_NOW).bytes,
    );
    const row = parsed.payload.dataset.events[0]!;
    expect(row.calendarType).toBe('solar');

    const { calls, client } = recordingClient();
    const target = createDbRestoreTarget(client, {
      now: () => '2026-10-27T00:00:00.000Z',
    });
    await target.apply({
      type: 'create',
      collection: 'events',
      row,
    } as RestoreOperation);

    const create = calls.find((call) => call.command === 'events_create');
    expect(
      (create?.args?.input as Record<string, unknown> | undefined)?.calendarType,
    ).toBe('solar');
  });

  it('事件仓储不再把 unknown 历法写进更新参数', async () => {
    const { calls, client } = recordingClient();
    const target = createDbRestoreTarget(client, {
      now: () => '2026-10-27T00:00:00.000Z',
    });
    await target.apply(eventOperation('update'));

    // Rust 侧会拒绝非法值；前端不得悄悄传空或漏字段（漏字段 = 旧 bug）。
    const update = calls.find((call) => call.command === 'events_update');
    expect(update?.args?.input).toHaveProperty('calendarType', 'lunar');
  });
});
