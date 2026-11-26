import type {
  ApplyResult,
  AppliedOp,
  EntityState,
  FieldClocks,
  FieldVvs,
  Hlc,
  PullResponse,
  PushResponse,
  SyncConflictRecord,
  SyncOp,
  SyncOpWithCursor,
  SyncStatusResponse,
} from '../../../packages/shared/src/index.ts';
import {
  CLOCK_SKEW_WARNING_MS,
  HlcClock,
  MAX_PULL_LIMIT,
  applyOperation,
  advanceVv,
} from '../../../packages/shared/src/index.ts';
import type { DbPool } from '../db/pool.ts';
import type {
  ConflictRow,
  DeviceRow,
  EntityRow,
  SyncOpRow,
} from '../db/rows.ts';
import {
  iso,
  rowToConflict,
  rowToEntityState,
  rowToOp,
} from '../db/rows.ts';
import { errors } from '../errors.ts';
import { stableHash } from '../../../packages/shared/src/index.ts';
import type { StorageService } from './storage.ts';

type Queryable = {
  query: DbPool['query'];
};

function cursorString(value: string | null | undefined): string {
  return value && /^\d+$/.test(value) ? value : '0';
}

function parseCursor(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw errors.badRequest('cursor 必须是正整数');
  }
  const text = String(value);
  if (!/^\d{1,19}$/.test(text)) throw errors.badRequest('cursor 必须是正整数');
  const parsed = BigInt(text);
  if (parsed > 9223372036854775807n) throw errors.badRequest('cursor 超出 bigint 范围');
  return parsed.toString();
}

function conflictRowValues(
  spaceId: string,
  entityType: string,
  entityId: string,
  conflict: ApplyResult['conflicts'][number],
  incomingOp: SyncOp,
  cursor: string,
): unknown[] {
  const id = `cf_${stableHash(`${incomingOp.op_id}\u0000${conflict.field}`).slice(0, 40)}`;
  return [
    id,
    spaceId,
    entityType,
    entityId,
    conflict.field,
    conflict.kind,
    incomingOp.op_id,
    incomingOp.device_id,
    JSON.stringify(conflict.incomingHlc),
    conflict.existingHlc ? JSON.stringify(conflict.existingHlc) : null,
    conflict.localValue === undefined ? null : JSON.stringify(conflict.localValue),
    conflict.incomingValue === undefined ? null : JSON.stringify(conflict.incomingValue),
    conflict.winner,
    conflict.copyEntityType ?? null,
    conflict.copyEntityId ?? null,
    cursor,
  ];
}

async function insertConflict(
  client: Queryable,
  spaceId: string,
  entityType: string,
  entityId: string,
  conflict: ApplyResult['conflicts'][number],
  incomingOp: SyncOp,
  cursor: string,
): Promise<SyncConflictRecord> {
  const values = conflictRowValues(spaceId, entityType, entityId, conflict, incomingOp, cursor);
  const inserted = await client.query<ConflictRow>(
    `INSERT INTO conflicts
       (id, space_id, entity_type, entity_id, field, kind, incoming_op_id,
        incoming_device_id, incoming_hlc, existing_hlc, local_value, incoming_value,
        winner, copy_entity_type, copy_entity_id, cursor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    values,
  );
  if (inserted.rows[0]) return rowToConflict(inserted.rows[0]);
  const existing = await client.query<ConflictRow>(
    'SELECT * FROM conflicts WHERE id = $1',
    [values[0]],
  );
  return rowToConflict(existing.rows[0]!);
}

async function insertServerCopyOp(
  client: Queryable,
  clock: HlcClock,
  copy: EntityState,
  incoming: SyncOp,
): Promise<{ cursor: string; state: EntityState; hlc: Hlc }> {
  const hlc = clock.receive(incoming.hlc);
  const vvAfterServer = advanceVv(copy.vv, 'server');
  const fieldClocks: FieldClocks = {};
  const fieldVvs: FieldVvs = {};
  for (const field of Object.keys(copy.fields)) {
    fieldClocks[field] = { ...hlc };
    fieldVvs[field] = { ...vvAfterServer };
  }
  const state: EntityState = {
    ...copy,
    fieldClocks,
    fieldVvs,
    vv: vvAfterServer,
    hlc: { ...hlc },
    version: Math.max(1, copy.version),
  };
  const opId = `srv_${stableHash(`${incoming.op_id}\u0000${copy.entityId}`).slice(0, 48)}`;

  await client.query(
    `INSERT INTO sync_entities
       (space_id, entity_type, entity_id, fields, field_clocks, field_vvs, vv,
        deleted, hlc_ms, hlc_c, hlc_d, version)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12)
     ON CONFLICT (space_id, entity_type, entity_id) DO NOTHING`,
    [
      state.spaceId,
      state.entityType,
      state.entityId,
      JSON.stringify(state.fields),
      JSON.stringify(state.fieldClocks),
      JSON.stringify(state.fieldVvs),
      JSON.stringify(state.vv),
      state.deleted,
      hlc.ms,
      hlc.c,
      hlc.d,
      state.version,
    ],
  );

  const inserted = await client.query<{ seq: string }>(
    `INSERT INTO sync_ops
       (op_id, origin, space_id, device_id, entity_type, entity_id, op_type,
        hlc_ms, hlc_c, hlc_d, base_vv, payload, warning)
     VALUES ($1,'server',$2,NULL,$3,$4,'upsert',$5,$6,$7,$8::jsonb,$9::jsonb,'conflict_copy')
     ON CONFLICT (op_id) DO NOTHING
     RETURNING seq`,
    [
      opId,
      state.spaceId,
      state.entityType,
      state.entityId,
      hlc.ms,
      hlc.c,
      hlc.d,
      JSON.stringify(copy.vv),
      JSON.stringify(state.fields),
    ],
  );
  if (inserted.rows[0]) {
    return { cursor: inserted.rows[0].seq, state, hlc };
  }
  const existing = await client.query<{ seq: string }>(
    'SELECT seq FROM sync_ops WHERE op_id = $1',
    [opId],
  );
  return { cursor: existing.rows[0]?.seq ?? '0', state, hlc };
}

export class SyncService {
  private readonly clock: HlcClock;

  constructor(
    private readonly pool: DbPool,
    private readonly storage: StorageService,
    clock?: HlcClock,
  ) {
    this.clock = clock ?? new HlcClock('server');
  }

  async push(device: DeviceRow, ops: SyncOp[]): Promise<PushResponse> {
    const client = await this.pool.connect();
    const applied: AppliedOp[] = [];
    const duplicates: AppliedOp[] = [];
    const conflicts: SyncConflictRecord[] = [];
    const warnings: { opId: string; warning: string }[] = [];

    try {
      await client.query('BEGIN');
      for (const op of ops) {
        if (op.device_id !== device.id) {
          throw errors.forbidden(
            `op ${op.op_id} 的 device_id 与当前设备不一致`,
            'OP_DEVICE_MISMATCH',
          );
        }

        const now = Date.now();
        const warning =
          op.hlc.ms > now + CLOCK_SKEW_WARNING_MS
            ? `clock_skew_future:+${op.hlc.ms - now}ms`
            : null;
        if (warning) warnings.push({ opId: op.op_id, warning });

        const insertedOp = await client.query<{ seq: string }>(
          `INSERT INTO sync_ops
             (op_id, origin, space_id, device_id, entity_type, entity_id, op_type,
              hlc_ms, hlc_c, hlc_d, base_vv, payload, client_created_at, warning)
           VALUES ($1,'client',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)
           ON CONFLICT (op_id) DO NOTHING
           RETURNING seq`,
          [
            op.op_id,
            op.space_id,
            device.id,
            op.entity_type,
            op.entity_id,
            op.op_type,
            op.hlc.ms,
            op.hlc.c,
            op.hlc.d,
            JSON.stringify(op.base_vv ?? {}),
            JSON.stringify(op.payload ?? {}),
            op.created_at ? new Date(op.created_at) : null,
            warning,
          ],
        );

        if (!insertedOp.rows[0]) {
          const existing = await client.query<{ seq: string }>(
            'SELECT seq FROM sync_ops WHERE op_id = $1',
            [op.op_id],
          );
          duplicates.push({ opId: op.op_id, cursor: existing.rows[0]?.seq ?? '0', duplicate: true });
          continue;
        }
        const incomingCursor = insertedOp.rows[0].seq;

        await client.query(
          `INSERT INTO sync_entities (space_id, entity_type, entity_id)
           VALUES ($1,$2,$3)
           ON CONFLICT (space_id, entity_type, entity_id) DO NOTHING`,
          [op.space_id, op.entity_type, op.entity_id],
        );
        const stateResult = await client.query<EntityRow>(
          `SELECT * FROM sync_entities
           WHERE space_id = $1 AND entity_type = $2 AND entity_id = $3
           FOR UPDATE`,
          [op.space_id, op.entity_type, op.entity_id],
        );
        const state = stateResult.rows[0]!;
        const current = rowToEntityState(state);
        const result = applyOperation(current, op);

        await client.query(
          `UPDATE sync_entities
              SET fields = $4::jsonb,
                  field_clocks = $5::jsonb,
                  field_vvs = $6::jsonb,
                  vv = $7::jsonb,
                  deleted = $8,
                  hlc_ms = $9,
                  hlc_c = $10,
                  hlc_d = $11,
                  version = $12,
                  updated_at = now()
            WHERE space_id = $1 AND entity_type = $2 AND entity_id = $3`,
          [
            op.space_id,
            op.entity_type,
            op.entity_id,
            JSON.stringify(result.state.fields),
            JSON.stringify(result.state.fieldClocks),
            JSON.stringify(result.state.fieldVvs),
            JSON.stringify(result.state.vv),
            result.state.deleted,
            result.state.hlc?.ms ?? null,
            result.state.hlc?.c ?? null,
            result.state.hlc?.d ?? null,
            result.state.version,
          ],
        );

        const copyCursorByEntity = new Map<string, string>();
        for (const copy of result.conflictCopies) {
          const written = await insertServerCopyOp(client, this.clock, copy, op);
          copyCursorByEntity.set(copy.entityId, written.cursor);
        }

        for (const conflict of result.conflicts) {
          const cursor = conflict.copyEntityId
            ? (copyCursorByEntity.get(conflict.copyEntityId) ?? incomingCursor)
            : incomingCursor;
          conflicts.push(
            await insertConflict(
              client,
              op.space_id,
              op.entity_type,
              op.entity_id,
              conflict,
              op,
              cursor,
            ),
          );
        }

        applied.push({ opId: op.op_id, cursor: incomingCursor, duplicate: false });
      }

      await client.query(
        `UPDATE device_sync_state
            SET last_push_at = now(), updated_at = now()
          WHERE device_id = $1`,
        [device.id],
      );
      const latest = await client.query<{ seq: string | null }>(
        'SELECT max(seq)::text AS seq FROM sync_ops',
      );
      await client.query('COMMIT');
      return {
        ok: true,
        applied,
        duplicates,
        conflicts,
        warnings,
        nextCursor: latest.rows[0]?.seq ?? '0',
        latestCursor: latest.rows[0]?.seq ?? '0',
        serverTime: new Date().toISOString(),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async pull(
    device: DeviceRow,
    inputCursor: unknown,
    inputLimit: unknown,
    spaceId = 'personal',
  ): Promise<PullResponse> {
    const stateResult = await this.pool.query<{ last_pull_cursor: string }>(
      'SELECT last_pull_cursor FROM device_sync_state WHERE device_id = $1',
      [device.id],
    );
    const storedCursor = cursorString(stateResult.rows[0]?.last_pull_cursor);
    const cursor = parseCursor(inputCursor, storedCursor);
    let limit = 200;
    if (inputLimit !== undefined && inputLimit !== null && inputLimit !== '') {
      const parsed = Number(inputLimit);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw errors.badRequest('limit 必须是 1..500 的整数');
      }
      limit = Math.min(parsed, MAX_PULL_LIMIT);
    }

    const rows = await this.pool.query<SyncOpRow>(
      `SELECT * FROM sync_ops
        WHERE seq > $1::bigint AND space_id = $2
        ORDER BY seq ASC
        LIMIT $3`,
      [cursor, spaceId, limit + 1],
    );
    const hasMore = rows.rows.length > limit;
    const page = rows.rows.slice(0, limit);
    const ops: SyncOpWithCursor[] = page.map(rowToOp);
    const nextCursor = page.length > 0 ? page[page.length - 1]!.seq : cursor;
    const latestResult = await this.pool.query<{ seq: string | null }>(
      'SELECT max(seq)::text AS seq FROM sync_ops',
    );
    const latestCursor = latestResult.rows[0]?.seq ?? '0';

    const conflictResult = await this.pool.query<ConflictRow>(
      `SELECT * FROM conflicts
        WHERE cursor > $1::bigint AND cursor <= $2::bigint
        ORDER BY cursor ASC, created_at ASC
        LIMIT 100`,
      [cursor, nextCursor],
    );

    await this.pool.query(
      `INSERT INTO device_sync_state (device_id, last_pull_cursor, last_pull_at, updated_at)
       VALUES ($1, $2::bigint, now(), now())
       ON CONFLICT (device_id) DO UPDATE
         SET last_pull_cursor = GREATEST(device_sync_state.last_pull_cursor, EXCLUDED.last_pull_cursor),
             last_pull_at = now(),
             updated_at = now()`,
      [device.id, nextCursor],
    );

    return {
      ok: true,
      ops,
      nextCursor,
      latestCursor,
      hasMore,
      conflicts: conflictResult.rows.map(rowToConflict),
      serverTime: new Date().toISOString(),
    };
  }

  async status(device: DeviceRow, spaceId = 'personal'): Promise<SyncStatusResponse> {
    const [stateResult, latestResult, countResult, entityResult, conflictResult, conflictCount] =
      await Promise.all([
        this.pool.query<{
          last_pull_cursor: string;
          last_pull_at: Date | null;
          last_push_at: Date | null;
        }>(
          'SELECT last_pull_cursor, last_pull_at, last_push_at FROM device_sync_state WHERE device_id = $1',
          [device.id],
        ),
        this.pool.query<{ seq: string | null }>('SELECT max(seq)::text AS seq FROM sync_ops'),
        this.pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM sync_ops WHERE space_id = $1',
          [spaceId],
        ),
        this.pool.query<{ entity_type: string; count: string }>(
          `SELECT entity_type, count(*)::text AS count
             FROM sync_entities
            WHERE space_id = $1 AND deleted = false
            GROUP BY entity_type`,
          [spaceId],
        ),
        this.pool.query<ConflictRow>(
          `SELECT * FROM conflicts
            WHERE space_id = $1
            ORDER BY created_at DESC
            LIMIT 20`,
          [spaceId],
        ),
        this.pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM conflicts WHERE space_id = $1',
          [spaceId],
        ),
      ]);

    const state = stateResult.rows[0];
    const entityCounts: Record<string, number> = {};
    for (const row of entityResult.rows) entityCounts[row.entity_type] = Number(row.count);

    return {
      ok: true,
      device: {
        id: device.id,
        name: device.name,
        platform: device.platform,
        pairedAt: device.paired_at.toISOString(),
        lastSeenAt: iso(device.last_seen_at),
        accessExpiresAt: device.access_expires_at.toISOString(),
      },
      spaceId,
      cursor: cursorString(state?.last_pull_cursor),
      latestCursor: latestResult.rows[0]?.seq ?? '0',
      appliedOps: Number(countResult.rows[0]?.count ?? 0),
      lastPullAt: iso(state?.last_pull_at),
      lastPushAt: iso(state?.last_push_at),
      entityCounts,
      unresolvedConflicts: Number(conflictCount.rows[0]?.count ?? 0),
      conflicts: conflictResult.rows.map(rowToConflict),
      storage: this.storage.status(),
      serverTime: new Date().toISOString(),
    };
  }

  async getEntity(
    device: DeviceRow,
    spaceId: string,
    entityType: string,
    entityId: string,
  ): Promise<{ entity: EntityState; conflicts: SyncConflictRecord[] }> {
    void device;
    const [entityResult, conflictResult] = await Promise.all([
      this.pool.query<EntityRow>(
        `SELECT * FROM sync_entities
          WHERE space_id = $1 AND entity_type = $2 AND entity_id = $3`,
        [spaceId, entityType, entityId],
      ),
      this.pool.query<ConflictRow>(
        `SELECT * FROM conflicts
          WHERE space_id = $1 AND entity_type = $2 AND entity_id = $3
          ORDER BY created_at DESC`,
        [spaceId, entityType, entityId],
      ),
    ]);
    const row = entityResult.rows[0];
    if (!row) throw errors.notFound('实体不存在', 'ENTITY_NOT_FOUND');
    return {
      entity: rowToEntityState(row),
      conflicts: conflictResult.rows.map(rowToConflict),
    };
  }

  async listConflicts(spaceId = 'personal'): Promise<SyncConflictRecord[]> {
    const result = await this.pool.query<ConflictRow>(
      `SELECT * FROM conflicts
        WHERE space_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [spaceId],
    );
    return result.rows.map(rowToConflict);
  }
}
