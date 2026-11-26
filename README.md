# 知行 · 单用户个人任务与知识管理

> **v0.2.0 · MIT 开源版** —— 桌面端源码公开，无许可码、无试用期、无激活门禁、无账号。
> 状态：P0 全量 + P1 知识工作区；macOS arm64 已构建验证，Windows/Linux 需在对应平台构建。
> 构建：见下方「环境要求」+ `pnpm install` → `pnpm -C app build` → `cd app/src-tauri && cargo build --release`。

知行把「任务 + 知识 + 时间」融合为一个**单用户、无账号、本地优先**的桌面应用。
本仓库是正式工程源码（`app/`），不是原型 HTML 的包装。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Tauri 2（Rust） |
| 前端 | React 19 + TypeScript 5 + Vite 7 |
| 路由 | React Router 7（当前只有空页面） |
| 本地库 | SQLite（rusqlite，WAL） |
| 日志 | `tauri-plugin-log`：stdout + 日志文件 + 前端 console.error/warn 回传 |
| 测试 | Vitest + Testing Library；Rust 单元测试 |
| 包管理 | pnpm workspace（根 `pnpm-workspace.yaml`，应用包名 `app`） |

## 环境要求

- Node.js **24**（当前验证版本 24.16.0）
- pnpm **12**（`corepack enable` 后由根 `packageManager` 固定为 12.15.0）
- Rust stable（`rustup`；macOS 上把 `~/.cargo/bin` 加入 `PATH`）
- 平台依赖：
  - **macOS**：Xcode Command Line Tools / Xcode（`xcode-select --install`）
  - **Windows**：Microsoft C++ Build Tools + WebView2 Runtime
  - **Linux**：`libwebkit2gtk-4.1-dev`、`build-essential`、`curl`、`wget`、`file`、`libxdo-dev`、`libssl-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev`

## 快速开始

### 1. 安装依赖

```sh
corepack enable
pnpm install
```

首次安装时 `pnpm-workspace.yaml` 已通过 `allowBuilds` 允许 `esbuild` 的安装脚本。

### 2. 浏览器空壳（Vite）

```sh
pnpm --filter app dev
```

打开 <http://localhost:5173>。页面显示知行空壳、10 个路由入口和「浏览器预览」状态；
浏览器里不会连接 SQLite，本地库状态卡会明确标注这一点。

### 3. 桌面空壳（Tauri）

```sh
export PATH="$HOME/.cargo/bin:$PATH"
pnpm --filter app tauri dev
```

Tauri 会先启动 Vite，再编译 Rust 并打开 1280×820 的「知行」窗口。
窗口内右侧底部显示本地库版本、WAL、外键与迁移数量；Rust/WebView 日志输出到终端。
`tauri dev` 实际执行的是 `cargo run --no-default-features --`（不带 `--bin`），
因此 `default-run` 是多 bin 工程能正常启动的必要配置。

需要图形会话（WebKit/WindowServer）。无显示环境（CI、纯 SSH）无法保持窗口，
请改用 `tauri build --bundles app` 验证编译与打包，或运行下面的数据库维护 CLI。

### 4. 构建

```sh
pnpm --filter app build                     # tsc --noEmit + vite build
pnpm --filter app tauri build --bundles app # 只打 macOS .app（推荐用于验收）
pnpm --filter app tauri build               # 全量打包；macOS 同时产出 .app 与 .dmg
```

`tauri build` 会先执行 `beforeBuildCommand`（再次执行前端 build），
产物位于 `app/src-tauri/target/release/bundle/`。
打包只做链接器 ad-hoc 签名，未做 Developer ID 签名与公证。

### 5. 数据库维护 CLI

`zhixing-db` 是独立 bin，**不启动 WebView**，必须显式指定 `--bin`：

```sh
# pnpm 脚本（默认对系统应用数据目录执行；参数直接跟，不能再加 `--`）
pnpm --filter app db:migrate
pnpm --filter app db:migrate --path /tmp/zhixing.db
# 也可用环境变量指定库文件
ZHIXING_DB_PATH=/tmp/zhixing.db pnpm --filter app db:migrate

# 等价的手动命令（在仓库根目录执行）
cargo run --quiet --manifest-path app/src-tauri/Cargo.toml --bin zhixing-db -- migrate --path /tmp/zhixing.db
cargo run --quiet --manifest-path app/src-tauri/Cargo.toml --bin zhixing-db -- status  --path /tmp/zhixing.db
```

不要为了“只有一个 bin”而删除 `zhixing-db`；主 bin 的选择由 `default-run` 负责。

### 6. 测试

```sh
pnpm --filter app test             # Vitest：607 项（87 个测试文件）
pnpm --filter app typecheck        # tsc --noEmit
pnpm --filter app test:rust        # Rust：65 项（60 单元 + 5 契约）
pnpm --filter app lint:rust        # cargo clippy -D warnings
```

其中 `app/src-tauri/tests/binary_contract.rs` 固定检查 `default-run = "zhixing"`
以及 `src/main.rs`、`src/bin/zhixing-db.rs` 同时存在，防止多 bin 二义性回归。

根目录也提供了快捷脚本：`pnpm dev`、`pnpm build`、`pnpm test`、`pnpm check`、`pnpm tauri:dev`、`pnpm tauri:build`。

## 目录结构

```text
app/
├── index.html
├── public/favicon.svg
├── src/
│   ├── main.tsx                 # React 挂载、Tauri 前端日志桥
│   ├── App.tsx                  # 空壳、设计 token 应用、路由空页、本地库状态
│   ├── App.test.tsx             # 路由/空态/console 测试
│   ├── styles/tokens.css        # 知行全局 design token（浅/深色）
│   ├── styles/app.css           # 空壳布局
│   └── test/setup.ts
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json          # 窗口、CSP、bundle、图标
    ├── capabilities/default.json
    ├── migrations/0001_bootstrap.sql
    ├── icons/                   # 由 tauri icon 生成
    └── src/
        ├── main.rs
        ├── lib.rs               # Tauri Builder、日志、命令、启动流程
        ├── db.rs                # SQLite 打开、WAL、迁移执行器、状态命令
        └── menu.rs              # 桌面菜单（业务项禁用占位）
```

## 设计 token

唯一来源是 `app/src/styles/tokens.css`，数值与 `outputs/知行-前端原型-v1.html` 一致：

`--bg / --surface / --surface-2 / --ink / --muted / --line / --line-strong / --blue / --blue-soft / --blue-ink / --violet / --violet-soft / --coral / --coral-soft / --teal / --teal-soft / --amber / --amber-soft / --green / --green-soft / --red`

深色主题可通过系统 `prefers-color-scheme` 或根节点 `data-theme="dark"` 生效。
后续页面不得另起第二套主色或深色侧栏。

## 路由空页

| 路径 | 空页标题 |
|---|---|
| `/today` | 今天 |
| `/inbox` | 收件箱 |
| `/calendar` | 日历 |
| `/habits` | 习惯 |
| `/focus` | 专注 |
| `/review` | 复盘 |
| `/lists` | 我的清单 |
| `/knowledge` | 知识 |
| `/board` | 画板 |
| `/settings/appearance` | 设置 |

`/` 重定向到 `/today`，`/settings` 重定向到 `/settings/appearance`，未知路径显示「页面不存在」。
所有页面只包含标题、范围和「业务未实现」说明，没有业务组件、假数据或账号/路由守卫。

## Tauri 窗口、菜单与日志

- 窗口：label `main`，标题「知行」，1280×820，最小 960×640，居中。
- 菜单：`知行 / 文件 / 编辑 / 视图 / 帮助`；其中「新建笔记」「新建任务」「使用说明」等业务项一律 **disabled 占位**，系统菜单项（撤销/复制/全屏/退出等）正常。
- 日志目标：
  - stdout（`tauri dev` 终端可见）
  - 日志文件（文件名 `zhixing.log`，位于 Tauri 的 app log dir）
  - WebView 桥：前端 `console.error` / `console.warn` / `window.error` / `unhandledrejection` 回传 Rust 日志
- 启动时会记录版本、平台、数据库路径、迁移结果、窗口就绪与前端 `shell_ready`。

## SQLite 迁移机制

- 文件：`app/src-tauri/migrations/*.sql`。
- 运行器：`app/src-tauri/src/db.rs` 的 `run_migrations`。
  - 打开连接后执行 `PRAGMA foreign_keys=ON`、`PRAGMA synchronous=NORMAL`、`PRAGMA journal_mode=WAL`。
  - 维护 `schema_migrations(version, name, applied_at)`，同时校准 `PRAGMA user_version`。
  - 每个迁移在事务中执行；失败回滚。
  - 启动时校验：版本严格递增、数据库中的版本必须存在于应用、名称必须一致；出现未知版本或改名会拒绝启动迁移并记录错误。
  - 迁移幂等，重启应用不会重复执行。
- 当前仅有 `0001_bootstrap`，只创建 `app_meta` 自检表；业务表由 P0-03 的迁移追加。
- IPC 命令：
  - `db_status`：返回路径、是否就绪、当前 schema 版本、WAL、外键、已应用迁移、错误。
  - `db_migrate`：手动重跑迁移并更新状态。
- 新增迁移：放入 `migrations/000N_name.sql`，在 `db.rs` 的 `MIGRATIONS` 中登记严格递增的版本号。

检查数据库（macOS 实际路径）：

```sh
DB="$HOME/Library/Application Support/com.zhixing.desktop/zhixing.db"
sqlite3 "$DB" ".tables"
sqlite3 "$DB" "SELECT version, name, applied_at FROM schema_migrations;"
sqlite3 "$DB" "PRAGMA journal_mode; PRAGMA user_version;"
```

`foreign_keys` 是连接级 PRAGMA，`sqlite3` CLI 默认显示 0；应用连接始终以 `PRAGMA foreign_keys=ON` 打开，
`db_status` 返回的 `foreignKeys` 字段为验证值。

## 历史验收记录（P0-01，2026-10-26）

| 命令 | 结果 |
|---|---|
| `pnpm install` | 成功；workspace 2 个项目，esbuild 构建脚本已批准 |
| `pnpm --filter app dev` | Vite 7.3.7 启动于 <http://localhost:5173> |
| 无头 Chrome 冒烟（13 条路径） | 13/13 标题与导航正确；0 console error / warning；0 HTTP ≥400 |
| `pnpm --filter app build` | 成功；TypeScript 0 错误，Vite 产物生成 |
| `pnpm --filter app test` | 15/15 通过 |
| `pnpm --filter app test:rust` | 5/5 通过 |
| `pnpm --filter app lint:rust` | 0 warning |
| `pnpm --filter app tauri dev` | Rust 编译并启动窗口；SQLite 迁移成功；前端 `shell_ready` 与日志桥日志可见 |
| `pnpm --filter app tauri build --bundles app` | 成功；产物 `app/src-tauri/target/release/bundle/macos/知行.app`（4.37 MiB） |
| `pnpm --filter app tauri build` | 成功；同时产出 `知行.app`（4.37 MiB）与 `app/src-tauri/target/release/bundle/dmg/知行_0.1.0_aarch64.dmg`（2.22 MiB） |
| 启动 release `.app` | 成功；前端从 `tauri://localhost/assets/...` 加载，`shell_ready route=/today`，日志桥无 error |

真实日志节选：

```text
[INFO] zhixing desktop shell starting: version=0.1.0 platform=macos arch=aarch64
[INFO] migrations applied: from=0 to=1 applied=[0001_bootstrap]
[INFO] database ready: path=.../com.zhixing.desktop/zhixing.db schema_version=1 journal_mode=wal foreign_keys=true applied=[0001_bootstrap]
[INFO] menu installed: app / file / edit / view / help (business items disabled)
[INFO] main window ready: label=main title=知行
[INFO] zhixing desktop shell setup complete
[INFO] frontend shell ready: route=/today
[INFO] [webview::...][INFO] zhixing webview console bridge active
```

第二次启动时迁移日志为 `from=1 to=1 applied=[]`，证明重启不会重复迁移且数据仍在。

## AUD-001 验收记录（2026-10-27）

问题：工程加入 `zhixing-db` 后变成多 bin，但没有 `default-run`。
`tauri dev` 执行 `cargo run --no-default-features --`（不带 `--bin`），修复前实测失败：

```text
error: `cargo run` could not determine which binary to run. Use the `--bin` option to specify a binary, or the `default-run` manifest key.
available binaries: zhixing, zhixing-db
exit=101
```

修复：`app/src-tauri/Cargo.toml` 增加 `default-run = "zhixing"`，并新增
`app/src-tauri/tests/binary_contract.rs` 做回归检查。未删除 `zhixing-db`。

| 命令 | 结果 |
|---|---|
| `cargo metadata --no-deps` | `default_run = "zhixing"`；targets 含 `zhixing`、`zhixing-db` |
| `cargo run --bin zhixing-db -- migrate --path /tmp/aud001-db/zhixing.db` | 成功；`schemaVersion=3`、WAL、外键开启 |
| `cargo run --bin zhixing-db -- status --path /tmp/aud001-db/zhixing.db` | 成功；迁移 `0001_bootstrap`、`0002_domain`、`0003_review_snapshots` |
| `pnpm --filter app test` | 87 个文件、607 项全部通过 |
| `pnpm --filter app build` | TypeScript 0 错误；224 个模块，Vite 产物生成 |
| `pnpm --filter app test:rust` | 65 项通过（60 单元 + 1 多 bin 契约 + 4 数据库契约） |
| `pnpm --filter app tauri dev` | 成功；Cargo 默认运行 `target/debug/zhixing`，窗口 `main` 就绪 |
| `pnpm --filter app tauri build --bundles app` | 成功；`知行.app`（6.45 MiB） |

`tauri dev` 真实日志节选（窗口就绪后由验收脚本发送 SIGTERM 结束，返回码 `-15` 属预期，不是启动失败）：

```text
Running DevCommand (`cargo  run --no-default-features --color always --`)
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.13s
Running `target/debug/zhixing`
[INFO] database ready: path=.../com.zhixing.desktop/zhixing.db schema_version=3 journal_mode=wal foreign_keys=true
[INFO] main window ready: label=main title=知行
[INFO] zhixing desktop shell setup complete
[INFO] zhixing webview console bridge active
```

## 非目标 / 已知边界

- **没有业务页面**：今天、四象限、看板、日历、习惯、专注、复盘、清单、知识、画板、设置均只有空路由。
- **没有完整业务 schema**：当前只有 `app_meta` 与 `schema_migrations`；P0-03 负责业务表与仓储。
- 不引入账号、登录、成员、席位、协作、AI、路由守卫。
- 不复制 `outputs/知行-前端原型-v1.html` 作为正式 UI；不改 `outputs/` 下的原型与设计文档。
- 不写 localStorage 作为权威库；不实现同步/WebDAV/backend、许可验签、OCR、系统通知。
- `tauri build` 产物只有链接器 ad-hoc 签名，未做 Developer ID 签名与公证；macOS 首次打开可能需要右键「打开」。
- 当前 `BrowserRouter` 在 Tauri 生产环境刷新深链的兼容方案由 P0-02 路由卡统一收口；本卡验收只看 dev 空壳。

## 常见问题

| 现象 | 处理 |
|---|---|
| `pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS` | 确认 `pnpm-workspace.yaml` 中保留 `allowBuilds: esbuild: true` |
| 5173 被占用 | 本工程 `strictPort: true`；先结束旧 Vite 进程 |
| `cargo: command not found` | `export PATH="$HOME/.cargo/bin:$PATH"` |
| `cargo run` / `tauri dev` 报 `could not determine which binary to run` | 确认 `app/src-tauri/Cargo.toml` 保留 `default-run = "zhixing"`；`zhixing-db` 必须显式 `--bin zhixing-db` |
| macOS 窗口未出现 | 确认在已登录的图形会话中运行；`tauri dev` 需要 WebKit/WindowServer。无显示环境改用 `tauri build --bundles app` 验证 |
| 中文窗口名乱码 | 终端编码设为 UTF-8；应用内标题与日志均为 UTF-8 |
| 想看数据库/日志 | 数据与日志路径以 `db_status` 返回值及终端日志为准；macOS 路径见上 |
