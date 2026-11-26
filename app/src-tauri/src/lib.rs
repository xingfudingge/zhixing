pub mod db;
pub mod http;
mod menu;
pub mod note_crypto;
pub mod note_encryption;
pub mod ocr;
pub mod privacy;
pub mod repositories;

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellReady {
    version: String,
    route: String,
}

/// 把任意展示名收敛成单个文件名：去目录、去控制字符，并限制长度。
///
/// 只做展示/落盘文件名，不用于拼接业务路径；调用方始终显式 join 自己的目录。
fn sanitize_file_name(file_name: &str) -> String {
    // 同时按 Unix / Windows 分隔符取最后一段，避免平台差异造成路径穿越。
    let normalized = file_name.replace('\\', "/");
    let raw_name = normalized.rsplit('/').next().unwrap_or("zhixing-file");
    let safe_name: String = raw_name
        .chars()
        .map(|ch| if ch.is_control() { '_' } else { ch })
        .take(120)
        .collect();
    let safe_name = safe_name.trim();
    if safe_name.is_empty() || safe_name == "." || safe_name == ".." {
        "zhixing-file".to_string()
    } else {
        safe_name.to_string()
    }
}

/// 在保留扩展名的前提下生成 `name-1.ext`、`name-2.ext`，从 1 开始。
fn numbered_path(path: &Path, index: u32) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("zhixing-file");
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!(".{ext}"))
        .unwrap_or_default();
    path.with_file_name(format!("{stem}-{index}{extension}"))
}

/// 以 `create_new` 写入，绝不覆盖已有文件；重名时自动追加序号。
///
/// 使用 `create_new` 而不是先 `exists()` 再写，避免两个并发保存同时判定
/// “不存在”后互相覆盖。返回真正写入的路径。
fn write_bytes_no_overwrite(path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    for index in 0..10_000 {
        let candidate = if index == 0 {
            path.to_path_buf()
        } else {
            numbered_path(path, index)
        };
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                file.write_all(bytes)
                    .map_err(|error| format!("写入文件失败：{error}"))?;
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建文件：{error}")),
        }
    }
    Err("同一目录下同名文件过多，无法生成不重复的文件名".to_string())
}

/// 导出目录不可用时，告诉用户下一步能做什么。
fn export_directory_hint() -> &'static str {
    "请在「设置 → 数据与备份」中重新选择默认导出目录，或清除默认目录后每次手动选择。"
}

/// 把目录相关的 IO 错误收敛成可恢复的提示，而不是让用户看到裸 errno。
fn directory_io_error(context: &str, path: &Path, error: &std::io::Error) -> String {
    let hint = export_directory_hint();
    match error.kind() {
        std::io::ErrorKind::NotFound => {
            format!("{context}：{} 不存在。{hint}", path.display())
        }
        std::io::ErrorKind::PermissionDenied => {
            format!("{context}：{} 没有写入权限。{hint}", path.display())
        }
        _ => format!("{context}：{}（{error}）。{hint}", path.display()),
    }
}

/// 目录不存在、不是目录或不可写时直接失败，绝不自动创建或回退到
/// Downloads/Documents。
fn validate_export_directory(directory: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(raw) = directory.map(str::trim).filter(|value| !value.is_empty()) else {
        // None/空字符串 = 不预设目录：保存面板使用系统上次位置。
        return Ok(None);
    };
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!(
            "默认导出目录必须是绝对路径：{raw}。{}",
            export_directory_hint()
        ));
    }
    match fs::metadata(&path) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(format!(
                "默认导出目录不是文件夹：{}。{}",
                path.display(),
                export_directory_hint()
            ));
        }
        Err(error) => {
            return Err(directory_io_error("默认导出目录不可用", &path, &error));
        }
    }
    ensure_directory_writable(&path)?;
    Ok(Some(path))
}

/// 写一个唯一探针文件再删除，确认目录真的可写（仅看权限位并不可靠）。
fn ensure_directory_writable(directory: &Path) -> Result<(), String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let probe = directory.join(format!(
        ".zhixing-write-check-{}-{stamp}",
        std::process::id()
    ));
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            Ok(())
        }
        Err(error) => Err(directory_io_error(
            "默认导出目录不可写",
            directory,
            &error,
        )),
    }
}

/// 统一的保存面板：默认目录只在用户设置过时传入，绝不静默指定
/// Documents/Downloads；用户取消返回 `None`，不创建任何文件。
async fn save_bytes_with_dialog(
    app: &tauri::AppHandle,
    file_name: &str,
    bytes: &[u8],
    directory: Option<String>,
    kind: &str,
    log_label: &str,
) -> Result<Option<String>, String> {
    let start_directory = validate_export_directory(directory.as_deref())?;
    let mut builder = app.dialog().file().set_file_name(file_name);
    match kind {
        "png" => {
            builder = builder.add_filter("PNG 图片", &["png"]);
        }
        "json" => {
            builder = builder.add_filter("画板 JSON", &["json"]);
        }
        _ => {}
    }
    if let Some(directory) = start_directory {
        builder = builder.set_directory(directory);
    }

    // 命令运行在异步线程，blocking_save_file 内部会调度到主线程。
    let Some(chosen) = builder.blocking_save_file() else {
        log::info!("{log_label} canceled: {file_name}");
        return Ok(None);
    };
    let chosen = chosen.into_path().map_err(|error| {
        format!("保存位置不可用：{error}。请重新打开保存面板并选择可写的位置。")
    })?;
    let path = write_bytes_no_overwrite(&chosen, bytes)?;
    log::info!("{log_label} saved: {}", path.display());
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// 让用户选择默认导出目录。
///
/// 取消返回 `None` 且不改设置；选择后立即做存在/目录/可写校验，避免把
/// 一个下次无法写入的路径记进设备设置。
#[tauri::command]
async fn pick_export_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    // blocking_pick_folder 内部会调度到主线程；本命令运行在异步线程。
    let Some(chosen) = app.dialog().file().blocking_pick_folder() else {
        log::info!("export directory picker canceled");
        return Ok(None);
    };
    let chosen = chosen
        .into_path()
        .map_err(|error| format!("所选目录不可用：{error}。请重新选择。"))?;
    let raw = chosen.to_string_lossy().into_owned();
    let validated = validate_export_directory(Some(&raw))?
        .ok_or_else(|| "未选择有效的导出目录，请重新选择。".to_string())?;
    log::info!("export directory selected: {}", validated.display());
    Ok(Some(validated.to_string_lossy().into_owned()))
}

/// 导出文件落点：桌面壳写应用数据目录，避免 WebView 默认落到 Downloads。
/// 同名时追加序号，不覆盖已有导出。
#[tauri::command]
fn save_export_file(
    app: tauri::AppHandle,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join("exports");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建导出目录：{error}"))?;

    let safe_name = sanitize_file_name(&file_name);
    let path = write_bytes_no_overwrite(&dir.join(&safe_name), &bytes)?;
    log::info!("export written: {}", path.display());
    Ok(path.to_string_lossy().into_owned())
}

/// 用系统默认应用打开本机附件。
///
/// 二进制先写入应用缓存目录（按 SHA-256 前缀隔离），再由 `open` 交给
/// 系统默认应用；返回的路径仅用于界面提示/日志，不写回附件元数据。
/// 这样“打开”不会退化成下载，也不会把 Downloads 当成默认落点。
#[tauri::command]
fn open_attachment_file(
    app: tauri::AppHandle,
    file_name: String,
    bytes: Vec<u8>,
    sha256: Option<String>,
) -> Result<String, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法定位应用缓存目录：{error}"))?
        .join("attachment-open");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建附件缓存目录：{error}"))?;

    let safe_name = sanitize_file_name(&file_name);
    let token = sha256
        .as_deref()
        .filter(|value| value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit()))
        .map(|value| &value[..16])
        .unwrap_or("nohash");
    let path = dir.join(format!("{token}-{safe_name}"));
    // 缓存文件由应用管理且按内容哈希命名，重复打开同一附件直接复用。
    fs::write(&path, bytes).map_err(|error| format!("无法写入附件缓存：{error}"))?;

    open::that(&path).map_err(|error| {
        format!(
            "无法用系统默认应用打开「{}」：{error}。请检查本机是否有可打开该格式的应用。",
            safe_name
        )
    })?;
    log::info!("attachment opened: {}", path.display());
    Ok(path.to_string_lossy().into_owned())
}

/// 通过用户可见的保存面板另存附件。
///
/// - `directory` 只来自设备设置中的默认导出目录；`None` 时不调用
///   `set_directory`，由系统保存面板使用上次位置；
/// - 取消返回 `None`，不写任何文件；
/// - 用户选中的文件已存在时追加序号，**不覆盖**原文件。
#[tauri::command]
async fn save_attachment_file(
    app: tauri::AppHandle,
    file_name: String,
    bytes: Vec<u8>,
    directory: Option<String>,
) -> Result<Option<String>, String> {
    let safe_name = sanitize_file_name(&file_name);
    save_bytes_with_dialog(&app, &safe_name, &bytes, directory, "attachment", "attachment").await
}

/// 画板导出文件名：去掉路径/控制字符，并确保扩展名与格式一致。
fn with_export_extension(file_name: &str, extension: &str) -> String {
    let safe_name = sanitize_file_name(file_name);
    if safe_name
        .to_ascii_lowercase()
        .ends_with(&format!(".{extension}"))
    {
        safe_name
    } else {
        format!("{safe_name}.{extension}")
    }
}

/// 画板 PNG 文件名：确保以 `.png` 结尾。
fn png_export_file_name(file_name: &str) -> String {
    with_export_extension(file_name, "png")
}

/// 画板 JSON 文件名：确保以 `.json` 结尾。
fn json_export_file_name(file_name: &str) -> String {
    with_export_extension(file_name, "json")
}

/// 画板 PNG / JSON 另存：统一保存面板 + 对应格式过滤器。
///
/// - `directory` 只来自设备设置中的默认导出目录；`None` 时使用系统上次位置；
/// - `kind` 缺省为 `png`，保持旧版 PNG 调用兼容；
/// - 取消返回 `None`，不写任何文件；
/// - 重名时追加序号，不覆盖已有文件。
#[tauri::command]
async fn save_board_export_file(
    app: tauri::AppHandle,
    file_name: String,
    bytes: Vec<u8>,
    directory: Option<String>,
    kind: Option<String>,
) -> Result<Option<String>, String> {
    if bytes.is_empty() {
        return Err("导出内容为空，未写入文件".to_string());
    }
    let is_json = kind.as_deref() == Some("json");
    let safe_name = if is_json {
        json_export_file_name(&file_name)
    } else {
        png_export_file_name(&file_name)
    };
    save_bytes_with_dialog(
        &app,
        &safe_name,
        &bytes,
        directory,
        if is_json { "json" } else { "png" },
        if is_json { "board json export" } else { "board export" },
    )
    .await
}

/// 前端完成首屏挂载后回调，用于确认 WebView、IPC 与日志链路可用。
#[tauri::command]
fn shell_ready(route: String) -> ShellReady {
    log::info!("frontend shell ready: route={route}");
    ShellReady {
        version: env!("CARGO_PKG_VERSION").to_string(),
        route,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("zhixing".to_string()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            log::info!(
                "zhixing desktop shell starting: version={} platform={} arch={}",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH
            );

            let database_state = db::init(app.handle());
            let database_status = database_state.status();
            log::info!(
                "database status: ready={} schema_version={} journal_mode={} error={:?}",
                database_status.ready,
                database_status.schema_version,
                database_status.journal_mode,
                database_status.error
            );
            app.manage(database_state);
            // 笔记加密密钥状态：启动时锁定，只加载公开信封；主密钥在用户解锁后进入内存。
            let encryption_state = note_encryption::NoteEncryptionState::init(app.handle());
            // 0007 升级/上次清理中断：启动时补做 VACUUM，移除旧版本留下的明文空闲页。
            if let Ok(connection) = app.state::<db::DbState>().connection() {
                encryption_state.run_startup_maintenance(&connection);
            }
            app.manage(encryption_state);

            menu::install(app)?;
            // 系统锁屏：通知前端立即遮挡，解锁不自动揭开。
            privacy::install_screen_lock_watcher(app.handle());

            if let Some(window) = app.get_webview_window("main") {
                window.set_title("知行")?;
                log::info!("main window ready: label=main title=知行");
            } else {
                log::warn!("main window not found during setup");
            }

            log::info!("zhixing desktop shell setup complete");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::db_status,
            db::db_migrate,
            // 业务数据重置（清空业务表 + 重新执行种子，保留偏好）
            repositories::reset::db_reset_domain,
            shell_ready,
            // 受限 HTTP 传输：ICS 只读订阅（CSP/CORS 下的条件请求）
            http::http_fetch_text,
            save_export_file,
            // 默认导出目录：用户主动选择，取消不改设置
            pick_export_directory,
            // 附件本机文件链路：保存面板另存 / 系统默认应用打开
            save_attachment_file,
            open_attachment_file,
            // 画板 PNG 导出：统一保存面板 + PNG 过滤器
            save_board_export_file,
            // 原生 OCR：macOS Apple Vision；无 Tauri/非 macOS 时明确不可用
            ocr::ocr_capability,
            ocr::ocr_probe,
            ocr::ocr_recognize,
            // 笔记内容加密：钥匙串信封、锁定/解锁、导出/导入信封
            note_encryption::note_encryption_status,
            note_encryption::note_encryption_enable,
            note_encryption::note_encryption_unlock,
            note_encryption::note_encryption_lock,
            note_encryption::note_encryption_change_passphrase,
            note_encryption::note_encryption_disable,
            note_encryption::note_encryption_export_envelope,
            note_encryption::note_encryption_import_envelope,
            // 任务清单
            repositories::lists::lists_list,
            repositories::lists::lists_get,
            repositories::lists::lists_create,
            repositories::lists::lists_update,
            repositories::lists::lists_move,
            repositories::lists::lists_delete,
            // 任务与子任务
            repositories::tasks::tasks_list,
            repositories::tasks::tasks_get,
            repositories::tasks::tasks_create,
            repositories::tasks::tasks_update,
            repositories::tasks::tasks_complete,
            repositories::tasks::tasks_delete,
            repositories::tasks::tasks_restore,
            repositories::tasks::subtasks_list,
            repositories::tasks::subtasks_create,
            repositories::tasks::subtasks_update,
            repositories::tasks::subtasks_delete,
            // 笔记、块投影与笔记待办
            repositories::notes::notes_list,
            repositories::notes::notes_get,
            repositories::notes::notes_create,
            repositories::notes::notes_import,
            repositories::notes::notes_update,
            repositories::notes::notes_delete,
            repositories::notes::notes_restore,
            repositories::notes::note_blocks_list,
            repositories::notes::note_blocks_create,
            repositories::notes::note_blocks_update,
            repositories::notes::note_blocks_delete,
            // 完整备份专用：原样导出密文行，不接触明文密钥
            repositories::notes::notes_export_rows,
            repositories::notes::note_blocks_export_rows,
            repositories::note_todos::note_todos_export_rows,
            repositories::note_todos::note_todos_list,
            repositories::note_todos::note_todos_create,
            repositories::note_todos::note_todos_update,
            repositories::note_todos::note_todos_delete,
            // 时间
            repositories::events::events_list,
            repositories::events::events_get,
            repositories::events::events_create,
            repositories::events::events_update,
            repositories::events::events_delete,
            repositories::countdowns::countdowns_list,
            repositories::countdowns::countdowns_get,
            repositories::countdowns::countdowns_create,
            repositories::countdowns::countdowns_update,
            repositories::countdowns::countdowns_delete,
            // 习惯与打卡
            repositories::habits::habits_list,
            repositories::habits::habits_get,
            repositories::habits::habits_create,
            repositories::habits::habits_update,
            repositories::habits::habits_delete,
            repositories::habits::habit_logs_list,
            repositories::habits::habit_logs_set,
            repositories::habits::habit_logs_delete,
            // 专注
            repositories::focus_sessions::focus_sessions_list,
            repositories::focus_sessions::focus_sessions_get,
            repositories::focus_sessions::focus_sessions_create,
            repositories::focus_sessions::focus_sessions_update,
            repositories::focus_sessions::focus_sessions_delete,
            // 复盘快照
            repositories::review_snapshots::review_snapshots_list,
            repositories::review_snapshots::review_snapshots_get,
            repositories::review_snapshots::review_snapshots_get_by_range,
            repositories::review_snapshots::review_snapshots_save,
            // 画板
            repositories::boards::boards_list,
            repositories::boards::boards_get,
            repositories::boards::boards_create,
            repositories::boards::boards_update,
            repositories::boards::boards_delete,
            repositories::boards::board_nodes_list,
            repositories::boards::board_nodes_create,
            repositories::boards::board_nodes_update,
            repositories::boards::board_nodes_delete,
            repositories::boards::board_edges_list,
            repositories::boards::board_edges_create,
            repositories::boards::board_edges_update,
            repositories::boards::board_edges_delete,
            // 附件与设置
            repositories::attachments::attachments_list,
            repositories::attachments::attachments_get,
            repositories::attachments::attachments_create,
            repositories::attachments::attachments_update,
            repositories::attachments::attachments_delete,
            repositories::settings::settings_list,
            repositories::settings::settings_get,
            repositories::settings::settings_set,
            repositories::settings::settings_delete
        ]);

    if let Err(error) = builder.run(tauri::generate_context!()) {
        log::error!("zhixing desktop shell failed to run: {error}");
        eprintln!("zhixing desktop shell failed to run: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod file_action_tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("create temp dir")
    }

    #[test]
    fn sanitize_file_name_removes_directories_and_control_chars() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("方案\u{0000}一.pdf"), "方案_一.pdf");
        assert_eq!(sanitize_file_name("  "), "zhixing-file");
        assert_eq!(sanitize_file_name(".."), "zhixing-file");
        assert_eq!(sanitize_file_name("a/b\\c.txt"), "c.txt");
    }

    #[test]
    fn write_bytes_no_overwrite_appends_suffix_instead_of_replacing() {
        let dir = temp_dir();
        let target = dir.path().join("报告.pdf");

        let first = write_bytes_no_overwrite(&target, b"first").expect("write first");
        assert_eq!(first, target);
        assert_eq!(fs::read(&target).expect("read first"), b"first");

        let second = write_bytes_no_overwrite(&target, b"second").expect("write second");
        assert_eq!(second, dir.path().join("报告-1.pdf"));
        assert_eq!(fs::read(&second).expect("read second"), b"second");
        // 原文件内容保持不变，证明没有覆盖。
        assert_eq!(fs::read(&target).expect("read original"), b"first");

        let third = write_bytes_no_overwrite(&target, b"third").expect("write third");
        assert_eq!(third, dir.path().join("报告-2.pdf"));
    }

    #[test]
    fn write_bytes_no_overwrite_keeps_extension_when_numbering() {
        let dir = temp_dir();
        let target = dir.path().join("archive.tar.gz");
        write_bytes_no_overwrite(&target, b"one").expect("write one");
        let next = write_bytes_no_overwrite(&target, b"two").expect("write two");
        assert_eq!(next, dir.path().join("archive.tar-1.gz"));
    }

    #[test]
    fn numbered_path_handles_names_without_extension() {
        let path = Path::new("/tmp/README");
        assert_eq!(numbered_path(path, 3), PathBuf::from("/tmp/README-3"));
    }

    #[test]
    fn png_export_file_name_forces_png_extension() {
        assert_eq!(png_export_file_name("画板.png"), "画板.png");
        assert_eq!(png_export_file_name("画板.PNG"), "画板.PNG");
        assert_eq!(png_export_file_name("画板"), "画板.png");
        assert_eq!(png_export_file_name("../../etc/passwd"), "passwd.png");
        assert_eq!(png_export_file_name("  "), "zhixing-file.png");
    }

    #[test]
    fn json_export_file_name_forces_json_extension() {
        assert_eq!(json_export_file_name("画板.json"), "画板.json");
        assert_eq!(json_export_file_name("画板.JSON"), "画板.JSON");
        assert_eq!(json_export_file_name("画板"), "画板.json");
        assert_eq!(json_export_file_name("../../etc/passwd"), "passwd.json");
        assert_eq!(json_export_file_name("  "), "zhixing-file.json");
    }

    // -----------------------------------------------------------------------
    // ZX-EXPORT-06：默认导出目录
    // -----------------------------------------------------------------------

    #[test]
    fn no_export_directory_means_no_preset_and_no_fallback() {
        // None/空白都表示“每次询问”；绝不能在这里回退到 Documents/Downloads。
        assert_eq!(validate_export_directory(None).expect("none"), None);
        assert_eq!(
            validate_export_directory(Some("   ")).expect("blank"),
            None
        );
    }

    #[test]
    fn existing_writable_directory_is_used_as_start_directory() {
        let dir = temp_dir();
        let resolved = validate_export_directory(Some(
            dir.path().to_str().expect("utf-8 temp path"),
        ))
        .expect("valid directory");
        assert_eq!(resolved.as_deref(), Some(dir.path()));
        // 探针文件必须清理干净，不能污染用户目录。
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".zhixing-write-check-")
            })
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn missing_directory_returns_recovery_hint() {
        let dir = temp_dir();
        let missing = dir.path().join("removed-directory");
        let message = validate_export_directory(Some(
            missing.to_str().expect("utf-8 temp path"),
        ))
        .expect_err("missing directory must fail");
        assert!(message.contains("不存在"), "{message}");
        assert!(message.contains("重新选择"), "{message}");
        assert!(message.contains("清除默认目录"), "{message}");
    }

    #[test]
    fn file_instead_of_directory_is_rejected() {
        let dir = temp_dir();
        let file = dir.path().join("not-a-directory.txt");
        fs::write(&file, b"x").expect("write file");
        let message = validate_export_directory(Some(
            file.to_str().expect("utf-8 temp path"),
        ))
        .expect_err("file must fail");
        assert!(message.contains("不是文件夹"), "{message}");
        assert!(message.contains("重新选择"), "{message}");
    }

    #[test]
    fn relative_directory_is_rejected_instead_of_resolving_against_cwd() {
        let message = validate_export_directory(Some("relative/exports"))
            .expect_err("relative path must fail");
        assert!(message.contains("绝对路径"), "{message}");
    }

    #[test]
    fn permission_denied_maps_to_actionable_message() {
        let error = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let message = directory_io_error(
            "默认导出目录不可写",
            Path::new("/Users/me/read-only"),
            &error,
        );
        assert!(message.contains("没有写入权限"), "{message}");
        assert!(message.contains("重新选择"), "{message}");
        assert!(message.contains("清除默认目录"), "{message}");
    }

    #[cfg(unix)]
    #[test]
    fn read_only_directory_is_rejected_when_permissions_are_enforced() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_dir();
        let read_only = dir.path().join("read-only");
        fs::create_dir(&read_only).expect("create dir");
        fs::set_permissions(&read_only, fs::Permissions::from_mode(0o500))
            .expect("chmod");

        let result = validate_export_directory(Some(
            read_only.to_str().expect("utf-8 temp path"),
        ));
        // 以 root 运行时目录仍可写（权限位对 root 不生效）；普通用户必须失败。
        if let Err(message) = result {
            assert!(message.contains("没有写入权限"), "{message}");
            assert!(message.contains("重新选择"), "{message}");
        }

        // 恢复权限，保证临时目录能清理。
        fs::set_permissions(&read_only, fs::Permissions::from_mode(0o700))
            .expect("restore chmod");
    }
}
