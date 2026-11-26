# 知行 · 项目上下文（Claude Code / 子员工必读）

## 项目
把「为知笔记 X（知识库）+ 滴答清单（任务）+ 一页日历（时间）」融合成单用户产品「知行」。
当前仓库是已封版 v0.1.0 的桌面应用源码（Tauri 2 + React 19 + SQLite）。

## 事实来源（按优先级）
1. `README.md`：产品定位、环境与构建。
2. `docs/`：发布格式与实现说明。
3. `app/`、`server/`、`packages/`：可运行代码即事实来源。

## 不可违反的产品决策
- 单用户、无账号、无席位、无协作、无 AI；**无许可码、无试用期、无激活门禁**。
- 桌面优先（Windows/macOS）→ 服务端+Web → 移动端。
- 每设备单一同步模式 `local / webdav / backend`；Web 只连 backend；WebDAV 面向 OpenList/Alist，不依赖 If-Match/ETag/LOCK。
- 画板对标飞书单人创作能力，不降级；v1 不做多人协作/评论/分享。
- 笔记编辑器学 WizNote X 的**交互结构**：无固定格式工具栏、块级 `＋`、划词格式条、右键菜单；**不照抄 WizNote 配色**，主色必须用知行全局 design token。
- 已确定的模块不得删：今天/四象限/看板、收件箱、日历（事件/倒数日/小工具）、习惯、专注、复盘、我的清单、知识、画板、设置 8 分组。

## 工程与验收
- 代码在 `app/`（Tauri 2 + React 19 + SQLite），不要把原型直接当正式版。
- 任何改动必须能实际运行/点击，不能只写文档或留 stub；控制台零报错。
- 每个看板卡必须给出真实命令输出、文件清单、验收步骤；完成后 `git commit`，提交信息带卡号。
- 禁止修改卡面「禁区」；禁止用删功能/隐藏按钮/写死数据消除问题。

## 常用命令
```sh
pnpm install
pnpm --filter app test
pnpm --filter app typecheck
pnpm --filter app build
pnpm --filter app tauri dev
```
