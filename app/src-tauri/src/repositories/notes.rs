//! 笔记与块投影仓储。
//!
//! `notes.body` 是兼容缓存；`note_blocks` 是编辑器用于搜索、导出、关系定位的投影。
//! 笔记删除是软删除（status=trashed + deleted_at），恢复保留原目录。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use super::{
    bool_to_int, ensure_changed, from_json, int_to_bool, new_id, to_json, validate_non_empty,
    RepoError, DEFAULT_SPACE_ID,
};
use crate::db::DbState;
use crate::note_crypto::NoteCipher;
use crate::note_encryption::NoteEncryptionState;

const COLUMNS: &str = "id, space_id, title, folder_id, tags_json, body, body_format, status, \
                       favorite, pinned, created_at, updated_at, deleted_at, version, \
                       encrypted, encrypted_tags_json";
const BLOCK_COLUMNS: &str = "id, note_id, block_type, order_key, payload_json, schema_version, \
                             created_at, updated_at, deleted_at, version, encrypted, \
                             encrypted_payload_json";

/// 读取/写入时如何对待内容字段。
///
/// * `Plain`：明文或已锁定。锁定笔记读出来是空内容 + `locked=true`。
/// * `Keyed`：已解锁，读时解密、写时加密。
/// * `Raw`：备份导出/恢复专用。原样搬运密文，不接触明文密钥。
#[derive(Clone, Copy)]
pub enum ContentCrypto<'a> {
    Plain,
    Keyed(&'a NoteCipher),
    Raw,
}

impl ContentCrypto<'_> {
    pub(crate) fn cipher(&self) -> Option<&NoteCipher> {
        match self {
            Self::Keyed(cipher) => Some(cipher),
            Self::Plain | Self::Raw => None,
        }
    }

    pub(crate) fn is_raw(&self) -> bool {
        matches!(self, Self::Raw)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub space_id: String,
    pub title: String,
    pub folder_id: Option<String>,
    pub tags: Vec<String>,
    pub body: String,
    pub body_format: String,
    pub status: String,
    pub favorite: bool,
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
    /// 该笔记内容是否已加密。加密笔记在锁定时 `title/body/tags` 为空。
    #[serde(default)]
    pub encrypted: bool,
    /// 当前读取是否因锁定而没有返回明文。
    #[serde(default)]
    pub locked: bool,
    /// 仅备份原始导出使用；普通读取不返回密文。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_tags_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNote {
    pub id: Option<String>,
    pub space_id: Option<String>,
    pub title: String,
    pub folder_id: Option<String>,
    pub tags: Option<Vec<String>>,
    pub body: Option<String>,
    pub body_format: Option<String>,
    pub status: Option<String>,
    pub favorite: Option<bool>,
    pub pinned: Option<bool>,
    /// 备份恢复：`true` 表示 title/body 已是密文，原样落库（需要本机已有信封）。
    #[serde(default)]
    pub encrypted: Option<bool>,
    #[serde(default)]
    pub encrypted_tags_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdate {
    pub title: String,
    pub folder_id: Option<String>,
    pub tags: Vec<String>,
    pub body: String,
    pub body_format: String,
    pub favorite: bool,
    pub pinned: bool,
    #[serde(default)]
    pub encrypted: Option<bool>,
    #[serde(default)]
    pub encrypted_tags_json: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteQuery {
    pub folder_id: Option<String>,
    pub status: Option<String>,
    pub favorite: Option<bool>,
    pub search: Option<String>,
    pub include_deleted: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteBlock {
    pub id: String,
    pub note_id: String,
    pub block_type: String,
    pub order_key: f64,
    pub payload: Value,
    pub schema_version: i64,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
    #[serde(default)]
    pub encrypted: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_payload_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNoteBlock {
    pub id: Option<String>,
    pub note_id: String,
    pub block_type: String,
    pub order_key: Option<f64>,
    pub payload: Option<Value>,
    pub schema_version: Option<i64>,
    #[serde(default)]
    pub encrypted: Option<bool>,
    #[serde(default)]
    pub encrypted_payload_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteBlockUpdate {
    pub block_type: String,
    pub order_key: f64,
    pub payload: Value,
    pub schema_version: Option<i64>,
    #[serde(default)]
    pub encrypted: Option<bool>,
    #[serde(default)]
    pub encrypted_payload_json: Option<String>,
}

/// 文件导入时随笔记一起提交的正文块；`note_id` 由事务内生成的笔记 ID 填充。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportNoteBlock {
    pub id: Option<String>,
    pub block_type: String,
    pub order_key: Option<f64>,
    pub payload: Option<Value>,
    pub schema_version: Option<i64>,
}

/// 文件导入时随笔记一起提交的笔记待办；与正文 todo 块共用 id。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportNoteTodo {
    pub id: Option<String>,
    pub title: String,
    pub done: Option<bool>,
    pub sort_order: Option<f64>,
}

/// 单文件导入的原子输入：笔记、块、待办必须在同一事务内落库。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportNoteInput {
    pub note: NewNote,
    #[serde(default)]
    pub blocks: Vec<ImportNoteBlock>,
    #[serde(default)]
    pub todos: Vec<ImportNoteTodo>,
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

fn parse_tags(raw: &str) -> rusqlite::Result<Vec<String>> {
    from_json(raw).map_err(conversion_error)
}

fn map_note(row: &Row<'_>, crypto: ContentCrypto<'_>) -> rusqlite::Result<Note> {
    let id: String = row.get("id")?;
    let raw_title: String = row.get("title")?;
    let raw_body: String = row.get("body")?;
    let raw_tags: String = row.get("tags_json")?;
    let encrypted = int_to_bool(row.get("encrypted")?);
    let encrypted_tags_json: Option<String> = row.get("encrypted_tags_json")?;

    let (title, body, tags, locked, raw_tags_out) = if !encrypted {
        (raw_title, raw_body, parse_tags(&raw_tags)?, false, None)
    } else if let Some(cipher) = crypto.cipher() {
        let cipher_text = encrypted_tags_json
            .clone()
            .ok_or_else(|| conversion_error("加密笔记缺少标签密文"))?;
        let (title, body, tags_json) =
            super::note_encryption::decrypt_note_fields(cipher, &id, &raw_title, &raw_body, &cipher_text)
                .map_err(conversion_error)?;
        (title, body, parse_tags(&tags_json)?, false, None)
    } else if crypto.is_raw() {
        (raw_title, raw_body, Vec::new(), true, encrypted_tags_json)
    } else {
        (String::new(), String::new(), Vec::new(), true, None)
    };

    Ok(Note {
        id,
        space_id: row.get("space_id")?,
        title,
        folder_id: row.get("folder_id")?,
        tags,
        body,
        body_format: row.get("body_format")?,
        status: row.get("status")?,
        favorite: int_to_bool(row.get("favorite")?),
        pinned: int_to_bool(row.get("pinned")?),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
        encrypted,
        locked,
        encrypted_tags_json: raw_tags_out,
    })
}

fn map_block(row: &Row<'_>, crypto: ContentCrypto<'_>) -> rusqlite::Result<NoteBlock> {
    let id: String = row.get("id")?;
    let raw_payload: String = row.get("payload_json")?;
    let encrypted = int_to_bool(row.get("encrypted")?);
    let encrypted_payload_json: Option<String> = row.get("encrypted_payload_json")?;

    let (payload, locked, raw_payload_out) = if !encrypted {
        (
            from_json(&raw_payload).map_err(conversion_error)?,
            false,
            None,
        )
    } else if let Some(cipher) = crypto.cipher() {
        let cipher_text = encrypted_payload_json
            .clone()
            .ok_or_else(|| conversion_error("加密笔记块缺少 payload 密文"))?;
        let payload_json =
            super::note_encryption::decrypt_block_payload(cipher, &id, &cipher_text)
                .map_err(conversion_error)?;
        (
            from_json(&payload_json).map_err(conversion_error)?,
            false,
            None,
        )
    } else if crypto.is_raw() {
        (
            serde_json::json!({}),
            true,
            encrypted_payload_json,
        )
    } else {
        (serde_json::json!({}), true, None)
    };

    Ok(NoteBlock {
        id,
        note_id: row.get("note_id")?,
        block_type: row.get("block_type")?,
        order_key: row.get("order_key")?,
        payload,
        schema_version: row.get("schema_version")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
        encrypted,
        locked,
        encrypted_payload_json: raw_payload_out,
    })
}

fn validate_status(status: &str) -> Result<(), RepoError> {
    if matches!(status, "active" | "trashed") {
        Ok(())
    } else {
        Err(RepoError::invalid(format!("笔记状态无效：{status}")))
    }
}

fn validate_body_format(format: &str) -> Result<(), RepoError> {
    if matches!(format, "html" | "blocks") {
        Ok(())
    } else {
        Err(RepoError::invalid(format!("正文格式无效：{format}")))
    }
}

pub fn list(conn: &Connection, query: &NoteQuery) -> Result<Vec<Note>, RepoError> {
    list_with(conn, query, ContentCrypto::Plain)
}

/// 搜索在 Rust 侧对解密后的标题/正文/标签执行：SQL 无法 LIKE 密文，
/// 锁定笔记不参与内容搜索（其字段为空），避免出现“搜到了但打不开”的假命中。
pub fn list_with(
    conn: &Connection,
    query: &NoteQuery,
    crypto: ContentCrypto<'_>,
) -> Result<Vec<Note>, RepoError> {
    let sql = format!(
        "SELECT {COLUMNS} FROM notes
         WHERE (?1 = 1 OR deleted_at IS NULL)
           AND (?2 IS NULL OR folder_id = ?2)
           AND (?3 IS NULL OR status = ?3)
           AND (?4 IS NULL OR favorite = ?4)
         ORDER BY pinned DESC, updated_at DESC, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            bool_to_int(query.include_deleted.unwrap_or(false)),
            query.folder_id,
            query.status,
            query.favorite.map(bool_to_int),
        ],
        |row| map_note(row, crypto),
    )?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(row?);
    }
    if let Some(needle) = query
        .search
        .as_ref()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
    {
        notes.retain(|note| {
            !note.locked
                && (note.title.to_lowercase().contains(&needle)
                    || note.body.to_lowercase().contains(&needle)
                    || note
                        .tags
                        .iter()
                        .any(|tag| tag.to_lowercase().contains(&needle)))
        });
    }
    Ok(notes)
}

pub fn get(conn: &Connection, id: &str) -> Result<Note, RepoError> {
    get_with(conn, id, ContentCrypto::Plain)
}

pub fn get_with(
    conn: &Connection,
    id: &str,
    crypto: ContentCrypto<'_>,
) -> Result<Note, RepoError> {
    let sql = format!("SELECT {COLUMNS} FROM notes WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], |row| map_note(row, crypto))
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("笔记", id),
            other => RepoError::Sqlite(other),
        })
}

pub fn create(conn: &Connection, input: NewNote) -> Result<Note, RepoError> {
    create_with(conn, input, ContentCrypto::Plain)
}

pub fn create_with(
    conn: &Connection,
    input: NewNote,
    crypto: ContentCrypto<'_>,
) -> Result<Note, RepoError> {
    let NewNote {
        id,
        space_id,
        title,
        folder_id,
        tags,
        body,
        body_format,
        status,
        favorite,
        pinned,
        encrypted,
        encrypted_tags_json,
    } = input;
    let status = status.unwrap_or_else(|| "active".to_string());
    validate_status(&status)?;
    let body_format = body_format.unwrap_or_else(|| "html".to_string());
    validate_body_format(&body_format)?;

    let id = id.unwrap_or_else(new_id);
    let space_id = space_id.unwrap_or_else(|| DEFAULT_SPACE_ID.to_string());
    let tags = tags.unwrap_or_default();
    let body = body.unwrap_or_default();
    let tags_json = to_json(&tags)?;

    let (title, body, stored_tags_json, encrypted, encrypted_tags_json) = match crypto {
        ContentCrypto::Keyed(cipher) => {
            let (title, body, tag_cipher) =
                super::note_encryption::encrypt_note_fields(cipher, &id, &title, &body, &tags_json)?;
            (title, body, "[]".to_string(), true, Some(tag_cipher))
        }
        ContentCrypto::Raw => {
            if encrypted != Some(true) {
                return Err(RepoError::invalid("原始恢复缺少 encrypted=true"));
            }
            let tag_cipher = encrypted_tags_json
                .ok_or_else(|| RepoError::invalid("原始恢复缺少加密标签密文"))?;
            if !crate::note_crypto::is_ciphertext(&title)
                || !crate::note_crypto::is_ciphertext(&body)
                || !crate::note_crypto::is_ciphertext(&tag_cipher)
            {
                return Err(RepoError::invalid(
                    "备份中的加密笔记不是知行密文格式，已拒绝写入",
                ));
            }
            (title, body, "[]".to_string(), true, Some(tag_cipher))
        }
        ContentCrypto::Plain => {
            if encrypted == Some(true) {
                return Err(RepoError::invalid(
                    "本机未配置笔记加密密钥，不能写入加密笔记",
                ));
            }
            (title, body, tags_json, false, None)
        }
    };

    conn.execute(
        "INSERT INTO notes (
           id, space_id, title, folder_id, tags_json, body, body_format, status,
           favorite, pinned, encrypted, encrypted_tags_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            id,
            space_id,
            title,
            folder_id,
            stored_tags_json,
            body,
            body_format,
            status,
            bool_to_int(favorite.unwrap_or(false)),
            bool_to_int(pinned.unwrap_or(false)),
            bool_to_int(encrypted),
            encrypted_tags_json
        ],
    )?;
    get_with(conn, &id, crypto)
}

/// 文件导入：笔记、正文块、笔记待办在同一个事务内写入。
///
/// 调用方（前端解析器）只负责把文件映射成结构化块；任何块类型、标题或
/// 主键冲突都会让整个事务回滚，不会留下半个笔记。图片/附件二进制不在本
/// 命令范围内，Markdown/HTML 导入只生成占位文本。
pub fn import_note(conn: &Connection, input: ImportNoteInput) -> Result<Note, RepoError> {
    import_note_with(conn, input, ContentCrypto::Plain)
}

pub fn import_note_with(
    conn: &Connection,
    input: ImportNoteInput,
    crypto: ContentCrypto<'_>,
) -> Result<Note, RepoError> {
    let ImportNoteInput {
        mut note,
        blocks,
        todos,
    } = input;
    validate_non_empty(&note.title, "笔记标题")?;
    if note.id.is_none() {
        note.id = Some(new_id());
    }
    let note_id = note.id.clone().expect("note id initialized above");

    let tx = conn.unchecked_transaction()?;
    create_with(&tx, note, crypto)?;

    for block in blocks {
        validate_non_empty(&block.block_type, "块类型")?;
        create_block_with(
            &tx,
            NewNoteBlock {
                id: block.id,
                note_id: note_id.clone(),
                block_type: block.block_type,
                order_key: block.order_key,
                payload: block.payload,
                schema_version: block.schema_version,
                encrypted: None,
                encrypted_payload_json: None,
            },
            crypto,
        )?;
    }

    for todo in todos {
        super::note_todos::create_with(
            &tx,
            super::note_todos::NewNoteTodo {
                id: todo.id,
                space_id: None,
                note_id: note_id.clone(),
                task_id: None,
                title: todo.title,
                done: todo.done,
                due_date: None,
                reminder_enabled: None,
                sort_order: todo.sort_order,
                encrypted: None,
            },
            crypto,
        )?;
    }

    tx.commit()?;
    get_with(conn, &note_id, crypto)
}

pub fn update(conn: &Connection, id: &str, input: NoteUpdate) -> Result<Note, RepoError> {
    update_with(conn, id, input, ContentCrypto::Plain)
}

pub fn update_with(
    conn: &Connection,
    id: &str,
    input: NoteUpdate,
    crypto: ContentCrypto<'_>,
) -> Result<Note, RepoError> {
    validate_body_format(&input.body_format)?;
    let NoteUpdate {
        title,
        folder_id,
        tags,
        body,
        body_format,
        favorite,
        pinned,
        encrypted: requested_encrypted,
        encrypted_tags_json,
    } = input;
    let tags_json = to_json(&tags)?;
    let existing_encrypted: i64 = conn
        .query_row(
            "SELECT encrypted FROM notes WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get(0),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("笔记", id),
            other => RepoError::Sqlite(other),
        })?;

    let (title, body, stored_tags_json, encrypted, encrypted_tags_json) = match crypto {
        ContentCrypto::Keyed(cipher) => {
            let (title, body, tag_cipher) =
                super::note_encryption::encrypt_note_fields(cipher, id, &title, &body, &tags_json)?;
            (title, body, "[]".to_string(), true, Some(tag_cipher))
        }
        ContentCrypto::Raw => {
            if requested_encrypted != Some(true) {
                return Err(RepoError::invalid("原始恢复缺少 encrypted=true"));
            }
            let tag_cipher = encrypted_tags_json
                .ok_or_else(|| RepoError::invalid("原始恢复缺少加密标签密文"))?;
            if !crate::note_crypto::is_ciphertext(&title)
                || !crate::note_crypto::is_ciphertext(&body)
                || !crate::note_crypto::is_ciphertext(&tag_cipher)
            {
                return Err(RepoError::invalid(
                    "备份中的加密笔记不是知行密文格式，已拒绝写入",
                ));
            }
            (title, body, "[]".to_string(), true, Some(tag_cipher))
        }
        ContentCrypto::Plain => {
            if existing_encrypted != 0 {
                return Err(RepoError::invalid(
                    "笔记已加密并锁定；拒绝用明文覆盖密文",
                ));
            }
            if requested_encrypted == Some(true) {
                return Err(RepoError::invalid(
                    "本机未配置笔记加密密钥，不能写入加密笔记",
                ));
            }
            (title, body, tags_json, false, None)
        }
    };

    let changed = conn.execute(
        "UPDATE notes SET
           title = ?1,
           folder_id = ?2,
           tags_json = ?3,
           body = ?4,
           body_format = ?5,
           favorite = ?6,
           pinned = ?7,
           encrypted = ?8,
           encrypted_tags_json = ?9,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?10 AND deleted_at IS NULL",
        params![
            title,
            folder_id,
            stored_tags_json,
            body,
            body_format,
            bool_to_int(favorite),
            bool_to_int(pinned),
            bool_to_int(encrypted),
            encrypted_tags_json,
            id
        ],
    )?;
    ensure_changed(changed, "笔记", id)?;
    get_with(conn, id, crypto)
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), RepoError> {
    let changed = conn.execute(
        "UPDATE notes SET
           status = 'trashed',
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "笔记", id)
}

pub fn restore(conn: &Connection, id: &str) -> Result<Note, RepoError> {
    restore_with(conn, id, ContentCrypto::Plain)
}

pub fn restore_with(
    conn: &Connection,
    id: &str,
    crypto: ContentCrypto<'_>,
) -> Result<Note, RepoError> {
    let changed = conn.execute(
        "UPDATE notes SET
           status = 'active',
           deleted_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NOT NULL",
        params![id],
    )?;
    ensure_changed(changed, "笔记", id)?;
    get_with(conn, id, crypto)
}

// ---------------------------------------------------------------------------
// 块投影
// ---------------------------------------------------------------------------

pub fn list_blocks(
    conn: &Connection,
    note_id: &str,
    include_deleted: bool,
) -> Result<Vec<NoteBlock>, RepoError> {
    list_blocks_with(conn, note_id, include_deleted, ContentCrypto::Plain)
}

pub fn list_blocks_with(
    conn: &Connection,
    note_id: &str,
    include_deleted: bool,
    crypto: ContentCrypto<'_>,
) -> Result<Vec<NoteBlock>, RepoError> {
    let sql = format!(
        "SELECT {BLOCK_COLUMNS} FROM note_blocks
         WHERE note_id = ?1 AND (?2 = 1 OR deleted_at IS NULL)
         ORDER BY order_key, created_at, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(params![note_id, bool_to_int(include_deleted)], |row| {
        map_block(row, crypto)
    })?;
    let mut blocks = Vec::new();
    for row in rows {
        blocks.push(row?);
    }
    Ok(blocks)
}

/// 备份导出：所有块（含回收站），加密块返回密文旁路列。
pub fn list_all_blocks_raw(conn: &Connection) -> Result<Vec<NoteBlock>, RepoError> {
    let sql = format!(
        "SELECT {BLOCK_COLUMNS} FROM note_blocks ORDER BY note_id, order_key, created_at, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map([], |row| map_block(row, ContentCrypto::Raw))?;
    let mut blocks = Vec::new();
    for row in rows {
        blocks.push(row?);
    }
    Ok(blocks)
}

pub fn get_block(conn: &Connection, id: &str) -> Result<NoteBlock, RepoError> {    get_block_with(conn, id, ContentCrypto::Plain)
}

pub fn get_block_with(
    conn: &Connection,
    id: &str,
    crypto: ContentCrypto<'_>,
) -> Result<NoteBlock, RepoError> {
    let sql =
        format!("SELECT {BLOCK_COLUMNS} FROM note_blocks WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], |row| map_block(row, crypto))
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("笔记块", id),
            other => RepoError::Sqlite(other),
        })
}

pub fn create_block(conn: &Connection, input: NewNoteBlock) -> Result<NoteBlock, RepoError> {
    create_block_with(conn, input, ContentCrypto::Plain)
}

pub fn create_block_with(
    conn: &Connection,
    input: NewNoteBlock,
    crypto: ContentCrypto<'_>,
) -> Result<NoteBlock, RepoError> {
    validate_non_empty(&input.block_type, "块类型")?;
    // 显式拒绝孤儿块，并确认加密笔记在锁定时不被写入。
    let note = get_with(conn, &input.note_id, crypto)?;
    if note.encrypted && note.locked {
        return Err(RepoError::invalid(
            "笔记已加密并锁定；拒绝写入块内容",
        ));
    }
    let id = input.id.unwrap_or_else(new_id);
    let payload_json =
        to_json(&input.payload.unwrap_or(Value::Object(Default::default())))?;

    let (stored_payload, encrypted, encrypted_payload_json) = match crypto {
        ContentCrypto::Keyed(cipher) => {
            let cipher_text = super::note_encryption::encrypt_block_payload(cipher, &id, &payload_json)?;
            ("{}".to_string(), true, Some(cipher_text))
        }
        ContentCrypto::Raw => {
            if input.encrypted != Some(true) {
                return Err(RepoError::invalid("原始恢复缺少 encrypted=true"));
            }
            let cipher_text = input
                .encrypted_payload_json
                .ok_or_else(|| RepoError::invalid("原始恢复缺少 payload 密文"))?;
            if !crate::note_crypto::is_ciphertext(&cipher_text) {
                return Err(RepoError::invalid(
                    "备份中的加密块不是知行密文格式，已拒绝写入",
                ));
            }
            ("{}".to_string(), true, Some(cipher_text))
        }
        ContentCrypto::Plain => {
            if note.encrypted {
                return Err(RepoError::invalid(
                    "笔记已加密；拒绝写入明文块",
                ));
            }
            (payload_json, false, None)
        }
    };

    conn.execute(
        "INSERT INTO note_blocks (
           id, note_id, block_type, order_key, payload_json, schema_version,
           encrypted, encrypted_payload_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            input.note_id,
            input.block_type,
            input.order_key.unwrap_or(0.0),
            stored_payload,
            input.schema_version.unwrap_or(1),
            bool_to_int(encrypted),
            encrypted_payload_json
        ],
    )?;
    get_block_with(conn, &id, crypto)
}

pub fn update_block(
    conn: &Connection,
    id: &str,
    input: NoteBlockUpdate,
) -> Result<NoteBlock, RepoError> {
    update_block_with(conn, id, input, ContentCrypto::Plain)
}

pub fn update_block_with(
    conn: &Connection,
    id: &str,
    input: NoteBlockUpdate,
    crypto: ContentCrypto<'_>,
) -> Result<NoteBlock, RepoError> {
    validate_non_empty(&input.block_type, "块类型")?;
    let existing_encrypted: i64 = conn
        .query_row(
            "SELECT encrypted FROM note_blocks WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get(0),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("笔记块", id),
            other => RepoError::Sqlite(other),
        })?;
    let payload_json = to_json(&input.payload)?;

    let (stored_payload, encrypted, encrypted_payload_json) = match crypto {
        ContentCrypto::Keyed(cipher) => {
            let cipher_text = super::note_encryption::encrypt_block_payload(cipher, id, &payload_json)?;
            ("{}".to_string(), true, Some(cipher_text))
        }
        ContentCrypto::Raw => {
            if input.encrypted != Some(true) {
                return Err(RepoError::invalid("原始恢复缺少 encrypted=true"));
            }
            let cipher_text = input
                .encrypted_payload_json
                .ok_or_else(|| RepoError::invalid("原始恢复缺少 payload 密文"))?;
            if !crate::note_crypto::is_ciphertext(&cipher_text) {
                return Err(RepoError::invalid(
                    "备份中的加密块不是知行密文格式，已拒绝写入",
                ));
            }
            ("{}".to_string(), true, Some(cipher_text))
        }
        ContentCrypto::Plain => {
            if existing_encrypted != 0 {
                return Err(RepoError::invalid(
                    "笔记块已加密并锁定；拒绝用明文覆盖密文",
                ));
            }
            (payload_json, false, None)
        }
    };

    let changed = conn.execute(
        "UPDATE note_blocks SET
           block_type = ?1,
           order_key = ?2,
           payload_json = ?3,
           schema_version = ?4,
           encrypted = ?5,
           encrypted_payload_json = ?6,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?7 AND deleted_at IS NULL",
        params![
            input.block_type,
            input.order_key,
            stored_payload,
            input.schema_version.unwrap_or(1),
            bool_to_int(encrypted),
            encrypted_payload_json,
            id
        ],
    )?;
    ensure_changed(changed, "笔记块", id)?;
    get_block_with(conn, id, crypto)
}

pub fn delete_block(conn: &Connection, id: &str) -> Result<(), RepoError> {
    let changed = conn.execute(
        "UPDATE note_blocks SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "笔记块", id)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

/// 命令层的加密选择。`OwnedCrypto` 持有解锁密钥，保证 `ContentCrypto`
/// 的借用不会悬垂；锁定时读取落回 `Plain`（返回空内容 + locked）。
enum OwnedCrypto {
    Plain,
    Keyed(NoteCipher),
    Raw,
}

impl OwnedCrypto {
    fn as_content(&self) -> ContentCrypto<'_> {
        match self {
            Self::Plain => ContentCrypto::Plain,
            Self::Keyed(cipher) => ContentCrypto::Keyed(cipher),
            Self::Raw => ContentCrypto::Raw,
        }
    }
}

fn read_crypto(encryption: &NoteEncryptionState, conn: &Connection) -> OwnedCrypto {
    if encryption.status_with_conn(conn).enabled {
        encryption
            .cipher_if_unlocked()
            .map(OwnedCrypto::Keyed)
            .unwrap_or(OwnedCrypto::Plain)
    } else {
        OwnedCrypto::Plain
    }
}

fn write_crypto(
    encryption: &NoteEncryptionState,
    conn: &Connection,
    raw: bool,
) -> Result<OwnedCrypto, String> {
    if raw {
        if encryption.has_envelope() {
            return Ok(OwnedCrypto::Raw);
        }
        return Err(
            "备份包含加密笔记，但本机未配置笔记加密密钥；请先导入密钥信封".to_string(),
        );
    }
    if encryption.status_with_conn(conn).enabled {
        Ok(OwnedCrypto::Keyed(encryption.cipher()?))
    } else {
        Ok(OwnedCrypto::Plain)
    }
}

#[tauri::command]
pub fn notes_list(
    state: State<'_, DbState>,
    encryption: State<'_, NoteEncryptionState>,
    query: Option<NoteQuery>,
) -> Result<Vec<Note>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    let crypto = read_crypto(&encryption, &connection);
    list_with(&connection, &query.unwrap_or_default(), crypto.as_content())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn notes_get(
    state: State<'_, DbState>,
    encryption: State<'_, NoteEncryptionState>,
    id: String,
) -> Result<Note, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    let crypto = read_crypto(&encryption, &connection);
    get_with(&connection, &id, crypto.as_content()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn notes_create(
    state: State<'_, DbState>,
    encryption: State<'_, NoteEncryptionState>,
    input: NewNote,
) -> Result<Note, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    let raw = input.encrypted == Some(true);
    let crypto = write_crypto(&encryption, &connection, raw)?;
    create_with(&connection, input, crypto.as_content()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn notes_import(
    state: State<'_, DbState>,
    encryption: State<'_, NoteEncryptionState>,
    input: ImportNoteInput,
) -> Result<Note, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    let crypto = write_crypto(&encryption, &connection, false)?;
    import_note_with(&connection, input, crypto.as_content())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn notes_update(
    state: State<'_, DbState>,
    encryption: State<'_, NoteEncryptionState>,
    id: String,
    input: NoteUpdate,
) -> Result<Note, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    let raw = input.encrypted == Some(true);
    let crypto = write_crypto(&encryption, &connection, raw)?;
    update_with(&connection, &id, input, crypto.as_content())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn notes_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn notes_restore(
    state: State<'_, DbState>,
    encryption: State<'_, NoteEncryptionState>,
    id: String,
) -> Result<Note, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    let crypto = read_crypto(&encryption, &connection);
    restore_with(&connection, &id, crypto.as_content()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn note_blocks_list(
    state: State<'_, DbState>,
    encryption: State<'_, NoteEncryptionState>,
    note_id: String,
    include_deleted: Option<bool>,
) -> Result<Vec<NoteBlock>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    let crypto = read_crypto(&encryption, &connection);
    list_blocks_with(
        &connection,
        &note_id,
        include_deleted.unwrap_or(false),
        crypto.as_content(),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn note_blocks_create(
    state: State<'_, DbState>,
    encryption: State<'_, NoteEncryptionState>,
    input: NewNoteBlock,
) -> Result<NoteBlock, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    let raw = input.encrypted == Some(true);
    let crypto = write_crypto(&encryption, &connection, raw)?;
    create_block_with(&connection, input, crypto.as_content())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn note_blocks_update(
    state: State<'_, DbState>,
    encryption: State<'_, NoteEncryptionState>,
    id: String,
    input: NoteBlockUpdate,
) -> Result<NoteBlock, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    let raw = input.encrypted == Some(true);
    let crypto = write_crypto(&encryption, &connection, raw)?;
    update_block_with(&connection, &id, input, crypto.as_content())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn note_blocks_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete_block(&connection, &id).map_err(|error| error.to_string())
}

/// 完整备份专用：原样导出所有笔记（含密文与回收站），不接触明文密钥。
#[tauri::command]
pub fn notes_export_rows(
    state: State<'_, DbState>,
) -> Result<Vec<Note>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list_with(
        &connection,
        &NoteQuery {
            include_deleted: Some(true),
            ..NoteQuery::default()
        },
        ContentCrypto::Raw,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn note_blocks_export_rows(
    state: State<'_, DbState>,
) -> Result<Vec<NoteBlock>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list_all_blocks_raw(&connection).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::test_support;

    fn new_note(id: &str, title: &str) -> NewNote {
        NewNote {
            id: Some(id.to_string()),
            space_id: None,
            title: title.to_string(),
            folder_id: Some("f1".to_string()),
            tags: Some(vec!["产品".to_string(), "测试".to_string()]),
            body: Some("<p>正文</p>".to_string()),
            body_format: None,
            status: None,
            favorite: None,
            pinned: None,
            encrypted: None,
            encrypted_tags_json: None,
        }
    }

    #[test]
    fn crud_soft_delete_restore_and_tags() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let created = create(&connection, new_note("note-a", "测试笔记")).expect("create");
        assert_eq!(created.tags, vec!["产品", "测试"]);
        assert_eq!(created.status, "active");
        assert_eq!(created.version, 1);

        let updated = update(
            &connection,
            "note-a",
            NoteUpdate {
                title: "测试笔记 2".to_string(),
                folder_id: Some("f2".to_string()),
                tags: vec!["复盘".to_string()],
                body: "<h2>新正文</h2>".to_string(),
                body_format: "html".to_string(),
                favorite: true,
                pinned: true,
                encrypted: None,
                encrypted_tags_json: None,
            },
        )
        .expect("update");
        assert_eq!(updated.title, "测试笔记 2");
        assert_eq!(updated.tags, vec!["复盘"]);
        assert!(updated.favorite);
        assert_eq!(updated.version, 2);

        delete(&connection, "note-a").expect("delete");
        assert!(matches!(
            get(&connection, "note-a"),
            Err(RepoError::NotFound { .. })
        ));
        let active = list(&connection, &NoteQuery::default()).expect("list");
        assert!(!active.iter().any(|note| note.id == "note-a"));

        let trashed = list(
            &connection,
            &NoteQuery {
                status: Some("trashed".to_string()),
                include_deleted: Some(true),
                ..NoteQuery::default()
            },
        )
        .expect("list trash");
        assert!(trashed.iter().any(|note| note.id == "note-a"));

        let restored = restore(&connection, "note-a").expect("restore");
        assert_eq!(restored.status, "active");
        assert!(restored.deleted_at.is_none());
    }

    #[test]
    fn query_filters_folder_favorite_and_search() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let mut note = new_note("note-search", "可搜索的标题");
        note.favorite = Some(true);
        note.folder_id = Some("f9".to_string());
        create(&connection, note).expect("create");

        let by_folder = list(
            &connection,
            &NoteQuery {
                folder_id: Some("f9".to_string()),
                ..NoteQuery::default()
            },
        )
        .expect("folder query");
        assert_eq!(by_folder.len(), 1);
        assert_eq!(by_folder[0].id, "note-search");

        let by_favorite = list(
            &connection,
            &NoteQuery {
                favorite: Some(true),
                ..NoteQuery::default()
            },
        )
        .expect("favorite query");
        assert!(by_favorite.iter().all(|note| note.favorite));
        assert!(by_favorite.iter().any(|note| note.id == "note-search"));

        let by_search = list(
            &connection,
            &NoteQuery {
                search: Some("可搜索".to_string()),
                ..NoteQuery::default()
            },
        )
        .expect("search query");
        assert_eq!(by_search.len(), 1);
        assert_eq!(by_search[0].id, "note-search");
    }

    #[test]
    fn blocks_crud_and_cascade_on_hard_delete() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let block = create_block(
            &connection,
            NewNoteBlock {
                id: Some("block-a".to_string()),
                note_id: "note-a".to_string(),
                block_type: "heading".to_string(),
                order_key: Some(1.0),
                payload: Some(serde_json::json!({ "level": 2, "text": "标题" })),
                schema_version: None,
                encrypted: None,
                encrypted_payload_json: None,
            },
        )
        .expect_err("orphan note must fail");
        assert!(matches!(block, RepoError::NotFound { .. }));

        create(&connection, new_note("note-a", "测试笔记")).expect("create note");
        let block = create_block(
            &connection,
            NewNoteBlock {
                id: Some("block-a".to_string()),
                note_id: "note-a".to_string(),
                block_type: "heading".to_string(),
                order_key: Some(1.0),
                payload: Some(serde_json::json!({ "level": 2, "text": "标题" })),
                schema_version: None,
                encrypted: None,
                encrypted_payload_json: None,
            },
        )
        .expect("create block");
        assert_eq!(block.payload["text"], "标题");

        let updated = update_block(
            &connection,
            "block-a",
            NoteBlockUpdate {
                block_type: "paragraph".to_string(),
                order_key: 2.0,
                payload: serde_json::json!({ "text": "段落" }),
                schema_version: Some(2),
                encrypted: None,
                encrypted_payload_json: None,
            },
        )
        .expect("update block");
        assert_eq!(updated.block_type, "paragraph");
        assert_eq!(updated.version, 2);

        delete_block(&connection, "block-a").expect("delete block");
        assert!(list_blocks(&connection, "note-a", false)
            .expect("list blocks")
            .is_empty());

        // 模拟硬删除：外键应级联清掉块投影。
        connection
            .execute("DELETE FROM notes WHERE id = 'note-a'", [])
            .expect("hard delete note");
        let remaining: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM note_blocks WHERE note_id = 'note-a'",
                [],
                |row| row.get(0),
            )
            .expect("count blocks");
        assert_eq!(remaining, 0);
    }

    #[test]
    fn orphan_block_is_rejected_by_foreign_key_when_note_is_removed_in_race() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        create(&connection, new_note("note-race", "竞态")).expect("create note");
        create_block(
            &connection,
            NewNoteBlock {
                id: Some("block-race".to_string()),
                note_id: "note-race".to_string(),
                block_type: "paragraph".to_string(),
                order_key: None,
                payload: None,
                schema_version: None,
                encrypted: None,
                encrypted_payload_json: None,
            },
        )
        .expect("create block");
        connection
            .execute("DELETE FROM notes WHERE id = 'note-race'", [])
            .expect("hard delete note");

        let error = connection
            .execute(
                "INSERT INTO note_blocks (id, note_id, block_type)
                 VALUES ('orphan', 'note-race', 'paragraph')",
                [],
            )
            .expect_err("orphan block insert must fail");
        assert!(error.to_string().contains("FOREIGN KEY"));
    }

    #[test]
    fn import_note_writes_note_blocks_and_todos_atomically() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let note = import_note(
            &connection,
            ImportNoteInput {
                note: NewNote {
                    id: Some("note-import".to_string()),
                    space_id: None,
                    title: "导入笔记".to_string(),
                    folder_id: Some("f1".to_string()),
                    tags: None,
                    body: Some("<h1>标题</h1><p>正文</p>".to_string()),
                    body_format: Some("html".to_string()),
                    status: None,
                    favorite: None,
                    pinned: None,
                    encrypted: None,
                    encrypted_tags_json: None,
                },
                blocks: vec![
                    ImportNoteBlock {
                        id: Some("import-block-1".to_string()),
                        block_type: "heading1".to_string(),
                        order_key: Some(1024.0),
                        payload: Some(serde_json::json!({ "runs": [{ "text": "标题" }] })),
                        schema_version: None,
                    },
                    ImportNoteBlock {
                        id: Some("import-block-2".to_string()),
                        block_type: "todo".to_string(),
                        order_key: Some(2048.0),
                        payload: Some(serde_json::json!({
                            "runs": [{ "text": "待办" }],
                            "checked": false,
                            "todoId": "import-todo-1"
                        })),
                        schema_version: None,
                    },
                ],
                todos: vec![ImportNoteTodo {
                    id: Some("import-todo-1".to_string()),
                    title: "待办".to_string(),
                    done: Some(false),
                    sort_order: Some(0.0),
                }],
            },
        )
        .expect("import note");
        assert_eq!(note.id, "note-import");
        assert_eq!(note.title, "导入笔记");
        assert_eq!(list_blocks(&connection, "note-import", false).unwrap().len(), 2);
        assert_eq!(super::super::note_todos::list(&connection, "note-import", false).unwrap().len(), 1);

        // 第二个块用重复主键触发唯一约束；事务必须整体回滚，
        // 不留下 notes / note_blocks / note_todos 中的任何半成品。
        let error = import_note(
            &connection,
            ImportNoteInput {
                note: NewNote {
                    id: Some("note-broken".to_string()),
                    space_id: None,
                    title: "半成品".to_string(),
                    folder_id: None,
                    tags: None,
                    body: Some("<p>不应写库</p>".to_string()),
                    body_format: Some("html".to_string()),
                    status: None,
                    favorite: None,
                    pinned: None,
                    encrypted: None,
                    encrypted_tags_json: None,
                },
                blocks: vec![
                    ImportNoteBlock {
                        id: Some("duplicate-block".to_string()),
                        block_type: "paragraph".to_string(),
                        order_key: Some(1024.0),
                        payload: None,
                        schema_version: None,
                    },
                    ImportNoteBlock {
                        id: Some("duplicate-block".to_string()),
                        block_type: "paragraph".to_string(),
                        order_key: Some(2048.0),
                        payload: None,
                        schema_version: None,
                    },
                ],
                todos: vec![ImportNoteTodo {
                    id: Some("rolled-back-todo".to_string()),
                    title: "不应存在".to_string(),
                    done: None,
                    sort_order: None,
                }],
            },
        )
        .expect_err("duplicate block id must fail");
        assert!(error.to_string().contains("UNIQUE"), "{error}");

        assert!(matches!(
            get(&connection, "note-broken"),
            Err(RepoError::NotFound { .. })
        ));
        assert!(list_blocks(&connection, "note-broken", false)
            .unwrap()
            .is_empty());
        assert!(super::super::note_todos::list(&connection, "note-broken", false)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn encrypted_note_lock_unlock_search_and_raw_export() {
        let (dir, repository) = test_support::repository();
        let mut connection = repository.connection().expect("connection");
        let state = crate::note_encryption::NoteEncryptionState::with_store(
            crate::note_encryption::EnvelopeStore::file_only(dir.path().join("keys")),
        );
        state
            .enable_with_conn(&mut connection, Some("correct horse battery"))
            .expect("enable");
        let cipher = state.cipher().expect("cipher");

        let created = create_with(
            &connection,
            new_note("note-secret", "机密标题"),
            ContentCrypto::Keyed(&cipher),
        )
        .expect("create encrypted note");
        assert!(created.encrypted);
        assert!(!created.locked);
        assert_eq!(created.title, "机密标题");

        let raw_title: String = connection
            .query_row(
                "SELECT title FROM notes WHERE id = 'note-secret'",
                [],
                |row| row.get(0),
            )
            .expect("raw title");
        assert!(crate::note_crypto::is_ciphertext(&raw_title));
        assert!(!raw_title.contains("机密"));

        let locked = get_with(&connection, "note-secret", ContentCrypto::Plain).expect("locked get");
        assert!(locked.encrypted && locked.locked);
        assert_eq!(locked.title, "");
        assert!(locked.body.is_empty());
        assert!(locked.tags.is_empty());

        let locked_search = list_with(
            &connection,
            &NoteQuery {
                search: Some("机密".to_string()),
                ..NoteQuery::default()
            },
            ContentCrypto::Plain,
        )
        .expect("locked search");
        assert!(!locked_search.iter().any(|note| note.id == "note-secret"));

        let unlocked_search = list_with(
            &connection,
            &NoteQuery {
                search: Some("机密".to_string()),
                ..NoteQuery::default()
            },
            ContentCrypto::Keyed(&cipher),
        )
        .expect("unlocked search");
        assert!(unlocked_search.iter().any(|note| note.id == "note-secret"));

        let raw = list_with(
            &connection,
            &NoteQuery {
                include_deleted: Some(true),
                ..NoteQuery::default()
            },
            ContentCrypto::Raw,
        )
        .expect("raw export");
        let raw_note = raw.iter().find(|note| note.id == "note-secret").expect("raw note");
        assert_eq!(raw_note.title, raw_title);
        assert!(raw_note.encrypted_tags_json.is_some());

        let block = create_block_with(
            &connection,
            NewNoteBlock {
                id: Some("block-secret".to_string()),
                note_id: "note-secret".to_string(),
                block_type: "paragraph".to_string(),
                order_key: Some(1.0),
                payload: Some(serde_json::json!({ "text": "机密段落" })),
                schema_version: None,
                encrypted: None,
                encrypted_payload_json: None,
            },
            ContentCrypto::Keyed(&cipher),
        )
        .expect("encrypted block");
        assert!(block.encrypted);
        assert_eq!(block.payload["text"], "机密段落");
        let locked_blocks =
            list_blocks_with(&connection, "note-secret", false, ContentCrypto::Plain)
                .expect("locked blocks");
        assert!(locked_blocks.iter().all(|item| item.locked && item.payload == serde_json::json!({})));
        let raw_blocks = list_all_blocks_raw(&connection).expect("raw blocks");
        let raw_block = raw_blocks
            .iter()
            .find(|item| item.id == "block-secret")
            .expect("raw block");
        assert!(raw_block.encrypted_payload_json.is_some());

        let todo = super::super::note_todos::create_with(
            &connection,
            super::super::note_todos::NewNoteTodo {
                id: Some("todo-secret".to_string()),
                space_id: None,
                note_id: "note-secret".to_string(),
                task_id: None,
                title: "机密待办".to_string(),
                done: None,
                due_date: None,
                reminder_enabled: None,
                sort_order: None,
                encrypted: None,
            },
            ContentCrypto::Keyed(&cipher),
        )
        .expect("encrypted todo");
        assert!(todo.encrypted);
        let locked_todos =
            super::super::note_todos::list_with(&connection, "note-secret", false, ContentCrypto::Plain)
                .expect("locked todos");
        assert!(locked_todos.iter().all(|item| item.locked && item.title.is_empty()));
        let raw_todos = super::super::note_todos::list_all_raw(&connection).expect("raw todos");
        let raw_todo = raw_todos
            .iter()
            .find(|item| item.id == "todo-secret")
            .expect("raw todo");
        assert!(crate::note_crypto::is_ciphertext(&raw_todo.title));

        let error = update_with(
            &connection,
            "note-secret",
            NoteUpdate {
                title: "覆盖尝试".to_string(),
                folder_id: None,
                tags: Vec::new(),
                body: String::new(),
                body_format: "html".to_string(),
                favorite: false,
                pinned: false,
                encrypted: None,
                encrypted_tags_json: None,
            },
            ContentCrypto::Plain,
        )
        .expect_err("locked write must be refused");
        assert!(error.to_string().contains("锁定"), "{error}");

        state.lock(&connection).expect("lock");
        assert!(state.cipher().is_err());
        let wrong = state
            .unlock(&connection, "wrong passphrase")
            .expect_err("wrong passphrase");
        assert!(wrong.contains("口令错误"), "{wrong}");
        state
            .unlock(&connection, "correct horse battery")
            .expect("unlock");
        let cipher = state.cipher().expect("cipher after unlock");
        let recovered =
            get_with(&connection, "note-secret", ContentCrypto::Keyed(&cipher)).expect("recovered");
        assert_eq!(recovered.title, "机密标题");
        assert_eq!(recovered.tags, vec!["产品", "测试"]);
        assert_eq!(recovered.body, "<p>正文</p>");
    }
}
