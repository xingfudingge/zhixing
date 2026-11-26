//! 领域种子数据。
//!
//! 规则：
//! * 只执行一次（`app_meta.domain_seed` 标记），重复启动 / migrate 不会重复插入。
//! * 全部使用固定 ID + `ON CONFLICT DO NOTHING`，绝不覆盖用户已有数据。
//! * 如果库里已经有任何业务数据，只补收件箱 / 工作清单，不注入示例内容。
//! * 收件箱是产品不变量；即使种子已执行，也会在缺失时补建。

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use super::{RepoError, DEFAULT_SPACE_ID};

pub const SEED_VERSION: &str = "0002_domain";
pub const SEED_MARKER_KEY: &str = "domain_seed";
pub const INBOX_LIST_ID: &str = "inbox";
pub const WORK_LIST_ID: &str = "work";
pub const WELCOME_NOTE_ID: &str = "seed-note-welcome";
pub const WORKFLOW_NOTE_ID: &str = "seed-note-workflow";
pub const REVIEW_TASK_ID: &str = "seed-task-review";
pub const INBOX_TASK_ID: &str = "seed-task-inbox";
pub const DONE_TASK_ID: &str = "seed-task-done";
pub const BOARD_ID: &str = "seed-board-flow";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedReport {
    pub applied: bool,
    pub marker: String,
    pub samples_inserted: i64,
    pub inbox_created: bool,
    pub work_created: bool,
}

impl SeedReport {
    fn skipped() -> Self {
        Self {
            applied: false,
            marker: SEED_VERSION.to_string(),
            samples_inserted: 0,
            inbox_created: false,
            work_created: false,
        }
    }
}

/// 在已应用迁移的连接上确保种子数据存在。调用方负责事务边界。
pub fn ensure_seed(conn: &mut Connection) -> Result<SeedReport, RepoError> {
    let marker: Option<String> = conn
        .query_row(
            "SELECT value FROM app_meta WHERE key = ?1",
            params![SEED_MARKER_KEY],
            |row| row.get(0),
        )
        .optional()?;

    if marker.as_deref() == Some(SEED_VERSION) {
        return Ok(SeedReport::skipped());
    }

    let tx = conn.transaction()?;

    // 先记录既有业务数据量，避免把种子算成用户数据。
    let existing_rows: i64 = tx.query_row(
        "SELECT
           (SELECT COUNT(*) FROM lists) +
           (SELECT COUNT(*) FROM tasks) +
           (SELECT COUNT(*) FROM notes) +
           (SELECT COUNT(*) FROM boards)",
        [],
        |row| row.get(0),
    )?;

    let (inbox_created, work_created) = ensure_core_lists(&tx)?;

    let mut samples_inserted = 0_i64;
    if existing_rows == 0 {
        samples_inserted += seed_samples(&tx)?;
    }

    write_marker(&tx)?;
    tx.commit()?;

    log::info!(
        "domain seed applied: marker={} samples={} inbox_created={} work_created={}",
        SEED_VERSION,
        samples_inserted,
        inbox_created,
        work_created
    );

    Ok(SeedReport {
        applied: true,
        marker: SEED_VERSION.to_string(),
        samples_inserted,
        inbox_created,
        work_created,
    })
}

/// 确保收件箱（产品不变量）与「工作」清单存在；返回是否新建。
fn ensure_core_lists(tx: &Transaction<'_>) -> Result<(bool, bool), RepoError> {
    let has_active_inbox: bool = tx.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM lists
           WHERE space_id = ?1 AND is_inbox = 1 AND deleted_at IS NULL
         )",
        params![DEFAULT_SPACE_ID],
        |row| row.get::<_, i64>(0).map(|value| value != 0),
    )?;

    let mut inbox_created = false;
    if !has_active_inbox {
        inbox_created = tx.execute(
            "INSERT INTO lists (id, space_id, name, color, icon, sort_order, is_inbox)
             VALUES (?1, ?2, '收件箱', '#8b96a3', 'inbox', 0, 1)
             ON CONFLICT(id) DO NOTHING",
            params![INBOX_LIST_ID, DEFAULT_SPACE_ID],
        )? > 0;
    }

    let work_created = tx.execute(
        "INSERT INTO lists (id, space_id, name, color, icon, sort_order, is_inbox)
         VALUES (?1, ?2, '工作', '#5579d5', 'briefcase', 10, 0)
         ON CONFLICT(id) DO NOTHING",
        params![WORK_LIST_ID, DEFAULT_SPACE_ID],
    )? > 0;

    Ok((inbox_created, work_created))
}

fn write_marker(tx: &Transaction<'_>) -> Result<(), RepoError> {
    tx.execute(
        "INSERT INTO app_meta (key, value)
         VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        params![SEED_MARKER_KEY, SEED_VERSION],
    )?;
    Ok(())
}

/// 业务数据重置后强制写回完整种子。
///
/// 与 `ensure_seed` 不同：调用方已经清空业务表，这里必须写示例内容，
/// 不能因为“库里已有清单”而跳过。调用方负责事务提交/回滚。
pub(super) fn reseed_after_reset(tx: &Transaction<'_>) -> Result<SeedReport, RepoError> {
    let (inbox_created, work_created) = ensure_core_lists(tx)?;
    let samples_inserted = seed_samples(tx)?;
    write_marker(tx)?;
    Ok(SeedReport {
        applied: true,
        marker: SEED_VERSION.to_string(),
        samples_inserted,
        inbox_created,
        work_created,
    })
}

fn seed_samples(tx: &rusqlite::Transaction<'_>) -> Result<i64, RepoError> {
    let mut rows = 0_i64;

    // 清单：在收件箱 / 工作之外再给两个可辨识的示例清单。
    for (id, name, color, icon, order) in [
        ("life", "生活", "#d89338", "home", 20.0),
        ("reading", "阅读计划", "#8066c7", "book", 30.0),
    ] {
        rows += tx.execute(
            "INSERT INTO lists (id, space_id, name, color, icon, sort_order, is_inbox)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
             ON CONFLICT(id) DO NOTHING",
            params![id, DEFAULT_SPACE_ID, name, color, icon, order],
        )? as i64;
    }

    rows += tx.execute(
        "INSERT INTO notes (
           id, space_id, title, folder_id, tags_json, body, status, favorite, pinned
         ) VALUES (
           ?1, ?2, '欢迎使用知行', 'f1', '[\"开始\",\"产品\"]',
           '<p>知行把<strong>任务</strong>、<strong>知识</strong>与<strong>时间</strong>放在同一条工作流里。</p><div class=\"callout\">本地优先：所有内容先写入本机 SQLite，再按需同步。</div>',
           'active', 1, 0
         ) ON CONFLICT(id) DO NOTHING",
        params![WELCOME_NOTE_ID, DEFAULT_SPACE_ID],
    )? as i64;

    rows += tx.execute(
        "INSERT INTO notes (
           id, space_id, title, folder_id, tags_json, body, status, favorite, pinned
         ) VALUES (
           ?1, ?2, '任务、笔记与日历：三源融合', 'f2', '[\"产品\",\"方法\"]',
           '<h2>三条不变量</h2><ul><li>任务只有一个 ID。</li><li>笔记待办与全局任务状态独立。</li><li>日期对象不是任务。</li></ul>',
           'active', 0, 1
         ) ON CONFLICT(id) DO NOTHING",
        params![WORKFLOW_NOTE_ID, DEFAULT_SPACE_ID],
    )? as i64;

    for (id, note_id, block_type, order_key, payload) in [
        (
            "seed-block-welcome-h",
            WELCOME_NOTE_ID,
            "heading",
            1.0,
            r#"{"level":2,"text":"从资料到行动"}"#,
        ),
        (
            "seed-block-welcome-p",
            WELCOME_NOTE_ID,
            "paragraph",
            2.0,
            r#"{"text":"左侧导航切换今天、收件箱、日历与知识；所有入口读写同一套实体。"}"#,
        ),
        (
            "seed-block-workflow-p",
            WORKFLOW_NOTE_ID,
            "paragraph",
            1.0,
            r#"{"text":"一个任务可以关联多篇笔记；一篇笔记也可以关联多个任务。"}"#,
        ),
    ] {
        rows += tx.execute(
            "INSERT INTO note_blocks (id, note_id, block_type, order_key, payload_json)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO NOTHING",
            params![id, note_id, block_type, order_key, payload],
        )? as i64;
    }

    rows += tx.execute(
        "INSERT INTO tasks (
           id, space_id, list_id, note_id, title, notes, status, priority, quadrant,
           due_date, due_time, reminder, sort_order
         ) VALUES (
           ?1, ?2, ?3, ?4, '完成新版产品需求文档',
           '收敛任务与知识的融合边界，明确首期范围。',
           'todo', 3, 1, date('now', 'localtime'), '10:30', '提前 15 分钟', 1
         ) ON CONFLICT(id) DO NOTHING",
        params![
            REVIEW_TASK_ID,
            DEFAULT_SPACE_ID,
            WORK_LIST_ID,
            WORKFLOW_NOTE_ID
        ],
    )? as i64;

    rows += tx.execute(
        "INSERT INTO tasks (
           id, space_id, list_id, title, notes, status, priority, quadrant, sort_order
         ) VALUES (
           ?1, ?2, ?3, '记一个想法：把日历和笔记连起来',
           '', 'todo', 0, 4, 2
         ) ON CONFLICT(id) DO NOTHING",
        params![INBOX_TASK_ID, DEFAULT_SPACE_ID, INBOX_LIST_ID],
    )? as i64;

    rows += tx.execute(
        "INSERT INTO tasks (
           id, space_id, list_id, title, notes, status, priority, quadrant,
           due_date, completed_at, sort_order
         ) VALUES (
           ?1, ?2, ?3, '回复合作方邮件', '', 'done', 1, 2,
           date('now', '-1 day', 'localtime'),
           strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 3
         ) ON CONFLICT(id) DO NOTHING",
        params![DONE_TASK_ID, DEFAULT_SPACE_ID, WORK_LIST_ID],
    )? as i64;

    for (id, task_id, title, done, order) in [
        (
            "seed-subtask-1",
            REVIEW_TASK_ID,
            "梳理任务与笔记的关系",
            1,
            1.0,
        ),
        ("seed-subtask-2", REVIEW_TASK_ID, "补充同步失败场景", 0, 2.0),
    ] {
        rows += tx.execute(
            "INSERT INTO subtasks (id, task_id, title, done, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO NOTHING",
            params![id, task_id, title, done, order],
        )? as i64;
    }

    for (id, title, done, task_id, order) in [
        (
            "seed-note-todo-1",
            "确认附件同步策略",
            0_i64,
            Some(REVIEW_TASK_ID),
            1.0_f64,
        ),
        ("seed-note-todo-2", "整理 OCR 识别方案", 0, None, 2.0),
    ] {
        rows += tx.execute(
            "INSERT INTO note_todos (
               id, space_id, note_id, task_id, title, done, sort_order
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO NOTHING",
            params![
                id,
                DEFAULT_SPACE_ID,
                WELCOME_NOTE_ID,
                task_id,
                title,
                done,
                order
            ],
        )? as i64;
    }

    rows += tx.execute(
        "INSERT INTO boards (
           id, space_id, note_id, title, background, snapshot_json
         ) VALUES (
           ?1, ?2, ?3, '需求评审流程', 'dot', '{\"version\":1}'
         ) ON CONFLICT(id) DO NOTHING",
        params![BOARD_ID, DEFAULT_SPACE_ID, WELCOME_NOTE_ID],
    )? as i64;

    for (id, node_type, x, y, width, height, z_index, text) in [
        (
            "seed-node-start",
            "start",
            120.0,
            160.0,
            130.0,
            52.0,
            1_i64,
            "收到需求",
        ),
        (
            "seed-node-review",
            "process",
            320.0,
            160.0,
            150.0,
            58.0,
            2,
            "收集资料",
        ),
        (
            "seed-node-decision",
            "decision",
            540.0,
            150.0,
            150.0,
            76.0,
            3,
            "值得做？",
        ),
        (
            "seed-node-sticky",
            "sticky",
            540.0,
            300.0,
            150.0,
            90.0,
            4,
            "判断依据：用户价值 × 成本",
        ),
    ] {
        rows += tx.execute(
            "INSERT INTO board_nodes (
               id, board_id, node_type, x, y, width, height, z_index, text
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO NOTHING",
            params![id, BOARD_ID, node_type, x, y, width, height, z_index, text],
        )? as i64;
    }

    for (id, from_node, to_node, label) in [
        ("seed-edge-1", "seed-node-start", "seed-node-review", ""),
        ("seed-edge-2", "seed-node-review", "seed-node-decision", ""),
        (
            "seed-edge-3",
            "seed-node-decision",
            "seed-node-sticky",
            "依据",
        ),
    ] {
        rows += tx.execute(
            "INSERT INTO board_edges (id, board_id, from_node_id, to_node_id, label)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO NOTHING",
            params![id, BOARD_ID, from_node, to_node, label],
        )? as i64;
    }

    rows += tx.execute(
        "INSERT INTO settings (id, space_id, scope, setting_key, value_json)
         VALUES ('seed-setting-theme', ?1, 'space', 'appearance.theme', '\"light\"')
         ON CONFLICT(id) DO NOTHING",
        params![DEFAULT_SPACE_ID],
    )? as i64;

    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::test_support;

    #[test]
    fn fresh_database_gets_inbox_work_and_samples() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let lists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM lists WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count lists");
        let tasks: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count tasks");
        let notes: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count notes");
        let boards: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM boards WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count boards");
        let inbox: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM lists WHERE id = 'inbox' AND is_inbox = 1",
                [],
                |row| row.get(0),
            )
            .expect("count inbox");

        assert!(lists >= 4, "expected seeded lists, got {lists}");
        assert!(tasks >= 3, "expected seeded tasks, got {tasks}");
        assert!(notes >= 2, "expected seeded notes, got {notes}");
        assert!(boards >= 1, "expected seeded board, got {boards}");
        assert_eq!(inbox, 1);
    }

    #[test]
    fn rerun_is_idempotent() {
        let (_dir, repository) = test_support::repository();
        let mut connection = repository.connection().expect("connection");

        let count = |connection: &Connection| -> i64 {
            connection
                .query_row(
                    "SELECT
                       (SELECT COUNT(*) FROM lists) +
                       (SELECT COUNT(*) FROM tasks) +
                       (SELECT COUNT(*) FROM notes) +
                       (SELECT COUNT(*) FROM note_blocks) +
                       (SELECT COUNT(*) FROM subtasks) +
                       (SELECT COUNT(*) FROM note_todos) +
                       (SELECT COUNT(*) FROM boards) +
                       (SELECT COUNT(*) FROM board_nodes) +
                       (SELECT COUNT(*) FROM board_edges)",
                    [],
                    |row| row.get(0),
                )
                .expect("count seeded rows")
        };

        let before = count(&connection);
        let report = ensure_seed(&mut connection).expect("seed again");
        assert!(!report.applied);
        assert_eq!(count(&connection), before);
    }

    #[test]
    fn existing_user_data_is_not_overwritten_or_polluted() {
        let (_dir, repository) = test_support::repository();
        let mut connection = repository.connection().expect("connection");

        // 清空种子，精确构造“升级前已有用户数据”的场景。
        connection
            .execute_batch(
                "DELETE FROM board_edges;
                 DELETE FROM board_nodes;
                 DELETE FROM boards;
                 DELETE FROM focus_sessions;
                 DELETE FROM note_todos;
                 DELETE FROM subtasks;
                 DELETE FROM tasks;
                 DELETE FROM note_blocks;
                 DELETE FROM attachments;
                 DELETE FROM events;
                 DELETE FROM countdowns;
                 DELETE FROM habit_logs;
                 DELETE FROM habits;
                 DELETE FROM notes;
                 DELETE FROM settings;
                 DELETE FROM lists;
                 DELETE FROM app_meta WHERE key = 'domain_seed';",
            )
            .expect("wipe seed data");
        connection
            .execute(
                "INSERT INTO lists (id, name) VALUES ('work', '我的工作')",
                [],
            )
            .expect("insert existing user list");

        let report = ensure_seed(&mut connection).expect("reseed");
        assert!(report.applied);
        assert_eq!(report.samples_inserted, 0, "user data must not be polluted");
        assert!(report.inbox_created, "missing inbox must still be ensured");
        assert!(!report.work_created, "existing work list must be kept");

        let work_name: String = connection
            .query_row("SELECT name FROM lists WHERE id = 'work'", [], |row| {
                row.get(0)
            })
            .expect("read work list");
        let inbox_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM lists WHERE id = 'inbox' AND is_inbox = 1",
                [],
                |row| row.get(0),
            )
            .expect("count inbox");
        let sample_notes: i64 = connection
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .expect("count notes");
        let sample_tasks: i64 = connection
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
            .expect("count tasks");

        assert_eq!(work_name, "我的工作");
        assert_eq!(inbox_count, 1);
        assert_eq!(sample_notes, 0);
        assert_eq!(sample_tasks, 0);
    }
}
