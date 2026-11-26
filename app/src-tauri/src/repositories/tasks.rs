//! 任务与子任务仓储。任务只有一个实体和一份 status；完成写 completed_at。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{
    bool_to_int, ensure_changed, int_to_bool, new_id, validate_non_empty, RepoError,
    DEFAULT_SPACE_ID,
};
use crate::db::DbState;

const COLUMNS: &str = "t.id AS id, t.space_id AS space_id, t.list_id AS list_id, \
                       t.parent_id AS parent_id, t.note_id AS note_id, t.title AS title, \
                       t.notes AS notes, t.status AS status, t.priority AS priority, \
                       t.quadrant AS quadrant, t.due_date AS due_date, t.due_time AS due_time, \
                       t.due_at AS due_at, t.tz AS tz, t.reminder AS reminder, \
                       t.sort_order AS sort_order, t.completed_at AS completed_at, \
                       t.created_at AS created_at, t.updated_at AS updated_at, \
                       t.deleted_at AS deleted_at, t.version AS version";

const SUBTASK_COLUMNS: &str = "id, task_id, title, done, sort_order, created_at, updated_at, \
                               deleted_at, version";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub space_id: String,
    pub list_id: String,
    pub parent_id: Option<String>,
    pub note_id: Option<String>,
    pub title: String,
    pub notes: String,
    pub status: String,
    pub priority: i64,
    pub quadrant: i64,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub due_at: Option<String>,
    pub tz: String,
    pub reminder: String,
    pub sort_order: f64,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTask {
    pub id: Option<String>,
    pub space_id: Option<String>,
    pub list_id: String,
    pub parent_id: Option<String>,
    pub note_id: Option<String>,
    pub title: String,
    pub notes: Option<String>,
    pub status: Option<String>,
    pub priority: Option<i64>,
    pub quadrant: Option<i64>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub due_at: Option<String>,
    pub tz: Option<String>,
    pub reminder: Option<String>,
    pub sort_order: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdate {
    pub list_id: String,
    pub parent_id: Option<String>,
    pub note_id: Option<String>,
    pub title: String,
    pub notes: String,
    pub status: String,
    pub priority: i64,
    pub quadrant: i64,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub due_at: Option<String>,
    pub tz: Option<String>,
    pub reminder: Option<String>,
    pub sort_order: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQuery {
    pub list_id: Option<String>,
    pub status: Option<String>,
    pub due_date: Option<String>,
    pub due_before: Option<String>,
    pub inbox: Option<bool>,
    pub include_deleted: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Subtask {
    pub id: String,
    pub task_id: String,
    pub title: String,
    pub done: bool,
    pub sort_order: f64,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSubtask {
    pub id: Option<String>,
    pub task_id: String,
    pub title: String,
    pub done: Option<bool>,
    pub sort_order: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskUpdate {
    pub title: String,
    pub done: bool,
    pub sort_order: f64,
}

fn map_task(row: &Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get("id")?,
        space_id: row.get("space_id")?,
        list_id: row.get("list_id")?,
        parent_id: row.get("parent_id")?,
        note_id: row.get("note_id")?,
        title: row.get("title")?,
        notes: row.get("notes")?,
        status: row.get("status")?,
        priority: row.get("priority")?,
        quadrant: row.get("quadrant")?,
        due_date: row.get("due_date")?,
        due_time: row.get("due_time")?,
        due_at: row.get("due_at")?,
        tz: row.get("tz")?,
        reminder: row.get("reminder")?,
        sort_order: row.get("sort_order")?,
        completed_at: row.get("completed_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
    })
}

fn map_subtask(row: &Row<'_>) -> rusqlite::Result<Subtask> {
    Ok(Subtask {
        id: row.get("id")?,
        task_id: row.get("task_id")?,
        title: row.get("title")?,
        done: int_to_bool(row.get("done")?),
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
    })
}

fn validate_status(status: &str) -> Result<(), RepoError> {
    if matches!(status, "todo" | "doing" | "done") {
        Ok(())
    } else {
        Err(RepoError::invalid(format!("任务状态无效：{status}")))
    }
}

fn validate_priority(priority: i64) -> Result<(), RepoError> {
    if (0..=3).contains(&priority) {
        Ok(())
    } else {
        Err(RepoError::invalid("任务优先级必须在 0..=3"))
    }
}

fn validate_quadrant(quadrant: i64) -> Result<(), RepoError> {
    if (0..=4).contains(&quadrant) {
        Ok(())
    } else {
        Err(RepoError::invalid("四象限必须在 0..=4（0 表示未分配）"))
    }
}

pub fn list(conn: &Connection, query: &TaskQuery) -> Result<Vec<Task>, RepoError> {
    let sql = format!(
        "SELECT {COLUMNS}
         FROM tasks t
         JOIN lists l ON l.id = t.list_id
         WHERE (?1 = 1 OR t.deleted_at IS NULL)
           AND (?2 IS NULL OR t.list_id = ?2)
           AND (?3 IS NULL OR t.status = ?3)
           AND (?4 IS NULL OR t.due_date = ?4)
           AND (?5 IS NULL OR t.due_date <= ?5)
           AND (?6 = 0 OR l.is_inbox = 1)
         ORDER BY t.sort_order, t.created_at, t.id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            bool_to_int(query.include_deleted.unwrap_or(false)),
            query.list_id,
            query.status,
            query.due_date,
            query.due_before,
            bool_to_int(query.inbox.unwrap_or(false))
        ],
        map_task,
    )?;
    let mut tasks = Vec::new();
    for row in rows {
        tasks.push(row?);
    }
    Ok(tasks)
}

pub fn get(conn: &Connection, id: &str) -> Result<Task, RepoError> {
    let sql = format!("SELECT {COLUMNS} FROM tasks t WHERE t.id = ?1 AND t.deleted_at IS NULL");
    conn.query_row(&sql, params![id], map_task)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("任务", id),
            other => RepoError::Sqlite(other),
        })
}

pub fn create(conn: &Connection, input: NewTask) -> Result<Task, RepoError> {
    validate_non_empty(&input.title, "任务标题")?;
    let status = input.status.unwrap_or_else(|| "todo".to_string());
    validate_status(&status)?;
    let priority = input.priority.unwrap_or(0);
    validate_priority(priority)?;
    let quadrant = input.quadrant.unwrap_or(0);
    validate_quadrant(quadrant)?;

    let id = input.id.unwrap_or_else(new_id);
    let space_id = input
        .space_id
        .unwrap_or_else(|| DEFAULT_SPACE_ID.to_string());
    let tz = input.tz.unwrap_or_else(|| "Asia/Shanghai".to_string());
    let completed = status == "done";

    conn.execute(
        "INSERT INTO tasks (
           id, space_id, list_id, parent_id, note_id, title, notes, status, priority,
           quadrant, due_date, due_time, due_at, tz, reminder, sort_order, completed_at
         ) VALUES (
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
           CASE WHEN ?17 = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
         )",
        params![
            id,
            space_id,
            input.list_id,
            input.parent_id,
            input.note_id,
            input.title.trim(),
            input.notes.unwrap_or_default(),
            status,
            priority,
            quadrant,
            input.due_date,
            input.due_time,
            input.due_at,
            tz,
            input.reminder.unwrap_or_default(),
            input.sort_order.unwrap_or(0.0),
            bool_to_int(completed)
        ],
    )?;

    get(conn, &id)
}

pub fn update(conn: &Connection, id: &str, input: TaskUpdate) -> Result<Task, RepoError> {
    validate_non_empty(&input.title, "任务标题")?;
    validate_status(&input.status)?;
    validate_priority(input.priority)?;
    validate_quadrant(input.quadrant)?;

    let changed = conn.execute(
        "UPDATE tasks SET
           list_id = ?1,
           parent_id = ?2,
           note_id = ?3,
           title = ?4,
           notes = ?5,
           status = ?6,
           priority = ?7,
           quadrant = ?8,
           due_date = ?9,
           due_time = ?10,
           due_at = ?11,
           tz = ?12,
           reminder = ?13,
           sort_order = ?14,
           completed_at = CASE
             WHEN ?6 = 'done' THEN COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             ELSE NULL
           END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?15 AND deleted_at IS NULL",
        params![
            input.list_id,
            input.parent_id,
            input.note_id,
            input.title.trim(),
            input.notes,
            input.status,
            input.priority,
            input.quadrant,
            input.due_date,
            input.due_time,
            input.due_at,
            input.tz.unwrap_or_else(|| "Asia/Shanghai".to_string()),
            input.reminder.unwrap_or_default(),
            input.sort_order.unwrap_or(0.0),
            id
        ],
    )?;
    ensure_changed(changed, "任务", id)?;
    get(conn, id)
}

pub fn set_done(conn: &Connection, id: &str, done: bool) -> Result<Task, RepoError> {
    let changed = conn.execute(
        "UPDATE tasks SET
           status = CASE WHEN ?1 = 1 THEN 'done' ELSE 'todo' END,
           completed_at = CASE
             WHEN ?1 = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             ELSE NULL
           END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?2 AND deleted_at IS NULL",
        params![bool_to_int(done), id],
    )?;
    ensure_changed(changed, "任务", id)?;
    get(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), RepoError> {
    let changed = conn.execute(
        "UPDATE tasks SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "任务", id)
}

pub fn restore(conn: &Connection, id: &str) -> Result<Task, RepoError> {
    let changed = conn.execute(
        "UPDATE tasks SET
           deleted_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NOT NULL",
        params![id],
    )?;
    ensure_changed(changed, "任务", id)?;
    get(conn, id)
}

// ---------------------------------------------------------------------------
// 子任务
// ---------------------------------------------------------------------------

pub fn list_subtasks(
    conn: &Connection,
    task_id: &str,
    include_deleted: bool,
) -> Result<Vec<Subtask>, RepoError> {
    let sql = format!(
        "SELECT {SUBTASK_COLUMNS} FROM subtasks
         WHERE task_id = ?1 AND (?2 = 1 OR deleted_at IS NULL)
         ORDER BY sort_order, created_at, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params![task_id, bool_to_int(include_deleted)], map_subtask)?;
    let mut subtasks = Vec::new();
    for row in rows {
        subtasks.push(row?);
    }
    Ok(subtasks)
}

pub fn get_subtask(conn: &Connection, id: &str) -> Result<Subtask, RepoError> {
    let sql =
        format!("SELECT {SUBTASK_COLUMNS} FROM subtasks WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], map_subtask)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("子任务", id),
            other => RepoError::Sqlite(other),
        })
}

pub fn create_subtask(conn: &Connection, input: NewSubtask) -> Result<Subtask, RepoError> {
    validate_non_empty(&input.title, "子任务标题")?;
    let id = input.id.unwrap_or_else(new_id);
    conn.execute(
        "INSERT INTO subtasks (id, task_id, title, done, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            id,
            input.task_id,
            input.title.trim(),
            bool_to_int(input.done.unwrap_or(false)),
            input.sort_order.unwrap_or(0.0)
        ],
    )?;
    get_subtask(conn, &id)
}

pub fn update_subtask(
    conn: &Connection,
    id: &str,
    input: SubtaskUpdate,
) -> Result<Subtask, RepoError> {
    validate_non_empty(&input.title, "子任务标题")?;
    let changed = conn.execute(
        "UPDATE subtasks SET
           title = ?1,
           done = ?2,
           sort_order = ?3,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?4 AND deleted_at IS NULL",
        params![
            input.title.trim(),
            bool_to_int(input.done),
            input.sort_order,
            id
        ],
    )?;
    ensure_changed(changed, "子任务", id)?;
    get_subtask(conn, id)
}

pub fn delete_subtask(conn: &Connection, id: &str) -> Result<(), RepoError> {
    let changed = conn.execute(
        "UPDATE subtasks SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "子任务", id)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn tasks_list(
    state: State<'_, DbState>,
    query: Option<TaskQuery>,
) -> Result<Vec<Task>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list(&connection, &query.unwrap_or_default()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn tasks_get(state: State<'_, DbState>, id: String) -> Result<Task, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    get(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn tasks_create(state: State<'_, DbState>, input: NewTask) -> Result<Task, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    create(&connection, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn tasks_update(
    state: State<'_, DbState>,
    id: String,
    input: TaskUpdate,
) -> Result<Task, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    update(&connection, &id, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn tasks_complete(state: State<'_, DbState>, id: String, done: bool) -> Result<Task, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    set_done(&connection, &id, done).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn tasks_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn tasks_restore(state: State<'_, DbState>, id: String) -> Result<Task, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    restore(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn subtasks_list(
    state: State<'_, DbState>,
    task_id: String,
    include_deleted: Option<bool>,
) -> Result<Vec<Subtask>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list_subtasks(&connection, &task_id, include_deleted.unwrap_or(false))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn subtasks_create(state: State<'_, DbState>, input: NewSubtask) -> Result<Subtask, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    create_subtask(&connection, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn subtasks_update(
    state: State<'_, DbState>,
    id: String,
    input: SubtaskUpdate,
) -> Result<Subtask, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    update_subtask(&connection, &id, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn subtasks_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete_subtask(&connection, &id).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::test_support;

    fn new_task(id: &str, list_id: &str, title: &str) -> NewTask {
        NewTask {
            id: Some(id.to_string()),
            space_id: None,
            list_id: list_id.to_string(),
            parent_id: None,
            note_id: None,
            title: title.to_string(),
            notes: None,
            status: None,
            priority: None,
            quadrant: None,
            due_date: None,
            due_time: None,
            due_at: None,
            tz: None,
            reminder: None,
            sort_order: None,
        }
    }

    #[test]
    fn create_get_update_and_complete() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let created =
            create(&connection, new_task("task-a", "work", "  写周报  ")).expect("create task");
        assert_eq!(created.title, "写周报");
        assert_eq!(created.status, "todo");
        assert_eq!(created.completed_at, None);
        assert_eq!(created.version, 1);

        let updated = update(
            &connection,
            "task-a",
            TaskUpdate {
                list_id: "life".to_string(),
                parent_id: None,
                note_id: Some(super::super::seed::WORKFLOW_NOTE_ID.to_string()),
                title: "写周报（周四）".to_string(),
                notes: "带上数据".to_string(),
                status: "doing".to_string(),
                priority: 2,
                quadrant: 2,
                due_date: Some("2026-10-30".to_string()),
                due_time: Some("18:00".to_string()),
                due_at: None,
                tz: None,
                reminder: Some("提前 15 分钟".to_string()),
                sort_order: Some(2.0),
            },
        )
        .expect("update task");
        assert_eq!(updated.list_id, "life");
        assert_eq!(
            updated.note_id.as_deref(),
            Some(super::super::seed::WORKFLOW_NOTE_ID)
        );
        assert_eq!(updated.status, "doing");
        assert_eq!(updated.version, 2);

        let completed = set_done(&connection, "task-a", true).expect("complete");
        assert_eq!(completed.status, "done");
        assert!(completed.completed_at.is_some());
        assert_eq!(completed.version, 3);

        let reopened = set_done(&connection, "task-a", false).expect("reopen");
        assert_eq!(reopened.status, "todo");
        assert_eq!(reopened.completed_at, None);
    }

    #[test]
    fn soft_delete_hides_and_restore_brings_back() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        create(&connection, new_task("task-delete", "inbox", "待删除")).expect("create");
        delete(&connection, "task-delete").expect("delete");
        assert!(matches!(
            get(&connection, "task-delete"),
            Err(RepoError::NotFound { .. })
        ));
        let active = list(&connection, &TaskQuery::default()).expect("list");
        assert!(!active.iter().any(|task| task.id == "task-delete"));
        let all = list(
            &connection,
            &TaskQuery {
                include_deleted: Some(true),
                ..TaskQuery::default()
            },
        )
        .expect("list all");
        assert!(all.iter().any(|task| task.id == "task-delete"));

        let restored = restore(&connection, "task-delete").expect("restore");
        assert!(restored.deleted_at.is_none());
        assert!(get(&connection, "task-delete").is_ok());
    }

    #[test]
    fn query_filters_by_inbox_and_due_date() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        create(&connection, new_task("task-due", "work", "有截止日期")).expect("create");
        update(
            &connection,
            "task-due",
            TaskUpdate {
                list_id: "work".to_string(),
                parent_id: None,
                note_id: None,
                title: "有截止日期".to_string(),
                notes: String::new(),
                status: "todo".to_string(),
                priority: 0,
                quadrant: 0,
                due_date: Some("2026-01-01".to_string()),
                due_time: None,
                due_at: None,
                tz: None,
                reminder: None,
                sort_order: None,
            },
        )
        .expect("set due date");

        let inbox = list(
            &connection,
            &TaskQuery {
                inbox: Some(true),
                ..TaskQuery::default()
            },
        )
        .expect("inbox query");
        assert!(inbox.iter().all(|task| task.list_id == "inbox"));
        assert!(inbox.iter().any(|task| task.id == "seed-task-inbox"));

        let overdue = list(
            &connection,
            &TaskQuery {
                due_before: Some("2026-02-01".to_string()),
                ..TaskQuery::default()
            },
        )
        .expect("due query");
        assert!(overdue.iter().any(|task| task.id == "task-due"));
        assert!(!overdue.iter().any(|task| task.id == "seed-task-review"));
    }

    #[test]
    fn foreign_keys_reject_orphan_list_and_note() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let list_error = create(
            &connection,
            new_task("bad-list", "no-such-list", "孤儿清单"),
        );
        assert!(list_error.is_err(), "task with missing list must fail");
        assert!(
            list_error.unwrap_err().to_string().contains("FOREIGN KEY"),
            "expected FK error for list"
        );

        let mut with_note = new_task("bad-note", "work", "孤儿笔记");
        with_note.note_id = Some("no-such-note".to_string());
        let note_error = create(&connection, with_note);
        assert!(note_error.is_err(), "task with missing note must fail");
        assert!(
            note_error.unwrap_err().to_string().contains("FOREIGN KEY"),
            "expected FK error for note"
        );
    }

    #[test]
    fn subtasks_crud_and_soft_delete() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let subtask = create_subtask(
            &connection,
            NewSubtask {
                id: Some("sub-a".to_string()),
                task_id: "seed-task-review".to_string(),
                title: "拆解第一步".to_string(),
                done: Some(false),
                sort_order: Some(1.0),
            },
        )
        .expect("create subtask");
        assert!(!subtask.done);

        let updated = update_subtask(
            &connection,
            "sub-a",
            SubtaskUpdate {
                title: "拆解第一步（完成）".to_string(),
                done: true,
                sort_order: 2.0,
            },
        )
        .expect("update subtask");
        assert!(updated.done);
        assert_eq!(updated.version, 2);

        let listed = list_subtasks(&connection, "seed-task-review", false).expect("list subtasks");
        assert!(listed.iter().any(|item| item.id == "sub-a"));

        delete_subtask(&connection, "sub-a").expect("delete subtask");
        let listed = list_subtasks(&connection, "seed-task-review", false).expect("list subtasks");
        assert!(!listed.iter().any(|item| item.id == "sub-a"));
    }

    #[test]
    fn invalid_status_or_priority_is_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let mut task = new_task("bad-status", "inbox", "坏状态");
        task.status = Some("blocked".to_string());
        assert!(matches!(
            create(&connection, task),
            Err(RepoError::Invalid(_))
        ));

        let mut task = new_task("bad-priority", "inbox", "坏优先级");
        task.priority = Some(9);
        assert!(matches!(
            create(&connection, task),
            Err(RepoError::Invalid(_))
        ));
    }
}
