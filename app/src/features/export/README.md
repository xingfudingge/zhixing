# export · 完整数据备份（P2-04）与单篇笔记导出（ZX-EXPORT-01）

设置 → 数据与备份 → 完整数据备份使用这里的实现。

| 文件 | 职责 |
|---|---|
| `types.ts` | 备份数据集、manifest、恢复操作与目标接口 |
| `collect.ts` | 从 SQLite 收集全部业务行（含回收站）、校验附件哈希、过滤设置 |
| `sanitize.ts` | 设置白名单、稳定序列化、诊断脱敏、文件名安全 |
| `relations.ts` | 关系清单、悬空引用与关系比较 |
| `manifest.ts` | manifest、实体文件、画板文件、关系文件与 SHA-256 |
| `serialize.ts` | ZIP / JSON / Markdown / CSV 导出 |
| `pdf.ts` | Canvas 排版 + JPEG 嵌入的最小 PDF |
| `zip.ts` | 无依赖 ZIP 写入、读取与 CRC/路径校验 |
| `monitoring.ts` | 本机错误/耗时环形缓冲与诊断快照 |
| `download.ts` | Blob 下载与测试用内存下载器 |
| `location.ts` | 默认导出目录：读设备偏好、系统目录选择器、保存面板参数 |
| `DataBackupPanel.tsx` | 设置页面板（导出、选择备份、诊断、业务数据重置） |
| `reset.ts` | 业务数据重置目标：桌面调用 `db_reset_domain`，浏览器返回 null |
| `ResetDataDialog.tsx` | 重置确认弹层（备份提醒、不可撤销勾选、失败回滚提示） |

## note/ · 单篇笔记导出（ZX-EXPORT-01）

| 文件 | 职责 |
|---|---|
| `note/document.ts` | 块权威投影 → 三格式共用的导出文档模型（元信息/目录/降级事实） |
| `note/markdown.ts` | Markdown：标题、元信息、目录、表格、代码、公式、内链、图片 base64 |
| `note/docx.ts` | 真 OOXML `.docx`（复用 `zip.ts`，无第三方依赖）：样式/编号/表格/图片/超链接 |
| `note/pdf.ts` | A4/Letter 图片型 PDF：Canvas 排版、分页、页眉页脚、占位与限制标注 |
| `note/settings.ts` | 导出偏好（默认格式/元信息/图片/纸张）写入 SQLite `settings` |
| `note/index.ts` | 生成报告 → 统一保存面板（`saveBlobWithDialog`）→ 实际路径/降级项 |
| `note/note-export.css` | 导出面板与标题区入口样式（只用全局 design token） |

约定：
- 入口统一为「列表右键/`···`、标题区 `导出`、信息/链接面板、`⇧⌘E`」打开
  同一个导出面板；回收站/阅读模式按只读快照导出并明示。
- 保存走 ZX-FILE-01 的统一保存面板（桌面 `save_attachment_file`、浏览器
  File System Access）；默认目录来自「设置 → 数据与备份」，未设置时传
  `null` 由系统记住上次位置。取消不写文件，同名冲突自动 `-1` 并在结果面板
  反馈；默认目录失效/无权限时提示重新选择或清除，不静默回退。
- 缺失附件、公式源、画板占位、颜色丢失、内链不可跳转都写入降级报告，
  不静默丢内容；PDF 文字为图像、不可选中/检索，限制在面板与报告标注。

安全边界：不读取/导出 localStorage 中的同步配置、设备令牌、账号信息；
设置表只导出 `SETTING_KEYS` 白名单。业务数据重置只清空业务表，保留
`settings`、通知凭证与数据库文件；清空与重新种子在同一 SQLite
事务内，失败自动回滚。格式细节见 `docs/release/export-format.md`。
