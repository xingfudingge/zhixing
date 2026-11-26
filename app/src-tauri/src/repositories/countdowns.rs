//! 倒数日仓储。倒数日是独立日期对象，不进入任务，也不自动生成任务。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{bool_to_int, ensure_changed, new_id, validate_non_empty, RepoError, DEFAULT_SPACE_ID};
use crate::db::DbState;

const COLUMNS: &str = "id, space_id, title, category, calendar_type, target_date, repeat_rule, \
                       lunar_month, lunar_day, note, color, created_at, updated_at, deleted_at, \
                       version";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Countdown {
    pub id: String,
    pub space_id: String,
    pub title: String,
    pub category: String,
    pub calendar_type: String,
    pub target_date: String,
    pub repeat_rule: String,
    pub lunar_month: Option<String>,
    pub lunar_day: Option<i64>,
    pub note: String,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCountdown {
    pub id: Option<String>,
    pub space_id: Option<String>,
    pub title: String,
    pub category: Option<String>,
    pub calendar_type: Option<String>,
    pub target_date: String,
    pub repeat_rule: Option<String>,
    pub lunar_month: Option<String>,
    pub lunar_day: Option<i64>,
    pub note: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountdownUpdate {
    pub title: String,
    pub category: String,
    pub calendar_type: String,
    pub target_date: String,
    pub repeat_rule: String,
    pub lunar_month: Option<String>,
    pub lunar_day: Option<i64>,
    pub note: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountdownQuery {
    pub category: Option<String>,
    pub include_deleted: Option<bool>,
}

fn map_countdown(row: &Row<'_>) -> rusqlite::Result<Countdown> {
    Ok(Countdown {
        id: row.get("id")?,
        space_id: row.get("space_id")?,
        title: row.get("title")?,
        category: row.get("category")?,
        calendar_type: row.get("calendar_type")?,
        target_date: row.get("target_date")?,
        repeat_rule: row.get("repeat_rule")?,
        lunar_month: row.get("lunar_month")?,
        lunar_day: row.get("lunar_day")?,
        note: row.get("note")?,
        color: row.get("color")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
    })
}

fn validate_calendar_type(value: &str) -> Result<(), RepoError> {
    if matches!(value, "solar" | "lunar") {
        Ok(())
    } else {
        Err(RepoError::invalid(format!("历法类型无效：{value}")))
    }
}

pub fn list(conn: &Connection, query: &CountdownQuery) -> Result<Vec<Countdown>, RepoError> {
    let sql = format!(
        "SELECT {COLUMNS} FROM countdowns
         WHERE (?1 = 1 OR deleted_at IS NULL)
           AND (?2 IS NULL OR category = ?2)
         ORDER BY target_date, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            bool_to_int(query.include_deleted.unwrap_or(false)),
            query.category
        ],
        map_countdown,
    )?;
    let mut countdowns = Vec::new();
    for row in rows {
        countdowns.push(row?);
    }
    Ok(countdowns)
}

pub fn get(conn: &Connection, id: &str) -> Result<Countdown, RepoError> {
    let sql = format!("SELECT {COLUMNS} FROM countdowns WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], map_countdown)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("倒数日", id),
            other => RepoError::Sqlite(other),
        })
}

pub fn create(conn: &Connection, input: NewCountdown) -> Result<Countdown, RepoError> {
    validate_non_empty(&input.title, "倒数日标题")?;
    validate_non_empty(&input.target_date, "目标日期")?;
    let calendar_type = input.calendar_type.unwrap_or_else(|| "solar".to_string());
    validate_calendar_type(&calendar_type)?;

    let id = input.id.unwrap_or_else(new_id);
    let space_id = input
        .space_id
        .unwrap_or_else(|| DEFAULT_SPACE_ID.to_string());

    conn.execute(
        "INSERT INTO countdowns (
           id, space_id, title, category, calendar_type, target_date, repeat_rule,
           lunar_month, lunar_day, note, color
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            id,
            space_id,
            input.title.trim(),
            input.category.unwrap_or_else(|| "自定义".to_string()),
            calendar_type,
            input.target_date,
            input.repeat_rule.unwrap_or_else(|| "单次".to_string()),
            input.lunar_month,
            input.lunar_day,
            input.note.unwrap_or_default(),
            input.color.unwrap_or_default()
        ],
    )?;
    get(conn, &id)
}

pub fn update(conn: &Connection, id: &str, input: CountdownUpdate) -> Result<Countdown, RepoError> {
    validate_non_empty(&input.title, "倒数日标题")?;
    validate_non_empty(&input.target_date, "目标日期")?;
    validate_calendar_type(&input.calendar_type)?;
    let changed = conn.execute(
        "UPDATE countdowns SET
           title = ?1,
           category = ?2,
           calendar_type = ?3,
           target_date = ?4,
           repeat_rule = ?5,
           lunar_month = ?6,
           lunar_day = ?7,
           note = ?8,
           color = ?9,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?10 AND deleted_at IS NULL",
        params![
            input.title.trim(),
            input.category,
            input.calendar_type,
            input.target_date,
            input.repeat_rule,
            input.lunar_month,
            input.lunar_day,
            input.note,
            input.color.unwrap_or_default(),
            id
        ],
    )?;
    ensure_changed(changed, "倒数日", id)?;
    get(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), RepoError> {
    let changed = conn.execute(
        "UPDATE countdowns SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "倒数日", id)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn countdowns_list(
    state: State<'_, DbState>,
    query: Option<CountdownQuery>,
) -> Result<Vec<Countdown>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list(&connection, &query.unwrap_or_default()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn countdowns_get(state: State<'_, DbState>, id: String) -> Result<Countdown, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    get(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn countdowns_create(
    state: State<'_, DbState>,
    input: NewCountdown,
) -> Result<Countdown, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    create(&connection, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn countdowns_update(
    state: State<'_, DbState>,
    id: String,
    input: CountdownUpdate,
) -> Result<Countdown, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    update(&connection, &id, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn countdowns_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete(&connection, &id).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::test_support;

    #[test]
    fn crud_category_filter_and_lunar_fields() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let countdown = create(
            &connection,
            NewCountdown {
                id: Some("countdown-a".to_string()),
                space_id: None,
                title: "春节".to_string(),
                category: Some("热门节日".to_string()),
                calendar_type: Some("lunar".to_string()),
                target_date: "2027-02-07".to_string(),
                repeat_rule: Some("每年（农历）".to_string()),
                lunar_month: Some("正月".to_string()),
                lunar_day: Some(1),
                note: Some("农历新年".to_string()),
                color: None,
            },
        )
        .expect("create");
        assert_eq!(countdown.calendar_type, "lunar");
        assert_eq!(countdown.lunar_month.as_deref(), Some("正月"));

        create(
            &connection,
            NewCountdown {
                id: Some("countdown-b".to_string()),
                space_id: None,
                title: "项目上线".to_string(),
                category: Some("自定义".to_string()),
                calendar_type: None,
                target_date: "2026-11-07".to_string(),
                repeat_rule: None,
                lunar_month: None,
                lunar_day: None,
                note: None,
                color: None,
            },
        )
        .expect("create");

        let holidays = list(
            &connection,
            &CountdownQuery {
                category: Some("热门节日".to_string()),
                ..CountdownQuery::default()
            },
        )
        .expect("category query");
        assert_eq!(holidays.len(), 1);
        assert_eq!(holidays[0].id, "countdown-a");

        let updated = update(
            &connection,
            "countdown-b",
            CountdownUpdate {
                title: "项目上线（延期）".to_string(),
                category: "自定义".to_string(),
                calendar_type: "solar".to_string(),
                target_date: "2026-11-14".to_string(),
                repeat_rule: "单次".to_string(),
                lunar_month: None,
                lunar_day: None,
                note: "v1 内测".to_string(),
                color: Some("#d89338".to_string()),
            },
        )
        .expect("update");
        assert_eq!(updated.target_date, "2026-11-14");
        assert_eq!(updated.version, 2);

        delete(&connection, "countdown-b").expect("delete");
        assert!(matches!(
            get(&connection, "countdown-b"),
            Err(RepoError::NotFound { .. })
        ));
        assert!(!list(&connection, &CountdownQuery::default())
            .expect("list")
            .iter()
            .any(|item| item.id == "countdown-b"));
    }

    #[test]
    fn invalid_calendar_type_is_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let error = create(
            &connection,
            NewCountdown {
                id: Some("countdown-bad".to_string()),
                space_id: None,
                title: "坏历法".to_string(),
                category: None,
                calendar_type: Some("mayan".to_string()),
                target_date: "2026-12-01".to_string(),
                repeat_rule: None,
                lunar_month: None,
                lunar_day: None,
                note: None,
                color: None,
            },
        )
        .expect_err("invalid calendar must fail");
        assert!(matches!(error, RepoError::Invalid(_)));
    }
}
