//! 领域仓储层。
//!
//! 设计原则：
//! * SQL 只出现在本模块（Rust），渲染层不拼接 SQL。
//! * 每个操作通过 `Repository::connection()` 获取一个已启用 WAL / foreign_keys 的连接。
//! * 对外只暴露领域模型与输入类型，行映射和软删除过滤在内部完成。
//! * 不包含 users / memberships / seats / accounts；`space_id` 仅作为同步命名空间。

pub mod attachments;
pub mod boards;
pub mod countdowns;
pub mod events;
pub mod focus_sessions;
pub mod habits;
pub mod lists;
pub mod note_encryption;
pub mod note_todos;
pub mod notes;
pub mod reset;
pub mod review_snapshots;
pub mod seed;
pub mod settings;
pub mod tasks;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde::Serialize;
use thiserror::Error;

/// 单用户本地空间。同步时作为命名空间，不作为权限边界。
pub const DEFAULT_SPACE_ID: &str = "personal";

#[derive(Debug, Error)]
pub enum RepoError {
    #[error("SQLite 错误：{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("JSON 序列化错误：{0}")]
    Json(#[from] serde_json::Error),
    #[error("无法打开数据库连接：{0}")]
    Connection(String),
    #[error("未找到 {entity}：{id}")]
    NotFound { entity: &'static str, id: String },
    #[error("参数无效：{0}")]
    Invalid(String),
    #[error("加密操作失败：{0}")]
    Encryption(String),
}

impl From<crate::note_crypto::CryptoError> for RepoError {
    fn from(error: crate::note_crypto::CryptoError) -> Self {
        Self::Encryption(error.to_string())
    }
}

impl RepoError {
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }

    pub(crate) fn not_found(entity: &'static str, id: impl Into<String>) -> Self {
        Self::NotFound {
            entity,
            id: id.into(),
        }
    }
}

/// 带路径的仓储入口；每次操作独立开连接，避免跨线程共享 `Connection`。
#[derive(Debug, Clone)]
pub struct Repository {
    path: PathBuf,
}

impl Repository {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn connection(&self) -> Result<Connection, RepoError> {
        crate::db::open_connection(&self.path)
            .map_err(|error| RepoError::Connection(error.to_string()))
    }
}

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 离线优先的本地 ID：毫秒时间 + 进程内计数器 + 纳秒扰动，32 位十六进制。
/// 不引入额外依赖；PK 约束会兜底发现碰撞。
pub(crate) fn new_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let counter = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "{:011x}{:04x}{:09x}{:04x}",
        now.as_millis() as u64,
        counter & 0xffff,
        now.subsec_nanos(),
        (now.as_millis() as u64 >> 32) & 0xffff
    )
}

pub(crate) fn bool_to_int(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

pub(crate) fn int_to_bool(value: i64) -> bool {
    value != 0
}

pub(crate) fn to_json<T: Serialize>(value: &T) -> Result<String, RepoError> {
    Ok(serde_json::to_string(value)?)
}

pub(crate) fn from_json<T: DeserializeOwned>(raw: &str) -> Result<T, RepoError> {
    Ok(serde_json::from_str(raw)?)
}

pub(crate) fn ensure_changed(
    changed: usize,
    entity: &'static str,
    id: &str,
) -> Result<(), RepoError> {
    if changed == 0 {
        Err(RepoError::not_found(entity, id))
    } else {
        Ok(())
    }
}

pub(crate) fn validate_non_empty(value: &str, field: &str) -> Result<(), RepoError> {
    if value.trim().is_empty() {
        return Err(RepoError::invalid(format!("{field} 不能为空")));
    }
    Ok(())
}

/// 仅测试使用：在临时库里跑完整迁移与种子，返回仓储入口。
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use tempfile::TempDir;

    pub(crate) fn repository() -> (TempDir, Repository) {
        let dir = tempfile::tempdir().expect("create temp dir");
        let path = dir.path().join("zhixing.db");
        crate::db::migrate_path(&path).expect("migrate temp database");
        (dir, Repository::new(path))
    }
}
