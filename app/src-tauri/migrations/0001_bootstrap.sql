-- 0001_bootstrap
-- 只建立迁移机制自检所需的元数据表；业务表由 P0-03 的迁移追加。
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO app_meta (key, value)
VALUES ('bootstrap', '0001_bootstrap')
ON CONFLICT(key) DO NOTHING;
