//! 知行数据库维护 CLI（不启动 WebView）。
//!
//! 用法：
//!   cargo run --bin zhixing-db -- migrate [--path /path/to/zhixing.db]
//!   cargo run --bin zhixing-db -- status  [--path /path/to/zhixing.db]
//!
//! 也可以设置 `ZHIXING_DB_PATH`；未指定时使用 Tauri 的 app_data_dir 约定路径。

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use zhixing_lib::db;

const BUNDLE_ID: &str = "com.zhixing.desktop";

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "migrate".to_string());
    let mut path: Option<PathBuf> = None;

    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--path" | "-p" => match args.next() {
                Some(value) => path = Some(PathBuf::from(value)),
                None => {
                    eprintln!("--path 需要一个数据库文件路径");
                    return ExitCode::from(2);
                }
            },
            "--help" | "-h" => {
                print_help();
                return ExitCode::SUCCESS;
            }
            other => {
                eprintln!("未知参数：{other}");
                print_help();
                return ExitCode::from(2);
            }
        }
    }

    if command == "help" {
        print_help();
        return ExitCode::SUCCESS;
    }

    let path = path
        .or_else(|| env::var_os("ZHIXING_DB_PATH").map(PathBuf::from))
        .unwrap_or_else(default_database_path);

    let result = match command.as_str() {
        "migrate" | "seed" => db::migrate_path(&path),
        "status" => db::status_path(&path),
        other => {
            eprintln!("未知命令：{other}");
            print_help();
            return ExitCode::from(2);
        }
    };

    match result {
        Ok(status) => {
            println!("database: {}", path.display());
            match serde_json::to_string_pretty(&status) {
                Ok(json) => println!("{json}"),
                Err(error) => {
                    eprintln!("无法序列化状态：{error}");
                    return ExitCode::FAILURE;
                }
            }
            if !status.ready {
                eprintln!("数据库未就绪：{:?}", status.error);
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("数据库操作失败：{error}");
            ExitCode::FAILURE
        }
    }
}

fn print_help() {
    println!(
        "知行数据库维护工具\n\n\
         用法：\n  \
         zhixing-db migrate [--path <db>]\n  \
         zhixing-db status  [--path <db>]\n\n\
         环境变量：ZHIXING_DB_PATH（默认使用系统应用数据目录）"
    );
}

fn default_database_path() -> PathBuf {
    let file_name = "zhixing.db";

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = env::var_os("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(BUNDLE_ID)
                .join(file_name);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = env::var_os("APPDATA") {
            return PathBuf::from(appdata).join(BUNDLE_ID).join(file_name);
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(data_home) = env::var_os("XDG_DATA_HOME") {
            return PathBuf::from(data_home).join(BUNDLE_ID).join(file_name);
        }
        if let Some(home) = env::var_os("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("share")
                .join(BUNDLE_ID)
                .join(file_name);
        }
    }

    PathBuf::from(file_name)
}
