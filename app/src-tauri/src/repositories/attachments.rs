//! 附件元数据仓储。二进制按 sha256 内容寻址存放，数据库只存元数据。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{bool_to_int, ensure_changed, new_id, validate_non_empty, RepoError, DEFAULT_SPACE_ID};
use crate::db::DbState;

const COLUMNS: &str = "id, space_id, note_id, block_id, file_name, sha256, byte_size, mime, \
                       storage_key, created_at, updated_at, deleted_at, version";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub space_id: String,
    pub note_id: Option<String>,
    pub block_id: Option<String>,
    pub file_name: String,
    pub sha256: String,
    pub byte_size: i64,
    pub mime: String,
    pub storage_key: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAttachment {
    pub id: Option<String>,
    pub space_id: Option<String>,
    pub note_id: Option<String>,
    pub block_id: Option<String>,
    pub file_name: String,
    pub sha256: String,
    pub byte_size: i64,
    pub mime: Option<String>,
    pub storage_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUpdate {
    pub note_id: Option<String>,
    pub block_id: Option<String>,
    pub file_name: String,
    pub mime: String,
    pub storage_key: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentQuery {
    pub note_id: Option<String>,
    pub include_deleted: Option<bool>,
}

fn map_attachment(row: &Row<'_>) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: row.get("id")?,
        space_id: row.get("space_id")?,
        note_id: row.get("note_id")?,
        block_id: row.get("block_id")?,
        file_name: row.get("file_name")?,
        sha256: row.get("sha256")?,
        byte_size: row.get("byte_size")?,
        mime: row.get("mime")?,
        storage_key: row.get("storage_key")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
    })
}

fn validate_sha256(value: &str) -> Result<(), RepoError> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(RepoError::invalid("sha256 必须是 64 位十六进制字符串"))
    }
}

pub fn list(conn: &Connection, query: &AttachmentQuery) -> Result<Vec<Attachment>, RepoError> {
    let sql = format!(
        "SELECT {COLUMNS} FROM attachments
         WHERE (?1 = 1 OR deleted_at IS NULL)
           AND (?2 IS NULL OR note_id = ?2)
         ORDER BY created_at, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            bool_to_int(query.include_deleted.unwrap_or(false)),
            query.note_id
        ],
        map_attachment,
    )?;
    let mut attachments = Vec::new();
    for row in rows {
        attachments.push(row?);
    }
    Ok(attachments)
}

pub fn get(conn: &Connection, id: &str) -> Result<Attachment, RepoError> {
    let sql = format!("SELECT {COLUMNS} FROM attachments WHERE id = ?1 AND deleted_at IS NULL");
    conn.query_row(&sql, params![id], map_attachment)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepoError::not_found("附件", id),
            other => RepoError::Sqlite(other),
        })
}

pub fn create(conn: &Connection, input: NewAttachment) -> Result<Attachment, RepoError> {
    validate_non_empty(&input.file_name, "附件文件名")?;
    validate_non_empty(&input.storage_key, "附件存储键")?;
    validate_sha256(&input.sha256)?;
    if input.byte_size < 0 {
        return Err(RepoError::invalid("附件大小不能为负"));
    }
    let id = input.id.unwrap_or_else(new_id);
    let space_id = input
        .space_id
        .unwrap_or_else(|| DEFAULT_SPACE_ID.to_string());

    conn.execute(
        "INSERT INTO attachments (
           id, space_id, note_id, block_id, file_name, sha256, byte_size, mime, storage_key
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            space_id,
            input.note_id,
            input.block_id,
            input.file_name,
            input.sha256.to_ascii_lowercase(),
            input.byte_size,
            input
                .mime
                .unwrap_or_else(|| "application/octet-stream".to_string()),
            input.storage_key
        ],
    )?;
    get(conn, &id)
}

pub fn update(
    conn: &Connection,
    id: &str,
    input: AttachmentUpdate,
) -> Result<Attachment, RepoError> {
    validate_non_empty(&input.file_name, "附件文件名")?;
    validate_non_empty(&input.storage_key, "附件存储键")?;
    let changed = conn.execute(
        "UPDATE attachments SET
           note_id = ?1,
           block_id = ?2,
           file_name = ?3,
           mime = ?4,
           storage_key = ?5,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?6 AND deleted_at IS NULL",
        params![
            input.note_id,
            input.block_id,
            input.file_name,
            input.mime,
            input.storage_key,
            id
        ],
    )?;
    ensure_changed(changed, "附件", id)?;
    get(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), RepoError> {
    let changed = conn.execute(
        "UPDATE attachments SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "附件", id)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn attachments_list(
    state: State<'_, DbState>,
    query: Option<AttachmentQuery>,
) -> Result<Vec<Attachment>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list(&connection, &query.unwrap_or_default()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn attachments_get(state: State<'_, DbState>, id: String) -> Result<Attachment, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    get(&connection, &id).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn attachments_create(
    state: State<'_, DbState>,
    input: NewAttachment,
) -> Result<Attachment, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    create(&connection, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn attachments_update(
    state: State<'_, DbState>,
    id: String,
    input: AttachmentUpdate,
) -> Result<Attachment, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    update(&connection, &id, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn attachments_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete(&connection, &id).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::test_support;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn metadata_crud_and_soft_delete() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let attachment = create(
            &connection,
            NewAttachment {
                id: Some("attachment-a".to_string()),
                space_id: None,
                note_id: Some(super::super::seed::WELCOME_NOTE_ID.to_string()),
                block_id: Some("seed-block-welcome-p".to_string()),
                file_name: "产品方案.docx".to_string(),
                sha256: SHA.to_string(),
                byte_size: 1024,
                mime: Some(
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        .to_string(),
                ),
                storage_key: "sha256/aa".to_string(),
            },
        )
        .expect("create attachment");
        assert_eq!(attachment.byte_size, 1024);

        let listed = list(
            &connection,
            &AttachmentQuery {
                note_id: Some(super::super::seed::WELCOME_NOTE_ID.to_string()),
                ..AttachmentQuery::default()
            },
        )
        .expect("list attachments");
        assert!(listed.iter().any(|item| item.id == "attachment-a"));

        let updated = update(
            &connection,
            "attachment-a",
            AttachmentUpdate {
                note_id: Some(super::super::seed::WORKFLOW_NOTE_ID.to_string()),
                block_id: None,
                file_name: "产品方案-终版.docx".to_string(),
                mime: "application/octet-stream".to_string(),
                storage_key: "sha256/aa".to_string(),
            },
        )
        .expect("update attachment");
        assert_eq!(updated.file_name, "产品方案-终版.docx");
        assert_eq!(updated.version, 2);

        delete(&connection, "attachment-a").expect("delete");
        assert!(matches!(
            get(&connection, "attachment-a"),
            Err(RepoError::NotFound { .. })
        ));
    }

    #[test]
    fn duplicate_sha_orphan_note_and_bad_sha_are_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let mut first = NewAttachment {
            id: Some("attachment-1".to_string()),
            space_id: None,
            note_id: None,
            block_id: None,
            file_name: "a.txt".to_string(),
            sha256: SHA.to_string(),
            byte_size: 1,
            mime: None,
            storage_key: "sha256/aa".to_string(),
        };
        create(&connection, first.clone()).expect("create first");

        // 内容寻址：同一 sha256 只允许一行。
        first.id = Some("attachment-2".to_string());
        assert!(create(&connection, first).is_err());

        let orphan = NewAttachment {
            id: Some("attachment-orphan".to_string()),
            space_id: None,
            note_id: Some("no-such-note".to_string()),
            block_id: None,
            file_name: "b.txt".to_string(),
            sha256: "b".repeat(64),
            byte_size: 1,
            mime: None,
            storage_key: "sha256/bb".to_string(),
        };
        let error = create(&connection, orphan).expect_err("orphan note must fail");
        assert!(error.to_string().contains("FOREIGN KEY"));

        let bad_sha = NewAttachment {
            id: Some("attachment-bad".to_string()),
            space_id: None,
            note_id: None,
            block_id: None,
            file_name: "c.txt".to_string(),
            sha256: "not-a-hash".to_string(),
            byte_size: 1,
            mime: None,
            storage_key: "sha256/cc".to_string(),
        };
        assert!(matches!(
            create(&connection, bad_sha),
            Err(RepoError::Invalid(_))
        ));
    }
}
