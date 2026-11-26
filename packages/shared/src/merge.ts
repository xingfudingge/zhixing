import { compareHlc, hlcToString, maxHlc } from './hlc.ts';
import { stableHash } from './ids.ts';
import { cloneJson, isPlainObject, jsonEquals } from './json.ts';
import {
  DEFAULT_SPACE_ID,
  PROTECTED_FIELDS,
  type ApplyResult,
  type EntityState,
  type FieldClocks,
  type FieldVvs,
  type Hlc,
  type JsonObject,
  type JsonValue,
  type MergeConflict,
  type SyncOp,
} from './types.ts';
import { advanceVv, dominatesOrEqual, mergeVv } from './vv.ts';

export function emptyEntityState(
  spaceId: string,
  entityType: string,
  entityId: string,
): EntityState {
  return {
    spaceId,
    entityType,
    entityId,
    fields: {},
    fieldClocks: {},
    fieldVvs: {},
    vv: {},
    deleted: false,
    hlc: null,
    version: 0,
  };
}

function cloneState(state: EntityState): EntityState {
  return {
    spaceId: state.spaceId,
    entityType: state.entityType,
    entityId: state.entityId,
    fields: cloneJson(state.fields),
    fieldClocks: cloneJson(state.fieldClocks),
    fieldVvs: cloneJson(state.fieldVvs),
    vv: { ...state.vv },
    deleted: state.deleted,
    hlc: state.hlc ? { ...state.hlc } : null,
    version: state.version,
  };
}

function conflictCopyId(
  entityType: string,
  entityId: string,
  existingClock: Hlc | undefined,
  incomingClock: Hlc,
  field: string,
): string {
  // 用冲突双方的 HLC 规范排序生成 ID：服务端先收到 B、客户端先看到 A 时，
  // 两端都会得到同一个副本 ID，避免同一冲突出现两份副本。
  const pair = [existingClock ? hlcToString(existingClock) : '', hlcToString(incomingClock)]
    .sort()
    .join('|');
  const seed = `${entityType}\u0000${entityId}\u0000${field}\u0000${pair}`;
  const suffix = stableHash(seed).slice(0, 12);
  const prefix = entityId.length > 160 ? entityId.slice(0, 160) : entityId;
  return `${prefix}-conflict-${suffix}`;
}

function buildConflictCopy(
  state: EntityState,
  fields: JsonObject,
  op: SyncOp,
  resultVv: EntityState['vv'],
  field: string,
  nowIso: string,
  sourceDevice: string,
): EntityState {
  const copyFields: JsonObject = cloneJson(fields);
  const originalTitle = typeof copyFields.title === 'string' ? copyFields.title : '未命名';
  copyFields.title = `${originalTitle}（冲突副本）`;
  copyFields.conflict_of = state.entityId;
  copyFields.conflict_field = field;
  copyFields.conflict_reason = field === 'body' ? '正文并发编辑' : '内容并发编辑';
  copyFields.conflict_source_device = sourceDevice;
  copyFields.conflict_created_at = nowIso;
  if (state.entityType === 'note') {
    copyFields.status = 'active';
    const tags = Array.isArray(copyFields.tags)
      ? copyFields.tags.filter((tag): tag is string => typeof tag === 'string')
      : [];
    if (!tags.includes('冲突副本')) tags.push('冲突副本');
    copyFields.tags = tags;
  }
  if (state.entityType === 'board') {
    copyFields.conflict_of_board = state.entityId;
  }

  const copyId = conflictCopyId(
    state.entityType,
    state.entityId,
    state.fieldClocks[field],
    op.hlc,
    field,
  );
  const fieldClocks: FieldClocks = {};
  const fieldVvs: FieldVvs = {};
  for (const key of Object.keys(copyFields)) {
    fieldClocks[key] = { ...op.hlc };
    fieldVvs[key] = { ...resultVv };
  }
  return {
    spaceId: state.spaceId,
    entityType: state.entityType,
    entityId: copyId,
    fields: copyFields,
    fieldClocks,
    fieldVvs,
    vv: { ...resultVv },
    deleted: false,
    hlc: { ...op.hlc },
    version: 1,
  };
}

export type ApplyOptions = {
  /** 可覆盖受保护字段（默认正文/画板快照）。 */
  protectedFields?: readonly string[];
  /** 冲突副本时间戳，测试可注入。 */
  now?: Date;
};

/**
 * 把单个 op 合并进实体状态。
 *
 * 规则：
 * - 标量字段：字段级 LWW（HLC 大者胜，同 HLC 比 device_id）；
 * - 并发标量冲突：记录审计，不生成副本；
 * - 正文/画板快照并发：绝不静默覆盖，落败内容生成独立冲突副本实体；
 * - 墓碑优先，删除后普通 patch 不复活实体；
 * - 重复 op（已有字段时钟 >= op）不改字段、不重复生成副本。
 *
 * 幂等：同一 op 重放两次，版本号与字段值不变。
 */
export function applyOperation(
  current: EntityState | null | undefined,
  op: SyncOp,
  options: ApplyOptions = {},
): ApplyResult {
  const state = current
    ? cloneState(current)
    : emptyEntityState(op.space_id || DEFAULT_SPACE_ID, op.entity_type, op.entity_id);
  const protectedFields = new Set<string>(options.protectedFields ?? PROTECTED_FIELDS);
  const nowIso = (options.now ?? new Date()).toISOString();
  const baseVv = op.base_vv ?? {};
  const resultVv = advanceVv(baseVv, op.device_id, state.vv);

  const changedFields: string[] = [];
  const conflicts: MergeConflict[] = [];
  const conflictCopies: EntityState[] = [];

  if (op.op_type === 'delete') {
    const previousClock = state.fieldClocks.__deleted;
    const previousDeleted = state.deleted;
    if (!previousClock || compareHlc(op.hlc, previousClock) > 0) {
      state.fieldClocks.__deleted = { ...op.hlc };
      state.fieldVvs.__deleted = { ...resultVv };
      state.deleted = true;
      if (!previousDeleted) changedFields.push('__deleted');
    }
  } else if (isPlainObject(op.payload)) {
    const keys = Object.keys(op.payload).sort();
    for (const field of keys) {
      if (field === '__deleted') continue;
      const incomingValue = op.payload[field] as JsonValue;
      const existingValue = state.fields[field];
      const existingClock = state.fieldClocks[field];
      const fieldVv = state.fieldVvs[field] ?? {};
      const incomingSawExisting = dominatesOrEqual(baseVv, fieldVv);
      const existingSawIncoming = dominatesOrEqual(fieldVv, resultVv);
      const valuesDiffer = !jsonEquals(existingValue, incomingValue);
      const incomingWins = !existingClock || compareHlc(op.hlc, existingClock) > 0;

      if (existingSawIncoming && !incomingWins) {
        // 已经应用过的 op（或更晚的本地编辑已包含它）：幂等跳过。
        continue;
      }

      const isProtected = protectedFields.has(field);
      const hadValue = existingValue !== undefined && existingValue !== null;
      const unsafeConcurrent = !incomingSawExisting && valuesDiffer && hadValue;

      if (isProtected && unsafeConcurrent) {
        const winner: 'incoming' | 'existing' = incomingWins ? 'incoming' : 'existing';
        const losingFields = cloneJson(state.fields);
        if (winner === 'incoming') {
          // 旧内容进副本；主实体写入新内容。
          const copy = buildConflictCopy(
            state,
            state.fields,
            op,
            resultVv,
            field,
            nowIso,
            existingClock?.d ?? 'unknown',
          );
          conflictCopies.push(copy);
          conflicts.push({
            kind: 'body_concurrent',
            entityType: state.entityType,
            entityId: state.entityId,
            field,
            winner,
            incomingHlc: { ...op.hlc },
            existingHlc: existingClock,
            localValue: existingValue,
            incomingValue,
            copyEntityType: copy.entityType,
            copyEntityId: copy.entityId,
          });
          state.fields[field] = cloneJson(incomingValue);
          state.fieldClocks[field] = { ...op.hlc };
          state.fieldVvs[field] = { ...resultVv };
          changedFields.push(field);
        } else {
          // 本地内容保留；incoming 内容进副本。
          losingFields[field] = cloneJson(incomingValue);
          const copy = buildConflictCopy(
            state,
            losingFields,
            op,
            resultVv,
            field,
            nowIso,
            op.device_id,
          );
          conflictCopies.push(copy);
          conflicts.push({
            kind: 'body_concurrent',
            entityType: state.entityType,
            entityId: state.entityId,
            field,
            winner,
            incomingHlc: { ...op.hlc },
            existingHlc: existingClock,
            localValue: existingValue,
            incomingValue,
            copyEntityType: copy.entityType,
            copyEntityId: copy.entityId,
          });
        }
        continue;
      }

      if (incomingWins) {
        state.fields[field] = cloneJson(incomingValue);
        state.fieldClocks[field] = { ...op.hlc };
        state.fieldVvs[field] = { ...resultVv };
        if (valuesDiffer) changedFields.push(field);
        if (!isProtected && unsafeConcurrent) {
          conflicts.push({
            kind: 'field_lww',
            entityType: state.entityType,
            entityId: state.entityId,
            field,
            winner: 'incoming',
            incomingHlc: { ...op.hlc },
            existingHlc: existingClock,
            localValue: existingValue,
            incomingValue,
          });
        }
      } else if (!isProtected && unsafeConcurrent) {
        conflicts.push({
          kind: 'field_lww',
          entityType: state.entityType,
          entityId: state.entityId,
          field,
          winner: 'existing',
          incomingHlc: { ...op.hlc },
          existingHlc: existingClock,
          localValue: existingValue,
          incomingValue,
        });
      }
    }
  }

  state.vv = mergeVv(state.vv, resultVv);
  state.hlc = maxHlc(state.hlc, op.hlc);
  if (changedFields.length > 0) state.version += 1;

  return {
    state,
    changedFields,
    conflicts,
    conflictCopies,
    applied: changedFields.length > 0,
  };
}

/**
 * 把服务端/其他设备的 op 应用到本地实体表。
 * 校验失败抛出带字段信息的 Error，调用方可拒绝整批 op。
 */
export function validateOpEnvelope(value: unknown): asserts value is SyncOp {
  if (!isPlainObject(value)) throw new Error('op 必须是对象');
  const op = value as Partial<SyncOp>;
  if (typeof op.op_id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(op.op_id)) {
    throw new Error('op_id 非法');
  }
  if (typeof op.space_id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(op.space_id)) {
    throw new Error('space_id 非法');
  }
  if (typeof op.device_id !== 'string' || op.device_id.length === 0 || op.device_id.length > 128) {
    throw new Error('device_id 非法');
  }
  if (
    typeof op.entity_type !== 'string' ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(op.entity_type)
  ) {
    throw new Error('entity_type 非法');
  }
  if (typeof op.entity_id !== 'string' || op.entity_id.length === 0 || op.entity_id.length > 200) {
    throw new Error('entity_id 非法');
  }
  if (!['upsert', 'patch', 'delete', 'yupdate'].includes(op.op_type ?? '')) {
    throw new Error('op_type 非法');
  }
  if (
    !op.hlc ||
    !Number.isSafeInteger(op.hlc.ms) ||
    op.hlc.ms < 0 ||
    !Number.isSafeInteger(op.hlc.c) ||
    op.hlc.c < 0 ||
    typeof op.hlc.d !== 'string' ||
    op.hlc.d.length === 0 ||
    op.hlc.d.length > 64
  ) {
    throw new Error('hlc 非法');
  }
  if (!isPlainObject(op.base_vv)) throw new Error('base_vv 必须是对象');
  if (!isPlainObject(op.payload)) throw new Error('payload 必须是对象');
}

export function compareMergedFields(a: EntityState, b: EntityState): boolean {
  return jsonEquals(a.fields, b.fields) && a.deleted === b.deleted;
}
