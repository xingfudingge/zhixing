//! 画板仓储：boards / board_nodes / board_edges。
//!
//! 连线通过复合外键 (board_id, node_id) 保证两端节点属于同一画板；
//! 删除节点会在同一事务内软删除相连的边。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use super::{
    bool_to_int, ensure_changed, from_json, new_id, to_json, validate_non_empty, RepoError,
    DEFAULT_SPACE_ID,
};
use crate::db::DbState;

const BOARD_COLUMNS: &str = "id, space_id, note_id, title, background, snapshot_json, \
                             thumbnail_key, created_at, updated_at, deleted_at, version";
const NODE_COLUMNS: &str = "id, board_id, node_type, x, y, width, height, rotation, z_index, \
                            text, payload_json, created_at, updated_at, deleted_at, version";
const EDGE_COLUMNS: &str = "id, board_id, from_node_id, to_node_id, label, style_json, \
                            created_at, updated_at, deleted_at, version";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub id: String,
    pub space_id: String,
    pub note_id: Option<String>,
    pub title: String,
    pub background: String,
    pub snapshot: Value,
    pub thumbnail_key: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBoard {
    pub id: Option<String>,
    pub space_id: Option<String>,
    pub note_id: Option<String>,
    pub title: String,
    pub background: Option<String>,
    pub snapshot: Option<Value>,
    pub thumbnail_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardUpdate {
    pub note_id: Option<String>,
    pub title: String,
    pub background: String,
    pub snapshot: Value,
    pub thumbnail_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardQuery {
    pub note_id: Option<String>,
    pub include_deleted: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardNode {
    pub id: String,
    pub board_id: String,
    pub node_type: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub z_index: i64,
    pub text: String,
    pub payload: Value,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBoardNode {
    pub id: Option<String>,
    pub board_id: String,
    pub node_type: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub rotation: Option<f64>,
    pub z_index: Option<i64>,
    pub text: Option<String>,
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardNodeUpdate {
    pub node_type: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub z_index: i64,
    pub text: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardEdge {
    pub id: String,
    pub board_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub label: String,
    pub style: Value,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBoardEdge {
    pub id: Option<String>,
    pub board_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub label: Option<String>,
    pub style: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardEdgeUpdate {
    pub from_node_id: String,
    pub to_node_id: String,
    pub label: String,
    pub style: Value,
}

fn json_value(row: &Row<'_>, column: &str) -> rusqlite::Result<Value> {
    let raw: String = row.get(column)?;
    from_json(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                error.to_string(),
            )),
        )
    })
}

fn map_board(row: &Row<'_>) -> rusqlite::Result<Board> {
    Ok(Board {
        id: row.get("id")?,
        space_id: row.get("space_id")?,
        note_id: row.get("note_id")?,
        title: row.get("title")?,
        background: row.get("background")?,
        snapshot: json_value(row, "snapshot_json")?,
        thumbnail_key: row.get("thumbnail_key")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
    })
}

fn map_node(row: &Row<'_>) -> rusqlite::Result<BoardNode> {
    Ok(BoardNode {
        id: row.get("id")?,
        board_id: row.get("board_id")?,
        node_type: row.get("node_type")?,
        x: row.get("x")?,
        y: row.get("y")?,
        width: row.get("width")?,
        height: row.get("height")?,
        rotation: row.get("rotation")?,
        z_index: row.get("z_index")?,
        text: row.get("text")?,
        payload: json_value(row, "payload_json")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
    })
}

fn map_edge(row: &Row<'_>) -> rusqlite::Result<BoardEdge> {
    Ok(BoardEdge {
        id: row.get("id")?,
        board_id: row.get("board_id")?,
        from_node_id: row.get("from_node_id")?,
        to_node_id: row.get("to_node_id")?,
        label: row.get("label")?,
        style: json_value(row, "style_json")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
    })
}

// ---------------------------------------------------------------------------
// 画板
// ---------------------------------------------------------------------------

pub fn list(conn: &Connection, query: &BoardQuery) -> Result<Vec<Board>, RepoError> {
    let sql = format!(
        "SELECT {BOARD_COLUMNS} FROM boards
         WHERE (?1 = 1 OR deleted_at IS NULL)
           AND (?2 IS NULL OR note_id = ?2)
         ORDER BY updated_at DESC, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            bool_to_int(query.include_deleted.unwrap_or(false)),
            query.note_id
        ],
        map_board,
    )?;
    let mut boards = Vec::new();
    for row in rows {
        boards.push(row?);
    }
    Ok(boards)
}

pub fn get(conn: &Connection, id: &str) -> Result<Board, RepoError> {
    let sql = format!("SELECT {BOARD_COLUMNS} FROM boards WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], map_board)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("画板", id),
            other => RepoError::Sqlite(other),
        })
}

pub fn create(conn: &Connection, input: NewBoard) -> Result<Board, RepoError> {
    validate_non_empty(&input.title, "画板标题")?;
    let id = input.id.unwrap_or_else(new_id);
    let space_id = input
        .space_id
        .unwrap_or_else(|| DEFAULT_SPACE_ID.to_string());
    let snapshot = to_json(&input.snapshot.unwrap_or(Value::Object(Default::default())))?;

    conn.execute(
        "INSERT INTO boards (
           id, space_id, note_id, title, background, snapshot_json, thumbnail_key
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            space_id,
            input.note_id,
            input.title.trim(),
            input.background.unwrap_or_else(|| "dot".to_string()),
            snapshot,
            input.thumbnail_key
        ],
    )?;
    get(conn, &id)
}

pub fn update(conn: &Connection, id: &str, input: BoardUpdate) -> Result<Board, RepoError> {
    validate_non_empty(&input.title, "画板标题")?;
    let snapshot = to_json(&input.snapshot)?;
    let changed = conn.execute(
        "UPDATE boards SET
           note_id = ?1,
           title = ?2,
           background = ?3,
           snapshot_json = ?4,
           thumbnail_key = ?5,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?6 AND deleted_at IS NULL",
        params![
            input.note_id,
            input.title.trim(),
            input.background,
            snapshot,
            input.thumbnail_key,
            id
        ],
    )?;
    ensure_changed(changed, "画板", id)?;
    get(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), RepoError> {
    get(conn, id)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE board_edges SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE board_id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    tx.execute(
        "UPDATE board_nodes SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE board_id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    let changed = tx.execute(
        "UPDATE boards SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "画板", id)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

pub fn list_nodes(
    conn: &Connection,
    board_id: &str,
    include_deleted: bool,
) -> Result<Vec<BoardNode>, RepoError> {
    let sql = format!(
        "SELECT {NODE_COLUMNS} FROM board_nodes
         WHERE board_id = ?1 AND (?2 = 1 OR deleted_at IS NULL)
         ORDER BY z_index, created_at, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params![board_id, bool_to_int(include_deleted)], map_node)?;
    let mut nodes = Vec::new();
    for row in rows {
        nodes.push(row?);
    }
    Ok(nodes)
}

pub fn get_node(conn: &Connection, id: &str) -> Result<BoardNode, RepoError> {
    let sql =
        format!("SELECT {NODE_COLUMNS} FROM board_nodes WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], map_node)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("画板节点", id),
            other => RepoError::Sqlite(other),
        })
}

pub fn create_node(conn: &Connection, input: NewBoardNode) -> Result<BoardNode, RepoError> {
    // 只允许活跃画板；外键无法过滤软删除。
    get(conn, &input.board_id)?;
    let id = input.id.unwrap_or_else(new_id);
    let payload = to_json(&input.payload.unwrap_or(Value::Object(Default::default())))?;
    conn.execute(
        "INSERT INTO board_nodes (
           id, board_id, node_type, x, y, width, height, rotation, z_index, text, payload_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            id,
            input.board_id,
            input.node_type.unwrap_or_else(|| "process".to_string()),
            input.x.unwrap_or(0.0),
            input.y.unwrap_or(0.0),
            input.width.unwrap_or(150.0),
            input.height.unwrap_or(60.0),
            input.rotation.unwrap_or(0.0),
            input.z_index.unwrap_or(0),
            input.text.unwrap_or_default(),
            payload
        ],
    )?;
    get_node(conn, &id)
}

pub fn update_node(
    conn: &Connection,
    id: &str,
    input: BoardNodeUpdate,
) -> Result<BoardNode, RepoError> {
    let payload = to_json(&input.payload)?;
    let changed = conn.execute(
        "UPDATE board_nodes SET
           node_type = ?1,
           x = ?2,
           y = ?3,
           width = ?4,
           height = ?5,
           rotation = ?6,
           z_index = ?7,
           text = ?8,
           payload_json = ?9,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?10 AND deleted_at IS NULL",
        params![
            input.node_type,
            input.x,
            input.y,
            input.width,
            input.height,
            input.rotation,
            input.z_index,
            input.text,
            payload,
            id
        ],
    )?;
    ensure_changed(changed, "画板节点", id)?;
    get_node(conn, id)
}

/// 软删除节点时同事务软删除相连边，避免画布出现悬空连线。
pub fn delete_node(conn: &Connection, id: &str) -> Result<(), RepoError> {
    let node = get_node(conn, id)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE board_edges SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE board_id = ?1
           AND (from_node_id = ?2 OR to_node_id = ?2)
           AND deleted_at IS NULL",
        params![node.board_id, id],
    )?;
    let changed = tx.execute(
        "UPDATE board_nodes SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "画板节点", id)?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 连线
// ---------------------------------------------------------------------------

pub fn list_edges(
    conn: &Connection,
    board_id: &str,
    include_deleted: bool,
) -> Result<Vec<BoardEdge>, RepoError> {
    let sql = format!(
        "SELECT {EDGE_COLUMNS} FROM board_edges
         WHERE board_id = ?1 AND (?2 = 1 OR deleted_at IS NULL)
         ORDER BY created_at, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params![board_id, bool_to_int(include_deleted)], map_edge)?;
    let mut edges = Vec::new();
    for row in rows {
        edges.push(row?);
    }
    Ok(edges)
}

pub fn get_edge(conn: &Connection, id: &str) -> Result<BoardEdge, RepoError> {
    let sql =
        format!("SELECT {EDGE_COLUMNS} FROM board_edges WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], map_edge)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("画板连线", id),
            other => RepoError::Sqlite(other),
        })
}

fn ensure_active_node(conn: &Connection, board_id: &str, node_id: &str) -> Result<(), RepoError> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM board_nodes
         WHERE id = ?1 AND board_id = ?2 AND deleted_at IS NULL",
        params![node_id, board_id],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Err(RepoError::invalid(format!(
            "连线端点 {node_id} 不存在、已删除或不属于该画板"
        )));
    }
    Ok(())
}

pub fn create_edge(conn: &Connection, input: NewBoardEdge) -> Result<BoardEdge, RepoError> {
    if input.from_node_id == input.to_node_id {
        return Err(RepoError::invalid("连线两端不能是同一个节点"));
    }
    get(conn, &input.board_id)?;
    ensure_active_node(conn, &input.board_id, &input.from_node_id)?;
    ensure_active_node(conn, &input.board_id, &input.to_node_id)?;

    let id = input.id.unwrap_or_else(new_id);
    let style = to_json(&input.style.unwrap_or(Value::Object(Default::default())))?;
    conn.execute(
        "INSERT INTO board_edges (
           id, board_id, from_node_id, to_node_id, label, style_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            id,
            input.board_id,
            input.from_node_id,
            input.to_node_id,
            input.label.unwrap_or_default(),
            style
        ],
    )?;
    get_edge(conn, &id)
}

pub fn update_edge(
    conn: &Connection,
    id: &str,
    input: BoardEdgeUpdate,
) -> Result<BoardEdge, RepoError> {
    if input.from_node_id == input.to_node_id {
        return Err(RepoError::invalid("连线两端不能是同一个节点"));
    }
    let existing = get_edge(conn, id)?;
    ensure_active_node(conn, &existing.board_id, &input.from_node_id)?;
    ensure_active_node(conn, &existing.board_id, &input.to_node_id)?;
    let style = to_json(&input.style)?;
    let changed = conn.execute(
        "UPDATE board_edges SET
           from_node_id = ?1,
           to_node_id = ?2,
           label = ?3,
           style_json = ?4,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?5 AND deleted_at IS NULL",
        params![input.from_node_id, input.to_node_id, input.label, style, id],
    )?;
    ensure_changed(changed, "画板连线", id)?;
    get_edge(conn, id)
}

pub fn delete_edge(conn: &Connection, id: &str) -> Result<(), RepoError> {
    let changed = conn.execute(
        "UPDATE board_edges SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "画板连线", id)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn boards_list(
    state: State<'_, DbState>,
    query: Option<BoardQuery>,
) -> Result<Vec<Board>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list(&connection, &query.unwrap_or_default()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn boards_get(state: State<'_, DbState>, id: String) -> Result<Board, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    get(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn boards_create(state: State<'_, DbState>, input: NewBoard) -> Result<Board, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    create(&connection, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn boards_update(
    state: State<'_, DbState>,
    id: String,
    input: BoardUpdate,
) -> Result<Board, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    update(&connection, &id, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn boards_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn board_nodes_list(
    state: State<'_, DbState>,
    board_id: String,
    include_deleted: Option<bool>,
) -> Result<Vec<BoardNode>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list_nodes(&connection, &board_id, include_deleted.unwrap_or(false))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn board_nodes_create(
    state: State<'_, DbState>,
    input: NewBoardNode,
) -> Result<BoardNode, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    create_node(&connection, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn board_nodes_update(
    state: State<'_, DbState>,
    id: String,
    input: BoardNodeUpdate,
) -> Result<BoardNode, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    update_node(&connection, &id, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn board_nodes_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete_node(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn board_edges_list(
    state: State<'_, DbState>,
    board_id: String,
    include_deleted: Option<bool>,
) -> Result<Vec<BoardEdge>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list_edges(&connection, &board_id, include_deleted.unwrap_or(false))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn board_edges_create(
    state: State<'_, DbState>,
    input: NewBoardEdge,
) -> Result<BoardEdge, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    create_edge(&connection, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn board_edges_update(
    state: State<'_, DbState>,
    id: String,
    input: BoardEdgeUpdate,
) -> Result<BoardEdge, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    update_edge(&connection, &id, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn board_edges_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete_edge(&connection, &id).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::test_support;

    fn create_test_board(conn: &Connection, id: &str) -> Board {
        create(
            conn,
            NewBoard {
                id: Some(id.to_string()),
                space_id: None,
                note_id: None,
                title: "测试画板".to_string(),
                background: None,
                snapshot: None,
                thumbnail_key: None,
            },
        )
        .expect("create board")
    }

    fn create_test_node(conn: &Connection, id: &str, board_id: &str) -> BoardNode {
        create_node(
            conn,
            NewBoardNode {
                id: Some(id.to_string()),
                board_id: board_id.to_string(),
                node_type: Some("process".to_string()),
                x: Some(10.0),
                y: Some(20.0),
                width: None,
                height: None,
                rotation: None,
                z_index: None,
                text: Some("节点".to_string()),
                payload: None,
            },
        )
        .expect("create node")
    }

    #[test]
    fn board_node_edge_crud() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let board = create_test_board(&connection, "board-a");
        assert_eq!(board.background, "dot");
        assert_eq!(board.snapshot, serde_json::json!({}));

        let updated = update(
            &connection,
            "board-a",
            BoardUpdate {
                note_id: Some(super::super::seed::WELCOME_NOTE_ID.to_string()),
                title: "测试画板 2".to_string(),
                background: "grid".to_string(),
                snapshot: serde_json::json!({ "version": 1 }),
                thumbnail_key: Some("thumb-a".to_string()),
            },
        )
        .expect("update board");
        assert_eq!(updated.title, "测试画板 2");
        assert_eq!(updated.snapshot["version"], 1);
        assert_eq!(updated.version, 2);

        let node_a = create_test_node(&connection, "node-a", "board-a");
        create_test_node(&connection, "node-b", "board-a");
        assert_eq!(node_a.width, 150.0);

        let edge = create_edge(
            &connection,
            NewBoardEdge {
                id: Some("edge-a".to_string()),
                board_id: "board-a".to_string(),
                from_node_id: "node-a".to_string(),
                to_node_id: "node-b".to_string(),
                label: Some("是".to_string()),
                style: None,
            },
        )
        .expect("create edge");
        assert_eq!(edge.label, "是");

        assert_eq!(
            list_nodes(&connection, "board-a", false)
                .expect("nodes")
                .len(),
            2
        );
        assert_eq!(
            list_edges(&connection, "board-a", false)
                .expect("edges")
                .len(),
            1
        );

        let updated_edge = update_edge(
            &connection,
            "edge-a",
            BoardEdgeUpdate {
                from_node_id: "node-a".to_string(),
                to_node_id: "node-b".to_string(),
                label: "否".to_string(),
                style: serde_json::json!({ "stroke": "#5579d5" }),
            },
        )
        .expect("update edge");
        assert_eq!(updated_edge.label, "否");
        assert_eq!(updated_edge.version, 2);

        delete_edge(&connection, "edge-a").expect("delete edge");
        assert!(matches!(
            get_edge(&connection, "edge-a"),
            Err(RepoError::NotFound { .. })
        ));

        delete_node(&connection, "node-a").expect("delete node");
        assert!(list_nodes(&connection, "board-a", false)
            .expect("nodes")
            .iter()
            .all(|node| node.id != "node-a"));

        delete(&connection, "board-a").expect("delete board");
        assert!(matches!(
            get(&connection, "board-a"),
            Err(RepoError::NotFound { .. })
        ));
    }

    #[test]
    fn cross_board_edge_is_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        create_test_board(&connection, "board-1");
        create_test_board(&connection, "board-2");
        create_test_node(&connection, "node-1", "board-1");
        create_test_node(&connection, "node-2", "board-2");

        let error = create_edge(
            &connection,
            NewBoardEdge {
                id: Some("edge-cross".to_string()),
                board_id: "board-1".to_string(),
                from_node_id: "node-1".to_string(),
                to_node_id: "node-2".to_string(),
                label: None,
                style: None,
            },
        )
        .expect_err("cross-board edge must fail");
        assert!(matches!(error, RepoError::Invalid(_)));
    }

    #[test]
    fn deleting_node_cascades_soft_delete_to_edges() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        create_test_board(&connection, "board-c");
        create_test_node(&connection, "node-c-start", "board-c");
        create_test_node(&connection, "node-d", "board-c");
        create_edge(
            &connection,
            NewBoardEdge {
                id: Some("edge-c".to_string()),
                board_id: "board-c".to_string(),
                from_node_id: "node-c-start".to_string(),
                to_node_id: "node-d".to_string(),
                label: None,
                style: None,
            },
        )
        .expect("create edge");

        delete_node(&connection, "node-c-start").expect("delete node");
        assert!(list_edges(&connection, "board-c", false)
            .expect("edges")
            .iter()
            .all(|edge| edge.id != "edge-c"));
        assert!(list_edges(&connection, "board-c", true)
            .expect("all edges")
            .iter()
            .any(|edge| edge.id == "edge-c"));
    }

    #[test]
    fn orphan_note_and_self_edge_are_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let error = create(
            &connection,
            NewBoard {
                id: Some("board-bad-note".to_string()),
                space_id: None,
                note_id: Some("no-such-note".to_string()),
                title: "坏画板".to_string(),
                background: None,
                snapshot: None,
                thumbnail_key: None,
            },
        )
        .expect_err("missing note must fail");
        assert!(error.to_string().contains("FOREIGN KEY"));

        create_test_board(&connection, "board-self");
        create_test_node(&connection, "node-self", "board-self");
        let error = create_edge(
            &connection,
            NewBoardEdge {
                id: Some("edge-self".to_string()),
                board_id: "board-self".to_string(),
                from_node_id: "node-self".to_string(),
                to_node_id: "node-self".to_string(),
                label: None,
                style: None,
            },
        )
        .expect_err("self edge must fail");
        assert!(matches!(error, RepoError::Invalid(_)));
    }
}
