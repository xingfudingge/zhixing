//! 笔记加密的数据库侧操作：元数据、批量加密/解密、附件边界检查。
//!
//! 纯加解密原语在 `crate::note_crypto`；这里只负责事务与字段映射。
//! 所有更新都在一个事务里完成：任何一篇笔记/块/待办失败都会整体回滚，
//! 不会留下“一半明文、一半密文”的库。

use rusqlite::{params, Connection, Row};
use serde::Serialize;

use super::{bool_to_int, RepoError};
use crate::note_crypto::{block_field_context, note_field_context, todo_field_context, NoteCipher};

/// 与 `0006_note_encryption.sql` 的单行元数据对应。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EncryptionMeta {
    pub enabled: bool,
    pub key_id: Option<String>,
    pub scrub_pending: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncryptionCounts {
    pub total_notes: i64,
    pub encrypted_notes: i64,
    pub plaintext_notes: i64,
    pub note_attachments: i64,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncryptionTransformReport {
    pub notes: i64,
    pub blocks: i64,
    pub todos: i64,
}

fn map_meta(row: &Row<'_>) -> rusqlite::Result<EncryptionMeta> {
    Ok(EncryptionMeta {
        enabled: row.get::<_, i64>("enabled")? != 0,
        key_id: row.get("key_id")?,
        scrub_pending: row.get::<_, i64>("scrub_pending")? != 0,
        updated_at: row.get("updated_at")?,
    })
}

pub fn read_meta(conn: &Connection) -> Result<EncryptionMeta, RepoError> {
    conn.query_row(
        "SELECT enabled, key_id, scrub_pending, updated_at
         FROM note_encryption_meta WHERE id = 1",
        [],
        map_meta,
    )
    .map_err(|error| match error {
        rusqlite::Error::QueryReturnedNoRows => {
            RepoError::Invalid("加密元数据缺失；数据库可能未执行 0006 迁移".to_string())
        }
        other => RepoError::Sqlite(other),
    })
}

pub fn set_meta(
    conn: &Connection,
    enabled: bool,
    key_id: Option<&str>,
) -> Result<EncryptionMeta, RepoError> {
    conn.execute(
        "INSERT INTO note_encryption_meta (id, enabled, key_id, updated_at)
         VALUES (1, ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(id) DO UPDATE SET
           enabled = excluded.enabled,
           key_id = excluded.key_id,
           updated_at = excluded.updated_at",
        params![bool_to_int(enabled), key_id],
    )?;
    read_meta(conn)
}

/// 标记“密文已提交、旧页清理尚未完成”。清理成功后置回 0；
/// 进程在两者之间崩溃时，下次启动/锁定会重试，避免残留永久存在。
pub fn set_scrub_pending(conn: &Connection, pending: bool) -> Result<EncryptionMeta, RepoError> {
    conn.execute(
        "UPDATE note_encryption_meta SET
           scrub_pending = ?1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = 1",
        params![bool_to_int(pending)],
    )?;
    read_meta(conn)
}

pub fn counts(conn: &Connection) -> Result<EncryptionCounts, RepoError> {
    let total_notes = conn.query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))?;
    let encrypted_notes = conn.query_row(
        "SELECT COUNT(*) FROM notes WHERE encrypted = 1",
        [],
        |row| row.get(0),
    )?;
    let note_attachments = conn.query_row(
        "SELECT COUNT(*) FROM attachments
         WHERE note_id IS NOT NULL AND deleted_at IS NULL",
        [],
        |row| row.get(0),
    )?;
    Ok(EncryptionCounts {
        total_notes,
        encrypted_notes,
        plaintext_notes: total_notes - encrypted_notes,
        note_attachments,
    })
}

/// 把一篇笔记的三个内容字段一起加密。`tags_json` 的密文写入旁路列，
/// 原 `tags_json` 由调用方写成合法空数组（满足 json_valid CHECK）。
pub fn encrypt_note_fields(
    cipher: &NoteCipher,
    note_id: &str,
    title: &str,
    body: &str,
    tags_json: &str,
) -> Result<(String, String, String), RepoError> {
    Ok((
        cipher.encrypt_text(&note_field_context(note_id, "title"), title)?,
        cipher.encrypt_text(&note_field_context(note_id, "body"), body)?,
        cipher.encrypt_text(&note_field_context(note_id, "tags"), tags_json)?,
    ))
}

/// 返回 `(title, body, tags_json)` 三个明文；第三个参数是旁路列的密文。
pub fn decrypt_note_fields(
    cipher: &NoteCipher,
    note_id: &str,
    title: &str,
    body: &str,
    encrypted_tags_json: &str,
) -> Result<(String, String, String), RepoError> {
    Ok((
        cipher.decrypt_text(&note_field_context(note_id, "title"), title)?,
        cipher.decrypt_text(&note_field_context(note_id, "body"), body)?,
        cipher.decrypt_text(&note_field_context(note_id, "tags"), encrypted_tags_json)?,
    ))
}

pub fn encrypt_block_payload(
    cipher: &NoteCipher,
    block_id: &str,
    payload_json: &str,
) -> Result<String, RepoError> {
    Ok(cipher.encrypt_text(&block_field_context(block_id, "payload"), payload_json)?)
}

pub fn decrypt_block_payload(
    cipher: &NoteCipher,
    block_id: &str,
    payload_json: &str,
) -> Result<String, RepoError> {
    Ok(cipher.decrypt_text(&block_field_context(block_id, "payload"), payload_json)?)
}

pub fn encrypt_todo_title(
    cipher: &NoteCipher,
    todo_id: &str,
    title: &str,
) -> Result<String, RepoError> {
    Ok(cipher.encrypt_text(&todo_field_context(todo_id, "title"), title)?)
}

pub fn decrypt_todo_title(
    cipher: &NoteCipher,
    todo_id: &str,
    title: &str,
) -> Result<String, RepoError> {
    Ok(cipher.decrypt_text(&todo_field_context(todo_id, "title"), title)?)
}

/// 批量加密尚未加密的笔记内容。调用方负责在事务中执行并写元数据。
/// 已加密的行保持原样，便于中断后重试（幂等）。
pub fn encrypt_all(
    conn: &Connection,
    cipher: &NoteCipher,
) -> Result<EncryptionTransformReport, RepoError> {
    let mut report = EncryptionTransformReport::default();

    let notes = {
        let mut statement =
            conn.prepare("SELECT id, title, body, tags_json FROM notes WHERE encrypted = 0")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>("id")?,
                row.get::<_, String>("title")?,
                row.get::<_, String>("body")?,
                row.get::<_, String>("tags_json")?,
            ))
        })?;
        let mut notes = Vec::new();
        for row in rows {
            notes.push(row?);
        }
        notes
    };

    for (id, title, body, tags_json) in notes {
        let (title, body, encrypted_tags) =
            encrypt_note_fields(cipher, &id, &title, &body, &tags_json)?;
        conn.execute(
            "UPDATE notes SET
               title = ?1, body = ?2, tags_json = '[]',
               encrypted_tags_json = ?3, encrypted = 1,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               version = version + 1
             WHERE id = ?4 AND encrypted = 0",
            params![title, body, encrypted_tags, id],
        )?;
        report.notes += 1;
    }

    let blocks = {
        let mut statement = conn.prepare(
            "SELECT b.id, b.payload_json FROM note_blocks b
             JOIN notes n ON n.id = b.note_id
             WHERE b.encrypted = 0 AND n.encrypted = 1",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>("id")?,
                row.get::<_, String>("payload_json")?,
            ))
        })?;
        let mut blocks = Vec::new();
        for row in rows {
            blocks.push(row?);
        }
        blocks
    };
    for (id, payload_json) in blocks {
        let payload = encrypt_block_payload(cipher, &id, &payload_json)?;
        conn.execute(
            "UPDATE note_blocks SET
               payload_json = '{}', encrypted_payload_json = ?1, encrypted = 1,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               version = version + 1
             WHERE id = ?2 AND encrypted = 0",
            params![payload, id],
        )?;
        report.blocks += 1;
    }

    let todos = {
        let mut statement = conn.prepare(
            "SELECT t.id, t.title FROM note_todos t
             JOIN notes n ON n.id = t.note_id
             WHERE t.encrypted = 0 AND n.encrypted = 1",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>("id")?, row.get::<_, String>("title")?))
        })?;
        let mut todos = Vec::new();
        for row in rows {
            todos.push(row?);
        }
        todos
    };
    for (id, title) in todos {
        let title = encrypt_todo_title(cipher, &id, &title)?;
        conn.execute(
            "UPDATE note_todos SET
               title = ?1, encrypted = 1,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               version = version + 1
             WHERE id = ?2 AND encrypted = 0",
            params![title, id],
        )?;
        report.todos += 1;
    }

    Ok(report)
}

/// 批量解密全部内容。任何一篇失败都返回错误，由调用方回滚事务。
pub fn decrypt_all(
    conn: &Connection,
    cipher: &NoteCipher,
) -> Result<EncryptionTransformReport, RepoError> {
    let mut report = EncryptionTransformReport::default();

    let notes = {
        let mut statement = conn.prepare(
            "SELECT id, title, body, encrypted_tags_json FROM notes WHERE encrypted = 1",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>("id")?,
                row.get::<_, String>("title")?,
                row.get::<_, String>("body")?,
                row.get::<_, Option<String>>("encrypted_tags_json")?,
            ))
        })?;
        let mut notes = Vec::new();
        for row in rows {
            notes.push(row?);
        }
        notes
    };
    for (id, title, body, encrypted_tags_json) in notes {
        let encrypted_tags_json = encrypted_tags_json.ok_or_else(|| {
            RepoError::Encryption(format!("笔记 {id} 标记为已加密，但缺少标签密文"))
        })?;
        let (title, body, tags_json) =
            decrypt_note_fields(cipher, &id, &title, &body, &encrypted_tags_json)?;
        conn.execute(
            "UPDATE notes SET
               title = ?1, body = ?2, tags_json = ?3,
               encrypted_tags_json = NULL, encrypted = 0,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               version = version + 1
             WHERE id = ?4 AND encrypted = 1",
            params![title, body, tags_json, id],
        )?;
        report.notes += 1;
    }

    let blocks = {
        let mut statement =
            conn.prepare("SELECT id, encrypted_payload_json FROM note_blocks WHERE encrypted = 1")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>("id")?,
                row.get::<_, Option<String>>("encrypted_payload_json")?,
            ))
        })?;
        let mut blocks = Vec::new();
        for row in rows {
            blocks.push(row?);
        }
        blocks
    };
    for (id, encrypted_payload) in blocks {
        let encrypted_payload = encrypted_payload.ok_or_else(|| {
            RepoError::Encryption(format!("笔记块 {id} 标记为已加密，但缺少 payload 密文"))
        })?;
        let payload = decrypt_block_payload(cipher, &id, &encrypted_payload)?;
        conn.execute(
            "UPDATE note_blocks SET
               payload_json = ?1, encrypted_payload_json = NULL, encrypted = 0,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               version = version + 1
             WHERE id = ?2 AND encrypted = 1",
            params![payload, id],
        )?;
        report.blocks += 1;
    }

    let todos = {
        let mut statement = conn.prepare("SELECT id, title FROM note_todos WHERE encrypted = 1")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>("id")?, row.get::<_, String>("title")?))
        })?;
        let mut todos = Vec::new();
        for row in rows {
            todos.push(row?);
        }
        todos
    };
    for (id, title) in todos {
        let title = decrypt_todo_title(cipher, &id, &title)?;
        conn.execute(
            "UPDATE note_todos SET
               title = ?1, encrypted = 0,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               version = version + 1
             WHERE id = ?2 AND encrypted = 1",
            params![title, id],
        )?;
        report.todos += 1;
    }

    Ok(report)
}

/// 开启加密前检查：笔记附件二进制在 IndexedDB/同步边车里，不在 SQLite
/// 加密边界内；存在时拒绝开启，避免“笔记加密了、图片仍明文”。
pub fn ensure_note_attachments_absent(conn: &Connection) -> Result<(), RepoError> {
    let counts = counts(conn)?;
    if counts.note_attachments > 0 {
        return Err(RepoError::Invalid(format!(
            "有 {} 个笔记附件未纳入加密边界；请先删除笔记附件再开启加密",
            counts.note_attachments
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::note_crypto::create_envelope;
    use crate::repositories::test_support;

    const LOG_N: u8 = 14;

    #[test]
    fn bulk_encrypt_and_decrypt_round_trip() {
        let (_dir, repository) = test_support::repository();
        let mut connection = repository.connection().expect("connection");
        let (envelope, cipher) = create_envelope("correct horse battery", LOG_N).expect("envelope");

        let tx = connection.transaction().expect("tx");
        let report = encrypt_all(&tx, &cipher).expect("encrypt");
        assert!(report.notes > 0);
        set_meta(&tx, true, Some(&envelope.key_id)).expect("meta");
        tx.commit().expect("commit");

        let encrypted = counts(&connection).expect("counts");
        assert_eq!(encrypted.encrypted_notes, encrypted.total_notes);
        assert_eq!(encrypted.plaintext_notes, 0);

        let raw_title: String = connection
            .query_row(
                "SELECT title FROM notes WHERE id = (
                   SELECT id FROM notes ORDER BY id LIMIT 1
                 )",
                [],
                |row| row.get(0),
            )
            .expect("title");
        assert!(crate::note_crypto::is_ciphertext(&raw_title));
        assert!(!raw_title.contains("知行"));

        let tx = connection.transaction().expect("tx");
        let report = decrypt_all(&tx, &cipher).expect("decrypt");
        assert!(report.notes > 0);
        set_meta(&tx, false, None).expect("meta");
        tx.commit().expect("commit");

        let after = counts(&connection).expect("counts");
        assert_eq!(after.encrypted_notes, 0);
        let raw_title: String = connection
            .query_row(
                "SELECT title FROM notes WHERE id = (
                   SELECT id FROM notes ORDER BY id LIMIT 1
                 )",
                [],
                |row| row.get(0),
            )
            .expect("title");
        assert!(!crate::note_crypto::is_ciphertext(&raw_title));
    }

    #[test]
    fn wrong_key_rolls_back_without_partial_plaintext() {
        let (_dir, repository) = test_support::repository();
        let mut connection = repository.connection().expect("connection");
        let (envelope, cipher) = create_envelope("correct horse battery", LOG_N).expect("envelope");
        let tx = connection.transaction().expect("tx");
        encrypt_all(&tx, &cipher).expect("encrypt");
        set_meta(&tx, true, Some(&envelope.key_id)).expect("meta");
        tx.commit().expect("commit");

        let (_other_envelope, other_cipher) =
            create_envelope("another correct horse", LOG_N).expect("other");
        let tx = connection.transaction().expect("tx");
        let error = decrypt_all(&tx, &other_cipher).expect_err("wrong key must fail");
        assert!(matches!(error, RepoError::Encryption(_)));
        tx.rollback().expect("rollback");

        let counts = counts(&connection).expect("counts");
        assert_eq!(counts.encrypted_notes, counts.total_notes);
    }
}
