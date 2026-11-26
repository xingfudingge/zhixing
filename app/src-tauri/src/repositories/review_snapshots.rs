//! 复盘快照仓储（P0-09）。
//!
//! 复盘是只读聚合：这里只写 `review_snapshots` 与生成它的复盘笔记，
//! 绝不反写 `tasks` / `focus_sessions` / `habit_logs`。
//!
//! * 同一 `space_id + range_start + range_end` 只允许一条活动快照；
//!   `save` 命中已有范围时直接返回原快照与笔记，重复点击不会重复创建。
//! * 复盘笔记与快照在同一事务内创建，避免出现“有笔记没来源”的半成品。
//! * 来源 ID 以 JSON 数组保存，源实体之后被软删除也仍可追溯。

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::notes::{self, NewNote, Note};
use super::{ensure_changed, new_id, validate_non_empty, RepoError, DEFAULT_SPACE_ID};
use crate::db::DbState;

const COLUMNS: &str = "id, space_id, range_start, range_end, task_ids_json, focus_ids_json, \
                       habit_ids_json, note_id, created_at, updated_at, deleted_at, version";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSnapshot {
    pub id: String,
    pub space_id: String,
    pub range_start: String,
    pub range_end: String,
    pub task_ids: Vec<String>,
    pub focus_ids: Vec<String>,
    pub habit_ids: Vec<String>,
    pub note_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSnapshotQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub note_id: Option<String>,
    pub include_deleted: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReviewInput {
    pub id: Option<String>,
    pub space_id: Option<String>,
    pub range_start: String,
    pub range_end: String,
    #[serde(default)]
    pub task_ids: Vec<String>,
    #[serde(default)]
    pub focus_ids: Vec<String>,
    #[serde(default)]
    pub habit_ids: Vec<String>,
    pub note: NewNote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedReview {
    pub snapshot: ReviewSnapshot,
    pub note: Note,
    /// 本次是否新建了快照；false 表示命中同范围已有快照（幂等）。
    pub created: bool,
}

fn parse_ids(index: usize, raw: String) -> rusqlite::Result<Vec<String>> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn map_snapshot(row: &Row<'_>) -> rusqlite::Result<ReviewSnapshot> {
    Ok(ReviewSnapshot {
        id: row.get("id")?,
        space_id: row.get("space_id")?,
        range_start: row.get("range_start")?,
        range_end: row.get("range_end")?,
        task_ids: parse_ids(4, row.get("task_ids_json")?)?,
        focus_ids: parse_ids(5, row.get("focus_ids_json")?)?,
        habit_ids: parse_ids(6, row.get("habit_ids_json")?)?,
        note_id: row.get("note_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
    })
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
}

fn validate_range(start: &str, end: &str) -> Result<(), RepoError> {
    if !is_iso_date(start) || !is_iso_date(end) {
        return Err(RepoError::invalid("复盘范围必须是 YYYY-MM-DD"));
    }
    if start > end {
        return Err(RepoError::invalid("复盘开始日期不能晚于结束日期"));
    }
    Ok(())
}

/// 去空白、去重并保留原始顺序，保证同一批来源生成稳定的快照内容。
fn normalize_ids(ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

pub fn list(
    conn: &Connection,
    query: &ReviewSnapshotQuery,
) -> Result<Vec<ReviewSnapshot>, RepoError> {
    let sql = format!(
        "SELECT {COLUMNS} FROM review_snapshots
         WHERE (?1 = 1 OR deleted_at IS NULL)
           AND (?2 IS NULL OR range_end >= ?2)
           AND (?3 IS NULL OR range_start <= ?3)
           AND (?4 IS NULL OR note_id = ?4)
         ORDER BY range_start DESC, created_at DESC, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            super::bool_to_int(query.include_deleted.unwrap_or(false)),
            query.from,
            query.to,
            query.note_id
        ],
        map_snapshot,
    )?;
    let mut snapshots = Vec::new();
    for row in rows {
        snapshots.push(row?);
    }
    Ok(snapshots)
}

pub fn get(conn: &Connection, id: &str) -> Result<ReviewSnapshot, RepoError> {
    let sql = format!("SELECT {COLUMNS} FROM review_snapshots WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], map_snapshot)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("复盘快照", id),
            other => RepoError::Sqlite(other),
        })
}

pub fn get_by_range(
    conn: &Connection,
    range_start: &str,
    range_end: &str,
) -> Result<Option<ReviewSnapshot>, RepoError> {
    let sql = format!(
        "SELECT {COLUMNS} FROM review_snapshots
         WHERE range_start = ?1 AND range_end = ?2 AND deleted_at IS NULL
         ORDER BY created_at, id
         LIMIT 1"
    );
    conn.query_row(&sql, params![range_start, range_end], map_snapshot)
        .optional()
        .map_err(RepoError::Sqlite)
}

/// 保存复盘：创建复盘笔记 + 快照；同范围重复调用返回已有结果。
pub fn save(conn: &mut Connection, input: SaveReviewInput) -> Result<SavedReview, RepoError> {
    validate_range(&input.range_start, &input.range_end)?;
    validate_non_empty(&input.note.title, "复盘笔记标题")?;

    let tx = conn.transaction()?;

    if let Some(existing) = get_by_range(&tx, &input.range_start, &input.range_end)? {
        if let Some(note_id) = existing.note_id.clone() {
            match notes::get(&tx, &note_id) {
                Ok(note) => {
                    return Ok(SavedReview {
                        snapshot: existing,
                        note,
                        created: false,
                    });
                }
                // 笔记被用户删除时补建一篇，但仍复用同一条快照。
                Err(RepoError::NotFound { .. }) => {}
                Err(error) => return Err(error),
            }
        }

        let note = notes::create(&tx, input.note)?;
        let changed = tx.execute(
            "UPDATE review_snapshots SET
               note_id = ?1,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               version = version + 1
             WHERE id = ?2 AND deleted_at IS NULL",
            params![note.id, existing.id],
        )?;
        ensure_changed(changed, "复盘快照", &existing.id)?;
        let snapshot = get(&tx, &existing.id)?;
        tx.commit()?;
        return Ok(SavedReview {
            snapshot,
            note,
            created: false,
        });
    }

    let note = notes::create(&tx, input.note)?;
    let id = input.id.unwrap_or_else(new_id);
    let space_id = input
        .space_id
        .unwrap_or_else(|| DEFAULT_SPACE_ID.to_string());
    let task_ids = super::to_json(&normalize_ids(input.task_ids))?;
    let focus_ids = super::to_json(&normalize_ids(input.focus_ids))?;
    let habit_ids = super::to_json(&normalize_ids(input.habit_ids))?;

    tx.execute(
        "INSERT INTO review_snapshots (
           id, space_id, range_start, range_end, task_ids_json, focus_ids_json,
           habit_ids_json, note_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            space_id,
            input.range_start,
            input.range_end,
            task_ids,
            focus_ids,
            habit_ids,
            note.id
        ],
    )?;

    let snapshot = get(&tx, &id)?;
    tx.commit()?;
    Ok(SavedReview {
        snapshot,
        note,
        created: true,
    })
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn review_snapshots_list(
    state: State<'_, DbState>,
    query: Option<ReviewSnapshotQuery>,
) -> Result<Vec<ReviewSnapshot>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list(&connection, &query.unwrap_or_default()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn review_snapshots_get(
    state: State<'_, DbState>,
    id: String,
) -> Result<ReviewSnapshot, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    get(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn review_snapshots_get_by_range(
    state: State<'_, DbState>,
    from: String,
    to: String,
) -> Result<Option<ReviewSnapshot>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    get_by_range(&connection, &from, &to).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn review_snapshots_save(
    state: State<'_, DbState>,
    input: SaveReviewInput,
) -> Result<SavedReview, String> {
    let mut connection = state.connection().map_err(|error| error.to_string())?;
    save(&mut connection, input).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::test_support;

    fn note_input(title: &str) -> NewNote {
        NewNote {
            id: None,
            space_id: None,
            title: title.to_string(),
            folder_id: None,
            tags: Some(vec!["复盘".to_string()]),
            body: Some("<h2>本周数据</h2>".to_string()),
            body_format: None,
            status: None,
            favorite: None,
            pinned: None,
            encrypted: None,
            encrypted_tags_json: None,
        }
    }

    fn input(start: &str, end: &str) -> SaveReviewInput {
        SaveReviewInput {
            id: None,
            space_id: None,
            range_start: start.to_string(),
            range_end: end.to_string(),
            task_ids: vec![
                "task-a".to_string(),
                "task-b".to_string(),
                "task-a".to_string(),
            ],
            focus_ids: vec!["focus-a".to_string()],
            habit_ids: vec!["habit-a".to_string(), "habit-b".to_string()],
            note: note_input("复盘 · 2026-10-26"),
        }
    }

    #[test]
    fn save_is_idempotent_and_keeps_source_ids() {
        let (_dir, repository) = test_support::repository();
        let mut connection = repository.connection().expect("connection");

        let first = save(&mut connection, input("2026-10-20", "2026-10-26")).expect("first save");
        assert!(first.created);
        assert_eq!(first.snapshot.task_ids, vec!["task-a", "task-b"]);
        assert_eq!(first.snapshot.focus_ids, vec!["focus-a"]);
        assert_eq!(first.snapshot.habit_ids, vec!["habit-a", "habit-b"]);
        assert_eq!(first.snapshot.note_id.as_deref(), Some(first.note.id.as_str()));
        assert_eq!(first.note.title, "复盘 · 2026-10-26");

        let second = save(&mut connection, input("2026-10-20", "2026-10-26")).expect("second save");
        assert!(!second.created);
        assert_eq!(second.snapshot.id, first.snapshot.id);
        assert_eq!(second.note.id, first.note.id);

        let snapshots = list(&connection, &ReviewSnapshotQuery::default()).expect("list");
        assert_eq!(snapshots.len(), 1);
        let note_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE title = '复盘 · 2026-10-26' AND deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count notes");
        assert_eq!(note_count, 1);
    }

    #[test]
    fn different_ranges_create_separate_snapshots() {
        let (_dir, repository) = test_support::repository();
        let mut connection = repository.connection().expect("connection");

        let first = save(&mut connection, input("2026-10-20", "2026-10-26")).expect("first");
        let second = save(&mut connection, input("2026-10-21", "2026-10-27")).expect("second");
        assert!(second.created);
        assert_ne!(first.snapshot.id, second.snapshot.id);
        assert_eq!(
            list(&connection, &ReviewSnapshotQuery::default())
                .expect("list")
                .len(),
            2
        );

        let by_range =
            get_by_range(&connection, "2026-10-20", "2026-10-26").expect("range query");
        assert_eq!(by_range.map(|row| row.id), Some(first.snapshot.id));
    }

    #[test]
    fn deleted_note_is_recreated_without_duplicating_snapshot() {
        let (_dir, repository) = test_support::repository();
        let mut connection = repository.connection().expect("connection");

        let first = save(&mut connection, input("2026-10-20", "2026-10-26")).expect("first");
        notes::delete(&connection, &first.note.id).expect("delete note");

        let second = save(&mut connection, input("2026-10-20", "2026-10-26")).expect("resave");
        assert!(!second.created);
        assert_eq!(second.snapshot.id, first.snapshot.id);
        assert_ne!(second.note.id, first.note.id);
        assert_eq!(
            second.snapshot.note_id.as_deref(),
            Some(second.note.id.as_str())
        );
        assert_eq!(
            list(&connection, &ReviewSnapshotQuery::default())
                .expect("list")
                .len(),
            1
        );
    }

    #[test]
    fn invalid_range_is_rejected_without_writing() {
        let (_dir, repository) = test_support::repository();
        let mut connection = repository.connection().expect("connection");

        let error = save(&mut connection, input("2026-10-27", "2026-10-20"))
            .expect_err("reversed range must fail");
        assert!(matches!(error, RepoError::Invalid(_)));

        let error =
            save(&mut connection, input("2026-10-20", "not-a-date")).expect_err("bad date");
        assert!(matches!(error, RepoError::Invalid(_)));
        assert!(list(&connection, &ReviewSnapshotQuery::default())
            .expect("list")
            .is_empty());
    }
}
