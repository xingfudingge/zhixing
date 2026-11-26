-- 0002_domain
-- 知行 P0-03 领域表：单用户 workspace，没有 users / memberships / seats / accounts。
-- 约定：
--   * 主键统一为 TEXT（应用生成，便于离线创建与同步）。
--   * 每张业务表都有 created_at / updated_at / deleted_at / version。
--   * 删除一律软删除（deleted_at 非空）；仓储默认过滤已删除行。
--   * space_id 只是同步命名空间，不是权限边界；默认 'personal'。
--   * 外键全部显式声明并建立索引，避免孤儿行。

------------------------------------------------------------------------------
-- 任务清单
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lists (
  id         TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL DEFAULT 'personal',
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  color      TEXT NOT NULL DEFAULT '#5579d5',
  icon       TEXT NOT NULL DEFAULT '',
  sort_order REAL NOT NULL DEFAULT 0,
  is_inbox   INTEGER NOT NULL DEFAULT 0 CHECK (is_inbox IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  version    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_lists_space
  ON lists(space_id, deleted_at, sort_order);
-- 每个空间最多一个可用收件箱（软删除后允许重建）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_lists_active_inbox
  ON lists(space_id)
  WHERE is_inbox = 1 AND deleted_at IS NULL;

------------------------------------------------------------------------------
-- 知识：笔记、块投影、笔记待办
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL DEFAULT 'personal',
  title      TEXT NOT NULL DEFAULT '',
  folder_id  TEXT,
  tags_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  body       TEXT NOT NULL DEFAULT '',
  body_format TEXT NOT NULL DEFAULT 'html' CHECK (body_format IN ('html', 'blocks')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trashed')),
  favorite   INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
  pinned     INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  version    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_notes_folder
  ON notes(folder_id, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_status
  ON notes(space_id, status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_notes_updated
  ON notes(deleted_at, updated_at DESC);

-- 块模型是编辑器的权威投影（正文另由编辑器快照承载）。order_key 支持小数插入。
CREATE TABLE IF NOT EXISTS note_blocks (
  id             TEXT PRIMARY KEY,
  note_id        TEXT NOT NULL REFERENCES notes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  block_type     TEXT NOT NULL CHECK (length(trim(block_type)) > 0),
  order_key      REAL NOT NULL DEFAULT 0,
  payload_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at     TEXT,
  version        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_note_blocks_note
  ON note_blocks(note_id, deleted_at, order_key);

-- 笔记内待办与全局任务状态独立；只通过 task_id 显式关联，不做级联状态镜像。
CREATE TABLE IF NOT EXISTS note_todos (
  id               TEXT PRIMARY KEY,
  space_id         TEXT NOT NULL DEFAULT 'personal',
  note_id          TEXT NOT NULL REFERENCES notes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  task_id          TEXT REFERENCES tasks(id) ON UPDATE CASCADE ON DELETE SET NULL,
  title            TEXT NOT NULL CHECK (length(trim(title)) > 0),
  done             INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  due_date         TEXT,
  reminder_enabled INTEGER NOT NULL DEFAULT 0 CHECK (reminder_enabled IN (0, 1)),
  sort_order       REAL NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at       TEXT,
  version          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_note_todos_note
  ON note_todos(note_id, deleted_at, sort_order);
CREATE INDEX IF NOT EXISTS idx_note_todos_task
  ON note_todos(task_id);

------------------------------------------------------------------------------
-- 行动：任务与子任务
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL DEFAULT 'personal',
  list_id      TEXT NOT NULL REFERENCES lists(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  parent_id    TEXT REFERENCES tasks(id) ON UPDATE CASCADE ON DELETE SET NULL,
  note_id      TEXT REFERENCES notes(id) ON UPDATE CASCADE ON DELETE SET NULL,
  title        TEXT NOT NULL CHECK (length(trim(title)) > 0),
  notes        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
  priority     INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  quadrant     INTEGER NOT NULL DEFAULT 0 CHECK (quadrant BETWEEN 0 AND 4),
  due_date     TEXT,
  due_time     TEXT,
  due_at       TEXT,
  tz           TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  reminder     TEXT NOT NULL DEFAULT '',
  sort_order   REAL NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at   TEXT,
  version      INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_tasks_list
  ON tasks(list_id, deleted_at, sort_order);
CREATE INDEX IF NOT EXISTS idx_tasks_due
  ON tasks(due_date, deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks(status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_note
  ON tasks(note_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent
  ON tasks(parent_id);

CREATE TABLE IF NOT EXISTS subtasks (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON UPDATE CASCADE ON DELETE CASCADE,
  title      TEXT NOT NULL CHECK (length(trim(title)) > 0),
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  version    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_subtasks_task
  ON subtasks(task_id, deleted_at, sort_order);

------------------------------------------------------------------------------
-- 时间：事件与倒数日
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL DEFAULT 'personal',
  title        TEXT NOT NULL CHECK (length(trim(title)) > 0),
  event_type   TEXT NOT NULL DEFAULT '个人日程',
  all_day      INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
  start_date   TEXT NOT NULL,
  start_at     TEXT,
  end_at       TEXT,
  tz           TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  source       TEXT NOT NULL DEFAULT 'local',
  external_uid TEXT,
  repeat_rule  TEXT NOT NULL DEFAULT '单次',
  note_id      TEXT REFERENCES notes(id) ON UPDATE CASCADE ON DELETE SET NULL,
  color        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at   TEXT,
  version      INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_events_date
  ON events(start_date, deleted_at);
CREATE INDEX IF NOT EXISTS idx_events_note
  ON events(note_id);

CREATE TABLE IF NOT EXISTS countdowns (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL DEFAULT 'personal',
  title         TEXT NOT NULL CHECK (length(trim(title)) > 0),
  category      TEXT NOT NULL DEFAULT '自定义',
  calendar_type TEXT NOT NULL DEFAULT 'solar' CHECK (calendar_type IN ('solar', 'lunar')),
  target_date   TEXT NOT NULL,
  repeat_rule   TEXT NOT NULL DEFAULT '单次',
  lunar_month   TEXT,
  lunar_day     INTEGER,
  note          TEXT NOT NULL DEFAULT '',
  color         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at    TEXT,
  version       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_countdowns_target
  ON countdowns(target_date, deleted_at);
CREATE INDEX IF NOT EXISTS idx_countdowns_category
  ON countdowns(category, deleted_at);

------------------------------------------------------------------------------
-- 习惯与打卡
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS habits (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL DEFAULT 'personal',
  title         TEXT NOT NULL CHECK (length(trim(title)) > 0),
  schedule      TEXT NOT NULL DEFAULT '每天',
  icon          TEXT NOT NULL DEFAULT '',
  color         TEXT NOT NULL DEFAULT 'blue',
  goal_per_week INTEGER NOT NULL DEFAULT 7 CHECK (goal_per_week BETWEEN 0 AND 7),
  sort_order    REAL NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at    TEXT,
  version       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_habits_space
  ON habits(space_id, deleted_at, sort_order);

CREATE TABLE IF NOT EXISTS habit_logs (
  id         TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL DEFAULT 'personal',
  habit_id   TEXT NOT NULL REFERENCES habits(id) ON UPDATE CASCADE ON DELETE CASCADE,
  log_date   TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 1 CHECK (done IN (0, 1)),
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  version    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (habit_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_habit_logs_date
  ON habit_logs(log_date, deleted_at);

------------------------------------------------------------------------------
-- 专注
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS focus_sessions (
  id         TEXT PRIMARY KEY,
  space_id   TEXT NOT NULL DEFAULT 'personal',
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON UPDATE CASCADE ON DELETE CASCADE,
  minutes    INTEGER NOT NULL CHECK (minutes > 0),
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  mode       TEXT NOT NULL DEFAULT 'countdown',
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  version    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_focus_sessions_started
  ON focus_sessions(started_at, deleted_at);
CREATE INDEX IF NOT EXISTS idx_focus_sessions_task
  ON focus_sessions(task_id, deleted_at);

------------------------------------------------------------------------------
-- 画板
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS boards (
  id            TEXT PRIMARY KEY,
  space_id      TEXT NOT NULL DEFAULT 'personal',
  note_id       TEXT REFERENCES notes(id) ON UPDATE CASCADE ON DELETE SET NULL,
  title         TEXT NOT NULL CHECK (length(trim(title)) > 0),
  background    TEXT NOT NULL DEFAULT 'dot',
  snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(snapshot_json)),
  thumbnail_key TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at    TEXT,
  version       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_boards_space
  ON boards(space_id, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_boards_note
  ON boards(note_id);

CREATE TABLE IF NOT EXISTS board_nodes (
  id           TEXT PRIMARY KEY,
  board_id     TEXT NOT NULL REFERENCES boards(id) ON UPDATE CASCADE ON DELETE CASCADE,
  node_type    TEXT NOT NULL DEFAULT 'process',
  x            REAL NOT NULL DEFAULT 0,
  y            REAL NOT NULL DEFAULT 0,
  width        REAL NOT NULL DEFAULT 150,
  height       REAL NOT NULL DEFAULT 60,
  rotation     REAL NOT NULL DEFAULT 0,
  z_index      INTEGER NOT NULL DEFAULT 0,
  text         TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at   TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  -- 供 board_edges 复合外键使用：连线两端的节点必须属于同一画板。
  UNIQUE (board_id, id)
);

CREATE INDEX IF NOT EXISTS idx_board_nodes_board
  ON board_nodes(board_id, deleted_at, z_index);

CREATE TABLE IF NOT EXISTS board_edges (
  id           TEXT PRIMARY KEY,
  board_id     TEXT NOT NULL REFERENCES boards(id) ON UPDATE CASCADE ON DELETE CASCADE,
  from_node_id TEXT NOT NULL,
  to_node_id   TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  style_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(style_json)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at   TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  CHECK (from_node_id <> to_node_id),
  FOREIGN KEY (board_id, from_node_id)
    REFERENCES board_nodes(board_id, id) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (board_id, to_node_id)
    REFERENCES board_nodes(board_id, id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_board_edges_board
  ON board_edges(board_id, deleted_at);

------------------------------------------------------------------------------
-- 附件元数据（内容寻址；二进制不进数据库）
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL DEFAULT 'personal',
  note_id     TEXT REFERENCES notes(id) ON UPDATE CASCADE ON DELETE CASCADE,
  block_id    TEXT,
  file_name   TEXT NOT NULL,
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_size   INTEGER NOT NULL CHECK (byte_size >= 0),
  mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
  storage_key TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (sha256)
);

CREATE INDEX IF NOT EXISTS idx_attachments_note
  ON attachments(note_id, deleted_at);

------------------------------------------------------------------------------
-- 设置（device 本机 / space 可同步）
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL DEFAULT 'personal',
  scope       TEXT NOT NULL DEFAULT 'space' CHECK (scope IN ('device', 'space')),
  setting_key TEXT NOT NULL CHECK (length(trim(setting_key)) > 0),
  value_json  TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(value_json)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (space_id, scope, setting_key)
);

CREATE INDEX IF NOT EXISTS idx_settings_scope
  ON settings(space_id, scope, deleted_at);

------------------------------------------------------------------------------
-- 迁移自检标记
------------------------------------------------------------------------------
INSERT INTO app_meta (key, value)
VALUES ('domain_schema', '0002_domain')
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
