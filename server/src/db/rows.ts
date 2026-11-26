import type {
  EntityState,
  FieldClocks,
  FieldVvs,
  Hlc,
  JsonObject,
  JsonValue,
  SyncConflictRecord,
  SyncOpWithCursor,
  VersionVector,
} from '../../../packages/shared/src/index.ts';

export type DeploymentRow = {
  id: string;
  name: string;
  passphrase_hash: string | null;
  passphrase_salt: string | null;
  passphrase_scheme: string | null;
  initialized_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type AdminSessionRow = {
  id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
};

export type DeviceRow = {
  id: string;
  name: string;
  platform: string;
  token_hash: string;
  refresh_token_hash: string;
  access_expires_at: Date;
  refresh_expires_at: Date;
  features: Record<string, boolean>;
  pairing_code_id: string | null;
  paired_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
};

export type SyncOpRow = {
  seq: string;
  op_id: string;
  origin: 'client' | 'server';
  space_id: string;
  device_id: string | null;
  entity_type: string;
  entity_id: string;
  op_type: 'upsert' | 'patch' | 'delete' | 'yupdate';
  hlc_ms: string;
  hlc_c: number;
  hlc_d: string;
  base_vv: VersionVector;
  payload: JsonObject;
  client_created_at: Date | null;
  received_at: Date;
  warning: string | null;
};

export type EntityRow = {
  space_id: string;
  entity_type: string;
  entity_id: string;
  fields: JsonObject;
  field_clocks: FieldClocks;
  field_vvs: FieldVvs;
  vv: VersionVector;
  deleted: boolean;
  hlc_ms: string | null;
  hlc_c: number | null;
  hlc_d: string | null;
  version: string;
  updated_at: Date;
};

export type ConflictRow = {
  id: string;
  space_id: string;
  entity_type: string;
  entity_id: string;
  field: string;
  kind: 'body_concurrent' | 'field_lww' | 'delete_lww';
  incoming_op_id: string;
  incoming_device_id: string | null;
  incoming_hlc: Hlc;
  existing_hlc: Hlc | null;
  local_value: JsonValue | null;
  incoming_value: JsonValue | null;
  winner: 'incoming' | 'existing';
  copy_entity_type: string | null;
  copy_entity_id: string | null;
  cursor: string;
  created_at: Date;
};

export type AttachmentRow = {
  id: string;
  space_id: string;
  note_id: string | null;
  block_id: string | null;
  file_name: string;
  sha256: string;
  byte_size: string;
  mime: string;
  storage_key: string;
  status: 'pending' | 'available' | 'deleted';
  created_by_device_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export function rowToEntityState(row: EntityRow): EntityState {
  return {
    spaceId: row.space_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    fields: row.fields ?? {},
    fieldClocks: row.field_clocks ?? {},
    fieldVvs: row.field_vvs ?? {},
    vv: row.vv ?? {},
    deleted: row.deleted,
    hlc:
      row.hlc_ms !== null && row.hlc_c !== null && row.hlc_d !== null
        ? { ms: Number(row.hlc_ms), c: row.hlc_c, d: row.hlc_d }
        : null,
    version: Number(row.version),
  };
}

export function rowToOp(row: SyncOpRow): SyncOpWithCursor {
  return {
    op_id: row.op_id,
    space_id: row.space_id,
    device_id: row.device_id ?? 'server',
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    op_type: row.op_type,
    hlc: { ms: Number(row.hlc_ms), c: row.hlc_c, d: row.hlc_d },
    base_vv: row.base_vv ?? {},
    payload: row.payload ?? {},
    created_at: (row.client_created_at ?? row.received_at).toISOString(),
    cursor: row.seq,
    origin: row.origin,
  };
}

export function rowToConflict(row: ConflictRow): SyncConflictRecord {
  return {
    id: row.id,
    spaceId: row.space_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    field: row.field,
    kind: row.kind,
    incomingOpId: row.incoming_op_id,
    incomingDeviceId: row.incoming_device_id,
    winner: row.winner,
    localValue: row.local_value ?? undefined,
    incomingValue: row.incoming_value ?? undefined,
    copyEntityType: row.copy_entity_type ?? undefined,
    copyEntityId: row.copy_entity_id ?? undefined,
    cursor: row.cursor,
    createdAt: row.created_at.toISOString(),
  };
}

export function attachmentToJson(row: AttachmentRow) {
  return {
    id: row.id,
    spaceId: row.space_id,
    noteId: row.note_id,
    blockId: row.block_id,
    fileName: row.file_name,
    sha256: row.sha256,
    byteSize: Number(row.byte_size),
    mime: row.mime,
    storageKey: row.storage_key,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deletedAt: iso(row.deleted_at),
  };
}
