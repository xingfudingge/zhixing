# ADR：笔记内容加密（ZX11-PRIVACY-ENC-01）

- 状态：已实现（v1）
- 日期：2026-11-01
- 上游审计：`outputs/设置模块-全量盘点与上游参考-2026-11-01.md`（F-04/F-05、P2-25）
- 相关代码：`app/src-tauri/src/note_crypto.rs`、`note_encryption.rs`、`repositories/note_encryption.rs`、
  `migrations/0006_note_encryption.sql`、`app/src/features/settings/groups/PrivacyGroup.tsx`

## 1. 问题与威胁模型

要保护的是**本机 SQLite 文件、迁移副本与完整备份被拷走后的笔记内容**。威胁模型：

- 覆盖：拿到 `zhixing.db` / `.bak` / ZIP 备份但没有用户口令的人；
- 覆盖：应用锁定/重启后，进程内存中没有明文主密钥；
- 不覆盖：已登录桌面会话中的恶意进程、键盘记录、屏幕录制；
- 不覆盖：笔记 id、目录、状态、收藏/置顶、时间戳、附件文件名等导航元数据；
- 不覆盖：附件二进制与 OCR 文本（见 §5 边界）。

这不是“防截屏”或“防已控制设备”的承诺，UI 文案已明确。

## 2. 上游实现与许可证

先读上游再实现，不自行发明密码算法：

| 上游 | 采用点 | 许可证 |
|---|---|---|
| [age 规范](https://age-encryption.org/v1) / FiloSottile/age | 口令 KDF 用 scrypt，参数族 `N=2^workFactor, r=8, p=1, dkLen=32`；age 默认 workFactor=18 | BSD-3-Clause（仅参考格式，不复制代码） |
| [RFC 7914 scrypt](https://www.rfc-editor.org/rfc/rfc7914) / RustCrypto `scrypt` 0.11 | 口令 → KEK，`logN=17`（128 MiB），盐 16 字节 | MIT OR Apache-2.0 |
| [RFC 8439](https://www.rfc-editor.org/rfc/rfc8439) / RustCrypto `chacha20poly1305` 0.10 | 字段与主密钥包裹使用 XChaCha20-Poly1305，24 字节随机 nonce | MIT OR Apache-2.0 |
| [keyring-rs](https://github.com/hwchen/keyring-rs) 3.6 | macOS Keychain / Windows Credential Manager / Linux Secret Service | MIT OR Apache-2.0 |
| Tauri 2 | `app_data_dir`、命令 IPC、状态管理 | MIT OR Apache-2.0 |
| SQLCipher | 评估后不采用（见 §3） | BSD-style（未引入依赖） |

**未引入 GPL/AGPL 代码**；OpenList/Alist 仍只作为 WebDAV 兼容目标。

## 3. 决策：逐字段 AEAD，而不是 SQLCipher

评估过三条路：

1. **整库 SQLCipher**：需要把 `rusqlite` 的 bundled SQLite 换成 SQLCipher，改动 C 构建、迁移回滚、
   `VACUUM INTO` 备份、CLI 与测试工具链；一旦密钥丢失，整库（包括任务/日历）不可用。
   与“只加密笔记内容、其他模块照常可用”的产品边界不匹配，本卡不采用。
2. **单篇 age 文件**：会把笔记搬出 SQLite，破坏现有块投影、搜索、关系、备份事务；不采用。
3. **逐字段 AEAD（采用）**：每篇笔记的标题、正文、标签、每个块 payload、每条笔记待办标题
   独立加密；随机主密钥只驻留内存，口令只用于包裹主密钥。数据库结构、任务/日历/画板不受影响，
   锁定/解锁可以精确到笔记内容。

逐字段加密使用稳定 AAD：

```
标题  note:<noteId>:title
正文  note:<noteId>:body
标签  note:<noteId>:tags
块    block:<blockId>:payload
待办  todo:<todoId>:title
```

密文格式 `zxnote:v1:<keyId>:<base64url(nonce||ciphertext)>`。`keyId` 与 AAD 一起绑定，
密文不能跨笔记/跨字段搬运；换 key 后旧密文会被拒绝（`KeyIdMismatch`）。

## 4. 密钥生命周期

1. **创建**：`getrandom` 生成 32 字节主密钥与 8 字节 keyId；生成 16 字节盐；
   `scrypt(口令, 盐, logN=17, r=8, p=1) → 32 字节 KEK`；
   `XChaCha20Poly1305(KEK, nonce=24B, AAD=zx-note-key:v1:<keyId>)` 包裹主密钥。
2. **存储**：只把“公开信封”（盐、KDF 参数、nonce、包裹后的主密钥、keyId）
   写入系统钥匙串：service `com.zhixing.desktop`，account `note-encryption-v1`。
   钥匙串不可用时回退到应用数据目录 `note-encryption-envelope.json`，Unix 权限 0600。
   **明文主密钥、KEK、口令从不落盘、不写日志、不进 localStorage/设置表。**
3. **锁定**：清空内存中的 `NoteCipher`；`zeroize` 在 drop 时清零。列表/读取返回
   `locked=true` 与空内容；写命令直接拒绝。
4. **解锁**：口令 → KEK → 解开主密钥；口令错误与信封损坏统一返回
   “解锁失败：口令错误或密钥数据损坏”，不区分以避免口令探测 oracle。
5. **更换口令**：只重新包裹同一把主密钥（新盐/新 nonce），不改任何笔记密文；旧口令立即失效。
6. **关闭加密**：在事务中解密全部内容，提交后删除钥匙串/文件信封；删除失败会报告
   `warning`，不伪装成功。
7. **备份/恢复**：完整备份保存密文，不包含明文密钥；用户可在设置中导出受口令保护的
   信封文件，在新设备导入后输入同一口令解锁。

## 5. 兼容性边界（必须与 UI 文案一致）

| 能力 | 加密开启后的行为 |
|---|---|
| 列表/读取（已解锁） | 解密后返回明文；`encrypted=true, locked=false` |
| 列表/读取（已锁定） | `title/body/tags` 为空，`locked=true`；编辑器不挂载，避免空正文覆盖密文 |
| 编辑/新建块/待办 | 已解锁时加密写入；锁定时后端返回具体错误 |
| 搜索 | SQL 不能 LIKE 密文；在 Rust 中解密后对标题/正文/标签过滤。锁定笔记不参与内容搜索 |
| 导出 Markdown/Word/PDF/笔记包 | 锁定时拒绝；解锁后导出明文（用户显式操作） |
| 完整备份 ZIP/JSON | 使用 `notes_export_rows` 等原始导出命令，保存密文与 `encryptedTagsJson`/`encryptedPayloadJson`；不含明文密钥 |
| 恢复 | 备份含加密行时，本机必须有信封；没有信封会明确拒绝，避免把密文当明文写坏 |
| OCR | 加密开启时 `OcrService.enqueue/processJob/processAll` 拒绝，避免 OCR 文本落在 SQLite 之外的 IndexedDB 明文；测试识别不写库 |
| 笔记附件 | 附件二进制/OCR 文本不在 SQLite 边界内；开启加密前若有笔记附件，后端拒绝并给出数量 |
| 画板/任务/日历 | 不受影响；但与笔记正文重复的内容不在本卡加密边界内 |
| 同步 | 本卡不改同步协议；密文按普通文本同步，对方没有信封时显示锁定 |

## 6. 迁移与回滚

`0006_note_encryption.sql` 只加列与元数据表，不改写现有内容：

- `notes.encrypted`、`notes.encrypted_tags_json`；
- `note_blocks.encrypted`、`note_blocks.encrypted_payload_json`；
- `note_todos.encrypted`；
- `note_encryption_meta(id=1, enabled, key_id)`。

原 `tags_json`/`payload_json` 有 `json_valid` CHECK，所以加密时原列写合法空 JSON，
密文放旁路列；关闭加密时再写回。迁移前 `db.rs` 仍会 `VACUUM INTO` 生成 `.pre-0006.*.bak`。
开启/关闭加密都在单事务内完成：任何一篇失败整体回滚，不会出现半明文半密文。

回滚路径：关闭加密 → 全部解密并删除信封；或恢复 `.pre-0006` 备份。

## 7. 已知限制 / 后续

- 附件二进制未加密；开启加密前要求先删除笔记附件。
- OCR 文本在加密期间不可入队；已有 OCR 文本不会自动清除，用户可在 OCR 面板清理。
- 元数据（目录、时间、收藏、附件名）仍是明文。
- 没有硬件密钥/生物识别绑定；钥匙串访问控制由操作系统账户决定。
- 未验证 Windows/Linux 真机钥匙串；macOS 开发构建使用文件回退时会在状态中显示 `file`。

## 8. 验收命令

```sh
pnpm --filter app exec vitest run src/features/settings/__tests__/PrivacyGroup.test.tsx
pnpm --filter app test
pnpm --filter app typecheck
cd app/src-tauri && cargo test --lib note_crypto note_encryption
cd app/src-tauri && cargo test
```

关键测试：

- `note_crypto::tests::*`：真实 scrypt/XChaCha 往返、错误口令、篡改、跨 keyId、换口令；
- `note_encryption::tests::enable_lock_unlock_disable_round_trip`：真实库开启/锁定/解锁/关闭；
- `repositories::notes::tests::encrypted_note_lock_unlock_search_and_raw_export`：
  锁定不可读、正确口令恢复、错误口令报具体错误、搜索与原始备份；
- `PrivacyGroup.test.tsx`：诊断默认关闭/清除、加密开关与锁定入口、附件边界。
