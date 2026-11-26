-- 知行后台 P2-01 初始 schema（PostgreSQL 16）
--
-- 单用户、无账号、无成员、无席位：本库没有 users / accounts / memberships /
-- seats / workspaces 表。设备是唯一访问主体；space_id 只是同步分区。
--
-- 约定：
--   * 业务实体以 op_log 为权威，sync_entities 是可重建的合并投影；
--   * op_id 全局唯一，重复 push 不会二次写入；
--   * 冲突正文另存独立 note/board 实体，绝不静默覆盖。

------------------------------------------------------------------------------
-- 部署单例与管理员会话
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deployment (
  id                TEXT PRIMARY KEY CHECK (id = 'default'),
  name              TEXT NOT NULL DEFAULT '知行',
  passphrase_hash   TEXT,
  passphrase_salt   TEXT,
  passphrase_scheme TEXT,
  initialized_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO deployment (id, name)
VALUES ('default', '知行')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS admin_sessions (
  id           TEXT PRIMARY KEY,
  token_hash   CHAR(64) NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry
  ON admin_sessions(expires_at)
  WHERE revoked_at IS NULL;

------------------------------------------------------------------------------
-- 设备配对
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pairing_codes (
  id                  TEXT PRIMARY KEY,
  code_hash           CHAR(64) NOT NULL UNIQUE,
  label               TEXT NOT NULL DEFAULT '',
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at          TIMESTAMPTZ NOT NULL,
  used_at             TIMESTAMPTZ,
  used_by_device_id   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pairing_codes_expiry
  ON pairing_codes(expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS devices (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL CHECK (length(trim(name)) > 0),
  platform            TEXT NOT NULL CHECK (
                        platform IN ('macos', 'windows', 'linux', 'ios', 'android', 'web')
                      ),
  token_hash          CHAR(64) NOT NULL UNIQUE,
  refresh_token_hash  CHAR(64) NOT NULL UNIQUE,
  access_expires_at   TIMESTAMPTZ NOT NULL,
  refresh_expires_at  TIMESTAMPTZ NOT NULL,
  features            JSONB NOT NULL DEFAULT '{"sync": true, "attachments": true}'::jsonb,
  pairing_code_id     TEXT REFERENCES pairing_codes(id) ON DELETE SET NULL,
  paired_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devices_active
  ON devices(paired_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS device_sync_state (
  device_id         TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  last_pull_cursor  BIGINT NOT NULL DEFAULT 0 CHECK (last_pull_cursor >= 0),
  last_pull_at      TIMESTAMPTZ,
  last_push_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

------------------------------------------------------------------------------
-- 操作日志（全局游标）
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_ops (
  seq               BIGSERIAL PRIMARY KEY,
  op_id             TEXT NOT NULL UNIQUE,
  origin            TEXT NOT NULL DEFAULT 'client' CHECK (origin IN ('client', 'server')),
  space_id          TEXT NOT NULL DEFAULT 'personal',
  device_id         TEXT REFERENCES devices(id) ON DELETE SET NULL,
  entity_type       TEXT NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  entity_id         TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 200),
  op_type           TEXT NOT NULL CHECK (op_type IN ('upsert', 'patch', 'delete', 'yupdate')),
  hlc_ms            BIGINT NOT NULL CHECK (hlc_ms >= 0),
  hlc_c             INTEGER NOT NULL CHECK (hlc_c >= 0),
  hlc_d             TEXT NOT NULL CHECK (length(hlc_d) BETWEEN 1 AND 64),
  base_vv           JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_created_at TIMESTAMPTZ,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  warning           TEXT,
  CHECK (origin = 'server' OR device_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_sync_ops_entity
  ON sync_ops(space_id, entity_type, entity_id, seq);
CREATE INDEX IF NOT EXISTS idx_sync_ops_device
  ON sync_ops(device_id, seq DESC);

------------------------------------------------------------------------------
-- 合并投影：字段时钟 + 字段版本向量 + 实体版本向量
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_entities (
  space_id      TEXT NOT NULL DEFAULT 'personal',
  entity_type   TEXT NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  entity_id     TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 200),
  fields        JSONB NOT NULL DEFAULT '{}'::jsonb,
  field_clocks  JSONB NOT NULL DEFAULT '{}'::jsonb,
  field_vvs     JSONB NOT NULL DEFAULT '{}'::jsonb,
  vv            JSONB NOT NULL DEFAULT '{}'::jsonb,
  deleted       BOOLEAN NOT NULL DEFAULT FALSE,
  hlc_ms        BIGINT,
  hlc_c         INTEGER,
  hlc_d         TEXT,
  version       BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_entities_type
  ON sync_entities(entity_type, deleted, updated_at DESC);

------------------------------------------------------------------------------
-- 冲突审计与冲突副本索引
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conflicts (
  id                 TEXT PRIMARY KEY,
  space_id           TEXT NOT NULL DEFAULT 'personal',
  entity_type        TEXT NOT NULL,
  entity_id          TEXT NOT NULL,
  field              TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('body_concurrent', 'field_lww', 'delete_lww')),
  incoming_op_id     TEXT NOT NULL,
  incoming_device_id TEXT,
  incoming_hlc       JSONB NOT NULL,
  existing_hlc       JSONB,
  local_value        JSONB,
  incoming_value     JSONB,
  winner             TEXT NOT NULL CHECK (winner IN ('incoming', 'existing')),
  copy_entity_type   TEXT,
  copy_entity_id     TEXT,
  cursor             BIGINT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conflicts_cursor ON conflicts(cursor);
CREATE INDEX IF NOT EXISTS idx_conflicts_entity
  ON conflicts(space_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_copy
  ON conflicts(copy_entity_id)
  WHERE copy_entity_id IS NOT NULL;

------------------------------------------------------------------------------
-- 附件元数据（内容寻址；二进制在 MinIO/S3，配置见 docker-compose.yml）
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  id                  TEXT PRIMARY KEY,
  space_id            TEXT NOT NULL DEFAULT 'personal',
  note_id             TEXT,
  block_id            TEXT,
  file_name           TEXT NOT NULL CHECK (length(trim(file_name)) > 0),
  sha256              CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size           BIGINT NOT NULL CHECK (byte_size >= 0),
  mime                TEXT NOT NULL DEFAULT 'application/octet-stream',
  storage_key         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'available', 'deleted')),
  created_by_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  UNIQUE (space_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_attachments_note
  ON attachments(space_id, note_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_attachments_status
  ON attachments(status, created_at DESC);
