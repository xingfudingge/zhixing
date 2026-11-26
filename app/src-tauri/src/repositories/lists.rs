//! 任务清单仓储。收件箱（is_inbox=1）是不可删除的产品不变量。
//!
//! ZX-UX-02 树状清单：
//! * `parent_id` 为 NULL 表示根级；收件箱必须是根级、固定第一。
//! * 用户清单最多 3 层；写入前在同一事务内做跨空间、环与深度校验。
//! * 删除父清单时任务移到收件箱、子清单上移一级，全部单事务完成。
//! * `lists_move` 是唯一修改父级的入口，避免 `lists_update` 的“未传/传 null”歧义。

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{
    bool_to_int, ensure_changed, int_to_bool, new_id, validate_non_empty, RepoError,
    DEFAULT_SPACE_ID,
};
use crate::db::DbState;

const COLUMNS: &str = "id, space_id, name, color, icon, parent_id, sort_order, is_inbox, \
                       created_at, updated_at, deleted_at, version";

/// 用户清单最大层级：根级=1，子=2，孙=3。
pub const MAX_LIST_DEPTH: i64 = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct List {
    pub id: String,
    pub space_id: String,
    pub name: String,
    pub color: String,
    pub icon: String,
    pub parent_id: Option<String>,
    pub sort_order: f64,
    pub is_inbox: bool,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewList {
    pub id: Option<String>,
    pub space_id: Option<String>,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub parent_id: Option<String>,
    pub sort_order: Option<f64>,
    pub is_inbox: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListUpdate {
    pub name: String,
    pub color: String,
    pub icon: Option<String>,
    pub sort_order: f64,
}

/// 独立移动命令：`parent_id = null` 明确表示移到根级。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMove {
    pub parent_id: Option<String>,
    pub sort_order: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListDeleteResult {
    pub moved_tasks: usize,
    pub promoted_lists: usize,
    pub inbox_id: String,
}

fn map_list(row: &Row<'_>) -> rusqlite::Result<List> {
    Ok(List {
        id: row.get("id")?,
        space_id: row.get("space_id")?,
        name: row.get("name")?,
        color: row.get("color")?,
        icon: row.get("icon")?,
        parent_id: row.get("parent_id")?,
        sort_order: row.get("sort_order")?,
        is_inbox: int_to_bool(row.get("is_inbox")?),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
    })
}

pub fn list(conn: &Connection, include_deleted: bool) -> Result<Vec<List>, RepoError> {
    let sql = format!(
        "SELECT {COLUMNS} FROM lists
         WHERE (?1 = 1 OR deleted_at IS NULL)
         ORDER BY sort_order, name, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params![bool_to_int(include_deleted)], map_list)?;
    let mut lists = Vec::new();
    for row in rows {
        lists.push(row?);
    }
    Ok(lists)
}

pub fn get(conn: &Connection, id: &str) -> Result<List, RepoError> {
    let sql = format!("SELECT {COLUMNS} FROM lists WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], map_list)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("清单", id),
            other => RepoError::Sqlite(other),
        })
}

pub fn create(conn: &Connection, input: NewList) -> Result<List, RepoError> {
    validate_non_empty(&input.name, "清单名称")?;
    let id = input.id.unwrap_or_else(new_id);
    let space_id = input
        .space_id
        .unwrap_or_else(|| DEFAULT_SPACE_ID.to_string());
    let color = input.color.unwrap_or_else(|| "#5579d5".to_string());
    let icon = input.icon.unwrap_or_default();
    let is_inbox = input.is_inbox.unwrap_or(false);

    let tx = conn.unchecked_transaction()?;

    if is_inbox {
        if input.parent_id.is_some() {
            return Err(RepoError::invalid("收件箱必须位于根级"));
        }
        let existing: i64 = tx.query_row(
            "SELECT COUNT(*) FROM lists
             WHERE space_id = ?1 AND is_inbox = 1 AND deleted_at IS NULL",
            params![space_id],
            |row| row.get(0),
        )?;
        if existing > 0 {
            return Err(RepoError::invalid("该空间已存在收件箱，不能重复创建"));
        }
    }

    if let Some(parent_id) = input.parent_id.as_deref() {
        validate_parent(&tx, &space_id, parent_id)?;
        let depth = list_depth(&tx, parent_id)? + 1;
        if depth > MAX_LIST_DEPTH {
            return Err(RepoError::invalid("最多支持 3 层清单"));
        }
    }

    ensure_unique_name(
        &tx,
        &space_id,
        input.name.trim(),
        input.parent_id.as_deref(),
        None,
    )?;

    let sort_order = if is_inbox {
        0.0
    } else {
        match input.sort_order {
            Some(value) => value,
            None => next_sort_order(&tx, &space_id, input.parent_id.as_deref())?,
        }
    };

    tx.execute(
        "INSERT INTO lists (id, space_id, name, color, icon, parent_id, sort_order, is_inbox)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            space_id,
            input.name.trim(),
            color,
            icon,
            input.parent_id,
            sort_order,
            bool_to_int(is_inbox)
        ],
    )?;
    if !is_inbox {
        normalize_sibling_sort_orders(&tx, &space_id, input.parent_id.as_deref())?;
    }
    tx.commit()?;

    get(conn, &id)
}

pub fn update(conn: &Connection, id: &str, input: ListUpdate) -> Result<List, RepoError> {
    validate_non_empty(&input.name, "清单名称")?;
    let current = get(conn, id)?;
    ensure_unique_name(
        conn,
        &current.space_id,
        input.name.trim(),
        current.parent_id.as_deref(),
        Some(id),
    )?;
    let changed = conn.execute(
        "UPDATE lists SET
           name = ?1,
           color = ?2,
           icon = ?3,
           sort_order = ?4,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?5 AND deleted_at IS NULL",
        params![
            input.name.trim(),
            input.color,
            input.icon.unwrap_or_default(),
            input.sort_order,
            id
        ],
    )?;
    ensure_changed(changed, "清单", id)?;
    get(conn, id)
}

/// 修改父级与同级顺序。所有校验与写入在同一个 IMMEDIATE 事务内完成。
pub fn move_list(conn: &Connection, id: &str, input: ListMove) -> Result<List, RepoError> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let target = get(&tx, id)?;
    if target.is_inbox {
        return Err(RepoError::invalid("收件箱是系统清单，不能移动"));
    }

    if let Some(parent_id) = input.parent_id.as_deref() {
        if parent_id == id {
            return Err(RepoError::invalid("清单不能移动到自己的子清单下"));
        }
        let parent = validate_parent(&tx, &target.space_id, parent_id)?;
        if parent.is_inbox {
            return Err(RepoError::invalid("不能把清单放到收件箱下"));
        }
        if is_descendant(&tx, parent_id, id)? {
            return Err(RepoError::invalid("清单不能移动到自己的子清单下"));
        }
        let parent_depth = list_depth(&tx, parent_id)?;
        let height = subtree_height(&tx, id)?;
        if parent_depth + height > MAX_LIST_DEPTH {
            return Err(RepoError::invalid("最多支持 3 层清单"));
        }
    }

    let changed = tx.execute(
        "UPDATE lists SET
           parent_id = ?1,
           sort_order = ?2,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?3 AND deleted_at IS NULL",
        params![input.parent_id, input.sort_order, id],
    )?;
    ensure_changed(changed, "清单", id)?;

    // 连续插入导致同级间距过小时，在同一事务内重排为 10, 20, 30…
    normalize_sibling_sort_orders(&tx, &target.space_id, input.parent_id.as_deref())?;
    tx.commit()?;

    get(conn, id)
}

/// 软删除清单：任务移到收件箱；子清单上移一级；全部在同一事务内完成。
pub fn delete(conn: &Connection, id: &str) -> Result<ListDeleteResult, RepoError> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let target = get(&tx, id)?;
    if target.is_inbox {
        return Err(RepoError::invalid("收件箱是系统清单，不能删除"));
    }

    let inbox_id: String = tx
        .query_row(
            "SELECT id FROM lists
             WHERE space_id = ?1 AND is_inbox = 1 AND deleted_at IS NULL
             LIMIT 1",
            params![target.space_id],
            |row| row.get(0),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                RepoError::invalid("找不到可用收件箱，无法迁移清单内任务")
            }
            other => RepoError::Sqlite(other),
        })?;

    let moved = tx.execute(
        "UPDATE tasks SET
           list_id = ?1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE list_id = ?2 AND deleted_at IS NULL",
        params![inbox_id, id],
    )?;

    // 子清单上移一级（保持相对顺序），再统一重排目标父级的兄弟顺序。
    let promoted = tx.execute(
        "UPDATE lists SET
           parent_id = ?1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE parent_id = ?2 AND deleted_at IS NULL",
        params![target.parent_id, id],
    )?;

    resequence_siblings(&tx, &target.space_id, target.parent_id.as_deref(), Some(id))?;

    let changed = tx.execute(
        "UPDATE lists SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "清单", id)?;
    tx.commit()?;

    Ok(ListDeleteResult {
        moved_tasks: moved,
        promoted_lists: promoted,
        inbox_id,
    })
}

/// 启动自检：父节点存在、同空间、收件箱为根、无环、深度 ≤3。
/// 任何一项失败都返回错误，由调用方保留备份并进入失败页。
pub fn validate_tree(conn: &Connection) -> Result<(), RepoError> {
    let mut statement = conn
        .prepare("SELECT id, parent_id, space_id, is_inbox FROM lists WHERE deleted_at IS NULL")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            int_to_bool(row.get::<_, i64>(3)?),
        ))
    })?;

    for row in rows {
        let (id, parent_id, space_id, is_inbox) = row?;
        if is_inbox && parent_id.is_some() {
            return Err(RepoError::invalid(format!(
                "收件箱 {id} 必须位于根级（parent_id 为 NULL）"
            )));
        }
        if let Some(parent_id) = parent_id.as_deref() {
            let parent: Option<(String, bool, Option<String>)> = conn
                .query_row(
                    "SELECT space_id, is_inbox, deleted_at FROM lists WHERE id = ?1",
                    params![parent_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            int_to_bool(row.get::<_, i64>(1)?),
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()?;
            let Some((parent_space, parent_is_inbox, parent_deleted)) = parent else {
                return Err(RepoError::invalid(format!(
                    "清单 {id} 的父清单 {parent_id} 不存在"
                )));
            };
            if parent_deleted.is_some() {
                return Err(RepoError::invalid(format!(
                    "清单 {id} 的父清单 {parent_id} 已删除"
                )));
            }
            if parent_is_inbox {
                return Err(RepoError::invalid(format!(
                    "清单 {id} 不能挂在收件箱 {parent_id} 下"
                )));
            }
            if parent_space != space_id {
                return Err(RepoError::invalid(format!(
                    "清单 {id} 与父清单 {parent_id} 跨空间"
                )));
            }
        }
        let depth = list_depth(conn, &id)?;
        if depth > MAX_LIST_DEPTH {
            return Err(RepoError::invalid(format!(
                "清单 {id} 的层级为 {depth}，超过最多 3 层"
            )));
        }
    }
    Ok(())
}

fn validate_parent(
    conn: &Connection,
    space_id: &str,
    parent_id: &str,
) -> Result<List, RepoError> {
    let parent = get(conn, parent_id)?;
    if parent.is_inbox {
        return Err(RepoError::invalid("不能把清单放到收件箱下"));
    }
    if parent.space_id != space_id {
        return Err(RepoError::invalid("父子清单必须属于同一空间"));
    }
    Ok(parent)
}

fn ensure_unique_name(
    conn: &Connection,
    space_id: &str,
    name: &str,
    parent_id: Option<&str>,
    exclude_id: Option<&str>,
) -> Result<(), RepoError> {
    let existing: i64 = conn.query_row(
        "SELECT COUNT(*) FROM lists
         WHERE space_id = ?1
           AND deleted_at IS NULL
           AND lower(name) = lower(?2)
           AND ((?3 IS NULL AND parent_id IS NULL) OR parent_id = ?3)
           AND (?4 IS NULL OR id <> ?4)",
        params![space_id, name, parent_id, exclude_id],
        |row| row.get(0),
    )?;
    if existing > 0 {
        return Err(RepoError::invalid("同一父级下已存在同名清单"));
    }
    Ok(())
}

/// 从清单自身向上数到根，根级返回 1。超过 32 层视为环。
fn list_depth(conn: &Connection, id: &str) -> Result<i64, RepoError> {
    let mut current = Some(id.to_string());
    let mut depth = 0;
    while let Some(node) = current {
        depth += 1;
        if depth > 32 {
            return Err(RepoError::invalid("清单层级存在循环"));
        }
        let parent: Option<Option<String>> = conn
            .query_row(
                "SELECT parent_id FROM lists WHERE id = ?1 AND deleted_at IS NULL",
                params![node],
                |row| row.get(0),
            )
            .optional()?;
        match parent {
            Some(parent) => current = parent,
            None => return Err(RepoError::not_found("清单", node)),
        }
    }
    Ok(depth)
}

/// 被移动子树的高度（含自身）。
fn subtree_height(conn: &Connection, id: &str) -> Result<i64, RepoError> {
    let mut frontier = vec![id.to_string()];
    let mut height = 0;
    while !frontier.is_empty() {
        height += 1;
        if height > 32 {
            return Err(RepoError::invalid("清单层级存在循环"));
        }
        let mut next = Vec::new();
        for node in frontier {
            let mut statement =
                conn.prepare("SELECT id FROM lists WHERE parent_id = ?1 AND deleted_at IS NULL")?;
            let rows = statement.query_map(params![node], |row| row.get::<_, String>(0))?;
            for row in rows {
                next.push(row?);
            }
        }
        frontier = next;
    }
    Ok(height)
}

/// `candidate` 是否在被移动节点 `root` 的子树中（含自身）。
fn is_descendant(conn: &Connection, candidate: &str, root: &str) -> Result<bool, RepoError> {
    let mut current = Some(candidate.to_string());
    let mut guard = 0;
    while let Some(node) = current {
        if node == root {
            return Ok(true);
        }
        guard += 1;
        if guard > 32 {
            return Err(RepoError::invalid("清单层级存在循环"));
        }
        let parent: Option<Option<String>> = conn
            .query_row(
                "SELECT parent_id FROM lists WHERE id = ?1 AND deleted_at IS NULL",
                params![node],
                |row| row.get(0),
            )
            .optional()?;
        match parent {
            Some(parent) => current = parent,
            None => return Ok(false),
        }
    }
    Ok(false)
}

fn next_sort_order(
    conn: &Connection,
    space_id: &str,
    parent_id: Option<&str>,
) -> Result<f64, RepoError> {
    let max: f64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), 0) FROM lists
         WHERE space_id = ?1
           AND deleted_at IS NULL
           AND is_inbox = 0
           AND ((?2 IS NULL AND parent_id IS NULL) OR parent_id = ?2)",
        params![space_id, parent_id],
        |row| row.get(0),
    )?;
    Ok(max + 10.0)
}

fn sibling_rows(
    conn: &Connection,
    space_id: &str,
    parent_id: Option<&str>,
    exclude_id: Option<&str>,
) -> Result<Vec<(String, f64)>, RepoError> {
    let mut statement = conn.prepare(
        "SELECT id, sort_order FROM lists
         WHERE space_id = ?1
           AND deleted_at IS NULL
           AND is_inbox = 0
           AND ((?2 IS NULL AND parent_id IS NULL) OR parent_id = ?2)
           AND (?3 IS NULL OR id <> ?3)
         ORDER BY sort_order, name, id",
    )?;
    let rows = statement.query_map(params![space_id, parent_id, exclude_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
    })?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row?);
    }
    Ok(result)
}

fn normalize_sibling_sort_orders(
    conn: &Connection,
    space_id: &str,
    parent_id: Option<&str>,
) -> Result<(), RepoError> {
    let rows = sibling_rows(conn, space_id, parent_id, None)?;
    let needs_resequence = rows
        .windows(2)
        .any(|pair| (pair[1].1 - pair[0].1).abs() < 0.001);
    if !needs_resequence {
        return Ok(());
    }
    for (index, (id, _)) in rows.iter().enumerate() {
        conn.execute(
            "UPDATE lists SET
               sort_order = ?1,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               version = version + 1
             WHERE id = ?2 AND deleted_at IS NULL",
            params![((index + 1) as f64) * 10.0, id],
        )?;
    }
    Ok(())
}

fn resequence_siblings(
    conn: &Connection,
    space_id: &str,
    parent_id: Option<&str>,
    exclude_id: Option<&str>,
) -> Result<(), RepoError> {
    let rows = sibling_rows(conn, space_id, parent_id, exclude_id)?;
    for (index, (id, _)) in rows.iter().enumerate() {
        conn.execute(
            "UPDATE lists SET
               sort_order = ?1,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               version = version + 1
             WHERE id = ?2 AND deleted_at IS NULL",
            params![((index + 1) as f64) * 10.0, id],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn lists_list(
    state: State<'_, DbState>,
    include_deleted: Option<bool>,
) -> Result<Vec<List>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list(&connection, include_deleted.unwrap_or(false)).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn lists_get(state: State<'_, DbState>, id: String) -> Result<List, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    get(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn lists_create(state: State<'_, DbState>, input: NewList) -> Result<List, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    create(&connection, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn lists_update(
    state: State<'_, DbState>,
    id: String,
    input: ListUpdate,
) -> Result<List, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    update(&connection, &id, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn lists_move(state: State<'_, DbState>, id: String, input: ListMove) -> Result<List, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    move_list(&connection, &id, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn lists_delete(state: State<'_, DbState>, id: String) -> Result<ListDeleteResult, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete(&connection, &id).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::{tasks, test_support};

    fn new_list(name: &str, parent_id: Option<&str>) -> NewList {
        NewList {
            id: None,
            space_id: None,
            name: name.to_string(),
            color: None,
            icon: None,
            parent_id: parent_id.map(ToString::to_string),
            sort_order: None,
            is_inbox: Some(false),
        }
    }

    fn list_id(conn: &Connection, name: &str) -> String {
        conn.query_row(
            "SELECT id FROM lists WHERE name = ?1 AND deleted_at IS NULL",
            params![name],
            |row| row.get(0),
        )
        .expect("find list by name")
    }

    #[test]
    fn crud_and_soft_delete() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let created = create(
            &connection,
            NewList {
                id: None,
                space_id: None,
                name: "  实验清单  ".to_string(),
                color: Some("#123456".to_string()),
                icon: Some("flask".to_string()),
                parent_id: None,
                sort_order: Some(5.0),
                is_inbox: Some(false),
            },
        )
        .expect("create list");
        assert_eq!(created.name, "实验清单");
        assert_eq!(created.color, "#123456");
        assert_eq!(created.parent_id, None);
        assert!(!created.is_inbox);
        assert_eq!(created.version, 1);

        let fetched = get(&connection, &created.id).expect("get list");
        assert_eq!(fetched, created);

        let updated = update(
            &connection,
            &created.id,
            ListUpdate {
                name: "实验清单 2".to_string(),
                color: "#654321".to_string(),
                icon: None,
                sort_order: 6.0,
            },
        )
        .expect("update list");
        assert_eq!(updated.name, "实验清单 2");
        assert_eq!(updated.version, 2);
        assert_eq!(updated.icon, "");

        delete(&connection, &created.id).expect("delete list");
        assert!(matches!(
            get(&connection, &created.id),
            Err(RepoError::NotFound { .. })
        ));
        let active = list(&connection, false).expect("list active");
        assert!(!active.iter().any(|item| item.id == created.id));
        let all = list(&connection, true).expect("list all");
        assert!(all.iter().any(|item| item.id == created.id));
    }

    #[test]
    fn duplicate_inbox_is_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let error = create(
            &connection,
            NewList {
                id: Some("another-inbox".to_string()),
                space_id: None,
                name: "第二个收件箱".to_string(),
                color: None,
                icon: None,
                parent_id: None,
                sort_order: None,
                is_inbox: Some(true),
            },
        )
        .expect_err("duplicate inbox must fail");
        assert!(matches!(error, RepoError::Invalid(_)));
    }

    #[test]
    fn deleting_inbox_is_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let error = delete(&connection, "inbox").expect_err("inbox delete must fail");
        assert!(matches!(error, RepoError::Invalid(_)));
    }

    #[test]
    fn deleting_list_moves_tasks_to_inbox() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let task = tasks::create(
            &connection,
            tasks::NewTask {
                id: Some("move-me".to_string()),
                space_id: None,
                list_id: "work".to_string(),
                parent_id: None,
                note_id: None,
                title: "需要搬家的任务".to_string(),
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
            },
        )
        .expect("create task");

        let expected_moves: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM tasks WHERE list_id = 'work' AND deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count work tasks");
        let inbox_sort_before = get(&connection, "inbox").expect("inbox").sort_order;
        let result = delete(&connection, "work").expect("delete work list");
        assert_eq!(
            get(&connection, "inbox").expect("inbox").sort_order,
            inbox_sort_before,
            "收件箱不参与用户根清单重排"
        );
        assert_eq!(result.moved_tasks as i64, expected_moves);
        assert_eq!(result.promoted_lists, 0);
        assert_eq!(result.inbox_id, "inbox");

        let moved = tasks::get(&connection, &task.id).expect("get moved task");
        assert_eq!(moved.list_id, "inbox");
    }

    #[test]
    fn three_level_tree_is_allowed_and_fourth_level_is_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let level2 = create(&connection, new_list("二级", Some("work"))).expect("level 2");
        let level3 = create(&connection, new_list("三级", Some(&level2.id))).expect("level 3");
        assert_eq!(list_depth(&connection, &level3.id).expect("depth"), 3);

        let error = create(&connection, new_list("四级", Some(&level3.id)))
            .expect_err("fourth level must fail");
        assert!(error.to_string().contains("最多支持 3 层清单"));
    }

    #[test]
    fn moving_list_under_own_child_is_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let child = create(&connection, new_list("子", Some("work"))).expect("child");
        let grandchild = create(&connection, new_list("孙", Some(&child.id))).expect("grandchild");

        let error = move_list(
            &connection,
            "work",
            ListMove {
                parent_id: Some(grandchild.id.clone()),
                sort_order: 40.0,
            },
        )
        .expect_err("cycle must fail");
        assert!(error.to_string().contains("不能移动到自己的子清单下"));

        let work = get(&connection, "work").expect("work");
        assert_eq!(work.parent_id, None);
    }

    #[test]
    fn inbox_cannot_be_child_or_receive_children() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let error = move_list(
            &connection,
            "work",
            ListMove {
                parent_id: Some("inbox".to_string()),
                sort_order: 10.0,
            },
        )
        .expect_err("drop under inbox must fail");
        assert!(error.to_string().contains("收件箱"));

        let error = move_list(
            &connection,
            "inbox",
            ListMove {
                parent_id: Some("work".to_string()),
                sort_order: 10.0,
            },
        )
        .expect_err("moving inbox must fail");
        assert!(error.to_string().contains("收件箱"));
    }

    #[test]
    fn deleting_parent_promotes_children_and_moves_tasks() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let child = create(&connection, new_list("项目 A", Some("work"))).expect("child");
        let grandchild =
            create(&connection, new_list("项目 A-1", Some(&child.id))).expect("grandchild");

        tasks::create(
            &connection,
            tasks::NewTask {
                id: Some("parent-task".to_string()),
                space_id: None,
                list_id: "work".to_string(),
                parent_id: None,
                note_id: None,
                title: "父清单任务".to_string(),
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
            },
        )
        .expect("create task");

        let result = delete(&connection, "work").expect("delete work");
        assert_eq!(result.promoted_lists, 1, "只有直接子清单上移");
        assert!(result.moved_tasks >= 1);

        let promoted = get(&connection, &child.id).expect("child promoted");
        assert_eq!(promoted.parent_id, None);
        let still_nested = get(&connection, &grandchild.id).expect("grandchild");
        assert_eq!(still_nested.parent_id.as_deref(), Some(child.id.as_str()));
        assert!(matches!(
            get(&connection, "work"),
            Err(RepoError::NotFound { .. })
        ));
    }

    #[test]
    fn moving_subtree_checks_height() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let level2 = create(&connection, new_list("二级", Some("work"))).expect("level 2");
        let level3 = create(&connection, new_list("三级", Some(&level2.id))).expect("level 3");
        let other = create(&connection, new_list("另一棵", None)).expect("other");
        let other_child =
            create(&connection, new_list("另一棵子", Some(&other.id))).expect("other child");

        let error = move_list(
            &connection,
            &level2.id,
            ListMove {
                parent_id: Some(other_child.id.clone()),
                sort_order: 10.0,
            },
        )
        .expect_err("subtree too deep");
        assert!(error.to_string().contains("最多支持 3 层清单"));

        let moved = move_list(
            &connection,
            &level3.id,
            ListMove {
                parent_id: Some(other_child.id.clone()),
                sort_order: 10.0,
            },
        )
        .expect("leaf can move");
        assert_eq!(moved.parent_id.as_deref(), Some(other_child.id.as_str()));
    }

    #[test]
    fn same_parent_names_are_unique_but_different_parents_may_repeat() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let error = create(&connection, new_list("生活", None)).expect_err("duplicate root");
        assert!(error.to_string().contains("同名清单"));

        create(&connection, new_list("生活", Some("work"))).expect("same name elsewhere");
    }

    #[test]
    fn invalid_data_is_detected_by_tree_self_check() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        // 绕过应用层直接构造环；触发器只挡自引用，环由启动自检发现。
        connection
            .execute("UPDATE lists SET parent_id = 'life' WHERE id = 'work'", [])
            .expect("make work child of life");
        connection
            .execute("UPDATE lists SET parent_id = 'work' WHERE id = 'life'", [])
            .expect("make life child of work");

        let error = validate_tree(&connection).expect_err("cycle must fail");
        assert!(error.to_string().contains("循环"));
    }

    #[test]
    fn moving_into_tight_gap_resequences_siblings() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let child = create(&connection, new_list("子", Some("work"))).expect("child");
        let moved = move_list(
            &connection,
            &child.id,
            ListMove {
                parent_id: None,
                sort_order: 10.0,
            },
        )
        .expect("move to root");
        assert_eq!(moved.parent_id, None);

        // 根级现有 work(10) 与 life(20) 之间插入；连续挤入后必须重排。
        let mut last = 10.0;
        for index in 0..20 {
            let list = create(
                &connection,
                NewList {
                    name: format!("挤入 {index}"),
                    parent_id: None,
                    sort_order: Some(last + 0.0005),
                    id: None,
                    space_id: None,
                    color: None,
                    icon: None,
                    is_inbox: Some(false),
                },
            )
            .expect("create squeezed list");
            last = list.sort_order;
        }
        let rows = sibling_rows(&connection, DEFAULT_SPACE_ID, None, None).expect("siblings");
        for pair in rows.windows(2) {
            assert!(
                (pair[1].1 - pair[0].1).abs() >= 0.001,
                "siblings must be resequenced"
            );
        }
    }

    #[test]
    fn legacy_rows_become_root_lists() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let listed = list_id(&connection, "工作");
        let work = get(&connection, &listed).expect("work");
        assert_eq!(work.parent_id, None);
        let inbox = get(&connection, "inbox").expect("inbox");
        assert_eq!(inbox.parent_id, None);
        validate_tree(&connection).expect("seed tree valid");
    }
}
