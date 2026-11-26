-- 笔记内容加密（ZX11-PRIVACY-ENC-01）
--
-- 只给内容字段增加“是否已加密”标记；正文/标题/标签/块 payload/待办标题
-- 的密文仍存放在原字段，前缀为 zxnote:v1:<keyId>:<base64url>。
-- 目录、状态、收藏、置顶、时间戳与 id 保持明文，用于列表与排序。
--
-- 密钥信封不在 SQLite：存系统钥匙串；钥匙串不可用时回退到应用数据目录
-- 的 0600 note-encryption-envelope.json。SQLite 中只保存 keyId 与开关，
-- 不保存明文密钥、口令或 KEK。

ALTER TABLE notes ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0, 1));
ALTER TABLE note_blocks ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0, 1));
ALTER TABLE note_todos ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0, 1));

-- 原表的 tags_json / payload_json 有 json_valid CHECK，不能直接放密文。
-- 加密时把原列写为合法空 JSON，密文放旁路列；关闭加密时再写回。
ALTER TABLE notes ADD COLUMN encrypted_tags_json TEXT;
ALTER TABLE note_blocks ADD COLUMN encrypted_payload_json TEXT;

CREATE INDEX IF NOT EXISTS idx_notes_encrypted
  ON notes(encrypted, deleted_at);

CREATE TABLE IF NOT EXISTS note_encryption_meta (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  key_id     TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO note_encryption_meta (id, enabled, key_id) VALUES (1, 0, NULL);
