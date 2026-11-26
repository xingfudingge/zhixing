//! 笔记加密的密钥生命周期、系统钥匙串存储与 Tauri 命令。
//!
//! 事实边界：
//! * 主密钥只存在于 Rust 内存；锁定时立即 `zeroize`。
//! * 系统钥匙串只保存“口令包裹的主密钥”信封（盐、KDF 参数、AEAD 密文），
//!   不是明文密钥；钥匙串不可用时回退到应用数据目录的 0600 文件。
//! * 口令、主密钥、派生 KEK 都不写日志、不写设置、不进入前端持久化。
//! * 锁定时 `notes_list/notes_get` 返回空内容 + `locked=true`，不返回明文；
//!   写命令在锁定时直接拒绝，避免把密文覆盖成空内容。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::db::DbState;
use crate::note_crypto::{
    create_envelope, envelope_from_json, envelope_to_json, rewrap_envelope, unlock_envelope,
    validate_envelope, KeyEnvelope, NoteCipher, ALGORITHM, KEY_ENVELOPE_FILE, KEY_STORE_ACCOUNT,
    KEY_STORE_SERVICE, PRODUCTION_LOG_N,
};
use crate::repositories::note_encryption::{
    counts, ensure_note_attachments_absent, read_meta, set_meta, set_scrub_pending,
    EncryptionTransformReport,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyStorage {
    Keychain,
    File,
    None,
}

impl KeyStorage {
    fn label(self) -> &'static str {
        match self {
            Self::Keychain => "keychain",
            Self::File => "file",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone)]
struct LoadedEnvelope {
    envelope: Option<KeyEnvelope>,
    storage: KeyStorage,
    error: Option<String>,
}

/// 钥匙串/文件双通道。信封是公开的（没有口令无法解出主密钥），
/// 因此文件回退不会降低“密钥不落盘”的约束；明文主密钥永远不落盘。
#[derive(Debug, Clone)]
pub struct EnvelopeStore {
    directory: PathBuf,
    use_keyring: bool,
}

impl EnvelopeStore {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
            use_keyring: true,
        }
    }

    /// 测试/无钥匙串环境：只读写 0600 文件。
    pub fn file_only(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
            use_keyring: false,
        }
    }

    fn envelope_path(&self) -> PathBuf {
        self.directory.join(KEY_ENVELOPE_FILE)
    }

    fn load(&self) -> LoadedEnvelope {
        if self.use_keyring {
            match keyring::Entry::new(KEY_STORE_SERVICE, KEY_STORE_ACCOUNT) {
                Ok(entry) => match entry.get_password() {
                    Ok(raw) => match envelope_from_json(&raw) {
                        Ok(envelope) => {
                            return LoadedEnvelope {
                                envelope: Some(envelope),
                                storage: KeyStorage::Keychain,
                                error: None,
                            }
                        }
                        Err(error) => {
                            log::warn!("note encryption keychain envelope invalid: {error}");
                        }
                    },
                    Err(keyring::Error::NoEntry) => {}
                    Err(error) => {
                        // 不记录钥匙串条目内容，只记录可恢复的失败类型。
                        log::warn!("note encryption keychain unavailable: {error}");
                    }
                },
                Err(error) => {
                    log::warn!("note encryption keychain init failed: {error}");
                }
            }
        }

        match fs::read_to_string(self.envelope_path()) {
            Ok(raw) => match envelope_from_json(&raw) {
                Ok(envelope) => LoadedEnvelope {
                    envelope: Some(envelope),
                    storage: KeyStorage::File,
                    error: None,
                },
                Err(error) => LoadedEnvelope {
                    envelope: None,
                    storage: KeyStorage::None,
                    error: Some(format!("密钥信封文件损坏：{error}")),
                },
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => LoadedEnvelope {
                envelope: None,
                storage: KeyStorage::None,
                error: None,
            },
            Err(error) => LoadedEnvelope {
                envelope: None,
                storage: KeyStorage::None,
                error: Some(format!("无法读取密钥信封文件：{error}")),
            },
        }
    }

    fn save(&self, envelope: &KeyEnvelope) -> Result<KeyStorage, String> {
        let json = envelope_to_json(envelope).map_err(|error| error.to_string())?;
        write_private_file(&self.envelope_path(), &json)?;
        if self.use_keyring {
            match keyring::Entry::new(KEY_STORE_SERVICE, KEY_STORE_ACCOUNT) {
                Ok(entry) => match entry.set_password(&json) {
                    Ok(()) => return Ok(KeyStorage::Keychain),
                    Err(error) => {
                        log::warn!(
                            "note encryption keychain save failed; fell back to 0600 file: {error}"
                        );
                    }
                },
                Err(error) => {
                    log::warn!("note encryption keychain init failed: {error}");
                }
            }
        }
        Ok(KeyStorage::File)
    }

    fn delete(&self) -> Result<(), String> {
        let mut failures = Vec::new();
        if self.use_keyring {
            match keyring::Entry::new(KEY_STORE_SERVICE, KEY_STORE_ACCOUNT) {
                Ok(entry) => match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => {}
                    Err(error) => failures.push(format!("钥匙串删除失败：{error}")),
                },
                Err(error) => failures.push(format!("钥匙串不可用：{error}")),
            }
        }
        match fs::remove_file(self.envelope_path()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => failures.push(format!("信封文件删除失败：{error}")),
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("；"))
        }
    }
}

fn write_private_file(path: &Path, contents: &str) -> Result<(), String> {
    crate::db::harden_process_umask();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建密钥目录：{error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // 应用数据目录同时存放数据库/日志；统一收紧为 0700。
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("无法设置密钥目录权限：{error}"))?;
        }
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)
            .map_err(|error| format!("无法写入密钥信封：{error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("无法设置密钥信封权限：{error}"))?;
        }
        file.write_all(contents.as_bytes())
            .map_err(|error| format!("写入密钥信封失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步密钥信封失败：{error}"))?;
    }
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("保存密钥信封失败：{error}")
    })?;
    Ok(())
}

struct Inner {
    envelope: Option<KeyEnvelope>,
    cipher: Option<NoteCipher>,
    storage: KeyStorage,
    load_error: Option<String>,
    /// 清理 SQLite 旧页失败时的用户可见提示；成功后清空。
    maintenance_error: Option<String>,
}

pub struct NoteEncryptionState {
    inner: Mutex<Inner>,
    store: EnvelopeStore,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEncryptionStatus {
    pub supported: bool,
    pub configured: bool,
    pub enabled: bool,
    pub locked: bool,
    pub key_missing: bool,
    pub storage: String,
    pub algorithm: String,
    pub key_id: Option<String>,
    pub encrypted_notes: i64,
    pub total_notes: i64,
    pub plaintext_notes: i64,
    pub note_attachments: i64,
    pub pending_encryption: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteEncryptionReport {
    #[serde(flatten)]
    pub status: NoteEncryptionStatus,
    pub transformed: EncryptionTransformReport,
    pub warning: Option<String>,
}

impl NoteEncryptionState {
    pub fn with_store(store: EnvelopeStore) -> Self {
        let loaded = store.load();
        Self {
            inner: Mutex::new(Inner {
                envelope: loaded.envelope,
                cipher: None,
                storage: loaded.storage,
                load_error: loaded.error,
                maintenance_error: None,
            }),
            store,
        }
    }

    pub fn init(app: &AppHandle) -> Self {
        let directory = match app.path().app_data_dir() {
            Ok(directory) => directory,
            Err(error) => {
                log::error!("note encryption app data dir unavailable: {error}");
                PathBuf::from(".")
            }
        };
        Self::with_store(EnvelopeStore::new(directory))
    }

    pub fn has_envelope(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.envelope.is_some())
            .unwrap_or(false)
    }

    /// 列表/读取用：锁定或未配置时返回 None，不报错。
    pub fn cipher_if_unlocked(&self) -> Option<NoteCipher> {
        self.inner.lock().ok()?.cipher.clone()
    }

    /// 写入用：未解锁时给出可操作的具体错误。
    pub fn cipher(&self) -> Result<NoteCipher, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "加密状态锁已损坏".to_string())?;
        if let Some(cipher) = inner.cipher.clone() {
            return Ok(cipher);
        }
        if inner.envelope.is_none() {
            return Err("尚未配置笔记加密；请先在设置中设置加密口令".to_string());
        }
        Err("笔记已加密并锁定；请先在设置 → 隐私与安全中解锁".to_string())
    }

    pub fn status_with_conn(&self, conn: &Connection) -> NoteEncryptionStatus {
        let inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => {
                return NoteEncryptionStatus {
                    supported: true,
                    configured: false,
                    enabled: false,
                    locked: false,
                    key_missing: false,
                    storage: KeyStorage::None.label().to_string(),
                    algorithm: ALGORITHM.to_string(),
                    key_id: None,
                    encrypted_notes: 0,
                    total_notes: 0,
                    plaintext_notes: 0,
                    note_attachments: 0,
                    pending_encryption: false,
                    error: Some("加密状态锁已损坏".to_string()),
                }
            }
        };
        let meta = read_meta(conn);
        let counts = counts(conn).unwrap_or_default();
        let (meta_enabled, _key_id, meta_error) = match meta {
            Ok(meta) => (meta.enabled, meta.key_id, None),
            Err(error) => (false, None, Some(error.to_string())),
        };
        // 恢复备份后可能出现“有密文但元数据尚未打开”的库；以实际密文行为准，
        // 否则 UI 会显示“未启用”，但读取/写入仍按加密笔记处理。
        let enabled = meta_enabled || counts.encrypted_notes > 0;
        let configured = inner.envelope.is_some();
        let key_missing = enabled && !configured;
        let locked = enabled && configured && inner.cipher.is_none();
        NoteEncryptionStatus {
            supported: true,
            configured,
            enabled,
            locked,
            key_missing,
            storage: inner.storage.label().to_string(),
            algorithm: ALGORITHM.to_string(),
            key_id: inner
                .envelope
                .as_ref()
                .map(|envelope| envelope.key_id.clone()),
            encrypted_notes: counts.encrypted_notes,
            total_notes: counts.total_notes,
            plaintext_notes: counts.plaintext_notes,
            note_attachments: counts.note_attachments,
            pending_encryption: enabled && counts.plaintext_notes > 0,
            error: inner
                .load_error
                .clone()
                .or(meta_error)
                .or_else(|| {
                    if key_missing {
                        Some(
                            "检测到加密笔记，但本机缺少密钥信封；请从备份导入信封或恢复原钥匙串"
                                .to_string(),
                        )
                    } else {
                        None
                    }
                })
                .or_else(|| inner.maintenance_error.clone()),
        }
    }

    fn envelope(&self) -> Result<KeyEnvelope, String> {
        self.inner
            .lock()
            .map_err(|_| "加密状态锁已损坏".to_string())?
            .envelope
            .clone()
            .ok_or_else(|| "尚未配置笔记加密；请先设置加密口令".to_string())
    }

    fn set_maintenance_error(&self, message: Option<String>) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.maintenance_error = message;
        }
    }

    /// SQLite 旧页清理：secure_delete FULL + VACUUM + WAL checkpoint(TRUNCATE)。
    /// 只在加密事务提交后或 `scrub_pending=1` 的重试路径调用；失败保留 pending。
    fn attempt_scrub(&self, conn: &Connection) -> Result<(), String> {
        crate::db::scrub_plaintext_pages(conn).map_err(|error| error.to_string())?;
        set_scrub_pending(conn, false).map_err(|error| format!("更新旧页清理状态失败：{error}"))?;
        // 清除 pending 本身是一次很小的写事务；立即截断 WAL，保持 <db>-wal 干净。
        if let Err(error) = crate::db::checkpoint_wal(conn) {
            log::warn!("note encryption scrub checkpoint warning: {error}");
        }
        self.set_maintenance_error(None);
        Ok(())
    }

    /// 应用启动时调用：升级到 0007 的旧加密库、或上次清理中途退出时补做。
    pub fn run_startup_maintenance(&self, conn: &Connection) {
        let pending = match read_meta(conn) {
            Ok(meta) => meta.scrub_pending,
            Err(error) => {
                log::warn!("note encryption scrub state unavailable: {error}");
                return;
            }
        };
        if !pending {
            if let Some(path) = crate::db::main_database_path(conn) {
                if let Err(error) = crate::db::harden_database_permissions(&path) {
                    log::warn!("database permission hardening failed: {error}");
                }
            }
            return;
        }
        match self.attempt_scrub(conn) {
            Ok(()) => log::info!("note encryption scrub: legacy plaintext pages removed"),
            Err(error) => {
                let message = format!(
                    "加密笔记旧页清理未完成：{error}；已保留待重试状态，下次启动或锁定时自动重试"
                );
                log::error!("note encryption scrub failed: {error}");
                self.set_maintenance_error(Some(message));
            }
        }
    }

    /// 设置口令并加密全部笔记；已配置但未加密完成时幂等续做。
    pub fn enable_with_conn(
        &self,
        conn: &mut Connection,
        passphrase: Option<&str>,
    ) -> Result<NoteEncryptionReport, String> {
        ensure_note_attachments_absent(conn).map_err(|error| error.to_string())?;

        let existing_cipher = self.cipher_if_unlocked();
        let existing_envelope = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| "加密状态锁已损坏".to_string())?;
            inner.envelope.clone()
        };

        let (envelope, cipher, created) = if let Some(cipher) = existing_cipher {
            let envelope = existing_envelope
                .ok_or_else(|| "加密状态不一致：有内存密钥但缺少信封".to_string())?;
            (envelope, cipher, false)
        } else if let Some(envelope) = existing_envelope {
            let passphrase = require_passphrase(passphrase)?;
            let cipher =
                unlock_envelope(&envelope, passphrase).map_err(|error| error.to_string())?;
            (envelope, cipher, false)
        } else {
            let passphrase = require_passphrase(passphrase)?;
            let (envelope, cipher) =
                create_envelope(passphrase, PRODUCTION_LOG_N).map_err(|error| error.to_string())?;
            (envelope, cipher, true)
        };

        // 先把公开信封写入钥匙串，再改数据库；数据库失败时回滚并清理新信封。
        let storage = if created {
            match self.store.save(&envelope) {
                Ok(storage) => storage,
                Err(error) => return Err(format!("无法保存密钥信封：{error}")),
            }
        } else {
            self.inner
                .lock()
                .map_err(|_| "加密状态锁已损坏".to_string())?
                .storage
        };

        let transform = (|| -> Result<EncryptionTransformReport, String> {
            let tx = conn.transaction().map_err(|error| error.to_string())?;
            let transform = crate::repositories::note_encryption::encrypt_all(&tx, &cipher)
                .map_err(|error| error.to_string())?;
            set_meta(&tx, true, Some(cipher.key_id())).map_err(|error| error.to_string())?;
            // 先标记“旧页待清理”，再提交；即使随后崩溃，下次启动也会补做。
            set_scrub_pending(&tx, true).map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(transform)
        })();

        let transform = match transform {
            Ok(transform) => transform,
            Err(error) => {
                if created {
                    let _ = self.store.delete();
                }
                return Err(error);
            }
        };

        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "加密状态锁已损坏".to_string())?;
            inner.envelope = Some(envelope);
            inner.cipher = Some(cipher);
            inner.storage = storage;
            inner.load_error = None;
        }

        // 密文已提交后，才允许重建 SQLite（VACUUM 不能在事务内执行）。
        // 失败不谎报成功：保留 pending，并把可见警告放进报告，启动/锁定会重试。
        let warning = match self.attempt_scrub(conn) {
            Ok(()) => None,
            Err(error) => {
                log::error!("note encryption scrub after enable failed: {error}");
                let message = format!(
                    "笔记已加密，但 SQLite 旧页清理未完成：{error}；已保留待重试状态，下次启动或锁定时自动重试"
                );
                self.set_maintenance_error(Some(message.clone()));
                Some(message)
            }
        };

        Ok(NoteEncryptionReport {
            status: self.status_with_conn(conn),
            transformed: transform,
            warning,
        })
    }

    pub fn unlock(
        &self,
        conn: &Connection,
        passphrase: &str,
    ) -> Result<NoteEncryptionStatus, String> {
        let envelope = self.envelope()?;
        let cipher = unlock_envelope(&envelope, passphrase).map_err(|error| error.to_string())?;
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "加密状态锁已损坏".to_string())?;
            inner.envelope = Some(envelope);
            inner.cipher = Some(cipher);
        }
        Ok(self.status_with_conn(conn))
    }

    pub fn lock(&self, conn: &Connection) -> Result<NoteEncryptionStatus, String> {
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "加密状态锁已损坏".to_string())?;
            // NoteCipher 内部是 Zeroizing，drop 即清零。
            inner.cipher = None;
        }
        // 锁定是安全点：先截断 WAL，旧帧不会继续留在 -wal；
        // 若上次加密/清理中途退出留下 pending，则补做全库 VACUUM。
        if let Err(error) = crate::db::checkpoint_wal(conn) {
            log::warn!("note encryption lock checkpoint warning: {error}");
        }
        let pending = read_meta(conn)
            .map(|meta| meta.scrub_pending)
            .unwrap_or(false);
        if pending {
            if let Err(error) = self.attempt_scrub(conn) {
                let message = format!(
                    "已锁定，但 SQLite 旧页清理未完成：{error}；已保留待重试状态，下次启动或锁定时自动重试"
                );
                log::error!("note encryption scrub on lock failed: {error}");
                self.set_maintenance_error(Some(message));
            }
        } else {
            self.set_maintenance_error(None);
        }
        Ok(self.status_with_conn(conn))
    }

    pub fn change_passphrase(
        &self,
        conn: &Connection,
        current: &str,
        next: &str,
    ) -> Result<NoteEncryptionStatus, String> {
        let envelope = self.envelope()?;
        let (next_envelope, cipher) = rewrap_envelope(&envelope, current, next, PRODUCTION_LOG_N)
            .map_err(|error| error.to_string())?;
        let storage = self
            .store
            .save(&next_envelope)
            .map_err(|error| format!("无法保存新密钥信封：{error}"))?;
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "加密状态锁已损坏".to_string())?;
            inner.envelope = Some(next_envelope);
            inner.cipher = Some(cipher);
            inner.storage = storage;
            inner.load_error = None;
        }
        Ok(self.status_with_conn(conn))
    }

    /// 关闭加密：先把全部密文解密并提交，再删除信封。
    /// 若删除信封失败，数据已是明文但会留下公开信封；报告 warning，不伪装成功。
    pub fn disable_with_conn(
        &self,
        conn: &mut Connection,
        passphrase: Option<&str>,
    ) -> Result<NoteEncryptionReport, String> {
        let cipher = match self.cipher_if_unlocked() {
            Some(cipher) => cipher,
            None => {
                let envelope = self.envelope()?;
                let passphrase = require_passphrase(passphrase)?;
                unlock_envelope(&envelope, passphrase).map_err(|error| error.to_string())?
            }
        };

        let transform = (|| -> Result<EncryptionTransformReport, String> {
            let tx = conn.transaction().map_err(|error| error.to_string())?;
            let transform = crate::repositories::note_encryption::decrypt_all(&tx, &cipher)
                .map_err(|error| error.to_string())?;
            set_meta(&tx, false, None).map_err(|error| error.to_string())?;
            // 关闭加密后内容本来就是明文，不再需要“清旧页”。
            set_scrub_pending(&tx, false).map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(transform)
        })()?;

        let warning = match self.store.delete() {
            Ok(()) => None,
            Err(error) => Some(format!(
                "笔记已解密，但旧密钥信封未能完全删除：{error}；请重试关闭加密"
            )),
        };
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "加密状态锁已损坏".to_string())?;
            inner.envelope = None;
            inner.cipher = None;
            inner.storage = KeyStorage::None;
            inner.load_error = None;
            inner.maintenance_error = None;
        }

        Ok(NoteEncryptionReport {
            status: self.status_with_conn(conn),
            transformed: transform,
            warning,
        })
    }

    /// 备份/迁移用：导出“口令包裹的主密钥”信封，不是明文密钥。
    pub fn envelope_json(&self) -> Result<Option<String>, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "加密状态锁已损坏".to_string())?;
        match inner.envelope.as_ref() {
            Some(envelope) => envelope_to_json(envelope)
                .map(Some)
                .map_err(|error| error.to_string()),
            None => Ok(None),
        }
    }

    /// 恢复用：只接受合法信封；本机已有不同 keyId 时拒绝覆盖，避免把现有笔记锁死。
    pub fn import_envelope(
        &self,
        conn: &Connection,
        json: &str,
    ) -> Result<NoteEncryptionStatus, String> {
        let envelope = envelope_from_json(json).map_err(|error| error.to_string())?;
        validate_envelope(&envelope).map_err(|error| error.to_string())?;
        {
            let inner = self
                .inner
                .lock()
                .map_err(|_| "加密状态锁已损坏".to_string())?;
            if let Some(existing) = inner.envelope.as_ref() {
                if existing.key_id != envelope.key_id {
                    return Err(
                        "本机已有另一份笔记加密密钥；导入不同 keyId 会锁死现有笔记，已拒绝"
                            .to_string(),
                    );
                }
                return Ok(self.status_with_conn(conn));
            }
        }
        let storage = self
            .store
            .save(&envelope)
            .map_err(|error| format!("无法保存导入的密钥信封：{error}"))?;
        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "加密状态锁已损坏".to_string())?;
            inner.envelope = Some(envelope);
            inner.cipher = None;
            inner.storage = storage;
            inner.load_error = None;
        }
        // 恢复的备份可能来自旧版本，页内仍有机会残留明文；导入信封后立即清理。
        if counts(conn)
            .map(|counts| counts.encrypted_notes > 0)
            .unwrap_or(false)
        {
            if let Err(error) = set_scrub_pending(conn, true) {
                log::warn!("note encryption scrub state could not be marked: {error}");
            }
            if let Err(error) = self.attempt_scrub(conn) {
                log::error!("note encryption scrub after envelope import failed: {error}");
                self.set_maintenance_error(Some(format!(
                    "已导入密钥信封，但 SQLite 旧页清理未完成：{error}；下次启动或锁定时自动重试"
                )));
            }
        }
        Ok(self.status_with_conn(conn))
    }
}

fn require_passphrase(passphrase: Option<&str>) -> Result<&str, String> {
    match passphrase {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err("请输入加密口令".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn note_encryption_status(
    state: State<'_, NoteEncryptionState>,
    db: State<'_, DbState>,
) -> Result<NoteEncryptionStatus, String> {
    let connection = db.connection().map_err(|error| error.to_string())?;
    Ok(state.status_with_conn(&connection))
}

#[tauri::command]
pub fn note_encryption_enable(
    state: State<'_, NoteEncryptionState>,
    db: State<'_, DbState>,
    passphrase: Option<String>,
) -> Result<NoteEncryptionReport, String> {
    let mut connection = db.connection().map_err(|error| error.to_string())?;
    state.enable_with_conn(&mut connection, passphrase.as_deref())
}

#[tauri::command]
pub fn note_encryption_unlock(
    state: State<'_, NoteEncryptionState>,
    db: State<'_, DbState>,
    passphrase: String,
) -> Result<NoteEncryptionStatus, String> {
    let connection = db.connection().map_err(|error| error.to_string())?;
    state.unlock(&connection, &passphrase)
}

#[tauri::command]
pub fn note_encryption_lock(
    state: State<'_, NoteEncryptionState>,
    db: State<'_, DbState>,
) -> Result<NoteEncryptionStatus, String> {
    let connection = db.connection().map_err(|error| error.to_string())?;
    state.lock(&connection)
}

#[tauri::command]
pub fn note_encryption_change_passphrase(
    state: State<'_, NoteEncryptionState>,
    db: State<'_, DbState>,
    current_passphrase: String,
    next_passphrase: String,
) -> Result<NoteEncryptionStatus, String> {
    let connection = db.connection().map_err(|error| error.to_string())?;
    state.change_passphrase(&connection, &current_passphrase, &next_passphrase)
}

#[tauri::command]
pub fn note_encryption_disable(
    state: State<'_, NoteEncryptionState>,
    db: State<'_, DbState>,
    passphrase: Option<String>,
) -> Result<NoteEncryptionReport, String> {
    let mut connection = db.connection().map_err(|error| error.to_string())?;
    state.disable_with_conn(&mut connection, passphrase.as_deref())
}

#[tauri::command]
pub fn note_encryption_export_envelope(
    state: State<'_, NoteEncryptionState>,
) -> Result<Option<String>, String> {
    state.envelope_json()
}

#[tauri::command]
pub fn note_encryption_import_envelope(
    state: State<'_, NoteEncryptionState>,
    db: State<'_, DbState>,
    envelope_json: String,
) -> Result<NoteEncryptionStatus, String> {
    let connection = db.connection().map_err(|error| error.to_string())?;
    state.import_envelope(&connection, &envelope_json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate_path;

    fn test_state(dir: &Path) -> NoteEncryptionState {
        NoteEncryptionState::with_store(EnvelopeStore::file_only(dir))
    }

    fn open(dir: &Path) -> Connection {
        let path = dir.join("zhixing.db");
        migrate_path(&path).expect("migrate");
        crate::db::open_connection(&path).expect("open")
    }

    const SENTINEL: &str = "ZX11-PLAINTEXT-SENTINEL-9f3a";

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    fn assert_file_clean(path: &Path) {
        if !path.exists() {
            return;
        }
        let bytes = fs::read(path).expect("read database file");
        assert!(
            !contains(&bytes, SENTINEL.as_bytes()),
            "{} 仍可 grep 到明文哨兵",
            path.display()
        );
    }

    #[test]
    fn encryption_scrubs_plaintext_from_db_and_wal() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("zhixing.db");
        {
            let conn = open(dir.path());
            // 明文笔记在加密前已提交到主库，UPDATE 后旧行会留在页内空闲区。
            conn.execute(
                "INSERT INTO notes (id, title, body, tags_json)
                 VALUES ('sentinel-note', ?1, ?2, '[]')",
                rusqlite::params![SENTINEL, format!("{SENTINEL}{}", "padding".repeat(400))],
            )
            .expect("insert sentinel note");
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
                .expect("checkpoint seed");
        }
        assert!(
            contains(&fs::read(&path).expect("read seed"), SENTINEL.as_bytes()),
            "测试前置条件：加密前主库应包含明文"
        );

        let state = test_state(dir.path());
        let mut conn = crate::db::open_connection(&path).expect("open");
        state
            .enable_with_conn(&mut conn, Some("correct horse battery"))
            .expect("enable encryption");
        state.lock(&conn).expect("lock");
        drop(conn);

        for suffix in ["", "-wal", "-shm"] {
            assert_file_clean(&path.with_file_name(format!("zhixing.db{suffix}")));
        }

        let conn = crate::db::open_connection(&path).expect("reopen");
        let counts = counts(&conn).expect("counts");
        assert_eq!(counts.encrypted_notes, counts.total_notes);
        assert_eq!(counts.plaintext_notes, 0);
        let title: String = conn
            .query_row(
                "SELECT title FROM notes WHERE id = 'sentinel-note'",
                [],
                |row| row.get(0),
            )
            .expect("encrypted title");
        assert!(crate::note_crypto::is_ciphertext(&title));
        assert!(!title.contains(SENTINEL));
    }

    #[test]
    fn startup_maintenance_scrubs_legacy_plaintext_residue() {
        let dir = tempfile::tempdir().expect("temp");
        let path = dir.path().join("zhixing.db");
        let state = test_state(dir.path());
        let conn = open(dir.path());

        // 模拟旧版本（secure_delete=FAST/OFF）UPDATE 后留在页内空闲区的明文。
        conn.execute_batch("PRAGMA secure_delete = OFF;")
            .expect("disable secure delete for legacy simulation");
        conn.execute(
            "INSERT INTO notes (id, title, body, tags_json)
             VALUES ('legacy-note', ?1, ?2, '[]')",
            rusqlite::params![SENTINEL, format!("{SENTINEL}{}", "x".repeat(4000))],
        )
        .expect("insert legacy note");
        conn.execute(
            "UPDATE notes SET title = 'changed', body = 'short' WHERE id = 'legacy-note'",
            [],
        )
        .expect("overwrite legacy row");
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .expect("checkpoint legacy state");
        assert!(
            contains(
                &fs::read(&path).expect("read legacy db"),
                SENTINEL.as_bytes()
            ),
            "测试前置条件：旧版本应留下明文空闲页"
        );

        // 0007 迁移会把已有加密库标记为 pending；这里直接模拟升级后的第一启动。
        set_meta(&conn, true, Some("legacy-key")).expect("legacy meta");
        set_scrub_pending(&conn, true).expect("pending");
        state.run_startup_maintenance(&conn);

        assert_file_clean(&path);
        assert_file_clean(&path.with_file_name("zhixing.db-wal"));
        assert!(
            !read_meta(&conn).expect("meta").scrub_pending,
            "清理成功后必须清除 pending"
        );
    }

    #[test]
    fn failed_encryption_transaction_rolls_back_plaintext() {
        let dir = tempfile::tempdir().expect("temp");
        let state = test_state(dir.path());
        let mut conn = open(dir.path());
        conn.execute(
            "INSERT INTO notes (id, title, body, tags_json)
             VALUES ('zz-fail-note', ?1, ?1, '[]')",
            rusqlite::params![SENTINEL],
        )
        .expect("insert failing note");
        // 在批量加密中途注入失败：只要事务正确，任何已在事务内更新的笔记都必须回滚。
        conn.execute_batch(
            "CREATE TRIGGER force_fail_note_encrypt
             BEFORE UPDATE ON notes
             WHEN NEW.id = 'zz-fail-note' AND NEW.encrypted = 1
             BEGIN
               SELECT RAISE(ABORT, 'injected encryption failure');
             END;",
        )
        .expect("failure trigger");

        let before: Vec<(String, String)> = {
            let mut statement = conn
                .prepare("SELECT id, title FROM notes ORDER BY id")
                .expect("prepare");
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .expect("query")
                .collect::<Result<_, _>>()
                .expect("titles")
        };
        let error = state
            .enable_with_conn(&mut conn, Some("correct horse battery"))
            .expect_err("injected failure must abort");
        assert!(error.contains("injected encryption failure"), "{error}");
        assert!(!state.has_envelope(), "失败后不能留下新信封");
        let counts = counts(&conn).expect("counts");
        assert_eq!(counts.encrypted_notes, 0, "事务必须整体回滚");
        let after: Vec<(String, String)> = {
            let mut statement = conn
                .prepare("SELECT id, title FROM notes ORDER BY id")
                .expect("prepare");
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .expect("query")
                .collect::<Result<_, _>>()
                .expect("titles")
        };
        assert_eq!(before, after, "回滚后原文必须逐字保留");
        let meta = read_meta(&conn).expect("meta");
        assert!(!meta.enabled);
        assert!(!meta.scrub_pending);
    }

    #[cfg(unix)]
    #[test]
    fn encryption_hardens_database_and_envelope_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp");
        let state = test_state(dir.path());
        let mut conn = open(dir.path());
        state
            .enable_with_conn(&mut conn, Some("correct horse battery"))
            .expect("enable");
        state.lock(&conn).expect("lock");

        let mode = |path: &Path| fs::metadata(path).expect("metadata").permissions().mode() & 0o777;
        let secure_delete: i64 = conn
            .pragma_query_value(None, "secure_delete", |row| row.get(0))
            .expect("secure_delete pragma");
        assert_eq!(secure_delete, 1, "必须使用 secure_delete=ON（FULL）");
        let database = dir.path().join("zhixing.db");
        assert_eq!(mode(&database), 0o600, "主库必须 0600");
        assert_eq!(mode(dir.path()), 0o700, "数据目录必须 0700");
        assert_eq!(
            mode(&dir.path().join(KEY_ENVELOPE_FILE)),
            0o600,
            "密钥信封必须 0600"
        );
        for suffix in ["-wal", "-shm"] {
            let sidecar = database.with_file_name(format!("zhixing.db{suffix}"));
            if sidecar.exists() {
                assert_eq!(mode(&sidecar), 0o600, "{suffix} 必须 0600");
            }
        }
        drop(conn);
        for suffix in ["", "-wal", "-shm"] {
            let path = database.with_file_name(format!("zhixing.db{suffix}"));
            if path.exists() {
                assert_eq!(mode(&path), 0o600, "关闭后 {} 必须 0600", path.display());
            }
        }
    }

    #[test]
    fn enable_lock_unlock_disable_round_trip() {
        let dir = tempfile::tempdir().expect("temp");
        let state = test_state(dir.path());
        let mut conn = open(dir.path());

        let report = state
            .enable_with_conn(&mut conn, Some("correct horse battery"))
            .expect("enable");
        assert!(report.status.enabled);
        assert!(report.status.configured);
        assert!(!report.status.locked);
        assert_eq!(report.status.encrypted_notes, report.status.total_notes);
        assert_eq!(report.status.storage, "file");
        assert!(report.transformed.notes > 0);

        // 锁定后列表/读取不应泄露明文；写操作直接拒绝。
        let locked = state.lock(&conn).expect("lock");
        assert!(locked.locked);
        assert!(state.cipher().is_err());

        let wrong = state.unlock(&conn, "wrong passphrase").expect_err("wrong");
        assert!(wrong.contains("口令错误"), "{wrong}");
        assert!(state.cipher().is_err());

        let unlocked = state
            .unlock(&conn, "correct horse battery")
            .expect("unlock");
        assert!(!unlocked.locked);

        let disabled = state
            .disable_with_conn(&mut conn, None)
            .expect("disable while unlocked");
        assert!(!disabled.status.enabled);
        assert!(!disabled.status.configured);
        assert!(disabled.transformed.notes > 0);
        let counts = counts(&conn).expect("counts");
        assert_eq!(counts.encrypted_notes, 0);
    }

    #[test]
    fn wrong_passphrase_does_not_change_state() {
        let dir = tempfile::tempdir().expect("temp");
        let state = test_state(dir.path());
        let conn = {
            let path = dir.path().join("zhixing.db");
            migrate_path(&path).expect("migrate");
            crate::db::open_connection(&path).expect("open")
        };
        state
            .enable_with_conn(
                &mut crate::db::open_connection(&dir.path().join("zhixing.db")).expect("open"),
                Some("correct horse battery"),
            )
            .expect("enable");
        let error = state.unlock(&conn, "bad passphrase").expect_err("bad");
        assert!(error.contains("口令错误"));
        assert!(state.has_envelope());
    }

    #[test]
    fn envelope_export_import_and_key_id_conflict() {
        let first = tempfile::tempdir().expect("temp");
        let state_a = test_state(first.path());
        let mut conn_a = open(first.path());
        state_a
            .enable_with_conn(&mut conn_a, Some("correct horse battery"))
            .expect("enable");
        let json = state_a.envelope_json().expect("export").expect("some");

        let second = tempfile::tempdir().expect("temp");
        let state_b = test_state(second.path());
        let conn_b = open(second.path());
        let imported = state_b.import_envelope(&conn_b, &json).expect("import");
        assert!(imported.configured);
        assert!(!imported.enabled);
        let parsed = envelope_from_json(&json).expect("parse");
        assert_eq!(imported.key_id.as_deref(), Some(parsed.key_id.as_str()));
        let unlocked = state_b
            .unlock(&conn_b, "correct horse battery")
            .expect("unlock imported envelope");
        assert!(!unlocked.locked);

        let third = tempfile::tempdir().expect("temp");
        let state_c = test_state(third.path());
        let mut conn_c = open(third.path());
        state_c
            .enable_with_conn(&mut conn_c, Some("another correct horse"))
            .expect("enable other");
        let error = state_c
            .import_envelope(&conn_c, &json)
            .expect_err("conflict");
        assert!(error.contains("另一份"), "{error}");
    }

    #[test]
    fn enabling_with_note_attachments_is_refused() {
        let dir = tempfile::tempdir().expect("temp");
        let state = test_state(dir.path());
        let mut conn = open(dir.path());
        let note_id: String = conn
            .query_row("SELECT id FROM notes ORDER BY id LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("note");
        conn.execute(
            "INSERT INTO attachments (
               id, space_id, note_id, block_id, file_name, mime, sha256, byte_size, storage_key
             ) VALUES ('att-a', 'personal', ?1, NULL, '图.png', 'image/png', ?2, 3, ?3)",
            rusqlite::params![note_id, "a".repeat(64), "local:image"],
        )
        .expect("attachment");
        let error = state
            .enable_with_conn(&mut conn, Some("correct horse battery"))
            .expect_err("attachments must block");
        assert!(error.contains("附件"), "{error}");
        assert!(!state.has_envelope());
    }

    #[test]
    #[ignore = "manual: touches the real OS keychain"]
    fn keychain_round_trip_manual() {
        let account = format!("note-encryption-test-{}", std::process::id());
        let entry =
            keyring::Entry::new(KEY_STORE_SERVICE, &account).expect("create keychain entry");
        entry
            .set_password("wrapped-key-envelope-placeholder")
            .expect("write keychain");
        assert_eq!(
            entry.get_password().expect("read keychain"),
            "wrapped-key-envelope-placeholder"
        );
        entry.delete_credential().expect("delete keychain entry");
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }

    #[test]
    fn crypto_errors_are_not_swallowed() {
        let error = crate::note_crypto::CryptoError::UnlockFailed.to_string();
        assert_eq!(error, "解锁失败：口令错误或密钥数据损坏");
    }
}
