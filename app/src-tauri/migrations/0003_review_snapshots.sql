-- 0003_review_snapshots
-- P0-09 复盘快照：保存一次复盘的来源 ID 与生成笔记，便于从复盘笔记回链。
-- 约束：
--   * 快照只读源数据，绝不反写 tasks / focus_sessions / habit_logs。
--   * 同一 space + 范围只允许一条活动快照（部分唯一索引），重复保存幂等。
--   * task/focus/habit 的来源 ID 以 JSON 数组保存；源实体软删除后仍可追溯。

CREATE TABLE IF NOT EXISTS review_snapshots (
  id             TEXT PRIMARY KEY,
  space_id       TEXT NOT NULL DEFAULT 'personal',
  range_start    TEXT NOT NULL,
  range_end      TEXT NOT NULL,
  task_ids_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(task_ids_json)),
  focus_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(focus_ids_json)),
  habit_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(habit_ids_json)),
  note_id        TEXT REFERENCES notes(id) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at     TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  CHECK (range_start <= range_end)
);

-- 同一范围的活动快照只能有一条：重复点击保存不会生成第二份。
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_snapshots_range
  ON review_snapshots(space_id, range_start, range_end)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_review_snapshots_note
  ON review_snapshots(note_id);
CREATE INDEX IF NOT EXISTS idx_review_snapshots_created
  ON review_snapshots(deleted_at, created_at DESC);
