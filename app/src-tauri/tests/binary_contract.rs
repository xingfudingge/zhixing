//! AUD-001：多 bin 工程的启动契约。
//!
//! `tauri dev` / `cargo run` 不带 `--bin`，工程里一旦有多个 bin 而没有
//! `default-run`，Cargo 会直接报 “could not determine which binary to run”。
//! 这里固定主程序选择，并确认维护 CLI 仍然存在、可用显式 `--bin` 运行。

use std::fs;
use std::path::Path;

#[test]
fn manifest_pins_main_binary_as_default_run() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let manifest = fs::read_to_string(root.join("Cargo.toml")).expect("read Cargo.toml");

    // 忽略注释行，避免注释里的示例文本被误判为真实配置。
    let has_default_run = manifest
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .any(|line| line == r#"default-run = "zhixing""#);
    assert!(
        has_default_run,
        "Cargo.toml 必须声明 default-run = \"zhixing\"，否则 tauri dev / cargo run 会因多 bin 二义性失败"
    );

    assert!(
        root.join("src/main.rs").is_file(),
        "主程序入口 src/main.rs 缺失"
    );
    assert!(
        root.join("src/bin/zhixing-db.rs").is_file(),
        "维护 CLI src/bin/zhixing-db.rs 缺失（不得用删除 bin 的方式规避二义性）"
    );
}
