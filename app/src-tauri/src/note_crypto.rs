//! 笔记内容加密原语。
//!
//! 设计（见 `docs/ADR-note-encryption.md`）：
//! * 每篇笔记的标题、正文、标签、块 payload、笔记待办标题各自作为独立字段加密；
//! * 数据密钥是 32 字节随机主密钥，只存在于内存；口令通过 scrypt 派生 KEK 后
//!   用 XChaCha20-Poly1305 包裹主密钥，存入系统钥匙串；
//! * 每个字段使用独立随机 24 字节 nonce，AAD 绑定 `keyId + 笔记/字段`，
//!   密文不能跨笔记或跨字段搬运；
//! * 不自行发明密码算法：scrypt 来自 RustCrypto（RFC 7914），
//!   XChaCha20-Poly1305 来自 RustCrypto（RFC 8439 的 XChaCha 扩展）。
//!
//! 兼容边界：`notes.folder_id`、`status`、`favorite`、`pinned`、时间戳与 id
//! 仍是明文元数据，用于目录/排序；附件二进制与 OCR 文本不在此模块内，
//! 开启加密时由应用层拒绝存在笔记附件的库，并在加密期间禁用 OCR 入队。

use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use scrypt::{scrypt, Params as ScryptParams};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroizing;

pub const ENVELOPE_VERSION: u32 = 1;
pub const ALGORITHM: &str = "scrypt+XChaCha20-Poly1305";
pub const CIPHERTEXT_PREFIX: &str = "zxnote:v1:";
pub const KEY_STORE_SERVICE: &str = "com.zhixing.desktop";
pub const KEY_STORE_ACCOUNT: &str = "note-encryption-v1";
pub const KEY_ENVELOPE_FILE: &str = "note-encryption-envelope.json";

/// 生产参数。logN=17（128 MiB）与 RustCrypto `Params::RECOMMENDED_LOG_N`
/// 一致；age 的口令 stanza 使用 logN=18。测试使用 14 以保持测试快速，
/// 信封解析拒绝低于 14 的参数，避免降级。
pub const PRODUCTION_LOG_N: u8 = 17;
pub const MIN_LOG_N: u8 = 14;
pub const MAX_LOG_N: u8 = 20;
pub const SCRYPT_R: u32 = 8;
pub const SCRYPT_P: u32 = 1;
pub const MIN_PASSPHRASE_CHARS: usize = 8;
pub const MAX_PASSPHRASE_BYTES: usize = 1024;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const MASTER_KEY_LEN: usize = 32;
const KEY_ID_BYTES: usize = 8;
const KEY_WRAP_AAD_PREFIX: &str = "zx-note-key:v1:";
const FIELD_AAD_PREFIX: &str = "zx-note:v1:";

const UNLOCK_FAILED_MESSAGE: &str = "解锁失败：口令错误或密钥数据损坏";

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("口令至少需要 {MIN_PASSPHRASE_CHARS} 个字符")]
    PassphraseTooShort,
    #[error("口令过长（最多 {MAX_PASSPHRASE_BYTES} 字节）")]
    PassphraseTooLong,
    #[error("无法生成安全随机数：{0}")]
    Random(String),
    #[error("密钥参数无效：{0}")]
    InvalidParams(String),
    #[error("加密失败：系统未返回密文")]
    EncryptFailed,
    #[error("{UNLOCK_FAILED_MESSAGE}")]
    UnlockFailed,
    #[error("解密失败：密钥不匹配或密文已损坏")]
    DecryptFailed,
    #[error("字段不是知行的加密格式")]
    NotEncrypted,
    #[error("密钥版本不匹配：密文由另一份密钥加密")]
    KeyIdMismatch,
    #[error("密钥信封格式无效：{0}")]
    Envelope(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub name: String,
    pub log_n: u8,
    pub r: u32,
    pub p: u32,
    pub salt_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WrappedKey {
    pub nonce_b64: String,
    pub ciphertext_b64: String,
}

/// 存入系统钥匙串的公开信封：盐、KDF 参数与“被口令包裹的主密钥”。
/// 信封本身不是密钥；没有口令无法解出主密钥。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyEnvelope {
    pub version: u32,
    pub algorithm: String,
    pub kdf: KdfParams,
    pub wrapped_key: WrappedKey,
    pub key_id: String,
    pub created_at: String,
}

/// 已解锁的数据密钥。只允许在 Rust 进程内存中存在，不序列化、不写日志。
#[derive(Clone)]
pub struct NoteCipher {
    key: Zeroizing<[u8; MASTER_KEY_LEN]>,
    key_id: String,
}

impl std::fmt::Debug for NoteCipher {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NoteCipher")
            .field("key_id", &self.key_id)
            .field("key", &"[redacted]")
            .finish()
    }
}

impl NoteCipher {
    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    /// `context` 必须稳定且唯一，例如 `note:<id>:title`、`block:<id>:payload`。
    pub fn encrypt_text(&self, context: &str, plaintext: &str) -> Result<String, CryptoError> {
        let nonce = random_bytes::<NONCE_LEN>()?;
        let aad = field_aad(&self.key_id, context);
        let cipher = XChaCha20Poly1305::new_from_slice(self.key.as_ref())
            .map_err(|_| CryptoError::InvalidParams("主密钥长度无效".to_string()))?;
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| CryptoError::EncryptFailed)?;
        let mut sealed = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        sealed.extend_from_slice(&nonce);
        sealed.extend_from_slice(&ciphertext);
        Ok(format!(
            "{CIPHERTEXT_PREFIX}{}:{}",
            self.key_id,
            URL_SAFE_NO_PAD.encode(sealed)
        ))
    }

    pub fn decrypt_text(&self, context: &str, value: &str) -> Result<String, CryptoError> {
        let rest = value
            .strip_prefix(CIPHERTEXT_PREFIX)
            .ok_or(CryptoError::NotEncrypted)?;
        let (key_id, payload) = rest.split_once(':').ok_or(CryptoError::NotEncrypted)?;
        if key_id != self.key_id {
            return Err(CryptoError::KeyIdMismatch);
        }
        let sealed = URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| CryptoError::DecryptFailed)?;
        if sealed.len() < NONCE_LEN + 16 {
            return Err(CryptoError::DecryptFailed);
        }
        let (nonce, ciphertext) = sealed.split_at(NONCE_LEN);
        let aad = field_aad(&self.key_id, context);
        let cipher = XChaCha20Poly1305::new_from_slice(self.key.as_ref())
            .map_err(|_| CryptoError::InvalidParams("主密钥长度无效".to_string()))?;
        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| CryptoError::DecryptFailed)?;
        String::from_utf8(plaintext).map_err(|_| CryptoError::DecryptFailed)
    }
}

pub fn is_ciphertext(value: &str) -> bool {
    value.starts_with(CIPHERTEXT_PREFIX)
}

/// AAD 上下文命名必须与仓储层完全一致；不要把用户输入拼进来。
pub fn note_field_context(note_id: &str, field: &str) -> String {
    format!("note:{note_id}:{field}")
}

pub fn block_field_context(block_id: &str, field: &str) -> String {
    format!("block:{block_id}:{field}")
}

pub fn todo_field_context(todo_id: &str, field: &str) -> String {
    format!("todo:{todo_id}:{field}")
}

pub fn validate_passphrase(passphrase: &str) -> Result<(), CryptoError> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(CryptoError::PassphraseTooShort);
    }
    if passphrase.len() > MAX_PASSPHRASE_BYTES {
        return Err(CryptoError::PassphraseTooLong);
    }
    Ok(())
}

/// 生成随机主密钥并返回信封 + 内存中的 `NoteCipher`。
pub fn create_envelope(
    passphrase: &str,
    log_n: u8,
) -> Result<(KeyEnvelope, NoteCipher), CryptoError> {
    validate_passphrase(passphrase)?;
    validate_log_n(log_n)?;

    let master_key = Zeroizing::new(random_bytes::<MASTER_KEY_LEN>()?);
    let key_id = hex_lower(&random_bytes::<KEY_ID_BYTES>()?);
    let salt = random_bytes::<SALT_LEN>()?;
    let nonce = random_bytes::<NONCE_LEN>()?;
    let kek = derive_kek(passphrase, &salt, log_n)?;
    let aad = key_wrap_aad(&key_id);
    let cipher = XChaCha20Poly1305::new_from_slice(kek.as_ref())
        .map_err(|_| CryptoError::InvalidParams("KEK 长度无效".to_string()))?;
    let wrapped = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: master_key.as_ref(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::EncryptFailed)?;

    let envelope = KeyEnvelope {
        version: ENVELOPE_VERSION,
        algorithm: ALGORITHM.to_string(),
        kdf: KdfParams {
            name: "scrypt".to_string(),
            log_n,
            r: SCRYPT_R,
            p: SCRYPT_P,
            salt_b64: URL_SAFE_NO_PAD.encode(salt),
        },
        wrapped_key: WrappedKey {
            nonce_b64: URL_SAFE_NO_PAD.encode(nonce),
            ciphertext_b64: URL_SAFE_NO_PAD.encode(wrapped),
        },
        key_id: key_id.clone(),
        created_at: now_iso(),
    };

    Ok((
        envelope,
        NoteCipher {
            key: master_key,
            key_id,
        },
    ))
}

/// 用口令解出主密钥。错误口令与损坏的信封都返回同一条具体错误，
/// 不区分“口令错”与“密文坏”，避免成为口令探测 oracle。
pub fn unlock_envelope(
    envelope: &KeyEnvelope,
    passphrase: &str,
) -> Result<NoteCipher, CryptoError> {
    validate_envelope(envelope)?;
    validate_passphrase(passphrase)?;
    let salt = URL_SAFE_NO_PAD
        .decode(&envelope.kdf.salt_b64)
        .map_err(|_| CryptoError::Envelope("盐值不是有效 base64".to_string()))?;
    let nonce = URL_SAFE_NO_PAD
        .decode(&envelope.wrapped_key.nonce_b64)
        .map_err(|_| CryptoError::Envelope("nonce 不是有效 base64".to_string()))?;
    let wrapped = URL_SAFE_NO_PAD
        .decode(&envelope.wrapped_key.ciphertext_b64)
        .map_err(|_| CryptoError::Envelope("包裹密钥不是有效 base64".to_string()))?;
    if nonce.len() != NONCE_LEN {
        return Err(CryptoError::Envelope("nonce 长度无效".to_string()));
    }
    if wrapped.len() != MASTER_KEY_LEN + 16 {
        return Err(CryptoError::Envelope("包裹密钥长度无效".to_string()));
    }

    let kek = derive_kek(passphrase, &salt, envelope.kdf.log_n)?;
    let aad = key_wrap_aad(&envelope.key_id);
    let cipher = XChaCha20Poly1305::new_from_slice(kek.as_ref())
        .map_err(|_| CryptoError::InvalidParams("KEK 长度无效".to_string()))?;
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &wrapped,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::UnlockFailed)?;
    if plaintext.len() != MASTER_KEY_LEN {
        return Err(CryptoError::UnlockFailed);
    }
    let mut key = Zeroizing::new([0u8; MASTER_KEY_LEN]);
    key.copy_from_slice(&plaintext);
    Ok(NoteCipher {
        key,
        key_id: envelope.key_id.clone(),
    })
}

/// 更换口令：只重新包裹同一把主密钥，不改动任何笔记密文。
/// 旧口令在新信封写入后立即失效。
pub fn rewrap_envelope(
    envelope: &KeyEnvelope,
    current_passphrase: &str,
    next_passphrase: &str,
    log_n: u8,
) -> Result<(KeyEnvelope, NoteCipher), CryptoError> {
    validate_passphrase(next_passphrase)?;
    validate_log_n(log_n)?;
    let cipher = unlock_envelope(envelope, current_passphrase)?;

    let salt = random_bytes::<SALT_LEN>()?;
    let nonce = random_bytes::<NONCE_LEN>()?;
    let kek = derive_kek(next_passphrase, &salt, log_n)?;
    let aad = key_wrap_aad(&envelope.key_id);
    let wrapper = XChaCha20Poly1305::new_from_slice(kek.as_ref())
        .map_err(|_| CryptoError::InvalidParams("KEK 长度无效".to_string()))?;
    let wrapped = wrapper
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: cipher.key.as_ref(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::EncryptFailed)?;

    let next = KeyEnvelope {
        version: ENVELOPE_VERSION,
        algorithm: ALGORITHM.to_string(),
        kdf: KdfParams {
            name: "scrypt".to_string(),
            log_n,
            r: SCRYPT_R,
            p: SCRYPT_P,
            salt_b64: URL_SAFE_NO_PAD.encode(salt),
        },
        wrapped_key: WrappedKey {
            nonce_b64: URL_SAFE_NO_PAD.encode(nonce),
            ciphertext_b64: URL_SAFE_NO_PAD.encode(wrapped),
        },
        key_id: envelope.key_id.clone(),
        created_at: now_iso(),
    };
    Ok((next, cipher))
}

pub fn envelope_to_json(envelope: &KeyEnvelope) -> Result<String, CryptoError> {
    serde_json::to_string_pretty(envelope)
        .map_err(|error| CryptoError::Envelope(format!("无法序列化：{error}")))
}

pub fn envelope_from_json(raw: &str) -> Result<KeyEnvelope, CryptoError> {
    let envelope: KeyEnvelope = serde_json::from_str(raw)
        .map_err(|error| CryptoError::Envelope(format!("无法解析 JSON：{error}")))?;
    validate_envelope(&envelope)?;
    Ok(envelope)
}

pub fn validate_envelope(envelope: &KeyEnvelope) -> Result<(), CryptoError> {
    if envelope.version != ENVELOPE_VERSION {
        return Err(CryptoError::Envelope(format!(
            "不支持的版本 {}",
            envelope.version
        )));
    }
    if envelope.algorithm != ALGORITHM {
        return Err(CryptoError::Envelope("不支持的加密算法".to_string()));
    }
    if envelope.kdf.name != "scrypt" {
        return Err(CryptoError::Envelope("不支持的 KDF".to_string()));
    }
    if envelope.kdf.r != SCRYPT_R || envelope.kdf.p != SCRYPT_P {
        return Err(CryptoError::Envelope("scrypt 参数不匹配".to_string()));
    }
    validate_log_n(envelope.kdf.log_n)?;
    let salt = URL_SAFE_NO_PAD
        .decode(&envelope.kdf.salt_b64)
        .map_err(|_| CryptoError::Envelope("盐值不是有效 base64".to_string()))?;
    if salt.len() != SALT_LEN {
        return Err(CryptoError::Envelope("盐值长度无效".to_string()));
    }
    if envelope.key_id.is_empty()
        || envelope.key_id.len() > 64
        || !envelope
            .key_id
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() || ch == '-')
    {
        return Err(CryptoError::Envelope("keyId 无效".to_string()));
    }
    Ok(())
}

fn validate_log_n(log_n: u8) -> Result<(), CryptoError> {
    if !(MIN_LOG_N..=MAX_LOG_N).contains(&log_n) {
        return Err(CryptoError::InvalidParams(format!(
            "scrypt logN 必须在 {MIN_LOG_N}..={MAX_LOG_N}"
        )));
    }
    Ok(())
}

fn derive_kek(
    passphrase: &str,
    salt: &[u8],
    log_n: u8,
) -> Result<Zeroizing<[u8; MASTER_KEY_LEN]>, CryptoError> {
    let params = ScryptParams::new(log_n, SCRYPT_R, SCRYPT_P, MASTER_KEY_LEN)
        .map_err(|error| CryptoError::InvalidParams(error.to_string()))?;
    let mut output = Zeroizing::new([0u8; MASTER_KEY_LEN]);
    scrypt(passphrase.as_bytes(), salt, &params, output.as_mut())
        .map_err(|error| CryptoError::InvalidParams(error.to_string()))?;
    Ok(output)
}

fn random_bytes<const N: usize>() -> Result<[u8; N], CryptoError> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|error| CryptoError::Random(error.to_string()))?;
    Ok(bytes)
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn key_wrap_aad(key_id: &str) -> String {
    format!("{KEY_WRAP_AAD_PREFIX}{key_id}")
}

fn field_aad(key_id: &str, context: &str) -> String {
    format!("{FIELD_AAD_PREFIX}{key_id}:{context}")
}

fn now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}Z", now.as_secs(), now.subsec_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_LOG_N: u8 = 14;
    const PASSPHRASE: &str = "correct horse battery staple";
    const OTHER_PASSPHRASE: &str = "another correct horse battery";

    fn new_cipher() -> (KeyEnvelope, NoteCipher) {
        create_envelope(PASSPHRASE, TEST_LOG_N).expect("create envelope")
    }

    #[test]
    fn encrypt_decrypt_round_trip_and_tamper_detection() {
        let (_envelope, cipher) = new_cipher();
        let context = "note:note-a:body";
        let sealed = cipher
            .encrypt_text(context, "<p>机密正文</p>")
            .expect("encrypt");
        assert!(sealed.starts_with(CIPHERTEXT_PREFIX));
        assert!(!sealed.contains("机密"));
        assert_eq!(
            cipher.decrypt_text(context, &sealed).expect("decrypt"),
            "<p>机密正文</p>"
        );

        // 换字段/换笔记 context 必须失败，密文不能横向搬运。
        assert!(matches!(
            cipher.decrypt_text("note:note-b:body", &sealed),
            Err(CryptoError::DecryptFailed)
        ));

        // 翻转密文最后一个字符（base64 有效范围内）必须失败。
        let mut tampered = sealed.clone();
        let last = tampered.pop().expect("non-empty");
        let replacement = if last == 'A' { 'B' } else { 'A' };
        tampered.push(replacement);
        assert!(matches!(
            cipher.decrypt_text(context, &tampered),
            Err(CryptoError::DecryptFailed)
        ));
    }

    #[test]
    fn wrong_passphrase_reports_specific_unlock_error() {
        let (envelope, _cipher) = new_cipher();
        let error = unlock_envelope(&envelope, OTHER_PASSPHRASE).expect_err("wrong passphrase");
        assert!(matches!(error, CryptoError::UnlockFailed));
        assert_eq!(error.to_string(), UNLOCK_FAILED_MESSAGE);

        let unlocked = unlock_envelope(&envelope, PASSPHRASE).expect("correct passphrase");
        assert_eq!(unlocked.key_id(), envelope.key_id);
    }

    #[test]
    fn ciphertext_from_another_key_is_rejected() {
        let (_envelope_a, cipher_a) = new_cipher();
        let (_envelope_b, cipher_b) = create_envelope(OTHER_PASSPHRASE, TEST_LOG_N).expect("b");
        let sealed = cipher_a.encrypt_text("note:n:title", "标题").expect("encrypt");
        assert!(matches!(
            cipher_b.decrypt_text("note:n:title", &sealed),
            Err(CryptoError::KeyIdMismatch)
        ));
    }

    #[test]
    fn rewrap_keeps_master_key_and_invalidates_old_passphrase() {
        let (envelope, cipher) = new_cipher();
        let sealed = cipher
            .encrypt_text("note:n:body", "正文")
            .expect("encrypt");
        let (next_envelope, next_cipher) =
            rewrap_envelope(&envelope, PASSPHRASE, OTHER_PASSPHRASE, TEST_LOG_N).expect("rewrap");

        assert_eq!(next_envelope.key_id, envelope.key_id);
        assert!(matches!(
            unlock_envelope(&envelope, OTHER_PASSPHRASE),
            Err(CryptoError::UnlockFailed)
        ));
        let unlocked = unlock_envelope(&next_envelope, OTHER_PASSPHRASE).expect("new passphrase");
        assert_eq!(
            unlocked.decrypt_text("note:n:body", &sealed).expect("decrypt"),
            "正文"
        );
        assert!(matches!(
            unlock_envelope(&next_envelope, PASSPHRASE),
            Err(CryptoError::UnlockFailed)
        ));
        let _ = next_cipher;
    }

    #[test]
    fn envelope_json_round_trip_and_weak_params_rejected() {
        let (envelope, _cipher) = new_cipher();
        let json = envelope_to_json(&envelope).expect("serialize");
        let parsed = envelope_from_json(&json).expect("parse");
        assert_eq!(parsed, envelope);

        let mut weak = envelope.clone();
        weak.kdf.log_n = 10;
        assert!(matches!(
            validate_envelope(&weak),
            Err(CryptoError::InvalidParams(_))
        ));
    }

    #[test]
    fn passphrase_policy_is_enforced() {
        assert!(matches!(
            create_envelope("short", TEST_LOG_N),
            Err(CryptoError::PassphraseTooShort)
        ));
        let long = "x".repeat(MAX_PASSPHRASE_BYTES + 1);
        assert!(matches!(
            create_envelope(&long, TEST_LOG_N),
            Err(CryptoError::PassphraseTooLong)
        ));
    }
}
