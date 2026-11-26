//! 笔记待办仓储。与全局任务状态独立，仅通过 task_id 显式关联（不镜像状态）。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::notes::ContentCrypto;
use super::{
    bool_to_int, ensure_changed, int_to_bool, new_id, validate_non_empty, RepoError,
    DEFAULT_SPACE_ID,
};
use crate::db::DbState;
use crate::note_crypto::NoteCipher;
use crate::note_encryption::NoteEncryptionState;

const COLUMNS: &str = "id, space_id, note_id, task_id, title, done, due_date, \
                       reminder_enabled, sort_order, created_at, updated_at, deleted_at, version, \
                       encrypted";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteTodo {
    pub id: String,
    pub space_id: String,
    pub note_id: String,
    pub task_id: Option<String>,
    pub title: String,
    pub done: bool,
    pub due_date: Option<String>,
    pub reminder_enabled: bool,
    pub sort_order: f64,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
    #[serde(default)]
    pub encrypted: bool,
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNoteTodo {
    pub id: Option<String>,
    pub space_id: Option<String>,
    pub note_id: String,
    pub task_id: Option<String>,
    pub title: String,
    pub done: Option<bool>,
    pub due_date: Option<String>,
    pub reminder_enabled: Option<bool>,
    pub sort_order: Option<f64>,
    #[serde(default)]
    pub encrypted: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTodoUpdate {
    pub task_id: Option<String>,
    pub title: String,
    pub done: bool,
    pub due_date: Option<String>,
    pub reminder_enabled: bool,
    pub sort_order: f64,
    #[serde(default)]
    pub encrypted: Option<bool>,
}

fn map_todo(row: &Row<'_>, crypto: ContentCrypto<'_>) -> rusqlite::Result<NoteTodo> {
    let id: String = row.get("id")?;
    let raw_title: String = row.get("title")?;
    let encrypted = int_to_bool(row.get("encrypted")?);
    let (title, locked) = if !encrypted {
        (raw_title, false)
    } else if let Some(cipher) = crypto.cipher() {
        (
            super::note_encryption::decrypt_todo_title(cipher, &id, &raw_title)
                .map_err(conversion_error)?,
            false,
        )
    } else if crypto.is_raw() {
        (raw_title, true)
    } else {
        (String::new(), true)
    };
    Ok(NoteTodo {
        id,
        space_id: row.get("space_id")?,
        note_id: row.get("note_id")?,
        task_id: row.get("task_id")?,
        title,
        done: int_to_bool(row.get("done")?),
        due_date: row.get("due_date")?,
        reminder_enabled: int_to_bool(row.get("reminder_enabled")?),
        sort_order: row.get("sort_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
        encrypted,
        locked,
    })
}

fn conversion_error(error: impl std::fmt::Display) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            error.to_string(),
        )),
    )
}

pub fn list(
    conn: &Connection,
    note_id: &str,
    include_deleted: bool,
) -> Result<Vec<NoteTodo>, RepoError> {
    list_with(conn, note_id, include_deleted, ContentCrypto::Plain)
}

pub fn list_with(
    conn: &Connection,
    note_id: &str,
    include_deleted: bool,
    crypto: ContentCrypto<'_>,
) -> Result<Vec<NoteTodo>, RepoError> {
    let sql = format!(
        "SELECT {COLUMNS} FROM note_todos
         WHERE note_id = ?1 AND (?2 = 1 OR deleted_at IS NULL)
         ORDER BY sort_order, created_at, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params![note_id, bool_to_int(include_deleted)], |row| {
        map_todo(row, crypto)
    })?;
    let mut todos = Vec::new();
    for row in rows {
        todos.push(row?);
    }
    Ok(todos)
}

pub fn get(conn: &Connection, id: &str) -> Result<NoteTodo, RepoError> {
    get_with(conn, id, ContentCrypto::Plain)
}

pub fn get_with(
    conn: &Connection,
    id: &str,
    crypto: ContentCrypto<'_>,
) -> Result<NoteTodo, RepoError> {
    let sql = format!("SELECT {COLUMNS} FROM note_todos WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], |row| map_todo(row, crypto))
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("笔记待办", id),
            other => RepoError::Sqlite(other),
        })
}

pub fn create(conn: &Connection, input: NewNoteTodo) -> Result<NoteTodo, RepoError> {
    create_with(conn, input, ContentCrypto::Plain)
}

pub fn create_with(
    conn: &Connection,
    input: NewNoteTodo,
    crypto: ContentCrypto<'_>,
) -> Result<NoteTodo, RepoError> {
    validate_non_empty(&input.title, "待办标题")?;
    let note = super::notes::get_with(conn, &input.note_id, crypto)?;
    // Raw 是备份恢复：只搬运密文，不读取明文，因此锁定态也可以写入。
    // Plain 才代表“试图用明文覆盖加密笔记”，必须拒绝。
    if note.encrypted && note.locked && !crypto.is_raw() {
        return Err(RepoError::invalid("笔记已加密并锁定；拒绝写入笔记待办"));
    }
    let id = input.id.unwrap_or_else(new_id);
    let space_id = input
        .space_id
        .unwrap_or_else(|| DEFAULT_SPACE_ID.to_string());
    let title = input.title.trim().to_string();

    let (stored_title, encrypted) = match crypto {
        ContentCrypto::Keyed(cipher) => (
            super::note_encryption::encrypt_todo_title(cipher, &id, &title)?,
            true,
        ),
        ContentCrypto::Raw => {
            if input.encrypted != Some(true) {
                return Err(RepoError::invalid("原始恢复缺少 encrypted=true"));
            }
            if !crate::note_crypto::is_ciphertext(&title) {
                return Err(RepoError::invalid(
                    "备份中的加密待办不是知行密文格式，已拒绝写入",
                ));
            }
            (title, true)
        }
        ContentCrypto::Plain => {
            if note.encrypted {
                return Err(RepoError::invalid("笔记已加密；拒绝写入明文待办"));
            }
            (title, false)
        }
    };

    conn.execute(
        "INSERT INTO note_todos (
           id, space_id, note_id, task_id, title, done, due_date, reminder_enabled, sort_order,
           encrypted
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            space_id,
            input.note_id,
            input.task_id,
            stored_title,
            bool_to_int(input.done.unwrap_or(false)),
            input.due_date,
            bool_to_int(input.reminder_enabled.unwrap_or(false)),
            input.sort_order.unwrap_or(0.0),
            bool_to_int(encrypted)
        ],
    )?;
    get_with(conn, &id, crypto)
}

pub fn update(conn: &Connection, id: &str, input: NoteTodoUpdate) -> Result<NoteTodo, RepoError> {
    update_with(conn, id, input, ContentCrypto::Plain)
}

pub fn update_with(
    conn: &Connection,
    id: &str,
    input: NoteTodoUpdate,
    crypto: ContentCrypto<'_>,
) -> Result<NoteTodo, RepoError> {
    validate_non_empty(&input.title, "待办标题")?;
    let existing_encrypted: i64 = conn
        .query_row(
            "SELECT encrypted FROM note_todos WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get(0),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("笔记待办", id),
            other => RepoError::Sqlite(other),
        })?;
    let title = input.title.trim().to_string();

    let (stored_title, encrypted) = match crypto {
        ContentCrypto::Keyed(cipher) => (
            super::note_encryption::encrypt_todo_title(cipher, id, &title)?,
            true,
        ),
        ContentCrypto::Raw => {
            if input.encrypted != Some(true) {
                return Err(RepoError::invalid("原始恢复缺少 encrypted=true"));
            }
            if !crate::note_crypto::is_ciphertext(&title) {
                return Err(RepoError::invalid(
                    "备份中的加密待办不是知行密文格式，已拒绝写入",
                ));
            }
            (title, true)
        }
        ContentCrypto::Plain => {
            if existing_encrypted != 0 {
                return Err(RepoError::invalid(
                    "笔记待办已加密并锁定；拒绝用明文覆盖密文",
                ));
            }
            (title, false)
        }
    };

    let changed = conn.execute(
        "UPDATE note_todos SET
           task_id = ?1,
           title = ?2,
           done = ?3,
           due_date = ?4,
           reminder_enabled = ?5,
           sort_order = ?6,
           encrypted = ?7,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?8 AND deleted_at IS NULL",
        params![
            input.task_id,
            stored_title,
            bool_to_int(input.done),
            input.due_date,
            bool_to_int(input.reminder_enabled),
            input.sort_order,
            bool_to_int(encrypted),
            id
        ],
    )?;
    ensure_changed(changed, "笔记待办", id)?;
    get_with(conn, id, crypto)
}

/// 备份导出：所有待办（含回收站），加密待办原样返回 title 密文。
pub fn list_all_raw(conn: &Connection) -> Result<Vec<NoteTodo>, RepoError> {
    let sql = format!("SELECT {COLUMNS} FROM note_todos ORDER BY note_id, sort_order, id");
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map([], |row| map_todo(row, ContentCrypto::Raw))?;
    let mut todos = Vec::new();
    for row in rows {
        todos.push(row?);
    }
    Ok(todos)
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), RepoError> {
    let changed = conn.execute(
        "UPDATE note_todos SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "笔记待办", id)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

fn read_crypto(encryption: &NoteEncryptionState, conn: &Connection) -> Option<NoteCipher> {
    if encryption.status_with_conn(conn).enabled {
        encryption.cipher_if_unlocked()
    } else {
        None
    }
}

/// 命令层的加密选择，与 notes 的 `write_crypto` 保持同一语义：
/// * 未启用笔记加密：明文写入，不再要求配置口令；
/// * 已启用且已解锁：新写入必须加密；
/// * 已启用但锁定：返回可操作错误，绝不降级成明文；
/// * 备份恢复：原样写入密文，只需本机已有密钥信封。
enum TodoWriteCrypto {
    Plain,
    Keyed(NoteCipher),
    Raw,
}

impl TodoWriteCrypto {
    fn as_content(&self) -> ContentCrypto<'_> {
        match self {
            Self::Plain => ContentCrypto::Plain,
            Self::Keyed(cipher) => ContentCrypto::Keyed(cipher),
            Self::Raw => ContentCrypto::Raw,
        }
    }
}

fn write_crypto(
    encryption: &NoteEncryptionState,
    conn: &Connection,
    raw: bool,
) -> Result<TodoWriteCrypto, String> {
    if raw {
        if encryption.has_envelope() {
            return Ok(TodoWriteCrypto::Raw);
        }
        return Err("备份包含加密笔记待办，但本机未配置笔记加密密钥；请先导入密钥信封".to_string());
    }
    if encryption.status_with_conn(conn).enabled {
        Ok(TodoWriteCrypto::Keyed(encryption.cipher()?))
    } else {
        Ok(TodoWriteCrypto::Plain)
    }
}

#[tauri::command]
pub fn note_todos_list(
    state: State<'_, DbState>,
    encryption: State<'_, NoteEncryptionState>,
    note_id: String,
    include_deleted: Option<bool>,
) -> Result<Vec<NoteTodo>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    let cipher = read_crypto(&encryption, &connection);
    let crypto = cipher
        .as_ref()
        .map(ContentCrypto::Keyed)
        .unwrap_or(ContentCrypto::Plain);
    list_with(
        &connection,
        &note_id,
        include_deleted.unwrap_or(false),
        crypto,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn note_todos_create(
    state: State<'_, DbState>,
    encryption: State<'_, NoteEncryptionState>,
    input: NewNoteTodo,
) -> Result<NoteTodo, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    let crypto = write_crypto(&encryption, &connection, input.encrypted == Some(true))?;
    create_with(&connection, input, crypto.as_content()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn note_todos_update(
    state: State<'_, DbState>,
    encryption: State<'_, NoteEncryptionState>,
    id: String,
    input: NoteTodoUpdate,
) -> Result<NoteTodo, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    let crypto = write_crypto(&encryption, &connection, input.encrypted == Some(true))?;
    update_with(&connection, &id, input, crypto.as_content()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn note_todos_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn note_todos_export_rows(state: State<'_, DbState>) -> Result<Vec<NoteTodo>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list_all_raw(&connection).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::{tasks, test_support};

    #[test]
    fn linked_todo_state_is_independent_from_task_state() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let todo = create(
            &connection,
            NewNoteTodo {
                id: Some("todo-a".to_string()),
                space_id: None,
                note_id: super::super::seed::WELCOME_NOTE_ID.to_string(),
                task_id: Some("seed-task-review".to_string()),
                title: "写验收清单".to_string(),
                done: Some(false),
                due_date: None,
                reminder_enabled: Some(false),
                sort_order: Some(1.0),
                encrypted: None,
            },
        )
        .expect("create todo");
        assert!(!todo.done);

        let updated = update(
            &connection,
            "todo-a",
            NoteTodoUpdate {
                task_id: Some("seed-task-review".to_string()),
                title: "写验收清单".to_string(),
                done: true,
                due_date: Some("2026-10-30".to_string()),
                reminder_enabled: true,
                sort_order: 2.0,
                encrypted: None,
            },
        )
        .expect("complete note todo");
        assert!(updated.done);
        assert_eq!(updated.version, 2);

        let task = tasks::get(&connection, "seed-task-review").expect("task");
        assert_eq!(task.status, "todo", "笔记待办勾选不得改变全局任务状态");

        delete(&connection, "todo-a").expect("delete todo");
        let task_after = tasks::get(&connection, "seed-task-review").expect("task still exists");
        assert_eq!(task_after.id, task.id, "删除笔记待办不得级联任务");
        assert!(
            list(&connection, super::super::seed::WELCOME_NOTE_ID, false)
                .expect("list todos")
                .iter()
                .all(|item| item.id != "todo-a")
        );
    }

    #[test]
    fn orphan_note_or_task_is_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let orphan_note = create(
            &connection,
            NewNoteTodo {
                id: Some("todo-orphan-note".to_string()),
                space_id: None,
                note_id: "no-such-note".to_string(),
                task_id: None,
                title: "孤儿笔记待办".to_string(),
                done: None,
                due_date: None,
                reminder_enabled: None,
                sort_order: None,
                encrypted: None,
            },
        );
        assert!(matches!(orphan_note, Err(RepoError::NotFound { .. })));

        let orphan_task = create(
            &connection,
            NewNoteTodo {
                id: Some("todo-orphan-task".to_string()),
                space_id: None,
                note_id: super::super::seed::WELCOME_NOTE_ID.to_string(),
                task_id: Some("no-such-task".to_string()),
                title: "孤儿任务待办".to_string(),
                done: None,
                due_date: None,
                reminder_enabled: None,
                sort_order: None,
                encrypted: None,
            },
        );
        assert!(orphan_task.is_err());
        assert!(orphan_task.unwrap_err().to_string().contains("FOREIGN KEY"));
    }

    // -----------------------------------------------------------------------
    // 命令层 / 真实 Tauri IPC 回归
    //
    // 这里不直接调用 `create_with` 等内部函数，而是通过 mock runtime 把
    // JSON 请求送进 `#[tauri::command]` 注册表，覆盖参数反序列化、State
    // 注入、错误序列化与命令层加密选择。
    // -----------------------------------------------------------------------

    use serde::de::DeserializeOwned;
    use std::path::Path;
    use tauri::webview::InvokeRequest;
    use tauri::WebviewWindow;

    type TestWebview = WebviewWindow<tauri::test::MockRuntime>;
    const PASSPHRASE: &str = "correct horse battery";
    const NOTE_ID: &str = super::super::seed::WELCOME_NOTE_ID;

    fn command_app(dir: &Path) -> (tauri::App<tauri::test::MockRuntime>, TestWebview) {
        let path = dir.join("zhixing.db");
        let status = crate::db::migrate_path(&path).expect("migrate temp database");
        let db = crate::db::DbState::new(path, status);
        let encryption = NoteEncryptionState::with_store(
            crate::note_encryption::EnvelopeStore::file_only(dir.join("keys")),
        );
        let app = tauri::test::mock_builder()
            .manage(db)
            .manage(encryption)
            .invoke_handler(tauri::generate_handler![
                note_todos_list,
                note_todos_create,
                note_todos_update,
                note_todos_delete,
                note_todos_export_rows,
                crate::note_encryption::note_encryption_status,
                crate::note_encryption::note_encryption_enable,
                crate::note_encryption::note_encryption_unlock,
                crate::note_encryption::note_encryption_lock,
                crate::note_encryption::note_encryption_disable,
                crate::note_encryption::note_encryption_export_envelope,
                crate::note_encryption::note_encryption_import_envelope,
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock app");
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("build mock webview");
        (app, webview)
    }

    fn invoke<T: DeserializeOwned>(
        webview: &TestWebview,
        command: &str,
        args: serde_json::Value,
    ) -> Result<T, String> {
        let request = InvokeRequest {
            cmd: command.to_owned(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().expect("local url"),
            body: tauri::ipc::InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_owned(),
        };
        match tauri::test::get_ipc_response(webview, request) {
            Ok(body) => Ok(body
                .deserialize::<T>()
                .expect("deserialize command response")),
            Err(error) => Err(match error {
                serde_json::Value::String(message) => message,
                other => format!("{other}"),
            }),
        }
    }

    fn enable(webview: &TestWebview) {
        let _: serde_json::Value = invoke(
            webview,
            "note_encryption_enable",
            serde_json::json!({ "passphrase": PASSPHRASE }),
        )
        .expect("enable note encryption");
    }

    fn raw_todo_row(dir: &Path, id: &str) -> (String, i64, i64) {
        let connection =
            crate::db::open_connection(&dir.join("zhixing.db")).expect("open temp database");
        connection
            .query_row(
                "SELECT title, encrypted, done FROM note_todos WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("raw todo row")
    }

    fn seed_todo(id: &str, title: &str, done: bool, sort_order: f64) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "spaceId": null,
            "noteId": NOTE_ID,
            "taskId": null,
            "title": title,
            "done": done,
            "dueDate": null,
            "reminderEnabled": false,
            "sortOrder": sort_order,
        })
    }

    #[test]
    fn ipc_note_todo_crud_works_without_encryption() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (_app, webview) = command_app(dir.path());

        let created: NoteTodo = invoke(
            &webview,
            "note_todos_create",
            serde_json::json!({ "input": seed_todo("todo-plain", "未配置加密也能保存", false, 1.0) }),
        )
        .expect("create todo without encryption");
        assert_eq!(created.title, "未配置加密也能保存");
        assert!(!created.encrypted);
        assert!(!created.locked);

        let (raw_title, raw_encrypted, _) = raw_todo_row(dir.path(), "todo-plain");
        assert_eq!(raw_title, "未配置加密也能保存");
        assert_eq!(raw_encrypted, 0);

        let updated: NoteTodo = invoke(
            &webview,
            "note_todos_update",
            serde_json::json!({
                "id": "todo-plain",
                "input": {
                    "taskId": null,
                    "title": "未配置加密也能勾选",
                    "done": true,
                    "dueDate": "2026-11-02",
                    "reminderEnabled": true,
                    "sortOrder": 2.5,
                }
            }),
        )
        .expect("update todo without encryption");
        assert!(updated.done);
        assert_eq!(updated.title, "未配置加密也能勾选");
        assert_eq!(updated.sort_order, 2.5);
        assert_eq!(updated.version, created.version + 1);

        let listed: Vec<NoteTodo> = invoke(
            &webview,
            "note_todos_list",
            serde_json::json!({ "noteId": NOTE_ID, "includeDeleted": false }),
        )
        .expect("list todos without encryption");
        let found = listed
            .iter()
            .find(|todo| todo.id == "todo-plain")
            .expect("created todo in list");
        assert!(found.done);
        assert_eq!(found.title, "未配置加密也能勾选");

        let _: () = invoke(
            &webview,
            "note_todos_delete",
            serde_json::json!({ "id": "todo-plain" }),
        )
        .expect("delete todo without encryption");

        let after: Vec<NoteTodo> = invoke(
            &webview,
            "note_todos_list",
            serde_json::json!({ "noteId": NOTE_ID, "includeDeleted": false }),
        )
        .expect("list after delete");
        assert!(!after.iter().any(|todo| todo.id == "todo-plain"));
    }

    #[test]
    fn ipc_note_todo_writes_ciphertext_when_encryption_enabled() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (_app, webview) = command_app(dir.path());
        enable(&webview);

        let created: NoteTodo = invoke(
            &webview,
            "note_todos_create",
            serde_json::json!({ "input": seed_todo("todo-secret", "机密待办", false, 1.0) }),
        )
        .expect("create encrypted todo");
        assert!(created.encrypted);
        assert!(!created.locked);
        assert_eq!(created.title, "机密待办");

        let (raw_title, raw_encrypted, _) = raw_todo_row(dir.path(), "todo-secret");
        assert!(crate::note_crypto::is_ciphertext(&raw_title));
        assert!(!raw_title.contains("机密"));
        assert_eq!(raw_encrypted, 1);

        let updated: NoteTodo = invoke(
            &webview,
            "note_todos_update",
            serde_json::json!({
                "id": "todo-secret",
                "input": {
                    "taskId": null,
                    "title": "机密待办（已勾选）",
                    "done": true,
                    "dueDate": null,
                    "reminderEnabled": false,
                    "sortOrder": 3.0,
                }
            }),
        )
        .expect("update encrypted todo");
        assert!(updated.encrypted);
        assert!(updated.done);
        assert_eq!(updated.title, "机密待办（已勾选）");

        let (updated_raw_title, updated_raw_encrypted, raw_done) =
            raw_todo_row(dir.path(), "todo-secret");
        assert!(crate::note_crypto::is_ciphertext(&updated_raw_title));
        assert_ne!(updated_raw_title, raw_title);
        assert_eq!(updated_raw_encrypted, 1);
        assert_eq!(raw_done, 1);

        let listed: Vec<NoteTodo> = invoke(
            &webview,
            "note_todos_list",
            serde_json::json!({ "noteId": NOTE_ID, "includeDeleted": false }),
        )
        .expect("list encrypted todos");
        let found = listed
            .iter()
            .find(|todo| todo.id == "todo-secret")
            .expect("encrypted todo in list");
        assert_eq!(found.title, "机密待办（已勾选）");
        assert!(found.done);
        assert!(found.encrypted);
        assert!(!found.locked);

        let _: serde_json::Value = invoke(&webview, "note_encryption_lock", serde_json::json!({}))
            .expect("lock encryption");
        let locked: Vec<NoteTodo> = invoke(
            &webview,
            "note_todos_list",
            serde_json::json!({ "noteId": NOTE_ID, "includeDeleted": false }),
        )
        .expect("list while locked");
        let hidden = locked
            .iter()
            .find(|todo| todo.id == "todo-secret")
            .expect("locked todo in list");
        assert!(hidden.locked);
        assert_eq!(hidden.title, "");

        let _: serde_json::Value = invoke(
            &webview,
            "note_encryption_unlock",
            serde_json::json!({ "passphrase": PASSPHRASE }),
        )
        .expect("unlock encryption");
        let unlocked: Vec<NoteTodo> = invoke(
            &webview,
            "note_todos_list",
            serde_json::json!({ "noteId": NOTE_ID, "includeDeleted": false }),
        )
        .expect("list after unlock");
        assert_eq!(
            unlocked
                .iter()
                .find(|todo| todo.id == "todo-secret")
                .expect("unlocked todo")
                .title,
            "机密待办（已勾选）"
        );
    }

    #[test]
    fn ipc_disable_encryption_keeps_todos_and_reads_after_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (app, webview) = command_app(dir.path());
        enable(&webview);

        let _: NoteTodo = invoke(
            &webview,
            "note_todos_create",
            serde_json::json!({ "input": seed_todo("todo-toggle", "切换加密不丢待办", false, 1.0) }),
        )
        .expect("create encrypted todo");
        let _: NoteTodo = invoke(
            &webview,
            "note_todos_update",
            serde_json::json!({
                "id": "todo-toggle",
                "input": {
                    "taskId": null,
                    "title": "切换加密不丢待办",
                    "done": true,
                    "dueDate": null,
                    "reminderEnabled": false,
                    "sortOrder": 1.0,
                }
            }),
        )
        .expect("complete encrypted todo");

        let _: serde_json::Value = invoke(
            &webview,
            "note_encryption_disable",
            serde_json::json!({ "passphrase": null }),
        )
        .expect("disable encryption");

        let (raw_title, raw_encrypted, raw_done) = raw_todo_row(dir.path(), "todo-toggle");
        assert_eq!(raw_title, "切换加密不丢待办");
        assert_eq!(raw_encrypted, 0);
        assert_eq!(raw_done, 1);

        let after_disable: Vec<NoteTodo> = invoke(
            &webview,
            "note_todos_list",
            serde_json::json!({ "noteId": NOTE_ID, "includeDeleted": false }),
        )
        .expect("list after disable");
        let found = after_disable
            .iter()
            .find(|todo| todo.id == "todo-toggle")
            .expect("todo survives disable");
        assert!(found.done);
        assert_eq!(found.title, "切换加密不丢待办");
        assert!(!found.encrypted);

        drop(webview);
        drop(app);

        // 模拟重启：新连接、新加密状态，仍能读到关闭加密后的待办。
        let (_restarted_app, restarted) = command_app(dir.path());
        let restarted_list: Vec<NoteTodo> = invoke(
            &restarted,
            "note_todos_list",
            serde_json::json!({ "noteId": NOTE_ID, "includeDeleted": false }),
        )
        .expect("list after restart");
        let found = restarted_list
            .iter()
            .find(|todo| todo.id == "todo-toggle")
            .expect("todo after restart");
        assert!(found.done);
        assert_eq!(found.title, "切换加密不丢待办");
        assert!(!found.encrypted);
    }

    #[test]
    fn ipc_backup_export_and_restore_without_encryption_keeps_todos() {
        let source_dir = tempfile::tempdir().expect("source tempdir");
        let (source_app, source) = command_app(source_dir.path());

        let created: NoteTodo = invoke(
            &source,
            "note_todos_create",
            serde_json::json!({
                "input": {
                    "id": "todo-restore-plain",
                    "spaceId": null,
                    "noteId": NOTE_ID,
                    "taskId": "seed-task-review",
                    "title": "备份恢复的明文待办",
                    "done": true,
                    "dueDate": "2026-11-02",
                    "reminderEnabled": true,
                    "sortOrder": 4.25,
                }
            }),
        )
        .expect("create todo for backup");

        let exported: Vec<NoteTodo> =
            invoke(&source, "note_todos_export_rows", serde_json::json!({}))
                .expect("export note todos");
        let row = exported
            .iter()
            .find(|todo| todo.id == "todo-restore-plain")
            .expect("exported todo")
            .clone();
        assert!(!row.encrypted);
        assert_eq!(row.title, "备份恢复的明文待办");
        assert!(row.done);
        drop(source_app);
        drop(source);

        let target_dir = tempfile::tempdir().expect("target tempdir");
        let (_target_app, target) = command_app(target_dir.path());
        let restored: NoteTodo = invoke(
            &target,
            "note_todos_create",
            serde_json::json!({ "input": row }),
        )
        .expect("restore plain todo");

        assert_eq!(restored.id, created.id);
        assert_eq!(restored.title, "备份恢复的明文待办");
        assert!(restored.done);
        assert_eq!(restored.task_id.as_deref(), Some("seed-task-review"));
        assert_eq!(restored.sort_order, 4.25);
        assert!(!restored.encrypted);

        let listed: Vec<NoteTodo> = invoke(
            &target,
            "note_todos_list",
            serde_json::json!({ "noteId": NOTE_ID, "includeDeleted": false }),
        )
        .expect("list restored plain todo");
        let found = listed
            .iter()
            .find(|todo| todo.id == "todo-restore-plain")
            .expect("restored plain todo in list");
        assert!(found.done);
        assert_eq!(found.title, "备份恢复的明文待办");
        assert_eq!(found.sort_order, 4.25);
    }

    #[test]
    fn ipc_backup_restore_with_encryption_keeps_ciphertext_and_done_state() {
        let source_dir = tempfile::tempdir().expect("source tempdir");
        let (source_app, source) = command_app(source_dir.path());
        enable(&source);

        let _: NoteTodo = invoke(
            &source,
            "note_todos_create",
            serde_json::json!({ "input": seed_todo("todo-restore-secret", "备份恢复的加密待办", true, 7.5) }),
        )
        .expect("create encrypted todo for backup");

        let exported: Vec<NoteTodo> =
            invoke(&source, "note_todos_export_rows", serde_json::json!({}))
                .expect("export encrypted note todos");
        let row = exported
            .iter()
            .find(|todo| todo.id == "todo-restore-secret")
            .expect("exported encrypted todo")
            .clone();
        assert!(row.encrypted);
        assert!(crate::note_crypto::is_ciphertext(&row.title));

        let envelope: Option<String> = invoke(
            &source,
            "note_encryption_export_envelope",
            serde_json::json!({}),
        )
        .expect("export envelope");
        let envelope = envelope.expect("encryption envelope");
        drop(source_app);
        drop(source);

        let target_dir = tempfile::tempdir().expect("target tempdir");
        let (_target_app, target) = command_app(target_dir.path());
        let _: serde_json::Value = invoke(
            &target,
            "note_encryption_import_envelope",
            serde_json::json!({ "envelopeJson": envelope }),
        )
        .expect("import envelope");
        // 在目标库开启加密，使欢迎笔记与待办都处于加密态，覆盖“encrypted note + raw todo”路径。
        enable(&target);

        let restored: NoteTodo = invoke(
            &target,
            "note_todos_create",
            serde_json::json!({ "input": row }),
        )
        .expect("restore encrypted todo by raw ciphertext");
        assert!(restored.encrypted);
        assert_eq!(restored.id, "todo-restore-secret");

        let (raw_title, raw_encrypted, raw_done) =
            raw_todo_row(target_dir.path(), "todo-restore-secret");
        assert!(crate::note_crypto::is_ciphertext(&raw_title));
        assert_eq!(raw_encrypted, 1);
        assert_eq!(raw_done, 1);

        let listed: Vec<NoteTodo> = invoke(
            &target,
            "note_todos_list",
            serde_json::json!({ "noteId": NOTE_ID, "includeDeleted": false }),
        )
        .expect("list restored encrypted todo");
        let found = listed
            .iter()
            .find(|todo| todo.id == "todo-restore-secret")
            .expect("restored encrypted todo in list");
        assert_eq!(found.title, "备份恢复的加密待办");
        assert!(found.done);
        assert_eq!(found.sort_order, 7.5);

        let _: serde_json::Value = invoke(
            &target,
            "note_encryption_disable",
            serde_json::json!({ "passphrase": null }),
        )
        .expect("disable encryption after restore");
        let plain: Vec<NoteTodo> = invoke(
            &target,
            "note_todos_list",
            serde_json::json!({ "noteId": NOTE_ID, "includeDeleted": false }),
        )
        .expect("list restored todo after disable");
        let found = plain
            .iter()
            .find(|todo| todo.id == "todo-restore-secret")
            .expect("restored todo after disable");
        assert_eq!(found.title, "备份恢复的加密待办");
        assert!(found.done);
        assert!(!found.encrypted);
    }

    #[test]
    fn ipc_raw_restore_without_envelope_is_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (_app, webview) = command_app(dir.path());

        let error = invoke::<NoteTodo>(
            &webview,
            "note_todos_create",
            serde_json::json!({
                "input": {
                    "id": "todo-raw-no-key",
                    "spaceId": null,
                    "noteId": NOTE_ID,
                    "taskId": null,
                    "title": "无法解密的备份待办",
                    "done": false,
                    "dueDate": null,
                    "reminderEnabled": false,
                    "sortOrder": 1.0,
                    "encrypted": true,
                }
            }),
        )
        .expect_err("raw restore without envelope must be rejected");
        assert!(error.contains("密钥信封"), "unexpected error: {error}");
        assert!(
            !error.contains("尚未配置笔记加密"),
            "plaintext-create error must not leak into raw restore: {error}"
        );
    }
}
