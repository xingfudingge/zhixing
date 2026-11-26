//! 习惯与打卡仓储。`habit_id + log_date` 唯一，打卡幂等。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{
    bool_to_int, ensure_changed, int_to_bool, new_id, validate_non_empty, RepoError,
    DEFAULT_SPACE_ID,
};
use crate::db::DbState;

const COLUMNS: &str = "id, space_id, title, schedule, icon, color, goal_per_week, sort_order, \
                       archived, created_at, updated_at, deleted_at, version";
const LOG_COLUMNS: &str = "id, space_id, habit_id, log_date, done, note, created_at, updated_at, \
                           deleted_at, version";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Habit {
    pub id: String,
    pub space_id: String,
    pub title: String,
    pub schedule: String,
    pub icon: String,
    pub color: String,
    pub goal_per_week: i64,
    pub sort_order: f64,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewHabit {
    pub id: Option<String>,
    pub space_id: Option<String>,
    pub title: String,
    pub schedule: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub goal_per_week: Option<i64>,
    pub sort_order: Option<f64>,
    pub archived: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HabitUpdate {
    pub title: String,
    pub schedule: String,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub goal_per_week: i64,
    pub sort_order: f64,
    pub archived: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HabitQuery {
    pub include_archived: Option<bool>,
    pub include_deleted: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HabitLog {
    pub id: String,
    pub space_id: String,
    pub habit_id: String,
    pub log_date: String,
    pub done: bool,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HabitLogQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub include_deleted: Option<bool>,
}

fn map_habit(row: &Row<'_>) -> rusqlite::Result<Habit> {
    Ok(Habit {
        id: row.get("id")?,
        space_id: row.get("space_id")?,
        title: row.get("title")?,
        schedule: row.get("schedule")?,
        icon: row.get("icon")?,
        color: row.get("color")?,
        goal_per_week: row.get("goal_per_week")?,
        sort_order: row.get("sort_order")?,
        archived: int_to_bool(row.get("archived")?),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
    })
}

fn map_log(row: &Row<'_>) -> rusqlite::Result<HabitLog> {
    Ok(HabitLog {
        id: row.get("id")?,
        space_id: row.get("space_id")?,
        habit_id: row.get("habit_id")?,
        log_date: row.get("log_date")?,
        done: int_to_bool(row.get("done")?),
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
    })
}

fn validate_goal(goal: i64) -> Result<(), RepoError> {
    if (0..=7).contains(&goal) {
        Ok(())
    } else {
        Err(RepoError::invalid("每周目标必须在 0..=7"))
    }
}

pub fn list(conn: &Connection, query: &HabitQuery) -> Result<Vec<Habit>, RepoError> {
    let sql = format!(
        "SELECT {COLUMNS} FROM habits
         WHERE (?1 = 1 OR deleted_at IS NULL)
           AND (?2 = 1 OR archived = 0)
         ORDER BY sort_order, created_at, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            bool_to_int(query.include_deleted.unwrap_or(false)),
            bool_to_int(query.include_archived.unwrap_or(false))
        ],
        map_habit,
    )?;
    let mut habits = Vec::new();
    for row in rows {
        habits.push(row?);
    }
    Ok(habits)
}

pub fn get(conn: &Connection, id: &str) -> Result<Habit, RepoError> {
    let sql = format!("SELECT {COLUMNS} FROM habits WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], map_habit)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("习惯", id),
            other => RepoError::Sqlite(other),
        })
}

pub fn create(conn: &Connection, input: NewHabit) -> Result<Habit, RepoError> {
    validate_non_empty(&input.title, "习惯名称")?;
    let goal = input.goal_per_week.unwrap_or(7);
    validate_goal(goal)?;
    let id = input.id.unwrap_or_else(new_id);
    let space_id = input
        .space_id
        .unwrap_or_else(|| DEFAULT_SPACE_ID.to_string());

    conn.execute(
        "INSERT INTO habits (
           id, space_id, title, schedule, icon, color, goal_per_week, sort_order, archived
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            space_id,
            input.title.trim(),
            input.schedule.unwrap_or_else(|| "每天".to_string()),
            input.icon.unwrap_or_default(),
            input.color.unwrap_or_else(|| "blue".to_string()),
            goal,
            input.sort_order.unwrap_or(0.0),
            bool_to_int(input.archived.unwrap_or(false))
        ],
    )?;
    get(conn, &id)
}

pub fn update(conn: &Connection, id: &str, input: HabitUpdate) -> Result<Habit, RepoError> {
    validate_non_empty(&input.title, "习惯名称")?;
    validate_goal(input.goal_per_week)?;
    let changed = conn.execute(
        "UPDATE habits SET
           title = ?1,
           schedule = ?2,
           icon = ?3,
           color = ?4,
           goal_per_week = ?5,
           sort_order = ?6,
           archived = ?7,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?8 AND deleted_at IS NULL",
        params![
            input.title.trim(),
            input.schedule,
            input.icon.unwrap_or_default(),
            input.color.unwrap_or_else(|| "blue".to_string()),
            input.goal_per_week,
            input.sort_order,
            bool_to_int(input.archived),
            id
        ],
    )?;
    ensure_changed(changed, "习惯", id)?;
    get(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), RepoError> {
    let changed = conn.execute(
        "UPDATE habits SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "习惯", id)
}

pub fn list_logs(
    conn: &Connection,
    habit_id: &str,
    query: &HabitLogQuery,
) -> Result<Vec<HabitLog>, RepoError> {
    let sql = format!(
        "SELECT {LOG_COLUMNS} FROM habit_logs
         WHERE habit_id = ?1
           AND (?2 = 1 OR deleted_at IS NULL)
           AND (?3 IS NULL OR log_date >= ?3)
           AND (?4 IS NULL OR log_date <= ?4)
         ORDER BY log_date, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            habit_id,
            bool_to_int(query.include_deleted.unwrap_or(false)),
            query.from,
            query.to
        ],
        map_log,
    )?;
    let mut logs = Vec::new();
    for row in rows {
        logs.push(row?);
    }
    Ok(logs)
}

pub fn get_log(conn: &Connection, habit_id: &str, date: &str) -> Result<HabitLog, RepoError> {
    let sql = format!(
        "SELECT {LOG_COLUMNS} FROM habit_logs
         WHERE habit_id = ?1 AND log_date = ?2 AND deleted_at IS NULL"
    );
    conn.query_row(&sql, params![habit_id, date], map_log)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                RepoError::not_found("习惯打卡", format!("{habit_id}@{date}"))
            }
            other => RepoError::Sqlite(other),
        })
}

/// 打卡（幂等 upsert）。同一 habit + date 永远只有一行。
pub fn set_log(
    conn: &Connection,
    habit_id: &str,
    date: &str,
    note: Option<String>,
) -> Result<HabitLog, RepoError> {
    validate_non_empty(date, "打卡日期")?;
    get(conn, habit_id)?;
    let id = new_id();
    conn.execute(
        "INSERT INTO habit_logs (id, space_id, habit_id, log_date, done, note)
         VALUES (?1, ?2, ?3, ?4, 1, ?5)
         ON CONFLICT(habit_id, log_date) DO UPDATE SET
           done = 1,
           note = excluded.note,
           deleted_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = habit_logs.version + 1",
        params![
            id,
            DEFAULT_SPACE_ID,
            habit_id,
            date,
            note.unwrap_or_default()
        ],
    )?;
    get_log(conn, habit_id, date)
}

/// 取消打卡：软删除，date 仍占用唯一键；再次打卡会复活同一行。
pub fn delete_log(conn: &Connection, habit_id: &str, date: &str) -> Result<(), RepoError> {
    conn.execute(
        "UPDATE habit_logs SET
           done = 0,
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE habit_id = ?1 AND log_date = ?2 AND deleted_at IS NULL",
        params![habit_id, date],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn habits_list(
    state: State<'_, DbState>,
    query: Option<HabitQuery>,
) -> Result<Vec<Habit>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list(&connection, &query.unwrap_or_default()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn habits_get(state: State<'_, DbState>, id: String) -> Result<Habit, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    get(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn habits_create(state: State<'_, DbState>, input: NewHabit) -> Result<Habit, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    create(&connection, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn habits_update(
    state: State<'_, DbState>,
    id: String,
    input: HabitUpdate,
) -> Result<Habit, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    update(&connection, &id, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn habits_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn habit_logs_list(
    state: State<'_, DbState>,
    habit_id: String,
    query: Option<HabitLogQuery>,
) -> Result<Vec<HabitLog>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list_logs(&connection, &habit_id, &query.unwrap_or_default()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn habit_logs_set(
    state: State<'_, DbState>,
    habit_id: String,
    date: String,
    note: Option<String>,
) -> Result<HabitLog, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    set_log(&connection, &habit_id, &date, note).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn habit_logs_delete(
    state: State<'_, DbState>,
    habit_id: String,
    date: String,
) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete_log(&connection, &habit_id, &date).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::test_support;

    fn new_habit(id: &str, title: &str) -> NewHabit {
        NewHabit {
            id: Some(id.to_string()),
            space_id: None,
            title: title.to_string(),
            schedule: Some("每天 · 07:00".to_string()),
            icon: Some("sun".to_string()),
            color: Some("amber".to_string()),
            goal_per_week: Some(5),
            sort_order: Some(1.0),
            archived: None,
        }
    }

    #[test]
    fn crud_archive_and_filters() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let habit = create(&connection, new_habit("habit-a", "早起")).expect("create");
        assert_eq!(habit.goal_per_week, 5);
        assert!(!habit.archived);

        let updated = update(
            &connection,
            "habit-a",
            HabitUpdate {
                title: "早起（工作日）".to_string(),
                schedule: "工作日 · 07:00".to_string(),
                icon: None,
                color: Some("blue".to_string()),
                goal_per_week: 5,
                sort_order: 2.0,
                archived: true,
            },
        )
        .expect("update");
        assert!(updated.archived);
        assert_eq!(updated.version, 2);

        let active = list(&connection, &HabitQuery::default()).expect("list");
        assert!(!active.iter().any(|item| item.id == "habit-a"));

        let all = list(
            &connection,
            &HabitQuery {
                include_archived: Some(true),
                ..HabitQuery::default()
            },
        )
        .expect("list archived");
        assert!(all.iter().any(|item| item.id == "habit-a"));

        delete(&connection, "habit-a").expect("delete");
        assert!(matches!(
            get(&connection, "habit-a"),
            Err(RepoError::NotFound { .. })
        ));
    }

    #[test]
    fn check_is_idempotent_and_uncheck_reactivates() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");
        create(&connection, new_habit("habit-check", "阅读")).expect("create");

        let first = set_log(
            &connection,
            "habit-check",
            "2026-10-26",
            Some("第二章".to_string()),
        )
        .expect("check");
        assert!(first.done);
        let second = set_log(&connection, "habit-check", "2026-10-26", None).expect("check again");
        assert_eq!(second.id, first.id, "same habit+date must reuse the row");
        assert_eq!(second.version, 2);

        let duplicate_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM habit_logs WHERE habit_id = 'habit-check'",
                [],
                |row| row.get(0),
            )
            .expect("count logs");
        assert_eq!(duplicate_count, 1);

        delete_log(&connection, "habit-check", "2026-10-26").expect("uncheck");
        assert!(matches!(
            get_log(&connection, "habit-check", "2026-10-26"),
            Err(RepoError::NotFound { .. })
        ));
        let active =
            list_logs(&connection, "habit-check", &HabitLogQuery::default()).expect("list logs");
        assert!(active.is_empty());

        let revived = set_log(&connection, "habit-check", "2026-10-26", None).expect("recheck");
        assert_eq!(revived.id, first.id);
        assert!(revived.deleted_at.is_none());
    }

    #[test]
    fn log_range_filter_and_orphan_habit_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");
        create(&connection, new_habit("habit-range", "整理")).expect("create");

        set_log(&connection, "habit-range", "2026-10-01", None).expect("log 1");
        set_log(&connection, "habit-range", "2026-10-15", None).expect("log 2");
        set_log(&connection, "habit-range", "2026-11-01", None).expect("log 3");

        let october = list_logs(
            &connection,
            "habit-range",
            &HabitLogQuery {
                from: Some("2026-10-01".to_string()),
                to: Some("2026-10-31".to_string()),
                ..HabitLogQuery::default()
            },
        )
        .expect("range logs");
        assert_eq!(october.len(), 2);

        let error = set_log(&connection, "no-such-habit", "2026-10-01", None)
            .expect_err("orphan habit must fail");
        assert!(matches!(error, RepoError::NotFound { .. }));
    }

    #[test]
    fn invalid_goal_is_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let mut habit = new_habit("habit-bad", "坏目标");
        habit.goal_per_week = Some(9);
        assert!(matches!(
            create(&connection, habit),
            Err(RepoError::Invalid(_))
        ));
    }
}
