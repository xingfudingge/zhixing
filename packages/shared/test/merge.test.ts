import { describe, expect, it } from 'vitest';

import {
  HlcClock,
  applyOperation,
  advanceVv,
  compareHlc,
  compareVv,
  emptyEntityState,
  isConcurrent,
  mergeVv,
  uuidv7,
  type SyncOp,
} from '../src/index.ts';

function op(overrides: Partial<SyncOp> & Pick<SyncOp, 'op_id' | 'device_id' | 'hlc'>): SyncOp {
  return {
    space_id: 'personal',
    entity_type: 'task',
    entity_id: 'task-1',
    op_type: 'patch',
    base_vv: {},
    payload: {},
    ...overrides,
  };
}

function hlc(ms: number, c: number, d: string) {
  return { ms, c, d };
}

describe('HLC / VV', () => {
  it('HLC 单调且按 ms、c、device 排序', () => {
    const clock = new HlcClock('dev-a');
    const first = clock.next(1000);
    const second = clock.next(1000);
    const third = clock.next(1001);
    expect(second.c).toBe(first.c + 1);
    expect(third.ms).toBe(1001);
    expect(compareHlc(third, second)).toBeGreaterThan(0);
    expect(compareHlc(hlc(1000, 1, 'b'), hlc(1000, 1, 'a'))).toBeGreaterThan(0);
  });

  it('收到远端时钟后保持严格递增', () => {
    const clock = new HlcClock('server');
    const next = clock.receive(hlc(5000, 7, 'dev-a'), 1000);
    expect(next.ms).toBe(5000);
    expect(next.c).toBe(8);
    expect(clock.next(1000).ms).toBeGreaterThanOrEqual(5000);
  });

  it('版本向量区分支配与并发', () => {
    expect(compareVv({ a: 2, b: 1 }, { a: 1 })).toBe('dominant');
    expect(compareVv({ a: 1 }, { a: 2 })).toBe('dominated');
    expect(compareVv({ a: 1 }, { b: 1 })).toBe('concurrent');
    expect(compareVv({ a: 1 }, { a: 1 })).toBe('equal');
    expect(isConcurrent({ a: 1 }, { b: 1 })).toBe(true);
    expect(mergeVv({ a: 1 }, { a: 3, b: 2 })).toEqual({ a: 3, b: 2 });
    expect(advanceVv({ a: 1 }, 'a')).toEqual({ a: 2 });
  });

  it('UUIDv7 可按生成顺序排序', () => {
    const ids = Array.from({ length: 20 }, () => uuidv7(1_700_000_000_000));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('字段级 LWW 合并', () => {
  it('两台设备改同一任务不同字段，字段都保留', () => {
    const initial = applyOperation(
      null,
      op({
        op_id: 'op-a-0001',
        device_id: 'dev-a',
        hlc: hlc(1000, 0, 'dev-a'),
        op_type: 'upsert',
        payload: { title: '写周报', status: 'todo' },
      }),
    );

    const fromA = applyOperation(initial.state, op({
      op_id: 'op-a-0002',
      device_id: 'dev-a',
      hlc: hlc(2000, 0, 'dev-a'),
      base_vv: { 'dev-a': 1 },
      payload: { title: '写周报（改）' },
    }));
    const fromB = applyOperation(fromA.state, op({
      op_id: 'op-b-0001',
      device_id: 'dev-b',
      hlc: hlc(2001, 0, 'dev-b'),
      base_vv: { 'dev-a': 1 },
      payload: { due_date: '2026-10-30' },
    }));

    expect(fromB.state.fields.title).toBe('写周报（改）');
    expect(fromB.state.fields.due_date).toBe('2026-10-30');
    expect(fromB.conflictCopies).toHaveLength(0);
    expect(fromB.state.version).toBe(3);
  });

  it('同一标量字段并发时 HLC 大者胜并留下审计', () => {
    const first = applyOperation(null, op({
      op_id: 'op-a-0001',
      device_id: 'dev-a',
      hlc: hlc(1000, 0, 'dev-a'),
      op_type: 'upsert',
      payload: { priority: 1 },
    }));
    const second = applyOperation(first.state, op({
      op_id: 'op-b-0001',
      device_id: 'dev-b',
      hlc: hlc(3000, 0, 'dev-b'),
      payload: { priority: 3 },
    }));
    expect(second.state.fields.priority).toBe(3);
    expect(second.conflicts[0]?.kind).toBe('field_lww');
    expect(second.conflicts[0]?.winner).toBe('incoming');
  });

  it('重复 op 幂等：不重复写字段、不重复生成副本', () => {
    const incoming = op({
      op_id: 'op-a-0001',
      device_id: 'dev-a',
      hlc: hlc(1000, 0, 'dev-a'),
      op_type: 'upsert',
      payload: { title: '唯一' },
    });
    const first = applyOperation(null, incoming);
    const second = applyOperation(first.state, incoming);
    expect(second.state.version).toBe(1);
    expect(second.applied).toBe(false);
    expect(second.conflictCopies).toHaveLength(0);
  });

  it('删除墓碑优先，旧设备的普通 patch 不复活', () => {
    const created = applyOperation(null, op({
      op_id: 'op-a-0001',
      device_id: 'dev-a',
      hlc: hlc(1000, 0, 'dev-a'),
      op_type: 'upsert',
      payload: { title: '待删除' },
    }));
    const deleted = applyOperation(created.state, op({
      op_id: 'op-a-0002',
      device_id: 'dev-a',
      hlc: hlc(2000, 0, 'dev-a'),
      op_type: 'delete',
    }));
    const staleEdit = applyOperation(deleted.state, op({
      op_id: 'op-b-0001',
      device_id: 'dev-b',
      hlc: hlc(2500, 0, 'dev-b'),
      base_vv: { 'dev-a': 1 },
      payload: { title: '旧设备改标题' },
    }));
    expect(deleted.state.deleted).toBe(true);
    expect(staleEdit.state.deleted).toBe(true);
  });
});

describe('正文并发冲突副本', () => {
  it('两台设备并发改正文：主实体按 LWW，落败正文进入冲突副本', () => {
    const base = applyOperation(null, op({
      op_id: 'op-a-0001',
      device_id: 'dev-a',
      entity_type: 'note',
      entity_id: 'note-1',
      op_type: 'upsert',
      hlc: hlc(1000, 0, 'dev-a'),
      payload: { title: '会议记录', body: '原始正文', status: 'active' },
    }));

    const fromA = applyOperation(base.state, op({
      op_id: 'op-a-0002',
      device_id: 'dev-a',
      entity_type: 'note',
      entity_id: 'note-1',
      hlc: hlc(2000, 0, 'dev-a'),
      base_vv: { 'dev-a': 1 },
      payload: { body: 'A 的新正文' },
    }));
    const fromB = applyOperation(fromA.state, op({
      op_id: 'op-b-0001',
      device_id: 'dev-b',
      entity_type: 'note',
      entity_id: 'note-1',
      hlc: hlc(2100, 0, 'dev-b'),
      // 没看到 A 的 op，构成并发
      base_vv: { 'dev-a': 1 },
      payload: { body: 'B 的新正文' },
    }));

    expect(fromB.state.fields.body).toBe('B 的新正文');
    expect(fromB.conflicts).toHaveLength(1);
    expect(fromB.conflicts[0]).toMatchObject({
      kind: 'body_concurrent',
      field: 'body',
      winner: 'incoming',
    });
    expect(fromB.conflictCopies).toHaveLength(1);
    const copy = fromB.conflictCopies[0]!;
    expect(copy.entityType).toBe('note');
    expect(copy.entityId).not.toBe('note-1');
    expect(copy.entityId).toContain('conflict');
    expect(copy.fields.body).toBe('A 的新正文');
    expect(copy.fields.title).toContain('冲突副本');
    expect(copy.fields.status).toBe('active');
    expect(copy.fields.conflict_of).toBe('note-1');
  });

  it('迟到的旧正文不会覆盖本地：旧内容进副本，主正文保留', () => {
    const base = applyOperation(null, op({
      op_id: 'op-a-0001',
      device_id: 'dev-a',
      entity_type: 'note',
      entity_id: 'note-1',
      op_type: 'upsert',
      hlc: hlc(1000, 0, 'dev-a'),
      payload: { title: '标题', body: '原始' },
    }));
    const local = applyOperation(base.state, op({
      op_id: 'op-a-0002',
      device_id: 'dev-a',
      entity_type: 'note',
      entity_id: 'note-1',
      hlc: hlc(3000, 0, 'dev-a'),
      base_vv: { 'dev-a': 1 },
      payload: { body: '本地新正文' },
    }));
    const stale = applyOperation(local.state, op({
      op_id: 'op-b-0001',
      device_id: 'dev-b',
      entity_type: 'note',
      entity_id: 'note-1',
      hlc: hlc(2000, 0, 'dev-b'),
      base_vv: { 'dev-a': 1 },
      payload: { body: '远端旧正文' },
    }));
    expect(stale.state.fields.body).toBe('本地新正文');
    expect(stale.conflicts[0]?.winner).toBe('existing');
    expect(stale.conflictCopies[0]?.fields.body).toBe('远端旧正文');
  });

  it('正文时钟相同但值相同不产生副本', () => {
    const base = applyOperation(null, op({
      op_id: 'op-a-0001',
      device_id: 'dev-a',
      entity_type: 'note',
      entity_id: 'note-1',
      op_type: 'upsert',
      hlc: hlc(1000, 0, 'dev-a'),
      payload: { body: '同一段' },
    }));
    const same = applyOperation(base.state, op({
      op_id: 'op-b-0001',
      device_id: 'dev-b',
      entity_type: 'note',
      entity_id: 'note-1',
      hlc: hlc(2000, 0, 'dev-b'),
      payload: { body: '同一段' },
    }));
    expect(same.conflictCopies).toHaveLength(0);
  });
});

describe('空实体', () => {
  it('空白实体具有稳定结构', () => {
    expect(emptyEntityState('personal', 'task', 't1')).toMatchObject({
      spaceId: 'personal',
      entityType: 'task',
      entityId: 't1',
      fields: {},
      deleted: false,
      version: 0,
    });
  });
});
