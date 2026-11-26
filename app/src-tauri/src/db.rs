use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[cfg(unix)]
use std::sync::Once;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use thiserror::Error;

pub const DB_FILE_NAME: &str = "zhixing.db";

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

const CREATE_MIGRATIONS_TABLE: &str = "
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
";

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "bootstrap",
        sql: include_str!("../migrations/0001_bootstrap.sql"),
    },
    Migration {
        version: 2,
        name: "domain",
        sql: include_str!("../migrations/0002_domain.sql"),
    },
    Migration {
        version: 3,
        name: "review_snapshots",
        sql: include_str!("../migrations/0003_review_snapshots.sql"),
    },
    Migration {
        version: 4,
        name: "event_calendar_type",
        sql: include_str!("../migrations/0004_event_calendar_type.sql"),
    },
    Migration {
        version: 5,
        name: "lists_parent",
        sql: include_str!("../migrations/0005_lists_parent.sql"),
    },
    Migration {
        version: 6,
        name: "note_encryption",
        sql: include_str!("../migrations/0006_note_encryption.sql"),
    },
    Migration {
        version: 7,
        name: "note_encryption_scrub",
        sql: include_str!("../migrations/0007_note_encryption_scrub.sql"),
    },
];

#[derive(Debug, Error)]
pub enum DbError {
    #[error("无法创建数据库目录 {path}：{source}")]
    CreateDir {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("SQLite 错误：{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("迁移 {version} ({name}) 失败：{source}")]
    Migration {
        version: i64,
        name: &'static str,
        #[source]
        source: rusqlite::Error,
    },
    #[error("数据库包含未知迁移版本 {0}，请升级应用或恢复备份")]
    UnknownMigration(i64),
    #[error("迁移 {version} 的名称不匹配：数据库为 {found}，应用为 {expected}")]
    MigrationNameMismatch {
        version: i64,
        found: String,
        expected: &'static str,
    },
    #[error("迁移版本必须严格递增，发现重复或倒序版本 {0}")]
    InvalidMigrationOrder(i64),
    #[error("初始化领域种子数据失败：{0}")]
    Seed(String),
    #[error("数据库升级前备份失败：{0}")]
    Backup(String),
    #[error("清单树自检失败：{0}")]
    TreeCheck(String),
    #[error("收紧数据库文件权限失败：{0}")]
    Permission(String),
    #[error("WAL 检查点未完成：仍有连接在使用数据库，请稍后重试")]
    WalBusy,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbStatus {
    pub path: String,
    pub ready: bool,
    pub schema_version: i64,
    pub journal_mode: String,
    pub foreign_keys: bool,
    pub applied: Vec<String>,
    pub error: Option<String>,
}

impl DbStatus {
    fn failed(path: &Path, error: String) -> Self {
        Self {
            path: path.display().to_string(),
            ready: false,
            schema_version: 0,
            journal_mode: "unknown".to_string(),
            foreign_keys: false,
            applied: Vec::new(),
            error: Some(error),
        }
    }
}

pub struct DbState {
    path: PathBuf,
    status: Mutex<DbStatus>,
}

impl DbState {
    /// 桌面壳与命令层测试通过已迁移的路径构造状态；不暴露任意写入入口。
    pub(crate) fn new(path: PathBuf, status: DbStatus) -> Self {
        Self {
            path,
            status: Mutex::new(status),
        }
    }

    pub fn status(&self) -> DbStatus {
        self.snapshot()
    }

    /// 只读路径，供仓储层与后续诊断命令使用。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 打开一个已启用 WAL / foreign_keys 的新连接。
    pub fn connection(&self) -> Result<Connection, DbError> {
        open_connection(&self.path)
    }

    fn snapshot(&self) -> DbStatus {
        match self.status.lock() {
            Ok(status) => status.clone(),
            Err(_) => DbStatus::failed(&self.path, "本地库状态锁已损坏".to_string()),
        }
    }

    fn replace(&self, status: DbStatus) {
        if let Ok(mut guard) = self.status.lock() {
            *guard = status;
        }
    }
}

#[derive(Debug)]
struct AppliedMigration {
    version: i64,
    name: String,
}

#[derive(Debug)]
struct MigrationReport {
    from_version: i64,
    to_version: i64,
    applied: Vec<String>,
}

pub fn init(app: &AppHandle) -> DbState {
    let path = match app.path().app_data_dir() {
        Ok(dir) => dir.join(DB_FILE_NAME),
        Err(error) => {
            let path = PathBuf::from(DB_FILE_NAME);
            let status = DbStatus::failed(&path, format!("无法定位应用数据目录：{error}"));
            log::error!("database path resolution failed: {error}");
            return DbState::new(path, status);
        }
    };

    match migrate_and_status(&path) {
        Ok(status) => {
            log::info!(
                "database ready: path={} schema_version={} journal_mode={} foreign_keys={} applied=[{}]",
                path.display(),
                status.schema_version,
                status.journal_mode,
                status.foreign_keys,
                status.applied.join(", ")
            );
            DbState::new(path, status)
        }
        Err(error) => {
            log::error!("database initialization failed: {error}");
            DbState::new(path.clone(), DbStatus::failed(&path, error.to_string()))
        }
    }
}

#[tauri::command]
pub fn db_status(state: State<'_, DbState>) -> DbStatus {
    state.snapshot()
}

#[tauri::command]
pub fn db_migrate(state: State<'_, DbState>) -> Result<DbStatus, String> {
    match migrate_and_status(&state.path) {
        Ok(status) => {
            log::info!(
                "manual database migration complete: schema_version={}",
                status.schema_version
            );
            state.replace(status.clone());
            Ok(status)
        }
        Err(error) => {
            log::error!("manual database migration failed: {error}");
            let status = DbStatus::failed(&state.path, error.to_string());
            state.replace(status);
            Err(error.to_string())
        }
    }
}

/// 供桌面壳、迁移 CLI 与集成测试复用的迁移入口（含种子）。
pub fn migrate_path(path: &Path) -> Result<DbStatus, DbError> {
    migrate_and_status(path)
}

/// 只读取当前状态，不执行迁移。
pub fn status_path(path: &Path) -> Result<DbStatus, DbError> {
    read_status(path)
}

fn migrate_and_status(path: &Path) -> Result<DbStatus, DbError> {
    let report = run_migrations(path)?;
    log::info!(
        "migrations applied: from={} to={} applied=[{}]",
        report.from_version,
        report.to_version,
        report.applied.join(", ")
    );
    read_status(path)
}

fn run_migrations(path: &Path) -> Result<MigrationReport, DbError> {
    validate_migrations()?;
    // 必须在创建目录/数据库之前收紧进程 umask，否则新文件会按默认 0644 落盘。
    harden_process_umask();

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|source| DbError::CreateDir {
                path: parent.display().to_string(),
                source,
            })?;
        }
    }

    let mut connection = open_connection(path)?;
    connection.execute_batch(CREATE_MIGRATIONS_TABLE)?;

    let already_applied = load_applied(&connection)?;
    validate_applied(&already_applied)?;

    let from_version = already_applied
        .iter()
        .map(|migration| migration.version)
        .max()
        .unwrap_or(0);
    let mut to_version = from_version;
    let mut applied = Vec::new();

    let pending: Vec<&Migration> = MIGRATIONS
        .iter()
        .filter(|migration| {
            !already_applied
                .iter()
                .any(|applied| applied.version == migration.version)
        })
        .collect();

    // 升级前保留一份一致的数据库副本；失败时不进入主界面，备份仍可恢复。
    if let (Some(target), true) = (pending.last(), !already_applied.is_empty() && path.exists()) {
        backup_before_migration(&connection, path, target)?;
    }

    for migration in MIGRATIONS {
        if already_applied
            .iter()
            .any(|applied| applied.version == migration.version)
        {
            continue;
        }

        let tx = connection.transaction()?;
        tx.execute_batch(migration.sql)
            .map_err(|source| DbError::Migration {
                version: migration.version,
                name: migration.name,
                source,
            })?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
            params![migration.version, migration.name],
        )
        .map_err(|source| DbError::Migration {
            version: migration.version,
            name: migration.name,
            source,
        })?;
        tx.pragma_update(None, "user_version", migration.version)?;
        tx.commit()?;

        to_version = migration.version;
        applied.push(format!("{:04}_{}", migration.version, migration.name));
    }

    // 即使本次没有待执行迁移，也把 user_version 校准到最新版本。
    connection.pragma_update(None, "user_version", to_version)?;

    // 树结构自检：父节点存在、同空间、收件箱为根、无环、深度 ≤3。
    // 旧库/导入数据带病时不“带病启动”，调用方会显示失败页并保留备份。
    crate::repositories::lists::validate_tree(&connection)
        .map_err(|error| DbError::TreeCheck(error.to_string()))?;

    // 种子依赖最新 schema；标记写入后重复启动不会重复插入。
    let seed_report = crate::repositories::seed::ensure_seed(&mut connection)
        .map_err(|error| DbError::Seed(error.to_string()))?;
    log::info!(
        "domain seed: applied={} samples={} inbox_created={} work_created={}",
        seed_report.applied,
        seed_report.samples_inserted,
        seed_report.inbox_created,
        seed_report.work_created
    );

    Ok(MigrationReport {
        from_version,
        to_version,
        applied,
    })
}

fn backup_before_migration(
    connection: &Connection,
    path: &Path,
    target: &Migration,
) -> Result<(), DbError> {
    let metadata = fs::metadata(path).map_err(|error| DbError::Backup(error.to_string()))?;
    if metadata.len() == 0 {
        return Ok(());
    }
    let stamp: String = connection
        .query_row("SELECT strftime('%Y%m%d%H%M%S', 'now')", [], |row| {
            row.get(0)
        })
        .map_err(|error| DbError::Backup(error.to_string()))?;
    let backup_name = format!("{}.pre-{:04}.{}.bak", DB_FILE_NAME, target.version, stamp);
    let backup_path = path.with_file_name(backup_name);
    let backup_target = backup_path.display().to_string();
    if backup_path.exists() {
        fs::remove_file(&backup_path).map_err(|error| DbError::Backup(error.to_string()))?;
    }
    // VACUUM INTO 生成一致的副本，包含 WAL 中尚未 checkpoint 的已提交页。
    connection
        .execute("VACUUM INTO ?1", params![backup_target])
        .map_err(|error| DbError::Backup(error.to_string()))?;
    // 迁移备份同样可能包含明文笔记（例如首次升级到 0006 之前），必须 0600。
    set_private_mode(&backup_path, 0o600)
        .map_err(|error| DbError::Permission(error.to_string()))?;
    prune_backups(path);
    log::info!(
        "database backup before migration {}: {}",
        target.version,
        backup_path.display()
    );
    Ok(())
}

/// 同目录最多保留最近 3 份迁移前备份。
fn prune_backups(path: &Path) {
    let Some(parent) = path.parent() else {
        return;
    };
    let directory = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut backups: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|candidate| {
            candidate
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with(&format!("{DB_FILE_NAME}.pre-")) && name.ends_with(".bak")
                })
        })
        .collect();
    backups.sort();
    while backups.len() > 3 {
        let oldest = backups.remove(0);
        let _ = fs::remove_file(oldest);
    }
}

fn validate_migrations() -> Result<(), DbError> {
    let mut previous = 0;
    for migration in MIGRATIONS {
        if migration.version <= previous {
            return Err(DbError::InvalidMigrationOrder(migration.version));
        }
        previous = migration.version;
    }
    Ok(())
}

fn validate_applied(applied: &[AppliedMigration]) -> Result<(), DbError> {
    for row in applied {
        match MIGRATIONS
            .iter()
            .find(|migration| migration.version == row.version)
        {
            Some(migration) if migration.name == row.name => {}
            Some(migration) => {
                return Err(DbError::MigrationNameMismatch {
                    version: row.version,
                    found: row.name.clone(),
                    expected: migration.name,
                });
            }
            None => return Err(DbError::UnknownMigration(row.version)),
        }
    }
    Ok(())
}

fn load_applied(connection: &Connection) -> Result<Vec<AppliedMigration>, DbError> {
    let mut statement =
        connection.prepare("SELECT version, name FROM schema_migrations ORDER BY version")?;
    let rows = statement.query_map([], |row| {
        Ok(AppliedMigration {
            version: row.get(0)?,
            name: row.get(1)?,
        })
    })?;

    let mut applied = Vec::new();
    for row in rows {
        applied.push(row?);
    }
    Ok(applied)
}

pub fn open_connection(path: &Path) -> Result<Connection, DbError> {
    harden_process_umask();
    let connection = Connection::open(path)?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA synchronous = NORMAL;
         -- FULL（1）而不是 FAST（2）：任何 UPDATE/DELETE 都覆盖页内旧内容。
         PRAGMA secure_delete = ON;",
    )?;
    // 文件库返回 wal；内存库返回 memory，两者都不应报错。
    let _: String = connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    if let Some(database_path) = main_database_path(&connection) {
        if let Err(error) = harden_database_permissions(&database_path) {
            // 只读挂载/FAT 等文件系统可能不支持 chmod；不阻断启动，但必须留痕。
            log::warn!("database permissions could not be hardened: {error}");
        }
    }
    Ok(connection)
}

/// 进程级 umask：SQLite 新建的 `-wal`/`-shm`、迁移备份与密钥信封至少落成 0600，
/// 目录落成 0700。只在 Unix 生效；重复调用无副作用。
pub fn harden_process_umask() {
    #[cfg(unix)]
    {
        static UMASK: Once = Once::new();
        UMASK.call_once(|| unsafe {
            libc::umask(0o077);
        });
    }
}

pub fn main_database_path(connection: &Connection) -> Option<PathBuf> {
    let file: String = connection
        .query_row(
            "SELECT file FROM pragma_database_list WHERE name = 'main'",
            [],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()?;
    if file.is_empty() {
        None
    } else {
        Some(PathBuf::from(file))
    }
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

#[cfg(unix)]
fn set_private_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    match fs::set_permissions(path, fs::Permissions::from_mode(mode)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(not(unix))]
fn set_private_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

/// 目录 0700；主库、WAL、SHM、回滚日志 0600。
pub fn harden_database_permissions(path: &Path) -> Result<(), DbError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let directory = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    set_private_mode(directory, 0o700)
        .map_err(|error| DbError::Permission(format!("{}：{error}", directory.display())))?;
    set_private_mode(path, 0o600)
        .map_err(|error| DbError::Permission(format!("{}：{error}", path.display())))?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let sidecar = sidecar_path(path, suffix);
        set_private_mode(&sidecar, 0o600)
            .map_err(|error| DbError::Permission(format!("{}：{error}", sidecar.display())))?;
    }
    harden_migration_backups(directory)?;
    Ok(())
}

/// 迁移备份可能包含明文笔记；同目录 `zhixing.db.pre-*.bak` 一并收紧为 0600。
fn harden_migration_backups(directory: &Path) -> Result<(), DbError> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str() else {
            continue;
        };
        if name.starts_with(&format!("{DB_FILE_NAME}.pre-")) && name.ends_with(".bak") {
            set_private_mode(&entry.path(), 0o600).map_err(|error| {
                DbError::Permission(format!("{}：{error}", entry.path().display()))
            })?;
        }
    }
    Ok(())
}

/// 把 WAL 中的已提交页写回主库并把 WAL 截断为 0 字节。
/// 只做 checkpoint 不重建主库；用于锁定/退出等快速路径。
pub fn checkpoint_wal(connection: &Connection) -> Result<(), DbError> {
    let busy: i64 =
        connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
    if busy != 0 {
        return Err(DbError::WalBusy);
    }
    Ok(())
}

/// 加密事务提交后调用：FULL secure_delete + VACUUM 重建主库 + 截断 WAL，
/// 再收紧目录/文件权限。VACUUM 不能运行在事务中，调用方必须已经提交。
///
/// 触发时机：仅“明文行切换为密文”后的安全点（启用加密成功）以及
/// `scrub_pending=1` 的启动/锁定重试；普通状态查询与每次锁定不做全库 VACUUM。
/// 失败会返回错误并由调用方保留 pending、在设置页显示可见提示，不静默吞掉。
pub fn scrub_plaintext_pages(connection: &Connection) -> Result<(), DbError> {
    connection.execute_batch("PRAGMA secure_delete = ON;")?;
    // VACUUM 重建整库：旧页（含页内空闲区）不会进入新库，文件尾部也会截断。
    connection.execute_batch("VACUUM;")?;
    // WAL 里可能保留 UPDATE 前的旧页帧；TRUNCATE 后旧帧被丢弃。
    checkpoint_wal(connection)?;
    if let Some(path) = main_database_path(connection) {
        harden_database_permissions(&path)?;
    }
    Ok(())
}

fn read_status(path: &Path) -> Result<DbStatus, DbError> {
    let connection = open_connection(path)?;

    let schema_version: i64 = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    let journal_mode: String = connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
    let foreign_keys: i64 = connection.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;
    let applied = load_applied(&connection)?
        .iter()
        .map(|migration| format!("{:04}_{}", migration.version, migration.name))
        .collect();

    Ok(DbStatus {
        path: path.display().to_string(),
        ready: true,
        schema_version,
        journal_mode,
        foreign_keys: foreign_keys != 0,
        applied,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn database_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().expect("create temp dir");
        let path = dir.path().join("nested").join(DB_FILE_NAME);
        (dir, path)
    }

    #[test]
    fn fresh_database_is_migrated_with_wal_and_foreign_keys() {
        let (_dir, path) = database_path();

        let status = migrate_and_status(&path).expect("migrate fresh database");

        assert!(status.ready);
        assert_eq!(status.error, None);
        assert_eq!(status.schema_version, 7);
        assert_eq!(status.journal_mode, "wal");
        assert!(status.foreign_keys);
        assert_eq!(
            status.applied,
            vec![
                "0001_bootstrap".to_string(),
                "0002_domain".to_string(),
                "0003_review_snapshots".to_string(),
                "0004_event_calendar_type".to_string(),
                "0005_lists_parent".to_string(),
                "0006_note_encryption".to_string(),
                "0007_note_encryption_scrub".to_string()
            ]
        );
        assert!(path.exists());
    }

    #[test]
    fn all_required_domain_tables_exist() {
        let (_dir, path) = database_path();
        migrate_and_status(&path).expect("migrate");

        let connection = open_connection(&path).expect("open database");
        let required = [
            "lists",
            "tasks",
            "subtasks",
            "notes",
            "note_blocks",
            "note_todos",
            "events",
            "countdowns",
            "habits",
            "habit_logs",
            "focus_sessions",
            "boards",
            "board_nodes",
            "board_edges",
            "attachments",
            "settings",
            "review_snapshots",
        ];
        for table in required {
            let exists: i64 = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                    params![table],
                    |row| row.get(0),
                )
                .expect("look up table");
            assert_eq!(exists, 1, "missing table {table}");
        }

        for forbidden in ["users", "memberships", "seats", "accounts"] {
            let exists: i64 = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                    params![forbidden],
                    |row| row.get(0),
                )
                .expect("look up forbidden table");
            assert_eq!(exists, 0, "forbidden table {forbidden} must not exist");
        }
    }

    #[test]
    fn seed_does_not_duplicate_across_restarts() {
        let (_dir, path) = database_path();
        migrate_and_status(&path).expect("first migrate");

        let counts = |path: &Path| -> Vec<i64> {
            let connection = open_connection(path).expect("open database");
            [
                "lists",
                "tasks",
                "subtasks",
                "notes",
                "note_blocks",
                "note_todos",
                "boards",
                "board_nodes",
                "board_edges",
                "settings",
            ]
            .iter()
            .map(|table| {
                connection
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                    .expect("count table")
            })
            .collect()
        };

        let before = counts(&path);
        migrate_and_status(&path).expect("second migrate");
        let after = counts(&path);

        assert_eq!(before, after);
    }

    #[test]
    fn migrations_are_idempotent() {
        let (_dir, path) = database_path();

        let first = run_migrations(&path).expect("first migration");
        let second = run_migrations(&path).expect("second migration");

        assert_eq!(first.from_version, 0);
        assert_eq!(first.to_version, 7);
        assert_eq!(
            first.applied,
            vec![
                "0001_bootstrap".to_string(),
                "0002_domain".to_string(),
                "0003_review_snapshots".to_string(),
                "0004_event_calendar_type".to_string(),
                "0005_lists_parent".to_string(),
                "0006_note_encryption".to_string(),
                "0007_note_encryption_scrub".to_string()
            ]
        );
        assert_eq!(second.from_version, 7);
        assert_eq!(second.to_version, 7);
        assert!(second.applied.is_empty());

        let connection = open_connection(&path).expect("open database");
        let migration_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("count migrations");
        let user_version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(migration_rows, 7);
        assert_eq!(user_version, 7);
    }

    #[test]
    fn upgrading_version_6_encrypted_database_marks_scrub_pending() {
        let (_dir, path) = database_path();
        fs::create_dir_all(path.parent().expect("parent")).expect("create dir");
        let connection = open_connection(&path).expect("open");
        connection
            .execute_batch(CREATE_MIGRATIONS_TABLE)
            .expect("migrations table");
        for migration in MIGRATIONS.iter().filter(|item| item.version <= 6) {
            connection
                .execute_batch(migration.sql)
                .expect("apply legacy migration");
            connection
                .execute(
                    "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
                    params![migration.version, migration.name],
                )
                .expect("record legacy migration");
        }
        connection
            .pragma_update(None, "user_version", 6)
            .expect("legacy user_version");
        connection
            .execute(
                "INSERT INTO notes (
                   id, title, body, tags_json, encrypted, encrypted_tags_json
                 ) VALUES (
                   'legacy-encrypted', 'zxnote:v1:legacy:title', '',
                   '[]', 1, 'zxnote:v1:legacy:tags'
                 )",
                [],
            )
            .expect("legacy encrypted note");
        connection
            .execute(
                "UPDATE note_encryption_meta SET enabled = 1, key_id = 'legacy' WHERE id = 1",
                [],
            )
            .expect("legacy encryption meta");
        drop(connection);

        let status = migrate_and_status(&path).expect("upgrade database");
        assert_eq!(status.schema_version, 7);
        assert_eq!(
            status.applied.last().map(String::as_str),
            Some("0007_note_encryption_scrub")
        );
        let connection = open_connection(&path).expect("reopen");
        let meta =
            crate::repositories::note_encryption::read_meta(&connection).expect("encryption meta");
        assert!(meta.enabled);
        assert!(meta.scrub_pending, "旧加密库升级后必须待清理");
    }

    #[test]
    fn version_3_database_upgrades_and_keeps_events_as_solar() {
        let (_dir, path) = database_path();
        fs::create_dir_all(path.parent().expect("parent")).expect("create dir");
        let connection = open_connection(&path).expect("open");
        connection
            .execute_batch(CREATE_MIGRATIONS_TABLE)
            .expect("migrations table");
        for migration in MIGRATIONS.iter().filter(|item| item.version <= 3) {
            connection
                .execute_batch(migration.sql)
                .expect("apply legacy migration");
            connection
                .execute(
                    "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
                    params![migration.version, migration.name],
                )
                .expect("record legacy migration");
        }
        connection
            .execute(
                "INSERT INTO events (id, space_id, title, start_date)
                 VALUES ('legacy-event', 'personal', '升级前的事件', '2026-10-27')",
                [],
            )
            .expect("insert legacy event");
        drop(connection);

        let status = migrate_and_status(&path).expect("upgrade database");
        assert_eq!(status.schema_version, 7);
        assert_eq!(
            status.applied.last().map(String::as_str),
            Some("0007_note_encryption_scrub")
        );

        let connection = open_connection(&path).expect("reopen");
        let (title, calendar_type): (String, String) = connection
            .query_row(
                "SELECT title, calendar_type FROM events WHERE id = 'legacy-event'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("legacy event must survive migration");
        assert_eq!(title, "升级前的事件");
        assert_eq!(calendar_type, "solar");
    }

    #[test]
    fn bootstrap_seed_persists_across_reopen() {
        let (_dir, path) = database_path();
        migrate_and_status(&path).expect("migrate");

        let connection = open_connection(&path).expect("reopen database");
        let value: String = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'bootstrap'",
                [],
                |row| row.get(0),
            )
            .expect("read bootstrap seed");
        assert_eq!(value, "0001_bootstrap");
    }

    #[test]
    fn upgrading_0004_database_keeps_backup_before_0005() {
        let (_dir, path) = database_path();
        fs::create_dir_all(path.parent().expect("parent")).expect("create dir");
        let connection = open_connection(&path).expect("open");
        connection
            .execute_batch(CREATE_MIGRATIONS_TABLE)
            .expect("migrations table");
        for migration in MIGRATIONS.iter().filter(|item| item.version <= 4) {
            connection
                .execute_batch(migration.sql)
                .expect("apply legacy migration");
            connection
                .execute(
                    "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
                    params![migration.version, migration.name],
                )
                .expect("record legacy migration");
        }
        connection
            .execute(
                "INSERT INTO lists (id, space_id, name, sort_order, is_inbox)
                 VALUES ('legacy-list', 'personal', '升级前清单', 10, 0)",
                [],
            )
            .expect("legacy list");
        drop(connection);

        let status = migrate_and_status(&path).expect("upgrade to 0005");
        assert_eq!(status.schema_version, 7);

        let parent = path.parent().expect("parent");
        let backups: Vec<PathBuf> = fs::read_dir(parent)
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|candidate| {
                candidate
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with("zhixing.db.pre-0007.") && name.ends_with(".bak")
                    })
            })
            .collect();
        assert_eq!(backups.len(), 1, "升级前必须保留一份 0005 备份");
        let backup_connection = Connection::open(&backups[0]).expect("open backup");
        let legacy_name: String = backup_connection
            .query_row(
                "SELECT name FROM lists WHERE id = 'legacy-list'",
                [],
                |row| row.get(0),
            )
            .expect("legacy list in backup");
        assert_eq!(legacy_name, "升级前清单");
    }

    #[test]
    fn failed_0005_migration_rolls_back_schema_and_keeps_backup() {
        let (_dir, path) = database_path();
        fs::create_dir_all(path.parent().expect("parent")).expect("create dir");
        let connection = open_connection(&path).expect("open");
        connection
            .execute_batch(CREATE_MIGRATIONS_TABLE)
            .expect("migrations table");
        for migration in MIGRATIONS.iter().filter(|item| item.version <= 4) {
            connection
                .execute_batch(migration.sql)
                .expect("apply legacy migration");
            connection
                .execute(
                    "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
                    params![migration.version, migration.name],
                )
                .expect("record legacy migration");
        }
        // 注入失败：0005 的 DDL 已执行后，写迁移记录时强制 ABORT，事务必须整体回滚。
        connection
            .execute_batch(
                "CREATE TRIGGER force_fail_0005
                 BEFORE INSERT ON schema_migrations
                 WHEN NEW.version = 5
                 BEGIN
                   SELECT RAISE(ABORT, 'injected migration failure');
                 END;",
            )
            .expect("failure trigger");
        drop(connection);

        let error = migrate_and_status(&path).expect_err("migration must fail");
        assert!(
            matches!(error, DbError::Migration { version: 5, .. }),
            "got {error:?}"
        );

        let connection = open_connection(&path).expect("reopen");
        let parent_column: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('lists') WHERE name = 'parent_id'",
                [],
                |row| row.get(0),
            )
            .expect("parent_id column");
        assert_eq!(parent_column, 0, "失败迁移必须回滚 parent_id 列");
        let migration_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("migration rows");
        assert_eq!(migration_rows, 4, "失败迁移不能留下版本记录");
        drop(connection);

        let parent = path.parent().expect("parent");
        let backups = fs::read_dir(parent)
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|candidate| {
                candidate
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with("zhixing.db.pre-0007.") && name.ends_with(".bak")
                    })
            })
            .count();
        assert_eq!(backups, 1, "失败后必须保留升级前备份");
    }

    #[test]
    fn tree_self_check_blocks_startup_on_cycle() {
        let (_dir, path) = database_path();
        migrate_and_status(&path).expect("migrate");
        let connection = open_connection(&path).expect("open");
        connection
            .execute("UPDATE lists SET parent_id = 'life' WHERE id = 'work'", [])
            .expect("make work child of life");
        connection
            .execute("UPDATE lists SET parent_id = 'work' WHERE id = 'life'", [])
            .expect("make life child of work");
        drop(connection);

        let error = run_migrations(&path).expect_err("cycle must block startup");
        assert!(matches!(error, DbError::TreeCheck(_)), "got {error:?}");
    }

    #[test]
    fn unknown_future_migration_is_rejected() {
        let (_dir, path) = database_path();
        migrate_and_status(&path).expect("migrate");

        let connection = open_connection(&path).expect("open database");
        connection
            .execute(
                "INSERT INTO schema_migrations (version, name) VALUES (99, 'future')",
                [],
            )
            .expect("insert future migration");
        drop(connection);

        let error = run_migrations(&path).expect_err("future migration must fail");
        assert!(matches!(error, DbError::UnknownMigration(99)));
    }

    #[test]
    fn renamed_migration_is_rejected() {
        let (_dir, path) = database_path();
        migrate_and_status(&path).expect("migrate");

        let connection = open_connection(&path).expect("open database");
        connection
            .execute(
                "UPDATE schema_migrations SET name = 'renamed' WHERE version = 1",
                [],
            )
            .expect("rename migration");
        drop(connection);

        let error = run_migrations(&path).expect_err("renamed migration must fail");
        assert!(matches!(
            error,
            DbError::MigrationNameMismatch { version: 1, .. }
        ));
    }
}
