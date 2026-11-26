//! 设置仓储。`scope=device` 是本机偏好，`scope=space` 可随空间同步。
//! 只存键值，不存任何授权 / 账号信息。

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use super::{
    bool_to_int, ensure_changed, from_json, new_id, to_json, validate_non_empty, RepoError,
    DEFAULT_SPACE_ID,
};
use crate::db::DbState;

const COLUMNS: &str = "id, space_id, scope, setting_key, value_json, created_at, updated_at, \
                       deleted_at, version";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub id: String,
    pub space_id: String,
    pub scope: String,
    pub key: String,
    pub value: Value,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSetting {
    pub id: Option<String>,
    pub space_id: Option<String>,
    pub scope: Option<String>,
    pub key: String,
    pub value: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingQuery {
    pub scope: Option<String>,
    pub include_deleted: Option<bool>,
}

fn map_setting(row: &Row<'_>) -> rusqlite::Result<Setting> {
    let raw: String = row.get("value_json")?;
    let value = from_json(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                error.to_string(),
            )),
        )
    })?;
    Ok(Setting {
        id: row.get("id")?,
        space_id: row.get("space_id")?,
        scope: row.get("scope")?,
        key: row.get("setting_key")?,
        value,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        deleted_at: row.get("deleted_at")?,
        version: row.get("version")?,
    })
}

fn validate_scope(scope: &str) -> Result<(), RepoError> {
    if matches!(scope, "device" | "space") {
        Ok(())
    } else {
        Err(RepoError::invalid(format!("设置作用域无效：{scope}")))
    }
}

pub fn list(conn: &Connection, query: &SettingQuery) -> Result<Vec<Setting>, RepoError> {
    if let Some(scope) = query.scope.as_deref() {
        validate_scope(scope)?;
    }
    let sql = format!(
        "SELECT {COLUMNS} FROM settings
         WHERE (?1 = 1 OR deleted_at IS NULL)
           AND (?2 IS NULL OR scope = ?2)
         ORDER BY scope, setting_key, id"
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            bool_to_int(query.include_deleted.unwrap_or(false)),
            query.scope
        ],
        map_setting,
    )?;
    let mut settings = Vec::new();
    for row in rows {
        settings.push(row?);
    }
    Ok(settings)
}

pub fn get(conn: &Connection, scope: &str, key: &str) -> Result<Setting, RepoError> {
    validate_scope(scope)?;
    let sql = format!(
        "SELECT {COLUMNS} FROM settings
         WHERE space_id = ?1 AND scope = ?2 AND setting_key = ?3 AND deleted_at IS NULL"
    );
    conn.query_row(&sql, params![DEFAULT_SPACE_ID, scope, key], map_setting)
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => {
                RepoError::not_found("设置", format!("{scope}:{key}"))
            }
            other => RepoError::Sqlite(other),
        })
}

/// 按键 upsert。同 key 更新会复用原 id，版本号递增。
pub fn set(conn: &Connection, input: NewSetting) -> Result<Setting, RepoError> {
    validate_non_empty(&input.key, "设置键")?;
    let scope = input.scope.unwrap_or_else(|| "space".to_string());
    validate_scope(&scope)?;
    let space_id = input
        .space_id
        .unwrap_or_else(|| DEFAULT_SPACE_ID.to_string());
    let value = to_json(&input.value)?;
    let id = input.id.unwrap_or_else(new_id);

    conn.execute(
        "INSERT INTO settings (id, space_id, scope, setting_key, value_json)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(space_id, scope, setting_key) DO UPDATE SET
           value_json = excluded.value_json,
           deleted_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = settings.version + 1",
        params![id, space_id, scope, input.key, value],
    )?;
    get(conn, &scope, &input.key)
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), RepoError> {
    let changed = conn.execute(
        "UPDATE settings SET
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           version = version + 1
         WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
    )?;
    ensure_changed(changed, "设置", id)
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn settings_list(
    state: State<'_, DbState>,
    query: Option<SettingQuery>,
) -> Result<Vec<Setting>, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    list(&connection, &query.unwrap_or_default()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn settings_get(
    state: State<'_, DbState>,
    scope: String,
    key: String,
) -> Result<Setting, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    get(&connection, &scope, &key).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn settings_set(state: State<'_, DbState>, input: NewSetting) -> Result<Setting, String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    set(&connection, input).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn settings_delete(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let connection = state.connection().map_err(|error| error.to_string())?;
    delete(&connection, &id).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::test_support;

    #[test]
    fn set_get_update_and_soft_delete() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let created = set(
            &connection,
            NewSetting {
                id: Some("setting-a".to_string()),
                space_id: None,
                scope: Some("device".to_string()),
                key: "appearance.density".to_string(),
                value: serde_json::json!("comfortable"),
            },
        )
        .expect("set");
        assert_eq!(created.value, serde_json::json!("comfortable"));
        assert_eq!(created.scope, "device");
        assert_eq!(created.version, 1);

        let updated = set(
            &connection,
            NewSetting {
                id: Some("ignored-id".to_string()),
                space_id: None,
                scope: Some("device".to_string()),
                key: "appearance.density".to_string(),
                value: serde_json::json!("compact"),
            },
        )
        .expect("upsert");
        assert_eq!(updated.id, created.id, "upsert keeps the original id");
        assert_eq!(updated.value, serde_json::json!("compact"));
        assert_eq!(updated.version, 2);

        let fetched = get(&connection, "device", "appearance.density").expect("get");
        assert_eq!(fetched.value, serde_json::json!("compact"));

        delete(&connection, &created.id).expect("delete");
        assert!(matches!(
            get(&connection, "device", "appearance.density"),
            Err(RepoError::NotFound { .. })
        ));
        let active = list(&connection, &SettingQuery::default()).expect("list");
        assert!(!active.iter().any(|item| item.id == created.id));

        // 删除后再次 set 会复活同一键。
        let revived = set(
            &connection,
            NewSetting {
                id: None,
                space_id: None,
                scope: Some("device".to_string()),
                key: "appearance.density".to_string(),
                value: serde_json::json!("comfortable"),
            },
        )
        .expect("revive");
        assert!(revived.deleted_at.is_none());
        assert_eq!(revived.id, created.id);
        // create v1 -> upsert v2 -> delete v3 -> revive v4
        assert_eq!(revived.version, 4);
    }

    #[test]
    fn scope_filter_and_json_roundtrip() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        set(
            &connection,
            NewSetting {
                id: None,
                space_id: None,
                scope: Some("space".to_string()),
                key: "task.defaults".to_string(),
                value: serde_json::json!({ "list": "work", "reminder": "提前 15 分钟" }),
            },
        )
        .expect("space setting");
        set(
            &connection,
            NewSetting {
                id: None,
                space_id: None,
                scope: Some("device".to_string()),
                key: "notify.sound".to_string(),
                value: serde_json::json!(true),
            },
        )
        .expect("device setting");

        let device = list(
            &connection,
            &SettingQuery {
                scope: Some("device".to_string()),
                ..SettingQuery::default()
            },
        )
        .expect("device list");
        assert!(device.iter().all(|item| item.scope == "device"));
        assert!(device.iter().any(|item| item.key == "notify.sound"));

        let value = get(&connection, "space", "task.defaults")
            .expect("get space setting")
            .value;
        assert_eq!(value["list"], "work");
    }

    #[test]
    fn invalid_scope_is_rejected() {
        let (_dir, repository) = test_support::repository();
        let connection = repository.connection().expect("connection");

        let error = set(
            &connection,
            NewSetting {
                id: None,
                space_id: None,
                scope: Some("global".to_string()),
                key: "x".to_string(),
                value: serde_json::json!(1),
            },
        )
        .expect_err("invalid scope must fail");
        assert!(matches!(error, RepoError::Invalid(_)));
    }
}
