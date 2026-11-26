# 发布检查清单（P2-04）

检查日期：2026-10-26 · 目标：知行 0.1.0（P2-04）

## A. 自动化与构建（已执行）

- [x] `pnpm --filter app typecheck` 通过。
- [x] `pnpm --filter app test` 通过：86 个测试文件 / 600 个测试。
- [x] `pnpm --filter app test:e2e` 通过：1 个文件 / 2 个端到端流程。
- [x] `pnpm --filter app build` 通过：217 modules transformed；产出
      `dist/index.html`、`dist/assets/index-*.css`、`dist/assets/index-*.js`。
- [x] ZIP 含 `manifest.json`、`data/entities.json`、`data/relations.json`、
      `boards/<id>.json`、`attachments/<sha256>.*`。
- [x] 生成的 ZIP 通过系统 `unzip -t`（No errors detected）与 Python
      `zipfile` 校验；UTF-8 文件名/CRC 正常，读取器支持 DEFLATE 条目。
      （Info-ZIP 在部分终端会把中文名显示为乱码，Python 解码为
      `boards/画板.json`，不影响内容。）
- [x] manifest 记录每个条目字节数/SHA-256、附件哈希、画板路径、关系统计。
- [x] 导入预览展示新增/冲突/跳过/阻止/未变化与附件二进制数量。
- [x] 冲突默认“跳过（保留本机）”；覆盖需额外勾选；保留两者生成新 id。
- [x] 恢复后删除对象关系不丢：回收站任务仍保留 `noteId`，回收站笔记的块
      仍保留 `noteId`；关系清单无悬空引用。
- [x] Tab 在恢复预览内循环；Shift+Tab 反向；Esc 关闭并归还焦点。
- [x] 全局历史对话框焦点兜底与自带 FocusTrap 不重复接管。
- [x] 备份不含账号/令牌/密钥/WebDAV 密码：设置白名单 + 导入拒绝未知键。
- [x] JSON/Markdown/CSV/PDF 导出可用；PDF 为图像化报告（不可检索）。
- [x] 诊断 JSON 下载可用，事件写入前脱敏。
- [x] 浏览器预览不伪造完整备份入口，显示“需桌面壳”。
- [x] “重置全部数据”保持未实现标记，不提供可点击的危险入口。

### 证据命令

```sh
pnpm --filter app typecheck
pnpm --filter app test
pnpm --filter app test:e2e
pnpm --filter app build
```

本次运行摘要：

```text
typecheck: 通过（无输出错误）
test:      Test Files 86 passed (86) · Tests 600 passed (600)
test:e2e:  Test Files 1 passed (1)  · Tests 2 passed (2)
build:     217 modules transformed · built in 752ms
```

> 测试环境 jsdom 会对 Canvas 打印 “Not implemented: HTMLCanvasElement's
> getContext()”；这是既有画板测试的 jsdom 限制，不影响 PDF 测试（PDF 使用
> 注入的 Canvas 替身）。

## B. 桌面壳人工验收（未执行）

以下项目需要 macOS/Windows 打包机与真实 WebView，本次未运行，发布前必须补做：

- [ ] 在 Tauri 桌面壳打开 设置 → 数据与备份，真实导出 ZIP 并用系统解压工具
      打开；确认附件文件可读、manifest 与画板 JSON 可解析。
- [ ] 真实恢复一份包含冲突的备份：勾选覆盖/保留两者各一次，重启应用确认
      数据、关系和画板节点仍正确。
- [ ] 真实 PDF 视觉检查：中文显示、分页、页脚；确认文字不可选中已写入说明。
- [ ] 断网/磁盘满/只读目录下复制失败路径：确认提示已应用数量且不误报成功。
- [ ] VoiceOver（macOS）或 NVDA（Windows）人工走查恢复预览。
- [ ] 全站键盘 Tab 走查（含历史对话框）与颜色对比度审计。
- [ ] `pnpm --filter app test:rust` 与 `pnpm --filter app lint:rust`（本卡未改
      Rust，但发布流程应执行）。

## C. 发布材料（已完成）

- [x] `docs/release/export-format.md` 写明格式、校验、安全边界、恢复语义
      与已知限制。
- [x] `docs/release/accessibility.md` 写明已实现与未完成的 a11y 项。
- [x] `docs/release/monitoring.md` 写明监控范围、阈值、脱敏与边界。
- [x] `docs/release/release-notes.md` 只列已实现能力，不写未落地功能。
- [x] 提交信息带卡号 `#t_23b4f69e`。
