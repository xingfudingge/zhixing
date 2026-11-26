-- 0005_lists_parent
-- ZX-UX-02 树状清单：父节点、同级排序索引、自引用防护。
--
-- 约定：
--   * 根清单 parent_id 为 NULL；旧数据执行 ADD COLUMN 后自然全部成为根级，
--     因此升级不会丢失或改变任何已有清单/任务。
--   * 收件箱是系统根节点：parent_id 必须为 NULL，由应用层与自检共同保证。
--   * 软删除模型下不做级联删除；父清单删除时子清单上移一级（应用层事务）。
--   * 层级深度、跨空间与环检测在 Rust 仓储事务内完成；这里的触发器只挡住
--     “自己当自己的父节点”这种最直接的错误。

ALTER TABLE lists ADD COLUMN parent_id TEXT REFERENCES lists(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_lists_parent
  ON lists(space_id, parent_id, sort_order);

-- 旧数据迁移：所有已有清单保持原顺序成为根级；收件箱固定为根级。
UPDATE lists SET parent_id = NULL WHERE is_inbox = 1 AND parent_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_lists_parent_self_insert
BEFORE INSERT ON lists
WHEN NEW.parent_id IS NOT NULL AND NEW.parent_id = NEW.id
BEGIN
  SELECT RAISE(ABORT, 'lists.parent_id cannot equal lists.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_lists_parent_self_update
BEFORE UPDATE OF parent_id ON lists
WHEN NEW.parent_id IS NOT NULL AND NEW.parent_id = NEW.id
BEGIN
  SELECT RAISE(ABORT, 'lists.parent_id cannot equal lists.id');
END;
