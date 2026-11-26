-- 加密旧页清理状态（ZX11-FIX-ENC-01）
--
-- 0006 只做逐字段 AEAD。加密事务把明文行 UPDATE 成密文后，旧行仍可能停留在
-- SQLite 页内空闲区；`secure_delete=FAST` 不会清除这些字节。从 0007 开始：
--   * 连接统一 `PRAGMA secure_delete=ON`；
--   * 加密成功后必须 VACUUM + WAL checkpoint(TRUNCATE)；
--   * 用 scrub_pending 记录“已切换为密文、但旧页尚未清理”的状态，
--     应用启动/锁定时重试，避免崩溃或中途退出后永久残留。
--
-- 迁移到 0007 时，已有加密库会置为 pending=1，因此升级用户第一次启动就会
-- 执行一次清理；全新库（未启用加密）保持 0。

ALTER TABLE note_encryption_meta
  ADD COLUMN scrub_pending INTEGER NOT NULL DEFAULT 0 CHECK (scrub_pending IN (0, 1));

UPDATE note_encryption_meta
SET scrub_pending = CASE
  WHEN enabled = 1 OR EXISTS (SELECT 1 FROM notes WHERE encrypted = 1) THEN 1
  ELSE 0
END
WHERE id = 1;
