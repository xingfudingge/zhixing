//! 业务数据重置（AUD-005）。
//!
//! * 只清空业务表，保留 `settings`（设备/空间偏好）、`app_meta` 其他键、
//!   许可与安装信息所在的安全存储；不删除数据库文件，不重建 schema。
//! * 清空、重新写入种子、恢复 `domain_seed` 标记在同一个 SQLite 事务内。
//!   任何一步失败都会回滚，磁盘上的业务数据保持重置前状态。
//! * 附件二进制在 IndexedDB 中，不属于 SQLite 业务表；这里只清空附件元数据。

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

use super::seed::{self, SEED_MARKER_KEY};
use super::RepoError;
use crate::db::DbState;

/// 需要清空的业务表，按外键从子到父排列。
/// `settings` 故意不在列表内：偏好必须保留。
const BUSINESS_TABLES: &[&str] = &[
    "attachments",
    "board_edges",
    "board_nodes",
    "boards",
    "review_snapshots",
    "focus_sessions",
    "habit_logs",
    "habits",
    "countdowns",
    "events",
    "note_todos",
    "subtasks",
    "tasks",
    "note_blocks",
    "notes",
    "lists",
];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetDomainReport {
    /// 本次事务内删除的业务行数（含回收站）。
    pub deleted_rows: i64,
    /// 重置后保留的设置行数（设备偏好 + 空间偏好）。
    pub preserved_settings: i64,
    pub seed_applied: bool,
    pub samples_inserted: i64,
    pub inbox_created: bool,
    pub work_created: bool,
    pub seed_marker: String,
}

/// 清空业务数据并重新执行领域种子。
///
/// 该函数只接受已迁移的连接；整个操作是一个事务，失败自动回滚。
pub fn reset_domain(conn: &mut Connection) -> Result<ResetDomainReport, RepoError> {
    let tx = conn.transaction()?;

    // 先记录保留项数量，便于 UI 明确告诉用户“偏好没有被清掉”。
    let preserved_settings: i64 =
        tx.query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0))?;

    let mut deleted_rows = 0_i64;
    for table in BUSINESS_TABLES {
        // 表名来自本文件的静态白名单，不拼接用户输入。
        deleted_rows += tx.execute(&format!("DELETE FROM {table}"), [])? as i64;
    }

    // 删除标记后 reseed_after_reset 会强制写入示例，而不是走“已有数据”分支。
    tx.execute(
        "DELETE FROM app_meta WHERE key = ?1",
        params![SEED_MARKER_KEY],
    )?;

    let seeded = seed::reseed_after_reset(&tx)?;
    tx.commit()?;

    log::info!(
        "domain reset complete: deleted_rows={} preserved_settings={} samples={}",
        deleted_rows,
        preserved_settings,
        seeded.samples_inserted
    );

    Ok(ResetDomainReport {
        deleted_rows,
        preserved_settings,
        seed_applied: seeded.applied,
        samples_inserted: seeded.samples_inserted,
        inbox_created: seeded.inbox_created,
        work_created: seeded.work_created,
        seed_marker: seeded.marker,
    })
}

#[tauri::command]
pub fn db_reset_domain(state: State<'_, DbState>) -> Result<ResetDomainReport, String> {
    let mut connection = state.connection().map_err(|error| error.to_string())?;
    reset_domain(&mut connection).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::seed::SEED_VERSION;
    use crate::repositories::test_support;

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("count rows")
    }

    fn insert_user_business_data(conn: &Connection) {
        conn.execute(
            "INSERT INTO lists (id, space_id, name, sort_order, is_inbox)
             VALUES ('user-list', 'personal', '用户清单', 99, 0)",
            [],
        )
        .expect("insert user list");
        conn.execute(
            "INSERT INTO notes (id, space_id, title, body)
             VALUES ('user-note', 'personal', '用户笔记', '<p>保留我</p>')",
            [],
        )
        .expect("insert user note");
        conn.execute(
            "INSERT INTO tasks (id, space_id, list_id, title)
             VALUES ('user-task', 'personal', 'user-list', '用户任务')",
            [],
        )
        .expect("insert user task");
        conn.execute(
            "INSERT INTO events (id, space_id, title, start_date)
             VALUES ('user-event', 'personal', '用户日程', '2026-10-27')",
            [],
        )
        .expect("insert user event");
        conn.execute(
            "INSERT INTO habits (id, space_id, title)
             VALUES ('user-habit', 'personal', '用户习惯')",
            [],
        )
        .expect("insert user habit");
        conn.execute(
            "INSERT INTO settings (id, space_id, scope, setting_key, value_json)
             VALUES ('user-setting', 'personal', 'device', 'editor.fontSize', '20')",
            [],
        )
        .expect("insert device setting");
        conn.execute(
            "INSERT INTO settings (id, space_id, scope, setting_key, value_json)
             VALUES ('user-space-setting', 'personal', 'space', 'task.defaultList', '\"work\"')",
            [],
        )
        .expect("insert space setting");
        conn.execute(
            "INSERT INTO app_meta (key, value) VALUES ('keep_me', 'yes')",
            [],
        )
        .expect("insert unrelated meta");
    }

    #[test]
    fn reset_clears_business_rows_reseeds_and_preserves_preferences() {
        let (_dir, repository) = test_support::repository();
        let mut connection = repository.connection().expect("connection");
        insert_user_business_data(&connection);
        let schema_before = count(&connection, "schema_migrations");

        let report = reset_domain(&mut connection).expect("reset domain");

        assert!(report.deleted_rows >= 7);
        assert_eq!(report.preserved_settings, 3, "种子主题 + 两条用户设置");
        assert!(report.seed_applied);
        assert_eq!(report.seed_marker, SEED_VERSION);
        assert!(report.samples_inserted > 0);

        // 用户业务数据已不存在（包括回收站中的行）。
        for (table, id) in [
            ("lists", "user-list"),
            ("notes", "user-note"),
            ("tasks", "user-task"),
            ("events", "user-event"),
            ("habits", "user-habit"),
        ] {
            let found: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"),
                    params![id],
                    |row| row.get(0),
                )
                .expect("count user row");
            assert_eq!(found, 0, "{table} 中的用户数据必须被清空");
        }

        // 回到种子。
        for (table, id) in [
            ("lists", "inbox"),
            ("lists", "work"),
            ("lists", "life"),
            ("lists", "reading"),
            ("notes", "seed-note-welcome"),
            ("notes", "seed-note-workflow"),
            ("tasks", "seed-task-review"),
            ("tasks", "seed-task-inbox"),
            ("tasks", "seed-task-done"),
            ("boards", "seed-board-flow"),
        ] {
            let found: i64 = connection
                .query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1 AND deleted_at IS NULL"),
                    params![id],
                    |row| row.get(0),
                )
                .expect("count seeded row");
            assert_eq!(found, 1, "{table}/{id} 必须由种子恢复");
        }

        // 偏好与无关元数据保留。
        let font: String = connection
            .query_row(
                "SELECT value_json FROM settings WHERE id = 'user-setting'",
                [],
                |row| row.get(0),
            )
            .expect("device setting preserved");
        assert_eq!(font, "20");
        let keep: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'keep_me'",
                [],
                |row| row.get(0),
            )
            .expect("unrelated app_meta preserved");
        assert_eq!(keep, "yes");
        assert_eq!(count(&connection, "schema_migrations"), schema_before);
    }

    #[test]
    fn reset_is_idempotent() {
        let (_dir, repository) = test_support::repository();
        let mut connection = repository.connection().expect("connection");

        let first = reset_domain(&mut connection).expect("first reset");
        let notes_after_first = count(&connection, "notes");
        let tasks_after_first = count(&connection, "tasks");

        let second = reset_domain(&mut connection).expect("second reset");

        assert!(first.deleted_rows > 0);
        assert!(second.deleted_rows > 0);
        assert_eq!(count(&connection, "notes"), notes_after_first);
        assert_eq!(count(&connection, "tasks"), tasks_after_first);
        let welcome: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE id = 'seed-note-welcome'",
                [],
                |row| row.get(0),
            )
            .expect("welcome note");
        assert_eq!(welcome, 1, "重复重置不能重复插入种子");
    }

    #[test]
    fn failure_during_seed_rolls_back_deletes() {
        let (_dir, repository) = test_support::repository();
        let mut connection = repository.connection().expect("connection");
        insert_user_business_data(&connection);
        let tasks_before = count(&connection, "tasks");
        let lists_before = count(&connection, "lists");

        // 让种子在插入 review 任务时失败，验证清空也被回滚。
        connection
            .execute_batch(
                "CREATE TRIGGER force_seed_failure
                 BEFORE INSERT ON tasks
                 WHEN NEW.id = 'seed-task-review'
                 BEGIN
                   SELECT RAISE(ABORT, 'forced seed failure');
                 END;",
            )
            .expect("create failure trigger");

        let error = reset_domain(&mut connection).expect_err("reset must fail");
        assert!(error.to_string().contains("forced seed failure"));

        assert_eq!(count(&connection, "tasks"), tasks_before);
        assert_eq!(count(&connection, "lists"), lists_before);
        let user_task: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE id = 'user-task'",
                [],
                |row| row.get(0),
            )
            .expect("user task survives");
        assert_eq!(user_task, 1);
        let marker: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'domain_seed'",
                [],
                |row| row.get(0),
            )
            .expect("seed marker survives");
        assert_eq!(marker, SEED_VERSION);
    }
}
