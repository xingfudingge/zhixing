# 发布资料（P2-04）

本目录只描述**当前已实现**的导出/恢复、可访问性与监控能力，不包含账号、
云同步或任何未落地功能。

| 文档 | 内容 |
|---|---|
| [checklist.md](./checklist.md) | 发布前逐项检查、命令与真实输出；未执行项明确标注 |
| [export-format.md](./export-format.md) | JSON/ZIP/Markdown/CSV/PDF 格式、manifest、安全边界、恢复语义 |
| [accessibility.md](./accessibility.md) | 键盘焦点、ARIA、Esc、已知缺口 |
| [monitoring.md](./monitoring.md) | 本机性能/错误缓冲、诊断包与脱敏规则 |
| [release-notes.md](./release-notes.md) | 对外发布说明（只写已实现能力与已知限制） |

## 对应实现

- `app/src/features/export/`：收集、manifest、ZIP、JSON、Markdown、CSV、PDF、下载、监控、设置页面板。
- `app/src/features/import/`：解析校验、冲突计划、写入目标、恢复预览对话框。
- `app/src/app/a11y/`：FocusTrap、Modal、全局历史对话框焦点兜底。
- 入口：设置 → 数据与备份 → 完整数据备份（`DataBackupPanel`）。
- 桌面壳：`main.tsx` 启动时安装全局监控与历史对话框焦点兜底。
