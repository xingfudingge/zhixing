//! 日历事件仓储。事件没有完成状态，也不会自动生成任务。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{
    bool_to_int, ensure_changed, int_to_bool, new_id, validate_non_empty, RepoError,
    DEFAULT_SPACE_ID,
};
use crate::db::DbState;

const COLUMNS: &str = "id, space_id, title, event_type, all_day, start_date, start_at, end_at, \
                       tz, source, external_uid, repeat_rule, calendar_type, note_id, color, \
                       created_at, updated_at, deleted_at, version";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub space_id: String,
    pub title: String,
    pub event_type: String,
    pub all_day: bool,
    pub start_date: String,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub tz: String,
    pub source: String,
    pub external_uid: Option<String>,
    pub repeat_rule: String,
    /// 日历标记，只取 `solar` / `lunar`；不自动换算下一次公历日期。
    pub calendar_type: String,
    pub note_id: Option<String>,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEvent {
    pub id: Option<String>,
    pub space_id: Option<String>,
    pub title: String,
    pub event_type: Option<String>,
    pub all_day: Option<bool>,
    pub start_date: String,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub tz: Option<String>,
    pub source: Option<String>,
    pub external_uid: Option<String>,
    pub repeat_rule: Option<String>,
    pub calendar_type: Option<String>,
    pub note_id: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventUpdate {
    pub title: String,
    pub event_type: String,
    pub all_day: bool,
    pub start_date: String,
    pub start_at: Option<String>,
    pub end_at: Option<String>,
    pub tz: Option<String>,
    pub source: Option<String>,
    pub external_uid: Option<String>,
    pub repeat_rule: Option<String>,
    pub calendar_type: String,
    pub note_id: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub note_id: Option<String>,
    pub include_deleted: Option<bool>,
}

fn validate_calendar_type(value: &str) -> Result<(), RepoError> {
    if matches!(value, "solar" | "lunar") {
        Ok(())
    } else {
        Err(RepoError::invalid(format!("历法类型无效：{value}")))
    }
}

fn map_event(row: &Row<'_>) -> rusqlite::Result<Event> {
    Ok(Event {
        id: row.get("id")?,
        space_id: row.get("space_id")?,
        title: row.get("title")?,
        event_type: row.get("event_type")?,
        all_day: int_to_bool(row.get("all_day")?),
        start_date: row.get("start_date")?,
        start_at: row.get("start_at")?,
        end_at: row.get("end_at")?,
        tz: row.get("tz")?,
        source: row.get("source")?,
        external_uid: row.get("external_uid")?,
        repeat_rule: row.get("repeat_rule")?,
        calendar_type: row.get("calendar_type")?,
        note_id: row.get("note_id")?,
        color: row.get("color")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
    })
}

pub fn list(conn: &Connection, query: &EventQuery) -> Result<Vec<Event>, RepoError> {
    let sql = format!(
        "SELECT {COLUMNS} FROM events
         WHERE (?1 = 1 OR deleted_at IS NULL)
           AND (?2 IS NULL OR start_date >= ?2)
           AND (?3 IS NULL OR start_date <= ?3)
           AND (?4 IS NULL OR note_id = ?4)
         ORDER BY start_date, COALESCE(start_at, ''), id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            bool_to_int(query.include_deleted.unwrap_or(false)),
            query.from,
            query.to,
            query.note_id
        ],
        map_event,
    )?;
    let mut events = Vec::new();
    for row in rows {
        events.push(row?);
    }
    Ok(events)
}

pub fn get(conn: &Connection, id: &str) -> Result<Event, RepoError> {
    let sql = format!("SELECT {COLUMNS} FROM events WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], map_event)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("事件", id),
            other => RepoError::Sqlite(other),
        })
}

pub fn create(conn: &Connection, input: NewEvent) -> Result<Event, RepoError> {
    validate_non_empty(&input.title, "事件标题")?;
    validate_non_empty(&input.start_date, "事件日期")?;
    let calendar_type = input
        .calendar_type
        .unwrap_or_else(|| "solar".to_string());
    validate_calendar_type(&calendar_type)?;
    let id = input.id.unwrap_or_else(new_id);
    let space_id = input
        .space_id
        .unwrap_or_else(|| DEFAULT_SPACE_ID.to_string());

    conn.execute(
        "INSERT INTO events (
           id, space_id, title, event_type, all_day, start_date, start_at, end_at, tz,
           source, external_uid, repeat_rule, calendar_type, note_id, color
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            id,
            space_id,
            input.title.trim(),
            input.event_type.unwrap_or_else(|| "个人日程".to_string()),
            bool_to_int(input.all_day.unwrap_or(false)),
            input.start_date,
            input.start_at,
            input.end_at,
            input.tz.unwrap_or_else(|| "Asia/Shanghai".to_string()),
            input.source.unwrap_or_else(|| "local".to_string()),
            input.external_uid,
            input.repeat_rule.unwrap_or_else(|| "单次".to_string()),
            calendar_type,
            input.note_id,
            input.color.unwrap_or_default()
        ],
    )?;
    get(conn, &id)
}

pub fn update(conn: &Connection, id: &str, input: EventUpdate) -> Result<Event, RepoError> {
    validate_non_empty(&input.title, "事件标题")?;
    validate_non_empty(&input.start_date, "事件日期")?;
    validate_calendar_type(&input.calendar_type)?;
    let changed = conn.execute(
        "UPDATE events SET
           title = ?1,
           event_type = ?2,
           all_day = ?3,
           start_date = ?4,
           start_at = ?5,
           end_at = ?6,
           tz = ?7,
           source = ?8,
           external_uid = ?9,
           repeat_rule = ?10,
           calendar_type = ?11,
           note_id = ?12,
           color = ?13,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?14 AND deleted_at IS NULL",
        params![
            input.title.trim(),
            input.event_type,
            bool_to_int(input.all_day),
            input.start_date,
            input.start_at,
            input.end_at,
            input.tz.unwrap_or_else(|| "Asia/Shanghai".to_string()),
            input.source.unwrap_or_else(|| "local".to_string()),
            input.external_uid,
            input.repeat_rule.unwrap_or_else(|| "单次".to_string()),
            input.calendar_type,
            input.note_id,
            input.color.unwrap_or_default(),
            id
        ],
    )?;
    ensure_changed(changed, "事件", id)?;
    get(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), RepoError> {
    let changed = conn.execute(
        "UPDATE events SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "事件", id)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn events_list(
    state: State<'_, DbState>,
    query: Option<EventQuery>,
) -> Result<Vec<Event>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list(&connection, &query.unwrap_or_default()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn events_get(state: State<'_, DbState>, id: String) -> Result<Event, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    get(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn events_create(state: State<'_, DbState>, input: NewEvent) -> Result<Event, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    create(&connection, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn events_update(
    state: State<'_, DbState>,
    id: String,
    input: EventUpdate,
) -> Result<Event, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    update(&connection, &id, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn events_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete(&connection, &id).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::test_support;

    fn new_event(id: &str, date: &str) -> NewEvent {
        NewEvent {
            id: Some(id.to_string()),
            space_id: None,
            title: "产品评审会".to_string(),
            event_type: Some("工作日程".to_string()),
            all_day: None,
            start_date: date.to_string(),
            start_at: Some(format!("{date}T10:00:00")),
            end_at: None,
            tz: None,
            source: None,
            external_uid: None,
            repeat_rule: Some("单次".to_string()),
            calendar_type: None,
            note_id: None,
            color: None,
        }
    }

    #[test]
    fn crud_and_range_filter() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let event = create(&connection, new_event("event-a", "2026-11-01")).expect("create");
        assert_eq!(event.event_type, "工作日程");
        assert!(!event.all_day);
        assert_eq!(event.calendar_type, "solar");
        assert_eq!(event.version, 1);

        create(&connection, new_event("event-b", "2026-12-01")).expect("create");

        let range = list(
            &connection,
            &EventQuery {
                from: Some("2026-11-01".to_string()),
                to: Some("2026-11-30".to_string()),
                ..EventQuery::default()
            },
        )
        .expect("range query");
        assert_eq!(range.len(), 1);
        assert_eq!(range[0].id, "event-a");

        let updated = update(
            &connection,
            "event-a",
            EventUpdate {
                title: "产品评审会（改期）".to_string(),
                event_type: "工作日程".to_string(),
                all_day: true,
                start_date: "2026-11-02".to_string(),
                start_at: None,
                end_at: None,
                tz: None,
                source: None,
                external_uid: None,
                repeat_rule: Some("每年".to_string()),
                calendar_type: "solar".to_string(),
                note_id: Some(super::super::seed::WELCOME_NOTE_ID.to_string()),
                color: Some("#5579d5".to_string()),
            },
        )
        .expect("update");
        assert_eq!(updated.title, "产品评审会（改期）");
        assert!(updated.all_day);
        assert_eq!(updated.start_at, None);
        assert_eq!(updated.calendar_type, "solar");
        assert_eq!(updated.version, 2);

        delete(&connection, "event-a").expect("delete");
        assert!(matches!(
            get(&connection, "event-a"),
            Err(RepoError::NotFound { .. })
        ));
        let active = list(&connection, &EventQuery::default()).expect("list");
        assert!(!active.iter().any(|event| event.id == "event-a"));
    }

    #[test]
    fn lunar_event_is_stored_as_marker_without_converting_dates() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let mut event = new_event("event-lunar", "2026-11-01");
        event.title = "妈妈的农历生日".to_string();
        event.event_type = Some("生日".to_string());
        event.repeat_rule = Some("每年".to_string());
        event.calendar_type = Some("lunar".to_string());
        let created = create(&connection, event).expect("create lunar event");
        assert_eq!(created.calendar_type, "lunar");
        // 农历只是标记：日期原样保存，不做农历→公历换算。
        assert_eq!(created.start_date, "2026-11-01");

        let updated = update(
            &connection,
            "event-lunar",
            EventUpdate {
                title: "妈妈的生日".to_string(),
                event_type: "生日".to_string(),
                all_day: true,
                start_date: "2026-11-01".to_string(),
                start_at: None,
                end_at: None,
                tz: None,
                source: None,
                external_uid: None,
                repeat_rule: Some("每年".to_string()),
                calendar_type: "solar".to_string(),
                note_id: None,
                color: None,
            },
        )
        .expect("update back to solar");
        assert_eq!(updated.calendar_type, "solar");
    }

    #[test]
    fn invalid_calendar_type_is_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let mut event = new_event("event-mayan", "2026-11-01");
        event.calendar_type = Some("mayan".to_string());
        let error = create(&connection, event).expect_err("invalid calendar type");
        assert!(error.to_string().contains("历法类型无效"));

        let created = create(&connection, new_event("event-ok", "2026-11-01")).expect("create");
        let error = update(
            &connection,
            "event-ok",
            EventUpdate {
                title: created.title.clone(),
                event_type: created.event_type.clone(),
                all_day: created.all_day,
                start_date: created.start_date.clone(),
                start_at: created.start_at.clone(),
                end_at: created.end_at.clone(),
                tz: Some(created.tz.clone()),
                source: Some(created.source.clone()),
                external_uid: created.external_uid.clone(),
                repeat_rule: Some(created.repeat_rule.clone()),
                calendar_type: "lunar-ish".to_string(),
                note_id: created.note_id.clone(),
                color: Some(created.color.clone()),
            },
        )
        .expect_err("invalid update calendar type");
        assert!(error.to_string().contains("历法类型无效"));
    }

    #[test]
    fn existing_events_default_to_solar_after_migration() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        // 模拟迁移前写入的旧行：不提供 calendar_type，交给列默认值回填。
        connection
            .execute(
                "INSERT INTO events (id, space_id, title, start_date)
                 VALUES ('event-legacy', 'personal', '旧事件', '2026-10-01')",
                [],
            )
            .expect("insert legacy event");

        let event = get(&connection, "event-legacy").expect("read legacy event");
        assert_eq!(event.calendar_type, "solar");
    }

    #[test]
    fn orphan_note_reference_is_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let mut event = new_event("event-bad-note", "2026-11-01");
        event.note_id = Some("no-such-note".to_string());
        let error = create(&connection, event).expect_err("missing note must fail");
        assert!(error.to_string().contains("FOREIGN KEY"));
    }
}
