//! 专注记录仓储。正式版没有关联任务时拒绝记录（task_id NOT NULL + 外键）。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{ensure_changed, new_id, validate_non_empty, RepoError, DEFAULT_SPACE_ID};
use crate::db::DbState;

const COLUMNS: &str = "id, space_id, task_id, minutes, started_at, ended_at, mode, note, \
                       created_at, updated_at, deleted_at, version";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FocusSession {
    pub id: String,
    pub space_id: String,
    pub task_id: String,
    pub minutes: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub mode: String,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewFocusSession {
    pub id: Option<String>,
    pub space_id: Option<String>,
    pub task_id: String,
    pub minutes: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub mode: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSessionUpdate {
    pub task_id: String,
    pub minutes: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub mode: String,
    pub note: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSessionQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub task_id: Option<String>,
    pub include_deleted: Option<bool>,
}

fn map_session(row: &Row<'_>) -> rusqlite::Result<FocusSession> {
    Ok(FocusSession {
        id: row.get("id")?,
        space_id: row.get("space_id")?,
        task_id: row.get("task_id")?,
        minutes: row.get("minutes")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        mode: row.get("mode")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
    })
}

fn validate_minutes(minutes: i64) -> Result<(), RepoError> {
    if minutes > 0 {
        Ok(())
    } else {
        Err(RepoError::invalid("专注时长必须大于 0 分钟"))
    }
}

pub fn list(conn: &Connection, query: &FocusSessionQuery) -> Result<Vec<FocusSession>, RepoError> {
    let sql = format!(
        "SELECT {COLUMNS} FROM focus_sessions
         WHERE (?1 = 1 OR deleted_at IS NULL)
           AND (?2 IS NULL OR substr(started_at, 1, 10) >= ?2)
           AND (?3 IS NULL OR substr(started_at, 1, 10) <= ?3)
           AND (?4 IS NULL OR task_id = ?4)
         ORDER BY started_at DESC, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            super::bool_to_int(query.include_deleted.unwrap_or(false)),
            query.from,
            query.to,
            query.task_id
        ],
        map_session,
    )?;
    let mut sessions = Vec::new();
    for row in rows {
        sessions.push(row?);
    }
    Ok(sessions)
}

pub fn get(conn: &Connection, id: &str) -> Result<FocusSession, RepoError> {
    let sql = format!("SELECT {COLUMNS} FROM focus_sessions WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], map_session)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("专注记录", id),
            other => RepoError::Sqlite(other),
        })
}

pub fn create(conn: &Connection, input: NewFocusSession) -> Result<FocusSession, RepoError> {
    validate_minutes(input.minutes)?;
    validate_non_empty(&input.started_at, "开始时间")?;
    let id = input.id.unwrap_or_else(new_id);
    let space_id = input
        .space_id
        .unwrap_or_else(|| DEFAULT_SPACE_ID.to_string());

    conn.execute(
        "INSERT INTO focus_sessions (
           id, space_id, task_id, minutes, started_at, ended_at, mode, note
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            space_id,
            input.task_id,
            input.minutes,
            input.started_at,
            input.ended_at,
            input.mode.unwrap_or_else(|| "countdown".to_string()),
            input.note.unwrap_or_default()
        ],
    )?;
    get(conn, &id)
}

pub fn update(
    conn: &Connection,
    id: &str,
    input: FocusSessionUpdate,
) -> Result<FocusSession, RepoError> {
    validate_minutes(input.minutes)?;
    validate_non_empty(&input.started_at, "开始时间")?;
    let changed = conn.execute(
        "UPDATE focus_sessions SET
           task_id = ?1,
           minutes = ?2,
           started_at = ?3,
           ended_at = ?4,
           mode = ?5,
           note = ?6,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?7 AND deleted_at IS NULL",
        params![
            input.task_id,
            input.minutes,
            input.started_at,
            input.ended_at,
            input.mode,
            input.note,
            id
        ],
    )?;
    ensure_changed(changed, "专注记录", id)?;
    get(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), RepoError> {
    let changed = conn.execute(
        "UPDATE focus_sessions SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "专注记录", id)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn focus_sessions_list(
    state: State<'_, DbState>,
    query: Option<FocusSessionQuery>,
) -> Result<Vec<FocusSession>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list(&connection, &query.unwrap_or_default()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn focus_sessions_get(state: State<'_, DbState>, id: String) -> Result<FocusSession, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    get(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn focus_sessions_create(
    state: State<'_, DbState>,
    input: NewFocusSession,
) -> Result<FocusSession, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    create(&connection, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn focus_sessions_update(
    state: State<'_, DbState>,
    id: String,
    input: FocusSessionUpdate,
) -> Result<FocusSession, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    update(&connection, &id, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn focus_sessions_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete(&connection, &id).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::test_support;

    fn new_session(id: &str, from: &str, minutes: i64) -> NewFocusSession {
        NewFocusSession {
            id: Some(id.to_string()),
            space_id: None,
            task_id: "seed-task-review".to_string(),
            minutes,
            started_at: format!("{from}T09:00:00Z"),
            ended_at: Some(format!("{from}T09:25:00Z")),
            mode: Some("countdown".to_string()),
            note: None,
        }
    }

    #[test]
    fn crud_and_date_range() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let session =
            create(&connection, new_session("focus-a", "2026-10-25", 25)).expect("create");
        assert_eq!(session.minutes, 25);
        assert_eq!(session.version, 1);

        create(&connection, new_session("focus-b", "2026-11-02", 50)).expect("create");

        let october = list(
            &connection,
            &FocusSessionQuery {
                from: Some("2026-10-01".to_string()),
                to: Some("2026-10-31".to_string()),
                ..FocusSessionQuery::default()
            },
        )
        .expect("range query");
        assert_eq!(october.len(), 1);
        assert_eq!(october[0].id, "focus-a");

        let updated = update(
            &connection,
            "focus-a",
            FocusSessionUpdate {
                task_id: "seed-task-inbox".to_string(),
                minutes: 30,
                started_at: "2026-10-25T10:00:00Z".to_string(),
                ended_at: Some("2026-10-25T10:30:00Z".to_string()),
                mode: "pomodoro".to_string(),
                note: "补记录".to_string(),
            },
        )
        .expect("update");
        assert_eq!(updated.minutes, 30);
        assert_eq!(updated.task_id, "seed-task-inbox");
        assert_eq!(updated.version, 2);

        delete(&connection, "focus-a").expect("delete");
        assert!(matches!(
            get(&connection, "focus-a"),
            Err(RepoError::NotFound { .. })
        ));
        assert!(!list(&connection, &FocusSessionQuery::default())
            .expect("list")
            .iter()
            .any(|item| item.id == "focus-a"));
    }

    #[test]
    fn orphan_task_and_invalid_minutes_are_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let mut orphan = new_session("focus-orphan", "2026-10-25", 25);
        orphan.task_id = "no-such-task".to_string();
        let error = create(&connection, orphan).expect_err("orphan task must fail");
        assert!(error.to_string().contains("FOREIGN KEY"));

        let error = create(&connection, new_session("focus-zero", "2026-10-25", 0))
            .expect_err("zero minutes must fail");
        assert!(matches!(error, RepoError::Invalid(_)));
    }
}
